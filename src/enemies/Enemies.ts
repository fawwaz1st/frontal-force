import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { Effects } from '../combat/Effects';
import type { GameAudio } from '../audio/Audio';
import { clamp, dampAngle, randRange } from '../core/math';

export type EnemyKind = 'grunt' | 'rusher' | 'gunner';

interface EnemyDef {
  health: number;
  speed: number;
  radius: number;
  height: number;
  color: number;
  attackRange: number;
  attackCooldown: number;
  damage: number;
  score: number;
}

const DEFS: Record<EnemyKind, EnemyDef> = {
  grunt: { health: 60, speed: 3.4, radius: 0.42, height: 1.7, color: 0xd95cff, attackRange: 26, attackCooldown: 1.6, damage: 8, score: 100 },
  rusher: { health: 40, speed: 6.2, radius: 0.38, height: 1.4, color: 0xff5c5c, attackRange: 1.7, attackCooldown: 0.9, damage: 14, score: 150 },
  gunner: { health: 110, speed: 2.2, radius: 0.5, height: 1.9, color: 0xffb03a, attackRange: 30, attackCooldown: 2.4, damage: 12, score: 250 },
};

export interface Enemy {
  kind: EnemyKind;
  def: EnemyDef;
  health: number;
  maxHealth: number;
  group: THREE.Group;
  body: THREE.Mesh;
  eye: THREE.Mesh;
  collider: Capsule;
  attackTimer: number;
  strafeSeed: number;
  spawnTimer: number;
  dead: boolean;
  deadT: number;
}

export interface Projectile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  damage: number;
  life: number;
  active: boolean;
}

const PROJECTILE_POOL = 24;
const CORPSE_LIFE = 3.5;
const FLOOR_Y = 0;

export class EnemyManager {
  public readonly group = new THREE.Group();
  public onEnemyKilled: ((enemy: Enemy) => void) | null = null;
  public onPlayerHit: ((damage: number, from: THREE.Vector3) => void) | null = null;

