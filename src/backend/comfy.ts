// ComfyUI local REST backend.
//
// Probe /system_stats first; refuse to queue a prompt when there is no
// checkpoint, with the download command in the hint rather than a stack trace.
// Workflow is API-format JSON; prompt and seed are injected by walking the
// KSampler links so the template can be swapped without rewriting this file.

import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { UserError } from '../log.ts'
import type { BackendAdapter, GenerateItem, GenerateResult } from './types.ts'

export const DEFAULT_COMFY_URL = 'http://127.0.0.1:8188'
export const DEFAULT_CHECKPOINT = 'sd_xl_base_1.0.safetensors'
export const CHECKPOINT_URL =
  'https://huggingface.co/stabilityai/stable-diffusion-xl-base-1.0/resolve/main/sd_xl_base_1.0.safetensors'

/** Shared across dishes so a rerun of the same id lands on the same image. */
export const SEED_FAMILY = 42

const HERE = dirname(fileURLToPath(import.meta.url))
export const DEFAULT_WORKFLOW_PATH = join(HERE, 'workflows', 'sdxl_txt2img.json')

const CHECKPOINT_EXT = /\.(safetensors|ckpt|pt|pth|bin)$/i

export interface WorkflowNode {
  class_type: string
  inputs: Record<string, unknown>
}

export type Workflow = Record<string, WorkflowNode>

export function seedFor(id: string, family = SEED_FAMILY): number {
  const digest = createHash('sha256').update(`${family}:${id}`).digest()
  return (digest.readUInt32BE(0) % 2_147_483_646) + 1
}

function findNode(workflow: Workflow, classType: string): WorkflowNode | undefined {
  for (const node of Object.values(workflow)) {
    if (node && typeof node === 'object' && node.class_type === classType) return node
  }
  return undefined
}

function linkedNode(workflow: Workflow, from: unknown): WorkflowNode | undefined {
  if (!Array.isArray(from) || from.length === 0) return undefined
  const node = workflow[String(from[0])]
  return node?.class_type ? node : undefined
}

/** Clone an API-format workflow and overwrite prompt / seed / save prefix. */
export function injectWorkflow(
  workflow: Record<string, unknown>,
  params: { prompt: string; seed: number; filenamePrefix: string; negative?: string; ckptName?: string },
): Workflow {
  const next: Workflow = {}
  for (const [id, node] of Object.entries(workflow)) {
    if (!node || typeof node !== 'object' || !('class_type' in node) || typeof (node as WorkflowNode).class_type !== 'string') continue
    next[id] = structuredClone(node) as WorkflowNode
  }
  const sampler = findNode(next, 'KSampler')
  if (sampler) {
    sampler.inputs.seed = params.seed
    const positive = linkedNode(next, sampler.inputs.positive)
    if (positive) positive.inputs.text = params.prompt
    if (params.negative) {
      const negative = linkedNode(next, sampler.inputs.negative)
      if (negative) negative.inputs.text = params.negative
    }
  }
  const save = findNode(next, 'SaveImage')
  if (save) save.inputs.filename_prefix = params.filenamePrefix
  if (params.ckptName) {
    const loader = findNode(next, 'CheckpointLoaderSimple')
    if (loader) loader.inputs.ckpt_name = params.ckptName
  }
  return next
}

export interface ComfyAdapterOptions {
  baseUrl?: string
  fetch?: typeof fetch
  workflow?: Workflow
  timeoutMs?: number
  pollMs?: number
}

function asUserError(err: unknown, baseUrl: string): UserError {
  if (err instanceof UserError) return err
  const message = err instanceof Error ? err.message : String(err)
  return new UserError(
    `ComfyUI is not reachable at ${baseUrl} (${message}).`,
    `Start it with \`comfy launch --background\` (workspace ~/ComfyUI), then retry.`,
  )
}

async function getJson(fetchFn: typeof fetch, url: string): Promise<{ ok: boolean; status: number; data: unknown }> {
  const res = await fetchFn(url)
  let data: unknown
  try {
    data = await res.json()
  } catch {
    data = undefined
  }
  return { ok: res.ok, status: res.status, data }
}

function isCheckpoint(name: unknown): name is string {
  return typeof name === 'string' && CHECKPOINT_EXT.test(name)
}

export async function listCheckpoints(baseUrl: string, fetchFn: typeof fetch): Promise<string[]> {
  const listed = await getJson(fetchFn, `${baseUrl}/models/checkpoints`)
  if (listed.ok && Array.isArray(listed.data)) {
    return listed.data.filter(isCheckpoint)
  }

  const info = await getJson(fetchFn, `${baseUrl}/object_info/CheckpointLoaderSimple`)
  if (info.ok && info.data && typeof info.data === 'object') {
    const node = info.data as { input?: { required?: { ckpt_name?: [string[]] } } }
    const names = node.input?.required?.ckpt_name?.[0]
    if (Array.isArray(names)) return names.filter(isCheckpoint)
  }

  return []
}

export async function probeComfy(
  baseUrl: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ checkpoints: string[] }> {
  try {
    const stats = await getJson(fetchFn, `${baseUrl}/system_stats`)
    if (!stats.ok) {
      throw new UserError(
        `ComfyUI at ${baseUrl} responded ${stats.status} to /system_stats.`,
        `Start it with \`comfy launch --background\`, then retry.`,
      )
    }
  } catch (err) {
    throw asUserError(err, baseUrl)
  }

  const checkpoints = await listCheckpoints(baseUrl, fetchFn)
  if (checkpoints.length === 0) {
    throw new UserError(
      `ComfyUI is running at ${baseUrl} but has no checkpoint.`,
      `Download SDXL (~6.5GB) into the workspace:\n` +
        `    comfy model download --url "${CHECKPOINT_URL}" --relative-path models/checkpoints\n` +
        `The file should land as models/checkpoints/${DEFAULT_CHECKPOINT}.`,
    )
  }
  return { checkpoints }
}

