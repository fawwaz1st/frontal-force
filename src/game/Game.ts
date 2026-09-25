import * as THREE from 'three/webgpu';
import { GameLoop } from '../core/loop';
import { Input, type InputFrame } from '../input/Input';
import { GameAudio } from '../audio/Audio';
import { World } from '../world/World';
import { Player } from '../player/Player';
import { Effects } from '../combat/Effects';
import { EnemyManager, type Enemy } from '../enemies/Enemies';
import { WeaponController } from '../combat/WeaponController';
import { Viewmodel } from '../combat/Viewmodel';
import { Ally } from '../allies/Ally';
import { Pickups } from '../items/Pickups';
import { WaveManager } from './Waves';
import { Hud, type HudState, type RadarBlip, type SettingsPatch } from '../ui/Hud';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadSave, persistSave, type SaveData } from '../core/storage';
import { clamp } from '../core/math';

type GamePhase = 'menu' | 'playing' | 'paused' | 'dead';

export class Game {
  private renderer!: THREE.WebGPURenderer;
  private readonly scene = new THREE.Scene();
  private readonly input = new Input();
  private readonly audio = new GameAudio();
  private readonly world = new World();
  private player!: Player;
  private effects!: Effects;
  private enemies!: EnemyManager;
  private weapons!: WeaponController;
  private pickups!: Pickups;
  private waves!: WaveManager;
  private readonly viewmodel = new Viewmodel();
  private ally!: Ally;
  private readonly hud = new Hud();
  private loop!: GameLoop;
  private readonly save: SaveData;

  private phase: GamePhase = 'menu';
  private score = 0;
  private kills = 0;
  private runRecorded = false;
  private isNewRecord = false;
  private stepAcc = 0;
  private lastCountdown = -1;
  private readonly pLast = new THREE.Vector3(Number.NaN, 0, 0);
  private readonly pVel = new THREE.Vector3();
  private readonly radarBlips: RadarBlip[] = Array.from({ length: 24 }, () => ({
    x: 0,
    z: 0,
    color: 0,
    colorCss: '#000000',
  }));
  private readonly radarColorCache = new Map<number, string>();
  private radarCount = 0;
  private readonly hudSnapshot: HudState = {
    health: 100,
    maxHealth: 100,
    mag: 30,
    magSize: 30,
    reserve: 0,
    reloading: false,
    reloadProgress: 0,
    weaponIndex: 0,
    wave: 1,
    enemiesLeft: 0,
    phase: 'intermission',
    phaseTimer: 0,
    score: 0,
    kills: 0,
    spread: 0,
    inGame: false,
    allyActive: false,
    allyCount: 0,
    allyHp: 0,
    allyMax: 0,
    radar: this.radarBlips,
    radarCount: 0,
  };
  private menuTime = 0;

  public constructor(private readonly container: HTMLElement) {
    this.configureRenderer();
    this.save = loadSave();
    this.audio.setVolume(this.save.volume);
    this.createSystems();
    this.wireCallbacks();
    this.attachLifecycle();
    this.hud.syncSettings(this.save.sensitivity, this.save.volume);
    this.hud.syncMode(this.save.mode);
    this.hud.setMenuBest(this.save.bestScore, this.save.bestWave);
    (window as unknown as { __game?: Game }).__game = this;
    this.resetPlayer();
    this.hud.showMenu(true);
    void this.bootRenderer();
  }

