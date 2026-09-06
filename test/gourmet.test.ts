// Read-only check against the first real consumer. Skipped when the sibling
// checkout is not there, so the suite still runs on its own.

import { existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import { buildManifest } from '../src/manifest.ts'
import { renderSheet } from '../src/prompts.ts'

const GOURMET = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'gourmet')
const available = existsSync(join(GOURMET, 'factory.config.json'))

describe.skipIf(!available)('gourmet (real data)', () => {
  it('reads all 28 dishes straight out of foods.ts', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    expect(manifest.records).toHaveLength(28)
    expect(manifest.assets.filter((a) => a.kind === 'image')).toHaveLength(28)
  })

  it('produces the same prompt text the hand-written sheet used', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    const xiaolongbao = manifest.assets.find((a) => a.id === 'xiaolongbao')!

    expect(xiaolongbao.label).toBe('小笼包')
    expect(xiaolongbao.prompt).toContain(xiaolongbao.rawPrompt!)
    expect(xiaolongbao.prompt).toContain('No text, no letters, no words, no watermark, no hands, no people.')
    expect(xiaolongbao.relOutFile).toBe(join('public', 'images', 'foods', 'xiaolongbao.webp'))
  })

  it('keeps the sheet grouped by the four categories', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    const sheet = renderSheet(manifest)

    for (const category of ['菜肴', '小吃', '甜品', '点心']) {
      expect(sheet).toContain(`## ${category}`)
    }
    expect(sheet).toContain('Total: 28 images.')
  })
})
