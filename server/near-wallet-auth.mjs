import { createHash, createPublicKey, randomBytes, verify } from 'node:crypto';

const base58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const accountPattern = /^(?=.{2,64}$)[a-z0-9]+(?:[._-][a-z0-9]+)*$/;
const fullAccessKeyPrefix = Buffer.from('302a300506032b6570032100', 'hex');
const challengeLifetime = 5 * 60 * 1000;
const sessionLifetime = 12 * 60 * 60 * 1000;

function keyBytes(publicKey) {
  const match = /^ed25519:([1-9A-HJ-NP-Za-km-z]{32,44})$/.exec(publicKey);
  if (!match) throw new Error('Select an Ed25519 wallet key.');
  let number = 0n;
  for (const char of match[1]) number = number * 58n + BigInt(base58.indexOf(char));
  const hex = number.toString(16);
  const decoded = number === 0n ? Buffer.alloc(0) : Buffer.from(hex.padStart(hex.length + hex.length % 2, '0'), 'hex');
  const leadingZeros = match[1].match(/^1*/)[0].length;
  if (decoded.length + leadingZeros !== 32) throw new Error('Invalid wallet public key.');
  return Buffer.concat([Buffer.alloc(leadingZeros), decoded]);
}

function borshText(text) {
  const bytes = Buffer.from(text, 'utf8');
  const size = Buffer.alloc(4);
  size.writeUInt32LE(bytes.length);
  return Buffer.concat([size, bytes]);
}

export function nearMessageDigest({ message, nonce, recipient }) {
  const tag = Buffer.alloc(4);
  tag.writeUInt32LE(2 ** 31 + 413);
  return createHash('sha256').update(Buffer.concat([
    tag, borshText(message), Buffer.from(nonce, 'base64'), borshText(recipient), Buffer.of(0),
  ])).digest();
}

async function accessKey(account_id, public_key) {
  const response = await fetch('https://near-testnet.drpc.org', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 'near-auth', method: 'query',
      params: { request_type: 'view_access_key', finality: 'final', account_id, public_key } }),
    signal: AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error('NEAR Testnet RPC is unavailable.');
  return (await response.json()).result;
}

export async function verifyNearMessage(challenge, proof, readKey = accessKey) {
  const { accountId, publicKey, signature } = proof;
  if (accountId !== challenge.accountId || typeof signature !== 'string' ||
      !/^[A-Za-z0-9+/]{86}==$/.test(signature)) throw new Error('Invalid wallet signature.');
  const key = createPublicKey({ key: Buffer.concat([fullAccessKeyPrefix, keyBytes(publicKey)]), format: 'der', type: 'spki' });
  if (!verify(null, nearMessageDigest(challenge), key, Buffer.from(signature, 'base64'))) throw new Error('Invalid wallet signature.');
  if ((await readKey(accountId, publicKey))?.permission !== 'FullAccess') throw new Error('The signing key does not belong to this Testnet account.');
}

export class NearWalletAuth {
  constructor({ origins = ['http://127.0.0.1:8817', 'http://localhost:8817'], now = Date.now, readKey = accessKey,
    socialOrigins = [], socialProvider, provisionSocialWallet } = {}) {
    this.origins = new Set(origins);
    this.now = now;
    this.readKey = readKey;
    this.challenges = new Map();
    this.sessions = new Map();
    this.socialOrigins = new Set(socialOrigins);
    this.socialProvider = socialProvider;
    this.provisionSocialWallet = provisionSocialWallet;
    this.socialChallenges = new Map();
    this.socialSessions = new Map();
  }

  trim(entries) {
    for (const [id, entry] of entries) if (entry.expires <= this.now()) entries.delete(id);
    if (entries.size >= 10_000) throw new Error('Sign-in service is busy.');
  }

