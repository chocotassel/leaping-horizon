export const LANE_CENTERS = [-2, -1, 0, 1, 2] as const;
export type LaneIndex = 0 | 1 | 2 | 3 | 4;

export enum ObstacleType {
  Empty = 0,
  Breakable = 1,
  Spike = 2,
}

export type ObstacleRow = [
  ObstacleType,
  ObstacleType,
  ObstacleType,
  ObstacleType,
  ObstacleType,
];

export interface Song {
  title: string;
  artist: string;
  audioUrl: string;
  /** BPM is retained for background visuals only. It never determines event time. */
  bpm: number;
  durationSeconds: number;
}

export interface LevelEvent {
  timeSeconds: number;
  obstacles: ObstacleRow;
  strength?: number;
  source?: string;
}

export interface LevelGeneration {
  algorithm: string;
  noteCount: number;
  confidence?: number;
  [key: string]: unknown;
}

/**
 * Level v3 stores every row at its measured audio time. There is deliberately
 * no ticksPerBeat or beatOffset: gameplay events cannot be snapped to a grid.
 */
export interface Level {
  id: string;
  version: 3;
  song: Song;
  generation: LevelGeneration;
  events: LevelEvent[];
}

export type ObstacleState = 'pending' | 'hit' | 'miss';
export type ObstacleStateRow = [
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
  ObstacleState | null,
];

export interface GameResult {
  score: number;
  maxCombo: number;
  hits: number;
  total: number;
}
