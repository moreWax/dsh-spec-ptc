import { describe, expect, it } from 'vitest'
import { startEndpoint } from '../src/endpoint.js'
import type { EndpointToolDefinition } from '../src/endpoint.js'

const logger = { warn: () => {} }

function doubleTools(defs: Record<string, (args: unknown) => Promise<unknown>>) {
  return {
    get(name: string): EndpointToolDefinition | undefined {
      const fn = defs[name]
      return fn === undefined ? undefined : { execute: (args) => fn(args) }
    },
  }
}

describe('callback endpoint', () => {
  it('rejects unauthenticated requests', async () => {
    const ep = await startEndpoint({ tools: doubleTools({}), speculatable: new Set(['search']), logger })
    try {
      const res = await fetch(`${ep.url}/tools`)
      expect(res.status).toBe(403)
    } finally { await ep.close() }
  })

  it('lists only the speculatable tool names', async () => {
    const ep = await startEndpoint({ tools: doubleTools({}), speculatable: new Set(['search', 'read_file']), logger })
    try {
      const res = await fetch(`${ep.url}/tools`, { headers: { authorization: `Bearer ${ep.token}` } })
      expect(res.status).toBe(200)
      const body = await res.json() as { tools: Array<{ name: string }> }
      expect(body.tools.map((t) => t.name).sort()).toEqual(['read_file', 'search'])
    } finally { await ep.close() }
  })

  it('executes an allowlisted tool and returns its result', async () => {
    let seenArgs: unknown
    const ep = await startEndpoint({
      tools: doubleTools({ search: async (args) => { seenArgs = args; return { hits: 3 } } }),
      speculatable: new Set(['search']),
      logger,
    })
    try {
      const res = await fetch(`${ep.url}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ tool: 'search', args: { q: 'spec' } }),
      })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ result: { hits: 3 } })
      expect(seenArgs).toEqual({ q: 'spec' })
    } finally { await ep.close() }
  })

  it('hard-refuses non-allowlisted tools (never speculate side effects)', async () => {
    let called = false
    const ep = await startEndpoint({
      tools: doubleTools({ write_file: async () => { called = true; return null } }),
      speculatable: new Set(['search']),
      logger,
    })
    try {
      const res = await fetch(`${ep.url}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ tool: 'write_file', args: {} }),
      })
      expect(res.status).toBe(403)
      expect(called).toBe(false)
    } finally { await ep.close() }
  })

  it('prefers the complete registry execute pipeline when available', async () => {
    let directCalled = false
    let input: unknown
    const ep = await startEndpoint({
      tools: {
        get: () => ({ execute: async () => { directCalled = true; return 'DIRECT' } }),
        execute: async (next) => { input = next; return { isError: false, value: 'PIPELINE' } },
      },
      speculatable: new Set(['search']),
      logger,
    })
    try {
      const res = await fetch(`${ep.url}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ tool: 'search', args: { q: 'x' } }),
      })
      expect(await res.json()).toEqual({ result: 'PIPELINE' })
      expect(directCalled).toBe(false)
      expect(input).toMatchObject({ name: 'search', arguments: { q: 'x' } })
    } finally { await ep.close() }
  })

  it('surfaces tool errors as isError without crashing', async () => {
    const ep = await startEndpoint({
      tools: doubleTools({ search: async () => { throw new Error('backend down') } }),
      speculatable: new Set(['search']),
      logger,
    })
    try {
      const res = await fetch(`${ep.url}/execute`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${ep.token}` },
        body: JSON.stringify({ tool: 'search', args: {} }),
      })
      expect(await res.json()).toEqual({ isError: true, error: 'backend down' })
    } finally { await ep.close() }
  })
})
