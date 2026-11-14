use near_contract_standards::fungible_token::FungibleToken;
use near_contract_standards::storage_management::{StorageBalance, StorageManagement};
use near_sdk::{json_types::U128, near, AccountId, PanicOnDefault, PromiseOrValue};

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct MockFt {
    token: FungibleToken,
}

#[near]
impl MockFt {
    #[init]
    pub fn new(owner_id: AccountId, supply: U128) -> Self {
        let mut token = FungibleToken::new(b"t");
        token.internal_register_account(&owner_id);
        token.internal_deposit(&owner_id, supply.0);
        Self { token }
    }

    #[payable]
    pub fn storage_deposit(&mut self, account_id: Option<AccountId>, registration_only: Option<bool>) -> StorageBalance {
        self.token.storage_deposit(account_id, registration_only)
    }

    // Sandbox-only receiver fixture. This crate is never a deployed game token.
    pub fn mt_on_transfer(&mut self, sender_id: AccountId, previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>, amounts: Vec<U128>, msg: String) -> Vec<U128> {
        let _ = (sender_id, previous_owner_ids, token_ids);
        if msg == "reject" { near_sdk::env::panic_str("Receiver rejected MT transfer"); }
        if msg == "refund" { amounts }
        else if msg == "partial" { amounts.into_iter().map(|amount|U128(amount.0/2)).collect() }
        else { amounts.into_iter().map(|_|U128(0)).collect() }
    }
}

near_contract_standards::impl_fungible_token_core!(MockFt, token);
