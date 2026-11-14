mod crafting;
mod recipe_licenses;
mod events;
mod guild_projects;
mod inventory;
mod ledger;
mod multi_token;
mod orders;
mod order_storage;
mod ranking;
mod reservations;
mod sales;
mod settlement;

use crafting::{CraftedItem, Recipe};
use inventory::{Inventory, Materials};
use ledger::{Ledger, LedgerView, REWARD_FUNDING_CAP};
use near_sdk::{
    assert_one_yocto,
    collections::{LookupMap, LookupSet},
    env, ext_contract,
    json_types::U128,
    near, require, AccountId, Gas, NearToken, PanicOnDefault, Promise, PromiseResult,
};
use orders::{OrderLedger, OrderPayout, Orders, PurchaseOrder};
use settlement::{valid_identifier, Entitlement, EntitlementView, ResultPayload, Status};

#[allow(dead_code)]
#[ext_contract(ext_token)]
trait Token {
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}

#[allow(dead_code)]
#[ext_contract(ext_self)]
trait Callback {
    fn finish_claim(&mut self, operation_id: String, attempt: u64) -> bool;
    fn finish_order_payout(&mut self, payout_id: u64) -> bool;
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct EconomyConfig {
    owner_id: AccountId,
    foxo_contract_id: AccountId,
    network: String,
    settlement_signer_id: AccountId,
    signer_epoch: u32,
    settlement_enabled: bool,
    reward_funding_cap: U128,
    crafting_enabled: bool,
    orders_enabled: bool,
    market_fee_bps: u16,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct Campaign {
    remaining: U128,
    max_award: U128,
    closes_at_ms: u64,
    closed: bool,
}

#[near(serializers = [json])]
#[serde(tag = "action", rename_all = "snake_case", deny_unknown_fields)]
enum TransferAction {
    FundRewards,
    #[serde(rename_all = "camelCase")]
    GuildCommit { project_id: String, terms_hash: String },
    #[serde(rename_all = "camelCase")]
    BuySale {
        operation_id: String,
        sale_id: String,
    },
    #[serde(rename_all = "camelCase")]
    Craft {
        operation_id: String,
        recipe_id: String,
        recipe_version: u32,
    },
    #[serde(rename_all = "camelCase")]
    FundOrder {
        operation_id: String,
        recipe_id: String,
        recipe_version: u32,
        quantity: u32,
        unit_price: U128,
        expires_at_ms: u64,
    },
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Economy {
    owner_id: AccountId,
    foxo_contract_id: AccountId,
    network: String,
    settlement_signer_id: AccountId,
    signer_epoch: u32,
    settlement_enabled: bool,
    ledger: Ledger,
    entitlements: LookupMap<String, Entitlement>,
    settled_matches: LookupSet<(AccountId, String)>,
    campaigns: LookupMap<String, Campaign>,
    inventories: LookupMap<AccountId, Inventory>,
    material_grants: LookupMap<(AccountId, String), Materials>,
    recipes: LookupMap<(String, u32), Recipe>,
    items: LookupMap<String, CraftedItem>,
    owned_item_count: LookupMap<AccountId, u32>,
    owned_item_ids: LookupMap<(AccountId, u32), String>,
    item_positions: LookupMap<String, u32>,
    equipped: LookupMap<AccountId, String>,
    crafting_enabled: bool,
    orders: Orders,
}

#[near]
impl Economy {
    #[init]
    pub fn new(
        owner_id: AccountId,
        foxo_contract_id: AccountId,
        network: String,
        settlement_signer_id: AccountId,
    ) -> Self {
        let contract_id = env::current_account_id();
        let caller = env::predecessor_account_id();
        let direct_owner_subaccount = caller == owner_id
            && env::signer_account_id() == owner_id
            && contract_id
                .as_str()
                .split_once('.')
                .is_some_and(|(_, parent)| parent == owner_id.as_str());
        require!(
            caller == contract_id || direct_owner_subaccount,
            "Only this account or its parent operator can initialize"
        );
        require!(
            foxo_contract_id != contract_id,
            "Token account must differ from vault"
        );
        require!(valid_identifier(&network, 32), "Invalid network");
        Self {
            owner_id,
            foxo_contract_id,
            network,
            settlement_signer_id,
            signer_epoch: 1,
            settlement_enabled: false,
            ledger: Ledger::default(),
            entitlements: LookupMap::new(b"e"),
            settled_matches: LookupSet::new(b"m"),
            campaigns: LookupMap::new(b"s"),
            inventories: LookupMap::new(b"i"),
            material_grants: LookupMap::new(b"g"),
            recipes: LookupMap::new(b"r"),
            items: LookupMap::new(b"c"),
            owned_item_count: LookupMap::new(b"n"),
            owned_item_ids: LookupMap::new(b"j"),
            item_positions: LookupMap::new(b"I"),
            equipped: LookupMap::new(b"q"),
            crafting_enabled: false,
            orders: Orders::default(),
        }
    }

    pub fn get_config(&self) -> EconomyConfig {
        EconomyConfig {
            owner_id: self.owner_id.clone(),
            foxo_contract_id: self.foxo_contract_id.clone(),
            network: self.network.clone(),
            settlement_signer_id: self.settlement_signer_id.clone(),
            signer_epoch: self.signer_epoch,
            settlement_enabled: self.settlement_enabled,
            reward_funding_cap: U128(REWARD_FUNDING_CAP),
            crafting_enabled: self.crafting_enabled,
            orders_enabled: self.orders.enabled,
            market_fee_bps: 250,
        }
    }

    pub fn get_ledger(&self) -> LedgerView {
        self.ledger.view(reservations::held())
    }

    pub fn get_entitlement(&self, operation_id: String) -> Option<EntitlementView> {
        self.entitlements
            .get(&operation_id)
            .map(|entry| entry.view(operation_id))
    }

    pub fn set_settlement_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        self.settlement_enabled = enabled;
    }

    pub fn open_campaign(
        &mut self,
        campaign_id: String,
        budget: U128,
        max_award: U128,
        closes_at_ms: u64,
    ) {
        self.assert_owner();
        require!(valid_identifier(&campaign_id, 64), "Invalid campaign ID");
        require!(
            !self.campaigns.contains_key(&campaign_id),
            "Campaign already exists"
        );
        require!(
            max_award.0 > 0 && max_award.0 <= budget.0,
            "Invalid award cap"
        );
        require!(
            closes_at_ms > env::block_timestamp_ms(),
            "Campaign deadline has passed"
        );
        require!(
            self.ledger.allocate_campaign(budget.0),
            "Insufficient unallocated funds"
        );
        self.campaigns.insert(
            &campaign_id,
            &Campaign {
                remaining: budget,
                max_award,
                closes_at_ms,
                closed: false,
            },
        );
    }

    pub fn get_campaign(&self, campaign_id: String) -> Option<Campaign> {
        self.campaigns.get(&campaign_id)
    }

    pub fn close_campaign(&mut self, campaign_id: String) {
        self.assert_owner();
        let mut campaign = self.campaigns.get(&campaign_id).expect("Unknown campaign");
        require!(!campaign.closed, "Campaign already closed");
        self.ledger.release_campaign(campaign.remaining.0);
        campaign.remaining = U128(0);
        campaign.closed = true;
        self.campaigns.insert(&campaign_id, &campaign);
    }

    pub fn rotate_settlement_signer(&mut self, settlement_signer_id: AccountId) {
        self.assert_owner();
        self.signer_epoch = self
            .signer_epoch
            .checked_add(1)
            .expect("Signer epoch exhausted");
        self.settlement_signer_id = settlement_signer_id;
    }

    pub fn set_crafting_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        self.crafting_enabled = enabled;
    }

    pub fn add_recipe(&mut self, recipe: Recipe) {
        self.assert_owner();
        require!(recipe.sku != "guild-banner-beacon-v2", "Banner is issued by the Guild contract");
        require!(
            valid_identifier(&recipe.recipe_id, 48) && valid_identifier(&recipe.sku, 64),
            "Invalid recipe identity"
        );
        require!(
            recipe.version > 0 && recipe.inputs != Materials::default() && recipe.fee_atomic.0 > 0,
            "Invalid recipe costs"
        );
        let key = (recipe.recipe_id.clone(), recipe.version);
        require!(
            !self.recipes.contains_key(&key),
            "Recipe version already exists"
        );
        self.recipes.insert(&key, &recipe);
    }

    pub fn get_recipe(&self, recipe_id: String, recipe_version: u32) -> Option<Recipe> {
        self.recipes.get(&(recipe_id, recipe_version))
    }

    pub fn get_inventory(&self, account_id: AccountId) -> Inventory {
        self.inventories.get(&account_id).unwrap_or_default()
    }

    pub fn get_item(&self, item_id: String) -> Option<CraftedItem> {
        self.items.get(&item_id)
    }

    pub fn get_owned_items(
        &self,
        account_id: AccountId,
        offset: u32,
        limit: u32,
    ) -> Vec<CraftedItem> {
        let count = self.owned_item_count.get(&account_id).unwrap_or(0);
        let end = offset.saturating_add(limit.min(50)).min(count);
        (offset..end)
            .filter_map(|index| self.owned_item_ids.get(&(account_id.clone(), index)))
            .filter_map(|id| self.items.get(&id))
            .collect()
    }

    pub fn get_equipped(&self, account_id: AccountId) -> Option<String> {
        self.equipped.get(&account_id)
    }

    pub fn grant_materials(
        &mut self,
        account_id: AccountId,
        match_id: String,
        materials: Materials,
    ) -> bool {
        self.assert_settlement_signer();
        require!(
            valid_identifier(&match_id, 128) && materials != Materials::default(),
            "Invalid material grant"
        );
        let key = (account_id.clone(), match_id);
        if let Some(previous) = self.material_grants.get(&key) {
            require!(previous == materials, "Conflicting material grant");
            return false;
        }
        require!(self.crafting_enabled, "Material grants are disabled");
        require!(
            multi_token::legacy_writes_allowed(),
            "MT migration freezes material writes"
        );
        let mut inventory = self.get_inventory(account_id.clone());
        multi_token::assert_inventory_included(
            &account_id,
            inventory.available,
            inventory.reserved,
        );
        let utc_day = env::block_timestamp_ms() / 86_400_000;
        require!(
            inventory.grant(materials, utc_day),
            "Material quota exceeded"
        );
        multi_token::assert_refund_capacity(&account_id, inventory.available);
        self.inventories.insert(&account_id, &inventory);
        self.material_grants.insert(&key, &materials);
        multi_token::record_material_change(&account_id, materials, true);
        true
    }

    #[payable]
    pub fn equip(&mut self, item_id: String) {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let item = self.items.get(&item_id).expect("Unknown item");
        require!(item.owner_id == account, "Only the item owner can equip");
        self.equipped.insert(&account, &item_id);
    }

    pub fn set_orders_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        self.orders.enabled = enabled;
    }

