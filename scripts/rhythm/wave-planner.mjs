const EMPTY = 0;
const HAZARD = 2;
const LANE_COUNT = 5;
const DEPTH_CYCLE = [1, 2, 3, 2];

export function buildWaveRows({ length = 5, mirror = false } = {}) {
  if (!Number.isInteger(length) || length < 1) throw new Error('Wave length must be a positive integer.');

  return Array.from({ length }, (_, index) => {
    const depth = DEPTH_CYCLE[index % DEPTH_CYCLE.length];
    const row = Array.from({ length: LANE_COUNT }, () => EMPTY);
    for (let lane = 0; lane < depth; lane += 1) row[lane] = HAZARD;
    for (let lane = LANE_COUNT - (3 - depth); lane < LANE_COUNT; lane += 1) row[lane] = HAZARD;
    return mirror ? row.reverse() : row;
  });
}
