use near_sdk::{env, json_types::U128, near, require, AccountId};

pub(crate) const MAX_RESULT_TTL_MS: u64 = 86_400_000;
const RESULT_VERSION: u8 = 1;

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResultPayload {
    pub(crate) version: u8,
    pub(crate) network: String,
    pub(crate) contract_id: AccountId,
    pub(crate) signer_epoch: u32,
    pub(crate) operation_id: String,
    pub(crate) campaign_id: String,
    pub(crate) account_id: AccountId,
    pub(crate) match_id: String,
    pub(crate) rules_version: String,
    pub(crate) expires_at_ms: u64,
    pub(crate) amount_atomic: U128,
    pub(crate) result_hash: String,
}

impl ResultPayload {
    pub(crate) fn check_domain(&self, network: &str, epoch: u32) {
        require!(self.version == RESULT_VERSION, "Unsupported result version");
        require!(self.network == network, "Wrong network");
        require!(
            self.contract_id == env::current_account_id(),
            "Wrong contract"
        );
        require!(self.signer_epoch == epoch, "Wrong signer epoch");
        require!(
            valid_identifier(&self.operation_id, 96),
            "Invalid operation ID"
        );
        require!(
            valid_identifier(&self.campaign_id, 64),
            "Invalid campaign ID"
        );
        require!(valid_identifier(&self.match_id, 128), "Invalid match ID");
        require!(
            valid_identifier(&self.rules_version, 64),
            "Invalid rules version"
        );
        require!(valid_hash(&self.result_hash), "Invalid result hash");
    }

    pub(crate) fn check_expiry(&self) {
        let now = env::block_timestamp_ms();
        require!(
            self.expires_at_ms > now && self.expires_at_ms <= now + MAX_RESULT_TTL_MS,
            "Invalid result expiry"
        );
    }

    pub(crate) fn fingerprint(&self) -> [u8; 32] {
        let mut bytes = b"fox-economy/result/v1\0".to_vec();
        bytes.extend(near_sdk::borsh::to_vec(self).expect("Unable to encode result"));
        env::sha256_array(&bytes)
    }
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "snake_case")]
#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum Status {
    Reserved,
    InFlight,
    Paid,
}

#[near(serializers = [borsh])]
pub(crate) struct Entitlement {
    pub(crate) fingerprint: [u8; 32],
    pub(crate) account_id: AccountId,
    pub(crate) amount_atomic: u128,
    pub(crate) status: Status,
    pub(crate) attempt: u64,
}

#[near(serializers = [json])]
#[serde(rename_all = "camelCase")]
pub struct EntitlementView {
    operation_id: String,
    account_id: AccountId,
    amount_atomic: U128,
    status: Status,
    attempt: u64,
}

impl Entitlement {
    pub(crate) fn view(&self, operation_id: String) -> EntitlementView {
        EntitlementView {
            operation_id,
            account_id: self.account_id.clone(),
            amount_atomic: U128(self.amount_atomic),
            status: self.status,
            attempt: self.attempt,
        }
    }
}

pub(crate) fn valid_identifier(value: &str, max_len: usize) -> bool {
    !value.is_empty()
        && value.len() <= max_len
        && value.bytes().all(|byte| {
            byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b':' | b'.' | b'/')
        })
}

pub(crate) fn valid_hash(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}
