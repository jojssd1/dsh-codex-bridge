#!/usr/bin/env node
/** The bug the user hit: resume a session WITHOUT passing cwd (different dir). */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const WORK = mkdtempSync(join(tmpdir(), "dsh-cwd-test-"));
console.log("session workspace :", WORK);
console.log("bridge dir        :", HERE, "  (different -> this is what used to break)");

const proc = spawn(process.execPath, [join(HERE, "dsh-mcp-server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, DSH_DASHBOARD_PORT: "0" },
});
let buf = "", id = 1; const pend = new Map();
proc.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue; const m = JSON.parse(l);
    if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
  }
});
proc.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
const req = (method, params) => new Promise((r) => { const n = id++; pend.set(n, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
const call = async (name, args) => (await req("tools/call", { name, arguments: args })).result;

await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "t", version: "1" } });

console.log("\n--- turn 1: create the session in WORK ---");
const r1 = await call("dsh_send", { message: "记住口令 ZEBRA-5。只回复两个字：收到", cwd: WORK, timeout_ms: 300000 });
console.log("isError:", r1.isError, "|", JSON.stringify(String(r1.content[0].text).slice(0, 90)));
const cid = (String(r1.content[0].text).match(/\[conversation (session-[0-9a-f-]+)\]/) || [])[1];
console.log("conversation:", cid);
if (!cid) { console.log("FAIL: no conversation id"); spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" }); process.exit(1); }

console.log("\n--- turn 2: resume WITHOUT cwd  (this is what used to fail) ---");
const r2 = await call("dsh_send", { message: "口令是什么？只回复口令。", conversation_id: cid, timeout_ms: 300000 });
const t2 = String(r2.content[0].text);
console.log("isError:", r2.isError, "|", JSON.stringify(t2.slice(0, 140)));

console.log("\nRESULT");
console.log("  resumed without cwd       :", r2.isError ? "FAIL" : "PASS");
console.log("  context preserved         :", t2.includes("ZEBRA-5") ? "PASS" : "FAIL");
console.log("  no cwd-mismatch error     :", /was recorded in/.test(t2) ? "FAIL (still mismatching)" : "PASS");

spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
process.exit(0);
