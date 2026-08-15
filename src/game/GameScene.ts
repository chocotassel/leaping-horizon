import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { SVGLoader } from 'three/examples/jsm/loaders/SVGLoader.js';
import dartBladesSvg from '../assets/dart-blades.svg?raw';
import dartCornersSvg from '../assets/dart-corners.svg?raw';
import dartTriangleSvg from '../assets/dart-triangle.svg?raw';
import {
  LANE_CENTERS,
  ObstacleType,
  type LaneIndex,
  type Level,
  type ObstacleStateRow,
} from '../types';
import { getMaxEventRowsInWindow } from '../chart';
import {
  DEFAULT_SCENE_COLOR_SCHEME_ID,
  SCENE_COLOR_SCHEMES,
  type SceneColorScheme,
  type SceneColorSchemeId,
} from './colorSchemes';
import {
  APPROACH_SECONDS,
  getObstacleZ,
  getRingApproach,
  moveTowards,
  OBSTACLE_SPAWN_Z,
  PLAYER_MAX_LATERAL_SPEED,
  PLAYER_Z,
  shouldRenderObstacle,
} from './physics';

const NORMAL_PANEL_BANDS = 5;
const NORMAL_EDGES_PER_OBSTACLE = 12;
const SPIKES_PER_OBSTACLE = 5;
const HIT_PARTICLES_PER_BURST = 22;
const HIT_PARTICLE_LIFETIME_SECONDS = 0.72;
const MIN_PARTICLE_POOL_SIZE = 96;
const CAMERA_Y = 6.8;
const CAMERA_Z = 9.35;
const FLOATING_CUBE_COUNT = 64;
const FLOATING_CUBE_SPEED = 5.4;
// 穿过相机后再循环，避免仍在画面内时突然重置到远处。
const FLOATING_CUBE_NEAR_Z = CAMERA_Z + 2;
const OUTER_SPECTRUM_COUNT = 112;
const INNER_SPECTRUM_COUNT = 88;
const SPEED_STREAK_COUNT = 42;
const RING_CENTER_Y = 15;
const PLAYER_LIMIT_X = 2;
const PLAYER_IDLE_SPIN_SPEED = 1.5;
const PLAYER_HIT_SPIN_SPEED = 48;
const PLAYER_SPIN_RECOVERY = 4;
const TRAIL_SEGMENT_COUNT = 26;
const TRAIL_LENGTH = 9.8;
const TRAIL_HEAD_Z_OFFSET = 0.66;
const TRAIL_HEAD_Y_OFFSET = 0.06;
const TRAIL_SURFACE_Y = 0.025;
const DESIGN_ASPECT = 9 / 16;
const PLAYER_BOTTOM_RATIO = 0.32;
const NORMAL_EDGE_THICKNESS = 0.075;
const NORMAL_EDGE_LENGTH = 1.08;
const NORMAL_EDGE_TRANSFORMS = [
  [-0.5, 0, -0.5, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS],
  [-0.5, 0, 0.5, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS],
  [0.5, 0, -0.5, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS],
  [0.5, 0, 0.5, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS],
  [0, -0.5, -0.5, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS],
  [0, -0.5, 0.5, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS],
  [0, 0.5, -0.5, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS],
  [0, 0.5, 0.5, NORMAL_EDGE_LENGTH, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS],
  [-0.5, -0.5, 0, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH],
  [-0.5, 0.5, 0, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH],
  [0.5, -0.5, 0, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH],
  [0.5, 0.5, 0, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_THICKNESS, NORMAL_EDGE_LENGTH],
] as const;
const hiddenMatrix = new THREE.Matrix4().makeScale(0, 0, 0);

interface Particle {
  active: boolean;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  maxLife: number;
  sx: number;
  sy: number;
  sz: number;
  spinX: number;
  spinY: number;
}

interface FloatingCube {
  x: number;
  y: number;
  z: number;
  size: number;
  phase: number;
}

type SceneColorRole = 'primary' | 'ringCore' | 'hazard';

function getDecorativeMetalColor(index: number): number {
  return index % 5 === 0 ? 0x35271f : index % 3 === 0 ? 0x211b18 : 0x171514;
}

