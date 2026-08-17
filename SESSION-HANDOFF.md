# Leaping Horizon 会话交接

更新时间：2026-08-18（Asia/Hong_Kong）

这份文件用于在另一台电脑或新的 Codex 会话中继续当前工作。开始前先阅读本文件、根目录 [`CONTEXT.md`](./CONTEXT.md)，以及 [`docs/adr/0001-evidence-grounded-song-direction.md`](./docs/adr/0001-evidence-grounded-song-direction.md) 和 [`docs/adr/0002-performance-score-before-obstacle-direction.md`](./docs/adr/0002-performance-score-before-obstacle-direction.md)。

## 当前目标

用户最初认为自动生成关卡在歌曲之间过于同质化，随后试玩新版后进一步指出：关卡虽然外观不同，但仍像躲避游戏，不像音游。当前产品目标已经明确为：

1. 玩家用飞镖撞击 Target Cell 来“演奏”歌曲，而不是主要躲避 Hazard Cell。
2. Target Cell 必须对应实际听见的打击、琴音、音符、人声发音或显著旋律转折，不能只落在 BPM/四拍网格上。
3. 五条轨道在局部旋律中表达从低音到高音；连续升降音应形成折线、弧线或 S 形轨迹。
4. 密集旋律可以形成类似 `10200 → 20100 → 10200 → 20100 → 10200` 的快速相邻轨往返，让音乐本身帮助玩家预判。
5. 命中 Target Cell 时播放短促、低延迟、与该 Attack Event 音高和来源特征一致的 Hit Voice。
6. 全流程自动、离线、无需人工标注。当前实现未接入在线大模型。

下一步产品工作不是继续凭指标改算法，而是让用户试玩本次 Performance Score 版本，并按“歌曲 + 时间点”收集听感和操作反馈。

## 不可打破的优先级

```text
audio.mp3
  -> analyze-rhythm.py：测量攻击沿、音高、节奏和结构证据
  -> transcribePerformance(...)：生成 Performance Score
       |  唯一决定 core Target Cell 的 time / lane / hitSound
       v
  -> build-rhythm-levels.mjs
       + Directed Song Score：只修饰 hazard / pressure / color / visual accent
       v
  -> level.json
       -> GameController：实际 target-hit 时播放 Hit Voice
```

规则：

- `PerformanceScore` 是 core Target Cell 时间与轨道的唯一权威。
- `DirectedSongScore` 仍负责歌曲场景、转折、压力、颜色和少量危险修饰，但不能移动、删除或替换演奏目标。
- Beat This 的孤立节拍只能作为 metric/强度证据，不能单独发明 Attack Event。
- 事件保持测量时间，不吸附到 beat grid。
- 当前四首均走 Performance 模式；旧的模板/Kinetic Form 编译器仅作为没有 Performance Score 时的兼容回退。
- Performance 模式下，旧 Phrase Identity Kinetic Form 对 Target lane 的权威明确标记为 `supersededByPerformanceScore`。
- 不要为了恢复 M/Wave/Sweep 数量或视觉配额而覆盖 Performance Score。

## 已完成实现

### 1. 音频分析

主要文件：[`scripts/analyze-rhythm.py`](./scripts/analyze-rhythm.py)

- Librosa onset 不再把谱面放在能量峰值上；强度仍取峰值，时间回溯到此前的实际起振沿。
- 输出 percussion、harmonic 和 bass/low-mid/mid/high-mid/high 五个频段的 Attack evidence。
- Basic Pitch 提供音高、时值、音域和复音信息。
- Beat This 提供拍号/小节结构，但不再支配 Target Cell。
- 自适应乐句分段使用真实 downbeat 和证据边界，乐句为 2–12 bars；没有固定八小节模板。
- 超长区域在最高证据 seam 上递归拆分；弱证据拆分会进入 diagnostics。

注意：`work/` 中的 analysis JSON 被 `.gitignore` 忽略，换电脑时若未复制整个工作区，需要重新分析。

### 2. Performance Score

主要文件：

