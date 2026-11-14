import { accountId, atomic } from './schema.js';
export const GUILD_TOKENS=Object.freeze(['alloy','core','catalyst']);
export const GUILD_TARGETS=Object.freeze(['48','2','2']);
export const GUILD_FEE='15000000000000000000000000';
export function guildIdentifier(value){if(typeof value!=='string'||! /^[a-zA-Z0-9_-]{1,64}$/.test(value))throw new Error('Invalid guild/project operation ID.');return value;}
export function guildTermsJSON({contract,projectId,project}){
 accountId(contract);guildIdentifier(projectId);guildIdentifier(project.guild_id);accountId(project.fee_payer);
 if(typeof project.deadline!=='string'||! /^[1-9]\d{0,19}$/.test(project.deadline)||BigInt(project.deadline)>18446744073709551615n)throw new Error('Exact project deadline is unavailable.');
 if(project.sku!=='guild-banner-beacon-v2')throw new Error('Unsupported guild output.');
 // serde_json::Value objects use lexicographic keys. Deadline remains a JSON u64 number in the hash, even though the view transports it as a decimal string.
 return '{"contract":'+JSON.stringify(contract)+',"deadline":'+project.deadline+',"fee_atomic":"'+GUILD_FEE+'","fee_payer":'+JSON.stringify(project.fee_payer)+',"guild_id":'+JSON.stringify(project.guild_id)+',"project_id":'+JSON.stringify(projectId)+',"refund_policy":"uncommitted-only","sku":"guild-banner-beacon-v2","targets":["48","2","2"],"token_ids":["alloy","core","catalyst"],"transferable":false}';
}
export async function guildTermsHash(options){const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(guildTermsJSON(options)));return Array.from(new Uint8Array(bytes),b=>b.toString(16).padStart(2,'0')).join('');}
export function contributionDraft({guild,economy,account,projectId,project,operationId,amounts}){
 accountId(account);guildIdentifier(projectId);guildIdentifier(operationId);
 if(!/^[a-f0-9]{64}$/.test(project.terms_hash)||!Array.isArray(amounts)||amounts.length!==3)throw new Error('Invalid contribution terms.');
 const token_ids=[],values=[];
 amounts.forEach((value,i)=>{const amount=atomic(value);if(amount>BigInt(GUILD_TARGETS[i])-atomic(project.totals[i]))throw new Error('Contribution exceeds remaining target.');if(amount){token_ids.push(GUILD_TOKENS[i]);values.push(value);}});
 if(!values.length)throw new Error('Enter at least one material amount.');
 return {kind:'contribute',account,guild:accountId(guild),projectId,operationId,termsHash:project.terms_hash,receiverId:accountId(economy),method:'mt_batch_transfer_call',deposit:'1',args:{receiver_id:guild,token_ids,amounts:values,approvals:null,memo:null,msg:JSON.stringify({project_id:projectId,terms_hash:project.terms_hash,operation_id:operationId})}};
}
export function contributionMatches(row,draft){return row?.project_id===draft.projectId&&row.contributor===draft.account&&JSON.stringify(row.token_ids)===JSON.stringify(draft.args.token_ids)&&JSON.stringify(row.amounts)===JSON.stringify(draft.args.amounts);}
export function guildGate(action,{guild:g,project:p,member,account},now=Date.now()){
 const manager=g?.active&&member&&(g.leader===account||g.treasurer===account),open=p?.status==='open',expired=p&&BigInt(p.deadline)<=BigInt(now)*1000000n;
 if(['join','leave','open_project','contribute','fund_fee','commit','approve_manager_change'].includes(action)&&!g?.active)throw new Error('Guild is inactive.');
 if(['contribute','commit','open_project','leave'].includes(action)&&!member)throw new Error('Active member required.');
 if(['open_project','commit','cancel'].includes(action)&&!manager)throw new Error('Guild leader or treasurer required.');
 if(['contribute','fund_fee','commit'].includes(action)&&(!open||expired))throw new Error('Project closed or expired.');
 if(action==='commit'&&!GUILD_TARGETS.every((v,i)=>p.totals[i]===v))throw new Error('Project must be fully funded.');
 if(action==='commit'&&p.fee_state!=='held')throw new Error('15 FOXO fee required.');
 if(action==='fund_fee'&&(p.fee_payer!==account||p.fee_state!=='unfunded'))throw new Error('Only the designated fee payer can fund this fee once.');
 if(action==='cancel'&&!open)throw new Error('Project is closed.');
 if(action==='expire'&&(!open||!expired))throw new Error('Project is not expired.');
 if(action==='reconcile_commit'&&p?.status!=='committing')throw new Error('No commit to reconcile.');
 if(['refund','refund_fee'].includes(action)&&!['cancelled','expired'].includes(p?.status))throw new Error('Only uncommitted cancelled or expired projects can refund.');
 if(action==='refund_fee'&&p.fee_state!=='held')throw new Error('Fee refund is pending, delivered or unavailable.');
 if(action==='leave'&&[g.leader,g.treasurer].includes(account))throw new Error('Change manager through governor approvals before leaving.');
 if(action==='disband'&&(!g?.active||g.leader!==account))throw new Error('Only the active leader can disband.');
 if(action==='approve_manager_change'&&(!member||!g.governors.includes(account)))throw new Error('Active governor required.');
}
export async function readGuildSnapshot({deployment,economy,token,account,guildId,projectId,readCode,view}){
 if(!deployment.accountId||!deployment.codeHash||!economy.accountId||!economy.codeHash)throw new Error('Guild deployment is awaiting verification.');
 const code=await readCode(deployment.accountId);
 if(code.codeHash!==deployment.codeHash)throw new Error('Guild or economy code hash mismatch.');
 const read=async(contract,method,args={})=>{const row=await view(contract,method,args,{blockId:code.blockHash});if(row.blockHash!==code.blockHash)throw new Error('Guild snapshot changed.');return row.value;};
 // Verify economy code at the SAME finalized block as the guild snapshot.
 const accountCode=await readCode(economy.accountId,{blockId:code.blockHash});
 if(!(economy.acceptedCodeHashes ?? [economy.codeHash]).includes(accountCode.codeHash)||accountCode.blockHash!==code.blockHash)throw new Error('Economy finalized code snapshot mismatch.');
 const [config,ec,mt]=await Promise.all([read(deployment.accountId,'get_config'),read(economy.accountId,'get_config'),read(economy.accountId,'get_mt_migration')]);
 if(config.economy_mt!==economy.accountId||config.foxo_contract_id!==token||ec.foxoContractId!==token||ec.network!=='near-testnet'||!mt?.finalized)throw new Error('Guild configuration or material migration mismatch.');
 const result={read,account,guild:null,project:null,member:false};
 if(guildId){guildIdentifier(guildId);[result.guild,result.member]=await Promise.all([read(deployment.accountId,'guild',{guild_id:guildId}),read(deployment.accountId,'member',{guild_id:guildId,account_id:account})]);}
 if(projectId){guildIdentifier(projectId);result.project=await read(deployment.accountId,'project',{project_id:projectId});if(result.project&&(result.project.guild_id!==guildId||await guildTermsHash({contract:deployment.accountId,projectId,project:result.project})!==result.project.terms_hash))throw new Error('Project terms hash does not match the reviewed specification.');}
 return result;
}




