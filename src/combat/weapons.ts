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
  /**
   * Aimed field of view in degrees. Lower is more zoom. Every weapon has one:
   * aiming is a real change of sight picture for all ten, which is what makes
   * ADS a decision rather than a hold-to-slow-walk button.
   */
  adsFov: number;
  /**
   * True for weapons with a magnified optic. These get the scope overlay and a
   * much lower `adsFov`; the overlay is the tell that separates "aiming" from
   * "scoped", so a player always knows which one they are holding.
   */
  scoped: boolean;
  /**
   * Charge-up: seconds the trigger must be held before the shot releases. The
   * trade is a much larger hit for a telegraph the enemy can dodge, which is
   * what gives the heavy weapons a rhythm instead of a rate.
   */
  chargeTime?: number;
  /** Damage multiplier applied at full charge (only meaningful with chargeTime). */
  chargeDamageMul?: number;
  /**
   * Ricochet: how many times a round can bounce off world geometry. Bounced
   * rounds keep their damage, so the rail becomes a bank-shot weapon in cover.
   */
  ricochet?: number;
  /** Movement speed multiplier while this weapon is equipped. */
  moveMul?: number;
  /** One-line role, shown in the loadout screen. */
  role: string;
}

export const WEAPONS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar', name: 'Vanguard AR',
    damage: 22, pellets: 1, fireRate: 8, magSize: 30, reserve: 150,
    reloadTime: 1.5, spread: 0.006, spreadMoving: 0.02, recoil: 0.014,
    auto: true, range: 120, sound: 'ar', tracerColor: 0x9fd0ff,
    adsFov: 55, scoped: false, moveMul: 1,
    role: 'All-round rifle. The one you always have.',
  },
  smg: {
    id: 'smg', name: 'Hornet SMG',
    damage: 13, pellets: 1, fireRate: 13, magSize: 40, reserve: 200,
    reloadTime: 1.2, spread: 0.014, spreadMoving: 0.035, recoil: 0.009,
    auto: true, range: 80, sound: 'smg', tracerColor: 0xffd28a,
    adsFov: 62, scoped: false, moveMul: 1.08,
    role: 'Fastest fire rate and fastest feet. Wins the close fight.',
  },
  shotgun: {
    id: 'shotgun', name: 'Breaker SG',
    damage: 11, pellets: 9, fireRate: 1.4, magSize: 6, reserve: 36,
    reloadTime: 2.2, spread: 0.055, spreadMoving: 0.07, recoil: 0.05,
    auto: false, range: 40, sound: 'shotgun', tracerColor: 0xffb36b,
    adsFov: 68, scoped: false, moveMul: 0.95,
    role: 'Nine pellets. Nothing survives inside 10 metres.',
  },
  rail: {
    id: 'rail', name: 'Lance Rail',
    damage: 130, pellets: 1, fireRate: 0.9, magSize: 4, reserve: 20,
    reloadTime: 2.4, spread: 0.0008, spreadMoving: 0.004, recoil: 0.06,
    auto: false, range: 200, sound: 'rail', tracerColor: 0x7dffd4,
    adsFov: 18, scoped: true, ricochet: 2, moveMul: 0.88,
    // 0.6 s of charge buys 1.35x: 130 -> 175.5, deliberately just under a
    // warden's 180 HP. A full charge is worth the wait but is not a free
    // execute, so the plate still matters.
    chargeTime: 0.6, chargeDamageMul: 1.35,
    role: 'Scoped. Charge for 1.35x. Ricochets twice off cover.',
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
    adsFov: 26, scoped: true, moveMul: 0.94,
    role: 'Scoped marksman rifle. Three shots kill a warden.',
  },
  // LMG: sustained DPS ~124 matches the AR's 126, so it adds NO damage creep —
  // its value is 100 rounds (11.1 s of fire) versus the AR's 3.75 s. The 3.3x
  // base spread makes it a stationary lane-holder, not a duellist.
  lmg: {
    id: 'lmg', name: 'Bastion LMG',
    damage: 19, pellets: 1, fireRate: 9, magSize: 100, reserve: 140,
    reloadTime: 4.2, spread: 0.02, spreadMoving: 0.045, recoil: 0.011,
    auto: true, range: 110, sound: 'lmg', tracerColor: 0xc9d4ff,
    adsFov: 58, scoped: false, moveMul: 0.82,
    role: '100 rounds. Plant your feet and hold the lane.',
  },
  // Pistol: deliberately last on every axis. Its role is the 105-round pool and
  // the fastest reload in the game — the "never caught empty" backup.
  pistol: {
    id: 'pistol', name: 'Sidewinder',
    damage: 26, pellets: 1, fireRate: 4.5, magSize: 15, reserve: 90,
    reloadTime: 1.1, spread: 0.01, spreadMoving: 0.025, recoil: 0.018,
    auto: false, range: 70, sound: 'pistol', tracerColor: 0xffffff,
    adsFov: 60, scoped: false, moveMul: 1.12,
    role: 'Never caught empty. Fastest reload, lightest feet.',
  },
  // Launcher: linear falloff to a 35% floor, self-damage on a separate smaller
  // radius. Blast vertical impulse is capped so it can never replace a jump.
  launcher: {
    id: 'launcher', name: 'Siegebreaker',
    damage: 95, pellets: 1, fireRate: 0.85, magSize: 3, reserve: 12,
    reloadTime: 2.6, spread: 0.012, spreadMoving: 0.02, recoil: 0.09,
    auto: false, range: 90, sound: 'launcher', tracerColor: 0xff8a3c,
    blastRadius: 4, blastFloor: 0.35, selfBlastRadius: 3.2, selfBlastFraction: 0.4,
    adsFov: 64, scoped: false, moveMul: 0.86,
    // A 0.4 s charge on the rocket is a short, readable commitment: it is
    // enough that a panicked point-blank shot is not instant, and short enough
    // that the weapon still works as a reaction tool.
    chargeTime: 0.4, chargeDamageMul: 1.2,
    role: 'Splash damage. Charge to 1.2x. Do not fire it at your feet.',
  },
  // Beam: 0.012 moving spread versus the SMG's 0.035 makes it the only weapon
  // that does not degrade while strafing. Six seconds of fire, then a long reload.
  beam: {
    id: 'beam', name: 'Helios Beam',
    damage: 9, pellets: 1, fireRate: 20, magSize: 120, reserve: 240,
    reloadTime: 2.8, spread: 0.004, spreadMoving: 0.012, recoil: 0.003,
    auto: true, range: 60, sound: 'beam', tracerColor: 0xff5cf0,
    adsFov: 60, scoped: false, moveMul: 0.96,
    role: 'No spread penalty while moving. A hose of light.',
  },
  // Burst: 21 x 3 = 63, the minimum burst that one-shots a grunt. Budget is
  // gated by cadence — only ten trigger pulls before a 1.8 s reload.
  burst: {
    id: 'burst', name: 'Trident Burst',
    damage: 21, pellets: 1, fireRate: 2.2, magSize: 30, reserve: 60,
    reloadTime: 1.8, spread: 0.004, spreadMoving: 0.015, recoil: 0.02,
    auto: false, range: 130, sound: 'burst', tracerColor: 0x9dffb0,
    burstCount: 3,
    adsFov: 50, scoped: false, moveMul: 0.98,
    role: 'Three-round burst. Rewards trigger discipline.',
  },
};

