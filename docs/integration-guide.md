# 接入指南 / Integration guide

把 asset-factory 产出的资产接进一个 App。以 gourmet 为例，但步骤对 marine-organism
和以后的新项目一样。

> 本仓库**不改任何 App 的代码**（PLAN §7）。这份文档是给之后单独改 App 的那次改动看的。

## 1. 配置：一个 factory.config.json

放在 App 根目录，声明「从我的数据模块里取哪些资产」。gourmet 的实际配置：

```jsonc
{
  "$schema": "../asset-factory/factory.config.schema.json",
  "name": "gourmet",
  "dataSource": "src/data/foods.ts",   // 唯一真相，工厂只读它
  "dataExport": "FOODS",
  "idField": "id",
  "labelField": "name",
  "groupField": "category",
  "styleGuide": "...共用画风串...",
  "items": [
    { "kind": "image", "outDir": "public/images/foods", "promptField": "imagePrompt",
      "format": "webp", "size": 768 },
    { "kind": "tts", "name": "intro", "outDir": "public/audio/intro", "textField": "intro",
      "lang": "zh-CN", "voice": "zh-CN-XiaoxiaoNeural", "rate": "-8%" }
  ]
}
```

一个 `items` 条目 = 一组资产。同一种 kind 想配多组（比如给 `intro` 和 `name` 各配一份音），
就写两条、各给一个 `name` 和不同的 `outDir`。

`rate` 对应原来 `useSpeech` 里的 `u.rate = 0.92`（给小朋友放慢一点）。

## 2. 生成

```bash
cd gourmet
npx asset-factory prompts   # 图：提示词清单
npx asset-factory import    # 图：incoming-images/ → public/images/foods/*.webp
npx asset-factory tts       # 音：public/audio/intro/*.mp3 + audio-manifest.json
npx asset-factory audit     # 齐没齐（缺东西退出码非零）
```

`tts` 可续跑：已经配过、且原文没变的条目会跳过。改了 `foods.ts` 里某道菜的 `intro`，
下次 `tts` 只重配那一条（靠 manifest 里的 `textHash` 比对）。`--force` 全部重来。

> **前提**：本机要有 `edge-tts`。不在 PATH 上就用 `EDGE_TTS_BIN=/path/to/edge-tts` 指过去。

## 3. 产出长什么样

```
public/audio/intro/
├── audio-manifest.json
├── gongbao-jiding.mp3
├── mapo-doufu.mp3
└── ...（每个 id 一个）
```

`audio-manifest.json`：

```jsonc
{
  "app": "gourmet",
  "group": "intro",
  "lang": "zh-CN",
  "voice": "zh-CN-XiaoxiaoNeural",
  "outDir": "public/audio/intro",
  "clips": {
    "gongbao-jiding": {
      "file": "gongbao-jiding.mp3",
      "url": "/audio/intro/gongbao-jiding.mp3",  // Vite 把 public/ 挂在站点根
      "durationSec": 9.552,
      "bytes": 57312,
      "textHash": "791dfc211937"                 // 原文变了就能看出来
    }
  }
}
```

## 4. gourmet：从 useSpeech 切到预生成 mp3

### 4.1 先认清一件事：不能整体替换

现在有三处朗读，但**只有第一处**有预生成音频：

| 调用点 | 读的内容 | 有 mp3 吗 |
|---|---|---|
| `DetailPage.tsx` `<ReadAloudButton text={food.intro} />` | 菜品简介 | ✅ 有 |
| `DetailPage.tsx` `<ReadAloudButton text={food.story} label="听故事" />` | 小故事 | ❌ 没配 |
| `GamePrompt.tsx` `speak(speech)` | 游戏里动态拼出来的题目 | ❌ 永远不会有 |

所以目标是**混合**：有 mp3 就放 mp3，没有就退回 Web Speech。
`useSpeech` / `VoiceContext` 那套挑音色的代码**先留着**——它现在是兜底路径。
（想全删，得先把 `story` 也配上音，并且接受游戏提示不朗读。）

### 4.2 加载清单

清单在 `public/` 下，Vite 不能 `import`，运行时取一次即可：

```ts
// src/audio/manifest.ts
export interface AudioClip {
  file: string
  url: string
  durationSec: number
  bytes: number
  textHash: string
}

let cache: Record<string, AudioClip> | null = null

/** 取一次就缓存；失败就当作没有音频，让调用方走 Web Speech 兜底。 */
export async function loadClips(): Promise<Record<string, AudioClip>> {
  if (cache) return cache
  try {
    const res = await fetch('/audio/intro/audio-manifest.json')
    cache = res.ok ? ((await res.json()).clips ?? {}) : {}
  } catch {
    cache = {}
  }
  return cache
}
```

### 4.3 一个「优先放 mp3」的 hook

保持和现有 `useSpeech` 一样的接口形状（`speaking` / `paused` / `speak` / `pause` / `resume`），
这样 `ReadAloudButton` 几乎不用动：

