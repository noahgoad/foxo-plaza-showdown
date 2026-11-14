import { randomUUID } from 'node:crypto';
import { accountId } from '../../src/economy/schema.js';
import { createPilotPolicy } from '../../src/economy/policy.js';
import { RANKING_MODES } from '../../src/economy/ranking-rules.js';

const active = "'pending','submitting','reserved','started','release_pending'";
const used = active + ",'completed'";

function identifier(value, label) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(value)) {
    throw new TypeError(`Invalid ${label}`);
  }
  return value;
}

function integer(value, label, min = 0) {
  if (!Number.isSafeInteger(value) || value < min) throw new RangeError(`Invalid ${label}`);
  return value;
}

function view(row, time) {
  if (!row) return null;
  return {
    id: row.id, campaignId: row.campaign_id, accountId: row.account_id, requestId: row.request_id,
    matchId: row.match_id, taskId: row.task_id, mode: row.mode, source: 'fixed',
    status: row.status, readyUntil: row.ready_until, budgetDay: row.budget_day, dayIndex: row.day_index,
    windowIndex: row.window_index, amountAtomic: row.amount_atomic, createdAt: row.created_at,
    startBy: row.start_by, completeBy: row.complete_by, startedAt: row.started_at,
    finishedAt: row.finished_at, resultHash: row.result_hash, reserveReceiptId: row.reserve_receipt_id,
    reserveFailureReceiptId: row.reserve_failure_receipt_id, releaseReceiptId: row.release_receipt_id,
    cancelRequested: row.release_status === 'cancelled',
    guaranteed: Boolean(row.reserve_receipt_id &&
      (row.status === 'reserved' && time < row.start_by ||
        row.status === 'started' && time < row.complete_by ||
        row.status === 'completed')),
  };
}

/**
 * Server-only. The caller provides authenticated actors and authoritative room/match data.
 * verifyChainReservation must bind finalized evidence to the network, contract, campaign,
 * reservation ID, account, amount and deadlines supplied by the calling integration.
 * A definitive failed reserve must also establish that no outstanding send can later fund it.
 * This module persists intents and results; the transport owns transaction submission.
 */
