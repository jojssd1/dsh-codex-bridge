#!/usr/bin/env node
/** Destroy flow: create a throwaway conversation, then verify all three stores are cleared. */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const BASE = "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const convs = () => fetch(BASE + "/api/conversations").then((r) => r.json());
const RUNS = join(homedir(), ".dsh-codex-bridge", "runs");
const SESS = join(homedir(), ".dsh", "sessions");

function sessionDirs(id) {
  const hits = [];
  for (const d of readdirSync(SESS)) { const p = join(SESS, d, id); if (existsSync(p)) hits.push(p); }
  return hits;
}

const before = await convs();
console.log("conversations before:", before.length);

// --- throwaway conversation ---
await fetch(BASE + "/api/send", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ message: "只回复一个字：删", cwd: process.cwd(), timeout_ms: 300000 }) });
let v;
for (let i = 0; i < 25; i++) { await sleep(2000); const l = await convs(); v = l.find((c) => !before.map((b) => b.id).includes(c.id)); if (v && v.status !== "running") break; }
console.log("created:", v.id);
console.log("conversations now:", (await convs()).length);

const logs = readdirSync(RUNS).filter((n) => n.endsWith(".jsonl"))
  .filter((n) => readFileSync(join(RUNS, n), "utf8").includes(v.id));
const sdirs = sessionDirs(v.id);
console.log("backing logs found:", logs.length, "| DSH session dirs:", sdirs.length, sdirs.map((p) => p.slice(-28)));
console.log("log files exist:", logs.every((n) => existsSync(join(RUNS, n))));

// --- destroy ---
const res = await (await fetch(BASE + "/api/forget", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ conversation_id: v.id }) })).json();
console.log("forget ->", JSON.stringify(res));

await sleep(500);
const after = await convs();
console.log("conversations after:", after.length, "| gone from list:", !after.some((c) => c.id === v.id));
console.log("logs deleted:", logs.every((n) => !existsSync(join(RUNS, n))));
console.log("session dirs deleted:", sessionDirs(v.id).length === 0);
console.log("count restored:", after.length === before.length);

// --- guard: unknown id must not silently succeed ---
const bad = await fetch(BASE + "/api/forget", { method: "POST", headers: { "content-type": "application/json" },
  body: JSON.stringify({ conversation_id: "session-does-not-exist" }) }).then((r) => r.json());
console.log("unknown id ->", JSON.stringify(bad), "(expect empty removed)");
