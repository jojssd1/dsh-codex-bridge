#!/usr/bin/env node
/**
 * MCP stdio server exposing the DeepSeek Harness headless runtime to Codex,
 * with real-time progress.
 *
 * Progress reaches the caller three ways, so at least one always works:
 *   1. JSON-RPC notifications/progress + notifications/message during a run
 *   2. dsh_start / dsh_status / dsh_result -> pull-based, works in any client
 *   3. a per-run NDJSON log file the user can tail in a terminal
 *
 * stdout is the protocol channel only; diagnostics go to stderr.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, readdirSync, readFileSync, existsSync, statSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join } from "node:path";

const HERE = import.meta.dirname;
const INSTALL =
  process.env.DSH_INSTALL_ROOT ??
  join(process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local"), "Programs", "DeepSeek Harness");
const EXE = join(INSTALL, "DeepSeek Harness.exe");
const CLI = join(INSTALL, "resources", "app.asar", "dsh", "node_modules", "@deepseek-ai", "dsh-desktop-host", "lib", "cli.js");
const RUNS_DIR = join(homedir(), ".dsh-codex-bridge", "runs");
const PROJCACHE_DIR = join(homedir(), ".dsh", "storages", "session_projcache", "sessions");
const BRIDGE_DIR = join(homedir(), ".dsh-codex-bridge");
const HUB_STATE = join(BRIDGE_DIR, "hub.json");
/* Codex spawns one MCP server per conversation, but only one process can own the
   dashboard port. So the dashboard runs as a detached HUB process and every MCP
   server merely forwards to it. Same file, two roles: --hub serves, default forwards. */
const HUB_MODE = process.argv.includes("--hub");
const INSTANCE_ID = "inst-" + Math.random().toString(36).slice(2, 8);
const instances = new Map();          // instanceId -> lastSeen (hub side)
let forwarding = false;               // MCP side: am I forwarding to a hub?
const DEFAULT_TIMEOUT_MS = Number(process.env.DSH_MCP_TIMEOUT_MS ?? 1800000);

/**
 * Codex launches this server with an explicit env block, so only the variables
 * listed under [mcp_servers.dsh.env] reach us -- the machine's user-level
 * environment is NOT inherited. DSH's headless profile resolves the provider key
 * from OPENCODE_GO_API_KEY, so without this the delegated run dies instantly with
 * MISSING_CREDENTIAL and the caller only sees an empty turn.
 *
 * Values are read from the user-level environment (set them once with
 * setx, or via the DSH Models page) and merged in. Nothing is written to disk
 * here, so no secret ends up in a config file.
 */
const CREDENTIAL_ENV = ["OPENCODE_GO_API_KEY", "DEEPSEEK_API_KEY", "ARK_API_KEY",
                        "HETU_API_KEY", "CATBEE_API_KEY"];
function healEnv() {
  const missing = CREDENTIAL_ENV.filter((k) => !process.env[k]);
  if (!missing.length) return [];
  const healed = [];
  if (process.platform === "win32") {
    // ONE registry read, not one PowerShell process per key. Each PowerShell start
    // costs ~100ms and four credentials are typically absent from an MCP server's
    // environment, so the old loop burned ~400ms of every startup -- on top of
    // rehydration, which competes for exactly the same window.
    try {
      const out = spawnSync("reg", ["query", "HKCU\\Environment"],
        { encoding: "utf8", timeout: 8000, windowsHide: true }).stdout ?? "";
      const vals = new Map();
      for (const line of out.split(/\r?\n/)) {
        const m = line.match(/^\s{4}(\S+)\s+REG_(?:SZ|EXPAND_SZ)\s+(.*)$/);
        if (m) vals.set(m[1], m[2].trim());
      }
      for (const k of missing) {
        const v = vals.get(k);
        if (v) { process.env[k] = v; healed.push(k); }
      }
      if (healed.length) return healed;
    } catch {}
    // Fallback only when the registry read produced nothing usable.
    try {
      for (const k of missing) {
        try {
          const v = spawnSync("powershell",
            ["-NoProfile", "-NonInteractive", "-Command",
             "[Environment]::GetEnvironmentVariable('" + k + "','User')"],
            { encoding: "utf8", timeout: 8000, windowsHide: true }).stdout?.trim();
          if (v) { process.env[k] = v; healed.push(k); }
        } catch {}
      }
    } catch {}
  }
  return healed;
}
const HEALED = healEnv();
const MAX_EVENTS = 400;

const log = (...a) => process.stderr.write("[dsh-mcp] " + a.join(" ") + "\n");
const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");

/* ------------------------------------------------------------------ runs */
let seq = 0;
const runs = new Map();
// Backtick, quotes, braces and friends are NOT path characters: a JSON dump like
// `"file": "x.png"` used to drag the closing quote (or a template backtick) into
// the captured path, producing a broken <img> for a file that never existed.
const IMG_RE = /[A-Za-z]:\\[^\s"'`<>|?*{}()\[\],;:]+?\.(?:png|jpe?g|gif|webp|bmp|svg)|[^\s"'`<>|?*{}()\[\],;:]+?\.(?:png|jpe?g|gif|webp|bmp|svg)/gi;
const servedImages = new Set(); // only paths that actually appeared in a conversation
const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif",
               webp: "image/webp", bmp: "image/bmp", svg: "image/svg+xml" };

/**
 * DSH's headless projection flattens every content block to text, so images can
 * never arrive as data. What does survive is the FILE PATH the agent wrote or
 * read, so harvest those and serve them back over the dashboard.
 */
// A cheap boolean test run before the path regex. Rehydration walks tens of
// thousands of tool inputs and results, and the overwhelming majority contain no
// image at all; scanning each megabyte string with the path regex (and stat-ing
// every match) cost 3.5s of startup on a 38MB log directory.
const IMG_HINT = /\.(?:png|jpe?g|gif|webp|bmp|svg)\b/i;
/** False on MCP-only processes: Codex never renders images, but the dashboard does. */
let REPLAY_IMAGES = true;
function collectImages(...texts) {
  const found = [];
  for (const t of texts) {
    if (t == null) continue;
    const s = typeof t === "string" ? t : JSON.stringify(t);
    if (!IMG_HINT.test(s)) continue;
    for (const m of String(s).matchAll(IMG_RE)) {
      let p = m[0].replace(/[.,;:)\]]+$/, "").replace(/^[\s"'`]+|[\s"'`]+$/g, "");
      if (!p || found.includes(p)) continue;
      const abs = p.match(/^[A-Za-z]:[\\/]/) ? p : join(cwdOfRun, p);
      // A path that only LOOKS like an image must not become a broken <img>:
      // DSH prints planned/attempted filenames all the time, and a missing file
      // renders as a torn icon that reads like a failure.
      try { if (!statSync(abs).isFile()) continue; } catch { continue; }
      if (!servedImages.has(abs)) servedImages.add(abs);
      found.push(abs);
    }
  }
  return found;
}
let cwdOfRun = process.cwd();

const conversations = new Map(); // sessionId -> one subagent with persistent context
const sessionCwd = new Map();    // sessionId -> the directory DSH recorded it in
const activeBySession = new Map(); // sessionId -> the run currently writing it

/**
 * DSH refuses to resume a session from a different cwd, so a resume must reuse
 * the directory the session was recorded in. Ask the in-memory map first, then
 * fall back to scanning the run logs (which survive restarts and are shared by
 * every MCP instance).
 */
function cwdForSession(sessionId) {
  if (!sessionId) return null;
  const live = sessionCwd.get(sessionId) ?? conversations.get(sessionId)?.cwd;
  if (live) return live;
  try {
    for (const n of readdirSync(RUNS_DIR)) {
      if (!n.endsWith(".jsonl")) continue;
      let raw = "";
      try { raw = readFileSync(join(RUNS_DIR, n), "utf8"); } catch { continue; }
      if (!raw.includes(sessionId)) continue;
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let ev; try { ev = JSON.parse(line); } catch { continue; }
        const cw = ev.type === "session" ? ev.cwd : ev.type === "bridge_meta" ? ev.cwd : null;
        if (cw) { sessionCwd.set(sessionId, cw); return cw; }
      }
    }
  } catch {}
  return null;
}
function convFor(sessionId, cwd) {
  let conv = conversations.get(sessionId);
  if (!conv) {
    conv = { id: sessionId, cwd, baseBlocks: [], status: "running",
             createdAt: Date.now(), updatedAt: Date.now(), run: null, logs: [] };
    conversations.set(sessionId, conv);
  }
  if (cwd) conv.cwd = cwd;
  return conv;
}
function userBlock(text) {
  return { kind: "user", id: "u" + Math.random().toString(36).slice(2, 9), text: String(text) };
}
/** Frozen history of earlier turns + the in-flight turn, newest last. */
/**
 * DSH already tracks context pressure per session and exposes it in the session
 * projection cache. Reading it gives the orchestrator the same picture the desktop
 * app shows: how much of the window is consumed and what consumes it, split into
 * system / tool-definitions / messages.
 *
 *   contextPressure  {surfaceTokens, contextWindow, pressureTokens}
 *   contextBreakdown {breakdown:{systemTokens, toolsTokens, messageTokens}}
 *   tokenUsage       {totals:{...}, last:{turn,step,buckets}}
 *
 * The file is a small JSON projection updated as the session runs, so it is cheap
 * to stat and re-read; results are cached for a second to survive 1 Hz polling.
 */
