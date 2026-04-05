import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'

export function loadClaudeCodeConfig(): Record<string, unknown> {
  let fileConfig: Record<string, unknown> = {}

  try {
    const configPath = join(homedir(), '.config', 'opencode', 'oh-my-opencode.jsonc')
    const raw = readFileSync(configPath, 'utf8')
    const parsed = parseJsonc(raw) as unknown
    if (parsed && typeof parsed === 'object') {
      fileConfig = parsed as Record<string, unknown>
    }
  } catch {
    // Missing file is fine — return partial config
  }

  const envOverlay: Record<string, unknown> = {}

  if (process.env.OMC_PROVIDER_LOW_URL) {
    envOverlay['provider_low_url'] = process.env.OMC_PROVIDER_LOW_URL
  }
  if (process.env.OMC_PROVIDER_LOW_KEY) {
    envOverlay['provider_low_key'] = process.env.OMC_PROVIDER_LOW_KEY
  }
  if (process.env.OMC_PROVIDER_LOW_PROTOCOL) {
    envOverlay['provider_low_protocol'] = process.env.OMC_PROVIDER_LOW_PROTOCOL
  }
  if (process.env.OMC_METRICS_ENABLED !== undefined) {
    envOverlay['metrics_enabled'] = process.env.OMC_METRICS_ENABLED === 'true'
  }
  if (process.env.OMC_METRICS_ENDPOINT) {
    envOverlay['metrics_endpoint'] = process.env.OMC_METRICS_ENDPOINT
  }

  return { ...fileConfig, ...envOverlay }
}
