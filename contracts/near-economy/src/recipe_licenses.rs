use crate::{Economy, EconomyExt, Recipe};
use near_sdk::{collections::{LookupMap, LookupSet}, near, require, AccountId};

fn license_for(recipe: &Recipe) -> Option<&'static str> {
    match recipe.sku.as_str() {
        "weapon-finish-aurora-v2" => Some("armorer:aurora-v2"),
        "outfit-recolor-tide-v2" => Some("stylist:tide-v2"),
        _ => None,
    }
}

fn licenses() -> LookupSet<(AccountId, String)> {
    LookupSet::new(b"catalogue/v2/recipe-licenses".to_vec())
}

#[near]
impl Economy {
    pub fn record_profession_matches(&mut self, account_id: AccountId, matches: Vec<ProfessionMatch>) -> bool {
        self.assert_settlement_signer();
        require!(!matches.is_empty() && matches.len() <= 3, "Invalid evidence batch");
        let mut records = profession_records();
        let mut progress = records.get(&account_id).unwrap_or_default();
        let mut changed = false;
        for evidence in matches {
            require!(
                !evidence.match_id.is_empty() && evidence.match_id.len() <= 128 &&
                evidence.match_id.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-'),
                "Invalid match ID"
            );
            if progress.match_ids.contains(&evidence.match_id) {
                continue;
            }
            let useful = match evidence.kind {
                ProfessionMatchKind::Match => false,
                ProfessionMatchKind::BossClear => !std::mem::replace(&mut progress.boss, true),
                ProfessionMatchKind::TrialClear => !std::mem::replace(&mut progress.trial, true),
            };
            if progress.matches < 3 || useful {
                progress.matches = (progress.matches + 1).min(3);
                progress.match_ids.push(evidence.match_id);
                changed = true;
            }
        }
        if changed {
            if progress.matches >= 3 {
                if progress.boss {
                    licenses().insert(&(account_id.clone(), "armorer:aurora-v2".into()));
                }
                if progress.trial {
                    licenses().insert(&(account_id.clone(), "stylist:tide-v2".into()));
                }
            }
            records.insert(&account_id, &progress);
        }
        changed
    }

    pub fn get_profession_progress(&self, account_id: AccountId) -> ProfessionProgress {
        profession_records().get(&account_id).unwrap_or_default()
    }

    pub fn get_recipe_license(&self, account_id: AccountId, license_id: String) -> bool {
        licenses().contains(&(account_id, license_id))
    }

    pub(crate) fn can_craft_recipe(&self, owner: &AccountId, recipe: &Recipe) -> bool {
        license_for(recipe).is_none_or(|license| {
            licenses().contains(&(owner.clone(), license.to_string()))
        })
    }
}

#[near(serializers = [json])]
pub struct ProfessionMatch {
    match_id: String,
    kind: ProfessionMatchKind,
}

#[near(serializers = [json])]
#[serde(rename_all = "snake_case")]
enum ProfessionMatchKind {
    Match,
    BossClear,
    TrialClear,
}

#[near(serializers = [borsh, json])]
#[serde(rename_all = "camelCase")]
#[derive(Default)]
pub struct ProfessionProgress {
    matches: u8,
    boss: bool,
    trial: bool,
    match_ids: Vec<String>,
}

fn profession_records() -> LookupMap<AccountId, ProfessionProgress> {
    LookupMap::new(b"catalogue/v2/profession-progress".to_vec())
}
