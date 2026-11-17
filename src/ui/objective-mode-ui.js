import { h } from './ui-util.js';
import { GLYPHS } from './ui-icons.js';
import { bossStatIcons } from './chog-icons.js';
import { TESTNET } from './chog-wallet.js';
import { objectiveFromNft } from '../game/chog-objectives.js';
import { workshopIdentity, workshopOptions, workshopRaidStorageKey, defaultWorkshopSkill, resolveWorkshopSkill, loadWorkshopSkill, saveWorkshopSkill } from '../game/skill-workshop.js';
import {describeWorkshopSkill,workshopPresets} from '../game/foxo-preset-discovery.js';
import { FOXO_ICON, nearRelayUrl, readNearWorkshopProgress } from './near-testnet-assets.js';
import { economyPanel } from './near-economy-page.js';
import { trialGhostLink } from '../game/trial-ghost-share.js';
import {CUP_ROUNDS,createPracticeCup,cupTime,recordCupRound} from '../game/foxo-event-rules.js';
import {startNearQuickPlay} from '../net/near-quickplay.js';
import {HuntRoomSession} from '../net/hunt-room.js';

// Reuse in-flight reads across redraws without retaining another wallet's state.
const modeReads=new WeakMap();
function modeRead(rewards,action,body){
  let cache=modeReads.get(rewards);if(!cache){cache=new Map();modeReads.set(rewards,cache);}
  const key=JSON.stringify([rewards.token,action,body]),old=cache.get(key);
  if(old&&Date.now()-old.at<1500)return old.promise;
  if(cache.size>=32)cache.clear();
  const promise=rewards.request(action,body);cache.set(key,{at:Date.now(),promise});
  promise.catch(()=>{if(cache.get(key)?.promise===promise)cache.delete(key);});return promise;
}
function syncMessage(node,message,hash){
  node.replaceChildren(document.createTextNode(message));
  if(/^0x[\da-f]{64}$/i.test(hash||''))node.append(' ',h('a',{href:TESTNET.explorer+'/tx/'+hash,target:'_blank',rel:'noopener noreferrer'},'VIEW TRANSACTION'));
}
// A modal can be replaced directly by navigation, so its polling follows its DOM lifetime.
function modalPollLifetime(modal){
  let timer=null,stopped=false;const stop=()=>{stopped=true;clearTimeout(timer);observer.disconnect();};
  const observer=new MutationObserver(()=>{if(!modal.isConnected)stop();});observer.observe(document.body,{childList:true,subtree:true});
  return {alive:()=>!stopped&&modal.isConnected,later:fn=>{clearTimeout(timer);if(!stopped)timer=setTimeout(fn,5000);},stop};
}
export const modeName=id=>id==='control'?'TRAIT CONTROL':'DAILY TRIALS';
export function modeChooserScreen(menu) {
  const launch = mode => {
    if (!menu.chogWallet.requirePlayer()) return;
    menu._lobbyKind = mode;
    menu._go('lobby');
  };
  const cards = [
    { id: 'mode-control', title: 'TRAIT CONTROL', detail: '3 vs 3 · Capture and hold three stations',
      art: 'assets/near-fox/mode-previews/trait-control.webp',
      info: 'Capture stations with your squad and hold them to score. The first team to reach 100 points wins.',
      accept: () => launch('control') },
    { id: 'mode-trials', title: 'DAILY TRIALS', detail: 'Race the clock and activate eight beacons',
      art: 'assets/near-fox/mode-previews/daily-trials.webp',
      info: 'Activate all eight beacons. Hold each ring for three seconds and try to finish as fast as possible.',
      accept: () => launch('trials') },
    { id: 'mode-plaza-cup', title: 'PLAZA CUP', detail: 'Three beacon runs · Fastest total time wins',
      art: 'assets/near-fox/mode-previews/plaza-cup.webp',
      info: 'Run the beacon course three times. Competition records your total time in the live standings. Practice lets you run solo.',
      accept: () => menu._go('plazaCup') },
    { id: 'mode-decoy-hunt', title: 'DECOY HUNT PRACTICE', detail: 'Drop false Carrier signals to divert rival Hunters',
      art: 'assets/near-fox/mode-previews/decoy-hunt.webp',
      info: 'Use false Carrier signals to pull rival Hunters away during a 90-second practice match.',
      accept: () => {
        if(menu.chogWallet.requirePlayer())void menu.api.startMatch({mode:'hunt',duration:90,decoyHunt:true});
      } },
    { id: 'mode-workshop', title: 'SKILL WORKSHOP', detail: 'Build a skill for Boss Battle',
      art: 'assets/near-fox/mode-previews/skill-workshop.webp',
      info: 'Combine your Fox traits into a skill loadout and use it in Boss Battle.',
      accept: () => menu._go('skillWorkshop') },
    { id: 'mode-economy', title: 'FOX ECONOMY', detail: 'Craft, trade and manage your NFTs',
      art: 'assets/near-fox/mode-previews/fox-economy.webp',
      info: 'Craft gear, trade cosmetics and Fox NFTs, support Guild Projects, and check your claims and rankings.',
      accept: () => menu._go('foxEconomy') },
  ];
  const title = h('h2', { class: 'iw-display' });
  const detail = h('p');
  const art = h('img', { class: 'foxo-mode-hero__art', alt: '' });
  const copy = h('div', { class: 'foxo-mode-hero__copy', 'aria-live': 'polite' }, title, detail);
  const current = () => cards[menu._modeSlide ?? 0];
  const render = () => {
    const card = current();
    art.src = card.art;
    title.textContent = card.title;
    detail.textContent = card.detail;
    tabs.forEach((tab, index) => {
      const selected = index === (menu._modeSlide ?? 0);
      tab.setAttribute('aria-pressed', String(selected));
    });
    copy.animate([{ opacity: 0 }, { opacity: 1 }], {
      duration: matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 180,
    });
  };
  const arrow = (step, label) => {
    const icon = h('i', { html: GLYPHS.next, 'aria-hidden': 'true' });
    const button = h('button', { class: 'foxo-mode-arrow', 'aria-label': label }, icon);
    return menu._bind(button, { id: step < 0 ? 'previous-mode' : 'next-mode', accept: () => {
      menu._modeSlide = ((menu._modeSlide ?? 0) + step + cards.length) % cards.length;
      render();
    } });
  };
  const play = menu._btn({ id: 'mode-play', label: 'PLAY', icon: GLYPHS.play,
    cls: 'iw-btn--primary', accept: () => current().accept() });
  const info = menu._btn({ id: 'mode-info', label: 'MORE INFO', accept: () => {
    const card = current();
    economyPanel(menu, null, { title: card.title, text: card.info,
      buttons: [{ id: 'close-mode-info', label: 'BACK', accept: () => menu._closeModal() }] });
  } });
  const hero = h('section', { class: 'foxo-mode-hero' }, art,
    h('div', { class: 'foxo-mode-hero__content' }, copy,
      h('div', { class: 'foxo-mode-hero__actions' }, play, info)));
  const tabs = cards.map((card, index) => menu._btn({
    id: card.id, label: card.title, cls: 'iw-btn--small', accept: () => {
      menu._modeSlide = index;
      render();
    },
  }));
  render();
  return { el: h('div', { class: 'iw-screen iw-online chog-online chog-mode-screen foxo-mode-carousel' },
    h('div', { class: 'iw-scrim-left' }), menu._header('CHOOSE MODE'),
    h('div', { class: 'foxo-mode-carousel__stage' },
      h('nav', { class: 'foxo-mode-carousel__tabs', 'aria-label': 'Choose game mode' }, tabs),
      arrow(-1, 'Previous mode'), hero, arrow(1, 'Next mode'))),
    initial: play };
}

