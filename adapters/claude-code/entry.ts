import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import OhMyOpenCodePlugin from '../../src/index.js'
import { createContextShim } from './context-shim.js'
import { loadClaudeCodeConfig, getOmoConfigPath } from './config-bridge.js'

type PluginInstance = Awaited<ReturnType<typeof OhMyOpenCodePlugin>>

const cache = new Map<string, PluginInstance>()

function writeOmoConfig(): void {
  try {
    const cfg = JSON.stringify(loadClaudeCodeConfig(), null, 2)
    const p = getOmoConfigPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, cfg)
  } catch (err) {
    process.stderr.write(`[entry] config write failed: ${err}\n`)
  }
}

export async function getPlugin(directory: string): Promise<PluginInstance> {
  if (cache.has(directory)) return cache.get(directory)!
  writeOmoConfig()
  const ctx = createContextShim(directory)
  const plugin = await OhMyOpenCodePlugin(ctx)
  cache.set(directory, plugin)
  return plugin
}
