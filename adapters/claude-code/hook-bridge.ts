import { readStdin } from './stdin-reader.js'
import { mapEvent, type ClaudeCodeInput } from './event-mapper.js'
import { getPlugin } from './entry.js'
import { recordHookEvent, shutdown } from './metrics.js'

export async function run(): Promise<void> {
  const raw = await readStdin()
  let parsed: ClaudeCodeInput = { hook_event_name: 'Unknown' }
  try { parsed = JSON.parse(raw || '{}') } catch { /* ignore */ }

  const directory = parsed.directory ?? process.cwd()
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
  .finally(() => shutdown())
