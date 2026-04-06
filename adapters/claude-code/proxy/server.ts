/// <reference types="bun-types" />

// server.ts — Anthropic→OpenAI proxy server (Bun native).
//
// Provider entries are configured via env vars:
//   OMO_PROXY_{NAME}_TARGET_URL   — upstream endpoint (required to activate entry)
//   OMO_PROXY_{NAME}_API_KEY      — upstream API key
//   OMO_PROXY_{NAME}_PROTO        — "openai" (default) or "anthropic" (passthrough)
//   OMO_PROXY_{NAME}_PREFIXES     — comma-separated model prefixes (overrides built-in)
//
// Example entries: LMSTUDIO, OPENAI, GEMINI, TOGETHER, GROQ, FIREWORKS
//
// Routing:
//   OMO_PROXY_DEFAULT=lmstudio    — fallback provider when no prefix matches
//   OMO_PROXY_PORT=4315           — listen port
//
// The provider prefix is stripped from the model before forwarding:
//   "lmstudio/qwen/qwen3.5-35b-a3b" → upstream sees "qwen/qwen3.5-35b-a3b"

import { writeFileSync } from 'fs'
import { translateRequest, translateResponse, StreamTranslator, formatSSE } from './translate.js'
import type { AnthropicRequest, OpenAIDelta } from './translate.js'

// ---------------------------------------------------------------------------
// Metrics — emit token counts directly from the proxy (the Claude Agent SDK
// returns zero tokens for non-Anthropic models; the proxy sees the real usage).
// ---------------------------------------------------------------------------

const METRICS_ENABLED = process.env.OMO_METRICS_ENABLED === 'true'
const METRICS_ENDPOINT = (process.env.OMO_METRICS_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '')

async function emitTokenMetrics(opts: {
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
}): Promise<void> {
  if (!METRICS_ENABLED || (!opts.inputTokens && !opts.outputTokens)) return
  try {
    const nowNs = String(BigInt(Date.now()) * 1_000_000n)
    const payload = {
      resourceMetrics: [{
        resource: { attributes: [
          { key: 'service.name', value: { stringValue: 'oh-my-openagent' } },
          { key: 'adapter',      value: { stringValue: 'claude-code' } },
          { key: 'component',    value: { stringValue: 'proxy' } },
        ]},
        scopeMetrics: [{
          scope: { name: 'omo-proxy' },
          metrics: [{
            name: 'omo_proxy_tokens_total',
            description: 'Tokens processed by the omo proxy (source of truth for non-Anthropic models)',
            sum: {
              dataPoints: [
                ...(opts.inputTokens ? [{
                  attributes: [
                    { key: 'direction', value: { stringValue: 'input' } },
                    { key: 'provider',  value: { stringValue: opts.provider } },
                    { key: 'model',     value: { stringValue: opts.model } },
                  ],
                  startTimeUnixNano: nowNs,
                  timeUnixNano: nowNs,
                  asInt: String(opts.inputTokens),
                }] : []),
                ...(opts.outputTokens ? [{
                  attributes: [
                    { key: 'direction', value: { stringValue: 'output' } },
                    { key: 'provider',  value: { stringValue: opts.provider } },
                    { key: 'model',     value: { stringValue: opts.model } },
                  ],
                  startTimeUnixNano: nowNs,
                  timeUnixNano: nowNs,
                  asInt: String(opts.outputTokens),
                }] : []),
              ],
              aggregationTemporality: 1,  // DELTA
              isMonotonic: true,
            },
          }],
        }],
      }],
    }
    await fetch(`${METRICS_ENDPOINT}/v1/metrics`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(3000),
    })
  } catch { /* best-effort, never block a response */ }
}

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const PORT = parseInt(process.env.OMO_PROXY_PORT ?? '4315', 10)
const DEFAULT_PROVIDER = (process.env.OMO_PROXY_DEFAULT ?? 'openai').toLowerCase()

interface ProxyEntry {
  name: string
  targetUrl: string
  apiKey: string
  proto: 'anthropic' | 'openai'
  prefixes: string[]
}

