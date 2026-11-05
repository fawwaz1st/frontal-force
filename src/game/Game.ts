import * as THREE from 'three/webgpu';
import { RenderPipeline } from 'three/webgpu';
import { pass } from 'three/tsl';
import { bloom } from 'three/addons/tsl/display/BloomNode.js';
import { fxaa } from 'three/addons/tsl/display/FXAANode.js';
import { Fn, uv, length, mix, renderOutput, smoothstep } from 'three/tsl';
import { GameLoop } from '../core/loop';
import { Input, type InputFrame } from '../input/Input';
import { GameAudio } from '../audio/Audio';
import { World } from '../world/World';
import { Hazards, type HazardDamageSink } from '../world/Hazards';
import { Player } from '../player/Player';
import { Effects } from '../render/Effects';
import { EnemyManager, type Enemy } from '../ai/Enemies';
import { WeaponController } from '../combat/WeaponController';
import { PLAYER_TARGET_ID } from '../combat/Combatant';
import { WEAPONS, sanitizeLoadout, type WeaponId } from '../combat/weapons';
import { Grenades, type GrenadeKind } from '../combat/Grenades';
import { Viewmodel } from '../render/Viewmodel';
import { Ally } from '../ai/Ally';
import { Pickups } from '../world/Pickups';
import { WaveManager, BOSS_NAME } from './Waves';
import { Run } from './Run';
import { UPGRADES, type UpgradeId } from './Upgrades';
import {
  ACHIEVEMENTS,
  AchievementTracker,
  type AchievementId,
} from './Achievements';
import { applyRun, createCounters, type RunResult } from './AchievementCounters';
import {
  challengeLabel,
  foldChallenges,
  type ChallengeId,
  type ChallengeMods,
} from './Challenges';
import { Hud, type HudState, type RadarBlip, type SettingsPatch, type TargetMarker } from '../ui/Hud';
import { Draft } from '../ui/Draft';
import { Kiosk, type KioskItem } from '../ui/Kiosk';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { loadSave, persistSave, resolveTier, type SaveData } from '../core/storage';
import {
  detectTier,
  FrameTimeGovernor,
  presetFor,
  type QualityPreset,
} from '../core/quality';
import { clamp } from '../core/math';
import { codeToSeed, dailySeed, seedToCode } from '../core/rng';
import type { CombatTarget } from '../combat/Combatant';

type GamePhase = 'menu' | 'playing' | 'paused' | 'dead' | 'draft' | 'kiosk';

/** Kill-combo: refresh window per kill, tier decay after it lapses (research: ×8 cap). */
const COMBO_WINDOW = 3;
const COMBO_DECAY = 0.5;
/** Salvage paid per kill, before the salvage multiplier. */
const SALVAGE_PER_KILL = 4;
const SALVAGE_PER_WAVE = 30;
const SALVAGE_ELITE_BONUS = 25;
const SALVAGE_BOSS_BONUS = 200;
/** What a pickup restores. Health is a real heal, salvage is real currency. */
const HEALTH_PICKUP = 35;
const SALVAGE_PICKUP = 12;
/**
 * Drop chances per kill, as independent rolls.
 *
 * Deliberately low and independent rather than a guaranteed schedule: a
 * guaranteed drop turns every kill into a chore (walk over and collect it), and
 * a schedule the player can count makes the arena feel like a spreadsheet. Low
 * odds mean a drop is a small event, which is exactly what it should be.
 *
 * Elites and the boss get much better odds because killing one already cost the
 * player something, and the drop is how the game says so.
 */
const DROP_CHANCE_AMMO = 0.14;
const DROP_CHANCE_HEALTH = 0.09;
const DROP_CHANCE_SALVAGE = 0.22;
/** Bonus roll odds for an elite, and the boss. */
const ELITE_DROP_BONUS = 0.35;
/** Ability timings. */
const DASH_CHARGES = 2;
const DASH_COOLDOWN = 3;
const DASH_TIME = 0.25;
const DASH_SPEED = 24;
const DASH_INVULN = 0.12;
const GRENADE_CHARGES = 2;
const GRENADE_COOLDOWN = 12;
const MELEE_RANGE = 2.6;
const MELEE_DAMAGE = 42;
const MELEE_COOLDOWN = 0.5;
const MELEE_LUNGE = 5.5;
/** Seconds the lunge lasts. Kept beside the speed so the two are read together. */
const MELEE_LUNGE_TIME = 0.14;
/** Enemies below this health fraction can be executed for a heal. */
const EXECUTE_THRESHOLD = 0.15;
const EXECUTE_HEAL = 18;
/**
 * Kiosk sell-back: a sold card pays this fraction of a fixed nominal card
 * value. Flat pricing (rather than a per-card price) keeps the shop readable:
 * the player never has to remember what a specific card cost to know what
 * selling it returns.
 */
const CARD_VALUE = 50;
const SELL_REFUND_RATE = 0.4;
/** How close a bullet impact must land to count as hitting a barrel. */
const BARREL_HIT_RADIUS = 0.6;
/**
 * Ignite-on-kill payload (Gasoline / Diesel Soaked / Greek Fire).
 *
 * A radius smaller than a frag grenade on purpose: this is a chain-reaction
 * rider on a kill, not a second explosive. The burn outlasts the 3 s combo
 * window so the fire can finish a straggler the player already moved past.
 */
const IGNITE_RADIUS = 5;
const IGNITE_DPS = 14;
const IGNITE_TIME = 3;
/** How long a melee swing or a thrown grenade owns the kills it causes. */
const MELEE_KILL_WINDOW = 0.8;
const GRENADE_KILL_WINDOW = 2.5;

/**
 * Adapter: makes the human a `CombatTarget` without teaching Player about
 * enemy AI. Kept in the orchestrator so the player module stays renderer-only.
 */
class PlayerTarget implements CombatTarget {
  public readonly team = 'player' as const;
  /** The human is the most attractive victim on the field. */
  public readonly threatRole = 1;

  public constructor(private readonly player: Player) {}

  public get targetId(): number {
    return PLAYER_TARGET_ID;
  }

  public get position(): THREE.Vector3 {
    return this.player.position;
  }

  public get velocity(): THREE.Vector3 {
    return this.player.velocity;
  }

  public get eyeHeight(): number {
    return this.player.eyeHeight;
  }

  public get hpFraction(): number {
    return this.player.health / this.player.maxHealth;
  }

  public get targetable(): boolean {
    return !this.player.dead;
  }

  public aimPressureAt(from: THREE.Vector3): number {
    if (this.player.dead) return 0;
    const dx = from.x - this.player.position.x;
    const dz = from.z - this.player.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) return 1;
    const yaw = this.player.yawAngle;
    const fx = -Math.sin(yaw);
    const fz = -Math.cos(yaw);
    const dot = (dx / len) * fx + (dz / len) * fz;
    if (dot <= 0) return 0;
    return dot * dot;
  }

  public receiveDamage(amount: number, from: THREE.Vector3, source = ''): void {
    this.player.damage(amount, from, source);
  }
}

export class Game {
  private renderer!: THREE.WebGPURenderer;
  private renderPipeline!: RenderPipeline;
  private readonly scene = new THREE.Scene();
  private readonly input = new Input();
  private readonly audio = new GameAudio();
  private readonly world = new World();
  private flashExposure = 1.35;
  private flashExposureT = 0;
  private player!: Player;
  private effects!: Effects;
  private enemies!: EnemyManager;
  private weapons!: WeaponController;
  private pickups!: Pickups;
  private waves!: WaveManager;
  private grenades!: Grenades;
  private hazards!: Hazards;
  private readonly viewmodel = new Viewmodel();
  private ally!: Ally;
  /** Player-as-target adapter — registered with the enemy threat table. */
  private playerTarget!: PlayerTarget;
  private readonly hud = new Hud();
  private readonly draft = new Draft();
  private readonly kiosk = new Kiosk();
  /** The live roguelite run. Replaced on every startRun(). */
  private run = new Run(0);
  /** Lifetime counters plus the achievement evaluator. */
  private counters = createCounters();
  private readonly tracker = new AchievementTracker();
  private unlocked = new Set<AchievementId>();
  private queue: AchievementId[] = [];
  private loop!: GameLoop;
  private readonly save: SaveData;
  /** Resolved render preset — a floor on quality, lowered by the governor. */
  private quality!: QualityPreset;
  /** Runtime frame-time probe: only ever steps the pixel ratio down. */
  private readonly governor = new FrameTimeGovernor();

  private phase: GamePhase = 'menu';
  private score = 0;
  private kills = 0;
  private runRecorded = false;
  private isNewRecord = false;
  private stepAcc = 0;
  /**
   * Hitstop: seconds of near-frozen simulation left.
   *
   * A 40-70 ms freeze on a big hit is the single cheapest way to make damage
   * feel like it LANDED rather than like a number changed. It is applied as a
   * time scale on the sim only, so the renderer keeps running and the freeze
   * reads as a punch rather than as a stutter.
   */
  private hitstopT = 0;
  private lastCountdown = -1;
  private combo = 0;
  private comboTimer = 0;
  /** Ability state. */
  private dashCharges = DASH_CHARGES;
  private dashRecharge = 0;
  private dashT = 0;
  private dashDir = new THREE.Vector3();
  private grenadeCharges = GRENADE_CHARGES;
  private grenadeRecharge = 0;
  private grenadeCook = 0;
  private grenadeKind: GrenadeKind = 'frag';
  private meleeT = 0;
  /** Alternates per swing so consecutive melees never read the same way. */
  private meleeSwingSide: 1 | -1 = 1;
  /** Per-wave stats for the medal + achievement counters. */
  private waveTookDamage = false;
  private waveStartT = 0;
  private bestWaveTime = 0;
  private noHitWaves = 0;
  private eliteKills = 0;
  private bossKills = 0;
  private barrelKills = 0;
  private hazardKills = 0;
  private meleeKills = 0;
  private grenadeKills = 0;
  private dashKills = 0;
  private lifestealHealed = 0;
  private longestCombo = 0;
  /**
   * Ability kill-attribution WINDOWS, in seconds remaining.
   *
   * A window rather than a one-shot flag because all three abilities kill
   * asynchronously: a grenade kills on impact (up to ~2 s after the throw), a
   * dash kill happens while the dash is still travelling, and a melee kill can
   * come from the lunge. The window closes on its own timer, so a stale flag
   * can never claim a kill from a later fight.
   */
  private pendingMeleeKill = false;
  private pendingGrenadeKill = false;
  private pendingDashKill = false;
  private meleeKillT = 0;
  private grenadeKillT = 0;
  private readonly pLast = new THREE.Vector3(0, 0, 0);
  private readonly radarBlips: RadarBlip[] = Array.from({ length: 40 }, () => ({
    x: 0,
    z: 0,
    color: 0,
    colorCss: '#000000',
  }));
  private readonly radarColorCache = new Map<number, string>();
  private radarCount = 0;
  /** World-space markers over enemies and allies, rebuilt each HUD tick. */
  private readonly targetMarkers: TargetMarker[] = Array.from({ length: 28 }, () => ({
    x: 0, y: 0, distance: 0, colorCss: '#ffffff', role: 'enemy',
    health: 1, clamped: false, glyph: '',
  }));
  private markerCount = 0;
  private readonly markerProject = new THREE.Vector3();
  private readonly markerProject2 = new THREE.Vector3();
  private hudMarkerTimer = 0;
  private hurtAge = 99;
  /** Handle for the post-resume pointer-lock re-probe, 0 when disarmed. */
  private lockReprobeTimer = 0;
  private readonly hudSnapshot: HudState = {
    health: 100,
    maxHealth: 100,
    shield: 0,
    mag: 30,
    magSize: 30,
    reserve: 0,
    reloading: false,
    reloadProgress: 0,
    weaponIndex: 0,
    weaponName: '',
    wave: 1,
    enemiesLeft: 0,
    phase: 'intermission',
    phaseTimer: 0,
    score: 0,
    kills: 0,
    comboMult: 1,
    crosshairGapPx: 3,
    inGame: false,
    allyActive: false,
    allyCount: 0,
    allyHp: 0,
    allyMax: 0,
    radar: this.radarBlips,
    radarCount: 0,
    // New systems surface through the same snapshot: the HUD never reaches
    // into the simulation, it only reads this object.
    dashCharges: DASH_CHARGES,
    dashMax: DASH_CHARGES,
    dashFraction: 1,
    grenadeCharges: GRENADE_CHARGES,
    grenadeMax: GRENADE_CHARGES,
    grenadeFraction: 1,
    grenadeKind: 'frag',
    grenadeCook: 0,
    salvage: 0,
    upgrades: 0,
    seedCode: '',
    isDaily: false,
    mutationName: '',
    mutationDesc: '',
    wagerCount: 0,
    wagerScoreMul: 1,
    wagerLabel: '',
    bossActive: false,
    bossHealth: 0,
    bossMax: 0,
    bossName: '',
    bossPhase: 0,
    bossWeakPoint: false,
    burnT: 0,
    slowT: 0,
    achievementsQueued: 0,
    eliteAlive: 0,
    mapName: '',
    mapTagline: '',
    loadoutNames: [],
    loadoutIds: [],
    scoped: false,
    adsT: 0,
    charge: 1,
    charging: false,
    markers: this.targetMarkers,
    markerCount: 0,
    hurtBy: '',
    hurtAge: 99,
  };
  private menuTime = 0;
  /** Last consumed look delta (render-rate) — drives cosmetic weapon sway. */
  private readonly frameLook = new THREE.Vector2();
  /** Viewport height in CSS px — converts a cone angle into crosshair pixels. */
  private viewportH = 900;

