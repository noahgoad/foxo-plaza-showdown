import { createPublicKey, verify } from 'node:crypto';

export const SOCIAL_ISSUER = 'https://login.testnet.fast-auth.com/';
export const SOCIAL_CLIENT_ID = 'np8paqIpMWmNbzT4xAvOOapZBjsOpptl';

async function readIssuerKeys(issuer) {
  const response = await fetch(new URL('.well-known/jwks.json', issuer), {
    signal: AbortSignal.timeout(5000), redirect: 'error',
  });
  if (!response.ok) throw new Error('NEAR Auth signing keys are unavailable.');
  return response.json();
}

export function createSocialVerifier({ clientId = SOCIAL_CLIENT_ID, issuer = SOCIAL_ISSUER,
  now = Date.now, readKeys = () => readIssuerKeys(issuer) } = {}) {
  let cache;
  let fetching;
  async function getKeys() {
    if (cache?.expires > now()) return cache.keys;
    fetching ??= (async () => {
      const { keys } = await readKeys();
      if (!Array.isArray(keys) || keys.length > 16) throw new Error('Invalid NEAR Auth signing keys.');
      cache = { keys, expires: now() + 60_000 };
      return keys;
    })().finally(() => { fetching = null; });
    return fetching;
  }
  return async (credential, expectedNonce) => {
    try {
      if (typeof credential !== 'string' || credential.length > 12_000 ||
          !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(credential)) throw new Error();
      const [header, payload, signature] = credential.split('.');
      const { alg, kid } = JSON.parse(Buffer.from(header, 'base64url'));
      const { iss, sub, aud, azp, iat, exp, nbf, nonce } = JSON.parse(Buffer.from(payload, 'base64url'));
      const time = Math.floor(now() / 1000);
      const validAudience = aud === clientId || (Array.isArray(aud) && aud.includes(clientId) && azp === clientId);
      if (alg !== 'RS256' || typeof kid !== 'string' || iss !== issuer || !validAudience ||
          (azp !== undefined && azp !== clientId) || typeof sub !== 'string' || sub.length < 1 || sub.length > 256 ||
          !Number.isSafeInteger(iat) || !Number.isSafeInteger(exp) || iat > time + 30 || iat < time - 300 || exp <= time ||
          (nbf !== undefined && (!Number.isSafeInteger(nbf) || nbf > time)) ||
          (expectedNonce !== undefined && nonce !== expectedNonce)) throw new Error();
      const jwk = (await getKeys()).find(key => key.kid === kid && key.kty === 'RSA' && key.use === 'sig' && key.alg === 'RS256');
      if (!jwk || !verify('RSA-SHA256', Buffer.from(header + '.' + payload),
          createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(signature, 'base64url'))) throw new Error();
      return { issuer: iss, subject: sub, expires: exp * 1000 };
    } catch {
      throw new Error('Invalid or unavailable NEAR Auth credential.');
    }
  };
}

export function createNearSocialProvider({ clientId = SOCIAL_CLIENT_ID, issuer = SOCIAL_ISSUER, fetchImpl = fetch } = {}) {
  const provider = new URL(issuer);
  if (provider.protocol !== 'https:' || provider.href !== provider.origin + '/' ||
      issuer !== SOCIAL_ISSUER && clientId === SOCIAL_CLIENT_ID) throw Error('Use an HTTPS social issuer and its own client ID.');
  const verifyCredential = createSocialVerifier({ clientId, issuer: provider.href });
  return {
    origin: provider.origin,
    authorize({ state, nonce, verifier, redirectUri }) {
      const url = new URL('authorize', provider);
      url.search = new URLSearchParams({
        client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid',
        state, nonce, prompt: 'login', code_challenge_method: 'S256', code_challenge: verifier,
      });
      return url.href;
    },
    async exchange({ code, verifier, redirectUri, nonce }) {
      const response = await fetchImpl(new URL('oauth/token', provider), {
        method: 'POST', signal: AbortSignal.timeout(10_000), redirect: 'error',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code', client_id: clientId, code, code_verifier: verifier, redirect_uri: redirectUri,
        }),
      });
      if (!response.ok) throw new Error('NEAR Auth could not complete sign-in.');
      return verifyCredential((await response.json()).id_token, nonce);
    },
  };
}
