import test from 'node:test';
import assert from 'node:assert/strict';
import { materialAward } from '../../src/economy/material-rules.js';

test('private practice and abandoned rounds grant no tradeable materials', () => {
  const fresh = { alloy: 0, core: 0, catalyst: 0 };
  assert.deepEqual(materialAward({ mode: 'boss', won: true }, fresh, 'catalyst'), fresh);
  assert.deepEqual(materialAward({ mode: 'boss', eligible: true, left: true, won: true }, fresh), fresh);
});

test('weekly alternatives and standard modes draw from the same limits', () => {
  const full = { alloy: 12, core: 2, catalyst: 1 };
  assert.deepEqual(materialAward({ mode: 'hunt', eligible: true }, full, 'core'),
    { alloy: 0, core: 0, catalyst: 0 });
  assert.deepEqual(materialAward({ mode: 'control', eligible: true },
    { alloy: 8, core: 0, catalyst: 0 }, 'catalyst'), { alloy: 4, core: 0, catalyst: 1 });
  assert.deepEqual(materialAward({ mode: 'boss', eligible: true, won: true },
    { alloy: 0, core: 0, catalyst: 0 }, 'core'), { alloy: 4, core: 1, catalyst: 0 });
});