  public constructor(private readonly container: HTMLElement) {
    // Save MUST load before the renderer: the quality preset comes from it.
    this.save = loadSave();
    this.configureRenderer();
    this.audio.setVolume(this.save.volume);
    this.createSystems();
    this.wireCallbacks();
    this.attachLifecycle();
    this.hud.syncSettings(this.save.sensitivity, this.save.volume, this.save.touchSensitivity, this.save.quality);
    this.hud.syncMode(this.save.mode);
    // Restore the persisted wager selection before the menu is ever shown, so
    // the chips and the payout readout agree with the save on first paint.
    this.setChallenges(this.save.challenges);
    // Loadout: repaired through the weapon table before it ever reaches the
    // controller, so a save from an older build cannot leave an empty kit.
    this.setLoadout(this.save.loadout, false);
    this.hud.setChallengeSelection(this.challenges);
    this.hud.setMenuBest(this.save.bestScore, this.recordWave);
    this.hud.setMenuRecords(this.save);
    // The ledger is a progress panel, so it belongs on the first paint too: an
    // empty ring at 0% is a better invitation than an absent panel.
    this.hud.setAchievements(this.unlocked, this.counters);
    this.input.touch.setSensitivity(this.save.touchSensitivity);
    // The HUD draws the touch buttons from the SAME rects the input hit-tests,
    // so a visible button is always a tappable button.
    this.hud.touchButtonRects = this.input.touch.buttonsForRender;
    this.input.onTouchMode = () => {
      this.hud.setTouchMode(true);
      // Slot chips double as touch weapon selectors: tapping one switches.
      this.hud.onSlotTap = (slot) => this.input.touch.requestSlot(slot);
    };
    (window as unknown as { __game?: Game }).__game = this;
    this.resetPlayer();
    this.hud.showMenu(true);
    void this.bootRenderer();
  }

  private configureRenderer(): void {
    this.quality = presetFor(resolveTier(this.save.quality, detectTier()));
    this.renderer = new THREE.WebGPURenderer({
      antialias: this.quality.antialias,
      // Chrome ignores this for WebGPU, but the WebGL2 fallback and
      // Firefox/Safari honour it, and 'low-power' would be wrong for a game.
      powerPreference: 'high-performance',
    });    this.renderer.setPixelRatio(this.pixelRatio());
    this.renderer.autoClear = false;
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    // Exposure 2.2 washed the arena out: ACES already lifts mid-tones, so
    // doubling it flattened the floor, the walls and the fog into one pale
    // grey band and killed the contrast the lighting was built for. 1.35
    // keeps the highlights from clipping while letting the shadows stay
    // genuinely dark, which is what makes the emissive accents read.
    if (this.flashExposureT > 0) {
      this.flashExposureT = Math.max(0, this.flashExposureT - 0.016);
      this.renderer.toneMappingExposure = this.flashExposure;
      if (this.flashExposureT <= 0) this.renderer.toneMappingExposure = 1.35;
    } else {
      this.renderer.toneMappingExposure = 1.35;
    }

    this.container.appendChild(this.renderer.domElement);
    this.container.appendChild(this.hud.root);
    // The draft and kiosk are separate overlays, not part of the HUD tree, so
    // they must be attached explicitly. Without this they render nothing and
    // the between-wave loop is unreachable.
    this.container.appendChild(this.draft.root);
    this.container.appendChild(this.kiosk.root);

    // Touch surfaces: `touch-action: none` must be on every element that
    // receives pointer events (it is not inherited), or the browser steals
    // pan/pinch mid-drag.
    this.renderer.domElement.style.touchAction = 'none';
    this.hud.root.style.touchAction = 'none';

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
    // Thunder: a brief exposure spike so a lightning flash reads as light,
    // not as a UI event. Wired here because World.onThunder was declared
    // but never connected (audit finding).
    this.world.onThunder = (_delay) => {
      this.flashExposure = 1.55;
      this.flashExposureT = 0.1;
    };
    this.player = new Player(this.world.octree);

    // Post-processing: bloom on emissive + soft vignette + FXAA. Built here
    // (not in configureRenderer) because pass() needs the live player camera.
    const scenePass = pass(this.scene, this.player.camera);
    const scenePassColor = scenePass.getTextureNode('output');
    const bloomPass = bloom(scenePassColor, 0.6, 0.4, 0.85);
    const vignetteNode = Fn(() => {
      const centered = uv().sub(0.5);
      const dist = length(centered);
      const v = smoothstep(0.35, 0.9, dist);
      return scenePassColor.mul(mix(1.0, 0.68, v));
    })();
    this.renderPipeline = new RenderPipeline(this.renderer);
    this.renderPipeline.outputNode = fxaa(renderOutput(vignetteNode.add(bloomPass)));
    this.player.setSensitivity(this.save.sensitivity);
    this.playerTarget = new PlayerTarget(this.player);
    this.scene.add(this.player.camera, this.player.body);
    this.effects = new Effects(this.scene);
    this.enemies = new EnemyManager(this.scene, this.world.octree, this.effects, this.audio);
    this.enemies.setCoverSpots(this.world.coverSpots);
    this.weapons = new WeaponController(
      this.player, this.enemies, this.world, this.effects, this.audio,
      (kind) => {
        if (kind === 'blocked') {
          this.hud.hitmarkerFlash('blocked');
          this.audio.blocked();
          return;
        }
        this.hud.hitmarkerFlash(kind === 'headshot' ? 'headshot' : 'hit');
        this.audio.hitmarker(kind === 'headshot');
        // Hit-stop scales with the WEAPON, not just the hit. Avowed's team
        // found a uniform freeze made every swing feel identical; a shotgun
        // pellet and a rail round should not land with the same weight. The
        // freeze is derived from the shot's damage, so the heaviest weapon in
        // the kit has the heaviest beat.
        const wDef = this.weapons.current.def;
        // 0.018 s per 10 damage, floored at 0.02 and capped at 0.075 so a
        // rail (130) reads as a real stop without freezing the game.
        const stop = clamp(0.018 * (wDef.damage / 10), 0.02, 0.075);
        // Only KILLS freeze. A hit-stop on every hit (the previous behaviour)
        // scaled time dilation with accuracy: a beam player (20 hits/s) ran
        // the whole sim at 0.74x, which made every encounter 26% easier and
        // desynced audio. A hit is feedback; a kill is a beat.
        // Only KILLS freeze. A hit-stop on every hit scaled time dilation
        // with accuracy: a beam player (20 hits/s) ran the whole sim at
        // 0.74x, which made every encounter 26% easier and desynced audio.
        // A hit is feedback; a kill is a beat.
        if (kind === 'kill') this.hitstopT = Math.max(this.hitstopT, stop);
      },
    );
    this.weapons.onFired = (weapon) => this.viewmodel.kick(0.025 + weapon.def.recoil * 0.8);
    this.weapons.getMuzzle = (eye, out) => {
      this.viewmodel.muzzleOffset(out);
      out.applyQuaternion(this.player.camera.quaternion).add(eye);
    };
    // Statistics: every shot and every point of damage the player deals passes
    // through here, which is what makes accuracy, headshots, DPS and lifesteal
    // agree with each other. Damage is post-mitigation (see WeaponController).
    this.weapons.onShotStat = (result) => {
      this.run.stats.shotsFired += 1;
      if (result === 1 || result === 2 || result === 3 || result === 4) {
        this.run.stats.shotsHit += 1;
      }
      if (result === 2 || result === 3) this.run.stats.headshots += 1;
    };
    this.weapons.onDamageDealt = (amount, headshot) => this.onDamageDealt(amount, headshot);
    // Barrel shooting: a prop hit within a barrel's radius damages that barrel,
    // so the arena's explosive props are part of the fight instead of scenery.
    this.weapons.onPropHit = (point, _dir, amount) => {
      const barrel = this.hazards.nearest(point, BARREL_HIT_RADIUS);
      if (!barrel) return false;
      return this.hazards.damageHazard(barrel, amount, point, true);
    };
    // Affix riders: a Blazing enemy sets the player burning, a Glacial one
    // slows them. The rider belongs to the enemy that was shot.
    this.weapons.onEnemyHit = (enemy, headshot) => {
      void headshot;
      this.enemies.applyAffixOnHit(this.playerTarget, enemy);
    };
    this.weapons.onSwitched = () => {
      this.viewmodel.notifySwitch();
      this.audio.weaponSwitch();
    };
    this.ally = new Ally(this.scene, this.world.octree, this.effects, this.audio);
    this.ally.onShot = (pan) => this.audio.allyShot(pan);
    // Escort stereo placement needs the live listener frame, which only the
    // orchestrator has — the bots just report world positions.
    this.ally.panProvider = (p) => {
      const dx = p.x - this.player.position.x;
      const dz = p.z - this.player.position.z;
      const len = Math.hypot(dx, dz) || 1;
      const yaw = this.player.yawAngle;
      return Math.max(-1, Math.min(1, (dx / len) * Math.cos(yaw) - (dz / len) * Math.sin(yaw)));
    };
    // HOT ZONE death-grenade: spawn a short-fuse frag where the enemy fell.
    this.enemies.onDeathGrenade = (at) => {
      const eye = at.clone();
      const dir = new THREE.Vector3(0, 0.35, 0);
      this.grenades.throwGrenade('frag', eye, dir, 0.15);
      this.effects.ring(at, 0xff8a3c, 2.2, 0.3);
      this.audio.blastAt(at.x, at.z);
    };
    // HOT ZONE: the grenade must be able to hurt the PLAYER too, otherwise
    // the modifier is a free +30% score. The detonate callback now also
    // calls player.damage via a sink with radius 3.6 m, floor 0.45, cap 35.
    // (See Grenades.ts detonate.)
    this.enemies.interceptors.push(...this.ally.bots);
    // Enemy AI scores this registry instead of hard-coding "the player", so a
    // downed human does not make the whole roster go passive.
    this.enemies.targets.push(this.playerTarget, ...this.ally.bots);
    this.pickups = new Pickups(this.scene, this.audio, this.effects);
    this.grenades = new Grenades(this.scene, this.world.octree, this.effects, this.audio);
    this.hazards = new Hazards(this.scene, this.world.octree, this.effects, this.audio);
    this.waves = new WaveManager(this.enemies, this.world);
    this.waves.setMode(this.save.mode);
    this.waves.onMutation = (def) => {
      this.hud.showBanner(def.name.toUpperCase(), def.description);
      this.audio.record();
      this.world.applyMutation(def.fogMul, def.sunMul, def.ambientMul);
      // Record it for the death card. Without this `mutationsSeen` was written
      // nowhere, so the run summary always reported the mutations it saw as
      // none and the whole ledger rendered as empty.
      this.mutationsSeen.push(def.name);
    };
    this.waves.onBoss = (name) => {
      this.hud.showBanner(name, 'BOSS INBOUND');
      this.audio.bossSpawn();
    };
    // Run modifier banner: TLOU2 No Return style rules change per block.
    this.waves.onModifier = (mod) => {
      this.hud.showBanner(mod.name, mod.description);
      this.audio.record();
    };
    this.hazards.onDestroyed = (_hazard, byPlayer) => {
      void _hazard;
      // `barrelKills` is already incremented from the blast's real kill count
      // in hazardSink (Game.ts:528). Counting the prop here on top of that
      // counted a barrel that killed 7 enemies as 8, so the ENVIRONMENTALIST /
      // SHRINE RAIDER achievements unlocked from prop events instead of deaths.
      if (byPlayer) {
        this.score += Math.round(
          60 * this.waves.scoreMult * this.run.mods.scoreMul * this.challengeMods.scoreMul,
        );
      }
    };
    // `hazardKills` is incremented from the hazardSink for actual kills
    // (see error sink), not per activation: an activation with no enemy in its
    // radius is zero kills, not one, so the achievements gated on kill counts
    // can no longer be reached by standing next to an empty coil.
    this.hazards.onTrigger = () => { /* intentionally no-op: counted at kill time */ };
    this.grenades.onExplode = (kind, point, radius) => {
      if (kind === 'frag') this.effects.ring(point, 0xff8a3c, radius * 2.4, 0.45);
    };
    this.hud.onSlotTap = (slot) => this.input.touch.requestSlot(slot);
  }

