/**
 * Registry-level resolve-first wrapping: every tool registered AFTER this
 * plugin loads gets an execute that asks the spec-ptc daemon first. One wrap
 * covers every dispatch path — direct model tool calls AND Code Mode nested
 * dispatches — with zero upstream changes.
 *
 * Load-order contract: this plugin must load BEFORE tool-providing plugins
 * (their registrations are what gets wrapped). Put its row first in
 * cordis.patch.yml. Disposal restores the original register.
 *
 * @module
 */

/** Structural slices of the harness ToolRuntime (work with the real one or a double). */
export interface WrappedDefinition {
  execute(args: unknown, exec: unknown): Promise<unknown>
  [key: string]: unknown
}

export interface WrappableToolRuntime {
  register(def: WrappedDefinition): () => void
}

export type ResolveFn = (tool: string, args: unknown[]) => Promise<{ hit: true; result: unknown } | { hit: false }>

export interface WrapHandle {
  /** Restore the untouched register (called on plugin disposal). */
  restore(): void
}

/**
 * Wrap `runtime.register` so subsequently-registered definitions execute
 * resolve-first. Only tools in `speculatable` are eligible — a speculative
 * cache can only ever serve pure tools; everything else runs untouched.
 *
 * The original definition object is never mutated; the wrap is a shallow
 * copy with a new execute, preserving output/finalizeContent behavior
 * (a hit simply leaves execution-local projections unset, which the
 * finalization contract already treats as "no rich projection").
 */
export function wrapRegister(
  runtime: WrappableToolRuntime,
  resolve: ResolveFn,
  speculatable: ReadonlySet<string>,
  toolNameOf: (def: WrappedDefinition) => string,
): WrapHandle {
  const original = runtime.register.bind(runtime)
  runtime.register = (def: WrappedDefinition): (() => void) => {
    const toolName = toolNameOf(def)
    if (!speculatable.has(toolName)) return original(def)
    const wrapped: WrappedDefinition = {
      ...def,
      async execute(args: unknown, exec: unknown): Promise<unknown> {
        try {
          const argList = Array.isArray(args) ? args : [args]
          const outcome = await resolve(toolName, argList)
          if (outcome.hit) return outcome.result
        } catch {
          // fail-open: any resolver trouble runs the tool normally
        }
        return def.execute(args, exec)
      },
    }
    return original(wrapped)
  }
  return {
    restore() {
      runtime.register = original
    },
  }
}
