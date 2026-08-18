# Rhythm Authoring Context

Leaping Horizon 的关卡生产不是“全自动懂歌”，而是“机器批量提取证据，人按片段做少量玩法决策”。完整操作见 [docs/rhythm-authoring-workflow.md](docs/rhythm-authoring-workflow.md)，自动分析的可信边界见 [能力矩阵](docs/research/music-analysis-capability-matrix.md)。

## 领域词汇

**Measured Evidence（实测证据）**

落在最终游戏音频原始时间轴上的 beat、attack、音符、连续 F0 等机器观察。每条证据都必须注明来自直接 mix 还是模型估计分轨；它不等于情绪、高潮或创作意图。

**Estimated Stem（估计分轨）**

Demucs 从最终游戏音频估计出的 `vocals`、`drums`、`bass`、`other` 四个声部。它们允许串音和误分，不能称为真实录音分轨。

**Metric Grid（度量网格）**

Beat This 只在完整 mix 上运行一次得到的 beat/downbeat 网格。它描述拍子位置，不直接决定玩家要演奏哪个声部。

**Timing Evidence（时间证据）**

回答“方块何时出现”的发音、起音或击打事件。一个 Region 可以多选 Timing layers，让多个声部共同提供目标时间。

**Lane Evidence（轨道证据）**

回答“方块在五轨哪里”的音高轮廓或动作手势。一个 Region 始终只有一个 Lane Driver，避免多个声部同时争夺轨道方向。

**Accent Evidence（强调证据）**

回答“哪些已有目标更重要”的重音事件。Accent 只能增强附近 Timing 目标，不能单独制造新方块。

**Authoring Score（编排谱）**

每首歌的 editor-only `authoring.json`，汇总 Evidence Streams、Regions、Repeat Sets、算法建议和 fingerprints；不进入浏览器运行包。

**Region（片段）**

一次人工决策的最小单位，通常来自乐句，缺少乐句时退化为段落。目标是确认少量 Region，而不是逐拍手调。

**Repeat Set（重复组）**

算法认为属于同一重复身份的一组 Region occurrences。同步后复用动作语法，但每次仍使用该 occurrence 自己的证据时间。

**Performance Preset（演奏预设）**

面向非音乐背景作者的一组安全默认 Region Recipe，例如人声领奏、鼓点律动、低音推进、合奏、长音轨迹和留白。

**Region Recipe（片段配方）**

一个 Region 的玩法合同：多选 Timing layers、选择一个 Lane Driver、可选 Accent，并设置密度、手感、移动和挑战。配方只筛选和排列证据，不移动证据时间。

**Arrangement（编排）**

一首歌全部 Region Recipes 的集合，保存在 `edits.json` v3 的 `arrangements` 中。

**Review Queue（复核队列）**

编辑器列出的低覆盖或建议不确定 Region。默认只需优先试听这些片段，而不是逐段重新判断整首歌。

**Row Override（逐点覆盖）**

在既有 Rhythm Point 上手工替换一整行五轨内容。它在 Arrangement 编译之后应用，因此永远是最后裁决。

补充词汇：Rhythm Point 是允许落行的证据时间；Base Row 是保守算法生成的起始行；`0/1/2` 分别为空、可击碎方块和地刺。

## 生产流

```text
source audio
  -> final game MP3
  -> cached Demucs core-4 Estimated Stems
  -> analysis
       mix: attack / note / one Beat This Metric Grid
       stems: per-role Timing / Lane / Accent Evidence
  -> level.json + editor-only authoring.json
  -> 人在 editor 先采用建议，再处理 Review Queue
       preset -> Timing layers + one Lane Driver + optional Accent
  -> edits.json v3
       Arrangement + Row Overrides + color ranges
  -> build-time compile
       Base Rows -> Arrangement -> Row Override -> compact runtime Level
```

重新分析会重建 `level.json` 和 `authoring.json`，但保留 `edits.json`。音频或证据 fingerprint 不匹配时必须停止并由人确认或重新采用建议，不能静默套用旧决定。

## 不变量

- 所有关卡行必须落在 Measured Evidence / Rhythm Point 的原始时间；不吸附 BPM、不平移时间、不凭空造点。
- 全曲只有一份来自 mix 的 Beat This Metric Grid；任何 stem 都不单独运行 Beat This。
- `vocals`、`drums`、`bass`、`other` 和它们的 F0 都是模型估计证据，不是真实分轨，也不能证明情绪或歌词含义。
- Timing layers 可以多选；Lane Driver 只能有一个；Accent 不能独立生成目标。
- beat、响度、音高、覆盖率和重复性可以产生预设与复核建议；高潮、颜色和“这一段最终演奏谁”仍由人定稿。
- 同一最终游戏音频和分轨模型命中内容寻址缓存；audio/evidence fingerprint 防止错歌或旧证据被静默复用。
- 分轨失败时保留 mix 分析并禁用对应 stem 证据；缺少 Authoring Score、配方引用不可用证据或 fingerprint 不匹配时 fail closed。
- Repeat Set 复用动作序列，但使用每个 occurrence 自己的实测事件时间。
- Region Recipes 不可重叠；密度调整必须确定性；每行始终限制为五条轨道。
- 编译顺序是 Base Rows → Arrangement → Row Override；手工逐点修改最后生效。
- stems、`authoring.json`、`edits.json` 和编译器只用于离线编辑/构建；runtime 只保留最终 events、颜色与对应 event times。
