/**
 * Achievements: the long-game checklist.
 *
 * Pure data plus a stateless evaluator. `ACHIEVEMENTS` is the single source of
 * truth for what exists and what each entry watches; `AchievementTracker` only
 * compares a counter snapshot against that table. The counters themselves live
 * in `AchievementCounters.ts`, the only module that maps live game events onto
 * metric names.
 *
 * The evaluator keeps no memory. Callers pass the set of ids that are already
 * unlocked and get back only the ids that became true this call, which keeps the
 * tracker trivially testable and leaves persistence to the save layer.
 *
 * Modeling notes, for conditions that cannot be a single threshold:
 *  - Shrine Raider counts hazard kills; no metric records a hazard activation.
 *  - Double or Nothing counts every card held in a run; curse cards are not
 *    separable from the rest in the counter set.
 *  - Devil's Bargain, Blitzkrieg and Onslaught all threshold bestWave, which is
 *    mode and health agnostic, so their flavor cannot be enforced by a counter.
 *  - Giant Killer counts elite kills; melee kills on elites are not separable,
 *    so MELEE MAYHEM carries the melee side.
 *  - Speed Demon is five fast wave clears (perfectWaves) because no metric
 *    records the clear time of one specific wave.
 *  - Untouchable Run needs a counter that must stay at zero, so it is a compound
 *    check instead of a threshold; see COMPOUND_CHECKS below.
 */

/** Every counter the achievement table can read. */
export type AchievementMetric =
  | 'totalKills' | 'totalHeadshots' | 'totalShots' | 'totalRuns' | 'totalWavesCleared'
  | 'bestCombo' | 'bestWave' | 'bestWaveOverrun' | 'elitesKilled' | 'bossesKilled'
  | 'barrelKills' | 'hazardKills' | 'meleeKills' | 'grenadeKills' | 'dashKills'
  | 'noHitWavesBest' | 'accuracyBestWave' | 'longestSurvival' | 'cardsInRun'
  | 'maxedTagsInRun' | 'upgradesTakenTotal' | 'dailyRunsPlayed' | 'deathsTotal'
  | 'lifestealHealed' | 'damageDealtTotal' | 'perfectWaves' | 'styleRankBest'
  | 'sprayRuns'; // runs finished with 500 or more shots at under 10 percent accuracy

export type AchievementId =
  // bronze
  | 'firstBlood' | 'killtacular' | 'untouchable' | 'overkill' | 'shrineRaider'
  | 'sprayAndPray' | 'meleeMayhem'
  // silver
  | 'headhunter' | 'deadeye' | 'ironSkin' | 'killionaire' | 'doubleOrNothing'
  | 'giantKiller' | 'boomBoom' | 'gunsmith' | 'specialist' | 'speedDemon'
  | 'blitzkrieg' | 'dailyDuty' | 'untouchableRun' | 'vampire' | 'pacifistAdjacent'
  | 'aerialAce' | 'waveBreaker'
  // gold
  | 'wallOfLead' | 'perfectionist' | 'crowdControl' | 'devilsBargain' | 'bossSlayer'
  | 'environmentalist' | 'collector' | 'marathon' | 'endless' | 'onslaught'
  | 'styleGod' | 'thousandYardStare';

export interface AchievementDef {
  id: AchievementId;
  /** Short label for the list row, uppercase in the UI. */
  name: string;
  /** One factual sentence stating the exact modeled condition. */
  description: string;
  tier: 'bronze' | 'silver' | 'gold';
  /** Which counter this achievement watches. */
  metric: AchievementMetric;
  /** Threshold the counter must reach. */
  target: number;
  /** When true the check is "counter must be >= target", when false it is
   *  "counter must be exactly target in a single run" (per-run bests). */
  cumulative: boolean;
}

/**
 * Declaration order is the display order: bronze, then silver, then gold.
 * `Record<AchievementId, AchievementDef>` makes the compiler enforce that every
 * id has exactly one entry, so the table and the union cannot drift apart.
 */
