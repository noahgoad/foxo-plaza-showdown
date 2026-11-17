import {dailyChallenge} from './objective-rules.js';

export const CUP_ROUNDS=3;
export const DECOY_LIFE_MS=6000;
export const DECOY_RECHARGE_MS=22000;

export function placeHuntDecoy({now,readyAt=0,active,hunter,position}){
 if(!active||!hunter||!Number.isFinite(now)||now<readyAt||
    ![position?.x,position?.y,position?.z].every(Number.isFinite))return null;
 const {x,y,z}=position;
 return {position:{x,y,z},endsAt:now+DECOY_LIFE_MS,readyAt:now+DECOY_RECHARGE_MS};
}
export function createPracticeCup(day=new Date().toISOString().slice(0,10)){
 return {challenge:dailyChallenge(day),results:[]};
}

export function recordCupRound(cup,result){
 if(cup.results.length>=CUP_ROUNDS||result.mode!=='trials'||result.challenge?.id!==cup.challenge.id||
    result.version!==cup.challenge.version||!result.roundId||!Number.isFinite(result.time)||
    result.time<0||result.time>cup.challenge.duration||cup.results.some(round=>round.id===result.roundId))return false;
 cup.results.push({id:result.roundId,elapsedMs:result.completed?Math.round((cup.challenge.duration-result.time)*1000):null});
 return true;
}

export function cupTime(cup){
 if(cup.results.length!==CUP_ROUNDS||cup.results.some(round=>round.elapsedMs===null))return null;
 return cup.results.reduce((sum,round)=>sum+round.elapsedMs,0);
}
