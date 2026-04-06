/**
 * Prefix-based prompt classifier for Claude Code UserPromptSubmit routing.
 *
 * Prefixes:
 *   @quick / @local / @q  → route to LM Studio (quick category)
 *   @deep  / @opus        → route to Claude Opus (deep category)
 *   (anything else)       → pass through to Claude normally
 *
 * Kill-switch: OMO_PROMPT_ROUTING=false disables all interception.
 */

export type RouteDecision =
  | { route: 'quick'; prompt: string }
  | { route: 'deep';  prompt: string }
  | { route: 'pass' }

const QUICK_PREFIXES = ['@quick ', '@local ', '@q ']
const DEEP_PREFIXES  = ['@deep ',  '@opus ']

export function classifyPrompt(raw: string): RouteDecision {
  if (process.env.OMO_PROMPT_ROUTING === 'false') return { route: 'pass' }

  const lower = raw.trimStart().toLowerCase()

  for (const prefix of QUICK_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { route: 'quick', prompt: raw.trimStart().slice(prefix.length).trim() }
    }
  }

  for (const prefix of DEEP_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return { route: 'deep', prompt: raw.trimStart().slice(prefix.length).trim() }
    }
  }

  return { route: 'pass' }
}

// ---------------------------------------------------------------------------
// Auto-classification — uses a fast model to decide quick vs pass
// ---------------------------------------------------------------------------

const CLASSIFIER_SYSTEM = `You are a prompt classifier. Respond with exactly one word: QUICK or PASS.
QUICK: simple file lookups, listing files/symbols, simple factual questions about code, grep-like searches.
PASS: anything requiring reasoning, code generation, debugging, multi-step tasks, refactoring, or anything ambiguous.
When in doubt, respond PASS.`

export async function autoClassifyPrompt(raw: string): Promise<RouteDecision> {
  if (process.env.OMO_AUTO_CLASSIFY !== 'true') return { route: 'pass' }
  if (process.env.OMO_PROMPT_ROUTING === 'false') return { route: 'pass' }

  // Explicit prefixes already handled by classifyPrompt() — this only fires on pass
  const port = process.env.OMO_PROXY_PORT ?? '4315'
  const model = process.env.OMO_CATEGORY_QUICK_MODEL ?? 'gpt-5.4-mini'
  const start = Date.now()

  try {
    const { recordClassifierDecision } = await import('./metrics.js')

    const res = await fetch(`http://localhost:${port}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': 'omo-proxy' },
      body: JSON.stringify({
        model,
        max_tokens: 20,
        stream: false,
        system: CLASSIFIER_SYSTEM,
        messages: [{ role: 'user', content: raw }],
      }),
      signal: AbortSignal.timeout(500),
    })

    const json = await res.json() as { content?: Array<{ type: string; text?: string }> }
    const text = json.content?.[0]?.text ?? ''
    const decision: RouteDecision = text.toUpperCase().includes('QUICK')
      ? { route: 'quick', prompt: raw }
      : { route: 'pass' }

    recordClassifierDecision({ decision: decision.route === 'quick' ? 'quick' : 'pass', latencyMs: Date.now() - start, model })
    return decision
  } catch {
    return { route: 'pass' }
  }
}
