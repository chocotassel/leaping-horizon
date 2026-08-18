# 音乐关卡生成与人工编辑

## 生成基础关卡

首次安装分析环境：

```sh
npm run setup:rhythm
```

生成或更新歌曲：

```sh
npm run generate -- "path/to/song.wav" "Song title" "Artist" song-id
```

分析器输出真实 attack、beat 和 MIDI 音高。`transcribePerformance(...)` 把音高映射到五条轨道；Builder 只保存两类紧凑数据：

- `rhythmPoints`：所有可人工编辑的 attack/beat 时间点。
- `events`：依据音高预生成的基础方块行。

Builder 不再生成 Song Director、LLM 语义颜色、Hit Voice 或大体积解释数据。

## 人工编辑

```sh
npm run editor
```

打开 `http://localhost:5173/editor.html`。工作台可以：

- 播放和拖动四首歌曲。
- 在每个 Rhythm Point 的五条轨道上放置空白、方块或地刺。
- 选择两个 Rhythm Point，建立不重叠的颜色区间。
- 保存到 `src/songs/<song-id>/edits.json`，或导入/导出 JSON。

`edits.json` 是稀疏覆盖，不会因重新生成 `level.json` 而丢失。游戏加载时通过 `applyLevelEdits(...)` 合成最终关卡。

## 验证

```sh
npm run test:level
npm run test:physics
npm run test:audio
npm run build
```
