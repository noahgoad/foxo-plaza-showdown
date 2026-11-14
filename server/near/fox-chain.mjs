import { accountId, nftIdentity } from '../../src/economy/schema.js';
import { NEAR_TESTNET, nearFoxProfile, viewNearContract } from '../../src/ui/near-testnet-assets.js';

export async function readFoxChainIdentity(nft) {
  const { collectionId, tokenId } = nftIdentity(nft?.collectionId, nft?.tokenId);
  if (collectionId !== NEAR_TESTNET.nft) throw new Error('Unsupported Fox collection.');
  const { value, blockHeight, blockHash } = await viewNearContract(collectionId, 'nft_token', { token_id: tokenId });
  if (value == null) return null;
  if (value.token_id !== tokenId || !Number.isSafeInteger(blockHeight)) throw new Error('Invalid NEAR ownership snapshot.');
  let ownershipEpoch = null;
  try {
    const observed = await viewNearContract(collectionId, 'get_ownership_epoch', { token_id: tokenId }, { blockId: blockHash });
    if (observed.blockHash === blockHash && typeof observed.value === 'string' &&
        /^(0|[1-9][0-9]{0,19})$/.test(observed.value) && BigInt(observed.value) <= (1n<<64n)-1n) {
      ownershipEpoch = observed.value;
    }
  } catch {}
  return { ...nearFoxProfile(value), ownerId: accountId(value.owner_id), blockHeight, ownershipEpoch };
}
