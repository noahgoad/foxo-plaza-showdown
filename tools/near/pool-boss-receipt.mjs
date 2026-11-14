import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { utils } from 'near-api-js';
import { preparePoolBossReceipt, verifyPoolBossReceipt } from '../../server/near/pool-boss-receipt.mjs';

const { values } = parseArgs({ options: {
  db: { type: 'string', default: 'outputs/near-economy.sqlite' },
  match: { type: 'string' },
  player: { type: 'string' },
  tx: { type: 'string' },
} });
if (!values.match || !values.player) throw new Error('Use --match <round ID> --player <account.testnet>.');
const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('config/economy-deployment-manifest.json', root), 'utf8'));
const pool = manifest.modules.find(row => row.name === 'pool');
const database = new DatabaseSync(values.db, { readOnly: true });
let request;
try {
  request = preparePoolBossReceipt({ database, matchId: values.match, player: values.player,
    poolId: pool.accountId, signerId: pool.init.receipt_signer_id });
} finally {
  database.close();
}
if (!values.tx) {
  console.log(JSON.stringify({ status: 'UNSIGNED', request }, null, 2));
} else {
  const rpc = async (method, params) => {
    const response = await fetch('https://near-testnet.drpc.org', { method: 'POST',
      headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(15000),
      body: JSON.stringify({ jsonrpc: '2.0', id: 'pool-boss-receipt', method, params }) });
    if (!response.ok) throw new Error('Testnet RPC HTTP ' + response.status);
    const value = await response.json();
    if (value.error || value.result === undefined) throw new Error('Testnet receipt read failed');
    return value.result;
  };
  const expectedCodeHash = utils.serialize.base_encode(createHash('sha256')
    .update(await readFile(new URL(pool.wasm, root))).digest());
  const proof = await verifyPoolBossReceipt({ rpc, request, transactionHash: values.tx, expectedCodeHash });
  console.log(JSON.stringify({ status: proof ? 'FINALIZED' : 'UNVERIFIED', proof }, null, 2));
  if (!proof) process.exitCode = 2;
}