const _ctxCache = new Map();   // sessionId -> {at, data}
function readContext(sessionId) {
  if (!sessionId) return null;
  const hit = _ctxCache.get(sessionId);
  const now = Date.now();
  if (hit && now - hit.at < 1000) return hit.data;
  let data = null;
  try {
    const p = join(PROJCACHE_DIR, sessionId + ".json");
    const st = statSync(p);
    if (hit && hit.mtimeMs === st.mtimeMs) { hit.at = now; return hit.data; }
    const rows = JSON.parse(readFileSync(p, "utf8"))?.record?.rows ?? {};
    const pressure = rows.contextPressure?.val ?? null;
    const bd = rows.contextBreakdown?.val?.breakdown ?? null;
    const usage = rows.tokenUsage?.val ?? null;
    if (pressure || bd || usage) {
      data = {
        surface: pressure?.surfaceTokens ?? bd?.messageTokens ?? null,
        window: pressure?.contextWindow ?? null,
        pressure: pressure?.pressureTokens ?? null,
        system: bd?.systemTokens ?? null,
        tools: bd?.toolsTokens ?? null,
        messages: bd?.messageTokens ?? null,
        totals: usage?.totals ?? null,
        last: usage?.last ?? null,
      };
    }
    _ctxCache.set(sessionId, { at: now, data, mtimeMs: st.mtimeMs });
  } catch (e) {
    _ctxCache.set(sessionId, { at: now, data: null, mtimeMs: 0 });
  }
  return data;
}

/**
 * Image paths are harvested from tool input/result text, which means a regex over
 * every event plus a statSync per hit. Doing that while rehydrating 38MB of logs
 * dominated startup (3.5s); doing it for only the conversations actually opened
 * costs nothing measurable.
 */
function ensureImages(conv) {
  if (conv.imagesDone) return;
  conv.imagesDone = true;
  for (const blk of conv.baseBlocks) {
    if (blk.kind !== "tool" || (blk.images && blk.images.length)) continue;
    blk.images = collectImages(blk.input, blk.result);
  }
}

function conversationView(conv) {
  ensureImages(conv);
  let blocks = conv.baseBlocks.slice();
  if (conv.run) blocks = blocks.concat([conv.run.userBlock], conv.run.blocks);
  const firstUser = blocks.find((b) => b.kind === "user");
  return {
    id: conv.id, sessionId: conv.id, cwd: conv.cwd,
    title: firstUser ? String(firstUser.text).slice(0, 70) : "(新会话)",
    status: conv.run ? conv.run.status : conv.status,
    createdAt: conv.createdAt, updatedAt: conv.updatedAt,
    elapsed: conv.run ? ((conv.run.endedAt ?? Date.now()) - conv.run.startedAt) / 1000 : 0,
    calls: blocks.filter((b) => b.kind === "tool").length,
    context: readContext(conv.id),
    blocks,
  };
}

/** Same fields as conversationView minus the blocks: cheap enough to send 1 Hz. */
function conversationBrief(conv) {
  const v = conversationView(conv);
  delete v.blocks;
  // context is kept: it is a handful of numbers and drives the per-row meter
  v.nBlocks = (conv.baseBlocks.length + (conv.run ? conv.run.blocks.length + 1 : 0));
  v.calls = conv.baseBlocks.filter((b) => b.kind === "tool").length
    + (conv.run ? conv.run.blocks.filter((b) => b.kind === "tool").length : 0);
  return v;
}

function summarize(ev) {
  switch (ev.type) {
    case "session": return "session " + ev.sessionId;
    case "status":
      if (ev.phase === "turn_start") return "turn " + ev.turn + " started";
      if (ev.phase === "step_start") return "step " + ev.turn + "." + ev.step;
      if (ev.phase === "step_end") return "step " + ev.turn + "." + ev.step + " done (" + (ev.usage?.totalTokens ?? "?") + " tok)";
      if (ev.phase === "turn_end") return "turn " + ev.turn + " ended (" + (ev.reason?.kind ?? "") + ")";
      return String(ev.phase);
    case "tool_call": return "-> " + ev.tool + ": " + JSON.stringify(ev.input).slice(0, 160);
    case "tool_result": return "<- " + ev.status + ": " + String(ev.result ?? "").slice(0, 160);
    case "text": return ev.text;
    case "thinking": return "\u601d\u8003: " + String(ev.text).slice(0, 120);
    case "error": return "! " + String(ev.message ?? "").slice(0, 160);
    case "final": return "final";
    default: return String(ev.type);
  }
}

/** Refuse to start a second writer on a session DSH still owns. Returns error text or null. */
async function guardSession(sid, waitMs) {
  if (!sid) return null;
  const busy = await waitWhileBusy(sid, waitMs);
  if (!busy) return null;
  // A bare refusal is a trap: when the goal is to STOP the run, "wait for it" is
  // the wrong advice and dsh_cancel looked like the only escape. Cancel is not
  // destructive of finished work -- files the tools already wrote stay on disk.
  return text("subagent " + sid + " is still working (run " + busy.id + ", " +
    Math.round((Date.now() - busy.startedAt) / 1000) + "s in).\n" +
    "DSH allows only one writer per session, so a new message cannot attach to a running turn.\n\n" +
    "  STOP it:        dsh_cancel " + busy.id + "\n" +
    "                  Kills only the in-flight turn. Files the tools already wrote stay on disk,\n" +
    "                  and the log keeps everything up to that point. Then dsh_send your follow-up.\n" +
    "  COLLECT it:     dsh_status " + busy.id + " (progress) / dsh_result " + busy.id + " (final answer)\n" +
    "  JUST WAIT:      dsh_status " + busy.id + " with wait_ms, or retry dsh_send later", true);
}
async function waitWhileBusy(sessionId, waitMs) {
  const active = activeBySession.get(sessionId);
  if (!active || active.status !== "running") return null;
  await waitFor(active, waitMs);
  const still = activeBySession.get(sessionId);
  return still && still.status === "running" ? still : null;
}

// The opencode-go models declare reasoningEfforts off/high/max only. A level the
// route does not declare fails the whole run with UNSUPPORTED_REASONING_EFFORT, so
// the accepted set is the declared set -- not the set that sounds reasonable.
const REASONING_LEVELS = ["off", "high", "max"];
/** Full ordering the protocol can express, used to snap an undeclared level. */
const REASONING_ORDER = ["off", "low", "medium", "high", "max"];
function nearestReasoning(level) {
  if (REASONING_LEVELS.includes(level)) return level;
  const want = REASONING_ORDER.indexOf(level);
  if (want < 0) return "off";
  let best = REASONING_LEVELS[0], bestD = Infinity;
  for (const cand of REASONING_LEVELS) {
    const d = Math.abs(REASONING_ORDER.indexOf(cand) - want);
    if (d < bestD) { bestD = d; best = cand; }
  }
  return best;
}
/** Write a one-line overlay selecting the requested effort. Cached per level. */
const _patchCache = new Map();
function reasoningPatch(level) {
  if (!level) return null;
  const lv = String(level).toLowerCase();
  if (!REASONING_LEVELS.includes(lv)) return null;
  if (_patchCache.has(lv)) return _patchCache.get(lv);
  try {
    mkdirSync(BRIDGE_DIR, { recursive: true });
    const p = join(BRIDGE_DIR, "reasoning-" + lv + ".yml");
    // A patch REPLACES the entry's config rather than merging into it, so the
    // provider and model have to be restated or startup fails validation with
    // "$.provider missing required value".
    writeFileSync(p, [
      "- id: agent-default-model",
      '  name: "@deepseek-ai/dsh-agent-default-model"',
      "  config:",
      "    provider: opencode-go",
      "    model: deepseek-v4.1-flash",
      '    reasoningEffort: "' + lv + '"',
      "",
    ].join("\n"), "utf8");
    _patchCache.set(lv, p);
    return p;
  } catch (e) { log("reasoning patch failed: " + e.message); return null; }
}

