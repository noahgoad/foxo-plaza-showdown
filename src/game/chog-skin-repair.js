// Classify the connected sleeves before assigning weights. A spatial cutoff can
// confuse the inner forearm with the torso when their rest surfaces nearly touch.
const smooth=(a,b,x)=>{const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);};
export function repairChogSkin(scene){
 scene.traverse(mesh=>{
  if(!mesh.isSkinnedMesh)return;
  const g=mesh.geometry,p=g.attributes.position,si=g.attributes.skinIndex,sw=g.attributes.skinWeight,index=g.index;
  if(!index||!si||!sw)return;
  const names=mesh.skeleton.bones.map(b=>b.name.replace(/^mixamorig:?/,'')),bone=n=>names.indexOf(n);
  if(['Hips','Spine','Spine1','Spine2','LeftArm','RightArm'].some(n=>bone(n)<0))return;
  const ids=new Int32Array(p.count).fill(-1),nodes=[],weld=new Map();
  for(let i=0;i<p.count;i++){
   const y=p.getY(i);if(y<.64||y>1.015)continue;
   const z=p.getZ(i),key=[p.getX(i),y,z].map(n=>Math.round(n*100000)).join(',');
   let id=weld.get(key);
   if(id===undefined){id=nodes.length;weld.set(key,id);nodes.push({vertices:[],edges:new Set(),weights:new Map(),y,z,fixed:false,arm:0});}
   ids[i]=id;const n=nodes[id];n.vertices.push(i);
   for(let j=0;j<4;j++){const b=si.getComponent(i,j);n.weights.set(b,(n.weights.get(b)||0)+sw.getComponent(i,j));}
  }
  for(let i=0;i<index.count;i+=3)for(let e=0;e<3;e++){
   const a=ids[index.getX(i+e)],b=ids[index.getX(i+(e+1)%3)];
   if(a>=0&&b>=0&&a!==b){nodes[a].edges.add(b);nodes[b].edges.add(a);}
  }
  for(const n of nodes){
   for(const [b,w]of n.weights)n.weights.set(b,w/n.vertices.length);
   n.arm=[...n.weights].reduce((s,[b,w])=>s+(/^(Left|Right)(Shoulder|Arm|ForeArm|Hand)/.test(names[b])?w:0),0);
  }
  // Below the armpit the torso and each sleeve are separate surface components.
  // Lock those labels, including their inner surfaces and welded UV seams.
  const seen=new Set();
  for(let i=0;i<nodes.length;i++){
   if(seen.has(i)||nodes[i].y>.78)continue;
   const queue=[i];seen.add(i);
   for(let q=0;q<queue.length;q++)for(const j of nodes[queue[q]].edges)if(!seen.has(j)&&nodes[j].y<=.78){seen.add(j);queue.push(j);}
   const side=queue.reduce((s,j)=>s+nodes[j].z,0)/queue.length;
   const label=Math.abs(side)>.19?1:Math.abs(side)<.10?0:null;
   if(label!==null)for(const j of queue){nodes[j].arm=label;nodes[j].fixed=true;}
  }
  for(const n of nodes){
   if(Math.abs(n.z)<.08||n.y>.98){n.arm=0;n.fixed=true;}
   else if(Math.abs(n.z)>.23&&n.y<.94){n.arm=1;n.fixed=true;}
  }
  // Blend across the shoulder along the surface, never across the armpit gap.
  for(let pass=0;pass<100;pass++){
   const next=nodes.map(n=>n.fixed||!n.edges.size?n.arm:[...n.edges].reduce((s,j)=>s+nodes[j].arm,0)/n.edges.size);
   nodes.forEach((n,i)=>n.arm=next[i]);
  }
  for(const n of nodes){
   const target=new Map(),add=(b,w)=>{if(b>=0&&w>0)target.set(b,(target.get(b)||0)+w);};
   const side=n.z>0?'Right':'Left',upper=smooth(.75,.83,n.y),hand=1-smooth(.635,.69,n.y);
   add(bone(side+'Arm'),n.arm*upper);add(bone(side+'ForeArm'),n.arm*(1-upper)*(1-hand));add(bone(side+'Hand'),n.arm*(1-upper)*hand);
   // The old nearest-surface transfer also assigned shirt vertices to thighs.
   // Restrict the trunk to its own chain above the waist.
   const trunk=[['Hips',.62],['Spine',.73],['Spine1',.82],['Spine2',.91],['Neck',.995]];
   let k=0;while(k<trunk.length-2&&n.y>trunk[k+1][1])k++;
   const t=smooth(trunk[k][1],trunk[k+1][1],n.y);
   add(bone(trunk[k][0]),(1-n.arm)*(1-t));add(bone(trunk[k+1][0]),(1-n.arm)*t);
   const blend=smooth(.64,.69,n.y)*(1-smooth(.98,1.015,n.y)),weights=new Map();
   for(const [b,w]of n.weights)weights.set(b,w*(1-blend));
   for(const [b,w]of target)weights.set(b,(weights.get(b)||0)+w*blend);
   const ranked=[...weights].filter(([,w])=>w>1e-7).sort((a,b)=>b[1]-a[1]).slice(0,4),total=ranked.reduce((s,[,w])=>s+w,0);
   if(!total)continue;
   for(const i of n.vertices)for(let j=0;j<4;j++){si.setComponent(i,j,ranked[j]?.[0]||0);sw.setComponent(i,j,(ranked[j]?.[1]||0)/total);}
  }
  si.needsUpdate=true;sw.needsUpdate=true;
 });
}
