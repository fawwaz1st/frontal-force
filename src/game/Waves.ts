import * as THREE from 'three';
import type { EnemyKind, EnemyManager } from '../ai/Enemies';
import type { World } from '../world/World';
import type { GameMode } from '../core/storage';
import type { Rng } from '../core/rng';

export type WavePhase = 'intermission' | 'spawning' | 'combat' | 'cleared';

interface SpawnEntry {
  kind: EnemyKind;
  delay: number;
  /** True when this entry is the wave boss (announced, never randomised away). */
  boss?: boolean;
}

interface ModeConfig {
  intermissionSeconds: number;
  spawnDelayMultiplier: number;
  countMultiplier: number;
  countBonus: number;
  scoreMultiplier: number;
  gunnerFromWave: number;
  wardenFromWave: number;
  sniperFromWave: number;
  flyerFromWave: number;
  exploderFromWave: number;
  healerFromWave: number;
  summonerFromWave: number;
  rotatesWeapon: boolean;
  /** Endless horde: no cleared screen, escalating HP/spawn curve. */
  endless: boolean;
}

const ENDLESS_ALIVE_CAP = 24;
/** A boss wave is every N waves in every mode. */
const BOSS_EVERY = 5;

const MODES: Record<GameMode, ModeConfig> = {
  standard: {
    intermissionSeconds: 6, spawnDelayMultiplier: 1, countMultiplier: 1, countBonus: 0,
    scoreMultiplier: 1, gunnerFromWave: 3, wardenFromWave: 4,
    sniperFromWave: 6, flyerFromWave: 5, exploderFromWave: 4, healerFromWave: 7, summonerFromWave: 9,
    rotatesWeapon: false, endless: false,
  },
  blitz: {
    intermissionSeconds: 3.5, spawnDelayMultiplier: 0.55, countMultiplier: 1.15, countBonus: 1,
    scoreMultiplier: 1.35, gunnerFromWave: 3, wardenFromWave: 3,
    sniperFromWave: 5, flyerFromWave: 4, exploderFromWave: 3, healerFromWave: 6, summonerFromWave: 8,
    rotatesWeapon: false, endless: false,
  },
  onslaught: {
    intermissionSeconds: 5, spawnDelayMultiplier: 0.8, countMultiplier: 1.5, countBonus: 2,
    scoreMultiplier: 1.75, gunnerFromWave: 2, wardenFromWave: 2,
    sniperFromWave: 4, flyerFromWave: 3, exploderFromWave: 3, healerFromWave: 5, summonerFromWave: 7,
    rotatesWeapon: false, endless: false,
  },
  rotator: {
    intermissionSeconds: 5, spawnDelayMultiplier: 0.85, countMultiplier: 1.1, countBonus: 0,
    scoreMultiplier: 1.5, gunnerFromWave: 3, wardenFromWave: 3,
    sniperFromWave: 5, flyerFromWave: 4, exploderFromWave: 4, healerFromWave: 6, summonerFromWave: 9,
    rotatesWeapon: true, endless: false,
  },
  overrun: {
    intermissionSeconds: 2, spawnDelayMultiplier: 1, countMultiplier: 1, countBonus: 1,
    scoreMultiplier: 1.5, gunnerFromWave: 3, wardenFromWave: 3,
    sniperFromWave: 5, flyerFromWave: 4, exploderFromWave: 4, healerFromWave: 6, summonerFromWave: 8,
    rotatesWeapon: false, endless: true,
  },
};

/**
 * Arena mutations, applied every `MUTATION_EVERY` waves. Each one changes the
 * LIGHTING or the WEATHER rather than the rules, so it reads as the arena
 * changing around you instead of the game changing under you. Every mutation
 * carries a player-facing benefit as well, which is what stops it reading as a
 * pure penalty.
 */
export type MutationId = 'night' | 'blackout' | 'sandstorm' | 'overgrowth' | 'rain' | 'clear';

export interface MutationDef {
  id: MutationId;
  name: string;
  description: string;
  /** Exponential fog density multiplier. */
  fogMul: number;
  /** Sun (directional light) intensity multiplier. */
  sunMul: number;
  /** Ambient light multiplier. */
  ambientMul: number;
  /** Enemy sight-range multiplier: below 1 makes stealth easier. */
  sightMul: number;
  /** Score multiplier while the mutation is active. */
  scoreMul: number;
}

