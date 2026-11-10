#!/bin/bash
# setup-agent-mac.sh: one-time macOS setup for Duet's normal (full-autonomy) Claude Code sessions.
# The Mac version of setup-agent.ps1. It makes a hidden macOS user, "duet-agent", that cannot see your home
# folder, and starts runner.mjs as that user at every boot with a LaunchDaemon. Run it from the duet-gateway folder:
#   sudo ./setup-agent-mac.sh --claude-token-file <file holding the token from `claude setup-token`>
# Run it again to update the runner or Claude Code.
# The workspace is where duet-agent may write. Keep your own repos out of it: git hooks, .git/config, .vscode and
# .claude settings in a repo all run as you the next time you or your editor open it.
# Your home folder gets an ACL that denies duet-agent everything (list, read, traverse, write), so it also cannot
# reach config.json, ~/.ssh, ~/.claude or any repo in your home folder. macOS puts every local user in "staff",
# which can read most home folders; the ACL is what keeps duet-agent out.
# Before the runner starts, a probe running as duet-agent proves the sandbox: it must be able to write in the
# workspace, and must fail to list your home folder, read config.json or ~/.ssh, or write in /opt/homebrew and
# /Applications. If anything is off, setup stops and the runner stays off.
#
# Options:
#   --workspace <dir>          where sessions work (default /Users/Shared/Duet); repeat for more than one
#   --claude-token-file <file> the sk-ant- token from `claude setup-token`; without it you are asked (hidden input)
#   --new-claude-token         replace the saved token
#   --no-claude-token          set up everything without a token (for setting up remotely); sessions report that
#                              Claude Code is signed out until you run this again with --new-claude-token
#   --gateway-dir <dir>        folder with gateway.mjs and config.json (default: this script's folder)
#   --no-restart-gateway       don't restart the com.duet-gateway LaunchAgent afterwards
#   --uninstall                remove the daemon, the ACL, the user, its group and the install folder
set -euo pipefail

USER_NAME="duet-agent"
LABEL="com.duet-agent.runner"
BASE="/Library/Application Support/duet-agent"
PLIST="/Library/LaunchDaemons/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORKSPACES=()
GATEWAY_DIR="$HERE"
CLAUDE_TOKEN_FILE=""
NEW_TOKEN=0
NO_TOKEN=0
RESTART_GATEWAY=1
UNINSTALL=0

while [ $# -gt 0 ]; do
  case "$1" in
    --workspace) WORKSPACES+=("${2%/}"); shift 2 ;;
    --claude-token-file) CLAUDE_TOKEN_FILE="$2"; shift 2 ;;
    --new-claude-token) NEW_TOKEN=1; shift ;;
    --no-claude-token) NO_TOKEN=1; shift ;;
    --gateway-dir) GATEWAY_DIR="$(cd "$2" && pwd)"; shift 2 ;;
    --no-restart-gateway) RESTART_GATEWAY=0; shift ;;
    --uninstall) UNINSTALL=1; shift ;;
    *) echo "Unknown option: $1" >&2; exit 2 ;;
  esac
