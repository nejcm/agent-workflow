import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validRepo } from "../src/config";
import { canonCache, github } from "../src/github";
import { adminDir, launcher, render, seedClaude } from "../src/launcher";
import { endedNotice, pass } from "../src/pass";
import { liveStates, pickAnswer } from "../src/question";
import type { State } from "../src/state";
import type { Io, Repo, Ticket, TicketComment, Tracker } from "../src/types";
import { GIT } from "../src/util";
import { claudeFile, config, fakeIo, fakeTracker, noPr, root, src, ticket, two, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

test("render is single-pass so ticket text cannot expand placeholders", () => {
  expect(render("{{title}} / {{body}} / {{nope}}", { title: "{{body}}", body: "b" })).toBe("{{body}} / b / {{nope}}");
});

test("launcher: claude under nono, token read on the host, never written", () => {
  const c = config();
  const s = launcher(web(c), "/ws/web/gh-1", "/ws/web/gh-1.prompt.md", "/aw");
  expect(s).toContain(`CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.claude-aw/oauth-token")" || exit 1\nexport CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='/ws/web/gh-1'.claude CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR='/ws/web/gh-1'.claude/tmp`);
  expect(s).toContain("--no-rollback-prompt");
  expect(s).toContain(`exec nono run --no-rollback-prompt --profile '/aw/nono/aw-claude.json' --allow '/ws/web/gh-1' --allow '/ws/web/gh-1.claude' --read '${root}/src-web/.git' --allow '${root}/src-web/.git/objects' --allow '${root}/src-web/.git/refs' --allow '${root}/src-web/.git/logs' --allow '${root}/src-web/.git/worktrees/gh-1' -- claude --permission-mode`);
  expect(s).toContain(`--permission-mode bypassPermissions "$(cat '/ws/web/gh-1.prompt.md')"`);
});

test("launcher: codex without sandbox keeps the daemon", () => {
  const c = config({ repos: [{ name: "acme/web", agent: "codex", sandbox: "none" }] });
  const s = launcher(web(c), "/ws/web/gh-2", "/ws/web/gh-2.prompt.md", "/aw");
  expect(s).toContain('export CODEX_HOME="$HOME/.codex-aw"');
  expect(s).toContain(`exec codex --sandbox danger-full-access --ask-for-approval never -C '/ws/web/gh-2' "$(cat '/ws/web/gh-2.prompt.md')"`);
  expect(launcher(web(config({ repos: [{ name: "acme/web", agent: "codex" }] })), "/w", "/p", "/aw")).toContain("-- codex --no-daemon ");
});

test("launcher scripts are byte-for-byte stable for each agent, with and without nono", () => {
  const head = String.raw`#!/usr/bin/env bash
cd '/ws/it'\''s' || exit 1
unset LINEAR_API_KEY
`;
  const claudeEnv = String.raw`CLAUDE_CODE_OAUTH_TOKEN="$(cat "$HOME/.claude-aw/oauth-token")" || exit 1
export CLAUDE_CODE_OAUTH_TOKEN CLAUDE_CONFIG_DIR='/ws/it'\''s'.claude CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR='/ws/it'\''s'.claude/tmp; mkdir -p "$CLAUDE_CODE_TMPDIR"
`;
  const nono = (a: string, own = "") => String.raw`nono run --no-rollback-prompt --profile '/aw/nono/aw-${a}.json' --allow '/ws/it'\''s' ${own}--read '/src/web/.git' --allow '/src/web/.git/objects' --allow '/src/web/.git/refs' --allow '/src/web/.git/logs' --allow '/src/web/.git/worktrees/it'\''s' -- `;
  const claude = String.raw`claude --permission-mode bypassPermissions "$(cat '/ws/p.md')"
`;
  const codex = (d: string) => String.raw`codex ${d}--sandbox danger-full-access --ask-for-approval never -C '/ws/it'\''s' "$(cat '/ws/p.md')"
`;
  const s = (agent: string, sandbox: string) => launcher(web(config({ repos: [{ name: "acme/web", path: "/src/web", agent, sandbox }] })), "/ws/it's", "/ws/p.md", "/aw");
  expect(s("claude", "nono")).toBe(`${head}${claudeEnv}exec ${nono("claude", String.raw`--allow '/ws/it'\''s.claude' `)}${claude}`);
  expect(s("claude", "none")).toBe(`${head}${claudeEnv}exec ${claude}`);
  expect(s("codex", "nono")).toBe(`${head}export CODEX_HOME="$HOME/.codex-aw"\nexec ${nono("codex")}${codex("--no-daemon ")}`);
  expect(s("codex", "none")).toBe(`${head}export CODEX_HOME="$HOME/.codex-aw"\nexec ${codex("")}`);
});

test("starts ready tickets up to maxConcurrent", async () => {
  const c = config({ maxConcurrent: 2 });
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2), ticket(3)] });
  const { io, cmds } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-9"]) : a[4] === "--verify" ? { code: 1 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["claim gh-1"]);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-1 -b agent/gh-1 origin/main`);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n acme/web/gh-1 ${root}/acme/web/gh-1.sh`);
  const prompt = readFileSync(join(root, "acme/web/gh-1.prompt.md"), "utf8");
  expect(prompt).toContain("body; rm -rf ~ $(whoami)");
  expect(prompt).toContain("git push origin agent/gh-1");
  const seeded = JSON.parse(readFileSync(join(root, "acme/web/gh-1.claude/.claude.json"), "utf8"));
  expect(seeded.projects).toEqual({ [realpathSync(join(root, "src-web"))]: { hasTrustDialogAccepted: true } });
});

test("a claude start without the token file fails before cloning, with the fix in the log", async () => {
  rmSync(join(root, ".claude-aw/oauth-token"));
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut([]) : noPr(a)));
  await pass(config(), io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(cmds.filter((c) => / clone | worktree add | new-window /.test(c))).toEqual([]);
  expect(logs.join("\n")).toContain(`${root}/.claude-aw/oauth-token is missing: run \`claude setup-token\``);
});

