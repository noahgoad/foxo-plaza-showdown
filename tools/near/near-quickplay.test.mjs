import assert from 'node:assert/strict';
import test from 'node:test';
import {isNearWalletPlayer,startNearQuickPlay} from '../../src/net/near-quickplay.js';
import {HuntRoomSession} from '../../src/net/hunt-room.js';
import {G} from '../../src/core/ctx.js';

const identity=()=>({kind:'wallet',address:'alice.testnet',nearSession:'signed-near-session',config:{network:'near-testnet'},nft:{tokenId:'001',contract:'fox.xuancanh1.testnet',name:'NEAR Fox #001',image:'https://example.com/fox.png'}});
const menu=()=>({_identity:identity(),huntRoom:null});
const fixture=(menus,hook=()=>{})=>{
 const calls=[];
 const session={room:{phase:'lobby'},async enter(code,options){calls.push(['enter',code,options]);await hook('enter');},async settings(...args){calls.push(['settings',...args]);await hook('settings');},async start(){calls.push(['start']);await hook('start');this.room={phase:'queued',nearAuthoritative:true};},async poll(){calls.push(['poll']);},async leave(){calls.push(['leave']);if(menus.huntRoom===this)menus.huntRoom=null;}};
 return {session,calls};
};
const opts={mapId:'tidewater',time:'dusk',mode:'boss'};

test('NEAR QuickPlay creates/configures/starts authoritative room before polling; double click starts once',async()=>{
 const menus=menu();let resume;const deferred=new Promise(resolve=>resume=resolve);const {session,calls}=fixture(menus,async action=>{if(action==='enter')await deferred;});let creates=0;
 const first=startNearQuickPlay(menus,opts,()=>{creates++;return session;});
 assert.equal(await startNearQuickPlay(menus,opts,()=>{throw Error('Duplicate room');}),null);
 resume();assert.equal(await first,session);assert.equal(creates,1);assert.deepEqual(calls,[['enter',undefined,{poll:false}],['settings','tidewater','dusk','boss'],['start'],['poll']]);assert.equal(menus._nearQuickPending,false);assert.equal(menus.huntRoom,session);
});

test('NEAR QuickPlay rejects account, session, NFT, network and screen changes and cleans up',async()=>{
 for(const stage of ['enter','settings','start'])for(const change of ['account','session','nft','network','screen']){
  const menus=menu();let mounted=true;const {session,calls}=fixture(menus,async action=>{if(action!==stage)return;if(change==='account')menus._identity.address='bob.testnet';if(change==='session')menus._identity.nearSession='other';if(change==='nft')menus._identity.nft.tokenId='002';if(change==='network')menus._identity.config.network='mainnet';if(change==='screen')mounted=false;});
  await assert.rejects(startNearQuickPlay(menus,opts,()=>session,()=>mounted),/changed/);assert.equal(calls.at(-1)[0],'leave');assert.equal(calls.some(call=>call[0]==='poll'),false);assert.equal(menus.huntRoom,null);assert.equal(menus._nearQuickPending,false);
 }
});

test('rejection/capacity/relay error and non-authoritative server clean up without local fallback',async()=>{
 for(const stage of ['enter','settings','start']){
  const menus=menu();const {session,calls}=fixture(menus,async action=>{if(action===stage)throw Error(stage==='start'?'Match queue is full.':'Request rejected');});
  await assert.rejects(startNearQuickPlay(menus,opts,()=>session),/full|rejected/);assert.equal(calls.at(-1)[0],'leave');assert.equal(calls.some(call=>call[0]==='poll'),false);assert.equal(menus.huntRoom,null);assert.equal(menus._nearQuickPending,false);
 }
 const menus=menu(),{session,calls}=fixture(menus);session.start=async()=>{session.room={phase:'loading',nearAuthoritative:false};};await assert.rejects(startNearQuickPlay(menus,opts,()=>session),/unavailable/);assert.equal(calls.at(-1)[0],'leave');
});

