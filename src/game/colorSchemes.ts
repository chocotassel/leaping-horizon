export interface SceneColorScheme {
  /** 玩家、道路、频谱、背景线与障碍物共享的主色。 */
  readonly primary: number;
  /** 主色的小幅偏色，用于道路细边、尾焰内芯与装饰线。 */
  readonly detail: number;
  /** 障碍物只使用一种基础色；表面明暗由中性纹理和光照产生。 */
  readonly obstacle: number;
  /** 地刺与圆环使用色环互补色或中性白。 */
  readonly hazard: number;
  readonly ringCore: number;
}

interface SceneColorHues {
  readonly primary: number;
  readonly accent: number | 'white';
}

/** 主色来自 HSV 色环；白色是减少杂色时允许的唯一中性色。 */
export const SCENE_COLOR_HUES = {
  redWhite: { primary: 0, accent: 'white' },
  redCyan: { primary: 0, accent: 180 },
  orangeAzure: { primary: 30, accent: 210 },
  yellowBlue: { primary: 60, accent: 240 },
  yellowWhite: { primary: 60, accent: 'white' },
  greenWhite: { primary: 120, accent: 'white' },
  cyanWhite: { primary: 180, accent: 'white' },
  cyanRed: { primary: 180, accent: 0 },
  azureOrange: { primary: 210, accent: 30 },
  blueWhite: { primary: 240, accent: 'white' },
  violetWhite: { primary: 270, accent: 'white' },
  magentaWhite: { primary: 300, accent: 'white' },
} as const satisfies Record<string, SceneColorHues>;

export type SceneColorSchemeId = keyof typeof SCENE_COLOR_HUES;

export const SCENE_COLOR_SATURATION = 0.84;
export const SCENE_COLOR_VALUE = 1;

function hsvColor(hue: number, saturation = SCENE_COLOR_SATURATION): number {
  const sector = ((hue % 360) + 360) % 360 / 60;
  const chroma = SCENE_COLOR_VALUE * saturation;
  const secondary = chroma * (1 - Math.abs(sector % 2 - 1));
  const match = SCENE_COLOR_VALUE - chroma;
  const [red, green, blue] = sector < 1 ? [chroma, secondary, 0]
    : sector < 2 ? [secondary, chroma, 0]
      : sector < 3 ? [0, chroma, secondary]
        : sector < 4 ? [0, secondary, chroma]
          : sector < 5 ? [secondary, 0, chroma]
            : [chroma, 0, secondary];
  return (
    Math.round((red + match) * 255) << 16
    | Math.round((green + match) * 255) << 8
    | Math.round((blue + match) * 255)
  );
}

function makeColorScheme(hues: SceneColorHues): SceneColorScheme {
  const primary = hsvColor(hues.primary);
  const detail = hsvColor(hues.primary + 20, SCENE_COLOR_SATURATION * 0.94);
  const accent = hues.accent === 'white' ? 0xffffff : hsvColor(hues.accent);
  return { primary, detail, obstacle: primary, hazard: accent, ringCore: accent };
}

export const SCENE_COLOR_SCHEMES = {
  redWhite: makeColorScheme(SCENE_COLOR_HUES.redWhite),
  redCyan: makeColorScheme(SCENE_COLOR_HUES.redCyan),
  orangeAzure: makeColorScheme(SCENE_COLOR_HUES.orangeAzure),
  yellowBlue: makeColorScheme(SCENE_COLOR_HUES.yellowBlue),
  yellowWhite: makeColorScheme(SCENE_COLOR_HUES.yellowWhite),
  greenWhite: makeColorScheme(SCENE_COLOR_HUES.greenWhite),
  cyanWhite: makeColorScheme(SCENE_COLOR_HUES.cyanWhite),
  cyanRed: makeColorScheme(SCENE_COLOR_HUES.cyanRed),
  azureOrange: makeColorScheme(SCENE_COLOR_HUES.azureOrange),
  blueWhite: makeColorScheme(SCENE_COLOR_HUES.blueWhite),
  violetWhite: makeColorScheme(SCENE_COLOR_HUES.violetWhite),
  magentaWhite: makeColorScheme(SCENE_COLOR_HUES.magentaWhite),
} as const satisfies Record<SceneColorSchemeId, SceneColorScheme>;

export const DEFAULT_SCENE_COLOR_SCHEME_ID: SceneColorSchemeId = 'cyanWhite';
