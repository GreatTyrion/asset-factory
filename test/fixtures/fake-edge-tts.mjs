#!/usr/bin/env node
// A stand-in for the real edge-tts binary, so the subprocess wrapper can be
// tested against actual process behaviour — argv, exit codes, signals, timeouts
// — instead of a mock. Point EDGE_TTS_BIN at this file.
//
// Behaviour is driven by env vars:
//   FAKE_TTS_MODE      ok | fail | badvoice | hang | flaky | nofile | emptyfile
//   FAKE_TTS_FAILURES  flaky mode: how many attempts fail before one succeeds
//   FAKE_TTS_COUNTER   file used to count attempts across processes
//   FAKE_TTS_ARGV_LOG  file to append the received argv to, one JSON line each

import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'

const argv = process.argv.slice(2)

function flag(name) {
  const i = argv.indexOf(name)
  return i === -1 ? undefined : argv[i + 1]
}

const text = flag('--text') ?? ''
const voice = flag('--voice') ?? ''
const outFile = flag('--write-media')

if (process.env.FAKE_TTS_ARGV_LOG) {
  appendFileSync(process.env.FAKE_TTS_ARGV_LOG, `${JSON.stringify(argv)}\n`)
}

/** Count this attempt and return the running total. */
function bumpCounter() {
  const file = process.env.FAKE_TTS_COUNTER
  if (!file) return 1
  let count = 0
  try {
    count = Number(readFileSync(file, 'utf8')) || 0
  } catch {
    count = 0
  }
  count += 1
  writeFileSync(file, String(count))
  return count
}

/**
 * Build a real, parseable MPEG-2 Layer III stream: 24 kHz, 48 kbps, mono —
 * the same shape edge-tts emits, so duration parsing is exercised for real.
 * Each frame is 144 bytes and lasts 576/24000 = 24 ms.
 */
function silentMp3(frames) {
  const FRAME_BYTES = 144
  const buf = Buffer.alloc(FRAME_BYTES * frames)
  for (let i = 0; i < frames; i++) {
    const at = i * FRAME_BYTES
    buf[at] = 0xff // sync
    buf[at + 1] = 0xf3 // sync + MPEG-2 + Layer III + no CRC
    buf[at + 2] = 0x64 // 48 kbps, 24 kHz, no padding
    buf[at + 3] = 0xc0 // mono
  }
  return buf
}

const mode = process.env.FAKE_TTS_MODE ?? 'ok'
const attempt = mode === 'flaky' ? bumpCounter() : bumpCounter()

switch (mode) {
  case 'badvoice':
    process.stderr.write(`No voices found with the name ${voice}\n`)
    process.exit(1)
    break

  case 'fail':
    process.stderr.write('WSServerHandshakeError: 429 Too Many Requests\n')
    process.exit(1)
    break

  // How argparse rejects `--rate -8%`, i.e. a flag we built wrong.
  case 'badargs':
    process.stderr.write('edge-tts: error: argument --rate: expected one argument\n')
    process.exit(1)
    break

  case 'hang':
    // Never exits; the caller's timeout must kill it.
    setInterval(() => {}, 1000)
    break

  case 'nofile':
    process.exit(0)
    break

  case 'emptyfile':
    writeFileSync(outFile, '')
    process.exit(0)
    break

  case 'flaky': {
    const failures = Number(process.env.FAKE_TTS_FAILURES ?? '1')
    if (attempt <= failures) {
      process.stderr.write('WSServerHandshakeError: 503 Service Unavailable\n')
      process.exit(1)
    }
    writeFileSync(outFile, silentMp3(Math.max(1, text.length)))
    process.exit(0)
    break
  }

  default:
    // One frame (24 ms) per character keeps durations deterministic per input.
    writeFileSync(outFile, silentMp3(Math.max(1, text.length)))
    process.exit(0)
}