test("seedClaude: a fresh dir with template links, account keys and trust only; dry run touches nothing", () => {
  const tpl = join(root, ".claude-aw");
  mkdirSync(join(root, ".claude/skills"), { recursive: true });
  mkdirSync(join(tpl, "plugins"), { recursive: true });
  writeFileSync(join(tpl, "settings.json"), "{}");
  symlinkSync(join(root, ".claude/skills"), join(tpl, "skills"));
  writeFileSync(join(tpl, ".credentials.json"), "{}");
  writeFileSync(join(tpl, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, oauthAccount: { a: 1 }, userID: "u", mcpServers: { x: {} }, projects: { "/o": { hasTrustDialogAccepted: true, mcpServers: { y: {} } } } }));
  const dir = join(root, "acme/web/gh-1.claude");
  const { io, logs } = fakeIo();
  seedClaude({ ...io, dry: true }, dir, "/r");
  expect(existsSync(dir)).toBe(false);
  mkdirSync(join(dir, "projects/x/memory"), { recursive: true });
  writeFileSync(join(dir, "settings.json"), '{"hooks":{}}');
  seedClaude(io, dir, "/r");
  expect(readdirSync(dir).sort()).toEqual([".claude.json", "plugins", "settings.json", "skills"]);
  expect(realpathSync(join(dir, "skills"))).toBe(realpathSync(join(root, ".claude/skills")));
  expect(realpathSync(join(dir, "settings.json"))).toBe(realpathSync(join(tpl, "settings.json")));
  expect(JSON.parse(readFileSync(join(dir, ".claude.json"), "utf8"))).toEqual({ hasCompletedOnboarding: true, oauthAccount: { a: 1 }, userID: "u", projects: { "/r": { hasTrustDialogAccepted: true } } });
  expect(statSync(join(dir, ".claude.json")).mode & 0o777).toBe(0o600);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
  expect(logs).toEqual([`dry: seed ${dir} from ${tpl}`, `seed ${dir} from ${tpl}`]);
});

