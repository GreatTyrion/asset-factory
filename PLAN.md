# asset-factory 开发计划

> 状态：**Phase 1 ✅ + Phase 2 ✅ + Phase 3 ✅（完结）**。图像方向 C（gemini-3.1-flash-image）批量 28 张完成，用户整体满意（含个别瑕疵，如 tanghulu/beijing-kaoya/doujiang-youtiao，用户接受不改）。**最终决策：备选集不合入**——webp 存 `gourmet/gemini-batch/`、原始 PNG 存 `gourmet/gemini-batch-png/`，App 现网图保持原手工集（已在 CLAUDE.md 铁律注明）。实测成本 ~0.087 CAD/图，28 张 ≈ 2.4 CAD。管线能力已验证可复现。实现依据；idea.md 是需求来源。
> 首个真实使用方（dogfooding，自己先尝自己做的东西）：gourmet（28 图，真实数据在 `src/data/foods.ts`）和 marine-organism（16 图，`src/data/creatures.ts`）。

## 1. 环境事实（2026-08 实测，写代码前先复核）
- gourmet/marine-organism 都是 **Vite + React + TS**，数据在 `src/data/*.ts`（Node 26 可直接 type-strip import TS——gourmet 脚本已这么干）
- gourmet 现有脚本：`scripts/prompt.mjs`（风格常量 STYLE + buildPrompt）、`write-prompt-sheet.mjs`、`import-images.mjs`、`generate-images.mjs`（Gemini API，`GEMINI_API_KEY`，768×768 webp via sharp，~$0.039/图，idempotent）
- marine 图片规格：768×768 webp ~15–35KB；gourmet 同 768 webp。**两项目共用这一规格**
- 音频现状：无文件，运行时 Web Speech（gourmet `useSpeech.ts` + `VoiceContext` 排序挑 zh-CN 音色）
- 机器上：`~/ComfyUI` 有源码 + `.venv`（Python 3.12 / torch 2.13.0 / MPS 可用）。SDXL `sd_xl_base_1.0.safetensors`（~6.5GB）已放入 `models/checkpoints/`。comfy-cli 经 `uv tool install comfy-cli` 安装；`comfy launch --background` 起 8188。M5 Pro 24GB 跑 SDXL 判定 **marginal（可跑偏慢）**。
- `edge-tts` 可用（hermes venv 内），zh-CN + en-US 音色齐全；`sharp` 两项目都在用
- `~/.claude/skills/image-prompt-studio/` 存在（含 import-images.mjs）

## 2. 架构
```
asset-factory/                # 独立工具仓库（不塞进任何 App）
├── package.json              # bin: asset-factory
├── factory.config.schema.json
├── src/
│   ├── cli.ts                # prompts / generate / import / tts / audit / init
│   ├── manifest.ts           # 读目标 App 的 factory.config.json + 数据模块 → 资产清单
│   ├── prompts.ts            # 生成 prompt sheet（markdown + JSON，风格来自 config）
│   ├── backend/
│   │   ├── types.ts          # BackendAdapter 接口（可插拔）
│   │   ├── comfy.ts          # ComfyUI 本地 REST（探测模型，缺则报清晰指引）
│   │   ├── gemini.ts         # Gemini 图片 API（gourmet generate-images.mjs 逻辑搬过来）
│   │   └── manual.ts         # 只产出 sheet，人肉生成（兼容今天流程）
│   ├── import-images.ts      # sharp 统一转 webp/768（收敛三份重复实现）
│   ├── tts.ts                # edge-tts 批量配音 → {id}.mp3 + audio-manifest.json
│   ├── state.ts              # .asset-factory/state.json：每资产状态 pending/done/failed，可续跑
│   └── audit.ts              # 覆盖率报告（对比清单 vs 实际文件）
├── scripts/
│   └── smoke.sh              # 端到端冒烟：fake 数据 → import → audit
└── docs/integration-guide.md # 各 App 接入说明（含音频替换 useSpeech 的步骤）
```

**factory.config.json（放在目标 App 根目录，示意）**
```jsonc
{
  "name": "gourmet",
  "dataSource": "src/data/foods.ts",   // 导出数组的模块
  "idField": "id",
  "items": [                            // 每个数据项 → 一组资产
    { "kind": "image", "promptField": "imagePrompt", "outDir": "public/images/foods", "format": "webp", "size": 768 },
    { "kind": "tts", "textField": "intro", "lang": "zh-CN", "voice": "zh-CN-XiaoxiaoNeural", "outDir": "public/audio" }
  ],
  "styleGuide": "A bright, appetizing, kid-friendly food illustration ... 共用风格串"
}
```
清单只描述**怎么从 App 现有数据取资产**——不复制数据本身。

### 运行与分发：命令怎么被找到（关键，先读再实施）

`asset-factory` **不发布到 npm**，纯本地工具。这带来一个坑：`npx asset-factory` 的查找顺序是「当前项目 `node_modules/.bin/` → npm 官网」。本地没装时 npx 会去官网找同名包——可能撞上别人发布的同名代码。所以**必须先本地安装**，不能裸跑。

