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

const TRACER_POOL = 24;
const SPARK_POOL = 48;
const RING_POOL = 8;

/** Pooled, allocation-free hit effects: tracers, impact sparks, expanding rings. */
export class Effects {
  public readonly group = new THREE.Group();
  private readonly tracers: Tracer[] = [];
  private readonly sparks: Spark[] = [];
  private readonly rings: Ring[] = [];
  private tracerCursor = 0;
  private sparkCursor = 0;
  private ringCursor = 0;
  private readonly tmpDir = new THREE.Vector3();

  private readonly tracerGeo = new THREE.BoxGeometry(0.02, 0.02, 1);
  private readonly sparkGeo = new THREE.BoxGeometry(0.05, 0.05, 0.05);
  private readonly ringGeo = new THREE.RingGeometry(0.42, 0.5, 32);
  private readonly tracerMats = new Map<number, THREE.MeshBasicMaterial>();
  private readonly sparkMat = new THREE.MeshBasicMaterial({ color: 0xffc46b });
  private readonly ringMat = new THREE.MeshBasicMaterial({
    color: 0x9fd0ff,
    transparent: true,
    opacity: 0.9,
    side: THREE.DoubleSide,
    depthWrite: false,
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
    t.mesh.scale.set(1, 1, len);
    t.mesh.lookAt(to);
    t.mesh.visible = true;
    t.life = 0.07;
  }

  public impact(point: THREE.Vector3, normal: THREE.Vector3): void {
    for (let i = 0; i < 4; i++) {
      const s = this.sparks[this.sparkCursor];
      this.sparkCursor = (this.sparkCursor + 1) % SPARK_POOL;
      if (!s) continue;
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
  }

  private getTracerMat(color: number): THREE.MeshBasicMaterial {
    let mat = this.tracerMats.get(color);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9 });
      this.tracerMats.set(color, mat);
    }
    return mat;
  }
}