/**
 * The execution contract. A skill on disk is only *available* -- whether a
 * subagent loads it is its own decision, and measurement showed it did so in
 * only 2 of 70 recent runs, while 20% still burned 10-20 minutes in a single
 * blocking job_output {wait:true}. Prepending this marker makes loading the
 * contract part of the task rather than an option.
 *
 * It is prepended to the WIRE task only: userMessage (which titles the dashboard
 * conversation and is written to the log) stays clean.
 */
const CONTRACT_ENABLED = process.env.DSH_CONTRACT !== "0";
const CONTRACT = "[执行契约] 本任务由 Codex 经 DSH 桥派发。动手前先调用 skill 工具加载 "
  + "`dsh-execution-contract` 并严格遵守其四模式、白名单与返回格式；"
  + "缺少 cwd / 输出目录 / runner 时只报告缺失项，不得自行扫描目录寻找答案。\n\n";

/**
 * Windows reports a bad working directory as ENOENT *naming the executable*, so a
 * path that lost its backslashes looks exactly like a missing install -- and that
 * misdirection costs real time. Check both before spawning and say which is wrong.
 */
function preflightRun(dir) {
  if (!existsSync(EXE)) return "executable not found: " + EXE;
  if (!existsSync(dir)) {
    // C:UsersAdmin01Desktop... is the signature of a Windows path that went
    // through a shell which consumed the separators.
    const stripped = /^[A-Za-z]:[^\\/]/.test(dir);
    return "cwd does not exist: " + JSON.stringify(dir)
      + (stripped
        ? "\n  Every separator is missing from that path. A Windows path most likely"
          + " passed through a shell that ate the backslashes -- send it JSON-escaped"
          + " (\\\\) or use forward slashes (/)."
        : "");
  }
  return null;
}

/** A run that dies before spawning still gets an id, a log, and a readable reason. */
function blockedRun({ task, cwd, why, userMessage }) {
  const id = "run-" + (++seq) + "-" + Date.now().toString(36);
  mkdirSync(RUNS_DIR, { recursive: true });
  const logPath = join(RUNS_DIR, id + ".jsonl");
  const now = Date.now();
  try {
    writeFileSync(logPath, [
      JSON.stringify({ type: "bridge_meta", task: String(userMessage ?? task), cwd, startedAt: now, ts: now }),
      JSON.stringify({ type: "bridge_stderr", text: why + "\n", ts: now }),
      JSON.stringify({ type: "bridge_exit", code: -1, signal: null, timedOut: false,
                       detached: false, killed: false, stderrBytes: why.length, ts: now }),
      "",
    ].join("\n"), "utf8");
  } catch (e) { log("blockedRun: " + e.message); }
  const state = {
    id, task, userBlock: null, conv: null, cwd, logPath, child: null,
    startedAt: now, endedAt: now, events: [], blocks: [], finalText: null,
    exitCode: -1, status: "failed", stderr: why, timedOut: false, detached: false,
    killed: false, sessionId: null, listeners: [], lastTextAt: 0,
  };
  runs.set(id, state);
  log("run " + id + " blocked: " + why.split("\n")[0]);
  return state;
}

function startRun({ task, cwd, session_id, timeout_ms, userMessage, reasoning, contract }) {
  // A resume must land in the session's own directory, not the bridge's.
  const resumeCwd = session_id ? cwdForSession(session_id) : null;
  if (resumeCwd && !cwd) cwd = resumeCwd;
  if (resumeCwd && cwd && resumeCwd !== cwd) {
    log("run: cwd override " + cwd + " -> " + resumeCwd + " (session was recorded there)");
    cwd = resumeCwd;
  }
  const bad = preflightRun(cwd || process.cwd());
  if (bad) return blockedRun({ task, cwd: cwd || process.cwd(), why: bad, userMessage });

  const id = "run-" + (++seq) + "-" + Date.now().toString(36);
  mkdirSync(RUNS_DIR, { recursive: true });
  const logPath = join(RUNS_DIR, id + ".jsonl");

  const args = ["--expose-internals", CLI, "--profile", "headless"];
  // Reasoning level is per-run, not a profile edit: `--patch` overlays one more
  // entry on top of the profile tree, so a trivial task can drop to "off" without
  // anyone touching a file on disk between calls.
  // --patch must come BEFORE --json: everything after --json is the task text.
  // Asking for a level the route does not declare used to kill the run at the
  // provider, after the session had already started. Rejecting it locally would
  // still fail the task; mapping it to the nearest declared level keeps the task
  // alive and is visible in the log.
  const wantedLevel = reasoning === undefined || reasoning === null ? null : String(reasoning).toLowerCase();
  const effectiveLevel = wantedLevel === null ? null : nearestReasoning(wantedLevel);
  if (wantedLevel !== null && effectiveLevel !== wantedLevel) {
    log("run: reasoning " + wantedLevel + " not declared by this route; using " + effectiveLevel);
  }
  const patchPath = reasoningPatch(effectiveLevel);
  if (patchPath) args.push("--patch", patchPath);
  args.push("--json");
  if (session_id) args.push("--session-id", String(session_id));
  args.push(contract === false || !CONTRACT_ENABLED ? task : CONTRACT + task);

  const child = spawn(EXE, args, {
    cwd: cwd || process.cwd(),
    env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" },
    windowsHide: true,
  });

  const state = {
    id, task, userBlock: null, conv: null,
    cwd: cwd || process.cwd(), logPath, child,
    startedAt: Date.now(), events: [], blocks: [], finalText: null, exitCode: null,
    status: "running", stderr: "", timedOut: false, sessionId: null,
    listeners: [], lastTextAt: 0,
  };
  runs.set(id, state);
  cwdOfRun = state.cwd;
  state.userBlock = userBlock(userMessage ?? task);
  if (session_id) { sessionCwd.set(session_id, state.cwd); activeBySession.set(session_id, state); }
  if (session_id) { state.conv = convFor(session_id, state.cwd); state.conv.run = state; }
  const stream = createWriteStream(logPath, { flags: "a" });
  // The DSH event stream never contains the prompt, so record it for replay.
  stream.write(JSON.stringify({ type: "bridge_meta", task: String(userMessage ?? task), cwd: state.cwd, startedAt: state.startedAt }) + "\n");
  publishState(state);

  const finish = (status) => {
    if (state.status !== "running") return;
    state.status = status;
    state.endedAt = Date.now();
    // NOTE: stream.end() must come AFTER the post-mortem writes below. Ending it
    // here made every bridge_exit/bridge_stderr write a no-op (and the empty catch
    // swallowed the write-after-end error), so 35 logs carried no exit record.
    for (const w of state.listeners.splice(0)) w(state);
    if (state.conv) {
      state.conv.baseBlocks = state.conv.baseBlocks.concat([state.userBlock], state.blocks);
      state.conv.status = status;
      state.conv.updatedAt = Date.now();
      state.conv.run = null;
      publish({ kind: "conv", conv: conversationView(state.conv) });
    }
    publishState(state);
    forwardStatus(state);
    // The single most useful post-mortem line: HOW did it die?
    //   code=null + signal=SIGTERM -> something outside killed it (cancel / tree kill)
    //   code=1                     -> DSH exited on its own error
    //   code=137                   -> out of memory
    try {
      stream.write(JSON.stringify({
        type: "bridge_exit", code: state.exitCode,
        signal: state.child ? state.child.signalCode : null,
        timedOut: state.timedOut, detached: state.detached === true,
        killed: state.child ? state.child.killed : null,
        stderrBytes: state.stderr.length,
      }) + "\n");
    } catch {}
    if (state.stderr.trim()) {
      try { stream.write(JSON.stringify({ type: "bridge_stderr", text: state.stderr.slice(0, 4000) }) + "\n"); } catch {}
    }
    try { stream.end(); } catch {}
    if (state.sessionId && activeBySession.get(state.sessionId) === state) activeBySession.delete(state.sessionId);
  };

  // A timeout means "stop waiting", NOT "die". Killing here destroyed real work:
  // a legitimate long regression was executed for 1200s and then thrown away, and
  // the caller was told "failed". The run now keeps going; the caller gets a run id
  // to poll with dsh_status / collect with dsh_result. dsh_cancel is the only thing
  // that kills.
  const timer = setTimeout(() => {
    if (state.status !== "running") return;
    state.timedOut = true;
    state.detached = true;
    publishState(state);
    forwardStatus(state);
    for (const w of state.listeners.splice(0)) w(state);
  }, Number.isFinite(timeout_ms) ? timeout_ms : DEFAULT_TIMEOUT_MS);
  state.timer = timer;

  let buf = "";
  child.stdout.on("data", (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      // Stamp each event as it is written. The log carried no time at all, so a
      // replayed conversation could not recover real tool durations: after a hub
      // restart every measurement read zero, and long blocking waits were
      // invisible. With ts present, replay reconstructs true timings.
      let ev;
      try { ev = JSON.parse(line); } catch { stream.write(line + "\n"); continue; }
      if (typeof ev.ts !== "number") ev.ts = Date.now();
      stream.write(JSON.stringify(ev) + "\n");
      if (ev.type === "session" && ev.sessionId) {
        state.sessionId = ev.sessionId;
        sessionCwd.set(ev.sessionId, state.cwd);
        activeBySession.set(ev.sessionId, state);
        if (!state.conv) { state.conv = convFor(ev.sessionId, state.cwd); state.conv.run = state; }
        if (state.conv && !state.conv.logs.includes(state.logPath)) state.conv.logs.push(state.logPath);
      }
      if (ev.type === "final") state.finalText = ev.text;
      state.events.push(ev);
      if (state.events.length > MAX_EVENTS) state.events.shift();
      updateBlocks(state, ev);
      forwardEvent(state, ev);
      const isText = ev.type === "text";
      const now = Date.now();
      if (!isText || now - state.lastTextAt > 300) {
        if (isText) state.lastTextAt = now;
        const msg = summarize(ev);
        publish({ kind: "blocks", runId: state.id, blocks: state.blocks, status: state.status });
        if (state.conv) {
          state.conv.updatedAt = Date.now();
          publish({ kind: "conv", conv: conversationView(state.conv) });
        }
        notifyProgress(state, msg);
      }
    }
  });
  child.stderr.on("data", (d) => (state.stderr += d));
  child.on("error", (e) => (state.stderr += "\nspawn error: " + e.message));
  child.on("close", (code) => {
    clearTimeout(timer);
    state.exitCode = code;
    finish(code === 0 ? "done" : "failed");
  });
  return state;
}