export const MUTATIONS: Record<MutationId, MutationDef> = {
  clear: {
    id: 'clear', name: 'Clear Skies', description: 'Standard visibility.',
    fogMul: 1, sunMul: 1, ambientMul: 1, sightMul: 1, scoreMul: 1,
  },
  night: {
    id: 'night', name: 'Nightfall', description: 'Darker arena. Enemies see 30% less far. +10% score.',
    fogMul: 1.35, sunMul: 0.35, ambientMul: 0.55, sightMul: 0.7, scoreMul: 1.1,
  },
  blackout: {
    id: 'blackout', name: 'Blackout', description: 'Lights out. Muzzle flash is your only light. +20% score.',
    fogMul: 1.5, sunMul: 0.12, ambientMul: 0.22, sightMul: 0.65, scoreMul: 1.2,
  },
  sandstorm: {
    id: 'sandstorm', name: 'Sandstorm', description: 'Dense haze. Enemies see 45% less far. +25% score.',
    fogMul: 2.6, sunMul: 0.7, ambientMul: 0.9, sightMul: 0.55, scoreMul: 1.25,
  },
  overgrowth: {
    id: 'overgrowth', name: 'Overgrowth', description: 'Cover regrows faster. +10% score.',
    fogMul: 1, sunMul: 0.95, ambientMul: 1, sightMul: 1, scoreMul: 1.1,
  },
  rain: {
    id: 'rain', name: 'Downpour', description: 'Wet ground, heavier haze. Enemies see 20% less far. +15% score.',
    fogMul: 1.7, sunMul: 0.6, ambientMul: 0.85, sightMul: 0.8, scoreMul: 1.15,
  },
};

/** Waves between arena mutations. */
const MUTATION_EVERY = 4;
/** Mutations that can be rolled (clear is the "no mutation" baseline). */
const ROLLABLE: readonly MutationId[] = ['night', 'blackout', 'sandstorm', 'overgrowth', 'rain'];

export class WaveManager {
  public wave = 0;
  /** Waves fully cleared — what "waves survived" on the death card reports. */
  public cleared = 0;
  public phase: WavePhase = 'intermission';
  public timer = 3;
  public onWaveStart: ((wave: number) => void) | null = null;
  public onWaveClear: ((wave: number) => void) | null = null;
  /** Fired when the arena mutation changes (wave start, every 4th wave). */
  public onMutation: ((def: MutationDef) => void) | null = null;
  /** Fired when a boss wave begins, so the HUD can announce it. */
  public onBoss: ((name: string) => void) | null = null;

  private mode: GameMode = 'standard';
  private queue: SpawnEntry[] = [];
  private spawnTimer = 0;
  private mutation: MutationDef = MUTATIONS.clear;
  /** Enemy count multiplier contributed by the run's curse cards. */
  private curseCountMul = 1;
  private curseHpMul = 1;
  /** Opt-in challenge modifiers (see game/Challenges.ts). Identity by default. */
  private challengeCountMul = 1;
  private challengeHpMul = 1;
  private challengeSpeedMul = 1;
  private challengeExtraAffixes = 0;
  /** Deterministic stream: spawn order and mutation picks must be reproducible. */
  private rng: Rng | null = null;

  public constructor(
    private readonly enemies: EnemyManager,
    private readonly world: World,
  ) {}

  public setMode(mode: GameMode): void {
    this.mode = mode;
  }

  /** Adopt the run's seeded stream. Without this, waves use Math.random and a
   *  shared seed would not reproduce. */
  public setRng(rng: Rng): void {
    this.rng = rng;
  }

  /** Curse cards raise enemy count and health, and pay for it in score. */
  public setCurse(countMul: number, hpMul: number): void {
    this.curseCountMul = Math.max(1, countMul);
    this.curseHpMul = Math.max(1, hpMul);
  }

  /**
   * Apply the run's challenge modifiers. Separate from setCurse because the
   * two stack: a curse card taken mid-run and a challenge picked in the menu
   * must both be reflected, and clearing one must not clear the other.
   */
  public setChallenges(
    countMul: number,
    hpMul: number,
    speedMul: number,
    extraAffixes = 0,
  ): void {
    this.challengeCountMul = Math.max(0.1, countMul);
    this.challengeHpMul = Math.max(0.1, hpMul);
    this.challengeSpeedMul = Math.max(0.1, speedMul);
    this.challengeExtraAffixes = Math.max(0, Math.floor(extraAffixes));
  }

  /** Score multiplier for the active mode (kill points + wave bonus). */
  public get scoreMult(): number {
    return MODES[this.mode].scoreMultiplier * this.mutation.scoreMul;
  }

