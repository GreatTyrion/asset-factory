#!/usr/bin/env node
// asset-factory — batch image + voice-over pipeline for the kids apps.
//
// Run from a target app root (or pass --cwd / --config). Every command reads
// that app's factory.config.json and its own data module; nothing is duplicated.

import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { audit, formatBytes, type AuditReport } from './audit.ts'
import { loadConfig, type ImageItem, type TtsItem } from './config.ts'
import { generateImages, resolveBackend } from './generate.ts'
import { importImages } from './import-images.ts'
import { initConfig } from './init.ts'
import { UserError, color, log } from './log.ts'
import { buildManifest, resolveGroup, type Manifest } from './manifest.ts'
import { writePrompts } from './prompts.ts'
import { loadState, record, saveState } from './state.ts'
import { generateTts } from './tts.ts'

const VERSION = '0.1.0'

const USAGE = `${color.bold('asset-factory')} ${color.dim(`v${VERSION}`)} — image + voice-over pipeline for the kids apps

${color.bold('Usage')}
  asset-factory <command> [options]

${color.bold('Commands')}
  init       Write a starter factory.config.json in this app
  prompts    Write the prompt sheet + .asset-factory/prompts.json
  generate   Produce images through a backend
  import     Convert the drop folder into final assets
  tts        Synthesize voice-over with edge-tts
  audit      Coverage report: manifest vs. files on disk

${color.bold('Options')}
  --cwd <dir>        App root to operate on (default: current folder)
  --config <file>    Explicit factory.config.json path
  --group <name>     Item group to act on, when the config has several
  --json             Machine-readable output (audit, prompts)
  --force            init: overwrite an existing config; tts/generate: redo all
  --skip-existing    Leave assets that already exist alone
  --only <ids>       Comma-separated ids to act on
  --backend <name>   generate: gemini | manual
  --concurrency <n>  tts: parallel edge-tts calls (default 3)
  --timeout <ms>     tts: per-clip timeout (default 60000)
  --retries <n>      tts: retries per clip (default 2)
  -h, --help         Show this help
  -v, --version      Show the version

${color.bold('Environment')}
  EDGE_TTS_BIN       Path to the edge-tts executable, when it is not on PATH
  GEMINI_API_KEY     Gemini image API key (--backend gemini)
`

interface Options {
  cwd?: string
  config?: string
  group?: string
  json: boolean
  force: boolean
  skipExisting: boolean
  only?: string[]
  backend?: string
  concurrency?: number
  timeoutMs?: number
  retries?: number
}

async function load(options: Options): Promise<Manifest> {
  const config = await loadConfig(options.config ?? options.cwd ?? process.cwd())
  return buildManifest(config)
}

function short(root: string, file: string): string {
  const rel = relative(root, file)
  return rel.startsWith('..') ? file : rel
}

async function cmdInit(options: Options): Promise<number> {
  const root = options.cwd ?? process.cwd()
  const file = await initConfig(root, options.force)
  log.ok(`Wrote ${short(root, file)}`)
  log.info(color.dim('  Check dataSource / promptField / outDir, then run `asset-factory prompts`.'))
  return 0
}

async function cmdPrompts(options: Options): Promise<number> {
  const manifest = await load(options)
  const written = await writePrompts(manifest)
  if (options.json) {
    console.log(JSON.stringify({ ...written, sheetPath: undefined }, null, 2))
    return 0
  }
  const root = manifest.config.root
  log.ok(`${short(root, written.sheetPath)} — ${written.count} prompts`)
  log.ok(`${short(root, written.jsonPath)} — machine-readable twin`)
  return 0
}

