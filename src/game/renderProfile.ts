export const DESIGN_ASPECT = 9 / 16;
const TALL_ASPECT = 9 / 21;

export type RenderTier = 'low' | 'balanced' | 'high';

export interface RenderProfile {
  tier: RenderTier;
  antialias: boolean;
  lowGeometry: boolean;
  maxPixelRatio: number;
  maxRenderPixels: number;
}

interface DeviceCapabilities {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  devicePixelRatio?: number;
  screenWidth?: number;
  screenHeight?: number;
}

export function selectRenderProfile(capabilities: DeviceCapabilities): RenderProfile {
  const cores = Number.isFinite(capabilities.hardwareConcurrency)
    && (capabilities.hardwareConcurrency ?? 0) > 0
    ? capabilities.hardwareConcurrency
    : undefined;
  const memory = Number.isFinite(capabilities.deviceMemory)
    && (capabilities.deviceMemory ?? 0) > 0
    ? capabilities.deviceMemory
    : undefined;
  const shortSide = Math.min(capabilities.screenWidth ?? 0, capabilities.screenHeight ?? 0);
  const longSide = Math.max(capabilities.screenWidth ?? 0, capabilities.screenHeight ?? 0);
  const proMaxClassDisplay = (capabilities.devicePixelRatio ?? 0) >= 3
    && shortSide >= 420
    && longSide >= 900;
  const tier: RenderTier = proMaxClassDisplay
    ? 'high'
    : memory !== undefined && memory <= 2
    || cores !== undefined && cores <= 4
      ? 'low'
      : cores !== undefined && cores >= 6 || memory !== undefined && memory >= 8
        ? 'high'
        : 'balanced';

  if (tier === 'low') return {
    tier,
    antialias: false,
    lowGeometry: true,
    maxPixelRatio: 1.25,
    maxRenderPixels: 1_000_000,
  };
  if (tier === 'high') return {
    tier,
    antialias: true,
    lowGeometry: false,
    maxPixelRatio: 3,
    maxRenderPixels: 4_000_000,
  };
  return {
    tier,
    antialias: true,
    lowGeometry: false,
    maxPixelRatio: 1.5,
    maxRenderPixels: 1_800_000,
  };
}

export function getRenderPixelRatio(
  profile: RenderProfile,
  width: number,
  height: number,
  devicePixelRatio: number,
  isWebGL2 = true,
): number {
  const nativeRatio = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0
    ? devicePixelRatio
    : 1;
  const cssPixels = Math.max(1, width * height);
  const budgetRatio = Math.sqrt(profile.maxRenderPixels / cssPixels);
  const contextRatio = isWebGL2 ? Number.POSITIVE_INFINITY : 1.5;
  return Math.max(0.75, Math.floor(
    Math.min(nativeRatio, profile.maxPixelRatio, budgetRatio, contextRatio) * 100,
  ) / 100);
}

export function getCameraZoom(aspect: number): number {
  if (!Number.isFinite(aspect) || aspect <= 0) return 1;
  return Math.min(1, aspect / DESIGN_ASPECT);
}

export function getGameplayViewport(aspect: number) {
  const tallness = Number.isFinite(aspect) && aspect > 0
    ? Math.max(0, Math.min(1, (DESIGN_ASPECT - aspect) / (DESIGN_ASPECT - TALL_ASPECT)))
    : 0;
  return {
    cameraTargetY: -6 * tallness,
    cameraZoom: getCameraZoom(aspect),
    playerBottomRatio: 0.32 + 0.1 * tallness,
    ringScale: 1 - 0.1 * tallness,
  };
}
