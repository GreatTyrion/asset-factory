#!/usr/bin/env bash
# End-to-end smoke test on a throwaway app: init → prompts → (manual) → import → audit,
# plus the two error paths users hit first (no config, data/config mismatch).
#
#   npm run smoke

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CLI="$ROOT/src/cli.ts"
APP="$(mktemp -d "${TMPDIR:-/tmp}/asset-factory-smoke-XXXXXX")"
trap 'rm -rf "$APP"' EXIT

pass() { printf '\033[32m✓\033[0m %s\n' "$1"; }
fail() { printf '\033[31m✖ %s\033[0m\n' "$1" >&2; exit 1; }
step() { printf '\n\033[1m%s\033[0m\n' "$1"; }

expect_exit() {
  local want="$1" desc="$2"; shift 2
  local got=0
  "$@" >"$APP/out.log" 2>&1 || got=$?
  [ "$got" = "$want" ] || { cat "$APP/out.log"; fail "$desc — expected exit $want, got $got"; }
}

# -F: messages contain [0] and other regex metacharacters.
expect_output() {
  grep -qF -- "$1" "$APP/out.log" || { cat "$APP/out.log"; fail "expected output to contain: $1"; }
}

step "0. errors before anything is configured"
expect_exit 1 "audit without a config" node "$CLI" audit --cwd "$APP"
expect_output "No factory.config.json found"
pass "missing config names the file and points at \`init\`"

step "1. fake app with three records"
mkdir -p "$APP/src/data"
cat >"$APP/src/data/creatures.ts" <<'TS'
interface Creature { id: string; name: string; zone: string; imagePrompt: string }
export const CREATURES: Creature[] = [
  { id: 'octopus', name: '章鱼', zone: '珊瑚礁', imagePrompt: 'A friendly purple octopus' },
  { id: 'seahorse', name: '海马', zone: '珊瑚礁', imagePrompt: 'A tiny yellow seahorse' },
  { id: 'anglerfish', name: '鮟鱇鱼', zone: '深海', imagePrompt: 'A glowing anglerfish' },
]
TS

cat >"$APP/factory.config.json" <<'JSON'
{
  "name": "smoke-app",
  "dataSource": "src/data/creatures.ts",
  "dataExport": "CREATURES",
  "idField": "id",
  "labelField": "name",
  "groupField": "zone",
  "styleGuide": "Flat pastel illustration, plain background, no text.",
  "items": [
    { "kind": "image", "outDir": "public/images", "promptField": "imagePrompt", "format": "webp", "size": 128 }
  ]
}
JSON
pass "wrote fake data module + config"

step "2. prompts"
expect_exit 0 "prompts" node "$CLI" prompts --cwd "$APP"
[ -f "$APP/image-prompts.md" ] || fail "no prompt sheet was written"
[ -f "$APP/.asset-factory/prompts.json" ] || fail "no prompts.json was written"
grep -q 'save as `octopus`' "$APP/image-prompts.md" || fail "sheet is missing the octopus entry"
grep -q 'A friendly purple octopus. Flat pastel illustration' "$APP/image-prompts.md" ||
  fail "sheet did not append the shared style"
pass "sheet + prompts.json cover all 3 records"

step "3. audit before any image exists"
expect_exit 1 "audit with nothing generated" node "$CLI" audit --cwd "$APP"
expect_output "0/3"
pass "empty project reports 0/3 and exits non-zero"

step "4. manual step — stand in for a human making the images"
mkdir -p "$APP/incoming-images"
node "$ROOT/scripts/make-test-image.mjs" "$APP/incoming-images/octopus.png" '#8844cc' || fail "could not fake an image"
node "$ROOT/scripts/make-test-image.mjs" "$APP/incoming-images/seahorse.png" '#eecc33' || fail "could not fake an image"
node "$ROOT/scripts/make-test-image.mjs" "$APP/incoming-images/jellyfish.png" '#33ccbb' || fail "could not fake an image"
pass "dropped 3 png files (one of them named after no record)"

step "5. import"
expect_exit 0 "import" node "$CLI" import --cwd "$APP"
expect_output "octopus.png"
expect_output "match no id"
expect_output "jellyfish.png"
pass "converted the 2 matching files and flagged the stray one"

node "$ROOT/scripts/check-image.mjs" "$APP/public/images/octopus.webp" webp 128 128 ||
  fail "imported image is not a 128x128 webp"
pass "output is a 128x128 webp, as the config asked"

step "6. audit after a partial import"
expect_exit 1 "audit with one image missing" node "$CLI" audit --cwd "$APP"
expect_output "2/3"
expect_output "missing: anglerfish"
pass "partial coverage is reported as 2/3 and exits non-zero"

step "7. finish the set"
node "$ROOT/scripts/make-test-image.mjs" "$APP/incoming-images/anglerfish.png" '#224466' ||
  fail "could not fake an image"
expect_exit 0 "import the last image" node "$CLI" import --cwd "$APP"
expect_exit 0 "audit a complete project" node "$CLI" audit --cwd "$APP"
expect_output "3/3"
expect_output "Every asset is present"
pass "full coverage reports 3/3 and exits 0"

step "8. state survives the run"
node -e "
const state = require('$APP/.asset-factory/state.json')
const done = Object.values(state.assets).filter((a) => a.status === 'done')
if (done.length !== 3) { console.error('expected 3 done assets, got', done.length); process.exit(1) }
" || fail "state.json did not record all 3 assets"
pass "state.json records all 3 assets as done"

step "9. config that does not match the data"
node -e "
const fs = require('node:fs')
const file = '$APP/factory.config.json'
const cfg = JSON.parse(fs.readFileSync(file, 'utf8'))
cfg.items[0].promptField = 'artDirection'
fs.writeFileSync(file, JSON.stringify(cfg, null, 2))
" || fail "could not rewrite the config"
expect_exit 1 "audit with a mismatched promptField" node "$CLI" audit --cwd "$APP"
expect_output 'missing "artDirection"'
expect_output 'src/data/creatures.ts[0]'
pass "a wrong field name names the record and the field"

printf '\n\033[32m🎉 smoke passed\033[0m\n'
