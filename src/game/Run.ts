/**
 * Per-run state: the roguelite layer.
 *
 * Everything in here resets when a run starts and is thrown away when it ends.
 * Only `RunSummary` survives (into the meta ledger), which is the design rule
 * for in-run vs meta progression: the run is where skill lives, the meta
 * ledger only records what happened.
 *
 * All stat effects funnel through ONE object (`PlayerMods`) that the player,
 * weapon and wave systems read. Adding a new upgrade is a data change, not a
 * code change — the card pool in `Upgrades.ts` is the only place a new effect
 * needs to be described.
 */
import { Rng } from '../core/rng';
import { UPGRADES, type UpgradeCard, type UpgradeId } from './Upgrades';

/** Aggregated, always-defined modifier set. Every field has an identity value
 *  so consumers never need `?? 1` guards (a missing guard is a silent bug). */
export interface PlayerMods {
  /** Multiplier on all outgoing damage. */
  damageMul: number;
  /** Multiplier on fire rate (higher = faster). */
  fireRateMul: number;
  /** Multiplier on magazine size. */
  magMul: number;
  /** Multiplier on reload speed (higher = faster). */
  reloadMul: number;
  /** Additional spread multiplier (lower = more accurate). */
  spreadMul: number;
  /** Multiplier on max health. */
  maxHealthMul: number;
  /** Flat damage reduction per hit (applied before the fraction). */
  flatArmor: number;
  /** Fraction of incoming damage ignored (0..0.6). */
  damageReduction: number;
  /** Multiplier on walk/sprint speed. */
  moveSpeedMul: number;
  /** Multiplier on dash recharge rate. */
  dashRechargeMul: number;
  /** Extra dash charges. */
  dashChargesBonus: number;
  /** Multiplier on grenade recharge rate. */
  grenadeRechargeMul: number;
  /** Extra grenade charges. */
  grenadeChargesBonus: number;
  /** Multiplier on melee damage. */
  meleeMul: number;
  /** Crit chance 0..1 — headshots always crit, this adds body crits. */
  critChance: number;
  /** Crit damage multiplier. */
  critMul: number;
  /** Flat HP healed on kill. */
  healOnKill: number;
  /** HP per second regeneration. */
  regen: number;
  /** Multiplier on salvage (currency) earned. */
  salvageMul: number;
  /** Multiplier on score earned. */
  scoreMul: number;
  /** Multiplier on the kill-combo window, in seconds. */
  comboWindowBonus: number;
  /** Extra percentage points of splash radius on explosive damage. */
  blastRadiusMul: number;
  /** Extra percentage points of splash damage. */
  blastDamageMul: number;
  /** Multiplier on headshot damage. */
  headshotMul: number;
  /** Extra i-frames on dash, in seconds. */
  dashInvulnBonus: number;
  /** Chance 0..1 to fully ignore a hit (Tougher Times style). */
  blockChance: number;
  /** Fraction of damage dealt returned as health (lifesteal). */
  lifesteal: number;
  /** Chance 0..1 that a kill ignites nearby enemies. */
  igniteOnKill: number;
  /** Percent move speed gained while sprinting (Rose Buckler analogue). */
  sprintArmor: number;
  /** Multiplier on score gained while at full health (High Confidence). */
  fullHpScoreMul: number;
  /** Enemy count multiplier this run (curse). */
  curse: number;
}

export function identityMods(): PlayerMods {
  return {
    damageMul: 1,
    fireRateMul: 1,
    magMul: 1,
    reloadMul: 1,
    spreadMul: 1,
    maxHealthMul: 1,
    flatArmor: 0,
    damageReduction: 0,
    moveSpeedMul: 1,
    dashRechargeMul: 1,
    dashChargesBonus: 0,
    grenadeRechargeMul: 1,
    grenadeChargesBonus: 0,
    meleeMul: 1,
    critChance: 0,
    critMul: 2,
    healOnKill: 0,
    regen: 0,
    salvageMul: 1,
    scoreMul: 1,
    comboWindowBonus: 0,
    blastRadiusMul: 1,
    blastDamageMul: 1,
    headshotMul: 1,
    dashInvulnBonus: 0,
    blockChance: 0,
    lifesteal: 0,
    igniteOnKill: 0,
    sprintArmor: 0,
    fullHpScoreMul: 1,
    curse: 0,
  };
}

/** Everything the meta ledger needs to know about a finished run. */
export interface RunSummary {
  score: number;
  kills: number;
  wave: number;
  wavesCleared: number;
  mode: string;
  seed: number;
  timeSurvived: number;
  shotsFired: number;
  shotsHit: number;
  headshots: number;
  damageDealt: number;
  damageTaken: number;
  longestCombo: number;
  elitesKilled: number;
  bossesKilled: number;
  salvageEarned: number;
  upgrades: UpgradeId[];
  noHitWaves: number;
  bestWaveTime: number;
}

export function emptySummary(): RunSummary {
  return {
    score: 0,
    kills: 0,
    wave: 0,
    wavesCleared: 0,
    mode: 'standard',
    seed: 0,
    timeSurvived: 0,
    shotsFired: 0,
    shotsHit: 0,
    headshots: 0,
    damageDealt: 0,
    damageTaken: 0,
    longestCombo: 0,
    elitesKilled: 0,
    bossesKilled: 0,
    salvageEarned: 0,
    upgrades: [],
    noHitWaves: 0,
    bestWaveTime: 0,
  };
}

