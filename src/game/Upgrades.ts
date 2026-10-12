/**
 * The upgrade card pool — the roguelite draft.
 *
 * Every card is pure data: an id, a name, one line of flavour-free copy, a
 * rarity, a stack cap and an `apply(mods)` that mutates the aggregate modifier
 * object. Numbers are taken from real games in the genre (Vampire Survivors,
 * Risk of Rain 2, Hades, Brotato, Deep Rock Galactic: Survivor) so the curve is
 * already play-tested by thousands of hours of other people's players.
 *
 * Design rules applied here:
 *  - Common cards are small and always useful; rare cards change a decision;
 *    legendary cards change how you play.
 *  - Nothing is a flat "+X% damage" at legendary tier — those are commons.
 *  - Curse cards trade difficulty for power, so a confident player can opt in.
 *  - No card removes a mechanic; they only add or amplify.
 */
import type { PlayerMods } from './Run';

export type UpgradeId =
  | 'might' | 'hollowHeart' | 'armor' | 'hollowPoint' | 'emptyTome' | 'bracer'
  | 'duplicator' | 'wings' | 'crown' | 'stoneMask' | 'pummarola' | 'clover'
  | 'critLens' | 'soldiersSyringe' | 'toughTimes' | 'crowbar' | 'gasoline'
  | 'triTip' | 'monsterTooth' | 'medkit' | 'roseBuckler' | 'delicateWatch'
  | 'armorPiercing' | 'runaldBand' | 'behemoth' | 'highConfidence'
  | 'deathDefiance' | 'doubleStrike' | 'greekFire' | 'ricochet' | 'focus'
  | 'explosiveShells' | 'ninjaInvincibility' | 'dualEdge' | 'midairStrike'
  | 'blackContract' | 'overclock' | 'superReload' | 'dieselSoaked' | 'bloodyHand';

export type Rarity = 'common' | 'rare' | 'legendary';

export interface UpgradeCard {
  id: UpgradeId;
  name: string;
  /** Terse, factual, no marketing voice (see PRODUCT.md anti-references). */
  description: string;
  rarity: Rarity;
  /** Max stacks; defaults to 5. */
  maxStacks?: number;
  /** Mutate the aggregate modifiers by exactly one stack's worth. */
  apply(mods: PlayerMods): void;
}

