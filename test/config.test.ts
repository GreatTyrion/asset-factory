import { rm, writeFile } from 'node:fs/promises'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts'
import { captureUserError, demoConfig, makeDemoApp, type DemoApp } from './helpers.ts'

let apps: DemoApp[] = []

async function app(options: Parameters<typeof makeDemoApp>[0] = {}) {
  const created = await makeDemoApp(options)
  apps.push(created)
  return created
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

describe('loadConfig', () => {
  it('applies documented defaults', async () => {
    const { root } = await app({
      config: {
        name: 'demo',
        dataSource: 'src/data/items.ts',
        items: [{ kind: 'image', outDir: 'public/images', promptField: 'imagePrompt' }],
      },
    })
    const config = await loadConfig(root)

    expect(config.idField).toBe('id')
    expect(config.labelField).toBe('id')
    expect(config.incomingDir).toBe('incoming-images')
    expect(config.promptSheet).toBe('image-prompts.md')
    expect(config.items[0]).toMatchObject({ name: 'image', format: 'webp', size: 768, fit: 'cover', quality: 82 })
  })

  it('finds the config by walking up from a subfolder', async () => {
    const { root } = await app()
    const config = await loadConfig(join(root, 'src', 'data'))
    expect(config.root).toBe(root)
  })

  it('names the missing file when there is no config anywhere', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'asset-factory-empty-'))
    try {
      await expect(loadConfig(empty)).rejects.toThrow(/No factory\.config\.json found/)
      await expect(loadConfig(empty)).rejects.toMatchObject({ hint: expect.stringContaining('asset-factory init') })
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('reports malformed JSON instead of crashing', async () => {
    const { root } = await app({ rawConfig: '{ "name": "demo", }' })
    await expect(loadConfig(root)).rejects.toThrow(/is not valid JSON/)
  })

  it('lists every schema violation with its path', async () => {
    const { root } = await app({
      config: { dataSource: 'src/data/items.ts', items: [{ kind: 'video', outDir: 'x' }], nope: 1 },
    })
    const error = await captureUserError(loadConfig(root))

    expect(error.message).toContain('missing required field "name"')
    expect(error.message).toContain('unknown field "nope"')
    expect(error.message).toContain('items[0].kind: must be one of "image", "tts"')
  })

  it('says which kind-specific field an item is missing', async () => {
    const { root } = await app({
      config: demoConfig({ items: [{ kind: 'image', outDir: 'public/images' }] }),
    })
    await expect(loadConfig(root)).rejects.toThrow(/kind "image" but no "promptField"/)

    const tts = await app({ config: demoConfig({ items: [{ kind: 'tts', outDir: 'public/audio' }] }) })
    await expect(loadConfig(tts.root)).rejects.toThrow(/kind "tts" but no "textField"/)
  })

  it('rejects two item groups sharing a name', async () => {
    const { root } = await app({
      config: demoConfig({
        items: [
          { kind: 'image', outDir: 'a', promptField: 'imagePrompt' },
          { kind: 'image', outDir: 'b', promptField: 'imagePrompt' },
        ],
      }),
    })
    await expect(loadConfig(root)).rejects.toThrow(/both named "image"/)
  })

  it('rejects an absolute dataSource', async () => {
    const { root } = await app({ config: demoConfig({ dataSource: '/etc/items.ts' }) })
    await expect(loadConfig(root)).rejects.toThrow(/must be relative to the app root/)
  })

  it('accepts an explicit config file path', async () => {
    const { root, configFile } = await app()
    await writeFile(join(root, 'unused.txt'), '', 'utf8')
    const config = await loadConfig(configFile)
    expect(config.file).toBe(configFile)
    expect(config.name).toBe('demo')
  })

  it('keeps the shipped schema itself loadable', async () => {
    const { root } = await app({ config: demoConfig({ $schema: '../asset-factory/factory.config.schema.json' }) })
    await expect(loadConfig(root)).resolves.toMatchObject({ name: 'demo' })
  })
})

describe('config filename', () => {
  it('is the name the docs promise', () => {
    expect(CONFIG_FILENAME).toBe('factory.config.json')
  })
})