两层问题别混淆：
- **解析层**（命令跑起来去哪找）＝ 本节的 bin 声明 + 本地安装
- **发现层**（项目怎么知道该用它）＝ Phase 4 的 CLAUDE.md 指引 + 新项目 brief

机制：
1. asset-factory 自己的 `package.json` 声明 `"bin": { "asset-factory": "./入口文件" }`——命令名到可执行文件的映射，没这行装了也跑不了
2. 消费项目接入（推荐，离线 + 改代码即生效）：
   ```bash
   # 在 gourmet/、marine-organism/ 及未来各新项目根目录各执行一次
   npm i -D asset-factory@file:../asset-factory
   ```
   效果：`node_modules/.bin/asset-factory` 成为指向 `../asset-factory` 的软链 → 该项目内 `npx asset-factory generate` 本地命中，不碰 npm 官网；工厂代码更新无需重装
3. 备选：全局安装 `npm i -g <asset-factory 绝对路径>`，之后任何目录直接 `asset-factory generate`（不依赖消费项目的 package.json）

## 3. Phase 1 — 骨架 + prompts/import/audit ✅ 已完成
1. ✅ `npm init` + tsconfig + vitest；package.json 声明 `bin.asset-factory`；`factory.config.schema.json`（JSON Schema，Cursor 写完让 CLI 校验配置）
2. ✅ `manifest.ts`：读 config → import 数据模块（type-strip）→ 展开资产清单（id、prompt、输出路径）
3. ✅ `prompts.ts`：markdown sheet（复用 gourmet 风格串）+ `prompts.json`（machine-readable，供 generate 用）
4. ✅ `import-images.ts`：incoming 目录 → 按 id 转 webp/768 → 落到 outDir；报告未知文件（= gourmet import-images.mjs 逻辑，收敛）
5. ✅ `audit.ts`：清单 vs 实际文件 → 缺失列表 + 覆盖率
6. ✅ `state.ts` + cli 骨架：子命令分发、彩色输出、非零退出码
7. ✅ **验收**：gourmet config 配好；`audit --cwd ../gourmet` → **28/28 assets**；CLI 从 App 根目录或 `--cwd` 均可
8. ✅ 测试：vitest **86/86**（8 文件，含 `gourmet.test.ts` 真实数据测试、cli 退出码测试）
> 完成记录：commit `8a2b46e`；实际实现还多了 `init` 子命令、schema 校验、`--group/--only/--json/--skip-existing` 参数、`scripts/smoke.sh`。
> 遗留（属 Phase 4）：gourmet 尚未执行 `npm i -D asset-factory@file:../asset-factory`，当前需在工厂目录用 `--cwd ../gourmet` 调用。

## 4. Phase 2 — 配音（全新能力，先于图像后端）✅ 已完成
1. ✅ `tts.ts`：调 edge-tts（子进程，`--voice` `--text`），输出 `{id}.mp3` + `audio-manifest.json`（id→文件、时长），进度入 state 可续跑
2. ✅ gourmet 实测：28 道菜的 `intro` 配音（zh-CN-XiaoxiaoNeural，`rate: -8%`）→ **28/28，267.1s 音频，1.6 MB**；`audit` 图+音合计 **56/56**
3. ✅ `docs/integration-guide.md`：gourmet 改 `useSpeech` 为播放预生成 mp3 的步骤（供后续单独改 App，不在本仓库做）
4. ✅ 测试：vitest **132/132**（新增 `tts.test.ts` 34 例、`mp3.test.ts` 7 例）；子进程用真实可执行文件 `test/fixtures/fake-edge-tts.mjs` 注入 badvoice/超时/flaky 重试等分支

> 完成记录：实现还多了 `mp3.ts`（无依赖解析时长，与 macOS `afinfo` 逐帧一致）、`textHash` 陈旧检测（改了 `intro` 只重配那一条）、`--concurrency/--timeout/--retries`、`EDGE_TTS_BIN` 覆盖、smoke 加了 tts 两步。
> 环境事实修正：edge-tts 是**微软在线服务**（非本地合成），故有超时+重试；prosody 参数必须写成 `--rate=-8%`（argparse 会把 `-8%` 当成下一个 flag），真实验收时踩到并已修。
> 音频入库：`public/audio/` **提交进 gourmet 仓库**（与 `public/images/` 一致，clone 即可用，不依赖在线服务的可复现性）。

## 5. Phase 3 — 图像后端（可插拔，从 ComfyUI 开始）
1. ✅ `backend/types.ts`：`BackendAdapter { generate(item, style): Promise<{file}> }`
2. ✅ `comfy.ts`：探测 `http://127.0.0.1:8188/system_stats`；无 checkpoint 时报下载命令；API-format workflow 可注入 prompt/seed
3. ✅ `gemini.ts`：移植 gourmet `generate-images.mjs`（idempotent、跳过已有）
4. ✅ `manual.ts`：输出 sheet + 空跑（提示人工）
5. ❌ **验收关口（已审，未过）**：xiaolongbao / mapo-doufu / tanghulu 三道菜 ComfyUI 出图 → import → 人审风格。**结果：否决**，见下方 🔴 关口记录
6. ✅ 测试：adapter 接口契约、comfy 探测失败分支、gemini 跳过已有

