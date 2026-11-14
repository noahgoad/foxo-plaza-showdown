import { createHash } from 'node:crypto';

const prefix = 'EVENT_JSON:';
const u128Max = (1n << 128n) - 1n;
const u64Max = (1n << 64n) - 1n;
const accountPattern = /^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/;
const operationPattern = /^[a-zA-Z0-9_:.\/-]+$/;
const nonFinancialEvents = new Set(['cosmetic_sale_opened', 'cosmetic_sale_cancelled', 'ranking_draft_proposed']);
function eventAmount(name, data) {
  if (nonFinancialEvents.has(name)) return '0';
  if (name === 'cosmetic_sale_filled') return data.grossAtomic;
  if (name === 'ranking_draft_published') return data.awardedAtomic;
  return data.amountAtomic;
}
const claimEvents = new Set(['reward_paid', 'reward_transfer_failed', 'reward_payout_started']);

function requireIndex(condition, message) {
  if (!condition) throw new Error(message);
}

function isAccount(value) {
  return typeof value === 'string' && value.length >= 2 && value.length <= 64 && accountPattern.test(value);
}

function isIdentifier(value, maxLength) {
  return typeof value === 'string' && value.length <= maxLength && operationPattern.test(value);
}

function validAtomic(value, max) {
  return typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) <= max;
}

function isHeight(height) {
  return Number.isSafeInteger(height) && height >= 0;
}

