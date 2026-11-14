import {careerRecordHash} from './career-record.mjs';
import {buildCareerAppendTransaction} from './career-deployment.mjs';

/** prepare signs only; the signed bytes are persisted before send_tx. */
export function createCareerChain({database,network,contractId,signerId,storageDepositAtomic,rpc,prepare,broadcast,canReplace}) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_career_transactions (
    operation_id TEXT PRIMARY KEY, record_hash TEXT NOT NULL, transaction_id TEXT NOT NULL UNIQUE, signed_bytes TEXT NOT NULL
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS near_career_transaction_attempts (
    transaction_id TEXT PRIMARY KEY, signed_bytes TEXT NOT NULL, operation_id TEXT NOT NULL
  );
  INSERT OR IGNORE INTO near_career_transaction_attempts
    SELECT transaction_id,signed_bytes,operation_id FROM near_career_transactions;`);
  const lookup=database.prepare('SELECT * FROM near_career_transactions WHERE operation_id=?');
  const running=new Map();
  return {
    async replay({operationId,record}) {
      let tx=lookup.get(operationId);
      if(!tx || tx.record_hash!==careerRecordHash(record))throw new Error('No matching durable career transaction');
      if((await rpc('status',[]))?.chain_id!=='testnet')throw new Error('Career network mismatch');
      const draft=buildCareerAppendTransaction(record,{network,contractId,signerId,storageDepositAtomic});
      const action=draft.actions[0].params;
      if(canReplace && await canReplace({transactionHash:tx.transaction_id,signedTransaction:tx.signed_bytes},
          {method:action.methodName,args:action.args})) {
        const signed=await prepare(draft);
        if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed?.transactionHash??'') ||
            !/^[A-Za-z0-9+/]{1,32768}={0,2}$/.test(signed?.signedTransaction??''))throw new Error('Invalid signed career replacement');
        database.exec('BEGIN IMMEDIATE');
        try {
          database.prepare('UPDATE near_career_transactions SET transaction_id=?,signed_bytes=? WHERE operation_id=? AND transaction_id=?')
            .run(signed.transactionHash,signed.signedTransaction,operationId,tx.transaction_id);
          tx=lookup.get(operationId);
          database.prepare('INSERT OR IGNORE INTO near_career_transaction_attempts VALUES(?,?,?)')
            .run(tx.transaction_id,tx.signed_bytes,operationId);
          database.exec('COMMIT');
        } catch(error) {database.exec('ROLLBACK');throw error;}
      }
      try {await broadcast({transactionHash:tx.transaction_id,signedTransaction:tx.signed_bytes});} catch {/* exact bytes remain durable */}
    },
    recover({operationId,record}) {
      const tx=lookup.get(operationId);
      if(!tx)return {status:'SAFE_TO_PREPARE'};
      if(tx.record_hash!==careerRecordHash(record))throw new Error('Career transaction collision');
      return {status:'SUBMITTED',transactionId:tx.transaction_id};
    },
    async submit({operationId,record}) {
      if(running.has(operationId))return running.get(operationId);
      const task=(async()=>{
        if((await rpc('status',[]))?.chain_id!=='testnet')throw new Error('Career network mismatch');
        const hash=careerRecordHash(record);
        let tx=lookup.get(operationId);
        if(tx && tx.record_hash!==hash)throw new Error('Career transaction collision');
        if(!tx) {
          const draft=buildCareerAppendTransaction(record,{network,contractId,signerId,storageDepositAtomic});
          const signed=await prepare(draft);
          if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed?.transactionHash??'') ||
            !/^[A-Za-z0-9+/]{1,32768}={0,2}$/.test(signed?.signedTransaction??''))throw new Error('Invalid signed career transaction');
          database.prepare('INSERT OR IGNORE INTO near_career_transactions VALUES(?,?,?,?)').run(operationId,hash,signed.transactionHash,signed.signedTransaction);
          tx=lookup.get(operationId);
          database.prepare('INSERT OR IGNORE INTO near_career_transaction_attempts VALUES(?,?,?)')
            .run(tx.transaction_id,tx.signed_bytes,operationId);
        }
        try {await broadcast({transactionHash:tx.transaction_id,signedTransaction:tx.signed_bytes});} catch {/* reconcile durable hash */}
        return {status:'SUBMITTED',transactionId:tx.transaction_id};
      })().finally(()=>running.delete(operationId));
      running.set(operationId,task);return task;
    },
    async reconcile({operationId,record}) {
      const tx=lookup.get(operationId);
      if(!tx || careerRecordHash(record)!==tx.record_hash)return {status:'UNKNOWN'};
      try {
        if((await rpc('status',[]))?.chain_id!=='testnet')return {status:'UNKNOWN'};
        const final=await rpc('tx',{tx_hash:tx.transaction_id,sender_account_id:signerId,wait_until:'FINAL'});
        const transaction=final?.transaction,fn=transaction?.actions?.[0]?.FunctionCall;
        if(final.final_execution_status!=='FINAL' || typeof final.status?.SuccessValue!=='string' ||
          transaction.hash!==tx.transaction_id || transaction.signer_id!==signerId || transaction.receiver_id!==contractId ||
          transaction.actions.length!==1 || fn?.method_name!=='append_career' || fn.deposit!==storageDepositAtomic ||
          typeof fn.args!=='string' || fn.args.length>16384)return {status:'UNKNOWN'};
        const args=JSON.parse(Buffer.from(fn.args,'base64').toString('utf8'));
        if(Object.keys(args).length!==1 || careerRecordHash(args.record)!==tx.record_hash)return {status:'UNKNOWN'};
        const receiptId=final.transaction_outcome?.outcome?.status?.SuccessReceiptId;
        const receipt=final.receipts_outcome?.find(row=>row.id===receiptId);
        if(typeof receiptId!=='string' || receipt?.outcome?.executor_id!==contractId || typeof receipt.outcome.status?.SuccessValue!=='string')return {status:'UNKNOWN'};
        const view=await rpc('query',{request_type:'call_function',account_id:contractId,method_name:'get_record',
          args_base64:Buffer.from(JSON.stringify({event_id:record.eventId})).toString('base64'),finality:'final'});
        if(!Array.isArray(view?.result) || typeof view.block_hash!=='string' || !Number.isSafeInteger(view.block_height))return {status:'UNKNOWN'};
        const observed=JSON.parse(Buffer.from(view.result).toString('utf8'));
        if(careerRecordHash(observed)!==tx.record_hash)return {status:'UNKNOWN'};
        return {status:'FINALIZED',transactionId:tx.transaction_id,receiptId,blockHash:view.block_hash,blockHeight:view.block_height,record:observed};
      } catch {return {status:'UNKNOWN'};}
    },
  };
}
