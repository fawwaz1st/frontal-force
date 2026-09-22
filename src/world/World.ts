import * as THREE from 'three';
import { Octree } from 'three/addons/math/Octree.js';

const ARENA_HALF = 31;

function makeFloorTexture(): THREE.CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = 512;
  const g = canvas.getContext('2d') as CanvasRenderingContext2D;
  g.fillStyle = '#0a101d';
  g.fillRect(0, 0, 512, 512);
  g.strokeStyle = 'rgba(96, 148, 255, 0.14)';
  g.lineWidth = 2;
  for (let i = 0; i <= 8; i++) {
    const p = i * 64;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, 512); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(512, p); g.stroke();
  }
  for (let i = 0; i < 1600; i++) {
    g.fillStyle = `rgba(255,255,255,${Math.random() * 0.045})`;
    g.fillRect(Math.random() * 512, Math.random() * 512, 2, 2);
  }
  const tex = new THREE.CanvasTexture(canvas);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(8, 8);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Static arena: visuals, lights, spawn/pickup points, and the collision octree. */
export class World {
  public readonly group = new THREE.Group();
  public readonly octree = new Octree();
  public readonly spawnPoints: THREE.Vector3[] = [];
  public readonly pickupPoints: THREE.Vector3[] = [];
  public readonly bounds = ARENA_HALF - 1;
  private dust: THREE.Points | null = null;

  public build(scene: THREE.Scene): void {
    this.buildFloor();
    this.buildWalls();
    this.buildCover();
    this.buildLights(scene);
    this.buildDust();
    this.markPoints();
    scene.add(this.group);
    this.group.updateMatrixWorld(true);
    this.octree.fromGraphNode(this.group);
  }

  public update(dt: number): void {
    if (this.dust) this.dust.rotation.y += dt * 0.008;
  }

