// Pluggable image backends. `generate` is the whole contract: given one
// record's prompt (and the shared style), write a file and say where it went.

export type BackendName = 'gemini' | 'manual'

export interface GenerateItem {
  id: string
  /** Art direction as the generator should send it (record prompt + style). */
  prompt: string
  /** Where the adapter must write the image (PNG in the app's incoming folder). */
  outFile: string
  /** Stable per-id seed so reruns of the same dish don't wander. */
  seed: number
}

export interface GenerateResult {
  file: string
  skipped?: boolean
}

export interface BackendAdapter {
  readonly name: BackendName
  /** Optional setup that runs once per `generateImages` call (e.g. write the sheet). */
  prepare?(manifest: unknown): Promise<void>
  generate(item: GenerateItem, style?: string): Promise<GenerateResult>
}

const BACKENDS: BackendName[] = ['gemini', 'manual']

export function isBackendName(value: string): value is BackendName {
  return (BACKENDS as string[]).includes(value)
}

export function allowedBackends(): string {
  return BACKENDS.join(', ')
}
