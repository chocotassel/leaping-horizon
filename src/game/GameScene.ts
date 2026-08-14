import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import type { ChartNote, NoteState } from '../types';

const NORMAL_POOL_SIZE = 22;
const SPIKE_POOL_SIZE = 10;
const SPIKES_PER_OBSTACLE = 13;
const PARTICLE_POOL_SIZE = 96;
const FLOATING_CUBE_COUNT = 80;
const OUTER_SPECTRUM_COUNT = 112;
const INNER_SPECTRUM_COUNT = 88;
const SPEED_STREAK_COUNT = 42;
const LANE_X = 1.35;
const PLAYER_Z = -2.4;
const APPROACH_SECONDS = 1.55;
const OBSTACLE_SPAWN_Z = -64;
const RING_Z = -420;
const RING_CENTER_Y = 0;
const PLAYER_LIMIT_X = 2.92;
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
  color: THREE.Color;
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

export class GameScene {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(92, 1, 0.1, 900);
  private readonly player = new THREE.Group();
  private readonly trailMesh: THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial>;
  private readonly trailHistory = new Float32Array(22);
  private readonly normalBlocks: THREE.InstancedMesh;
  private readonly normalBands: THREE.InstancedMesh;
  private readonly normalFrames: THREE.InstancedMesh;
  private readonly spikeBases: THREE.InstancedMesh;
  private readonly spikeCones: THREE.InstancedMesh;
  private readonly particles: THREE.InstancedMesh;
  private readonly particleData: Particle[];
  private readonly outerSpectrumBars: THREE.InstancedMesh;
  private readonly innerSpectrumBars: THREE.InstancedMesh;
  private readonly floatingCubes: THREE.InstancedMesh;
  private readonly floatingEdges: THREE.InstancedMesh;
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
  private environmentTexture: THREE.Texture | null = null;
  private playerX = 0;
  private targetPlayerX = 0;
  private playerVelocity = 0;
  private hitImpulse = 0;
  private feedbackCombo = -1;
  private comboImpactStart = -Infinity;
  private missImpactStart = -Infinity;
  private crashed = false;
  private disposed = false;