test("reuses existing worktree dir and existing branch", async () => {
  const c = config();
  mkdirSync(join(root, "acme/web/gh-1"), { recursive: true });
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(logs.some((l) => l.includes(`reuse ${root}/acme/web/gh-1`))).toBe(true);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-2 agent/gh-2`);
});

test("in-progress: PR moves to review; missing window comments once", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(2), ticket(3)] });
  const { io, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-3"]);
    if (a[1] === "pr") return { out: a.includes("agent/gh-1") ? '[{"url":"https://pr/1","state":"OPEN"}]' : "[]" };
  });
  await pass(c, io, () => tr, "/aw");
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["review gh-1 https://pr/1", "comment gh-2 session ended without a PR", "review gh-1 https://pr/1"]);
  expect(existsSync(join(root, "acme/web/gh-2.ended"))).toBe(true);
  expect(readFileSync(join(root, "acme/web/gh-1.pr"), "utf8")).toBe("https://pr/1");
  expect(logs.filter((l) => l.endsWith("write " + join(root, "acme/web/gh-1.pr")))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-2.pr"))).toBe(false);
});

test("parked: no ended-without-PR comment, and a done parked ticket is still cleaned up", async () => {
  const c = config();
  const parked = (n: number) => ({ ...ticket(n), labels: ["Needs-Human"] });
  worktree("gh-2");
  mkdirSync(join(root, "src-web"), { recursive: true });
  const { tr, calls } = fakeTracker({ inProgress: [parked(1)], inReview: [parked(2)], done: ["gh-2"] });
  const { io, cmds } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-2"]) : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.ended"))).toBe(false);
  expect(cmds).toContain("tmux kill-window -t @0");
  expect(cmds.some((x) => x.includes("worktree remove") && x.endsWith("gh-2"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-2.source"))).toBe(false);
});

test("done: kills window, removes worktree, files and config dir; keeps them all when the worktree remove fails", async () => {
  const c = config();
  for (const id of ["gh-1", "gh-2", "gh-3"]) {
    mkdirSync(join(root, "acme/web", id), { recursive: true });
    for (const ext of [".prompt.md", ".sh", ".ended", ".pr", ".question"]) writeFileSync(join(root, "acme/web", id + ext), "");
    writeFileSync(join(root, "acme/web", `${id}.source`), "web\n");
    mkdirSync(join(root, "acme/web", `${id}.claude/projects/p`), { recursive: true });
    symlinkSync(join(root, "src-web"), join(root, "acme/web", `${id}.claude/link`));
  }
  mkdirSync(join(root, "src-web"), { recursive: true });
  const { tr } = fakeTracker({ done: ["gh-1", "gh-2"] });
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-1"]);
    if (a[3] === "worktree" && a.at(-1)?.endsWith("gh-2")) return { code: 1 };
  });
  await pass(c, io, () => tr, "/aw");
  expect(cmds).toContain("tmux kill-window -t @0");
  expect(cmds.filter((x) => x.includes("kill-window"))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-1.sh"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.pr"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.question"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.claude"))).toBe(false);
  expect(existsSync(join(root, "src-web"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-3.claude"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-2.claude"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-2.sh"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-3.sh"))).toBe(true);
  expect(logs.some((l) => l.includes("[web] cleanup acme/web/gh-2 failed"))).toBe(true);
});

test("a failed start leaves the ticket unclaimed and retries next poll; a failed claim kills the window", async () => {
  const c = config();
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  let tmuxDown = true;
  const { io, cmds, logs } = fakeIo((a) => ((a[1] === "new-window" && tmuxDown) || a[1] === "kill-window" ? { code: 1 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(logs.some((l) => l.includes("start gh-1 failed"))).toBe(true);
  tmuxDown = false;
  tr.claim = () => Promise.reject(new Error("tracker down"));
  await pass(c, io, () => tr, "/aw");
  expect(logs).toContain(`[web] reuse ${root}/acme/web/gh-1`);
  expect(cmds).toContain("tmux kill-window -t =aw:=acme/web/gh-1");
  expect(logs.some((l) => l.includes("start gh-1 failed: tracker down"))).toBe(true);
  expect(logs.some((l) => l.includes("kill window acme/web/gh-1 by hand"))).toBe(true);
});

test("one ticket or source failing does not stop the rest", async () => {
  const c = config({ sources: [src(), src({ name: "api" })] });
  const bad: Tracker = { ...fakeTracker({}).tr, listReady: () => Promise.reject(new Error("api down")), listInProgress: () => Promise.reject(new Error("api down")) };
  const good = fakeTracker({ ready: [ticket(1), ticket(2)] });
  good.tr.claim = async (t) => {
    if (t.id === "gh-1") throw new Error("nope");
    good.calls.push(`claim ${t.id}`);
  };
  const { io, logs } = fakeIo(noPr);
  await pass(c, io, (l) => (l.name === "web" ? bad : good.tr), "/aw");
  expect(logs.some((l) => l.includes("[web] list ready failed: api down"))).toBe(true);
  expect(logs.some((l) => l.includes("[api] start gh-1 failed: nope"))).toBe(true);
  expect(good.calls).toEqual(["claim gh-2"]);
});

test("dry-run logs side effects and executes none", async () => {
  const c = config();
  mkdirSync(join(root, "acme/web/gh-5"), { recursive: true });
  writeFileSync(join(root, "acme/web/gh-5.source"), "web");
  const { tr } = fakeTracker({ ready: [ticket(1)], inProgress: [ticket(2)], done: ["gh-5"] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "has-session" ? { code: 1 } : a[1] === "pr" && a.includes("agent/gh-2") ? { out: '[{"url":"https://pr/2","state":"OPEN"}]' } : noPr(a)), true);
  await pass(c, io, () => tr, "/aw");
  expect(cmds.every((x) => /has-session|list-windows|rev-parse|gh pr list|gh repo view/.test(x))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-session -d -s aw"))).toBe(true);
  expect(logs.some((l) => l.startsWith("[web] dry: nono run ") && l.endsWith(`-C ${root}/acme/web/gh-5 status --porcelain --ignore-submodules=none`))).toBe(true);
  expect(logs.some((l) => l.includes(`dry: ${GIT.join(" ")} -C ${root}/src-web worktree remove --force --force ${root}/acme/web/gh-5`))).toBe(true);
  expect(logs.some((l) => l.includes("dry: tmux new-window"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.prompt.md"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-2.pr"))).toBe(false);
});

test("pass hands defaultHost to the tracker factory", async () => {
  const c = config({ defaultHost: true });
  const seen: unknown[] = [];
  const { io } = fakeIo(noPr);
  await pass(c, io, (_l, host, _io, defaultHost) => (seen.push(host, defaultHost), fakeTracker({}).tr), "/aw");
  expect(seen).toEqual(["box", true]);
});

test("start never writes .aw/.gitignore through an agent-planted symlink", async () => {
  const c = config();
  const { tr } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, logs } = fakeIo(noPr);
  mkdirSync(join(root, "outside"));
  writeFileSync(join(root, "outside/victim"), "secret");
  mkdirSync(join(root, "acme/web/gh-1/.aw"), { recursive: true });
  symlinkSync(join(root, "outside/victim"), join(root, "acme/web/gh-1/.aw/.gitignore"));
  mkdirSync(join(root, "acme/web/gh-2"), { recursive: true });
  symlinkSync(join(root, "outside"), join(root, "acme/web/gh-2/.aw"));
  await pass(c, io, () => tr, "/aw");
  expect(readFileSync(join(root, "outside/victim"), "utf8")).toBe("secret");
  expect(readFileSync(join(root, "acme/web/gh-1/.aw/.gitignore"), "utf8")).toBe("*\n");
  expect(existsSync(join(root, "outside/.gitignore"))).toBe(false);
  expect(logs.some((l) => l.includes("start gh-2 failed: ENOTDIR"))).toBe(true);
});

test("allowlist: a rejected ticket gets one comment whatever the reason, kept across restarts", async () => {
  const c = two();
  const eng = (n: number, repo?: string): Ticket => ({ ...ticket(n), id: `ENG-${n}`, repo });
  const run = async (ready: Ticket[]) => {
    const f = fakeTracker({ ready });
    const { io, cmds } = fakeIo(noPr);
    await pass(c, io, (s) => (s.name === "lin" ? f.tr : fakeTracker({}).tr), "/aw");
    return { calls: f.calls, cmds };
  };
  const first = await run([eng(1, "evil/x"), eng(2), eng(3, "a/b;rm -rf ~")]);
  expect(first.calls).toEqual([
    "comment ENG-1 repo evil/x is not in the aw allowlist",
    expect.stringContaining("comment ENG-2 no repo set on this ticket"),
    'comment ENG-3 repo "a/b;rm -rf ~" is not a valid owner/name',
  ]);
  expect(first.cmds.some((x) => /worktree|new-window|clone/.test(x))).toBe(false);
  expect((await run([eng(1, "evil/x"), eng(2), eng(3, "a/b;rm -rf ~")])).calls).toEqual([]);
  for (const repo of ["EVIL/X", "evil/y", "evil/x", undefined]) expect((await run([eng(1, repo)])).calls).toEqual([]);
  expect(readFileSync(join(root, ".rejected/ENG-1"), "utf8")).toBe("repo evil/x is not in the aw allowlist");
});

test("allowlist match is case-insensitive and uses the canonical key", async () => {
  const c = two();
  const { tr, calls } = fakeTracker({ ready: [{ ...ticket(1), id: "ENG-1", repo: "ACME/Api" }] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "lin" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim ENG-1"]);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n acme/api/ENG-1 ${root}/acme/api/ENG-1.sh`);
  expect(readFileSync(join(root, "acme/api/ENG-1.source"), "utf8")).toBe("lin");
  expect(readFileSync(join(root, "acme/api/ENG-1.prompt.md"), "utf8")).toContain("GitHub repository acme/api");
});

test("clone on demand: missing clone is cloned with gh before the worktree, existing one is not", async () => {
  const c = two();
  mkdirSync(join(root, "src-web"));
  const { tr } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(cmds.filter((x) => x.startsWith("gh repo clone"))).toEqual([]);
  const c2 = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  const f = fakeTracker({ ready: [ticket(3)] });
  const r2 = fakeIo(noPr);
  await pass(c2, r2.io, () => f.tr, "/aw");
  const clone = r2.cmds.findIndex((x) => x.startsWith(`gh repo clone acme/web ${root}/clones/acme/web.tmp-`));
  expect(clone).toBeGreaterThan(-1);
  expect(r2.cmds.indexOf(`git -C ${root}/clones/acme/web fetch origin main`)).toBeGreaterThan(clone);
  expect(readdirSync(join(root, "clones/acme"))).toEqual(["web"]);
});

