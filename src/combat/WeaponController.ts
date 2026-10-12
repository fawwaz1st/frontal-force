import * as THREE from 'three';
import type { EnemyManager, Enemy } from '../ai/Enemies';
import type { Player } from '../player/Player';
import type { InputFrame } from '../input/Input';
import type { Effects } from '../render/Effects';
import type { GameAudio } from '../audio/Audio';
import type { World } from '../world/World';
import { createWeaponState, sanitizeLoadout, type WeaponId, type WeaponState } from './weapons';

const UP = new THREE.Vector3(0, 1, 0);

/** Seconds between rounds inside one burst group (≈288 rpm — reads as a
 *  deliberate 3-round group rather than a full-auto dump). */
const BURST_ROUND_INTERVAL = 1 / 4.8;

/** Hard ceiling on self-inflicted blast damage. Without it the endless damage
 *  ramp (×40 by wave 34) turns a point-blank rocket into instant suicide. */
const MAX_SELF_BLAST = 35;

/** CombatTarget id of the human player — shared with the enemy threat table. */
export const PLAYER_TARGET_ID = 1;

export interface WeaponView {
  index: number;
  mag: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
  /** Effective magazine size after run modifiers. */
  magSize: number;
}

/** Owns all weapon state: inventory, ammo, reload, switching, and firing. */
export class WeaponController {
  /**
   * The equipped loadout. Four slots, chosen in the menu. The ten-weapon pool
   * still exists, but it lives in the loadout screen rather than in the middle
   * of a firefight: cycling ten guns with the mouse wheel is not a decision,
   * it is a chore.
   */
  private loadout: WeaponId[] = sanitizeLoadout([]);
  private states: WeaponState[] = this.loadout.map(createWeaponState);
  private index = 0;
  private readonly viewSnapshot: WeaponView = {
    index: 0,
    mag: 0,
    reserve: 0,
    reloading: false,
    reloadProgress: 0,
    magSize: 0,
  };

  private readonly ray = new THREE.Ray();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpPoint = new THREE.Vector3();
  private readonly tmpNormal = new THREE.Vector3();
  private readonly tmpPellet = new THREE.Vector3();
  private readonly tmpMuzzle = new THREE.Vector3();
  private readonly tmpRight = new THREE.Vector3();
  private readonly tmpUp = new THREE.Vector3();
  // Ricochet scratch. These must survive across a leg boundary, which is why
  // they are dedicated fields rather than reused temporaries.
  private readonly richFrom = new THREE.Vector3();
  private readonly richDir = new THREE.Vector3();
  private readonly richPoint = new THREE.Vector3();
  private readonly richNormal = new THREE.Vector3();
  private richHitWall = false;
  /** Rounds still owed to the current burst group. */
  private burstLeft = 0;
  private burstT = 0;
  /**
   * Charge-up state for the heavy weapons. `chargeT` counts up while the
   * trigger is held, `chargeReady` latches once the shot has released so the
   * same hold cannot fire twice.
   */
  private chargeT = 0;
  private chargeReady = false;

