import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import OhMyOpenCodePlugin from '../../src/index.js'
import { createContextShim } from './context-shim.js'
import { loadClaudeCodeConfig, getOmoConfigPath } from './config-bridge.js'
import { renderOmoAgents } from './agent-renderer.js'

type PluginInstance = Awaited<ReturnType<typeof OhMyOpenCodePlugin>>

const cache = new Map<string, PluginInstance>()

function writeOmoConfig(): void {
  try {
    const cfg = loadClaudeCodeConfig()
    const p = getOmoConfigPath()
    mkdirSync(dirname(p), { recursive: true })
    writeFileSync(p, JSON.stringify(cfg, null, 2))

    // Render omo agents into ~/.claude/agents/ on every init so they stay current
    const quickModel = (cfg.categories?.quick as { model?: string } | undefined)?.model ?? 'lmstudio/google/gemma-4-26b-a4b'
    const deepModel  = (cfg.categories?.deep  as { model?: string } | undefined)?.model ?? 'anthropic/claude-opus-4-6'
    renderOmoAgents({ quickModel, deepModel }).catch(err => {
      process.stderr.write(`[entry] agent render failed: ${err}\n`)
    })
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
