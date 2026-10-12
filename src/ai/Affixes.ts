/**
 * Elite affixes: Diablo/Risk of Rain style modifiers that reuse the existing
 * enemy art and only change stats plus one visual tell.
 *
 * This is the cheapest possible enemy variety: no new models, no new AI, just
 * a multiplier set and an on-event hook. Risk of Rain 2's tier-1 elites are
 * exactly this (roughly 4x health, 2x damage, one tint), and it is what makes
 * a wave of the same four archetypes keep reading as new.
 *
 * Rules encoded here:
 *  - An affix must be readable in under a second: one material tint plus one
 *    particle tell. No affix is invisible.
 *  - Affixes never remove counter-play. "Shielded" adds a breakable plate,
 *    it does not make the enemy immune.
 *  - Elite chance scales with the wave but is capped, so late waves do not
 *    become nothing but elites (which would flatten the difficulty curve).
 */
import * as THREE from 'three';

export type AffixId =
  | 'blazing' | 'overloading' | 'glacial' | 'mending' | 'juggernaut'
  | 'hasted' | 'gilded' | 'splitting' | 'vampiric' | 'volatile'
  | 'regenerating' | 'armored' | 'shrouded' | 'charged';

export interface AffixDef {
  id: AffixId;
  name: string;
  /** One factual sentence, shown in the HUD legend. */
  description: string;
  /** Material tint applied to the body so the elite reads at a glance. */
  tint: number;
  /** Emissive intensity multiplier for the chest strip. */
  glow: number;
  /** Multipliers applied at spawn. */
  hpMul: number;
  damageMul: number;
  speedMul: number;
  /** Extra score multiplier on top of the elite bonus. */
  scoreMul: number;
  /** Behavioural hooks the enemy manager honours. */
  onHit?: 'burn' | 'slow' | 'chain';
  onDeath?: 'explode' | 'freeze' | 'split';
  /** Passive flag consumed by the AI. */
  passive?: 'healAllies' | 'shieldAll' | 'regen' | 'ccImmune' | 'stealth' | 'armor';
}

export const AFFIXES: Record<AffixId, AffixDef> = {
  blazing: {
    id: 'blazing', name: 'Blazing',
    description: 'Leaves fire on hit and on death.',
    tint: 0xff6a2a, glow: 2.4,
    hpMul: 1.6, damageMul: 1.15, speedMul: 1, scoreMul: 1.5,
    onHit: 'burn', onDeath: 'explode',
  },
  overloading: {
    id: 'overloading', name: 'Overloading',
    description: 'Attacks chain to nearby friendlies.',
    tint: 0x5aa8ff, glow: 2.6,
    hpMul: 1.7, damageMul: 1.2, speedMul: 1, scoreMul: 1.6,
    onHit: 'chain',
  },
  glacial: {
    id: 'glacial', name: 'Glacial',
    description: 'Hits slow you by 35% for 2 s.',
    tint: 0xa8f0ff, glow: 2.2,
    hpMul: 1.5, damageMul: 1.1, speedMul: 1, scoreMul: 1.5,
    onHit: 'slow', onDeath: 'freeze',
  },
  mending: {
    id: 'mending', name: 'Mending',
    description: 'Heals nearby enemies 3% of their health per second.',
    tint: 0x7fe08a, glow: 2.2,
    hpMul: 1.9, damageMul: 1, speedMul: 1, scoreMul: 1.7,
    passive: 'healAllies',
  },
  juggernaut: {
    id: 'juggernaut', name: 'Juggernaut',
    description: 'Immune to stagger, but takes 30% more damage and moves slower.',
    tint: 0xc2b280, glow: 1.6,
    hpMul: 2.4, damageMul: 1.15, speedMul: 0.82, scoreMul: 1.9,
    passive: 'ccImmune',
  },
  hasted: {
    id: 'hasted', name: 'Hasted',
    description: '30% faster movement and attack.',
    tint: 0xffe066, glow: 2.4,
    hpMul: 1.35, damageMul: 1.1, speedMul: 1.3, scoreMul: 1.5,
  },
  gilded: {
    id: 'gilded', name: 'Gilded',
    description: 'Drops double salvage.',
    tint: 0xffd76b, glow: 2.8,
    hpMul: 1.6, damageMul: 1.1, speedMul: 1, scoreMul: 2.4,
  },
  splitting: {
    id: 'splitting', name: 'Splitting',
    description: 'Splits into two lesser copies on death.',
    tint: 0xd98aff, glow: 2.2,
    hpMul: 1.8, damageMul: 1, speedMul: 1, scoreMul: 1.8,
    onDeath: 'split',
  },
  vampiric: {
    id: 'vampiric', name: 'Vampiric',
    description: 'Heals itself for 20% of the damage it deals.',
    tint: 0xff4d6d, glow: 2.4,
    hpMul: 1.8, damageMul: 1.2, speedMul: 1, scoreMul: 1.7,
    passive: 'regen',
  },
  volatile: {
    id: 'volatile', name: 'Volatile',
    description: 'Explodes violently on death.',
    tint: 0xff9f1c, glow: 3.0,
    hpMul: 1.4, damageMul: 1.1, speedMul: 1, scoreMul: 1.6,
    onDeath: 'explode',
  },
  regenerating: {
    id: 'regenerating', name: 'Regenerating',
    description: 'Recovers 4% of max health per second.',
    tint: 0x9fe8c0, glow: 2.2,
    hpMul: 2.0, damageMul: 1, speedMul: 1, scoreMul: 1.7,
    passive: 'regen',
  },
  armored: {
    id: 'armored', name: 'Armored',
    description: 'Flat damage reduction of 6 per hit.',
    tint: 0x9aa8b8, glow: 1.8,
    hpMul: 2.1, damageMul: 1.1, speedMul: 0.95, scoreMul: 1.8,
    passive: 'armor',
  },
  shrouded: {
    id: 'shrouded', name: 'Shrouded',
    description: 'Semi-transparent and harder to see at range.',
    tint: 0x6a6a8a, glow: 1.4,
    hpMul: 1.5, damageMul: 1.2, speedMul: 1.1, scoreMul: 1.6,
    passive: 'stealth',
  },
  charged: {
    id: 'charged', name: 'Charged',
    description: 'Grants a damage-absorbing shield to nearby enemies.',
    tint: 0x7dd8ff, glow: 3.0,
    hpMul: 1.9, damageMul: 1.05, speedMul: 1, scoreMul: 1.9,
    passive: 'shieldAll',
  },
};

