# Review standards

Every pull request is reviewed against this file before it can merge (`.github/workflows/pr-review.yml`).
A **blocking** finding sends the PR back with "Changes requested". Anything else is a non-blocking note.
Edit this file to change the bar; the reviewer reads it fresh on every run.

This gateway exposes a home PC to the internet through Tailscale Funnel. The bar is set by that.

## Blocking

### Security
- **Path access.** Any file access must go through the guard (`makeGuard`): inside `roots`, outside `deny`
  and `denyNames`, resolved with symlinks and junctions followed, and with UNC and device paths refused
  before any filesystem call. A new way to read, list, search or write files that skips the guard blocks.
- **Auth.** `/mcp` and the runner port must stay authenticated. Passphrases and tokens are compared in
  constant time (`timingSafeEqual`) and stored hashed (scrypt for the passphrase, SHA-256 for tokens).
  OAuth redirects stay limited to Claude origins. Weakening any of these blocks.
- **Listening.** Servers listen on `127.0.0.1` only. The runner port (8788) must never be exposed on Funnel.
- **Commands.** `run_command` runs only the named commands in `commands`. Building a shell string from tool
  input, or running anything not on that list, blocks.
- **Sessions.** Normal sessions run as `duet-agent` and stay in their workspaces. Egnyte sessions stay
  approval-gated, with web tools and secret paths denied. The `duet.OFF` kill switch must keep working.
  Anything that lets a normal session reach `Z:\`, the owner's profile, or code that runs as the owner blocks.
- **Money tools.** `money_*` stays a read-only allowlist. Adding a tool that moves money or changes accounts blocks.
- **Secrets.** No secrets, tokens, passphrase hashes or machine paths committed. `config.json`, `state.json`,
  `sessions.json`, `gateway.log` and `duet.OFF` stay out of git.
- **Logs.** `gateway.log` and `runner.log` hold ids and outcomes only. Logging prompts, answers, file contents
  or tokens blocks.

### Correctness
- Bugs that break a tool, the OAuth flow, the runner protocol, or startup.
- Unhandled promise rejections or thrown errors that can crash the gateway from tool input.
- Changed behavior with no matching change to `selfcheck.mjs` or `sessioncheck.mjs`. Security-relevant
  changes (guard, auth, sessions, commands) need a test that would fail without the fix.

### Project rules
- New dependencies need a reason in the PR description and an exact version (no `^` or `~`), matching `package.json`.
- User-facing changes (new tools, config keys, setup steps) update `README.md` and `config.example.json`.
- `setup-agent.ps1` changes keep `-Uninstall` able to remove everything they add.

## Non-blocking (note, don't block)
- Naming, small refactors, comment wording.
- Style: plain ES modules (`.mjs`), Node built-ins first, short functions, no build step.
- Commit messages: a short imperative subject; a body saying why for anything non-trivial.
