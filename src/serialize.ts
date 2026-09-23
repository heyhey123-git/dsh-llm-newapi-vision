/**
 * Serialize harness messages into gateway chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool-role messages pass through as tool messages. Assistant reasoning
 * is replayed as `reasoning_content` only on tool-call turns, as required by
 * DeepSeek-family upstreams (other OpenAI-compatible upstreams ignore the
 * field). Core image blocks are rejected explicitly because this wire route
 * is text-only; developer tool-change blocks are rejected like the official
 * adapter rejects them, because this wire has no projection for them. Unknown
 * declaration-merged block types retain the adapter's documented extension
 * fallback. No reasoning-control fields are emitted: the adapter declares no
 * reasoning efforts, so callers cannot pass one.
 * @module dsh-llm-newapi/serialize
 */

import { contentHasImage, LlmError } from '@deepseek-ai/dsh-llm'
import type { AssistantMessage, ContentBlock, GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm'
import type { WireMessage, WireRequest, WireTool } from './types.ts'

/** Join the text blocks of a message (used for user/tool content). */
function flattenText(blocks: readonly ContentBlock[]): string {
  return blocks
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

/** Reject core image content before any text-flattening path can silently erase it. */
function assertTextOnly(blocks: readonly ContentBlock[]): void {
  if (contentHasImage(blocks)) {
    throw new LlmError('The NewAPI chat-completions adapter does not support image content.', 'UNSUPPORTED_CONTENT')
  }
}

/** Serialize one assistant message (text + reasoning + tool calls). */
function serializeAssistant(message: AssistantMessage): WireMessage {
  const text = flattenText(message.content)
  const reasoning = message.content
    .filter(block => block.type === 'reasoning')
    .map(block => block.text)
    .join('')
  const toolCalls = message.content
    .filter(block => block.type === 'tool-call')
    .map(block => ({
      id: block.id,
      type: 'function' as const,
      function: { name: block.name, arguments: block.arguments },
    }))

  return {
    role: 'assistant',
    // Text-less turns send "" — NEVER null. Pure tool-call turns: some
    // gateways reject null outright. Reasoning-ONLY turns (the model can
    // answer entirely in the reasoning channel): the wire API rejects
    // null-content/no-tool_calls assistant messages with a 400, and since
    // the message sits durably in the session log, a null here bricks every
    // later turn of that session.
    content: text,
    // DeepSeek-family upstream passback rule: reasoning_content must return
    // on tool-call turns; it is ignored on plain turns, so we drop it there
    // to save tokens.
    ...toolCalls.length > 0 && reasoning.length > 0 ? { reasoning_content: reasoning } : {},
    ...toolCalls.length > 0 ? { tool_calls: toolCalls } : {},
  }
}

/**
 * Reject block families this wire cannot project: developer messages and the
 * `tool-addition`/`tool-removal` blocks they carry describe dynamic tool
 * inventory changes, which chat completions has no field for. The official
 * DeepSeek adapter rejects them the same way instead of silently dropping
 * them, because a dropped tool change would make the request inconsistent
 * with the model's tool schema.
 * @param message - one harness message or request-only user input.
 */
function assertSupportedBlocks(message: RequestMessage): void {
  if (message.role === 'developer') {
    throw new LlmError('The NewAPI chat-completions adapter does not support developer messages.', 'UNSUPPORTED_CONTENT')
  }
  if (message.content.some(block => block.type === 'tool-addition' || block.type === 'tool-removal')) {
    throw new LlmError('The NewAPI chat-completions adapter does not support tool-change blocks.', 'UNSUPPORTED_CONTENT')
  }
}

/**
 * Serialize the conversation. Harness `tool` messages map one-to-one onto the
 * wire's `{role: 'tool'}` messages; user, system, and assistant messages keep
 * their roles, and a request-only user input (no durable identity) serializes
 * exactly like a durable user message.
 * @param messages - the harness conversation or request-only inputs, in order.
 * @returns the wire messages; order preserved.
 */
export function serializeMessages(messages: readonly RequestMessage[]): WireMessage[] {
  const wire: WireMessage[] = []
  for (const message of messages) {
    assertSupportedBlocks(message)
    assertTextOnly(message.content)
    if (message.role === 'system') {
      wire.push({ role: 'system', content: flattenText(message.content) })
      continue
    }
    if (message.role === 'assistant') {
      wire.push(serializeAssistant(message))
      continue
    }
    if (message.role === 'tool') {
      wire.push({
        role: 'tool',
        tool_call_id: message.toolCallId,
        // Empty tool output still needs SOME content on the wire.
        content: flattenText(message.content) || '(no output)',
      })
      continue
    }
    // Durable user message or request-only user input.
    wire.push({ role: 'user', content: flattenText(message.content) })
  }
  return wire
}

/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * upstream defaults apply — including `max_tokens`, which this adapter has
 * no default for (heterogeneous upstreams each own their cap). An explicit
 * reasoning effort rides as OpenAI-compatible `reasoning_effort`; it only
 * ever arrives for a row whose catalog declares supported efforts.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @returns the chat-completions request body.
 */
export function serializeRequest(options: GenerateOptions): WireRequest {
  const messages: WireMessage[] = []
  if (options.system !== undefined) {
    messages.push({ role: 'system', content: options.system })
  }
  messages.push(...serializeMessages(options.messages))

  const tools: WireTool[] | undefined = options.tools?.map(tool => ({
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  }))

  return {
    model: options.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
    ...tools !== undefined && tools.length > 0 ? { tools } : {},
    ...options.temperature !== undefined ? { temperature: options.temperature } : {},
    ...options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens },
    ...options.reasoningEffort !== undefined ? { reasoning_effort: options.reasoningEffort } : {},
    ...options.stop !== undefined ? { stop: options.stop } : {},
  }
}
