import { guildDirectory } from './near-guild-directory.js';
import { economyPanelActive, economyPanel } from './near-economy-page.js';
import { accountId } from '../economy/schema.js';
import { h } from './ui-util.js';
import { NEAR_TESTNET, formatFoxo, nearRelayUrl, viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { guildDeployment } from '../../assets/near-fox/guild-deployment.js';
import { GUILD_FEE, GUILD_TOKENS, GUILD_TARGETS, guildIdentifier, guildGate, contributionDraft, contributionMatches, readGuildSnapshot } from '../economy/near-guild.js';

export function openNearGuild(menu,back,host){
 const identity=menu._identity,wallet=menu.chogWallet,account=identity?.kind==='wallet'&&identity.config?.network===NEAR_TESTNET.network?identity.address:null;
 const modal = economyPanel(menu, host, {title:'GUILD PROJECTS',text:!account?'Connect Intear to manage guild projects.':!guildDeployment.accountId?'Guild projects are awaiting verified Testnet deployment.':host?'':'Load a guild and review each action before signing.',buttons:[{label:'BACK',accept:back}]});
 modal.classList.add('chog-workshop-modal');
  modal.classList.add('near-game-panel');
 if (host && !account) {
  modal.querySelector('.iw-modal__btns').before(guildDirectory(menu,{
   readGuild:readDirectoryGuild, createGuild:()=>menu.toast('Connect Intear to create a guild.'),
   openGuild:()=>menu.toast('Connect Intear to join or manage a guild.'),
  }));
 }
 if(!account||!guildDeployment.accountId)return;
 const body=h('div',{class:'chog-workshop-body'}),status=modal.querySelector('.iw-modal__text');status.setAttribute('role','status');status.setAttribute('aria-live','polite');modal.querySelector('.iw-modal__btns').before(body);
 const active=()=>economyPanelActive(menu, host, modal)&&menu._identity===identity&&identity.address===account&&menu.chogWallet===wallet;
 const guard=()=>{if(!active())throw new Error('Wallet or screen changed. Reopen Guild Projects.');};
 let busy=false,prepared=null,snapshot=null;
 const input=(id,label,value='')=>{const el=h('input',{id,type:'text',autocomplete:'off','aria-label':label,value});el.addEventListener('keydown',e=>{if(e.key!=='Escape')e.stopPropagation();});return el;};
 const gid=input('guild-id','Guild ID'),pid=input('guild-project-id','Project ID');
 const field=(label,el)=>h('label',{class:'fox-order-field'},h('span',null,label),el);
 const review=h('p',{id:'guild-review',role:'status'}),details=h('div',{id:'guild-detail'});
 const button=(id,label,fn)=>menu._btn({id:'guild-'+id,label,cls:'iw-btn--small',accept:()=>run(fn)});
 const key='fox-guild-contribution:'+guildDeployment.accountId+':'+account;
 const read=()=>readGuildSnapshot({deployment:guildDeployment,economy:economyDeployment,token:NEAR_TESTNET.token,account,guildId:gid.value.trim(),projectId:pid.value.trim(),readCode:readNearAccountCode,view:viewNearContract});
 async function run(fn){if(busy||!active())return;busy=true;confirm.disabled=true;try{await fn();}catch(error){if(economyPanelActive(menu, host, modal))status.textContent=error.message||'Guild request failed.';}finally{busy=false;if(active())confirm.disabled=!prepared;}}
 function stage(call,text,check){prepared={call,check};review.textContent=text+' Native attachment '+formatFoxo(call.deposit)+' NEAR ('+call.deposit+' yoctoNEAR); wallet network gas is additional. No action is signed until CONFIRM IN WALLET.';confirm.disabled=false;}
 const call=(method,args,deposit='0',receiverId=guildDeployment.accountId)=>({receiverId,method,args,deposit});
 async function stageAction(action,args,text,extra=()=>{}){
  if(!snapshot)throw new Error('Load the guild first.');guildGate(action,snapshot);await extra(snapshot);
  const expected=JSON.stringify({guild:snapshot.guild,project:snapshot.project,member:snapshot.member});
  stage(call(action,args),text,async fresh=>{guildGate(action,fresh);await extra(fresh);if(JSON.stringify({guild:fresh.guild,project:fresh.project,member:fresh.member})!==expected)throw new Error('Guild state changed. Load and review again.');});
 }
 async function load(){
  prepared=null;confirm.disabled=true;review.textContent='';const next=await read();guard();snapshot=next;
  for(const el of details.querySelectorAll('[data-nav]'))menu._binds.delete(el);details.replaceChildren();
  const g=next.guild,p=next.project;if(!g){status.textContent='Guild not found. Create a guild explicitly, or enter another ID.';return;}
  details.append(h('h3',{class:'iw-display'},gid.value.trim()),h('p',null,(g.active?'ACTIVE':'DISBANDED')+' · Leader '+g.leader+' · Treasurer '+g.treasurer+' · '+(next.member?'Active member':'Not a member')+' · Governor threshold '+g.threshold+'/'+g.governors.length));
  const action=(name,label,text,extra)=>{let disabled=false;try{guildGate(name,next);extra?.(next);}catch{disabled=true;}const el=button(name,label,()=>stageAction(name,name==='join'||name==='leave'||name==='disband'?{guild_id:gid.value.trim()}:{project_id:pid.value.trim()},text,extra));el.disabled=disabled;details.append(el);};
  action(next.member?'leave':'join',next.member?'REVIEW LEAVING':'REVIEW JOINING',next.member?'Leave this guild. Contribution history remains; guild output display stops.':'Join this guild explicitly. Joining does not contribute materials or FOXO.');
  action('disband','REVIEW DISBANDING','Disband this guild. Committed output is archived and display stops. Uncommitted projects cancel; contributors must request refunds separately.');
  if(p){
   const display=await next.read(guildDeployment.accountId,'can_display',{project_id:pid.value.trim(),account_id:account});guard();
   if(display===true&&p.sku==='guild-banner-beacon-v2'){
    const projectId=pid.value.trim(),key='fox-guild-banner:'+account;
    const toggle=button('equip-banner',localStorage.getItem(key)===projectId?'REMOVE BANNER':'EQUIP BANNER',async()=>{
     const fresh=await read();
     const permitted=await fresh.read(guildDeployment.accountId,'can_display',{project_id:projectId,account_id:account});guard();
     if(permitted!==true)throw new Error('Guild display permission expired.');
     if(localStorage.getItem(key)===projectId)localStorage.removeItem(key);
     else localStorage.setItem(key,projectId);
     toggle.textContent=localStorage.getItem(key)===projectId?'REMOVE BANNER':'EQUIP BANNER';
    });
    details.append(toggle);
   }
   const meters=GUILD_TOKENS.map((name,i)=>h('label',{class:'guild-meter'},
    h('span',null,name,h('b',null,p.totals[i]+'/'+GUILD_TARGETS[i])),
    h('progress',{value:p.totals[i],max:GUILD_TARGETS[i]})));
   details.prepend(h('section',{class:'guild-project-card'},
    p.sku==='guild-banner-beacon-v2'?h('img',{src:new URL('../../assets/near-fox/pilot-v2/guild-avatar.png',import.meta.url).href,alt:''}):null,
    h('div',null,h('h3',{class:'iw-display'},pid.value.trim()),h('p',null,p.status+' · Ends '+new Date(Number(BigInt(p.deadline)/1000000n)).toLocaleString('en-US')),
      h('div',{class:'guild-meters'},meters),h('p',null,'15 FOXO · '+p.fee_state),
      h('p',null,display?'Banner available to equip':'Banner unlocks after project completion'),
      h('details',null,h('summary',null,'Project terms'),h('p',null,'Fee payer '+p.fee_payer),h('p',null,'SHA-256 '+p.terms_hash)))));
   if(host && p.status==='open'){
    const missing=GUILD_TOKENS.map((name,i)=>[name,BigInt(GUILD_TARGETS[i])-BigInt(p.totals[i])])
      .filter(([,amount])=>amount>0n);
    if(missing.length){
     const missions=h('div',{class:'fox-feature-grid'});
     const projectId=pid.value.trim();
     const missionStatus=h('p',{role:'status'});
     const requestMission=async(action,mode)=>{
      if(!identity.nearSession)throw Error('Sign in with Intear to track Guild missions.');
      const response=await fetch(nearRelayUrl()+'/near/guild/missions/'+action,{
       method:'POST',headers:{'content-type':'application/json'},
       body:JSON.stringify({nearSession:identity.nearSession,projectId,mode}),
       signal:AbortSignal.timeout(12000)});
      const result=await response.json().catch(()=>null);
      guard();
      if(!response.ok||!Array.isArray(result?.missions))throw Error(result?.error||'Guild mission service unavailable.');
      return result.missions;
     };
     const missionLabels=new Map();
     const refreshMissions=async()=>{
      const records=await requestMission('status');
      for(const [mode,label] of missionLabels){
       const record=records.find(item=>item.mode===mode);
       label.textContent=record?.status==='confirmed'?'Confirmed · Match '+record.matchId:
        record?.status==='accepted'?'Accepted · Finish a verified match':
        record?.status==='closed'?'Closed':'Ready to accept';
      }
     };
     for(const [mode,label,objective] of [
      ['boss','BOSS BATTLE','Win and break a shield, heal or protect an ally.'],
      ['control','TRAIT CONTROL','Win and help capture or defend a station.'],
      ['trials','DAILY TRIALS','Clear all eight beacons with the standard kit.'],
     ]){
      const progress=h('p',null,'Check mission status');
      missionLabels.set(mode,progress);
      const play=button('mission-'+mode,'ACCEPT & PLAY',async()=>{
       if(!menu.chogWallet.requirePlayer())return;
       const records=await requestMission('accept',mode);
       const record=records.find(item=>item.mode===mode);
       if(record?.status!=='accepted'){await refreshMissions();return;}
       menu._lobbyKind=mode;
       menu._go('lobby');
      });
      play.disabled=!next.member;
      missions.append(h('article',{class:'near-market-section fox-feature-card'},
       h('h4',{class:'iw-display'},label),h('p',null,objective),progress,play));
     }
     details.append(h('section',{class:'near-market-section'},
      h('h3',{class:'iw-display'},'GUILD CONTRACTS'),
      h('p',null,'Materials needed · '+missing.map(([name,amount])=>amount+' '+name).join(' · ')),
      h('p',null,'Accept before starting a verified match. Return to check progress and contribute materials.'),
      missions,missionStatus,button('mission-refresh','CHECK MISSION STATUS',refreshMissions)));
     if(next.member&&identity.nearSession)void refreshMissions().catch(error=>{
      if(active()&&missions.isConnected)missionStatus.textContent=error.message;
     });
    }
   }
   const amounts=GUILD_TOKENS.map(t=>input('guild-material-'+t,t+' contribution','0'));
   details.append(...amounts.map((el,i)=>field(GUILD_TOKENS[i].toUpperCase(),el)),button('contribution-review','REVIEW MATERIAL CONTRIBUTION',async()=>{
    const fresh=await read();guildGate('contribute',fresh);
    let draft;const saved=localStorage.getItem(key);
    if(saved){draft=JSON.parse(saved);validateSaved(draft,fresh);}else draft=contributionDraft({guild:guildDeployment.accountId,economy:economyDeployment.accountId,account,projectId:pid.value.trim(),project:fresh.project,operationId:crypto.randomUUID(),amounts:amounts.map(el=>el.value.trim())});
    stage(draft,'Contribute '+draft.args.amounts.map((v,i)=>v+' '+draft.args.token_ids[i]).join(' + ')+' to '+draft.projectId+'. Materials enter escrow. Total project target 48 alloy + 2 core + 2 catalyst; separate project fee 15 FOXO paid by '+fresh.project.fee_payer+'. Refunds only after uncommitted cancellation/expiry; committed materials are consumed. Output stays with the guild, cannot be sold or transferred. Terms '+draft.termsHash+'.',async current=>{
     validateSaved(draft,current);const existing=await current.read(guildDeployment.accountId,'contribution',{operation_id:draft.operationId});
     if(existing){if(!contributionMatches(existing,draft))throw new Error('Saved operation conflicts with chain contribution.');return 'confirmed';}
     guildGate('contribute',current);const raw=GUILD_TOKENS.map(t=>draft.args.amounts[draft.args.token_ids.indexOf(t)]||'0');contributionDraft({guild:draft.guild,economy:draft.receiverId,account,projectId:draft.projectId,project:current.project,operationId:draft.operationId,amounts:raw});
    });
   }));
   details.append(button('fee-review','REVIEW 15 FOXO FEE',async()=>{
    const fresh=await read();guildGate('fund_fee',fresh);const hash=fresh.project.terms_hash;
    stage(call('ft_transfer_call',{receiver_id:guildDeployment.accountId,amount:GUILD_FEE,msg:JSON.stringify({project_id:pid.value.trim(),terms_hash:hash})},'1',NEAR_TESTNET.token),'Pay exactly 15 FOXO for this guild project. Payer '+fresh.project.fee_payer+'. Fee stays held until commit. After uncommitted cancellation/expiry it can be refunded only to this payer. Terms '+hash+'.',current=>{guildGate('fund_fee',current);if(current.project.terms_hash!==hash)throw new Error('Project terms changed.');});
   }));
   action('commit','REVIEW COMMIT','Commit full project target: consume 48 alloy + 2 core + 2 catalyst and spend held 15 FOXO. Output is guild-bound; no sale, transfer or post-commit refund. Terms '+p.terms_hash+'.');
   action('reconcile_commit','REVIEW COMMIT RECONCILIATION','Query the canonical economy receipt for this pending commit. This does not charge another 15 FOXO.');
   action('cancel','REVIEW CANCELLATION','Cancel the uncommitted project. Each contribution and the held fee need separate refund delivery.');
   action('expire','REVIEW EXPIRY','Expire the overdue uncommitted project; refunds need separate delivery.');
   action('refund_fee','REVIEW FEE REFUND','Deliver 15 FOXO to immutable fee payer '+p.fee_payer+'. Failed delivery restores eligibility for retry.');
   const rows=await Promise.all(p.contributions.map(async operation_id=>({operation_id,row:await next.read(guildDeployment.accountId,'contribution',{operation_id})})));guard();
   for(const {operation_id,row} of rows){if(!row)continue;details.append(h('p',null,operation_id+' · '+row.contributor+' · '+row.status+' · '+row.amounts.map((v,i)=>v+' '+row.token_ids[i]).join(' + ')));const refund=button('refund-'+operation_id,'REVIEW MATERIAL REFUND',()=>stageAction('refund',{operation_id},'Refund these exact materials to '+row.contributor+'. Failed transfers return to escrow for retry.',async fresh=>{const current=await fresh.read(guildDeployment.accountId,'contribution',{operation_id});if(current?.status!=='escrow'||current.contributor!==row.contributor||current.project_id!==pid.value.trim())throw new Error('Refund pending, already delivered or changed.');}));refund.disabled=!['cancelled','expired'].includes(p.status)||row.status!=='escrow';details.append(refund);}
  }
  status.textContent='';
 }
 function validateSaved(draft,fresh){
  if(draft.kind!=='contribute'||draft.account!==account||draft.guild!==guildDeployment.accountId||draft.receiverId!==economyDeployment.accountId||draft.projectId!==pid.value.trim()||draft.termsHash!==fresh.project?.terms_hash)throw new Error('Saved contribution belongs to different project terms. Keep its operation ID and load that project.');
  const amounts=GUILD_TOKENS.map(t=>draft.args?.amounts?.[draft.args.token_ids.indexOf(t)]||'0');
  const rebuilt=contributionDraft({guild:draft.guild,economy:draft.receiverId,account,projectId:draft.projectId,project:{...fresh.project,totals:['0','0','0']},operationId:draft.operationId,amounts});
  if(JSON.stringify(rebuilt)!==JSON.stringify(draft))throw new Error('Saved contribution is malformed.');
 }
 const confirm=button('confirm','CONFIRM IN WALLET',async()=>{
  const draft=prepared;if(!draft)return;await wallet.prepareWallet();guard();const fresh=await read();guard();
  const result=await draft.check(fresh);guard();
  if(draft.call.kind==='contribute')localStorage.setItem(key,JSON.stringify(draft.call));
  if(result!=='confirmed'){
   status.textContent='Review the exact action in Intear.';
   const c=draft.call;await wallet.intear.signAndSendTransaction({signerId:account,receiverId:c.receiverId,actions:[wallet.nearActions.functionCall(c.method,c.args,200n*10n**12n,BigInt(c.deposit))]});guard();
  }
  if(draft.call.kind==='contribute'){
   const current=await read(),row=await current.read(guildDeployment.accountId,'contribution',{operation_id:draft.call.operationId});guard();
   if(!contributionMatches(row,draft.call))throw new Error('Contribution is not confirmed at finality. Saved operation retained. Load and review it before retrying.');localStorage.removeItem(key);
  }
  await load();
 });confirm.disabled=true;
 const storage=input('guild-storage','Native storage prepayment in yoctoNEAR','0');
 const governors=input('guild-governors','Governor accounts, comma separated'),threshold=input('guild-threshold','Governor approval threshold','2'),deadline=input('guild-deadline','Project deadline UTC ISO','');
 const role=input('guild-role','Manager role: leader or treasurer','treasurer'),target=input('guild-manager-target','New manager account');
 const search=h('section',{class:'near-market-section guild-lookup'},
  h('h3',{class:'iw-display'},'FIND YOUR GUILD'),
  h('div',{class:'near-market-search'},field('GUILD ID',gid),field('PROJECT ID (OPTIONAL)',pid),button('load','LOAD / REFRESH',load)));
 const management=h('details',{class:'near-market-section guild-management'},h('summary',null,'Guild management'),
 field('GOVERNORS (COMMA SEPARATED)',governors),field('APPROVAL THRESHOLD',threshold),button('create-review','REVIEW CREATE GUILD',async()=>{
  const id=guildIdentifier(gid.value.trim()),list=governors.value.split(',').map(s=>accountId(s.trim())),n=Number(threshold.value);if(list.length<2||list.length>16||new Set(list).size!==list.length||!list.includes(account)||!Number.isInteger(n)||n<2||n>list.length)throw new Error('Use 2–16 unique governors including this wallet and a valid threshold of at least 2.');
  stage(call('create_guild',{guild_id:id,governors:list,threshold:n}),'Create guild '+id+' with governors '+list.join(', ')+' and approval threshold '+n+'. You become leader, treasurer and its first member. Native prepaid storage is required.',fresh=>{if(fresh.guild)throw new Error('Guild already exists.');});
 }),field('DEADLINE (UTC ISO)',deadline),button('open-review','REVIEW OPEN PROJECT',async()=>{
  const fresh=await read();guildGate('open_project',fresh);const ms=Date.parse(deadline.value);if(!Number.isSafeInteger(ms)||ms<=Date.now())throw new Error('Enter a future UTC deadline.');
  const id=guildIdentifier(pid.value.trim());stage(call('open_project_ms',{project_id:id,guild_id:gid.value.trim(),deadline_ms:ms}),'Open '+id+' for guild '+gid.value.trim()+': guild-banner-beacon-v2; targets 48 alloy + 2 core + 2 catalyst; fee payer '+account+' owes 15 FOXO separately; deadline '+new Date(ms).toISOString()+'. Uncommitted-only refunds. Output is nontransferable and guild-bound.',current=>{guildGate('open_project',current);if(current.project)throw new Error('Project already exists.');});
 }),field('MANAGER ROLE',role),field('NEW MANAGER ACCOUNT',target),button('governance-review','REVIEW GOVERNOR APPROVAL',()=>{
  if(!['leader','treasurer'].includes(role.value.trim()))throw new Error('Role must be leader or treasurer.');stageAction('approve_manager_change',{guild_id:gid.value.trim(),role:role.value.trim(),account_id:accountId(target.value.trim())},'Approve changing '+role.value.trim()+' to '+target.value.trim()+'. Change executes only at the configured active-governor threshold.',async fresh=>{if(!await fresh.read(guildDeployment.accountId,'member',{guild_id:gid.value.trim(),account_id:target.value.trim()}))throw new Error('The new manager must be an active guild member.');});
 }),field('STORAGE PREPAYMENT (YOCTONEAR)',storage),button('storage-review','REVIEW STORAGE PREPAYMENT',()=>{
  if(!/^[1-9]\d{0,30}$/.test(storage.value.trim()))throw new Error('Enter an exact positive native storage prepayment.');stage(call('fund_storage',{},storage.value.trim()),'Prepay guild contract storage. This native payment is not project principal, is consumed by storage growth and has no withdrawal API.',()=>{});
 }));
 if(!host) management.open=true;
 const workspace=h('div',{class:'guild-workspace fox-feature-stack'},
  h('div',{class:'fox-feature-grid'},
   h('div',{class:'fox-feature-stack'},search,h('section',{class:'near-market-section fox-feature-card'},
    h('h3',{class:'iw-display'},'MEMBERSHIP & PROJECTS'),details)),
   h('section',{class:'near-market-section fox-feature-card'},
    h('h3',{class:'iw-display'},'GUILD ADMINISTRATION'),management)),
  h('section',{class:'near-market-section guild-review-panel'},
   h('h3',{class:'iw-display'},'REVIEW TRANSACTION'),review,confirm));
 if(host) {
  workspace.hidden=true;
  const directory=guildDirectory(menu,{
   readGuild:readDirectoryGuild,
   openGuild:id=>{workspace.hidden=false;gid.value=id;pid.value='';run(async()=>{
    await load();
    const project=snapshot?.guild?.projects?.at(-1);
    if(project){pid.value=project;await load();}
    if(active()) workspace.scrollIntoView({block:'start'});
   });},
   createGuild:()=>{workspace.hidden=false;management.open=true;gid.focus();gid.scrollIntoView({block:'nearest'});},
  });
  const lookup=menu._btn({id:'guild-open-by-id',label:'OPEN BY ID',cls:'iw-btn--small',accept:()=>{
   workspace.hidden=false;gid.focus();gid.scrollIntoView({block:'nearest'});
  }});
  directory.querySelector('.guild-directory-toolbar').append(lookup);
  body.append(directory,workspace);
 } else body.append(workspace);
 for(const el of body.querySelectorAll('input'))el.addEventListener('input',()=>{prepared=null;confirm.disabled=true;review.textContent='';});
}



async function readDirectoryGuild(id) {
 if (!guildDeployment.accountId) return null;
 const code=await readNearAccountCode(guildDeployment.accountId);
 if(code.codeHash!==guildDeployment.codeHash)throw Error('Guild code verification failed.');
 const row=await viewNearContract(guildDeployment.accountId,'guild',{guild_id:id},{blockId:code.blockHash});
 if(row.blockHash!==code.blockHash)throw Error('Guild snapshot changed.');
 return row.value;
}
