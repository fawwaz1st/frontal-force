/**
 * Arena hazards: explosive barrels, tesla coils, and flame vents.
 *
 * Fully procedural and pooled: every mesh is built once in the constructor and
 * re-armed by `spawnAll`, so starting a run allocates nothing. Hazards never
 * touch the player or the enemy roster directly. All damage leaves through
 * `HazardDamageSink`, which keeps kill attribution, scoring, and ragdolls in
 * the orchestrator where that state already lives.
 *
 * The one non-obvious rule is the deferred kill. `damageHazard` has no sink, so
 * a barrel that reaches 0 HP is only MARKED, then destroyed on a later `update`
 * tick. A cluster therefore cascades exactly one link per tick, and a
 * detonation can never recurse back into the sink that caused it.
 */
import * as THREE from 'three';
import type { Octree } from 'three/addons/math/Octree.js';
import type { Effects } from '../render/Effects';
import type { GameAudio } from '../audio/Audio';
import { clamp } from '../core/math';
import { ARENA_LIMIT } from './World';

export type HazardKind = 'barrel' | 'tesla' | 'vent';

/** A hazard that can be triggered and can damage the player and enemies. */
export interface Hazard {
  kind: HazardKind;
  /** Root object added to the scene. */
  group: THREE.Group;
  position: THREE.Vector3;
  /** HP for destructible hazards (barrels); Infinity for indestructible. */
  health: number;
  alive: boolean;
  /** Seconds until the next internal state change (charge, vent pulse...). */
  timer: number;
  /** Current cycle phase, for the visual/audio telegraph. */
  phase: 'idle' | 'charging' | 'firing' | 'cooling' | 'spent';
  /** Radius of the damaging effect, in metres. */
  radius: number;
  /** Damage per application. */
  damage: number;
  /** Hazard-specific scratch value (tesla charge fraction, vent pulse count). */
  scratch: number;
}

export interface HazardDamageSink {
  /** Damage every live enemy within `radius` of `point`. Returns how many died. */
  damageEnemiesInRadius(
    point: THREE.Vector3,
    radius: number,
    damage: number,
    floor: number,
    source: 'barrel' | 'hazard',
  ): number;
  /** Damage the player if inside the radius. Returns true when the player was hit.
   *  `source` is a short player-facing label so the HUD can name the hazard. */
  damagePlayerInRadius(
    point: THREE.Vector3,
    radius: number,
    damage: number,
    source?: string,
  ): boolean;
}

/**
 * A cover marker, accepted in either shape the project uses. `World.coverSpots`
 * is typed `CoverSpotData` (`center`), while a bare `{ position }` is the
 * minimal contract, so both are taken here and neither call site needs an
 * adapter.
 */
export type CoverClearanceSpot = { position: THREE.Vector3 } | { center: THREE.Vector3 };

/** Internal state the public `Hazard` view does not need to expose. */
interface HazardRuntime extends Hazard {
  /** Seconds accumulated toward the next periodic damage application. */
  tick: number;
  /** Destruction queued for a later tick, because the sink only exists in `update`. */
  pendingDeath: boolean;
  /** Tick at which `pendingDeath` becomes consumable. */
  pendingTick: number;
  /** True when any pending damage was dealt by the player. */
  pendingByPlayer: boolean;
  /** Per-instance glow material (tesla orb, vent mouth), so pulses stay independent. */
  glow: THREE.MeshStandardMaterial | null;
}

// ---------- Placement ----------

/** Rejection samples per hazard before the last candidate is accepted. */
const PLACE_ATTEMPTS = 40;
/** Placement stays this far inside the arena walls. */
const PLACE_MARGIN = 1.2;
/** Downward probe origin for the floor snap. */
const PROBE_HEIGHT = 24;
/** Floor hits above this are cover lids, so the sample is rejected. */
const FLOOR_BAND = 0.08;
/**
 * Mirrors `World.playerSpawn`. `spawnAll` is handed no spawn point, so the
 * keep-clear radius is measured from this constant. Keep the two in sync.
 */
const PLAYER_SPAWN = new THREE.Vector3(0, 0, 40);

const BARREL_COUNT = 7;
const TESLA_COUNT = 3;
const VENT_COUNT = 4;

// ---------- Barrel ----------

