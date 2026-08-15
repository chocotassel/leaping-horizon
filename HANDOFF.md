# 节奏生成改造：music-structure-template-v3 交接

更新日期：2026-08-16

## 当前结论

这一阶段已经把问题从“局部强度够不够、C/S/M 数量够不够”推进到“音乐结构是否可识别”。默认谱面现在使用 **`music-structure-template-v3`**：先用 Beat This! 的真实 downbeat 建立小节，再用 librosa 特征与 scikit-learn 聚类识别 section 和重复乐句，最后按乐句家族编译固定障碍母版。

最重要的行为已经落实：

- 同一段旋律再次出现时，`core` 障碍逐槽完全相同；
- 重复乐句共有的旋律加花作为 `auxiliary-common`，障碍也完全相同；
- 只有高潮额外真实峰值可作为 `overlay` 发生局部变化；
- 不同家族按 `familyId` 使用不同的小节 motif sentence，FA 与 FB 不会再坍缩成同一套组合；
- 小节、乐句和 section 边界全部引用 Beat This! 原始时间，没有 BPM 网格和吸附。

当前仍只保留一个“心流”难度。不要在这个阶段重新拆普通/困难/专家。

## 当前可玩输出

首选关卡：`src/levels/slice-at-two.level.json`

| 项目 | 当前值 |
| --- | ---: |
| Beat This! 原始 beat / downbeat | 318 / 80 |
| 音乐小节 | 80 |
| 可玩 Beat This! 槽 | 314 |
| 8 小节主乐句 / 多尺度 section | 10 / 14 |
| 可玩 bar module | 79 |
| `core` 事件 | 310 |
| `auxiliary-common` / `overlay` | 101 / 15 |
| 旋律加花合计 | 116 |
| 击打方块 | 422 |
| 纯躲避事件 | 4 |
| 总事件 | 426 |
| 带地刺事件 / 地刺单元 | 301 / 733 |
| 最长短间隔旋律连段 | 5 |
| 持续能量高潮 | 约 153.42 s |

两组 M 各有两个 `00000` 移动槽，因此 314 个可玩骨架槽编译为 310 个落盘 core 事件。422 个目标加 4 个纯躲避墙，正好等于 426 个总事件。

## 已确认的歌曲结构

分析输出位于 `public/analysis/slice-at-two.rhythm-analysis.json` 的 `musicalStructure`。

- FA：34.16–50.72 秒与 83.80–100.32 秒；
- FB：50.72–67.26 秒与 100.32–116.84 秒；
- 组合：34.16–67.26 秒与 83.80–116.84 秒，完整 16 小节返回；
- 重叠 OFB：42.44–58.98、92.06–108.58、133.34–149.82 秒。

生成关卡中 FA/FB 分别映射为 `verified-main-a` / `verified-main-b`，并记录在 `analysisFamilyId` 与 `familyId`。重叠窗口步长为 4 小节，用来捕获从标准 8 小节中点开始的旋律；编译后 `appliedRangeLinks` 记录实际复制的范围。

## v3 实现结构

### 1. 音频与结构分析

`scripts/analyze-rhythm.py`：

- 运行 librosa、Basic Pitch ONNX、Beat This! 和 preference fusion；
- 从 Beat This! 的 318 beat、80 downbeat 构造 80 小节；
- 提取 `chroma_cens`、13 维 MFCC、16 相位 onset micro-rhythm；
- 用和声 0.50、音色 0.20、微节奏 0.30 的余弦相似度比较 8 小节乐句；
- 用 scikit-learn Ward agglomerative clustering 的多个分辨率投票生成 section；
- 用 average-linkage 识别标准 8 小节家族，用 complete-linkage 识别步长 4 小节的严格重叠家族；
- 输出 beats、downbeats、bars、sections、phrases、families、相似矩阵和 links。

主家族同类阈值为 0.84，相关变体阈值为 0.78；重叠家族严格阈值为 0.88，相关变体阈值为 0.82。单例保留为 `unique-low-confidence`，不强行合并。

### 2. 结构化谱面编译

`scripts/build-rhythm-levels.mjs`：

- 按 `familyId + durationClass` 生成一次 canonical template；
- 每个家族固定方向、相对槽和 bar motif sentence；
- 每个 8 小节短语使用 `opening / call / answer / turn / lift / drive / peak / cadence` 角色；
- `familyId` 旋转 bar plan，让不同家族有不同组合，同时同家族 exact reuse；
- `core` 使用 Beat This! 可玩峰值；
- 重复家族只有在每个 occurrence 的相对间隙都检测到旋律峰时，才批量接纳 `auxiliary-common`；
- 高潮附近额外候选标为 `overlay`，这是唯一可变层；
- 对跨标准乐句边界的 OFB 再做范围复制；
- 每个 event 保存 `phraseId`、`familyId`、`barIndex`、`barRole`、`downbeatCue`、`relativeSlotKey`、`layer` 和模板信息。

`generation.flowSections` 是沿用旧名字的输出兼容字段；在 v3 中它表示母版编译后的 bar/motif 块，不再负责按局部 flow 任意分割歌曲。结构输入应看 `musicalStructure.sections`、`phraseSections` 和 `barSections`。

