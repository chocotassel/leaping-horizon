import { AudioEngine } from '../audio/AudioEngine';
import {
  LANE_CENTERS,
  ObstacleType,
  type GameResult,
  type LaneIndex,
  type Level,
  type LevelEvent,
  type ObstacleStateRow,
} from '../types';
import { GameScene } from './GameScene';
import type { SceneColorSchemeId } from './colorSchemes';
import { overlapsCollectibleTarget, overlapsPlayer } from './physics';

export interface GameCallbacks {
  onHud: (hud: GameHud) => void;
  onCrash?: () => void;
  onDeath: (result: GameResult) => void;
  onFinish: (result: GameResult) => void;
}

export interface GameHud {
  combo: number;
  progress: number;
  hits: number;
  doubleHitRows: number;
}

const DRAG_SENSITIVITY = 2.4;
export const CRASH_EFFECT_DURATION_MS = 1150;
const CRASH_SCENE_MAX_ADVANCE_SECONDS = 0.07;
const CRASH_SCENE_DECAY_MS = 180;

export function getCrashEffectProgress(startedAt: number, now: number): number {
  return Math.min(1, Math.max(0, (now - startedAt) / CRASH_EFFECT_DURATION_MS));
}

export function getCrashSceneTime(startTime: number, elapsedMs: number): number {
  const elapsed = Math.max(0, elapsedMs);
  return startTime + CRASH_SCENE_MAX_ADVANCE_SECONDS * (
    1 - Math.exp(-elapsed / CRASH_SCENE_DECAY_MS)
  );
}

export interface RunJudgmentState {
  score: number;
  combo: number;
  maxCombo: number;
  hits: number;
  doubleHitRows: number;
  dodges: number;
}

export type EventRowOutcome = 'none' | 'target-hit' | 'target-miss' | 'dodge' | 'crash';

export interface EventRowResolution {
  outcome: EventRowOutcome;
  states: ObstacleStateRow;
  run: RunJudgmentState;
  impactX: number | null;
}

interface ResolveEventRowOptions {
  event: LevelEvent;
  states: ObstacleStateRow;
  playerX: number;
  run: RunJudgmentState;
}

function pendingCollisions(
  event: LevelEvent,
  states: ObstacleStateRow,
  playerX: number,
  type: ObstacleType,
): LaneIndex[] {
  const lanes: LaneIndex[] = [];
  for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
    const lane = laneIndex as LaneIndex;
    if (event.obstacles[lane] !== type || states[lane] !== 'pending') continue;
    const overlaps = type === ObstacleType.Breakable ? overlapsCollectibleTarget : overlapsPlayer;
    if (overlaps(playerX, LANE_CENTERS[lane])) lanes.push(lane);
  }
  return lanes.sort((left, right) => (
    Math.abs(playerX - LANE_CENTERS[left]) - Math.abs(playerX - LANE_CENTERS[right])
  ));
}

