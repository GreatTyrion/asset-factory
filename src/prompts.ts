// Produce the two prompt artifacts:
//   - image-prompts.md    copy-paste sheet for making images by hand
//   - .asset-factory/prompts.json   the same prompts, machine-readable, for `generate`
//
// Both are pure functions of the config + data module, so reruns are byte-stable
// (no timestamps) and a `git diff` after adding a dish shows only that dish.

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { STATE_DIR, itemExt, type ImageItem } from './config.ts'
import type { Asset, Manifest } from './manifest.ts'

export interface PromptEntry {
  id: string
  label: string
  section?: string
  /** Art direction as written in the data module. */
  rawPrompt: string
  /** What a generator should actually send: rawPrompt + shared style. */
  prompt: string
  outFile: string
}

export interface PromptsJson {
  app: string
  styleGuide?: string
  groups: {
    name: string
    outDir: string
    format: string
    size: number
    count: number
    prompts: PromptEntry[]
  }[]
}

function bucket(assets: Asset[]): Map<string, Asset[]> {
  const out = new Map<string, Asset[]>()
  for (const asset of assets) {
    const key = asset.section ?? ''
    const list = out.get(key)
    if (list) list.push(asset)
    else out.set(key, [asset])
  }
  return out
}

/** The copy-paste markdown sheet. */
export function renderSheet(manifest: Manifest): string {
  const { config } = manifest
  const imageItems = config.items.filter((it): it is ImageItem => it.kind === 'image')
  const imageAssets = manifest.assets.filter((a) => a.kind === 'image')
  const example = imageAssets[0]?.id ?? 'item-id'
  const total = imageAssets.length
  const single = imageItems[0]

  let md = `# 图片提示词 / Hero image prompt sheet\n\n`
  md +=
    `Generate each image by hand (Gemini app, AI Studio, anything), then **download and save it named by its id**\n` +
    `(e.g. \`${example}.png\`) into the \`${config.incomingDir}/\` folder. When done, run \`npx asset-factory import\`\n` +
    `and every file becomes \`${single ? `${single.outDir}/{id}.${single.format}` : '{outDir}/{id}'}\`.\n`

  if (config.styleGuide) {
    md += `\nShared style (already appended to every prompt below):\n\n> ${config.styleGuide}\n`
  }

  md += `\nTotal: ${total} images.\n`

  for (const item of imageItems) {
    const assets = imageAssets.filter((a) => a.group === item.name)
    if (imageItems.length > 1) md += `\n# ${item.name} → ${item.outDir}\n`

    for (const [section, items] of bucket(assets)) {
      if (section) md += `\n## ${section}\n`
      for (const asset of items) {
        md += `\n### ${asset.label} — save as \`${asset.id}\`\n\n`
        md += '```\n' + asset.prompt + '\n```\n'
      }
    }
  }

  return md
}

/** The machine-readable twin of the sheet. */
export function buildPromptsJson(manifest: Manifest): PromptsJson {
  const { config } = manifest
  return {
    app: config.name,
    styleGuide: config.styleGuide,
    groups: config.items
      .filter((it): it is ImageItem => it.kind === 'image')
      .map((item) => {
        const prompts = manifest.assets
          .filter((a) => a.group === item.name)
          .map<PromptEntry>((a) => ({
            id: a.id,
            label: a.label,
            ...(a.section ? { section: a.section } : {}),
            rawPrompt: a.rawPrompt!,
            prompt: a.prompt!,
            outFile: a.relOutFile,
          }))
        return {
          name: item.name,
          outDir: item.outDir,
          format: itemExt(item),
          size: item.size,
          count: prompts.length,
          prompts,
        }
      }),
  }
}

export interface WrittenPrompts {
  sheetPath: string
  jsonPath: string
  count: number
}

export async function writePrompts(manifest: Manifest): Promise<WrittenPrompts> {
  const { config } = manifest
  const sheetPath = join(config.root, config.promptSheet)
  const jsonPath = join(config.root, STATE_DIR, 'prompts.json')
  const json = buildPromptsJson(manifest)

  await mkdir(dirname(sheetPath), { recursive: true })
  await mkdir(dirname(jsonPath), { recursive: true })
  await writeFile(sheetPath, renderSheet(manifest), 'utf8')
  await writeFile(jsonPath, `${JSON.stringify(json, null, 2)}\n`, 'utf8')

  return {
    sheetPath,
    jsonPath,
    count: json.groups.reduce((sum, g) => sum + g.count, 0),
  }
}
