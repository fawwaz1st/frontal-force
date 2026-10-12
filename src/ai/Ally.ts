import * as THREE from 'three';
import type { Octree } from 'three/addons/math/Octree.js';
import type { EnemyManager, Enemy, Interceptor } from './Enemies';
import type { Effects } from '../render/Effects';
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

/* ---------- Autonomy tuning: no leash, only objectives ---------- */

/**
 * How far a bot will range from the arena centre. The bots are independent,
 * so the only thing bounding them is the arena itself, not the player.
 */
const ROAM_LIMIT = BOUNDS - 2;
/** Seconds between objective re-evaluations. Slow on purpose: a bot that
 *  changes its mind every frame looks confused, not decisive. */
const OBJECTIVE_INTERVAL = 1.6;
/** Combat standoff per role — flankers close, overwatch holds a lane. */
const FLANK_STANDOFF = 8;
/** A flanker commits inside this range; overwatch holds a band instead. */
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
/** A downed bot walks back in from the nearest arena edge, not from the
 *  player, so a respawn is not a teleport to the human's shoulder. */
const RESPAWN_INSET = 6;
/** Sector split cadence, in seconds. Slow on purpose: the shape of a fight
 *  does not flip fast, and a sector that changes every tick makes the pair
 *  oscillate between the same two clusters. */
const SECTOR_TICK = 2.5;

type BotRole = 'flanker' | 'overwatch';

