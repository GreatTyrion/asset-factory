import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { STATE_VERSION, loadState, record, saveState, stateFilePath, stateKey } from '../src/state.ts'
import { loadDemo, type DemoApp } from './helpers.ts'

let apps: DemoApp[] = []

async function demo() {
  const result = await loadDemo()
  apps.push(result.app)
  return result
}

afterEach(async () => {
  await Promise.all(apps.map((a) => a.cleanup()))
  apps = []
})

describe('state', () => {
  it('keys assets by group so two groups never collide', () => {
    expect(stateKey({ group: 'image', id: 'apple' })).toBe('image:apple')
    expect(stateKey({ group: 'tts', id: 'apple' })).toBe('tts:apple')
  })

  it('starts empty when nothing has run yet', async () => {
    const { app } = await demo()
    const state = await loadState(app.root)
    expect(state).toMatchObject({ version: STATE_VERSION, assets: {} })
  })

  it('survives a round trip through disk', async () => {
    const { app, manifest } = await demo()
    const state = await loadState(app.root)
    record(state, manifest.assets[0]!, 'done')
    record(state, manifest.assets[1]!, 'failed', 'quota exceeded')
    await saveState(app.root, state)

    const reloaded = await loadState(app.root)
    expect(reloaded.assets['image:apple']).toMatchObject({
      status: 'done',
      file: join('public', 'images', 'apple.webp'),
    })
    expect(reloaded.assets['image:banana']).toMatchObject({ status: 'failed', error: 'quota exceeded' })
    expect(reloaded.assets['image:banana']!.file).toBeUndefined()
  })

  it('writes into .asset-factory/ inside the app', async () => {
    const { app, manifest } = await demo()
    const state = await loadState(app.root)
    record(state, manifest.assets[0]!, 'done')
    await saveState(app.root, state)

    expect(stateFilePath(app.root)).toBe(join(app.root, '.asset-factory', 'state.json'))
    expect(existsSync(stateFilePath(app.root))).toBe(true)
  })

  it('treats a corrupt state file as no progress rather than crashing', async () => {
    const { app } = await demo()
    await mkdir(dirname(stateFilePath(app.root)), { recursive: true })
    await writeFile(stateFilePath(app.root), '{ not json', 'utf8')

    await expect(loadState(app.root)).resolves.toMatchObject({ assets: {} })
  })

  it('discards state written by an incompatible version', async () => {
    const { app } = await demo()
    await mkdir(dirname(stateFilePath(app.root)), { recursive: true })
    await writeFile(
      stateFilePath(app.root),
      JSON.stringify({ version: 999, assets: { 'image:apple': { status: 'done' } } }),
      'utf8',
    )

    await expect(loadState(app.root)).resolves.toMatchObject({ version: STATE_VERSION, assets: {} })
  })

  it('overwrites a previous outcome for the same asset', async () => {
    const { app, manifest } = await demo()
    const state = await loadState(app.root)
    record(state, manifest.assets[0]!, 'failed', 'timeout')
    record(state, manifest.assets[0]!, 'done')

    expect(state.assets['image:apple']).toMatchObject({ status: 'done' })
    expect(state.assets['image:apple']!.error).toBeUndefined()
  })
})