  private readonly enemies: Enemy[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly bodyGeo = new THREE.CapsuleGeometry(0.42, 0.9, 4, 10);
  private readonly eyeGeo = new THREE.SphereGeometry(0.11, 10, 10);
  private readonly projGeo = new THREE.SphereGeometry(0.12, 8, 8);
  private readonly bodyMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
  private readonly eyeMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0xffffff, emissiveIntensity: 3,
  });
  private readonly projMat = new THREE.MeshBasicMaterial({ color: 0xff6bd7 });
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
  private readonly tmpRay = new THREE.Ray();

  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
  ) {
    scene.add(this.group);
    for (let i = 0; i < PROJECTILE_POOL; i++) {
      const mesh = new THREE.Mesh(this.projGeo, this.projMat);
      mesh.visible = false;
      this.group.add(mesh);
      this.projectiles.push({ mesh, vel: new THREE.Vector3(), damage: 0, life: 0, active: false });
    }
  }

  public get aliveCount(): number {
    return this.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
  }

  /** Iterate live (non-dead, fully-spawned) enemies — used by the radar. */
  public forEachLive(fn: (e: Enemy) => void): void {
    for (const e of this.enemies) {
      if (!e.dead && e.spawnTimer <= 0) fn(e);
    }
  }

  public spawn(kind: EnemyKind, position: THREE.Vector3): void {
    const def = DEFS[kind];
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.bodyGeo, this.getBodyMat(kind));
    body.scale.set(def.radius / 0.42, def.height / 1.74, def.radius / 0.42);
    body.position.y = def.height / 2;
    body.castShadow = true;
    const eye = new THREE.Mesh(this.eyeGeo, this.eyeMat);
    eye.position.set(0, def.height * 0.82, -def.radius * 0.8);
    group.add(body, eye);
    group.position.copy(position);
    this.group.add(group);

    const collider = new Capsule(
      new THREE.Vector3(position.x, position.y + def.radius, position.z),
      new THREE.Vector3(position.x, position.y + def.height - def.radius, position.z),
      def.radius,
    );

    this.enemies.push({
      kind, def, health: def.health, maxHealth: def.health, group, body, eye, collider,
      attackTimer: randRange(0.5, def.attackCooldown),
      strafeSeed: Math.random() * Math.PI * 2,
      spawnTimer: 0.6,
      dead: false,
      deadT: 0,
    });
    this.effects.ring(position.clone().setY(position.y + 0.1), def.color, 3, 0.5);
    this.audio.spawn();
  }

  /** Sphere ray test used by the player's hitscan. Returns closest hit distance or null. */
  public raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { enemy: Enemy; distance: number; headshot: boolean } | null {
    let best: { enemy: Enemy; distance: number; headshot: boolean } | null = null;
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.spawnTimer > 0) continue;
      const center = this.tmp.set(
        enemy.collider.start.x,
        (enemy.collider.start.y + enemy.collider.end.y) / 2,
        enemy.collider.start.z,
      );
      const radius = (enemy.def.height / 2) * 0.92;
      const dist = this.raySphere(origin, dir, center, radius);
      if (dist !== null && dist <= maxDist && (!best || dist < best.distance)) {
        // Headshot: hit point near the top of the capsule (top ~25% of body height)
        const hitY = origin.y + dir.y * dist;
        const headY = enemy.collider.end.y;
        const headshot = hitY > headY - enemy.def.height * 0.22;
        best = { enemy, distance: dist, headshot };
      }
    }
    return best;
  }

  public damageEnemy(enemy: Enemy, amount: number, point: THREE.Vector3): void {
    if (enemy.dead) return;
    enemy.health -= amount;
    this.effects.impact(point, this.tmp.copy(point).sub(enemy.group.position).normalize());
    if (enemy.health <= 0) {
      enemy.dead = true;
      enemy.deadT = CORPSE_LIFE;
      this.effects.ring(enemy.group.position.clone().setY(enemy.group.position.y + 1), enemy.def.color, 5, 0.45);
      this.audio.kill();
      this.onEnemyKilled?.(enemy);
    }
  }

  public update(dt: number, playerPos: THREE.Vector3, playerDead: boolean): void {
    // Fade out + dispose dead enemies after a short linger
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy || !enemy.dead) continue;
      enemy.deadT -= dt;
      const k = Math.max(0, enemy.deadT / CORPSE_LIFE);
      enemy.group.scale.y = k;
      (enemy.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.12 + k * 0.4;
      if (enemy.deadT <= 0) {
        this.group.remove(enemy.group);
        this.enemies.splice(i, 1);
      }
    }
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.spawnTimer > 0) {
        enemy.spawnTimer -= dt;
        const k = clamp(enemy.spawnTimer / 0.6, 0, 1);
        enemy.group.scale.setScalar(1 - k * 0.85);
        continue;
      }
      enemy.group.scale.setScalar(1);
      this.updateEnemy(enemy, dt, playerPos, playerDead);
    }
    this.updateProjectiles(dt, playerPos, playerDead);
  }

  public clear(): void {
    for (const enemy of this.enemies) this.group.remove(enemy.group);
    this.enemies.length = 0;
    for (const p of this.projectiles) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  private updateEnemy(enemy: Enemy, dt: number, playerPos: THREE.Vector3, playerDead: boolean): void {
    const pos = enemy.group.position;
    const toPlayer = this.tmp.copy(playerPos).sub(pos);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    if (dist > 0.001) toPlayer.divideScalar(dist);

    // Face the player
    const targetYaw = Math.atan2(-toPlayer.x, -toPlayer.z) + Math.PI;
    enemy.group.rotation.y = dampAngle(enemy.group.rotation.y, targetYaw, 10, dt);

    if (!playerDead) {
      // Movement: approach, keep distance for gunner, strafe slightly
      const def = enemy.def;
      const desired = def.speed;
      const strafe = Math.sin(performance.now() * 0.001 + enemy.strafeSeed) * 0.5;
      const move = this.tmp2.set(0, 0, 0);

      if (enemy.kind === 'gunner') {
        if (dist > def.attackRange * 0.8) move.addScaledVector(toPlayer, 1);
        else if (dist < 10) move.addScaledVector(toPlayer, -1);
        move.addScaledVector(this.tmp.set(-toPlayer.z, 0, toPlayer.x), strafe);
      } else {
        move.addScaledVector(toPlayer, 1);
        if (enemy.kind === 'grunt' && dist < 8) {
          move.addScaledVector(this.tmp.set(-toPlayer.z, 0, toPlayer.x), strafe * 0.8);
        }
      }
      if (move.lengthSq() > 0.001) move.normalize();

      // Integrate with wall collision
      const step = move.multiplyScalar(desired * dt);
      enemy.collider.translate(step);
      const hit = this.octree.capsuleIntersect(enemy.collider);
      if (hit) {
        enemy.collider.translate(this.tmp.copy(hit.normal).multiplyScalar(hit.depth));
      }
      // Keep on the floor plane
      enemy.collider.start.y = Math.max(enemy.collider.start.y, FLOOR_Y + enemy.def.radius);
      enemy.collider.end.y = enemy.collider.start.y + enemy.def.height - enemy.def.radius * 2;

      pos.set(enemy.collider.start.x, enemy.collider.start.y - enemy.def.radius, enemy.collider.start.z);

      // Attack
      enemy.attackTimer -= dt;
      if (enemy.attackTimer <= 0 && dist < def.attackRange) {
        enemy.attackTimer = def.attackCooldown * randRange(0.85, 1.2);
        if (enemy.kind === 'rusher') {
          if (dist < def.attackRange) {
            this.onPlayerHit?.(def.damage, pos);
            this.audio.melee();
          }
        } else if (this.hasLineOfSight(pos, playerPos)) {
          this.fireProjectile(enemy, playerPos);
          this.audio.enemyShot();
        }
      }
    }

    // Eye glow pulse
    const pulse = 2.2 + Math.sin(performance.now() * 0.006 + enemy.strafeSeed) * 1.2;
    (enemy.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse;
  }

  private fireProjectile(enemy: Enemy, playerPos: THREE.Vector3): void {
    const proj = this.projectiles.find((p) => !p.active);
    if (!proj) return;
    const from = this.tmp.set(
      enemy.group.position.x,
      enemy.group.position.y + enemy.def.height * 0.75,
      enemy.group.position.z,
    );
    const dir = this.tmp2.copy(playerPos).setY(playerPos.y + 1.4).sub(from).normalize();
    // Lead the target slightly with inaccuracy
    dir.x += randRange(-0.04, 0.04);
    dir.y += randRange(-0.02, 0.02);
    dir.z += randRange(-0.04, 0.04);
    dir.normalize();
    proj.mesh.position.copy(from).addScaledVector(dir, 0.6);
    proj.vel.copy(dir).multiplyScalar(enemy.kind === 'gunner' ? 17 : 13);
    proj.damage = enemy.def.damage;
    proj.life = 4;
    proj.active = true;
    proj.mesh.visible = true;
  }

  private updateProjectiles(dt: number, playerPos: THREE.Vector3, playerDead: boolean): void {
    for (const proj of this.projectiles) {
      if (!proj.active) continue;
      proj.life -= dt;
      const prev = this.tmp.copy(proj.mesh.position);
      proj.mesh.position.addScaledVector(proj.vel, dt);

      // World collision: ray from previous to new position
      const seg = this.tmp2.copy(proj.mesh.position).sub(prev);
      const segLen = seg.length();
      if (segLen > 0.001) {
        seg.divideScalar(segLen);
        this.tmpRay.set(prev, seg);
        const wallHit = this.octree.rayIntersect(this.tmpRay);
        if (wallHit && wallHit.distance < segLen) {
          const normal = wallHit.triangle.getNormal(this.tmp3);
          if (normal.dot(seg) > 0) normal.negate();
          this.effects.impact(wallHit.position, normal);
          proj.active = false;
          proj.mesh.visible = false;
          continue;
        }
      }

      // Player collision
      if (!playerDead) {
        const center = this.tmp.set(playerPos.x, playerPos.y + 1.0, playerPos.z);
        if (proj.mesh.position.distanceToSquared(center) < 0.75 * 0.75) {
          this.onPlayerHit?.(proj.damage, proj.mesh.position);
          proj.active = false;
          proj.mesh.visible = false;
          continue;
        }
      }

      if (proj.life <= 0 || Math.abs(proj.mesh.position.x) > 40 || Math.abs(proj.mesh.position.z) > 40) {
        proj.active = false;
        proj.mesh.visible = false;
      }
    }
  }

  private hasLineOfSight(from: THREE.Vector3, playerPos: THREE.Vector3): boolean {
    const origin = this.tmp.set(from.x, from.y + 1.4, from.z);
    const target = this.tmp2.copy(playerPos).setY(playerPos.y + 1.5);
    const dir = target.sub(origin);
    const dist = dir.length();
    if (dist < 0.01) return true;
    dir.divideScalar(dist);
    this.tmpRay.set(origin, dir);
    const hit = this.octree.rayIntersect(this.tmpRay);
    return !hit || hit.distance > dist - 0.3;
  }

  private raySphere(origin: THREE.Vector3, dir: THREE.Vector3, center: THREE.Vector3, radius: number): number | null {
    const oc = this.tmp2.copy(origin).sub(center);
    const b = oc.dot(dir);
    const c = oc.lengthSq() - radius * radius;
    const disc = b * b - c;
    if (disc < 0) return null;
    const t = -b - Math.sqrt(disc);
    return t >= 0 ? t : null;
  }

  private getBodyMat(kind: EnemyKind): THREE.MeshStandardMaterial {
    let mat = this.bodyMats.get(kind);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: DEFS[kind].color,
        roughness: 0.5,
        metalness: 0.2,
        emissive: DEFS[kind].color,
        emissiveIntensity: 0.12,
      });
      this.bodyMats.set(kind, mat);
    }
    return mat;
  }
}
