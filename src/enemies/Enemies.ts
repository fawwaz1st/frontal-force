import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { Effects } from '../combat/Effects';
import type { GameAudio } from '../audio/Audio';
import { clamp, damp, dampAngle, randRange } from '../core/math';
import {
  TacticalDirector,
  type CoverSpotData,
  type TacticalClaim,
} from '../game/Tactics';

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
  group: THREE.Group;
  body: THREE.Mesh;
  eye: THREE.Mesh;
  /** Walk-cycle pivots. Every procedural model supplies all four. */
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  walkPhase: number;
  /** Attack windup already announced (charge sfx/visor spike once per attack) */
  telegraphed: boolean;
  /** Aim-pose blend 0..1 (arms raise during windup) */
  animAim: number;
  /** Seconds left on the white hit-flash (per-agent body material) */
  flashT: number;
  collider: Capsule;
  attackTimer: number;
  strafeSeed: number;
  tacticalId: number;
  state: 'advance' | 'cover' | 'peek' | 'search' | 'flank' | 'suppress';
  lastKnown: THREE.Vector3;
  claim: TacticalClaim | null;
  perceptionTimer: number;
  visible: boolean;
  seenFor: number;
  memory: number;
  decisionTimer: number;
  burst: number;
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

/** Anything that can intercept a bolt before it reaches the player. */
export interface Interceptor {
  active: boolean;
  readonly position: THREE.Vector3;
  takeDamage(amount: number): void;
}

const PROJECTILE_POOL = 24;
const CORPSE_LIFE = 6;
const FLOOR_Y = 0;
const BODY_EMISSIVE = 0.26;
const ATTACK_WINDUP = 0.35;
const PERCEPTION_INTERVAL = 0.125;
const SEARCH_MEMORY = 4.5;
const MAX_ACTIVE_SHOOTERS = 4;
const BURST_MAX = 3;

export class EnemyManager {
  private readonly group = new THREE.Group();
  public onEnemyKilled: ((enemy: Enemy) => void) | null = null;
  public onPlayerHit: ((damage: number, from: THREE.Vector3) => void) | null = null;
  /** Player yaw for the current frame — lets enemy sfx pan to their screen side. */
  public playerYaw = 0;
  /** Escort bots that intercept bolts before they reach the player. */
  public readonly interceptors: Interceptor[] = [];

  /** Reinitialize cover claims after World regenerates its layout. */
  public setCoverSpots(spots: readonly CoverSpotData[]): void {
    this.tactics.rebuild(spots);
  }

  private readonly enemies: Enemy[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly tactics = new TacticalDirector();
  private nextTacticalId = 1;
  private simTime = 0;
  private readonly bodyMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
  private readonly frameMat = new THREE.MeshStandardMaterial({
    color: 0x1a2130, roughness: 0.55, metalness: 0.7,
  });
  private readonly eyeMat = new THREE.MeshStandardMaterial({
    color: 0x111111, emissive: 0xffffff, emissiveIntensity: 3,
  });
  private readonly armorGeos = {
    torso: new THREE.BoxGeometry(0.62, 0.55, 0.38),
    pelvis: new THREE.BoxGeometry(0.4, 0.2, 0.3),
    head: new THREE.BoxGeometry(0.3, 0.26, 0.3),
    visor: new THREE.BoxGeometry(0.2, 0.07, 0.04),
    upperArm: new THREE.BoxGeometry(0.13, 0.3, 0.13),
    forearm: new THREE.BoxGeometry(0.12, 0.3, 0.12),
    thigh: new THREE.BoxGeometry(0.16, 0.4, 0.17),
    shin: new THREE.BoxGeometry(0.14, 0.4, 0.15),
    shoulder: new THREE.BoxGeometry(0.2, 0.16, 0.22),
    blade: new THREE.BoxGeometry(0.05, 0.5, 0.1),
    cannon: new THREE.CylinderGeometry(0.07, 0.08, 0.5, 10),
    rifle: new THREE.BoxGeometry(0.05, 0.08, 0.44),
    foot: new THREE.BoxGeometry(0.17, 0.09, 0.26),
    joint: new THREE.SphereGeometry(0.07, 6, 6),
    antenna: new THREE.CylinderGeometry(0.012, 0.012, 0.22, 5),
    strip: new THREE.BoxGeometry(0.28, 0.05, 0.02),
    pack: new THREE.BoxGeometry(0.36, 0.34, 0.16),
  } as const;
  private readonly projMat = new THREE.MeshBasicMaterial({ color: 0xff6bd7 });
  private readonly projMats = new Map<EnemyKind, THREE.MeshBasicMaterial>();
  private readonly projGlowMats = new Map<EnemyKind, THREE.MeshBasicMaterial>();
  private readonly stripMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
  /** Gravity for ballistic bolts (m/s²) — flat-fire low-arc solution. */
  private static readonly BOLT_G = 1.6;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
  private readonly tmp4 = new THREE.Vector3();
  private readonly tmp5 = new THREE.Vector3();
  private readonly tmpRay = new THREE.Ray();

  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
  ) {
    scene.add(this.group);
    for (let i = 0; i < PROJECTILE_POOL; i++) {
      // Shaped bolt: hot core cylinder along +Z + additive glow shell (recolored per firer)
      const bolt = new THREE.Mesh(
        new THREE.CylinderGeometry(0.05, 0.05, 0.5, 8).rotateX(Math.PI / 2),
        this.projMat,
      );
      const glow = new THREE.Mesh(
        new THREE.SphereGeometry(0.11, 8, 8),
        new THREE.MeshBasicMaterial({
          color: 0xff6bd7,
          transparent: true,
          opacity: 0.55,
          blending: THREE.AdditiveBlending,
          depthWrite: false,
        }),
      );
      bolt.add(glow);
      bolt.visible = false;
      this.group.add(bolt);
      this.projectiles.push({ mesh: bolt, vel: new THREE.Vector3(), damage: 0, life: 0, active: false });
    }
  }

