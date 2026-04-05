import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import OhMyOpenCodePlugin from '../../src/index.js'
import { createContextShim } from './context-shim.js'
import { loadClaudeCodeConfig, getOmoConfigPath, getOmoConfigSyncPath } from './config-bridge.js'

type PluginInstance = Awaited<ReturnType<typeof OhMyOpenCodePlugin>>

const cache = new Map<string, PluginInstance>()

function writeOmoConfig(): void {
  try {
    const cfg = JSON.stringify(loadClaudeCodeConfig(), null, 2)
    const canonical = getOmoConfigPath()
    mkdirSync(dirname(canonical), { recursive: true })
    writeFileSync(canonical, cfg)
    // Sync copy so omo's loadPluginConfig() (which reads opencode config dir) still picks it up
    const syncPath = getOmoConfigSyncPath()
    mkdirSync(dirname(syncPath), { recursive: true })
    writeFileSync(syncPath, cfg)
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
