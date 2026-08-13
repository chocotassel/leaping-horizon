import type { ChartNote, Lane, SongChart } from './types';

const patterns: Lane[][] = [
  [-2, -1, 0, 1, 2, 1, 0, -1],
  [0, -2, 1, -1, 2, 0, -1, 1],
  [2, 1, 0, -1, -2, -1, 0, 1],
  [-1, 1, -2, 0, 2, 1, -1, 0],
  [0, 2, -1, 1, -2, 0, 2, -1],
];

const spikeOffset: Lane[] = [2, -2, 1, -1, 0];
const beat = 60 / 156;

const notes: ChartNote[] = Array.from({ length: 100 }, (_, index) => {
  const group = Math.floor(index / 8);
  return {
    time: 1.45 + index * beat,
    lane: patterns[group % patterns.length][index % 8],
    type: 'normal',
  };
});

// 尖刺和同一拍的可击碎方块错开车道，玩家可以主动选择路线躲避。
for (let index = 9; index < 98; index += 9) {
  const normalLane = notes[index].lane;
  let lane = spikeOffset[index % spikeOffset.length];
  if (lane === normalLane) lane = (lane === 2 ? -2 : (lane + 1)) as Lane;
  notes.push({ time: notes[index].time, lane, type: 'spike' });
}

notes.sort((a, b) => a.time - b.time || (a.type === 'spike' ? 1 : -1));

export const DEMO_CHART: SongChart = {
  title: 'STAR//DRIVE',
  artist: 'NEON SYSTEM',
  bpm: 156,
  duration: 40.5,
  notes,
};
