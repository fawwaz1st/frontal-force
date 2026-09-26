import * as THREE from 'three';
import type { Octree } from 'three/addons/math/Octree.js';
import type { EnemyManager, Enemy, Interceptor } from '../enemies/Enemies';
import type { Effects } from '../combat/Effects';
import type { GameAudio } from '../audio/Audio';
import type { CombatTarget } from '../combat/Combatant';
import { ARENA_LIMIT } from '../world/World';
import { clamp, damp, dampAngle, randRange } from '../core/math';

const FIRE_CD = 0.7;
const SHOT_DMG = 5;
const MAX_HP = 100;
const RESPAWN_TIME = 18;
const BOUNDS = ARENA_LIMIT;
const FIRE_RANGE = 34;
const SPEED = 7;
const SPRINT_MULT = 1.35;
const TRACER = 0xffc266;
const SPAWN_OFFSETS: Array<[number, number]> = [
  [-2.4, 1.8],
  [2.4, 1.8],
];

/* ---------- Autonomy tuning: anchor + leash + role slot ---------- */

/** Idle slot offset from the anchor — a rotated seat, not the anchor itself. */
const SLOT_SIDE = 3;
const SLOT_BACK = 2;
/** Re-quantize the anchor only after the owner moves this far (kills jitter). */
const ANCHOR_REFRESH_DISTANCE = 3;
/** Soft leash: past this the bot heads home at full speed. */
const LEASH_SOFT = 18;
/** Hard leash: past this the bot breaks off entirely and sprints back. */
const LEASH_HARD = 26;
/** Combat standoff per role — flankers close, overwatch holds a lane. */
const FLANK_STANDOFF = 8;
const FLANK_MAX_RANGE = 12;
const OVERWATCH_STANDOFF = 15;
const OVERWATCH_MIN_RANGE = 10;
const OVERWATCH_MAX_RANGE = 20;
/** Roles are re-auctioned on this cadence so the pair keeps different angles. */
const ROLE_AUCTION_INTERVAL = 2;
/** Victim re-score cadence — NOT per frame (that is what causes target flicker). */
const VICTIM_RESCORE = 0.4;
/** Retreat below this health fraction; re-engage above the upper band. */
const RETREAT_HP = 0.3;
const REENGAGE_HP = 0.55;
/** Hard cap so a bot can never kite forever. */
const RETREAT_MAX_TIME = 8;
/** Nearest-enemy distance that justifies breaking contact. */
const RETREAT_TRIGGER_RANGE = 20;

type BotRole = 'flanker' | 'overwatch';

/**
 * Humanoid escort bot — fully autonomous. It owns its own objective anchor,
 * its own victim selection, its own engagement range and its own retreat
 * decision. The human is an anchor it prefers, not a leash it obeys.
 *
 * Design (research-backed): anchor + leash + role slot. The anchor is the
 * owner position quantized to a grid so a walking human does not drag the bots
 * around every frame; the leash has soft and hard radii; and the two bots
 * auction flanker/overwatch so they never stack on one firing line.
 *
 * Implements `CombatTarget`, so enemy AI scores it exactly like the player.
 */
class Bot implements Interceptor, CombatTarget {
  private readonly group = new THREE.Group();
  public hp = 100;
  public active = false;
  public onShot: ((pan: number) => void) | null = null;
  /** Endless modes scale enemy HP; escort fire scales with it (1 otherwise). */
  public damageScale = 1;

