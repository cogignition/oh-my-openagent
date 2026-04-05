import type { PluginContext } from '../../src/plugin/types.js'

function makeNoop(): unknown {
  const proxy: unknown = new Proxy(() => Promise.resolve({ data: null }), {
    get: (_target, _prop) => proxy,
    apply: (_target, _thisArg, _args) => Promise.resolve({ data: null }),
  })
  return proxy
}

export function createContextShim(directory: string): PluginContext {
  const shim = {
    directory,
    worktree: directory,
    serverUrl: new URL('http://localhost:3000'),
    project: makeNoop(),
    $: makeNoop(),
    client: new Proxy({} as object, {
      get(_target, prop) {
        if (prop === 'provider') {
          return {
            list: async () => ({ data: [] }),
          }
        }
        if (prop === 'session') {
          return {
            message: async () => ({ data: null }),
          }
        }
        if (prop === 'tui') {
          return {
            showToast: async (args: unknown) => {
              process.stderr.write(`[context-shim] toast: ${JSON.stringify(args)}\n`)
              return { data: null }
            },
          }
        }
        return makeNoop()
      },
    }),
  }

  return shim as unknown as PluginContext
}
