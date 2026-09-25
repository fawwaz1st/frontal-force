import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CoverSpotData } from '../game/Tactics';

const ARENA_HALF = 47;
export const ARENA_LIMIT = ARENA_HALF - 2;
const REDUCE_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const BASE_SUN_INTENSITY = 1.75;
const BASE_AMBIENT_INTENSITY = 1.05;

/** Deterministic per-run layout RNG (mulberry32). */
function makeSkyTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 512;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  gradient.addColorStop(0, '#485760');
  gradient.addColorStop(0.5, '#788084');
  gradient.addColorStop(0.68, '#b0a58e');
  gradient.addColorStop(0.76, '#8d8978');
  gradient.addColorStop(1, '#363b35');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, 32, 512);
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = '#55564f';
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 20 + Math.random() * 80;
    const wet = Math.random() < 0.28;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, wet ? 'rgba(24,30,30,0.34)' : 'rgba(151,145,124,0.12)');
    gradient.addColorStop(1, wet ? 'rgba(24,30,30,0)' : 'rgba(151,145,124,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5200; i++) {
    const value = 70 + Math.random() * 110;
    ctx.fillStyle = `rgba(${value},${value},${value - 8},${0.05 + Math.random() * 0.16})`;
    const size = Math.random() < 0.08 ? 2 : 1;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, size, size);
  }

  ctx.strokeStyle = 'rgba(20,22,20,0.42)';
  ctx.lineWidth = 2;
  for (let i = 0; i <= 4; i++) {
    const p = i * 128;
    ctx.beginPath();
    ctx.moveTo(p, 0);
    ctx.lineTo(p, 512);
    ctx.moveTo(0, p);
    ctx.lineTo(512, p);
    ctx.stroke();
  }
  ctx.lineWidth = 1;
  for (let i = 0; i < 34; i++) {
    let x = Math.random() * 512;
    let y = Math.random() * 512;
    ctx.beginPath();
    ctx.moveTo(x, y);
    for (let k = 0; k < 4; k++) {
      x += (Math.random() - 0.5) * 24;
      y += 8 + Math.random() * 22;
      ctx.lineTo(x, y);
    }
    ctx.stroke();
  }

  const texture = new THREE.CanvasTexture(canvas);
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  texture.repeat.set(14, 14);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
}

/** Static arena: visuals, lights, spawn/pickup points, and the collision octree. */
export class World {
  private readonly group = new THREE.Group();
  public readonly octree = new Octree();
  public readonly spawnPoints: THREE.Vector3[] = [];
  public readonly pickupPoints: THREE.Vector3[] = [];
  public readonly coverSpots: CoverSpotData[] = [];
  public readonly playerSpawn = new THREE.Vector3(0, 0, 40);
  private readonly coverGroup = new THREE.Group();
  private coverMerged: THREE.Mesh[] = [];
  private runMaterials: THREE.Material[] = [];
  private readonly footprints: Array<{ x: number; z: number; r: number }> = [];
  private dust: THREE.Points | null = null;
  private sunLight: THREE.DirectionalLight | null = null;
  private skyLight: THREE.HemisphereLight | null = null;
  private lightningBolt: THREE.Line | null = null;
  private lightningTimer = REDUCE_MOTION ? Number.POSITIVE_INFINITY : 6;
  private lightningTime = -1;
  public onThunder: ((delay: number) => void) | null = null;

  public build(scene: THREE.Scene): void {
    this.group.add(this.coverGroup);
    this.buildFloor();
    this.buildWalls();
    this.buildRangeDetails();
    this.buildLights(scene);
    this.buildDust();
    this.buildSky(scene);
    scene.add(this.group);
    this.mergeDirectMeshes(this.group, true);
    this.rebuild((Math.random() * 0xffffffff) >>> 0);
  }

  /** Fresh cover layout + spawn/pickup points + collision per run. */
  public rebuild(seed: number): void {
    const rnd = mulberry32(seed);
    this.generateCover(rnd);
    this.markPoints(rnd);
    this.coverMerged = this.mergeDirectMeshes(this.coverGroup, true);
    this.octree.clear();
    this.group.updateMatrixWorld(true);
    this.octree.fromGraphNode(this.group);
    if (this.sunLight) this.sunLight.shadow.needsUpdate = true;
  }

