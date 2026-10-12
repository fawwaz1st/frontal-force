/**
 * Arena themes. Every run picks one from its seed, so two players on the same
 * seed still fight on the same map, and the map itself is part of the seed
 * code the way the layout and the spawn order already are.
 *
 * A theme only changes things that cannot invalidate what the player has
 * learned: palette, sky, fog, light, and cover DENSITY. Cover PLACEMENT stays
 * seeded the same way for all themes, so a theme is never unfair, only
 * different to look at and differently crowded.
 *
 * Adding a theme is adding one object to this array. Nothing else in the
 * codebase needs to know about it.
 */

export interface MapTheme {
  /** Stable id, used in the seed readout and the HUD. */
  readonly id: string;
  /** Short name shown on the HUD and the debrief board. */
  readonly name: string;
  /** One-line description of the place. */
  readonly tagline: string;
  /** Floor: base material colour plus the texture's own palette. */
  readonly floor: {
    readonly color: number;
    readonly base: string;
    readonly light: string;
    readonly dark: string;
    readonly line: string;
    readonly grit: number;
    readonly repeat: number;
  };
  /** Wall body and coping. */
  readonly wall: { readonly body: number; readonly cap: number };
  /** Sky gradient, top to bottom. */
  readonly sky: readonly string[];
  /** Fog colour and its base density (before a wave mutation scales it). */
  readonly fog: { readonly color: number; readonly density: number };
  /** Key light colour and the ambient pair (sky, ground). */
  readonly light: {
    readonly sun: number;
    readonly sunIntensity: number;
    readonly sky: number;
    readonly ground: number;
    readonly ambientIntensity: number;
  };
  /** Cover palette: crate body, dark trim, and the emissive glow accent. */
  readonly cover: {
    readonly crate: number;
    readonly dark: number;
    readonly glow: number;
  };
  /** Cover density multiplier (1 = the original layout). */
  readonly density: number;
  /** Floating dust colour. */
  readonly dust: number;
}

export const MAPS: readonly MapTheme[] = [
  {
    id: 'dawn-range',
    name: 'DAWN RANGE',
    tagline: 'cold light, long shadows',
    floor: {
      color: 0xbfb8a3,
      base: '#55564f',
      light: 'rgba(151,145,124,0.12)',
      dark: 'rgba(24,30,30,0.34)',
      line: 'rgba(20,22,20,0.42)',
      grit: 110,
      repeat: 14,
    },
    wall: { body: 0x817967, cap: 0x494a42 },
    sky: ['#485760', '#788084', '#b0a58e', '#8d8978', '#363b35'],
    fog: { color: 0x6d6f66, density: 0.0042 },
    light: {
      sun: 0xffe0b0, sunIntensity: 1.75,
      sky: 0xa8b0ad, ground: 0x24261f, ambientIntensity: 1.05,
    },
    cover: { crate: 0x24304c, dark: 0x141c2e, glow: 0xff7a33 },
    density: 1,
    dust: 0xc5b18a,
  },
  {
    id: 'night-yard',
    name: 'NIGHT YARD',
    tagline: 'dark, tight, lit by work lamps',
    floor: {
      color: 0x5f6a72,
      base: '#2a3138',
      light: 'rgba(120,150,168,0.16)',
      dark: 'rgba(6,10,14,0.46)',
      line: 'rgba(10,14,18,0.5)',
      grit: 90,
      repeat: 16,
    },
    wall: { body: 0x39434c, cap: 0x1d2429 },
    sky: ['#050810', '#0a1020', '#141c2e', '#0c111c', '#04060b'],
    fog: { color: 0x080d16, density: 0.0072 },
    // The dark map still has to be PLAYABLE: a night that hides the enemies is
    // not atmosphere, it is a bug. Ambient stays high enough that a silhouette
    // reads against the floor, and the sun acts as a cold moon rather than
    // being switched off.
    light: {
      sun: 0x9fb6d8, sunIntensity: 1.15,
      sky: 0x6f8496, ground: 0x161a20, ambientIntensity: 0.95,
    },
    cover: { crate: 0x2c3a4e, dark: 0x161d29, glow: 0x7ce7ff },
    density: 1.15,
    dust: 0x8fb4c8,
  },
  {
    id: 'rust-works',
    name: 'RUST WORKS',
    tagline: 'hot haze over dead machinery',
    floor: {
      color: 0xa8815f,
      base: '#5c4433',
      light: 'rgba(198,150,104,0.16)',
      dark: 'rgba(30,18,12,0.4)',
      line: 'rgba(26,16,10,0.46)',
      grit: 130,
      repeat: 12,
    },
    wall: { body: 0x6b4a35, cap: 0x3a2820 },
    sky: ['#6b4a3a', '#a4674a', '#d99b5f', '#c07a45', '#4a2f22'],
    fog: { color: 0x8a5a3c, density: 0.0062 },
    light: {
      sun: 0xffb066, sunIntensity: 2.1,
      sky: 0xd9a172, ground: 0x2a1a12, ambientIntensity: 0.95,
    },
    cover: { crate: 0x4a3527, dark: 0x241812, glow: 0xffd76b },
    density: 1.3,
    dust: 0xd9a172,
  },
  {
    id: 'frost-line',
    name: 'FROST LINE',
    tagline: 'white ground, blue air, no cover for free',
    floor: {
      color: 0xdfe6ec,
      base: '#8d99a4',
      light: 'rgba(236,244,250,0.3)',
      dark: 'rgba(60,78,96,0.3)',
      line: 'rgba(48,62,76,0.34)',
      grit: 70,
      repeat: 18,
    },
    wall: { body: 0x8e9aa6, cap: 0x5a6672 },
    sky: ['#8fb3d4', '#b6cfe4', '#dfe9f0', '#c6d5e0', '#7d8f9e'],
    fog: { color: 0xc3d3de, density: 0.0058 },
    light: {
      sun: 0xf2f8ff, sunIntensity: 2.15,
      sky: 0xdbe8f2, ground: 0x5a6672, ambientIntensity: 1.35,
    },
    cover: { crate: 0x516070, dark: 0x2c3640, glow: 0x9ff0d8 },
    density: 0.78,
    dust: 0xf0f6fa,
  },
];

/** Resolve a theme from a run seed. Deterministic and shareable. */
export function mapForSeed(seed: number): number {
  // A cheap avalanche, so consecutive seeds do not walk the theme list in
  // order: seed 1, 2, 3 must not be map 1, 2, 3 or players will think the
  // rotation is just "next".
  let h = seed >>> 0;
  h ^= h >>> 16;
  h = Math.imul(h, 0x7feb352d);
  h ^= h >>> 15;
  h = Math.imul(h, 0x846ca68b);
  h ^= h >>> 16;
  // CRITICAL: `^` and `Math.imul` produce a SIGNED 32-bit int, so `h` can be
  // negative here. A negative modulo would index MAPS[-1] and hand back
  // undefined, which took the whole arena down on the first rebuild.
  h >>>= 0;
  return h % MAPS.length;
}