export function createFixedReservationQueue({
  database, config, campaignId, seasonStartMs, now = Date.now, verifyChainReservation,
  cancelCooldownMs = 60_000,
}) {
  identifier(campaignId, 'campaign ID');
  integer(cancelCooldownMs, 'cancel cooldown');
  if (typeof verifyChainReservation !== 'function') throw new TypeError('A finalized chain verifier is required');
  const policy = createPilotPolicy(config);
  const { windowsPerDay, maxAwardsPerAccountDay, startWithinMinutes, baseSlotsPerWindow, extraSlotDays } = config.rewardWindows;
  const startMs = integer(startWithinMinutes * 60_000, 'start duration', 1);
  const completeMs = integer(config.pilot.reservationMinutes * 60_000, 'completion duration', startMs);
  integer(maxAwardsPerAccountDay, 'daily award cap', 1);
  policy.windowAt(seasonStartMs, seasonStartMs);
  const fingerprint = JSON.stringify([config.network, config.designRevision, seasonStartMs, config.pilot.seasonDays,
    windowsPerDay, baseSlotsPerWindow, extraSlotDays, maxAwardsPerAccountDay, startMs, completeMs,
    policy.fixedAwardAtomic, cancelCooldownMs]);

  database.exec(`
    CREATE TABLE IF NOT EXISTS near_fixed_campaigns (
      campaign_id TEXT PRIMARY KEY, policy_fingerprint TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS near_fixed_reservations (
      sequence INTEGER PRIMARY KEY, id TEXT UNIQUE NOT NULL, campaign_id TEXT NOT NULL,
      account_id TEXT NOT NULL, request_id TEXT NOT NULL, match_id TEXT NOT NULL,
      task_id TEXT NOT NULL, mode TEXT NOT NULL, ready_until INTEGER NOT NULL,
      status TEXT NOT NULL, budget_day TEXT, day_index INTEGER, window_index INTEGER,
      amount_atomic TEXT, created_at INTEGER, start_by INTEGER, complete_by INTEGER,
      started_at INTEGER, finished_at INTEGER, result_hash TEXT,
      reserve_receipt_id TEXT, reserve_failure_receipt_id TEXT, release_receipt_id TEXT,
      release_status TEXT, cancelled_at INTEGER,
      UNIQUE (campaign_id, account_id, request_id),
      UNIQUE (campaign_id, account_id, match_id)
    );
    CREATE INDEX IF NOT EXISTS near_fixed_reservations_window
      ON near_fixed_reservations(campaign_id, budget_day, status);
    CREATE INDEX IF NOT EXISTS near_fixed_reservations_queue
      ON near_fixed_reservations(campaign_id, status, sequence);
    CREATE INDEX IF NOT EXISTS near_fixed_reservations_actor
      ON near_fixed_reservations(account_id, status, cancelled_at);
  `);
  database.prepare('INSERT OR IGNORE INTO near_fixed_campaigns VALUES (?, ?)').run(campaignId, fingerprint);
  const existing = database.prepare('SELECT policy_fingerprint FROM near_fixed_campaigns WHERE campaign_id = ?').get(campaignId);
  if (existing.policy_fingerprint !== fingerprint) throw new Error('Campaign policy changed after initialization');

  const read = database.prepare('SELECT * FROM near_fixed_reservations WHERE campaign_id = ? AND id = ?');
  const get = id => read.get(campaignId, identifier(id, 'reservation ID'));
  const clock = () => integer(now(), 'server time');
  const transaction = operation => {
    database.exec('BEGIN IMMEDIATE');
    try {
      const value = operation(clock());
      database.exec('COMMIT');
      return value;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  };
  const requireRow = id => {
    const row = get(id);
    if (!row) throw new Error('Unknown reservation');
    return row;
  };
  const changeStatus = database.prepare('UPDATE near_fixed_reservations SET status = ? WHERE id = ?');
  const release = database.prepare(`
    UPDATE near_fixed_reservations SET status = 'release_pending', release_status = ? WHERE id = ?
  `);
  const checkCooldown = database.prepare('SELECT MAX(cancelled_at) AS time FROM near_fixed_reservations WHERE account_id = ?');
  const eligible = database.prepare(`
    SELECT * FROM near_fixed_reservations
    WHERE campaign_id = ? AND status = 'queued' AND ready_until > ? ORDER BY sequence
  `);
  const pending = database.prepare(`
    SELECT * FROM near_fixed_reservations WHERE campaign_id = ?
      AND status IN ('pending','submitting','release_pending','completed') ORDER BY sequence
  `);

  async function verify(action, id, evidence) {
    const reservation = view(requireRow(id), clock());
    const result = await verifyChainReservation({ action, reservation, evidence });
    if (!result) return null;
    identifier(result.receiptId, 'finalized receipt ID');
    return result;
  }

  return {
    get(id) { return view(get(id), clock()); },

    enqueueReady(actor, { requestId, matchId, taskId, mode, readyUntil }) {
      accountId(actor);
      identifier(requestId, 'ready request ID');
      identifier(matchId, 'match ID');
      identifier(taskId, 'task ID');
      if (!RANKING_MODES.includes(mode)) throw new RangeError('Invalid reward mode');
      return transaction(time => {
        const previous = database.prepare(`
          SELECT * FROM near_fixed_reservations WHERE campaign_id = ? AND account_id = ?
          AND (request_id = ? OR match_id = ?)
        `).all(campaignId, actor, requestId, matchId);
        if (previous.length) {
          const [row] = previous;
          if (previous.length !== 1 || row.match_id !== matchId || row.task_id !== taskId || row.mode !== mode) {
            throw new Error('Conflicting ready request');
          }
          return view(row, time);
        }
        integer(readyUntil, 'ready expiry', time + 1);
        const lastCancel = checkCooldown.get(actor).time;
        if (lastCancel !== null && time - lastCancel < cancelCooldownMs) throw new Error('Ready request cooldown');
        const id = randomUUID();
        database.prepare(`
          INSERT INTO near_fixed_reservations
            (id,campaign_id,account_id,request_id,match_id,task_id,mode,ready_until,status)
          VALUES (?,?,?,?,?,?,?,?,'queued')
        `).run(id, campaignId, actor, requestId, matchId, taskId, mode, readyUntil);
        return view(get(id), time);
      });
    },

    allocateReady() {
      return transaction(time => {
        const window = policy.windowAt(time, seasonStartMs);
        if (!window) return [];
        const { budgetDay, dayIndex, windowIndex } = window;
        const reservedByWindow = Array(windowsPerDay).fill(0);
        const dailyCounts = new Map();
        const activeAccounts = new Set();
        for (const row of database.prepare(`
          SELECT campaign_id, account_id, window_index, budget_day, status <> 'completed' AS active
          FROM near_fixed_reservations WHERE
            (status IN (${active})) OR (campaign_id = ? AND budget_day = ? AND status IN (${used}))
        `).all(campaignId, budgetDay)) {
          if (row.active) activeAccounts.add(row.account_id);
          if (row.campaign_id === campaignId && row.budget_day === budgetDay) {
            reservedByWindow[row.window_index]++;
            dailyCounts.set(row.account_id, (dailyCounts.get(row.account_id) ?? 0) + 1);
          }
        }
        let slots = policy.availableSlots({ dayIndex, windowIndex, reservedByWindow });
        if (!slots) return [];
        const candidates = eligible.all(campaignId, time);
        const count = row => dailyCounts.get(row.account_id) ?? 0;
        candidates.sort((a, b) => count(a) - count(b) || a.sequence - b.sequence);
        const update = database.prepare(`
          UPDATE near_fixed_reservations SET status = 'pending', budget_day = ?, day_index = ?, window_index = ?,
            amount_atomic = ?, created_at = ?, start_by = ?, complete_by = ? WHERE id = ?
        `);
        const allocated = [];
        for (const row of candidates) {
          if (activeAccounts.has(row.account_id) || count(row) >= maxAwardsPerAccountDay) continue;
          const lastCancel = checkCooldown.get(row.account_id).time;
          if (lastCancel !== null && time - lastCancel < cancelCooldownMs) continue;
          update.run(budgetDay, dayIndex, windowIndex, policy.fixedAwardAtomic, time,
            integer(time + startMs, 'start deadline'), integer(time + completeMs, 'completion deadline'), row.id);
          allocated.push(view(get(row.id), time));
          activeAccounts.add(row.account_id);
          if (--slots === 0) break;
        }
        return allocated;
      });
    },

    pendingChain() {
      const time = clock();
      return pending.all(campaignId).map(row => view(row, time));
    },

    beginChainReserve(id) {
      return transaction(time => {
        const row = requireRow(id);
        if (row.status !== 'pending' || time >= row.start_by || time >= row.ready_until) return null;
        changeStatus.run('submitting', id);
        return view(get(id), time);
      });
    },

    async reconcileChainReserve(id, evidence) {
      const verified = await verify('reserve', id, evidence);
      if (!verified) return null;
      if (!['reserved', 'failed'].includes(verified.status)) throw new Error('Invalid reserve evidence');
      return transaction(time => {
        const row = requireRow(id);
        if (verified.status === 'reserved' && row.reserve_receipt_id === verified.receiptId ||
            verified.status === 'failed' && row.reserve_failure_receipt_id === verified.receiptId) return view(row, time);
        if (row.status !== 'submitting') throw new Error('No reserve submission to reconcile');
        const terminal = row.release_status ?? 'expired';
        if (verified.status === 'failed') {
          database.prepare(`
            UPDATE near_fixed_reservations SET status = ?, reserve_failure_receipt_id = ? WHERE id = ?
          `).run(terminal, verified.receiptId, id);
        } else {
          const mustRelease = row.release_status !== null || time >= row.start_by || time >= row.ready_until;
          database.prepare(`
            UPDATE near_fixed_reservations SET status = ?, reserve_receipt_id = ?, release_status = ? WHERE id = ?
          `).run(mustRelease ? 'release_pending' : 'reserved', verified.receiptId, mustRelease ? terminal : null, id);
        }
        return view(get(id), time);
      });
    },

    async reconcileChainRelease(id, evidence) {
      const verified = await verify('release', id, evidence);
      if (!verified) return null;
      if (verified.status !== 'released') throw new Error('Invalid release evidence');
      return transaction(time => {
        const row = requireRow(id);
        if (row.release_receipt_id === verified.receiptId) return view(row, time);
        if (row.status !== 'release_pending') throw new Error('No release to reconcile');
        database.prepare(`
          UPDATE near_fixed_reservations SET status = release_status, release_receipt_id = ? WHERE id = ?
        `).run(verified.receiptId, id);
        return view(get(id), time);
      });
    },

    start(id) {
      return transaction(time => {
        const row = requireRow(id);
        if (row.status === 'started') return view(row, time);
        if (row.status !== 'reserved') throw new Error('Chain reservation is not confirmed');
        if (time >= row.start_by) throw new Error('Reservation start deadline passed');
        database.prepare("UPDATE near_fixed_reservations SET status = 'started', started_at = ? WHERE id = ?").run(time, id);
        return view(get(id), time);
      });
    },

    complete(id, { finishedAt, resultHash }) {
      integer(finishedAt, 'authoritative completion time');
      if (typeof resultHash !== 'string' || !/^[a-f0-9]{64}$/.test(resultHash)) throw new TypeError('Invalid result hash');
      return transaction(time => {
        const row = requireRow(id);
        if (row.status === 'completed' && row.finished_at === finishedAt && row.result_hash === resultHash) return view(row, time);
        if (row.status !== 'started' || finishedAt < row.started_at || finishedAt >= row.complete_by || finishedAt > time) {
          throw new Error('Invalid reservation completion');
        }
        database.prepare(`
          UPDATE near_fixed_reservations SET status = 'completed', finished_at = ?, result_hash = ? WHERE id = ?
        `).run(finishedAt, resultHash, id);
        return view(get(id), time);
      });
    },

    // Call only after the authoritative simulation durably records an ineligible
    // outcome or confirms the match ended without an eligible completion.
    closeIncomplete(id, { matchId, reason }) {
      if (!['ineligible', 'abandoned', 'deadline'].includes(reason)) throw new Error('Invalid match closure reason');
      return transaction(time => {
        const row = requireRow(id);
        if (row.match_id !== matchId || row.started_at === null) throw new Error('Match closure mismatch');
        if (row.release_status === 'expired') return view(row, time);
        if (row.status !== 'started' || (reason === 'deadline' && time < row.complete_by)) {
          throw new Error('Reservation cannot be released for this closure');
        }
        release.run('expired', id);
        return view(get(id), time);
      });
    },

    cancel(actor, id) {
      accountId(actor);
      return transaction(time => {
        const row = requireRow(id);
        if (actor !== row.account_id) throw new Error('Reservation actor mismatch');
        if (row.status === 'cancelled' || row.release_status === 'cancelled') return view(row, time);
        if (!['queued', 'pending', 'submitting', 'reserved'].includes(row.status)) throw new Error('Reservation cannot be cancelled');
        if (row.status === 'submitting') {
          database.prepare("UPDATE near_fixed_reservations SET release_status = 'cancelled' WHERE id = ?").run(id);
        } else if (row.status === 'reserved') {
          release.run('cancelled', id);
        } else {
          changeStatus.run('cancelled', id);
        }
        database.prepare('UPDATE near_fixed_reservations SET cancelled_at = ? WHERE id = ?').run(time, id);
        return view(get(id), time);
      });
    },

    expireUnstarted() {
      return transaction(time => {
        const rows = database.prepare(`
          SELECT * FROM near_fixed_reservations WHERE campaign_id = ?
          AND ((status IN ('queued','pending') AND ready_until <= ?) OR
            (status IN ('pending','reserved') AND start_by <= ?)) ORDER BY sequence
        `).all(campaignId, time, time);
        for (const row of rows) {
          if (row.status === 'reserved') release.run('expired', row.id);
          else changeStatus.run('expired', row.id);
        }
        return rows.map(row => view(get(row.id), time));
      });
    },
  };
}
