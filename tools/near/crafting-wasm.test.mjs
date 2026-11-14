import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const wasm = new URL('../../contracts/near-economy/target/wasm32-unknown-unknown/release/near_economy.wasm', import.meta.url);
const token = 'foxo.testnet';
const contract = 'economy.operator.testnet';
const owner = 'operator.testnet';
const signer = 'signer.testnet';
const alice = 'alice.testnet';
const fee = '5000000000000000000000000';

export async function fixture(logs = [], options = {}) {
  const module = await WebAssembly.compile(await readFile(process.env.NEAR_ECONOMY_TEST_WASM || wasm));
  const registers = new Map();
  let storage = new Map();
  let input, result, predecessor, transactionSigner, deposit, instance, transferSucceeded;
  const read = (length, address) => Buffer.from(new Uint8Array(instance.exports.memory.buffer, Number(address), Number(length)));
  const write = (bytes, address) => new Uint8Array(instance.exports.memory.buffer, Number(address), bytes.length).set(bytes);
  const register = (id, value) => registers.set(id, Buffer.from(value));
  const key = (length, address) => read(length, address).toString('hex');
  const env = {
    log_utf8: (length, pointer) => logs.push(read(length, pointer).toString()),
    input: id => register(id, input),
    current_account_id: id => register(id, contract),
    predecessor_account_id: id => register(id, predecessor),
    signer_account_id: id => register(id, transactionSigner),
    register_len: id => BigInt(registers.get(id)?.length ?? -1),
    read_register: (id, pointer) => write(registers.get(id), pointer),
    value_return: (length, pointer) => { result = JSON.parse(read(length, pointer)); },
    panic_utf8: (length, pointer) => { throw new Error(read(length, pointer).toString()); },
    block_timestamp: () => BigInt(options.nowMs?.() ?? 100 * 86_400_000) * 1_000_000n,
    attached_deposit: pointer => {
      const bytes = Buffer.alloc(16);
      bytes.writeBigUInt64LE(deposit & ((1n << 64n)-1n));
      bytes.writeBigUInt64LE(deposit >> 64n,8);
      write(bytes, pointer);
    },
    sha256: (length, pointer, id) => register(id, createHash('sha256').update(read(length, pointer)).digest()),
    storage_has_key: (length, address) => storage.has(key(length, address)) ? 1n : 0n,
    storage_usage: () => BigInt([...storage].reduce((sum,[k,v]) => sum + k.length/2 + v.length,0)),
    storage_read: (length, address, id) => {
      const value = storage.get(key(length, address));
      if (!value) return 0n;
      register(id, value);
      return 1n;
    },
    storage_write: (length, address, valueLength, valueAddress, id) => {
      const k = key(length, address);
      const previous = storage.get(k);
      if (previous) register(id, previous);
      storage.set(k, read(valueLength, valueAddress));
      return previous ? 1n : 0n;
    },
    storage_remove: (length, address, id) => {
      const k = key(length, address);
      const value = storage.get(k);
      if (!value) return 0n;
      register(id, value);
      storage.delete(k);
      return 1n;
    },
    prepaid_gas: () => 100_000_000_000_000n,
    promise_batch_create: () => 0n,
    promise_batch_then: () => 1n,
    promise_batch_action_function_call: () => {},
    promise_batch_action_function_call_weight: () => {},
    promise_batch_action_transfer: () => {},
    promise_return: () => {},
    promise_results_count: () => 1n,
    promise_result: (_index, id) => {
      if (!transferSucceeded) return 2n;
      register(id, typeof transferSucceeded === 'string' ? transferSucceeded : '');
      return 1n;
    },
  };
  for (const { name } of WebAssembly.Module.imports(module)) {
    env[name] ??= () => { throw new Error('Unexpected host call: ' + name); };
  }
  return (method, args, caller = alice, attached = 0n, signedBy = caller, receiptSucceeded = false) => {
    input = JSON.stringify(args);
    predecessor = caller;
    transactionSigner = signedBy;
    deposit = attached;
    transferSucceeded = receiptSucceeded;
    result = undefined;
    registers.clear();
    instance = new WebAssembly.Instance(module, { env });
    const snapshot = new Map(storage);
    try {
      instance.exports[method]();
      return result;
    } catch (error) {
      storage = snapshot;
      throw error;
    }
  };
}

test('the operator can initialize its subaccount in the deployment transaction', async () => {
  const call = await fixture();
  const args = { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer };
  assert.throws(() => call('new', args, alice), /parent operator/);
  assert.throws(() => call('new', args, owner, 0n, alice), /parent operator/);
  call('new', args, owner);
  assert.equal(call('get_config', {}).ownerId, owner);
});

