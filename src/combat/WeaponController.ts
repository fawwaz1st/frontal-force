import * as THREE from 'three';
import type { EnemyManager } from '../enemies/Enemies';
import type { Player } from '../player/Player';
import type { InputFrame } from '../input/Input';
import type { Effects } from './Effects';
import type { GameAudio } from '../audio/Audio';
import type { World } from '../world/World';
import { WEAPON_ORDER, createWeaponState, type WeaponState } from './weapons';

const UP = new THREE.Vector3(0, 1, 0);

export interface WeaponView {
  index: number;
  mag: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
}

/** Owns all weapon state: inventory, ammo, reload, switching, and firing. */
export class WeaponController {
  private states: WeaponState[] = WEAPON_ORDER.map(createWeaponState);
  private index = 0;
  private readonly viewSnapshot: WeaponView = {
    index: 0,
    mag: 0,
    reserve: 0,
    reloading: false,
    reloadProgress: 0,
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

  public onFired: ((weapon: WeaponState) => void) | null = null;
  public onSwitched: (() => void) | null = null;
  /** Damage multiplier for endless modes — mirrors the enemy HP ramp so a
   *  fixed ammo pool never becomes a hard wall. 1 in every finite mode. */
  public damageScale = 1;
  /** Latest player muzzle in world space; consumed once by enemy hearing. */
  public lastShot: THREE.Vector3 | null = null;
  /** Supplies the current weapon muzzle in WORLD space (eye + viewmodel offset). */
  public getMuzzle:
    | ((eye: THREE.Vector3, out: THREE.Vector3) => void)
    | null = null;

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
    return view;
  }

  public reset(): void {
    this.states = WEAPON_ORDER.map(createWeaponState);
    this.index = 0;
    this.lastShot = null;
  }

  /** Single source for bullet and crosshair spread. */
  public spreadFor(moving: boolean, aiming: boolean): number {
    if (aiming) return this.current.def.spread * 0.6;
    return moving ? this.current.def.spreadMoving : this.current.def.spread;
  }

  /** Full ammo top-up from an ammo pickup. */
  public refillReserve(): void {
    for (const w of this.states) {
      w.reserve = Math.min(w.def.reserve, w.reserve + Math.ceil(w.def.magSize * 1.5));
    }
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
      weapon.reloadT += dt;
      if (weapon.reloadT >= weapon.def.reloadTime) this.finishReload(weapon);
    } else if (frame.reloadPressed && weapon.mag < weapon.def.magSize && weapon.reserve > 0) {
      this.beginReload(weapon);
    }

