export const HUNT_EVENT_SCHEMA = 1;
export const HUNT_RULES_VERSION = 'foxo-hunt-v1';

export function huntReplayEvent(event, core, seq) {
 const base = {schemaVersion:HUNT_EVENT_SCHEMA,rulesVersion:HUNT_RULES_VERSION,matchId:core.roundId,seq,tick:Math.floor(core.elapsed*1000)};
 if(event.type==='play')return {...base,type:'match_started',actorSessionId:event.id,payload:{traitCount:0}};
 if(event.type==='capture')return {...base,type:'carrier_changed',actorSessionId:event.id,payload:{
  previousCarrier:event.old,carrier:event.id,traitCount:event.found.length,disconnect:!!event.disconnect
 }};
 if(event.type==='loot'&&event.traitMatched)return {...base,type:'trait_collected',actorSessionId:event.id,payload:{traitId:event.traitId,traitCount:event.traitCount}};
 if(event.type==='end')return {...base,type:'match_finished',actorSessionId:event.winner,payload:{reason:event.reason,traitCount:core.found.size}};
 return null;
}

export function huntCaptureHighlight(events) {
 return events.findLast(event=>event.type==='carrier_changed'&&!event.payload.disconnect&&event.payload.traitCount>=2)
  ??events.findLast(event=>event.type==='carrier_changed'&&!event.payload.disconnect)
  ??events.findLast(event=>event.type==='match_finished'&&event.payload.reason==='traits')
  ??null;
}
