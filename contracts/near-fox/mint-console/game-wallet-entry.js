import { Buffer } from 'buffer';
import { setupWalletSelector } from '@near-wallet-selector/core';
import { setupIntearWallet } from '@near-wallet-selector/intear-wallet';
import { KeyPair } from '@near-js/crypto';
import { actionCreators, encodeDelegateAction } from '@near-js/transactions';
import { baseEncode } from '@near-js/utils';
export { actionCreators as nearActions } from '@near-js/transactions';

globalThis.Buffer ??= Buffer;

export async function openNearWallet() {
  const selector = await setupWalletSelector({ network: 'testnet', modules: [setupIntearWallet()] });
  return selector.wallet('intear-wallet');
}

export function createPoolRegistrationSigner(receiverId) {
  const pair = KeyPair.fromRandom('ed25519');
  const publicKey = pair.getPublicKey();
  return {
    publicKey: publicKey.toString(),
    addKey: actionCreators.addKey(publicKey, actionCreators.functionCallAccessKey(receiverId, ['register'], 1n)),
    async sign(senderId, nonce, maxBlockHeight) {
      const gas = 20_000_000_000_000n;
      const delegate = { senderId, receiverId, nonce, maxBlockHeight, publicKey,
        actions: [actionCreators.functionCall('register', {}, gas, 0n)] };
      const hash = await crypto.subtle.digest('SHA-256', encodeDelegateAction(delegate));
      return { senderId, receiverId, nonce: String(nonce), maxBlockHeight: String(maxBlockHeight),
        publicKey: publicKey.toString(), methodName: 'register', argsBase64: 'e30=', gas: String(gas), deposit: '0',
        signature: baseEncode(pair.sign(new Uint8Array(hash)).signature) };
    },
  };
}