  public onFired: ((weapon: WeaponState) => void) | null = null;
  public onSwitched: (() => void) | null = null;
  /**
   * Damage actually dealt by a player shot, forwarded to the run statistics
   * and the lifesteal path. Called once per pellet that connects, with the
   * post-mitigation number, so the accuracy and DPS readouts are honest.
   */
  public onDamageDealt: ((amount: number, headshot: boolean) => void) | null = null;
  /**
   * Per-pellet outcome, for the accuracy and headshot statistics.
   * 0 = miss, 1 = body hit, 2 = headshot, 3 = headshot kill, 4 = body kill,
   * 5 = blocked by a shield (no kill). Kills carry their own codes so the
   * hitmarker can show the headshot variant only when the shot really hit the
   * head, and blocked shots are reported separately instead of being folded
   * into the generic hit bucket.
   */
  public onShotStat: ((result: 0 | 1 | 2 | 3 | 4 | 5) => void) | null = null;
  /** Run modifiers. Identity until the first card is taken. */
  private mods = {
    damageMul: 1,
    fireRateMul: 1,
    magMul: 1,
    reloadMul: 1,
    spreadMul: 1,
    blastDamageMul: 1,
    blastRadiusMul: 1,
    headshotMul: 1,
    critChance: 0,
    critMul: 2,
  };
  /** Damage multiplier for endless modes — mirrors the enemy HP ramp so a
   *  fixed ammo pool never becomes a hard wall. 1 in every finite mode. */
  public damageScale = 1;
  /**
   * Extra cone multiplier from the run's challenges (Scatter). Kept separate
   * from `mods.spreadMul` because that one is a card the player opted into
   * mid-run, while this is a menu wager fixed for the whole run.
   */
  public challengeSpreadMul = 1;
  /** Multiplier on reserve ammo at run start (Famine). */
  public challengeAmmoMul = 1;
  /** Latest player muzzle in world space; consumed once by enemy hearing. */
  public lastShot: THREE.Vector3 | null = null;
  /** Supplies the current weapon muzzle in WORLD space (eye + viewmodel offset). */
  public getMuzzle:
    | ((eye: THREE.Vector3, out: THREE.Vector3) => void)
    | null = null;
  /**
   * Destructible world props along the shot line (barrels). The owner wires
   * this to the hazard system, which is why the weapon does not need to know
   * hazards exist: it reports a hit and the owner decides what it means.
   * Returns true when the prop absorbed the round.
   */
  public onPropHit:
    | ((point: THREE.Vector3, dir: THREE.Vector3, amount: number) => boolean)
    | null = null;
  /**
   * Called when a player shot lands on an enemy, so affix riders (burn, slow,
   * chain) can fire. The weapon owns the hit, the enemy manager owns the rider.
   */
  public onEnemyHit: ((enemy: Enemy, headshot: boolean) => void) | null = null;

  public constructor(
    private readonly player: Player,
    private readonly enemies: EnemyManager,
    private readonly world: World,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
    private readonly onHitFeedback: (kind: 'hit' | 'headshot' | 'blocked') => void,
  ) {}

  public get current(): WeaponState {
    return this.states[this.index] ?? this.states[0]!;
  }

  public view(): WeaponView {
    const weapon = this.current;
    const view = this.viewSnapshot;
    view.index = this.index;
    view.mag = weapon.mag;
    view.reserve = weapon.reserve;
    view.reloading = weapon.reloading;
    view.reloadProgress = weapon.reloading
      ? Math.min(weapon.reloadT / weapon.def.reloadTime, 1)
      : 0;
    view.magSize = this.magSizeOf(weapon);
    return view;
  }

  public reset(): void {
    this.states = this.loadout.map(createWeaponState);
    this.index = 0;
    this.lastShot = null;
    this.chargeT = 0;
    this.chargeReady = false;
    this.burstLeft = 0;
    this.burstT = 0;
    // Famine: reserves only, never the magazine. The first magazine is what
    // the opening fight is balanced around, so cutting it would make wave 1
    // unwinnable rather than tense.
    if (this.challengeAmmoMul !== 1) {
      for (const state of this.states) {
        state.reserve = Math.max(
          0,
          Math.floor(state.reserve * this.challengeAmmoMul),
        );
      }
    }
  }

  /**
   * Equip a new loadout. Called from the menu, never mid-run, so it is safe to
   * rebuild every state from scratch: the player is choosing a kit, not
   * swapping a magazine.
   */
  public setLoadout(ids: readonly string[]): void {
    const next = sanitizeLoadout(ids);
    // Skip the rebuild when nothing moved, so opening the menu twice does not
    // silently refill the magazines of the run in progress.
    if (next.length === this.loadout.length && next.every((id, i) => id === this.loadout[i])) return;
    this.loadout = next;
    this.states = this.loadout.map(createWeaponState);
    this.index = 0;
    this.chargeT = 0;
    this.chargeReady = false;
  }

