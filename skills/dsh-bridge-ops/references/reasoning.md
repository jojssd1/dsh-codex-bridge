# Per-run reasoning level

Reasoning effort is **not** a profile-wide setting you edit between tasks. Every
run tool accepts it per call:

    dsh_run   { "task": "...", "reasoning": "off" }
    dsh_send  { "message": "...", "reasoning": "low" }
    dsh_start { "task": "...", "reasoning": "max" }

Levels: `off | low | medium | high | max`. Omit it and the profile default applies.

Use `off` for mechanical work — run a script, list files, copy a result. Measured
on a trivial prompt: `off` produced `outputTokens: 1` with no thinking block at
all, while the default spent a reasoning pass on the same question.

## How it works

DSH accepts `--patch <file>`, an extra overlay applied after the profile. The
bridge writes one small YAML per level (cached, generated once):

    - id: agent-default-model
      name: "@deepseek-ai/dsh-agent-default-model"
      config:
        provider: opencode-go
        model: deepseek-v4.1-flash
        reasoningEffort: "off"

Files land in `~/.dsh-codex-bridge/reasoning-<level>.yml`.

## Two traps

**1. `--patch` must come BEFORE `--json`.**

    dsh --profile headless --json --patch x.yml "task"    -> unknown option '--patch'
    dsh --profile headless --patch x.yml --json "task"    -> works

Everything after `--json` is task text. The bridge builds:

    ["--expose-internals", CLI, "--profile", "headless", "--patch", patchPath,
     "--json", ...sessionArgs, task]

**2. A patch REPLACES the entry's config; it does not merge.**

An overlay carrying only `reasoningEffort` fails startup validation:

    ValidationError: invalid config:
    - $.provider missing required value (at provider)
    dsh: startup failed: 1 required plugin did not activate

`provider` and `model` must be restated every time. The word "overlay" suggests a
deep merge; verify with `--dump-config` rather than assuming:

    dsh --profile headless --patch p.yml --dump-config | Select-String reasoningEffort

## Verifying a change took effect

`--dump-config` shows the composed tree without invoking a model, so it costs
nothing:

    dsh --profile headless --dump-config | Select-String reasoningEffort
    # reasoningEffort: 'off'

To confirm behaviour, run a trivial prompt and inspect the usage line:

    {"type":"status","phase":"step_end","turn":1,"step":1,
     "usage":{"inputTokens":4054,"outputTokens":1,"totalTokens":8151}}

A near-zero `outputTokens` with no `thinking` event means reasoning really was off.

## Adding another per-run knob

The same mechanism carries any `agent-default-model` field. Extend
`reasoningPatch()` to accept more keys, or generalise it to write a caller-supplied
config object. Because the bridge re-reads nothing between runs, a new file is
picked up on the next task — no restart.
