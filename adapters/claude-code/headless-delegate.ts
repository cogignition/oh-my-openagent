// Headless delegate: routes all tasks through @anthropic-ai/claude-agent-sdk.
//
// Quick tasks route through the omo proxy (localhost:OMO_PROXY_PORT).
// The proxy handles provider selection by model prefix:
//   "lmstudio/qwen/..." → LM Studio (passthrough, proto=anthropic)
//   "gpt-4o-mini"       → OpenAI (translated, proto=openai)
//   "gemini-2.0-flash"  → Gemini (translated, proto=openai)
//
// Deep tasks use the default Anthropic endpoint (Claude Opus + tools).
//
// Env vars:
//   OMO_PROXY_PORT=4315              — proxy port (default 4315)
//   OMO_CATEGORY_QUICK_MODEL=...     — model for quick tasks (with provider prefix)
//   OMO_QUICK_AGENT=omo-explore      — optional: use agent's focused system prompt
//   OMO_CATEGORY_DEEP_MODEL=...      — model for deep tasks (default: claude-opus-4-6)

import { recordDelegateCall, recordFallback } from './metrics.js'

export type DelegateOptions = {
  task: string
  category?: string
  directory: string
  timeoutMs?: number
  systemPrompt?: string
  /** Agent name (e.g. 'omo-explore') — uses its focused system prompt instead of full Claude Code context */
  agent?: string
}

const QUICK_CATEGORIES = new Set(['quick', 'unspecified-low'])
const DEEP_CATEGORIES  = new Set(['deep', 'ultrabrain', 'unspecified-high'])

function getProxyBaseUrl(): string {
  return `http://localhost:${process.env.OMO_PROXY_PORT ?? '4315'}`
}

function getQuickModel(): string {
  return process.env.OMO_CATEGORY_QUICK_MODEL ?? 'lmstudio/qwen/qwen3.5-35b-a3b'
}

function getDeepModel(): string {
  return process.env.OMO_CATEGORY_DEEP_MODEL ?? 'claude-opus-4-6'
}

async function callAgent(opts: DelegateOptions & {
  model: string
  baseUrl?: string
  apiKey?: string
}): Promise<{ result: string; inputTokens: number; outputTokens: number }> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')

  const prevBaseUrl = process.env.ANTHROPIC_BASE_URL
  const prevApiKey  = process.env.ANTHROPIC_API_KEY
  if (opts.baseUrl) process.env.ANTHROPIC_BASE_URL = opts.baseUrl
  if (opts.apiKey)  process.env.ANTHROPIC_API_KEY  = opts.apiKey

  try {
    const chunks: string[] = []
    let inputTokens = 0
    let outputTokens = 0
    for await (const msg of query({
      prompt: opts.task,
      options: {
        cwd: opts.directory,
        model: opts.model,
        maxTurns: 10,
        // Auto-allow read-only tools — no more than what the spawning session has,
        // but avoids blocking on approval prompts in a headless context.
        // Write/Edit/Bash are intentionally excluded for quick delegates.
        allowedTools: ['Read', 'Glob', 'Grep', 'LS'],
        ...(opts.agent        ? { agent: opts.agent }              : {}),
        ...(opts.systemPrompt ? { systemPrompt: opts.systemPrompt } : {}),
      } as Parameters<typeof query>[0]['options'],
    })) {
      if (msg && typeof msg === 'object') {
        if ('result' in msg && typeof msg.result === 'string') chunks.push(msg.result)
        if ('usage' in msg && msg.usage && typeof msg.usage === 'object') {
          const u = msg.usage as Record<string, unknown>
          if (typeof u['input_tokens']  === 'number') inputTokens  = u['input_tokens']
          if (typeof u['output_tokens'] === 'number') outputTokens = u['output_tokens']
        }
      }
    }
    return { result: chunks.join(''), inputTokens, outputTokens }
  } finally {
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
  const start    = Date.now()

  if (QUICK_CATEGORIES.has(category)) {
    const model  = getQuickModel()
    const agent  = process.env.OMO_QUICK_AGENT || undefined
    // Quick path always routes through the omo proxy — it resolves the provider by model prefix
    const baseUrl = getProxyBaseUrl()
    const apiKey  = 'omo-proxy'  // proxy handles real auth; SDK just needs a non-empty value
    try {
      const { result, inputTokens, outputTokens } = await callAgent({ ...opts, model, baseUrl, apiKey, agent })
      recordDelegateCall({ category, model, status: 'success', latencyMs: Date.now() - start, inputTokens, outputTokens })
      return result
    } catch (err) {
      if (isOfflineError(err)) {
        process.stderr.write(`[headless-delegate] proxy offline, falling back to Haiku: ${err}\n`)
        recordFallback(category, 'offline')
        const fallbackModel = 'claude-haiku-4-5-20251001'
        const { result, inputTokens, outputTokens } = await callAgent({ ...opts, model: fallbackModel })
        recordDelegateCall({ category, model: fallbackModel, status: 'fallback', latencyMs: Date.now() - start, inputTokens, outputTokens })
        return result
      }
      recordDelegateCall({ category, model, status: 'error', latencyMs: Date.now() - start })
      throw err
    }
  }

  const deepModel = DEEP_CATEGORIES.has(category) ? getDeepModel() : 'claude-sonnet-4-6'
  const { result, inputTokens, outputTokens } = await callAgent({ ...opts, model: deepModel })
  recordDelegateCall({ category, model: deepModel, status: 'success', latencyMs: Date.now() - start, inputTokens, outputTokens })
  return result
}
