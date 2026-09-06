// Voice-over via edge-tts (Microsoft's online TTS, driven as a subprocess).
//
// Pre-generating mp3 replaces the apps' runtime Web Speech synthesis, which is
// why gourmet needed a whole voice-ranking module to dodge Chrome's flaky
// network voices. The service is remote, so every call gets a timeout and a
// couple of retries, and progress is recorded so a half-finished run resumes.

import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { access, constants, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import type { TtsItem } from './config.ts'
import { UserError } from './log.ts'
import type { Asset, Manifest } from './manifest.ts'
import { readMp3Info } from './mp3.ts'
import { loadState, record, saveState, type FactoryState } from './state.ts'

export const AUDIO_MANIFEST = 'audio-manifest.json'

export const DEFAULT_TIMEOUT_MS = 60_000
export const DEFAULT_RETRIES = 2
export const DEFAULT_CONCURRENCY = 3

/**
 * Where to look for edge-tts when EDGE_TTS_BIN is unset and it is not on PATH.
 * The hermes venv is where this machine happens to have it; harmless elsewhere.
 * Read at call time, not module load, so the environment stays overridable.
 */
function fallbackBins(): string[] {
  return [
    `${process.env.HOME ?? ''}/.hermes/hermes-agent/venv/bin/edge-tts`,
    '/opt/homebrew/bin/edge-tts',
    '/usr/local/bin/edge-tts',
  ]
}

export class TtsError extends Error {
  stderr: string
  exitCode: number | null
  timedOut: boolean
  /** False for mistakes retrying cannot fix, like an unknown voice name. */
  retryable: boolean

  constructor(
    message: string,
    options: { stderr?: string; exitCode?: number | null; timedOut?: boolean; retryable?: boolean } = {},
  ) {
    super(message)
    this.name = 'TtsError'
    this.stderr = options.stderr ?? ''
    this.exitCode = options.exitCode ?? null
    this.timedOut = options.timedOut ?? false
    this.retryable = options.retryable ?? true
  }
}

/**
 * Config errors surface immediately instead of being retried three times.
 * `edge-tts: error: ...` is argparse rejecting our argv — no amount of retrying
 * fixes a malformed flag.
 */
function isRetryable(stderr: string): boolean {
  return !/no voices found|invalid voice|edge-tts: error:|unrecognized arguments/i.test(stderr)
}

async function isExecutable(file: string): Promise<boolean> {
  try {
    await access(file, constants.X_OK)
    return true
  } catch {
    return false
  }
}

/**
 * Resolve the edge-tts executable: EDGE_TTS_BIN wins, then an explicit path,
 * then PATH, then the known install locations.
 */
export async function resolveEdgeTtsBin(explicit?: string): Promise<string> {
  const preferred = process.env.EDGE_TTS_BIN ?? explicit
  if (preferred) {
    if (await isExecutable(preferred)) return preferred
    throw new UserError(
      `edge-tts not executable at ${preferred}`,
      process.env.EDGE_TTS_BIN
        ? `EDGE_TTS_BIN points there. Fix it or unset it to fall back to PATH.`
        : `Check the path, or set EDGE_TTS_BIN.`,
    )
  }

  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => join(dir, 'edge-tts'))
  for (const candidate of [...onPath, ...fallbackBins()]) {
    if (await isExecutable(candidate)) return candidate
  }

  throw new UserError(
    'Could not find the edge-tts executable.',
    `Install it (\`pipx install edge-tts\` or \`pip install edge-tts\`), or point EDGE_TTS_BIN at it:\n` +
      `    EDGE_TTS_BIN=/path/to/edge-tts asset-factory tts`,
  )
}

export interface SynthesizeRequest {
  bin: string
  voice: string
  text: string
  outFile: string
  rate?: string
  volume?: string
  pitch?: string
  timeoutMs?: number
}

/**
 * The exact argv handed to edge-tts. Split out so tests can assert on it.
 *
 * Prosody values are passed as `--rate=-8%`, not `--rate -8%`: edge-tts parses
 * with argparse, which reads a leading "-" as the start of another flag and
 * fails with "expected one argument".
 */
export function edgeTtsArgs(request: SynthesizeRequest): string[] {
  const args = ['--voice', request.voice, '--text', request.text, '--write-media', request.outFile]
  if (request.rate) args.push(`--rate=${request.rate}`)
  if (request.volume) args.push(`--volume=${request.volume}`)
  if (request.pitch) args.push(`--pitch=${request.pitch}`)
  return args
}

