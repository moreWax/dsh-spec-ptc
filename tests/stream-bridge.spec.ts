import { describe, expect, it } from 'vitest'
import { TurnStreamBridge } from '../src/stream-bridge.js'

function fixture() {
  const ops: string[] = [], warnings: string[] = []
  const bridge = new TurnStreamBridge({
    client: {
      turnBegin: async () => { ops.push('begin') },
      feed: async delta => { ops.push(`feed:${delta}`) },
      turnEnd: async () => { ops.push('end'); return { speculated: 1, claimed: 1 } },
    },
    logger: { info: message => { ops.push(`info:${message}`) }, warn: message => { warnings.push(message) } },
    feedEnabled: true, translateRunCode: false,
  })
  return { bridge, ops, warnings }
}

describe('TurnStreamBridge', () => {
  it('owns and serializes a complete turn', async () => {
    const { bridge, ops } = fixture()
    bridge.accept({ type: 'assistant/chunk', turn: 7, chunk: { type: 'text-delta', text: 'x' } })
    bridge.accept({ type: 'assistant/message', turn: 7 })
    await bridge.flush()
    expect(ops.slice(0, 3)).toEqual(['begin', 'feed:x', 'end'])
    expect(ops[3]).toContain('turn 7')
  })

  it('closes an overlapping old turn before beginning the new turn', async () => {
    const { bridge, ops } = fixture()
    bridge.accept({ type: 'assistant/chunk', turn: 1, chunk: { type: 'text-delta', text: 'a' } })
    bridge.accept({ type: 'assistant/chunk', turn: 2, chunk: { type: 'text-delta', text: 'b' } })
    await bridge.flush()
    expect(ops).toEqual(['begin', 'feed:a', 'end', 'begin', 'feed:b'])
  })
})
