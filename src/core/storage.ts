import { clamp } from './math';
import type { QualityTier } from './quality';

const KEY = 'frontal-force.v1';

export const GAME_MODES = ['standard', 'blitz', 'onslaught', 'rotator', 'overrun'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export const QUALITY_TIERS = ['auto', 'low', 'medium', 'high'] as const;
export type QualitySetting = (typeof QUALITY_TIERS)[number];

export interface SaveData {
  /** Schema version — forced to current on every load (additive fields only). */
  version: number;
  bestScore: number;
  bestWave: number;
  bestWaveOverrun: number;
  totalKills: number;
  totalRuns: number;
  totalWavesCleared: number;
  killsPerMode: Partial<Record<GameMode, number>>;
  sensitivity: number;
  /** Touch look multiplier — phones need a different feel from a mouse. */
  touchSensitivity: number;
  /** 'auto' = boot heuristic + frame-time governor. */
  quality: QualitySetting;
  volume: number;
  mode: GameMode;
}

export const DEFAULT_SAVE: SaveData = {
  version: 1,
  bestScore: 0,
  bestWave: 0,
  bestWaveOverrun: 0,
  totalKills: 0,
  totalRuns: 0,
  totalWavesCleared: 0,
  killsPerMode: {},
  sensitivity: 1,
  touchSensitivity: 1,
  quality: 'auto',
  volume: 0.42,
  mode: 'standard',
};

const finite = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

const isGameMode = (v: unknown): v is GameMode =>
  typeof v === 'string' && GAME_MODES.some((mode) => mode === v);

const isQuality = (v: unknown): v is QualitySetting =>
  typeof v === 'string' && QUALITY_TIERS.some((tier) => tier === v);

/** Fresh save object — never hands out the shared DEFAULT_SAVE internals
 *  (killsPerMode is a nested object, so a spread alone would alias it). */
function defaultSave(): SaveData {
  return { ...DEFAULT_SAVE, killsPerMode: { ...DEFAULT_SAVE.killsPerMode } };
}

/** Tiny persistence layer for settings and personal records.
 * Every field is validated: finite numbers, clamped ranges, allowlisted mode —
 * a tampered localStorage can't inject NaN/Infinity or HTML into innerHTML sinks. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return defaultSave();
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return defaultSave();
    const p = parsed as Record<string, unknown>;
    const out = defaultSave();
    out.bestScore = clamp(Math.floor(finite(p.bestScore, 0)), 0, 1e9);
    out.bestWave = clamp(Math.floor(finite(p.bestWave, 0)), 0, 9999);
    out.sensitivity = clamp(finite(p.sensitivity, DEFAULT_SAVE.sensitivity), 0.2, 3);
    out.touchSensitivity = clamp(finite(p.touchSensitivity, DEFAULT_SAVE.touchSensitivity), 0.2, 3);
    out.quality = isQuality(p.quality) ? p.quality : DEFAULT_SAVE.quality;
    out.volume = clamp(finite(p.volume, DEFAULT_SAVE.volume), 0, 1);
    out.mode = isGameMode(p.mode) ? p.mode : DEFAULT_SAVE.mode;
    // Additive lifetime counters: hydrate with defaults so legacy saves (and
    // tampered payloads) can never inject NaN/unknown keys into the UI.
    out.version = 1;
    out.bestWaveOverrun = clamp(Math.floor(finite(p.bestWaveOverrun, 0)), 0, 9999);
    out.totalKills = clamp(Math.floor(finite(p.totalKills, 0)), 0, 1e9);
    out.totalRuns = clamp(Math.floor(finite(p.totalRuns, 0)), 0, 1e9);
    out.totalWavesCleared = clamp(Math.floor(finite(p.totalWavesCleared, 0)), 0, 1e9);
    const rawKills =
      typeof p.killsPerMode === 'object' && p.killsPerMode !== null
        ? (p.killsPerMode as Record<string, unknown>)
        : {};
    const kills: Partial<Record<GameMode, number>> = {};
    for (const m of GAME_MODES) kills[m] = clamp(Math.floor(finite(rawKills[m], 0)), 0, 1e9);
    out.killsPerMode = kills;
    return out;
  } catch {
    return defaultSave();
  }
}

export function persistSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}

/** Resolve the tier to actually render at: an explicit choice wins, otherwise
 *  the boot heuristic decides. Kept here so storage stays the single source. */
export function resolveTier(setting: QualitySetting, detected: QualityTier): QualityTier {
  return setting === 'auto' ? detected : setting;
}
