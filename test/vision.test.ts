import { describe, expect, it, vi } from 'vitest'
import type { AttachmentStore, ImageAttachmentRef, RequestImageAttachment } from '@deepseek-ai/dsh-attachment'
import type { GenerateOptions, Message, RequestMessage, ToolResultMessage, UserMessage } from '@deepseek-ai/dsh-llm'
import { imageTaskTool, serializeMessages, serializeRequestWithImages } from '../src/serialize.ts'

const image: ImageAttachmentRef = {
  attachmentId: 'sha256:test' as ImageAttachmentRef['attachmentId'],
  mediaType: 'image/png', bytes: 4, width: 2, height: 2,
}
const version: RequestImageAttachment = {
  variantId: 'test' as RequestImageAttachment['variantId'], attachment: image,
  data: new Uint8Array([1, 2, 3, 4]), mediaType: 'image/png', bytes: 4,
  width: 2, height: 2, depth: 'uchar', space: 'srgb', hasAlpha: false,
}

/** A durable user message: `source.kind === 'user'` is what marks a human turn. */
const user = (content: Message['content']): UserMessage =>
  ({ id: 'user-1', role: 'user', content, source: { kind: 'user' } }) as UserMessage
/** A durable tool message, the 0.1.7 shape tool results arrive in. */
const tool = (content: Message['content']): ToolResultMessage =>
  ({ id: 'tool-1', role: 'tool', content, source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1' }) as unknown as ToolResultMessage
const assistant = (content: Message['content']): Message =>
  ({ id: 'assistant-1', role: 'assistant', content, source: { kind: 'model', provider: 'newapi-images', model: 'vision' } }) as unknown as Message
const request = (messages: RequestMessage[]): GenerateOptions =>
  ({ provider: 'newapi-images', model: 'vision', messages: messages as RequestMessage[] })
const attachments = { readImageRequest: vi.fn(async () => version) } as unknown as AttachmentStore

const send = (messages: RequestMessage[], enabled = true, toolImageMode: 'off' | 'user-followup' = 'off') =>
  serializeRequestWithImages(request(messages), { attachments, supportsImageInput: enabled, toolImageMode })

describe('NewAPI image projection (DSH 0.1.7)', () => {
  it('encodes verified request bytes as an OpenAI image_url part after its handle', async () => {
    const body = await send([user([
      { type: 'text', text: 'before' }, { type: 'image', attachment: image }, { type: 'text', text: 'after' },
    ])])
    const parts = body.messages[0]
    expect(parts.role).toBe('user')
    expect(parts.content).toEqual([
      { type: 'text', text: 'before' },
      expect.objectContaining({ type: 'text', text: expect.stringContaining('sha256:test') }),
      { type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' } },
      { type: 'text', text: 'after' },
    ])
    expect(attachments.readImageRequest).toHaveBeenCalledWith(image, { width: 2, height: 2, maxBytes: 1_048_576 }, undefined)
  })

  it('reads a shared attachment once while keeping every occurrence', async () => {
    vi.mocked(attachments.readImageRequest).mockClear()
    const body = await send([user([{ type: 'image', attachment: image }, { type: 'image', attachment: image }])])
    expect(vi.mocked(attachments.readImageRequest)).toHaveBeenCalledTimes(1)
    const parts = body.messages[0]
    expect(Array.isArray(parts.content)
      && parts.content.filter(part => part.type === 'image_url')).toHaveLength(2)
  })

  it('keeps tool results text-only and references their image durably', async () => {
    const body = await send([tool([{ type: 'text', text: 'done' }, { type: 'image', attachment: image }])])
    const message = body.messages[0]
    expect(message).toEqual({
      role: 'tool',
      tool_call_id: 'call-1',
      content: expect.stringContaining('attachment ID: sha256:test'),
    })
  })

  it('repeats a tool image as a following user-role occurrence only in user-followup mode', async () => {
    const follows = await send([tool([{ type: 'image', attachment: image }]), assistant([{ type: 'text', text: 'ok' }])], true, 'user-followup')
    expect(follows.messages.map(entry => entry.role)).toEqual(['tool', 'user', 'assistant'])
    const followup = follows.messages[1]
    expect(Array.isArray(followup.content) && followup.content.at(-1)).toEqual({
      type: 'image_url', image_url: { url: 'data:image/png;base64,AQIDBA==' },
    })
    const off = await send([tool([{ type: 'image', attachment: image }]), assistant([{ type: 'text', text: 'ok' }])])
    expect(off.messages.map(entry => entry.role)).toEqual(['tool', 'assistant'])
  })

  it('rejects images on a route without verified vision capability or attachment service', async () => {
    await expect(send([user([{ type: 'image', attachment: image }])], false))
      .rejects.toThrow('requires a configured vision model and attachment service')
    await expect(serializeRequestWithImages(request([user([{ type: 'image', attachment: image }])]), {
      supportsImageInput: true,
    })).rejects.toThrow('requires a configured vision model and attachment service')
  })

  it('refuses an image in a role this wire cannot carry', async () => {
    await expect(send([assistant([{ type: 'image', attachment: image }])]))
      .rejects.toThrow('images only in user content and tool results')
  })

  it('keeps text-only requests unchanged and free of prepared versions', async () => {
    vi.mocked(attachments.readImageRequest).mockClear()
    const body = await send([user([{ type: 'text', text: 'hello' }])])
    expect(body.messages).toEqual([{ role: 'user', content: 'hello' }])
    expect(vi.mocked(attachments.readImageRequest)).not.toHaveBeenCalled()
  })
})

describe('explicit image task detection', () => {
  const withTools = (content: Message['content'], names: string[] = ['generate_image', 'edit_image']): GenerateOptions => ({
    ...request([user(content)] as RequestMessage[]),
    tools: names.map(name => ({ name, description: name, parameters: {} })),
  })
  it('selects edit for an attached image and generate for a fresh one', () => {
    expect(imageTaskTool(withTools([{ type: 'image', attachment: image }, { type: 'text', text: '生成这张照片的像素版' }]))).toBe('edit_image')
    expect(imageTaskTool(withTools([{ type: 'text', text: '生成一张像素图' }]))).toBe('generate_image')
  })
  it('never fires for questions, negation, past tense, or an unavailable tool', () => {
    expect(imageTaskTool(withTools([{ type: 'text', text: '如何生成像素图？' }]))).toBeUndefined()
    expect(imageTaskTool(withTools([{ type: 'text', text: '不要生成图片，只解释原理' }]))).toBeUndefined()
    expect(imageTaskTool(withTools([{ type: 'text', text: '我昨天生成了一张像素图' }]))).toBeUndefined()
    expect(imageTaskTool(withTools([{ type: 'text', text: '如果我要生成一张像素图，怎么做？' }]))).toBeUndefined()
    expect(imageTaskTool(withTools([{ type: 'text', text: '生成一张像素图' }], []))).toBeUndefined()
  })
  it('forces the tool on the first step only, then releases the choice', async () => {
    const fresh = withTools([{ type: 'image', attachment: image }, { type: 'text', text: '生成这张照片的像素版' }])
    const first = await serializeRequestWithImages(fresh, { attachments, supportsImageInput: true })
    expect(first.tool_choice).toEqual({ type: 'function', function: { name: 'edit_image' } })
    expect(first.messages[0]).toEqual({ role: 'system', content: expect.stringContaining('edit_image') })
    const later = await serializeRequestWithImages({ ...fresh, messages: [
      ...fresh.messages,
      assistant([{ type: 'tool-call', id: 'c' as never, name: 'edit_image', arguments: '{}' }]),
      tool([{ type: 'text', text: 'failed' }]),
    ] }, { attachments, supportsImageInput: true })
    expect(later.tool_choice).toBeUndefined()
    expect(later.messages.some(entry => entry.role === 'system' && entry.content.includes('For the current explicit image task'))).toBe(false)
  })
  it('ignores injected plugin and request-only inputs as the human task', () => {
    const injected = { role: 'user', content: [{ type: 'text', text: '生成一张像素图' }] } as RequestMessage
    expect(imageTaskTool({ ...withTools([{ type: 'text', text: 'hi' }]), messages: [injected] })).toBeUndefined()
    const plugin = { id: 'p', role: 'user', content: [{ type: 'text', text: '生成一张像素图' }], source: { kind: 'system-prompt' } } as unknown as RequestMessage
    expect(imageTaskTool({ ...withTools([{ type: 'text', text: 'hi' }]), messages: [plugin] })).toBeUndefined()
  })
})

describe('message vocabulary guards', () => {
  it('rejects developer messages and tool-change blocks', () => {
    const developer = { id: 'd', role: 'developer', content: [{ type: 'text', text: 'x' }] } as unknown as RequestMessage
    expect(() => serializeMessages([developer])).toThrow('does not support developer messages')
    const changes = user([{ type: 'tool-addition', tool: { name: 't', description: '', parameters: {} } } as never])
    expect(() => serializeMessages([changes])).toThrow('does not support tool-change blocks')
  })
  it('replays assistant reasoning only on tool-call turns', () => {
    expect(serializeMessages([assistant([
      { type: 'reasoning', text: 'think' }, { type: 'text', text: 'answer' },
    ])])[0]).toEqual({ role: 'assistant', content: 'answer' })
    const call = serializeMessages([assistant([
      { type: 'reasoning', text: 'think' }, { type: 'tool-call', id: 'c' as never, name: 'edit_image', arguments: '{}' },
    ])])[0]
    expect(call).toMatchObject({ reasoning_content: 'think', content: '' })
  })
})
