export const PLAYER_Z = -2.4;
export const APPROACH_SECONDS = 5;
export const OBSTACLE_SPAWN_Z = -126;
export const RING_SPAWN_Z = -64;
export const OBSTACLE_DESPAWN_SECONDS = 0.6;
export const MIN_RING_APPROACH_SECONDS = 2;
/** Runtime hard cap; level generation deliberately reserves a larger movement margin. */
export const PLAYER_MAX_LATERAL_SPEED = 30;

const HORIZONTAL_COLLISION_DISTANCE = (0.9 + 1) / 2;
const HORIZONTAL_TARGET_COLLECTION_DISTANCE = 1.05;

export function getObstacleZ(secondsUntilBeat: number): number {
  const progress = 1 - secondsUntilBeat / APPROACH_SECONDS;
  return OBSTACLE_SPAWN_Z + progress * (Math.abs(OBSTACLE_SPAWN_Z) + PLAYER_Z);
}

export function overlapsPlayer(playerX: number, obstacleX: number): boolean {
  return Math.abs(playerX - obstacleX) < HORIZONTAL_COLLISION_DISTANCE;
}

export function overlapsCollectibleTarget(playerX: number, targetX: number): boolean {
  return Math.abs(playerX - targetX) < HORIZONTAL_TARGET_COLLECTION_DISTANCE;
}

export function moveTowards(current: number, target: number, maximumDelta: number): number {
  const delta = target - current;
  if (Math.abs(delta) <= maximumDelta) return target;
  return current + Math.sign(delta) * Math.max(0, maximumDelta);
}

export function shouldRenderObstacle(state: 'pending' | 'hit' | 'miss' | null): boolean {
  return state === 'pending' || state === 'miss';
}

export function findFirstVisibleEventIndex(
  events: readonly { timeSeconds: number }[],
  time: number,
): number {
  const earliestTime = time - OBSTACLE_DESPAWN_SECONDS;
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (events[middle].timeSeconds < earliestTime) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function getRingApproach(time: number, duration: number, lastObstacleTime: number | null): number {
  const start = Math.max(0, Math.min(lastObstacleTime ?? duration, duration - MIN_RING_APPROACH_SECONDS));
  const t = Math.min(1, Math.max(0, (time - start) / Math.max(Number.EPSILON, duration - start)));
  return t * t * (3 - 2 * t);
}
