// Gemini image API backend. Logic matches gourmet's generate-images.mjs:
// one prompt in, one image out, skip when the destination already exists.

import { mkdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { dirname } from 'node:path'
import { UserError } from '../log.ts'
import type { BackendAdapter, GenerateItem, GenerateResult } from './types.ts'

export const DEFAULT_GEMINI_MODEL = 'gemini-3.1-flash-image'

export interface GeminiImage {
  bytes: Buffer
}

export type GeminiGenerateContent = (prompt: string) => Promise<GeminiImage>

export interface GeminiAdapterOptions {
  apiKey?: string
  model?: string
  generateContent?: GeminiGenerateContent
}

export class GeminiAdapter implements BackendAdapter {
  readonly name = 'gemini' as const
  private readonly apiKey: string
  private readonly model: string
  private readonly generateContent: GeminiGenerateContent | undefined

  constructor(options: GeminiAdapterOptions = {}) {
    this.apiKey = options.apiKey ?? process.env.GEMINI_API_KEY ?? ''
    this.model = options.model ?? process.env.GEMINI_IMAGE_MODEL ?? DEFAULT_GEMINI_MODEL
    this.generateContent = options.generateContent
  }

  async generate(item: GenerateItem, _style?: string): Promise<GenerateResult> {
    if (!this.apiKey) {
      throw new UserError(
        'Missing GEMINI_API_KEY.',
        'Get a key at https://aistudio.google.com/apikey and export GEMINI_API_KEY, then retry.',
      )
    }

    if (existsSync(item.outFile)) {
      return { file: item.outFile, skipped: true }
    }

    const image = this.generateContent ? await this.generateContent(item.prompt) : await this.callApi(item.prompt)
    await mkdir(dirname(item.outFile), { recursive: true })
    await writeFile(item.outFile, image.bytes)
    return { file: item.outFile }
  }

  private async callApi(prompt: string): Promise<GeminiImage> {
    const { GoogleGenAI, Modality } = await import('@google/genai')
    const ai = new GoogleGenAI({ apiKey: this.apiKey })
    const res = await ai.models.generateContent({
      model: this.model,
      contents: prompt,
      config: { responseModalities: [Modality.IMAGE] },
    })
    const parts = res.candidates?.[0]?.content?.parts ?? []
    const imgPart = parts.find((p) => p.inlineData?.data)
    if (!imgPart?.inlineData?.data) {
      throw new UserError(`Gemini returned no image for this prompt.`)
    }
    return { bytes: Buffer.from(imgPart.inlineData.data, 'base64') }
  }
}
