// Read an MP3's playing time by walking its frame headers.
//
// The alternative is shelling out to ffprobe, which is not installed here and
// would be one more thing every consumer has to have. Summing frame durations
// is exact for the constant-bitrate files edge-tts produces, and it keeps the
// factory dependency-free for audio.

/** kbps by (version, bitrate index); index 0 is "free" and 15 is invalid. */
const BITRATES_V1_L3 = [0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0]
const BITRATES_V2_L3 = [0, 8, 16, 24, 32, 40, 48, 56, 64, 80, 96, 112, 128, 144, 160, 0]

/** Hz by (version, sample-rate index). */
const SAMPLE_RATES = {
  mpeg1: [44100, 48000, 32000],
  mpeg2: [22050, 24000, 16000],
  mpeg25: [11025, 12000, 8000],
} as const

export interface Mp3Info {
  durationSec: number
  frames: number
  sampleRate: number
  /** Average kbps across the file. */
  bitrate: number
  channels: number
}

/** Length of the leading ID3v2 tag, if any. */
function id3v2Size(buf: Buffer): number {
  if (buf.length < 10 || buf.toString('latin1', 0, 3) !== 'ID3') return 0
  // Size is 4 sync-safe bytes (7 bits each), excluding the 10-byte header.
  const size = ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f)
  return 10 + size
}

interface Frame {
  length: number
  samples: number
  sampleRate: number
  bitrate: number
  channels: number
}

/** Decode a 4-byte frame header, or undefined if these bytes are not one. */
function parseFrameHeader(buf: Buffer, offset: number): Frame | undefined {
  if (offset + 4 > buf.length) return undefined

  const b0 = buf[offset]!
  const b1 = buf[offset + 1]!
  const b2 = buf[offset + 2]!
  const b3 = buf[offset + 3]!

  // 11 sync bits.
  if (b0 !== 0xff || (b1 & 0xe0) !== 0xe0) return undefined

  const versionBits = (b1 >> 3) & 0b11
  const layerBits = (b1 >> 1) & 0b11
  if (versionBits === 0b01) return undefined // reserved
  if (layerBits !== 0b01) return undefined // only Layer III is "mp3"

  const version = versionBits === 0b11 ? 'mpeg1' : versionBits === 0b10 ? 'mpeg2' : 'mpeg25'

  const bitrateIndex = (b2 >> 4) & 0b1111
  const sampleRateIndex = (b2 >> 2) & 0b11
  if (bitrateIndex === 0 || bitrateIndex === 15 || sampleRateIndex === 3) return undefined

  const bitrate = (version === 'mpeg1' ? BITRATES_V1_L3 : BITRATES_V2_L3)[bitrateIndex]!
  const sampleRate = SAMPLE_RATES[version][sampleRateIndex]!
  const padding = (b2 >> 1) & 1
  const channels = ((b3 >> 6) & 0b11) === 0b11 ? 1 : 2

  // MPEG-1 Layer III carries 1152 samples per frame, MPEG-2/2.5 half that.
  const samples = version === 'mpeg1' ? 1152 : 576
  const length = Math.floor(((samples / 8) * bitrate * 1000) / sampleRate) + padding
  if (length <= 4) return undefined

  return { length, samples, sampleRate, bitrate, channels }
}

/**
 * Sum every frame in an MP3 buffer.
 * Returns undefined when the bytes hold no decodable frame.
 */
export function readMp3Info(buf: Buffer): Mp3Info | undefined {
  let offset = id3v2Size(buf)
  let frames = 0
  let samples = 0
  let bitrateSum = 0
  let sampleRate = 0
  let channels = 0

  while (offset + 4 <= buf.length) {
    const frame = parseFrameHeader(buf, offset)
    if (!frame) {
      // Not a frame boundary — could be padding, a tag, or junk. Resynchronize
      // by scanning for the next sync word rather than giving up on the file.
      const next = buf.indexOf(0xff, offset + 1)
      if (next === -1) break
      offset = next
      continue
    }

    frames++
    samples += frame.samples
    bitrateSum += frame.bitrate
    sampleRate = frame.sampleRate
    channels = frame.channels
    offset += frame.length
  }

  if (frames === 0 || sampleRate === 0) return undefined

  return {
    durationSec: Number((samples / sampleRate).toFixed(3)),
    frames,
    sampleRate,
    bitrate: Math.round(bitrateSum / frames),
    channels,
  }
}