/** Resolve one due musical row atomically, so lane order cannot change its outcome. */
export function resolveEventRow({
  event,
  states: currentStates,
  playerX,
  run: currentRun,
}: ResolveEventRowOptions): EventRowResolution {
  const states = [...currentStates] as ObstacleStateRow;
  const run = { ...currentRun };
  const result = (outcome: EventRowOutcome, impactLane: LaneIndex | null = null): EventRowResolution => ({
    outcome,
    states,
    run,
    impactX: impactLane === null ? null : LANE_CENTERS[impactLane],
  });

  // Hazards are resolved before targets across the whole row. A player spanning
  // adjacent lanes must never survive because the target happened to be visited first.
  const [spikeLane] = pendingCollisions(
    event,
    currentStates,
    playerX,
    ObstacleType.Spike,
  );
  if (spikeLane !== undefined) {
    states[spikeLane] = 'hit';
    run.combo = 0;
    return result('crash', spikeLane);
  }

  if (event.kind === 'target') {
    const alreadySatisfied = event.obstacles.some((type, lane) => (
      type === ObstacleType.Breakable && currentStates[lane] === 'hit'
    ));
    const hasPendingTarget = event.obstacles.some((type, lane) => (
      type === ObstacleType.Breakable && currentStates[lane] === 'pending'
    ));
    const targetLanes = pendingCollisions(
      event,
      currentStates,
      playerX,
      ObstacleType.Breakable,
    );

    for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
      const lane = laneIndex as LaneIndex;
      if (states[lane] !== 'pending') continue;
      const type = event.obstacles[lane];
      if (type === ObstacleType.Breakable) {
        states[lane] = !alreadySatisfied && targetLanes.includes(lane) ? 'hit' : 'miss';
      } else if (type === ObstacleType.Spike) {
        states[lane] = 'miss';
      }
    }

    if (alreadySatisfied || !hasPendingTarget) return result('none');
    if (targetLanes.length === 0) {
      run.combo = 0;
      return result('target-miss');
    }

    run.combo += 1;
    run.maxCombo = Math.max(run.maxCombo, run.combo);
    run.hits += 1;
    if (
      targetLanes.length >= 2
      && event.obstacles.filter((type) => type === ObstacleType.Breakable).length > 1
    ) run.doubleHitRows += 1;
    run.score += 100 + Math.min(200, run.combo * 4);
    return result('target-hit', targetLanes[0]);
  }

  const hasPendingObstacle = currentStates.some((state) => state === 'pending');
  for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
    const lane = laneIndex as LaneIndex;
    if (states[lane] === 'pending') states[lane] = 'miss';
  }
  if (event.kind !== 'dodge' || !hasPendingObstacle) return result('none');

  run.dodges += 1;
  run.combo += 1;
  run.maxCombo = Math.max(run.maxCombo, run.combo);
  run.score += 70 + Math.min(120, run.combo * 2);
  return result('dodge');
}

/** Accuracy is measured per Choice Row, never per Target Cell. */
export function countChoiceRows(events: readonly LevelEvent[]): number {
  return events.filter((event) => event.kind === 'target').length;
}

export function countMultiTargetRows(events: readonly LevelEvent[]): number {
  return events.filter((event) => (
    event.kind === 'target'
    && event.obstacles.filter((type) => type === ObstacleType.Breakable).length > 1
  )).length;
}

export class GameController {
  private readonly scene: GameScene;
  private readonly audio: AudioEngine;
  private readonly level: Level;
  private readonly callbacks: GameCallbacks;
  private readonly states: ObstacleStateRow[];
  private score = 0;
  private combo = 0;
  private maxCombo = 0;
  private hits = 0;
  private doubleHitRows = 0;
  private dodges = 0;
  private nextEventIndex = 0;
  private nextColorSchemeEventIndex = 0;
  private frameId = 0;
  private finished = false;
  private dead = false;
  private crashStartedAt: number | null = null;
  private crashSongTime = 0;
  private pointerId: number | null = null;
  private lastPointerX = 0;
  private lastHudUpdate = 0;

  constructor(canvas: HTMLCanvasElement, level: Level, callbacks: GameCallbacks) {
    this.scene = new GameScene(canvas, level);
    this.audio = new AudioEngine(level.song.durationSeconds, level.song.bpm, level.song.audioUrl);
    this.level = level;
    this.callbacks = callbacks;
    this.states = level.events.map((event) => event.obstacles.map((type) => (
      type === ObstacleType.Empty ? null : 'pending'
    )) as ObstacleStateRow);
  }

  start(): void {
    void this.audio.start().then(() => {
      if (!this.finished) this.frameId = requestAnimationFrame(this.loop);
    });
  }

  resize(width: number, height: number): void {
    this.scene.resize(width, height);
  }

  setColorScheme(colorSchemeId: SceneColorSchemeId): void {
    this.scene.setColorScheme(colorSchemeId);
  }

  getColorSchemeId(): SceneColorSchemeId {
    return this.scene.getColorSchemeId();
  }

  setPointer(pointerId: number, normalizedX: number): void {
    if (this.dead) return;
    if (this.pointerId === null) {
      this.pointerId = pointerId;
      this.lastPointerX = normalizedX;
    } else if (this.pointerId === pointerId) {
      this.scene.movePlayerNormalized((normalizedX - this.lastPointerX) * DRAG_SENSITIVITY);
      this.lastPointerX = normalizedX;
    }
  }

