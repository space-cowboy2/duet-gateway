// Desktop-control check: the off switch, output_path refusal, allowlist, upstream enabled flag and readOnly annotations,
// with a fake agent-desktop (a real stdio MCP server in a child process). Then upstream health: a server that is
// missing, crashes or hangs is reported with its reason and does not take the others with it. Run: node desktopcheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { errorCode, makeContext, setLaunchProbe, setLogFile, setUpstreamStartMs } from "./gateway.mjs";
import { MAX_LAUNCH_MS, launchArgs, parseShortcut, resolveLaunch, splitArgs } from "./launch.mjs";

// A failed upstream call is logged with its error code only (never the message), and only if it is a plain code.
const errRes = text => ({ isError: true, content: [{ type: "text", text }] });
assert.equal(errorCode(errRes('{"error":{"code":"TIMEOUT","message":"waited for C:\\\\Users\\\\x"}}')), "TIMEOUT");
assert.equal(errorCode(errRes('{"code":"AMBIGUOUS_TARGET"}')), "AMBIGUOUS_TARGET");
for (const bad of ["plain text failure", '{"error":{"code":"sk-ant-secret value"}}', '{"error":{"code":"lower"}}', '{"error":{"code":7}}', "{"])
  assert.equal(errorCode(errRes(bad)), null, bad);
