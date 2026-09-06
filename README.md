# asset-factory

给孩子 App 批量生产教学资产（图片 + 配音）的本地流水线 CLI。吃掉 gourmet / marine-organism 里的人肉流程。

**状态：Phase 1–3 已完成**——`init` / `prompts` / `generate` / `import` / `tts` / `audit` 可用。gourmet 配音 28/28 已入库；图像走 Gemini API（gemini-3.1-flash-image）批量 28 张完成、用户满意，**备选集已归档不合入**（webp → `gourmet/gemini-batch/`，原始 PNG → `gourmet/gemini-batch-png/`，App 保持原手工图）。首个真实使用方（dogfooding）：`gourmet` 已跑通 → 接下来 `marine-organism`（16 张图）。

## 它是干什么的（大白话）

给你那些孩子 App 批量做「图片素材 + 配音」的流水线。**App 的数据文件是唯一真相，工厂顺着它自动补齐所有资产。**

### 现在的做法（以 gourmet 加一道新菜为例）

```
1. 在 foods.ts 里写新菜数据（含一段英文 imagePrompt）
2. 手动把提示词复制到 Gemini app，生成图片
3. 下载图片，命名成 xiaolongbao.png 存进 incoming-images/
4. 跑 npm run import:images 转成 webp
5. 想加配音？没有——只能靠浏览器现场合成，音色还不稳定
```

28 道菜 = 重复 28 次第 2–3 步，全手工。

### 有了 asset-factory 之后

```
1. 在 foods.ts 里写新菜数据（唯一要你做的）
2. 跑 npx asset-factory generate   ← 自动读 foods.ts，发现新菜 → 自动出图
3. 跑 npx asset-factory tts        ← 自动给 intro/菜名配音，生成 mp3
4. 跑 npx asset-factory audit      ← 告诉你：还差什么、齐没齐
```

### 关键设计点

- **不用维护第二份清单**：工厂读 App 自己的数据模块（`foods.ts` / `creatures.ts`），加一道菜它自动知道要多一张图、多一段配音——不存在两份数据不同步的问题
- **跑一半不怕**：state 文件记进度，断电重跑只补剩下的（替代 marine 手工勾 Progress Tracker 复选框）
- **配音是白捡的新能力**：edge-tts 本地免费合成 mp3，比浏览器运行时合成稳定——gourmet 那套挑音色/防联网音色翻车的代码以后可删
- **后端随便换**：出图可走 ComfyUI 本地（免费）/ Gemini API（付费）/ 手工模式，同一命令入口，不锁死
- **收敛重复**：gourmet 一套导入脚本、marine 一套、image-prompt-studio skill 里又一套——统一成一个公共工具

最终效果：再开一个新 App（恐龙小课堂、蔬菜小课堂…），写好数据 + 配置，图、音、审计全自动。

## 文档

- `idea.md` — 需求来源与现状痛点
- `PLAN.md` — 实施计划（环境事实、架构、分阶段验收、非目标）

## 命令速览

> 前提：消费项目先本地安装一次——`npm i -D asset-factory@file:../asset-factory`（机制详见 PLAN.md「运行与分发」）

```bash
npx asset-factory init       # ✅ 在目标 App 里生成一份 factory.config.json 起步
npx asset-factory prompts    # ✅ 生成 prompt sheet + .asset-factory/prompts.json
npx asset-factory generate   # ✅ 出图：--backend comfy | gemini | manual
npx asset-factory import     # ✅ 统一转 webp/裁尺寸，落到 public/images/...
npx asset-factory tts        # ✅ edge-tts 批量配音 → mp3 + audio-manifest.json
npx asset-factory audit      # ✅ 覆盖率报告：还差哪些图/音；缺东西时退出码非零
```

常用选项：`--cwd <dir>` 指定 App 根目录、`--group <name>` 指定资产组、`--json` 机器可读输出、`--skip-existing` 跳过已有文件、`--only a,b` 只处理指定 id。
`generate` 必须带 `--backend comfy|gemini|manual`（ComfyUI 要本机 8188 在跑且有 checkpoint；Gemini 要 `GEMINI_API_KEY`）。出图落到 `incoming-images/`，再 `import` 转成最终 webp。
`tts` 另有 `--force`（全量重配）、`--concurrency` / `--timeout` / `--retries`；找不到 edge-tts 时用 `EDGE_TTS_BIN` 指路。

配音是**增量**的：`audio-manifest.json` 记了每条原文的摘要，改了 `foods.ts` 里某道菜的 `intro`，下次 `tts` 只重配那一条。

接入某个 App 的完整步骤见 [`docs/integration-guide.md`](docs/integration-guide.md)（含 gourmet 从 `useSpeech` 切到 mp3 的做法）。

## 开发

```bash
npm test        # vitest
npm run smoke   # 假数据端到端：prompts → generate(manual) → import → tts → audit
npm run typecheck
```
