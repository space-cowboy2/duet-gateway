# Desktop control (`pc_desktop_*`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expose agent-desktop through the gateway as `pc_desktop_*`, refused whenever a work app window is open.

**Architecture:** A new upstream entry in config reuses the `Upstream` proxy in `gateway.mjs`. Optional `readOnly` adds
annotations; optional `screenGuard` wraps `Upstream.call` with an off-file check, an `output_path` refusal, and a window
check before and after each call, using agent-desktop's own `desktop_list_windows`.

**Tech Stack:** Node 20+ ESM, `@modelcontextprotocol/sdk` 1.32.2 (client and stdio server), `node:assert`.

**Spec:** `docs/superpowers/specs/2026-11-08-desktop-control-design.md`

## Global Constraints
- Prefix `pc`; upstream ships with `"enabled": false` in `config.example.json`.
- Off file `desktop.OFF`, resolved against `path.dirname(cfg.stateFile)` (the same folder as `duet.OFF` in `sessions.mjs:42`).
- Errors and logs never contain window titles. Refusal text names exe names only. Log line: `tool <name> refused: work apps open`.
- Fail closed on any window-listing error.
- No new dependencies.
- Allowlist, readOnly list, apps and titles exactly as in the spec's Config and Tool allowlist sections.

## Review Focus
1. A minimized Outlook still blocks (`minimized: true`). Test in Task 2.
2. Case: `outlook.exe` in the window list vs `OUTLOOK.EXE` in config blocks. Test in Task 1.
3. A bad regex in `titles` throws when `makeContext` builds the upstream, not on the first call. Test in Task 1.
4. A fake server returning `isError` from `list_windows` refuses (fail closed). Test in Task 2.
5. An upstream with no `screenGuard` (tv, money) behaves exactly as before: no extra `list_windows` call. Test in Task 2.

---

### Task 1: `blockedApps` + `enabled` + annotations

**Files:**
- Modify: `gateway.mjs` (Upstream class, `makeContext`, new export)
- Create: `desktopcheck.mjs`
- Modify: `package.json` (`check` script: append `&& node desktopcheck.mjs`)

**Interfaces:**
- Produces: `export function blockedApps(windows: Array<{app_name, title}>, guard: {apps?: string[], titles?: (string|RegExp)[]}) → string[]`,
  unique exe names (as reported in `app_name`) of windows that match. Title regexes are case-insensitive.
- Produces: `export function compileGuard(g) → {offFile, apps: Set<lowercase string>, titles: RegExp[]}`; throws
  `screenGuard: bad title pattern <p>` on an invalid regex. `blockedApps` accepts its result.
- Upstream with `readOnly: string[]` adds `annotations: { readOnlyHint: true }` to names in the list, else
  `{ readOnlyHint: false, destructiveHint: true }`.

- [ ] **Step 1: Write failing unit tests in `desktopcheck.mjs`**
```js
const g = compileGuard({ apps: ["OUTLOOK.EXE"], titles: ["\\bEgnyte\\b"] });
assert.deepEqual(blockedApps([{ app_name: "outlook.exe", title: "Inbox" }], g), ["outlook.exe"]);
assert.deepEqual(blockedApps([{ app_name: "msedge.exe", title: "Egnyte - Files" }], g), ["msedge.exe"]);
assert.deepEqual(blockedApps([{ app_name: "notepad.exe", title: "notes" }], g), []);
assert.throws(() => compileGuard({ titles: ["("] }), /bad title pattern/);
assert.throws(() => makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", command: "x", screenGuard: { titles: ["("] } }] }), /bad title pattern/);
const ctx0 = makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", enabled: false, command: "x" }] });
assert.equal(ctx0.ups.length, 0);
```
- [ ] **Step 2: Run `node desktopcheck.mjs`.** Expected: fail (exports missing).
- [ ] **Step 3: Implement** `compileGuard`, `blockedApps`, the `enabled === false` filter in `makeContext`, and compile
  `screenGuard` in the `Upstream` constructor (`this.guard = spec.screenGuard && compileGuard(spec.screenGuard)`).
  Add annotations in `Upstream.tools()`.
- [ ] **Step 4: Run `node desktopcheck.mjs`.** Expected: pass.
- [ ] **Step 5: Commit** `feat: blockedApps guard, upstream enabled flag and readOnly annotations`.

### Task 2: Guarded `Upstream.call` + fake-server integration tests

**Files:**
- Modify: `gateway.mjs` (`Upstream.call`, `callTool` log line for refusals, `INSTRUCTIONS`)
- Modify: `desktopcheck.mjs`

**Interfaces:**
- Consumes: `compileGuard`, `blockedApps` (Task 1).
- Refusal errors (exact text):
  - off: `desktop control is off (desktop.OFF on the PC). Danny has to delete that file to turn it back on.`
  - output_path: `output_path is not allowed: screenshots are returned, never saved on the PC.`
  - blocked: `refused: work apps are open on the PC. Ask Danny to close these first: <names joined ", ">`
  - after-call: `refused: a work app opened during the call (<names>), so the result was dropped.`
  - listing failed: `refused: couldn't check open windows (<message>)`. The message comes from agent-desktop or JSON
    parse. It never contains titles, because only parse/transport errors are passed through.
