/**
 * Deterministic PRNG (mulberry32).
 *
 * Every source of run randomness (spawn jitter, draft offers, affix rolls,
 * arena mutation picks) routes through one of these so a seed string fully
 * reproduces a run. That is what makes daily challenges and shareable seeds
 * honest: two players on the same seed see the same enemies, in the same
 * order, with the same card offers.
 *
 * Cosmetic randomness (particle jitter, audio detune) deliberately stays on
 * `Math.random()` — it must never consume from the run stream, or adding a
 * sparkle effect would change the run.
 */
export class Rng {
  private state: number;

  public constructor(seed: number) {
    // Force to uint32; 0 is a valid mulberry32 state.
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  public next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Uniform in [min, max). */
  public range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** Integer in [min, max] inclusive. */
  public int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability `p`. */
  public chance(p: number): boolean {
    return this.next() < p;
  }

  /** Uniform pick; returns `undefined` only for an empty array. */
  public pick<T>(items: readonly T[]): T | undefined {
    if (items.length === 0) return undefined;
    return items[Math.min(items.length - 1, Math.floor(this.next() * items.length))];
  }

  /** In-place Fisher-Yates shuffle. */
  public shuffle<T>(items: T[]): T[] {
    for (let i = items.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      const a = items[i];
      const b = items[j];
      if (a !== undefined && b !== undefined) {
        items[i] = b;
        items[j] = a;
      }
    }
    return items;
  }

  /** Weighted pick — `weight` must be non-negative. */
  public weighted<T>(items: readonly T[], weight: (item: T) => number): T | undefined {
    let total = 0;
    for (const item of items) total += Math.max(0, weight(item));
    if (total <= 0) return this.pick(items);
    let roll = this.next() * total;
    for (const item of items) {
      roll -= Math.max(0, weight(item));
      if (roll <= 0) return item;
    }
    return items[items.length - 1];
  }

  /** Fork a child stream — keeps sub-systems from perturbing each other. */
  public fork(): Rng {
    return new Rng(Math.floor(this.next() * 4294967296));
  }
}

/** Hash an arbitrary string into a uint32 seed (FNV-1a). */
export function hashSeed(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Today's daily seed. Everyone who plays on the same UTC date gets the same
 * run. The `31337` multiplier is the widely used roguelike convention and
 * keeps consecutive days from producing correlated streams.
 */
export function dailySeed(date = new Date()): number {
  const y = date.getUTCFullYear();
  const m = date.getUTCMonth() + 1;
  const d = date.getUTCDate();
  return (((y * 10000 + m * 100 + d) * 31337) >>> 0);
}

const SEED_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** Render a uint32 as an 8-character shareable seed code (no look-alikes). */
export function seedToCode(seed: number): string {
  let out = '';
  let v = seed >>> 0;
  for (let i = 0; i < 8; i++) {
    out += SEED_ALPHABET[v % SEED_ALPHABET.length] ?? 'A';
    v = Math.floor(v / SEED_ALPHABET.length);
  }
  return out;
}

/** Parse a shareable seed code back to a uint32; falls back to hashing. */
export function codeToSeed(code: string): number {
  const clean = code.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length === 0) return 0;
  let v = 0;
  let ok = true;
  for (const ch of clean) {
    const idx = SEED_ALPHABET.indexOf(ch);
    if (idx < 0) {
      ok = false;
      break;
    }
    v = v * SEED_ALPHABET.length + idx;
  }
  if (ok && v <= 0xffffffff) return v >>> 0;
  return hashSeed(clean);
}
