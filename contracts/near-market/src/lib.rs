//! Approval-based single NFT sales. FOXO and NFT receipts settle in stages.
use near_sdk::{
    collections::LookupMap,
    env, ext_contract,
    json_types::{U128, U64},
    near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseOrValue,
    PromiseResult,
};
const STORAGE_CHARGE: u128 = 50_000_000_000_000_000_000_000;
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Listing {
    pub seller_id: AccountId,
    pub token_id: String,
    pub approval_id: u64,
    pub price_atomic: U128,
    pub expires_at_ns: U64,
    pub career_revision: U64,
    pub status: String,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Purchase {
    pub buyer_id: AccountId,
    pub listing: Listing,
    pub status: String,
}
#[near(serializers=[borsh])]
#[derive(Default)]
struct Credit {
    amount: u128,
    pending: u128,
    attempt: u64,
}
#[near(serializers=[json])]
#[serde(deny_unknown_fields)]
struct Terms {
    price_atomic: U128,
    expires_at_ns: U64,
    career_revision: U64,
}
#[near(serializers=[json])]
#[serde(deny_unknown_fields)]
struct Payment {
    purchase_id: String,
}
#[near(serializers=[json])]
pub struct AccountState {
    credit: U128,
    withdraw_pending: U128,
}
#[near(serializers=[json])]
pub struct Ledger {
    principal: U128,
    credits: U128,
    fees: U128,
    withdraw_pending: U128,
}
#[near(serializers=[json])]
struct Career {
    revision: u64,
}
#[allow(dead_code)]
#[ext_contract(passport)]
trait Passport {
    fn get_career(&self, collection_id: AccountId, token_id: String) -> Career;
}
#[allow(dead_code)]
#[ext_contract(nft)]
trait Nft {
    fn nft_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        approval_id: Option<u64>,
        memo: Option<String>,
    );
}
#[allow(dead_code)]
#[ext_contract(ft)]
trait Ft {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[allow(dead_code)]
#[ext_contract(callback)]
trait Callback {
    fn resolve_career(&mut self, purchase_id: String) -> PromiseOrValue<bool>;
    fn resolve_purchase(&mut self, purchase_id: String);
    fn resolve_withdraw(&mut self, account_id: AccountId, attempt: u64);
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    owner_id: AccountId,
    foxo_contract_id: AccountId,
    nft_contract_id: AccountId,
    passport_contract_id: AccountId,
    enabled: bool,
    listings: LookupMap<String, Listing>,
    slots: LookupMap<String, bool>,
    purchases: LookupMap<String, Purchase>,
    credits: LookupMap<AccountId, Credit>,
    principal: u128,
    credits_total: u128,
    fees: u128,
    withdraw_pending: u128,
}
#[near]
impl Contract {
    #[init]
    pub fn new(
        owner_id: AccountId,
        foxo_contract_id: AccountId,
        nft_contract_id: AccountId,
        passport_contract_id: AccountId,
    ) -> Self {
        let caller = env::predecessor_account_id();
        let contract = env::current_account_id();
        let parent = contract.as_str().split_once('.').map(|(_, parent)| parent);
        require!(
            caller == contract
                || (caller == owner_id
                    && env::signer_account_id() == owner_id
                    && parent == Some(owner_id.as_str())),
            "Only this account or its parent operator can initialize"
        );
        Self {
            owner_id,
            foxo_contract_id,
            nft_contract_id,
            passport_contract_id,
            enabled: false,
            listings: LookupMap::new(b"l"),
            slots: LookupMap::new(b"s"),
            purchases: LookupMap::new(b"p"),
            credits: LookupMap::new(b"c"),
            principal: 0,
            credits_total: 0,
            fees: 0,
            withdraw_pending: 0,
        }
    }
    pub fn set_enabled(&mut self, enabled: bool) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        self.enabled = enabled;
    }
    pub fn get_enabled(&self) -> bool {
        self.enabled
    }
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
         "ownerId": self.owner_id, "foxoContractId": self.foxo_contract_id,
         "collectionId": self.nft_contract_id, "passportContractId": self.passport_contract_id,
         "enabled": self.enabled
        })
    }
    pub fn get_storage_charge(&self) -> U128 {
        U128(STORAGE_CHARGE)
    }
    #[payable]
    pub fn fund_account(&mut self) {
        Self::charge();
        let a = env::predecessor_account_id();
        require!(self.credits.get(&a).is_none(), "Already funded");
        self.credits.insert(&a, &Credit::default());
    }
    #[payable]
    pub fn fund_listing(&mut self, token_id: String) {
        Self::token(&token_id);
        Self::charge();
        let key = Self::slot(&env::predecessor_account_id(), &token_id);
        require!(self.slots.get(&key).is_none(), "Already funded");
        self.slots.insert(&key, &true);
    }
    /// Called only by the immutable collection after its real nft_approve.
    pub fn nft_on_approve(
        &mut self,
        token_id: String,
        owner_id: AccountId,
        approval_id: u64,
        msg: String,
    ) {
        require!(
            env::predecessor_account_id() == self.nft_contract_id,
            "Only configured collection"
        );
        Self::token(&token_id);
        require!(
            self.slots.get(&Self::slot(&owner_id, &token_id)) == Some(true),
            "Fund listing storage first"
        );
        require!(self.credits.get(&owner_id).is_some(), "Fund account first");
        let terms: Terms = near_sdk::serde_json::from_str(&msg)
            .expect("Single NFT terms required; bundles unsupported");
        require!(
            terms.price_atomic.0 > 0 && terms.price_atomic.0 <= u128::MAX / 10_000,
            "Invalid price"
        );
        require!(terms.expires_at_ns.0 > env::block_timestamp(), "Expired");
        if let Some(old) = self.listings.get(&token_id) {
            require!(old.status != "pending", "Purchase pending");
            require!(old.approval_id < approval_id, "Stale approval");
        }
        self.listings.insert(
            &token_id,
            &Listing {
                seller_id: owner_id,
                token_id: token_id.clone(),
                approval_id,
                price_atomic: terms.price_atomic,
                expires_at_ns: terms.expires_at_ns,
                career_revision: terms.career_revision,
                status: "open".into(),
            },
        );
    }
    #[payable]
    pub fn prepare_purchase(
        &mut self,
        purchase_id: String,
        token_id: String,
        approval_id: u64,
        price_atomic: U128,
        career_revision: U64,
    ) {
        Self::id(&purchase_id);
        Self::charge();
        require!(
            self.purchases.get(&purchase_id).is_none(),
            "Purchase ID used"
        );
        let buyer_id = env::predecessor_account_id();
        require!(self.credits.get(&buyer_id).is_some(), "Fund account first");
        let listing = self.listings.get(&token_id).expect("Unknown listing");
        require!(
            listing.status == "open"
                && listing.approval_id == approval_id
                && listing.price_atomic == price_atomic
                && listing.career_revision == career_revision
                && listing.expires_at_ns.0 > env::block_timestamp(),
            "Stale terms"
        );
        require!(listing.seller_id != buyer_id, "Self trade blocked");
        self.purchases.insert(
            &purchase_id,
            &Purchase {
                buyer_id,
                listing,
                status: "prepared".into(),
            },
        );
    }
    pub fn cancel_purchase(&mut self, purchase_id: String) {
        let mut purchase = self.purchases.get(&purchase_id).expect("Unknown purchase");
        require!(
            purchase.buyer_id == env::predecessor_account_id(),
            "Only buyer"
        );
        require!(
            purchase.status == "prepared",
            "Purchase already funded or cancelled"
        );
        purchase.status = "cancelled".into();
        self.purchases.insert(&purchase_id, &purchase);
    }
    pub fn cancel_listing(&mut self, token_id: String) {
        let mut l = self.listings.get(&token_id).expect("Unknown listing");
        require!(env::predecessor_account_id() == l.seller_id, "Only seller");
        require!(l.status == "open", "Not open");
        l.status = "cancelled".into();
        self.listings.insert(&token_id, &l);
    }
    /// Retain payment while NFT delivery is pending. Failures become withdrawable buyer credits.
    pub fn ft_on_transfer(
        &mut self,
        sender_id: AccountId,
        amount: U128,
        msg: String,
    ) -> PromiseOrValue<U128> {
        require!(
            env::predecessor_account_id() == self.foxo_contract_id,
            "Only configured FOXO"
        );
        let Ok(message) = near_sdk::serde_json::from_str::<Payment>(&msg) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(mut p) = self.purchases.get(&message.purchase_id) else {
            return PromiseOrValue::Value(amount);
        };
        let Some(mut l) = self.listings.get(&p.listing.token_id) else {
            return PromiseOrValue::Value(amount);
        };
        if !self.enabled
            || p.status != "prepared"
            || p.buyer_id != sender_id
            || p.listing.approval_id != l.approval_id
            || p.listing.seller_id != l.seller_id
            || amount != l.price_atomic
            || l.status != "open"
            || l.expires_at_ns.0 <= env::block_timestamp()
        {
            return PromiseOrValue::Value(amount);
        }
        require!(
            env::prepaid_gas().as_tgas() >= 150,
            "At least 150 Tgas receiver gas required"
        );
        p.status = "pending".into();
        l.status = "pending".into();
        self.purchases.insert(&message.purchase_id, &p);
        self.listings.insert(&l.token_id, &l);
        self.principal = self
            .principal
            .checked_add(amount.0)
            .expect("Principal overflow");
        passport::ext(self.passport_contract_id.clone())
            .with_static_gas(Gas::from_tgas(15))
            .get_career(self.nft_contract_id.clone(), l.token_id)
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(100))
                    .resolve_career(message.purchase_id),
            );
        PromiseOrValue::Value(U128(0))
    }
    #[private]
    pub fn resolve_career(&mut self, purchase_id: String) -> PromiseOrValue<bool> {
        require!(env::promise_results_count() == 1, "One receipt required");
        let p = self.purchases.get(&purchase_id).expect("Unknown purchase");
        require!(p.status == "pending", "Purchase not pending");
        let career = match env::promise_result(0) {
            PromiseResult::Successful(data) => {
                near_sdk::serde_json::from_slice::<Career>(&data).ok()
            }
            _ => None,
        };
        if !career.is_some_and(|c| c.revision == p.listing.career_revision.0) {
            self.fail_purchase(&purchase_id);
            return PromiseOrValue::Value(false);
        }
        PromiseOrValue::Promise(
            nft::ext(self.nft_contract_id.clone())
                .with_attached_deposit(NearToken::from_yoctonear(1))
                .with_static_gas(Gas::from_tgas(35))
                .nft_transfer(
                    p.buyer_id,
                    p.listing.token_id,
                    Some(p.listing.approval_id),
                    Some("FOXO fixed sale".into()),
                )
                .then(
                    callback::ext(env::current_account_id())
                        .with_static_gas(Gas::from_tgas(30))
                        .resolve_purchase(purchase_id),
                ),
        )
    }
    #[private]
    pub fn resolve_purchase(&mut self, purchase_id: String) {
        require!(env::promise_results_count() == 1, "One receipt required");
        let mut p = self.purchases.get(&purchase_id).expect("Unknown purchase");
        require!(p.status == "pending", "Purchase not pending");
        let mut l = self
            .listings
            .get(&p.listing.token_id)
            .expect("Missing listing");
        require!(
            l.status == "pending" && l.approval_id == p.listing.approval_id,
            "Listing receipt mismatch"
        );
        let delivered = matches!(env::promise_result(0), PromiseResult::Successful(_));
        let gross = p.listing.price_atomic.0;
        self.principal = self
            .principal
            .checked_sub(gross)
            .expect("Principal mismatch");
        if delivered {
            let fee = gross * 250 / 10_000;
            self.add_credit(&l.seller_id, gross - fee);
            self.fees = self.fees.checked_add(fee).expect("Fee overflow");
            p.status = "delivered".into();
            l.status = "sold".into();
        } else {
            self.add_credit(&p.buyer_id, gross);
            p.status = "refundable".into();
            l.status = "failed".into();
        }
        self.purchases.insert(&purchase_id, &p);
        self.listings.insert(&l.token_id, &l);
    }
    #[payable]
    pub fn withdraw_credit(&mut self) -> Promise {
        near_sdk::assert_one_yocto();
        let account_id = env::predecessor_account_id();
        let mut c = self.credits.get(&account_id).expect("Not funded");
        require!(c.pending == 0 && c.amount > 0, "No available credit");
        let amount = c.amount;
        c.amount = 0;
        c.pending = amount;
        c.attempt = c.attempt.checked_add(1).expect("Attempt overflow");
        self.credits_total -= amount;
        self.withdraw_pending += amount;
        self.credits.insert(&account_id, &c);
        ft::ext(self.foxo_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(
                account_id.clone(),
                U128(amount),
                Some("Market credit".into()),
            )
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .resolve_withdraw(account_id, c.attempt),
            )
    }
    #[private]
    pub fn resolve_withdraw(&mut self, account_id: AccountId, attempt: u64) {
        require!(env::promise_results_count() == 1, "One receipt required");
        let mut c = self.credits.get(&account_id).expect("Unknown account");
        require!(c.pending > 0 && c.attempt == attempt, "Unknown withdrawal");
        let amount = c.pending;
        c.pending = 0;
        self.withdraw_pending -= amount;
        if !matches!(env::promise_result(0), PromiseResult::Successful(_)) {
            c.amount = c.amount.checked_add(amount).expect("Credit overflow");
            self.credits_total += amount;
        }
        self.credits.insert(&account_id, &c);
    }
    pub fn get_account_state(&self, account_id: AccountId) -> Option<AccountState> {
        self.credits.get(&account_id).map(|c| AccountState {
            credit: U128(c.amount),
            withdraw_pending: U128(c.pending),
        })
    }
    pub fn get_listing_slot(&self, account_id: AccountId, token_id: String) -> bool {
        self.slots
            .get(&Self::slot(&account_id, &token_id))
            .unwrap_or(false)
    }
    pub fn get_listing(&self, token_id: String) -> Option<Listing> {
        self.listings.get(&token_id)
    }
    pub fn get_purchase(&self, purchase_id: String) -> Option<Purchase> {
        self.purchases.get(&purchase_id)
    }
    pub fn get_credit(&self, account_id: AccountId) -> U128 {
        U128(self.credits.get(&account_id).map(|c| c.amount).unwrap_or(0))
    }
    pub fn get_ledger(&self) -> Ledger {
        Ledger {
            principal: U128(self.principal),
            credits: U128(self.credits_total),
            fees: U128(self.fees),
            withdraw_pending: U128(self.withdraw_pending),
        }
    }
}
impl Contract {
    fn fail_purchase(&mut self, id: &String) {
        let mut p = self.purchases.get(id).expect("Unknown purchase");
        require!(p.status == "pending", "Not pending");
        let mut l = self
            .listings
            .get(&p.listing.token_id)
            .expect("Missing listing");
        self.principal -= p.listing.price_atomic.0;
        self.add_credit(&p.buyer_id, p.listing.price_atomic.0);
        p.status = "refundable".into();
        l.status = "failed".into();
        self.purchases.insert(id, &p);
        self.listings.insert(&l.token_id, &l);
    }
    fn charge() {
        require!(
            env::attached_deposit().as_yoctonear() >= STORAGE_CHARGE,
            "Native storage deposit required"
        );
        let refund = env::attached_deposit().as_yoctonear() - STORAGE_CHARGE;
        if refund > 0 {
            Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(refund));
        }
    }
    fn token(id: &str) {
        require!(!id.is_empty() && id.len() <= 64, "Invalid token ID");
    }
    fn id(id: &str) {
        require!(
            !id.is_empty()
                && id.len() <= 64
                && id
                    .bytes()
                    .all(|x| x.is_ascii_alphanumeric() || x == b'-' || x == b'_'),
            "Invalid purchase ID"
        );
    }
    fn slot(a: &AccountId, t: &str) -> String {
        format!("{a}:{t}")
    }
    fn add_credit(&mut self, a: &AccountId, amount: u128) {
        let mut c = self.credits.get(a).expect("Funded account missing");
        c.amount = c.amount.checked_add(amount).expect("Credit overflow");
        self.credits_total = self
            .credits_total
            .checked_add(amount)
            .expect("Credits overflow");
        self.credits.insert(a, &c);
    }
}
