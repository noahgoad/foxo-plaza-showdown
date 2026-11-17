import {h} from './ui-util.js';
import {nearRelayUrl} from './near-testnet-assets.js';
import {huntCaptureHighlight} from '../game/foxo-event-schema.js';
import {foxoProductEvent} from '../game/foxo-product-telemetry.js';

export async function shareHuntReplay(matchId, nearSession) {
 const response=await fetch(nearRelayUrl()+'/near/replay/share',{
  method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({matchId,nearSession}),signal:AbortSignal.timeout(10000),
 });
 const result=await response.json();
 if(!response.ok||!/^[-\w]{24}$/.test(result.key))throw Error('Match replay is unavailable.');
 const link=new URL(location.href);
 link.search='';
 link.hash='hunt-replay='+result.key;
 return link.href;
}

export async function openSharedHuntReplay(hash) {
 const key=/^#hunt-replay=([-\w]{24})$/.exec(hash)?.[1];
 if(!key)return;
 const response=await fetch(nearRelayUrl()+'/near/replay/'+key,{signal:AbortSignal.timeout(10000)});
 const {frames,events=[],schemaVersion}=await response.json();
 if(!response.ok||schemaVersion!==1||!Array.isArray(frames)||frames.length<2)throw Error('Match replay is unavailable.');
 const ids=new Set(frames.flatMap(frame=>frame.positions.map(actor=>actor.id)));
 foxoProductEvent('share_opened',{mode:'hunt'});
 openHuntReplay({frames,events,highlight:huntCaptureHighlight(events),source:'Match server',players:[...ids].map((id,index)=>({id,name:'Fox '+(index+1)}))});
}

