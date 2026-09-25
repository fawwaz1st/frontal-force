import assert from 'node:assert/strict';
import { clamp, damp, dampAngle } from '../src/core/math.ts';

assert.equal(clamp(-1, 0, 3), 0);
assert.equal(clamp(4, 0, 3), 3);
assert.equal(damp(0, 10, 8, 0.25) > 0, true);
assert.equal(damp(0, 0, 8, 0.25), 0);
assert.equal(dampAngle(Math.PI - 0.1, -Math.PI + 0.1, 8, 0.25) > 3, true);

console.log('self-check: 5/5 passed');
