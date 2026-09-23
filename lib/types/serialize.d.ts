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
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { WireMessage, WireRequest } from './types.js';
/**
 * Serialize the conversation. Harness `tool` messages map one-to-one onto the
 * wire's `{role: 'tool'}` messages; user, system, and assistant messages keep
 * their roles, and a request-only user input (no durable identity) serializes
 * exactly like a durable user message.
 * @param messages - the harness conversation or request-only inputs, in order.
 * @returns the wire messages; order preserved.
 */
export declare function serializeMessages(messages: readonly RequestMessage[]): WireMessage[];
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
export declare function serializeRequest(options: GenerateOptions): WireRequest;
