use crate::{
    events,
    settlement::{valid_hash, valid_identifier, Entitlement, EntitlementView, Status},
    Economy, EconomyExt,
};
use near_sdk::{collections::LookupMap, env, json_types::U128, near, require, AccountId};

const DAY_MS: u64 = 86_400_000;
const WINDOW_MS: u64 = DAY_MS / 6;
const SEASON_DAYS: u64 = 28;
const START_MS: u64 = 600_000;
const COMPLETE_MS: u64 = 3_600_000;
const FIXED_AWARD: u128 = 5 * 10u128.pow(24);
const FIXED_BUDGET: u128 = 16_000 * 10u128.pow(24);
const FIXED_HELD_KEY: &[u8] = b"fixed/v1/held";

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(PartialEq, Eq)]
pub struct FixedReservation {
    id: String,
    campaign_id: String,
    account_id: AccountId,
    match_id: String,
    task_id: String,
    mode: String,
    amount_atomic: U128,
    created_at_ms: u64,
    start_by_ms: u64,
    complete_by_ms: u64,
    day_index: u8,
    window_index: u8,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Eq)]
enum FixedStatus {
    Reserved,
    Released,
    Settled,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
pub struct FixedReservationRecord {
    #[serde(flatten)]
    reservation: FixedReservation,
    reserved_at_ms: u64,
    status: FixedStatus,
    started_at_ms: Option<u64>,
    finished_at_ms: Option<u64>,
    result_hash: Option<String>,
}

// Dedicated keys preserve the Economy and Ledger Borsh layouts on upgrade.
fn reservations() -> LookupMap<String, FixedReservationRecord> {
    LookupMap::new(&b"fixed/v1/reservation"[..])
}

fn seasons() -> LookupMap<String, u64> {
    LookupMap::new(&b"fixed/v1/season"[..])
}

fn match_ids() -> LookupMap<(AccountId, String), String> {
    LookupMap::new(&b"fixed/v1/match"[..])
}

fn active_accounts() -> LookupMap<AccountId, String> {
    LookupMap::new(&b"fixed/v1/active"[..])
}

fn account_days() -> LookupMap<(AccountId, u64), u8> {
    LookupMap::new(&b"fixed/v1/account-day"[..])
}

fn windows() -> LookupMap<(String, u8), [u16; 6]> {
    LookupMap::new(&b"fixed/v1/windows"[..])
}

pub(crate) fn fixed_campaign(campaign_id: &String) -> bool {
    seasons().contains_key(campaign_id)
}

pub(crate) fn fixed_operation(id: &String) -> bool {
    reservations().contains_key(id)
}

pub(crate) fn fixed_match(key: &(AccountId, String)) -> bool {
    match_ids().contains_key(key)
}

pub(crate) fn held() -> u128 {
    env::storage_read(FIXED_HELD_KEY)
        .map(|data| u128::from_le_bytes(data.try_into().expect("Invalid fixed reserve ledger")))
        .unwrap_or(0)
}

fn set_held(amount: u128) {
    env::storage_write(FIXED_HELD_KEY, &amount.to_le_bytes());
}

fn issue_window(season_start_ms: u64, created_at_ms: u64) -> Option<(u8, u8)> {
    let elapsed = created_at_ms.checked_sub(season_start_ms)?;
    let day = elapsed / DAY_MS;
    if day >= SEASON_DAYS {
        return None;
    }
    Some((day as u8, (elapsed % DAY_MS / WINDOW_MS) as u8))
}

fn window_slot_cap(day: u8, window: u8) -> u16 {
    19 * (u16::from(window) + 1) + u16::from(day < 8 && day % 6 <= window)
}

fn take_slot(day: u8, window: u8, counts: &mut [u16; 6]) -> bool {
    let mut running = 0;
    for (index, count) in counts.iter().enumerate() {
        running += count;
        let index = index as u8;
        // A delayed transaction in an earlier issue window cannot consume carry
        // that has already funded a later window.
        if index >= window && running >= window_slot_cap(day, index) {
            return false;
        }
    }
    counts[usize::from(window)] += 1;
    true
}

impl FixedReservation {
    fn check(&self, season_start: u64, now: u64) {
        require!(
            valid_identifier(&self.id, 96)
                && valid_identifier(&self.campaign_id, 64)
                && valid_identifier(&self.match_id, 128)
                && valid_identifier(&self.task_id, 128),
            "Invalid fixed reservation identity"
        );
        require!(
            matches!(self.mode.as_str(), "hunt" | "boss" | "control" | "trials"),
            "Invalid fixed reward mode"
        );
        require!(self.amount_atomic.0 == FIXED_AWARD, "Wrong fixed award");
        require!(
            issue_window(season_start, self.created_at_ms)
                == Some((self.day_index, self.window_index)),
            "Wrong fixed issue window"
        );
        require!(
            self.created_at_ms <= now
                && now < self.start_by_ms
                && self.created_at_ms.checked_add(START_MS) == Some(self.start_by_ms)
                && self.created_at_ms.checked_add(COMPLETE_MS) == Some(self.complete_by_ms),
            "Invalid fixed reservation deadline"
        );
    }

