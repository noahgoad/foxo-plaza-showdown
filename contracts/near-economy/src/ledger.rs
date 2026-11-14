use near_sdk::{json_types::U128, near};

pub(crate) const REWARD_FUNDING_CAP: u128 = 80_000 * 10u128.pow(24);

#[near(serializers = [borsh])]
#[derive(Default)]
pub(crate) struct Ledger {
    pub(crate) reward_available: u128,
    pub(crate) campaign_available: u128,
    pub(crate) reward_reserved: u128,
    pub(crate) reward_in_flight: u128,
    pub(crate) reward_paid: u128,
    pub(crate) crafting_fees: u128,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct LedgerView {
    reward_available: U128,
    campaign_available: U128,
    fixed_reserved: U128,
    reward_reserved: U128,
    reward_in_flight: U128,
    reward_paid: U128,
    crafting_fees: U128,
}

impl Ledger {
    pub(crate) fn fund_rewards(&mut self, amount: u128) -> u128 {
        let funded = self.reward_available
            + self.campaign_available
            + self.reward_reserved
            + self.reward_in_flight
            + self.reward_paid;
        let accepted = amount.min(REWARD_FUNDING_CAP - funded);
        self.reward_available += accepted;
        accepted
    }

    pub(crate) fn allocate_campaign(&mut self, amount: u128) -> bool {
        if amount == 0 || amount > self.reward_available {
            return false;
        }
        self.reward_available -= amount;
        self.campaign_available += amount;
        true
    }

    pub(crate) fn release_campaign(&mut self, amount: u128) {
        self.campaign_available -= amount;
        self.reward_available += amount;
    }

    pub(crate) fn reserve_campaign_reward(&mut self, amount: u128) {
        self.campaign_available -= amount;
        self.reward_reserved += amount;
    }

    pub(crate) fn release_fixed_reward(&mut self, amount: u128, return_to_campaign: bool) {
        self.reward_reserved -= amount;
        if return_to_campaign {
            self.campaign_available += amount;
        } else {
            self.reward_available += amount;
        }
    }

    pub(crate) fn begin_reward_transfer(&mut self, amount: u128) {
        self.reward_reserved -= amount;
        self.reward_in_flight += amount;
    }

    pub(crate) fn finish_reward_transfer(&mut self, amount: u128, success: bool) {
        self.reward_in_flight -= amount;
        if success {
            self.reward_paid += amount;
        } else {
            self.reward_reserved += amount;
        }
    }

    pub(crate) fn view(&self, fixed_held: u128) -> LedgerView {
        LedgerView {
            reward_available: U128(self.reward_available),
            campaign_available: U128(self.campaign_available),
            fixed_reserved: U128(fixed_held),
            reward_reserved: U128(self.reward_reserved - fixed_held),
            reward_in_flight: U128(self.reward_in_flight),
            reward_paid: U128(self.reward_paid),
            crafting_fees: U128(self.crafting_fees),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failed_transfer_restores_the_same_reservation() {
        let mut ledger = Ledger::default();
        assert_eq!(ledger.fund_rewards(100), 100);
        assert!(ledger.allocate_campaign(40));
        ledger.reserve_campaign_reward(40);
        assert!(!ledger.allocate_campaign(61));
        ledger.begin_reward_transfer(40);
        assert_eq!(ledger.reward_available, 60);
        assert_eq!(ledger.reward_reserved, 0);
        assert_eq!(ledger.reward_in_flight, 40);

        ledger.finish_reward_transfer(40, false);
        assert_eq!(ledger.reward_available, 60);
        assert_eq!(ledger.reward_reserved, 40);
        assert_eq!(ledger.reward_in_flight, 0);
        assert_eq!(ledger.reward_paid, 0);

        ledger.begin_reward_transfer(40);
        ledger.finish_reward_transfer(40, true);
        assert_eq!(ledger.reward_available, 60);
        assert_eq!(ledger.reward_reserved, 0);
        assert_eq!(ledger.reward_in_flight, 0);
        assert_eq!(ledger.reward_paid, 40);
    }

    #[test]
    fn paid_rewards_still_count_against_funding_cap() {
        let mut ledger = Ledger::default();
        assert_eq!(
            ledger.fund_rewards(REWARD_FUNDING_CAP + 20),
            REWARD_FUNDING_CAP
        );
        assert!(ledger.allocate_campaign(10));
        ledger.reserve_campaign_reward(10);
        ledger.begin_reward_transfer(10);
        ledger.finish_reward_transfer(10, true);
        assert_eq!(ledger.fund_rewards(10), 0);
    }
}
