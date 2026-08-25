/**
 * Daemon lifecycle: prove the spec-ptc daemon is reachable, spawning it when
 * configured. Fail-open throughout — an unavailable daemon degrades the
 * plugin to a no-op, never to a broken harness.
 *
 * @module
 */
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { scrubbedParentEnv } from '@deepseek-ai/dsh-subprocess'
import { SpecClient } from './client.js'

export interface DaemonConfig {
  /** Unix socket the daemon listens on (default /tmp/spec-ptc.sock). */
  socketPath: string
  /** Spawn the daemon when the socket is absent (default true). */
  autoStart: boolean
  /** Daemon executable; must be on PATH after `pip install spec-ptc` (default spec-ptc-daemon). */
  command: string
  /** Extra args passed to the daemon command. */
  args: string[]
  /** How long to wait for a spawned daemon's socket to appear (default 8000). */
  startTimeoutMs: number
  /**
   * Which engine the daemon speculates with:
   *  - 'stock': the upstream daemon's built-in engine (sub-LLM calls only).
   *  - 'dsh': our engine shim — dsh harness tools executed via loopback callback.
   */
  engine?: 'stock' | 'dsh' | undefined
  /** Python interpreter for the shim (engine 'dsh'; default python3). */
  pythonBin?: string | undefined
  /** Absolute path to the dsh_spec_engine.py shim (engine 'dsh'). */
  shimPath?: string | undefined
  /** Loopback base URL the shim calls back to (engine 'dsh'). */
  callbackUrl?: string | undefined
  /** Bearer token for the callback endpoint; passed to the child via env ONLY. */
  callbackToken?: string | undefined
}

export interface DaemonHandle {
  client: SpecClient
  /** True when this handle spawned the daemon (and therefore kills it on dispose). */
  spawned: boolean
  dispose(): Promise<void>
}

export const DEFAULT_DAEMON_CONFIG: DaemonConfig = Object.freeze({
  socketPath: '/tmp/spec-ptc.sock',
  autoStart: true,
  command: 'spec-ptc-daemon',
  args: [],
  startTimeoutMs: 8000,
})

interface Logger { info(msg: string): void; warn(msg: string): void }

function waitForSocket(socketPath: string, timeoutMs: number): Promise<boolean> {
  const started = Date.now()
  return new Promise((resolvePromise) => {
    const poll = (): void => {
      if (existsSync(socketPath)) return resolvePromise(true)
      if (Date.now() - started >= timeoutMs) return resolvePromise(false)
      setTimeout(poll, 100).unref()
    }
    poll()
  })
}

/**
 * Connect to a healthy daemon, spawning one if needed and allowed.
 *
 * @returns a live handle, or `undefined` when the daemon cannot be reached —
 *   callers treat that as "speculation unavailable, run everything normally".
 */
export async function ensureDaemon(
  config: DaemonConfig,
  logger: Logger,
): Promise<DaemonHandle | undefined> {
  let spawned: ChildProcess | undefined
  if (!existsSync(config.socketPath)) {
    if (!config.autoStart) {
      logger.warn(`spec-ptc: no daemon socket at ${config.socketPath} and autoStart is off — speculation disabled`)
      return undefined
    }
    const isDsh = config.engine === 'dsh' && config.shimPath !== undefined && config.callbackUrl !== undefined
    const spawnCommand = isDsh ? (config.pythonBin ?? 'python3') : config.command
    const spawnArgs = isDsh
      ? [config.shimPath as string, '--socket', config.socketPath, '--callback', config.callbackUrl as string, ...config.args]
      : config.args
    const childEnv: Record<string, string> = { ...scrubbedParentEnv() } as Record<string, string>
    if (isDsh && config.callbackToken !== undefined) {
      // The callback credential travels by env only — never argv (visible in
      // ps), never config files, never logs.
      childEnv.DSH_SPEC_CALLBACK_TOKEN = config.callbackToken
    }
    spawned = spawn(spawnCommand, spawnArgs, {
      env: childEnv as NodeJS.ProcessEnv,
      stdio: 'ignore',
      detached: false,
    })
    spawned.on('error', () => { /* surfaced by the socket wait below */ })
    if (!await waitForSocket(config.socketPath, config.startTimeoutMs)) {
      spawned.kill()
      logger.warn(
        `spec-ptc: daemon did not create ${config.socketPath} within ${config.startTimeoutMs}ms ` +
        `(is the upstream package installed? pip install spec-ptc) — speculation disabled`,
      )
      return undefined
    }
    logger.info(`spec-ptc: daemon spawned (${config.command}), socket at ${config.socketPath}`)
  }
  try {
    const client = await SpecClient.connect(config.socketPath)
    return {
      client,
      spawned: spawned !== undefined,
      async dispose() {
        client.close()
        if (spawned !== undefined && !spawned.killed) {
          spawned.kill()
          await new Promise<void>((resolvePromise) => {
            spawned?.once('exit', () => { resolvePromise() })
            setTimeout(resolvePromise, 2000).unref()
          })
        }
      },
    }
  } catch (error) {
    if (spawned !== undefined && !spawned.killed) spawned.kill()
    logger.warn(`spec-ptc: cannot reach daemon at ${config.socketPath}: ${String(error)} — speculation disabled`)
    return undefined
  }
}
