import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { objectiveFromNft } from '../../src/game/chog-objectives.js';
import { defaultWorkshopSkill, loadWorkshopSkill, resolveWorkshopSkill, saveWorkshopSkill, validateWorkshopSkill, workshopIdentity, workshopOptions } from '../../src/game/skill-workshop.js';
import { createHuntRelay } from '../../server/hunt-relay.mjs';
import { createFoxPassport } from '../../server/near/passport.mjs';
import { createFoxPassportRoutes } from '../../server/near/passport-routes.mjs';

test('the exported Genesis affinity map covers each mint metadata record and respects the Workshop budget', async () => {
  const {foxAffinity, foxSpecializationBuild} = await import('../../src/economy/specializations.js');
  const read = async path => JSON.parse(await readFile(new URL('../../' + path, import.meta.url), 'utf8'));
  const mint = await read('nft-art/testnet-88/mint-plan.json');
  const mapping = await read('assets/near-fox/affinities.json');
  const distribution = {breaker:0, guardian:0, support:0};
  assert.equal(mint.tokens.length, 88);
  assert.equal(mapping.version, 1);
  for (const {token_id, token_metadata} of mint.tokens) {
    const {attributes} = JSON.parse(token_metadata.extra);
    const profile = {tokenId:token_id, name:token_metadata.title, image:token_metadata.media,
      contract:mapping.collectionId, attributes};
    const objective = objectiveFromNft(profile);
    assert.equal(foxAffinity(objective), mapping.tokens[token_id]);
    const role = foxAffinity({ ...objective, contract: mapping.collectionId });
    assert.equal(mapping.tokens[token_id], role);
    distribution[role]++;
    const recipe = foxSpecializationBuild(profile, role);
    assert.deepEqual(validateWorkshopSkill(recipe, profile), recipe);
  }
  assert.equal(Object.keys(mapping.tokens).length, 88);
  assert.deepEqual(mapping.distribution, distribution);
  assert.ok(Object.values(distribution).every(count => count > 0));
});

const collectionId = 'fox.xuancanh1.testnet';
const fox = {collectionId, tokenId:'045'};

test('all three NEAR builds use distinct effects within the same five point budget', async () => {
  const {foxSpecializationBuild} = await import('../../src/economy/specializations.js');
  for (const [role, effect] of Object.entries({breaker:'empower', guardian:'ward', support:'mend'})) {
    const build = foxSpecializationBuild(fox, role);
    assert.equal(build.effect, effect);
    assert.ok(resolveWorkshopSkill(build, fox).cost <= 5);
  }
});

test('account Boss milestones are equivalent and do not combine partial progress with Fox milestones', async () => {
  const {nearWorkshopProgress} = await import('../../src/economy/specializations.js');
  for (const [bossWins, expected] of [[0, []], [1, ['lasting']], [2, ['nearby','lasting']], [3, ['nearby','focused','lasting']]]) {
    const npc = nearWorkshopProgress(null, {bossWins});
    const options = workshopOptions(null, npc);
    assert.deepEqual([...options.targets, ...options.modifiers].filter(row => row.requiredWins && row.unlocked).map(row => row.id), expected);
    const career = nearWorkshopProgress(fox, {bossWins:0}, {bossWins});
    assert.equal(workshopOptions(fox, career).wins, bossWins);
  }
  const progress = nearWorkshopProgress(fox, {bossWins:1}, {bossWins:1});
  assert.equal(workshopOptions(fox, progress).wins, 1);
  assert.equal(workshopOptions({...fox, tokenId:'046'}, progress).wins, 0);
  assert.equal(workshopOptions(null, nearWorkshopProgress(null, {wins:100})).wins, 0);
  assert.equal(workshopOptions(null, {identity:'guest', wins:100}).wins, 0);
  assert.throws(() => resolveWorkshopSkill({...defaultWorkshopSkill(fox), effect:'empower', target:'nearby', modifier:'focused'},
    fox, nearWorkshopProgress(fox, {bossWins:3})), /budget/i);
});

