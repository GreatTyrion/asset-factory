// Terminal output helpers. Colors are dropped when piped or when NO_COLOR is set,
// so `--json` output and CI logs stay clean.

const enabled =
  process.env.NO_COLOR === undefined &&
  process.env.TERM !== 'dumb' &&
  process.stdout.isTTY === true

function wrap(open: number, close: number) {
  return (s: string) => (enabled ? `\u001b[${open}m${s}\u001b[${close}m` : s)
}

export const color = {
  bold: wrap(1, 22),
  dim: wrap(2, 22),
  red: wrap(31, 39),
  green: wrap(32, 39),
  yellow: wrap(33, 39),
  blue: wrap(34, 39),
  cyan: wrap(36, 39),
}

export const log = {
  info: (msg: string) => console.log(msg),
  ok: (msg: string) => console.log(`${color.green('✓')} ${msg}`),
  skip: (msg: string) => console.log(`${color.dim('↷')} ${color.dim(msg)}`),
  warn: (msg: string) => console.warn(`${color.yellow('⚠')} ${msg}`),
  error: (msg: string) => console.error(`${color.red('✖')} ${msg}`),
  heading: (msg: string) => console.log(`\n${color.bold(msg)}`),
}

/**
 * Thrown for problems the user can fix (bad config, missing data field, no
 * Gemini API key). The CLI prints `message` + `hint` without a stack trace —
 * anything else is a bug and keeps its stack.
 */
export class UserError extends Error {
  hint?: string
  constructor(message: string, hint?: string) {
    super(message)
    this.name = 'UserError'
    this.hint = hint
  }
}