/**
 * One edge-tts invocation. Resolves only when the process exits 0 *and* leaves
 * a non-empty file behind — edge-tts can exit 0 having written nothing.
 */
export function runEdgeTts(request: SynthesizeRequest): Promise<void> {
  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return new Promise((resolve, reject) => {
    // PYTHONPATH from a surrounding venv makes the wrapper import the wrong
    // packages, so it is dropped the way `env -u PYTHONPATH` would.
    const env = { ...process.env }
    delete env.PYTHONPATH

    const child = spawn(request.bin, edgeTtsArgs(request), { env, stdio: ['ignore', 'ignore', 'pipe'] })

    let stderr = ''
    let timedOut = false

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
    })

    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      // Escalate if it ignores the polite request.
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)

    child.on('error', (err) => {
      clearTimeout(timer)
      reject(new TtsError(`could not run ${request.bin}: ${err.message}`, { stderr }))
    })

    child.on('close', (code) => {
      clearTimeout(timer)

      if (timedOut) {
        reject(new TtsError(`timed out after ${timeoutMs}ms`, { stderr, exitCode: code, timedOut: true }))
        return
      }
      if (code !== 0) {
        const detail = stderr.trim().split('\n').at(-1) ?? `exit code ${code}`
        reject(new TtsError(detail, { stderr, exitCode: code, retryable: isRetryable(stderr) }))
        return
      }

      stat(request.outFile).then(
        (info) =>
          info.size > 0
            ? resolve()
            : reject(new TtsError('edge-tts exited 0 but wrote an empty file', { stderr, exitCode: code })),
        () => reject(new TtsError('edge-tts exited 0 but wrote no file', { stderr, exitCode: code })),
      )
    })
  })
}

export interface RetryOptions {
  retries?: number
  /** Base delay; doubles each attempt. Zero keeps tests fast. */
  backoffMs?: number
  onRetry?: (attempt: number, error: TtsError) => void
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** runEdgeTts plus retries, for the transient failures a network service has. */
export async function synthesize(request: SynthesizeRequest, options: RetryOptions = {}): Promise<void> {
  const retries = options.retries ?? DEFAULT_RETRIES
  const backoffMs = options.backoffMs ?? 1_000

  let lastError: TtsError | undefined
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await runEdgeTts(request)
      return
    } catch (err) {
      const error = err instanceof TtsError ? err : new TtsError((err as Error).message)
      lastError = error
      if (!error.retryable || attempt === retries) break
      options.onRetry?.(attempt + 1, error)
      if (backoffMs > 0) await sleep(backoffMs * 2 ** attempt)
    }
  }

  throw lastError ?? new TtsError('synthesis failed')
}

/** Short digest of the source text, so changed copy can be spotted later. */
export function textHash(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 12)
}

export interface AudioClip {
  /** Filename inside outDir. */
  file: string
  /** Browser path, when outDir sits under public/. */
  url?: string
  durationSec: number
  bytes: number
  textHash: string
}

export interface AudioManifest {
  app: string
  group: string
  lang: string
  voice: string
  outDir: string
  clips: Record<string, AudioClip>
}

/** Vite serves public/ at the site root, so that prefix is not part of the URL. */
function urlFor(outDir: string, file: string): string | undefined {
  const normalized = outDir.split('\\').join('/')
  if (normalized !== 'public' && !normalized.startsWith('public/')) return undefined
  const webDir = normalized.slice('public'.length)
  return `${webDir}/${file}`.replace(/\/+/g, '/')
}

async function readExistingManifest(file: string): Promise<AudioManifest | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as AudioManifest
  } catch {
    return undefined
  }
}

/**
 * Describe every clip that exists on disk right now. Built by reading the files
 * rather than trusting the previous manifest, so hand-deleted audio disappears.
 */
export async function buildAudioManifest(
  manifest: Manifest,
  item: TtsItem,
  assets: Asset[],
): Promise<AudioManifest> {
  const clips: Record<string, AudioClip> = {}

  for (const asset of assets) {
    if (!existsSync(asset.outFile)) continue
    const buf = await readFile(asset.outFile)
    const info = readMp3Info(buf)
    const file = `${asset.id}.mp3`
    const url = urlFor(item.outDir, file)
    clips[asset.id] = {
      file,
      ...(url ? { url } : {}),
      durationSec: info?.durationSec ?? 0,
      bytes: buf.length,
      textHash: textHash(asset.text ?? ''),
    }
  }

  return {
    app: manifest.config.name,
    group: item.name,
    lang: item.lang,
    voice: item.voice ?? '',
    outDir: item.outDir,
    clips,
  }
}

