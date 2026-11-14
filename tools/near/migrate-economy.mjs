import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { DatabaseSync, backup } from 'node:sqlite';
import { pathToFileURL } from 'node:url';

const schema = readFileSync(new URL('../../server/near/migrations/001-economy.sql', import.meta.url), 'utf8');
const ident = value => '"' + value.replaceAll('"', '""') + '"';

export function databaseState(db) {
  const hash = createHash('sha256');
  const tables = {};
  const definitions = db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  for (const { name, sql } of definitions) {
    const rows = db.prepare('SELECT * FROM ' + ident(name));
    rows.setReadBigInts(true);
    const encoded = rows.all().map(row => JSON.stringify(row, (_key, value) =>
      typeof value === 'bigint' ? { integer: value.toString() } : value)).sort();
    hash.update(JSON.stringify([name, sql, encoded]));
    tables[name] = { rows: encoded.length };
  }
  return { stateHash: hash.digest('hex'), tables };
}

export function applySchema(db) {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec(schema);
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

export async function migrateEconomy({ source, apply = false, backupPath }) {
  if (!existsSync(source)) throw new Error('Source database does not exist.');
  if (apply && (!backupPath || existsSync(backupPath))) throw new Error('Choose a new backup file.');
  const db = new DatabaseSync(source, { readOnly: !apply });
  try {
    const before = databaseState(db);
    if (!apply) {
      // Copy schema only to a memory database. The migration adds isolated tables.
      const copy = new DatabaseSync(':memory:');
      try {
        for (const { sql } of db.prepare("SELECT sql FROM sqlite_schema WHERE type='table' AND name NOT LIKE 'sqlite_%'").all()) copy.exec(sql);
        applySchema(copy);
        const preview = databaseState(copy);
        return { before, after: { tables: { ...preview.tables, ...before.tables } }, applied: false };
      } finally { copy.close(); }
    }
    await backup(db, backupPath);
    const saved = new DatabaseSync(backupPath, { readOnly: true });
    let backupState;
    try { backupState = databaseState(saved); } finally { saved.close(); }
    db.exec('BEGIN IMMEDIATE');
    try {
      if (before.stateHash !== backupState.stateHash || before.stateHash !== databaseState(db).stateHash) {
        throw new Error('Database changed during backup. Stop writers and retry.');
      }
      db.exec(schema);
      db.exec('COMMIT');
    } catch (error) {
      db.exec('ROLLBACK');
      throw error;
    }
    return { before, backup: backupState, after: databaseState(db), applied: true };
  } finally { db.close(); }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const [source, flag, backupPath] = process.argv.slice(2);
  if (!source || (flag && flag !== '--apply')) throw new Error('Usage: migrate-economy.mjs DATABASE [--apply BACKUP]');
  console.log(JSON.stringify(await migrateEconomy({ source, apply: flag === '--apply', backupPath }), null, 2));
}