test('compiled contract accepts one paid craft and refunds unsuccessful transfer calls', async () => {
  const call = await fixture();
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  const recipe = { recipeId: 'finish', version: 1, sku: 'finish-a', inputs: { alloy: 8, core: 1, catalyst: 0 }, feeAtomic: fee };
  call('add_recipe', { recipe }, owner);
  assert.throws(() => call('add_recipe', { recipe }, owner), /version already exists/);
  const craft = (operationId, amount = fee) => call('ft_on_transfer', {
    sender_id: alice, amount, msg: JSON.stringify({ action: 'craft', operationId, recipeId: 'finish', recipeVersion: 1 }),
  }, token);
  assert.equal(craft('craft-1'), fee);
  call('set_crafting_enabled', { enabled: true }, owner);
  assert.equal(craft('craft-1'), fee);
  const grant = { account_id: alice, match_id: 'match-1', materials: { alloy: 8, core: 1, catalyst: 0 } };
  assert.throws(() => call('grant_materials', grant), /Unauthorized/);
  assert.equal(call('grant_materials', grant, signer), true);
  assert.equal(call('grant_materials', grant, signer), false);
  assert.throws(() => call('grant_materials', { ...grant, match_id: 'match-2' }, signer), /quota exceeded/);
  assert.equal(craft('craft-1', '1'), '1');
  assert.equal(craft('craft-1'), '0');
  assert.equal(craft('craft-1'), fee);
  assert.equal(craft('craft-2'), fee);
  assert.deepEqual(call('get_inventory', { account_id: alice }).available, { alloy: 0, core: 0, catalyst: 0 });
  const itemId = alice + ':craft-1';
  assert.equal(call('get_item', { item_id: itemId }).ownerId, alice);
  assert.deepEqual(call('get_owned_items', { account_id: alice, offset: 0, limit: 10 })
    .map(item => item.itemId), [itemId]);
  assert.deepEqual(call('get_owned_items', { account_id: alice, offset: 1, limit: 10 }), []);
  assert.throws(() => call('equip', { item_id: itemId }, 'bob.testnet', 1n), /Only the item owner/);
  call('equip', { item_id: itemId }, alice, 1n);
  assert.equal(call('get_equipped', { account_id: alice }), itemId);
  const ledger = call('get_ledger', {});
  assert.equal(ledger.craftingFees, fee);
  assert.equal(ledger.rewardAvailable, '0');
});

