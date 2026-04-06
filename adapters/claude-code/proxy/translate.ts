// translate.ts — pure Anthropic ↔ OpenAI translation functions (no I/O, no side effects).

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AnthropicContentBlock {
  type: string
  text?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
}

export interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string | AnthropicContentBlock[]
}

export interface AnthropicTool {
  name: string
  description?: string
  input_schema: Record<string, unknown>
}

export interface AnthropicRequest {
  model: string
  messages: AnthropicMessage[]
  system?: string
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: AnthropicTool[]
  stop_sequences?: string[]
  metadata?: unknown
  [key: string]: unknown
}

export interface OpenAIMessage {
  role: string
  content?: string | null
  tool_calls?: OpenAIToolCall[]
  tool_call_id?: string
  name?: string
}

export interface OpenAIToolCall {
  id: string
  type: 'function'
  function: {
    name: string
    arguments: string
  }
}

export interface OpenAITool {
  type: 'function'
  function: {
    name: string
    description?: string
    parameters: Record<string, unknown>
  }
}

export interface OpenAIRequest {
  model: string
  messages: OpenAIMessage[]
  max_completion_tokens?: number
  max_tokens?: number
  temperature?: number
  top_p?: number
  stream?: boolean
  tools?: OpenAITool[]
  stop?: string[]
}

export interface OpenAIChoice {
  message: {
    role: string
    content?: string | null
    tool_calls?: OpenAIToolCall[]
  }
  finish_reason: string
}

export interface OpenAIResponse {
  id: string
  choices: OpenAIChoice[]
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
  model: string
}

export interface AnthropicResponse {
  id: string
  type: 'message'
  role: 'assistant'
  model: string
  content: AnthropicContentBlock[]
  stop_reason: string
  stop_sequence: null
  usage: {
    input_tokens: number
    output_tokens: number
  }
}

export interface AnthropicSSEEvent {
  event: string
  data: unknown
}

// OpenAI streaming delta shape
export interface OpenAIDelta {
  id?: string
  object?: string
  model?: string
  choices?: Array<{
    index: number
    delta: {
      role?: string
      content?: string | null
      tool_calls?: Array<{
        index: number
        id?: string
        type?: string
        function?: {
          name?: string
          arguments?: string
        }
      }>
    }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens: number
    completion_tokens: number
  }
}

// ---------------------------------------------------------------------------
// Request translation
// ---------------------------------------------------------------------------


function translateContentBlock(block: AnthropicContentBlock, role: string): OpenAIMessage[] {
  if (role === 'user' && block.type === 'tool_result') {
    const contentVal = block.content
    const contentStr =
      typeof contentVal === 'string'
        ? contentVal
        : Array.isArray(contentVal)
          ? (contentVal as AnthropicContentBlock[])
              .filter(b => b.type === 'text' && b.text)
              .map(b => b.text!)
              .join('\n')
          : JSON.stringify(contentVal)
    return [{
      role: 'tool',
      tool_call_id: block.tool_use_id ?? '',
      content: contentStr,
    }]
  }
  if (role === 'assistant' && block.type === 'tool_use') {
    // Returned as tool_calls on the assistant message — handled in translateMessage
    return []
  }
  // text block → handled in translateMessage
  return []
}

function translateMessage(msg: AnthropicMessage): OpenAIMessage[] {
  const { role, content } = msg

  if (typeof content === 'string') {
    return [{ role, content }]
  }

  // Separate tool_result blocks (user messages) from everything else
  const toolResultMessages: OpenAIMessage[] = []
  const textParts: string[] = []
  const toolCalls: OpenAIToolCall[] = []

  for (const block of content) {
    if (role === 'user' && block.type === 'tool_result') {
      const extras = translateContentBlock(block, role)
      toolResultMessages.push(...extras)
    } else if (role === 'assistant' && block.type === 'tool_use') {
      toolCalls.push({
        id: block.id ?? '',
        type: 'function',
        function: {
          name: block.name ?? '',
          arguments: JSON.stringify(block.input ?? {}),
        },
      })
    } else if (block.type === 'text' && block.text) {
      textParts.push(block.text)
    }
  }

  const messages: OpenAIMessage[] = []

  // Combine text + tool_calls into a single assistant message
  if (role === 'assistant') {
    const msg: OpenAIMessage = {
      role: 'assistant',
      content: textParts.length > 0 ? textParts.join('\n') : null,
    }
    if (toolCalls.length > 0) msg.tool_calls = toolCalls
    messages.push(msg)
  } else {
    // user — plain text parts
    if (textParts.length > 0) {
      messages.push({ role: 'user', content: textParts.join('\n') })
    }
    messages.push(...toolResultMessages)
  }

  return messages
}