test("same ticket number in two repos does not collide", async () => {
  const c = two();
  const { tr, calls } = fakeTracker({ ready: [ticket(12), ticket(12, "acme/api")] });
  const { io, cmds } = fakeIo((a) => (a[4] === "--verify" ? { code: 1 } : noPr(a)));
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim gh-12", "claim gh-12"]);
  expect(cmds).toContain(`git -C ${root}/src-web worktree add ${root}/acme/web/gh-12 -b agent/gh-12 origin/main`);
  expect(cmds).toContain(`git -C ${root}/src-api worktree add ${root}/acme/api/gh-12 -b agent/gh-12 origin/main`);
  expect(cmds.filter((x) => x.includes("new-window")).map((x) => x.split(" ")[6])).toEqual(["acme/web/gh-12", "acme/api/gh-12"]);
  expect(readFileSync(join(root, "acme/api/gh-12.prompt.md"), "utf8")).toContain("acme/api");
  expect(readFileSync(join(root, "acme/web/gh-12.prompt.md"), "utf8")).toContain("acme/web");
});

test("concurrency: per-repo limit and global limit both apply", async () => {
  const c = two({ maxConcurrent: 1 });
  const { tr, calls } = fakeTracker({ ready: [ticket(1, "acme/api"), ticket(2, "acme/api"), ticket(3), ticket(4), ticket(5)] });
  const { io } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/gh-9", "other"]) : noPr(a)));
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual(["claim gh-1", "claim gh-3", "claim gh-4"]);
  const busy = fakeTracker({ ready: [ticket(6, "acme/web")] });
  const r = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/api/gh-1"]) : noPr(a)));
  await pass(c, r.io, (s) => (s.name === "gh" ? busy.tr : fakeTracker({}).tr), "/aw");
  expect(busy.calls).toEqual(["claim gh-6"]);
});

test("priority: ready tickets from all sources start most urgent first, before the maxConcurrent cut", async () => {
  const c = two();
  c.maxConcurrent = 2;
  const gh = fakeTracker({ ready: [ticket(1), { ...ticket(2), priority: 3 }] });
  const lin = fakeTracker({ ready: [{ ...ticket(3), id: "ENG-3", repo: "acme/api", priority: 1 }, { ...ticket(4), id: "ENG-4", repo: "acme/api" }] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(cmds.filter((x) => x.includes("new-window")).map((x) => x.split(" ")[6])).toEqual(["acme/api/ENG-3", "acme/web/gh-2"]);
  expect([...gh.calls, ...lin.calls]).toEqual(["claim gh-2", "claim ENG-3"]);
});

test("after a restart cleanup and findPr use the repo and source recorded next to the worktree", async () => {
  const c = two();
  for (const [dir, id, source] of [["acme/web", "gh-5", "gh"], ["acme/api", "gh-5", "gh"], ["acme/api", "ENG-7", "lin"], ["acme/web", "gh-6", "gone"]]) {
    mkdirSync(join(root, dir!, id!), { recursive: true });
    writeFileSync(join(root, dir!, `${id}.source`), source!);
  }
  const gh = fakeTracker({ done: ["acme/api#gh-5"], inProgress: [ticket(5, "acme/api")] });
  const lin = fakeTracker({ inProgress: [{ ...ticket(7), id: "ENG-7", repo: "acme/web" }] });
  let names = ["acme/web/gh-5", "acme/api/gh-5", "acme/api/ENG-7"];
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(names);
    if (a[1] === "kill-window") names = names.filter((_, i) => `@${i}` !== a.at(-1));
    if (a[4] === "remove") rmSync(a.at(-1)!, { recursive: true });
    return noPr(a);
  });
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(cmds.filter((x) => /worktree remove|kill-window/.test(x))).toEqual(["tmux kill-window -t @1", `git -C ${root}/src-api worktree remove --force --force ${root}/acme/api/gh-5`]);
  expect(existsSync(join(root, "acme/web/gh-5.source"))).toBe(true);
  expect(logs.some((l) => l.includes(`acme/web/gh-6: source "gone" in gh-6.source is not configured; left alone`))).toBe(true);
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/gh-5 --state all --json url,state");
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/ENG-7 --state all --json url,state");
  expect(cmds.some((x) => x.includes("--repo acme/web --head agent/ENG-7"))).toBe(false);
  expect(lin.calls).toEqual([]);
  // Closed but still listed in progress, after the worktree is gone too.
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(gh.calls).toEqual([]);
  expect(existsSync(join(root, "acme/api/gh-5.ended"))).toBe(false);
});

test("redirected or unresolvable repos are skipped before listing, cloning or starting", async () => {
  const c = config({ repos: ["acme/web", { name: "acme/api", path: join(root, "src-api") }, { name: "acme/docs", path: join(root, "src-docs") }], sources: [src({ name: "gh" }), src({ name: "lin", tracker: "linear", team: "ENG" })] });
  const eng = (n: number, repo: string): Ticket => ({ ...ticket(n), id: `ENG-${n}`, repo });
  const st = { ready: [eng(1, "acme/api"), eng(2, "acme/docs"), eng(3, "acme/web")] };
  const lin = fakeTracker(st);
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[2] === "view" && a[3] === "acme/api") return { out: '{"nameWithOwner":"evil/api"}' };
    if (a[2] === "view" && a[3] === "acme/docs") return { code: 1 };
    if (a[2] === "list") return { out: "[]" };
    return noPr(a);
  });
  const factory = (s: any, h: string, i: Io, d: boolean, repos: string[]) => (s.name === "gh" ? github(s, h, i, d, repos) : lin.tr);
  await pass(c, io, factory, "/aw");
  st.ready = st.ready.slice(0, 2);
  await pass(c, io, factory, "/aw");
  expect(lin.calls).toEqual(["comment ENG-1 repo acme/api now resolves to evil/api on GitHub, which is not in the aw allowlist", "claim ENG-3"]);
  expect(cmds.filter((x) => x.startsWith("gh issue list")).map((x) => x.split(" ")[4])).toEqual(Array(6).fill("acme/web"));
  expect(cmds.filter((x) => x === "gh repo view acme/api --json nameWithOwner")).toHaveLength(3);
  expect(cmds.filter((x) => x === "gh repo view acme/docs --json nameWithOwner").length).toBeGreaterThan(1);
  expect(cmds.some((x) => /clone acme\/(api|docs)|src-(api|docs)/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes('repo acme/api: GitHub resolves it to "evil/api", skipped'))).toBe(true);
  expect(logs.some((l) => l.includes("repo acme/docs: lookup failed, skipped"))).toBe(true);
});