  /** The equipped ids, for the HUD slot ring and the loadout screen. */
  public get equipped(): readonly WeaponId[] {
    return this.loadout;
  }

  /** Return to slot 0 and clear any in-flight burst or charge. */
  public reslot(): void {
    const current = this.states[this.index];
    if (current) current.reloading = false;
    this.index = 0;
    this.burstLeft = 0;
    this.burstT = 0;
    this.chargeT = 0;
    this.chargeReady = false;
  }

  /** Single source for bullet and crosshair spread. */
  public spreadFor(moving: boolean, aiming: boolean): number {
    if (aiming) return this.current.def.spread * 0.6;
    return moving ? this.current.def.spreadMoving : this.current.def.spread;
  }

  /**
   * The real cone half-angle, in radians, for the NEXT shot. Drives both the
   * bullets and the crosshair gap, so the crosshair is always honest about
   * where a round can actually land.
   *
   * Model (research: CS2 / Apex / Source):
   *  1. The FIRST shot of a group from a stationary, grounded shooter is
   *     perfectly accurate. This is the single highest-impact accuracy rule
   *     in any shooter — if bullet 1 is RNG, nothing else matters.
   *  2. Movement penalty scales with ACTUAL velocity, not with "is a key
   *     held", so counter-strafing works the way players expect.
   *  3. Sustained fire blooms the cone; the bloom resets with the group.
   *  4. Airborne adds a large flat penalty — jumping is not a valid tactic.
   */
  public spreadForState(
    moveFraction: number,
    aiming: boolean,
    airborne: boolean,
    shotIndex: number,
  ): number {
    const def = this.current.def;
    const still = moveFraction < 0.08 && !airborne;
    // Perfect first shot: only when genuinely stationary and grounded.
    if (shotIndex === 0 && still) return aiming ? def.spread * 0.35 : 0;
    const move = Math.min(1, Math.max(0, moveFraction));
    let cone = def.spread + (def.spreadMoving - def.spread) * move;
    if (airborne) cone += def.spreadMoving * 2.4;
    // Bloom: +12% of the moving cone per consecutive round, capped at 2.5x.
    cone *= 1 + Math.min(1.5, shotIndex * 0.12);
    if (aiming) cone *= 0.6;
    return cone * this.mods.spreadMul * this.challengeSpreadMul;
  }

  /** Cone half-angle for the next shot using the live player state. */
  public currentSpread(): number {
    return this.spreadForState(
      this.player.moveFraction,
      this.player.isAiming,
      this.player.airborne,
      this.player.shotIndex,
    );
  }

  /**
   * Screen-space crosshair gap in CSS pixels for a cone half-angle. Derived
   * from the perspective projection: a point at angle `theta` off-axis lands
   * `(h/2) * tan(theta) / tan(fovY/2)` pixels from centre. Without this the
   * crosshair lies about where shots go.
   */
  public crosshairGapPx(viewportHeightPx: number): number {
    const cone = this.currentSpread();
    if (cone <= 1e-5) return 3; // tight but visible
    const fovY = (this.player.camera.fov * Math.PI) / 180;
    const halfH = viewportHeightPx * 0.5;
    return Math.max(2, halfH * Math.tan(cone) / Math.tan(fovY * 0.5));
  }

