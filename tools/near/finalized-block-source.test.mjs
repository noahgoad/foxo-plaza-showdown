import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { createFinalizedTestnetBlockSource } from '../../server/near/finalized-block-source.mjs';
import { createEconomyIndexer } from '../../server/near/indexer.mjs';

const hash = letter => letter.repeat(43);
const base = (height, prevHeight, id, prevId) => {
  const header = { height, hash: hash(id), prev_height: prevHeight, prev_hash: hash(prevId) };
  return { header, chunks: [
    { shard_id: 5, chunk_hash: hash('C'), height_included: height },
    { shard_id: 9, chunk_hash: hash('D'), height_included: prevHeight },
  ] };
};
const block = base(102, 100, 'A', 'B');
const latest = base(103, 102, 'E', 'A');
const executor = 'economy.testnet';
const account = 'alice.testnet';
const log = `EVENT_JSON:${JSON.stringify({ standard: 'fox_economy', version: '1.0.0',
  event: 'reward_funded', data: [{ accountId: account, amountAtomic: '7' }] })}`;
const receipt = (id, status) => ({ receipt: { receipt_id: hash(id), receiver_id: executor },
  execution_outcome: { id: hash(id), block_hash: block.header.hash,
    outcome: { executor_id: executor, status, logs: [log] } } });

test('archive supplies historical blocks and skips HTTP 422 only for a genuinely missing height', async () => {
  const document = { block, shards: [
    { shard_id: 5, state_changes: [], chunk: { header: block.chunks[0], transactions: [], receipts: [] },
      receipt_execution_outcomes: [] },
    { shard_id: 9, state_changes: [], chunk: null, receipt_execution_outcomes: [] },
  ] };
  const source = createFinalizedTestnetBlockSource({ fetcher: async (url, options) => {
    if (!options.body) return Response.json(document);
    const { params } = JSON.parse(options.body);
    if (params.finality) {
      assert.equal(new URL(url).hostname, 'near-testnet.drpc.org');
      return Response.json({ result: latest });
    }
    assert.equal(new URL(url).hostname, 'archival-rpc.testnet.near.org');
    if (params.block_id === 101) return Response.json({ error: { cause: { name: 'UNKNOWN_BLOCK' } } }, { status: 422 });
    assert.equal(params.block_id, 102);
    return Response.json({ result: block });
  } });
  assert.equal((await source({ height: 100, hash: hash('B') })).height, 102);
});

function fixture(mutate, rpcOverride) {
  const document = { block: structuredClone(block), shards: [
    { shard_id: 5, state_changes: [], chunk: { header: block.chunks[0], transactions: [], receipts: [] },
      receipt_execution_outcomes: [receipt('F', { SuccessReceiptId: hash('H') }), receipt('G', { Failure: {} })] },
    { shard_id: 9, state_changes: [], chunk: null, receipt_execution_outcomes: [] },
  ] };
  mutate?.(document);
  const calls = [];
  const provider = createFinalizedTestnetBlockSource({
    rpc: async (method, params) => {
      assert.equal(method, 'block');
      calls.push(params);
      if (rpcOverride) return rpcOverride(params);
      if (params.finality) return latest;
      return params.block_id === 102 ? block : null;
    },
    fetcher: async (url, options) => {
      assert.equal(url, 'https://testnet.neardata.xyz/v0/block/102');
      assert.equal(options.redirect, 'manual');
      return Response.json(document);
    },
  });
  return { provider, calls };
}

test('reads receipt-only outcomes and preserves local failure for the journal', async () => {
  const { provider } = fixture();
  const database = new DatabaseSync(':memory:');
  try {
    const journal = createEconomyIndexer(database, { network: 'near-testnet', contractId: executor,
      startHeight: 102, getFinalizedBlock: provider });
    assert.deepEqual(await provider.getFinalizedHead(), { height: 103, hash: hash('E') });
    const applied = await journal.ingestNext();
    assert.equal(applied.eventsAdded, 1);
    assert.deepEqual(journal.cursor(), { height: 102, hash: hash('A') });
  } finally {
    database.close();
  }
});

test('skips an absent height only after validating the direct canonical parent', async () => {
  const { provider, calls } = fixture();
  const next = await provider({ height: 100, hash: hash('B') }, 0);
  assert.equal(next.height, 102);
  assert.deepEqual(calls, [{ finality: 'final' }, { block_id: 101 }, { block_id: 102 }]);
  await assert.rejects(provider({ height: 100, hash: hash('J') }, 0), /directly extend/);
  assert.equal(await provider({ height: 103, hash: hash('E') }, 0), null);
  await assert.rejects(provider(null, 101), /unavailable/);
});

test('rejects mismatched headers, missing shards, absent outcome arrays and malformed receipts', async () => {
  for (const [mutate, expected] of [
    [d => { d.block.header.hash = hash('J'); }, /canonical RPC/],
    [d => { d.shards.pop(); }, /incomplete shard/],
    [d => { delete d.shards[0].receipt_execution_outcomes; }, /missing shard outcome/],
    [d => { d.shards[0].receipt_execution_outcomes[0].execution_outcome.block_hash = hash('J'); }, /receipt outcome/],
    [d => { d.shards[0].receipt_execution_outcomes[0].execution_outcome.outcome.status = 'Unknown'; }, /unknown receipt/],
    [d => { d.shards[0].receipt_execution_outcomes.push(receipt('F', { SuccessValue: '' })); }, /duplicate receipt/],
  ]) {
    await assert.rejects(fixture(mutate).provider(null, 102), expected);
  }
});

test('a missing source document does not advance the journal cursor', async () => {
  const database = new DatabaseSync(':memory:');
  try {
    const { provider } = fixture(() => {}, params => params.finality ? latest : block);
    const broken = createFinalizedTestnetBlockSource({
      rpc: async (_method, params) => params.finality ? latest : block,
      fetcher: async () => Response.json(null),
    });
    const journal = createEconomyIndexer(database, { network: 'near-testnet', contractId: executor,
      startHeight: 102, getFinalizedBlock: broken });
    await assert.rejects(journal.ingestNext(), /outcome document unavailable/);
    assert.equal(journal.cursor(), null);
    assert.equal(journal.ingestBlock(await provider(null, 102)).eventsAdded, 1);
  } finally {
    database.close();
  }
});
