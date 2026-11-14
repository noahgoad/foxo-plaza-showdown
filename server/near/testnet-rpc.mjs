const endpoints = ['https://near-testnet.drpc.org', 'https://rpc.testnet.fastnear.com'];
const readMethods = new Set(['status', 'block', 'query', 'tx', 'EXPERIMENTAL_protocol_config']);

export async function testnetRequest(method, params, { id = 'fox-testnet', timeoutMs = 12_000, endpoint } = {}) {
  let failure;
  const primary = endpoint ?? endpoints[0];
  const candidates = readMethods.has(method) ? [...new Set([primary, ...endpoints])] : [primary];
  for (const url of candidates) {
    try {
      const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }), signal: AbortSignal.timeout(timeoutMs) });
      if (response.status === 429 || response.status >= 500) {
        failure = Error('Testnet RPC HTTP ' + response.status);
        continue;
      }
      return response;
    } catch (error) { failure = error; }
  }
  throw failure;
}