    fn match_key(&self) -> (AccountId, String) {
        (self.account_id.clone(), self.match_id.clone())
    }

    fn day_key(&self) -> (AccountId, u64) {
        (self.account_id.clone(), self.created_at_ms / DAY_MS)
    }

    fn window_key(&self) -> (String, u8) {
        (self.campaign_id.clone(), self.day_index)
    }
}

#[near]
impl Economy {
    pub fn open_fixed_campaign(&mut self, campaign_id: String, season_start_ms: u64) {
        require!(
            season_start_ms % DAY_MS == 0,
            "Season must start at UTC midnight"
        );
        let closes_at_ms = season_start_ms
            .checked_add(SEASON_DAYS * DAY_MS)
            .expect("Season deadline overflow");
        self.open_campaign(
            campaign_id.clone(),
            U128(FIXED_BUDGET),
            U128(FIXED_AWARD),
            closes_at_ms,
        );
        seasons().insert(&campaign_id, &season_start_ms);
    }

    pub fn get_fixed_reservation(&self, reservation_id: String) -> Option<FixedReservationRecord> {
        reservations().get(&reservation_id)
    }

    pub fn reserve_fixed_reward(
        &mut self,
        reservation: FixedReservation,
    ) -> FixedReservationRecord {
        self.assert_settlement_signer();
        let mut records = reservations();
        if let Some(record) = records.get(&reservation.id) {
            require!(
                record.reservation == reservation,
                "Reservation ID already used"
            );
            return record;
        }
        require!(self.settlement_enabled, "Settlement is disabled");
        let season_start = seasons()
            .get(&reservation.campaign_id)
            .expect("Unknown fixed campaign");
        let now = env::block_timestamp_ms();
        reservation.check(season_start, now);
        let mut campaign = self
            .campaigns
            .get(&reservation.campaign_id)
            .expect("Missing fixed campaign");
        require!(
            !campaign.closed && now < campaign.closes_at_ms,
            "Campaign closed"
        );
        require!(
            campaign.remaining.0 >= FIXED_AWARD && campaign.max_award.0 == FIXED_AWARD,
            "Insufficient fixed campaign funds"
        );
        let match_key = reservation.match_key();
        require!(
            !self.entitlements.contains_key(&reservation.id)
                && !self.settled_matches.contains(&match_key)
                && !fixed_match(&match_key),
            "Fixed match or operation already used"
        );
        require!(
            !active_accounts().contains_key(&reservation.account_id),
            "Account has an active reservation"
        );
        let day_key = reservation.day_key();
        let daily = account_days().get(&day_key).unwrap_or(0);
        require!(daily < 3, "Daily fixed award cap reached");
        let window_key = reservation.window_key();
        let mut counts = windows().get(&window_key).unwrap_or_default();
        require!(
            take_slot(reservation.day_index, reservation.window_index, &mut counts),
            "No fixed slots available"
        );

        campaign.remaining.0 -= FIXED_AWARD;
        self.ledger.reserve_campaign_reward(FIXED_AWARD);
        set_held(held() + FIXED_AWARD);
        self.campaigns.insert(&reservation.campaign_id, &campaign);
        windows().insert(&window_key, &counts);
        account_days().insert(&day_key, &(daily + 1));
        active_accounts().insert(&reservation.account_id, &reservation.id);
        match_ids().insert(&match_key, &reservation.id);
        let record = FixedReservationRecord {
            reservation,
            reserved_at_ms: now,
            status: FixedStatus::Reserved,
            started_at_ms: None,
            finished_at_ms: None,
            result_hash: None,
        };
        records.insert(&record.reservation.id, &record);
        events::emit("fixed_reward_held", near_sdk::serde_json::json!(record));
        record
    }

    pub fn release_fixed_reward(&mut self, reservation_id: String) -> FixedReservationRecord {
        self.assert_settlement_signer();
        let mut records = reservations();
        let mut record = records
            .get(&reservation_id)
            .expect("Unknown fixed reservation");
        if record.status == FixedStatus::Released {
            return record;
        }
        require!(
            record.status == FixedStatus::Reserved,
            "Fixed reward already settled"
        );
        // The authenticated game server attests cancellation or durable match closure.
        // No time-only release can erase a result waiting for transport recovery.
        let reservation = &record.reservation;
        let mut campaign = self
            .campaigns
            .get(&reservation.campaign_id)
            .expect("Missing fixed campaign");
        let return_to_campaign =
            !campaign.closed && env::block_timestamp_ms() < campaign.closes_at_ms;
        self.ledger
            .release_fixed_reward(FIXED_AWARD, return_to_campaign);
        set_held(held() - FIXED_AWARD);
        if return_to_campaign {
            campaign.remaining.0 += FIXED_AWARD;
            self.campaigns.insert(&reservation.campaign_id, &campaign);
        }
        let window_key = reservation.window_key();
        let mut counts = windows().get(&window_key).expect("Missing fixed window");
        counts[usize::from(reservation.window_index)] -= 1;
        windows().insert(&window_key, &counts);
        let day_key = reservation.day_key();
        let daily = account_days()
            .get(&day_key)
            .expect("Missing fixed daily count");
        account_days().insert(&day_key, &(daily - 1));
        active_accounts().remove(&reservation.account_id);
        record.status = FixedStatus::Released;
        records.insert(&reservation_id, &record);
        events::emit("fixed_reward_released", near_sdk::serde_json::json!(record));
        record
    }

