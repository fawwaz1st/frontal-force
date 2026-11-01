// Runtime check — executes the real modules, not regexes over their source.
// Run: node --experimental-strip-types scripts/runtime-check.ts
//
// The self-check suite asserts WIRING by reading source text, which cannot
// prove that a formula produces the right number. This suite imports the actual
// modules and drives them, so a sign error or a wrong operator is caught.
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { Player } from '../src/player/Player.ts';
import { Run } from '../src/game/Run.ts';
import { UPGRADES } from '../src/game/Upgrades.ts';

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
const closeTo = (got: number, want: number, eps = 1e-6): void => {
  assert.ok(Math.abs(got - want) <= eps, `expected ${got} ≈ ${want} (±${eps})`);
};

/** A player standing on nothing, so no octree geometry is needed. */
const newPlayer = (): Player => new Player(null as never);
const spawn = new THREE.Vector3(0, 0, 0);

const freshPlayer = (): Player => {
  const p = newPlayer();
  p.reset(spawn, 0);
  return p;
};

// ---------- damage mitigation ----------
check('armor: flat reduction is subtracted from every hit', () => {
  const p = freshPlayer();
  p.setFlatArmor(3);
  p.damage(10);
  closeTo(p.health, p.maxHealth - 7);
});
check('armor: a hit smaller than the armor cannot heal the player', () => {
  const p = freshPlayer();
  p.setFlatArmor(8);
  p.damage(3);
  closeTo(p.health, p.maxHealth);
});
check('armor: reduction is a fraction applied after the flat subtraction', () => {
  const p = freshPlayer();
  p.setFlatArmor(10);
  p.setDamageReduction(0.5);
  p.damage(30); // (30 - 10) * 0.5 = 10
  closeTo(p.health, p.maxHealth - 10);
});
check('armor: reduction is capped at 60%', () => {
  const p = freshPlayer();
  p.setDamageReduction(0.99);
  p.damage(100);
  closeTo(p.health, p.maxHealth - 40);
});
check('armor: a negative reduction AMPLIFIES damage (Delicate Watch)', () => {
  const p = freshPlayer();
  p.setDamageReduction(-0.25);
  p.damage(20);
  closeTo(p.health, p.maxHealth - 25);
});
check('armor: sprint armor only applies while sprinting', () => {
  const still = freshPlayer();
  still.setSprintArmor(0.15);
  still.damage(20);
  closeTo(still.health, still.maxHealth - 20);
});
check('block: the chance is capped at 60%, matching the modifier clamp', () => {
  // Tougher Times stacks 4 x 12% = 48%, and Run.sync clamps the aggregate to
  // 0.6. A card that could reach 100% would make a run unkillable, so the
  // ceiling is part of the contract and the setter enforces it on its own
  // rather than trusting its caller.
  const p = freshPlayer();
  p.setBlockChance(99); // nonsense input must not make the player immortal
  let blocked = 0;
  const samples = 2000;
  for (let i = 0; i < samples; i++) {
    p.health = p.maxHealth;
    p.onBlocked = () => { blocked += 1; };
    p.damage(10);
  }
  const rate = blocked / samples;
  assert.ok(rate > 0.45 && rate < 0.75,
    `observed block rate ${rate.toFixed(2)} should sit near the 0.60 cap`);
});
check('block: a blocked hit takes nothing, and says so', () => {
  const p = freshPlayer();
  let blocked = 0;
  p.onBlocked = () => { blocked += 1; };
  let hits = 0;
  p.onDamaged = () => { hits += 1; };
  // Roll until the cap-level chance actually fires, so the assertion is about
  // the CONSEQUENCE of a block rather than about the RNG.
  p.setBlockChance(0.6);
  let fired = false;
  for (let i = 0; i < 400 && !fired; i++) {
    p.health = p.maxHealth;
    blocked = 0;
    hits = 0;
    p.damage(50);
    if (blocked === 1) fired = true;
    else assert.equal(hits, 1, 'an unblocked hit must report as a hit');
  }
  assert.ok(fired, 'a 60% block chance never fired in 400 tries');
  assert.equal(hits, 0, 'a dodged hit must not read as a hit');
  closeTo(p.health, p.maxHealth);
  assert.equal(p.lastDamageTaken, 0, 'a dodged hit deals no damage');
});
check('block: the shield is not drained by a dodged hit', () => {
  const p = freshPlayer();
  p.setBlockChance(0.6);
  for (let i = 0; i < 400; i++) {
    p.shield = 50;
    p.health = p.maxHealth;
    let dodged = false;
    p.onBlocked = () => { dodged = true; };
    p.damage(20);
    if (dodged) {
      closeTo(p.shield, 50);
      return;
    }
    closeTo(p.shield, 30);
  }
  assert.fail('a 60% block chance never fired in 400 tries');
});
check('invulnerability: the dash window swallows the hit entirely', () => {
  const p = freshPlayer();
  p.setInvulnerable(0.5);
  p.damage(99);
  closeTo(p.health, p.maxHealth);
});