/** A card offered in the draft, with its rolled rarity. */
export interface DraftOffer {
  card: UpgradeCard;
  /** How many copies the player already owns (drives stack labels). */
  owned: number;
}

const MAX_STACKS = 5;

/**
 * The live run. Owns the seeded RNG, the upgrade stacks, the modifier cache
 * and the per-run statistics.
 */
export class Run {
  public readonly rng: Rng;
  public readonly seed: number;
  public readonly mods: PlayerMods = identityMods();
  public readonly stats = emptySummary();

  /** Salvage earned this run but not yet spent. */
  public salvage = 0;
  /** Stack count per upgrade id. */
  public readonly stacks = new Map<UpgradeId, number>();
  /** Ordered acquisition log — shown on the death card. */
  public readonly taken: UpgradeId[] = [];
  /** Rerolls remaining in the current draft. */
  public rerolls = 1;
  /** Card slots offered per draft. */
  public cardSlots = 3;

  private readonly dirty = { value: true };
  private elapsed = 0;

  public constructor(seed: number) {
    this.seed = seed >>> 0;
    this.rng = new Rng(this.seed);
    this.stats.seed = this.seed;
  }

  public tick(dt: number): void {
    this.elapsed += dt;
    this.stats.timeSurvived = this.elapsed;
  }

  /** Add salvage, applying the salvage multiplier. */
  public earnSalvage(base: number): void {
    const gained = Math.max(0, Math.round(base * this.mods.salvageMul));
    this.salvage += gained;
    this.stats.salvageEarned += gained;
  }

  public spendSalvage(amount: number): boolean {
    if (this.salvage < amount) return false;
    this.salvage -= amount;
    return true;
  }

  public stackOf(id: UpgradeId): number {
    return this.stacks.get(id) ?? 0;
  }

  /** True when the card is at its stack cap and must not be offered again. */
  public isMaxed(card: UpgradeCard): boolean {
    return this.stackOf(card.id) >= (card.maxStacks ?? MAX_STACKS);
  }

  public take(id: UpgradeId): void {
    this.stacks.set(id, this.stackOf(id) + 1);
    this.taken.push(id);
    this.dirty.value = true;
  }

  /** Remove one stack (used by "sell" at the kiosk). */
  public refund(id: UpgradeId): void {
    const n = this.stackOf(id);
    if (n <= 0) return;
    if (n === 1) this.stacks.delete(id);
    else this.stacks.set(id, n - 1);
    const i = this.taken.lastIndexOf(id);
    if (i >= 0) this.taken.splice(i, 1);
    this.dirty.value = true;
  }

  /**
   * Rebuild the aggregate modifier object from the stacks. Called lazily: the
   * draft is the only thing that changes it, so recomputing per tick would be
   * pure waste.
   */
  public sync(): void {
    if (!this.dirty.value) return;
    this.dirty.value = false;
    Object.assign(this.mods, identityMods());
    for (const [id, count] of this.stacks) {
      const card = UPGRADES[id];
      if (!card) continue;
      for (let i = 0; i < count; i++) card.apply(this.mods);
    }
    // Clamp the fields where an unbounded value would break the game rather
    // than merely make it easy. Percentage stacks can otherwise reach 100 %+.
    this.mods.damageReduction = Math.min(0.6, this.mods.damageReduction);
    this.mods.blockChance = Math.min(0.6, this.mods.blockChance);
    this.mods.critChance = Math.min(1, this.mods.critChance);
    this.mods.lifesteal = Math.min(0.25, this.mods.lifesteal);
    this.mods.regen = Math.min(12, this.mods.regen);
    this.mods.flatArmor = Math.min(8, this.mods.flatArmor);
    this.mods.spreadMul = Math.max(0.25, this.mods.spreadMul);
    this.mods.fireRateMul = Math.min(2.5, this.mods.fireRateMul);
    this.mods.moveSpeedMul = Math.min(1.6, this.mods.moveSpeedMul);
    this.mods.curse = Math.min(2, this.mods.curse);
  }

  /**
   * Roll a draft. Cards already at max stacks are excluded; rarity weights
   * shift toward rare/legendary as the wave climbs, which is the standard
   * "the pool gets better as the run gets harder" curve.
   */
  public rollDraft(wave: number, count = this.cardSlots): DraftOffer[] {
    const pool = Object.values(UPGRADES).filter((card) => !this.isMaxed(card));
    const offers: DraftOffer[] = [];
    const taken = new Set<UpgradeId>();
    const rareBias = Math.min(2.2, 1 + wave * 0.045);
    for (let i = 0; i < count && pool.length > 0; i++) {
      const candidates = pool.filter((card) => !taken.has(card.id));
      if (candidates.length === 0) break;
      const pick = this.rng.weighted(candidates, (card) => {
        if (card.rarity === 'common') return 100;
        if (card.rarity === 'rare') return 45 * rareBias;
        return 14 * rareBias * rareBias;
      });
      if (!pick) break;
      taken.add(pick.id);
      offers.push({ card: pick, owned: this.stackOf(pick.id) });
    }
    return offers;
  }

  /** Curse raises enemy count and HP but pays score and salvage for it. */
  public get curseCountMul(): number {
    return 1 + this.mods.curse * 0.25;
  }

  public get curseHpMul(): number {
    return 1 + this.mods.curse * 0.3;
  }
}