function colorToCss(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`;
}

function mixColors(from: number, to: number, amount: number): string {
  const mixChannel = (shift: number): number => Math.round(
    ((from >> shift) & 0xff) * (1 - amount) + ((to >> shift) & 0xff) * amount,
  );
  return `rgb(${mixChannel(16)}, ${mixChannel(8)}, ${mixChannel(0)})`;
}

export class GameScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(76, 1, 0.1, 900);
  private readonly player = new THREE.Group();
  private readonly rhythmRing = new THREE.Group();
  private readonly trailMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly trailHistory = new Float32Array(TRAIL_SEGMENT_COUNT);
  private readonly normalBlocks: THREE.InstancedMesh;
  private readonly normalEdges: THREE.InstancedMesh;
  private readonly spikeBases: THREE.InstancedMesh;
  private readonly spikeCones: THREE.InstancedMesh;
  private readonly particles: THREE.InstancedMesh;
  private readonly particleData: Particle[];
  private readonly outerSpectrumBars: THREE.InstancedMesh;
  private readonly innerSpectrumBars: THREE.InstancedMesh;
  private readonly floatingCubes: THREE.InstancedMesh;
  private readonly floatingData: FloatingCube[];
  private readonly speedStreaks: THREE.InstancedMesh;
  private readonly comboCanvas: HTMLCanvasElement;
  private readonly comboTexture: THREE.CanvasTexture;
  private readonly comboSprite: THREE.Sprite;
  private readonly missCanvas: HTMLCanvasElement;
  private readonly missTexture: THREE.CanvasTexture;
  private readonly missSprite: THREE.Sprite;
  private readonly clock = new THREE.Clock();
  private readonly matrix = new THREE.Matrix4();
  private readonly position = new THREE.Vector3();
  private readonly quaternion = new THREE.Quaternion();
  private readonly scale = new THREE.Vector3(1, 1, 1);
  private readonly tempColor = new THREE.Color();
  private readonly glowColor = new THREE.Color(SCENE_COLOR_SCHEMES[DEFAULT_SCENE_COLOR_SCHEME_ID].primary);
  private readonly ringCoreColor = new THREE.Color(SCENE_COLOR_SCHEMES[DEFAULT_SCENE_COLOR_SCHEME_ID].ringCore);
  private readonly hazardColor = new THREE.Color(SCENE_COLOR_SCHEMES[DEFAULT_SCENE_COLOR_SCHEME_ID].hazard);
  private readonly primaryChannels: THREE.Color[] = [];
  private readonly ringCoreChannels: THREE.Color[] = [];
  private readonly hazardChannels: THREE.Color[] = [];
  private readonly obstacleEdgeChannels: THREE.Color[] = [];
  private readonly hazardSurfaceChannels: THREE.Color[] = [];
  private readonly obstacleFrustum = new THREE.Frustum();
  private readonly obstacleBounds = new THREE.Sphere(new THREE.Vector3(), Math.sqrt(3) / 2);
  private readonly lastObstacleTime: number | null;
  private environmentTexture: THREE.Texture | null = null;
  private obstaclePanelTexture: THREE.CanvasTexture | null = null;
  private colorScheme: SceneColorScheme = SCENE_COLOR_SCHEMES[DEFAULT_SCENE_COLOR_SCHEME_ID];
  private colorSchemeId: SceneColorSchemeId = DEFAULT_SCENE_COLOR_SCHEME_ID;
  private playerX = 0;
  private targetPlayerX = 0;
  private playerVelocity = 0;
  private playerSpinSpeed = PLAYER_IDLE_SPIN_SPEED;
  private hitImpulse = 0;
  private feedbackCombo = -1;
  private comboImpactStart = -Infinity;
  private missImpactStart = -Infinity;
  private crashed = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement, level: Level) {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lowPower = (nav.deviceMemory ?? 4) <= 2 || (navigator.hardwareConcurrency ?? 4) <= 4;
    this.lastObstacleTime = level.events.length
      ? level.events[level.events.length - 1].timeSeconds
      : null;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: !lowPower,
      alpha: false,
      powerPreference: 'high-performance',
    });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, lowPower ? 0.9 : 1.25));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.02;
    this.scene.background = new THREE.Color(0x080706);
    this.scene.fog = new THREE.Fog(0x0d0a08, 105, 430);
    this.camera.position.set(0, CAMERA_Y, CAMERA_Z);
    this.camera.lookAt(0, 0, -14.9);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.environmentTexture;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0xf4f4f4, 0x100c0a, 1.6));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.4);
    keyLight.position.set(-4, 8, 7);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(this.glowColor, 2.8);
    this.primaryChannels.push(rimLight.color);
    rimLight.position.set(6, 3, -8);
    this.scene.add(rimLight);

    const environment = this.createEnvironment(lowPower);
    this.outerSpectrumBars = environment.outerSpectrumBars;
    this.innerSpectrumBars = environment.innerSpectrumBars;
    this.floatingCubes = environment.floatingCubes;
    this.floatingData = environment.floatingData;
    this.speedStreaks = environment.speedStreaks;
    this.trailMesh = this.createPlayer();

    const steelTexture = this.createSteelTexture();
    const obstaclePanelTexture = this.createObstaclePanelTexture();
    const obstaclePoolSize = Math.max(
      LANE_CENTERS.length,
      (getMaxEventRowsInWindow(level, APPROACH_SECONDS) + 2) * LANE_CENTERS.length,
    );
    const normalBlockMaterial = this.createMetalMaterial({
      color: 0xffffff,
      map: obstaclePanelTexture,
      emissiveMap: obstaclePanelTexture,
      metalness: 0.94,
      roughness: 0.3,
      emissiveIntensity: 0.58,
      envMapIntensity: 2.6,
    });
    this.normalBlocks = this.createInstances(
      new THREE.BoxGeometry(1, 1, 1),
      normalBlockMaterial,
      obstaclePoolSize,
    );
    const normalEdgeMaterial = this.createMetalMaterial({
      color: this.colorScheme.obstacle.edge,
      metalness: 1,
      roughness: 0.22,
      emissiveIntensity: 0.42,
      envMapIntensity: 3,
    });
    this.obstacleEdgeChannels.push(normalEdgeMaterial.color);
    this.normalEdges = this.createInstances(
      new THREE.BoxGeometry(1, 1, 1),
      normalEdgeMaterial,
      obstaclePoolSize * NORMAL_EDGES_PER_OBSTACLE,
    );

    const spikeBaseMaterial = this.createMetalMaterial({
      color: this.colorScheme.hazard,
      map: steelTexture,
      metalness: 0.98,
      roughness: 0.22,
      emissiveIntensity: 0.2,
      envMapIntensity: 2.5,
    }, 'hazard');
    this.hazardSurfaceChannels.push(spikeBaseMaterial.color);
    this.spikeBases = this.createInstances(
      new THREE.BoxGeometry(1, 0.08, 1),
      spikeBaseMaterial,
      obstaclePoolSize,
    );
    const spikeConeMaterial = this.createMetalMaterial({
      color: this.colorScheme.hazard,
      metalness: 0.98,
      roughness: 0.14,
      emissiveIntensity: 0.95,
    }, 'hazard');
    this.hazardSurfaceChannels.push(spikeConeMaterial.color);
    this.spikeCones = this.createInstances(
      new THREE.ConeGeometry(0.2, 0.9, 4),
      spikeConeMaterial,
      obstaclePoolSize * SPIKES_PER_OBSTACLE,
    );

    const particlePoolSize = Math.max(
      MIN_PARTICLE_POOL_SIZE,
      getMaxEventRowsInWindow(level, HIT_PARTICLE_LIFETIME_SECONDS) * HIT_PARTICLES_PER_BURST,
    );
    this.particles = this.createInstances(
      new THREE.BoxGeometry(0.24, 0.09, 0.2),
      this.createMetalMaterial({ metalness: 0.9, roughness: 0.25, emissiveIntensity: 0.8 }),
      particlePoolSize,
    );
    this.particleData = Array.from({ length: particlePoolSize }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      maxLife: 0,
      sx: 1,
      sy: 1,
      sz: 1,
      spinX: 0,
      spinY: 0,
    }));

    const comboFeedback = this.createFeedback(640, 480);
    this.comboCanvas = comboFeedback.canvas;
    this.comboTexture = comboFeedback.texture;
    this.comboSprite = comboFeedback.sprite;
    const missFeedback = this.createFeedback(512, 256);
    this.missCanvas = missFeedback.canvas;
    this.missTexture = missFeedback.texture;
    this.missSprite = missFeedback.sprite;
    this.drawCombo(0);
    this.drawMiss();
    this.missSprite.visible = false;
  }

  private createInstances(geometry: THREE.BufferGeometry, material: THREE.Material, count: number): THREE.InstancedMesh {
    const mesh = new THREE.InstancedMesh(geometry, material, count);
    mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < count; i += 1) mesh.setMatrixAt(i, hiddenMatrix);
    mesh.frustumCulled = false;
    this.scene.add(mesh);
    return mesh;
  }

  private getRoleColor(role: SceneColorRole): THREE.Color {
    if (role === 'ringCore') return this.ringCoreColor;
    if (role === 'hazard') return this.hazardColor;
    return this.glowColor;
  }

  private getRoleChannels(role: SceneColorRole): THREE.Color[] {
    if (role === 'ringCore') return this.ringCoreChannels;
    if (role === 'hazard') return this.hazardChannels;
    return this.primaryChannels;
  }

  private createGlowMaterial(
    parameters: THREE.MeshBasicMaterialParameters = {},
    role: SceneColorRole = 'primary',
  ): THREE.MeshBasicMaterial {
    const roleColor = this.getRoleColor(role);
    const material = new THREE.MeshBasicMaterial({
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      fog: false,
      toneMapped: false,
      ...parameters,
      color: roleColor,
    });
    this.getRoleChannels(role).push(material.color);
    return material;
  }

  private createMetalMaterial(
    parameters: THREE.MeshStandardMaterialParameters,
    role: SceneColorRole = 'primary',
  ): THREE.MeshStandardMaterial {
    const roleColor = this.getRoleColor(role);
    const material = new THREE.MeshStandardMaterial({
      color: 0x383838,
      metalness: 0.96,
      roughness: 0.2,
      ...parameters,
      emissive: roleColor,
    });
    this.getRoleChannels(role).push(material.emissive);
    return material;
  }

  private createGlowLineMaterial(
    parameters: THREE.LineBasicMaterialParameters = {},
    role: SceneColorRole = 'primary',
  ): THREE.LineBasicMaterial {
    const roleColor = this.getRoleColor(role);
    const material = new THREE.LineBasicMaterial({
      transparent: true,
      blending: THREE.AdditiveBlending,
      ...parameters,
      color: roleColor,
    });
    this.getRoleChannels(role).push(material.color);
    return material;
  }

  setColorScheme(colorSchemeId: SceneColorSchemeId): void {
    const scheme = SCENE_COLOR_SCHEMES[colorSchemeId];
    this.colorSchemeId = colorSchemeId;
    this.colorScheme = scheme;
    this.glowColor.set(scheme.primary);
    this.ringCoreColor.set(scheme.ringCore);
    this.hazardColor.set(scheme.hazard);
    this.primaryChannels.forEach((channel) => channel.copy(this.glowColor));
    this.ringCoreChannels.forEach((channel) => channel.copy(this.ringCoreColor));
    this.hazardChannels.forEach((channel) => channel.copy(this.hazardColor));
    this.obstacleEdgeChannels.forEach((channel) => channel.set(scheme.obstacle.edge));
    this.hazardSurfaceChannels.forEach((channel) => channel.set(scheme.hazard));
    if (this.obstaclePanelTexture) {
      this.paintObstaclePanelTexture(this.obstaclePanelTexture.image as HTMLCanvasElement, scheme);
      this.obstaclePanelTexture.needsUpdate = true;
    }
  }

  getColorSchemeId(): SceneColorSchemeId {
    return this.colorSchemeId;
  }

  private createFeedback(width: number, height: number): {
    canvas: HTMLCanvasElement;
    texture: THREE.CanvasTexture;
    sprite: THREE.Sprite;
  } {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({
      map: texture,
      transparent: true,
      depthTest: false,
      depthWrite: false,
      fog: false,
      toneMapped: false,
    }));
    sprite.position.set(0, RING_CENTER_Y, 0.8);
    sprite.renderOrder = 20;
    this.rhythmRing.add(sprite);
    return { canvas, texture, sprite };
  }

  private drawCombo(combo: number): void {
    const context = this.comboCanvas.getContext('2d')!;
    context.clearRect(0, 0, 640, 480);
    context.textAlign = 'center';
    context.textBaseline = 'top';
    context.fillStyle = '#ffffff';
    context.shadowColor = 'rgba(255,255,255,0.45)';
    context.shadowBlur = 8;
    context.font = "700 64px 'Arial Narrow', sans-serif";
    context.fillText('C O M B O', 320, 26);
    context.shadowColor = 'rgba(255,75,155,0.45)';
    context.shadowBlur = 18;
    context.font = "700 230px 'Arial Narrow', sans-serif";
    context.fillText(`× ${combo}`, 320, 112, 580);
    context.fillStyle = '#39c6ff';
    context.shadowColor = 'rgba(57,198,255,0.55)';
    context.shadowBlur = 8;
    context.font = "700 52px 'Arial Narrow', sans-serif";
    context.fillText(`S C O R E  ×${Math.min(15, Math.max(1, Math.floor(combo / 8) + 1))}`, 320, 404);
    this.feedbackCombo = combo;
    this.comboTexture.needsUpdate = true;
  }

  private drawMiss(): void {
    const context = this.missCanvas.getContext('2d')!;
    context.clearRect(0, 0, 512, 256);
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillStyle = '#ff4b9b';
    context.shadowColor = '#ff4b9b';
    context.shadowBlur = 20;
    context.font = "italic 700 130px 'Arial Narrow', sans-serif";
    context.fillText('M I S S', 256, 128);
    this.missTexture.needsUpdate = true;
  }

  flashMiss(time: number): void {
    this.missImpactStart = time;
  }

  private updateFeedback(time: number, combo: number): void {
    const missProgress = (time - this.missImpactStart) / 0.26;
    this.missSprite.visible = missProgress >= 0 && missProgress < 1;
    this.comboSprite.visible = !this.missSprite.visible;
    if (missProgress >= 0 && missProgress < 1) {
      const eased = 1 - Math.pow(1 - missProgress, 3);
      const impact = THREE.MathUtils.lerp(0.55, 1.3, eased);
      this.missSprite.scale.set(12 * impact, 6 * impact, 1);
      this.missSprite.material.opacity = missProgress < 0.35
        ? THREE.MathUtils.lerp(0.2, 1, missProgress / 0.35)
        : (1 - missProgress) / 0.65;
      return;
    }

    if (combo !== this.feedbackCombo) {
      if (combo > this.feedbackCombo && combo > 0) this.comboImpactStart = time;
      this.drawCombo(combo);
    }
    const comboProgress = THREE.MathUtils.clamp((time - this.comboImpactStart) / 0.22, 0, 1);
    const impact = THREE.MathUtils.lerp(0.62, 1, 1 - Math.pow(1 - comboProgress, 3));
    this.comboSprite.scale.set(14 * impact, 10.5 * impact, 1);
    this.comboSprite.material.opacity = 1;
  }

  private createSteelTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 128;
    canvas.height = 128;
    const context = canvas.getContext('2d')!;
    const gradient = context.createLinearGradient(0, 0, 128, 0);
    gradient.addColorStop(0, '#25383e');
    gradient.addColorStop(0.18, '#a5bbc0');
    gradient.addColorStop(0.42, '#41555b');
    gradient.addColorStop(0.68, '#d1e0e2');
    gradient.addColorStop(1, '#33474e');
    context.fillStyle = gradient;
    context.fillRect(0, 0, 128, 128);
    for (let y = 0; y < 128; y += 2) {
      const brightness = 80 + ((y * 37) % 70);
      context.fillStyle = `rgba(${brightness},${brightness + 15},${brightness + 18},0.18)`;
      context.fillRect(0, y, 128, 1);
    }
    // 细密斜向加工纹路，随着模型表面重复。
    context.strokeStyle = 'rgba(6,24,29,0.4)';
    context.lineWidth = 3;
    for (let x = -128; x < 256; x += 22) {
      context.beginPath();
      context.moveTo(x, 128);
      context.lineTo(x + 128, 0);
      context.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(1.4, 1.4);
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    return texture;
  }

  private createObstaclePanelTexture(): THREE.CanvasTexture {
    const canvas = document.createElement('canvas');
    canvas.width = 256;
    canvas.height = 256;
    this.paintObstaclePanelTexture(canvas, this.colorScheme);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.magFilter = THREE.LinearFilter;
    texture.generateMipmaps = true;
    texture.anisotropy = Math.min(4, this.renderer.capabilities.getMaxAnisotropy());
    this.obstaclePanelTexture = texture;
    return texture;
  }

  private paintObstaclePanelTexture(canvas: HTMLCanvasElement, scheme: SceneColorScheme): void {
    const context = canvas.getContext('2d')!;

    const base = context.createLinearGradient(0, 0, 256, 0);
    base.addColorStop(0, colorToCss(scheme.obstacle.panelDark));
    base.addColorStop(0.28, colorToCss(scheme.obstacle.panelLight));
    base.addColorStop(0.52, mixColors(scheme.obstacle.panelDark, scheme.obstacle.panelLight, 0.3));
    base.addColorStop(0.78, mixColors(scheme.obstacle.panelLight, 0xffffff, 0.08));
    base.addColorStop(1, colorToCss(scheme.obstacle.panelDark));
    context.fillStyle = base;
    context.fillRect(0, 0, 256, 256);

    // 深浅条纹交替，切换配色时直接重绘 CanvasTexture。
    for (let stripe = 0; stripe < NORMAL_PANEL_BANDS; stripe += 1) {
      const y = 18 + stripe * 48;
      const stripeColor = stripe % 2 === 0
        ? scheme.obstacle.stripeLight
        : scheme.obstacle.stripeDark;
      const band = context.createLinearGradient(0, y, 0, y + 30);
      band.addColorStop(0, mixColors(stripeColor, scheme.obstacle.panelDark, 0.38));
      band.addColorStop(0.18, mixColors(stripeColor, 0xffffff, 0.14));
      band.addColorStop(0.52, colorToCss(stripeColor));
      band.addColorStop(0.84, mixColors(stripeColor, scheme.obstacle.panelDark, 0.24));
      band.addColorStop(1, mixColors(stripeColor, 0xffffff, 0.08));
      context.fillStyle = band;
      context.fillRect(9, y, 238, 30);
    }
  }

  private createPerspectiveRoad(): void {
    const roadLength = 1500;
    const visualRoadWidth = 5.8;
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(visualRoadWidth, roadLength),
      new THREE.MeshBasicMaterial({ color: 0x080504, side: THREE.DoubleSide }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, -0.075, 10 - roadLength / 2);
    this.scene.add(road);

    // 世界空间中严格平行、全程等宽，只通过透视投影自然汇聚。
    for (const side of [-1, 1]) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.48, roadLength),
        this.createGlowMaterial({
          transparent: true,
          opacity: 0.28,
          side: THREE.DoubleSide,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
          toneMapped: false,
        }),
      );
      glow.rotation.x = -Math.PI / 2;
      glow.position.set(side * visualRoadWidth / 2, -0.035, 10 - roadLength / 2);
      this.scene.add(glow);

      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(0.065, 0.04, roadLength),
        this.createGlowMaterial(),
      );
      edge.position.set(side * visualRoadWidth / 2, 0, 10 - roadLength / 2);
      this.scene.add(edge);
    }
  }

  private createEnvironment(lowPower: boolean): {
    outerSpectrumBars: THREE.InstancedMesh;
    innerSpectrumBars: THREE.InstancedMesh;
    floatingCubes: THREE.InstancedMesh;
    floatingData: FloatingCube[];
    speedStreaks: THREE.InstancedMesh;
  } {
    this.createBackgroundGrid();

    this.createPerspectiveRoad();
    this.rhythmRing.position.z = OBSTACLE_SPAWN_Z;
    this.scene.add(this.rhythmRing);

    const circleCenterY = RING_CENTER_Y;
    // 多层主环与频谱环对应参考图中的终点门。
    const ringLayers = [
      { radius: 14, tube: 0.11, z: -0.3, opacity: 0.9 },
      { radius: 12.95, tube: 0.28, z: 0, opacity: 1 },
      { radius: 12.04, tube: 0.1, z: 0.3, opacity: 1 },
    ];
    ringLayers.forEach((layer) => {
      const ringMaterial = this.createGlowMaterial({
        transparent: false,
        depthTest: false,
        opacity: layer.opacity,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }, 'ringCore');
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(layer.radius, layer.tube, lowPower ? 6 : 10, lowPower ? 64 : 96),
        ringMaterial,
      );
      ring.position.set(0, circleCenterY, layer.z);
      ring.renderOrder = -10;
      this.rhythmRing.add(ring);
    });

    const outerSpectrumBars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.12, 1, 0.11),
      this.createGlowMaterial({ transparent: false, depthTest: false }),
      OUTER_SPECTRUM_COUNT,
    );
    outerSpectrumBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    outerSpectrumBars.frustumCulled = false;
    outerSpectrumBars.renderOrder = -10;
    this.rhythmRing.add(outerSpectrumBars);

    const innerSpectrumBars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.065, 1, 0.1),
      this.createGlowMaterial({ transparent: false, depthTest: false }),
      INNER_SPECTRUM_COUNT,
    );
    innerSpectrumBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    innerSpectrumBars.frustumCulled = false;
    innerSpectrumBars.renderOrder = -10;
    this.rhythmRing.add(innerSpectrumBars);

    const floatingData = Array.from({ length: FLOATING_CUBE_COUNT }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const pairIndex = Math.floor(index / 2);
      const heightSeed = ((pairIndex * 11 + (side > 0 ? 7 : 0)) % 31) / 30;
      const heightRatio = Math.pow(heightSeed, 2.6);
      const verticalJitter = ((((pairIndex + (side > 0 ? 7 : 0)) * 13) % 11) / 10 - 0.5)
        * THREE.MathUtils.lerp(0.5, 1.1, heightRatio);
      const horizontalJitter = ((pairIndex * 17 + (side > 0 ? 5 : 0)) % 13) / 12;
      const depthRatio = (pairIndex * 0.61803398875 + (side > 0 ? 0.31 : 0)) % 1;
      const randomSize = ((index * 29) % 17) / 16;
      const lateralMin = THREE.MathUtils.lerp(3.7, 11.5, heightRatio);
      const lateralMax = THREE.MathUtils.lerp(9.5, 18, heightRatio);
      const heightScale = THREE.MathUtils.lerp(1, 0.68, heightRatio);
      return {
        // 世界空间中的道路两侧景物：固定横向/高度，靠纵深移动产生向后掠过的视差。
        x: side * THREE.MathUtils.lerp(lateralMin, lateralMax, horizontalJitter),
        y: Math.max(0.35, THREE.MathUtils.lerp(0.5, 17, heightRatio) + verticalJitter),
        z: THREE.MathUtils.lerp(OBSTACLE_SPAWN_Z, FLOATING_CUBE_NEAR_Z, depthRatio),
        size: (0.34 + randomSize * 0.74) * heightScale,
        phase: index * 0.73,
      };
    });
    const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const floatingMaterial = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      metalness: 0.96,
      roughness: 0.24,
      envMapIntensity: 2.2,
    });
    const floatingCubes = new THREE.InstancedMesh(
      cubeGeometry,
      floatingMaterial,
      FLOATING_CUBE_COUNT,
    );
    floatingCubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    floatingCubes.frustumCulled = false;
    // 圆环禁用深度测试，因此装饰方块需要在圆环之后绘制才能处于其上层。
    floatingCubes.renderOrder = -5;
    this.scene.add(floatingCubes);

    const speedStreaks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.025, 0.025, 3.8),
      this.createGlowMaterial({
        transparent: true,
        opacity: 0.7,
        fog: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
      SPEED_STREAK_COUNT,
    );
    speedStreaks.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    speedStreaks.frustumCulled = false;
    this.scene.add(speedStreaks);

    return { outerSpectrumBars, innerSpectrumBars, floatingCubes, floatingData, speedStreaks };
  }

  private createBackgroundGrid(): void {
    const gridBottomY = 3;
    const gridTopY = 112;
    const gridStep = 11.2;
    const gridFadeEndY = 36;
    const vertices: number[] = [];
    const colors: number[] = [];
    const addVertex = (x: number, y: number): void => {
      const fade = THREE.MathUtils.smoothstep(y, gridBottomY, gridFadeEndY);
      vertices.push(x, y, -120);
      colors.push(fade, fade, fade);
    };

    // 纵线拆成小段，才能让底部透明度沿高度平滑插值到 0。
    for (let x = -56; x <= 56; x += gridStep) {
      for (let y = gridBottomY; y < gridTopY; y += gridStep) {
        addVertex(x, y);
        addVertex(x, Math.min(y + gridStep, gridTopY));
      }
    }
    for (let y = gridBottomY; y <= gridTopY; y += gridStep) {
      addVertex(-56, y);
      addVertex(56, y);
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
    const grid = new THREE.LineSegments(
      geometry,
      this.createGlowLineMaterial({
        transparent: true,
        opacity: 0.16,
        vertexColors: true,
        fog: false,
        depthWrite: false,
      }),
    );
    grid.renderOrder = -20;
    this.camera.add(grid);
    this.scene.add(this.camera);

    const accentVertices = [
      -48, 44, -119, -38, 52, -119, -38, 52, -119, -29, 46, -119,
      32, 29, -119, 41, 38, -119, 41, 38, -119, 50, 32, -119,
      -46, 24, -119, -39, 20, -119, -39, 20, -119, -32, 29, -119,
    ];
    const accentGeometry = new THREE.BufferGeometry();
    accentGeometry.setAttribute('position', new THREE.Float32BufferAttribute(accentVertices, 3));
    this.camera.add(new THREE.LineSegments(
      accentGeometry,
      this.createGlowLineMaterial({ fog: false }),
    ));
  }

  private createPlayer(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const coreMaterial = this.createGlowMaterial({ opacity: 1, side: THREE.DoubleSide });
    const glowMaterial = this.createGlowMaterial({ opacity: 0.35, side: THREE.DoubleSide });
    const createSvgLayer = (
      svg: string,
      height: number,
      size = 1,
      rotation = 0,
    ): THREE.Group => {
      const content = new THREE.Group();
      const addGeometry = (geometry: THREE.BufferGeometry): void => {
        content.add(new THREE.Mesh(geometry, glowMaterial), new THREE.Mesh(geometry, coreMaterial));
      };
      for (const path of new SVGLoader().parse(svg).paths) {
        const style = path.userData.style as Parameters<typeof SVGLoader.pointsToStroke>[1] & {
          fill?: string;
          stroke?: string;
        };
        if (style.fill && style.fill !== 'none') addGeometry(new THREE.ShapeGeometry(path.toShapes()));
        if (style.stroke && style.stroke !== 'none') {
          path.subPaths.forEach((subPath) => addGeometry(SVGLoader.pointsToStroke(subPath.getPoints(), style)));
        }
      }
      content.position.set(-256, -256, 0);
      const layer = new THREE.Group();
      layer.position.z = height;
      layer.rotation.z = rotation;
      layer.scale.setScalar(size);
      layer.add(content);
      return layer;
    };
    const playerArt = new THREE.Group();
    playerArt.add(
      createSvgLayer(dartCornersSvg, 0, 0.68, Math.PI / 3),
      createSvgLayer(dartTriangleSvg, 16, 0.82, Math.PI / 6),
      createSvgLayer(dartTriangleSvg, 32, 0.82, Math.PI / 2),
      createSvgLayer(dartBladesSvg, 48),
    );
    playerArt.scale.setScalar(1 / 512);
    playerArt.rotation.x = -Math.PI / 2;
    this.player.add(playerArt);
    const playerLight = new THREE.PointLight(0x48f8ff, 18, 8, 2);
    playerLight.color.copy(this.glowColor);
    this.primaryChannels.push(playerLight.color);
    playerLight.position.y = 0.7;
    this.player.add(playerLight);
    const playerSize = new THREE.Box3().setFromObject(this.player).getSize(new THREE.Vector3());
    const thicknessScale = 1 / Math.max(playerSize.x, playerSize.z);
    this.player.scale.set(1 / playerSize.x, thicknessScale, 1 / playerSize.z);
    this.player.position.set(0, 0.32, PLAYER_Z);
    this.scene.add(this.player);

    const trailSegments = this.trailHistory.length;
    // 四列顶点构成柔光边缘 + 高亮内芯，比单色三角片更像连续的能量尾焰。
    const verticesPerSegment = 4;
    const positions = new Float32Array(trailSegments * verticesPerSegment * 3);
    const colors = new Float32Array(trailSegments * verticesPerSegment * 3);
    const indices: number[] = [];
    for (let segment = 0; segment < trailSegments - 1; segment += 1) {
      const current = segment * verticesPerSegment;
      const next = current + verticesPerSegment;
      for (let band = 0; band < verticesPerSegment - 1; band += 1) {
        indices.push(
          current + band,
          next + band,
          current + band + 1,
          current + band + 1,
          next + band,
          next + band + 1,
        );
      }
    }
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    trailGeometry.setIndex(indices);
    const trailMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.94,
      side: THREE.DoubleSide,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
      toneMapped: false,
    });
    const trailMesh = new THREE.Mesh(trailGeometry, trailMaterial);
    trailMesh.frustumCulled = false;
    this.scene.add(trailMesh);
    return trailMesh;
  }

  resize(width: number, height: number): void {
    if (!width || !height) return;
    this.camera.clearViewOffset();
    this.camera.aspect = width / height;
    this.camera.zoom = Math.max(1, DESIGN_ASPECT / this.camera.aspect);
    this.camera.updateProjectionMatrix();
    this.camera.updateMatrixWorld();
    const playerNdcY = this.position.set(0, 0.32, PLAYER_Z).project(this.camera).y;
    const targetNdcY = PLAYER_BOTTOM_RATIO * 2 - 1;
    this.camera.setViewOffset(width, height, 0, (targetNdcY - playerNdcY) * height / 2, width, height);
    this.renderer.setSize(width, height, false);
  }

  movePlayerNormalized(normalizedDeltaX: number): void {
    this.targetPlayerX = THREE.MathUtils.clamp(
      this.targetPlayerX + normalizedDeltaX * PLAYER_LIMIT_X,
      -PLAYER_LIMIT_X,
      PLAYER_LIMIT_X,
    );
  }

  getPlayerX(): number {
    return this.playerX;
  }

  render(time: number, level: Level, states: ObstacleStateRow[], combo: number, spectrum: Uint8Array): void {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.crashed) {
      const oldX = this.playerX;
      this.playerX = moveTowards(this.playerX, this.targetPlayerX, PLAYER_MAX_LATERAL_SPEED * dt);
      this.playerVelocity = (this.playerX - oldX) / Math.max(dt, 0.001);
      this.player.position.x = this.playerX;
      this.player.position.y = 0.32 + Math.sin(time * 8) * 0.025;
      this.player.rotation.z = THREE.MathUtils.clamp(-this.playerVelocity * 0.013, -0.16, 0.16);
      this.player.rotation.y -= dt * this.playerSpinSpeed;
      this.playerSpinSpeed = THREE.MathUtils.lerp(
        this.playerSpinSpeed,
        PLAYER_IDLE_SPIN_SPEED,
        Math.min(1, dt * PLAYER_SPIN_RECOVERY),
      );
      this.updateTrail();
    }

    this.updateFeedback(time, combo);
    this.updateFloatingCubes(time);
    this.updateSpeedStreaks(time);
    this.updateObstacles(time, level, states);
    this.updateParticles(dt);
    this.hitImpulse *= Math.pow(0.015, dt);
    const cameraJitter = this.hitImpulse * Math.sin(time * 115);
    this.camera.position.x += (this.playerX * 0.06 + cameraJitter - this.camera.position.x) * Math.min(1, dt * 11);
    this.camera.position.y = CAMERA_Y + cameraJitter * 0.28;
    this.updateSpectrum(time, combo, level.song.durationSeconds, level.song.bpm, spectrum);
    this.renderer.render(this.scene, this.camera);
  }

  private updateTrail(): void {
    for (let i = this.trailHistory.length - 1; i > 0; i -= 1) {
      this.trailHistory[i] += (this.trailHistory[i - 1] - this.trailHistory[i]) * 0.5;
    }
    this.trailHistory[0] = this.playerX;
    const positions = this.trailMesh.geometry.getAttribute('position') as THREE.BufferAttribute;
    const colors = this.trailMesh.geometry.getAttribute('color') as THREE.BufferAttribute;
    for (let segment = 0; segment < this.trailHistory.length; segment += 1) {
      const progress = segment / (this.trailHistory.length - 1);
      const centerX = this.trailHistory[segment];
      const widthProgress = 1 - Math.pow(1 - progress, 1.45);
      const outerWidth = THREE.MathUtils.lerp(0.035, 0.78, widthProgress);
      const coreWidth = outerWidth * THREE.MathUtils.lerp(0.42, 0.18, progress);
      const settle = THREE.MathUtils.smoothstep(progress, 0, 0.28);
      const y = THREE.MathUtils.lerp(
        this.player.position.y + TRAIL_HEAD_Y_OFFSET,
        TRAIL_SURFACE_Y,
        settle,
      );
      const z = PLAYER_Z + TRAIL_HEAD_Z_OFFSET + progress * TRAIL_LENGTH;
      const intensity = Math.pow(1 - progress, 1.22);
      const vertex = segment * 4;

      positions.setXYZ(vertex, centerX - outerWidth, y, z);
      positions.setXYZ(vertex + 1, centerX - coreWidth, y + 0.003, z);
      positions.setXYZ(vertex + 2, centerX + coreWidth, y + 0.003, z);
      positions.setXYZ(vertex + 3, centerX + outerWidth, y, z);

      const edgeIntensity = intensity * 0.2;
      const coreIntensity = intensity * THREE.MathUtils.lerp(1.9, 0.75, progress);
      colors.setXYZ(
        vertex,
        this.glowColor.r * edgeIntensity,
        this.glowColor.g * edgeIntensity,
        this.glowColor.b * edgeIntensity,
      );
      colors.setXYZ(
        vertex + 1,
        this.glowColor.r * coreIntensity,
        this.glowColor.g * coreIntensity,
        this.glowColor.b * coreIntensity,
      );
      colors.setXYZ(
        vertex + 2,
        this.glowColor.r * coreIntensity,
        this.glowColor.g * coreIntensity,
        this.glowColor.b * coreIntensity,
      );
      colors.setXYZ(
        vertex + 3,
        this.glowColor.r * edgeIntensity,
        this.glowColor.g * edgeIntensity,
        this.glowColor.b * edgeIntensity,
      );
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
  }

  private updateSpectrum(time: number, combo: number, duration: number, bpm: number, spectrum: Uint8Array): void {
    const approach = getRingApproach(time, duration, this.lastObstacleTime);
    this.rhythmRing.position.set(
      THREE.MathUtils.lerp(0, this.camera.position.x, approach),
      THREE.MathUtils.lerp(0, this.camera.position.y - RING_CENTER_Y, approach),
      THREE.MathUtils.lerp(OBSTACLE_SPAWN_Z, CAMERA_Z + 2, approach),
    );
    const beat = 60 / bpm;
    const beatPhase = (time % beat) / beat;
    const beatKick = Math.exp(-beatPhase * 6.5);
    const comboBoost = Math.min(0.4, combo * 0.006);
    const maxBin = Math.min(55, spectrum.length - 2);
    let averageEnergy = 0;
    for (let bin = 2; bin <= maxBin; bin += 1) averageEnergy += spectrum[bin] / 255;
    averageEnergy /= maxBin - 1;
    for (let i = 0; i < OUTER_SPECTRUM_COUNT; i += 1) {
      const position = i / OUTER_SPECTRUM_COUNT;
      const angle = position * Math.PI * 2;
      const frequencyPosition = Math.abs(Math.sin(angle));
      const bin = 2 + Math.floor(frequencyPosition * (maxBin - 2));
      const energy = (
        spectrum[bin - 2] + spectrum[bin - 1] * 2 + spectrum[bin] * 3
        + spectrum[bin + 1] * 2 + spectrum[bin + 2]
      ) / (255 * 9);
      const response = Math.pow(Math.max(0, energy - averageEnergy - 0.035), 0.72);
      const variation = 1 + Math.sin(angle * 3 + time * 0.16) * 0.035 + Math.sin(angle * 7 - 1.1) * 0.022;
      const length = (1.05 + response * (3.3 + beatKick * 0.55) + comboBoost * 0.35) * variation;
      const radius = 14.7 + length * 0.5;
      this.position.set(Math.cos(angle) * radius, RING_CENTER_Y + Math.sin(angle) * radius, 0.15);
      this.quaternion.setFromEuler(new THREE.Euler(0, 0, angle - Math.PI / 2));
      this.scale.set(2.5, length, 2);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.outerSpectrumBars.setMatrixAt(i, this.matrix);
    }
    this.outerSpectrumBars.instanceMatrix.needsUpdate = true;
    if (this.outerSpectrumBars.instanceColor) this.outerSpectrumBars.instanceColor.needsUpdate = true;

    // 内圈略靠近镜头，避免频谱竖条被主环完全遮住。
    for (let i = 0; i < INNER_SPECTRUM_COUNT; i += 1) {
      const position = i / INNER_SPECTRUM_COUNT;
      const angle = position * Math.PI * 2;
      const frequencyPosition = Math.abs(Math.sin(angle));
      const bin = 2 + Math.floor(frequencyPosition * (maxBin - 2));
      const energy = (
        spectrum[bin - 2] + spectrum[bin - 1] * 2 + spectrum[bin] * 3
        + spectrum[bin + 1] * 2 + spectrum[bin + 2]
      ) / (255 * 9);
      const response = Math.pow(Math.max(0, energy - averageEnergy - 0.035), 0.78);
      const variation = 1 + Math.sin(angle * 3 + time * 0.16 + 0.7) * 0.025 + Math.sin(angle * 5 + 0.4) * 0.018;
      const length = (0.48 + response * 1.15 + comboBoost * 0.16) * variation;
      const radius = 11.3 - length * 0.5;
      this.position.set(Math.cos(angle) * radius, RING_CENTER_Y + Math.sin(angle) * radius, 0.75);
      this.quaternion.setFromEuler(new THREE.Euler(0, 0, angle - Math.PI / 2));
      this.scale.set(2.2, length, 1.8);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.innerSpectrumBars.setMatrixAt(i, this.matrix);
    }
    this.innerSpectrumBars.instanceMatrix.needsUpdate = true;
    if (this.innerSpectrumBars.instanceColor) this.innerSpectrumBars.instanceColor.needsUpdate = true;
  }

  private updateFloatingCubes(time: number): void {
    const nearZ = FLOATING_CUBE_NEAR_Z;
    const farZ = OBSTACLE_SPAWN_Z;
    const travelDistance = nearZ - farZ;
    for (let i = 0; i < this.floatingData.length; i += 1) {
      const cube = this.floatingData[i];
      const z = farZ + ((time * FLOATING_CUBE_SPEED + cube.z - farZ) % travelDistance);
      const depthProgress = (z - farZ) / travelDistance;
      const emergence = THREE.MathUtils.smoothstep(depthProgress, 0.08, 0.34);
      this.position.set(
        cube.x + Math.sin(time * 0.38 + cube.phase) * 0.16,
        Math.max(0.25, cube.y + Math.sin(time * 0.55 + cube.phase) * 0.18),
        z,
      );
      this.quaternion.setFromEuler(new THREE.Euler(time * 0.18 + cube.phase, time * 0.24 + cube.phase * 0.7, cube.phase));
      this.scale.setScalar(cube.size * emergence);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.floatingCubes.setMatrixAt(i, this.matrix);
      this.floatingCubes.setColorAt(i, this.tempColor.setHex(getDecorativeMetalColor(i)));
    }
    this.floatingCubes.instanceMatrix.needsUpdate = true;
    if (this.floatingCubes.instanceColor) this.floatingCubes.instanceColor.needsUpdate = true;
  }

  private updateSpeedStreaks(time: number): void {
    for (let i = 0; i < SPEED_STREAK_COUNT; i += 1) {
      const side = i % 2 === 0 ? -1 : 1;
      const cycle = (time * 58 + i * 4.73) % 92;
      const z = 7 - cycle;
      const x = side * (3.95 + ((i * 13) % 11) * 0.34);
      const y = 0.1 + ((i * 17) % 13) * 0.3;
      const stretch = 0.6 + Math.max(0, 1 - cycle / 92) * 1.6;
      this.position.set(x, y, z);
      this.quaternion.set(0, 0, 0, 1);
      this.scale.set(1, 1, stretch);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.speedStreaks.setMatrixAt(i, this.matrix);
    }
    this.speedStreaks.instanceMatrix.needsUpdate = true;
    if (this.speedStreaks.instanceColor) this.speedStreaks.instanceColor.needsUpdate = true;
  }

  private updateObstacles(time: number, level: Level, states: ObstacleStateRow[]): void {
    let normalIndex = 0;
    let spikeIndex = 0;
    this.camera.updateMatrixWorld();
    this.obstacleFrustum.setFromProjectionMatrix(
      this.matrix.multiplyMatrices(this.camera.projectionMatrix, this.camera.matrixWorldInverse),
    );
    for (let eventIndex = 0; eventIndex < level.events.length; eventIndex += 1) {
      const event = level.events[eventIndex];
      const delta = event.timeSeconds - time;
      if (delta > APPROACH_SECONDS) break;
      // 线性匀速接近，绝不在飞盘附近减速或停顿。
      const z = getObstacleZ(delta);
      for (let laneIndex = 0; laneIndex < LANE_CENTERS.length; laneIndex += 1) {
        const lane = laneIndex as LaneIndex;
        if (!shouldRenderObstacle(states[eventIndex][lane])) continue;
        const type = event.obstacles[lane];
        const x = LANE_CENTERS[lane];
        // InstancedMesh 只能整池剔除；填池前逐个剔除，避免离屏旧障碍占用实例。
        this.obstacleBounds.center.set(x, 0.5, z);
        if (!this.obstacleFrustum.intersectsSphere(this.obstacleBounds)) continue;

        if (type === ObstacleType.Breakable && normalIndex < this.normalBlocks.count) {
          this.position.set(x, 0.5, z);
          this.quaternion.set(0, 0, 0, 1);
          this.scale.set(1, 1, 1);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.normalBlocks.setMatrixAt(normalIndex, this.matrix);
          for (let edgeIndex = 0; edgeIndex < NORMAL_EDGE_TRANSFORMS.length; edgeIndex += 1) {
            const [offsetX, offsetY, offsetZ, scaleX, scaleY, scaleZ] = NORMAL_EDGE_TRANSFORMS[edgeIndex];
            this.position.set(x + offsetX, 0.5 + offsetY, z + offsetZ);
            this.scale.set(scaleX, scaleY, scaleZ);
            this.matrix.compose(this.position, this.quaternion, this.scale);
            this.normalEdges.setMatrixAt(normalIndex * NORMAL_EDGES_PER_OBSTACLE + edgeIndex, this.matrix);
          }
          normalIndex += 1;
        } else if (type === ObstacleType.Spike && spikeIndex < this.spikeBases.count) {
          this.position.set(x, 0.04, z);
          this.quaternion.set(0, 0, 0, 1);
          this.scale.set(1, 1, 1);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.spikeBases.setMatrixAt(spikeIndex, this.matrix);
          const spikes = [
            { x: 0, z: 0 },
            { x: -0.28, z: -0.28 },
            { x: 0.28, z: -0.28 },
            { x: -0.28, z: 0.28 },
            { x: 0.28, z: 0.28 },
          ];
          for (let point = 0; point < SPIKES_PER_OBSTACLE; point += 1) {
            const spike = spikes[point];
            this.position.set(x + spike.x, 0.53, z + spike.z);
            this.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 4, 0));
            this.matrix.compose(this.position, this.quaternion, this.scale);
            this.spikeCones.setMatrixAt(spikeIndex * SPIKES_PER_OBSTACLE + point, this.matrix);
          }
          spikeIndex += 1;
        }
      }
    }
    for (let i = normalIndex; i < this.normalBlocks.count; i += 1) {
      this.normalBlocks.setMatrixAt(i, hiddenMatrix);
      for (let edgeIndex = 0; edgeIndex < NORMAL_EDGES_PER_OBSTACLE; edgeIndex += 1) {
        this.normalEdges.setMatrixAt(i * NORMAL_EDGES_PER_OBSTACLE + edgeIndex, hiddenMatrix);
      }
    }
    for (let i = spikeIndex; i < this.spikeBases.count; i += 1) {
      this.spikeBases.setMatrixAt(i, hiddenMatrix);
      for (let point = 0; point < SPIKES_PER_OBSTACLE; point += 1) {
        this.spikeCones.setMatrixAt(i * SPIKES_PER_OBSTACLE + point, hiddenMatrix);
      }
    }
    this.normalBlocks.instanceMatrix.needsUpdate = true;
    this.normalEdges.instanceMatrix.needsUpdate = true;
    this.spikeBases.instanceMatrix.needsUpdate = true;
    this.spikeCones.instanceMatrix.needsUpdate = true;
  }

  burst(x: number, hazard = false): void {
    const count = hazard ? 48 : HIT_PARTICLES_PER_BURST;
    if (!hazard) this.playerSpinSpeed = PLAYER_HIT_SPIN_SPEED;
    this.hitImpulse = hazard ? 0.2 : 0.075;
    let created = 0;
    for (const particle of this.particleData) {
      if (particle.active || created >= count) continue;
      const angle = (created / count) * Math.PI * 2;
      const speed = 1.7 + (created % 6) * 0.35;
      particle.active = true;
      particle.x = x;
      particle.y = 0.55;
      particle.z = PLAYER_Z;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = 1.3 + (created % 5) * 0.55;
      particle.vz = Math.sin(angle) * speed;
      particle.life = hazard ? 0.95 : 0.72;
      particle.maxLife = particle.life;
      particle.sx = 0.55 + (created % 4) * 0.24;
      particle.sy = 0.45 + (created % 3) * 0.18;
      particle.sz = 0.6 + (created % 5) * 0.2;
      particle.spinX = 3 + (created % 6) * 1.4;
      particle.spinY = 4 + (created % 7) * 1.2;
      created += 1;
    }
  }

  crash(x: number): void {
    this.crashed = true;
    this.player.visible = false;
    this.trailMesh.visible = false;
    this.burst(x, true);
  }

  private updateParticles(dt: number): void {
    for (let i = 0; i < this.particleData.length; i += 1) {
      const particle = this.particleData[i];
      if (!particle.active) {
        this.particles.setMatrixAt(i, hiddenMatrix);
        continue;
      }
      particle.life -= dt;
      if (particle.life <= 0) {
        particle.active = false;
        this.particles.setMatrixAt(i, hiddenMatrix);
        continue;
      }
      particle.x += particle.vx * dt;
      particle.y += particle.vy * dt;
      particle.z += particle.vz * dt;
      particle.vy -= 5.2 * dt;
      this.position.set(particle.x, particle.y, particle.z);
      const s = Math.max(0.12, particle.life / particle.maxLife);
      this.scale.set(s * particle.sx, s * particle.sy, s * particle.sz);
      const age = particle.maxLife - particle.life;
      this.quaternion.setFromEuler(new THREE.Euler(age * particle.spinX, age * particle.spinY, age * 2.7));
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.particles.setMatrixAt(i, this.matrix);
      this.particles.setColorAt(i, this.glowColor);
    }
    this.particles.instanceMatrix.needsUpdate = true;
    if (this.particles.instanceColor) this.particles.instanceColor.needsUpdate = true;
  }

  dispose(): void {
    this.disposed = true;
    this.scene.traverse((object) => {
      if (!(object instanceof THREE.Mesh)) return;
      object.geometry.dispose();
      const materials = Array.isArray(object.material) ? object.material : [object.material];
      materials.forEach((material) => material.dispose());
    });
    this.renderer.dispose();
    this.comboTexture.dispose();
    this.comboSprite.material.dispose();
    this.missTexture.dispose();
    this.missSprite.material.dispose();
    this.environmentTexture?.dispose();
  }
}
