import { describe, expect, it } from 'vitest'
import { ReplFeedAdapter, rewriteLine } from '../src/repl-adapter.js'

function chunk(argumentsDelta: string, name: string | undefined = undefined, index = 0) {
  return { type: 'tool-call-delta' as const, index, ...(name === undefined ? {} : { name }), argumentsDelta }
}

describe('ReplFeedAdapter', () => {
  it('extracts run_code code, unescapes JSON, rewrites dsh Python calls, and fences it', () => {
    const a = new ReplFeedAdapter()
    const json = JSON.stringify({ description: 'lookup', code: 'x = await tools.search({"q": "spec"})\nprint(x)' })
    const out = [...a.push(chunk(json, 'run_code')), ...a.finish()].join('')
    expect(out).toBe('```repl\nx = search({"q": "spec"})\nprint(x)\n```\n')
  })

  it('survives every possible single split point in the arguments JSON', () => {
    const json = JSON.stringify({ code: 'answer = await tools.read_file({"path": "a\\nb"})\n', description: 'd' })
    for (let at = 1; at < json.length; at++) {
      const a = new ReplFeedAdapter()
      const out = [
        ...a.push(chunk(json.slice(0, at), 'run_code')),
        ...a.push(chunk(json.slice(at))),
        ...a.finish(),
      ].join('')
      expect(out, `split at ${String(at)}`).toBe('```repl\nanswer = read_file({"path": "a\\nb"})\n\n```\n')
    }
  })

  it('ignores non-run_code calls', () => {
    const a = new ReplFeedAdapter()
    expect(a.push(chunk('{"q":"x"}', 'search'))).toEqual([])
    expect(a.finish()).toEqual([])
  })

  it('closes one run_code fence before opening a new call index', () => {
    const a = new ReplFeedAdapter()
    const first = JSON.stringify({ code: 'await tools.a({})' })
    const second = JSON.stringify({ code: 'await tools.b({})' })
    const out = [
      ...a.push(chunk(first, 'run_code', 0)),
      ...a.push(chunk(second, 'run_code', 1)),
      ...a.finish(),
    ].join('')
    expect(out).toBe('```repl\na({})\n```\n```repl\nb({})\n```\n')
  })

  it('handles unicode escapes split across deltas', () => {
    const a = new ReplFeedAdapter()
    const raw = '{"code":"print(\\u263a)"}'
    const at = raw.indexOf('263a') + 2
    const out = [...a.push(chunk(raw.slice(0, at), 'run_code')), ...a.push(chunk(raw.slice(at))), ...a.finish()].join('')
    expect(out).toBe('```repl\nprint(☺)\n```\n')
  })
})

describe('rewriteLine', () => {
  it('rewrites multiple await and non-await tools calls', () => {
    expect(rewriteLine('a = await tools.x(1); b = tools.y(2)')).toBe('a = x(1); b = y(2)')
  })
})
