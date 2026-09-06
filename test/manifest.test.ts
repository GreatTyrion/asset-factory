import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { loadConfig } from '../src/config.ts'
import type { UserError } from '../src/log.ts'
import { buildManifest, buildPrompt, resolveGroup } from '../src/manifest.ts'
import { DEMO_RECORDS, DEMO_STYLE, captureUserError, demoConfig, makeDemoApp, type DemoApp } from './helpers.ts'

let apps: DemoApp[] = []

async function build(options: Parameters<typeof makeDemoApp>[0] = {}) {
  const app = await makeDemoApp(options)
  apps.push(app)
  const config = await loadConfig(app.root)
  return { app, config, manifest: await buildManifest(config) }
}

async function buildFails(options: Parameters<typeof makeDemoApp>[0]): Promise<UserError> {
  const app = await makeDemoApp(options)
  apps.push(app)
  const config = await loadConfig(app.root)
  return captureUserError(buildManifest(config))
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

describe('buildManifest', () => {
  it('expands one asset per record per item', async () => {
    const { manifest } = await build({
      config: demoConfig({
        items: [
          { kind: 'image', outDir: 'public/images', promptField: 'imagePrompt', size: 64 },
          { kind: 'tts', outDir: 'public/audio', textField: 'intro', voice: 'zh-CN-XiaoxiaoNeural' },
        ],
      }),
    })

    expect(manifest.assets).toHaveLength(DEMO_RECORDS.length * 2)
    expect(manifest.assets.filter((a) => a.kind === 'image')).toHaveLength(3)
    expect(manifest.assets.filter((a) => a.kind === 'tts')).toHaveLength(3)
  })

  it('carries label, section and output path through from the data module', async () => {
    const { app, manifest } = await build()
    const apple = manifest.assets.find((a) => a.id === 'apple')!

    expect(apple.label).toBe('苹果')
    expect(apple.section).toBe('水果')
    expect(apple.relOutFile).toBe(join('public', 'images', 'apple.webp'))
    expect(apple.outFile).toBe(join(app.root, 'public', 'images', 'apple.webp'))
  })

  it('appends the shared style to every image prompt', async () => {
    const { manifest } = await build()
    const apple = manifest.assets.find((a) => a.id === 'apple')!

    expect(apple.rawPrompt).toBe('A red apple')
    expect(apple.prompt).toBe(`A red apple. ${DEMO_STYLE}`)
    expect(buildPrompt('A red apple', undefined)).toBe('A red apple')
  })

  it('gives tts assets the voice and language from their item', async () => {
    const { manifest } = await build({
      config: demoConfig({
        items: [{ kind: 'tts', outDir: 'public/audio', textField: 'intro', lang: 'zh-CN', voice: 'zh-CN-YunxiNeural' }],
      }),
    })
    expect(manifest.assets[0]).toMatchObject({
      kind: 'tts',
      text: '红红的苹果。',
      lang: 'zh-CN',
      voice: 'zh-CN-YunxiNeural',
      relOutFile: join('public', 'audio', 'apple.mp3'),
    })
  })

  it('names the record, the field and the item when data does not match config', async () => {
    const error = await buildFails({
      dataModule: `export const ITEMS = [{ id: 'apple', name: '苹果', category: '水果', intro: 'x' }]\n`,
    })
    expect(error.message).toContain('src/data/items.ts[0]')
    expect(error.message).toContain('(id="apple")')
    expect(error.message).toContain('missing "imagePrompt"')
  })

  it('flags records with no id', async () => {
    const error = await buildFails({
      dataModule: `export const ITEMS = [{ name: '苹果', imagePrompt: 'x', category: 'y', intro: 'z' }]\n`,
    })
    expect(error.message).toContain('missing "id" (the id field)')
  })

  it('flags duplicate ids, which would silently overwrite a file', async () => {
    const error = await buildFails({
      dataModule:
        `export const ITEMS = [\n` +
        `  { id: 'apple', name: 'a', category: 'c', imagePrompt: 'p', intro: 'i' },\n` +
        `  { id: 'apple', name: 'b', category: 'c', imagePrompt: 'p', intro: 'i' },\n` +
        `]\n`,
    })
    expect(error.message).toContain('duplicate id "apple"')
  })

  it('treats a blank field as missing', async () => {
    const error = await buildFails({
      dataModule: `export const ITEMS = [{ id: 'apple', name: 'a', category: 'c', imagePrompt: '   ', intro: 'i' }]\n`,
    })
    expect(error.message).toContain('missing "imagePrompt"')
  })

  it('points at the config when the data module is not there', async () => {
    const app = await makeDemoApp({ config: demoConfig({ dataSource: 'src/data/nope.ts' }) })
    apps.push(app)
    const config = await loadConfig(app.root)
    await expect(buildManifest(config)).rejects.toThrow(/Data source not found/)
  })

  it('lists the available exports when dataExport is wrong', async () => {
    const error = await buildFails({ config: demoConfig({ dataExport: 'FOODS' }) })
    expect(error.message).toContain('no exported array named "FOODS"')
    expect(error.hint).toContain('ITEMS')
  })

  it('falls back to the only exported array', async () => {
    const { manifest } = await build({ config: demoConfig({ dataExport: undefined }) })
    expect(manifest.assets).toHaveLength(3)
  })

  it('uses the default export when there is one', async () => {
    const { manifest } = await build({
      config: demoConfig({ dataExport: undefined }),
      dataModule: `export default [{ id: 'apple', name: 'a', category: 'c', imagePrompt: 'p', intro: 'i' }]\n`,
    })
    expect(manifest.assets).toHaveLength(1)
  })

  it('refuses to guess between several exported arrays', async () => {
    const error = await buildFails({
      config: demoConfig({ dataExport: undefined }),
      dataModule:
        `export const ITEMS = [{ id: 'apple', name: 'a', category: 'c', imagePrompt: 'p', intro: 'i' }]\n` +
        `export const OTHER = [1, 2]\n`,
    })
    expect(error.message).toContain('exports several arrays')
    expect(error.hint).toContain('dataExport')
  })

  it('rejects an empty data array', async () => {
    const error = await buildFails({ dataModule: `export const ITEMS = []\n` })
    expect(error.message).toContain('empty array')
  })
})

describe('resolveGroup', () => {
  const twoImages = demoConfig({
    items: [
      { kind: 'image', name: 'hero', outDir: 'public/hero', promptField: 'imagePrompt' },
      { kind: 'image', name: 'thumb', outDir: 'public/thumb', promptField: 'imagePrompt' },
    ],
  })

  it('picks the only group of that kind', async () => {
    const { config } = await build()
    expect(resolveGroup(config, 'image').name).toBe('image')
  })

  it('asks for --group instead of guessing', async () => {
    const { config } = await build({ config: twoImages })
    expect(() => resolveGroup(config, 'image')).toThrow(/ambiguous/)
    expect(() => resolveGroup(config, 'image')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('--group <name>') }),
    )
  })

  it('honours an explicit group', async () => {
    const { config } = await build({ config: twoImages })
    expect(resolveGroup(config, 'image', 'thumb').outDir).toBe('public/thumb')
  })

  it('lists the real groups when the name is unknown', async () => {
    const { config } = await build({ config: twoImages })
    expect(() => resolveGroup(config, 'image', 'nope')).toThrow(/No item group named "nope"/)
    expect(() => resolveGroup(config, 'image', 'nope')).toThrow(
      expect.objectContaining({ hint: expect.stringContaining('hero (image), thumb (image)') }),
    )
  })

  it('refuses a group of the wrong kind', async () => {
    const { config } = await build()
    expect(() => resolveGroup(config, 'tts', 'image')).toThrow(/has kind "image", but this command needs kind "tts"/)
  })

  it('suggests adding an item when the kind is absent', async () => {
    const { config } = await build()
    expect(() => resolveGroup(config, 'tts')).toThrow(/declares no item of kind "tts"/)
  })
})