    pub fn settle_fixed_reward(
        &mut self,
        reservation_id: String,
        started_at_ms: u64,
        finished_at_ms: u64,
        result_hash: String,
    ) -> EntitlementView {
        self.assert_settlement_signer();
        let mut records = reservations();
        let mut record = records
            .get(&reservation_id)
            .expect("Unknown fixed reservation");
        if record.status == FixedStatus::Settled {
            require!(
                record.started_at_ms == Some(started_at_ms)
                    && record.finished_at_ms == Some(finished_at_ms)
                    && record.result_hash.as_ref() == Some(&result_hash),
                "Conflicting fixed result"
            );
            return self
                .entitlements
                .get(&reservation_id)
                .expect("Missing fixed entitlement")
                .view(reservation_id);
        }
        require!(
            record.status == FixedStatus::Reserved,
            "Fixed reservation was released"
        );
        let reservation = &record.reservation;
        require!(
            started_at_ms >= record.reserved_at_ms
                && started_at_ms < reservation.start_by_ms
                && finished_at_ms >= started_at_ms
                && finished_at_ms < reservation.complete_by_ms
                && finished_at_ms <= env::block_timestamp_ms()
                && valid_hash(&result_hash),
            "Invalid fixed completion proof"
        );
        let match_key = reservation.match_key();
        require!(
            !self.entitlements.contains_key(&reservation_id)
                && !self.settled_matches.contains(&match_key),
            "Fixed match or operation already settled"
        );
        let fingerprint = env::sha256_array(result_hash.as_bytes());
        let entry = Entitlement {
            fingerprint,
            account_id: reservation.account_id.clone(),
            amount_atomic: FIXED_AWARD,
            status: Status::Reserved,
            attempt: 0,
        };
        self.entitlements.insert(&reservation_id, &entry);
        self.settled_matches.insert(&match_key);
        active_accounts().remove(&reservation.account_id);
        set_held(held() - FIXED_AWARD);
        record.status = FixedStatus::Settled;
        record.started_at_ms = Some(started_at_ms);
        record.finished_at_ms = Some(finished_at_ms);
        record.result_hash = Some(result_hash);
        records.insert(&reservation_id, &record);
        events::emit("fixed_reward_settled", near_sdk::serde_json::json!(record));
        entry.view(reservation_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pilot_schedule_counts_exact_fixed_budget() {
        let total: u32 = (0..28).map(|day| u32::from(window_slot_cap(day, 5))).sum();
        assert_eq!(u128::from(total) * FIXED_AWARD, FIXED_BUDGET);
        assert_eq!(window_slot_cap(0, 0), 20);
        assert_eq!(window_slot_cap(1, 0), 19);
        assert_eq!(window_slot_cap(1, 1), 39);
        assert_eq!(window_slot_cap(7, 1), 39);
        assert_eq!(window_slot_cap(8, 5), 114);
    }

    #[test]
    fn earlier_window_submissions_cannot_steal_capacity_already_used_in_later_windows() {
        let mut counts = [19, 20, 0, 0, 0, 0];
        assert!(!take_slot(0, 0, &mut counts));
        assert_eq!(counts, [19, 20, 0, 0, 0, 0]);
        counts[1] -= 1;
        assert!(take_slot(0, 0, &mut counts));
        assert_eq!(counts, [20, 19, 0, 0, 0, 0]);
    }

    #[test]
    fn schedule_uses_half_open_utc_window_and_season_boundaries() {
        assert_eq!(issue_window(0, 0), Some((0, 0)));
        assert_eq!(issue_window(0, WINDOW_MS - 1), Some((0, 0)));
        assert_eq!(issue_window(0, WINDOW_MS), Some((0, 1)));
        assert_eq!(issue_window(0, DAY_MS - 1), Some((0, 5)));
        assert_eq!(issue_window(0, DAY_MS), Some((1, 0)));
        assert_eq!(issue_window(0, 28 * DAY_MS - 1), Some((27, 5)));
        assert_eq!(issue_window(0, 28 * DAY_MS), None);
        assert_eq!(issue_window(DAY_MS, DAY_MS - 1), None);
    }
}
