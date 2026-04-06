import { readStdin } from './stdin-reader.js'
import { mapEvent, type ClaudeCodeInput } from './event-mapper.js'
import { getPlugin } from './entry.js'
import { recordHookEvent, recordSessionTokens, recordAgentTokens, flush, shutdown } from './metrics.js'
import { classifyPrompt, autoClassifyPrompt } from './prompt-router.js'
import { runHeadlessDelegate } from './headless-delegate.js'
import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, unlinkSync } from 'fs'
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

interface SessionUsage {
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
}

/** Sum all assistant message token usage from a single JSONL file. */
function readJSONLUsage(filePath: string): SessionUsage | null {
  try {
    const content = readFileSync(filePath, 'utf-8')
    let inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, model = ''
    for (const line of content.split('\n')) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type !== 'assistant' || !msg.message?.usage) continue
        const u = msg.message.usage
        inputTokens      += (u.input_tokens            ?? 0)
        outputTokens     += (u.output_tokens           ?? 0)
        cacheReadTokens  += (u.cache_read_input_tokens ?? 0)
        if (msg.message.model) model = msg.message.model
      } catch { /* skip malformed lines */ }
    }
    return model ? { model, inputTokens, outputTokens, cacheReadTokens } : null
  } catch {
    return null
  }
}

/** Return all JSONL file paths in the project directory for the given cwd. */
function listProjectJSONLs(dir: string): Array<{ path: string; sessionId: string }> {
  try {
    const encoded = encodeProjectPath(dir)
    const projectDir = join(homedir(), '.claude', 'projects', encoded)
    if (!existsSync(projectDir)) return []
    return readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => ({ path: join(projectDir, f), sessionId: f.replace(/\.jsonl$/, '') }))
  } catch {
    return []
  }
}

const STATE_DIR = join(homedir(), '.claude', 'tmp', 'omo-session-state')
const AGENT_STATE_DIR = join(homedir(), '.claude', 'tmp', 'omo-agent-state')

function isOmoAgent(agentType: string): boolean {
  return agentType.startsWith('omo-')
}

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

/** Emit delta tokens for the main session JSONL only.
 *  Delegate sub-sessions (Agent SDK) use non-Claude models routed through the proxy —
 *  their tokens are already tracked via omo_proxy_tokens_total, so skip them here. */
function processJSONL(filePath: string, fileSessionId: string, mainSessionId: string): void {
  const current = readJSONLUsage(filePath)
  if (!current) return
  if (!current.model.startsWith('claude-')) return

  const prev = loadSessionState(fileSessionId)
  const deltaInput     = Math.max(0, current.inputTokens     - prev.inputTokens)
  const deltaOutput    = Math.max(0, current.outputTokens    - prev.outputTokens)
  const deltaCacheRead = Math.max(0, current.cacheReadTokens - prev.cacheReadTokens)

  if (deltaInput || deltaOutput || deltaCacheRead) {
    const origin = fileSessionId === mainSessionId ? 'session' : 'delegate'
    recordSessionTokens({
      model:           current.model,
      origin,
      inputTokens:     deltaInput,
      outputTokens:    deltaOutput,
      cacheReadTokens: deltaCacheRead,
    })
  }

  saveSessionState(fileSessionId, {
    inputTokens:     current.inputTokens,
    outputTokens:    current.outputTokens,
    cacheReadTokens: current.cacheReadTokens,
  })
}

async function captureSessionTokens(sessionId: string, dir: string): Promise<void> {
  // Only scan the main session JSONL. Delegate sub-sessions (Agent SDK) fire their
  // own Stop hooks with their own session ID as "main" — scanning all files would
  // incorrectly label sub-session tokens as origin="session". Delegate token counts
  // are tracked correctly via omo_proxy_tokens_total emitted by the proxy.
  const files = listProjectJSONLs(dir)
  const mainFile = files.find(f => f.sessionId === sessionId)
  if (mainFile) {
    processJSONL(mainFile.path, mainFile.sessionId, sessionId)
  }
}

// ---------------------------------------------------------------------------
// Agent token tracking — reads agent JSONL on SubagentStop
// ---------------------------------------------------------------------------

function processAgentTokens(agentType: string, agentId: string, raw: ClaudeCodeInput): void {
  // Try agent_transcript_path first (provided by Claude Code on SubagentStop)
  const transcriptPath = typeof raw.agent_transcript_path === 'string'
    ? raw.agent_transcript_path : undefined

  if (transcriptPath) {
    const usage = readJSONLUsage(transcriptPath)
    if (usage) {
      recordAgentTokens({ agent: agentType, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens })
      return
    }
  }

  // Fallback: scan project JSONLs for a file matching the agent's session ID
  const dir = raw.directory ? String(raw.directory) : process.cwd()
  const files = listProjectJSONLs(dir)
  const agentFile = files.find(f => f.sessionId === agentId)
  if (agentFile) {
    const usage = readJSONLUsage(agentFile.path)
    if (usage) {
      recordAgentTokens({ agent: agentType, model: usage.model, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, cacheReadTokens: usage.cacheReadTokens })
    }
  }
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

  // Prompt routing: intercept UserPromptSubmit with explicit prefixes or auto-classification
  if (parsed.hook_event_name === 'UserPromptSubmit') {
    const prompt = typeof parsed.prompt === 'string' ? parsed.prompt : ''
    let decision = classifyPrompt(prompt)        // sync prefix check first
    if (decision.route === 'pass') {
      decision = await autoClassifyPrompt(prompt) // async classifier fallback
    }
    if (decision.route !== 'pass') {
      recordHookEvent(parsed.hook_event_name, true)
      try {
        const result = await runHeadlessDelegate({ task: decision.prompt, category: decision.route, directory })
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

  // Agent token tracking: persist agent info on start, read tokens on stop
  if (parsed.hook_event_name === 'SubagentStart') {
    const agentType = String(parsed.agent_type ?? '')
    const agentId = String(parsed.agent_id ?? '')
    if (isOmoAgent(agentType) && agentId) {
      try {
        mkdirSync(AGENT_STATE_DIR, { recursive: true })
        writeFileSync(join(AGENT_STATE_DIR, `${agentId}.json`), JSON.stringify({ agentType, startedAt: Date.now() }))
      } catch { /* best-effort */ }
    }
  }

  if (parsed.hook_event_name === 'SubagentStop') {
    const agentType = String(parsed.agent_type ?? '')
    const agentId = String(parsed.agent_id ?? '')
    if (isOmoAgent(agentType) && agentId) {
      processAgentTokens(agentType, agentId, parsed)
      try { unlinkSync(join(AGENT_STATE_DIR, `${agentId}.json`)) } catch { /* ok if missing */ }
    }
  }

  // On Stop: capture main-session token usage from the session JSONL before flushing metrics.
  if (parsed.hook_event_name === 'Stop' && parsed.session_id) {
    await captureSessionTokens(String(parsed.session_id), directory)
  }

  const target = mapEvent(parsed)

  recordHookEvent(parsed.hook_event_name)

  // Fast-path: skip events that don't need the full plugin, and PreCompact
  // which can cause a feedback loop (context injection → compaction → repeat).
  if (target.handler === 'skip' || target.handler === 'experimental.session.compacting') {
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
