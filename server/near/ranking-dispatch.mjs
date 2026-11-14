import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { transactions, utils } from 'near-api-js';
import { accountId as checkAccount, atomic } from '../../src/economy/schema.js';

const HASH=/^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const ALLOWED=new Set(['propose_ranking_draft','finalize_ranking_allocation']);
const DAY=86_400_000;
const rawDraft=value=>value.draftJson??JSON.stringify(value.draft);

function checkedDraft(value) {
  if(!value||typeof value.hash!=='string'||!/^[a-f0-9]{64}$/.test(value.hash))throw new Error('Missing ranking draft');
  const raw=rawDraft(value);
  const hash=createHash('sha256').update('fox-ranking-draft/v1\0').update(raw).digest('hex');
  if(hash!==value.hash||!isDeepStrictEqual(JSON.parse(raw),value.draft))throw new Error('Conflicting stored ranking draft');
  return value;
}

export function validatePreparedRankingTransaction(value,call,{economyId,signerId}) {
  if(!ALLOWED.has(call?.method))throw new Error('Method is outside ranking signer scope');
  if(!HASH.test(value?.transactionHash??'')||typeof value?.signedTransaction!=='string'||
      value.signedTransaction.length>1_000_000||!/^[A-Za-z0-9+/]+={0,2}$/.test(value.signedTransaction))throw new Error('Invalid prepared ranking transaction');
  const signed=transactions.SignedTransaction.decode(Buffer.from(value.signedTransaction,'base64'));
  const tx=signed.transaction,fn=tx.actions?.[0]?.functionCall;
  const hash=utils.serialize.base_encode(createHash('sha256').update(new transactions.Transaction(tx).encode()).digest());
  if(hash!==value.transactionHash||tx.signerId!==signerId||tx.receiverId!==economyId||tx.actions.length!==1||
      fn?.methodName!==call.method||fn.deposit!==0n||!isDeepStrictEqual(JSON.parse(Buffer.from(fn.args).toString()),call.args)) {
    throw new Error('Prepared ranking transaction does not match exact call');
  }
  return value;
}

function matchingRecord(record,value,published=false) {
  return record?.draftHash===value.hash&&record.draftJson===rawDraft(value)&&isDeepStrictEqual(record.draft,value.draft)&&
    Number.isSafeInteger(record.proposedAtMs)&&record.proposedAtMs>=0&&Number.isSafeInteger(record.reviewAfterMs)&&
    record.reviewAfterMs>=record.proposedAtMs+DAY&&(!published||
      Number.isSafeInteger(record.publishedAtMs)&&record.publishedAtMs>=record.reviewAfterMs);
}