  async handle(action, body, origin) {
    if (!this.origins.has(origin)) throw new Error('Game origin is not allowed.');
    if (action.startsWith('social-')) return this.handleSocial(action, body, origin);
    if (action === 'challenge') {
      const { accountId } = body;
      if (typeof accountId !== 'string' || !accountPattern.test(accountId)) throw new Error('Invalid NEAR account ID.');
      this.trim(this.challenges);
      const nonce = randomBytes(32).toString('base64');
      const recipient = new URL(origin).host;
      const message = 'Sign in to NEAR Fox on NEAR Testnet as ' + accountId + '.';
      const challenge = { message, nonce, recipient };
      this.challenges.set(nonce, { ...challenge, accountId, origin, expires: this.now() + challengeLifetime });
      return challenge;
    }
    if (action === 'login') {
      const { nonce, accountId, publicKey, signature } = body;
      const challenge = this.challenges.get(nonce);
      if (!challenge || challenge.origin !== origin || challenge.accountId !== accountId || challenge.expires <= this.now()) {
        throw new Error('Sign-in challenge is invalid or expired.');
      }
      this.challenges.delete(nonce);
      await verifyNearMessage(challenge, { accountId, publicKey, signature }, this.readKey);
      this.trim(this.sessions);
      const token = randomBytes(32).toString('hex');
      const expires = this.now() + sessionLifetime;
      this.sessions.set(token, { accountId, origin, expires });
      return { token, accountId, expires };
    }
    if (action === 'logout') {
      this.account(body.token, origin);
      this.sessions.delete(body.token);
      return { ok: true };
    }
    throw new Error('Unknown NEAR sign-in action.');
  }

  async handleSocial(action, body, origin) {
    if (!this.socialProvider || !this.socialOrigins.has(origin)) throw new Error('Social sign-in is unavailable.');
    if (action === 'social-status') return { enabled: true, issuerOrigin: this.socialProvider.origin };
    if (action === 'social-start') {
      if (typeof body.key !== 'string' || !/^[a-f0-9]{64}$/.test(body.key)) throw new Error('Invalid social sign-in key.');
      this.trim(this.socialChallenges);
      const state = randomBytes(32).toString('hex');
      const nonce = randomBytes(32).toString('hex');
      const verifier = randomBytes(32).toString('base64url');
      const redirectUri = origin;
      const url = this.socialProvider.authorize({ state, nonce, redirectUri,
        verifier: createHash('sha256').update(verifier).digest('base64url') });
      this.socialChallenges.set(state, { origin, key: body.key, nonce, verifier, redirectUri,
        expires: this.now() + challengeLifetime });
      return { state, url };
    }
    if (action === 'social-login') {
      const { state, code, key } = body;
      const challenge = this.socialChallenges.get(state);
      if (!challenge || challenge.origin !== origin || key !== challenge.key || challenge.expires <= this.now() ||
          typeof code !== 'string' || code.length < 1 || code.length > 2048) throw new Error('Invalid social sign-in challenge.');
      this.socialChallenges.delete(state);
      const { issuer, subject, expires: validUntil } = await this.socialProvider.exchange({ ...challenge, code });
      if (validUntil <= this.now()) throw new Error('Social credential expired.');
      this.trim(this.socialSessions);
      const token = randomBytes(32).toString('hex');
      const expires = this.now() + sessionLifetime;
      const profileId = 'social:' + createHash('sha256').update(JSON.stringify([issuer, subject])).digest('hex');
      let wallet;
      if (this.provisionSocialWallet) {
        try { wallet = await this.provisionSocialWallet({ issuer, subject }); }
        catch { wallet = { unavailable: true }; }
      }
      this.socialSessions.set(token, { profileId, origin, expires, wallet });
      return { token, profileId, expires, ...(wallet && { wallet }) };
    }
    if (action === 'social-session' || action === 'social-logout') {
      const session = this.socialSessions.get(body.token);
      if (session?.origin !== origin || session.expires <= this.now()) throw new Error('Invalid social session.');
      if (action === 'social-session') return { profileId: session.profileId, expires: session.expires, ...(session.wallet && { wallet: session.wallet }) };
      this.socialSessions.delete(body.token);
      return { ok: true };
    }
    throw new Error('Unknown social sign-in action.');
  }

  account(token, origin) {
    const session = this.sessions.get(token);
    if (!session || session.origin !== origin || session.expires <= this.now()) throw new Error('Verify your NEAR wallet again.');
    return session.accountId;
  }
}