// Built-in model prefix → provider name mappings
const BUILTIN_PREFIXES: Record<string, string[]> = {
  lmstudio:   ['lmstudio/'],
  openai:     ['openai/', 'gpt-', 'o1', 'o3', 'o4'],
  gemini:     ['gemini/', 'gemini-'],
  together:   ['together/', 'meta-llama/'],
  groq:       ['groq/'],
  fireworks:  ['fireworks/', 'accounts/fireworks/'],
  anthropic:  ['anthropic/', 'claude-'],
}

function loadProxyEntries(): Map<string, ProxyEntry> {
  const entries = new Map<string, ProxyEntry>()

  // Scan all env vars for OMO_PROXY_{NAME}_TARGET_URL
  for (const [key, value] of Object.entries(process.env)) {
    const m = key.match(/^OMO_PROXY_([A-Z0-9]+)_TARGET_URL$/)
    if (!m || !value) continue
    const name = m[1].toLowerCase()

    // Key resolution: OMO_PROXY_{NAME}_API_KEY → well-known env var → OMO_PROXY_API_KEY → ''
    const wellKnownKey: Record<string, string | undefined> = {
      openai:    process.env.OPENAI_API_KEY,
      gemini:    process.env.GEMINI_API_KEY    ?? process.env.GOOGLE_API_KEY,
      together:  process.env.TOGETHER_API_KEY,
      groq:      process.env.GROQ_API_KEY,
      fireworks: process.env.FIREWORKS_API_KEY,
      anthropic: process.env.ANTHROPIC_API_KEY,
    }
    const apiKey  = process.env[`OMO_PROXY_${m[1]}_API_KEY`]
      ?? wellKnownKey[name]
      ?? process.env.OMO_PROXY_API_KEY
      ?? ''
    const proto   = (process.env[`OMO_PROXY_${m[1]}_PROTO`]     ?? 'openai').toLowerCase()
    const rawPfx  = process.env[`OMO_PROXY_${m[1]}_PREFIXES`]

    const prefixes = rawPfx
      ? rawPfx.split(',').map(s => s.trim()).filter(Boolean)
      : (BUILTIN_PREFIXES[name] ?? [`${name}/`])

    entries.set(name, {
      name,
      targetUrl: value,
      apiKey,
      proto: proto === 'anthropic' ? 'anthropic' : 'openai',
      prefixes,
    })
  }

  return entries
}

const ENTRIES = loadProxyEntries()

process.stderr.write(
  `[omo-proxy] listening on :${PORT} — providers: ${[...ENTRIES.keys()].join(', ') || '(none)'}\n`
)

// Write PID file for daemon management
try { writeFileSync(`/tmp/omo-proxy-${PORT}.pid`, String(process.pid)) } catch {}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

/** Strip leading provider prefix from model string for upstream forwarding. */
function stripProviderPrefix(model: string, entryName: string): string {
  // Strip the entry name prefix first (e.g. "lmstudio/")
  const namePrefix = `${entryName}/`
  if (model.startsWith(namePrefix)) return model.slice(namePrefix.length)

  // Strip any other known provider prefix
  for (const prefixes of Object.values(BUILTIN_PREFIXES)) {
    for (const p of prefixes) {
      if (p.endsWith('/') && model.startsWith(p)) return model.slice(p.length)
    }
  }
  return model
}

