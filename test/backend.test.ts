// Image backend contract tests. The ComfyUI adapter was removed after the
// SDXL route was rejected (see PLAN §5 gate record); gemini (production) and
// manual (prompt-sheet) are the remaining backends. Gemini behavior is also
// exercised end-to-end in real runs; these tests pin the unit contract.

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { GeminiAdapter } from '../src/backend/gemini.ts'
import { ManualAdapter } from '../src/backend/manual.ts'
import { allowedBackends, isBackendName, type GenerateItem } from '../src/backend/types.ts'
import { seedFor } from '../src/generate.ts'

function item(overrides: Partial<GenerateItem> = {}): GenerateItem {
  return {
    id: 'apple',
    prompt: 'A red apple',
    outFile: join(tmpdir(), 'af-test-out.png'),
    seed: seedFor('apple'),
    ...overrides,
  }
}

describe('backend registry', () => {
  it('exposes gemini and manual only (comfy was removed)', () => {
    expect(allowedBackends()).toBe('gemini, manual')
    expect(isBackendName('gemini')).toBe(true)
    expect(isBackendName('manual')).toBe(true)
    expect(isBackendName('comfy')).toBe(false)
  })
})

describe('gemini backend', () => {
  it('skips when the destination already exists, without calling the API', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af-gemini-'))
    try {
      const outFile = join(dir, 'exists.png')
      await writeFile(outFile, 'already there')
      let called = false
      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        generateContent: async () => {
          called = true
          return { bytes: Buffer.from('nope') }
        },
      })
      const result = await adapter.generate(item({ outFile }))
      expect(result.skipped).toBe(true)
      expect(called).toBe(false)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('calls the API and writes the returned bytes when the file is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'af-gemini-'))
    try {
      const outFile = join(dir, 'new.png')
      let seenPrompt = ''
      const adapter = new GeminiAdapter({
        apiKey: 'test-key',
        generateContent: async (prompt: string) => {
          seenPrompt = prompt
          return { bytes: Buffer.from('fake-png-bytes') }
        },
      })
      const result = await adapter.generate(item({ outFile }))
      expect(result.skipped).toBeUndefined()
      expect(seenPrompt).toBe('A red apple')
      const written = await import('node:fs/promises').then((fs) => fs.readFile(outFile, 'utf8'))
      expect(written).toBe('fake-png-bytes')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('refuses to run without an API key', async () => {
    const adapter = new GeminiAdapter({ apiKey: '' })
    await expect(adapter.generate(item())).rejects.toThrow(/GEMINI_API_KEY/)
  })
})

describe('manual backend', () => {
  it('never invents images: every item is reported skipped', async () => {
    const adapter = new ManualAdapter()
    expect(adapter.name).toBe('manual')
    const result = await adapter.generate(item())
    expect(result.skipped).toBe(true)
  })
})

describe('seedFor', () => {
  it('is stable for a given id and different across dishes', () => {
    expect(seedFor('xiaolongbao')).toBe(seedFor('xiaolongbao'))
    expect(seedFor('xiaolongbao')).not.toBe(seedFor('mapo-doufu'))
    expect(seedFor('xiaolongbao')).toBeGreaterThan(0)
  })
})