    pub fn get_order(&self, order_id: String) -> Option<PurchaseOrder> {
        self.orders.orders.get(&order_id)
    }

    pub fn get_order_credit(&self, account_id: AccountId) -> U128 {
        U128(self.orders.credits.get(&account_id).unwrap_or(0))
    }

    pub fn get_order_ledger(&self) -> OrderLedger {
        OrderLedger {
            escrow: U128(self.orders.escrow),
            payable: U128(self.orders.payable),
            in_flight: U128(self.orders.in_flight),
            market_fees: U128(orders::market_fees()),
        }
    }

    #[payable]
    pub fn fill_order(&mut self, order_id: String, item_id: String) {
        assert_one_yocto();
        require!(self.orders.enabled, "Orders are paused");
        let seller = env::predecessor_account_id();
        let mut order = self.get_order(order_id.clone()).expect("Unknown order");
        require!(
            !order.closed && order.remaining > 0 && env::block_timestamp_ms() < order.expires_at_ms,
            "Order is closed"
        );
        require!(seller != order.buyer_id, "Cannot fill your own order");
        let mut item = self.get_item(item_id.clone()).expect("Unknown item");
        require!(item.owner_id == seller, "Only the item owner can sell");
        require!(
            item.recipe_id == order.recipe_id && item.recipe_version == order.recipe_version,
            "Item does not match order"
        );
        self.transfer_crafted_item(&item_id, &seller, &order.buyer_id);
        item.owner_id = order.buyer_id.clone();
        self.items.insert(&item_id, &item);
        order.remaining -= 1;
        order.closed = order.remaining == 0;
        self.orders.orders.insert(&order_id, &order);
        self.orders.escrow -= order.unit_price.0;
        let fee = orders::market_fee(order.unit_price.0);
        let net = order.unit_price.0 - fee;
        self.orders.credit(&seller, net);
        orders::collect_market_fee(fee);
        events::emit(
            "order_filled",
            near_sdk::serde_json::json!({
                "orderId": order_id, "itemId": item_id, "accountId": seller,
                "amountAtomic": order.unit_price, "grossAtomic": order.unit_price,
                "feeAtomic": U128(fee), "netAtomic": U128(net)
            }),
        );
    }

