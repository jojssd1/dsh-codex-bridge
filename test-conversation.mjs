#!/usr/bin/env node
/** Two turns in ONE conversation: does the subagent keep context, and does the
 *  thread accumulate instead of spawning a new sidebar entry? */
const BASE = "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (body) => fetch(BASE + "/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }).then((r) => r.json());
const convs = () => fetch(BASE + "/api/conversations").then((r) => r.json());
const waitDone = async (id) => {
  for (let i = 0; i < 30; i++) {
    await sleep(2000);
    const v = (await convs()).find((x) => x.id === id);
    if (v && v.status !== "running") return v;
  }
  return (await convs()).find((x) => x.id === id);
};

console.log("=== turn 1: start a new subagent ===");
console.log("POST /api/send ->", JSON.stringify(await send({ message: "记住一个口令：PURPLE-77。只回复两个字：收到", cwd: process.cwd(), timeout_ms: 300000 })));
let all = await convs();
for (let i = 0; i < 30 && !all.length; i++) { await sleep(1000); all = await convs(); }
const id = all[0].id;
console.log("conversation id:", id);
let v = await waitDone(id);
console.log("status:", v.status, "| blocks:", v.blocks.length, "| title:", JSON.stringify(v.title));

console.log("\n=== turn 2: SAME conversation, different message ===");
console.log("POST /api/send ->", JSON.stringify(await send({ message: "我刚才让你记住的口令是什么？只回复那个口令。", conversation_id: id, timeout_ms: 300000 })));
v = await waitDone(id);

console.log("\nconversation count:", (await convs()).length, "(must stay 1)");
console.log("blocks:", v.blocks.length);
for (const b of v.blocks) {
  if (b.kind === "user") console.log("  [user]  " + JSON.stringify(String(b.text).slice(0, 50)));
  else if (b.kind === "final") console.log("  [final] " + JSON.stringify(String(b.text).slice(0, 50)));
  else if (b.kind === "tool") console.log("  [tool]  " + b.name + " / " + b.status);
  else if (b.kind === "think") console.log("  [think] " + JSON.stringify(String(b.text).slice(0, 45)));
}
const finals = v.blocks.filter((b) => b.kind === "final").map((b) => String(b.text));
console.log("\nuser turns:", v.blocks.filter((b) => b.kind === "user").length, "(expect 2)");
console.log("CONTEXT KEPT:", finals.some((t) => t.includes("PURPLE-77")));
