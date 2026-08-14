import sliceAtTwoLevel from './levels/slice-at-two.level.json';
import { ObstacleType, type Level } from './types';

export function getLevelTickCount(level: Level): number {
  const { song } = level;
  if (!Number.isFinite(song.bpm) || song.bpm <= 0) throw new Error('Song BPM must be greater than 0.');
  if (!Number.isFinite(song.durationSeconds) || song.durationSeconds <= 0) {
    throw new Error('Song duration must be greater than 0.');
  }
  if (!Number.isFinite(song.beatOffsetSeconds) || song.beatOffsetSeconds < 0 || song.beatOffsetSeconds >= song.durationSeconds) {
    throw new Error('Song beat offset must be inside the song.');
  }
  if (!Number.isInteger(level.ticksPerBeat) || level.ticksPerBeat < 1 || level.ticksPerBeat > 4) {
    throw new Error('Level ticks per beat must be an integer from 1 to 4.');
  }
  return Math.ceil((song.durationSeconds - song.beatOffsetSeconds) * song.bpm * level.ticksPerBeat / 60);
}

export function validateLevel(level: Level): Level {
  const expectedTicks = getLevelTickCount(level);
  if (level.obstacles.length !== expectedTicks) {
    throw new Error(`Level requires ${expectedTicks} tick rows, received ${level.obstacles.length}.`);
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

export const DEMO_LEVEL = validateLevel(sliceAtTwoLevel as Level);
