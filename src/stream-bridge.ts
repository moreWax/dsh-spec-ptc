/** Ordered session-event to daemon-protocol bridge. */
import type { SpecClient } from './client.js'
import { ReplFeedAdapter } from './repl-adapter.js'
import type { ToolCallDeltaChunk } from './repl-adapter.js'

export interface SessionEventLike {
  type?: string
  turn?: number
  chunk?: { type?: string; text?: string; index?: number; name?: string; argumentsDelta?: string }
}

export interface StreamBridgeOptions {
  client: Pick<SpecClient, 'turnBegin' | 'turnEnd' | 'feed'>
  logger: { info(message: string): void; warn(message: string): void }
  feedEnabled: boolean
  translateRunCode: boolean
}

/** Owns per-turn state and serializes all writes to the line protocol. */
export class TurnStreamBridge {
  private lastTurn: number | undefined
  private inTurn = false
  private chain: Promise<void> = Promise.resolve()
  private broken = false
  private readonly repl = new ReplFeedAdapter()

  constructor(private readonly options: StreamBridgeOptions) {}

  accept(event: SessionEventLike): void {
    if (!this.options.feedEnabled || this.broken) return
    const turn = event.turn
    if (event.type === 'assistant/chunk' && typeof turn === 'number') {
      if (!this.inTurn || turn !== this.lastTurn) this.begin(turn)
      const chunk = event.chunk
      if (chunk?.type === 'text-delta' && typeof chunk.text === 'string' && chunk.text !== '') {
        this.enqueue(() => this.options.client.feed(chunk.text as string))
      } else if (this.options.translateRunCode && chunk?.type === 'tool-call-delta' && typeof chunk.index === 'number' && typeof chunk.argumentsDelta === 'string') {
        for (const delta of this.repl.push(chunk as ToolCallDeltaChunk)) this.enqueue(() => this.options.client.feed(delta))
      }
    } else if (event.type === 'assistant/message' && this.inTurn && turn === this.lastTurn) {
      for (const delta of this.repl.finish()) this.enqueue(() => this.options.client.feed(delta))
      this.end()
    }
  }

  /** Allows lifecycle owners and tests to await all already-enqueued traffic. */
  async flush(): Promise<void> { await this.chain }

  private enqueue(work: () => Promise<unknown>): void {
    this.chain = this.chain.then(async () => { await work() }).catch((error) => {
      if (!this.broken) {
        this.broken = true
        this.options.logger.warn(`spec-ptc: daemon feed failed (${String(error)}) — bridge disabled until next turn`)
      }
    })
  }

  private begin(turn: number): void {
    if (this.inTurn) this.enqueue(() => this.options.client.turnEnd())
    this.enqueue(() => this.options.client.turnBegin({}))
    this.inTurn = true
    this.lastTurn = turn
  }

  private end(): void {
    const finished = this.lastTurn
    this.enqueue(async () => {
      const metrics = await this.options.client.turnEnd()
      this.options.logger.info(`spec-ptc: turn ${String(finished)} — speculated ${String(metrics.speculated ?? 0)}, claimed ${String(metrics.claimed ?? 0)}, evicted ${String(metrics.evicted ?? 0)}`)
    })
    this.inTurn = false
  }
}
