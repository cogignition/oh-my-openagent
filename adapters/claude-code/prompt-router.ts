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
