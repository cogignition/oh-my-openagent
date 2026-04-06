/// <reference types="bun-types" />

// server.ts — Anthropic→OpenAI proxy server (Bun native).
//
// Env vars:
//   OMO_PROXY_PORT=4315          — listen port (default 4315)
//   OMO_PROXY_TARGET_URL=...     — upstream OpenAI-compatible endpoint
//   OMO_PROXY_API_KEY=sk-...     — upstream API key
//   OMO_PROXY_MODEL=gpt-4o-mini  — optional model override

import { writeFileSync } from 'fs'
import { translateRequest, translateResponse, StreamTranslator, formatSSE } from './translate.js'
import type { AnthropicRequest, OpenAIDelta } from './translate.js'

const PORT = parseInt(process.env.OMO_PROXY_PORT ?? '4315', 10)
const TARGET_URL = process.env.OMO_PROXY_TARGET_URL ?? 'https://api.openai.com/v1/chat/completions'
const MODEL_OVERRIDE = process.env.OMO_PROXY_MODEL

// Resolve API key by provider — discrete keys per provider, OMO_PROXY_API_KEY as fallback.
//   OMO_PROXY_OPENAI_API_KEY    — api.openai.com
//   OMO_PROXY_TOGETHER_API_KEY  — together.ai
//   OMO_PROXY_FIREWORKS_API_KEY — fireworks.ai
//   OMO_PROXY_GROQ_API_KEY      — groq.com
//   OMO_PROXY_ANTHROPIC_API_KEY — api.anthropic.com (Anthropic-native upstream)
//   OMO_PROXY_API_KEY           — generic fallback for any other provider
function resolveApiKey(): string {
  const t = TARGET_URL.toLowerCase()
  if (t.includes('openai.com'))       return process.env.OMO_PROXY_OPENAI_API_KEY    ?? process.env.OMO_PROXY_API_KEY ?? ''
  if (t.includes('together.ai'))      return process.env.OMO_PROXY_TOGETHER_API_KEY  ?? process.env.OMO_PROXY_API_KEY ?? ''
  if (t.includes('fireworks.ai'))     return process.env.OMO_PROXY_FIREWORKS_API_KEY ?? process.env.OMO_PROXY_API_KEY ?? ''
  if (t.includes('groq.com'))         return process.env.OMO_PROXY_GROQ_API_KEY      ?? process.env.OMO_PROXY_API_KEY ?? ''
  if (t.includes('anthropic.com'))    return process.env.OMO_PROXY_ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_API_KEY ?? process.env.OMO_PROXY_API_KEY ?? ''
  return process.env.OMO_PROXY_API_KEY ?? ''
}

// Write PID file for daemon management
try {
  writeFileSync(`/tmp/omo-proxy-${PORT}.pid`, String(process.pid))
} catch {
  // Non-fatal: best effort
}

process.stderr.write(`[omo-proxy] listening on :${PORT}\n`)

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

  const openaiBody = translateRequest(body, MODEL_OVERRIDE)

  let upstream: Response
  try {
    upstream = await fetch(TARGET_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': `Bearer ${resolveApiKey()}`,
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
    // Stream: translate OpenAI SSE → Anthropic SSE
    const translator = new StreamTranslator(MODEL_OVERRIDE ?? body.model)
    const upstreamBody = upstream.body
    if (!upstreamBody) {
      return anthropicError('Upstream returned empty stream body')
    }

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

              const jsonStr = trimmed.slice(6)
              let chunk: OpenAIDelta
              try {
                chunk = JSON.parse(jsonStr) as OpenAIDelta
              } catch {
                continue
              }

              const events = translator.feed(chunk)
              for (const ev of events) {
                controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
              }
            }
          }

          // Flush any remaining buffer
          if (buffer.trim() && buffer.trim() !== 'data: [DONE]' && buffer.trim().startsWith('data: ')) {
            const jsonStr = buffer.trim().slice(6)
            try {
              const chunk = JSON.parse(jsonStr) as OpenAIDelta
              const events = translator.feed(chunk)
              for (const ev of events) {
                controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
              }
            } catch {
              // ignore malformed trailing chunk
            }
          }

          // Emit finish events in case upstream didn't include finish_reason
          const finalEvents = translator.finish()
          for (const ev of finalEvents) {
            controller.enqueue(new TextEncoder().encode(formatSSE(ev)))
          }
        } catch (err) {
          controller.error(err)
        } finally {
          controller.close()
        }
      },
    })

    return new Response(readable, {
      status: 200,
      headers: {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        'connection': 'keep-alive',
      },
    })
  }

  // Non-streaming: translate response
  let openaiResponse: Awaited<ReturnType<typeof upstream.json>>
  try {
    openaiResponse = await upstream.json()
  } catch (err) {
    return anthropicError(`Failed to parse upstream response: ${err}`)
  }

  const anthropicResponse = translateResponse(openaiResponse, MODEL_OVERRIDE ?? body.model)
  return new Response(JSON.stringify(anthropicResponse), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  })
}

Bun.serve({
  port: PORT,
  async fetch(req: Request): Promise<Response> {
    const url = new URL(req.url)

    // Health check
    if (req.method === 'GET' && url.pathname === '/health') {
      return new Response('OK', { status: 200 })
    }

    // Main proxy endpoint
    if (req.method === 'POST' && url.pathname === '/v1/messages') {
      return handleMessages(req)
    }

    return new Response('Not Found', { status: 404 })
  },
})