/* --------------------------------------------------- MCP progress emission */
let currentToken;   // set from params._meta.progressToken of the in-flight tools/call
let logLevel = null; // null = client has not asked for logging/setLevel

const LOG_ORDER = ["debug", "info", "notice", "warning", "error", "critical", "alert", "emergency"];
const logAllows = (level) =>
  logLevel !== null && LOG_ORDER.indexOf(level) >= LOG_ORDER.indexOf(logLevel);

/**
 * MCP gates the two notification channels differently:
 *   - notifications/progress  only when the request carried a progressToken
 *   - notifications/message   only when the client enabled logging/setLevel
 * Sending either uninvited is a spec violation and clients may drop it.
 */
function notifyProgress(state, message) {
  if (currentToken !== undefined) {
    send({ jsonrpc: "2.0", method: "notifications/progress",
      params: { progressToken: currentToken, progress: state.events.length,
                total: state.totalSteps ?? undefined, message } });
  }
  if (logAllows("info")) {
    send({ jsonrpc: "2.0", method: "notifications/message",
      params: { level: "info", logger: "dsh", data: "[" + state.id + "] " + message } });
  }
}

function waitFor(state, waitMs) {
  if (state.status !== "running") return Promise.resolve(state);
  return new Promise((resolve) => {
    state.listeners.push(resolve);
    if (Number.isFinite(waitMs)) setTimeout(() => resolve(state), waitMs);
  });
}

function progressText(state, limit = 12) {
  const evs = state.events.slice(-limit).map((e) => "  " + summarize(e));
  const secs = ((state.endedAt ?? Date.now()) - state.startedAt) / 1000;
  const calls = state.events.filter((e) => e.type === "tool_call").length;
  return [
    state.id + " [" + state.status + "] " + secs.toFixed(1) + "s, " + calls + " tool call(s)",
    "session: " + (state.sessionId ?? "(pending)"),
    "log: " + state.logPath,
    evs.length ? "recent:\n" + evs.join("\n") : "  (no events yet)",
  ].join("\n");
}

/* ------------------------------------------------------------------- tools */
const TOOLS = [
  { name: "dsh_run",
    description: "Delegate one task to a DeepSeek Harness agent and wait for the final answer. Progress streams as MCP progress/log notifications. For long tasks prefer dsh_start + dsh_status so you can report progress before the run ends.",
    inputSchema: { type: "object", properties: {
      task: { type: "string" }, cwd: { type: "string" },
      session_id: { type: "string" }, timeout_ms: { type: "integer" },
      reasoning: { type: "string", enum: ["off", "low", "medium", "high", "max"],
                   description: "Override this run only. Default comes from the profile; use 'off' for trivial mechanical work. A level this model does not declare is mapped to the nearest one it does." },
      contract: { type: "boolean",
                  description: "Default true: prepend the execution contract so the subagent loads dsh-execution-contract. Set false only for exploratory work." } },
      required: ["task"], additionalProperties: false } },
  { name: "dsh_send",
    description: "Send a message to a DSH subagent and wait for its reply. Omit conversation_id to start a new subagent; pass the conversation_id from a previous call to continue THAT subagent with its full context.",
    inputSchema: { type: "object", properties: {
      message: { type: "string" }, conversation_id: { type: "string" },
      cwd: { type: "string" }, timeout_ms: { type: "integer" },
      reasoning: { type: "string", enum: ["off", "low", "medium", "high", "max"],
                   description: "Override this run only. Default comes from the profile; use 'off' for trivial mechanical work. A level this model does not declare is mapped to the nearest one it does." },
      contract: { type: "boolean",
                  description: "Default true: prepend the execution contract so the subagent loads dsh-execution-contract. Set false only for exploratory work." } },
      required: ["message"], additionalProperties: false } },
  { name: "dsh_forget",
    description: "Destroy DSH subagent conversations so they stop accumulating. Pass conversation_id for one (deletes its logs and its persisted DSH session unless purge_session:false), or all:true to clear every conversation from the list and delete their logs. For safety all:true does NOT touch persisted DSH sessions unless you also pass purge_sessions:true.",
    inputSchema: { type: "object", properties: {
      conversation_id: { type: "string" }, all: { type: "boolean" }, purge_session: { type: "boolean" } },
      additionalProperties: false } },
  { name: "dsh_conversations",
    description: "List DSH subagent conversations (id, title, status, tool calls).",
    inputSchema: { type: "object", properties: {}, additionalProperties: false } },
  { name: "dsh_start",
    description: "Start a DSH run in the background and return immediately with a run_id.",
    inputSchema: { type: "object", properties: {
      task: { type: "string" }, cwd: { type: "string" },
      session_id: { type: "string" }, timeout_ms: { type: "integer" },
      reasoning: { type: "string", enum: ["off", "low", "medium", "high", "max"],
                   description: "Override this run only. Default comes from the profile; use 'off' for trivial mechanical work. A level this model does not declare is mapped to the nearest one it does." },
      contract: { type: "boolean",
                  description: "Default true: prepend the execution contract so the subagent loads dsh-execution-contract. Set false only for exploratory work." } },
      required: ["task"], additionalProperties: false } },
  { name: "dsh_status",
    description: "Report live progress of a DSH run: status, elapsed, tool calls, recent events, log path. Set wait_ms to block briefly for the next change.",
    inputSchema: { type: "object", properties: {
      run_id: { type: "string" }, wait_ms: { type: "integer" }, tail: { type: "integer" } },
      required: ["run_id"], additionalProperties: false } },
  { name: "dsh_result",
    description: "Wait for a DSH run to finish and return its final answer.",
    inputSchema: { type: "object", properties: {
      run_id: { type: "string" }, wait_ms: { type: "integer" } },
      required: ["run_id"], additionalProperties: false } },
  { name: "dsh_cancel",
    description: "Cancel a running DSH run.",
    inputSchema: { type: "object", properties: { run_id: { type: "string" } },
      required: ["run_id"], additionalProperties: false } },
];

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], isError });

/**
 * MCP tool results can carry image blocks, and Codex renders them. DSH's headless
 * projection flattens pictures into file paths, so read those files back and hand
 * them over as real images -- otherwise every figure the subagent produced stays
 * invisible in the orchestrator's own transcript.
 */
const IMG_MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
                   gif: "image/gif", webp: "image/webp" };
