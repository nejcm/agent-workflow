import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AGENTS, codexState } from "../src/agents";
import { resolve, STALE_MS, UNKNOWN } from "../src/state";
import { snapshot, table } from "../src/status";
import { config, fakeIo, root, useTempRoot, windowsOut, worktree } from "./helpers";

useTempRoot();

const T = 1_000_000;
const NOW = T * 1000;
const wt = (id: string) => join(root, "acme/web", id);
const agent = (o: object) => ({ pid: 1, cwd: "/w/a", kind: "interactive", startedAt: 1, sessionId: "s", name: "n", status: "busy", ...o });
const codex = () => config({ defaults: { agent: "codex", sandbox: "nono", testCmd: "bun test" } });
const launched = (id: string) => (worktree(id), writeFileSync(join(root, "acme/web", `${id}.sh`), ""), utimesSync(join(root, "acme/web", `${id}.sh`), T - 60, T - 60));
const stateAt = (id: string) => join(wt(id), ".aw", "codex-state.json");
const hookFile = (id: string, o: unknown) => {
  mkdirSync(join(wt(id), ".aw"), { recursive: true });
  writeFileSync(stateAt(id), typeof o === "string" ? o : JSON.stringify(o));
};

test("resolve: ended/orphan first, then the feed, stale working is unknown", () => {
  const working = { state: "working" as const, since: NOW - STALE_MS - 1, waitingFor: null };
  expect(resolve("ended", working, 0, NOW).state).toBe("ended");
  expect(resolve("orphan", working, 0, NOW).state).toBe("ended");
  expect(resolve("running", undefined, 0, NOW)).toEqual(UNKNOWN);
  expect(resolve("running", working, 1000, NOW)).toBe(working);
  expect(resolve("running", working, null, NOW)).toEqual(UNKNOWN);
  expect(resolve("running", working, STALE_MS + 1, NOW)).toEqual(UNKNOWN);
  expect(resolve("running", { ...working, state: "idle" }, null, NOW).state).toBe("idle");
  expect(resolve("running", { ...working, since: null }, null, NOW).state).toBe("working");
});

