// Headless delegate: routes all tasks through @anthropic-ai/claude-agent-sdk.
// Quick tasks point the SDK at LM Studio via ANTHROPIC_BASE_URL override (gemma4 + tools).
// Deep tasks use the default Anthropic endpoint (Claude Opus + tools).

import { recordDelegateCall, recordFallback } from './metrics.js'

export type DelegateOptions = {
  task: string
  category?: string
  directory: string
  timeoutMs?: number
  systemPrompt?: string
  /** Agent name (e.g. 'omo-sisyphus-junior') — uses its focused system prompt instead of full Claude Code context */
  agent?: string
}

const QUICK_CATEGORIES = new Set(['quick', 'unspecified-low'])
const DEEP_CATEGORIES  = new Set(['deep', 'ultrabrain', 'unspecified-high'])

function getLmStudioBaseUrl(): string {
  const url = process.env.OMO_PROVIDER_LOW_URL ?? 'http://localhost:1234/v1/messages'
  // Anthropic SDK appends /v1 itself — return just protocol+host
  const { protocol, host } = new URL(url)
  return `${protocol}//${host}`
}

function getLmStudioModel(): string {
  const full = process.env.OMO_CATEGORY_QUICK_MODEL ?? 'lmstudio/google/gemma-4-26b-a4b'
  // Strip provider prefix: 'lmstudio/google/gemma-4-26b-a4b' → 'google/gemma-4-26b-a4b'
  const knownPrefixes = ['lmstudio', 'anthropic', 'openai', 'ollama', 'mistral']
  const parts = full.split('/')
  if (knownPrefixes.includes(parts[0])) return parts.slice(1).join('/')
  return full
}

async function callAgent(opts: DelegateOptions & {
  model: string
  baseUrl?: string
  apiKey?: string
}): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  // Temporarily override env so the SDK client picks up LM Studio URL
  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
  const prevApiKey  = process.env.ANTHROPIC_API_KEY
  if (opts.baseUrl) process.env.ANTHROPIC_BASE_URL = opts.baseUrl
  if (opts.apiKey)  process.env.ANTHROPIC_API_KEY  = opts.apiKey

  try {
    const chunks: string[] = []
    for await (const msg of query({
      prompt: opts.task,
      options: {
        cwd: opts.directory,
        model: opts.model,
        maxTurns: 10,
        ...(opts.agent       ? { agent: opts.agent }             : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      } as Parameters<typeof query>[0]['options'],
    })) {
      if (msg && typeof msg === 'object' && 'result' in msg && typeof msg.result === 'string') {
        chunks.push(msg.result)
      }
    }
    return chunks.join('')
  } finally {
    // Restore previous env state
    if (opts.baseUrl) {
      if (prevBaseUrl === undefined) delete process.env.ANTHROPIC_BASE_URL
      else process.env.ANTHROPIC_BASE_URL = prevBaseUrl
    }
    if (opts.apiKey) {
      if (prevApiKey === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prevApiKey
    }
  }
}

function isOfflineError(err: unknown): boolean {
  if (!(err instanceof Error)) return false
  return (
    err.message.includes('ECONNREFUSED') ||
    err.message.includes('fetch failed') ||
    err.message.includes('Unable to connect') ||
    err.message.includes('timed out') ||
    (err as NodeJS.ErrnoException).code === 'ConnectionRefused' ||
    err.name === 'TimeoutError'
  )
}

export async function runHeadlessDelegate(opts: DelegateOptions): Promise<string> {
  const category = opts.category ?? 'quick'
  const start = Date.now()

  if (QUICK_CATEGORIES.has(category)) {
    const model   = getLmStudioModel()
    const baseUrl = getLmStudioBaseUrl()
    const apiKey  = process.env.OMO_PROVIDER_LOW_KEY ?? 'lmstudio'
    // Optional: set OMO_QUICK_AGENT=omo-explore (or any omo-* agent) to use that agent's
    // focused system prompt and avoid sending the full ~46k Claude Code context to LM Studio.
    const agent = process.env.OMO_QUICK_AGENT || undefined
    try {
      const result = await callAgent({ ...opts, model, baseUrl, apiKey, agent })
      recordDelegateCall({ category, model, status: 'success', latencyMs: Date.now() - start })
      return result
    } catch (err) {
      if (isOfflineError(err)) {
        process.stderr.write(`[headless-delegate] LM Studio offline, falling back to Haiku: ${err}\n`)
        recordFallback(category, 'offline')
        const fallbackModel = 'claude-haiku-4-5-20251001'
        const result = await callAgent({ ...opts, model: fallbackModel })
        recordDelegateCall({ category, model: fallbackModel, status: 'fallback', latencyMs: Date.now() - start })
        return result
      }
      recordDelegateCall({ category, model, status: 'error', latencyMs: Date.now() - start })
      throw err
    }
  }

  const deepModel = DEEP_CATEGORIES.has(category) ? 'claude-opus-4-6' : 'claude-sonnet-4-6'
  const result = await callAgent({ ...opts, model: deepModel })
  recordDelegateCall({ category, model: deepModel, status: 'success', latencyMs: Date.now() - start })
  return result
}