export function translateRequest(body: AnthropicRequest, modelOverride?: string): OpenAIRequest {
  const model = modelOverride ?? body.model
  const openaiMessages: OpenAIMessage[] = []

  // System message first
  if (body.system) {
    openaiMessages.push({ role: 'system', content: body.system })
  }

  for (const msg of body.messages) {
    openaiMessages.push(...translateMessage(msg))
  }

  const req: OpenAIRequest = {
    model,
    messages: openaiMessages,
  }

  // Use max_completion_tokens universally — max_tokens is deprecated in o-series and gpt-5+
  if (body.max_tokens !== undefined) {
    req.max_completion_tokens = body.max_tokens
  }

  if (body.temperature !== undefined) req.temperature = body.temperature
  if (body.top_p !== undefined) req.top_p = body.top_p
  if (body.stream !== undefined) req.stream = body.stream

  if (body.stop_sequences && body.stop_sequences.length > 0) {
    req.stop = body.stop_sequences
  }

  if (body.tools && body.tools.length > 0) {
    req.tools = body.tools.map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        ...(t.description ? { description: t.description } : {}),
        parameters: t.input_schema,
      },
    }))
  }

  // Intentionally omit: metadata, and any other Anthropic-only fields

  return req
}

// ---------------------------------------------------------------------------
// Response translation
// ---------------------------------------------------------------------------

function mapFinishReason(reason: string): string {
  if (reason === 'stop') return 'end_turn'
  if (reason === 'tool_calls') return 'tool_use'
  if (reason === 'length') return 'max_tokens'
  return 'end_turn'
}

function generateMsgId(): string {
  const uuid = crypto.randomUUID().replace(/-/g, '')
  return 'msg_' + uuid.slice(0, 24)
}

export function translateResponse(body: OpenAIResponse, requestModel: string): AnthropicResponse {
  const choice = body.choices[0]
  const { message, finish_reason } = choice
  const content: AnthropicContentBlock[] = []

  if (message.content) {
    content.push({ type: 'text', text: message.content })
  }

  if (message.tool_calls) {
    for (const tc of message.tool_calls) {
      let parsed: unknown
      try {
        parsed = JSON.parse(tc.function.arguments)
      } catch {
        parsed = {}
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input: parsed,
      })
    }
  }

  return {
    id: generateMsgId(),
    type: 'message',
    role: 'assistant',
    model: requestModel,
    content,
    stop_reason: mapFinishReason(finish_reason),
    stop_sequence: null,
    usage: {
      input_tokens: body.usage?.prompt_tokens ?? 0,
      output_tokens: body.usage?.completion_tokens ?? 0,
    },
  }
}

// ---------------------------------------------------------------------------
// Streaming translation
// ---------------------------------------------------------------------------

interface ToolCallState {
  id: string
  name: string
  argumentsAccumulated: string
  blockIndex: number
}

export class StreamTranslator {
  private messageId: string
  private requestModel: string
  private textBlockOpen = false
  private textBlockIndex = 0
  private toolCallStates = new Map<number, ToolCallState>()
  private currentBlockIndex = 0
  private inputTokens = 0
  private outputTokens = 0
  private started = false

  constructor(requestModel: string) {
    this.requestModel = requestModel
    this.messageId = generateMsgId()
  }

