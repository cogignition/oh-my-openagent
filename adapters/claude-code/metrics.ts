/**
 * OTLP metrics instrumentation for the Claude Code adapter.
 *
 * Emits to OMO_METRICS_ENDPOINT (default: http://localhost:4318) when
 * OMO_METRICS_ENABLED=true. No-ops silently when disabled or unreachable.
 *
 * Instruments:
 *   omo_hook_events_total          — counter  {event_name}
 *   omo_delegate_calls_total       — counter  {category, model, status}
 *   omo_delegate_latency_ms        — histogram {category, model}
 *   omo_delegate_tokens_total      — counter  {direction:"input"|"output", category, model}
 *   omo_lm_studio_fallbacks_total  — counter  {category, reason}
 */

import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http'
import { resourceFromAttributes } from '@opentelemetry/resources'
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions'
import type { Counter, Histogram, Meter } from '@opentelemetry/api'

const ENABLED = process.env.OMO_METRICS_ENABLED === 'true'
const ENDPOINT = (process.env.OMO_METRICS_ENDPOINT ?? 'http://localhost:4318').replace(/\/$/, '')
const EXPORT_INTERVAL_MS = 15_000

let _meter: Meter | null = null
let _provider: MeterProvider | null = null

function getMeter(): Meter | null {
  if (!ENABLED) return null
  if (_meter) return _meter

  try {
    const exporter = new OTLPMetricExporter({
      url: `${ENDPOINT}/v1/metrics`,
      headers: {},
    })

    _provider = new MeterProvider({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: 'oh-my-openagent',
        [ATTR_SERVICE_VERSION]: '0.0.0',
        'adapter': 'claude-code',
      }),
      readers: [
        new PeriodicExportingMetricReader({
          exporter,
          exportIntervalMillis: EXPORT_INTERVAL_MS,
        }),
      ],
    })

    _meter = _provider.getMeter('omo-claude-code-adapter')
    return _meter
  } catch (err) {
    process.stderr.write(`[metrics] init failed: ${err}\n`)
    return null
  }
}

// Lazily initialized instruments
let _hookCounter: Counter | null = null
let _delegateCounter: Counter | null = null
let _delegateLatency: Histogram | null = null
let _delegateTokens: Counter | null = null
let _fallbackCounter: Counter | null = null

function hookCounter(): Counter | null {
  if (_hookCounter) return _hookCounter
  const m = getMeter()
  if (!m) return null
  _hookCounter = m.createCounter('omo_hook_events_total', {
    description: 'Total Claude Code hook events received',
  })
  return _hookCounter
}

function delegateCounter(): Counter | null {
  if (_delegateCounter) return _delegateCounter
  const m = getMeter()
  if (!m) return null
  _delegateCounter = m.createCounter('omo_delegate_calls_total', {
    description: 'Total headless delegate calls',
  })
  return _delegateCounter
}

function delegateLatency(): Histogram | null {
  if (_delegateLatency) return _delegateLatency
  const m = getMeter()
  if (!m) return null
  _delegateLatency = m.createHistogram('omo_delegate_latency_ms', {
    description: 'Headless delegate call latency in milliseconds',
    unit: 'ms',
  })
  return _delegateLatency
}

function delegateTokens(): Counter | null {
  if (_delegateTokens) return _delegateTokens
  const m = getMeter()
  if (!m) return null
  _delegateTokens = m.createCounter('omo_delegate_tokens_total', {
    description: 'Total tokens consumed by headless delegate calls',
  })
  return _delegateTokens
}

function fallbackCounter(): Counter | null {
  if (_fallbackCounter) return _fallbackCounter
  const m = getMeter()
  if (!m) return null
  _fallbackCounter = m.createCounter('omo_lm_studio_fallbacks_total', {
    description: 'LM Studio → Claude fallback events',
  })
  return _fallbackCounter
}

// Public API — all no-op when metrics disabled

export function recordHookEvent(eventName: string, routed = false): void {
  try { hookCounter()?.add(1, { event_name: eventName, routed: String(routed) }) } catch {}
}

export function recordDelegateCall(opts: {
  category: string
  model: string
  status: 'success' | 'fallback' | 'error'
  latencyMs: number
  inputTokens?: number
  outputTokens?: number
}): void {
  const { category, model, status, latencyMs, inputTokens, outputTokens } = opts
  try {
    delegateCounter()?.add(1, { category, model, status })
    delegateLatency()?.record(latencyMs, { category, model })
    if (inputTokens)  delegateTokens()?.add(inputTokens,  { direction: 'input',  category, model })
    if (outputTokens) delegateTokens()?.add(outputTokens, { direction: 'output', category, model })
  } catch {}
}

export function recordFallback(category: string, reason: string): void {
  try { fallbackCounter()?.add(1, { category, reason }) } catch {}
}

/** Flush pending metrics on shutdown. Best-effort. */
export async function shutdown(): Promise<void> {
  try { await _provider?.shutdown() } catch {}
}
