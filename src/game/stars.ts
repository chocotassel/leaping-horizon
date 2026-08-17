import type { GameResult } from '../types';

export const MAX_STARS = 5;

type StarResult = Pick<GameResult, 'hits' | 'total' | 'doubleHitRows' | 'totalMultiTargetRows'>;

const ratio = (value: number, target: number) => (
  target > 0 ? Math.min(1, Math.max(0, value / target)) : 1
);

export function getAccuracyPercent(result: Pick<GameResult, 'hits' | 'total'>): number {
  return result.total ? Math.round((result.hits / result.total) * 100) : 0;
}

export function getEarnedStars(result: StarResult, completed: boolean): number {
  if (!completed) return 0;
  if (result.total <= 0) return 1;
  if (result.hits < result.total * 0.7) return 1;
  if (result.hits < result.total * 0.9) return 2;
  if (result.hits < result.total) return 3;
  return result.doubleHitRows === result.totalMultiTargetRows ? 5 : 4;
}

export function getStarProgress(result: StarResult, levelProgress: number): number[] {
  const perfectHitProgress = ratio(result.hits, result.total);
  const doubleHitProgress = ratio(result.doubleHitRows, result.totalMultiTargetRows);
  return [
    Math.min(1, Math.max(0, levelProgress)),
    ratio(result.hits, result.total * 0.7),
    ratio(result.hits, result.total * 0.9),
    perfectHitProgress,
    Math.min(perfectHitProgress, doubleHitProgress),
  ];
}