export const AFFIX_IDS = Object.keys(AFFIXES) as AffixId[];

/** How many affixes an elite may carry, by wave. */
export function affixCountForWave(wave: number): number {
  if (wave < 8) return 1;
  if (wave < 16) return 2;
  return 3;
}

/**
 * Probability that a spawned enemy is an elite. Ramps fast early (so the
 * player meets the mechanic) and then plateaus well below 1, so ordinary
 * enemies remain the baseline the player reads the arena against.
 */
export function eliteChanceForWave(wave: number): number {
  return Math.min(0.34, 0.04 + wave * 0.012);
}

/** Score multiplier for an elite carrying `count` affixes. */
export function eliteScoreMul(count: number): number {
  return 1 + count * 0.6;
}

/**
 * Apply an affix's multipliers to a mutable stat block. Kept separate from
 * `AFFIXES` so the data table stays serialisable and testable.
 */
export interface AffixStats {
  health: number;
  damage: number;
  speed: number;
  score: number;
  /** Flat reduction applied after the multiplier. */
  flatArmor: number;
  /** True when stagger/knockback is ignored. */
  ccImmune: boolean;
  /** Body opacity; below 1 makes the enemy translucent. */
  opacity: number;
  /** Emissive intensity for the chest strip. */
  glow: number;
  /** Tint applied to the body material. */
  tint: number | null;
}

export function applyAffix(stats: AffixStats, def: AffixDef): void {
  stats.health *= def.hpMul;
  stats.damage *= def.damageMul;
  stats.speed *= def.speedMul;
  stats.score *= def.scoreMul;
  stats.glow = Math.max(stats.glow, def.glow);
  stats.tint = def.tint;
  if (def.passive === 'armor') stats.flatArmor += 6;
  if (def.passive === 'ccImmune') stats.ccImmune = true;
  if (def.passive === 'stealth') stats.opacity = Math.min(stats.opacity, 0.42);
}

/** Human-readable one-line summary of an elite's affixes. */
export function describeAffixes(ids: readonly AffixId[]): string {
  return ids.map((id) => AFFIXES[id].name).join(' + ');
}

/** Shared geometry for the elite tell: a rotating wireframe halo. */
export function makeEliteHalo(radius: number, color: number): THREE.Mesh {
  const halo = new THREE.Mesh(
    new THREE.TorusGeometry(radius, 0.018, 6, 20),
    new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.5 }),
  );
  halo.rotation.x = Math.PI * 0.5;
  return halo;
}