  /**
   * Hazard damage sink. Hazards never touch the enemy or player systems
   * directly, so this adapter is the only place the two meet.
   */
  private readonly hazardSink: HazardDamageSink = {
    damageEnemiesInRadius: (point, radius, damage, floor, source) => {
      const result = this.enemies.damageArea(point, radius, damage, floor, source === 'barrel');
      if (result.killed > 0 && source === 'barrel') this.barrelKills += result.killed;
      // Non-barrel hazards (tesla coils, flame vents) must feed `hazardKills`
      // from actual kills, not from activation events.
      if (result.killed > 0 && source !== 'barrel') this.hazardKills += result.killed;
      // Barrel blasts are player damage when the player triggered them; they
      // feed the damage-dealt statistic like any other kill source.
      if (result.dealt > 0) this.onDamageDealt(result.dealt, false);
      return result.killed;
    },
    damagePlayerInRadius: (point, radius, damage, source) => {
      if (this.player.dead) return false;
      const distance = this.player.position.distanceTo(point);
      if (distance > radius) return false;
      const falloff = Math.max(0.35, 1 - distance / radius);
      this.player.damage(damage * falloff, point, source);
      return true;
    },
  };

  private wireCallbacks(): void {
    this.enemies.onEnemyKilled = this.handleKill;
    this.player.onDamaged = (from) => {
      this.hud.damageFlash();
      this.combo = 0;
      this.comboTimer = 0;
      this.waveTookDamage = true;
      // Reset the "hurt by" clock so the label always describes the newest hit.
      this.hurtAge = 0;
      // Health actually lost, after the shield ate its share: a fully absorbed
      // hit must not read as damage taken on the death card.
      this.run.stats.damageTaken += this.player.lastDamageTaken;
      if (!from) {
        this.audio.hurt();
        return;
      }
      const angle = this.damageAngle(from);
      this.hud.damageFrom(angle);
      this.audio.hurt(Math.sin(angle));
    };
    // Tougher Times: a blocked hit needs a visible answer, or the card is
    // invisible. It is deliberately NOT a damage flash — nothing was taken —
    // and it does not reset the combo, because the hit never landed.
    this.player.onBlocked = () => {
      this.hud.hitmarkerFlash('blocked');
      this.audio.blocked();
    };
    this.player.onSlide = () => {
      this.audio.dash();
    };
    this.player.onLanded = (fallSpeed) => {
      this.audio.land();
      if (fallSpeed > 6) {
        this.effects.ring(this.player.position, 0xffffff, 1.5, 0.25);
        this.effects.smoke(this.player.position);
      }
    };
    this.waves.onWaveStart = (wave) => {
      // ROTATION swaps the weapon on every kill. Without naming that on the
      // banner, a player who tried ROTATOR for the first time read the swap as
      // a bug -- 'my weapon changes by itself'. This is the disclosure the mode
      // was missing.
      const rotLabel = this.waves.isRotator ? 'ROTATION: WEAPON SWAPS ON EVERY KILL' : '';
      this.hud.showBanner(`WAVE ${wave}`, rotLabel);
      this.audio.waveStart();
      this.lastCountdown = -1;
      // Per-wave stat reset: the medal and the accuracy achievements are all
      // measured per wave, so the counters must be scoped to one.
      this.waveTookDamage = false;
      this.waveStartT = this.run.stats.timeSurvived;
    };
    this.waves.onWaveClear = (wave) => {
      // Surface the map's environmental story fragment on the first clear:
      // the arena has been read by then, so the banner lands as a beat.
      if (wave === 1) {
        const frag = this.world.themeStory[0];
        if (frag) this.hud.showBanner(this.world.themeName, frag);
      }
      // Slow-motion beat on wave clear: the rhythm release. Giving the player
      // a third of a second of near-frozen time is what makes a clear feel like
      // a victory rather than like a timer resetting.
      this.hitstopT = Math.max(this.hitstopT, 0.32);
      this.audio.waveClear();
      const bonus = Math.round(
        wave * 250 * this.waves.scoreMult * this.run.mods.scoreMul *
        this.challengeMods.scoreMul,
      );
      this.score += bonus;
      this.run.earnSalvage(SALVAGE_PER_WAVE + wave * 4);
      // Wave medal: a clean, fast clear pays extra and feeds the counters.
      const clearTime = this.run.stats.timeSurvived - this.waveStartT;
      const fast = clearTime < 20;
      if (!this.waveTookDamage) this.noHitWaves += 1;
      if (fast && (this.bestWaveTime === 0 || clearTime < this.bestWaveTime)) {
        this.bestWaveTime = clearTime;
      }
      const medal = !this.waveTookDamage && fast ? 'GOLD' : !this.waveTookDamage ? 'SILVER' : fast ? 'BRONZE' : '';
      if (medal) {
        this.hud.showBanner('WAVE CLEAR', `+${bonus}  ${medal}`);
        this.audio.achievement();
      } else {
        this.hud.showBanner('WAVE CLEAR', `+${bonus}`);
      }
      // Between-wave draft: the roguelite core loop.
      this.openDraft(wave);
    };
    this.hud.onStart = () => this.startRun();
    this.hud.onRestart = () => this.startRun();
    this.hud.onResume = () => this.resume();
    this.hud.onQuit = () => this.toMenu();
    this.hud.onSettings = (patch) => this.applySettings(patch);
    this.hud.onSeedRun = (code) => this.startSeededRun(code);
    this.hud.onDailyRun = () => this.startDailyRun();
    this.hud.onChallengeToggle = (id) => {
      const next = this.challenges.includes(id)
        ? this.challenges.filter((entry) => entry !== id)
        : [...this.challenges, id];
      this.setChallenges(next);
      // The menu readout is the source of truth for the wager, so repaint it
      // from the game's folded set rather than trusting the click order.
      this.hud.setChallengeSelection(this.challenges);
      // Persist the wager so it survives a reload instead of being re-picked
      // every session.
      this.save.challenges = this.challenges.slice();
      persistSave(this.save);
    };
    this.hud.onMode = (mode) => {
      this.save.mode = mode;
      this.waves.setMode(mode);
      this.hud.syncMode(mode);
      this.hud.setMenuBest(this.save.bestScore, this.recordWave);
      persistSave(this.save);
    };
    this.hud.onLoadoutChange = (ids) => this.setLoadout(ids);
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
    this.draft.onResolve = (result) => this.resolveDraft(result.chosen, 0);
    // `rerollCost` is NOT deducted again here: it was already charged by the
    // `spendSalvage` below, at the moment the player asked. Deducting it in
    // resolveDraft as well billed a 75-salvage reroll 150, and turned the skip
    // bonus into a net loss.
    this.draft.onReroll = (cost) => {
      if (cost > 0 && !this.run.spendSalvage(cost)) {
        this.audio.denied();
        return false;
      }
      if (cost === 0) this.run.rerolls = Math.max(0, this.run.rerolls - 1);
      this.audio.purchase();
      const offers = this.run.rollDraft(this.waves.wave);
      this.draft.show(this.waves.wave, offers, this.run.salvage, this.run.rerolls);
      return true;
    };
    this.kiosk.onPurchase = (result) => {
      // Sell rows PAY OUT: charging first would make a refund impossible to
      // afford, which is exactly backwards for the one row that is not a cost.
      const isSell = result.itemId.startsWith('sell:');
      if (!isSell && !this.run.spendSalvage(result.cost)) {
        this.audio.denied();
        return false;
      }
      const applied = this.applyKioskPurchase(result.itemId);
      if (applied) {
        this.audio.purchase();
        this.kiosk.setSalvage(this.run.salvage);
      } else if (!isSell) {
        // The purchase failed after the charge: hand the salvage back so a
        // refused item can never eat the balance.
        this.run.salvage += result.cost;
      }
      return applied;
    };
    this.kiosk.onClose = () => this.closeKiosk();
  }

  private attachLifecycle(): void {
    this.loop = new GameLoop(this.update, this.render);
    this.input.attach(this.renderer.domElement);
    this.renderer.domElement.addEventListener('click', this.onCanvasClick);
    window.addEventListener('resize', this.onResize);
    // iOS Safari moves the visual viewport (address bar) WITHOUT a reliable
    // window resize, and does it on scroll too — without these the touch
    // buttons drift away from their hit-rects.
    window.visualViewport?.addEventListener('resize', this.onResize);
    window.visualViewport?.addEventListener('scroll', this.onResize);
    // Closing the tab mid-run must still bank the lifetime counters —
    // recordRun() is otherwise only reached on death or quit-to-menu.
    window.addEventListener('pagehide', this.onPageHide);
    this.onResize();
  }

  private onPageHide = (): void => {
    if (this.phase === 'playing' || this.phase === 'paused' || this.phase === 'dead' || this.phase === 'draft' || this.phase === 'kiosk') {
      this.recordRun();
    }
  };

  private onCanvasClick = (): void => {
    this.audio.unlock();
    if (this.phase === 'playing') this.input.requestLock();
  };

  // ---------- Run lifecycle ----------

