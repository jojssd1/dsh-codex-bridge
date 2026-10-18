# Frontend faults: do not guess, drive a browser

When the server is healthy (every endpoint fast, data complete) and the page still
spins or shows a blank conversation, the fault is in `dashboard.html`. Stop
reasoning about the code — **launch a headless browser and read the console.**

## The method

Chromium and Edge ship remote debugging; no puppeteer or playwright install needed:

    msedge.exe --headless=new --disable-gpu --remote-debugging-port=9222 \
      --user-data-dir=%TEMP%\edge-dsh-profile about:blank

Node 22+ has a **global WebSocket** — do not `import("undici")`, it is not
installed:

    const list = await (await fetch("http://127.0.0.1:9222/json/list")).json();
    const page = list.find((t) => t.type === "page");
    const sock = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r, j) => { sock.addEventListener("open", r);
                                  sock.addEventListener("error", j); });

    // three events are enough to catch anything
    sock.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.method === "Runtime.exceptionThrown")  // uncaught errors
      if (m.method === "Runtime.consoleAPICalled") // console.*
      if (m.method === "Log.entryAdded")           // network / resource
    });

    await send("Runtime.enable"); await send("Log.enable"); await send("Page.enable");
    await send("Page.navigate", { url: "http://127.0.0.1:8799/" });

Then **act like the user**:

    Runtime.evaluate: document.querySelector('#list .item').click()
    Runtime.evaluate: thread.innerHTML.length

A ready-made driver lives at `scripts/cdp-probe.mjs` in the bridge repo.

## What it caught

    [EXCEPTION] ReferenceError: $ is not defined
        at http://127.0.0.1:8799/:803

One line of jQuery habit in a page that never defines `$`:

    $("list").addEventListener("click", ...)     // should be getElementById

**The script is sequential: everything after the throw never ran.** The list still
drew (it rendered before the fault), clicking did nothing, and the page never
finished initialising — which reads exactly like "it just spins".

Confirmed by driving the page: after the fix,

    clicked session-65e677f6-...
    threadLen = 1,441,473   rows = 518

## Rules

1. **A blank page is not a data problem until the console says so.** Verify the
   endpoint first (`/api/conversations?full=1&id=...`), then the console.
2. **Grep for undefined helpers after editing**: `grep -n '\$("' dashboard.html`.
   This class of error is invisible to review — `$` is correct in most projects.
3. **Page renders ≠ script completed.** Only the console knows.
4. Verify a frontend fix by driving the page, never by asking a human to reload.

## Payload size is a frontend fault too

The dashboard once "spun forever" while every endpoint answered in milliseconds.
The cause was volume, not latency:

    /api/conversations           12,484 KB   4,816 ms   (27 conversations, all blocks)
    1 Hz SSE snapshot            12,056 KB per tick  ->  42 GB/hour

The browser spent all its time parsing and never finished a paint.

    /api/conversations           metadata only        12 KB   (blocks dropped)
    /api/conversations?full=1&id=...   one body on demand   2,469 KB
    1 Hz SSE snapshot            metadata only        11 KB

**Any timer-driven message must carry counts, never bodies.** `summarizeRun` had
to be replaced by an explicit field projection: its `recent` array can contain a
single multi-megabyte text event, so even "just the recent events" is unbounded.

When a fix changes the payload shape, the client must preserve what it already
holds — a metadata-only snapshot must not blank a conversation the user is reading.
