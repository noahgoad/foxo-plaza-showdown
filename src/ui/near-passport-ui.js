import { economyPanel, economyPanelActive } from './near-economy-page.js';
import {h} from './ui-util.js';
import {NEAR_TESTNET,nearRelayUrl,viewNearContract,nearFoxProfile} from './near-testnet-assets.js';
import {accountId} from '../economy/schema.js';import {objectiveFromNft} from '../game/chog-objectives.js';
import {raidRole} from '../game/boss-raid-rules.js';


// Passport career/usage records are server managed. Ownership alone is read from NEAR.
export function openNearPassport(menu,nft,back=()=>menu._closeModal(),host) {
  if(!host&&menu._modal?.isConnected)return;
  const state=menu._identity,account=state?.address,session=state?.nearSession,equipped=state?.nft?.tokenId;
  const key={collectionId:nft.contract,tokenId:nft.tokenId};
  const modal=economyPanel(menu,host,{title:'FOX PASSPORT',text:'',buttons:[{label:'BACK',accept:back}]});
  modal.classList.add('near-game-panel','chog-raid-pool-modal','fox-passport');
  modal.querySelector('.iw-modal__splat')?.remove();

  const status=h('p',{class:'chog-wallet-status',role:'status','aria-live':'polite'},'Loading Fox passport…');
  const tabs=h('div',{class:'guild-book-tabs fox-passport-tabs',role:'tablist','aria-label':'Fox passport sections'});
  const content=h('div',{class:'chog-raid-pool-body',role:'tabpanel',id:'fox-passport-panel',tabindex:'0'});
  modal.querySelector('.iw-modal__btns').before(tabs,h('div',{class:'fox-passport-layout'},
    h('aside',{class:'near-market-section fox-passport-portrait'},
      nft.image?h('img',{src:nft.image,alt:'',referrerpolicy:'no-referrer'}):null,
      h('h3',{class:'iw-display'},nft.name||'Fox #'+key.tokenId)),content),status);
  if(!host)modal._onBack=back;
  let selected='identity',data,busy=false,loans=null,owned=null,offset=0;
  const active=()=>economyPanelActive(menu,host,modal)&&menu._identity===state&&state?.address===account&&
    state?.nearSession===session&&state?.nft?.tokenId===equipped&&nft.contract===key.collectionId&&nft.tokenId===key.tokenId&&state?.kind==='wallet'&&state.config?.network===NEAR_TESTNET.network;
  const guard=()=>{if(!active())throw Error('Wallet or selected Fox changed. Reopen the passport.');};
  const auth=()=>{guard();if(!session||state.nearSessionExpires<=Date.now())throw Error('Sign in with Intear again to manage usage.');};
  const row=(label,value)=>h('div',{class:'chog-raid-pool-row'},h('span',null,label),h('b',null,String(value??'Unavailable')));
  const note=text=>h('p',{class:'chog-wallet-status'},text);
  const clear=()=>{for(const el of content.querySelectorAll('[data-nav]'))menu._binds?.delete(el);content.replaceChildren();};
  const button=(id,label,fn)=>menu._btn({id:'passport-'+id,label,cls:'iw-btn--small',accept:()=>{if(!busy)fn();}});
  const focus=el=>{menu._setFocus?.(el,{snap:true});el?.focus();};
  const request=async(path,body)=>{
    guard();
    const response=await fetch(nearRelayUrl()+path,{...(body?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({nearSession:session,...body})}:{}),signal:AbortSignal.timeout(12000)});
    const result=await response.json().catch(()=>null);guard();
    if(!response.ok||!result)throw Error(result?.error||'Passport service is unavailable. Try again.');
    return result;
  };
  const run=async fn=>{
    if(busy)return;
    const previousFocus=document.activeElement;busy=true;modal.querySelectorAll('button:not(.iw-modal__btns button)').forEach(el=>el.disabled=true);
    try{guard();await fn();}
    catch(error){if(economyPanelActive(menu,host,modal))status.textContent=error.message;}
    finally{busy=false;if(active()){tabs.querySelectorAll('button').forEach(el=>el.disabled=false);content.querySelectorAll('button').forEach(el=>el.disabled=false);if(document.activeElement===document.body)focus(previousFocus?.isConnected?previousFocus:tabs.querySelector('[aria-selected=true]'));}else content.querySelectorAll('button,input,select').forEach(el=>el.disabled=true);}
  };
  const load=async(page=0)=>{
    data=await request('/near/passport/'+encodeURIComponent(key.collectionId)+'/'+encodeURIComponent(key.tokenId)+'?offset='+page+'&limit=20');
    if(data.identity?.collectionId!==key.collectionId||data.identity?.tokenId!==key.tokenId||typeof data.identity?.ownerId!=='string'||!Array.isArray(data.career?.history))throw Error('Passport response does not match this Fox.');
    render();status.textContent='';
  };
  const list=async()=>{auth();const result=await request('/near/usage/list',{offset,limit:20});if(!Array.isArray(result.loans))throw Error('Loan list is unavailable.');loans=result.loans;if(data.identity.ownerId===account){const result=await request('/near/usage/owned',{nft:key});owned=result.usage;if(owned?.ownerId!==account||!Array.isArray(owned.grants))throw Error('Owner usage view is unavailable.');}render();};
  const choose=tab=>run(async()=>{selected=tab;render();if(tab==='usage')await list();});
  for(const tab of ['identity','career','loadout','usage']){
    const el=button('tab-'+tab,tab.toUpperCase(),()=>choose(tab));el.setAttribute('role','tab');el.setAttribute('aria-controls',content.id);el.id='passport-tab-'+tab;
    el.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const all=[...tabs.children],index=all.indexOf(el),next=event.key==='Home'?0:event.key==='End'?3:(index+(event.key==='ArrowRight'?1:3))%4;focus(all[next]);all[next].click();});tabs.append(el);
  }
  function render(){
    guard();clear();
    for(const el of tabs.children){const on=el.id==='passport-tab-'+selected;el.classList.toggle('is-selected',on);el.setAttribute('aria-selected',String(on));el.tabIndex=on?0:-1;}
    content.setAttribute('aria-labelledby','passport-tab-'+selected);
    if(!data){content.append(note('Loading passport…'));return;}
    const identity=data.identity,career=data.career;
    if(selected==='identity'){      const objective=objectiveFromNft(nft);
      const role=raidRole(objective);
      if(objective?.traits.length){
        const traitSection=h('section',{class:'near-market-section'},
          h('h3',{class:'iw-display'},'BOSS BATTLE'),
          row('TRAIT POWER',role.name),note(role.description));
        for(const trait of objective.traits)traitSection.append(row(trait.category,trait.value));
        const comparison=h('div',{role:'status'});
        const foxId=h('input',{type:'text',inputmode:'numeric',maxlength:'3',placeholder:'Fox ID (001–088)','aria-label':'Fox ID to compare'});
        foxId.addEventListener('keydown',event=>{if(event.key!=='Escape')event.stopPropagation();});
        const compare=button('compare','COMPARE FOX',()=>run(async()=>{
          const id=Number(foxId.value.trim());
          if(!/^\d{1,3}$/.test(foxId.value.trim())||id<1||id>88)throw Error('Enter a Fox ID from 001 to 088.');
          comparison.replaceChildren();
          const tokenId=String(id).padStart(3,'0');
          const {value}=await viewNearContract(NEAR_TESTNET.nft,'nft_token',{token_id:tokenId});
          guard();
          if(value?.token_id!==tokenId)throw Error('This Fox is unavailable.');
          const other=nearFoxProfile(value);
          const otherObjective=objectiveFromNft(other);
          if(!otherObjective)throw Error('This Fox has no gameplay trait data.');
          const otherRole=raidRole(otherObjective);
          comparison.append(row(other.name,otherRole.name),note(otherRole.description));
          const left=new Map(objective.traits.map(trait=>[trait.category,trait.value]));
          const right=new Map(otherObjective.traits.map(trait=>[trait.category,trait.value]));
          for(const category of new Set([...left.keys(),...right.keys()])){
            comparison.append(row(category,`${left.get(category)??'—'} → ${right.get(category)??'—'}`));
          }
        }));
        traitSection.append(foxId,compare,comparison);
        content.append(traitSection);
      }

      content.append(row('FOX',identity.name||nft.name||'#'+key.tokenId),row('COLLECTION',key.collectionId),row('TOKEN',key.tokenId),row('CURRENT OWNER',identity.ownerId),row('OWNERSHIP BLOCK',identity.blockHeight),note('Ownership comes from a NEAR Testnet read. Playing or lending usage does not transfer the NFT.'));
    }else if(selected==='career'){
      content.append(row(career.source==='near-testnet'?'FINALIZED MATCHES':'SERVER-CONFIRMED MATCHES',career.finalized?.matches??0),row(career.source==='near-testnet'?'FINALIZED XP':'SERVER-CONFIRMED XP',career.finalized?.xp??0),row('PENDING SERVER MATCHES',career.pending?.matches??0),note(career.source==='near-testnet'?'NEAR Testnet career at finalized block '+career.blockHeight+'.':'Local server career records. Finalized chain history becomes available after Passport activation.'));
      if(career.entitlements?.title)content.append(row('CAREER TITLE',career.entitlements.title.label));
      for(const entry of career.history)content.append(row(String(entry.mode||'match').toUpperCase()+' · '+entry.accountId,
        career.source==='near-testnet'?'Finalized on NEAR Testnet':entry.rulesVersion?.startsWith('near-practice')?'Local practice':entry.finalized?'Server-confirmed (local record)':'Server-recorded · Pending'));
      if(!career.history.length)content.append(note('No career history recorded.'));
      if(career.nextOffset!=null)content.append(button('history-next','MORE HISTORY',()=>run(()=>load(career.nextOffset))));
    }else if(selected==='loadout'){
      content.append(note('Server career unlocks and recorded presets. This view does not equip a skill or change your match loadout.'));
      const presets=career.entitlements?.presets||[];
      for(const [index,preset]of presets.entries())content.append(row('PRESET '+(index+1),[preset.effect,preset.target,preset.modifier].filter(Boolean).join(' · ').toUpperCase()));
      if(!presets.length)content.append(note('No career presets recorded. Use the existing Workshop to prepare your loadout.'));
      for(const value of career.entitlements?.visualVariations||[])content.append(row('VISUAL VARIATION',typeof value==='string'?value:value.label||value.id));
    }else renderUsage(identity);
  }
  function renderUsage(identity){
    content.append(note('Server-managed Testnet usage permissions. No NFT transfer, custody deposit or registry transaction occurs. Revoking blocks new sessions; an already accepted session keeps its recorded rights and result receipt.'),row('MATCH SESSION',data.usage?.active?'Active':'No active match'));
    if(!session){content.append(note('Sign in with Intear to list loans or manage usage.'));return;}
    content.append(h('h3',null,'LOANS TO THIS ACCOUNT'));
    if(loans===null)content.append(note('Loading incoming loans…'));
    else if(!loans.length)content.append(note('No active incoming loans on this page.'));
    else for(const loan of loans){const id=loan.identity;content.append(h('article',{class:'near-market-section fox-loan-card'},row('FOX',id?.name||id?.tokenId||'Unknown Fox'),row('OWNER',id?.ownerId),row('BORROWER',loan.borrowerId),row('ALLOWED MODES',(loan.modes||[]).join(' · ').toUpperCase()),row('EXPIRES',new Date(loan.expiresAt).toLocaleString('en-US')),row('TIME LEFT',Math.max(0,Math.ceil((loan.expiresAt-Date.now())/60000))+' minutes'),button('use-'+id?.tokenId,'USE FOX',()=>run(async()=>{auth();if(loan.borrowerId!==account||loan.expiresAt<=Date.now()||id?.collectionId!==NEAR_TESTNET.nft)throw Error('This Fox loan is unavailable.');const {value,blockHash}=await viewNearContract(id.collectionId,'nft_token',{token_id:id.tokenId});guard();if(!blockHash||value?.owner_id!==id.ownerId||value?.token_id!==id.tokenId)throw Error('Fox ownership changed. Refresh the loan list.');const profile=nearFoxProfile(value,value.owner_id);await request('/near/workshop/progress',{tokenId:id.tokenId});guard();state.nft={...profile,borrowed:true,sourceLoan:{borrowerId:account,modes:loan.modes,expiresAt:loan.expiresAt},ownedTokenIds:state.nft?.ownedTokenIds||[]};back();menu.chogWallet?.repaint();menu.toast?.('Borrowed Fox selected for usage. The server checks loan rights again before each match.');}))));}
    const paging=h('div',{class:'chog-raid-pool-actions'},button('loans-refresh','REFRESH LOANS',()=>run(list)));
    if(offset>0)paging.append(button('loans-prev','PREVIOUS',()=>run(async()=>{offset=Math.max(0,offset-20);await list();})));
    if(loans?.length===20)paging.append(button('loans-next','NEXT',()=>run(async()=>{offset+=20;await list();})));
    content.append(paging);
    if(identity.ownerId!==account){content.append(note('Only the current chain owner can grant or revoke usage for this Fox.'));return;}
    const borrower=h('input',{class:'chog-token-input',type:'text',placeholder:'borrower.testnet','aria-label':'Borrower NEAR account'});
    const hours=h('input',{class:'chog-token-input',type:'number',min:'1',max:'168',value:'24','aria-label':'Loan duration in hours'});
    const modes=h('select',{class:'chog-token-input',multiple:true,'aria-label':'Allowed game modes'},...['boss','hunt','control','trials'].map(mode=>h('option',{value:mode,selected:mode==='boss'},mode.toUpperCase())));
    const review=h('div');
    content.append(h('h3',null,'LOANS FROM THIS FOX'));
    if(!owned?.grants?.length)content.append(note('No active outgoing usage grants.'));
    for(const grant of owned?.grants||[])content.append(row('BORROWER',grant.borrowerId),row('MODES',grant.modes.join(' · ').toUpperCase()),row('EXPIRES',new Date(grant.expiresAt).toLocaleString('en-US')),button('revoke-'+grant.borrowerId,'REVIEW REVOKE',()=>{borrower.value=grant.borrowerId;reviewAction('revoke');}));
    if(owned?.lease)content.append(row('CURRENT SESSION ACTOR',owned.lease.actorId),row('SESSION EXPIRES',new Date(owned.lease.expiresAt).toLocaleString('en-US')));
    const reviewAction=action=>{
      try{auth();const borrowerId=accountId(borrower.value.trim());if(borrowerId===account)throw Error('Choose a different borrower account.');
        const allowed=[...modes.selectedOptions].map(option=>option.value),duration=Number(hours.value);
        if(action==='grant'&&(!allowed.length||!Number.isInteger(duration)||duration<1||duration>168))throw Error('Choose at least one mode and a duration from 1 to 168 hours.');
        const expiresAt=Date.now()+duration*3600000;
        const confirm=button('confirm-'+action,action==='grant'?'CONFIRM LOAN':'CONFIRM REVOKE',()=>run(async()=>{
          auth();const fresh=await request('/near/passport/'+encodeURIComponent(key.collectionId)+'/'+encodeURIComponent(key.tokenId));
          if(fresh.identity?.ownerId!==account)throw Error('Fox owner changed. Refresh the passport.');
          const result=await request('/near/usage/'+action,{nft:key,borrowerId,...(action==='grant'?{modes:allowed,expiresAt}:{})});
          loans=null;await list();review.replaceChildren(note(action==='grant'?'Usage loan saved on this server. The NFT remains with its owner.':result.revoked?'Usage revoked for new sessions. Existing accepted session rights are retained.':'No active matching grant was revoked.'));status.textContent='Server usage updated. No NFT transfer or chain transaction was sent.';
        }));
        review.replaceChildren(note((action==='grant'?'Lend '+allowed.join(', ').toUpperCase()+' usage until '+new Date(expiresAt).toLocaleString('en-US'):'Revoke new usage sessions')+' for '+borrowerId+'.'),confirm);focus(confirm);
      }catch(error){status.textContent=error.message;}
    };
    content.append(h('h3',null,'OWNER USAGE CONTROLS'),note('Enter a borrower account to grant or revoke. Outgoing loans above apply to this Fox; incoming loans apply to your account.'),h('label',null,'Borrower account',borrower),h('label',null,'Duration in hours (maximum 168)',hours),h('label',null,'Allowed modes (select one or more)',modes),h('div',{class:'chog-raid-pool-actions'},button('grant','REVIEW LOAN',()=>reviewAction('grant')),button('revoke','REVIEW REVOKE',()=>reviewAction('revoke'))),review);
  }
  focus(tabs.firstElementChild);
  void run(()=>load());
}
