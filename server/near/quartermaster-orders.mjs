import {createHash} from 'node:crypto';
import {accountId,atomic} from '../../src/economy/schema.js';
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const encoded=value=>Buffer.from(JSON.stringify(value)).toString('base64');
const identifier=value=>typeof value==='string'&&/^[\w-]{1,64}$/.test(value);

export function readPublishedQuartermasterOrders(database) {
  const table = database.prepare("SELECT 1 FROM sqlite_schema WHERE type='table' AND name='near_quartermaster_public_orders'");
  if (!table.get()) return [];
  return database.prepare(`SELECT order_id AS orderId, source FROM near_quartermaster_public_orders
    ORDER BY rowid DESC LIMIT 50`).all();
}

export function quartermasterStorageDeposit({ charge, credit, registration }) {
  const missing = atomic(charge) - atomic(credit);
  return missing > 0n ? (missing + atomic(registration)).toString() : '0';
}

/** Called only after Quartermaster's reviewed funding approval. No key is owned by this adapter. */
export function createFundedQuartermasterOrders({database,economyId,economyCodeHash,economyUpgradeCodeHash,economyProfessionCodeHash,economyGuildMissionCodeHash,tokenId,buyerId,catalogue,prepare,broadcast,rpc,now=Date.now}) {
  for(const id of [economyId,tokenId,buyerId])accountId(id);
  const recipes=new Map(catalogue.filter(item=>item.enabled===true&&item.transferability==='tradable').map(item=>[item.sku,item]));
  database.exec(`CREATE TABLE IF NOT EXISTS near_quartermaster_transactions (
    operation_id TEXT PRIMARY KEY, terms_hash TEXT NOT NULL, transaction_hash TEXT NOT NULL UNIQUE,
    signed_bytes TEXT NOT NULL, draft_json TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS near_quartermaster_public_orders (
    operation_id TEXT PRIMARY KEY, terms_hash TEXT NOT NULL, source TEXT NOT NULL,
    funding_id TEXT NOT NULL, order_id TEXT NOT NULL, receipt_json TEXT NOT NULL
  )`);
  const find=database.prepare('SELECT * FROM near_quartermaster_transactions WHERE operation_id=?');
  const running=new Map();
  async function codeBlock() {
    if(typeof economyCodeHash!=='string'||!economyCodeHash)throw Error('Verified Quartermaster deployment hash required');
    const account=await rpc('query',{request_type:'view_account',account_id:economyId,finality:'final'});
    if(!account.code_hash||![economyCodeHash,economyUpgradeCodeHash,economyProfessionCodeHash,economyGuildMissionCodeHash].includes(account.code_hash)||
      typeof account.block_hash!=='string')throw Error('Quartermaster economy code mismatch');
    return account.block_hash;
  }
  function draft(terms) {
    const {proposal}=terms,recipe=recipes.get(proposal?.sku);
    if(!identifier(terms.operationId)||!identifier(terms.fundingId)||!['Sponsored','Guild'].includes(terms.source)||!recipe)throw Error('Unsupported funded Quartermaster order');
    if(!Number.isSafeInteger(proposal.quantity)||proposal.quantity<1||proposal.quantity>100 ||
      !Number.isSafeInteger(proposal.expiresAtMs)||proposal.expiresAtMs<=now())throw Error('Expired or invalid Quartermaster order');
    const price=atomic(proposal.priceAtomic),amount=price*BigInt(proposal.quantity);
    if(price===0n||amount.toString()!==terms.totalAtomic)throw Error('Quartermaster funding amount mismatch');
    atomic(terms.totalAtomic);
    const msg={action:'fund_order',operationId:terms.operationId,recipeId:recipe.recipeId,recipeVersion:recipe.recipeVersion,
      quantity:proposal.quantity,unitPrice:proposal.priceAtomic,expiresAtMs:proposal.expiresAtMs};
    return {signerId:buyerId,receiverId:tokenId,orderId:buyerId+':'+terms.operationId,
      args:{receiver_id:economyId,amount:terms.totalAtomic,msg:JSON.stringify(msg)}};
  }
  async function confirm(terms,row) {
    try {
      if((await rpc('status',[]))?.chain_id!=='testnet')return {status:'UNKNOWN'};
      await codeBlock();
      const stored=JSON.parse(row.draft_json),msg=JSON.parse(stored.args.msg);
      const tx=await rpc('tx',{tx_hash:row.transaction_hash,sender_account_id:buyerId,wait_until:'FINAL'});
      const transaction=tx?.transaction,call=transaction?.actions?.[0]?.FunctionCall;
      if(tx.final_execution_status!=='FINAL'||typeof tx.status?.SuccessValue!=='string'||transaction?.hash!==row.transaction_hash||
        transaction.signer_id!==buyerId||transaction.receiver_id!==tokenId||transaction.actions.length!==1||call?.method_name!=='ft_transfer_call'||call.deposit!=='1'||call.args!==encoded(stored.args))return {status:'UNKNOWN'};
      const proof=tx.receipts_outcome?.find(receipt=>receipt.outcome?.executor_id===economyId&&typeof receipt.outcome.status?.SuccessValue==='string'&&receipt.outcome.logs?.some(line=>{
        if(!line.startsWith('EVENT_JSON:'))return false;
        try{const event=JSON.parse(line.slice(11));return event.standard==='fox_economy'&&event.event==='order_funded'&&event.data?.some(data=>data.orderId===stored.orderId&&data.accountId===buyerId&&data.amountAtomic===terms.totalAtomic);}catch{return false;}
      }));
      if(typeof proof?.id!=='string')return {status:'UNKNOWN'};
      const view=await rpc('query',{request_type:'call_function',account_id:economyId,method_name:'get_order',args_base64:encoded({order_id:stored.orderId}),finality:'final'});
      if(!Array.isArray(view?.result)||!Number.isSafeInteger(view.block_height)||typeof view.block_hash!=='string')return {status:'UNKNOWN'};
      const order=JSON.parse(Buffer.from(view.result).toString('utf8'));
      if(order?.buyerId!==buyerId||order.recipeId!==msg.recipeId||order.recipeVersion!==msg.recipeVersion||order.unitPrice!==msg.unitPrice||order.expiresAtMs!==msg.expiresAtMs||!Number.isInteger(order.remaining)||order.remaining<0||order.remaining>msg.quantity)return {status:'UNKNOWN'};
      return {status:'FINALIZED',transactionId:row.transaction_hash,receiptId:proof.id,blockHeight:view.block_height,blockHash:view.block_hash,
        orderId:stored.orderId,amountAtomic:terms.totalAtomic,sku:terms.proposal.sku,quantity:msg.quantity,priceAtomic:msg.unitPrice};
    }catch{return {status:'UNKNOWN'};}
  }
  async function reserve(terms) {
    const hash=digest(terms);let row=find.get(terms.operationId);
    if(row&&row.terms_hash!==hash)throw Error('Funded order operation collision');
    if(row) {const known=await confirm(terms,row);if(known.status==='FINALIZED')return known;}
    if(!row) {
      const reviewed=draft(terms);
      if(typeof prepare!=='function'||typeof broadcast!=='function')throw Error('Funded order signing transport unavailable');
      if((await rpc('status',[]))?.chain_id!=='testnet')throw Error('Quartermaster network mismatch');
      // Quote is checked against the immutable onchain recipe before any signing.
      const recipe=recipes.get(terms.proposal.sku);
      const blockId=await codeBlock();
      const view=await rpc('query',{request_type:'call_function',account_id:economyId,method_name:'get_recipe',args_base64:encoded({recipe_id:recipe.recipeId,recipe_version:recipe.recipeVersion}),block_id:blockId});
      if(view.block_hash!==blockId)throw Error('Quartermaster quote finality mismatch');
      const actual=JSON.parse(Buffer.from(view.result).toString('utf8'));
      if(actual?.sku!==recipe.sku||actual.recipeId!==recipe.recipeId||actual.version!==recipe.recipeVersion)throw Error('Quartermaster recipe mismatch');
      const read=async(method,args)=>{
        const result=await rpc('query',{request_type:'call_function',account_id:economyId,method_name:method,args_base64:encoded(args),block_id:blockId});
        if(result.block_hash!==blockId||!Array.isArray(result.result))throw Error('Quartermaster storage quote unavailable');
        return atomic(JSON.parse(Buffer.from(result.result).toString('utf8')));
      };
      const [charge,credit]=await Promise.all([read('get_order_storage_charge',{quantity:terms.proposal.quantity}),read('get_order_storage_credit',{account_id:buyerId})]);
      if(credit<charge)throw Error('Quartermaster native order storage is not funded. Operator review required.');
      const signed=await prepare({signerId:buyerId,receiverId:tokenId,method:'ft_transfer_call',args:reviewed.args,gas:'50000000000000',deposit:'1'});
      if(!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(signed?.transactionHash??'')||!/^[A-Za-z0-9+/]{1,16384}={0,2}$/.test(signed?.signedTransaction??''))throw Error('Invalid prepared order transaction');
      database.prepare('INSERT OR IGNORE INTO near_quartermaster_transactions VALUES(?,?,?,?,?)').run(terms.operationId,hash,signed.transactionHash,signed.signedTransaction,JSON.stringify(reviewed));
      row=find.get(terms.operationId);
    }
    try{await broadcast({transactionHash:row.transaction_hash,signedTransaction:row.signed_bytes});}catch{/* retain the same operation and signed bytes */}
    return confirm(terms,row);
  }
  const run=terms=>{if(running.has(terms.operationId))return running.get(terms.operationId);const task=reserve(terms).finally(()=>running.delete(terms.operationId));running.set(terms.operationId,task);return task;};
  return {reserve:run,reconcile:run,
    async publish(terms) {
      const row=find.get(terms.operationId);
      if(!row||row.terms_hash!==digest(Object.fromEntries(Object.entries(terms).filter(([key])=>key!=='receipt'))))throw Error('Publication terms changed');
      const proof=await confirm(terms,row);if(proof.status!=='FINALIZED')throw Error('Funded order is not finalized');
      database.prepare('INSERT OR IGNORE INTO near_quartermaster_public_orders VALUES(?,?,?,?,?,?)').run(terms.operationId,row.terms_hash,terms.source,terms.fundingId,proof.orderId,JSON.stringify(proof));
    },
    list:()=>database.prepare('SELECT operation_id AS operationId,source,funding_id AS fundingId,order_id AS orderId,receipt_json FROM near_quartermaster_public_orders ORDER BY rowid').all().map(({receipt_json,...row})=>({...row,receipt:JSON.parse(receipt_json)})),
  };
}