async function cmdImport(options: Options): Promise<number> {
  const manifest = await load(options)
  const item = resolveGroup(manifest.config, 'image', options.group) as ImageItem
  const result = await importImages(manifest, item, {
    skipExisting: options.skipExisting,
    only: options.only,
  })

  const state = await loadState(manifest.config.root)
  const byId = new Map(manifest.assets.filter((a) => a.group === item.name).map((a) => [a.id, a]))

  for (const file of result.imported) {
    log.ok(`${file.source}  →  ${file.outFile}  ${color.dim(formatBytes(file.bytes))}`)
    const asset = byId.get(file.id)
    if (asset) record(state, asset, 'done')
  }
  for (const id of result.skipped) log.skip(`skip ${id} (already imported)`)
  await saveState(manifest.config.root, state)

  if (result.unmatched.length > 0) {
    log.warn(
      `${result.unmatched.length} file(s) in ${manifest.config.incomingDir}/ match no ${manifest.config.idField} — rename them:`,
    )
    for (const file of result.unmatched) log.info(`   ${file}`)
  }

  log.info(`\nImported ${result.imported.length}.`)

  // The coverage summary is informational: import did its job if it converted
  // what was in the drop folder. `audit` is the command whose exit code means
  // "the set is complete".
  reportAudit(await audit(manifest), options)
  return 0
}

function seconds(value: number): string {
  return `${value.toFixed(1)}s`
}

async function cmdTts(options: Options): Promise<number> {
  const manifest = await load(options)
  const item = resolveGroup(manifest.config, 'tts', options.group) as TtsItem

  log.info(`Synthesizing ${color.bold(item.name)} with ${color.cyan(item.voice ?? '(no voice set)')}`)

  const result = await generateTts(manifest, item, {
    force: options.force,
    skipExisting: options.skipExisting,
    only: options.only,
    concurrency: options.concurrency,
    timeoutMs: options.timeoutMs,
    retries: options.retries,
    onDone: (asset, clip) =>
      log.ok(`${asset.id} ${color.dim(`${seconds(clip.durationSec)} · ${formatBytes(clip.bytes)}`)}`),
    onSkip: (asset, reason) => log.skip(`skip ${asset.id} (${reason})`),
    onRetry: (asset, attempt, error) => log.warn(`retry ${attempt} for ${asset.id}: ${error.message}`),
    onFail: (asset, error) => log.error(`${asset.id}: ${error.message}`),
  })

  const clips = Object.values(result.manifest.clips)
  const totalSec = clips.reduce((sum, c) => sum + c.durationSec, 0)
  const totalBytes = clips.reduce((sum, c) => sum + c.bytes, 0)

  log.info(
    `\nMade ${result.made.length}, skipped ${result.skipped.length}, failed ${result.failed.length}. ` +
      `${clips.length} clip(s), ${seconds(totalSec)} of audio, ${formatBytes(totalBytes)}.`,
  )
  log.ok(`${short(manifest.config.root, result.manifestPath)}`)

  if (result.failed.length > 0) {
    log.info(color.dim(`  Rerun \`asset-factory tts\` to retry just the failures.`))
    return 1
  }
  return 0
}

async function cmdAudit(options: Options): Promise<number> {
  const manifest = await load(options)
  return reportAudit(await audit(manifest), options)
}

function reportAudit(report: AuditReport, options: Options): number {
  if (options.json) {
    console.log(JSON.stringify(report, null, 2))
    return report.complete ? 0 : 1
  }

  log.heading(`${report.app} — ${report.present}/${report.total} assets`)
  for (const group of report.groups) {
    const done = group.present === group.total
    const tally = `${group.present}/${group.total}`
    log.info(
      `  ${done ? color.green('●') : color.yellow('○')} ${group.group} ${color.dim(`(${group.kind} → ${group.outDir})`)} ` +
        `${done ? color.green(tally) : color.yellow(tally)} ${color.dim(formatBytes(group.bytes))}`,
    )
    if (group.missing.length > 0) log.info(`      missing: ${group.missing.join(', ')}`)
    for (const failure of group.failed) {
      log.info(`      ${color.red('failed')} ${failure.id}${failure.error ? `: ${failure.error}` : ''}`)
    }
    if (group.orphans.length > 0) {
      log.info(color.dim(`      orphan files (no matching record): ${group.orphans.join(', ')}`))
    }
  }

  if (report.complete) {
    log.info(`\n${color.green('🎉 Every asset is present.')}`)
    return 0
  }
  log.info(`\n${color.yellow(`${report.total - report.present} asset(s) still missing.`)}`)
  return 1
}

