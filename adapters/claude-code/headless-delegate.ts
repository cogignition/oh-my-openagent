// Headless delegate: routes tasks to LM Studio (quick) or Claude via Agent SDK (deep/default).
// LM Studio uses Anthropic-compatible endpoint: POST http://localhost:1234/v1/messages
// Claude tasks use @anthropic-ai/claude-agent-sdk query()

import { recordDelegateCall, recordFallback } from './metrics.js'

export type DelegateOptions = {
  task: string
  category?: string
  directory: string
  timeoutMs?: number
  systemPrompt?: string
}

const QUICK_CATEGORIES = new Set(['quick', 'unspecified-low'])
const DEEP_CATEGORIES  = new Set(['deep', 'ultrabrain', 'unspecified-high'])

function getLmStudioBaseUrl(): string {
  const url = process.env.OMO_PROVIDER_LOW_URL ?? 'http://localhost:1234/v1/chat/completions'
  // Normalize: strip /chat/completions or /messages suffix to get base
  return url.replace(/\/(chat\/completions|messages)\/?$/, '')
}

function getLmStudioModel(): string {
  const full = process.env.OMO_CATEGORY_QUICK_MODEL ?? 'lmstudio/google/gemma-4-26b-a4b'
  // Strip provider prefix: "lmstudio/deepseek-..." → "deepseek-..."
  return full.includes('/') ? full.split('/').slice(1).join('/') : full
}

async function callLmStudio(opts: DelegateOptions): Promise<string> {
  const baseUrl = getLmStudioBaseUrl()
  const model   = getLmStudioModel()
  const apiKey  = process.env.OMO_PROVIDER_LOW_KEY ?? 'lmstudio'
  const timeout = opts.timeoutMs ?? 30_000

  const body: Record<string, unknown> = {
    model,
    messages: [{ role: 'user', content: opts.task }],
    max_tokens: 4096,
  }
  if (opts.systemPrompt) body.system = opts.systemPrompt

  const res = await fetch(`${baseUrl}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`LM Studio ${res.status}: ${text}`)
  }

  const data = await res.json() as {
    content?: Array<{ type: string; text?: string }>
    choices?: Array<{ message?: { content?: string } }>
  }

  // Anthropic-compat format
  if (Array.isArray(data.content)) {
    return data.content.filter(b => b.type === 'text' && b.text).map(b => b.text!).join('')
  }
  // OpenAI-compat fallback
  if (Array.isArray(data.choices)) {
    return data.choices[0]?.message?.content ?? ''
  }
  return ''
}

async function callClaudeAgent(opts: DelegateOptions & { model?: string }): Promise<string> {
  const { query } = await import('@anthropic-ai/claude-agent-sdk')
  const model = opts.model
    ?? (DEEP_CATEGORIES.has(opts.category ?? '') ? 'claude-opus-4-6' : 'claude-sonnet-4-6')

  const chunks: string[] = []
  for await (const msg of query({
    prompt: opts.task,
    options: {
      cwd: opts.directory,
      maxTurns: 1,
      allowedTools: [],
      model,
    } as Parameters<typeof query>[0]['options'],
  })) {
    if (msg && typeof msg === 'object' && 'result' in msg && typeof msg.result === 'string') {
      chunks.push(msg.result)
    }
  }
  return chunks.join('')
}

export async function runHeadlessDelegate(opts: DelegateOptions): Promise<string> {
  const category = opts.category ?? 'quick'
  const start = Date.now()

  if (QUICK_CATEGORIES.has(category)) {
    const model = getLmStudioModel()
    try {
      const result = await callLmStudio(opts)
      recordDelegateCall({ category, model, status: 'success', latencyMs: Date.now() - start })
      return result
    } catch (err) {
      const isOffline = err instanceof Error &&
        (err.message.includes('ECONNREFUSED') ||
         err.message.includes('fetch failed') ||
         err.message.includes('Unable to connect') ||
         (err as NodeJS.ErrnoException).code === 'ConnectionRefused' ||
         err.name === 'TimeoutError' ||
         err.message.includes('timed out'))

      if (isOffline) {
        process.stderr.write(`[headless-delegate] LM Studio offline, falling back to Haiku: ${err}\n`)
        recordFallback(category, 'offline')
        const fallbackModel = 'claude-haiku-4-5-20251001'
        const result = await callClaudeAgent({ ...opts, model: fallbackModel })
        recordDelegateCall({ category, model: fallbackModel, status: 'fallback', latencyMs: Date.now() - start })
        return result
      }
      recordDelegateCall({ category, model, status: 'error', latencyMs: Date.now() - start })
      throw err
    }
  }

  const deepModel = DEEP_CATEGORIES.has(category) ? 'claude-opus-4-6' : 'claude-sonnet-4-6'
  const result = await callClaudeAgent(opts)
  recordDelegateCall({ category, model: deepModel, status: 'success', latencyMs: Date.now() - start })
  return result
}