test("a Linear ticket requeued with another repo does not start a second session", async () => {
  const c = two();
  worktree("ENG-1", "lin", "acme/web");
  const lin = fakeTracker({ ready: [{ ...ticket(1), id: "ENG-1", repo: "acme/api" }, { ...ticket(2), id: "ENG-2", repo: "acme/api" }] });
  const { io, cmds, logs } = fakeIo((a) => (a[1] === "list-windows" ? windowsOut(["acme/web/ENG-2"]) : noPr(a)));
  await pass(c, io, (s) => (s.name === "lin" ? lin.tr : fakeTracker({}).tr), "/aw");
  expect(lin.calls).toEqual([]);
  expect(cmds.some((x) => /new-window|worktree add/.test(x))).toBe(false);
  expect(logs.filter((l) => l.includes("already started in acme/web"))).toHaveLength(2);
});

test("only the source recorded in <ID>.source reconciles a worktree; a missing owner is logged once", async () => {
  const c = config({ sources: [src({ name: "gh" }), src({ name: "gh2", readyLabel: "agent2" })] });
  worktree("gh-1", "gh2");
  worktree("gh-2", "gone");
  const t = [ticket(1), ticket(2)];
  const gh = fakeTracker({ inProgress: t, inReview: t });
  const gh2 = fakeTracker({ inProgress: t, inReview: t });
  const { io, logs } = fakeIo((a) => (a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : undefined));
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : gh2.tr), "/aw");
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : gh2.tr), "/aw");
  expect(gh.calls).toEqual([]);
  expect(gh2.calls).toEqual(["review gh-1 https://pr/1", "review gh-1 https://pr/1"]);
  expect(logs.filter((l) => l.includes('source "gone"'))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-2"))).toBe(true);
});

