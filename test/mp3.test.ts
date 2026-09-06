import { describe, expect, it } from 'vitest'
import { readMp3Info } from '../src/mp3.ts'

/**
 * A valid MPEG-2 Layer III stream: 24 kHz, 48 kbps, mono — what edge-tts emits.
 * Each frame is 144 bytes and lasts 576/24000 = 24 ms exactly.
 */
function mpeg2Frames(count: number, { padding = false } = {}): Buffer {
  const size = 144 + (padding ? 1 : 0)
  const buf = Buffer.alloc(size * count)
  for (let i = 0; i < count; i++) {
    const at = i * size
    buf[at] = 0xff
    buf[at + 1] = 0xf3
    buf[at + 2] = padding ? 0x66 : 0x64
    buf[at + 3] = 0xc0
  }
  return buf
}

/** MPEG-1 Layer III: 44.1 kHz, 128 kbps, stereo — 1152 samples per frame. */
function mpeg1Frames(count: number): Buffer {
  const size = 417 // floor(144 * 128000 / 44100)
  const buf = Buffer.alloc(size * count)
  for (let i = 0; i < count; i++) {
    const at = i * size
    buf[at] = 0xff
    buf[at + 1] = 0xfb
    buf[at + 2] = 0x90
    buf[at + 3] = 0x00
  }
  return buf
}

function withId3(payload: Buffer, tagBytes = 100): Buffer {
  const header = Buffer.alloc(10 + tagBytes)
  header.write('ID3', 0, 'latin1')
  header[3] = 3
  // Size is stored as four sync-safe (7-bit) bytes.
  header[6] = (tagBytes >> 21) & 0x7f
  header[7] = (tagBytes >> 14) & 0x7f
  header[8] = (tagBytes >> 7) & 0x7f
  header[9] = tagBytes & 0x7f
  return Buffer.concat([header, payload])
}

describe('readMp3Info', () => {
  it('sums MPEG-2 frames the way edge-tts output measures', () => {
    // 367 frames is the real 8.808 s sample this was validated against.
    const info = readMp3Info(mpeg2Frames(367))
    expect(info).toEqual({ durationSec: 8.808, frames: 367, sampleRate: 24000, bitrate: 48, channels: 1 })
  })

  it('handles MPEG-1 stereo frames', () => {
    const info = readMp3Info(mpeg1Frames(10))
    expect(info).toMatchObject({ frames: 10, sampleRate: 44100, bitrate: 128, channels: 2 })
    expect(info!.durationSec).toBeCloseTo((10 * 1152) / 44100, 3)
  })

  it('accounts for padded frames', () => {
    const info = readMp3Info(mpeg2Frames(50, { padding: true }))
    expect(info).toMatchObject({ frames: 50, sampleRate: 24000 })
  })

  it('skips a leading ID3v2 tag', () => {
    const info = readMp3Info(withId3(mpeg2Frames(100)))
    expect(info).toMatchObject({ frames: 100, durationSec: 2.4 })
  })

  it('resynchronizes past junk between frames', () => {
    const noise = Buffer.from([0x00, 0xff, 0x11, 0x22, 0x33])
    const info = readMp3Info(Buffer.concat([mpeg2Frames(5), noise, mpeg2Frames(5)]))
    expect(info!.frames).toBe(10)
  })

  it('returns undefined for bytes that are not an mp3', () => {
    expect(readMp3Info(Buffer.from('this is plainly not audio'))).toBeUndefined()
    expect(readMp3Info(Buffer.alloc(0))).toBeUndefined()
    expect(readMp3Info(Buffer.alloc(4096))).toBeUndefined()
  })

  it('rejects headers with a reserved bitrate or sample rate', () => {
    const bad = mpeg2Frames(1)
    bad[2] = 0xf4 // bitrate index 15 = invalid
    expect(readMp3Info(bad)).toBeUndefined()
  })
})