  private configureRenderer(): void {
    this.renderer = new THREE.WebGPURenderer({ antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 2.2;
    this.container.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud.root);

    this.scene.background = new THREE.Color(0x060a14);
    this.scene.fog = new THREE.FogExp2(0x060a14, 0.005);
  }

  private async bootRenderer(): Promise<void> {
    try {
      await this.renderer.init();
      this.configureViewmodelEnvironment();
      this.loop.start();
    } catch (error) {
      console.error('Frontal Force renderer initialization failed:', error);
      this.hud.showFatal(error instanceof Error ? error.message : String(error));
    }
  }

  private configureViewmodelEnvironment(): void {
    try {
      const pmrem = new THREE.PMREMGenerator(this.renderer);
      const room = new RoomEnvironment();
      this.viewmodel.setEnvironment(pmrem.fromScene(room, 0.04).texture);
      room.dispose();
      pmrem.dispose();
    } catch {
      /* no IBL — viewmodel key/rim lights carry the metals */
    }
  }

  private createSystems(): void {
    this.world.build(this.scene);
    this.player = new Player(this.world.octree);
    this.player.setSensitivity(this.save.sensitivity);
    this.scene.add(this.player.camera, this.player.body);
    this.effects = new Effects(this.scene);
    this.enemies = new EnemyManager(this.scene, this.world.octree, this.effects, this.audio);
    this.enemies.setCoverSpots(this.world.coverSpots);
    this.weapons = new WeaponController(
      this.player, this.enemies, this.world, this.effects, this.audio,
      (kind) => {
        this.hud.hitmarkerFlash(kind === 'headshot' ? 'headshot' : 'hit');
        this.audio.hitmarker(kind === 'headshot');
      },
    );
    this.weapons.onFired = (weapon) => this.viewmodel.kick(0.025 + weapon.def.recoil * 0.8);
    this.weapons.getMuzzle = (eye, out) => {
      this.viewmodel.muzzleOffset(out);
      out.applyQuaternion(this.player.camera.quaternion).add(eye);
    };
    this.weapons.onSwitched = () => {
      this.viewmodel.notifySwitch();
      this.audio.weaponSwitch();
    };
    this.ally = new Ally(this.scene, this.world.octree, this.effects, this.audio);
    this.ally.onShot = (pan) => this.audio.allyShot(pan);
    this.enemies.interceptors.push(...this.ally.bots);
    this.pickups = new Pickups(this.scene, this.audio, this.effects);
    this.waves = new WaveManager(this.enemies, this.world);
    this.waves.setMode(this.save.mode);
  }

  private wireCallbacks(): void {
    this.enemies.onEnemyKilled = this.handleKill;
    this.enemies.onPlayerHit = this.handlePlayerHit;
    this.player.onDamaged = (from) => {
      this.hud.damageFlash();
      if (!from) {
        this.audio.hurt();
        return;
      }
      const angle = this.damageAngle(from);
      this.hud.damageFrom(angle);
      this.audio.hurt(Math.sin(angle));
    };
    this.player.onLanded = () => this.audio.land();
    this.waves.onWaveStart = (wave) => {
      this.hud.showBanner(`WAVE ${wave}`, '');
      this.audio.waveStart();
      this.lastCountdown = -1;
    };
    this.waves.onWaveClear = (wave) => {
      this.audio.waveClear();
      const bonus = Math.round(wave * 250 * this.waves.scoreMult);
      this.score += bonus;
      this.hud.showBanner('WAVE CLEAR', `+${bonus}`);
    };
    this.hud.onStart = () => this.startRun();
    this.hud.onRestart = () => this.startRun();
    this.hud.onResume = () => this.resume();
    this.hud.onQuit = () => this.toMenu();
    this.hud.onSettings = (patch) => this.applySettings(patch);
    this.hud.onMode = (mode) => {
      this.save.mode = mode;
      this.waves.setMode(mode);
      this.hud.syncMode(mode);
      persistSave(this.save);
    };
    this.input.onPauseKey = () => {
      if (this.phase === 'playing') this.pause();
      else if (this.phase === 'paused') this.resume();
    };
    this.input.onLockChange = (locked) => {
      this.hud.setLocked(locked);
      if (!locked && this.phase === 'playing') this.pause();
    };
    this.input.onFocusLost = () => {
      if (this.phase === 'playing') this.pause();
    };
  }

  private attachLifecycle(): void {
    this.loop = new GameLoop(this.update, this.render);
    this.input.attach(this.renderer.domElement);
    this.renderer.domElement.addEventListener('click', this.onCanvasClick);
    window.addEventListener('resize', this.onResize);
    this.onResize();
  }

  private onCanvasClick = (): void => {
    this.audio.unlock();
    if (this.phase === 'playing') this.input.requestLock();
  };

  // ---------- Run lifecycle ----------

  private startRun(): void {
    this.audio.unlock();
    this.phase = 'playing';
    this.audio.setMusicPaused(false);
    this.score = 0;
    this.kills = 0;
    this.runRecorded = false;
    this.isNewRecord = false;
    this.stepAcc = 0;
    this.lastCountdown = -1;
    this.weapons.reset();
    this.enemies.clear();
    this.pickups.clear();
    this.world.rebuild((Math.random() * 0xffffffff) >>> 0);
    this.enemies.setCoverSpots(this.world.coverSpots);
    this.effects.reset();
    this.viewmodel.reset();
    for (const [i, point] of this.world.pickupPoints.entries()) {
      this.pickups.spawnAt(i % 2 === 0 ? 'health' : 'ammo', point);
    }
    this.resetPlayer();
    this.pLast.copy(this.player.position);
    this.pVel.set(0, 0, 0);
    this.waves.reset();
    this.ally.deploy(this.player.position);
    this.hud.showMenu(false);
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.showBanner('DEPLOYED', '');
    this.input.resetTransient();
    this.input.requestLock();
  }

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    this.input.resetTransient();
    document.exitPointerLock();
    this.hud.showPause(true);
    this.audio.setMusicPaused(true);
    this.audio.heartbeat(0, 0);
  }