const BARREL_BODY_COLOR = 0x3a3f28;
const BARREL_BAND_COLOR = 0xff9f1c;
const BARREL_MESH_RADIUS = 0.34;
const BARREL_MESH_HEIGHT = 0.95;
const BARREL_BAND_Y = 0.62;
const BARREL_HEALTH = 60;
const BARREL_RADIUS = 4.5;
const BARREL_DAMAGE = 120;
const BARREL_ENEMY_FLOOR = 0.3;
/** Self-blast uses a tighter radius so a point-blank barrel punishes, not deletes. */
const BARREL_SELF_RADIUS = 3.6;
const BARREL_SELF_FRACTION = 0.45;
const BARREL_CHAIN_RADIUS = 5;
const BARREL_CHAIN_DAMAGE = 200;
const BARREL_MIN_SPAWN_DISTANCE = 6;
const BARREL_MIN_APART = 3;
const BARREL_COVER_CLEARANCE = 1.5;
const BARREL_HIT_SPARKS = 4;
const BARREL_HIT_SPARK_SPEED = 1;
const BARREL_BLAST_SPARKS = 18;
const BARREL_BLAST_SPARK_SPEED = 2.4;
/** Ring geometry base radius is 0.5 m, so 8.8 opens the ring to the blast radius. */
const BARREL_RING_GROW = 8.8;
const BARREL_RING_LIFE = 0.5;

// ---------- Tesla coil ----------

const TESLA_BODY_COLOR = 0x22262b;
const TESLA_ORB_COLOR = 0x7dd8ff;
const TESLA_PILLAR_RADIUS = 0.16;
const TESLA_PILLAR_HEIGHT = 1.8;
const TESLA_ORB_Y = 1.9;
const TESLA_ORB_RADIUS = 0.22;
/** Authored idle glow; charging ramps above it so the telegraph reads at range. */
const TESLA_ORB_GLOW = 2.2;
const TESLA_ORB_CHARGE_GAIN = 3.4;
const TESLA_ORB_FIRE_GLOW = 6.2;
const TESLA_CHARGE_FLICKER_FREQ = 26;
const TESLA_CHARGE_FLICKER_GAIN = 0.7;
const TESLA_IDLE = 2;
const TESLA_CHARGE = 0.9;
const TESLA_FIRE = 0.55;
const TESLA_DAMAGE_INTERVAL = 0.25;
const TESLA_RADIUS = 8;
const TESLA_DAMAGE = 22;
const TESLA_ENEMY_FLOOR = 1;
const TESLA_RING_GROW = 8;
const TESLA_SPARKS = 6;
const TESLA_SPARK_SPEED = 1.4;
const TESLA_MIN_SPAWN_DISTANCE = 9;
const TESLA_MIN_APART = 10;

// ---------- Flame vent ----------

const VENT_BODY_COLOR = 0x1b1e17;
const VENT_MOUTH_COLOR = 0xff8a3c;
const VENT_GRATE_RADIUS = 0.55;
const VENT_GRATE_HEIGHT = 0.08;
const VENT_MOUTH_RADIUS = 0.4;
const VENT_MOUTH_HEIGHT = 0.07;
const VENT_MOUTH_Y = 0.16;
const VENT_MOUTH_TILT = 0.3;
const VENT_MOUTH_GLOW = 1.1;
/** Ramp lands exactly on the firing glow, so ignition has no brightness pop. */
const VENT_MOUTH_CHARGE_GAIN = 2.3;
const VENT_MOUTH_FIRE_GLOW = 3.4;
const VENT_IDLE = 3.2;
const VENT_CHARGE = 0.8;
const VENT_FIRE = 2.2;
const VENT_DAMAGE_INTERVAL = 0.5;
const VENT_RADIUS = 2.4;
/** The player eats the full burn; `VENT_ENEMY_DAMAGE` is the softer value below. */
const VENT_DAMAGE = 30;
/**
 * Deliberately below `VENT_DAMAGE`: the vent must stay a positional threat that
 * a standing player respects, not a turret that out-clears a tesla coil. Four
 * applications of 12 also keeps a vent from deleting a full-health rusher that
 * is merely crossing it.
 */
const VENT_ENEMY_DAMAGE = 12;
const VENT_ENEMY_FLOOR = 0.8;
const VENT_RING_GROW = 2.2;
const VENT_BURST_SPARKS = 16;
const VENT_BURST_SPEED = 1.8;
const VENT_SMOKE_JITTER = 0.3;
const VENT_MIN_SPAWN_DISTANCE = 8;
const VENT_MIN_APART = 8;

