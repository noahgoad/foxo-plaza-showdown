import test from 'node:test';
import assert from 'node:assert/strict';
import { closeMatchRewards } from '../../server/near/match-reward-closure.mjs';

test('aborted authority releases held slots but preserves completed settlements', () => {
  const calls = [];
  const states = ['started', 'reserved', 'submitting', 'completed', 'expired'];
  const service = {
    get: id => ({ status: states[id] }),
    cancel: (...args) => calls.push(['cancel', ...args]),
    closeIncomplete: (...args) => calls.push(['close', ...args]),
  };
  const room = { roundId: 'match', fixedReservations: new Map(states.map((_, i) => [`a${i}.testnet`, i])) };
  closeMatchRewards(service, room);
  assert.deepEqual(calls, [
    ['close', 0, { matchId: 'match', reason: 'abandoned' }],
    ['cancel', 'a1.testnet', 1], ['cancel', 'a2.testnet', 2],
  ]);
  calls.length = 0;
  closeMatchRewards(service, { ...room, finished: true });
  assert.equal(calls.length, 0);
});