export function createRankingReceiptVerifier({economyId,signerId,rpc}) {
  checkAccount(economyId);checkAccount(signerId);
  if(typeof rpc!=='function')throw new TypeError('Ranking RPC reader is required');
  const view=async(method,args)=>{
    const response=await rpc('query',{request_type:'call_function',finality:'final',account_id:economyId,
      method_name:method,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
    if(!Array.isArray(response?.result))throw new Error('Invalid ranking chain view');
    return JSON.parse(Buffer.from(response.result).toString());
  };
  const publication=async value=>{
    try {
      checkedDraft(value);
      if((await rpc('status',[]))?.chain_id!=='testnet')return null;
      const record=await view('get_ranking_draft',{campaign_id:value.draft.campaignId,day_index:value.draft.dayIndex});
      return matchingRecord(record,value,true)?record:null;
    }catch{return null;}
  };
  const verify=async({call,transaction,draft:value})=>{
    try {
      checkedDraft(value);
      validatePreparedRankingTransaction(transaction,call,{economyId,signerId});
      if((await rpc('status',[]))?.chain_id!=='testnet')return null;
      const result=await rpc('tx',{tx_hash:transaction.transactionHash,sender_account_id:signerId,wait_until:'FINAL'});
      const tx=result?.transaction,fn=tx?.actions?.[0]?.FunctionCall;
      if(result?.final_execution_status!=='FINAL'||typeof result.status?.SuccessValue!=='string'||
        tx?.hash!==transaction.transactionHash||tx.signer_id!==signerId||tx.receiver_id!==economyId||tx.actions?.length!==1||
        fn?.method_name!==call.method||fn.deposit!=='0'||typeof fn.args!=='string'||fn.args.length>1_000_000||
        !isDeepStrictEqual(JSON.parse(Buffer.from(fn.args,'base64').toString()),call.args))return null;
      const receiptId=result.transaction_outcome?.outcome?.status?.SuccessReceiptId;
      if(!HASH.test(receiptId??''))return null;
      const receipt=result.receipts_outcome?.find(row=>row.id===receiptId);
      if(receipt?.outcome?.executor_id!==economyId||typeof receipt.outcome.status?.SuccessValue!=='string')return null;
      const returned=JSON.parse(Buffer.from(receipt.outcome.status.SuccessValue,'base64').toString());
      const record=await view('get_ranking_draft',{campaign_id:value.draft.campaignId,day_index:value.draft.dayIndex});
      if(!matchingRecord(record,value,call.method==='finalize_ranking_allocation'))return null;
      if(call.method==='propose_ranking_draft') {
        if(!matchingRecord(returned,value))return null;
        return {status:'proposed',receiptId,transactionHash:transaction.transactionHash,record};
      }
      const allocation=value.draft.allocations.find(row=>row.accountId===call.args.account_id);
      if(!allocation||atomic(allocation.amountAtomic)===0n)return null;
      const operationId=await view('get_ranking_allocation_id',call.args);
      if(typeof operationId!=='string'||!/^ranking:[a-f0-9]{64}$/.test(operationId))return null;
      const entry=await view('get_entitlement',{operation_id:operationId});
      const same=entry=>entry?.operationId===operationId&&entry.accountId===allocation.accountId&&
        entry.amountAtomic===allocation.amountAtomic&&['reserved','in_flight','paid'].includes(entry.status)&&
        Number.isSafeInteger(entry.attempt)&&entry.attempt>=0;
      if(!same(entry)||!same(returned))return null;
      return {status:'finalized',receiptId,transactionHash:transaction.transactionHash,entitlement:entry};
    }catch{return null;}
  };
  verify.publication=publication;
  return verify;
}

/** prepare signs without sending. This service has no owner publication action. */
export function createRankingDispatch({database,drafts,economyId,signerId,prepare,broadcast,rpc,canReplace}) {
  checkAccount(economyId);checkAccount(signerId);
  if(typeof prepare!=='function'||typeof broadcast!=='function')throw new TypeError('Ranking signed transport is required');
  const verify=createRankingReceiptVerifier({economyId,signerId,rpc});
  database.exec(`CREATE TABLE IF NOT EXISTS near_ranking_transactions (
    campaign_id TEXT NOT NULL, mode TEXT NOT NULL, budget_day TEXT NOT NULL,
    account_id TEXT NOT NULL, action TEXT NOT NULL, draft_hash TEXT NOT NULL, call_json TEXT NOT NULL,
    transaction_hash TEXT NOT NULL UNIQUE, signed_transaction TEXT NOT NULL, receipt_id TEXT,
    PRIMARY KEY(campaign_id,mode,budget_day,account_id,action))`);
  database.exec(`CREATE TABLE IF NOT EXISTS near_ranking_transaction_attempts (
    transaction_hash TEXT PRIMARY KEY, signed_transaction TEXT NOT NULL
  );
  INSERT OR IGNORE INTO near_ranking_transaction_attempts
    SELECT transaction_hash,signed_transaction FROM near_ranking_transactions;`);
  const find=database.prepare(`SELECT transaction_hash AS transactionHash,signed_transaction AS signedTransaction,
    receipt_id AS receiptId,call_json AS callJson,draft_hash AS draftHash FROM near_ranking_transactions
    WHERE campaign_id=? AND mode=? AND budget_day=? AND account_id=? AND action=?`);
  const insert=database.prepare(`INSERT OR IGNORE INTO near_ranking_transactions VALUES(?,?,?,?,?,?,?,?,?,NULL)`);
  const confirm=database.prepare('UPDATE near_ranking_transactions SET receipt_id=? WHERE transaction_hash=?');
  const remember=database.prepare('INSERT OR IGNORE INTO near_ranking_transaction_attempts VALUES(?,?)');
  const replace=database.prepare(`UPDATE near_ranking_transactions SET transaction_hash=?,signed_transaction=?
    WHERE campaign_id=? AND mode=? AND budget_day=? AND account_id=? AND action=?
      AND transaction_hash=? AND receipt_id IS NULL`);
  const pending=database.prepare(`SELECT campaign_id AS campaignId,mode,budget_day AS budgetDay,
    account_id AS accountId,action FROM near_ranking_transactions WHERE receipt_id IS NULL`);
  const unsubmitted=database.prepare(`SELECT d.campaign_id AS campaignId,d.mode,d.budget_day AS budgetDay
    FROM near_ranking_drafts d
    WHERE d.mode IN (SELECT value FROM json_each(?))
      AND NOT EXISTS (SELECT 1 FROM near_ranking_transactions p WHERE p.campaign_id=d.campaign_id
        AND p.mode=d.mode AND p.budget_day=d.budget_day AND p.action='propose')
    ORDER BY d.budget_day,d.campaign_id,d.mode LIMIT 1 OFFSET ?`);
  const claims=database.prepare(`SELECT campaign_id AS campaignId,mode,budget_day AS budgetDay,
    transaction_hash AS transactionHash,signed_transaction AS signedTransaction,call_json AS callJson
    FROM near_ranking_transactions WHERE account_id=? AND action='finalize' AND receipt_id IS NOT NULL`);
  const publishedCandidates=database.prepare(`SELECT p.campaign_id AS campaignId,p.mode,p.budget_day AS budgetDay
    FROM near_ranking_transactions p
    JOIN near_ranking_drafts d USING(campaign_id,mode,budget_day)
    JOIN json_each(d.payload,'$.allocations') a
    WHERE p.action='propose' AND p.receipt_id IS NOT NULL
      AND json_extract(a.value,'$.accountId')=? AND json_extract(a.value,'$.amountAtomic')<>'0'
      AND NOT EXISTS (
        SELECT 1 FROM near_ranking_transactions f
        WHERE f.campaign_id=p.campaign_id AND f.mode=p.mode AND f.budget_day=p.budget_day
          AND f.action='finalize' AND f.account_id=? AND f.receipt_id IS NOT NULL)
    ORDER BY p.budget_day DESC LIMIT 8`);
  const running=new Map();
  let proposalOffset=0;
  async function dispatch(key,action) {
    const value=checkedDraft(drafts.forSubmission(key));
    const account=action==='finalize'?checkAccount(key.accountId):'';
    const allocation=value.draft.allocations.find(row=>row.accountId===account);
    if(action==='finalize'&&(!allocation||atomic(allocation.amountAtomic)===0n))return null;
    const call=action==='propose'?{method:'propose_ranking_draft',args:{draft_json:rawDraft(value),draft_hash:value.hash}}:
      {method:'finalize_ranking_allocation',args:{campaign_id:value.draft.campaignId,day_index:value.draft.dayIndex,account_id:account}};
    if(action==='finalize'&&!await verify.publication(value))return null;
    const tuple=[key.campaignId,key.mode,key.budgetDay,account,action];
    let transaction=find.get(...tuple);
    if(transaction) {
      if(transaction.draftHash!==value.hash||transaction.callJson!==JSON.stringify(call))throw new Error('Conflicting ranking dispatch operation');
      validatePreparedRankingTransaction(transaction,call,{economyId,signerId});
      const known=await verify({call,transaction,draft:value});
      if(known){confirm.run(known.receiptId,transaction.transactionHash);return known;}
      // Previously confirmed rows are never resent on an inconclusive RPC read.
      if(transaction.receiptId)return null;
      if(canReplace && await canReplace(transaction,call)===true) {
        const prepared=validatePreparedRankingTransaction(await prepare(call),call,{economyId,signerId});
        database.exec('BEGIN IMMEDIATE');
        try {
          replace.run(prepared.transactionHash,prepared.signedTransaction,...tuple,transaction.transactionHash);
          transaction=find.get(...tuple);
          remember.run(transaction.transactionHash,transaction.signedTransaction);
          database.exec('COMMIT');
        } catch(error) {
          database.exec('ROLLBACK');
          throw error;
        }
        if(transaction.receiptId)return null;
        validatePreparedRankingTransaction(transaction,call,{economyId,signerId});
      }
    }else{
      const prepared=validatePreparedRankingTransaction(await prepare(call),call,{economyId,signerId});
      insert.run(...tuple,value.hash,JSON.stringify(call),prepared.transactionHash,prepared.signedTransaction);
      transaction=find.get(...tuple);
      if(!transaction)throw new Error('Unable to persist ranking transaction');
      validatePreparedRankingTransaction(transaction,call,{economyId,signerId});
      remember.run(transaction.transactionHash,transaction.signedTransaction);
    }
    try{await broadcast({transactionHash:transaction.transactionHash,signedTransaction:transaction.signedTransaction});}catch{/* Unknown inclusion retains exact signed bytes. */}
    const result=await verify({call,transaction,draft:value});
    if(result)confirm.run(result.receiptId,transaction.transactionHash);
    return result;
  }
  function run(key,action) {
    const id=JSON.stringify([key.campaignId,key.mode,key.budgetDay,key.accountId??'',action]);
    if(running.has(id))return running.get(id);
    const promise=dispatch(key,action).finally(()=>running.delete(id));running.set(id,promise);return promise;
  }
  return {
    propose:key=>run(key,'propose'),
    finalize:key=>run(key,'finalize'),
    // Public review data is deliberately separate from verified claim rights.
    forReview:key=>drafts.forReview(key),
    async submitNextDraft(enabledModes) {
      const modes=JSON.stringify(enabledModes);
      let key=unsubmitted.get(modes,proposalOffset);
      if(!key && proposalOffset>0) {
        proposalOffset=0;
        key=unsubmitted.get(modes,proposalOffset);
      }
      if(!key)return null;
      proposalOffset++;
      const {draft}=checkedDraft(drafts.forSubmission(key));
      const response=await rpc('query',{request_type:'call_function',finality:'final',account_id:economyId,
        method_name:'get_campaign',args_base64:Buffer.from(JSON.stringify({campaign_id:key.campaignId})).toString('base64')});
      const campaign=JSON.parse(Buffer.from(response.result).toString());
      if(campaign?.closed!==false||campaign.closesAtMs!==draft.seasonStartMs+28*86_400_000||
        campaign.maxAward!=='6250000000000000000000000')return null;
      return run(key,'propose');
    },
    async recover({onError=console.error}={}) {
      for(const row of pending.all())try{await run(row,row.action);}catch(error){onError(error,row);}
    },
    async claimsForAccount(accountId) {
      checkAccount(accountId);
      const verified=[];
      for(const row of claims.all(accountId)) {
        const draft=drafts.forSubmission(row);
        if(!draft)continue;
        const result=await verify({call:JSON.parse(row.callJson),transaction:row,draft});
        if(result?.status!=='finalized'||result.entitlement.status!=='reserved')continue;
        verified.push({source:'ranking',campaignId:row.campaignId,mode:row.mode,budgetDay:row.budgetDay,
          ...result.entitlement,transactionHash:result.transactionHash,receiptId:result.receiptId});
      }
      return verified;
    },
    async materializeForAccount(accountId) {
      checkAccount(accountId);
      for(const key of publishedCandidates.all(accountId,accountId)) {
        await run({...key,accountId},'finalize');
      }
    },
  };
}
