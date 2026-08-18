import type { SceneColorSchemeId } from './game/colorSchemes';

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
  /** A row can expose several Target Cells; any one satisfies the Choice Row. */
  obstacles: ObstacleRow;
  /** Choice Rows score a hit; Gate Rows score a dodge. */
  kind: 'target' | 'dodge';
}

export interface LevelGeneration {
  algorithm: string;
  /** Number of Choice Rows, not the number of individual Target Cells. */
  noteCount: number;
  difficulty?: 'flow';
  confidence?: number;
  colorSchemeEventCount?: number;
  [key: string]: unknown;
}

export interface ColorSchemeEvent {
  timeSeconds: number;
  colorSchemeId: SceneColorSchemeId;
  kind: 'section' | 'accent';
  source: string;
  strength: number;
}

export interface RhythmPoint {
  id: string;
  timeSeconds: number;
  suggestedLane: LaneIndex;
  kind: 'attack' | 'beat' | 'downbeat';
  strength: number;
  pitchMidi?: number;
  sourceRole: string;
  hasBaseRow: boolean;
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
  rhythmPoints: RhythmPoint[];
  colorSchemeEvents: ColorSchemeEvent[];
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
  /** Number of satisfied Choice Rows; multi-target rows count once. */
  hits: number;
  /** Number of Choice Rows in the level; this is the accuracy denominator. */
  total: number;
  /** Multi-target Choice Rows where at least two Target Cells were collected. */
  doubleHitRows: number;
  totalMultiTargetRows: number;
  dodges: number;
  totalDodges: number;
}
