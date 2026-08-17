export type WeaponKind =
  | 'pistol' | 'machine-pistol' | 'smg' | 'burst-rifle' | 'assault-rifle'
  | 'carbine' | 'shotgun' | 'auto-shotgun' | 'slug-shotgun' | 'sniper'
  | 'dmr' | 'lmg' | 'heavy-lmg' | 'rocket' | 'grenade' | 'sticky-grenade'
  | 'melee' | 'knife' | 'bat' | 'hammer' | 'crossbow' | 'bow'
  | 'laser' | 'plasma' | 'ion-rifle' | 'railgun' | 'flamethrower'
  | 'tesla' | 'pulse' | 'drone-gun' | 'minigun' | 'energy';

export interface WeaponSpec {
  kind: WeaponKind;
  name: string;
  damage: number;
  ammo: number;
  reserve: number;
  fireRate: number;
  spread: number;
  projectile: boolean;
  burst?: number;
  recoil?: number;
  pellets?: number;
}

const baseWeapons: WeaponSpec[] = [
  { kind: 'pistol', name: 'Pistol', damage: 18, ammo: 12, reserve: 72, fireRate: 4, spread: 0.012, projectile: false, recoil: 1 },
  { kind: 'machine-pistol', name: 'Machine Pistol', damage: 11, ammo: 24, reserve: 144, fireRate: 12, spread: 0.02, projectile: false, recoil: 1.2 },
  { kind: 'smg', name: 'SMG', damage: 9, ammo: 30, reserve: 180, fireRate: 13, spread: 0.045, projectile: false, recoil: 1.15 },
  { kind: 'burst-rifle', name: 'Burst Rifle', damage: 16, ammo: 24, reserve: 144, fireRate: 7, spread: 0.018, projectile: false, burst: 3, recoil: 1.35 },
  { kind: 'assault-rifle', name: 'Assault Rifle', damage: 14, ammo: 30, reserve: 180, fireRate: 8, spread: 0.02, projectile: false, recoil: 1.4 },
  { kind: 'carbine', name: 'Carbine', damage: 15, ammo: 20, reserve: 120, fireRate: 9, spread: 0.014, projectile: false, recoil: 1.1 },
  { kind: 'shotgun', name: 'Shotgun', damage: 8, ammo: 6, reserve: 48, fireRate: 1.1, spread: 0.15, projectile: false, pellets: 8, recoil: 2.8 },
  { kind: 'auto-shotgun', name: 'Auto Shotgun', damage: 7, ammo: 8, reserve: 56, fireRate: 2.5, spread: 0.13, projectile: false, pellets: 7, recoil: 3.2 },
  { kind: 'slug-shotgun', name: 'Slug Shotgun', damage: 48, ammo: 5, reserve: 30, fireRate: 1.4, spread: 0.025, projectile: false, recoil: 2.6 },
  { kind: 'sniper', name: 'Sniper', damage: 95, ammo: 5, reserve: 30, fireRate: 0.8, spread: 0.002, projectile: false, recoil: 4.5 },
  { kind: 'dmr', name: 'DMR', damage: 42, ammo: 10, reserve: 60, fireRate: 3.2, spread: 0.006, projectile: false, recoil: 2.2 },
  { kind: 'lmg', name: 'LMG', damage: 12, ammo: 60, reserve: 240, fireRate: 10, spread: 0.06, projectile: false, recoil: 1.9 },
  { kind: 'heavy-lmg', name: 'Heavy LMG', damage: 15, ammo: 50, reserve: 200, fireRate: 9, spread: 0.07, projectile: false, recoil: 2.4 },
  { kind: 'rocket', name: 'Rocket Launcher', damage: 120, ammo: 1, reserve: 12, fireRate: 0.5, spread: 0.01, projectile: true, recoil: 5 },
  { kind: 'grenade', name: 'Grenade', damage: 100, ammo: 1, reserve: 6, fireRate: 0.3, spread: 0, projectile: true },
  { kind: 'sticky-grenade', name: 'Sticky Grenade', damage: 110, ammo: 1, reserve: 4, fireRate: 0.2, spread: 0, projectile: true },
  { kind: 'melee', name: 'Melee', damage: 35, ammo: 1, reserve: 0, fireRate: 1.5, spread: 0, projectile: false },
  { kind: 'knife', name: 'Knife', damage: 28, ammo: 1, reserve: 0, fireRate: 2.1, spread: 0, projectile: false },
  { kind: 'bat', name: 'Bat', damage: 26, ammo: 1, reserve: 0, fireRate: 1.7, spread: 0, projectile: false },
  { kind: 'hammer', name: 'Hammer', damage: 52, ammo: 1, reserve: 0, fireRate: 1, spread: 0, projectile: false },
  { kind: 'crossbow', name: 'Crossbow', damage: 62, ammo: 1, reserve: 20, fireRate: 1.5, spread: 0.004, projectile: true },
  { kind: 'bow', name: 'Combat Bow', damage: 40, ammo: 1, reserve: 24, fireRate: 1.8, spread: 0.005, projectile: true },
  { kind: 'laser', name: 'Laser', damage: 20, ammo: 50, reserve: 250, fireRate: 14, spread: 0.001, projectile: false },
  { kind: 'plasma', name: 'Plasma Cannon', damage: 34, ammo: 14, reserve: 84, fireRate: 4.2, spread: 0.01, projectile: true },
  { kind: 'ion-rifle', name: 'Ion Rifle', damage: 30, ammo: 20, reserve: 120, fireRate: 6, spread: 0.006, projectile: false },
  { kind: 'railgun', name: 'Railgun', damage: 150, ammo: 4, reserve: 24, fireRate: 0.6, spread: 0.001, projectile: false, recoil: 5.5 },
  { kind: 'flamethrower', name: 'Flamethrower', damage: 6, ammo: 100, reserve: 300, fireRate: 20, spread: 0.12, projectile: true },
  { kind: 'tesla', name: 'Tesla Arc', damage: 24, ammo: 22, reserve: 132, fireRate: 7.5, spread: 0.012, projectile: true },
  { kind: 'pulse', name: 'Pulse Rifle', damage: 17, ammo: 26, reserve: 156, fireRate: 11, spread: 0.016, projectile: false },
  { kind: 'drone-gun', name: 'Drone Gun', damage: 13, ammo: 30, reserve: 180, fireRate: 8.5, spread: 0.03, projectile: true },
  { kind: 'minigun', name: 'Minigun', damage: 10, ammo: 100, reserve: 500, fireRate: 22, spread: 0.08, projectile: false, recoil: 3.6 },
  { kind: 'energy', name: 'Energy Rifle', damage: 22, ammo: 20, reserve: 120, fireRate: 10, spread: 0.008, projectile: true },
];

export class WeaponSystem {
  private index = 0;
  private cooldown = 0;
  private weapon = baseWeapons[0];

  public get current() {
    return this.weapon;
  }

  public update(delta: number) {
    this.cooldown = Math.max(0, this.cooldown - delta);
  }

  public select(slot: number) {
    const weapon = baseWeapons[(slot - 1) % baseWeapons.length];
    if (weapon) {
      this.weapon = weapon;
      this.index = baseWeapons.indexOf(weapon);
    }
  }

  public next() {
    this.index = (this.index + 1) % baseWeapons.length;
    this.weapon = baseWeapons[this.index];
  }

  public fire() {
    if (this.cooldown > 0 || this.weapon.ammo <= 0) return false;
    this.weapon = { ...this.weapon, ammo: this.weapon.ammo - 1 };
    this.cooldown = 1 / this.weapon.fireRate;
    return true;
  }

  public reload() {
    const weapon = baseWeapons[this.index];
    this.weapon = weapon;
  }

  public status() {
    return `${this.weapon.name} ${this.weapon.ammo} / ${this.weapon.reserve}`;
  }

  public catalog() {
    return baseWeapons;
  }
}

