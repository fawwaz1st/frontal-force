import * as THREE from 'three';
import { Capsule } from 'three/addons/math/Capsule.js';
import type { Octree } from 'three/addons/math/Octree.js';
import type { Effects } from '../render/Effects';
import type { GameAudio } from '../audio/Audio';
import { clamp, damp, dampAngle, randRange } from '../core/math';
import {
  TacticalDirector,
  type CoverSpotData,
  type TacticalClaim,
} from './Tactics';
import {
  GRUDGE_WINDOW,
  grudgeAt,
  RETARGET_INTERVAL,
  RETARGET_STAGGER,
  TARGET_COMMIT_TIME,
  TARGET_SWITCH_HYSTERESIS,
  threatScore,
  type CombatTarget,
} from '../combat/Combatant';
import {
  AFFIXES,
  AFFIX_IDS,
  affixCountForWave,
  applyAffix,
  eliteChanceForWave,
  eliteScoreMul,
  makeEliteHalo,
  type AffixId,
  type AffixStats,
} from './Affixes';

export type EnemyKind =
  | 'grunt' | 'rusher' | 'gunner' | 'warden'
  /** Long-range one-shot threat: a laser telegraph then a fast, hard-hitting bolt. */
  | 'sniper'
  /** Floating drone that ignores cover and orbits at head height. */
  | 'flyer'
  /** Charges the player and detonates; the counter-play is killing it early. */
  | 'exploder'
  /** Fragile support that heals its squad, so it changes the target priority. */
  | 'healer'
  /** Spawns grunts on a cooldown; ignores the player to keep the pipeline up. */
  | 'summoner'
  /** Every fifth wave. Phased, weak-pointed, enrages when the timer runs out. */
  | 'wardenPrime';

/** Kinds that count as "elite" for scoring even without affixes. */
export const ELITE_KINDS: readonly EnemyKind[] = ['wardenPrime'];

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
  /** Short player-facing name, used by the HUD when this kind hurts you. */
  label: string;
}

const DEFS: Record<EnemyKind, EnemyDef> = {
  grunt: { health: 60, speed: 3.4, radius: 0.42, height: 1.7, color: 0xd95cff, attackRange: 26, attackCooldown: 1.6, damage: 8, score: 100, label: 'GRUNT' },
  rusher: { health: 40, speed: 6.2, radius: 0.38, height: 1.4, color: 0xff5c5c, attackRange: 1.7, attackCooldown: 0.9, damage: 14, score: 150, label: 'RUSHER' },
  gunner: { health: 110, speed: 2.2, radius: 0.5, height: 1.9, color: 0xffb03a, attackRange: 30, attackCooldown: 2.4, damage: 12, score: 250, label: 'GUNNER' },
  warden: { health: 180, speed: 2.6, radius: 0.55, height: 2.0, color: 0x35f0c8, attackRange: 22, attackCooldown: 2.4, damage: 16, score: 400, label: 'WARDEN' },
  // Sniper: the longest telegraph in the game (1.1 s) buys the biggest single
  // hit. Its 44 m range means it must be found and killed, not out-ranged.
  sniper: { health: 70, speed: 2.4, radius: 0.4, height: 1.75, color: 0xff4d6d, attackRange: 44, attackCooldown: 3.4, damage: 34, score: 450, label: 'SNIPER' },
  // Flyer: ignores cover entirely, so it punishes pure corner-camping. Low HP
  // and a slow bob make it a priority but not a threat spike.
  flyer: { health: 55, speed: 4.4, radius: 0.42, height: 1.5, color: 0x7dd8ff, attackRange: 18, attackCooldown: 1.5, damage: 9, score: 220, label: 'FLYER' },
  // Exploder: fast, fragile, and its damage is on DEATH. Killing it at range
  // is the whole counter-play, which teaches spacing without a tutorial.
  exploder: { health: 45, speed: 5.0, radius: 0.44, height: 1.55, color: 0xff9f1c, attackRange: 2.6, attackCooldown: 2.0, damage: 34, score: 200, label: 'EXPLODER' },
  // Healer: 3%/s to every enemy within 9 m. Killing it first is the lesson.
  healer: { health: 90, speed: 2.8, radius: 0.42, height: 1.7, color: 0x7fe08a, attackRange: 14, attackCooldown: 2.8, damage: 6, score: 350, label: 'HEALER' },
  // Summoner: spawns a grunt every 6 s. Ignores the player, so it must be
  // hunted rather than waited out.
  summoner: { health: 150, speed: 2.0, radius: 0.5, height: 1.85, color: 0xc98aff, attackRange: 20, attackCooldown: 6.0, damage: 10, score: 500, label: 'SUMMONER' },
  // Warden Prime: the every-fifth-wave boss. 2200 base health, three phases,
  // a rear weak point at 2.5x, and an enrage timer.
  wardenPrime: { health: 2200, speed: 2.2, radius: 0.85, height: 3.1, color: 0xffd76b, attackRange: 30, attackCooldown: 1.5, damage: 20, score: 5000, label: 'WARDEN PRIME' },
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
  /** Cooldown for the blind-search objective refresh. */
  searchSyncT: number;
  /** Warden guard: consecutive frontal blocks absorbed before the guard breaks. */
  shieldBlocks: number;
  /** simTime of the last counted frontal block — dedupes multi-pellet volleys
   *  so one shotgun trigger pull is one block, not eight. -1 = never. */
  shieldHitT: number;
  /** Seconds of guard-break left — shield lowered, full damage taken. */
  staggerT: number;
  tacticalId: number;
  state: 'advance' | 'cover' | 'peek' | 'search' | 'flank' | 'suppress';
  /** Affixes carried (empty for ordinary enemies). */
  affixes: AffixId[];
  /** True for affixed enemies and boss kinds. */
  elite: boolean;
  /** Flat damage reduction from the Armored affix. */
  flatArmor: number;
  /** Stagger/knockback immunity (Juggernaut). */
  ccImmune: boolean;
  /** Remaining burn stacks (damage over time). */
  burnT: number;
  burnDps: number;
  /** Slow applied by the Glacial affix, in seconds. */
  slowT: number;
  /** Boss phase 1..3; 0 for non-bosses. */
  phase: number;
  /** Boss enrage countdown in seconds; Infinity for non-bosses. */
  enrageT: number;
  /** True once the boss weak point has been destroyed. */
  weakPointBroken: boolean;
  /** Rear-core damage accumulated this fight; the core breaks at a fraction
   *  of the boss's max health (see BOSS_CORE_BREAK_FRACTION). */
  coreDamage: number;
  /** Visual halo for elites, or null. */
  halo: THREE.Mesh | null;
  /** Current chosen victim. Null only before the first resolve pass. */
  target: CombatTarget | null;
  /** Seconds until the next target re-score (staggered per agent). */
  retargetT: number;
  /** Seconds of forced commitment to the current target. */
  commitT: number;
  /** Seconds left on the grudge against `grudgeId` (a target that hurt me). */
  grudgeT: number;
  /** Which target hurt me most recently — grudge is aimed at this one only. */
  grudgeId: number;
  /** Last resolve result for the current target: was it in sight? */
  targetVisible: boolean;
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
  /** Seconds left on a committed slide: a low, fast, straight-line burst. */
  slideT: number;
  /** Committed slide direction (XZ, normalised). */
  slideDirX: number;
  slideDirZ: number;
  /** Seconds left on a dodge: a hard lateral burst away from incoming fire. */
  dodgeT: number;
  /** Side of the current dodge (+1 / -1) and its cooldown. */
  dodgeSide: number;
  dodgeCd: number;
  /** Seconds left on a juke: a short repositioning burst along `jukeSide`. */
  jukeT: number;
  jukeSide: number;
  /** Countdown to the next juke; staggered so a squad never jukes in unison. */
  jukeCd: number;
  /** Hit flinch: seconds left, amplitude in radians, and the push direction. */
  flinchT: number;
  flinchAmp: number;
  flinchX: number;
  flinchZ: number;
  /** Seconds spent failing to make progress against geometry. */
  stuckT: number;
  /** Seconds left on a committed sideways detour around an obstacle. */
  detourT: number;
  /** Which side the detour commits to (+1 / -1). */
  detourSide: number;
}

