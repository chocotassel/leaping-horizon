# 音乐到完整关卡

项目只保留一条生产管线：输入一首音乐，输出游戏使用的压缩 MP3 和完整 Level v3 数据。当前空间布局算法为 `music-responsive-template-v5`。

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
8. C/S/M/V、阶梯、钩形、钟摆等形态会跨 1–3 小节保持连续入口与出口，只在乐句边界回到中路；相同乐句只生成一次 canonical 核心模板，高潮的单次变化只能增加明确标记的 overlay。
9. 全曲通过生存路线、完整连击路线、五道覆盖、中心道偏置、压力与地刺强度关系、重复乐句一致性和跨歌曲布局差异检查。

所有障碍时刻都来自检测器的真实音频峰值；BPM 只用于视觉，不建立固定网格，也不吸附事件时间。

## 验证

```powershell
npm run test:level
npm run test:physics
npm run build
```

`test:level` 会先运行布局意图的纯函数测试，再检查 MP3 压缩信息、事件顺序、五道数据、无孤立中缝、路线可达性、音高方向、段落心流、结构模板复用、边道覆盖、中心道偏置、跨歌曲布局差异和统计一致性。
