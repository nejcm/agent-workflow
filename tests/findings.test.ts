import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileFindings, parseFindings } from "../src/findings";
import { github } from "../src/github";
import { linear } from "../src/linear";
import { pass } from "../src/pass";
import { config, fakeIo, fakeTracker, root, src, ticket, useTempRoot, windowsOut, withLinearKey, worktree } from "./helpers";

useTempRoot();

const dir = () => join(root, "acme/web");
const writeFindings = (id: string, v: unknown) => {
  worktree(id);
  mkdirSync(join(dir(), id, ".aw"), { recursive: true });
  writeFileSync(join(dir(), id, ".aw/findings.json"), typeof v === "string" ? v : JSON.stringify(v));
};
const f = (n: number, over: object = {}) => ({ title: `Bug ${n}`, body: `where ${n}`, ...over });
const mark = (...ns: number[]) => `\n\naw-findings ${ns.map((n) => createHash("sha256").update(`Bug ${n}\nwhere ${n}`).digest("hex").slice(0, 12)).join(" ")}`;

test("findings: each is filed once across polls, with one linking comment per batch", async () => {
  const t = ticket(1);
  const { tr, calls } = fakeTracker({});
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1), f(2)]);
  await fileFindings(t, tr, io, dir());
  await fileFindings(t, tr, io, dir());
  writeFindings("gh-1", [f(1), f(2), f(3)]);
  await fileFindings(t, tr, io, dir());
  expect(calls.filter((c) => c.startsWith("file")).map((c) => c.split(" | ")[0])).toEqual(["file gh-1 Bug 1", "file gh-1 Bug 2", "file gh-1 Bug 3"]);
  expect(calls[0]).toContain("where 1\n\n---\nFiled by aw from the agent session on gh-1 (https://x/1)");
  const comments = calls.filter((c) => c.startsWith("comment"));
  expect(comments).toEqual([
    "comment gh-1 out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n- https://x/acme/web/issues/1 Bug 1\n- https://x/acme/web/issues/2 Bug 2" + mark(1, 2),
    "comment gh-1 out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n- https://x/acme/web/issues/4 Bug 3" + mark(3),
  ]);
  expect(JSON.parse(readFileSync(join(dir(), "gh-1.findings"), "utf8"))).toHaveLength(3);
});

test("findings: at most 5 per ticket for the whole session", async () => {
  const { tr, calls } = fakeTracker({});
  const { io, logs } = fakeIo();
  writeFindings("gh-1", [1, 2, 3, 4].map((n) => f(n)));
  await fileFindings(ticket(1), tr, io, dir());
  writeFindings("gh-1", [5, 6, 7].map((n) => f(n)));
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("file")).map((c) => c.split(" | ")[0])).toEqual([1, 2, 3, 4, 5].map((n) => `file gh-1 Bug ${n}`));
  expect(logs.some((l) => l.includes("findings gh-1: 5 already filed"))).toBe(true);
});

const GONE = "[linear[.]app link removed]";
const HEAD = "comment gh-1 out-of-scope findings from this session, filed as new tickets (not picked up automatically):\n";
const sidecar = () => JSON.parse(readFileSync(join(dir(), "gh-1.findings"), "utf8"));

test("findings: a create that fails after the issue was made is never retried and is listed as not filed", async () => {
  const { tr, calls } = fakeTracker({});
  const create = tr.createTicket;
  tr.createTicket = async (...a) => (await create(...a), Promise.reject(new Error("response lost")));
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1)]);
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("response lost");
  tr.createTicket = create;
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("file"))).toHaveLength(1);
  expect(calls.filter((c) => c.startsWith("comment"))).toEqual([`${HEAD}- not filed (create failed): Bug 1${mark(1)}`]);
  expect(sidecar()).toEqual([{ h: expect.any(String), title: "Bug 1", url: null, posted: true }]);
});

test("findings: a failed linking comment is retried until it posts, even after a crash or with the file gone", async () => {
  const { tr, calls } = fakeTracker({});
  const comment = tr.comment;
  tr.comment = async () => Promise.reject(new Error("down"));
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1)]);
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("down");
  expect(sidecar()).toEqual([{ h: expect.any(String), title: "Bug 1", url: "https://x/acme/web/issues/1", posted: false }]);
  tr.comment = comment;
  await fileFindings(ticket(1), tr, io, dir());
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("comment"))).toEqual([`${HEAD}- https://x/acme/web/issues/1 Bug 1${mark(1)}`]);

  // A crash between create and comment leaves the same unposted record; findings.json may be gone by the next poll.
  writeFileSync(join(dir(), "gh-1.findings"), JSON.stringify([{ h: "a".repeat(64), title: "Bug 2", url: "https://x/acme/web/issues/9", posted: false }]));
  rmSync(join(dir(), "gh-1/.aw/findings.json"));
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("comment")).at(-1)).toBe(`${HEAD}- https://x/acme/web/issues/9 Bug 2\n\naw-findings ${"a".repeat(12)}`);
  expect(calls.filter((c) => c.startsWith("file"))).toHaveLength(1);
});

