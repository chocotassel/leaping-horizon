export const PLAYER_Z = -2.4;
export const APPROACH_SECONDS = 2.5;
export const OBSTACLE_SPAWN_Z = -64;
export const MIN_RING_APPROACH_SECONDS = 2;

const HORIZONTAL_COLLISION_DISTANCE = (0.9 + 1) / 2;

export function getObstacleZ(secondsUntilBeat: number): number {
  const progress = 1 - secondsUntilBeat / APPROACH_SECONDS;
  return OBSTACLE_SPAWN_Z + progress * (Math.abs(OBSTACLE_SPAWN_Z) + PLAYER_Z);
}

export function overlapsPlayer(playerX: number, obstacleX: number): boolean {
  return Math.abs(playerX - obstacleX) < HORIZONTAL_COLLISION_DISTANCE;
}

export function shouldRenderObstacle(state: 'pending' | 'hit' | 'miss' | null): boolean {
  return state === 'pending' || state === 'miss';
}

export function getRingApproach(time: number, duration: number, lastObstacleTime: number | null): number {
  const start = Math.max(0, Math.min(lastObstacleTime ?? duration, duration - MIN_RING_APPROACH_SECONDS));
  const t = Math.min(1, Math.max(0, (time - start) / Math.max(Number.EPSILON, duration - start)));
  return t * t * (3 - 2 * t);
}
