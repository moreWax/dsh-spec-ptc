import { describe, expect, it } from 'vitest'
import { wrapLookup } from '../src/wrap-registry.js'
import type { ResolveFn, WrappedDefinition, WrappableToolRuntime } from '../src/wrap-registry.js'

function doubleRuntime(defs: Record<string, WrappedDefinition>) {
  const runtime: WrappableToolRuntime = { get(name: string) { return defs[name] } }
  return runtime
}

describe('wrapLookup', () => {
  it('wraps definitions that existed before activation', async () => {
    let originalCalled = false
    const runtime = doubleRuntime({ search: { name: 'search', execute: async () => { originalCalled = true; return 'REAL' } } })
    const resolve: ResolveFn = async (tool, args) => tool === 'search' && JSON.stringify(args) === '[{"q":"x"}]'
      ? { hit: true, result: 'SPECULATIVE' } : { hit: false }
    wrapLookup(runtime, resolve, new Set(['search']))
    expect(await runtime.get('search')!.execute({ q: 'x' }, {})).toBe('SPECULATIVE')
    expect(originalCalled).toBe(false)
  })

  it('wraps definitions registered after activation', async () => {
    const defs: Record<string, WrappedDefinition> = {}
    const runtime = doubleRuntime(defs)
    wrapLookup(runtime, async () => ({ hit: true, result: 'HIT' }), new Set(['search']))
    defs.search = { name: 'search', execute: async () => 'REAL' }
    expect(await runtime.get('search')!.execute({}, {})).toBe('HIT')
  })

  it('falls through on a miss and on resolver failure', async () => {
    const definition = { name: 'search', execute: async () => 'REAL' }
    const miss = doubleRuntime({ search: definition })
    wrapLookup(miss, async () => ({ hit: false }), new Set(['search']))
    expect(await miss.get('search')!.execute({}, {})).toBe('REAL')
    const broken = doubleRuntime({ search: definition })
    wrapLookup(broken, async () => { throw new Error('daemon gone') }, new Set(['search']))
    expect(await broken.get('search')!.execute({}, {})).toBe('REAL')
  })

  it('returns non-speculatable definitions untouched', () => {
    const original: WrappedDefinition = { name: 'write', execute: async () => null }
    const runtime = doubleRuntime({ write: original })
    wrapLookup(runtime, async () => ({ hit: true, result: null }), new Set(['search']))
    expect(runtime.get('write')).toBe(original)
  })

  it('memoizes a wrapper per original identity and preserves sibling fields', () => {
    const original: WrappedDefinition = { name: 'search', description: 'find', execute: async () => null }
    const runtime = doubleRuntime({ search: original })
    wrapLookup(runtime, async () => ({ hit: false }), new Set(['search']))
    expect(runtime.get('search')).toBe(runtime.get('search'))
    expect(runtime.get('search')!.description).toBe('find')
  })

  it('restore returns the original lookup behavior', () => {
    const original: WrappedDefinition = { name: 'search', execute: async () => null }
    const runtime = doubleRuntime({ search: original })
    const handle = wrapLookup(runtime, async () => ({ hit: true, result: null }), new Set(['search']))
    expect(runtime.get('search')).not.toBe(original)
    handle.restore()
    expect(runtime.get('search')).toBe(original)
  })
})
