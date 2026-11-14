//! NEP-245 adapter over the authoritative material inventory and crafted items.
//! Spec source https://github.com/near/NEPs/blob/master/neps/nep-0245.md
use crate::{inventory::Materials, Economy, EconomyExt};
use near_sdk::{
    assert_one_yocto,
    collections::LookupMap,
    env, ext_contract,
    json_types::U128,
    near, require,
    serde_json::{json, Value},
    AccountId, Gas, NearToken, Promise, PromiseResult,
};

const TOKENS: [&str; 3] = ["alloy", "core", "catalyst"];
const STATE_KEY: &[u8] = b"mt/v1/state";
const REGISTRATION_BYTES: u128 = 1024;
const ITEM_BYTES: u128 = 1024;

#[near(serializers = [borsh])]
struct MtState {
    finalized: bool,
    enabled: bool,
    manifest_hash: String,
    accounts: u64,
    supply: [u128; 3],
    next_call: u64,
    items: u64,
}

#[near(serializers = [borsh])]
struct Registration {
    total: u128,
    used: u128,
    pending: u32,
    refund_capacity: [u32; 3],
    inventory_created: bool,
}

#[near(serializers = [borsh])]
struct TransferCall {
    sender_id: AccountId,
    receiver_id: AccountId,
    token_ids: Vec<String>,
    amounts: Vec<U128>,
    storage_cost: u128,
}

#[near(serializers = [json])]
pub struct StorageBalance {
    total: U128,
    available: U128,
}

#[near(serializers = [json])]
pub struct StorageBalanceBounds {
    min: U128,
    max: Option<U128>,
}

#[allow(dead_code)]
#[ext_contract(ext_mt_receiver)]
trait Receiver {
    fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128>;
}

#[allow(dead_code)]
#[ext_contract(ext_mt_self)]
trait Resolver {
    fn mt_resolve_transfer(&mut self, call_id: u64) -> Vec<U128>;
}

fn registrations() -> LookupMap<AccountId, Registration> {
    LookupMap::new(b"mt/v1/registration".to_vec())
}

fn migrated() -> LookupMap<AccountId, Materials> {
    LookupMap::new(b"mt/v1/migrated".to_vec())
}

fn calls() -> LookupMap<u64, TransferCall> {
    LookupMap::new(b"mt/v1/call".to_vec())
}

fn included_items() -> LookupMap<String, bool> {
    LookupMap::new(b"mt/v1/included-item".to_vec())
}

fn item_storage_owners() -> LookupMap<String, AccountId> {
    LookupMap::new(b"mt/v1/item-storage".to_vec())
}

fn item_id(token_id: &str) -> Option<&str> {
    token_id.strip_prefix("item:").filter(|id| !id.is_empty())
}

fn item_storage_cost() -> u128 {
    ITEM_BYTES * env::storage_byte_cost().as_yoctonear()
}

fn read_state() -> Option<MtState> {
    env::storage_read(STATE_KEY)
        .map(|bytes| near_sdk::borsh::from_slice(&bytes).expect("Invalid MT state"))
}

fn write_state(state: &MtState) {
    env::storage_write(
        STATE_KEY,
        &near_sdk::borsh::to_vec(state).expect("Cannot encode MT state"),
    );
}

fn storage_min() -> u128 {
    env::storage_byte_cost().as_yoctonear() * REGISTRATION_BYTES
}

fn storage_view(registration: &Registration) -> StorageBalance {
    StorageBalance {
        total: U128(registration.total),
        available: U128(registration.total - registration.used),
    }
}

fn token_index(token_id: &str) -> Option<usize> {
    TOKENS.iter().position(|id| *id == token_id)
}

fn validate_batch(token_ids: &[String], amounts: &[U128]) {
    require!(
        !token_ids.is_empty()
            && token_ids.len() <= 16
            && token_ids.len() == amounts.len(),
        "Invalid MT batch"
    );
    for (i, token_id) in token_ids.iter().enumerate() {
        require!(
            (token_index(token_id).is_some() || item_id(token_id).is_some()) && !token_ids[..i].contains(token_id),
            "Unknown or duplicate MT token"
        );
        require!(
            amounts[i].0 > 0 && amounts[i].0 <= u128::from(u32::MAX)
                && (item_id(token_id).is_none() || amounts[i].0 == 1),
            "Invalid material amount"
        );
    }
}

