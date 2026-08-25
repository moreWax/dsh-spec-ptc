/** uv-managed CPython process provider for the dsh CodeRuntime seam. */
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { accessSync, constants, existsSync } from 'node:fs'
import { delimiter, isAbsolute, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Duplex } from 'node:stream'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import {
  CodeRuntime, DUNDER_MEMBER, PORTABLE_RESERVED_WORDS,
  RESERVED_BINDING_GLOBALS, RESERVED_ERROR_MEMBERS,
} from '@deepseek-ai/dsh-code-runtime'
import type {
  CodeBindingNamespace, CodeJsonValue, CodeRunFailure, CodeRunRequest, CodeRunResult,
} from '@deepseek-ai/dsh-code-runtime'
import {
  checkDoneValue, encodeJsonPlain, hasUnsafeIntegerToken, validateChildFrame,
} from '@deepseek-ai/dsh-code-runtime-python'
import type { BootMessage, ReplyMessage } from '@deepseek-ai/dsh-code-runtime-python'

export const name = 'spec-ptc-code-runtime-python-uv'
export const provide = ['codeRuntime']

export interface Config {
  /** Absolute uv path or command resolved from the host PATH. */
  uv?: string
  /** uv Python request (version, executable, or interpreter path). */
  python?: string
  cpuSeconds?: number
  maxWallMs?: number
  addressSpaceBytes?: number
  maxOutputBytes?: number
  /** Maximum one-line fd-3 frame accepted from hostile model code. */
  maxFrameBytes?: number
}
type Resolved = Required<Config>
export const Config: z<Config> = z.object({
  uv: z.string().default('uv'),
  python: z.string().default('3.12'),
  cpuSeconds: z.number().default(60),
  maxWallMs: z.number().default(600_000),
  addressSpaceBytes: z.number().default(536_870_912),
  maxOutputBytes: z.number().default(67_108_864),
  maxFrameBytes: z.number().default(67_108_864),
}) as unknown as z<Config>

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/
const PYTHON_PROJECT = fileURLToPath(new URL('../python-runtime', import.meta.url))
const BOOTSTRAP = fileURLToPath(new URL('../python-runtime/bootstrap.py', import.meta.url))
const MAX_TIMER = 2_147_483_647

interface LiveRun { child: ChildProcess; settle(error: CodeRunFailure): void; finished: Promise<void> }
function messageOf(error: unknown): string { return error instanceof Error ? error.message : String(error) }

function resolveExecutable(command: string): string {
  if (isAbsolute(command) || command.includes('/')) {
    accessSync(command, constants.X_OK); return command
  }
  for (const dir of (process.env.PATH ?? '').split(delimiter)) {
    if (!dir) continue
    const candidate = join(dir, command)
    try { accessSync(candidate, constants.X_OK); return candidate } catch { /* next */ }
  }
  throw new Error(`dsh-code-runtime-python-uv: executable ${JSON.stringify(command)} not found on PATH`)
}

function cloneJson(value: unknown): CodeJsonValue {
  const seen = new Set<object>()
  const walk = (input: unknown): CodeJsonValue => {
    if (input === null || typeof input === 'boolean' || typeof input === 'string') return input
    if (typeof input === 'number') {
      if (!Number.isFinite(input) || Object.is(input, -0)) throw new Error('value must be lossless JSON')
      return input
    }
    if (typeof input !== 'object') throw new Error('value must be lossless JSON')
    if (seen.has(input)) throw new Error('value must be acyclic JSON')
    seen.add(input)
    try {
      if (Array.isArray(input)) return input.map(walk)
      const proto = Object.getPrototypeOf(input)
      if (proto !== Object.prototype && proto !== null) throw new Error('value must be plain JSON')
      const output: Record<string, CodeJsonValue> = Object.create(null) as Record<string, CodeJsonValue>
      for (const [key, entry] of Object.entries(input)) output[key] = walk(entry)
      return output
    } finally { seen.delete(input) }
  }
  return walk(value)
}

