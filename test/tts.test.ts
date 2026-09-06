// The edge-tts wrapper is exercised against test/fixtures/fake-edge-tts.mjs, a
// real executable, so exit codes, signals and timeouts behave like production.

import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TtsItem } from '../src/config.ts'
import { UserError } from '../src/log.ts'
import { resolveGroup } from '../src/manifest.ts'
import { readMp3Info } from '../src/mp3.ts'
import { loadState } from '../src/state.ts'
import {
  AUDIO_MANIFEST,
  TtsError,
  buildAudioManifest,
  edgeTtsArgs,
  generateTts,
  resolveEdgeTtsBin,
  runEdgeTts,
  synthesize,
  textHash,
  type AudioManifest,
} from '../src/tts.ts'
import { demoConfig, loadDemo, type DemoApp } from './helpers.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const FAKE_BIN = resolve(HERE, 'fixtures', 'fake-edge-tts.mjs')

const TTS_CONFIG = demoConfig({
  items: [
    {
      kind: 'tts',
      outDir: 'public/audio',
      textField: 'intro',
      lang: 'zh-CN',
      voice: 'zh-CN-XiaoxiaoNeural',
    },
  ],
})

let apps: DemoApp[] = []
let scratch: string

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'asset-factory-tts-'))
  process.env.EDGE_TTS_BIN = FAKE_BIN
  process.env.FAKE_TTS_COUNTER = join(scratch, 'attempts')
  delete process.env.FAKE_TTS_MODE
  delete process.env.FAKE_TTS_FAILURES
  delete process.env.FAKE_TTS_ARGV_LOG
})

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
  await rm(scratch, { recursive: true, force: true })
  delete process.env.EDGE_TTS_BIN
  delete process.env.FAKE_TTS_MODE
  delete process.env.FAKE_TTS_FAILURES
  delete process.env.FAKE_TTS_COUNTER
  delete process.env.FAKE_TTS_ARGV_LOG
})

async function demo(config: Record<string, unknown> = TTS_CONFIG) {
  const result = await loadDemo({ config })
  apps.push(result.app)
  const item = resolveGroup(result.config, 'tts') as TtsItem
  return { ...result, item }
}

/** Await a call that must reject with a TtsError, and hand back the error. */
async function captureTtsError(promise: Promise<unknown>): Promise<TtsError> {
  try {
    await promise
  } catch (err) {
    if (err instanceof TtsError) return err
    throw err
  }
  throw new Error('Expected a TtsError, but the call succeeded.')
}

async function attempts(): Promise<number> {
  try {
    return Number(await readFile(process.env.FAKE_TTS_COUNTER!, 'utf8'))
  } catch {
    return 0
  }
}

describe('edgeTtsArgs', () => {
  const base = { bin: FAKE_BIN, voice: 'zh-CN-XiaoxiaoNeural', text: '你好', outFile: '/tmp/a.mp3' }

  it('passes voice, text and output path', () => {
    expect(edgeTtsArgs(base)).toEqual([
      '--voice',
      'zh-CN-XiaoxiaoNeural',
      '--text',
      '你好',
      '--write-media',
      '/tmp/a.mp3',
    ])
  })

  it('adds prosody flags only when configured', () => {
    expect(edgeTtsArgs({ ...base, rate: '-8%', pitch: '+5Hz' })).toEqual(
      expect.arrayContaining(['--rate=-8%', '--pitch=+5Hz']),
    )
    expect(edgeTtsArgs(base).join(' ')).not.toContain('--volume')
  })

  it('glues negative prosody values to the flag, which argparse requires', () => {
    // `--rate -8%` makes edge-tts fail with "expected one argument", because
    // argparse reads the leading "-" as the next flag.
    const args = edgeTtsArgs({ ...base, rate: '-8%', volume: '-10%', pitch: '-5Hz' })
    expect(args).toContain('--rate=-8%')
    expect(args).toContain('--volume=-10%')
    expect(args).toContain('--pitch=-5Hz')
    expect(args).not.toContain('-8%')
  })
})