test("repo names map to distinct dirs; dot components and a .git suffix are rejected", async () => {
  for (const bad of ["acme/.", "acme/..", "./x", "../x", ".x/y", "acme/web.git", "acme/Web.GIT"]) expect(validRepo(bad)).toBe(false);
  for (const ok of ["a__b/c", "a/b__c", "acme/.github", "acme/web.js"]) expect(validRepo(ok)).toBe(true);
  const c = config({ repos: [{ name: "a__b/c", path: join(root, "s1") }, { name: "a/b__c", path: join(root, "s2") }] });
  const { tr, calls } = fakeTracker({ ready: [ticket(1, "a__b/c"), ticket(1, "a/b__c")] });
  const { io, cmds } = fakeIo(noPr);
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual(["claim gh-1", "claim gh-1"]);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n a__b/c/gh-1 ${root}/a__b/c/gh-1.sh`);
  expect(cmds).toContain(`tmux new-window -d -t =aw: -n a/b__c/gh-1 ${root}/a/b__c/gh-1.sh`);
  expect(readFileSync(join(root, "a/b__c/gh-1.prompt.md"), "utf8")).toContain("a/b__c");
});

test("clone: a leftover non-git dir or a failed clone fails the start before claiming, deleting nothing", async () => {
  const c = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  mkdirSync(join(root, "clones/acme/web"), { recursive: true });
  writeFileSync(join(root, "clones/acme/web/partial"), "");
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds, logs } = fakeIo((a) => (a[5] === "--git-common-dir" ? { code: 128 } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(logs.some((l) => l.includes(`start gh-1 failed: ${root}/clones/acme/web is not the top of its own git clone`))).toBe(true);
  expect(existsSync(join(root, "clones/acme/web/partial"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(cmds.some((x) => /repo clone|worktree add/.test(x))).toBe(false);
  const c2 = config({ reposRoot: join(root, "c2"), repos: ["acme/web"] });
  const f = fakeTracker({ ready: [ticket(1)] });
  const r2 = fakeIo((a) => (a[2] === "clone" ? { code: 1 } : noPr(a)));
  await pass(c2, r2.io, () => f.tr, "/aw");
  expect(f.calls).toEqual([]);
  expect(existsSync(join(root, "c2/acme/web"))).toBe(false);
});

test("a repo transferred while its name is cached is caught by a fresh lookup before clone or start", async () => {
  const c = config({ reposRoot: join(root, "clones"), repos: ["acme/web"] });
  canonCache.set("acme/web", { name: "acme/web", at: Date.now() });
  const { tr, calls } = fakeTracker({ ready: [ticket(1)] });
  const { io, cmds, logs } = fakeIo((a) => (a[2] === "view" ? { out: '{"nameWithOwner":"evil/web"}' } : noPr(a)));
  await pass(c, io, () => tr, "/aw");
  expect(calls).toEqual([]);
  expect(cmds.some((x) => /repo clone|worktree add|new-window/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes('repo acme/web: GitHub resolves it to "evil/web", skipped'))).toBe(true);
});

test("a ready ticket never takes over a worktree recorded for another source", async () => {
  const c = config({ sources: [src({ name: "gh" }), src({ name: "gh2", readyLabel: "agent2" })] });
  worktree("gh-1", "gh2");
  worktree("gh-2", "gone");
  const { tr, calls } = fakeTracker({ ready: [ticket(1), ticket(2)] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "gh" ? tr : fakeTracker({}).tr), "/aw");
  expect(calls).toEqual([]);
  expect(cmds.some((x) => /new-window/.test(x))).toBe(false);
  expect(readFileSync(join(root, "acme/web/gh-1.source"), "utf8")).toBe("gh2");
  expect(logs.some((l) => l.includes('skip gh-1: acme/web/gh-1 belongs to source "gh2"'))).toBe(true);
});

test("a Linear ticket started in a repo since removed from aw.json is not started or reconciled elsewhere", async () => {
  const c = two();
  worktree("ENG-1", "lin", "acme/old");
  const eng1 = { ...ticket(1), id: "ENG-1", repo: "acme/api" };
  const lin = fakeTracker({ ready: [eng1], inProgress: [eng1] });
  const { io, cmds, logs } = fakeIo(noPr);
  await pass(c, io, (s) => (s.name === "lin" ? lin.tr : fakeTracker({}).tr), "/aw");
  expect(lin.calls).toEqual([]);
  expect(cmds.some((x) => /new-window|worktree add|agent\/ENG-1/.test(x))).toBe(false);
  expect(logs.some((l) => l.includes("skip ENG-1: already started in acme/old"))).toBe(true);
});

test("rejection: one comment per Linear ticket across sources and starts; marked before posting, unmarked on failure", async () => {
  const c = config({ maxConcurrent: 4, repos: [{ name: "acme/web", path: join(root, "src-web") }], sources: [src({ name: "lin", tracker: "linear", team: "ENG" }), src({ name: "lin2", tracker: "linear", team: "ENG", readyLabel: "agent2" })] });
  const eng = (repo?: string): Ticket => ({ ...ticket(1), id: "ENG-1", repo });
  const marker = join(root, ".rejected/ENG-1");
  const comments: string[] = [];
  const run = async (repo: string | undefined, fail = false) => {
    const f = fakeTracker({ ready: [eng(repo)] });
    f.tr.comment = async (t, b) => {
      expect(existsSync(marker)).toBe(true);
      if (fail) throw new Error("linear down");
      comments.push(`${t.id} ${b}`);
    };
    await pass(c, fakeIo(noPr).io, () => f.tr, "/aw");
    return f.calls;
  };
  await run("evil/x", true);
  expect(existsSync(marker)).toBe(false);
  await run("evil/x");
  expect(comments).toEqual(["ENG-1 repo evil/x is not in the aw allowlist"]);
  expect(await run("acme/web")).toEqual(["claim ENG-1"]);
  rmSync(join(root, "acme/web/ENG-1"), { recursive: true });
  rmSync(join(root, "acme/web/ENG-1.source"));
  await run(undefined);
  expect(comments).toHaveLength(1);
});

test("clone path: a subdirectory or alias of another repo's clone is refused at start", async () => {
  const git = (...a: string[]) => Bun.spawnSync(["git", ...a], { stdout: "pipe" });
  expect(git("init", "-q", join(root, "clone")).exitCode).toBe(0);
  mkdirSync(join(root, "clone/sub"));
  symlinkSync(join(root, "clone"), join(root, "alias"));
  const run = async (path: string) => {
    const c = config({ repos: [{ name: "acme/web", path: join(root, "clone") }, { name: "acme/api", path }] });
    const { tr, calls } = fakeTracker({ ready: [ticket(1, "acme/api")] });
    const { io, logs } = fakeIo((a) => (a[5] === "--git-common-dir" ? { out: git(...a.slice(1)).stdout.toString() } : noPr(a)));
    await pass(c, io, () => tr, "/aw");
    expect(calls).toEqual([]);
    return logs.find((l) => l.includes("start gh-1 failed"));
  };
  expect(await run(join(root, "clone/sub"))).toContain("is not the top of its own git clone");
  expect(await run(join(root, "alias"))).toContain("is the same clone as acme/web's path");
});

test("aw's git calls run no hook files, fsmonitor or auto-gc planted in the clone's .git", () => {
  const origin = join(root, "origin");
  const clone = join(root, "clone");
  const marker = join(root, "fired");
  const run = (...a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }).exitCode;
  const git = (...a: string[]) => run("git", "-C", clone, ...a);
  const commit = () => run("git", "-C", origin, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "c");
  expect(run("git", "init", "-q", origin)).toBe(0);
  expect(commit()).toBe(0);
  expect(run("git", "clone", "-q", origin, clone)).toBe(0);
  mkdirSync(join(root, "blobs"));
  for (let i = 0; i < 2000; i++) writeFileSync(join(root, "blobs", `${i}`), `${i}`);
  expect(Bun.spawnSync(["git", "-C", clone, "hash-object", "-w", "--stdin-paths"], { stdin: Buffer.from(readdirSync(join(root, "blobs")).map((f) => join(root, "blobs", f)).join("\n")) }).exitCode).toBe(0);
  const evil = `#!/bin/sh\necho x >> '${marker}'\n`;
  for (const h of ["post-checkout", "reference-transaction", "post-index-change", "pre-auto-gc"]) writeFileSync(join(clone, ".git/hooks", h), evil, { mode: 0o755 });
  writeFileSync(join(root, "fsm"), evil, { mode: 0o755 });
  for (const [k, v] of [["core.fsmonitor", join(root, "fsm")], ["hook.evil.command", `echo x >> '${marker}'`], ["hook.evil.event", "pre-auto-gc"], ["gc.auto", "1"], ["gc.autoDetach", "false"], ["maintenance.autoDetach", "false"], ["maintenance.gc.enabled", "true"]]) git("config", k!, v!);
  // The test origin is a local path, which GIT itself refuses.
  const fetch = (...c: string[]) => (commit(), run(...GIT, "-c", "protocol.file.allow=always", ...c, "-C", clone, "fetch", "-q", "origin"));
  expect(fetch()).toBe(0);
  expect(run(...GIT, "-C", clone, "worktree", "add", "-q", join(root, "wt"), "-b", "agent/x")).toBe(0);
  expect(run(...GIT, "-C", clone, "worktree", "remove", join(root, "wt"))).toBe(0);
  expect(existsSync(marker)).toBe(false);
  expect(fetch("-c", "maintenance.auto=true")).toBe(0);
  expect(existsSync(marker)).toBe(true);
  rmSync(marker);
  expect(git("worktree", "add", "-q", join(root, "wt2"), "-b", "agent/y")).toBe(0);
  expect(existsSync(marker)).toBe(true);
});

