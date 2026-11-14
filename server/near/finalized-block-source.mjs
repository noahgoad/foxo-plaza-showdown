const DATA_ORIGIN = 'https://testnet.neardata.xyz';
const RPC_ORIGIN = 'https://near-testnet.drpc.org';
const ARCHIVAL_RPC_ORIGIN = 'https://archival-rpc.testnet.near.org';
const hashPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const validHeight = value => Number.isSafeInteger(value) && value >= 0;
const validHash = value => typeof value === 'string' && hashPattern.test(value);

function verify(condition, reason) {
  if (!condition) throw new Error(`Finalized Testnet block source: ${reason}`);
}

function readHeader(block) {
  const header = block?.header;
  verify(validHeight(header?.height) && validHeight(header?.prev_height) &&
    header.prev_height < header.height && validHash(header.hash) && validHash(header.prev_hash),
  'invalid block header');
  return header;
}

function chunkMap(chunks, height) {
  verify(Array.isArray(chunks) && chunks.length > 0, 'missing chunk headers');
  const byShard = new Map();
  for (const chunk of chunks) {
    verify(validHeight(chunk?.shard_id) && validHash(chunk.chunk_hash) &&
      validHeight(chunk.height_included) && chunk.height_included <= height &&
      !byShard.has(chunk.shard_id), 'invalid or duplicate chunk header');
    byShard.set(chunk.shard_id, chunk);
  }
  return byShard;
}

function sameChunk(left, right) {
  return left?.shard_id === right.shard_id && left.chunk_hash === right.chunk_hash &&
    left.height_included === right.height_included;
}

function collectReceipts(document, canonical) {
  const header = readHeader(canonical);
  const source = readHeader(document?.block);
  verify(source.height === header.height && source.hash === header.hash &&
    source.prev_height === header.prev_height && source.prev_hash === header.prev_hash,
  'data provider header disagrees with canonical RPC');
  const chunks = chunkMap(canonical.chunks, header.height);
  const sourceChunks = chunkMap(document.block.chunks, header.height);
  verify(sourceChunks.size === chunks.size && Array.isArray(document.shards) &&
    document.shards.length === chunks.size, 'incomplete shard set');
  const shards = new Set();
  const receipts = new Map();
  for (const shard of document.shards) {
    const chunk = chunks.get(shard?.shard_id);
    verify(chunk && !shards.has(shard.shard_id) && sameChunk(sourceChunks.get(shard.shard_id), chunk),
      'unexpected, duplicate or inconsistent shard');
    shards.add(shard.shard_id);
    const rows = shard.receipt_execution_outcomes;
    verify(Array.isArray(rows) && Array.isArray(shard.state_changes), 'missing shard outcome data');
    if (chunk.height_included === header.height) {
      verify(sameChunk(shard.chunk?.header, chunk) && Array.isArray(shard.chunk?.receipts) &&
        Array.isArray(shard.chunk?.transactions), 'missing included chunk data');
    } else {
      verify(shard.chunk === null && rows.length === 0, 'invalid carried chunk data');
    }
    for (const row of rows) {
      const entry = row?.execution_outcome;
      const { id, block_hash: outcomeBlock, outcome } = entry ?? {};
      const { executor_id: executorId, logs, status } = outcome ?? {};
      verify(validHash(id) && outcomeBlock === header.hash && typeof executorId === 'string' &&
        accountPattern.test(executorId) && Array.isArray(logs) && logs.every(line => typeof line === 'string') &&
        !receipts.has(id), 'invalid or duplicate receipt outcome');
      if (row.receipt?.receipt_id !== undefined) {
        verify(row.receipt.receipt_id === id && row.receipt.receiver_id === executorId,
          'receipt metadata disagrees with outcome');
      }
      const variant = status && typeof status === 'object' && Object.keys(status);
      const success = variant?.length === 1 && (typeof status.SuccessValue === 'string' ||
        validHash(status.SuccessReceiptId));
      const failure = variant?.length === 1 && status.Failure !== null && typeof status.Failure === 'object';
      verify(success || failure, 'unknown receipt execution status');
      receipts.set(id, { receiptId: id, executorId, success: Boolean(success), logs });
    }
  }
  return [...receipts.values()];
}

