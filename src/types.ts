export const LANE_CENTERS = [-2, -1, 0, 1, 2] as const;
export type LaneIndex = 0 | 1 | 2 | 3 | 4;

export type DifficultyId = 'flow';

export interface DifficultyOption {
  id: DifficultyId;
  label: string;
  shortLabel: string;
  description: string;
}

export const DIFFICULTY_OPTIONS: readonly DifficultyOption[] = [
  { id: 'flow', label: '心流', shortLabel: 'FLOW', description: '全程保持操作，随音乐强度递进' },
];

export function isDifficultyId(value: unknown): value is DifficultyId {
  return DIFFICULTY_OPTIONS.some((option) => option.id === value);
}

export function getDifficultyOption(value: unknown): DifficultyOption {
  return DIFFICULTY_OPTIONS.find((option) => option.id === value) ?? DIFFICULTY_OPTIONS[0];
}

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
  kind?: 'target' | 'dodge';
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
}

export interface LevelGeneration {
  algorithm: string;
  noteCount: number;
  difficulty?: DifficultyId;
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
  dodges: number;
  totalDodges: number;
}