  private solid(
    geo: THREE.BufferGeometry,
    mat: THREE.Material,
    x: number, y: number, z: number,
    ry = 0,
  ): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(x, y, z);
    mesh.rotation.y = ry;
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    this.group.add(mesh);
    return mesh;
  }

  private buildFloor(): void {
    const mat = new THREE.MeshStandardMaterial({
      map: makeFloorTexture(),
      roughness: 0.85,
      metalness: 0.15,
    });
    const floor = new THREE.Mesh(new THREE.BoxGeometry(64, 1, 64), mat);
    floor.position.y = -0.5;
    floor.receiveShadow = true;
    this.group.add(floor);
  }

  private buildWalls(): void {
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x182238, roughness: 0.7, metalness: 0.3 });
    const trimMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c,
      emissive: 0x3f7bff,
      emissiveIntensity: 2.2,
      roughness: 0.4,
    });
    const wallGeo = new THREE.BoxGeometry(64, 5, 1);
    const trimGeo = new THREE.BoxGeometry(64, 0.12, 0.12);
    const sides: Array<[number, number, number]> = [
      [0, -ARENA_HALF - 0.5, 0],
      [0, ARENA_HALF + 0.5, 0],
      [-ARENA_HALF - 0.5, 0, Math.PI / 2],
      [ARENA_HALF + 0.5, 0, Math.PI / 2],
    ];
    for (const [x, z, ry] of sides) {
      this.solid(wallGeo, wallMat, x, 2.5, z, ry);
      const trim = new THREE.Mesh(trimGeo, trimMat);
      trim.position.set(x, 3.4, z);
      trim.rotation.y = ry;
      this.group.add(trim);
    }
  }

  private buildCover(): void {
    const crateMat = new THREE.MeshStandardMaterial({ color: 0x24304c, roughness: 0.6, metalness: 0.35 });
    const darkMat = new THREE.MeshStandardMaterial({ color: 0x141c2e, roughness: 0.55, metalness: 0.4 });
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c,
      emissive: 0xff7a33,
      emissiveIntensity: 1.6,
      roughness: 0.4,
    });

    const crate = new THREE.BoxGeometry(1.4, 1.4, 1.4);
    const slab = new THREE.BoxGeometry(4.5, 2.2, 0.9);
    const pillar = new THREE.BoxGeometry(1.1, 4.2, 1.1);

    // Central cross structure
    this.solid(new THREE.BoxGeometry(3.2, 2.4, 3.2), darkMat, 0, 1.2, 0);
    this.solid(new THREE.BoxGeometry(1.2, 3.4, 1.2), darkMat, 0, 1.7, 0);
    const ring = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.1, 3.4), glowMat);
    ring.position.set(0, 2.45, 0);
    this.group.add(ring);

    // L-shaped covers in each quadrant (mirrored for fairness)
    const quads: Array<[number, number, number]> = [
      [12, 12, 0],
      [-12, 12, Math.PI / 2],
      [-12, -12, Math.PI],
      [12, -12, -Math.PI / 2],
    ];
    for (const [x, z, ry] of quads) {
      this.solid(slab, crateMat, x, 1.1, z, ry);
      this.solid(slab, crateMat, x + Math.cos(ry + Math.PI / 2) * 2.6, 1.1, z - Math.sin(ry + Math.PI / 2) * 2.6, ry + Math.PI / 2);
      this.solid(crate, darkMat, x - Math.cos(ry) * 3.4, 0.7, z + Math.sin(ry) * 3.4, ry);
    }

    // Pillars mid-lanes
    for (const [x, z] of [[20, 0], [-20, 0], [0, 20], [0, -20]] as Array<[number, number]>) {
      this.solid(pillar, crateMat, x, 2.1, z);
      const cap = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.12, 1.3), glowMat);
      cap.position.set(x, 4.26, z);
      this.group.add(cap);
    }

    // Scattered crates
    const spots: Array<[number, number, number]> = [
      [6, 22, 0.4], [-7, 20, 1.2], [22, 7, 0.9], [21, -8, 0.2],
      [-22, 6, 1.9], [-20, -9, 0.7], [7, -21, 1.4], [-6, -22, 0.1],
      [16, 16, 0.8], [-16, 16, 2.2], [-16, -16, 1.1], [16, -16, 0.3],
    ];
    for (const [x, z, ry] of spots) {
      this.solid(crate, crateMat, x, 0.7, z, ry);
    }
  }

  private buildLights(scene: THREE.Scene): void {
    scene.add(new THREE.HemisphereLight(0x44598c, 0x0a0e18, 0.85));

    const sun = new THREE.DirectionalLight(0xbfd4ff, 2.4);
    sun.position.set(18, 30, 12);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    sun.shadow.camera.left = -40;
    sun.shadow.camera.right = 40;
    sun.shadow.camera.top = 40;
    sun.shadow.camera.bottom = -40;
    sun.shadow.camera.far = 80;
    sun.shadow.bias = -0.0004;
    scene.add(sun);

    const accents: Array<[number, number, number, number]> = [
      [24, 3, 24, 0x35c8ff],
      [-24, 3, 24, 0xff8a3d],
      [-24, 3, -24, 0x35c8ff],
      [24, 3, -24, 0xff8a3d],
      [0, 4.5, 0, 0x5f8cff],
    ];
    for (const [x, y, z, color] of accents) {
      const light = new THREE.PointLight(color, 42, 30, 2);
      light.position.set(x, y, z);
      scene.add(light);
    }
  }

  private buildDust(): void {
    const count = 260;
    const positions = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      positions[i * 3] = (Math.random() - 0.5) * 60;
      positions[i * 3 + 1] = Math.random() * 6 + 0.3;
      positions[i * 3 + 2] = (Math.random() - 0.5) * 60;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const mat = new THREE.PointsMaterial({
      color: 0x7fa8ff,
      size: 0.05,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
    });
    this.dust = new THREE.Points(geo, mat);
    this.group.add(this.dust);
  }

  private markPoints(): void {
    const r = ARENA_HALF - 4;
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2 + Math.PI / 8;
      this.spawnPoints.push(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r));
    }
    const spots: Array<[number, number]> = [
      [0, 6.5], [0, -6.5], [6.5, 0], [-6.5, 0],
      [18, 18], [-18, 18], [-18, -18], [18, -18],
      [24, 3], [-24, -3],
    ];
    for (const [x, z] of spots) {
      this.pickupPoints.push(new THREE.Vector3(x, 0, z));
    }
  }
}
