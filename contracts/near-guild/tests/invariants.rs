use near_guild::Contract;
use near_sdk::{
    json_types::U128, test_utils::VMContextBuilder, testing_env, AccountId, PromiseResult,
};
fn id(s: &str) -> AccountId {
    s.parse().unwrap()
}
fn ctx(actor: &str, timestamp: u64) {
    let mut c = VMContextBuilder::new();
    c.current_account_id(id("guild.test.near"))
        .predecessor_account_id(id(actor))
        .block_timestamp(timestamp)
        .attached_deposit(near_sdk::NearToken::from_near(1));
    testing_env!(c.build());
}
fn setup() -> Contract {
    ctx("guild.test.near", 1);
    let mut c = Contract::new(id("economy.near"), id("foxo.near"));
    ctx("alice.near", 1);
    c.fund_storage();
    c.create_guild("fox".into(), vec![id("alice.near"), id("bob.near")], 2);
    ctx("bob.near", 1);
    c.fund_storage();
    c.join("fox".into());
    ctx("alice.near", 1);
    c.open_project("p1".into(), "fox".into(), 100);
    c
}
fn deposit(c: &mut Contract, actor: &str, op: &str, ids: Vec<&str>, values: Vec<u128>) {
    let p = c.project("p1".into()).unwrap();
    ctx("economy.near", 2);
    c.mt_on_transfer(
        id(actor),
        vec![id(actor); ids.len()],
        ids.iter().map(|s| s.to_string()).collect(),
        values.into_iter().map(U128).collect(),
        format!(
            r#"{{"project_id":"p1","terms_hash":"{}","operation_id":"{}"}}"#,
            p.terms_hash, op
        ),
    );
}
#[test]
fn commit_requires_full_target_and_output_follows_active_membership() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "core", "catalyst"],
        vec![48, 2, 2],
    );
    ctx("alice.near", 3);
    commit_full(&mut c);
    assert!(c.can_display("p1".into(), id("bob.near")));
    ctx("bob.near", 4);
    c.leave("fox".into());
    assert!(!c.can_display("p1".into(), id("bob.near")));
    assert_eq!(c.contribution("one".into()).unwrap().amounts[0], U128(48));
}
#[test]
#[should_panic(expected = "funded")]
fn partial_inputs_cannot_commit() {
    let mut c = setup();
    deposit(&mut c, "alice.near", "one", vec!["alloy"], vec![48]);
    ctx("alice.near", 3);
    c.commit("p1".into());
}
#[test]
#[should_panic(expected = "economy")]
fn spoofed_receiver_rejected() {
    let mut c = setup();
    let p = c.project("p1".into()).unwrap();
    ctx("evil.near", 2);
    c.mt_on_transfer(
        id("alice.near"),
        vec![id("alice.near")],
        vec!["alloy".into()],
        vec![U128(48)],
        format!(
            r#"{{"project_id":"p1","terms_hash":"{}","operation_id":"one"}}"#,
            p.terms_hash
        ),
    );
}
#[test]
fn refund_failure_restores_and_stale_callback_cannot_erase_retry() {
    let mut c = setup();
    deposit(&mut c, "alice.near", "one", vec!["alloy"], vec![10]);
    ctx("alice.near", 3);
    c.cancel("p1".into());
    c.refund("one".into());
    ctx("guild.test.near", 4);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!c.on_refund("one".into(), 1));
    assert_eq!(c.contribution("one".into()).unwrap().status, "escrow");
    ctx("alice.near", 5);
    c.refund("one".into());
    ctx("guild.test.near", 6);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(!c.on_refund("one".into(), 1));
    assert!(c.on_refund("one".into(), 2));
    assert!(!c.on_refund("one".into(), 2));
    assert_eq!(c.contribution("one".into()).unwrap().status, "refunded");
}
#[test]
fn governance_needs_distinct_active_approvals() {
    let mut c = setup();
    ctx("alice.near", 2);
    assert!(!c.approve_manager_change("fox".into(), "leader".into(), id("bob.near")));
    assert!(!c.approve_manager_change("fox".into(), "leader".into(), id("bob.near")));
    ctx("bob.near", 3);
    assert!(c.approve_manager_change("fox".into(), "leader".into(), id("bob.near")));
    assert_eq!(c.guild("fox".into()).unwrap().leader, id("bob.near"));
}

