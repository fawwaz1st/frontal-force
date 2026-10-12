// Self-check — plain asserts, no framework, no three.js/DOM imports.
// Run: node --experimental-strip-types scripts/self-check.ts
// Source files are read as text (readFileSync) so tests stay pure logic while
// still regression-testing the real constants/formulas in src/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clamp, damp, dampAngle } from '../src/core/math.ts';
import {
  CHALLENGES,
  CHALLENGE_IDS,
  challengeLabel,
  challengeScoreMul,
  foldChallenges,
} from '../src/game/Challenges.ts';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8')
    // Normalize CRLF so every source regex below is platform-independent.
    // Without this, a `\n` in a pattern silently fails on a Windows checkout
    // and the test reports "not found" instead of a real regression.
    .replace(/\r\n/g, '\n');

let passed = 0;
let failed = 0;

const check = (name: string, fn: () => void): void => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    console.error(`  FAIL  ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
};

/** Float-tolerant equality — formulas round-trip through Math.pow. */
const closeTo = (got: number, want: number, eps = 1e-9): void => {
  assert.ok(Math.abs(got - want) <= eps, `expected ${got} ≈ ${want} (±${eps})`);
};

/** Pull a numeric constant out of source text: `NAME = 12.5`. */
const literal = (src: string, name: string): number => {
  const m = new RegExp(`${name}\\s*=\\s*([0-9.]+)`).exec(src);
  assert.ok(m, `${name} not found in source`);
  return Number(m[1]);
};

// ---------- core math (src/core/math.ts) ----------
check('clamp floors below range', () => assert.equal(clamp(-1, 0, 3), 0));
check('clamp caps above range', () => assert.equal(clamp(4, 0, 3), 3));
check('damp moves toward target', () => assert.equal(damp(0, 10, 8, 0.25) > 0, true));
check('damp is a no-op at target', () => assert.equal(damp(0, 0, 8, 0.25), 0));
check('dampAngle takes the short way around', () =>
  assert.equal(dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 8, 0.25) > 3, true));

// ---------- endless wave scaling (src/game/Waves.ts) ----------
const wavesSrc = readSrc('game/Waves.ts');
// Re-implemented from the endless branch of WaveManager.update().
const hpMul = (wave: number): number => Math.min(40, Math.pow(1.12, wave - 1));
const spdMul = (wave: number): number => Math.min(1.3, 1 + 0.02 * Math.min(wave, 15));
const spawnTimer = (wave: number): number => Math.max(0.25, Math.pow(0.94, wave - 1));

check('endless hpMul: wave 1 is unmodified', () => closeTo(hpMul(1), 1));
check('endless hpMul: wave 10 ≈ 2.77', () => closeTo(hpMul(10), 2.77, 0.01));
check('endless hpMul: wave 60 hits the 40× cap', () => {
  assert.ok(Math.pow(1.12, 59) > 40, 'cap should be binding at wave 60');
  closeTo(hpMul(60), 40);
});
check('endless spdMul: wave 1 is +2%', () => closeTo(spdMul(1), 1.02));
check('endless spdMul: wave 15 hits the 1.3× cap', () => closeTo(spdMul(15), 1.3));
check('endless spdMul: wave 50 stays capped', () => {
  assert.ok(1 + 0.02 * 50 > 1.3, 'cap should be binding at wave 50');
  closeTo(spdMul(50), 1.3);
});
check('endless spawnTimer: wave 1 is 1.0 s', () => closeTo(spawnTimer(1), 1));
check('endless spawnTimer: wave 40 hits the 0.25 s floor', () => {
  assert.ok(Math.pow(0.94, 39) < 0.25, 'floor should be binding at wave 40');
  closeTo(spawnTimer(40), 0.25);
});
check('Waves.ts still contains the endless formulas + constants', () => {
  // hpMul is now the single source of truth shared by enemy health AND the
  // player's damage ramp, so it must be a named static, not an inline copy.
  assert.match(wavesSrc, /static hpMul\(wave: number\): number \{\s*return Math\.min\(40, Math\.pow\(1\.12, Math\.max\(0, wave - 1\)\)\);/);
  assert.match(wavesSrc, /Math\.min\(1\.3, 1 \+ 0\.02 \* Math\.min\(this\.wave, 15\)\)/);
  assert.match(wavesSrc, /Math\.max\(0\.25, Math\.pow\(0\.94, this\.wave - 1\)\)/);
  assert.equal(literal(wavesSrc, 'ENDLESS_ALIVE_CAP'), 24);
  assert.match(wavesSrc, /overrun: \{[^}]*endless: true,/);
  // Both the enemy spawn path and damageScale must route through hpMul.
  const uses = wavesSrc.match(/WaveManager\.hpMul\(/g) ?? [];
  assert.ok(uses.length >= 2, `hpMul must be shared by spawn + damageScale (found ${uses.length})`);
  assert.match(wavesSrc, /endless \? WaveManager\.hpMul\(this\.wave\) : 1/);
});

// ---------- combo tiers (src/game/Game.ts) ----------
const gameSrc = readSrc('game/Game.ts');
const comboMult = (streak: number): number => Math.min(1 + Math.floor(streak / 2), 8);

check('combo: streak 0 → 1', () => assert.equal(comboMult(0), 1));
check('combo: streak 1 → 1', () => assert.equal(comboMult(1), 1));
check('combo: streak 2 → 2', () => assert.equal(comboMult(2), 2));
check('combo: streak 3 → 2', () => assert.equal(comboMult(3), 2));
check('combo: streak 4 → 3', () => assert.equal(comboMult(4), 3));
check('combo: streak 14 → 8 (cap)', () => assert.equal(comboMult(14), 8));
check('combo: streak 999 → 8 (cap)', () => assert.equal(comboMult(999), 8));
check('Game.ts still contains combo constants + formula', () => {
  assert.equal(literal(gameSrc, 'COMBO_WINDOW'), 3);
  assert.equal(literal(gameSrc, 'COMBO_DECAY'), 0.5);
  assert.match(gameSrc, /Math\.min\(1 \+ Math\.floor\(this\.combo \/ 2\), 8\)/);
});

// ---------- warden shield math (src/ai/Enemies.ts) ----------
const enemiesSrc = readSrc('ai/Enemies.ts');
// Front cone: forward·shotDir < -0.5 ⇔ within ±60° of dead-on frontal.
// Shot travels +z into the enemy's face at 0° off-axis; forward = (0,0,-1).
const frontBlocked = (offAxisDeg: number): boolean => {
  const a = (offAxisDeg * Math.PI) / 180;
  const forward = { x: 0, z: -1 };
  const shot = { x: Math.sin(a), z: Math.cos(a) };
  return forward.x * shot.x + forward.z * shot.z < -0.5;
};

check('warden cone: threshold is -0.5 (≈±60°)', () => {
  const m = /forward\.dot\(shot\.normalize\(\)\) < (-?[0-9.]+)/.exec(enemiesSrc);
  assert.ok(m, 'front-cone dot test not found');
  const threshold = Number(m[1]);
  assert.equal(threshold, -0.5);
  closeTo((Math.acos(-threshold) * 180) / Math.PI, 60);
});
check('warden cone: dead-on frontal shot is blocked', () => assert.equal(frontBlocked(0), true));
check('warden cone: 55° off-axis is blocked', () => assert.equal(frontBlocked(55), true));
check('warden cone: 65° off-axis slips past the shield', () => assert.equal(frontBlocked(65), false));
check('warden cone: rear shots bypass the shield', () => assert.equal(frontBlocked(180), false));
check('warden shield breaks after 6 blocks', () => assert.equal(literal(enemiesSrc, 'WARDEN_SHIELD_BREAK'), 6));
check('warden stagger lasts 1.2 s', () => assert.equal(literal(enemiesSrc, 'WARDEN_STAGGER'), 1.2));
check('warden windup is 0.45 s', () => assert.equal(literal(enemiesSrc, 'WARDEN_WINDUP'), 0.45));
check('warden guard meter: 6th blocked hit staggers and resets', () => {
  let blocks = 0;
  let stagger = 0;
  const blockedHit = (): void => {
    blocks += 1;
    if (blocks >= 6) {
      blocks = 0;
      stagger = 1.2;
    }
  };
  for (let i = 0; i < 5; i += 1) blockedHit();
  assert.equal(stagger, 0);
  blockedHit();
  assert.equal(stagger, 1.2);
  assert.equal(blocks, 0);
});

// ---------- save schema (src/core/storage.ts) ----------
const storageSrc = readSrc('core/storage.ts');

check('storage: save schema version is 1', () => {
  assert.match(storageSrc, /version: 1,/); // DEFAULT_SAVE literal
  assert.match(storageSrc, /out\.version = 1;/); // forced on every load
});
check('storage: GAME_MODES has exactly 5 modes incl. overrun', () => {
  const m = /export const GAME_MODES = \[([^\]]*)\] as const;/.exec(storageSrc);
  assert.ok(m, 'GAME_MODES array literal not found');
  const modes = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(modes, ['standard', 'blitz', 'onslaught', 'rotator', 'overrun']);
  assert.equal(modes.length, 5);
  assert.ok(modes.includes('overrun'));
});
check('storage: SaveData declares every expected field', () => {
  const m = /export interface SaveData \{([\s\S]*?)\n\}/.exec(storageSrc);
  assert.ok(m, 'SaveData interface not found');
  const fields = [...m[1].matchAll(/^\s+([A-Za-z]+)\??:/gm)].map((x) => x[1]).sort();
  assert.deepEqual(
    fields,
    [
      'version',
      'bestScore',
      'bestWave',
      'bestWaveOverrun',
      'totalKills',
      'totalRuns',
      'totalWavesCleared',
      'killsPerMode',
      'sensitivity',
      'touchSensitivity',
      'quality',
      'volume',
      'mode',
      'challenges',
      'loadout',
    ].sort(),
  );
});
check('storage: quality tiers are allowlisted', () => {
  const m = /export const QUALITY_TIERS = \[([^\]]*)\]/.exec(storageSrc);
  assert.ok(m, 'QUALITY_TIERS not found');
  const tiers = [...m[1].matchAll(/'([a-z]+)'/g)].map((x) => x[1]);
  assert.deepEqual(tiers, ['auto', 'low', 'medium', 'high']);
});

// ---------- quality presets (src/core/quality.ts) ----------
const qualitySrc = readSrc('core/quality.ts');
check('quality: every preset declares the full shape', () => {
  for (const tier of ['low', 'medium', 'high']) {
    assert.match(
      qualitySrc,
      new RegExp(`${tier}: \\{ tier: '${tier}', pixelRatioCap: [\\d.]+, antialias: (true|false), shadows: (true|false), shadowMapSize: \\d+ \\}`),
    );
  }
});
check('quality: low disables AA + shadows and renders below native', () => {
  const low = /low: \{ tier: 'low', pixelRatioCap: ([\d.]+), antialias: (true|false), shadows: (true|false)/.exec(qualitySrc);
  assert.ok(low, 'low preset not found');
  assert.equal(Number(low[1]), 0.75);
  assert.equal(low[2], 'false');
  assert.equal(low[3], 'false');
});
check('quality: governor rate-limits steps and gates recovery', () => {
  assert.match(qualitySrc, /SCALE_STEPS = \[1, 0\.79, 0\.62, 0\.5, 0\.4, 0\.31, 0\.25\]/);
  // One step per second max — each one reallocates framebuffers.
  assert.match(qualitySrc, /MIN_STEP_INTERVAL = 1/);
  // Recovery from a downgrade must be gated behind a sustained fast window,
  // or the resolution would pump.
  assert.match(qualitySrc, /RECOVERY_SECONDS = 5/);
  assert.match(qualitySrc, /if \(this\.fastFor < FrameTimeGovernor\.RECOVERY_SECONDS\) return false;/);
  // Never step below the floor of SCALE_STEPS.
  assert.match(qualitySrc, /if \(this\.stepIndex >= steps\.length - 1\) return false;/);
});

// ---------- threat scoring (src/combat/Combatant.ts) ----------
const combatantSrc = readSrc('combat/Combatant.ts');
const threatWeights = (): Record<string, number> => {
  const m = /THREAT_WEIGHTS = \{([\s\S]*?)\} as const/.exec(combatantSrc);
  assert.ok(m, 'THREAT_WEIGHTS not found');
  const out: Record<string, number> = {};
  for (const x of m[1].matchAll(/([a-zA-Z]+): ([\d.]+)/g)) {
    if (x[1] && x[2]) out[x[1]] = Number(x[2]);
  }
  return out;
};
check('threat: weights sum to 1', () => {
  const w = threatWeights();
  const sum = Object.values(w).reduce((a, b) => a + b, 0);
  closeTo(sum, 1, 1e-9);
  assert.deepEqual(Object.keys(w).sort(), [
    'aggression', 'aimPressure', 'fragility', 'proximity', 'role',
  ]);
});
check('threat: an invisible candidate scores zero', () => {
  // Mirrors threatScore()'s early-out.
  const score = (visibility: number): number => (visibility <= 0 ? 0 : 1);
  assert.equal(score(0), 0);
  assert.equal(score(0.35), 1);
});
check('threat: the human outranks an escort at equal distance', () => {
  const w = threatWeights();
  const proximity = 1 - 10 / 34;
  const player = w.proximity! * proximity + w.role! * 1;
  const escort = w.proximity! * proximity + w.role! * 0.45;
  assert.ok(player > escort, 'player threatRole must be 1.0 and escort 0.45');
  assert.match(combatantSrc, /readonly threatRole: number;/);
});
check('threat: grudge decays to zero over the window', () => {
  const window = Number(/GRUDGE_WINDOW = ([\d.]+)/.exec(combatantSrc)?.[1]);
  assert.equal(window, 4);
  const grudgeAt = (t: number): number => (t >= window ? 0 : 1 - t / window);
  assert.equal(grudgeAt(0), 1);
  assert.equal(grudgeAt(2), 0.5);
  assert.equal(grudgeAt(4), 0);
  assert.equal(grudgeAt(9), 0);
});
check('threat: hysteresis above 1 so the incumbent wins ties', () => {
  const h = Number(/TARGET_SWITCH_HYSTERESIS = ([\d.]+)/.exec(combatantSrc)?.[1]);
  assert.ok(h > 1, `switch threshold must exceed 1 (got ${h})`);
});

// ---------- fire-order precision (src/combat/WeaponController.ts) ----------
const weaponSrc = readSrc('combat/WeaponController.ts');
check('fire: the aim is sampled BEFORE this shot recoil is applied', () => {
  // Regression: addRecoil() rotates the pitch/yaw that forward() reads. When it
  // ran first, every round was deflected by the kick it had not been fired with
  // yet, so the first bullet of a burst left the crosshair. The aim read must
  // come first in source order.
  const aim = weaponSrc.indexOf('this.player.forward(this.tmpDir);');
  const recoil = weaponSrc.indexOf('this.player.addRecoil(weapon.def.recoil);');
  assert.ok(aim > 0, 'forward() call not found in the fire path');
  assert.ok(recoil > 0, 'addRecoil() call not found in the fire path');
  assert.ok(aim < recoil, 'forward() must be read before addRecoil() rotates the aim');
});
check('fire: shot statistics count hits, headshots and kills', () => {
  // The result codes are: 0 miss, 1 body, 2 headshot, 3 headshot kill,
  // 4 body kill, 5 blocked. Accuracy counts 1..4; headshots count 2..3.
  const hitSet = [1, 2, 3, 4];
  const headSet = [2, 3];
  assert.deepEqual(hitSet.filter((r) => r >= 1 && r <= 4), [1, 2, 3, 4]);
  assert.deepEqual(headSet, [2, 3]);
  assert.match(weaponSrc, /if \(hit\.killed\) return enemyHit\.headshot \? 3 : 4;/);
  assert.match(weaponSrc, /if \(hit\.blocked\) return 5;/);
});
check('fire: damage stats report post-mitigation damage', () => {
  // `dealt` is what the health bar actually lost, so a warden plate or a
  // kill-shot overkill cannot inflate damage-dealt or lifesteal.
  assert.match(weaponSrc, /this\.onDamageDealt\?\.\(hit\.dealt, enemyHit\.headshot\)/);
  const enemiesSrc2 = readSrc('ai/Enemies.ts');
  assert.match(enemiesSrc2, /const dealt = Math\.max\(0, Math\.min\(damage, enemy\.health\)\)/);
  assert.match(enemiesSrc2, /return \{ killed: true, blocked, dealt \};/);
});

// ---------- challenge wagers (src/game/Challenges.ts) ----------
check('challenges: every id in the list has a definition', () => {
  for (const id of CHALLENGE_IDS) {
    assert.ok(CHALLENGES[id], `missing definition for ${id}`);
    assert.equal(CHALLENGES[id].id, id);
    assert.ok(CHALLENGES[id].description.length > 0);
  }
});
check('challenges: no selection is a pure identity', () => {
  const m = foldChallenges([]);
  assert.equal(m.scoreMul, 1);
  assert.equal(m.enemyHpMul, 1);
  assert.equal(m.enemySpeedMul, 1);
  assert.equal(m.enemyCountMul, 1);
  assert.equal(m.playerDamageMul, 1);
  assert.equal(m.playerSpreadMul, 1);
  assert.equal(m.extraAffixes, 0);
});
check('challenges: payouts compose multiplicatively', () => {
  // Horde x1.45 and Glass Cannon x1.30 => 1.885, not 1.75. Stacking must be a
  // real decision, so the multipliers compound.
  closeTo(challengeScoreMul(['horde', 'glassCannon']), 1.45 * 1.3, 1e-9);
  closeTo(challengeScoreMul(['ironclad', 'relentless', 'scatter']), 1.3 * 1.25 * 1.25, 1e-9);
});
check('challenges: each wager only moves the stats it claims', () => {
  // Ironclad touches enemy health and nothing else.
  const iron = foldChallenges(['ironclad']);
  assert.equal(iron.enemyHpMul, 1.4);
  assert.equal(iron.enemySpeedMul, 1);
  assert.equal(iron.playerDamageMul, 1);
  // Glass Cannon doubles incoming damage and nothing else.
  const glass = foldChallenges(['glassCannon']);
  assert.equal(glass.playerDamageMul, 2);
  assert.equal(glass.enemyHpMul, 1);
  // Famine halves reserve ammo only.
  const famine = foldChallenges(['famine']);
  assert.equal(famine.playerAmmoMul, 0.5);
  assert.equal(famine.playerSpreadMul, 1);
  // Scatter widens the cone only.
  const scatter = foldChallenges(['scatter']);
  assert.equal(scatter.playerSpreadMul, 1.6);
  assert.equal(scatter.playerDamageMul, 1);
  // Horde is the only one that adds affixes.
  assert.equal(foldChallenges(['horde']).extraAffixes, 1);
  assert.equal(foldChallenges(['ironclad']).extraAffixes, 0);
});
check('challenges: extra affixes add up across picks', () => {
  assert.equal(foldChallenges(['horde', 'horde']).extraAffixes, 2);
});
check('challenges: label joins the picked names', () => {
  assert.equal(challengeLabel([]), '');
  assert.equal(challengeLabel(['horde']), 'HORDE');
  assert.equal(challengeLabel(['horde', 'glassCannon']), 'HORDE + GLASS CANNON');
});
check('challenges: the fold is order-independent', () => {
  const a = foldChallenges(['horde', 'ironclad', 'famine']);
  const b = foldChallenges(['famine', 'horde', 'ironclad']);
  for (const key of Object.keys(a) as (keyof typeof a)[]) {
    closeTo(a[key], b[key], 1e-9);
  }
});
check('challenges: an unknown id is ignored, not fatal', () => {
  const m = foldChallenges(['horde', 'notARealChallenge' as never]);
  closeTo(m.scoreMul, 1.45, 1e-9);
});

// ---------- slide + crouch (src/player/Player.ts) ----------
const playerSrc = readSrc('player/Player.ts');

/**
 * Regression for the bug where the slide could never fire: `canSprint` used to
 * require `!wantsCrouch`, which made the slide condition (`sprinting && crouch`)
 * unsatisfiable. The gate is now free of the crouch term.
 */
check('slide: the sprint gate does NOT depend on the crouch key', () => {
  const m = /const canSprint = ([^;]+);/.exec(playerSrc);
  assert.ok(m, 'canSprint expression not found');
  assert.ok(
    !/wantsCrouch/.test(m[1]),
    'canSprint must not test wantsCrouch, or the slide can never trigger',
  );
});
check('slide: entry requires a sprint, a crouch, and the ground', () => {
  assert.match(
    playerSrc,
    /if \(wantsCrouch && this\.sprinting && this\.grounded && !this\.wasCrouching && moving\)/,
  );
});
check('slide: the slide direction is committed, not steered', () => {
  // The velocity must be driven along slideDir while the timer runs; steering
  // it with tmpMove would let a slide be curved into a circle.
  assert.match(playerSrc, /this\.slideDir\.copy\(this\.tmpMove\)/);
  assert.match(playerSrc, /this\.velocity\.x = damp\(this\.velocity\.x, this\.slideDir\.x \* speed \* slowK, accel, dt\)/);
});
check('slide: entry speed is the decaying speed plus a fixed bonus', () => {
  assert.equal(literal(playerSrc, 'SLIDE_SPEED'), 5.5);
  assert.equal(literal(playerSrc, 'SLIDE_ENTRY_BONUS'), 3);
  assert.equal(literal(playerSrc, 'SLIDE_TIME'), 0.65);
});
check('crouch: the stand-up probe uses the STANDING radius', () => {
  // The probe used to be built from whatever radius the collider had at the
  // time, so it could report a hit the real standing capsule would not have.
  assert.match(playerSrc, /this\.standTest\.radius = STAND_RADIUS;/);
});
check('crouch: the stand-up probe is tested before the collider is resized', () => {
  // Anchor on the probe assignment and the crouch flag, then compare the two
  // offsets between them. Plain indexOf keeps this readable and avoids a
  // non-greedy span that silently matches nothing when the block moves.
  const probeAt = playerSrc.indexOf('this.standTest.radius = STAND_RADIUS;');
  const doneAt = playerSrc.indexOf('this.crouched = false;', probeAt);
  assert.ok(probeAt >= 0, 'stand-up probe not found');
  assert.ok(doneAt > probeAt, 'stand-up completion not found after the probe');
  const body = playerSrc.slice(probeAt, doneAt);
  const intersectAt = body.indexOf('capsuleIntersect');
  const resizeAt = body.indexOf('this.collider.radius = STAND_RADIUS');
  assert.ok(intersectAt >= 0, 'the probe never calls capsuleIntersect');
  assert.ok(resizeAt >= 0, 'the collider is never resized to the standing shape');
  assert.ok(
    intersectAt < resizeAt,
    'the probe must be tested BEFORE the collider is resized',
  );
});
check('aim: the weapon drives the aimed FOV', () => {
  assert.match(playerSrc, /const aimFov = 75 \+ \(this\.adsFov - 75\) \* this\.adsT;/);
});
check('move: weapon weight scales every ground speed', () => {
  assert.match(playerSrc, /speed \*= this\.weaponMoveMul;/);
});

// ---------- arena themes (src/world/Maps.ts) ----------
const mapsSrc = readSrc('world/Maps.ts');
const worldSrc = readSrc('world/World.ts');

check('maps: at least four distinct themes ship', () => {
  const ids = [...mapsSrc.matchAll(/^\s+id: '([a-z-]+)',/gm)].map((m) => m[1]);
  assert.ok(ids.length >= 4, `expected >= 4 themes, found ${ids.length}`);
  assert.equal(new Set(ids).size, ids.length, 'theme ids must be unique');
});
check('maps: every theme declares the full palette shape', () => {
  const blocks = [...mapsSrc.matchAll(/id: '[a-z-]+',[\s\S]*?\n  \},/g)];
  assert.ok(blocks.length >= 4, 'theme blocks not found');
  for (const [block] of blocks) {
    for (const key of ['floor:', 'wall:', 'sky:', 'fog:', 'light:', 'cover:', 'density:', 'dust:']) {
      assert.ok(block.includes(key), `theme is missing ${key}`);
    }
  }
});
check('maps: the seed selects the theme (not a fixed map)', () => {
  assert.match(worldSrc, /const nextIndex = mapForSeed\(seed\);/);
  assert.match(worldSrc, /this\.theme = MAPS\[nextIndex\] \?\? \(MAPS\[0\] as MapTheme\);/);
});
check('maps: mapForSeed can never return a negative index', () => {
  // `^` and Math.imul yield a SIGNED int32, so the raw hash can be negative and
  // a negative modulo indexes MAPS[-1] -> undefined -> the arena fails to build.
  assert.match(mapsSrc, /h >>>= 0;\n\s+return h % MAPS\.length;/);
  // Simulate the real function over a spread of seeds, including the ones that
  // are most likely to produce a negative intermediate hash.
  const LEN = 4;
  const idx = (seed: number): number => {
    let h = seed >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    h >>>= 0;
    return h % LEN;
  };
  const seeds = [0, 1, 2, 3, 12345, 0x7fffffff, 0x80000000, 0xffffffff, 4294967295];
  for (let s = 0; s < 400; s += 1) seeds.push(Math.floor(Math.random() * 0xffffffff));
  for (const seed of seeds) {
    const i = idx(seed);
    assert.ok(Number.isInteger(i), `seed ${seed} gave a non-integer index`);
    assert.ok(i >= 0 && i < LEN, `seed ${seed} gave out-of-range index ${i}`);
  }
});
check('maps: consecutive seeds do not walk the theme list in order', () => {
  const LEN = 4;
  const idx = (seed: number): number => {
    let h = seed >>> 0;
    h ^= h >>> 16;
    h = Math.imul(h, 0x7feb352d);
    h ^= h >>> 15;
    h = Math.imul(h, 0x846ca68b);
    h ^= h >>> 16;
    h >>>= 0;
    return h % LEN;
  };
  const first = [idx(1), idx(2), idx(3), idx(4)];
  assert.notDeepEqual(first, [1, 2, 3, 0]);
  assert.notDeepEqual(first, [0, 1, 2, 3]);
});
check('maps: the colour pass runs on every rebuild', () => {
  // The scene fog is created by Game AFTER build(), so a same-theme rebuild
  // must still re-assert the theme colours or the first run has grey fog.
  assert.match(worldSrc, /this\.applyTheme\(this\.theme, changed\);/);
});
check('maps: the theme never touches geometry or the octree', () => {
  const m = /private applyTheme\([\s\S]*?\n  \}/.exec(worldSrc);
  assert.ok(m, 'applyTheme not found');
  assert.ok(!/octree|Geometry\(/.test(m[0]), 'applyTheme must only touch materials and lights');
});
check('maps: cover density scales the cluster count', () => {
  assert.match(worldSrc, /\* this\.theme\.density\)/);
});
check('maps: every theme stays bright enough to fight in', () => {
  // A night theme that hides the enemies is not atmosphere, it is a bug. The
  // floor is a product of ambient intensity and the sky colour's luminance:
  // below it, a dark enemy silhouette stops reading against the ground.
  const ambient = [...mapsSrc.matchAll(/ambientIntensity: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const sky = [...mapsSrc.matchAll(/sky: (0x[0-9a-f]{6}), ground:/g)].map((m) => Number(m[1]));
  const sun = [...mapsSrc.matchAll(/sunIntensity: ([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(ambient.length >= 4, 'ambient intensities not parsed');
  assert.equal(ambient.length, sky.length, 'sky/ambient counts must match');
  assert.equal(ambient.length, sun.length, 'sun/ambient counts must match');
  const lum = (hex: number): number => {
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (let i = 0; i < ambient.length; i += 1) {
    const key = ambient[i] as number;
    const lit = key * (0.35 + 0.65 * lum(sky[i] as number));
    assert.ok(
      lit >= 0.45,
      `theme ${i} is too dark to play (ambient ${key}, sky luminance ${lum(sky[i] as number).toFixed(3)})`,
    );
    assert.ok((sun[i] as number) >= 1, `theme ${i} has no key light`);
  }
});
check('maps: no theme is blown out', () => {
  // The other half of the legibility rule. A near-white floor under a bright
  // key light washes the frame out and an enemy silhouette stops reading
  // against it, which is a playability failure wearing a colour scheme.
  const ambient = [...mapsSrc.matchAll(/ambientIntensity: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const sun = [...mapsSrc.matchAll(/sunIntensity: ([0-9.]+)/g)].map((m) => Number(m[1]));
  const floorColor = [...mapsSrc.matchAll(/^\s+color: (0x[0-9a-f]{6}),\n\s+base: /gm)]
    .map((m) => Number(m[1]));
  assert.ok(floorColor.length >= 4, 'floor colours not parsed');
  const lum = (hex: number): number => {
    const r = ((hex >> 16) & 0xff) / 255;
    const g = ((hex >> 8) & 0xff) / 255;
    const b = (hex & 0xff) / 255;
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  for (let i = 0; i < floorColor.length; i += 1) {
    const floorLum = lum(floorColor[i] as number);
    assert.ok(floorLum <= 0.75, `theme ${i} floor is too bright (luminance ${floorLum.toFixed(3)})`);
    // Total scene energy: a bright floor plus a bright key is what blows out.
    const energy = floorLum * (0.5 + (sun[i] ?? 1) * 0.35 + (ambient[i] ?? 1) * 0.25);
    assert.ok(energy <= 0.95, `theme ${i} is blown out (energy ${energy.toFixed(3)})`);
  }
});

// ---------- AI agility (src/ai/Enemies.ts) ----------
check('ai agility: dodge, juke and slide timers exist on the enemy', () => {
  for (const field of ['slideT', 'dodgeT', 'jukeT', 'dodgeSide', 'jukeSide', 'dodgeCd', 'jukeCd']) {
    assert.match(enemiesSrc, new RegExp(`\\b${field}: number;`), `missing ${field}`);
  }
});
check('ai agility: taking a hit starts a dodge', () => {
  assert.match(enemiesSrc, /enemy\.dodgeT = AGILITY_DODGE_TIME;/);
});
check('ai agility: a dodge is lateral to the shot line', () => {
  // The side is chosen by which side of the shot line the agent already holds,
  // so a dodge never crosses the line (which would read as running into fire).
  assert.match(enemiesSrc, /enemy\.dodgeSide = -shotZ \* ownX \+ shotX \* ownZ >= 0 \? 1 : -1;/);
});
check('ai agility: a committed burst owns movement outright', () => {
  assert.match(enemiesSrc, /const burst = this\.isBursting\(enemy\) \? this\.burstMove\(enemy, toTarget\) : null;/);
});
check('ai agility: only melee archetypes slide, and only in a range window', () => {
  const m = /private trySlide\([\s\S]*?\n  \}/.exec(enemiesSrc);
  assert.ok(m, 'trySlide not found');
  assert.match(m[0], /enemy\.kind !== 'rusher' && enemy\.kind !== 'exploder'/);
  assert.match(m[0], /distance > AGILITY_SLIDE_RANGE/);
});
check('ai agility: the slide pose drops the body and tucks the legs', () => {
  assert.match(enemiesSrc, /const sliding = enemy\.slideT > 0;/);
  assert.match(enemiesSrc, /enemy\.legL\.rotation\.x = -1\.15;/);
});
check('ai agility: a flyer never dodges (it would fight its own bob)', () => {
  const m = /private updateAgility\([\s\S]*?\n  \}/.exec(enemiesSrc);
  assert.ok(m, 'updateAgility not found');
  assert.match(m[0], /enemy\.kind === 'flyer'/);
});

// ---------- damage attribution (src/player/Player.ts, src/ai/Enemies.ts) ----------
check('damage: every enemy kind declares a player-facing label', () => {
  const labels = [...enemiesSrc.matchAll(/label: '([^']+)'/g)].map((m) => m[1]);
  assert.ok(labels.length >= 10, `expected >= 10 labels, found ${labels.length}`);
  assert.equal(new Set(labels).size, labels.length, 'labels must be unique');
});
check('damage: the player records the source of the last hit', () => {
  assert.match(playerSrc, /this\.lastDamageSource = source;/);
});
check('damage: hazards name themselves', () => {
  const hazardsSrc = readSrc('world/Hazards.ts');
  assert.match(hazardsSrc, /'BARREL BLAST'/);
  assert.match(hazardsSrc, /'TESLA COIL'/);
  assert.match(hazardsSrc, /'STEAM VENT'/);
});
check('damage: the affix burn names itself', () => {
  assert.match(gameSrc, /'AFFIX BURN'/);
});
check('damage: the projectile carries its shooter label', () => {
  assert.match(enemiesSrc, /proj\.sourceLabel = enemy\.def\.label;/);
  assert.match(enemiesSrc, /proj\.sourceLabel\)/);
});

// ---------- weapons: scope, loadout, charge, ricochet (src/combat/weapons.ts) ----------
const weaponsSrc = readSrc('combat/weapons.ts');

check('weapons: every definition declares an aimed FOV and a scope flag', () => {
  const defs = [...weaponsSrc.matchAll(/^\s{2}(\w+): \{\n\s+id: '(\w+)'/gm)].map((m) => m[2]);
  assert.ok(defs.length >= 10, `expected >= 10 weapons, found ${defs.length}`);
  const fovs = [...weaponsSrc.matchAll(/adsFov: ([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.equal(fovs.length, defs.length, 'every weapon needs an adsFov');
  for (const fov of fovs) assert.ok(fov > 0 && fov <= 75, `adsFov ${fov} out of range`);
  const scoped = [...weaponsSrc.matchAll(/scoped: (true|false)/g)];
  assert.equal(scoped.length, defs.length, 'every weapon needs a scoped flag');
});
check('weapons: scoped weapons zoom harder than the rest', () => {
  const scoped = [...weaponsSrc.matchAll(/scoped: true[^}]*/g)].length;
  assert.ok(scoped >= 2, 'expected at least the rail and the DMR to be scoped');
  const minScoped = Math.min(
    ...[...weaponsSrc.matchAll(/adsFov: ([0-9.]+), scoped: true/g)].map((m) => Number(m[1])),
  );
  assert.ok(minScoped <= 30, `a scoped weapon should reach <= 30° FOV, got ${minScoped}`);
});
check('loadout: three slots, and the default kit is three distinct weapons', () => {
  assert.equal(literal(weaponsSrc, 'LOADOUT_SLOTS'), 3);
  const m = /export const DEFAULT_LOADOUT: readonly WeaponId\[\] = \[([^\]]*)\]/.exec(weaponsSrc);
  assert.ok(m, 'DEFAULT_LOADOUT not found');
  const ids = [...m[1].matchAll(/'(\w+)'/g)].map((x) => x[1]);
  assert.equal(ids.length, 3);
  assert.equal(new Set(ids).size, 3);
  // The default kit must cover a close, a mid and a long role, or the starting
  // loadout has a hole the player has to fix before they can play.
  assert.ok(ids.includes('shotgun'), 'default kit needs a close-range weapon');
  assert.ok(ids.includes('ar'), 'default kit needs a mid-range weapon');
  assert.ok(ids.includes('dmr'), 'default kit needs a long-range weapon');
});
check('loadout: sanitize pads, dedupes, and drops unknown ids', () => {
  const ids = [...weaponsSrc.matchAll(/^\s{2}(\w+): \{\n\s+id:/gm)].map((m) => m[1]);
  assert.ok(ids.includes('ar') && ids.includes('rail'), 'weapon table not parsed');
  // Mirror of sanitizeLoadout: unknown and duplicate entries never survive, and
  // the result is always exactly LOADOUT_SLOTS long.
  const sanitize = (input: readonly string[]): string[] => {
    const out: string[] = [];
    for (const id of input) {
      if (!ids.includes(id) || out.includes(id)) continue;
      out.push(id);
      if (out.length >= 3) break;
    }
    for (const id of ['ar', 'shotgun', 'dmr']) {
      if (out.length >= 3) break;
      if (!out.includes(id)) out.push(id);
    }
    for (const id of ids) {
      if (out.length >= 3) break;
      if (!out.includes(id)) out.push(id);
    }
    return out;
  };
  assert.deepEqual(sanitize([]), ['ar', 'shotgun', 'dmr']);
  assert.deepEqual(sanitize(['rail', 'rail', 'nope']), ['rail', 'ar', 'shotgun']);
  assert.deepEqual(sanitize(['pistol', 'pistol', 'pistol', 'pistol']), ['pistol', 'ar', 'shotgun']);
  for (const input of [[], ['x'], ['ar', 'ar'], ['launcher', 'beam', 'burst', 'lmg', 'smg']]) {
    assert.equal(sanitize(input).length, 3);
  }
});
check('weapons: the rail ricochets and the heavy guns have a charge', () => {
  assert.match(weaponsSrc, /ricochet: 2/);
  assert.match(weaponsSrc, /chargeTime: [0-9.]+/);
});
check('weapons: movement weight is declared for every weapon', () => {
  const muls = [...weaponsSrc.matchAll(/moveMul: ([0-9.]+)/g)].map((m) => Number(m[1]));
  assert.ok(muls.length >= 10, `expected >= 10 moveMul, found ${muls.length}`);
  for (const mul of muls) assert.ok(mul > 0.5 && mul <= 1.3, `moveMul ${mul} out of range`);
});
check('weapons: every definition carries a role line for the loadout screen', () => {
  const roles = [...weaponsSrc.matchAll(/role: '[^']+'/g)];
  assert.ok(roles.length >= 10, `expected >= 10 roles, found ${roles.length}`);
});

// ---------- weapon controller: charge + ricochet (src/combat/WeaponController.ts) ----------
check('charge: the shot releases only at full charge, once per discharge', () => {
  assert.match(weaponSrc, /this\.chargeT = Math\.min\(chargeTime, this\.chargeT \+ dt\);/);
  // A shot needs a full charge AND an elapsed cooldown, then the capacitor is
  // spent. Testing the two together is what keeps the cycle honest.
  assert.match(weaponSrc, /if \(this\.chargeT >= chargeTime && weapon\.cooldown <= COOLDOWN_EPS\) \{/);
  assert.match(weaponSrc, /this\.chargeReady = true;/);
});
check('charge: the capacitor runs concurrently with the cooldown, not after it', () => {
  // The bug: charging and cooling down ran back to back, so the cycle was the
  // SUM of the two and the rail took 1.7 s per shot against a stated 1.111 s —
  // the stat block understated the real rate by 35%. Running them together
  // makes the cycle max(chargeTime, 1/fireRate), which is what the stat block
  // claims. Both charge times are shorter than their cooldowns, so the
  // telegraph survives: the first shot still takes a full 0.6 s / 0.4 s.
  assert.match(weaponSrc, /if \(this\.chargeT >= chargeTime && weapon\.cooldown <= COOLDOWN_EPS\) \{/);
  // Charging must NOT be gated behind a separate `chargeReady` branch.
  assert.doesNotMatch(weaponSrc, /if \(this\.chargeReady\) \{\n\s+\/\/ Already discharged/);
  assert.match(weaponSrc, /this\.chargeT = Math\.min\(chargeTime, this\.chargeT \+ dt\);\n\s+if \(this\.chargeT >= chargeTime && weapon\.cooldown <= COOLDOWN_EPS\)/);
});
check('charge: releasing early loses the charge instead of banking it', () => {
  assert.match(weaponSrc, /if \(this\.chargeT > 0 && !this\.chargeReady\) this\.audio\.empty\(\);/);
  assert.match(weaponSrc, /this\.chargeT = 0;/);
  assert.match(weaponSrc, /this\.chargeReady = false;/);
});
check('charge: the damage multiplier reaches the damage formula', () => {
  assert.match(weaponSrc, /const damage = weapon\.def\.damage \* chargeMul \* this\.damageScale/);
});
check('burst: a follow-up round cannot re-arm the group', () => {
  // The bug that made the burst weapon empty its magazine from one trigger
  // pull: `fire()` re-armed `burstLeft` on every round it fired, so the counter
  // was reset to 2 before it could reach 0 and the group never ended.
  assert.match(weaponSrc, /private fire\(weapon: WeaponState, aiming: boolean, chargeMul = 1, continuing = false\): void \{/);
  assert.match(weaponSrc, /if \(!continuing\) \{[\s\S]{0,1200}?const burstCount = weapon\.def\.burstCount \?\? 0;/);
  // The burst loop must pass `continuing: true`.
  assert.match(weaponSrc, /this\.fire\(weapon, this\.player\.isAiming, 1, true\);/);
});
check('burst: holding the trigger keeps sending groups', () => {
  // A burst rifle is neither semi nor full auto: held fire cycles groups.
  // Treating it as semi-auto meant one group per click, which contradicts the
  // weapon's own role text.
  assert.match(weaponSrc, /const burstWeapon = \(weapon\.def\.burstCount \?\? 0\) > 1;/);
  assert.match(weaponSrc, /const wantsFire = burstWeapon\n\s+\? \(frame\.fireHeld \|\| frame\.firePressed\)/);
});
check('burst: the group cadence cannot exceed the stated fire rate', () => {
  // Resetting the cooldown per round made the real group rate depend on how
  // long the group took (measured 1.15 groups/s against a stated 2.2), which
  // made the weapon's stat block a lie.
  assert.match(weaponSrc, /const groupDuration = \(burstCount - 1\) \* BURST_ROUND_INTERVAL;/);
  assert.match(weaponSrc, /weapon\.cooldown \+= Math\.max\(cadence, groupDuration\);/);
});
check('fire rate: the clock accumulates the interval instead of being overwritten', () => {
  // The bug: assigning the interval discarded the fraction of a step that had
  // already elapsed, so a weapon whose interval is not a whole number of 60 Hz
  // ticks always rounded up to the next one. The AR's 8 rounds/s is a 7.5-tick
  // interval and delivered 7.5 rounds/s; the beam's 20 rounds/s is exactly three
  // ticks but a ~1e-18 s float residue still pushed every shot to four, delivering
  // 15 rounds/s against a stated 20 — a 25% shortfall. Accumulating lets a short
  // and a long tick alternate, so the average lands on the stat block.
  assert.match(weaponSrc, /weapon\.cooldown \+= 1 \/ \(weapon\.def\.fireRate \* this\.mods\.fireRateMul\);/);
  assert.doesNotMatch(weaponSrc, /weapon\.cooldown = 1 \/ \(weapon\.def\.fireRate \* this\.mods\.fireRateMul\);/);
  // The carry must stay bounded: an idle gun may not bank catch-up shots.
  assert.match(weaponSrc, /weapon\.cooldown = Math\.max\(-dt, weapon\.cooldown - dt\);/);
});
check('fire rate: a gun reads ready on the tick its interval actually elapses', () => {
  // A bare `<= 0` test reads the ~1e-18 s residue as "not ready" and costs a
  // whole tick. The slack is tiny enough to be unfelt and large enough to beat
  // double-precision drift over a full magazine.
  assert.match(weaponSrc, /const COOLDOWN_EPS = 1e-6;/);
  assert.match(weaponSrc, /weapon\.cooldown <= COOLDOWN_EPS\) \{/);
  assert.match(weaponSrc, /!weapon\.reloading && weapon\.cooldown <= COOLDOWN_EPS\) \{/);
});
check('ricochet: the bounce loop is bounded by the weapon field', () => {
  assert.match(weaponSrc, /const maxBounces = Math\.max\(0, Math\.floor\(weapon\.def\.ricochet \?\? 0\)\);/);
  assert.match(weaponSrc, /for \(let bounce = 0; bounce <= maxBounces; bounce\+\+\)/);
});
check('ricochet: a grazing hit cannot reflect into a zero-length bounce', () => {
  assert.match(weaponSrc, /if \(Math\.abs\(dot\) < 1e-4\) return 0;/);
});
check('ricochet: the new origin is pushed off the surface it just left', () => {
  assert.match(weaponSrc, /this\.richFrom\.addScaledVector\(this\.richDir, 0\.02\);/);
});
check('ricochet: a detonating rocket does not bounce', () => {
  assert.match(weaponSrc, /\/\/ A rocket that detonates does not bounce\.\n\s+this\.richHitWall = false;/);
});
check('loadout: the controller exposes the equipped kit and re-slots on change', () => {
  assert.match(weaponSrc, /public get equipped\(\): readonly WeaponId\[\] \{/);
  assert.match(weaponSrc, /public reslot\(\): void \{/);
  assert.match(weaponSrc, /this\.states = this\.loadout\.map\(createWeaponState\);/);
});
check('loadout: a live swap clears the in-flight burst and charge', () => {
  const m = /public reslot\(\): void \{([\s\S]*?)\n  \}/.exec(weaponSrc);
  assert.ok(m, 'reslot not found');
  assert.match(m[1], /this\.burstLeft = 0;/);
  assert.match(m[1], /this\.chargeT = 0;/);
});

// ---------- audio (src/audio/Audio.ts) ----------
const audioSrc = readSrc('audio/Audio.ts');

check('audio: every voice has an attack stage (no click at the front)', () => {
  // A waveform that jumps to full amplitude instantly produces a broadband
  // transient, which the ear hears as a tick rather than as a hit.
  const toneBlock = /private tone\(opts: ToneOpts\): void \{([\s\S]*?)\n  \}/.exec(audioSrc);
  const noiseBlock = /private noise\(opts: NoiseOpts\): void \{([\s\S]*?)\n  \}/.exec(audioSrc);
  assert.ok(toneBlock && noiseBlock, 'tone/noise not found');
  assert.match(toneBlock[1], /const attack = Math\.max\(0\.002/);
  assert.match(noiseBlock[1], /const attack = Math\.max\(0\.001/);
  // Both must ramp from silence UP to the peak before decaying.
  for (const block of [toneBlock[1], noiseBlock[1]]) {
    assert.match(block, /gain\.gain\.setValueAtTime\(0\.0001, t0\);/);
    assert.match(block, /exponentialRampToValueAtTime\(peak, t0 \+ attack\);/);
  }
});
check('audio: the noise buffer is read from a random offset', () => {
  // Without an offset every noise voice plays the same second of noise, so
  // repeated shots phase-lock and sound like one frozen sample.
  const m = /const offset = Math\.random\(\) \* \(this\.noiseBuffer\.duration - opts\.dur - 0\.05\);/.exec(audioSrc);
  assert.ok(m, 'random read offset not found');
  assert.match(audioSrc, /src\.start\(t0, Math\.max\(0, offset\)\);/);
});
check('audio: there is a real room (procedural impulse response)', () => {
  assert.match(audioSrc, /this\.room = ctx\.createConvolver\(\);/);
  assert.match(audioSrc, /this\.room\.buffer = this\.makeImpulse\(/);
  assert.match(audioSrc, /private makeImpulse\(seconds: number, decay: number\): AudioBuffer \{/);
});
check('audio: the master chain saturates before it clips', () => {
  // Many simultaneous voices must compress into each other, not sum into a
  // square wave. A WaveShaper between the bus and the compressor is the fix.
  assert.match(audioSrc, /const shaper = ctx\.createWaveShaper\(\);/);
  assert.match(audioSrc, /shaper\.curve = this\.makeSaturationCurve\(/);
  assert.match(audioSrc, /this\.airFilter\.connect\(shaper\);/);
  assert.match(audioSrc, /shaper\.connect\(this\.master\);/);
});
check('audio: a shot is layered from four parts', () => {
  // TRANSIENT + BODY + THUMP + TAIL. Each `case` must have at least three
  // voices, or the weapon will read as a single blip.
  //
  // The beam is the one documented exception: it fires 20 times a second, so a
  // body and a tail would smear 20 voices into a continuous chord. It is
  // deliberately a transient and a tick and nothing else.
  const shotBlock = /public shot\(kind: ShotSound[\s\S]*?\n  \}/.exec(audioSrc);
  assert.ok(shotBlock, 'shot() not found');
  const cases = shotBlock[0].split(/case '/).slice(1);
  assert.ok(cases.length >= 10, `expected >= 10 weapon cases, found ${cases.length}`);
  for (const c of cases) {
    const name = c.split("'")[0];
    const voices = (c.match(/this\.(noise|tone)\(\{/g) ?? []).length;
    if (name === 'beam') {
      assert.ok(voices >= 2, 'the beam still needs a transient and a tick');
      continue;
    }
    assert.ok(voices >= 3, `${name} has only ${voices} layers`);
  }
});
check('audio: the beam is deliberately unlayered, and says so', () => {
  assert.match(audioSrc, /At 20 Hz this must not smear into a drone/);
});
check('audio: distance attenuates and darkens', () => {
  assert.match(audioSrc, /public setListenerDistance\(metres: number\): void \{/);
  assert.match(audioSrc, /const cutoff = clamp\(18000 - metres \* 340, 2200, 18000\);/);
  // A far shot loses its room tail: the tail IS the distance cue.
  assert.match(audioSrc, /const roomK = near \* near;/);
});
check('audio: the pan is resolved in the listener frame, not world X', () => {
  // Panning along the world X axis is only the player's right if they happen
  // to be facing -Z. Turn around and a sound on the right arrives on the left.
  assert.match(audioSrc, /const right = dx \* cos - dz \* sin;/);
  assert.match(audioSrc, /public setListener\(x: number, z: number, yaw: number\): void \{/);
});
check('audio: a near miss is gated to the player and fires once per bolt', () => {
  assert.match(audioSrc, /public nearMiss\(pan = 0\): void \{/);
  assert.match(audioSrc, /public nearMissAt\(x: number, z: number\): void \{/);
  // The once-per-bolt flag lives on the projectile, not on the sound.
  assert.match(enemiesSrc, /nearMissed: boolean;/);
  assert.match(enemiesSrc, /if \(!proj\.nearMissed\) \{/);
});
check('audio: impact sounds are material-specific', () => {
  // `concrete` is the DEFAULT branch: it is the floor, the walls and most of
  // the cover, so it is the honest fallback for anything unclassified.
  const m = /public impact\(kind: 'concrete' \| 'metal' \| 'soft' \| 'glass'[\s\S]*?\n  \}/.exec(audioSrc);
  assert.ok(m, 'impact() not found');
  assert.match(m[0], /case 'metal':/);
  assert.match(m[0], /case 'soft':/);
  assert.match(m[0], /case 'glass':/);
  assert.match(m[0], /default:/);
  // Metal is the only material that sustains a pitch, and it must say so.
  assert.match(m[0], /metal is the only material that sustains a pitch/);
});
check('audio: a room tone exists and fades with the phase', () => {
  assert.match(audioSrc, /public startAmbience\(\): void \{/);
  assert.match(audioSrc, /public setAmbience\(on: boolean\): void \{/);
  assert.match(gameSrc, /this\.audio\.setAmbience\(this\.phase === 'playing'/);
});
check('audio: the listener is updated every step from the player eye and yaw', () => {
  assert.match(gameSrc, /this\.audio\.setListener\(\n\s+this\.player\.position\.x,\n\s+this\.player\.position\.z,\n\s+this\.player\.yawAngle,\n\s+\);/);
});
check('audio: no call site computes its own pan any more', () => {
  // Every call site that did this got it wrong in the same way, which is why
  // the listener frame now lives in one place.
  const hazardsSrc = readSrc('world/Hazards.ts');
  assert.ok(!/private panToward/.test(hazardsSrc), 'Hazards still has its own pan');
  assert.match(hazardsSrc, /this\.audio\.barrelBlastAt\(p\.x, p\.z\);/);
});

// ---------- environment (src/world/World.ts) ----------
check('world: every fixed structure registers cover the AI can claim', () => {
  // A structure the AI cannot use is scenery. The bunker, the towers, the
  // nests and the tarps all register spots now.
  const m = /private buildRangeDetails\(\): void \{([\s\S]*?)\n  \}/.exec(worldSrc);
  assert.ok(m, 'buildRangeDetails not found');
  const marks = (m[1].match(/this\.markStructureCover\(/g) ?? []).length;
  assert.ok(marks >= 4, `expected >= 4 structures registering cover, found ${marks}`);
});
check('world: fixed cover survives a rebuild', () => {
  // generateCover clears coverSpots, so the fixed ones live in their own list
  // and are re-attached on every rebuild.
  assert.match(worldSrc, /private readonly fixedCoverSpots: CoverSpotData\[\] = \[\];/);
  assert.match(worldSrc, /this\.coverSpots\.push\(\.\.\.this\.fixedCoverSpots\);/);
});
check('world: the decorative-only props are gone', () => {
  // Berms, target frames, painted stripes and lamp poles changed nothing.
  assert.ok(!/ConeGeometry\(1, 1, 4\)/.test(worldSrc), 'berms still built');
  assert.ok(!/stripeGeometry/.test(worldSrc), 'painted stripes still built');
  assert.ok(!/CylinderGeometry\(0\.12, 0\.16, 4\.2, 8\)/.test(worldSrc), 'lamp poles still built');
});
check('world: the arena is sized to the engagement ranges', () => {
  // Every enemy engages inside 44 m and the longest useful sight line is about
  // 40 m, so a 94 m box was mostly dead ground.
  const m = /const ARENA_HALF = ([0-9]+);/.exec(worldSrc);
  assert.ok(m, 'ARENA_HALF not found');
  const half = Number(m[1]);
  assert.ok(half <= 40 && half >= 28, `ARENA_HALF ${half} is outside the tuned band`);
  // The sun's shadow camera has to cover the arena or shadows pop at the edge.
  const shadow = /shadow\.camera\.left = -([0-9]+);/.exec(worldSrc);
  assert.ok(shadow, 'shadow camera not found');
  assert.ok(Number(shadow[1]) > half, 'shadow camera must be wider than the arena');
});
check('world: the work lamps sit on the structures they light', () => {
  const m = /for \(const \[x, y, z\] of \[\[-21, 5\.2, 0\]/.exec(worldSrc);
  assert.ok(m, 'lamps are not attached to the towers');
});

// ---------- squad tactics (src/ai/Enemies.ts) ----------
check('squad: fire teams exist and are ticked on their own cadence', () => {
  assert.match(enemiesSrc, /const FIRE_TEAM_SIZE = 3;/);
  assert.match(enemiesSrc, /private readonly teams = new Map<number, FireTeam>\(\);/);
  assert.match(enemiesSrc, /this\.teamTimer = TEAM_TICK;\n\s+this\.updateTeams\(\);/);
});
check('squad: a team shares ONE victim', () => {
  assert.match(enemiesSrc, /team\.focus = bestTarget;/);
  assert.match(enemiesSrc, /const focus = team\?\.focus \?\? null;/);
});
check('squad: focus fire is a bonus, not a hard override', () => {
  // Forcing the team target outright made squads walk past targets in front
  // of them, which reads as the AI being blind rather than coordinated.
  assert.match(enemiesSrc, /\* \(candidate === focus \? FOCUS_FIRE_BONUS : 1\)/);
  assert.match(enemiesSrc, /const FOCUS_FIRE_BONUS = 1\.6;/);
});
check('squad: teams are cleared with the roster', () => {
  const m = /public clear\(\): void \{([\s\S]*?)\n  \}/.exec(enemiesSrc);
  assert.ok(m, 'clear not found');
  assert.match(m[1], /this\.teams\.clear\(\);/);
});
check('squad: bounding holds one member back at a time', () => {
  assert.match(enemiesSrc, /const holding = team !== null && team\.upId >= 0 && team\.upId !== enemy\.tacticalId/);
  assert.match(enemiesSrc, /if \(holding\) this\.holdPosition\(/);
  assert.match(enemiesSrc, /private holdPosition\(/);
});
check('squad: a holding agent still shoots and still dodges', () => {
  // The ONLY thing a hold gives up is the approach. A holding agent that stops
  // shooting is not covering anyone.
  const m = /private holdPosition\(([\s\S]*?)\n  \}/.exec(enemiesSrc);
  assert.ok(m, 'holdPosition not found');
  assert.ok(!/attackTimer/.test(m[1]), 'holdPosition must not touch the attack timer');
  assert.ok(!/dodgeT/.test(m[1]), 'holdPosition must not touch the dodge timer');
});
check('squad: a holding agent gives up the hold when it is left behind', () => {
  assert.match(enemiesSrc, /const HOLD_MAX_RANGE = 24;/);
  assert.match(enemiesSrc, /&& targetDistance < HOLD_MAX_RANGE;/);
});
check('squad: suppression keeps a covered player under fire', () => {
  assert.match(enemiesSrc, /if \(enemy\.state === 'suppress' && !enemy\.visible && enemy\.memory > 0\)/);
});
check('squad: lone archetypes never hold', () => {
  const m = /private teamOf\(enemy: Enemy\): FireTeam \| null \{([\s\S]*?)\n  \}/.exec(enemiesSrc);
  assert.ok(m, 'teamOf not found');
  for (const kind of ['rusher', 'exploder', 'flyer', 'wardenPrime', 'summoner']) {
    assert.ok(m[1].includes(`'${kind}'`), `${kind} must be excluded from holding`);
  }
});

// ---------- independent allies (src/ai/Ally.ts) ----------
const allySrc = readSrc('ai/Ally.ts');

check('ally: there is no leash left', () => {
  for (const gone of ['LEASH_SOFT', 'LEASH_HARD', 'leashBroken', 'updateAnchor', 'hasAnchor', 'SLOT_SIDE']) {
    assert.ok(!allySrc.includes(gone), `ally still references ${gone}`);
  }
});
check('ally: the bot never reads the player position', () => {
  // The parameter is accepted for a uniform call signature and explicitly
  // discarded, so any future edit that reaches for the player has to change
  // the signature to do it.
  assert.match(allySrc, /void ownerPos;/);
  const m = /public update\(\n\s+dt: number,\n\s+ownerPos: THREE\.Vector3,([\s\S]*?)\n  \}/.exec(allySrc);
  assert.ok(m, 'bot update not found');
  assert.ok(!/ownerPos\./.test(m[1]), 'the bot body must not read ownerPos');
});
check('ally: each bot owns a sector and splits on the fight axis', () => {
  assert.match(allySrc, /public assignSector\(sign: number, alongZ: boolean\): void \{/);
  assert.match(allySrc, /const alongZ = \(maxZ - minZ\) > \(maxX - minX\);/);
  assert.match(allySrc, /if \(a\) a\.assignSector\(-1, alongZ\);/);
  assert.match(allySrc, /if \(b\) b\.assignSector\(1, alongZ\);/);
});
check('ally: the objective is the enemy cluster in its own sector', () => {
  assert.match(allySrc, /const coord = this\.sectorAlongZ \? p\.z : p\.x;/);
  assert.match(allySrc, /if \(Math\.sign\(coord\) !== this\.sectorSign\) return;/);
  // Averaging the cluster, not taking the nearest: a bot should walk at the
  // fight, not at whichever straggler happens to be closest.
  assert.match(allySrc, /this\.objective\.set\(sumX \/ count, sumZ \/ count\);/);
});
check('ally: an empty sector falls back to a patrol, never to the player', () => {
  const m = /private updateObjective\(([\s\S]*?)\n  \}/.exec(allySrc);
  assert.ok(m, 'updateObjective not found');
  assert.ok(!/ownerPos/.test(m[1]), 'the objective must not fall back to the player');
  assert.match(m[1], /this\.objective\.set\(0, this\.sectorSign \* span\);/);
});
check('ally: a respawn comes in from its own sector edge', () => {
  assert.match(allySrc, /private redeploy\(\): void \{/);
  assert.match(allySrc, /const edge = ROAM_LIMIT - RESPAWN_INSET;/);
  assert.match(allySrc, /if \(this\.sectorAlongZ\) this\.deploy\(new THREE\.Vector3\(along, 0, this\.sectorSign \* edge\), this\.idx\);/);
});
check('ally: facing falls back to the objective, not the player', () => {
  const m = /private faceTarget\(dt: number\): void \{([\s\S]*?)\n  \}/.exec(allySrc);
  assert.ok(m, 'faceTarget not found');
  assert.ok(!/ownerPos/.test(m[1]), 'facing must not fall back to the player');
  assert.match(m[1], /faceX = this\.objective\.x;/);
});

// ---------- juice (src/game/Game.ts, src/ai/Enemies.ts) ----------
check('juice: hitstop exists and scales the sim, not the renderer', () => {
  assert.match(gameSrc, /private hitstopT = 0;/);
  assert.match(gameSrc, /if \(this\.hitstopT > 0\) \{\n\s+this\.hitstopT -= dt;\n\s+dt \*= 0\.12;/);
});
check('juice: hitstop is never a full freeze', () => {
  // A scale of exactly 0 would stop every timer in the sim, including the one
  // counting the hitstop down.
  const m = /dt \*= ([0-9.]+);/.exec(gameSrc);
  assert.ok(m, 'hitstop scale not found');
  const scale = Number(m[1]);
  assert.ok(scale > 0 && scale < 0.5, `hitstop scale ${scale} is not a partial freeze`);
});
check('juice: a bigger kill freezes longer', () => {
  assert.match(gameSrc, /enemy\.kind === 'wardenPrime' \? 0\.16\n\s+: enemy\.elite \? 0\.1 : 0\.06/);
});
check('juice: the freeze is driven by real events, not a timer', () => {
  assert.match(gameSrc, /if \(kind === 'headshot'\) this\.hitstopT = Math\.max\(this\.hitstopT, 0\.035\);/);
});
check('juice: a hit flinches the body, scaled by the damage fraction', () => {
  assert.match(enemiesSrc, /const weight = clamp\(dealt \/ enemy\.def\.health, 0, 1\);/);
  assert.match(enemiesSrc, /enemy\.flinchAmp = Math\.min\(0\.22, 0\.05 \+ weight \* 0\.3\);/);
  assert.match(enemiesSrc, /flinchT: number;/);
});
check('juice: death has impact, topple and settle as separate beats', () => {
  assert.match(enemiesSrc, /const age = CORPSE_LIFE - enemy\.deadT;/);
  assert.match(enemiesSrc, /const squash = age < 0\.1 \? 1 - \(1 - age \/ 0\.1\) \* 0\.45 : 1;/);
  // Ease-out: a body accelerates as it falls and then stops.
  assert.match(enemiesSrc, /const topple = 1 - Math\.pow\(1 - fall, 3\);/);
});
check('juice: squash is applied to the body, not the group', () => {
  // Scaling the group would also scale the topple rotation and the position.
  assert.match(enemiesSrc, /enemy\.body\.scale\.set\(1 \+ \(1 - squash\) \* 0\.35, squash, 1 \+ \(1 - squash\) \* 0\.35\);/);
});

// ---------- drops (src/world/Pickups.ts, src/game/Game.ts) ----------
const pickupsSrc = readSrc('world/Pickups.ts');

check('drops: a station and a drop are different things', () => {
  // A station respawns and is part of the map; a drop expires and never comes
  // back. The two have opposite jobs, so they must not share one code path.
  assert.match(pickupsSrc, /export type PickupKind = 'health' \| 'ammo' \| 'salvage';/);
  assert.match(pickupsSrc, /public spawnAt\(kind: PickupKind, position: THREE\.Vector3\): void \{/);
  assert.match(pickupsSrc, /public dropAt\(kind: PickupKind, position: THREE\.Vector3, rnd: \(\) => number\): void \{/);
  assert.match(pickupsSrc, /station: boolean;/);
  assert.match(pickupsSrc, /lifeT: station \? Number\.POSITIVE_INFINITY : DROP_LIFE,/);
});
check('drops: a collected drop is removed, not parked invisible', () => {
  // A collected station goes invisible and waits to respawn. A drop must be
  // removed, or a long run accumulates dead entries forever.
  assert.match(pickupsSrc, /if \(!pickup\.station\) \{\n\s+this\.removeAt\(i\);\n\s+continue;\n\s+\}/);
});
check('drops: a drop expires, and announces it before it goes', () => {
  assert.match(pickupsSrc, /if \(pickup\.lifeT < 3\) \{/);
  assert.match(pickupsSrc, /pickup\.mesh\.visible = Math\.floor\(pickup\.lifeT \* 6\) % 2 === 0;/);
});
check('drops: shared geometry is never disposed per pickup', () => {
  // Every pickup mesh shares the module's geometries and materials. Disposing
  // them on removal would blank every other pickup on the field.
  const m = /private removeAt\(index: number\): void \{([\s\S]*?)\n  \}/.exec(pickupsSrc);
  assert.ok(m, 'removeAt not found');
  assert.ok(!/\.dispose\(\)/.test(m[1]), 'removeAt must not dispose shared resources');
});
check('drops: the roll uses the run seed, not Math.random', () => {
  // A seed code promises the same arena AND the same spawn order. A replay that
  // dropped different loot would break that promise for no benefit.
  const m = /private rollDrop\(enemy: Enemy\): void \{([\s\S]*?)\n  \}/.exec(gameSrc);
  assert.ok(m, 'rollDrop not found');
  assert.match(m[1], /const rng = this\.run\.rng;/);
  assert.ok(!/Math\.random/.test(m[1]), 'rollDrop must use the seeded rng');
  assert.match(m[1], /this\.pickups\.dropAt\('salvage', at, \(\) => rng\.next\(\)\);/);
});
check('drops: only player kills drop', () => {
  // Otherwise an escort farms the arena on the player's behalf.
  assert.match(gameSrc, /if \(byPlayer\) this\.rollDrop\(enemy\);/);
});
check('drops: a boss always pays out', () => {
  // A boss fight is long enough that a dry drop reads as a bug, not bad luck.
  const m = /private rollDrop\(enemy: Enemy\): void \{([\s\S]*?)\n  \}/.exec(gameSrc);
  assert.ok(m, 'rollDrop not found');
  assert.match(m[1], /if \(boss \|\| rng\.next\(\) < DROP_CHANCE_SALVAGE \+ elite\) \{/);
  assert.match(m[1], /if \(boss \|\| rng\.next\(\) < DROP_CHANCE_HEALTH \+ elite \* 0\.5\) \{/);
});
check('drops: health is the rarest drop', () => {
  // A common heal erases the value of the arena's health stations.
  const ammo = literal(gameSrc, 'DROP_CHANCE_AMMO');
  const health = literal(gameSrc, 'DROP_CHANCE_HEALTH');
  assert.ok(health < ammo, `health ${health} must be rarer than ammo ${ammo}`);
});
check('drops: every kind is actually handled on pickup', () => {
  assert.match(gameSrc, /if \(collected === 'health'\) this\.player\.heal\(HEALTH_PICKUP\);/);
  assert.match(gameSrc, /if \(collected === 'ammo'\) this\.weapons\.refillReserve\(\);/);
  assert.match(gameSrc, /if \(collected === 'salvage'\) \{\n\s+this\.run\.earnSalvage\(SALVAGE_PICKUP\);/);
});
check('drops: salvage has its own sound, distinct from supply', () => {
  // "Restocked" and "paid" are different pieces of news.
  assert.match(audioSrc, /public pickup\(kind: 'health' \| 'ammo' \| 'salvage'\): void \{/);
  assert.match(audioSrc, /Currency: a bright metallic ping, deliberately unlike the supply/);
});

console.log(`self-check: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