test("cleanup never runs git's own dirty check, which follows a planted commondir or config.worktree", async () => {
  const clone = join(root, "src-web");
  const marker = join(root, "fired");
  const sh = (...a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" });
  expect(sh("git", "init", "-q", clone).exitCode).toBe(0);
  writeFileSync(join(clone, "f"), "a");
  expect(sh("git", "-C", clone, "add", "f").exitCode).toBe(0);
  expect(sh("git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", "i").exitCode).toBe(0);
  writeFileSync(join(root, "clean"), `#!/bin/sh\necho x >> '${marker}'; cat\n`, { mode: 0o755 });
  const plant = (id: string, how: "commondir" | "config.worktree") => {
    const wt = join(root, "acme/web", id);
    expect(sh(...GIT, "-C", clone, "worktree", "add", "-q", wt, "-b", `agent/${id}`).exitCode).toBe(0);
    worktree(id);
    writeFileSync(join(wt, "f"), "x");
    writeFileSync(join(wt, ".gitattributes"), "* filter=evil\n");
    mkdirSync(`${wt}.claude`);
    const admin = join(clone, ".git/worktrees", id);
    if (how === "commondir") {
      const fake = join(root, `fake-${id}`);
      sh("cp", "-r", join(clone, ".git"), fake);
      sh("git", "--git-dir", fake, "config", "filter.evil.clean", join(root, "clean"));
      writeFileSync(join(admin, "commondir"), fake);
    } else {
      sh("git", "-C", clone, "config", "extensions.worktreeConfig", "true");
      writeFileSync(join(admin, "config.worktree"), `[filter "evil"]\n\tclean = ${join(root, "clean")}\n`);
    }
    return wt;
  };
  const a = plant("gh-1", "commondir");
  const b = plant("gh-2", "config.worktree");
  const run = async (nonoOut: string) => {
    const { tr } = fakeTracker({ done: ["gh-1", "gh-2"] });
    const { io, logs } = fakeIo((x) => (x[0] === "nono" ? { out: nonoOut } : x[0] === "git" ? (({ exitCode, stdout }) => ({ code: exitCode, out: stdout.toString() }))(sh(...GIT, ...x.slice(1))) : noPr(x)));
    await pass(config({ repos: [{ name: "acme/web", path: clone }] }), io, () => tr, "/aw");
    return logs;
  };
  expect((await run("?? f\n")).filter((l) => l.includes("has uncommitted or untracked files"))).toHaveLength(2);
  expect([existsSync(a), existsSync(b), existsSync(marker), existsSync(`${a}.claude`)]).toEqual([true, true, false, true]);
  for (const wt of [a, b]) {
    expect(sh("git", "-C", clone, "worktree", "remove", wt).exitCode).not.toBe(0);
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);
  }
  await run("");
  expect([existsSync(a), existsSync(b), existsSync(marker), existsSync(`${a}.claude`)]).toEqual([false, false, false, false]);
});

test("cleanup removes a done worktree despite a planted lock file, dir, FIFO or symlink; a dirty one is still kept", async () => {
  const clone = join(root, "src-web");
  const target = join(root, "target");
  const sh = (...a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" });
  expect(sh("git", "init", "-q", clone).exitCode).toBe(0);
  expect(sh("git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i").exitCode).toBe(0);
  writeFileSync(target, "keep");
  const kinds = { "gh-1": "file", "gh-2": "dir", "gh-3": "fifo", "gh-4": "symlink", "gh-5": "file" } as const;
  for (const [id, kind] of Object.entries(kinds)) {
    expect(sh(...GIT, "-C", clone, "worktree", "add", "-q", join(root, "acme/web", id), "-b", `agent/${id}`).exitCode).toBe(0);
    worktree(id);
    const locked = join(clone, ".git/worktrees", id, "locked");
    if (kind === "file") writeFileSync(locked, "mine");
    else if (kind === "dir") mkdirSync(locked);
    else if (kind === "fifo") expect(sh("mkfifo", locked).exitCode).toBe(0);
    else symlinkSync(target, locked);
  }
  const { tr } = fakeTracker({ done: Object.keys(kinds) });
  const { io, logs } = fakeIo((x) =>
    x[0] === "nono" ? { out: x.includes(join(root, "acme/web/gh-5")) ? "?? f\n" : "" } : x[0] === "git" ? (({ exitCode, stdout }) => ({ code: exitCode, out: stdout.toString() }))(sh(...GIT, ...x.slice(1))) : noPr(x),
  );
  await pass(config({ repos: [{ name: "acme/web", path: clone }] }), io, () => tr, "/aw");
  expect(Object.keys(kinds).filter((id) => existsSync(join(root, "acme/web", id)))).toEqual(["gh-5"]);
  expect(readdirSync(join(clone, ".git/worktrees"))).toEqual(["gh-5"]);
  expect(logs.filter((l) => l.includes("failed"))).toEqual([expect.stringContaining("gh-5 has uncommitted or untracked files")]);
  expect(readFileSync(target, "utf8")).toBe("keep");
});

test("the session is granted git's actual admin dir, and a .git pointing elsewhere is refused", () => {
  const clone = join(root, "src-web");
  const sh = (...a: string[]) => Bun.spawnSync(a, { stdout: "pipe", stderr: "pipe" }).exitCode;
  expect(sh("git", "init", "-q", clone)).toBe(0);
  expect(sh("git", "-C", clone, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "i")).toBe(0);
  expect(sh(...GIT, "-C", clone, "worktree", "add", "-q", join(root, "other/gh-1"), "-b", "other")).toBe(0);
  const wt = join(root, "acme/web/gh-1");
  expect(sh(...GIT, "-C", clone, "worktree", "add", "-q", wt, "-b", "agent/gh-1")).toBe(0);
  const r = { ...web(config()), path: clone };
  expect(adminDir(r, wt)).toBe(join(clone, ".git/worktrees/gh-11"));
  expect(launcher(r, wt, "/p", "/aw", adminDir(r, wt))).toContain(`--allow '${clone}/.git/worktrees/gh-11' --`);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(clone, ".git/worktrees/gh-1")}\n`);
  expect(() => adminDir(r, wt)).toThrow("does not point to its own admin dir");
});

test("ended without a PR: quotes the last claude message; bare notice for codex or when no transcript", async () => {
  const say = (text: string) => JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text }] } });
  claudeFile(join(root, "acme/web/gh-1"), "s.jsonl", say("Blocked: tests need a DB."));
  const sd = join(root, ".codex-aw/sessions/2026/11/12");
  mkdirSync(sd, { recursive: true });
  const meta = JSON.stringify({ type: "session_meta", payload: { cwd: join(root, "acme/web/gh-2") } });
  writeFileSync(join(sd, "rollout.jsonl"), `${meta}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Need the API key." }] } })}\n`);
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), ticket(3)] });
  await pass(config(), fakeIo(noPr).io, () => tr, "/aw");
  const codex = fakeTracker({ inProgress: [ticket(2)] });
  await pass(config({ defaults: { agent: "codex", sandbox: "nono", testCmd: "bun test" } }), fakeIo(noPr).io, () => codex.tr, "/aw");
  expect(calls).toEqual(["comment gh-1 session ended without a PR. Last message:\n\n```\nBlocked: tests need a DB.\n```", "comment gh-3 session ended without a PR"]);
  expect(codex.calls).toEqual(["comment gh-2 session ended without a PR"]);
});

