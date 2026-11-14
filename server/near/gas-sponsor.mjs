import {createHash} from 'node:crypto';
import {accountId,atomic} from '../../src/economy/schema.js';
const safeMethods=new Set(['claim','register','storage_deposit','append_career']);

/** This policy never signs. A NEP-366 verifier and funded, receipt-aware sender are separate gates. */
export function createGasSponsor({database,enabled=false,budgetAtomic='0',maxGas='100000000000000',
  maxDepositAtomic='1',maxTtlMs=300000,allowlist={},oneRegistrationPerAccount=false,verifyDelegate,now=Date.now}) {
  atomic(budgetAtomic);atomic(maxGas);atomic(maxDepositAtomic);
  if(!Number.isSafeInteger(maxTtlMs)||maxTtlMs<=0||maxTtlMs>300000)throw new Error('Invalid sponsor session lifetime');
  for(const [receiver,methods] of Object.entries(allowlist)) {
    accountId(receiver);
    if(!Array.isArray(methods)||!methods.length||methods.some(method=>!safeMethods.has(method)))throw new Error('Unsafe sponsor method allowlist');
  }
  database.exec(`CREATE TABLE IF NOT EXISTS near_gas_reservations (
    id TEXT PRIMARY KEY, account_id TEXT NOT NULL, public_key TEXT NOT NULL, nonce TEXT NOT NULL,
    maximum_cost TEXT NOT NULL, status TEXT NOT NULL, receipt_id TEXT,
    UNIQUE(account_id,public_key,nonce)
  )`);
  const list=database.prepare('SELECT * FROM near_gas_reservations');
  const find=database.prepare('SELECT id FROM near_gas_reservations WHERE id=?');
  const accountRegistration=database.prepare("SELECT id FROM near_gas_reservations WHERE account_id=? AND status IN ('RESERVED','FINALIZED') LIMIT 1");
  const reserved=()=>list.all().filter(row=>row.status!=='REJECTED').reduce((sum,row)=>sum+BigInt(row.maximum_cost),0n);
  const checkCapacity=(id,cost,account)=>{
    if(find.get(id))throw new Error('Delegated nonce already reserved');
    if(oneRegistrationPerAccount && accountRegistration.get(account))throw new Error('A sponsored registration already exists');
    if(reserved()+cost>atomic(budgetAtomic))throw new Error('Sponsor budget exhausted');
  };
  return {
    status:()=>({enabled,budgetAtomic,reservedAtomic:reserved().toString()}),
    canRegister:account=>!oneRegistrationPerAccount||!accountRegistration.get(account),
    async reserve(signedDelegate,{maximumCostAtomic,session,prepare,persist}={}) {
      if(!enabled || atomic(budgetAtomic)===0n)throw new Error('Gas sponsorship is unavailable. Review a self-paid wallet transaction instead.');
      if(typeof verifyDelegate!=='function')throw new Error('Delegated signature verification unavailable');
      // Verifier must check signature, access-key permission and finalized delegate nonce.
      const verified=await verifyDelegate(signedDelegate,session);
      if(!verified || verified.network!=='near-testnet' || verified.permission!=='FunctionCall' || verified.revoked ||
        verified.signatureValid!==true || verified.nonceValid!==true)throw new Error('Invalid delegated session');
      maximumCostAtomic??=verified.maximumCostAtomic;
      const cost=atomic(maximumCostAtomic);
      if(cost===0n)throw new Error('A verified maximum gas cost is required');
      if(verified.maximumCostAtomic!==maximumCostAtomic)throw new Error('Sponsor cost was not verified against the signed action');
      accountId(verified.accountId);accountId(verified.receiverId);
      const time=now();
      if(!Number.isSafeInteger(verified.issuedAtMs)||!Number.isSafeInteger(verified.expiresAtMs)||
        verified.issuedAtMs>time || verified.expiresAtMs<=time || verified.expiresAtMs-verified.issuedAtMs>maxTtlMs ||
        typeof verified.publicKey!=='string'||!/^ed25519:[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(verified.publicKey) ||
        typeof verified.nonce!=='string'||! /^(0|[1-9]\d*)$/.test(verified.nonce))throw new Error('Expired or malformed delegated session');
      const allowed=allowlist[verified.receiverId];
      if(!Array.isArray(verified.actions)||verified.actions.length!==1)throw new Error('Sponsor permits one reviewed function call');
      const call=verified.actions[0];
      if(call.type!=='FunctionCall'||!allowed?.includes(call.method)||atomic(call.gas)>atomic(maxGas)||
        atomic(call.deposit)>atomic(maxDepositAtomic))throw new Error('Delegated action is outside sponsor scope');
      const id=createHash('sha256').update(verified.accountId+'\0'+verified.publicKey+'\0'+verified.nonce).digest('hex');
      checkCapacity(id,cost,verified.accountId);
      const transaction=prepare?await prepare(verified):null;
      database.exec('BEGIN IMMEDIATE');
      try {
        checkCapacity(id,cost,verified.accountId);
        database.prepare("INSERT INTO near_gas_reservations VALUES(?,?,?,?,?,'RESERVED',NULL)").run(id,verified.accountId,verified.publicKey,verified.nonce,cost.toString());
        if(persist)persist(id,transaction);
        database.exec('COMMIT');return {id,status:'RESERVED',maximumCostAtomic:cost.toString()};
      } catch(error) {database.exec('ROLLBACK');throw error;}
    },
  };
}