export interface Projectile {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  damage: number;
  life: number;
  active: boolean;
  /** Identity of the target this bolt was aimed at — bolts only hurt their
   *  intended victim's team, so a stray round never hits a bystander. */
  targetId: number;
  /** Short player-facing name of the shooter, so the HUD can name the source
   *  of an incoming hit instead of leaving the player guessing. */
  sourceLabel: string;
  /** True once this bolt has already whipped past the player. Without it a
   *  single bolt fires a near-miss sound on every tick it stays close. */
  nearMissed: boolean;
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
/** Wardens telegraph longer — the shield swings open during this window. */
const WARDEN_WINDUP = 0.45;
/** Consecutive frontal blocks that break a warden's guard. */
const WARDEN_SHIELD_BREAK = 6;
/** Guard-break duration in seconds (shield down, full damage, no block). */
const WARDEN_STAGGER = 1.2;
/** Blind agents re-orient lastKnown toward the objective at this cadence. */
const SEARCH_SYNC_INTERVAL = 3;
const PERCEPTION_INTERVAL = 0.125;
/** Alerted contact memory (seconds) — longer than the unalerted baseline. */
const SEARCH_MEMORY = 6;
const MAX_ACTIVE_SHOOTERS = 4;
const BURST_MAX = 3;
/** Boss phase thresholds (fraction of max health remaining). */
const BOSS_PHASE_2 = 0.66;
const BOSS_PHASE_3 = 0.33;
/** CombatTarget id of the human player. Mirrors WeaponController's constant;
 *  duplicated as a literal because the AI module must not import the weapon
 *  module just for one number (that would be a cycle). */
const PLAYER_TARGET_ID = 1;
/** Seconds before a boss enrages: +25% damage, 20% shorter telegraphs. */
const BOSS_ENRAGE_TIME = 90;
/** Weak-point damage multiplier (Doom-style permanent disable). */
const BOSS_WEAKPOINT_MUL = 2.5;
/** Rear-core damage (post-multiplier) that permanently destroys the core, as a
 *  fraction of the boss's max health. Set so a focused flanker breaks it in a
 *  handful of precision hits, not a full magazine. */
const BOSS_CORE_BREAK_FRACTION = 0.18;
/** Exploder detonation radius and damage. */
const EXPLODER_RADIUS = 4.2;
const EXPLODER_DAMAGE = 46;
/** Healer: radius and fraction of max health restored per second. */
const HEALER_RADIUS = 9;
const HEALER_RATE = 0.03;
/** Summoner cadence in seconds. */
const SUMMON_INTERVAL = 6;
/** Flyer hover height above the floor. */
const FLYER_HEIGHT = 1.9;
/** Burn applied by Blazing affixes: damage per second and duration. */
const AFFIX_BURN_DPS = 9;
const AFFIX_BURN_TIME = 3;
/** Glacial slow: fraction of speed removed and duration. */
const AFFIX_SLOW_MUL = 0.65;
const AFFIX_SLOW_TIME = 2;

// ---------------------------------------------------------------------------
// Agility. The old AI only walked and strafed on a sine, which is why it read
// as inert. Three short, committed bursts give it readable intent:
//   dodge  — reactive lateral burst the moment it takes fire
//   juke   — proactive lateral burst that breaks a straight approach line
//   slide  — low, fast, straight commit used to close the last few metres
// All three are short (under 0.7 s) so they punctuate the walk cycle instead
// of replacing it, and all three keep the agent's aim on its victim.
// ---------------------------------------------------------------------------
/** Length of a reactive dodge burst. */
const AGILITY_DODGE_TIME = 0.32;
/** Speed multiplier while dodging. */
const AGILITY_DODGE_MUL = 2.35;
/** Length of a proactive juke burst. */
const AGILITY_JUKE_TIME = 0.26;
/** Speed multiplier while juking. */
const AGILITY_JUKE_MUL = 2.1;
/** Length of an AI slide. */
const AGILITY_SLIDE_TIME = 0.55;
/** Speed multiplier while sliding (rushers and exploders only). */
const AGILITY_SLIDE_MUL = 2.9;
/** Distance window in which a melee agent commits to a slide. */
const AGILITY_SLIDE_RANGE = 9;
/** Dodge cooldown bounds, in seconds. */
const AGILITY_DODGE_CD_MIN = 0.7;
const AGILITY_DODGE_CD_MAX = 1.9;

// ---------------------------------------------------------------------------
// Squad tactics.
//
// The old AI was ten independent agents that happened to share an arena. Each
// one picked its own victim and walked at it, so a wave read as a queue of
// duels rather than as a squad. Three mechanisms fix that, and all three are
// cheap: they are properties of the roster, not per-agent pathfinding.
//
//   1. FIRE TEAMS. The roster is split into teams of three by tactical id.
//      A team shares ONE victim, so a squad concentrates instead of spreading.
//   2. BOUNDING. Inside a team, at most one agent is "up" (advancing) at a
//      time; the others hold and cover it. That is the real infantry bounding
//      overwatch, and it is what makes a squad look like it has a plan.
//   3. SUPPRESSION. An agent that has held a firing position for a while keeps
//      firing even without a clean line, which is what makes cover feel
//      contested instead of binary.
// ---------------------------------------------------------------------------
/** Agents per fire team. Three is the smallest group that can bound (one up,
 *  one covering, one reloading) and it maps cleanly onto the wave sizes. */
const FIRE_TEAM_SIZE = 3;
/** How long an agent holds its firing position before rotating out. */
const BOUND_HOLD_TIME = 2.2;
/** Cadence of the team state refresh. Not per frame: teams move on the scale
 *  of seconds, and a per-frame recompute would be pure waste. */
const TEAM_TICK = 0.35;

/** One fire team's shared state, rebuilt from the roster each tick. */
interface FireTeam {
  /** Shared victim. Every member of the team shoots at this. */
  focus: CombatTarget | null;
  /** Seconds the current member has been up (advancing). */
  boundT: number;
  /** Tactical id of the member currently advancing. */
  upId: number;
}

/**
 * Multiplier applied to a candidate's threat score when it is the team's
 * shared victim. Deliberately modest: a large bonus would override the
 * individual's own judgement and make the squad walk past a target in front
 * of it, which reads as the AI being blind rather than coordinated.
 */
const FOCUS_FIRE_BONUS = 1.6;
/** A holding agent keeps its hold while the target is inside this range. Past
 *  it the agent is too far from the fight to be useful as covering fire. */
const HOLD_MAX_RANGE = 24;

/**
 * Per-kind armor look. Ten archetypes sharing one gunmetal frame with a
 * coloured strip is why the roster read as "the same model, ten times".
 *
 * Each entry changes three things at once, because one is never enough:
 *   tint      how far the plate leans toward the kind's own hue (0 = neutral)
 *   roughness how matte the plate is (fabric-ish support vs polished heavy)
 *   metalness how much it catches the arena lights (glass vs iron)
 *   glow      emissive multiplier on the body material
 *   plateGlow emissive on the armor plates themselves, for the powered kinds
 */
interface ArmorLook {
  tint: number;
  roughness: number;
  metalness: number;
  glow: number;
  plateGlow: number;
}

/**
 * Per-kind proportions. Width, head size and limb thickness, so two kinds with
 * the same height still read as different bodies: a sniper is narrow with a
 * small head, a gunner is wide and thick, a summoner is tall and thin.
 */
interface Proportion {
  /** Shoulder separation multiplier. */
  shoulder: number;
  /** Shoulder pad size multiplier. */
  pad: number;
  /** Head scale multiplier. */
  head: number;
}

const PROPORTION: Record<EnemyKind, Proportion> = {
  grunt: { shoulder: 1, pad: 1, head: 1 },
  rusher: { shoulder: 0.88, pad: 0.8, head: 0.92 },
  gunner: { shoulder: 1.2, pad: 1.25, head: 1.05 },
  warden: { shoulder: 1.12, pad: 1.35, head: 0.95 },
  sniper: { shoulder: 0.86, pad: 0.75, head: 0.85 },
  flyer: { shoulder: 0.9, pad: 0.7, head: 0.9 },
  exploder: { shoulder: 1.05, pad: 0.9, head: 0.95 },
  healer: { shoulder: 0.94, pad: 0.85, head: 1.1 },
  summoner: { shoulder: 1.05, pad: 1.1, head: 1.15 },
  wardenPrime: { shoulder: 1.35, pad: 1.6, head: 1.2 },
};

const ARMOR_LOOK: Record<EnemyKind, ArmorLook> = {
  // Scavenged plates: matte, dirty, barely tinted. The baseline human.
  grunt: { tint: 0.34, roughness: 0.82, metalness: 0.12, glow: 0.85, plateGlow: 0.05 },
  // Bare frame, almost no plate: it survives on speed, not armor.
  rusher: { tint: 0.5, roughness: 0.72, metalness: 0.2, glow: 1.1, plateGlow: 0.12 },
  // Heavy industrial plating, scuffed but solid, with a lit ammo pack.
  gunner: { tint: 0.36, roughness: 0.55, metalness: 0.55, glow: 0.8, plateGlow: 0.1 },
  // Polished ceramic riot plate: the shield IS the character.
  warden: { tint: 0.42, roughness: 0.28, metalness: 0.35, glow: 1.0, plateGlow: 0.18 },
  // Matte black with a single cold lens: it should almost vanish at range.
  sniper: { tint: 0.2, roughness: 0.9, metalness: 0.1, glow: 0.6, plateGlow: 0.02 },
  // Light composites: thin, glossy, built to fly.
  flyer: { tint: 0.46, roughness: 0.3, metalness: 0.45, glow: 1.15, plateGlow: 0.2 },
  // Exposed hazard shell with the charge tank glowing through it.
  exploder: { tint: 0.62, roughness: 0.6, metalness: 0.25, glow: 1.45, plateGlow: 0.5 },
  // Clean white support chassis: the only bright body on the field.
  healer: { tint: 0.3, roughness: 0.42, metalness: 0.15, glow: 1.2, plateGlow: 0.35 },
  // Deep violet lacquer with the emitter lit: ceremonial, alien, expensive.
  summoner: { tint: 0.55, roughness: 0.24, metalness: 0.6, glow: 1.25, plateGlow: 0.45 },
  // Boss: gold-plated and self-lit, with the rear core burning through.
  wardenPrime: { tint: 0.6, roughness: 0.18, metalness: 0.85, glow: 1.5, plateGlow: 0.6 },
};

export class EnemyManager {
  private readonly group = new THREE.Group();
  public onEnemyKilled: ((enemy: Enemy, byPlayer: boolean) => void) | null = null;
  /** Player yaw for the current frame — lets enemy sfx pan to their screen side. */
  public playerYaw = 0;
  /** Escort bots that intercept bolts before they reach the player. */
  public readonly interceptors: Interceptor[] = [];
  /**
   * Every valid victim, registered by Game each frame (player + escorts).
   * Enemy AI never references "the player" directly — it scores this list, so
   * adding a friendly type costs one push and no AI changes.
   */
  public readonly targets: CombatTarget[] = [];

  /** Reinitialize cover claims after World regenerates its layout. */
  public setCoverSpots(spots: readonly CoverSpotData[]): void {
    this.tactics.rebuild(spots);
  }

