export interface SceneColorScheme {
  /** 道路光线、频谱竖线、背景装饰线、网格和玩家使用的全局主色。 */
  readonly primary: number;
  readonly obstacle: {
    readonly panelDark: number;
    readonly panelLight: number;
    readonly stripeDark: number;
    readonly stripeLight: number;
    readonly edge: number;
  };
  /** 地刺使用的反色或高亮中性色。 */
  readonly hazard: number;
  /** 圆环中央的三层实线，与频谱竖线分离。 */
  readonly ringCore: number;
}

export const SCENE_COLOR_SCHEMES = {
  amberCyan: {
    primary: 0xffa21a,
    obstacle: {
      panelDark: 0x15110e,
      panelLight: 0x3e3024,
      stripeDark: 0x8f5716,
      stripeLight: 0xffcf61,
      edge: 0xffa21a,
    },
    hazard: 0xffffff,
    ringCore: 0x35d8ff,
  },
  cyanMagenta: {
    primary: 0x24d8ff,
    obstacle: {
      panelDark: 0x0b1519,
      panelLight: 0x173c47,
      stripeDark: 0x0c6d82,
      stripeLight: 0x8bedff,
      edge: 0x24d8ff,
    },
    hazard: 0xff4f9a,
    ringCore: 0xff4f9a,
  },
  violetLime: {
    primary: 0x9164ff,
    obstacle: {
      panelDark: 0x120e1d,
      panelLight: 0x33265a,
      stripeDark: 0x4f328f,
      stripeLight: 0xc8b4ff,
      edge: 0x9164ff,
    },
    hazard: 0xe8ff66,
    ringCore: 0xe8ff66,
  },
  crimsonIce: {
    primary: 0xff4058,
    obstacle: {
      panelDark: 0x1b0b0f,
      panelLight: 0x4b1d27,
      stripeDark: 0x831c2d,
      stripeLight: 0xff9baa,
      edge: 0xff4058,
    },
    hazard: 0xffffff,
    ringCore: 0x65e7ff,
  },
} as const satisfies Record<string, SceneColorScheme>;

export type SceneColorSchemeId = keyof typeof SCENE_COLOR_SCHEMES;

export const DEFAULT_SCENE_COLOR_SCHEME_ID: SceneColorSchemeId = 'amberCyan';