- [`scripts/rhythm/performance-transcriber.mjs`](./scripts/rhythm/performance-transcriber.mjs)
- [`scripts/rhythm/performance-transcriber.test.mjs`](./scripts/rhythm/performance-transcriber.test.mjs)

Public seam：

```js
transcribePerformance(analysis, options?) -> PerformanceScore
```

Score 结构：

```text
PerformanceScore
  schemaVersion / kind / algorithm / audioFingerprint
  attackEvents[]
  melodicTraces[]
  diagnostics

AttackEvent
  id / timeSeconds / lane
  pitchMidi / pitchClass / sourceRole / strength
  evidenceIds / sourceTimeEvidence
  phraseId / phraseIds
  continuity
  hitSound
```

当前行为：

- 55ms 内的多检测器证据融合为同一个 Attack Event。
- 检测器边界造成的小于 18ms 重复会确定性合并。
- Attack time 优先取回溯后的非 beat 起振沿；Basic Pitch 决定音高时不自动决定时间。
- 孤立 Beat This 事件只进入 diagnostics，不生成 Target。
- 音高在每个局部 phrase/trace 内映射到五轨，保留上升、下降、重复与折返。
- 长音和连续变调会形成 `MelodicTrace`，包括 `s-curve`。
- 复音聚类用音域边界与前后连续性近似选择主声部，并报告 `polyphonicApproximationCount`。
- 全曲 lane 使用动态规划，从 lane 2、time 0 开始按 0.08 秒/轨保证可达；不删除或改动 Attack time。
- 密集打击穿插旋律时优先贴近当前旋律，不再产生无意义的远端随机跳跃。

### 3. Builder 权威接入

主要文件：

- [`scripts/build-rhythm-levels.mjs`](./scripts/build-rhythm-levels.mjs)
- [`scripts/build-rhythm-levels.test.mjs`](./scripts/build-rhythm-levels.test.mjs)

行为：

- 若 analysis 内已有 `performanceScore` 则直接消费；否则自动调用 `transcribePerformance(analysis, { travelSecondsPerLane: 0.08 })`。
- 每个 Attack Event 生成一个单 Target Cell 的 core Choice Row。
- Target Row 精确保留 Attack 的 time、lane、trace、evidence 和 `hitSound`。
- 不额外生成 beat-template Target。
- 同时发生的事件只能作为有证据的 perceptual merge，不允许静默删除。
- Director 仅在极少数强转折旁增加 hazard 或 pressure；当前正式关卡每首只有 2–3 个 spikes。
- Performance compilation diagnostics 记录 input、represented、merged 和 omitted 数量；当前四首 `omittedAttackEventCount = 0`。

### 4. Hit Voice

主要文件：

- [`src/audio/HitVoice.ts`](./src/audio/HitVoice.ts)
- [`src/audio/AudioEngine.ts`](./src/audio/AudioEngine.ts)
- [`src/game/GameController.ts`](./src/game/GameController.ts)
- [`src/types.ts`](./src/types.ts)
- [`scripts/hit-voice-check.mjs`](./scripts/hit-voice-check.mjs)

`LevelEvent.hitSound`：

```ts
{
  pitchMidi: number;
  pitchClass: number;
  sourceRole: string;
  velocity: number;
  gain: number;
  brightness: number;
}
```

运行时行为：

- 只有真实 `target-hit` 才触发。
- 复用现有 AudioContext 和一个低增益输出总线，不为每次命中新建 AudioContext 或解码采样。
- 2ms attack，约 52–100ms decay，最长约 106ms。
- percussion、melody、vocal-like、wind、bass 使用不同的短音包络/波形倾向。
- 静音、暂停、崩溃或结束后不发声。
- Hit Voice 总线增益受限，目标是补全演奏反馈而不是覆盖原曲。

### 5. Director、颜色和兼容层

主要文件：

- [`scripts/rhythm/song-director.mjs`](./scripts/rhythm/song-director.mjs)
- [`scripts/rhythm/color-timeline.mjs`](./scripts/rhythm/color-timeline.mjs)
- [`scripts/rhythm/density-planner.mjs`](./scripts/rhythm/density-planner.mjs)
- [`src/game/GameScene.ts`](./src/game/GameScene.ts)