const MAX_IMGS = 4;            // per tool result
const MAX_IMG_BYTES = 700000;  // base64 inflates ~33%; keep the frame reasonable
function imageBlocks(state) {
  if (!state) return [];
  const seen = new Set(), out = [];
  for (const b of state.blocks || []) {
    for (const p of b?.images || []) {
      if (out.length >= MAX_IMGS || seen.has(p)) continue;
      seen.add(p);
      const mime = IMG_MIME[(p.split(".").pop() || "").toLowerCase()];
      if (!mime) continue;                       // svg/bmp stay text-only
      try {
        const buf = readFileSync(p);
        if (!buf.length || buf.length > MAX_IMG_BYTES) continue;
        out.push({ type: "image", data: buf.toString("base64"), mimeType: mime });
      } catch {}
    }
  }
  return out;
}
function textWithImages(t, state, isError = false) {
  const imgs = imageBlocks(state);
  const content = [{ type: "text", text: t }].concat(imgs);
  if (imgs.length) content.push({ type: "text",
    text: "(+" + imgs.length + " image(s) attached above)" });
  return { content, isError };
}
const needTask = (a) =>
  typeof a?.task === "string" && a.task.trim() !== "" ? null : text("task must be a non-empty string", true);
const needRun = (a) => runs.get(a?.run_id) ?? null;

async function callTool(name, args) {
  if (name === "dsh_run") {
    const bad = needTask(args); if (bad) return bad;
    const busy = await guardSession(args.session_id, 120000);
    if (busy) return busy;
    const s = startRun(args);
    const done = await waitFor(s, Infinity);
    let body = done.finalText ?? "";
    if (done.stderr.trim()) body += (body ? "\n\n" : "") + "[stderr]\n" + done.stderr.trim();
    if (done.timedOut) body += "\n\n[dsh-mcp] exceeded its time budget and was killed.";
    if (done.status === "running" && done.detached) {
      return text("DSH run " + done.id + " is still running (not killed). Collect it with dsh_status / dsh_result.");
    }
    if (done.status !== "done") return textWithImages("DSH run " + done.status + " (exit " + done.exitCode + ").\n\n" + (body || "(no output)"), done, true);
    return textWithImages(body || "(no output)", done);
  }
  if (name === "dsh_send") {
    if (typeof args?.message !== "string" || !args.message.trim()) return text("message must be a non-empty string", true);
    const busy = await guardSession(args.conversation_id, 120000);
    if (busy) return busy;
    const s = startRun({ task: args.message, userMessage: args.message,
                         session_id: args.conversation_id, cwd: args.cwd, timeout_ms: args.timeout_ms,
                         reasoning: args.reasoning, contract: args.contract });
    const done2 = await waitFor(s, Infinity);
    const id = done2.sessionId ?? args.conversation_id ?? "(unknown)";
    let body = done2.finalText ?? "";
    if (done2.stderr.trim()) body += (body ? "\n\n" : "") + "[stderr]\n" + done2.stderr.trim();
    const head = "[conversation " + id + "]";
    if (done2.status === "running" && done2.detached) {
      const secs = Math.round(((Date.now()) - done2.startedAt) / 1000);
      return text(head + "\nStill running after " + secs + "s -- it was NOT killed.\n" +
        "run_id: " + done2.id + "\n" +
        "Collect it later with dsh_status (progress) or dsh_result (final answer), " +
        "or dsh_cancel to stop it.");
    }
    if (done2.status !== "done") return textWithImages(head + "\nDSH turn " + done2.status + " (exit " + done2.exitCode + ").\n\n" + (body || "(no output)"), done2, true);
    return textWithImages(head + "\n" + (body || "(no output)"), done2);
  }
  if (name === "dsh_forget") {
    const purge = args?.purge_session !== false;
    const removed = [];
    // all:true keeps DSH sessions unless purge_sessions is explicitly true
    if (args?.all) { for (const cv of [...conversations.values()]) removed.push(forgetConversation(cv, args?.purge_sessions === true)); }
    else if (args?.conversation_id) {
      const cv = conversations.get(args.conversation_id);
      if (!cv) return text("unknown conversation_id: " + args.conversation_id, true);
      removed.push(forgetConversation(cv, purge));
    } else return text("pass conversation_id or all:true", true);
    return text("destroyed " + removed.length + " conversation(s), " +
      removed.reduce((a, r) => a + r.logs, 0) + " log(s), " +
      removed.reduce((a, r) => a + r.sessions, 0) + " DSH session dir(s).");
  }
  if (name === "dsh_conversations") {
    // Metadata only: a full view here would force image harvesting for every
    // conversation, which is exactly the startup cost this path must not pay.
    return text([...conversations.values()].map((c) => {
      const v = conversationBrief(c);
      return v.id + "  [" + v.status + "]  " + v.calls + " calls  " + v.title;
    }).join("\n") || "(none)");
  }
  if (name === "dsh_start") {
    const bad = needTask(args); if (bad) return bad;
    const busy = await guardSession(args.conversation_id, 120000);
    if (busy) return busy;
    const s = startRun(args);
    return text(s.id + " started\n" + progressText(s));
  }
  if (name === "dsh_status") {
    const r = needRun(args); if (!r) return text("unknown run_id: " + args?.run_id, true);
    if (Number.isFinite(args.wait_ms) && args.wait_ms > 0) await waitFor(r, args.wait_ms);
    return text(progressText(r, Number.isFinite(args.tail) ? args.tail : 12));
  }
  if (name === "dsh_result") {
    const r = needRun(args); if (!r) return text("unknown run_id: " + args?.run_id, true);
    await waitFor(r, Number.isFinite(args.wait_ms) ? args.wait_ms : Infinity);
    if (r.status === "running") return text("still running after wait\n" + progressText(r));
    let body = r.finalText ?? "";
    if (r.stderr.trim()) body += (body ? "\n\n" : "") + "[stderr]\n" + r.stderr.trim();
    if (r.status !== "done") return textWithImages("DSH run " + r.status + " (exit " + r.exitCode + ").\n\n" + (body || "(no output)"), r, true);
    return textWithImages(body || "(no output)", r);
  }
  if (name === "dsh_cancel") {
    const r = needRun(args); if (!r) return text("unknown run_id: " + args?.run_id, true);
    try { r.child.kill(); } catch {}
    return text("cancel requested for " + r.id);
  }
  return text("unknown tool: " + name, true);
}


/* ------------------------------------------------- hub-side ingest (role: hub) */
const forwardedRuns = new Map(); // runId -> { state, lastSeq, conv }
let lastActivity = Date.now();

/** Fold a batch of forwarded events into the hub's own conversation view. */
function applyIngest(body) {
  if (body?.instanceId) instances.set(body.instanceId, Date.now());
  lastActivity = Date.now();
  let applied = 0;
  for (const r of body?.runs ?? []) {
    let fr = forwardedRuns.get(r.runId);
    if (!fr) {
      const state = {
        id: r.runId, blocks: [], status: "running",
        startedAt: r.startedAt ?? Date.now(), endedAt: undefined,
        cwd: r.cwd, sessionId: r.sessionId ?? null, task: r.task,
        userBlock: userBlock(r.task ?? "(未记录的任务)"),
      };
      fr = { state, lastSeq: -1, conv: null };
      forwardedRuns.set(r.runId, fr);
    }
    if (body?.instanceId) fr.instanceId = body.instanceId;
    if (r.sessionId && !fr.state.sessionId) fr.state.sessionId = r.sessionId;
    if (r.task && (!fr.state.userBlock || fr.state.userBlock.text === "(未记录的任务)")) fr.state.userBlock = userBlock(r.task);
    if (!fr.conv && fr.state.sessionId) { fr.conv = convFor(fr.state.sessionId, fr.state.cwd); fr.conv.run = fr.state; }
    if (fr.state.cwd) cwdOfRun = fr.state.cwd;      // relative image paths resolve here
    for (const item of r.events ?? []) {
      if (typeof item.seq === "number") {
        if (item.seq <= fr.lastSeq) continue;        // idempotent: replayed batches are ignored
        fr.lastSeq = item.seq;
      }
      updateBlocks(fr.state, item.ev);
      applied++;
    }
    if (r.status && r.status !== "running" && fr.conv && fr.conv.run === fr.state) {
      fr.conv.baseBlocks = fr.conv.baseBlocks.concat([fr.state.userBlock], fr.state.blocks);
      fr.conv.status = r.status === "done" ? "done" : "failed";
      fr.conv.updatedAt = Date.now();
      fr.conv.run = null;
      publish({ kind: "conv", conv: conversationView(fr.conv) });
    } else if (fr.conv) {
      fr.conv.updatedAt = Date.now();
      publish({ kind: "conv", conv: conversationView(fr.conv) });
    }
  }
  return applied;
}

/**
 * An MCP server is the parent of the DSH processes it started. When Codex closes
 * or reloads that conversation, the process tree goes with it and the run stops
 * mid-stream without any error event. The hub used to show such runs as still
 * running forever; now a silent instance means its runs are interrupted.
 */