fn reject_approvals(approvals: Option<Vec<Option<(AccountId, u64)>>>, len: usize) {
    if let Some(approvals) = approvals {
        require!(
            approvals.len() == len && approvals.iter().all(Option::is_none),
            "MT approvals unsupported"
        );
    }
}

fn emit(event: &str, data: Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        json!({
            "standard": "nep245", "version": "1.0.0", "event": event, "data": [data]
        })
    ));
}

fn material_event(event: &str, owner: &AccountId, materials: Materials) {
    let pairs: Vec<_> = TOKENS
        .iter()
        .filter_map(|id| {
            let amount = materials.token_amount(id).unwrap();
            (amount > 0).then_some((id.to_string(), U128(amount)))
        })
        .collect();
    if !pairs.is_empty() {
        emit(
            event,
            json!({"owner_id":owner, "token_ids":pairs.iter().map(|p| &p.0).collect::<Vec<_>>(),
            "amounts":pairs.iter().map(|p| p.1).collect::<Vec<_>>()}),
        );
    }
}

pub(crate) fn legacy_writes_allowed() -> bool {
    read_state().is_none_or(|state| state.finalized)
}

pub(crate) fn record_material_change(owner: &AccountId, materials: Materials, mint: bool) {
    if let Some(mut state) = read_state() {
        require!(state.finalized, "MT migration freezes material writes");
        for (i, token_id) in TOKENS.iter().enumerate() {
            let amount = materials.token_amount(token_id).unwrap();
            state.supply[i] = if mint {
                state.supply[i]
                    .checked_add(amount)
                    .expect("MT supply overflow")
            } else {
                state.supply[i]
                    .checked_sub(amount)
                    .expect("MT supply underflow")
            };
        }
        write_state(&state);
        if !migrated().contains_key(owner) {
            migrated().insert(owner, &Materials::default());
        }
        material_event(if mint { "mt_mint" } else { "mt_burn" }, owner, materials);
    }
}

pub(crate) fn assert_inventory_included(
    owner: &AccountId,
    available: Materials,
    reserved: Materials,
) {
    if read_state().is_some_and(|state| state.finalized)
        && !migrated().contains_key(owner)
        && !registrations().contains_key(owner)
    {
        require!(
            available == Materials::default() && reserved == Materials::default(),
            "Legacy MT inventory missing from finalized manifest"
        );
    }
}

pub(crate) fn assert_refund_capacity(owner: &AccountId, available: Materials) {
    if let Some(registration) = registrations().get(owner) {
        for (i, id) in TOKENS.iter().enumerate() {
            require!(
                available.token_amount(id).unwrap() + u128::from(registration.refund_capacity[i])
                    <= u128::from(u32::MAX),
                "Material refund capacity reserved"
            );
        }
    }
}

pub(crate) fn cosmetic_transfer(item: &str, seller: &AccountId, buyer: &AccountId) {
    if let Some(state) = read_state() {
        require!(state.finalized, "MT migration freezes item transfers");
        require!(included_items().contains_key(&item.to_string()), "Cosmetic missing from MT manifest");
        let mut recipient = registrations().get(buyer).expect("Cosmetic recipient must register MT storage");
        recipient.used = recipient.used.checked_add(item_storage_cost()).expect("MT item storage overflow");
        require!(recipient.used <= recipient.total, "Insufficient cosmetic storage deposit");
        registrations().insert(buyer, &recipient);
        if let Some(previous) = item_storage_owners().get(&item.to_string()) {
            require!(&previous == seller, "Cosmetic storage owner mismatch");
            let mut source = registrations().get(seller).expect("Cosmetic sender must register MT storage");
            source.used -= item_storage_cost();
            registrations().insert(seller, &source);
        }
        item_storage_owners().insert(&item.to_string(), buyer);
        emit("mt_transfer", json!({"old_owner_id":seller,"new_owner_id":buyer,
            "token_ids":[format!("item:{item}")],"amounts":["1"]}));
    }
}

