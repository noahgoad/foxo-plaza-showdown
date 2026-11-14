use near_sdk::{
    assert_one_yocto, collections::LookupMap, env, ext_contract, json_types::U128, near, require,
    AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
};
use uint::construct_uint;
construct_uint! { pub struct U256(4); }

const UNIT: u128 = 10u128.pow(24);
const BUDGET: u128 = 1_500 * UNIT;
const TARGET: u128 = 100_000 * UNIT;
const DURATION_MS: u64 = 604_800_000;
const DAY_MS: u64 = 86_400_000;
const SCALE: u128 = 10u128.pow(36);

fn mul_div(a: u128, b: u128, denominator: u128) -> u128 {
    (U256::from(a) * U256::from(b) / U256::from(denominator)).as_u128()
}

#[near(serializers = [borsh])]
#[derive(Default, Clone)]
struct Position {
    principal: u128,
    reward: u128,
    index: u128,
    registered: bool,
}

#[near(serializers = [borsh])]
struct Payout {
    account_id: AccountId,
    amount: u128,
    reward: bool,
}

#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum TransferAction {
    Stake,
    FundReward,
}

#[ext_contract(ext_ft)]
#[allow(dead_code)]
trait FungibleToken {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[ext_contract(ext_self)]
#[allow(dead_code)]
trait Callback {
    fn finish_payout(&mut self, payout_id: u64) -> bool;
}

#[near(serializers = [json])]
pub struct PoolView {
    pub principal: U128,
    pub principal_in_flight: U128,
    pub reward_available: U128,
    pub reward_reserved: U128,
    pub reward_in_flight: U128,
    pub reward_paid: U128,
    pub opened_at_ms: Option<u64>,
    pub starts_at_ms: Option<u64>,
    pub ends_at_ms: Option<u64>,
}

#[near(serializers = [json])]
pub struct PositionView {
    pub principal: U128,
    pub accrued_reward: U128,
    pub registered: bool,
}

// One explicitly funded pilot campaign per deployment. All token custody remains
// in this contract. There is no operator withdrawal of principal or reward funds.
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Pool {
    owner_id: AccountId,
    token_id: AccountId,
    receipt_signer_id: AccountId,
    positions: LookupMap<AccountId, Position>,
    eligible: LookupMap<AccountId, u64>,
    boss_receipts: LookupMap<String, (AccountId, u64)>,
    payouts: LookupMap<u64, Payout>,
    next_payout: u64,
    opened_at_ms: Option<u64>,
    starts_at_ms: Option<u64>,
    last_ms: u64,
    index: u128,
    principal: u128,
    principal_in_flight: u128,
    reward_available: u128,
    reward_reserved: u128,
    reward_in_flight: u128,
    reward_paid: u128,
}

#[near]
impl Pool {
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({
            "ownerId": self.owner_id,
            "tokenId": self.token_id,
            "receiptSignerId": self.receipt_signer_id,
            "rewardBudgetAtomic": BUDGET.to_string(),
            "targetStakeAtomic": TARGET.to_string(),
            "durationMs": DURATION_MS
        })
    }
    #[init]
    pub fn new(owner_id: AccountId, token_id: AccountId, receipt_signer_id: AccountId) -> Self {
        let contract = env::current_account_id();
        let caller = env::predecessor_account_id();
        require!(
            caller == contract
                || (caller == owner_id
                    && env::signer_account_id() == owner_id
                    && contract
                        .as_str()
                        .split_once('.')
                        .is_some_and(|(_, parent)| parent == owner_id.as_str())),
            "Unauthorized initialization"
        );
        Self {
            owner_id,
            token_id,
            receipt_signer_id,
            positions: LookupMap::new(b"p"),
            eligible: LookupMap::new(b"e"),
            boss_receipts: LookupMap::new(b"b"),
            payouts: LookupMap::new(b"t"),
            next_payout: 0,
            opened_at_ms: None,
            starts_at_ms: None,
            last_ms: 0,
            index: 0,
            principal: 0,
            principal_in_flight: 0,
            reward_available: 0,
            reward_reserved: 0,
            reward_in_flight: 0,
            reward_paid: 0,
        }
    }

