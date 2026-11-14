import { atomic } from '../../src/economy/schema.js';

const rewardBuckets = ['rewardAvailable', 'campaignAvailable', 'fixedReserved',
  'rewardReserved', 'rewardInFlight', 'rewardPaid'];

export function reconcileEconomy({ snapshot, ledger, block }) {
  if (!snapshot.cursor || snapshot.cursor.hash !== block?.hash || snapshot.cursor.height !== block?.height) {
    throw new Error('Economy index and ledger must use the same finalized block');
  }
  const chainFunding = rewardBuckets.reduce((total, key) => total + atomic(ledger[key]), 0n);
  const comparisons = [
    ['Reward funding', snapshot.cumulativeEventTotals.rewardFunding, chainFunding.toString()],
    ['Rewards paid', snapshot.cumulativeEventTotals.rewardPaid, ledger.rewardPaid],
    ['Fixed rewards held', snapshot.fixedOutstandingAtomic, ledger.fixedReserved],
    ['Craft and guild fees', snapshot.cumulativeEventTotals.craftingFees, ledger.craftingFees],
  ].map(([label, indexedAtomic, chainAtomic]) => ({
    label, indexedAtomic, chainAtomic, matches: indexedAtomic === chainAtomic,
  }));
  return { block, status: comparisons.every(row => row.matches) ? 'MATCH' : 'MISMATCH',
    indexStatus: snapshot.status, comparisons, spendAuthorization: false };
}