// Generous by default: a single long reasoning step can go minutes without an
// event, and the heartbeat only carries the instance id once the MCP servers
// run this same build. After the next Codex restart, `DSH_STALE_MS=30000` is safe.
const STALE_MS = Number(process.env.DSH_STALE_MS ?? 180000);
function interruptRun(fr, reason) {
  if (fr.state.status !== "running") return false;
  const tools = fr.state.blocks.filter((b) => b.kind === "tool").length;
  fr.state.status = "interrupted";
  fr.state.blocks.push({ kind: "error", id: "int" + fr.state.blocks.length,
    text: "任务已中断：" + reason + "。停在第 " + tools + " 次工具调用之后，再无新事件 —— " +
          "这不是模型挂起，是承载它的进程没了。" });
  if (fr.conv && fr.conv.run === fr.state) {
    fr.conv.baseBlocks = fr.conv.baseBlocks.concat([fr.state.userBlock], fr.state.blocks);
    fr.conv.status = "interrupted";
    fr.conv.updatedAt = Date.now();
    fr.conv.run = null;
    publish({ kind: "conv", conv: conversationView(fr.conv) });
  }
  return true;
}
function sweepStale() {
  const now = Date.now();
  for (const fr of forwardedRuns.values()) {
    if (fr.state.status !== "running" || !fr.instanceId) continue;
    const last = instances.get(fr.instanceId) ?? 0;
    if (now - last > STALE_MS) interruptRun(fr, "派发它的 Codex 对话已断开");
  }
}
setInterval(sweepStale, 15000).unref();

/* --------------------------------------------------- live web dashboard */
/* Zero-dependency: same process as the MCP server, so the page shows exactly
   the runs the bridge is driving. SSE pushes events as they arrive. */
const sseClients = new Set();
function publish(payload) {
  const line = "data: " + JSON.stringify(payload) + "\n\n";
  for (const res of sseClients) { try { res.write(line); } catch {} }
}
/**
 * Fold the raw DSH event stream into conversation blocks, so the page renders a
 * transcript (task -> reasoning -> tool cards -> answer) instead of a log.
 * Consecutive assistant text merges; a tool_result attaches to its tool_call.
 */
function updateBlocks(s, ev) {
  const b = s.blocks;
  const last = b[b.length - 1];
  if (ev.type === "text") {
    if (last && last.kind === "msg") { last.text += ev.text; last.images = collectImages(ev.text); }
    else b.push({ kind: "msg", id: "m" + s.blocks.length, text: ev.text });
  } else if (ev.type === "thinking") {
    // committed reasoning block; this is what makes the transcript read like a
    // real subagent rather than a bare tool log
    if (last && last.kind === "think") last.text += "\n\n" + ev.text;
    else b.push({ kind: "think", id: "k" + s.blocks.length, text: ev.text });
  } else if (ev.type === "tool_call") {
    const blk = { kind: "tool", id: ev.callId, callId: ev.callId, name: ev.tool, input: ev.input, status: "running",
             t0: typeof ev.ts === "number" ? ev.ts : Date.now(),
             images: REPLAY_IMAGES ? collectImages(ev.input) : [] };
    b.push(blk);
    // Pairing a result with its call by scanning backwards is quadratic: 10k
    // results over hundred-block conversations copied millions of elements while
    // rehydrating. Keep an index instead.
    (s.toolIdx || (s.toolIdx = new Map())).set(ev.callId, blk);
  } else if (ev.type === "tool_result") {
    const t = (s.toolIdx || (s.toolIdx = new Map())).get(ev.callId);
    if (t) {
      t.status = ev.status; t.result = ev.result;
      t.images = REPLAY_IMAGES ? collectImages(ev.result) : [];
      // the DSH event stream carries no timestamps, so timing is measured here,
      // at the moment each half of the call is folded
      t.t1 = typeof ev.ts === "number" ? ev.ts : Date.now();
      t.ms = t.t0 ? Math.max(0, t.t1 - t.t0) : 0;
    }
    else b.push({ kind: "tool", id: ev.callId, callId: ev.callId, name: "tool", status: ev.status, result: ev.result });
  } else if (ev.type === "status" && ev.phase === "step_start") {
    b.push({ kind: "step", id: "s" + ev.turn + "_" + ev.step, turn: ev.turn, step: ev.step });
  } else if (ev.type === "status" && ev.phase === "step_end") {
    const st = [...b].reverse().find((x) => x.kind === "step" && x.turn === ev.turn && x.step === ev.step);
    if (st) st.usage = ev.usage;
  } else if (ev.type === "bridge_exit" && ev.code !== 0) {
    const how = ev.signal ? ("信号 " + ev.signal) : ("退出码 " + ev.code);
    const why = ev.timedOut ? "超过桥的时间上限被终止"
      : (ev.signal === "SIGTERM" || ev.signal === "SIGKILL") ? "被外部终止（cancel 或进程树被清）"
      : (ev.code === 137) ? "疑似内存耗尽"
      : "异常退出";
    b.push({ kind: "error", id: "x" + s.blocks.length,
      text: "进程结束：" + how + " —— " + why + "。最后动作之后没有新事件。" });
  } else if (ev.type === "error") {
    b.push({ kind: "error", id: "e" + s.blocks.length, text: String(ev.message ?? ev.text ?? "unknown error") });
  } else if (ev.type === "final") {
    // The final answer is usually the same text we already streamed as a message
    // block. Relabel that block instead of rendering it twice.
    const fin = String(ev.text ?? "");
    const tail = b[b.length - 1];
    if (tail && tail.kind === "msg" && tail.text.trim() === fin.trim()) {
      tail.kind = "final";
      tail.text = fin;
      tail.images = collectImages(fin);
    } else {
      b.push({ kind: "final", id: "f" + s.blocks.length, text: fin, images: collectImages(fin) });
    }
  }
  if (b.length > 400) b.splice(0, b.length - 400);
}

function summarizeRun(s) {
  return {
    id: s.id, status: s.status, task: String(s.task).slice(0, 200), cwd: s.cwd,
    sessionId: s.sessionId ?? "(pending)",
    elapsed: ((s.endedAt ?? Date.now()) - s.startedAt) / 1000,
    calls: s.events.filter((e) => e.type === "tool_call").length,
    recent: s.events.slice(-14).map(summarize), logPath: s.logPath,
    blocks: s.blocks,
  };
}
const WORKER_JOBS = join(homedir(), '.local', 'share', 'codex-deepseek-worker', 'jobs');
function workerSnapshot() {
  if (!existsSync(WORKER_JOBS)) return [];
  return readdirSync(WORKER_JOBS).filter(n => /^[a-f0-9]{32}\.json$/.test(n)).map(n => {
    try {
      const s = JSON.parse(readFileSync(join(WORKER_JOBS, n), 'utf8'));
      const eventsPath = join(WORKER_JOBS, s.id + '.events.jsonl');
      const raw = existsSync(eventsPath) ? readFileSync(eventsPath, 'utf8') : (s.output || '');
      const events = raw.split('\n').filter(Boolean).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } });
      const active = ['queued', 'starting', 'running'].includes(s.status);
      const stamp = s.created_at || s.updated_at;
      let task = '';
      try { task = readFileSync(join(WORKER_JOBS, s.id + '.task.txt'), 'utf8').slice(0, 200); } catch {}
      return { id: s.id, status: s.status === 'completed' ? 'done' : s.status,
        task: task || 'DSH 委派任务', cwd: s.workspace, sessionId: s.session_id || '(pending)',
        elapsed: stamp ? Math.max(0, ((active ? Date.now() / 1000 : s.updated_at || stamp) - stamp)) : 0,
        calls: events.filter(e => e.type === 'tool_call').length,
        recent: events.slice(-14).map(summarize), logPath: eventsPath,
        finalText: s.final_text || events.findLast(e => e.type === 'final')?.text || '',
        source: 'Codex DSH worker', createdAt: stamp || 0 };
    } catch { return null; }
  }).filter(Boolean).sort((a,b) => b.createdAt-a.createdAt).slice(0, 20);
}
function snapshot() {
  return {
    runs: [...runs.values()].map(summarizeRun).concat(workerSnapshot()),
    conversations: [...conversations.values()].map(conversationView),
  };
}
/* The 1 Hz SSE snapshot used to carry every block of every conversation: ~12 MB
   per tick, i.e. 42 GB/hour pushed into the browser, which spent all its time
   parsing and never finished a paint. Only metadata goes out on the timer now;
   a conversation's body is sent when it actually changes. */
