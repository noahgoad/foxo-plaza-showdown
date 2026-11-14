import { createHash } from 'node:crypto';
import { testnetRequest } from './testnet-rpc.mjs';
import { SOCIAL_ISSUER } from './social-verifier.mjs';

const relayer = 'https://fast-auth-staging.aws.peersyst.tech/api/relayer/fast-auth';

async function query(params) {
  const response = await testnetRequest('query', { ...params, finality: 'final' });
  if (!response.ok) throw Error('NEAR Testnet RPC is unavailable.');
  const { result, error } = await response.json();
  if (result) return result;
  if (['UNKNOWN_ACCOUNT', 'UNKNOWN_ACCESS_KEY'].includes(error?.cause?.name)) return null;
  throw Error('NEAR Testnet could not verify the social wallet.');
}

export function createSocialWalletProvisioner({
  read = query,
  request = (body) => fetch(relayer + '/create-account', {
    method: 'POST', redirect: 'error', headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(12000),
  }),
} = {}) {
  const pending = new Map();
  return async function provision({ issuer, subject }) {
    if (issuer !== SOCIAL_ISSUER) throw Error('Wallet creation is unavailable for this social provider.');
    const suffix = createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex').slice(0, 40);
    const accountId = 'fox-' + suffix + '.testnet';
    if (pending.has(accountId)) return pending.get(accountId);
    const setup = (async () => {
      const derived = await read({ request_type: 'call_function', account_id: 'v1.signer-prod.testnet',
        method_name: 'derived_public_key', args_base64: Buffer.from(JSON.stringify({
          path: 'jwt#' + issuer + '#' + subject, predecessor: 'fast-auth.testnet', domain_id: 1,
        })).toString('base64') });
      const publicKey = JSON.parse(Buffer.from(derived.result).toString());
      if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(publicKey)) throw Error('Invalid NEAR Auth public key.');
      const check = () => read({ request_type: 'view_access_key', account_id: accountId, public_key: publicKey });
      let access = await check();
      if (!access) {
        if (await read({ request_type: 'view_account', account_id: accountId })) {
          throw Error('The account already exists with a different key.');
        }
        try {
          const response = await request({ accountId, publicKey });
          if (!response.ok) throw Error('Wallet creation rejected.');
        } catch { /* The request may have landed even if its response was lost. */ }
        for (let attempt = 0; attempt < 5 && !access; attempt++) {
          access = await check();
          if (!access && attempt < 4) await new Promise(resolve => setTimeout(resolve, 500));
        }
      }
      if (access?.permission !== 'FullAccess') throw Error('Wallet creation could not be confirmed. Sign in again to retry.');
      return { accountId };
    })().finally(() => pending.delete(accountId));
    pending.set(accountId, setup);
    return setup;
  };
}
