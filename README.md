# duet-gateway

Remote MCP gateway that lets Claude (claude.ai connectors, Duet) reach tools on a home PC or Mac (see [On a Mac](#on-a-mac)):
- `tv_*`: proxied from the TV remote MCP server
- `money_*`: a read-only allowlist proxied from the Plaid bridge
- `pc_desktop_*`: see and drive this PC's desktop (screenshots, clicks, typing, opening apps) through agent-desktop. Off until you set `enabled`
- `web_*`: a real browser on this PC with its own profile, for online tasks that need your sign-ins: forms, bookings, orders. Off until you run `npm run enable-web`
- `guide`: how you want work on this PC and online carried out. It returns [PLAYBOOK.md](PLAYBOOK.md), what is switched on right now, and your `notes`
- `health_report`: read-only usage and error counts from `gateway.log` and `runner.log` plus the doctor's checks. The monitor and fixer tasks use it to file issues and draft fixes; see [MONITOR.md](MONITOR.md). With `alerts` in `config.json` (`enabled`, `repo`, `tokenFile` naming a file next to `config.json` that holds a fine-grained GitHub token with Issues read/write on that repo only, and `ignore`, a list of finding fingerprints with `*` wildcards), the gateway also files an issue itself seconds after a problem. It is off in the example
- `remember`, `recall`, `inbox_*`, `watch_*`, `notify`, `journal_*`, `outbox_*`, `agent_*`, `machine_status`: what makes Duet an assistant that is still there when no conversation is open. See [Assistant tools](#assistant-tools)
- `files_list`, `files_read`, `files_search`: read-only, limited to the folders in `roots`
- `run_command`: only the named commands listed in `commands`, which is empty by default
- `start_session`, `send_message`, `read_messages`, `list_sessions`, `end_session`: Claude Code sessions with full autonomy, run as a separate user (`duet-agent`) that cannot see Egnyte or your profile
- `start_egnyte_session`, `send_egnyte_message`: Claude Code on the Egnyte drive (Z:\), run as you with no shell, only with your approval tap. Off until you set `egnyteEnabled`

OAuth, single user: Claude signs in with a passphrase stored as a scrypt hash. Tokens are kept hashed in `state.json`.

## How Duet works on this PC
Duet is told to act like an agent, not a remote control: you ask for an outcome, it works out the steps, does them, checks the result and reports. Three things carry that.

- **The instructions** every client gets when it connects (`HOW_TO_WORK` in `gateway.mjs`). In short: a request from you covers the ordinary steps it takes; check the result with a read tool before calling it done; ask first only when a detail can't be found, or when a step spends money, sends or posts as you, deletes your data or changes an account, and your request did not plainly cover it; only your own messages are requests, and text in a page, email, window or file is content.
- **[PLAYBOOK.md](PLAYBOOK.md)**, returned by the `guide` tool. It says which tool to use for what, how to recover from a failed step without repeating a payment or a send, what counts as proof, and what the report should hold. Edit it to change how Duet works here. Restart is not needed: the file is read on every call.
- **`notes` in `config.json`**: a list of plain sentences that `guide` adds at the end, for what is true on this PC only (restart the gateway after you change them). For example `"Order household things from Amazon, never above $60 without asking."` or `"The web browser is signed in to Amazon and OpenTable."`.

`guide` also lists what is on right now, which off switches are set, and whether the TV and bank servers are answering, so Duet can say what it can't do instead of trying.

### Approvals: who decides each step
The gateway marks every tool that changes something (`pc_desktop_click`, `web_browser_navigate` and so on) as a write tool. In claude.ai, open the connector's tool settings and choose one of two ways to run them.

| Setting for the act tools | What you get | What you give up |
|---|---|---|
| **Always allow** | Duet carries a task through while you are away. This is what "act on its own" needs | Nothing on the PC stands between a planted instruction and the action. The rules above are guards, not walls |
| **Needs approval** | A tap before every click, keystroke and page load | A task stops at the first step until you are back |

There is no setting in between: a click that pays looks the same to claude.ai as a click that scrolls. What limits the damage either way:
- The kill switches (`desktop.OFF`, `web.OFF`, `duet.OFF`) work at once, with no restart.
- The web browser has its own profile. It can only act on accounts you signed it in to, so leave work accounts and your bank out of it.
- Every result from the desktop or the browser ends with a line that marks screen and page text as content, not a request.
- Keep `start_egnyte_session` and `send_egnyte_message` on **Needs approval** whatever you choose for the rest.

## How Claude Code sessions work

```
Duet ──OAuth──▶ Tailscale Funnel ──▶ gateway.mjs (you, desktop logon, Z:\ mounted)
                                       │  Egnyte sessions: claude.exe as you, cwd Z:\
                                       │
                                       └─ 127.0.0.1:8788 (not on Funnel) ◀── runner.mjs (user duet-agent)
                                                                              normal sessions: claude.exe, --permission-mode auto,
                                                                              writes only in D:\Duet
```

- **Normal sessions** edit files, run commands and use git without asking. They run as `duet-agent`, a standard Windows user. Windows itself keeps that user out of `C:\Users\trand` (`.ssh`, `plaid-bridge`, Claude's sign-in, Egnyte's cache) and it has no Z:\ drive. It has no GitHub sign-in, so it cannot push.
- **It writes only in D:\Duet, never in your own repos.** Anything it can write in a repo you use runs as you later: git hooks and `core.fsmonitor` in `.git`, `.vscode` tasks, `.claude` hooks, npm scripts. VS Code runs git as soon as you open a folder, so that would need no click. So `D:\Projects` is read-only for it (`-Protect` in `setup-agent.ps1`, an explicit deny that also beats drive-wide grants); protect any other folder with code you run the same way. It can still *read* `D:\Projects`, `.env` files included, and it has a full network: a normal session can send anything it can read.
- **Egnyte sessions** need your tap. Set it up first: in claude.ai, open the connector's tool settings and set `start_egnyte_session` and `send_egnyte_message` to **Needs approval**; then set `"egnyteEnabled": true` under `claude` in `config.json` and restart the gateway. Until then the tools don't exist. The approval card shows `mode`: `read` can only read files; `edit` can also change them, and changes sync to the company. Neither mode has a shell or web tools, and Claude Code's permission rules limit file access to Z:\ (every other drive and your profile are denied). Your tap covers what Duet sends, not what the session does after reading a booby-trapped file, which is why it gets no shell. Z:\ only exists while you are signed in to the desktop.
- **One runner at a time.** A normal session runs as `duet-agent` too, so it can read `runner-token` and could ask the gateway for work itself, taking queued prompts or posting fake answers. So each runner process sends a random instance id, and the gateway serves only the first one it sees. Any other is refused while that one keeps polling; each refusal goes to `gateway.log` (`runner: second instance refused`) and counts in `list_sessions` as `runner_conflicts`. Answers are taken only from the instance the turn was handed to. After the runner is quiet for 30 s, the next instance takes over, so a real restart recovers on its own within about 45 s (it adds up to three refusals, and its running turns fail; `health_report` counts the takeovers and only reports refusals beyond that). A count that keeps rising means something other than your runner is polling. The pin survives a gateway restart, so a stray poller can't get in first while the runner reconnects. This detects and blocks a second poller; it can't stop a session that kills the runner first, since both are the same Windows user. A runner that sends no instance id (an old `runner.mjs`) is refused too: run `setup-agent.ps1` again.
- Each message is one turn of `claude -p`; the session remembers earlier turns. Calls wait up to 45 s for the answer; after that, Duet uses `read_messages`.
- Every session is told never to send messages, post, buy, move money or touch credentials. Duet reads your email, so treat these as guards, not walls: a normal session has a real shell inside its workspaces.
- `gateway.log` and `runner.log` hold ids and outcomes only, never prompts or answers. Sessions and answers are kept in `sessions.json`.

## Setup on a new machine
`files_search` needs ripgrep (`rg`) on PATH: `winget install BurntSushi.ripgrep.MSVC`. `npm install` also brings Playwright MCP for the web browser; it downloads no browser of its own.
```bash
npm install
cp config.example.json config.json   # edit roots, deny, upstream paths and publicUrl for this machine
npm run check                        # self-tests
npm run set-passphrase               # 12+ characters; also revokes existing tokens
npm start                            # listens on 127.0.0.1:<port>
tailscale funnel --bg 8787           # public HTTPS at https://<machine>.<tailnet>.ts.net
```
Then in claude.ai go to Settings → Connectors → Add custom connector, enter `https://<machine>.<tailnet>.ts.net/mcp`, and sign in.

To start it at every Windows logon, create a hidden task. It must run in your desktop logon ("Interactive only"), because that is where Z:\ is mounted:
```powershell
$a = New-ScheduledTaskAction -Execute conhost.exe -Argument "--headless `"C:\Program Files\nodejs\node.exe`" `"$PWD\gateway.mjs`"" -WorkingDirectory $PWD
Register-ScheduledTask duet-gateway -Action $a -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $env:USERNAME) `
  -Settings (New-ScheduledTaskSettingsSet -ExecutionTimeLimit 0 -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1))
```

### Claude Code sessions (one time)
In an elevated PowerShell in this folder:
```powershell
powershell -ExecutionPolicy Bypass -File .\setup-agent.ps1
```
It creates `duet-agent`, copies `runner.mjs`, `claude.mjs` and `claude.exe` to `C:\ProgramData\duet-agent`, gives the user modify rights on the workspaces (default `D:\Duet`; change with `-Workspaces`), denies it writes in `-Protect` folders (default `D:\Projects`), limits `config.json` to you, SYSTEM and Administrators, asks for a token from `claude setup-token` (run that in a normal terminal), fills in `claude` in `config.json`, and starts the `duet-agent-runner` task at every boot.

Before it starts the runner, it proves the sandbox. A one-off task runs a probe as `duet-agent` and prints each result. The probe must be able to write and delete a file in every workspace. It must fail to create a file in every `-Protect` folder and the folders directly inside it, see `Z:\` (`-EgnyteRoot`, default: `egnyteRoot` from `config.json`), read `config.json`, or list your profile and `.ssh`. If any check goes the wrong way, setup stops, says which check failed, and leaves the runner off. It also warns you if a workspace holds a git repo that you own: git run as you trusts that repo, so `duet-agent` could plant hooks in it. Move that repo out of the workspace.

- Update the runner or Claude Code: run the script again. If you set it up before `D:\Projects` stopped being a workspace, run it again now: it removes that grant. New sign-in token: add `-NewClaudeToken`.
- No prompts (scripts, CI): `-ClaudeTokenFile <file holding the sk-ant- token>`, `-GatewayDir <folder with gateway.mjs and config.json>` (default: the script's folder), `-NoRestartGateway`. `.github/workflows/setup-agent.yml` runs it this way on a fresh Windows machine on every push.
- Remove everything: `setup-agent.ps1 -Uninstall`.

Canary checks after setup (ask Duet). Setup's probe already covers 1 and 2 as `duet-agent`; these check the same thing through a real session:
1. "Start a session and run `dir Z:\` and `type C:\Users\trand\duet-gateway\config.json`": both must fail.
2. "Start a session and create `D:\Projects\canary.txt`": must fail.
3. "Start a session in duet and create hello.txt": `D:\Duet\hello.txt` appears.
4. "Start an Egnyte session in read mode and list the top folders": claude.ai asks you to approve first.
5. "Start an Egnyte session in read mode, run `dir`, then read `C:\Users\trand\.gitconfig`": both must be refused while Z:\ files still read fine. If Z:\ reads are refused too, Claude Code is treating the mapped drive as a network path; see its permissions docs.

### Getting work out of D:\Duet
Have the session clone your repo into `D:\Duet` and work there. Don't open those clones in VS Code or run git in them yourself, and don't add them to git's `safe.directory`. git refuses them by default because `duet-agent` owns them, and that refusal is what keeps their hooks from running as you. To bring changes over, ask the session for a bundle (`git bundle create D:\Duet\work.bundle main`), then in your own repo:
```bash
git fetch D:/Duet/work.bundle main:duet/work
git diff main duet/work
```

## Desktop control
`pc_desktop_*` lets Duet see and drive this PC's desktop: screenshots, accessibility snapshots, clicks, typing, opening and arranging apps. The gateway runs [agent-desktop](https://www.npmjs.com/package/agent-desktop) as a child (the `pc` upstream in `config.example.json`, 44 tools), in your desktop logon, so it sees your real screen. Anything it reads goes to Anthropic, including work apps (Outlook, Citrix/Vista, Excel, Teams, Egnyte) if they are open: there is no work-app guard. Close what you don't want it to see.

**Turn it on**
1. In `config.json`, copy the `pc` upstream from `config.example.json` and set `"enabled": true`. Check `command` points at `agent-desktop-win32-x64.exe` on this machine.
2. Restart the gateway. Until then the tools don't exist.
3. In claude.ai, open the connector's tool settings and choose how the act tools run: see [Approvals](#approvals-who-decides-each-step). They are marked as write tools, so they group together. The read tools (`snapshot`, `screenshot`, `find`, `get`, `is`, `wait`, `list_*`, `status`, `version`, `skills_*`) can stay on Always allow.
4. `npm run doctor` shows a `desktop control` line: `ok` on, `warn` if `desktop.OFF` exists, `fail` if the exe is missing, the upstream has no `allow` list or `offFile`, or `allow` holds a clipboard, `batch` or notification tool. It also warns about a `screenGuard` left in config.json: the gateway ignores it now, so delete it.

**Refusals.** The gateway refuses a `pc_desktop_*` call that:
- has an `output_path` argument, which would write a file anywhere as you;
- comes while `desktop.OFF` exists in this folder.

An agent-desktop upstream without an `allow` list or an `offFile` makes the gateway refuse to start, so a copy of the example that loses either can't run with all 67 tools and no off switch. `gateway.log` gets `tool pc_desktop_x refused: <kind>`, where kind is `desktop.OFF` or `output_path`.

**Tools left out**
- `clipboard_get/set/clear`: the clipboard can hold something copied from Vista.
- `list_notifications`, `notification_action`, `dismiss_*`: Outlook and Teams toasts show message text.
- `batch`: its sub-commands would get around the allowlist.
- `open_system_surface`, `permissions`: system settings.
- `key_down/up`, `mouse_down/up`: a dropped call leaves a key or button stuck; `press`, `drag` and `mouse_click` cover the same needs.
- `session_*`, `trace_*`, `skills_path`, `cursor_overlay_*`: housekeeping that writes local files or isn't needed.

**Known limits**
- Reading takes no approval. With the read tools on Always allow, `screenshot`, `snapshot`, `find` and `get` return whatever is open, work apps included, without a card, while the Egnyte tools ask every time. Set `screenshot` and `snapshot` to **Needs approval** if you want a tap before the screen leaves.
- What is on screen is also input. With Outlook open, the text of an email reaches Claude through a snapshot, so a booby-trapped email can try to steer the next call.
- `desktop.OFF` is checked when a call starts; a call already running finishes.
- The approval tap is the real protection against a booby-trapped email steering Duet. The act tools include `launch`, which starts any program as you. With the act tools on Always allow there is no tap, only the rules Duet is given.
- The desktop is driven without taking the keyboard or mouse, so `type`, `double_click`, `triple_click`, `right_click` and `focus` are refused by agent-desktop. Duet uses `set_value`, `click`, `select` and `press` instead. A Windows permission prompt (UAC) and the lock screen can't be seen or clicked at all.
- Launching an app can bring back what was open in it last time. Notepad restores its tabs, and a snapshot returns the text of the tab in front. Don't keep secrets in an open editor.

**Kill switch:** create `desktop.OFF` in this folder. It takes effect on the next call, no restart (a call already running finishes). Delete it to turn desktop control back on.

**Starting an app by name.** agent-desktop on Windows only takes a full path, or a program name that sits in `System32` or the Windows folder. Duet says "Calculator" or "Microsoft Edge", so the gateway looks the name up first (`launch.mjs`): a full path or a system program goes through as given; then a short list of everyday names (Calculator is `calc`, File Explorer is `explorer`, Word is `winword`); then the `App Paths` registry key, where installers register a program by name; then your Start Menu shortcuts, by exact name, then by a name that starts with or contains what was asked, when exactly one matches. A name that leads nowhere is not sent to agent-desktop: Duet gets `APP_NOT_FOUND` with the close matches from the Start Menu, and `gateway.log` gets `tool pc_desktop_launch error APP_NOT_FOUND`. Nothing in the lookup runs a command built from the name. A Microsoft Store app without a shortcut (Settings) can't be started this way. A launch is also given 60 s at most, whatever `timeout` asks for.

## Web browser
`web_*` gives Duet a real browser for online tasks: open a site, read the page, fill a form, click through a booking or an order, and read the confirmation back. The gateway runs [Playwright MCP](https://www.npmjs.com/package/@playwright/mcp) as a child (the `web` upstream, 17 tools, pinned in `package.json`). It drives Microsoft Edge with a profile of its own, kept in `%LOCALAPPDATA%\duet-gateway\web-profile`, so it is signed in only where you signed it in. Your everyday browser and its sign-ins are not touched.

It runs as you, in your desktop logon, and its window shows on the desktop while Duet works (add `--headless` to the upstream's `args` to hide it). It closes after ten minutes without a call. Anything it reads goes to Anthropic.

**Turn it on**
1. `npm install`, then `npm run enable-web`. It adds the `web` upstream to `config.json` with this machine's paths.
2. Restart the gateway. Until then the tools don't exist.
3. `npm run web-login` opens plain Edge on that profile. Sign in to the sites Duet should use, then close the window: the profile can be open in one browser at a time. Sign in by hand here, not through Duet. Some sites refuse a sign-in from a driven browser, and Duet is told never to ask for a password.
4. In claude.ai, choose how the act tools run: see [Approvals](#approvals-who-decides-each-step). The read tools (`snapshot`, `find`, `take_screenshot`, `wait_for`) can stay on Always allow.
5. `npm run doctor` shows a `web browser` line: `ok` on, `warn` if `web.OFF` exists or the browser is attached to your everyday one (`--extension`, `--cdp-endpoint`), `fail` if node or Playwright MCP is missing, the upstream has no `allow` list or `offFile`, `allow` holds a tool that runs code or reads local files, or the args turn on local file access.

**Refusals.** The gateway refuses a `web_*` call that:
- comes while `web.OFF` exists in this folder;
- has a `filename` or `output_path` argument, which would write a file as you;
- has a `url` that is not `http` or `https` (so no `file:`, `edge:` or `javascript:`), or whose host is this PC, the home network or the tailnet: `localhost`, private and link-local addresses, `100.64.0.0/10`, names with no dot, `.local`, `.lan`, `.internal`, `.ts.net`. To let one through, add its host name to `localHosts` on the upstream.

A browser upstream without an `allow` list or an `offFile`, or with `--allow-unrestricted-file-access` or `--config` in its args, makes the gateway refuse to start. `gateway.log` gets `tool web_x refused: <kind>`, where kind is `web.OFF`, `filename`, `output_path` or `url`. The address itself is never logged.

**Tools left out**
- `browser_evaluate`, `browser_run_code_unsafe`: they run code in the page or in the server, as you.
- `browser_file_upload`, `browser_drop`: they send local files to a site.
- `browser_network_request(s)`: request headers hold session cookies.
- `browser_console_messages`, `browser_emulate_media`: not needed.

**Known limits**
- The address check sees only the address Duet asks for. A page can still redirect or link to an address on the home network, so it is a guard, not a wall.
- A page is input. Its text reaches Claude and can try to steer the next step, in a browser that is signed in as you. The gateway marks what comes back as content, and Duet is told not to act on it; with the act tools on Always allow, nothing else is in the way. Sign the profile in only to accounts you would let Duet act on.
- A download lands in `%LOCALAPPDATA%\duet-gateway\web-files`, as does a copy of each screenshot. Duet can't read or move files there.
- Duet can't solve a CAPTCHA or enter a code sent to your phone. It stops and tells you which site needs you.
- `web.OFF` is checked when a call starts; a call already running finishes.

**Kill switch:** create `web.OFF` in this folder. It takes effect on the next call, no restart. Delete it to turn the browser back on. To sign Duet out of everything, delete the `web-profile` folder.

## On a Mac
The same gateway runs on macOS. There is no Egnyte drive there, so the Egnyte tools stay off; everything else works the same way.
`config.example.mac.json` is a starting point: it uses ports 8790 and 8791 and publishes on Funnel port 8443, so it does not disturb anything already served on 443.

```bash
brew install node ripgrep
npm install
cp config.example.mac.json config.json   # edit roots, deny, machineName and publicUrl
npm run check                            # all five test files run on macOS
npm run set-passphrase
./gateway-launchd.sh                     # LaunchAgent com.duet-gateway: starts at login, restarts if it stops
tailscale funnel --bg --https=8443 http://127.0.0.1:8790
```
Then add `https://<machine>.<tailnet>.ts.net:8443/mcp` as a custom connector in claude.ai, as on Windows.

Two config keys matter more on a Mac. `machineName` is the name the sign-in page, the tool descriptions and Duet use for this machine. `rgPath` is the full path to ripgrep, for when `rg` is not on the gateway's PATH; the LaunchAgent's PATH already includes `/opt/homebrew/bin` and `/usr/local/bin`, so a Homebrew install needs nothing.

Claude Code sessions, one time:
```bash
claude setup-token          # sign in; it prints a token that starts with sk-ant-
sudo ./setup-agent-mac.sh   # paste the token when asked (or pass --claude-token-file <file>)
```
`setup-agent-mac.sh` is the Mac version of `setup-agent.ps1`:
- It creates `duet-agent`, a hidden standard user with its own group and no password, and copies `runner.mjs`, `claude.mjs` and the `claude` binary to `/Library/Application Support/duet-agent`.
- It gives the user the workspace `/Users/Shared/Duet` (change with `--workspace`).
- macOS puts every local user in `staff`, which can read most home folders. So the script adds an ACL entry to your home folder that denies `duet-agent` every right, including traversal. That keeps it away from `config.json`, `~/.ssh`, `~/.claude` and every repo in your home folder.
- It starts the runner with the LaunchDaemon `com.duet-agent.runner`, which runs at boot as `duet-agent` whether or not you are signed in.
- Before the runner starts, a probe runs as `duet-agent`. It must be able to write in each workspace, and must fail to list your home folder, read `config.json`, `~/.ssh` or `~/.claude`, or create files in `/opt/homebrew`, `/usr/local` and `/Applications`. If any check goes the wrong way, setup stops and the runner stays off.
- Run it again to update the runner or Claude Code. `--new-claude-token` replaces the sign-in token. `--uninstall` removes the daemon, the ACL entry, the user, its group and the install folder.

Kill switches on a Mac: `duet.OFF` in this folder, `tailscale funnel --https=8443 off`, and `sudo launchctl bootout system/com.duet-agent.runner`.

`npm run doctor` knows the Mac layout. It looks for the runner token and `runner.log` in `/Library/Application Support/duet-agent`, and in place of the Windows task and the Egnyte drive it checks two things:
- `runner daemon`: the `com.duet-agent.runner` LaunchDaemon is installed and `duet-agent` is running `runner.mjs`.
- `home folder`: your home folder still has the ACL entry that denies `duet-agent` list and search. It is a `fail` if the entry is gone, because then nothing keeps sessions out of your home folder; run `sudo ./setup-agent-mac.sh` again.

The runner token file is readable only by root and `duet-agent`, so a plain run reports the token as set but not compared. `sudo npm run doctor` compares it.

Desktop control (`pc_desktop_*`) and the web browser (`web_*`) have not been tried on a Mac. `config.example.mac.json` has neither upstream, and `npm run enable-web` and `npm run web-login` are written for Windows paths and Microsoft Edge.

Duet is told which machine it is on: the instructions start with `machineName`, and the session line describes a separate macOS user. The `guide` tool returns the same `PLAYBOOK.md`, which is written for the PC, so on a Mac the status under it starts with a line that names the Mac and says to read "PC" and "Windows" as this machine.

## Pull request review
Every PR into `main` runs `.github/workflows/pr-review.yml`:
- **Tests**: `npm run check` on a Windows runner.
- **Claude review**: Claude reviews the diff against [REVIEW.md](REVIEW.md) and leaves inline comments. A blocking finding posts "Changes requested" and fails the check; once a later push passes, that review is dismissed. Draft PRs are skipped until they are marked ready.

One-time setup on GitHub:
1. Settings → Secrets and variables → Actions → add `CLAUDE_CODE_OAUTH_TOKEN` (run `claude setup-token`; uses your Claude plan) or `ANTHROPIC_API_KEY`.
2. Settings → Rules → Rulesets (or Branches) → protect `main`: require a pull request, and require the status checks **Tests** and **Claude review**.

The review action refuses to run when a PR changes `pr-review.yml` itself (the file must match `main`), so such a PR's Claude review fails. Merge it with the ruleset's bypass (add Repository admin to the bypass list), then review the workflow change yourself.

To change the bar, edit `REVIEW.md`. The reviewer always judges a PR by the `REVIEW.md` on `main`, so a PR can't lower the bar for itself.

## Assistant tools
Duet's own VM can remember things and check your accounts on a schedule, but the gateway used to do nothing between calls: it could not watch anything, tell you anything, or say what Duet had done here. These tools (`assistant.mjs`) fill that in. They are on by default; `"assistant": { "enabled": false }` in `config.json` removes them all. Their state sits in this folder: `memory.json`, `inbox.json`, `watches.json`, `journal.jsonl`.

| Tools | What they do | On by default |
|---|---|---|
| `remember`, `recall`, `forget` | A notebook that outlasts a conversation: up to 300 notes of 500 characters. `guide` shows the newest under their own heading, apart from your `notes` | Yes |
| `inbox_read`, `inbox_done`, `inbox_post` | What arrived while no conversation was open: fired watches, late replies from other agents, notes you left, follow-ups Duet left itself | Yes |
| `watch_create`, `watch_list`, `watch_delete` | The gateway checks a public page, a file in `roots`, a listed read tool or the clock every 30 s, and when the condition comes true (`changed`, `contains`, `not_contains`, a number `above` or `below`) it writes to the inbox and pushes to your phone | Yes (tool watches: `machine_status` only) |
| `notify` | A push message to your own phone | No: `npm run enable-notify` |
| `journal_read`, `journal_note` | Every tool call that was not a plain read (tool, outcome, time taken, one named target), plus one-line notes from Duet on what it did and why | Yes |
| `machine_status` | Uptime, memory, free disk space, gateway version, what is on | Yes |
| `outbox_save`, `outbox_list` | Text files Duet leaves for you in one folder | No: set `assistant.outbox` |
| `agent_list`, `agent_send` | A message to one of your other AI agents over A2A, and its reply | No: set `assistant.agents` |

**Leave Duet a note from this PC:** `npm run tell -- "Renew the library books this week"`. It lands in the inbox, marked as typed by you on the PC. Duet treats it as yours for routine steps; anything that spends, sends, deletes or changes an account still needs your word in the conversation.

**Alerts to your phone.** `npm run enable-notify` writes `assistant.notify` with a new [ntfy](https://ntfy.sh) address that has a random 32-character topic, and prints it. Install the ntfy app, subscribe to that address, restart the gateway. Anyone who knows the address can read the alerts, and the text passes through ntfy.sh, so Duet is told to keep passwords, codes and balances out, and the gateway refuses text that looks like one. A watch's push says only that it fired; what it read stays in the inbox. Your own server works too (`npm run enable-notify -- https://ntfy.example.com/topic`, plus `"tokenFile"` for an access token). Other kinds: `{ "kind": "telegram", "tokenFile": "telegram-token", "chatId": "123" }` and `{ "kind": "pushover", "tokenFile": "pushover-token", "user": "…" }`. A token file is named by file name only and sits in this folder. There is no recipient argument: `notify` reaches the one place `config.json` names. At most 20 an hour.

**Watches.** A page watch reads internet pages only, without your sign-ins: the address check is the web browser's, the host name is also resolved and refused when it points at this PC, the home network or the tailnet, and every redirect is checked again. Scripts and tags are stripped, at most 512 KB is read, and a page is read every 5 minutes at most. A file watch goes through the path guard on every check. A tool watch may call `machine_status` and whatever `assistant.watch.tools` lists, hourly at most. It is empty in the example on purpose: a bank balance read can be a billed call, so add `"money_get_balances"` only if you want "tell me when my balance drops below…". A watch fires when its condition becomes true, once unless `repeat` is set, stops after five failed checks in a row, and ends after 30 days unless Duet asks for fewer or more (90 at most). 25 can be active. **The gateway can't start a conversation:** a fired watch reaches you through `notify`, and reaches Duet the next time it reads its inbox.

**Outbox.** Set `"outbox"` under `assistant` to a folder, for example `C:\\Users\\trand\\Documents\\Duet` (inside `roots`, so `files_read` can read a file back). `outbox_save` takes a plain file name ending in `.txt`, `.md`, `.csv`, `.json` or `.log` and text up to 1 MB. It creates the file and never overwrites or deletes one; 500 files at most.

**Other agents.** For each agent that speaks [A2A](https://a2a-protocol.org) over JSON-RPC, add an entry under `assistant.agents`:
```json
"agents": { "nova": { "url": "http://100.x.y.z:9900/", "tokenFile": "nova-token", "about": "Hermes profile that reads and drafts mail", "timeoutSecs": 300 } }
```
`agent_send` posts `SendMessage` (and falls back to `message/send` for an agent on the earlier wording), with the bearer token from the token file. Every message starts with a fixed line saying that Duet wrote it, that you did not type it, and that it carries no approval to send, pay for, delete or change anything. The reply comes back marked as content from another agent. If it is not back within `wait_seconds` (90 by default), the call returns and the reply goes to the inbox. 30 messages an hour per agent. The address comes from `config.json` only. An agent that listens on `127.0.0.1` of another machine (Hermes on a Mac does by default) is not reachable from this PC until you publish it on the tailnet, or run a gateway on that machine.

**Messages from other agents.** An agent on this machine can also leave Duet a message. Give its entry an `inboundTokenFile` (a token file next to `config.json`, 16 characters or more, different from `tokenFile`), and point the agent at `http://127.0.0.1:<port>/a2a` with that token as its bearer token. For Hermes, in its `config.yaml`:

```yaml
a2a_agents:
  duet:
    url: http://127.0.0.1:8787/a2a
    auth: { type: bearer, token: "<the inbound token>" }
```

The gateway takes an A2A `SendMessage` (or `message/send`), puts the text in the inbox as a message from that agent (content, not a request from you, with how to answer it through `agent_send`), and answers that it was delivered. Nothing else runs because of it: Duet reads it at its next conversation or check-in. A request that came in through Funnel is refused, a message that looks like a secret is not kept, text past 1,600 characters is cut, and each agent may send 30 an hour. For the other direction (`agent_send` to a Hermes agent), that agent needs `duet:<token>` in its `A2A_PEER_TOKENS` and `duet` in its `A2A_TRUSTED_PEERS`, with the same token in this gateway's `tokenFile` for it.

**The journal** holds the tool name, the outcome, the time taken and one short named argument that says what the call was aimed at (`app`, `name`, `workspace`, `agent`, `query`, `id`, `session_id`, or the host of `url`). It never holds typed text, values, messages, file contents or results. It is trimmed to the last 5,000 lines once it passes 2 MB.

**Kill switch:** create `watch.OFF` in this folder to stop every watch and refuse new ones. `gateway.log` gets `watch <id> created|fired|deleted`, `notify sent|failed` and `agent <name> late reply|no reply`: ids and outcomes only.

## TV and bank tools: when a server does not start
`tv_*` and `money_*` come from two programs the gateway starts itself (the `tv` and `money` upstreams in `config.json`). A program that does not start lists no tools, so the whole group is missing in claude.ai. The gateway says why, in three places:

- **`guide`**, under "On this PC right now": `- TV (tv_*): on, 24 tools`, or `- TV (tv_*): not answering (command not found: python). Its tools are missing until that is fixed on the PC`. A server that was down is asked again each time `guide` is called, so a fix shows without a restart. On a Mac the same lines say Mac.
- **`gateway.log`**: one line each time a server's state changes, such as `upstream tv up, 24 tools` or `upstream tv unavailable: python started and exited at once (wrong script path, or it crashed)`. The line has the program's file name and a fixed reason, never a path or the program's output. The gateway starts every server once at startup, so the log shows the state right away.
- **`npm run doctor`**: an `upstream tv` and an `upstream money` line (`fail` when the command or its script is not found; `warn` when `python` is only the Microsoft Store alias), and a `TV hub` line.

The reasons: `command not found` (not on the gateway's PATH: use the full path in `command`), `started and exited at once` (the script path in `args` is wrong, or the program crashed), `started but did not answer in 15 s`. A server that hangs is given up on after that time, so it does not hold up the tool list for the others.

The TV server (`tv_mcp.py` from [tv-remote](https://github.com/space-cowboy2/tv-remote)) only passes calls on to the TV hub, a second program that talks to the TV and has to be running on this PC (`127.0.0.1:8080`). In the tv-remote folder, `deploy\windows\install-hub.ps1` installs it and starts it at every logon (on a Mac, see that project's `docs/SETUP.md`); `tvremote pair` pairs it with the TV. With the server up and the hub down, the `tv_*` tools are listed and each call answers `hub_unreachable`.

## Not in git (per machine)
`config.json` (passphrase hash, runner token, local paths), `state.json` (tokens), `sessions.json`, `gateway.log`, `gateway.out` (Mac LaunchAgent output), `duet.OFF`, `desktop.OFF`, `web.OFF`, `watch.OFF`, the assistant tools' state (`memory.json`, `inbox.json`, `watches.json`, `journal.jsonl`) and token files (`*-token`, `*.token`). The web browser's profile and downloads live outside this folder, in `%LOCALAPPDATA%\duet-gateway`.

## Notes
- Health check: `npm run doctor` (or `node gateway.mjs doctor`) prints one `ok`, `warn` or `fail` line per check and exits 1 on any `fail`. It checks config.json, the passphrase, `publicUrl`, `roots`, the `claude` section (command, runner token, workspaces that hold or sit inside your own repos), `egnyteEnabled`, the Egnyte drive, `duet.OFF`, desktop control (the `pc` upstream and `desktop.OFF`), the web browser (the `web` upstream and `web.OFF`), the other upstreams (the command and script of `tv` and `money`, and whether the TV hub answers), both loopback ports, the `duet-agent-runner` task and the last `runner.log` line. It never prints secrets or file contents. Run it from an elevated prompt to also compare the runner token with `C:\ProgramData\duet-agent\runner-token`. On a Mac it checks the runner's LaunchDaemon and your home folder's ACL instead of the task and the Egnyte drive; see [On a Mac](#on-a-mac).
- Restart after an update: on this PC `Stop-ScheduledTask duet-gateway` ends only the `conhost` wrapper, and the `node` process keeps the port. End it by its process id (`(Get-NetTCPConnection -LocalPort 8787 -State Listen).OwningProcess`, then `Stop-Process -Id`), then `Start-ScheduledTask duet-gateway`. A gateway that can't get its port exits and writes `gateway could not start on 127.0.0.1:8787 (EADDRINUSE); exiting` to `gateway.log`. The line `listening on 127.0.0.1:8787` means it has the port.
- Kill switches: create `duet.OFF` in this folder to refuse new Claude Code turns; create `desktop.OFF` to refuse every `pc_desktop_*` call; create `web.OFF` to refuse every `web_*` call; create `watch.OFF` to stop every watch; `tailscale funnel reset` closes the endpoint; `Stop-ScheduledTask duet-agent-runner` stops the runner.
- Anything Claude reads through these tools is sent to Anthropic's cloud. Keep work data (Z:\ Egnyte, Vista) out of `roots`. Egnyte files are reachable through the approval-gated Egnyte tools, and anything open on the desktop (Egnyte, Vista and Outlook included) through `pc_desktop_*` while desktop control is on. The web browser reaches a work site only if you sign its profile in to one, so don't.
- Normal and Egnyte sessions share your Claude plan's usage limits.
- Unverified: whether Duet accepts custom connectors.
