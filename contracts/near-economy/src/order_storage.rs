//! Prepaid native storage for public buy orders. Separate from all FOXO buckets.
use crate::{Economy,EconomyExt};
use near_sdk::{near,env,require,collections::LookupMap,json_types::U128,AccountId};
const BASE_BYTES:u128=4096;
const PER_ITEM_BYTES:u128=4096;
fn credits()->LookupMap<AccountId,u128>{LookupMap::new(b"orders/v2/native-storage-credit".to_vec())}
pub(crate) fn charge(account:&AccountId,quantity:u32)->bool{
    if !(1..=100).contains(&quantity){return false;}
    let cost=(BASE_BYTES+PER_ITEM_BYTES*u128::from(quantity))*env::storage_byte_cost().as_yoctonear();
    let credit=credits().get(account).unwrap_or(0);
    if credit<cost{return false;}
    credits().insert(account,&(credit-cost));true
}
#[near]
impl Economy {
    pub fn get_order_storage_charge(&self,quantity:u32)->U128{
        require!((1..=100).contains(&quantity),"Invalid order quantity");
        U128((BASE_BYTES+PER_ITEM_BYTES*u128::from(quantity))*env::storage_byte_cost().as_yoctonear())
    }
    pub fn get_order_storage_credit(&self,account_id:AccountId)->U128{U128(credits().get(&account_id).unwrap_or(0))}
    /// Native prepaid storage fee. Unspent credit can fund later orders; no FOXO is accepted here.
    #[payable]
    pub fn deposit_order_storage(&mut self){
        let payer=env::predecessor_account_id();
        let amount=env::attached_deposit().as_yoctonear();
        require!(amount>0,"Storage deposit required");
        let prior=credits().get(&payer);
        // The fixed first-row charge prevents one-yocto account-row storage attacks.
        let row_cost=if prior.is_none(){1024*env::storage_byte_cost().as_yoctonear()}else{0};
        require!(amount>row_cost,"Insufficient storage credit deposit");
        let next=prior.unwrap_or(0).checked_add(amount-row_cost).expect("Storage credit overflow");
        credits().insert(&payer,&next);
    }
    pub fn get_order_storage_registration_charge(&self,account_id:AccountId)->U128{
        U128(if credits().contains_key(&account_id){0}else{1024*env::storage_byte_cost().as_yoctonear()})
    }
}