function summarizeRunBrief(s) {
  // Build an explicit metadata projection: neither blocks nor recent text belong
  // in a timer-driven message. A text event may itself contain megabytes.
  return {
    id: s.id, status: s.status, task: String(s.task).slice(0, 200), cwd: s.cwd,
    sessionId: s.sessionId ?? "(pending)",
    elapsed: ((s.endedAt ?? Date.now()) - s.startedAt) / 1000,
    calls: s.events.filter((e) => e.type === "tool_call").length,
    nBlocks: s.blocks.length, logPath: s.logPath,
  };
}
function snapshotBrief() {
  return {
    runs: [...runs.values()].map(summarizeRunBrief),
    conversations: [...conversations.values()].map((c) => conversationBrief(c)),
  };
}
function publishState(s) { publish({ kind: "state", run: summarizeRun(s) }); }
const PAGE_PATH = join(HERE, "dashboard.html");
/** Served from disk every request, so editing dashboard.html needs no restart. */
function dashboardHtml() {
  try { return readFileSync(PAGE_PATH, "utf8"); }
  catch (e) { return "<h1>dashboard.html missing</h1><p>" + e.message + "</p>"; }
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = "";
    req.on("data", (c) => (b += c));
    req.on("end", () => { try { resolve(b ? JSON.parse(b) : {}); } catch { resolve({}); } });
  });
}
const DASH_PORT = Number(process.env.DSH_DASHBOARD_PORT ?? 8799);
function startHttpServer() {
  const http = createServer(async (req, res) => {
    const url = req.url.split("?")[0];
    if (url === "/" || url === "/index.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, must-revalidate" });
      res.end(dashboardHtml());
    } else if (url === "/api/ping") {
      const who = new URL(req.url, "http://x").searchParams.get("instance");
      if (who) { instances.set(who, Date.now()); lastActivity = Date.now(); }
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify({ ok: true, version: 2, role: HUB_MODE ? "hub" : "inline",
                               pid: process.pid, instances: instances.size,
                               conversations: conversations.size }));
    } else if (url === "/api/ingest" && req.method === "POST") {
      const body = await readBody(req);
      const applied = applyIngest(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ok: true, applied }));
    } else if (url === "/api/runs") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify([...runs.values()].map(summarizeRun)));
    } else if (url === "/api/stream") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      sseClients.add(res);
      const s0 = snapshotBrief();
      res.write("data: " + JSON.stringify({ kind: "snapshot", runs: s0.runs, conversations: s0.conversations }) + "\n\n");
      req.on("close", () => sseClients.delete(res));
    } else if (url === "/api/run" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.task) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"task required"}'); return; }
      const s = startRun(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run_id: s.id }));
    } else if (url === "/api/file") {
      const q = new URL(req.url, "http://x").searchParams.get("path");
      if (!q || !servedImages.has(q)) { res.writeHead(403, { "content-type": "text/plain" }); res.end("not an image from this conversation"); return; }
      try {
        const buf = readFileSync(q);
        const ext = (q.split(".").pop() || "").toLowerCase();
        res.writeHead(200, { "content-type": MIME[ext] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(buf);
      } catch (e) { res.writeHead(404, { "content-type": "text/plain" }); res.end("cannot read: " + e.message); }
    } else if (url === "/api/forget" && req.method === "POST") {
      const body = await readBody(req);
      let removed = [];
      if (body.all) {
        // Bulk clearing is deliberately conservative: the in-memory entry and the
        // per-turn logs go, but the persisted DSH sessions survive unless the
        // caller asks for them explicitly. A mis-click must not be able to wipe
        // an agent's memory of a thread.
        const purgeAll = body.purge_sessions === true;
        for (const conv of [...conversations.values()]) removed.push(forgetConversation(conv, purgeAll));
      } else if (body.conversation_id && conversations.has(body.conversation_id)) {
        removed.push(forgetConversation(conversations.get(body.conversation_id), body.purge_session !== false));
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ removed }));
    } else if (url === "/api/conversations") {
      /* The full list is ~11 MB once the archive grows: serialising every block of
         every conversation on each poll took ~4.8 s and the browser rendered nothing
         until it arrived, which looked like an endless spinner. The index now ships
         metadata only; bodies are fetched per conversation via ?full=1. */
      const brief = new URL(req.url, "http://x").searchParams.get("full") === "1";
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      if (!brief) {
        const list = [...conversations.values()].map(conversationBrief);
        res.end(JSON.stringify(list));
        return;
      }
      const one = new URL(req.url, "http://x").searchParams.get("id");
      const selected = one ? (conversations.has(one) ? [conversations.get(one)] : [])
                           : [...conversations.values()];
      res.end(JSON.stringify(selected.map(conversationView)));
    } else if (url === "/api/send" && req.method === "POST") {
      const body = await readBody(req);
      if (!body.message) { res.writeHead(400, { "content-type": "application/json" }); res.end('{"error":"message required"}'); return; }
      if (body.conversation_id) {
        const busy = await waitWhileBusy(body.conversation_id, 120000);
        if (busy) {
          res.writeHead(409, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "busy", run_id: busy.id, conversation_id: body.conversation_id }));
          return;
        }
      }
      const s = startRun({ task: body.message, userMessage: body.message,
                           session_id: body.conversation_id, cwd: body.cwd, timeout_ms: body.timeout_ms });
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ run_id: s.id, conversation_id: body.conversation_id || null }));
    } else if (url === "/api/cancel" && req.method === "POST") {
      const body = await readBody(req);
      const s = runs.get(body.run_id);
      if (s) try { s.child.kill(); } catch {}
      res.writeHead(s ? 200 : 404, { "content-type": "application/json" });
      res.end(JSON.stringify({ cancelled: !!s }));
    } else {
      res.writeHead(404, { "content-type": "text/plain" });
      res.end("not found");
    }
  });
  http.on("error", (e) => {
    if (e.code === "EADDRINUSE") log("port " + DASH_PORT + " already held (another hub won the race); dashboard off here");
    else log("dashboard disabled:", e.message);
  });
  http.listen(DASH_PORT, "127.0.0.1", () => {
    lastActivity = Date.now();
    try { writeFileSync(HUB_STATE, JSON.stringify({ pid: process.pid, port: DASH_PORT, role: HUB_MODE ? "hub" : "inline", startedAt: Date.now() })); } catch {}
    log("dashboard on http://127.0.0.1:" + DASH_PORT + "  role=" + (HUB_MODE ? "hub" : "inline"));
  });
  setInterval(() => { const s = snapshotBrief(); publish({ kind: 'snapshot', runs: s.runs, conversations: s.conversations }); }, 1000).unref();
  /* A hub must not outlive its usefulness, but "no events recently" is the wrong
     test: the dashboard matters MOST exactly when forwarding has stopped, because
     that is when you go back to read what happened to the interrupted runs. It
     used to exit after 30 idle minutes whenever no tab happened to be open, and
     the page then spun forever against a dead port.

     Exit only when BOTH hold:
       - nobody is watching (no SSE client), and
       - no MCP instance has registered for far longer (default 8h).
     Instances re-register on their 5s heartbeat, so any live Codex conversation
     keeps the hub alive indefinitely. */
  setInterval(() => {
    const idle = Number(process.env.DSH_HUB_IDLE_MS ?? 28800000);
    if (!HUB_MODE || idle <= 0) return;
    if (sseClients.size > 0) return;
    const stale = Date.now() - lastActivity > idle;
    let anyInstance = false;
    for (const [, t] of instances) if (Date.now() - t < 900000) { anyInstance = true; break; }
    if (stale && !anyInstance) {
      log("hub idle for " + Math.round(idle / 1000) + "s with no viewers and no instances; exiting");
      process.exit(0);
    }
  }, 60000).unref();
}

/* ------------------------------------------------------------ hub handshake */
const HUB_URL = "http://127.0.0.1:" + DASH_PORT;
const HUB_PING = HUB_URL + "/api/ping?instance=" + INSTANCE_ID;
async function pingHub(timeoutMs) {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    const res = await fetch(HUB_PING, { signal: ac.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return j && j.version === 2 ? j : null;      // an older listener is not a hub we can talk to
  } catch { return null; }
}
function spawnHub() {
  try {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "--hub"], {
      detached: true, stdio: "ignore", windowsHide: true,
      env: { ...process.env, DSH_DASHBOARD_PORT: String(DASH_PORT) },
    });
    child.unref();
    log("hub: spawned detached hub pid=" + child.pid);
    return true;
  } catch (e) { log("hub: spawn failed:", e.message); return false; }
}
/** Join an existing hub, or start one; only fall back to inline serving if that fails. */
async function ensureHub() {
  let j = await pingHub(600);
  if (j) { forwarding = true; log("hub: joined existing " + JSON.stringify(j)); return true; }
  await new Promise((r) => setTimeout(r, Math.random() * 400));   // avoid a spawn stampede
  spawnHub();
  for (let i = 0; i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250));
    j = await pingHub(600);
    if (j) { forwarding = true; log("hub: joined new " + JSON.stringify(j)); return true; }
  }
  log("hub: unavailable; this instance will serve the dashboard inline instead");
  return false;
}

