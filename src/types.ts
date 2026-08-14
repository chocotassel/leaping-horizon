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
  bpm: number;
  beatOffsetSeconds: number;
  durationSeconds: number;
}

export interface Level {
  id: string;
  version: number;
  ticksPerBeat: number;
  song: Song;
  generation: {
    algorithm: string;
    confidence: number;
    noteCount: number;
    spikeCount: number;
    spikeRows: {
      single: number;
      double: number;
      triple: number;
    };
  };
  accents: Array<{
    label: string;
    tick: number;
    timeSeconds: number;
    intensity: number;
  }>;
  obstacles: ObstacleRow[];
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
