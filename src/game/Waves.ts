import * as THREE from 'three';
import type { EnemyKind, EnemyManager } from '../enemies/Enemies';
import type { World } from '../world/World';
import type { GameMode } from '../core/storage';

export type WavePhase = 'intermission' | 'spawning' | 'combat' | 'cleared';

interface SpawnEntry {
  kind: EnemyKind;
  delay: number;
}

interface ModeConfig {
  intermissionSeconds: number;
  spawnDelayMultiplier: number;
  countMultiplier: number;
  countBonus: number;
  scoreMultiplier: number;
  gunnerFromWave: number;
  wardenFromWave: number;
  rotatesWeapon: boolean;
  /** Endless horde: no cleared screen, escalating HP/spawn curve. */
  endless: boolean;
}

const ENDLESS_ALIVE_CAP = 24;

const MODES: Record<GameMode, ModeConfig> = {
  standard: { intermissionSeconds: 6, spawnDelayMultiplier: 1, countMultiplier: 1, countBonus: 0, scoreMultiplier: 1, gunnerFromWave: 3, wardenFromWave: 4, rotatesWeapon: false, endless: false },
  blitz: { intermissionSeconds: 3.5, spawnDelayMultiplier: 0.55, countMultiplier: 1.15, countBonus: 1, scoreMultiplier: 1.35, gunnerFromWave: 3, wardenFromWave: 3, rotatesWeapon: false, endless: false },
  onslaught: { intermissionSeconds: 5, spawnDelayMultiplier: 0.8, countMultiplier: 1.5, countBonus: 2, scoreMultiplier: 1.75, gunnerFromWave: 2, wardenFromWave: 2, rotatesWeapon: false, endless: false },
  rotator: { intermissionSeconds: 5, spawnDelayMultiplier: 0.85, countMultiplier: 1.1, countBonus: 0, scoreMultiplier: 1.5, gunnerFromWave: 3, wardenFromWave: 3, rotatesWeapon: true, endless: false },
  overrun: { intermissionSeconds: 2, spawnDelayMultiplier: 1, countMultiplier: 1, countBonus: 1, scoreMultiplier: 1.5, gunnerFromWave: 3, wardenFromWave: 3, rotatesWeapon: false, endless: true },
};

export class WaveManager {
  public wave = 0;
  /** Waves fully cleared — what "waves survived" on the death card reports. */
  public cleared = 0;
  public phase: WavePhase = 'intermission';
  public timer = 3;
  public onWaveStart: ((wave: number) => void) | null = null;
  public onWaveClear: ((wave: number) => void) | null = null;

  private mode: GameMode = 'standard';
  private queue: SpawnEntry[] = [];
  private spawnTimer = 0;

  public constructor(
    private readonly enemies: EnemyManager,
    private readonly world: World,
  ) {}

  public setMode(mode: GameMode): void {
    this.mode = mode;
  }

  /** Score multiplier for the active mode (kill points + wave bonus). */
  public get scoreMult(): number {
    return MODES[this.mode].scoreMultiplier;
  }

  /** Gun-game mode: weapon rotates on every kill. */
  public get isRotator(): boolean {
    return MODES[this.mode].rotatesWeapon;
  }

  /** Endless modes ramp enemy HP; the player's damage ramps to match so a
   *  fixed ammo pool cannot become a hard wall. Returns 1 for finite modes. */
  public get damageScale(): number {
    return MODES[this.mode].endless
      ? Math.min(40, Math.pow(1.12, Math.max(0, this.wave - 1)))
      : 1;
  }

  private config(): ModeConfig {
    return MODES[this.mode];
  }

  public reset(): void {
    this.wave = 0;
    this.cleared = 0;
    this.phase = 'intermission';
    // First wave after DEPLOY always starts briskly (3 s); between-wave breaks
    // use the mode's own intermissionSeconds.
    this.timer = Math.min(3, this.config().intermissionSeconds);
    this.queue = [];
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
            const hpMul = config.endless
              ? Math.min(40, Math.pow(1.12, this.wave - 1))
              : Math.min(2.2, 1 + 0.06 * (this.wave - 1));
            const spdMul = config.endless
              ? Math.min(1.3, 1 + 0.02 * Math.min(this.wave, 15))
              : Math.min(1.32, 1 + 0.018 * (this.wave - 1));
            const atkMul = config.endless
              ? 1
              : Math.max(0.72, 1 - 0.015 * (this.wave - 1));
            this.enemies.spawn(entry.kind, point, hpMul, spdMul, atkMul);
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
    this.queue = this.buildWave(this.wave);
    this.phase = 'spawning';
    this.spawnTimer = 0.2;
    this.onWaveStart?.(this.wave);
  }

  private buildWave(wave: number): SpawnEntry[] {
    const entries: SpawnEntry[] = [];
    const config = this.config();
    const grunts = Math.round((3 + wave * 1.2) * config.countMultiplier) + config.countBonus;
    const rushers = wave >= 2 ? Math.round(wave * 0.8 * config.countMultiplier) : 0;
    const gunners = wave >= config.gunnerFromWave ? Math.round((wave - 1) * 0.6 * config.countMultiplier) : 0;
    const wardens = wave > 1 && wave >= config.wardenFromWave
      ? Math.min(2, 1 + Math.floor((wave - config.wardenFromWave) / 3))
      : 0;
    for (let i = 0; i < grunts; i++) entries.push({ kind: 'grunt', delay: 0.5 * config.spawnDelayMultiplier });
    for (let i = 0; i < rushers; i++) entries.push({ kind: 'rusher', delay: 0.4 * config.spawnDelayMultiplier });
    for (let i = 0; i < gunners; i++) entries.push({ kind: 'gunner', delay: 0.8 * config.spawnDelayMultiplier });
    for (let i = 0; i < wardens; i++) entries.push({ kind: 'warden', delay: 1.0 * config.spawnDelayMultiplier });
    // Shuffle
    for (let i = entries.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
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
    const chosen = top[Math.floor(Math.random() * top.length)] ?? new THREE.Vector3(20, 0, 20);
    return chosen.clone();
  }
}