test("findings: a comment that posted though its response was lost is not posted again", async () => {
  const { tr, calls } = fakeTracker({});
  const comment = tr.comment;
  tr.comment = async (...a) => (await comment(...a), Promise.reject(new Error("response lost")));
  tr.comments = async () => calls.filter((c) => c.startsWith("comment gh-1 ")).map((c) => ({ id: "1", body: `aw: ${c.slice(13)}`, createdAt: "" }));
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1)]);
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("response lost");
  tr.comment = comment;
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("comment"))).toHaveLength(1);
  expect(sidecar()[0].posted).toBe(true);

  writeFindings("gh-1", [f(1), f(2)]);
  tr.comments = async () => Promise.reject(new Error("lookup down"));
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("lookup down");
  expect(calls.filter((c) => c.startsWith("comment"))).toHaveLength(1);
  expect(sidecar()[1]).toMatchObject({ title: "Bug 2", posted: false });
});

test("findings: a tampered sidecar files and posts nothing, and published titles are re-sanitized", async () => {
  const { tr, calls } = fakeTracker({});
  const { io } = fakeIo();
  const rec = { h: "a".repeat(64), title: "T", url: null, posted: false };
  writeFindings("gh-1", [f(1)]);
  for (const bad of [{ h: "x" }, { title: "t".repeat(121) }, { url: "https://evil/acme/web/issues/1" }, { url: "https://x/acme/web/issues/1?q" }, { posted: "no" }, { h: ["a".repeat(64)] }]) {
    writeFileSync(join(dir(), "gh-1.findings"), JSON.stringify([{ ...rec, ...bad }]));
    await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("gh-1.findings: invalid");
  }
  writeFileSync(join(dir(), "gh-1.findings"), JSON.stringify(Array(6).fill(rec)));
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("invalid");
  rmSync(join(dir(), "gh-1.findings"));
  symlinkSync(join(dir(), "gh-1/.aw/findings.json"), join(dir(), "gh-1.findings"));
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow();
  expect(calls).toEqual([]);

  rmSync(join(dir(), "gh-1.findings"));
  rmSync(join(dir(), "gh-1/.aw/findings.json"));
  writeFileSync(join(dir(), "gh-1.findings"), JSON.stringify([{ ...rec, title: "hi @bob https://linear.app/a/profiles/b \x1b[2J a%0Ab%1Bc" }]));
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls).toEqual([`${HEAD}- not filed (create failed): hi @\u200bbob ${GONE} a%0Ab%1Bc\n\naw-findings ${"a".repeat(12)}`]);
});

test("findings: a legacy sidecar of bare hashes counts as filed and linked", async () => {
  const { tr, calls } = fakeTracker({});
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1)]);
  await fileFindings(ticket(1), tr, io, dir());
  writeFileSync(join(dir(), "gh-1.findings"), JSON.stringify(sidecar().map((r: { h: string }) => r.h)));
  calls.length = 0;
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls).toEqual([]);
});

