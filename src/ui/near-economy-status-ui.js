import { economyPanelActive, economyPanel } from './near-economy-page.js';
import { openNearRanking } from './near-ranking-ui.js';
import { h } from './ui-util.js';
import { formatFoxo, nearRelayUrl } from './near-testnet-assets.js';

export function openEconomyStatus(menu,back,host){
  let busy=false;
  const modal = economyPanel(menu, host, {title:'ECONOMY',text:'Loading finalized activity…',buttons:[
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
  const body=h('div',{class:'chog-workshop-body economy-dashboard'});
  modal.querySelector('.iw-modal__btns').before(body);
  async function refresh(){
    if(busy||!economyPanelActive(menu, host, modal))return;
    busy=true;
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