export class Hazards {
  /** Fired when a hazard triggers, so the caller can award score. */
  public onTrigger: ((hazard: Hazard) => void) | null = null;
  /** Fired when a destructible hazard is destroyed. */
  public onDestroyed: ((hazard: Hazard, byPlayer: boolean) => void) | null = null;

  private readonly group = new THREE.Group();
  private readonly items: HazardRuntime[] = [];
  private readonly tmp = new THREE.Vector3();
  private readonly up = new THREE.Vector3(0, 1, 0);
  private readonly listener = new THREE.Vector3();
  private readonly probeRay = new THREE.Ray(new THREE.Vector3(), new THREE.Vector3(0, -1, 0));
  /** Monotonic update counter; stamps deferred kills so they wait one tick. */
  private tickCount = 0;

  // Shared geometry and materials, one instance per kind for the whole pool.
  private readonly barrelGeo = new THREE.CylinderGeometry(
    BARREL_MESH_RADIUS, BARREL_MESH_RADIUS, BARREL_MESH_HEIGHT, 12,
  );
  private readonly bandGeo = new THREE.TorusGeometry(BARREL_MESH_RADIUS + 0.01, 0.05, 5, 14);
  private readonly barrelMat = new THREE.MeshStandardMaterial({
    color: BARREL_BODY_COLOR, roughness: 0.72, metalness: 0.35,
  });
  private readonly bandMat = new THREE.MeshStandardMaterial({
    color: BARREL_BAND_COLOR,
    emissive: BARREL_BAND_COLOR,
    emissiveIntensity: 0.55,
    roughness: 0.5,
    metalness: 0.2,
  });
  private readonly pillarGeo = new THREE.CylinderGeometry(
    TESLA_PILLAR_RADIUS, TESLA_PILLAR_RADIUS, TESLA_PILLAR_HEIGHT, 10,
  );
  private readonly orbGeo = new THREE.SphereGeometry(TESLA_ORB_RADIUS, 12, 10);
  private readonly pillarMat = new THREE.MeshStandardMaterial({
    color: TESLA_BODY_COLOR, roughness: 0.45, metalness: 0.75,
  });
  private readonly grateGeo = new THREE.CylinderGeometry(
    VENT_GRATE_RADIUS, VENT_GRATE_RADIUS, VENT_GRATE_HEIGHT, 14,
  );
  private readonly mouthGeo = new THREE.CylinderGeometry(
    VENT_MOUTH_RADIUS, VENT_MOUTH_RADIUS, VENT_MOUTH_HEIGHT, 12,
  );
  private readonly grateMat = new THREE.MeshStandardMaterial({
    color: VENT_BODY_COLOR, roughness: 0.85, metalness: 0.4,
  });

  /**
   * Hazards are added to the scene but never to the collision octree: the arena
   * bakes the octree before hazards spawn, and a barrel that blocked movement
   * would be a trap rather than a target. Weapon hits are routed in through
   * `damageHazard` instead. The octree is read here for placement only, where
   * its per-query allocations are off the frame path.
   */
  public constructor(
    scene: THREE.Scene,
    private readonly octree: Octree,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
  ) {
    scene.add(this.group);
    for (let i = 0; i < BARREL_COUNT; i++) this.items.push(this.buildBarrel());
    for (let i = 0; i < TESLA_COUNT; i++) this.items.push(this.buildTesla());
    for (let i = 0; i < VENT_COUNT; i++) this.items.push(this.buildVent());
  }

  /** Rebuild all hazards for a fresh run. `rng` must be a () => number in [0,1). */
  public spawnAll(rng: () => number, coverSpots: readonly CoverClearanceSpot[]): void {
    this.clear();
    // Pool order (barrels, coils, vents) fixes the rng consumption order, so the
    // same seed always produces the same layout.
    for (const h of this.items) {
      if (h.kind === 'barrel') {
        this.place(
          h, rng, BARREL_MIN_SPAWN_DISTANCE, BARREL_MIN_APART, BARREL_COVER_CLEARANCE, coverSpots,
        );
      } else if (h.kind === 'tesla') {
        this.place(h, rng, TESLA_MIN_SPAWN_DISTANCE, TESLA_MIN_APART, 0, coverSpots);
        // Staggered start: three coils firing on the same frame would read as
        // one global event instead of three separate threats.
        h.timer = rng() * TESLA_IDLE;
      } else {
        this.place(h, rng, VENT_MIN_SPAWN_DISTANCE, VENT_MIN_APART, 0, coverSpots);
        h.timer = rng() * VENT_IDLE;
      }
    }
  }

