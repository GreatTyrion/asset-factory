// Image backends are the slow, failure-prone step, so the tests pin the
// contract and the two branches users actually hit: ComfyUI not running,
// and Gemini refusing to redo work that is already on disk.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { ComfyAdapter, injectWorkflow, seedFor } from '../src/backend/comfy.ts'
import { GeminiAdapter } from '../src/backend/gemini.ts'
import { ManualAdapter } from '../src/backend/manual.ts'
import type { BackendAdapter, GenerateItem } from '../src/backend/types.ts'
import { generateImages, resolveBackend } from '../src/generate.ts'
import { UserError } from '../src/log.ts'
import { resolveGroup } from '../src/manifest.ts'
import type { ImageItem } from '../src/config.ts'
import { captureUserError, DEMO_STYLE, loadDemo, type DemoApp } from './helpers.ts'

const TINY_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

const SDXL_WORKFLOW = {
  '3': {
    class_type: 'KSampler',
    inputs: {
      seed: 1,
      steps: 30,
      cfg: 7.5,
      sampler_name: 'dpmpp_2m',
      scheduler: 'karras',
      denoise: 1,
      model: ['4', 0],
      positive: ['6', 0],
      negative: ['7', 0],
      latent_image: ['5', 0],
    },
  },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'sd_xl_base_1.0.safetensors' } },
  '5': { class_type: 'EmptyLatentImage', inputs: { width: 1024, height: 1024, batch_size: 1 } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'PLACEHOLDER', clip: ['4', 1] } },
  '7': { class_type: 'CLIPTextEncode', inputs: { text: 'ugly', clip: ['4', 1] } },
  '8': { class_type: 'VAEDecode', inputs: { samples: ['3', 0], vae: ['4', 2] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'sdxl', images: ['8', 0] } },
}

let apps: DemoApp[] = []

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

async function demo() {
  const result = await loadDemo()
  apps.push(result.app)
  const item = resolveGroup(result.config, 'image') as ImageItem
  return { ...result, item }
}

function incomingFile(root: string, id: string): string {
  return join(root, 'incoming-images', `${id}.png`)
}

describe('BackendAdapter contract', () => {
  it('comfy, gemini and manual all expose generate(item, style) → { file }', () => {
    const adapters: BackendAdapter[] = [
      new ComfyAdapter({ baseUrl: 'http://127.0.0.1:9', fetch: async () => new Response('no', { status: 500 }) }),
      new GeminiAdapter({ apiKey: 'test', generateContent: async () => ({ bytes: TINY_PNG }) }),
      new ManualAdapter(),
    ]
    for (const adapter of adapters) {
      expect(typeof adapter.name).toBe('string')
      expect(typeof adapter.generate).toBe('function')
    }
    expect(adapters.map((a) => a.name).sort()).toEqual(['comfy', 'gemini', 'manual'])
  })

  it('generateImages hands each image asset the combined prompt and shared style', async () => {
    const { app, manifest, item } = await demo()
    const calls: { item: GenerateItem; style?: string }[] = []
    const adapter: BackendAdapter = {
      name: 'manual',
      async generate(generateItem, style) {
        calls.push({ item: generateItem, style })
        await mkdir(join(app.root, 'incoming-images'), { recursive: true })
        await writeFile(generateItem.outFile, TINY_PNG)
        return { file: generateItem.outFile }
      },
    }

    const result = await generateImages(manifest, item, adapter)

    expect(result.made).toEqual(['apple', 'banana', 'carrot'])
    expect(calls).toHaveLength(3)
    expect(calls[0]!.item.id).toBe('apple')
    expect(calls[0]!.item.prompt).toContain('A red apple')
    expect(calls[0]!.item.prompt).toContain(DEMO_STYLE)
    expect(calls[0]!.style).toBe(DEMO_STYLE)
    expect(calls[0]!.item.seed).toBe(seedFor('apple'))
    expect(existsSync(incomingFile(app.root, 'apple'))).toBe(true)
  })

  it('resolveBackend rejects an unknown name with the allowed list', () => {
    expect(() => resolveBackend('midjourney')).toThrow(/midjourney/)
    try {
      resolveBackend('midjourney')
    } catch (err) {
      expect(err).toBeInstanceOf(UserError)
      expect((err as UserError).hint ?? (err as UserError).message).toMatch(/comfy/)
      return
    }
    throw new Error('expected resolveBackend to throw')
  })
})

