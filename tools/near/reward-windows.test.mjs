import test from 'node:test';
import assert from 'node:assert/strict';
import { slotsForDay, rewardWindowAt, availableWindowSlots } from '../../src/economy/reward-windows.js';

test('season opens exactly 3200 fixed slots worth 16000 FOXO', () => {
  const days = Array.from({ length: 28 }, (_, day) => slotsForDay(day));
  assert.equal(days.flat().reduce((sum, slots) => sum + slots, 0), 3200);
  assert.equal(BigInt(days.flat().reduce((sum, n) => sum + n, 0)) * 5n, 16000n);
  days.forEach((slots, day) => {
    assert.equal(slots.length, 6);
    assert.equal(slots.reduce((sum, n) => sum + n, 0), day < 8 ? 115 : 114);
    assert.equal(slots[day % 6], day < 8 ? 20 : 19);
    assert.equal(slots.filter(n => n === 20).length, day < 8 ? 1 : 0);
  });
});

test('UTC boundaries open only the current day and window', () => {
  const seasonStartMs = Date.UTC(2026, 0, 1);
  const at = offset => rewardWindowAt(seasonStartMs + offset, { seasonStartMs });
  assert.equal(at(-1), null);
  assert.deepEqual(at(0), { dayIndex: 0, windowIndex: 0, budgetDay: '2026-01-01', startMs: seasonStartMs, endMs: seasonStartMs + 14400000 });
  assert.equal(at(14400000 - 1).windowIndex, 0);
  assert.equal(at(14400000).windowIndex, 1);
  assert.equal(at(86400000 - 1).windowIndex, 5);
  assert.equal(at(86400000).dayIndex, 1);
  assert.equal(at(28 * 86400000 - 1).dayIndex, 27);
  assert.equal(at(28 * 86400000), null);
  assert.throws(() => rewardWindowAt(seasonStartMs, { seasonStartMs: seasonStartMs + 1 }));
});

test('unused slots accumulate within a day without borrowing unopened or next-day slots', () => {
  assert.equal(availableWindowSlots({ dayIndex: 0, windowIndex: 0, reservedByWindow: [19, 0, 0, 0, 0, 0] }), 1);
  assert.equal(availableWindowSlots({ dayIndex: 0, windowIndex: 1, reservedByWindow: [19, 0, 0, 0, 0, 0] }), 20);
  assert.equal(availableWindowSlots({ dayIndex: 0, windowIndex: 5, reservedByWindow: [0, 0, 0, 0, 0, 0] }), 115);
  assert.equal(availableWindowSlots({ dayIndex: 1, windowIndex: 0, reservedByWindow: [0, 0, 0, 0, 0, 0] }), 19);
  assert.throws(() => availableWindowSlots({ dayIndex: 0, windowIndex: 0, reservedByWindow: [21, 0, 0, 0, 0, 0] }));
  assert.throws(() => availableWindowSlots({ dayIndex: 0, windowIndex: 0, reservedByWindow: [0, 1, 0, 0, 0, 0] }));
});

test('window inputs reject invalid indices and unsafe timestamps', () => {
  for (const day of [-1, 28, 0.5, NaN, '0']) assert.throws(() => slotsForDay(day));
  assert.throws(() => rewardWindowAt(Number.MAX_SAFE_INTEGER + 1, { seasonStartMs: 0 }));
  assert.throws(() => availableWindowSlots({ dayIndex: 0, windowIndex: 6, reservedByWindow: [] }));
});
