# Factory

tender is the ticket runner. It does only what a skill cannot do from inside a session. How to plan, build, review, fix and verify lives in skills and instruction files that you own. A ticket's type picks one instruction file, one session runs it, and tender checks the result from outside.

## What only the runner does

A skill runs inside the session it would have to start, contain, pace, grade or wake. These six live in tender:

| | what tender does | details |
|---|---|---|
| Start unattended | polls each source every `pollIntervalMs`, claims ready tickets (`agent` + `host:<host>` labels), most urgent first | [How it works](lifecycle.md) |
| Isolate | one `git clone --shared` per ticket, a nono sandbox (unless `sandbox: none`) with GitHub credentials behind nono's proxy, a systemd scope that `tender` can kill whole | [Clones, sandbox and cleanup](sandbox.md) |
| Run many at once | `maxConcurrent` and `maxInReview`, host-wide and per repo; one verify run per workspace; port blocks allocated under the pass lock | [Config reference](config.md#top-level) |
| Enforce from outside | runs `.tender/verify.yaml` from `origin/<base>`, sandboxed and offline, on the PR's head | [Verify contract](auto-merge.md#verify-contract) |
| Gate merges | auto-merge modes, trust per path, critical paths, escape hatches, Ready to merge; per repo, never per type | [Auto-merge](auto-merge.md) |
| Deliver | posts questions to the ticket and delivers replies, PR comments, failed checks, conflicts and failed verify runs back to the session | [PR feedback](lifecycle.md#pr-feedback), [Questions](lifecycle.md#questions) |

The contract is read from the base branch, never from the PR, because ticket and PR text can steer the agent. The narrower guarantee: it fixes which commands run, but the scripts it calls are head code. Keep scripts that must not change under `.tender/checks/`, a critical path. A failed run goes back to the session as a feedback round; after `maxRounds` (default 2) failed runs, or at once if the window is gone, the ticket gets `needs-human`.

## Verification ladder

Pick the lowest rung that proves the change. Each rung adds a moving part, and tender adds that part only when a type or a check declares it.

1. **In-process fakes.** A plain check: `run` only, no `needs`. It runs offline, with no logins, so external APIs are faked in the process (request interception, recorded fixtures). Dependencies must already be in the clone or install offline from the read-only caches. A library that starts containers from inside the test (Testcontainers) needs the Docker API, which the sandbox never gets. Move that service to rung 3.
2. **App on assigned ports.** `needs: { ports: n }` (1 to 10) gives `TENDER_PORT_0`… from 20000 to 29999, granted in nono and apart from the session's own ports. The grants need Landlock ABI 4 (Linux 6.7). nono grants a port, not an address, so the same port is reachable on any host. See [Ports and services](sandbox.md#ports-and-services).
3. **Compose by tender.** `needs: { ports: n, compose: <file> }`. tender runs `docker compose … up -d --wait` from the base commit, outside the sandbox, with a clean env. Every published port must be `127.0.0.1` and an assigned port. It runs `down -v` when the run or the ticket ends. The Docker daemon is host root, so the agent never runs it, and each declared compose file is a critical path. tender needs Docker only when a repo declares `compose`.
4. **Preview, only if it exists.** tender never builds, waits on or reaches a deployed preview. Verify checks are offline, and a sandboxed session reaches only the hosts its nono profile allows. If the repo already deploys PR previews, they are for you to review the PR.

```yaml
# .tender/verify.yaml
checks:
  - name: test                        # rung 1
    run: bun test
  - name: smoke                       # rung 2
    run: bash .tender/checks/smoke.sh
    timeout: 300
    needs: { ports: 1 }
  - name: e2e                         # rung 3
    run: bash .tender/checks/e2e.sh
    needs: { ports: 2, compose: .tender/compose.yaml }
    proof: [".tender/proof/**/*.png", ".tender/proof/**/*.webm"]
```

```yaml
# .tender/compose.yaml
services:
  db:
    image: postgres:17
    ports: ["127.0.0.1:${TENDER_PORT_1}:5432"]
```

A session gets the same rungs through its type, `needs` in a type in `.tender/config.yaml`, so it can start the app while it works.

**Proof.** Screenshots and video that a passing check leaves behind are attached to one `tender: verified <sha>: <checks>` PR comment for you to judge. tender enforces the deterministic checks, not the proof. On a public repo anyone can open the attachments. Limits are in [Verify contract](auto-merge.md#verify-contract).

Prove a contract on the base before any PR depends on it:

```
bun <tender>/tender.ts check . --config <tender>/tender.json   # in the repo: validates .tender/, types against your profile
bun tender.ts verify owner/repo                                # in tender's clone: runs the contract on the base commit under the real verifier
```

## What is left to skills

- **The flow.** A [profile](config.md#profile) is `types.yaml` plus `instructions/*.md`. The first type whose `match.labels` the ticket has wins, and `default` comes last. tender ships [`profile/`](../profile) (`bug`, `docs`, `default`). Point `"profile": "~/Work/agents/tender"` in `tender.json` at your own. The instruction file names the skills the session loads (for example `orchestration`). tender has no step list and no per-step sessions.
- **Repo setup.** `tender-setup` writes `.tender/config.yaml`, type overrides and `verify.yaml` from CI config and manifests, running each check once first. `tender-maintain` proposes repairs, including for checks that fail on the base under `tender verify`. Both live in this repo, tied to its schema; see [Setup](setup.md).
- **Interactive verification.** [`create-verification`](https://github.com/nejcm/agents/tree/main/skills/create-verification) writes a repo's `.agents/skills/verify-<app>/` (Launch, Doctor, Drive, Evidence, Cleanup, feature map, proven once) and its `verify.yaml` checks. [`maintain-verification`](https://github.com/nejcm/agents/tree/main/skills/maintain-verification) re-drives every feature and ends clean, changed (one PR) or blocked. Both are adapted from pstack (MIT) and live with your other skills, reaching sessions through the template links.
- **Out of tender.** Measurement, cost and budgets belong where all your agents run. Also out: a separate verifier session (added only if proof proves unreliable), multi-tenant use and Symphony.

## Research

Each link backs a claim above; all resolved on 2026-11-23.

- [Stripe, Minions part 2](https://stripe.dev/blog/minions-stripes-one-shot-end-to-end-coding-agents-part-2): deterministic nodes "don't invoke an LLM at all", and after the second push and CI run the branch goes to a human. Hence `maxRounds: 2`.
- [Spotify, feedback loops](https://engineering.atspotify.com/2025/12/feedback-loops-background-coding-agents-part-3): verifiers activate on the component's contents, and "the agent doesn't know what the verification does"; the agent runs in a container with limited permissions.
- [OpenAI, harness engineering](https://openai.com/index/harness-engineering/): rules are enforced "mechanically via custom linters … and structural tests"; the app is "bootable per git worktree" so the agent drives one instance per change, with video as evidence.
- [CSA, Claude Code GitHub Action prompt injection](https://labs.cloudsecurityalliance.org/research/csa-research-note-claude-code-github-action-prompt-injection/): issue bodies and PR titles steered an agent in CI. Hence the contract comes from the base, and the merge file can only hold a merge back.
- [Evaluating AGENTS.md](https://arxiv.org/abs/2602.11988) (ETH): providing context files "does not generally improve task success rates" and add over 20% inference cost. [Vercel](https://vercel.com/blog/agents-md-outperforms-skills-in-our-agent-evals): a skill was never invoked in 56% of eval cases. Hence short instruction files that name their skills, and checks instead of prose for what must hold.
- pstack [`create-verification-skill`](https://github.com/cursor/plugins/blob/main/pstack/skills/create-verification-skill/SKILL.md), [verify and ship](https://github.com/cursor/plugins/blob/main/pstack/docs/guide/06-verify-and-ship.md), [license](https://github.com/cursor/plugins/blob/main/pstack/LICENSE): interview the repo, prove the skill once, and ask for an artifact as proof ("An artifact beats a plausible explanation").
- [Conductor `CONDUCTOR_PORT`](https://www.conductor.build/docs/reference/environment-variables): a range of 10 ports per workspace, the precedent for `needs.ports` (at most 10).
- [Compose project name](https://docs.docker.com/compose/how-tos/project-name/): "a project name to isolate environments", one project per ticket.
- [Docker daemon attack surface](https://docs.docker.com/engine/security/): the daemon needs root and "only trusted users should be allowed to control" it. Hence Compose outside the sandbox.
- [MSW `listen()`](https://v1.mswjs.io/docs/api/setup-server/listen): interception with "no servers" (rung 1). [Testcontainers](https://testcontainers.com/getting-started/) needs a Docker-API runtime, so it does not run inside the sandbox.
- [Render PR previews](https://render.com/docs/pull-request-previews): an example of rung 4, which the host provides, not tender.
- [GitHub attachments](https://docs.github.com/en/get-started/writing-on-github/working-with-advanced-formatting/attaching-files): 10 MB images, 10 MB video on free plans, public-repo uploads readable without authentication. [Playwright videos](https://playwright.dev/docs/videos): the `video` option, one way a check leaves proof.
- [Devin blueprints](https://docs.devin.ai/onboard-devin/environment/blueprints.md) (`.devin/blueprint.yaml`) and [OpenHands repository customization](https://docs.openhands.dev/openhands/usage/customization/repository.md) (`.openhands/setup.sh`, stop hooks that run repo checks): environment and checks committed in the repo, like `.tender/`.
- [Symphony spec](https://raw.githubusercontent.com/openai/symphony/main/SPEC.md): a similar runner that polls a tracker, runs an isolated workspace per issue and keeps its policy in `WORKFLOW.md`; skipped for now.
