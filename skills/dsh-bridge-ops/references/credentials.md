# Credentials

## The silent killer

The headless profile resolves the provider key from an **environment variable**:

    # ~/.dsh/profiles/headless/cordis.patch.yml
    - id: agent-default-model
      config:
        provider: opencode-go
        model: deepseek-v4.1-flash
        reasoningEffort: high
    # and, in the provider entry:
    #   apiKeyEnv: OPENCODE_GO_API_KEY

When that variable is absent every delegated run dies **instantly and silently**:

    {"type":"status","phase":"step_start","turn":1,"step":1}
    {"type":"status","phase":"step_end","turn":1,"step":1}
    {"type":"turn_end","reason":{"kind":"error","error":{"message":
       "llm-pi-ai: no credential for provider route \"opencode-go\"; its profile
        resolves OPENCODE_GO_API_KEY, which is not set ..."}}}
    {"type":"final","text":""}
    {"type":"bridge_exit","code":1,"signal":null,"timedOut":false,"killed":false}

From Codex this looks like "the tool returned nothing" or "the bridge is broken".
The run log is ~1.5 KB and contains the answer verbatim.

## The env-inheritance trap

**Codex does not pass the machine environment to an MCP server.** It passes only
the variables listed under the server's `env` block:

    # ~/.codex/config.toml
    [mcp_servers.dsh.env]
    DSH_DASHBOARD_PORT = "8799"
    DSH_INSTALL_ROOT = 'C:\\Users\\...\\DeepSeek Harness'
    DSH_MCP_TIMEOUT_MS = "1800000"

A key that exists perfectly well at the user level never reaches DSH this way.
This was a real outage: `setx OPENCODE_GO_API_KEY ...` was set, the CLI worked
when run by hand, and every Codex-delegated run still died.

## How it is fixed now

The bridge heals its own environment at startup — no secret is written to any
config file:

    const CREDENTIAL_ENV = ["OPENCODE_GO_API_KEY", "DEEPSEEK_API_KEY", "ARK_API_KEY",
                            "HETU_API_KEY", "CATBEE_API_KEY"];
    function healEnv() {
      const missing = CREDENTIAL_ENV.filter((k) => !process.env[k]);
      ...
      // reads the persistent USER environment via powershell, then sets process.env
    }

Runs in ~550 ms, once per MCP server start. To add a provider, append its variable
name to `CREDENTIAL_ENV`.

## Verify a credential end to end

Never conclude "the key is fine" from the fact that it is set. Run it:

    $env:OPENCODE_GO_API_KEY = [Environment]::GetEnvironmentVariable('OPENCODE_GO_API_KEY','User')
    dsh --profile headless --json "只回复两个字：通了"

Expect `{"type":"final","text":"通了"}`. A credential error appears as a
`turn_end` with `reason.kind == "error"`, never as an exception.

## Where else keys can live

    %USERPROFILE%\.dsh\.credentials.yaml     DSH credential store (refs: block lists names)
    %USERPROFILE%\.dsh\settings.yaml         web Models page writes here

DSH prefers its credential store when the provider entry has **no** `apiKeyEnv`.
Since the headless profile sets `apiKeyEnv`, the environment wins — which is why
adding the variable to Codex's env block, or letting the bridge heal it, fixes it.

## The key lives in two places, and they drift

A provider key such as `OPENCODE_GO_API_KEY` can be stored **twice**:

```
~/.dsh/.credentials.yaml            <- what DSH desktop/web resolves
User environment variable           <- what bridge healEnv() resolves
```

Updating one does not update the other, and the symptom is confusing: the
desktop app works while every `dsh_run` fails, or the reverse. Observed
2026-10-24: the credential store already held the rotated key while the user
environment still held the previous one, so bridge-dispatched runs kept using a
dead key.

**Check both before concluding a key is bad:**

```powershell
# what DSH stores
Select-String -Path "$HOME\.dsh\.credentials.yaml" -Pattern "OPENCODE_GO_API_KEY"
# what the bridge will inject
[Environment]::GetEnvironmentVariable("OPENCODE_GO_API_KEY","User")
```

You may ask DSH to keep no `apiKeyEnv` at all (letting its credential store win),
but the bridge cannot see that store: `healEnv()` reads the environment only. So
when a key is rotated, set **both**.

After changing the user environment, already-running MCP servers still hold the
old value in their own `process.env` -- `healEnv()` only fills variables that are
**missing**, it never overwrites. A fresh Codex conversation (new MCP server) or
a Codex restart is required for the rotation to take effect.

Verification that does not depend on Codex:

```powershell
$env:OPENCODE_GO_API_KEY=[Environment]::GetEnvironmentVariable("OPENCODE_GO_API_KEY","User")
dsh --profile headless --json "只回复两个字：通了"
```

Expect `{"type":"final","text":"通了"}`. A dead key shows up as `turn_end` with
`reason.kind == "error"` and a provider message, never as an exception.