  private resume(): void {
    if (this.phase !== 'paused') return;
    this.phase = 'playing';
    this.hud.showPause(false);
    this.audio.setMusicPaused(false);
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
    this.audio.setMusicPaused(false);
    this.recordRun();
    this.enemies.clear();
    this.pickups.clear();
    this.waves.reset();
    this.ally.stow();
    this.effects.reset();
    this.viewmodel.reset();
    this.resetPlayer();
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.showMenu(true);
    this.hud.setMenuBest(this.save.bestScore, this.save.bestWave);
  }

  private onDeath(): void {
    this.phase = 'dead';
    this.input.resetTransient();
    this.audio.setMusicPaused(false);
    this.audio.heartbeat(0, 0);
    document.exitPointerLock();
    this.isNewRecord = this.recordRun();
    if (this.isNewRecord) this.audio.record();
    this.hud.showDeath(true, {
      wave: this.waves.cleared,
      kills: this.kills,
      score: this.score,
      bestScore: this.save.bestScore,
      isNewRecord: this.isNewRecord,
      mode: this.save.mode,
    });
  }

  private recordRun(): boolean {
    if (this.runRecorded || this.score <= 0) return false;
    this.runRecorded = true;
    const isRecord = this.score > this.save.bestScore;
    if (isRecord) this.save.bestScore = this.score;
    if (this.waves.wave > this.save.bestWave) this.save.bestWave = this.waves.wave;
    persistSave(this.save);
    return isRecord;
  }

  private applySettings(patch: SettingsPatch): void {
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
    this.player.reset(this.world.playerSpawn, Math.PI);
  }

  // ---------- Frame update ----------

  private update = (dt: number): void => {
    const frame = this.input.read();
    if (this.phase === 'paused') return;
    this.updateMusic();
    this.audio.musicTick();

    if (this.phase === 'dead') return;
    if (this.phase === 'menu') {
      this.world.update(dt);
      this.menuTime += dt;
      const t = this.menuTime * 0.01;
      this.player.camera.position.set(Math.sin(t) * 26, 12, Math.cos(t) * 26);
      this.player.camera.lookAt(0, 1, 0);
      return;
    }

    this.world.update(dt);
    this.effects.update(dt, this.player.camera);
    this.pickups.update(dt);
    this.updatePlayingStep(dt, frame);
  };

  private updatePlayingStep(dt: number, frame: InputFrame): void {
    this.player.update(dt, frame);
    // Player velocity for enemy ballistic lead prediction
    if (Number.isNaN(this.pLast.x)) {
      this.pLast.copy(this.player.position);
    } else {
      this.pVel.subVectors(this.player.position, this.pLast).divideScalar(Math.max(dt, 1e-4));
      this.pVel.clampLength(0, 14);
      this.pLast.copy(this.player.position);
    }
    this.weapons.update(frame, dt);
    this.viewmodel.setWeapon(this.weapons.current.def.id);
    const wv = this.weapons.view();
    this.viewmodel.update(dt, {
      speed: this.player.horizontalSpeed,
      sprinting: this.player.isSprinting,
      aimHeld: frame.aimHeld,
      lookX: frame.lookX,
      lookY: frame.lookY,
      reloading: wv.reloading,
      reloadProgress: wv.reloadProgress,
    });
    this.waves.update(dt, this.player.position);
    this.enemies.playerYaw = this.player.yawAngle;
    this.enemies.update(
      dt,
      this.player.position,
      this.player.dead,
      this.pVel,
      this.weapons.lastShot,
    );
    this.weapons.lastShot = null;
    this.ally.update(dt, this.player.position, this.player.yawAngle, this.enemies);

    // Footsteps: stride-linked distance cadence while grounded
    const speed = this.player.horizontalSpeed;
    if (speed > 1.2 && this.player.isGrounded) {
      this.stepAcc += speed * dt;
      if (this.stepAcc >= 2.6) {
        this.stepAcc = 0;
        this.audio.step();
      }
    } else {
      this.stepAcc = 0;
    }

    // Intermission countdown blips (3·2·1)
    if (this.waves.phase === 'intermission') {
      const c = Math.ceil(this.waves.timer);
      if (c !== this.lastCountdown) {
        this.lastCountdown = c;
        if (c >= 1 && c <= 3) this.audio.tick();
      }
    }

    const collected = this.pickups.tryCollect(this.player.position);
    if (collected === 'health') this.player.heal(35);
    if (collected === 'ammo') this.weapons.refillReserve();

    this.audio.heartbeat(this.player.health / this.player.maxHealth, dt);

    if (this.player.dead) this.onDeath();
  }