    pub fn set_receipt_signer(&mut self, signer_id: AccountId) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        self.receipt_signer_id = signer_id;
    }

    // Internal server receipt sink. The configured signer must verify Boss
    // completion, actor, match and rules before submitting this record.
    pub fn record_boss_clear(
        &mut self,
        account_id: AccountId,
        match_id: String,
        finished_at_ms: u64,
    ) -> bool {
        require!(
            env::predecessor_account_id() == self.receipt_signer_id,
            "Only receipt signer"
        );
        require!(
            !match_id.is_empty() && match_id.len() <= 128,
            "Invalid match"
        );
        require!(
            finished_at_ms <= env::block_timestamp_ms(),
            "Future receipt"
        );
        let receipt_key = format!("{}:{}", account_id, match_id);
        if let Some(prior) = self.boss_receipts.get(&receipt_key) {
            require!(
                prior == (account_id, finished_at_ms),
                "Conflicting Boss receipt"
            );
            return false;
        }
        require!(
            self.starts_at_ms.is_none_or(|start| env::block_timestamp_ms() < start + DURATION_MS),
            "Campaign ended"
        );
        let previous = self.eligible.get(&account_id).unwrap_or(0);
        self.eligible
            .insert(&account_id, &previous.max(finished_at_ms));
        self.boss_receipts
            .insert(&receipt_key, &(account_id, finished_at_ms));
        true
    }

    pub fn get_boss_clear(&self, account_id: AccountId, match_id: String) -> Option<u64> {
        self.boss_receipts
            .get(&format!("{}:{}", account_id, match_id))
            .map(|(_, finished_at_ms)| finished_at_ms)
    }

    pub fn open_campaign(&mut self, starts_at_ms: u64) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
        require!(self.opened_at_ms.is_none(), "Campaign already opened");
        require!(
            self.reward_available == BUDGET,
            "Campaign must be fully funded"
        );
        let now = env::block_timestamp_ms();
        require!(
            starts_at_ms > now && starts_at_ms <= now.checked_add(DAY_MS).expect("Time overflow"),
            "Invalid start"
        );
        starts_at_ms
            .checked_add(DURATION_MS)
            .expect("Time overflow");
        self.opened_at_ms = Some(now);
        self.starts_at_ms = Some(starts_at_ms);
        self.last_ms = starts_at_ms;
    }

    pub fn register(&mut self) {
        self.opened_at_ms.expect("Campaign not open");
        let now = env::block_timestamp_ms();
        require!(
            now < self.starts_at_ms.unwrap() + DURATION_MS,
            "Registration closed"
        );
        let account = env::predecessor_account_id();
        let finished = self.eligible.get(&account).expect("Boss clear required");
        require!(
            finished <= now && now - finished <= DAY_MS,
            "Boss clear outside eligibility window"
        );
        let mut position = self.positions.get(&account).unwrap_or_default();
        position.registered = true;
        self.positions.insert(&account, &position);
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.token_id,
            "Only configured token"
        );
        require!(amount.0 > 0, "Zero transfer");
        let action: TransferAction =
            near_sdk::serde_json::from_str(&msg).expect("Invalid transfer action");
        match action {
            TransferAction::FundReward => {
                require!(
                    sender_id == self.owner_id && self.opened_at_ms.is_none(),
                    "Reward funding closed"
                );
                let accepted = amount.0.min(BUDGET - self.reward_available);
                self.reward_available += accepted;
                U128(amount.0 - accepted)
            }
            TransferAction::Stake => {
                let start = self.starts_at_ms.expect("Campaign not open");
                require!(
                    env::block_timestamp_ms() < start + DURATION_MS,
                    "Campaign ended"
                );
                self.checkpoint();
                let mut position = self.settle(&sender_id);
                require!(position.registered, "Register before campaign start");
                self.principal = self
                    .principal
                    .checked_add(amount.0)
                    .expect("Principal overflow");
                position.principal = position
                    .principal
                    .checked_add(amount.0)
                    .expect("Position overflow");
                self.positions.insert(&sender_id, &position);
                U128(0)
            }
        }
    }

    #[payable]
    pub fn withdraw(&mut self, amount: U128) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= Gas::from_tgas(65), "Need 65 Tgas");
        self.checkpoint();
        let account = env::predecessor_account_id();
        let mut position = self.settle(&account);
        require!(
            amount.0 > 0 && amount.0 <= position.principal,
            "Invalid withdrawal"
        );
        position.principal -= amount.0;
        self.principal -= amount.0;
        self.principal_in_flight += amount.0;
        self.positions.insert(&account, &position);
        self.transfer(account, amount.0, false)
    }

    #[payable]
    pub fn claim(&mut self) -> Promise {
        assert_one_yocto();
        require!(env::prepaid_gas() >= Gas::from_tgas(65), "Need 65 Tgas");
        self.checkpoint();
        let account = env::predecessor_account_id();
        let mut position = self.settle(&account);
        let amount = position.reward;
        require!(
            amount > 0 && amount <= self.reward_reserved,
            "No accrued reward"
        );
        position.reward = 0;
        self.reward_reserved -= amount;
        self.reward_in_flight += amount;
        self.positions.insert(&account, &position);
        self.transfer(account, amount, true)
    }

    #[private]
    pub fn finish_payout(&mut self, payout_id: u64) -> bool {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Only self callback"
        );
        require!(env::promise_results_count() == 1, "Expected one receipt");
        let payout = self
            .payouts
            .remove(&payout_id)
            .expect("Unknown or completed payout");
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if payout.reward {
            self.reward_in_flight -= payout.amount;
            if success {
                self.reward_paid += payout.amount;
            } else {
                let mut position = self.positions.get(&payout.account_id).unwrap_or_default();
                position.reward += payout.amount;
                self.reward_reserved += payout.amount;
                self.positions.insert(&payout.account_id, &position);
            }
        } else {
            self.principal_in_flight -= payout.amount;
            if !success {
                self.checkpoint();
                let mut position = self.settle(&payout.account_id);
                position.principal += payout.amount;
                self.principal += payout.amount;
                self.positions.insert(&payout.account_id, &position);
            }
        }
        success
    }

    pub fn get_pool(&self) -> PoolView {
        PoolView {
            principal: U128(self.principal),
            principal_in_flight: U128(self.principal_in_flight),
            reward_available: U128(self.reward_available),
            reward_reserved: U128(self.reward_reserved),
            reward_in_flight: U128(self.reward_in_flight),
            reward_paid: U128(self.reward_paid),
            opened_at_ms: self.opened_at_ms,
            starts_at_ms: self.starts_at_ms,
            ends_at_ms: self.starts_at_ms.map(|start| start + DURATION_MS),
        }
    }

    // Accrued view is checkpointed through current block time without a write.
    pub fn get_position(&self, account_id: AccountId) -> PositionView {
        let position = self.positions.get(&account_id).unwrap_or_default();
        let (index_delta, _) = self.interval();
        PositionView {
            principal: U128(position.principal),
            registered: position.registered,
            accrued_reward: U128(
                position.reward
                    + mul_div(
                        position.principal,
                        self.index + index_delta - position.index,
                        SCALE,
                    ),
            ),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use near_sdk::{test_utils::VMContextBuilder, testing_env};
    fn id(value: &str) -> AccountId {
        value.parse().unwrap()
    }
    fn context(actor: &str, time: u64, deposit: u128) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(id("pool.owner.testnet"))
            .predecessor_account_id(id(actor))
            .signer_account_id(id(actor))
            .block_timestamp(time * 1_000_000)
            .attached_deposit(NearToken::from_yoctonear(deposit))
            .prepaid_gas(Gas::from_tgas(300));
        testing_env!(builder.build());
    }
    fn funded() -> Pool {
        context("owner.testnet", DAY_MS, 0);
        let mut pool = Pool::new(
            id("owner.testnet"),
            id("foxo.testnet"),
            id("signer.testnet"),
        );
        context("signer.testnet", DAY_MS, 0);
        pool.record_boss_clear(id("alice.testnet"), "boss-a".into(), DAY_MS);
        pool.record_boss_clear(id("bob.testnet"), "boss-a".into(), DAY_MS);
        context("foxo.testnet", DAY_MS, 0);
        assert_eq!(
            pool.ft_on_transfer(
                id("owner.testnet"),
                U128(BUDGET + 1),
                r#"{"action":"fund_reward"}"#.into()
            )
            .0,
            1
        );
        context("owner.testnet", DAY_MS, 0);
        pool.open_campaign(DAY_MS + 1_000);
        for actor in ["alice.testnet", "bob.testnet"] {
            context(actor, DAY_MS, 0);
            pool.register();
        }
        pool
    }
    fn stake(pool: &mut Pool, actor: &str, amount: u128, time: u64) {
        context("foxo.testnet", time, 0);
        assert_eq!(
            pool.ft_on_transfer(id(actor), U128(amount), r#"{"action":"stake"}"#.into())
                .0,
            0
        );
    }
    fn callback(success: bool, time: u64) {
        let mut builder = VMContextBuilder::new();
        builder
            .current_account_id(id("pool.owner.testnet"))
            .predecessor_account_id(id("pool.owner.testnet"))
            .signer_account_id(id("alice.testnet"))
            .block_timestamp(time * 1_000_000);
        testing_env!(
            builder.build(),
            near_sdk::test_vm_config(),
            near_sdk::RuntimeFeesConfig::test(),
            Default::default(),
            vec![if success {
                PromiseResult::Successful(vec![])
            } else {
                PromiseResult::Failed
            }]
        );
    }
    #[test]
    fn target_stake_emits_exact_budget_and_principal_remains_withdrawable() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", TARGET, start);
        context("alice.testnet", start + DURATION_MS, 1);
        assert_eq!(
            pool.get_position(id("alice.testnet")).accrued_reward.0,
            BUDGET
        );
        let _ = pool.claim();
        assert_eq!(pool.reward_in_flight, BUDGET);
        callback(true, start + DURATION_MS);
        assert!(pool.finish_payout(0));
        assert_eq!(pool.reward_paid, BUDGET);
        context("alice.testnet", start + DURATION_MS + 100, 1);
        let _ = pool.withdraw(U128(TARGET));
        callback(true, start + DURATION_MS + 100);
        assert!(pool.finish_payout(1));
        assert_eq!(pool.principal, 0);
        assert_eq!(pool.principal_in_flight, 0);
    }
    #[test]
    fn zero_stake_and_late_registered_stake_have_no_retroactive_rewards() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        context("alice.testnet", start + DURATION_MS / 2, 0);
        assert_eq!(pool.get_position(id("alice.testnet")).accrued_reward.0, 0);
        stake(
            &mut pool,
            "alice.testnet",
            TARGET / 2,
            start + DURATION_MS / 2,
        );
        context("alice.testnet", start + DURATION_MS, 0);
        assert_eq!(
            pool.get_position(id("alice.testnet")).accrued_reward.0,
            BUDGET / 4
        );
    }
    #[test]
    fn whale_and_account_split_share_the_same_total_cap() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", TARGET, start);
        stake(&mut pool, "bob.testnet", TARGET, start);
        context("alice.testnet", start + DURATION_MS, 0);
        assert_eq!(
            pool.get_position(id("alice.testnet")).accrued_reward.0,
            BUDGET / 2
        );
        assert_eq!(
            pool.get_position(id("bob.testnet")).accrued_reward.0,
            BUDGET / 2
        );
    }
    #[test]
    fn failed_principal_and_reward_deliveries_restore_the_original_beneficiary() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", TARGET, start);
        context("alice.testnet", start + DURATION_MS / 2, 1);
        let _ = pool.claim();
        callback(false, start + DURATION_MS / 2);
        assert!(!pool.finish_payout(0));
        assert_eq!(
            pool.positions.get(&id("alice.testnet")).unwrap().reward,
            BUDGET / 2
        );
        context("alice.testnet", start + DURATION_MS / 2, 1);
        let _ = pool.withdraw(U128(TARGET));
        callback(false, start + DURATION_MS);
        assert!(!pool.finish_payout(1));
        assert_eq!(
            pool.positions.get(&id("alice.testnet")).unwrap().principal,
            TARGET
        );
        assert_eq!(pool.principal_in_flight, 0);
        // Principal awaiting failed delivery does not earn during the gap.
        assert_eq!(
            pool.get_position(id("alice.testnet")).accrued_reward.0,
            BUDGET / 2
        );
    }
    #[test]
    fn tiny_stake_cannot_create_reward_from_rounding() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", 1, start);
        context("alice.testnet", start + DURATION_MS, 0);
        assert_eq!(pool.get_position(id("alice.testnet")).accrued_reward.0, 0);
        pool.checkpoint();
        assert_eq!(pool.reward_available + pool.reward_reserved, BUDGET);
    }
    #[test]
    #[should_panic(expected = "Only configured token")]
    fn unrelated_token_cannot_fund_or_stake() {
        let mut pool = funded();
        context("evil.testnet", DAY_MS, 0);
        pool.ft_on_transfer(
            id("alice.testnet"),
            U128(TARGET),
            r#"{"action":"stake"}"#.into(),
        );
    }
    #[test]
    #[should_panic(expected = "Registration closed")]
    fn late_registration_rejects_even_an_eligible_player() {
        let mut pool = funded();
        context("alice.testnet", pool.starts_at_ms.unwrap(), 0);
        pool.register();
    }
    #[test]
    #[should_panic(expected = "Only self callback")]
    fn spoofed_callback_cannot_clear_a_liability() {
        let mut pool = funded();
        context("alice.testnet", pool.starts_at_ms.unwrap(), 0);
        pool.finish_payout(0);
    }
    #[test]
    #[should_panic(expected = "Unknown or completed payout")]
    fn completed_callback_cannot_replay() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", TARGET, start);
        context("alice.testnet", start + DURATION_MS, 1);
        let _ = pool.claim();
        callback(true, start + DURATION_MS);
        pool.finish_payout(0);
        pool.finish_payout(0);
    }
    #[test]
    fn many_checkpoints_and_withdraw_all_never_consume_principal_for_rewards() {
        let mut pool = funded();
        let start = pool.starts_at_ms.unwrap();
        stake(&mut pool, "alice.testnet", TARGET + 7, start);
        for n in 1..=100 {
            context("alice.testnet", start + DURATION_MS * n / 100, 0);
            pool.checkpoint();
        }
        assert_eq!(pool.principal, TARGET + 7);
        assert_eq!(pool.reward_available + pool.reward_reserved, BUDGET);
        assert!(pool.get_position(id("alice.testnet")).accrued_reward.0 <= BUDGET);
        context("alice.testnet", start + DURATION_MS, 1);
        let _ = pool.withdraw(U128(TARGET + 7));
        assert_eq!(pool.principal, 0);
        assert_eq!(pool.principal_in_flight, TARGET + 7);
    }
}

