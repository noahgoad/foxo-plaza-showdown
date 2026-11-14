use crate::record::{self, CareerRecord, CareerSource};
use near_sdk::{
    collections::LookupMap, env, near, require, AccountId, NearToken, PanicOnDefault, Promise,
};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Default, Clone)]
pub struct CareerSummary {
    pub revision: u64,
    pub matches: u64,
    pub wins: u64,
    pub boss_wins: u64,
    pub xp: u64,
}

impl CareerSummary {
    fn remove(&mut self, record: &CareerRecord) {
        self.matches = self
            .matches
            .checked_sub(1)
            .expect("Invalid career match total");
        self.wins = self
            .wins
            .checked_sub(u64::from(record.won))
            .expect("Invalid career win total");
        self.boss_wins = self
            .boss_wins
            .checked_sub(u64::from(record.won && record.mode == "boss"))
            .expect("Invalid Boss win total");
        self.xp = self
            .xp
            .checked_sub(u64::from(record.xp))
            .expect("Invalid career XP total");
    }

    fn append(&mut self, record: &CareerRecord) {
        self.revision = self
            .revision
            .checked_add(1)
            .expect("Career revision exhausted");
        self.matches = self
            .matches
            .checked_add(1)
            .expect("Career match total overflow");
        self.wins = self
            .wins
            .checked_add(u64::from(record.won))
            .expect("Career win total overflow");
        self.boss_wins = self
            .boss_wins
            .checked_add(u64::from(record.won && record.mode == "boss"))
            .expect("Boss win total overflow");
        self.xp = self
            .xp
            .checked_add(u64::from(record.xp))
            .expect("Career XP total overflow");
    }
}

#[near(serializers = [borsh])]
struct StoredRecord {
    record: CareerRecord,
    fingerprint: [u8; 32],
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct PassportConfig {
    pub owner_id: AccountId,
    pub collection_id: AccountId,
    pub network: String,
    pub career_signer_id: AccountId,
    pub append_enabled: bool,
}

#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Passport {
    owner_id: AccountId,
    collection_id: AccountId,
    network: String,
    career_signer_id: AccountId,
    append_enabled: bool,
    records: LookupMap<String, StoredRecord>,
    sources: LookupMap<(CareerSource, String), [u8; 32]>,
    matches: LookupMap<(AccountId, String, AccountId, String), String>,
    summaries: LookupMap<(AccountId, String), CareerSummary>,
    history: LookupMap<(AccountId, String, u64), String>,
    corrected_by: LookupMap<String, String>,
}

#[near]
impl Passport {
    #[init]
    pub fn new(
        owner_id: AccountId,
        collection_id: AccountId,
        network: String,
        career_signer_id: AccountId,
    ) -> Self {
        let caller = env::predecessor_account_id();
        let contract = env::current_account_id();
        let parent = contract.as_str().split_once('.').map(|(_, value)| value);
        require!(
            caller == contract
                || (caller == owner_id
                    && env::signer_account_id() == owner_id
                    && parent == Some(owner_id.as_str())),
            "Only this account or its parent operator can initialize"
        );
        require!(record::identifier(&network, 32), "Invalid network");
        Self {
            owner_id,
            collection_id,
            network,
            career_signer_id,
            append_enabled: false,
            records: LookupMap::new(b"r"),
            sources: LookupMap::new(b"s"),
            matches: LookupMap::new(b"m"),
            summaries: LookupMap::new(b"c"),
            history: LookupMap::new(b"h"),
            corrected_by: LookupMap::new(b"x"),
        }
    }

    pub fn get_config(&self) -> PassportConfig {
        PassportConfig {
            owner_id: self.owner_id.clone(),
            collection_id: self.collection_id.clone(),
            network: self.network.clone(),
            career_signer_id: self.career_signer_id.clone(),
            append_enabled: self.append_enabled,
        }
    }

    pub fn set_append_enabled(&mut self, enabled: bool) {
        self.assert_owner();
        self.append_enabled = enabled;
    }

    pub fn set_career_signer(&mut self, career_signer_id: AccountId) {
        self.assert_owner();
        self.career_signer_id = career_signer_id;
    }

    pub fn get_record(&self, event_id: String) -> Option<CareerRecord> {
        self.records.get(&event_id).map(|entry| entry.record)
    }

    pub fn get_correction(&self, event_id: String) -> Option<String> {
        self.corrected_by.get(&event_id)
    }

    pub fn get_career(&self, collection_id: AccountId, token_id: String) -> CareerSummary {
        self.summaries
            .get(&(collection_id, token_id))
            .unwrap_or_default()
    }

