export const PLAYER_Z = -2.4;
export const APPROACH_SECONDS = 2.5;
export const OBSTACLE_SPAWN_Z = -64;
export const RING_APPROACH_START = 0.85;

const COLLISION_DISTANCE = 1;

export function getObstacleZ(secondsUntilBeat: number): number {
  const progress = 1 - secondsUntilBeat / APPROACH_SECONDS;
  return OBSTACLE_SPAWN_Z + progress * (Math.abs(OBSTACLE_SPAWN_Z) + PLAYER_Z);
}

export function overlapsPlayer(playerX: number, obstacleX: number, secondsUntilBeat: number): boolean {
  return Math.abs(playerX - obstacleX) < COLLISION_DISTANCE
    && Math.abs(getObstacleZ(secondsUntilBeat) - PLAYER_Z) < COLLISION_DISTANCE;
}

export function hasPassedPlayer(secondsUntilBeat: number): boolean {
  return getObstacleZ(secondsUntilBeat) - PLAYER_Z >= COLLISION_DISTANCE;
}

export function getRingApproach(progress: number): number {
  const t = Math.min(1, Math.max(0, (progress - RING_APPROACH_START) / (1 - RING_APPROACH_START)));
  return t * t * (3 - 2 * t);
}
