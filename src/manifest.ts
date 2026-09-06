// Expand the app's own data module into a flat asset manifest.
//
// Nothing is copied: the manifest is derived on every run, so adding a dish to
// foods.ts is all it takes for the factory to know about one more image.

import { existsSync } from 'node:fs'
import { join, relative, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { itemExt, type FactoryConfig, type Item } from './config.ts'
import { UserError } from './log.ts'

export interface Asset {
  /** Item group name — "image", "tts", or a custom name. */
  group: string
  kind: Item['kind']
  /** Value of the config's idField; doubles as the output filename stem. */
  id: string
  /** Human-readable heading, from labelField. */
  label: string
  /** Bucket from groupField, if configured. */
  section?: string
  /** kind=image: per-record art direction with the shared style appended. */
  prompt?: string
  /** kind=image: the art direction as written in the data module. */
  rawPrompt?: string
  /** kind=tts: the text to read aloud. */
  text?: string
  lang?: string
  voice?: string
  /** Absolute output path. */
  outFile: string
  /** Output path relative to the app root, for display. */
  relOutFile: string
}

export interface Manifest {
  config: FactoryConfig
  /** The raw records as exported by the app. */
  records: Record<string, unknown>[]
  assets: Asset[]
}

/** `prompt` as the generator sees it: record art direction + shared style. */
export function buildPrompt(rawPrompt: string, styleGuide?: string): string {
  return styleGuide ? `${rawPrompt}. ${styleGuide}` : rawPrompt
}

async function loadRecords(config: FactoryConfig): Promise<Record<string, unknown>[]> {
  const modPath = resolve(config.root, config.dataSource)
  if (!existsSync(modPath)) {
    throw new UserError(
      `Data source not found: ${modPath}`,
      `"dataSource" in ${config.file} is resolved relative to the app root (${config.root}).`,
    )
  }

  let mod: Record<string, unknown>
  try {
    mod = (await import(pathToFileURL(modPath).href)) as Record<string, unknown>
  } catch (err) {
    throw new UserError(
      `Could not import ${config.dataSource}: ${(err as Error).message}`,
      `The module must be importable by plain Node (TypeScript is type-stripped, so no enums / namespaces / decorators).`,
    )
  }

  const exported = Object.keys(mod).filter((k) => k !== '__esModule')

  if (config.dataExport) {
    const value = mod[config.dataExport]
    if (!Array.isArray(value)) {
      throw new UserError(
        `${config.dataSource} has no exported array named "${config.dataExport}".`,
        `Exports found: ${exported.join(', ') || '(none)'}`,
      )
    }
    return value
  }

  if (Array.isArray(mod.default)) return mod.default

  const arrays = exported.filter((k) => Array.isArray(mod[k]))
  if (arrays.length === 1) return mod[arrays[0]!] as Record<string, unknown>[]

  throw new UserError(
    arrays.length === 0
      ? `${config.dataSource} does not export an array.`
      : `${config.dataSource} exports several arrays (${arrays.join(', ')}), so the right one is ambiguous.`,
    `Set "dataExport" in ${config.file}. Exports found: ${exported.join(', ') || '(none)'}`,
  )
}

function readString(record: Record<string, unknown>, field: string): string | undefined {
  const value = record[field]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

/** Read the config's data module and expand it into one asset per record per item. */
export async function buildManifest(config: FactoryConfig): Promise<Manifest> {
  const records = await loadRecords(config)

  if (records.length === 0) {
    throw new UserError(`${config.dataSource} exported an empty array — nothing to build.`)
  }

  const problems: string[] = []
  const assets: Asset[] = []
  const seenIds = new Map<string, number>()

  records.forEach((record, i) => {
    const where = `${config.dataSource}[${i}]`
    const id = readString(record, config.idField)
    if (!id) {
      problems.push(`${where}: missing "${config.idField}" (the id field) or it is not a non-empty string`)
      return
    }
    if (seenIds.has(id)) {
      problems.push(`${where}: duplicate ${config.idField} "${id}" (already used by record #${seenIds.get(id)})`)
      return
    }
    seenIds.set(id, i)

    const label = readString(record, config.labelField) ?? id
    const section = config.groupField ? readString(record, config.groupField) : undefined

    for (const item of config.items) {
      const outFile = join(config.root, item.outDir, `${id}.${itemExt(item)}`)
      const base: Asset = {
        group: item.name,
        kind: item.kind,
        id,
        label,
        section,
        outFile,
        relOutFile: relative(config.root, outFile),
      }

      if (item.kind === 'image') {
        const rawPrompt = readString(record, item.promptField)
        if (!rawPrompt) {
          problems.push(`${where} (${config.idField}="${id}"): missing "${item.promptField}", required by items."${item.name}"`)
          continue
        }
        assets.push({ ...base, rawPrompt, prompt: buildPrompt(rawPrompt, config.styleGuide) })
      } else {
        const text = readString(record, item.textField)
        if (!text) {
          problems.push(`${where} (${config.idField}="${id}"): missing "${item.textField}", required by items."${item.name}"`)
          continue
        }
        assets.push({ ...base, text, lang: item.lang, voice: item.voice })
      }
    }
  })

  if (problems.length > 0) {
    throw new UserError(
      `${config.dataSource} does not match ${config.file}:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
      `Either add the fields to the data module, or point the config at the fields it actually has.`,
    )
  }

  return { config, records, assets }
}

/** Assets of one item group; used by commands that act on a single group. */
export function assetsOfGroup(manifest: Manifest, group: string): Asset[] {
  return manifest.assets.filter((a) => a.group === group)
}

/**
 * Pick the item group a command should act on: an explicit `--group`, or the
 * only group of that kind. Ambiguity is an error, never a silent guess.
 */
export function resolveGroup(config: FactoryConfig, kind: Item['kind'], requested?: string): Item {
  if (requested) {
    const found = config.items.find((it) => it.name === requested)
    if (!found) {
      throw new UserError(
        `No item group named "${requested}" in ${config.file}.`,
        `Available groups: ${config.items.map((it) => `${it.name} (${it.kind})`).join(', ')}`,
      )
    }
    if (found.kind !== kind) {
      throw new UserError(`Item group "${requested}" has kind "${found.kind}", but this command needs kind "${kind}".`)
    }
    return found
  }

  const candidates = config.items.filter((it) => it.kind === kind)
  if (candidates.length === 0) {
    throw new UserError(
      `${config.file} declares no item of kind "${kind}".`,
      `Add one to "items", e.g. { "kind": "${kind}", "outDir": "public/..." }.`,
    )
  }
  if (candidates.length > 1) {
    throw new UserError(
      `${config.file} declares ${candidates.length} "${kind}" groups, so the target is ambiguous.`,
      `Pass --group <name>. Available: ${candidates.map((c) => c.name).join(', ')}`,
    )
  }
  return candidates[0]!
}