export function plazaCupScreen(menu) {
  return hubScreen(menu, 'PLAZA CUP', [
    { id: 'mode-plaza-cup-online', title: 'COMPETITION', detail: 'Eight slots · Three recorded runs · Live standings',
      icon: GLYPHS.crown, accept: () => openCupStandings(menu) },
    { id: 'mode-plaza-cup-practice', title: 'PRACTICE', detail: 'Three solo runs · Beat your best total time',
      icon: GLYPHS.clock, accept: () => {
        if (menu.chogWallet.requirePlayer()) void menu.api.startMatch({mode:'trials',practiceCup:createPracticeCup()});
      } },
  ], 'foxo-cup-grid');
}

function launchCup(menu,day,isCurrent){
 return startNearQuickPlay(menu,{mapId:'tidewater',time:'day',mode:'trials',cup:true,cupDay:day},m=>new HuntRoomSession(m),isCurrent);
}

function openCupStandings(menu,initialDay){
 const standings=h('div',{role:'status'},'Loading standings…');
 let day=initialDay,active=true,ready=false;
 const panel=economyPanel(menu,null,{title:'PLAZA CUP',text:'Complete three runs on the same beacon course. Lowest total time wins.',buttons:[
  {id:'start-cup',label:'START NEXT ROUND',accept:async()=>{
   if(!ready||menu._nearQuickPending)return;
   try{await launchCup(menu,day,()=>active&&panel.isConnected);}
   catch(error){menu.toast(error.message);}
  }},
  {id:'refresh-cup',label:'REFRESH',accept:()=>void refresh()},
  {id:'close-cup',label:'BACK',accept:()=>{active=false;menu._closeModal();}},
 ]});
 panel.querySelector('.iw-modal__btns').before(standings);
 panel.classList.add('foxo-cup-standings');
 standings.classList.add('foxo-cup-entries');
 const lifetime=modalPollLifetime(panel);
 async function refresh(){
  try{
   const response=await fetch(nearRelayUrl()+'/plaza-cup/status',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({day}),signal:AbortSignal.timeout(10000)});
   if(!response.ok)throw Error('Cup standings are unavailable.');
   const value=await response.json();
   if(!active||!lifetime.alive())return;
   day=value.day;ready=value.available&&value.phase!=='finished';
   standings.replaceChildren(h('p',null,`${value.entries.length}/${value.capacity} entries · ${value.phase}`),
    h('ol',null,value.entries.map(row=>h('li',null,`${row.position?row.position+'. ':''}${row.name} · ${row.roundCount}/3 · ${row.dnf?'DNF':row.totalMs===null?'In progress':(row.totalMs/1000).toFixed(2)+'s'}`))));
   if(!value.available)standings.append(h('p',null,'The match simulator is unavailable. Try Plaza Cup Practice.'));
  }catch(error){if(active&&lifetime.alive())standings.textContent=error.message;}
  if(active&&lifetime.alive())lifetime.later(refresh);
 }
 void refresh();
}

