import test from 'node:test';
import assert from 'node:assert/strict';
import { professionEvidence } from '../../server/near/professions.mjs';

test('profession evidence counts active authoritative matches without requiring an NFT', () => {
  const result = { mode: 'boss', left: false, won: true, rulesVersion: 'near-authoritative-boss-1' };
  const signals = { activeMs: 200, durationMs: 1000, bossDamage: 1, left: false };
  assert.equal(professionEvidence(result, signals), 'boss_clear');
  assert.equal(professionEvidence(result, { ...signals, bossDamage: 0 }), 'match');
  assert.equal(professionEvidence(result, { ...signals, activeMs: 199 }), null);
  assert.equal(professionEvidence({ ...result, left: true }, signals), null);
  assert.equal(professionEvidence({ ...result, mode: 'trials', rulesVersion: 'near-authoritative-trials-1' },
    { ...signals, durationMs: 180000, activeMs: 24000, objectiveProgress: 8 }), 'trial_clear');
  assert.equal(professionEvidence({ ...result, rulesVersion: 'near-practice-1' }, signals), null);
});