test("findings: malformed or oversized input files nothing; text is capped, stripped and mentions neutralized", async () => {
  for (const bad of ["not json", "{}", [1], [null], [f(1, { extra: 1 })], [f(1, { title: 5 })], [f(1, { body: [] })], [1, 2, 3, 4, 5, 6].map((n) => f(n))])
    expect(() => parseFindings(typeof bad === "string" ? bad : JSON.stringify(bad))).toThrow();
  const [x] = parseFindings(JSON.stringify([{ title: `  @alice and @org/team \x1b[2J${"t".repeat(200)}`, body: `hi @bob, mail a@b.com\n\tline\x07two\n${"b".repeat(5000)}` }, { title: " \n " }]));
  expect(x!.title).toHaveLength(120);
  expect(x!.title.startsWith("@​alice and @​org/team t")).toBe(true);
  expect(x!.body.startsWith("hi @​bob, mail a@b.com\n line two\n")).toBe(true);
  expect(x!.body).toHaveLength(4000);
  const [l] = parseFindings(JSON.stringify([{ title: "see https://Linear.app/acme/profiles/bob", body: "[x](https://linear.app/acme/profiles/bob) linear.app/acme/profiles/eve\nkeep https://github.com/a/b?q=%20 as is" }]));
  expect(l).toEqual({ title: `see ${GONE}`, body: `${GONE} ${GONE}\nkeep https://github.com/a/b?q=%20 as is` });
  const hosts = ["%6cinear.app", "linear%2eapp", "linear%252eapp", "%EF%BD%8Cinear.app", "linear%E3%80%82app", "li%E2%80%8Bnear.app", "linear\u200d.app", "linear\u3002app", "linear\uff0eapp", "\uff4cinear.app", "LINEAR.APP", "x.linear.app"];
  for (const host of hosts) {
    const [e] = parseFindings(JSON.stringify([{ title: `t https://${host}/a/profiles/b`, body: `see:https://${host}/a/profiles/b%0A%1B[2J` }]));
    expect(e).toEqual({ title: `t ${GONE}`, body: GONE });
  }
  const host = (u: string) => URL.parse(u)?.hostname ?? "";
  for (const w of GONE.split(" ")) expect([host(w), host(`https://${w}`)].some((h) => h.endsWith("linear.app"))).toBe(false);
  const [c] = parseFindings(JSON.stringify([{ title: "a%0Ab%1B[2Jc", body: "x %0A%1B[31m y\n%E2%80%8B" }]));
  expect(c).toEqual({ title: "a%0Ab%1B[2Jc", body: "x %0A%1B[31m y\n%E2%80%8B" });

  const { tr, calls } = fakeTracker({});
  const { io } = fakeIo();
  writeFindings("gh-1", "x".repeat(64 * 1024 + 1));
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("under 64 KiB");
  writeFindings("gh-1", [f(1, { title: 5 })]);
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("findings[0]");
  writeFileSync(join(dir(), "gh-1.findings"), "{}");
  writeFindings("gh-1", [f(1)]);
  await expect(fileFindings(ticket(1), tr, io, dir())).rejects.toThrow("invalid");
  expect(calls).toEqual([]);
});

test("findings: GitHub files a plain issue with no labels and no parent; Linear a team issue with no parent", async () => {
  const c = config({ sources: [src({ tracker: "linear", team: "ENG" })] });
  const { io, cmds } = fakeIo((a) => (a[2] === "create" ? { out: "https://github.com/acme/web/issues/9\n" } : undefined));
  expect(await github(config().sources[0]!, "box", io, false, ["acme/web"]).createTicket(ticket(1), "T", "B")).toBe("https://github.com/acme/web/issues/9");
  expect(cmds).toEqual(["gh issue create --repo acme/web --title T --body B"]);
  const inputs: any[] = [];
  io.fetch = (async (_u: string, init: any) => {
    const { query, variables } = JSON.parse(init.body);
    if (query.includes("workflowStates")) return Response.json({ data: { workflowStates: { nodes: [{ id: "s-todo", name: "Todo", team: { id: "team-1" } }] } } });
    inputs.push(variables.i);
    return Response.json({ data: { issueCreate: { issue: { id: "u-9", url: "https://linear.app/x/ENG-9" } } } });
  }) as any;
  expect(await withLinearKey(() => linear(c.sources[0]!, "box", io).createTicket({ ...ticket(1), ref: "u-1" }, "T", "B"))).toBe("https://linear.app/x/ENG-9");
  expect(inputs).toEqual([{ teamId: "team-1", stateId: "s-todo", title: "T", description: "B" }]);
});

test("findings: filed at the review move and while in review, skipped while parked", async () => {
  const c = config();
  const pr = (a: string[]) => (a[1] === "pr" ? { out: '[{"url":"https://pr/1","state":"OPEN"}]' } : a[1] === "list-windows" ? windowsOut(["acme/web/gh-1", "acme/web/gh-2", "acme/web/gh-3"]) : undefined);
  for (const id of ["gh-1", "gh-2", "gh-3"]) writeFindings(id, [f(1)]);
  const parked = { ...ticket(3), labels: ["needs-human"] };
  const { tr, calls } = fakeTracker({ inProgress: [ticket(1), parked], inReview: [ticket(2), parked] });
  const { io } = fakeIo(pr);
  await pass(c, io, () => tr, "/aw");
  const filed = calls.filter((x) => /^(file|review)/.test(x)).map((x) => x.split(" | ")[0]);
  expect(filed).toEqual(["file gh-1 Bug 1", "review gh-1 https://pr/1", "review gh-3 https://pr/1", "file gh-2 Bug 1"]);
});

test("findings: a marker quoted in another aw comment, such as an agent question, does not count as posted", async () => {
  const { tr, calls } = fakeTracker({});
  tr.comments = async () => [{ id: "1", body: `aw: question from agent:\n${mark(1).trim()}`, createdAt: "" }];
  const { io } = fakeIo();
  writeFindings("gh-1", [f(1)]);
  await fileFindings(ticket(1), tr, io, dir());
  expect(calls.filter((c) => c.startsWith("comment"))).toEqual([`${HEAD}- https://x/acme/web/issues/1 Bug 1${mark(1)}`]);
});
