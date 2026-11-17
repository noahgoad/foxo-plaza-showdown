import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { validateQuartermasterProposal, deterministicQuartermasterProposal } from '../../server/near/quartermaster-policy.mjs';
import { createQuartermaster } from '../../server/near/quartermaster.mjs';

const config = { enabled: true, policyVersion: 'pilot-1', budgetAtomic: '100', maxQuantity: 10,
  maxTtlMs: 60000, providerTimeoutMs: 10 };
const context = { finalized: true, blockHash: 'block-1', blockHeight: 1, availableBudgetAtomic: '100',
  source: 'Sponsored', fundingId: 'sponsor-1', skus: [{ sku: 'finish-a', stock: 1, target: 4,
    minPriceAtomic: '2', maxPriceAtomic: '10', priceAtomic: '5', registered: true, previewed: true }] };
const proposal = { sku: 'finish-a', quantity: 3, priceAtomic: '5', reason: 'stock below registered target',
  expiresAtMs: 2000, policyVersion: 'pilot-1' };

test('Guild orders require funding proof for the approved project before accessing escrow', async t => {
  const database = new DatabaseSync(':memory:');
  t.after(() => database.close());
  const guild = { ...context, source: 'Guild', projectId: 'plaza-banner' };
  const approval = {
    operationId: 'guild-order', fundingId: guild.fundingId, projectId: guild.projectId, source: 'Guild',
    amountAtomic: '15', proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex'),
  };
  let reserved;
  let fundedProject = 'another-project';
  const service = createQuartermaster({ database, config, now: () => 1000,
    verifyGuildFunding: async request => ({ ...request, finalized: true, projectId: fundedProject, budgetAtomic: '100' }),
    orders: {
      reserve: async request => { reserved = request; return { status: 'UNKNOWN' }; },
      reconcile: async () => ({ status: 'UNKNOWN' }),
      publish: async () => {},
    },
  });
  const request = { operationId: approval.operationId, proposal, context: guild, approval };
  await assert.rejects(service.execute(request), /Guild project funding/);
  assert.equal(reserved, undefined);
  fundedProject = guild.projectId;
  await service.execute(request);
  assert.equal(reserved.projectId, guild.projectId);
  await assert.rejects(service.execute({ ...request, approval: { ...approval, projectId: 'another-project' } }), /Approved Guild project/);
});

test('policy uses finalized registered stock and keeps exact prices within funded limits', () => {
  const result = deterministicQuartermasterProposal(context, config, 1000);
  assert.equal(result.quantity, 3);
  assert.equal(validateQuartermasterProposal(result, context, config, 1000).totalAtomic, '15');
  for (const change of [{ quantity: 11 }, { quantity: 0 }, { priceAtomic: '11' }, { priceAtomic: '0' },
    { sku: 'invented' }, { expiresAtMs: 1000 }, { policyVersion: 'old' }, { signer: 'secret' }]) {
    assert.throws(() => validateQuartermasterProposal({ ...proposal, ...change }, context, config, 1000));
  }
  assert.throws(() => validateQuartermasterProposal(proposal, { ...context, finalized: false }, config, 1000));
  assert.throws(() => validateQuartermasterProposal(proposal, { ...context, availableBudgetAtomic: '14' }, config, 1000));
  assert.equal(deterministicQuartermasterProposal({ ...context, skus: [] }, config, 1000), null);
  assert.equal(deterministicQuartermasterProposal(context, { ...config, budgetAtomic: '0' }, 1000), null);
});

test('default disabled and zero budget perform no provider or order calls', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const service = createQuartermaster({ database: db, provider: () => { throw Error('called'); } });
  assert.deepEqual(await service.propose(context), { status: 'DISABLED', proposal: null });
});

test('provider rejection and timeout use deterministic proposals with sanitized input', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let input;
  const service = createQuartermaster({ database: db, config, now: () => 1000,
    provider: async value => { input = value; return { ...proposal, withdraw: true }; } });
  const result = await service.propose({ ...context, email: 'private', accounts: ['wallet.near'] });
  assert.equal(result.status, 'PROPOSED');
  assert.equal(result.providerStatus, 'REJECTED');
  assert.equal(JSON.stringify(input).includes('private'), false);
  assert.equal(JSON.stringify(input).includes('wallet.near'), false);
  const timed = createQuartermaster({ database: db, config, now: () => 1000, provider: () => new Promise(() => {}) });
  assert.equal((await timed.propose(context)).providerStatus, 'TIMEOUT');
});