test('the transferable career view carries validated presets and title but excludes account rights', async () => {
  const {foxCareerEntitlements, nearWorkshopProgress} = await import('../../src/economy/specializations.js');
  const preset = {...defaultWorkshopSkill(fox), modifier:'focused'};
  const snapshot = {bossWins:3, presets:[preset, {...preset, itemId:'account-gear'}],
    accountBadge:'personal', recipeLicense:'armorer', rewardAccountId:'seller.testnet'};
  const seller = foxCareerEntitlements({...fox, ownerId:'seller.testnet'}, snapshot);
  const buyer = foxCareerEntitlements({...fox, ownerId:'buyer.testnet'}, snapshot);
  const borrower = foxCareerEntitlements({...fox, actorId:'borrower.testnet'}, snapshot);
  assert.deepEqual(buyer, seller);
  assert.deepEqual(borrower, seller);
  assert.equal(buyer.title.id, 'fox-boss-veteran');
  assert.deepEqual(buyer.presets, [preset]);
  assert.equal(buyer.visualVariations.length, 0);
  assert.ok(!Object.hasOwn(buyer, 'accountBadge') && !Object.hasOwn(buyer, 'recipeLicense') && !Object.hasOwn(buyer, 'rewardAccountId'));
  assert.deepEqual(foxCareerEntitlements(fox, {...snapshot, bossWins:0}).presets, []);
  assert.equal(workshopOptions(null, nearWorkshopProgress(null, {bossWins:0})).wins, 0);
});

test('signed-in players without a Fox keep independent local Workshop selections', () => {
  const values = new Map();
  const storage = {getItem:key => values.get(key), setItem:(key,value) => values.set(key,value)};
  const alice = {identity:'guest', source:'near-account', storageScope:'alice.testnet', wins:3};
  const bob = {...alice, storageScope:'bob.testnet'};
  const recipe = {...defaultWorkshopSkill(null), effect:'ward', modifier:'focused'};
  saveWorkshopSkill(storage, recipe, null, alice);
  assert.deepEqual(loadWorkshopSkill(storage, null, alice), recipe);
  assert.deepEqual(loadWorkshopSkill(storage, null, bob), defaultWorkshopSkill(null));
  assert.deepEqual(loadWorkshopSkill(storage, null), defaultWorkshopSkill(null));
});

test('authenticated NEAR Workshop unlocks reach the Boss roster and Trials still use the standard kit', async () => {
  const database = new DatabaseSync(':memory:');
  const account = 'alice.testnet';
  const passport = createFoxPassport({database});
  for (const [index, mode, finalized] of [[1,'boss',true], [2,'boss',true], [3,'boss',true], [4,'hunt',true], [5,'boss',false]]) {
    const matchId = 'match-' + index;
    const resultHash = String(index).repeat(64);
    passport.ingest({matchId, accountId:account, nft:null, mode, won:true, xp:10, resultHash, rulesVersion:'fixture', finishedAt:index});
    if (finalized) passport.finalize(matchId, account, resultHash);
  }
  const nearAuth = {account(token) {
    if (token !== 'fixture-session') throw new Error('Invalid session');
    return account;
  }};
  const server = createHuntRelay({nearAuth, nearPassport:passport,
    nearRoutes:createFoxPassportRoutes({passport, nearAuth})});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const call = async (action, data, token) => {
    const response = await fetch(base + '/' + action, {method:'POST',
      headers:{'Content-Type':'application/json', ...(token ? {Authorization:'Bearer ' + token} : {})},
      body:JSON.stringify(data)});
    return {status:response.status, ...await response.json()};
  };
  try {
    const denied = await call('near/workshop/progress', {accountId:account});
    assert.equal(denied.status, 400);
    const checkpoint = await call('near/workshop/progress', {nearSession:'fixture-session', accountId:'bob.testnet'});
    assert.equal(checkpoint.status, 200);
    assert.equal(checkpoint.progress.wins, 3);
    const chosen = {...defaultWorkshopSkill(null), effect:'ward', modifier:'focused'};
    for (const mode of ['boss', 'trials']) {
      const joined = await call('create', {identity:'guest', nearSession:'fixture-session',
        workshopSkill:chosen, workshopProgress:{wins:99}, raidSkill:'workshop'});
      const code = joined.room.code;
      await call('settings', {code, mode}, joined.token);
      const started = await call('start', {code}, joined.token);
      assert.equal(started.status, 200);
      assert.equal(started.room.roster[0].workshopProgress.wins, 3);
      assert.deepEqual(started.room.roster[0].workshopSkill, mode === 'boss' ? chosen : defaultWorkshopSkill(null));
    }
  } finally {
    await new Promise(resolve => server.close(resolve));
    database.close();
  }
});

test('guests can use all basic builds and Boss wins unlock higher options within the same budget', async () => {
  const {foxSpecializationBuild} = await import('../../src/economy/specializations.js');
  for (const id of ['breaker','guardian','support']) {
    const recipe = foxSpecializationBuild(null, id);
    assert.deepEqual(validateWorkshopSkill(recipe, null), recipe);
  }
  const guest = {identity:workshopIdentity(null), wins:3};
  const options = workshopOptions(null, guest);
  assert.equal(options.modifiers.find(item => item.id === 'focused').unlocked, false);
});
