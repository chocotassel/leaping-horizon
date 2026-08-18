# 音乐关卡生成：乐理 / MIR 自动分析能力矩阵

调研日期：2026-08-18

## 结论先行

对当前项目使用的“完整立体声成品歌曲”而言，**BPM 也不是算法一定能找准的事实**。MIREX 的官方任务说明明确指出：熟练音乐人可能在不同拍层上打拍，感知速度也可能与记谱速度不同；官方评测因此允许两个候选速度，并以 ±8% 为正确窗口。[MIREX Audio Tempo Estimation](https://music-ir.org/mirex/wiki/2021%3AAudio_Tempo_Estimation)

更重要的是，Beat This 解决的是 **beat（人会跟着打拍的位置）和 downbeat（每小节第一拍）**，不是“所有鼓点、琴音、人声发音”，也不是“情绪上的强转折”。论文作者明确承认模型仍会在困难或训练中代表不足的曲风上失败，而且连续正确性指标更差。[Beat This 论文](https://arxiv.org/abs/2407.21658) Beat This 的输出置信度表示模型对 beat/downbeat 的把握，不能解释为音乐冲击力或情绪强度。

所以，工业上可行的目标不是寻找一个全自动“懂歌”的算法，而是把信息分成三层：

1. **可测量事实**：响度、音频时间、在清晰单声部里的基频等，可直接计算。
2. **机器候选**：节拍、起音、音符、段落、重复乐句等，由算法批量产生并给出置信度，但允许快速接受、修正或舍弃。
3. **创作决策**：这段应该让玩家演奏谁、哪里是情绪转折、哪里应该变色、高潮应使用什么玩法，由人按段落定稿，而不是逐拍标注。

## 本报告的“工业可行”判定标准

以下结论默认输入是商业发行级的完整混音，而不是原始 MIDI 或干净分轨。

| 结论 | 判定标准 | 在产品中的用法 |
|---|---|---|
| **能找准** | 对定义明确的测量量，成熟实现可重复得到同一结果；不需要理解创作意图。这里不表示对任意损坏音频都数学上 100% 正确。 | 可直接进入数据层，只做异常值检查。 |
| **条件可用** | 在明确曲风、音源或置信度条件下足够有用，但公开基准仍有明显错误，或概念本身存在多种合理答案。 | 生成候选；低置信度拒绝；让人按片段快速确认。 |
| **不能自动定稿** | 真实商业混音上的误差仍大，或“正确答案”依赖听者、文化和设计意图。 | AI 只能排序、解释和提供建议，最终决定必须由人做。 |

一个模型在某个测试集拿到高平均分，不足以判为“能找准”。例如 beat 的常用 F-measure 允许预测与标注相差 **70 ms**；这对研究评测算正确，但对需要听感紧密的音游仍可能感觉偏。[mir_eval beat 规范](https://mir-eval.readthedocs.io/latest/api/beat.html) 音符转录的常用正确标准也允许 onset 相差 50 ms、音高相差四分之一音，并对 offset 给出 20% 或至少 50 ms 的宽容区间。[mir_eval transcription 规范](https://mir-eval.readthedocs.io/latest/api/transcription.html)

## 能力矩阵

| 音乐 / MIR 概念 | 通俗含义 | 自动化结论 | 工业边界，以及对音游关卡真正有用的输出 |
|---|---|---|---|
| **Tempo / BPM** | Tempo 是整体速度；BPM 是每分钟多少个被选定层级的拍。120 BPM 即该层级平均每 0.5 秒一拍。 | **条件可用** | 固定速度、4/4、鼓点清晰的流行/电子乐通常可用；半速/倍速歧义、摇摆、变速、rubato、弱拍音乐不能无条件相信。MIREX 明确记录听者会选择不同拍层，并要求算法返回两个速度候选。[MIREX tempo 定义与评测](https://music-ir.org/mirex/wiki/2021%3AAudio_Tempo_Estimation) 用于初始网格可以，发布前至少需要一次全曲节拍漂移检查。 |
| **Beat（拍）** | 听者会跟着点头、踏脚的周期性脉搏位置；它不是音频里发生的每个声音事件。 | **条件可用** | Beat This 已是高水平通用模型，但论文仍报告困难和代表不足曲风会失败；标准 beat 评测又允许 70 ms 误差并处理拍层歧义。[Beat This](https://arxiv.org/abs/2407.21658) [mir_eval beat](https://mir-eval.readthedocs.io/latest/api/beat.html) 适合提供拍网格和吸附线，不应直接等同全部可撞方块。 |
| **Downbeat（小节第一拍）** | 一小节的第一拍，决定小节边界；常被口头称作“一拍”。 | **条件可用** | Downbeat 是度量结构，不保证是这一小节听起来最响、最重或最有情绪冲击的声音。Beat This 对它的正式定义就是“每小节开始”。[Beat This](https://arxiv.org/abs/2407.21658) 适合安排小节级变化和强调候选，但不能单独决定爆点、变色或大型障碍。 |
| **Meter / Time signature（拍号、节拍组织）** | 把拍组织成小节，例如 4/4 常见为每小节四拍；也可能是 3/4、6/8、奇数拍或中途换拍。 | **条件可用** | 一些追踪器要求从有限拍号列表中选择，遇到变拍和未支持拍号会结构性失败；Beat This 正是为减少此类约束而设计，但仍非无误。[Beat This 对 DBN 限制的说明](https://arxiv.org/abs/2407.21658) 适合生成 1/2/4 小节的编辑块，但要允许人一键改拍号或重新对齐。 |
| **Onset / Attack（起音、声音开始）** | 某个声音事件开始或能量突然建立的时刻，例如鼓槌击中、琴键发声、辅音进入。它与 beat 是两条不同时间线。 | **条件可用** | 标准 onset 评测通常把落在 ±50 ms 内视为正确，说明“研究上正确”不等于采样级精确。[mir_eval onset](https://mir-eval.readthedocs.io/latest/api/onset.html) 清晰瞬态容易；legato、人声元音、混响、压缩和多个同时发声较难。适合批量提供真实演奏事件候选，再按显著度和密度筛选。 |
| **Accent / Salience（重音、显著度）** | 某个事件因响度、音色、音高、时值、切分或上下文而更突出；不等同于 downbeat。 | **条件可用** | 能量、频谱变化、模型激活值都能测，但“这里是否值得玩家击打”仍取决于上下文。Harmonix 的数据论文把 beat、downbeat 与功能段落分开标注，并说明灯光可跟 beat、颜色可跟段落边界，显示这些控制层不可互换。[Harmonix Set](https://archives.ismir.net/ismir2019/paper/000068.pdf) 应输出若干可解释分量，而不是一个伪精确的 `strength`。 |
| **鼓点与分鼓件转录** | 找出底鼓、军鼓、踩镲等每次击打的类别和时间。 | **条件可用** | 在限定三类鼓件的公开实验中，平均 F-measure 约 0.83，且仍以 50 ms 窗口判正确；真实多乐器混音明显不是零错误。[Southall 等，ISMIR 2016](https://archives.ismir.net/ismir2016/paper/000217.pdf) 对常见鼓组和高置信击打可直接形成候选谱；密集镲片、叠加鼓和特殊打击乐需要抽听。 |
| **乐器分轨 / Source separation** | 从总混音估计 vocals、drums、bass、other 等音轨，以便分别分析。 | **条件可用** | Demucs 官方模型在 MUSDB HQ 报告约 9 dB SDR，但官方也明确说明实验性 piano stem 有大量串音和伪影；它只能估计分轨，不能还原母带真值。[Demucs 官方实现](https://github.com/facebookresearch/demucs) 可作为后续 onset/F0 的预处理，并保留原混音交叉验证；不能把分轨伪影直接当成音符。 |
| **F0 / Fundamental frequency（基频）** | 周期声源的基础振动频率，是感知音高的主要物理依据；例如 A4 约为 440 Hz。 | **能找准（仅清晰单声部）／完整混音为条件可用** | CREPE 的正式定位就是 **monophonic pitch tracker**；它不是全混音多乐器音高识别器。[CREPE 官方实现](https://github.com/marl/crepe) 单独人声、长笛、独奏线可稳定得到连续 F0；总混音必须先分轨，并用置信度屏蔽无声、噪声及串音。 |
| **Melody contour（旋律轮廓）** | 主旋律音高随时间上升、下降、保持和跳跃的形状；不要求每个音名都完全正确。 | **条件可用，且很适合五轨映射** | MIREX 把任务定义为从复调音频识别旋律音高轮廓，并分别评估音高、八度和有声/无声判断，说明这些错误来源彼此独立。[MIREX Audio Melody Extraction](https://music-ir.org/mirex/wiki/Audio_Melody_Extraction) 对五轨游戏只保留局部相对高低、做平滑和迟滞，比把每个 MIDI 音直接映射轨道更稳。 |
| **Note transcription（音符转录）** | 把音频转成带 onset、offset、pitch，可能还带 velocity 和乐器标签的 MIDI 式音符。 | **条件可用；完整多乐器成品不能自动定稿** | Spotify Basic Pitch 官方明确说支持复音乐器，但“对一次一个乐器效果最好”。[Basic Pitch 官方 README](https://github.com/spotify/basic-pitch) MT3 论文也将多乐器同时转录称为挑战，并指出数据稀缺和评测不一致。[MT3，ICLR 2022](https://research.google/pubs/mt3-multi-task-multitrack-music-transcription/) 适合从单独 stem 生成候选，不适合把全混音转出的所有音符直接变成关卡。 |
| **Chord（和弦）** | 同一时间共同构成和声的音集合，例如 C 大三和弦；可包含根音、大小性质、七音、转位等不同精度。 | **条件可用** | MIREX 2020 在流行数据上的根音正确覆盖约 55%–74%，大/小和弦更低，带七音与低音转位通常约 35%–59%；离自动真值仍远。[MIREX 2020 Audio Chord Estimation Results](https://music-ir.org/mirex/wiki/2020%3AAudio_Chord_Estimation_Results) 可用于长期色彩或和声张力候选，不适合作为毫秒级碰撞点。 |
| **Key / Mode（调性、调式）** | Key 是全曲或一段围绕哪个主音和音阶组织；mode 在常见简化中指 major/minor，但现实还有转调、调式混合与无调性。 | **条件可用** | MIREX 2020 不同数据集的“完全正确”比例从约 18% 到 74%，跨曲风差异很大；评分还会给属调、关系大小调等“近错”部分分。[MIREX 2020 Audio Key Detection Results](https://music-ir.org/mirex/wiki/2020%3AAudio_Key_Detection_Results) 可作为配色与生成参数的弱提示，必须展示置信度和第二候选。 |
| **Loudness / Energy（响度、能量）** | Energy/RMS 是信号幅度；LUFS 是按规定模型估计节目感知响度。二者描述“声音有多强”，不等于情绪。 | **能找准（按指定测量标准）** | ITU-R BS.1770-5 给出节目响度和 true-peak 的确定算法；EBU Mode 进一步规定 Momentary 400 ms、Short-term 3 s、Integrated 全程窗口。[ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en) [EBU Loudness](https://tech.ebu.ch/loudness) 这是可以直接信任的信号层数据，适合找 swell、drop 和局部密度变化候选，但不能单独称为高潮。 |
| **Dynamics / Crescendo（力度与渐强渐弱）** | 音乐在一段时间内变强、变弱或保持；乐谱里的 `p/f` 还包含演奏意图。 | **条件可用** | 由短时 LUFS、RMS 和频谱包络可稳定测“混音输出变响/变弱”，但母带压缩可能掩盖演奏力度，新增乐器也会让总响度上升。ITU/EBU 标准只定义响度测量，没有宣称它等于音乐情绪或演奏力度。[ITU-R BS.1770-5](https://www.itu.int/rec/R-REC-BS.1770-5-202311-I/en) 适合生成“渐强候选区间”，让人确认其游戏意义。 |
| **Section / Form（段落、曲式）** | 把歌曲分成 intro、verse、chorus、bridge、solo、outro 等较长功能区域。 | **条件可用，不能自动发布** | Harmonix 为节奏游戏专门制作的 912 首标注集仍由专业音乐人手工建立 tempo track、beat、downbeat 和 section，并逐曲复核；论文把自动分析定位为加速手工创作或在部分场景自动化。[Harmonix Set](https://archives.ismir.net/ismir2019/paper/000068.pdf) SALAMI 也需要多层级和多标注者来表达结构。[SALAMI 原始数据论文](https://ismir2011.ismir.net/papers/PS4-14.pdf) 算法可一次给出 8–20 个边界候选，用户按整段确认即可。 |
| **Phrase（乐句）** | 比 verse/chorus 更短、在听感或演奏呼吸上形成完整意思的一段，常为 1–4 小节但并无硬性长度。 | **不能自动定稿** | SALAMI 的原始标注设计同时包含细粒度与粗粒度层级，并报告需要多个音乐专家；“哪个层级算一句”本身就是分析选择。[SALAMI 原始数据论文](https://ismir2011.ismir.net/papers/PS4-14.pdf) 可由小节、停顿、旋律收束和重复性提候选，但用户应选择真正用于玩法的乐句块。 |
| **Repetition / Motif（重复、动机）** | 旋律、节奏、和声或歌词再次出现；可能音频几乎相同，也可能换调、换乐器或改变编曲。 | **条件可用** | MIREX 为重复主题/段落单设 discovery、occurrence、coverage 等不同指标，说明“找到重复”不是单一二元问题。[MIREX Repeated Themes & Sections Results](https://www.music-ir.org/mirex/wiki/2017%3ADiscovery_of_Repeated_Themes_%26_Sections_Results) 近乎相同的音频重复容易聚类；换调或换编曲需结合节奏、旋律和歌词多视图。对音游最适合让用户一次确认“这些片段用同一动作语法”。 |
| **Timbre / Instrument presence（音色、乐器存在）** | Timbre 是同音高同响度下仍能区分人声、钢琴、吉他等的声音特征；instrument presence 是某段是否出现某类乐器。 | **条件可用（粗粒度）** | OpenMIC-2018 把真实复调音乐里的乐器识别称为困难任务；基线宏平均 F1 约 0.514，并指出单乐器数据训练的模型往往不能泛化到合奏。[OpenMIC-2018 原始论文](https://ismir2018.ircam.fr/doc/pdfs/248_Paper.pdf) 可以按 5–10 秒判断“主唱/鼓/吉他可能进入”，不能可靠决定每个 onset 属于哪件乐器。 |
| **Vocal activity（人声活动）** | 判断某个时间段是否有人唱，不要求知道唱了什么或具体音高。 | **条件可用** | 分轨和专门的人声活动检测能提供较好的片段候选，但 DALI 的构建研究指出小的人声检测变化会造成不同歌词对齐，且仍存在 false positives 和局部对齐问题。[DALI 数据论文](https://transactions.ismir.net/articles/10.5334/tismir.30) 适合切换“以人声为主”的生成模式，不能直接代表每次发音。 |
| **Lyrics / Word / Syllable / Phoneme（歌词、词、音节、音素）** | Lyrics 是唱出的文本；word/音节/音素时间表示每个发音单位何时开始与结束。 | **歌词未知时不能自动定稿；歌词已知时对齐条件可用** | MIREX 以 WER 衡量歌词转录，并把纯人声与带伴奏混音分开评测。[MIREX Automatic Lyrics Transcription](https://music-ir.org/mirex/wiki/2021%3AAutomatic_Lyrics_Transcription) 2022 的端到端研究在 DALI/Jamendo 上仍报告约 64%–77% WER，而正确音高/onset 的 oracle 会改善结果。[End-to-End Lyrics Transcription](https://archives.ismir.net/ismir2022/paper/000076.pdf) 若能从版权方取得歌词，应做强制对齐并让用户按句确认；不要期望模型从混音准确恢复每个发音。 |
| **Emotion / Valence / Arousal（情绪、愉悦度、激活度）** | Valence 粗略表示正面/负面，arousal 表示平静/激烈；它们是听者评分维度，不是音频里的客观标签。 | **不能自动定稿** | GlobalMood 由 59 国歌曲、五个文化地区的大规模人类标注构成，发现不同文化对翻译相同的情绪词仍有显著理解差异。[GlobalMood，ISMIR 2025](https://arxiv.org/abs/2505.09539) AI 可给“更激烈/更平静”等排序候选，尤其 arousal 常与响度和密度相关；它不能决定哪一秒对你的游戏应当“变色”。 |
| **Tension / Release / Climax（张力、释放、高潮）** | Tension 是听者感到未解决、期待或压力的程度；release 是缓解；climax 是设计上最重要的峰值，可能来自音高、和声、节奏、音色、歌词或结构共同作用。 | **不能自动定稿** | TenseMusic 的人类平均张力评分一致性约 0.80，但自动模型与平均人类评分的相关仅约 0.59–0.61，说明即使专门建模也远非真值。[TenseMusic 原始研究](https://pmc.ncbi.nlm.nih.gov/articles/PMC10798497/) **本报告据此推论**：响度峰、段落边界、高音和密度只能组成“高潮候选”，最终高潮及玩法表达应由开发者按段落选择。 |

## 对当前项目最重要的纠偏

### 1. “节拍点”不能替代“演奏事件”

一首 120 BPM 的歌曲每拍间隔约 500 ms，但期间可能出现多个十六分音符、鼓花、人声辅音，或整拍没有显著 attack。若只在 beat 上放块，得到的是跟拍游戏；若将所有 onset 都放块，又会得到噪声密集的躲避游戏。正确的机器中间层应同时保存：

- beat/downbeat 网格；
- 各 stem 的 onset/note 候选；
- onset 的来源、置信度、响度和音高；
- 哪些候选构成重复模式。

然后由“当前片段演奏谁”这一人类决策选择事件流。

### 2. “强拍”至少应拆成四个不同概念

- `downbeat`：小节第一拍；
- `attack strength`：这次声音开始得有多明显；
- `acoustic energy`：这一刻混音有多响；
- `design importance`：这里在这首歌和本关中有多重要。

前三项可自动测量或估计，最后一项不能。把它们压成单一 `strength`，会导致普通旋律中间随机变色、真正转折反而无表现。

### 3. 最省人工的介入粒度不是“每拍”，而是“乐句 / 段落合同”

Harmonix 的原始研究与本项目问题高度一致：其数据正是为了加速节奏动作游戏 beatmap、灯光和颜色创作，但最终仍由专业音乐人建立并复核 beat/downbeat/section。[Harmonix Set](https://archives.ismir.net/ismir2019/paper/000068.pdf) 对个人开发者，现实可行的交互应是每首歌做大约 10–30 次高层选择，而不是校对上千个方块：

1. 确认节拍网格是否半速/倍速或发生漂移；
2. 在每个 section/phrase 选择主导声部：鼓、人声、主旋律、低音或留白；
3. 对重复乐句绑定同一个玩法模式，并可一次应用到所有重复处；
4. 从算法给出的 3–8 个转折/高潮候选中选择；
5. 最后只试听低置信度和高密度片段。

## 建议的自动化权限边界

| 数据 | 默认权限 |
|---|---|
| LUFS/RMS、音频时间轴 | 自动写入 |
| 干净单声部的高置信 F0 | 自动写入，低置信帧丢弃 |
| BPM、beat、downbeat、onset、分鼓件、旋律轮廓 | 自动生成候选；需全曲快速试听或置信度拒绝机制 |
| note、chord、key、instrument、section、repetition | 用作批量编排建议，不作为不可覆盖的真值 |
| phrase、歌词语义、情绪、张力、高潮、颜色变化、玩法重点 | 人类定稿；AI 负责给候选、解释依据和批量应用 |

这套边界的核心不是削弱算法，而是让算法负责它真正擅长的“测量、搜索和重复劳动”，让个人开发者只介入少量会改变关卡灵魂的决策。