  /** Remove everything (menu / run end). */
  public clear(): void {
    this.tickCount = 0;
    for (const h of this.items) {
      h.alive = false;
      h.phase = 'idle';
      h.timer = 0;
      h.scratch = 0;
      h.tick = 0;
      h.pendingDeath = false;
      h.pendingTick = 0;
      h.pendingByPlayer = false;
      h.health = h.kind === 'barrel' ? BARREL_HEALTH : Number.POSITIVE_INFINITY;
      h.group.visible = false;
      if (h.glow) h.glow.emissiveIntensity = this.idleGlow(h);
    }
  }

  public update(dt: number, sink: HazardDamageSink, playerPosition: THREE.Vector3): void {
    this.tickCount += 1;
    this.listener.copy(playerPosition);
    // Deferred kills resolve first, so a detonation fired during this pass is
    // stamped for the NEXT tick and a chain can never recurse through the sink.
    this.resolvePending(sink);
    for (const h of this.items) {
      if (!h.alive || h.kind === 'barrel') continue;
      if (h.kind === 'tesla') this.stepTesla(h, dt, sink);
      else this.stepVent(h, dt, sink);
    }
  }

  /** Player shot or melee hit. Returns true when the hazard absorbed the hit. */
  public damageHazard(
    hazard: Hazard,
    amount: number,
    point: THREE.Vector3,
    byPlayer: boolean,
  ): boolean {
    const h = this.runtimeOf(hazard);
    // Indestructible hazards do not absorb: the round carries on to what is behind.
    if (!h || !h.alive || h.kind !== 'barrel') return false;
    this.effects.burst(point, BARREL_BAND_COLOR, BARREL_HIT_SPARKS, BARREL_HIT_SPARK_SPEED);
    this.audio.blocked();
    h.health -= amount;
    if (h.health <= 0) {
      h.health = 0;
      this.queueDeath(h, byPlayer);
    }
    return true;
  }

  /** Nearest alive hazard within `range` of `point`, or null. */
  public nearest(point: THREE.Vector3, range: number): Hazard | null {
    let best: HazardRuntime | null = null;
    let bestSq = range * range;
    for (const h of this.items) {
      if (!h.alive) continue;
      const dx = h.position.x - point.x;
      const dy = h.position.y - point.y;
      const dz = h.position.z - point.z;
      const d = dx * dx + dy * dy + dz * dz;
      if (d > bestSq) continue;
      bestSq = d;
      best = h;
    }
    return best;
  }

  public get hazards(): readonly Hazard[] {
    return this.items;
  }

  public get aliveCount(): number {
    let count = 0;
    for (const h of this.items) if (h.alive) count += 1;
    return count;
  }

  // ---------- Pool construction ----------

