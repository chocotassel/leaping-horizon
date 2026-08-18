import { useEffect, useMemo, useRef, useState, type ChangeEvent } from 'react';

import { SCENE_COLOR_SCHEMES, type SceneColorSchemeId } from '../game/colorSchemes';
import {
  applyLevelEdits,
  emptyLevelEdits,
  parseLevelEdits,
  rhythmPointKey,
  type LevelEdits,
} from '../levelEdits';
import { ObstacleType, type Level, type ObstacleRow, type RhythmPoint } from '../types';
import { getBeatAuditionRange } from './beatAudition';
import { EDITOR_LEVELS, getEditorLevel, getEditorLevelEdits } from './editorData';

const EMPTY_ROW: ObstacleRow = [0, 0, 0, 0, 0];
const COLOR_IDS = Object.keys(SCENE_COLOR_SCHEMES) as SceneColorSchemeId[];

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

function SongEditor({ level, onDirtyChange }: { level: Level; onDirtyChange: (dirty: boolean) => void }) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const auditionFrameRef = useRef<number | null>(null);
  const auditioningRef = useRef(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const [edits, setEdits] = useState(() => cloneEdits(getEditorLevelEdits(level.id)));
  const [tool, setTool] = useState<ObstacleType>(ObstacleType.Breakable);
  const [playbackTime, setPlaybackTime] = useState(0);
  const [selectedTime, setSelectedTime] = useState(level.rhythmPoints[0].timeSeconds);
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

  const baseRows = useMemo(() => new Map(
    level.events.map((event) => [rhythmPointKey(event.timeSeconds), event.obstacles]),
  ), [level]);
  const overrideRows = useMemo(() => new Map(
    edits.rowOverrides.map((override) => [rhythmPointKey(override.timeSeconds), override.obstacles]),
  ), [edits.rowOverrides]);
  const editedLevel = useMemo(() => applyLevelEdits(level, edits), [edits, level]);
  const selectedIndex = nearestPointIndex(level.rhythmPoints, selectedTime);
  const selectedPoint = level.rhythmPoints[selectedIndex];
  const visiblePoints = level.rhythmPoints.slice(
    Math.max(0, selectedIndex - 14),
    Math.min(level.rhythmPoints.length, selectedIndex + 15),
  );

  const rowAt = (timeSeconds: number): ObstacleRow => (
    overrideRows.get(rhythmPointKey(timeSeconds))
    ?? baseRows.get(rhythmPointKey(timeSeconds))
    ?? EMPTY_ROW
  );

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

  const auditionBeat = async () => {
    const audio = audioRef.current;
    if (!audio?.paused) return;

    stopAudition(false);
    const range = getBeatAuditionRange(
      selectedPoint.timeSeconds,
      level.song.bpm,
      level.song.durationSeconds,
    );
    audio.currentTime = range.startSeconds;
    setPlaybackTime(range.startSeconds);
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
      if (audio.currentTime >= range.endSeconds) {
        stopAudition(true);
        audio.currentTime = range.endSeconds;
        setPlaybackTime(range.endSeconds);
        return;
      }
      auditionFrameRef.current = requestAnimationFrame(watch);
    };
    auditionFrameRef.current = requestAnimationFrame(watch);
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
      setEdits(parseLevelEdits(next, level));
      setDirty(true);
      onDirtyChange(true);
      setStatus('有未保存修改');
    } catch (error) {
      setStatus(error instanceof Error ? error.message : String(error));
    }
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
      const imported = parseLevelEdits(JSON.parse(await file.text()), level);
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
              setEdits(emptyLevelEdits(level.id));
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
      <SongEditor key={level.id} level={level} onDirtyChange={setDirty} />
    </>
  );
}