  constructor(canvas: HTMLCanvasElement) {
    const nav = navigator as Navigator & { deviceMemory?: number };
    const lowPower = (nav.deviceMemory ?? 4) <= 2 || (navigator.hardwareConcurrency ?? 4) <= 4;
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
    this.scene.background = new THREE.Color(0x020910);
    this.scene.fog = new THREE.Fog(0x020a12, 170, 760);
    this.camera.position.set(0, 13, 12);
    this.camera.lookAt(0, 0, -40);

    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.environmentTexture = pmrem.fromScene(new RoomEnvironment(), 0.03).texture;
    this.scene.environment = this.environmentTexture;
    pmrem.dispose();

    this.scene.add(new THREE.HemisphereLight(0x8efaff, 0x18052d, 1.55));
    const keyLight = new THREE.DirectionalLight(0xe6faff, 3.2);
    keyLight.position.set(-4, 8, 7);
    this.scene.add(keyLight);
    const rimLight = new THREE.DirectionalLight(0x9b3dff, 2.7);
    rimLight.position.set(6, 3, -8);
    this.scene.add(rimLight);

    const environment = this.createEnvironment(lowPower);
    this.outerSpectrumBars = environment.outerSpectrumBars;
    this.innerSpectrumBars = environment.innerSpectrumBars;
    this.floatingCubes = environment.floatingCubes;
    this.floatingEdges = environment.floatingEdges;
    this.floatingData = environment.floatingData;
    this.speedStreaks = environment.speedStreaks;
    this.trailMesh = this.createPlayer();

    const steelTexture = this.createSteelTexture();
    this.normalBlocks = this.createInstances(
      new RoundedBoxGeometry(0.94, 0.64, 0.94, 2, 0.07),
      new THREE.MeshStandardMaterial({
        color: 0xd8ecf1,
        map: steelTexture,
        metalness: 0.96,
        roughness: 0.17,
        emissive: 0x063642,
        emissiveIntensity: 0.6,
        envMapIntensity: 2.2,
      }),
      NORMAL_POOL_SIZE,
    );
    this.normalBands = this.createInstances(
      new THREE.BoxGeometry(0.13, 0.035, 0.78),
      new THREE.MeshStandardMaterial({
        color: 0x07151b,
        metalness: 0.9,
        roughness: 0.22,
        emissive: 0x00a8c6,
        emissiveIntensity: 0.75,
      }),
      NORMAL_POOL_SIZE * 3,
    );
    this.normalFrames = this.createInstances(
      new THREE.BoxGeometry(0.99, 0.69, 0.99),
      new THREE.MeshBasicMaterial({
        color: 0x36efff,
        wireframe: true,
        transparent: true,
        opacity: 0.68,
        fog: false,
        toneMapped: false,
      }),
      NORMAL_POOL_SIZE,
    );

    this.spikeBases = this.createInstances(
      new RoundedBoxGeometry(0.98, 0.98, 0.98, 2, 0.07),
      new THREE.MeshStandardMaterial({
        color: 0x69757c,
        map: steelTexture,
        metalness: 0.96,
        roughness: 0.16,
        emissive: 0x310044,
        emissiveIntensity: 0.72,
        envMapIntensity: 2.2,
      }),
      SPIKE_POOL_SIZE,
    );
    this.spikeCones = this.createInstances(
      new THREE.ConeGeometry(0.13, 0.44, 5),
      new THREE.MeshStandardMaterial({
        color: 0xeefbff,
        metalness: 1,
        roughness: 0.1,
        emissive: 0x4e0068,
        emissiveIntensity: 0.7,
      }),
      SPIKE_POOL_SIZE * SPIKES_PER_OBSTACLE,
    );

    this.particles = this.createInstances(
      new THREE.BoxGeometry(0.24, 0.09, 0.2),
      new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.9, roughness: 0.25 }),
      PARTICLE_POOL_SIZE,
    );
    this.particleData = Array.from({ length: PARTICLE_POOL_SIZE }, () => ({
      active: false,
      x: 0,
      y: 0,
      z: 0,
      vx: 0,
      vy: 0,
      vz: 0,
      life: 0,
      maxLife: 0,
      color: new THREE.Color(),
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
    sprite.position.set(0, 55, RING_Z + 40);
    sprite.renderOrder = 20;
    this.scene.add(sprite);
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
      this.missSprite.scale.set(70 * impact, 35 * impact, 1);
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
    this.comboSprite.scale.set(80 * impact, 60 * impact, 1);
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

  private createPerspectiveRoad(): void {
    const roadLength = 1500;
    const roadWidth = 11.6;
    const road = new THREE.Mesh(
      new THREE.PlaneGeometry(roadWidth, roadLength),
      new THREE.MeshBasicMaterial({ color: 0x010203, side: THREE.DoubleSide }),
    );
    road.rotation.x = -Math.PI / 2;
    road.position.set(0, -0.075, 10 - roadLength / 2);
    this.scene.add(road);

    // 世界空间中严格平行、全程等宽，只通过透视投影自然汇聚。
    for (const side of [-1, 1]) {
      const glow = new THREE.Mesh(
        new THREE.PlaneGeometry(0.48, roadLength),
        new THREE.MeshBasicMaterial({
          color: 0x2cecff,
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
      glow.position.set(side * roadWidth / 2, -0.035, 10 - roadLength / 2);
      this.scene.add(glow);

      const edge = new THREE.Mesh(
        new THREE.BoxGeometry(0.065, 0.04, roadLength),
        new THREE.MeshBasicMaterial({ color: 0xa4fbff, fog: false, toneMapped: false }),
      );
      edge.position.set(side * roadWidth / 2, 0, 10 - roadLength / 2);
      this.scene.add(edge);
    }
  }

  private createEnvironment(lowPower: boolean): {
    outerSpectrumBars: THREE.InstancedMesh;
    innerSpectrumBars: THREE.InstancedMesh;
    floatingCubes: THREE.InstancedMesh;
    floatingEdges: THREE.InstancedMesh;
    floatingData: FloatingCube[];
    speedStreaks: THREE.InstancedMesh;
  } {
    this.createBackgroundGrid();

    this.createPerspectiveRoad();

    const circleCenterY = RING_CENTER_Y;
    // 多层圆环沿 Z 轴错开，形成有真实纵深的霓虹隧道入口。
    const ringLayers = [
      { radius: 138, tube: 3.8, z: RING_Z - 12, color: 0x04365a, opacity: 0.9 },
      { radius: 132, tube: 2.6, z: RING_Z - 3, color: 0xd8ffff, opacity: 1 },
      { radius: 126, tube: 1.8, z: RING_Z + 6, color: 0x00eaff, opacity: 1 },
      { radius: 114, tube: 1.2, z: RING_Z + 14, color: 0xa34dff, opacity: 1 },
    ];
    ringLayers.forEach((layer) => {
      const ringMaterial = new THREE.MeshBasicMaterial({
        color: layer.color,
        transparent: true,
        opacity: layer.opacity,
        fog: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const ring = new THREE.Mesh(
        new THREE.TorusGeometry(layer.radius, layer.tube, lowPower ? 6 : 10, lowPower ? 64 : 96),
        ringMaterial,
      );
      ring.position.set(0, circleCenterY, layer.z);
      this.scene.add(ring);
    });

    const tunnelWall = new THREE.Mesh(
      new THREE.CylinderGeometry(130, 114, 30, lowPower ? 48 : 72, 1, true),
      new THREE.MeshBasicMaterial({
        color: 0x037f99,
        transparent: true,
        opacity: 0.12,
        side: THREE.DoubleSide,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
    );
    tunnelWall.rotation.x = Math.PI / 2;
    tunnelWall.position.set(0, circleCenterY, RING_Z);
    this.scene.add(tunnelWall);

    const outerSpectrumBars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.075, 1, 0.11),
      new THREE.MeshBasicMaterial({ color: 0x20eaff, fog: false, toneMapped: false }),
      OUTER_SPECTRUM_COUNT,
    );
    outerSpectrumBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    outerSpectrumBars.frustumCulled = false;
    outerSpectrumBars.renderOrder = 1;
    this.scene.add(outerSpectrumBars);

    const innerSpectrumBars = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.065, 1, 0.1),
      new THREE.MeshBasicMaterial({ color: 0x8c4dff, fog: false, toneMapped: false }),
      INNER_SPECTRUM_COUNT,
    );
    innerSpectrumBars.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    innerSpectrumBars.frustumCulled = false;
    this.scene.add(innerSpectrumBars);

    const floatingData = Array.from({ length: FLOATING_CUBE_COUNT }, (_, index) => {
      const side = index % 2 === 0 ? -1 : 1;
      const depthIndex = Math.floor(index / 2);
      const depthBand = depthIndex % 32;
      return {
        x: side * (5.2 + depthBand * 1.1 + ((depthIndex * 5) % 7) * 0.35),
        y: depthIndex < 32 ? 0.6 + ((index * 13) % 21) * 1.1 : 0.6 + ((depthIndex - 32) % 4) * 1.4,
        z: 2 - depthBand * 3.4 - (index % 3) * 0.4,
        size: 0.28 + ((index * 5) % 9) * 0.1,
        phase: index * 0.73,
      };
    });
    const cubeGeometry = new THREE.BoxGeometry(1, 1, 1);
    const floatingMaterial = new THREE.MeshBasicMaterial({
      color: 0xffffff,
      transparent: true,
      opacity: 0.82,
      fog: false,
      toneMapped: false,
    });
    const floatingCubes = new THREE.InstancedMesh(
      cubeGeometry,
      floatingMaterial,
      FLOATING_CUBE_COUNT,
    );
    const floatingEdges = new THREE.InstancedMesh(
      cubeGeometry,
      new THREE.MeshBasicMaterial({
        color: 0x31dfff,
        transparent: true,
        opacity: 0.13,
        fog: false,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      }),
      FLOATING_CUBE_COUNT,
    );
    floatingCubes.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    floatingEdges.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    floatingCubes.frustumCulled = false;
    floatingEdges.frustumCulled = false;
    this.scene.add(floatingCubes, floatingEdges);

    const speedStreaks = new THREE.InstancedMesh(
      new THREE.BoxGeometry(0.025, 0.025, 3.8),
      new THREE.MeshBasicMaterial({
        color: 0xa7fbff,
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

    return { outerSpectrumBars, innerSpectrumBars, floatingCubes, floatingEdges, floatingData, speedStreaks };
  }

  private createBackgroundGrid(): void {
    const vertices: number[] = [];
    for (let x = -16; x <= 16; x += 1.6) vertices.push(x, -1, -47, x, 16, -47);
    for (let y = -1; y <= 16; y += 1.6) vertices.push(-16, y, -47, 16, y, -47);
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(vertices, 3));
    const grid = new THREE.LineSegments(
      geometry,
      new THREE.LineBasicMaterial({ color: 0x713133, transparent: true, opacity: 0.42, fog: false }),
    );
    this.scene.add(grid);

    const accentVertices = [
      -11, 7, -45, -8, 9, -45, -8, 9, -45, -6.4, 7.5, -45,
      8.5, 3, -45, 10.2, 4.6, -45, 10.2, 4.6, -45, 12, 3.4, -45,
      -10, 3, -45, -8.8, 2.4, -45, -8.8, 2.4, -45, -7.5, 4.2, -45,
    ];
    const accentGeometry = new THREE.BufferGeometry();
    accentGeometry.setAttribute('position', new THREE.Float32BufferAttribute(accentVertices, 3));
    this.scene.add(new THREE.LineSegments(
      accentGeometry,
      new THREE.LineBasicMaterial({ color: 0xff4f47, fog: false }),
    ));
  }

  private createPlayer(): THREE.Mesh<THREE.BufferGeometry, THREE.MeshBasicMaterial> {
    const hub = new THREE.Mesh(
      new THREE.CylinderGeometry(0.28, 0.35, 0.12, 16),
      new THREE.MeshStandardMaterial({
        color: 0x171b24,
        metalness: 1,
        roughness: 0.055,
        emissive: 0x280047,
        emissiveIntensity: 0.55,
        envMapIntensity: 3.6,
      }),
    );
    this.player.add(hub);

    const outerRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.43, 0.065, 6, 24),
      new THREE.MeshStandardMaterial({
        color: 0x202631,
        metalness: 1,
        roughness: 0.05,
        emissive: 0x310057,
        emissiveIntensity: 0.6,
        envMapIntensity: 3.8,
      }),
    );
    outerRing.rotation.x = Math.PI / 2;
    this.player.add(outerRing);

    // 三片向外弯折的飞刀轮廓，枢轴在中心，尖端形成明确旋转剪影。
    const bladeShape = new THREE.Shape();
    bladeShape.moveTo(0.38, -0.08);
    bladeShape.bezierCurveTo(0.72, -0.42, 1.24, -0.45, 1.55, -0.15);
    bladeShape.lineTo(1.16, 0.02);
    bladeShape.bezierCurveTo(0.91, 0.13, 0.69, 0.27, 0.5, 0.42);
    bladeShape.bezierCurveTo(0.55, 0.19, 0.48, 0.02, 0.38, -0.08);
    bladeShape.closePath();
    const bladeGeometry = new THREE.ExtrudeGeometry(bladeShape, {
      depth: 0.065,
      bevelEnabled: true,
      bevelThickness: 0.035,
      bevelSize: 0.025,
      bevelSegments: 1,
    });
    bladeGeometry.rotateX(Math.PI / 2);
    const bladeMaterial = new THREE.MeshStandardMaterial({
      color: 0x282f39,
      metalness: 1,
      roughness: 0.045,
      emissive: 0x300055,
      emissiveIntensity: 0.58,
      envMapIntensity: 4,
    });
    for (let i = 0; i < 3; i += 1) {
      const blade = new THREE.Mesh(bladeGeometry, bladeMaterial);
      blade.rotation.y = i * Math.PI * 2 / 3;
      this.player.add(blade);
      const glowBlade = new THREE.Mesh(
        bladeGeometry,
        new THREE.MeshBasicMaterial({
          color: 0xa53cff,
          transparent: true,
          opacity: 0.28,
          depthWrite: false,
          blending: THREE.AdditiveBlending,
          fog: false,
          toneMapped: false,
        }),
      );
      glowBlade.scale.set(1.045, 1.25, 1.045);
      glowBlade.rotation.y = i * Math.PI * 2 / 3;
      this.player.add(glowBlade);
    }
    const energyHalo = new THREE.Mesh(
      new THREE.TorusGeometry(0.48, 0.11, 6, 28),
      new THREE.MeshBasicMaterial({
        color: 0xc987ff,
        transparent: true,
        opacity: 0.3,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: false,
        toneMapped: false,
      }),
    );
    energyHalo.rotation.x = Math.PI / 2;
    this.player.add(energyHalo);
    this.player.scale.setScalar(1.28);
    this.player.position.set(0, 0.32, PLAYER_Z);
    this.scene.add(this.player);

    const trailSegments = this.trailHistory.length;
    const positions = new Float32Array(trailSegments * 2 * 3);
    const colors = new Float32Array(trailSegments * 2 * 3);
    const indices: number[] = [];
    for (let segment = 0; segment < trailSegments - 1; segment += 1) {
      const a = segment * 2;
      indices.push(a, a + 2, a + 1, a + 1, a + 2, a + 3);
    }
    const trailGeometry = new THREE.BufferGeometry();
    trailGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    trailGeometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    trailGeometry.setIndex(indices);
    const trailMaterial = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
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
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
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

  render(time: number, chart: ChartNote[], states: NoteState[], combo: number): void {
    if (this.disposed) return;
    const dt = Math.min(this.clock.getDelta(), 0.05);
    if (!this.crashed) {
      const oldX = this.playerX;
      this.playerX += (this.targetPlayerX - this.playerX) * Math.min(1, dt * 17);
      this.playerVelocity = (this.playerX - oldX) / Math.max(dt, 0.001);
      this.player.position.x = this.playerX;
      this.player.position.y = 0.32 + Math.sin(time * 8) * 0.025;
      this.player.rotation.z = THREE.MathUtils.clamp(-this.playerVelocity * 0.013, -0.16, 0.16);
      this.player.rotation.y -= dt * 34;
      this.updateTrail();
    }

    this.updateSpectrum(time, combo);
    this.updateFeedback(time, combo);
    this.updateFloatingCubes(time);
    this.updateSpeedStreaks(time);
    this.updateObstacles(time, chart, states);
    this.updateParticles(dt);
    this.hitImpulse *= Math.pow(0.015, dt);
    const cameraJitter = this.hitImpulse * Math.sin(time * 115);
    this.camera.position.x += (this.playerX * 0.06 + cameraJitter - this.camera.position.x) * Math.min(1, dt * 11);
    this.camera.position.y = 12.2 + cameraJitter * 0.28;
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
      // 光片从中心圆环后缘收束发出，向后逐渐展开和淡出。
      const width = 0.12 + progress * 0.68;
      const z = PLAYER_Z + 0.05 + progress * 9.4;
      const intensity = Math.pow(1 - progress, 0.72);
      positions.setXYZ(segment * 2, centerX - width, 0.025, z);
      positions.setXYZ(segment * 2 + 1, centerX + width, 0.025, z);
      colors.setXYZ(segment * 2, 0.78 * intensity, 0.55 * intensity, 1.0 * intensity);
      colors.setXYZ(segment * 2 + 1, 0.92 * intensity, 0.72 * intensity, 1.0 * intensity);
    }
    positions.needsUpdate = true;
    colors.needsUpdate = true;
  }

  private updateSpectrum(time: number, combo: number): void {
    const beat = 60 / 128;
    const beatPhase = (time % beat) / beat;
    const beatKick = Math.exp(-beatPhase * 6.5);
    const comboBoost = Math.min(0.4, combo * 0.006);
    for (let i = 0; i < OUTER_SPECTRUM_COUNT; i += 1) {
      const angle = (i / OUTER_SPECTRUM_COUNT) * Math.PI * 2;
      const wave = Math.abs(Math.sin(time * 4.7 + i * 0.47));
      const length = 3.2 + wave * 7.2 + beatKick * (3.8 + (i % 5) * 0.4) + comboBoost * 10;
      const radius = 142 + length * 0.5;
      this.position.set(Math.cos(angle) * radius, RING_CENTER_Y + Math.sin(angle) * radius, RING_Z + 3);
      this.quaternion.setFromEuler(new THREE.Euler(0, 0, angle - Math.PI / 2));
      this.scale.set(8, length, 10);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.outerSpectrumBars.setMatrixAt(i, this.matrix);
      this.outerSpectrumBars.setColorAt(i, this.tempColor.setHex(i % 13 < 3 ? 0xa44cff : 0x17e9ff));
    }
    this.outerSpectrumBars.instanceMatrix.needsUpdate = true;
    if (this.outerSpectrumBars.instanceColor) this.outerSpectrumBars.instanceColor.needsUpdate = true;

    // 内圈略靠近镜头，避免频谱竖条被主环完全遮住。
    for (let i = 0; i < INNER_SPECTRUM_COUNT; i += 1) {
      const angle = (i / INNER_SPECTRUM_COUNT) * Math.PI * 2;
      const wave = Math.abs(Math.cos(time * 5.2 + i * 0.39));
      const length = 2.2 + wave * 4.8 + beatKick * 2.8 + comboBoost * 5;
      const radius = 109 - length * 0.5;
      this.position.set(Math.cos(angle) * radius, RING_CENTER_Y + Math.sin(angle) * radius, RING_Z + 20);
      this.quaternion.setFromEuler(new THREE.Euler(0, 0, angle - Math.PI / 2));
      this.scale.set(7, length, 9);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.innerSpectrumBars.setMatrixAt(i, this.matrix);
      this.innerSpectrumBars.setColorAt(i, this.tempColor.setHex(i % 9 < 2 ? 0x20dfff : 0x8c42ff));
    }
    this.innerSpectrumBars.instanceMatrix.needsUpdate = true;
    if (this.innerSpectrumBars.instanceColor) this.innerSpectrumBars.instanceColor.needsUpdate = true;
  }

  private updateFloatingCubes(time: number): void {
    for (let i = 0; i < this.floatingData.length; i += 1) {
      const cube = this.floatingData[i];
      this.position.set(cube.x, cube.y + Math.sin(time * 0.8 + cube.phase) * 0.16, cube.z);
      this.quaternion.setFromEuler(new THREE.Euler(time * 0.18 + cube.phase, time * 0.24 + cube.phase * 0.7, cube.phase));
      this.scale.setScalar(cube.size);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.floatingCubes.setMatrixAt(i, this.matrix);
      this.floatingCubes.setColorAt(i, this.tempColor.setHex(i % 5 === 0 ? 0x8a26ff : i % 3 === 0 ? 0x00e8bd : 0x009fe8));
      this.scale.setScalar(cube.size * 1.48);
      this.matrix.compose(this.position, this.quaternion, this.scale);
      this.floatingEdges.setMatrixAt(i, this.matrix);
    }
    this.floatingCubes.instanceMatrix.needsUpdate = true;
    if (this.floatingCubes.instanceColor) this.floatingCubes.instanceColor.needsUpdate = true;
    this.floatingEdges.instanceMatrix.needsUpdate = true;
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
      this.speedStreaks.setColorAt(i, this.tempColor.setHex(i % 6 === 0 ? 0xa550ff : 0x55eeff));
    }
    this.speedStreaks.instanceMatrix.needsUpdate = true;
    if (this.speedStreaks.instanceColor) this.speedStreaks.instanceColor.needsUpdate = true;
  }

  private updateObstacles(time: number, chart: ChartNote[], states: NoteState[]): void {
    let normalIndex = 0;
    let spikeIndex = 0;
    for (let i = 0; i < chart.length; i += 1) {
      const delta = chart[i].time - time;
      if (states[i] !== 'pending' || delta < -0.3 || delta > APPROACH_SECONDS) continue;
      const progress = 1 - delta / APPROACH_SECONDS;
      // 线性匀速接近，绝不在飞盘附近减速或停顿。
      const z = OBSTACLE_SPAWN_Z + progress * (Math.abs(OBSTACLE_SPAWN_Z) + PLAYER_Z);
      const x = chart[i].lane * LANE_X;

      if (chart[i].type === 'normal' && normalIndex < NORMAL_POOL_SIZE) {
        this.position.set(x, 0.3, z);
        this.quaternion.set(0, 0, 0, 1);
        this.scale.set(1, 1, 1);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.normalBlocks.setMatrixAt(normalIndex, this.matrix);
        this.normalFrames.setMatrixAt(normalIndex, this.matrix);
        // 三道固定斜纹钢板压槽，不随时间旋转。
        for (let stripe = 0; stripe < 3; stripe += 1) {
          this.position.set(x + (stripe - 1) * 0.23, 0.602, z);
          this.quaternion.setFromEuler(new THREE.Euler(0, Math.PI / 4, 0));
          this.scale.set(1, 1, 1);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.normalBands.setMatrixAt(normalIndex * 3 + stripe, this.matrix);
        }
        normalIndex += 1;
      } else if (chart[i].type === 'spike' && spikeIndex < SPIKE_POOL_SIZE) {
        this.position.set(x, 0.5, z);
        this.quaternion.set(0, 0, 0, 1);
        this.scale.set(1, 1, 1);
        this.matrix.compose(this.position, this.quaternion, this.scale);
        this.spikeBases.setMatrixAt(spikeIndex, this.matrix);
        const spikes = [
          { x: -0.27, y: 0.96, z: -0.27, rx: 0, rz: 0 },
          { x: 0.27, y: 0.96, z: -0.27, rx: 0, rz: 0 },
          { x: -0.27, y: 0.96, z: 0.27, rx: 0, rz: 0 },
          { x: 0.27, y: 0.96, z: 0.27, rx: 0, rz: 0 },
          { x: -0.48, y: 0.34, z: -0.27, rx: 0, rz: Math.PI / 2 },
          { x: -0.48, y: 0.66, z: 0.27, rx: 0, rz: Math.PI / 2 },
          { x: 0.48, y: 0.34, z: 0.27, rx: 0, rz: -Math.PI / 2 },
          { x: 0.48, y: 0.66, z: -0.27, rx: 0, rz: -Math.PI / 2 },
          { x: -0.27, y: 0.34, z: 0.48, rx: Math.PI / 2, rz: 0 },
          { x: 0.27, y: 0.66, z: 0.48, rx: Math.PI / 2, rz: 0 },
          { x: -0.27, y: 0.66, z: -0.48, rx: -Math.PI / 2, rz: 0 },
          { x: 0.27, y: 0.34, z: -0.48, rx: -Math.PI / 2, rz: 0 },
          { x: 0, y: 1.04, z: 0, rx: 0, rz: 0 },
        ];
        for (let point = 0; point < SPIKES_PER_OBSTACLE; point += 1) {
          const spike = spikes[point];
          this.position.set(x + spike.x, spike.y, z + spike.z);
          this.quaternion.setFromEuler(new THREE.Euler(spike.rx, 0, spike.rz));
          this.scale.set(1, point === 12 ? 1.2 : 1, 1);
          this.matrix.compose(this.position, this.quaternion, this.scale);
          this.spikeCones.setMatrixAt(spikeIndex * SPIKES_PER_OBSTACLE + point, this.matrix);
        }
        spikeIndex += 1;
      }
    }
    for (let i = normalIndex; i < NORMAL_POOL_SIZE; i += 1) {
      this.normalBlocks.setMatrixAt(i, hiddenMatrix);
      this.normalFrames.setMatrixAt(i, hiddenMatrix);
      for (let stripe = 0; stripe < 3; stripe += 1) {
        this.normalBands.setMatrixAt(i * 3 + stripe, hiddenMatrix);
      }
    }
    for (let i = spikeIndex; i < SPIKE_POOL_SIZE; i += 1) {
      this.spikeBases.setMatrixAt(i, hiddenMatrix);
      for (let point = 0; point < SPIKES_PER_OBSTACLE; point += 1) {
        this.spikeCones.setMatrixAt(i * SPIKES_PER_OBSTACLE + point, hiddenMatrix);
      }
    }
    this.normalBlocks.instanceMatrix.needsUpdate = true;
    this.normalFrames.instanceMatrix.needsUpdate = true;
    this.normalBands.instanceMatrix.needsUpdate = true;
    this.spikeBases.instanceMatrix.needsUpdate = true;
    this.spikeCones.instanceMatrix.needsUpdate = true;
  }

  burst(lane: number, hazard = false): void {
    const count = hazard ? 48 : 22;
    const color = hazard ? new THREE.Color(0xff342e) : new THREE.Color(0x9defff);
    this.hitImpulse = hazard ? 0.2 : 0.075;
    let created = 0;
    for (const particle of this.particleData) {
      if (particle.active || created >= count) continue;
      const angle = (created / count) * Math.PI * 2;
      const speed = 1.7 + (created % 6) * 0.35;
      particle.active = true;
      particle.x = lane * LANE_X;
      particle.y = 0.55;
      particle.z = PLAYER_Z;
      particle.vx = Math.cos(angle) * speed;
      particle.vy = 1.3 + (created % 5) * 0.55;
      particle.vz = Math.sin(angle) * speed;
      particle.life = hazard ? 0.95 : 0.72;
      particle.maxLife = particle.life;
      particle.color.copy(color);
      particle.sx = 0.55 + (created % 4) * 0.24;
      particle.sy = 0.45 + (created % 3) * 0.18;
      particle.sz = 0.6 + (created % 5) * 0.2;
      particle.spinX = 3 + (created % 6) * 1.4;
      particle.spinY = 4 + (created % 7) * 1.2;
      created += 1;
    }
  }

  crash(lane: number): void {
    this.crashed = true;
    this.player.visible = false;
    this.trailMesh.visible = false;
    this.burst(lane, true);
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
      this.particles.setColorAt(i, particle.color);
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
