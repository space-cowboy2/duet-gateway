// Desktop-control check: the work-app screen guard, upstream enabled flag and readOnly annotations. Run: node desktopcheck.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { blockedApps, compileGuard, makeContext, setLogFile } from "./gateway.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "duet-desk-"));
setLogFile(path.join(tmp, "gateway.log"));
const baseCfg = { roots: [tmp], upstreams: [], stateFile: path.join(tmp, "state.json") };
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

  // readOnly adds annotations; without it tools pass through untouched
  const listed = async spec => {
    const up = makeContext({ ...baseCfg, upstreams: [spec] }).ups[0];
    up.get = async () => ({ listTools: async () => ({ tools: [{ name: "look" }, { name: "poke" }] }) });
    return up.tools();
  };
  const ann = await listed({ prefix: "pc", command: "x", readOnly: ["look"] });
  assert.deepEqual(ann.map(t => [t.name, t.annotations]), [["pc_look", { readOnlyHint: true }], ["pc_poke", { readOnlyHint: false, destructiveHint: true }]]);
  assert.ok((await listed({ prefix: "pc", command: "x" })).every(t => !("annotations" in t)));

  console.log("desktopcheck: all passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
