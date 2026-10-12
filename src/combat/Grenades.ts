/**
 * Throwables: frag, smoke, and EMP.
 *
 * The fuse model follows the standard FPS design: a fixed fuse that a bounce
 * SHORTENS (Rainbow Six Siege drops 4 s to 2 s on the first surface contact),
 * plus a cook-hold so a confident player can time an airburst. Cooking is what
 * turns a grenade from "area denial" into "aimed weapon", so it is worth the
 * extra input.
 *
 * Physics are deliberately simple: gravity, one restitution bounce, linear
 * drag, and a swept capsule probe against the octree so a fast throw cannot
 * tunnel through a wall.
 */
import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { Effects } from '../render/Effects';
import type { GameAudio } from '../audio/Audio';
import { clamp } from '../core/math';

export type GrenadeKind = 'frag' | 'smoke' | 'emp';

interface GrenadeDef {
  /** Seconds from throw to detonation. */
  fuse: number;
  /** Seconds subtracted per surface bounce (fuse floor 0.4 s). */
  bounceFuse: number;
  /** Blast radius in metres. */
  radius: number;
  /** Damage at the centre. */
  damage: number;
  /** Damage at the edge as a fraction of centre. */
  floor: number;
  /** Field lifetime after detonation. */
  effectLife: number;
  color: number;
  /** Non-damage kinds spawn a persistent field (smoke / EMP) instead. */
  field: boolean;
}

export const GRENADE_DEFS: Record<GrenadeKind, GrenadeDef> = {
  frag: {
    fuse: 3.0, bounceFuse: 0.8, radius: 4.6, damage: 130, floor: 0.3,
    effectLife: 0.35, color: 0xff8a3c, field: false,
  },
  smoke: {
    fuse: 1.6, bounceFuse: 0.4, radius: 4.0, damage: 0, floor: 0,
    effectLife: 11, color: 0xd8d8d8, field: true,
  },
  emp: {
    fuse: 1.2, bounceFuse: 0.4, radius: 7.0, damage: 25, floor: 0.5,
    effectLife: 2.5, color: 0x7dd8ff, field: true,
  },
};

const POOL = 6;
const GRAVITY = 19;
const RESTITUTION = 0.42;
const DRAG = 0.12;
const BODY_RADIUS = 0.13;

interface Grenade {
  mesh: THREE.Mesh;
  glow: THREE.Mesh;
  vel: THREE.Vector3;
  fuse: number;
  kind: GrenadeKind;
  active: boolean;
}

/** A live smoke cloud or EMP field. */
export interface FieldEffect {
  kind: GrenadeKind;
  center: THREE.Vector3;
  radius: number;
  life: number;
  maxLife: number;
  mesh: THREE.Mesh | null;
}

export class Grenades {
  public onExplode: ((kind: GrenadeKind, point: THREE.Vector3, radius: number) => void) | null = null;

