import type { ShotSound } from '../audio/Audio';

export type WeaponId = 'ar' | 'smg' | 'shotgun' | 'rail';

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  pellets: number;
  fireRate: number; // shots per second
  magSize: number;
  reserve: number;
  reloadTime: number;
  spread: number; // radians base
  spreadMoving: number;
  recoil: number;
  auto: boolean;
  range: number;
  sound: ShotSound;
  tracerColor: number;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar', name: 'Vanguard AR',
    damage: 22, pellets: 1, fireRate: 8, magSize: 30, reserve: 150,
    reloadTime: 1.5, spread: 0.006, spreadMoving: 0.02, recoil: 0.014,
    auto: true, range: 120, sound: 'ar', tracerColor: 0x9fd0ff,
  },
  smg: {
    id: 'smg', name: 'Hornet SMG',
    damage: 13, pellets: 1, fireRate: 13, magSize: 40, reserve: 200,
    reloadTime: 1.2, spread: 0.014, spreadMoving: 0.035, recoil: 0.009,
    auto: true, range: 80, sound: 'smg', tracerColor: 0xffd28a,
  },
  shotgun: {
    id: 'shotgun', name: 'Breaker SG',
    damage: 11, pellets: 9, fireRate: 1.4, magSize: 6, reserve: 36,
    reloadTime: 2.2, spread: 0.055, spreadMoving: 0.07, recoil: 0.05,
    auto: false, range: 40, sound: 'shotgun', tracerColor: 0xffb36b,
  },
  rail: {
    id: 'rail', name: 'Lance Rail',
    damage: 130, pellets: 1, fireRate: 0.9, magSize: 4, reserve: 20,
    reloadTime: 2.4, spread: 0.0008, spreadMoving: 0.004, recoil: 0.06,
    auto: false, range: 200, sound: 'rail', tracerColor: 0x7dffd4,
  },
};

export const WEAPON_ORDER: WeaponId[] = ['ar', 'smg', 'shotgun', 'rail'];

export interface WeaponState {
  def: WeaponDef;
  mag: number;
  reserve: number;
  reloading: boolean;
  reloadT: number;
  cooldown: number;
}

export function createWeaponState(id: WeaponId): WeaponState {
  const def = WEAPONS[id];
  return { def, mag: def.magSize, reserve: def.reserve, reloading: false, reloadT: 0, cooldown: 0 };
}
