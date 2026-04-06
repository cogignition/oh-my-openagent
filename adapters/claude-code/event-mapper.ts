import { randomUUID } from 'node:crypto'

export type ClaudeCodeInput = {
  session_id?: string
  hook_event_name: string
  tool_name?: string
  tool_input?: Record<string, unknown>
  tool_response?: string
  tool_error?: string
  directory?: string
  prompt?: string
  [key: string]: unknown
}

type OmoEvent = { type: string; properties?: Record<string, unknown> }

export type DispatchTarget =
  | { handler: 'event'; input: { event: OmoEvent }; output: Record<string, unknown> }
  | { handler: 'chat.message'; input: { sessionID: string; agent: string; model: string }; output: Record<string, unknown> }
  | { handler: 'tool.execute.before'; input: { tool: string; sessionID: string; callID: string }; output: { args: Record<string, unknown> } }
  | { handler: 'tool.execute.after'; input: { tool: string; sessionID: string; callID: string; [key: string]: unknown }; output: Record<string, unknown> }
  | { handler: 'experimental.session.compacting'; input: { sessionID: string }; output: { context: string[] } }
  | { handler: 'subagent.start'; input: { agentType: string; agentId: string; sessionID: string }; output: Record<string, unknown> }
  | { handler: 'subagent.stop'; input: { agentType: string; agentId: string; sessionID: string; transcriptPath?: string }; output: Record<string, unknown> }
  | { handler: 'skip' }

function makeEvent(type: string, sessionID: string, extra?: Record<string, unknown>): { event: OmoEvent } {
  return { event: { type, properties: { sessionID, ...extra } } }
}

export function mapEvent(raw: ClaudeCodeInput): DispatchTarget {
  const sessionID = raw.session_id ?? ''
  const event = raw.hook_event_name

  switch (event) {
    case 'SessionStart':
      // session.created uses properties.info.id (not properties.sessionID)
      return {
        handler: 'event',
        input: { event: { type: 'session.created', properties: { info: { id: sessionID } } } },
        output: {},
      }

    case 'UserPromptSubmit':
      return {
        handler: 'chat.message',
        input: { sessionID, agent: 'default', model: '' },
        output: {},
      }

    case 'PreToolUse':
      return {
        handler: 'tool.execute.before',
        input: { tool: raw.tool_name ?? '', sessionID, callID: randomUUID() },
        output: { args: raw.tool_input ?? {} },
      }

    case 'PostToolUse':
      return {
        handler: 'tool.execute.after',
        input: { tool: raw.tool_name ?? '', sessionID, callID: randomUUID() },
        output: {},
      }

    case 'PostToolUseFailure':
      return {
        handler: 'tool.execute.after',
        input: { tool: raw.tool_name ?? '', sessionID, callID: randomUUID(), failed: true },
        output: {},
      }

    case 'PreCompact':
      return {
        handler: 'experimental.session.compacting',
        input: { sessionID },
        output: { context: [] },
      }

    case 'Stop':
      return { handler: 'event', input: makeEvent('session.stopping', sessionID), output: {} }

    case 'SessionEnd':
      return { handler: 'event', input: makeEvent('session.ended', sessionID), output: {} }

    case 'SubagentStart':
      return {
        handler: 'subagent.start',
        input: {
          agentType: String(raw.agent_type ?? ''),
          agentId: String(raw.agent_id ?? ''),
          sessionID,
        },
        output: {},
      }

    case 'SubagentStop':
      return {
        handler: 'subagent.stop',
        input: {
          agentType: String(raw.agent_type ?? ''),
          agentId: String(raw.agent_id ?? ''),
          sessionID,
          transcriptPath: typeof raw.agent_transcript_path === 'string'
            ? raw.agent_transcript_path : undefined,
        },
        output: {},
      }

    case 'PermissionRequest':
      return { handler: 'skip' }

    default:
      return { handler: 'skip' }
  }
}