export function foxEconomyScreen(menu) {
  const open = page => () => menu._go(page);
  return hubScreen(menu, 'FOX ECONOMY', [
    { id: 'economy-crafting', title: 'CRAFTING', detail: 'Browse recipes and equip crafted items', icon: GLYPHS.gear,
      accept: () => menu._go('crafting') },
    { id: 'economy-cosmetics', title: 'COSMETIC MARKET', detail: 'Buy and sell crafted gear', icon: GLYPHS.star,
      accept: open('economyCosmetics') },
    { id: 'economy-nfts', title: 'FOX NFT MARKET', detail: 'Buy and sell Fox NFTs', icon: GLYPHS.crown,
      accept: open('economyNfts') },
    { id: 'economy-orders', title: 'BUY ORDERS', detail: 'Request items or fill open orders', icon: GLYPHS.check,
      accept: open('economyOrders') },
    { id: 'economy-guild', title: 'GUILD', detail: 'Contribute materials to guild projects', icon: GLYPHS.users,
      accept: open('economyGuild') },
    { id: 'economy-activity', title: 'PLAYER DESK', detail: 'View wallet balances, claims and leaderboards',
      icon: h('img', { src: FOXO_ICON, alt: '' }), accept: open('economyActivity') },
  ], 'chog-economy-screen');
}

