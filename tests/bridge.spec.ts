/**
 * Plugin-level tests: the stream bridge forwards session events to the
 * daemon, and every failure mode fails open.
 */
import { describe, expect, it, afterEach } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { apply } from '../src/index.js'
import { startFakeDaemon } from './fake-daemon.mjs'

let daemon: Awaited<ReturnType<typeof startFakeDaemon>> | undefined

afterEach(async () => {
  await daemon?.close()
  daemon = undefined
})

function sock(): string {
  return join(tmpdir(), `spec-bridge-${randomBytes(6).toString('hex')}.sock`)
}

/** Typed local seams for the dsh-session-declared events (cast, see index.ts). */
type SessionBus = {
  emit(name: 'session/event', session: unknown, event: Record<string, unknown>): void
}

function bus(ctx: Context): SessionBus {
  return ctx as unknown as SessionBus
}

function makeCtx(): Context {
  const ctx = new Context()
  const logs: string[] = []
  ;(ctx as unknown as Record<string, unknown>).logger = {
    info: (m: string) => { logs.push(m) },
    warn: (m: string) => { logs.push(m) },
    error: (m: string) => { logs.push(m) },
    debug: () => {},
  }
  return ctx
}

/** Poll until fn() turns true (feeds are serialized async behind the listener). */
async function until(fn: () => boolean, ms = 2000): Promise<void> {
  const started = Date.now()
  while (!fn()) {
    if (Date.now() - started > ms) throw new Error('until() timed out')
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('stream bridge', () => {
  it('forwards turn lifecycle and text deltas to the daemon', async () => {
    const socketPath = sock()
    daemon = await startFakeDaemon({ socketPath })
    const ctx = makeCtx()
    await apply(ctx, { socketPath, autoStart: false })

    bus(ctx).emit('session/event', {}, { type: 'assistant/chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: 'result = ' } })
    bus(ctx).emit('session/event', {}, { type: 'assistant/chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: 'search("x")' } })
    bus(ctx).emit('session/event', {}, { type: 'assistant/message', turn: 1, step: 0, message: {} })

    await until(() => daemon!.received.length >= 4)
    const ops = daemon!.received.map((m: object) => (m as { op: string }).op)
    expect(ops).toEqual(['turn_begin', 'feed', 'feed', 'turn_end'])
    const feeds = daemon!.received.filter((m: object) => (m as { op: string }).op === 'feed')
    expect(feeds.map((m: object) => (m as { delta: string }).delta)).toEqual(['result = ', 'search("x")'])
  })

  it('exposes the specPtc resolve service, hitting the daemon', async () => {
    const socketPath = sock()
    daemon = await startFakeDaemon({
      socketPath,
      onResolve: (tool) => tool === 'search' ? { hit: true, result: 'cached!' } : { hit: false },
    })
    const ctx = makeCtx()
    await apply(ctx, { socketPath, autoStart: false })

    const service = (ctx as unknown as Record<string, { resolve(t: string, a: unknown[]): Promise<unknown> } | undefined>).specPtc
    if (service === undefined) throw new Error('specPtc service not mounted')
    expect(await service.resolve('search', ['x'])).toEqual({ hit: true, result: 'cached!', waitedMs: 3 })
    expect(await service.resolve('other', [])).toEqual({ hit: false })
  })

  it('starts a new turn when the turn number changes', async () => {
    const socketPath = sock()
    daemon = await startFakeDaemon({ socketPath })
    const ctx = makeCtx()
    await apply(ctx, { socketPath, autoStart: false })

    bus(ctx).emit('session/event', {}, { type: 'assistant/chunk', turn: 1, step: 0, chunk: { type: 'text-delta', text: 'a' } })
    bus(ctx).emit('session/event', {}, { type: 'assistant/chunk', turn: 2, step: 0, chunk: { type: 'text-delta', text: 'b' } })

    await until(() => daemon!.received.length >= 5)
    const ops = daemon!.received.map((m: object) => (m as { op: string }).op)
    expect(ops).toEqual(['turn_begin', 'feed', 'turn_end', 'turn_begin', 'feed'])
  })
})

describe('fail-open behavior', () => {
  it('loads cleanly with no daemon and autoStart off — plugin inert', async () => {
    const ctx = makeCtx()
    await expect(apply(ctx, { socketPath: sock(), autoStart: false })).resolves.toBeUndefined()
    expect((ctx as unknown as Record<string, unknown>).specPtc).toBeUndefined()
  })

  it('loads cleanly when the spawn command does not exist', async () => {
    const ctx = makeCtx()
    await expect(apply(ctx, {
      socketPath: sock(),
      autoStart: true,
      command: '/nonexistent/spec-ptc-daemon',
    })).resolves.toBeUndefined()
  }, 15000)
})
