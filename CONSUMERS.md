# CONSUMERS — who uses asset-factory

Registry of apps that consume asset-factory. **Single source of truth for adoption status.**
Per-app authoritative usage instructions live in each app's own CLAUDE.md ("Asset pipeline" section) — this file tracks who is connected and what remains.

| App | Status | Config | Image | Narration (tts) | App playback |
|---|---|---|---|---|---|
| **gourmet** | ✅ Connected | `gourmet/factory.config.json` (styleGuide hardened) | 32 dishes: 28 live hand-made originals + **4 new dishes generated via Gemini** (huoguo/yangrou-chuan/changfen/xingren-doufu, committed `c3dbcaf`); 28-image alternative set archived NOT merged (`gemini-batch/` webp versioned, `gemini-batch-png/` local-only, gitignored) | 32/32 mp3 (`public/audio/intro/`, zh-CN-XiaoxiaoNeural rate -8%) | ✅ mp3 wired in (commit `92fa7e0`: `useNarration` + `src/audio/clips.ts`, Web Speech fallback, mute-aware) |
| **marine-organism** | 🔶 Pending | not created | 16/16 done (hand-made Nano Banana, committed) — image group would only matter for NEW creatures | none yet | Web Speech only |

## marine-organism — prerequisites before connecting

Data structure facts (checked 2026-09-06):

- `src/data/creatures.ts` — 16 creatures, export `CREATURES`; fields: `id`, `commonName`, `emoji`, `color`, `funIntro`, `habitat`, `diet`, `coolFact`, `sizeComparison?`, `image?` (`/images/creatures/<id>.webp`)
- ⚠️ **No `imagePrompt` field** — image generation needs either adding `imagePrompt` per creature (prompts currently live in `image-prompts.md` only) or composing prompts from existing fields. Since all 16 images exist, the image group is audit-only until new creatures are added.
- TTS opportunity: `funIntro` is a one-line playful hook → en-US mp3 group (`voice: en-US-*Neural`, same edge-tts path as gourmet). App playback would need the same `useNarration` integration gourmet did.
- CLAUDE.md patch: add the "Asset pipeline" section **when the config lands** (don't add it before — commands would fail without a config).

## Adding a new consumer (checklist)

1. Add `factory.config.json` at the app root (copy gourmet's; fix `dataSource`/`dataExport`/`idField`/`labelField`/`outDir`/`styleGuide`; run `asset-factory init` for a template)
2. Verify data fields exist (`promptField` for image, `textField` for tts) — add fields to the data module if missing
3. `audit` → `generate` → `import` → `tts` (from the asset-factory dir with `--cwd ../<app>` until the app has the `file:` devDependency)
4. Patch the app's CLAUDE.md with the English "Asset pipeline" section (copy gourmet's, adjust paths)
5. Wire playback if the app reads narration (copy gourmet's `src/audio/clips.ts` + `src/hooks/useNarration.ts` pattern)
6. Add a row to this table
