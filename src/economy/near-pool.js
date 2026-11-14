import { accountId, atomic, FOXO_SCALE } from './schema.js';

export function foxoAmount(text) {
  if (typeof text !== 'string' || !/^(0|[1-9]\d*)(\.\d{1,24})?$/.test(text)) throw new Error('Enter a FOXO amount with up to 24 decimals.');
  const [whole, fraction = ''] = text.split('.');
  const value = BigInt(whole) * FOXO_SCALE + BigInt(fraction.padEnd(24, '0'));
  if (value <= 0n) throw new Error('Enter a positive FOXO amount.');
  atomic(value.toString());
  return value.toString();
}

export function poolCall({ action, poolId, tokenId, amount }) {
  accountId(poolId);
  if (action === 'stake') {
    if (atomic(amount) === 0n) throw new Error('Zero stake.');
    return { receiverId: accountId(tokenId), method: 'ft_transfer_call', deposit: 1n,
      args: { receiver_id: poolId, amount, msg: JSON.stringify({ action: 'stake' }) } };
  }
  if (action === 'withdraw') {
    if (atomic(amount) === 0n) throw new Error('No principal to withdraw.');
    return { receiverId: poolId, method: 'withdraw', deposit: 1n, args: { amount } };
  }
  if (!['register', 'claim'].includes(action)) throw new Error('Unsupported pool action.');
  return { receiverId: poolId, method: action, deposit: action === 'claim' ? 1n : 0n, args: {} };
}

export async function readPoolSnapshot({ deployment, tokenId, account, view, readCode }) {
  const poolId = accountId(deployment.accountId);
  accountId(account);
  if (!deployment.codeHash || !deployment.receiptSignerId) throw new Error('Pool deployment has not been verified.');
  if(typeof readCode!=='function')throw new Error('Pool code verifier unavailable.');
  const code=await readCode(poolId);
  const upgraded = Boolean(deployment.upgradeCodeHash && code.codeHash === deployment.upgradeCodeHash);
  if((!upgraded && code.codeHash!==deployment.codeHash) || !code.blockHash)throw new Error('Pool code hash mismatch.');
  const config = await view(poolId, 'get_config', {}, {blockId:code.blockHash});
  if (config.value?.tokenId !== tokenId || config.value?.receiptSignerId !== (upgraded ? deployment.upgradeSignerId : deployment.receiptSignerId)) throw new Error('Pool configuration mismatch.');
  const blockId = code.blockHash;
  if(config.blockHash!==blockId)throw new Error('Pool finality mismatch.');
  if (typeof blockId !== 'string' || !blockId) throw new Error('Finalized pool block unavailable.');
  const [pool, position] = await Promise.all([
    view(poolId, 'get_pool', {}, { blockId }),
    view(poolId, 'get_position', { account_id: account }, { blockId }),
  ]);
  if(pool.blockHash!==blockId || position.blockHash!==blockId)throw new Error('Pool finality mismatch.');
  for (const key of ['principal','principal_in_flight','reward_available','reward_reserved','reward_in_flight','reward_paid']) atomic(pool.value?.[key]);
  atomic(position.value?.principal); atomic(position.value?.accrued_reward);
  return { pool: pool.value, position: position.value, blockHash: blockId, rollingRegistration: upgraded };
}

