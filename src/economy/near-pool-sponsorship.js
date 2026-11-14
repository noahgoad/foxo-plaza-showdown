const RPC = 'https://near-testnet.drpc.org';

async function readRegistrationKey(account, publicKey) {
  const response = await fetch(RPC, {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(5_000),
    body: JSON.stringify({ jsonrpc: '2.0', id: 'pool-registration-key', method: 'query', params: {
      request_type: 'view_access_key', account_id: account, public_key: publicKey, finality: 'final',
    } }),
  });
  if (!response.ok) return null;
  return (await response.json()).result ?? null;
}

export async function sponsorPoolRegistration({ relay, session, wallet, account, receiverId, guard, inform }) {
  if (!session || !wallet.createPoolRegistrationSigner) return false;
  const request = async (action, data = {}) => {
    const response = await fetch(relay + '/near/gas/' + action, {
      method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(12_000),
      body: JSON.stringify({ nearSession: session, ...data }),
    });
    if (!response.ok) throw Error('Pool sponsorship could not be verified. Refresh the finalized position.');
    return response.json();
  };
  if (!(await request('availability').catch(() => null))?.enabled) return false;
  guard();
  const signer = wallet.createPoolRegistrationSigner(receiverId);
  inform('Review a temporary Pool registration key in Intear. This setup transaction uses Testnet NEAR.');
  await wallet.intear.signAndSendTransaction({ signerId: account, receiverId: account, actions: [signer.addKey] });
  guard();
  let key;
  for (let attempt = 0; attempt < 5; attempt++) {
    key = await readRegistrationKey(account, signer.publicKey).catch(() => null);
    if (key) break;
    await new Promise(resolve => setTimeout(resolve, 800));
    guard();
  }
  const permission = key?.permission?.FunctionCall;
  if (permission?.receiver_id !== receiverId || permission.method_names?.length !== 1 ||
      permission.method_names[0] !== 'register' || permission.allowance !== '1' ||
      !Number.isSafeInteger(key.nonce) || !Number.isSafeInteger(key.block_height)) {
    throw Error('Finalize the scoped Pool key before submitting registration.');
  }
  const delegate = await signer.sign(account, BigInt(key.nonce) + 1n, BigInt(key.block_height) + 25n);
  guard();
  inform('Submitting registration with sponsored gas.');
  let result;
  try { result = await request('submit', { delegate }); }
  catch { result = await request('submit', { delegate }); }
  if (result.status === 'FAILED') throw Error('Sponsored registration failed on Testnet. Refresh the Pool position.');
  if (result.status === 'REJECTED') throw Error('Sponsored registration expired before inclusion. Try again.');
  if (result.status !== 'FINALIZED') throw Error('Sponsored registration is pending. Use Refresh to check the Pool position.');
  return true;
}
