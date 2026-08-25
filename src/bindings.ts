/**
 * wrapBindings: give any Code Mode binding table resolve-first semantics.
 *
 * The dsh code-runtime exposes host functions to the executed program as an
 * object of async callables (the `tools` global). Wrapping that table makes
 * every call ask the spec-ptc daemon first: a hit returns the speculative
 * result instantly (the call already ran while the model was still writing
 * the code); a miss runs the original function unchanged.
 *
 * Adoption is one line wherever bindings are constructed:
 *
 *   const tools = wrapBindings(originalBindings, (name, args) => specPtc.resolve(name, args))
 *
 * Fail-open by construction: any resolver error falls through to the
 * original function, so a sick daemon can never break execution.
 *
 * @module @morewax/dsh-spec-ptc/bindings
 */

/** One host-side callable exposed to the executed program. */
export type HostFunction = (...args: unknown[]) => Promise<unknown>

/** A table of host functions, keyed by the exact name the program calls. */
export type Bindings = Record<string, HostFunction>

/** Resolve hook: hit → the claimed result; miss → run the tool. */
export type ResolveHook = (name: string, args: unknown[]) => Promise<
  | { hit: true; result: unknown }
  | { hit: false }
>

/**
 * Wrap one binding table with resolve-first semantics.
 *
 * @param bindings - the original host-function table (not mutated).
 * @param resolve - asks the daemon for a speculative result.
 * @returns a new table with identical keys and fail-open resolve-first calls.
 */
export function wrapBindings(bindings: Bindings, resolve: ResolveHook): Bindings {
  const wrapped: Bindings = {}
  for (const [name, fn] of Object.entries(bindings)) {
    wrapped[name] = async (...args: unknown[]): Promise<unknown> => {
      try {
        const outcome = await resolve(name, args)
        if (outcome.hit) return outcome.result
      } catch {
        // Daemon unreachable, protocol error, anything: fall through and run
        // the original — speculation is an accelerator, never a dependency.
      }
      return fn(...args)
    }
  }
  return wrapped
}
