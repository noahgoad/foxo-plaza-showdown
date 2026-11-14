import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

const load = async (path, missing) => import(path).catch(error => {
  if (error.code === 'ERR_MODULE_NOT_FOUND' && error.url?.endsWith('/' + missing)) return {};
  throw error;
});
const { migrateEconomy = async () => ({}) } = await load('./migrate-economy.mjs', 'migrate-economy.mjs');
const { rehearseRestore = async () => ({}) } = await load('./restore-rehearsal.mjs', 'restore-rehearsal.mjs');

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'fox-economy-test-'));
  const source = join(dir, 'legacy.sqlite');
  const writer = new DatabaseSync(source);
  t.after(async () => {
    writer.close();
    await rm(dir, { recursive: true, force: true });
  });
  writer.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE accounts(wallet TEXT PRIMARY KEY,balance INTEGER NOT NULL);
    INSERT INTO accounts VALUES ('0x0000000000000000000000000000000000000001',999);`);
  return { source, dir, writer };
}

test('dry run leaves SQLite intact and migration is idempotent with a WAL-aware backup', async t => {
  const { source, dir, writer } = await fixture(t);
  const dry = await migrateEconomy({ source });
  assert.equal(dry.before.tables.accounts.rows, 1);
  assert.equal(dry.before.tables.economy_schema_version, undefined);
  assert.equal(dry.after.tables.economy_schema_version.rows, 1);
  assert.equal(writer.prepare("SELECT name FROM sqlite_schema WHERE name LIKE 'economy_%'").all().length, 0);
  const apply = await migrateEconomy({ source, apply: true, backupPath: join(dir, 'backup-first.sqlite') });
  assert.equal(apply.backup.stateHash, dry.before.stateHash);
  const retry = await migrateEconomy({ source, apply: true, backupPath: join(dir, 'backup-second.sqlite') });
  assert.equal(apply.after.stateHash, retry.after.stateHash);
});

test('exact decimal FOXO, opaque token IDs and isolated legacy/practice data', async t => {
  const { source, dir, writer } = await fixture(t);
  await migrateEconomy({ source, apply: true, backupPath: join(dir, 'backup.sqlite') });
  writer.exec(`INSERT INTO economy_funding_buckets VALUES ('near-testnet','rewards','1000000000000000000000000');
    INSERT INTO economy_assets VALUES ('near-testnet','alice.testnet','fox.testnet','045'),('near-testnet','alice.testnet','fox.testnet','45');
    INSERT INTO economy_practice_balances VALUES ('practice','alice.testnet','200');`);
  const amount = writer.prepare('SELECT amount_atomic, typeof(amount_atomic) AS storage FROM economy_funding_buckets').get();
  assert.equal(amount.storage, 'text');
  assert.equal(BigInt(amount.amount_atomic), 10n ** 24n);
  assert.deepEqual(writer.prepare('SELECT token_id FROM economy_assets ORDER BY token_id').all().map(row => row.token_id), ['045', '45']);
  assert.throws(() => writer.exec("INSERT INTO economy_funding_buckets VALUES ('near-testnet','invalid','1.0')"));
  assert.throws(() => writer.exec("INSERT INTO economy_practice_balances VALUES ('near-testnet','alice.testnet','5')"));
  assert.throws(() => writer.exec("INSERT INTO economy_assets VALUES ('monad-testnet','0x1','0x2','45')"));
  assert.throws(() => writer.exec("INSERT INTO economy_assets VALUES ('near-testnet','0x0000000000000000000000000000000000000001','fox.testnet','45')"));
  assert.equal(writer.prepare('SELECT count(*) AS count FROM economy_operation_journal').get().count, 0);
  assert.equal(writer.prepare('SELECT balance FROM accounts').get().balance, 999);
});

test('restore replays the same journal operation twice with one row and the original state hash', async t => {
  const { source, dir } = await fixture(t);
  const result = await rehearseRestore({ source, workDir: join(dir, 'restore') });
  assert.equal(result.status, 'MATCH');
  assert.equal(result.snapshotHash, result.restoredSnapshotHash);
  assert.equal(result.expectedReplayedHash, result.replayedHash);
  assert.equal(result.replayedOperations, 1);
});
