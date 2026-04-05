// Build script for the Claude Code adapter.
// The omo codebase is Bun-native (imports from "bun"), so we skip bundling and
// run hook-bridge.ts directly via `bun` at hook invocation time.
// This script only generates the two manifest files needed by Claude Code.

import { join, dirname } from 'node:path'
import { mkdirSync, writeFileSync } from 'node:fs'

const root = join(import.meta.dir, '../..')
const bunBin = process.execPath // absolute path to the running bun binary
const bridgeEntry = join(root, 'adapters/claude-code/hook-bridge.ts')

// 1. Generate hooks/hooks.json
mkdirSync(join(root, 'hooks'), { recursive: true })
const hookEvents = [
  'SessionStart',
  'UserPromptSubmit',
  'PreToolUse',
  'PostToolUse',
  'PostToolUseFailure',
  'PreCompact',
  'SubagentStart',
  'SubagentStop',
  'Stop',
  'SessionEnd',
  'PermissionRequest',
]
const hooksJson: Record<string, unknown[]> = {}
for (const event of hookEvents) {
  hooksJson[event] = [{ type: 'command', command: `"${bunBin}" "${bridgeEntry}"` }]
}
writeFileSync(join(root, 'hooks/hooks.json'), JSON.stringify({ hooks: hooksJson }, null, 2))
console.log('Written hooks/hooks.json')

// 3. Write omo config (LM Studio routing + runtime_fallback)
const { loadClaudeCodeConfig, getOmoConfigPath } = await import('./config-bridge.ts')
const omoConfigPath = getOmoConfigPath()
mkdirSync(dirname(omoConfigPath), { recursive: true })
writeFileSync(omoConfigPath, JSON.stringify(loadClaudeCodeConfig(), null, 2))
console.log('Written', omoConfigPath)

// 4. Render omo agents → ~/.claude/agents/omo-*.md
const { renderOmoAgents } = await import('./agent-renderer.ts')
const cfg = loadClaudeCodeConfig()
const quickModel = (cfg.categories?.quick as { model?: string } | undefined)?.model ?? 'lmstudio/google/gemma-4-26b-a4b'
const deepModel  = (cfg.categories?.deep  as { model?: string } | undefined)?.model ?? 'anthropic/claude-opus-4-6'
await renderOmoAgents({ quickModel, deepModel, directory: root })
console.log('Rendered omo agents → ~/.claude/agents/omo-*.md')

// 5. Generate .claude-plugin/plugin.json
mkdirSync(join(root, '.claude-plugin'), { recursive: true })
const pkg = await import('../../package.json')
writeFileSync(join(root, '.claude-plugin/plugin.json'), JSON.stringify({
  name: 'oh-my-openagent',
  version: pkg.version ?? '3.15.1',
  description: 'oh-my-openagent Claude Code adapter',
  entry: bridgeEntry,
  runtime: bunBin,
}, null, 2))
console.log('Written .claude-plugin/plugin.json')
console.log('Done. Hooks will invoke: ' + bunBin + ' ' + bridgeEntry)
