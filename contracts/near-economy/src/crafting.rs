use crate::inventory::Materials;
use near_sdk::{json_types::U128, near, AccountId};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Clone)]
pub struct Recipe {
    pub(crate) recipe_id: String,
    pub(crate) version: u32,
    pub(crate) sku: String,
    pub(crate) inputs: Materials,
    pub(crate) fee_atomic: U128,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct CraftedItem {
    pub(crate) item_id: String,
    pub(crate) owner_id: AccountId,
    pub(crate) sku: String,
    pub(crate) recipe_id: String,
    pub(crate) recipe_version: u32,
}
