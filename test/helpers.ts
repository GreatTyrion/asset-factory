// Each test gets a throwaway copy of a miniature app so runs never share state
// and never touch a real project.

import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { CONFIG_FILENAME, loadConfig, type FactoryConfig } from '../src/config.ts'
import { UserError } from '../src/log.ts'
import { buildManifest, type Manifest } from '../src/manifest.ts'

/** Await a call that must fail with a UserError, and hand back the error itself. */
export async function captureUserError(promise: Promise<unknown>): Promise<UserError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof UserError) return err
    throw err
  }
  throw new Error('Expected a UserError, but the call succeeded.')
}

export const DEMO_STYLE = 'Flat pastel illustration, plain background, no text.'

export const DEMO_RECORDS = [
  { id: 'apple', name: '苹果', category: '水果', imagePrompt: 'A red apple', intro: '红红的苹果。' },
  { id: 'banana', name: '香蕉', category: '水果', imagePrompt: 'A yellow banana', intro: '弯弯的香蕉。' },
  { id: 'carrot', name: '胡萝卜', category: '蔬菜', imagePrompt: 'An orange carrot', intro: '脆脆的胡萝卜。' },
]

export function demoConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    name: 'demo',
    dataSource: 'src/data/items.ts',
    dataExport: 'ITEMS',
    idField: 'id',
    labelField: 'name',
    groupField: 'category',
    incomingDir: 'incoming-images',
    styleGuide: DEMO_STYLE,
    items: [{ kind: 'image', outDir: 'public/images', promptField: 'imagePrompt', format: 'webp', size: 64 }],
    ...overrides,
  }
}

export interface DemoApp {
  root: string
  configFile: string
  cleanup: () => Promise<void>
}

export interface DemoOptions {
  config?: Record<string, unknown>
  /** Raw text of src/data/items.ts; defaults to a module exporting DEMO_RECORDS. */
  dataModule?: string
  /** Raw text of factory.config.json, for testing malformed configs. */
  rawConfig?: string
}

export async function makeDemoApp(options: DemoOptions = {}): Promise<DemoApp> {
  const root = await mkdtemp(join(tmpdir(), 'asset-factory-test-'))
  await mkdir(join(root, 'src', 'data'), { recursive: true })

  const dataModule =
    options.dataModule ??
    `interface Item { id: string; name: string; category: string; imagePrompt: string; intro: string }\n` +
      `export const ITEMS: Item[] = ${JSON.stringify(DEMO_RECORDS, null, 2)}\n`
  await writeFile(join(root, 'src', 'data', 'items.ts'), dataModule, 'utf8')

  const configFile = join(root, CONFIG_FILENAME)
  await writeFile(
    configFile,
    options.rawConfig ?? `${JSON.stringify(options.config ?? demoConfig(), null, 2)}\n`,
    'utf8',
  )

  return { root, configFile, cleanup: () => rm(root, { recursive: true, force: true }) }
}

export async function loadDemo(options: DemoOptions = {}): Promise<{
  app: DemoApp
  config: FactoryConfig
  manifest: Manifest
}> {
  const app = await makeDemoApp(options)
  const config = await loadConfig(app.root)
  const manifest = await buildManifest(config)
  return { app, config, manifest }
}

/** Write a solid-color PNG so import tests exercise real sharp decoding. */
export async function writeTestImage(file: string, size = 200, color = { r: 200, g: 40, b: 40 }): Promise<void> {
  await sharp({ create: { width: size, height: Math.round(size * 0.75), channels: 3, background: color } })
    .png()
    .toFile(file)
}
