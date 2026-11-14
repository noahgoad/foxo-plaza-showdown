import foxOwnershipWasm from './fox-ownership-reviewed.wasm?url';
import { poolDeployment } from '../../../assets/near-fox/pool-deployment.js';
import poolUpgradeWasm from './pool-open-registration.wasm?url';
import { actionCreators as action } from '@near-js/transactions';
import { PublicKey } from '@near-js/crypto';
import { openNearWallet } from './game-wallet-entry.js';
import setup from './backend-setup.json';
import pilotKeys from './pilot-keys.json';
import pins from './activation-pins.json';
import manifest from '../../../config/economy-deployment-manifest.json';
import economyConfig from '../../../config/economy.testnet.json';
import rankingRubric from '../../../config/ranking-rubrics.testnet.json';
import rankingSeasons from '../../../config/ranking-pilot.testnet.json';
import catalogue from '../../../assets/near-fox/catalogue.v2.json' with {type:'json'};
import { validateCatalogue } from '../../../assets/near-fox/catalogue.js';
import { catalogueUpgrade, professionUpgrade, guildMissionUpgrade } from '../../../assets/near-fox/economy-deployment.js';
import economyProfessionWasm from './economy-professions-reviewed.wasm?url';
import economyCatalogueWasm from './economy-catalogue-reviewed.wasm?url';
import guildMissionWasm from './economy-guild-mission-reviewed.wasm?url';
import { onchainPilotRecipe } from '../../../assets/near-fox/economy-catalogue.js';

