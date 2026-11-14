//! Single cosmetic fixed sales. Delivery and FT acceptance share one atomic receipt.
//! Fox NFTs belong to a separate contract and are deliberately not accepted here.
use crate::{events, orders, settlement::valid_identifier, Economy, EconomyExt};
use near_sdk::{
    assert_one_yocto, collections::LookupMap, env, json_types::U128, near, require, AccountId,
    NearToken, Promise,
};

const ENABLED: &[u8] = b"sales/v1/enabled";
const LISTING_BYTES: u128 = 4096;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct CosmeticSale {
    seller_id: AccountId,
    item_id: String,
    sku: String,
    recipe_id: String,
    recipe_version: u32,
    transfer_version: u64,
    price_atomic: U128,
    expires_at_ms: u64,
    status: String,
    buyer_id: Option<AccountId>,
    purchase_operation_id: Option<String>,
}

fn listings() -> LookupMap<String, CosmeticSale> {
    LookupMap::new(b"sales/v1/listing".to_vec())
}
fn versions() -> LookupMap<String, u64> {
    LookupMap::new(b"sales/v1/version".to_vec())
}
fn purchases() -> LookupMap<(AccountId, String), String> {
    LookupMap::new(b"sales/v1/purchase".to_vec())
}

pub(crate) fn enabled() -> bool {
    env::storage_read(ENABLED).is_some_and(|value| value == [1])
}

/// All authoritative cosmetic ownership paths pass through this hook, including MT callbacks.
pub(crate) fn record_item_transfer(item_id: &String) {
    let next = versions()
        .get(item_id)
        .unwrap_or(0)
        .checked_add(1)
        .expect("Item version exhausted");
    versions().insert(item_id, &next);
}

#[near]
impl Economy {
    pub fn set_sales_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        env::storage_write(ENABLED, &[u8::from(enabled)]);
    }

    pub fn get_sales_enabled(&self) -> bool {
        enabled()
    }

    pub fn get_cosmetic_item_version(&self, item_id: String) -> u64 {
        versions().get(&item_id).unwrap_or(0)
    }

    pub fn get_cosmetic_purchase(
        &self,
        account_id: AccountId,
        operation_id: String,
    ) -> Option<String> {
        purchases().get(&(account_id, operation_id))
    }

    pub fn get_cosmetic_sale_storage_charge(&self) -> U128 {
        U128(LISTING_BYTES * env::storage_byte_cost().as_yoctonear())
    }

    pub fn get_cosmetic_sale(&self, sale_id: String) -> Option<CosmeticSale> {
        listings().get(&sale_id)
    }

    /// Listing storage is a separate native-token charge, never deducted from FT principal.
    /// Ownership is retained; every transfer invalidates this exact version of the listing.
    #[payable]
    pub fn create_cosmetic_sale(
        &mut self,
        operation_id: String,
        item_id: String,
        expected_transfer_version: u64,
        price_atomic: U128,
        expires_at_ms: u64,
    ) -> String {
        require!(enabled(), "Sales are paused");
        require!(
            valid_identifier(&operation_id, 64),
            "Invalid sale operation ID"
        );
        let now = env::block_timestamp_ms();
        require!(
            expires_at_ms > now && expires_at_ms - now <= 30 * 86_400_000,
            "Invalid sale expiry"
        );
        require!(price_atomic.0 > 0, "Invalid sale price");
        let charge = self.get_cosmetic_sale_storage_charge().0;
        let deposit = env::attached_deposit().as_yoctonear();
        require!(deposit >= charge, "Insufficient listing storage charge");
        let seller = env::predecessor_account_id();
        let item = self.items.get(&item_id).expect("Unknown cosmetic item");
        require!(item.owner_id == seller, "Only the item owner can sell");
        require!(self.get_cosmetic_item_version(item_id.clone()) == expected_transfer_version, "Cosmetic transfer version changed");
        let sale_id = format!("{seller}:{operation_id}");
        require!(!listings().contains_key(&sale_id), "Sale already exists");
        listings().insert(
            &sale_id,
            &CosmeticSale {
                seller_id: seller.clone(),
                item_id: item_id.clone(),
                sku: item.sku,
                recipe_id: item.recipe_id,
                recipe_version: item.recipe_version,
                transfer_version: versions().get(&item_id).unwrap_or(0),
                price_atomic,
                expires_at_ms,
                status: "open".into(),
                buyer_id: None,
                purchase_operation_id: None,
            },
        );
        if deposit > charge {
            Promise::new(seller.clone()).transfer(NearToken::from_yoctonear(deposit - charge));
        }
        events::emit(
            "cosmetic_sale_opened",
            near_sdk::serde_json::json!({"saleId":sale_id,"itemId":item_id,"accountId":seller,"grossAtomic":price_atomic,"expiresAtMs":expires_at_ms,"storageChargeYoctoNear":U128(charge)}),
        );
        sale_id
    }

    #[payable]
    pub fn cancel_cosmetic_sale(&mut self, sale_id: String) {
        assert_one_yocto();
        let mut sale = listings().get(&sale_id).expect("Unknown sale");
        require!(
            sale.seller_id == env::predecessor_account_id(),
            "Only the seller can cancel"
        );
        if sale.status == "cancelled" {
            return;
        }
        require!(sale.status == "open", "Sale is closed");
        sale.status = "cancelled".into();
        listings().insert(&sale_id, &sale);
        events::emit(
            "cosmetic_sale_cancelled",
            near_sdk::serde_json::json!({"saleId":sale_id,"accountId":sale.seller_id}),
        );
    }
}