describe('comfy probe', () => {
  it('fails with a launch hint when nothing is listening on the ComfyUI port', async () => {
    const adapter = new ComfyAdapter({ baseUrl: 'http://127.0.0.1:1' })
    const error = await captureUserError(
      adapter.generate(
        { id: 'apple', prompt: 'A red apple', outFile: '/tmp/apple.png', seed: 1 },
        DEMO_STYLE,
      ),
    )
    expect(error.message).toMatch(/ComfyUI|8188|127\.0\.0\.1/)
    expect(error.hint ?? error.message).toMatch(/comfy launch/)
  })

  it('fails with a download command when the server is up but has no checkpoint', async () => {
    const server = await serveComfy({ checkpoints: [] })
    try {
      const adapter = new ComfyAdapter({ baseUrl: server.url })
      const error = await captureUserError(
        adapter.generate(
          { id: 'apple', prompt: 'A red apple', outFile: '/tmp/apple.png', seed: 1 },
          DEMO_STYLE,
        ),
      )
      expect(error.message.toLowerCase()).toMatch(/checkpoint|model/)
      expect(error.hint ?? error.message).toContain('sd_xl_base_1.0.safetensors')
      expect(error.hint ?? error.message).toContain('models/checkpoints')
    } finally {
      await server.close()
    }
  })

  it('injects prompt, seed and filename prefix into an API-format workflow', () => {
    const next = injectWorkflow(
      { _comment: 'not a node', ...SDXL_WORKFLOW },
      {
        prompt: 'A bamboo steamer of xiaolongbao. Kid-friendly food illustration.',
        seed: 12345,
        filenamePrefix: 'xiaolongbao',
      },
    )
    expect(next['6']!.inputs.text).toContain('xiaolongbao')
    expect(next['7']!.inputs.text).not.toContain('xiaolongbao')
    expect(next['3']!.inputs.seed).toBe(12345)
    expect(next['9']!.inputs.filename_prefix).toBe('xiaolongbao')
    expect(next._comment).toBeUndefined()
    expect(SDXL_WORKFLOW['6']!.inputs.text).toBe('PLACEHOLDER')
  })

  it('seedFor is stable for a given id and different across dishes', () => {
    expect(seedFor('xiaolongbao')).toBe(seedFor('xiaolongbao'))
    expect(seedFor('xiaolongbao')).not.toBe(seedFor('mapo-doufu'))
    expect(seedFor('xiaolongbao')).toBeGreaterThan(0)
  })

  it('submits an injected workflow and writes the output image', async () => {
    const { app } = await demo()
    const dest = incomingFile(app.root, 'apple')
    const server = await serveComfy({ checkpoints: ['sd_xl_base_1.0.safetensors'], image: TINY_PNG })
    try {
      const adapter = new ComfyAdapter({ baseUrl: server.url, workflow: SDXL_WORKFLOW })
      const result = await adapter.generate(
        { id: 'apple', prompt: 'A red apple. Flat pastel illustration.', outFile: dest, seed: 99 },
        DEMO_STYLE,
      )
      expect(result.file).toBe(dest)
      expect(await readFile(dest)).toEqual(TINY_PNG)
      expect(server.lastPrompt?.['6']?.inputs.text).toContain('A red apple')
      expect(server.lastPrompt?.['3']?.inputs.seed).toBe(99)
      expect(server.lastPrompt?.['9']?.inputs.filename_prefix).toBe('apple')
    } finally {
      await server.close()
    }
  })
})

describe('gemini skip-existing', () => {
  it('does not call the API for an id that already has an incoming image', async () => {
    const { app, manifest, item } = await demo()
    await mkdir(join(app.root, 'incoming-images'), { recursive: true })
    await writeFile(incomingFile(app.root, 'apple'), TINY_PNG)

    let calls = 0
    const adapter = new GeminiAdapter({
      apiKey: 'test',
      generateContent: async () => {
        calls++
        return { bytes: TINY_PNG }
      },
    })

    const result = await generateImages(manifest, item, adapter, { skipExisting: true, only: ['apple'] })

    expect(result.skipped).toEqual(['apple'])
    expect(result.made).toEqual([])
    expect(calls).toBe(0)
  })

  it('names GEMINI_API_KEY when the key is missing', async () => {
    const adapter = new GeminiAdapter({ apiKey: '' })
    const error = await captureUserError(
      adapter.generate({ id: 'apple', prompt: 'A red apple', outFile: '/tmp/apple.png', seed: 1 }),
    )
    expect(error.message).toContain('GEMINI_API_KEY')
  })
})

describe('manual backend', () => {
  it('writes the prompt sheet and generates no image files', async () => {
    const { app, manifest, item } = await demo()
    const result = await generateImages(manifest, item, new ManualAdapter())

    expect(result.made).toEqual([])
    expect(result.skipped).toEqual(['apple', 'banana', 'carrot'])
    expect(existsSync(join(app.root, 'image-prompts.md'))).toBe(true)
    expect(existsSync(incomingFile(app.root, 'apple'))).toBe(false)
  })
})

interface FakeComfy {
  url: string
  lastPrompt: Record<string, { inputs: Record<string, unknown> }> | undefined
  close: () => Promise<void>
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString('utf8')
}

async function serveComfy(options: { checkpoints: string[]; image?: Buffer }): Promise<FakeComfy> {
  const state: Pick<FakeComfy, 'lastPrompt'> = { lastPrompt: undefined }

  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      if (url.pathname === '/system_stats') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ system: { os: 'darwin' } }))
        return
      }
      if (url.pathname === '/models/checkpoints') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(options.checkpoints))
        return
      }
      if (req.method === 'POST' && url.pathname === '/prompt') {
        const body = JSON.parse(await readBody(req)) as { prompt: FakeComfy['lastPrompt'] }
        state.lastPrompt = body.prompt
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ prompt_id: 'p1', node_errors: {} }))
        return
      }
      if (url.pathname === '/history/p1') {
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(
          JSON.stringify({
            p1: {
              status: { completed: true, status_str: 'success' },
              outputs: { '9': { images: [{ filename: 'apple.png', subfolder: '', type: 'output' }] } },
            },
          }),
        )
        return
      }
      if (url.pathname === '/view') {
        res.writeHead(200, { 'content-type': 'image/png' })
        res.end(options.image ?? TINY_PNG)
        return
      }
      res.writeHead(404)
      res.end('no')
    })().catch((err: unknown) => {
      res.writeHead(500)
      res.end((err as Error).message)
    })
  })

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('expected a TCP address')
  return {
    url: `http://127.0.0.1:${address.port}`,
    get lastPrompt() {
      return state.lastPrompt
    },
    close: () => new Promise((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  }
}
