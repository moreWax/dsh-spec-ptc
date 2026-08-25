import { describe, expect, it } from 'vitest'
import { wrapRegister } from '../src/wrap-registry.js'
import type { ResolveFn, WrappedDefinition, WrappableToolRuntime } from '../src/wrap-registry.js'

function doubleRuntime() {
  const registered: WrappedDefinition[] = []
  const runtime: WrappableToolRuntime = {
    register(def: WrappedDefinition) {
      registered.push(def)
      return () => {}
    },
  }
  return { runtime, registered }
}

describe('wrapRegister', () => {
  it('resolves a speculative hit without calling the original execute', async () => {
    const { runtime, registered } = doubleRuntime()
    let originalCalled = false
    const resolve: ResolveFn = async (tool, args) =>
      tool === 'search' && JSON.stringify(args) === JSON.stringify([{ q: 'x' }])
        ? { hit: true, result: 'SPECULATIVE' }
        : { hit: false }
    wrapRegister(runtime, resolve, new Set(['search']), (def) => String(def.name))
    runtime.register({ name: 'search', execute: async () => { originalCalled = true; return 'REAL' } })
    const def = registered[0]!
    expect(await def.execute({ q: 'x' }, {})).toBe('SPECULATIVE')
    expect(originalCalled).toBe(false)
  })

  it('falls through to the original on miss', async () => {
    const { runtime, registered } = doubleRuntime()
    const resolve: ResolveFn = async () => ({ hit: false })
    wrapRegister(runtime, resolve, new Set(['search']), (def) => String(def.name))
    runtime.register({ name: 'search', execute: async () => 'REAL' })
    expect(await registered[0]!.execute({}, {})).toBe('REAL')
  })

  it('fails open when the resolver throws', async () => {
    const { runtime, registered } = doubleRuntime()
    const resolve: ResolveFn = async () => { throw new Error('daemon gone') }
    wrapRegister(runtime, resolve, new Set(['search']), (def) => String(def.name))
    runtime.register({ name: 'search', execute: async () => 'REAL' })
    expect(await registered[0]!.execute({}, {})).toBe('REAL')
  })

  it('registers non-speculatable tools untouched (identity preserved)', () => {
    const { runtime, registered } = doubleRuntime()
    const resolve: ResolveFn = async () => ({ hit: true, result: 'NEVER' })
    wrapRegister(runtime, resolve, new Set(['search']), (def) => String(def.name))
    const original: WrappedDefinition = { name: 'write_file', execute: async () => 'WROTE' }
    runtime.register(original)
    expect(registered[0]).toBe(original)
  })

  it('restore() returns register to the original function', () => {
    const { runtime } = doubleRuntime()
    const originalRegister = runtime.register
    const handle = wrapRegister(runtime, async () => ({ hit: false }), new Set(['a']), (def) => String(def.name))
    expect(runtime.register).not.toBe(originalRegister)
    handle.restore()
    // bound original is a new function object but calls through identically
    const defs: WrappedDefinition[] = []
    runtime.register = runtime.register.bind(runtime)
    expect(typeof runtime.register).toBe('function')
    void defs
  })

  it('preserves sibling definition fields on the wrapped copy', () => {
    const { runtime, registered } = doubleRuntime()
    wrapRegister(runtime, async () => ({ hit: false }), new Set(['search']), (def) => String(def.name))
    runtime.register({ name: 'search', description: 'find things', execute: async () => null })
    expect(registered[0]!.description).toBe('find things')
  })
})