- Refusals throw an `Error` with `.refused = true`. `callTool` logs `tool <name> refused: work apps open` for those
  instead of `error`.

- [ ] **Step 1: Write the fake server.** The test writes `fake-desktop.mjs` into its temp dir (SDK `Server` +
  `StdioServerTransport`). It reads `windows.json` from `process.env.FAKE_WINDOWS` on every call. Tools:
  `desktop_list_windows` (returns `{ok:true,data:windows}` as text; if the file holds `"garbage"` it returns text
  `not json`; if it holds `"error"` it returns `isError: true`), `desktop_screenshot` (returns an image
  `{type:"image",mimeType:"image/png",data:"iVBO"}`; if `process.env.FAKE_OPEN_ON_SHOT` is set it first writes a window
  `{app_name:"OUTLOOK.EXE",title:"x"}` into windows.json), `desktop_clipboard_get`. It counts `list_windows` calls in
  `calls.txt`.
- [ ] **Step 2: Write failing tests** through `makeContext(cfg)` with upstream
  `{prefix:"pc", command: process.execPath, args:[fakePath], allow:["desktop_screenshot","desktop_list_windows"], readOnly:["desktop_screenshot","desktop_list_windows"], screenGuard:{offFile:"desktop.OFF", apps:["OUTLOOK.EXE"], titles:["\\bVista\\b"]}}`:
```js
// listing + allowlist + annotations
const names = (await ctx.listTools()).map(t => t.name);
assert.ok(names.includes("pc_desktop_screenshot") && !names.includes("pc_desktop_clipboard_get"));
assert.equal((await ctx.callTool("pc_desktop_clipboard_get", {})).isError, true);
// clean desktop → image passes
setWindows([{ app_name: "notepad.exe", title: "a" }]);
assert.equal((await ctx.callTool("pc_desktop_screenshot", {})).content[0].type, "image");
// Outlook open, minimized Outlook, title match → refused, exe named, title absent
for (const w of [{ app_name: "OUTLOOK.EXE", title: "Re: payroll" }, { app_name: "OUTLOOK.EXE", title: "Re: payroll", minimized: true }, { app_name: "msedge.exe", title: "Vista - Re: payroll" }]) {
  setWindows([w]); const r = await ctx.callTool("pc_desktop_screenshot", {});
  assert.equal(r.isError, true); assert.match(r.content[0].text, /close these first/); assert.doesNotMatch(r.content[0].text, /payroll/);
}
// opened during call → dropped, no image in result
// output_path → refused, and the fake server never received the screenshot call
// desktop.OFF → refused; garbage listing → refused; isError listing → refused
// gateway.log has "refused: work apps open" and never "payroll"
// tv-style upstream without screenGuard → calls.txt count unchanged
```
- [ ] **Step 3: Run `node desktopcheck.mjs`.** Expected: fail at the clean-desktop or refusal assertions.
- [ ] **Step 4: Implement** `Upstream.call` per spec §Gateway changes 3: off file → output_path → `#check("refused: work apps are open…")` → call →
  `#check(after)`. `#check` calls `desktop_list_windows` via `this.get()` with a 15 s timeout, rejects on `isError`, and
  parses `content[0].text` → `.data` (must be an array). Add the spec's INSTRUCTIONS line, only when an upstream with
  `screenGuard` is enabled.
- [ ] **Step 5: Run `npm run check`.** Expected: all four check files pass.
- [ ] **Step 6: Commit** `feat: screen guard on pc upstream (off file, output_path, before/after window check)`.

### Task 3: Config example, doctor line, README

**Files:**
- Modify: `config.example.json` (add the spec's upstream verbatim, with the full allow and readOnly lists)
- Modify: `doctor.mjs` (`diagnose`: one `desktop control` line), `doctorcheck.mjs`
- Modify: `README.md` (tool bullet at the top, "Desktop control" section, `desktop.OFF` under kill switches and "Not in git")

**Interfaces:**
- Doctor line, check name `desktop control`. Find the upstream with `prefix === "pc"`:
  - absent or `enabled === false` → `ok`, "off".
  - exe missing (`probe.exists(command)` false) → `fail`, "agent-desktop not found at <command>".
  - `desktop.OFF` exists next to config.json → `warn`, "switched off (desktop.OFF)".
  - else `ok`, "on; turn on Needs approval for act tools in claude.ai".

- [ ] **Step 1: Write failing doctorcheck cases**, one per level above, using the existing `fakeProbe`/`goodCfg` helpers.
- [ ] **Step 2: Run `node doctorcheck.mjs`.** Expected: fail.
- [ ] **Step 3: Implement** the doctor line; add the config example and README text.
- [ ] **Step 4: Validate the example:** `node -e "JSON.parse(require('fs').readFileSync('config.example.json','utf8'))"`, then `npm run check`. Expected: pass.
- [ ] **Step 5: Commit** `feat: desktop control config example, doctor check, README`.

### Task 4: Live check against the real agent-desktop (no commit)
- [ ] Script in the scratchpad: `makeContext` with `config.example.json`'s `pc` upstream (`enabled: true`) and `upstreams` only that.
  Print the `pc_*` tool count (expect 44) and the result of `pc_desktop_list_windows`: expect the "close these first"
  refusal while Outlook is open, with exe names only. Print only `isError` and the refusal text, never content.
- [ ] Whole-branch review, then push and open a draft PR.
