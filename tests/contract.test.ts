import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { globKey, globRe, main } from "../intake/contract";
import { globRe as tenderGlobRe } from "../src/review/merge";
import { parseCollect, parseRecheck } from "../src/intake";

const SCRIPT = join(import.meta.dir, "../intake/contract.ts");
const NO_PARSER = "/nonexistent/repo-config.ts";
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "contract-"));
  Bun.spawnSync(["git", "init", "-q", dir]);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (name: string, text = "") => {
  mkdirSync(dirname(join(dir, name)), { recursive: true });
  writeFileSync(join(dir, name), text);
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
};
const config = (yaml: string) => put(".tender/config.yaml", yaml);
const collect = async (parser?: string) => parseCollect(await main([], dir, parser));
const recheck = async (key: string, parser?: string) => parseRecheck(await main(["--recheck", key], dir, parser)).state;
const YAML = "criticalPaths: [src/db/**, migrations/*.sql]\ntrust:\n  - paths: [docs/**, '*.md']\n    autoMerge: all\n";

test("globRe is tender's merge.ts matcher", () => {
  for (const g of ["src/db/**", "*.md", "**/auth/**", "a?b.ts", "x.(y)+", "dir/*.sql"]) expect(globRe(g).source).toBe(tenderGlobRe(g).source);
});

test("a valid config whose globs all match tracked files reports nothing", async () => {
  config(YAML);
  for (const f of ["src/db/a.ts", "migrations/1.sql", "docs/x.md"]) put(f);
  expect(await collect()).toEqual([]);
});

test("each criticalPaths and trust glob matching no tracked file is one item with a stable key", async () => {
  config(YAML + "  - paths: [docs/**]\n    autoMerge: shadow\n");
  put("README.md");
  writeFileSync(join(dir, "migrations.sql"), "");
  mkdirSync(join(dir, "src/db"), { recursive: true });
  writeFileSync(join(dir, "src/db/untracked.ts"), "");
  const found = await collect();
  expect(found.map((f) => f.key)).toEqual([globKey("criticalPaths", "src/db/**"), globKey("criticalPaths", "migrations/*.sql"), globKey("trust", "docs/**")]);
  expect(found[0]!.key).toMatch(/^contract:criticalPaths:src\/db\/---[0-9a-f]{8}$/);
  expect(found[2]!.facts).toEqual({ check: "trust", glob: "docs/**" });
  expect((await collect()).map((f) => f.key)).toEqual(found.map((f) => f.key));
  expect(globKey("trust", "a*b")).not.toBe(globKey("trust", "a?b"));
});

test("a config tender check rejects is one item; an unparseable one hides the glob checks", async () => {
  config("criticalPaths: [nowhere/**]\nsmoke: bun run smoke\n");
  const found = await collect();
  expect(found.map((f) => f.key)).toEqual(["contract:config:check", globKey("criticalPaths", "nowhere/**")]);
  expect(found[0]!.body).toContain("smoke: unknown key");
  config("criticalPaths: [a\n");
  expect((await collect()).map((f) => f.key)).toEqual(["contract:config:check"]);
});

test("without tender's parser beside it, the config check is skipped and an unparseable config fails the run", async () => {
  config("criticalPaths: [nowhere/**]\nsmoke: x\n");
  expect((await collect(NO_PARSER)).map((f) => f.key)).toEqual([globKey("criticalPaths", "nowhere/**")]);
  config("criticalPaths: [a\n");
  await expect(main([], dir, NO_PARSER)).rejects.toThrow();
});

test("recheck: still while a glob matches nothing, gone once it matches or leaves the config", async () => {
  config(YAML);
  const key = globKey("criticalPaths", "src/db/**");
  expect(await recheck(key)).toBe("still");
  put("src/db/a.ts");
  expect(await recheck(key)).toBe("gone");
  rmSync(join(dir, "src"), { recursive: true });
  Bun.spawnSync(["git", "-C", dir, "add", "-A"]);
  expect(await recheck(key, NO_PARSER)).toBe("still");
  config("criticalPaths: [migrations/*.sql]\n");
  expect(await recheck(key)).toBe("gone");
});

test("recheck: the config key is still while tender check fails and gone once it passes", async () => {
  config("bogus: 1\n");
  expect(await recheck("contract:config:check")).toBe("still");
  config("agent: claude\n");
  expect(await recheck("contract:config:check")).toBe("gone");
});

test("recheck cannot decide without the parser, or a glob with an unparseable config", async () => {
  config("agent: claude\n");
  await expect(main(["--recheck", "contract:config:check"], dir, NO_PARSER)).rejects.toThrow("parser");
  config("criticalPaths: [a\n");
  await expect(main(["--recheck", globKey("criticalPaths", "a")], dir)).rejects.toThrow();
});

test("collect stops at tender's 100-line cap, config item first", async () => {
  config(`smoke: x\ncriticalPaths: [${Array.from({ length: 120 }, (_, i) => `gone${i}/**`).join(", ")}]\n`);
  const found = await collect();
  expect(found).toHaveLength(100);
  expect(found[0]!.key).toBe("contract:config:check");
  expect(await recheck(globKey("criticalPaths", "gone119/**"))).toBe("still");
});

test("errors exit non-zero with nothing on stdout", async () => {
  config(YAML);
  const run = (args: string[]) => Bun.spawnSync(["bun", SCRIPT, ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
  for (const key of ["contract:unknown:check", "contract:config:other", "contract:trust:a*b-0123abcd", "contract:trust:docs", "nope"]) {
    const r = run(["--recheck", key]);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).toBe("");
  }
  config("criticalPaths: [nowhere/**]\nsmoke: x\n");
  rmSync(join(dir, ".git"), { recursive: true });
  for (const args of [[], ["--recheck", "nope"], ["--recheck"], ["extra"]]) {
    const r = run(args);
    expect(r.exitCode).not.toBe(0);
    expect(r.stdout.toString()).toBe("");
  }
});

test("with TENDER_CONFIG, the config check and its recheck use the repo's profile from that tender.json", async () => {
  const profile = join(dir, "..", `${dir.split("/").at(-1)}-profile`);
  mkdirSync(join(profile, "instructions"), { recursive: true });
  writeFileSync(join(profile, "instructions/ui.md"), "UI");
  writeFileSync(join(profile, "instructions/default.md"), "D");
  writeFileSync(join(profile, "types.yaml"), "types:\n  - { name: default, instructions: instructions/default.md }\n");
  const host = join(profile, "tender.json");
  writeFileSync(host, JSON.stringify({ host: "h", defaults: { sandbox: "nono" }, repos: [{ name: "acme/web", path: join(profile, "web"), profile }], sources: [{ name: "gh", tracker: "github" }] }));
  Bun.spawnSync(["git", "-C", dir, "remote", "add", "origin", "https://github.com/acme/web.git"]);
  config("types:\n  - { name: ui, match: { labels: [ui] }, instructions: instructions/ui.md }\n");
  const prev = process.env.TENDER_CONFIG;
  try {
    delete process.env.TENDER_CONFIG;
    expect((await collect()).map((f) => f.key)).toEqual(["contract:config:check"]);
    process.env.TENDER_CONFIG = host;
    expect(await collect()).toEqual([]);
    expect(await recheck("contract:config:check")).toBe("gone");
  } finally {
    if (prev === undefined) delete process.env.TENDER_CONFIG;
    else process.env.TENDER_CONFIG = prev;
    rmSync(profile, { recursive: true, force: true });
  }
});
