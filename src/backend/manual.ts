// Manual backend: write the prompt sheet and stop. The human makes the
// images (Gemini app, anything), drops them in incoming-images/, then import.

import { writePrompts } from '../prompts.ts'
import type { Manifest } from '../manifest.ts'
import type { BackendAdapter, GenerateItem, GenerateResult } from './types.ts'

export class ManualAdapter implements BackendAdapter {
  readonly name = 'manual' as const

  async prepare(manifest: unknown): Promise<void> {
    await writePrompts(manifest as Manifest)
  }

  async generate(item: GenerateItem, _style?: string): Promise<GenerateResult> {
    return { file: item.outFile, skipped: true }
  }
}
