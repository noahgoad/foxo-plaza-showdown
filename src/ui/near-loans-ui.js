import {h} from './ui-util.js';
import {NEAR_TESTNET,nearRelayUrl,viewNearContract,nearFoxProfile} from './near-testnet-assets.js';

export function openIncomingFoxLoans(menu) {
  const identity=menu._identity,account=identity?.address,session=identity?.nearSession;
  menu._openModal({title:'BORROWED FOXES',text:'Loading borrowed Foxes…',buttons:[{label:'CLOSE',accept:()=>menu._closeModal()}]});
  const modal=menu._modal,body=h('div',{class:'chog-raid-pool-body'}),status=modal.querySelector('.iw-modal__text');
  modal.classList.add('chog-raid-pool-modal');modal.querySelector('.iw-modal__btns').before(body);
  modal.classList.add('near-game-panel');
  const active=()=>menu._modal===modal&&modal.isConnected&&menu._identity===identity&&identity?.address===account&&identity?.nearSession===session&&identity?.config?.network===NEAR_TESTNET.network;
  let busy=false,offset=0;
  const request=async(path,args)=>{
    if(!active())throw Error('Wallet changed. Reopen borrowed Foxes.');
    if(!session || identity.nearSessionExpires<=Date.now())throw Error('Sign in with Intear to read usage permissions.');
    const response=await fetch(nearRelayUrl()+path,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nearSession:session,...args}),signal:AbortSignal.timeout(12000)});
    const data=await response.json();if(!active())throw Error('Wallet changed. Reopen borrowed Foxes.');
    if(!response.ok)throw Error(data.error||'Usage service unavailable.');return data;
  };
  const run=async fn=>{
    if(busy||!active())return;busy=true;body.querySelectorAll('button').forEach(button=>button.disabled=true);
    try{await fn();}catch(error){if(active())status.textContent=error.message;}
    finally{busy=false;if(active())body.querySelectorAll('button').forEach(button=>button.disabled=false);}
  };
  const button=(id,label,fn)=>menu._btn({id,label,cls:'iw-btn--small',accept:()=>run(fn)});
  async function list(){
    const {loans}=await request('/near/usage/list',{offset,limit:20});
    if(!Array.isArray(loans))throw Error('Invalid loan list.');
    for(const old of body.querySelectorAll('[data-nav]'))menu._binds?.delete(old);
    body.replaceChildren();
    for(const [index,loan] of loans.entries()) {
      const fox=loan.identity;
      if(loan.borrowerId!==account||fox?.collectionId!==NEAR_TESTNET.nft||!/^\d{3}$/.test(fox?.tokenId??'')||!Array.isArray(loan.modes)||!Number.isSafeInteger(loan.expiresAt))continue;
      body.append(h('div',{class:'chog-raid-pool-row'},h('span',null,fox.name||'Fox #'+fox.tokenId),h('b',null,'Owner: '+fox.ownerId)),
        h('p',{class:'chog-wallet-status'},loan.modes.join(' · ').toUpperCase()+' · Until '+new Date(loan.expiresAt).toLocaleString()),
        button('borrowed-use-'+index,'USE FOX #'+fox.tokenId,async()=>{
          if(loan.expiresAt<=Date.now())throw Error('This loan expired. Refresh the list.');
          const {value}=await viewNearContract(NEAR_TESTNET.nft,'nft_token',{token_id:fox.tokenId});
          if(!active())return;
          if(value?.token_id!==fox.tokenId||value.owner_id!==fox.ownerId)throw Error('Fox owner changed. Refresh the loan list.');
          const profile=nearFoxProfile(value,value.owner_id);
          await request('/near/workshop/progress',{tokenId:fox.tokenId});
          if(!active())return;
          identity.nft={...profile,borrowed:true,sourceLoan:{borrowerId:account,modes:[...loan.modes],expiresAt:loan.expiresAt},ownedTokenIds:identity.nft?.ownedTokenIds||[]};
          menu._closeModal();menu.chogWallet.repaint();menu.toast('Borrowed Fox selected. Usage is checked again before every match.');
        }));
    }
    if(!body.children.length)body.append(h('p',null,'No active incoming Fox loans.'));
    body.append(h('div',{class:'chog-raid-pool-actions'},
      ...(offset?[button('loans-previous','PREVIOUS',async()=>{offset=Math.max(0,offset-20);await list();})]:[]),
      ...(loans.length===20?[button('loans-next','NEXT',async()=>{offset+=20;await list();})]:[]),
      button('loans-refresh','REFRESH',list)));
    status.textContent='';
  }
  void run(list);
}