impl Pool {
    fn interval(&self) -> (u128, u128) {
        let Some(start) = self.starts_at_ms else {
            return (0, 0);
        };
        let end = env::block_timestamp_ms().min(start + DURATION_MS);
        if self.principal == 0 || end <= self.last_ms {
            return (0, 0);
        }
        let elapsed = end - self.last_ms;
        let denominator = self.principal.max(TARGET);
        let numerator = U256::from(BUDGET) * U256::from(elapsed) * U256::from(SCALE);
        let computed = (numerator / U256::from(DURATION_MS) / U256::from(denominator)).as_u128();
        let affordable = (U256::from(self.reward_available) * U256::from(SCALE)
            / U256::from(self.principal))
        .min(U256::from(u128::MAX))
        .as_u128();
        let index_delta = computed.min(affordable);
        // Reserve ceil(total * index increment / scale) so independent
        // checkpoints cannot create claims exceeding the reward liability.
        let product = U256::from(self.principal) * U256::from(index_delta);
        let reserved = ((product + U256::from(SCALE - 1)) / U256::from(SCALE)).as_u128();
        (index_delta, reserved)
    }
    fn checkpoint(&mut self) {
        let (index_delta, reserved) = self.interval();
        require!(reserved <= self.reward_available, "Reward budget exhausted");
        self.index += index_delta;
        self.reward_available -= reserved;
        self.reward_reserved += reserved;
        if let Some(start) = self.starts_at_ms {
            self.last_ms = env::block_timestamp_ms()
                .min(start + DURATION_MS)
                .max(start);
        }
    }
    fn settle(&mut self, account: &AccountId) -> Position {
        let mut position = self.positions.get(account).unwrap_or_default();
        position.reward += mul_div(position.principal, self.index - position.index, SCALE);
        position.index = self.index;
        position
    }
    fn transfer(&mut self, account: AccountId, amount: u128, reward: bool) -> Promise {
        let payout_id = self.next_payout;
        self.next_payout = self
            .next_payout
            .checked_add(1)
            .expect("Payout IDs exhausted");
        self.payouts.insert(
            &payout_id,
            &Payout {
                account_id: account.clone(),
                amount,
                reward,
            },
        );
        ext_ft::ext(self.token_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(account, U128(amount), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(25))
                    .finish_payout(payout_id),
            )
    }
}
