import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { SCENE_COLOR_SCHEMES, type SceneColorSchemeId } from '../game/colorSchemes';
import {
  applyLevelEdits,
  emptyLevelEdits,
  parseLevelEdits,
  rhythmPointKey,
  type LevelEdits,
  type RegionRecipe,
} from '../levelEdits';
import { compilePerformance } from '../regionArrangement';
import {
  ObstacleType,
  type AuthoringEvidenceStream,
  type Level,
  type ObstacleRow,
  type RegionFeel,
  type RegionLaneDriver,
  type RhythmPoint,
} from '../types';
import {
  buildRegionReviewQueue,
  deleteRegionRecipe,
  draftForRegion,
  draftFromRecipe,
  getRegionStreamSummary,
  isEvidenceSelectable,
  materializePerformancePreset,
  materializeRecipe,
  prepareEditorEdits,
  recipesFromSuggestions,
  repeatSelectionForRegion,
  setLaneDriver,
  setTimingLayerSelection,
  upsertLinkedRegionRecipe,
  upsertRegionRecipe,
  type AuthoringScore,
  type PerformancePresetId,
  type RegionRecipeDraft,
} from './arrangementDraft';
import { getBeatAuditionRange } from './beatAudition';
import {
  EDITOR_LEVELS,
  getEditorAuthoringScore,
  getEditorLevel,
  getEditorLevelEdits,
} from './editorData';

const EMPTY_ROW: ObstacleRow = [0, 0, 0, 0, 0];
const COLOR_IDS = Object.keys(SCENE_COLOR_SCHEMES) as SceneColorSchemeId[];
const PRESET_OPTIONS: Array<{ id: PerformancePresetId; label: string; hint: string }> = [
  { id: 'vocal-lead', label: '人声领奏', hint: '人声发音落方块，音高带轨道' },
  { id: 'drum-groove', label: '鼓点律动', hint: '跟随鼓点左右演奏' },
  { id: 'bass-drive', label: '低音推进', hint: '贝斯起音形成推进感' },
  { id: 'ensemble', label: '全员合奏', hint: '多个声部共享演奏预算' },
  { id: 'long-note', label: '长音轨迹', hint: '连续音高塑造五轨曲线' },
  { id: 'rest', label: '留白', hint: '这一段不放置演奏方块' },
];
const FEEL_LABELS: Record<RegionFeel, string> = {
  steady: '稳',
  natural: '原味',
  showcase: '强烈',
};
const STEM_LABELS: Record<string, string> = {
  vocals: '人声',
  drums: '鼓',
  bass: '贝斯',
  other: '其他伴奏',
  mix: '全曲综合',
  metric: '节拍网格',
};
const REASON_LABELS: Record<string, string> = {
  'continuous-pitch-evidence': '连续音高变化明显',
  'discrete-pitch-evidence': '旋律音符足够清晰',
  'dense-percussive-evidence': '打击点密集',
  'sparse-percussive-evidence': '打击点稀疏',
  'performance-attack-density': '综合击打较密集',
  'metric-grid-only': '仅依据节拍网格',
  'single-performance-attack': '只有少量可用击打',
  'no-event-evidence': '本段没有可信事件',
  'separated-stem-coverage': '分轨声部在本段覆盖较完整',
};

function cloneEdits(edits: LevelEdits): LevelEdits {
  return JSON.parse(JSON.stringify(edits)) as LevelEdits;
}

function audioSource(value: string): string {
  return /^(data:|https?:|blob:)/.test(value) || value.toLowerCase().endsWith('.mp3')
    ? value
    : `data:audio/mpeg;base64,${value}`;
}

function formatTime(timeSeconds: number): string {
  const minutes = Math.floor(timeSeconds / 60);
  const seconds = timeSeconds - minutes * 60;
  return `${minutes}:${seconds.toFixed(2).padStart(5, '0')}`;
}

function nearestPointIndex(points: readonly RhythmPoint[], timeSeconds: number): number {
  let low = 0;
  let high = points.length - 1;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (points[middle].timeSeconds < timeSeconds) low = middle + 1;
    else high = middle;
  }
  if (low > 0 && Math.abs(points[low - 1].timeSeconds - timeSeconds) <= Math.abs(points[low].timeSeconds - timeSeconds)) {
    return low - 1;
  }
  return low;
}

function colorHex(value: number): string {
  return `#${value.toString(16).padStart(6, '0')}`;
}

function rowKind(row: readonly number[]): string {
  if (row.includes(ObstacleType.Breakable)) return '方块';
  if (row.includes(ObstacleType.Spike)) return '地刺';
  return '空';
}

