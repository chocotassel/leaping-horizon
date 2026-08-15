# 节奏与音乐结构生成管线

更新日期：2026-08-16
当前布局版本：`music-structure-template-v3`

## 一句话结论

主谱不再按一段段局部强度随机挑 C/S/M。现在先从音乐中识别真实小节、段落和重复乐句，再为每个乐句家族生成一次标准障碍母版；同一旋律再次出现时复用同一组障碍。BPM 只作为歌曲展示信息，任何事件都不会被吸附到等间隔网格。

## 端到端流程

```text
音频
  ├─ Beat This!：beat / downbeat 真实时间
  ├─ librosa：chroma_cens / MFCC / onset strength
  ├─ Basic Pitch：旋律音符起点
  └─ preference fusion：从成熟检测器候选中学习人工偏好
        ↓
真实 downbeat → 小节 → 多尺度段落 + 8 小节乐句家族
        ↓
同家族 canonical template + 每小节 bar module
        ↓
core 节拍行 + auxiliary-common 共同旋律行 + climax overlay
        ↓
生存路线 / Full Combo 路线 / 重复一致性验证
```

分析与重建：

```powershell
npm run analyze:rhythm
```

只用已有分析结果重建关卡并验证：

```powershell
npm run build:rhythm-levels
npm run test:level
```

试听全部算法：

```powershell
npm run lab:rhythm
```

## 1. 检测层：只产生真实候选时间

| 来源 | 当前职责 |
| --- | --- |
| Beat This! 1.1.0 | 主谱节拍骨架和 downbeat；本曲输出 318 个 beat、80 个 downbeat |
| librosa 0.11.0 | 多频带起音候选，以及结构分析需要的和声、音色和微节奏特征 |
| Basic Pitch 0.4.0（ONNX） | 非均匀的旋律音符起点 |
| preference fusion | 用人工点击与复核反馈，在已有检测器候选中学习“更像需要操作的点” |

人工点击保存在 `data/annotations/`，允许包含误触；它只影响候选选择，不会成为时间网格。旧版等间隔结果保存在 `data/baselines/`，仅用于对照。

时间不变量：

- `timeSeconds` 必须直接来自某个检测器峰值；
- 候选可以被合并、选择或拒绝，但不能被平移、插值或补齐；
- 60 ms 内的多来源候选聚成一组，保留其中一个真实成员作为代表，不取平均时间；
- 常规区域要求候选与已有事件至少相隔 120 ms，高潮附近放宽到 95 ms；间隔规则只删除候选；
- `ticksPerBeat` 和 `beatOffsetSeconds` 不允许重新进入 Level v3。

## 2. 结构层：先理解“哪一段音乐又回来了”

### 真实小节时间线

Beat This! 的 80 个 downbeat 直接形成 80 个小节。内部段落、乐句和小节边界都引用这些原始 downbeat 时间；只有最后一个开放小节会以解码后的歌曲时长收尾。当前推断为稳定的四拍小节。

`public/analysis/slice-at-two.rhythm-analysis.json` 的 `musicalStructure` 保存完整结果：

- `beats` / `downbeats` / `bars`：真实时间线；
- `sections`：音乐换段；
- `phrases` / `families`：不重叠的 8 小节乐句与身份；
- `overlappingPhrases`：步长为 4 小节的滑动 8 小节窗口，用于发现从半个乐句处开始的重复；
- `similarityMatrix` / `phraseLinks`：相似度及同家族、相关变体关系。

### 成熟特征与聚类

结构分析直接使用 librosa 与 scikit-learn：

- 和声：`chroma_cens`，每小节 4 个局部时间片；
- 音色：13 维 MFCC，稳健缩放后每小节 2 个时间片；
- 微节奏：librosa onset strength，每小节 16 个归一化相位槽；
- 乐句相似度：和声 0.50、音色 0.20、微节奏 0.30 的加权余弦相似度；
- 段落边界：scikit-learn Ward agglomerative clustering，加相邻时间连接约束，在 6/8/10/12/14/16/18 个聚类尺度上投票；
- 8 小节家族：预计算余弦距离上的 agglomerative clustering。

不重叠乐句的同家族阈值为 0.84，0.78–0.84 只记为 related variant，不强制共用母版。滑动窗口使用 complete linkage，家族内每一对都必须达到 0.88；0.82–0.88 也只记为相关变体。低置信度单例保留为 `unique-low-confidence`，不会为了凑家族而误合并。

多尺度结构投票还限制单个 section 最长 16 小节；过长时只在已有真实 downbeat 上补一个低置信度边界，不制造时间。

### Slice at Two 已确认的重复关系

| 结构身份 | 第一次 | 再次出现 | 生成约束 |
| --- | --- | --- | --- |
| FA | 34.16–50.72 s | 83.80–100.32 s | 8 小节 core 与共同旋律障碍完全复用 |
| FB | 50.72–67.26 s | 100.32–116.84 s | 8 小节 core 与共同旋律障碍完全复用 |
| FA + FB | 34.16–67.26 s | 83.80–116.84 s | 整段 16 小节 core 序列相同 |
| 重叠家族 OFB | 42.44–58.98 s | 92.06–108.58 s、133.34–149.82 s | 跨固定乐句边界的 8 小节 core 序列相同 |