    const wantsFire = weapon.def.auto ? frame.fireHeld : frame.firePressed;
    if (wantsFire && frame.locked && !weapon.reloading && weapon.cooldown <= 0) {
      if (weapon.mag <= 0) {
        this.audio.empty();
        weapon.cooldown = 0.25;
        if (weapon.reserve > 0) this.beginReload(weapon);
      } else {
        this.fire(weapon, this.player.isAiming);
      }
    }
  }

  private switchTo(index: number): void {
    if (index === this.index) return;
    const current = this.states[this.index];
    if (current) current.reloading = false;
    this.index = index;
    const next = this.states[index];
    if (next) next.cooldown = Math.max(next.cooldown, 0.18);
    this.onSwitched?.();
  }

  /** Gun-game rotation: next weapon in slot order (ROTATION mode). */
  public rotate(): void {
    this.switchTo((this.index + 1) % this.states.length);
  }

  private beginReload(weapon: WeaponState): void {
    weapon.reloading = true;
    weapon.reloadT = 0;
    this.audio.reload();
  }

  private finishReload(weapon: WeaponState): void {
    const need = weapon.def.magSize - weapon.mag;
    const take = Math.min(need, weapon.reserve);
    weapon.mag += take;
    weapon.reserve -= take;
    weapon.reloading = false;
  }

  private fire(weapon: WeaponState, aiming: boolean): void {
    weapon.mag -= 1;
    weapon.cooldown = 1 / weapon.def.fireRate;
    this.player.addRecoil(weapon.def.recoil);
    this.audio.shot(weapon.def.sound);
    this.onFired?.(weapon);

    this.player.eyePosition(this.tmpOrigin);
    this.player.forward(this.tmpDir);

    // Bullets leave the GUN, not the camera: muzzle in world space…
    const muzzle = this.tmpMuzzle.copy(this.tmpOrigin);
    this.getMuzzle?.(this.tmpOrigin, muzzle);
    this.lastShot = muzzle;
    // …but converge on whatever the crosshair points at (eye-cast aim point).
    this.ray.set(this.tmpOrigin, this.tmpDir);
    const aimWall = this.world.octree.rayIntersect(this.ray);
    const aimMax = Math.min(aimWall ? aimWall.distance : weapon.def.range, weapon.def.range);
    const aimEnemy = this.enemies.raycast(this.tmpOrigin, this.tmpDir, aimMax);
    const aimDist = aimEnemy ? aimEnemy.distance : aimMax;
    const aim = this.tmpPoint.copy(this.tmpOrigin).addScaledVector(this.tmpDir, aimDist);
    const baseDir = aim.sub(muzzle);
    if (baseDir.lengthSq() < 1e-6) baseDir.copy(this.tmpDir);
    baseDir.normalize();

    const spread = this.spreadFor(this.player.horizontalSpeed > 2, aiming);
    let hitAny = false;
    let blockedAny = false;
    let headshotAny = false;
    let killedAny = false;
    const right = this.tmpRight.crossVectors(baseDir, UP);
    if (right.lengthSq() < 1e-8) right.set(1, 0, 0);
    right.normalize();
    const up = this.tmpUp.crossVectors(right, baseDir).normalize();

    for (let pellet = 0; pellet < weapon.def.pellets; pellet++) {
      const angle = Math.tan(spread) * Math.sqrt(Math.random());
      const azimuth = Math.random() * Math.PI * 2;
      const dir = this.tmpPellet.copy(baseDir)
        .addScaledVector(right, Math.cos(azimuth) * angle)
        .addScaledVector(up, Math.sin(azimuth) * angle)
        .normalize();
      const result = this.fireRay(muzzle, dir, weapon, pellet === 0);
      hitAny ||= result !== 0;
      blockedAny ||= result === 4;
      headshotAny ||= result === 2 || result === 3;
      killedAny ||= result === 3;
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

  /** 0 miss, 1 hit, 2 headshot, 3 kill, 4 blocked by armour. */
  private fireRay(origin: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponState, showTracer: boolean): 0 | 1 | 2 | 3 | 4 {
    this.ray.set(origin, dir);
    const wallHit = this.world.octree.rayIntersect(this.ray);
    const wallDist = wallHit ? wallHit.distance : weapon.def.range;
    const enemyHit = this.enemies.raycast(origin, dir, Math.min(wallDist, weapon.def.range));

    if (enemyHit) {
      const point = this.tmpPoint.copy(origin).addScaledVector(dir, enemyHit.distance);
      const hit = this.enemies.damageEnemy(
        enemyHit.enemy,
        (enemyHit.headshot ? weapon.def.damage * 2 : weapon.def.damage) * this.damageScale,
        point,
        dir, // knockback impulse along the shot line
        true, // player-owned kill: feeds the combo meter
      );
      this.effects.ring(point, 0xffffff, 1.2, 0.18);
      if (showTracer) this.effects.tracer(origin, point, weapon.def.tracerColor);
      if (hit.killed) return 3;
      if (hit.blocked) return 4;
      return enemyHit.headshot ? 2 : 1;
    } else if (wallHit && wallDist <= weapon.def.range) {
      const normal = wallHit.triangle.getNormal(this.tmpNormal);
      if (normal.dot(dir) > 0) normal.negate();
      this.effects.impact(wallHit.position, normal);
      this.effects.decal(wallHit.position, normal);
      if (showTracer) this.effects.tracer(origin, wallHit.position, weapon.def.tracerColor);
    } else if (showTracer) {
      const end = this.tmpPoint.copy(origin).addScaledVector(dir, weapon.def.range);
      this.effects.tracer(origin, end, weapon.def.tracerColor);
    }
    return 0;
  }
}
