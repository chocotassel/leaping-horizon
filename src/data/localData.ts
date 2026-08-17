import { getAccuracyPercent } from '../game/stars';
import type { GameResult } from '../types';

type StorageLike = Pick<Storage, 'getItem' | 'setItem'>;

export class LocalDataManager<T> {
  constructor(
    private readonly key: string,
    private readonly fallback: T,
    private readonly isValid: (value: unknown) => value is T,
    private readonly storageOverride?: StorageLike,
  ) {}

  read(): T {
    try {
      const raw = this.storage()?.getItem(this.key);
      if (!raw) return this.fallback;
      const value: unknown = JSON.parse(raw);
      return this.isValid(value) ? value : this.fallback;
    } catch {
      return this.fallback;
    }
  }

  write(value: T): void {
    try {
      this.storage()?.setItem(this.key, JSON.stringify(value));
    } catch {
      // Storage may be unavailable in private browsing; the current session still works.
    }
  }

  private storage(): StorageLike | null {
    if (this.storageOverride) return this.storageOverride;
    if (typeof window === 'undefined') return null;
    return window.localStorage;
  }
}

export interface LevelData {
  stars: number;
  bestScore: number;
  bestAccuracy: number;
  bestCombo: number;
}

export interface GameData {
  levels: Record<string, LevelData>;
}

const EMPTY_GAME_DATA: GameData = { levels: {} };

function isLevelData(value: unknown): value is LevelData {
  if (!value || typeof value !== 'object') return false;
  const level = value as Partial<LevelData>;
  return Number.isInteger(level.stars) && level.stars! >= 0 && level.stars! <= 5
    && Number.isFinite(level.bestScore) && level.bestScore! >= 0
    && Number.isFinite(level.bestAccuracy) && level.bestAccuracy! >= 0 && level.bestAccuracy! <= 100
    && Number.isFinite(level.bestCombo) && level.bestCombo! >= 0;
}

function isGameData(value: unknown): value is GameData {
  if (!value || typeof value !== 'object') return false;
  const levels = (value as Partial<GameData>).levels;
  return Boolean(levels)
    && typeof levels === 'object'
    && !Array.isArray(levels)
    && Object.values(levels).every(isLevelData);
}

export const gameDataManager = new LocalDataManager(
  'leaping-horizon:level-data:v1',
  EMPTY_GAME_DATA,
  isGameData,
);

export function recordLevelResult(
  data: GameData,
  levelId: string,
  result: GameResult,
  stars: number,
): GameData {
  const previous = data.levels[levelId];
  return {
    levels: {
      ...data.levels,
      [levelId]: {
        stars: Math.max(previous?.stars ?? 0, stars),
        bestScore: Math.max(previous?.bestScore ?? 0, result.score),
        bestAccuracy: Math.max(previous?.bestAccuracy ?? 0, getAccuracyPercent(result)),
        bestCombo: Math.max(previous?.bestCombo ?? 0, result.maxCombo),
      },
    },
  };
}

export function isLevelUnlocked(
  levels: readonly { id: string }[],
  levelId: string,
  data: GameData,
): boolean {
  const index = levels.findIndex((level) => level.id === levelId);
  return index === 0 || (index > 0 && (data.levels[levels[index - 1].id]?.stars ?? 0) >= 1);
}
