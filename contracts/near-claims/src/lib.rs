use near_sdk::{
    assert_one_yocto,
    collections::{LookupMap, LookupSet, Vector},
    env, ext_contract,
    json_types::U128,
    near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
};

const NFT: &str = "fox.xuancanh1.testnet";
const FOXO: &str = "foxo.xuancanh1.testnet";
const OWNER: &str = "xuancanh1.testnet";
const VAULT: &str = "claim.xuancanh1.testnet";
const DAILY_AMOUNT: u128 = 10 * 10u128.pow(24);
const FAUCET_CAP: u128 = 5_000 * 10u128.pow(24);
const DAY_NS: u64 = 86_400_000_000_000;
const PENDING: u64 = u64::MAX;

#[ext_contract(ext_assets)]
trait Assets {
    fn nft_transfer(&mut self, receiver_id: AccountId, token_id: String);
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128);
}

#[ext_contract(ext_self)]
trait Callbacks {
    fn finish_nft_claim(&mut self, receiver: AccountId, token_id: String) -> bool;
    fn finish_foxo_claim(&mut self, receiver: AccountId, previous: Option<u64>) -> bool;
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Claims {
    inventory: Vector<String>,
    admitted: LookupSet<String>,
    nft_claimed: LookupSet<AccountId>,
    nft_pending: LookupSet<AccountId>,
    faucet_balance: u128,
    faucet_funded: u128,
    faucet_claims: LookupMap<AccountId, u64>,
}

#[near]
impl Claims {
    #[init]
    pub fn new() -> Self {
        require!(
            env::predecessor_account_id().as_str() == OWNER
                && env::current_account_id().as_str() == VAULT,
            "Only the Testnet operator can initialize this vault"
        );
        Self {
            inventory: Vector::new(b"i"),
            admitted: LookupSet::new(b"a"),
            nft_claimed: LookupSet::new(b"c"),
            nft_pending: LookupSet::new(b"p"),
            faucet_balance: 0,
            faucet_funded: 0,
            faucet_claims: LookupMap::new(b"f"),
        }
    }

    pub fn nft_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_id: AccountId,
        token_id: String,
        msg: String,
    ) -> bool {
        require!(
            env::predecessor_account_id().as_str() == NFT,
            "Wrong NFT contract"
        );
        if sender_id.as_str() != OWNER
            || previous_owner_id.as_str() != OWNER
            || msg != "claim"
            || !inventory_id(&token_id)
            || !self.admitted.insert(&token_id)
        {
            return true;
        }
        self.inventory.push(&token_id);
        false
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id().as_str() == FOXO,
            "Wrong token contract"
        );
        if sender_id.as_str() != OWNER || msg != "faucet" {
            return amount;
        }
        let accepted = amount.0.min(FAUCET_CAP - self.faucet_funded);
        self.faucet_balance += accepted;
        self.faucet_funded += accepted;
        U128(amount.0 - accepted)
    }

    pub fn nft_available(&self) -> u64 {
        self.inventory.len()
    }

    pub fn nft_claim_status(&self, account_id: AccountId) -> &'static str {
        if self.nft_claimed.contains(&account_id) {
            "claimed"
        } else if self.nft_pending.contains(&account_id) {
            "pending"
        } else {
            "eligible"
        }
    }

    pub fn faucet_available(&self) -> U128 {
        U128(self.faucet_balance)
    }

    pub fn faucet_funded(&self) -> U128 {
        U128(self.faucet_funded)
    }

    pub fn faucet_next_claim_ms(&self, account_id: AccountId) -> Option<u64> {
        self.faucet_claims
            .get(&account_id)
            .and_then(|value| (value != PENDING).then(|| value.saturating_add(DAY_NS) / 1_000_000))
    }

    pub fn faucet_claim_pending(&self, account_id: AccountId) -> bool {
        self.faucet_claims.get(&account_id) == Some(PENDING)
    }

    #[payable]
    pub fn claim_nft(&mut self) -> Promise {
        assert_one_yocto();
        let receiver = env::predecessor_account_id();
        require!(
            self.nft_claim_status(receiver.clone()) == "eligible",
            "NFT already claimed or pending"
        );
        let token_id = self.inventory.pop().expect("No NFTs available");
        self.nft_pending.insert(&receiver);
        ext_assets::ext(NFT.parse().unwrap())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .nft_transfer(receiver.clone(), token_id.clone())
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .finish_nft_claim(receiver, token_id),
            )
    }

    #[payable]
    pub fn claim_foxo(&mut self) -> Promise {
        assert_one_yocto();
        let receiver = env::predecessor_account_id();
        let previous = self.faucet_claims.get(&receiver);
        require!(
            previous.is_none_or(
                |last| last != PENDING && env::block_timestamp() >= last.saturating_add(DAY_NS)
            ),
            "FOXO claim pending or on cooldown"
        );
        require!(
            self.faucet_balance >= DAILY_AMOUNT,
            "Faucet needs FOXO funding"
        );
        self.faucet_balance -= DAILY_AMOUNT;
        self.faucet_claims.insert(&receiver, &PENDING);
        ext_assets::ext(FOXO.parse().unwrap())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(receiver.clone(), U128(DAILY_AMOUNT))
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .finish_foxo_claim(receiver, previous),
            )
    }

    #[private]
    pub fn finish_nft_claim(&mut self, receiver: AccountId, token_id: String) -> bool {
        require!(self.nft_pending.remove(&receiver), "Claim is not pending");
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if success {
            self.nft_claimed.insert(&receiver);
        } else {
            self.inventory.push(&token_id);
        }
        success
    }

    #[private]
    pub fn finish_foxo_claim(&mut self, receiver: AccountId, previous: Option<u64>) -> bool {
        require!(
            self.faucet_claims.get(&receiver) == Some(PENDING),
            "Claim is not pending"
        );
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if success {
            self.faucet_claims
                .insert(&receiver, &env::block_timestamp());
        } else {
            self.faucet_balance += DAILY_AMOUNT;
            if let Some(last) = previous {
                self.faucet_claims.insert(&receiver, &last);
            } else {
                self.faucet_claims.remove(&receiver);
            }
        }
        success
    }
}

fn inventory_id(token_id: &str) -> bool {
    let id = token_id.parse::<u8>().unwrap_or_default();
    (45..=88).contains(&id) && token_id == format!("{id:03}")
}