```ts
// src/hooks/useNarration.ts
import { useCallback, useEffect, useRef, useState } from 'react'
import { useSound } from '../context/SoundContext'
import { useSpeech } from './useSpeech'
import { loadClips, type AudioClip } from '../audio/manifest'

type Status = 'idle' | 'speaking' | 'paused'

/**
 * 朗读一段文字：clipId 有预生成 mp3 就播放它，否则退回 Web Speech。
 */
export function useNarration(clipId?: string) {
  const { muted } = useSound()
  const speech = useSpeech()                    // 兜底
  const [clip, setClip] = useState<AudioClip>()
  const [status, setStatus] = useState<Status>('idle')
  const audioRef = useRef<HTMLAudioElement | null>(null)

  useEffect(() => {
    if (!clipId) return setClip(undefined)
    let alive = true
    loadClips().then((clips) => alive && setClip(clips[clipId]))
    return () => { alive = false }
  }, [clipId])

  // 静音或离开页面时停掉，和 useSpeech 的行为保持一致
  useEffect(() => {
    if (muted) stop()
  }, [muted])

  useEffect(() => () => { audioRef.current?.pause() }, [])

  const stop = useCallback(() => {
    const el = audioRef.current
    if (el) { el.pause(); el.currentTime = 0 }
    setStatus('idle')
    speech.stop()
  }, [speech])

  const speak = useCallback(
    (text: string) => {
      if (muted) return
      if (!clip) return speech.speak(text)      // 没有音频 → 现场合成

      let el = audioRef.current
      if (!el) {
        el = new Audio(clip.url)
        el.onended = () => setStatus('idle')
        el.onerror = () => { setStatus('idle'); speech.speak(text) }  // 404 也能兜底
        audioRef.current = el
      }
      el.currentTime = 0
      void el.play()
      setStatus('speaking')
    },
    [clip, muted, speech],
  )

  const pause = useCallback(() => {
    if (!clip) return speech.pause()
    audioRef.current?.pause()
    setStatus('paused')
  }, [clip, speech])

  const resume = useCallback(() => {
    if (muted) return
    if (!clip) return speech.resume()
    void audioRef.current?.play()
    setStatus('speaking')
  }, [clip, muted, speech])

  // 有 mp3 时用自己的状态，没有时透传 useSpeech 的
  const active = clip ? status : speech.status

  return {
    supported: clip ? true : speech.supported,
    hasVoice: clip ? true : speech.hasVoice,
    speaking: active === 'speaking',
    paused: active === 'paused',
    speak,
    pause,
    resume,
    stop,
    /** 有预生成音频时可用，可用来画进度条 */
    durationSec: clip?.durationSec,
  }
}
```

### 4.4 改调用点

`ReadAloudButton` 多收一个可选的 `clipId`，内部换成 `useNarration`：

```diff
-export default function ReadAloudButton({ text, label = '朗读' }: {
-  text: string
-  label?: string
-}) {
-  const { supported, hasVoice, speaking, paused, speak, pause, resume } = useSpeech()
+export default function ReadAloudButton({ text, clipId, label = '朗读' }: {
+  text: string
+  clipId?: string
+  label?: string
+}) {
+  const { supported, hasVoice, speaking, paused, speak, pause, resume } = useNarration(clipId)
```

`DetailPage.tsx` 里只有简介那处要传 id（`food` 就在作用域里）：

```diff
-<ReadAloudButton text={food.intro} />
+<ReadAloudButton text={food.intro} clipId={food.id} />
```

小故事那处不传 `clipId`，自动走 Web Speech，行为和今天完全一样。

### 4.5 验证

1. `npx asset-factory audit` → `intro (tts → public/audio/intro) 28/28`
2. `npm run dev`，进任意菜品页点「朗读」——应该是 Xiaoxiao 的声音，且每次都一样
3. 点「听故事」——仍然是系统音色（兜底路径没坏）
4. 断网再点「朗读」——mp3 是本地文件，照常播；这正是换掉运行时合成的意义
5. 静音按钮对两条路径都要生效

## 5. 内容改了怎么办

`foods.ts` 是唯一真相。改完跑一次就行：

```bash
npx asset-factory tts     # 只重配 textHash 对不上的那几条
npx asset-factory audit   # 确认齐了
```

加一道新菜 → `import`（图）+ `tts`（音）各跑一次，两样都会自动补上。

## 6. 换音色

```bash
edge-tts --list-voices | grep zh-CN
```

改 config 里的 `voice`，然后 `npx asset-factory tts --force` 全量重配。
`rate` / `volume` / `pitch` 也在 config 里调（写成 `"-8%"` / `"+5Hz"` 这种带符号的形式）。

## 7. 常见问题

**`Could not find the edge-tts executable`**
装一个（`pipx install edge-tts`），或者 `EDGE_TTS_BIN=/path/to/edge-tts npx asset-factory tts`。

**某几条失败了**
edge-tts 走的是微软的在线服务，偶发 429/503 很正常。工厂已经自动重试 2 次；
再跑一次 `tts` 只会补失败的那几条（成功的都会跳过）。

**音频进不进 git？**
和图片一样是生成物。图片（1.1 MB）目前是提交进 gourmet 仓库的；音频 28 条约 1.6 MB。
提交的好处是 clone 下来就能用、且不依赖在线服务的可复现性；不提交则要每个人自己跑一遍
`tts`。**两种都行，但要和 `.gitignore` 保持一致**，别处在「没忽略也没提交」的中间状态。
