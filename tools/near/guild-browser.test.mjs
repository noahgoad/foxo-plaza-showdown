import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';
const root=new URL('../../',import.meta.url);
const executablePath=[process.env.CHOG_BROWSER_PATH,'C:/Program Files/Google/Chrome/Application/chrome.exe','C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe','/usr/bin/chromium'].find(p=>p&&existsSync(p));
test('guild fixture reviews exact terms, persists contribution, retries same operation, blocks changed code and identity',{skip:!executablePath},async()=>{
 const server=createServer(async(req,res)=>{
  const path=new URL(req.url,'http://fixture').pathname;
  if(path==='/')return res.end('<html><body><main></main></body></html>');
  if(path==='/assets/near-fox/guild-deployment.js'){res.setHeader('Content-Type','text/javascript');return res.end("export const guildDeployment={accountId:'guild.testnet',codeHash:'guild-code'};");}
  if(path==='/assets/near-fox/economy-deployment.js'){res.setHeader('Content-Type','text/javascript');return res.end("export const economyDeployment={accountId:'economy.testnet',codeHash:'economy-code',recipes:[]};");}
  if(!/^\/(src|assets\/near-fox)\/[a-z0-9/.-]+\.js$/i.test(path)||path.includes('..'))return res.writeHead(404).end();
  try{res.setHeader('Content-Type','text/javascript');res.end(await readFile(new URL('.'+path,root)));}catch{res.writeHead(404).end();}
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));let browser;
 try{
  browser=await puppeteer.launch({executablePath,headless:true});const page=await browser.newPage();await page.goto('http://127.0.0.1:'+server.address().port);
  await page.evaluate(async()=>{
   const {openNearGuild}=await import('/src/ui/near-guild-ui.js');const {guildTermsHash}=await import('/src/economy/near-guild.js');
   const project={guild_id:'fox',deadline:'9999999999999999999',sku:'guild-banner-beacon-v2',fee_payer:'alice.testnet',status:'open',fee_state:'unfunded',totals:['0','0','0'],contributions:[]};project.terms_hash=await guildTermsHash({contract:'guild.testnet',projectId:'banner',project});
   let contribution=null;window.txs=[];window.saved=[];window.wrongCode=false;window.member=true;window.project=project;
   const real=fetch;window.fetch=async(url,opts)=>{
    if(!String(url).includes('near-testnet.drpc.org'))return real(url,opts);
    const {params:p}=JSON.parse(opts.body);if(p.request_type==='view_account')return new Response(JSON.stringify({result:{code_hash:window.wrongCode?'wrong':p.account_id==='guild.testnet'?'guild-code':'economy-code',block_hash:'final'}}));
    if(p.block_id!=='final')throw Error('Unpinned read');
    const value={get_config:p.account_id==='guild.testnet'?{economy_mt:'economy.testnet',foxo_contract_id:'foxo.xuancanh1.testnet'}:{network:'near-testnet',foxoContractId:'foxo.xuancanh1.testnet'},get_mt_migration:{finalized:true},guild:{active:true,leader:'alice.testnet',treasurer:'bob.testnet',governors:['alice.testnet','bob.testnet'],threshold:2,projects:['banner']},member:window.member,project,can_display:false,contribution}[p.method_name];
    return new Response(JSON.stringify({result:{result:[...new TextEncoder().encode(JSON.stringify(value))],block_hash:'final'}}));
   };
   const btn=(id,text,fn)=>{const b=document.createElement('button');b.id=id;b.textContent=text;b.onclick=fn;return b;};
   const menu={_identity:{kind:'wallet',address:'alice.testnet',config:{network:'near-testnet'}},_binds:new Map(),_btn:({id,label,accept})=>btn(id,label,accept),_closeModal(){this._modal?.remove();},_openModal({title,text,buttons}){this._modal?.remove();this._modal=document.createElement('section');const p=document.createElement('p');p.className='iw-modal__text';p.textContent=text;const div=document.createElement('div');div.className='iw-modal__btns';buttons.forEach((b,i)=>div.append(btn('nav-'+i,b.label,b.accept)));this._modal.append(title,p,div);document.querySelector('main').append(this._modal);},chogWallet:{prepareWallet:async()=>{},nearActions:{functionCall:(method,args,gas,deposit)=>({method,args,gas:String(gas),deposit:String(deposit)})},intear:{async signAndSendTransaction(tx){window.txs.push(tx);window.saved.push(localStorage.getItem('fox-guild-contribution:guild.testnet:alice.testnet'));if(window.txs.length===2){const a=tx.actions[0],m=JSON.parse(a.args.msg);contribution={project_id:m.project_id,contributor:'alice.testnet',token_ids:a.args.token_ids,amounts:a.args.amounts,status:'escrow'};project.contributions=[m.operation_id];project.totals=['12','1','0'];}return{status:{SuccessValue:''}};}}}};
   window.menu=menu;window.open=()=>openNearGuild(menu,()=>menu._closeModal());window.open();
  });
  async function load(){await page.type('#guild-id','fox');await page.type('#guild-project-id','banner');await page.click('#guild-load');await page.waitForFunction(()=>document.querySelector('#guild-contribution-review'));}
  await load();assert.equal(await page.evaluate(()=>window.txs.length),0);
  await page.evaluate(()=>{document.querySelector('#guild-material-alloy').value='12';document.querySelector('#guild-material-core').value='1';});await page.click('#guild-contribution-review');
  await page.waitForFunction(()=>document.querySelector('#guild-review').textContent.includes('12 alloy + 1 core'));
  assert.match(await page.$eval('#guild-review',e=>e.textContent),/15 FOXO.*Terms [a-f0-9]{64}/);
  await page.click('#guild-confirm');await page.waitForFunction(()=>document.body.innerText.includes('Saved operation retained'));
  await page.evaluate(()=>window.open());await load();await page.click('#guild-contribution-review');await page.waitForFunction(()=>!document.querySelector('#guild-confirm').disabled);await page.click('#guild-confirm');
  await page.waitForFunction(()=>window.txs.length===2&&document.querySelector('#guild-detail').textContent.includes('12/'));
  const txs=await page.evaluate(()=>window.txs);assert.deepEqual(txs[0].actions,txs[1].actions);assert.equal(txs[0].receiverId,'economy.testnet');assert.equal(txs[0].actions[0].deposit,'1');assert.ok((await page.evaluate(()=>window.saved)).every(Boolean));assert.equal(await page.evaluate(()=>localStorage.getItem('fox-guild-contribution:guild.testnet:alice.testnet')),null);
  await page.click('#guild-fee-review');await page.waitForFunction(()=>document.querySelector('#guild-review').textContent.includes('Pay exactly 15 FOXO'));await page.evaluate(()=>window.wrongCode=true);await page.click('#guild-confirm');await page.waitForFunction(()=>document.body.innerText.includes('code hash mismatch')&&!document.querySelector('#guild-confirm').disabled);assert.equal(await page.evaluate(()=>window.txs.length),2);
  await page.evaluate(()=>{window.wrongCode=false;window.menu.chogWallet.prepareWallet=async()=>{window.menu._identity.address='other.testnet';};});await page.click('#guild-confirm');await page.waitForFunction(()=>document.body.innerText.includes('Wallet or screen changed'));assert.equal(await page.evaluate(()=>window.txs.length),2);
 }finally{await browser?.close();await new Promise(r=>server.close(r));}
});
