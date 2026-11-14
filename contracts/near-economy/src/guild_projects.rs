//! Atomic guild fee acceptance + canonical material burn. Independent prefixed state.
use crate::{Economy,EconomyExt,inventory::Materials,multi_token,events,settlement::valid_identifier};
use near_sdk::{near,env,require,collections::LookupMap,json_types::U128,AccountId};
pub const FEE:u128=15*10u128.pow(24);
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct GuildCommitReceipt {pub guild_contract_id:AccountId,pub project_id:String,pub terms_hash:String,pub fee_atomic:U128,pub inputs:Materials}
#[near(serializers=[borsh])]
struct GuildPolicy {enabled:bool,storage_credit:u128}
fn policies()->LookupMap<AccountId,GuildPolicy>{LookupMap::new(b"guild/v1/policy".to_vec())}
fn receipts()->LookupMap<(AccountId,String),GuildCommitReceipt>{LookupMap::new(b"guild/v1/receipt".to_vec())}
#[near]
impl Economy {
 /// Owner explicitly verifies deployed guild code before allowlisting. Default is absent/disabled.
 #[payable] pub fn configure_guild_contract(&mut self,guild_contract_id:AccountId,enabled:bool){require!(env::predecessor_account_id()==self.owner_id,"Only owner");let before=env::storage_usage();let prior=policies().get(&guild_contract_id).map(|x|x.storage_credit).unwrap_or(0);policies().insert(&guild_contract_id,&GuildPolicy{enabled,storage_credit:prior});let cost=u128::from(env::storage_usage()-before)*env::storage_byte_cost().as_yoctonear();let credit=prior.checked_add(env::attached_deposit().as_yoctonear()).expect("Storage overflow");require!(credit>=cost,"Guild storage deposit required");policies().insert(&guild_contract_id,&GuildPolicy{enabled,storage_credit:credit-cost});}
 pub fn get_guild_commit_receipt(&self,guild_contract_id:AccountId,project_id:String)->Option<GuildCommitReceipt>{receipts().get(&(guild_contract_id,project_id))}
}
impl Economy {
 pub(crate) fn receive_guild_commit(&mut self,sender:AccountId,project_id:String,terms_hash:String,amount:U128)->U128 {
  let Some(mut policy)=policies().get(&sender)else{return amount;};
  if !policy.enabled||amount.0!=FEE||!valid_identifier(&project_id,64)||terms_hash.len()!=64||!terms_hash.bytes().all(|b|b.is_ascii_hexdigit()){return amount;}
  // A duplicate transfer is returned in full; the existing immutable receipt remains proof of the first fee.
  if receipts().contains_key(&(sender.clone(),project_id.clone())){return amount;}
  let inputs=Materials{alloy:48,core:2,catalyst:2};
  let mut inventory=self.get_inventory(sender.clone());multi_token::assert_inventory_included(&sender,inventory.available,inventory.reserved);
  if !multi_token::legacy_writes_allowed()||!inventory.consume(inputs){return amount;}
  let Some(revenue)=self.ledger.crafting_fees.checked_add(amount.0)else{return amount;};
  let before=env::storage_usage();
  receipts().insert(&(sender.clone(),project_id.clone()),&GuildCommitReceipt{guild_contract_id:sender.clone(),project_id:project_id.clone(),terms_hash:terms_hash.clone(),fee_atomic:amount,inputs});
  self.inventories.insert(&sender,&inventory);multi_token::record_material_change(&sender,inputs,false);
  let cost=u128::from(env::storage_usage().saturating_sub(before))*env::storage_byte_cost().as_yoctonear();require!(policy.storage_credit>=cost,"Insufficient guild receipt storage");policy.storage_credit-=cost;policies().insert(&sender,&policy);self.ledger.crafting_fees=revenue;
  events::emit("guild_commit",near_sdk::serde_json::json!({"guildContractId":sender,"projectId":project_id,"termsHash":terms_hash,"feeAtomic":amount,"amountAtomic":amount,"accountId":sender,"inputs":inputs}));
  U128(0)
 }
}