  /**
   * Start a run. `seed` defaults to a fresh random run; the daily challenge
   * passes the date-derived seed so every player on the same UTC day gets the
   * same arena, the same spawn order and the same card offers.
   */
  private startRun(seed?: number, daily = false): void {
    this.audio.unlock();
    this.cancelLockReprobe();
    this.phase = 'playing';
    this.audio.setMusicPaused(false);
    this.score = 0;
    this.kills = 0;
    this.runRecorded = false;
    this.isNewRecord = false;
    this.stepAcc = 0;
    this.lastCountdown = -1;
    this.combo = 0;
    this.comboTimer = 0;
    this.isDaily = daily;
    // Fresh run: new seeded stream, new modifier set, fresh statistics.
    const runSeed = seed ?? ((Math.random() * 0xffffffff) >>> 0);
    this.run = new Run(runSeed);
    // The mutation log is per RUN: it is rendered as "the mutations you saw"
    // on the death card, so carrying it across a restart reported the previous
    // run's weather as this run's.
    this.mutationsSeen.length = 0;
    this.waves.setRng(this.run.rng);
    this.enemies.setRng(this.run.rng);
    this.resetAbilityState();
    this.resetRunStats();
    this.applyChallenges();
    // Reset the player's mitigation to the fresh (identity) run: the armor,
    // reduction, block chance and move-speed fields the run starts with are
    // only re-derived on draft resolve, so without this a SECOND run kept the
    // first run's Plate Carrier / Wings / Tougher Times and the player walked
    // into wave 1 already armoured by a run they had already finished.
    this.applyRunMods();
    this.weapons.reset();
    this.enemies.clear();
    this.pickups.clear();
    this.grenades.clear();
    this.hazards.clear();
    this.effects.reset();
    this.viewmodel.reset();
    // The arena layout itself is part of the seed, so two players on the same
    // seed fight in the same arena, not just against the same enemies.
    this.world.rebuild(runSeed);
    this.world.applyMutation(1, 1, 1);
    this.enemies.setCoverSpots(this.world.coverSpots);
    this.hazards.spawnAll(() => this.run.rng.next(), this.world.playerSpawn, this.world.coverSpots);
    for (const [i, point] of this.world.pickupPoints.entries()) {
      this.pickups.spawnAt(i % 2 === 0 ? 'health' : 'ammo', point);
    }
    this.resetPlayer();
    this.pLast.copy(this.player.position);
    this.waves.reset();
    this.waves.setCurse(this.run.curseCountMul, this.run.curseHpMul);
    this.waves.setChallenges(
      this.challengeMods.enemyCountMul,
      this.challengeMods.enemyHpMul,
      this.challengeMods.enemySpeedMul,
      this.challengeMods.extraAffixes,
    );
    this.ally.deploy(this.player.position);
    this.hud.showMenu(false);
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.setSeedCode(seedToCode(runSeed), daily);
    const tag = this.challenges.length > 0
      ? challengeLabel(this.challenges)
      : seedToCode(runSeed);
    this.hud.showBanner(daily ? 'DAILY DEPLOYMENT' : 'DEPLOYED', tag);
    this.input.resetTransient();
    this.input.requestLock();
  }

  /**
   * Fold the selected challenges into the systems that read them. Called on
   * every run start, and again whenever the menu selection changes, so the
   * menu's live payout readout and the run agree by construction.
   */
  private applyChallenges(): void {
    this.challengeMods = foldChallenges(this.challenges);
    this.player.incomingDamageMul = this.challengeMods.playerDamageMul;
    this.weapons.challengeSpreadMul = this.challengeMods.playerSpreadMul;
    this.weapons.challengeAmmoMul = this.challengeMods.playerAmmoMul;
    this.waves.setChallenges(
      this.challengeMods.enemyCountMul,
      this.challengeMods.enemyHpMul,
      this.challengeMods.enemySpeedMul,
      this.challengeMods.extraAffixes,
    );
    this.player.applyMods(this.run.mods.maxHealthMul * this.challengeMods.playerHpMul);
  }

  /**
   * Toggle one challenge in the menu selection. `null` clears the selection
   * (used by the mode chips, which own the base ruleset).
   */
  public setChallenges(ids: readonly ChallengeId[] | null): void {
    this.challenges = ids ? [...ids] : [];
    this.challengeMods = foldChallenges(this.challenges);
  }

  /**
   * Equip a loadout from the menu. The kit is persisted, because choosing four
   * weapons and then losing them on reload would make the choice pointless.
   * `persist` is false during boot so loading a save does not immediately
   * rewrite it.
   */
  public setLoadout(ids: readonly string[], persist = true): void {
    const clean = sanitizeLoadout(ids);
    this.weapons.setLoadout(clean);
    // A loadout change while a run is live must not leave the player holding a
    // weapon that is no longer in the kit, so the controller re-slots to the
    // first equipped weapon.
    this.weapons.reslot();
    this.syncLoadoutReadout();
    this.hud.setLoadoutSelection(clean);
    if (!persist) return;
    this.save.loadout = clean.slice();
    persistSave(this.save);
  }

  /** Start today's shared-seed run. */
  private startDailyRun(): void {
    this.startRun(dailySeed(), true);
  }

  /** Start a run from a code the player typed or was given. */
  private startSeededRun(code: string): void {
    const seed = codeToSeed(code);
    this.startRun(seed, false);
  }

  private resetAbilityState(): void {
    const mods = this.run.mods;
    this.dashCharges = DASH_CHARGES + mods.dashChargesBonus;
    this.dashRecharge = 0;
    this.dashT = 0;
    this.player.clearInvulnerable();
    this.grenadeCharges = GRENADE_CHARGES + mods.grenadeChargesBonus;
    this.grenadeRecharge = 0;
    this.grenadeCook = 0;
    this.grenadeKind = 'frag';
    this.meleeT = 0;
    this.maxDashCharges = DASH_CHARGES + mods.dashChargesBonus;
    this.maxGrenadeCharges = GRENADE_CHARGES + mods.grenadeChargesBonus;
  }

  private resetRunStats(): void {
    this.waveTookDamage = false;
    this.waveStartT = 0;
    // 99 is the "no label" sentinel used at construction. `hurtAge` is only
    // zeroed when the player is hit, so a run that ended in death otherwise
    // started its successor with the old label still inside its 2.4 s window.
    this.hurtAge = 99;
    this.bestWaveTime = 0;
    this.noHitWaves = 0;
    this.eliteKills = 0;
    this.bossKills = 0;
    this.barrelKills = 0;
    this.hazardKills = 0;
    this.meleeKills = 0;
    this.grenadeKills = 0;
    this.dashKills = 0;
    this.lifestealHealed = 0;
    this.longestCombo = 0;
    this.pendingMeleeKill = false;
    this.pendingGrenadeKill = false;
    this.pendingDashKill = false;
    this.meleeKillT = 0;
    this.grenadeKillT = 0;
  }

  private maxDashCharges = DASH_CHARGES;
  private maxGrenadeCharges = GRENADE_CHARGES;
  private isDaily = false;
  /** Opt-in difficulty wagers for the live run (see game/Challenges.ts). */
  private challenges: ChallengeId[] = [];
  private challengeMods: ChallengeMods = foldChallenges([]);

  /** Open the between-wave draft and freeze the sim behind it. */
  private openDraft(wave: number): void {
    // Every third wave also opens the kiosk first, so the player spends before
    // they commit a card. Two decisions back to back is the intended rhythm.
    if (wave % 3 === 0 && this.run.salvage >= 40) {
      this.openKiosk();
      return;
    }
    this.showDraft(wave);
  }

  private showDraft(wave: number): void {
    const offers = this.run.rollDraft(wave);
    if (offers.length === 0) {
      // Everything is maxed: do not block the run on an empty draft.
      this.resumeAfterIntermission();
      return;
    }
    this.phase = 'draft';
    document.exitPointerLock();
    this.draft.show(wave, offers, this.run.salvage, this.run.rerolls);
  }

  private resolveDraft(chosen: string | null, _rerollCost: number): void {
    void _rerollCost;    if (chosen) {
      const id = chosen as UpgradeId;
      if (UPGRADES[id]) {
        this.run.take(id);
        this.run.sync();
        this.applyRunMods();
        this.audio.upgrade();
        this.hud.showBanner(UPGRADES[id].name.toUpperCase(), UPGRADES[id].description);
      }
    } else {
      // Skipping pays salvage: an unspent card is not wasted, it is banked.
      this.run.earnSalvage(45);
    }
    // `rerollCost` used to be deducted here a second time. It is now charged once,
    // at the moment of reroll, by Draft.onReroll -> Run.spendSalvage.
    this.draft.hide();
    this.resumeAfterIntermission();
  }

  /**
   * Push the run's aggregate modifiers into the systems that read them.
   *
   * This is the ONLY place a card reaches the simulation, which is why every
   * field of `PlayerMods` has to be forwarded here. A field that is written by
   * a card but never forwarded is an upgrade that silently does nothing — the
   * player pays a draft pick for it and gets no feedback either way.
   */
  private applyRunMods(): void {
    const mods = this.run.mods;
    // Challenge HP multiplies the card HP; the run-start path applies the same
    // product, so a mid-run card cannot quietly erase the wager's health cost.
    this.player.applyMods(mods.maxHealthMul * this.challengeMods.playerHpMul);
    this.weapons.setMods(mods);
    this.waves.setCurse(this.run.curseCountMul, this.run.curseHpMul);
    // Damage mitigation and mobility, funnelled through the player because
    // Player.damage and Player.update are the single choke points for them.
    this.player.setFlatArmor(mods.flatArmor);
    this.player.setDamageReduction(mods.damageReduction);
    this.player.setSprintArmor(mods.sprintArmor);
    this.player.setBlockChance(mods.blockChance);
    this.player.cardMoveMul = mods.moveSpeedMul;
    this.player.setRevives(this.run.stackOf('deathDefiance'));
    // Ability capacity can change mid-run when a card grants a charge.
    this.maxDashCharges = DASH_CHARGES + mods.dashChargesBonus;
    this.maxGrenadeCharges = GRENADE_CHARGES + mods.grenadeChargesBonus;
    this.dashCharges = Math.min(this.maxDashCharges, this.dashCharges);
    this.grenadeCharges = Math.min(this.maxGrenadeCharges, this.grenadeCharges);
  }

  private openKiosk(): void {
    this.phase = 'kiosk';
    document.exitPointerLock();
    this.kiosk.show(this.buildKioskItems(), this.run.salvage);
  }

  private closeKiosk(): void {
    this.kiosk.hide();
    // The kiosk always leads into the draft: spend, then commit.
    this.showDraft(this.waves.wave);
  }

  private buildKioskItems(): KioskItem[] {
    const full = this.player.health >= this.player.maxHealth - 0.5;
    const cheap = this.run.salvage >= 120;
    const items: KioskItem[] = [
      {
        id: 'repair',
        name: 'Field Repair',
        description: 'Restore 45 health.',
        cost: 60,
        available: !full,
        ...(full ? { unavailableReason: 'AT FULL HEALTH' } : {}),
      },
      {
        id: 'armory',
        name: 'Armory Drop',
        description: 'Refill every weapon reserve and magazine.',
        cost: 80,
        available: true,
      },
      {
        id: 'reroll',
        name: 'Intel Sweep',
        description: 'One extra free draft reroll.',
        cost: 50,
        available: true,
      },
      {
        id: 'shield',
        name: 'Reactive Plating',
        description: 'Absorb the next 60 damage this run.',
        cost: 120,
        available: cheap,
        ...(cheap ? {} : { unavailableReason: 'NEED 120 SALVAGE' }),
      },
    ];
    // Sell-back: one row per upgrade stack owned, paying 40% of its draft
    // value. It keeps the kiosk a two-way economy (a bad early pick is not a
    // permanent tax) and gives Run.refund a real caller. The ids are prefixed
    // so a sell row can never collide with a purchase row.
    for (const [id, count] of this.run.stacks) {
      const card = UPGRADES[id];
      if (!card || count <= 0) continue;
      items.push({
        id: `sell:${id}`,
        name: `Sell ${card.name}`,
        description: `Refund one stack (${count} owned).`,
        cost: SELL_REFUND_RATE * CARD_VALUE,
        available: true,
        sell: true,
      });
    }
    return items;
  }

  private applyKioskPurchase(itemId: string): boolean {
    if (itemId === 'repair') {
      this.player.heal(45);
      return true;
    }
    if (itemId === 'armory') {
      this.weapons.refillReserve();
      for (const state of this.weapons.allStates()) {
        state.mag = state.def.magSize;
      }
      return true;
    }
    if (itemId === 'reroll') {
      this.run.rerolls += 1;
      return true;
    }
    if (itemId === 'shield') {
      this.player.addShield(60);
      return true;
    }
    if (itemId.startsWith('sell:')) {
      const id = itemId.slice('sell:'.length) as UpgradeId;
      if (!UPGRADES[id] || this.run.stackOf(id) <= 0) return false;
      this.run.refund(id);
      this.run.sync();
      this.applyRunMods();
      this.run.earnSalvage(SELL_REFUND_RATE * CARD_VALUE);
      return true;
    }
    return false;
  }

