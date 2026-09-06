import { mkdir, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { audit, formatBytes } from '../src/audit.ts'
import { importImages } from '../src/import-images.ts'
import type { ImageItem } from '../src/config.ts'
import { resolveGroup } from '../src/manifest.ts'
import { loadState, record, saveState } from '../src/state.ts'
import { demoConfig, loadDemo, writeTestImage, type DemoApp } from './helpers.ts'

let apps: DemoApp[] = []

async function demo(options: Parameters<typeof loadDemo>[0] = {}) {
  const result = await loadDemo(options)
  apps.push(result.app)
  return result
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

/** Put real assets on disk the way `import` would. */
async function importIds(demoApp: Awaited<ReturnType<typeof demo>>, ids: string[]) {
  const item = resolveGroup(demoApp.config, 'image') as ImageItem
  const incoming = join(demoApp.app.root, demoApp.config.incomingDir)
  await mkdir(incoming, { recursive: true })
  for (const id of ids) await writeTestImage(join(incoming, `${id}.png`))
  await importImages(demoApp.manifest, item)
}

describe('audit', () => {
  it('reports zero coverage before anything is generated', async () => {
    const app = await demo()
    const report = await audit(app.manifest)

    expect(report).toMatchObject({ app: 'demo', total: 3, present: 0, complete: false })
    expect(report.groups[0]!.missing).toEqual(['apple', 'banana', 'carrot'])
  })

  it('counts what is on disk and names what is not', async () => {
    const app = await demo()
    await importIds(app, ['apple', 'carrot'])

    const report = await audit(app.manifest)
    expect(report).toMatchObject({ total: 3, present: 2, complete: false })
    expect(report.groups[0]!.missing).toEqual(['banana'])
    expect(report.groups[0]!.bytes).toBeGreaterThan(0)
  })

  it('is complete once every asset exists', async () => {
    const app = await demo()
    await importIds(app, ['apple', 'banana', 'carrot'])

    const report = await audit(app.manifest)
    expect(report).toMatchObject({ total: 3, present: 3, complete: true })
    expect(report.groups[0]!.missing).toEqual([])
  })

  it('sums each item group separately', async () => {
    const app = await demo({
      config: demoConfig({
        items: [
          { kind: 'image', outDir: 'public/images', promptField: 'imagePrompt', size: 64 },
          { kind: 'tts', outDir: 'public/audio', textField: 'intro' },
        ],
      }),
    })
    await importIds(app, ['apple'])

    const report = await audit(app.manifest)
    expect(report.total).toBe(6)
    expect(report.present).toBe(1)
    expect(report.groups.map((g) => [g.group, g.present, g.total])).toEqual([
      ['image', 1, 3],
      ['tts', 0, 3],
    ])
  })

  it('flags output files that belong to no record', async () => {
    const app = await demo()
    await importIds(app, ['apple'])
    await writeTestImage(join(app.app.root, 'public', 'images', 'durian.webp'))
    await writeFile(join(app.app.root, 'public', 'images', 'README.md'), 'not an asset', 'utf8')

    const report = await audit(app.manifest)
    expect(report.groups[0]!.orphans).toEqual(['durian.webp'])
  })

  it('surfaces failures a previous run recorded, while the asset is still missing', async () => {
    const app = await demo()
    const banana = app.manifest.assets.find((a) => a.id === 'banana')!
    const state = await loadState(app.app.root)
    record(state, banana, 'failed', 'backend returned no image')
    await saveState(app.app.root, state)

    const report = await audit(app.manifest)
    expect(report.groups[0]!.failed).toEqual([{ id: 'banana', error: 'backend returned no image' }])
  })

  it('trusts the disk over stale state', async () => {
    const app = await demo()
    await importIds(app, ['apple'])
    const apple = app.manifest.assets.find((a) => a.id === 'apple')!

    const state = await loadState(app.app.root)
    record(state, apple, 'done')
    await saveState(app.app.root, state)
    await rm(apple.outFile)

    const report = await audit(app.manifest)
    expect(report.present).toBe(0)
    expect(report.groups[0]!.missing).toContain('apple')
  })

  it('handles an output folder that does not exist yet', async () => {
    const app = await demo()
    const report = await audit(app.manifest)
    expect(report.groups[0]!.orphans).toEqual([])
  })
})

describe('formatBytes', () => {
  it('scales the unit to the magnitude', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2.0 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
  })
})
