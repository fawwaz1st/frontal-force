import { clamp } from './math';

const KEY = 'frontal-force.v1';

export const GAME_MODES = ['standard', 'blitz', 'onslaught', 'rotator'] as const;
export type GameMode = (typeof GAME_MODES)[number];

export interface SaveData {
  bestScore: number;
  bestWave: number;
  sensitivity: number;
  volume: number;
  mode: GameMode;
}

export const DEFAULT_SAVE: SaveData = {
  bestScore: 0,
  bestWave: 0,
  sensitivity: 1,
  volume: 0.42,
  mode: 'standard',
};

const finite = (v: unknown, def: number): number =>
  typeof v === 'number' && Number.isFinite(v) ? v : def;

const isGameMode = (v: unknown): v is GameMode =>
  typeof v === 'string' && GAME_MODES.some((mode) => mode === v);

/** Tiny persistence layer for settings and personal records.
 * Every field is validated: finite numbers, clamped ranges, allowlisted mode —
 * a tampered localStorage can't inject NaN/Infinity or HTML into innerHTML sinks. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SAVE };
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return { ...DEFAULT_SAVE };
    const p = parsed as Record<string, unknown>;
    const out = { ...DEFAULT_SAVE };
    out.bestScore = clamp(Math.floor(finite(p.bestScore, 0)), 0, 1e9);
    out.bestWave = clamp(Math.floor(finite(p.bestWave, 0)), 0, 9999);
    out.sensitivity = clamp(finite(p.sensitivity, DEFAULT_SAVE.sensitivity), 0.2, 3);
    out.volume = clamp(finite(p.volume, DEFAULT_SAVE.volume), 0, 1);
    out.mode = isGameMode(p.mode) ? p.mode : DEFAULT_SAVE.mode;
    return out;
  } catch {
    return { ...DEFAULT_SAVE };
  }
}

export function persistSave(data: SaveData): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — settings just won't persist */
  }
}
