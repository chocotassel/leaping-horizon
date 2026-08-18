export function getBeatAuditionRange(
  startSeconds: number,
  bpm: number,
  durationSeconds: number,
): { startSeconds: number; endSeconds: number } {
  const start = Math.max(0, Math.min(startSeconds, durationSeconds));
  return {
    startSeconds: start,
    endSeconds: Math.min(start + 60 / bpm, durationSeconds),
  };
}