pub(crate) fn record_cosmetic_mint(owner: &AccountId, item: &str) {
    if let Some(mut state) = read_state() {
        require!(state.finalized, "MT migration freezes crafting");
        let mut registration = registrations().get(owner).expect("Register cosmetic storage before crafting");
        registration.used = registration.used.checked_add(item_storage_cost()).expect("Cosmetic storage overflow");
        require!(registration.used <= registration.total, "Insufficient cosmetic storage deposit");
        registrations().insert(owner, &registration);
        item_storage_owners().insert(&item.to_string(), owner);
        state.items = state.items.checked_add(1).expect("MT item count overflow");
        included_items().insert(&item.to_string(), &true);
        write_state(&state);
        emit("mt_mint",json!({"owner_id":owner,"token_ids":[format!("item:{item}")],"amounts":["1"]}));
    }
}

impl Economy {
    fn mt_move(
        &mut self,
        sender: &AccountId,
        receiver: &AccountId,
        token_ids: &[String],
        amounts: &[U128],
        memo: Option<String>,
    ) {
        require!(sender != receiver, "MT receiver must differ from sender");
        require!(
            registrations().contains_key(sender) && registrations().contains_key(receiver),
            "MT account is not registered"
        );
        validate_batch(token_ids, amounts);
        let mut source = self.get_inventory(sender.clone());
        let mut destination = self.get_inventory(receiver.clone());
        assert_inventory_included(sender, source.available, source.reserved);
        assert_inventory_included(receiver, destination.available, destination.reserved);
        for (token_id, amount) in token_ids.iter().zip(amounts) {
            if let Some(id) = item_id(token_id) {
                require!(included_items().contains_key(&id.to_string()), "Cosmetic missing from MT manifest");
                let mut item = self.items.get(&id.to_string()).expect("Unknown MT cosmetic");
                require!(&item.owner_id == sender, "Only cosmetic owner can transfer");
                self.transfer_crafted_item(&id.to_string(), sender, receiver);
                item.owner_id = receiver.clone();
                self.items.insert(&id.to_string(), &item);
                continue;
            }
            let remaining = source
                .available
                .token_amount(token_id)
                .unwrap()
                .checked_sub(amount.0)
                .expect("Insufficient MT balance");
            let received = destination
                .available
                .token_amount(token_id)
                .unwrap()
                .checked_add(amount.0)
                .expect("MT balance overflow");
            require!(
                source.available.set_token_amount(token_id, remaining)
                    && destination.available.set_token_amount(token_id, received),
                "Material balance capacity exceeded"
            );
        }
        assert_refund_capacity(receiver, destination.available);
        self.inventories.insert(sender, &source);
        self.inventories.insert(receiver, &destination);
        let materials: Vec<_> = token_ids.iter().zip(amounts).filter(|(id,_)|token_index(id).is_some()).collect();
        if !materials.is_empty() {
            emit("mt_transfer", json!({"old_owner_id":sender,"new_owner_id":receiver,
                "token_ids":materials.iter().map(|p|p.0).collect::<Vec<_>>(),
                "amounts":materials.iter().map(|p|p.1).collect::<Vec<_>>(),"memo":memo}));
        }
    }

    fn mt_assert_enabled(&self) {
        require!(
            read_state().is_some_and(|state| state.finalized && state.enabled),
            "MT transfers disabled"
        );
    }
}

#[near]
impl Economy {
    pub fn begin_mt_migration(&mut self, manifest_hash: String) {
        self.assert_owner();
        require!(
            crate::settlement::valid_hash(&manifest_hash),
            "Invalid MT manifest hash"
        );
        require!(
            !self.crafting_enabled && !self.orders.enabled,
            "Pause crafting and orders before MT migration"
        );
        require!(read_state().is_none(), "MT migration already initialized");
        write_state(&MtState {
            finalized: false,
            enabled: false,
            manifest_hash,
            accounts: 0,
            supply: [0; 3],
            next_call: 0,
            items: 0,
        });
    }