assert.equal(errorCode({ isError: true }), null);

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-desk-"));
const logFile = path.join(tmp, "gateway.log");
setLogFile(logFile);
const baseCfg = { roots: [tmp], upstreams: [], stateFile: path.join(tmp, "state.json") };
// The gateway names its machine: "PC" on Windows, "Mac" elsewhere (Linux CI included).
const PC = process.platform === "win32" ? "PC" : "Mac";

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
  tools: ["desktop_list_windows", "desktop_screenshot", "desktop_clipboard_get", "desktop_skills_get", "desktop_find", "desktop_launch"]
    .map(name => ({ name, description: name, inputSchema: { type: "object" }, ...(name !== "desktop_screenshot" && { outputSchema: { type: "object" } }) })),
}));
// Like agent-desktop: the JSON comes twice, as a text block and as structuredContent. desktop_find sends only the second.
// Every tool but the screenshot promises that structuredContent (agent-desktop promises none; a later version may).
server.setRequestHandler(CallToolRequestSchema, async ({ params: { name, arguments: args } }) => {
  fs.appendFileSync(process.env.FAKE_CALLS, name + "\\n");
  // launch answers with the arguments it was given, so the check can see what the gateway passed on
  if (name === "desktop_launch") return { content: [{ type: "text", text: JSON.stringify({ got: args }) }] };
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

  // ---- launch: the name Duet gives becomes a program agent-desktop can start (issue #17) ----
  // A made-up Windows machine: two system programs, one program registered in App Paths, and three Start Menu shortcuts.
  const lnk = (target, args = "") => {
    const head = Buffer.alloc(76); head.writeUInt32LE(0x4c, 0); head.writeUInt32LE(0x02 | 0x80 | (args ? 0x20 : 0), 20); // has link info, unicode strings
    const base = Buffer.from(target + "\0", "latin1"), info = Buffer.alloc(28 + base.length + 1);
    info.writeUInt32LE(info.length, 0); info.writeUInt32LE(28, 4); info.writeUInt32LE(1, 8); info.writeUInt32LE(28, 16); info.writeUInt32LE(28 + base.length, 24);
    base.copy(info, 28);
    const str = t => { const b = Buffer.alloc(2 + t.length * 2); b.writeUInt16LE(t.length, 0); b.write(t, 2, "utf16le"); return b; };
    return Buffer.concat([head, info, ...(args ? [str(args)] : [])]);
  };
  assert.deepEqual(parseShortcut(lnk("C:\\Apps\\Steam\\steam.exe")), { target: "C:\\Apps\\Steam\\steam.exe", args: "" });
  assert.deepEqual(parseShortcut(lnk("C:\\Apps\\Discord\\Update.exe", '--processStart "Discord App.exe"')), { target: "C:\\Apps\\Discord\\Update.exe", args: '--processStart "Discord App.exe"' });
  for (const bad of [Buffer.alloc(0), Buffer.from("not a shortcut at all, just some text that is long enough to pass the size check........"), lnk("relative\\x.exe"), lnk("C:\\x.exe").subarray(0, 90)])
    assert.equal(parseShortcut(bad), null);
  assert.deepEqual(splitArgs('--processStart "Discord App.exe" -x'), ["--processStart", "Discord App.exe", "-x"]);
  const disk = new Set(["C:\\Windows\\System32\\calc.exe", "C:\\Windows\\notepad.exe", "C:\\Program Files\\Edge\\msedge.exe", "C:\\Apps\\Steam\\steam.exe", "C:\\Apps\\Discord\\Update.exe"]);
  const links = { "S:\\Steam.lnk": lnk("C:\\Apps\\Steam\\steam.exe"), "S:\\Discord.lnk": lnk("C:\\Apps\\Discord\\Update.exe", "--processStart Discord.exe"),
    "S:\\Notepad++.lnk": lnk("C:\\Apps\\npp\\gone.exe"), "S:\\Read Me.lnk": lnk("C:\\Apps\\readme.txt") };
  const asked = [];
  const probe = {
    systemDirs: ["C:\\Windows\\System32", "C:\\Windows"], exists: p => disk.has(p),
    appPath: async name => { asked.push(name); return name.toLowerCase() === "msedge" ? "C:\\Program Files\\Edge\\msedge.exe" : null; },
    shortcuts: () => Object.keys(links).map(file => ({ name: file.slice(3, -4), file })), readShortcut: file => parseShortcut(links[file]),
  };
  const resolved = async app => { const r = await resolveLaunch(app, probe); return [r.app, r.how, ...(r.args ? [r.args] : [])]; };
  assert.deepEqual(await resolved("calc"), ["calc", "system"]);
  assert.deepEqual(await resolved("Calculator"), ["calc", "system"]);
  assert.deepEqual(await resolved("notepad.exe"), ["notepad", "system"]);
  assert.deepEqual(await resolved("Microsoft Edge"), ["C:\\Program Files\\Edge\\msedge.exe", "app-path"]);
  assert.deepEqual(await resolved("D:\\Tools\\x.exe"), ["D:\\Tools\\x.exe", "path"]); // a full path goes through as it is
  assert.deepEqual(await resolved("steam"), ["C:\\Apps\\Steam\\steam.exe", "shortcut"]);
  assert.deepEqual(await resolved("Discord"), ["C:\\Apps\\Discord\\Update.exe", "shortcut", ["--processStart", "Discord.exe"]]);
  // Nothing by that name: an APP_NOT_FOUND with the close matches, and no guess. A shortcut to a missing or non-program target is not used.
  for (const [app, hint] of [["Notepad+", /Close matches in the Start Menu: Notepad\+\+/], ["read me", /Close matches in the Start Menu: Read Me/], ["zzz", /No app named "zzz"/], ["..\\x", /No app named/], ["", /No app named/]])
    await assert.rejects(resolveLaunch(app, probe), e => e.code === "APP_NOT_FOUND" && e.launch === true && hint.test(e.message), app);
  // A name is never put into the registry lookup unless it is a plain program name.
  await assert.rejects(resolveLaunch('x" /s & calc', probe));
  assert.ok(asked.every(n => /^[\w][\w .+-]*$/.test(n)), asked.join());
  // The caller's own arguments win over a shortcut's, and the time limit is capped.
  assert.deepEqual(await launchArgs({ app: "Discord", args: ["--x"], timeout: 500_000 }, probe), { app: "C:\\Apps\\Discord\\Update.exe", args: ["--x"], timeout: MAX_LAUNCH_MS });
  assert.deepEqual(await launchArgs({ app: "Calculator", activate: true }, probe), { app: "calc", activate: true });

  // Through the gateway: the resolved program reaches agent-desktop, an unknown name never does, and the log has the code only.
  const launcher = await newCtx({ ...pc, allow: [...names, "desktop_launch"] });
  setLaunchProbe(probe);
  reset();
  const sentTo = async app => JSON.parse((await launcher.callTool("pc_desktop_launch", { app })).content[0].text).got;
  assert.deepEqual(await sentTo("Calculator"), { app: "calc" });
  assert.deepEqual(await sentTo("steam"), { app: "C:\\Apps\\Steam\\steam.exe" });
  const none = await launcher.callTool("pc_desktop_launch", { app: "Secret Budget App" });
  assert.equal(none.isError, true);
  assert.match(none.content[0].text, /No app named "Secret Budget App" was found on the PC\. Nothing was started\./);
  assert.equal(calls("desktop_launch"), 2);
  assert.match(fs.readFileSync(logFile, "utf8"), /tool pc_desktop_launch error APP_NOT_FOUND \d+ms/);
  assert.doesNotMatch(fs.readFileSync(logFile, "utf8"), /Secret Budget/);
  // Without a probe (a Mac, where agent-desktop takes app names itself) the name goes through untouched.
  setLaunchProbe(null);
  assert.deepEqual(await sentTo("Calculator"), { app: "Calculator" });
  setLaunchProbe(process.platform === "win32" ? undefined : null);

  // the log has the tool name and the refusal kind; the desktop instructions appear only with a desktop upstream
  const logged = fs.readFileSync(logFile, "utf8");
  for (const kind of ["desktop\\.OFF", "output_path"])
    assert.match(logged, new RegExp(`tool pc_desktop_screenshot refused: ${kind} \\d+ms`), kind);
  assert.match(ctx.instructions(), /pc_desktop_\*/);
  assert.doesNotMatch(tv.instructions(), /pc_desktop_/);

  // ---- upstream health ----
  // A fake TV server with instructions of its own, and three broken ones: no such program, exits at once, never answers.
  const fakeTv = path.join(tmp, "fake-tv.mjs");
  fs.writeFileSync(fakeTv, fs.readFileSync(fakePath, "utf8")
    .replace('{ capabilities: { tools: {} } }', '{ capabilities: { tools: {} }, instructions: "FAKE TV INSTRUCTIONS" }')
    .replace(/\["desktop_list_windows"[^\]]*\]/, '["play", "get_guide"]'));
  assert.match(fs.readFileSync(fakeTv, "utf8"), /tools: \["play", "get_guide"\]/, "the fake TV server was not derived from the fake desktop");
  const crash = path.join(tmp, "crash.mjs"), hang = path.join(tmp, "hang.mjs"), late = path.join(tmp, "late.mjs");
  fs.writeFileSync(crash, "process.exit(3);");
  fs.writeFileSync(hang, "setInterval(() => {}, 1000);");
  const guideOf = async c => (await c.callTool("guide", {})).content[0].text;
  const node = path.basename(process.execPath).replace(/\./g, "\\.");
  const make = (...upstreams) => { const c = makeContext({ ...baseCfg, upstreams }); ctxs.push(c); return c; };

  // No such program: the other upstream still lists, the guide and a call both give the reason, and nothing is thrown.
  const gone = make({ prefix: "tv", command: path.join(tmp, "no-such-python"), args: [fakeTv] }, pc);
  let listed = (await gone.listTools()).map(t => t.name);
  assert.ok(listed.includes("pc_desktop_screenshot") && listed.includes("guide") && !listed.some(n => n.startsWith("tv_")), listed.join());
  let g = await guideOf(gone);
  assert.match(g, new RegExp(`^- TV \\(tv_\\*\\): not answering \\(command not found: no-such-python\\)\\. Its tools are missing until that is fixed on the ${PC}$`, "m"));
  assert.match(g, /^- Desktop control \(pc_desktop_\*\): on$/m);
  assert.match(g, new RegExp(`^- Bank balances: not set up on this ${PC}$`, "m"));
  assert.match(g, /^## TV notes \(`tv_\*`\)$/m);
  const downCall = await gone.callTool("tv_play", { query: "jazz" });
  assert.equal(downCall.isError, true);
  assert.equal(downCall.content[0].text, `The tv_* tools are not answering on the ${PC} (command not found: no-such-python). Nothing was sent.`);

  // Exits at once (a wrong script path does the same), and never answers: both are reported, the second within the time limit.
  setUpstreamStartMs(400);
  const broken = make({ prefix: "money", command: process.execPath, args: [crash] }, { prefix: "tv", command: process.execPath, args: [hang] },
    { prefix: "pc", command: process.execPath, args: [crash], allow: names, offFile: "desktop.OFF" });
  const t0 = Date.now();
  assert.deepEqual((await broken.listTools()).map(t => t.name).filter(n => /^(tv|money|pc)_/.test(n)), []);
  assert.ok(Date.now() - t0 < 5000, "a hung upstream held the tool list");
  g = await guideOf(broken);
  assert.match(g, new RegExp(`^- Bank balances \\(money_\\*\\): not answering \\(${node} started and exited at once \\(wrong script path, or it crashed\\)\\)\\.`, "m"));
  assert.match(g, new RegExp(`^- TV \\(tv_\\*\\): not answering \\(${node} started but did not answer in 0\\.4 s\\)\\.`, "m"));
  assert.match(g, new RegExp(`^- Desktop control \\(pc_desktop_\\*\\): on, but not answering \\(${node} started and exited at once`, "m"));
  setUpstreamStartMs(15_000);

  // A server that was down is asked again by the guide, so a fix on the PC shows without restarting the gateway.
  const healed = make({ prefix: "tv", command: process.execPath, args: [late] });
  assert.match(await guideOf(healed), /^- TV \(tv_\*\): set up, not started yet$/m);
  assert.equal((await healed.listTools()).filter(t => t.name.startsWith("tv_")).length, 0);
  assert.match(await guideOf(healed), /^- TV \(tv_\*\): not answering/m);
  fs.copyFileSync(fakeTv, late);
  assert.match(await guideOf(healed), /^- TV \(tv_\*\): on, 2 tools$/m);
  assert.deepEqual((await healed.listTools()).map(t => t.name).filter(n => n.startsWith("tv_")), ["tv_play", "tv_get_guide"]);

  // warm() starts the upstreams, so the first conversation already has a server's own instructions.
  const warmed = make({ prefix: "tv", command: process.execPath, args: [fakeTv] });
  assert.match(warmed.instructions(), /tv_get_guide before the first TV request\. If no tv_\* tools are listed, guide says why/);
  assert.doesNotMatch(warmed.instructions(), /FAKE TV INSTRUCTIONS/);
  await warmed.warm();
  assert.match(warmed.instructions(), /FAKE TV INSTRUCTIONS$/);
  assert.match(await guideOf(warmed), /^- TV \(tv_\*\): on, 2 tools$/m);

  // The older TV server (get_notes, play_youtube, no get_guide): the line names the tool that server really has.
  const oldTv = path.join(tmp, "old-tv.mjs");
  fs.writeFileSync(oldTv, fs.readFileSync(fakeTv, "utf8").replace('["play", "get_guide"]', '["play_youtube", "get_notes"]'));
  const older = make({ prefix: "tv", command: process.execPath, args: [oldTv] });
  await older.warm();
  assert.match(older.instructions(), /tv_get_notes before the first TV request and follow the TV server's own instructions below\./);
  assert.doesNotMatch(older.instructions(), /tv_get_guide/);

  // An upstream that is switched off in config.json is named as that, not as missing.
  assert.match(await guideOf(make({ prefix: "tv", enabled: false, command: "x" })), new RegExp(`^- TV: switched off in config\\.json on the ${PC}\\n- Bank balances: not set up on this ${PC}$`, "m"));

  // gateway.log: one line per change of state, in fixed wording, with the program's file name and never its folder.
  const upLog = fs.readFileSync(logFile, "utf8").split("\n").filter(l => / upstream /.test(l)).map(l => l.replace(/^\S+ /, ""));
  assert.equal(upLog.filter(l => l === "upstream tv unavailable: command not found: no-such-python").length, 1, upLog.join("\n"));
  assert.ok(upLog.includes("upstream tv up, 2 tools") && upLog.some(l => /^upstream money unavailable: \S+ started and exited at once/.test(l)), upLog.join("\n"));
  assert.ok(!upLog.some(l => l.includes(tmp) || l.includes(fs.realpathSync(tmp))), "a path in the log");
  assert.match(fs.readFileSync(logFile, "utf8"), /tool tv_play upstream down \d+ms/);

  console.log("desktopcheck: all passed");
} finally {
  await Promise.allSettled(ctxs.flatMap(c => c.ups.map(u => u.close())));
  fs.rmSync(tmp, { recursive: true, force: true });
}
