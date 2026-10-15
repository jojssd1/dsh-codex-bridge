#!/usr/bin/env node
/** Does a Chinese task survive the bridge -> DSH path? */
const BASE = "http://127.0.0.1:8799";
const TASK = "请只回复四个字：编码正常";

const start = await (await fetch(BASE + "/api/run", { method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ task: TASK, cwd: process.cwd(), timeout_ms: 180000 }) })).json();
console.log("sent  :", JSON.stringify(TASK));
console.log("run_id:", start.run_id);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let run;
for (let i = 0; i < 20; i++) {
  await sleep(2000);
  const list = await (await fetch(BASE + "/api/runs")).json();
  run = list.find((x) => x.id === start.run_id);
  if (run && run.status !== "running") break;
}
console.log("status:", run.status, "blocks:", (run.blocks || []).length);
for (const b of run.blocks || []) {
  if (b.kind === "final") console.log("reply :", JSON.stringify(b.text));
  if (b.kind === "msg")   console.log("  msg :", JSON.stringify(String(b.text).slice(0, 120)));
}
// what actually reached the DSH process?
const raw = await (await fetch(BASE + "/api/runs")).json();
console.log("ok = reply matches expectation:", (run.blocks || []).some((b) => b.kind === "final" && b.text.includes("编码正常")));