    pub fn import_mt_account(
        &mut self,
        account_id: AccountId,
        expected_available: Materials,
        expected_reserved: Materials,
        expected_consumed: Materials,
        expected_item_ids: Option<Vec<String>>,
    ) -> bool {
        self.assert_owner();
        let mut state = read_state().expect("MT migration not initialized");
        require!(!state.finalized, "MT migration finalized");
        let inventory = self.get_inventory(account_id.clone());
        require!(
            inventory.available == expected_available
                && inventory.reserved == expected_reserved
                && inventory.consumed == expected_consumed,
            "MT inventory snapshot mismatch"
        );
        let mut expected_items = expected_item_ids.unwrap_or_default();
        let count = self.owned_item_count.get(&account_id).unwrap_or(0);
        require!(expected_items.len() == count as usize, "Cosmetic snapshot count mismatch");
        expected_items.sort();
        require!(expected_items.windows(2).all(|pair|pair[0] != pair[1]), "Duplicate cosmetic snapshot");
        let mut actual_items: Vec<String> = (0..count).map(|index|
            self.owned_item_ids.get(&(account_id.clone(),index)).expect("Missing cosmetic index")).collect();
        actual_items.sort();
        require!(actual_items == expected_items, "Cosmetic snapshot mismatch");
        for id in &expected_items {
            require!(self.items.get(id).is_some_and(|item|item.owner_id == account_id), "Cosmetic snapshot owner mismatch");
        }
        if let Some(previous) = migrated().get(&account_id) {
            require!(
                previous == expected_available,
                "Conflicting MT account import"
            );
            return false;
        }
        for (i, token_id) in TOKENS.iter().enumerate() {
            let held = expected_available.token_amount(token_id).unwrap()
                + expected_reserved.token_amount(token_id).unwrap();
            state.supply[i] = state.supply[i]
                .checked_add(held)
                .expect("MT supply overflow");
        }
        state.accounts = state
            .accounts
            .checked_add(1)
            .expect("MT account count overflow");
        state.items = state.items.checked_add(u64::from(count)).expect("MT item count overflow");
        for id in expected_items {
            require!(!included_items().contains_key(&id), "Cosmetic already imported");
            included_items().insert(&id,&true);
        }
        migrated().insert(&account_id, &expected_available);
        write_state(&state);
        true
    }

    pub fn finalize_mt_migration(
        &mut self,
        manifest_hash: String,
        expected_accounts: u64,
        expected_supply: Vec<U128>,
        expected_items: Option<u64>,
    ) {
        self.assert_owner();
        let mut state = read_state().expect("MT migration not initialized");
        require!(
            state.manifest_hash == manifest_hash
                && state.accounts == expected_accounts
                && state.items == expected_items.unwrap_or(0)
                && expected_supply == state.supply.map(U128).to_vec(),
            "MT migration totals mismatch"
        );
        state.finalized = true;
        write_state(&state);
    }