### 🔴 关口记录（2026-09-06）：ComfyUI + SDXL base 1.0 路径被否决
- **验收动作**：3 道菜（xiaolongbao/mapo-doufu/tanghulu）SDXL 出图 → 用户人工评审
- **结果**：不认可。用户原话：「SDXL base 和现网那套软绘单品对不上」
- **我的实测**（并排对比 tanghulu 原图 vs SDXL 图）：构图/配色接近，但微观差距明显——边缘不够干净（果与签粘连）、材质厚度感弱（糖衣像涂色不像晶体）、「高级插画感」滑向「普通写实渲染」；且 SDXL base **整组风格一致性弱**，单张接近不代表 28 张连贯
- **根因**：现网 28 张出自 **Gemini 图像模型**（gourmet 手工路径 / marine Nano Banana = 同一模型家族），SDXL base 是另一套通用模型，风格语言天然不同
- **无损**：3 张测试图留在 gourmet `incoming-images/`（gitignored）；`public/images/foods/` 原图未动
- **二轮复核（2026-09-06，comfy-review/ 目录，用户带图逐张否决）**：失败升级诊断为三类结构性能力缺失，非风格微差——
  1. **文化语义缺失**：tanghulu 被画成"野莓+树枝"，无糖衣光泽、竹签未串起果实（SD 系训练数据缺中国文化食物）
  2. **道具细节崩坏**：mapo-doufu 左上小盏内筷子粗如船桨；且擅自堆砌米饭/蘸碟/桌垫整桌场景，违反风格指南"居中单品、画面干净"纪律
  3. **构图纪律不守**：xiaolongbao 场景堆砌无层级、褶皱生硬皮厚无汤汁感，"随意堆放"产生不卫生暗示
  → 三类问题均**非提示词可修**，属 base model 能力边界；换 SD 系 checkpoint 无法解决（语义只会更差）。选项 A 裁决：放弃
- **备选方向（已定：C）**：~~A. 换插画向 checkpoint~~（已裁决放弃）；~~B. IP-Adapter~~（救不了语义）；**✅ C. Gemini API 适配器出图（现网同源，用户 2026-09-06 选定，billing 已开通 ¥10）**；D. 图像保持手工/manual 模式（备用）
- **执行状态**：评审残留已清理（3 个 review 目录删除，均确认 untracked）；批量隔离目录 `gourmet/gemini-batch/` 就绪（强化风格指南：禁文字/禁厨房虚化/禁多余餐具/纯奶油底，清单构建验证 28 项，present=0 空目录）。⚠️ **`gourmet/incoming-images/` 含 25 张 2026-07-23 的 2048² 原始手工 PNG（高清母本，gitignored）——任何清理/生成都不得触碰**。若 `gemini-3.1-flash-image` 风格与现网有差，换 `GEMINI_IMAGE_MODEL=gemini-2.5-flash-image`（Nano Banana，marine 同源）或 `gemini-3-pro-image` 再评

## 6. Phase 4 — 收尾 + 推广（让项目们真的用起来）
- `audit` 加多项目报告（一个命令扫全部 playground 带 config 的项目）
- **给 gourmet/marine 接上**：各执行 `npm i -D asset-factory@file:../asset-factory`（gourmet 的 config Phase 1 已配好）；marine 配好 config 后跑通 16/16
- **给 gourmet/marine 的 CLAUDE.md 打补丁**：图片/配音统一走 `../asset-factory`，本地 `import-images.mjs` 标 deprecated（不删，留作对照）——这是 agent 在旧项目里改用新工具的关键一步
- asset-factory 仓库维护 **CONSUMERS.md**：接入方清单（项目 / 数据源 / 资产规格 / 状态），作为唯一真相
- playground 根目录建 AGENTS.md：声明公共工具（asset-factory 管素材、local-reader 管翻译…）；仅对从根目录开工的会话生效，不替代各项目 CLAUDE.md
- `docs/`：README + 接入指南 + ComfyUI 模型采购清单（SDXL 起步 ~6.5GB）

## 7. 非目标
- 不做角色一致性（v2：img2img 参考图 / IP-Adapter）
- 不自动改各 App 代码；只产资产 + 文档
- 不部署任何服务；纯本地 CLI
- 不复制数据：清单永远指向 App 自己的数据模块

## 8. 验证方式（每阶段做完必须过）
- `npm test`（vitest）
- Phase 1/2 验收 = gourmet 真实数据全流程；Phase 3 验收 = 3 道菜真实出图人工评审
- 冒烟脚本 `scripts/smoke.sh` 用假数据跑通 prompts→(manual)→import→audit
- 边界：config 缺失/数据字段不符 → 报错信息指出具体缺什么；ComfyUI 未装模型 → 指引命令而非裸报错
