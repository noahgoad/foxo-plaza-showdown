import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { KeyPair, InMemorySigner, keyStores, transactions, utils } from 'near-api-js';
import { economyDeployment, guildMissionUpgrade, materialOrdersUpgrade } from '../../assets/near-fox/economy-deployment.js';
import { NEAR_TESTNET } from '../../src/ui/near-testnet-assets.js';
import { verifyNearMessage } from '../near-wallet-auth.mjs';
import { createFundedQuartermasterOrders, quartermasterStorageDeposit } from './quartermaster-orders.mjs';
import { createQuartermaster } from './quartermaster.mjs';
import { createNearAiQuartermasterProvider } from './near-ai-provider.mjs';

const operator = 'xuancanh1.testnet';
const buyer = 'quartermaster.' + operator;
const economy = economyDeployment.accountId;
const token = NEAR_TESTNET.token;
const recipe = economyDeployment.recipes[0];
const total = '10000000000000000000000000';
const storageCap = '92160000000000000000000';

export async function bootstrapQuartermasterPilot({ database, keyFile, origin, rpc, round = 1,
  aiKey = process.env.NEAR_AI_API_KEY, aiModel = process.env.NEAR_AI_MODEL }) {
  if (!Number.isSafeInteger(round) || round < 1 || round > 9999) throw Error('Invalid Quartermaster pilot round.');
  const operationId = 'violet-pilot-' + round;
  const fundingId = 'quartermaster-pilot-' + round;
  const key = KeyPair.fromString((await readFile(keyFile, 'utf8')).trim());
  const publicKey = key.getPublicKey();
  const store = new keyStores.InMemoryKeyStore();
  await store.setKey('testnet', buyer, key);
  const signer = new InMemorySigner(store);
  const recipient = new URL(origin).host;
  database.exec(`CREATE TABLE IF NOT EXISTS near_quartermaster_pilot (
    id INTEGER PRIMARY KEY CHECK(id=1), approval TEXT NOT NULL, storage_tx TEXT
  );
  CREATE TABLE IF NOT EXISTS near_quartermaster_pilot_rounds (
    round INTEGER PRIMARY KEY, approval TEXT NOT NULL, storage_tx TEXT
  );
  INSERT OR IGNORE INTO near_quartermaster_pilot_rounds
    SELECT id,approval,storage_tx FROM near_quartermaster_pilot`);
  const readApproval = database.prepare('SELECT approval,storage_tx FROM near_quartermaster_pilot_rounds WHERE round=?');
  const saved = { get: () => readApproval.get(round) };
  const insert = database.prepare('INSERT INTO near_quartermaster_pilot_rounds VALUES(?,?,NULL)');
  const recordStorage = database.prepare('UPDATE near_quartermaster_pilot_rounds SET storage_tx=? WHERE round=? AND storage_tx IS NULL');
  const encode = args => Buffer.from(JSON.stringify(args)).toString('base64');
  const view = async (account_id, method_name, args, block_id) => {
    const response = await rpc('query', { request_type:'call_function', account_id, method_name, block_id, args_base64:encode(args) });
    if (response.block_hash !== block_id) throw Error('Quartermaster quote is not pinned to the finalized block.');
    return JSON.parse(Buffer.from(response.result).toString());
  };
  async function quote() {
    if ((await rpc('status', [])).chain_id !== 'testnet') throw Error('Wrong Quartermaster network.');
    const { header } = await rpc('block', { finality:'final' });
    const at = header.hash;
    const [code,config,balance,charge,credit,registration,items,payer,protocol] = await Promise.all([
      rpc('query',{request_type:'view_account',account_id:economy,block_id:at}),
      view(economy,'get_config',{},at), view(token,'ft_balance_of',{account_id:buyer},at),
      view(economy,'get_order_storage_charge',{quantity:1},at),
      view(economy,'get_order_storage_credit',{account_id:buyer},at),
      view(economy,'get_order_storage_registration_charge',{account_id:buyer},at),
      view(economy,'get_owned_items',{account_id:buyer,offset:0,limit:50},at),
      rpc('query',{request_type:'view_account',account_id:buyer,block_id:at}),
      rpc('EXPERIMENTAL_protocol_config',{block_id:at}),
    ]);
    if (code.block_hash !== at || !economyDeployment.acceptedCodeHashes.includes(code.code_hash) ||
        config.foxoContractId !== token || !config.ordersEnabled) throw Error('Quartermaster Economy verification failed.');
    if (!Array.isArray(items) || items.length >= 50) throw Error('Complete Quartermaster inventory unavailable.');
    const stock = items.filter(item => item.recipeId === recipe.recipeId && item.recipeVersion === recipe.version).length;
    const deposit = quartermasterStorageDeposit({charge,credit,registration});
    const storageRate = protocol?.runtime_config?.storage_amount_per_byte;
    if (payer.block_hash !== at || !Number.isSafeInteger(payer.storage_usage) ||
        typeof storageRate !== 'string' || typeof payer.amount !== 'string') throw Error('Quartermaster NEAR balance is unavailable.');
    const availableNear = BigInt(payer.amount) - BigInt(storageRate) * BigInt(payer.storage_usage);
    return { header, balance, credit, charge, stock, deposit, availableNear };
  }
  function checkFunds(quote) {
    if (BigInt(quote.balance) < BigInt(total)) throw Error('The dedicated Quartermaster account needs 10 FOXO.');
    if (BigInt(quote.deposit) > BigInt(storageCap)) throw Error('Quartermaster storage exceeds the pilot cap.');
    // The pilot funds one 50 Tgas order and, if needed, one 20 Tgas storage call.
    const gasReserve = BigInt(quote.deposit) > 0n ? 74n : 53n;
    if (quote.availableNear < BigInt(quote.deposit) + gasReserve * 10n ** 21n) {
      throw Error('The dedicated Quartermaster account needs more Testnet NEAR for order storage and gas.');
    }
  }
  async function prepare(call) {
    const storage = call.receiverId === economy && call.method === 'deposit_order_storage' &&
      Object.keys(call.args).length === 0 && BigInt(call.deposit) > 0n && BigInt(call.deposit) <= BigInt(storageCap);
    const order = call.receiverId === token && call.method === 'ft_transfer_call' &&
      call.deposit === '1' && call.args.receiver_id === economy && call.args.amount === total &&
      JSON.parse(call.args.msg).operationId === operationId;
    if (call.signerId !== buyer || (!storage && !order)) throw Error('Quartermaster call is outside the approved pilot.');
    const access = await rpc('query',{request_type:'view_access_key',account_id:buyer,
      public_key:publicKey.toString(),finality:'final'});
    if (access.permission !== 'FullAccess' || !Number.isSafeInteger(access.nonce)) throw Error('Quartermaster signer is unavailable.');
    const tx = transactions.createTransaction(buyer,publicKey,call.receiverId,BigInt(access.nonce)+1n,
      [transactions.functionCall(call.method,call.args,BigInt(call.gas),BigInt(call.deposit))],
      utils.serialize.base_decode(access.block_hash));
    const [hash,signed] = await transactions.signTransaction(tx,signer,buyer,'testnet');
    return { transactionHash:utils.serialize.base_encode(hash), signedTransaction:Buffer.from(signed.encode()).toString('base64') };
  }
  const broadcast = tx => rpc('send_tx',{signed_tx_base64:tx.signedTransaction,wait_until:'FINAL'});
  const orders = createFundedQuartermasterOrders({database,economyId:economy,economyCodeHash:economyDeployment.codeHash,
    economyUpgradeCodeHash:economyDeployment.upgradeCodeHash, economyProfessionCodeHash:economyDeployment.professionCodeHash,
    economyGuildMissionCodeHash:guildMissionUpgrade.codeHash,
    economyMaterialOrdersCodeHash:materialOrdersUpgrade.codeHash,
    tokenId:token,buyerId:buyer,catalogue:[{...recipe,recipeVersion:recipe.version,enabled:true,transferability:'tradable'}],
    prepare,broadcast,rpc});
  const maxTtlMs = 86_400_000;
  const provider = aiKey && aiModel
    ? createNearAiQuartermasterProvider({apiKey:aiKey,model:aiModel,maxTtlMs}) : undefined;
  const service = createQuartermaster({database,config:{enabled:true,budgetAtomic:total,maxTtlMs},orders,provider});
  let pending;
  let running;
  async function review() {
    if (saved.get()) return { status:service.get(operationId)?.status ?? 'APPROVED' };
    const current = await quote();
    const {header, balance, deposit, stock} = current;
    const now = Date.now();
    if (round > 1) {
      const prior = await view(economy,'get_order',{order_id:buyer+':violet-pilot-'+(round-1)},header.hash);
      if (!prior || (!prior.closed && prior.remaining !== 0)) {
        throw Error('The previous sponsored order must be filled or closed before reviewing the next order.');
      }
    }
    checkFunds(current);
    if (stock >= 1) throw Error('The pilot already has its target stock.');
    if (pending?.expiresAt > now) return pending.challenge;
    const context = {finalized:true,blockHash:header.hash,blockHeight:header.height,source:'Sponsored',fundingId,
      availableBudgetAtomic:balance,skus:[{sku:recipe.sku,stock,target:1,registered:true,previewed:true,
        priceAtomic:total,minPriceAtomic:total,maxPriceAtomic:total}]};
    const proposed = await service.propose(context);
    if (!proposed.proposal) throw Error('Quartermaster pilot is unavailable.');
    const approval = {operationId,fundingId,source:'Sponsored',amountAtomic:total,proposalHash:proposed.proposalHash};
    const challenge = { accountId:operator, nonce:randomBytes(32).toString('base64'), recipient,
      providerStatus:proposed.providerStatus,
      message:'Authorize NEAR Testnet Quartermaster order '+operationId+': buy 1 Violet Fox Finish for 10 FOXO. Buyer: '+buyer+
        '. Storage deposit maximum: '+deposit+' yoctoNEAR. Order expires '+new Date(proposed.proposal.expiresAtMs).toISOString()+
        '. Terms hash: '+approval.proposalHash };
    pending = {challenge, expiresAt:now+300_000, deposit, request:{operationId,proposal:proposed.proposal,context,approval}};
    return challenge;
  }
  async function process() {
    const row = saved.get();
    const approved = JSON.parse(row.approval);
    if (service.get(operationId)) return service.execute(approved.request);
    const current = await quote();
    if (current.stock >= 1) throw Error('The pilot already has its target stock.');
    checkFunds(current);
    if (BigInt(current.deposit) > 0n) {
      if (BigInt(current.deposit) > BigInt(approved.deposit)) throw Error('Storage deposit exceeds the signed approval.');
      let tx = row.storage_tx && JSON.parse(row.storage_tx);
      if (!tx) {
        if (approved.request.proposal.expiresAtMs <= Date.now()) throw Error('The approved order expired before submission.');
        const prepared = await prepare({signerId:buyer,receiverId:economy,method:'deposit_order_storage',
          args:{},gas:'20000000000000',deposit:current.deposit});
        recordStorage.run(JSON.stringify(prepared),round);
        tx = JSON.parse(saved.get().storage_tx);
      }
      try { await broadcast(tx); } catch { /* Confirm the original transaction via finalized credit. */ }
      const after = await quote();
      if (BigInt(after.credit) < BigInt(after.charge)) return {status:'STORAGE_PENDING',transactionHash:tx.transactionHash};
    }
    return service.execute(approved.request);
  }
  return async ({method,url,headers,body}) => {
    if (method !== 'POST' || headers.origin !== origin || !['/near/quartermaster/review','/near/quartermaster/confirm'].includes(url)) return null;
    if (url.endsWith('/review')) return {status:200,data:{...(await review()),round}};
    if (running) return {status:409,data:{error:'Pilot approval is processing.'}};
    running = (async () => {
      const draft = pending;
      if (!saved.get()) {
        if (!draft || draft.expiresAt <= Date.now() || body?.nonce !== draft.challenge.nonce) throw Error('Review the current pilot terms.');
        await verifyNearMessage(draft.challenge,body);
        insert.run(round,JSON.stringify({deposit:draft.deposit,request:draft.request,proof:body,
          digest:createHash('sha256').update(draft.challenge.message).digest('hex')}));
        pending = null;
      } else {
        const approved = JSON.parse(saved.get().approval);
        if (approved.proof.signature !== body?.signature || approved.proof.nonce !== body?.nonce) throw Error('Provide the original approval.');
      }
      return process();
    })().finally(()=>{ running=null; });
    return {status:200,data:await running};
  };
}
