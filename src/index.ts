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
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { ensureDaemon, DEFAULT_DAEMON_CONFIG } from './daemon.js'
import type { SpecClient } from './client.js'

export { SpecClient } from './client.js'
export { ensureDaemon, DEFAULT_DAEMON_CONFIG } from './daemon.js'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'spec-ptc'

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
}

export const Config: z<Config> = z.object({
  socketPath: z.string().default(DEFAULT_DAEMON_CONFIG.socketPath),
  autoStart: z.boolean().default(DEFAULT_DAEMON_CONFIG.autoStart),
  command: z.string().default(DEFAULT_DAEMON_CONFIG.command),
  args: z.array(String).default([]),
  feedEnabled: z.boolean().default(true),
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
  chunk?: { type?: string; text?: string }
}

export async function apply(ctx: Context, config: Config): Promise<void> {
  const daemon = await ensureDaemon({
    socketPath: config.socketPath ?? DEFAULT_DAEMON_CONFIG.socketPath,
    autoStart: config.autoStart ?? DEFAULT_DAEMON_CONFIG.autoStart,
    command: config.command ?? DEFAULT_DAEMON_CONFIG.command,
    args: config.args ?? [],
    startTimeoutMs: DEFAULT_DAEMON_CONFIG.startTimeoutMs,
  }, ctx.logger)

  if (daemon === undefined) {
    // Fail-open: plugin loads, speculation simply never happens.
    return
  }

  const client: SpecClient = daemon.client
  const service: SpecPtcService = {
    resolve: (tool, args) => client.resolve(tool, args).catch(() => ({ hit: false as const })),
    available: () => true,
  }
  const bag = ctx as unknown as Record<string, unknown>
  bag.specPtc = service

  // ---- stream bridge -----------------------------------------------------
  // Feeds are serialized to preserve stream order; a feed failure disables
  // the bridge for the rest of the turn rather than spamming the log.
  let lastTurn: number | undefined
  let inTurn = false
  let feedChain: Promise<void> = Promise.resolve()
  let feedBroken = false

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
      const text = event.chunk?.text
      if (typeof text === 'string' && text !== '') {
        enqueue(async () => { await client.feed(text) })
      }
    } else if (event?.type === 'assistant/message' && inTurn && turn === lastTurn) {
      endTurn()
    }
  })

  ctx.effect(() => {
    return () => {
      disposeListener()
      void daemon.dispose()
      delete bag.specPtc
    }
  }, 'spec-ptc.daemon')
}
