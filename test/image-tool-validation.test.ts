import { describe, expect, it } from 'vitest'
import type { StreamChunk } from '@deepseek-ai/dsh-llm'
import { validateRequiredImageTool } from '../src/adapter.ts'

const textOnly: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: '已生成图片' },
  { type: 'block-end', index: 0, block: { type: 'text', text: '已生成图片' } },
  { type: 'finish', reason: { kind: 'stop' } },
]
async function* chunks(items: StreamChunk[]): AsyncGenerator<StreamChunk> { yield* items }

async function drain(items: StreamChunk[], required?: string): Promise<StreamChunk[]> {
  const output: StreamChunk[] = []
  for await (const chunk of validateRequiredImageTool(chunks(items), required)) output.push(chunk)
  return output
}

describe('forced image tool completion validation', () => {
  it('withholds a text-only false success instead of publishing it', async () => {
    const received: StreamChunk[] = []
    await expect((async () => {
      for await (const chunk of validateRequiredImageTool(chunks(textOnly), 'edit_image')) received.push(chunk)
    })()).rejects.toThrow('did not call required edit_image')
    expect(received).toEqual([])
  })
  it('passes a real matching call through, and forces nothing on unrelated requests', async () => {
    const call: StreamChunk = { type: 'block-end', index: 1, block: {
      type: 'tool-call', id: 'c' as never, name: 'edit_image', arguments: '{"prompt":"pixel art"}',
    } }
    const result: StreamChunk[] = [call, { type: 'finish', reason: { kind: 'tool-calls' } }]
    expect(await drain(result, 'edit_image')).toEqual(result)
    expect(await drain(textOnly)).toEqual(textOnly)
    await expect(drain(result, 'generate_image')).rejects.toThrow('did not call required generate_image')
  })
  it('passes a provider error finish through instead of inventing an image success', async () => {
    const failed: StreamChunk[] = [{ type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM', message: 'failure' } } }]
    expect(await drain(failed, 'edit_image')).toEqual(failed)
  })
  it('bounds the withheld buffer so an untrusted stream cannot exhaust memory', async () => {
    const huge: StreamChunk[] = [
      { type: 'text-delta', index: 0, text: 'x'.repeat(600_000) },
      { type: 'text-delta', index: 0, text: 'y'.repeat(600_000) },
      { type: 'finish', reason: { kind: 'stop' } },
    ]
    await expect(drain(huge, 'edit_image')).rejects.toThrow('exceeded validation buffer')
  })
})
