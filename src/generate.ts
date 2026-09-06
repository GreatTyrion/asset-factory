// Drive one image backend across a manifest. Adapters write PNGs into the
// app's incoming folder; `asset-factory import` then normalizes them to the
// configured format/size. Skipping is about the incoming file (resume) and,
// with --skip-existing, also the final asset so Gemini can no-op like gourmet.

import { mkdir } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { GeminiAdapter } from './backend/gemini.ts'
import { ManualAdapter } from './backend/manual.ts'
import { allowedBackends, isBackendName, type BackendAdapter, type GenerateItem } from './backend/types.ts'
import type { ImageItem } from './config.ts'
import { UserError } from './log.ts'
import type { Asset, Manifest } from './manifest.ts'
import { loadState, record, saveState } from './state.ts'

export interface GenerateOptions {
  force?: boolean
  /** Also skip when the *final* asset (webp etc.) already exists. */
  skipExisting?: boolean
  only?: string[]
  onStart?: (asset: Asset) => void
  onDone?: (asset: Asset, file: string) => void
  onSkip?: (asset: Asset, reason: 'exists' | 'incoming' | 'manual') => void
  onFail?: (asset: Asset, error: Error) => void
}

export interface GenerateImagesResult {
  made: string[]
  skipped: string[]
  failed: { id: string; error: string }[]
}

export function incomingPath(root: string, incomingDir: string, id: string): string {
  return join(root, incomingDir, `${id}.png`)
}

// Stable per-id seed (FNV-1a 32-bit) so reruns of the same dish don't wander.
export function seedFor(id: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

export function resolveBackend(name: string, options: { timeoutMs?: number } = {}): BackendAdapter {
  if (!isBackendName(name)) {
    throw new UserError(
      `Unknown image backend "${name}".`,
      `Pass --backend ${allowedBackends()}.`,
    )
  }
  switch (name) {
    case 'gemini':
      return new GeminiAdapter()
    case 'manual':
      return new ManualAdapter()
  }
}

export async function generateImages(
  manifest: Manifest,
  item: ImageItem,
  adapter: BackendAdapter,
  options: GenerateOptions = {},
): Promise<GenerateImagesResult> {
  const { config } = manifest
  await adapter.prepare?.(manifest)
  await mkdir(join(config.root, config.incomingDir), { recursive: true })

  const all = manifest.assets.filter((a) => a.group === item.name && a.kind === 'image')
  const assets = options.only ? all.filter((a) => options.only!.includes(a.id)) : all

  const state = await loadState(config.root)
  const made: string[] = []
  const skipped: string[] = []
  const failed: { id: string; error: string }[] = []

  for (const asset of assets) {
    const dest = incomingPath(config.root, config.incomingDir, asset.id)
    const generateItem: GenerateItem = {
      id: asset.id,
      prompt: asset.prompt ?? '',
      outFile: dest,
      seed: seedFor(asset.id),
    }

    if (!options.force) {
      if (options.skipExisting && existsSync(asset.outFile)) {
        skipped.push(asset.id)
        options.onSkip?.(asset, 'exists')
        continue
      }
      if (existsSync(dest)) {
        skipped.push(asset.id)
        options.onSkip?.(asset, 'incoming')
        continue
      }
    }

    options.onStart?.(asset)
    try {
      const result = await adapter.generate(generateItem, config.styleGuide)
      if (result.skipped) {
        skipped.push(asset.id)
        options.onSkip?.(asset, adapter.name === 'manual' ? 'manual' : 'incoming')
        continue
      }
      made.push(asset.id)
      record(state, asset, 'done')
      options.onDone?.(asset, result.file)
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err))
      failed.push({ id: asset.id, error: error.message })
      record(state, asset, 'failed', error.message)
      options.onFail?.(asset, error)
      if (err instanceof UserError) {
        // Config / environment mistakes (no server, no key) fail the run;
        // don't keep asking the same broken backend for every remaining id.
        await saveState(config.root, state)
        throw err
      }
    }
  }

  await saveState(config.root, state)
  return { made, skipped, failed }
}