interface HistoryImage {
  filename: string
  subfolder?: string
  type?: string
}

function firstImage(outputs: unknown): HistoryImage | undefined {
  if (!outputs || typeof outputs !== 'object') return undefined
  for (const node of Object.values(outputs as Record<string, { images?: HistoryImage[] }>)) {
    const image = node?.images?.[0]
    if (image?.filename) return image
  }
  return undefined
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

export class ComfyAdapter implements BackendAdapter {
  readonly name = 'comfy' as const
  private readonly baseUrl: string
  private readonly fetchFn: typeof fetch
  private readonly timeoutMs: number
  private readonly pollMs: number
  private workflow: Workflow | undefined
  private probed: Promise<{ checkpoints: string[] }> | undefined

  constructor(options: ComfyAdapterOptions = {}) {
    this.baseUrl = (options.baseUrl ?? process.env.COMFY_URL ?? DEFAULT_COMFY_URL).replace(/\/$/, '')
    this.fetchFn = options.fetch ?? fetch
    this.timeoutMs = options.timeoutMs ?? 10 * 60_000
    this.pollMs = options.pollMs ?? 1_000
    this.workflow = options.workflow
  }

  private async loadWorkflow(): Promise<Workflow> {
    if (this.workflow) return this.workflow
    if (!existsSync(DEFAULT_WORKFLOW_PATH)) {
      throw new UserError(
        `ComfyUI workflow not found: ${DEFAULT_WORKFLOW_PATH}`,
        `Expected an API-format txt2img JSON next to the adapter.`,
      )
    }
    this.workflow = JSON.parse(await readFile(DEFAULT_WORKFLOW_PATH, 'utf8')) as Workflow
    return this.workflow
  }

  async generate(item: GenerateItem, _style?: string): Promise<GenerateResult> {
    const { checkpoints } = await (this.probed ??= probeComfy(this.baseUrl, this.fetchFn))
    const ckptName = checkpoints.includes(DEFAULT_CHECKPOINT) ? DEFAULT_CHECKPOINT : checkpoints[0]

    const workflow = injectWorkflow(await this.loadWorkflow(), {
      prompt: item.prompt,
      seed: item.seed,
      filenamePrefix: item.id,
      ckptName,
    })

    let promptId: string
    try {
      const res = await this.fetchFn(`${this.baseUrl}/prompt`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ prompt: workflow, client_id: 'asset-factory' }),
      })
      const raw = await res.text()
      let body: { prompt_id?: string; node_errors?: unknown; error?: { message?: string } }
      try {
        body = JSON.parse(raw) as typeof body
      } catch {
        throw new UserError(
          `ComfyUI /prompt returned HTTP ${res.status} (not JSON): ${raw.slice(0, 180).replace(/\s+/g, ' ')}`,
        )
      }
      if (!res.ok || !body.prompt_id) {
        const detail = body.error?.message ?? `HTTP ${res.status}`
        throw new UserError(`ComfyUI rejected the prompt: ${detail}`)
      }
      if (body.node_errors && typeof body.node_errors === 'object' && Object.keys(body.node_errors).length > 0) {
        throw new UserError(`ComfyUI workflow has node errors: ${JSON.stringify(body.node_errors)}`)
      }
      promptId = body.prompt_id
    } catch (err) {
      throw asUserError(err, this.baseUrl)
    }

    const image = await this.waitForImage(promptId)
    const view = new URL(`${this.baseUrl}/view`)
    view.searchParams.set('filename', image.filename)
    view.searchParams.set('subfolder', image.subfolder ?? '')
    view.searchParams.set('type', image.type ?? 'output')

    const res = await this.fetchFn(view)
    if (!res.ok) {
      throw new UserError(`ComfyUI /view failed (${res.status}) for ${image.filename}.`)
    }
    const bytes = Buffer.from(await res.arrayBuffer())
    if (bytes.length === 0) throw new UserError(`ComfyUI returned an empty image for ${item.id}.`)

    await mkdir(dirname(item.outFile), { recursive: true })
    await writeFile(item.outFile, bytes)
    return { file: item.outFile }
  }

  private async waitForImage(promptId: string): Promise<HistoryImage> {
    const deadline = Date.now() + this.timeoutMs
    while (Date.now() < deadline) {
      const { ok, data } = await getJson(this.fetchFn, `${this.baseUrl}/history/${promptId}`)
      if (ok && data && typeof data === 'object') {
        const entry = (data as Record<string, { status?: { status_str?: string; completed?: boolean; messages?: unknown[] }; outputs?: unknown }>)[
          promptId
        ]
        if (entry?.status?.status_str === 'error') {
          const messages = entry.status.messages ?? []
          throw new UserError(`ComfyUI execution failed for prompt ${promptId}: ${JSON.stringify(messages)}`)
        }
        if (entry?.status?.completed) {
          const image = firstImage(entry.outputs)
          if (!image) throw new UserError(`ComfyUI finished prompt ${promptId} but produced no image.`)
          return image
        }
      }
      await sleep(this.pollMs)
    }
    throw new UserError(
      `ComfyUI timed out after ${this.timeoutMs}ms waiting for prompt ${promptId}.`,
      `SDXL on this machine is expected to be slow. Raise the wait with --timeout, or check the ComfyUI log.`,
    )
  }
}
