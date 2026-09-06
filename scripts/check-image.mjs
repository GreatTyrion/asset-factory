// Assert an image's format and dimensions. Used by scripts/smoke.sh.
//
//   node scripts/check-image.mjs <file> <format> <width> <height>

import sharp from 'sharp'

const [file, format, width, height] = process.argv.slice(2)
const meta = await sharp(file).metadata()

if (meta.format !== format || meta.width !== Number(width) || meta.height !== Number(height)) {
  console.error(`${file}: expected ${format} ${width}x${height}, got ${meta.format} ${meta.width}x${meta.height}`)
  process.exit(1)
}