export const ACHIEVEMENTS: Record<AchievementId, AchievementDef> = {
  // ---------------------------------------------------------------- bronze
  firstBlood: {
    id: 'firstBlood', name: 'FIRST BLOOD', tier: 'bronze',
    description: 'Kill 1 enemy.',
    metric: 'totalKills', target: 1, cumulative: true,
  },
  killtacular: {
    id: 'killtacular', name: 'KILLTACULAR', tier: 'bronze',
    description: 'Reach a 5 kill combo.',
    metric: 'bestCombo', target: 5, cumulative: false,
  },
  untouchable: {
    id: 'untouchable', name: 'UNTOUCHABLE', tier: 'bronze',
    description: 'Clear 3 waves without taking a hit.',
    metric: 'noHitWavesBest', target: 3, cumulative: false,
  },
  overkill: {
    id: 'overkill', name: 'OVERKILL', tier: 'bronze',
    description: 'Clear a wave in under 20 seconds.',
    metric: 'perfectWaves', target: 1, cumulative: true,
  },
  shrineRaider: {
    id: 'shrineRaider', name: 'SHRINE RAIDER', tier: 'bronze',
    description: 'Get 10 kills from hazards.',
    metric: 'hazardKills', target: 10, cumulative: true,
  },
  sprayAndPray: {
    id: 'sprayAndPray', name: 'SPRAY AND PRAY', tier: 'bronze',
    description: 'Finish a run with 500 or more shots fired and under 10 percent accuracy.',
    metric: 'sprayRuns', target: 1, cumulative: true,
  },
  meleeMayhem: {
    id: 'meleeMayhem', name: 'MELEE MAYHEM', tier: 'bronze',
    description: 'Kill 25 enemies with melee attacks.',
    metric: 'meleeKills', target: 25, cumulative: true,
  },

  // ---------------------------------------------------------------- silver
  headhunter: {
    id: 'headhunter', name: 'HEADHUNTER', tier: 'silver',
    description: 'Land 100 headshots.',
    metric: 'totalHeadshots', target: 100, cumulative: true,
  },
  deadeye: {
    id: 'deadeye', name: 'DEADEYE', tier: 'silver',
    description: 'Finish a wave with at least 90 percent accuracy.',
    metric: 'accuracyBestWave', target: 0.9, cumulative: false,
  },
  ironSkin: {
    id: 'ironSkin', name: 'IRON SKIN', tier: 'silver',
    description: 'Clear 10 waves without taking a hit.',
    metric: 'noHitWavesBest', target: 10, cumulative: false,
  },
  killionaire: {
    id: 'killionaire', name: 'KILLIONAIRE', tier: 'silver',
    description: 'Reach a 10 kill combo.',
    metric: 'bestCombo', target: 10, cumulative: false,
  },
  doubleOrNothing: {
    id: 'doubleOrNothing', name: 'DOUBLE OR NOTHING', tier: 'silver',
    description: 'Hold 5 upgrade cards in a single run.',
    metric: 'cardsInRun', target: 5, cumulative: false,
  },
  giantKiller: {
    id: 'giantKiller', name: 'GIANT KILLER', tier: 'silver',
    description: 'Kill 5 elites.',
    metric: 'elitesKilled', target: 5, cumulative: true,
  },
  boomBoom: {
    id: 'boomBoom', name: 'BOOM BOOM', tier: 'silver',
    description: 'Kill 25 enemies with barrels.',
    metric: 'barrelKills', target: 25, cumulative: true,
  },
  gunsmith: {
    id: 'gunsmith', name: 'GUNSMITH', tier: 'silver',
    description: 'Take 25 upgrades across all runs.',
    metric: 'upgradesTakenTotal', target: 25, cumulative: true,
  },
  specialist: {
    id: 'specialist', name: 'SPECIALIST', tier: 'silver',
    description: 'Max out 3 synergy tags in a single run.',
    metric: 'maxedTagsInRun', target: 3, cumulative: false,
  },
  speedDemon: {
    id: 'speedDemon', name: 'SPEED DEMON', tier: 'silver',
    description: 'Clear 5 waves in under 20 seconds each.',
    metric: 'perfectWaves', target: 5, cumulative: true,
  },
  blitzkrieg: {
    id: 'blitzkrieg', name: 'BLITZKRIEG', tier: 'silver',
    description: 'Reach wave 10.',
    metric: 'bestWave', target: 10, cumulative: false,
  },
  dailyDuty: {
    id: 'dailyDuty', name: 'DAILY DUTY', tier: 'silver',
    description: 'Play 7 daily runs.',
    metric: 'dailyRunsPlayed', target: 7, cumulative: true,
  },
  untouchableRun: {
    id: 'untouchableRun', name: 'UNTOUCHABLE RUN', tier: 'silver',
    description: 'Finish a run without dying.',
    metric: 'deathsTotal', target: 1, cumulative: false,
  },
  vampire: {
    id: 'vampire', name: 'VAMPIRE', tier: 'silver',
    description: 'Heal 5000 HP with lifesteal.',
    metric: 'lifestealHealed', target: 5000, cumulative: true,
  },
  pacifistAdjacent: {
    id: 'pacifistAdjacent', name: 'PACIFIST ADJACENT', tier: 'silver',
    description: 'Get 100 kills with grenades.',
    metric: 'grenadeKills', target: 100, cumulative: true,
  },
  aerialAce: {
    id: 'aerialAce', name: 'AERIAL ACE', tier: 'silver',
    description: 'Get 50 kills while dashing.',
    metric: 'dashKills', target: 50, cumulative: true,
  },
  waveBreaker: {
    id: 'waveBreaker', name: 'WAVE BREAKER', tier: 'silver',
    description: 'Clear 50 waves across all runs.',
    metric: 'totalWavesCleared', target: 50, cumulative: true,
  },

  // ------------------------------------------------------------------ gold
  wallOfLead: {
    id: 'wallOfLead', name: 'WALL OF LEAD', tier: 'gold',
    description: 'Fire 10000 shots.',
    metric: 'totalShots', target: 10000, cumulative: true,
  },
  perfectionist: {
    id: 'perfectionist', name: 'PERFECTIONIST', tier: 'gold',
    description: 'Clear 25 waves without taking a hit.',
    metric: 'noHitWavesBest', target: 25, cumulative: false,
  },
  crowdControl: {
    id: 'crowdControl', name: 'CROWD CONTROL', tier: 'gold',
    description: 'Reach a 15 kill combo.',
    metric: 'bestCombo', target: 15, cumulative: false,
  },
  devilsBargain: {
    id: 'devilsBargain', name: "DEVIL'S BARGAIN", tier: 'gold',
    description: 'Reach wave 10.',
    metric: 'bestWave', target: 10, cumulative: false,
  },
  bossSlayer: {
    id: 'bossSlayer', name: 'BOSS SLAYER', tier: 'gold',
    description: 'Kill 10 bosses.',
    metric: 'bossesKilled', target: 10, cumulative: true,
  },
  environmentalist: {
    id: 'environmentalist', name: 'ENVIRONMENTALIST', tier: 'gold',
    description: 'Get 100 kills from hazards.',
    metric: 'hazardKills', target: 100, cumulative: true,
  },
  collector: {
    id: 'collector', name: 'COLLECTOR', tier: 'gold',
    description: 'Hold 12 upgrade cards in a single run.',
    metric: 'cardsInRun', target: 12, cumulative: false,
  },
  marathon: {
    id: 'marathon', name: 'MARATHON', tier: 'gold',
    description: 'Survive 30 minutes in a single run.',
    metric: 'longestSurvival', target: 1800, cumulative: false,
  },
  endless: {
    id: 'endless', name: 'ENDLESS', tier: 'gold',
    description: 'Reach wave 25 in OVERRUN.',
    metric: 'bestWaveOverrun', target: 25, cumulative: false,
  },
  onslaught: {
    id: 'onslaught', name: 'ONSLAUGHT', tier: 'gold',
    description: 'Reach wave 10.',
    metric: 'bestWave', target: 10, cumulative: false,
  },
  styleGod: {
    id: 'styleGod', name: 'STYLE GOD', tier: 'gold',
    description: 'Reach style rank 7.',
    metric: 'styleRankBest', target: 7, cumulative: false,
  },
  thousandYardStare: {
    id: 'thousandYardStare', name: 'THOUSAND YARD STARE', tier: 'gold',
    description: 'Deal 1000000 total damage.',
    metric: 'damageDealtTotal', target: 1e6, cumulative: true,
  },
};

