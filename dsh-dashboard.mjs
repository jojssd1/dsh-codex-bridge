#!/usr/bin/env node
/**
 * Standalone dashboard: runs the HUB in the foreground so you can watch
 * conversations without Codex. Any MCP server already running joins this hub
 * instead of starting its own, so both share one board.
 */
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.DSH_DASHBOARD_PORT ?? 8799);

const hub = spawn(process.execPath, [join(HERE, "dsh-mcp-server.mjs"), "--hub"], {
  stdio: "inherit",
  windowsHide: true,
  env: { ...process.env, DSH_DASHBOARD_PORT: String(PORT) },
});

console.log("");
console.log("  DSH hub  ->  http://127.0.0.1:" + PORT);
console.log("  Codex 的 MCP server 会自动加入这个 hub；Ctrl+C 停止");
console.log("");

hub.on("exit", (code) => process.exit(code ?? 0));
