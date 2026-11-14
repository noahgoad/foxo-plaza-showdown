import { accountId, atomic } from '../../src/economy/schema.js';
function call(receiverId,signerId,methodName,args,deposit='0') {
  return {signerId:accountId(signerId),receiverId:accountId(receiverId),actions:[{type:'FunctionCall',params:{methodName,args,gas:'100000000000000',deposit}}]};
}
export function buildCareerAppendTransaction(record,{network,contractId,signerId,storageDepositAtomic}) {
  if(storageDepositAtomic==null || atomic(storageDepositAtomic)===0n)throw new Error('Explicit storage deposit required');
  if(network!=='near-testnet' || record.network!==network || record.contractId!==contractId)throw new Error('Career domain mismatch');
  return call(contractId,signerId,'append_career',{record},storageDepositAtomic);
}
export function buildPassportInitTransaction({network,contractId,collectionId,ownerId,signerId}) {
  if(network!=='near-testnet')throw new Error('Testnet only');
  return call(contractId,ownerId,'new',{owner_id:accountId(ownerId),collection_id:accountId(collectionId),network,career_signer_id:accountId(signerId)});
}
