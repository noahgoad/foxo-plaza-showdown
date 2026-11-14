import {prepareChogWeapons} from './chog-weapon-models.js';
import { clone } from 'three/addons/utils/SkeletonUtils.js';
import { SuppliedChog, prepareSuppliedChog } from './supplied-chog.js';
import {CHOG_NFT_IDS,CHOG_CHARACTER_IDS,normalizedChogId} from './chog-roster-ids.js';
export {CHOG_NFT_IDS,CHOG_CHARACTER_IDS,CHOG_MAIN_WEAPONS,normalizedChogId} from './chog-roster-ids.js';

// Load once before any actor/showcase is constructed. Geometry/textures are shared;
// SkeletonUtils gives each actor independent bones, bind state and finger poses.
export async function prepareGameChogs({localNft=()=>null}={}){
 await prepareChogWeapons();
 const url=new URL('../../assets/near-fox/fox-garment.glb',import.meta.url).href;
 const source=await prepareSuppliedChog({modelUrl:url,fox:true});
 let previewIndex=0;
 return class GameChog extends SuppliedChog {
  static nftIds=CHOG_NFT_IDS;
  constructor(opts={}){
   const id=normalizedChogId(opts.nftId||opts.style?.chogNft)||(opts.isLocal?normalizedChogId(localNft())||'varsity':CHOG_CHARACTER_IDS[opts.slot!==undefined?((opts.team||0)*2+opts.slot)%CHOG_CHARACTER_IDS.length:(previewIndex++%CHOG_CHARACTER_IDS.length)]);
   super(opts,{model:clone(source.model),reference:clone(source.reference),fox:true});
   this.nftId=id;this.root.name='chog-nft-'+id;this.setChogWeapon(true);
  }
  dispose(){for(const m of this.imported)m.skeleton.dispose();super.dispose();}
 };
}