export interface TtsOptions {
  /** Re-synthesize everything, even unchanged clips. */
  force?: boolean
  /** Keep every existing file, even if its text changed. */
  skipExisting?: boolean
  only?: string[]
  concurrency?: number
  timeoutMs?: number
  retries?: number
  backoffMs?: number
  bin?: string
  onStart?: (asset: Asset) => void
  onDone?: (asset: Asset, clip: { bytes: number; durationSec: number }) => void
  onSkip?: (asset: Asset, reason: 'unchanged' | 'exists') => void
  onRetry?: (asset: Asset, attempt: number, error: TtsError) => void
  onFail?: (asset: Asset, error: TtsError) => void
}

export interface TtsResult {
  made: string[]
  skipped: string[]
  failed: { id: string; error: string }[]
  manifestPath: string
  manifest: AudioManifest
  voice: string
}

/** Run a pool of `limit` workers over `items`. */
async function pool<T>(items: T[], limit: number, worker: (item: T) => Promise<void>): Promise<void> {
  let cursor = 0
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = cursor++
      if (index >= items.length) return
      await worker(items[index]!)
    }
  })
  await Promise.all(runners)
}

export async function generateTts(manifest: Manifest, item: TtsItem, options: TtsOptions = {}): Promise<TtsResult> {
  const { config } = manifest
  const voice = item.voice
  if (!voice) {
    throw new UserError(
      `Item group "${item.name}" has no "voice".`,
      `Add one to ${config.file}, e.g. "voice": "zh-CN-XiaoxiaoNeural". ` +
        `List the options with \`edge-tts --list-voices\`.`,
    )
  }

  const bin = await resolveEdgeTtsBin(options.bin)
  const outDir = join(config.root, item.outDir)
  await mkdir(outDir, { recursive: true })

  const all = manifest.assets.filter((a) => a.group === item.name)
  const assets = options.only ? all.filter((a) => options.only!.includes(a.id)) : all

  const manifestPath = join(outDir, AUDIO_MANIFEST)
  const previous = await readExistingManifest(manifestPath)

  const state = await loadState(config.root)
  const made: string[] = []
  const skipped: string[] = []
  const failed: { id: string; error: string }[] = []

  const todo = assets.filter((asset) => {
    if (options.force) return true
    if (!existsSync(asset.outFile)) return true
    if (options.skipExisting) {
      skipped.push(asset.id)
      options.onSkip?.(asset, 'exists')
      return false
    }
    // The data module is the source of truth: re-read anything whose copy changed.
    const stale = previous?.clips[asset.id]?.textHash !== textHash(asset.text ?? '')
    if (!stale) {
      skipped.push(asset.id)
      options.onSkip?.(asset, 'unchanged')
    }
    return stale
  })

  await pool(todo, options.concurrency ?? DEFAULT_CONCURRENCY, async (asset) => {
    options.onStart?.(asset)
    try {
      await synthesize(
        {
          bin,
          voice,
          text: asset.text ?? '',
          outFile: asset.outFile,
          rate: item.rate,
          volume: item.volume,
          pitch: item.pitch,
          timeoutMs: options.timeoutMs,
        },
        {
          retries: options.retries,
          backoffMs: options.backoffMs,
          onRetry: (attempt, error) => options.onRetry?.(asset, attempt, error),
        },
      )

      const buf = await readFile(asset.outFile)
      const info = readMp3Info(buf)
      made.push(asset.id)
      record(state, asset, 'done')
      options.onDone?.(asset, { bytes: buf.length, durationSec: info?.durationSec ?? 0 })
    } catch (err) {
      const error = err instanceof TtsError ? err : new TtsError((err as Error).message)
      failed.push({ id: asset.id, error: error.message })
      record(state, asset, 'failed', error.message)
      options.onFail?.(asset, error)
    }
  })

  await saveState(config.root, state)

  const audioManifest = await buildAudioManifest(manifest, item, all)
  await writeFile(manifestPath, `${JSON.stringify(audioManifest, null, 2)}\n`, 'utf8')

  return { made, skipped, failed, manifestPath, manifest: audioManifest, voice }
}

export type { FactoryState }