/** FastNear supplies receipt outcomes, and a separate NEAR RPC binds the block to the final chain. */
export function createFinalizedTestnetBlockSource({ fetcher = fetch, rpc: customRpc, apiKey, rpcOrigin = RPC_ORIGIN, archivalRpcOrigin = ARCHIVAL_RPC_ORIGIN, dataOrigin = DATA_ORIGIN, maxGap = 32, timeoutMs = 15_000 } = {}) {
  verify(Number.isSafeInteger(maxGap) && maxGap > 0 && Number.isSafeInteger(timeoutMs) && timeoutMs > 0,
    'invalid provider limits');

  const dataUrl = new URL(dataOrigin);
  const rpcUrl = new URL(rpcOrigin);
  const archivalRpcUrl = new URL(archivalRpcOrigin);
  verify([dataUrl, rpcUrl, archivalRpcUrl].every(url => url.protocol === 'https:' && !url.username && !url.password),
    'provider URLs must use HTTPS without embedded credentials');

  async function request(url, options, allowUnknownBlock = false) {
    const response = await fetcher(url, { ...options, redirect: 'manual', signal: AbortSignal.timeout(timeoutMs) });
    if ([301, 302, 307, 308].includes(response.status) && !options?.method) {
      const location = response.headers?.get('location');
      verify(location, 'missing data redirect');
      const target = new URL(location, url);
      verify(target.protocol === 'https:' && !target.username && !target.password, 'invalid data redirect');
      if (target.origin !== dataUrl.origin) {
        verify(!target.searchParams.has('apiKey'), 'credential in cross-origin data redirect');
      } else if (apiKey) target.searchParams.set('apiKey', apiKey);
      return request(target.href, { method: 'GET' });
    }
    if (!response.ok) {
      if (allowUnknownBlock && response.status === 422) {
        const reply = await response.json().catch(() => null);
        if (reply?.error?.cause?.name === 'UNKNOWN_BLOCK') return reply;
      }
      const error = new Error(`Finalized Testnet block source: ${new URL(url).hostname} HTTP ${response.status}`);
      error.status = response.status;
      const retry = response.headers?.get('retry-after');
      if (retry) error.retryAfterMs = /^\d+$/.test(retry) ? Number(retry) * 1000 : Date.parse(retry) - Date.now();
      throw error;
    }
    return response.json();
  }

  async function defaultRpc(method, params) {
    const historicalBlock = method === 'block' && params.block_id !== undefined;
    const reply = await request(historicalBlock ? archivalRpcUrl.href : rpcUrl.href, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 'finalized-block-source', method, params }),
    }, historicalBlock);
    if (historicalBlock && reply?.error?.cause?.name === 'UNKNOWN_BLOCK') return null;
    verify(reply && !reply.error && reply.result, 'canonical RPC unavailable');
    return reply.result;
  }

  const rpc = customRpc ?? defaultRpc;
  async function getFinalizedHead() {
    const header = readHeader(await rpc('block', { finality: 'final' }));
    return { height: header.height, hash: header.hash };
  }

  async function getFinalizedBlock(cursor, startHeight, knownHead) {
    verify(cursor ? validHeight(cursor.height) && validHash(cursor.hash) : validHeight(startHeight),
      'invalid checkpoint');
    const start = cursor ? cursor.height + 1 : startHeight;
    const head = knownHead ?? await getFinalizedHead();
    if (start > head.height) return null;
    const end = cursor ? Math.min(head.height, start + maxGap - 1) : start;
    for (let height = start; height <= end; height += 1) {
      const canonical = await rpc('block', { block_id: height });
      if (canonical === null) continue;
      const header = readHeader(canonical);
      verify(header.height === height && (height < head.height || header.hash === head.hash),
        'canonical RPC returned a different block');
      if (cursor) verify(header.prev_height === cursor.height && header.prev_hash === cursor.hash,
        'canonical block does not directly extend checkpoint');
      const outcomeUrl = new URL('v0/block/' + height, dataUrl.href.replace(/\/$/, '') + '/');
      if (apiKey) outcomeUrl.searchParams.set('apiKey', apiKey);
      const document = await request(outcomeUrl.href);
      verify(document, 'finalized outcome document unavailable');
      return { finality: 'final', height, hash: header.hash, previousHash: header.prev_hash,
        receipts: collectReceipts(document, canonical) };
    }
    throw new Error('Finalized Testnet block source: block unavailable within configured height window');
  }

  return Object.assign(getFinalizedBlock, { getFinalizedHead });
}