function hubScreen(menu, title, cards, extraClass = '') {
  const body = h('div', { class: 'iw-hub__body chog-mode-cards' });
  for (const { id, title, detail, icon, accept } of cards) {
    const tileIcon = typeof icon === 'string' ? h('i', { html: icon }) : icon;
    const card = h('button', { class: 'iw-hubcard iw-hubcard--create chog-mode-card iw-in iw-in--left', type: 'button' },
      h('span', { class: 'iw-hubcard__bg' }, h('span', { class: 'iw-hubcard__ink' })),
      h('span', { class: 'iw-hubcard__icon', 'aria-hidden': 'true' }, tileIcon),
      h('span', { class: 'iw-hubcard__text' },
        h('span', { class: 'iw-hubcard__title' }, title),
        h('span', { class: 'iw-hubcard__sub' }, detail)),
      h('span', { class: 'iw-hubcard__go', 'aria-hidden': 'true' }, h('i', { html: GLYPHS.next })));
    menu._bind(card, { id, accept });
    menu._fx(card, { tilt: 3 });
    body.append(card);
  }
  return {
    el: h('div', { class: 'iw-screen iw-online chog-online chog-mode-screen ' + extraClass },
      h('div', { class: 'iw-scrim-left' }), menu._header(title), body),
    initial: body.firstElementChild,
  };
}
export function openSkillWorkshop(menu,back=()=>menu._closeModal(),host){
  const identity=menu._identity,nearSession=identity?.nearSession;
  const raw=identity?.nft,nft=raw?{...raw,...objectiveFromNft(raw),contract:raw.contract||identity?.config?.nft||menu.chogWallet.rewards.config?.nft}:null;
  const progress={identity:workshopIdentity(nft),wins:0,...(nearSession&&!raw?{source:'near-account',storageScope:identity.address}:{})};
  let recipe=loadWorkshopSkill(localStorage,nft,progress)||defaultWorkshopSkill(nft);
  let recipeDirty=false,saving=false,syncText=nearSession?'Reading Boss win history…':menu.chogWallet.rewards.token?'Saved locally until an onchain save is confirmed.':'Skills are saved on this device.',syncHash=null,syncRun=0;
  const modal=economyPanel(menu,host,{title:'SKILL WORKSHOP',text:'',buttons:[
    {label:'SAVE SKILL',accept:async()=>{
      if(saving||menu._identity!==identity||identity?.nft?.tokenId!==raw?.tokenId||identity?.nearSession!==nearSession)return;recipeDirty=true;
      let valid;try{valid=saveWorkshopSkill(localStorage,recipe,nft,progress);localStorage.setItem(workshopRaidStorageKey(nft,progress),'workshop');menu._workshopProgress={...progress};}catch(e){menu.toast(e.message);return;}
      const rewards=menu.chogWallet.rewards;
      if(!raw||!rewards.token){menu.toast('Skill saved on this device.');render();return;}
      const session=rewards.token,run=++syncRun;saving=true;syncText='Saving onchain…';syncHash=null;render();
      const active=()=>lifetime.alive()&&rewards.token===session&&run===syncRun;
      const show=data=>{const state=data.recipeSync||data;syncHash=state.transactionHash||null;syncText=state.error?'Saved locally. Onchain save pending: '+state.error:state.confirmed?'Skill saved onchain.':'Saving onchain…';render();return !!state.confirmed;};
      const poll=async()=>{if(!active())return;try{const data=await modeRead(rewards,'mode-profile',{tokenId:raw.tokenId});if(!active())return;const state=data.recipeSync||data;if(savedHash&&String(state.recipeHash||'').toLowerCase()!==savedHash.toLowerCase()){if(data.error){syncText='Saved locally. Onchain save needs retry: '+data.error;render();return;}lifetime.later(poll);return;}if(show(data))return;}catch(e){if(!active())return;syncText='Saved locally. Onchain status unavailable: '+e.message;render();}if(active())lifetime.later(poll);};
      let savedHash;
      try{const data=await rewards.request('workshop-save',{tokenId:raw.tokenId,recipe:valid});if(!active())return;savedHash=data.recipeHash;if(!show(data))lifetime.later(poll);}
      catch(e){if(active()){syncText='Saved locally. Onchain save failed: '+e.message;render();}}
      finally{saving=false;}
    }},
    {label:'LOAD SAVED',accept:()=>{recipeDirty=true;recipe=loadWorkshopSkill(localStorage,nft,progress)||defaultWorkshopSkill(nft);render();}},
    ...(menu._identity?.config?.network==='near-testnet'?[{label:'CRAFTING',accept:()=>{
      menu._closeModal(true);
      menu._go('crafting');
    }}]:[]),
    {label:'BACK',accept:back},
  ]});
  modal.classList.add('chog-workshop-modal','fox-workshop');
  modal.querySelector('.iw-modal__splat')?.replaceChildren(menu._headingSign());
  const lifetime=modalPollLifetime(modal);
  const body=h('div',{class:'chog-workshop-body'});modal.querySelector('.iw-modal__btns').before(body);
  const render=()=>{
    const focusId=menu._focus?.dataset?.id;
    for(const b of body.querySelectorAll('[data-nav]'))menu._binds.delete(b);
    body.replaceChildren(h('div',{class:'iw-seclabel'},raw?`${raw.name||'FOX'} · NFT #${raw.tokenId}`:nearSession?'ACCOUNT SKILL':'GUEST SKILL'));
    const options=workshopOptions(nft,progress);
    const choices=h('div',{class:'fox-workshop-choices'});
    for(const [field,key,title] of [['effect','effects','EFFECT'],['target','targets','TARGET'],['modifier','modifiers','MODIFIER']]){
      const row=h('div',{class:'chog-workshop-options'},h('div',{class:'iw-seclabel'},title));
      for(const option of options[key]){
        const b=menu._btn({id:`skill-${field}-${option.id}`,label:option.name,sub:`${option.cost}/${options.budget} · ${({mend:'+18 HP',empower:'+12% · 4s',ward:'−15% · 4s',self:'Self',nearby:'Squad · 8m',steady:'18s recharge',quick:'12s · Lower power',focused:'+Power · 24s',lasting:'+2s · 22s'})[option.id]}`,icon:({heart:bossStatIcons[2],bolt:GLYPHS.star,shield:bossStatIcons[1],person:GLYPHS.users,group:GLYPHS.users,clock:GLYPHS.clock})[option.icon]||GLYPHS.star,cls:'iw-btn--small',accept:()=>{recipeDirty=true;recipe={...recipe,[field]:option.id};render();}});
        b.disabled=option.unlocked===false;b.classList.toggle('is-selected',recipe[field]===option.id);b.setAttribute('aria-label',option.name+'. '+option.description);b.title=option.description+(b.disabled?option.traitValid===false?' · Requires matching NFT trait':` · Requires ${option.requiredWins} wins`:'');row.append(b);
      }choices.append(row);
    }
    const facts=h('p',{class:'iw-modal__text',role:'status'});
    try{const resolved=resolveWorkshopSkill(recipe,nft,progress);facts.textContent=describeWorkshopSkill(resolved);}
    catch(e){facts.textContent=e.message;}
    const sync=h('p',{class:'iw-modal__text',role:'status'});syncMessage(sync,syncText,syncHash);body.append(sync);
    const cost=['effect','target','modifier'].reduce((sum,field)=>sum+
      (options[field+'s'].find(option=>option.id===recipe?.[field])?.cost||0),0);
    const saved=loadWorkshopSkill(localStorage,nft,progress);
    const equipped=localStorage.getItem(workshopRaidStorageKey(nft,progress))==='workshop';
    const isSaved=['effect','target','modifier'].every(field=>saved?.[field]===recipe?.[field]);
    const presetList=h('div',{class:'chog-workshop-options'},h('div',{class:'iw-seclabel'},'PRESETS'));
    for(const preset of workshopPresets(nft,progress)){
      const button=menu._btn({id:`workshop-preset-${preset.id}`,label:preset.name,
        sub:preset.skill?describeWorkshopSkill(preset.skill):'Unlock the required parts',
        cls:'iw-btn--small',accept:()=>{if(preset.skill){recipeDirty=true;recipe=preset.recipe;render();}}});
      button.disabled=!preset.skill;
      presetList.append(button);
    }
    choices.append(presetList);
    body.append(h('div',{class:'fox-feature-grid fox-workshop-grid'},choices,
      h('aside',{class:'near-market-section fox-feature-card'},
        h('h3',{class:'iw-display'},'SKILL PREVIEW'),
        h('label',{class:'guild-meter'},h('span',null,'Skill points',h('b',null,cost+'/'+options.budget)),
          h('progress',{value:Math.min(cost,options.budget),max:options.budget})),
        h('p',null,equipped&&isSaved?'Equipped for Boss Battle':isSaved?'Saved preset':'Unsaved changes'),facts,
        !isSaved?h('p',null,`Saved • ${describeWorkshopSkill(resolveWorkshopSkill(saved,nft,progress))}`):null)));
    const focused=[...body.querySelectorAll('[data-id]')].find(b=>b.dataset.id===focusId);if(focused)menu._setFocus(focused,{snap:true});
  };render();
  if(nearSession){
    const active=()=>lifetime.alive()&&menu._identity===identity&&identity.nearSession===nearSession&&identity.nft?.tokenId===raw?.tokenId;
    readNearWorkshopProgress(identity).then(checkpoint=>{
      if(!active()||checkpoint.identity!==progress.identity)return;
      Object.assign(progress,checkpoint);
      if(!recipeDirty&&!saving)recipe=loadWorkshopSkill(localStorage,nft,progress);
      syncText=`${progress.wins} confirmed Boss clears · Skills are saved on this device.`;
      render();
    }).catch(()=>{
      if(!active())return;
      syncText='Boss win history is unavailable. Basic skills are still usable.';
      render();
    });
  }else if(raw&&menu.chogWallet.rewards.token){
    const rewards=menu.chogWallet.rewards,session=rewards.token;
    Promise.allSettled([rewards.request('raid-profile',{tokenId:raw.tokenId}),modeRead(rewards,'mode-profile',{tokenId:raw.tokenId})]).then(([history,profile])=>{
      if(!lifetime.alive()||rewards.token!==session)return;
      progress.wins=history.status==='fulfilled'&&Number.isSafeInteger(history.value.wins)?history.value.wins:0;
      if(!recipeDirty&&!saving){
        const data=profile.status==='fulfilled'?profile.value:null;
        let loadedOnchain=false;
        if(data?.recipe){try{recipe=saveWorkshopSkill(localStorage,data.recipe,nft,progress);loadedOnchain=true;}catch{recipe=loadWorkshopSkill(localStorage,nft,progress);}}
        else recipe=loadWorkshopSkill(localStorage,nft,progress);
        const state=data?.recipeSync||data;
        if(loadedOnchain&&state?.confirmed){syncText='Skill saved onchain.';syncHash=state.transactionHash||null;}
        else if(state?.pending||data?.syncPending){syncText='Onchain skill save pending.';syncHash=state.transactionHash||null;}
        else if(state?.error){syncText='Saved locally. Onchain save failed: '+state.error;syncHash=state.transactionHash||null;}
      }
      render();
      if(history.status==='rejected')menu.toast('Win history unavailable. Default skill remains usable.');
    });
  }
}
export function objectivePause(menu,screen,r){
  const mode=r.core.mode;
  screen.el.querySelector('.iw-pmatch__tag').textContent=modeName(mode);
  const labels=mode==='control'?['RED','BLUE','STATIONS','TIME']:['SCORE','PROGRESS','TIME','SKILL'];
  const stats=[...screen.el.querySelectorAll('.iw-pstat')];
  stats.forEach((el,i)=>{el.querySelector(':scope > small').textContent=labels[i];el.querySelector(':scope > i').innerHTML=[bossStatIcons[0],bossStatIcons[1],GLYPHS.target||GLYPHS.star,GLYPHS.clock][i];});
  const refresh=()=>{const c=r.uiState(),values=mode==='control'?[Math.floor(c.scores[0]),Math.floor(c.scores[1]),c.stations.filter(s=>s.owner===r.match.local.team).length,Math.ceil(c.time)]:[c.score,c.objectiveProgress,Math.ceil(c.time),Math.ceil(c.skillCooldown||0)+'s'];stats.forEach((el,i)=>{el.querySelector('b').textContent=values[i];});};
  const tick=screen.tick;screen.tick=dt=>{tick?.(dt);refresh();};refresh();
  return screen;
}
export function objectiveResults(menu,screen,context){
  const {result:r,runtime}=context,el=screen.el;
  const won=r.mode==='trials'?r.completed:r.winner===runtime.match.local.team;
  el.querySelector('.iw-res__title').textContent=r.winner===null&&r.mode==='control'?'DRAW':won?'MISSION COMPLETE':'MISSION FAILED';
  el.querySelector('.iw-res__meta').textContent=`${modeName(r.mode)} · ${String(r.reason||'').replaceAll('-',' ').toUpperCase()}`;
  el.querySelector('.iw-res__splat')?.replaceChildren(menu._headingSign());
  el.querySelectorAll('.iw-res__cover,.iw-xp,.iw-res__medals,.iw-res__tag').forEach(n=>n.remove());
  const summary=h('div',{class:'iw-panel chog-objective-summary iw-in iw-in--up'},h('div',{class:'iw-seclabel'},r.mode==='control'?'FINAL SCORE':'DAILY CHALLENGE'),h('b',{class:'iw-display'},r.mode==='control'?`${Math.floor(r.scores[0])} — ${Math.floor(r.scores[1])}`:String(r.score||0)),h('p',null,r.mode==='trials'?`${r.completed?'Completed':'Not completed'} · ${r.challenge?.id||r.challenge?.name||''}`:'First to 100 · Three stations'));
  el.querySelector('.iw-res__head').append(summary);
  const practiceCup=runtime.match.opts.practiceCup;
  const onlineCup=runtime.session?.room.config.cup;
  if(practiceCup){
    recordCupRound(practiceCup,r);
    const total=cupTime(practiceCup);
    summary.append(h('h3',null,'PLAZA CUP PRACTICE'),h('ol',null,practiceCup.results.map(round=>
      h('li',null,round.elapsedMs===null?'Did not finish':(round.elapsedMs/1000).toFixed(2)+'s'))));
    if(practiceCup.results.length===CUP_ROUNDS){
      summary.append(h('p',null,total===null?'Cup incomplete':`Total: ${(total/1000).toFixed(2)}s`));
    }else{
      summary.append(menu._btn({id:'next-cup-round',label:'NEXT ROUND',cls:'iw-btn--small',accept:()=>{
        if(menu._cupStarting)return;
        menu._cupStarting=true;
        Promise.resolve(menu.api.startMatch({mode:'trials',practiceCup}))
          .catch(error=>menu.toast(error.message)).finally(()=>{menu._cupStarting=false;});
      }}));
    }
  }
  if(onlineCup){
    summary.append(h('p',null,`Plaza Cup · Round ${onlineCup.round}/${CUP_ROUNDS}`));
    summary.append(menu._btn({id:'cup-results-standings',label:'VIEW STANDINGS',cls:'iw-btn--small',accept:async()=>{
      await runtime.leave();
      menu.show('chooseModes');
      openCupStandings(menu,onlineCup.day);
    }}));
  }
  if(r.mode==='trials'&&runtime.ghostTrace&&r.completed){
    const delta=runtime.ghostDelta;
    summary.append(h('p',null,Number.isFinite(delta)?Math.abs(delta).toFixed(2)+'s '+
      (delta<0?'ahead of':delta>0?'behind':'from')+(runtime.sharedGhost?' the shared ghost':' your local ghost'):null));
    if(runtime.ghostSaved)summary.append(h('p',null,'Local ghost saved'));
    summary.append(menu._btn({id:'share-trial-ghost',label:'COPY GHOST LINK',cls:'iw-btn--small',accept:async()=>{
      try{
        await navigator.clipboard.writeText(trialGhostLink(location.href,runtime.ghostKey,
          runtime.core.duration-runtime.core.time,runtime.ghostTrace));
        menu.toast('Ghost link copied. Open it and enter Daily Trials practice for this challenge.');
      }catch(error){menu.toast(error.message);}
    }}));
  }
  const rewards=menu.chogWallet?.rewards,tokenId=menu._identity?.nft?.tokenId,session=rewards?.token;
  let pollTimer=null,closed=false;const oldDestroy=screen.destroy;
  screen.destroy=()=>{closed=true;clearTimeout(pollTimer);oldDestroy?.call(screen);};
  if(!practiceCup&&!onlineCup&&session&&tokenId!=null&&r.roundId){
    const status=h('p',{class:'iw-modal__text',role:'status'},'Checking onchain record…');summary.append(status);
    const active=()=>!closed&&rewards.token===session;
    const poll=async()=>{
      if(!active())return;
      try{const data=await modeRead(rewards,'mode-record',{roundId:r.roundId,tokenId});if(!active())return;
        syncMessage(status,data.confirmed?'Record saved onchain.':data.error?'Onchain record pending: '+data.error:data.pending?'Saving onchain…':data.registry?'No verified onchain record for this round.':'Onchain registry unavailable.',data.transactionHash);
        if(data.confirmed||(!data.pending&&!data.error))return;
      }catch(e){if(!active())return;syncMessage(status,'Onchain status unavailable: '+e.message);}
      if(active())pollTimer=setTimeout(poll,5000);
    };void poll();
  }else summary.append(h('p',{class:'iw-modal__text'},'Local result · No onchain record.'));
  const replay=el.querySelector('[data-id="rematch"]'),home=el.querySelector('[data-id="home"]');
  replay.querySelector('.iw-btn__label').textContent='PLAY AGAIN';home.querySelector('.iw-btn__label').textContent='MAIN MENU';
  menu._binds.get(replay).accept=async()=>{menu._lobbyKind=r.mode;await runtime.leave?.();menu.show('lobby');};
  menu._binds.get(home).accept=async()=>{await runtime.leave?.();menu.show('main');};
  screen.onBack=async()=>{await runtime.leave?.();menu.show('main');};return screen;
}
