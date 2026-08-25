import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { parse } from 'yaml'
import { inject, provide } from '../src/index.js'

describe('package integration manifest', () => {
  it('declares the tools service it reads from ctx', () => {
    expect(inject).toContain('tools')
    expect(provide).toContain('specPtc')
  })

  it('declares cordis.patch.yml as a dsh profile bundle', () => {
    const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as { dsh?: { bundle?: { patch?: string } } }
    expect(pkg.dsh?.bundle?.patch).toBe('./cordis.patch.yml')
  })

  it('ships a parseable patch list', () => {
    const rows = parse(readFileSync(resolve('cordis.patch.yml'), 'utf8')) as Array<{ insert?: Array<{ id?: string }> }>
    expect(Array.isArray(rows)).toBe(true)
    expect(rows.flatMap((row) => row.insert ?? []).some((entry) => entry.id === 'spec-ptc')).toBe(true)
  })
})
