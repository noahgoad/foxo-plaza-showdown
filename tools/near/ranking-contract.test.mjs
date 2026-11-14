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

export async function fixture(logs = []) {
  const module = await WebAssembly.compile(await readFile(wasm));
  const registers = new Map();
  let storage = new Map();
  let nowMs = 100 * 86_400_000; let input, result, predecessor, transactionSigner, deposit, instance, transferSucceeded;
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
    block_timestamp: () => BigInt(nowMs) * 1_000_000n,
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
  const call = (method, args, caller = alice, attached = 0n, signedBy = caller, receiptSucceeded = false) => {
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
  call.setTime = value => { nowMs = value; };
  return call;
}

const DAY = 86_400_000;
const SCALE = 10n ** 24n;
const start = 100 * DAY;
async function setup() {
  const call = await fixture();
  call('new', { owner_id: owner, foxo_contract_id: token, network: 'near-testnet', settlement_signer_id: signer }, contract);
  call('ft_on_transfer', { sender_id: owner, amount: String(2000n*SCALE), msg:'{"action":"fund_rewards"}' }, token);
  call('set_settlement_enabled', { enabled:true }, owner);
  call('open_ranking_campaign', { campaign_id:'rank-hunt', mode:'hunt', season_start_ms:start }, owner);
  return call;
}
function draft(overrides = {}) {
  const budget = 1000n*SCALE/28n + 1n;
  const amount = budget / 10n;
  const value = { version:1, campaignId:'rank-hunt', seasonStartMs:start, budgetDay:'1970-04-11',
    rubricVersion:'hunt-v1', evidenceHash:'a'.repeat(64), mode:'hunt', dayIndex:0,
    budgetAtomic:String(budget), totalScoreAtomic:'1000000',
    allocations:[{accountId:alice, scoreAtomic:'1000000', amountAtomic:String(amount)}],
    awardedAtomic:String(amount), unallocatedAtomic:String(budget-amount), ...overrides };
  const draft_json = JSON.stringify(value);
  return { draft_json, draft_hash:createHash('sha256').update('fox-ranking-draft/v1\0').update(draft_json).digest('hex') };
}
test('ranking draft requires signer, completed day, review delay and explicit owner publication', async () => {
  const call = await setup();
  const args = draft();
  assert.throws(() => call('propose_ranking_draft', args, signer), /still open/);
  call.setTime(start+DAY);
  assert.throws(() => call('propose_ranking_draft', args, alice), /Unauthorized/);
  const record = call('propose_ranking_draft', args, signer);
  assert.equal(record.reviewAfterMs, start+2*DAY);
  assert.deepEqual(call('propose_ranking_draft', args, signer), record);
  const publish = { campaign_id:'rank-hunt', day_index:0, draft_hash:args.draft_hash };
  assert.throws(() => call('publish_ranking_draft', publish, signer), /Only owner/);
  assert.throws(() => call('publish_ranking_draft', publish, owner), /review/);
  const operation_id = call('get_ranking_allocation_id', { campaign_id:'rank-hunt', day_index:0, account_id:alice });
  const finalize = {campaign_id:'rank-hunt',day_index:0,account_id:alice};
  assert.equal(call('get_entitlement', {operation_id}), null);
  assert.throws(() => call('finalize_ranking_allocation', finalize, signer), /not published/);
  call.setTime(start+2*DAY);
  call('publish_ranking_draft', publish, owner);
  const ledger = call('get_ledger', {});
  const liability = call('get_ranking_liabilities', {});
  assert.equal(liability.unmaterializedAtomic, JSON.parse(args.draft_json).awardedAtomic);
  call('publish_ranking_draft', publish, owner);
  assert.deepEqual(call('get_ledger', {}), ledger);
  assert.deepEqual(call('get_ranking_liabilities', {}), liability);
  assert.equal(call('get_entitlement', {operation_id}), null);
  call('finalize_ranking_allocation', finalize, signer);
  call('finalize_ranking_allocation', finalize, signer);
  assert.deepEqual(call('get_ledger', {}), ledger);
  assert.equal(call('get_ranking_liabilities', {}).unmaterializedAtomic, '0');
  assert.equal(call('get_entitlement', {operation_id}).amountAtomic, JSON.parse(args.draft_json).awardedAtomic);
  call('close_campaign', {campaign_id:'rank-hunt'}, owner);
  assert.equal(call('get_ledger', {}).rewardReserved, ledger.rewardReserved);
  call('claim', {operation_id}, alice, 1n);
  assert.equal(call('finish_claim', {operation_id,attempt:1}, contract), false);
  assert.equal(call('get_entitlement', {operation_id}).status, 'reserved');
});

test('ranking rejects provenance, mode, remainder, duplicate account and inflated allocations', async () => {
  const call = await setup();
  call.setTime(start+DAY);
  const valid = JSON.parse(draft().draft_json);
  for (const [override, error] of [
    [{mode:'boss'}, /Wrong ranking mode/], [{seasonStartMs:start-DAY}, /season/],
    [{dayIndex:28}, /day/], [{budgetDay:'1970-04-10'}, /budget day/],
    [{budgetAtomic:String(BigInt(valid.budgetAtomic)-1n)}, /daily ranking budget/],
    [{rubricVersion:''}, /provenance/], [{evidenceHash:'broken'}, /provenance/],
    [{totalScoreAtomic:'1'}, /total ranking score/],
    [{allocations:[...valid.allocations,...valid.allocations]}, /Duplicate/],
    [{allocations:[{...valid.allocations[0],scoreAtomic:'1000001'}]}, /normalized/],
    [{allocations:[{...valid.allocations[0],amountAtomic:String(7n*SCALE)}]}, /amount or cap/],
    [{awardedAtomic:'0'}, /allocation sum/], [{unallocatedAtomic:'0'}, /allocation sum/],
  ]) assert.throws(() => call('propose_ranking_draft', draft(override), signer), error);
  assert.throws(() => call('propose_ranking_draft', {...draft(), draft_hash:'f'.repeat(64)}, signer), /hash mismatch/);
  call('propose_ranking_draft', draft(), signer);
  assert.throws(() => call('propose_ranking_draft', draft({evidenceHash:'b'.repeat(64)}), signer), /Conflicting/);
});

test('ranking and fixed budgets remain separate and generic settlement cannot bypass review', async () => {
  const call = await setup();
  assert.throws(() => call('open_ranking_campaign', {campaign_id:'another',mode:'hunt',season_start_ms:start}, owner), /already funded/);
  assert.throws(() => call('open_ranking_campaign', {campaign_id:'cross-mode',mode:'all',season_start_ms:start}, owner), /Unknown ranking mode/);
  assert.equal(call('get_campaign', {campaign_id:'rank-hunt'}).remaining, String(1000n*SCALE));
  assert.equal(call('get_ledger', {}).rewardAvailable, String(1000n*SCALE));
  const payload = { version:1, network:'near-testnet', contractId:contract, signerEpoch:1,
    operationId:'bypass',campaignId:'rank-hunt',accountId:alice,matchId:'fake',rulesVersion:'v1',
    expiresAtMs:start+DAY,amountAtomic:'1',resultHash:'a'.repeat(64) };
  assert.throws(() => call('settle_result', {payload}, signer), /reviewed ranking/);
  call.setTime(start+DAY);
  const args = draft();
  call('propose_ranking_draft', args, signer);
  call('close_campaign', {campaign_id:'rank-hunt'}, owner);
  call.setTime(start+2*DAY);
  assert.throws(() => call('publish_ranking_draft', {campaign_id:'rank-hunt',day_index:0,draft_hash:args.draft_hash}, owner), /Campaign closed/);
});

test('zero-player publication is immutable and creates no entitlement or reservation', async () => {
  const call = await setup();
  call.setTime(start+DAY);
  const args = draft({allocations:[],totalScoreAtomic:'0',awardedAtomic:'0',unallocatedAtomic:JSON.parse(draft().draft_json).budgetAtomic});
  call('propose_ranking_draft', args, signer);
  call.setTime(start+2*DAY);
  const publication = {campaign_id:'rank-hunt',day_index:0,draft_hash:args.draft_hash};
  call('publish_ranking_draft', publication, owner);
  call('set_settlement_enabled', {enabled:false}, owner);
  assert.ok(call('publish_ranking_draft', publication, owner).publishedAtMs);
  assert.equal(call('get_ledger', {}).rewardReserved, '0');
});

test('one thousand allocations sum exactly, stay below daily cap and cannot be funded twice', async () => {
  const call = await setup();
  const budget = BigInt(JSON.parse(draft().draft_json).budgetAtomic);
  const allocations = Array.from({length:1000}, (_,i) => ({accountId:`player${String(i).padStart(4,'0')}.testnet`,scoreAtomic:'1000000',amountAtomic:String(budget/1000n)}));
  const awarded = (budget/1000n)*1000n;
  const args = draft({allocations,totalScoreAtomic:'1000000000',awardedAtomic:String(awarded),unallocatedAtomic:String(budget-awarded)});
  call.setTime(start+DAY);
  call('propose_ranking_draft', args, signer);
  call.setTime(start+2*DAY);
  const publication = {campaign_id:'rank-hunt',day_index:0,draft_hash:args.draft_hash};
  call('publish_ranking_draft', publication, owner);
  call('publish_ranking_draft', publication, owner);
  assert.equal(call('get_ledger', {}).rewardReserved, String(awarded));
  call('finalize_ranking_allocation', {campaign_id:'rank-hunt',day_index:0,account_id:allocations[999].accountId}, signer);
  const operation_id = call('get_ranking_allocation_id', {campaign_id:'rank-hunt',day_index:0,account_id:allocations[999].accountId});
  assert.equal(call('get_entitlement', {operation_id}).amountAtomic, allocations[999].amountAtomic);
});

test('overlapping mode seasons cannot allocate a second daily pool', async () => {
  const call = await setup();
  const ledger = call('get_ledger', {});
  assert.throws(() => call('open_ranking_campaign', {campaign_id:'overlap',mode:'hunt',season_start_ms:start-DAY}, owner), /overlap/);
  assert.deepEqual(call('get_ledger', {}), ledger);
});

test('last day remainder and review can finalize after the season end without reallocating dust', async () => {
  const call = await setup();
  const budget = 1000n*SCALE/28n;
  const amount = budget/10n;
  const args = draft({dayIndex:27,budgetDay:'1970-05-08',budgetAtomic:String(budget),
    allocations:[{accountId:alice,scoreAtomic:'1000000',amountAtomic:String(amount)}],
    awardedAtomic:String(amount),unallocatedAtomic:String(budget-amount)});
  call.setTime(start+28*DAY);
  call('propose_ranking_draft', args, signer);
  call.setTime(start+29*DAY);
  call('publish_ranking_draft', {campaign_id:'rank-hunt',day_index:27,draft_hash:args.draft_hash}, owner);
  assert.equal(call('get_campaign', {campaign_id:'rank-hunt'}).remaining, String(1000n*SCALE-amount));
});


