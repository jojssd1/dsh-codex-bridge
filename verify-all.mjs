#!/usr/bin/env node
/** Final verification: MCP surface + dashboard surface, both against the live code. */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (b) => (b ? "PASS" : "FAIL");

/* ---------- 1. MCP protocol surface ---------- */
const mcp = spawn(process.execPath, [join(HERE, "dsh-mcp-server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, DSH_DASHBOARD_PORT: "0" },   // no dashboard for this instance
});
mcp.stderr.on("data", () => {});
let buf = "", nextId = 1; const pending = new Map();
mcp.stdout.on("data", (d) => {
  buf += d; let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
    if (!l) continue;
    const m = JSON.parse(l); if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  }
});
const req = (method, params) => new Promise((res) => { const id = nextId++; pending.set(id, res); mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n"); });

const init = await req("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "verify", version: "1" } });
mcp.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized", params: {} }) + "\n");
console.log("MCP protocolVersion :", init.result.protocolVersion);
console.log("MCP capabilities    :", JSON.stringify(init.result.capabilities));
const tools = (await req("tools/list", {})).result.tools;
console.log("MCP tools (" + tools.length + ")     :", tools.map((t) => t.name).join(", "));
const err = await req("tools/call", { name: "nope", arguments: {} });
console.log("unknown tool guarded:", ok(err.result.isError === true));

/* ---------- 2. dashboard + conversation round trip ---------- */
const PORT = 8900 + Math.floor(Math.random() * 80);
const dash = spawn(process.execPath, [join(HERE, "dsh-dashboard.mjs")], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, DSH_DASHBOARD_PORT: String(PORT) },
});
dash.stderr.on("data", () => {}); dash.stdout.on("data", () => {});
const BASE = "http://127.0.0.1:" + PORT;
let up = false;
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/api/conversations")).ok) { up = true; break; } } catch {} await sleep(250); }
console.log("\nDashboard port      :", PORT, ok(up));

const page = await (await fetch(BASE + "/")).text();
console.log("page bytes          :", page.length, ok(page.includes("SUBAGENTS") && page.includes("dataset.kind")));

const send = (b) => fetch(BASE + "/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const convs = () => fetch(BASE + "/api/conversations").then((r) => r.json());
const waitDone = async (id) => {
  for (let i = 0; i < 25; i++) { await sleep(2000); const v = (await convs()).find((x) => x.id === id); if (v && v.status !== "running") return v; }
  return (await convs()).find((x) => x.id === id);
};

const before = (await convs()).map((x) => x.id);
console.log("\n--- turn 1 ---  (" + before.length + " conversation(s) already on the board)");
await send({ message: "记住暗号 GOLD-9。只回复：好", cwd: HERE, timeout_ms: 300000 });
let all = []; for (let i = 0; i < 25; i++) { await sleep(1000); all = (await convs()).filter((x) => !before.includes(x.id)); if (all.length) break; }
if (!all.length) { console.log("FAIL: no new conversation appeared"); process.exit(1); }
const cid = all[0].id;
let v = await waitDone(cid);
console.log("conversation        :", cid);
console.log("status              :", v.status);

console.log("--- turn 2 (same conversation) ---");
await send({ message: "暗号是什么？只回复暗号。", conversation_id: cid, timeout_ms: 300000 });
v = await waitDone(cid);

const texts = v.blocks.filter((b) => b.kind === "msg" || b.kind === "final").map((b) => String(b.text).trim());
const dup = texts.length !== new Set(texts).size;
const newOnes = (await convs()).filter((x) => !before.includes(x.id)).length;
console.log("new conversations   :", newOnes, ok(newOnes === 1));
console.log("user turns          :", v.blocks.filter((b) => b.kind === "user").length, ok(v.blocks.filter((b) => b.kind === "user").length === 2));
console.log("context kept        :", ok(texts.some((t) => t.includes("GOLD-9"))));
console.log("no duplicated bubble:", ok(!dup));
console.log("\nblocks:");
for (const b of v.blocks) console.log("  [" + b.kind + "] " + String(b.text ?? b.name ?? "").slice(0, 46).replace(/\n/g, " "));

const die = (p) => { try { spawnSync("taskkill", ["/PID", String(p.pid), "/T", "/F"], { stdio: "ignore" }); } catch {} };
die(mcp); die(dash);
process.exit(0);