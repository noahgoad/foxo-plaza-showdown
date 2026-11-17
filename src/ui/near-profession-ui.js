import { viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { economyDeployment, guildMissionCodeHashes } from '../../assets/near-fox/economy-deployment.js';

export async function watchProfessionUnlock(menu, result) {
  const identity = menu._identity;
  if (identity?.config?.network !== 'near-testnet' || !identity.address) return;
  const account = identity.address;
  const contract = economyDeployment.accountId;
  const active = () => menu._results === result && menu._identity === identity && identity.address === account;
  try {
    if (![economyDeployment.professionCodeHash,...guildMissionCodeHashes].includes((await readNearAccountCode(contract)).codeHash)) return;
    for (let attempt = 0; attempt < 10 && active(); attempt++) {
      const { value } = await viewNearContract(contract, 'get_profession_progress', { account_id: account });
      if (!active()) return;
      if (value.matchIds.includes(result.roundId) && value.matches === 3) {
        for (const [flag, label] of [['boss', 'ARMORER'], ['trial', 'STYLIST']]) {
          const key = 'fox-profession-notified:' + account + ':' + label;
          if (value[flag] && !localStorage.getItem(key)) {
            localStorage.setItem(key, '1');
            menu.toast(label + ' UNLOCKED');
          }
        }
        return;
      }
      if (value.boss && value.trial && value.matches === 3) return;
      await new Promise(resolve => setTimeout(resolve, 3000));
    }
  } catch {
    // Workshop remains the source of finalized progress if the result screen closes or RPC is unavailable.
  }
}
