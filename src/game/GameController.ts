import { AudioEngine } from '../audio/AudioEngine';
import type { ChartNote, GameResult, NoteState, SongChart } from '../types';
import { GameScene } from './GameScene';

interface GameCallbacks {
  onHud: (score: number, combo: number, progress: number) => void;
  onDeath: () => void;
  onFinish: (result: GameResult) => void;
}

const HIT_WINDOW = 0.25;
const LANE_X = 1.35;
const DRAG_SENSITIVITY = 2.4;

export class GameController {
  private readonly scene: GameScene;
  private readonly audio: AudioEngine;
  private readonly chart: SongChart;
  private readonly callbacks: GameCallbacks;
  private readonly states: NoteState[];
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

  constructor(canvas: HTMLCanvasElement, chart: SongChart, callbacks: GameCallbacks) {
    this.scene = new GameScene(canvas);
    this.audio = new AudioEngine(chart.duration, chart.bpm);
    this.chart = chart;
    this.callbacks = callbacks;
    this.states = chart.notes.map(() => 'pending');
  }

  start(): void {
    this.audio.start();
    this.frameId = requestAnimationFrame(this.loop);
  }

  resize(width: number, height: number): void {
    this.scene.resize(width, height);
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
    if (!this.audio.paused && !this.dead) this.judgeNotes(time, this.chart.notes);
    this.scene.render(time, this.chart.notes, this.states, this.combo);

    if (time - this.lastHudUpdate > 0.045 || time >= this.chart.duration) {
      this.callbacks.onHud(this.score, this.combo, Math.min(1, time / this.chart.duration));
      this.lastHudUpdate = time;
    }

    if (time >= this.chart.duration && !this.dead) {
      this.finish();
      return;
    }
    this.frameId = requestAnimationFrame(this.loop);
  };

  private judgeNotes(time: number, notes: ChartNote[]): void {
    for (let i = 0; i < notes.length; i += 1) {
      if (this.states[i] !== 'pending') continue;
      const delta = time - notes[i].time;
      // 只在物体真正抵达飞盘的碰撞帧判定；不再提前吸附或提前消失。
      if (delta >= 0 && delta <= HIT_WINDOW) {
        const targetX = notes[i].lane * LANE_X;
        if (Math.abs(this.scene.getPlayerX() - targetX) <= 0.8) {
          if (notes[i].type === 'spike') {
            this.states[i] = 'hit';
            this.dead = true;
            this.combo = 0;
            this.scene.crash(notes[i].lane);
            void this.audio.pause();
            this.callbacks.onDeath();
            return;
          }
          this.states[i] = 'hit';
          this.combo += 1;
          this.maxCombo = Math.max(this.maxCombo, this.combo);
          this.hits += 1;
          const points = 100 + Math.min(200, this.combo * 4);
          this.score += points;
          this.scene.burst(notes[i].lane);
          continue;
        }
      }
      if (delta > HIT_WINDOW) {
        this.states[i] = 'miss';
        if (notes[i].type === 'normal') {
          this.combo = 0;
          this.scene.flashMiss(time);
        }
      }
      if (notes[i].time - time > 0.4) break;
    }
  }

  private finish(): void {
    if (this.finished) return;
    this.finished = true;
    this.callbacks.onFinish({
      score: this.score,
      maxCombo: this.maxCombo,
      hits: this.hits,
      total: this.chart.notes.filter((note) => note.type === 'normal').length,
    });
  }

  destroy(): void {
    this.finished = true;
    cancelAnimationFrame(this.frameId);
    this.audio.stop();
    this.scene.dispose();
  }
}