  private readonly group = new THREE.Group();
  private readonly grenades: Grenade[] = [];
  private readonly fields: FieldEffect[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly probe = new Capsule(new THREE.Vector3(), new THREE.Vector3(), BODY_RADIUS);

  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
  ) {
    scene.add(this.group);
    const geo = new THREE.IcosahedronGeometry(BODY_RADIUS, 1);
    for (let i = 0; i < POOL; i++) {
      const mesh = new THREE.Mesh(
        geo,
        new THREE.MeshStandardMaterial({ color: 0x2b2f22, roughness: 0.7, metalness: 0.4 }),
      );
      mesh.visible = false;
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.05, 8, 6),
        new THREE.MeshBasicMaterial({ color: 0xff5040 }),
      );
      glow.position.y = BODY_RADIUS;
      mesh.add(glow);
      this.group.add(mesh);
      this.grenades.push({
        mesh,
        glow,
        vel: new THREE.Vector3(),
        fuse: 0,
        kind: 'frag',
        active: false,
      });
    }
  }

  public get activeFields(): readonly FieldEffect[] {
    return this.fields;
  }

  /** True when the point sits inside a live smoke cloud (AI respects this). */
  public isSmoked(point: THREE.Vector3): boolean {
    for (const field of this.fields) {
      if (field.kind !== 'smoke') continue;
      const dx = point.x - field.center.x;
      const dz = point.z - field.center.z;
      const dy = point.y - field.center.y;
      if (dx * dx + dz * dz + dy * dy * 0.35 <= field.radius * field.radius) return true;
    }
    return false;
  }

  /** True when the point sits inside a live EMP field (shields disabled). */
  public isEmped(point: THREE.Vector3): boolean {
    for (const field of this.fields) {
      if (field.kind !== 'emp') continue;
      if (point.distanceToSquared(field.center) <= field.radius * field.radius) return true;
    }
    return false;
  }

  public clear(): void {
    for (const g of this.grenades) {
      g.active = false;
      g.mesh.visible = false;
    }
    for (const field of this.fields) {
      if (field.mesh) {
        this.group.remove(field.mesh);
        field.mesh.geometry.dispose();
      }
    }
    this.fields.length = 0;
  }

  /**
   * Throw from `origin` along `dir`. `power` is 0..1 (cook strength): a full
   * cook throws at 17 m/s, a quick tap at 9 m/s.
   */
  public throwGrenade(
    kind: GrenadeKind,
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    power: number,
  ): boolean {
    const g = this.grenades.find((n) => !n.active);
    if (!g) return false;
    const def = GRENADE_DEFS[kind];
    const p = clamp(power, 0, 1);
    g.kind = kind;
    g.active = true;
    g.mesh.visible = true;
    g.mesh.position.copy(origin).addScaledVector(dir, 0.55);
    g.vel.copy(dir).multiplyScalar(9 + p * 8);
    g.vel.y += 1.6 + p * 1.4;
    g.fuse = def.fuse;
    (g.glow.material as THREE.MeshBasicMaterial).color.setHex(def.color);
    this.audio.grenadeThrow();
    return true;
  }

  public update(
    dt: number,
    damageEnemy: (
      point: THREE.Vector3,
      radius: number,
      damage: number,
      floor: number,
    ) => { killed: number; dealt: number },
  ): void {
    for (const g of this.grenades) {
      if (!g.active) continue;
      const def = GRENADE_DEFS[g.kind];
      g.fuse -= dt;
      g.vel.y -= GRAVITY * dt;
      g.vel.multiplyScalar(1 - DRAG * dt);
      const step = this.tmp.copy(g.vel).multiplyScalar(dt);
      const length = step.length();
      if (length > 1e-5) {
        const hit = this.sweep(g.mesh.position, step, length);
        if (hit) {
          g.mesh.position.addScaledVector(hit.normal, hit.depth);
          const into = g.vel.dot(hit.normal);
          if (into < 0) {
            g.vel.addScaledVector(hit.normal, -into * (1 + RESTITUTION));
            g.vel.multiplyScalar(0.72);
            g.fuse = Math.max(0.4, g.fuse - def.bounceFuse);
            this.effects.impact(g.mesh.position.clone(), hit.normal);
          }
        }
      }
      g.mesh.position.addScaledVector(g.vel, dt);
      // Spin for readability — a grenade that does not tumble is unreadable.
      g.mesh.rotation.x += dt * 7;
      g.mesh.rotation.z += dt * 4.5;
      // The glow blinks faster as the fuse runs out: the standard readability
      // cue that says "this is about to go off" without any UI.
      const t = Math.max(0, g.fuse);
      const hz = t < 1 ? 14 : 5;
      g.glow.visible = Math.floor(t * hz * 2) % 2 === 0;
      g.glow.scale.setScalar(1 + (1 - Math.min(1, t / def.fuse)) * 0.7);
      if (g.fuse <= 0) this.detonate(g, def, damageEnemy);
    }

    for (let i = this.fields.length - 1; i >= 0; i--) {
      const field = this.fields[i];
      if (!field) continue;
      field.life -= dt;
      if (field.mesh) {
        const k = Math.max(0, Math.min(1, field.life / Math.max(0.001, field.maxLife)));
        (field.mesh.material as THREE.MeshBasicMaterial).opacity = 0.12 * k;
      }
      if (field.life <= 0) {
        if (field.mesh) {
          this.group.remove(field.mesh);
          field.mesh.geometry.dispose();
        }
        this.fields.splice(i, 1);
      }
    }
  }

  private detonate(
    g: Grenade,
    def: GrenadeDef,
    damageEnemy: (
      point: THREE.Vector3,
      radius: number,
      damage: number,
      floor: number,
    ) => { killed: number; dealt: number },
  ): void {
    const point = this.tmp.copy(g.mesh.position);
    const kind = g.kind;
    g.active = false;
    g.mesh.visible = false;
    this.effects.ring(point, def.color, def.radius * 2.6, 0.5);
    this.effects.burst(point, def.color, kind === 'smoke' ? 8 : 22, kind === 'smoke' ? 0.8 : 2.6);
    if (kind !== 'smoke') this.audio.blast();
    if (def.damage > 0) damageEnemy(point.clone(), def.radius, def.damage, def.floor);
    if (kind === 'smoke') {
      this.effects.smokeBurst(point.clone(), def.radius);
      this.fields.push({
        kind: 'smoke', center: point.clone(), radius: def.radius,
        life: def.effectLife, maxLife: def.effectLife, mesh: null,
      });
    } else if (kind === 'emp') {
      const mesh = new THREE.Mesh(
        new THREE.SphereGeometry(def.radius * 0.5, 12, 8),
        new THREE.MeshBasicMaterial({
          color: 0x7dd8ff, transparent: true, opacity: 0.12, wireframe: true,
        }),
      );
      mesh.position.copy(point);
      this.group.add(mesh);
      this.fields.push({
        kind: 'emp', center: point.clone(), radius: def.radius,
        life: def.effectLife, maxLife: def.effectLife, mesh,
      });
    }
    this.onExplode?.(kind, point.clone(), def.radius);
  }

  /**
   * Swept capsule probe: march a body-radius capsule along `step` in sub-steps
   * of at most one radius. Sampling (rather than a single raycast) also catches
   * the case where the throw begins already overlapping geometry.
   */
  private sweep(
    from: THREE.Vector3,
    step: THREE.Vector3,
    distance: number,
  ): { normal: THREE.Vector3; depth: number } | null {
    const dir = this.tmp2.copy(step).normalize();
    const steps = Math.max(1, Math.ceil(distance / (BODY_RADIUS * 0.9)));
    for (let i = 1; i <= steps; i++) {
      const t = (i / steps) * distance;
      this.probe.start.copy(from).addScaledVector(dir, t);
      this.probe.end.copy(this.probe.start);
      const hit = this.octree.capsuleIntersect(this.probe);
      if (hit) return { normal: hit.normal.clone(), depth: hit.depth };
    }
    return null;
  }
}
