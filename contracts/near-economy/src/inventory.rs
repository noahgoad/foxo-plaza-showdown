use near_sdk::near;

const DAILY_CAP: Materials = Materials {
    alloy: 12,
    core: 2,
    catalyst: 1,
};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Clone, Copy, Default, Debug, PartialEq, Eq)]
pub struct Materials {
    pub(crate) alloy: u32,
    pub(crate) core: u32,
    pub(crate) catalyst: u32,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct Inventory {
    pub(crate) available: Materials,
    pub(crate) reserved: Materials,
    pub(crate) consumed: Materials,
    pub(crate) grant_day: u64,
    pub(crate) granted_today: Materials,
}

impl Inventory {
    pub(crate) fn grant(&mut self, materials: Materials, day: u64) -> bool {
        if day < self.grant_day {
            return false;
        }
        let previous = if day == self.grant_day {
            self.granted_today
        } else {
            Materials::default()
        };
        let Some(today) = previous.add(materials) else {
            return false;
        };
        let Some(available) = self.available.add(materials) else {
            return false;
        };
        if !DAILY_CAP.covers(today) {
            return false;
        }
        self.grant_day = day;
        self.granted_today = today;
        self.available = available;
        true
    }

    pub(crate) fn consume(&mut self, materials: Materials) -> bool {
        let Some(available) = self.available.subtract(materials) else {
            return false;
        };
        let Some(consumed) = self.consumed.add(materials) else {
            return false;
        };
        self.available = available;
        self.consumed = consumed;
        true
    }
}

impl Materials {
    pub(crate) fn token_amount(self, token_id: &str) -> Option<u128> {
        match token_id {
            "alloy" => Some(u128::from(self.alloy)),
            "core" => Some(u128::from(self.core)),
            "catalyst" => Some(u128::from(self.catalyst)),
            _ => None,
        }
    }

    pub(crate) fn set_token_amount(&mut self, token_id: &str, amount: u128) -> bool {
        let Ok(amount) = u32::try_from(amount) else {
            return false;
        };
        match token_id {
            "alloy" => self.alloy = amount,
            "core" => self.core = amount,
            "catalyst" => self.catalyst = amount,
            _ => return false,
        }
        true
    }

    fn add(self, other: Self) -> Option<Self> {
        Some(Self {
            alloy: self.alloy.checked_add(other.alloy)?,
            core: self.core.checked_add(other.core)?,
            catalyst: self.catalyst.checked_add(other.catalyst)?,
        })
    }

    fn subtract(self, other: Self) -> Option<Self> {
        Some(Self {
            alloy: self.alloy.checked_sub(other.alloy)?,
            core: self.core.checked_sub(other.core)?,
            catalyst: self.catalyst.checked_sub(other.catalyst)?,
        })
    }

    fn covers(self, other: Self) -> bool {
        self.alloy >= other.alloy && self.core >= other.core && self.catalyst >= other.catalyst
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn all_grant_sources_share_account_day_quota() {
        let mut inventory = Inventory::default();
        assert!(inventory.grant(DAILY_CAP, 5));
        assert!(!inventory.grant(
            Materials {
                alloy: 1,
                ..Materials::default()
            },
            5
        ));
        assert!(!inventory.grant(
            Materials {
                alloy: 1,
                ..Materials::default()
            },
            4
        ));
        assert!(inventory.grant(
            Materials {
                alloy: 1,
                ..Materials::default()
            },
            6
        ));
        assert_eq!(inventory.available.alloy, 13);
        assert_eq!(inventory.granted_today.alloy, 1);
    }

    #[test]
    fn insufficient_materials_do_not_partially_consume() {
        let mut inventory = Inventory::default();
        assert!(inventory.grant(DAILY_CAP, 1));
        assert!(!inventory.consume(Materials {
            alloy: 2,
            core: 3,
            catalyst: 0
        }));
        assert_eq!(inventory.available, DAILY_CAP);
        assert_eq!(inventory.consumed, Materials::default());
        assert!(inventory.consume(DAILY_CAP));
        assert_eq!(inventory.available, Materials::default());
        assert_eq!(inventory.consumed, DAILY_CAP);
    }
}