export function openHuntReplay({frames,events,players,highlight,source='Local replay'}){
 const dialog=h('dialog',{class:'foxo-replay-dialog','aria-label':'Trait Hunt replay'});
 const canvas=h('canvas',{width:640,height:360,'aria-label':'Overhead view of players'});
 const cursor=h('input',{type:'range',min:0,max:frames.length-1,value:0,'aria-label':'Replay position'});
 const status=h('p',{role:'status'});
 const pause=h('button',{type:'button'},'PAUSE');
 const save=h('button',{type:'button'},'SAVE FRAME');
 const clip=h('button',{type:'button'},'SAVE CLIP');
 const exportStatus=h('p',{role:'status'});
 const close=h('button',{type:'button'},'CLOSE');
 const ctx=canvas.getContext('2d');
 if(!ctx)return;
 const bounds=frames.reduce((rect,{positions})=>{
  for(const {x,z} of positions){
   rect.minX=Math.min(rect.minX,x);rect.maxX=Math.max(rect.maxX,x);
   rect.minZ=Math.min(rect.minZ,z);rect.maxZ=Math.max(rect.maxZ,z);
  }
  return rect;
 },{minX:0,maxX:1,minZ:0,maxZ:1});
 const scale=Math.min(540/(bounds.maxX-bounds.minX),280/(bounds.maxZ-bounds.minZ));
 const names=new Map(players.map(({id,name})=>[id,name]));
 const marker=highlight?.tick??0;
 let index=Math.max(0,frames.findIndex(frame=>frame.tick>=marker-4000));
 let timer;
 let stopExport;
 function render(){
  const frame=frames[index];
  cursor.value=index;
  ctx.fillStyle='#181324';ctx.fillRect(0,0,640,360);
  for(const {id,x,z,active} of frame.positions){
   if(!active)continue;
   const px=50+(x-bounds.minX)*scale,py=40+(z-bounds.minZ)*scale;
   ctx.fillStyle=id===frame.carrier?'#ffae28':'#a787ff';
   ctx.beginPath();ctx.arc(px,py,7,0,Math.PI*2);ctx.fill();
   ctx.fillStyle='#fff';ctx.font='13px sans-serif';
   ctx.fillText(names.get(id)||'Player',px+10,py+4);
  }
  const lastCapture=events.findLast(event=>event.type==='carrier_changed'&&event.tick<=frame.tick);
  status.textContent=`${(frame.tick/1000).toFixed(1)}s · Carrier: ${names.get(frame.carrier)||'Player'}${lastCapture&&!lastCapture.payload.disconnect?` · Inherited ${lastCapture.payload.traitCount} traits`:''}`;
 }
 function stop(){clearInterval(timer);timer=undefined;pause.textContent='PLAY';}
 function play(){
  if(index===frames.length-1)index=0;
  pause.textContent='PAUSE';
  timer=setInterval(()=>{if(index+1>=frames.length){stop();return;}index++;render();},200);
 }
 pause.onclick=()=>timer===undefined?play():stop();
 close.onclick=()=>dialog.close();
 save.onclick=()=>{
  stop();
  const image=document.createElement('canvas');
  image.width=640;
  image.height=416;
  const drawing=image.getContext('2d');
  if(!drawing)return;
  drawing.drawImage(canvas,0,0);
  drawing.fillStyle='#181324';
  drawing.fillRect(0,360,640,56);
  drawing.fillStyle='#fff';
  drawing.font='16px sans-serif';
  drawing.fillText('FOXO · Trait Hunt · '+source,16,382,608);
  drawing.font='13px sans-serif';
  drawing.fillText(status.textContent,16,402,608);
  image.toBlob(blob=>{
   if(!blob||!dialog.open)return;
   const url=URL.createObjectURL(blob);
   h('a',{href:url,download:'foxo-trait-hunt.png'}).click();
   setTimeout(()=>URL.revokeObjectURL(url),10000);
  },'image/png');
 };
 clip.hidden=typeof MediaRecorder!=='function'||typeof canvas.captureStream!=='function';
 clip.onclick=()=>{
  stop();
  if(frames.length<2)return;
  const start=Math.max(0,frames.findIndex(frame=>frame.tick>=marker-4000));
  const end=Math.min(frames.length-1,start+50);
  const stream=canvas.captureStream(5);
  let recorder;
  try{recorder=new MediaRecorder(stream);}
  catch{
   for(const track of stream.getTracks())track.stop();
   exportStatus.textContent='Clip export is unavailable in this browser. Save a frame instead.';
   return;
  }
  const chunks=[];
  clip.disabled=true;
  cursor.disabled=true;
  pause.disabled=true;
  exportStatus.textContent='Recording local replay clip…';
  let exportTimer;
  stopExport=()=>{
   clearInterval(exportTimer);
   if(recorder.state!=='inactive')recorder.stop();
  };
  recorder.ondataavailable=event=>{if(event.data.size)chunks.push(event.data);};
  recorder.onstop=()=>{
   for(const track of stream.getTracks())track.stop();
   clip.disabled=false;
   cursor.disabled=false;
   pause.disabled=false;
   stopExport=undefined;
   if(!dialog.open)return;
   if(!chunks.length){
    exportStatus.textContent='No clip was recorded. Save a frame instead.';
    return;
   }
   const type=recorder.mimeType||chunks[0].type;
   const url=URL.createObjectURL(new Blob(chunks,{type}));
   const extension=type.startsWith('video/mp4')?'mp4':'webm';
   h('a',{href:url,download:'foxo-local-trait-hunt.'+extension}).click();
   setTimeout(()=>URL.revokeObjectURL(url),10000);
   exportStatus.textContent='Local replay clip ready.';
  };
  recorder.onerror=()=>stopExport?.();
  try{recorder.start();}
  catch{
   for(const track of stream.getTracks())track.stop();
   stopExport=undefined;
   clip.disabled=false;
   cursor.disabled=false;
   pause.disabled=false;
   exportStatus.textContent='Clip export failed. Save a frame instead.';
   return;
  }
  index=start;
  render();
  exportTimer=setInterval(()=>{
   if(index>=end){stopExport?.();return;}
   index++;
   render();
  },200);
 };
 cursor.oninput=()=>{stop();index=Number(cursor.value);render();};
 dialog.addEventListener('close',()=>{stop();stopExport?.();dialog.remove();},{once:true});
 dialog.append(h('h2',null,'TRAIT HUNT REPLAY'),canvas,status,cursor,h('div',null,pause,save,clip,close),exportStatus);
 document.body.append(dialog);
 dialog.showModal();
 render();
 play();
 return dialog;
}
