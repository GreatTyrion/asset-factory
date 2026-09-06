// The CLI is what other tools and humans actually call, so exit codes and the
// first line of output are part of the contract.

import { execFile } from 'node:child_process'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, describe, expect, it } from 'vitest'
import { CONFIG_FILENAME, loadConfig } from '../src/config.ts'
import { guessDataSource, initConfig } from '../src/init.ts'
import { demoConfig, loadDemo, makeDemoApp, writeTestImage, type DemoApp } from './helpers.ts'

const run = promisify(execFile)
const CLI = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'cli.ts')

let apps: DemoApp[] = []

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

interface Run {
  code: number
  stdout: string
  stderr: string
}

async function cli(args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI, ...args], {
      env: { ...process.env, NO_COLOR: '1', ...env },
    })
    return { code: 0, stdout, stderr }
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string }
    return { code: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' }
  }
}

async function demo(options: Parameters<typeof loadDemo>[0] = {}) {
  const result = await loadDemo(options)
  apps.push(result.app)
  return result
}

describe('cli', () => {
  it('prints usage and fails when called with no command', async () => {
    const result = await cli([])
    expect(result.code).toBe(1)
    expect(result.stdout).toContain('asset-factory <command>')
  })

  it('prints usage and succeeds for --help', async () => {
    const result = await cli(['audit', '--help'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('Commands')
  })

  it('reports the version', async () => {
    const result = await cli(['--version'])
    expect(result.code).toBe(0)
    expect(result.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it('rejects an unknown command', async () => {
    const result = await cli(['frobnicate'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('Unknown command "frobnicate"')
  })

  it('exits non-zero with a fixable message when there is no config', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'asset-factory-nocfg-'))
    try {
      const result = await cli(['audit', '--cwd', empty])
      expect(result.code).toBe(1)
      expect(result.stderr).toContain('No factory.config.json found')
      expect(result.stdout).toContain('asset-factory init')
      expect(result.stderr).not.toContain('at async')
    } finally {
      await rm(empty, { recursive: true, force: true })
    }
  })

  it('exits non-zero while assets are missing, and zero once they are all there', async () => {
    const { app, config } = await demo()
    const incomplete = await cli(['audit', '--cwd', app.root])
    expect(incomplete.code).toBe(1)
    expect(incomplete.stdout).toContain('demo — 0/3 assets')

    const incoming = join(app.root, config.incomingDir)
    await mkdir(incoming, { recursive: true })
    for (const id of ['apple', 'banana', 'carrot']) await writeTestImage(join(incoming, `${id}.png`))

    const imported = await cli(['import', '--cwd', app.root])
    expect(imported.code).toBe(0)
    expect(imported.stdout).toContain('Imported 3.')
    expect(imported.stdout).toContain('Every asset is present')

    const complete = await cli(['audit', '--cwd', app.root])
    expect(complete.code).toBe(0)
  })

  it('succeeds after a partial import — only audit judges completeness', async () => {
    const { app, config } = await demo()
    const incoming = join(app.root, config.incomingDir)
    await mkdir(incoming, { recursive: true })
    await writeTestImage(join(incoming, 'apple.png'))

    const imported = await cli(['import', '--cwd', app.root])
    expect(imported.code).toBe(0)
    expect(imported.stdout).toContain('missing: banana, carrot')

    expect((await cli(['audit', '--cwd', app.root])).code).toBe(1)
  })

  it('emits a machine-readable report with --json', async () => {
    const { app } = await demo()
    const result = await cli(['audit', '--cwd', app.root, '--json'])
    expect(result.code).toBe(1)
    expect(JSON.parse(result.stdout)).toMatchObject({ app: 'demo', total: 3, present: 0, complete: false })
  })

  it('writes both prompt artifacts', async () => {
    const { app } = await demo()
    const result = await cli(['prompts', '--cwd', app.root])

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('image-prompts.md — 3 prompts')
    await expect(readFile(join(app.root, 'image-prompts.md'), 'utf8')).resolves.toContain('save as `apple`')
    await expect(readFile(join(app.root, '.asset-factory', 'prompts.json'), 'utf8')).resolves.toContain('"apple"')
  })

  it('records import progress in state.json', async () => {
    const { app, config } = await demo()
    const incoming = join(app.root, config.incomingDir)
    await mkdir(incoming, { recursive: true })
    await writeTestImage(join(incoming, 'apple.png'))

    await cli(['import', '--cwd', app.root])
    const state = JSON.parse(await readFile(join(app.root, '.asset-factory', 'state.json'), 'utf8'))
    expect(state.assets['image:apple']).toMatchObject({ status: 'done' })
  })

  it('warns about drop-folder files that match no record without failing the import', async () => {
    const { app, config } = await demo()
    const incoming = join(app.root, config.incomingDir)
    await mkdir(incoming, { recursive: true })
    for (const id of ['apple', 'banana', 'carrot', 'durian']) await writeTestImage(join(incoming, `${id}.png`))

    const result = await cli(['import', '--cwd', app.root])
    expect(result.code).toBe(0)
    expect(result.stderr).toContain('match no id')
    expect(result.stdout).toContain('durian.png')
  })

  it('asks for --group instead of guessing between two image groups', async () => {
    const { app } = await demo({
      config: demoConfig({
        items: [
          { kind: 'image', name: 'hero', outDir: 'public/hero', promptField: 'imagePrompt' },
          { kind: 'image', name: 'thumb', outDir: 'public/thumb', promptField: 'imagePrompt' },
        ],
      }),
    })
    const result = await cli(['import', '--cwd', app.root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('ambiguous')
    expect(result.stdout).toContain('--group')
  })

  it('generate --backend manual writes the sheet and does not invent images', async () => {
    const { app } = await demo()
    const result = await cli(['generate', '--cwd', app.root, '--backend', 'manual'])
    expect(result.code).toBe(0)
    expect(result.stdout).toContain('manual')
    expect(result.stdout).toContain('skipped 3')
    await expect(readFile(join(app.root, 'image-prompts.md'), 'utf8')).resolves.toContain('save as `apple`')
    expect(existsSync(join(app.root, 'incoming-images', 'apple.png'))).toBe(false)
  })

  it('generate refuses to guess a backend', async () => {
    const { app } = await demo()
    const result = await cli(['generate', '--cwd', app.root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--backend')
  })

  it('generate names the allowed backends when the name is unknown', async () => {
    const { app } = await demo()
    const result = await cli(['generate', '--cwd', app.root, '--backend', 'midjourney'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('midjourney')
    expect(result.stdout).toContain('gemini')
  })

  it('synthesizes voice-over and writes an audio manifest', async () => {
    const { app } = await demo({
      config: demoConfig({
        items: [
          {
            kind: 'tts',
            outDir: 'public/audio',
            textField: 'intro',
            lang: 'zh-CN',
            voice: 'zh-CN-XiaoxiaoNeural',
          },
        ],
      }),
    })

    const result = await cli(['tts', '--cwd', app.root], {
      EDGE_TTS_BIN: resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-edge-tts.mjs'),
    })

    expect(result.code).toBe(0)
    expect(result.stdout).toContain('zh-CN-XiaoxiaoNeural')
    expect(result.stdout).toContain('Made 3, skipped 0, failed 0')
    await expect(readFile(join(app.root, 'public', 'audio', 'audio-manifest.json'), 'utf8')).resolves.toContain(
      '"/audio/apple.mp3"',
    )
  })

  it('exits non-zero when a clip fails to synthesize', async () => {
    const { app } = await demo({
      config: demoConfig({
        items: [{ kind: 'tts', outDir: 'public/audio', textField: 'intro', voice: 'zh-CN-XiaoxiaoNeural' }],
      }),
    })

    const result = await cli(['tts', '--cwd', app.root, '--retries', '0'], {
      EDGE_TTS_BIN: resolve(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'fake-edge-tts.mjs'),
      FAKE_TTS_MODE: 'fail',
    })

    expect(result.code).toBe(1)
    expect(result.stderr).toContain('429')
    expect(result.stdout).toContain('failed 3')
  })

  it('rejects a nonsense numeric flag up front', async () => {
    const { app } = await demo()
    const result = await cli(['tts', '--cwd', app.root, '--concurrency', 'lots'])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('--concurrency must be an integer >= 1')
  })
})

describe('init', () => {
  it('creates a config that loads cleanly once a promptField exists', async () => {
    const app = await makeDemoApp()
    apps.push(app)
    await rm(join(app.root, CONFIG_FILENAME))

    const result = await cli(['init', '--cwd', app.root])
    expect(result.code).toBe(0)
    expect(existsSync(join(app.root, CONFIG_FILENAME))).toBe(true)

    const config = await loadConfig(app.root)
    expect(config.dataSource).toBe('src/data/items.ts')
    expect(config.items[0]).toMatchObject({ kind: 'image', promptField: 'imagePrompt' })
  })

  it('refuses to clobber an existing config unless forced', async () => {
    const app = await makeDemoApp()
    apps.push(app)
    const before = await readFile(join(app.root, CONFIG_FILENAME), 'utf8')

    const result = await cli(['init', '--cwd', app.root])
    expect(result.code).toBe(1)
    expect(result.stderr).toContain('already exists')
    await expect(readFile(join(app.root, CONFIG_FILENAME), 'utf8')).resolves.toBe(before)

    const forced = await cli(['init', '--cwd', app.root, '--force'])
    expect(forced.code).toBe(0)
    await expect(readFile(join(app.root, CONFIG_FILENAME), 'utf8')).resolves.not.toBe(before)
  })

  it('skips test files when guessing the data module', async () => {
    const app = await makeDemoApp()
    apps.push(app)
    await writeTestImage(join(app.root, 'src', 'data', 'ignored.png'))
    await expect(guessDataSource(app.root)).resolves.toBe('src/data/items.ts')
  })

  it('falls back to a placeholder when there is no data folder', async () => {
    const bare = await mkdtemp(join(tmpdir(), 'asset-factory-bare-'))
    try {
      await initConfig(bare)
      const raw = JSON.parse(await readFile(join(bare, CONFIG_FILENAME), 'utf8'))
      expect(raw.dataSource).toBe('src/data/items.ts')
    } finally {
      await rm(bare, { recursive: true, force: true })
    }
  })
})
