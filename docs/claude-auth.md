# Claude auth for aw sessions: subscription login via nono's credential proxy

Research for replacing the `claude setup-token` step. Checked 2026-11-14 on this host: Claude Code 2.1.323, nono 0.81.0, Linux. No token values were printed or copied; only expiry/scope metadata was read. Revised after an independent review (see [Review dispositions](#review-dispositions)).

**Status:** Phase 0 gates B1–B6 passed on 2026-11-14 ([results](#phase-0-results)). Phase 2 is implemented on `feat/claude-auth-activate`; gates R1–R6 are still pending, so don't rely on it yet.

Evidence labels: **[live]** run on this host (commands below), **[code]** read from the Claude Code 2.1.323 or nono 0.81.0 binary (`strings`) or this repo, **[docs]** official docs, **[inferred]** not checked.

## Recommendation

**Build**, for `sandbox: "nono"` lanes (Claude and Codex):

1. **Source:** the operator's normal login in `~/.claude` (zero setup). aw seeds the per-ticket account keys from `~/.claude.json`, the global config that belongs to that login.
2. **Inject:** a nono route `anthropic_oauth` for `api.anthropic.com` (MITM, no base URL). The session holds only nono's phantom in `CLAUDE_CODE_OAUTH_TOKEN`.
   - The capture is **read-only**: aw's own `bun` JSON-parses the file. It runs from `/` under `env -i` with `--no-env-file`, and prints the root `claudeAiOauth.accessToken` only if `expiresAt` is a safe integer more than 30 s in the future.
   - It runs under `/bin/sh -p`, and waits (≤ 3 s) while Claude's refresh lock exists, then reads anyway.
   - `cache_ttl_secs: 0` is required, not tunable: a refresh revokes the old access token at once (gate B4). Never raise it.
   - It needs no new host dependency (aw already requires bun).
3. **Refresh:** a non-dry `aw run` refreshes the login itself.
   - It checks once at start, before the first pass, then on its own 60 s timer.
   - Inside Claude's 5-minute window it runs `claude -p /cost` hardened: the **real Claude executable** (resolved at start, not the mise wrapper), a clean env, and a host-owned cwd.
   - That makes no model turn, and Claude Code's own lock protects your interactive sessions.
4. `sandbox: "none"` keeps the setup-token.

Deciding facts:

- It works: a real `claude -p` turn in a fresh config dir with only the phantom succeeded; the same run with the capture returning an invalid token got `401 OAuth access token is invalid` [live].
- The real token never enters the sandbox; the session holds a 64-hex phantom that is useless outside the session's proxy [live].
- Refresh without a model turn: `claude -p /cost --safe-mode --setting-sources "" --strict-mcp-config --no-session-persistence` attempted the refresh and made 0 `/v1/messages` requests [live: bogus expired login, token endpoint blocked]. A real refresh inside the window also succeeded with 0 `/v1/messages` (gate B2) [live].
- Sharing `~/.claude` with your own sessions is what Claude Code is built for. Refresh holds `<config>/.oauth_refresh.lock`, re-reads under the lock, and returns `race_resolved` if another process already refreshed [code]. Gate B3: two runners and five live sessions on `~/.claude` gave one lock, one write and no `invalid_grant` [live].
- This does **not** fix Remote Control: env tokens are treated as inference-only [docs, code].
- Terms: gray, not clearly blocked. See [Terms](#terms).

## Review dispositions

| # | Finding | Verdict | Evidence / change |
|---|---|---|---|
| 1 | Capture runs nested on the host with the ticket's PATH and env | **accept** | The capture inherits the ticket's `CLAUDE_CONFIG_DIR`, with the session clone as cwd [live]. The capture is now read-only, uses absolute `/usr/bin/jq`, and validates its output. Refresh moved to aw's host process with a clean env. The earlier text called the legacy lock "only logged"; corrected below |
| 2 | Default to `~/.claude` and seed matching account metadata | **accept** (operator decision) | No evidence it is unsafe (above). `~/.claude.json` holds all 4 `ACCOUNT` keys; `~/.claude/.claude.json` holds only `userID` [live]. Seed from `~/.claude.json` |
| 3 | Codex lanes never export `CLAUDE_CONFIG_DIR` | **accept** | `src/agents.ts:133` exports only `CODEX_HOME`. `src/launcher.ts:50,224` grant and seed `<ID>.claude` for Claude lanes only [code] |
| 4 | A 60 s cache can serve a token that was just invalidated | **accept** | Use `cache_ttl_secs: 0`. Gate B4 then showed the old token dies within ≤ 0.5 s of a refresh, so 0 is permanent |
| 5 | Claude accepts an unknown refresh expiry | **accept** | `iO` keeps `refreshTokenExpiresAt` undefined if it was never stored [code]. Preflight must separate unknown (warn), near (< 3 days, warn) and past (fail) |
| 6 | Unconditional setup-token revocation breaks `sandbox: "none"` and rollback | **accept** | The `none` lanes have no proxy. Keep the token until no lane uses `none` and the rollback window is over |
| — | Refresh in aw's host loop, with a read-only capture | **accept**, with a change | Use its own timer, not `pass()`, because a pass can block up to `SLOW_SECS` (900 s) and `pollIntervalMs` can be larger than 5 minutes (`src/config.ts:30`). Cost: if aw is down, sessions 401 within ≤ 8 h unless your own Claude use refreshes the login |

Second review round:

| # | Finding | Verdict | Evidence / change |
|---|---|---|---|
| 7 | The mise wrapper can reintroduce `CLAUDE_CONFIG_DIR` | **accept** | On PATH, `claude` → `/usr/bin/mise` [live]. `/etc/mise/conf.d/omarchy-agent-accounts.toml` dispatches to `omarchy-agent-account-exec`, which exports the selected account's home as `CLAUDE_CONFIG_DIR` when it is unset, and rebuilds `PATH` [code]. Fix: resolve the real executable once at start (Phase 2) and run it directly |
| 8 | Phase 1 activates proxy auth before refresh exists | **accept** | The profile route would be live while `src/agents.ts:122`, `src/launcher.ts:206` and `seedClaude` still follow the old path. Fix: blocking evidence first, an inactive prep PR, then one activation PR for both directions; see [plan](#implementation-plan) |
| 9 | The refresh gate must require zero inference, and test overlapping requests | **accept** | Only failed refreshes were observed. TTL 0 does not stop a capture from reading token A just before a rotation; env mode never retries [code]. Both are now blocking gates |
| 10 | Unspecified lifecycle: dry-run, `once`, shutdown, child timeout | **accept** | `scripts/run.sh:9` runs `once --dry-run` on every start, and `aw.ts:117` promises dry runs change nothing. `spawnRun` has no env override (`aw.ts:24-27`), and the service uses `KillMode=process` (`systemd/aw.service:12`). Rules are in Phase 2 |
| Q | Is jq needed? | **no** | aw doesn't require jq; it is installed here only as an Omarchy dependency (`pacman -Qi jq`). Superseded by review 3: the capture now uses aw's bun, hardened |

Third review round:

| # | Finding | Verdict | Evidence / change |
|---|---|---|---|
| 11 | sed returned a nested MCP decoy token | **accept** | Reproducible by construction: the sed matched `"claudeAiOauth":{` anywhere in the file. Replaced with `JSON.parse` that takes only the root key. Both of the reviewer's decoys now exit 1 [live] |
| 12 | `9999999999999e-20` passed as a future `expiresAt` | **accept** | sed took the integer prefix. Now `Number.isSafeInteger(expiresAt)` must hold, and that input exits 1 [live] |
| — | Use aw's bun from a trusted cwd under `env -i` | **accept** | Plain `bun -e` started in a clone ran the clone's `bunfig.toml` preload and loaded its `.env` [live]. With `cd /`, `env -i HOME`, `--no-env-file` and a planted `BUN_OPTIONS=--preload …`, neither ran [live]. So `python3 -I` is not needed |

## Phase 0 results

Run 2026-11-14 on this host (Claude Code 2.1.323, nono 0.81.0, GNU bash 5.3 as `/bin/sh`). No token values were printed or copied; the token endpoint was never called by hand; one Haiku turn was spent.

| Gate | Verdict | Evidence |
|---|---|---|
| B1 | pass | `realpath(mise which claude)` is the ELF in `~/.local/share/mise/installs/claude/2.1.323/`. With a clean env it used `~/.claude` while an Omarchy pin selected another dir; the wrapper control picked the other dir |
| B2 | pass | Refresh at W+0.78 s: exit 0 in 2.0 s, `expiresAt` +8.0 h, `refreshTokenExpiresAt` −186 ms (did not grow), 0 `/v1/messages`, `auth status` fine afterwards. Attribution to the runner is inferred: Claude logs no success line |
| B3 | pass | Two hardened runners plus five live sessions: one `.oauth_refresh.lock`, one `.credentials.json` write, 0 `invalid_grant`, every session kept working |
| B4 | pass, plan changed | TTL 0: 300/300 requests 200 across the refresh. TTL 3600 (old token pinned): every request 401 from +0.5 s after the write. **The server revokes the old access token at rotation** |
| B5 | pass after a fix | Capture and refresh executed or read none of the planted items. But `BASH_FUNC_cd%%` and `SHELLOPTS=xtrace`+`PS4=$(…)` in the inherited env ran code in the capture's `/bin/sh -c`; `/bin/sh -p -c` blocks both |
| B6 | pass | `/etc/claude-code/` is absent; the debug log confirms no managed settings |

Findings folded into Phase 2:

1. **Old token revoked at refresh** (B4). `cache_ttl_secs: 0` is mandatory. There is also a window of up to ~0.6 s in which the server has rotated the token but Claude has not yet written the file; inotify showed Claude holds `<config>/.oauth_refresh.lock` across the network call and the write (lock 53.250 → 53.885, write 53.881). The capture now waits while that lock exists, polling every 50 ms for at most 3 s, then reads anyway. That narrows the window for aw's refreshes and for your own; a capture that passed the lock check just before a rotation still hands out a token that dies in flight.
2. **Capture shell imports bash env code** (B5). The capture now runs `/bin/sh -p -c`: privileged mode ignores imported functions, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, `ENV` and `BASH_ENV`. Verified: no markers, output unchanged. None of these vars are in the tmux, systemd-user or session env today, so this is hardening, not a live hole.
3. **The refresh runner's cwd is load-bearing** (B5). From a clone cwd it opened the clone's `.claude/settings*.json` and `bunfig.toml` and read `.git/config`, even with `--setting-sources ""` (nothing ran). From aw's dir it touched nothing planted. aw keeps cwd = its own dir and refuses to start a nono lane when that dir is under `workspaceRoot`.

Re-check B1 after a Claude upgrade (`latest` → realpath pins the version), and B6 if a managed settings file is ever installed: it loads under `--setting-sources ""`, and its hooks still run under `--safe-mode`.

## Q1. Token lifetime and refresh

Host login metadata (`~/.claude/.credentials.json` → `claudeAiOauth`) [live]:

| Field | Value |
|---|---|
| access token | `sk-ant-oat01-…`, `expiresAt` = file mtime + 8.0 h (last refresh) |
| refresh token | `sk-ant-ort01-…`, `refreshTokenExpiresAt` ≈ 3.8 days from now |
| scopes | `user:file_upload user:inference user:mcp_servers user:plugins user:profile user:sessions:claude_code` (no `org:create_api_key`) |
| subscription | `max`, source `sign_in` |

How Claude refreshes [code]:

- **Endpoint.** `POST https://platform.claude.com/v1/oauth/token` with `grant_type=refresh_token`. The response may rotate the refresh token; if it returns none, Claude keeps the old one.
- **When.** Only when `now + 300000 ms >= expiresAt` (`uI`), or when forced after a 401.
- **Locks.**
  - The main lock is `<config>/.oauth_refresh.lock` (proper-lockfile, `stale: 60000`, 5 retries).
  - There is also a legacy lock, `realpath(<config>) + ".lock"`, which is `~/.claude.lock` for the default dir. On that lock, `ELOCKED` is rethrown and only other failures are logged.
  - Under the lock Claude re-reads the credentials and returns `race_resolved` if another process already refreshed. Refresh tokens that came back `invalid_grant` are remembered as dead.
- **Hard time limit.** On refresh, `refreshTokenExpiresAt` becomes `min(stored, new)`. It stays undefined if it was never stored, and only a sign-in sets it (`iO`). When it passes, Claude says: "this login reached its time limit and cannot be renewed. Run `claude auth login`…, or use `claude setup-token`… for unattended jobs".
  - Docs: a warning appears 3 days before expiry, and "Renewing early matters most for sessions that run unattended" ([authentication#renew-an-expiring-login](https://code.claude.com/docs/en/authentication#renew-an-expiring-login)).
  - Your login's total length is unknown; ~3.8 days remain. A setup-token lasts one year [docs].

Keeping the host login fresh without a model turn:

| Command | Triggers refresh? | Model call? |
|---|---|---|
| `claude auth status --json` | no: it only reads (`yi` → `cli_auth_status`) [code] | no |
| `claude mcp list` | not observed [live] | no |
| `claude -p "/cost"` | **yes**: 6 attempts in the debug log, before Bootstrap [live] | **0** `/v1/messages` [live] |
| same, plus `--safe-mode --setting-sources "" --strict-mcp-config --no-session-persistence` | **yes**: 4 attempts [live] | **0** [live] |
| `claude -p "/usage"` | yes [live] | 0 [live] |
| `claude -p "Reply OK"` | yes, at startup [live] | yes |

How these rows were probed:

1. A sandboxed config dir with a bogus `.credentials.json` (`expiresAt: 1000`).
2. A probe profile with `deny_domain: ["platform.claude.com"]`.
3. `grep` of the `--debug-file` output for `OAuth refresh failed` and `API REQUEST] /v1/messages`.

No transcript is written with `--no-session-persistence` [live]. The success path, a real refresh that writes new credentials, was exercised in gate B2 [live].

## Q2. Placeholder token behind nono's proxy

Setup [live]: the profile was a copy of `nono/aw-claude.json` in `/dev/shm/awauth-test` (since deleted). jq added the route below. The test capture was a plain `jq -j .claudeAiOauth.accessToken <file>`; the proposed capture is in Phase 2.

```json
"network": {
  "credentials": ["github", "github_git", "anthropic_oauth"],
  "custom_credentials": { "anthropic_oauth": {
    "upstream": "https://api.anthropic.com",
    "credential_key": "cmd://anthropic_oauth",
    "env_var": "CLAUDE_CODE_OAUTH_TOKEN",
    "credential_format": "Bearer {}" } } }
```

The run had a fresh `CLAUDE_CONFIG_DIR` seeded only with the account and trust keys (no `.credentials.json`) and the launcher's grants.

| Check | Result |
|---|---|
| Session env | `CLAUDE_CODE_OAUTH_TOKEN` is the 64-hex phantom, the same value as `GH_TOKEN` and `NONO_PROXY_TOKEN`. nono also sets `HTTPS_PROXY`, `NODE_EXTRA_CA_CERTS`/`SSL_CERT_FILE` (its intercept CA), `NODE_USE_ENV_PROXY=1`, and `ANTHROPIC_OAUTH_BASE_URL=http://127.0.0.1:<port>/anthropic_oauth` (Claude doesn't read that name [code]) |
| MITM path (no base URL) | `claude -p "Reply with exactly: OK" --model haiku` → `OK`, exit 0 |
| Negative control (capture prints an invalid token) | `401 OAuth access token is invalid` |
| Reverse-proxy path (`ANTHROPIC_BASE_URL=$ANTHROPIC_OAUTH_BASE_URL`) | `OK`, request `/anthropic_oauth/v1/messages`. The log shows no policy-limits or remote-settings fetches, so this path drifts from default behaviour |
| `claude auth status --json` (env mode) | `authMethod: oauth_token`, `subscriptionType: null`, no email (the same as a setup-token today) |
| Headers | `Authorization: Bearer <phantom>` plus `anthropic-beta: oauth-2025-04-20` [code]. nono replaces only `Authorization`, and the turn succeeded |
| Capture command env | inherits the **ticket's** env (`CLAUDE_CONFIG_DIR`, `PATH`, …), cwd = the **session clone**, proxy vars removed [live]. Hence a read-only capture with absolute paths |

Hosts and endpoints:

- **`api.anthropic.com`:** `/v1/messages`, `/api/event_logging/v2/batch`, policy limits and remote settings, all fetched at startup [live]. Profile and Bootstrap use the same host [code]. All of them get the token, because the route has no `endpoint_rules`.
- **`platform.claude.com`:** never contacted in env mode. Claude doesn't refresh env tokens: `sba()` → refresh mode `none` [code].
- **`mcp-proxy.anthropic.com` and claude.ai connectors:** unused. Env tokens are `user:inference` only; the log says "env-var and setup-token sessions default to user:inference only" [live].
- **Statsig, Sentry, Datadog:** not in nono's `claude-code` network profile, so they stay blocked as today.

nono semantics [nono docs embedded in the binary; https://nono.sh/docs]:

- **When capture runs.** `credential_capture` runs lazily when the proxy needs the credential. Settings: `cache_ttl_secs` 0–3600 (0 = no cache, default 900) and `timeout_secs` 1–300. Docs: "only the proxy receives captured material, and the sandboxed child never sees the command output". The command is an argv array with no implicit shell.
- **Registration.** `custom_credentials` is only a definition; the name must also be listed in `network.credentials`.
- **Name clash.** nono has a built-in `anthropic` credential (`x-api-key`). Don't reuse that name.
- **`oauth_capture`** (`credential_providers`) lets a sandboxed Claude run its own `/login`. It doesn't fit aw: each ticket would need its own login, or the tickets would share a rotating refresh token.

## Q3. Alternatives

| Option | Verdict | Why |
|---|---|---|
| **nono proxy + read-only capture + aw host refresh (recommended)** | build | Verified above. The token never enters the sandbox, and Claude Code refreshes it under its own lock |
| Lazy refresh inside the capture | fallback only | Needs no aw timer, but runs `claude` from the ticket's env. It would have to clear the env itself (`/usr/bin/env -i …`, the resolved real `claude`, host cwd, `--safe-mode --setting-sources ""`). Use it only if aw-down outages matter |
| `apiKeyHelper` | no | It runs **inside** the sandbox, so the real token would be visible there. Its output goes out "as both the `X-Api-Key` and `Authorization: Bearer` headers", which is API-key auth, not the OAuth path ([settings-reference#apikeyhelper](https://code.claude.com/docs/en/settings-reference#apikeyhelper)) |
| Host-refreshed `CLAUDE_CODE_OAUTH_TOKEN` + restart | no | The token is visible in the sandbox and dies after ≤ 8 h (env tokens never refresh [code]) |
| Copy `.credentials.json` without the refresh token (Codex pattern) | no | Real token in the sandbox, dead after ≤ 8 h, then Claude asks for `/login` |
| Phantom `.credentials.json` (`refreshToken: null`, far `expiresAt`, full scopes) | later, optional | `auth status` → `authMethod: claude.ai`, `subscriptionType: max` [live]. It might enable Remote Control, but those calls may reach hosts with no injection. Untested beyond `auth status` |
| `setup.sh` runs `claude setup-token` | no | Still the browser flow, and the token stays in the session env |
| Keep setup-token | fallback | Required for `sandbox: "none"` |

## Q4. Interactions

- **Per-ticket `CLAUDE_CONFIG_DIR`:** unchanged. The env token needs no `.credentials.json` there, and nothing refreshes inside the sandbox, so there are no lock or rotation conflicts.
- **Pre-seeded keys:** seed `ACCOUNT` (`hasCompletedOnboarding`, `lastOnboardingVersion`, `oauthAccount`, `userID`) from `~/.claude.json`, and keep the `TEMPLATE` symlinks (settings, skills) from `~/.claude-aw`.
  - The live run started with no onboarding or trust prompt [live; `-p` only, TUI not checked].
  - `~/.claude-aw` becomes a settings template only. A separate aw login stays possible as opt-in isolation, at the cost of a second login to renew.
- **Your own sessions:** they share `~/.claude/.credentials.json` with aw's refresh. Both are Claude Code under the same lock [code]. Your interactive use keeps it fresh too, but only while Omarchy's selected Claude account is the default `~/.claude` one (the wrapper otherwise points `claude` at another config dir [code]).
- **Remote Control: not fixed.** Docs: the env token "can only make model requests, so it can't establish Remote Control sessions" ([authentication#generate-a-long-lived-token](https://code.claude.com/docs/en/authentication#generate-a-long-lived-token)). Only the phantom-`.credentials.json` variant could change that (unverified).
- **Claude → Codex:** unchanged (Codex login copy).
- **Codex → Claude:** today a Codex lane exports only `CODEX_HOME` (`src/agents.ts:133`), so a nested `claude` would use `~/.claude` without a token. It needs:
  - the launch to export `CLAUDE_CONFIG_DIR=<ID>.claude` and `CLAUDE_CODE_TMPDIR`;
  - `<ID>.claude` seeded and granted for Codex lanes (`src/launcher.ts:50,224`);
  - in `nono/aw-codex.json`, the route, the capture, and `allow_vars` `CLAUDE_CONFIG_DIR`, `CLAUDE_CODE_TMPDIR`. nono's injected `CLAUDE_CODE_OAUTH_TOKEN` bypasses `allow_vars` [nono docs], so it stays off the list.

  The `codex` network profile already includes `api.anthropic.com` [code].
- **Billing:** the same OAuth subscription token type as setup-token. In env mode `/cost` shows a `$` figure because `subscriptionType` is unknown (it does today too). Confirm at claude.ai/settings/usage [inferred].

## Terms

[legal-and-compliance](https://code.claude.com/docs/en/legal-and-compliance#authentication-and-credential-use): OAuth "is intended exclusively for purchasers of … subscription plans and is designed to support ordinary use of Claude Code". It also says "developers may not collect, store, or intermediate Claude.ai credentials or session tokens — sign-in to a Claude account must complete through Anthropic's own flow". The usage limits "assume ordinary, individual usage".

- **In favour:** the requests come from the unmodified Claude Code binary, on your own subscription and machine. Sign-in uses Anthropic's flow, and Claude Code does the refresh itself.
- **Against:** a local proxy injecting the token reads like "intermediating" session tokens. The clause targets third-party products, but it has no carve-out for personal tooling. `claude setup-token` is the documented path for unattended use. **Your call**; this doc can't settle it.

## Implementation plan

Nothing changes how sessions authenticate until the activation PR, and that PR lands only after the blocking gates pass.

**Phase 0: blocking evidence (no repo code).** Settle gates B1–B6 with scratch profiles and host commands. Any failure stops the rollout here.

**Phase 1: inactive prep PR.** Code and tests only; nothing calls it from `run` or `once`, and the profiles are unchanged.

- **Resolver.** Find the real Claude executable and the bun binary once, at start (bun: `realpath(process.execPath)`, under the same rejection rule):
  - Use `mise which claude` when mise exists, run from aw's own dir; otherwise `Bun.which("claude")`. Then `realpath`.
  - Reject the result if it is a mise command wrapper or `/usr/bin/mise`, or if it sits under `workspaceRoot` or any path a session can write.
  - Re-resolve only when the path disappears, e.g. after a Claude upgrade removes the old version dir. Here it resolves to `~/.local/share/mise/installs/claude/<ver>/claude`.
  - Leave `CLAUDE_CONFIG_DIR` unset, so the default `~/.claude` and `~/.claude.json` semantics apply.
- **Refresh decision.** A pure function of the metadata: refresh when `expiresAt − now < 300000`.
- **Refresh runner.** `Bun.spawn(["/usr/bin/timeout", "-k", "5", "60", <claude>, "-p", "/cost", "--safe-mode", "--setting-sources", "", "--strict-mcp-config", "--no-session-persistence"])`:
  - `env: { HOME, PATH: "/usr/local/bin:/usr/bin:/bin" }`, with cwd set to aw's own dir and stdio `ignore`. The cwd is load-bearing (gate B5): Claude reads the cwd's settings and git config even with `--setting-sources ""`.
  - `timeout` kills the whole child group, and it still fires if aw dies (as `spawnRun` relies on). It is a dedicated spawn, because `spawnRun` has no env override.
  - Single-flight: one refresh at a time.
  - Afterwards, re-read the metadata and log only `ok`, `unchanged` or `failed` and the exit code.
- **Login preflight.** Read metadata only:
  - **fail** if the file is missing ("run `claude auth login`"), if `refreshToken` is absent, if `user:inference` is not in scopes, or if `refreshTokenExpiresAt` is past;
  - **warn** if `refreshTokenExpiresAt` is unknown or less than 3 days away.
- **Capture script.** The profile command (Phase 2) with its fixture tests: the Phase 1 tests read the command from the profile and run it against fixtures. Run with `HOME=<fixture>`, the ticket cwd set to a clone that holds a `bunfig.toml` preload and a `.env`, `PATH=<clone>` and `BUN_OPTIONS=--preload <clone>/evil.ts`, it gave [live]:
  - valid, compact or pretty-printed → prints, exit 0;
  - an `mcpOAuth` decoy listed first → prints the root token;
  - a decoy nested inside the entry, next to its own token → prints its own token;
  - exit 1 with empty stdout and stderr for each of these:
    - expired;
    - no root `accessToken` (decoy only in `mcpOAuth`);
    - a `claudeAiOauth` only nested under `mcpOAuth` (review 3);
    - a decoy nested in the entry and no token of its own (review 3);
    - `expiresAt: 9999999999999e-20` (review 3);
    - `expiresAt` as a string;
    - a root array;
    - truncated JSON.
  - The preload and the `.env` never ran or loaded.
  - Control: plain `bun -e` started in that clone printed `PRELOAD-RAN` and loaded the `.env`. The hazard is real, and the `cd /` + `env -i` + `--no-env-file` wrapper is what removes it.

  On the real `~/.claude` file it printed a value of the same length as the stored token (value not shown).
- **Checks.** Typecheck and focused tests for each unit.

**Phase 2: activation PR (both directions, one revertable unit).** Implemented on `feat/claude-auth-activate`; gates R1–R6 pending. [As built](#phase-2-as-built) lists where it differs from the plan below.

- **Profiles.** In `nono/aw-claude.json` **and** `nono/aw-codex.json`, add the route from Q2 to `network.credentials`, plus this capture (`timeout_secs: 5`, `cache_ttl_secs: 0`):
  ```json
  "command": ["/bin/sh","-p","-c","cd / && exec /usr/bin/env -i HOME=\"$HOME\" \"$AW_BUN\" --no-env-file -e \"$1\"","sh","try{const f=require(\"node:fs\"),d=process.env.HOME+\"/.claude/\",w=Date.now()+3000;while(f.existsSync(d+\".oauth_refresh.lock\")&&Date.now()<w)Bun.sleepSync(50);const c=JSON.parse(f.readFileSync(d+\".credentials.json\",\"utf8\"));const o=c!==null&&typeof c===\"object\"&&!Array.isArray(c)&&Object.hasOwn(c,\"claudeAiOauth\")?c.claudeAiOauth:null;const t=o?.accessToken,e=o?.expiresAt;if(typeof t===\"string\"&&/^[A-Za-z0-9._-]+$/.test(t)&&Number.isSafeInteger(e)&&e>Date.now()+30000){process.stdout.write(t);process.exit(0)}}catch{}process.exit(1)"]
  ```
  The inline script, readable:
  ```js
  try {
    const f = require("node:fs"), d = process.env.HOME + "/.claude/", w = Date.now() + 3000;
    while (f.existsSync(d + ".oauth_refresh.lock") && Date.now() < w) Bun.sleepSync(50);
    const c = JSON.parse(f.readFileSync(d + ".credentials.json", "utf8"));
    const o = c !== null && typeof c === "object" && !Array.isArray(c) && Object.hasOwn(c, "claudeAiOauth") ? c.claudeAiOauth : null;
    const t = o?.accessToken, e = o?.expiresAt;
    if (typeof t === "string" && /^[A-Za-z0-9._-]+$/.test(t) && Number.isSafeInteger(e) && e > Date.now() + 30000) { process.stdout.write(t); process.exit(0); }
  } catch {}
  process.exit(1);
  ```
  - It waits while Claude's refresh lock exists, for at most 3 s (inside `timeout_secs: 5`), then reads anyway. Claude holds the lock from before the token call until after the new credentials are written, and the server revokes the old token at rotation (gates B3, B4), so a read inside it would return a dead token. A stale lock (its holder died) must not blackhole every session until the next refresh, and the write is tmp + rename, so the late read is never partial.
  - It is read-only and parses real JSON. Only the root `claudeAiOauth` counts, and `expiresAt` must be a safe integer more than 30 s in the future. Anything else exits 1 with no output.
  - `catch {}` keeps parse errors, which can quote file content, out of stderr; nono audits capture stderr (`credential_capture_stderr` [code]).
  - It ignores the ticket's cwd, `PATH` and bun-specific env (`BUN_OPTIONS`, a clone's `bunfig.toml` and `.env`): `cd /`, `env -i` with only `HOME`, `--no-env-file`, and no imports.
  - `-p` (bash privileged mode) ignores exported functions, `SHELLOPTS`, `BASHOPTS`, `CDPATH`, `ENV` and `BASH_ENV` from the inherited env. Without it, `BASH_FUNC_cd%%` and `SHELLOPTS=xtrace`+`PS4=$(…)` ran code before `env -i` [live, gate B5].
  - It does **not** neutralise `LD_PRELOAD`. Safe only while the supervisor env comes from aw's launch script (`launcher()` in `src/launcher.ts`).
  - `AW_BUN` is exported by the launch script, which aw writes, and it is not in `allow_vars`. aw sets it to `realpath(process.execPath)`, so under the service it is `~/.bun/bin/bun` [live].
  - At start aw rejects that path if it is under a mise `shims` or `command-wrappers` dir or under `workspaceRoot`, the same rule as for `claude`.
  - A global `~/.bunfig.toml` preload is no evidence either way: on bun 1.4.4 it does not run for plain `bun -e` either [live, review5]. Sessions cannot write `$HOME` outside their grants.
  - In `nono/aw-claude.json` and `nono/aw-codex.json`, generate the command with `JSON.stringify` rather than escaping it by hand. A test asserts both profiles and this doc hold exactly `CAPTURE_COMMAND` from `src/claude-auth.ts`.
  - `aw-codex.json` also needs `allow_vars` `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TMPDIR`. Neither profile lists `CLAUDE_CODE_OAUTH_TOKEN`: nono's injected phantom bypasses `allow_vars`, and listing it would only let an inherited real token through.
- **Launch** (`src/agents.ts`).
  - For nono lanes, drop the setup-token line; `sandbox: "none"` keeps it.
  - Codex lanes also export `CLAUDE_CONFIG_DIR=<ID>.claude` and `CLAUDE_CODE_TMPDIR`.
  - Both lanes export `AW_BUN`, the path resolved at start, for the capture. It is not in `allow_vars`.
- **Launcher** (`src/launcher.ts`).
  - Seed and grant `<ID>.claude` for Codex lanes too.
  - `seedClaude` takes `ACCOUNT` from `~/.claude.json`, and `TEMPLATE` from `~/.claude-aw` as today.
  - nono lanes use the login preflight instead of the token-file check.
- **Lifecycle** (`aw.ts`):

  | Command | Refresh behaviour |
  |---|---|
  | `run` (not dry) | Resolve, preflight, and an **awaited** refresh check before the first pass. Then a `setInterval` of 60 s, independent of `pass()`. On SIGINT/SIGTERM, clear the interval; an in-flight child is bounded by `timeout` (≤ 65 s) |
  | `once` (not dry) | One awaited check before the pass, no timer, so the process exits when the pass is done. Sessions it starts get no further refresh from aw |
  | `--dry-run` (`run`, `once`) | Metadata preflight only: no spawn, no credential writes. Dry run logs what it would do |
  | `status`, `watch`, `tail` | Nothing: no preflight, no refresh |

  Service stop (`KillMode=process`) kills only bun; a running refresh child ends within its `timeout`.
- **Setup and docs.**
  - `scripts/setup.sh`: check `claude auth status` on the default config, and require the setup-token only if a lane uses `sandbox: "none"`.
  - README setup section and line 5 (Remote Control); `docs/issues.md` item 20.
- **Tests.**
  - `tests/pass.test.ts`, for both lanes' env, preflight fail/warn, and the `none` token case.
  - `tests/helpers.ts` (metadata-only fixture).
  - Profile assertions for both routes and the zero TTL.
  - Lifecycle: dry run spawns nothing, `once` exits promptly, no overlap during a slow refresh, and timeout/shutdown leaves no refresher behind.
- **Pass conditions.** `nono profile validate` on both profiles, typecheck, the focused tests, then gates R1–R6 before relying on it.

<a id="phase-2-as-built"></a>**Phase 2 as built** (differences from the plan above):

- `AW_BUN` is exported on the launch script's nono-only line (`src/launcher.ts`), not per agent. `start` resolves it with `findBun([workspaceRoot])`. A session keeps the path it was launched with, so if that bun is removed (say, a mise-managed bun on upgrade), its captures fail until it is restarted.
- The same nono-only line runs `unset CLAUDE_CODE_OAUTH_TOKEN`, so a setup-token inherited from the tmux or service env never reaches a nono session. The `none` Claude lane still sets it.
- Codex lanes export `CLAUDE_CONFIG_DIR` and `CLAUDE_CODE_TMPDIR`, and get a seeded `<ID>.claude`, only under nono. A `sandbox: "none"` Codex lane has no proxy, so a nested `claude` there keeps using the host's `~/.claude` as before.
- `nono/aw-codex.json` also reads `~/.claude-aw/settings.json` and `~/.claude-aw/plugins`, the targets of the template links in `<ID>.claude`, as `aw-claude.json` does.
- Startup (`hostLogin`, `run` and `once`, dry or not, when any lane uses nono) splits failures by kind:
  - **Fatal (exit 1) for any nono lane:** aw's dir under `workspaceRoot` (the profiles and the refresh cwd would be session-writable), `AW_BUN` failing the resolver, and, when a login exists and the run is not dry, `claude` failing the resolver.
  - **Logged only:** login state (missing, no refresh token, no `user:inference`, past its time limit, or a warning). `start()` rejects nono Claude tickets in that state, so Codex and `none` lanes, and reconciling running sessions, keep going, the same as when the login lapses while aw runs. `scripts/run.sh`'s dry-run preflight therefore doesn't fail on login state; `scripts/setup.sh` prints it as a TODO.
  - With no login file, `claude` is not resolved at start (a Codex-only host may not have it); the refresher resolves it once a login appears.
  - A non-dry run then awaits one refresh check.
- The refresher skips the spawn once `refreshTokenExpiresAt` has passed, and logs that once, not every 60 s, until the login is renewed.
- Each nono Claude start re-runs the login preflight, so a login past its time limit fails the start with the fix in the log; a near limit is logged.
- `status`, `watch` and `tail` run no preflight and no refresh.
- No signal handlers were added: SIGINT/SIGTERM end bun, and with it the 60 s timer. A running refresh child is bounded by `timeout` (≤ 65 s).
- `scripts/setup.sh` runs aw's own `checkLogin` on `~/.claude` instead of `claude auth status`, since the mise wrapper may point `claude` at another account's dir (B1). It asks for the setup-token only when `aw.json` has a `sandbox: "none"` repo, and no longer asks for a `~/.claude-aw` login.
- `docs/issues.md` doesn't exist in this repo, so there was nothing to update.
- Not covered by automated tests: the `run` timer and the `aw.ts` exit wiring; gate R6 covers them live. `hostLogin` takes a finder (default `findClaude`) so its non-dry path is tested with a fake `claude`.

**Phase 3 (optional).** A phantom `.credentials.json` for Remote Control, then `endpoint_rules` built from the observed paths.

**Migration.**
- There is nothing to log in to.
- Restart running sessions so they pick up the new route.
- Keep `~/.claude-aw/oauth-token` and the setup-token while any lane uses `sandbox: "none"` and until rollback is retired. Then revoke the token at claude.ai, since the agent could read it.

**Rollback.** Revert the activation PR as a whole, then restart affected sessions, because a running nono proxy keeps the profile it started with. The token file is still in place.

## Rollout gates

Blocking, Phase 0 (before activation). All passed on 2026-11-14; see [Phase 0 results](#phase-0-results).

- **B1. Executable.** The resolver returns the real binary, not the wrapper. Run with the clean env, it uses `~/.claude` even while Omarchy has a **different account selected**. Re-check after a Claude upgrade.
- **B2. Successful refresh, no inference.** Run inside the 5-minute window with `--debug-file` set to a host path. All of these must hold:
  - exit 0 within the timeout;
  - new credentials persisted, with `expiresAt` about +8 h;
  - a known `refreshTokenExpiresAt` that did not grow;
  - **0** `/v1/messages` requests in that run;
  - your interactive `claude` still works afterwards.
- **B3. Concurrency.** Overlap the refresh with your own sessions in the window. Expect one refresh, `race_resolved` elsewhere, and no `invalid_grant`.
- **B4. Overlapping requests.** A scratch-profile session streams requests across a host refresh (TTL 0). If a just-captured old token 401s, either block the rollout or accept and document the race, which your own interactive refreshes trigger too.
- **B5. Host-boundary negatives.** Plant `bun`/`env`/`claude`/`sh` on the ticket PATH, `BUN_OPTIONS`/`NODE_OPTIONS` in the ticket env, `.claude/settings*.json` hooks, `bunfig.toml` and `.env` in the clone, and files in the ticket tmp/XDG dirs; also inherit `ANTHROPIC_*`/`CLAUDE_CODE_OAUTH_TOKEN`. Neither the capture nor the refresh may execute or read any of them. Also confirm a session cannot set `LD_PRELOAD`, `BASH_FUNC_*%%` or `SHELLOPTS`/`PS4` on the `nono run` process, since those act on the capture's `/bin/sh` before `env -i`.
- **B6. Managed policy.** Review `/etc/claude-code/managed-settings.json` (if any): it loads under `--setting-sources ""` and is accepted as host trust.

Before rollout, on the activation PR. **Pending**; run them with the operator:

- **R1.** An interactive TUI session, and a long session across a host refresh.
- **R2.** Claude → Codex and Codex → Claude, end to end.
- **R3.** Billing appears on claude.ai/settings/usage, not as API spend.
- **R4.** Stop aw: running sessions 401 once the token lapses (≤ 8 h), unless your own Claude use refreshed it. Document this.
- **R5.** `sandbox: "none"` lanes still work on the setup-token.
- **R6.** Lifecycle: `scripts/run.sh` (dry-run preflight) spawns no refresh, and `once` exits.

## Risks

- **The refresh runs unsandboxed `claude` on the host.** Clean env, `--safe-mode` and empty setting sources keep agent-written files out of it. Gate B5 must prove that, and B1 that it is the real binary.
- **The login has a time limit.** When the `~/.claude` login reaches it, every Claude session 401s until `claude auth login`. A setup-token lasts a year.
- **A refresh revokes the old access token at once** (gate B4). The capture's lock wait narrows the gap between rotation and the credentials write, but a capture that passed the check just before a rotation still hands out a token that dies in flight. If the lock is held for more than 3 s (a slow token call, or a stale lock left by a killed refresh, which proper-lockfile clears only when another Claude process next tries to take it), the capture reads the file anyway, so a stale lock costs 3 s per request rather than every request failing.
- **A 401 mid-turn ends the turn.** Env mode never retries a refresh (`CLAUDE_CODE_OAUTH_401_WAIT_MS` is 0 outside remote sessions [code]), so the turn needs a nudge or a restart. aw downtime longer than the token's remaining life causes this.
- **Spend while running.** The agent can still spend the subscription through the proxy, on any `api.anthropic.com` path, but it can't take the token away. There is no `org:create_api_key` scope.
- **Shared rotation with your sessions.** This rests on Claude's lock; gates B3 and B4 passed.
- **Terms ambiguity** (above).

## Unverified

- The login's total length (~3.8 days left now).
- A full TUI session and a long session through the proxy (only `-p` turns were run).
- Remote Control with a phantom `.credentials.json`; Codex → Claude end to end; billing attribution.
- Whether `claude mcp list` triggers a refresh (no debug log was produced).
- That B2's refresh was made by aw's runner rather than another process (inferred from timing; Claude logs no success line).

## Live test log (reproducible)

Scratch dir `/dev/shm/awauth-test` (deleted afterwards). It held:
- a profile copy with the route above;
- `wt/` (`git init`);
- `wt.claude/.claude.json` with the 4 account keys plus trust;
- `wt.tmpdir/`.

Runs:

```bash
cd $T/wt && CLAUDE_CONFIG_DIR=$T/wt.claude TMPDIR=$T/wt.tmpdir CLAUDE_CODE_TMPDIR=$T/wt.tmpdir XDG_CACHE_HOME=$T/wt.tmpdir/cache \
  nono run -s --no-rollback-prompt --profile $T/p.json --allow $T/wt --allow $T/wt.claude --allow $T/wt.tmpdir -- \
  claude -p "Reply with exactly: OK" --model haiku --debug-file $T/wt.tmpdir/debug.log          # → OK
# control: capture command ["printf","sk-ant-oat01-invalid-control"]                             # → 401
# reverse proxy: sh -c 'ANTHROPIC_BASE_URL=$ANTHROPIC_OAUTH_BASE_URL exec claude -p …'           # → OK
# refresh probes: bogus expired .credentials.json + deny_domain platform.claude.com, then
#   grep -c 'OAuth refresh failed' / 'API REQUEST] /v1/messages' in --debug-file
#   (hardened flags incl. --safe-mode: 4 refresh attempts, 0 /v1/messages)
```

Two model turns (Haiku) were spent on the subscription, none in the review round.