  /** Unfreeze the sim after a draft or kiosk closes. */
  private resumeAfterIntermission(): void {
    this.phase = 'playing';
    // Same reason as pause(): a draft or kiosk ending must not commit a grenade
    // that was being cooked when the intermission began.
    this.grenadeCook = 0;
    this.input.resetTransient();
    this.input.requestLock();
  }

  /**
   * Cancel the post-resume lock re-probe. It is armed for 300 ms and nothing
   * else clears it, so without this a restart (or a trip to the menu) inside
   * that window let the stale probe fire `pause()` against the brand-new run
   * and freeze it behind the pause overlay with no input from the player.
   */
  private cancelLockReprobe(): void {
    if (this.lockReprobeTimer === 0) return;
    window.clearTimeout(this.lockReprobeTimer);
    this.lockReprobeTimer = 0;
  }

  private pause(): void {
    if (this.phase !== 'playing') return;
    this.phase = 'paused';
    // Drop any grenade being cooked. `resetTransient()` below clears
    // `grenadeHeld`, and the cook branch treats a released button as a commit,
    // so without this a pause (lock loss, alt-tab) or a draft ending while G was
    // held threw a grenade the instant the sim resumed.
    this.grenadeCook = 0;
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
    this.cancelLockReprobe();
    this.lockReprobeTimer = window.setTimeout(() => {
      this.lockReprobeTimer = 0;
      if (this.phase === 'playing' && !this.input.lockedNow) this.pause();
    }, 300);
  }

  private toMenu(): void {
    if (this.phase === 'menu') return;
    this.cancelLockReprobe();
    this.phase = 'menu';
    this.audio.setMusicPaused(false);
    this.recordRun();
    this.enemies.clear();
    this.pickups.clear();
    this.grenades.clear();
    this.hazards.clear();
    this.waves.reset();
    this.ally.stow();
    this.effects.reset();
    this.viewmodel.reset();
    this.draft.hide();
    this.kiosk.hide();
    this.resetPlayer();
    this.combo = 0;
    this.comboTimer = 0;
    this.world.applyMutation(1, 1, 1);
    this.hud.showPause(false);
    this.hud.showDeath(false);
    this.hud.showMenu(true);
    this.hud.setMenuBest(this.save.bestScore, this.recordWave);
    this.hud.setMenuRecords(this.save);
    this.hud.setAchievements(this.unlocked, this.counters);
  }

  private onDeath(): void {
    // Death Defiance: a banked revive turns the killing blow into a reset
    // instead of a run summary. It is checked HERE, at the one place the run
    // can end, so every damage source is covered by construction.
    if (this.player.tryRevive()) {
      this.hitstopT = Math.max(this.hitstopT, 0.22);
      this.effects.ring(this.player.position, 0xffd76b, 7, 0.6);
      this.effects.burst(this.player.position, 0xffd76b, 24, 3);
      this.audio.achievement();
      this.hud.showBanner('DEATH DEFIANCE', 'BACK ON YOUR FEET');
      // Coming back must not be silent about what it cost: the combo is gone
      // either way, so the reset is the same as a hit.
      this.combo = 0;
      this.comboTimer = 0;
      return;
    }
    this.phase = 'dead';
    this.input.resetTransient();
    this.audio.setMusicPaused(false);
    this.audio.heartbeat(0, 0);
    document.exitPointerLock();
    this.draft.hide();
    this.kiosk.hide();
    this.isNewRecord = this.recordRun();
    if (this.isNewRecord) this.audio.record();
    this.hud.showDeath(true, {
      wave: this.waves.wave,
      kills: this.kills,
      score: this.score,
      bestScore: this.save.bestScore,
      isNewRecord: this.isNewRecord,
      mode: this.save.mode,
      // Run summary, straight off the live Run object.
      accuracy: this.run.stats.shotsFired > 0
        ? this.run.stats.shotsHit / this.run.stats.shotsFired
        : 0,
      headshots: this.run.stats.headshots,
      timeSurvived: this.run.stats.timeSurvived,
      damageDealt: Math.round(this.run.stats.damageDealt),
      damageTaken: Math.round(this.run.stats.damageTaken),
      longestCombo: this.longestCombo,
      elitesKilled: this.eliteKills,
      bossesKilled: this.bossKills,
      salvageEarned: this.run.stats.salvageEarned,
      upgrades: this.run.taken.slice(),
      noHitWaves: this.noHitWaves,
      seedCode: seedToCode(this.run.seed),
      isDaily: this.isDaily,
      mutationsSeen: this.mutationsSeen.slice(),
    });
  }

  /** Mutation names seen this run, for the death-card ledger. */
  private readonly mutationsSeen: string[] = [];

  /**
   * Fold the finished run into the save, the lifetime counters and the
   * achievement tracker. Called from death, quit-to-menu and pagehide, so it
   * must be idempotent (guarded by `runRecorded`).
   */
  private recordRun(): boolean {
    if (this.runRecorded) return false;
    this.runRecorded = true;
    // Lifetime counters record every run — even a scoreless one.
    this.save.totalRuns += 1;
    this.save.totalKills += this.kills;
    this.save.totalWavesCleared += this.waves.cleared;
    this.save.killsPerMode[this.save.mode] =
      (this.save.killsPerMode[this.save.mode] ?? 0) + this.kills;
    const isRecord = this.score > 0 && this.score > this.save.bestScore;
    if (isRecord) this.save.bestScore = this.score;
    if (this.save.mode === 'overrun') {
      if (this.waves.wave > this.save.bestWaveOverrun) {
        this.save.bestWaveOverrun = Math.min(9999, this.waves.wave);
      }
    } else if (this.waves.wave > this.save.bestWave) {
      this.save.bestWave = Math.min(9999, this.waves.wave);
    }
    // Run summary into the lifetime counters, then evaluate achievements.
    const result: RunResult = {
      kills: this.kills,
      headshots: this.run.stats.headshots,
      shotsFired: this.run.stats.shotsFired,
      shotsHit: this.run.stats.shotsHit,
      wave: this.waves.wave,
      wavesCleared: this.waves.cleared,
      mode: this.save.mode,
      timeSurvived: this.run.stats.timeSurvived,
      damageDealt: this.run.stats.damageDealt,
      longestCombo: this.longestCombo,
      elitesKilled: this.eliteKills,
      bossesKilled: this.bossKills,
      barrelKills: this.barrelKills,
      hazardKills: this.hazardKills,
      meleeKills: this.meleeKills,
      grenadeKills: this.grenadeKills,
      dashKills: this.dashKills,
      noHitWaves: this.noHitWaves,
      cardsInRun: this.run.taken.length,
      maxedTags: this.countMaxedTags(),
      upgradesTaken: this.run.taken.length,
      lifestealHealed: this.lifestealHealed,
      accuracyBestWave: this.run.stats.shotsFired > 0
        ? this.run.stats.shotsHit / this.run.stats.shotsFired
        : 0,
      styleRank: this.styleRank(),
      isDaily: this.isDaily,
      died: this.player.dead,
      bestWaveTime: this.bestWaveTime,
    };
    applyRun(this.counters, result);
    const fresh = this.tracker.evaluate(this.counters, this.unlocked);
    for (const id of fresh) {
      this.unlocked.add(id);
      this.queue.push(id);
    }
    persistSave(this.save);
    return isRecord;
  }

  /** Number of upgrade ids held at 3+ stacks, for the Specialist achievement. */
  private countMaxedTags(): number {
    let count = 0;
    for (const n of this.run.stacks.values()) {
      if (n >= 3) count += 1;
    }
    return count;
  }

  /**
   * Style rank D..SSS, the ULTRAKILL model: kill streak and headshot rate
   * dominate, taking damage demotes. It is a read on how the run is GOING, not
   * on how long it lasted.
   */
  private styleRank(): number {
    if (this.run.stats.timeSurvived <= 0) return 1;
    const kpm = this.kills / (this.run.stats.timeSurvived / 60);
    const accuracy = this.run.stats.shotsFired > 0
      ? this.run.stats.shotsHit / this.run.stats.shotsFired
      : 0;
    const score = kpm * 0.35 + accuracy * 4 + this.longestCombo * 0.12;
    if (score >= 14) return 7;
    if (score >= 11) return 6;
    if (score >= 8.5) return 5;
    if (score >= 6.5) return 4;
    if (score >= 4.5) return 3;
    if (score >= 2.5) return 2;
    return 1;
  }

  /** Drain the achievement popup queue into the HUD, a few at a time. */
  private flushAchievements(): void {
    if (this.queue.length === 0) return;
    const id = this.queue.shift();
    if (!id) return;
    const def = ACHIEVEMENTS[id];
    if (!def) return;
    this.hud.showAchievement(def.name, def.description);
    this.audio.achievement();
  }

  private applySettings(patch: SettingsPatch): void {
    if (patch.sensitivity !== undefined) {
      this.save.sensitivity = clamp(patch.sensitivity, 0.2, 3);
      this.player.setSensitivity(this.save.sensitivity);
    }
    if (patch.touchSensitivity !== undefined) {
      this.save.touchSensitivity = clamp(patch.touchSensitivity, 0.2, 3);
      this.input.touch.setSensitivity(this.save.touchSensitivity);
    }
    if (patch.quality !== undefined) {
      this.save.quality = patch.quality;
      // Switching preset re-resolves the whole render configuration.
      this.applyQuality();
    }
    if (patch.volume !== undefined) {
      this.save.volume = clamp(patch.volume, 0, 1);
      this.audio.setVolume(this.save.volume);
    }
    persistSave(this.save);
    this.hud.syncSettings(
      this.save.sensitivity,
      this.save.volume,
      this.save.touchSensitivity,
      this.save.quality,
    );
  }

  /** Re-resolve the quality preset and push it at the renderer. */
  private applyQuality(): void {
    this.quality = presetFor(resolveTier(this.save.quality, detectTier()));
    this.governor.reset();
    this.renderer.shadowMap.enabled = this.quality.shadows;
    this.renderer.setPixelRatio(this.pixelRatio());
    if (this.quality.shadows) this.refreshShadows();
  }

  /** Preset cap times the governor's step, floored so it never hits zero.
   *  The cap bounds `devicePixelRatio` — it is NOT an absolute ratio, or a
   *  dpr-1 monitor would be forced to render ABOVE its native resolution. */
  private pixelRatio(): number {
    const cap = this.quality.pixelRatioCap * this.governor.scale;
    return Math.max(0.25, Math.min(window.devicePixelRatio || 1, cap));
  }

  /**
   * Re-arm the baked static shadow map. World disables `autoUpdate` for the
   * sun (static geometry), so toggling shadows back on would otherwise leave
   * the stale/empty map from whenever it was last baked.
   */
  private refreshShadows(): void {
    this.world.setShadowMapSize(this.quality.shadowMapSize);
  }

  /** Menu shows the record belonging to the currently selected mode. */
  private get recordWave(): number {
    return this.save.mode === 'overrun' ? this.save.bestWaveOverrun : this.save.bestWave;
  }

  private resetPlayer(): void {
    this.player.reset(this.world.playerSpawn, Math.PI);
  }

  // ---------- Frame update ----------

