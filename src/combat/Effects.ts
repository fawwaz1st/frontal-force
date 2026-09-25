import * as THREE from 'three';

interface Tracer {
  mesh: THREE.Mesh;
  life: number;
}

interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  grow: number;
}

interface Casing {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  spin: THREE.Vector3;
  life: number;
}

interface SmokePuff {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
}

const TRACER_POOL = 24;
const SPARK_POOL = 48;
const RING_POOL = 8;
const CASING_POOL = 48;
const SMOKE_POOL = 24;
const DECAL_POOL = 48;

/** Pooled, allocation-free hit effects: tracers, impact sparks, expanding rings. */
export class Effects {
  private readonly group = new THREE.Group();
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly rings: Ring[] = [];
  private tracerCursor = 0;
  private sparkCursor = 0;
  private ringCursor = 0;
  private casingCursor = 0;
  private smokeCursor = 0;
  private decalCursor = 0;
  private readonly casings: Casing[] = [];
  private readonly smokes: SmokePuff[] = [];
  private readonly decals: { mesh: THREE.Mesh }[] = [];
  private readonly tmpDir = new THREE.Vector3();

  private readonly tracerGeo = new THREE.OctahedronGeometry(1, 0);
  private readonly sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  private readonly ringGeo = new THREE.RingGeometry(0.42, 0.5, 32);
  private readonly casingGeo = new THREE.BoxGeometry(0.014, 0.014, 0.055);
  private readonly smokeGeo = new THREE.SphereGeometry(0.06, 6, 6);
  private readonly decalGeo = new THREE.CircleGeometry(0.035, 6);
  private readonly decalMat = new THREE.MeshBasicMaterial({
    color: 0x05060a, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -4,
  });
  private readonly tracerMats = new Map<number, THREE.MeshBasicMaterial>();
  private readonly sparkMats = new Map<number, THREE.MeshBasicMaterial>();
  private readonly sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fd0ff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
  });
  private readonly casingMat = new THREE.MeshStandardMaterial({
    color: 0xd8a94a, roughness: 0.35, metalness: 0.8, emissive: 0x2a1d05, emissiveIntensity: 0.6,
  });
  private readonly smokeMat = new THREE.MeshBasicMaterial({
    color: 0xb9b4a4, transparent: true, opacity: 0.16, depthWrite: false,
  });

  public constructor(scene: THREE.Scene) {
    scene.add(this.group);
    for (let i = 0; i < TRACER_POOL; i++) {
      const mesh = new THREE.Mesh(this.tracerGeo, this.getTracerMat(0xffffff));
      mesh.visible = false;
      this.group.add(mesh);
      this.tracers.push({ mesh, life: 0 });
    }
    for (let i = 0; i < SPARK_POOL; i++) {
      const mesh = new THREE.Mesh(this.sparkGeo, this.sparkMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.sparks.push({ mesh, vel: new THREE.Vector3(), life: 0 });
    }
    for (let i = 0; i < RING_POOL; i++) {
      const mesh = new THREE.Mesh(this.ringGeo, this.ringMat.clone());
      mesh.visible = false;
      this.group.add(mesh);
      this.rings.push({ mesh, life: 0, maxLife: 0.4, grow: 6 });
    }
    for (let i = 0; i < CASING_POOL; i++) {
      const mesh = new THREE.Mesh(this.casingGeo, this.casingMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.casings.push({ mesh, vel: new THREE.Vector3(), spin: new THREE.Vector3(), life: 0 });
    }
    for (let i = 0; i < SMOKE_POOL; i++) {
      const mesh = new THREE.Mesh(this.smokeGeo, this.smokeMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.smokes.push({ mesh, vel: new THREE.Vector3(), life: 0 });
    }
    for (let i = 0; i < DECAL_POOL; i++) {
      const mesh = new THREE.Mesh(this.decalGeo, this.decalMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.decals.push({ mesh });
    }
  }

  /** Bullet hole on a wall — pooled flat disc aligned to the surface normal. */
  public decal(point: THREE.Vector3, normal: THREE.Vector3): void {
    const d = this.decals[this.decalCursor];
    this.decalCursor = (this.decalCursor + 1) % DECAL_POOL;
    if (!d) return;
    d.mesh.visible = true;
    d.mesh.position.copy(point).addScaledVector(normal, 0.015);
    this.tmpDir.set(0, 0, 1);
    d.mesh.quaternion.setFromUnitVectors(this.tmpDir, normal);
    d.mesh.rotateZ(Math.random() * Math.PI * 2);
    d.mesh.scale.setScalar(0.7 + Math.random() * 0.7);
  }

  /** Clear every transient visual between runs. */
  public reset(): void {
    for (const t of this.tracers) { t.life = 0; t.mesh.visible = false; }
    for (const s of this.sparks) { s.life = 0; s.mesh.visible = false; }
    for (const r of this.rings) { r.life = 0; r.mesh.visible = false; }
    for (const c of this.casings) { c.life = 0; c.mesh.visible = false; }
    for (const s of this.smokes) { s.life = 0; s.mesh.visible = false; }
    for (const d of this.decals) d.mesh.visible = false;
    this.tracerCursor = this.sparkCursor = this.ringCursor = 0;
    this.casingCursor = this.smokeCursor = this.decalCursor = 0;
  }

  public tracer(from: THREE.Vector3, to: THREE.Vector3, color: number): void {
    const t = this.tracers[this.tracerCursor];
    this.tracerCursor = (this.tracerCursor + 1) % TRACER_POOL;
    if (!t) return;
    const dir = this.tmpDir.copy(to).sub(from);
    const len = dir.length();
    if (len < 0.01) return;
    t.mesh.material = this.getTracerMat(color);
    t.mesh.position.copy(from).addScaledVector(dir, 0.5);
    t.mesh.scale.set(0.03, 0.03, len * 0.5);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  public impact(point: THREE.Vector3, normal: THREE.Vector3): void {
    const mat = this.getSparkMat(0xffc46b);
    for (let i = 0; i < 4; i++) {
      const s = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_POOL;
      if (!s) continue;
      s.mesh.material = mat;
      s.mesh.position.copy(point);
      s.vel.set(
        normal.x + (Math.random() - 0.5) * 1.4,
        normal.y + Math.random() * 1.2,
        normal.z + (Math.random() - 0.5) * 1.4,
      ).multiplyScalar(3.2);
      s.mesh.visible = true;
      s.life = 0.28 + Math.random() * 0.12;
    }
  }

  /** Colored spark splash (kill pops, muzzle flashes, ally death). */
  public burst(point: THREE.Vector3, color: number, count = 6, speed = 1): void {
    const mat = this.getSparkMat(color);
    for (let i = 0; i < count; i++) {
      const s = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_POOL;
      if (!s) continue;
      s.mesh.material = mat;
      s.mesh.position.copy(point);
      s.vel.set(
        (Math.random() - 0.5) * 2,
        Math.random() * 1.4,
        (Math.random() - 0.5) * 2,
      ).multiplyScalar((2 + Math.random() * 2.4) * speed);
      s.mesh.visible = true;
      s.life = 0.22 + Math.random() * 0.2;
    }
  }

  private getSparkMat(color: number): THREE.MeshBasicMaterial {
    if (color === 0xffc46b) return this.sparkMat;
    let mat = this.sparkMats.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color });
      this.sparkMats.set(color, mat);
    }
    return mat;
  }

  /** Eject a brass casing with velocity — gravity + floor bounce in update(). */
  public casing(pos: THREE.Vector3, vel: THREE.Vector3): void {
    const c = this.casings[this.casingCursor];
    this.casingCursor = (this.casingCursor + 1) % CASING_POOL;
    if (!c) return;
    c.mesh.position.copy(pos);
    c.mesh.visible = true;
    c.mesh.scale.setScalar(1);
    c.vel.copy(vel);
    c.spin.set(Math.random() * 14 - 7, Math.random() * 14 - 7, Math.random() * 14 - 7);
    c.life = 2.6;
  }

  /** Rising smoke puff at the muzzle (shared material; expands and then disappears). */
  public smoke(pos: THREE.Vector3, dir?: THREE.Vector3): void {
    const s = this.smokes[this.smokeCursor];
    this.smokeCursor = (this.smokeCursor + 1) % SMOKE_POOL;
    if (!s) return;
    s.mesh.position.copy(pos);
    s.mesh.visible = true;
    s.mesh.scale.setScalar(0.6);
    s.vel.set(
      (Math.random() - 0.5) * 0.4,
      0.55 + Math.random() * 0.3,
      (Math.random() - 0.5) * 0.4,
    );
    if (dir) s.vel.addScaledVector(dir, 0.7);
    s.life = 0.55;
  }

  public ring(point: THREE.Vector3, color: number, grow = 6, maxLife = 0.4): void {
    const r = this.rings[this.ringCursor];
    this.ringCursor = (this.ringCursor + 1) % RING_POOL;
    if (!r) return;
    (r.mesh.material as THREE.MeshBasicMaterial).color.setHex(color);
    r.mesh.position.copy(point);
    r.mesh.scale.setScalar(0.2);
    r.mesh.visible = true;
    r.life = maxLife;
    r.maxLife = maxLife;
    r.grow = grow;
  }

  public update(dt: number, camera: THREE.Camera): void {
    for (const t of this.tracers) {
      if (t.life <= 0) continue;
      t.life -= dt;
      if (t.life <= 0) t.mesh.visible = false;
    }
    for (const s of this.sparks) {
      if (s.life <= 0) continue;
      s.life -= dt;
      s.vel.y -= 14 * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.life <= 0) s.mesh.visible = false;
    }
    for (const r of this.rings) {
      if (r.life <= 0) continue;
      r.life -= dt;
      const k = 1 - r.life / r.maxLife;
      r.mesh.scale.setScalar(0.2 + k * r.grow);
      r.mesh.lookAt(camera.position);
      const mat = r.mesh.material as THREE.MeshBasicMaterial;
      mat.opacity = 0.9 * (1 - k);
      if (r.life <= 0) r.mesh.visible = false;
    }
    for (const c of this.casings) {
      if (c.life <= 0) continue;
      c.life -= dt;
      if (c.life <= 0) {
        c.mesh.visible = false;
        continue;
      }
      c.vel.y -= 16 * dt;
      c.mesh.position.addScaledVector(c.vel, dt);
      if (c.mesh.position.y <= 0.012) {
        c.mesh.position.y = 0.012;
        c.vel.y = -c.vel.y * 0.35;
        c.vel.x *= 0.6;
        c.vel.z *= 0.6;
        if (Math.abs(c.vel.y) < 0.5) c.vel.y = 0;
      }
      c.mesh.rotation.x += c.spin.x * dt;
      c.mesh.rotation.y += c.spin.y * dt;
      c.mesh.rotation.z += c.spin.z * dt;
      if (c.life < 0.5) c.mesh.scale.setScalar(c.life / 0.5);
    }
    for (const s of this.smokes) {
      if (s.life <= 0) continue;
      s.life -= dt;
      if (s.life <= 0) {
        s.mesh.visible = false;
        continue;
      }
      s.mesh.position.addScaledVector(s.vel, dt);
      s.vel.y -= 0.4 * dt;
      s.mesh.scale.setScalar(0.6 + (1 - s.life / 0.55) * 1.3);
    }
  }

  private getTracerMat(color: number): THREE.MeshBasicMaterial {
    let mat = this.tracerMats.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.95,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.tracerMats.set(color, mat);
    }
    return mat;
  }
}
