# 一页完成一首歌：预设优先的片段编排

这套流程面向不懂乐理的个人开发者。你不需要判断和弦或逐拍校准；每个片段通常只做两个决定：**玩家主要演奏谁，以及方块怎样走五条轨道。** 算法提供时间、音高、重音和重复候选，人负责情绪、高潮、留白与最终手感。能力边界见 [音乐分析能力矩阵](research/music-analysis-capability-matrix.md)。

## 0. 首次准备与生成

```sh
npm run setup:rhythm
npm run setup:separation
npm run generate -- "path/to/song.wav" "Song title" "Artist" song-id
npm run test:stems
```

`generate` 会先制作最终游戏 MP3，再对这份 MP3 运行 CPU Demucs，缓存 `vocals`、`drums`、`bass`、`other` 四个估计分轨，然后生成 `level.json` 和 editor-only `authoring.json`。第一次会下载模型并较慢；同一游戏音频和同一模型会命中 `work/<song-id>/core4` 的内容寻址缓存。

这四个 stem 只是模型估计，可能串音、漏音或把乐器分错，不能当成真实录音分轨。Beat This 不会分别跑四次：全曲只有一份在完整 mix 上测得的 beat/downbeat Metric Grid，所有 stem 与 mix 共用最终游戏音频的零点。

`npm run test:stems` 会运行分轨缓存/失败退化 fixture，以及 Python 的 F0、逐 stem 证据行为测试。

## 1. 打开编辑器并采用默认稿

```sh
npm run editor
```

打开 `http://localhost:5173/editor.html`，选择歌曲，点击“一键采用全曲建议”。这会生成 `edits.json` v3 的 Region Recipes；它是可试听的默认稿，不代表算法理解了歌词或情绪。

先看“优先复核”队列。这里只列低覆盖或建议不确定的 Region；其余标为“建议稳定”的片段可以先保留，不必从头逐段重做。

## 2. 每个待复核 Region 先选预设

试听整段后，先选最接近听感的一个预设：

| 预设 | 适用听感 |
|---|---|
| 人声领奏 | 发音决定落点，人声估计 F0 可带出上升、下降或 S 形轨迹 |
| 鼓点律动 | 鼓击决定落点，左右交替形成节奏动作 |
| 低音推进 | 贝斯起音和音高推动轨道前进 |
| 全员合奏 | 多个声部共同提供落点，适合饱满段落 |
| 长音轨迹 | vocals、other 或 bass 的连续估计 F0 驱动五轨曲线 |
| 留白 | 不生成本段演奏行，用于呼吸、停顿或蓄力 |

默认预设已经填好声部权重、密度、手感、移动和挑战。多数 Region 选完预设即可；只有听起来不对时，再做第二个决定——修改“轨道跟随”。

## 3. 需要微调时，只分清三种证据

| 证据角色 | 回答的问题 | 编辑规则 |
|---|---|---|
| Timing | 方块何时出现？ | “领奏者 / 一起演奏”可以多选；第一个是主要声部，其余声部共享本段演奏预算 |
| Lane | 方块走哪条轨？ | 每段只能选一个 Lane Driver：某个声部的音高、中间定点或左右交替 |
| Accent | 哪些已有方块更重要？ | “强调声部”可以加入鼓等重音，但只增强附近目标，不单独制造方块 |

Metric Grid 只提供拍与小节位置的度量参照，不是假装成演奏声部。长音和滑音的 F0 现在可来自估计的 vocals/bass 等 stem；它仍是模型证据，不证明该处一定是人声。

保持预设默认值时，只需检查：

1. Timing 是否在演奏你耳朵关注的声音；
2. 单一 Lane Driver 是否给出了可预判的移动。

仍需调整时，再按顺序改密度、移动幅度、挑战。密度只筛选已有时间，移动只改变轨道范围，挑战不能替代主旋律目标；如果不听音乐也能轻松通过，先换 Timing/Lane，而不是堆地刺。

## 4. 重复同步，最后才逐点修

有 Repeat Set 时，先调好第一次出现，再启用“同步重复”。系统复用动作语法，但每次仍落在该 occurrence 自己的实测时间上。乐器、歌词重点或情绪功能变了，即使算法认为相似，也可以不同步。

整段配方稳定后才使用 Row Override 修个别五轨行、删除误点或补必要地刺，再设置少量颜色区间。编译顺序固定为：

```text
Base Rows -> Arrangement (v3 Region Recipes) -> Row Override
```

因此 Row Override 永远最后生效；一开始逐点修，会在之后更换预设时制造重复劳动。

## 5. 保存、试玩、只回改问题片段

点击“保存”写入 `src/songs/<song-id>/edits.json`，再打开游戏预览。重点检查：

- 闭眼听时能否预判下一次移动；
- 方块是否像在演奏声音，而不是只在躲障碍；
- 长音高变化是否形成清楚且可移动的轨迹；
- 重复句是否保留身份，同时允许有意变化；
- 高潮、转折和颜色是否来自你的片段决策。

每轮只回到有问题的 Region，不用重新校对全曲。

## 缓存、fingerprint 与 fail-closed

重新运行 `npm run generate` 会重建 Base Level 和 Authoring Score，但保留 `edits.json`。系统同时记录最终游戏音频的 audio fingerprint 和分轨/证据的 evidence fingerprint：

- 两者匹配：继续使用缓存和现有编排；
- 音频、剪辑、模型或证据变化：编辑器要求“重新采用当前分析建议”，不会静默套用旧 Arrangement；
- Demucs 失败：保留 mix 分析，stem 专属预设/证据不可用，不会伪造 stem 事件；
- Recipe 引用不可用 Timing/Lane/Accent、连续 F0 为空、sidecar 错歌、Region 重叠或 fingerprint 不匹配：停止应用该编排并给出明确错误。

确认只是同一录音的重新分析后，重新采用建议并优先抽听 Review Queue；如果换了录音或剪辑版本，应重新检查所有 Row Overrides。

stems、Authoring Score、`edits.json` 和编译器只存在于离线编辑/构建阶段；游戏运行时只带最终事件、颜色和对应时间。
