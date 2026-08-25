import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { UvPythonCodeRuntime } from '../src/python-runtime.js'

const fibers: Array<{ dispose(): Promise<void> }> = []
afterEach(async () => { while (fibers.length) await fibers.pop()!.dispose() })
async function runtime(config: Record<string, unknown> = {}) {
  const ctx = new Context()
  const fiber = await ctx.plugin(UvPythonCodeRuntime, { python: '3.12', cpuSeconds: 5, maxWallMs: 5000, addressSpaceBytes: 536870912, maxOutputBytes: 1_000_000, maxFrameBytes: 1_000_000, ...config })
  fibers.push(fiber)
  return ctx.codeRuntime as UvPythonCodeRuntime
}

describe('UvPythonCodeRuntime', () => {
  it('runs top-level await/return and captures ordered logs', async () => {
    const rt = await runtime()
    const out = await rt.run({ program: `print("a")
await tools.echo({"x": 2})
print("b")
return {"ok": True}`, bindings: [{ global: 'tools', functions: { echo: async (args) => args as never } }] })
    expect(out).toEqual({ logs: ['a', '\n', 'b', '\n'], value: { ok: true } })
  }, 20_000)

  it('round-trips a host binding result', async () => {
    const rt = await runtime()
    const out = await rt.run({ program: `value = await tools.double({"n": 3})
return value`, bindings: [{ global: 'tools', functions: { double: async (args) => ({ n: (args as { n: number }).n * 2 }) } }] })
    expect(out.value).toEqual({ n: 6 })
  }, 20_000)

  it('surfaces Python exceptions as resolved failures', async () => {
    const rt = await runtime()
    const out = await rt.run({ program: 'raise ValueError("boom")', bindings: [] })
    expect(out.error?.kind).toBe('exception')
    expect(out.error?.message).toContain('boom')
  }, 20_000)

  it('hard-aborts a hot loop on the wall ceiling', async () => {
    const rt = await runtime({ maxWallMs: 300 })
    const out = await rt.run({ program: `while True:
    pass`, bindings: [] })
    expect(out.error?.kind).toBe('timeout')
  }, 20_000)

  it('materializes typed binding errors with the exact member property', async () => {
    const rt = await runtime()
    const out = await rt.run({
      program: `try:
    await tools.fail({})
except ToolCallError as error:
    return {"name": type(error).__name__, "member": error.toolName}`,
      bindings: [{ global: 'tools', errorClass: { name: 'ToolCallError', memberNameProperty: 'toolName' }, functions: { fail: async () => { throw new Error('nope') } } }],
    })
    expect(out.value).toEqual({ name: 'ToolCallError', member: 'fail' })
  }, 20_000)

  it('aborts an in-flight run and awaits process exit', async () => {
    const rt = await runtime({ maxWallMs: 5000 })
    const controller = new AbortController()
    const pending = rt.run({ program: `while True:
    pass`, bindings: [], signal: controller.signal })
    setTimeout(() => controller.abort('stop'), 100)
    expect((await pending).error).toEqual({ kind: 'abort', message: 'stop' })
  }, 20_000)

  it('does not leak Python globals across runs', async () => {
    const rt = await runtime()
    expect((await rt.run({ program: `global leaked
leaked = 1
return leaked`, bindings: [] })).value).toBe(1)
    const second = await rt.run({ program: `return globals().get("leaked")`, bindings: [] })
    expect(second).toEqual({ logs: [] })
  }, 20_000)

  it('rejects reserved globals as seam misuse before spawn', async () => {
    const rt = await runtime()
    await expect(rt.run({ program: 'return None', bindings: [{ global: 'console', functions: {} }] })).rejects.toThrow(/unusable binding global/)
  })
})
