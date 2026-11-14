import {dailyChallenge} from '../src/game/objective-rules.js';
import {defaultWorkshopSkill,validateWorkshopSkill,workshopIdentity} from '../src/game/skill-workshop.js';
import {raidSkills} from '../src/game/boss-raid-rules.js';
import {NEAR_TESTNET,readNearFox} from '../src/ui/near-testnet-assets.js';
import {objectiveFromNft} from '../src/game/chog-objectives.js';
import {nearWorkshopProgress} from '../src/economy/specializations.js';
import {closeMatchRewards} from './near/match-reward-closure.mjs';
import {roomRewardStatus} from './near/room-reward-status.mjs';
import http from 'node:http';import {randomUUID,randomInt,randomBytes}from 'node:crypto';import{pathToFileURL}from 'node:url';
const WEAPONS=['shooter','twins','spinner','charger','blaster'],NFTS=['varsity','1462','0697','1070','1055'];
export function createHuntRelay({now=Date.now,ttl=60000,economy=null,runner=null,maintenance=false,nearAuth=null,readNft=readNearFox,nearResults=null,nearRoutes=null,nearUsage=null,nearPassport=null,nearFixedRewards=null}={}){
 const rooms=new Map();
 const nearProfile=async(account,id,mode)=>{
  if(!id)return {nftImage:null,canCarry:false,nftTokenId:null,nftContract:null,objectiveNft:null,
   workshopProgress:nearWorkshopProgress(null,nearPassport?.rank(account))};
  if(typeof id!=='string'||!/^\d{3}$/.test(id))throw Error('Choose an owned NEAR Fox NFT.');
  const nft=nearUsage?(await nearUsage.authorize(account,{nft:{collectionId:NEAR_TESTNET.nft,tokenId:id},mode})).identity:await readNft(account,id),objective=objectiveFromNft(nft);
  const key={collectionId:NEAR_TESTNET.nft,tokenId:id};
  return {nftImage:nft.image,canCarry:!!objective,nftTokenId:id,nftContract:nft.contract,objectiveNft:objective,
   workshopProgress:nearWorkshopProgress(key,nearPassport?.rank(account),
    nearPassport?.gameplayCareer?await nearPassport.gameplayCareer(key):nearPassport?.tokenCareer(key))};
 };
 const publicRoom=r=>({code:r.code,phase:r.phase,config:r.config,roster:r.roster?.map(({nearWallet,...actor})=>actor),roundId:r.roundId,go:r.go,closed:r.closed,verified:r.verified,nearAuthoritative:!!r.nearAuthoritative,rewardStatus:roomRewardStatus(nearFixedRewards,r),authority:r.authority,simulation:r.simulation||null,players:[...r.players.values()].map(p=>({id:p.id,name:p.name,host:p.id===r.host,ready:p.ready,loaded:p.loaded,nftImage:p.nftImage,nft:p.nft,weapon:p.weapon})),host:r.host});
 const close=(r,reason)=>{if(r.closed)return;closeMatchRewards(nearFixedRewards,r);r.closed=reason;if(r.roundId)nearUsage?.finishMatch(r.roundId);if(r.verified)economy.ledger.abort(r);runner?.close(r.code);};
 const clean=()=>{for(const [code,r]of rooms){for(const [id,p]of r.players)if(now()-p.seen>(r.phase==='loading'?180000:ttl)){r.players.delete(id);if(id===r.host&&!r.verified)close(r,'Host disconnected');}if((r.verified||r.nearAuthoritative)&&r.phase!=='queued'&&r.simulator&&!r.finished&&now()-r.simulator.seen>(r.phase==='loading'?180000:ttl))close(r,'Match server disconnected');if(!r.players.size)close(r,'Room closed');if(!r.players.size||r.closed&&now()-r.updated>ttl)rooms.delete(code);}};
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Access-Control-Allow-Origin','*');res.setHeader('Access-Control-Allow-Headers','Content-Type,Authorization');res.setHeader('Access-Control-Allow-Methods','POST,OPTIONS');res.setHeader('Cache-Control','no-store');if(req.method==='OPTIONS'){res.writeHead(204);res.end();return;}
  const reply=(status,data)=>{res.writeHead(status,{'Content-Type':'application/json'});res.end(JSON.stringify(data));};
  if(req.url==='/health'&&['GET','HEAD'].includes(req.method)){res.writeHead(200,{'Content-Type':'application/json'});res.end(req.method==='HEAD'?'':JSON.stringify({ok:true,...(runner?.status?.()||{})}));return;}
  if(maintenance&&req.url!=='/rewards/status')return reply(503,{error:'Cloud relay preparing migration. Please use the current game relay.'});
  try{clean();if(nearRoutes&&req.method==='GET'){const routed=await nearRoutes({method:req.method,url:req.url,headers:req.headers});if(routed)return reply(routed.status,routed.data);}if(req.method!=='POST')return reply(405,{error:'POST required'});let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>1200000)throw Error('Payload too large');}const b=JSON.parse(raw||'{}'),action=req.url.slice(1);
   if(nearRoutes&&action.startsWith('near/')){const routed=await nearRoutes({method:req.method,url:req.url,headers:req.headers,body:b});if(routed)return reply(routed.status,routed.data);}
   if(action==='capacity')return reply(200,runner?.status?.()||{maxConcurrent:0,maxQueued:0,active:0,queued:0});
   if(action.startsWith('near-auth/')){if(!nearAuth)throw Error('NEAR sign-in is unavailable');return reply(200,await nearAuth.handle(action.slice(10),b,req.headers.origin));}
   if(action.startsWith('rewards/')){if(!economy)throw Error('Reward service unavailable');return reply(200,await economy.handle(action.slice(8),b,req));}
   let r=rooms.get(String(b.code||'').toUpperCase());
   const profile=async verified=>{if(!verified&&b.identity!=='guest')throw Error('Choose GUEST or sign in with your wallet before joining');const wallet=verified?economy.auth(b.walletSession):null;if(wallet&&r&&[...r.players.values()].some(p=>p.wallet===wallet))throw Error('Wallet already joined this room');return {requestedWorkshop:b.workshopSkill,raidSkill:['trait','rally','second-wind','workshop'].includes(b.raidSkill)?b.raidSkill:'trait',nftImage:typeof b.nftImage==='string'&&b.nftImage.length<2048&&/^https:\/\//.test(b.nftImage)?b.nftImage:null,id:randomUUID(),token:randomUUID(),wallet,...(wallet?await economy.nftProfile(wallet,b.tokenId):{canCarry:false}),name:String(b.name||'Player').replace(/[<>]/g,'').slice(0,24),nft:NFTS.includes(b.nft)?b.nft:'varsity',weapon:WEAPONS.includes(b.weapon)?b.weapon:'shooter',balance:wallet?economy.ledger.account(wallet).balance:Number.isSafeInteger(b.balance)&&b.balance>=0?Math.min(b.balance,1e9):0,ready:false,loaded:false,seen:now()};};
   const roomProfile=async verified=>{
    const p=await profile(verified);
    if(!verified&&b.nearSession){
     if(!nearAuth)throw Error('NEAR sign-in is unavailable');
     const account=nearAuth.account(b.nearSession,req.headers.origin);
     if(r&&[...r.players.values()].some(player=>player.nearWallet===account))throw Error('Wallet already joined this room');
     Object.assign(p,await nearProfile(account,b.tokenId),{nearWallet:account});
    }
    return p;
   };
   if(action==='create'){if(b.verified&&(!economy||!runner))throw Error('Verified matches require the reward service and simulation runner');let code;do{code=Array.from({length:5},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');}while(rooms.has(code));const p=await roomProfile(!!b.verified);p.ready=true;r={code,host:p.id,authority:p.id,verified:!!b.verified,players:new Map([[p.id,p]]),phase:'lobby',config:{mapId:'tidewater',time:'day',difficulty:'normal'},snapshot:null,seq:0,commands:[],updated:now()};rooms.set(code,r);return reply(200,{id:p.id,token:p.token,room:publicRoom(r)});}
   if(!r)throw Error('Room not found');if(r.closed)throw Error(r.closed);
   if(action==='join'){if(r.phase!=='lobby')throw Error('Match already started');if(r.players.size>=6)throw Error('Room is full');const p=await roomProfile(r.verified);if(r.phase!=='lobby'||r.players.size>=6)throw Error('Room is no longer open');if(p.nearWallet&&[...r.players.values()].some(player=>player.nearWallet===p.nearWallet))throw Error('Wallet already joined this room');r.players.set(p.id,p);return reply(200,{id:p.id,token:p.token,room:publicRoom(r)});}
   const token=req.headers.authorization?.replace(/^Bearer /,'');const p=[...r.players.values(),...(r.simulator?[r.simulator]:[])].find(p=>p.token===token);if(!p)return reply(401,{error:'Invalid room session'});p.seen=now();r.updated=now();
   if(action==='leave'){r.players.delete(p.id);if(p.id===r.host&&!r.verified)close(r,'Host left the room');if(r.verified&&p.id===r.host&&r.players.size)r.host=r.players.keys().next().value;if(!r.players.size)close(r,'Room closed');return reply(200,{ok:true});}
   if(action==='settings'){if(p.id!==r.host||r.phase!=='lobby')throw Error('Only host can edit lobby settings');if(typeof b.mapId==='string'&&/^[a-z-]{2,30}$/.test(b.mapId))r.config.mapId=b.mapId;r.config.time=b.time==='dusk'?'dusk':'day';if(['boss','hunt','control','trials'].includes(b.mode))r.config.mode=b.mode;if(r.config.mode==='trials'){r.config.mapId='tidewater';r.config.time='day';r.config.difficulty='normal';}}
   if(action==='ready'){if(r.phase==='lobby')p.ready=!!b.ready;else if(r.phase==='loading')p.loaded=true;else if(r.phase==='queued')throw Error('Waiting for a match slot');}
   if(action==='start'){if(p.id!==r.host||r.phase!=='lobby'||r.starting)throw Error('Only host can start an idle lobby');if([...r.players.values()].some(p=>!p.ready))throw Error('Waiting for players to ready up');r.starting=true;try{if(r.config.mode==='trials'){if(r.players.size!==1)throw Error('Daily Trials is solo');r.config.challenge=dailyChallenge(new Date(now()).toISOString().slice(0,10));r.config.duration=r.config.challenge.duration;}for(const q of r.players.values()){if(q.wallet)Object.assign(q,await economy.nftProfile(q.wallet,q.nftTokenId));else if(q.nearWallet)Object.assign(q,await nearProfile(q.nearWallet,q.nftTokenId,r.config.mode||'hunt'));}for(const q of r.players.values()){const nft={...q.objectiveNft,contract:q.nftContract,tokenId:q.nftTokenId},progress=q.workshopProgress??{identity:workshopIdentity(nft),wins:q.raidWins||0};q.workshopSkill=r.config.mode==='trials'?defaultWorkshopSkill(nft):q.requestedWorkshop?validateWorkshopSkill(q.requestedWorkshop,nft,progress):defaultWorkshopSkill(nft);}
    r.roundId=randomUUID();r.nearAuthoritative=!!(!r.verified&&nearResults&&runner&&[...r.players.values()].every(player=>player.nearWallet));r.roster=[...r.players.values()].map((p,i)=>({nid:i,owner:p.id,wallet:p.wallet,nearWallet:p.nearWallet,canCarry:p.canCarry,nftContract:p.nftContract,nftTokenId:p.nftTokenId,objectiveNft:p.objectiveNft,raidWins:p.raidWins||0,workshopSkill:p.workshopSkill,workshopProgress:p.workshopProgress,raidSkill:p.raidSkill==='workshop'&&p.workshopSkill?'workshop':raidSkills(p.raidWins||0).some(s=>s.id===p.raidSkill)?p.raidSkill:'trait',name:p.name,weapon:p.weapon,style:{chogNft:p.nft},balance:p.balance,level:p.level,bot:false,team:i<3?0:1,slot:i%3}));while(r.roster.length<(r.config.mode==='trials'?1:6)){const i=r.roster.length;r.roster.push({nid:i,owner:r.host,name:['Pip','Nori','Kelp','Fizz','Coral','Moxie'][i],weapon:WEAPONS[i%5],style:{chogNft:NFTS[i%5]},balance:0,canCarry:true,bot:true,team:i<3?0:1,slot:i%3});}
    if(r.config.mode==='trials')for(const q of r.roster){q.team=0;q.slot=0;q.weapon='shooter';q.sub=null;q.special=null;}
    if(r.config.mode==='boss')for(const [i,q]of r.roster.entries()){q.team=0;q.slot=i;}
    if((r.config.mode||'hunt')==='hunt'&&!r.roster.some(q=>q.canCarry))throw Error('At least one player must own a Chog NFT to play as Carrier');
    if(r.verified){if(r.config.mode==='boss')for(const q of r.roster)if(q.wallet)q.raidStakeNonce=await economy.raidPool?.entry(q.wallet,q.nftTokenId)||null;const capacity=runner.status?.();if(capacity&&capacity.active>=capacity.maxConcurrent&&capacity.queued>=capacity.maxQueued)throw Error('Match queue is full. Please try again shortly.');economy.ledger.start(r);}
    if(r.verified||r.nearAuthoritative){r.simulator={id:randomUUID(),token:randomBytes(32).toString('hex'),seen:now(),loaded:false};r.authority=r.simulator.id;}
    r.phase=(r.verified||r.nearAuthoritative)&&runner.status?'queued':'loading';r.go=false;for(const q of r.players.values())q.loaded=false;
    if(r.verified||r.nearAuthoritative)runner.launch(r,publicRoom(r),{onState:state=>{r.simulation=state;if(state.state==='starting'&&!r.closed&&r.phase==='queued'){r.phase='loading';r.simulator.seen=now();r.updated=now();}},onFailure:e=>close(r,'Simulation failed: '+e.message)}).catch(e=>close(r,'Simulation failed: '+e.message));
    }catch(error){if(r.phase==='lobby'&&r.roundId)nearUsage?.finishMatch(r.roundId);throw error;}finally{r.starting=false;}
   }
   if(action==='sync'){
    if(b.input&&r.phase==='playing'&&p.id!==r.authority)p.input={move:Array.isArray(b.input.move)?b.input.move.slice(0,3).map(v=>Number.isFinite(v)?Math.max(-1,Math.min(1,v)):0):[0,0,0],yaw:Number.isFinite(b.input.yaw)?b.input.yaw:0,pitch:Number.isFinite(b.input.pitch)?Math.max(-1.5,Math.min(1.5,b.input.pitch)):0,fire:!!b.input.fire,jump:!!b.input.jump,hold:!!b.input.hold,skill:!!b.input.skill,sub:!!b.input.sub,special:!!b.input.special,squid:!!b.input.squid,at:now()};
    if(p.input){const m=p.input.move,k=Math.max(1,Math.hypot(m[0]||0,m[2]||0));p.input.move=[(m[0]||0)/k,0,(m[2]||0)/k];}
    if(['buy','raid-skill','workshop-skill'].includes(b.command)&&r.phase==='playing'&&!r.commands.some(c=>c.id===p.id))r.commands.push({id:p.id,type:b.command});
    if(b.snapshot&&p.id!==r.authority)throw Error('Only the match authority can publish snapshots');
    if(p.id===r.authority&&b.snapshot&&r.phase==='playing'){if(r.verified){economy.ledger.observe(r,b.snapshot);if(b.snapshot.core?.phase==='finished'){economy.nftXP?.wake();economy.modeRegistry?.wake();}}if(r.nearAuthoritative&&p===r.simulator&&b.snapshot.core?.phase==='finished'&&!r.finished){
 const results = nearResults.record(r,b.snapshot);
 if (nearFixedRewards && r.fixedReservations) {
  for (const result of results) {
   const id = r.fixedReservations.get(result.accountId);
   if (!id || nearFixedRewards.get(id)?.status !== 'started') continue;
   if (result.left) nearFixedRewards.closeIncomplete(id, {matchId:r.roundId,reason:'abandoned'});
   else nearFixedRewards.complete(id, {finishedAt:result.finishedAt,resultHash:result.resultHash})
    .catch(error=>console.error('Fixed result settlement pending',error.message));
  }
 }
}r.snapshot=b.snapshot;r.seq++;if(b.snapshot.core?.phase==='finished'&&!r.finished){r.finished=true;nearUsage?.finishMatch(r.roundId);if(r.verified||r.nearAuthoritative)setTimeout(()=>runner.close(r.code),1500);}}
   }
   if (r.phase === 'loading' && !r.activating && [...r.players.values()].every(player => player.loaded) &&
       (!(r.verified || r.nearAuthoritative) || r.simulator.loaded)) {
    r.activating = true;
    try {
     if (nearUsage) {
      for (const player of r.roster) {
       if (!player.nearWallet || !player.nftTokenId) continue;
       await nearUsage.start(player.nearWallet, {
        nft: { collectionId: player.nftContract, tokenId: player.nftTokenId },
        mode: r.config.mode || 'hunt', matchId: r.roundId,
        loadout: { weapon: player.weapon, raidSkill: player.raidSkill, workshopSkill: player.workshopSkill ?? null, workshopProgress: player.workshopProgress ?? null },
       });
       if (r.closed) throw Error(r.closed);
      }
     }
     if (nearFixedRewards && r.nearAuthoritative && ['boss', 'trials'].includes(r.config.mode)) {
     r.fixedReservations ??= new Map();
     for (const player of r.roster.filter(row => row.nearWallet && !row.bot)) {
      if (!r.fixedReservations.has(player.nearWallet)) {
       const reservation = nearFixedRewards.ready(player.nearWallet, {
        requestId: r.roundId, matchId: r.roundId, taskId: 'complete-' + r.config.mode,
        mode: r.config.mode, readyUntil: now() + 60_000,
       });
       r.fixedReservations.set(player.nearWallet, reservation.id);
      }
     }
     await nearFixedRewards.tick();
     if (r.closed) throw Error(r.closed);
     for (const id of r.fixedReservations.values()) {
      const reservation = nearFixedRewards.get(id);
      if (reservation?.guaranteed && reservation.status === 'reserved') nearFixedRewards.start(id);
     }
    }
    r.phase = 'playing';
     r.go = true;
    } catch (error) {
     nearUsage?.finishMatch(r.roundId);
     close(r, error.message);
     throw error;
    } finally {
     r.activating = false;
    }
   }
   const out={room:publicRoom(r)};
   if(p.id===r.authority){out.inputs=[...r.players.values()].filter(q=>q.id!==r.authority).map(q=>({id:q.id,...(now()-(q.input?.at||0)<500?q.input:{move:[0,0,0],fire:false,jump:false,hold:false})}));out.commands=r.commands.splice(0);out.left=r.roster?.filter(q=>!q.bot&&!r.players.has(q.owner)).map(q=>q.owner)||[];}
   else if(r.snapshot){out.snapshot=r.snapshot;out.seq=r.seq;}
   reply(200,out);
  }catch(e){reply(400,{error:e.shortMessage||e.message});}
 });server.rooms=rooms;server.closeRoom=(code,reason)=>{const r=rooms.get(code);if(r)close(r,reason);};return server;
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){const {RewardService}=await import('./rewards/service.mjs'),{SimulationRunner}=await import('./rewards/runner.mjs');const port=Number(process.env.CHOG_RELAY_PORT||8805),economy=new RewardService(),runner=new SimulationRunner({relayURL:`http://127.0.0.1:${port}`});economy.nftXP.start();economy.modeRegistry.start();const server=createHuntRelay({economy,runner});server.listen(port,'0.0.0.0',()=>console.log(`CHOG room and reward service listening on ${port}; ${runner.maxConcurrent} workers, ${runner.maxQueued} queued rooms`));let stopping=false;const shutdown=async()=>{if(stopping)return;stopping=true;for(const room of server.rooms.values())server.closeRoom(room.code,'Match server restarting');await runner.closeAll();await new Promise(resolve=>server.close(resolve));economy.close();};process.once('SIGINT',()=>shutdown().then(()=>process.exit(0)));process.once('SIGTERM',()=>shutdown().then(()=>process.exit(0)));}
