// Real simulation runner with local account/session fixtures; no wallet or chain mutation.
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {writeFile} from 'node:fs/promises';
import {createHuntRelay} from '../../server/hunt-relay.mjs';
import {SimulationRunner} from '../../server/rewards/runner.mjs';
import {createResultOutbox} from '../../server/near/result-outbox.mjs';
import {createFoxPassport} from '../../server/near/passport.mjs';
import {rankingMetricsFromSimulation} from '../../server/near/ranking-rubric.mjs';
const database=new DatabaseSync(':memory:'),passport=createFoxPassport({database});
const runner=new SimulationRunner({relayURL:'http://127.0.0.1:8829',gameURL:'http://127.0.0.1:8817/dist/',maxConcurrent:1});
const server=createHuntRelay({runner,nearAuth:{account:token=>{if(token!=='local-only')throw Error('Invalid fixture');return 'fixture.testnet';}},
  nearResults:createResultOutbox(database,{passport,confirmPractice:true,rankingMetrics:rankingMetricsFromSimulation})});
await new Promise(resolve=>server.listen(8829,'127.0.0.1',resolve));
const call=async(action,body={},token)=>{
  const response=await fetch('http://127.0.0.1:8829/'+action,{method:'POST',headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:JSON.stringify(body)});
  const result=await response.json();if(!response.ok)throw Error(result.error);return result;
};
const wait=async(fn,label,ms=180000)=>{const end=Date.now()+ms;while(Date.now()<end){const result=await fn();if(result)return result;await new Promise(resolve=>setTimeout(resolve,300));}throw Error('Timed out '+label);};
let heartbeat;
try {
 const host=await call('create',{identity:'guest',nearSession:'local-only',name:'Fixture'}),code=host.room.code;
 await call('settings',{code,mode:'boss',mapId:'tidewater'},host.token);
 const started=await call('start',{code},host.token);assert.equal(started.room.nearAuthoritative,true);
 heartbeat=setInterval(()=>{const room=server.rooms.get(code);if(room&&!room.closed)call(room.phase==='loading'?'ready':'sync',{code},host.token).catch(()=>{});},500);
 await wait(()=>server.rooms.get(code)?.go,'worker loaded');
 const job=runner.jobs.get(code),page=job.page;
 await wait(()=>page.evaluate(()=>__inkwave.match?.raid&&__inkwave.match.state==='playing'),'boss playing');
 const live=await page.evaluate(()=>({mode:__inkwave.match.mode,actors:__inkwave.match.actors.length,simulation:__inkwave.match.raid.session.simulation}));
 assert.equal(live.simulation,true);assert.equal(live.actors,6);
 await assert.rejects(call('sync',{code,snapshot:{core:{phase:'finished'}}},host.token),/authority/);
 await page.evaluate(()=>{const m=__inkwave.match;m.boss.hp=0;m.boss.dead=true;m.time=0;m.setState('finish');});
 await wait(()=>database.prepare('SELECT COUNT(*) AS n FROM near_results').get().n===1,'result persisted',30000);
 assert.equal(passport.rank('fixture.testnet').bossWins,1);
 assert.equal(database.prepare('SELECT COUNT(*) AS n FROM near_result_metrics').get().n,1);
 assert.deepEqual(job.errors,[]);
 await writeFile('docs/evidence/economy-v2-1/near-worker-runtime.json',JSON.stringify({fixture:true,forcedOutcome:true,walletSigned:false,chainRewards:false,live,resultRows:1,metricsRows:1,workerErrors:job.errors},null,2));
 console.log('PASS actual NEAR authoritative worker/result/Passport/metrics; local identity and forced outcome fixture');
} finally {
 clearInterval(heartbeat);for(const room of server.rooms.values())server.closeRoom(room.code,'Fixture finished');
 await runner.closeAll();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));database.close();
}
