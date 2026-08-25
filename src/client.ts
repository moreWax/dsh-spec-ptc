/**
 * TypeScript client for the upstream spec-ptc daemon — a line-for-line port
 * of the reference `plugins/client.py` (MIT, alexzhang13/spec-ptc).
 *
 * Wire protocol: newline-delimited JSON over a Unix domain socket.
 *   turn_begin {vars}  -> {ok: true}
 *   feed {delta}       -> {ok: true}
 *   resolve {tool,args}-> {status:"hit", result, waited_ms} | {status:"miss"}
 *   turn_end           -> {ok, metrics:{speculated,claimed,evicted,...}}
 * Any malformed message -> {ok: false, error}.
 *
 * NOTE: resolve BLOCKS server-side (the daemon waits for the speculative
 * call to finish, up to its own timeout) — that wait is the point: the call
 * already ran during generation.
 *
 * @module
 */
import { Socket } from 'node:net'

export interface TurnMetrics {
  speculated?: number
  claimed?: number
  evicted?: number
  [key: string]: unknown
}

export type ResolveOutcome =
  | { hit: true; result: unknown; waitedMs?: number }
  | { hit: false }

export class SpecClient {
  private socket: Socket | undefined
  private buffer = ''
  private waiters: Array<{
    resolve: (msg: Record<string, unknown>) => void
    reject: (err: Error) => void
  }> = []

  private constructor(private readonly socketPath: string) {}

  static async connect(socketPath: string, timeoutMs = 5000): Promise<SpecClient> {
    const client = new SpecClient(socketPath)
    await client.open(timeoutMs)
    return client
  }

  private open(timeoutMs: number): Promise<void> {
    return new Promise((resolvePromise, rejectPromise) => {
      const socket = new Socket()
      const timer = setTimeout(() => {
        socket.destroy()
        rejectPromise(new Error(`spec-ptc: connect to ${this.socketPath} timed out`))
      }, timeoutMs)
      socket.on('error', (err) => {
        clearTimeout(timer)
        rejectPromise(err)
      })
      socket.connect(this.socketPath, () => {
        clearTimeout(timer)
        socket.removeAllListeners('error')
        this.socket = socket
        socket.on('data', (data) => this.onData(data))
        socket.on('error', (err) => this.failAll(err))
        socket.on('close', () => this.failAll(new Error('spec-ptc daemon closed')))
        resolvePromise()
      })
    })
  }

  private onData(data: Buffer): void {
    this.buffer += data.toString('utf8')
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline === -1) return
      const line = this.buffer.slice(0, newline)
      this.buffer = this.buffer.slice(newline + 1)
      const waiter = this.waiters.shift()
      if (waiter === undefined) continue
      try {
        waiter.resolve(JSON.parse(line) as Record<string, unknown>)
      } catch {
        waiter.reject(new Error(`spec-ptc: daemon sent bad json: ${line.slice(0, 120)}`))
      }
    }
  }

  private failAll(err: Error): void {
    for (const waiter of this.waiters.splice(0)) waiter.reject(err)
  }

  /** In-order RPC: the daemon answers messages strictly in order. */
  private rpc(message: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (this.socket === undefined) return Promise.reject(new Error('spec-ptc: not connected'))
    return new Promise((resolvePromise, rejectPromise) => {
      this.waiters.push({ resolve: resolvePromise, reject: rejectPromise })
      this.socket?.write(JSON.stringify(message) + '\n', (err) => {
        if (err) {
          this.waiters.pop()
          rejectPromise(err)
        }
      })
    })
  }

  async turnBegin(variables: Record<string, unknown> = {}): Promise<void> {
    await this.rpc({ op: 'turn_begin', vars: variables })
  }

  async feed(delta: string): Promise<void> {
    await this.rpc({ op: 'feed', delta })
  }

  /** The claimed result, or a miss — in which case run the tool yourself. */
  async resolve(tool: string, args: unknown[]): Promise<ResolveOutcome> {
    const reply = await this.rpc({ op: 'resolve', tool, args })
    if (reply.status === 'hit') {
      return {
        hit: true,
        result: reply.result,
        ...(typeof reply.waited_ms === 'number' ? { waitedMs: reply.waited_ms } : {}),
      }
    }
    return { hit: false }
  }

  async turnEnd(): Promise<TurnMetrics> {
    const reply = await this.rpc({ op: 'turn_end' })
    return (reply.metrics ?? {}) as TurnMetrics
  }

  close(): void {
    this.socket?.destroy()
    this.socket = undefined
  }
}
