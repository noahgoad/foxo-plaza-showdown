import { buildCareerRecord, careerRecordHash } from './career-record.mjs';

export function createCareerOutbox({database,network,contractId,collectionId,verifyResult,chain}) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_career_outbox (
    operation_id TEXT PRIMARY KEY, record_json TEXT NOT NULL, record_hash TEXT NOT NULL,
    status TEXT NOT NULL, transaction_id TEXT, proof_json TEXT
  )`);
  const getRow=database.prepare('SELECT * FROM near_career_outbox WHERE operation_id=?');
  const view=row=>row?{operationId:row.operation_id,record:JSON.parse(row.record_json),status:row.status,
    ...(row.transaction_id?{transactionId:row.transaction_id}:{}),...(row.proof_json?{proof:JSON.parse(row.proof_json)}:{})}:null;
  const running=new Map();
  async function process(id) {
    let row=getRow.get(id);
    if(!row)throw new Error('Unknown career operation');
    if(row.status==='FINALIZED')return view(row);
    if(!chain)throw new Error('Career chain adapter unavailable');
    if(row.status==='SUBMITTED' && chain.recover) {
      const recovery=await chain.recover(view(row));
      if(recovery?.status==='SUBMITTED' && typeof recovery.transactionId==='string') {
        database.prepare('UPDATE near_career_outbox SET transaction_id=? WHERE operation_id=?').run(recovery.transactionId,id);
      } else if(recovery?.status==='SAFE_TO_PREPARE' && !row.transaction_id) {
        database.prepare("UPDATE near_career_outbox SET status='PREPARED' WHERE operation_id=? AND transaction_id IS NULL").run(id);
      }
      row=getRow.get(id);
    }
    if(row.status!=='PREPARED') {
      const proof=await chain.reconcile(view(row));
      if(proof?.status==='FINALIZED') {
        if(typeof proof.receiptId!=='string' || !proof.receiptId || typeof proof.blockHash!=='string' || !proof.blockHash ||
          !Number.isSafeInteger(proof.blockHeight) || proof.blockHeight<0 ||
          proof.transactionId!==row.transaction_id || careerRecordHash(proof.record)!==row.record_hash)throw new Error('Career proof mismatch');
        database.prepare("UPDATE near_career_outbox SET status='FINALIZED',proof_json=? WHERE operation_id=?").run(JSON.stringify(proof),id);
      } else if(chain.replay) {
        await chain.replay(view(row));
      }
      return view(getRow.get(id));
    }
    // Persist uncertainty before any external mutation. Unknown submissions require reconciliation.
    database.prepare("UPDATE near_career_outbox SET status='SUBMITTED' WHERE operation_id=? AND status='PREPARED'").run(id);
    const response=await chain.submit(view(row));
    if(typeof response?.transactionId!=='string' || !response.transactionId)throw new Error('Career transaction outcome unknown');
    database.prepare('UPDATE near_career_outbox SET transaction_id=? WHERE operation_id=?').run(response.transactionId,id);
    return view(getRow.get(id));
  }
  return {
    enqueue(result) {
      if(result.rulesVersion?.startsWith('near-practice-'))return {status:'PRACTICE'};
      const provenance=verifyResult?.(result);
      if(!provenance || typeof provenance.then==='function')throw new Error('Verified career provenance required');
      const record=buildCareerRecord(result,{network,contractId,collectionId},provenance);
      const digest=careerRecordHash(record),previous=getRow.get(record.eventId);
      if(previous) {if(previous.record_hash!==digest)throw new Error('Career record conflict');return view(previous);}
      database.prepare("INSERT INTO near_career_outbox VALUES(?,?,?,'PREPARED',NULL,NULL)").run(record.eventId,JSON.stringify(record),digest);
      return view(getRow.get(record.eventId));
    },
    get:id=>view(getRow.get(id)),
    list:()=>database.prepare('SELECT * FROM near_career_outbox ORDER BY rowid').all().map(view),
    process(id) {if(running.has(id))return running.get(id);const task=process(id).finally(()=>running.delete(id));running.set(id,task);return task;},
  };
}