    pub fn set_mt_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        let mut state = read_state().expect("MT migration not initialized");
        require!(state.finalized, "Finalize MT migration first");
        state.enabled = enabled;
        write_state(&state);
    }

    pub fn get_mt_migration(&self) -> Value {
        read_state()
            .map(|state| {
                json!({"manifestHash":state.manifest_hash,"accounts":state.accounts,
            "supply":state.supply.map(U128),"items":state.items,"finalized":state.finalized,"enabled":state.enabled})
            })
            .unwrap_or(Value::Null)
    }

    pub fn mt_token(&self, token_ids: Vec<String>) -> Vec<Option<Value>> {
        token_ids
            .into_iter()
            .map(|token_id| {
                if let Some(id) = item_id(&token_id) {
                    return self.items.get(&id.to_string()).filter(|_|included_items().contains_key(&id.to_string()))
                        .map(|item|json!({"token_id":token_id,"owner_id":item.owner_id,"base_metadata_id":format!("cosmetic:{}",item.sku)}));
                }
                token_index(&token_id).map(
                    |_| json!({"token_id":token_id,"owner_id":null,"base_metadata_id":token_id}),
                )
            })
            .collect()
    }

    pub fn mt_balance_of(&self, account_id: AccountId, token_id: String) -> U128 {
        if let Some(id) = item_id(&token_id) {
            return U128(u128::from(included_items().contains_key(&id.to_string()) &&
                self.items.get(&id.to_string()).is_some_and(|item|item.owner_id==account_id)));
        }
        U128(
            self.get_inventory(account_id)
                .available
                .token_amount(&token_id)
                .unwrap_or(0),
        )
    }

    pub fn mt_batch_balance_of(&self, account_id: AccountId, token_ids: Vec<String>) -> Vec<U128> {
        token_ids
            .into_iter()
            .map(|token_id| self.mt_balance_of(account_id.clone(), token_id))
            .collect()
    }

    pub fn mt_supply(&self, token_id: String) -> Option<U128> {
        if let Some(id) = item_id(&token_id) {
            return included_items().contains_key(&id.to_string()).then_some(U128(1));
        }
        let index = token_index(&token_id)?;
        read_state()
            .filter(|state| state.finalized)
            .map(|state| U128(state.supply[index]))
    }

    pub fn mt_batch_supply(&self, token_ids: Vec<String>) -> Vec<Option<U128>> {
        token_ids.into_iter().map(|id| self.mt_supply(id)).collect()
    }

    pub fn mt_metadata_contract(&self) -> Value {
        json!({"spec":"mt-1.0.0","name":"Fox Materials"})
    }

    pub fn mt_metadata_base_by_metadata_id(&self, base_metadata_ids: Vec<String>) -> Vec<Value> {
        base_metadata_ids.iter().map(|id| {
            if let Some(sku)=id.strip_prefix("cosmetic:") {
                require!(!sku.is_empty() && sku.len()<=64,"Invalid cosmetic metadata");
                return json!({"id":id,"name":sku,"symbol":null,"icon":null,"decimals":"0","base_uri":null,
                    "reference":null,"copies":null,"reference_hash":null});
            }
            require!(token_index(id).is_some(),"Unknown MT metadata");
            json!({"id":id,"name":match id.as_str() {"alloy"=>"Alloy","core"=>"Core",_=>"Catalyst"},
                "symbol":id.to_uppercase(),"icon":null,"decimals":"0","base_uri":null,
                "reference":null,"copies":null,"reference_hash":null})
        }).collect()
    }

    pub fn mt_metadata_base_by_token_id(&self, token_ids: Vec<String>) -> Vec<Value> {
        let ids=token_ids.into_iter().map(|token| {
            if let Some(id)=item_id(&token) {
                require!(included_items().contains_key(&id.to_string()),"Unknown MT cosmetic");
                let item=self.items.get(&id.to_string()).expect("Unknown MT cosmetic");
                format!("cosmetic:{}",item.sku)
            } else {token}
        }).collect();
        self.mt_metadata_base_by_metadata_id(ids)
    }

    pub fn mt_metadata_token_by_token_id(&self, token_ids: Vec<String>) -> Vec<Value> {
        token_ids.iter().map(|id| {
            require!(token_index(id).is_some() || item_id(id).is_some_and(|item|included_items().contains_key(&item.to_string())),"Unknown MT token");
            json!({"title":null,"description":null,"media":null,"media_hash":null,"issued_at":null,
                "expires_at":null,"starts_at":null,"updated_at":null,"extra":null,"reference":null,"reference_hash":null})
        }).collect()
    }

    pub fn mt_metadata_token_all(&self, token_ids: Vec<String>) -> Vec<Value> {
        self.mt_metadata_base_by_token_id(token_ids.clone())
            .into_iter()
            .zip(self.mt_metadata_token_by_token_id(token_ids))
            .map(|(base, token)| json!({"base":base,"token":token}))
            .collect()
    }

    #[payable]
    pub fn mt_transfer(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
    ) {
        self.mt_batch_transfer(
            receiver_id,
            vec![token_id],
            vec![amount],
            Some(vec![approval]),
            memo,
        );
    }

    #[payable]
    pub fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    ) {
        assert_one_yocto();
        self.mt_assert_enabled();
        reject_approvals(approvals, token_ids.len());
        self.mt_move(
            &env::predecessor_account_id(),
            &receiver_id,
            &token_ids,
            &amounts,
            memo,
        );
    }

    #[payable]
    pub fn mt_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_id: String,
        amount: U128,
        approval: Option<(AccountId, u64)>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        self.mt_batch_transfer_call(
            receiver_id,
            vec![token_id],
            vec![amount],
            Some(vec![approval]),
            memo,
            msg,
        )
    }

    #[payable]
    pub fn mt_batch_transfer_call(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
        msg: String,
    ) -> Promise {
        let cosmetic_count=token_ids.iter().filter(|id|item_id(id).is_some()).count();
        require!(cosmetic_count==0 || (cosmetic_count==1 && token_ids.len()==1),"Cosmetic callbacks accept one item per call");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(90),
            "MT transfer_call needs 90 Tgas"
        );
        require!(msg.len() <= 4096, "MT receiver message too large");
        let sender_id = env::predecessor_account_id();
        self.mt_batch_transfer(
            receiver_id.clone(),
            token_ids.clone(),
            amounts.clone(),
            approvals,
            memo,
        );
        let mut state = read_state().unwrap();
        let call_id = state.next_call;
        state.next_call = state
            .next_call
            .checked_add(1)
            .expect("MT call counter exhausted");
        write_state(&state);
        let mut sender = registrations().get(&sender_id).unwrap();
        let mut receiver = registrations().get(&receiver_id).unwrap();
        sender.pending = sender
            .pending
            .checked_add(1)
            .expect("MT pending count overflow");
        receiver.pending = receiver
            .pending
            .checked_add(1)
            .expect("MT pending count overflow");
        for (id, amount) in token_ids.iter().zip(&amounts) {
            if let Some(index) = token_index(id) {
                sender.refund_capacity[index] = sender.refund_capacity[index]
                    .checked_add(amount.0 as u32)
                    .expect("MT refund capacity overflow");
            } else {
                // Keep enough sender storage locked to receive this item back even
                // if the sender withdraws every unreserved storage yocto meanwhile.
                sender.used = sender.used.checked_add(item_storage_cost()).expect("Cosmetic refund storage overflow");
            }
        }
        let before = env::storage_usage();
        let mut call = TransferCall {
            sender_id: sender_id.clone(),
            receiver_id: receiver_id.clone(),
            token_ids: token_ids.clone(),
            amounts: amounts.clone(),
            storage_cost: 0,
        };
        calls().insert(&call_id, &call);
        call.storage_cost =
            u128::from(env::storage_usage() - before) * env::storage_byte_cost().as_yoctonear();
        sender.used = sender
            .used
            .checked_add(call.storage_cost)
            .expect("MT storage overflow");
        require!(
            sender.used <= sender.total,
            "Insufficient MT call storage deposit"
        );
        calls().insert(&call_id, &call);
        registrations().insert(&sender_id, &sender);
        registrations().insert(&receiver_id, &receiver);
        ext_mt_receiver::ext(receiver_id)
            .with_static_gas(Gas::from_tgas(35))
            .mt_on_transfer(
                sender_id.clone(),
                vec![sender_id; token_ids.len()],
                token_ids,
                amounts,
                msg,
            )
            .then(
                ext_mt_self::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(35))
                    .mt_resolve_transfer(call_id),
            )
    }

    #[private]
    pub fn mt_resolve_transfer(&mut self, call_id: u64) -> Vec<U128> {
        require!(
            env::promise_results_count() == 1,
            "Expected MT receiver receipt"
        );
        let call = calls()
            .remove(&call_id)
            .expect("Unknown or resolved MT call");
        let mut sender = registrations().get(&call.sender_id).unwrap();
        for (id, amount) in call.token_ids.iter().zip(&call.amounts) {
            if let Some(index) = token_index(id) {
                sender.refund_capacity[index] -= amount.0 as u32;
            } else {
                sender.used -= item_storage_cost();
            }
        }
        registrations().insert(&call.sender_id, &sender);
        let requested = match env::promise_result(0) {
            PromiseResult::Successful(bytes) => {
                near_sdk::serde_json::from_slice::<Vec<U128>>(&bytes)
                    .ok()
                    .filter(|amounts| amounts.len() == call.amounts.len())
                    .unwrap_or_else(|| call.amounts.clone())
            }
            PromiseResult::Failed => call.amounts.clone(),
        };
        let mut spent = Vec::new();
        for ((token_id, sent), unused) in call.token_ids.iter().zip(&call.amounts).zip(requested) {
            let refundable = self
                .mt_balance_of(call.receiver_id.clone(), token_id.clone())
                .0
                .min(sent.0)
                .min(unused.0);
            let refund = refundable;
            if refund > 0 {
                self.mt_move(
                    &call.receiver_id,
                    &call.sender_id,
                    &[token_id.clone()],
                    &[U128(refund)],
                    Some("MT refund".into()),
                );
            }
            spent.push(U128(sent.0 - refund));
        }
        let mut sender = registrations().get(&call.sender_id).unwrap();
        let mut receiver = registrations().get(&call.receiver_id).unwrap();
        sender.pending -= 1;
        receiver.pending -= 1;
        sender.used -= call.storage_cost;
        registrations().insert(&call.sender_id, &sender);
        registrations().insert(&call.receiver_id, &receiver);
        spent
    }

    pub fn storage_balance_bounds(&self) -> StorageBalanceBounds {
        StorageBalanceBounds {
            min: U128(storage_min()),
            max: None,
        }
    }

    pub fn storage_balance_of(&self, account_id: AccountId) -> Option<StorageBalance> {
        registrations().get(&account_id).as_ref().map(storage_view)
    }

    #[payable]
    pub fn storage_deposit(
        &mut self,
        account_id: Option<AccountId>,
        registration_only: Option<bool>,
    ) -> StorageBalance {
        require!(
            read_state().is_some_and(|state| state.finalized),
            "Finalize MT migration before registration"
        );
        let account = account_id.unwrap_or_else(env::predecessor_account_id);
        let inventory = self.get_inventory(account.clone());
        assert_inventory_included(&account, inventory.available, inventory.reserved);
        let deposit = env::attached_deposit().as_yoctonear();
        let previous = registrations().get(&account);
        let existed = previous.is_some();
        let mut registration = previous.unwrap_or(Registration {
            total: 0,
            used: storage_min(),
            pending: 0,
            refund_capacity: [0; 3],
            inventory_created: !self.inventories.contains_key(&account),
        });
        let accepted = if registration_only.unwrap_or(false) {
            if existed {
                0
            } else {
                storage_min()
            }
        } else {
            deposit
        };
        require!(deposit >= accepted, "Insufficient MT registration deposit");
        registration.total = registration
            .total
            .checked_add(accepted)
            .expect("MT deposit overflow");
        require!(
            registration.total >= registration.used,
            "Insufficient MT registration deposit"
        );
        let before = env::storage_usage();
        registrations().insert(&account, &registration);
        if !self.inventories.contains_key(&account) {
            self.inventories.insert(&account, &Default::default());
        }
        require!(
            u128::from(env::storage_usage() - before) * env::storage_byte_cost().as_yoctonear()
                <= storage_min(),
            "MT registration exceeds quoted minimum"
        );
        if deposit > accepted {
            Promise::new(env::predecessor_account_id())
                .transfer(NearToken::from_yoctonear(deposit - accepted));
        }
        storage_view(&registration)
    }

    #[payable]
    pub fn storage_withdraw(&mut self, amount: Option<U128>) -> StorageBalance {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let mut registration = registrations()
            .get(&account)
            .expect("MT account is not registered");
        let amount = amount
            .map(|value| value.0)
            .unwrap_or(registration.total - registration.used);
        require!(
            amount <= registration.total - registration.used,
            "MT withdrawal exceeds available storage"
        );
        registration.total -= amount;
        registrations().insert(&account, &registration);
        if amount > 0 {
            Promise::new(account).transfer(NearToken::from_yoctonear(amount));
        }
        storage_view(&registration)
    }

    #[payable]
    pub fn storage_unregister(&mut self, force: Option<bool>) -> bool {
        assert_one_yocto();
        let account = env::predecessor_account_id();
        let Some(registration) = registrations().get(&account) else {
            return false;
        };
        require!(
            !force.unwrap_or(false),
            "Forced MT unregistration unsupported"
        );
        let inventory = self.get_inventory(account.clone());
        require!(
            registration.pending == 0
                && self.owned_item_count.get(&account).unwrap_or(0) == 0
                && inventory.available == Materials::default()
                && inventory.reserved == Materials::default(),
            "MT balances or callbacks outstanding"
        );
        if registration.inventory_created {
            require!(
                inventory.consumed == Materials::default()
                    && inventory.granted_today == Materials::default(),
                "Legacy inventory history must retain storage"
            );
            self.inventories.remove(&account);
        }
        registrations().remove(&account);
        // Preserve legacy quota/consumption history and idempotency records.
        Promise::new(account).transfer(NearToken::from_yoctonear(registration.total + 1));
        true
    }
}
