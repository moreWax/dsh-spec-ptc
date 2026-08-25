/**
 * dsh-spec-ptc: speculative programmatic tool calling for DeepSeek Harness.
 *
 * While the model streams a code block, the upstream spec-ptc daemon
 * pre-launches the tool calls already visible in the partial code; by the
 * time the block executes, results are instant claims. This plugin bridges
 * dsh to that daemon:
 *
 *   - stream bridge: session `assistant/chunk` events -> daemon feed
 *   - turn lifecycle: first chunk of a turn -> turn_begin; the committed
 *     `assistant/message` -> turn_end (metrics logged)
 *   - resolve service: `specPtc` on the context, for Code Mode consumers
 *     (pair with `wrapBindings` from `@morewax/dsh-spec-ptc/bindings`)
 *
 * Fail-open everywhere: no daemon, no Python, socket trouble — the plugin
 * logs once and every tool call executes exactly as without it.
 *
 * @module @morewax/dsh-spec-ptc
 */
import { fileURLToPath } from 'node:url'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ensureDaemon, DEFAULT_DAEMON_CONFIG } from './daemon.js'
import type { SpecClient } from './client.js'
import { startEndpoint } from './endpoint.js'
import type { EndpointHandle, EndpointToolRuntime } from './endpoint.js'
import { wrapLookup } from './wrap-registry.js'
import type { WrappableToolRuntime } from './wrap-registry.js'
import { ReplFeedAdapter } from './repl-adapter.js'
import type { ToolCallDeltaChunk } from './repl-adapter.js'

export { SpecClient } from './client.js'
export { ensureDaemon, DEFAULT_DAEMON_CONFIG } from './daemon.js'
export { startEndpoint } from './endpoint.js'
export { wrapLookup } from './wrap-registry.js'
export { ReplFeedAdapter, rewriteLine } from './repl-adapter.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spec-ptc'
/** Tool registry required for callback execution and resolve-first lookup interception. */
export const inject = ['tools']
/** Resolve service mounted for optional consumers. */
export const provide = ['specPtc']

export interface Config {
  /** Unix socket the daemon listens on. */
  socketPath?: string
  /** Spawn the daemon when the socket is absent. */
  autoStart?: boolean
  /** Daemon executable (must be on PATH after `pip install spec-ptc`). */
  command?: string
  /** Extra args for the daemon command. */
  args?: string[]
  /** Forward streamed chunks to the daemon. */
  feedEnabled?: boolean
  /**
   * Which engine the daemon speculates with: 'dsh' (harness tools via loopback
   * callback — the full Phase 2 path) or 'stock' (upstream sub-LLM engine).
   */
  engine?: 'stock' | 'dsh'
  /** uv executable for the locked dsh engine project. */
  uvBin?: string
  /**
   * Public names of PURE tools the daemon may speculate. Speculation executes
   * the tool during generation — only side-effect-free tools may ever be
   * listed. Empty (default) disables dsh-engine speculation entirely.
   */
  speculatableTools?: string[]
  /** Wrap ctx.tools.get so existing and future definitions execute resolve-first. */
  wrapRegistry?: boolean
  /** Translate streamed run_code JSON arguments into upstream ```repl input. */
  translateRunCode?: boolean
}

export const Config: z<Config> = z.object({
  socketPath: z.string().default(DEFAULT_DAEMON_CONFIG.socketPath),
  autoStart: z.boolean().default(DEFAULT_DAEMON_CONFIG.autoStart),
  command: z.string().default(DEFAULT_DAEMON_CONFIG.command),
  args: z.array(String).default([]),
  feedEnabled: z.boolean().default(true),
  engine: z.string().default('dsh'),
  uvBin: z.string().default('uv'),
  speculatableTools: z.array(String).default([]),
  wrapRegistry: z.boolean().default(true),
  translateRunCode: z.boolean().default(true),
}) as unknown as z<Config>

/** The resolve service exposed on the context for Code Mode consumers. */
export interface SpecPtcService {
  /** Claim a speculative result, or miss — then run the tool yourself. */
  resolve(tool: string, args: unknown[]): Promise<{ hit: true; result: unknown } | { hit: false }>
  /** Whether the daemon is currently reachable. */
  available(): boolean
}

/** Minimal shape of the session events this bridge consumes (defensive: log is authoritative). */
interface SessionEventLike {
  type?: string
  turn?: number
  chunk?: {
    type?: string
    text?: string
    index?: number
    name?: string
    argumentsDelta?: string
  }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const speculatable = new Set(config.speculatableTools ?? [])
  // The dsh engine shim is only meaningful with tools to speculate AND a
  // callback endpoint to execute them through; anything less falls back to
  // the upstream stock daemon (sub-LLM speculation only).
  const wantDshEngine = (config.engine ?? 'dsh') === 'dsh' && speculatable.size > 0

  let endpoint: EndpointHandle | undefined
  if (wantDshEngine) {
    const tools = (ctx as unknown as Record<string, unknown>).tools as EndpointToolRuntime | undefined
    if (tools === undefined) {
      ctx.logger.warn('spec-ptc: no tools runtime on context — falling back to the stock engine')
    } else {
      try {
        endpoint = await startEndpoint({ tools, speculatable, logger: ctx.logger })
      } catch (error) {
        ctx.logger.warn(`spec-ptc: callback endpoint failed to start (${String(error)}) — falling back to the stock engine`)
      }
    }
  }

