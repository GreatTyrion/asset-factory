import { mkdir, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it } from 'vitest'
import type { ImageItem } from '../src/config.ts'
import { importImages } from '../src/import-images.ts'
import { resolveGroup } from '../src/manifest.ts'
import { demoConfig, loadDemo, writeTestImage, type DemoApp } from './helpers.ts'

// libvips caches decoded files by path within a process; these tests rewrite the
// same drop-folder path in a way a real (one-shot) CLI run never does.
sharp.cache(false)

let apps: DemoApp[] = []

async function demo(options: Parameters<typeof loadDemo>[0] = {}) {
  const result = await loadDemo(options)
  apps.push(result.app)
  const item = resolveGroup(result.config, 'image') as ImageItem
  const incoming = join(result.app.root, result.config.incomingDir)
  await mkdir(incoming, { recursive: true })
  return { ...result, item, incoming }
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

describe('importImages', () => {
  it('converts every matching drop-folder file to the configured format and size', async () => {
    const { app, manifest, item, incoming } = await demo()
    for (const id of ['apple', 'banana', 'carrot']) await writeTestImage(join(incoming, `${id}.png`))

    const result = await importImages(manifest, item)

    expect(result.imported.map((f) => f.id)).toEqual(['apple', 'banana', 'carrot'])
    for (const id of ['apple', 'banana', 'carrot']) {
      const meta = await sharp(join(app.root, 'public', 'images', `${id}.webp`)).metadata()
      expect(meta).toMatchObject({ format: 'webp', width: 64, height: 64 })
    }
  })

  it('reports the real byte size of what it wrote', async () => {
    const { manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'))

    const [file] = (await importImages(manifest, item)).imported
    expect(file!.bytes).toBeGreaterThan(0)
    expect(file!.outFile).toBe(join('public', 'images', 'apple.webp'))
  })

  it('accepts any common image extension', async () => {
    const { manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'))
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#123456' } })
      .jpeg()
      .toFile(join(incoming, 'banana.jpg'))
    await sharp({ create: { width: 100, height: 100, channels: 3, background: '#654321' } })
      .webp()
      .toFile(join(incoming, 'carrot.webp'))

    const result = await importImages(manifest, item)
    expect(result.imported.map((f) => f.id)).toEqual(['apple', 'banana', 'carrot'])
    expect(result.unmatched).toEqual([])
  })

  it('lists files whose name matches no record instead of importing them', async () => {
    const { manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'))
    await writeTestImage(join(incoming, 'durian.png'))

    const result = await importImages(manifest, item)
    expect(result.imported.map((f) => f.id)).toEqual(['apple'])
    expect(result.unmatched).toEqual(['durian.png'])
  })

  it('ignores non-image files sitting in the drop folder', async () => {
    const { manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'))
    await writeFile(join(incoming, 'notes.txt'), 'hello', 'utf8')
    await writeFile(join(incoming, '.DS_Store'), '', 'utf8')

    const result = await importImages(manifest, item)
    expect(result.imported.map((f) => f.id)).toEqual(['apple'])
    expect(result.unmatched).toEqual([])
  })

  it('re-converts by default so a redrawn image replaces the old one', async () => {
    const { app, manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'), 200, { r: 10, g: 10, b: 10 })
    await importImages(manifest, item)
    const dark = await sharp(join(app.root, 'public', 'images', 'apple.webp')).stats()

    await rm(join(incoming, 'apple.png'))
    await writeTestImage(join(incoming, 'apple.png'), 200, { r: 250, g: 250, b: 250 })
    await importImages(manifest, item)
    const light = await sharp(join(app.root, 'public', 'images', 'apple.webp')).stats()

    expect(light.channels[0]!.mean).toBeGreaterThan(dark.channels[0]!.mean + 100)
  })

  it('leaves existing assets alone with skipExisting', async () => {
    const { manifest, item, incoming } = await demo()
    await writeTestImage(join(incoming, 'apple.png'))
    await importImages(manifest, item)

    const second = await importImages(manifest, item, { skipExisting: true })
    expect(second.imported).toEqual([])
    expect(second.skipped).toEqual(['apple'])
  })

  it('honours an id allow-list', async () => {
    const { app, manifest, item, incoming } = await demo()
    for (const id of ['apple', 'banana']) await writeTestImage(join(incoming, `${id}.png`))

    const result = await importImages(manifest, item, { only: ['banana'] })
    expect(result.imported.map((f) => f.id)).toEqual(['banana'])
    expect(existsSync(join(app.root, 'public', 'images', 'apple.webp'))).toBe(false)
  })

  it('honours a non-default format', async () => {
    const { app, manifest, item, incoming } = await demo({
      config: demoConfig({
        items: [{ kind: 'image', outDir: 'public/images', promptField: 'imagePrompt', format: 'png', size: 32 }],
      }),
    })
    await writeTestImage(join(incoming, 'apple.png'))
    await importImages(manifest, item)

    const meta = await sharp(join(app.root, 'public', 'images', 'apple.png')).metadata()
    expect(meta).toMatchObject({ format: 'png', width: 32, height: 32 })
  })

  it('creates the drop folder and explains what to put in it', async () => {
    const { app, manifest, item } = await demo()
    await rm(join(app.root, 'incoming-images'), { recursive: true, force: true })

    await expect(importImages(manifest, item)).rejects.toThrow(/Drop folder was empty/)
    expect(existsSync(join(app.root, 'incoming-images'))).toBe(true)
  })
})
