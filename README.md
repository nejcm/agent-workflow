# tender — agent workflow

Move a GitHub issue or Linear ticket to **ready**, and `tender` starts a Claude Code or Codex session for it: in its own git clone, inside the [nono](https://github.com/nolabs-ai/nono) sandbox, in a tmux window you can attach to. The agent implements the ticket, runs the tests, pushes `agent/<ID>` and opens a PR; `tender` then moves the ticket to **In Review**.

- **Watch and steer locally.** `tmux attach -t tender`, or open its clone in your editor. Codex sessions are interactive, so they also land in the ChatGPT/Codex app history. Claude sessions run without Remote Control: they hold an inference-only token (nono's phantom, or the setup-token without a sandbox), which cannot open Remote Control sessions.
- **Runs where you are.** Directly on your machine (sandboxed by nono), or on a VM (`sandbox: "none"`, the VM is the boundary). Same code, same config.
- **No moving parts to babysit.** A small Bun + TypeScript program, no database: state is the tracker, the tmux windows and the session clones. Polls instead of webhooks, so nothing listens on a port.
- **Your setup, read-only.** Agents use your `CLAUDE.md`, `AGENTS.md` and skills, but run from their own config dirs (a fresh `<ID>.claude` per Claude ticket and `<ID>.codex` per ticket) and cannot modify yours.

## How it works

Every poll (default 60 s), `tender` looks for ready tickets (the `agent` label plus `host:<host>`) in the repos you allowlist, and for each one:

1. clones the repo and makes a session clone on branch `agent/<ID>`;
2. starts the agent in a tmux window, sandboxed by nono, with a prompt built from the ticket and the repo's `.tender/` config;
3. mirrors the agent's phases, questions and findings to the tracker;
4. moves the ticket to In Review when the PR exists, feeds review comments, failed checks and conflicts back to the live session, and optionally auto-merges.

## Docs

- [Setup](docs/setup.md): requirements, tracker, config, first run, running as a service, first-run checklist
- [Agent logins](docs/auth.md): Claude and Codex authentication
- [How it works](docs/lifecycle.md): the full poll lifecycle, repo routing, phases, findings, questions, PR feedback, Ready to merge
- [Auto-merge](docs/auto-merge.md): modes, trust per path, critical paths, escape hatches
- [Hand-off](docs/hand-off.md): `open` / `resume` to take a session over
- [Watching sessions](docs/watching.md): `status`, `watch`, `tail`, live state
- [Config reference](docs/config.md): `tender.json` and `.tender/config.yaml`
- [Clones, sandbox and cleanup](docs/sandbox.md): isolation details
- [Upgrading](docs/upgrading.md), [Code layout](docs/code-layout.md)
- Design notes: [agent questions](docs/agent-questions.md), [known issues](docs/issues.md), [improvements](docs/improvements.md)

## Quick start

```bash
scripts/setup.sh owner/repo   # config dirs, nono, labels, .env and tender.json from the examples, login check
scripts/run.sh                # preflight (dry run), then poll in the foreground
```

Details in [docs/setup.md](docs/setup.md).

## Status

Early and used by one person. Linux only; macOS is untested. Auto-merge and the sandbox are guard rails, not guarantees: read [Auto-merge](docs/auto-merge.md) before enabling it, and protect `baseBranch` on GitHub. Bugs and ideas: open an issue.

## License

[MIT](LICENSE)