  /** Full ammo top-up from an ammo pickup. */
  public refillReserve(): void {
    for (const w of this.states) {
      w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.magSize * 1.5));
    }
  }

  /** Every weapon state, for the kiosk's full-rearm purchase. */
  public allStates(): readonly WeaponState[] {
    return this.states;
  }

  /**
   * Adopt the run's modifiers. Magazine size is applied by re-clamping the
   * live mag so a mid-run +10% magazine card is felt immediately instead of
   * only after the next reload.
   */
  public setMods(mods: {
    damageMul: number;
    fireRateMul: number;
    magMul: number;
    reloadMul: number;
    spreadMul: number;
    blastDamageMul: number;
    blastRadiusMul: number;
    headshotMul: number;
    critChance: number;
    critMul: number;
  }): void {
    this.mods = mods;
    for (const state of this.states) {
      const nextSize = Math.max(1, Math.round(state.def.magSize * mods.magMul));
      if (state.mag > nextSize) state.mag = nextSize;
    }
  }

  /** Effective magazine size for a weapon, after run modifiers. */
  public magSizeOf(state: WeaponState): number {
    return Math.max(1, Math.round(state.def.magSize * this.mods.magMul));
  }

  /**
   * Aimed field of view for the equipped weapon, in degrees. Every weapon has
   * one; the scoped ones go low enough that the scope overlay takes over.
   */
  public adsFov(): number {
    return this.current.def.adsFov;
  }

  /** True while the equipped weapon has a magnified optic. */
  public get scoped(): boolean {
    return this.current.def.scoped;
  }

  /** 0..1 charge progress for the HUD ring; 1 when the weapon has no charge. */
  public get chargeFraction(): number {
    const time = this.current.def.chargeTime ?? 0;
    if (time <= 0) return 1;
    return Math.min(1, this.chargeT / time);
  }

  /** Movement speed multiplier for the equipped weapon (heavy guns slow you). */
  public get moveMul(): number {
    return this.current.def.moveMul ?? 1;
  }

  public update(frame: InputFrame, dt: number): void {
    if (frame.slotPressed > 0 && frame.slotPressed <= this.states.length) {
      this.switchTo(frame.slotPressed - 1);
    }
    const count = this.states.length;
    for (let step = 0; step < frame.wheelSteps; step++) {
      this.switchTo((this.index + 1) % count);
    }
    for (let step = 0; step > frame.wheelSteps; step--) {
      this.switchTo((this.index - 1 + count) % count);
    }

    const weapon = this.current;
    weapon.cooldown = Math.max(0, weapon.cooldown - dt);

    if (weapon.reloading) {
      weapon.reloadT += dt * this.mods.reloadMul;
      if (weapon.reloadT >= weapon.def.reloadTime) this.finishReload(weapon);
    } else if (frame.reloadPressed && weapon.mag < this.magSizeOf(weapon) && weapon.reserve > 0) {
      this.beginReload(weapon);
    }

    const wantsFire = weapon.def.auto ? frame.fireHeld : frame.firePressed;
    // Charge-up weapons hold the shot until the capacitor is full. The
    // telegraph is the point: the biggest hits in the game must be visible
    // before they land, or they are just damage the player cannot answer.
    const chargeTime = weapon.def.chargeTime ?? 0;
    if (chargeTime > 0) {
      if (frame.fireHeld && frame.locked && !weapon.reloading && weapon.mag > 0) {
        this.chargeT = Math.min(chargeTime, this.chargeT + dt);
        if (this.chargeT >= chargeTime && !this.chargeReady) {
          this.chargeReady = true;
          this.fire(weapon, this.player.isAiming, (weapon.def.chargeDamageMul ?? 1));
        }
      } else {
        // Released early: the charge is lost, not banked. Banking it would let
        // the player pre-charge behind cover and delete the trade-off.
        if (this.chargeT > 0 && !this.chargeReady) this.audio.empty();
        this.chargeT = 0;
        this.chargeReady = false;
      }
    } else if (wantsFire && frame.locked && !weapon.reloading && weapon.cooldown <= 0) {
      if (weapon.mag <= 0) {
        this.audio.empty();
        weapon.cooldown = 0.25;
        if (weapon.reserve > 0) this.beginReload(weapon);
      } else {
        this.fire(weapon, this.player.isAiming);
      }
    }
    // Burst weapons keep cycling their group while the trigger is held down:
    // the first round is fired by the branch above, the rest here.
    this.burstT -= dt;
    if (this.burstLeft > 0 && this.burstT <= 0) {
      if (weapon.mag <= 0 || weapon.reloading || !frame.locked) {
        this.burstLeft = 0;
      } else {
        this.fire(weapon, this.player.isAiming);
        this.burstLeft -= 1;
        this.burstT = BURST_ROUND_INTERVAL;
      }
    }
  }

  private switchTo(index: number): void {
    if (index === this.index) return;
    const current = this.states[this.index];
    if (current) current.reloading = false;
    // A weapon swap aborts any burst in flight — otherwise the new weapon
    // would fire the previous weapon's remaining rounds on its own cadence.
    this.burstLeft = 0;
    this.burstT = 0;
    // A swap also drops a charge: the capacitor belongs to the weapon.
    this.chargeT = 0;
    this.chargeReady = false;
    this.index = index;
    const next = this.states[index];
    if (next) next.cooldown = Math.max(next.cooldown, 0.18);
    this.player.resetRecoilGroup();
    this.onSwitched?.();
  }

  /** Gun-game rotation: next weapon in slot order (ROTATION mode). */
  public rotate(): void {
    this.switchTo((this.index + 1) % this.states.length);
  }

  private beginReload(weapon: WeaponState): void {
    weapon.reloading = true;
    weapon.reloadT = 0;
    // A reload restarts the recoil pattern: the first round after it is
    // perfectly accurate again, which is what makes tap-firing viable.
    this.player.resetRecoilGroup();
    this.audio.reload();
  }

  private finishReload(weapon: WeaponState): void {
    const size = this.magSizeOf(weapon);
    const need = size - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    weapon.reserve -= take;
    weapon.reloading = false;
  }

  private fire(weapon: WeaponState, aiming: boolean, chargeMul = 1): void {
    weapon.mag -= 1;
    // Fire rate is a run modifier: every card that speeds the gun up must
    // change the cooldown here, or the card would only affect the animation.
    weapon.cooldown = 1 / (weapon.def.fireRate * this.mods.fireRateMul);
    // A burst weapon arms its follow-up rounds here, INCLUDING the first
    // inter-round delay — arming only `burstLeft` would fire round two on the
    // very same frame (burstT was never set) and the group would read as a
    // 2+1 rather than three evenly spaced rounds.
    const burstCount = weapon.def.burstCount ?? 0;
    if (burstCount > 1) {
      this.burstLeft = burstCount - 1;
      this.burstT = BURST_ROUND_INTERVAL;
    }
    // Cone is sampled BEFORE addRecoil so the shot uses the state the player
    // was aiming with, and the crosshair can predict it exactly.
    const shotIndex = this.player.shotIndex;
    const spread = this.spreadForState(
      this.player.moveFraction,
      aiming,
      this.player.airborne,
      shotIndex,
    );
    // The ray leaves the EYE and runs along the aim direction — the crosshair
    // is the aim point, always. Firing from the muzzle instead would make the
    // crosshair lie about close-range shots (the gun is ~30 cm off-axis).
    //
    // CRITICAL ORDER: the aim is sampled BEFORE this shot's recoil is applied.
    // addRecoil() rotates the very pitch/yaw that forward() reads, so applying
    // it first deflected every first round of a burst off the crosshair by the
    // kick it had not been fired with yet.
    this.player.eyePosition(this.tmpOrigin);
    this.player.forward(this.tmpDir);
    this.player.addRecoil(weapon.def.recoil);
    this.audio.shot(weapon.def.sound);
    this.onFired?.(weapon);

    // The tracer/flash/ejection origin is the GUN, which is purely cosmetic.
    const muzzle = this.tmpMuzzle.copy(this.tmpOrigin);
    this.getMuzzle?.(this.tmpOrigin, muzzle);
    this.lastShot = muzzle;

    const right = this.tmpRight.crossVectors(this.tmpDir, UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = this.tmpUp.crossVectors(right, this.tmpDir).normalize();

    let hitAny = false;
    let blockedAny = false;
    let headshotAny = false;
    let killedAny = false;
    for (let pellet = 0; pellet < weapon.def.pellets; pellet++) {
      // Uniform-in-disc sampling: sqrt() keeps the distribution flat instead of
      // clustering at the centre (which would make the cone a lie).
      const angle = Math.tan(spread) * Math.sqrt(Math.random());
      const azimuth = Math.random() * Math.PI * 2;
      const dir = this.tmpPellet.copy(this.tmpDir)
        .addScaledVector(right, Math.cos(azimuth) * angle)
        .addScaledVector(up, Math.sin(azimuth) * angle)
        .normalize();
      const result = this.fireRay(this.tmpOrigin, muzzle, dir, weapon, pellet === 0, chargeMul);
      hitAny ||= result !== 0;
      blockedAny ||= result === 5;
      headshotAny ||= result === 2 || result === 3;
      killedAny ||= result === 3 || result === 4;
      // Shot statistics: counted per PELLET so a shotgun's accuracy reflects
      // how many pellets connected, which is what the player actually sees.
      this.onShotStat?.(result);
    }
    // One marker/audio per trigger pull, not per pellet. Kill feedback is owned
    // by EnemyManager.onEnemyKilled and must not be overwritten by hit feedback.
    // A blocked shot gets its own marker so the player never reads "my gun is
    // weak" when a warden's plate is eating their damage.
    if (blockedAny && !killedAny) this.onHitFeedback('blocked');
    else if (hitAny && !killedAny) this.onHitFeedback(headshotAny ? 'headshot' : 'hit');
    // Brass ejects sideways/up; a smoke puff trails each shot (pooled physics props)
    const side = this.tmpNormal.crossVectors(this.tmpDir, UP);
    const k = 1.3 + Math.random() * 0.9;
    this.effects.casing(
      muzzle,
      this.tmpNormal.set(side.x * k, 2.6 + Math.random() * 1.4, side.z * k),
    );
    this.effects.smoke(muzzle, this.tmpDir);
  }

  /**
   * Explosive splash. Linear falloff from the centre to `blastFloor` at the
   * edge; the direct hit is excluded so it is never damaged twice. Self-damage
   * uses a SEPARATE, smaller radius so point-blank shots stay punishing without
   * letting the blast substitute for a jump (research: cap the vertical impulse).
   */
  private explode(point: THREE.Vector3, weapon: WeaponState, direct: Enemy | null): void {
    const def = weapon.def;
    const radius = def.blastRadius ?? 0;
    if (radius <= 0) return;
    const floor = def.blastFloor ?? 0;
    const center = def.damage * this.damageScale * this.mods.damageMul * this.mods.blastDamageMul;
    const blastRadius = radius * this.mods.blastRadiusMul;
    this.effects.ring(point, def.tracerColor, blastRadius * 2.4, 0.4);
    this.effects.burst(point, def.tracerColor, 16, 2.2);
    this.effects.smoke(point);
    this.audio.blast();
    this.enemies.forEachLive((enemy) => {
      if (enemy === direct) return;
      const distance = enemy.group.position.distanceTo(point);
      if (distance > blastRadius) return;
      const falloff = Math.max(floor, 1 - distance / blastRadius);
      const at = enemy.group.position.clone().setY(enemy.group.position.y + 1);
      const hit = this.enemies.damageEnemy(enemy, center * falloff, at, undefined, true, PLAYER_TARGET_ID);
      this.onDamageDealt?.(hit.dealt, false);
    });
    // Self-damage: smaller radius, and the falloff is applied to the PLAYER's
    // own position so backing off is the counter-play.
    const selfRadius = def.selfBlastRadius ?? 0;
    if (selfRadius > 0 && !this.player.dead) {
      const selfDist = this.player.position.distanceTo(point);
      if (selfDist <= selfRadius) {
        const falloff = Math.max(0, 1 - selfDist / selfRadius);
        // Capped: the endless damage ramp must not turn a rocket into suicide.
        const selfDamage = Math.min(MAX_SELF_BLAST, def.damage * (def.selfBlastFraction ?? 0) * falloff);
        if (selfDamage > 0) this.player.damage(selfDamage, point, 'YOUR OWN BLAST');
      }
    }
  }

  /**
   * Per-pellet result: 0 miss, 1 body hit, 2 headshot, 3 headshot kill,
   * 4 body kill, 5 blocked by a shield.
   *
   * `origin` is the eye (authoritative ray), `muzzle` is where the tracer and
   * impact effects are drawn FROM. Splitting them is the standard FPS model:
   * the crosshair is honest, and the visuals still look like they come from
   * the gun.
   */
  private fireRay(
    origin: THREE.Vector3,
    muzzle: THREE.Vector3,
    dir: THREE.Vector3,
    weapon: WeaponState,
    showTracer: boolean,
    chargeMul = 1,
  ): 0 | 1 | 2 | 3 | 4 | 5 {
    // Ricochet runs as a bounce loop rather than recursion: the bounce count is
    // at most two, so a loop keeps the trace readable and lets each leg draw
    // its own tracer segment through the path.
    const maxBounces = Math.max(0, Math.floor(weapon.def.ricochet ?? 0));
    // Scratch copies: the legs below overwrite the shared temporaries, so the
    // live ray origin and direction must live outside them.
    this.richFrom.copy(origin);
    this.richDir.copy(dir);
    for (let bounce = 0; bounce <= maxBounces; bounce++) {
      const finalLeg = bounce === maxBounces;
      const result = this.fireRayLeg(
        this.richFrom, muzzle, this.richDir, weapon, showTracer, chargeMul, finalLeg,
      );
      if (result !== 0) return result;
      // `fireRayLeg` returns 0 either for a clean miss or for a wall stop. A
      // wall stop is the only case that can bounce, and it leaves the impact
      // point and surface normal in the dedicated ricochet fields.
      if (!this.richHitWall || finalLeg) return 0;
      const normal = this.richNormal;
      const dot = this.richDir.dot(normal);
      // Guard against a grazing hit producing a zero-length reflect: without
      // this the round can bounce back along its own path forever.
      if (Math.abs(dot) < 1e-4) return 0;
      this.richDir.addScaledVector(normal, -2 * dot).normalize();
      this.richFrom.copy(this.richPoint);
      // Push the new origin a hair off the surface, or the very next ray
      // intersects the wall it just left.
      this.richFrom.addScaledVector(this.richDir, 0.02);
    }
    return 0;
  }

  /**
   * One straight leg of a shot. Returns the same result codes as `fireRay`.
   *
   * A wall stop returns 0 and reports the impact through `richHitWall`,
   * `richPoint` and `richNormal` rather than through the shared temporaries,
   * because the ricochet loop needs those three values to survive the call
   * that produced them.
   */
  private fireRayLeg(
    origin: THREE.Vector3,
    muzzle: THREE.Vector3,
    dir: THREE.Vector3,
    weapon: WeaponState,
    showTracer: boolean,
    chargeMul: number,
    finalLeg: boolean,
  ): 0 | 1 | 2 | 3 | 4 | 5 {
    this.richHitWall = false;
    this.ray.set(origin, dir);
    const wallHit = this.world.octree.rayIntersect(this.ray);
    const wallDist = wallHit ? wallHit.distance : weapon.def.range;
    const enemyHit = this.enemies.raycast(origin, dir, Math.min(wallDist, weapon.def.range));

    if (enemyHit) {
      const point = this.tmpPoint.copy(origin).addScaledVector(dir, enemyHit.distance);
      // Damage model: base x charge x headshot x crit x run modifiers. A crit is
      // a separate roll from a headshot so the two stack, which is what makes a
      // crit card meaningful on a precision weapon.
      const headshotMul = enemyHit.headshot ? 2 * this.mods.headshotMul : 1;
      const crit = this.mods.critChance > 0 && Math.random() < this.mods.critChance;
      const damage = weapon.def.damage * chargeMul * this.damageScale * this.mods.damageMul *
        headshotMul * (crit ? this.mods.critMul : 1);
      const hit = this.enemies.damageEnemy(
        enemyHit.enemy,
        damage,
        point,
        dir, // knockback impulse along the shot line
        true, // player-owned kill: feeds the combo meter
        PLAYER_TARGET_ID, // threat-table identity, so enemies can hold a grudge
        enemyHit.headshot, // weak-point check for the boss rear core
      );
      // Report the ACTUAL post-mitigation damage: a warden plate eats half the
      // round, and the damage/lifesteal readouts must reflect that, not the
      // number that was nominally fired.
      this.onDamageDealt?.(hit.dealt, enemyHit.headshot);
      // Affix riders: the enemy hit the player, so its Blazing/Glacial/Charged
      // affixes fire here. The player's own cards never own this path.
      this.onEnemyHit?.(enemyHit.enemy, enemyHit.headshot);
      this.effects.ring(point, crit ? 0xffd76b : 0xffffff, 1.2, 0.18);
      if (showTracer) this.effects.tracer(muzzle, point, weapon.def.tracerColor);
      if (weapon.def.blastRadius) this.explode(point, weapon, enemyHit.enemy);
      // Result codes: kill first so the kill feedback always wins, then a
      // blocked non-kill, then the plain head/body hit.
      if (hit.killed) return enemyHit.headshot ? 3 : 4;
      if (hit.blocked) return 5;
      return enemyHit.headshot ? 2 : 1;
    } else if (wallHit && wallDist <= weapon.def.range) {
      const normal = wallHit.triangle.getNormal(this.tmpNormal);
      if (normal.dot(dir) > 0) normal.negate();
      this.richHitWall = true;
      this.richPoint.copy(wallHit.position);
      this.richNormal.copy(normal);
      // Destructible props (barrels) are checked BEFORE the wall treatment so a
      // barrel in front of a wall takes the round instead of the wall eating it.
      if (this.onPropHit?.(wallHit.position, dir, weapon.def.damage * chargeMul * this.damageScale * this.mods.damageMul)) {
        // A prop absorbed the round: it is a stop, not a bounce surface.
        this.richHitWall = false;
        if (showTracer) this.effects.tracer(muzzle, wallHit.position, weapon.def.tracerColor);
        if (weapon.def.blastRadius) {
          const point = this.tmpPoint.copy(wallHit.position);
          this.explode(point, weapon, null);
        }
        return 0;
      }
      this.effects.impact(wallHit.position, normal);
      // The decal belongs to the FINAL stop only: a ricochet that leaves a mark
      // on every surface it grazes turns the arena into a graffiti wall.
      if (finalLeg) this.effects.decal(wallHit.position, normal);
      if (showTracer) this.effects.tracer(muzzle, wallHit.position, weapon.def.tracerColor);
      // A wall hit still detonates — that is the whole point of a launcher.
      if (weapon.def.blastRadius) {
        const point = this.tmpPoint.copy(wallHit.position);
        this.explode(point, weapon, null);
        // A rocket that detonates does not bounce.
        this.richHitWall = false;
      }
    } else if (showTracer) {
      const end = this.tmpPoint.copy(origin).addScaledVector(dir, weapon.def.range);
      this.effects.tracer(muzzle, end, weapon.def.tracerColor);
      if (weapon.def.blastRadius) this.explode(end, weapon, null);
    }
    return 0;
  }
}