function friendlyPreviewError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/baseFingerprint|evidenceFingerprint/i.test(message)) return '这份编辑来自旧的音频或分轨分析，请重新采用当前分析建议。';
  if (/overlap/i.test(message)) return '两个段落配方覆盖了同一段时间，请删除其中一个或重新同步重复段。';
  if (/continuous F0|pitch evidence/i.test(message)) return '当前段落没有足够可用的连续音高，请换一个声部或演奏方式。';
  if (/too few measured source events/i.test(message)) return '某个重复段的实测声音点不足，可以降低密度或取消同步。';
  if (/unavailable evidence/i.test(message)) return '当前声部在这首歌中不可用，请选择其他声部。';
  if (/timing evidence|timingLayer/i.test(message)) return '这一段的演奏声部覆盖不足，请换一个预设或增加一起演奏的声部。';
  return message;
}

function recipeSummary(recipe: RegionRecipe): string {
  if (recipe.mode === 'rest') return '留白';
  const targets = recipe.timingLayers.filter((layer) => layer.role === 'target').length;
  return targets > 1 ? `${targets} 个声部合奏` : '单声部演奏';
}

function streamDisplayName(stream: AuthoringEvidenceStream): string {
  const role = STEM_LABELS[stream.stemRole] ?? stream.stemRole;
  if (stream.kind === 'lane') return `${role}音高`;
  if (stream.kind === 'accent') return `${role}强调`;
  return stream.id.endsWith(':pitch-landmarks') ? `${role}转音点` : `${role}发音 / 起音`;
}

function availabilityLabel(stream: AuthoringEvidenceStream): string {
  if (stream.availability === 'unavailable') return '不可用';
  return stream.availability === 'estimated' ? '算法估计' : '实测';
}

function laneDriverValue(driver: RegionLaneDriver): string {
  return driver.kind === 'source'
    ? `source:${driver.sourceId}`
    : `gesture:${driver.pattern}`;
}

function RecipeSlider({
  label,
  value,
  description,
  onChange,
}: {
  label: string;
  value: number;
  description: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="recipe-slider">
      <span><strong>{label}</strong><output>{Math.round(value * 100)}%</output></span>
      <input
        type="range"
        min={0}
        max={1}
        step={0.01}
        value={value}
        onChange={(event) => onChange(Number(event.target.value))}
      />
      <small>{description}</small>
    </label>
  );
}