export const WEAPON_ORDER = [
  'ar', 'smg', 'shotgun', 'rail', 'dmr', 'lmg', 'pistol', 'launcher', 'beam', 'burst',
] as const satisfies readonly WeaponId[];

/**
 * Loadout rules. Four slots is the whole point: ten weapons cycled in battle is
 * a menu you have to operate mid-fight, and four is a decision you make once.
 * The pool stays ten, so the loadout screen is where the arsenal lives.
 */
export const LOADOUT_SLOTS = 4;
export const DEFAULT_LOADOUT: readonly WeaponId[] = ['ar', 'shotgun', 'dmr', 'rail'];

/** True when `id` is a valid weapon id (used to sanitize a saved loadout). */
export function isWeaponId(id: string): id is WeaponId {
  return Object.prototype.hasOwnProperty.call(WEAPONS, id);
}

/**
 * Repair a stored loadout: drop anything unknown, de-duplicate, pad from the
 * default list. A corrupted save must never leave the player with no weapon.
 */
export function sanitizeLoadout(ids: readonly string[]): WeaponId[] {
  const out: WeaponId[] = [];
  for (const id of ids) {
    if (!isWeaponId(id) || out.includes(id)) continue;
    out.push(id);
    if (out.length >= LOADOUT_SLOTS) break;
  }
  for (const id of DEFAULT_LOADOUT) {
    if (out.length >= LOADOUT_SLOTS) break;
    if (!out.includes(id)) out.push(id);
  }
  for (const id of WEAPON_ORDER) {
    if (out.length >= LOADOUT_SLOTS) break;
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

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
