// Desktop-control check: the work-app screen guard, upstream enabled flag and readOnly annotations, with a fake
// agent-desktop (a real stdio MCP server in a child process). Run: node desktopcheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockedApps, compileGuard, makeContext, setLogFile } from "./gateway.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-desk-"));
const logFile = path.join(tmp, "gateway.log");
setLogFile(logFile);
const baseCfg = { roots: [tmp], upstreams: [], stateFile: path.join(tmp, "state.json") };

// Fake agent-desktop. Reads the window list from FAKE_WINDOWS on every call and logs each call name to FAKE_CALLS.
// It lives in the temp folder, so the SDK is imported by absolute file URL.
const sdk = p => import.meta.resolve(`@modelcontextprotocol/sdk/${p}`);
const fakePath = path.join(tmp, "fake-desktop.mjs");
fs.writeFileSync(fakePath, `
import fs from "node:fs";
import { Server } from "${sdk("server/index.js")}";
import { StdioServerTransport } from "${sdk("server/stdio.js")}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${sdk("types.js")}";
const { FAKE_WINDOWS: W, FAKE_CALLS: C } = process.env;
const server = new Server({ name: "fake-desktop", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["desktop_list_windows", "desktop_screenshot", "desktop_clipboard_get"].map(name => ({ name, description: name, inputSchema: { type: "object" } })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name } }) => {
  fs.appendFileSync(C, name + "\\n");
  if (name === "desktop_list_windows") {
    const w = JSON.parse(fs.readFileSync(W, "utf8"));
    // The error text carries a title on purpose: it must never reach the caller.
    if (w === "error") return { isError: true, content: [{ type: "text", text: "boom Re: payroll" }] };
    return { content: [{ type: "text", text: w === "garbage" ? "not json Re: payroll" : JSON.stringify({ ok: true, data: w }) }] };
  }
  if (name === "desktop_screenshot") {
    if (process.env.FAKE_OPEN_ON_SHOT) fs.writeFileSync(W, JSON.stringify([{ app_name: "OUTLOOK.EXE", title: "x" }]));
    return { content: [{ type: "image", mimeType: "image/png", data: "iVBO" }] };
  }
  return { content: [{ type: "text", text: "clip" }] };
});
await server.connect(new StdioServerTransport());
`);
const winFile = path.join(tmp, "windows.json"), callsFile = path.join(tmp, "calls.txt");
process.env.FAKE_WINDOWS = winFile;
process.env.FAKE_CALLS = callsFile;
const setWindows = w => fs.writeFileSync(winFile, JSON.stringify(w));
const reset = () => fs.rmSync(callsFile, { force: true });
const calls = name => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(l => (name ? l === name : l)).length : 0);

const names = ["desktop_screenshot", "desktop_list_windows"];
const pc = { prefix: "pc", command: process.execPath, args: [fakePath], allow: names, readOnly: names,
  screenGuard: { offFile: "desktop.OFF", apps: ["OUTLOOK.EXE"], titles: ["\\bVista\\b"] } };