  private buildBarrel(): HazardRuntime {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.barrelGeo, this.barrelMat);
    body.position.y = BARREL_MESH_HEIGHT * 0.5;
    body.castShadow = true;
    body.receiveShadow = true;
    const band = new THREE.Mesh(this.bandGeo, this.bandMat);
    band.position.y = BARREL_BAND_Y;
    band.rotation.x = Math.PI / 2;
    group.add(body, band);
    group.visible = false;
    this.group.add(group);
    return this.makeRuntime('barrel', group, BARREL_HEALTH, BARREL_RADIUS, BARREL_DAMAGE, null);
  }

  private buildTesla(): HazardRuntime {
    const group = new THREE.Group();
    const pillar = new THREE.Mesh(this.pillarGeo, this.pillarMat);
    pillar.position.y = TESLA_PILLAR_HEIGHT * 0.5;
    pillar.castShadow = true;
    pillar.receiveShadow = true;
    // Cloned per coil: the charge pulse is per-hazard state, not shared state.
    const glow = new THREE.MeshStandardMaterial({
      color: TESLA_ORB_COLOR,
      emissive: TESLA_ORB_COLOR,
      emissiveIntensity: TESLA_ORB_GLOW,
      roughness: 0.25,
      metalness: 0.1,
    });
    const orb = new THREE.Mesh(this.orbGeo, glow);
    orb.position.y = TESLA_ORB_Y;
    group.add(pillar, orb);
    group.visible = false;
    this.group.add(group);
    return this.makeRuntime(
      'tesla', group, Number.POSITIVE_INFINITY, TESLA_RADIUS, TESLA_DAMAGE, glow,
    );
  }

  private buildVent(): HazardRuntime {
    const group = new THREE.Group();
    const grate = new THREE.Mesh(this.grateGeo, this.grateMat);
    grate.position.y = VENT_GRATE_HEIGHT * 0.5;
    grate.castShadow = true;
    grate.receiveShadow = true;
    // Cloned per vent so each mouth ramps on its own charge window.
    const glow = new THREE.MeshStandardMaterial({
      color: VENT_MOUTH_COLOR,
      emissive: VENT_MOUTH_COLOR,
      emissiveIntensity: VENT_MOUTH_GLOW,
      roughness: 0.4,
      metalness: 0.1,
    });
    const mouth = new THREE.Mesh(this.mouthGeo, glow);
    mouth.position.y = VENT_MOUTH_Y;
    mouth.rotation.x = VENT_MOUTH_TILT;
    group.add(grate, mouth);
    group.visible = false;
    this.group.add(group);
    return this.makeRuntime(
      'vent', group, Number.POSITIVE_INFINITY, VENT_RADIUS, VENT_DAMAGE, glow,
    );
  }

  private makeRuntime(
    kind: HazardKind,
    group: THREE.Group,
    health: number,
    radius: number,
    damage: number,
    glow: THREE.MeshStandardMaterial | null,
  ): HazardRuntime {
    return {
      kind,
      group,
      position: new THREE.Vector3(),
      health,
      alive: false,
      timer: 0,
      phase: 'idle',
      radius,
      damage,
      scratch: 0,
      tick: 0,
      pendingDeath: false,
      pendingTick: 0,
      pendingByPlayer: false,
      glow,
    };
  }

  private idleGlow(h: HazardRuntime): number {
    return h.kind === 'tesla' ? TESLA_ORB_GLOW : VENT_MOUTH_GLOW;
  }

  // ---------- Placement ----------

  private place(
    h: HazardRuntime,
    rng: () => number,
    minSpawnDistance: number,
    minApart: number,
    coverClearance: number,
    coverSpots: readonly CoverClearanceSpot[],
  ): void {
    const limit = Math.max(1, ARENA_LIMIT - PLACE_MARGIN);
    let x = 0;
    let z = 0;
    for (let attempt = 0; attempt < PLACE_ATTEMPTS; attempt++) {
      x = (rng() * 2 - 1) * limit;
      z = (rng() * 2 - 1) * limit;
      if (this.spotIsFree(h, x, z, minSpawnDistance, minApart, coverClearance, coverSpots)) break;
    }
    // A failed sweep accepts the last sample: a crowded arena degrades to a
    // tight cluster instead of hanging the run start on an impossible search.
    const onFloor = this.probeFloor(x, z);
    h.position.set(x, onFloor ? this.tmp.y : 0, z);
    h.group.position.copy(h.position);
    h.group.visible = true;
    h.alive = true;
    h.phase = 'idle';
    h.scratch = 0;
    h.tick = 0;
    h.pendingDeath = false;
    h.pendingTick = 0;
    h.pendingByPlayer = false;
    h.health = h.kind === 'barrel' ? BARREL_HEALTH : Number.POSITIVE_INFINITY;
  }

  private spotIsFree(
    h: HazardRuntime,
    x: number,
    z: number,
    minSpawnDistance: number,
    minApart: number,
    coverClearance: number,
    coverSpots: readonly CoverClearanceSpot[],
  ): boolean {
    const spawnX = x - PLAYER_SPAWN.x;
    const spawnZ = z - PLAYER_SPAWN.z;
    if (spawnX * spawnX + spawnZ * spawnZ < minSpawnDistance * minSpawnDistance) return false;
    // Rejects samples on top of cover as well as samples buried inside it.
    if (!this.probeFloor(x, z)) return false;
    // Spacing is per kind: a coil next to a barrel is a deliberate cluster.
    for (const other of this.items) {
      if (other === h || !other.alive || other.kind !== h.kind) continue;
      const dx = other.position.x - x;
      const dz = other.position.z - z;
      if (dx * dx + dz * dz < minApart * minApart) return false;
    }
    if (coverClearance > 0) {
      for (const spot of coverSpots) {
        const p = 'position' in spot ? spot.position : spot.center;
        const dx = p.x - x;
        const dz = p.z - z;
        if (dx * dx + dz * dz < coverClearance * coverClearance) return false;
      }
    }
    return true;
  }

  /**
   * Snap a candidate to the arena floor. Returns false when the sample sits on
   * top of cover, which is what keeps hazards out of geometry. The probe result
   * lands in `tmp` so the caller never allocates.
   */
  private probeFloor(x: number, z: number): boolean {
    this.probeRay.origin.set(x, PROBE_HEIGHT, z);
    this.probeRay.direction.set(0, -1, 0);
    const hit = this.octree.rayIntersect(this.probeRay);
    if (!hit) {
      // No floor under the sample: fall back to the plane so nothing floats.
      this.tmp.set(x, 0, z);
      return true;
    }
    if (hit.position.y > FLOOR_BAND) return false;
    this.tmp.set(x, hit.position.y, z);
    return true;
  }

  // ---------- Deferred destruction ----------

  private resolvePending(sink: HazardDamageSink): void {
    for (const h of this.items) {
      if (!h.alive || !h.pendingDeath || h.pendingTick > this.tickCount) continue;
      h.pendingDeath = false;
      const byPlayer = h.pendingByPlayer;
      h.pendingByPlayer = false;
      this.destroy(h, sink, byPlayer);
    }
  }

  /** Queue destruction for a later tick: the sink is only reachable from `update`. */
  private queueDeath(h: HazardRuntime, byPlayer: boolean): void {
    h.pendingDeath = true;
    h.pendingByPlayer ||= byPlayer;
    h.pendingTick = this.tickCount + 1;
  }

  private destroy(h: HazardRuntime, sink: HazardDamageSink, byPlayer: boolean): void {
    h.alive = false;
    h.phase = 'spent';
    h.group.visible = false;
    if (h.kind === 'barrel') this.detonate(h, sink, byPlayer);
    this.onDestroyed?.(h, byPlayer);
  }

  private detonate(h: HazardRuntime, sink: HazardDamageSink, byPlayer: boolean): void {
    const p = h.position;
    sink.damageEnemiesInRadius(p, h.radius, h.damage, BARREL_ENEMY_FLOOR, 'barrel');
    sink.damagePlayerInRadius(p, BARREL_SELF_RADIUS, h.damage * BARREL_SELF_FRACTION, 'BARREL BLAST');
    this.effects.ring(p, BARREL_BAND_COLOR, BARREL_RING_GROW, BARREL_RING_LIFE);
    this.effects.burst(p, BARREL_BAND_COLOR, BARREL_BLAST_SPARKS, BARREL_BLAST_SPARK_SPEED);
    this.audio.barrelBlast(this.panToward(p));
    this.onTrigger?.(h);
    // Cluster chain: neighbours take fatal damage stamped for the NEXT tick,
    // which is what makes a row of barrels read as one cascade.
    for (const other of this.items) {
      if (other === h || !other.alive || other.kind !== 'barrel') continue;
      const dx = other.position.x - p.x;
      const dz = other.position.z - p.z;
      if (dx * dx + dz * dz > BARREL_CHAIN_RADIUS * BARREL_CHAIN_RADIUS) continue;
      other.health -= BARREL_CHAIN_DAMAGE;
      if (other.health <= 0) this.queueDeath(other, byPlayer);
    }
  }

  // ---------- Cycles ----------

  private stepTesla(h: HazardRuntime, dt: number, sink: HazardDamageSink): void {
    h.timer -= dt;
    if (h.phase === 'idle') {
      if (h.timer > 0) return;
      h.phase = 'charging';
      h.timer = TESLA_CHARGE;
      h.scratch = 0;
      this.audio.hazardCharge();
      return;
    }
    if (h.phase === 'charging') {
      h.scratch = 1 - Math.max(0, h.timer) / TESLA_CHARGE;
      if (h.glow) {
        h.glow.emissiveIntensity = TESLA_ORB_GLOW
          + h.scratch * TESLA_ORB_CHARGE_GAIN
          + Math.sin(h.scratch * TESLA_CHARGE_FLICKER_FREQ) * TESLA_CHARGE_FLICKER_GAIN;
      }
      if (h.timer > 0) return;
      h.phase = 'firing';
      h.timer = TESLA_FIRE;
      h.tick = TESLA_DAMAGE_INTERVAL;
      h.scratch = 0;
      if (h.glow) h.glow.emissiveIntensity = TESLA_ORB_FIRE_GLOW;
      // Ring life equals the first damage interval, so the shockwave lands with
      // the first hit instead of promising damage the coil has not dealt yet.
      this.effects.ring(h.position, TESLA_ORB_COLOR, TESLA_RING_GROW, TESLA_DAMAGE_INTERVAL);
      this.onTrigger?.(h);
      return;
    }
    if (h.phase !== 'firing') return;
    h.tick -= dt;
    if (h.tick <= 0) {
      h.tick += TESLA_DAMAGE_INTERVAL;
      sink.damageEnemiesInRadius(
        h.position, h.radius, h.damage, TESLA_ENEMY_FLOOR, 'hazard',
      );
      sink.damagePlayerInRadius(h.position, h.radius, h.damage, 'TESLA COIL');
      this.tmp.copy(h.position);
      this.tmp.y += TESLA_ORB_Y;
      this.effects.burst(this.tmp, TESLA_ORB_COLOR, TESLA_SPARKS, TESLA_SPARK_SPEED);
    }
    if (h.timer <= 0) {
      h.phase = 'idle';
      h.timer = TESLA_IDLE;
      h.scratch = 0;
      if (h.glow) h.glow.emissiveIntensity = TESLA_ORB_GLOW;
    }
  }

  private stepVent(h: HazardRuntime, dt: number, sink: HazardDamageSink): void {
    h.timer -= dt;
    if (h.phase === 'idle') {
      if (h.timer > 0) return;
      h.phase = 'charging';
      h.timer = VENT_CHARGE;
      h.scratch = 0;
      // Decal spans the whole charge window: the player gets the full warning
      // before the footprint becomes lethal.
      this.effects.ring(h.position, VENT_MOUTH_COLOR, VENT_RING_GROW, VENT_CHARGE);
      return;
    }
    if (h.phase === 'charging') {
      h.scratch = 1 - Math.max(0, h.timer) / VENT_CHARGE;
      if (h.glow) {
        h.glow.emissiveIntensity = VENT_MOUTH_GLOW + h.scratch * VENT_MOUTH_CHARGE_GAIN;
      }
      if (h.timer > 0) return;
      h.phase = 'firing';
      h.timer = VENT_FIRE;
      h.tick = VENT_DAMAGE_INTERVAL;
      h.scratch = 0;
      if (h.glow) h.glow.emissiveIntensity = VENT_MOUTH_FIRE_GLOW;
      this.tmp.copy(h.position);
      this.tmp.y += VENT_MOUTH_Y;
      this.effects.burst(this.tmp, VENT_MOUTH_COLOR, VENT_BURST_SPARKS, VENT_BURST_SPEED);
      this.onTrigger?.(h);
      return;
    }
    if (h.phase !== 'firing') return;
    h.tick -= dt;
    if (h.tick <= 0) {
      h.tick += VENT_DAMAGE_INTERVAL;
      h.scratch += 1;
      sink.damageEnemiesInRadius(
        h.position, h.radius, VENT_ENEMY_DAMAGE, VENT_ENEMY_FLOOR, 'hazard',
      );
      sink.damagePlayerInRadius(h.position, h.radius, VENT_DAMAGE, 'STEAM VENT');
      this.tmp.copy(h.position);
      this.tmp.x += (Math.random() - 0.5) * VENT_SMOKE_JITTER;
      this.tmp.z += (Math.random() - 0.5) * VENT_SMOKE_JITTER;
      this.tmp.y += VENT_MOUTH_Y;
      this.effects.smoke(this.tmp, this.up);
    }
    if (h.timer <= 0) {
      h.phase = 'idle';
      h.timer = VENT_IDLE;
      h.scratch = 0;
      if (h.glow) h.glow.emissiveIntensity = VENT_MOUTH_GLOW;
    }
  }

  // ---------- Helpers ----------

  private runtimeOf(hazard: Hazard): HazardRuntime | null {
    for (const h of this.items) if (h === hazard) return h;
    return null;
  }

  /**
   * Stereo pan of a world point. `update` carries no listener yaw, so the pan
   * rides the world X axis: the arena is played along Z (spawn at +Z, arena at
   * -Z), where world X is screen X for the player's default facing.
   */
  private panToward(pos: THREE.Vector3): number {
    const dx = pos.x - this.listener.x;
    const dz = pos.z - this.listener.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return 0;
    return clamp(dx / len, -1, 1);
  }
}
