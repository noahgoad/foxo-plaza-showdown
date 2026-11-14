import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
const root=new URL('../../',import.meta.url);
const executablePath=[process.env.CHOG_BROWSER_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium'].find(path=>path&&existsSync(path));
test('cosmetic market reviews exact native/FT costs, persists before wallet, recovers receipts and blocks mutated identity or code',{skip:!executablePath},async()=>{
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');return res.end('<html><body><main></main></body></html>');}
  if(path==='/assets/near-fox/economy-deployment.js'){res.setHeader('Content-Type','text/javascript');return res.end("export const economyDeployment={accountId:'economy.testnet',codeHash:'verified-code',acceptedCodeHashes:['verified-code'],recipes:[]};export const catalogueRecipes=[];");}
  if(!/^\/(src|assets\/near-fox)\/[a-z0-9/.-]+\.(js|json)$/i.test(path)||path.includes('..'))return res.writeHead(404).end();
  try{res.setHeader('Content-Type',path.endsWith('.json')?'application/json':'text/javascript');res.end(await readFile(new URL('.'+path,root)));}catch{res.writeHead(404).end();}
 });
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 try{
  browser=await puppeteer.launch({executablePath,headless:true});const page=await browser.newPage();
  await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const {openNearSales}=await import('/src/ui/near-sales-ui.js');
   const seller='alice.testnet',buyer='bob.testnet',foxo='foxo.xuancanh1.testnet';
   let item={itemId:seller+':one',ownerId:seller,sku:'finish-a',recipeId:'finish',recipeVersion:1},sale=null,receipt=null;
   window.transactions=[];window.pendingAtSign=[];window.salesEnabled=true;window.code='verified-code';window.listAttempts=0;window.buyAttempts=0;
   const realFetch=window.fetch;window.fetch=async(url,options)=>{
    if(!String(url).startsWith('https://near-testnet.drpc.org'))return realFetch(url,options);
    const {params}=JSON.parse(options.body);
    if(params.request_type==='view_account')return new Response(JSON.stringify({result:{code_hash:window.code,block_hash:'block-final'}}));
    if(params.block_id!=='block-final')throw new Error('Expected pinned finalized reads');
    const value={get_config:{network:'near-testnet',foxoContractId:foxo,marketFeeBps:250},get_sales_enabled:window.salesEnabled,get_cosmetic_sale_storage_charge:'40960000000000000000000',get_owned_items:item.ownerId===window.menu._identity.address?[item]:[],get_order_credit:'0',get_cosmetic_sale:sale,get_item:item,get_cosmetic_item_version:2,get_cosmetic_purchase:receipt}[params.method_name];
    return new Response(JSON.stringify({result:{result:[...new TextEncoder().encode(JSON.stringify(value))],block_hash:'block-final'}}));
   };
   const btn=(id,label,fn)=>{const el=document.createElement('button');el.id=id;el.textContent=label;el.addEventListener('click',fn);return el;};
   const menu={_identity:{kind:'wallet',address:seller,config:{network:'near-testnet'}},_binds:new Map(),_btn:({id,label,accept})=>btn(id,label,accept),_closeModal(){this._modal?.remove();},_openModal({title,text,buttons}){this._modal?.remove();this._modal=document.createElement('section');const status=document.createElement('p');status.className='iw-modal__text';status.textContent=text;const actions=document.createElement('div');actions.className='iw-modal__btns';for(const [i,b]of buttons.entries())actions.append(btn('modal-'+i,b.label,b.accept));this._modal.append(title,status,actions);document.querySelector('main').append(this._modal);},chogWallet:{prepareWallet:async()=>{},nearActions:{functionCall:(method,args,gas,deposit)=>({method,args,gas:gas.toString(),deposit:deposit.toString()})},intear:{async signAndSendTransaction(tx){window.transactions.push(tx);window.pendingAtSign.push(localStorage.getItem('fox-cosmetic-sale:economy.testnet:'+tx.signerId));const a=tx.actions[0];if(a.method==='create_cosmetic_sale'&&++window.listAttempts===2){sale={sellerId:seller,itemId:item.itemId,sku:item.sku,recipeId:item.recipeId,recipeVersion:1,transferVersion:2,priceAtomic:a.args.price_atomic,expiresAtMs:a.args.expires_at_ms,status:'open',buyerId:null};window.saleId=seller+':'+a.args.operation_id;}if(a.method==='cancel_cosmetic_sale')sale={...sale,status:'cancelled'};if(a.method==='ft_transfer_call'&&++window.buyAttempts===2){const terms=JSON.parse(a.args.msg);sale={...sale,status:'sold',buyerId:buyer,purchaseOperationId:terms.operationId};item={...item,ownerId:buyer};receipt=terms.saleId;}return{status:{SuccessValue:''}};}}}};
   window.resetOpenSale=()=>{sale={...sale,status:'open'};};window.menu=menu;window.openMarket=()=>openNearSales(menu,()=>menu._closeModal());window.openMarket();
  });
  await page.waitForFunction(()=>!document.querySelector('#sale-list-review').disabled);
  assert.equal(await page.evaluate(()=>window.transactions.length),0);
  await page.type('#sale-price','0.000000000000000000010001');await page.click('#sale-list-review');
  await page.waitForFunction(()=>document.querySelector('#sale-quote').textContent.includes('40960000000000000000000 yoctoNEAR'));
  await page.click('#sale-confirm');await page.waitForFunction(()=>document.body.innerText.includes('Listing is not confirmed'));
  await page.evaluate(()=>window.openMarket());await page.waitForFunction(()=>!document.querySelector('#sale-list-review').disabled);
  await page.click('#sale-review-saved');await page.waitForFunction(()=>document.querySelector('#sale-quote').textContent.includes('Saved operation'));
  await page.click('#sale-confirm');await page.waitForFunction(()=>document.body.innerText.includes('Listing confirmed'));
  let txs=await page.evaluate(()=>window.transactions);assert.deepEqual(txs[0].actions,txs[1].actions);assert.equal(txs[0].actions[0].deposit,'40960000000000000000000');
  await page.evaluate(()=>{window.menu._identity={kind:'wallet',address:'bob.testnet',config:{network:'near-testnet'}};window.openMarket();});
  await page.waitForSelector('#sale-id');await page.type('#sale-id',await page.evaluate(()=>window.saleId));await page.click('#sale-find');await page.waitForSelector('#sale-buy-review');await page.click('#sale-buy-review');
  await page.waitForFunction(()=>document.querySelector('#sale-quote').textContent.includes('0.00000000000000000000025 FOXO'));
  await page.click('#sale-confirm');await page.waitForFunction(()=>document.body.innerText.includes('Purchase is not confirmed'));
  await page.evaluate(()=>window.openMarket());await page.click('#sale-review-saved');await page.waitForFunction(()=>!document.querySelector('#sale-confirm').disabled);await page.click('#sale-confirm');
  await page.waitForFunction(()=>document.body.innerText.includes('Purchase confirmed by its operation receipt'));
  txs=await page.evaluate(()=>window.transactions);assert.deepEqual(txs[2].actions,txs[3].actions);assert.equal(txs[2].actions[0].args.amount,'10001');assert.ok((await page.evaluate(()=>window.pendingAtSign)).every(Boolean));
  await page.evaluate(()=>{window.salesEnabled=false;window.resetOpenSale();window.menu._identity={kind:'wallet',address:'alice.testnet',config:{network:'near-testnet'}};window.openMarket();});
  await page.type('#sale-id',await page.evaluate(()=>window.saleId));await page.click('#sale-find');await page.waitForSelector('#sale-cancel');await page.click('#sale-cancel');
  await page.waitForFunction(()=>document.body.innerText.includes('Listing cancellation confirmed'));
  await page.evaluate(()=>{window.code='wrong-code';window.openMarket();});
  await page.waitForFunction(()=>document.body.innerText.includes('Market contract code has not been verified'));
  assert.equal(await page.evaluate(()=>window.transactions.length),5);
  await page.evaluate(()=>{window.code='verified-code';window.salesEnabled=true;window.menu._identity={kind:'wallet',address:'bob.testnet',config:{network:'near-testnet'}};window.openMarket();});
  await page.waitForFunction(()=>!document.querySelector('#sale-list-review').disabled);await page.type('#sale-price','1');await page.click('#sale-list-review');await page.waitForFunction(()=>!document.querySelector('#sale-confirm').disabled);
  await page.evaluate(()=>{window.menu.chogWallet.prepareWallet=async()=>{window.menu._identity.address='mutated.testnet';};});await page.click('#sale-confirm');
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal(await page.evaluate(()=>window.transactions.length),5);
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