FA 与 FB 是不同家族，当前会得到不同的小节 motif sentence；“同旋律相同”不等于“所有段落都长得一样”。

## 3. 编排层：家族母版、每小节句法与三种事件层

### Canonical template

主 Beat This! 谱面按 `familyId + durationClass` 建立 canonical template。母版只生成一次，其他 occurrence 复制其 `relativeSlotKey`、障碍行、方向变换和小节模块。重叠重复关系会在普通 8 小节切分之后再覆盖对应范围，以保证跨边界重复也精确一致。

每个 8 小节乐句包含明确的 `barRole`：

```text
opening → call → answer → turn → lift → drive → peak → cadence
```

家族身份会旋转/选择不同的 bar motif sentence，因此 FA、FB 等不同家族可辨认；同家族则保持相同。每个可玩小节在 `barSections` 中有 `downbeatCue: true`，首个实际槽位也带 downbeat cue 元数据。它只表达结构重音，不新增或移动事件。

历史字段 `generation.flowSections` 仍为兼容保留，但 v3 中它是 canonical template 编译后的“小节 motif 块”清单，不再是按局部 flow 任意切段的输入。

### 三种事件层

| `layer` | 含义 | 重复规则 |
| --- | --- | --- |
| `core` | Beat This! 可玩范围内的节拍槽 | 同家族逐槽完全一致 |
| `auxiliary-common` | Basic Pitch / librosa / preference fusion 在同一相对节拍间隙都检测到的旋律装饰 | 批量接纳或批量拒绝，固定同一障碍行；重复 occurrence 完全一致 |
| `overlay` | 高潮附近额外保留的真实旋律峰值 | 唯一允许按当前 occurrence 改变的层，明确标为 `climax-overlay-hit` |

重复发生在不同绝对时间，因此“完全一致”指相同的相对槽、事件类型和五道障碍行；各 occurrence 仍保留自己的真实 detector timestamp。

当前主谱从 318 个 Beat This! 原始 beat 中取得 314 个可玩范围槽；两组 M 的 4 个 `00000` 移动槽不写入事件，所以产生 310 个 core 事件。再加入 116 个真实旋律事件后，最终为：

| 项目 | 数量 |
| --- | ---: |
| 击打方块 | 422 |
| 纯躲避事件 | 4 |
| 总事件 | 426 |
| `auxiliary-common` + `overlay` | 116 |
| 地刺单元 | 733 |
| 带地刺事件 | 301 |
| 最长短间隔旋律连段 | 5 |
| 8 小节主乐句 | 10 |
| 可玩小节模块 | 79 |

## 4. M 形与可玩性

标准左口袋 M 必须逐槽等于：

```text
22200,00000,10000,10000,00000,22200
```

其镜像定义仍为：

```text
00222,00000,00001,00001,00000,00222
```

当前编译器固定采用左口袋：首尾是纯躲避墙，中间两个空槽只提供横移时间，不写入 `events`；求生玩家可留在右侧，Full Combo 玩家必须左划吃两个方块再撤回。高潮 M 保留同样锚点，允许真实 overlay 旋律峰进入口袋。

验证器逐事件推进两套五道状态图：

- 生存图允许放弃方块，但每一行必须至少有一条可达的非地刺路线；
- Full Combo 图在目标行必须到达方块所在道，并穿过所有纯躲避墙；
- 横移能力按真实相邻事件时间计算，`minTravelSecondsPerLane = 0.23`；
- 第 2–4 道禁止地刺形成单独一格的内部空口；
- C 形必须保留至少一条可露营边；
- 标准 M 必须精确匹配六槽模板且空槽不落盘；
- FA、FB、16 小节组合和重叠 OFB 的 core 序列必须完全相同；
- 重复家族的 `core` 与 `auxiliary-common` 都必须一致，只有 `overlay` 可例外；
- 高潮方块率必须明显高于开场，并保持规定的地刺压力。

## 5. 试听与人工反馈

`/rhythm-lab.html` 现在同时是节奏试听室和结构检查器：

- 波形背景以同一 `familyId` 使用同色块；
- 白线显示多尺度 section 边界；
- 8 小节结构条可点击跳到任一乐句；
- 当前家族面板可在同家族 occurrence 间跳转对听；
- 重叠重复区也提供多个时间入口，便于直接比较 42.44 / 92.06 / 133.34 秒；
- “保留刚才的点 / 刚才不该有 / 这里漏了一个”仍写入复核反馈。

导出的反馈文件放到：

```text
data/annotations/slice-at-two.review-feedback.json
```

下一次 `npm run analyze:rhythm` 会提高这些决定的训练权重，但仍不会把人工时间直接变成事件时间。

## 6. Windows 环境

推荐 Python 3.11 或 3.12：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-rhythm-env.ps1 -PythonCommand python
```

如果分析环境不在默认位置，设置 `RHYTHM_PYTHON`。第一次分析会把 Beat This! 官方 checkpoint 下载到 `.cache/`。结构分析只依赖当前环境已有的 librosa、NumPy、SciPy 和 scikit-learn，不要求额外安装重量级端到端结构模型。

运行时障碍池按 2.5 秒可见窗口的最大事件密度分配；命中特效池按 0.72 秒窗口内的事件数动态扩容，避免短间隔旋律在视觉上被旧固定容量吞掉。
