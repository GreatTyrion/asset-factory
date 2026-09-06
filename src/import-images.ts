// Take hand-made images out of the drop folder and normalize them into the app.
//
// Replaces the three near-identical copies of this logic (gourmet's
// import-images.mjs, marine's, and the image-prompt-studio skill's).

import { mkdir, readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import sharp from 'sharp'
import type { ImageItem } from './config.ts'
import { UserError } from './log.ts'
import type { Asset, Manifest } from './manifest.ts'

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp', '.avif', '.gif', '.tif', '.tiff'])

export interface ImportedFile {
  source: string
  id: string
  outFile: string
  bytes: number
}

export interface ImportResult {
  imported: ImportedFile[]
  /** Files already present in outDir and left alone (--skip-existing). */
  skipped: string[]
  /** Files in the drop folder whose name matches no record id. */
  unmatched: string[]
  incomingDir: string
  outDir: string
}

export interface ImportOptions {
  skipExisting?: boolean
  /** Convert only these ids. */
  only?: string[]
}

/** Encode one buffer/file to the item's format and square size. */
async function convert(source: string, outFile: string, item: ImageItem): Promise<number> {
  const pipeline = sharp(source).resize(item.size, item.size, { fit: item.fit })
  switch (item.format) {
    case 'webp':
      pipeline.webp({ quality: item.quality })
      break
    case 'png':
      pipeline.png()
      break
    case 'jpeg':
      pipeline.jpeg({ quality: item.quality })
      break
    case 'avif':
      pipeline.avif({ quality: item.quality })
      break
  }
  const info = await pipeline.toFile(outFile)
  return info.size
}

export async function importImages(
  manifest: Manifest,
  item: ImageItem,
  options: ImportOptions = {},
): Promise<ImportResult> {
  const { config } = manifest
  const incomingDir = join(config.root, config.incomingDir)
  const outDir = join(config.root, item.outDir)

  await mkdir(outDir, { recursive: true })

  if (!existsSync(incomingDir)) {
    await mkdir(incomingDir, { recursive: true })
    throw new UserError(
      `Drop folder was empty — created ${incomingDir}.`,
      `Save your images there named by ${config.idField} (e.g. ${manifest.assets[0]?.id ?? 'item-id'}.png), then rerun \`asset-factory import\`.`,
    )
  }

  const byId = new Map<string, Asset>()
  for (const asset of manifest.assets) {
    if (asset.group === item.name) byId.set(asset.id, asset)
  }

  const entries = (await readdir(incomingDir)).filter((f) => IMAGE_EXTENSIONS.has(extname(f).toLowerCase()))
  entries.sort()

  const result: ImportResult = { imported: [], skipped: [], unmatched: [], incomingDir, outDir }

  for (const file of entries) {
    const id = basename(file, extname(file)).trim()
    const asset = byId.get(id)
    if (!asset) {
      result.unmatched.push(file)
      continue
    }
    if (options.only && !options.only.includes(id)) continue
    if (options.skipExisting && existsSync(asset.outFile)) {
      result.skipped.push(id)
      continue
    }

    const source = join(incomingDir, file)
    if ((await stat(source)).isDirectory()) continue

    const bytes = await convert(source, asset.outFile, item)
    result.imported.push({ source: file, id, outFile: asset.relOutFile, bytes })
  }

  return result
}
