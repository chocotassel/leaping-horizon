import {
  ObstacleType,
  type LaneIndex,
  type Level,
  type ObstacleRow,
  type Song,
} from './types';

const song: Song = {
  title: 'STAR//DRIVE',
  artist: 'NEON SYSTEM',
  bpm: 156,
  durationSeconds: 40.5,
};

const patterns: LaneIndex[][] = [
  [0, 1, 2, 3, 4, 3, 2, 1],
  [2, 0, 3, 1, 4, 2, 1, 3],
  [4, 3, 2, 1, 0, 1, 2, 3],
  [1, 3, 0, 2, 4, 3, 1, 2],
  [2, 4, 1, 3, 0, 2, 4, 1],
];
const spikeLanes: LaneIndex[] = [4, 0, 3, 1, 2];

export function getSongBeatCount(value: Song): number {
  if (!Number.isFinite(value.bpm) || value.bpm <= 0) throw new Error('Song BPM must be greater than 0.');
  if (!Number.isFinite(value.durationSeconds) || value.durationSeconds <= 0) {
    throw new Error('Song duration must be greater than 0.');
  }
  return Math.ceil(value.durationSeconds * value.bpm / 60);
}

const emptyRow = (): ObstacleRow => [
  ObstacleType.Empty,
  ObstacleType.Empty,
  ObstacleType.Empty,
  ObstacleType.Empty,
  ObstacleType.Empty,
];

const obstacles = Array.from({ length: getSongBeatCount(song) }, emptyRow);
const firstObstacleBeat = 4;
for (let index = 0; index < 100; index += 1) {
  const beatIndex = firstObstacleBeat + index;
  const pattern = patterns[Math.floor(index / 8) % patterns.length];
  obstacles[beatIndex][pattern[index % 8]] = ObstacleType.Breakable;
}

// 地刺和同一拍的可击碎方块错开车道，玩家可以主动选择路线躲避。
for (let index = 9; index < 98; index += 9) {
  const beatIndex = firstObstacleBeat + index;
  let lane = spikeLanes[index % spikeLanes.length];
  if (obstacles[beatIndex][lane] !== ObstacleType.Empty) lane = lane === 4 ? 0 : (lane + 1) as LaneIndex;
  obstacles[beatIndex][lane] = ObstacleType.Spike;
}

export function validateLevel(level: Level): Level {
  const expectedBeats = getSongBeatCount(level.song);
  if (level.obstacles.length !== expectedBeats) {
    throw new Error(`Level requires ${expectedBeats} beat rows, received ${level.obstacles.length}.`);
  }
  level.obstacles.forEach((row, beatIndex) => {
    if (row.length !== 5) throw new Error(`Beat ${beatIndex} must contain exactly 5 lanes.`);
    row.forEach((cell, laneIndex) => {
      if (!Number.isInteger(cell) || cell < ObstacleType.Empty || cell > ObstacleType.Spike) {
        throw new Error(`Invalid obstacle at beat ${beatIndex}, lane ${laneIndex}.`);
      }
    });
  });
  return level;
}

export const DEMO_LEVEL = validateLevel({ song, obstacles });
