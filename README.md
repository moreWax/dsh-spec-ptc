# @morewax/dsh-spec-ptc

Speculative programmatic tool calling (**sPTC**) for DeepSeek Harness — while
the model is still streaming a code block, tool calls already visible in the
partial code are pre-launched, so execution claims them instantly instead of
running them serially.

```
baseline   tokens──────────────────▶ exec: call₁──▶call₂──▶…──▶callₙ──▶ answer
spec-ptc   tokens──────────────────▶ exec: claim·claim·claim ──▶ answer
                 ╲ call₁ ▶▶▶ done ╱
                  ╲ call₂ ▶▶▶ done╱     (calls run inside generation time)
```

Technique and daemon: [`alexzhang13/spec-ptc`](https://github.com/alexzhang13/spec-ptc)
(MIT). This package is a pure **bridge** — no vendored code — to the upstream
`spec-ptc-daemon` over its Unix-socket protocol.

## Install

```bash
pip install spec-ptc                 # the upstream daemon (Python)
dsh plugin add @morewax/dsh-spec-ptc # this bridge
```

## What it does in dsh

| Piece | How |
|---|---|
| Stream bridge | Listens to the session event log (`assistant/chunk`) and feeds text deltas to the daemon as the model streams |
| Turn lifecycle | First chunk of a turn → `turn_begin`; committed `assistant/message` → `turn_end` (metrics logged) |
| Resolve service | `specPtc` on the context: `resolve(tool, args)` → hit (claimed result) or miss |
| Binding helper | `wrapBindings()` gives any Code Mode binding table resolve-first semantics in one line |
| Daemon lifecycle | Spawns `spec-ptc-daemon` when the socket is absent (scrubbed env), kills it on disposal — only if it spawned it |

## Resolve-first for Code Mode

```ts
import { wrapBindings } from '@morewax/dsh-spec-ptc/bindings'

const tools = wrapBindings(originalBindings, (name, args) => specPtc.resolve(name, args))
// every tools.* call now: hit -> instant speculative result; miss -> original runs
```

**Fail-open by construction**: resolver errors fall through to the original
function. No daemon, no Python, socket trouble — the plugin logs once and
every tool call executes exactly as without it. Speculation is an
accelerator, never a dependency.

## Config

```yaml
- id: spec-ptc
  name: '@morewax/dsh-spec-ptc'
  config:
    socketPath: /tmp/spec-ptc.sock
    autoStart: true      # spawn the daemon when the socket is absent
    feedEnabled: true
```

## The same daemon serves your own harness loops

The daemon is the keystone; this plugin is just a client. Python-side
harnesses (DSPy programs, RLM loops) can use the upstream library directly
(`from spec_ptc import Speculator`) or the same socket protocol — speculation
is shared infrastructure, not a dsh-only feature.

## Verify

```bash
pnpm install
pnpm run typecheck   # 0 errors
pnpm test            # 12 tests: wire protocol, wrapBindings, stream bridge, fail-open
pnpm run build
```

Tests run against a fake Node daemon speaking the exact upstream wire
protocol — no Python needed.

## License

MIT. Wire protocol ported from `plugins/client.py` in
[alexzhang13/spec-ptc](https://github.com/alexzhang13/spec-ptc) (MIT).
