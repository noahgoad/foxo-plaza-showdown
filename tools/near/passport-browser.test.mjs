import assert from 'node:assert/strict';
import {existsSync} from 'node:fs';
import {readFile,mkdir} from 'node:fs/promises';
import {createServer} from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
const root=new URL('../../',import.meta.url);
const executablePath=[process.env.CHOG_BROWSER_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium'].find(path=>path&&existsSync(path));

test('Fox passport browser tabs, authenticated usage review and wallet guards',{skip:!executablePath},async t=>{
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture').pathname;
  if(path==='/'){res.setHeader('Content-Type','text/html');return res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/ui.css"><link rel="stylesheet" href="/styles/chog-original.css"><link rel="stylesheet" href="/styles/hunt-core.css"></head><body class="chog-original"><main></main></body></html>');}
  if(!/^\/(src|assets|styles)\/[a-z0-9_/.\-]+$/i.test(path)||path.includes('..'))return res.writeHead(404).end();
  try{res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.json')?'application/json':'application/octet-stream');res.end(await readFile(new URL('.'+path,root)));}catch{res.writeHead(404).end();}
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
 const fresh=async(options={})=>{
  const page=await browser.newPage();await page.setViewport({width:1280,height:720});await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async options=>{
   const {openNearPassport}=await import('/src/ui/near-passport-ui.js');window.requests=[];window.toasts=[];
   window.fixture={owner:'alice.testnet',...options};
   const identity={collectionId:'fox.xuancanh1.testnet',contract:'fox.xuancanh1.testnet',tokenId:'001',name:'NEAR Fox #001',ownerId:window.fixture.owner,blockHeight:12345};
   const loanIdentity={...identity,tokenId:'002',name:'NEAR Fox #002',ownerId:'lender.testnet'};
   window.passport={identity,career:{finalized:{matches:4,xp:120},pending:{matches:1},entitlements:{title:{label:'Fox Scout'},presets:[{effect:'mend',target:'self',modifier:'steady'}]},history:[{mode:'boss',accountId:'alice.testnet',finalized:true,rulesVersion:'career-v1'},{mode:'trials',accountId:'alice.testnet',finalized:false,rulesVersion:'near-practice-v1'}]},usage:{ownerId:identity.ownerId,active:true}};
   window.incoming=[{identity:loanIdentity,borrowerId:'alice.testnet',modes:['boss','trials'],expiresAt:Date.now()+3600000}];window.outgoing=[{borrowerId:'bob.testnet',modes:['boss'],expiresAt:Date.now()+7200000}];
   const nativeFetch=fetch;window.fetch=async(url,init={})=>{
    const path=String(url),body=init.body?JSON.parse(init.body):null;window.requests.push({path,body});
    if(path.startsWith('https://near-testnet.drpc.org'))return new Response(JSON.stringify({result:{result:[...new TextEncoder().encode(JSON.stringify({token_id:'002',owner_id:'lender.testnet',metadata:{title:'NEAR Fox #002',media:'https://example.com/fox.png'}}))],block_hash:'final-ownership'}}));
    if(!path.includes('/near/'))return nativeFetch(url,init);
    if(window.fixture.delay)await new Promise(resolve=>setTimeout(resolve,window.fixture.delay));
    if(window.fixture.error)return new Response(JSON.stringify({error:'Passport service is unavailable.'}),{status:503});
    const result=path.includes('/near/passport/')?window.passport:path.endsWith('/near/usage/list')?{loans:window.incoming}:path.endsWith('/near/usage/owned')?{usage:{ownerId:identity.ownerId,grants:window.outgoing,lease:{actorId:'bob.testnet',expiresAt:Date.now()+120000}}}:path.endsWith('/near/usage/grant')?{grant:body}:path.endsWith('/near/usage/revoke')?{revoked:true}:path.endsWith('/near/workshop/progress')?{progress:{wins:2}}:{};
    return new Response(JSON.stringify(result));
   };
   const button=({id,label,accept,cls=''})=>{const el=document.createElement('button');el.id=id;el.dataset.nav=id;el.className='iw-btn '+cls;const span=document.createElement('span');span.className='iw-btn__label';span.textContent=label;el.append(span);el.addEventListener('click',accept);return el;};
   window.menu={_identity:{kind:'wallet',address:'alice.testnet',nearSession:'signed-session',nearSessionExpires:Date.now()+3600000,config:{network:'near-testnet'},nft:identity},_binds:new Map(),_btn:button,_setFocus:el=>el?.focus(),toast:text=>window.toasts.push(text),chogWallet:{repaint:()=>{}},_closeModal(){this._modal?.remove();this._modal=null;},_openModal({title,text,buttons}){const modal=document.createElement('section');modal.className='iw-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-label',title);const card=document.createElement('div');card.className='iw-modal__card';const heading=document.createElement('h2');heading.className='iw-modal__title';heading.textContent=title;const note=document.createElement('p');note.className='iw-modal__text';note.textContent=text;const actions=document.createElement('div');actions.className='iw-modal__btns';buttons.forEach((entry,index)=>actions.append(button({id:'close-'+index,...entry})));card.append(heading,note,actions);modal.append(card);document.querySelector('main').append(modal);this._modal=modal;}};
   openNearPassport(window.menu,identity);
  },options);return page;
 };
 const ready=page=>page.waitForFunction(()=>document.querySelector('#passport-tab-identity')?.disabled===false&&document.body.innerText.includes('CURRENT OWNER'));
 const tab=async(page,id)=>{await page.click('#passport-tab-'+id);await page.waitForFunction(id=>document.querySelector('#passport-tab-'+id)?.getAttribute('aria-selected')==='true'&&!document.querySelector('#passport-tab-'+id)?.disabled,{},id);};
 try{browser=await puppeteer.launch({executablePath,headless:true});
  await t.test('an account with no owned NFT can select an incoming usage loan',async()=>{
   const page=await fresh();await ready(page);
   await page.evaluate(async()=>{
    menu._closeModal();menu._identity.nft=null;
    const {openIncomingFoxLoans}=await import('/src/ui/near-loans-ui.js');openIncomingFoxLoans(menu);
   });
   await page.waitForSelector('#borrowed-use-0');
   await page.click('#borrowed-use-0');
   await page.waitForFunction(()=>menu._identity.nft?.borrowed===true);
   const nft=await page.evaluate(()=>menu._identity.nft);
   assert.equal(nft.ownerId,'lender.testnet');assert.equal(nft.tokenId,'002');
   assert.deepEqual(nft.ownedTokenIds,[]);assert.equal(nft.sourceLoan.borrowerId,'alice.testnet');
   assert.equal(await page.evaluate(()=>menu._modal),null);
   await page.close();
  });
  await t.test('chain identity, local career and loadout labels are separate; tabs keep keyboard focus',async()=>{const page=await fresh();await ready(page);assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/alice.testnet/);assert.equal(await page.evaluate(()=>document.activeElement.id),'passport-tab-identity');await page.keyboard.press('ArrowRight');await page.waitForFunction(()=>document.body.innerText.includes('SERVER-CONFIRMED MATCHES'));assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/Local server career records/);assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/Local practice/);await tab(page,'loadout');assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/MEND · SELF · STEADY/);await page.close();});
  await t.test('grant and revoke require explicit review, authenticated exact scope, and show TTL',async()=>{const page=await fresh();await ready(page);await tab(page,'usage');assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/lender.testnet/);assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/TIME LEFT/);assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/bob.testnet/);assert.match(await page.$eval('#fox-passport-panel',el=>el.innerText),/already accepted session/);
   await page.type('input[aria-label="Borrower NEAR account"]','carol.testnet');await page.click('#passport-grant');assert.equal(await page.evaluate(()=>window.requests.filter(row=>row.path.endsWith('/grant')).length),0);await page.click('#passport-confirm-grant');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('Server usage updated'));
   const call=await page.evaluate(()=>window.requests.find(row=>row.path.endsWith('/grant')).body);assert.equal(call.nearSession,'signed-session');assert.equal(call.borrowerId,'carol.testnet');assert.deepEqual(call.nft,{collectionId:'fox.xuancanh1.testnet',tokenId:'001'});assert.deepEqual(call.modes,['boss']);assert.ok(call.expiresAt>Date.now()+23*3600000&&call.expiresAt<Date.now()+25*3600000);
   await page.click('#passport-revoke-bob\\.testnet');await page.click('#passport-confirm-revoke');await page.waitForFunction(()=>window.requests.some(row=>row.path.endsWith('/revoke')));const revoke=await page.evaluate(()=>window.requests.find(row=>row.path.endsWith('/revoke')).body);assert.equal(revoke.borrowerId,'bob.testnet');assert.equal(revoke.nearSession,'signed-session');await page.close();});
  await t.test('owner controls require current chain owner and incoming loan selection retains owner',async()=>{const page=await fresh({owner:'different.testnet'});await ready(page);await tab(page,'usage');assert.equal(await page.$('#passport-grant'),null);await page.click('#passport-use-002');await page.waitForFunction(()=>window.menu._identity.nft.borrowed===true);const nft=await page.evaluate(()=>window.menu._identity.nft);assert.equal(nft.ownerId,'lender.testnet');assert.equal(nft.sourceLoan.borrowerId,'alice.testnet');assert.equal(nft.tokenId,'002');assert.equal(await page.evaluate(()=>window.menu._modal),null);assert.ok(await page.evaluate(()=>window.requests.some(row=>row.path.endsWith('/near/workshop/progress')&&row.body.nearSession==='signed-session')));await page.close();});
  await t.test('mutated wallet and late responses cannot mutate usage or render another identity',async()=>{const page=await fresh();await ready(page);await tab(page,'usage');await page.type('input[aria-label="Borrower NEAR account"]','carol.testnet');await page.click('#passport-grant');await page.evaluate(()=>window.menu._identity.address='bob.testnet');await page.click('#passport-confirm-grant');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('changed'));assert.equal(await page.evaluate(()=>window.requests.filter(row=>row.path.endsWith('/grant')).length),0);await page.close();const delayed=await fresh({delay:100});await delayed.evaluate(()=>window.menu._identity.nearSession='other-session');await delayed.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('changed'));assert.equal(await delayed.$eval('#fox-passport-panel',el=>el.innerText.includes('CURRENT OWNER')),false);await delayed.close();});
  await t.test('safe error and existing style responsive previews',async()=>{const bad=await fresh({error:true});await bad.waitForFunction(()=>document.querySelector('[role=status]').textContent.includes('unavailable'));await bad.close();const page=await fresh();await ready(page);const dir=new URL('docs/evidence/economy-v2-1/',root);await mkdir(dir,{recursive:true});for(const [width,height]of [[1280,720],[390,844]]){await page.setViewport({width,height});await page.screenshot({path:new URL('passport-identity-'+width+'x'+height+'.png',dir).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth),false);}await page.setViewport({width:1280,height:720});await tab(page,'usage');await page.screenshot({path:new URL('passport-usage-1280x720.png',dir).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});await page.close();});
 }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
