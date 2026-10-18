# Post-mortem: reading a dead run

## The line that answers the question

Every run ends with a self-written obituary:

    {"type":"bridge_exit","code":1,"signal":null,"timedOut":false,
     "detached":false,"killed":false,"stderrBytes":351}

| field | meaning |
|---|---|
| `code` | process exit code (`null` when killed by a signal) |
| `signal` | `SIGTERM`/`SIGKILL` when something outside killed it |
| `timedOut` | our own budget elapsed |
| `detached` | we stopped waiting but left it running |
| `killed` | we actually sent the kill |

## Reading it

| record | diagnosis | action |
|---|---|---|
| **absent entirely** | the bridge process died before it could write. The run did not fail — its parent was killed | check whether the Codex conversation was closed or restarted |
| `code:0` | clean success | — |
| `code:1` + `bridge_stderr` | DSH exited on its own error; stderr holds the reason | read it — often `MISSING_CREDENTIAL` |
| `signal:SIGTERM`, `timedOut:true` | our budget elapsed and **the old build killed it** | if `detached:true` it survived and is still running |
| `signal:SIGTERM`, `timedOut:false` | something outside killed it: conversation closed, process tree reaped | see processes.md |
| `code:137` | out of memory | shrink the task or the context |

## The ordering bug that hid everything

`bridge_exit` was written **after** `stream.end()`:

    const finish = (status) => {
      stream.end();                       // closed here
      ...
      try { stream.write(bridge_exit); } catch {}   // no-op; error swallowed
    };

Writing to an ended stream fails asynchronously, so the empty `catch` never saw
it. **35 logs carried no exit record at all**, and the absence was misread as "the
bridge must have died". Move `stream.end()` to the very end of `finish`.

Lesson: an empty `catch` around diagnostic code makes the diagnostics silently
useless. If a record you expect is missing, suspect the writer before the system.

## A timeout must not kill

The original timer did `child.kill()`. A legitimate long regression ran 1200 s,
was killed at the 20-minute mark, and the caller was told `failed` — the work was
executed and then thrown away.

    // now: stop WAITING, keep RUNNING
    const timer = setTimeout(() => {
      state.timedOut = true;
      state.detached = true;
      for (const w of state.listeners.splice(0)) w(state);
    }, timeout_ms);              // no kill

The caller receives the run id and polls `dsh_status` / `dsh_result`.
`finish()` reports `code === 0 ? "done" : "failed"` — it no longer downgrades a
success just because we stopped waiting. `dsh_cancel` is the only thing that kills.

## Stuck versus dead

    last event is step_start, log frozen   -> process gone (absent bridge_exit) or hung
    last event is tool_call, unpaired      -> killed mid-tool
    log under ~2 KB, ends at step_start    -> startup failure, read bridge_stderr

Check liveness by file size, not by the dashboard:

    $f = Get-Item "$HOME\.dsh-codex-bridge\runs\<id>.jsonl"
    $a = $f.Length; Start-Sleep 4; $b = (Get-Item $f.FullName).Length
    # $a -eq $b  ->  nothing is writing

An `error` **event** in the log means DSH reported a failure. Its absence with a
dead process means the failure happened below the event layer.