impl Economy {
    pub(crate) fn buy_cosmetic_sale(
        &mut self,
        buyer: AccountId,
        operation_id: String,
        sale_id: String,
        amount: U128,
    ) -> U128 {
        if !enabled() || !valid_identifier(&operation_id, 64) || sale_id.len() > 129 {
            return amount;
        }
        let key = (buyer.clone(), operation_id);
        if purchases().contains_key(&key) {
            return amount;
        }
        let Some(mut sale) = listings().get(&sale_id) else {
            return amount;
        };
        if sale.status != "open"
            || env::block_timestamp_ms() >= sale.expires_at_ms
            || buyer == sale.seller_id
            || amount != sale.price_atomic
        {
            return amount;
        }
        let Some(mut item) = self.items.get(&sale.item_id) else {
            return amount;
        };
        if item.owner_id != sale.seller_id
            || item.sku != sale.sku
            || item.recipe_id != sale.recipe_id
            || item.recipe_version != sale.recipe_version
            || versions().get(&sale.item_id).unwrap_or(0) != sale.transfer_version
        {
            return amount;
        }
        // A delivery failure panics this receipt and NEP-141 returns the entire payment.
        // No cross-contract promise or seller credit can precede delivery.
        self.transfer_crafted_item(&sale.item_id, &sale.seller_id, &buyer);
        item.owner_id = buyer.clone();
        self.items.insert(&sale.item_id, &item);
        sale.status = "sold".into();
        sale.buyer_id = Some(buyer.clone());
        sale.purchase_operation_id = Some(key.1.clone());
        listings().insert(&sale_id, &sale);
        purchases().insert(&key, &sale_id);
        let fee = orders::market_fee(amount.0);
        let net = amount.0 - fee;
        self.orders.credit(&sale.seller_id, net);
        orders::collect_market_fee(fee);
        events::emit(
            "cosmetic_sale_filled",
            near_sdk::serde_json::json!({"saleId":sale_id,"itemId":sale.item_id,"accountId":buyer,"sellerId":sale.seller_id,"grossAtomic":amount,"feeAtomic":U128(fee),"netAtomic":U128(net)}),
        );
        U128(0)
    }
}
