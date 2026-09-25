/**
 * Serialize harness messages into gateway chat completions. User text is
 * joined; assistant text becomes `content`, tool calls become `tool_calls`,
 * and tool-role messages pass through as tool messages. Assistant reasoning
 * is replayed as `reasoning_content` only on tool-call turns, as required by
 * DeepSeek-family upstreams (other OpenAI-compatible upstreams ignore the
 * field). Verified vision routes serialize user and tool-result images as
 * OpenAI `image_url` data URIs, bounded by the route's own request-image
 * budget; every other image position is rejected rather than silently
 * dropped. Developer messages and `tool-addition`/`tool-removal` blocks are
 * rejected like the official adapter rejects them, because this wire has no
 * projection for them. Unknown declaration-merged block types retain the
 * adapter's documented extension fallback. No reasoning-control fields are
 * emitted: the adapter declares no reasoning efforts, so callers cannot pass one.
 * @module dsh-llm-newapi/serialize
 */
import type { AttachmentStore, ImageAttachmentRef, ImageRequestTarget, RequestImageAttachment } from '@deepseek-ai/dsh-attachment';
import type { GenerateOptions, RequestMessage } from '@deepseek-ai/dsh-llm';
import type { WireMessage, WireRequest } from './types.js';
/**
 * Serialize the conversation. Harness `tool` messages map one-to-one onto the
 * wire's `{role: 'tool'}` messages; user, system, and assistant messages keep
 * their roles, and a request-only user input (no durable identity) serializes
 * exactly like a durable user message.
 * @param messages - the harness conversation or request-only inputs, in order.
 * @param images - prepared request versions for retained images, when the route accepts them.
 * @param toolImageMode - `user-followup` projects tool-produced images into a following user-role message; `off` keeps them as text references only.
 * @returns the wire messages; order preserved.
 */
export declare function serializeMessages(messages: readonly RequestMessage[], images?: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, toolImageMode?: 'off' | 'user-followup'): WireMessage[];
/**
 * The image tool one request's last human message asks for, or `undefined`
 * when the request is not a first-person imperative image task. Deliberately
 * narrow: questions, negated, hypothetical, and past-tense phrasing never
 * trigger it, and a request whose matching tool is not offered never does.
 * @param options - the assembled request (messages, tools).
 * @returns the tool name to force, or `undefined` to leave the choice to the model.
 */
export declare function imageTaskTool(options: GenerateOptions): 'edit_image' | 'generate_image' | undefined;
/**
 * Build the full wire request. Always streaming (`stream: true`, usage
 * reporting on); optional fields are omitted rather than sent as null, so
 * upstream defaults apply — including `max_tokens`, which this adapter has
 * no default for (heterogeneous upstreams each own their cap). An explicit
 * reasoning effort rides as OpenAI-compatible `reasoning_effort`; it only
 * ever arrives for a row whose catalog declares supported efforts.
 * @param options - the harness request (model, history, system, tools, sampling).
 * @param images - prepared request versions for retained images.
 * @param history - the image-projected request inputs; defaults to `options.messages`.
 * @param toolImageMode - `user-followup` enables the tool-image projection.
 * @returns the chat-completions request body.
 */
export declare function serializeRequest(options: GenerateOptions, images?: ReadonlyMap<ImageAttachmentRef['attachmentId'], RequestImageAttachment>, history?: readonly RequestMessage[], toolImageMode?: 'off' | 'user-followup'): WireRequest;
/**
 * The deterministic request version this route asks for: source dimensions
 * scaled into the pixel budget, the longest edge capped, and an encoded-byte
 * target the encoder may reach by lowering quality.
 * @param ref - durable normalized attachment reference.
 * @returns the dimension and byte target for {@link AttachmentStore.readImageRequest}.
 */
export declare function requestImageTarget(ref: ImageAttachmentRef): ImageRequestTarget;
/**
 * Prepare bounded, verified attachment versions before creating image_url data
 * URIs. Offloaded occurrences stay as text on the wire; retained ones are read
 * once per durable attachment id. A request that still exceeds the route
 * budget fails with `IMAGE_OFFLOAD_REQUIRED` naming how many of the oldest
 * occurrences the host must offload before retrying.
 * @param options - the harness request.
 * @param config - capability, attachment service, projection mode, cancellation.
 * @returns the chat-completions body, with verified inline images where retained.
 */
export declare function serializeRequestWithImages(options: GenerateOptions, config: {
    attachments?: AttachmentStore;
    supportsImageInput: boolean;
    toolImageMode?: 'off' | 'user-followup';
    signal?: AbortSignal;
}): Promise<WireRequest>;