#[test]
fn outsider_cannot_leave_or_create_an_unfunded_membership_row() {
    let mut c = setup();
    ctx("outsider.near", 3);
    c.fund_storage();
    let credit = c.storage_credit(id("outsider.near"));
    let usage = near_sdk::env::storage_usage();
    assert!(!c.member("fox".into(), id("outsider.near")));
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        c.leave("fox".into());
    }));
    assert!(result.is_err(), "A never-joined account must be rejected");
    assert_eq!(near_sdk::env::storage_usage(), usage);
    assert_eq!(c.storage_credit(id("outsider.near")), credit);
    assert!(!c.member("fox".into(), id("outsider.near")));
}

#[test]
fn expiry_refunds_even_after_contributor_leaves() {
    let mut c = setup();
    deposit(&mut c, "bob.near", "one", vec!["alloy"], vec![10]);
    ctx("bob.near", 3);
    c.leave("fox".into());
    ctx("stranger.near", 101);
    assert!(c.expire("p1".into()));
    let _ = c.refund("one".into());
    let x = c.contribution("one".into()).unwrap();
    assert_eq!(x.contributor, id("bob.near"));
    assert_eq!(x.amounts, vec![U128(10)]);
    assert_eq!(x.status, "pending");
}
#[test]
fn duplicate_contribution_returns_every_new_token_without_new_credit() {
    let mut c = setup();
    deposit(&mut c, "alice.near", "one", vec!["alloy"], vec![10]);
    let p = c.project("p1".into()).unwrap();
    ctx("economy.near", 3);
    assert_eq!(
        c.mt_on_transfer(
            id("alice.near"),
            vec![id("alice.near")],
            vec!["alloy".into()],
            vec![U128(10)],
            format!(
                r#"{{"project_id":"p1","terms_hash":"{}","operation_id":"one"}}"#,
                p.terms_hash
            )
        ),
        vec![U128(10)]
    );
    assert_eq!(c.project("p1".into()).unwrap().totals[0], U128(10));
}
#[test]
#[should_panic(expected = "Terms mismatch")]
fn wrong_terms_rejected() {
    let mut c = setup();
    ctx("economy.near", 2);
    c.mt_on_transfer(
        id("alice.near"),
        vec![id("alice.near")],
        vec!["alloy".into()],
        vec![U128(1)],
        r#"{"project_id":"p1","terms_hash":"wrong","operation_id":"one"}"#.into(),
    );
}
#[test]
#[should_panic(expected = "Target exceeded")]
fn overfunding_rejected() {
    let mut c = setup();
    deposit(&mut c, "alice.near", "one", vec!["alloy"], vec![49]);
}
#[test]
#[should_panic(expected = "Contributor owner mismatch")]
fn contribution_cannot_spoof_previous_owner() {
    let mut c = setup();
    ctx("economy.near", 2);
    c.mt_on_transfer(
        id("alice.near"),
        vec![id("bob.near")],
        vec!["alloy".into()],
        vec![U128(1)],
        r#"{"project_id":"p1","terms_hash":"wrong","operation_id":"one"}"#.into(),
    );
}
#[test]
#[should_panic(expected = "Duplicate token")]
fn duplicate_materials_rejected() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "alloy"],
        vec![1, 1],
    );
}
#[test]
#[should_panic(expected = "Private callback")]
fn spoofed_refund_callback_rejected() {
    let mut c = setup();
    ctx("evil.near", 2);
    c.on_refund("one".into(), 1);
}
#[test]
#[should_panic(expected = "No uncommitted refund")]
fn committed_principal_cannot_be_withdrawn() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "core", "catalyst"],
        vec![48, 2, 2],
    );
    ctx("alice.near", 3);
    commit_full(&mut c);
    c.refund("one".into());
}
#[test]
#[should_panic(expected = "Invalid approval threshold")]
fn one_person_governance_rejected() {
    ctx("guild.test.near", 1);
    let mut c = Contract::new(id("economy.near"), id("foxo.near"));
    c.create_guild("g".into(), vec![id("alice.near")], 1);
}
#[test]
fn disband_archives_output_and_keeps_uncommitted_refundable() {
    let mut c = setup();
    deposit(&mut c, "alice.near", "one", vec!["alloy"], vec![10]);
    ctx("alice.near", 3);
    c.disband("fox".into());
    assert!(!c.can_display("p1".into(), id("alice.near")));
    ctx("bob.near", 4);
    let _ = c.refund("one".into());
    assert_eq!(c.contribution("one".into()).unwrap().status, "pending");
}