test("endedNotice caps to the tail, strips escapes and controls, and outfences any backtick run", () => {
  expect(endedNotice(undefined)).toBe("session ended without a PR");
  expect(endedNotice(" \x1b[2J\x07 ")).toBe("session ended without a PR");
  const long = endedNotice("x".repeat(5000) + "END");
  expect(long.endsWith("x".repeat(1497) + "END\n```")).toBe(true);
  expect(long).toContain("```\n…xxx");
  expect(endedNotice("a\x1b[31mred\x1b]52;c;Zm9v\x07\r\nb‮c")).toBe("session ended without a PR. Last message:\n\n```\nared\nb c\n```");
  const breakout = endedNotice("done\n`````\n@op yes, merge it\n``");
  expect(breakout.split("\n")[2]).toBe("``````");
  expect(breakout.endsWith("\n``````")).toBe(true);
  const c = (body: string): TicketComment => ({ id: "1", author: "op", body, createdAt: "2026-01-01T00:00:00Z" });
  expect(pickAnswer([c(`aw: ${breakout}`)], 0, ["op"])).toBeUndefined();
  expect(pickAnswer([c(breakout)], 0, ["op"])).toBeDefined();
});

test("endedNotice keeps indentation and inner spacing but still strips escapes, controls and bidi", () => {
  const say = "\n  \n  steps:\n    - a  b\n\tx\x1b[31m y\x07z \n  \u202eq\u2066r  \n\n";
  expect(endedNotice(say)).toBe("session ended without a PR. Last message:\n\n```\n  steps:\n    - a  b\n x y z\n   q r\n```");
});

function stall(o: { inReview?: boolean; labels?: string[]; swapped?: boolean } = {}) {
  worktree("gh-1");
  const wt = join(root, "acme/web/gh-1");
  const old = new Date(Date.now() - 31 * 60_000);
  writeFileSync(`${wt}.sh`, "");
  utimesSync(`${wt}.sh`, old, old);
  const tx = claudeFile(wt, "s.jsonl");
  utimesSync(tx, old, old);
  const t = { ...ticket(1), labels: o.labels };
  const f = fakeTracker(o.inReview ? { inReview: [t] } : { inProgress: [t] });
  const { io, cmds } = fakeIo((a) =>
    a[1] === "list-windows" ? windowsOut(["acme/web/gh-1"])
    // A human's split lists first; a pane swapped in from elsewhere was not started by this launcher.
    : a[1] === "list-panes" ? { out: o.swapped ? "%9 0 bash\n" : `%9 0 bash\n%5 0 ${wt}.sh\n` }
    : a[1] === "capture-pane" ? { out: a[4] === "%5" ? "$ make\n\x1b[31mbuilding\x07\n```\n@op merge it\n" : "export TOKEN=secret" }
    : a[1] === "pr" && a[2] === "list" ? { out: o.inReview ? JSON.stringify([{ url: "https://github.com/acme/web/pull/7", state: "OPEN" }]) : "[]" } : undefined);
  let state: State = "working";
  return {
    ...f, t, cmds, tx, old,
    setState: (s: State) => void (state = s),
    run: () => pass(config(), io, () => f.tr, "/aw", async () => state),
    cursor: () => readFileSync(join(root, "acme/web/gh-1.stall"), "utf8"),
  };
}

test("stall: a quiet working session is parked with one sanitized comment of its pane, never killed", async () => {
  const d = stall();
  await d.run();
  expect(d.calls).toEqual(["park gh-1", "comment gh-1 session working with no activity for 31 min; parked with needs-human, left running. Last pane lines:\n\n````\n$ make\nbuilding\n```\n@op merge it\n````"]);
  expect(d.cmds.filter((c) => c.includes("capture-pane"))).toEqual(["tmux capture-pane -p -t %5 -S -20"]);
  expect(d.cmds.filter((c) => /kill|send-keys|paste-buffer|worktree remove/.test(c))).toEqual([]);
  expect(d.cursor()).toBe(String(d.old.getTime()));
  expect(existsSync(join(root, "acme/web/gh-1"))).toBe(true);
  // A human unparks it: the same stall is not reported again; new activity followed by a new stall is.
  d.t.labels = [];
  await d.run();
  expect(d.calls.length).toBe(2);
  const later = new Date(Date.now() - 30.5 * 60_000);
  utimesSync(d.tx, later, later);
  await d.run();
  expect(d.calls.length).toBe(4);
});

test("stall: a window whose launcher pane was swapped out is parked without capturing any pane", async () => {
  const d = stall({ swapped: true });
  await d.run();
  expect(d.calls).toEqual(["park gh-1", "comment gh-1 session working with no activity for 31 min; parked with needs-human, left running"]);
  expect(d.cmds.filter((c) => c.includes("capture-pane"))).toEqual([]);
});

test("stall: nothing while activity is recent, the session is not working, or the ticket is parked", async () => {
  const d = stall();
  utimesSync(d.tx, new Date(), new Date());
  await d.run();
  d.setState("idle");
  utimesSync(d.tx, d.old, d.old);
  await d.run();
  expect(d.calls).toEqual([]);
  const p = stall({ labels: ["Needs-Human"] });
  await p.run();
  const r = stall({ inReview: true, labels: ["needs-human"] });
  await r.run();
  expect([...p.calls, ...r.calls].filter((c) => /park|comment/.test(c))).toEqual([]);
  expect(existsSync(join(root, "acme/web/gh-1.stall"))).toBe(false);
});

test("stall: also checked while in review, and feedback stops in the same poll", async () => {
  const d = stall({ inReview: true });
  await d.run();
  expect(d.calls.filter((c) => /^(park|comment)/.test(c)).map((c) => c.slice(0, 33))).toEqual(["park gh-1", "comment gh-1 session working with"]);
  expect(d.cmds.filter((c) => c.startsWith("gh pr view"))).toEqual([]);
});

test("liveStates raw keeps a stale working that the resolved state reports as unknown", async () => {
  const live = liveStates(root, async () => () => ({ state: "working", since: 0, waitingFor: null }));
  const r = { agent: "codex" } as Repo;
  expect(await live(r, root, "a", 20 * 60_000)).toBe("unknown");
  expect(await live(r, root, "a", 20 * 60_000, true)).toBe("working");
});
