import * as THREE from 'three';
import { GameLoop } from '../core/loop';
import { Input } from '../input/Input';
import { GameAudio } from '../audio/Audio';
import { World } from '../world/World';
import { Player } from '../player/Player';
import { Effects } from '../combat/Effects';
import { EnemyManager, type Enemy } from '../enemies/Enemies';
import { WeaponController } from '../combat/WeaponController';
import { Pickups } from '../items/Pickups';
import { WaveManager } from './Waves';
import { Hud, type RadarBlip } from '../ui/Hud';
import { loadSave, persistSave, type SaveData } from '../core/storage';
import { clamp } from '../core/math';

type GamePhase = 'menu' | 'playing' | 'paused' | 'dead';

export class Game {
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly input = new Input();
  private readonly audio = new GameAudio();
  private readonly world = new World();
  private readonly player: Player;
  private readonly effects: Effects;
  private readonly enemies: EnemyManager;
  private readonly weapons: WeaponController;
  private readonly pickups: Pickups;
  private readonly waves: WaveManager;
  private readonly hud = new Hud();
  private readonly loop: GameLoop;
  private readonly save: SaveData;

  private phase: GamePhase = 'menu';
  private score = 0;
  private kills = 0;
  private lastRecorded = false;
  private readonly radarBlips: RadarBlip[] = [];

  public constructor(private readonly container: HTMLElement) {
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    container.appendChild(this.renderer.domElement);
    container.appendChild(this.hud.root);

    this.scene.background = new THREE.Color(0x060a14);
    this.scene.fog = new THREE.FogExp2(0x060a14, 0.016);

    this.save = loadSave();
    this.audio.setVolume(this.save.volume);

    this.world.build(this.scene);
    this.player = new Player(this.world.octree);
    this.player.setSensitivity(this.save.sensitivity);
    this.scene.add(this.player.camera);
    this.effects = new Effects(this.scene);
    this.enemies = new EnemyManager(this.scene, this.world.octree, this.effects, this.audio);
    this.weapons = new WeaponController(this.player, this.enemies, this.world, this.effects, this.audio, (kind) => {
      this.hud.hitmarkerFlash(kind === 'headshot' ? 'headshot' : 'hit');
      this.audio.hitmarker();
    });
    this.pickups = new Pickups(this.scene, this.audio);
    this.waves = new WaveManager(this.enemies, this.world);

    // Wiring: one direction, explicit
    this.enemies.onEnemyKilled = this.handleKill;
    this.enemies.onPlayerHit = this.handlePlayerHit;
    this.player.onDamaged = (from) => {
      this.hud.damageFlash();
      if (from) this.hud.damageFrom(this.damageAngle(from));
    };
    this.waves.onWaveStart = (wave) => {
      this.hud.showBanner(`WAVE ${wave}`, 'Hostiles inbound');
      this.audio.waveStart();
    };
    this.waves.onWaveClear = (wave) => {
      this.audio.waveClear();
      this.score += wave * 250;
      this.hud.showBanner('WAVE CLEAR', `+${wave * 250} bonus`);
    };
    this.hud.onStart = () => this.startRun();
    this.hud.onRestart = () => this.startRun();
    this.hud.onResume = () => this.resume();
    this.hud.onQuit = () => this.toMenu();
    this.hud.onSettings = (patch) => this.applySettings(patch);
    this.input.onPauseKey = () => {
      if (this.phase === 'playing') this.pause();
      else if (this.phase === 'paused') this.resume();
    };
    this.input.onLockChange = (locked) => {
      this.hud.setLocked(locked);
      // Esc / focus loss during a run => pause menu (pointer lock also releases
      // automatically on tab switch, so this covers both cases).
      if (!locked && this.phase === 'playing') this.pause();
    };

    this.loop = new GameLoop(this.update, this.render);
    this.input.attach(this.renderer.domElement);
    this.renderer.domElement.addEventListener('click', this.onCanvasClick);
    window.addEventListener('resize', this.onResize);
    this.onResize();

    this.hud.syncSettings(this.save.sensitivity, this.save.volume);
    this.hud.setMenuBest(this.save.bestScore, this.save.bestWave);
    this.resetPlayer();
    this.hud.showMenu(true);
    this.loop.start();
  }

  private onCanvasClick = (): void => {
    this.audio.unlock();
    if (this.phase === 'playing') this.input.requestLock();
  };

  // ---------- Run lifecycle ----------

