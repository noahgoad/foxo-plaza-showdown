//! Isolated guild-bound material escrow. No economy state mutation or asset withdrawals.
use near_sdk::{
    collections::LookupMap, env, ext_contract, json_types::U128, near, require, AccountId, Gas,
    NearToken, PanicOnDefault, Promise, PromiseOrValue, PromiseResult,
};
const INPUTS: [u128; 3] = [48, 2, 2];
const TOKENS: [&str; 3] = ["alloy", "core", "catalyst"];
fn serialize_deadline<S:near_sdk::serde::Serializer>(value:&u64,serializer:S)->Result<S::Ok,S::Error>{serializer.serialize_str(&value.to_string())}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Guild {
    pub leader: AccountId,
    pub treasurer: AccountId,
    pub active: bool,
    pub governors: Vec<AccountId>,
    pub threshold: u32,
    pub epoch: u64,
    pub projects: Vec<String>,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Project {
    pub guild_id: String,
    pub terms_hash: String,
    #[serde(serialize_with="serialize_deadline")]
    pub deadline: u64,
    pub status: String,
    pub totals: Vec<U128>,
    pub contributions: Vec<String>,
    pub sku: String,
    pub fee_payer: AccountId,
    pub fee_state: String,
    pub fee_attempt: u64,
}
#[near(serializers=[borsh,json])]
#[derive(Clone)]
pub struct Contribution {
    pub project_id: String,
    pub contributor: AccountId,
    pub token_ids: Vec<String>,
    pub amounts: Vec<U128>,
    pub status: String,
    pub attempt: u64,
}
#[near(serializers=[borsh])]
struct Approval {
    epoch: u64,
    voters: Vec<AccountId>,
}
#[near(serializers=[json])]
#[serde(deny_unknown_fields)]
struct Message {
    project_id: String,
    terms_hash: String,
    operation_id: String,
}
#[allow(dead_code)]
#[ext_contract(mt)]
trait MultiToken {
    fn mt_batch_transfer(
        &mut self,
        receiver_id: AccountId,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        approvals: Option<Vec<Option<(AccountId, u64)>>>,
        memo: Option<String>,
    );
}
#[allow(dead_code)]
#[ext_contract(callback)]
trait Callback {
    fn on_refund(&mut self, operation_id: String, attempt: u64) -> bool;
    fn on_commit_transfer(&mut self, project_id: String, attempt: u64) -> PromiseOrValue<bool>;
    fn on_commit_receipt(&mut self, project_id: String, attempt: u64) -> bool;
    fn on_fee_refund(&mut self, project_id: String, attempt: u64) -> bool;
}
#[near(contract_state)]
#[derive(PanicOnDefault)]
pub struct Contract {
    economy_mt: AccountId,
    foxo_contract_id: AccountId,
    guilds: LookupMap<String, Guild>,
    members: LookupMap<String, bool>,
    projects: LookupMap<String, Project>,
    contributions: LookupMap<String, Contribution>,
    approvals: LookupMap<String, Approval>,
    storage_credit: LookupMap<AccountId, u128>,
}
fn key(g: &str, a: &AccountId) -> String {
    format!("{}:{}", g, a)
}
fn identifier(s: &str) {
    require!(
        !s.is_empty()
            && s.len() <= 64
            && s.bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
        "Invalid identifier"
    );
}
fn event(name: &str, data: near_sdk::serde_json::Value) {
    env::log_str(&format!(
        "EVENT_JSON:{}",
        near_sdk::serde_json::json!({"standard":"fox_guild","version":"1.0.0","event":name,"data":[data]})
    ));
}
#[near]
impl Contract {
    #[init]
    pub fn new(economy_mt: AccountId, foxo_contract_id: AccountId) -> Self {
        let caller = env::predecessor_account_id();
        let current = env::current_account_id();
        require!(
            caller == current
                || (env::signer_account_id() == caller
                    && current
                        .as_str()
                        .split_once('.')
                        .is_some_and(|(_, parent)| parent == caller.as_str())),
            "Initializer must control contract account"
        );
        require!(
            economy_mt != current && foxo_contract_id != current && foxo_contract_id != economy_mt,
            "Invalid asset contracts"
        );
        Self {
            economy_mt,
            foxo_contract_id,
            guilds: LookupMap::new(b"g"),
            members: LookupMap::new(b"m"),
            projects: LookupMap::new(b"p"),
            contributions: LookupMap::new(b"c"),
            approvals: LookupMap::new(b"a"),
            storage_credit: LookupMap::new(b"s"),
        }
    }
    /// Explicit storage prepayment, not project principal. No native-token treasury withdrawal exists.
    #[payable]
    pub fn fund_storage(&mut self) {
        let actor = env::predecessor_account_id();
        let prior = self.storage_credit.get(&actor).unwrap_or(0);
        let before = env::storage_usage();
        self.storage_credit.insert(&actor, &prior);
        let cost =
            u128::from(env::storage_usage() - before) * env::storage_byte_cost().as_yoctonear();
        let credit = prior
            .checked_add(env::attached_deposit().as_yoctonear())
            .expect("Storage overflow");
        require!(credit >= cost, "Insufficient storage deposit");
        self.storage_credit.insert(&actor, &(credit - cost));
    }
    pub fn storage_credit(&self, account_id: AccountId) -> U128 {
        U128(self.storage_credit.get(&account_id).unwrap_or(0))
    }
    pub fn get_config(&self) -> near_sdk::serde_json::Value {
        near_sdk::serde_json::json!({"economy_mt":self.economy_mt,"foxo_contract_id":self.foxo_contract_id})
    }
    pub fn member(&self,guild_id:String,account_id:AccountId) -> bool {
        self.is_member(&guild_id,&account_id)
    }
    pub fn guild(&self, guild_id: String) -> Option<Guild> {
        self.guilds.get(&guild_id)
    }
    pub fn project(&self, project_id: String) -> Option<Project> {
        self.projects.get(&project_id)
    }
    pub fn contribution(&self, operation_id: String) -> Option<Contribution> {
        self.contributions.get(&operation_id)
    }
    pub fn create_guild(&mut self, guild_id: String, governors: Vec<AccountId>, threshold: u32) {
        identifier(&guild_id);
        require!(self.guilds.get(&guild_id).is_none(), "Guild exists");
        let actor = env::predecessor_account_id();
        require!(
            governors.len() >= 2
                && governors.len() <= 16
                && threshold >= 2
                && threshold as usize <= governors.len(),
            "Invalid approval threshold"
        );
        for (i, a) in governors.iter().enumerate() {
            require!(!governors[..i].contains(a), "Duplicate governor");
        }
        require!(governors.contains(&actor), "Leader must be governor");
        let before = env::storage_usage();
        self.guilds.insert(
            &guild_id,
            &Guild {
                leader: actor.clone(),
                treasurer: actor.clone(),
                active: true,
                governors,
                threshold,
                epoch: 0,
                projects: vec![],
            },
        );
        self.members.insert(&key(&guild_id, &actor), &true);
        self.charge(&actor, before);
        event(
            "guild_create",
            near_sdk::serde_json::json!({"guild_id":guild_id,"leader":actor}),
        );
    }
    pub fn join(&mut self, guild_id: String) {
        let g = self.active_guild(&guild_id);
        let _ = g;
        let actor = env::predecessor_account_id();
        let before = env::storage_usage();
        self.members.insert(&key(&guild_id, &actor), &true);
        self.charge(&actor, before);
    }
    pub fn leave(&mut self, guild_id: String) {
        let g = self.active_guild(&guild_id);
        let actor = env::predecessor_account_id();
        require!(
            actor != g.leader && actor != g.treasurer,
            "Manager must change through approvals first"
        );
        require!(self.is_member(&guild_id,&actor),"Not an active guild member");
        self.members.insert(&key(&guild_id, &actor), &false);
    }
    pub fn open_project_ms(&mut self,project_id:String,guild_id:String,deadline_ms:u64)->String{
        require!(deadline_ms<=9_007_199_254_740_991,"Invalid millisecond deadline");
        let deadline=deadline_ms.checked_mul(1_000_000).expect("Deadline overflow");
        self.open_project(project_id,guild_id,deadline)
    }
    pub fn open_project(&mut self, project_id: String, guild_id: String, deadline: u64) -> String {
        identifier(&project_id);
        let mut g = self.manager(&guild_id);
        require!(g.projects.len() < 64, "Project limit");
        require!(self.projects.get(&project_id).is_none(), "Project exists");
        require!(deadline > env::block_timestamp(), "Invalid deadline");
        let terms=near_sdk::serde_json::to_vec(&near_sdk::serde_json::json!({"contract":env::current_account_id(),"guild_id":guild_id,"project_id":project_id,"sku":"guild-banner-beacon-v2","targets":["48","2","2"],"token_ids":TOKENS,"deadline":deadline,"refund_policy":"uncommitted-only","transferable":false,"fee_atomic":FEE.to_string(),"fee_payer":env::predecessor_account_id()})).unwrap();
        let hash = env::sha256(&terms)
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        let before = env::storage_usage();
        self.projects.insert(
            &project_id,
            &Project {
                guild_id: guild_id.clone(),
                terms_hash: hash.clone(),
                deadline,
                status: "open".into(),
                totals: vec![U128(0); 3],
                contributions: vec![],
                sku: "guild-banner-beacon-v2".into(),
                fee_payer: env::predecessor_account_id(),
                fee_state: "unfunded".into(),
                fee_attempt: 0,
            },
        );
        g.projects.push(project_id.clone());
        self.guilds.insert(&guild_id, &g);
        self.charge(&env::predecessor_account_id(), before);
        event(
            "project_open",
            near_sdk::serde_json::json!({"project_id":project_id,"terms_hash":hash}),
        );
        hash
    }
    /// Accept only direct contributions from the configured economy MT. Repeated operation IDs return every new token.
    pub fn mt_on_transfer(
        &mut self,
        sender_id: AccountId,
        previous_owner_ids: Vec<AccountId>,
        token_ids: Vec<String>,
        amounts: Vec<U128>,
        msg: String,
    ) -> Vec<U128> {
        require!(
            env::predecessor_account_id() == self.economy_mt,
            "Only verified economy MT"
        );
        require!(msg.len() <= 1024, "Message too large");
        let m: Message =
            near_sdk::serde_json::from_str(&msg).expect("Invalid contribution message");
        identifier(&m.operation_id);
        require!(
            !token_ids.is_empty()
                && token_ids.len() <= 3
                && token_ids.len() == amounts.len()
                && previous_owner_ids.len() == amounts.len(),
            "Invalid batch"
        );
        require!(
            previous_owner_ids.iter().all(|a| a == &sender_id),
            "Contributor owner mismatch"
        );
        if self.contributions.get(&m.operation_id).is_some() {
            return amounts;
        }
        let mut p = self.projects.get(&m.project_id).expect("Unknown project");
        self.active_guild(&p.guild_id);
        require!(
            self.is_member(&p.guild_id, &sender_id),
            "Active member required"
        );
        require!(
            p.status == "open" && env::block_timestamp() < p.deadline,
            "Project closed or expired"
        );
        require!(m.terms_hash == p.terms_hash, "Terms mismatch");
        require!(p.contributions.len() < 128, "Contribution limit");
        for (i, t) in token_ids.iter().enumerate() {
            require!(!token_ids[..i].contains(t), "Duplicate token");
            let idx = TOKENS
                .iter()
                .position(|s| s == t)
                .expect("Unsupported material");
            require!(
                amounts[i].0 > 0 && amounts[i].0 <= INPUTS[idx] - p.totals[idx].0,
                "Target exceeded"
            );
            p.totals[idx].0 += amounts[i].0;
        }
        let before = env::storage_usage();
        p.contributions.push(m.operation_id.clone());
        self.projects.insert(&m.project_id, &p);
        self.contributions.insert(
            &m.operation_id,
            &Contribution {
                project_id: m.project_id.clone(),
                contributor: sender_id.clone(),
                token_ids,
                amounts: amounts.clone(),
                status: "escrow".into(),
                attempt: 0,
            },
        );
        self.charge(&sender_id, before);
        event(
            "contribute",
            near_sdk::serde_json::json!({"project_id":m.project_id,"operation_id":m.operation_id,"contributor":sender_id,"amounts":amounts}),
        );
        vec![U128(0); amounts.len()]
    }
    pub fn ft_on_transfer(&mut self, sender_id: AccountId, amount: U128, msg: String) -> U128 {
        require!(
            env::predecessor_account_id() == self.foxo_contract_id,
            "Wrong FOXO contract"
        );
        if msg.len() > 512 {
            return amount;
        }
        let Ok(m) = near_sdk::serde_json::from_str::<FeeMessage>(&msg) else {
            return amount;
        };
        let Some(mut p) = self.projects.get(&m.project_id) else {
            return amount;
        };
        if p.status != "open"
            || p.fee_state != "unfunded"
            || p.fee_payer != sender_id
            || p.terms_hash != m.terms_hash
            || amount.0 != FEE
            || env::block_timestamp() >= p.deadline
            || !self.guilds.get(&p.guild_id).is_some_and(|g| g.active)
        {
            return amount;
        }
        p.fee_state = "held".into();
        self.projects.insert(&m.project_id, &p);
        U128(0)
    }
    pub fn commit(&mut self, project_id: String) -> Promise {
        let mut p = self.projects.get(&project_id).expect("Unknown project");
        self.manager(&p.guild_id);
        require!(
            p.status == "open" && env::block_timestamp() < p.deadline,
            "Project closed or expired"
        );
        require!(
            p.totals.iter().map(|x| x.0).eq(INPUTS),
            "Project not fully funded"
        );
        require!(p.fee_state == "held", "15 FOXO fee required");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(150),
            "Insufficient commit gas"
        );
        p.status = "committing".into();
        p.fee_state = "in_flight".into();
        p.fee_attempt += 1;
        self.projects.insert(&project_id, &p);
        ft::ext(self.foxo_contract_id.clone()).with_attached_deposit(NearToken::from_yoctonear(1)).with_static_gas(Gas::from_tgas(95)).ft_transfer_call(self.economy_mt.clone(),U128(FEE),None,near_sdk::serde_json::json!({"action":"guild_commit","projectId":project_id,"termsHash":p.terms_hash}).to_string()).then(callback::ext(env::current_account_id()).with_static_gas(Gas::from_tgas(40)).on_commit_transfer(project_id,p.fee_attempt))
    }
    #[private]
    pub fn on_commit_transfer(&mut self, project_id: String, attempt: u64) -> PromiseOrValue<bool> {
        self.private_callback();
        let mut p = self.projects.get(&project_id).expect("Unknown project");
        if p.status != "committing" || p.fee_attempt != attempt {
            return PromiseOrValue::Value(false);
        }
        if let PromiseResult::Successful(bytes) = env::promise_result(0) {
            if near_sdk::serde_json::from_slice::<U128>(&bytes).ok() == Some(U128(0)) {
                p.fee_state = "held".into();
                self.projects.insert(&project_id, &p);
            }
        }
        PromiseOrValue::Promise(self.receipt_query(project_id, attempt))
    }
    pub fn reconcile_commit(&mut self, project_id: String) -> Promise {
        let p = self.projects.get(&project_id).expect("Unknown project");
        require!(p.status == "committing", "No pending commit");
        self.receipt_query(project_id, p.fee_attempt)
    }
    #[private]
    pub fn on_commit_receipt(&mut self, project_id: String, attempt: u64) -> bool {
        self.private_callback();
        let mut p = self.projects.get(&project_id).expect("Unknown project");
        if p.status != "committing" || p.fee_attempt != attempt {
            return false;
        }
        let PromiseResult::Successful(bytes) = env::promise_result(0) else {
            return false;
        };
        let Ok(receipt) = near_sdk::serde_json::from_slice::<Option<CommitReceipt>>(&bytes) else {
            return false;
        };
        if let Some(r) = receipt {
            require!(
                r.guild_contract_id == env::current_account_id()
                    && r.project_id == project_id
                    && r.terms_hash == p.terms_hash
                    && r.fee_atomic.0 == FEE
                    && r.inputs.alloy == 48
                    && r.inputs.core == 2
                    && r.inputs.catalyst == 2,
                "Conflicting canonical receipt"
            );
            p.status = "committed".into();
            p.fee_state = "spent".into();
            self.projects.insert(&project_id, &p);
            event(
                "commit",
                near_sdk::serde_json::json!({"project_id":project_id,"terms_hash":p.terms_hash,"fee_atomic":U128(FEE),"output":"guild-banner-beacon-v2","transferable":false}),
            );
            true
        } else {
            if p.fee_state == "held" {
                p.status = "open".into();
                self.projects.insert(&project_id, &p);
            }
            false
        }
    }
    pub fn refund_fee(&mut self, project_id: String) -> Promise {
        let mut p = self.projects.get(&project_id).expect("Unknown project");
        require!(
            p.status == "cancelled" || p.status == "expired",
            "No uncommitted fee refund"
        );
        require!(p.fee_state == "held", "Fee not refundable");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(55),
            "Insufficient refund gas"
        );
        p.fee_state = "refund_pending".into();
        p.fee_attempt += 1;
        self.projects.insert(&project_id, &p);
        ft::ext(self.foxo_contract_id.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .ft_transfer(
                p.fee_payer,
                U128(FEE),
                Some(format!("guild-fee-refund:{project_id}")),
            )
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_fee_refund(project_id, p.fee_attempt),
            )
    }
    #[private]
    pub fn on_fee_refund(&mut self, project_id: String, attempt: u64) -> bool {
        self.private_callback();
        let mut p = self.projects.get(&project_id).expect("Unknown project");
        if p.fee_state != "refund_pending" || p.fee_attempt != attempt {
            return false;
        }
        let ok = matches!(env::promise_result(0), PromiseResult::Successful(_));
        p.fee_state = if ok { "refunded" } else { "held" }.into();
        self.projects.insert(&project_id, &p);
        ok
    }
    pub fn cancel(&mut self, project_id: String) -> bool {
        let p = self.projects.get(&project_id).expect("Unknown project");
        self.manager(&p.guild_id);
        self.close(project_id, "cancelled")
    }
    pub fn expire(&mut self, project_id: String) -> bool {
        let p = self.projects.get(&project_id).expect("Unknown project");
        require!(env::block_timestamp() >= p.deadline, "Deadline not passed");
        self.close(project_id, "expired")
    }
    pub fn disband(&mut self, guild_id: String) -> bool {
        let mut g = self.guilds.get(&guild_id).expect("Unknown guild");
        require!(env::predecessor_account_id() == g.leader, "Only leader");
        if !g.active {
            return false;
        }
        require!(
            !g.projects.iter().any(|id| self
                .projects
                .get(id)
                .is_some_and(|p| p.status == "committing")),
            "Reconcile pending commit before disband"
        );
        g.active = false;
        g.epoch += 1;
        self.guilds.insert(&guild_id, &g);
        for pid in g.projects {
            let mut p = self.projects.get(&pid).unwrap();
            if p.status == "open" {
                p.status = "cancelled".into();
            } else if p.status == "committed" {
                p.status = "archived".into();
            }
            self.projects.insert(&pid, &p);
        }
        event(
            "disband",
            near_sdk::serde_json::json!({"guild_id":guild_id}),
        );
        true
    }
    pub fn can_display(&self, project_id: String, account_id: AccountId) -> bool {
        let Some(p) = self.projects.get(&project_id) else {
            return false;
        };
        p.status == "committed"
            && self
                .guilds
                .get(&p.guild_id)
                .map(|g| g.active)
                .unwrap_or(false)
            && self.is_member(&p.guild_id, &account_id)
    }
    /// Anyone can retry delivery; destination is immutable contributor. Never reduces liability before success.
    pub fn refund(&mut self, operation_id: String) -> Promise {
        let mut c = self
            .contributions
            .get(&operation_id)
            .expect("Unknown contribution");
        let p = self.projects.get(&c.project_id).unwrap();
        require!(
            p.status == "cancelled" || p.status == "expired",
            "No uncommitted refund"
        );
        require!(c.status == "escrow", "Refund pending or delivered");
        require!(
            env::prepaid_gas() >= Gas::from_tgas(55),
            "Insufficient refund gas"
        );
        c.attempt = c.attempt.checked_add(1).expect("Attempt overflow");
        c.status = "pending".into();
        self.contributions.insert(&operation_id, &c);
        mt::ext(self.economy_mt.clone())
            .with_attached_deposit(NearToken::from_yoctonear(1))
            .with_static_gas(Gas::from_tgas(30))
            .mt_batch_transfer(
                c.contributor,
                c.token_ids,
                c.amounts,
                None,
                Some(format!("guild-refund:{operation_id}:{}", c.attempt)),
            )
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_refund(operation_id, c.attempt),
            )
    }
    #[private]
    pub fn on_refund(&mut self, operation_id: String, attempt: u64) -> bool {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Private callback"
        );
        let mut c = self
            .contributions
            .get(&operation_id)
            .expect("Unknown contribution");
        if c.status != "pending" || c.attempt != attempt {
            return false;
        }
        require!(
            env::promise_results_count() == 1,
            "Expected transfer receipt"
        );
        let success = matches!(env::promise_result(0), PromiseResult::Successful(_));
        c.status = if success { "refunded" } else { "escrow" }.into();
        self.contributions.insert(&operation_id, &c);
        event(
            "refund_result",
            near_sdk::serde_json::json!({"operation_id":operation_id,"attempt":attempt,"success":success}),
        );
        success
    }
    pub fn approve_manager_change(
        &mut self,
        guild_id: String,
        role: String,
        account_id: AccountId,
    ) -> bool {
        let mut g = self.active_guild(&guild_id);
        require!(
            g.threshold >= 2 && g.threshold as usize <= g.governors.len(),
            "Governance disabled"
        );
        require!(role == "leader" || role == "treasurer", "Invalid role");
        let actor = env::predecessor_account_id();
        require!(
            g.governors.contains(&actor) && self.is_member(&guild_id, &actor),
            "Active governor required"
        );
        require!(
            self.is_member(&guild_id, &account_id),
            "Target must be active"
        );
        let proposal = format!("{}:{}:{}:{}", guild_id, g.epoch, role, account_id);
        let mut a = self.approvals.get(&proposal).unwrap_or(Approval {
            epoch: g.epoch,
            voters: vec![],
        });
        if a.voters.contains(&actor) {
            return false;
        }
        let before = env::storage_usage();
        a.voters.push(actor.clone());
        let count = a
            .voters
            .iter()
            .filter(|v| g.governors.contains(v) && self.is_member(&guild_id, v))
            .count();
        if count >= g.threshold as usize {
            if role == "leader" {
                g.leader = account_id;
            } else {
                g.treasurer = account_id;
            }
            g.epoch += 1;
            self.guilds.insert(&guild_id, &g);
            self.approvals.remove(&proposal);
            self.charge(&actor, before);
            event(
                "manager_change",
                near_sdk::serde_json::json!({"guild_id":guild_id,"role":role,"epoch":g.epoch}),
            );
            true
        } else {
            self.approvals.insert(&proposal, &a);
            self.charge(&actor, before);
            false
        }
    }
}
impl Contract {
    fn private_callback(&self) {
        require!(
            env::predecessor_account_id() == env::current_account_id(),
            "Private callback"
        );
        require!(env::promise_results_count() == 1, "Expected one receipt");
    }
    fn receipt_query(&self, project_id: String, attempt: u64) -> Promise {
        economy::ext(self.economy_mt.clone())
            .with_static_gas(Gas::from_tgas(10))
            .get_guild_commit_receipt(env::current_account_id(), project_id.clone())
            .then(
                callback::ext(env::current_account_id())
                    .with_static_gas(Gas::from_tgas(15))
                    .on_commit_receipt(project_id, attempt),
            )
    }
    fn is_member(&self, g: &str, a: &AccountId) -> bool {
        self.members.get(&key(g, a)).unwrap_or(false)
    }
    fn active_guild(&self, g: &str) -> Guild {
        let g = self.guilds.get(&g.to_string()).expect("Unknown guild");
        require!(g.active, "Guild closed");
        g
    }
    fn manager(&self, gid: &str) -> Guild {
        let g = self.active_guild(gid);
        let a = env::predecessor_account_id();
        require!(
            (a == g.leader || a == g.treasurer) && self.is_member(gid, &a),
            "Manager required"
        );
        g
    }
    fn charge(&mut self, a: &AccountId, before: u64) {
        let cost = u128::from(env::storage_usage().saturating_sub(before))
            * env::storage_byte_cost().as_yoctonear();
        let credit = self.storage_credit.get(a).unwrap_or(0);
        require!(credit >= cost, "Insufficient prepaid storage");
        if cost > 0 {
            self.storage_credit.insert(a, &(credit - cost));
        }
    }
    fn close(&mut self, id: String, status: &str) -> bool {
        let mut p = self.projects.get(&id).expect("Unknown project");
        if p.status == status {
            return false;
        }
        require!(p.status == "open", "Committed or closed project");
        p.status = status.into();
        self.projects.insert(&id, &p);
        event(
            "project_close",
            near_sdk::serde_json::json!({"project_id":id,"status":status}),
        );
        true
    }
}

const FEE: u128 = 15 * 10u128.pow(24);
#[near(serializers=[json])]
#[serde(deny_unknown_fields)]
struct FeeMessage {
    project_id: String,
    terms_hash: String,
}
#[near(serializers=[json])]
struct Inputs {
    alloy: u32,
    core: u32,
    catalyst: u32,
}
#[near(serializers=[json])]
struct CommitReceipt {
    guild_contract_id: AccountId,
    project_id: String,
    terms_hash: String,
    fee_atomic: U128,
    inputs: Inputs,
}
#[allow(dead_code)]
#[ext_contract(ft)]
trait FungibleToken {
    fn ft_transfer_call(
        &mut self,
        receiver_id: AccountId,
        amount: U128,
        memo: Option<String>,
        msg: String,
    ) -> U128;
    fn ft_transfer(&mut self, receiver_id: AccountId, amount: U128, memo: Option<String>);
}
#[allow(dead_code)]
#[ext_contract(economy)]
trait Economy {
    fn get_guild_commit_receipt(
        &self,
        guild_contract_id: AccountId,
        project_id: String,
    ) -> Option<CommitReceipt>;
}
