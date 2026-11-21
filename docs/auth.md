# Agent logins

How Claude Code and Codex sessions authenticate.

## Claude auth

Sandboxed (`nono`) sessions use your own Claude login in `~/.claude` (`claude auth login` if you have none); there is nothing to set up for them. The session holds only nono's phantom in `CLAUDE_CODE_OAUTH_TOKEN`. For each request to `api.anthropic.com`, nono's proxy swaps in the real access token, read on the host from `~/.claude/.credentials.json` by tender's own `bun` (`TENDER_BUN`), from `/`, under `env -i`, uncached. The session never sees the token or the file. Each session keeps the `TENDER_BUN` path it was launched with, so restart running sessions if that bun is removed (e.g. a mise-managed bun on upgrade). Codex sessions get the same route and their own `<ID>.claude` dir, so a `claude` they run works too.

Claude refreshes only inside the last 5 minutes of the access token's 8 hours, and never from an env token, so `tender run` refreshes your login itself: at start and every 60 s it checks the expiry, and inside that window runs `claude -p /cost` on the host (the real executable that `mise which claude` resolves to, not the mise wrapper, with a clean env, `--safe-mode`, no setting sources and tender's dir as cwd). That makes no model turn, and Claude's own lock keeps it from racing your interactive sessions. `tender once` checks once; `--dry-run`, `status`, `watch` and `tail` never refresh. If `tender` is down for longer than the token has left, sessions get 503s from nono's proxy (Claude reports a server-side error) until your own Claude use or `tender` refreshes it. When the login itself reaches its time limit, run `claude auth login`; `tender` warns 3 days ahead, and a sandboxed Claude start fails once it has passed.

Unsandboxed (`none`) Claude sessions authenticate with a long-lived token instead:

```bash
claude setup-token   # prints the token; save it with:
install -m 600 /dev/stdin ~/.claude-tender/oauth-token   # paste, then Ctrl-D
```

The launch script reads it on the host and passes it as `CLAUDE_CODE_OAUTH_TOKEN`, so it never lands in the script, the prompt or the logs. An unsandboxed Claude start fails while the file is missing, empty or whitespace-only. Copying `.credentials.json` per ticket would not work: Claude rotates refresh tokens, so the copies would log each other out.

Log Codex in; this login is separate from your own:

```bash
CODEX_HOME=~/.codex-tender codex login
```

## Codex auth

Codex uses that ChatGPT login, so sessions draw on your plan's Codex limits (Plus, Pro, Business or Enterprise), shared by all concurrent sessions. Each ticket gets its own `CODEX_HOME`, `<workspaceRoot>/<owner>/<name>/<ID>.codex`, recreated at every start from the `~/.codex-tender` template: a copy of `config.toml` (and `hooks.json`) with `[projects."<session clone>"] trust_level = "trusted"` appended unless already there, so Codex starts without its folder-trust prompt (a template it would make invalid TOML, e.g. an inline `projects` table, fails the start), `AGENTS.md` and `skills` linked to their resolved targets, and `auth.json` (0600). Sessions can read only the template's `AGENTS.md` and `skills` and write none of it, so a session cannot plant config, MCP servers, hooks, instructions or transcripts for other tickets.

Only the host holds the refresh token. ChatGPT refresh tokens rotate and Codex rejects a reused one, so a copy that could refresh would log the template out. The ticket's `auth.json` holds only what an access-token login needs, copied from the template: `auth_mode`, `last_refresh` and the tokens' `id_token`, `access_token`, `account_id`, `login_owner_id` and `oauth_provenance`, with `refresh_token` set to `""` (Codex refuses the file without the key). Anything else in the template (an API key, a personal access token, Bedrock keys, fields a newer Codex adds) stays on the host. It carries the access token, which lives 10 days and which the session can read: its own credential, like the Claude token. Before copying, if the template's access token (its JWT `exp`) expires within 24 hours, `tender` refreshes it on the host: Codex has no refresh command, so `tender` runs `CODEX_HOME=~/.codex-tender codex app-server` and sends `account/read` with `refreshToken: true` (the app-server's forced refresh), waiting for the reply before closing it, under `flock` on `~/.codex-tender` so two `tender` processes never refresh at once. A refresh killed at its 60 s deadline after the server rotated the token but before Codex saved it loses the template login; log in again. If the token still expires within 24 hours afterwards, or the template has no ChatGPT login, the start fails with the fix (`CODEX_HOME=~/.codex-tender codex login`) in the log. A Claude start never fails over it; its Codex is then just not logged in. So a session starts with at least a day of token. If it runs past expiry, Codex tries to refresh with the empty token, which fails, and its requests fail with "Your access token could not be refreshed…": the session stays open but cannot work, and likely reads as idle rather than stalled (from the Codex source; not checked live). Restart the ticket for a fresh copy.

No trust step: Claude keys folder trust on the git repository root ([docs](https://code.claude.com/docs/en/permissions#project-allow-rules-and-workspace-trust)), here the session's own clone, so trusting `~/agent-ws` or your home does not cover it. Each Claude ticket gets its own config dir, `<workspaceRoot>/<owner>/<name>/<ID>.claude`, which `tender` recreates at every start: symlinks to the template's `settings.json`, `CLAUDE.md`, `AGENTS.md`, `skills` and `plugins` (resolved, so they point at the real files), and a `.claude.json` holding only your login's onboarding and account keys (from `~/.claude.json`) plus `projects["<session clone>"].hasTrustDialogAccepted` (the documented way to trust a folder by hand) and external `CLAUDE.md` imports declined (an ancestor `~/.claude/CLAUDE.md` reads as project memory once the config dir moves), so the session starts without a dialog. The session `--settings` also set `skipDangerousModePermissionPrompt`, so bypass mode starts without its warning. `~/.claude-tender` is the template: sessions can write only their own dir and read only the template's `settings.json`, `CLAUDE.md`, `AGENTS.md`, `skills/` and `plugins/`, so a session cannot plant hooks, instructions, MCP servers or plugins for other tickets. Anything it leaves in its own dir is gone at the next start and at cleanup.

Check the sandbox profiles parse:

```bash
nono profile validate nono/tender-claude.json
```

```bash
nono profile validate nono/tender-codex.json
```

```bash
nono profile validate nono/tender-check.json
```
