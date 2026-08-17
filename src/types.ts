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
  strength?: number;
  source?: string;
  /** Choice Rows require a hit; Gate Rows require avoiding every Hazard Cell. */
  kind: 'target' | 'dodge';
  pattern?: string;
  /** Role inside the spatial motif; empty template slots are intentionally not stored. */
  role?: string;
  /** Index into generation.flowSections for inspection and validation. */
  section?: number;
  /** Local 0..1 attention/intensity target used by the music-flow planner. */
  flow?: number;
  /** Repeated musical phrase identity produced by the structure analyser. */
  familyId?: string;
  /** Concrete phrase occurrence in the song. */
  phraseId?: string;
  /** Canonical template shared by every ordinary occurrence of a phrase family. */
  templateId?: string;
  /** Stable location inside the canonical phrase template. */
  relativeSlotKey?: string;
  /** Structural template core or a clearly-labelled intensity overlay. */
  layer?: 'core' | 'auxiliary-common' | 'overlay';
  /** Absolute Beat This! bar index and relative bar inside the phrase. */
  barIndex?: number;
  barInPhrase?: number;
  /** True for the first stored cue of a musical bar. */
  downbeatCue?: boolean;
  /** Number of Target Cells offered by this row (zero for a Gate Row). */
  choiceLaneCount?: number;
  /** True when at least two displayed targets are valid full-combo decisions. */
  routeBranch?: boolean;
  /** Rule-generated Gate Row between two measured musical anchors. */
  densityFill?: boolean;
  densityMode?: 'solid' | 'compact';
  /** Per-row movement allowance for explicit full-width beat gestures. */
  travelSecondsPerLane?: number;
  sweepHazardMode?: 'clean' | 'spiked';
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

/**
 * Level v3 stores every row at its measured audio time. There is deliberately
 * no ticksPerBeat or beatOffset: gameplay events cannot be snapped to a grid.
 */
export interface Level {
  id: string;
  version: 3;
  song: Song;
  generation: LevelGeneration;
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
