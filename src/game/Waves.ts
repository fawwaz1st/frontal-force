import * as THREE from 'three';
import type { EnemyKind, EnemyManager } from '../enemies/Enemies';
import type { World } from '../world/World';

export type WavePhase = 'intermission' | 'spawning' | 'combat' | 'cleared';

interface SpawnEntry {
  kind: EnemyKind;
  delay: number;
}

const INTERMISSION_TIME = 6;

export class WaveManager {
  public wave = 0;
  public phase: WavePhase = 'intermission';
  public timer = 3;
  public onWaveStart: ((wave: number) => void) | null = null;
  public onWaveClear: ((wave: number) => void) | null = null;

  private queue: SpawnEntry[] = [];
  private spawnTimer = 0;

  public constructor(
    private readonly enemies: EnemyManager,
    private readonly world: World,
  ) {}

  public reset(): void {
    this.wave = 0;
    this.phase = 'intermission';
    this.timer = 3;
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
          const entry = this.queue.shift();
          if (entry) {
            const point = this.pickSpawnPoint(playerPos);
            this.enemies.spawn(entry.kind, point);
            this.spawnTimer = entry.delay;
          }
        }
        if (this.queue.length === 0) this.phase = 'combat';
        break;
      case 'combat':
        if (this.enemies.aliveCount === 0) {
          this.phase = 'cleared';
          this.timer = 1.2;
          this.onWaveClear?.(this.wave);
        }
        break;
      case 'cleared':
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'intermission';
          this.timer = INTERMISSION_TIME;
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
    const grunts = 3 + Math.floor(wave * 1.2);
    const rushers = wave >= 2 ? Math.floor(wave * 0.8) : 0;
    const gunners = wave >= 3 ? Math.floor((wave - 1) * 0.6) : 0;
    for (let i = 0; i < grunts; i++) entries.push({ kind: 'grunt', delay: 0.5 });
    for (let i = 0; i < rushers; i++) entries.push({ kind: 'rusher', delay: 0.4 });
    for (let i = 0; i < gunners; i++) entries.push({ kind: 'gunner', delay: 0.8 });
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