function validateBindings(request: CodeRunRequest): Map<string, CodeBindingNamespace> {
  const bindings = new Map<string, CodeBindingNamespace>()
  const errors = new Set<string>()
  for (const ns of request.bindings) {
    if (!IDENTIFIER.test(ns.global) || PORTABLE_RESERVED_WORDS.has(ns.global) || RESERVED_BINDING_GLOBALS.has(ns.global))
      throw new Error(`dsh-code-runtime-python-uv: unusable binding global ${JSON.stringify(ns.global)}`)
    if (bindings.has(ns.global)) throw new Error(`dsh-code-runtime-python-uv: duplicate binding global ${JSON.stringify(ns.global)}`)
    bindings.set(ns.global, ns)
  }
  for (const ns of request.bindings) {
    const descriptor = ns.errorClass
    if (!descriptor) continue
    if (!IDENTIFIER.test(descriptor.name) || PORTABLE_RESERVED_WORDS.has(descriptor.name) || RESERVED_BINDING_GLOBALS.has(descriptor.name))
      throw new Error(`dsh-code-runtime-python-uv: unusable error class ${JSON.stringify(descriptor.name)}`)
    if (bindings.has(descriptor.name) || errors.has(descriptor.name)) throw new Error(`dsh-code-runtime-python-uv: duplicate injected global ${JSON.stringify(descriptor.name)}`)
    if (!descriptor.memberNameProperty || RESERVED_ERROR_MEMBERS.has(descriptor.memberNameProperty) || DUNDER_MEMBER.test(descriptor.memberNameProperty))
      throw new Error(`dsh-code-runtime-python-uv: unusable error member ${JSON.stringify(descriptor.memberNameProperty)}`)
    errors.add(descriptor.name)
  }
  return bindings
}

export class UvPythonCodeRuntime extends CodeRuntime {
  static Config = Config
  readonly language = 'python'
  readonly isolation = 'process'
  private readonly config: Resolved
  private readonly uv: string
  private readonly live = new Set<LiveRun>()
  private disposed = false

