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
import { overlapsPlayer } from './physics';

interface GameCallbacks {
  onHud: (score: number, combo: number, progress: number) => void;
  onDeath: (result: GameResult) => void;
  onFinish: (result: GameResult) => void;
}

const DRAG_SENSITIVITY = 2.4;

export interface RunJudgmentState {
  score: number;
  combo: number;
  maxCombo: number;
  hits: number;
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

function closestPendingCollision(
  event: LevelEvent,
  states: ObstacleStateRow,
  playerX: number,
  type: ObstacleType,
): LaneIndex | null {
  let closestLane: LaneIndex | null = null;
  let closestDistance = Infinity;
  for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
    const lane = laneIndex as LaneIndex;
    if (event.obstacles[lane] !== type || states[lane] !== 'pending') continue;
    const distance = Math.abs(playerX - LANE_CENTERS[lane]);
    if (overlapsPlayer(playerX, LANE_CENTERS[lane]) && distance < closestDistance) {
      closestLane = lane;
      closestDistance = distance;
    }
  }
  return closestLane;
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
  const spikeLane = closestPendingCollision(
    event,
    currentStates,
    playerX,
    ObstacleType.Spike,
  );
  if (spikeLane !== null) {
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
    const targetLane = closestPendingCollision(
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
        states[lane] = alreadySatisfied || targetLane !== null ? 'hit' : 'miss';
      } else if (type === ObstacleType.Spike) {
        states[lane] = 'miss';
      }
    }

    if (alreadySatisfied || !hasPendingTarget) return result('none');
    if (targetLane === null) {
      run.combo = 0;
      return result('target-miss');
    }

    run.combo += 1;
    run.maxCombo = Math.max(run.maxCombo, run.combo);
    run.hits += 1;
    run.score += 100 + Math.min(200, run.combo * 4);
    return result('target-hit', targetLane);
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
  private dodges = 0;
  private nextEventIndex = 0;
  private frameId = 0;
  private finished = false;
  private dead = false;
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
    if (this.audio.paused) await this.audio.resume();
    else await this.audio.pause();
    return this.audio.paused;
  }

  private loop = (): void => {
    if (this.finished) return;
    const time = this.audio.currentTime;
    if (!this.audio.paused && !this.dead) this.judgeObstacles(time);
    this.scene.render(time, this.level, this.states, this.combo, this.audio.spectrum);

    if (time - this.lastHudUpdate > 0.045 || time >= this.level.song.durationSeconds) {
      this.callbacks.onHud(this.score, this.combo, Math.min(1, time / this.level.song.durationSeconds));
      this.lastHudUpdate = time;
    }

    if (time >= this.level.song.durationSeconds && !this.dead) {
      this.finish();
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
          dodges: this.dodges,
        },
      });
      this.states[eventIndex] = resolution.states;
      this.score = resolution.run.score;
      this.combo = resolution.run.combo;
      this.maxCombo = resolution.run.maxCombo;
      this.hits = resolution.run.hits;
      this.dodges = resolution.run.dodges;
      this.nextEventIndex += 1;

      if (resolution.outcome === 'crash') {
        this.dead = true;
        this.finished = true;
        this.scene.crash(resolution.impactX ?? this.scene.getPlayerX());
        void this.audio.pause();
        this.callbacks.onDeath(this.getResult());
        return;
      }
      if (resolution.outcome === 'target-hit') {
        this.scene.burst(resolution.impactX ?? this.scene.getPlayerX());
      } else if (resolution.outcome === 'target-miss') {
        this.scene.flashMiss(time);
      } else if (resolution.outcome === 'dodge') {
        this.scene.burst(this.scene.getPlayerX());
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