const operator=manifest.operatorId, economy='economy.'+operator, passport='passport.'+operator, token=manifest.tokenId;
const unit=10n**24n, gas=20n*10n**12n;
const collectionUpgradeHash='9d6c61fc549fdbe8bd8afa9c2812ad4875568ec5c0cf768ac6e1ee7648b20902';
const elements=Object.fromEntries(['connect','refresh','actions','pool-actions','pool-status','fox-actions','fox-status','review','confirm','status'].map(id=>[id,document.getElementById(id)]));
let wallet,connected,busy=false,review;
const rpc=async(method,params)=>{
  const response=await fetch('https://near-testnet.drpc.org',{method:'POST',headers:{'content-type':'application/json'},
    signal:AbortSignal.timeout(15000),body:JSON.stringify({jsonrpc:'2.0',id:'activation',method,params})});
  if(!response.ok)throw Error('Testnet RPC HTTP '+response.status);
  const value=await response.json();
  if(value.error)throw Object.assign(Error(value.error.cause?.name||'Testnet read failed'),{code:value.error.cause?.name});
  return value.result;
};
const query=async(account_id,method_name,args={})=>{
  const observed=await rpc('query',{request_type:'call_function',account_id,method_name,
    args_base64:btoa(JSON.stringify(args)),finality:'final'});
  if(!Array.isArray(observed.result))throw Error('Invalid finalized contract view');
  return JSON.parse(new TextDecoder().decode(Uint8Array.from(observed.result)));
};
const call=(method,args,deposit=0n)=>action.functionCall(method,args,method==='ft_transfer_call'?100n*10n**12n:gas,deposit);
function amountFrom(id) {
  const value=document.getElementById(id).value.trim();
  if(!/^(0|[1-9]\d{0,14})(\.\d{1,24})?$/.test(value))throw Error('Enter the amount to review.');
  const [whole,fraction='']=value.split('.');
  const amount=BigInt(whole)*unit+BigInt(fraction.padEnd(24,'0'));
  if(amount===0n)throw Error('Enter a positive amount.');
  return {value,amount};
}
function choose(label,receiverId,actions,description,beforeSign) {
  if(connected?.accountId!==operator)throw Error('Connect '+operator+' to review this operation.');
  review={transaction:{signerId:operator,receiverId,actions},beforeSign};
  elements.review.textContent=JSON.stringify({network:'near-testnet',receiverId,description,actions},
    (_key,value)=>typeof value==='bigint'?value.toString():value,2);
  elements.confirm.disabled=false;
}
function button(label,prepare,container=elements.actions){
  const element=document.createElement('button');element.textContent=label;element.disabled=!connected;
  element.onclick=()=>run(prepare);container.append(element);
}
async function pilotRequest(path,body={}) {
  const round = new URLSearchParams(location.search).get('quartermasterRound');
  const port = round === '2' ? 8834 : 8833;
  const response=await fetch('http://127.0.0.1:'+port+'/near/quartermaster/'+path,{method:'POST',
    headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(50_000)});
  const data=await response.json();
  if(!response.ok)throw Error(data.error||'Quartermaster pilot unavailable.');
  return data;
}
async function refresh(){
  if((await rpc('status',[])).chain_id!=='testnet')throw Error('Wrong network');
  await verifyCode();
  const [config,career,ledger,mt]=await Promise.all([query(economy,'get_config'),query(passport,'get_config'),
    query(economy,'get_ledger'),query(economy,'get_mt_migration')]);
  const pilots=Object.fromEntries(await Promise.all(Object.entries(pilotKeys).map(async ([role,spec])=>{
    try {
      const state=await rpc('query',{request_type:'view_account',account_id:spec.accountId,finality:'final'});
      if(!state.block_hash||typeof state.amount!=='string')return [role,{accountId:spec.accountId,status:'unverified'}];
      await verifySigner(spec);
      const balance=role==='quartermaster'?await query(token,'ft_balance_of',{account_id:spec.accountId}):undefined;
      return [role,{accountId:spec.accountId,status:'verified',nearAtomic:state.amount,foxoAtomic:balance}];
    } catch(error) {
      return [role,{accountId:spec.accountId,status:error.code==='UNKNOWN_ACCOUNT'?'not created':'unverified'}];
    }
  })));
  elements.status.textContent=JSON.stringify({pilots,economy:config,passport:career,ledger,mt},null,2);
  elements.actions.replaceChildren();
  const reviewEconomyUpgrade = (label, upgrade, artifactUrl, description) => button(label,async()=>{
    if(!upgrade)throw Error('Economy upgrade is awaiting verification.');
    if(connected?.accountId!==economy)throw Error('In Intear, import the existing Testnet account '+economy+' using its original recovery method, then reconnect this page and select it.');
    const check=async()=>{
      const state=await rpc('query',{request_type:'view_account',account_id:economy,finality:'final'});
      if(state.code_hash!==upgrade.previous)throw Error('Economy code changed.');
      const keys=await rpc('query',{request_type:'view_access_key_list',account_id:economy,finality:'final'});
      if(!connected.publicKey||!keys.keys.some(row=>row.public_key===connected.publicKey&&row.access_key.permission==='FullAccess')){
        throw Error('Select the operator key with FullAccess to Economy.');
      }
    };
    await check();
    const artifact=await fetch(artifactUrl,{signal:AbortSignal.timeout(10000)});
    if(!artifact.ok)throw Error('Reviewed Economy Wasm could not be loaded.');
    const bytes=new Uint8Array(await artifact.arrayBuffer());
    const hash=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),byte=>byte.toString(16).padStart(2,'0')).join('');
    if(hash!==upgrade.sha256||!WebAssembly.validate(bytes))throw Error('Economy Wasm hash does not match the reviewed build.');
    class ContractCode extends Uint8Array {toJSON(){return Array.from(this);}}
    review={transaction:{signerId:economy,receiverId:economy,
      actions:[action.deployContract(new ContractCode(bytes))]},beforeSign:check};
    elements.review.textContent=JSON.stringify({network:'near-testnet',signer:economy,receiverId:economy,sha256:hash,
      description},null,2);
  });
  reviewEconomyUpgrade('Review Economy professions upgrade', professionUpgrade, economyProfessionWasm,
    'Unlock Armorer and Stylist through verified matches. Remove manual license grants.');
  reviewEconomyUpgrade('Review Economy catalogue upgrade', catalogueUpgrade, economyCatalogueWasm,
    'Upgrade existing Economy state with producer license enforcement.');
  reviewEconomyUpgrade('Review Guild mission rewards upgrade', guildMissionUpgrade, guildMissionWasm,
    'Enable separate Guild mission reward entitlements using existing Economy state.');
  const guildCampaignInput = (label, placeholder) => {
    const field=document.createElement('label');
    const input=document.createElement('input');
    input.placeholder=placeholder;
    field.append(label+' ',input);
    elements.actions.append(field);
    return input;
  };
  const rewardProject=guildCampaignInput('Guild project','Project ID');
  const rewardBudget=guildCampaignInput('Guild reward budget','Whole FOXO');
  const rewardAmount=guildCampaignInput('Reward per mission','Whole FOXO');
  const wholeGuildFoxo=input=>{
    if(!/^[1-9][0-9]{0,11}$/.test(input.value.trim()))throw Error('Enter a positive whole FOXO amount.');
    return BigInt(input.value.trim())*unit;
  };
  button('Review Guild reward funding',async()=>{
    const amount=wholeGuildFoxo(rewardBudget);
    const readFunding=async()=>{
      const [ledger, config, balance]=await Promise.all([query(economy,'get_ledger'),
        query(economy,'get_config'),query(token,'ft_balance_of',{account_id:operator})]);
      const available=BigInt(ledger.rewardAvailable);
      const shortfall=amount>available?amount-available:0n;
      const funded=['rewardAvailable','campaignAvailable','fixedReserved','rewardReserved','rewardInFlight','rewardPaid']
        .reduce((sum,key)=>sum+BigInt(ledger[key]),0n);
      if(shortfall>BigInt(config.rewardFundingCap)-funded)throw Error('The Economy reward funding cap would be exceeded.');
      if(shortfall>BigInt(balance))throw Error('The operator wallet has insufficient FOXO.');
      return shortfall;
    };
    const shortfall=await readFunding();
    if(shortfall===0n)throw Error('Economy already has enough unallocated FOXO. Review the campaign.');
    choose('Guild reward funding',token,[call('ft_transfer_call',{receiver_id:economy,amount:String(shortfall),
      msg:JSON.stringify({action:'fund_rewards'})},1n)],'Top up unallocated Economy rewards for the Guild campaign.',async()=>{
      if(await readFunding()!==shortfall)throw Error('The funding shortfall changed. Review the top-up again.');
    });
  });
  button('Review Guild mission campaign',async()=>{
    const projectId=rewardProject.value.trim();
    if(!/^[A-Za-z0-9_-]{1,48}$/.test(projectId))throw Error('Enter a valid Guild project ID.');
    const budget=wholeGuildFoxo(rewardBudget), award=wholeGuildFoxo(rewardAmount);
    if(award>budget||budget%award!==0n)throw Error('Budget must cover a whole number of mission rewards.');
    const campaignId='guild-mission:'+projectId;
    const guild='guild.'+operator;
    const getProject=()=>query(guild,'project',{project_id:projectId});
    const project=await getProject();
    if(!project)throw Error('Guild project '+projectId+' does not exist on Testnet. Create and open it before reviewing the campaign.');
    if(project.status!=='open')throw Error('Guild project '+projectId+' is not open.');
    const closes=Number(BigInt(project.deadline)/1000000n);
    const check=async()=>{
      const [code,latest,existing,ledger]=await Promise.all([
        rpc('query',{request_type:'view_account',account_id:economy,finality:'final'}),getProject(),
        query(economy,'get_campaign',{campaign_id:campaignId}),query(economy,'get_ledger')]);
      if(code.code_hash!==guildMissionUpgrade.codeHash)throw Error('Deploy the Guild mission upgrade first.');
      if(existing||latest?.status!=='open'||latest.terms_hash!==project.terms_hash||closes<=Date.now())throw Error('Guild project or campaign state changed.');
      if(BigInt(ledger.rewardAvailable)<budget)throw Error('Insufficient unallocated FOXO in Economy. Use Review Guild reward funding first.');
    };
    await check();
    choose('Guild mission campaign',economy,[call('open_campaign',{campaign_id:campaignId,
      budget:String(budget),max_award:String(award),closes_at_ms:closes})],
      'Allocate '+budget/unit+' FOXO from Economy at '+award/unit+' FOXO per mission for '+projectId+'.',check);
  });
  button('Review Aurora and Tide recipe registration',async()=>{
    if(!catalogueUpgrade)throw Error('Economy catalogue upgrade is awaiting Sandbox verification.');
    const recipes=validateCatalogue(catalogue).items.filter(item=>item.transferability==='tradable')
      .map(({recipeId,recipeVersion,sku,inputs,feeAtomic})=>({recipeId,version:recipeVersion,sku,inputs,feeAtomic}));
    const check=async()=>{
      const state=await rpc('query',{request_type:'view_account',account_id:economy,finality:'final'});
      if(![catalogueUpgrade.codeHash,professionUpgrade.codeHash,guildMissionUpgrade.codeHash].includes(state.code_hash))throw Error('Deploy the producer-license upgrade first.');
      const existing=await Promise.all(recipes.map(recipe=>query(economy,'get_recipe',{
        recipe_id:recipe.recipeId,recipe_version:recipe.version,
      })));
      return recipes.filter((recipe,index)=>{
        const current=existing[index];
        if(current&&(current.sku!==recipe.sku||current.feeAtomic!==recipe.feeAtomic||
          Object.keys(recipe.inputs).some(key=>recipe.inputs[key]!==current.inputs?.[key])))throw Error('Recipe terms differ from the catalogue.');
        return !current;
      });
    };
    const missing=await check();
    if(!missing.length)throw Error('Both catalogue recipes are registered.');
    choose('Catalogue recipe registration',economy,missing.map(recipe=>call('add_recipe',{recipe})),
      'Register Aurora and Tide with the reviewed costs. Beacon remains a Guild project.',
      async()=>{if(JSON.stringify(await check())!==JSON.stringify(missing))throw Error('Recipe registration changed. Review again.');});
  });
  for(const [name,spec] of Object.entries(setup.signers)) {
    button('Review '+name+' signer setup',async()=>{
      const existing=await rpc('query',{request_type:'view_account',account_id:spec.accountId,finality:'final'})
        .catch(error=>{if(error.code==='UNKNOWN_ACCOUNT')return null;throw error;});
      if(existing){
        await verifySigner(spec);
        throw Error('Signer is already created and verified.');
      }
      choose(name,spec.accountId,[action.createAccount(),action.transfer(unit/2n),
        action.addKey(PublicKey.fromString(spec.publicKey),action.fullAccessKey())],
      'Create a dedicated relay signer with 0.5 Testnet NEAR for gas and storage. Key stays on this computer.');
    });
  }
  for(const [name,spec] of Object.entries(pilotKeys)) {
    button('Review '+name+' account creation',async()=>{
      const {amount,value}=amountFrom(name+'-near');
      const check=async()=>{
        const existing=await rpc('query',{request_type:'view_account',account_id:spec.accountId,finality:'final'})
          .catch(error=>{if(error.code==='UNKNOWN_ACCOUNT')return null;throw error;});
        if(existing)throw Error('Account already exists. No creation or top-up is needed.');
        const payer=await rpc('query',{request_type:'view_account',account_id:operator,finality:'final'});
        if(typeof payer.amount!=='string'||BigInt(payer.amount)<amount+unit/100n) {
          throw Error('Insufficient Testnet NEAR. Keep at least 0.01 NEAR for gas.');
        }
      };
      await check();
      choose(name+' account creation',spec.accountId,[action.createAccount(),action.transfer(amount),
        action.addKey(PublicKey.fromString(spec.publicKey),action.fullAccessKey())],
        'Create '+spec.accountId+' with '+value+' Testnet NEAR and its dedicated local signing key.',check);
    });
  }
  button('Review Quartermaster FOXO registration',async()=>{
    const spec=pilotKeys.quartermaster;
    const check=async()=>{
      await verifySigner(spec);
      if(await query(token,'storage_balance_of',{account_id:spec.accountId}))throw Error('Quartermaster FOXO storage is already registered.');
      return (await query(token,'storage_balance_bounds')).min;
    };
    const minimum=await check();
    choose('Quartermaster FOXO registration',token,[call('storage_deposit',{
      account_id:spec.accountId,registration_only:true,
    },BigInt(minimum))],'Register the separate buyer using the FOXO storage minimum.',
    async()=>{if(await check()!==minimum)throw Error('Storage minimum changed. Review again.');});
  });
  button('Review Quartermaster FOXO funding',async()=>{
    const spec=pilotKeys.quartermaster;
    const {amount,value}=amountFrom('quartermaster-foxo');
    const check=async()=>{
      await verifySigner(spec);
      if(!await query(token,'storage_balance_of',{account_id:spec.accountId}))throw Error('Register Quartermaster FOXO storage first.');
      const [current,available]=await Promise.all([
        query(token,'ft_balance_of',{account_id:spec.accountId}),query(token,'ft_balance_of',{account_id:operator}),
      ]);
      if(BigInt(current)!==0n)throw Error('Quartermaster already has FOXO. Check the finalized balance before funding again.');
      if(BigInt(available)<amount)throw Error('Insufficient operator FOXO.');
    };
    await check();
    choose('Quartermaster FOXO funding',token,[call('ft_transfer',{receiver_id:spec.accountId,amount:String(amount)},1n)],
      'Send '+value+' FOXO from the operator to the dedicated Quartermaster buyer. This does not open an order.',check);
  });
  button('Review Quartermaster order',async()=>{
    if(connected?.accountId!==operator)throw Error('Connect '+operator+' to approve the Quartermaster order.');
    const draft=await pilotRequest('review');
    if(draft.status==='PUBLISHED'){
      elements.review.textContent='Quartermaster pilot order is finalized.';
      return;
    }
    const approvalKey = draft.round > 1 ? 'fox-quartermaster-pilot-approval:'+draft.round : 'fox-quartermaster-pilot-approval';
    const prior=sessionStorage.getItem(approvalKey);
    if(draft.status&&!prior)throw Error('Use the browser tab that signed the order to recover its approval.');
    elements.review.textContent=draft.message||'Resume checking the signed Quartermaster pilot.';
    review={authorize:async()=>{
      const proof=draft.status?JSON.parse(prior):{
        ...await wallet.signMessage({message:draft.message,recipient:draft.recipient,
          nonce:globalThis.Buffer.from(draft.nonce,'base64')}),nonce:draft.nonce,
      };
      sessionStorage.setItem(approvalKey,JSON.stringify(proof));
      const result=await pilotRequest('confirm',proof);
      elements.review.textContent=JSON.stringify(result,null,2);
      if(result.status==='PUBLISHED')sessionStorage.removeItem(approvalKey);
    }};
  });
  button('Review expired Quartermaster refund',async()=>{
    const buyer=pilotKeys.quartermaster.accountId;
    if(connected?.accountId!==buyer)throw Error('Select '+buyer+' in Intear to recover its order credit.');
    const order_id=buyer+':violet-pilot-1';
    async function check(){
      const [order,credit,{header}]=await Promise.all([
        query(economy,'get_order',{order_id}),query(economy,'get_order_credit',{account_id:buyer}),
        rpc('block',{finality:'final'}),
      ]);
      const now=Number(BigInt(header.timestamp_nanosec)/1_000_000n);
      if(!order||order.buyerId!==buyer)throw Error('The sponsored order is unavailable.');
      if(!order.closed&&order.remaining>0&&now<order.expiresAtMs)throw Error('The first sponsored order is still open until '+new Date(order.expiresAtMs).toISOString()+'.');
      if(!order.closed&&order.remaining>0)return {method:'close_order',args:{order_id},gas};
      if(BigInt(credit)>0n)return {method:'withdraw_order_credit',args:{},gas:65n*10n**12n,credit};
      throw Error('There is no outstanding Quartermaster refund.');
    }
    const selected=await check();
    review={transaction:{signerId:buyer,receiverId:economy,
      actions:[action.functionCall(selected.method,selected.args,selected.gas,1n)]},
      beforeSign:async()=>{const current=await check();if(current.method!==selected.method||current.credit!==selected.credit)throw Error('Quartermaster refund state changed. Review again.');}};
    elements.review.textContent=selected.method==='close_order'?
      'Close the expired sponsored order and return unspent FOXO to Quartermaster order credit.':
      'Withdraw '+selected.credit+' atomic FOXO from finalized order credit to '+buyer+'.';
  });
  button('Review Economy activation',async()=>{
    const fresh=await query(economy,'get_config'), migration=await query(economy,'get_mt_migration');
    const actions=[];
    const signer=setup.signers.settler;
    await verifySigner(signer);
    if(fresh.settlementSignerId!==signer.accountId)actions.push(call('rotate_settlement_signer',{settlement_signer_id:signer.accountId}));
    const recipe=onchainPilotRecipe();
    const published=await query(economy,'get_recipe',{recipe_id:recipe.recipeId,recipe_version:recipe.version});
    if(!published)actions.push(call('add_recipe',{recipe}));
    if(!migration) {
      const text=JSON.stringify({version:1,contractId:economy,accounts:[],items:[],supply:['0','0','0']});
      const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(v=>v.toString(16).padStart(2,'0')).join('');
      const ledger=await query(economy,'get_ledger');
      if(fresh.craftingEnabled||fresh.ordersEnabled||ledger.craftingFees!=='0')throw Error('Nonempty economy requires a reviewed MT migration.');
      actions.push(call('begin_mt_migration',{manifest_hash:hash}),call('finalize_mt_migration',{
        manifest_hash:hash,expected_accounts:0,expected_supply:['0','0','0'],expected_items:0}));
    } else if(!migration.finalized)throw Error('Finish the existing MT migration first.');
    if(!migration?.enabled)actions.push(call('set_mt_enabled',{enabled:true}));
    if(!fresh.craftingEnabled)actions.push(call('set_crafting_enabled',{enabled:true}));
    if(!fresh.ordersEnabled)actions.push(call('set_orders_enabled',{enabled:true}));
    if(!await query(economy,'get_sales_enabled'))actions.push(call('set_sales_enabled',{enabled:true}));
    if(!fresh.settlementEnabled)actions.push(call('set_settlement_enabled',{enabled:true}));
    if(!actions.length)throw Error('Economy is already activated.');
    choose('Economy activation',economy,actions,'Assign the dedicated signer, publish the reviewed recipe and enable materials, craft, transfers and orders.');
  });
  button('Review Passport activation',async()=>{
    await verifySigner(setup.signers.career);
    const fresh=await query(passport,'get_config'),actions=[];
    if(fresh.careerSignerId!==setup.signers.career.accountId)actions.push(call('set_career_signer',{career_signer_id:setup.signers.career.accountId}));
    if(!fresh.appendEnabled)actions.push(call('set_append_enabled',{enabled:true}));
    if(!actions.length)throw Error('Passport is already activated.');
    choose('Passport activation',passport,actions,'Assign the career signer and enable append-only records. Storage paid from the dedicated Testnet signer.');
  });
  button('Review funding 20,000 FOXO pilot',async()=>{
    const ledger=await query(economy,'get_ledger');
    const funded=['rewardAvailable','campaignAvailable','fixedReserved','rewardReserved','rewardInFlight','rewardPaid']
      .reduce((sum,key)=>sum+BigInt(ledger[key]),0n);
    const target=20000n*unit,missing=target-funded;
    if(missing<=0n)throw Error('The first pilot is already funded.');
    const registered=await query(token,'storage_balance_of',{account_id:economy});
    if(!registered)throw Error('Register the Economy FOXO storage first.');
    choose('Pilot funding',token,[call('ft_transfer_call',{receiver_id:economy,amount:String(missing),
      msg:JSON.stringify({action:'fund_rewards'})},1n)],
      'Transfer only the missing part of the first 20,000 FOXO pilot from the approved 80,000 match allocation.',
      async()=>{
        const latest=await query(economy,'get_ledger');
        const total=['rewardAvailable','campaignAvailable','fixedReserved','rewardReserved','rewardInFlight','rewardPaid']
          .reduce((sum,key)=>sum+BigInt(latest[key]),0n);
        if(target-total!==missing)throw Error('Funding changed. Review the updated missing amount.');
      });
  });
  button('Review Economy FOXO registration',async()=>{
    if(await query(token,'storage_balance_of',{account_id:economy}))throw Error('Economy FOXO storage is already registered.');
    const bounds=await query(token,'storage_balance_bounds');
    choose('FT registration',token,[call('storage_deposit',{account_id:economy,registration_only:true},BigInt(bounds.min))],
      'Register Economy to receive FOXO. Attached deposit uses the token storage minimum.');
  });
  button('Review fixed reward campaign',async()=>{
    const campaignId='fox-pilot-1-fixed';
    const existing=await query(economy,'get_campaign',{campaign_id:campaignId});
    if(existing)throw Error('Fixed pilot campaign is already open.');
    const {header}=await rpc('block',{finality:'final'});
    const time=Number(BigInt(header.timestamp_nanosec)/1000000n);
    const start=Math.floor(time/86400000)*86400000;
    const ledger=await query(economy,'get_ledger');
    if(BigInt(ledger.rewardAvailable)<16000n*unit)throw Error('Fund the approved pilot first.');
    choose('Fixed pilot',economy,[call('open_fixed_campaign',{campaign_id:campaignId,season_start_ms:start})],
      'Reserve 16,000 FOXO from existing pilot funds for 3,200 awards of 5 FOXO over 28 UTC days, starting '+
        new Date(start).toISOString()+'. Remaining 4,000 FOXO stays unallocated until ranking review.');
  });
  button('Review Pool FOXO registration',async()=>{
    const pool='pool.'+operator;
    if(await query(token,'storage_balance_of',{account_id:pool}))throw Error('Pool FOXO storage is already registered.');
    const bounds=await query(token,'storage_balance_bounds');
    choose('Pool registration',token,[call('storage_deposit',{account_id:pool,registration_only:true},BigInt(bounds.min))],
      'Register Pool to receive the approved FOXO Testnet campaign reward.');
  });
  const market='market.'+operator, guild='guild.'+operator;
  for(const [label,account] of [['Market',market],['Guild',guild]]) {
    button('Review '+label+' FOXO registration',async()=>{
      if(await query(token,'storage_balance_of',{account_id:account}))throw Error(label+' FOXO storage is already registered.');
      const bounds=await query(token,'storage_balance_bounds');
      choose(label+' registration',token,[call('storage_deposit',{account_id:account,registration_only:true},BigInt(bounds.min))],
        'Register '+label+' to receive FOXO on Testnet.');
    });
  }
  button('Review Guild settlement setup',async()=>{
    if(!await query(token,'storage_balance_of',{account_id:guild}))throw Error('Register Guild FOXO storage first.');
    const mt=await query(economy,'get_mt_migration');
    if(!mt?.finalized||!mt.enabled)throw Error('Enable Economy multi-token transfers first.');
    choose('Guild settlement',economy,[call('configure_guild_contract',{guild_contract_id:guild,enabled:true},unit/10n)],
      'Authorize the verified Guild contract and add 0.1 NEAR Testnet for project receipt storage. Each confirmation adds storage credit.');
  });
  button('Review Fox Market activation',async()=>{
    if(await query(market,'get_enabled'))throw Error('Fox Market is already active.');
    if(!await query(token,'storage_balance_of',{account_id:market}))throw Error('Register Market FOXO storage first.');
    choose('Fox Market activation',market,[call('set_enabled',{enabled:true})],
      'Enable single-Fox purchases on Testnet. The market charges 2.5% of a successful sale.');
  });
  button('Review funding 1,500 FOXO pool',async()=>{
    const pool='pool.'+operator;
    const current=await query(pool,'get_pool');
    const funded=['reward_available','reward_reserved','reward_in_flight','reward_paid'].reduce((sum,key)=>sum+BigInt(current[key]),0n);
    const missing=1500n*unit-funded;
    if(missing<=0n)throw Error('The first pool reward budget is already funded.');
    if(!await query(token,'storage_balance_of',{account_id:pool}))throw Error('Register Pool FOXO storage first.');
    choose('Pool reward funding',token,[call('ft_transfer_call',{receiver_id:pool,amount:String(missing),
      msg:JSON.stringify({action:'fund_reward'})},1n)],
      'Fund the missing portion of the first 1,500 FOXO pool from the approved 15,000 staking allocation. Campaign opening follows verified Boss eligibility.',
      async()=>{
        const fresh=await query(pool,'get_pool');
        const total=['reward_available','reward_reserved','reward_in_flight','reward_paid'].reduce((sum,key)=>sum+BigInt(fresh[key]),0n);
        if(1500n*unit-total!==missing)throw Error('Pool funding changed. Review the missing amount again.');
      });
  });
  button('Review recording Boss clear',async()=>{
    const pool='pool.'+operator;
    const file=document.querySelector('#pool-receipt').files[0];
    if(!file||file.size>8192)throw Error('Select the Boss receipt JSON prepared by the relay tool.');
    const {status,request}=JSON.parse(await file.text());
    const args=request?.actions?.[0]?.params?.args;
    if(status!=='UNSIGNED'||request.network!=='near-testnet'||request.receiverId!==pool||
        request.signerId!==operator||request.actions.length!==1||
        request.actions[0].params.methodName!=='record_boss_clear'||
        !/^[a-z0-9][a-z0-9._-]{0,55}\.testnet$/.test(args?.account_id??'')||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(args?.match_id??'')||
        !Number.isSafeInteger(args.finished_at_ms)||!/^[a-f0-9]{64}$/.test(request.resultHash)) {
      throw Error('Invalid Boss receipt draft.');
    }
    const {account_id,match_id,finished_at_ms}=args;
    async function check(){
      const [poolState,receipt,{header}]=await Promise.all([query(pool,'get_pool'),
        query(pool,'get_boss_clear',{account_id,match_id}),rpc('block',{finality:'final'})]);
      const now=Number(BigInt(header.timestamp_nanosec)/1000000n);
      if(poolState.opened_at_ms!==null||receipt!==null||finished_at_ms>now||now-finished_at_ms>=86400000){
        throw Error('The Boss clear is already recorded, expired, or the campaign is open.');
      }
    }
    await check();
    choose('Record Boss clear',pool,[call('record_boss_clear',{account_id,match_id,finished_at_ms})],
      'Record the reviewed Boss clear for '+account_id+'. Match '+match_id+'. Result hash '+request.resultHash+'.',check);
  });
  button('Review opening ranking campaign',async()=>{
    const campaign_id=document.querySelector('#ranking-campaign').value.trim();
    const mode=document.querySelector('#ranking-mode').value;
    const start=document.querySelector('#ranking-start').value;
    const season_start_ms=Date.parse(start+'T00:00:00Z');
    if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(campaign_id)||!Number.isSafeInteger(season_start_ms)) {
      throw Error('Enter a campaign ID and UTC season start date.');
    }
    if(rankingRubric.reviewStatus!=='approved'||!rankingRubric.enabledModes.includes(mode)||
        !economyConfig.ranking.enabledModes.includes(mode))throw Error('This mode is awaiting rubric approval.');
    const budget=BigInt(economyConfig.ranking.modeBudgetsFoxo[mode]);
    async function check(){
      const [existing,ledger,{header}]=await Promise.all([query(economy,'get_campaign',{campaign_id}),
        query(economy,'get_ledger'),rpc('block',{finality:'final'})]);
      const today=Math.floor(Number(BigInt(header.timestamp_nanosec)/1000000n)/86400000)*86400000;
      if(existing)throw Error('The campaign ID is already in use.');
      if(season_start_ms<today)throw Error('Choose today or a future UTC date.');
      if(BigInt(ledger.rewardAvailable)<budget*unit)throw Error('The ranking budget is unavailable.');
    }
    await check();
    choose('Open ranking campaign',economy,[call('open_ranking_campaign',{campaign_id,mode,season_start_ms})],
      'Reserve '+budget+' FOXO for '+mode+' ranking starting '+start+' UTC.',check);
  });
  button('Review remaining ranking campaigns',async()=>{
    const campaigns = rankingSeasons.additional.filter(({mode}) =>
      rankingRubric.reviewStatus === 'approved' && rankingRubric.enabledModes.includes(mode) &&
      economyConfig.ranking.enabledModes.includes(mode));
    async function check(){
      const [ledger, {header}, ...existing] = await Promise.all([query(economy,'get_ledger'),
        rpc('block',{finality:'final'}), ...campaigns.map(({campaignId}) =>
          query(economy,'get_campaign',{campaign_id:campaignId}))]);
      const today = Math.floor(Number(BigInt(header.timestamp_nanosec)/1000000n)/86400000)*86400000;
      const missing = campaigns.filter((_,i)=>!existing[i]);
      if(missing.some(c=>c.seasonStartMs<today))throw Error('The configured season start has passed.');
      const budget = missing.reduce((sum,{mode})=>sum+BigInt(economyConfig.ranking.modeBudgetsFoxo[mode]),0n);
      if(BigInt(ledger.rewardAvailable)<budget*unit)throw Error('The remaining ranking budget is unavailable.');
      return {missing,budget};
    }
    const {missing,budget}=await check();
    if(!missing.length)throw Error('All configured ranking campaigns are already open.');
    choose('Open remaining ranking campaigns',economy,missing.map(({campaignId,mode,seasonStartMs})=>
      call('open_ranking_campaign',{campaign_id:campaignId,mode,season_start_ms:seasonStartMs})),
      'Reserve '+budget+' FOXO for '+missing.map(c=>c.mode).join(', ')+'.',
      async()=>{if(JSON.stringify((await check()).missing)!==JSON.stringify(missing))throw Error('Ranking campaign state changed. Review again.');});
  });
  button('Review ranking publication',async()=>{
    const campaign_id=document.querySelector('#ranking-campaign').value.trim();
    const day=document.querySelector('#ranking-day').value;
    const day_index=Number(day);
    if(!/^[a-zA-Z0-9_.-]{1,64}$/.test(campaign_id)||!day||
        !Number.isInteger(day_index)||day_index<0||day_index>27)throw Error('Enter a ranking campaign and a day index from 0 to 27.');
    const args={campaign_id,day_index};
    async function readDraft(){
      const [record,{header}]=await Promise.all([query(economy,'get_ranking_draft',args),rpc('block',{finality:'final'})]);
      const now=Number(BigInt(header.timestamp_nanosec)/1000000n);
      if(!record||!/^[a-f0-9]{64}$/.test(record.draftHash)||record.publishedAtMs!==null||
          !Number.isSafeInteger(record.reviewAfterMs)||now<record.reviewAfterMs)throw Error('The ranking draft is unavailable, published, or still in review.');
      return record;
    }
    const reviewed=await readDraft();
    choose('Ranking publication',economy,[call('publish_ranking_draft',{...args,draft_hash:reviewed.draftHash})],
      'Publish the finalized draft for '+campaign_id+', day '+day_index+'. Awards: '+reviewed.draft.awardedAtomic+' atomic FOXO.',
      async()=>{if((await readDraft()).draftHash!==reviewed.draftHash)throw Error('The ranking draft changed.');});
  });
  button('Review opening funded Boss Pool',async()=>{
    const pool='pool.'+operator;
    const account_id=document.querySelector('#pool-player').value.trim();
    const match_id=document.querySelector('#pool-match').value.trim();
    if(!/^[a-z0-9][a-z0-9._-]{0,55}\.testnet$/.test(account_id)||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(match_id))throw Error('Enter a Testnet account and its recorded Boss match ID.');
    async function verifyEligibility(){
      const [state,finished,{header}]=await Promise.all([
        query(pool,'get_pool'),query(pool,'get_boss_clear',{account_id,match_id}),rpc('block',{finality:'final'}),
      ]);
      const now=Number(BigInt(header.timestamp_nanosec)/1000000n);
      if(state.opened_at_ms!==null||state.reward_available!==(1500n*unit).toString())throw Error('Pool is already open or its reward budget is incomplete.');
      if(!Number.isSafeInteger(finished)||finished>now||now-finished>=86400000)throw Error('A finalized Boss clear from the past 24 hours is required.');
      return now;
    }
    const starts_at_ms=await verifyEligibility()+15*60000;
    choose('Open Boss Pool',pool,[call('open_campaign',{starts_at_ms})],
      'Open the funded 7-day campaign. Registration closes when staking begins at '+new Date(starts_at_ms).toISOString()+'.',
      async()=>{if(await verifyEligibility()>=starts_at_ms)throw Error('Start time expired. Review again.');});
  });
}
async function refreshFoxStatus(){
  const state=await rpc('query',{request_type:'view_account',account_id:manifest.collectionId,finality:'final'});
  const upgraded=state.code_hash==='BbWs3VA5oLmRgJTbMusFSuLj7MByeDXFrT7VUqboV8gq';
  elements['fox-status'].textContent=(upgraded?'Upgrade finalized':'Upgrade not finalized')+' · Block '+state.block_height;
  return {upgraded};
}
function renderFoxActions(){
  elements['fox-actions'].replaceChildren();
  button('Review Fox ownership upgrade',async()=>{
    if(!pins.verifiedCollectionUpgrade)throw Error('Collection upgrade rehearsal with the deployed Wasm is pending.');
    const collection=manifest.collectionId;
    if(connected?.accountId!==collection)throw Error('Switch Intear to '+collection+' before reviewing this upgrade.');
    const legacyHash='2Pz9L3EUc9p4VyySqVrn8YKs2kuuWMbDpmFveq4r5h28';
    const check=async()=>{
      const state=await rpc('query',{request_type:'view_account',account_id:collection,finality:'final'});
      if(state.code_hash!==legacyHash)throw Error('The collection code differs from the reviewed upgrade source.');
      if(await query(collection,'nft_total_supply')!=='88')throw Error('Unexpected Fox supply.');
    };
    if((await refreshFoxStatus()).upgraded)throw Error('Fox ownership upgrade is already finalized.');
    await check();
    const keys=await rpc('query',{request_type:'view_access_key_list',account_id:collection,finality:'final'});
    if(!connected.publicKey||!keys.keys.some(row=>row.public_key===connected.publicKey&&row.access_key.permission==='FullAccess')){
      throw Error('Intear must expose the connected public key and that key must have FullAccess on the Fox collection.');
    }
    const file=document.querySelector('#fox-wasm').files[0];
    const artifact=file ?? await fetch(foxOwnershipWasm,{signal:AbortSignal.timeout(10000)});
    if(!file&&!artifact.ok)throw Error('Reviewed Fox upgrade Wasm is unavailable.');
    const bytes=new Uint8Array(await artifact.arrayBuffer());
    const digest=new Uint8Array(await crypto.subtle.digest('SHA-256',bytes));
    const hash=Array.from(digest,byte=>byte.toString(16).padStart(2,'0')).join('');
    if(hash!==collectionUpgradeHash||!WebAssembly.validate(bytes))throw Error('Fox upgrade artifact does not match the reviewed hash.');
    class ContractCode extends Uint8Array {toJSON(){return Array.from(this);}}
    review={transaction:{signerId:collection,receiverId:collection,actions:[action.deployContract(new ContractCode(bytes))]},beforeSign:check,foxOnly:true};
    elements.review.textContent=JSON.stringify({network:'near-testnet',signer:collection,receiver:collection,
      action:'Deploy ownership epoch code using existing collection state',sha256:hash,bytes:bytes.length,supply:88},null,2);
  },elements['fox-actions']);
  elements['fox-actions'].querySelector('button').disabled=connected?.accountId!==manifest.collectionId;
  button('Check finalized Fox upgrade',()=>refreshFoxStatus(),elements['fox-actions']);
  elements['fox-actions'].lastElementChild.disabled=false;
}
function renderPoolActions(){
  const container=elements['pool-actions'];
  container.replaceChildren();
  elements['pool-status'].textContent=connected ? 'Connected: '+connected.accountId : 'Connect Intear to review a Pool transaction.';
  button('Review Boss Pool upgrade',async()=>{
    const pool=poolDeployment.accountId;
    if(connected?.accountId!==pool)throw Error('Connect the existing Pool account to deploy its upgrade: '+pool);
    const check=async()=>{
      const code=await rpc('query',{request_type:'view_account',account_id:pool,finality:'final'});
      if(code.code_hash!==poolDeployment.codeHash)throw Error('Pool code changed.');
      const keys=await rpc('query',{request_type:'view_access_key_list',account_id:pool,finality:'final'});
      if(!connected.publicKey||!keys.keys.some(row=>row.public_key===connected.publicKey&&row.access_key.permission==='FullAccess'))
        throw Error('Select the Pool account key with FullAccess.');
    };
    await check();
    const response=await fetch(poolUpgradeWasm);
    if(!response.ok)throw Error('Pool Wasm unavailable.');
    const bytes=new Uint8Array(await response.arrayBuffer());
    const sha=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),x=>x.toString(16).padStart(2,'0')).join('');
    if(sha!==poolDeployment.upgradeSha256||!WebAssembly.validate(bytes))throw Error('Pool Wasm verification failed.');
    class ContractCode extends Uint8Array {toJSON(){return Array.from(this);}}
    review={transaction:{signerId:pool,receiverId:pool,actions:[action.deployContract(new ContractCode(bytes))]},beforeSign:check,poolOnly:true};
    elements.review.textContent=JSON.stringify({network:'near-testnet',receiver:pool,sha,
      description:'Enable Boss clears and registration through campaign end.'},null,2);
  },elements['pool-actions']);
  button('Review activating upgraded Boss Pool',async()=>{
    const pool=poolDeployment.accountId;
    const check=async()=>{
      const code=await rpc('query',{request_type:'view_account',account_id:pool,finality:'final'});
      const state=await query(pool,'get_pool');
      if(code.code_hash!==poolDeployment.upgradeCodeHash||state.opened_at_ms!==null||
        state.reward_available!==(1500n*unit).toString())throw Error('An upgraded, unopened and funded Pool is required.');
    };
    await check();
    const {header}=await rpc('block',{finality:'final'});
    const starts_at_ms=Number(BigInt(header.timestamp_nanosec)/1000000n)+10*60000;
    choose('Activate upgraded Boss Pool',pool,[
      call('set_receipt_signer',{signer_id:poolDeployment.upgradeSignerId}),call('open_campaign',{starts_at_ms}),
    ],'Enable relay-verified Boss clears and open the 7-day funded campaign.',
    async()=>{await check();if(Date.now()>=starts_at_ms)throw Error('Start time expired. Review again.');});
    review.poolOnly=true;
  },elements['pool-actions']);
  const [upgrade,activate]=container.querySelectorAll('button');
  upgrade.disabled=connected?.accountId!==poolDeployment.accountId;
  activate.disabled=connected?.accountId!==operator;
}
async function verifyCode(){
  const {header}=await rpc('block',{finality:'final'});
  await Promise.all(manifest.modules.map(async ({accountId:account_id})=>{
    const expected=pins[account_id];
    const observed=await rpc('query',{request_type:'view_account',account_id,block_id:header.hash});
    if(observed.block_hash!==header.hash||(observed.code_hash!==expected&&
        !(account_id===economy&&[catalogueUpgrade.codeHash,professionUpgrade.codeHash,guildMissionUpgrade.codeHash].includes(observed.code_hash))&&
        !(account_id===poolDeployment.accountId&&observed.code_hash===poolDeployment.upgradeCodeHash)))throw Error('Code changed for '+account_id);
  }));
}
async function verifySigner(spec){
  const keys=await rpc('query',{request_type:'view_access_key_list',account_id:spec.accountId,finality:'final'});
  if(!keys.keys.some(row=>row.public_key===spec.publicKey&&row.access_key.permission==='FullAccess'))throw Error('Create the reviewed signer account first.');
}
async function run(operation){
  if(busy)return;busy=true;elements.confirm.disabled=true;
  try{if(operation)await operation();else await refresh();}
  catch(error){elements.status.textContent=error.message;elements.review.textContent=error.message;elements['pool-status'].textContent=error.message;elements['fox-status'].textContent=error.message;review=null;}
  finally{busy=false;elements.confirm.disabled=!review;}
}
elements.connect.onclick=()=>run(async()=>{
  wallet??=await openNearWallet();
  const prior=connected;
  connected=null;
  renderPoolActions();
  renderFoxActions();
  review=null;
  if(prior)await wallet.signOut();
  [connected]=await wallet.signIn({});
  if(![operator,economy,manifest.collectionId,poolDeployment.accountId,pilotKeys.quartermaster.accountId].includes(connected?.accountId)){
    connected=null;
    throw Error('Choose the operator, Economy, Fox collection, Boss Pool, or Quartermaster account.');
  }
  elements.connect.textContent='Switch Intear account ('+connected.accountId+')';
  renderPoolActions();
  renderFoxActions();
  if(connected.accountId===manifest.collectionId){
    await refreshFoxStatus();
  }else if(connected.accountId!==poolDeployment.accountId){
    try{await refresh();}catch(error){elements.status.textContent=error.message;}
  }
});
elements.refresh.onclick=()=>run(async()=>{review=null;await refresh();});
elements.confirm.onclick=()=>run(async()=>{
  const selected=review;if(!selected)throw Error('Choose an operation first.');
  review=null;
  if(!selected.poolOnly&&!selected.foxOnly)await verifyCode();
  if(selected.authorize){await selected.authorize();return;}
  await selected.beforeSign?.();
  if(connected?.accountId!==selected.transaction.signerId)throw Error('Switch Intear to '+selected.transaction.signerId+' before signing.');
  const result=await wallet.signAndSendTransaction(selected.transaction);
  if(selected.foxOnly){
    const hash=result?.transaction?.hash ?? result?.transaction_outcome?.id;
    if(hash) elements.review.textContent='Fox upgrade transaction: '+hash;
    const state=await refreshFoxStatus();
    if(!state.upgraded)throw Error('Wallet returned, but Fox upgrade has not finalized. Check finalized status before signing again.');
    return;
  }
  if(typeof result?.status?.SuccessValue!=='string')throw Error('Outcome unknown. Refresh finalized status.');
  await refresh();
});
renderPoolActions();
renderFoxActions();
run();


