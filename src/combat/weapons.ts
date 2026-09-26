import type { ShotSound } from '../audio/Audio';

export type WeaponId = 'ar' | 'smg' | 'shotgun' | 'rail' | 'dmr' | 'lmg' | 'pistol' | 'launcher' | 'beam' | 'burst';

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
  /** Explosive rounds splash this many metres around the impact (0 = none). */
  blastRadius?: number;
  /** Damage at the blast edge as a fraction of the centre hit (0..1). */
  blastFloor?: number;
  /** Self-damage radius and fraction — keeps point-blank shots punishing
   *  without letting the blast substitute for a jump. */
  selfBlastRadius?: number;
  selfBlastFraction?: number;
  /** Burst fire: rounds per trigger pull (sequential, not simultaneous). */
  burstCount?: number;
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
  // ---- Extended arsenal ----
  // DMR: the smallest damage that three-taps a warden (3 x 62 = 186 >= 180),
  // so it is the only mid-range gun that out-TTKs the AR on the tankiest enemy
  // (0.77 s vs 1.00 s) while still one-shotting a grunt.
  dmr: {
    id: 'dmr', name: 'Harrier DMR',
    damage: 62, pellets: 1, fireRate: 2.6, magSize: 12, reserve: 54,
    reloadTime: 1.9, spread: 0.002, spreadMoving: 0.012, recoil: 0.028,
    auto: false, range: 150, sound: 'dmr', tracerColor: 0xffe08a,
  },
  // LMG: sustained DPS ~124 matches the AR's 126, so it adds NO damage creep —
  // its value is 100 rounds (11.1 s of fire) versus the AR's 3.75 s. The 3.3x
  // base spread makes it a stationary lane-holder, not a duellist.
  lmg: {
    id: 'lmg', name: 'Bastion LMG',
    damage: 19, pellets: 1, fireRate: 9, magSize: 100, reserve: 140,
    reloadTime: 4.2, spread: 0.02, spreadMoving: 0.045, recoil: 0.011,
    auto: true, range: 110, sound: 'lmg', tracerColor: 0xc9d4ff,
  },
  // Pistol: deliberately last on every axis. Its role is the 105-round pool and
  // the fastest reload in the game — the "never caught empty" backup.
  pistol: {
    id: 'pistol', name: 'Sidewinder',
    damage: 26, pellets: 1, fireRate: 4.5, magSize: 15, reserve: 90,
    reloadTime: 1.1, spread: 0.01, spreadMoving: 0.025, recoil: 0.018,
    auto: false, range: 70, sound: 'pistol', tracerColor: 0xffffff,
  },
  // Launcher: linear falloff to a 35% floor, self-damage on a separate smaller
  // radius. Blast vertical impulse is capped so it can never replace a jump.
  launcher: {
    id: 'launcher', name: 'Siegebreaker',
    damage: 95, pellets: 1, fireRate: 0.85, magSize: 3, reserve: 12,
    reloadTime: 2.6, spread: 0.012, spreadMoving: 0.02, recoil: 0.09,
    auto: false, range: 90, sound: 'launcher', tracerColor: 0xff8a3c,
    blastRadius: 4, blastFloor: 0.35, selfBlastRadius: 3.2, selfBlastFraction: 0.4,
  },
  // Beam: 0.012 moving spread versus the SMG's 0.035 makes it the only weapon
  // that does not degrade while strafing. Six seconds of fire, then a long reload.
  beam: {
    id: 'beam', name: 'Helios Beam',
    damage: 9, pellets: 1, fireRate: 20, magSize: 120, reserve: 240,
    reloadTime: 2.8, spread: 0.004, spreadMoving: 0.012, recoil: 0.003,
    auto: true, range: 60, sound: 'beam', tracerColor: 0xff5cf0,
  },
  // Burst: 21 x 3 = 63, the minimum burst that one-shots a grunt. Budget is
  // gated by cadence — only ten trigger pulls before a 1.8 s reload.
  burst: {
    id: 'burst', name: 'Trident Burst',
    damage: 21, pellets: 1, fireRate: 2.2, magSize: 30, reserve: 60,
    reloadTime: 1.8, spread: 0.004, spreadMoving: 0.015, recoil: 0.02,
    auto: false, range: 130, sound: 'burst', tracerColor: 0x9dffb0,
    burstCount: 3,
  },
};

export const WEAPON_ORDER = [
  'ar', 'smg', 'shotgun', 'rail', 'dmr', 'lmg', 'pistol', 'launcher', 'beam', 'burst',
] as const satisfies readonly WeaponId[];

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
