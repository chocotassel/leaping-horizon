export const GAME_LAUNCH_MAX_WAIT_MS = 15_000;

export class GameLaunchTimeoutError extends Error {
  constructor() {
    super('Game preparation timed out.');
    this.name = 'GameLaunchTimeoutError';
  }
}

type FrameScheduler = (callback: () => void) => void;

/** Give the launch transition one real paint before mounting expensive game work. */
export function afterNextPaint(
  callback: () => void,
  schedule: FrameScheduler = (next) => { requestAnimationFrame(next); },
): void {
  schedule(() => schedule(callback));
}

/** Wait for both the launch animation and the real game preparation, with a hard deadline. */
export function waitForGameLaunch(
  preparation: Promise<void>,
  minimumWaitMs: number,
  maximumWaitMs = GAME_LAUNCH_MAX_WAIT_MS,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const minimumWait = new Promise<void>((minimumResolved) => {
      setTimeout(minimumResolved, Math.max(0, minimumWaitMs));
    });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new GameLaunchTimeoutError());
    }, Math.max(0, maximumWaitMs));

    Promise.all([preparation, minimumWait]).then(() => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve();
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}