  private idx = 0;
  private fireT = 0;
  private respawnT = 0;
  private yaw = 0;
  private walkPhase = 0;
  private gait = 0;
  private recoilT = 0;
  private simTime = 0;
  private role: BotRole = 'flanker';
  private retreating = false;
  private retreatT = 0;
  private leashBroken = false;
  private readonly anchor = new THREE.Vector2();
  private hasAnchor = false;
  private readonly lastPos = new THREE.Vector3();
  private hasLastPos = false;
  /** Current victim — re-scored on a timer, never per frame. */
  private victim: Enemy | null = null;
  private victimTimer = 0;
  /** World velocity for enemy ballistic lead. */
  public readonly velocity = new THREE.Vector3();
  /** Escorts draw less fire than the human (player 1.0, escort 0.45). */
  public readonly threatRole = 0.45;
  public readonly team = 'escort' as const;
  private readonly torsoMesh: THREE.Mesh;
  private readonly visorMat: THREE.MeshStandardMaterial;
  private readonly rifle: THREE.Object3D;
  private readonly rifleRestZ: number;
  private readonly legL: THREE.Group;
  private readonly legR: THREE.Group;
  private readonly armL: THREE.Group;
  private readonly armR: THREE.Group;
  private readonly tmpRay = new THREE.Ray();
  private readonly tmpA = new THREE.Vector3();
  private readonly tmpB = new THREE.Vector3();
  private readonly tmpC = new THREE.Vector3();
  private readonly moveTarget = new THREE.Vector2();

  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
    /** Stable id for the enemy threat table (never reused across respawns). */
    private readonly id: number,
  ) {
    const armor = new THREE.MeshStandardMaterial({ color: 0xd8d2c0, roughness: 0.55, metalness: 0.25 });
    const joint = new THREE.MeshStandardMaterial({ color: 0x22251c, roughness: 0.7, metalness: 0.4 });
    const dark = new THREE.MeshStandardMaterial({ color: 0x14160f, roughness: 0.6, metalness: 0.5 });
    this.visorMat = new THREE.MeshStandardMaterial({
      color: 0x111111, emissive: 0xff9f1c, emissiveIntensity: 3,
    });
    const stripMat = new THREE.MeshStandardMaterial({
      color: 0x0a0f1c, emissive: 0xff9f1c, emissiveIntensity: 1.4, roughness: 0.4,
    });

    const mesh = (
      geo: THREE.BufferGeometry, mat: THREE.Material,
      x: number, y: number, z: number, parent: THREE.Object3D, shadow = false,
    ): THREE.Mesh => {
      const m = new THREE.Mesh(geo, mat);
      m.position.set(x, y, z);
      m.castShadow = shadow;
      parent.add(m);
      return m;
    };

    // Pelvis + torso + collar + head (chest strip faces -Z like the enemies)
    mesh(new THREE.BoxGeometry(0.34, 0.18, 0.24), armor, 0, 0.92, 0, this.group, true);
    const torso = mesh(new THREE.BoxGeometry(0.5, 0.52, 0.3), armor, 0, 1.28, 0, this.group, true);
    mesh(new THREE.BoxGeometry(0.28, 0.05, 0.02), stripMat, 0, 0.06, -0.156, torso);
    this.torsoMesh = torso;
    mesh(new THREE.BoxGeometry(0.2, 0.09, 0.18), joint, 0, 1.57, 0, this.group);
    const head = mesh(new THREE.BoxGeometry(0.26, 0.24, 0.24), armor, 0, 1.72, 0, this.group, true);
    mesh(new THREE.BoxGeometry(0.18, 0.06, 0.04), this.visorMat, 0, 0.01, -0.13, head);
    mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.2, 5), dark, 0.1, 0.16, 0.04, head);

    // Rifle carried at the hip, muzzle forward
    this.rifle = new THREE.Group();
    mesh(new THREE.BoxGeometry(0.05, 0.07, 0.42), dark, 0, 0, 0, this.rifle);
    mesh(
      new THREE.CylinderGeometry(0.014, 0.014, 0.18, 8).rotateX(Math.PI / 2),
      joint, 0, 0.01, -0.28, this.rifle,
    );
    this.rifleRestZ = -0.3;
    this.rifle.position.set(0.26, 0.03, this.rifleRestZ);
    torso.add(this.rifle);

    // Shoulders + jointed arms (pivot at the shoulder, aim pose forward)
    const arms: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      mesh(new THREE.BoxGeometry(0.16, 0.14, 0.22), armor, side * 0.34, 1.47, 0, this.group, true);
      const arm = new THREE.Group();
      arm.position.set(side * 0.33, 1.45, 0);
      this.group.add(arm);
      mesh(new THREE.BoxGeometry(0.11, 0.32, 0.12), armor, 0, -0.16, 0, arm, true);
      mesh(new THREE.SphereGeometry(0.07, 6, 6), joint, 0, -0.32, 0, arm);
      arms.push(arm);
    }

    // Legs (pivot at hip, knee joint, boot)
    const legs: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const leg = new THREE.Group();
      leg.position.set(side * 0.14, 0.9, 0);
      this.group.add(leg);
      mesh(new THREE.BoxGeometry(0.16, 0.42, 0.17), armor, 0, -0.21, 0, leg, true);
      mesh(new THREE.SphereGeometry(0.07, 6, 6), joint, 0, -0.42, 0, leg);
      mesh(new THREE.BoxGeometry(0.14, 0.4, 0.15), joint, 0, -0.62, 0, leg);
      mesh(new THREE.BoxGeometry(0.15, 0.1, 0.26), dark, 0, -0.86, 0.04, leg);
      legs.push(leg);
    }

    const armL = arms[0];
    const armR = arms[1];
    const legL = legs[0];
    const legR = legs[1];
    if (!armL || !armR || !legL || !legR) throw new Error('Bot limb construction failed');
    this.armL = armL;
    this.armR = armR;
    this.legL = legL;
    this.legR = legR;

    this.group.visible = false;
    scene.add(this.group);
  }

  public get position(): THREE.Vector3 {
    return this.group.position;
  }

  // ---------- CombatTarget ----------

  public get targetId(): number {
    return this.id;
  }

  public get eyeHeight(): number {
    return 1.4;
  }

  public get hpFraction(): number {
    return this.hp / MAX_HP;
  }

  public get targetable(): boolean {
    return this.active && this.hp > 0;
  }

  /** How squarely this bot is aiming back at `from` (0..1, squared falloff). */
  public aimPressureAt(from: THREE.Vector3): number {
    if (!this.active) return 0;
    const dx = from.x - this.group.position.x;
    const dz = from.z - this.group.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return 1;
    // Bot forward is -Z at yaw 0.
    const fx = -Math.sin(this.yaw);
    const fz = -Math.cos(this.yaw);
    const dot = (dx / len) * fx + (dz / len) * fz;
    if (dot <= 0) return 0;
    return dot * dot;
  }

  /** An enemy attack landed on this bot — routed by the enemy manager. */
  public receiveDamage(amount: number, from: THREE.Vector3): void {
    if (!this.active) return;
    this.hp -= amount;
    this.effects.burst(this.group.position.clone().setY(1.2), 0xff9f1c, 4, 1.2);
    if (this.hp <= 0) {
      this.down(from);
    }
  }

  /** Bolt connected — armor absorbs it; down at 0, redeploy on timer. */
  public takeDamage(amount: number): void {
    if (!this.active) return;
    this.hp -= amount;
    if (this.hp <= 0) this.down(this.group.position);
  }

  private down(from: THREE.Vector3): void {
    this.hp = 0;
    this.active = false;
    this.group.visible = false;
    this.respawnT = RESPAWN_TIME;
    this.victim = null;
    this.retreating = false;
    this.retreatT = 0;
    this.effects.burst(this.group.position.clone().setY(1.2), 0xff9f1c, 14, 2);
    void from;
    this.audio.slam();
  }

  public deploy(at: THREE.Vector3, idx: number): void {
    this.idx = idx;
    this.hp = MAX_HP;
    this.active = true;
    this.group.visible = true;
    this.respawnT = 0;
    this.fireT = 0.7;
    this.simTime = 0;
    this.yaw = 0;
    this.walkPhase = 0;
    this.gait = 0;
    this.recoilT = 0;
    this.victim = null;
    this.victimTimer = 0;
    this.retreating = false;
    this.retreatT = 0;
    this.leashBroken = false;
    this.hasAnchor = false;
    this.hasLastPos = false;
    this.velocity.set(0, 0, 0);
    this.role = idx === 0 ? 'flanker' : 'overwatch';
    this.rifle.position.z = this.rifleRestZ;
    this.rifle.rotation.x = 0;
    const off = SPAWN_OFFSETS[idx % SPAWN_OFFSETS.length] ?? [-2.4, 1.8];
    this.group.position.set(
      clamp(at.x + off[0] + randRange(-0.5, 0.5), -BOUNDS, BOUNDS),
      0,
      clamp(at.z + off[1] + randRange(-0.5, 0.5), -BOUNDS, BOUNDS),
    );
    this.group.rotation.set(0, 0, 0);
    this.effects.ring(this.group.position.clone().setY(0.1), 0xff9f1c, 3, 0.5);
    this.audio.allyDeploy();
  }

  public stow(): void {
    this.active = false;
    this.group.visible = false;
    // Without this the !active branch instantly redeploys on the next frame
    // (respawnT was already 0). deploy() re-arms the timer.
    this.respawnT = Number.POSITIVE_INFINITY;
    this.victim = null;
    this.retreating = false;
  }

  /**
   * `ownerPos` is a PREFERENCE, not a leash: the bot anchors to it while idle
   * but fights toward its own contact point once the squad is engaged.
   */
  public update(
    dt: number,
    ownerPos: THREE.Vector3,
    enemies: EnemyManager,
    /** Sibling bot — used so the pair never doubles up on one victim. */
    sibling: Bot | null,
  ): void {
    if (!this.active) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.deploy(ownerPos, this.idx);
      return;
    }

    this.simTime += dt;
    this.visorMat.emissiveIntensity = 2.4 + Math.sin(this.simTime * 5 + this.idx * 2.1) * 0.8;

    // World velocity for enemy ballistic lead — enemies now aim with real motion.
    if (this.hasLastPos && dt > 1e-5) {
      this.velocity.subVectors(this.group.position, this.lastPos).divideScalar(dt);
      this.velocity.clampLength(0, 12);
    }
    this.lastPos.copy(this.group.position);
    this.hasLastPos = true;

    this.updateAnchor(ownerPos);
    this.updateVictim(dt, enemies, sibling);
    this.updateRetreat(dt, enemies);
    const intent = this.chooseMoveTarget(ownerPos, enemies);
    const moved = this.moveToward(intent.x, intent.y, dt);
    this.updateGait(moved, dt);
    this.faceTarget(ownerPos, dt);
    this.updateFire(dt, enemies);
  }

  /**
   * Anchor = owner position quantized to a grid, so a walking human does not
   * drag the bots around every frame. Refreshed only on real movement.
   */
  private updateAnchor(ownerPos: THREE.Vector3): void {
    if (!this.hasAnchor
      || Math.hypot(this.anchor.x - ownerPos.x, this.anchor.y - ownerPos.z) > ANCHOR_REFRESH_DISTANCE) {
      this.anchor.set(ownerPos.x, ownerPos.z);
      this.hasAnchor = true;
    }
  }

  /**
   * Roles are assigned by the squad, never flipped independently: two bots
   * each running their own timer can (and did) land on the same role, which
   * makes them stack on one firing line. The closer bot takes the flank.
   */
  public assignRole(role: BotRole): void {
    this.role = role;
  }

  /**
   * Pick a victim and keep it. Re-scoring on a 0.4 s timer (rather than every
   * frame) plus preferring an unclaimed target is what stops the classic
   * companion target flicker.
   */
  private updateVictim(dt: number, enemies: EnemyManager, sibling: Bot | null): void {
    this.victimTimer -= dt;
    if (this.victim && this.victim.dead) this.victim = null;
    if (this.victimTimer > 0 && this.victim) return;
    this.victimTimer = VICTIM_RESCORE;
    const claimed = sibling?.victim ?? null;
    this.victim = enemies.nearestEnemyExcluding(this.group.position, [claimed], FIRE_RANGE)
      ?? enemies.nearestEnemyExcluding(this.group.position, [], FIRE_RANGE);
  }

  /**
   * Self-preservation with a hard ceiling: retreat below 30 %, re-engage at
   * 55 %, and never kite longer than 8 s — the standard pattern that avoids
   * the "companion runs away forever" failure.
   */
  private updateRetreat(dt: number, enemies: EnemyManager): void {
    if (this.retreating) {
      this.retreatT += dt;
      if (this.hpFraction >= REENGAGE_HP || this.retreatT >= RETREAT_MAX_TIME) {
        this.retreating = false;
        this.retreatT = 0;
      }
      return;
    }
    if (this.hpFraction > RETREAT_HP) return;
    // Only break contact if something is actually near enough to finish us.
    const threat = enemies.nearestEnemy(this.group.position);
    if (threat && threat.group.position.distanceTo(this.group.position) < RETREAT_TRIGGER_RANGE) {
      this.retreating = true;
      this.retreatT = 0;
    }
  }

  private chooseMoveTarget(ownerPos: THREE.Vector3, enemies: EnemyManager): THREE.Vector2 {
    const position = this.group.position;
    const ownerDistance = Math.hypot(ownerPos.x - position.x, ownerPos.z - position.z);
    this.leashBroken = ownerDistance > LEASH_HARD;

    // Hard leash: too far from the squad — break off and sprint home.
    if (this.leashBroken) {
      const dx = ownerPos.x - position.x;
      const dz = ownerPos.z - position.z;
      const length = Math.hypot(dx, dz) || 1;
      return this.moveTarget.set(
        clamp(ownerPos.x - (dx / length) * SLOT_BACK, -BOUNDS, BOUNDS),
        clamp(ownerPos.z - (dz / length) * SLOT_BACK, -BOUNDS, BOUNDS),
      );
    }

    if (this.retreating) {
      // Break contact: run away from the nearest enemy, staying inside bounds.
      const threat = enemies.nearestEnemy(position);
      if (threat) {
        const dx = position.x - threat.group.position.x;
        const dz = position.z - threat.group.position.z;
        const length = Math.hypot(dx, dz) || 1;
        return this.moveTarget.set(
          clamp(position.x + (dx / length) * 12, -BOUNDS, BOUNDS),
          clamp(position.z + (dz / length) * 12, -BOUNDS, BOUNDS),
        );
      }
    }

    if (this.victim) {
      const enemy = this.victim.group.position;
      const dx = position.x - enemy.x;
      const dz = position.z - enemy.z;
      const length = Math.hypot(dx, dz) || 1;
      const standoff = this.role === 'flanker' ? FLANK_STANDOFF : OVERWATCH_STANDOFF;
      // Opposite tangential signs per bot: they orbit from different sides
      // instead of trailing each other around the same arc.
      const side = this.idx === 0 ? 1 : -1;
      const strafe = side * Math.sin(this.simTime * 1.2 + this.idx * 1.7)
        * (this.role === 'flanker' ? 1.6 : 0.8);
      // Radial standoff plus a tangential offset: flankers orbit, overwatch holds.
      return this.moveTarget.set(
        clamp(enemy.x + (dx / length) * standoff - (dz / length) * strafe, -BOUNDS, BOUNDS),
        clamp(enemy.z + (dz / length) * standoff + (dx / length) * strafe, -BOUNDS, BOUNDS),
      );
    }

    // Idle: hold a rotated slot beside the anchor rather than standing on it.
    const angle = this.idx * Math.PI * 0.5 + 0.6;
    const slotX = this.anchor.x + Math.cos(angle) * SLOT_SIDE;
    const slotZ = this.anchor.y + Math.sin(angle) * SLOT_SIDE + SLOT_BACK;
    if (ownerDistance > LEASH_SOFT
      || Math.hypot(slotX - position.x, slotZ - position.z) > 2.5) {
      return this.moveTarget.set(clamp(slotX, -BOUNDS, BOUNDS), clamp(slotZ, -BOUNDS, BOUNDS));
    }
    return this.moveTarget.set(position.x, position.z);
  }

  private moveToward(x: number, z: number, dt: number): boolean {
    const position = this.group.position;
    const distance = Math.hypot(x - position.x, z - position.z);
    if (distance <= 0.15) return false;
    const direction = this.tmpA.set(x - position.x, 0, z - position.z).normalize();
    this.tmpRay.set(this.tmpB.set(position.x, position.y + 1, position.z), direction);
    const hit = this.octree.rayIntersect(this.tmpRay);
    if (hit && hit.distance <= 1.4) return false;
    const sprinting = this.retreating || this.leashBroken || distance > 8;
    const speed = sprinting ? SPEED * SPRINT_MULT : SPEED;
    position.x += direction.x * speed * dt;
    position.z += direction.z * speed * dt;
    return true;
  }

  private updateGait(moved: boolean, dt: number): void {
    this.gait = damp(this.gait, moved ? 1 : 0, 8, dt);
    if (moved || this.gait > 0.02) this.walkPhase += dt * SPEED * 1.9;
    const swing = Math.sin(this.walkPhase) * this.gait * 0.75;
    this.legL.rotation.x = swing;
    this.legR.rotation.x = -swing;
    this.armL.rotation.x = -swing * 0.6;
    this.armR.rotation.x = 1.4 - swing * 0.15;
    this.torsoMesh.rotation.x = damp(this.torsoMesh.rotation.x, moved ? -0.08 : 0, 6, dt);
    this.group.position.y = this.gait > 0.02
      ? Math.abs(Math.sin(this.walkPhase * 2)) * 0.04 * this.gait
      : 0;
  }

  /**
   * Face the victim when engaged, otherwise face the anchor. The owner's
   * position is only a fallback for a bot with nothing else to look at.
   */
  private faceTarget(ownerPos: THREE.Vector3, dt: number): void {
    const position = this.group.position;
    let faceX: number;
    let faceZ: number;
    if (this.victim) {
      faceX = this.victim.group.position.x;
      faceZ = this.victim.group.position.z;
    } else if (this.hasAnchor) {
      faceX = this.anchor.x;
      faceZ = this.anchor.y;
    } else {
      faceX = ownerPos.x;
      faceZ = ownerPos.z;
    }
    const dx = faceX - position.x;
    const dz = faceZ - position.z;
    if (dx * dx + dz * dz < 1e-4) return;
    this.yaw = dampAngle(this.yaw, Math.atan2(-dx, -dz), 8, dt);
    this.group.rotation.y = this.yaw;
  }

  /**
   * Fire at the victim when the current role's engagement band allows it.
   * Flankers commit at close range; overwatch holds a mid-range lane. A
   * retreating bot holds fire — that is what makes the retreat read as one.
   */
  private updateFire(dt: number, enemies: EnemyManager): void {
    this.fireT -= dt;
    this.recoilT = Math.max(0, this.recoilT - dt * 6);
    this.rifle.position.z = this.rifleRestZ + this.recoilT * 0.06;
    this.rifle.rotation.x = this.recoilT * 0.18;
    const target = this.victim;
    if (!target || this.fireT > 0 || this.retreating) return;

    const position = this.group.position;
    const engageRange = position.distanceTo(target.group.position);
    if (this.role === 'flanker') {
      if (engageRange > FLANK_MAX_RANGE) return;
    } else if (engageRange < OVERWATCH_MIN_RANGE || engageRange > OVERWATCH_MAX_RANGE) {
      return;
    }
    const center = this.tmpA.set(
      target.collider.start.x,
      (target.collider.start.y + target.collider.end.y) / 2,
      target.collider.start.z,
    );
    const eye = this.tmpB.set(position.x, position.y + 1.5, position.z);
    const toTarget = this.tmpC.copy(center).sub(eye);
    const distance = toTarget.length();
    if (distance <= 0.6 || distance > FIRE_RANGE) {
      this.fireT = 0.25;
      return;
    }
    toTarget.divideScalar(distance);
    this.tmpRay.set(eye, toTarget);
    const wall = this.octree.rayIntersect(this.tmpRay);
    if (wall && wall.distance <= distance - 0.5) {
      this.fireT = 0.12;
      return;
    }

    this.fireT = FIRE_CD + randRange(0, 0.14);
    this.recoilT = 1;
    const point = center.clone().add(
      this.tmpC.set(randRange(-0.2, 0.2), randRange(-0.25, 0.25), randRange(-0.2, 0.2)),
    );
    const hit = enemies.damageEnemy(
      target,
      SHOT_DMG * this.damageScale,
      point,
      undefined,
      false,
      this.id,
    );
    if (hit.killed) this.victim = null;
    const forward = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    const muzzle = this.tmpC.set(position.x + forward * 0.55, position.y + 1.34, position.z + forwardZ * 0.55);
    this.effects.tracer(muzzle, point, TRACER);
    this.effects.burst(muzzle, TRACER, 2, 1.2);
    // Pan is resolved by the owner (it knows the listener frame); the bot just
    // reports its own world position so it works with any listener.
    this.onShot?.(this.pan(position));
  }

  /** Screen-space pan (−1 left … +1 right) resolved by the owner's listener. */
  private pan(p: THREE.Vector3): number {
    return this.panProvider ? this.panProvider(p) : 0;
  }

  /** Injected by Ally: turns a world point into a stereo pan value. */
  public panProvider: ((p: THREE.Vector3) => number) | null = null;

  /** Live role label for HUD/debug. */
  public get roleLabel(): string {
    return this.retreating ? 'RETREAT' : this.role.toUpperCase();
  }

  /** Current victim — exposed so the sibling can avoid doubling up. */
  public get currentVictim(): Enemy | null {
    return this.victim;
  }
}

