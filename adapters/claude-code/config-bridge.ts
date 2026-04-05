import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parse as parseJsonc } from 'jsonc-parser'
import type { OhMyOpenCodeConfig } from '../../src/config/index.js'

export function loadClaudeCodeConfig(): Partial<OhMyOpenCodeConfig> {
  // 1. Load ~/.config/opencode/oh-my-opencode.jsonc as base (user-authored)
  let fileConfig: Partial<OhMyOpenCodeConfig> = {}
  try {
    const configPath = join(homedir(), '.config', 'opencode', 'oh-my-opencode.jsonc')
    const raw = readFileSync(configPath, 'utf8')
    const parsed = parseJsonc(raw)
    if (parsed && typeof parsed === 'object') fileConfig = parsed as Partial<OhMyOpenCodeConfig>
  } catch { /* missing file is fine */ }

  // 2. Build env overlay if LM Studio URL present
  const lowUrl = process.env.OMC_PROVIDER_LOW_URL
  if (!lowUrl) return fileConfig

  const isLmStudio = lowUrl.includes('localhost:1234') || lowUrl.includes('127.0.0.1:1234')
  const providerPrefix = isLmStudio ? 'lmstudio' : 'openai'

  const quickModel = process.env.OMC_CATEGORY_QUICK_MODEL ?? `${providerPrefix}/google/gemma-4-26b-a4b`
  const deepModel  = process.env.OMC_CATEGORY_DEEP_MODEL  ?? 'anthropic/claude-opus-4-6'
  const fallback   = process.env.OMC_CATEGORY_FALLBACK_MODEL ?? 'anthropic/claude-sonnet-4-6'
  const timeout    = parseInt(process.env.OMC_FALLBACK_TIMEOUT_SECONDS ?? '15', 10)

  const envConfig: Partial<OhMyOpenCodeConfig> = {
    categories: {
      quick:             { model: quickModel, fallback_models: [fallback] },
      'unspecified-low': { model: quickModel, fallback_models: [fallback] },
      deep:              { model: deepModel },
      'unspecified-high':{ model: deepModel },
      ultrabrain:        { model: deepModel },
    },
    runtime_fallback: {
      enabled: true,
      timeout_seconds: isNaN(timeout) ? 15 : timeout,
      max_fallback_attempts: 3,
      notify_on_fallback: true,
    },
  }

  return {
    ...fileConfig,
    ...envConfig,
    categories: { ...(fileConfig.categories ?? {}), ...(envConfig.categories ?? {}) },
  }
}

export function getOmoConfigPath(): string {
  return join(homedir(), '.config', 'opencode', 'oh-my-openagent.json')
}
