// Scaffold a factory.config.json in a target app, guessing the data module.

import { readdir, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import { CONFIG_FILENAME, SCHEMA_PATH } from './config.ts'
import { UserError } from './log.ts'

const DATA_DIRS = ['src/data', 'data', 'src']

/** Best guess at the module exporting the record array. */
export async function guessDataSource(root: string): Promise<string | undefined> {
  for (const dir of DATA_DIRS) {
    const abs = join(root, dir)
    if (!existsSync(abs)) continue
    const files = (await readdir(abs))
      .filter((f) => /\.(ts|js|mjs)$/.test(f) && !/\.(test|spec|d)\./.test(f))
      .sort()
    if (files.length > 0) return `${dir}/${files[0]}`
  }
  return undefined
}

export async function initConfig(root: string, force = false): Promise<string> {
  const file = join(root, CONFIG_FILENAME)
  if (existsSync(file) && !force) {
    throw new UserError(`${file} already exists.`, `Pass --force to overwrite it.`)
  }

  const dataSource = await guessDataSource(root)
  const schemaRef = relative(root, SCHEMA_PATH).split('\\').join('/')

  const config = {
    $schema: schemaRef,
    name: relative(join(root, '..'), root),
    dataSource: dataSource ?? 'src/data/items.ts',
    idField: 'id',
    labelField: 'name',
    incomingDir: 'incoming-images',
    styleGuide: 'TODO: one shared sentence of art direction, appended to every image prompt.',
    items: [
      {
        kind: 'image',
        promptField: 'imagePrompt',
        outDir: 'public/images',
        format: 'webp',
        size: 768,
      },
    ],
  }

  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8')
  return file
}