test("snapshot runs claude agents once per running ticket with its own config dir, maps rows by exact cwd, and shows state in table and JSON", async () => {
  for (const id of ["PER-1", "PER-2", "PER-3"]) worktree(id);
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "out.json"), JSON.stringify([agent({ cwd: wt("PER-1"), status: "waiting", waitingFor: "permission" }), agent({ cwd: `${wt("PER-2")}/sub`, status: "busy" })]));
  writeFileSync(join(bin, "claude"), `#!/bin/sh\necho "$CLAUDE_CONFIG_DIR $*" >> '${root}/calls'\ncat '${root}/out.json'\n`, { mode: 0o755 });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path}`;
  const { io } = fakeIo((argv) => (argv[0] === "tmux" ? windowsOut(["acme/web/PER-1", "acme/web/PER-2"]) : undefined));
  let rs, none;
  try {
    rs = await snapshot(config(), io, root, NOW);
    none = await snapshot(config(), fakeIo().io, root, NOW);
  } finally {
    process.env.PATH = path;
  }
  expect(readFileSync(join(root, "calls"), "utf8").split("\n").filter(Boolean).sort()).toEqual([`${wt("PER-1")}.claude agents --json`, `${wt("PER-2")}.claude agents --json`]);
  expect(rs.map((r) => [r.id, r.session, r.state, r.waitingFor])).toEqual([["PER-1", "running", "waiting", "permission"], ["PER-2", "running", "unknown", null], ["PER-3", "orphan", "ended", null]]);
  expect(JSON.parse(JSON.stringify(rs))[0]).toMatchObject({ state: "waiting", waitingFor: "permission", stateSince: null });
  expect(table(rs).split("\n")[1]).toMatch(/^PER-1\s+acme\/web\s+claude\s+running\s+waiting: permission\s+/);

  expect(none.every((r) => r.state === "ended")).toBe(true);
  const broken = await snapshot(config(), io, root, NOW, async () => () => undefined);
  expect(broken[0]!.state).toBe("unknown");
});

test("codex rows read the hook file; one from before the launch is ignored", async () => {
  launched("PER-4");
  launched("PER-5");
  hookFile("PER-4", { state: "idle", ts: NOW - 10_000 });
  hookFile("PER-5", { state: "working", ts: (T - 120) * 1000 });
  const { io } = fakeIo((argv) => (argv[0] === "tmux" ? windowsOut(["acme/web/PER-4", "acme/web/PER-5"]) : undefined));
  const rs = await snapshot(codex(), io, root, NOW, (a) => (a === "claude" ? Promise.reject(new Error("not for codex")) : AGENTS[a].live(root, [])));
  expect(rs.map((r) => [r.state, r.stateSince])).toEqual([["idle", NOW - 10_000], ["unknown", null]]);
});

const script = join(import.meta.dir, "..", "scripts", "codex-hooks.sh");
const hooks = (file: string) => Bun.spawnSync(["bash", script, file]);

test("codex-hooks.sh adds one aw block, is idempotent, keeps user content and refuses damaged markers", () => {
  const file = join(root, "config.toml");
  const user = 'model = "x"\n\n[projects."/p"]\ntrust_level = "trusted"\n';
  writeFileSync(file, user);
  expect(hooks(file).exitCode).toBe(0);
  const once = readFileSync(file, "utf8");
  expect(once.startsWith(user)).toBe(true);
  expect(hooks(file).stdout.toString()).toMatch(/^ok /);
  expect(readFileSync(file, "utf8")).toBe(once);
  const parsed = Bun.TOML.parse(once) as any;
  expect(Object.keys(parsed.hooks).sort()).toEqual(["PermissionRequest", "PostToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
  expect(parsed.projects["/p"].trust_level).toBe("trusted");

  writeFileSync(file, once.replace("timeout = 2", "timeout = 9") + 'extra = "kept"\n');
  expect(hooks(file).exitCode).toBe(0);
  const again = readFileSync(file, "utf8");
  expect(again).toContain('extra = "kept"');
  expect(again.match(/>>> aw state hooks/g)!.length).toBe(1);
  expect(again).not.toContain("timeout = 9");

  const [b, e] = ["# >>> aw state hooks (managed by scripts/codex-hooks.sh)", "# <<< aw state hooks"];
  for (const bad of [user + `${b}\nmine = 1\n`, user + `${e}\nkeep = 2\n${b}\nmine = 1\n`, user + `${b}\n${e}\n${b}\n${e}\n`, `hooks = {}\n${user}`]) {
    writeFileSync(file, bad);
    expect(hooks(file).exitCode).toBe(1);
    expect(readFileSync(file, "utf8")).toBe(bad);
  }
  expect(readdirSync(root).filter((f) => f.startsWith("config.toml."))).toEqual([]);
});

test("the installed hook command writes only into a real <cwd>/.aw and aw accepts it", () => {
  const file = join(root, "config.toml");
  hooks(file);
  const parsed = Bun.TOML.parse(readFileSync(file, "utf8")) as any;
  const run = (event: string, cwd: string) => Bun.spawnSync(["sh", "-c", parsed.hooks[event][0].hooks[0].command], { cwd, stdin: Buffer.from('{"session_id":"s"}') }).exitCode;
  mkdirSync(join(wt("PER-9"), ".aw"), { recursive: true });
  for (const [event, state] of [["UserPromptSubmit", "working"], ["PermissionRequest", "waiting"]]) {
    expect(run(event!, wt("PER-9"))).toBe(0);
    expect(codexState(wt("PER-9"), Date.now() - 5000, Date.now())?.state).toBe(state as any);
  }
  expect(readdirSync(join(wt("PER-9"), ".aw"))).toEqual(["codex-state.json"]);

  mkdirSync(wt("PER-10"), { recursive: true });
  expect(run("Stop", wt("PER-10"))).toBe(0);
  expect(existsSync(join(wt("PER-10"), ".aw"))).toBe(false);
  const outside = join(root, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(wt("PER-10"), ".aw"));
  expect(run("Stop", wt("PER-10"))).toBe(0);
  expect(readdirSync(outside)).toEqual([]);
});
