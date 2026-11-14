import { mkdir, copyFile, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync, backup } from 'node:sqlite';
import { applySchema, databaseState } from './migrate-economy.mjs';

export async function rehearseRestore({ source, workDir }) {
  await mkdir(workDir, { recursive: true });
  const snapshot = join(workDir, 'snapshot.sqlite');
  const restored = join(workDir, 'restored.sqlite');
  const reservation = await open(snapshot, 'wx');
  await reservation.close();
  const original = new DatabaseSync(source, { readOnly: true });
  try { await backup(original, snapshot); } finally { original.close(); }
  await copyFile(snapshot, restored, constants.COPYFILE_EXCL);
  const left = new DatabaseSync(snapshot);
  const right = new DatabaseSync(restored);
  try {
    const snapshotHash = databaseState(left).stateHash;
    const restoredSnapshotHash = databaseState(right).stateHash;
    for (const db of [left, right]) applySchema(db);
    for (const db of [left, right]) {
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') {
        throw new Error('SQLite integrity check failed during restore rehearsal');
      }
    }
    for (const [db, times] of [[left, 1], [right, 2]]) {
      const replay = db.prepare('INSERT OR IGNORE INTO economy_operation_journal VALUES (?, ?)');
      for (let i = 0; i < times; i++) replay.run('restore-fixture', '{"source":"rehearsal"}');
    }
    const expectedReplayedHash = databaseState(left).stateHash;
    const replayedHash = databaseState(right).stateHash;
    return { status: snapshotHash === restoredSnapshotHash && expectedReplayedHash === replayedHash ? 'MATCH' : 'MISMATCH',
      snapshotHash, restoredSnapshotHash, expectedReplayedHash, replayedHash,
      replayedOperations: right.prepare('SELECT COUNT(*) AS count FROM economy_operation_journal WHERE operation_id = ?').get('restore-fixture').count };
  } finally { left.close(); right.close(); }
}