### 3. 可玩性与回归验证

`scripts/level-check.mjs`：

- 同时推进生存路线和 Full Combo 路线；
- 按真实事件间隔和 `0.23 s/道` 校验横移；
- 禁止第 2–4 道出现被地刺夹住的单格空口；
- C 形必须保留可露营边；
- 标准 M 必须匹配 `22200,00000,10000,10000,00000,22200`，空槽不得落盘；
- 每个可玩 bar module 必须有 downbeat cue；
- FA、FB、16 小节组合及重叠 OFB 必须精确复用；
- 重复家族的 `core + auxiliary-common` 必须一致；
- 不同重复家族的 core signature 不得相同；
- 高潮密度、地刺压力、旋律短间隔和全部统计元数据都要达到阈值。

### 4. 试听室

`src/tools/RhythmLabApp.tsx` 与 `src/tools/rhythm-lab.css`：

- 波形上同家族显示相同色块，section 用白线标记；
- 8 小节结构条可以点击跳转；
- 当前家族面板可在重复 occurrence 之间来回跳；
- 重叠重复区域提供单独的 42.44 / 92.06 / 133.34 秒入口；
- 原有保留、排除、漏点反馈和 JSON 导入导出仍可用。

## 时间规则：后续修改不得破坏

所有 Level v3 事件时间必须是某个成熟检测器的原始峰值。允许：

- 选择或拒绝候选；
- 把 60 ms 内的多来源候选归组，并选一个真实成员；
- 用结构身份决定障碍是否复用。

不允许：

- 按 BPM 建等间隔格；
- snap、插值、平均候选时间；
- 为了让障碍看起来整齐而补一个并不存在的事件；
- 用一次有误差的人工点击直接替换检测器时间。

人工原始标注：`data/annotations/slice-at-two.human-beats.json`。复核反馈：`data/annotations/slice-at-two.review-feedback.json`。旧网格基线：`data/baselines/slice-at-two.legacy-times.json`。

## 在另一台 Windows 电脑恢复

仓库不提交 `.venv-analysis/`、`.cache/` 和模型权重。拉取当前工作后：

```powershell
npm install
npm run setup:rhythm
npm run analyze:rhythm
npm run dev
```

要求 Node.js、npm、Python 3.11 或 3.12、ffmpeg。若 `python` 不是目标解释器：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-rhythm-env.ps1 -PythonCommand py
```

若虚拟环境位于其他路径，设置 `RHYTHM_PYTHON`。首次分析会下载 Beat This! 官方 checkpoint 到 `.cache/`。当前结构层只使用已安装的 librosa / NumPy / SciPy / scikit-learn，不需要另装 All-In-One 或 MSAF。

页面：

- 游戏：`http://localhost:5173/`
- 节奏与结构试听室：`http://localhost:5173/rhythm-lab.html`
- 人工标注器：`http://localhost:5173/beat-marker.html`
- 谱面想法板：`http://localhost:5173/pattern-lab.html`

完整验收：

```powershell
npm run build
npm run test:level
npm run test:physics
npm run test:rhythm-feedback
```

只在分析 JSON 已存在时重建关卡：

```powershell
npm run build:rhythm-levels
```

## 下一阶段优先级

1. 在试听室反复跳转 FA、FB、OFB 的 occurrence，确认“同旋律同操作、不同乐句不同句法”能直接听出来和玩出来。
2. 重点试玩 phrase-02 标准 M 与 phrase-10 高潮 M，确认口袋意图无需说明也能理解。
3. 若换段仍有误，先调整 `musicalStructure` 的特征权重、阈值和多尺度边界支持；不要退回按强度随机切段。
4. 用 3–5 首不同风格歌曲验证 8 小节假设与 4/4 小节推断；对非 4/4、弱 downbeat 或长度不足 8 小节的歌曲补明确 fallback。
5. 再手打同一首歌 2 遍，用多遍一致性区分手误、反应延迟和真正偏好，然后重训 preference fusion。
6. 发布商业版本前复核模型权重与训练数据许可；开源代码许可宽松不代表模型训练数据自动适合商业发布。

## 已知但不阻塞

- Basic Pitch 会提示未安装 TensorFlow/CoreML/TFLite；当前明确使用 ONNX，可以忽略。
- Vite 会提示 Three.js chunk 超过 500 kB；不影响当前功能，后续可按页面懒加载。
- 结构分析对当前歌曲工作正常，但 8 小节 phrase 和 4 小节 overlap 是音乐假设，跨曲风验证仍未完成。
- 六个对照轨继续保留各自真实事件时间；只有主 Beat This! 谱面严格执行跨 occurrence 的结构复用，避免把 Beat This! 的槽强套给其他检测器。
- All-In-One 能提供更高层的功能段标签，但 Windows 安装成本较高；当前 librosa + scikit-learn 已直接解决“重复旋律复用障碍”的核心需求，可后续作为可选对照，不应成为运行必需项。

设计原理与字段细节见 `RHYTHM_PIPELINE.md`，玩家体验和形态规则见 `FLOW_DESIGN.md`。
