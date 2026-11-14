import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createGuildProjects } from '../../server/near/guilds.mjs';

const alice='alice.testnet', bob='bob.testnet', carol='carol.testnet';
function fixture() {
  const database=new DatabaseSync(':memory:');
  let time=100;
  const make=()=>createGuildProjects({database, now:()=>time, catalogue:[
    {sku:'fixture-guild-banner',guildBound:true,transferable:false,displayRoles:['member','treasurer','owner']},
  ]});
  const guilds=make();
  guilds.create(alice,{guildId:'guild',treasurerId:bob});
  guilds.join(bob,'guild');
  guilds.join(carol,'guild');
  const terms={projectId:'project',guildId:'guild',sku:'fixture-guild-banner',targets:{alloy:'10',core:'2'},deadline:1000};
  guilds.open(bob,terms);
  return {guilds,make,database,terms,advance:ms=>time+=ms};
}
const fund=(g,actor,asset,amount,id)=>g.credit({receiptId:id,accountId:actor,asset,amount});
const contribute=(g,actor,asset,amount,id)=>g.contribute(actor,{projectId:'project',asset,amount,operationId:id,termsHash:g.project('project').termsHash});

test('contributions debit local balances atomically, bind terms and replay once',()=>{
  const {guilds:g,make}=fixture();
  fund(g,carol,'alloy','7','deposit');
  assert.equal(fund(g,carol,'alloy','7','deposit'),false);
  assert.throws(()=>fund(g,carol,'alloy','8','deposit'),/conflict/i);
  assert.throws(()=>g.contribute(carol,{projectId:'project',asset:'alloy',amount:'7',operationId:'x',termsHash:'wrong'}),/terms/i);
  assert.equal(contribute(g,carol,'alloy','7','c1'),true);
  assert.equal(contribute(make(),carol,'alloy','7','c1'),false);
  assert.equal(g.balance(carol,'alloy'),'0');
  assert.equal(g.project('project').status,'open');
  assert.throws(()=>contribute(g,carol,'alloy','8','c1'),/conflict/i);
  assert.throws(()=>contribute(g,carol,'alloy','1','c2'),/balance/i);
});

test('cancel refunds each contributor even after leaving, and repeat cancel cannot duplicate credit',()=>{
  const {guilds:g}=fixture();
  fund(g,carol,'alloy','7','a');fund(g,bob,'core','2','b');
  contribute(g,carol,'alloy','7','c');contribute(g,bob,'core','2','d');
  g.leave(carol,'guild');
  assert.equal(g.cancel(bob,'project'),true);
  assert.equal(g.cancel(bob,'project'),false);
  assert.equal(g.balance(carol,'alloy'),'7');
  assert.equal(g.balance(bob,'core'),'2');
  assert.equal(g.balance(alice,'alloy'),'0');
  assert.equal(g.project('project').contributions[0].accountId,carol);
});

test('commit consumes only a fully funded project and output rights follow active membership',()=>{
  const {guilds:g}=fixture();
  assert.throws(()=>g.commit(bob,'project'),/target/i);
  for(const [asset,amount] of [['alloy','10'],['core','2']]){fund(g,carol,asset,amount,asset);contribute(g,carol,asset,amount,'c-'+asset);}
  assert.equal(g.commit(bob,'project'),true);
  assert.equal(g.commit(bob,'project'),false);
  assert.equal(g.canDisplay(carol,'project'),true);
  g.leave(carol,'guild');
  assert.equal(g.canDisplay(carol,'project'),false);
  assert.throws(()=>g.cancel(bob,'project'),/committed/i);
  assert.equal(g.balance(carol,'alloy'),'0');
  assert.throws(()=>g.transferOutput(alice,'project',alice),/bound/i);
  assert.throws(()=>g.changeOwner(alice,'guild',bob),/approval/i);
  g.disband(alice,'guild');
  assert.equal(g.project('project').status,'archived');
  assert.equal(g.canDisplay(bob,'project'),false);
  assert.equal(g.project('project').contributions.length,2);
});

test('expiry and disband refund uncommitted funds once and block further commits',()=>{
  const {guilds:g,advance}=fixture();
  fund(g,carol,'alloy','10','d');contribute(g,carol,'alloy','10','c');
  advance(900);
  assert.throws(()=>g.commit(alice,'project'),/deadline/i);
  assert.equal(g.expire('project'),true);
  assert.equal(g.expire('project'),false);
  g.disband(alice,'guild');
  assert.equal(g.balance(carol,'alloy'),'10');
  assert.throws(()=>contribute(g,carol,'alloy','1','c2'),/open/i);
});