  private update = (dt: number): void => {
    // Hitstop: the sim crawls for a few frames so a heavy hit has weight. The
    // scale is 0.12 rather than 0 so nothing deadlocks (timers still tick) and
    // so the freeze ends smoothly instead of snapping back.
    if (this.hitstopT > 0) {
      this.hitstopT -= dt;
      dt *= 0.12;
    }
    const frame = this.input.read();
    if (this.phase === 'paused' || this.phase === 'draft' || this.phase === 'kiosk') {
      // The draft and kiosk freeze the world but keep rendering: the arena
      // behind the panel must stay alive or the pause reads as a crash.
      this.world.update(dt);
      return;
    }
    this.updateMusic();
    this.audio.musicTick();
    // The audio listener rides the player's eye and yaw. Every positional
    // sound resolves its pan and distance against this frame, which is what
    // keeps a sound on the same side of the player's head as they turn.
    this.audio.setListener(
      this.player.position.x,
      this.player.position.z,
      this.player.yawAngle,
    );
    this.flushAchievements();
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
    this.run.tick(dt);
    this.updateAbilities(dt, frame);
    // The weapon owns the optic and the weight: a scoped rifle really zooms and
    // a heavy gun really slows the walk. Both are read here rather than inside
    // Player, so Player never has to know weapons exist.
    this.player.adsFov = this.weapons.adsFov();
    this.player.weaponMoveMul = this.weapons.moveMul;
    this.player.recoilRecoveryMul = this.weapons.recoilRecoveryMul;
    this.player.update(dt, frame, this.dashT > 0 ? this.dashDir : null);
    // The damage-source label fades after a couple of seconds: it must describe
    // the hit the player just felt, not linger as a permanent banner.
    this.hurtAge += dt;
    // Player velocity is read straight off PlayerTarget.velocity (the player
    // integrates it), so no separate sampling pass is needed here.
    this.pLast.copy(this.player.position);
    this.comboTimer -= dt;
    if (this.comboTimer <= 0 && this.combo > 0) {
      this.combo = Math.max(0, this.combo - 1); // one tier per lapse
      this.comboTimer = this.combo > 0 ? COMBO_DECAY : 0;
    }
    if (this.comboTimer < 0) this.comboTimer = 0;
    this.weapons.damageScale = this.waves.damageScale;
    this.weapons.update(frame, dt);
    this.viewmodel.setWeapon(this.weapons.current.def.id);
    const wv = this.weapons.view();
    this.viewmodel.update(dt, {
      speed: this.player.horizontalSpeed,
      sprinting: this.player.isSprinting,
      aimHeld: frame.aimHeld,
      // Cosmetic sway uses the last frame's consumed look delta — the real
      // look already happened at render rate, this only leans the gun.
      lookX: this.frameLook.x,
      lookY: this.frameLook.y,
      reloading: wv.reloading,
      reloadProgress: wv.reloadProgress,
    });
    this.waves.update(dt, this.player.position);
    // Smoke and EMP fields feed the enemy perception and shield systems, which
    // is what turns the two support grenades into mechanical tools rather than
    // visual effects. Cheap: both reads are a short field-list scan.
    this.enemies.smokeBlocks = (point) => this.grenades.isSmoked(point);
    // A probe, not a value: each enemy is tested against its own position, so an
    // EMP strips the shields of the enemies standing in it.
    this.enemies.shieldsDisabled = (point) => this.grenades.isEmped(point);
    // The arena mutation's visibility contract: every mutation advertises a
    // sight reduction ("Enemies see 30% less far") and this is what makes that
    // true rather than atmospheric copy.
    this.enemies.sightMul = this.waves.sightMul;
    // HOT ZONE: killed enemies drop live grenades while the modifier is up.
    this.enemies.deathGrenades = this.waves.activeModifier?.deathGrenades === true;
    this.enemies.shieldBreakBonus = this.run.mods.shieldBreakBonus;
    this.enemies.playerYaw = this.player.yawAngle;
    this.enemies.update(
      dt,
      this.player.position,
      this.player.dead,
      this.weapons.lastShot,
    );
    this.weapons.lastShot = null;
    // Hazards and grenades resolve AFTER the enemy step so their damage lands
    // on the same tick the player saw them fire.
    this.hazards.update(dt, this.hazardSink, this.player.position);
    this.grenades.update(dt, (point, radius, damage, floor) => {
      const result = this.enemies.damageArea(
        point,
        radius,
        damage * this.run.mods.blastDamageMul,
        floor,
        true,
      );
      // Grenade blast damage feeds the same run statistics as gunfire, and
      // lifesteal applies to it exactly as it does to a bullet.
      if (result.dealt > 0) this.onDamageDealt(result.dealt, false);
      return result;
    }, (point, radius, damage, source) => {
      // HOT ZONE self-damage: the detonate callback now also calls player.
      // damage via the hazard sink pattern (falloff + cap), so a modifier
      // that promised 'back out or catch it' actually hurts you.
      if (this.player.dead) return;
      const distance = this.player.position.distanceTo(point);
      if (distance > radius) return;
      const falloff = Math.max(0.45, 1 - distance / radius);
      this.player.damage(Math.min(35, damage * falloff), point, source);
    });
    this.ally.update(dt, this.player.position, this.enemies, this.waves.damageScale);
    // Affix riders on the player: burn damage and the Glacial slow. The burn
    // names its source: a damage-over-time with no visible attacker is the
    // single most confusing way to lose health.
    const afflict = this.enemies.tickPlayerAffixes(dt);
    if (afflict.burnDamage > 0) this.player.damage(afflict.burnDamage, null, 'AFFIX BURN');
    this.player.setSlow(afflict.slowFraction);
    // Passive regeneration from cards. A NEGATIVE rate is a bleed and must
    // drain rather than heal: Bloody Hand advertises "you take 1 damage per
    // second" and pays for it with 6% lifesteal, but the old `> 0` guard
    // silently discarded the downside, so the card was pure upside and its
    // stated cost was a lie the player could not even measure.
    const regen = this.run.mods.regen;
    if (regen > 0) {
      this.player.heal(regen * dt);
    } else if (regen < 0) {
      this.player.drain(-regen * dt);
    }

    // Footsteps: stride-linked distance cadence while grounded
    const speed = this.player.horizontalSpeed;
    if (speed > 1.2 && this.player.isGrounded) {
      this.stepAcc += speed * dt;
      if (this.stepAcc >= 2.6) {
        this.stepAcc = 0;
        this.audio.step(this.world.surfaceAt(this.player.position.x, this.player.position.z));
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

    // A pickup the player cannot benefit from is left on the ground rather
    // than consumed. Destroying a health drop at full HP punishes the kill
    // that produced it, invisibly: the item simply ceases to exist as you
    // touch it, and nothing about that reads as intentional. Salvage is
    // currency and is always wanted.
    const collected = this.pickups.tryCollect(this.player.position, (kind) => {
      if (kind === 'salvage') return true;
      if (kind === 'health') return this.player.health < this.player.maxHealth - 0.5;
      return this.weapons.needsAmmo();
    });
    if (collected === 'health') this.player.heal(HEALTH_PICKUP);
    if (collected === 'ammo') this.weapons.refillReserve();
    if (collected === 'salvage') {
      this.run.earnSalvage(SALVAGE_PICKUP);
      this.hud.popScore(SALVAGE_PICKUP, true);
    }

    this.audio.heartbeat(this.player.health / this.player.maxHealth, dt);

    if (this.player.dead) this.onDeath();
  }

  /**
   * Dash, grenade, and melee. All three live in the orchestrator because they
   * each need the player, the enemy roster and the effects at once, which is
   * exactly the seam the orchestrator exists to own.
   */
  private updateAbilities(dt: number, frame: InputFrame): void {
    const mods = this.run.mods;
    // The invulnerability window lives on the player, because Player.damage is
    // the single funnel every damage source passes through.
    this.player.tickInvulnerable(dt);
    this.meleeT = Math.max(0, this.meleeT - dt);
    // Attribution windows close on their own clock, so a grenade that lands
    // long after the throw still owns its kills and a rifle kill two seconds
    // later does not steal them.
    if (this.meleeKillT > 0) {
      this.meleeKillT = Math.max(0, this.meleeKillT - dt);
      if (this.meleeKillT === 0) this.pendingMeleeKill = false;
    }
    if (this.grenadeKillT > 0) {
      this.grenadeKillT = Math.max(0, this.grenadeKillT - dt);
      if (this.grenadeKillT === 0) this.pendingGrenadeKill = false;
    }

    // ---- Dash ----
    if (this.dashT > 0) {
      this.dashT = Math.max(0, this.dashT - dt);
      if (this.dashT <= 0) {
        this.player.clearDash();
        // The dash kill window IS the dash: once the movement is over, a kill
        // can no longer be "while dashing", so the claim closes with it.
        this.pendingDashKill = false;
      }
    }
    if (this.dashCharges < this.maxDashCharges) {
      this.dashRecharge += dt * mods.dashRechargeMul;
      if (this.dashRecharge >= DASH_COOLDOWN) {
        this.dashRecharge = 0;
        this.dashCharges += 1;
      }
    }
    if (frame.dashPressed && this.dashCharges > 0 && this.dashT <= 0) {
      this.dashCharges -= 1;
      if (this.dashRecharge <= 0) this.dashRecharge = 0.001;
      this.dashT = DASH_TIME;
      this.player.setInvulnerable(DASH_INVULN + mods.dashInvulnBonus);
      this.dashDir.copy(this.dashInputDirection(frame));
      this.player.startDash(this.dashDir, DASH_SPEED, DASH_TIME);
      this.effects.ring(this.player.position, 0xff9f1c, 2.6, 0.3);
      // The dash sweeps the weapon across the screen, so it gets a trail too.
      // Swing direction alternates so two swings never read the same way -- the
    // 'oomph' Apex's animators chase.
    this.viewmodel.swingTrail(this.meleeSwingSide);
      this.audio.dash();
      this.pendingDashKill = true;
    }

    // ---- Grenade ----
    if (this.grenadeCharges < this.maxGrenadeCharges) {
      this.grenadeRecharge += dt * mods.grenadeRechargeMul;
      if (this.grenadeRecharge >= GRENADE_COOLDOWN) {
        this.grenadeRecharge = 0;
        this.grenadeCharges += 1;
      }
    }
    if (frame.grenadeCyclePressed) {
      this.grenadeKind = this.grenadeKind === 'frag'
        ? 'smoke'
        : this.grenadeKind === 'smoke'
          ? 'emp'
          : 'frag';
      this.audio.weaponSwitch();
    }
    // A tap never throws. Even a 60 ms press starts cooking (the cook grows
    // every tick), so without this branch the release path would fire a dud
    // and spend a charge the player meant to spend on a cycle. Zeroing the
    // cook is what disarms the release branch below.
    if (frame.grenadeTap) {
      this.grenadeCook = 0;
    } else if (frame.grenadeHeld && this.grenadeCharges > 0 && this.dashT <= 0) {
      // Cooking is what turns a throw into an aimed weapon: hold to build
      // power, release to commit. A tap drops it at your feet.
      this.grenadeCook = Math.min(1, this.grenadeCook + dt / 1.1);
    } else if (this.grenadeCook > 0) {
      this.throwGrenade();
      this.grenadeCook = 0;
    }

    // ---- Melee ----
    if (frame.meleePressed && this.meleeT <= 0) {
      this.meleeT = MELEE_COOLDOWN;
      this.doMelee();
    }
  }

  /** Dash direction: the movement input if any, otherwise straight ahead. */
  private dashInputDirection(frame: InputFrame): THREE.Vector3 {
    const out = new THREE.Vector3();
    if (frame.moveX !== 0 || frame.moveZ !== 0) {
      const yaw = this.player.inputYaw;
      const forward = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
      const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
      out.addScaledVector(forward, -frame.moveZ).addScaledVector(right, frame.moveX);
      if (out.lengthSq() > 1e-6) return out.normalize();
    }
    return this.player.forward(out);
  }

  private throwGrenade(): void {
    if (this.grenadeCharges <= 0) return;
    this.grenadeCharges -= 1;
    if (this.grenadeRecharge <= 0) this.grenadeRecharge = 0.001;
    const dir = new THREE.Vector3();
    this.player.forward(dir);
    const eye = new THREE.Vector3();
    this.player.eyePosition(eye);
    this.grenades.throwGrenade(this.grenadeKind, eye, dir, this.grenadeCook);
    this.pendingGrenadeKill = true;
    this.grenadeKillT = GRENADE_KILL_WINDOW;
  }

  /**
   * Quick melee. Three outcomes, in priority order:
   *  1. A wounded enemy inside range is EXECUTED: instant kill, a heal, and a
   *     short invulnerability window. This is the glory kill, and it is what
   *     makes closing on a low-health enemy a real option instead of a risk.
   *  2. Any enemy inside range takes melee damage plus a short lunge, so the
   *     swing connects on a moving target.
   *  3. Nothing in range: a swing at air, so the input is always answered.
   */
  private doMelee(): void {
    const eye = new THREE.Vector3();
    this.player.eyePosition(eye);
    const forward = new THREE.Vector3();
    this.player.forward(forward);

    let best: Enemy | null = null;
    let bestScore = Number.POSITIVE_INFINITY;
    this.enemies.forEachLive((enemy) => {
      const dx = enemy.group.position.x - eye.x;
      const dz = enemy.group.position.z - eye.z;
      const distance = Math.hypot(dx, dz);
      if (distance > MELEE_RANGE) return;
      const dot = (dx / (distance || 1)) * forward.x + (dz / (distance || 1)) * forward.z;
      if (dot < 0.35) return; // behind or too far off-axis
      const score = distance - dot;
      if (score >= bestScore) return;
      bestScore = score;
      best = enemy;
    });

    // Alternate the swing direction: two identical swings in a row read as a
    // single repeated animation, which is the 'one sample forever' tell.
    this.meleeSwingSide = this.meleeSwingSide === 1 ? -1 : 1;
    this.audio.swing();
    // Motion trail along the swing: the eye follows the arc, so the hit
    // reads as a sweep rather than a jump cut (Avowed's lesson).
    this.viewmodel.swingTrail(this.meleeSwingSide);
    if (!best) {
      this.effects.burst(eye.clone().addScaledVector(forward, 1.4), 0xded2aa, 4, 1.2);
      return;
    }
    const target: Enemy = best;
    const at = target.group.position.clone().setY(target.group.position.y + 1);
    this.pendingMeleeKill = true;
    this.meleeKillT = MELEE_KILL_WINDOW;
    const canExecute = target.health / target.def.health <= EXECUTE_THRESHOLD;
    if (canExecute) {
      this.effects.ring(at, 0xffd76b, 4, 0.35);
      this.effects.burst(at, 0xffd76b, 14, 2.2);
      this.audio.slashHit();
      this.audio.eliteKill();
      this.enemies.damageEnemy(target, target.health + 1, at, undefined, true, PLAYER_TARGET_ID);
      this.player.heal(EXECUTE_HEAL);
      this.player.setInvulnerable(0.5);
      // NO extra meleeKills here: damageEnemy reports the death synchronously
      // through onEnemyKilled -> handleKill, which counts it under
      // `pendingMeleeKill`. Adding it here as well double-counted every execute,
      // so MELEE MAYHEM unlocked at 13 real kills and the death card reported
      // twice the melee kills that happened. The non-execute branch below is
      // counted the single correct way.
      return;
    }
    const damage = MELEE_DAMAGE * this.run.mods.meleeMul * this.waves.damageScale;
    this.enemies.damageEnemy(target, damage, at, forward, true, PLAYER_TARGET_ID);
    // 35 ms hitstop on a connecting swing: the 'I connected' beat.
    this.hitstopT = Math.max(this.hitstopT, 0.035);
    this.effects.impact(at, forward.clone().negate());
    this.audio.slashHit();
    // Lunge: the melee closes the last metre so it connects on a moving target.
    // BOTH halves are required. `Player.update` only applies a dash when it is
    // handed a dashDir, and that argument is gated on `Game.dashT` -- so calling
    // `startDash` alone filled the player's `dashRemaining` and then did nothing,
    // leaving the documented lunge a pure no-op. `dashT` is safe to set directly:
    // dash charges are spent only in the dash branch, and `pendingDashKill` is
    // set only there too, so a lunge cannot consume a charge or claim a kill.
    this.player.startDash(forward, MELEE_LUNGE, MELEE_LUNGE_TIME);
    this.dashDir.copy(forward);
    this.dashT = MELEE_LUNGE_TIME;
  }

  // ---------- Combat callbacks ----------

  /** Adaptive music: quiet on menu, pulse ramps with wave pressure in combat. */
  private updateMusic(): void {
    // Room tone belongs to the arena: the menu keeps it off so the menu music
    // has somewhere quiet to sit, and a run fades it in.
    this.audio.setAmbience(this.phase === 'playing' || this.phase === 'paused'
      || this.phase === 'draft' || this.phase === 'kiosk');
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

  /**
   * Roll a dead enemy's drops and place whatever it leaves behind.
   *
   * Uses the RUN's seeded RNG, not Math.random: a seed code promises the same
   * arena and the same spawn order, and a replay that drops different loot
   * would break that promise for no benefit.
   */
  private rollDrop(enemy: Enemy): void {
    const at = enemy.group.position.clone().setY(0);
    const rng = this.run.rng;
    const elite = enemy.elite ? ELITE_DROP_BONUS : 0;
    const boss = enemy.kind === 'wardenPrime';
    // A boss always pays out: the fight is long enough that a dry drop would
    // read as a bug rather than as bad luck.
    if (boss || rng.next() < DROP_CHANCE_SALVAGE + elite) {
      this.pickups.dropAt('salvage', at, () => rng.next());
    }
    if (rng.next() < DROP_CHANCE_AMMO + elite) {
      this.pickups.dropAt('ammo', at, () => rng.next());
    }
    // Health is the rarest drop, and an elite is the most likely source. A
    // common heal would erase the value of the arena's health stations.
    if (boss || rng.next() < DROP_CHANCE_HEALTH + elite * 0.5) {
      this.pickups.dropAt('health', at, () => rng.next());
    }
  }

  private handleKill = (enemy: Enemy, byPlayer: boolean): void => {
    this.kills += 1;
    // A kill freezes the sim for a beat. Elites and the boss freeze longer,
    // because the size of the pause is the size of the news.
    if (byPlayer) {
      this.hitstopT = Math.max(this.hitstopT, enemy.kind === 'wardenPrime' ? 0.16
        : enemy.elite ? 0.1 : 0.06);
    }
    // Drops. A kill has to leave something behind or the fight has no
    // aftertaste: the arena stations are destinations, but a drop is a reward
    // that pulls the player forward. Only player kills drop, so an escort
    // cannot farm the arena on the player's behalf, and the rolls use the
    // run's seeded RNG so a replayed seed drops identically.
    if (byPlayer) this.rollDrop(enemy);
    const mods = this.run.mods;
    // Attribute the kill to whichever ability produced it.
    //
    // The flags are WINDOWS, not one-shot claims: a melee swing, a thrown
    // grenade and a dash each open a window of a few seconds during which kills
    // are credited to them. The old code cleared all three on ANY kill, so
    // throwing a grenade and then shooting one grunt while the grenade was
    // still in the air consumed the flag — the grenade landed, killed five
    // enemies, and every one of them was credited to the rifle. AERIAL ACE and
    // PACIFIST ADJACENT were effectively unreachable.
    if (byPlayer) {
      if (this.pendingMeleeKill) this.meleeKills += 1;
      else if (this.pendingGrenadeKill) this.grenadeKills += 1;
      else if (this.pendingDashKill && this.dashT > 0) this.dashKills += 1;
    }
    if (enemy.elite) this.eliteKills += 1;
    if (enemy.kind === 'wardenPrime') this.bossKills += 1;
    // Killfeed: name the kill. Only player kills -- an escort farming the
    // arena would flood the feed with rows the player did not earn.
    if (byPlayer) {
      this.hud.pushKill(
        enemy.def.label,
        this.weapons.current.def.name,
        enemy.elite,
      );
    }
    // Salvage: the run's currency. Elites and bosses pay a premium, which is
    // what makes hunting them a real economic decision. The challenge salvage
    // multiplier applies on top, so a hard run is also a richer one.
    const salvageBase = (SALVAGE_PER_KILL
      + (enemy.elite ? SALVAGE_ELITE_BONUS : 0)
      + (enemy.kind === 'wardenPrime' ? SALVAGE_BOSS_BONUS : 0)) *
      this.challengeMods.salvageMul;
    this.run.earnSalvage(salvageBase);
    // Heal-on-kill and lifesteal, both from the card pool.
    if (mods.healOnKill > 0) this.player.heal(mods.healOnKill);
    // Ignite-on-kill: splash a burn onto the dead enemy's neighbours.
    //
    // This used to draw the ring and the sparks and apply NOTHING — no burn
    // timer was ever set, so Gasoline, Diesel Soaked and Greek Fire were three
    // cards that cost a draft pick and changed no fight. The visual is now
    // driven by the count of enemies actually set alight, so an empty burst
    // cannot read as a working card either.
    if (mods.igniteOnKill > 0 && this.run.rng.chance(mods.igniteOnKill)) {
      const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
      const lit = this.enemies.igniteArea(at, IGNITE_RADIUS, IGNITE_DPS, IGNITE_TIME);
      if (lit > 0) {
        this.effects.ring(at, 0xff8a3c, IGNITE_RADIUS * 2, 0.4);
        this.effects.burst(at, 0xff8a3c, 10, 1.8);
        this.audio.blastAt(at.x, at.z);
      }
    }
    // Escort kills bank the base score but never extend the player's combo.
    if (!byPlayer) {
      const base = Math.round(
        enemy.def.score * this.waves.scoreMult * mods.scoreMul *
        this.challengeMods.scoreMul,
      );
      this.score += base;
      this.hud.popScore(base);
      return;
    }
    const firstTier = this.combo < 2;
    this.combo += 1;
    this.comboTimer = COMBO_WINDOW + mods.comboWindowBonus;
    if (this.combo > this.longestCombo) this.longestCombo = this.combo;
    const mult = Math.min(1 + Math.floor(this.combo / 2), 8);
    // High Confidence: the full-health score bonus.
    const fullHpBonus = this.player.health >= this.player.maxHealth - 0.5
      ? mods.fullHpScoreMul
      : 1;
    const pts = Math.round(
      enemy.def.score * this.waves.scoreMult * mult * mods.scoreMul * fullHpBonus *
      this.challengeMods.scoreMul,
    );
    this.score += pts;
    this.hud.hitmarkerFlash('kill');
    this.hud.popScore(pts);
    if (enemy.elite) {
      this.hud.showBanner(
        enemy.kind === 'wardenPrime' ? 'PRIME DOWN' : 'ELITE DOWN',
        `${enemy.def.score} PTS`,
      );
      this.audio.eliteKill();
    }
    // Teach the mechanic the first time it actually matters (×2 unlocks here).
    if (firstTier && mult > 1) this.hud.showBanner(`COMBO ×${mult}`, 'CHAIN KILLS TO RAISE IT');
    if (this.waves.isRotator) this.weapons.rotate();
  };

  /** Damage actually dealt by the player, forwarded from the weapon path. */
  public onDamageDealt(amount: number, headshot: boolean): void {
    this.run.stats.damageDealt += amount;
    void headshot;
    const mods = this.run.mods;
    if (mods.lifesteal > 0 && !this.player.dead) {
      const healed = amount * mods.lifesteal;
      this.player.heal(healed);
      this.lifestealHealed += healed;
    }
  }

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
    state.shield = this.player.shield;
    state.mag = view.mag;
    // Use the MODDED mag size, not the base def. With Bracer/Duplicator/Fuel
    state.reserve = view.reserve;
    state.reloading = view.reloading;
    state.reloadProgress = view.reloadProgress;
    state.weaponIndex = view.index;
    state.weaponName = weapon.def.name;
    // The loadout readout is derived from the LIVE equipped list, so a menu
    // change is reflected the moment the run starts with no extra plumbing.
    this.syncLoadoutReadout();
    state.scoped = weapon.def.scoped;
    state.adsT = this.player.aimFraction;
    state.charge = this.weapons.chargeFraction;
    // 'charging' is true only while the weapon is ACTUALLY charging, not
    // merely because it has a chargeTime. The old flag was static and made
    // the charge ring show permanently for rail/launcher.
    state.charging = (weapon.def.chargeTime ?? 0) > 0 && this.weapons.chargeFraction > 0 && this.weapons.chargeFraction < 1;
    state.wave = Math.max(1, this.waves.wave);
    state.enemiesLeft = this.enemies.aliveCount;
    state.phase = this.waves.phase;
    state.phaseTimer = this.waves.timer;
    state.score = this.score;
    state.kills = this.kills;
    state.comboMult = Math.min(1 + Math.floor(this.combo / 2), 8);
    state.crosshairGapPx = this.crosshairGap();
    state.inGame = this.phase === 'playing';
    state.allyActive = this.ally.active;
    state.allyCount = this.ally.aliveCount;
    state.allyHp = this.ally.hp;
    state.allyMax = this.ally.maxHp;
    state.radar = this.radarBlips;
    state.radarCount = this.radarCount;
    // Ability + run readouts.
    state.dashCharges = this.dashCharges;
    state.dashMax = this.maxDashCharges;
    state.dashFraction = this.dashCharges >= this.maxDashCharges
      ? 1
      : clamp(this.dashRecharge / DASH_COOLDOWN, 0, 1);
    state.grenadeCharges = this.grenadeCharges;
    state.grenadeMax = this.maxGrenadeCharges;
    state.grenadeFraction = this.grenadeCharges >= this.maxGrenadeCharges
      ? 1
      : clamp(this.grenadeRecharge / GRENADE_COOLDOWN, 0, 1);
    state.grenadeKind = this.grenadeKind;
    state.grenadeCook = this.grenadeCook;
    state.salvage = this.run.salvage;
    state.upgrades = this.run.taken.length;
    state.seedCode = seedToCode(this.run.seed);
    state.isDaily = this.isDaily;
    state.mutationName = this.waves.activeMutation.id === 'clear'
      ? ''
      : this.waves.activeMutation.name;
    state.mutationDesc = this.waves.activeMutation.description;
    state.wagerCount = this.challenges.length;
    state.wagerScoreMul = this.challengeMods.scoreMul;
    state.wagerLabel = challengeLabel(this.challenges);
    state.burnT = this.enemies.playerBurnT;
    state.slowT = this.enemies.playerSlowT;
    state.achievementsQueued = this.queue.length;
    state.eliteAlive = this.enemies.eliteAliveCount;
    // Boss readout: the HUD needs health, phase and weak-point state to draw a
    // bar, and it must read straight off the roster rather than a cached copy.
    const boss = this.enemies.activeBoss;
    state.bossActive = boss !== null;
    state.bossHealth = boss ? Math.max(0, boss.health) : 0;
    state.bossMax = boss ? boss.def.health : 0;
    state.bossName = boss ? BOSS_NAME : '';
    state.bossPhase = boss ? boss.phase : 0;
    state.bossWeakPoint = boss ? !boss.weakPointBroken : false;
    // Arena identity and the world markers. The map name is part of the run
    // readout because the map is part of the seed now.
    state.mapName = this.world.themeName;
    state.mapTagline = this.world.themeTagline;
    state.markers = this.targetMarkers;
    state.markerCount = this.markerCount;
    state.hurtBy = this.player.lastDamageSource;
    state.hurtAge = this.hurtAge;
    return state;
  }

  /**
   * Refresh the loadout readout arrays in place. The HUD reads them every
   * frame, so they are mutated rather than reallocated: a 4-element array per
   * frame would be 240 allocations a second for a value that changes when the
   * player opens the menu.
   */
  private syncLoadoutReadout(): void {
    const ids = this.weapons.equipped;
    const names = this.hudSnapshot.loadoutNames;
    const outIds = this.hudSnapshot.loadoutIds;
    if (names.length !== ids.length) {
      names.length = 0;
      outIds.length = 0;
      for (const id of ids) {
        names.push(WEAPONS[id].name);
        outIds.push(id);
      }
      return;
    }
    for (let i = 0; i < ids.length; i++) {
      const id = ids[i] as WeaponId;
      const name = WEAPONS[id].name;
      if (names[i] !== name) names[i] = name;
      if (outIds[i] !== id) outIds[i] = id;
    }
  }

  /** Honest crosshair gap in CSS px, straight from the real cone. */
  private crosshairGap(): number {
    return this.weapons.crosshairGapPx(this.viewportH);
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
      blip.colorCss = this.colorCssOf(enemy.def.color);
      // Clear the drop tag: this slot may have held a drop on the previous
      // sweep, and a stale tag would draw an enemy as loot.
      delete blip.drop;
      count += 1;
    });
    // Loot drops, after the enemies so a crowded wave never starves the radar
    // of the thing the player is actually looking for. Drops are temporary and
    // their position is unknowable without being told, which is exactly what a
    // radar is for; the arena's permanent stations are deliberately excluded,
    // because a fixture the player has learned once is noise on every sweep.
    this.pickups.forEachDrop((kind, at) => {
      if (count >= this.radarBlips.length) return;
      const blip = this.radarBlips[count];
      if (!blip) return;
      const dx = at.x - playerX;
      const dz = at.z - playerZ;
      const rx = dx * cy - dz * sy;
      const rz = -(dx * sy + dz * cy);
      blip.x = clamp(rx / 46, -1, 1);
      blip.z = clamp(rz / 46, -1, 1);
      blip.drop = kind;
      blip.color = kind === 'health' ? 0x2aff8a : kind === 'ammo' ? 0xffc44d : 0xffd76b;
      blip.colorCss = this.colorCssOf(blip.color);
      count += 1;
    });
    this.radarCount = count;
  }

