# Factory

tender is the ticket runner. It does only what a skill cannot do from inside a session. How to plan, build, review, fix and verify lives in skills and instruction files that you own. A ticket's type picks one instruction file, one session runs it, and tender checks the result from outside through your CI.

## What only the runner does

A skill runs inside the session it would have to start, contain, pace, gate or wake. These five live in tender:

| | what tender does | details |
|---|---|---|
| Start unattended | polls each source every `pollIntervalMs`, claims ready tickets (`agent` + `host:<host>` labels), most urgent first | [How it works](lifecycle.md) |
| Isolate | one `git clone --shared` per ticket, a nono sandbox (unless `sandbox: none`) with GitHub credentials behind nono's proxy, a systemd scope that `tender` can kill whole | [Clones, sandbox and cleanup](sandbox.md) |
| Run many at once | `maxConcurrent` and `maxInReview`, host-wide and per repo; port blocks allocated under the pass lock | [Config reference](config.md#top-level) |
| Gate merges | every CI status check must pass, and a medium or large change needs at least one; auto-merge modes, trust per path, critical paths, escape hatches, Ready to merge; per repo, never per type | [Auto-merge](auto-merge.md) |
| Deliver | posts questions to the ticket and delivers replies, other ticket comments before the PR, PR comments, failed checks and conflicts back to the session | [PR feedback](lifecycle.md#pr-feedback), [Questions](lifecycle.md#questions), [Operator messages](lifecycle.md#operator-messages) |

tender runs no tests of its own. The session verifies its work as its instruction file and skills say; CI is the check from outside, and `.github/**` is a critical path, so a PR that edits its workflows never merges unattended. `.tender/` is read from the base branch, never from the PR, because ticket and PR text can steer the agent.

## Session environment

Pick the lowest rung the change needs. Each rung adds a moving part, and tender adds that part only when a type declares it in `needs`.

1. **In-process fakes.** No `needs`. External APIs are faked in the process (request interception, recorded fixtures). A library that starts containers from inside the test (Testcontainers) needs the Docker API, which the sandbox never gets. Move that service to rung 3.
2. **App on assigned ports.** `needs: { ports: n }` (1 to 10) gives `TENDER_PORT_0`… from 20000 to 29999, granted in nono. The grants need Landlock ABI 4 (Linux 6.7). nono grants a port, not an address, so the same port is reachable on any host. See [Ports and services](sandbox.md#ports-and-services).
3. **Compose by tender.** `needs: { ports: n, compose: <file> }`. tender runs `docker compose … up -d --wait` from the base commit, outside the sandbox, with a clean env, before the agent starts. Every published port must be `127.0.0.1` and an assigned port. It runs `down -v` when the ticket ends. The Docker daemon is host root, so the agent never runs it, and each declared compose file is a critical path. tender needs Docker only when a repo declares `compose`.
4. **Preview, only if it exists.** tender never builds, waits on or reaches a deployed preview. A sandboxed session reaches only the hosts its nono profile allows. If the repo already deploys PR previews, they are for you to review the PR.

```yaml
# .tender/config.yaml
types:
  - name: e2e
    match: { labels: ["type:e2e"] }
    instructions: instructions/default.md
    needs: { ports: 2, compose: .tender/compose.yaml }
```

```yaml
# .tender/compose.yaml
services:
  db:
    image: postgres:17
    environment: { POSTGRES_PASSWORD: tender }
    ports: ["127.0.0.1:${TENDER_PORT_1}:5432"]
```

## What is left to skills

- **The flow.** A [profile](config.md#profile) is `types.yaml` plus `instructions/*.md`. The first type whose `match.labels` the ticket has wins, and `default` comes last. tender ships [`profile/`](../profile) (`bug`, `docs`, `default`). Point `"profile"` in `tender.json` at your own. The instruction file names the skills the session loads (for example `orchestration`). tender has no step list and no per-step sessions.
- **Repo setup.** `tender-setup` writes `.tender/config.yaml` and type overrides from CI config and manifests. `tender-maintain` proposes repairs for what the contract check reports. Both live in this repo, tied to its schema; see [Setup](setup.md).
- **Verification.** How a session proves its change (tests, driving the app, screenshots or video) is the repo's verification skill, which the instruction files tell the session to use. `create-verification` can write one (`.agents/skills/verify-<app>/`), and `maintain-verification` keeps it current. Both are adapted from pstack (MIT) and live with your other skills, reaching sessions through the template links.
- **Out of tender.** Measurement, cost and budgets belong where all your agents run. Also out: a separate verifier session, multi-tenant use and Symphony.

## Research

Each link backs a claim above; all resolved on 2026-11-23.

- [Spotify, feedback loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3): the agent runs in a container with limited permissions.
- [OpenAI, harness engineering](https://openai.com/index/harness-engineering/): the app is "bootable per git worktree" so the agent drives one instance per change.
- [CSA, Claude Code GitHub Action prompt injection](https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-github-action-prompt-injection/): issue bodies and PR titles steered an agent in CI. Hence `.tender/` comes from the base, and the merge file can only hold a merge back.
- [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) (ETH): providing context files "does not generally improve task success rates" and add over 20% inference cost. [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals): a skill was never invoked in 56% of eval cases. Hence short instruction files that name their skills.
- pstack [`create-verification-skill`](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md), [license](https://github.com/cursor/plugins/blob/main/pstack/LICENSE): the source `create-verification` is adapted from.
- [Conductor `CONDUCTOR_PORT`](https://www.conductor.build/docs/reference/environment-variables): a range of 10 ports per workspace, the precedent for `needs.ports` (at most 10).
- [Compose project name](https://docs.docker.com/compose/how-tos/project-name/): "a project name to isolate environments", one project per ticket.
- [Docker daemon attack surface](https://docs.docker.com/engine/security/): the daemon needs root and "only trusted users should be allowed to control" it. Hence Compose outside the sandbox.
- [MSW `listen()`](https://v1.mswjs.io/docs/api/setup-server/listen): interception with "no servers" (rung 1). [Testcontainers](https://testcontainers.com/getting-started/) needs a Docker-API runtime, so it does not run inside the sandbox.
- [Render PR previews](https://render.com/docs/pull-request-previews): an example of rung 4, which the host provides, not tender.
- [Devin blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints.md) (`.devin/blueprint.yaml`) and [OpenHands repository customization](https://docs.openhands.dev/openhands/usage/customization/repository.md) (`.openhands/setup.sh`): environment committed in the repo, like `.tender/`.
- [Symphony spec](https://raw.githubusercontent.com/openai/symphony/main/SPEC.md): a similar runner that polls a tracker, runs an isolated workspace per issue and keeps its policy in `WORKFLOW.md`; skipped for now.
