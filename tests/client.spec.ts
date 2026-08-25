import { describe, expect, it, afterEach } from 'vitest'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { randomBytes } from 'node:crypto'
import { SpecClient } from '../src/client.js'
import { startFakeDaemon } from './fake-daemon.mjs'

let daemon: Awaited<ReturnType<typeof startFakeDaemon>> | undefined
let client: SpecClient | undefined

afterEach(async () => {
  client?.close()
  client = undefined
  await daemon?.close()
  daemon = undefined
})

function sock(): string {
  return join(tmpdir(), `spec-test-${randomBytes(6).toString('hex')}.sock`)
}

describe('SpecClient', () => {
  it('runs the full turn lifecycle against the wire protocol', async () => {
    daemon = await startFakeDaemon({
      socketPath: (globalThis as Record<string, unknown>).__sock = sock(),
      onResolve: (tool) => tool === 'fast' ? { hit: true, result: { answer: 42 } } : { hit: false },
    })
    client = await SpecClient.connect((globalThis as Record<string, unknown>).__sock as string)

    await client.turnBegin({ context: 'doc' })
    await client.feed('result = fast(')
    await client.feed('"what is the answer")')

    const hit = await client.resolve('fast', ['what is the answer'])
    expect(hit).toEqual({ hit: true, result: { answer: 42 }, waitedMs: 3 })

    const miss = await client.resolve('slow', [])
    expect(miss).toEqual({ hit: false })

    const metrics = await client.turnEnd()
    expect(metrics).toEqual({ speculated: 2, claimed: 1, evicted: 1 })

    const ops = daemon.received.map((m) => (m as { op: string }).op)
    expect(ops).toEqual(['turn_begin', 'feed', 'feed', 'resolve', 'resolve', 'turn_end'])
  })

  it('forwards resolve arguments exactly', async () => {
    const socketPath = sock()
    daemon = await startFakeDaemon({ socketPath })
    client = await SpecClient.connect(socketPath)
    await client.resolve('tool', [1, 'two', { three: 3 }])
    expect(daemon.received[0]).toEqual({ op: 'resolve', tool: 'tool', args: [1, 'two', { three: 3 }] })
  })

  it('rejects when the daemon is absent', async () => {
    await expect(SpecClient.connect(sock(), 500)).rejects.toThrow()
  })
})
