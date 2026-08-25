/**
 * Loopback execution endpoint: the engine shim's speculative calls land here
 * and run through the harness tool registry for real.
 *
 * Threat model: this is a privileged tool-execution endpoint, so it is
 *  - bound to 127.0.0.1 on an ephemeral port (never LAN-reachable)
 *  - gated by a per-instance random bearer token handed to the daemon child
 *    via env only (never config, never logs — credential doctrine)
 *  - read-only over the registry: it can execute only tools the plugin
 *    config allowlisted as speculatable (pure), and list those same names
 *
 * @module
 */
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { randomBytes } from 'node:crypto'

/** The registry slice the endpoint needs (structural: works with the real ToolRuntime or a test double). */
export interface EndpointToolDefinition {
  execute(args: unknown, exec: unknown): Promise<unknown>
}

export interface EndpointToolRuntime {
  /** Resolve a registered tool definition by public name; undefined when absent. */
  get(name: string): EndpointToolDefinition | undefined
}

export interface EndpointHandle {
  /** Base URL the shim calls back to, e.g. http://127.0.0.1:54321 */
  url: string
  /** The bearer token the daemon child must present (pass via env only). */
  token: string
  close(): Promise<void>
}

export interface EndpointOptions {
  tools: EndpointToolRuntime
  /** Public names of pure tools the daemon may speculate. */
  speculatable: ReadonlySet<string>
  logger: { warn(msg: string): void }
}

interface ExecuteRequest { tool?: unknown; args?: unknown }

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => { chunks.push(c) })
    req.on('end', () => { resolveBody(Buffer.concat(chunks).toString('utf8')) })
    req.on('error', rejectBody)
  })
}

export async function startEndpoint(opts: EndpointOptions): Promise<EndpointHandle> {
  const token = randomBytes(24).toString('hex')
  const server: Server = createServer((req, res) => {
    void (async () => {
      const authed = req.headers.authorization === `Bearer ${token}`
      const send = (status: number, body: unknown): void => {
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
      }
      if (!authed) return send(403, { error: 'forbidden' })

      if (req.method === 'GET' && req.url === '/tools') {
        return send(200, {
          tools: [...opts.speculatable].map((name) => ({ name, latencyHintMs: 1000 })),
        })
      }
      if (req.method === 'POST' && req.url === '/execute') {
        let payload: ExecuteRequest
        try {
          payload = JSON.parse(await readBody(req)) as ExecuteRequest
        } catch {
          return send(400, { error: 'bad json' })
        }
        if (typeof payload.tool !== 'string') return send(400, { error: 'tool must be a string' })
        if (!opts.speculatable.has(payload.tool)) {
          // Hard refusal: never execute a non-allowlisted tool speculatively.
          return send(403, { error: `tool "${payload.tool}" is not speculatable` })
        }
        const definition = opts.tools.get(payload.tool)
        if (definition === undefined) return send(404, { error: `unknown tool "${payload.tool}"` })
        try {
          const result = await definition.execute(payload.args ?? {}, { signal: new AbortController().signal })
          return send(200, { result })
        } catch (error) {
          return send(200, { isError: true, error: error instanceof Error ? error.message : String(error) })
        }
      }
      return send(404, { error: 'not found' })
    })().catch((error) => {
      opts.logger.warn(`spec-ptc endpoint error: ${String(error)}`)
      res.writeHead(500); res.end()
    })
  })
  await new Promise<void>((resolveListen) => { server.listen(0, '127.0.0.1', resolveListen) })
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('spec-ptc: endpoint got no address')
  return {
    url: `http://127.0.0.1:${String(address.port)}`,
    token,
    close: () => new Promise<void>((resolveClose) => { server.close(() => { resolveClose() }) }),
  }
}
