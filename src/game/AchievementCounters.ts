/**
 * Achievement counters: the live record plus the fold from a finished run.
 *
 * The record is a flat map of metric name to number, kept deliberately dumb so
 * it can be serialized into the save file without a schema. Two kinds of metric
 * live in it:
 *  - lifetime totals, which only grow by addition (kills, shots, runs, ...);
 *  - per-run bests, which only grow by `Math.max` (best wave, best combo, ...).
 * `applyRun` is the only writer, and it is the single place that knows which run
 * field feeds which metric.
 *
 * Every input is sanitized on the way in: non-finite values are dropped and
 * negatives are clamped to 0, so a bad run summary can never poison the record
 * with NaN or Infinity.
 */
import type { AchievementMetric } from './Achievements';

/** Finite, non-negative number: the only shape allowed into the record. */
function num(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

/** Sum that survives a corrupt counter or a bad run field. */
function add(current: number, delta: number): number {
  return num(current) + num(delta);
}

/** Max that survives a corrupt counter or a bad run field. */
function raise(current: number, candidate: number): number {
  return Math.max(num(current), num(candidate));
}

/** All-zero counters. */
export function createCounters(): Record<AchievementMetric, number> {
  return {
    totalKills: 0, totalHeadshots: 0, totalShots: 0, totalRuns: 0, totalWavesCleared: 0,
    bestCombo: 0, bestWave: 0, bestWaveOverrun: 0, elitesKilled: 0, bossesKilled: 0,
    barrelKills: 0, hazardKills: 0, meleeKills: 0, grenadeKills: 0, dashKills: 0,
    noHitWavesBest: 0, accuracyBestWave: 0, longestSurvival: 0, cardsInRun: 0,
    maxedTagsInRun: 0, upgradesTakenTotal: 0, dailyRunsPlayed: 0, deathsTotal: 0,
    lifestealHealed: 0, damageDealtTotal: 0, perfectWaves: 0, styleRankBest: 0,
    sprayRuns: 0,
  };
}

/** Fold a finished run into the lifetime counters. */
export interface RunResult {
  kills: number;
  headshots: number;
  shotsFired: number;
  shotsHit: number;
  wave: number;
  wavesCleared: number;
  mode: 'standard' | 'blitz' | 'onslaught' | 'rotator' | 'overrun';
  timeSurvived: number;
  damageDealt: number;
  longestCombo: number;
  elitesKilled: number;
  bossesKilled: number;
  barrelKills: number;
  hazardKills: number;
  meleeKills: number;
  grenadeKills: number;
  dashKills: number;
  noHitWaves: number;
  cardsInRun: number;
  /** Maxed synergy tags this run (feeds `maxedTagsInRun`). */
  maxedTags: number;
  upgradesTaken: number;
  lifestealHealed: number;
  accuracyBestWave: number;
  styleRank: number;
  isDaily: boolean;
  died: boolean;
  /** Best single-wave clear time in seconds this run (0 = none recorded). */
  bestWaveTime: number;
}

export function applyRun(counters: Record<AchievementMetric, number>, run: RunResult): void {
  // Lifetime totals: every field is added as-is, negatives and non-finite
  // values are flattened by `add`.
  counters.totalKills = add(counters.totalKills, run.kills);
  counters.totalHeadshots = add(counters.totalHeadshots, run.headshots);
  counters.totalShots = add(counters.totalShots, run.shotsFired);
  counters.totalWavesCleared = add(counters.totalWavesCleared, run.wavesCleared);
  counters.elitesKilled = add(counters.elitesKilled, run.elitesKilled);
  counters.bossesKilled = add(counters.bossesKilled, run.bossesKilled);
  counters.barrelKills = add(counters.barrelKills, run.barrelKills);
  counters.hazardKills = add(counters.hazardKills, run.hazardKills);
  counters.meleeKills = add(counters.meleeKills, run.meleeKills);
  counters.grenadeKills = add(counters.grenadeKills, run.grenadeKills);
  counters.dashKills = add(counters.dashKills, run.dashKills);
  counters.upgradesTakenTotal = add(counters.upgradesTakenTotal, run.upgradesTaken);
  counters.lifestealHealed = add(counters.lifestealHealed, run.lifestealHealed);
  counters.damageDealtTotal = add(counters.damageDealtTotal, run.damageDealt);

  // Run counts.
  counters.totalRuns = add(counters.totalRuns, 1);
  counters.deathsTotal = add(counters.deathsTotal, run.died ? 1 : 0);
  counters.dailyRunsPlayed = add(counters.dailyRunsPlayed, run.isDaily ? 1 : 0);

  // Per-run bests: these never decrease.
  counters.bestCombo = raise(counters.bestCombo, run.longestCombo);
  counters.bestWave = raise(counters.bestWave, run.wave);
  // OVERRUN is endless, so its wave record only moves in that mode.
  if (run.mode === 'overrun') {
    counters.bestWaveOverrun = raise(counters.bestWaveOverrun, run.wave);
  }
  counters.noHitWavesBest = raise(counters.noHitWavesBest, run.noHitWaves);
  // Accuracy is a 0..1 fraction; clamp the top end as well so a bad summary
  // cannot store 4.0 and block the DEADEYE progress bar forever.
  counters.accuracyBestWave = raise(
    counters.accuracyBestWave,
    Math.min(1, num(run.accuracyBestWave)),
  );
  counters.longestSurvival = raise(counters.longestSurvival, run.timeSurvived);
  counters.cardsInRun = raise(counters.cardsInRun, run.cardsInRun);
  counters.maxedTagsInRun = raise(counters.maxedTagsInRun, run.maxedTags);
  counters.styleRankBest = raise(counters.styleRankBest, run.styleRank);

  // Derived per-run flags, summed across runs.
  // A perfect wave is a wave cleared in under 20 seconds.
  const waveTime = num(run.bestWaveTime);
  counters.perfectWaves = add(counters.perfectWaves, waveTime > 0 && waveTime < 20 ? 1 : 0);
  // A spray run is 500 or more shots fired at under 10 percent accuracy.
  const shots = num(run.shotsFired);
  const hits = Math.min(shots, num(run.shotsHit));
  const accuracy = shots > 0 ? hits / shots : 0;
  counters.sprayRuns = add(counters.sprayRuns, shots >= 500 && accuracy < 0.1 ? 1 : 0);
}