test('guest stays outside NEAR route; unsigned wallet cannot start',async()=>{
 assert.equal(isNearWalletPlayer({kind:'guest'}),false);const menus=menu();menus._identity.nearSession=null;await assert.rejects(startNearQuickPlay(menus,opts,()=>{throw Error('Must not create');}),/Sign in/);
});

test('HuntRoom profile preserves signed NEAR session, NFT, weapon and server workshop progression; never inherits EVM verification',async()=>{
 const originalLocation=globalThis.location,originalStorage=globalThis.localStorage,originalFetch=globalThis.fetch;
 const store=new Map();globalThis.location={search:'',protocol:'http:',hostname:'127.0.0.1'};globalThis.localStorage={getItem:key=>store.get(key)??null,setItem:(key,value)=>store.set(key,value)};G.game={profile:{weapon:'shooter',style:{}}};
 const menus={...menu(),_profile:()=>({name:'Alice',weapon:'charger'}),toast:()=>{},chogWallet:{requirePlayer:()=>true,gameLedger:()=>({balance:10}),rewards:{token:'stale-evm-token',config:{},request:()=>{throw Error('Wrong EVM route');}}}};
 try{
  const session=new HuntRoomSession(menus);session.nearWorkshopProgress={identity:'fox.xuancanh1.testnet:001',wins:2};
  const profile=session.profile();assert.equal(profile.nearSession,'signed-near-session');assert.equal(profile.tokenId,'001');assert.equal(profile.nftImage,'https://example.com/fox.png');assert.equal(profile.name,'Alice');assert.equal(profile.weapon,'charger');assert.equal(profile.verified,false);assert.equal(profile.walletSession,undefined);assert.equal(profile.identity,'guest');
  let poll=0;session.poll=async()=>{poll++;};session.readNearWorkshopProgress=async()=>{};session.request=async(action)=>{assert.equal(action,'create');session.room={code:'ABCDE',phase:'lobby'};return {id:'player',token:'room-token'};};await session.enter(undefined,{poll:false});assert.equal(poll,0);assert.equal(session.token,'room-token');
 }finally{globalThis.location=originalLocation;globalThis.localStorage=originalStorage;globalThis.fetch=originalFetch;delete G.game;}
});

test('HuntRoom cleans up server membership if wallet changes while create is in flight',async()=>{
 const originalLocation=globalThis.location;globalThis.location={search:'',protocol:'http:',hostname:'127.0.0.1'};
 try{
  const menus={...menu(),chogWallet:{requirePlayer:()=>true,rewards:{}}},session=new HuntRoomSession(menus),requests=[];menus.huntRoom=session;
  session.readNearWorkshopProgress=async()=>{};session.profile=()=>({nearSession:'signed-near-session'});session.request=async action=>{requests.push(action);if(action==='create'){menus._identity.address='bob.testnet';session.room={code:'ABCDE',phase:'lobby'};return{id:'player',token:'room-token'};}return{};};
  await assert.rejects(session.enter(undefined,{poll:false}),/changed/);assert.deepEqual(requests,['create','leave']);assert.equal(menus.huntRoom,null);assert.equal(session.closed,true);
 }finally{globalThis.location=originalLocation;}
});


test('leaving while queued sync is in flight cannot launch a late loading response',async()=>{
 const originalLocation=globalThis.location;globalThis.location={search:'',protocol:'http:',hostname:'127.0.0.1'};
 try{
  let launches=0,resume,started;const requested=new Promise(resolve=>started=resolve),pending=new Promise(resolve=>resume=resolve);
  G.game={startMatch:async()=>{launches++;}};
  const menus={...menu(),toast:()=>{}},session=new HuntRoomSession(menus);menus.huntRoom=session;session.room={phase:'queued',config:{mode:'boss'}};
  session.request=async action=>{if(action==='sync'){started();await pending;session.room={phase:'loading',config:{mode:'boss'}};}return{};};
  const polling=session.poll();await requested;await session.leave();resume();await polling;assert.equal(launches,0);assert.equal(session.closed,true);assert.equal(session.timer,undefined);
 }finally{globalThis.location=originalLocation;delete G.game;}
});