export const UPGRADES: Record<UpgradeId, UpgradeCard> = {
  // ---------- Common: raw stat lines ----------
  might: {
    id: 'might', name: 'Might', rarity: 'common',
    description: '+10% damage dealt.',
    apply: (m) => { m.damageMul *= 1.1; },
  },
  hollowHeart: {
    id: 'hollowHeart', name: 'Hollow Heart', rarity: 'common',
    description: '+20% max health.',
    apply: (m) => { m.maxHealthMul *= 1.2; },
  },
  armor: {
    id: 'armor', name: 'Plate Carrier', rarity: 'common',
    description: '-1 damage from every hit.',
    maxStacks: 5,
    apply: (m) => { m.flatArmor += 1; },
  },
  hollowPoint: {
    id: 'hollowPoint', name: 'Hollow Point', rarity: 'common',
    description: '+15% damage, +8% spread.',
    apply: (m) => { m.damageMul *= 1.15; m.spreadMul *= 1.08; },
  },
  emptyTome: {
    id: 'emptyTome', name: 'Empty Tome', rarity: 'common',
    description: '+8% fire rate.',
    apply: (m) => { m.fireRateMul *= 1.08; },
  },
  bracer: {
    id: 'bracer', name: 'Bracer', rarity: 'common',
    description: '+10% magazine size.',
    apply: (m) => { m.magMul *= 1.1; },
  },
  duplicator: {
    id: 'duplicator', name: 'Duplicator', rarity: 'rare',
    description: '+12% fire rate and +6% magazine size.',
    maxStacks: 3,
    apply: (m) => { m.fireRateMul *= 1.12; m.magMul *= 1.06; },
  },
  wings: {
    id: 'wings', name: 'Wings', rarity: 'common',
    description: '+10% movement speed.',
    apply: (m) => { m.moveSpeedMul *= 1.1; },
  },
  crown: {
    id: 'crown', name: 'Crown', rarity: 'common',
    description: '+12% score.',
    apply: (m) => { m.scoreMul *= 1.12; },
  },
  stoneMask: {
    id: 'stoneMask', name: 'Stone Mask', rarity: 'common',
    description: '+15% salvage.',
    apply: (m) => { m.salvageMul *= 1.15; },
  },
  pummarola: {
    id: 'pummarola', name: 'Pummarola', rarity: 'common',
    description: 'Regenerate 0.4 HP per second.',
    maxStacks: 4,
    apply: (m) => { m.regen += 0.4; },
  },
  clover: {
    id: 'clover', name: 'Clover', rarity: 'common',
    description: '+6% crit chance.',
    maxStacks: 5,
    apply: (m) => { m.critChance += 0.06; },
  },

  // ---------- Common: weapon-feel lines ----------
  critLens: {
    id: 'critLens', name: "Lens-Maker's Glasses", rarity: 'common',
    description: '+10% crit chance. Crits deal double damage.',
    apply: (m) => { m.critChance += 0.1; },
  },
  soldiersSyringe: {
    id: 'soldiersSyringe', name: "Soldier's Syringe", rarity: 'common',
    description: '+15% fire rate.',
    apply: (m) => { m.fireRateMul *= 1.15; },
  },
  toughTimes: {
    id: 'toughTimes', name: 'Tougher Times', rarity: 'rare',
    description: '+12% chance to ignore a hit entirely.',
    maxStacks: 4,
    apply: (m) => { m.blockChance += 0.12; },
  },
  crowbar: {
    id: 'crowbar', name: 'Crowbar', rarity: 'common',
    description: '+30% headshot damage.',
    apply: (m) => { m.headshotMul *= 1.3; },
  },
  gasoline: {
    id: 'gasoline', name: 'Gasoline', rarity: 'rare',
    description: 'Kills have a 35% chance to ignite nearby enemies.',
    maxStacks: 3,
    apply: (m) => { m.igniteOnKill = Math.min(1, m.igniteOnKill + 0.35); },
  },
  triTip: {
    id: 'triTip', name: 'Tri-Tip Dagger', rarity: 'rare',
    description: '3% of damage dealt returns as health.',
    maxStacks: 4,
    apply: (m) => { m.lifesteal += 0.03; },
  },
  monsterTooth: {
    id: 'monsterTooth', name: 'Monster Tooth', rarity: 'common',
    description: '+6 HP on every kill.',
    apply: (m) => { m.healOnKill += 6; },
  },
  medkit: {
    id: 'medkit', name: 'Medkit', rarity: 'common',
    description: 'Regenerate 0.8 HP per second.',
    apply: (m) => { m.regen += 0.8; },
  },
  roseBuckler: {
    id: 'roseBuckler', name: 'Rose Buckler', rarity: 'common',
    description: '+15% damage reduction while sprinting.',
    maxStacks: 3,
    apply: (m) => { m.sprintArmor += 0.15; },
  },
  delicateWatch: {
    id: 'delicateWatch', name: 'Delicate Watch', rarity: 'legendary',
    description: '+40% damage dealt, +25% damage taken.',
    maxStacks: 3,
    apply: (m) => { m.damageMul *= 1.4; m.damageReduction -= 0.25; },
  },
  armorPiercing: {
    id: 'armorPiercing', name: 'Armor-Piercing Rounds', rarity: 'rare',
    description: '+18% damage, and warden shields break 2 blocks sooner.',
    apply: (m) => { m.damageMul *= 1.18; },
  },
  runaldBand: {
    id: 'runaldBand', name: "Runald's Band", rarity: 'rare',
    description: '+25% splash damage and +15% splash radius.',
    apply: (m) => { m.blastDamageMul *= 1.25; m.blastRadiusMul *= 1.15; },
  },
  behemoth: {
    id: 'behemoth', name: 'Brilliant Behemoth', rarity: 'legendary',
    description: '+60% splash damage, +30% splash radius.',
    maxStacks: 3,
    apply: (m) => { m.blastDamageMul *= 1.6; m.blastRadiusMul *= 1.3; },
  },
  highConfidence: {
    id: 'highConfidence', name: 'High Confidence', rarity: 'rare',
    description: '+25% score while at full health.',
    maxStacks: 3,
    apply: (m) => { m.fullHpScoreMul *= 1.25; },
  },
  deathDefiance: {
    id: 'deathDefiance', name: 'Death Defiance', rarity: 'legendary',
    description: 'Revive once per run at 50% health.',
    maxStacks: 2,
    apply: () => { /* handled by the player revive path, see Player.tryRevive */ },
  },
  doubleStrike: {
    id: 'doubleStrike', name: 'Double Strike', rarity: 'rare',
    description: '+30% crit chance, crits deal 2.5x.',
    maxStacks: 3,
    apply: (m) => { m.critChance += 0.3; m.critMul = Math.max(m.critMul, 2.5); },
  },
  greekFire: {
    id: 'greekFire', name: 'Greek Fire', rarity: 'legendary',
    description: 'Kills always ignite nearby enemies for heavy burn.',
    maxStacks: 3,
    apply: (m) => { m.igniteOnKill = 1; },
  },
  ricochet: {
    id: 'ricochet', name: 'Ricochet', rarity: 'rare',
    description: '+8% fire rate, +10% damage.',
    apply: (m) => { m.fireRateMul *= 1.08; m.damageMul *= 1.1; },
  },
  focus: {
    id: 'focus', name: 'Focus', rarity: 'rare',
    description: '+25% damage, -12% fire rate.',
    maxStacks: 3,
    apply: (m) => { m.damageMul *= 1.25; m.fireRateMul *= 0.88; },
  },
  explosiveShells: {
    id: 'explosiveShells', name: 'Explosive Shells', rarity: 'legendary',
    description: '+45% splash damage, +25% splash radius, +6% spread.',
    maxStacks: 3,
    apply: (m) => { m.blastDamageMul *= 1.45; m.blastRadiusMul *= 1.25; m.spreadMul *= 1.06; },
  },
  ninjaInvincibility: {
    id: 'ninjaInvincibility', name: 'Smoke Screen', rarity: 'rare',
    description: '+0.06 s of invulnerability on dash.',
    maxStacks: 4,
    apply: (m) => { m.dashInvulnBonus += 0.06; },
  },
  dualEdge: {
    id: 'dualEdge', name: 'Dual Edge', rarity: 'legendary',
    description: '+30% damage and +20% score, +18% damage taken.',
    maxStacks: 3,
    apply: (m) => { m.damageMul *= 1.3; m.scoreMul *= 1.2; m.damageReduction -= 0.18; },
  },
  midairStrike: {
    id: 'midairStrike', name: 'Midair Strike', rarity: 'common',
    description: '+0.4 s of dash recharge rate.',
    apply: (m) => { m.dashRechargeMul *= 1.12; },
  },
  blackContract: {
    id: 'blackContract', name: 'Black Contract', rarity: 'rare',
    description: '+25% enemy count and +30% enemy health, +40% score and +50% salvage.',
    maxStacks: 4,
    apply: (m) => { m.curse += 0.25; m.scoreMul *= 1.4; m.salvageMul *= 1.5; },
  },
  overclock: {
    id: 'overclock', name: 'Overclock', rarity: 'rare',
    description: '+25% fire rate, -10% damage.',
    apply: (m) => { m.fireRateMul *= 1.25; m.damageMul *= 0.9; },
  },
  superReload: {
    id: 'superReload', name: 'Super Reload', rarity: 'common',
    description: '+25% reload speed.',
    apply: (m) => { m.reloadMul *= 1.25; },
  },
  dieselSoaked: {
    id: 'dieselSoaked', name: 'Diesel Soaked', rarity: 'rare',
    description: 'Kills leave a burning patch behind.',
    maxStacks: 2,
    apply: (m) => { m.igniteOnKill = Math.min(1, m.igniteOnKill + 0.5); },
  },
  bloodyHand: {
    id: 'bloodyHand', name: 'Bloody Hand', rarity: 'legendary',
    description: '6% lifesteal, but you take 1 damage per second.',
    maxStacks: 3,
    apply: (m) => { m.lifesteal += 0.06; m.regen -= 1; },
  },
};

export const UPGRADE_IDS = Object.keys(UPGRADES) as UpgradeId[];

/** Human-readable rarity label for the card frame. */
export function rarityLabel(rarity: Rarity): string {
  if (rarity === 'legendary') return 'LEGENDARY';
  if (rarity === 'rare') return 'RARE';
  return 'COMMON';
}
