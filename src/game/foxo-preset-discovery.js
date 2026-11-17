import {defaultWorkshopSkill,resolveWorkshopSkill} from './skill-workshop.js';

const presets=[
 ['field-medic','FIELD MEDIC','mend','self','steady'],
 ['rapid-recovery','RAPID RECOVERY','mend','self','quick'],
 ['rescue-circle','RESCUE CIRCLE','mend','nearby','steady'],
 ['focused-aid','FOCUSED AID','mend','self','focused'],
 ['breach-window','BREACH WINDOW','empower','self','quick'],
 ['hold-the-line','HOLD THE LINE','ward','self','lasting'],
];

export function workshopPresets(nft,progress){
 return presets.map(([id,name,effect,target,modifier])=>{
  const recipe={...defaultWorkshopSkill(nft),effect,target,modifier};
  try{return {id,name,recipe,skill:resolveWorkshopSkill(recipe,nft,progress)};}
  catch{return {id,name,recipe,skill:null};}
 });
}

export function describeWorkshopSkill(skill){
 const strength=skill.effect==='mend'?`${skill.amount} HP`:`${Math.round(skill.amount*100)}%`;
 const range=skill.target==='self'?'Self':`${skill.radius}m squad`;
 return `${skill.name} · ${strength} · ${range}${skill.duration?` · ${skill.duration}s duration`:''} · ${skill.cooldown}s cooldown`;
}
