// Per-app progress file: .asset-factory/state.json
//
// Generation is the slow, failure-prone step (network APIs, local GPU), so every
// asset's outcome is recorded and a rerun can pick up where it stopped.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { STATE_DIR } from './config.ts'
import type { Asset } from './manifest.ts'

export const STATE_VERSION = 1

export type AssetStatus = 'pending' | 'done' | 'failed'

export interface AssetState {
  status: AssetStatus
  updatedAt: string
  /** Output path relative to the app root, when the asset was produced. */
  file?: string
  error?: string
}

export interface FactoryState {
  version: number
  updatedAt: string
  assets: Record<string, AssetState>
}

/** Stable state key for an asset — group + id, so groups never collide. */
export function stateKey(asset: Pick<Asset, 'group' | 'id'>): string {
  return `${asset.group}:${asset.id}`
}

export function stateFilePath(root: string): string {
  return join(root, STATE_DIR, 'state.json')
}

function empty(): FactoryState {
  return { version: STATE_VERSION, updatedAt: new Date().toISOString(), assets: {} }
}

/** Read state, treating a missing or corrupt file as "nothing done yet". */
export async function loadState(root: string): Promise<FactoryState> {
  try {
    const parsed = JSON.parse(await readFile(stateFilePath(root), 'utf8')) as FactoryState
    if (parsed?.version !== STATE_VERSION || typeof parsed.assets !== 'object') return empty()
    return { ...empty(), ...parsed, assets: parsed.assets ?? {} }
  } catch {
    return empty()
  }
}

export async function saveState(root: string, state: FactoryState): Promise<void> {
  const file = stateFilePath(root)
  await mkdir(join(root, STATE_DIR), { recursive: true })
  state.updatedAt = new Date().toISOString()
  await writeFile(file, `${JSON.stringify(state, null, 2)}\n`, 'utf8')
}

export function record(
  state: FactoryState,
  asset: Pick<Asset, 'group' | 'id' | 'relOutFile'>,
  status: AssetStatus,
  error?: string,
): void {
  state.assets[stateKey(asset)] = {
    status,
    updatedAt: new Date().toISOString(),
    ...(status === 'done' ? { file: asset.relOutFile } : {}),
    ...(error ? { error } : {}),
  }
}
