import { afterEach, describe, expect, it, vi } from 'vitest'
import type { AttachmentMeta, AttachmentReadResult } from '@samugen/platform'
import { createFilesSkill } from '../src/renderer/ai/files-skill'
import { setDocsPlatform, type DocsPlatform } from '../src/renderer/platform'

const ATT: AttachmentMeta = {
  ref: '/tmp/notes.md',
  name: 'notes.md',
  ext: 'md',
  sizeBytes: 2048,
}

/**
 * Install a platform whose only real member is the one the skill uses. The slot
 * is typed, so the cast stands in for the rest of the composition rather than
 * stubbing it: a capability this skill does not consume is never reached.
 */
function mockPlatform(result: AttachmentReadResult) {
  const readAttachment = vi.fn(async () => result)
  setDocsPlatform({ attachments: { readAttachment } } as unknown as DocsPlatform)
  return readAttachment
}

afterEach(() => vi.unstubAllGlobals())

describe('files skill', () => {
  it('lists attachments in the per-turn context and stays silent without any', () => {
    const skill = createFilesSkill(() => [ATT])
    expect(skill.buildContext?.()).toContain('notes.md')
    expect(skill.buildContext?.()).toContain('2KB')
    const empty = createFilesSkill(() => [])
    expect(empty.buildContext?.()).toBe('')
  })

  it('reads a slice and reports paging info', async () => {
    const readAttachment = mockPlatform({
      ok: true,
      name: 'notes.md',
      totalChars: 50_000,
      offset: 0,
      text: 'hello'.repeat(10),
    })
    const skill = createFilesSkill(() => [ATT])
    const result = await skill.executeTool({
      id: 't1',
      name: 'read_attachment',
      input: { index: 0 },
    })
    expect(readAttachment).toHaveBeenCalledWith('/tmp/notes.md', 0, 24_000)
    expect(result.isError).toBeFalsy()
    expect(result.mutated).toBeFalsy()
    expect(result.output).toContain('total characters 50000')
    expect(result.output).toContain('offset=50') // continue hint at slice end
  })

  it('rejects an invalid attachment index without calling IPC', async () => {
    const readAttachment = mockPlatform({ ok: true })
    const skill = createFilesSkill(() => [ATT])
    const result = await skill.executeTool({
      id: 't2',
      name: 'read_attachment',
      input: { index: 5 },
    })
    expect(result.isError).toBe(true)
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('answers image attachments locally without reading text', async () => {
    const readAttachment = mockPlatform({ ok: true })
    const skill = createFilesSkill(() => [
      { ref: '/tmp/photo.png', name: 'photo.png', ext: 'png', sizeBytes: 1024 },
    ])
    const result = await skill.executeTool({
      id: 't-img',
      name: 'read_attachment',
      input: { index: 0 },
    })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('image attachment')
    expect(readAttachment).not.toHaveBeenCalled()
  })

  it('surfaces main-process parse errors as tool errors', async () => {
    mockPlatform({ ok: false, error: 'File exceeds the size limit' })
    const skill = createFilesSkill(() => [ATT])
    const result = await skill.executeTool({
      id: 't3',
      name: 'read_attachment',
      input: { index: 0 },
    })
    expect(result.isError).toBe(true)
    expect(result.output).toContain('size limit')
  })
})
