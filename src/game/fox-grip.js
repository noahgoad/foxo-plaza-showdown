import * as THREE from 'three';

const vec=()=>new THREE.Vector3();
const at=b=>b.getWorldPosition(vec());
const frame=(f,u)=>new THREE.Quaternion().setFromRotationMatrix(
 new THREE.Matrix4().makeBasis(u.clone().cross(f).normalize(),u,f)
);

// Local weapon-space contacts, elbow clearance and palm rolls are independent
// for each weapon. Paired pistols use a trigger grip on each hand.
export const FOX_WEAPON_POSES={
 shooter:{support:[0,-.035,.195],reach:.115,drop:.105,spread:-.025,palm:[0,.77,-.64],supportPalm:[0,1,0],curl:[1.10,1.12,.70]},
 twins:{support:null,reach:.210,drop:.145,spread:.060,palm:[0,1,-.25],supportPalm:null,curl:[.95,1.05,.65]},
 spinner:{support:[0,.205,.095],reach:.145,drop:.160,spread:-.015,palm:[0,.90,-.35],supportPalm:[1,0,0],curl:[.85,1.0,.60]},
 charger:{support:[.025,.015,.155],reach:.115,drop:.105,spread:-.025,palm:[0,1,-.20],supportPalm:[-1,0,0],supportCurl:[.40,.55,.30],curl:[.78,.90,.55]},
 blaster:{support:[.025,.035,.100],reach:.150,drop:.130,spread:-.010,palm:[0,.8,-.6],supportPalm:[-1,0,0],supportCurl:[.50,.65,.35],curl:[1.05,1.15,.70]}
};

// This Mixamo export already has weighted finger joints. Derive each palm and
// its local coordinate frame from those joints instead of using CHOG offsets.
export class FoxGrip {
 constructor(c){
  this.c=c;
  this.hands={};
  for(const side of ['Left','Right']){
   const names=c.nativeBones,bone=names[side+'Hand'];
   const joint=(finger,i)=>names[side+'Hand'+finger+i];
   const middle=at(joint('Middle',1)),wrist=at(bone);
   const forward=middle.clone().sub(wrist).normalize();
   const across=at(joint('Index',1)).sub(at(joint('Pinky',1)));
   across.addScaledVector(forward,-across.dot(forward)).normalize();
   const normal=across.clone().cross(forward).normalize();
   const thumb=at(joint('Thumb',2)).sub(wrist);
   if(normal.dot(thumb)<0)normal.negate();
   this.hands[side]={bone,palm:bone.worldToLocal(wrist.clone().lerp(middle,.68)),
    basis:frame(forward,across).invert().multiply(bone.getWorldQuaternion(new THREE.Quaternion())),
    grip:0,fingers:['Index','Middle','Ring','Pinky','Thumb'].map(finger=>[1,2,3].map(i=>{
     const b=joint(finger,i),dir=at(joint(finger,i+1)).sub(at(b)).normalize();
     const curl=dir.cross(normal).normalize().applyQuaternion(b.getWorldQuaternion(new THREE.Quaternion()).invert());
     return {b,curl,rest:b.quaternion.clone()};
    }))};
  }
 }
 orientHand(side,gun,forearm){
  const h=this.hands[side];
  const support=side==='Left'&&!this.c.weapon.left&&gun===this.c.weapon;
  const gunQ=gun.off.getWorldQuaternion(new THREE.Quaternion());
  const pose=FOX_WEAPON_POSES[this.c.weaponKind];
  const direction=new THREE.Vector3(0,0,1).applyQuaternion(gunQ);
  const armDirection=forearm||h.bone.getWorldPosition(vec())
   .sub(this.c.nativeBones[side+'ForeArm'].getWorldPosition(vec())).normalize();
  const turn=new THREE.Quaternion().setFromUnitVectors(armDirection,direction);
  const angle=armDirection.angleTo(direction);
  if(angle>.78)direction.copy(armDirection).applyQuaternion(
   new THREE.Quaternion().slerp(turn,.78/angle));
  const across=new THREE.Vector3(...(support?pose.supportPalm:pose.palm));
  across.applyQuaternion(gunQ).addScaledVector(direction,-across.dot(direction));
  if(across.lengthSq()<.001){
   across.set(0,0,1).applyQuaternion(gunQ);
   across.addScaledVector(direction,-across.dot(direction));
  }
  const q=frame(direction,across.normalize()).multiply(h.basis);
  h.bone.quaternion.copy(h.bone.parent.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(q));
  h.bone.updateWorldMatrix(false,true);
 }
 palmLength(side){const h=this.hands[side];return h.bone.getWorldPosition(vec()).distanceTo(this.palmWorld(side));}
 palmWorld(side){const h=this.hands[side];return h.bone.localToWorld(h.palm.clone());}
 update(dt){
  for(const [side,h] of Object.entries(this.hands)){
   const active=this.c.chogWeaponEnabled&&(side==='Right'||this.c.weapon?.left||this.c.wTwo>.2);
   h.grip+=(Number(!!active)-h.grip)*(1-Math.exp(-dt*20));
   h.fingers.forEach((joints,f)=>joints.forEach(({b,curl,rest},i)=>{
    const pose=FOX_WEAPON_POSES[this.c.weaponKind];
    const trigger=side==='Right'||!!this.c.weapon?.left;
    const fingerCurl=trigger?pose.curl:pose.supportCurl||pose.curl;
    const angles=f===4?[.55,.75,.45]:f===0&&trigger?[.50,.65,.40]:fingerCurl;
    b.quaternion.copy(rest).multiply(new THREE.Quaternion().setFromAxisAngle(curl,angles[i]*h.grip));
   }));
  }
 }
}

