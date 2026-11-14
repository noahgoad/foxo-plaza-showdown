use near_sdk::{collections::LookupMap, env, json_types::U128, near, AccountId};

const MARKET_FEES_KEY: &[u8] = b"orders/v1/market-fees";

pub(crate) fn market_fee(gross: u128) -> u128 {
    // floor(gross * 250 / 10000), without a multiplication overflow.
    gross / 40
}

pub(crate) fn market_fees() -> u128 {
    env::storage_read(MARKET_FEES_KEY)
        .map(|bytes| u128::from_le_bytes(bytes.try_into().expect("Invalid market fee ledger")))
        .unwrap_or(0)
}

pub(crate) fn collect_market_fee(fee: u128) {
    let total = market_fees()
        .checked_add(fee)
        .expect("Market fee balance overflow");
    env::storage_write(MARKET_FEES_KEY, &total.to_le_bytes());
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct PurchaseOrder {
    pub(crate) buyer_id: AccountId,
    pub(crate) recipe_id: String,
    pub(crate) recipe_version: u32,
    pub(crate) unit_price: U128,
    pub(crate) remaining: u32,
    pub(crate) expires_at_ms: u64,
    pub(crate) closed: bool,
}

#[near(serializers = [borsh])]
pub(crate) struct OrderPayout {
    pub(crate) account_id: AccountId,
    pub(crate) amount: u128,
}

#[near(serializers = [borsh])]
pub(crate) struct Orders {
    pub(crate) enabled: bool,
    pub(crate) orders: LookupMap<String, PurchaseOrder>,
    pub(crate) credits: LookupMap<AccountId, u128>,
    pub(crate) payouts: LookupMap<u64, OrderPayout>,
    pub(crate) next_payout: u64,
    pub(crate) escrow: u128,
    pub(crate) payable: u128,
    pub(crate) in_flight: u128,
}

impl Default for Orders {
    fn default() -> Self {
        Self {
            enabled: false,
            orders: LookupMap::new(b"O"),
            credits: LookupMap::new(b"C"),
            payouts: LookupMap::new(b"P"),
            next_payout: 0,
            escrow: 0,
            payable: 0,
            in_flight: 0,
        }
    }
}

impl Orders {
    pub(crate) fn credit(&mut self, account: &AccountId, amount: u128) {
        let balance = self.credits.get(account).unwrap_or(0);
        self.credits.insert(
            account,
            &balance.checked_add(amount).expect("Order balance overflow"),
        );
        self.payable = self
            .payable
            .checked_add(amount)
            .expect("Order payable overflow");
    }
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct OrderLedger {
    pub(crate) escrow: U128,
    pub(crate) payable: U128,
    pub(crate) in_flight: U128,
    pub(crate) market_fees: U128,
}