/**
 * Humanoid escort bot — INDEPENDENT. It owns its objective, its sector, its
 * victim and its retreat decision. The player is not an anchor and there is no
 * leash: a bot decides where the fight is and goes there.
 *
 * Design: sector ownership + role auction.
 *
 *   SECTOR   Each bot is assigned half of the arena (split on the axis
 *            perpendicular to the biggest enemy cluster), and it is
 *            responsible for clearing its half. This is what makes two bots
 *            cover ground instead of trailing a human.
 *   ROLES    The pair auctions flanker/overwatch every 2 s so they never
 *            stack on one firing line.
 *   RETREAT  Self-preservation with a hard ceiling, because a bot that never
 *            disengages is a bot the player has to babysit.
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
  /** Own objective: where this bot has decided the fight is. */
  private readonly objective = new THREE.Vector2();
  private objectiveTimer = 0;
  private hasObjective = false;
  /** Which half of the arena this bot owns. Set by the squad. */
  private sectorSign = 1;
  /** Sector axis: true means the split is along Z, false along X. */
  private sectorAlongZ = false;
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

  /**
   * Bring the bot back in from its own sector edge.
   *
   * A respawn must not be a teleport to the player's shoulder: that would make
   * the bot dependent again the moment it dies. It walks back in from the edge
   * of the half it owns, which keeps it an independent unit for its whole life.
   */
  private redeploy(): void {
    const edge = ROAM_LIMIT - RESPAWN_INSET;
    const along = randRange(-edge * 0.6, edge * 0.6);
    if (this.sectorAlongZ) this.deploy(new THREE.Vector3(along, 0, this.sectorSign * edge), this.idx);
    else this.deploy(new THREE.Vector3(this.sectorSign * edge, 0, along), this.idx);
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
    this.hasObjective = false;
    this.objectiveTimer = 0;
    this.hasLastPos = false;
    this.velocity.set(0, 0, 0);
    this.role = idx === 0 ? 'flanker' : 'overwatch';
    this.rifle.position.z = this.rifleRestZ;
    this.rifle.rotation.x = 0;
    const off = SPAWN_OFFSETS[idx % SPAWN_OFFSETS.length] ?? [-2.4, 1.8];
    this.group.position.set(
      clamp(at.x + off[0] + randRange(-0.5, 0.5), -ROAM_LIMIT, ROAM_LIMIT),
      0,
      clamp(at.z + off[1] + randRange(-0.5, 0.5), -ROAM_LIMIT, ROAM_LIMIT),
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
   * `ownerPos` is accepted only so the wrapper can pass it uniformly; the bot
   * itself never reads it. The parameter is kept in the signature (and unused)
   * on purpose: it documents that this bot is independent, and a lint-suppressed
   * unused parameter is a stronger guarantee than a comment, because any future
   * edit that reaches for the player has to change this signature to do it.
   */
  public update(
    dt: number,
    ownerPos: THREE.Vector3,
    enemies: EnemyManager,
    /** Sibling bot — used so the pair never doubles up on one victim. */
    sibling: Bot | null,
  ): void {
    void ownerPos;
    if (!this.active) {
      this.respawnT -= dt;
      if (this.respawnT <= 0) this.redeploy();
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

    this.updateObjective(dt, enemies);
    this.updateVictim(dt, enemies, sibling);
    this.updateRetreat(dt, enemies);
    const intent = this.chooseMoveTarget(enemies);
    const moved = this.moveToward(intent.x, intent.y, dt);
    this.updateGait(moved, dt);
    this.faceTarget(dt);
    this.updateFire(dt, enemies);
  }

  /**
   * Pick where this bot wants to be.
   *
   * The objective is the enemy cluster inside its own sector, NOT the player.
   * A bot with no enemies in its sector falls back to the arena centre, which
   * makes it a roamer that sweeps for contact instead of a pet that orbits a
   * human. `ownerPos` is deliberately not a parameter: independence is
   * enforced by the signature, so no later edit can quietly reintroduce a
   * leash by reaching for the player's position.
   */
  private updateObjective(dt: number, enemies: EnemyManager): void {
    this.objectiveTimer -= dt;
    if (this.hasObjective && this.objectiveTimer > 0) return;
    this.objectiveTimer = OBJECTIVE_INTERVAL;

    // Average the live enemies inside this bot's sector. Averaging rather than
    // taking the nearest is what makes a bot walk toward the FIGHT and not
    // toward whichever straggler happens to be closest.
    let sumX = 0;
    let sumZ = 0;
    let count = 0;
    // The global cluster is the fallback: a bot whose own half is empty should
    // go help, not stand on a patrol point. Standing still while a firefight
    // happens one sector over is the failure mode this avoids.
    let allX = 0;
    let allZ = 0;
    let allCount = 0;
    enemies.forEachLive((enemy) => {
      const p = enemy.group.position;
      allX += p.x;
      allZ += p.z;
      allCount += 1;
      // The sector test: sign of the coordinate on the split axis.
      const coord = this.sectorAlongZ ? p.z : p.x;
      if (Math.sign(coord) !== this.sectorSign) return;
      sumX += p.x;
      sumZ += p.z;
      count += 1;
    });

    if (count > 0) {
      this.objective.set(sumX / count, sumZ / count);
      this.hasObjective = true;
      return;
    }
    if (allCount > 0) {
      // Own half is clear: reinforce. A small per-bot offset keeps the pair
      // from stacking on the exact same point when both sectors are empty.
      const spread = this.sectorSign * 4;
      this.objective.set(allX / allCount + spread, allZ / allCount - spread);
      this.hasObjective = true;
      return;
    }

    // Nothing alive anywhere: sweep the sector's own centroid so the bot is
    // still covering ground rather than standing still. The sector centroid is
    // a fixed point of the arena, which makes the patrol deterministic.
    const span = ROAM_LIMIT * 0.5;
    if (this.sectorAlongZ) this.objective.set(0, this.sectorSign * span);
    else this.objective.set(this.sectorSign * span, 0);
    this.hasObjective = true;
  }

  /**
   * The squad tells each bot which half of the arena it owns. Called by
   * `Ally.update` after reading the enemy distribution, so the two bots always
   * split on the axis where the fight actually is.
   */
  public assignSector(sign: number, alongZ: boolean): void {
    this.sectorSign = sign >= 0 ? 1 : -1;
    this.sectorAlongZ = alongZ;
    // Force a re-pick: the old objective belonged to the old sector.
    this.objectiveTimer = 0;
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

  private chooseMoveTarget(enemies: EnemyManager): THREE.Vector2 {
    const position = this.group.position;

    if (this.retreating) {
      // Break contact: run away from the nearest enemy, staying inside bounds.
      const threat = enemies.nearestEnemy(position);
      if (threat) {
        const dx = position.x - threat.group.position.x;
        const dz = position.z - threat.group.position.z;
        const length = Math.hypot(dx, dz) || 1;
        return this.moveTarget.set(
          clamp(position.x + (dx / length) * 12, -ROAM_LIMIT, ROAM_LIMIT),
          clamp(position.z + (dz / length) * 12, -ROAM_LIMIT, ROAM_LIMIT),
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
        clamp(enemy.x + (dx / length) * standoff - (dz / length) * strafe, -ROAM_LIMIT, ROAM_LIMIT),
        clamp(enemy.z + (dz / length) * standoff + (dx / length) * strafe, -ROAM_LIMIT, ROAM_LIMIT),
      );
    }

    // No victim: walk to the objective. This is the whole independence story:
    // the bot goes where the FIGHT is, not where the player is.
    const objective = this.hasObjective
      ? this.objective
      : { x: this.sectorSign * ROAM_LIMIT * 0.5, y: 0 };
    return this.moveTarget.set(
      clamp(objective.x, -ROAM_LIMIT, ROAM_LIMIT),
      clamp(objective.y, -ROAM_LIMIT, ROAM_LIMIT),
    );
  }

  /**
   * Walk toward a point, sliding along obstacles instead of stopping at them.
   *
   * The old version returned `false` the moment a ray hit anything within
   * 1.4 m, which meant a bot that met a crate simply stood there forever: it
   * had no way to know that stepping left would clear it. That is the bug the
   * player sees as "the bot is stuck on a box".
   *
   * The fix is the standard two-probe slide: cast at the target, and if that is
   * blocked, cast at the target rotated 55 degrees either way and take the
   * first one that is clear. The bot walks around the obstacle and re-aims at
   * the objective on the next tick, so no path memory is needed.
   */
  private moveToward(x: number, z: number, dt: number): boolean {
    const position = this.group.position;
    const distance = Math.hypot(x - position.x, z - position.z);
    if (distance <= 0.15) return false;
    const base = Math.atan2(z - position.z, x - position.x);

    // Probe the direct line first, then the two detours. 55 degrees is wide
    // enough to clear a 1.4 m crate from 1.4 m away and narrow enough that the
    // bot still makes progress toward its objective rather than circling.
    const DETOUR = (55 * Math.PI) / 180;
    const CLEAR = 2.2;
    let heading = base;
    let found = false;
    for (const offset of [0, DETOUR, -DETOUR]) {
      const a = base + offset;
      const dx = Math.cos(a);
      const dz = Math.sin(a);
      this.tmpRay.set(this.tmpB.set(position.x, position.y + 1, position.z), this.tmpC.set(dx, 0, dz));
      const hit = this.octree.rayIntersect(this.tmpRay);
      if (!hit || hit.distance > CLEAR) {
        heading = a;
        found = true;
        break;
      }
    }
    // Boxed in on all three probes: hold position rather than vibrate against
    // the wall. The next tick re-probes, so this clears itself.
    if (!found) return false;

    const sprinting = this.retreating || distance > 8;
    const speed = sprinting ? SPEED * SPRINT_MULT : SPEED;
    position.x += Math.cos(heading) * speed * dt;
    position.z += Math.sin(heading) * speed * dt;
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
   * Face the victim when engaged, otherwise face the objective this bot chose
   * for itself. There is no player fallback: a bot with nothing to shoot looks
   * where it is GOING, which is what makes a patrolling escort read as a unit
   * with its own agenda.
   */
  private faceTarget(dt: number): void {
    const position = this.group.position;
    let faceX: number;
    let faceZ: number;
    if (this.victim) {
      faceX = this.victim.group.position.x;
      faceZ = this.victim.group.position.z;
    } else if (this.hasObjective) {
      faceX = this.objective.x;
      faceZ = this.objective.y;
    } else {
      faceX = this.sectorSign * ROAM_LIMIT;
      faceZ = 0;
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
  /** Sector split cadence. Slow: the shape of a fight does not flip fast. */
  private sectorTimer = SECTOR_TICK;

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
    this.assignSectors(dt, enemies);
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
   * Split the arena between the bots.
   *
   * The split axis is whichever of X or Z the enemy cloud is more spread along,
   * so the pair divides the fight where it actually is instead of dividing the
   * map arbitrarily. Each bot owns a sign on that axis. This is the mechanism
   * that makes two escorts cover ground: with no leash and a shared objective,
   * both would simply walk to the same cluster.
   */
  private assignSectors(dt: number, enemies: EnemyManager): void {
    this.sectorTimer -= dt;
    if (this.sectorTimer > 0) return;
    this.sectorTimer = SECTOR_TICK;
    let minX = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let minZ = Number.POSITIVE_INFINITY;
    let maxZ = Number.NEGATIVE_INFINITY;
    let count = 0;
    enemies.forEachLive((enemy) => {
      const p = enemy.group.position;
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.z < minZ) minZ = p.z;
      if (p.z > maxZ) maxZ = p.z;
      count += 1;
    });
    if (count === 0) return;
    // Split along the wider spread. A tie goes to X, which is arbitrary but
    // deterministic, and a deterministic tie is better than a flipping one.
    const alongZ = (maxZ - minZ) > (maxX - minX);
    const [a, b] = this.bots;
    if (a) a.assignSector(-1, alongZ);
    if (b) b.assignSector(1, alongZ);
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