async function cmdGenerate(options: Options): Promise<number> {
  if (!options.backend) {
    throw new UserError(
      'generate needs --backend <gemini|manual>.',
      'gemini = Gemini image API, manual = write the prompt sheet and stop.',
    )
  }

  const manifest = await load(options)
  const item = resolveGroup(manifest.config, 'image', options.group) as ImageItem
  const adapter = resolveBackend(options.backend, { timeoutMs: options.timeoutMs })

  log.info(`Generating ${color.bold(item.name)} with ${color.cyan(adapter.name)}`)

  const result = await generateImages(manifest, item, adapter, {
    force: options.force,
    skipExisting: options.skipExisting,
    only: options.only,
    onStart: (asset) => log.info(`${color.dim('…')} ${asset.id}`),
    onDone: (asset, file) => log.ok(`${asset.id}  ${color.dim(short(manifest.config.root, file))}`),
    onSkip: (asset, reason) => log.skip(`skip ${asset.id} (${reason})`),
    onFail: (asset, error) => log.error(`${asset.id}: ${error.message}`),
  })

  log.info(`\nMade ${result.made.length}, skipped ${result.skipped.length}, failed ${result.failed.length}.`)

  if (adapter.name === 'manual') {
    log.info(color.dim(`  Drop PNGs named by id into ${manifest.config.incomingDir}/, then \`asset-factory import\`.`))
  } else if (result.made.length > 0) {
    log.info(color.dim(`  Next: \`asset-factory import\` to convert incoming PNGs into ${item.outDir}.`))
  }

  return result.failed.length > 0 ? 1 : 0
}

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      cwd: { type: 'string' },
      config: { type: 'string' },
      group: { type: 'string' },
      only: { type: 'string' },
      concurrency: { type: 'string' },
      timeout: { type: 'string' },
      retries: { type: 'string' },
      backend: { type: 'string' },
      json: { type: 'boolean', default: false },
      force: { type: 'boolean', default: false },
      'skip-existing': { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
      version: { type: 'boolean', short: 'v', default: false },
    },
  })

  const command = positionals[0]

  if (values.version) {
    console.log(VERSION)
    return 0
  }
  if (values.help || !command) {
    console.log(USAGE)
    return command ? 0 : 1
  }

  /** Parse a numeric flag, rejecting junk up front rather than deep in a run. */
  const numeric = (flag: string, raw: string | undefined, min: number): number | undefined => {
    if (raw === undefined) return undefined
    const value = Number(raw)
    if (!Number.isInteger(value) || value < min) {
      throw new UserError(`--${flag} must be an integer >= ${min}, got "${raw}".`)
    }
    return value
  }

  const options: Options = {
    cwd: values.cwd,
    config: values.config,
    group: values.group,
    json: values.json,
    force: values.force,
    skipExisting: values['skip-existing'],
    only: values.only?.split(',').map((s) => s.trim()).filter(Boolean),
    backend: values.backend,
    concurrency: numeric('concurrency', values.concurrency, 1),
    timeoutMs: numeric('timeout', values.timeout, 1),
    retries: numeric('retries', values.retries, 0),
  }

  switch (command) {
    case 'init':
      return cmdInit(options)
    case 'prompts':
      return cmdPrompts(options)
    case 'import':
      return cmdImport(options)
    case 'audit':
      return cmdAudit(options)
    case 'tts':
      return cmdTts(options)
    case 'generate':
      return cmdGenerate(options)
    default:
      log.error(`Unknown command "${command}".`)
      console.log(USAGE)
      return 1
  }
}

try {
  process.exitCode = await main(process.argv.slice(2))
} catch (err) {
  if (err instanceof UserError) {
    log.error(err.message)
    if (err.hint) log.info(color.dim(`  ${err.hint}`))
    process.exitCode = 1
  } else {
    throw err
  }
}