  /**
   * Project every live enemy and ally to screen space for the world markers.
   *
   * Markers exist because the radar is a 2D abstraction: it tells you something
   * is behind you but not WHAT it is or HOW hurt it is. A marker carries the
   * kind's colour, its glyph, its health, and its range, so a glance answers
   * "what is that, where is it, and can I kill it" without reading a label.
   *
   * Cost is bounded: 28 markers, one matrix multiply each, and off-screen
   * markers are still emitted (clamped to the edge) so a flanking enemy cannot
   * arrive unannounced.
   */
  private buildMarkers(dt: number): void {
    // The projection only needs to be as fresh as the eye can read it.
    this.hudMarkerTimer -= dt;
    if (this.hudMarkerTimer > 0) return;
    this.hudMarkerTimer = 0.05;
    const camera = this.player.camera;
    camera.updateMatrixWorld();
    const halfW = this.container.clientWidth * 0.5;
    const halfH = this.container.clientHeight * 0.5;
    if (halfW <= 0 || halfH <= 0) {
      this.markerCount = 0;
      return;
    }
    let count = 0;
    const emit = (
      world: THREE.Vector3,
      colorCss: string,
      role: string,
      health: number,
      glyph: string,
    ): void => {
      if (count >= this.targetMarkers.length) return;
      const marker = this.targetMarkers[count];
      if (!marker) return;
      this.markerProject.copy(world).project(camera);
      // Behind the camera: clamp to the edge on the correct side instead of
      // mirroring through the centre, which is the classic "marker points the
      // wrong way" bug.
      const behind = this.markerProject.z > 1;
      let x = this.markerProject.x;
      let y = this.markerProject.y;
      let clamped = behind;
      if (behind) {
        x = x >= 0 ? 1 : -1;
        y = y >= 0 ? 1 : -1;
      } else if (Math.abs(x) > 1 || Math.abs(y) > 1) {
        clamped = true;
        const k = 1 / Math.max(Math.abs(x), Math.abs(y));
        x *= k;
        y *= k;
      }
      marker.x = halfW + x * halfW * 0.94;
      marker.y = halfH - y * halfH * 0.9;
      marker.distance = world.distanceTo(this.player.position);
      marker.colorCss = colorCss;
      marker.role = role;
      marker.health = clamp(health, 0, 1);
      marker.clamped = clamped;
      marker.glyph = glyph;
      count += 1;
    };

    this.enemies.forEachLive((enemy) => {
      const at = enemy.group.position;
      const colorCss = this.colorCssOf(enemy.def.color);
      // Elites and the boss get their own glyph so a threat is never just
      // "another dot": the shape is the read, the colour is the kind.
      const role = enemy.kind === 'wardenPrime' ? 'boss' : enemy.elite ? 'elite' : 'enemy';
      const glyph = enemy.kind === 'wardenPrime' ? 'B'
        : enemy.kind === 'healer' ? '+'
          : enemy.kind === 'summoner' ? 'S'
            : enemy.kind === 'sniper' ? 'X'
              : enemy.kind === 'exploder' ? '!'
                : enemy.elite ? 'E' : '';
      emit(
        this.markerProject2.set(at.x, at.y + enemy.def.height + 0.55, at.z),
        colorCss,
        role,
        enemy.health / enemy.def.health,
        glyph,
      );
    });

    // Ally markers are always lime, matching the escort's own HUD plate, so
    // friendly and hostile markers can never be confused at a glance.
    for (const bot of this.ally.bots) {
      if (!bot.active) continue;
      const at = bot.position;
      emit(
        this.markerProject2.set(at.x, at.y + 2.3, at.z),
        '#7ddb8a',
        'ally',
        bot.hpFraction,
        'A',
      );
    }
    this.markerCount = count;
  }

