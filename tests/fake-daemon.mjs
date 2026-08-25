/**
 * Fake spec-ptc daemon for tests: speaks the exact upstream wire protocol
 * (newline-delimited JSON over a Unix socket) with scripted behavior.
 * No Python required.
 */
import { createServer } from 'node:net'
import { unlinkSync, existsSync } from 'node:fs'

/**
 * @param {object} opts
 * @param {string} opts.socketPath
 * @param {(tool: string, args: unknown[]) => {hit: boolean, result?: unknown}} [opts.onResolve]
 * @returns {Promise<{received: object[], close: () => Promise<void>}>}
 */
export async function startFakeDaemon({ socketPath, onResolve }) {
  const received = []
  const connections = new Set()
  const resolve_ = onResolve ?? (() => ({ hit: false }))
  const server = createServer((conn) => {
    connections.add(conn)
    conn.on('close', () => connections.delete(conn))
    let buffer = ''
    conn.on('data', (data) => {
      buffer += data.toString('utf8')
      for (;;) {
        const nl = buffer.indexOf('\n')
        if (nl === -1) return
        const line = buffer.slice(0, nl)
        buffer = buffer.slice(nl + 1)
        let msg
        try {
          msg = JSON.parse(line)
        } catch {
          conn.write(JSON.stringify({ ok: false, error: 'bad json' }) + '\n')
          continue
        }
        received.push(msg)
        if (msg.op === 'turn_begin' || msg.op === 'feed') {
          conn.write(JSON.stringify({ ok: true }) + '\n')
        } else if (msg.op === 'resolve') {
          const outcome = resolve_(msg.tool, msg.args ?? [])
          conn.write(JSON.stringify(
            outcome.hit
              ? { status: 'hit', result: outcome.result, waited_ms: 3 }
              : { status: 'miss' },
          ) + '\n')
        } else if (msg.op === 'turn_end') {
          conn.write(JSON.stringify({
            ok: true,
            metrics: { speculated: 2, claimed: 1, evicted: 1 },
          }) + '\n')
        } else {
          conn.write(JSON.stringify({ ok: false, error: `unknown op ${msg.op}` }) + '\n')
        }
      }
    })
  })
  if (existsSync(socketPath)) unlinkSync(socketPath)
  await new Promise((r) => { server.listen(socketPath, r) })
  return {
    received,
    // server.close() alone waits for open connections — and a plugin under
    // test may legitimately hold its socket open. Destroy them explicitly.
    close: () => new Promise((r) => {
      for (const conn of connections) conn.destroy()
      server.close(() => { r() })
    }),
  }
}