    #[payable]
    pub fn close_order(&mut self, order_id: String) {
        assert_one_yocto();
        let mut order = self.get_order(order_id.clone()).expect("Unknown order");
        require!(
            order.buyer_id == env::predecessor_account_id(),
            "Only the buyer can close"
        );
        require!(!order.closed, "Order already closed");
        let refund = order.unit_price.0 * u128::from(order.remaining);
        order.remaining = 0;
        order.closed = true;
        self.orders.orders.insert(&order_id, &order);
        self.orders.escrow -= refund;
        self.orders.credit(&order.buyer_id, refund);
        events::emit(
            "order_refund_credited",
            near_sdk::serde_json::json!({
                "orderId": order_id, "accountId": order.buyer_id, "amountAtomic": U128(refund)
            }),
        );
    }

    #[payable]
    pub fn withdraw_order_credit(&mut self) -> Promise {
        assert_one_yocto();
        require!(
            env::prepaid_gas() >= Gas::from_tgas(65),
            "Withdrawal needs at least 65 Tgas"
        );
        let account_id = env::predecessor_account_id();
        let amount = self.get_order_credit(account_id.clone()).0;
        require!(amount > 0, "No order credit");
        let payout_id = self.orders.next_payout;
        self.orders.next_payout = payout_id.checked_add(1).expect("Payout ID exhausted");
        self.orders.credits.remove(&account_id);
        self.orders.payable -= amount;
        self.orders.in_flight += amount;
        self.orders.payouts.insert(
            &payout_id,
            &OrderPayout {
                account_id: account_id.clone(),
                amount,
            },
        );
        events::emit(
            "order_payout_started",
            near_sdk::serde_json::json!({
                "payoutId": payout_id.to_string(), "accountId": account_id, "amountAtomic": U128(amount)
            }),
        );
        ext_token::ext(self.foxo_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(account_id, U128(amount), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .finish_order_payout(payout_id),
            )
    }

    #[private]
    pub fn finish_order_payout(&mut self, payout_id: u64) -> bool {
        require!(
            env::promise_results_count() == 1,
            "Expected one transfer receipt"
        );
        let payout = self
            .orders
            .payouts
            .remove(&payout_id)
            .expect("Unknown payout");
        self.orders.in_flight -= payout.amount;
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        if !success {
            self.orders.credit(&payout.account_id, payout.amount);
        }
        events::emit(
            if success {
                "order_paid"
            } else {
                "order_transfer_failed"
            },
            near_sdk::serde_json::json!({ "payoutId": payout_id.to_string(),
                "accountId": payout.account_id, "amountAtomic": U128(payout.amount) }),
        );
        success
    }

    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.foxo_contract_id,
            "Wrong token contract"
        );
        if msg.len() > 256 {
            return amount;
        }
        match near_sdk::serde_json::from_str::<TransferAction>(&msg) {
            Ok(TransferAction::GuildCommit {project_id,terms_hash}) => self.receive_guild_commit(sender_id,project_id,terms_hash,amount),
            Ok(TransferAction::BuySale { operation_id, sale_id }) => {
                self.buy_cosmetic_sale(sender_id, operation_id, sale_id, amount)
            }
            Ok(TransferAction::FundRewards) if sender_id == self.owner_id => {
                let accepted = self.ledger.fund_rewards(amount.0);
                if accepted > 0 {
                    events::emit(
                        "reward_funded",
                        near_sdk::serde_json::json!({
                            "accountId": sender_id, "amountAtomic": U128(accepted)
                        }),
                    );
                }
                U128(amount.0 - accepted)
            }
            Ok(TransferAction::Craft {
                operation_id,
                recipe_id,
                recipe_version,
            }) => {
                if self.craft(sender_id, operation_id, recipe_id, recipe_version, amount.0) {
                    U128(0)
                } else {
                    amount
                }
            }
            Ok(TransferAction::FundOrder {
                operation_id,
                recipe_id,
                recipe_version,
                quantity,
                unit_price,
                expires_at_ms,
            }) => {
                let order_id = format!("{sender_id}:{operation_id}");
                let now = env::block_timestamp_ms();
                if !self.orders.enabled
                    || !valid_identifier(&operation_id, 64)
                    || !valid_identifier(&recipe_id, 48)
                    || !(1..=100).contains(&quantity)
                    || expires_at_ms <= now
                    || expires_at_ms - now > 30 * 86_400_000
                    || unit_price.0 == 0
                    || unit_price.0.checked_mul(u128::from(quantity)) != Some(amount.0)
                    || self.orders.orders.contains_key(&order_id)
                    || self.get_recipe(recipe_id.clone(), recipe_version).is_none()
                {
                    return amount;
                }
                if !order_storage::charge(&sender_id,quantity) { return amount; }
                self.orders.escrow = self
                    .orders
                    .escrow
                    .checked_add(amount.0)
                    .expect("Order escrow overflow");
                self.orders.orders.insert(
                    &order_id,
                    &PurchaseOrder {
                        buyer_id: sender_id.clone(),
                        recipe_id,
                        recipe_version,
                        unit_price,
                        remaining: quantity,
                        expires_at_ms,
                        closed: false,
                    },
                );
                events::emit(
                    "order_funded",
                    near_sdk::serde_json::json!({
                        "orderId": order_id, "accountId": sender_id, "amountAtomic": amount
                    }),
                );
                U128(0)
            }
            _ => amount,
        }
    }

    pub fn settle_result(&mut self, payload: ResultPayload) -> EntitlementView {
        // The signed NEAR FunctionCall action authenticates the entire payload. Restrict the
        // predecessor as well as the signer so another contract cannot submit on its behalf.
        self.assert_settlement_signer();
        payload.check_domain(&self.network, self.signer_epoch);
        require!(!payload.operation_id.starts_with("guild-mission:") &&
            !payload.campaign_id.starts_with("guild-mission:"), "Use Guild mission settlement");
        require!(!ranking::ranking_campaign(&payload.campaign_id), "Use reviewed ranking publication");
        require!(
            !reservations::fixed_campaign(&payload.campaign_id)
                && !reservations::fixed_operation(&payload.operation_id)
                && !reservations::fixed_match(&(
                    payload.account_id.clone(),
                    payload.match_id.clone()
                )),
            "Use fixed reservation settlement"
        );
        let fingerprint = payload.fingerprint();
        if let Some(entry) = self.entitlements.get(&payload.operation_id) {
            require!(
                entry.fingerprint == fingerprint,
                "Operation ID already used"
            );
            return entry.view(payload.operation_id);
        }

        require!(self.settlement_enabled, "Settlement is disabled");
        payload.check_expiry();
        let match_key = (payload.account_id.clone(), payload.match_id);
        require!(
            !self.settled_matches.contains(&match_key),
            "Match result already settled"
        );
        require!(
            payload.amount_atomic.0 > 0,
            "Reward amount must be positive"
        );
        let mut campaign = self
            .campaigns
            .get(&payload.campaign_id)
            .expect("Unknown campaign");
        require!(
            !campaign.closed && env::block_timestamp_ms() < campaign.closes_at_ms,
            "Campaign closed"
        );
        require!(
            payload.amount_atomic.0 <= campaign.max_award.0,
            "Award exceeds campaign cap"
        );
        require!(
            payload.amount_atomic.0 <= campaign.remaining.0,
            "Insufficient campaign funds"
        );
        campaign.remaining.0 -= payload.amount_atomic.0;
        self.ledger.reserve_campaign_reward(payload.amount_atomic.0);
        self.campaigns.insert(&payload.campaign_id, &campaign);

        let entry = Entitlement {
            fingerprint,
            account_id: payload.account_id,
            amount_atomic: payload.amount_atomic.0,
            status: Status::Reserved,
            attempt: 0,
        };
        self.entitlements.insert(&payload.operation_id, &entry);
        self.settled_matches.insert(&match_key);
        events::emit(
            "reward_reserved",
            near_sdk::serde_json::json!({
                "operationId": payload.operation_id, "campaignId": payload.campaign_id,
                "accountId": entry.account_id, "amountAtomic": U128(entry.amount_atomic)
            }),
        );
        entry.view(payload.operation_id)
    }

    pub fn settle_guild_mission(&mut self, project_id: String, mode: String, payload: ResultPayload) -> EntitlementView {
        self.assert_settlement_signer();
        payload.check_domain(&self.network, self.signer_epoch);
        require!(valid_identifier(&project_id, 48), "Invalid Guild project");
        require!(matches!(mode.as_str(), "boss" | "control" | "trials"), "Invalid Guild mission mode");
        require!(payload.rules_version == "guild-mission-v1", "Wrong Guild mission rules");
        require!(payload.campaign_id == format!("guild-mission:{project_id}"), "Wrong Guild campaign");
        let identity = format!("{project_id}/{mode}/{}", payload.account_id);
        let key = env::sha256_array(identity.as_bytes());
        let operation_id = format!("guild-mission:{}", key.iter().map(|byte| format!("{byte:02x}")).collect::<String>());
        require!(payload.operation_id == operation_id, "Wrong Guild operation ID");
        let fingerprint = payload.fingerprint();
        if let Some(entry) = self.entitlements.get(&operation_id) {
            require!(entry.fingerprint == fingerprint, "Guild mission already settled");
            return entry.view(operation_id);
        }
        require!(self.settlement_enabled, "Settlement is disabled");
        payload.check_expiry();
        let mut used = LookupSet::new(b"guild-mission/v1/matches".to_vec());
        let match_key = (payload.account_id.clone(), payload.match_id);
        require!(!used.contains(&match_key), "Match already used for a Guild mission");
        let mut campaign = self.campaigns.get(&payload.campaign_id).expect("Unknown Guild campaign");
        require!(!campaign.closed && env::block_timestamp_ms() < campaign.closes_at_ms, "Campaign closed");
        let award = payload.amount_atomic.0;
        require!(award > 0 && award <= campaign.max_award.0, "Invalid Guild award");
        require!(award <= campaign.remaining.0, "Insufficient campaign funds");
        campaign.remaining.0 -= award;
        self.ledger.reserve_campaign_reward(award);
        self.campaigns.insert(&payload.campaign_id, &campaign);
        used.insert(&match_key);
        let entry = Entitlement { fingerprint, account_id: payload.account_id, amount_atomic: award,
            status: Status::Reserved, attempt: 0 };
        self.entitlements.insert(&operation_id, &entry);
        events::emit("reward_reserved", near_sdk::serde_json::json!({
            "operationId": operation_id, "campaignId": payload.campaign_id,
            "accountId": entry.account_id, "amountAtomic": U128(award)
        }));
        entry.view(operation_id)
    }

    #[payable]
    pub fn claim(&mut self, operation_id: String) -> Promise {
        assert_one_yocto();
        let mut entry = self
            .entitlements
            .get(&operation_id)
            .expect("Unknown entitlement");
        require!(
            env::predecessor_account_id() == entry.account_id,
            "Only beneficiary can claim"
        );
        require!(
            entry.status == Status::Reserved,
            "Entitlement is not reserved"
        );
        require!(
            env::prepaid_gas() >= Gas::from_tgas(65),
            "Claim needs at least 65 Tgas"
        );

        entry.attempt = entry
            .attempt
            .checked_add(1)
            .expect("Claim attempt exhausted");
        entry.status = Status::InFlight;
        self.ledger.begin_reward_transfer(entry.amount_atomic);
        self.entitlements.insert(&operation_id, &entry);
        events::emit(
            "reward_payout_started",
            near_sdk::serde_json::json!({
                "operationId": operation_id, "attempt": entry.attempt.to_string(),
                "accountId": entry.account_id, "amountAtomic": U128(entry.amount_atomic)
            }),
        );

        ext_token::ext(self.foxo_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(25))
            .ft_transfer(entry.account_id, U128(entry.amount_atomic), None)
            .then(
                ext_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .finish_claim(operation_id, entry.attempt),
            )
    }

    #[private]
    pub fn finish_claim(&mut self, operation_id: String, attempt: u64) -> bool {
        require!(
            env::promise_results_count() == 1,
            "Expected one transfer receipt"
        );
        let mut entry = self
            .entitlements
            .get(&operation_id)
            .expect("Unknown entitlement");
        require!(
            entry.status == Status::InFlight && entry.attempt == attempt,
            "Stale claim callback"
        );
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        self.ledger
            .finish_reward_transfer(entry.amount_atomic, success);
        entry.status = if success {
            Status::Paid
        } else {
            Status::Reserved
        };
        self.entitlements.insert(&operation_id, &entry);
        events::emit(
            if success {
                "reward_paid"
            } else {
                "reward_transfer_failed"
            },
            near_sdk::serde_json::json!({ "operationId": operation_id, "attempt": attempt.to_string(),
                "accountId": entry.account_id, "amountAtomic": U128(entry.amount_atomic) }),
        );
        success
    }
}

