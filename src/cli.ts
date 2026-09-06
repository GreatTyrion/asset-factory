#!/usr/bin/env node
// asset-factory — batch image + voice-over pipeline for the kids apps.
//
// Run from a target app root (or pass --cwd / --config). Every command reads
// that app's factory.config.json and its own data module; nothing is duplicated.

import { relative } from 'node:path'
import { parseArgs } from 'node:util'
import { audit, formatBytes, type AuditReport } from './audit.ts'
import { loadConfig, type ImageItem } from './config.ts'
import { importImages } from './import-images.ts'
import { initConfig } from './init.ts'
import { UserError, color, log } from './log.ts'
import { buildManifest, resolveGroup, type Manifest } from './manifest.ts'
import { writePrompts } from './prompts.ts'
import { loadState, record, saveState } from './state.ts'

const VERSION = '0.1.0'

const USAGE = `${color.bold('asset-factory')} ${color.dim(`v${VERSION}`)} — image + voice-over pipeline for the kids apps

${color.bold('Usage')}
  asset-factory <command> [options]

${color.bold('Commands')}
  init       Write a starter factory.config.json in this app
  prompts    Write the prompt sheet + .asset-factory/prompts.json
  generate   Produce images through a backend            ${color.dim('(Phase 3)')}
  import     Convert the drop folder into final assets
  tts        Synthesize voice-over with edge-tts          ${color.dim('(Phase 2)')}
  audit      Coverage report: manifest vs. files on disk

${color.bold('Options')}
  --cwd <dir>        App root to operate on (default: current folder)
  --config <file>    Explicit factory.config.json path
  --group <name>     Item group to act on, when the config has several
  --json             Machine-readable output (audit, prompts)
  --force            init: overwrite an existing config
  --skip-existing    import: leave assets that already exist alone
  --only <ids>       Comma-separated ids to act on
  -h, --help         Show this help
  -v, --version      Show the version
`

interface Options {
  cwd?: string
  config?: string
  group?: string
  json: boolean
  force: boolean
  skipExisting: boolean
  only?: string[]
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

function notYet(command: string, phase: string, next: string): number {
  log.error(`\`${command}\` is not implemented yet (${phase}).`)
  log.info(color.dim(`  For now: ${next}`))
  return 2
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

  const options: Options = {
    cwd: values.cwd,
    config: values.config,
    group: values.group,
    json: values.json,
    force: values.force,
    skipExisting: values['skip-existing'],
    only: values.only?.split(',').map((s) => s.trim()).filter(Boolean),
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
    case 'generate':
      return notYet('generate', 'Phase 3 — pluggable image backends', 'run `asset-factory prompts`, make the images by hand, then `asset-factory import`.')
    case 'tts':
      return notYet('tts', 'Phase 2 — edge-tts voice-over', 'the apps still synthesize speech at runtime.')
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