    pub fn get_history(
        &self,
        collection_id: AccountId,
        token_id: String,
        offset: u64,
        limit: u32,
    ) -> Vec<CareerRecord> {
        let career = self.get_career(collection_id.clone(), token_id.clone());
        let end = offset
            .saturating_add(u64::from(limit.min(50)))
            .min(career.revision);
        (offset..end)
            .filter_map(|index| {
                self.history
                    .get(&(collection_id.clone(), token_id.clone(), index))
            })
            .filter_map(|event_id| self.get_record(event_id))
            .collect()
    }

    #[payable]
    pub fn append_career(&mut self, record: CareerRecord) -> bool {
        require!(
            env::predecessor_account_id() == self.career_signer_id
                && env::signer_account_id() == self.career_signer_id,
            "Unauthorized career signer"
        );
        record
            .validate(
                &self.network,
                &env::current_account_id(),
                &self.collection_id,
            )
            .unwrap_or_else(|message| env::panic_str(message));
        require!(
            record.finished_at_ms <= env::block_timestamp_ms(),
            "Career result is in the future"
        );
        let fingerprint = env::sha256_array(
            &near_sdk::borsh::to_vec(&record).expect("Cannot encode career record"),
        );
        if let Some(existing) = self.records.get(&record.event_id) {
            require!(
                existing.fingerprint == fingerprint,
                "Conflicting career event ID"
            );
            Self::refund(env::attached_deposit().as_yoctonear());
            return false;
        }
        require!(self.append_enabled, "Career append is paused");
        let source_key = (record.source, record.source_id.clone());
        require!(
            !self.sources.contains_key(&source_key),
            "Career source ID already recorded"
        );
        let match_key = (
            record.collection_id.clone(),
            record.token_id.clone(),
            record.actor_id.clone(),
            record.match_id.clone(),
        );
        let token_key = (record.collection_id.clone(), record.token_id.clone());
        let mut summary = self.get_career(record.collection_id.clone(), record.token_id.clone());
        if record.source == CareerSource::Correction {
            let target_id = record
                .corrects_event_id
                .as_ref()
                .expect("Missing correction target");
            let target = self
                .get_record(target_id.clone())
                .expect("Unknown correction target");
            require!(
                target.collection_id == record.collection_id
                    && target.token_id == record.token_id
                    && target.actor_id == record.actor_id
                    && target.match_id == record.match_id,
                "Correction identity mismatch"
            );
            require!(
                !self.corrected_by.contains_key(target_id),
                "Career record already corrected"
            );
            require!(
                self.matches.get(&match_key).as_ref() == Some(target_id),
                "Correction must link latest match record"
            );
            summary.remove(&target);
        } else {
            require!(
                !self.matches.contains_key(&match_key),
                "Career match already recorded"
            );
        }
        let storage_before = env::storage_usage();
        let sequence = summary.revision;
        summary.append(&record);
        self.summaries.insert(&token_key, &summary);
        self.history.insert(
            &(
                record.collection_id.clone(),
                record.token_id.clone(),
                sequence,
            ),
            &record.event_id,
        );
        self.matches.insert(&match_key, &record.event_id);
        self.sources.insert(&source_key, &fingerprint);
        if let Some(target) = &record.corrects_event_id {
            self.corrected_by.insert(target, &record.event_id);
        }
        self.records.insert(
            &record.event_id,
            &StoredRecord {
                fingerprint,
                record: record.clone(),
            },
        );
        let storage_cost = u128::from(
            env::storage_usage()
                .checked_sub(storage_before)
                .expect("Unexpected storage shrink"),
        )
        .checked_mul(env::storage_byte_cost().as_yoctonear())
        .expect("Storage cost overflow");
        let attached = env::attached_deposit().as_yoctonear();
        require!(
            attached >= storage_cost,
            "Career append storage deposit is insufficient"
        );
        Self::refund(attached - storage_cost);
        env::log_str(&format!(
            "EVENT_JSON:{}",
            near_sdk::serde_json::json!({
                "standard": "fox_passport", "version": "1.0.0", "event": "career_appended",
                "data": [{ "eventId": record.event_id, "collectionId": record.collection_id,
                    "tokenId": record.token_id, "actorId": record.actor_id, "source": record.source,
                    "sourceId": record.source_id, "matchId": record.match_id, "rulesVersion": record.rules_version,
                    "resultHash": record.result_hash, "revision": summary.revision.to_string() }]
            })
        ));
        true
    }
}

impl Passport {
    fn assert_owner(&self) {
        require!(env::predecessor_account_id() == self.owner_id, "Only owner");
    }

    fn refund(amount: u128) {
        if amount > 0 {
            Promise::new(env::predecessor_account_id()).transfer(NearToken::from_yoctonear(amount));
        }
    }
}
