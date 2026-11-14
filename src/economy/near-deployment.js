import {accountId} from './schema.js';
/** Verify one finalized code/config snapshot before presenting or signing money actions. */
export async function verifyEconomyDeployment({deployment,tokenId,network='near-testnet',readCode,view}) {
  const id=accountId(deployment.accountId);
  if(network!=='near-testnet'||typeof deployment.codeHash!=='string'||!deployment.codeHash)throw Error('Economy deployment is not verified.');
  const code=await readCode(id);
  if(!(deployment.acceptedCodeHashes ?? [deployment.codeHash, deployment.upgradeCodeHash]).includes(code.codeHash)||!code.blockHash)throw Error('Economy contract code changed.');
  const config=await view(id,'get_config',{}, {blockId:code.blockHash});
  if(config.blockHash!==code.blockHash||config.value?.network!==network||config.value?.foxoContractId!==tokenId)throw Error('Economy contract configuration mismatch.');
  return {config:config.value,blockHash:code.blockHash};
}
