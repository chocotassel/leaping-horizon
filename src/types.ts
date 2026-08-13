export type Lane = -2 | -1 | 0 | 1 | 2;
export type ObstacleType = 'normal' | 'spike';

export interface ChartNote {
  time: number;
  lane: Lane;
  type: ObstacleType;
}

export interface SongChart {
  title: string;
  artist: string;
  bpm: number;
  duration: number;
  notes: ChartNote[];
}

export type NoteState = 'pending' | 'hit' | 'miss';

export interface GameResult {
  score: number;
  maxCombo: number;
  hits: number;
  total: number;
}
