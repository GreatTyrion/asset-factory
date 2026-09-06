// Coverage report: what the manifest says should exist vs. what is on disk.
//
// Disk is the source of truth here, not state.json — a file deleted by hand
// shows up as missing even if a previous run recorded it as done.

import { readdir, stat } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { basename, extname, join } from 'node:path'
import { itemExt } from './config.ts'
import type { Manifest } from './manifest.ts'
import { loadState, stateKey } from './state.ts'

export interface GroupReport {
  group: string
  kind: string
  outDir: string
  total: number
  present: number
  missing: string[]
  /** Files in outDir with the right extension but no matching record. */
  orphans: string[]
  /** Assets a previous run recorded as failed and that are still missing. */
  failed: { id: string; error?: string }[]
  bytes: number
}

export interface AuditReport {
  app: string
  root: string
  complete: boolean
  total: number
  present: number
  groups: GroupReport[]
}

export async function audit(manifest: Manifest): Promise<AuditReport> {
  const { config } = manifest
  const state = await loadState(config.root)
  const groups: GroupReport[] = []

  for (const item of config.items) {
    const assets = manifest.assets.filter((a) => a.group === item.name)
    const outDir = join(config.root, item.outDir)
    const ext = `.${itemExt(item)}`

    const report: GroupReport = {
      group: item.name,
      kind: item.kind,
      outDir: item.outDir,
      total: assets.length,
      present: 0,
      missing: [],
      orphans: [],
      failed: [],
      bytes: 0,
    }

    for (const asset of assets) {
      if (existsSync(asset.outFile)) {
        report.present++
        report.bytes += (await stat(asset.outFile)).size
      } else {
        report.missing.push(asset.id)
        const recorded = state.assets[stateKey(asset)]
        if (recorded?.status === 'failed') report.failed.push({ id: asset.id, error: recorded.error })
      }
    }

    if (existsSync(outDir)) {
      const known = new Set(assets.map((a) => a.id))
      for (const file of await readdir(outDir)) {
        if (extname(file).toLowerCase() !== ext) continue
        const id = basename(file, extname(file))
        if (!known.has(id)) report.orphans.push(file)
      }
      report.orphans.sort()
    }

    groups.push(report)
  }

  const total = groups.reduce((sum, g) => sum + g.total, 0)
  const present = groups.reduce((sum, g) => sum + g.present, 0)

  return { app: config.name, root: config.root, complete: total === present, total, present, groups }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}