  public update(dt: number): void {
    if (this.dust) this.dust.rotation.y += dt * 0.008;
    if (this.lightningTime < 0) {
      this.lightningTimer -= dt;
      if (this.lightningTimer <= 0) {
        this.lightningTime = 0;
        this.lightningTimer = 9 + Math.random() * 13;
        if (this.lightningBolt) this.lightningBolt.visible = true;
        this.onThunder?.(1.4 + Math.random() * 1.8);
      }
      return;
    }

    this.lightningTime += dt;
    const t = this.lightningTime;
    const flash = t < 0.055 ? 1 : t < 0.11 ? 0.28 : Math.max(0, 1 - (t - 0.11) / 0.2);
    if (this.lightningBolt) {
      const material = this.lightningBolt.material as THREE.LineBasicMaterial;
      material.opacity = flash;
      this.lightningBolt.visible = flash > 0;
    }
    if (this.skyLight) this.skyLight.intensity = BASE_AMBIENT_INTENSITY + flash * 2.4;
    if (this.sunLight) this.sunLight.intensity = BASE_SUN_INTENSITY + flash * 1.5;
    if (t > 0.38) {
      this.lightningTime = -1;
      if (this.skyLight) this.skyLight.intensity = BASE_AMBIENT_INTENSITY;
      if (this.sunLight) this.sunLight.intensity = BASE_SUN_INTENSITY;
    }
  }

  private solid(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number, y: number, z: number,
    ry = 0,
    parent: THREE.Object3D = this.group,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  }