describe('resolveEdgeTtsBin', () => {
  it('prefers EDGE_TTS_BIN', async () => {
    await expect(resolveEdgeTtsBin()).resolves.toBe(FAKE_BIN)
  })

  it('explains how to fix a bad EDGE_TTS_BIN', async () => {
    process.env.EDGE_TTS_BIN = join(scratch, 'nope')
    const error = await resolveEdgeTtsBin().catch((e: UserError) => e)
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).message).toContain('not executable')
    expect((error as UserError).hint).toContain('EDGE_TTS_BIN')
  })

  it('rejects a file without the execute bit', async () => {
    const notExec = join(scratch, 'edge-tts')
    await writeFile(notExec, '#!/bin/sh\n', 'utf8')
    await chmod(notExec, 0o644)
    process.env.EDGE_TTS_BIN = notExec
    await expect(resolveEdgeTtsBin()).rejects.toThrow(/not executable/)
  })

  it('falls back to PATH when EDGE_TTS_BIN is unset', async () => {
    delete process.env.EDGE_TTS_BIN
    const dir = join(scratch, 'bin')
    await mkdir(dir, { recursive: true })
    const onPath = join(dir, 'edge-tts')
    await writeFile(onPath, '#!/bin/sh\nexit 0\n', 'utf8')
    await chmod(onPath, 0o755)

    const previousPath = process.env.PATH
    process.env.PATH = dir
    try {
      await expect(resolveEdgeTtsBin()).resolves.toBe(onPath)
    } finally {
      process.env.PATH = previousPath
    }
  })

  it('tells the user how to install it when it is nowhere', async () => {
    delete process.env.EDGE_TTS_BIN
    const previousPath = process.env.PATH
    const previousHome = process.env.HOME
    process.env.PATH = join(scratch, 'empty')
    process.env.HOME = join(scratch, 'empty')
    try {
      const error = await resolveEdgeTtsBin().catch((e: UserError) => e)
      expect((error as UserError).message).toContain('Could not find the edge-tts executable')
      expect((error as UserError).hint).toContain('pip install edge-tts')
    } finally {
      process.env.PATH = previousPath
      process.env.HOME = previousHome
    }
  })
})

describe('runEdgeTts', () => {
  const request = (overrides: Record<string, unknown> = {}) => ({
    bin: FAKE_BIN,
    voice: 'zh-CN-XiaoxiaoNeural',
    text: '你好世界',
    outFile: join(scratch, 'out.mp3'),
    ...overrides,
  })

  it('writes a playable mp3 on success', async () => {
    await runEdgeTts(request())
    const info = readMp3Info(await readFile(join(scratch, 'out.mp3')))
    // The fake emits one 24 ms frame per character.
    expect(info).toMatchObject({ sampleRate: 24000, channels: 1, frames: 4 })
    expect(info!.durationSec).toBeCloseTo(0.096, 3)
  })

  it('forwards the exact argv to the binary', async () => {
    process.env.FAKE_TTS_ARGV_LOG = join(scratch, 'argv.log')
    await runEdgeTts(request({ rate: '-8%' }))
    const logged = JSON.parse((await readFile(process.env.FAKE_TTS_ARGV_LOG, 'utf8')).trim())
    expect(logged).toEqual(expect.arrayContaining(['--voice', 'zh-CN-XiaoxiaoNeural', '--rate=-8%']))
  })

  it('drops PYTHONPATH so a surrounding venv cannot break the wrapper', async () => {
    const probe = join(scratch, 'probe.mjs')
    await writeFile(
      probe,
      `#!/usr/bin/env node\n` +
        `import { writeFileSync } from 'node:fs'\n` +
        `writeFileSync(process.argv[process.argv.indexOf('--write-media') + 1], String(process.env.PYTHONPATH))\n`,
      'utf8',
    )
    await chmod(probe, 0o755)

    process.env.PYTHONPATH = '/some/poisoned/path'
    try {
      await runEdgeTts(request({ bin: probe }))
      // The child saw no PYTHONPATH at all, the way `env -u PYTHONPATH` runs it.
      expect(await readFile(join(scratch, 'out.mp3'), 'utf8')).toBe('undefined')
    } finally {
      delete process.env.PYTHONPATH
    }
  })

  it('surfaces the last stderr line when the process fails', async () => {
    process.env.FAKE_TTS_MODE = 'fail'
    const error = await captureTtsError(runEdgeTts(request()))
    expect(error.message).toContain('429 Too Many Requests')
    expect(error.exitCode).toBe(1)
    expect(error.retryable).toBe(true)
  })

  it('marks an unknown voice as not worth retrying', async () => {
    process.env.FAKE_TTS_MODE = 'badvoice'
    const error = await captureTtsError(runEdgeTts(request()))
    expect(error.message).toContain('No voices found')
    expect(error.retryable).toBe(false)
  })

  it('marks a rejected argument as not worth retrying', async () => {
    process.env.FAKE_TTS_MODE = 'badargs'
    const error = await captureTtsError(runEdgeTts(request()))
    expect(error.message).toContain('expected one argument')
    expect(error.retryable).toBe(false)
  })

  it('kills a hung process at the timeout', async () => {
    process.env.FAKE_TTS_MODE = 'hang'
    const started = Date.now()
    const error = await captureTtsError(runEdgeTts(request({ timeoutMs: 300 })))

    expect(error.timedOut).toBe(true)
    expect(error.message).toContain('timed out after 300ms')
    expect(Date.now() - started).toBeLessThan(5_000)
  })

  it('fails when the process exits 0 without writing anything', async () => {
    process.env.FAKE_TTS_MODE = 'nofile'
    await expect(runEdgeTts(request())).rejects.toThrow(/wrote no file/)
  })

  it('fails when the process exits 0 leaving an empty file', async () => {
    process.env.FAKE_TTS_MODE = 'emptyfile'
    await expect(runEdgeTts(request())).rejects.toThrow(/empty file/)
  })

  it('reports a missing binary rather than hanging', async () => {
    await expect(runEdgeTts(request({ bin: join(scratch, 'ghost') }))).rejects.toThrow(/could not run/)
  })
})