/* ------------------------------------------------------ forwarding (client) */
const fwdPending = new Map();   // runId -> { sessionId, cwd, task, startedAt, status, events: [] }
const fwdSeq = new Map();       // runId -> last seq handed out
let fwdTimer = null, fwdFailures = 0;

function forwardEvent(state, ev) {
  if (!forwarding) return;
  let p = fwdPending.get(state.id);
  if (!p) {
    p = { sessionId: null, cwd: state.cwd, task: state.userBlock?.text ?? state.task,
          startedAt: state.startedAt, status: "running", events: [] };
    fwdPending.set(state.id, p);
  }
  const seq = (fwdSeq.get(state.id) ?? -1) + 1;
  fwdSeq.set(state.id, seq);
  p.events.push({ seq, ev });
  p.sessionId = state.sessionId ?? p.sessionId;
  p.status = state.status;
  if (ev.type === "final") flushForward(); else scheduleFlush();
}
/** Push a status-only update (the event buffer may already have been flushed). */
function forwardStatus(state) {
  if (!forwarding) return;
  let p = fwdPending.get(state.id);
  if (!p) {
    p = { sessionId: state.sessionId ?? null, cwd: state.cwd,
          task: state.userBlock?.text ?? state.task, startedAt: state.startedAt,
          status: state.status, events: [] };
    fwdPending.set(state.id, p);
  }
  p.status = state.status;
  p.sessionId = state.sessionId ?? p.sessionId;
  flushForward();
}
function scheduleFlush() {
  if (fwdTimer || !fwdPending.size) return;
  fwdTimer = setTimeout(() => { fwdTimer = null; flushForward(); }, 250);
}
/** Batched, at-least-once delivery; seq numbers make replays harmless on the hub. */
async function flushForward() {
  if (!forwarding || !fwdPending.size) return;
  const runs = [...fwdPending.entries()].map(([runId, p]) => ({ runId, ...p }));
  try {
    const res = await fetch(HUB_URL + "/api/ingest", { method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ instanceId: INSTANCE_ID, runs }) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    fwdPending.clear();
    fwdFailures = 0;
  } catch (e) {
    fwdFailures++;
    log("hub: forward failed (" + fwdFailures + "): " + e.message);
    if (fwdFailures === 3) { forwarding = false; ensureHub().catch(() => {}); }
    scheduleFlush();
  }
}

if (DASH_PORT > 0) {
  if (HUB_MODE) startHttpServer();
  else {
    ensureHub().then((ok) => { if (!ok) startHttpServer(); });
    // Watch the hub so a killed dashboard is replaced within a few seconds even
    // while this instance is idle.
    setInterval(async () => {
      if (!forwarding) return;
      const j = await pingHub(600);
      if (!j) { log("hub: gone; re-establishing"); forwarding = false; ensureHub().catch(() => {}); }
    }, 5000).unref();
  }
}

/**
 * Rebuild conversations from the per-run NDJSON logs. DSH persists sessions on
 * disk, but this process keeps conversations in memory, so without a replay a
 * restart (or a Codex reconnect) would show an empty dashboard.
 */
function rehydrate() {
  try {
    if (!existsSync(RUNS_DIR)) return;
    const dated = readdirSync(RUNS_DIR).filter((n) => n.endsWith(".jsonl")).map((n) => {
      try { return { n, m: statSync(join(RUNS_DIR, n)).mtimeMs }; } catch { return null; }
    }).filter(Boolean).sort((a, b) => a.m - b.m);

    // Replay deliberately builds blocks without image harvesting; conversationView
    // fills them in per conversation the first time one is opened.
    REPLAY_IMAGES = false;
    for (const { n, m } of dated.slice(-400)) {
      let raw = "";
      try { raw = readFileSync(join(RUNS_DIR, n), "utf8"); } catch { continue; }
      const evs = raw.split("\n").filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
      const sess = evs.find((e) => e.type === "session");
      if (!sess) continue;
      const meta = evs.find((e) => e.type === "bridge_meta");
      cwdOfRun = sess.cwd ?? cwdOfRun;
      const conv = convFor(sess.sessionId, sess.cwd);
      const fresh = conv.baseBlocks.length === 0;
      // One state object for the whole log, so updateBlocks can keep its call index
      // across events. A fresh object per event defeated the index entirely.
      const replay = { blocks: [] };
      for (const e of evs) if (e.type !== "session" && e.type !== "bridge_meta") updateBlocks(replay, e);
      const blocks = replay.blocks;
      if (fresh) conv.createdAt = meta?.startedAt ?? m;
      const lp = join(RUNS_DIR, n);
      if (!conv.logs.includes(lp)) conv.logs.push(lp);
      conv.baseBlocks = conv.baseBlocks.concat([userBlock(meta?.task ?? "(未记录的任务)")], blocks);
      conv.updatedAt = m;
      // A log with no `final` did not finish; rehydration must not launder an
      // interrupted run into a successful one.
      const finished = blocks.some((b) => b.kind === "final");
      if (!conv.run) conv.status = finished ? "done" : "interrupted";
    }
    REPLAY_IMAGES = true;
      if (conversations.size) log("rehydrated " + conversations.size + " conversation(s) from " + RUNS_DIR);
    const max = Number(process.env.DSH_MAX_CONVERSATIONS ?? 0);
    if (max > 0) { const n = pruneConversations(max); if (n) log("auto-pruned " + n + " old conversation(s), kept " + max); }
  } catch (e) { log("rehydrate skipped:", e.message); }
}

/**
 * Really destroy a conversation: drop it from memory, delete the per-turn NDJSON
 * logs, and optionally remove the persisted DSH session directory (the agent's
 * actual memory of the thread).
 */
function purgeSessions(sessionId) {
  const root = join(homedir(), ".dsh", "sessions");
  let n = 0;
  try {
    for (const d of readdirSync(root)) {
      const p = join(root, d, sessionId);
      if (existsSync(p)) { rmSync(p, { recursive: true, force: true }); n++; }
    }
  } catch (e) { log("purgeSessions:", e.message); }
  return n;
}
function forgetConversation(conv, purgeSession) {
  for (const p of conv.logs ?? []) { try { rmSync(p, { force: true }); } catch {} }
  let sessions = 0;
  if (purgeSession) sessions = purgeSessions(conv.id);
  conversations.delete(conv.id);
  publish({ kind: "removed", id: conv.id });
  return { id: conv.id, logs: (conv.logs ?? []).length, sessions };
}
function pruneConversations(max) {
  if (!Number.isFinite(max) || max <= 0) return 0;
  const list = [...conversations.values()].sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0));
  let n = 0;
  for (const conv of list.slice(max)) { forgetConversation(conv, true); n++; }
  return n;
}

/* ------------------------------------------------------------- MCP plumbing */
let buf = "";
if (!HUB_MODE) {   // hub mode has no MCP channel; its stdin is /dev/null and would EOF instantly
process.stdin.setEncoding("utf8");
process.stdin.on("data", async (chunk) => {
  buf += chunk;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    const { id, method, params } = msg;
    if (id === undefined) continue;
    try {
      if (method === "initialize") {
        send({ jsonrpc: "2.0", id, result: {
          protocolVersion: params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {}, logging: {} },
          serverInfo: { name: "dsh-bridge", version: "0.2.0" } } });
      } else if (method === "ping") {
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "logging/setLevel") {
        const lvl = params?.level;
        logLevel = LOG_ORDER.includes(lvl) ? lvl : "info";
        log("client enabled logging at level " + logLevel);
        send({ jsonrpc: "2.0", id, result: {} });
      } else if (method === "tools/list") {
        send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
      } else if (method === "tools/call") {
        currentToken = params?._meta?.progressToken;
        try {
          send({ jsonrpc: "2.0", id, result: await callTool(params?.name, params?.arguments ?? {}) });
        } finally { currentToken = undefined; }
      } else {
        send({ jsonrpc: "2.0", id, error: { code: -32601, message: "method not found: " + method } });
      }
    } catch (e) {
      send({ jsonrpc: "2.0", id, error: { code: -32603, message: String(e?.message ?? e) } });
    }
  }
});
process.stdin.on("end", () => process.exit(0));
}
rehydrate();
log("ready", EXE);
