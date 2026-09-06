import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { buildPromptsJson, renderSheet, writePrompts } from '../src/prompts.ts'
import { demoConfig, loadDemo, type DemoApp } from './helpers.ts'

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

describe('renderSheet', () => {
  it('matches the shape of the hand-written sheets', async () => {
    const { manifest } = await demo()
    expect(renderSheet(manifest)).toMatchInlineSnapshot(`
      "# 图片提示词 / Hero image prompt sheet

      Generate each image by hand (Gemini app, AI Studio, anything), then **download and save it named by its id**
      (e.g. \`apple.png\`) into the \`incoming-images/\` folder. When done, run \`npx asset-factory import\`
      and every file becomes \`public/images/{id}.webp\`.

      Shared style (already appended to every prompt below):

      > Flat pastel illustration, plain background, no text.

      Total: 3 images.

      ## 水果

      ### 苹果 — save as \`apple\`

      \`\`\`
      A red apple. Flat pastel illustration, plain background, no text.
      \`\`\`

      ### 香蕉 — save as \`banana\`

      \`\`\`
      A yellow banana. Flat pastel illustration, plain background, no text.
      \`\`\`

      ## 蔬菜

      ### 胡萝卜 — save as \`carrot\`

      \`\`\`
      An orange carrot. Flat pastel illustration, plain background, no text.
      \`\`\`
      "
    `)
  })

  it('drops the section headings when no groupField is configured', async () => {
    const { manifest } = await demo({ config: demoConfig({ groupField: undefined }) })
    const sheet = renderSheet(manifest)
    expect(sheet).not.toContain('## 水果')
    expect(sheet).toContain('### 苹果 — save as `apple`')
  })

  it('omits the style block when there is no styleGuide', async () => {
    const { manifest } = await demo({ config: demoConfig({ styleGuide: undefined }) })
    const sheet = renderSheet(manifest)
    expect(sheet).not.toContain('Shared style')
    expect(sheet).toContain('A red apple\n```')
  })

  it('leaves tts items out of the image sheet', async () => {
    const { manifest } = await demo({
      config: demoConfig({
        items: [
          { kind: 'image', outDir: 'public/images', promptField: 'imagePrompt' },
          { kind: 'tts', outDir: 'public/audio', textField: 'intro' },
        ],
      }),
    })
    const sheet = renderSheet(manifest)
    expect(sheet).toContain('Total: 3 images.')
    expect(sheet).not.toContain('红红的苹果')
  })

  it('separates several image groups', async () => {
    const { manifest } = await demo({
      config: demoConfig({
        items: [
          { kind: 'image', name: 'hero', outDir: 'public/hero', promptField: 'imagePrompt' },
          { kind: 'image', name: 'thumb', outDir: 'public/thumb', promptField: 'imagePrompt' },
        ],
      }),
    })
    const sheet = renderSheet(manifest)
    expect(sheet).toContain('# hero → public/hero')
    expect(sheet).toContain('# thumb → public/thumb')
    expect(sheet).toContain('Total: 6 images.')
  })
})

describe('buildPromptsJson', () => {
  it('carries the raw and the fully-styled prompt', async () => {
    const { manifest } = await demo()
    const json = buildPromptsJson(manifest)

    expect(json.app).toBe('demo')
    expect(json.groups).toHaveLength(1)
    expect(json.groups[0]).toMatchObject({ name: 'image', outDir: 'public/images', format: 'webp', count: 3 })
    expect(json.groups[0]!.prompts[0]).toEqual({
      id: 'apple',
      label: '苹果',
      section: '水果',
      rawPrompt: 'A red apple',
      prompt: 'A red apple. Flat pastel illustration, plain background, no text.',
      outFile: join('public', 'images', 'apple.webp'),
    })
  })
})

describe('writePrompts', () => {
  it('writes both artifacts where the config says', async () => {
    const { app, manifest } = await demo()
    const written = await writePrompts(manifest)

    expect(written.count).toBe(3)
    expect(written.sheetPath).toBe(join(app.root, 'image-prompts.md'))
    expect(written.jsonPath).toBe(join(app.root, '.asset-factory', 'prompts.json'))
    await expect(readFile(written.sheetPath, 'utf8')).resolves.toContain('save as `apple`')
    await expect(readFile(written.jsonPath, 'utf8')).resolves.toContain('"rawPrompt": "A red apple"')
  })

  it('is byte-stable across runs so reruns produce no diff', async () => {
    const { manifest } = await demo()
    const first = await writePrompts(manifest)
    const sheet = await readFile(first.sheetPath, 'utf8')
    const json = await readFile(first.jsonPath, 'utf8')

    await writePrompts(manifest)

    await expect(readFile(first.sheetPath, 'utf8')).resolves.toBe(sheet)
    await expect(readFile(first.jsonPath, 'utf8')).resolves.toBe(json)
  })

  it('honours a custom promptSheet path', async () => {
    const { app, manifest } = await demo({ config: demoConfig({ promptSheet: 'docs/prompts.md' }) })
    const written = await writePrompts(manifest)
    expect(written.sheetPath).toBe(join(app.root, 'docs', 'prompts.md'))
    await expect(readFile(written.sheetPath, 'utf8')).resolves.toContain('Total: 3 images.')
  })
})
