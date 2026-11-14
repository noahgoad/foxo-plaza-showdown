import { raidRole } from '../game/boss-raid-rules.js';
import { defaultWorkshopSkill, validateWorkshopSkill, workshopIdentity, workshopOptions } from '../game/skill-workshop.js';
import affinities from '../../assets/near-fox/affinities.json' with {type:'json'};
import careerCatalogue from '../../assets/near-fox/career-entitlements.json' with {type:'json'};

function genesisIdentity(nft) {
  const identity = workshopIdentity(nft);
  return identity.startsWith(affinities.collectionId + ':') ? identity : null;
}

function bossWins(checkpoint) {
  const wins = checkpoint?.bossWins;
  return Number.isSafeInteger(wins) && wins >= 0 ? wins : 0;
}

export function foxAffinity(objective) {
  const identity = genesisIdentity(objective);
  if (identity) return affinities.tokens[identity.split(':')[1]];
  const role = raidRole(objective).id;
  return role === 'medic' ? 'support' : role;
}

// Supply finalized checkpoints from the authenticated account and current Fox.
// Either milestone path can unlock a choice. Progress from the two paths is
// never added, since one Boss clear may count toward both checkpoints.
export function nearWorkshopProgress(nft, accountCheckpoint, careerCheckpoint) {
  const identity = genesisIdentity(nft);
  if (!identity) {
    return { identity: 'guest', source: 'near-account', wins: bossWins(accountCheckpoint) };
  }
  return { identity, source: 'near-fox', wins: Math.max(bossWins(accountCheckpoint), bossWins(careerCheckpoint)) };
}

export function foxCareerEntitlements(nft, checkpoint = {}) {
  const identity = genesisIdentity(nft);
  if (!identity) return null;
  const wins = bossWins(checkpoint);
  const progress = nearWorkshopProgress(nft, null, checkpoint);
  const presets = [];
  const seen = new Set();
  for (const candidate of Array.isArray(checkpoint.presets) ? checkpoint.presets : []) {
    let preset;
    try { preset = validateWorkshopSkill(candidate, nft, progress); } catch { continue; }
    const key = JSON.stringify(preset);
    if (seen.has(key)) continue;
    seen.add(key);
    presets.push(preset);
  }
  const title = careerCatalogue.titles.find(row => wins >= row.requiredBossWins);
  return {
    version: careerCatalogue.version, identity, title: title ? { ...title } : null, presets,
    visualVariations: careerCatalogue.visualVariations.slice(),
    skillPresentations: careerCatalogue.skillPresentations.slice(),
  };
}

export function foxSpecializationBuild(nft, role, progress = {}) {
  const options = workshopOptions(nft, progress);
  const effect = { breaker: 'empower', guardian: 'ward', support: 'mend' }[role];
  if (!effect) throw new Error('Unknown Fox specialization.');
  const recipe = defaultWorkshopSkill(nft);
  if (options.effects.some(choice => choice.id === effect && choice.unlocked)) recipe.effect = effect;
  return validateWorkshopSkill(recipe, nft, progress);
}