  /** Gun-game mode: weapon rotates on every kill. */
  public get isRotator(): boolean {
    return MODES[this.mode].rotatesWeapon;
  }

  /** The live arena mutation, for the HUD legend and the World fog pass. */
  public get activeMutation(): MutationDef {
    return this.mutation;
  }

  /** Enemy sight multiplier from the mutation (AI reads this). */
  public get sightMul(): number {
    return this.mutation.sightMul;
  }

  /** True when the wave currently running is a boss wave. */
  public get isBossWave(): boolean {
    return this.wave > 0 && this.wave % BOSS_EVERY === 0;
  }

  /** Endless modes ramp enemy HP; the player's damage ramps to match so a
   *  fixed ammo pool cannot become a hard wall. Returns 1 for finite modes. */
  public get damageScale(): number {
    return MODES[this.mode].endless ? WaveManager.hpMul(this.wave) : 1;
  }

  /** Single source of truth for the endless HP curve — enemy health and the
   *  player's damage multiplier MUST stay in lockstep or the mode walls out. */
  public static hpMul(wave: number): number {
    return Math.min(40, Math.pow(1.12, Math.max(0, wave - 1)));
  }

  private config(): ModeConfig {
    return MODES[this.mode];
  }

  private random(): number {
    return this.rng ? this.rng.next() : Math.random();
  }

  public reset(): void {
    this.wave = 0;
    this.cleared = 0;
    this.phase = 'intermission';
    // First wave after DEPLOY always starts briskly (3 s); between-wave breaks
    // use the mode's own intermissionSeconds.
    this.timer = Math.min(3, this.config().intermissionSeconds);
    this.queue = [];
    this.mutation = MUTATIONS.clear;
  }