function object(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readLog(line) {
  if (!line.startsWith(prefix)) return null;
  let event;
  try {
    event = JSON.parse(line.slice(prefix.length));
  } catch {
    throw new Error('Malformed EVENT_JSON log');
  }
  if (event?.standard !== 'fox_economy') return null;
  requireIndex(event.version === '1.0.0', 'Unsupported fox_economy event version');
  requireIndex(typeof event.event === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(event.event) &&
    Array.isArray(event.data) && event.data.length > 0, 'Malformed fox_economy event');
  for (const data of event.data) {
    requireIndex(object(data) && validAtomic(eventAmount(event.event, data), u128Max), 'Invalid event atomic amount');
    if (data.accountId !== undefined || event.event.startsWith('reward_')) {
      requireIndex(isAccount(data.accountId), 'Invalid event account');
    }
    if (claimEvents.has(event.event) || event.event === 'reward_reserved') {
      requireIndex(isIdentifier(data.operationId, 96), 'Invalid event operation ID');
    }
    if (claimEvents.has(event.event)) {
      requireIndex(validAtomic(data.attempt, u64Max) && BigInt(data.attempt)>0n, 'Invalid claim attempt');
    }
    if (event.event === 'reward_reserved') {
      requireIndex(isIdentifier(data.campaignId, 64), 'Invalid event campaign ID');
    }
  }
  return event;
}

function collectEvents(block, contractId) {
  const events = [];
  const seenReceipts = new Set();
  for (const receipt of block.receipts) {
    requireIndex(isIdentifier(receipt?.receiptId, 128) && isAccount(receipt.executorId) &&
      typeof receipt.success === 'boolean' && Array.isArray(receipt.logs) &&
      receipt.logs.every(line => typeof line === 'string'), 'Malformed receipt');
    const { receiptId, executorId, success, logs } = receipt;
    requireIndex(!seenReceipts.has(receiptId), 'Duplicate receipt in finalized block');
    seenReceipts.add(receiptId);
    if (executorId !== contractId || !success) continue;
    for (const [logIndex, line] of logs.entries()) {
      const event = readLog(line);
      if (!event) continue;
      for (const [eventIndex, data] of event.data.entries()) {
        events.push({ receiptId, logIndex, eventIndex, event: event.event, data });
      }
    }
  }
  return events.sort((left, right) => left.receiptId < right.receiptId ? -1 : Number(left.receiptId > right.receiptId));
}

/**
 * The provider returns the next canonical block after the given cursor, or the block at
 * startHeight for a new stream. It must supply complete execution outcomes at finality.
 * Return null if that block is unavailable. receipt.success describes the local receipt,
 * not the final status of any promise the receipt starts.
 */
export function createEconomyIndexer(database, { network, contractId, startHeight, getFinalizedBlock, now = Date.now } = {}) {
  requireIndex(typeof network === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(network) &&
    isAccount(contractId) && isHeight(startHeight), 'Invalid economy index stream');
  database.exec(`
    CREATE TABLE IF NOT EXISTS near_economy_index_sync (
      network TEXT NOT NULL, contract_id TEXT NOT NULL, synced_at_ms INTEGER NOT NULL,
      PRIMARY KEY(network,contract_id)
    );
    CREATE TABLE IF NOT EXISTS near_economy_index_blocks (
      network TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      height INTEGER NOT NULL,
      hash TEXT NOT NULL,
      previous_hash TEXT NOT NULL,
      events_hash TEXT NOT NULL,
      PRIMARY KEY (network, contract_id, height),
      UNIQUE (network, contract_id, hash)
    );
    CREATE TABLE IF NOT EXISTS near_economy_index_events (
      network TEXT NOT NULL,
      contract_id TEXT NOT NULL,
      block_height INTEGER NOT NULL,
      receipt_id TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      event_index INTEGER NOT NULL,
      event TEXT NOT NULL,
      amount_atomic TEXT NOT NULL,
      data TEXT NOT NULL,
      PRIMARY KEY (network, contract_id, receipt_id, log_index, event_index),
      FOREIGN KEY (network, contract_id, block_height)
        REFERENCES near_economy_index_blocks (network, contract_id, height)
    );
  `);
  const scope = [network, contractId];
  const latest = database.prepare(`SELECT height, hash FROM near_economy_index_blocks
    WHERE network = ? AND contract_id = ? ORDER BY height DESC LIMIT 1`);
  const atHeight = database.prepare(`SELECT hash, previous_hash, events_hash FROM near_economy_index_blocks
    WHERE network = ? AND contract_id = ? AND height = ?`);
  const insertBlock = database.prepare(`INSERT INTO near_economy_index_blocks
    (network, contract_id, height, hash, previous_hash, events_hash) VALUES (?, ?, ?, ?, ?, ?)`);
  const insertEvent = database.prepare(`INSERT INTO near_economy_index_events
    (network, contract_id, block_height, receipt_id, log_index, event_index, event, amount_atomic, data)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  function cursor() {
    const row = latest.get(...scope);
    return row ? { height: row.height, hash: row.hash } : null;
  }

  function ingestBlock(block) {
    requireIndex(block?.finality === 'final', 'Expected a finalized block');
    const { height, hash, previousHash, receipts } = block;
    requireIndex(isHeight(height) && isIdentifier(hash, 128) && isIdentifier(previousHash, 128) &&
      hash !== previousHash && Array.isArray(receipts), 'Malformed finalized block');
    const events = collectEvents(block, contractId);
    const eventsHash = createHash('sha256').update(JSON.stringify(events)).digest('hex');

    database.exec('BEGIN IMMEDIATE');
    try {
      const known = atHeight.get(...scope, height);
      if (known) {
        requireIndex(known.hash === hash && known.previous_hash === previousHash && known.events_hash === eventsHash,
          'Conflicting finalized block replay');
        const current = cursor();
        database.exec('COMMIT');
        return { status: 'REPLAY', cursor: current, eventsAdded: 0 };
      }
      const current = cursor();
      if (!current) requireIndex(height === startHeight, 'Expected configured start height');
      else {
        requireIndex(height > current.height, 'Finalized block is older than the cursor');
        requireIndex(previousHash === current.hash, 'Finalized block previous hash does not match cursor');
      }
      insertBlock.run(...scope, height, hash, previousHash, eventsHash);
      for (const { receiptId, logIndex, eventIndex, event, data } of events) {
        insertEvent.run(...scope, height, receiptId, logIndex, eventIndex, event, eventAmount(event, data), JSON.stringify(data));
      }
      const syncedAt=now();
      requireIndex(Number.isSafeInteger(syncedAt)&&syncedAt>=0,'Invalid synchronization time');
      database.prepare(`INSERT INTO near_economy_index_sync VALUES(?,?,?) ON CONFLICT(network,contract_id)
        DO UPDATE SET synced_at_ms=excluded.synced_at_ms`).run(...scope,syncedAt);
      database.exec('COMMIT');
      return { status: 'APPLIED', cursor: { height, hash }, eventsAdded: events.length };
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  }

  async function ingestNext(finalizedHead) {
    requireIndex(typeof getFinalizedBlock === 'function', 'Missing finalized block provider');
    const block = await getFinalizedBlock(cursor(), startHeight, finalizedHead);
    if (block === null) return { status: 'UNAVAILABLE', cursor: cursor(), eventsAdded: 0 };
    return ingestBlock(block);
  }

  return { cursor, ingestBlock, ingestNext };
}