test('funded order settles delivery and preserves seller and refund credits across failed receipts', async () => {
  const logs = [];
  const call = await fixture(logs);
  const bob = 'bob.testnet';
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  call('set_crafting_enabled', { enabled: true }, owner);
  const inputs = { alloy: 1, core: 0, catalyst: 0 };
  for (const version of [1, 2]) {
    call('add_recipe', { recipe: { recipeId: 'finish', version, sku: 'finish-a', inputs, feeAtomic: fee } }, owner);
  }
  call('grant_materials', { account_id: alice, match_id: 'loot', materials: { ...inputs, alloy: 2 } }, signer);
  for (const version of [1, 2]) {
    assert.equal(call('ft_on_transfer', { sender_id: alice, amount: fee,
      msg: JSON.stringify({ action: 'craft', operationId: 'craft-' + version, recipeId: 'finish', recipeVersion: version }) }, token), '0');
  }
  const item = alice + ':craft-1';
  call('equip', { item_id: item }, alice, 1n);
  const expiresAtMs = 101 * 86_400_000;
  const fund = (overrides = {}, amount = '200') => call('ft_on_transfer', {
    sender_id: bob, amount, msg: JSON.stringify({ action: 'fund_order', operationId: 'buy-1',
      recipeId: 'finish', recipeVersion: 1, quantity: 2, unitPrice: '100', expiresAtMs, ...overrides }),
  }, token);
  assert.equal(fund(), '200');
  call('set_orders_enabled', { enabled: true }, owner);
  assert.equal(fund(), '200');
  call('deposit_order_storage', {}, bob, 10n**24n);
  assert.equal(fund({ expiresAtMs: 100 * 86_400_000 }), '200');
  assert.equal(fund({}, '201'), '201');
  assert.equal(fund(), '0');
  assert.equal(fund(), '200');
  const order_id = bob + ':buy-1';
  assert.throws(() => call('fill_order', { order_id, item_id: alice + ':craft-2' }, alice, 1n), /does not match/);
  call('fill_order', { order_id, item_id: item }, alice, 1n);
  assert.equal(call('get_item', { item_id: item }).ownerId, bob);
  assert.equal(call('get_equipped', { account_id: alice }), null);
  assert.deepEqual(call('get_owned_items', { account_id: alice, offset: 0, limit: 1 }).map(x => x.itemId), [alice + ':craft-2']);
  assert.deepEqual(call('get_owned_items', { account_id: bob, offset: 0, limit: 1 }).map(x => x.itemId), [item]);
  assert.throws(() => call('fill_order', { order_id, item_id: item }, alice, 1n), /Only the item owner/);
  call('set_orders_enabled', { enabled: false }, owner);
  call('close_order', { order_id }, bob, 1n);
  assert.throws(() => call('close_order', { order_id }, bob, 1n), /already closed/);
  assert.deepEqual(call('get_order_ledger', {}), { escrow: '0', payable: '198', inFlight: '0', marketFees: '2' });
  call('withdraw_order_credit', {}, alice, 1n);
  assert.deepEqual(call('get_order_ledger', {}), { escrow: '0', payable: '100', inFlight: '98', marketFees: '2' });
  assert.throws(() => call('finish_order_payout', { payout_id: 0 }, alice), /private/);
  assert.equal(call('finish_order_payout', { payout_id: 0 }, contract), false);
  assert.equal(call('get_order_credit', { account_id: alice }), '98');
  call('withdraw_order_credit', {}, alice, 1n);
  assert.equal(call('finish_order_payout', { payout_id: 1 }, contract, 0n, contract, true), true);
  assert.throws(() => call('finish_order_payout', { payout_id: 1 }, contract), /Unknown payout/);
  assert.equal(call('get_order_credit', { account_id: bob }), '100');
  assert.deepEqual(call('get_order_ledger', {}), { escrow: '0', payable: '100', inFlight: '0', marketFees: '2' });
  assert.equal(call('get_config', {}).marketFeeBps, 250);
  const fill = logs.map(line => JSON.parse(line.slice('EVENT_JSON:'.length)))
    .find(event => event.event === 'order_filled').data[0];
  assert.deepEqual([fill.grossAtomic, fill.feeAtomic, fill.netAtomic], ['100','2','98']);
  call('set_orders_enabled', { enabled: true }, owner);
  assert.equal(fund({ operationId:'dust', recipeVersion:2, quantity:1, unitPrice:'39' }, '39'), '0');
  call('fill_order', { order_id:bob+':dust', item_id:alice+':craft-2' }, alice, 1n);
  assert.equal(call('get_order_credit', { account_id:alice }), '39');
  assert.equal(call('get_order_ledger', {}).marketFees, '2');
});

test('campaigns cannot reserve the same FOXO twice or release player entitlements on close', async () => {
  const logs = [];
  const call = await fixture(logs);
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  call('ft_on_transfer', { sender_id: owner, amount: '100', msg: '{"action":"fund_rewards"}' }, token);
  const closes = 101 * 86_400_000;
  const campaign = { campaign_id: 'pilot', budget: '70', max_award: '40', closes_at_ms: closes };
  call('open_campaign', campaign, owner);
  assert.throws(() => call('open_campaign', { ...campaign, campaign_id: 'overdraw' }, owner), /unallocated/);
  call('set_settlement_enabled', { enabled: true }, owner);
  const payload = {
    version: 1, network: 'near-testnet', contractId: contract, signerEpoch: 1,
    campaignId: 'pilot', operationId: 'first', accountId: alice, matchId: 'round-1',
    rulesVersion: 'pilot-1', expiresAtMs: closes, amountAtomic: '40', resultHash: '1'.repeat(64),
  };
  const settle = overrides => call('settle_result', { payload: { ...payload, ...overrides } }, signer);
  assert.throws(() => settle({ amountAtomic: '41' }), /campaign cap/);
  const entitlement = settle({});
  assert.deepEqual(settle({}), entitlement);
  const events = logs.map(line => JSON.parse(line.slice('EVENT_JSON:'.length)));
  assert.deepEqual(events.map(event => event.event), ['reward_funded', 'reward_reserved']);
  assert.equal(events[1].data[0].amountAtomic, '40');
  assert.throws(() => settle({ operationId: 'other' }), /already settled/);
  assert.throws(() => settle({ operationId: 'other', matchId: 'round-2' }), /campaign funds/);
  call('close_campaign', { campaign_id: 'pilot' }, owner);
  assert.equal(call('get_ledger', {}).rewardAvailable, '60');
  assert.equal(call('get_ledger', {}).rewardReserved, '40');
  assert.equal(call('get_ledger', {}).campaignAvailable, '0');
  assert.throws(() => settle({ operationId: 'other', matchId: 'round-2', amountAtomic: '20' }), /Campaign closed/);
});

