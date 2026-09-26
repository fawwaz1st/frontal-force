// Self-check — plain asserts, no framework, no three.js/DOM imports.
// Run: node --experimental-strip-types scripts/self-check.ts
// Source files are read as text (readFileSync) so tests stay pure logic while
// still regression-testing the real constants/formulas in src/.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { clamp, damp, dampAngle } from '../src/core/math.ts';

const readSrc = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(`../src/${rel}`, import.meta.url)), 'utf8');

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
  assert.match(wavesSrc, /Math\.min\(40, Math\.pow\(1\.12, this\.wave - 1\)\)/);
  assert.match(wavesSrc, /Math\.min\(1\.3, 1 \+ 0\.02 \* Math\.min\(this\.wave, 15\)\)/);
  assert.match(wavesSrc, /Math\.max\(0\.25, Math\.pow\(0\.94, this\.wave - 1\)\)/);
  assert.equal(literal(wavesSrc, 'ENDLESS_ALIVE_CAP'), 24);
  assert.match(wavesSrc, /overrun: \{[^}]*endless: true \}/);
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

// ---------- warden shield math (src/enemies/Enemies.ts) ----------
const enemiesSrc = readSrc('enemies/Enemies.ts');
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
      'volume',
      'mode',
    ].sort(),
  );
});

console.log(`self-check: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