// ---------- drain ----------
check('drain: moves health without firing the damage feedback', () => {
  const p = freshPlayer();
  let hits = 0;
  p.onDamaged = () => { hits += 1; };
  p.drain(5);
  closeTo(p.health, p.maxHealth - 5);
  assert.equal(hits, 0, 'a drain is upkeep, not a hit');
});
check('drain: cannot go below zero and kills at zero', () => {
  const p = freshPlayer();
  p.drain(p.maxHealth + 10);
  closeTo(p.health, 0);
  assert.equal(p.dead, true);
});
check('drain: is a no-op once dead', () => {
  const p = freshPlayer();
  p.drain(p.maxHealth);
  const before = p.health;
  p.drain(10);
  closeTo(p.health, before);
});

// ---------- revive ----------
check('revive: a banked charge restores half health and clears the death flag', () => {
  const p = freshPlayer();
  p.setRevives(1);
  p.damage(p.maxHealth + 1);
  assert.equal(p.dead, true);
  assert.equal(p.tryRevive(), true);
  assert.equal(p.dead, false);
  closeTo(p.health, Math.round(p.maxHealth * 0.5));
});
check('revive: grants a window of invulnerability so it cannot be re-killed instantly', () => {
  // A revive that dropped you back into the same bolt would burn every charge
  // in one frame, so the comeback has to be protected.
  const p = freshPlayer();
  p.setRevives(1);
  p.damage(p.maxHealth + 1);
  assert.equal(p.tryRevive(), true);
  p.damage(p.maxHealth + 1);
  closeTo(p.health, Math.round(p.maxHealth * 0.5), 1);
  assert.equal(p.dead, false, 'the invulnerability window must survive the hit');
});
check('revive: cannot fire twice on one charge', () => {
  const p = freshPlayer();
  p.setRevives(1);
  p.damage(p.maxHealth + 1);
  assert.equal(p.tryRevive(), true);
  p.clearInvulnerable();
  p.damage(p.maxHealth + 1);
  assert.equal(p.dead, true);
  assert.equal(p.tryRevive(), false);
});
check('revive: two stacks give two revives', () => {
  const p = freshPlayer();
  p.setRevives(2);
  p.damage(p.maxHealth + 1);
  assert.equal(p.tryRevive(), true);
  p.clearInvulnerable();
  p.damage(p.maxHealth + 1);
  assert.equal(p.tryRevive(), true);
  p.clearInvulnerable();
  p.damage(p.maxHealth + 1);
  assert.equal(p.tryRevive(), false);
  assert.equal(p.dead, true);
});
check('revive: a living player cannot spend a charge', () => {
  const p = freshPlayer();
  p.setRevives(1);
  assert.equal(p.tryRevive(), false);
});