fn fund_fee(c: &mut Contract) {
    let p = c.project("p1".into()).unwrap();
    ctx("foxo.near", 3);
    assert_eq!(
        c.ft_on_transfer(
            id("alice.near"),
            U128(15 * 10u128.pow(24)),
            format!(r#"{{"project_id":"p1","terms_hash":"{}"}}"#, p.terms_hash)
        ),
        U128(0)
    );
}
fn commit_full(c: &mut Contract) {
    fund_fee(c);
    ctx("alice.near", 3);
    let _ = c.commit("p1".into());
    assert!(!c.can_display("p1".into(), id("bob.near")));
    let p = c.project("p1".into()).unwrap();
    let receipt = near_sdk::serde_json::json!({"guild_contract_id":"guild.test.near","project_id":"p1","terms_hash":p.terms_hash,"fee_atomic":(15*10u128.pow(24)).to_string(),"inputs":{"alloy":48,"core":2,"catalyst":2}});
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(
            near_sdk::serde_json::to_vec(&Some(receipt)).unwrap()
        )]
    );
    assert!(c.on_commit_receipt("p1".into(), 1));
}
#[test]
#[should_panic(expected = "15 FOXO fee required")]
fn no_banner_without_fee() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "core", "catalyst"],
        vec![48, 2, 2],
    );
    ctx("alice.near", 3);
    c.commit("p1".into());
}
#[test]
fn fee_is_exact_and_payer_bound() {
    let mut c = setup();
    let p = c.project("p1".into()).unwrap();
    let msg = format!(r#"{{"project_id":"p1","terms_hash":"{}"}}"#, p.terms_hash);
    ctx("foxo.near", 3);
    assert_eq!(
        c.ft_on_transfer(id("bob.near"), U128(15 * 10u128.pow(24)), msg.clone()),
        U128(15 * 10u128.pow(24))
    );
    assert_eq!(c.ft_on_transfer(id("alice.near"), U128(1), msg), U128(1));
}
#[test]
fn fee_transfer_unknown_receipt_stays_pending() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "core", "catalyst"],
        vec![48, 2, 2],
    );
    fund_fee(&mut c);
    ctx("alice.near", 3);
    c.commit("p1".into());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(b"null".to_vec())]
    );
    assert!(!c.on_commit_receipt("p1".into(), 1));
    assert_eq!(c.project("p1".into()).unwrap().status, "committing");
    assert!(!c.can_display("p1".into(), id("alice.near")));
}
#[test]
fn failed_fee_refund_restores_exact_fee_and_replay_cannot_double_pay() {
    let mut c = setup();
    fund_fee(&mut c);
    ctx("alice.near", 4);
    c.cancel("p1".into());
    c.refund_fee("p1".into());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Failed]
    );
    assert!(!c.on_fee_refund("p1".into(), 1));
    assert_eq!(c.project("p1".into()).unwrap().fee_state, "held");
    ctx("bob.near", 5);
    c.refund_fee("p1".into());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(vec![])]
    );
    assert!(!c.on_fee_refund("p1".into(), 1));
    assert!(c.on_fee_refund("p1".into(), 2));
    assert!(!c.on_fee_refund("p1".into(), 2));
    assert_eq!(c.project("p1".into()).unwrap().fee_state, "refunded");
}
#[test]
fn returned_fee_and_absent_receipt_unlock_commit_retry() {
    let mut c = setup();
    deposit(
        &mut c,
        "alice.near",
        "one",
        vec!["alloy", "core", "catalyst"],
        vec![48, 2, 2],
    );
    fund_fee(&mut c);
    ctx("alice.near", 3);
    c.commit("p1".into());
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(b"\"0\"".to_vec())]
    );
    let _ = c.on_commit_transfer("p1".into(), 1);
    testing_env!(
        VMContextBuilder::new()
            .current_account_id(id("guild.test.near"))
            .predecessor_account_id(id("guild.test.near"))
            .build(),
        near_sdk::test_vm_config(),
        near_sdk::RuntimeFeesConfig::test(),
        std::collections::HashMap::default(),
        vec![PromiseResult::Successful(b"null".to_vec())]
    );
    assert!(!c.on_commit_receipt("p1".into(), 1));
    let p = c.project("p1".into()).unwrap();
    assert_eq!(p.status, "open");
    assert_eq!(p.fee_state, "held");
    ctx("alice.near", 5);
    c.commit("p1".into());
    assert_eq!(c.project("p1".into()).unwrap().fee_attempt, 2);
}
#[test]
#[should_panic(expected = "Initializer must control contract account")]
fn stranger_cannot_initialize() {
    ctx("evil.near", 1);
    let _ = Contract::new(id("economy.near"), id("foxo.near"));
}