function SongEditor({
  level,
  score,
  onDirtyChange,
}: {
  level: Level;
  score: AuthoringScore;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const auditionFrameRef = useRef<number | null>(null);
  const auditioningRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const firstRegionId = score.regions[0]?.id ?? '';
  const [edits, setEdits] = useState<LevelEdits>(() => prepareEditorEdits(
    cloneEdits(getEditorLevelEdits(level.id)),
    score,
  ));
  const [tool, setTool] = useState<ObstacleType>(ObstacleType.Breakable);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [selectedTime, setSelectedTime] = useState(level.rhythmPoints[0]?.timeSeconds ?? 0);
  const [selectedRegionId, setSelectedRegionId] = useState(firstRegionId);
  const [recipeDraft, setRecipeDraft] = useState<RegionRecipeDraft>(() => draftForRegion(
    score,
    prepareEditorEdits(cloneEdits(getEditorLevelEdits(level.id)), score),
    firstRegionId,
  ));
  const [syncRepeats, setSyncRepeats] = useState(() => Boolean(
    getEditorLevelEdits(level.id).arrangements
      .find((recipe) => recipe.regionId === firstRegionId)?.repeatSetId,
  ));
  const [rangeStart, setRangeStart] = useState<number | null>(null);
  const [rangeColor, setRangeColor] = useState<SceneColorSchemeId>('redWhite');
  const [dirty, setDirty] = useState(false);
  const [status, setStatus] = useState('未修改');

  useEffect(() => {
    if (!dirty) return undefined;
    const warn = (event: BeforeUnloadEvent) => event.preventDefault();
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  useEffect(() => () => {
    auditioningRef.current = false;
    if (auditionFrameRef.current != null) cancelAnimationFrame(auditionFrameRef.current);
    audioRef.current?.pause();
  }, []);

  const preview = useMemo(() => {
    try {
      const compiled = compilePerformance(level, score, edits);
      return { level: compiled.level, notices: compiled.notices, error: null as string | null };
    } catch (error) {
      return {
        level: null,
        notices: [],
        error: friendlyPreviewError(error),
      };
    }
  }, [edits, level, score]);
  const lastGoodPreviewRef = useRef<Level>(applyLevelEdits(level, {
    ...edits,
    arrangements: [],
  }));
  if (preview.level) lastGoodPreviewRef.current = preview.level;
  const editedLevel = preview.level ?? lastGoodPreviewRef.current;
  const previewRows = useMemo(() => new Map(
    editedLevel.events.map((event) => [rhythmPointKey(event.timeSeconds), event.obstacles]),
  ), [editedLevel]);
  const selectedIndex = nearestPointIndex(level.rhythmPoints, selectedTime);
  const selectedPoint = level.rhythmPoints[selectedIndex];
  const visiblePoints = level.rhythmPoints.slice(
    Math.max(0, selectedIndex - 14),
    Math.min(level.rhythmPoints.length, selectedIndex + 15),
  );

  const rowAt = (timeSeconds: number): ObstacleRow => (
    previewRows.get(rhythmPointKey(timeSeconds)) ?? EMPTY_ROW
  );
  const selectedRegion = score.regions.find((region) => region.id === selectedRegionId)
    ?? score.regions[0];
  const selectedRecipe = edits.arrangements.find((recipe) => recipe.regionId === selectedRegion?.id);
  const selectedSuggestion = score.suggestions.find((suggestion) => (
    suggestion.regionId === selectedRegion?.id
  ));
  const selectedSuggestedRecipe = selectedRegion
    ? recipesFromSuggestions(score).find((recipe) => recipe.regionId === selectedRegion.id)
    : null;
  const repeatSelection = selectedRegion
    ? repeatSelectionForRegion(score, selectedRegion.id)
    : null;
  const repeatSet = repeatSelection
    ? score.repeatSets.find((candidate) => candidate.id === repeatSelection.repeatSetId)
    : null;
  const fingerprintMismatch = Boolean(
    (edits.baseFingerprint && edits.baseFingerprint !== score.audioFingerprint)
    || (
      edits.evidenceFingerprint
      && edits.evidenceFingerprint !== score.evidenceFingerprint
    ),
  );
  const reviewQueue = useMemo(() => buildRegionReviewQueue(score), [score]);
  const reviewByRegion = useMemo(() => new Map(
    reviewQueue.map((item) => [item.regionId, item.reasons]),
  ), [reviewQueue]);
  const timingStreams = score.evidenceStreams.timing.filter((stream) => (
    !stream.id.endsWith(':pitch-landmarks')
  ));
  const accentStreams = score.evidenceStreams.accent;
  const laneStreams = score.evidenceStreams.lane;

  const stopAudition = (pauseAudio: boolean) => {
    auditioningRef.current = false;
    if (auditionFrameRef.current != null) cancelAnimationFrame(auditionFrameRef.current);
    auditionFrameRef.current = null;
    if (pauseAudio) audioRef.current?.pause();
  };

  const seek = (timeSeconds: number) => {
    if (auditioningRef.current) stopAudition(true);
    setSelectedTime(timeSeconds);
    setPlaybackTime(timeSeconds);
    if (audioRef.current) audioRef.current.currentTime = timeSeconds;
  };

  const auditionRange = async (startSeconds: number, endSeconds: number) => {
    const audio = audioRef.current;
    if (!audio) return;

    stopAudition(true);
    const start = Math.max(0, Math.min(level.song.durationSeconds, startSeconds));
    const end = Math.max(start, Math.min(level.song.durationSeconds, endSeconds));
    audio.currentTime = start;
    setPlaybackTime(start);
    auditioningRef.current = true;

    try {
      await audio.play();
    } catch {
      auditioningRef.current = false;
      return;
    }

    const watch = () => {
      if (!auditioningRef.current) return;
      if (audio.paused) {
        stopAudition(false);
        return;
      }
      if (audio.currentTime >= end) {
        stopAudition(true);
        audio.currentTime = end;
        setPlaybackTime(end);
        return;
      }
      auditionFrameRef.current = requestAnimationFrame(watch);
    };
    auditionFrameRef.current = requestAnimationFrame(watch);
  };

  const auditionBeat = async () => {
    const range = getBeatAuditionRange(
      selectedPoint.timeSeconds,
      level.song.bpm,
      level.song.durationSeconds,
    );
    await auditionRange(range.startSeconds, range.endSeconds);
  };

  useEffect(() => {
    const handleSpace = (event: KeyboardEvent) => {
      if (event.code !== 'Space' || event.repeat || !audioRef.current?.paused) return;
      const target = event.target;
      if (target instanceof HTMLElement) {
        if (target.matches('input, textarea, select, audio, [contenteditable="true"]')) return;
        const button = target.closest('button');
        if (button && !button.matches('.step-time, .cell')) return;
      }
      event.preventDefault();
      void auditionBeat();
    };
    window.addEventListener('keydown', handleSpace);
    return () => window.removeEventListener('keydown', handleSpace);
  });

  const updateEdits = (next: LevelEdits) => {
    try {
      setEdits(parseLevelEdits(prepareEditorEdits({
        ...next,
        version: 3,
        levelId: level.id,
      }, score), level));
      setDirty(true);
      onDirtyChange(true);
      setStatus('有未保存修改');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const selectRegion = (regionId: string) => {
    const region = score.regions.find((candidate) => candidate.id === regionId);
    if (!region) return;
    setSelectedRegionId(region.id);
    setRecipeDraft(draftForRegion(score, edits, region.id));
    setSyncRepeats(Boolean(
      edits.arrangements.find((recipe) => recipe.regionId === region.id)?.repeatSetId,
    ));
    seek(region.startSeconds);
  };

  const applyRecipe = () => {
    if (!selectedRegion) return;
    const link = syncRepeats ? repeatSelection : null;
    try {
      const recipe = materializeRecipe(selectedRegion.id, recipeDraft, link);
      updateEdits(link
        ? upsertLinkedRegionRecipe(edits, score, recipe)
        : upsertRegionRecipe(edits, recipe));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const deleteRecipe = () => {
    if (!selectedRegion) return;
    const next = deleteRegionRecipe(edits, selectedRegion.id);
    updateEdits(next);
    setRecipeDraft(draftForRegion(score, next, selectedRegion.id));
    setSyncRepeats(false);
  };

  const adoptSuggestions = () => {
    if (
      fingerprintMismatch
      && !window.confirm('这份编辑来自旧的音频分析。重新采用当前建议会替换旧的段落配方，是否继续？')
    ) return;
    const next: LevelEdits = {
      ...edits,
      baseFingerprint: score.audioFingerprint,
      evidenceFingerprint: score.evidenceFingerprint,
      arrangements: recipesFromSuggestions(score),
    };
    updateEdits(next);
    if (selectedRegion) setRecipeDraft(draftForRegion(score, next, selectedRegion.id));
    setSyncRepeats(false);
  };

  const choosePreset = (presetId: PerformancePresetId) => {
    if (!selectedRegion) return;
    try {
      setRecipeDraft(draftFromRecipe(
        materializePerformancePreset(score, selectedRegion.id, presetId),
      ));
      setStatus(`${PRESET_OPTIONS.find((preset) => preset.id === presetId)?.label ?? '预设'}已载入，应用后生效`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const toggleEvidenceLayer = (
    sourceId: string,
    role: 'target' | 'accent',
    selected: boolean,
  ) => {
    try {
      setRecipeDraft((current) => setTimingLayerSelection(score, current, {
        sourceId,
        role,
        selected,
      }));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const changeLaneDriver = (value: string) => {
    if (recipeDraft.mode !== 'play') return;
    try {
      const driver: RegionLaneDriver = value.startsWith('source:')
        ? {
            kind: 'source',
            sourceId: value.slice('source:'.length),
            motion: recipeDraft.laneDriver.motion,
          }
        : {
            kind: 'gesture',
            pattern: value === 'gesture:pulse' ? 'pulse' : 'alternating',
            motion: recipeDraft.laneDriver.motion,
          };
      setRecipeDraft(setLaneDriver(score, recipeDraft, driver));
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const updateLayerWeight = (sourceId: string, weight: number) => {
    if (recipeDraft.mode !== 'play') return;
    setRecipeDraft({
      ...recipeDraft,
      timingLayers: recipeDraft.timingLayers.map((layer) => (
        layer.sourceId === sourceId ? { ...layer, weight } : layer
      )),
    });
  };

  const paintCell = (point: RhythmPoint, lane: number) => {
    const obstacles = [...rowAt(point.timeSeconds)] as ObstacleRow;
    obstacles[lane] = tool;
    updateEdits({
      ...edits,
      rowOverrides: [
        ...edits.rowOverrides.filter((override) => (
          rhythmPointKey(override.timeSeconds) !== rhythmPointKey(point.timeSeconds)
        )),
        { timeSeconds: point.timeSeconds, obstacles },
      ],
    });
  };

  const addColorRange = (endSeconds: number) => {
    if (rangeStart == null) {
      setStatus('先选择区间起点。');
      return;
    }
    if (endSeconds <= rangeStart) {
      setStatus('区间终点必须晚于起点。');
      return;
    }
    const id = `range-${rhythmPointKey(rangeStart)}-${rhythmPointKey(endSeconds)}`;
    updateEdits({
      ...edits,
      colorRanges: [
        ...edits.colorRanges.filter((range) => range.id !== id),
        { id, startSeconds: rangeStart, endSeconds, colorSchemeId: rangeColor },
      ],
    });
    setRangeStart(null);
  };

  const save = async () => {
    try {
      const clean = parseLevelEdits(edits, level);
      const response = await fetch('/__level-editor/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(clean),
      });
      const result = await response.json() as { error?: string };
      if (!response.ok) throw new Error(result.error ?? '保存失败。');
      setEdits(clean);
      setDirty(false);
      onDirtyChange(false);
      setStatus('已保存到歌曲 edits.json');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
  };

  const exportEdits = () => {
    const blob = new Blob([`${JSON.stringify(edits, null, 2)}\n`], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `${level.id}.edits.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const importEdits = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) return;
    try {
      const parsed = parseLevelEdits(JSON.parse(await file.text()), level);
      const imported = parseLevelEdits(prepareEditorEdits(parsed, score), level);
      setEdits(imported);
      setDirty(true);
      onDirtyChange(true);
      setStatus(`已导入 ${file.name}，尚未保存`);
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    } finally {
      event.target.value = '';
    }
  };

  const activeColor = editedLevel.colorSchemeEvents.reduce((current, event) => (
    event.timeSeconds <= playbackTime ? event.colorSchemeId : current
  ), editedLevel.colorSchemeEvents[0].colorSchemeId);

  return (
    <main className="editor-shell">
      <section className="editor-toolbar">
        <div>
          <strong>{level.song.title}</strong>
          <span>{level.rhythmPoints.length} 个节奏点 · {editedLevel.events.length} 行</span>
        </div>
        <div className="editor-actions">
          <button type="button" onClick={() => fileRef.current?.click()}>导入</button>
          <button type="button" onClick={exportEdits}>导出</button>
          <button
            type="button"
            onClick={() => {
              if (!window.confirm('清空这首歌的人工修改？')) return;
              const cleared: LevelEdits = {
                ...emptyLevelEdits(level.id),
                baseFingerprint: score.audioFingerprint,
                evidenceFingerprint: score.evidenceFingerprint,
              };
              setEdits(cleared);
              if (selectedRegion) {
                setRecipeDraft(draftForRegion(score, cleared, selectedRegion.id));
              }
              setSyncRepeats(false);
              setDirty(true);
              onDirtyChange(true);
              setStatus('人工修改已清空，尚未保存');
            }}
          >清空人工修改</button>
          <button className="primary" type="button" disabled={!dirty} onClick={() => void save()}>
            保存
          </button>
          <input ref={fileRef} hidden type="file" accept="application/json" onChange={(event) => void importEdits(event)} />
        </div>
      </section>

      <section className="transport">
        <audio
          key={level.id}
          ref={audioRef}
          controls
          preload="metadata"
          src={audioSource(level.song.audioUrl)}
          onTimeUpdate={(event) => {
            const time = event.currentTarget.currentTime;
            setPlaybackTime(time);
            if (!event.currentTarget.paused && !auditioningRef.current) setSelectedTime(time);
          }}
        />
        <input
          aria-label="歌曲时间"
          type="range"
          min={0}
          max={level.song.durationSeconds}
          step={0.01}
          value={playbackTime}
          onChange={(event) => seek(Number(event.target.value))}
        />
        <strong>{formatTime(playbackTime)}</strong>
        <span className="audition-hint"><kbd>Space</kbd> 从选中点试听一拍</span>
        <span className="save-status">{status}</span>
      </section>

      <section className="arrangement-workbench">
        <header className="arrangement-header">
          <div>
            <span className="eyebrow">优先工作区</span>
            <h2>段落编排</h2>
            <p>先选一个接近你想法的演奏预设，再决定哪些声部一起参与。</p>
          </div>
          <div className="arrangement-head-actions">
            <span>{edits.arrangements.length} / {score.regions.length} 段已编排</span>
            <button className="primary" type="button" onClick={adoptSuggestions}>
              {fingerprintMismatch ? '重新采用当前分析建议' : '一键采用全曲建议'}
            </button>
          </div>
        </header>

        {preview.error && (
          <div className="preview-message error" role="alert">
            <strong>当前编排暂时无法预览</strong>
            <span>{preview.error}</span>
            <small>已保留上一个可用预览，你可以继续调整或删除当前配方。</small>
          </div>
        )}
        {!preview.error && preview.notices.length > 0 && (
          <div className="preview-message notice">
            当前编译给出 {preview.notices.length} 条提示；没有证据的段落会保留基础行或停止应用，不会静默生成。
          </div>
        )}

        {reviewQueue.length > 0 && (
          <div className="review-queue">
            <div>
              <strong>优先复核</strong>
              <span>这里只列低覆盖或建议不确定的片段</span>
            </div>
            <div>
              {reviewQueue.map((item) => {
                const region = score.regions.find((candidate) => candidate.id === item.regionId);
                return region ? (
                  <button type="button" key={item.regionId} onClick={() => selectRegion(item.regionId)}>
                    {region.label} · {item.reasons.join(' / ')}
                  </button>
                ) : null;
              })}
            </div>
          </div>
        )}

        <div className="arrangement-layout">
          <div className="region-browser">
            <div className="region-browser-title">
              <strong>选择段落</strong>
              <span>{score.regions.length} 段</span>
            </div>
            <div className="region-list">
              {score.regions.map((region) => {
                const recipe = edits.arrangements.find((candidate) => candidate.regionId === region.id);
                const suggestion = score.suggestions.find((candidate) => candidate.regionId === region.id);
                const reviewReasons = reviewByRegion.get(region.id);
                return (
                  <button
                    type="button"
                    key={region.id}
                    className={region.id === selectedRegion?.id ? 'selected' : ''}
                    onClick={() => selectRegion(region.id)}
                  >
                    <span>
                      <strong>{region.label}</strong>
                      <small>{formatTime(region.startSeconds)}–{formatTime(region.endSeconds)}</small>
                    </span>
                    <em className={recipe ? 'saved' : reviewReasons ? 'review' : ''}>
                      {recipe ? recipeSummary(recipe) : reviewReasons ? reviewReasons.join(' / ') : suggestion ? '建议稳定' : '未编排'}
                    </em>
                  </button>
                );
              })}
            </div>
          </div>

          {selectedRegion && (
            <div className="recipe-editor">
              <div className="recipe-title-row">
                <div>
                  <span className="eyebrow">{selectedRecipe ? '已应用的配方' : '待应用的配方'}</span>
                  <h3>{selectedRegion.label}</h3>
                  <p>{formatTime(selectedRegion.startSeconds)} – {formatTime(selectedRegion.endSeconds)}</p>
                </div>
                <button
                  type="button"
                  onClick={() => void auditionRange(selectedRegion.startSeconds, selectedRegion.endSeconds)}
                >▶ 试听整段</button>
              </div>

              {score.stemPreviewUrls && Object.keys(score.stemPreviewUrls).length > 0 && (
                <div className="stem-preview-links">
                  <span>分轨试听</span>
                  {Object.entries(score.stemPreviewUrls).map(([role, url]) => url ? (
                    <a key={role} href={url} target="_blank" rel="noreferrer">
                      ▶ {STEM_LABELS[role] ?? role}
                    </a>
                  ) : null)}
                </div>
              )}

              {selectedSuggestion && (
                <div className="suggestion-note">
                  <strong>算法建议</strong>
                  <span>{REASON_LABELS[selectedSuggestion.reasonCodes[0]] ?? '来自本段的局部音乐证据'}</span>
                  <button
                    type="button"
                    onClick={() => {
                      if (selectedSuggestedRecipe) setRecipeDraft(draftFromRecipe(selectedSuggestedRecipe));
                    }}
                  >恢复这段建议</button>
                </div>
              )}

              <div className="preset-grid" aria-label="演奏预设">
                {PRESET_OPTIONS.map((preset) => (
                  <button type="button" key={preset.id} onClick={() => choosePreset(preset.id)}>
                    <strong>{preset.label}</strong>
                    <small>{preset.hint}</small>
                  </button>
                ))}
              </div>

              {recipeDraft.mode === 'rest' ? (
                <div className="rest-draft">
                  <strong>这一段将留白</strong>
                  <span>应用后会移除该片段内的演奏行；逐点覆盖仍然最后生效。</span>
                </div>
              ) : (
                <>
                  <section className="layer-section">
                    <header>
                      <div><strong>领奏者 / 一起演奏</strong><span>可多选；第一项是主要演奏声部</span></div>
                    </header>
                    <div className="evidence-options">
                      {timingStreams.map((stream) => {
                        const layer = recipeDraft.timingLayers.find((candidate) => (
                          candidate.sourceId === stream.id && candidate.role === 'target'
                        ));
                        const firstTarget = recipeDraft.timingLayers.find((candidate) => candidate.role === 'target');
                        const summary = getRegionStreamSummary(score, selectedRegion.id, stream.id);
                        const selectable = isEvidenceSelectable(score, 'timing', stream.id);
                        return (
                          <label className={layer ? 'selected' : ''} key={stream.id}>
                            <input
                              type="checkbox"
                              checked={Boolean(layer)}
                              disabled={!selectable}
                              onChange={(event) => toggleEvidenceLayer(stream.id, 'target', event.target.checked)}
                            />
                            <span>
                              <strong>{layer && firstTarget?.sourceId === stream.id ? '领奏 · ' : layer ? '一起 · ' : ''}{streamDisplayName(stream)}</strong>
                              <small>
                                {availabilityLabel(stream)}
                                {summary ? ` · ${summary.eventCount} 点 · 覆盖 ${Math.round(summary.activeCoverageRatio * 100)}% · 最长空白 ${summary.maximumGapSeconds.toFixed(2)}s` : ' · 本段暂无统计'}
                              </small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>

                  <section className="layer-section compact">
                    <header><div><strong>强调声部</strong><span>只增强附近方块，不单独制造新方块</span></div></header>
                    <div className="evidence-options">
                      {accentStreams.map((stream) => {
                        const selected = recipeDraft.timingLayers.some((layer) => (
                          layer.sourceId === stream.id && layer.role === 'accent'
                        ));
                        const summary = getRegionStreamSummary(score, selectedRegion.id, stream.id);
                        return (
                          <label className={selected ? 'selected' : ''} key={stream.id}>
                            <input
                              type="checkbox"
                              checked={selected}
                              disabled={!isEvidenceSelectable(score, 'accent', stream.id)}
                              onChange={(event) => toggleEvidenceLayer(stream.id, 'accent', event.target.checked)}
                            />
                            <span>
                              <strong>{streamDisplayName(stream)}</strong>
                              <small>{availabilityLabel(stream)}{summary ? ` · ${summary.eventCount} 个强调点` : ''}</small>
                            </span>
                          </label>
                        );
                      })}
                    </div>
                  </section>

                  <div className="recipe-fields">
                    <label className="recipe-select">
                      <span>轨道跟随</span>
                      <select value={laneDriverValue(recipeDraft.laneDriver)} onChange={(event) => changeLaneDriver(event.target.value)}>
                        <option value="gesture:pulse">中间定点</option>
                        <option value="gesture:alternating">左右交替</option>
                        {laneStreams.map((stream) => (
                          <option
                            key={stream.id}
                            value={`source:${stream.id}`}
                            disabled={!isEvidenceSelectable(score, 'lane', stream.id)}
                          >{streamDisplayName(stream)}（{availabilityLabel(stream)}）</option>
                        ))}
                      </select>
                    </label>
                    <div className="feel-control">
                      <span>手感</span>
                      <div role="group" aria-label="手感">
                        {(Object.keys(FEEL_LABELS) as RegionFeel[]).map((feel) => (
                          <button
                            className={recipeDraft.feel === feel ? 'active' : ''}
                            type="button"
                            key={feel}
                            onClick={() => setRecipeDraft({ ...recipeDraft, feel })}
                          >{FEEL_LABELS[feel]}</button>
                        ))}
                      </div>
                    </div>
                  </div>

                  <div className="slider-grid">
                    <RecipeSlider
                      label="密度"
                      value={recipeDraft.density}
                      description="在全段预算内保留多少真实发音点。"
                      onChange={(density) => setRecipeDraft({ ...recipeDraft, density })}
                    />
                    <RecipeSlider
                      label="移动幅度"
                      value={recipeDraft.laneDriver.motion}
                      description="越高越会使用完整五轨音高或动作范围。"
                      onChange={(motion) => setRecipeDraft({
                        ...recipeDraft,
                        laneDriver: { ...recipeDraft.laneDriver, motion },
                      })}
                    />
                    <RecipeSlider
                      label="挑战强度"
                      value={recipeDraft.challenge}
                      description="增加预判与强调，但不改变声音时间。"
                      onChange={(challenge) => setRecipeDraft({ ...recipeDraft, challenge })}
                    />
                  </div>

                  <details className="advanced-weights">
                    <summary>高级：声部权重</summary>
                    {recipeDraft.timingLayers.map((layer) => (
                      <RecipeSlider
                        key={layer.sourceId}
                        label={`${layer.role === 'target' ? '演奏' : '强调'} · ${layer.sourceId}`}
                        value={layer.weight}
                        description="只影响多个候选冲突时谁更突出。"
                        onChange={(weight) => updateLayerWeight(layer.sourceId, Math.max(0.01, weight))}
                      />
                    ))}
                  </details>
                </>
              )}

              <div className="repeat-control">
                {repeatSelection && repeatSet ? (
                  <label>
                    <input
                      type="checkbox"
                      checked={syncRepeats}
                      onChange={(event) => setSyncRepeats(event.target.checked)}
                    />
                    <span>
                      <strong>同步到 {repeatSelection.occurrenceIds.length} 个重复段</strong>
                      <small>
                        重复可信度 {Math.round(repeatSet.confidence * 100)}%；保留各段自己的实测时间点，
                        并覆盖这些重复区间里已有的段落配方。
                      </small>
                    </span>
                  </label>
                ) : (
                  <span>这一段没有识别到可信的重复关系。</span>
                )}
              </div>

              <p className="f0-disclaimer">
                分轨、人声发音和连续音高仍是算法估计。不可用的证据会禁选，编译不会偷偷换成另一个声部。
              </p>
              <div className="recipe-actions">
                <button className="primary" type="button" onClick={applyRecipe}>
                  {selectedRecipe ? '更新这一段' : '应用到这一段'}
                </button>
                <button type="button" disabled={!selectedRecipe} onClick={deleteRecipe}>删除当前配方</button>
              </div>
            </div>
          )}
        </div>
      </section>

      <section className="editor-grid">
        <div className="step-editor">
          <header>
            <div>
              <button type="button" onClick={() => seek(level.rhythmPoints[Math.max(0, selectedIndex - 1)].timeSeconds)}>上一个</button>
              <button type="button" onClick={() => seek(level.rhythmPoints[Math.min(level.rhythmPoints.length - 1, selectedIndex + 1)].timeSeconds)}>下一个</button>
            </div>
            <div className="tools" role="group" aria-label="绘制工具">
              {[
                [ObstacleType.Empty, '删除'],
                [ObstacleType.Breakable, '方块'],
                [ObstacleType.Spike, '地刺'],
              ].map(([value, label]) => (
                <button
                  className={tool === value ? 'active' : ''}
                  type="button"
                  key={value}
                  onClick={() => setTool(value as ObstacleType)}
                >{label}</button>
              ))}
            </div>
          </header>
          <div className="lane-head"><span>时间 / 证据</span>{[1, 2, 3, 4, 5].map((lane) => <b key={lane}>轨 {lane}</b>)}</div>
          <div className="step-list">
            {visiblePoints.map((point) => {
              const row = rowAt(point.timeSeconds);
              const selected = point.id === selectedPoint.id;
              return (
                <div className={`step-row ${selected ? 'selected' : ''}`} key={point.id}>
                  <button className="step-time" type="button" onClick={() => seek(point.timeSeconds)}>
                    <strong>{formatTime(point.timeSeconds)}</strong>
                    <small>{point.kind} · {point.pitchMidi == null ? point.sourceRole : `MIDI ${point.pitchMidi}`}</small>
                  </button>
                  {row.map((cell, lane) => (
                    <button
                      key={lane}
                      type="button"
                      className={`cell cell-${cell}`}
                      aria-label={`${formatTime(point.timeSeconds)} 轨道 ${lane + 1} ${rowKind([cell])}`}
                      onClick={() => paintCell(point, lane)}
                    >{cell === ObstacleType.Breakable ? '■' : cell === ObstacleType.Spike ? '▲' : '·'}</button>
                  ))}
                </div>
              );
            })}
          </div>
        </div>

        <aside className="color-editor">
          <header>
            <h2>颜色区间</h2>
            <span className="current-color" style={{ background: colorHex(SCENE_COLOR_SCHEMES[activeColor].primary) }}>
              {activeColor}
            </span>
          </header>
          <p>在节奏点选择起点，再选择较晚的节奏点作为终点。</p>
          <button type="button" onClick={() => setRangeStart(selectedPoint.timeSeconds)}>
            起点：{rangeStart == null ? '未选择' : formatTime(rangeStart)}
          </button>
          <div className="scheme-grid">
            {COLOR_IDS.map((colorSchemeId) => {
              const scheme = SCENE_COLOR_SCHEMES[colorSchemeId];
              return (
                <button
                  type="button"
                  className={rangeColor === colorSchemeId ? 'selected' : ''}
                  key={colorSchemeId}
                  title={colorSchemeId}
                  onClick={() => setRangeColor(colorSchemeId)}
                >
                  <i style={{ background: colorHex(scheme.primary) }} />
                  <i style={{ background: colorHex(scheme.hazard) }} />
                  <span>{colorSchemeId}</span>
                </button>
              );
            })}
          </div>
          <div className="range-actions">
            <button className="primary" type="button" onClick={() => addColorRange(selectedPoint.timeSeconds)}>
              结束于 {formatTime(selectedPoint.timeSeconds)}
            </button>
            <button type="button" onClick={() => addColorRange(level.song.durationSeconds)}>持续到歌曲结束</button>
          </div>
          <div className="range-list">
            {edits.colorRanges.length === 0 && <p>还没有人工颜色区间。</p>}
            {edits.colorRanges.map((range) => (
              <div key={range.id}>
                <button type="button" onClick={() => seek(range.startSeconds)}>
                  {formatTime(range.startSeconds)}–{formatTime(range.endSeconds)} · {range.colorSchemeId}
                </button>
                <button
                  type="button"
                  aria-label="删除颜色区间"
                  onClick={() => updateEdits({
                    ...edits,
                    colorRanges: edits.colorRanges.filter((candidate) => candidate.id !== range.id),
                  })}
                >×</button>
              </div>
            ))}
          </div>
          <dl className="editor-stats">
            <div><dt>段落配方</dt><dd>{edits.arrangements.length}</dd></div>
            <div><dt>人工行修改</dt><dd>{edits.rowOverrides.length}</dd></div>
            <div><dt>人工颜色区间</dt><dd>{edits.colorRanges.length}</dd></div>
            <div><dt>当前节奏点</dt><dd>{selectedIndex + 1} / {level.rhythmPoints.length}</dd></div>
          </dl>
          <a href="/" target="_blank" rel="noreferrer">打开游戏预览 ↗</a>
        </aside>
      </section>
    </main>
  );
}

export function LevelEditor() {
  const requested = new URLSearchParams(window.location.search).get('song');
  const initial = getEditorLevel(requested);
  const [levelId, setLevelId] = useState(initial.id);
  const [dirty, setDirty] = useState(false);
  const level = getEditorLevel(levelId);
  const score = getEditorAuthoringScore(level.id);

  return (
    <>
      <nav className="song-tabs" aria-label="歌曲">
        <h1>LEAPING HORIZON / CHART EDITOR</h1>
        {EDITOR_LEVELS.map((candidate) => (
          <button
            className={candidate.id === level.id ? 'active' : ''}
            type="button"
            key={candidate.id}
            onClick={() => {
              if (dirty && !window.confirm('当前歌曲有未保存修改，仍要切换歌曲吗？')) return;
              const url = new URL(window.location.href);
              url.searchParams.set('song', candidate.id);
              window.history.replaceState(null, '', url);
              setDirty(false);
              setLevelId(candidate.id);
            }}
          >{candidate.song.title}</button>
        ))}
      </nav>
      <SongEditor key={level.id} level={level} score={score} onDirtyChange={setDirty} />
    </>
  );
}
