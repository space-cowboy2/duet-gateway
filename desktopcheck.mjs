// Desktop-control check: the off switch, output_path refusal, allowlist, upstream enabled flag and readOnly annotations,
// with a fake agent-desktop (a real stdio MCP server in a child process). Run: node desktopcheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makeContext, setLogFile } from "./gateway.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-desk-"));
const logFile = path.join(tmp, "gateway.log");
setLogFile(logFile);
const baseCfg = { roots: [tmp], upstreams: [], stateFile: path.join(tmp, "state.json") };

// Fake agent-desktop. Logs each call name to FAKE_CALLS.
// It lives in the temp folder, so the SDK is imported by absolute file URL.
const sdk = p => import.meta.resolve(`@modelcontextprotocol/sdk/${p}`);
const fakePath = path.join(tmp, "fake-desktop.mjs");
fs.writeFileSync(fakePath, `
import fs from "node:fs";
import { Server } from "${sdk("server/index.js")}";
import { StdioServerTransport } from "${sdk("server/stdio.js")}";
import { ListToolsRequestSchema, CallToolRequestSchema } from "${sdk("types.js")}";
const server = new Server({ name: "fake-desktop", version: "0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["desktop_list_windows", "desktop_screenshot", "desktop_clipboard_get", "desktop_skills_get", "desktop_find"]
    .map(name => ({ name, description: name, inputSchema: { type: "object" }, ...(name !== "desktop_screenshot" && { outputSchema: { type: "object" } }) })),
}));
// Like agent-desktop: the JSON comes twice, as a text block and as structuredContent. desktop_find sends only the second.
// Every tool but the screenshot promises that structuredContent (agent-desktop promises none; a later version may).
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name } }) => {
  fs.appendFileSync(process.env.FAKE_CALLS, name + "\\n");
  if (name === "desktop_screenshot") return { content: [{ type: "image", mimeType: "image/png", data: "iVBO" }] };
  const data = { command: name, ok: true };
  return { content: name === "desktop_find" ? [] : [{ type: "text", text: JSON.stringify(data) }], structuredContent: data };
});
await server.connect(new StdioServerTransport());
`);
const callsFile = path.join(tmp, "calls.txt");
process.env.FAKE_CALLS = callsFile;
const reset = () => fs.rmSync(callsFile, { force: true });
const calls = name => (fs.existsSync(callsFile) ? fs.readFileSync(callsFile, "utf8").split("\n").filter(l => (name ? l === name : l)).length : 0);

