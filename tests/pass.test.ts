import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { validRepo } from "../src/config";
import { canonCache, github } from "../src/github";
import { launcher, render } from "../src/launcher";
import { pass } from "../src/pass";
import type { Io, Ticket, Tracker } from "../src/types";
import { config, fakeIo, fakeTracker, noPr, root, src, ticket, two, useTempRoot, web, windowsOut, worktree } from "./helpers";

useTempRoot();

test("render is single-pass so ticket text cannot expand placeholders", () => {
  expect(render("{{title}} / {{body}} / {{nope}}", { title: "{{body}}", body: "b" })).toBe("{{body}} / b / {{nope}}");
});

test("launcher: claude under nono, ticket text never in shell", () => {
  const c = config();
  const s = launcher(web(c), { ...ticket(1), title: "x'; rm -rf / $(id) `id`" }, "/ws/web/gh-1", "/ws/web/gh-1.prompt.md", "/aw");
  expect(s).toContain("export CLAUDE_CONFIG_DIR=\"$HOME/.claude-aw\" CODEX_HOME=\"$HOME/.codex-aw\" CLAUDE_CODE_TMPDIR=\"$HOME/.claude-aw/tmp\"");
  expect(s).toContain("--no-rollback-prompt");
  expect(s).toContain(`exec nono run --no-rollback-prompt --profile '/aw/nono/aw-claude.json' --allow '/ws/web/gh-1' --allow '${root}/src-web/.git' -- claude --remote-control`);
  expect(s).toContain(`--permission-mode bypassPermissions "$(cat '/ws/web/gh-1.prompt.md')"`);
  expect(s).not.toMatch(/\$\(id\)|`id`|'; rm/);
});

test("launcher: codex without sandbox keeps the daemon", () => {
  const c = config({ repos: [{ name: "acme/web", agent: "codex", sandbox: "none" }] });
  const s = launcher(web(c), ticket(2), "/ws/web/gh-2", "/ws/web/gh-2.prompt.md", "/aw");
  expect(s).toContain('export CODEX_HOME="$HOME/.codex-aw"');
  expect(s).toContain(`exec codex --sandbox danger-full-access --ask-for-approval never -C '/ws/web/gh-2' "$(cat '/ws/web/gh-2.prompt.md')"`);
  expect(launcher(web(config({ repos: [{ name: "acme/web", agent: "codex" }] })), ticket(2), "/w", "/p", "/aw")).toContain("-- codex --no-daemon ");
});

test("launcher scripts are byte-for-byte stable for each agent, with and without nono", () => {
  const head = String.raw`#!/usr/bin/env bash
cd '/ws/it'\''s' || exit 1
unset LINEAR_API_KEY
`;
  const claudeEnv = String.raw`export CLAUDE_CONFIG_DIR="$HOME/.claude-aw" CODEX_HOME="$HOME/.codex-aw" CLAUDE_CODE_TMPDIR="$HOME/.claude-aw/tmp"; mkdir -p "$CLAUDE_CODE_TMPDIR"
`;
  const nono = (a: string) => String.raw`nono run --no-rollback-prompt --profile '/aw/nono/aw-${a}.json' --allow '/ws/it'\''s' --allow '/src/web/.git' -- `;
  const claude = String.raw`claude --remote-control 'gh-3: Its (x)' --permission-mode bypassPermissions "$(cat '/ws/p.md')"
`;
  const codex = (d: string) => String.raw`codex ${d}--sandbox danger-full-access --ask-for-approval never -C '/ws/it'\''s' "$(cat '/ws/p.md')"
`;
  const s = (agent: string, sandbox: string) => launcher(web(config({ repos: [{ name: "acme/web", path: "/src/web", agent, sandbox }] })), { ...ticket(3), title: "It's $(x) ✓" }, "/ws/it's", "/ws/p.md", "/aw");
  expect(s("claude", "nono")).toBe(`${head}${claudeEnv}exec ${nono("claude")}${claude}`);
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
  expect(prompt).toContain("git push -u origin agent/gh-1");
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

test("done: kills window, removes worktree and files; keeps files when remove fails", async () => {
  const c = config();
  for (const id of ["gh-1", "gh-2", "gh-3"]) {
    mkdirSync(join(root, "acme/web", id), { recursive: true });
    for (const ext of [".prompt.md", ".sh", ".ended", ".pr"]) writeFileSync(join(root, "acme/web", id + ext), "");
    writeFileSync(join(root, "acme/web", `${id}.source`), "web\n");
  }
  const { tr } = fakeTracker({ done: ["gh-1", "gh-2"] });
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-1"]);
    if (a[3] === "worktree" && a[5]?.endsWith("gh-2")) return { code: 1 };
  });
  await pass(c, io, () => tr, "/aw");
  expect(cmds).toContain("tmux kill-window -t @0");
  expect(cmds.filter((x) => x.includes("kill-window"))).toHaveLength(1);
  expect(existsSync(join(root, "acme/web/gh-1.sh"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.source"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-1.pr"))).toBe(false);
  expect(existsSync(join(root, "acme/web/gh-2.sh"))).toBe(true);
  expect(existsSync(join(root, "acme/web/gh-3.sh"))).toBe(true);
  expect(logs.some((l) => l.includes("[web] cleanup acme/web/gh-2 failed"))).toBe(true);
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
  expect(logs.some((l) => l.includes(`dry: git -C ${root}/src-web worktree remove ${root}/acme/web/gh-5`))).toBe(true);
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
  const { io, cmds, logs } = fakeIo((a) => {
    if (a[1] === "list-windows") return windowsOut(["acme/web/gh-5", "acme/api/gh-5", "acme/api/ENG-7"]);
    if (a[4] === "remove") rmSync(a[5]!, { recursive: true });
    return noPr(a);
  });
  await pass(c, io, (s) => (s.name === "gh" ? gh.tr : lin.tr), "/aw");
  expect(cmds.filter((x) => /worktree remove|kill-window/.test(x))).toEqual(["tmux kill-window -t @1", `git -C ${root}/src-api worktree remove ${root}/acme/api/gh-5`]);
  expect(existsSync(join(root, "acme/web/gh-5.source"))).toBe(true);
  expect(logs.some((l) => l.includes(`acme/web/gh-6: source "gone" in gh-6.source is not configured; left alone`))).toBe(true);
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/gh-5 --state all --json url,state");
  expect(cmds).toContain("gh pr list --repo acme/api --head agent/ENG-7 --state all --json url,state");
  expect(cmds.some((x) => x.includes("--repo acme/web --head agent/ENG-7"))).toBe(false);
  expect(lin.calls).toEqual([]);
  expect(gh.calls).toEqual(["comment gh-5 session ended without a PR"]);
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
