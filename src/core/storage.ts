import { clamp } from './math';

const KEY = 'frontal-force.v1';

export interface SaveData {
  bestScore: number;
  bestWave: number;
  sensitivity: number;
  volume: number;
}

export const DEFAULT_SAVE: SaveData = {
  bestScore: 0,
  bestWave: 0,
  sensitivity: 1,
  volume: 0.42,
};

/** Tiny persistence layer for settings and personal records. */
export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...DEFAULT_SAVE };
    const parsed = JSON.parse(raw) as Partial<SaveData>;
    const out = { ...DEFAULT_SAVE };
    if (typeof parsed.bestScore === 'number') out.bestScore = parsed.bestScore;
    if (typeof parsed.bestWave === 'number') out.bestWave = parsed.bestWave;
    if (typeof parsed.sensitivity === 'number') out.sensitivity = clamp(parsed.sensitivity, 0.2, 3);
    if (typeof parsed.volume === 'number') out.volume = clamp(parsed.volume, 0, 1);
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