保留能力：

- 自动检测 Scene、Narrative Turn、Phrase Identity、Directed Moment、Color Scene 和 Visual Accent。
- 持久配色只在 Narrative Turn 变化；普通强点使用短促 Visual Accent。
- Density Fill 是不计分的 guide，不冒充 Attack Event。
- 固定 M/Wave/Sweep 全曲配额已经移除。

### 6. 契约校验

主要文件：

- [`scripts/level-check.mjs`](./scripts/level-check.mjs)
- [`scripts/level-performance-contract.test.mjs`](./scripts/level-performance-contract.test.mjs)
- [`src/chart.ts`](./src/chart.ts)

Performance 模式强制：

- Target 与 Attack 的 measured time、单一 lane、evidence 一致。
- 没有额外模板 Target。
- Hit Voice 的值有限、范围安全，并来自对应 Attack。
- Melodic Trace 的 lane 不得与 pitch 方向反向；受物理约束时允许暂时留在同 lane。
- 编译计数与实际 events 一致。
- hazards 不能成为关卡密度的主体。
- 没有 Performance Score 的旧关卡仍可读取。

## 当前四首正式结果

| Song | Target Rows | Melodic Traces | S-curves | Pitched Attacks | Spikes | Omitted |
|---|---:|---:|---:|---:|---:|---:|
| Hands On Deck | 1394 | 44 | 17 | 393 | 2 | 0 |
| Rearview Halo | 986 | 27 | 14 | 178 | 2 | 0 |
| Slice at Two | 1083 | 35 | 14 | 181 | 3 | 0 |
| Story Reactions | 1343 | 31 | 21 | 449 | 2 | 0 |

正式产物：

- [`src/songs/hands-on-deck/level.json`](./src/songs/hands-on-deck/level.json)
- [`src/songs/rearview-halo/level.json`](./src/songs/rearview-halo/level.json)
- [`src/songs/slice-at-two/level.json`](./src/songs/slice-at-two/level.json)
- [`src/songs/story-reactions/level.json`](./src/songs/story-reactions/level.json)

## 最近验证状态

在上述正式 JSON 生成后通过：

- `npm run build`
- `npm run typecheck`
- `npm run test:intent`：66/66
- `npm run test:analysis`：12/12
- `npm run test:performance`：18/18
- `npm run test:audio`
- `node scripts/level-check.mjs`：四首通过

Build 有一个非阻塞警告：主 bundle 因内嵌音频和完整 Performance Score JSON 约 12MB。功能正常；如果下一轮处理加载性能，应优先把歌曲数据改成按需动态加载，或把 inspection-only Score/receipt 从 runtime level 中拆出。

## 已知限制

这些不是当前构建错误，而是下一轮可能由试玩反馈触发的改进方向：

1. `vocal-like` 是 Basic Pitch、harmonic onset、持续时值和复音度的启发式判断，没有独立的人声 stem 或歌词/音素模型。
2. 单个飞镖无法同时演奏完整和弦；复音片段当前选择连续主声部近似，并在 diagnostics 中保留近似数量。
3. Hit Voice 是轻量振荡器/滤波器合成，不是从原曲分离出的真实鼓、琴或人声采样。若听感过于电子，可升级为 scale-aware sample kit 或离线 stem-conditioned hit samples。
4. 新关卡平均密度显著高于旧版，可能出现“终于像音游但太密”的反馈。若需要难度分级，应从同一 Performance Score 确定性选择声部/强度层，而不是重新引入 beat 模板。
5. 视觉上仍可提前看到方块；当前“必须听音乐”的提升主要来自高密度且语义一致的动作序列。如果仍可轻松静音通关，再单独评估 approach distance、视觉提示时长或判定窗口。

## 工作区与迁移警告