  // ---------- Combat callbacks ----------

  /** Adaptive music: quiet on menu, pulse ramps with wave pressure in combat. */
  private updateMusic(): void {
    if (this.phase === 'menu') {
      this.audio.setMusic(0.25, 68);
    } else if (this.phase === 'dead') {
      this.audio.setMusic(0.08, 60);
    } else {
      const pressure = Math.min(1, this.waves.wave / 10);
      const fighting = this.waves.phase === 'combat' || this.waves.phase === 'spawning';
      this.audio.setMusic(
        fighting ? 0.45 + pressure * 0.5 : 0.28,
        fighting ? 78 + pressure * 36 : 70,
      );
    }
  }

  private handleKill = (enemy: Enemy): void => {
    this.kills += 1;
    const pts = Math.round(enemy.def.score * this.waves.scoreMult);
    this.score += pts;
    this.hud.hitmarkerFlash('kill');
    this.hud.popScore(pts);
    if (this.waves.isRotator) this.weapons.rotate();
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

  private hudState(): HudState {
    const view = this.weapons.view();
    const weapon = this.weapons.current;
    const state = this.hudSnapshot;
    state.health = this.player.health;
    state.maxHealth = this.player.maxHealth;
    state.mag = view.mag;
    state.magSize = weapon.def.magSize;
    state.reserve = view.reserve;
    state.reloading = view.reloading;
    state.reloadProgress = view.reloadProgress;
    state.weaponIndex = view.index;
    state.wave = Math.max(1, this.waves.wave);
    state.enemiesLeft = this.enemies.aliveCount;
    state.phase = this.waves.phase;
    state.phaseTimer = this.waves.timer;
    state.score = this.score;
    state.kills = this.kills;
    state.spread = this.crosshairSpread();
    state.inGame = this.phase === 'playing';
    state.allyActive = this.ally.active;
    state.allyCount = this.ally.aliveCount;
    state.allyHp = this.ally.hp;
    state.allyMax = this.ally.maxHp;
    state.radar = this.radarBlips;
    state.radarCount = this.radarCount;
    return state;
  }

  /** Normalized crosshair spread 0..1 from weapon + movement state. */
  private crosshairSpread(): number {
    const spread = this.weapons.spreadFor(this.player.horizontalSpeed > 2, this.player.isAiming);
    return clamp(spread / 0.08, 0, 1);
  }

  /** Build radar blips (enemy positions rotated into player-facing space). */
  private buildRadar(): void {
    let count = 0;
    const playerX = this.player.position.x;
    const playerZ = this.player.position.z;
    const cy = Math.cos(this.player.yawAngle);
    const sy = Math.sin(this.player.yawAngle);
    this.enemies.forEachLive((enemy) => {
      if (count >= this.radarBlips.length) return;
      const blip = this.radarBlips[count];
      if (!blip) return;
      const dx = enemy.group.position.x - playerX;
      const dz = enemy.group.position.z - playerZ;
      // World -> player-local: rz = forward component, rx = right component
      const rx = dx * cy - dz * sy;
      const rz = -(dx * sy + dz * cy);
      const range = 46;
      blip.x = clamp(rx / range, -1, 1);
      blip.z = clamp(rz / range, -1, 1);
      blip.color = enemy.def.color;
      let colorCss = this.radarColorCache.get(enemy.def.color);
      if (!colorCss) {
        colorCss = `#${enemy.def.color.toString(16).padStart(6, '0')}`;
        this.radarColorCache.set(enemy.def.color, colorCss);
      }
      blip.colorCss = colorCss;
      count += 1;
    });
    this.radarCount = count;
  }

  // ---------- Rendering / resize ----------

  private render = (frameDt: number): void => {
    if (this.phase === 'playing') this.buildRadar();
    else this.radarCount = 0;
    this.player.body.visible = this.phase === 'playing' || this.phase === 'paused';
    // Overlays freeze their banner timer; only active gameplay animates HUD.
    this.hud.update(this.phase === 'playing' ? frameDt : 0, this.hudState());
    this.renderer.clear();
    this.renderer.render(this.scene, this.player.camera);
    if (this.phase === 'playing' || this.phase === 'paused') {
      this.viewmodel.render(this.renderer);
    }
  };

  private onResize = (): void => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
    this.viewmodel.setSize(w, h);
  };
}
