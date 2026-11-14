import { resultsFromSimulation } from './result-adapter.mjs';

export function createResultOutbox(database, { passport, usage, confirmPractice = false, rankingMetrics,
  careerModes = [], now = Date.now } = {}) {
  database.exec(`
    CREATE TABLE IF NOT EXISTS near_results (
      match_id TEXT NOT NULL,
      account_id TEXT NOT NULL,
      result_hash TEXT NOT NULL,
      payload TEXT NOT NULL,
      PRIMARY KEY (match_id, account_id)
    )
  `);
  database.exec(`CREATE TABLE IF NOT EXISTS near_result_metrics (
    match_id TEXT NOT NULL, account_id TEXT NOT NULL, metrics_hash TEXT NOT NULL, payload TEXT NOT NULL,
    PRIMARY KEY(match_id,account_id)
  )`);
  database.exec(`CREATE TABLE IF NOT EXISTS near_ranking_encounters (
    match_id TEXT NOT NULL, mode TEXT NOT NULL, finished_at INTEGER NOT NULL,
    account_a TEXT NOT NULL, account_b TEXT NOT NULL,
    PRIMARY KEY(match_id,account_a,account_b)
  );
  CREATE INDEX IF NOT EXISTS near_ranking_encounters_day
    ON near_ranking_encounters(mode,account_a,account_b,finished_at)`);
  const countEncounters = database.prepare(`SELECT COUNT(*) AS total FROM near_ranking_encounters
    WHERE mode=? AND account_a=? AND account_b=? AND finished_at>=? AND finished_at<=? AND match_id<>?`);
  const saveEncounter = database.prepare('INSERT OR IGNORE INTO near_ranking_encounters VALUES (?,?,?,?,?)');
  const find = database.prepare(`SELECT result_hash, json_extract(payload,'$.finishedAt') AS finished_at FROM near_results WHERE match_id = ? AND account_id = ?`);
  const put = database.prepare('INSERT INTO near_results VALUES (?, ?, ?, ?)');
  return {
    record(room, snapshot) {
      const finishedAt=now();
      const results = resultsFromSimulation(room, snapshot, finishedAt, { careerModes });
      database.exec('BEGIN IMMEDIATE');
      try {
        const encounterRows = new Map();
        const opponents = new Map();
        const mode = room.config.mode || 'hunt';
        if (mode === 'control' || mode === 'hunt') {
          const teams = new Map(room.roster.filter(player => player.nearWallet && !player.bot)
            .map(player => [player.nearWallet, player.team]));
          const huntOpponents = new Map();
          if(mode==='hunt'){
            const byActor=new Map(room.roster.filter(player=>player.nearWallet&&!player.bot)
              .map(player=>['hunt-'+player.nid,player.nearWallet]));
            for(const player of snapshot.core.result.players) {
              const seen=player.rankingTelemetry?.opponents;
              if(byActor.has(player.id)&&Array.isArray(seen)){
                huntOpponents.set(byActor.get(player.id),new Set(seen.map(id=>byActor.get(id)).filter(Boolean)));
              }
            }
          }
          const eligible = results.filter(result => !result.left && teams.has(result.accountId));
          const previousFinish = find.get(room.roundId,eligible[0]?.accountId ?? '')?.finished_at;
          const encounterTime = previousFinish ?? finishedAt;
          const utcStart = Math.floor(encounterTime / 86400000) * 86400000;
          for (const player of eligible) {
            if(mode==='hunt'&&!huntOpponents.has(player.accountId)) continue;
            const rivals = eligible.filter(other => other.accountId !== player.accountId &&
              (mode==='control' ? teams.get(other.accountId)!==teams.get(player.accountId)
                : huntOpponents.get(player.accountId).has(other.accountId)||
                  huntOpponents.get(other.accountId)?.has(player.accountId)));
            let maxOpponentMeetings = 0;
            for (const rival of rivals) {
              const [a,b] = [player.accountId,rival.accountId].sort();
              const total = countEncounters.get(mode,a,b,utcStart,encounterTime,room.roundId).total + 1;
              maxOpponentMeetings = Math.max(maxOpponentMeetings,total);
              encounterRows.set(JSON.stringify([a,b]),[room.roundId,mode,encounterTime,a,b]);
            }
            opponents.set(player.accountId,{humanOpponentCount:rivals.length,maxOpponentMeetings});
          }
        }
        const metrics=rankingMetrics ? rankingMetrics(room,snapshot,finishedAt,undefined,{opponents}) : [];
        if(!Array.isArray(metrics) || metrics.length && metrics.length!==results.length)throw new Error('Invalid authoritative metrics');
        for (const row of encounterRows.values()) saveEncounter.run(...row);
        for (const result of results) {
          const previous = find.get(result.matchId, result.accountId);
          if (previous) {
            if (previous.result_hash !== result.resultHash) throw new Error('Conflicting match result');
            continue;
          }
          if (result.nft && usage) {
            usage.sessionReceipt(result.nft, result.matchId, {
              actorId: result.accountId,
              mode: result.mode,
              finishedAt: result.finishedAt,
            });
          }
          put.run(result.matchId, result.accountId, result.resultHash, JSON.stringify(result));
          passport?.ingest(result);
          if (confirmPractice && !result.left && result.rulesVersion.startsWith('near-practice-')) {
            passport?.finalize(result.matchId, result.accountId, result.resultHash);
          }
        }
        for(const metric of metrics) {
          const result=results.find(row=>row.matchId===metric.matchId && row.accountId===metric.accountId);
          if(!result || result.resultHash!==metric.resultHash || !/^[a-f0-9]{64}$/.test(metric.metricsHash??''))throw new Error('Metrics result mismatch');
          const previous=database.prepare('SELECT metrics_hash FROM near_result_metrics WHERE match_id=? AND account_id=?').get(metric.matchId,metric.accountId);
          if(previous && previous.metrics_hash!==metric.metricsHash)throw new Error('Conflicting authoritative metrics');
          database.prepare('INSERT OR IGNORE INTO near_result_metrics VALUES(?,?,?,?)').run(metric.matchId,metric.accountId,metric.metricsHash,JSON.stringify(metric));
        }
        database.exec('COMMIT');
      } catch (error) {
        database.exec('ROLLBACK');
        throw error;
      }
      return results;
    },
  };
}

