#!/usr/bin/env node
/** Fresh server on a private port: does image harvesting actually work? */
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = 9010 + Math.floor(Math.random() * 60);
const BASE = "http://127.0.0.1:" + PORT;
console.log("demo_plot.png exists:", existsSync(join(HERE, "demo_plot.png")));

const srv = spawn(process.execPath, [join(HERE, "dsh-mcp-server.mjs")], {
  stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  env: { ...process.env, DSH_DASHBOARD_PORT: String(PORT) },
});
srv.stderr.on("data", (d) => process.stderr.write("[srv] " + d));
srv.stdout.on("data", () => {});
console.log("server pid:", srv.pid, "port:", PORT);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let up = false;
for (let i = 0; i < 40; i++) { try { if ((await fetch(BASE + "/api/conversations")).ok) { up = true; break; } } catch {} await sleep(250); }
console.log("up:", up);
if (!up) { spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { stdio: "ignore" }); process.exit(1); }

const page = await (await fetch(BASE + "/")).text();
console.log("page has imgHtml:", page.includes("imgHtml"), "| has /api/file:", page.includes("/api/file"));

const send = (b) => fetch(BASE + "/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const convs = () => fetch(BASE + "/api/conversations").then((r) => r.json());

await send({ message: "运行 shell 命令查看 demo_plot.png 的大小，只回复大小。", cwd: HERE, timeout_ms: 300000 });
let v;
for (let i = 0; i < 25; i++) { await sleep(2000); v = (await convs())[0]; if (v && v.status !== "running") break; }
console.log("status:", v.status);

let imgs = [];
for (const b of v.blocks) { if (b.images && b.images.length) { imgs = imgs.concat(b.images); } }
console.log("harvested:", JSON.stringify(imgs));

if (imgs.length) {
  const ok = await fetch(BASE + "/api/file?path=" + encodeURIComponent(imgs[0]));
  console.log("GET /api/file ->", ok.status, ok.headers.get("content-type"), (await ok.arrayBuffer()).byteLength, "bytes");
  const bad = await fetch(BASE + "/api/file?path=" + encodeURIComponent("C:/Windows/win.ini"));
  console.log("unrelated path ->", bad.status, "(expect 403)");
} else {
  console.log("RAW BLOCK DUMP:");
  for (const b of v.blocks) console.log("  " + JSON.stringify(b).slice(0, 220));
}
spawnSync("taskkill", ["/PID", String(srv.pid), "/T", "/F"], { stdio: "ignore" });
process.exit(0);