  /** Bake same-material direct children into one mesh — draw-call cut for the static shell. */
  private mergeDirectMeshes(container: THREE.Object3D, disposeSources = false): THREE.Mesh[] {
    container.updateMatrixWorld(true);
    const byMat = new Map<THREE.Material, THREE.Mesh[]>();
    for (const child of [...container.children]) {
      const mesh = child as THREE.Mesh;
      if (!mesh.isMesh || Array.isArray(mesh.material)) continue;
      const mat = mesh.material as THREE.Material;
      const list = byMat.get(mat) ?? [];
      list.push(mesh);
      byMat.set(mat, list);
    }
    const merged: THREE.Mesh[] = [];
    const sourceGeometries = new Set<THREE.BufferGeometry>();
    for (const child of container.children) {
      if (!(child instanceof THREE.Mesh)) continue;
      sourceGeometries.add(child.geometry);
    }
    for (const [mat, meshes] of byMat) {
      if (meshes.length < 2) continue;
      const geos = meshes.map((m) => {
        m.updateMatrix();
        return m.geometry.clone().applyMatrix4(m.matrix);
      });
      const geo = mergeGeometries(geos, false);
      geos.forEach((g) => g.dispose());
      if (!geo) continue;
      for (const m of meshes) container.remove(m);
      const out = new THREE.Mesh(geo, mat);
      out.castShadow = true;
      out.receiveShadow = true;
      container.add(out);
      merged.push(out);
    }
    if (disposeSources) {
      for (const geometry of sourceGeometries) {
        const stillUsed = container.children.some(
          (child) => child instanceof THREE.Mesh && child.geometry === geometry,
        );
        if (!stillUsed) geometry.dispose();
      }
    }
    return merged;
  }

private buildRangeDetails(): void {
    const limestone = new THREE.MeshStandardMaterial({ color: 0x9b927a, roughness: 0.96, metalness: 0.01 });
    const concrete = new THREE.MeshStandardMaterial({ color: 0x62645b, roughness: 0.9, metalness: 0.03 });
    const steel = new THREE.MeshStandardMaterial({ color: 0x3c443e, roughness: 0.58, metalness: 0.72 });
    const tarp = new THREE.MeshStandardMaterial({ color: 0x3d4933, roughness: 0.98, metalness: 0.01 });
    const ochre = new THREE.MeshStandardMaterial({ color: 0x9b5d2f, roughness: 0.82, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x252820, roughness: 0.86, metalness: 0.08 });

    const bermGeometry = new THREE.ConeGeometry(1, 1, 4);
    const bermMaterial = limestone;
    const berms: Array<[number, number, number, number]> = [
      [-31, 0, -27, 0], [0, 0, -30, Math.PI / 2], [31, 0, -27, 0],
      [-31, 0, 24, 0], [0, 0, 31, Math.PI / 2], [31, 0, 24, 0],
    ];
    for (const [x, y, z, rotation] of berms) {
      const berm = this.solid(bermGeometry, bermMaterial, x, y + 1.5, z, rotation + Math.PI / 4);
      berm.scale.set(8, 3, 4.2);
    }

    // Control bunker at the far end: a readable silhouette and a real hard cover anchor.
    this.solid(new THREE.BoxGeometry(9, 3.2, 4.4), concrete, 0, 1.6, -35);
    this.solid(new THREE.BoxGeometry(10, 0.35, 5.2), dark, 0, 3.3, -35);
    this.solid(new THREE.BoxGeometry(2.2, 2.2, 0.18), dark, 0, 1.1, -32.72);
    this.solid(new THREE.BoxGeometry(7.2, 0.18, 0.18), ochre, 0, 2.5, -32.65);
    this.solid(new THREE.BoxGeometry(0.22, 1.5, 0.22), steel, -3.7, 4, -33.6);
    this.solid(new THREE.BoxGeometry(0.22, 1.5, 0.22), steel, 3.7, 4, -33.6);

    // Olive tarps on simple steel frames provide overhead cover without another light.
    const tarpGeometry = new THREE.BoxGeometry(6.5, 0.08, 3.4);
    for (const [x, z, rotation] of [[-18, -14, 0], [18, 5, Math.PI / 2]] as Array<[number, number, number]>) {
      this.solid(tarpGeometry, tarp, x, 3.8, z, rotation);
      const cos = Math.cos(rotation);
      const sin = Math.sin(rotation);
      for (const side of [-1, 1]) {
        this.solid(new THREE.BoxGeometry(0.16, 3.8, 0.16), steel, x + cos * side * 3.1, 1.9, z - sin * side * 3.1, rotation);
      }
    }

    // Lane furniture: target frames, low sandbag stacks, and painted range marks.
    const bagGeometry = new THREE.BoxGeometry(1.2, 0.32, 0.5);
    for (const [x, z, rotation] of [[-8, -22, 0.1], [8, -22, -0.1], [-24, 8, 0.3], [24, 8, -0.3]] as Array<[number, number, number]>) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          this.solid(bagGeometry, tarp, x + col * 0.3, 0.16 + row * 0.3, z + row * 0.15, rotation);
        }
      }
      this.solid(new THREE.BoxGeometry(1.8, 1.2, 0.12), concrete, x, 1.1, z - 0.9, rotation);
    }
    const stripeGeometry = new THREE.BoxGeometry(2.4, 0.03, 0.14);
    for (let i = -3; i <= 3; i++) {
      this.solid(stripeGeometry, ochre, i * 7, 0.02, 38.5, 0);
    }

    // Three warm work lamps are visual fixtures here; their actual lights live in buildLights.
    for (const [x, z] of [[-18, -14], [18, 5], [0, 28]] as Array<[number, number]>) {
      this.solid(new THREE.CylinderGeometry(0.12, 0.16, 4.2, 8), steel, x, 2.1, z);
      this.solid(new THREE.BoxGeometry(0.65, 0.24, 0.45), ochre, x, 4.25, z);
    }
  }

  private buildFloor(): void {
  const material = new THREE.MeshStandardMaterial({
    map: makeFloorTexture(),
    color: 0xbfb8a3,
    roughness: 0.48,
    metalness: 0.08,
  });
  const floor = new THREE.Mesh(
    new THREE.BoxGeometry(ARENA_HALF * 2, 1, ARENA_HALF * 2),
    material,
  );
  floor.position.y = -0.5;
  floor.receiveShadow = true;
  this.group.add(floor);
}

  private buildWalls(): void {
  const wallMaterial = new THREE.MeshStandardMaterial({
    color: 0x817967,
    roughness: 0.88,
    metalness: 0.02,
  });
  const capMaterial = new THREE.MeshStandardMaterial({
    color: 0x494a42,
    roughness: 0.72,
    metalness: 0.16,
  });
  const wallGeometry = new THREE.BoxGeometry(ARENA_HALF * 2, 4.8, 1.25);
  const capGeometry = new THREE.BoxGeometry(ARENA_HALF * 2, 0.42, 1.55);
  const buttressGeometry = new THREE.BoxGeometry(0.55, 3.8, 1.8);
  const sides: Array<[number, number, number]> = [
    [0, -ARENA_HALF - 0.55, 0],
    [0, ARENA_HALF + 0.55, 0],
    [-ARENA_HALF - 0.55, 0, Math.PI / 2],
    [ARENA_HALF + 0.55, 0, Math.PI / 2],
  ];
  for (const [x, z, rotation] of sides) {
    this.solid(wallGeometry, wallMaterial, x, 2.4, z, rotation);
    this.solid(capGeometry, capMaterial, x, 4.95, z, rotation);
  }
  for (let t = -40; t <= 40; t += 8) {
    this.solid(buttressGeometry, wallMaterial, t, 1.9, -(ARENA_HALF - 0.2));
    this.solid(buttressGeometry, wallMaterial, t, 1.9, ARENA_HALF - 0.2);
    this.solid(buttressGeometry, wallMaterial, -(ARENA_HALF - 0.2), 1.9, t, Math.PI / 2);
    this.solid(buttressGeometry, wallMaterial, ARENA_HALF - 0.2, 1.9, t, Math.PI / 2);
  }
}

  /** Star dome above the walls — fog-free so it survives FogExp2. */
  private buildSky(scene: THREE.Scene): void {
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(150, 32, 18),
    new THREE.MeshBasicMaterial({
      map: makeSkyTexture(),
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    }),
  );
  sky.renderOrder = -100;
  scene.add(sky);

  const sun = new THREE.Mesh(
    new THREE.CircleGeometry(4.8, 32),
    new THREE.MeshBasicMaterial({ color: 0xffd7a0, fog: false, transparent: true, opacity: 0.9 }),
  );
  sun.position.set(-72, 25, -104);
  sun.lookAt(0, 0, 0);
  sun.renderOrder = -99;
  scene.add(sun);

  const cloudMaterial = new THREE.MeshBasicMaterial({
    color: 0x5e6260,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  for (const [x, y, z, scaleX, scaleY] of [
    [-60, 65, -85, 42, 8],
    [48, 74, -70, 55, 10],
    [5, 88, 80, 62, 12],
  ] as Array<[number, number, number, number, number]>) {
    const cloud = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), cloudMaterial);
    cloud.position.set(x, y, z);
    cloud.scale.set(scaleX, scaleY, 1);
    cloud.lookAt(0, y * 0.15, 0);
    cloud.renderOrder = -98;
    scene.add(cloud);
  }

  const positions = new Float32Array(30 * 3);
  let startX = -70 + Math.random() * 140;
  let startZ = -90 + Math.random() * 170;
  for (let i = 0; i < 30; i++) {
    startX += (Math.random() - 0.5) * 4;
    startZ += (Math.random() - 0.5) * 3;
    positions[i * 3] = startX;
    positions[i * 3 + 1] = 96 - i * 1.9 - Math.random() * 0.8;
    positions[i * 3 + 2] = startZ;
  }
  const boltGeometry = new THREE.BufferGeometry();
  boltGeometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  const boltMaterial = new THREE.LineBasicMaterial({
    color: 0xe8efff,
    transparent: true,
    opacity: 0,
    fog: false,
    depthWrite: false,
  });
  this.lightningBolt = new THREE.Line(boltGeometry, boltMaterial);
  this.lightningBolt.visible = false;
  this.lightningBolt.frustumCulled = false;
  scene.add(this.lightningBolt);
}

  /** Seeded cover layout: central fortress + pillar ring + scattered clusters,
   * all rejected against accumulated footprints so pickups/spawns stay clear. */
  private generateCover(rnd: () => number): void {
    this.disposeCoverRun();
    while (this.coverGroup.children.length > 0) {
      const child = this.coverGroup.children[0];
      if (!child) break;
      this.coverGroup.remove(child);
    }
    this.footprints.length = 0;
    this.coverSpots.length = 0;

    const crateMat = new THREE.MeshStandardMaterial({ color: 0x24304c, roughness: 0.6, metalness: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x141c2e, roughness: 0.55, metalness: 0.4 });
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c,
      emissive: 0xff7a33,
      emissiveIntensity: 1.6,
      roughness: 0.4,
    });
    this.runMaterials.push(crateMat, darkMat, glowMat);
    const crate = new THREE.BoxGeometry(1.4, 1.4, 1.4);
    const slab = new THREE.BoxGeometry(4.5, 2.2, 0.9);
    const pillar = new THREE.BoxGeometry(1.1, 4.2, 1.1);
    const capGeo = new THREE.BoxGeometry(1.3, 0.12, 1.3);
    const trimGeo = new THREE.BoxGeometry(4.5, 0.08, 0.95);
    const ringGeo = new THREE.BoxGeometry(3.4, 0.1, 3.4);
    const crateCap = new THREE.BoxGeometry(1.45, 0.08, 1.45);
    const plinth = new THREE.BoxGeometry(1.5, 0.3, 1.5);
    const cg = this.coverGroup;
    const add = (geo: THREE.BufferGeometry, mat: THREE.Material, x: number, y: number, z: number, ry = 0): void => {
      this.solid(geo, mat, x, y, z, ry, cg);
    };
    const mark = (x: number, z: number, r: number): void => {
      this.footprints.push({ x, z, r });
    };
    const markCover = (x: number, z: number, ry: number): void => {
      const alongX = Math.cos(ry);
      const alongZ = -Math.sin(ry);
      const normalX = Math.sin(ry);
      const normalZ = Math.cos(ry);
      const behind = 1.25;
      const peek = 2.35;
      for (const side of [-1, 1]) {
        const sideX = normalX * side;
        const sideZ = normalZ * side;
        this.coverSpots.push({
          center: new THREE.Vector3(x - sideX * behind, 0, z - sideZ * behind),
          left: new THREE.Vector3(
            x - alongX * peek - sideX * behind,
            0,
            z - alongZ * peek - sideZ * behind,
          ),
          right: new THREE.Vector3(
            x + alongX * peek - sideX * behind,
            0,
            z + alongZ * peek - sideZ * behind,
          ),
        });
      }
    };

    // Central fortress (fixed anchor, orientation random each run)
    const cRot = rnd() * Math.PI * 2;
    add(new THREE.BoxGeometry(3.2, 2.4, 3.2), darkMat, 0, 1.2, 0, cRot);
    add(new THREE.BoxGeometry(1.2, 3.4, 1.2), darkMat, 0, 1.7, 0, cRot);
    markCover(0, 0, cRot + Math.PI);
    const ring = new THREE.Mesh(ringGeo, glowMat);
    ring.position.set(0, 2.45, 0);
    cg.add(ring);
    mark(0, 0, 4.2);

    // Pillar ring — 6 random angles at radius 16–26
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const rad = 16 + rnd() * 10;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      add(pillar, crateMat, x, 2.1, z);
      add(plinth, darkMat, x, 0.15, z);
      add(capGeo, glowMat, x, 4.26, z);
      mark(x, z, 1.4);
    }

    // Scattered clusters (12–17), each rejected until it clears every footprint
    const clusters = 12 + Math.floor(rnd() * 6);
    for (let i = 0; i < clusters; i++) {
      let x = 0;
      let z = 0;
      let ok = false;
      for (let tries = 0; tries < 14 && !ok; tries++) {
        const a = rnd() * Math.PI * 2;
        const rad = 7 + rnd() * 27;
        x = Math.cos(a) * rad;
        z = Math.sin(a) * rad;
        ok = this.footprints.every((f) => Math.hypot(f.x - x, f.z - z) > f.r + 2.4);
      }
      if (!ok) continue;
      const type = Math.floor(rnd() * 4);
      const ry = rnd() * Math.PI * 2;
      if (type === 0) {
        // Crate stack
        const n = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < n; k++) {
          add(crate, k % 2 ? darkMat : crateMat, x + (rnd() - 0.5) * 0.5, 0.7 + k * 1.4, z + (rnd() - 0.5) * 0.5, ry);
        }
        add(crateCap, glowMat, x, 1.44 + (n - 1) * 1.4, z, ry);
        mark(x, z, 1.7);
        markCover(x, z, ry + Math.PI);
      } else if (type === 1) {
        // L-shaped barrier pair with lit coping
        add(slab, crateMat, x, 1.1, z, ry);
        add(trimGeo, glowMat, x, 2.26, z, ry);
        add(slab, crateMat, x + Math.cos(ry + Math.PI / 2) * 2.6, 1.1, z - Math.sin(ry + Math.PI / 2) * 2.6, ry + Math.PI / 2);
        add(crate, darkMat, x - Math.cos(ry) * 3, 0.7, z + Math.sin(ry) * 3, ry);
        mark(x, z, 3.4);
        markCover(x, z, ry + Math.PI);
        markCover(
          x + Math.cos(ry + Math.PI / 2) * 2.6,
          z - Math.sin(ry + Math.PI / 2) * 2.6,
          ry + Math.PI * 1.5,
        );
      } else if (type === 2) {
        // Glow-topped crate pair
        add(crate, crateMat, x, 0.7, z, ry);
        add(crate, darkMat, x + 1.6, 0.7, z + 0.7, ry + 0.5);
        const top = new THREE.Mesh(capGeo, glowMat);
        top.position.set(x, 1.46, z);
        cg.add(top);
        mark(x, z, 2.5);
        markCover(x, z, ry + Math.PI);
      } else {
        // Low wall with lit coping
        add(slab, darkMat, x, 1.1, z, ry);
        add(trimGeo, glowMat, x, 2.26, z, ry);
        mark(x, z, 2.9);
        markCover(x, z, ry + Math.PI);
      }
    }

  }

  private disposeCoverRun(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const merged = new Set(this.coverMerged);
    for (const child of [...this.coverGroup.children]) {
      this.coverGroup.remove(child);
      if (child instanceof THREE.Mesh && !merged.has(child)) geometries.add(child.geometry);
    }
    for (const mesh of this.coverMerged) {
      this.coverGroup.remove(mesh);
      geometries.add(mesh.geometry);
    }
    for (const geometry of geometries) geometry.dispose();
    for (const material of this.runMaterials) material.dispose();
    this.coverMerged = [];
    this.runMaterials = [];
  }

  private buildLights(scene: THREE.Scene): void {
    this.skyLight = new THREE.HemisphereLight(0xa8b0ad, 0x24261f, BASE_AMBIENT_INTENSITY);
    scene.add(this.skyLight);

    this.sunLight = new THREE.DirectionalLight(0xffe0b0, BASE_SUN_INTENSITY);
    this.sunLight.position.set(-30, 42, -24);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1536, 1536);
    this.sunLight.shadow.camera.left = -54;
    this.sunLight.shadow.camera.right = 54;
    this.sunLight.shadow.camera.top = 54;
    this.sunLight.shadow.camera.bottom = -54;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 130;
    this.sunLight.shadow.bias = -0.00035;
    // Sun is static: bake the shadow map once instead of re-rendering all
    // casters every frame; rebuild() re-arms it after cover geometry changes.
    this.sunLight.shadow.autoUpdate = false;
    this.sunLight.shadow.needsUpdate = true;
    this.sunLight.target.position.set(0, 0, 0);
    scene.add(this.sunLight, this.sunLight.target);

    for (const [x, y, z] of [[-18, 4, -14], [18, 4, 5], [0, 4.5, 28]] as Array<[number, number, number]>) {
      const light = new THREE.PointLight(0xffb35a, 22, 24, 2);
      light.position.set(x, y, z);
      scene.add(light);
    }
  }

  private buildDust(): void {
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 90;
      positions[i * 3 + 1] = Math.random() * 5 + 0.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 90;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: 0xc5b18a,
      size: 0.045,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      fog: true,
    });
    this.dust = new THREE.Points(geometry, material);
    this.group.add(this.dust);
  }

  private markPoints(rnd: () => number): void {
    this.spawnPoints.length = 0;
    this.pickupPoints.length = 0;
    const r = ARENA_HALF - 2; // hug the wall — enemies advance in from the perimeter
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + Math.PI / 12;
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    // Random pickups, rejected against cover footprints + each other
    let placed = 0;
    for (let tries = 0; tries < 240 && placed < 14; tries++) {
      const a = rnd() * Math.PI * 2;
      const rad = 6 + rnd() * 30;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (this.footprints.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 1.3)) continue;
      if (this.pickupPoints.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 36)) continue;
      this.pickupPoints.push(new THREE.Vector3(x, 0, z));
      placed++;
    }
    // Fallback ring keeps the run playable even in a crowded layout
    const fallback: Array<[number, number]> = [
      [12, 0], [-12, 0], [0, 12], [0, -12], [24, 0], [-24, 0], [0, 24], [0, -24],
    ];
    for (const [x, z] of fallback) {
      if (placed >= 10) break;
      if (this.pickupPoints.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 36)) continue;
      this.pickupPoints.push(new THREE.Vector3(x, 0, z));
      placed++;
    }
    // Emissive floor plates: red spawn gates + amber pickup pads (merged → ~2 draws)
    const spawnMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: 0xff4d3d, emissiveIntensity: 0.8, roughness: 0.5,
    });
    const padMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: 0xffb03a, emissiveIntensity: 0.7, roughness: 0.5,
    });
    this.runMaterials.push(spawnMat, padMat);
    const gateGeo = new THREE.BoxGeometry(2.4, 0.06, 2.4);
    const padGeo = new THREE.BoxGeometry(1.7, 0.06, 1.7);
    for (const p of this.spawnPoints) {
      const mesh = new THREE.Mesh(gateGeo, spawnMat);
      mesh.position.set(p.x, 0.03, p.z);
      mesh.receiveShadow = true;
      this.coverGroup.add(mesh);
    }
    for (const p of this.pickupPoints) {
      const mesh = new THREE.Mesh(padGeo, padMat);
      mesh.position.set(p.x, 0.03, p.z);
      this.coverGroup.add(mesh);
    }
  }
}
