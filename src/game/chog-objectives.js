import {GENESIS_ART} from './chog-objective-catalog.js';

const categories=['Head','Eyes','Body','Accessory'];
const absent=new Set(['','none','no','n/a','null']);
const itemIcons=new Map([['Head:MCGA','mcga-cap'],['Eyes:BTC Glass','btc-glasses'],['Body:Yellow 143 Jersey','yellow-143-jersey'],['Accessory:Fwog','fwog']]);
const cachedPortraits=new Set(['697','1070','1055']);
const imageGateway='https://ipfs.filebase.io/ipfs/';
export function nearFoxGameplayTraits(attributes){
 const categories={Headwear:'Head',Outfit:'Body',Eyewear:'Eyes',Expression:'Eyes',Accessory:'Accessory',Background:'Accessory'};
 return ['Headwear','Eyewear','Expression','Outfit','Accessory','Background'].reduce((traits,key)=>{
  const entry=attributes.find(a=>a.trait_type===key&&!absent.has(a.value.trim().toLowerCase()));
  if(entry&&!traits.some(a=>a.trait_type===categories[key]))traits.push({...entry,trait_type:categories[key]});
  return traits;
 },[]);
}
export function objectiveFromNft(nft){
 if(!Array.isArray(nft?.attributes))return null;
 const original=nft.attributes.filter(a=>typeof a.trait_type==='string'&&typeof a.value==='string'&&!absent.has(a.value.trim().toLowerCase()));
 const available=nft.contract==='fox.xuancanh1.testnet'?nearFoxGameplayTraits(original):original;
 let selected=categories.map(category=>available.find(a=>a.trait_type===category)).filter(Boolean);
 // The ten Genesis without wearable groups still have real identity traits.
 if(!selected.length)selected=['Skin','Mouth','Aura','Form','Base','Tier'].map(category=>available.find(a=>a.trait_type===category)).filter(Boolean).slice(0,4);
 if(!selected.length)return null;
 const sourceId=String(nft.sourceId||nft.name?.match(/#(\d+)/)?.[1]||'');
 const portrait=cachedPortraits.has(sourceId)?sourceId:null;
 const image=typeof nft.image==='string'?nft.image.replace('ipfs://',imageGateway):null;
 if(!image||!/^https:\/\//.test(image))return null;
 return {tokenId:nft.tokenId??null,sourceId:nft.sourceId??null,name:nft.name||'FOX',image,traits:selected.map(a=>{
  const category=a.trait_type,value=a.value,key=category+':'+value,legacy=itemIcons.get(key);
  return {id:category.toLowerCase()+':'+encodeURIComponent(value),category,value,name:value,image,portrait,icon:legacy||null};
 })};
}
export function objectiveForModel(model){
 if(!/^\d{1,4}$/.test(String(model)))return null;
 const sourceId=String(Number(model)),source=GENESIS_ART[sourceId];
 return source?objectiveFromNft({...source,sourceId}):null;
}
export function objectiveForToken(tokenId,version=2){
 if(!/^[1-9]\d{0,3}$/.test(String(tokenId))||Number(tokenId)>1969)return null;
 // Replica v2 preserves the original tokenURI shuffle; token 1 is artwork 1462.
 const sourceId=version===2?String(((Number(tokenId)-1+1461)%1969)+1):'1462';
 return objectiveFromNft({...GENESIS_ART[sourceId],sourceId,tokenId:String(tokenId)});
}