  constructor(ctx: Context, config: Config) {
    super(ctx)
    if (process.platform === 'win32') throw new Error('dsh-code-runtime-python-uv: Windows is unsupported because RLIMIT/process-group containment is unavailable')
    this.config = config as Resolved
    for (const key of ['cpuSeconds', 'maxWallMs', 'addressSpaceBytes', 'maxOutputBytes', 'maxFrameBytes'] as const) {
      const value = this.config[key]
      if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`dsh-code-runtime-python-uv: config.${key} must be a positive safe integer`)
    }
    if (this.config.maxWallMs > MAX_TIMER) throw new Error(`dsh-code-runtime-python-uv: config.maxWallMs must be at most ${MAX_TIMER}`)
    if (!existsSync(BOOTSTRAP)) throw new Error(`dsh-code-runtime-python-uv: packaged bootstrap missing at ${BOOTSTRAP}`)
    this.uv = resolveExecutable(this.config.uv)
    ctx.effect(() => () => this.teardown(), 'uv python code-runtime teardown')
  }

  private async teardown(): Promise<void> {
    this.disposed = true
    const runs = [...this.live]
    for (const run of runs) run.settle({ kind: 'abort', message: 'runtime disposed' })
    await Promise.all(runs.map(run => run.finished))
  }

  async run(request: CodeRunRequest): Promise<CodeRunResult> {
    if (this.disposed) throw new Error('dsh-code-runtime-python-uv: run() after disposal')
    const bindings = validateBindings(request)
    if (request.signal?.aborted) return { logs: [], error: { kind: 'abort', message: String(request.signal.reason) } }
    return await this.execute(request, bindings)
  }

  private execute(request: CodeRunRequest, bindings: Map<string, CodeBindingNamespace>): Promise<CodeRunResult> {
    const args = ['run', '--project', PYTHON_PROJECT, '--locked', '--no-dev', '--python', this.config.python, 'python', '-I', '-B', BOOTSTRAP]
    const child = spawn(this.uv, args, {
      env: { UV_NO_CONFIG: '1', UV_PYTHON_DOWNLOADS: 'automatic' },
      stdio: ['ignore', 'pipe', 'pipe', 'pipe'], detached: true,
    })
    const exited = new Promise<void>(done => child.once('exit', () => done()))
    const channel = child.stdio[3] as Duplex
    const boot: BootMessage = {
      type: 'boot', cpuSeconds: this.config.cpuSeconds,
      addressSpaceBytes: this.config.addressSpaceBytes,
      maxLogBytes: this.config.maxOutputBytes, maxValueBytes: this.config.maxOutputBytes,
      namespaces: [...bindings].map(([global, ns]) => ({ global, names: Object.keys(ns.functions), ...(ns.errorClass ? { errorClass: ns.errorClass } : {}) })),
    }
    return new Promise<CodeRunResult>((resolve) => {
      let settled = false, booted = false, buffer = ''
      const logs: string[] = [], answered = new Set<number>()
      let outputBytes = 2 // []
      let finishDone!: () => void
      const finished = new Promise<void>(done => { finishDone = done })
      const kill = (): void => {
        try { process.kill(-child.pid!, 'SIGTERM') } catch { child.kill('SIGTERM') }
        setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL') } catch { child.kill('SIGKILL') } }, 500).unref()
      }
      const finish = (result: CodeRunResult): void => {
        if (settled) return
        settled = true; clearTimeout(wall); request.signal?.removeEventListener('abort', onAbort)
        this.live.delete(live); kill()
        void exited.then(() => { finishDone(); resolve(result) })
      }
      const fail = (kind: CodeRunFailure['kind'], message: string): void => finish({ logs, error: { kind, message } })
      const send = (message: BootMessage | ReplyMessage | { type: 'run'; program: string }): void => {
        if (!settled) channel.write(encodeJsonPlain(message) + '\n')
      }
      const handle = (line: string): void => {
        if (Buffer.byteLength(line) > this.config.maxFrameBytes || hasUnsafeIntegerToken(line)) return fail('worker-exit', 'invalid or oversized Python protocol frame')
        let parsed: unknown
        try { parsed = JSON.parse(line) } catch { return fail('worker-exit', 'malformed Python protocol frame') }
        const message = validateChildFrame(parsed)
        if (!message) return
        if (message.type === 'boot-ack') {
          if (booted) return
          booted = true; send({ type: 'run', program: request.program }); return
        }
        if (!booted) return fail('worker-exit', 'Python child sent traffic before boot acknowledgement')
        if (message.type === 'log') {
          const bytes = Buffer.byteLength(encodeJsonPlain(message.text)) + (logs.length ? 1 : 0)
          if (outputBytes + bytes > this.config.maxOutputBytes) return fail('output-limit', `output exceeds ${this.config.maxOutputBytes} bytes`)
          logs.push(message.text); outputBytes += bytes; return
        }
        if (message.type === 'call') {
          if (answered.has(message.id)) return
          answered.add(message.id)
          const record = bindings.get(message.global)?.functions
          const fn = record && Object.hasOwn(record, message.name) ? record[message.name] : undefined
          if (!fn) return send({ type: 'reply', id: message.id, ok: false, message: `unknown binding ${message.global}.${message.name}` })
          void fn(message.args).then(value => send({ type: 'reply', id: message.id, ok: true, value: cloneJson(value) }), error => send({ type: 'reply', id: message.id, ok: false, message: messageOf(error) })).catch(error => send({ type: 'reply', id: message.id, ok: false, message: messageOf(error) }))
          return
        }
        if (message.type === 'done') {
          if (message.error) return fail(message.error.kind, message.error.message)
          if (message.value === undefined) return finish({ logs })
          const checked = checkDoneValue(message.value, this.config.maxOutputBytes - outputBytes)
          if (!checked.ok) return fail(checked.reason === 'over-budget' ? 'output-limit' : 'invalid-output', 'Python completion is not bounded lossless JSON')
          finish({ logs, value: cloneJson(message.value) })
        }
      }
      channel.on('error', error => { if (!settled) fail('worker-exit', `Python protocol channel error: ${messageOf(error)}`) })
      channel.setEncoding('utf8')
      channel.on('data', (chunk: string) => {
        buffer += chunk
        if (Buffer.byteLength(buffer) > this.config.maxFrameBytes) return fail('worker-exit', 'unterminated Python protocol frame exceeds limit')
        let newline = buffer.indexOf('\n')
        while (newline !== -1 && !settled) { const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1); handle(line); newline = buffer.indexOf('\n') }
      })
      child.stdout?.on('data', (chunk: Buffer) => { if (!settled) fail('worker-exit', `unexpected Python stdout: ${chunk.toString('utf8').slice(0, 200)}`) })
      const substrateStderr: string[] = []
      child.stderr?.on('data', (chunk: Buffer) => { if (!settled) substrateStderr.push(chunk.toString('utf8')) })
      child.on('error', error => fail('worker-exit', messageOf(error)))
      child.on('exit', (code, signal) => {
        if (settled) return
        if (signal === 'SIGXCPU') fail('timeout', `CPU budget exhausted (${this.config.cpuSeconds}s)`)
        else fail('worker-exit', `Python process exited before completion (code ${String(code)}, signal ${String(signal)}): ${substrateStderr.join('').slice(0, 500)}`)
      })
      const wall = setTimeout(() => fail('timeout', `wall-clock ceiling reached (${this.config.maxWallMs}ms)`), this.config.maxWallMs)
      const onAbort = (): void => fail('abort', String(request.signal?.reason))
      request.signal?.addEventListener('abort', onAbort, { once: true })
      const live: LiveRun = { child, finished, settle: error => fail(error.kind, error.message) }
      this.live.add(live)
      send(boot)
    })
  }
}

export default UvPythonCodeRuntime
