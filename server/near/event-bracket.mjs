import {createPracticeCup,cupTime,recordCupRound,CUP_ROUNDS} from '../../src/game/foxo-event-rules.js';
import {validateObjectiveResult} from '../../src/game/objective-rules.js';

const LIMIT=8;
const ENTRY_WINDOW=15*60_000;
const PLAY_WINDOW=45*60_000;

export function createCupBrackets({now=Date.now,database}={}){
 const events=new Map();
 database?.exec('CREATE TABLE IF NOT EXISTS foxo_cup_editions (day TEXT PRIMARY KEY, state TEXT NOT NULL)');
 const save=database?.prepare('INSERT INTO foxo_cup_editions VALUES (?, ?) ON CONFLICT(day) DO UPDATE SET state=excluded.state');
 const remove=database?.prepare('DELETE FROM foxo_cup_editions WHERE day = ?');
 for(const row of database?.prepare('SELECT day,state FROM foxo_cup_editions').all()??[]){
  const event=JSON.parse(row.state);
  if(now()>event.finishAt+2*86400_000){remove.run(row.day);continue;}
  event.entries=new Map(event.entries);
  for(const entry of event.entries.values())entry.active=null;
  events.set(row.day,event);
 }
 const persist=(day,event)=>save?.run(day,JSON.stringify({...event,entries:[...event.entries]}));
 const stamp=()=>new Date(now()).toISOString().slice(0,10);
 function status(day=stamp()){
  const event=events.get(day);
  if(!event)return {day,phase:'registration',entries:[],capacity:LIMIT};
  const closed=now()>=event.finishAt;
  const rows=[...event.entries.values()].map(entry=>({name:entry.name,seed:entry.seed,
   roundCount:entry.cup.results.length,totalMs:cupTime(entry.cup),
   bestMs:Math.min(...entry.cup.results.filter(round=>round.elapsedMs!==null).map(round=>round.elapsedMs)),
   finishedAt:entry.finishedAt??null}));
  rows.sort((left,right)=>(left.totalMs??Infinity)-(right.totalMs??Infinity)||
   left.bestMs-right.bestMs||(left.finishedAt??Infinity)-(right.finishedAt??Infinity)||left.seed-right.seed);
  const finished=rows.filter(row=>row.roundCount===CUP_ROUNDS).length;
  const canRegister=now()<event.joinUntil&&event.entries.size<LIMIT;
  return {day,phase:closed||(!canRegister&&finished===event.entries.size)?'finished':
   canRegister?'registration':'running',capacity:LIMIT,
   entries:rows.map(({bestMs,finishedAt,...row},index)=>({...row,position:row.totalMs===null?null:index+1,
    dnf:row.totalMs===null&&(closed||row.roundCount===CUP_ROUNDS)}))};
 }
 function reserve(account,name,matchId,requestedDay){
  for(const [day,event] of events)if(now()>event.finishAt+2*86400_000){events.delete(day);remove?.run(day);}
  const day=requestedDay||stamp();
  let event=events.get(day);
  if(!event){
   if(day!==stamp())throw Error('Plaza Cup registration is closed for this day.');
   event={joinUntil:now()+ENTRY_WINDOW,finishAt:now()+PLAY_WINDOW,entries:new Map()};events.set(day,event);
  }
  if(now()>=event.finishAt)throw Error('Plaza Cup has ended.');
  let entry=event.entries.get(account);
  if(!entry){
   if(day!==stamp()||now()>=event.joinUntil||event.entries.size>=LIMIT)throw Error('Plaza Cup registration is closed.');
   entry={name,seed:event.entries.size+1,cup:createPracticeCup(day),active:null};event.entries.set(account,entry);
  }
  if(entry.active||entry.cup.results.length>=CUP_ROUNDS)throw Error('Finish the current round before starting another.');
  entry.active=matchId;
  persist(day,event);
  return {day,challenge:entry.cup.challenge,round:entry.cup.results.length+1};
 }
 function closeRound({day,account,matchId,result=null}){
  const event=events.get(day),entry=event?.entries.get(account);
  if(!entry||entry.active!==matchId)return false;
  if(result){
   validateObjectiveResult(result,{mode:'trials',challenge:entry.cup.challenge});
   if(result.roundId!==matchId)throw Error('Plaza Cup round mismatch.');
  }
  entry.active=null;
  const recorded=recordCupRound(entry.cup,result||{mode:'trials',version:entry.cup.challenge.version,
   challenge:entry.cup.challenge,roundId:matchId,time:0,completed:false});
  if(entry.cup.results.length===CUP_ROUNDS)entry.finishedAt=now();
  persist(day,event);
  return recorded;
 }
 return {status,reserve,closeRound};
}
