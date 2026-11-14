export const NETWORK = 'near-testnet';
export const FOXO_SCALE = 10n ** 24n;
export const MAX_ATOMIC = (1n << 128n) - 1n;

export function atomic(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,38})$/.test(value)) {
    throw new TypeError('Expected a canonical atomic amount');
  }
  const amount = BigInt(value);
  if (amount > MAX_ATOMIC) throw new RangeError('Atomic amount exceeds u128');
  return amount;
}

export function accountId(value) {
  if (typeof value !== 'string' || value.length < 2 || value.length > 64 ||
      !/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/.test(value)) {
    throw new TypeError('Invalid NEAR account ID');
  }
  return value;
}

export function nftIdentity(collectionId, tokenId) {
  if (typeof tokenId !== 'string' || tokenId.length === 0 || tokenId.length > 128) {
    throw new TypeError('Invalid NFT token ID');
  }
  return { collectionId: accountId(collectionId), tokenId };
}