  const useDshEngine = wantDshEngine && endpoint !== undefined
  const daemon = await ensureDaemon({
    socketPath: config.socketPath ?? DEFAULT_DAEMON_CONFIG.socketPath,
    autoStart: config.autoStart ?? DEFAULT_DAEMON_CONFIG.autoStart,
    command: config.command ?? DEFAULT_DAEMON_CONFIG.command,
    args: config.args ?? [],
    startTimeoutMs: DEFAULT_DAEMON_CONFIG.startTimeoutMs,
    engine: useDshEngine ? 'dsh' : 'stock',
    uvBin: config.uvBin ?? 'uv',
    shimPath: fileURLToPath(new URL('../python/dsh_spec_engine.py', import.meta.url)),
    callbackUrl: endpoint?.url,
    callbackToken: endpoint?.token,
  }, ctx.logger)

  if (daemon === undefined) {
    // Fail-open: plugin loads, speculation simply never happens.
    if (endpoint !== undefined) await endpoint.close()
    return
  }

  const client: SpecClient = daemon.client
  const service: SpecPtcService = {
    resolve: (tool, args) => client.resolve(tool, args).catch(() => ({ hit: false as const })),
    available: () => true,
  }
  const bag = ctx as unknown as Record<string, unknown>
  ctx.provide('specPtc', service)

  // ---- resolve-first registry wrap (Phase 2) -----------------------------
  // One lookup wrap covers existing and future definitions, including direct
  // model tool calls and Code Mode nested dispatches. Bundle order is irrelevant.
  let restoreRegister: (() => void) | undefined
  if (config.wrapRegistry !== false && speculatable.size > 0) {
    const runtime = bag.tools as WrappableToolRuntime | undefined
    if (runtime !== undefined && typeof runtime.get === 'function') {
      restoreRegister = wrapLookup(runtime, service.resolve, speculatable).restore
    } else {
      ctx.logger.warn('spec-ptc: tools runtime not wrappable — resolve-first limited to wrapBindings consumers')
    }
  }

  // ---- stream bridge -----------------------------------------------------
  // Feeds are serialized to preserve stream order; a feed failure disables
  // the bridge for the rest of the turn rather than spamming the log.
  let lastTurn: number | undefined
  let inTurn = false
  let feedChain: Promise<void> = Promise.resolve()
  let feedBroken = false
  const replAdapter = new ReplFeedAdapter()

  const enqueue = (work: () => Promise<void>): void => {
    feedChain = feedChain.then(work).catch((error) => {
      if (!feedBroken) {
        feedBroken = true
        ctx.logger.warn(`spec-ptc: daemon feed failed (${String(error)}) — bridge disabled until next turn`)
      }
    })
  }

  // 'session/event' is declaration-merged onto cordis Events by dsh-session;
  // this package intentionally avoids that dependency, so subscribe through
  // a narrow local signature (same runtime call, honest types).
  const onSessionEvent = ctx.on.bind(ctx) as unknown as (
    name: 'session/event',
    listener: (session: unknown, event: SessionEventLike) => void,
  ) => () => void
  // Turn state updates SYNCHRONOUSLY in the listener (so ordering decisions
  // are always current); only the daemon writes are serialized through the
  // queue. An assistant/message with a turn LOWER than the stream's current
  // turn is a concurrent older stream finishing — ignored, not a boundary.
  const beginTurn = (turn: number): void => {
    if (inTurn) enqueue(async () => { await client.turnEnd() })
    enqueue(async () => { await client.turnBegin({}) })
    inTurn = true
    lastTurn = turn
  }
  const endTurn = (): void => {
    const finished = lastTurn
    enqueue(async () => {
      const metrics = await client.turnEnd()
      ctx.logger.info(
        `spec-ptc: turn ${String(finished)} — speculated ${String(metrics.speculated ?? 0)}, ` +
        `claimed ${String(metrics.claimed ?? 0)}, evicted ${String(metrics.evicted ?? 0)}`,
      )
    })
    inTurn = false
  }

  const disposeListener = onSessionEvent('session/event', (_session: unknown, event: SessionEventLike) => {
    if (config.feedEnabled === false || feedBroken) return
    const turn = event?.turn
    if (event?.type === 'assistant/chunk' && typeof turn === 'number') {
      if (!inTurn || turn !== lastTurn) beginTurn(turn)
      const chunk = event.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        // Preserve the stock upstream path (raw ```repl blocks in assistant text).
        enqueue(async () => { await client.feed(chunk.text as string) })
      } else if (
        config.translateRunCode !== false
        && chunk?.type === 'tool-call-delta'
        && typeof chunk.index === 'number'
        && typeof chunk.argumentsDelta === 'string'
      ) {
        const translated = replAdapter.push(chunk as ToolCallDeltaChunk)
        for (const delta of translated) enqueue(async () => { await client.feed(delta) })
      }
    } else if (event?.type === 'assistant/message' && inTurn && turn === lastTurn) {
      for (const delta of replAdapter.finish()) enqueue(async () => { await client.feed(delta) })
      endTurn()
    }
  })

  ctx.effect(() => {
    return () => {
      disposeListener()
      restoreRegister?.()
      void daemon.dispose()
      if (endpoint !== undefined) void endpoint.close()
    }
  }, 'spec-ptc.daemon')
}
