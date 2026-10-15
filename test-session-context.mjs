#!/usr/bin/env node
/** Foundation test: does --session-id actually preserve context? */
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const INSTALL = process.env.DSH_INSTALL_ROOT ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "DeepSeek Harness");
const EXE = join(INSTALL, "DeepSeek Harness.exe");
const CLI = join(INSTALL, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
const HERE = dirname(fileURLToPath(import.meta.url));

function run(task, sessionId) {
  return new Promise((resolve) => {
    const args = ["--expose-internals", CLI, "--profile", "headless", "--json"];
    if (sessionId) args.push("--session-id", sessionId);
    args.push(task);
    const c = spawn(EXE, args, { cwd: HERE, env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true });
    let out = "", buf = "", sid = null, final = null, types = [];
    c.stdout.on("data", (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        types.push(ev.type);
        if (ev.type === "session") sid = ev.sessionId;
        if (ev.type === "final") final = ev.text;
      }
    });
    c.stderr.on("data", (d) => (out += d));
    c.on("close", (code) => resolve({ sid, final, code, err: out, types }));
  });
}

console.log("--- turn 1: teach it a secret ---");
const a = await run("请记住一个口令: ORANGE-42。只回复两个字：收到");
console.log("sessionId:", a.sid, "| final:", JSON.stringify(a.final), "| exit:", a.code);
console.log("event types:", [...new Set(a.types)].join(","));

console.log("\n--- turn 2: same session, ask for the secret ---");
const b = await run("我刚才让你记住的口令是什么？只回复那个口令。", a.sid);
console.log("sessionId:", b.sid, "| final:", JSON.stringify(b.final), "| exit:", b.code);

console.log("\nCONTEXT PRESERVED:", !!(b.final && b.final.includes("ORANGE-42")));
console.log("same session id:", a.sid === b.sid);