test('orders publish only after reviewed authorization and confirmed escrow, with replay recovery', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let reserves = 0; let publishes = 0; let finalized = false;
  const orders = {
    reserve: async () => { reserves++; return { status: 'UNKNOWN', transactionId: 'tx-1' }; },
    reconcile: async () => finalized ? { status: 'FINALIZED', receiptId: 'receipt-1', blockHash: 'block-2', blockHeight: 2,
      orderId: 'order-1', amountAtomic: '15',
      sku: 'finish-a', quantity: 3, priceAtomic: '5' } : { status: 'UNKNOWN' },
    publish: async () => { publishes++; },
  };
  const service = createQuartermaster({ database: db, config, now: () => 1000, orders });
  const approval = { operationId: 'op-1', fundingId: 'sponsor-1', source: 'Sponsored', amountAtomic: '15',
    proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex') };
  await assert.rejects(service.execute({ operationId: 'op-1', proposal, context }), /approval/i);
  assert.equal((await service.execute({ operationId: 'op-1', proposal, context, approval })).status, 'UNKNOWN');
  assert.equal((await service.execute({ operationId: 'op-1', proposal, context, approval })).status, 'UNKNOWN');
  assert.equal(reserves, 1); assert.equal(publishes, 0);
  finalized = true;
  assert.equal((await service.execute({ operationId: 'op-1', proposal, context, approval })).status, 'PUBLISHED');
  assert.equal((await service.execute({ operationId: 'op-1', proposal, context, approval })).status, 'PUBLISHED');
  assert.equal(reserves, 1); assert.equal(publishes, 1);
  await assert.rejects(service.execute({ operationId: 'op-1', proposal: { ...proposal, quantity: 2 }, context, approval }));
});

test('provider mutation cannot expand the authority of finalized stock or price bands', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  const service = createQuartermaster({ database: db, config, now: () => 1000, provider: async input => {
    input.skus[0].target = 100;
    input.skus[0].maxPriceAtomic = '1000';
    return { ...proposal, priceAtomic: '20' };
  } });
  const result = await service.propose(context);
  assert.equal(result.providerStatus, 'REJECTED');
  assert.equal(result.proposal.priceAtomic, '5');
});

test('different operations cannot reserve the same budget and unknown send never resends', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let calls = 0;
  const service = createQuartermaster({ database: db, config: { ...config, budgetAtomic: '20' }, now: () => 1000,
    orders: { reserve: async () => { calls++; throw Error('transport failed after send'); },
      reconcile: async () => ({ status: 'UNKNOWN' }), publish: async () => assert.fail('unfunded') } });
  const approval = operationId => ({ operationId, fundingId: context.fundingId, source: context.source,
    amountAtomic: '15', proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex') });
  await service.execute({ operationId: 'first', proposal, context, approval: approval('first') });
  await service.execute({ operationId: 'first', proposal, context, approval: approval('first') });
  await assert.rejects(service.execute({ operationId: 'second', proposal, context, approval: approval('second') }), /committed/);
  assert.equal(calls, 1);
});

test('pending approved operations recover after proposal expiry and process restart', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let time = 1000;
  const orders = { reserve: async () => ({ status: 'UNKNOWN' }), reconcile: async () => ({ status: 'FINALIZED',
    receiptId: 'receipt-1', blockHash: 'block-2', blockHeight: 2,
    orderId: 'order-1', amountAtomic: '15', sku: proposal.sku, quantity: proposal.quantity, priceAtomic: proposal.priceAtomic }),
  publish: async () => {} };
  const approval = { operationId: 'recovery', fundingId: context.fundingId, source: context.source, amountAtomic: '15',
    proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex') };
  const args = { operationId: 'recovery', proposal, context, approval };
  await createQuartermaster({ database: db, config, now: () => time, orders }).execute(args);
  time = 3000;
  assert.equal((await createQuartermaster({ database: db, config, now: () => time, orders }).execute(args)).status, 'PUBLISHED');
});

test('finalized escrow evidence must include receipt identity and match all approved terms', async t => {
  const db = new DatabaseSync(':memory:'); t.after(() => db.close());
  let published = 0;
  const service = createQuartermaster({ database: db, config, now: () => 1000,
    orders: { reserve: async () => ({ status: 'FINALIZED', orderId: 'fake', amountAtomic: '15',
      sku: proposal.sku, quantity: 3, priceAtomic: '5' }), reconcile: async () => ({ status: 'UNKNOWN' }),
    publish: async () => { published++; } } });
  const approval = { operationId: 'missing-receipt', fundingId: context.fundingId, source: context.source,
    amountAtomic: '15', proposalHash: createHash('sha256').update(JSON.stringify(proposal)).digest('hex') };
  await assert.rejects(service.execute({ operationId: 'missing-receipt', proposal, context, approval }), /receipt/);
  assert.equal(published, 0);
  assert.equal(service.get('missing-receipt').status, 'UNKNOWN');
});