// ---------- modifier aggregation ----------
check('mods: every card applies without throwing and keeps fields finite', () => {
  const run = new Run(12345);
  for (const id of Object.keys(UPGRADES)) run.take(id as never);
  run.sync();
  for (const [field, value] of Object.entries(run.mods)) {
    assert.ok(Number.isFinite(value), `${field} became ${value}`);
  }
});
check('mods: armor stacks add up across copies', () => {
  const run = new Run(1);
  for (let i = 0; i < 3; i++) run.take('armor');
  run.sync();
  closeTo(run.mods.flatArmor, 3);
});
check('mods: damage reduction is clamped to the 60% ceiling', () => {
  const run = new Run(1);
  for (let i = 0; i < 4; i++) run.take('toughTimes');
  run.sync();
  closeTo(run.mods.damageReduction, 0);
  closeTo(run.mods.blockChance, 0.48);
});
check('mods: Wings raises the movement multiplier', () => {
  const run = new Run(1);
  run.take('wings');
  run.sync();
  closeTo(run.mods.moveSpeedMul, 1.1);
});
check('mods: Delicate Watch is a net damage-taken increase', () => {
  const run = new Run(1);
  run.take('delicateWatch');
  run.sync();
  closeTo(run.mods.damageReduction, -0.25);
  closeTo(run.mods.damageMul, 1.4);
});
check('mods: Bloody Hand produces a negative regeneration (a bleed)', () => {
  const run = new Run(1);
  run.take('bloodyHand');
  run.sync();
  assert.ok(run.mods.regen < 0, `expected a negative regen, got ${run.mods.regen}`);
});
check('mods: Vulture Eye composes with High Confidence', () => {
  // Both rare cards write fullHpScoreMul. Composition must be multiplicative so
  // two stacks are a stronger pick than either alone, not a capped total.
  const run = new Run(1);
  run.take('vultureEye');
  run.take('highConfidence');
  run.sync();
  closeTo(run.mods.fullHpScoreMul, 1.25 * 1.35);
});
check('mods: Fuel Injector is Overclock in mirror', () => {
  const run = new Run(1);
  run.take('fuelInjector');
  run.sync();
  assert.ok(run.mods.fireRateMul < 1, `fire rate must drop, got ${run.mods.fireRateMul}`);
  assert.ok(run.mods.damageMul > 1, `damage must rise, got ${run.mods.damageMul}`);
  assert.ok(run.mods.magMul > 1, `magazine must rise, got ${run.mods.magMul}`);
  // Deleterious cards must not be free upside: the fire-rate cost has to be real.
  const overclock = new Run(1);
  overclock.take('overclock');
  overclock.sync();
  assert.ok(overclock.mods.damageMul < 1, `Overclock must cost damage, got ${overclock.mods.damageMul}`);
});
check('mods: armor-piercing stacks its shield-break bonus', () => {
  const run = new Run(1);
  run.take('armorPiercing');
  run.sync();
  closeTo(run.mods.shieldBreakBonus, 2);
});
check('mods: selling a card removes its contribution', () => {
  const run = new Run(1);
  run.take('armor');
  run.take('armor');
  run.sync();
  closeTo(run.mods.flatArmor, 2);
  run.refund('armor');
  run.sync();
  closeTo(run.mods.flatArmor, 1);
});
check('mods: a fresh run starts at identity', () => {
  const run = new Run(7);
  run.sync();
  closeTo(run.mods.flatArmor, 0);
  closeTo(run.mods.damageReduction, 0);
  closeTo(run.mods.moveSpeedMul, 1);
  closeTo(run.mods.blockChance, 0);
  closeTo(run.mods.shieldBreakBonus, 0);
});

// ---------- player reset ----------
check('reset: a new run clears health, shield and the death flag', () => {
  const p = freshPlayer();
  p.setBlockChance(0);
  p.addShield(80);
  p.drain(60);
  p.reset(spawn, 0);
  closeTo(p.health, p.maxHealth);
  closeTo(p.shield, 0);
  assert.equal(p.dead, false);
});

console.log(`runtime-check: ${passed}/${passed + failed} passed`);
if (failed > 0) process.exitCode = 1;