const ctxs = [];
const newCtx = async spec => { // the child gets process.env as it is at spawn, so FAKE_OPEN_ON_SHOT is set only around it
  const ctx = makeContext({ ...baseCfg, upstreams: [spec] });
  ctxs.push(ctx);
  await ctx.ups[0].get();
  return ctx;
};
try {
  // blockedApps: exe names match case-insensitively (reported name is returned), titles by regex, minimized or not
  const g = compileGuard({ apps: ["OUTLOOK.EXE"], titles: ["\\bEgnyte\\b"] });
  assert.deepEqual(blockedApps([{ app_name: "outlook.exe", title: "Inbox" }], g), ["outlook.exe"]);
  assert.deepEqual(blockedApps([{ app_name: "msedge.exe", title: "Egnyte - Files" }], g), ["msedge.exe"]);
  assert.deepEqual(blockedApps([{ app_name: "msedge.exe", title: "egnyte - files" }], g), ["msedge.exe"]);
  assert.deepEqual(blockedApps([{ app_name: "notepad.exe", title: "notes" }], g), []);
  assert.deepEqual(blockedApps([{ app_name: "a.exe", title: "Egnyte" }, { app_name: "a.exe", title: "Egnyte 2" }], g), ["a.exe"]);

  // a bad regex fails when the context is built, not on the first call
  assert.throws(() => compileGuard({ titles: ["("] }), /bad title pattern/);
  assert.throws(() => makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", command: "x", screenGuard: { titles: ["("] } }] }), /bad title pattern/);

  // enabled: false drops the upstream
  assert.equal(makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", enabled: false, command: "x" }] }).ups.length, 0);
  assert.equal(makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", command: "x" }] }).ups.length, 1);

  const ctx = await newCtx(pc);
  const shot = () => ctx.callTool("pc_desktop_screenshot", {});
  const refusal = async (call, re) => {
    const r = await call;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
    assert.doesNotMatch(r.content[0].text, /payroll/);
    assert.ok(r.content.every(c => c.type === "text"), "no image in a refusal");
  };

  // listing, allowlist, annotations
  const tools = await ctx.listTools();
  assert.ok(tools.some(t => t.name === "pc_desktop_screenshot") && !tools.some(t => t.name === "pc_desktop_clipboard_get"));
  assert.deepEqual(tools.find(t => t.name === "pc_desktop_screenshot").annotations, { readOnlyHint: true });
  const actCtx = await newCtx({ ...pc, readOnly: ["desktop_list_windows"] });
  assert.deepEqual((await actCtx.listTools()).find(t => t.name === "pc_desktop_screenshot").annotations, { readOnlyHint: false, destructiveHint: true });
  await refusal(ctx.callTool("pc_desktop_clipboard_get", {}), /not allowed/);

  // clean desktop: the image passes, with one window listing before and one after
  setWindows([{ app_name: "notepad.exe", title: "a" }]);
  reset();
  assert.equal((await shot()).content[0].type, "image");
  assert.equal(calls("desktop_list_windows"), 2);

  // Outlook open, minimized Outlook, a Vista title: refused with the exe name and without the title
  for (const w of [{ app_name: "OUTLOOK.EXE", title: "Re: payroll" }, { app_name: "outlook.exe", title: "Re: payroll", minimized: true }, { app_name: "msedge.exe", title: "Vista - Re: payroll" }]) {
    setWindows([w]);
    reset();
    await refusal(shot(), new RegExp(`close these first: ${w.app_name}$`));
    assert.equal(calls("desktop_screenshot"), 0, "the screenshot was never taken");
  }

  // a work window opened during the call: the result is dropped
  setWindows([]);
  process.env.FAKE_OPEN_ON_SHOT = "1";
  const racy = await newCtx(pc);
  delete process.env.FAKE_OPEN_ON_SHOT;
  reset();
  await refusal(racy.callTool("pc_desktop_screenshot", {}), /opened during the call \(OUTLOOK\.EXE\).*dropped/);
  assert.equal(calls("desktop_screenshot"), 1);

  // output_path is refused before anything reaches the fake server
  setWindows([]);
  reset();
  await refusal(ctx.callTool("pc_desktop_screenshot", { output_path: path.join(tmp, "x.png") }), /output_path is not allowed/);
  assert.equal(calls(), 0);
  assert.ok(!fs.existsSync(path.join(tmp, "x.png")));

  // desktop.OFF next to the state file refuses without touching the server, and deleting it turns control back on
  const off = path.join(tmp, "desktop.OFF");
  fs.writeFileSync(off, "");
  reset();
  await refusal(shot(), /desktop control is off/);
  assert.equal(calls(), 0);
  fs.rmSync(off);
  assert.equal((await shot()).content[0].type, "image");

  // fail closed: unparseable listing, listing that errors
  for (const bad of ["garbage", "error"]) {
    setWindows(bad);
    reset();
    await refusal(shot(), /couldn't check open windows/);
    assert.equal(calls("desktop_screenshot"), 0);
  }

  // an upstream without screenGuard behaves as before: no window listing, no refusals
  setWindows([{ app_name: "OUTLOOK.EXE", title: "x" }]);
  reset();
  const tv = await newCtx({ prefix: "tv", command: process.execPath, args: [fakePath], allow: ["desktop_screenshot"] });
  assert.ok((await tv.listTools()).every(t => !("annotations" in t)));
  assert.equal((await tv.callTool("tv_desktop_screenshot", {})).content[0].type, "image");
  assert.equal(calls("desktop_list_windows"), 0);
  assert.equal(calls("desktop_screenshot"), 1);

  // the log has the tool name and "refused", never titles; the guard's instructions appear only with a guarded upstream
  const logged = fs.readFileSync(logFile, "utf8");
  assert.match(logged, /tool pc_desktop_screenshot refused: work apps open/);
  assert.doesNotMatch(logged, /payroll|Vista/);
  assert.match(ctx.instructions(), /pc_desktop_\*/);
  assert.doesNotMatch(tv.instructions(), /pc_desktop_/);

  console.log("desktopcheck: all passed");
} finally {
  await Promise.allSettled(ctxs.flatMap(c => c.ups.map(u => u.close())));
  fs.rmSync(tmp, { recursive: true, force: true });
}
