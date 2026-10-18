---
name: dsh-bridge-ops
description: Operate and repair the DSH <-> Codex MCP bridge (dsh-codex-bridge). Use when dsh_run / dsh_send / dsh_start fail, a delegated run dies with no output, the dashboard spins or shows an empty conversation, the hub is unreachable, or a credential/port/process question needs answering. Covers the process model (one MCP server per Codex conversation), the credential path that silently kills every run, timeout semantics, exit-code post-mortems, and the headless-browser method that finds frontend faults without a human at the keyboard. 桥接排障：调用失败、任务秒死、看板转圈、无输出。
---

# DSH Bridge Operations

The bridge exposes DeepSeek Harness as a stateful subagent to Codex over MCP.
It lives at `%USERPROFILE%\dsh-codex-bridge`. Repo: github.com/jojssd1/dsh-codex-bridge

## The one rule that prevents most outages

**Read the run log before theorising.** Every run writes
`~/.dsh-codex-bridge/runs/<run-id>.jsonl`, and since the bridge records its own
death, the log usually names the cause outright:

    {"type":"bridge_exit","code":1,"signal":null,"timedOut":false,"killed":false,"stderrBytes":351}
    {"type":"bridge_stderr","text":"dsh: MISSING_CREDENTIAL: ..."}

If `bridge_exit` is **absent**, the bridge process itself was killed — the run did
not fail, its parent died. That distinction is the whole diagnosis.

## Triage order

1. **Is the bridge alive?** `GET http://127.0.0.1:8799/api/ping` → `{"ok":true,...}`.
   No listener means the hub is gone; restart it (see references/processes.md).
2. **Did the run produce a log?** A log under ~2 KB that ends at `step_start` is a
   startup failure, not a hang. Read `bridge_stderr`.
3. **Is it a credential failure?** `MISSING_CREDENTIAL` / `no credential for
   provider route` → see references/credentials.md. This is the single most common
   cause of "every task dies instantly with no output".
4. **Frontend fault?** Server healthy but the page spins or a conversation is
   blank → see references/frontend.md. Do not guess; drive a headless browser.
5. **Diagnosing a death?** `bridge_exit` code/signal table in
   references/postmortem.md.

## Environment facts

    bridge      %USERPROFILE%\dsh-codex-bridge\dsh-mcp-server.mjs   (MCP server + hub)
    dashboard   %USERPROFILE%\dsh-codex-bridge\dashboard.html      (served from disk per request)
    logs        %USERPROFILE%\.dsh-codex-bridge\runs\*.jsonl
    hub state   %USERPROFILE%\.dsh-codex-bridge\hub.json           ({pid,port,role})
    config      %USERPROFILE%\.codex\config.toml                  ([mcp_servers.dsh])
    profile     %USERPROFILE%\.dsh\profiles\headless\cordis.patch.yml

    node  %USERPROFILE%\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe

## Tools exposed to Codex

    dsh_run      one task, wait for the answer
    dsh_send     message an existing subagent (keeps its context)
    dsh_start    fire and return a run_id (for long work)
    dsh_status   live progress
    dsh_result   final answer
    dsh_cancel   stop an in-flight turn
    dsh_conversations / dsh_forget

All three run tools accept `reasoning`: `off | low | medium | high | max` for that
call only — no config edit, no restart. Full details in references/reasoning.md.

## Editing the bridge safely

The server file is edited while Codex holds it open, so **never overwrite it in
place**. Write a candidate, syntax-check it, then swap:

    node --check candidate.mjs && copy /Y candidate.mjs dsh-mcp-server.mjs

This file has been truncated mid-write more than once, and each time the bridge
stopped starting. A truncated file passes no syntax check, so the check is the
guard. Same for `dashboard.html`: extract the script and check it.

    node scripts/cdp-probe.mjs        # verify the page actually runs

## References

- `references/credentials.md` — why runs die instantly, and the env inheritance trap
- `references/processes.md` — process model, ports, hub lifetime, restart procedure
- `references/postmortem.md` — exit codes, signals, and what each failure looks like
- `references/frontend.md` — driving Chromium headless to read the console
- `references/reasoning.md` — per-run thinking level via --patch