  public get aliveCount(): number {
    return this.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
  }

  /** Iterate live (non-dead, fully-spawned) enemies — used by the radar. */
  public forEachLive(fn: (e: Enemy) => void): void {
    for (const e of this.enemies) {
      if (!e.dead) fn(e);
    }
  }

  public nearestEnemy(position: THREE.Vector3): Enemy | null {
    let nearest: Enemy | null = null;
    let bestDistanceSq = Number.MAX_SAFE_INTEGER;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const dx = enemy.group.position.x - position.x;
      const dz = enemy.group.position.z - position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      nearest = enemy;
    }
    return nearest;
  }

  public spawn(kind: EnemyKind, position: THREE.Vector3, hpMul = 1, spdMul = 1, atkMul = 1): void {
    // Per-spawn def clone: wave scaling never mutates the shared DEFS table.
    const base = DEFS[kind];
    const def: EnemyDef = {
      ...base,
      health: Math.round(base.health * hpMul),
      speed: base.speed * spdMul,
      attackCooldown: base.attackCooldown * atkMul,
    };
    const group = new THREE.Group();
    const model = this.buildModel(kind, def.height / 1.7);
    group.add(model.root);
    group.position.copy(position);
    this.group.add(group);

    const collider = new Capsule(
      new THREE.Vector3(position.x, position.y + def.radius, position.z),
      new THREE.Vector3(position.x, position.y + def.height - def.radius, position.z),
      def.radius,
    );

    this.enemies.push({
      kind, def, health: def.health, group,
      body: model.body, eye: model.eye,
      legL: model.legL, legR: model.legR, armL: model.armL, armR: model.armR,
      walkPhase: Math.random() * Math.PI * 2,
      collider,
      attackTimer: randRange(0.5, def.attackCooldown),
      strafeSeed: Math.random() * Math.PI * 2,
      tacticalId: this.nextTacticalId++,
      state: kind === 'rusher' ? 'flank' : 'advance',
      lastKnown: position.clone(),
      claim: null,
      perceptionTimer: Math.random() * PERCEPTION_INTERVAL,
      visible: false,
      seenFor: 0,
      memory: 0,
      decisionTimer: randRange(0.1, 0.8),
      burst: 1 + Math.floor(Math.random() * 3),
      telegraphed: false,
      animAim: 0,
      flashT: 0,
      dead: false,
      deadT: 0,
    });
    this.audio.spawn();
  }

  /** Capsule ray test used by the player's hitscan. Returns closest hit distance or null. */
  public raycast(origin: THREE.Vector3, dir: THREE.Vector3, maxDist: number): { enemy: Enemy; distance: number; headshot: boolean } | null {
    let best: { enemy: Enemy; distance: number; headshot: boolean } | null = null;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const distance = this.rayCapsule(origin, dir, enemy.collider);
      if (distance !== null && distance <= maxDist && (!best || distance < best.distance)) {
        const hitY = origin.y + dir.y * distance;
        const headFloor = enemy.group.position.y + enemy.def.height * 0.78;
        best = { enemy, distance, headshot: hitY > headFloor };
      }
    }
    return best;
  }

  public damageEnemy(enemy: Enemy, amount: number, point: THREE.Vector3, force?: THREE.Vector3): boolean {
    if (enemy.dead) return false;
    enemy.health -= amount;
    enemy.flashT = 0.14;
    this.effects.impact(point, this.tmp.copy(point).sub(enemy.group.position).normalize());
    // Physics kickback: heavier hits shove the body along the shot line
    // (resolved against walls by the normal octree pass next frame).
    if (force) {
      const push = Math.min(0.22, 0.05 + amount * 0.0035);
      enemy.collider.translate(this.tmp2.copy(force).setY(0).normalize().multiplyScalar(push));
    }
    if (enemy.health <= 0) {
      enemy.dead = true;
      enemy.deadT = CORPSE_LIFE;
      this.tactics.release(enemy.tacticalId);
      enemy.claim = null;
      this.effects.ring(enemy.group.position.clone().setY(enemy.group.position.y + 1), enemy.def.color, 5, 0.45);
      this.effects.burst(enemy.group.position.clone().setY(enemy.group.position.y + 1), enemy.def.color, 10, 1.6);
      this.audio.kill();
      this.onEnemyKilled?.(enemy);
      return true;
    }
    return false;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerDead: boolean,
    playerVel?: THREE.Vector3,
    lastShot?: THREE.Vector3 | null,
  ): void {
    this.simTime += dt;
    // Fade out + dispose dead enemies after a short linger
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy || !enemy.dead) continue;
      enemy.deadT -= dt;
      const k = Math.max(0, enemy.deadT / CORPSE_LIFE);
      // Topple backward over ~0.6 s, then hold on the ground as the glow fades
      const fall = clamp((1 - k) * 6, 0, 1);
      enemy.group.rotation.x = fall * 1.45;
      enemy.group.rotation.z = fall * Math.sin(enemy.strafeSeed) * 0.2;
      (enemy.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.02 + k * 0.4;
      (enemy.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = k * 3;
      if (enemy.deadT <= 0) {
        this.disposeEnemy(enemy);
        this.enemies.splice(i, 1);
      }
    }
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (lastShot) {
        const heardDistance = enemy.group.position.distanceTo(lastShot);
        const hearingRange = enemy.kind === 'rusher' ? 25 : 30;
        if (heardDistance <= hearingRange) {
          enemy.lastKnown.copy(lastShot);
          enemy.memory = Math.max(enemy.memory, 1.35);
          if (!enemy.visible) enemy.state = 'search';
        }
      }
      this.updateEnemy(enemy, dt, playerPos, playerDead, playerVel);
    }
    this.updateProjectiles(dt, playerPos, playerDead);
  }

  public clear(): void {
    this.simTime = 0;
    for (const enemy of this.enemies) {
      this.tactics.release(enemy.tacticalId);
      this.disposeEnemy(enemy);
    }
    this.enemies.length = 0;
    for (const p of this.projectiles) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  /** Remove a corpse and free its per-agent cloned materials (shared mats stay). */
  private disposeEnemy(enemy: Enemy): void {
    (enemy.body.material as THREE.Material).dispose();
    (enemy.eye.material as THREE.Material).dispose();
    this.group.remove(enemy.group);
  }

  private updateEnemy(
    enemy: Enemy,
    dt: number,
    playerPos: THREE.Vector3,
    playerDead: boolean,
    playerVel?: THREE.Vector3,
  ): void {
    this.updatePerception(enemy, dt, playerPos, playerDead);
    const target = enemy.visible ? playerPos : enemy.lastKnown;
    const toTarget = this.tmp.copy(target).sub(enemy.group.position);
    toTarget.y = 0;
    const targetDistance = toTarget.length();
    if (targetDistance > 0.001) toTarget.divideScalar(targetDistance);

    const facePoint = enemy.visible ? playerPos : enemy.lastKnown;
    const toFace = this.tmp2.copy(facePoint).sub(enemy.group.position);
    toFace.y = 0;
    if (toFace.lengthSq() > 0.001) {
      // Model forward is -Z; adding +PI makes agents walk away.
      const targetYaw = Math.atan2(-toFace.x, -toFace.z);
      enemy.group.rotation.y = dampAngle(enemy.group.rotation.y, targetYaw, 10, dt);
    }

    if (!playerDead) {
      this.moveEnemy(enemy, dt, toTarget, targetDistance, playerPos);
      this.updateAttack(enemy, dt, playerPos, playerVel);
    }
    this.animateEnemy(enemy, dt, targetDistance, playerDead);
  }

private updatePerception(
    enemy: Enemy,
    dt: number,
    playerPos: THREE.Vector3,
    playerDead: boolean,
  ): void {
    enemy.memory = Math.max(0, enemy.memory - dt);
    if (playerDead) {
      enemy.visible = false;
      enemy.state = 'search';
      return;
    }

    enemy.perceptionTimer -= dt;
    if (enemy.perceptionTimer > 0) return;
    enemy.perceptionTimer = PERCEPTION_INTERVAL;
    const distance = enemy.group.position.distanceTo(playerPos);
    const maxDistance = enemy.kind === 'gunner' ? 34 : enemy.kind === 'rusher' ? 22 : 28;
    const visible = distance <= maxDistance && this.hasLineOfSight(enemy.group.position, playerPos);
    if (visible) {
      enemy.visible = true;
      enemy.seenFor += PERCEPTION_INTERVAL;
      enemy.memory = SEARCH_MEMORY;
      enemy.lastKnown.copy(playerPos);
      if (enemy.state === 'search') enemy.state = enemy.kind === 'rusher' ? 'flank' : 'advance';
    } else {
      enemy.visible = false;
      enemy.seenFor = 0;
      if (enemy.memory <= 0) {
        enemy.state = 'search';
        if (enemy.claim) {
          this.tactics.release(enemy.tacticalId);
          enemy.claim = null;
        }
        enemy.attackTimer = Math.max(enemy.attackTimer, 0.25);
      }
    }

    if (enemy.claim && !enemy.visible && enemy.memory <= 0) {
      this.tactics.release(enemy.tacticalId);
      enemy.claim = null;
    }
    if (enemy.claim && enemy.visible && enemy.state === 'cover') {
      const target = enemy.claim.peek;
      const peekDistance = enemy.group.position.distanceTo(target);
      if (peekDistance < 0.65) {
        enemy.state = 'peek';
        enemy.attackTimer = Math.min(enemy.attackTimer, ATTACK_WINDUP + 0.2);
      } else if (enemy.group.position.distanceTo(enemy.claim.point.center) < 0.75) {
        enemy.state = 'peek';
      }
    }
    if (enemy.state === 'peek' && enemy.visible && enemy.seenFor > 1.5) {
      enemy.state = 'suppress';
      enemy.attackTimer = Math.min(enemy.attackTimer, ATTACK_WINDUP + 0.2);
    }
  }

  private moveEnemy(
    enemy: Enemy,
    dt: number,
    toTarget: THREE.Vector3,
    distance: number,
    playerPos: THREE.Vector3,
  ): void {
    const move = this.tmp3.set(0, 0, 0);
    const speed = enemy.def.speed;
    if (enemy.kind === 'rusher' && distance < 4.5 && enemy.attackTimer < ATTACK_WINDUP) {
      // Rusher commits only during its visible windup; there is no hidden melee hit.
      this.tmp4.copy(toTarget).multiplyScalar(1.7);
    } else {
      this.tmp4.copy(toTarget);
    }

    if (enemy.claim && enemy.state === 'cover') {
      const center = enemy.claim.point.center;
      this.tmp5.set(center.x - enemy.group.position.x, 0, center.z - enemy.group.position.z);
      if (this.tmp5.lengthSq() > 0.5) {
        this.tmp5.normalize();
        move.addScaledVector(this.tmp5, 0.85);
      } else {
        enemy.state = 'peek';
      }
    } else if (enemy.claim && enemy.state === 'peek') {
      const peek = enemy.claim.peek;
      this.tmp5.set(peek.x - enemy.group.position.x, 0, peek.z - enemy.group.position.z);
      if (this.tmp5.lengthSq() > 0.2) {
        this.tmp5.normalize();
        move.addScaledVector(this.tmp5, 1.25);
      }
    } else if (enemy.kind === 'rusher') {
      move.copy(this.tmp4);
    } else if (enemy.kind === 'gunner') {
      if (distance > enemy.def.attackRange * 0.78) move.copy(this.tmp4);
      else if (distance < 11) move.addScaledVector(this.tmp4, -0.8);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) move.addScaledVector(side.normalize(), Math.sin(this.simTime + enemy.strafeSeed) * 0.2);
    } else if (enemy.state === 'flank') {
      // Role flank is a lateral approach, then a short commit after cover clears.
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      move.copy(this.tmp4).addScaledVector(side.normalize(), 0.85);
    } else {
      if (distance > 11) move.copy(this.tmp4);
      else if (distance < 6) move.addScaledVector(this.tmp4, -0.65);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      move.addScaledVector(side.normalize(), Math.sin(this.simTime + enemy.strafeSeed) * 0.18);
    }

    if (move.lengthSq() > 0.001) move.normalize();
    enemy.collider.translate(move.multiplyScalar(speed * dt));
    const hit = this.octree.capsuleIntersect(enemy.collider);
    if (hit) {
      enemy.collider.translate(this.tmp4.copy(hit.normal).multiplyScalar(hit.depth));
    }
    this.separateFromCrowd(enemy);

    enemy.collider.start.y = Math.max(enemy.collider.start.y, FLOOR_Y + enemy.def.radius);
    enemy.collider.end.y = enemy.collider.start.y + enemy.def.height - enemy.def.radius * 2;
    enemy.group.position.set(
      enemy.collider.start.x,
      enemy.collider.start.y - enemy.def.radius,
      enemy.collider.start.z,
    );

    enemy.decisionTimer -= dt;
    if (enemy.decisionTimer <= 0 && !enemy.claim && enemy.kind !== 'rusher') {
      enemy.decisionTimer = randRange(0.5, 1.2);
      if (enemy.visible || enemy.memory > 0) {
        const claim = this.tactics.claim(
          enemy.tacticalId,
          enemy.group.position,
          playerPos,
          enemy.kind,
          (from, to) => this.hasLineOfSight(from, to),
        );
        if (claim) {
          enemy.claim = claim;
          enemy.state = 'cover';
        } else if (enemy.kind === 'gunner' || enemy.strafeSeed > Math.PI) {
          enemy.state = enemy.kind === 'gunner' ? 'suppress' : 'flank';
        }
      }
    }
  }

  private separateFromCrowd(enemy: Enemy): void {
    for (const other of this.enemies) {
      if (other === enemy || other.dead) continue;
      const dx = enemy.collider.start.x - other.collider.start.x;
      const dz = enemy.collider.start.z - other.collider.start.z;
      const minimum = (enemy.def.radius + other.def.radius) * 0.92;
      const distanceSquared = dx * dx + dz * dz;
      if (distanceSquared <= 1e-4 || distanceSquared >= minimum * minimum) continue;
      const distance = Math.sqrt(distanceSquared);
      const push = (minimum - distance) * 0.5;
      enemy.collider.translate(this.tmp3.set((dx / distance) * push, 0, (dz / distance) * push));
    }
  }

  private updateAttack(
    enemy: Enemy,
    dt: number,
    playerPos: THREE.Vector3,
    playerVel: THREE.Vector3 | undefined,
  ): void {
    const def = enemy.def;
    enemy.attackTimer -= dt;
    const distance = enemy.group.position.distanceTo(playerPos);
    const inRange = distance <= def.attackRange;
    const shootersReady = this.enemies.reduce((count, other) => {
      if (other === enemy || other.dead || !other.visible || other.attackTimer > ATTACK_WINDUP) return count;
      return count + (other.kind === 'rusher' ? 0 : 1);
    }, 0);
    const rushersReady = this.enemies.reduce((count, other) => {
      if (other === enemy || other.dead || !other.visible || other.kind !== 'rusher') return count;
      return count + (other.attackTimer <= ATTACK_WINDUP ? 1 : 0);
    }, 0);
    const roleCap = enemy.kind === 'rusher'
      ? rushersReady < 2
      : shootersReady < MAX_ACTIVE_SHOOTERS;
    const canEngage = enemy.visible && enemy.state !== 'search' && inRange && roleCap;
    if (!canEngage) {
      if (enemy.attackTimer <= 0) enemy.attackTimer = ATTACK_WINDUP + 0.05;
      if (enemy.telegraphed) enemy.telegraphed = false;
      return;
    }

    if (
      !enemy.telegraphed &&
      enemy.attackTimer <= ATTACK_WINDUP &&
      enemy.attackTimer > 0
    ) {
      enemy.telegraphed = true;
      this.audio.charge(this.panToward(enemy.group.position, playerPos));
    }
    if (enemy.attackTimer > 0) return;

    enemy.telegraphed = false;
    enemy.attackTimer = def.attackCooldown * randRange(0.85, 1.2);
    if (enemy.kind === 'rusher') {
      if (!this.hasLineOfSight(enemy.group.position, playerPos)) return;
      this.onPlayerHit?.(def.damage, enemy.group.position);
      this.audio.melee(this.panToward(enemy.group.position, playerPos));
    } else {
      this.fireProjectile(enemy, playerPos, playerVel);
      this.audio.enemyShot(this.panToward(enemy.group.position, playerPos));
      enemy.burst -= 1;
      if (enemy.burst <= 0) {
        enemy.burst = 1 + Math.floor(Math.random() * BURST_MAX);
        enemy.attackTimer += randRange(0.45, 1.35);
      }
    }
  }

  private animateEnemy(enemy: Enemy, dt: number, distance: number, playerDead: boolean): void {
    const pulse = 2.2 + Math.sin(this.simTime * 6 + enemy.strafeSeed) * 1.2;
    const windup = enemy.telegraphed
      ? clamp(1 - enemy.attackTimer / ATTACK_WINDUP, 0, 1) * 7
      : 0;
    (enemy.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = pulse + windup;
    if (enemy.flashT > 0) {
      enemy.flashT = Math.max(0, enemy.flashT - dt);
      (enemy.body.material as THREE.MeshStandardMaterial).emissiveIntensity =
        BODY_EMISSIVE + (enemy.flashT / 0.14) * 3.2;
    }

    const moving = !playerDead && (enemy.kind === 'gunner'
      ? Math.abs(distance - enemy.def.attackRange * 0.5) > 0.5
      : distance > enemy.def.attackRange * 0.6);
    if (moving) enemy.walkPhase += dt * enemy.def.speed * 2.1;
    const swing = Math.sin(enemy.walkPhase) * (moving ? 0.65 : 0);
    enemy.legL.rotation.x = swing;
    enemy.legR.rotation.x = -swing;

    enemy.animAim = damp(enemy.animAim, enemy.telegraphed ? 1 : 0, 10, dt);
    const aim = enemy.animAim;
    enemy.armL.rotation.x = -swing * 0.75 * (1 - aim) + 1.25 * aim;
    enemy.armR.rotation.x = enemy.kind === 'gunner'
      ? 1.35
      : swing * 0.75 * (1 - aim) + 1.4 * aim;

    enemy.body.rotation.x = damp(enemy.body.rotation.x, moving ? -0.07 : 0, 6, dt);
    enemy.body.position.y = 1.25 * (enemy.def.height / 1.7)
      + (moving ? Math.abs(Math.sin(enemy.walkPhase * 2)) * 0.035 : 0);
    enemy.group.rotation.z = moving ? Math.sin(enemy.walkPhase * 2) * 0.045 : 0;
  }

  /** Assemble a per-kind humanoid robot: torso, head+visor, jointed limbs. */
  private buildModel(kind: EnemyKind, scaleK: number): {
    root: THREE.Group;
    body: THREE.Mesh;
    eye: THREE.Mesh;
    legL: THREE.Group;
    legR: THREE.Group;
    armL: THREE.Group;
    armR: THREE.Group;
  } {
    const g = this.armorGeos;
    const root = new THREE.Group();
    const s = (mesh: THREE.Mesh, x: number, y: number, z = 0, parent: THREE.Object3D = root): THREE.Mesh => {
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      parent.add(mesh);
      return mesh;
    };

    // Per-agent clones so corpse-fade and pulse never bleed across agents
    const bodyMat = this.getBodyMat(kind).clone();
    const eyeMat = this.eyeMat.clone();
    const dark = this.frameMat;

    const torso = new THREE.Mesh(g.torso, bodyMat);
    const torsoY = 1.25 * scaleK;
    s(torso, 0, torsoY);
    if (kind === 'gunner') torso.scale.set(1.18, 1.05, 1.15);
    if (kind === 'rusher') torso.scale.set(0.9, 0.95, 0.9);
    // Pelvis + shoulder pads ride on the torso
    s(new THREE.Mesh(g.pelvis, dark), 0, -0.36 * scaleK, 0, torso);
    const padL = new THREE.Mesh(g.shoulder, dark);
    padL.position.set(-0.4 * scaleK, 0.18 * scaleK, 0);
    padL.castShadow = true;
    torso.add(padL);
    const padR = new THREE.Mesh(g.shoulder, dark);
    padR.position.set(0.4 * scaleK, 0.18 * scaleK, 0);
    padR.castShadow = true;
    torso.add(padR);
    // Glowing chest strip — the kind's identification light
    let strip = this.stripMats.get(kind);
    if (!strip) {
      strip = new THREE.MeshStandardMaterial({
        color: 0x0a0f1c, emissive: DEFS[kind].color, emissiveIntensity: 1.7, roughness: 0.4,
      });
      this.stripMats.set(kind, strip);
    }
    const chest = new THREE.Mesh(g.strip, strip);
    chest.position.set(0, 0.06 * scaleK, -0.196 * scaleK);
    torso.add(chest);
    if (kind === 'gunner') {
      s(new THREE.Mesh(g.pack, dark), 0, 0.02 * scaleK, 0.28 * scaleK, torso);
    }

    const head = new THREE.Mesh(g.head, dark);
    s(head, 0, 0.38 * scaleK, 0, torso);
    const eye = new THREE.Mesh(g.visor, eyeMat);
    // Head geo is unscaled (fixed 0.15 half-depth) — don't scale this offset or
    // rushers sink the visor inside the head and gunners float it proud.
    eye.position.set(0, 0.02 * scaleK, -0.163);
    head.add(eye);
    const antenna = new THREE.Mesh(g.antenna, dark);
    antenna.position.set(0.1, 0.24, 0.04);
    head.add(antenna);

    const makeArm = (side: -1 | 1): THREE.Group => {
      const pivot = new THREE.Group();
      // Shoulder height in root space (torso center 1.25 + shoulder offset 0.18)
      pivot.position.set(side * 0.4 * scaleK, (1.25 + 0.18) * scaleK, 0);
      root.add(pivot);
      const upper = new THREE.Mesh(g.upperArm, dark);
      upper.position.y = -0.15 * scaleK;
      upper.castShadow = false;
      pivot.add(upper);
      const elbow = new THREE.Mesh(g.joint, dark);
      elbow.position.y = -0.3 * scaleK;
      pivot.add(elbow);
      if (kind === 'rusher' && side === 1) {
        const blade = new THREE.Mesh(g.blade, bodyMat);
        blade.position.y = -0.5 * scaleK;
        blade.castShadow = true;
        pivot.add(blade);
      } else if (kind === 'gunner' && side === 1) {
        const cannon = new THREE.Mesh(g.cannon, dark);
        cannon.rotation.x = Math.PI / 2;
        cannon.position.set(0, -0.3 * scaleK, -0.25 * scaleK);
        cannon.castShadow = true;
        pivot.add(cannon);
      } else {
        const fore = new THREE.Mesh(g.forearm, dark);
        fore.position.y = -0.44 * scaleK;
        fore.castShadow = false;
        pivot.add(fore);
        if (kind === 'grunt' && side === 1) {
          // Grunt carbine, carried muzzle-forward (model faces -Z)
          const gun = new THREE.Mesh(g.rifle, dark);
          gun.position.set(0, -0.5 * scaleK, -0.2 * scaleK);
          gun.castShadow = false;
          pivot.add(gun);
        }
      }
      return pivot;
    };
    const armL = makeArm(-1);
    const armR = makeArm(1);

    const makeLeg = (side: -1 | 1): THREE.Group => {
      const pivot = new THREE.Group();
      pivot.position.set(side * 0.16 * scaleK, (1.25 - 0.36) * scaleK, 0);
      root.add(pivot);
      const thigh = new THREE.Mesh(g.thigh, dark);
      thigh.position.y = -0.2 * scaleK;
      thigh.castShadow = true;
      pivot.add(thigh);
      const shin = new THREE.Mesh(g.shin, dark);
      shin.position.y = -0.58 * scaleK;
      shin.castShadow = true;
      pivot.add(shin);
      const foot = new THREE.Mesh(g.foot, dark);
      foot.position.set(0, -0.82 * scaleK, 0.04);
      foot.castShadow = false;
      pivot.add(foot);
      const knee = new THREE.Mesh(g.joint, dark);
      knee.position.y = -0.4 * scaleK;
      knee.castShadow = false;
      pivot.add(knee);
      return pivot;
    };
    // Legs hang from the pelvis (world space, not torso) so torso bob never splits them
    const legL = makeLeg(-1);
    const legR = makeLeg(1);

    return { root, body: torso, eye, legL, legR, armL, armR };
  }

  private fireProjectile(enemy: Enemy, playerPos: THREE.Vector3, playerVel?: THREE.Vector3): void {
    const proj = this.projectiles.find((p) => !p.active);
    if (!proj) return;
    const from = this.tmp.set(
      enemy.group.position.x,
      enemy.group.position.y + enemy.def.height * 0.75,
      enemy.group.position.z,
    );
    const speed = enemy.kind === 'gunner' ? 17 : 13;
    const horizontal = Math.hypot(playerPos.x - from.x, playerPos.z - from.z);
    const flight = Math.max(0.2, horizontal / speed);
    const aim = this.tmp2.set(playerPos.x, playerPos.y + 1.4, playerPos.z);
    if (playerVel) aim.addScaledVector(playerVel, flight);

    const baseErr = enemy.kind === 'gunner' ? 0.015 : 0.05;
    const speedErr = playerVel ? Math.min(0.035, Math.hypot(playerVel.x, playerVel.z) * 0.007) : 0;
    const err = (baseErr + speedErr) * flight;
    aim.x += randRange(-err, err);
    aim.y += randRange(-err * 0.5, err * 0.5);
    aim.z += randRange(-err, err);

    // Solve launch velocity for the selected flight time. Gravity is applied
    // every step in updateProjectiles; the +g·t/2 term cancels it at impact.
    proj.vel.set(
      (aim.x - from.x) / flight,
      (aim.y - from.y) / flight + 0.5 * EnemyManager.BOLT_G * flight,
      (aim.z - from.z) / flight,
    );
    const launchDir = this.tmp3.copy(proj.vel).normalize();
    proj.mesh.position.copy(from).addScaledVector(launchDir, 0.6);
    proj.mesh.material = this.getProjMat(enemy.kind);
    const glow = proj.mesh.children[0] as THREE.Mesh | undefined;
    if (glow) glow.material = this.getProjGlowMat(enemy.kind);
    proj.mesh.scale.set(1, 1, 1.4);
    proj.mesh.lookAt(this.tmp3.copy(proj.mesh.position).add(proj.vel));
    proj.damage = enemy.def.damage;
    proj.life = 4;
    proj.active = true;
    proj.mesh.visible = true;
    this.effects.burst(from, enemy.def.color, 3, 1.2);
  }

  private updateProjectiles(dt: number, playerPos: THREE.Vector3, playerDead: boolean): void {
    for (const proj of this.projectiles) {
      if (!proj.active) continue;
      proj.life -= dt;
      proj.vel.y -= EnemyManager.BOLT_G * dt;
      const prev = this.tmp.copy(proj.mesh.position);
      proj.mesh.position.addScaledVector(proj.vel, dt);
      // Keep the bolt's long axis aligned with its curved velocity.
      proj.mesh.lookAt(this.tmp3.copy(proj.mesh.position).add(proj.vel));

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

      // Escort interception — only bolts that actually cross a guard's body.
      // The old 0.8m sphere test made every bot a global shield: it soaked
      // bolts aimed anywhere near it, so the player stopped taking fire.
      let eaten = false;
      const target = this.tmp.set(playerPos.x, playerPos.y + 1, playerPos.z);
      for (const guard of this.interceptors) {
        if (!guard.active) continue;
        const seg = this.tmp2.copy(target).sub(proj.mesh.position);
        const segLen2 = seg.lengthSq();
        if (segLen2 < 1e-6) continue;
        const tGuard = clamp(
          this.tmp3.set(guard.position.x, guard.position.y + 1, guard.position.z)
            .sub(proj.mesh.position).dot(seg) / segLen2,
          0,
          1,
        );
        const closest = this.tmp3.copy(proj.mesh.position).addScaledVector(seg, tGuard);
        const gx = guard.position.x;
        const gy = guard.position.y + 1;
        const gz = guard.position.z;
        if (closest.distanceToSquared(this.tmp4.set(gx, gy, gz)) < 0.6 * 0.6) {
          guard.takeDamage(proj.damage);
          this.effects.burst(closest.clone(), 0xff9f1c, 5, 1.4);
          eaten = true;
          break;
        }
      }
      if (eaten) {
        proj.active = false;
        proj.mesh.visible = false;
        continue;
      }

      if (proj.life <= 0 || Math.abs(proj.mesh.position.x) > 66 || Math.abs(proj.mesh.position.z) > 66) {
        proj.active = false;
        proj.mesh.visible = false;
      }
    }
  }

  /** Per-kind bolt material cache — projectile color matches the firer (grunt violet / gunner amber). */
  private getProjMat(kind: EnemyKind): THREE.MeshBasicMaterial {
    let mat = this.projMats.get(kind);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({ color: DEFS[kind].color });
      this.projMats.set(kind, mat);
    }
    return mat;
  }

  private getProjGlowMat(kind: EnemyKind): THREE.MeshBasicMaterial {
    let mat = this.projGlowMats.get(kind);
    if (!mat) {
      mat = new THREE.MeshBasicMaterial({
        color: DEFS[kind].color,
        transparent: true,
        opacity: 0.55,
        blending: THREE.AdditiveBlending,
        depthWrite: false,
      });
      this.projGlowMats.set(kind, mat);
    }
    return mat;
  }

  /** Horizontal screen-space pan (−1 left … +1 right) of a world point for the player. */
  private panToward(pos: THREE.Vector3, playerPos: THREE.Vector3): number {
    const dx = pos.x - playerPos.x;
    const dz = pos.z - playerPos.z;
    const len = Math.hypot(dx, dz) || 1;
    const yaw = this.playerYaw;
    return clamp((dx / len) * Math.cos(yaw) - (dz / len) * Math.sin(yaw), -1, 1);
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
    const offset = this.tmp2.copy(origin).sub(center);
    const b = offset.dot(dir);
    const c = offset.lengthSq() - radius * radius;
    const discriminant = b * b - c;
    if (discriminant < 0) return null;
    const root = Math.sqrt(discriminant);
    const near = -b - root;
    if (near >= 0) return near;
    return -b + root >= 0 ? 0 : null;
  }

  private rayCapsule(origin: THREE.Vector3, dir: THREE.Vector3, capsule: Capsule): number | null {
    let nearest = this.raySphere(origin, dir, capsule.start, capsule.radius);
    const endHit = this.raySphere(origin, dir, capsule.end, capsule.radius);
    if (endHit !== null && (nearest === null || endHit < nearest)) nearest = endHit;

    // Infinite-cylinder side test; accept only roots whose projection lies between
    // the capsule endpoints. Endpoint spheres above cover both hemispherical caps.
    const axis = this.tmp4.copy(capsule.end).sub(capsule.start);
    const axisLengthSq = axis.lengthSq();
    if (axisLengthSq < 1e-8) return nearest;
    const fromStart = this.tmp2.copy(origin).sub(capsule.start);
    const dirAxis = dir.dot(axis);
    const fromAxis = fromStart.dot(axis);
    const dirPerp = this.tmp3.copy(dir).addScaledVector(axis, -dirAxis / axisLengthSq);
    const fromPerp = this.tmp5.copy(fromStart).addScaledVector(axis, -fromAxis / axisLengthSq);
    const a = dirPerp.dot(dirPerp);
    const b = 2 * fromPerp.dot(dirPerp);
    const c = fromPerp.lengthSq() - capsule.radius * capsule.radius;
    const discriminant = b * b - 4 * a * c;
    if (a < 1e-8 || discriminant < 0) return nearest;
    const root = Math.sqrt(discriminant);
    const first = (-b - root) / (2 * a);
    const second = (-b + root) / (2 * a);
    const rootDistances = [first, second];
    for (const distance of rootDistances) {
      if (distance < 0 || (nearest !== null && distance >= nearest)) continue;
      const along = (fromStart.dot(axis) + distance * dirAxis) / axisLengthSq;
      if (along >= 0 && along <= 1) nearest = distance;
    }
    return nearest;
  }

  private getBodyMat(kind: EnemyKind): THREE.MeshStandardMaterial {
    let mat = this.bodyMats.get(kind);
    if (!mat) {
      mat = new THREE.MeshStandardMaterial({
        color: DEFS[kind].color,
        roughness: 0.5,
        metalness: 0.2,
        emissive: DEFS[kind].color,
        // Lifted from 0.12 so the silhouette still reads against the dark arena
        emissiveIntensity: BODY_EMISSIVE,
      });
      this.bodyMats.set(kind, mat);
    }
    return mat;
  }
}
