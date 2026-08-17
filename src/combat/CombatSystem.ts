import * as THREE from 'three';
import { WeaponSystem } from './WeaponSystem';

export interface HitResult {
  hit: boolean;
  damage: number;
  target?: string;
  distance: number;
}

export class CombatSystem {
  private readonly muzzleFlash = new THREE.PointLight(0xb7d4ff, 0, 20);

  public constructor(private readonly scene: THREE.Scene, private readonly weapon: WeaponSystem) {
    this.scene.add(this.muzzleFlash);
  }

  public fire(origin: THREE.Vector3, direction: THREE.Vector3): HitResult {
    if (!this.weapon.fire()) return { hit: false, damage: 0, distance: 0 };
    this.muzzleFlash.position.copy(origin);
    this.muzzleFlash.intensity = 4;
    window.setTimeout(() => (this.muzzleFlash.intensity = 0), 50);
    const range = this.weapon.current.projectile ? 120 : 60;
    const distance = direction.length() > 0 ? range : 0;
    return { hit: true, damage: this.weapon.current.damage, target: 'enemy', distance };
  }
}
