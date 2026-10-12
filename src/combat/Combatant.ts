import type * as THREE from 'three';

/**
 * Anything an enemy can perceive, prefer, shoot at and hurt.
 *
 * The player and the escort bots both implement this, so enemy AI never
 * special-cases "the player" — it scores every candidate and commits to the
 * best one. Adding a third friendly type later costs one registration.
 *
 * Implementations must be structurally compatible; this is an interface, not
 * a base class, so Player/Bot keep their own field layout.
 */
export interface CombatTarget {
  /** Stable identity — used for grudges, projectile ownership and stickiness. */
  readonly targetId: number;
  readonly team: 'player' | 'escort';
  /** Base attraction 0..1. The human draws more fire than a bot (research: 1.0 / 0.45). */
  readonly threatRole: number;
  /** Feet position (world space). */
  readonly position: THREE.Vector3;
  /** World-space velocity — ballistic lead uses this instead of the player's. */
  readonly velocity: THREE.Vector3;
  /** Metres from `position` to this target's eye/aim line. */
  readonly eyeHeight: number;
  /** 0..1 remaining health — a hurt target is a more attractive one. */
  readonly hpFraction: number;
  /** False while downed/dead; the AI drops it from the candidate set instantly. */
  readonly targetable: boolean;
  /** 0..1 how squarely this target is aiming back at `from` (0 = facing away). */
  aimPressureAt(from: THREE.Vector3): number;
  /** Called when an enemy attack lands on this target. `source` is a short
   *  player-facing label so the HUD can say WHERE the damage came from. */
  receiveDamage(amount: number, from: THREE.Vector3, source?: string): void;
}

/**
 * Utility weights for target selection. Sums to 1.0.
 *
 * Utility scoring (per-target weighted sum) outperforms "closest", "highest
 * damage" and "lowest health" heuristics in the FDG-2014 threat-ordering study,
 * and at 24 enemies x 3 targets the whole pass is 72 multiplications at 8 Hz.
 */
export const THREAT_WEIGHTS = {
  proximity: 0.3,
  role: 0.2,
  aggression: 0.2,
  fragility: 0.15,
  aimPressure: 0.15,
} as const;

/** Range at which proximity contribution reaches zero (gunner sight range). */
export const THREAT_SIGHT_RANGE = 34;

/** Remembered targets score this fraction of a visible one (never 0 — that
 *  would make an enemy forget a target the instant it steps behind cover). */
export const REMEMBERED_VISIBILITY = 0.35;

/** Grudge window: a target that damaged this agent stays attractive for this
 *  long, then the bonus decays linearly to zero. */
export const GRUDGE_WINDOW = 4;

/** Seconds between target re-evaluations (staggered per agent to spread cost). */
export const RETARGET_INTERVAL = 0.25;

/** Re-evaluation staggering step per roster index. */
export const RETARGET_STAGGER = 0.06;

/** Only switch away from the current target if the challenger scores this much
 *  higher — prevents per-frame target thrashing (WoW-style 110/130 % rule). */
export const TARGET_SWITCH_HYSTERESIS = 1.25;

/** Minimum seconds committed to a freshly acquired target before re-scoring. */
export const TARGET_COMMIT_TIME = 1.5;

export interface ThreatInputs {
  /** Metres to the candidate. */
  distance: number;
  /** Candidate's base attraction (CombatTarget.threatRole). */
  role: number;
  /** 0..1 grudge: 1 right after taking damage from it, 0 once decayed. */
  aggression: number;
  /** Candidate's 0..1 health fraction. */
  hpFraction: number;
  /** Candidate's 0..1 aim pressure. */
  aimPressure: number;
  /** 0..1 — 1 when in sight, REMEMBERED_VISIBILITY when only remembered. */
  visibility: number;
}

/**
 * Higher is more attractive. Pure function so it is unit-testable without a
 * renderer. Proximity dominates; role and grudge tie-break; fragility and
 * incoming aim pressure break the remaining ties.
 */
export function threatScore(input: ThreatInputs): number {
  if (input.visibility <= 0) return 0;
  const proximity = 1 - Math.min(1, Math.max(0, input.distance / THREAT_SIGHT_RANGE));
  const fragility = 1 - Math.min(1, Math.max(0, input.hpFraction));
  const raw =
    THREAT_WEIGHTS.proximity * proximity +
    THREAT_WEIGHTS.role * Math.min(1, Math.max(0, input.role)) +
    THREAT_WEIGHTS.aggression * Math.min(1, Math.max(0, input.aggression)) +
    THREAT_WEIGHTS.fragility * fragility +
    THREAT_WEIGHTS.aimPressure * Math.min(1, Math.max(0, input.aimPressure));
  return raw * input.visibility;
}

/** Linear grudge decay over GRUDGE_WINDOW seconds. */
export function grudgeAt(secondsSinceDamage: number): number {
  if (secondsSinceDamage < 0) return 0;
  if (secondsSinceDamage >= GRUDGE_WINDOW) return 0;
  return 1 - secondsSinceDamage / GRUDGE_WINDOW;
}
