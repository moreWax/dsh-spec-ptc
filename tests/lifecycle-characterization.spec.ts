import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { startEndpoint } from '../src/endpoint.js'
import { SpecClient } from '../src/client.js'

const endpoints: Array<{ close(): Promise<void> }> = []
afterEach(async () => { while (endpoints.length) await endpoints.pop()!.close() })

describe('lifecycle characterization', () => {
  it('endpoint close is idempotent', async () => {
    const endpoint = await startEndpoint({
      tools: { get: () => undefined }, speculatable: new Set(), logger: { warn: () => {} },
    })
    await endpoint.close()
    await expect(endpoint.close()).resolves.toBeUndefined()
  })

  it('runtime-facing public exports remain available', async () => {
    const api = await import('../src/index.js')
    expect(api.SpecClient).toBe(SpecClient)
    expect(api).toMatchObject({
      name: 'spec-ptc', inject: ['tools'], provide: ['specPtc'],
      ensureDaemon: expect.any(Function), startEndpoint: expect.any(Function),
      wrapLookup: expect.any(Function), ReplFeedAdapter: expect.any(Function),
    })
  })

  it('plugin stays inert when daemon discovery fails', async () => {
    const ctx = new Context()
    await expect(apiApply(ctx)).resolves.toBeUndefined()
    expect((ctx as unknown as Record<string, unknown>).specPtc).toBeUndefined()
  })
})

async function apiApply(ctx: Context): Promise<void> {
  const { apply } = await import('../src/index.js')
  await apply(ctx, { socketPath: `/tmp/spec-ptc-absent-${process.pid}.sock`, autoStart: false })
}
