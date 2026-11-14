import assert from 'node:assert/strict';
import test from 'node:test';

const implementation = await import('./audit-state.mjs').catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/audit-state.mjs')) return {};
  throw error;
});
const { auditState = async () => ({}), compareCode = () => null } = implementation;
const claims = 'claim.xuancanh1.testnet';

test('an unavailable RPC yields UNKNOWN with a null value', async () => {
  const report = await auditState({ rpc: async () => { throw Error('private endpoint detail'); } });
  assert.deepEqual(report.block, { status: 'UNKNOWN', value: null, error: 'RPC_READ_FAILED' });
  assert.equal(report.reads.faucetAvailable.status, 'UNKNOWN');
  assert.doesNotMatch(JSON.stringify(report), /private endpoint detail/);
});

test('all contract calls are pinned read-only views and preserve 045–088', async () => {
  const calls = [];
  const values = { nft_available: 44, faucet_funded: '5', faucet_available: '4', ft_balance_of: '4' };
  const report = await auditState({ rpc: async (method, params) => {
    calls.push([method, params]);
    if (method === 'status') return { chain_id: 'testnet' };
    if (method === 'block') return { header: { hash: 'fixed-final-block', height: 123 } };
    if (params.request_type === 'view_account') return { block_hash: params.block_id, code_hash: 'hash' };
    const args = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    const value = params.method_name === 'nft_token'
      ? { token_id: args.token_id, owner_id: claims }
      : values[params.method_name] ?? null;
    return { block_hash: params.block_id, result: [...Buffer.from(JSON.stringify(value))] };
  } });
  assert.deepEqual(report.inventory.tokens.map(token => token.tokenId), Array.from({ length: 44 }, (_, index) => String(index + 45).padStart(3, '0')));
  assert.equal(report.inventory.reconciliation.status, 'MATCH');
  assert.ok(calls.every(([method, args]) => ['status', 'block', 'query'].includes(method) && (method !== 'query' || args.block_id === 'fixed-final-block')));
  assert.ok(calls.every(([, args]) => !args?.method_name || /^(nft_(token|metadata|total_supply|available|claim_status)|ft_(metadata|total_supply|balance_of)|storage_balance_(of|bounds)|faucet_(available|funded|next_claim_ms|claim_pending))$/.test(args.method_name)));
});

test('contract code comparison distinguishes missing bytes and mismatch', () => {
  assert.equal(compareCode('remote', 'local').status, 'MISMATCH');
  assert.equal(compareCode('identical', 'identical').status, 'MATCH');
  assert.equal(compareCode('remote', null).status, 'UNKNOWN');
});

test('non-testnet RPC is rejected before reading final block or contracts', async () => {
  const calls = [];
  const report = await auditState({ rpc: async method => { calls.push(method); return { chain_id: 'mainnet' }; } });
  assert.deepEqual(calls, ['status']);
  assert.equal(report.block.status, 'UNKNOWN');
  assert.equal(report.block.error, 'WRONG_NETWORK');
});
