#!/usr/bin/env node
/** Make a real PNG, then check the dashboard harvests and serves it. */
import { writeFileSync } from "node:fs";
import { deflateSync } from "node:zlib";
import { join } from "node:path";

/* ---- minimal PNG encoder ---- */
const T = (() => { const t = new Int32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c; } return t; })();
const crc32 = (b) => { let c = -1; for (const x of b) c = T[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(w, h, px) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      raw[o] = Math.round(255 * x / w);
      raw[o + 1] = Math.round(255 * y / h);
      raw[o + 2] = 140;
    }
  }
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}
const IMG = join(process.cwd(), "demo_plot.png");
writeFileSync(IMG, png(480, 240));
console.log("wrote", IMG);

/* ---- drive the dashboard ---- */
const BASE = "http://127.0.0.1:8799";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const send = (b) => fetch(BASE + "/api/send", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) }).then((r) => r.json());
const convs = () => fetch(BASE + "/api/conversations").then((r) => r.json());

const before = (await convs()).map((c) => c.id);
await send({ message: "运行 shell 命令查看 demo_plot.png 的文件大小，只回复大小。", cwd: process.cwd(), timeout_ms: 300000 });
let v;
for (let i = 0; i < 25; i++) { await sleep(2000); const l = await convs(); v = l.find((c) => !before.includes(c.id)); if (v && v.status !== "running") break; }
if (!v) { console.log("no new conversation"); process.exit(1); }
console.log("conversation:", v.id, "status:", v.status);

let imgs = [];
for (const b of v.blocks) if (b.images && b.images.length) imgs = imgs.concat(b.images);
console.log("images harvested:", JSON.stringify(imgs));

if (imgs.length) {
  const r = await fetch(BASE + "/api/file?path=" + encodeURIComponent(imgs[0]));
  console.log("GET /api/file ->", r.status, r.headers.get("content-type"), (await r.arrayBuffer()).byteLength + " bytes");
  const bad = await fetch(BASE + "/api/file?path=" + encodeURIComponent("C:/Windows/win.ini"));
  console.log("unrelated path blocked ->", bad.status);
}
console.log("\nblocks:");
for (const b of v.blocks) console.log("  [" + b.kind + "] " + String(b.text ?? b.name ?? "").slice(0, 40).replace(/\n/g," ") + (b.images && b.images.length ? "   <" + b.images.length + " img>" : ""));
