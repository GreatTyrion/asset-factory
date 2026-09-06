// Read-only check against the first real consumer. Skipped when the sibling
// checkout is not there, so the suite still runs on its own.
//
// These are invariant checks, not snapshots: the dish count moves as content
// is added (28 → 32 → …) and the style guide is a living recipe, so the
// assertions pin the *shape* of the contract, not today's numbers.

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
  it('reads every dish in foods.ts — no dish is dropped from the manifest', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    const ids = manifest.records.map((r) => r.id)
    // Every historically known dish must still be present…
    for (const id of ['xiaolongbao', 'tanghulu', 'mapo-doufu', 'zongzi']) {
      expect(ids).toContain(id)
    }
    // …and the four dishes added in 2026-09 must be there too.
    for (const id of ['huoguo', 'yangrou-chuan', 'changfen', 'xingren-doufu']) {
      expect(ids).toContain(id)
    }
    // One image asset per dish, keyed by id — the count follows the data.
    const imageIds = manifest.assets.filter((a) => a.kind === 'image').map((a) => a.id)
    expect(imageIds).toHaveLength(ids.length)
    expect(new Set(imageIds)).toEqual(new Set(ids))
  })

  it('composes prompts from the raw record prompt plus the shared hardened style guide', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    const xiaolongbao = manifest.assets.find((a) => a.id === 'xiaolongbao')!

    expect(xiaolongbao.label).toBe('小笼包')
    expect(xiaolongbao.prompt).toContain(xiaolongbao.rawPrompt!)
    // Hardened style guide clauses (the exact wording may keep evolving, so
    // pin the bans that matter, not the whole string).
    for (const clause of ['Absolutely no text', 'no kitchen', 'no bokeh', 'no tableware beyond one simple']) {
      expect(xiaolongbao.prompt).toContain(clause)
    }
    expect(xiaolongbao.relOutFile).toBe(join('public', 'images', 'foods', 'xiaolongbao.webp'))
  })

  it('keeps the sheet grouped by the four categories with a counted total', async () => {
    const manifest = await buildManifest(await loadConfig(GOURMET))
    const sheet = renderSheet(manifest)

    for (const category of ['菜肴', '小吃', '甜品', '点心']) {
      expect(sheet).toContain(`## ${category}`)
    }
    expect(sheet).toMatch(/Total: \d+ images\./)
  })
})
