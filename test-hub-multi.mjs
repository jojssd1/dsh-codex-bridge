#!/usr/bin/env node
/** Acceptance test: 3 MCP servers (as Codex spawns them) -> ONE shared dashboard. */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9100 + Math.floor(Math.random() * 60);
const BASE = "http://127.0.0.1:" + PORT;
const HUB_STATE = join(homedir(), ".dsh-codex-bridge", "hub.json");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (p) => { try { spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} };
const ping = async () => { try { const r = await fetch(BASE + "/api/ping"); return r.ok ? await r.json() : null; } catch { return null; } };

/** Minimal MCP client over stdio, so we drive each server the way Codex does. */
function mcpClient(proc, label) {
  let buf = "", id = 1; const pend = new Map();
  proc.stdout.on("data", (d) => {
    buf += d; let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
      if (!l) continue; const m = JSON.parse(l);
      if (m.id !== undefined && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); }
    }
  });
  proc.stderr.on("data", (d) => process.stderr.write("[" + label + "] " + d));
  const req = (method, params) => new Promise((r) => { const n = id++; pend.set(n, r); proc.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: n, method, params }) + "\n"); });
  return { req, label, proc };
}

const startServer = (label) => {
  const p = spawn(process.execPath, [join(HERE, "dsh-mcp-server.mjs")], {
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    env: { ...process.env, DSH_DASHBOARD_PORT: String(PORT) },
  });
  return mcpClient(p, label);
};
const convs = async () => { try { const r = await fetch(BASE + "/api/conversations"); return r.ok ? await r.json() : []; } catch { return []; } };

console.log("== spawning 3 MCP servers on port " + PORT + " (Codex does exactly this) ==");
const a = startServer("srv-A"); await sleep(3500);   // first one should spawn the hub
const j0 = await ping();
console.log("hub after srv-A:", JSON.stringify(j0));
console.log("hub.json:", existsSync(HUB_STATE) ? readFileSync(HUB_STATE, "utf8") : "(missing)");
const b = startServer("srv-B"); await sleep(1500);
const cc = startServer("srv-C"); await sleep(1500);
for (const c of [a, b, cc]) await c.req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: c.label, version: "1" } });
console.log("3 servers up; hub still single:", JSON.stringify(await ping()));

console.log("\n== delegating one task from EACH server ==");
const before = (await convs()).map((c) => c.id);
const tasks = ["A", "B", "C"];
for (let i = 0; i < 3; i++) {
  const r = await [a, b, cc][i].req("tools/call", { name: "dsh_start",
    arguments: { task: "只回复一个字：" + tasks[i], cwd: HERE, timeout_ms: 300000 } });
  console.log("  " + [a, b, cc][i].label + " -> " + (r.result.content[0].text.split("\n")[0]));
}

console.log("\n== waiting for all 3 to appear on the SINGLE board ==");
let list = [];
for (let i = 0; i < 45; i++) {
  await sleep(1000);
  list = (await convs()).filter((c) => !before.includes(c.id));
  const done = list.filter((c) => c.status !== "running").length;
  process.stdout.write("  poll " + (i + 1) + ": conversations=" + list.length + " finished=" + done + "\n");
  if (list.length >= 3 && done >= 3) break;
}

console.log("\nRESULT");
console.log("  distinct conversations on the board:", list.length, list.length >= 3 ? "PASS" : "FAIL");
for (const c of list) {
  const finals = c.blocks.filter((b) => b.kind === "final").map((b) => String(b.text).trim());
  console.log("    " + c.id.slice(0, 22) + "  " + c.status + "  blocks=" + c.blocks.length + "  final=" + JSON.stringify(finals));
}

console.log("\n== killing the hub: does it come back on its own? ==");
const hubPid = JSON.parse(readFileSync(HUB_STATE, "utf8")).pid;
spawnSync("taskkill", ["/PID", String(hubPid), "/T", "/F"], { stdio: "ignore" });
console.log("  killed hub pid " + hubPid);
console.log("  ping right after:", JSON.stringify(await ping()));
const t0 = Date.now();
let back = null;
for (let i = 0; i < 20; i++) { await sleep(1000); back = await ping(); if (back) break; }
console.log("  recovered in " + ((Date.now() - t0) / 1000).toFixed(1) + "s ->", JSON.stringify(back));
const after = await convs();
console.log("  conversations still on the board after hub restart:", after.length, after.length >= 3 ? "PASS (rehydrated from logs)" : "FAIL");

for (const c of [a, b, cc]) kill(c.proc);
const h = await ping();
if (h) spawnSync("taskkill", ["/PID", String(h.pid), "/T", "/F"], { stdio: "ignore" });
process.exit(0);