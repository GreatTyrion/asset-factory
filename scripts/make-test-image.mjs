// Write a solid-color PNG. Stands in for a human-made image in scripts/smoke.sh.
//
//   node scripts/make-test-image.mjs <out-file> [#rrggbb]

import sharp from 'sharp'

const [outFile, background = '#8844cc'] = process.argv.slice(2)

if (!outFile) {
  console.error('usage: node scripts/make-test-image.mjs <out-file> [#rrggbb]')
  process.exit(1)
}

await sharp({ create: { width: 300, height: 220, channels: 3, background } })
  .png()
  .toFile(outFile)
