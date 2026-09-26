import { clamp } from './math';

const KEY = 'frontal-force.v1';

export const GAME_MODES = ['standard', 'blitz', 'onslaught', 'rotator', 'overrun'] as const;
export type GameMode = (typeof GAME_MODES)[number];

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
  volume: 0.42,
  mode: 'standard',
};

const finite = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

const isGameMode = (v: unknown): v is GameMode =>
  typeof v === 'string' && GAME_MODES.some((mode) => mode === v);

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
