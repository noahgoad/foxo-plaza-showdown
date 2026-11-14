import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { NearWalletAuth } from '../../server/near-wallet-auth.mjs';
import { createNearSocialProvider, createSocialVerifier, SOCIAL_ISSUER } from '../../server/near/social-verifier.mjs';

const origin = 'http://localhost:8817';
const clientId = 'fixture-client';
const now = 1_800_000_000_000;
const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'fixture', alg: 'RS256', use: 'sig' };
const encode = value => Buffer.from(JSON.stringify(value)).toString('base64url');
function jwt(changes = {}, header = { alg: 'RS256', kid: jwk.kid }) {
  const payload = encode({ iss: SOCIAL_ISSUER, sub: 'google-oauth2|123', aud: clientId,
    iat: now / 1000, exp: now / 1000 + 600, ...changes });
  const data = encode(header) + '.' + payload;
  return data + '.' + sign('RSA-SHA256', Buffer.from(data), privateKey).toString('base64url');
}
function verifier() {
  return createSocialVerifier({ clientId, now: () => now, readKeys: async () => ({ keys: [jwk] }) });
}
test('social login is off by default and a valid identity has a stable, practice-only profile', async () => {
  await assert.rejects(new NearWalletAuth({ origins: [origin] }).handle('social-start', {}, origin), /unavailable/);
  let credential = jwt();
  const auth = new NearWalletAuth({ origins: [origin], now: () => now, socialOrigins: [origin], socialProvider: {
    authorize: () => 'https://login.testnet.fast-auth.com/authorize',
    exchange: async () => verifier()(credential),
  } });
  const key = 'a'.repeat(64);
  const start = () => auth.handle('social-start', { key }, origin);
  const finish = state => auth.handle('social-login', { state, code: 'code', key }, origin);
  await assert.rejects(auth.handle('social-start', { key }, 'https://other.invalid'), /origin/);
  const { state } = await start();
  await assert.rejects(auth.handle('social-login', { state, code: 'code', key: 'b'.repeat(64) }, origin), /challenge/);
  const first = await finish(state);
  assert.match(first.profileId, /^social:[a-f0-9]{64}$/);
  assert.throws(() => auth.account(first.token, origin), /wallet/i);
  assert.deepEqual(await auth.handle('social-session', { token: first.token }, origin),
    { profileId: first.profileId, expires: first.expires });
  await assert.rejects(finish(state), /challenge/);
  await auth.handle('social-logout', { token: first.token }, origin);
  await assert.rejects(auth.handle('social-session', { token: first.token }, origin), /session/);
  await assert.rejects(auth.handle('social-logout', { token: first.token }, origin), /session/);
  const recovered = await finish((await start()).state);
  assert.equal(recovered.profileId, first.profileId);
  credential = jwt({ sub: 'auth0|123' });
  const other = await finish((await start()).state);
  assert.notEqual(other.profileId, first.profileId);
});
test('social identity rejects an untrusted issuer, audience, stale token and unsigned claims', async () => {
  const verify = verifier();
  for (const token of [
    jwt({ iss: 'https://other.invalid/' }), jwt({ aud: 'other' }),
    jwt({ exp: now / 1000 - 1 }), jwt({ iat: now / 1000 - 400 }),
    jwt({}, { alg: 'none', kid: jwk.kid }),
    jwt().split('.').slice(0, 2).join('.') + '.AAAA',
  ]) await assert.rejects(verify(token), /credential/i);
});

test('an app-specific social issuer is pinned for authorization and token verification', async () => {
  const issuer = 'https://fox-auth.example/';
  assert.throws(() => createNearSocialProvider({ issuer }), /own client ID/);
  const provider = createNearSocialProvider({ issuer, clientId });
  const auth = new NearWalletAuth({ origins: [origin], socialOrigins: [origin], socialProvider: provider });
  assert.deepEqual(await auth.handle('social-status', {}, origin), { enabled: true, issuerOrigin: 'https://fox-auth.example' });
  const { url } = await auth.handle('social-start', { key: 'a'.repeat(64) }, origin);
  const authorize = new URL(url);
  assert.equal(authorize.origin, 'https://fox-auth.example');
  assert.equal(authorize.searchParams.get('redirect_uri'), origin);
  assert.equal(authorize.searchParams.get('client_id'), clientId);
  const verify = createSocialVerifier({ clientId, issuer, now: () => now, readKeys: async () => ({ keys: [jwk] }) });
  await assert.rejects(verify(jwt()), /credential/i);
  assert.equal((await verify(jwt({ iss: issuer }))).issuer, issuer);
});