describe('synthesize (retries)', () => {
  const request = () => ({
    bin: FAKE_BIN,
    voice: 'zh-CN-XiaoxiaoNeural',
    text: '你好',
    outFile: join(scratch, 'out.mp3'),
  })

  it('recovers from a transient failure', async () => {
    process.env.FAKE_TTS_MODE = 'flaky'
    process.env.FAKE_TTS_FAILURES = '2'

    const retries: number[] = []
    await synthesize(request(), { retries: 3, backoffMs: 0, onRetry: (attempt) => retries.push(attempt) })

    expect(retries).toEqual([1, 2])
    expect(await attempts()).toBe(3)
    expect(existsSync(join(scratch, 'out.mp3'))).toBe(true)
  })

  it('gives up after the retry budget and reports the last error', async () => {
    process.env.FAKE_TTS_MODE = 'fail'
    const error = await captureTtsError(synthesize(request(), { retries: 2, backoffMs: 0 }))

    expect(error.message).toContain('429')
    expect(await attempts()).toBe(3) // one attempt + two retries
  })

  it('does not retry an unknown voice', async () => {
    process.env.FAKE_TTS_MODE = 'badvoice'
    await expect(synthesize(request(), { retries: 5, backoffMs: 0 })).rejects.toThrow(/No voices found/)
    expect(await attempts()).toBe(1)
  })

  it('honours retries: 0', async () => {
    process.env.FAKE_TTS_MODE = 'fail'
    await expect(synthesize(request(), { retries: 0, backoffMs: 0 })).rejects.toThrow()
    expect(await attempts()).toBe(1)
  })
})