done
[ ${#WORKSPACES[@]} -gt 0 ] || WORKSPACES=("/Users/Shared/Duet")

step() { printf '\033[36m-> %s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname)" = "Darwin" ] || die "This script is for macOS. On Windows use setup-agent.ps1."
[ "$(id -u)" = 0 ] || die "Run it with sudo: sudo $0 $*"
OWNER="${SUDO_USER:-}"
[ -n "$OWNER" ] && [ "$OWNER" != root ] || die "Run it with sudo from your own account, so it knows whose home folder to protect."
OWNER_UID="$(id -u "$OWNER")"
OWNER_HOME="$(dscl . -read "/Users/$OWNER" NFSHomeDirectory | awk '{print $2}')"
[ -d "$OWNER_HOME" ] || die "Could not find $OWNER's home folder."
# The exact ACL entry, so --uninstall can remove the same one. No inheritance is needed: without "search" on the
# home folder, nothing inside it can be reached by path.
HOME_DENY="user:$USER_NAME deny list,search,add_file,add_subdirectory,delete_child,readattr,writeattr,readextattr,writeextattr,readsecurity"
as_owner() { sudo -u "$OWNER" -H "$@"; }

if [ "$UNINSTALL" = 1 ]; then
  step "Removing $LABEL, the ACL on $OWNER_HOME, user $USER_NAME and $BASE"
  launchctl bootout "system/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  pkill -u "$USER_NAME" 2>/dev/null || true
  chmod -a "$HOME_DENY" "$OWNER_HOME" 2>/dev/null || true
  for w in "${WORKSPACES[@]}"; do [ -d "$w" ] && chown -R "$OWNER" "$w" 2>/dev/null || true; done
  dscl . -delete "/Users/$USER_NAME" 2>/dev/null || true
  dscl . -delete "/Groups/$USER_NAME" 2>/dev/null || true
  rm -rf "$BASE"
  echo "Done. /Users/$USER_NAME (its home) and the workspaces are left in place; they now belong to $OWNER."
  exit 0
fi

NODE="$(as_owner zsh -lc 'command -v node' 2>/dev/null || true)"
[ -x "$NODE" ] || NODE=/opt/homebrew/bin/node
[ -x "$NODE" ] || die "Node.js was not found."
CLAUDE_LINK="$OWNER_HOME/.local/bin/claude"
[ -x "$CLAUDE_LINK" ] || CLAUDE_LINK="$(as_owner zsh -lc 'whence -p claude' 2>/dev/null || true)"
CLAUDE_REAL="$(/usr/bin/python3 -c 'import os,sys;print(os.path.realpath(sys.argv[1]))' "$CLAUDE_LINK")"
[ -x "$CLAUDE_REAL" ] || die "Claude Code was not found at $CLAUDE_LINK."
CONFIG="$GATEWAY_DIR/config.json"
[ -f "$CONFIG" ] || die "No config.json in $GATEWAY_DIR. Copy config.example.json to config.json first, or pass --gateway-dir."
for w in "${WORKSPACES[@]}"; do
  case "$w/" in "$OWNER_HOME"/*) die "Workspace $w is inside $OWNER_HOME, which duet-agent may not see." ;; /*) ;; *) die "Workspace $w is not an absolute path." ;; esac
done
if [ -n "$CLAUDE_TOKEN_FILE" ] && [ ! -f "$CLAUDE_TOKEN_FILE" ]; then die "No token file at $CLAUDE_TOKEN_FILE."; fi

# 1. The user and its own group, hidden from the login window, with no password (it cannot log in).
if id "$USER_NAME" >/dev/null 2>&1; then
  step "Updating user $USER_NAME"
  AGENT_UID="$(id -u "$USER_NAME")"
else
  AGENT_UID=""
  for n in $(seq 450 499); do
    if ! dscl . -search /Users UniqueID "$n" | grep -q . && ! dscl . -search /Groups PrimaryGroupID "$n" | grep -q .; then AGENT_UID="$n"; break; fi
  done
  [ -n "$AGENT_UID" ] || die "No free user id between 450 and 499."
  step "Creating user $USER_NAME (uid $AGENT_UID, standard, hidden, cannot log in)"
  dscl . -create "/Groups/$USER_NAME"
  dscl . -create "/Groups/$USER_NAME" PrimaryGroupID "$AGENT_UID"
  dscl . -create "/Groups/$USER_NAME" RealName "Duet agent"
  dscl . -create "/Users/$USER_NAME"
  dscl . -create "/Users/$USER_NAME" UniqueID "$AGENT_UID"
  dscl . -create "/Users/$USER_NAME" PrimaryGroupID "$AGENT_UID"
  dscl . -create "/Users/$USER_NAME" RealName "Duet agent"
  dscl . -create "/Users/$USER_NAME" NFSHomeDirectory "/Users/$USER_NAME"
  dscl . -create "/Users/$USER_NAME" UserShell /bin/zsh
  dscl . -create "/Users/$USER_NAME" Password "*"
  dscl . -create "/Users/$USER_NAME" IsHidden 1
fi
AGENT_GID="$(id -g "$USER_NAME")"
if dsmemberutil checkmembership -U "$USER_NAME" -G admin | grep -q "is a member"; then
  dseditgroup -o edit -d "$USER_NAME" -t user admin
fi
mkdir -p "/Users/$USER_NAME"
chown "$USER_NAME:$AGENT_GID" "/Users/$USER_NAME"
chmod 700 "/Users/$USER_NAME"

# 2. Keep it out of your home folder. Deny entries come first in the ACL, ahead of any allow.
step "Denying $USER_NAME all access to $OWNER_HOME"
chmod -a "$HOME_DENY" "$OWNER_HOME" 2>/dev/null || true
chmod +a# 0 "$HOME_DENY" "$OWNER_HOME"
chmod 600 "$CONFIG"

# 3. Its folder: root writes, duet-agent only reads (except logs).
step "Installing runner and Claude Code in $BASE"
launchctl bootout "system/$LABEL" 2>/dev/null || true
pkill -u "$USER_NAME" 2>/dev/null || true
mkdir -p "$BASE/bin" "$BASE/logs"
chown root:wheel "$BASE" "$BASE/bin"
chmod 755 "$BASE" "$BASE/bin"
chown "$USER_NAME:$AGENT_GID" "$BASE/logs"
chmod 755 "$BASE/logs"   # ids and outcomes only, so you can read them without sudo
install -o root -g wheel -m 644 "$HERE/runner.mjs" "$HERE/claude.mjs" "$BASE/bin/"
install -o root -g wheel -m 755 "$CLAUDE_REAL" "$BASE/bin/claude"
# From /, since duet-agent cannot see the folder you run this script from.
V="$(cd / && sudo -u "$USER_NAME" -H "$BASE/bin/claude" --version 2>&1)" || die "The copied claude does not run as $USER_NAME: $V"
echo "   Claude Code $V"

# 4. Tokens. The runner token lets the runner ask the gateway for work on 127.0.0.1 only.
umask 077
if [ ! -s "$BASE/runner-token" ]; then
  /usr/bin/python3 -c 'import secrets;print(secrets.token_urlsafe(32))' > "$BASE/runner-token"
fi
CT="$BASE/claude-token"
if [ "$NO_TOKEN" = 1 ] && [ -z "$CLAUDE_TOKEN_FILE" ] && [ "$NEW_TOKEN" = 0 ]; then
  [ -s "$CT" ] || echo "   no Claude Code token yet: sessions will report that Claude Code is signed out" >&2
elif [ -n "$CLAUDE_TOKEN_FILE" ] || [ "$NEW_TOKEN" = 1 ] || [ ! -s "$CT" ]; then
  if [ -n "$CLAUDE_TOKEN_FILE" ]; then
    TOKEN="$(tr -d '[:space:]' < "$CLAUDE_TOKEN_FILE")"
  else
    [ -t 0 ] || die "duet-agent needs its own Claude Code sign-in. Run \`claude setup-token\`, save the token in a file and pass --claude-token-file <file>."
    echo
    printf '\033[33mduet-agent needs its own Claude Code sign-in. In another terminal run:\n    claude setup-token\nand paste the token it prints (it starts with sk-ant-) here. It is not shown or logged.\033[0m\n'
    read -rs -p "Token: " TOKEN; echo
  fi
  case "$TOKEN" in sk-ant-*) ;; *) die "That does not look like a Claude Code token (sk-ant-...). Nothing was saved." ;; esac
  printf '%s' "$TOKEN" > "$CT"
  TOKEN=""
fi
chown "root:$AGENT_GID" "$BASE/runner-token"
chmod 640 "$BASE/runner-token"
if [ -f "$CT" ]; then chown "root:$AGENT_GID" "$CT"; chmod 640 "$CT"; fi
umask 022

# 5. Workspaces it may change. It owns them; you can read them.
WS=()
for w in "${WORKSPACES[@]}"; do
  step "Giving $USER_NAME its workspace $w"
  mkdir -p "$w"
  chown -R "$USER_NAME:$AGENT_GID" "$w"
  chmod 755 "$w"
  WS+=("$w")
  # git run as you trusts repos you own, so their hooks and config would run as you.
  while IFS= read -r g; do
    if [ "$(stat -f %u "$g")" = "$OWNER_UID" ]; then
      echo "   warning: $g is owned by you, so git trusts it when you run it. Move that repo out of $w." >&2
    fi
  done < <(find "$w" -maxdepth 4 -name .git 2>/dev/null)
done

# 6. Prove the sandbox: run a probe as duet-agent. If it can't do what it should, or can do what it shouldn't, stop.
step "Checking what $USER_NAME can and cannot do"
PROBE="$BASE/bin/probe.mjs"
cat > "$PROBE" <<'EOF'
// probe.mjs: setup-agent-mac.sh runs this once as duet-agent. Input and output are JSON on stdin and stdout.
import fs from "node:fs";
import { execFileSync } from "node:child_process";
let input = ""; for await (const c of process.stdin) input += c;
const inp = JSON.parse(input), checks = [];
const add = (id, name, pass, detail = "") => checks.push({ id, name, pass: !!pass, detail });
// Only a permission error counts as denied; any other error fails the check.
function access(id, name, want, act) {
  let got = "works", why = "";
  try { act(); } catch (e) { got = e.code === "EACCES" || e.code === "EPERM" ? "denied" : "error"; why = e.code || e.message; }
  add(id, name, got === want, `${got} ${why}`.trim());
}
const groups = execFileSync("/usr/bin/id", ["-Gn"], { encoding: "utf8" }).trim().split(/\s+/);
add("notadmin", "not an administrator", !groups.includes("admin"), groups.join(" "));
for (const w of inp.workspaces) {
  const f = `${w}/.duet-probe-${inp.tag}`;
  access(`workspace:${w}`, `write and delete a file in ${w}`, "works", () => { fs.writeFileSync(f, "probe"); fs.unlinkSync(f); });
}
access("home", `list ${inp.home}`, "denied", () => fs.readdirSync(inp.home));
access("config", `read ${inp.config}`, "denied", () => fs.readFileSync(inp.config));
access("ssh", `list ${inp.home}/.ssh`, "denied", () => fs.readdirSync(`${inp.home}/.ssh`));
access("claude", `list ${inp.home}/.claude`, "denied", () => fs.readdirSync(`${inp.home}/.claude`));
for (const d of inp.protect) {
  const f = `${d}/.duet-probe-${inp.tag}`;
  access(`protect:${d}`, `create a file in ${d}`, "denied", () => fs.writeFileSync(f, "probe", { flag: "wx" }));
  try { fs.unlinkSync(f); } catch {}
}
process.stdout.write(JSON.stringify({ user: execFileSync("/usr/bin/id", ["-un"], { encoding: "utf8" }).trim(), checks }));
EOF
chmod 644 "$PROBE"
TAG="$(/usr/bin/python3 -c 'import secrets;print(secrets.token_hex(6))')"
PROTECT=()
for d in /opt/homebrew /usr/local /Applications; do [ -d "$d" ] && PROTECT+=("$d"); done
PROBE_IN="$(/usr/bin/python3 - "$TAG" "$OWNER_HOME" "$CONFIG" "${#WS[@]}" "${WS[@]}" "${PROTECT[@]}" <<'EOF'
import json, sys
tag, home, config, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
print(json.dumps({"tag": tag, "home": home, "config": config, "workspaces": sys.argv[5:5 + n], "protect": sys.argv[5 + n:]}))
EOF
)"
PROBE_OUT="$(cd "$BASE/bin" && printf '%s' "$PROBE_IN" | sudo -u "$USER_NAME" -H "$NODE" "$PROBE" 2>&1)" || true
rm -f "$PROBE"
RESULT="$(/usr/bin/python3 - "$USER_NAME" "$PROBE_OUT" <<'EOF'
import json, sys
user, raw = sys.argv[1], sys.argv[2]
try:
    r = json.loads(raw)
except Exception:
    print("FAIL the probe did not report: " + raw[-500:]); sys.exit(1)
bad = []
if r.get("user") != user: bad.append(f"the probe ran as {r.get('user')!r}, not {user}")
for c in r["checks"]:
    print(("   ok    " if c["pass"] else "   FAIL  ") + c["name"] + ("" if c["pass"] else f" ({c['detail']})"))
    if not c["pass"]: bad.append(c["name"])
if bad: print("FAIL " + "; ".join(bad)); sys.exit(1)
EOF
)" && OK=1 || OK=0
echo "$RESULT" | grep -v '^FAIL ' || true
[ "$OK" = 1 ] || die "The sandbox is not tight, so the runner was not started. Failed: $(echo "$RESULT" | grep '^FAIL ' | cut -c6-)"
printf '\033[32m   sandbox ok\033[0m\n'

# 7. Runner settings, and the gateway's side of them.
RUNNER_PORT="$(/usr/bin/python3 -c 'import json,sys;print((json.load(open(sys.argv[1])).get("claude") or {}).get("runnerPort") or 8788)' "$CONFIG")"
/usr/bin/python3 - "$BASE/runner.json" "$RUNNER_PORT" "$BASE" "${WS[@]}" <<'EOF'
import json, sys
out, port, base, ws = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4:]
json.dump({"gateway": f"http://127.0.0.1:{port}", "tokenFile": f"{base}/runner-token", "claudeTokenFile": f"{base}/claude-token",
           "claude": {"command": f"{base}/bin/claude"}, "workspaces": ws, "maxParallel": 2,
           "permissionMode": "auto", "logFile": f"{base}/logs/runner.log"}, open(out, "w"), indent=2)
EOF
chown root:wheel "$BASE/runner.json"
chmod 644 "$BASE/runner.json"
# The gateway's copy of the runner token lives in config.json, which only you can read.
TMP_TOKEN="$(mktemp "$OWNER_HOME/.duet-runner-token.XXXXXX")"
cp "$BASE/runner-token" "$TMP_TOKEN"
chown "$OWNER" "$TMP_TOKEN"
as_owner env DUET_GATEWAY_CONFIG="$CONFIG" "$NODE" "$GATEWAY_DIR/gateway.mjs" set-runner "$TMP_TOKEN" "$CLAUDE_LINK" "${WS[@]}" || { rm -f "$TMP_TOKEN"; die "Could not update config.json"; }
rm -f "$TMP_TOKEN"

# 8. The LaunchDaemon: start at boot as duet-agent, whether or not anyone is signed in; restart if it stops.
step "Installing LaunchDaemon $LABEL"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>UserName</key><string>$USER_NAME</string>
  <key>GroupName</key><string>$USER_NAME</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$BASE/bin/runner.mjs</string></array>
  <key>WorkingDirectory</key><string>$BASE/bin</string>
  <key>EnvironmentVariables</key><dict>
    <key>HOME</key><string>/Users/$USER_NAME</string>
    <key>SHELL</key><string>/bin/zsh</string>
    <key>PATH</key><string>$BASE/bin:$(dirname "$NODE"):/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$BASE/logs/runner.out</string>
  <key>StandardErrorPath</key><string>$BASE/logs/runner.out</string>
</dict>
</plist>
EOF
chown root:wheel "$PLIST"
chmod 644 "$PLIST"
plutil -lint "$PLIST" >/dev/null
LOG="$BASE/logs/runner.log"
LOG_LEN=0; [ -f "$LOG" ] && LOG_LEN="$(stat -f %z "$LOG")"
launchctl bootstrap system "$PLIST"
STARTED=0
for _ in $(seq 20); do
  sleep 1
  if [ -f "$LOG" ] && tail -c +"$((LOG_LEN + 1))" "$LOG" | grep -q "runner started"; then STARTED=1; break; fi
done
if [ "$STARTED" = 1 ]; then printf '\033[32m   runner is running\033[0m\n'
else echo "warning: the runner did not start. Last log lines:" >&2; tail -n 3 "$LOG" "$BASE/logs/runner.out" 2>/dev/null >&2 || true; fi

# 9. Restart the gateway so it opens the runner port.
if [ "$RESTART_GATEWAY" = 1 ] && launchctl print "gui/$OWNER_UID/com.duet-gateway" >/dev/null 2>&1; then
  step "Restarting the com.duet-gateway LaunchAgent"
  launchctl kickstart -k "gui/$OWNER_UID/com.duet-gateway"
fi

echo
printf '\033[32mDone. The runner logs to %s\033[0m\n' "$LOG"
echo "Kill switch: create duet.OFF in $GATEWAY_DIR (stops new turns), or close the endpoint: tailscale funnel --https=<port> off"