  releasePointer(pointerId: number): void {
    if (this.pointerId === pointerId) this.pointerId = null;
  }

  async togglePause(): Promise<boolean> {
    if (this.dead) return false;
    if (this.audio.paused) await this.audio.resume();
    else await this.audio.pause();
    return this.audio.paused;
  }

  private loop = (): void => {
    if (this.finished) return;
    const now = performance.now();
    const time = this.crashStartedAt === null
      ? this.audio.currentTime
      : getCrashSceneTime(this.crashSongTime, now - this.crashStartedAt);
    while (
      this.nextColorSchemeEventIndex < this.level.colorSchemeEvents.length
      && this.level.colorSchemeEvents[this.nextColorSchemeEventIndex].timeSeconds <= time
    ) {
      this.scene.setColorScheme(this.level.colorSchemeEvents[this.nextColorSchemeEventIndex].colorSchemeId);
      this.nextColorSchemeEventIndex += 1;
    }
    if (!this.audio.paused && !this.dead) this.judgeObstacles(time);
    this.scene.render(time, this.level, this.states, this.combo, this.audio.spectrum);

    if (time - this.lastHudUpdate > 0.045 || time >= this.level.song.durationSeconds) {
      this.callbacks.onHud({
        combo: this.combo,
        progress: Math.min(1, time / this.level.song.durationSeconds),
        hits: this.hits,
        doubleHitRows: this.doubleHitRows,
      });
      this.lastHudUpdate = time;
    }

    if (time >= this.level.song.durationSeconds && !this.dead) {
      this.finish();
      return;
    }
    if (
      this.crashStartedAt !== null
      && getCrashEffectProgress(this.crashStartedAt, now) >= 1
    ) {
      this.finished = true;
      this.callbacks.onDeath(this.getResult());
      return;
    }
    this.frameId = requestAnimationFrame(this.loop);
  };

  private judgeObstacles(time: number): void {
    while (this.nextEventIndex < this.level.events.length) {
      const eventIndex = this.nextEventIndex;
      const event = this.level.events[eventIndex];
      const secondsUntilBeat = event.timeSeconds - time;
      if (secondsUntilBeat > 0) break;

      const resolution = resolveEventRow({
        event,
        states: this.states[eventIndex],
        playerX: this.scene.getPlayerX(),
        run: {
          score: this.score,
          combo: this.combo,
          maxCombo: this.maxCombo,
          hits: this.hits,
          doubleHitRows: this.doubleHitRows,
          dodges: this.dodges,
        },
      });
      this.states[eventIndex] = resolution.states;
      this.score = resolution.run.score;
      this.combo = resolution.run.combo;
      this.maxCombo = resolution.run.maxCombo;
      this.hits = resolution.run.hits;
      this.doubleHitRows = resolution.run.doubleHitRows;
      this.dodges = resolution.run.dodges;
      this.nextEventIndex += 1;

      if (resolution.outcome === 'crash') {
        this.dead = true;
        this.crashSongTime = time;
        this.crashStartedAt = performance.now();
        this.callbacks.onCrash?.();
        this.scene.crash(resolution.impactX ?? this.scene.getPlayerX());
        this.audio.crash();
        return;
      }
      if (resolution.outcome === 'target-hit') {
        this.scene.burst(resolution.impactX ?? this.scene.getPlayerX());
      } else if (resolution.outcome === 'target-miss') {
        this.scene.flashMiss(time);
      }
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.callbacks.onFinish(this.getResult());
  }

  private getResult(): GameResult {
    return {
      score: this.score,
      maxCombo: this.maxCombo,
      hits: this.hits,
      total: countChoiceRows(this.level.events),
      doubleHitRows: this.doubleHitRows,
      totalMultiTargetRows: countMultiTargetRows(this.level.events),
      dodges: this.dodges,
      totalDodges: this.level.events.filter((event) => event.kind === 'dodge').length,
    };
  }

  destroy(): void {
    this.finished = true;
    cancelAnimationFrame(this.frameId);
    this.audio.stop();
    this.scene.dispose();
  }
}
