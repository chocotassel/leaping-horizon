import { AudioEngine } from '../audio/AudioEngine';
import {
  LANE_CENTERS,
  ObstacleType,
  type GameResult,
  type LaneIndex,
  type Level,
  type ObstacleStateRow,
} from '../types';
import { GameScene } from './GameScene';
import { overlapsPlayer } from './physics';

interface GameCallbacks {
  onHud: (score: number, combo: number, progress: number) => void;
  onDeath: () => void;
  onFinish: (result: GameResult) => void;
}

const DRAG_SENSITIVITY = 2.4;

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
    this.states = level.obstacles.map((row) => row.map((type) => (
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

  setGlowColor(color: string | number): void {
    this.scene.setGlowColor(color);
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
    const tickDuration = 60 / this.level.song.bpm / this.level.ticksPerBeat;
    for (let beatIndex = 0; beatIndex < this.level.obstacles.length; beatIndex += 1) {
      const secondsUntilBeat = this.level.song.beatOffsetSeconds + beatIndex * tickDuration - time;
      for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
        const lane = laneIndex as LaneIndex;
        const type = this.level.obstacles[beatIndex][lane];
        if (type === ObstacleType.Empty || this.states[beatIndex][lane] !== 'pending') continue;
        if (secondsUntilBeat > 0) continue;
        const targetX = LANE_CENTERS[lane];
        if (overlapsPlayer(this.scene.getPlayerX(), targetX)) {
          if (type === ObstacleType.Spike) {
            this.states[beatIndex][lane] = 'hit';
            this.dead = true;
            this.combo = 0;
            this.scene.crash(targetX);
            void this.audio.pause();
            this.callbacks.onDeath();
            return;
          }
          this.states[beatIndex][lane] = 'hit';
          this.combo += 1;
          this.maxCombo = Math.max(this.maxCombo, this.combo);
          this.hits += 1;
          const points = 100 + Math.min(200, this.combo * 4);
          this.score += points;
          this.scene.burst(targetX);
          continue;
        }
        this.states[beatIndex][lane] = 'miss';
        if (type === ObstacleType.Breakable) {
          this.combo = 0;
          this.scene.flashMiss(time);
        }
      }
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.callbacks.onFinish({
      score: this.score,
      maxCombo: this.maxCombo,
      hits: this.hits,
      total: this.level.obstacles.reduce(
        (total, row) => total + row.filter((type) => type === ObstacleType.Breakable).length,
        0,
      ),
    });
  }

  destroy(): void {
    this.finished = true;
    cancelAnimationFrame(this.frameId);
    this.audio.stop();
    this.scene.dispose();
  }
}
