import { readStdin } from './stdin-reader.js'
import { mapEvent, type ClaudeCodeInput } from './event-mapper.js'
import { getPlugin } from './entry.js'
import { recordHookEvent, recordSessionTokens, flush, shutdown } from './metrics.js'
import { classifyPrompt } from './prompt-router.js'
import { runHeadlessDelegate } from './headless-delegate.js'
import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

// ---------------------------------------------------------------------------
// Session token tracking — reads Claude Code's session JSONL on each Stop
// event to capture main-session Anthropic token usage.
//
// Uses delta tracking: stores the last-known cumulative total in a temp file
// and emits only the increment since the previous Stop (one counter add per turn).
// ---------------------------------------------------------------------------

/** Encode a cwd path to the Claude Code projects directory name format.
 *  e.g. /Users/foo/my_project → -Users-foo-my-project */
function encodeProjectPath(dir: string): string {
  return dir.replace(/[^a-zA-Z0-9]/g, '-')
}

interface AssistantUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** Read the session JSONL and sum all assistant message token usage. */
function readSessionUsage(sessionId: string, dir: string): AssistantUsage | null {
  try {
    const encoded  = encodeProjectPath(dir)
    const filePath = join(homedir(), '.claude', 'projects', encoded, `${sessionId}.jsonl`)
    if (!existsSync(filePath)) return null

    const content = readFileSync(filePath, 'utf-8')
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, model = ''

    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== 'assistant' || !msg.message?.usage) continue
        const u = msg.message.usage
        inputTokens      += (u.input_tokens               ?? 0)
        outputTokens     += (u.output_tokens              ?? 0)
        cacheReadTokens  += (u.cache_read_input_tokens    ?? 0)
        if (msg.message.model) model = msg.message.model
      } catch { /* skip malformed lines */ }
    }

    return { model: model || 'unknown', inputTokens, outputTokens, cacheReadTokens }
  } catch {
    return null
  }
}

const STATE_DIR = join(homedir(), '.claude', 'tmp', 'omo-session-state')

interface SessionState {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

function loadSessionState(sessionId: string): SessionState {
  try {
    const data = readFileSync(join(STATE_DIR, `${sessionId}.json`), 'utf-8')
    return JSON.parse(data)
  } catch {
    return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 }
  }
}

function saveSessionState(sessionId: string, state: SessionState): void {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    writeFileSync(join(STATE_DIR, `${sessionId}.json`), JSON.stringify(state))
  } catch { /* best-effort */ }
}

async function captureSessionTokens(sessionId: string, dir: string): Promise<void> {
  const current = readSessionUsage(sessionId, dir)
  if (!current) return

  const prev   = loadSessionState(sessionId)

  // Compute deltas — clamp to 0 to handle compaction (cumulative can drop after compact)
  const deltaInput     = Math.max(0, current.inputTokens     - prev.inputTokens)
  const deltaOutput    = Math.max(0, current.outputTokens    - prev.outputTokens)
  const deltaCacheRead = Math.max(0, current.cacheReadTokens - prev.cacheReadTokens)

  if (deltaInput || deltaOutput || deltaCacheRead) {
    recordSessionTokens({
      model:           current.model,
      inputTokens:     deltaInput,
      outputTokens:    deltaOutput,
      cacheReadTokens: deltaCacheRead,
    })
  }

  saveSessionState(sessionId, {
    inputTokens:     current.inputTokens,
    outputTokens:    current.outputTokens,
    cacheReadTokens: current.cacheReadTokens,
  })
}

export async function run(): Promise<void> {
  const raw = await readStdin()
  let parsed: ClaudeCodeInput = { hook_event_name: 'Unknown' }
  try { parsed = JSON.parse(raw || '{}') } catch { /* ignore */ }

  const directory = parsed.directory ?? process.cwd()

  // On session start, ensure the Anthropic→OpenAI proxy daemon is running.
  // Dynamic import keeps proxy/daemon.ts (Bun-native) out of the tsc graph.
  if (parsed.hook_event_name === 'SessionStart') {
    const { ensureProxyRunning } = await import('./proxy/daemon.js')
    await ensureProxyRunning().catch((err: unknown) => {
      process.stderr.write(`[hook-bridge] proxy daemon start failed: ${err}\n`)
    })
  }

  // Prompt routing: intercept UserPromptSubmit with known prefixes (@quick, @local, @deep, etc.)
  if (parsed.hook_event_name === 'UserPromptSubmit') {
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''
    const decision = classifyPrompt(prompt)
    if (decision.route !== 'pass') {
      recordHookEvent(parsed.hook_event_name, true)
      try {
        const result = await runHeadlessDelegate({ task: decision.prompt, category: decision.route, directory })
        // Flush metrics before writing response — Claude Code may kill the process
        // immediately after reading stdout, so the finally() flush may never run.
        await flush()
        process.stdout.write(JSON.stringify({ continue: false, stopReason: result }) + '\n')
      } catch (err) {
        process.stderr.write(`[hook-bridge] delegate error: ${err}\n`)
        await flush()
        process.stdout.write(JSON.stringify({ continue: true }) + '\n')
      }
      return
    }
  }

  // On Stop: capture main-session token usage from the session JSONL before flushing metrics.
  if (parsed.hook_event_name === 'Stop' && parsed.session_id) {
    await captureSessionTokens(String(parsed.session_id), directory)
  }

  const target = mapEvent(parsed)

  recordHookEvent(parsed.hook_event_name)

  if (target.handler === 'skip') {
    process.stdout.write(JSON.stringify({ continue: true }) + '\n')
    return
  }

  try {
    const plugin = await getPlugin(directory)
    const handler = (plugin as Record<string, unknown>)[target.handler]
    if (typeof handler === 'function') {
      await handler(target.input, target.output)
    }
    // Extract message from output if available
    const message = extractMessage(target.output)
    process.stdout.write(JSON.stringify({ continue: true, ...(message ? { message } : {}) }) + '\n')
  } catch (err) {
    process.stderr.write(`[hook-bridge] error: ${err}\n`)
    process.stdout.write(JSON.stringify({ continue: true }) + '\n')
  }
}

function extractMessage(output: Record<string, unknown>): string | undefined {
  // If output has context array (compacting), join it
  if (Array.isArray(output.context) && output.context.length > 0) {
    return output.context.join('\n')
  }
  // If output has message parts, extract text
  if (Array.isArray(output.parts)) {
    const texts = (output.parts as Array<{type: string; text?: string}>)
      .filter(p => p.type === 'text' && p.text)
      .map(p => p.text!)
    if (texts.length > 0) return texts.join('\n')
  }
  return undefined
}

// Auto-run when executed directly
run()
  .catch(err => {
    process.stderr.write(`[hook-bridge] fatal: ${err}\n`)
    process.stdout.write(JSON.stringify({ continue: true }) + '\n')
  })
  .finally(async () => {
    // Flush metrics before exit — the OTel periodic exporter won't fire
    // in a short-lived process without an explicit shutdown flush.
    await shutdown()
  })
