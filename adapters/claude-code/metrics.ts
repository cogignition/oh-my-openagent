/**
 * OTLP metrics instrumentation for the Claude Code adapter.
 *
 * Emits to OMO_METRICS_ENDPOINT (default: http://localhost:4318) when
 * OMO_METRICS_ENABLED=true. No-ops silently when disabled or unreachable.
 *
 * Three discrete token metrics — each tracks a different call path:
 *   omo_session_tokens_total       — counter  {direction, model}
 *     Main Claude Code session ↔ Anthropic. Read from session JSONL on Stop.
 *   omo_proxy_tokens_total         — emitted by proxy/server.ts, not here
 *     Delegate quick calls → OpenAI/LM Studio via the omo proxy.
 *   omo_delegate_tokens_total      — counter  {direction, category, model}
 *     Delegate deep calls — token counts returned by the Anthropic SDK.
 *
 * Other instruments:
 *   omo_hook_events_total          — counter  {event_name}
 *   omo_delegate_calls_total       — counter  {category, model, status}
 *   omo_delegate_latency_ms        — histogram {category, model}
 *   omo_lm_studio_fallbacks_total  — counter  {category, reason}
 *   omo_agent_tokens_total         — counter  {agent, model, direction}
 *     Per-agent token usage (omo-oracle, omo-explore, etc.) read on SubagentStop.
 *   omo_classifier_decisions_total — counter  {decision, model}
 *     Auto-classifier routing decisions (quick vs pass).
 */

import { MeterProvider, PeriodicExportingMetricReader } from '@opentelemetry/sdk-metrics'
import { OTLPMetricExporter, AggregationTemporalityPreference } from '@opentelemetry/exporter-metrics-otlp-http'
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
    // Delta temporality: each short-lived hook process exports its increment
    // rather than a cumulative sum from its own start. Without this, every
    // fresh process exports cumulative=1, the collector sees no change, and
    // rate() stays 0 forever.
    const exporter = new OTLPMetricExporter({
      url: `${ENDPOINT}/v1/metrics`,
      headers: {},
      temporalityPreference: AggregationTemporalityPreference.DELTA,
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
let _sessionTokens: Counter | null = null
let _fallbackCounter: Counter | null = null
let _agentTokens: Counter | null = null
let _classifierCounter: Counter | null = null

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
    // Buckets cover quick (5-15s via LM Studio/OpenAI) and deep (10-120s) calls
    advice: { explicitBucketBoundaries: [1000, 2500, 5000, 10000, 15000, 20000, 30000, 45000, 60000, 90000, 120000] },
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

function sessionTokens(): Counter | null {
  if (_sessionTokens) return _sessionTokens
  const m = getMeter()
  if (!m) return null
  _sessionTokens = m.createCounter('omo_session_tokens_total', {
    description: 'Tokens for the main Claude Code session (read from session JSONL on Stop)',
  })
  return _sessionTokens
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

function agentTokens(): Counter | null {
  if (_agentTokens) return _agentTokens
  const m = getMeter()
  if (!m) return null
  _agentTokens = m.createCounter('omo_agent_tokens_total', {
    description: 'Tokens consumed by omo agent invocations',
  })
  return _agentTokens
}

function classifierCounter(): Counter | null {
  if (_classifierCounter) return _classifierCounter
  const m = getMeter()
  if (!m) return null
  _classifierCounter = m.createCounter('omo_classifier_decisions_total', {
    description: 'Auto-classifier routing decisions',
  })
  return _classifierCounter
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

export function recordSessionTokens(opts: {
  model: string
  origin: 'session' | 'delegate'
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): void {
  const { model, origin, inputTokens, outputTokens, cacheReadTokens } = opts
  try {
    if (inputTokens)      sessionTokens()?.add(inputTokens,      { direction: 'input',      model, origin })
    if (outputTokens)     sessionTokens()?.add(outputTokens,     { direction: 'output',     model, origin })
    if (cacheReadTokens)  sessionTokens()?.add(cacheReadTokens,  { direction: 'cache_read', model, origin })
  } catch {}
}

export function recordFallback(category: string, reason: string): void {
  try { fallbackCounter()?.add(1, { category, reason }) } catch {}
}

export function recordAgentTokens(opts: {
  agent: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
}): void {
  const { agent, model, inputTokens, outputTokens, cacheReadTokens } = opts
  try {
    if (inputTokens)      agentTokens()?.add(inputTokens,      { direction: 'input',      agent, model })
    if (outputTokens)     agentTokens()?.add(outputTokens,     { direction: 'output',     agent, model })
    if (cacheReadTokens)  agentTokens()?.add(cacheReadTokens,  { direction: 'cache_read', agent, model })
  } catch {}
}

export function recordClassifierDecision(opts: {
  decision: 'quick' | 'pass'
  latencyMs: number
  model: string
}): void {
  try { classifierCounter()?.add(1, { decision: opts.decision, model: opts.model }) } catch {}
}

/** Force-flush pending metrics without shutting down the provider. */
export async function flush(): Promise<void> {
  try { await _provider?.forceFlush() } catch {}
}

/** Flush pending metrics on shutdown. Best-effort. */
export async function shutdown(): Promise<void> {
  try {
    await _provider?.forceFlush()
    await _provider?.shutdown()
  } catch {}
}