test('fixed reservations preserve held awards across campaign close and prevent duplicate settlement', async () => {
  const call = await fixture();
  const now = 100 * 86_400_000;
  const award = '5000000000000000000000000';
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  call('ft_on_transfer', { sender_id: owner, amount: (16000n * 10n ** 24n).toString(), msg: '{"action":"fund_rewards"}' }, token);
  call('open_fixed_campaign', { campaign_id: 'fixed', season_start_ms: now }, owner);
  call('set_settlement_enabled', { enabled: true }, owner);
  const reservation = { id: 'fixed-1', campaignId: 'fixed', accountId: alice, matchId: 'round-1', taskId: 'boss-clear',
    mode: 'boss', amountAtomic: award, createdAtMs: now, startByMs: now + 600000, completeByMs: now + 3600000, dayIndex: 0, windowIndex: 0 };
  const reserve = () => call('reserve_fixed_reward', { reservation }, signer);
  assert.equal(reserve().status, 'reserved');
  assert.equal(reserve().status, 'reserved');
  assert.equal(call('get_ledger', {}).fixedReserved, award);
  call('close_campaign', { campaign_id: 'fixed' }, owner);
  const settle = () => call('settle_fixed_reward', { reservation_id: reservation.id,
    started_at_ms: now, finished_at_ms: now, result_hash: 'a'.repeat(64) }, signer);
  assert.equal(settle().amountAtomic, award);
  assert.equal(settle().amountAtomic, award);
  assert.equal(call('get_ledger', {}).fixedReserved, '0');
  assert.equal(call('get_ledger', {}).rewardReserved, award);
});


test('professions require distinct verified matches and unlock permanently', async () => {
  const call = await fixture();
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  const args = (match_id, kind) => ({ account_id: alice, matches: [{ match_id, kind }] });
  const license = license_id => call('get_recipe_license', { account_id: alice, license_id });
  assert.throws(() => call('record_profession_matches', args('boss', 'boss_clear'), owner), /Unauthorized/);
  assert.equal(call('record_profession_matches', args('boss', 'boss_clear'), signer), true);
  assert.equal(call('record_profession_matches', args('boss', 'trial_clear'), signer), false);
  call('record_profession_matches', args('m2', 'match'), signer);
  assert.equal(license('armorer:aurora-v2'), false);
  call('record_profession_matches', args('m3', 'match'), signer);
  assert.equal(license('armorer:aurora-v2'), true);
  assert.equal(license('stylist:tide-v2'), false);
  call('record_profession_matches', args('trial', 'trial_clear'), signer);
  assert.equal(license('stylist:tide-v2'), true);
  assert.equal(call('get_profession_progress', { account_id: alice }).matches, 3);
});

test('Guild incentives use separate budgets and reject reuse across projects', async () => {
  const call = await fixture();
  const expiry = 101 * 86_400_000;
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  call('ft_on_transfer', { sender_id: owner, amount: '100', msg: '{"action":"fund_rewards"}' }, token);
  for (const [id,budget] of [['standard','40'],['guild-mission:beacon','25'],['guild-mission:other','25']]) {
    call('open_campaign',{campaign_id:id,budget,max_award:budget,closes_at_ms:expiry},owner);
  }
  call('set_settlement_enabled',{enabled:true},owner);
  const base = {version:1,network:'near-testnet',contractId:contract,signerEpoch:1,accountId:alice,
    matchId:'round-1',expiresAtMs:expiry,amountAtomic:'20',resultHash:'a'.repeat(64)};
  const mission = (project, overrides={}, actor=signer) => call('settle_guild_mission',{
    project_id:project,mode:'boss',payload:{...base,campaignId:'guild-mission:'+project,rulesVersion:'guild-mission-v1',
      operationId:'guild-mission:'+createHash('sha256').update(project+'/boss/'+alice).digest('hex'),...overrides},
  },actor);
  call('settle_result',{payload:{...base,campaignId:'standard',operationId:'standard-1',rulesVersion:'pilot-1'}},signer);
  assert.throws(()=>mission('beacon',{},alice),/Unauthorized|signer/i);
  const reward = mission('beacon');
  assert.equal(reward.amountAtomic,'20');
  assert.deepEqual(mission('beacon'),reward);
  assert.throws(()=>mission('beacon',{matchId:'round-2'}),/already settled/);
  assert.throws(()=>mission('other'),/already used/);
  assert.throws(()=>mission('other',{matchId:'round-3',amountAtomic:'26'}),/Invalid Guild award/);
  assert.equal(call('get_campaign',{campaign_id:'guild-mission:beacon'}).remaining,'5');
  assert.equal(call('get_campaign',{campaign_id:'standard'}).remaining,'20');
  assert.equal(call('get_ledger',{}).rewardReserved,'40');
});