  private readonly enemies: Enemy[] = [];
  private readonly projectiles: Projectile[] = [];
  private readonly tactics = new TacticalDirector();
  private nextTacticalId = 1;
  private simTime = 0;
  private readonly lastPlayerPos = new THREE.Vector3();
  private hasPlayerPos = false;
  private readonly bodyMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
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
    shield: new THREE.BoxGeometry(0.55, 0.75, 0.06),
  } as const;
  private readonly projMat = new THREE.MeshBasicMaterial({ color: 0xff6bd7 });
  private readonly projMats = new Map<EnemyKind, THREE.MeshBasicMaterial>();
  private readonly projGlowMats = new Map<EnemyKind, THREE.MeshBasicMaterial>();
  private readonly stripMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
  private readonly armorMats = new Map<EnemyKind, THREE.MeshStandardMaterial>();
  /** Gravity for ballistic bolts (m/s²) — flat-fire low-arc solution. */
  private static readonly BOLT_G = 1.6;
  private readonly tmp = new THREE.Vector3();
  private readonly tmp2 = new THREE.Vector3();
  private readonly tmp3 = new THREE.Vector3();
  private readonly tmp4 = new THREE.Vector3();
  private readonly tmp5 = new THREE.Vector3();
  private readonly tmpHead = new THREE.Vector3();
  private readonly tmpRay = new THREE.Ray();
  /** Per-step readiness snapshot — hoisted out of the per-enemy attack scan
   *  so `updateAttack` never walks the roster again (was O(n²) per step). */
  private readyShooters = 0;
  private readyRushers = 0;
  /** Reused return slot for `resolveWardenHit` (no per-hit object churn). */
  private readonly wardenHit = { damage: 0, blocked: false };
  /** Fire-team state, keyed by team index. Rebuilt each team tick. */
  private readonly teams = new Map<number, FireTeam>();
  private teamTimer = 0;

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
      this.projectiles.push({
        mesh: bolt, vel: new THREE.Vector3(), damage: 0, life: 0, active: false,
        targetId: -1, sourceLabel: '', nearMissed: false,
      });
    }
  }

  public get aliveCount(): number {
    return this.enemies.reduce((n, e) => n + (e.dead ? 0 : 1), 0);
  }

  /** Live elites (affixed or boss kinds). Drives the HUD threat readout. */
  public get eliteAliveCount(): number {
    return this.enemies.reduce((n, e) => n + (!e.dead && e.elite ? 1 : 0), 0);
  }

  /** The live boss, or null. At most one exists at a time by design. */
  public get activeBoss(): Enemy | null {
    for (const enemy of this.enemies) {
      if (!enemy.dead && enemy.kind === 'wardenPrime') return enemy;
    }
    return null;
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

  /**
   * The enemy this position should shoot at: live enemies only, and never one
   * that is already inside `exclude` (so an escort never wastes shots on the
   * target its partner is already committed to).
   */
  public nearestEnemyExcluding(
    position: THREE.Vector3,
    exclude: readonly (Enemy | null)[] = [],
    maxRange = Number.POSITIVE_INFINITY,
  ): Enemy | null {
    let nearest: Enemy | null = null;
    let bestDistanceSq = maxRange === Number.POSITIVE_INFINITY
      ? Number.MAX_SAFE_INTEGER
      : maxRange * maxRange;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      let skip = false;
      for (const ex of exclude) {
        if (ex === enemy) { skip = true; break; }
      }
      if (skip) continue;
      const dx = enemy.group.position.x - position.x;
      const dz = enemy.group.position.z - position.z;
      const distanceSq = dx * dx + dz * dz;
      if (distanceSq >= bestDistanceSq) continue;
      bestDistanceSq = distanceSq;
      nearest = enemy;
    }
    return nearest;
  }

  /**
   * Threat-table entry: the target that just damaged this agent. Called by
   * `damageEnemy` so the AI holds a grudge for GRUDGE_WINDOW seconds.
   */
  public markAggressor(enemy: Enemy, attackerId: number): void {
    enemy.grudgeId = attackerId;
    enemy.grudgeT = GRUDGE_WINDOW;
  }

  /**
   * Score every registered target and commit to the best one.
   * Staggered per agent (RETARGET_STAGGER) and rate-limited (RETARGET_INTERVAL)
   * so the whole roster never re-scores on the same frame. Switching away from
   * the incumbent requires beating it by TARGET_SWITCH_HYSTERESIS, which is
   * what stops the per-frame target thrashing that utility AI is prone to.
   */
  private resolveTarget(enemy: Enemy, dt: number): void {
    enemy.retargetT -= dt;
    enemy.commitT = Math.max(0, enemy.commitT - dt);
    enemy.grudgeT = Math.max(0, enemy.grudgeT - dt);
    const current = enemy.target;
    // A downed or unregistered target is dropped immediately — no hysteresis.
    if (current && !current.targetable) enemy.target = null;
    if (enemy.retargetT > 0) return;
    // Stagger across the roster so the whole wave never re-scores on one frame.
    // `tacticalId` grows without bound across a session, so wrap it — an
    // unwrapped offset would stretch the re-score period into seconds by late
    // waves and leave targets stale.
    enemy.retargetT = RETARGET_INTERVAL + (enemy.tacticalId % 32) * RETARGET_STAGGER;

    const incumbent = enemy.target;
    let best: CombatTarget | null = null;
    let bestScore = 0;
    // Focus fire: a team member prefers the team's shared victim. This is a
    // BONUS rather than a hard override, so an agent with a genuinely better
    // shot (a flanker that just cleared cover) still takes it. Forcing the
    // team target outright made squads walk past targets they could see, which
    // read as the AI ignoring the player.
    const team = this.teamOf(enemy);
    const focus = team?.focus ?? null;
    for (const candidate of this.targets) {
      if (!candidate.targetable) continue;
      const distance = enemy.group.position.distanceTo(candidate.position);
      const maxDistance = enemy.kind === 'gunner' || enemy.kind === 'warden' ? 34 : 28;
      const inSight = distance <= maxDistance
        && this.hasLineOfSight(enemy.group.position, candidate.position);
      // A target we can see scores full; one we only remember scores a fraction.
      const remembered = candidate === incumbent && enemy.memory > 0 && enemy.targetVisible;
      const visibility = inSight ? 1 : remembered ? 0.35 : 0;
      if (visibility <= 0) continue;
      const score = threatScore({
        distance,
        role: candidate.threatRole,
        aggression: enemy.grudgeId === candidate.targetId
          ? grudgeAt(GRUDGE_WINDOW - enemy.grudgeT)
          : 0,
        hpFraction: candidate.hpFraction,
        aimPressure: candidate.aimPressureAt(enemy.group.position),
        visibility,
      }) * (candidate === focus ? FOCUS_FIRE_BONUS : 1);
      if (score <= bestScore) continue;
      bestScore = score;
      best = candidate;
    }

    if (!best) {
      // Nothing visible: keep the last victim as the memory anchor.
      return;
    }
    if (incumbent && incumbent.targetable && best !== incumbent) {
      if (enemy.commitT > 0) return;
      const incumbentScore = threatScore({
        distance: enemy.group.position.distanceTo(incumbent.position),
        role: incumbent.threatRole,
        aggression: enemy.grudgeId === incumbent.targetId
          ? grudgeAt(GRUDGE_WINDOW - enemy.grudgeT)
          : 0,
        hpFraction: incumbent.hpFraction,
        aimPressure: incumbent.aimPressureAt(enemy.group.position),
        visibility: 1,
      });
      if (bestScore < incumbentScore * TARGET_SWITCH_HYSTERESIS) return;
    }
    if (best !== incumbent) {
      enemy.target = best;
      enemy.commitT = TARGET_COMMIT_TIME;
      // New victim: the old memory anchor is stale.
      enemy.lastKnown.copy(best.position);
    }
  }

  /**
   * Spawn an enemy.
   *
   * `wave` drives the elite roll: affixed elites appear from wave 3, carry
   * more affixes as the run climbs, and are always worth substantially more
   * score. The affix stats are applied to the per-spawn def clone, so the
   * shared DEFS table is never mutated.
   */
  public spawn(
    kind: EnemyKind,
    position: THREE.Vector3,
    hpMul = 1,
    spdMul = 1,
    atkMul = 1,
    wave = 1,
    eliteAllowed = true,
    /** Extra affixes granted to an elite, from the run's challenges. */
    extraAffixes = 0,
  ): void {
    // Per-spawn def clone: wave scaling never mutates the shared DEFS table.
    const base = DEFS[kind];
    const def: EnemyDef = {
      ...base,
      health: Math.round(base.health * hpMul),
      speed: base.speed * spdMul,
      attackCooldown: base.attackCooldown * atkMul,
    };

    // Elite roll. Boss kinds are always elite but never carry affixes: their
    // own phase kit is the variety, and stacking affixes on a 2200 HP boss
    // would make the fight unreadable.
    const isBoss = kind === 'wardenPrime';
    const affixes: AffixId[] = [];
    if (!isBoss && eliteAllowed && wave >= 3 && Math.random() < eliteChanceForWave(wave)) {
      const count = affixCountForWave(wave) + Math.max(0, Math.floor(extraAffixes));
      const pool = AFFIX_IDS.slice();
      for (let i = 0; i < count && pool.length > 0; i++) {
        const idx = Math.floor(Math.random() * pool.length);
        const picked = pool.splice(idx, 1)[0];
        if (picked) affixes.push(picked);
      }
    }
    const elite = isBoss || affixes.length > 0;
    let flatArmor = 0;
    let ccImmune = false;
    let opacity = 1;
    let glow = 0;
    let tint: number | null = null;
    if (affixes.length > 0) {
      const stats: AffixStats = {
        health: def.health,
        damage: def.damage,
        speed: def.speed,
        score: def.score,
        flatArmor: 0,
        ccImmune: false,
        opacity: 1,
        glow: 0,
        tint: null,
      };
      for (const id of affixes) applyAffix(stats, AFFIXES[id]);
      def.health = Math.round(stats.health);
      def.damage = Math.round(stats.damage * 10) / 10;
      def.speed = stats.speed;
      def.score = Math.round(stats.score * eliteScoreMul(affixes.length));
      flatArmor = stats.flatArmor;
      ccImmune = stats.ccImmune;
      opacity = stats.opacity;
      glow = stats.glow;
      tint = stats.tint;
    } else if (isBoss) {
      def.score = Math.round(def.score * eliteScoreMul(3));
    }

    const group = new THREE.Group();
    const model = this.buildModel(kind, def.height / 1.7);
    group.add(model.root);
    group.position.copy(position);
    this.group.add(group);

    // Elite tell: one material tint plus a halo. Readable in under a second,
    // which is the rule every affix has to satisfy.
    let halo: THREE.Mesh | null = null;
    if (elite) {
      const bodyMat = model.body.material as THREE.MeshStandardMaterial;
      if (tint !== null) bodyMat.color.setHex(tint);
      if (glow > 0) {
        const strip = this.stripMats.get(kind);
        if (strip) strip.emissiveIntensity = glow;
      }
      if (opacity < 1) {
        bodyMat.transparent = true;
        bodyMat.opacity = opacity;
      }
      halo = makeEliteHalo(def.radius * 1.5, tint ?? base.color);
      halo.position.y = 0.08;
      group.add(halo);
    }

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
      affixes,
      elite,
      flatArmor,
      ccImmune,
      burnT: 0,
      burnDps: 0,
      slowT: 0,
      phase: isBoss ? 1 : 0,
      enrageT: isBoss ? BOSS_ENRAGE_TIME : Number.POSITIVE_INFINITY,
      weakPointBroken: false,
      coreDamage: 0,
      halo,
      // Seed the objective at spawn: without this, blind agents search their
      // own spawn point and freeze outside perception range forever.
      lastKnown: this.hasPlayerPos ? this.lastPlayerPos.clone() : position.clone(),
      attackTimer: randRange(0.5, def.attackCooldown),
      strafeSeed: Math.random() * Math.PI * 2,
      searchSyncT: randRange(0.4, SEARCH_SYNC_INTERVAL),
      tacticalId: this.nextTacticalId++,
      state: kind === 'rusher' ? 'flank' : kind === 'warden' ? 'suppress' : 'advance',
      target: null,
      retargetT: Math.random() * RETARGET_INTERVAL,
      commitT: 0,
      grudgeT: 0,
      grudgeId: -1,
      targetVisible: false,
      claim: null,
      perceptionTimer: Math.random() * PERCEPTION_INTERVAL,
      visible: false,
      seenFor: 0,
      memory: 0,
      decisionTimer: randRange(0.1, 0.8),
      burst: 1 + Math.floor(Math.random() * 3),
      slideT: 0,
      slideDirX: 0,
      slideDirZ: 0,
      dodgeT: 0,
      dodgeSide: Math.random() < 0.5 ? -1 : 1,
      dodgeCd: 0,
      jukeT: 0,
      jukeSide: Math.random() < 0.5 ? -1 : 1,
      jukeCd: randRange(1.2, 3.4),
      flinchT: 0,
      flinchAmp: 0,
      flinchX: 0,
      flinchZ: 0,
      stuckT: 0,
      detourT: 0,
      detourSide: 1,
      telegraphed: false,
      animAim: 0,
      flashT: 0,
      shieldBlocks: 0,
      shieldHitT: -1,
      staggerT: 0,
      dead: false,
      deadT: 0,
    });
    this.audio.spawn();
  }

  /**
   * Capsule + head-sphere ray test used by the player's hitscan.
   *
   * Why a separate head sphere instead of a Y-threshold: a plane cut counts a
   * shot that sails 3 m ABOVE a grunt's head as a headshot, and it misses the
   * case where the head is the only thing peeking over cover. The sphere is
   * the standard FPS answer and it is what makes "one-shot the grunt" feel
   * honest at long range.
   *
   * Forgiveness (research: enemies get slightly LARGER hitboxes than their
   * mesh): the torso capsule is used as-is, and the head sphere is 1.15x the
   * body radius.
   */
  public raycast(
    origin: THREE.Vector3,
    dir: THREE.Vector3,
    maxDist: number,
  ): { enemy: Enemy; distance: number; headshot: boolean } | null {
    let best: { enemy: Enemy; distance: number; headshot: boolean } | null = null;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const bodyDistance = this.rayCapsule(origin, dir, enemy.collider);
      const headDistance = this.rayHead(origin, dir, enemy);
      const distance =
        bodyDistance === null
          ? headDistance
          : headDistance === null
            ? bodyDistance
            : Math.min(bodyDistance, headDistance);
      if (distance === null || distance > maxDist) continue;
      if (best && distance >= best.distance) continue;
      // A head hit is a head hit only when the head sphere is what was struck.
      const headshot =
        headDistance !== null && (bodyDistance === null || headDistance <= bodyDistance + 1e-4);
      best = { enemy, distance, headshot };
    }
    return best;
  }

  /** Head sphere test. Centre sits at 88 % of the body height, radius is
   *  1.15x the body radius (a head is a little wider than the neck). */
  private rayHead(origin: THREE.Vector3, dir: THREE.Vector3, enemy: Enemy): number | null {
    const radius = enemy.def.radius * 1.15;
    this.tmpHead.set(
      enemy.group.position.x,
      enemy.group.position.y + enemy.def.height * 0.88,
      enemy.group.position.z,
    );
    return this.raySphere(origin, dir, this.tmpHead, radius);
  }

  /**
   * `byPlayer` marks damage that came from the player's own weapon — escort
   *  bot kills must not feed the kill-combo meter.
   *  `attackerId` records WHO shot this agent so its threat table can hold a
   *  grudge; omit it for environmental/unknown damage.
   *  Returns the hit result so callers can render distinct feedback for a
   *  shot a warden's plate absorbed. */
  public damageEnemy(
    enemy: Enemy,
    amount: number,
    point: THREE.Vector3,
    force?: THREE.Vector3,
    byPlayer = false,
    attackerId = -1,
    /** True for a shot to the boss's rear core (or any hit when it is broken). */
    weakPoint = false,
  ): { killed: boolean; blocked: boolean; dealt: number } {
    if (enemy.dead) return { killed: false, blocked: false, dealt: 0 };
    // Always record who shot us: the grudge is what makes an enemy switch OFF
    // its current victim onto whoever is actually hurting it, so suppressing it
    // when the attacker IS the current victim would defeat the point.
    if (attackerId >= 0) this.markAggressor(enemy, attackerId);
    // Wardens gate damage through their shield: frontal shots are absorbed
    // (or halved) until the guard breaks; flank shots punish for 1.5×.
    let damage = amount;
    let blocked = false;
    if (enemy.kind === 'warden') {
      const resolved = this.resolveWardenHit(enemy, amount, point, force);
      damage = resolved.damage;
      blocked = resolved.blocked;
    } else if (enemy.kind === 'wardenPrime') {
      const resolved = this.resolveBossHit(enemy, amount, point, weakPoint);
      damage = resolved.damage;
      blocked = resolved.blocked;
    }
    // Armored affix: flat reduction, floored at 1 so a weak weapon is never
    // literally useless (a zero-damage hit reads as a bug to the player).
    if (enemy.flatArmor > 0) damage = Math.max(1, damage - enemy.flatArmor);
    // Juggernaut affix trades stagger immunity for 30 % extra damage.
    if (enemy.ccImmune) damage *= 1.3;
    // Glacial / Blazing on-hit effects are applied by the attacker's weapon
    // path via `applyAffixOnHit`, so this method stays about damage only.
    // `dealt` is the damage the health bar ACTUALLY lost — capped at the
    // remaining health so an overkill execute never inflates the damage
    // statistics or the lifesteal heal derived from them.
    const dealt = Math.max(0, Math.min(damage, enemy.health));
    enemy.health -= damage;
    enemy.flashT = 0.14;
    // Flinch. The white flash says "I hit it"; the flinch says "it FELT that".
    // Strength scales with the fraction of the target's max health the hit
    // took, so a DMR round visibly rocks a grunt while a beam tick does not.
    // Capped so a big single hit cannot spin a body around.
    if (!blocked && dealt > 0) {
      const weight = clamp(dealt / enemy.def.health, 0, 1);
      enemy.flinchT = Math.max(enemy.flinchT, 0.12 + weight * 0.14);
      enemy.flinchAmp = Math.min(0.22, 0.05 + weight * 0.3);
      // Direction: rock AWAY from the shooter, so the hit has a vector.
      if (force) {
        enemy.flinchX = force.x;
        enemy.flinchZ = force.z;
      } else {
        enemy.flinchX = enemy.group.position.x - point.x;
        enemy.flinchZ = enemy.group.position.z - point.z;
      }
    }
    // Getting shot makes an agent MOVE. A lateral dodge away from the shot
    // line is the single biggest readability win for "the AI is alive": the
    // player sees the reaction to their own trigger pull. Never dodges while
    // already sliding, staggered, or on cooldown, so it reads as a reaction
    // rather than as random jitter.
    if (!blocked && dealt > 0 && !enemy.ccImmune && enemy.slideT <= 0) {
      if (enemy.dodgeT <= 0 && enemy.staggerT <= 0 && enemy.dodgeCd <= 0) {
        // Dodge to whichever side of the shot line the agent already occupies:
        // crossing the line would read as running INTO the fire.
        const shotX = force ? force.x : point.x - enemy.group.position.x;
        const shotZ = force ? force.z : point.z - enemy.group.position.z;
        const ownX = enemy.group.position.x - point.x;
        const ownZ = enemy.group.position.z - point.z;
        enemy.dodgeSide = -shotZ * ownX + shotX * ownZ >= 0 ? 1 : -1;
        enemy.dodgeT = AGILITY_DODGE_TIME;
        enemy.dodgeCd = randRange(AGILITY_DODGE_CD_MIN, AGILITY_DODGE_CD_MAX)
          * (enemy.kind === 'wardenPrime' ? 2.6 : 1);
        // A dodge cancels a claim: the agent is no longer holding cover.
        enemy.state = 'advance';
      }
    }
    this.effects.impact(point, this.tmp.copy(point).sub(enemy.group.position).normalize());
    // Physics kickback: heavier hits shove the body along the shot line
    // (resolved against walls by the normal octree pass next frame).
    // A blocked shot transfers no momentum — the shield eats it.
    if (force && !blocked && !enemy.ccImmune) {
      const push = Math.min(0.22, 0.05 + damage * 0.0035);
      enemy.collider.translate(this.tmp2.copy(force).setY(0).normalize().multiplyScalar(push));
    }
    if (enemy.health <= 0) {
      this.killEnemy(enemy, byPlayer);
      return { killed: true, blocked, dealt };
    }
    return { killed: false, blocked, dealt };
  }

  /** Shared kill path: death effects, affix on-death hooks, score callback. */
  private killEnemy(enemy: Enemy, byPlayer: boolean): void {
    enemy.dead = true;
    enemy.deadT = CORPSE_LIFE;
    this.tactics.release(enemy.tacticalId);
    enemy.claim = null;
    const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
    this.effects.ring(at, enemy.def.color, enemy.elite ? 8 : 5, 0.45);
    this.effects.burst(at, enemy.def.color, enemy.elite ? 20 : 10, enemy.elite ? 2.4 : 1.6);
    this.audio.killAt(at.x, at.z);
    // On-death affix hooks. Volatile/Blazing explode, Splitting spawns copies,
    // Glacial freezes the ground. All of them reuse existing systems.
    for (const id of enemy.affixes) {
      const def = AFFIXES[id];
      if (def.onDeath === 'explode') {
        this.effects.ring(at, 0xff8a3c, EXPLODER_RADIUS * 2.2, 0.4);
        this.audio.blastAt(at.x, at.z);
      } else if (def.onDeath === 'split' && enemy.kind !== 'wardenPrime') {
        this.spawnSplit(enemy);
      } else if (def.onDeath === 'freeze') {
        this.effects.ring(at, 0xa8f0ff, 5, 0.5);
      }
    }
    // The Exploder's damage is on death: killing it at range is the counter-play.
    if (enemy.kind === 'exploder') {
      this.effects.ring(at, 0xff9f1c, EXPLODER_RADIUS * 2.4, 0.5);
      this.effects.burst(at, 0xff9f1c, 26, 3);
      this.audio.blastAt(at.x, at.z);
      this.explodeAt(at, EXPLODER_RADIUS, EXPLODER_DAMAGE, enemy);
    }
    this.onEnemyKilled?.(enemy, byPlayer);
  }

  /**
   * Splitting affix: two half-health copies at 70 % scale. Spawned with the
   * affix list emptied so a chain of splits cannot fork forever.
   */
  private spawnSplit(parent: Enemy): void {
    if (this.enemies.length > 60) return;
    for (let i = 0; i < 2; i++) {
      const angle = (i / 2) * Math.PI * 2 + parent.strafeSeed;
      const offset = this.tmp5.set(Math.cos(angle) * 1.6, 0, Math.sin(angle) * 1.6);
      const at = parent.group.position.clone().add(offset);
      at.y = parent.group.position.y;
      const before = this.enemies.length;
      this.spawn(parent.kind, at, 1, 1, 1, 1, false);
      const child = this.enemies[before];
      if (!child) continue;
      // Half health, no affixes, dimmer halo so the copies read as lesser.
      child.health = Math.max(1, Math.round(parent.def.health * 0.5));
      child.def.health = child.health;
      child.affixes = [];
      child.elite = false;
      child.flatArmor = 0;
      if (child.halo) child.halo.visible = false;
      child.group.scale.setScalar(0.7);
    }
  }

  /**
   * Area damage used by the Exploder death, Volatile affix, and barrels.
   * Enemies inside the radius take linear falloff; the player takes a reduced
   * share so a single exploder can never one-shot a full-health player.
   */
  private explodeAt(
    center: THREE.Vector3,
    radius: number,
    damage: number,
    source: Enemy | null,
  ): void {
    for (const other of this.enemies) {
      if (other.dead || other === source) continue;
      const distance = other.group.position.distanceTo(center);
      if (distance > radius) continue;
      const falloff = Math.max(0.3, 1 - distance / radius);
      const at = other.group.position.clone().setY(other.group.position.y + 1);
      this.damageEnemy(other, damage * falloff, at, undefined, false, -1);
    }
  }

  /**
   * Public area damage for hazards and barrels: linear falloff to `floor`,
   * returns how many enemies died. Kept separate from `explodeAt` so the
   * hazard system gets the falloff shape it authored rather than the
   * exploder's fixed one.
   */
  public damageArea(
    center: THREE.Vector3,
    radius: number,
    damage: number,
    floor: number,
    byPlayer: boolean,
  ): { killed: number; dealt: number } {
    let killed = 0;
    let dealt = 0;
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      const distance = enemy.group.position.distanceTo(center);
      if (distance > radius) continue;
      const falloff = Math.max(floor, 1 - distance / radius);
      const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
      const result = this.damageEnemy(enemy, damage * falloff, at, undefined, byPlayer, -1);
      if (result.killed) killed += 1;
      dealt += result.dealt;
    }
    return { killed, dealt };
  }

  /**
   * Boss damage model. Frontal shots land at 60 %; the glowing rear core takes
   * 2.5x and is destroyed permanently (Doom Eternal's weak-point rule: the
   * reward for positioning is permanent, not a temporary buff).
   */
  private resolveBossHit(
    enemy: Enemy,
    amount: number,
    point: THREE.Vector3,
    weakPoint: boolean,
  ): { damage: number; blocked: boolean } {
    if (enemy.weakPointBroken) return { damage: amount, blocked: false };
    // EMP: an active field disables shield absorption entirely, which is the
    // EMP grenade's whole payoff against wardens and the boss.
    if (this.shieldsDisabled) return { damage: amount, blocked: false };
    // "Behind" is determined by the shot's approach versus the boss's facing.
    const facingX = -Math.sin(enemy.group.rotation.y);
    const facingZ = -Math.cos(enemy.group.rotation.y);
    const dx = point.x - enemy.group.position.x;
    const dz = point.z - enemy.group.position.z;
    const length = Math.hypot(dx, dz) || 1;
    const dot = (dx / length) * facingX + (dz / length) * facingZ;
    const fromBehind = dot < -0.25;
    if (weakPoint && fromBehind) {
      this.effects.burst(point, 0xffd76b, 8, 2.2);
      // Core integrity: enough rear-core damage destroys it for the rest of the
      // fight, which is what turns flanking from a damage bonus into a real
      // objective. The bar lives on the enemy so it survives phase changes.
      enemy.coreDamage += amount * BOSS_WEAKPOINT_MUL;
      if (enemy.coreDamage >= enemy.def.health * BOSS_CORE_BREAK_FRACTION) {
        this.breakWeakPoint(enemy);
      }
      return { damage: amount * BOSS_WEAKPOINT_MUL, blocked: false };
    }
    return { damage: amount * 0.6, blocked: true };
  }

  /** Called by the boss weak-point path when the core is destroyed. */
  public breakWeakPoint(enemy: Enemy): void {
    if (enemy.weakPointBroken) return;
    enemy.weakPointBroken = true;
    this.effects.ring(enemy.group.position.clone().setY(enemy.group.position.y + 1.8), 0xffd76b, 9, 0.6);
    this.audio.eliteKill();
  }


  /**
   * Warden armour model: a riot shield covers the front arc. Frontal hits land
   * at 50 % and charge a 6-block guard meter; the guard breaks for 1.2 s (and
   * every attack wind-up counts as open — trade the telegraph, not the plate).
   * Shots from behind ignore the shield entirely and deal 1.5× damage.
   * Returns the damage to apply plus whether the shot was absorbed.
   */
  private resolveWardenHit(
    enemy: Enemy,
    amount: number,
    point: THREE.Vector3,
    force?: THREE.Vector3,
  ): { damage: number; blocked: boolean } {
    const out = this.wardenHit;
    out.damage = amount;
    out.blocked = false;
    // EMP: the plate is dead weight while the field is up.
    if (this.shieldsDisabled) {
      enemy.shieldBlocks = 0;
      return out;
    }
    if (enemy.staggerT > 0 || (enemy.telegraphed && enemy.attackTimer <= WARDEN_WINDUP)) {
      enemy.shieldBlocks = 0;
      return out;
    }
    if (!force) {
      // No shot vector (ally fire, splash): unshielded, but the guard meter
      // must survive — an escort bot must not erase the player's progress.
      return out;
    }
    const forward = this.tmp4.set(-Math.sin(enemy.group.rotation.y), 0, -Math.cos(enemy.group.rotation.y));
    const shot = this.tmp5.copy(force).setY(0);
    if (shot.lengthSq() < 1e-6) return out;
    const fromFront = forward.dot(shot.normalize()) < -0.5;
    if (!fromFront) {
      enemy.shieldBlocks = 0;
      out.damage = amount * 1.5;
      return out;
    }
    if (Math.random() >= 0.8) {
      // Lucky gap: the plate is not perfectly flush, this shot slips through.
      return out;
    }
    // One trigger pull = one block: pellets of the same volley share a step.
    if (enemy.shieldHitT !== this.simTime) {
      enemy.shieldHitT = this.simTime;
      enemy.shieldBlocks += 1;
    }
    if (enemy.shieldBlocks >= WARDEN_SHIELD_BREAK) {
      enemy.shieldBlocks = 0;
      enemy.staggerT = WARDEN_STAGGER;
      this.effects.ring(point, enemy.def.color, 3.2, 0.3);
      // The breaking shot shatters the plate: full damage, no absorption.
      out.damage = amount;
      return out;
    }
    this.effects.burst(point, enemy.def.color, 4, 1.2);
    out.damage = amount * 0.5;
    out.blocked = true;
    return out;
  }

  public update(
    dt: number,
    playerPos: THREE.Vector3,
    playerDead: boolean,
    lastShot?: THREE.Vector3 | null,
  ): void {
    this.simTime += dt;
    this.lastPlayerPos.copy(playerPos);
    this.hasPlayerPos = true;
    this.updateAffixTicks(dt);
    // Fade out + dispose dead enemies after a short linger
    for (let i = this.enemies.length - 1; i >= 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy || !enemy.dead) continue;
      enemy.deadT -= dt;
      const k = Math.max(0, enemy.deadT / CORPSE_LIFE);
      // Death has three beats, and separating them is what makes it read as a
      // body rather than as a mesh rotating.
      //   IMPACT   0.00-0.10 s  squash: the body compresses where it was hit
      //   TOPPLE   0.10-0.60 s  falls over, with a little spin from its seed
      //   SETTLE   0.60 s+       lies still while the glow drains out
      const age = CORPSE_LIFE - enemy.deadT;
      const squash = age < 0.1 ? 1 - (1 - age / 0.1) * 0.45 : 1;
      const fall = clamp((age - 0.1) * 2, 0, 1);
      // Ease-out on the topple: a body accelerates as it falls and then stops.
      const topple = 1 - Math.pow(1 - fall, 3);
      enemy.group.rotation.x = topple * 1.5;
      enemy.group.rotation.z = topple * Math.sin(enemy.strafeSeed) * 0.25;
      // Squash is applied to the BODY, not the group, so the rotation above is
      // not scaled with it (scaling the group would also scale the fall).
      enemy.body.scale.set(1 + (1 - squash) * 0.35, squash, 1 + (1 - squash) * 0.35);
      (enemy.body.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.02 + k * 0.4;
      (enemy.eye.material as THREE.MeshStandardMaterial).emissiveIntensity = k * 3;
      if (enemy.deadT <= 0) {
        this.disposeEnemy(enemy);
        this.enemies.splice(i, 1);
      }
    }
    // Target acquisition runs before perception so `visible` describes the
    // CHOSEN victim, not whichever friendly happens to be closest.
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      this.resolveTarget(enemy, dt);
    }
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.staggerT > 0) enemy.staggerT = Math.max(0, enemy.staggerT - dt);
      if (lastShot) {
        const heardDistance = enemy.group.position.distanceTo(lastShot);
        const hearingRange = enemy.kind === 'rusher' ? 25 : 30;
        if (heardDistance <= hearingRange) {
          enemy.lastKnown.copy(lastShot);
          enemy.memory = Math.max(enemy.memory, 1.35);
          if (!enemy.visible) enemy.state = 'search';
        }
      }
    }
    // One readiness pass per step feeds every updateAttack() call below.
    let readyShooters = 0;
    let readyRushers = 0;
    for (const enemy of this.enemies) {
      if (enemy.dead || !enemy.visible) continue;
      if (enemy.attackTimer > EnemyManager.windupOf(enemy.kind)) continue;
      if (enemy.kind === 'rusher') readyRushers += 1;
      else readyShooters += 1;
    }
    this.readyShooters = readyShooters;
    this.readyRushers = readyRushers;
    // Squad state refreshes on its own cadence, before the per-agent pass, so
    // every member of a team reads the SAME team state this step.
    this.teamTimer -= dt;
    if (this.teamTimer <= 0) {
      this.teamTimer = TEAM_TICK;
      this.updateTeams();
    }
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      this.updateEnemy(enemy, dt, playerDead);
    }
    this.updateProjectiles(dt);
  }

  /**
   * Rebuild the fire teams. Runs on a slow cadence because a team's plan does
   * not change sixty times a second.
   *
   * Each team picks ONE victim: the one its members collectively have the best
   * shot at, scored by visibility and proximity. A shared victim is what turns
   * three agents into a squad, because it is what makes them shoot the same
   * thing at the same time.
   *
   * Bounding is a rotation: the member with the best line holds while the team
   * advances one at a time. Melee archetypes are excluded from holding, because
   * a rusher that stops to cover is just a slow rusher.
   */
  private updateTeams(): void {
    // Group live agents by team index. Rebuild from the roster each tick so a
    // death cannot leave a ghost in a team.
    const buckets = new Map<number, Enemy[]>();
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      if (enemy.kind === 'rusher' || enemy.kind === 'exploder' || enemy.kind === 'flyer') continue;
      if (enemy.kind === 'wardenPrime' || enemy.kind === 'summoner') continue;
      const team = Math.floor(enemy.tacticalId / FIRE_TEAM_SIZE);
      const list = buckets.get(team) ?? [];
      list.push(enemy);
      buckets.set(team, list);
    }
    for (const [key, members] of buckets) {
      let team = this.teams.get(key);
      if (!team) {
        team = { focus: null, boundT: 0, upId: -1 };
        this.teams.set(key, team);
      }
      // Drop a focus that is gone or no longer targetable.
      if (team.focus && !team.focus.targetable) team.focus = null;
      // Pick a focus when the team has none: the target the most members can
      // currently see, breaking ties on distance. Voting by line of sight is
      // what keeps a team from committing to someone only one member can hit.
      if (!team.focus) {
        let bestTarget: CombatTarget | null = null;
        let bestVotes = 0;
        let bestDistance = Number.POSITIVE_INFINITY;
        for (const candidate of this.targets) {
          if (!candidate.targetable) continue;
          let votes = 0;
          let totalDistance = 0;
          for (const member of members) {
            const distance = member.group.position.distanceTo(candidate.position);
            totalDistance += distance;
            if (member.targetVisible || (member.memory > 0 && member.visible)) votes += 1;
          }
          if (votes < bestVotes) continue;
          if (votes === bestVotes && totalDistance >= bestDistance) continue;
          bestVotes = votes;
          bestDistance = totalDistance;
          bestTarget = candidate;
        }
        team.focus = bestTarget;
      }
      // Rotation: advance the "up" slot when its hold expires.
      team.boundT += TEAM_TICK;
      if (team.boundT < BOUND_HOLD_TIME) continue;
      team.boundT = 0;
      const currentIdx = members.findIndex((m) => m.tacticalId === team.upId);
      const next = members[(currentIdx + 1) % Math.max(1, members.length)];
      team.upId = next ? next.tacticalId : -1;
    }
  }

  /** The team an agent belongs to, or null for the lone archetypes. */
  private teamOf(enemy: Enemy): FireTeam | null {
    if (enemy.kind === 'rusher' || enemy.kind === 'exploder' || enemy.kind === 'flyer'
      || enemy.kind === 'wardenPrime' || enemy.kind === 'summoner') return null;
    return this.teams.get(Math.floor(enemy.tacticalId / FIRE_TEAM_SIZE)) ?? null;
  }

  public clear(): void {
    this.simTime = 0;
    for (const enemy of this.enemies) {
      this.tactics.release(enemy.tacticalId);
      this.disposeEnemy(enemy);
    }
    this.enemies.length = 0;
    // Fire teams hold references to agents that no longer exist. Clearing the
    // map is what stops a stale focus from surviving into the next wave.
    this.teams.clear();
    this.teamTimer = 0;
    for (const p of this.projectiles) {
      p.active = false;
      p.mesh.visible = false;
    }
  }

  /** Remove a corpse and free its per-agent cloned materials (shared mats stay). */
  /**
   * Per-tick affix and support behaviour. One pass over the roster handles
   * burn damage, slow timers, regen, healing auras, shields, and boss phases:
   * keeping it in a single O(n) sweep (rather than per-affix passes) is what
   * lets 24 affixed enemies stay inside the frame budget.
   */
  private updateAffixTicks(dt: number): void {
    for (const enemy of this.enemies) {
      if (enemy.dead) continue;
      // Burn (Blazing / Diesel Soaked / Greek Fire).
      if (enemy.burnT > 0) {
        enemy.burnT -= dt;
        const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
        this.damageEnemy(enemy, enemy.burnDps * dt, at, undefined, false, -1);
        if (enemy.burnT <= 0) enemy.burnDps = 0;
        if (enemy.dead) continue;
      }
      if (enemy.slowT > 0) enemy.slowT = Math.max(0, enemy.slowT - dt);
      // Self-healing affixes (Vampiric, Regenerating).
      for (const id of enemy.affixes) {
        const def = AFFIXES[id];
        if (def.passive === 'regen') {
          enemy.health = Math.min(enemy.def.health, enemy.health + enemy.def.health * 0.04 * dt);
        }
        // Healing aura: 3 % of the RECIPIENT's max health per second, which
        // keeps it equally useful for a 60 HP grunt and a 2200 HP boss.
        if (def.passive === 'healAllies') {
          for (const other of this.enemies) {
            if (other.dead || other === enemy) continue;
            if (other.group.position.distanceToSquared(enemy.group.position) > HEALER_RADIUS * HEALER_RADIUS) continue;
            other.health = Math.min(other.def.health, other.health + other.def.health * HEALER_RATE * dt);
          }
        }
      }
      // The Healer KIND has the same aura as the Mending affix, but weaker and
      // tied to its own position, so the two stack the way players expect.
      if (enemy.kind === 'healer') {
        for (const other of this.enemies) {
          if (other.dead || other === enemy) continue;
          if (other.group.position.distanceToSquared(enemy.group.position) > HEALER_RADIUS * HEALER_RADIUS) continue;
          other.health = Math.min(other.def.health, other.health + other.def.health * HEALER_RATE * dt);
        }
      }
      // Boss phase progression and enrage.
      if (enemy.kind === 'wardenPrime') {
        const fraction = enemy.health / enemy.def.health;
        const phase = fraction <= BOSS_PHASE_3 ? 3 : fraction <= BOSS_PHASE_2 ? 2 : 1;
        if (phase !== enemy.phase) {
          enemy.phase = phase;
          // Each phase shortens the telegraph and speeds the boss up.
          enemy.def.speed *= 1.08;
          this.effects.ring(enemy.group.position.clone().setY(enemy.group.position.y + 1.6), 0xffd76b, 7, 0.5);
          this.audio.bossSpawn();
        }
        if (enemy.enrageT !== Number.POSITIVE_INFINITY) {
          enemy.enrageT -= dt;
          if (enemy.enrageT <= 0) {
            enemy.enrageT = Number.POSITIVE_INFINITY;
            enemy.def.speed *= 1.15;
            enemy.def.damage *= 1.25;
            this.audio.bossSpawn();
          }
        }
      }
      // Elite halo spin: one cheap visual that says "this one is different".
      if (enemy.halo) {
        enemy.halo.rotation.z += dt * 1.4;
      }
    }
  }

  /**
   * Apply an affix's on-hit rider. Called by the player's weapon path so the
   * effect lands on the PLAYER's terms (the enemy hit them, so the player's
   * card pool decides what happens).
   */
  public applyAffixOnHit(target: CombatTarget, attacker: Enemy): void {
    for (const id of attacker.affixes) {
      const def = AFFIXES[id];
      if (def.onHit === 'burn') {
        // Marked on the target so the player HUD can show the burn.
        if (target.targetId === 1) this.playerBurnT = Math.max(this.playerBurnT, AFFIX_BURN_TIME);
      } else if (def.onHit === 'slow' && target.targetId === 1) {
        this.playerSlowT = Math.max(this.playerSlowT, AFFIX_SLOW_TIME);
      } else if (def.onHit === 'chain') {
        this.effects.burst(attacker.group.position.clone().setY(attacker.group.position.y + 1), 0x5aa8ff, 6, 1.8);
      }
    }
  }

  /** Seconds of burn left on the player (Blazing affix). */
  public playerBurnT = 0;
  /** Seconds of slow left on the player (Glacial affix). */
  public playerSlowT = 0;

  /** Tick the player-affecting affix timers; returns burn damage for this step. */
  public tickPlayerAffixes(dt: number): { burnDamage: number; slowFraction: number } {
    let burnDamage = 0;
    if (this.playerBurnT > 0) {
      this.playerBurnT = Math.max(0, this.playerBurnT - dt);
      burnDamage = AFFIX_BURN_DPS * dt;
    }
    const slowFraction = this.playerSlowT > 0 ? 1 - AFFIX_SLOW_MUL : 0;
    if (this.playerSlowT > 0) this.playerSlowT = Math.max(0, this.playerSlowT - dt);
    return { burnDamage, slowFraction };
  }

  private disposeEnemy(enemy: Enemy): void {
    (enemy.body.material as THREE.Material).dispose();
    (enemy.eye.material as THREE.Material).dispose();
    if (enemy.halo) {
      this.group.remove(enemy.halo);
      enemy.halo.geometry.dispose();
      (enemy.halo.material as THREE.Material).dispose();
      enemy.halo = null;
    }
    this.group.remove(enemy.group);
  }

  private updateEnemy(
    enemy: Enemy,
    dt: number,
    playerDead: boolean,
  ): void {
    this.updatePerception(enemy, dt, playerDead);
    // Blind sweep: while searching with no contact memory, re-orient the
    // objective toward the actual target every few seconds so a spawn that
    // starts outside perception still closes instead of freezing in place.
    if (enemy.state === 'search' && enemy.memory <= 0) {
      enemy.searchSyncT -= dt;
      if (enemy.searchSyncT <= 0) {
        enemy.searchSyncT = SEARCH_SYNC_INTERVAL;
        const anchor = enemy.target?.position ?? (this.hasPlayerPos ? this.lastPlayerPos : null);
        if (anchor) enemy.lastKnown.copy(anchor);
      }
    }
    // The aim objective is the chosen victim when in sight, otherwise the last
    // place that victim was seen. With no victim at all, fall back to the
    // player's position so a fresh spawn still advances into the fight.
    const fallback = this.hasPlayerPos ? this.lastPlayerPos : this.tmp5.set(0, 0, 0);
    const objective = enemy.target
      ? (enemy.targetVisible ? enemy.target.position : enemy.lastKnown)
      : fallback;
    const toTarget = this.tmp.copy(objective).sub(enemy.group.position);
    toTarget.y = 0;
    const targetDistance = toTarget.length();
    if (targetDistance > 0.001) toTarget.divideScalar(targetDistance);

    const toFace = this.tmp2.copy(objective).sub(enemy.group.position);
    toFace.y = 0;
    if (toFace.lengthSq() > 0.001) {
      // Model forward is -Z; adding +PI makes agents walk away.
      const targetYaw = Math.atan2(-toFace.x, -toFace.z);
      enemy.group.rotation.y = dampAngle(enemy.group.rotation.y, targetYaw, 10, dt);
    }

    // Bounding overwatch. A team advances one member at a time: the agent in
    // the "up" slot closes, everyone else holds a firing position and covers
    // it. The hold is not a freeze: a holding agent still strafes and still
    // shoots, it just does not close. That is the difference between a squad
    // with a plan and a squad that all walks forward together.
    //
    // A holding agent gives up its hold once it is genuinely far from the
    // fight, so a bounding squad can never leave a member behind.
    const team = this.teamOf(enemy);
    const holding = team !== null && team.upId >= 0 && team.upId !== enemy.tacticalId
      && targetDistance < HOLD_MAX_RANGE;

    // A dead human no longer freezes the AI: escorts are still valid victims,
    // so the roster keeps fighting instead of going passive.
    const anyVictim = this.targets.some((t) => t.targetable);
    if (anyVictim) {
      this.updateAgility(enemy, dt);
      // `objective` is the live victim position when visible, so it is the
      // right thing to hold range against: a holding agent measures its
      // standoff from what it is actually shooting at.
      if (holding) this.holdPosition(enemy, dt, toTarget, objective);
      else this.moveEnemy(enemy, dt, toTarget, targetDistance, objective);
      // Ballistic lead must use the VICTIM's velocity, not the player's —
      // leading with the wrong vector makes bolts aimed at an escort miss.
      this.updateAttack(enemy, dt, enemy.target?.velocity);
    }
    this.animateEnemy(enemy, dt, targetDistance, !anyVictim);
  }

  /**
   * Perceive the CHOSEN victim. `visible` therefore means "I can see the thing
   * I am shooting at", which is what every downstream branch assumes.
   */
  private updatePerception(enemy: Enemy, dt: number, playerDead: boolean): void {
    enemy.memory = Math.max(0, enemy.memory - dt);
    const victim = enemy.target;
    if (!victim || !victim.targetable) {
      enemy.visible = false;
      enemy.targetVisible = false;
      enemy.seenFor = 0;
      enemy.state = 'search';
      if (enemy.claim) {
        this.tactics.release(enemy.tacticalId);
        enemy.claim = null;
      }
      return;
    }

    enemy.perceptionTimer -= dt;
    if (enemy.perceptionTimer > 0) return;
    enemy.perceptionTimer = PERCEPTION_INTERVAL;
    const distance = enemy.group.position.distanceTo(victim.position);
    // Two radii (sight vs keep-sight) kill the boundary flicker that a single
    // threshold produces when a target strafes in and out of cover.
    const maxDistance = enemy.kind === 'gunner' || enemy.kind === 'warden' ? 34 : 28;
    const acquire = distance <= maxDistance;
    const keep = distance <= maxDistance * 1.2;
    const inSight = (enemy.targetVisible ? keep : acquire)
      && this.hasLineOfSight(enemy.group.position, victim.position);
    enemy.targetVisible = inSight;
    if (inSight) {
      enemy.visible = true;
      enemy.seenFor += PERCEPTION_INTERVAL;
      // Alerted memory is longer than the unalerted baseline.
      enemy.memory = SEARCH_MEMORY;
      enemy.lastKnown.copy(victim.position);
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
        enemy.attackTimer = Math.min(enemy.attackTimer, EnemyManager.windupOf(enemy.kind) + 0.2);
      } else if (enemy.group.position.distanceTo(enemy.claim.point.center) < 0.75) {
        enemy.state = 'peek';
      }
    }
    if (enemy.state === 'peek' && enemy.visible && enemy.seenFor > 1.5) {
      enemy.state = 'suppress';
      enemy.attackTimer = Math.min(enemy.attackTimer, EnemyManager.windupOf(enemy.kind) + 0.2);
    }
    // Suppression: once an agent has held a firing position it keeps shooting
    // on a shorter cadence even when its line is imperfect. Without this, a
    // player who breaks line of sight is completely safe, which makes cover a
    // binary on/off switch instead of a contested position.
    if (enemy.state === 'suppress' && !enemy.visible && enemy.memory > 0) {
      enemy.attackTimer = Math.min(enemy.attackTimer, EnemyManager.windupOf(enemy.kind) + 0.25);
    }
    // A searching agent that has never seen anyone still needs a nudge.
    if (!enemy.visible && enemy.memory <= 0 && playerDead) enemy.state = 'search';
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
    // A committed burst owns movement outright for its duration. The normal
    // steering is skipped, which is what makes a dodge read as a dodge rather
    // than as a slightly faster strafe.
    const burst = this.isBursting(enemy) ? this.burstMove(enemy, toTarget) : null;
    if (burst) {
      const mul = enemy.slideT > 0
        ? AGILITY_SLIDE_MUL
        : enemy.dodgeT > 0 ? AGILITY_DODGE_MUL : AGILITY_JUKE_MUL;
      this.applyEnemyMove(enemy, burst, speed * mul, dt, playerPos);
      return;
    }
    // No burst running: see whether one should start before falling through to
    // the normal per-kind steering below.
    this.trySlide(enemy, toTarget, distance);
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
    } else if (enemy.kind === 'exploder') {
      // Relentless charge. No strafing: its whole design is "close the gap and
      // detonate", and the counter-play is killing it before it arrives.
      move.copy(this.tmp4);
    } else if (enemy.kind === 'summoner') {
      // The summoner ignores the player entirely and holds a far corner, so
      // the pressure comes from what it produces rather than from itself.
      if (distance < 22) move.addScaledVector(this.tmp4, -1);
      else if (distance > 30) move.copy(this.tmp4);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) move.addScaledVector(side.normalize(), Math.sin(this.simTime * 0.4 + enemy.strafeSeed) * 0.6);
    } else if (enemy.kind === 'healer') {
      // Healer stays behind the line: it backs away from the player and drifts
      // toward the nearest wounded ally, which keeps it alive and useful.
      const wounded = this.nearestWoundedAlly(enemy);
      if (wounded) {
        this.tmp5.set(
          wounded.group.position.x - enemy.group.position.x,
          0,
          wounded.group.position.z - enemy.group.position.z,
        );
        if (this.tmp5.lengthSq() > 1) move.addScaledVector(this.tmp5.normalize(), 0.9);
      }
      if (distance < 16) move.addScaledVector(this.tmp4, -0.8);
    } else if (enemy.kind === 'sniper') {
      // Sniper wants its full reach: backs off hard under 24 m, closes over 36.
      if (distance < 24) move.addScaledVector(this.tmp4, -1);
      else if (distance > 36) move.copy(this.tmp4);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) move.addScaledVector(side.normalize(), Math.sin(this.simTime * 0.5 + enemy.strafeSeed) * 0.1);
    } else if (enemy.kind === 'wardenPrime') {
      // Boss: holds mid range, strafes constantly, never hides.
      if (distance > enemy.def.attackRange * 0.6) move.copy(this.tmp4);
      else if (distance < 9) move.addScaledVector(this.tmp4, -0.6);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) move.addScaledVector(side.normalize(), Math.sin(this.simTime * 0.7 + enemy.strafeSeed) * 0.35);
    } else if (enemy.kind === 'warden') {
      // Warden holds a mid-range firing lane: closes to ~72 % of its reach,
      // backs off when crowded, strafes while shooting. Never flanks.
      if (distance > enemy.def.attackRange * 0.72) move.copy(this.tmp4);
      else if (distance < 8) move.addScaledVector(this.tmp4, -0.5);
      const side = this.tmp5.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) move.addScaledVector(side.normalize(), Math.sin(this.simTime + enemy.strafeSeed) * 0.15);
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
    this.applyEnemyMove(enemy, move, speed, dt, playerPos);
  }

  /**
   * Shared translation + collision + floor snap for one agent. Extracted so
   * the agility bursts and the normal steering cannot drift apart: both must
   * resolve against the octree and both must keep the agent on the floor.
   */
  private applyEnemyMove(
    enemy: Enemy,
    move: THREE.Vector3,
    speed: number,
    dt: number,
    playerPos: THREE.Vector3,
  ): void {
    // The Glacial affix's slow applies to movement, and it must not be able to
    // push a slow below zero.
    const slowK = enemy.slowT > 0 ? AFFIX_SLOW_MUL : 1;
    const step = speed * slowK * dt;
    // Record where we started so we can tell whether the step actually landed.
    const beforeX = enemy.collider.start.x;
    const beforeZ = enemy.collider.start.z;
    enemy.collider.translate(this.tmp4.copy(move).multiplyScalar(step));
    const hit = this.octree.capsuleIntersect(enemy.collider);
    if (hit) {
      enemy.collider.translate(this.tmp4.copy(hit.normal).multiplyScalar(hit.depth));
    }
    this.separateFromCrowd(enemy);

    // Stuck detection. The capsule resolve above can leave an agent pressed
    // flat against a crate with its move vector pointing straight into it, and
    // an agent that cannot move but keeps trying reads as broken. When a step
    // produces almost no displacement, commit to a lateral heading for a short
    // window so the agent walks around the obstacle instead of grinding.
    if (step > 1e-5 && enemy.kind !== 'flyer') {
      const movedX = enemy.collider.start.x - beforeX;
      const movedZ = enemy.collider.start.z - beforeZ;
      const progress = Math.hypot(movedX, movedZ);
      if (progress < step * 0.35) {
        enemy.stuckT += dt;
        if (enemy.stuckT > 0.25 && enemy.detourT <= 0) {
          // Pick the side once and hold it: alternating every frame would make
          // the agent vibrate in place instead of committing to a way around.
          const side = Math.sin(enemy.strafeSeed) >= 0 ? 1 : -1;
          enemy.detourT = 0.6;
          enemy.detourSide = side;
          enemy.stuckT = 0;
        }
      } else {
        enemy.stuckT = Math.max(0, enemy.stuckT - dt * 2);
      }
    }
    if (enemy.detourT > 0) {
      enemy.detourT = Math.max(0, enemy.detourT - dt);
      // Slide sideways relative to the current heading. This is applied as a
      // direct translate so it works for every archetype's steering without
      // each of their branches having to know about obstacles.
      const len = Math.hypot(move.x, move.z);
      if (len > 1e-4) {
        const nx = -move.z / len;
        const nz = move.x / len;
        enemy.collider.translate(this.tmp4.set(
          nx * enemy.detourSide * step * 1.4,
          0,
          nz * enemy.detourSide * step * 1.4,
        ));
        const slide = this.octree.capsuleIntersect(enemy.collider);
        if (slide) {
          enemy.collider.translate(this.tmp4.copy(slide.normal).multiplyScalar(slide.depth));
        }
      }
    }

    // Flyers hover: they ignore floor snapping and float at head height so
    // cover stops mattering against them, which is the entire point of the
    // archetype. Their collider is lifted with the visual.
    if (enemy.kind === 'flyer') {
      const bob = Math.sin(this.simTime * 2.1 + enemy.strafeSeed) * 0.16;
      enemy.collider.start.y = FLOOR_Y + FLYER_HEIGHT + bob;
      enemy.collider.end.y = enemy.collider.start.y;
      enemy.group.position.set(
        enemy.collider.start.x,
        enemy.collider.start.y - enemy.def.radius,
        enemy.collider.start.z,
      );
    } else {
      enemy.collider.start.y = Math.max(enemy.collider.start.y, FLOOR_Y + enemy.def.radius);
      enemy.collider.end.y = enemy.collider.start.y + enemy.def.height - enemy.def.radius * 2;
      enemy.group.position.set(
        enemy.collider.start.x,
        enemy.collider.start.y - enemy.def.radius,
        enemy.collider.start.z,
      );
    }

    enemy.decisionTimer -= dt;
    if (enemy.decisionTimer <= 0 && !enemy.claim && !EnemyManager.isRelentless(enemy.kind)) {
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
        } else if (
          enemy.kind === 'gunner' || enemy.kind === 'warden' ||
          enemy.kind === 'sniper' || enemy.kind === 'wardenPrime' ||
          enemy.strafeSeed > Math.PI
        ) {
          enemy.state = enemy.kind === 'gunner' || enemy.kind === 'warden' ||
            enemy.kind === 'sniper' || enemy.kind === 'wardenPrime'
            ? 'suppress'
            : 'flank';
        }
      }
    }
  }

  /**
   * Advance the three agility timers and start new bursts. Called once per
   * agent per step, before movement, so `moveEnemy` can simply read the state.
   *
   * Starting conditions are deliberately narrow. A dodge needs incoming fire,
   * a juke needs a live victim and an advancing state, and a slide needs a
   * melee archetype inside its commit range. Broadening any of these turns the
   * roster into noise, which is the failure mode this replaces.
   */
  private updateAgility(enemy: Enemy, dt: number): void {
    enemy.dodgeT = Math.max(0, enemy.dodgeT - dt);
    enemy.jukeT = Math.max(0, enemy.jukeT - dt);
    enemy.slideT = Math.max(0, enemy.slideT - dt);
    enemy.dodgeCd = Math.max(0, enemy.dodgeCd - dt);
    enemy.jukeCd = Math.max(0, enemy.jukeCd - dt);

    // Staggered agents do not dodge: the hit already landed and the stagger is
    // the reward. Flyers orbit, so a lateral burst fights their own bob.
    if (enemy.staggerT > 0 || enemy.kind === 'flyer') return;
    // Already committed to a burst: nothing else may start.
    if (enemy.dodgeT > 0 || enemy.jukeT > 0 || enemy.slideT > 0) return;

    // Proactive juke. Only while actually advancing (not while holding cover,
    // which is a deliberate choice the AI should honour) and only with a live
    // victim, so a blind search does not wander sideways.
    if (enemy.jukeCd <= 0 && enemy.visible && enemy.state !== 'cover' && enemy.state !== 'peek') {
      enemy.jukeCd = randRange(1.4, 3.6);
      // Alternate sides so a squad does not all break the same way.
      enemy.jukeSide = -enemy.jukeSide;
      enemy.jukeT = AGILITY_JUKE_TIME;
    }
  }

  /**
   * Bounding overwatch: hold a firing position instead of closing.
   *
   * A holding agent strafes to keep its angle open and drifts to maintain a
   * standoff, but it never advances. It still shoots, still dodges, still
   * takes cover: the ONLY thing it gives up is the approach, which is what
   * lets the agent in the up slot move without being alone.
   */
  private holdPosition(
    enemy: Enemy,
    dt: number,
    toTarget: THREE.Vector3,
    objective: THREE.Vector3,
  ): void {
    const move = this.tmp3.set(0, 0, 0);
    // Hold at roughly the kind's preferred engagement range: close enough to
    // shoot, far enough to be a separate problem from the agent advancing.
    const standoff = enemy.kind === 'gunner' || enemy.kind === 'warden'
      ? enemy.def.attackRange * 0.6
      : enemy.def.attackRange * 0.5;
    const distance = this.tmp5.copy(objective).sub(enemy.group.position).setY(0).length();
    if (distance > standoff * 1.15) {
      // Too far to cover anyone: creep forward, but at half pace so the up
      // slot still clearly outpaces the team.
      move.copy(toTarget).multiplyScalar(0.5);
    } else if (distance < standoff * 0.75) {
      // Crowded: back off, which also opens the angle for the advancing agent.
      move.copy(toTarget).multiplyScalar(-0.5);
    } else {
      // In the pocket: strafe to keep a firing lane instead of standing still.
      const side = this.tmp2.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() > 0.001) {
        move.copy(side.normalize()).multiplyScalar(Math.sin(this.simTime * 0.8 + enemy.strafeSeed) * 0.7);
      }
    }
    if (move.lengthSq() > 0.001) move.normalize();
    this.applyEnemyMove(enemy, move, enemy.def.speed * 0.75, dt, objective);
  }

  /**
   * True while the agent is in any agility burst. Callers use it to skip the
   * normal steering: a burst is committed, so it must not be blended away.
   */
  private isBursting(enemy: Enemy): boolean {
    return enemy.dodgeT > 0 || enemy.jukeT > 0 || enemy.slideT > 0;
  }

  /**
   * Committed-burst movement. Returns the unit direction the agent should move
   * along this step, or null when it should use its normal steering.
   *
   * A slide aims at the victim (a commit), while a dodge and a juke are pure
   * lateral offsets. That difference is the whole tell: a slide says "I am
   * coming for you", a dodge says "I am getting out of your line".
   */
  private burstMove(enemy: Enemy, toTarget: THREE.Vector3): THREE.Vector3 | null {
    if (enemy.slideT > 0) {
      const dir = this.tmp2.set(enemy.slideDirX, 0, enemy.slideDirZ);
      if (dir.lengthSq() < 1e-6) return null;
      return dir.normalize();
    }
    if (enemy.dodgeT > 0 || enemy.jukeT > 0) {
      const side = this.tmp2.set(-toTarget.z, 0, toTarget.x);
      if (side.lengthSq() < 1e-6) return null;
      return side.normalize().multiplyScalar(enemy.dodgeT > 0 ? enemy.dodgeSide : enemy.jukeSide);
    }
    return null;
  }

  /**
   * Start a slide when a melee archetype is closing. Gated on a distance
   * window so the player still gets a reaction: sliding in from across the map
   * would remove the counter-play that makes these two kinds fair.
   */
  private trySlide(enemy: Enemy, toTarget: THREE.Vector3, distance: number): void {
    if (enemy.kind !== 'rusher' && enemy.kind !== 'exploder') return;
    if (!enemy.visible || enemy.attackTimer < ATTACK_WINDUP) return;
    if (distance > AGILITY_SLIDE_RANGE || distance < 1.2) return;
    enemy.slideT = AGILITY_SLIDE_TIME;
    enemy.slideDirX = toTarget.x;
    enemy.slideDirZ = toTarget.z;
  }

  /** Nearest live ally below 90 % health, for the Healer's movement goal. */
  private nearestWoundedAlly(healer: Enemy): Enemy | null {
    let best: Enemy | null = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const other of this.enemies) {
      if (other === healer || other.dead) continue;
      if (other.health >= other.def.health * 0.9) continue;
      const distance = other.group.position.distanceToSquared(healer.group.position);
      if (distance >= bestDistance) continue;
      bestDistance = distance;
      best = other;
    }
    return best;
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

  private static windupOf(kind: EnemyKind): number {
    // Sniper telegraphs longest because its hit is the largest single threat
    // in the game: the player must have time to break line of sight.
    if (kind === 'sniper') return 1.1;
    if (kind === 'wardenPrime') return 0.7;
    return kind === 'warden' ? WARDEN_WINDUP : ATTACK_WINDUP;
  }

  /** True for kinds that never take cover and never stop closing. */
  private static isRelentless(kind: EnemyKind): boolean {
    return kind === 'rusher' || kind === 'exploder';
  }

  private updateAttack(
    enemy: Enemy,
    dt: number,
    victimVel: THREE.Vector3 | undefined,
  ): void {
    const def = enemy.def;
    enemy.attackTimer -= dt;
    const victim = enemy.target;
    if (!victim || !victim.targetable) {
      if (enemy.telegraphed) enemy.telegraphed = false;
      return;
    }
    const victimPos = victim.position;
    const distance = enemy.group.position.distanceTo(victimPos);
    const inRange = distance <= def.attackRange;
    const windup = EnemyManager.windupOf(enemy.kind);
    // Snapshot from update(): subtract self when this agent is already ready.
    const selfReady =
      enemy.visible && !enemy.dead && enemy.attackTimer <= windup;
    const shootersReady = this.readyShooters - (selfReady && enemy.kind !== 'rusher' ? 1 : 0);
    const rushersReady = this.readyRushers - (selfReady && enemy.kind === 'rusher' ? 1 : 0);
    const roleCap = enemy.kind === 'rusher'
      ? rushersReady < 2
      : shootersReady < MAX_ACTIVE_SHOOTERS;
    const canEngage = enemy.visible && enemy.state !== 'search' && inRange && roleCap;
    if (!canEngage) {
      if (enemy.attackTimer <= 0) enemy.attackTimer = windup + 0.05;
      if (enemy.telegraphed) enemy.telegraphed = false;
      return;
    }
    // Guard-broken wardens cannot act — no wind-up, no shot. It still turns
    // to face you, so the plate side matters on the next engagement.
    if (enemy.kind === 'warden' && enemy.staggerT > 0) {
      enemy.telegraphed = false;
      // Hold the timer at a full telegraph so recovery is never a free hit.
      if (enemy.attackTimer < windup) enemy.attackTimer = windup;
      return;
    }

    if (
      !enemy.telegraphed &&
      enemy.attackTimer <= windup &&
      enemy.attackTimer > 0
    ) {
      enemy.telegraphed = true;
      this.audio.charge(this.panToward(enemy.group.position, victimPos));
    }
    if (enemy.attackTimer > 0) return;

    enemy.telegraphed = false;
    enemy.attackTimer = def.attackCooldown * randRange(0.85, 1.2);
    // Consume this agent's slot from the per-step readiness snapshot: without
    // this, N ready agents all read the same pre-step count and either all
    // hold fire (cap deadlock) or all volley at once.
    if (enemy.kind === 'rusher') {
      if (this.readyRushers > 0) this.readyRushers -= 1;
    } else if (this.readyShooters > 0) {
      this.readyShooters -= 1;
    }
    if (enemy.kind === 'rusher') {
      if (!this.hasLineOfSight(enemy.group.position, victimPos)) return;
      victim.receiveDamage(def.damage, enemy.group.position, def.label);
      this.audio.melee(this.panToward(enemy.group.position, victimPos));
    } else if (enemy.kind === 'exploder') {
      // The Exploder's attack IS the detonation: it dies doing it, so the
      // trade is "let it arrive" versus "spend the ammo now".
      if (!this.hasLineOfSight(enemy.group.position, victimPos)) return;
      const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
      this.effects.ring(at, 0xff9f1c, EXPLODER_RADIUS * 2.4, 0.5);
      this.effects.burst(at, 0xff9f1c, 26, 3);
      this.audio.blastAt(at.x, at.z);
      this.explodeAt(at, EXPLODER_RADIUS, EXPLODER_DAMAGE, enemy);
      victim.receiveDamage(def.damage, enemy.group.position, def.label);
      this.killEnemy(enemy, false);
      return;
    } else if (enemy.kind === 'summoner') {
      // The summoner never shoots: it spawns a grunt at its own feet. That
      // turns it into a clock the player has to beat rather than a target to
      // trade fire with, which is the whole archetype.
      this.audio.spawn();
      this.effects.burst(enemy.group.position.clone().setY(enemy.group.position.y + 0.5), def.color, 8, 1.4);
      this.spawn('grunt', enemy.group.position, 1, 1, 1, 1, false);
      enemy.attackTimer = SUMMON_INTERVAL * randRange(0.9, 1.15);
    } else {
      this.fireProjectile(enemy, victim, victimVel);
      this.audio.enemyShotAt(enemy.group.position.x, enemy.group.position.z);
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
      ? clamp(1 - enemy.attackTimer / EnemyManager.windupOf(enemy.kind), 0, 1) * 7
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
    const armsForward = enemy.kind === 'gunner' || enemy.kind === 'warden' ||
      enemy.kind === 'sniper' || enemy.kind === 'wardenPrime';
    enemy.armL.rotation.x = enemy.kind === 'warden'
      ? -swing * 0.3 + (0.6 + 0.6 * aim)
      : enemy.kind === 'healer'
        // Both arms raised: the heal aura is legible from the silhouette alone.
        ? -2.1 - Math.sin(this.simTime * 3 + enemy.strafeSeed) * 0.12
        : enemy.kind === 'summoner'
          ? -2.4 - aim * 0.4
          : -swing * 0.75 * (1 - aim) + 1.25 * aim;
    enemy.armR.rotation.x = armsForward
      ? 1.35
      : enemy.kind === 'healer'
        ? -2.1 - Math.sin(this.simTime * 3 + enemy.strafeSeed + 1) * 0.12
        : enemy.kind === 'summoner'
          ? -2.4 - aim * 0.4
          : swing * 0.75 * (1 - aim) + 1.4 * aim;

    // Burst poses. These are deliberately large: a slide the player cannot SEE
    // is indistinguishable from a speed bug, so the body drops and pitches.
    const sliding = enemy.slideT > 0;
    const dodging = enemy.dodgeT > 0 || enemy.jukeT > 0;
    // Flinch: the body rocks away from the shot, then springs back. It is
    // additive on top of the base pose so a flinching agent mid-slide still
    // reads as sliding. The amplitude decays with the timer, which is what
    // makes it a knock rather than a lean.
    let flinch = 0;
    if (enemy.flinchT > 0) {
      enemy.flinchT = Math.max(0, enemy.flinchT - dt);
      const k = enemy.flinchT / 0.26;
      // A damped oscillation: one hard push, one small rebound.
      flinch = Math.sin(k * Math.PI * 1.6) * enemy.flinchAmp * k;
    }
    enemy.body.rotation.x = damp(enemy.body.rotation.x, sliding ? 0.34 : moving ? -0.07 : 0, 12, dt)
      + flinch;
    enemy.body.position.y = (sliding ? 0.72 : 1.25) * (enemy.def.height / 1.7)
      + (moving && !sliding ? Math.abs(Math.sin(enemy.walkPhase * 2)) * 0.035 : 0);
    enemy.group.rotation.z = sliding
      ? damp(enemy.group.rotation.z, enemy.dodgeSide * 0.42, 10, dt)
      : dodging
        ? damp(enemy.group.rotation.z, (enemy.dodgeT > 0 ? enemy.dodgeSide : enemy.jukeSide) * 0.24, 10, dt)
        : moving ? Math.sin(enemy.walkPhase * 2) * 0.045 : 0;
    if (sliding) {
      // Legs tuck under the body: the silhouette reads as a slide, not a run.
      enemy.legL.rotation.x = -1.15;
      enemy.legR.rotation.x = -1.15;
    }
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
    // Frame parts use the kind's own armor plate instead of one shared gunmetal
    // material. This is what makes the roster read as ten designs rather than
    // one design in ten colours.
    const dark = this.getArmorMat(kind);

    const torso = new THREE.Mesh(g.torso, bodyMat);
    const torsoY = 1.25 * scaleK;
    s(torso, 0, torsoY);
    // Proportion per kind. Scaling the torso is not enough on its own: the
    // shoulder width, the limb thickness and the head size all have to move
    // together or every kind reads as "the same robot, resized".
    const look = PROPORTION[kind];
    if (kind === 'gunner') torso.scale.set(1.18, 1.05, 1.15);
    if (kind === 'rusher') torso.scale.set(0.9, 0.95, 0.9);
    if (kind === 'warden') torso.scale.set(1.1, 1.06, 1.06);
    if (kind === 'sniper') torso.scale.set(0.92, 1.05, 0.95);
    if (kind === 'flyer') torso.scale.set(0.95, 0.8, 0.95);
    if (kind === 'exploder') torso.scale.set(1.1, 0.98, 1.1);
    if (kind === 'healer') torso.scale.set(0.95, 1.0, 0.95);
    if (kind === 'summoner') torso.scale.set(1.05, 1.08, 1.05);
    if (kind === 'wardenPrime') torso.scale.set(1.55, 1.3, 1.4);
    // Pelvis + shoulder pads ride on the torso
    s(new THREE.Mesh(g.pelvis, dark), 0, -0.36 * scaleK, 0, torso);
    const shoulderK = scaleK * look.shoulder;
    const padL = new THREE.Mesh(g.shoulder, dark);
    padL.position.set(-0.4 * shoulderK, 0.18 * scaleK, 0);
    padL.scale.setScalar(look.pad);
    padL.castShadow = true;
    torso.add(padL);
    const padR = new THREE.Mesh(g.shoulder, dark);
    padR.position.set(0.4 * shoulderK, 0.18 * scaleK, 0);
    padR.scale.setScalar(look.pad);
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
    // Per-kind silhouette props. Each one exists so the archetype is readable
    // from the silhouette at range, which is the only reliable identification
    // channel in a dark arena.
    if (kind === 'sniper') {
      // Long barrel over the right shoulder: the telegraph of a long reach.
      const barrel = new THREE.Mesh(g.cannon, dark);
      barrel.rotation.x = Math.PI / 2;
      barrel.scale.set(0.5, 2.4, 0.5);
      barrel.position.set(0.28 * scaleK, 0.42 * scaleK, -0.3 * scaleK);
      barrel.castShadow = true;
      torso.add(barrel);
    }
    if (kind === 'flyer') {
      // Two swept wings: it must read as airborne even when silhouetted.
      for (const side of [-1, 1] as const) {
        const wing = new THREE.Mesh(g.pack, dark);
        wing.scale.set(2.2, 0.16, 0.9);
        wing.position.set(side * 0.62 * scaleK, 0.34 * scaleK, 0.06 * scaleK);
        wing.rotation.z = side * 0.35;
        wing.castShadow = true;
        torso.add(wing);
      }
    }
    if (kind === 'exploder') {
      // Bulbous charge tank on the chest: the visible bomb IS the threat.
      const tank = new THREE.Mesh(g.pack, bodyMat);
      tank.scale.set(1.5, 1.5, 1.3);
      tank.position.set(0, 0.08 * scaleK, -0.26 * scaleK);
      tank.castShadow = true;
      torso.add(tank);
    }
    if (kind === 'healer') {
      // Antenna array instead of a rifle: reads as support, not shooter.
      for (let i = -1; i <= 1; i++) {
        const rod = new THREE.Mesh(g.antenna, dark);
        rod.scale.set(1, 2.6, 1);
        rod.position.set(i * 0.16 * scaleK, 0.36 * scaleK, 0.16 * scaleK);
        torso.add(rod);
      }
    }
    if (kind === 'summoner') {
      // A wide emitter collar: the spawn port the player learns to target.
      const collar = new THREE.Mesh(g.shield, bodyMat);
      collar.scale.set(1.5, 0.35, 1.5);
      collar.position.set(0, 0.3 * scaleK, 0.1 * scaleK);
      collar.rotation.x = Math.PI / 2;
      torso.add(collar);
    }
    if (kind === 'wardenPrime') {
      // Crown spikes plus a rear core the player can see from behind.
      for (let i = -1; i <= 1; i++) {
        const spike = new THREE.Mesh(g.antenna, bodyMat);
        spike.scale.set(1.6, 3.2, 1.6);
        spike.position.set(i * 0.2 * scaleK, 0.44 * scaleK, 0.02 * scaleK);
        spike.rotation.z = i * 0.22;
        torso.add(spike);
      }
      const core = new THREE.Mesh(
        g.visor,
        new THREE.MeshStandardMaterial({
          color: 0x1a1408, emissive: 0xffd76b, emissiveIntensity: 3.2, roughness: 0.3,
        }),
      );
      core.scale.set(1.5, 1.5, 1.5);
      core.position.set(0, 0.05 * scaleK, 0.24 * scaleK);
      torso.add(core);
    }

    const head = new THREE.Mesh(g.head, dark);
    head.scale.setScalar(look.head);
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
      pivot.position.set(side * 0.4 * shoulderK, (1.25 + 0.18) * scaleK, 0);
      root.add(pivot);
      const upper = new THREE.Mesh(g.upperArm, dark);
      upper.position.y = -0.15 * scaleK;
      upper.castShadow = false;
      pivot.add(upper);
      const elbow = new THREE.Mesh(g.joint, dark);
      elbow.position.y = -0.3 * scaleK;
      pivot.add(elbow);
      if (kind === 'warden' && side === -1) {
        // Riot plate carried on the left forearm — the model's front arc.
        const plate = new THREE.Mesh(g.shield, bodyMat);
        plate.position.set(0, -0.34 * scaleK, -0.12 * scaleK);
        plate.castShadow = true;
        pivot.add(plate);
      } else if (kind === 'rusher' && side === 1) {
        const blade = new THREE.Mesh(g.blade, bodyMat);
        blade.position.y = -0.5 * scaleK;
        blade.castShadow = true;
        pivot.add(blade);
      } else if ((kind === 'gunner' || kind === 'warden' || kind === 'wardenPrime') && side === 1) {
        const cannon = new THREE.Mesh(g.cannon, dark);
        cannon.rotation.x = Math.PI / 2;
        cannon.position.set(0, -0.3 * scaleK, -0.25 * scaleK);
        if (kind === 'wardenPrime') cannon.scale.set(1.8, 1.8, 1.8);
        cannon.castShadow = true;
        pivot.add(cannon);
      } else if (kind === 'wardenPrime' && side === -1) {
        // Boss shield is a full plate, not a forearm guard.
        const plate = new THREE.Mesh(g.shield, bodyMat);
        plate.scale.set(1.7, 1.5, 1.2);
        plate.position.set(0, -0.4 * scaleK, -0.16 * scaleK);
        plate.castShadow = true;
        pivot.add(plate);
      } else if (kind === 'exploder') {
        // No weapon at all: the model's arms are the trigger.
        const fore = new THREE.Mesh(g.forearm, dark);
        fore.position.y = -0.44 * scaleK;
        pivot.add(fore);
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

  private fireProjectile(enemy: Enemy, victim: CombatTarget, victimVel?: THREE.Vector3): void {
    const proj = this.projectiles.find((p) => !p.active);
    if (!proj) return;
    proj.sourceLabel = enemy.def.label;
    proj.nearMissed = false;
    const victimPos = victim.position;
    const from = this.tmp.set(
      enemy.group.position.x,
      enemy.group.position.y + enemy.def.height * 0.75,
      enemy.group.position.z,
    );
    // Projectile speed by role: snipers fire fast enough that the bolt is a
    // threat at its 44 m reach, heavies are slower and more readable.
    const speed = enemy.kind === 'sniper' ? 46
      : enemy.kind === 'wardenPrime' ? 22
        : enemy.kind === 'gunner' || enemy.kind === 'warden' ? 17
          : enemy.kind === 'flyer' ? 15
            : 13;
    const horizontal = Math.hypot(victimPos.x - from.x, victimPos.z - from.z);
    const flight = Math.max(0.2, horizontal / speed);
    const aim = this.tmp2.set(victimPos.x, victimPos.y + 1.4, victimPos.z);
    if (victimVel) aim.addScaledVector(victimVel, flight);

    const baseErr = enemy.kind === 'sniper' ? 0.006
      : enemy.kind === 'gunner' ? 0.015
        : enemy.kind === 'warden' ? 0.02
          : enemy.kind === 'wardenPrime' ? 0.012
            : 0.05;
    const speedErr = victimVel ? Math.min(0.035, Math.hypot(victimVel.x, victimVel.z) * 0.007) : 0;
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
    proj.targetId = victim.targetId;
    proj.active = true;
    proj.mesh.visible = true;
    this.effects.burst(from, enemy.def.color, 3, 1.2);
  }

  private updateProjectiles(dt: number): void {
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
          // A bolt striking the world is a concrete tick. The octree does not
          // report WHICH mesh was hit (it returns a bare triangle), so rather
          // than guess a material from nothing, this plays the honest default
          // and the player still gets the distance and the pan.
          this.audio.impactAt('concrete', wallHit.position.x, wallHit.position.z);
          proj.active = false;
          proj.mesh.visible = false;
          continue;
        }
      }

      // Near miss. A bolt that passes close to the player but does not hit is
      // the single most valuable cue an FPS can give: it is how the player
      // learns they are being shot at from a direction they are not facing.
      // Gated on the player being the intended victim so escort fire does not
      // buzz in the player's ear.
      if (proj.targetId === PLAYER_TARGET_ID) {
        const px = this.lastPlayerPos.x - proj.mesh.position.x;
        const pz = this.lastPlayerPos.z - proj.mesh.position.z;
        const planar = Math.hypot(px, pz);
        // 1.4 m is just outside body radius: close enough to whip past, far
        // enough that a bolt which will actually hit does not double up.
        if (planar > 1.4 && planar < 3.4 && proj.life > 0) {
          // One whizz per bolt, not per tick: a bolt lives ~20 ticks and would
          // otherwise fire 20 near-miss sounds.
          if (!proj.nearMissed) {
            proj.nearMissed = true;
            this.audio.nearMissAt(proj.mesh.position.x, proj.mesh.position.z);
          }
        }
      }

      // Swept hit tests. A bolt at 17 m/s covers 0.28 m per tick, so a plain
      // point-in-sphere check can skip straight past a target; testing the
      // SEGMENT the bolt travelled over this tick cannot. This is the standard
      // fix for tunnelling and it is what makes "I definitely hit that" true.
      const boltRadius = 0.12;

      // Intended victim: a bolt only hurts the friendly it was aimed at, so a
      // stray round never clips an escort that walked into the line of fire.
      const victim = this.targets.find((t) => t.targetId === proj.targetId);
      if (victim && victim.targetable) {
        const center = this.tmp.set(victim.position.x, victim.position.y + 1.0, victim.position.z);
        if (this.segmentSphereHit(prev, proj.mesh.position, center, 0.75 + boltRadius)) {
          this.markAggressorForTarget(proj.targetId, proj.mesh.position);
          victim.receiveDamage(proj.damage, proj.mesh.position, proj.sourceLabel);
          proj.active = false;
          proj.mesh.visible = false;
          continue;
        }
      }

      // Escort interception: a bolt whose path crosses a guard's body is eaten.
      // Only bolts that actually intersect are absorbed — a broad proximity
      // test would make every bot a global shield and stop the player taking
      // fire at all (the bug this replaced). Tested as a swept segment against
      // the guard's torso, not as a point-to-line distance.
      let eaten = false;
      for (const guard of this.interceptors) {
        if (!guard.active) continue;
        const guardCenter = this.tmp4.set(guard.position.x, guard.position.y + 1, guard.position.z);
        if (this.segmentSphereHit(prev, proj.mesh.position, guardCenter, 0.6 + boltRadius)) {
          guard.takeDamage(proj.damage);
          this.effects.burst(guardCenter.clone(), 0xff9f1c, 5, 1.4);
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

  /**
   * True when the segment `a`→`b` passes within `radius` of `center`.
   * The closest-point-on-segment form is used rather than a ray/sphere solve
   * because it is branch-free, allocation-free, and handles the degenerate
   * cases (zero-length segment, target behind the start) for free.
   */
  private segmentSphereHit(
    a: THREE.Vector3,
    b: THREE.Vector3,
    center: THREE.Vector3,
    radius: number,
  ): boolean {
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const abz = b.z - a.z;
    const lengthSq = abx * abx + aby * aby + abz * abz;
    if (lengthSq < 1e-9) {
      return center.distanceToSquared(a) <= radius * radius;
    }
    let t = ((center.x - a.x) * abx + (center.y - a.y) * aby + (center.z - a.z) * abz) / lengthSq;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = a.x + abx * t - center.x;
    const dy = a.y + aby * t - center.y;
    const dz = a.z + abz * t - center.z;
    return dx * dx + dy * dy + dz * dz <= radius * radius;
  }

  /**
   * Squad alert: when a friendly is hit, nearby enemies learn the shooter's
   * position. One pass over the roster with a radius test — O(n), never O(n²).
   */
  private markAggressorForTarget(targetId: number, at: THREE.Vector3): void {
    for (const enemy of this.enemies) {
      if (enemy.dead || enemy.target?.targetId === targetId) continue;
      if (enemy.group.position.distanceToSquared(at) > 25 * 25) continue;
      enemy.lastKnown.copy(at);
      enemy.memory = Math.max(enemy.memory, 2.5);
      if (!enemy.visible) enemy.state = 'search';
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
    // Smoke is a hard vision blocker: a cloud between the enemy and the player
    // breaks the sight line, which is what makes the smoke grenade a real
    // tactical tool instead of a visual effect.
    if (this.smokeBlocks) {
      const step = 1.5;
      for (let d = step; d < dist; d += step) {
        this.tmpSmokeProbe.copy(origin).addScaledVector(dir, d);
        if (this.smokeBlocks(this.tmpSmokeProbe)) return false;
      }
    }
    this.tmpRay.set(origin, dir);
    const hit = this.octree.rayIntersect(this.tmpRay);
    return !hit || hit.distance > dist - 0.3;
  }

  /**
   * Vision blocker supplied by the grenade system. Returns true when the point
   * sits inside a live smoke cloud. Null when no smoke exists.
   */
  public smokeBlocks: ((point: THREE.Vector3) => boolean) | null = null;
  /** True while an EMP field is active: enemy shields stop absorbing. */
  public shieldsDisabled = false;
  private readonly tmpSmokeProbe = new THREE.Vector3();

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
      const color = DEFS[kind].color;
      mat = new THREE.MeshStandardMaterial({
        color,
        roughness: ARMOR_LOOK[kind].roughness,
        metalness: ARMOR_LOOK[kind].metalness,
        emissive: color,
        // Lifted from 0.12 so the silhouette still reads against the dark arena
        emissiveIntensity: BODY_EMISSIVE * ARMOR_LOOK[kind].glow,
      });
      this.bodyMats.set(kind, mat);
    }
    return mat;
  }

  /**
   * Armor plate material for a kind. The plate is the kind's own hue darkened
   * and desaturated, so the whole robot carries the archetype's colour instead
   * of sharing one gunmetal frame with a coloured strip on the chest.
   *
   * This is the difference between "ten enemies that look identical" and ten
   * silhouettes you can name from across the arena at a glance, which is the
   * only identification channel that survives a dark map at range.
   */
  private getArmorMat(kind: EnemyKind): THREE.MeshStandardMaterial {
    let mat = this.armorMats.get(kind);
    if (!mat) {
      const look = ARMOR_LOOK[kind];
      const tint = new THREE.Color(DEFS[kind].color);
      // Mix toward a dark neutral rather than scaling, so a bright hue does not
      // stay bright when it is supposed to read as painted metal.
      const plate = new THREE.Color(0x11151a).lerp(tint, look.tint);
      mat = new THREE.MeshStandardMaterial({
        color: plate,
        roughness: look.roughness,
        metalness: look.metalness,
        emissive: tint,
        emissiveIntensity: look.plateGlow,
      });
      this.armorMats.set(kind, mat);
    }
    return mat;
  }
}
