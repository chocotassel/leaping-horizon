# 音乐到完整关卡

项目只保留一条生产管线：输入一首音乐，输出游戏使用的压缩 MP3 和完整 Level v3 数据。当前空间布局算法为 `music-responsive-choice-template-v6`。

## 首次安装

```powershell
npm run setup:rhythm
```

需要 Python 3.11。安装脚本会建立 `.venv-analysis` 并安装 Beat This!、librosa、Basic Pitch、scikit-learn 与音频编解码依赖。

## 生成关卡

```powershell
npm run generate -- "D:\Music\song.wav" "Song title" "Artist" song-id
```

标题、作者和 ID 都可从右向左省略。标题默认使用输入文件名，作者默认是 `Unknown Artist`。

每首歌按歌曲 ID 独立输出：

- `public/audio/<song-id>.mp3`：VBR MPEG Layer III 游戏音频。
- `src/levels/<song-id>.level.json`：游戏直接读取的完整关卡。
- `work/<song-id>.rhythm-analysis.json`：构建中间数据，已忽略，不进入版本库。

再次使用相同 ID 会更新该歌曲；不同 ID 会保留为不同歌曲。首页自动发现全部 `*.level.json` 并显示歌曲选择，无需维护额外清单。

压缩后的 MP3 同时也是分析输入，因此关卡时间戳和游戏实际解码的音频使用同一时间轴。

## 管线组成

1. libsndfile 将源音频有损压缩成 VBR MP3。
2. Beat This! 检测 beat/downbeat，提供真实拍点、小节与乐句时间轴。
3. librosa 检测多频段起音、能量和歌曲结构；段落尺度按歌曲长度动态选择，不使用某首歌固定的段数。
4. Basic Pitch 补充旋律音符起点，并保留 MIDI 音高、音域、音长与同时发音数；和弦聚合仍选用真实检测时刻。
5. 结构分析只在当前歌曲内部把重复乐句归为同一家族；不存在按绝对秒数写死的跨歌曲复用。
6. `scripts/rhythm/layout-intent.mjs` 把分析数据转换成一份稳定的布局意图：连续的旋律/打击/节奏权重、intro/build/drive/peak/break/release/outro 段落角色、段落压力，以及重复乐句的音高走势共识。
7. 上行、下行、摆动和平稳旋律分别偏向不同的形态与左右方向；缺少可用音高时只使用音频指纹做确定性回退，不读取歌名、歌曲 ID 或固定时间表。
8. C/S/V、阶梯、钩形、钟摆等形态会跨 1–3 小节保持连续入口与出口；M 手势严格输出 `00222 → 00001 → 22200 → 00001 → 00222 → 00001` 或镜像。六个可见事件全部使用真实检测时刻；横移时间不足时跳过中间弱时隙，而不是缩回中道。长曲至少安排一个原向 M 和一个镜像 M。
9. 一个 Choice Row 可以有 1–3 个可撞击方块；玩家吃到其中任意一个就完成这一行，分数、命中与 Combo 都只增加一次。多排 Choice Row 可以连续出现，生成器不公开推荐路线。
10. peak 与高压力 build/drive 段会加入全宽鼓点横扫：三个强制边缘击打点按 `0 → 4 → 0` 或镜像排列，中间用连续双安全道 Gate 引导移动。规划器同时检查同一家族全部 occurrence 的真实时间，绝不移动音乐事件。
11. 相同乐句只生成一次 canonical 模板，连旋律细分行与全宽横扫也必须跨 occurrence 达成共识；只出现一次的独有乐句才允许 overlay，因此重复旋律的实际可见事件、手势与分支结构完全一致。
12. 全曲使用共享的前向/后向路线图同时检查生存与完整 Combo：每个显示出来的可选方块都必须属于至少一条完整路线，并检查连续分支、宽分支、决策路径数量、五道覆盖、压力与地刺强度、重复乐句一致性和跨歌曲布局差异。强段还会拒绝任何始终躲在 1–3 道微操的完整 Combo 路线。

所有障碍时刻都来自检测器的真实音频峰值；BPM 只用于视觉，不建立固定网格，也不吸附事件时间。

## 验证

```powershell
npm run test:level
npm run test:physics
npm run build
```

`test:level` 会先运行布局意图、M/横扫识别与路线图的纯函数测试，再检查 MP3 压缩信息、事件顺序、Choice Row 的按行 Combo 统计、无孤立中缝、字面六行 M、强段 `0↔4↔0` 横扫、多分支完整 Combo 路线、音高方向、段落心流、结构模板复用、边道覆盖、中心道偏置、跨歌曲布局差异和统计一致性。`test:physics` 还会验证多目标行的原子判定、连续命中、整行漏击、地刺优先和 Gate Row Combo。
