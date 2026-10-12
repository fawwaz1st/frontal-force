/**
 * Run challenges: opt-in difficulty modifiers with a score payout.
 *
 * A challenge is a wager, not a menu setting. Each one makes a specific part
 * of the game harder in a way the player can read before the run starts, and
 * pays a score multiplier for taking it. They are selected in the menu, they
 * are part of the seed contract (two players on the same seed with the same
 * challenges get the same run), and they stack multiplicatively in payout so
 * taking three is a real gamble.
 *
 * The implementation is deliberately data-only: `ChallengeDef` carries the
 * numeric knobs the systems already understand, so adding a challenge never
 * requires touching the systems themselves.
 */

export const CHALLENGE_IDS = [
  'glassCannon',
  'ironclad',
  'famine',
  'relentless',
  'scatter',
  'horde',
] as const;

export type ChallengeId = (typeof CHALLENGE_IDS)[number];

export interface ChallengeDef {
  id: ChallengeId;
  name: string;
  /** One line the menu shows verbatim. */
  description: string;
  /** Multiplier on the final score. Applied multiplicatively across picks. */
  scoreMul: number;
  /** Enemy health multiplier. */
  enemyHpMul: number;
  /** Enemy movement speed multiplier. */
  enemySpeedMul: number;
  /** Enemy spawn count multiplier. */
  enemyCountMul: number;
  /** Player max-health multiplier. */
  playerHpMul: number;
  /** Damage the player takes multiplier. */
  playerDamageMul: number;
  /** Player starting reserve ammo multiplier (never the magazine). */
  playerAmmoMul: number;
  /** Player spread cone multiplier. */
  playerSpreadMul: number;
  /** Multiplier on the salvage paid per kill. */
  salvageMul: number;
  /** Extra elite affixes rolled on every elite. */
  extraAffixes: number;
}

/** Identity values, so a run with no challenges reads exactly like today. */
const IDENTITY: Omit<
  ChallengeDef,
  'id' | 'name' | 'description' | 'scoreMul'
> = {
  enemyHpMul: 1,
  enemySpeedMul: 1,
  enemyCountMul: 1,
  playerHpMul: 1,
  playerDamageMul: 1,
  playerAmmoMul: 1,
  playerSpreadMul: 1,
  salvageMul: 1,
  extraAffixes: 0,
};

export const CHALLENGES: Record<ChallengeId, ChallengeDef> = {
  glassCannon: {
    id: 'glassCannon',
    name: 'Glass Cannon',
    description: 'You take double damage. +30% score.',
    scoreMul: 1.3,
    ...IDENTITY,
    playerDamageMul: 2,
  },
  ironclad: {
    id: 'ironclad',
    name: 'Ironclad',
    description: 'Enemies have 40% more health. +30% score.',
    scoreMul: 1.3,
    ...IDENTITY,
    enemyHpMul: 1.4,
  },
  famine: {
    id: 'famine',
    name: 'Famine',
    description: 'You start with half the reserve ammo. +20% score.',
    scoreMul: 1.2,
    ...IDENTITY,
    playerAmmoMul: 0.5,
  },
  relentless: {
    id: 'relentless',
    name: 'Relentless',
    description: 'Enemies move 20% faster. +25% score.',
    scoreMul: 1.25,
    ...IDENTITY,
    enemySpeedMul: 1.2,
  },
  scatter: {
    id: 'scatter',
    name: 'Scatter',
    description: 'Your weapon cone is 60% wider. +25% score.',
    scoreMul: 1.25,
    ...IDENTITY,
    playerSpreadMul: 1.6,
  },
  horde: {
    id: 'horde',
    name: 'Horde',
    description: 'Waves spawn 50% more enemies and elites gain an extra affix. +45% score.',
    scoreMul: 1.45,
    ...IDENTITY,
    enemyCountMul: 1.5,
    extraAffixes: 1,
  },
};

/** Numeric fields that a selection modifies. */
export type ChallengeStat = Exclude<
  keyof ChallengeDef,
  'id' | 'name' | 'description'
>;

/** The aggregate of a selection: one number per stat, identity when empty. */
export type ChallengeMods = Record<ChallengeStat, number>;

export function identityChallengeMods(): ChallengeMods {
  return {
    scoreMul: 1,
    enemyHpMul: 1,
    enemySpeedMul: 1,
    enemyCountMul: 1,
    playerHpMul: 1,
    playerDamageMul: 1,
    playerAmmoMul: 1,
    playerSpreadMul: 1,
    salvageMul: 1,
    extraAffixes: 0,
  };
}

/**
 * Fold a selection into one modifier set.
 *
 * Multipliers compose multiplicatively (two +25% payouts are x1.5625, not
 * x1.5) because that is what makes stacking them a real decision; the one
 * additive field is `extraAffixes`, which counts.
 */
export function foldChallenges(ids: readonly ChallengeId[]): ChallengeMods {
  const out = identityChallengeMods();
  for (const id of ids) {
    const def = CHALLENGES[id];
    if (!def) continue;
    out.scoreMul *= def.scoreMul;
    out.enemyHpMul *= def.enemyHpMul;
    out.enemySpeedMul *= def.enemySpeedMul;
    out.enemyCountMul *= def.enemyCountMul;
    out.playerHpMul *= def.playerHpMul;
    out.playerDamageMul *= def.playerDamageMul;
    out.playerAmmoMul *= def.playerAmmoMul;
    out.playerSpreadMul *= def.playerSpreadMul;
    out.salvageMul *= def.salvageMul;
    out.extraAffixes += def.extraAffixes;
  }
  return out;
}

/** Total score payout for a selection, for the menu's live readout. */
export function challengeScoreMul(ids: readonly ChallengeId[]): number {
  return foldChallenges(ids).scoreMul;
}

/** Stable short label for the HUD chip, e.g. "GLASS CANNON + HORDE". */
export function challengeLabel(ids: readonly ChallengeId[]): string {
  return ids.map((id) => CHALLENGES[id]?.name.toUpperCase() ?? id).join(' + ');
}
