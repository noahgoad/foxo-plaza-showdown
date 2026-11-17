import { collectionBrowser } from './near-collection-browser.js';
import { economyPanelActive, economyPanel, economyTabs } from './near-economy-page.js';
import { h } from './ui-util.js';
import { NEAR_TESTNET, nearRelayUrl, formatFoxo, viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { economyDeployment, catalogueRecipes } from '../../assets/near-fox/economy-deployment.js';
import { listingDraft, buySaleDraft, listingMatches, purchaseConfirmed, saleTermsMatch } from '../economy/near-sales.js';
import { openNearOrders } from './near-orders-ui.js';
import { cosmeticCardInfo, marketCard, marketSection, marketPicker } from './near-market-card.js';
const GAS=100n*10n**12n, DAY=86400000;
const decimal=value=>{const digits=value.padStart(25,'0');return digits.slice(0,-24)+'.'+digits.slice(-24);};

export function openNearSales(menu,back,host){
 const identity=menu._identity, account=identity?.kind==='wallet'&&identity.config?.network===NEAR_TESTNET.network?identity.address:null;
 const economy=economyDeployment.accountId,wallet=menu.chogWallet;
 const modal = economyPanel(menu, host, {title:'COSMETIC MARKET',text:!account?'Connect Intear to trade crafted cosmetics.':!economy?'Cosmetic sales are awaiting their Testnet deployment.':'Loading cosmetic market…',buttons:[{label:'MARKET WALLET',accept:()=>{if(host)return menu._go('economyOrders');menu._closeModal(true);openNearOrders(menu,()=>{menu._closeModal(true);openNearSales(menu,back);});}},{label:'BACK',accept:back}]});
 if(!account||!economy)return;
 const status=modal.querySelector('.iw-modal__text'),body=h('div',{class:'chog-workshop-body'});
  modal.classList.add('near-game-panel','near-market-panel');
 modal.classList.add('chog-workshop-modal');status.setAttribute('role','status');status.setAttribute('aria-live','polite');modal.querySelector('.iw-modal__btns').before(body);
 const active=()=>economyPanelActive(menu, host, modal)&&menu._identity===identity&&identity.kind==='wallet'&&identity.address===account&&identity.config?.network===NEAR_TESTNET.network;
 const key='fox-cosmetic-sale:'+economy+':'+account;
 let busy=false,prepared=null;
 const itemSelect=h('select',{id:'sale-item','aria-label':'Owned cosmetic'}),price=h('input',{id:'sale-price',type:'text',inputmode:'decimal',autocomplete:'off'}),saleInput=h('input',{id:'sale-id',type:'text',maxlength:129,autocomplete:'off',spellcheck:'false'});
 const quote=h('p',{id:'sale-quote',role:'status'}),detail=h('div',{id:'sale-detail'});
 const collection=h('div',{class:'near-market-grid','aria-label':'Owned cosmetic cards'});
 const button=(id,label,fn)=>menu._btn({id,label,accept:()=>act(fn),cls:'iw-btn--small'});
 const field=(label,input)=>h('label',{class:'fox-order-field'},h('span',null,label),input);
 for(const input of [itemSelect,price,saleInput])input.addEventListener('keydown',event=>{if(event.key!=='Escape')event.stopPropagation();});
 async function act(fn){if(busy||!active())return;busy=true;try{await fn();}catch(error){if(active())status.textContent=error.message||'Market request failed.';}finally{busy=false;}}
 async function verifiedSnapshot(){
  const code=await readNearAccountCode(economy);
  if(!economyDeployment.acceptedCodeHashes.includes(code.codeHash))throw new Error('Market contract code has not been verified for this deployment.');
  const view=async(method,args={})=>{const result=await viewNearContract(economy,method,args,{blockId:code.blockHash});if(result.blockHash!==code.blockHash)throw new Error('Market snapshot changed. Refresh before continuing.');return result.value;};
  const [config,enabled,charge]=await Promise.all([view('get_config'),view('get_sales_enabled'),view('get_cosmetic_sale_storage_charge')]);
  if(config.network!==NEAR_TESTNET.network||config.foxoContractId!==NEAR_TESTNET.token||config.marketFeeBps!==250)throw new Error('Market configuration does not match this game.');
  if(!active())throw new Error('Wallet or screen changed.');
  return {view,enabled,charge};
 }
 async function sign(receiverId,method,args,deposit,preflight){
  await wallet.prepareWallet();
  const snap=await verifiedSnapshot();await preflight(snap);
  if(!active())throw new Error('Wallet or screen changed.');
  const result=await wallet.intear.signAndSendTransaction({signerId:account,receiverId,actions:[wallet.nearActions.functionCall(method,args,GAS,BigInt(deposit))]});
  if(typeof result?.status?.SuccessValue!=='string')throw new Error('Transaction outcome is unavailable. The saved operation is retained; refresh before retrying.');
 }
 function saved(){
  const raw=localStorage.getItem(key);if(!raw)return null;
  const value=JSON.parse(raw);let rebuilt;
  if(value.kind==='list')rebuilt=listingDraft({economy,seller:account,operationId:value.args?.operation_id,item:{...value.expected,ownerId:account},transferVersion:value.expected?.transferVersion,price:decimal(value.expected.priceAtomic),expiresAtMs:value.expected.expiresAtMs,storageCharge:value.deposit,now:Math.min(Date.now(),value.expected.expiresAtMs-1)});
  else if(value.kind==='buy')rebuilt=buySaleDraft({economy,token:NEAR_TESTNET.token,buyer:account,operationId:value.operationId,saleId:value.saleId,sale:{...value.expected,status:'open'},currentVersion:value.expected?.transferVersion,now:Math.min(Date.now(),value.expected.expiresAtMs-1)});
  if(!rebuilt||JSON.stringify(rebuilt)!==JSON.stringify(value))throw new Error('Saved market operation does not match this wallet or deployment.');
  return rebuilt;
 }
 function review(draft,isSaved=false){
  prepared=draft;confirm.disabled=false;
  const e=draft.expected,amount=formatFoxo(e.priceAtomic);
  quote.textContent=(isSaved?'Saved operation · ':'')+(draft.kind==='list'?'LIST ':'BUY ')+e.itemId+' · Gross '+amount+' FOXO · Fee '+formatFoxo(draft.quote.feeAtomic)+' FOXO · Seller receives '+formatFoxo(draft.quote.netAtomic)+' FOXO'+
   (draft.kind==='list'?' · Native storage charge '+formatFoxo(draft.deposit)+' NEAR ('+draft.deposit+' yoctoNEAR; retained after cancellation)':' · Attach 1 yoctoNEAR')+
   ' · Expires '+new Date(e.expiresAtMs).toLocaleString()+'. Wallet network gas is additional.';
 }
 async function saleState(snap,id){
  const sale=await snap.view('get_cosmetic_sale',{sale_id:id});
  if(!sale)throw new Error('Sale is unavailable.');
  const [item,version]=await Promise.all([snap.view('get_item',{item_id:sale.itemId}),snap.view('get_cosmetic_item_version',{item_id:sale.itemId})]);
  return {sale,item,version};
 }
 async function checkPurchase(snap,draft){
  const [{sale,item},receipt]=await Promise.all([saleState(snap,draft.saleId),snap.view('get_cosmetic_purchase',{account_id:account,operation_id:draft.operationId})]);
  return purchaseConfirmed(sale,item,receipt,draft);
 }
 async function refresh(){
  prepared=null;confirm.disabled=true;quote.textContent='';
  const snap=await verifiedSnapshot();
  const [items,credit]=await Promise.all([snap.view('get_owned_items',{account_id:account,offset:0,limit:50}),snap.view('get_order_credit',{account_id:account})]);
  if(!active())return;
  itemSelect.replaceChildren(...items.filter(item=>item.ownerId===account).map(item=>h('option',{value:item.itemId},item.sku+' · '+item.itemId)));
  for (const card of collection.children) menu._binds.delete(card);
  collection.replaceChildren(...items.filter(item=>item.ownerId===account).map(item=>
    marketPicker(menu, 'cosmetic-card-' + item.itemId, cosmeticCardInfo(item.sku), () => {
      itemSelect.value=item.itemId;
      itemSelect.dispatchEvent(new Event('input',{bubbles:true}));
    })));
  itemSelect.dispatchEvent(new Event('input'));
  reviewList.disabled=!snap.enabled||!itemSelect.options.length;
  status.textContent='Market wallet: '+formatFoxo(credit)+' FOXO.'+(snap.enabled?'':' New listings and purchases are paused.')+(localStorage.getItem(key)?' A saved operation needs review.':'');
 }
 async function find(){
  const snap=await verifiedSnapshot(),id=saleInput.value.trim();
  if(!/^[a-z0-9_.-]{2,64}:[a-zA-Z0-9-]{1,64}$/.test(id))throw new Error('Enter a valid cosmetic sale ID.');
  const {sale,item,version}=await saleState(snap,id);if(!active())return;
  for(const node of detail.querySelectorAll('[data-nav]'))menu._binds.delete(node);
  const stale=item?.ownerId!==sale.sellerId||version!==sale.transferVersion;
  detail.replaceChildren(h('div',{class:'near-market-feature'},
   marketCard({...cosmeticCardInfo(sale.sku),caption:formatFoxo(sale.priceAtomic)+' FOXO'}),
   h('div',null,h('strong',null,stale?'Ownership changed':sale.status.toUpperCase()),
    h('p',null,'Expires '+new Date(sale.expiresAtMs).toLocaleString()))));
  if(sale.status==='open'&&sale.sellerId===account)detail.append(button('sale-cancel','CANCEL LISTING',async()=>{
   await sign(economy,'cancel_cosmetic_sale',{sale_id:id},'1',async fresh=>{const row=await fresh.view('get_cosmetic_sale',{sale_id:id});if(row?.sellerId!==account||row.status!=='open')throw new Error('Sale changed. Refresh.');});
   const fresh=await verifiedSnapshot();if((await fresh.view('get_cosmetic_sale',{sale_id:id}))?.status!=='cancelled')throw new Error('Cancellation is awaiting confirmation.');
   await find();if(active())status.textContent='Listing cancellation confirmed. No FOXO principal was charged.';
  }));
  else if(snap.enabled&&sale.status==='open'&&!stale&&sale.expiresAtMs>Date.now())detail.append(button('sale-buy-review',host?'BUY FOR '+formatFoxo(sale.priceAtomic)+' FOXO':'REVIEW PURCHASE',async()=>{
   if(localStorage.getItem(key)){review(saved(),true);return;}
   const fresh=await verifiedSnapshot(),current=await saleState(fresh,id);
   if(!fresh.enabled)throw new Error('Purchases are paused.');
   if(host&&(current.sale?.priceAtomic!==sale.priceAtomic||current.version!==version))throw new Error('Listing changed. Reopen it before buying.');
   review(buySaleDraft({economy,token:NEAR_TESTNET.token,buyer:account,operationId:crypto.randomUUID(),saleId:id,sale:current.sale,currentVersion:current.version}));
   if(host)await submitPrepared();
  }));
 }
 async function submitPrepared(){
  const draft=prepared;if(!draft)return;
  const snap=await verifiedSnapshot();
  if(draft.kind==='list'){
   const existing=await snap.view('get_cosmetic_sale',{sale_id:draft.id});
   if(existing&&!listingMatches(existing,draft))throw new Error('Saved listing ID has different terms.');
   if(!existing){
    localStorage.setItem(key,JSON.stringify(draft));
    await sign(economy,'create_cosmetic_sale',draft.args,draft.deposit,async fresh=>{
     const [item,version]=await Promise.all([fresh.view('get_item',{item_id:draft.expected.itemId}),fresh.view('get_cosmetic_item_version',{item_id:draft.expected.itemId})]);
     if(!fresh.enabled||fresh.charge!==draft.deposit||item?.ownerId!==account||version!==draft.expected.transferVersion||draft.expected.expiresAtMs<=Date.now()||item.sku!==draft.expected.sku||item.recipeId!==draft.expected.recipeId||item.recipeVersion!==draft.expected.recipeVersion)throw new Error('Listing cost, ownership or expiry changed. Refresh and review again.');
    });
    const fresh=await verifiedSnapshot();if(!listingMatches(await fresh.view('get_cosmetic_sale',{sale_id:draft.id}),draft))throw new Error('Listing is not confirmed. The saved operation is retained.');
   }
   if(active()){saleInput.value=draft.id;status.textContent='Listing confirmed. Share its sale ID.';}
  }else{
   if(!await checkPurchase(snap,draft)){
    localStorage.setItem(key,JSON.stringify(draft));
    await sign(draft.receiverId,'ft_transfer_call',draft.args,'1',async fresh=>{
     const {sale,item,version}=await saleState(fresh,draft.saleId);
     if(!fresh.enabled||!saleTermsMatch(sale,draft,version)||sale.expiresAtMs<=Date.now()||item?.ownerId!==sale.sellerId)throw new Error('Sale changed or is paused. Refresh before signing.');
    });
    if(!await checkPurchase(await verifiedSnapshot(),draft))throw new Error('Purchase is not confirmed. It may be pending or refunded; the saved operation is retained.');
   }
   if(active())status.textContent='Purchase confirmed by its operation receipt and delivered item ownership.';
  }
  if(!active())return;localStorage.removeItem(key);prepared=null;confirm.disabled=true;quote.textContent='';
 }
 const confirm=button('sale-confirm','CONFIRM IN WALLET',submitPrepared);confirm.disabled=true;
 const reviewList=button('sale-list-review',host?'LIST ITEM':'REVIEW LISTING',async()=>{
  if(localStorage.getItem(key)){review(saved(),true);return;}
  const snap=await verifiedSnapshot(),itemId=itemSelect.value;
  if(!snap.enabled)throw new Error('New listings are paused.');
  const [item,version]=await Promise.all([snap.view('get_item',{item_id:itemId}),snap.view('get_cosmetic_item_version',{item_id:itemId})]);
  review(listingDraft({economy,seller:account,operationId:crypto.randomUUID(),item,transferVersion:version,price:price.value.trim(),expiresAtMs:Date.now()+DAY,storageCharge:snap.charge}));
  if(host)await submitPrepared();
 });reviewList.disabled=true;
 const discard=button('sale-discard-closed','DISCARD CLOSED REVIEW',async()=>{
  const draft=saved();if(!draft)throw new Error('No saved market operation.');
  const snap=await verifiedSnapshot();
  if(draft.kind==='list'){
   const sale=await snap.view('get_cosmetic_sale',{sale_id:draft.id});
   if(!sale||!listingMatches(sale,draft))throw new Error('Listing outcome is unresolved. Keep its saved operation and check again.');
  }else{
   const {sale,version}=await saleState(snap,draft.saleId);
   if(sale.status==='open'&&sale.transferVersion===version)throw new Error('Purchase outcome is unresolved. Keep its saved operation and check again.');
  }
  if(!active())return;
  localStorage.removeItem(key);prepared=null;confirm.disabled=true;quote.textContent='';
  status.textContent='Closed review discarded. This does not cancel a transaction or change an existing sale.';
 });
 const categoryFor = sku => sku.includes('finish') ? 'Weapon finishes' : sku.includes('outfit') ? 'Outfits' : 'Other';
 const catalogue = [...new Set([...economyDeployment.recipes,...catalogueRecipes].map(entry=>entry.sku))]
   .map(sku=>({...cosmeticCardInfo(sku),id:sku,category:categoryFor(sku),caption:'Catalogue',
     open:()=>{if(!busy){prepared=null;confirm.disabled=true;quote.textContent='';detail.replaceChildren(
       marketCard(cosmeticCardInfo(sku)),h('p',null,'No verified listing is displayed for this item.'));}}}));
 const browser = host ? collectionBrowser(menu, detail) : null;
 if(browser) browser.update(catalogue,'Checking listings…');
 async function loadListings() {
   try {
     const response = await fetch(nearRelayUrl()+'/near/market/cosmetics',{signal:AbortSignal.timeout(5000)});
     if (!response.ok) throw Error();
     const { ids } = await response.json();
     if (!ids.length) { if(active()) browser.update(catalogue,'No active listings found in the index.'); return; }
     const snap = await verifiedSnapshot();
     const rows = [];
     let partial = false;
     for(let offset=0;offset<ids.length;offset+=5){
       if (!active()) return;
       const results = await Promise.allSettled(ids.slice(offset,offset+5).map(async id=>({id,...await saleState(snap,id)})));
       for(const result of results) {
         if(result.status==='fulfilled') rows.push(result.value);
         else partial = true;
       }
     }
     if (!active()) return;
     const open = rows.filter(({sale,item,version})=>sale.status==='open'&&sale.expiresAtMs>Date.now()&&
       item?.sku===sale.sku&&item.ownerId===sale.sellerId&&version===sale.transferVersion);
     browser.update([...open.map(({id,sale})=>({
       ...cosmeticCardInfo(sale.sku),id,category:categoryFor(sale.sku),price:sale.priceAtomic,
       open:()=>act(async()=>{saleInput.value=id;await find();}),
     })),...catalogue.filter(row=>!open.some(({sale})=>sale.sku===row.id))],
       partial?'Some listings could not be verified.':'');
   } catch { if(active()) browser.update(catalogue,'Listing feed unavailable. Search by Sale ID.'); }
 }
 const lookup = h('div',{class:'near-market-search'},field('Sale ID',saleInput),button('sale-find','FIND SALE',find));
 const browse = host ? h('div',null,browser.el,h('details',null,h('summary',null,'Find by Sale ID'),lookup))
   : marketSection('FIND A SALE',lookup,detail);
 const inventory = marketSection('YOUR COSMETICS', collection, h('p',{class:'near-market-empty'},'No crafted cosmetics in this wallet.'),
   field('Owned cosmetic',itemSelect),field('List price in FOXO',price),reviewList);
 const accountPanel = marketSection('TRANSACTIONS', h('div',{class:'near-market-actions'},
   button('sale-review-saved','REVIEW SAVED OPERATION',async()=>{const draft=saved();if(!draft)throw new Error('No saved market operation.');review(draft,true);}),
   discard,button('sales-refresh','REFRESH',async()=>{await refresh();if(host) await loadListings();})));
 if (host) body.append(economyTabs(menu, [['BUY',browse],['SELL',inventory],['ACTIVITY',accountPanel]]),
   h('div',{class:'near-market-review'},quote,confirm));
 else {accountPanel.append(quote,confirm);body.append(h('div',{class:'near-market-layout'},inventory,browse),accountPanel);}
 itemSelect.addEventListener('input',()=>[...collection.children].forEach((card,i)=>{
  const selected=itemSelect.selectedIndex===i;card.classList.toggle('is-selected',selected);card.setAttribute('aria-pressed',String(selected));
 }));
 for(const input of [itemSelect,price])input.addEventListener('input',()=>{prepared=null;confirm.disabled=true;quote.textContent='';});
 act(refresh);
 if(host) void loadListings();
}
