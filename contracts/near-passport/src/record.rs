use near_sdk::{near, AccountId};

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum CareerSource {
    Authoritative,
    LegacyMigration,
    Correction,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[derive(Clone)]
pub struct CareerRecord {
    pub version: u8,
    pub network: String,
    pub contract_id: AccountId,
    pub collection_id: AccountId,
    pub token_id: String,
    pub event_id: String,
    pub source: CareerSource,
    pub source_id: String,
    pub actor_id: AccountId,
    pub match_id: String,
    pub rules_version: String,
    pub result_hash: String,
    pub finished_at_ms: u64,
    pub mode: String,
    pub won: bool,
    pub xp: u32,
    pub provenance_hash: Option<String>,
    pub corrects_event_id: Option<String>,
    pub correction_reason: Option<String>,
    #[serde(default)]
    pub trait_manifest_hash: Option<String>,
}

pub fn identifier(value: &str, maximum: usize) -> bool {
    !value.is_empty()
        && value.len() <= maximum
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.' | b'/')
        })
}

fn hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

impl CareerRecord {
    pub fn validate(
        &self,
        network: &str,
        contract: &AccountId,
        collection: &AccountId,
    ) -> Result<(), &'static str> {
        if self.version != 1
            || self.network != network
            || &self.contract_id != contract
            || &self.collection_id != collection
        {
            return Err("Wrong career record domain");
        }
        if !identifier(&self.event_id, 96)
            || !identifier(&self.source_id, 128)
            || !identifier(&self.match_id, 128)
            || !identifier(&self.rules_version, 64)
            || self.token_id.is_empty()
            || self.token_id.len() > 128
            || self.token_id.chars().any(char::is_control)
            || !hash(&self.result_hash)
            || self.finished_at_ms == 0
            || self
                .trait_manifest_hash
                .as_ref()
                .is_some_and(|value| !hash(value))
            || !matches!(self.mode.as_str(), "hunt" | "boss" | "control" | "trials")
        {
            return Err("Invalid career record");
        }
        match self.source {
            CareerSource::Authoritative => {
                if self.provenance_hash.is_some()
                    || self.corrects_event_id.is_some()
                    || self.correction_reason.is_some()
                {
                    return Err(
                        "Authoritative record cannot contain migration or correction provenance",
                    );
                }
            }
            CareerSource::LegacyMigration => {
                if !self
                    .provenance_hash
                    .as_ref()
                    .is_some_and(|value| hash(value))
                    || self.corrects_event_id.is_some()
                    || self.correction_reason.is_some()
                {
                    return Err("Legacy migration requires a source snapshot hash");
                }
            }
            CareerSource::Correction => {
                if !self
                    .corrects_event_id
                    .as_ref()
                    .is_some_and(|value| identifier(value, 96) && value != &self.event_id)
                    || !self.correction_reason.as_ref().is_some_and(|value| {
                        !value.trim().is_empty()
                            && value.len() <= 240
                            && !value.chars().any(char::is_control)
                    })
                    || !self
                        .provenance_hash
                        .as_ref()
                        .is_some_and(|value| hash(value))
                {
                    return Err("Correction requires a linked record, reason and evidence hash");
                }
            }
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn record() -> CareerRecord {
        CareerRecord {
            version: 1,
            network: "near-testnet".into(),
            contract_id: "passport.testnet".parse().unwrap(),
            collection_id: "fox.testnet".parse().unwrap(),
            token_id: "045".into(),
            event_id: "event-1".into(),
            source: CareerSource::Authoritative,
            source_id: "match-1:alice".into(),
            actor_id: "alice.testnet".parse().unwrap(),
            match_id: "match-1".into(),
            rules_version: "pilot-1".into(),
            result_hash: "a".repeat(64),
            finished_at_ms: 1,
            mode: "boss".into(),
            won: true,
            xp: 100,
            provenance_hash: None,
            corrects_event_id: None,
            correction_reason: None,
            trait_manifest_hash: None,
        }
    }

    #[test]
    fn domain_and_mode_are_required() {
        let mut value = record();
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_ok());
        assert!(value
            .validate("near-mainnet", &value.contract_id, &value.collection_id)
            .is_err());
        value.mode = "practice".into();
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_err());
    }

    #[test]
    fn legacy_and_correction_have_explicit_provenance() {
        let mut value = record();
        value.source = CareerSource::LegacyMigration;
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_err());
        value.provenance_hash = Some("b".repeat(64));
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_ok());
        value.source = CareerSource::Correction;
        value.corrects_event_id = Some("event-original".into());
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_err());
        value.correction_reason = Some("Corrected verified result".into());
        assert!(value
            .validate("near-testnet", &value.contract_id, &value.collection_id)
            .is_ok());
    }
}
