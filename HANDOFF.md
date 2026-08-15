# 节奏生成改造：当前阶段交接

更新日期：2026-08-15

## 当前结论

这一阶段已经完成，可以在另一台电脑继续。游戏不再从 BPM 建立等间隔网格；Level v3 的每个障碍都直接保存独立的 `timeSeconds`。BPM 只保留为歌曲信息和视觉效果参数。

当前推荐方案是“成熟检测器候选 + 人工偏好选择”：

1. librosa 从混音、打击/谐波声部和五个频带检测真实起音；
2. Spotify Basic Pitch ONNX 检测旋律音符起点；
3. Beat This! 检测 beat/downbeat，只作为上下文和独立试听基准；
4. L2 正则 Logistic Regression 根据本次 155 个手标点选择候选；
5. 最终事件时间始终取检测器原始峰值，模型只能选择或丢弃，不能移动、补齐或吸附到网格。

手标原始数据保存在 `data/annotations/slice-at-two.human-beats.json`，疑似误触只标记、不删除。旧版 96 个网格事件固定保存在 `data/baselines/slice-at-two.legacy-times.json`，只作为对照，已不参与生成。

## 已完成

- Level v3 任意时间事件格式；游戏控制、渲染、判定和对象池均已适配。
- 真实运行 librosa 0.11.0、Basic Pitch 0.4.0（ONNX）、Beat This! 1.1.0。
- 训练和输出均使用单调一对一标注匹配；120 ms NMS 只删除过近候选，不移动时间。
- 生成 6 套可比较关卡：人工参考、旧网格、librosa、Basic Pitch、Beat This!、偏好融合。
- 新增节奏算法试听室：`/rhythm-lab.html`，可边播放边听障碍提示音、看人工参考和五轨预览，并直接进入对应方案试玩。
- 游戏首页支持 `/?algorithm=<id>`，可载入不同生成结果。
- 保留并接入手打标注页面：`/beat-marker.html`。
- 移除旧的 `@audio/beat` 网格生成依赖和旧配置；`npm run generate:level` 已改为新流程。
- 已通过生产构建、TypeScript、六套关卡验证和物理测试。

## 当前输出

| 方案 | 原始事件数 | 与手标 F1（±120 ms） | 用途 |
| --- | ---: | ---: | --- |
| 旧网格 | 96 | 0.207 | 仅对照 |
| librosa | 179 | 0.210 | 广义真实起音 |
| Basic Pitch | 179 | 0.228 | 旋律起音 |
| Beat This! | 318 | 0.309 | 稠密拍点基准 |
| 偏好融合 | 155 | 0.290 | 当前默认 |

这些数字只比较一遍带误差的人工点击，不能代替听感。偏好融合的 155 个事件与标注密度接近，中位间隔约 0.872 秒。

## 在另一台 Windows 电脑恢复

仓库不提交 `.venv-analysis/`、`.cache/` 和模型权重。拉取代码后依次运行：

```powershell
npm install
npm run setup:rhythm
npm run analyze:rhythm
npm run dev
```

要求：Node.js、npm、Python 3.11 或 3.12、ffmpeg 可用。若 `python` 命令不是目标解释器：

```powershell
powershell -ExecutionPolicy Bypass -File scripts/setup-rhythm-env.ps1 -PythonCommand py
```

如果虚拟环境放在其他位置，设置环境变量 `RHYTHM_PYTHON` 指向其 Python。第一次运行会下载 Beat This! 官方 checkpoint 到 `.cache/`。

打开：

- 游戏：`http://localhost:5173/`
- 算法试听室：`http://localhost:5173/rhythm-lab.html`
- 人工标注器：`http://localhost:5173/beat-marker.html`

验收命令：

```powershell
npm run build
npm run test:level
npm run test:physics
```

## 下一阶段优先级

1. 在试听室重点听 20–40 秒、80–100 秒、125–145 秒三个区段，记录偏好融合的“多打/漏打”具体时刻。
2. 同一首歌再手打 2 遍。用多遍一致性区分手误、反应延迟和真正偏好；不要根据固定间隔纠正标签。
3. 根据听感决定候选侧升级：若偏旋律，加入 Spleeter/Demucs 分轨后再跑 Basic Pitch；若偏鼓组，细分鼓声部 onset；Beat This! 继续只作弱特征，不作网格。
4. 将对比页增加“这个点应该有/不应该有”的反馈按钮，把反馈保存成第二轮训练数据。
5. 有 3–5 首不同风格标注后再做跨歌曲验证；当前单歌 155 点不适合微调大型谱面模型。
6. 发布商业版本前复核模型权重和训练数据许可；代码许可宽松不等于训练数据许可已自动解决。

## 已知但不阻塞的问题

- Basic Pitch 启动时会提示未安装 TensorFlow/CoreML/TFLite；当前明确使用 ONNX，这些提示可忽略。
- Vite 构建会提示 Three.js chunk 超过 500 kB；不影响当前功能，后续可按页面懒加载优化。
- 当前偏好模型只学习“何时放一个事件”；障碍列、危险块和连续动作仍是确定性可玩性布局，不是谱师模型。

算法设计和时间保证的更详细说明见 `RHYTHM_PIPELINE.md`。
