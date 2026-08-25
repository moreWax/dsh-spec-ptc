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
# uv must be installed; this one bundle supplies both Python Code Mode and sPTC
dsh plugin --profile <profile> add @morewax/dsh-spec-ptc
```

## What it does in dsh

| Piece | How |
|---|---|
| Stream bridge | Listens to `assistant/chunk`; translates streamed `run_code` JSON arguments into upstream ` ```repl ` input |
| Turn lifecycle | First chunk of a turn → `turn_begin`; committed `assistant/message` → `turn_end` (metrics logged) |
| Resolve service | `specPtc` on the context: `resolve(tool, args)` → hit (claimed result) or miss |
| Registry wrap | Wraps `ctx.tools.get()` resolve-first, covering existing and future tools, direct calls, and built-in Code Mode without upstream patches |
| Binding helper | `wrapBindings()` remains available for custom binding tables |
| Python CodeRuntime | Included uv-managed CPython provider replaces the stock TypeScript runtime in the selected profile |
| dsh engine shim | Registers allowlisted dsh tools in the upstream daemon and calls them speculatively through an authenticated loopback endpoint |
| Daemon lifecycle | Spawns the shim/daemon with scrubbed env, disposes only processes it owns, and kills the owned child on CLI signals |


## Phase 2: automatic Code Mode integration

Phase 2 closes the full loop without changing DeepSeek Harness:

1. Streamed `run_code` argument JSON is decoded incrementally across arbitrary
   chunk and escape boundaries.
2. Python Code Mode calls such as `await tools.search(args)` are translated to
   the bare-name `search(args)` form expected by upstream's Python shadow REPL.
3. A custom upstream engine registers only the explicitly allowlisted dsh
   tools. Its speculative calls return through dsh's complete tool execution pipeline behind a `127.0.0.1` endpoint guarded
   by a random per-process bearer token passed to the child through env only.
4. `ctx.tools.get()` is wrapped so both existing and future definitions claim a
   cached result first, then fail open to their original `execute` on a miss.

### Safety contract

**Only pure, side-effect-free tools may appear in `speculatableTools`.** A
speculative call can run even when the final generated program never reaches
it. Never allowlist writes, shell execution, mutations, purchases, messages,
or other side effects. The endpoint hard-refuses everything outside the
allowlist.

Registry lookup interception covers tools registered before or after this plugin;
bundle ordering is not part of the correctness contract.

### Language limitation

Upstream spec-ptc's shadow executor is Python (`ast.parse`) and opens
` ```repl ` blocks. Automatic Phase 2 speculation therefore targets dsh's
**Python Code Mode flavor**, provided directly by this package's `./python-runtime` subpath. Installing this bundle intentionally disables the selected profile's stock TypeScript CodeRuntime and mounts the included Python provider. Remove the bundle to return to TypeScript Code Mode.

## Resolve-first for custom Code Mode bindings

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
    autoStart: true
    engine: dsh            # custom shim; stock keeps upstream sub-LLM tools
    feedEnabled: true
    translateRunCode: true
    wrapRegistry: true
    speculatableTools:     # PURE READS ONLY
      - search
      - read_file
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
pnpm test            # protocol, daemon, endpoint, adapter, and real uv/CPython runtime tests: protocol, adapter, endpoint, registry wrap, fail-open
pnpm run build
```

The default suite uses a fake Node daemon speaking the exact upstream wire
protocol — no Python required in CI. The full shim → loopback callback →
shadow execution → resolve path was additionally live-validated against
upstream spec-ptc 0.1.1: one speculation, one claimed hit, zero evictions.

## License

MIT. Wire protocol ported from `plugins/client.py` in
[alexzhang13/spec-ptc](https://github.com/alexzhang13/spec-ptc) (MIT).