test('roles, overfunding, unsupported assets and invalid quantities fail without consuming balance',()=>{
  const {guilds:g}=fixture();
  fund(g,carol,'alloy','20','d');
  assert.throws(()=>g.cancel(carol,'project'),/role/i);
  assert.throws(()=>contribute(g,carol,'alloy','11','c1'),/target/i);
  for(const amount of ['0','-1','1.2','01'])assert.throws(()=>contribute(g,carol,'alloy',amount,'bad'));
  assert.throws(()=>contribute(g,carol,'foxo','1','c2'),/asset/i);
  assert.equal(g.balance(carol,'alloy'),'20');
});

test('a refund failure rolls back every contributor and can safely retry after recovery',()=>{
  const {guilds:g,database,make}=fixture();
  fund(g,carol,'alloy','7','a');fund(g,bob,'core','2','b');
  contribute(g,carol,'alloy','7','c');contribute(g,bob,'core','2','d');
  database.exec(`CREATE TRIGGER fail_refund BEFORE UPDATE ON near_guild_balances
    WHEN NEW.account_id='bob.testnet' BEGIN SELECT RAISE(ABORT,'fixture storage failure'); END`);
  assert.throws(()=>g.cancel(alice,'project'),/storage failure/);
  assert.equal(g.balance(carol,'alloy'),'0');
  assert.equal(g.project('project').status,'open');
  assert.ok(g.project('project').contributions.every(row=>row.status==='escrow'));
  database.exec('DROP TRIGGER fail_refund');
  assert.equal(make().cancel(alice,'project'),true);
  assert.equal(g.balance(carol,'alloy'),'7');
  assert.equal(g.balance(bob,'core'),'2');
});

test('serialized workers cannot overfill a final target or refund consumed contributions',()=>{
  const {guilds:g,make}=fixture();
  fund(g,carol,'alloy','10','a');fund(g,bob,'alloy','10','b');fund(g,bob,'core','2','c');
  contribute(g,carol,'alloy','10','first');
  assert.throws(()=>contribute(make(),bob,'alloy','10','second'),/target/);
  contribute(g,bob,'core','2','core');
  make().commit(alice,'project');
  assert.throws(()=>make().cancel(bob,'project'),/committed/i);
  assert.equal(g.balance(bob,'alloy'),'10');
  assert.equal(g.balance(carol,'alloy'),'0');
});

test('unregistered outputs stay unavailable and disband refunds all open projects once',()=>{
  const {guilds:g,terms}=fixture();
  assert.throws(()=>g.open(alice,{...terms,projectId:'fake',sku:'unregistered'}),/registered/i);
  fund(g,carol,'alloy','10','a');contribute(g,carol,'alloy','10','c');
  assert.equal(g.disband(alice,'guild'),true);
  assert.equal(g.disband(alice,'guild'),false);
  assert.equal(g.balance(carol,'alloy'),'10');
  assert.equal(g.project('project').contributions[0].status,'refunded');
  assert.throws(()=>g.join(carol,'guild'),/closed/i);
  assert.throws(()=>g.open(alice,{...terms,projectId:'next'}),/closed/i);
});

test('disk restart retains escrow and original contributor refund identity',()=>{
  const directory=mkdtempSync(join(tmpdir(),'fox-guild-'));
  const file=join(directory,'guild.sqlite');
  let database=new DatabaseSync(file);
  try {
    let g=createGuildProjects({database,now:()=>100,catalogue:[
      {sku:'fixture-banner',guildBound:true,transferable:false,displayRoles:['member']},
    ]});
    g.create(alice,{guildId:'persist',treasurerId:bob});
    g.join(carol,'persist');
    g.open(alice,{guildId:'persist',projectId:'saved',sku:'fixture-banner',targets:{alloy:'10'},deadline:1000});
    fund(g,carol,'alloy','10','receipt');
    g.contribute(carol,{projectId:'saved',asset:'alloy',amount:'10',operationId:'contribute',termsHash:g.project('saved').termsHash});
    database.close();
    database=new DatabaseSync(file);
    g=createGuildProjects({database,now:()=>200});
    assert.equal(g.balance(carol,'alloy'),'0');
    g.cancel(alice,'saved');
    assert.equal(g.balance(carol,'alloy'),'10');
    assert.equal(g.balance(alice,'alloy'),'0');
  } finally {
    database.close();
    rmSync(directory,{recursive:true,force:true});
  }
});
