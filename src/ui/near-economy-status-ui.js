import { economyPanelActive, economyPanel } from './near-economy-page.js';
import { openNearRanking } from './near-ranking-ui.js';
import { h } from './ui-util.js';
import { formatFoxo, nearRelayUrl, NEAR_TESTNET, viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { marketDeployment } from '../../assets/near-fox/market-deployment.js';
import { verifyEconomyDeployment } from '../economy/near-deployment.js';

export function openEconomyStatus(menu,back,host){
  let busy=false;
  const modal = economyPanel(menu, host, {title:'PLAYER DESK',text:'Loading finalized activity…',buttons:[
    ...(host ? [
      {label:'BUY ORDERS',accept:()=>menu._go('economyOrders')},
      {label:'NFT RIGHTS',accept:()=>{
        const nft=menu._identity?.nft;
        if (!nft?.tokenId || !nft.contract) return menu._go('locker');
        menu._passportNft=nft;
        return menu._go('foxPassport');
      }},
    ] : []),
    {label:'RANKING',accept:()=>{
      if (host) return menu._go('economyRanking');
      menu._closeModal(true);
      openNearRanking(menu,()=>{menu._closeModal(true);openEconomyStatus(menu,back);});
    }},
    {label:'REFRESH',accept:()=>refresh()},
    {label:'BACK',accept:back},
  ]});
  
  modal.classList.add('near-game-panel');
  const status=modal.querySelector('.iw-modal__text');
  const desk=h('section',{class:'fox-feature-card','aria-label':'Wallet and account activity'});
  const body=h('div',{class:'chog-workshop-body economy-dashboard'});
  modal.querySelector('.iw-modal__btns').before(desk, body);
  let deskRequest = 0;
  async function refreshDesk(){
    const request = ++deskRequest;
    const identity=menu._identity;
    const account=identity?.kind==='wallet' ? identity.address : null;
    const alive=()=>request===deskRequest && economyPanelActive(menu,host,modal) &&
      menu._identity===identity && identity?.address===account;
    desk.replaceChildren(h('h3',{class:'iw-display'},'WALLET & ACTIVITY'));
    if(!account){
      desk.append(h('p',null,'Connect Intear to see your FOXO balance, claims and market proceeds.'));
      return;
    }
    if(typeof menu.chogWallet.openClaims==='function'){
      desk.append(menu._btn({id:'economy-wallet-claims',label:'VIEW CLAIMS',cls:'iw-btn--small',
        accept:()=>menu.chogWallet.openClaims()}));
    }
    const numbers=h('div',{class:'economy-stat-grid'});
    desk.append(h('p',null,account), numbers);
    const read=(id,method,blockId)=>viewNearContract(id,method,{account_id:account},{blockId});
    const results=await Promise.allSettled([
      read(NEAR_TESTNET.token,'ft_balance_of'),
      (async()=>{
        const {blockHash}=await verifyEconomyDeployment({deployment:economyDeployment,tokenId:NEAR_TESTNET.token,readCode:readNearAccountCode,view:viewNearContract});
        const observed=await read(economyDeployment.accountId,'get_order_credit',blockHash);
        if(observed.blockHash!==blockHash)throw Error('Finalized Economy block changed.');
        return observed;
      })(),
      (async()=>{
        const code=await readNearAccountCode(marketDeployment.accountId);
        if(code.codeHash!==marketDeployment.codeHash)throw Error('Market deployment changed.');
        const observed=await read(marketDeployment.accountId,'get_account_state',code.blockHash);
        if(observed.blockHash!==code.blockHash)throw Error('Finalized Market block changed.');
        return {value:observed.value?.credit??'0',withdrawPending:observed.value?.withdraw_pending??'0'};
      })(),
    ]);
    if(!alive())return;
    ['Wallet balance','Cosmetic and order proceeds','Fox Market proceeds'].forEach((label,index)=>{
      const result=results[index];
      let amount='Unavailable';
      let pending=null;
      if(result.status==='fulfilled') {
        try {
          amount=formatFoxo(result.value.value)+' FOXO';
          if (result.value.withdrawPending && BigInt(result.value.withdrawPending)>0n) {
            pending=h('small',null,formatFoxo(result.value.withdrawPending)+' FOXO withdrawal pending');
          }
        } catch { /* Keep the unavailable state for malformed RPC values. */ }
      }
      numbers.append(h('article',{class:'economy-stat'},h('span',null,label),h('strong',{class:'iw-display'},amount),pending));
    });
    if(host){
      desk.append(h('nav',{'aria-label':'Withdraw marketplace proceeds',class:'iw-modal__btns'},
        menu._btn({id:'desk-cosmetic-market',label:'COSMETIC MARKET',cls:'iw-btn--small',accept:()=>menu._go('economyCosmetics')}),
        menu._btn({id:'desk-fox-market',label:'FOX MARKET',cls:'iw-btn--small',accept:()=>menu._go('economyNfts')})));
    }
  }
  async function refresh(){
    if(busy||!economyPanelActive(menu, host, modal))return;
    busy=true;
    void refreshDesk();
    try{
      const [response,ranking]=await Promise.all([
        fetch(nearRelayUrl()+'/near/economy/status',{signal:AbortSignal.timeout(15000)}),
        fetch(nearRelayUrl()+'/near/ranking/status',{signal:AbortSignal.timeout(5000)})
          .then(result=>result.ok?result.json():null).catch(()=>null),
      ]);
      const value=await response.json();
      if(!economyPanelActive(menu, host, modal))return;
      if(!response.ok)throw new Error(value.error||'Economy activity is unavailable.');
      const totals=value.cumulativeEventTotals;
      status.textContent=value.status==='SYNCED'?'Finalized activity':'Syncing · Last confirmed activity';
      const ledger=value.ledger;
      body.replaceChildren(...[
        ledger?h('div',{class:'chog-wallet-status'},
          h('strong',null,'CONTRACT LEDGER · BLOCK '+ledger.blockHeight),
          h('div',null,'Funded · '+formatFoxo(ledger.fundedAtomic)+' FOXO'),
          h('div',null,'Available for campaigns · '+formatFoxo(ledger.availableAtomic)+' FOXO'),
          h('div',null,'Campaign balance · '+formatFoxo(ledger.campaignAtomic)+' FOXO'),
          h('div',null,'Paid · '+formatFoxo(ledger.paidAtomic)+' FOXO')):null,
        h('p',null,'Event history through block '+(value.cursor?.height??'—')+
          (Number.isSafeInteger(value.lagBlocks) && value.lagBlocks>0
            ? ' · '+value.lagBlocks.toLocaleString('en-US')+' blocks behind' : '')),
        h('section',{class:'economy-stat-grid'},[
          ['Reward funding',totals.rewardFunding],['Rewards paid',totals.rewardPaid],
          ['Craft and guild fees',totals.craftingFees],['Market fees',totals.marketFees],
          ['Buy order funding',totals.orderFunding],['Order refunds',totals.orderRefundCredits],
        ].map(([label,amount])=>h('article',{class:'economy-stat'},
          h('span',null,label),h('strong',{class:'iw-display'},formatFoxo(amount)),h('small',null,'FOXO')))),
        value.demandTotals?h('section',{class:'fox-feature-card'},
          h('h3',{class:'iw-display'},'FINALIZED TRADE VOLUME'),
          h('div',{class:'economy-stat-grid'},[
            ['Cosmetic sales',value.demandTotals.cosmeticSaleGross],
            ['Guild orders filled',value.demandTotals.guildOrderGross],
            ['Sponsored orders filled',value.demandTotals.sponsoredOrderGross],
            ['Orders without source proof',value.demandTotals.unattributedOrderGross],
          ].map(([label,amount])=>h('article',{class:'economy-stat'},
            h('span',null,label),h('strong',{class:'iw-display'},formatFoxo(amount)),h('small',null,'FOXO'))))):null,
        value.quartermaster?h('p',null,'Quartermaster · '+value.quartermaster.budgetFoxo+' FOXO budget · '+(value.quartermaster.enabled?'Active':'Paused')):null,
        ranking?.modes?h('section',{class:'fox-feature-card'},
          h('h3',{class:'iw-display'},'RANKING BY MODE'),
          h('div',{class:'economy-stat-grid'},ranking.modes.map(row=>h('article',{class:'economy-stat'},
            h('span',null,({hunt:'Trait Hunt',boss:'Boss Battle',control:'Trait Control',trials:'Daily Trials'})[row.mode]),
            h('strong',{class:'iw-display'},row.results),
            h('small',null,ranking.enabledModes.includes(row.mode)?'Results · Rewards enabled':'Results · Collecting scores'))))):null,
        value.error?h('p',{role:'status'},value.error):null,
      ].filter(node=>node!=null));
    }catch(error){if(economyPanelActive(menu, host, modal))status.textContent=error.message;}
    finally{busy=false;}
  }
  void refresh();
}
