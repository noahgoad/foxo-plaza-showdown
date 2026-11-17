import test from 'node:test';
import assert from 'node:assert/strict';
import {DatabaseSync} from 'node:sqlite';
import {createHuntRelay} from '../../server/hunt-relay.mjs';
import {createCupBrackets} from '../../server/near/event-bracket.mjs';
import {placeHuntDecoy} from '../../src/game/foxo-event-rules.js';

test('decoy expires and requires a live Hunter with cooldown ready',()=>{
 const placement={now:1000,active:true,hunter:true,position:{x:1,y:2,z:3}};
 assert.deepEqual(placeHuntDecoy(placement),{position:placement.position,endsAt:7000,readyAt:23000});
 assert.equal(placeHuntDecoy({...placement,hunter:false}),null);
 assert.equal(placeHuntDecoy({...placement,readyAt:1100}),null);
});

test('Cup caps enrollment at eight and closes unfinished entries at deadline',()=>{
 let time=Date.parse('2026-11-15T15:00:00Z');
 const bracket=createCupBrackets({now:()=>time});
 for(let i=0;i<8;i++)bracket.reserve('wallet-'+i,'Player '+i,'match-'+i);
 assert.equal(bracket.status().phase,'running');
 assert.throws(()=>bracket.reserve('wallet-8','Player 8','match-8'),/registration is closed/);
 time+=45*60_000;
 assert.equal(bracket.status().phase,'finished');
 assert.ok(bracket.status().entries.every(row=>row.dnf&&row.position===null));
});

test('Cup retains completed attempts across restart and releases a lost active room',()=>{
 const database=new DatabaseSync(':memory:');
 const now=()=>Date.parse('2026-11-15T15:00:00Z');
 try{
  const first=createCupBrackets({now,database});
  const {day}=first.reserve('player','Runner','round-1');
  first.closeRound({day,account:'player',matchId:'round-1'});
  first.reserve('player','Runner','lost-room');
  const restarted=createCupBrackets({now,database});
  assert.equal(restarted.status().entries[0].roundCount,1);
  assert.equal(restarted.reserve('player','Runner','round-2').round,2);
 }finally{database.close();}
});

test('party host changes group mode without replacing the room or its roster',async()=>{
 const relay=createHuntRelay();
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
 const request=async(action,body,token)=>fetch(`http://127.0.0.1:${relay.address().port}/${action}`,{
  method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
  body:JSON.stringify(body),
 }).then(response=>response.json());
 try{
  const host=await request('create',{identity:'guest',name:'Host'});
  const code=host.room.code;
  const guest=await request('join',{identity:'guest',name:'Guest',code});
  assert.match((await request('settings',{code,mode:'boss'},guest.token)).error,/Only host/);
  for(const mode of ['control','boss','hunt']){
   const changed=await request('settings',{code,mode,mapId:'tidewater'},host.token);
   const observed=await request('sync',{code},guest.token);
   assert.equal(changed.room.code,code);
   assert.equal(observed.room.config.mode,mode);
   assert.deepEqual(observed.room.players.map(player=>player.id),[host.id,guest.id]);
  }
 }finally{await new Promise(resolve=>relay.close(resolve));}
});

test('Cup ranks simulator results and bypasses the ordinary payout adapters',async()=>{
 let simulator,settlements=0;
 const runner={launch:async room=>{simulator=room.simulator;},close:()=>{}};
 const nearAuth={account:token=>token};
 const nearResults={record:()=>{settlements++;throw Error('Unexpected reward result');}};
 const nearFixedRewards={ready:()=>{settlements++;throw Error('Unexpected reservation');}};
 const relay=createHuntRelay({runner,nearAuth,nearResults,nearFixedRewards});
 await new Promise(resolve=>relay.listen(0,'127.0.0.1',resolve));
 const request=async(action,body,token)=>fetch(`http://127.0.0.1:${relay.address().port}/${action}`,{
  method:'POST',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},
  body:JSON.stringify(body),
 }).then(response=>response.json());
 try{
  for(let round=1;round<=3;round++){
   const {room,token}=await request('create',{identity:'guest',nearSession:'pilot.testnet',name:'Fox Pilot'});
   const code=room.code;
   await request('settings',{code,mode:'trials',cup:true},token);
   const started=(await request('start',{code},token)).room;
   assert.equal(started.config.cup.round,round);
   await request('ready',{code},token);
   assert.equal((await request('ready',{code},simulator.token)).room.go,true);
   const {challenge}=started.config,time=challenge.duration-10;
   const result={mode:'trials',version:challenge.version,roundId:started.roundId,players:[{id:'hunt-0',left:false}],
    challenge,objectiveProgress:8,score:800+time*2,time,completed:true,winner:0,reason:'completed'};
   const snapshot={core:{phase:'finished',result}};
   assert.match((await request('sync',{code,snapshot},token)).error,/authority/);
   assert.equal((await request('sync',{code,snapshot},simulator.token)).error,undefined);
   await request('leave',{code},token);
  }
  const standings=await request('plaza-cup/status',{});
  assert.equal(standings.entries[0].position,1);
  assert.equal(standings.entries[0].totalMs,30000);
  assert.equal(standings.entries[0].name,'Fox Pilot');
  assert.equal(settlements,0);
 }finally{await new Promise(resolve=>relay.close(resolve));}
});
