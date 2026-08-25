import { describe, expect, it } from 'vitest'
import { wrapBindings } from '../src/bindings.js'
import type { Bindings, ResolveHook } from '../src/bindings.js'

describe('wrapBindings', () => {
  it('returns the speculative result on a hit without calling the original', async () => {
    let originalCalls = 0
    const bindings: Bindings = {
      search: async () => { originalCalls += 1; return 'fresh result' },
    }
    const resolve: ResolveHook = async () => ({ hit: true, result: 'speculative result' })
    const wrapped = wrapBindings(bindings, resolve)
    expect(await wrapped.search!('q')).toBe('speculative result')
    expect(originalCalls).toBe(0)
  })

  it('passes through to the original on a miss, with the same args', async () => {
    const seen: unknown[] = []
    const bindings: Bindings = {
      add: async (...args) => { seen.push(args); return (args[0] as number) + (args[1] as number) },
    }
    const resolve: ResolveHook = async () => ({ hit: false })
    const wrapped = wrapBindings(bindings, resolve)
    expect(await wrapped.add!(2, 3)).toBe(5)
    expect(seen).toEqual([[2, 3]])
  })

  it('fails open when the resolver throws', async () => {
    const bindings: Bindings = { tool: async () => 'ran normally' }
    const resolve: ResolveHook = async () => { throw new Error('daemon gone') }
    const wrapped = wrapBindings(bindings, resolve)
    expect(await wrapped.tool!()).toBe('ran normally')
  })

  it('does not mutate the original table and forwards the tool name', async () => {
    const names: string[] = []
    const bindings: Bindings = { alpha: async () => 'a', beta: async () => 'b' }
    const resolve: ResolveHook = async (name) => { names.push(name); return { hit: false } }
    const wrapped = wrapBindings(bindings, resolve)
    await wrapped.alpha!()
    await wrapped.beta!()
    expect(names).toEqual(['alpha', 'beta'])
    expect(Object.keys(bindings)).toEqual(['alpha', 'beta'])
  })
})