  public update(dt: number, playerPos: THREE.Vector3): void {
    switch (this.phase) {
      case 'intermission':
        this.timer -= dt;
        if (this.timer <= 0) this.startWave();
        break;
      case 'spawning':
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0 && this.queue.length > 0) {
          const config = this.config();
          if (config.endless && this.enemies.aliveCount >= ENDLESS_ALIVE_CAP) {
            this.spawnTimer = 0.3; // hold the wave until attrition frees slots
            break;
          }
          const entry = this.queue.shift();
          if (entry) {
            const point = this.pickSpawnPoint(playerPos);
            // Finite ramp: health +6%/wave (cap 2.2x), speed +1.8%/wave (cap
            // 1.32x), attack cadence -1.5%/wave (floor 0.72x). Endless ramps:
            // HP 1.12^(wave-1) capped 40x, speed capped 1.30x (flat fire rate).
            // Curse multiplies on top of both.
            const hpMul = (config.endless
              ? WaveManager.hpMul(this.wave)
              : Math.min(2.2, 1 + 0.06 * (this.wave - 1))) *
              this.curseHpMul * this.challengeHpMul;
            const spdMul = (config.endless
              ? Math.min(1.3, 1 + 0.02 * Math.min(this.wave, 15))
              : Math.min(1.32, 1 + 0.018 * (this.wave - 1))) * this.challengeSpeedMul;
            const atkMul = config.endless
              ? 1
              : Math.max(0.72, 1 - 0.015 * (this.wave - 1));
            this.enemies.spawn(
              entry.kind,
              point,
              hpMul,
              spdMul,
              atkMul,
              this.wave,
              true,
              this.challengeExtraAffixes,
            );
            if (entry.boss) this.onBoss?.(BOSS_NAME);
            this.spawnTimer = config.endless
              ? Math.min(entry.delay, Math.max(0.25, Math.pow(0.94, this.wave - 1)))
              : entry.delay;
          }
        }
        if (this.queue.length === 0) this.phase = 'combat';
        break;
      case 'combat':
        if (this.enemies.aliveCount === 0) {
          this.cleared += 1;
          this.onWaveClear?.(this.wave);
          if (this.config().endless) {
            // Endless: no lingering CLEARED plate — straight back into it.
            this.phase = 'intermission';
            this.timer = this.config().intermissionSeconds;
          } else {
            this.phase = 'cleared';
            this.timer = 1.2;
          }
        }
        break;
      case 'cleared':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'intermission';
          this.timer = this.config().intermissionSeconds;
        }
        break;
    }
  }

  private startWave(): void {
    this.wave += 1;
    this.rollMutation();
    this.queue = this.buildWave(this.wave);
    this.phase = 'spawning';
    this.spawnTimer = 0.2;
    this.onWaveStart?.(this.wave);
  }

  /** Pick a new arena mutation every MUTATION_EVERY waves. Never repeats the
   *  current one, so the change is always visible. */
  private rollMutation(): void {
    if (this.wave <= 1 || this.wave % MUTATION_EVERY !== 1) return;
    const options = ROLLABLE.filter((id) => id !== this.mutation.id);
    const next = options[Math.floor(this.random() * options.length)] ?? 'night';
    this.mutation = MUTATIONS[next];
    this.onMutation?.(this.mutation);
  }

  private buildWave(wave: number): SpawnEntry[] {
    const entries: SpawnEntry[] = [];
    const config = this.config();
    const countMul = config.countMultiplier * this.curseCountMul * this.challengeCountMul;
    const grunts = Math.round((3 + wave * 1.2) * countMul) + config.countBonus;
    const rushers = wave >= 2 ? Math.round(wave * 0.8 * countMul) : 0;
    const gunners = wave >= config.gunnerFromWave ? Math.round((wave - 1) * 0.6 * countMul) : 0;
    const wardens = wave > 1 && wave >= config.wardenFromWave
      ? Math.min(2, 1 + Math.floor((wave - config.wardenFromWave) / 3))
      : 0;
    // New archetypes ramp in one at a time, and never in numbers that would
    // let a single mechanic dominate a wave. Each cap is deliberately low.
    const snipers = wave >= config.sniperFromWave
      ? Math.min(3, 1 + Math.floor((wave - config.sniperFromWave) / 3))
      : 0;
    const flyers = wave >= config.flyerFromWave
      ? Math.min(5, 1 + Math.floor((wave - config.flyerFromWave) / 2))
      : 0;
    const exploders = wave >= config.exploderFromWave
      ? Math.min(4, 1 + Math.floor((wave - config.exploderFromWave) / 3))
      : 0;
    const healers = wave >= config.healerFromWave
      ? Math.min(2, 1 + Math.floor((wave - config.healerFromWave) / 4))
      : 0;
    const summoners = wave >= config.summonerFromWave
      ? Math.min(2, 1 + Math.floor((wave - config.summonerFromWave) / 5))
      : 0;

    for (let i = 0; i < grunts; i++) entries.push({ kind: 'grunt', delay: 0.5 * config.spawnDelayMultiplier });
    for (let i = 0; i < rushers; i++) entries.push({ kind: 'rusher', delay: 0.4 * config.spawnDelayMultiplier });
    for (let i = 0; i < gunners; i++) entries.push({ kind: 'gunner', delay: 0.8 * config.spawnDelayMultiplier });
    for (let i = 0; i < wardens; i++) entries.push({ kind: 'warden', delay: 1.0 * config.spawnDelayMultiplier });
    for (let i = 0; i < snipers; i++) entries.push({ kind: 'sniper', delay: 1.2 * config.spawnDelayMultiplier });
    for (let i = 0; i < flyers; i++) entries.push({ kind: 'flyer', delay: 0.6 * config.spawnDelayMultiplier });
    for (let i = 0; i < exploders; i++) entries.push({ kind: 'exploder', delay: 0.7 * config.spawnDelayMultiplier });
    for (let i = 0; i < healers; i++) entries.push({ kind: 'healer', delay: 1.4 * config.spawnDelayMultiplier });
    for (let i = 0; i < summoners; i++) entries.push({ kind: 'summoner', delay: 1.6 * config.spawnDelayMultiplier });

    // Boss waves: exactly one Warden Prime, appended last so it walks in after
    // the escort has already engaged (a boss arriving alone is less readable).
    if (wave % BOSS_EVERY === 0) {
      entries.push({ kind: 'wardenPrime', delay: 2.0, boss: true });
    }

    // Fisher-Yates with the run stream so a shared seed reproduces the order.
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(this.random() * (i + 1));
      const a = entries[i];
      const b = entries[j];
      if (a && b) {
        entries[i] = b;
        entries[j] = a;
      }
    }
    return entries;
  }

  private pickSpawnPoint(playerPos: THREE.Vector3): THREE.Vector3 {
    // Prefer spawn points far from the player
    const points = [...this.world.spawnPoints].sort(
      (a, b) => b.distanceToSquared(playerPos) - a.distanceToSquared(playerPos),
    );
    const top = points.slice(0, Math.max(3, Math.floor(points.length / 2)));
    const chosen = top[Math.floor(this.random() * top.length)] ?? new THREE.Vector3(20, 0, 20);
    return chosen.clone();
  }
}

/** Display name for the boss wave announcement. */
export const BOSS_NAME = 'WARDEN PRIME';
