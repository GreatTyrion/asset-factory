// Load + validate a target app's factory.config.json.
//
// Structural checks come from factory.config.schema.json (the same file editors
// use for autocomplete); the kind-specific rules that JSON Schema states poorly
// are checked afterwards so the message can name the exact missing field.

import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Ajv, type ErrorObject } from 'ajv'
import { UserError } from './log.ts'

export const CONFIG_FILENAME = 'factory.config.json'
export const STATE_DIR = '.asset-factory'

const HERE = dirname(fileURLToPath(import.meta.url))
export const SCHEMA_PATH = resolve(HERE, '..', 'factory.config.schema.json')

export type AssetKind = 'image' | 'tts'

export interface ImageItem {
  kind: 'image'
  name: string
  outDir: string
  promptField: string
  format: 'webp' | 'png' | 'jpeg' | 'avif'
  size: number
  fit: 'cover' | 'contain' | 'inside'
  quality: number
}

export interface TtsItem {
  kind: 'tts'
  name: string
  outDir: string
  textField: string
  lang: string
  voice?: string
}

export type Item = ImageItem | TtsItem

export interface FactoryConfig {
  name: string
  dataSource: string
  dataExport?: string
  idField: string
  labelField: string
  groupField?: string
  incomingDir: string
  promptSheet: string
  styleGuide?: string
  items: Item[]
  /** Absolute path of the app root (the folder holding factory.config.json). */
  root: string
  /** Absolute path of the config file itself. */
  file: string
}

/** File extension produced for an item. */
export function itemExt(item: Item): string {
  return item.kind === 'image' ? item.format : 'mp3'
}

function formatAjvError(err: ErrorObject): string {
  const where = err.instancePath ? err.instancePath.replace(/^\//, '').replace(/\/(\d+)/g, '[$1]').replace(/\//g, '.') : '(root)'
  if (err.keyword === 'required') {
    return `${where}: missing required field "${(err.params as { missingProperty: string }).missingProperty}"`
  }
  if (err.keyword === 'additionalProperties') {
    return `${where}: unknown field "${(err.params as { additionalProperty: string }).additionalProperty}"`
  }
  if (err.keyword === 'enum') {
    const allowed = (err.params as { allowedValues: unknown[] }).allowedValues
    return `${where}: must be one of ${allowed.map((v) => JSON.stringify(v)).join(', ')}`
  }
  return `${where}: ${err.message ?? 'invalid'}`
}

/** Walk up from `start` looking for factory.config.json. */
export function findConfigFile(start: string): string | undefined {
  let dir = resolve(start)
  for (;;) {
    const candidate = join(dir, CONFIG_FILENAME)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

/**
 * Read, schema-validate and normalize the config.
 * `pathOrDir` may be the config file, the app root, or any folder below it.
 */
export async function loadConfig(pathOrDir: string): Promise<FactoryConfig> {
  const target = resolve(pathOrDir)
  const file = target.endsWith('.json') ? target : findConfigFile(target)

  if (!file || !existsSync(file)) {
    throw new UserError(
      `No ${CONFIG_FILENAME} found in ${target} or any parent folder.`,
      `Run \`asset-factory init\` in the app root to create one.`,
    )
  }

  let raw: unknown
  const text = await readFile(file, 'utf8')
  try {
    raw = JSON.parse(text)
  } catch (err) {
    throw new UserError(`${file} is not valid JSON: ${(err as Error).message}`)
  }

  const schema = JSON.parse(await readFile(SCHEMA_PATH, 'utf8'))
  const ajv = new Ajv({ allErrors: true, strict: false })
  const validate = ajv.compile(schema)

  if (!validate(raw)) {
    const lines = (validate.errors ?? []).map((e) => `  - ${formatAjvError(e)}`)
    throw new UserError(
      `${file} does not match the config schema:\n${lines.join('\n')}`,
      `Schema: ${SCHEMA_PATH}`,
    )
  }

  const cfg = raw as Record<string, any>
  const root = dirname(file)
  const idField = cfg.idField ?? 'id'

  const items: Item[] = cfg.items.map((it: Record<string, any>, i: number) => {
    const name = it.name ?? it.kind
    if (it.kind === 'image') {
      if (!it.promptField) {
        throw new UserError(
          `${file}: items[${i}] has kind "image" but no "promptField".`,
          `Point it at the record field holding the art direction, e.g. "promptField": "imagePrompt".`,
        )
      }
      return {
        kind: 'image',
        name,
        outDir: it.outDir,
        promptField: it.promptField,
        format: it.format ?? 'webp',
        size: it.size ?? 768,
        fit: it.fit ?? 'cover',
        quality: it.quality ?? 82,
      } satisfies ImageItem
    }
    if (!it.textField) {
      throw new UserError(
        `${file}: items[${i}] has kind "tts" but no "textField".`,
        `Point it at the record field to read aloud, e.g. "textField": "intro".`,
      )
    }
    return {
      kind: 'tts',
      name,
      outDir: it.outDir,
      textField: it.textField,
      lang: it.lang ?? 'zh-CN',
      voice: it.voice,
    } satisfies TtsItem
  })

  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.name)) {
      throw new UserError(
        `${file}: two items are both named "${item.name}".`,
        `Give one of them an explicit "name" so reports and state keys stay unambiguous.`,
      )
    }
    seen.add(item.name)
  }

  if (isAbsolute(cfg.dataSource)) {
    throw new UserError(`${file}: "dataSource" must be relative to the app root, got "${cfg.dataSource}".`)
  }

  return {
    name: cfg.name,
    dataSource: cfg.dataSource,
    dataExport: cfg.dataExport,
    idField,
    labelField: cfg.labelField ?? idField,
    groupField: cfg.groupField,
    incomingDir: cfg.incomingDir ?? 'incoming-images',
    promptSheet: cfg.promptSheet ?? 'image-prompts.md',
    styleGuide: cfg.styleGuide,
    items,
    root,
    file,
  }
}
