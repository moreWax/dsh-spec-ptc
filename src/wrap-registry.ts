/**
 * Registry lookup-level resolve-first wrapping.
 *
 * dsh profile bundles are composed before the loader applies them, but the
 * base bundle may register tools before a later third-party bundle activates.
 * Wrapping `register()` therefore misses existing definitions. Wrapping the
 * public `get()` lookup covers existing AND future definitions and every
 * downstream dispatch path, including built-in Code Mode nested dispatches.
 *
 * @module
 */

export interface WrappedDefinition {
  execute(args: unknown, exec: unknown): Promise<unknown>
  [key: string]: unknown
}

export interface WrappableToolRuntime {
  get(name: string, scope?: unknown): WrappedDefinition | undefined
}

export type ResolveFn = (tool: string, args: unknown[]) => Promise<{ hit: true; result: unknown } | { hit: false }>

export interface WrapHandle { restore(): void }

/**
 * Wrap the registry's definition lookup resolve-first for allowlisted pure
 * tools. The returned wrapper definition is memoized by original definition
 * identity, preserving stable lookup identity until a scope or HMR update
 * supplies a new definition. Resolver trouble always falls through.
 */
export function wrapLookup(
  runtime: WrappableToolRuntime,
  resolve: ResolveFn,
  speculatable: ReadonlySet<string>,
): WrapHandle {
  const originalGet = runtime.get.bind(runtime)
  const wrapped = new WeakMap<WrappedDefinition, WrappedDefinition>()
  runtime.get = (name: string, scope?: unknown): WrappedDefinition | undefined => {
    const definition = originalGet(name, scope)
    if (definition === undefined || !speculatable.has(name)) return definition
    const cached = wrapped.get(definition)
    if (cached !== undefined) return cached
    const projected: WrappedDefinition = {
      ...definition,
      async execute(args: unknown, exec: unknown): Promise<unknown> {
        try {
          const outcome = await resolve(name, Array.isArray(args) ? args : [args])
          if (outcome.hit) return outcome.result
        } catch {
          // fail-open: the original tool remains authoritative
        }
        return definition.execute(args, exec)
      },
    }
    wrapped.set(definition, projected)
    return projected
  }
  return { restore() { runtime.get = originalGet } }
}
