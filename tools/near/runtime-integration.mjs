// Local-only protocol fixture: no wallet signatures, token settlement or live NFT ownership.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {mkdir,writeFile} from 'node:fs/promises';
import puppeteer from 'puppeteer-core';
import {createHuntRelay} from '../../server/hunt-relay.mjs';
import {SimulationRunner} from '../../server/rewards/runner.mjs';
import {createResultOutbox} from '../../server/near/result-outbox.mjs';
import {createFoxPassport} from '../../server/near/passport.mjs';
import {createFoxUsage} from '../../server/near/usage.mjs';
import {createFoxPassportRoutes} from '../../server/near/passport-routes.mjs';
import {rankingMetricsFromSimulation} from '../../server/near/ranking-rubric.mjs';
const executablePath=process.env.CHOG_BROWSER_PATH||'C:/Program Files/Google/Chrome/Application/chrome.exe';
const port=Number(process.env.NEAR_RUNTIME_FIXTURE_PORT || 8828);
const relayURL='http://127.0.0.1:'+port;
const database=new DatabaseSync(':memory:');
const usage=createFoxUsage({database}),passport=createFoxPassport({database,usage});
const nearAuth={account(token){if(token!=='local-integration-only')throw Error('Invalid fixture session');return 'fixture.testnet';}};
const runner=new SimulationRunner({relayURL,gameURL:'http://127.0.0.1:8817/dist/',executablePath,maxConcurrent:1});
const server=createHuntRelay({runner,nearAuth,nearUsage:usage,nearPassport:passport,
  nearRoutes:createFoxPassportRoutes({passport,usage,nearAuth}),
  nearResults:createResultOutbox(database,{passport,usage,confirmPractice:true,rankingMetrics:rankingMetricsFromSimulation})});
await new Promise(resolve=>server.listen(port,'127.0.0.1',resolve));
let browser;
const errors=[];
const requests=[];
const progress=setInterval(()=>console.log('FIXTURE',JSON.stringify([...server.rooms.values()].map(room=>({phase:room.phase,go:room.go,closed:room.closed,simulation:room.simulation})))),10000);progress.unref();
try {
  browser=await puppeteer.launch({executablePath,headless:true,args:['--enable-unsafe-swiftshader',
    '--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});
  const page=await browser.newPage();await page.setViewport({width:1280,height:720});
  page.on('pageerror',error=>errors.push(error.message));
  page.on('response',response=>{
    if(response.url().startsWith(relayURL+'/'))requests.push([new URL(response.url()).pathname,response.status()]);
  });
  await page.goto('http://127.0.0.1:8817/dist/?huntRelay='+encodeURIComponent(relayURL));
  console.log('Client loaded');
  await page.waitForFunction(()=>window.__inkwave?.menus?._scr?.el?.isConnected,{timeout:180000});
  await page.evaluate(()=>{
    const menu=__inkwave.menus;
    menu._identity={kind:'wallet',address:'fixture.testnet',nearSession:'local-integration-only',nearSessionExpires:Date.now()+3600000,
      config:{network:'near-testnet',nft:'fox.xuancanh1.testnet',token:'foxo.xuancanh1.testnet'},nft:null,tokenBalance:'0'};
    menu._huntMap=Math.max(0,menu._maps().findIndex(map=>map.id==='tidewater'));
    menu._lobbyKind='boss';menu.show('lobby',{force:true,wipe:false,light:false});
  });
  await page.waitForFunction(()=>{
    const button=document.querySelector('.iw-btn--ready:not(:disabled)');
    if(!button)return false;
    button.scrollIntoView({block:'nearest'});
    const {x,y,width,height}=button.getBoundingClientRect();
    return button.contains(document.elementFromPoint(x+width/2,y+height/2));
  },{timeout:15000});
  console.log('Boss lobby ready');
  await page.click('.iw-btn--ready');
  try {
    await page.waitForFunction(()=>__inkwave.menus.huntRoom?.room?.nearAuthoritative,{timeout:30000});
  } catch(error) {
    console.error('Quick Play startup', {requests,errors,client:await page.evaluate(()=>({
      screen:__inkwave.menus.current, pending:__inkwave.menus._nearQuickPending,
      notices:[...document.querySelectorAll('[role="status"], .iw-toast')].map(el=>el.textContent).slice(-5),
    }))});
    throw error;
  }
  await page.waitForFunction(()=>__inkwave.match?.raid?.session?.room?.nearAuthoritative&&__inkwave.match.raid.session.room.go,{timeout:240000});
  const running=await page.evaluate(()=>({mode:__inkwave.match.mode,authority:__inkwave.match.raid.session.isHost,
    phase:__inkwave.match.raid.session.room.phase,rewards:__inkwave.match.raid.session.room.rewardStatus}));
  assert.equal(running.authority,false);assert.equal(running.phase,'playing');
  assert.ok(running.rewards.every(row=>!row.guaranteed));
  await mkdir('docs/evidence/economy-v2-1',{recursive:true});
  await page.screenshot({path:'docs/evidence/economy-v2-1/near-quickplay-runtime.png'});
  const room=[...server.rooms.values()][0],job=runner.jobs.get(room.code);
  // Force only the local simulation fixture's outcome to verify the actual result path.
  await job.page.evaluate(()=>{const m=__inkwave.match;m.boss.hp=0;m.boss.dead=true;m.time=0;m.setState('finish');});
  await page.waitForFunction(()=>__inkwave.match?.raid?.core?.phase==='finished',{timeout:30000});
  const count=database.prepare('SELECT COUNT(*) AS count FROM near_results').get().count;
  assert.equal(count,1);assert.equal(passport.rank('fixture.testnet').bossWins,1);
  assert.equal(database.prepare('SELECT COUNT(*) AS count FROM near_result_metrics').get().count,1);
  assert.deepEqual(errors,[]);
  await writeFile('docs/evidence/economy-v2-1/near-quickplay-runtime.json',JSON.stringify({fixture:true,forcedOutcome:true,liveSignatures:false,liveRewards:false,running,resultRows:count,errors},null,2));
  console.log('PASS actual client/runner/relay result path; fixture outcome, no live rewards');
} finally {
  clearInterval(progress);
  for(const room of server.rooms.values())server.closeRoom(room.code,'Integration fixture finished');
  await runner.closeAll();
  if(browser)await runner._closeBrowser(browser);
  server.closeAllConnections();
  await new Promise(resolve=>server.close(resolve));database.close();
}
