# Processes, ports, and lifetime

## The topology that causes every surprise

    Codex (one process)
      └── one MCP server per CONVERSATION   <- not one per app
            └── one DeepSeek Harness process per run

    Hub (detached, owns port 8799)          <- independent of all of the above
      └── dashboard.html over SSE

**Three consequences:**

1. **Closing a Codex conversation kills its MCP server and every DSH process
   under it.** A run in flight dies mid-stream with no error event. This is the
   single largest source of "the task just stopped".
2. **A dashboard port conflict is expected, not a bug.** Without the hub, the
   first conversation would win 8799 and the rest would silently lose it. The hub
   exists so exactly one process owns the port.
3. **MCP servers load `dsh-mcp-server.mjs` once, at spawn.** Editing the file does
   nothing until Codex restarts that conversation. Check ages before trusting a fix:

       Get-Item dsh-mcp-server.mjs | Select LastWriteTime
       Get-CimInstance Win32_Process -Filter "Name='node.exe'" |
         Where-Object { $_.CommandLine -match 'dsh-mcp-server' }

   A server started before the file's timestamp is running old code.

## Restarting the hub

The hub is disposable: it holds a fold of the logs, not the runs. Killing it never
loses a task.

    $hub = (Get-Content "$HOME\.dsh-codex-bridge\hub.json" -Raw | ConvertFrom-Json)
    taskkill /PID $hub.pid /T /F
    # any live MCP server re-establishes it within ~5 s (heartbeat), or start one:
    Start-Process -FilePath $node -ArgumentList "$D\dsh-mcp-server.mjs",'--hub' -WindowStyle Hidden

**Never kill by port or by image name.** MCP servers share the same command line;
matching on `dsh-mcp-server.mjs` alone will take out Codex's conversations too.
Match on `--hub` to isolate the hub.

## Hub lifetime

    DSH_HUB_IDLE_MS   default 28800000 (8 h)

The hub exits only when **all** hold: nobody is watching (no SSE client), no
instance has heartbeated for the idle window, and the window has elapsed. MCP
servers heartbeat every 5 s, so any open Codex conversation keeps it alive.

An earlier version keyed on "no recent events" with a 30-minute window. That was
wrong — the dashboard matters *most* when forwarding has stopped, because that is
when you go back to read what happened. The old rule killed the hub whenever no
tab happened to be open, and the page then spun forever against a dead port.

## Port ownership

    8799   hub (or the inline fallback when there is no hub)
    8801   project mirror — usually ABSENT. The dashboard probes it once at
           startup and ignores failure. It used to poll every 2 s, producing a
           failed request plus a full re-render each time.

## Stale-run detection

A run whose owning instance stops forwarding is marked `interrupted`, not left
`running` forever. The hub records the instance id per run and sweeps:

    DSH_STALE_MS   default 180000 (3 min)

Keep it generous unless every MCP server is known to be current: the check keys on
"has this instance sent anything", and one long reasoning step can be minutes
without an event. With heartbeats carrying the instance id, 30 s is safe.

## Health check

    $p = (Invoke-WebRequest http://127.0.0.1:8799/api/ping -UseBasicParsing).Content
    # {"ok":true,"version":2,"role":"hub","pid":...,"instances":N,"conversations":M}

`instances: 0` with a running Codex means no conversation has an MCP server up —
`dsh_*` tools will fail until one is spawned.