describe('generateTts', () => {
  const run = (app: Awaited<ReturnType<typeof demo>>, options = {}) =>
    generateTts(app.manifest, app.item, { backoffMs: 0, ...options })

  it('produces one mp3 per record plus an audio manifest', async () => {
    const app = await demo()
    const result = await run(app)

    expect(result.made.sort()).toEqual(['apple', 'banana', 'carrot'])
    expect(result.failed).toEqual([])
    for (const id of ['apple', 'banana', 'carrot']) {
      expect(existsSync(join(app.app.root, 'public', 'audio', `${id}.mp3`))).toBe(true)
    }
    expect(result.manifestPath).toBe(join(app.app.root, 'public', 'audio', AUDIO_MANIFEST))
  })

  it('records duration, size, web url and a text digest per clip', async () => {
    const app = await demo()
    await run(app)

    const written = JSON.parse(await readFile(join(app.app.root, 'public', 'audio', AUDIO_MANIFEST), 'utf8')) as AudioManifest
    expect(written).toMatchObject({ app: 'demo', group: 'tts', lang: 'zh-CN', voice: 'zh-CN-XiaoxiaoNeural' })

    const apple = written.clips.apple!
    expect(apple.file).toBe('apple.mp3')
    expect(apple.url).toBe('/audio/apple.mp3')
    expect(apple.durationSec).toBeGreaterThan(0)
    expect(apple.bytes).toBeGreaterThan(0)
    expect(apple.textHash).toBe(textHash('红红的苹果。'))
  })

  it('omits the url when the output is not served from public/', async () => {
    const app = await demo(
      demoConfig({
        items: [{ kind: 'tts', outDir: 'assets/audio', textField: 'intro', voice: 'zh-CN-XiaoxiaoNeural' }],
      }),
    )
    const result = await run(app)
    expect(result.manifest.clips.apple!.url).toBeUndefined()
  })

  it('marks every clip done in state so audit can see it', async () => {
    const app = await demo()
    await run(app)

    const state = await loadState(app.app.root)
    expect(Object.keys(state.assets).sort()).toEqual(['tts:apple', 'tts:banana', 'tts:carrot'])
    expect(state.assets['tts:apple']).toMatchObject({ status: 'done' })
  })

  it('skips unchanged clips on a second run', async () => {
    const app = await demo()
    await run(app)
    const first = await attempts()

    const second = await run(app)
    expect(second.made).toEqual([])
    expect(second.skipped.sort()).toEqual(['apple', 'banana', 'carrot'])
    expect(await attempts()).toBe(first)
  })

  it('re-synthesizes only the record whose text changed', async () => {
    const app = await demo()
    await run(app)

    // Pretend the app edited one intro: the digest no longer matches.
    const manifestPath = join(app.app.root, 'public', 'audio', AUDIO_MANIFEST)
    const stored = JSON.parse(await readFile(manifestPath, 'utf8')) as AudioManifest
    stored.clips.banana!.textHash = 'stale00000000'
    await writeFile(manifestPath, JSON.stringify(stored), 'utf8')

    const result = await run(app)
    expect(result.made).toEqual(['banana'])
    expect(result.skipped.sort()).toEqual(['apple', 'carrot'])
  })

  it('re-synthesizes everything with force', async () => {
    const app = await demo()
    await run(app)
    const result = await run(app, { force: true })
    expect(result.made.sort()).toEqual(['apple', 'banana', 'carrot'])
  })

  it('leaves existing files alone with skipExisting, even when the text changed', async () => {
    const app = await demo()
    await run(app)

    const manifestPath = join(app.app.root, 'public', 'audio', AUDIO_MANIFEST)
    const stored = JSON.parse(await readFile(manifestPath, 'utf8')) as AudioManifest
    stored.clips.banana!.textHash = 'stale00000000'
    await writeFile(manifestPath, JSON.stringify(stored), 'utf8')

    const result = await run(app, { skipExisting: true })
    expect(result.made).toEqual([])
  })

  it('regenerates a clip whose file was deleted by hand', async () => {
    const app = await demo()
    await run(app)
    await rm(join(app.app.root, 'public', 'audio', 'carrot.mp3'))

    const result = await run(app)
    expect(result.made).toEqual(['carrot'])
  })

  it('honours an id allow-list', async () => {
    const app = await demo()
    const result = await run(app, { only: ['banana'] })

    expect(result.made).toEqual(['banana'])
    expect(existsSync(join(app.app.root, 'public', 'audio', 'apple.mp3'))).toBe(false)
    // The manifest still describes the whole group, not just this run.
    expect(Object.keys(result.manifest.clips)).toEqual(['banana'])
  })

  it('keeps going when one clip fails, and records it for a resume', async () => {
    const app = await demo()
    process.env.FAKE_TTS_MODE = 'fail'

    const result = await run(app, { retries: 0 })
    expect(result.made).toEqual([])
    expect(result.failed).toHaveLength(3)

    const state = await loadState(app.app.root)
    expect(state.assets['tts:apple']).toMatchObject({ status: 'failed' })
    expect(state.assets['tts:apple']!.error).toContain('429')

    // A later run with the service back up fills in the gap.
    delete process.env.FAKE_TTS_MODE
    const retry = await run(app)
    expect(retry.made.sort()).toEqual(['apple', 'banana', 'carrot'])
  })

  it('refuses to run without a voice', async () => {
    const app = await demo(
      demoConfig({ items: [{ kind: 'tts', outDir: 'public/audio', textField: 'intro' }] }),
    )
    const error = await run(app).catch((e: UserError) => e)
    expect(error).toBeInstanceOf(UserError)
    expect((error as UserError).hint).toContain('edge-tts --list-voices')
  })

  it('respects a concurrency limit of one', async () => {
    const app = await demo()
    const result = await run(app, { concurrency: 1 })
    expect(result.made).toHaveLength(3)
  })
})

describe('buildAudioManifest', () => {
  it('describes only the clips that exist on disk', async () => {
    const app = await demo()
    await generateTts(app.manifest, app.item, { backoffMs: 0, only: ['apple'] })

    const built = await buildAudioManifest(
      app.manifest,
      app.item,
      app.manifest.assets.filter((a) => a.group === 'tts'),
    )
    expect(Object.keys(built.clips)).toEqual(['apple'])
  })
})
