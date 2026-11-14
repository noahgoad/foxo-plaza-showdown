import test from 'node:test';
import assert from 'node:assert/strict';
import * as THREE from 'three';
import { BossRaidRuntime } from '../../src/game/boss-raid-runtime.js';
import { hasStandardTrialKit, stepRankingObjectiveTelemetry } from '../../src/game/objective-runtime.js';
import { HuntCore } from '../../src/game/hunt-core.js';
import { Actor } from '../../src/game/actor.js';
import { defaultWorkshopSkill } from '../../src/game/skill-workshop.js';
import { G } from '../../src/core/ctx.js';

test('Hunt activity records only live opposing roles, and survives result serialization', () => {
  const players = Array.from({ length: 6 }, (_, i) => ({ id: 'p' + i }));
  const hunt = new HuntCore({ players, holderId: 'p0', traits: [{ id: 'one' }] });
  hunt.recordRankingActivity('p0', 1);
  for (let i = 0; i < 8; i++) hunt.step(1);
  hunt.players.get('p2').stun = 1;
  hunt.recordRankingActivity('p1', .4);
  hunt.recordRankingActivity('p0', .5);
  hunt.recordRankingActivity('p2', .5);
  hunt.finish();
  const result = JSON.parse(JSON.stringify(hunt.result));
  assert.deepEqual(result.players[0].rankingTelemetry, { version: 1, activeMs: 500, opponents: ['p1', 'p3', 'p4', 'p5'] });
  assert.deepEqual(result.players[1].rankingTelemetry, { version: 1, activeMs: 400, opponents: ['p0'] });
  assert.equal(result.players[2].rankingTelemetry.activeMs, 0);
});

test('Daily Trials locks the standard kit and attests only a solo runner with the baseline recipe', () => {
  const colors = G.teamColors;
  G.teamColors = [0, 1];
  try {
    const actor = new Actor({ team: 0, weapon: 'charger', sub: 'mine', special: 'sonar',
      trialKit: true, CharacterClass: class {} });
    actor.setWeapon('charger');
    actor.setSub('mine');
    actor.setSpecial('sonar');
    actor.workshopSkill = defaultWorkshopSkill(null);
    const core = { mode: 'trials', challenge: { weapon: 'shooter' } };
    assert.equal(actor.weaponId, 'shooter');
    assert.notEqual(actor.subId, 'mine');
    assert.notEqual(actor.specialId, 'sonar');
    assert.equal(hasStandardTrialKit(core, [actor]), true);
    assert.equal(hasStandardTrialKit(core, [actor, actor]), false);
    actor.workshopSkill.modifier = 'focused';
    assert.equal(hasStandardTrialKit(core, [actor]), false);
  } finally {
    G.teamColors = colors;
  }
});

test('actual Boss medic ability credits effective ally healing, excluding self and overheal', () => {
  const actor = (id, hp) => ({ huntId: id, hp, alive: true, pos: new THREE.Vector3(),
    raidNft: { traits: [] }, raidSkill: 'trait', raidRole: { id: 'medic' }, raidWins: 0, color: 0 });
  const actors = [actor('medic', 40), actor('ally', 95), actor('healthy', 100)];
  const stats = new Map(actors.map(a => [a.huntId, { healing: 0, blocked: 0, breaks: 0, allyHealing: 0, allyBlocked: 0, lastContributionAt: -Infinity }]));
  const runtime = { actors, stats, clock: 5, cooldowns: new Map(), buffs: new Map(), events: [], eventId: 0,
    match: { state: 'playing', boss: { pos: new THREE.Vector3() } }, core: { players: new Map(actors.map(a => [a.huntId, { left: false }])) },
    actor: id => actors.find(a => a.huntId === id), requirement: () => null };
  BossRaidRuntime.prototype.ability.call(runtime, 'medic');
  assert.equal(actors[0].hp, 60);
  assert.equal(actors[1].hp, 100);
  assert.equal(stats.get('medic').healing, 25);
  assert.equal(stats.get('medic').allyHealing, 5);
  assert.equal(stats.get('medic').lastContributionAt, 5);
});

test('actual incoming guard credits allies only and caps useful block by remaining HP', () => {
  const stats = new Map([['guard', { blocked: 0, allyBlocked: 0 }]]);
  const buffs = new Map([['ally', { guard: 20, guardian: 'guard' }], ['guard', { guard: 20, guardian: 'guard' }]]);
  const runtime = { stats, buffs, clock: 5 };
  assert.equal(BossRaidRuntime.prototype.incoming.call(runtime, { huntId: 'ally', hp: 10 }, 100), 80);
  assert.equal(stats.get('guard').allyBlocked, 0);
  BossRaidRuntime.prototype.incoming.call(runtime, { huntId: 'ally', hp: 100 }, 100);
  assert.equal(stats.get('guard').allyBlocked, 20);
  BossRaidRuntime.prototype.incoming.call(runtime, { huntId: 'guard', hp: 100 }, 100);
  assert.equal(stats.get('guard').allyBlocked, 20);
});

test('objective telemetry counts actual live ring presence and excludes AFK/dead/left actors', () => {
  const core = { mode: 'trials', phase: 'playing', time: 1, activeStation: 0,
    stations: [{ x: 0, y: 0, z: 0, radius: 4 }],
    players: new Map(['active', 'afk', 'dead', 'left'].map(id => [id, { left: id === 'left' }])) };
  const actors = ['active', 'afk', 'dead', 'left'].map(id => ({ huntId: id, team: 0, alive: id !== 'dead',
    pos: new THREE.Vector3(id === 'afk' ? 30 : 0, 0, 0) }));
  stepRankingObjectiveTelemetry(core, actors, 5);
  assert.equal(core.players.get('active').rankingTelemetry.activeMs, 1000);
  for (const id of ['afk', 'dead', 'left']) assert.equal(core.players.get(id).rankingTelemetry.activeMs, 0);
});