/** Values in declaration order, which is also display order. */
const ALL_ACHIEVEMENTS: readonly AchievementDef[] = Object.values(ACHIEVEMENTS);

/** Whole-number clamp for the 0..1 progress bar. */
function clamp01(value: number): number {
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * Compound predicates for achievements whose condition is not a single
 * threshold. UNTOUCHABLE RUN requires at least one finished run and zero deaths
 * so far: a counter that must STAY at zero cannot be written as
 * "counter >= target", so it is checked here instead. These ids are read only
 * by the evaluator; every other achievement is a pure threshold on one metric.
 */
const COMPOUND_CHECKS: Partial<
  Record<AchievementId, (counters: Readonly<Record<AchievementMetric, number>>) => boolean>
> = {
  untouchableRun: (counters) => counters.totalRuns >= 1 && counters.deathsTotal === 0,
};

/** Stateless evaluator over the table above. One shared instance is enough;
 *  the class exists so the UI has a single progress/summary implementation. */
export class AchievementTracker {
  /** Returns ids newly unlocked this call (never repeats). */
  public evaluate(
    counters: Readonly<Record<AchievementMetric, number>>,
    unlocked: ReadonlySet<AchievementId>,
  ): AchievementId[] {
    const fresh: AchievementId[] = [];
    for (const def of ALL_ACHIEVEMENTS) {
      if (unlocked.has(def.id)) continue;
      if (this.meets(def, counters)) fresh.push(def.id);
    }
    return fresh;
  }

  /** 0..1 progress for the UI, safe for any id. */
  public progress(
    id: AchievementId,
    counters: Readonly<Record<AchievementMetric, number>>,
  ): number {
    const def: AchievementDef | undefined = ACHIEVEMENTS[id];
    // Unknown id: return 0, never 1. There is no definition and no target to
    // measure against, and a missing row must not read as "completed".
    if (!def) return 0;
    const compound = COMPOUND_CHECKS[def.id];
    if (compound) return compound(counters) ? 1 : 0;
    if (def.target <= 0) return 0;
    const value = counters[def.metric];
    if (!Number.isFinite(value)) return 0;
    return clamp01(value / def.target);
  }

  /** Human summary: { unlocked: number, total: number, percent: number }. */
  public summary(
    unlocked: ReadonlySet<AchievementId>,
  ): { unlocked: number; total: number; percent: number } {
    let count = 0;
    for (const def of ALL_ACHIEVEMENTS) {
      if (unlocked.has(def.id)) count += 1;
    }
    const total = ALL_ACHIEVEMENTS.length;
    // Whole percent in 0..100, so the HUD can print it next to the counts.
    const percent = total > 0 ? Math.round((count / total) * 100) : 0;
    return { unlocked: count, total, percent };
  }

  /** All achievements grouped by tier, stable order (bronze, silver, gold). */
  public byTier(): Record<'bronze' | 'silver' | 'gold', AchievementDef[]> {
    const out: Record<'bronze' | 'silver' | 'gold', AchievementDef[]> = {
      bronze: [],
      silver: [],
      gold: [],
    };
    for (const def of ALL_ACHIEVEMENTS) out[def.tier].push(def);
    return out;
  }

  /**
   * True when a def's condition holds for a counter snapshot.
   *
   * Cumulative metrics are lifetime sums, so the test is value >= target.
   * Non-cumulative metrics store the best value seen in a single run, so the
   * test is ALSO value >= target: a best that overshoots the target proves the
   * target was reached, and no "exactly" comparison is needed.
   */
  private meets(
    def: AchievementDef,
    counters: Readonly<Record<AchievementMetric, number>>,
  ): boolean {
    const compound = COMPOUND_CHECKS[def.id];
    if (compound) return compound(counters);
    const value = counters[def.metric];
    // A non-finite counter never unlocks: a corrupt save must not satisfy every
    // threshold at once.
    return Number.isFinite(value) && value >= def.target;
  }
}