/**
 * The escort squad: two autonomous bots that fight beside the player.
 *
 * They are NOT leashed to the player: the owner position is only an idle
 * anchor. Both implement `CombatTarget`, so enemy AI scores them exactly like
 * the human and will shoot them when they are the better target.
 */
export class Ally {
  public readonly bots: Bot[];
  public onShot: ((pan: number) => void) | null = null;

  public constructor(
    scene: THREE.Scene,
    octree: Octree,
    effects: Effects,
    audio: GameAudio,
  ) {
    this.bots = [
      new Bot(scene, octree, effects, audio, 9001),
      new Bot(scene, octree, effects, audio, 9002),
    ];
    for (const bot of this.bots) {
      bot.panProvider = (p) => this.panProvider?.(p) ?? 0;
      bot.onShot = (pan) => this.onShot?.(pan);
    }
  }

  /** Set by Game: world point → stereo pan, using the live listener frame. */
  public panProvider: ((p: THREE.Vector3) => number) | null = null;
  private roleTimer = ROLE_AUCTION_INTERVAL;

  public get active(): boolean {
    return this.bots.some((b) => b.active);
  }

  public get aliveCount(): number {
    return this.bots.reduce((n, b) => n + (b.active ? 1 : 0), 0);
  }

  public get hp(): number {
    return this.bots.reduce((n, b) => n + b.hp, 0);
  }