function resolveEntry(model: string): ProxyEntry | null {
  const m = model.toLowerCase()

  // Match by registered prefix (longest match wins)
  let best: ProxyEntry | null = null
  let bestLen = 0
  for (const entry of ENTRIES.values()) {
    for (const pfx of entry.prefixes) {
      if (m.startsWith(pfx.toLowerCase()) && pfx.length > bestLen) {
        best = entry
        bestLen = pfx.length
      }
    }
  }
  if (best) return best

  // Fallback to default provider
  return ENTRIES.get(DEFAULT_PROVIDER) ?? (ENTRIES.size > 0 ? [...ENTRIES.values()][0] : null)
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

function anthropicError(message: string, status = 500): Response {
  return new Response(
    JSON.stringify({ type: 'error', error: { type: 'api_error', message } }),
    { status, headers: { 'content-type': 'application/json' } },
  )
}

async function handleMessages(req: Request): Promise<Response> {
  let body: AnthropicRequest
  try {
    body = await req.json() as AnthropicRequest
  } catch {
    return anthropicError('Invalid JSON body', 400)
  }

  const entry = resolveEntry(body.model)
  if (!entry) {
    return anthropicError(`No proxy provider configured. Set OMO_PROXY_{NAME}_TARGET_URL.`, 503)
  }

  const upstreamModel = stripProviderPrefix(body.model, entry.name)

  // Passthrough: upstream speaks Anthropic natively — forward unchanged
  if (entry.proto === 'anthropic') {
    const forwardBody = { ...body, model: upstreamModel }
    let upstream: Response
    try {
      upstream = await fetch(entry.targetUrl, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'authorization': `Bearer ${entry.apiKey}`,
          'x-api-key': entry.apiKey,
        },
        body: JSON.stringify(forwardBody),
      })
    } catch (err) {
      return anthropicError(`Upstream fetch failed: ${err}`)
    }

    // Stream or forward response body as-is
    return new Response(upstream.body, {
      status: upstream.status,
      headers: upstream.headers,
    })
  }

  // Translate: Anthropic → OpenAI
  const openaiBody = translateRequest({ ...body, model: upstreamModel }, undefined)

  let upstream: Response
  try {
    upstream = await fetch(entry.targetUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${entry.apiKey}`,
      },
      body: JSON.stringify(openaiBody),
    })
  } catch (err) {
    return anthropicError(`Upstream fetch failed: ${err}`)
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => upstream.statusText)
    return anthropicError(`Upstream error ${upstream.status}: ${text}`, upstream.status)
  }

  if (body.stream) {
    const translator = new StreamTranslator(upstreamModel)
    const upstreamBody = upstream.body
    if (!upstreamBody) return anthropicError('Upstream returned empty stream body')

    const readable = new ReadableStream({
      async start(controller) {
        const reader = upstreamBody.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        try {
          while (true) {
            const { done, value } = await reader.read()
            if (done) break
            buffer += decoder.decode(value, { stream: true })
            const lines = buffer.split('\n')
            buffer = lines.pop() ?? ''
            for (const line of lines) {
              const trimmed = line.trim()
              if (!trimmed || trimmed === 'data: [DONE]') continue
              if (!trimmed.startsWith('data: ')) continue
              try {
                const chunk = JSON.parse(trimmed.slice(6)) as OpenAIDelta
                for (const ev of translator.feed(chunk)) {
                  controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
                }
              } catch { continue }
            }
          }
          // Flush remaining buffer
          if (buffer.trim().startsWith('data: ') && buffer.trim() !== 'data: [DONE]') {
            try {
              const chunk = JSON.parse(buffer.trim().slice(6)) as OpenAIDelta
              for (const ev of translator.feed(chunk)) {
                controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
              }
            } catch {}
          }
          for (const ev of translator.finish()) {
            controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
          }
          // Emit token metrics (fire-and-forget; translator has accumulated usage)
          const usage = translator.getUsage()
          void emitTokenMetrics({ provider: entry.name, model: upstreamModel, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens })
        } catch (err) {
          controller.error(err)
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      status: 200,
      headers: { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'connection': 'keep-alive' },
    })
  }

  // Non-streaming
  try {
    const openaiResponse = await upstream.json()
    const anthropicResponse = translateResponse(openaiResponse, upstreamModel)
    void emitTokenMetrics({
      provider: entry.name,
      model: upstreamModel,
      inputTokens:  anthropicResponse.usage.input_tokens,
      outputTokens: anthropicResponse.usage.output_tokens,
    })
    return new Response(JSON.stringify(anthropicResponse), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  } catch (err) {
    return anthropicError(`Failed to parse upstream response: ${err}`)
  }
}

// ---------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', providers: [...ENTRIES.keys()] }), {
        headers: { 'content-type': 'application/json' },
      })
    }
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      return handleMessages(req)
    }
    return new Response('Not Found', { status: 404 })
  },
})