  /** Cached `#rrggbb` for a numeric colour, shared with the radar. */
  private colorCssOf(color: number): string {
    let colorCss = this.radarColorCache.get(color);
    if (!colorCss) {
      colorCss = `#${color.toString(16).padStart(6, '0')}`;
      this.radarColorCache.set(color, colorCss);
    }
    return colorCss;
  }

  // ---------- Rendering / resize ----------

  private render = (frameDt: number, alpha: number): void => {
    // Look runs at RENDER rate, before the frame is drawn and outside the fixed
    // step. Mouse deltas are a displacement, not a rate, so this is the lowest
    // latency point at which the view can possibly react, and it removes the
    // 16.7 ms aim staircase a 60 Hz-only look path would impose.
    if (this.phase === 'playing') {
      const look = this.input.consumeLook();
      this.frameLook.set(look.dx, look.dy);
      this.player.look(look.dx, look.dy);
      this.buildRadar();
      this.buildMarkers(frameDt);
    } else {
      this.frameLook.set(0, 0);
      this.radarCount = 0;
      this.markerCount = 0;
    }
    this.player.body.visible = this.phase === 'playing' || this.phase === 'paused';
    // Runtime quality probe: a downgrade reallocates framebuffers, so it is
    // rate-limited inside the governor and only ever steps down.
    if (this.phase === 'playing' && this.governor.sample(frameDt * 1000)) {
      this.renderer.setPixelRatio(this.pixelRatio());
    }
    this.syncTouchVisuals();
    // Overlays freeze their banner timer; only active gameplay animates HUD.
    this.hud.update(this.phase === 'playing' ? frameDt : 0, this.hudState());
    // Position interpolation: the sim runs at 60 Hz, the display does not.
    if (this.phase === 'playing' || this.phase === 'paused') this.player.syncCamera(alpha);
    this.renderer.clear();
    this.renderPipeline.render();
    if (this.phase === 'playing' || this.phase === 'paused') {
      this.viewmodel.render(this.renderer);
    }
  };

  /** Mirror the input layer's touch state onto the HUD overlay. */
  private syncTouchVisuals(): void {
    if (!this.input.isTouchMode) return;
    const touch = this.input.touch;
    this.hud.updateTouch(touch.stickState, 62);
    for (const button of touch.buttonsForRender) {
      this.hud.setTouchHeld(button.id, touch.isHeld(button.id));
    }
  }

  private onResize = (): void => {
    // `visualViewport` tracks the mobile address bar, which changes the visual
    // viewport WITHOUT firing a reliable window resize on iOS Safari.
    const vv = window.visualViewport;
    const w = Math.round(vv?.width ?? this.container.clientWidth ?? window.innerWidth);
    const h = Math.round(vv?.height ?? this.container.clientHeight ?? window.innerHeight);
    if (w <= 0 || h <= 0) return;
    this.viewportH = h;
    this.renderer.setSize(w, h);
    this.player.camera.aspect = w / h;
    this.player.camera.updateProjectionMatrix();
    this.viewmodel.setSize(w, h);
    this.input.touch.layout();
    this.hud.layoutTouch();
  };
}