  public get maxHp(): number {
    return MAX_HP * this.bots.length;
  }

  public deploy(at: THREE.Vector3): void {
    this.bots.forEach((bot, i) => bot.deploy(at, i));
  }

  public stow(): void {
    for (const bot of this.bots) bot.stow();
  }

  public update(
    dt: number,
    ownerPos: THREE.Vector3,
    enemies: EnemyManager,
    damageScale = 1,
  ): void {
    this.auctionRoles(dt);
    const [first, second] = this.bots;
    for (let i = 0; i < this.bots.length; i++) {
      const bot = this.bots[i];
      if (!bot) continue;
      bot.damageScale = damageScale;
      const sibling = i === 0 ? (second ?? null) : (first ?? null);
      bot.update(dt, ownerPos, enemies, sibling);
    }
    // A redeploy can land a bot on the role its partner already holds; enforce
    // the split AFTER updates so the pair is never mirrored for a whole cycle.
    if (first && second && first.active && second.active
      && first.roleLabel === second.roleLabel && first.roleLabel !== 'RETREAT') {
      second.assignRole(first.roleLabel === 'FLANKER' ? 'overwatch' : 'flanker');
    }
  }

  /**
   * Squad-level role auction on a slow cadence: the bot nearest its victim
   * flanks, the other holds overwatch. Assigned centrally so the pair can
   * never both hold the same role.
   */
  private auctionRoles(dt: number): void {
    this.roleTimer -= dt;
    if (this.roleTimer > 0) return;
    this.roleTimer = ROLE_AUCTION_INTERVAL;
    const [a, b] = this.bots;
    if (!a || !b) return;
    const distA = a.currentVictim ? a.position.distanceTo(a.currentVictim.group.position) : Infinity;
    const distB = b.currentVictim ? b.position.distanceTo(b.currentVictim.group.position) : Infinity;
    if (distA === Infinity && distB === Infinity) {
      // Nobody engaged: keep the pair split by index so they never both hold
      // the same role (a fresh deploy can land one bot on the other's role).
      a.assignRole('flanker');
      b.assignRole('overwatch');
      return;
    }
    const aFlanks = distA <= distB;
    a.assignRole(aFlanks ? 'flanker' : 'overwatch');
    b.assignRole(aFlanks ? 'overwatch' : 'flanker');
  }
}