- 当前分支：`main`
- 当前基准 commit：`a91a3cf3ad3e2a468c464be70249da459b074837`
- 本次工作尚未创建 commit，工作区有大量 modified/untracked 文件。
- 仅在另一台电脑重新 clone `main` 不会包含本文件或本次实现。迁移前需要选择一种方式：提交并推送、导出 patch 并连同二进制资源复制，或直接复制整个项目目录。
- `work/`、`.venv-analysis/`、`.cache/` 和 `dist/` 被 Git 忽略。正式 level JSON 已在 `src/songs/`；analysis 可在新电脑重新生成。
- `scripts/package-minitool.mjs` 和 `scripts/package-minitool.test.mjs` 是本次音乐算法工作开始前已经存在的用户改动。后续代理必须保留，不能回退，也不要把它们归功于本次实现。
- 不要使用 `git reset --hard`、`git checkout --` 或类似方式清理当前 dirty worktree。

当前变更按功能分组：

- Domain/ADR：`CONTEXT.md`、`docs/adr/*`
- Analysis/Director/Performance：`scripts/analyze-rhythm.py`、`scripts/rhythm/song-director*`、`scripts/rhythm/performance-transcriber*`
- Compiler/contracts：`scripts/build-rhythm-levels.mjs`、`scripts/build-rhythm-levels.test.mjs`、`scripts/level-check.mjs`、`scripts/level-performance-contract.test.mjs`
- Runtime audio/game：`src/audio/HitVoice.ts`、`src/audio/AudioEngine.ts`、`src/game/GameController.ts`、`src/chart.ts`、`src/types.ts`
- Visual/density compatibility：`scripts/rhythm/color-timeline*`、`scripts/rhythm/density-planner*`、`src/game/GameScene.ts`
- Generated charts：四个 `src/songs/*/level.json`

## 新电脑恢复步骤

1. 确认本次 dirty worktree 已通过 commit/patch/完整目录复制抵达新电脑。完成标准：`scripts/rhythm/performance-transcriber.mjs`、`src/audio/HitVoice.ts` 和本文件都存在。
2. 安装 Node 依赖：`npm install`。完成标准：`npm run typecheck` 可执行。
3. 若需要重新分析音频，准备 Python/模型环境：`npm run setup:rhythm`。完成标准：`.venv-analysis` 存在且 `npm run test:analysis` 通过。
4. 运行 `npm run test:performance`、`npm run test:audio` 和 `node scripts/level-check.mjs`。完成标准：18 个 performance tests、音频检查和四首正式关卡全部通过。
5. 运行 `npm run dev`，让用户试玩四首新版。完成标准：至少收集一条带歌曲名和时间点的具体反馈，再决定下一处修改。

如果 `work/<song>/analysis.json` 没有迁移，可用已提交的 `audio.mp3` 重新生成。Windows PowerShell 示例：

```powershell
npm run generate -- "src/songs/hands-on-deck/audio.mp3" "Hands On Deck" "momo" "hands-on-deck"
npm run generate -- "src/songs/rearview-halo/audio.mp3" "Rearview Halo" "momo" "rearview-halo"
npm run generate -- "src/songs/slice-at-two/audio.mp3" "Slice at Two" "momo" "slice-at-two"
npm run generate -- "src/songs/story-reactions/audio.mp3" "Story Reactions" "momo" "story-reactions"
```

## 下一次反馈的处理方式

请让用户按以下格式描述问题：

```text
歌曲：
时间点：
问题类型：方块提前/滞后、漏音/多音、轨道音高走势不对、密度过高/过低、Hit Voice 突兀、其他
听到的音乐内容：
期望动作：
```

处理顺序：

1. 在该时间窗口对照 `generation.performanceScore.attackEvents`、`melodicTraces` 和 level events，先确认是 detector、fusion、pitch mapping、global lane realization、Builder 还是 runtime mix 的问题。
2. 修复对应的 deep module，保持 `transcribePerformance(...)` interface 稳定。
3. 为这个具体听感场景增加一个行为测试，再修改实现。
4. 重分析受影响歌曲；如果算法是通用修改，重分析并重建四首。
5. 完成标准：Attack/Target 契约、路线可达、Hit Voice、正式关卡检查均通过，并把同一时间点交回用户复玩。

