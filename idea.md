# asset-factory — 教学资产工厂

**一句话：把散落在各个 App 里的人肉资产流水线（写提示词→生成图→转格式→配音），归一化成一个共享车间。**

给孩子 App 批量生产图片 + 配音的本地流水线。把 gourmet / marine-organism 里现在**人肉复制粘贴**的资产流程，变成一条命令跑完的流水线。

## 现状痛点（来自三个项目的实际代码）

| 环节 | 现在的做法 | 问题 |
|---|---|---|
| 写提示词 | 每个项目手写 prompt sheet（gourmet `image-prompts.md` 28 条、marine 同款 + Progress Tracker 复选框） | 每项目重造一遍 |
| 生成图片 | 人在 Gemini app / Nano Banana 里**逐条复制粘贴**生成 | 最耗时的瓶颈，28 张图全靠手 |
| 转格式 | 导入脚本写了三遍：gourmet `import-images.mjs`、marine 用 `image-prompt-studio` skill、外加 Hermes comfyui skill | 同一件事三份实现 |
| 配音 | 无音频资产，全靠浏览器 Web Speech API 运行时合成（gourmet 专门写了音色排序逻辑规避 Chrome 联网音色翻车） | 音质不稳、无法离线一致 |

## 产品：一个清单 + 一条命令

每个目标 App 放一个 `factory.config.json`，声明它要什么资产（图片/配音/尺寸/风格/数据源），然后：

```bash
npx asset-factory prompts    # 生成 prompt sheet + 提示词 JSON
npx asset-factory generate   # 交给后端批量出图（ComfyUI 本地 / Gemini API / 手工模式）
npx asset-factory import     # 统一转 webp/裁尺寸，落到 public/images/...
npx asset-factory tts        # edge-tts 批量生成中文/英文配音 mp3（全新能力）
npx asset-factory audit      # 覆盖率报告：还差哪些图/音
```

**单一数据源原则**：资产清单不另存一份——直接读 App 自己的数据模块（gourmet `src/data/foods.ts` 的 `Food[]`、marine `src/data/creatures.ts`），App 加一道菜，工厂自动知道要多一张图。

## 关键设计决策
- **后端可插拔**：ComfyUI（本机已装，但零模型，需先下 checkpoint）/ Gemini API（gourmet 已有 paid key 流程）/ 手工模式（只出 prompt sheet，人肉生成后 import——今天的流程但工具统一）
- **配音是新增值**：edge-tts 本地免费，预生成 mp3 替代运行时合成，顺带解决 gourmet 的音色翻车问题
- **状态可续跑**：进度存本地 state 文件，生成一半断电不重来（替代 marine 的手工复选框）

## v1 边界（不做）
- 不做 Web 服务/云同步，纯本地 CLI + 可选本地审核页
- 不替各 App 改代码接音频（只产出资产 + 集成文档）
- 不做角色一致性控制（那是 v2 用 img2img/IP-Adapter 的事）