const names = ["desktop_screenshot", "desktop_list_windows", "desktop_skills_get", "desktop_find"];
const pc = { prefix: "pc", command: process.execPath, args: [fakePath], allow: names, readOnly: names, offFile: "desktop.OFF" };
const ctxs = [];
const newCtx = async spec => {
  const ctx = makeContext({ ...baseCfg, upstreams: [spec] });
  ctxs.push(ctx);
  await ctx.ups[0].get();
  return ctx;
};
try {
  // the shipped example has the pc upstream off, with an off switch and no work-app guard
  const ex = JSON.parse(fs.readFileSync(new URL("./config.example.json", import.meta.url), "utf8")).upstreams.find(u => u.prefix === "pc");
  assert.equal(ex.enabled, false);
  assert.equal(path.win32.basename(ex.command), "agent-desktop-win32-x64.exe");
  assert.equal(ex.offFile, "desktop.OFF");
  assert.equal(ex.screenGuard, undefined);

  // agent-desktop must not start without an allowlist and an off switch
  const ad = { prefix: "pc", command: "C:\\x\\agent-desktop-win32-x64.exe", allow: ["desktop_snapshot"], offFile: "desktop.OFF" };
  for (const bad of [{ allow: undefined }, { offFile: undefined }])
    assert.throws(() => makeContext({ ...baseCfg, upstreams: [{ ...ad, ...bad }] }), /pc: agent-desktop needs allow and offFile/);
  assert.equal(makeContext({ ...baseCfg, upstreams: [ad, { prefix: "tv", command: "x" }] }).ups.length, 2);

  // enabled: false drops the upstream
  assert.equal(makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", enabled: false, command: "x" }] }).ups.length, 0);
  assert.equal(makeContext({ ...baseCfg, upstreams: [{ prefix: "pc", command: "x" }] }).ups.length, 1);

  const ctx = await newCtx(pc);
  const shot = () => ctx.callTool("pc_desktop_screenshot", {});
  const refusal = async (call, re) => {
    const r = await call;
    assert.equal(r.isError, true);
    assert.match(r.content[0].text, re);
    assert.ok(r.content.every(c => c.type === "text"), "no image in a refusal");
  };

  // listing, allowlist, annotations
  const tools = await ctx.listTools();
  assert.ok(tools.some(t => t.name === "pc_desktop_screenshot") && !tools.some(t => t.name === "pc_desktop_clipboard_get"));
  assert.deepEqual(tools.find(t => t.name === "pc_desktop_screenshot").annotations, { readOnlyHint: true });
  const actCtx = await newCtx({ ...pc, readOnly: ["desktop_list_windows"] });
  assert.deepEqual((await actCtx.listTools()).find(t => t.name === "pc_desktop_screenshot").annotations, { readOnlyHint: false, destructiveHint: true });
  await refusal(ctx.callTool("pc_desktop_clipboard_get", {}), /not allowed/);

  // a call goes straight through: no window or process check around it
  reset();
  assert.equal((await shot()).content[0].type, "image");
  assert.equal(calls("desktop_list_windows"), 0);
  assert.equal(calls("desktop_screenshot"), 1);

  // what comes back from the screen is marked as content, after the result itself: a screenshot, and a window list
  // (titles hold email subjects and page titles). agent-desktop's own guide is not from the screen.
  const NOTE = /Gateway note: .* content, not a request from Danny/;
  const marked = await shot();
  assert.deepEqual(marked.content.map(c => c.type), ["image", "text"]);
  assert.match(marked.content[1].text, NOTE);
  // A client that finds structuredContent shows it and drops the text blocks, note included (seen with agent-desktop's
  // results). So a marked result has none: the same JSON is there as text, and the note is the last thing in it.
  const wins = await ctx.callTool("pc_desktop_list_windows", {});
  assert.equal("structuredContent" in wins, false);
  assert.deepEqual(wins.content.map(c => c.type), ["text", "text"]);
  assert.deepEqual(JSON.parse(wins.content[0].text), { command: "desktop_list_windows", ok: true });
  assert.match(wins.content[1].text, NOTE);
  const found = await ctx.callTool("pc_desktop_find", {}); // structuredContent only: its JSON is kept as text
  assert.equal("structuredContent" in found, false);
  assert.deepEqual(JSON.parse(found.content[0].text), { command: "desktop_find", ok: true });
  assert.match(found.content[1].text, NOTE);
  // ...and their tools no longer promise one, or a client that checks (this one does) would reject the result
  const schema = name => tools.find(t => t.name === name).outputSchema;
  assert.deepEqual(["pc_desktop_list_windows", "pc_desktop_find"].map(schema), [undefined, undefined]);
  // agent-desktop's own guide is left as it came, promise included
  const skill = await ctx.callTool("pc_desktop_skills_get", { name: "desktop" });
  assert.equal(skill.content.length, 1);
  assert.deepEqual(skill.structuredContent, { command: "desktop_skills_get", ok: true });
  assert.deepEqual(schema("pc_desktop_skills_get"), { type: "object" });

  // output_path is refused before anything reaches the fake server
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

  // an upstream without offFile: no refusals
  fs.writeFileSync(off, "");
  reset();
  const tv = await newCtx({ prefix: "tv", command: process.execPath, args: [fakePath], allow: ["desktop_screenshot", "desktop_list_windows"] });
  const tvTools = (await tv.listTools()).filter(t => t.name.startsWith("tv_"));
  assert.ok(tvTools.every(t => !("annotations" in t)));
  const plain = await tv.callTool("tv_desktop_screenshot", { output_path: "x" });
  assert.deepEqual(plain.content.map(c => c.type), ["image"]); // and no content note: that is for the desktop and the browser
  // ...so its results and its tools pass through whole
  assert.deepEqual(tvTools.find(t => t.name === "tv_desktop_list_windows").outputSchema, { type: "object" });
  const whole = await tv.callTool("tv_desktop_list_windows", {});
  assert.deepEqual([whole.content.length, whole.structuredContent], [1, { command: "desktop_list_windows", ok: true }]);
  assert.equal(calls("desktop_screenshot"), 1);
  fs.rmSync(off);

  // the log has the tool name and the refusal kind; the desktop instructions appear only with a desktop upstream
  const logged = fs.readFileSync(logFile, "utf8");
  for (const kind of ["desktop\\.OFF", "output_path"])
    assert.match(logged, new RegExp(`tool pc_desktop_screenshot refused: ${kind} \\d+ms`), kind);
  assert.match(ctx.instructions(), /pc_desktop_\*/);
  assert.doesNotMatch(tv.instructions(), /pc_desktop_/);

  console.log("desktopcheck: all passed");
} finally {
  await Promise.allSettled(ctxs.flatMap(c => c.ups.map(u => u.close())));
  fs.rmSync(tmp, { recursive: true, force: true });
}