impl Economy {
    fn transfer_crafted_item(&mut self, item_id: &String, seller: &AccountId, buyer: &AccountId) {
        multi_token::cosmetic_transfer(item_id, seller, buyer);
        sales::record_item_transfer(item_id);
        let position = self
            .item_positions
            .get(item_id)
            .expect("Missing item position");
        let last = self
            .owned_item_count
            .get(seller)
            .expect("Missing inventory")
            - 1;
        let last_id = self
            .owned_item_ids
            .remove(&(seller.clone(), last))
            .expect("Missing inventory item");
        if position != last {
            self.owned_item_ids
                .insert(&(seller.clone(), position), &last_id);
            self.item_positions.insert(&last_id, &position);
        }
        self.owned_item_count.insert(seller, &last);
        let next = self.owned_item_count.get(buyer).unwrap_or(0);
        self.owned_item_ids.insert(&(buyer.clone(), next), item_id);
        self.item_positions.insert(item_id, &next);
        self.owned_item_count
            .insert(buyer, &next.checked_add(1).expect("Inventory full"));
        if self.equipped.get(seller).as_ref() == Some(item_id) {
            self.equipped.remove(seller);
        }
    }

    fn craft(
        &mut self,
        owner: AccountId,
        operation_id: String,
        recipe_id: String,
        version: u32,
        amount: u128,
    ) -> bool {
        if !self.crafting_enabled
            || !multi_token::legacy_writes_allowed()
            || !valid_identifier(&operation_id, 64)
            || !valid_identifier(&recipe_id, 48)
        {
            return false;
        }
        let item_id = format!("{owner}:{operation_id}");
        if self.items.contains_key(&item_id) {
            return false;
        }
        let count = self.owned_item_count.get(&owner).unwrap_or(0);
        let Some(next_count) = count.checked_add(1) else {
            return false;
        };
        let Some(recipe) = self.get_recipe(recipe_id, version) else {
            return false;
        };
        if !self.can_craft_recipe(&owner, &recipe) {
            return false;
        }
        if amount != recipe.fee_atomic.0 {
            return false;
        }
        let Some(revenue) = self.ledger.crafting_fees.checked_add(amount) else {
            return false;
        };
        let mut inventory = self.get_inventory(owner.clone());
        multi_token::assert_inventory_included(&owner, inventory.available, inventory.reserved);
        if !inventory.consume(recipe.inputs) {
            return false;
        }
        let item = CraftedItem {
            item_id: item_id.clone(),
            owner_id: owner.clone(),
            sku: recipe.sku,
            recipe_id: recipe.recipe_id,
            recipe_version: version,
        };
        self.items.insert(&item_id, &item);
        self.owned_item_ids
            .insert(&(owner.clone(), count), &item_id);
        self.owned_item_count.insert(&owner, &next_count);
        self.item_positions.insert(&item_id, &count);
        self.inventories.insert(&owner, &inventory);
        multi_token::record_material_change(&owner, recipe.inputs, false);
        multi_token::record_cosmetic_mint(&owner, &item_id);
        self.ledger.crafting_fees = revenue;
        events::emit(
            "craft_fee_collected",
            near_sdk::serde_json::json!({
                "operationId": operation_id, "itemId": item_id,
                "accountId": owner, "amountAtomic": U128(amount)
            }),
        );
        true
    }

    fn assert_settlement_signer(&self) {
        require!(
            env::predecessor_account_id() == self.settlement_signer_id
                && env::signer_account_id() == self.settlement_signer_id,
            "Unauthorized result signer"
        );
    }

    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
    }
}