  private startRun(): void {
    this.audio.unlock();
    this.phase = 'playing';
    this.score = 0;
    this.kills = 0;
    this.lastRecorded = false;
    this.weapons.reset();
    this.enemies.clear();
    this.pickups.clear();
    for (const [i, point] of this.world.pickupPoints.entries()) {
      this.pickups.spawnAt(i % 2 === 0 ? 'health' : 'ammo', point);
    }
    this.resetPlayer();
    this.waves.reset();
    this.hud.showMenu(false);
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.showBanner('DEPLOYED', 'Survive the waves');
    this.input.requestLock();
  }

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.hud.showPause(true);
    this.audio.heartbeat(0);
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.hud.showPause(false);
    this.input.requestLock();
    // Browsers block requestPointerLock briefly after Esc-exit; if the lock
    // doesn't come back, re-pause instead of leaving a lockless "playing" state.
    window.setTimeout(() => {
      if (this.phase === 'playing' && !this.input.lockedNow) this.pause();
    }, 300);
  }

  private toMenu(): void {
    if (this.phase === 'menu') return;
    this.phase = 'menu';
    this.enemies.clear();
    this.pickups.clear();
    this.waves.reset();
    this.resetPlayer();
    this.recordRun();
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.showMenu(true);
    this.hud.setMenuBest(this.save.bestScore, this.save.bestWave);
  }

  private onDeath(): void {
    this.phase = 'dead';
    this.audio.hurt();
    this.audio.heartbeat(0);
    document.exitPointerLock();
    this.recordRun();
    this.hud.showDeath(true, {
      wave: this.waves.wave,
      kills: this.kills,
      score: this.score,
      bestScore: this.save.bestScore,
      isNewRecord: this.lastRecorded,
    });
  }

  private recordRun(): void {
    if (this.lastRecorded || this.score <= 0) return;
    this.lastRecorded = true;
    const isRecord = this.score > this.save.bestScore;
    if (isRecord) this.save.bestScore = this.score;
    if (this.waves.wave > this.save.bestWave) this.save.bestWave = this.waves.wave;
    persistSave(this.save);
  }

  private applySettings(patch: { sensitivity?: number; volume?: number }): void {
    if (patch.sensitivity !== undefined) {
      this.save.sensitivity = clamp(patch.sensitivity, 0.2, 3);
      this.player.setSensitivity(this.save.sensitivity);
    }
    if (patch.volume !== undefined) {
      this.save.volume = clamp(patch.volume, 0, 1);
      this.audio.setVolume(this.save.volume);
    }
    persistSave(this.save);
    this.hud.syncSettings(this.save.sensitivity, this.save.volume);
  }

  private resetPlayer(): void {
    const spawn = this.world.spawnPoints[0] ?? new THREE.Vector3(0, 0, 20);
    const inward = Math.atan2(spawn.x, spawn.z);
    this.player.reset(spawn.clone(), inward);
  }

  // ---------- Frame update ----------

  private update = (dt: number): void => {
    const frame = this.input.read();
    this.world.update(dt);
    this.effects.update(dt, this.player.camera);
    this.pickups.update(dt);

    if (this.phase !== 'playing') {
      // Slow orbit camera on menu/pause/death screens
      const t = performance.now() * 0.0001;
      this.player.camera.position.set(Math.sin(t) * 26, 12, Math.cos(t) * 26);
      this.player.camera.lookAt(0, 1, 0);
      this.hud.update(dt, this.hudState());
      return;
    }

    this.player.update(dt, frame);
    this.weapons.update(frame, dt);
    this.waves.update(dt, this.player.position);
    this.enemies.update(dt, this.player.position, this.player.dead);

    const collected = this.pickups.tryCollect(this.player.position);
    if (collected === 'health') this.player.heal(35);
    if (collected === 'ammo') this.weapons.refillReserve();

    this.audio.heartbeat(this.player.health / this.player.maxHealth);

    if (this.player.dead) {
      this.onDeath();
    }
    this.hud.update(dt, this.hudState());
  };

  // ---------- Combat callbacks ----------

  private handleKill = (enemy: Enemy): void => {
    this.kills += 1;
    this.score += enemy.def.score;
    this.hud.hitmarkerFlash('kill');
  };

  private handlePlayerHit = (damage: number, from: THREE.Vector3): void => {
    this.player.damage(damage, from);
  };

  /** Screen-space-relative angle of an attacker for the damage arc UI. */
  private damageAngle(from: THREE.Vector3): number {
    const dx = from.x - this.player.position.x;
    const dz = from.z - this.player.position.z;
    return Math.atan2(dx, -dz) + this.player.yawAngle;
  }

  // ---------- HUD state ----------

  private hudState() {
    const view = this.weapons.view();
    const weapon = this.weapons.current;
    return {
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      weaponName: view.name,
      mag: view.mag,
      magSize: weapon.def.magSize,
      reserve: view.reserve,
      reloading: view.reloading,
      reloadProgress: view.reloadProgress,
      weaponIndex: view.index,
      weaponCount: view.count,
      wave: Math.max(1, this.waves.wave),
      enemiesLeft: this.enemies.aliveCount,
      phase: this.waves.phase,
      intermission: this.waves.timer,
      score: this.score,
      kills: this.kills,
      bestScore: this.save.bestScore,
      spread: this.crosshairSpread(),
      inGame: this.phase === 'playing',
      radar: this.radarBlips,
    };
  }

  /** Normalized crosshair spread 0..1 from weapon + movement state. */
  private crosshairSpread(): number {
    const weapon = this.weapons.current;
    const moving = this.player.horizontalSpeed > 2 ? 1 : 0;
    const base = moving ? weapon.def.spreadMoving : weapon.def.spread;
    return clamp(base / 0.08, 0, 1);
  }

  /** Build radar blips (enemy positions rotated into player-facing space). */
  private buildRadar(): void {
    const blips = this.radarBlips;
    blips.length = 0;
    const playerX = this.player.position.x;
    const playerZ = this.player.position.z;
    const cy = Math.cos(this.player.yawAngle);
    const sy = Math.sin(this.player.yawAngle);
    this.enemies.forEachLive((enemy) => {
      if (blips.length >= 24) return;
      const dx = enemy.group.position.x - playerX;
      const dz = enemy.group.position.z - playerZ;
      // World -> player-local: rz = forward component, rx = right component
      const rx = dx * cy - dz * sy;
      const rz = -(dx * sy + dz * cy);
      const range = 34;
      const x = clamp(rx / range, -1, 1);
      const z = clamp(rz / range, -1, 1);
      blips.push({ x, z, color: enemy.def.color });
    });
  }

  // ---------- Rendering / resize ----------

  private render = (): void => {
    this.buildRadar();
    this.renderer.render(this.scene, this.player.camera);
  };

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
  };
}
