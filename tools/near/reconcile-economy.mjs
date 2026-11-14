import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseArgs } from 'node:util';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { createFinalizedTestnetBlockSource } from '../../server/near/finalized-block-source.mjs';
import { createEconomyIndexer } from '../../server/near/indexer.mjs';
import { createEconomyReadModels } from '../../server/near/read-models.mjs';
import { reconcileEconomy } from '../../server/near/reconciliation.mjs';
import { reconcileLedger } from './reconcile-ledger.mjs';

const { values } = parseArgs({ options: {
  start: { type: 'string' },
  limit: { type: 'string', default: '20' },
  db: { type: 'string', default: 'outputs/near-economy-index.sqlite' },
} });
const startHeight = Number(values.start);
const limit = Number(values.limit);
if (!Number.isSafeInteger(startHeight) || startHeight < 1 ||
    !Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
  throw new Error('Use --start <first indexed block height> and --limit 1–500.');
}
const root = new URL('../../', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('config/economy-deployment-manifest.json', root), 'utf8'));
const module = manifest.modules.find(row => row.name === 'economy');
const contractId = module.accountId;
const endpoint = new URL(process.env.NEAR_INDEX_RPC || 'https://near-testnet.drpc.org');
if (endpoint.protocol !== 'https:') throw new Error('The Testnet RPC must use HTTPS.');
const rpc = async (method, params) => {
  const response = await fetch(endpoint, { method: 'POST', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'economy-reconcile', method, params }) });
  if (!response.ok) throw new Error('Testnet RPC HTTP ' + response.status);
  const body = await response.json();
  if (body.error?.cause?.name === 'UNKNOWN_BLOCK' && method === 'block') return null;
  if (body.error || body.result === undefined) {
    throw Object.assign(new Error('Testnet RPC read failed'), { code: body.error?.cause?.name });
  }
  return body.result;
};
if ((await rpc('status', [])).chain_id !== 'testnet') throw new Error('Wrong RPC network');
const getFinalizedBlock = createFinalizedTestnetBlockSource({
  rpcOrigin: endpoint.href,
  archivalRpcOrigin: process.env.NEAR_INDEX_ARCHIVAL_RPC_URL,
  dataOrigin: process.env.NEAR_INDEX_DATA_URL,
  apiKey: process.env.NEAR_INDEX_FASTNEAR_API_KEY,
});
const viewAt = async (block, request) => {
  const value = await rpc('query', { account_id: contractId, block_id: block.hash, ...request });
  if (value.block_hash !== block.hash || value.block_height !== block.height) throw new Error('Finalized block mismatch');
  return value;
};
const callAt = async (block, method) => {
  const { result } = await viewAt(block, { request_type: 'call_function', method_name: method, args_base64: 'e30=' });
  if (!Array.isArray(result)) throw new Error('Invalid Testnet contract view');
  return JSON.parse(Buffer.from(result).toString());
};
const verifyAt = async block => {
  const { code_hash: code } = await viewAt(block, { request_type: 'view_account' });
  if (!economyDeployment.acceptedCodeHashes.includes(code)) throw new Error('Economy Wasm differs from the reviewed builds');
  const config = await callAt(block, 'get_config');
  if (config.network !== manifest.network || config.ownerId !== manifest.operatorId ||
      config.foxoContractId !== manifest.tokenId ||
      config.settlementSignerId !== (module.runtimeConfig?.settlementSignerId ?? module.init.settlement_signer_id)) {
    throw new Error('Economy configuration differs from the deployment manifest');
  }
};

const head = await getFinalizedBlock.getFinalizedHead();
try {
  await verifyAt(head);
} catch (error) {
  if (error.code !== 'UNKNOWN_ACCOUNT') throw error;
  console.log(JSON.stringify({ status: 'NOT_DEPLOYED', contractId, head, spendAuthorization: false }, null, 2));
  process.exit(2);
}
const path = resolve(values.db);
await mkdir(dirname(path), { recursive: true });
const database = new DatabaseSync(path);
try {
  const settings = { network: manifest.network, contractId, startHeight, getFinalizedBlock };
  const index = createEconomyIndexer(database, settings);
  const previous = database.prepare(`SELECT MIN(height) AS start FROM near_economy_index_blocks
    WHERE network=? AND contract_id=?`).get(settings.network, contractId);
  if (previous.start !== null && previous.start !== startHeight) throw new Error('Index start height changed');
  for (let i = 0; i < limit && (index.cursor()?.height ?? 0) < head.height; i++) {
    const result = await index.ingestNext(head);
    if (result.status === 'UNAVAILABLE') break;
  }
  const snapshot = createEconomyReadModels({ database, ...settings }).snapshot({ finalizedHead: head });
  const block = snapshot.cursor;
  const reconciliation = block?.hash === head.hash && block.height === head.height ? reconcileEconomy({
    snapshot, ledger: await callAt(block, 'get_ledger'), block,
  }) : null;
  const custody = reconciliation && await reconcileLedger({ economy: contractId, token: manifest.tokenId, rpc, block });
  console.log(JSON.stringify({ contractId, startHeight, head, snapshot, reconciliation, custody }, null, 2));
  if (reconciliation?.status === 'MISMATCH' || custody && ['DEFICIT', 'SURPLUS', 'UNKNOWN'].includes(custody.status)) {
    process.exitCode = 2;
  }
} finally {
  database.close();
}
