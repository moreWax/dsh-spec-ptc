import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { parse } from 'yaml'
import { provide } from '../src/python-runtime.js'

describe('combined bundle runtime manifest', () => {
  it('provides codeRuntime', () => { expect(provide).toContain('codeRuntime') })
  it('disables the stock runtime and inserts both Python runtime and spec-ptc', () => {
    const rows = parse(readFileSync('cordis.patch.yml', 'utf8')) as Array<Record<string, unknown>>
    expect(rows).toContainEqual(expect.objectContaining({ id: 'code-runtime', disabled: true }))
    const inserted = rows.flatMap(row => (row.insert ?? []) as Array<{ id: string; name: string }>)
    expect(inserted).toContainEqual({ id: 'code-runtime-python-uv', name: '@morewax/dsh-spec-ptc/python-runtime', config: expect.any(Object) })
    expect(inserted).toContainEqual({ id: 'spec-ptc', name: '@morewax/dsh-spec-ptc', config: expect.any(Object) })
  })
})
