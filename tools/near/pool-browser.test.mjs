import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, mkdir } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

const root = new URL('../../', import.meta.url);
const evidence = new URL('docs/evidence/economy-v2-1/', root);
const executablePath = [process.env.CHOG_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('pool browser fixture: gates, finalized verification, exact calls, wallet changes and responsive panel', { skip: !executablePath }, async t => {
  let deployed = true;
  const server = createServer(async (req,res) => {
    const path = new URL(req.url,'http://fixture').pathname;
    if (path === '/') {
      res.setHeader('Content-Type','text/html');
      return res.end('<html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/styles/ui.css"><link rel="stylesheet" href="/styles/chog-original.css"><link rel="stylesheet" href="/styles/hunt-core.css"></head><body class="chog-original"><main class="iw-ui"></main></body></html>');
    }
    if (path === '/assets/near-fox/pool-deployment.js') {
      res.setHeader('Content-Type','text/javascript');
      return res.end('export const poolDeployment='+JSON.stringify(deployed?{accountId:'pool.testnet',codeHash:'fixture-code',receiptSignerId:'receipt.testnet'}:{accountId:null,codeHash:null,receiptSignerId:null}));
    }
    if (!/^\/(src|assets|styles)\/[a-z0-9_/.\-]+$/i.test(path) || path.includes('..')) return res.writeHead(404).end();
    try { const data=await readFile(new URL('.'+path,root)); res.setHeader('Content-Type',path.endsWith('.js')?'text/javascript':path.endsWith('.css')?'text/css':path.endsWith('.json')?'application/json':'application/octet-stream');res.end(data); }
    catch {res.writeHead(404).end();}
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  const fresh = async (options={}) => {
    const page=await browser.newPage();
    await page.setViewport({width:1280,height:720});
    await page.goto('http://127.0.0.1:'+server.address().port);
    await page.evaluate(async options=>{
      const {openNearPool}=await import('/src/ui/near-pool-ui.js');
      window.calls=[];window.reads=[];
      window.fixture={pool:{principal:'1000000000000000000000000',principal_in_flight:'0',reward_available:'5000000000000000000000000',reward_reserved:'1000000000000000000000000',reward_in_flight:'0',reward_paid:'0',starts_at_ms:Date.now()+3600000,ends_at_ms:Date.now()+86400000},position:{principal:'1000000000000000000000000',accrued_reward:'250000000000000000000000',registered:true},...options};
      const nativeFetch=window.fetch;
      window.fetch=async(url,init)=>{
        if(!String(url).startsWith('https://near-testnet.drpc.org'))return nativeFetch(url,init);
        const {params}=JSON.parse(init.body);window.reads.push(params);
        if(window.fixture.readDelay)await new Promise(resolve=>setTimeout(resolve,window.fixture.readDelay));
        if(params.request_type==='view_account')return new Response(JSON.stringify({result:{code_hash:window.fixture.badCode?'untrusted':'fixture-code',block_hash:'final-fixture'}}));
        const value=params.method_name==='get_config'?{tokenId:'foxo.xuancanh1.testnet',receiptSignerId:window.fixture.badConfig?'wrong.testnet':'receipt.testnet'}:params.method_name==='get_pool'?window.fixture.pool:window.fixture.position;
        return new Response(JSON.stringify({result:{result:[...new TextEncoder().encode(JSON.stringify(value))],block_hash:window.fixture.badFinality?'other-block':'final-fixture'}}));
      };
      const button=({id,label,accept,cls=''})=>{
        const el=document.createElement('button');el.id=id;el.className='iw-btn '+cls;el.dataset.nav=id;
        const text=document.createElement('span');text.className='iw-btn__label';text.textContent=label;el.append(text);el.addEventListener('click',accept);return el;
      };
      window.menu={_identity:{kind:'wallet',address:'alice.testnet',config:{network:'near-testnet'}},_binds:new Map(),_btn:button,
        _closeModal(){this._modal?.remove();this._modal=null;},
        _openModal({title,text,buttons}){this._closeModal();const modal=document.createElement('section');modal.className='iw-modal';modal.setAttribute('role','dialog');modal.setAttribute('aria-label',title);
          const card=document.createElement('div');card.className='iw-modal__card';const heading=document.createElement('h2');heading.className='iw-modal__title';heading.textContent=title;
          const note=document.createElement('p');note.className='iw-modal__text';note.textContent=text;
          const actions=document.createElement('div');actions.className='iw-modal__btns';buttons.forEach((entry,index)=>actions.append(button({id:'close-'+index,...entry})));card.append(heading,note,actions);modal.append(card);document.querySelector('main').append(modal);this._modal=modal;},
        chogWallet:{prepareWallet:async()=>{if(window.fixture.changeOnPrepare)window.menu._identity.address='bob.testnet';},nearActions:{functionCall:(method,args,gas,deposit)=>({method,args,gas:gas.toString(),deposit:deposit.toString()})},intear:{signAndSendTransaction:async call=>{window.calls.push(call);if(window.fixture.reject)throw new Error('Wallet request rejected.');return {status:{SuccessValue:''}};}}}};
      window.openPool=()=>openNearPool(window.menu);window.openPool();
    },options);
    return page;
  };
  const ready=page=>page.waitForFunction(()=>document.querySelector('#near-pool-refresh')?.disabled===false);
  try {
    browser=await puppeteer.launch({executablePath,headless:true});
    await t.test('null deployment offers no signing action',async()=>{
      deployed=false;const page=await fresh();assert.match(await page.$eval('[role=status]',el=>el.textContent),/awaiting verified deployment/);assert.equal(await page.$$eval('[data-pool-action]',els=>els.length),0);assert.equal(await page.evaluate(()=>window.reads.length),0);await page.close();deployed=true;
    });
    await t.test('untrusted code, configuration and finality fail closed',async()=>{
      for(const fault of ['badCode','badConfig','badFinality']){const page=await fresh({[fault]:true});await page.waitForFunction(()=>/mismatch/.test(document.querySelector('[role=status]').textContent));assert.equal(await page.$$eval('[data-pool-action]',els=>els.length),0);assert.equal(await page.evaluate(()=>window.calls.length),0);await page.close();}
    });
    await t.test('empty position and ended campaign retain disabled gates after refresh',async()=>{
      const page=await fresh({position:{principal:'0',accrued_reward:'0',registered:false}});await ready(page);
      for(const id of ['stake','withdraw','claim'])assert.equal(await page.$eval('#near-pool-'+id,el=>el.disabled),true);
      assert.equal(await page.$eval('#near-pool-register',el=>el.disabled),false);
      await page.evaluate(()=>{window.fixture.pool.starts_at_ms=Date.now()-1000;window.fixture.pool.ends_at_ms=Date.now()-1;});await page.click('#near-pool-refresh');await ready(page);
      assert.equal(await page.$eval('#near-pool-register',el=>el.disabled),true);assert.equal(await page.$eval('#near-pool-stake',el=>el.disabled),true);await page.close();
    });
    await t.test('exact register stake withdraw claim payloads; no false payment confirmation',async()=>{
      const page=await fresh({position:{principal:'1000000000000000000000000',accrued_reward:'250000000000000000000000',registered:false}});await ready(page);
      await page.click('#near-pool-register');await ready(page);assert.equal(await page.evaluate(()=>window.calls[0].actions[0].method),'register');
      await page.evaluate(()=>window.fixture.position.registered=true);await page.click('#near-pool-refresh');await ready(page);await page.type('input[inputmode=decimal]','0.15');await page.click('#near-pool-stake');await ready(page);
      await page.click('#near-pool-withdraw');await ready(page);await page.click('#near-pool-claim');await ready(page);
      const calls=await page.evaluate(()=>window.calls);assert.deepEqual(calls.map(call=>[call.signerId,call.receiverId,call.actions[0].method,call.actions[0].deposit]),[['alice.testnet','pool.testnet','register','0'],['alice.testnet','foxo.xuancanh1.testnet','ft_transfer_call','1'],['alice.testnet','pool.testnet','withdraw','1'],['alice.testnet','pool.testnet','claim','1']]);
      assert.ok(calls.every(call=>call.actions[0].gas==='100000000000000'));assert.equal(calls[1].actions[0].args.amount,'150000000000000000000000');assert.equal(calls[1].actions[0].args.receiver_id,'pool.testnet');assert.equal(calls[1].actions[0].args.msg,JSON.stringify({action:'stake'}));assert.equal(calls[2].actions[0].args.amount,'1000000000000000000000000');
      assert.match(await page.$eval('[role=status]',el=>el.textContent),/^$/);
      const reads=await page.evaluate(()=>window.reads);assert.ok(reads.filter(read=>read.request_type==='view_account').every(read=>read.finality==='final'));assert.ok(reads.filter(read=>read.request_type==='call_function').every(read=>read.block_id==='final-fixture'));
      await page.close();
    });
    await t.test('wallet identity changes abort before signing and stale code is rechecked',async()=>{
      for(const change of ['changeOnPrepare','badCode']){const page=await fresh();await ready(page);await page.evaluate(change=>window.fixture[change]=true,change);await page.click('#near-pool-claim');await page.waitForFunction(()=>/changed|mismatch/.test(document.querySelector('[role=status]').textContent));assert.equal(await page.evaluate(()=>window.calls.length),0);await page.close();}
      const page=await fresh({readDelay:80});await page.evaluate(()=>window.menu._identity.address='bob.testnet');await page.waitForFunction(()=>/changed/.test(document.querySelector('[role=status]').textContent));assert.equal(await page.$$eval('[data-pool-action]',els=>els.length),0);await page.close();
    });
    await t.test('wallet rejection is visible without payment claim',async()=>{const page=await fresh({reject:true});await ready(page);await page.click('#near-pool-claim');await page.waitForFunction(()=>document.querySelector('[role=status]').textContent==='Wallet request rejected.');await page.close();});
    await t.test('existing game CSS at desktop and narrow sizes',async()=>{
      const page=await fresh();await ready(page);await mkdir(evidence,{recursive:true});
      for(const [width,height] of [[1280,720],[1920,1080],[390,844]]){await page.setViewport({width,height});await page.screenshot({path:new URL('pool-'+width+'x'+height+'.png',evidence).pathname.replace(/^\/([A-Za-z]:)/,'$1'),fullPage:true});
        const overflow=await page.evaluate(()=>{const card=document.querySelector('.iw-modal__card');const bounds=card.getBoundingClientRect();return {page:document.documentElement.scrollWidth>innerWidth,card:card.scrollWidth>card.clientWidth+1,left:bounds.left,right:bounds.right};});assert.equal(overflow.page,false,JSON.stringify(overflow));assert.equal(overflow.card,false,JSON.stringify(overflow));assert.ok(overflow.left>=0&&overflow.right<=width);}
      await page.close();
    });
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

