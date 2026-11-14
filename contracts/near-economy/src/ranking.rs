use crate::{
    events, reservations,
    settlement::{valid_hash, valid_identifier, Entitlement, EntitlementView, Status},
    Economy, EconomyExt,
};
use near_sdk::{collections::LookupMap, env, json_types::U128, near, require, AccountId};

const DAY: u64 = 86_400_000;
const DAYS: u64 = 28;
const BUDGET: u128 = 1000 * 10u128.pow(24);
const CAP: u128 = 625 * 10u128.pow(22);
const SCALE: u128 = 1_000_000;
const LIABILITY_KEY: &[u8] = b"ranking/v1/liability";

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct RankingLiabilities {
    unmaterialized_atomic: U128,
    published_total_atomic: U128,
}

fn liabilities() -> RankingLiabilities {
    env::storage_read(LIABILITY_KEY)
        .map(|bytes| near_sdk::borsh::from_slice(&bytes).expect("Invalid ranking liability ledger"))
        .unwrap_or_default()
}

fn save_liabilities(value: &RankingLiabilities) {
    env::storage_write(
        LIABILITY_KEY,
        &near_sdk::borsh::to_vec(value).expect("Liability encoding"),
    );
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingAllocation {
    account_id: AccountId,
    score_atomic: U128,
    amount_atomic: U128,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RankingDraft {
    version: u8,
    campaign_id: String,
    season_start_ms: u64,
    budget_day: String,
    rubric_version: String,
    evidence_hash: String,
    mode: String,
    day_index: u8,
    budget_atomic: U128,
    total_score_atomic: U128,
    allocations: Vec<RankingAllocation>,
    awarded_atomic: U128,
    unallocated_atomic: U128,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct RankingRecord {
    draft: RankingDraft,
    draft_json: String,
    draft_hash: String,
    proposed_at_ms: u64,
    review_after_ms: u64,
    published_at_ms: Option<u64>,
}

#[near(serializers = [borsh])]
struct RankingCampaign {
    mode: String,
    start_ms: u64,
}

fn campaigns() -> LookupMap<String, RankingCampaign> {
    LookupMap::new(&b"ranking/v1/campaign"[..])
}
fn seasons() -> LookupMap<(String, u64), String> {
    LookupMap::new(&b"ranking/v1/season-mode"[..])
}
fn latest_ends() -> LookupMap<String, u64> {
    LookupMap::new(&b"ranking/v1/latest-mode-end"[..])
}
fn drafts() -> LookupMap<(String, u8), RankingRecord> {
    LookupMap::new(&b"ranking/v1/draft"[..])
}
fn account_days() -> LookupMap<(AccountId, String, u64), String> {
    LookupMap::new(&b"ranking/v1/account-day"[..])
}
pub(crate) fn ranking_campaign(id: &String) -> bool {
    campaigns().contains_key(id)
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}
fn allocation_id(campaign: &str, day: u8, account: &AccountId) -> String {
    let bytes = near_sdk::borsh::to_vec(&(campaign, day, account)).expect("Allocation encoding");
    format!("ranking:{}", hex(&env::sha256_array(&bytes)))
}

// Gregorian civil date for the UTC day, independent of local timezone.
fn utc_day(milliseconds: u64) -> String {
    let z = (milliseconds / DAY) as i64 + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let mut year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    year += i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

#[near]
impl Economy {
    // A classification of reward_reserved, never an additional token bucket.
    pub fn get_ranking_liabilities(&self) -> RankingLiabilities {
        liabilities()
    }
    pub fn open_ranking_campaign(
        &mut self,
        campaign_id: String,
        mode: String,
        season_start_ms: u64,
    ) {
        self.assert_owner();
        require!(
            matches!(mode.as_str(), "hunt" | "boss" | "control" | "trials"),
            "Unknown ranking mode"
        );
        require!(
            season_start_ms % DAY == 0,
            "Season must start at UTC midnight"
        );
        let key = (mode.clone(), season_start_ms);
        require!(
            !seasons().contains_key(&key),
            "Ranking mode season already funded"
        );
        require!(
            latest_ends()
                .get(&mode)
                .is_none_or(|end| season_start_ms >= end),
            "Ranking mode seasons cannot overlap or go backwards"
        );
        let end = season_start_ms
            .checked_add(DAYS * DAY)
            .expect("Season deadline overflow");
        self.open_campaign(campaign_id.clone(), U128(BUDGET), U128(CAP), end);
        latest_ends().insert(&mode, &end);
        campaigns().insert(
            &campaign_id,
            &RankingCampaign {
                mode,
                start_ms: season_start_ms,
            },
        );
        seasons().insert(&key, &campaign_id);
    }

    pub fn get_ranking_draft(&self, campaign_id: String, day_index: u8) -> Option<RankingRecord> {
        drafts().get(&(campaign_id, day_index))
    }

    pub fn get_ranking_allocation_id(
        &self,
        campaign_id: String,
        day_index: u8,
        account_id: AccountId,
    ) -> String {
        allocation_id(&campaign_id, day_index, &account_id)
    }

    pub fn propose_ranking_draft(
        &mut self,
        draft_json: String,
        draft_hash: String,
    ) -> RankingRecord {
        self.assert_settlement_signer();
        require!(
            draft_json.len() <= 500_000 && valid_hash(&draft_hash),
            "Invalid ranking draft hash or size"
        );
        let mut bytes = b"fox-ranking-draft/v1\0".to_vec();
        bytes.extend(draft_json.as_bytes());
        require!(
            hex(&env::sha256_array(&bytes)) == draft_hash,
            "Ranking hash mismatch"
        );
        let draft: RankingDraft =
            near_sdk::serde_json::from_str(&draft_json).expect("Invalid ranking draft payload");
        let key = (draft.campaign_id.clone(), draft.day_index);
        if let Some(record) = drafts().get(&key) {
            require!(
                record.draft_hash == draft_hash && record.draft_json == draft_json,
                "Conflicting ranking draft"
            );
            return record;
        }
        require!(self.settlement_enabled, "Settlement is disabled");
        let config = campaigns()
            .get(&draft.campaign_id)
            .expect("Unknown ranking campaign");
        let campaign = self
            .campaigns
            .get(&draft.campaign_id)
            .expect("Missing ranking funds");
        require!(!campaign.closed, "Campaign closed");
        require!(
            draft.version == 1
                && draft.mode == config.mode
                && draft.season_start_ms == config.start_ms
                && u64::from(draft.day_index) < DAYS,
            "Wrong ranking mode, season or day"
        );
        let day_start = config.start_ms + u64::from(draft.day_index) * DAY;
        let now = env::block_timestamp_ms();
        require!(now >= day_start + DAY, "Ranking day is still open");
        require!(
            draft.budget_day == utc_day(day_start),
            "Wrong ranking budget day"
        );
        require!(
            valid_identifier(&draft.rubric_version, 64) && valid_hash(&draft.evidence_hash),
            "Invalid ranking provenance"
        );
        let budget = BUDGET / u128::from(DAYS)
            + u128::from(u128::from(draft.day_index) < BUDGET % u128::from(DAYS));
        require!(
            draft.budget_atomic.0 == budget,
            "Wrong daily ranking budget"
        );
        let mut total = 0u128;
        let mut previous: Option<&AccountId> = None;
        for allocation in &draft.allocations {
            require!(
                previous.is_none_or(|id| id.as_str() < allocation.account_id.as_str()),
                "Duplicate or unsorted ranking account"
            );
            require!(
                allocation.score_atomic.0 <= SCALE,
                "Invalid normalized ranking score"
            );
            total = total
                .checked_add(allocation.score_atomic.0)
                .expect("Score overflow");
            previous = Some(&allocation.account_id);
        }
        require!(
            total == draft.total_score_atomic.0,
            "Wrong total ranking score"
        );
        let mut awarded = 0u128;
        for allocation in &draft.allocations {
            let expected = (budget * allocation.score_atomic.0 / total.max(10 * SCALE)).min(CAP);
            require!(
                allocation.amount_atomic.0 == expected,
                "Wrong ranking allocation amount or cap"
            );
            awarded = awarded.checked_add(expected).expect("Ranking sum overflow");
        }
        require!(
            awarded <= budget
                && draft.awarded_atomic.0 == awarded
                && draft.unallocated_atomic.0 == budget - awarded,
            "Wrong ranking allocation sum"
        );
        let record = RankingRecord {
            draft,
            draft_json,
            draft_hash,
            proposed_at_ms: now,
            review_after_ms: now.checked_add(DAY).expect("Review deadline overflow"),
            published_at_ms: None,
        };
        drafts().insert(&key, &record);
        events::emit(
            "ranking_draft_proposed",
            near_sdk::serde_json::json!({"campaignId":key.0,"dayIndex":key.1,"draftHash":record.draft_hash,"reviewAfterMs":record.review_after_ms}),
        );
        record
    }

    pub fn publish_ranking_draft(
        &mut self,
        campaign_id: String,
        day_index: u8,
        draft_hash: String,
    ) -> RankingRecord {
        self.assert_owner();
        let key = (campaign_id.clone(), day_index);
        let mut record = drafts().get(&key).expect("Unknown ranking draft");
        require!(record.draft_hash == draft_hash, "Ranking hash mismatch");
        if record.published_at_ms.is_some() {
            return record;
        }
        require!(self.settlement_enabled, "Settlement is disabled");
        let now = env::block_timestamp_ms();
        require!(
            now >= record.review_after_ms,
            "Ranking review is still pending"
        );
        let mut campaign = self
            .campaigns
            .get(&campaign_id)
            .expect("Missing ranking funds");
        require!(!campaign.closed, "Campaign closed");
        let draft = &record.draft;
        require!(
            campaign.remaining.0 >= draft.awarded_atomic.0,
            "Insufficient ranking campaign funds"
        );
        // Reserve the complete published liability once. Individual entitlements are
        // materialized in bounded calls, so publication does not write 1000 accounts.
        campaign.remaining.0 -= draft.awarded_atomic.0;
        self.ledger.reserve_campaign_reward(draft.awarded_atomic.0);
        let mut liability = liabilities();
        liability.unmaterialized_atomic.0 += draft.awarded_atomic.0;
        liability.published_total_atomic.0 += draft.awarded_atomic.0;
        save_liabilities(&liability);
        self.campaigns.insert(&campaign_id, &campaign);
        record.published_at_ms = Some(now);
        drafts().insert(&key, &record);
        events::emit(
            "ranking_draft_published",
            near_sdk::serde_json::json!({"campaignId":campaign_id,"dayIndex":day_index,"draftHash":draft_hash,"awardedAtomic":record.draft.awarded_atomic}),
        );
        record
    }

    pub fn finalize_ranking_allocation(
        &mut self,
        campaign_id: String,
        day_index: u8,
        account_id: AccountId,
    ) -> Option<EntitlementView> {
        self.assert_settlement_signer();
        let record = drafts()
            .get(&(campaign_id.clone(), day_index))
            .expect("Unknown ranking draft");
        require!(
            record.published_at_ms.is_some(),
            "Ranking draft is not published"
        );
        let draft = &record.draft;
        let allocation = draft
            .allocations
            .iter()
            .find(|allocation| allocation.account_id == account_id)
            .expect("Account has no published ranking allocation");
        if allocation.amount_atomic.0 == 0 {
            return None;
        }
        let operation = allocation_id(&campaign_id, day_index, &account_id);
        let fingerprint = env::sha256_array(record.draft_hash.as_bytes());
        if let Some(entry) = self.entitlements.get(&operation) {
            require!(
                entry.fingerprint == fingerprint
                    && entry.account_id == account_id
                    && entry.amount_atomic == allocation.amount_atomic.0,
                "Conflicting ranking entitlement"
            );
            return Some(entry.view(operation));
        }
        let day = draft.season_start_ms / DAY + u64::from(day_index);
        let account_key = (account_id.clone(), draft.mode.clone(), day);
        require!(
            !account_days().contains_key(&account_key)
                && !reservations::fixed_operation(&operation),
            "Ranking allocation already funded"
        );
        // Publication already removed this amount from campaign funds. Do not reserve
        // it again, and do not depend on campaign open/close or the season deadline.
        account_days().insert(&account_key, &operation);
        let entry = Entitlement {
            fingerprint,
            account_id: account_id.clone(),
            amount_atomic: allocation.amount_atomic.0,
            status: Status::Reserved,
            attempt: 0,
        };
        self.entitlements.insert(&operation, &entry);
        let mut liability = liabilities();
        liability.unmaterialized_atomic.0 -= allocation.amount_atomic.0;
        save_liabilities(&liability);
        events::emit(
            "ranking_allocation_reserved",
            near_sdk::serde_json::json!({"operationId":operation,"campaignId":campaign_id,"mode":draft.mode,"dayIndex":day_index,"draftHash":record.draft_hash,"accountId":account_id,"amountAtomic":allocation.amount_atomic}),
        );
        Some(entry.view(operation))
    }
}
