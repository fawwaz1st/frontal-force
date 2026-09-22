import * as THREE from 'three';
import type { Enemy, EnemyManager } from '../enemies/Enemies';
import type { Player } from '../player/Player';
import type { InputFrame } from '../input/Input';
import type { Effects } from './Effects';
import type { GameAudio } from '../audio/Audio';
import type { World } from '../world/World';
import { WEAPON_ORDER, createWeaponState, type WeaponState } from './weapons';

export interface WeaponView {
  index: number;
  count: number;
  name: string;
  mag: number;
  reserve: number;
  reloading: boolean;
  reloadProgress: number;
}

/** Owns all weapon state: inventory, ammo, reload, switching, and firing. */
export class WeaponController {
  private states: WeaponState[] = WEAPON_ORDER.map(createWeaponState);
  private index = 0;

  private readonly ray = new THREE.Ray();
  private readonly tmpOrigin = new THREE.Vector3();
  private readonly tmpDir = new THREE.Vector3();
  private readonly tmpPoint = new THREE.Vector3();
  private readonly tmpNormal = new THREE.Vector3();
  private readonly tmpPellet = new THREE.Vector3();
  private readonly tmpMuzzle = new THREE.Vector3();

  public constructor(
    private readonly player: Player,
    private readonly enemies: EnemyManager,
    private readonly world: World,
    private readonly effects: Effects,
    private readonly audio: GameAudio,
    private readonly onHitFeedback: (kind: 'hit' | 'headshot') => void,
  ) {}

  public get current(): WeaponState {
    return this.states[this.index] ?? this.states[0]!;
  }

  public get currentIndex(): number {
    return this.index;
  }

  public get count(): number {
    return this.states.length;
  }

  public view(): WeaponView {
    const w = this.current;
    return {
      index: this.index,
      count: this.states.length,
      name: w.def.name,
      mag: w.mag,
      reserve: w.reserve,
      reloading: w.reloading,
      reloadProgress: w.reloading ? Math.min(w.reloadT / w.def.reloadTime, 1) : 0,
    };
  }

  public reset(): void {
    this.states = WEAPON_ORDER.map(createWeaponState);
    this.index = 0;
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
    if (frame.cycleWeapon !== 0) {
      const n = this.states.length;
      this.switchTo((this.index + (frame.cycleWeapon > 0 ? 1 : -1) + n) % n);
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
        this.fire(weapon);
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

  private fire(weapon: WeaponState): void {
    weapon.mag -= 1;
    weapon.cooldown = 1 / weapon.def.fireRate;
    this.player.addRecoil(weapon.def.recoil);
    this.audio.shot(weapon.def.sound);

    this.player.eyePosition(this.tmpOrigin);
    this.player.forward(this.tmpDir);

    const moving = this.player.horizontalSpeed > 2;
    const spread = moving ? weapon.def.spreadMoving : weapon.def.spread;

    for (let pellet = 0; pellet < weapon.def.pellets; pellet++) {
      const dir = this.tmpPellet.copy(this.tmpDir);
      dir.x += (Math.random() - 0.5) * 2 * spread;
      dir.y += (Math.random() - 0.5) * 2 * spread;
      dir.z += (Math.random() - 0.5) * 2 * spread;
      dir.normalize();
      this.fireRay(this.tmpOrigin, dir, weapon, pellet === 0);
    }
  }

  private fireRay(origin: THREE.Vector3, dir: THREE.Vector3, weapon: WeaponState, showTracer: boolean): void {
    this.ray.set(origin, dir);
    const wallHit = this.world.octree.rayIntersect(this.ray);
    const wallDist = wallHit ? wallHit.distance : weapon.def.range;
    const enemyHit = this.enemies.raycast(origin, dir, Math.min(wallDist, weapon.def.range));

    if (enemyHit) {
      const point = this.tmpPoint.copy(origin).addScaledVector(dir, enemyHit.distance);
      this.enemies.damageEnemy(enemyHit.enemy, enemyHit.headshot ? weapon.def.damage * 2 : weapon.def.damage, point);
      this.effects.ring(point, 0xffffff, 1.2, 0.18);
      this.onHitFeedback(enemyHit.headshot ? 'headshot' : 'hit');
      if (showTracer) this.effects.tracer(this.muzzlePoint(origin, dir), point, weapon.def.tracerColor);
    } else if (wallHit && wallDist <= weapon.def.range) {
      const normal = wallHit.triangle.getNormal(this.tmpNormal);
      if (normal.dot(dir) > 0) normal.negate();
      this.effects.impact(wallHit.position, normal);
      if (showTracer) this.effects.tracer(this.muzzlePoint(origin, dir), wallHit.position, weapon.def.tracerColor);
    } else if (showTracer) {
      const end = this.tmpPoint.copy(origin).addScaledVector(dir, weapon.def.range);
      this.effects.tracer(this.muzzlePoint(origin, dir), end, weapon.def.tracerColor);
    }
  }

  private muzzlePoint(origin: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 {
    const out = this.tmpMuzzle.copy(origin).addScaledVector(dir, 0.6);
    out.y -= 0.12;
    return out;
  }
}
