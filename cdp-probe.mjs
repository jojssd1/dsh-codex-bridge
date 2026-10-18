
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const EDGE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const PORT = 9222;
const URL = "http://127.0.0.1:8799/";

const child = spawn(EDGE, [
  "--headless=new", "--disable-gpu", "--no-first-run", "--no-default-browser-check",
  "--remote-debugging-port=" + PORT,
  "--user-data-dir=" + process.env.TEMP + "\\edge-dsh-profile",
  "about:blank",
], { stdio: "ignore", detached: false });
await sleep(4000);

async function json(path, init) {
  const r = await fetch("http://127.0.0.1:" + PORT + path, init);
  return r.json();
}
let targets;
try { targets = await json("/json/list"); }
catch (e) { console.log("CDP 连不上:", e.message); child.kill(); process.exit(1); }

let page = targets.find((t) => t.type === "page");
if (!page) { console.log("没有 page target"); child.kill(); process.exit(1); }

// use raw WebSocket via undici
// Node 22+ ships a global WebSocket
const sock = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => { sock.addEventListener("open", res); sock.addEventListener("error", rej); });

let id = 0;
const pending = new Map();
const logs = [];
sock.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Runtime.consoleAPICalled") {
    logs.push("[" + m.params.type + "] " + m.params.args.map((a) => a.value ?? a.description ?? a.type).join(" "));
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    logs.push("[EXCEPTION] " + (d.exception?.description || d.text));
  }
  if (m.method === "Log.entryAdded") {
    logs.push("[log:" + m.params.entry.level + "] " + m.params.entry.text);
  }
});
function send(method, params = {}) {
  return new Promise((res) => { const i = ++id; pending.set(i, res); sock.send(JSON.stringify({ id: i, method, params })); });
}
await send("Runtime.enable");
await send("Log.enable");
await send("Page.enable");
await send("Page.navigate", { url: URL });
await sleep(6000);

// what does the page look like now?
const r1 = await send("Runtime.evaluate", { expression:
  "JSON.stringify({title:document.title, items:document.querySelectorAll('#list .item').length, " +
  "threadHTML:(document.getElementById('thread')||{}).innerHTML ? document.getElementById('thread').innerHTML.length : -1, " +
  "hTitle:(document.getElementById('h-title')||{}).textContent, " +
  "esReady:typeof convs!=='undefined'?Object.keys(convs).length:-1})", returnByValue: true });
console.log("页面状态:", r1.result?.result?.value);

// click the first conversation, like a user would
const r2 = await send("Runtime.evaluate", { expression:
  "(()=>{var it=document.querySelector('#list .item'); if(!it) return 'no item'; it.click(); return 'clicked '+it.getAttribute('data-id');})()",
  returnByValue: true });
console.log("点击:", r2.result?.result?.value);
await sleep(5000);

const r3 = await send("Runtime.evaluate", { expression:
  "JSON.stringify({threadLen:(document.getElementById('thread')||{}).innerHTML.length, " +
  "rows:(document.getElementById('thread')||{}).querySelectorAll('.ln,.band,.turn').length, " +
  "hTitle:(document.getElementById('h-title')||{}).textContent})", returnByValue: true });
console.log("点击后:", r3.result?.result?.value);

console.log("\n===== Console 输出 (" + logs.length + " 条) =====");
logs.slice(0, 40).forEach((l) => console.log("  " + l.slice(0, 300)));
sock.close(); child.kill();