  feed(chunk: OpenAIDelta): AnthropicSSEEvent[] {
    const events: AnthropicSSEEvent[] = []
    const choices = chunk.choices
    if (!choices || choices.length === 0) return events

    const choice = choices[0]
    const { delta, finish_reason } = choice

    // Track usage if present
    if (chunk.usage) {
      this.inputTokens = chunk.usage.prompt_tokens
      this.outputTokens = chunk.usage.completion_tokens
    }

    // First chunk: emit message_start + content_block_start (text)
    if (!this.started && delta.role === 'assistant') {
      this.started = true
      events.push({
        event: 'message_start',
        data: {
          type: 'message_start',
          message: {
            id: this.messageId,
            type: 'message',
            role: 'assistant',
            content: [],
            model: this.requestModel,
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: this.inputTokens, output_tokens: 0 },
          },
        },
      })
      events.push({
        event: 'content_block_start',
        data: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: '' },
        },
      })
      this.textBlockOpen = true
      this.textBlockIndex = 0
      this.currentBlockIndex = 0
    }

    // Text delta
    if (delta.content) {
      if (!this.started) {
        // Edge case: content before role seen
        this.started = true
        events.push({
          event: 'message_start',
          data: {
            type: 'message_start',
            message: {
              id: this.messageId,
              type: 'message',
              role: 'assistant',
              content: [],
              model: this.requestModel,
              stop_reason: null,
              stop_sequence: null,
              usage: { input_tokens: this.inputTokens, output_tokens: 0 },
            },
          },
        })
        events.push({
          event: 'content_block_start',
          data: {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'text', text: '' },
          },
        })
        this.textBlockOpen = true
        this.textBlockIndex = 0
        this.currentBlockIndex = 0
      }
      events.push({
        event: 'content_block_delta',
        data: {
          type: 'content_block_delta',
          index: this.textBlockIndex,
          delta: { type: 'text_delta', text: delta.content },
        },
      })
    }

    // Tool call deltas
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index

        if (tc.id && tc.function?.name !== undefined) {
          // First appearance of this tool call — open a new block
          if (this.textBlockOpen) {
            events.push({
              event: 'content_block_stop',
              data: { type: 'content_block_stop', index: this.textBlockIndex },
            })
            this.textBlockOpen = false
          }

          this.currentBlockIndex++
          const blockIndex = this.currentBlockIndex

          this.toolCallStates.set(tcIndex, {
            id: tc.id,
            name: tc.function.name,
            argumentsAccumulated: tc.function.arguments ?? '',
            blockIndex,
          })

          events.push({
            event: 'content_block_start',
            data: {
              type: 'content_block_start',
              index: blockIndex,
              content_block: {
                type: 'tool_use',
                id: tc.id,
                name: tc.function.name,
                input: {},
              },
            },
          })

          // If there are already some arguments in this first chunk, emit them
          if (tc.function.arguments) {
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: blockIndex,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              },
            })
          }
        } else if (tc.function?.arguments) {
          // Continuation of arguments
          const state = this.toolCallStates.get(tcIndex)
          if (state) {
            state.argumentsAccumulated += tc.function.arguments
            events.push({
              event: 'content_block_delta',
              data: {
                type: 'content_block_delta',
                index: state.blockIndex,
                delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
              },
            })
          }
        }
      }
    }

    // Finish reason
    if (finish_reason) {
      const stopReason = mapFinishReason(finish_reason)

      // Close open text block
      if (this.textBlockOpen) {
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: this.textBlockIndex },
        })
        this.textBlockOpen = false
      }

      // Close all open tool call blocks
      for (const [, state] of this.toolCallStates) {
        events.push({
          event: 'content_block_stop',
          data: { type: 'content_block_stop', index: state.blockIndex },
        })
      }
      this.toolCallStates.clear()

      events.push({
        event: 'message_delta',
        data: {
          type: 'message_delta',
          delta: { stop_reason: stopReason, stop_sequence: null },
          usage: { output_tokens: this.outputTokens },
        },
      })

      events.push({
        event: 'message_stop',
        data: { type: 'message_stop' },
      })
    }

    return events
  }

  getUsage(): { inputTokens: number; outputTokens: number } {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens }
  }

  finish(): AnthropicSSEEvent[] {
    const events: AnthropicSSEEvent[] = []

    if (this.textBlockOpen) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: this.textBlockIndex },
      })
      this.textBlockOpen = false
    }

    for (const [, state] of this.toolCallStates) {
      events.push({
        event: 'content_block_stop',
        data: { type: 'content_block_stop', index: state.blockIndex },
      })
    }
    this.toolCallStates.clear()

    events.push({
      event: 'message_delta',
      data: {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: { output_tokens: this.outputTokens },
      },
    })

    events.push({
      event: 'message_stop',
      data: { type: 'message_stop' },
    })

    return events
  }
}

export function formatSSE(event: AnthropicSSEEvent): string {
  return `event: ${event.event}\ndata: ${JSON.stringify(event.data)}\n\n`
}
