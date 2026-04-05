import OhMyOpenCodePlugin from '../../src/index.js'
import { createContextShim } from './context-shim.js'

type PluginInstance = Awaited<ReturnType<typeof OhMyOpenCodePlugin>>

const cache = new Map<string, PluginInstance>()

export async function getPlugin(directory: string): Promise<PluginInstance> {
  if (cache.has(directory)) return cache.get(directory)!
  const ctx = createContextShim(directory)
  const plugin = await OhMyOpenCodePlugin(ctx)
  cache.set(directory, plugin)
  return plugin
}
