import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HuntCore} from '../../src/game/hunt-core.js';
import {huntCaptureHighlight,huntReplayEvent} from '../../src/game/foxo-event-schema.js';
import {workshopPresets} from '../../src/game/foxo-preset-discovery.js';
import {createPracticeCup,cupTime,recordCupRound} from '../../src/game/foxo-event-rules.js';

test('a capture highlights the traits inherited at that exact transition',()=>{
 const traits=['head','body','eyes'].map(id=>({id,category:id,value:id}));
 const core=new HuntCore({players:Array.from({length:6},(_,id)=>({id:String(id)})),traits,holderId:'0',roundId:'test'});
 for(let i=0;i<7;i++)core.step(1);
 for(const trait of traits.slice(0,2))core.reveal('0',{id:trait.id,kind:'trait',trait});
 assert.equal(core.hit('1','0'),true);
 const records=[];
 for(const event of core.drain()){
  const record=huntReplayEvent(event,core,records.length);
  if(record)records.push(record);
 }
 assert.deepEqual(records.filter(event=>event.type==='trait_collected').map(event=>event.payload.traitCount),[1,2]);
 assert.deepEqual(huntCaptureHighlight(records).payload,{previousCarrier:'0',carrier:'1',traitCount:2,disconnect:false});
});

test('Workshop supplies six named choices and respects Boss-clear unlocks',()=>{
 const nft=null;
 const guest=Object.fromEntries(workshopPresets(nft,{}).map(preset=>[preset.id,preset.skill]));
 const accountProgress={identity:'guest',source:'near-account',wins:3};
 const account=workshopPresets(nft,accountProgress);
 assert.equal(account.length,6);
 assert.equal(guest['rescue-circle'],null);
 assert.equal(guest['rapid-recovery'].cooldown,12);
 assert.ok(account.every(preset=>preset.skill&&preset.skill.cost<=5));
});

test('Cup keeps three unique rounds against the original challenge and excludes DNF totals',()=>{
 const makeRound=(cup,id,completed=true)=>({roundId:id,mode:'trials',version:cup.challenge.version,
  challenge:cup.challenge,time:cup.challenge.duration-10,completed});
 const cup=createPracticeCup('2026-11-15');
 assert.equal(recordCupRound(cup,makeRound(cup,'1')),true);
 assert.equal(recordCupRound(cup,makeRound(cup,'1')),false);
 assert.equal(recordCupRound(cup,makeRound(createPracticeCup('2026-11-16'),'2')),false);
 assert.equal(recordCupRound(cup,makeRound(cup,'2')),true);
 assert.equal(cupTime(cup),null);
 assert.equal(recordCupRound(cup,makeRound(cup,'3')),true);
 assert.equal(cupTime(cup),30000);
 assert.equal(recordCupRound(cup,makeRound(cup,'4')),false);
 const dnf=createPracticeCup('2026-11-15');
 for(const id of ['1','2','3'])recordCupRound(dnf,makeRound(dnf,id,id!=='2'));
 assert.equal(cupTime(dnf),null);
});
