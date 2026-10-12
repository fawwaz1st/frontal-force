import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import type { CoverSpotData } from '../ai/Tactics';
import { MAPS, mapForSeed, type MapTheme } from './Maps';

/**
 * Half-width of the arena, in metres.
 *
 * This was 47 (a 94 x 94 m box) which is far more space than the weapons or
 * the AI can use: every enemy engages inside 44 m and the longest sight line
 * that matters is about 40 m, so the outer third of the old arena was dead
 * ground that only ever produced long walks. 37 keeps every fight inside the
 * range band the weapons are tuned for and roughly doubles the encounter
 * density, which is what "less is more" means here: fewer square metres,
 * more fight per square metre.
 */
const ARENA_HALF = 37;
export const ARENA_LIMIT = ARENA_HALF - 2;
const REDUCE_MOTION =
  typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** Deterministic per-run layout RNG (mulberry32). */
function makeSkyTexture(theme: MapTheme): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = 32;
  canvas.height = 512;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  const gradient = ctx.createLinearGradient(0, 0, 0, 512);
  const stops = theme.sky;
  for (let i = 0; i < stops.length; i++) {
    gradient.addColorStop(i / (stops.length - 1), stops[i] as string);
  }
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

function makeFloorTexture(theme: MapTheme): THREE.CanvasTexture {
  const { base, light, dark, line, grit, repeat } = theme.floor;
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const ctx = canvas.getContext('2d') as CanvasRenderingContext2D;
  ctx.fillStyle = base;
  ctx.fillRect(0, 0, 512, 512);

  for (let i = 0; i < 90; i++) {
    const x = Math.random() * 512;
    const y = Math.random() * 512;
    const r = 20 + Math.random() * 80;
    const wet = Math.random() < 0.28;
    const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
    gradient.addColorStop(0, wet ? dark : light);
    gradient.addColorStop(1, wet ? 'rgba(0,0,0,0)' : 'rgba(0,0,0,0)');
    ctx.fillStyle = gradient;
    ctx.fillRect(x - r, y - r, r * 2, r * 2);
  }
  for (let i = 0; i < 5200; i++) {
    const value = grit + Math.random() * 110;
    ctx.fillStyle = `rgba(${value},${value},${value - 8},${0.05 + Math.random() * 0.16})`;
    const size = Math.random() < 0.08 ? 2 : 1;
    ctx.fillRect(Math.random() * 512, Math.random() * 512, size, size);
  }

  ctx.strokeStyle = line;
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
  texture.repeat.set(repeat, repeat);
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
  /**
   * Cover spots belonging to the FIXED structures (bunker, towers, nests,
   * tarps). Kept apart from `coverSpots` because `generateCover` clears the
   * run's spots on every rebuild: the fixed ones are built once in `build()`
   * and would otherwise be wiped by the first run.
   */
  private readonly fixedCoverSpots: CoverSpotData[] = [];
  public readonly playerSpawn = new THREE.Vector3(0, 0, 30);
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
  /** Live arena-mutation multipliers (see game/Waves.ts MUTATIONS). */
  private fogMul = 1;
  private sunMul = 1;
  private ambientMul = 1;
  private scene: THREE.Scene | null = null;
  /** Base fog density, captured at build so a mutation is always relative. */
  private baseFogDensity = 0.005;

  // ---------------------------------------------------------------------
  // Arena theme. Every run rebuilds the same GEOMETRY (so the octree, the AI
  // and the cover claims all stay valid) but re-skins it: palette, sky, fog,
  // light colour and cover density. That is what makes a new seed a new map
  // instead of the same yard with the crates moved.
  // ---------------------------------------------------------------------
  private theme: MapTheme = MAPS[0] as MapTheme;
  private themeIndex = -1;
  private floorMaterial: THREE.MeshStandardMaterial | null = null;
  private wallMaterial: THREE.MeshStandardMaterial | null = null;
  private capMaterial: THREE.MeshStandardMaterial | null = null;
  private skyMaterial: THREE.MeshBasicMaterial | null = null;
  private sunDiscMaterial: THREE.MeshBasicMaterial | null = null;
  private cloudMaterial: THREE.MeshBasicMaterial | null = null;
  private dustMaterial: THREE.PointsMaterial | null = null;
  private readonly rangeMaterials: THREE.MeshStandardMaterial[] = [];
  private readonly rangeLamps: THREE.PointLight[] = [];

  /** Short theme name for the HUD and the debrief board. */
  public get themeName(): string {
    return this.theme.name;
  }

  /** One-line place description, shown under the theme name. */
  public get themeTagline(): string {
    return this.theme.tagline;
  }

  /**
   * Re-skin the arena for `theme`. Everything here is a material or light
   * property: no geometry is touched, so the collision octree built for this
   * run stays exactly as valid as it was.
   *
   * `regenerateTextures` is separate from the colour pass because the canvas
   * textures cost a few milliseconds each. The colour pass must run on every
   * rebuild (the scene's fog is created by the owner AFTER build(), so a
   * same-theme rebuild still has to re-assert it), while the textures only
   * need rebuilding when the theme actually changes.
   */
  private applyTheme(theme: MapTheme, regenerateTextures: boolean): void {
    if (regenerateTextures && this.floorMaterial) {
      this.floorMaterial.map?.dispose();
      this.floorMaterial.map = makeFloorTexture(theme);
      this.floorMaterial.needsUpdate = true;
    }
    if (this.floorMaterial) this.floorMaterial.color.setHex(theme.floor.color);
    this.wallMaterial?.color.setHex(theme.wall.body);
    this.capMaterial?.color.setHex(theme.wall.cap);
    if (regenerateTextures && this.skyMaterial) {
      this.skyMaterial.map?.dispose();
      this.skyMaterial.map = makeSkyTexture(theme);
      this.skyMaterial.needsUpdate = true;
    }
    this.sunDiscMaterial?.color.setHex(theme.light.sun);
    this.cloudMaterial?.color.setHex(theme.fog.color);
    this.dustMaterial?.color.setHex(theme.dust);
    // Range furniture picks up the theme's masonry and fabric tones so the
    // bunker and the berms do not stay limestone-brown on a night map.
    const [stone, concrete, steel, tarp, ochre, dark] = this.rangeMaterials;
    stone?.color.setHex(theme.wall.body);
    concrete?.color.setHex(theme.wall.cap);
    steel?.color.setHex(theme.cover.dark);
    tarp?.color.setHex(theme.cover.crate);
    ochre?.color.setHex(theme.cover.glow);
    dark?.color.setHex(theme.cover.dark);
    for (const lamp of this.rangeLamps) lamp.color.setHex(theme.cover.glow);
    // Fog and key light are the two strongest cues that the place changed.
    if (this.scene?.fog instanceof THREE.FogExp2) {
      this.scene.fog.color.setHex(theme.fog.color);
      this.baseFogDensity = theme.fog.density;
      this.scene.fog.density = this.baseFogDensity * this.fogMul;
    }
    if (this.scene) this.scene.background = new THREE.Color(theme.fog.color);
    if (this.skyLight) {
      this.skyLight.color.setHex(theme.light.sky);
      this.skyLight.groundColor.setHex(theme.light.ground);
    }
    if (this.sunLight) this.sunLight.color.setHex(theme.light.sun);
    this.applyMutation(this.fogMul, this.sunMul, this.ambientMul);
  }

  /**
   * Apply an arena mutation. Only light intensity and fog density change: the
   * geometry, the octree and the AI never do, so a mutation cannot invalidate
   * anything the player already learned about the arena.
   */
  public applyMutation(fogMul: number, sunMul: number, ambientMul: number): void {
    this.fogMul = Math.max(0.2, fogMul);
    this.sunMul = Math.max(0.05, sunMul);
    this.ambientMul = Math.max(0.05, ambientMul);
    if (this.sunLight) this.sunLight.intensity = this.theme.light.sunIntensity * this.sunMul;
    if (this.skyLight) this.skyLight.intensity = this.theme.light.ambientIntensity * this.ambientMul;
    if (this.scene?.fog instanceof THREE.FogExp2) {
      this.scene.fog.density = this.baseFogDensity * this.fogMul;
    }
  }

  public build(scene: THREE.Scene): void {
    this.scene = scene;
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
    // The theme is part of the seed, so a shared seed code reproduces both the
    // layout AND the place. Consecutive seeds are spread across themes by
    // `mapForSeed`'s avalanche, so the rotation never looks like "next".
    const nextIndex = mapForSeed(seed);
    const changed = nextIndex !== this.themeIndex;
    if (changed) {
      this.themeIndex = nextIndex;
      // Fall back to the first theme rather than trusting the index: a bad
      // lookup must degrade to a different-looking arena, never to no arena.
      this.theme = MAPS[nextIndex] ?? (MAPS[0] as MapTheme);
    }
    // The colour pass runs on EVERY rebuild: the scene's fog and background
    // are owned by Game and created after build(), so this is the only place
    // that can guarantee they match the theme.
    this.applyTheme(this.theme, changed);
    const rnd = mulberry32(seed);
    this.generateCover(rnd);
    // Re-attach the fixed structures' cover spots. The generated layout owns
    // the first half of the list; the arena's landmarks are appended after it
    // so a claim can use either.
    this.coverSpots.push(...this.fixedCoverSpots);
    this.markPoints(rnd);
    this.coverMerged = this.mergeDirectMeshes(this.coverGroup, true);
    this.octree.clear();
    this.group.updateMatrixWorld(true);
    this.octree.fromGraphNode(this.group);
    if (this.sunLight) this.sunLight.shadow.needsUpdate = true;
  }

  /**
   * Apply a quality-tier shadow map size and re-arm the bake. The sun's
   * `autoUpdate` is disabled for the static arena, so a size or enabled change
   * must set `needsUpdate` or the map would never re-render.
   */
  public setShadowMapSize(size: number): void {
    if (!this.sunLight) return;
    this.sunLight.shadow.mapSize.set(size, size);
    this.sunLight.shadow.needsUpdate = true;
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
    if (this.skyLight) {
      this.skyLight.intensity = this.theme.light.ambientIntensity * this.ambientMul + flash * 2.4;
    }
    if (this.sunLight) {
      this.sunLight.intensity = this.theme.light.sunIntensity * this.sunMul + flash * 1.5;
    }
    if (t > 0.38) {
      this.lightningTime = -1;
      if (this.skyLight) this.skyLight.intensity = this.theme.light.ambientIntensity * this.ambientMul;
      if (this.sunLight) this.sunLight.intensity = this.theme.light.sunIntensity * this.sunMul;
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

  /**
   * The arena's fixed furniture. "Less is more" applied literally: this used
   * to be three berms, a bunker, two tarps, four sandbag nests, seven painted
   * stripes, and three work-lamp poles, and only ONE of those (the bunker)
   * changed a fight. The rest was scenery the AI could not use and the player
   * could not shoot.
   *
   * Every structure here now does at least one job, and each one registers its
   * own cover spots so the AI can claim it. That is the whole rule: if a thing
   * cannot be used, it is not built.
   */
  private buildRangeDetails(): void {
    const masonry = new THREE.MeshStandardMaterial({ color: this.theme.wall.body, roughness: 0.96, metalness: 0.01 });
    const concrete = new THREE.MeshStandardMaterial({ color: this.theme.wall.cap, roughness: 0.9, metalness: 0.03 });
    const steel = new THREE.MeshStandardMaterial({ color: this.theme.cover.dark, roughness: 0.58, metalness: 0.72 });
    const fabric = new THREE.MeshStandardMaterial({ color: this.theme.cover.crate, roughness: 0.98, metalness: 0.01 });
    const accent = new THREE.MeshStandardMaterial({ color: this.theme.cover.glow, roughness: 0.82, metalness: 0.05 });
    const dark = new THREE.MeshStandardMaterial({ color: this.theme.cover.dark, roughness: 0.86, metalness: 0.08 });
    this.rangeMaterials.push(masonry, concrete, steel, fabric, accent, dark);

    // ---------------------------------------------------------------------
    // 1. CENTRAL BUNKER. A hard two-sided anchor at the far end of the arena,
    //    which is the one place a player is guaranteed to need cover from.
    //    Two faces means it works from both sides, so it is a landmark rather
    //    than a one-way trap.
    // ---------------------------------------------------------------------
    this.solid(new THREE.BoxGeometry(9, 3.2, 4.4), concrete, 0, 1.6, -28);
    this.solid(new THREE.BoxGeometry(10, 0.35, 5.2), dark, 0, 3.3, -28);
    // A lit sill on the player-facing wall: the read that this is cover.
    this.solid(new THREE.BoxGeometry(7.2, 0.18, 0.18), accent, 0, 2.5, -25.65);
    this.markStructureCover(0, -28, 4.5, 2.2);

    // ---------------------------------------------------------------------
    // 2. WATCHTOWERS. Two, mirrored, at the mid-lines. Tall enough to break a
    //    long sight line and thin enough to fight around, which is the shape
    //    that makes a lane interesting.
    // ---------------------------------------------------------------------
    for (const [x, z] of [[-21, 0], [21, 0]] as Array<[number, number]>) {
      this.solid(new THREE.BoxGeometry(2.6, 4.6, 2.6), masonry, x, 2.3, z);
      this.solid(new THREE.BoxGeometry(3.2, 0.3, 3.2), dark, x, 4.75, z);
      this.solid(new THREE.BoxGeometry(3.0, 0.16, 0.16), accent, x, 4.1, z - 1.3);
      this.markStructureCover(x, z, 1.7, 1.7);
    }

    // ---------------------------------------------------------------------
    // 3. SANDBAG NESTS. Four, on the diagonals, low enough to shoot over when
    //    crouched and low enough to be worth crouching behind. This is the
    //    structure that makes the crouch key matter outside the slide.
    // ---------------------------------------------------------------------
    const bag = new THREE.BoxGeometry(1.3, 0.34, 0.55);
    for (const [x, z, ry] of [[-14, -14, 0.4], [14, -14, -0.4], [-14, 14, -0.4], [14, 14, 0.4]] as Array<[number, number, number]>) {
      for (let row = 0; row < 2; row++) {
        for (let col = 0; col < 3; col++) {
          const along = (col - 1) * 1.35;
          this.solid(bag, fabric, x + Math.cos(ry) * along, 0.17 + row * 0.34, z - Math.sin(ry) * along, ry);
        }
      }
      this.markStructureCover(x, z, 2.2, 1.0);
    }

    // ---------------------------------------------------------------------
    // 4. OVERHEAD TARPS. Two, replacing the old decorative pair. They now
    //    stand where they can block a sight line from the towers, so they are
    //    the one piece of cover that works from above as well as the side.
    // ---------------------------------------------------------------------
    const tarp = new THREE.BoxGeometry(6.5, 0.08, 3.4);
    for (const [x, z, ry] of [[-15, -9, 0], [15, 6, Math.PI / 2]] as Array<[number, number, number]>) {
      this.solid(tarp, fabric, x, 3.8, z, ry);
      const cos = Math.cos(ry);
      const sin = Math.sin(ry);
      for (const side of [-1, 1]) {
        this.solid(new THREE.BoxGeometry(0.16, 3.8, 0.16), steel, x + cos * side * 3.1, 1.9, z - sin * side * 3.1, ry);
      }
      this.markStructureCover(x, z, 3.4, 1.8);
    }
  }

  /**
   * Register the four firing positions around a fixed structure. Mirrors the
   * cover generator's `markCover`, but takes an explicit half-extent because
   * fixed structures are not all the same size, and it registers on BOTH the
   * long and the short axis so a corner is a valid fighting position.
   */
  private markStructureCover(x: number, z: number, halfX: number, halfZ: number): void {
    const reach = 1.3;
    const peek = 2.4;
    // Two faces per axis: the structure is cover from either side, which is
    // what stops a fixed landmark from becoming a one-way advantage.
    for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as Array<[number, number]>) {
      const cx = x + nx * (halfX + reach);
      const cz = z + nz * (halfZ + reach);
      // Peek points sit to either side of the stand point, along the face.
      const tx = nz === 0 ? 0 : 1;
      const tz = nx === 0 ? 0 : 1;
      this.fixedCoverSpots.push({
        center: new THREE.Vector3(cx, 0, cz),
        left: new THREE.Vector3(cx + tx * peek, 0, cz + tz * peek),
        right: new THREE.Vector3(cx - tx * peek, 0, cz - tz * peek),
      });
    }
  }

  private buildFloor(): void {
  const material = new THREE.MeshStandardMaterial({
    map: makeFloorTexture(this.theme),
    color: this.theme.floor.color,
    roughness: 0.48,
    metalness: 0.08,
  });
  this.floorMaterial = material;
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
    color: this.theme.wall.body,
    roughness: 0.88,
    metalness: 0.02,
  });
  const capMaterial = new THREE.MeshStandardMaterial({
    color: this.theme.wall.cap,
    roughness: 0.72,
    metalness: 0.16,
  });
  this.wallMaterial = wallMaterial;
  this.capMaterial = capMaterial;
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
  for (let t = -32; t <= 32; t += 8) {
    this.solid(buttressGeometry, wallMaterial, t, 1.9, -(ARENA_HALF - 0.2));
    this.solid(buttressGeometry, wallMaterial, t, 1.9, ARENA_HALF - 0.2);
    this.solid(buttressGeometry, wallMaterial, -(ARENA_HALF - 0.2), 1.9, t, Math.PI / 2);
    this.solid(buttressGeometry, wallMaterial, ARENA_HALF - 0.2, 1.9, t, Math.PI / 2);
  }
}

  /** Star dome above the walls — fog-free so it survives FogExp2. */
  private buildSky(scene: THREE.Scene): void {
  const skyMaterial = new THREE.MeshBasicMaterial({
    map: makeSkyTexture(this.theme),
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
  });
  this.skyMaterial = skyMaterial;
  const sky = new THREE.Mesh(
    new THREE.SphereGeometry(120, 32, 18),
    skyMaterial,
  );
  sky.renderOrder = -100;
  scene.add(sky);

  const sunMaterial = new THREE.MeshBasicMaterial({
    color: this.theme.light.sun, fog: false, transparent: true, opacity: 0.9,
  });
  this.sunDiscMaterial = sunMaterial;
  const sun = new THREE.Mesh(new THREE.CircleGeometry(4.8, 32), sunMaterial);
  sun.position.set(-58, 22, -84);
  sun.lookAt(0, 0, 0);
  sun.renderOrder = -99;
  scene.add(sun);

  const cloudMaterial = new THREE.MeshBasicMaterial({
    color: this.theme.fog.color,
    transparent: true,
    opacity: 0.16,
    depthWrite: false,
    fog: false,
    side: THREE.DoubleSide,
  });
  this.cloudMaterial = cloudMaterial;
  for (const [x, y, z, scaleX, scaleY] of [
    [-50, 56, -70, 42, 8],
    [40, 64, -58, 55, 10],
    [4, 74, 66, 62, 12],
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

    const crateMat = new THREE.MeshStandardMaterial({ color: this.theme.cover.crate, roughness: 0.6, metalness: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: this.theme.cover.dark, roughness: 0.55, metalness: 0.4 });
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c,
      emissive: this.theme.cover.glow,
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

    // Pillar ring — 6 random angles at radius 12–20
    for (let i = 0; i < 6; i++) {
      const a = rnd() * Math.PI * 2;
      const rad = 12 + rnd() * 8;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      add(pillar, crateMat, x, 2.1, z);
      add(plinth, darkMat, x, 0.15, z);
      add(capGeo, glowMat, x, 4.26, z);
      mark(x, z, 1.4);
    }

    // Scattered clusters (12–17), each rejected until it clears every footprint.
    // The theme's density multiplier scales the count: FROST LINE is sparse
    // (long sight lines, little free cover) and RUST WORKS is crowded, which
    // changes how a wave plays without changing how the AI works.
    const clusters = Math.max(6, Math.round((12 + Math.floor(rnd() * 6)) * this.theme.density));
    for (let i = 0; i < clusters; i++) {
      let x = 0;
      let z = 0;
      let ok = false;
      for (let tries = 0; tries < 14 && !ok; tries++) {
        const a = rnd() * Math.PI * 2;
        const rad = 6 + rnd() * 20;
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
    this.skyLight = new THREE.HemisphereLight(
      this.theme.light.sky, this.theme.light.ground, this.theme.light.ambientIntensity,
    );
    scene.add(this.skyLight);

    this.sunLight = new THREE.DirectionalLight(this.theme.light.sun, this.theme.light.sunIntensity);
    this.sunLight.position.set(-30, 42, -24);
    this.sunLight.castShadow = true;
    this.sunLight.shadow.mapSize.set(1536, 1536);
    this.sunLight.shadow.camera.left = -44;
    this.sunLight.shadow.camera.right = 44;
    this.sunLight.shadow.camera.top = 44;
    this.sunLight.shadow.camera.bottom = -44;
    this.sunLight.shadow.camera.near = 1;
    this.sunLight.shadow.camera.far = 130;
    this.sunLight.shadow.bias = -0.00035;
    // Sun is static: bake the shadow map once instead of re-rendering all
    // casters every frame; rebuild() re-arms it after cover geometry changes.
    this.sunLight.shadow.autoUpdate = false;
    this.sunLight.shadow.needsUpdate = true;
    this.sunLight.target.position.set(0, 0, 0);
    scene.add(this.sunLight, this.sunLight.target);

    // Three work lamps, hung on the structures that actually exist. Each one
    // sits above a fixed landmark, so the light and the thing you fight around
    // are the same object: a lamp in empty space is decoration.
    for (const [x, y, z] of [[-21, 5.2, 0], [21, 5.2, 0], [0, 4.4, -26]] as Array<[number, number, number]>) {
      const light = new THREE.PointLight(this.theme.cover.glow, 26, 26, 2);
      light.position.set(x, y, z);
      this.rangeLamps.push(light);
      scene.add(light);
    }
  }

  private buildDust(): void {
    const count = 220;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 72;
      positions[i * 3 + 1] = Math.random() * 5 + 0.2;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 72;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const material = new THREE.PointsMaterial({
      color: this.theme.dust,
      size: 0.045,
      transparent: true,
      opacity: 0.28,
      depthWrite: false,
      fog: true,
    });
    this.dustMaterial = material;
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
      const rad = 5 + rnd() * 24;
      const x = Math.cos(a) * rad;
      const z = Math.sin(a) * rad;
      if (this.footprints.some((f) => Math.hypot(f.x - x, f.z - z) < f.r + 1.3)) continue;
      if (this.pickupPoints.some((p) => (p.x - x) * (p.x - x) + (p.z - z) * (p.z - z) < 36)) continue;
      this.pickupPoints.push(new THREE.Vector3(x, 0, z));
      placed++;
    }
    // Fallback ring keeps the run playable even in a crowded layout
    const fallback: Array<[number, number]> = [
      [10, 0], [-10, 0], [0, 10], [0, -10], [19, 0], [-19, 0], [0, 19], [0, -19],
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
