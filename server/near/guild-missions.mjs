import { createHash } from 'node:crypto';
import { guildDeployment } from '../../assets/near-fox/guild-deployment.js';
import { rankingMetricsHash } from './ranking-rubric.mjs';
import { guildTermsHash } from '../../src/economy/near-guild.js';

const modes = ['boss', 'control', 'trials'];
const idPattern = /^[a-zA-Z0-9_-]{1,64}$/;

export function qualifiesGuildMission(row, { account, mode, acceptedAt, deadline }) {
  try {
    const { resultHash, finishedAt, ...result } = JSON.parse(row.payload);
    const metric = JSON.parse(row.metric);
    const digest = createHash('sha256').update(JSON.stringify(result)).digest('hex');
    const signals = metric.signals;
    const expectedVersion = mode === 'control' ? /^near-practice-objective-\d+$/ : new RegExp('^near-authoritative-' + mode + '-1$');
    if (result.matchId !== row.match_id || result.accountId !== account || result.mode !== mode ||
        !expectedVersion.test(result.rulesVersion) || result.left !== false ||
        result.won !== true || resultHash !== digest || row.result_hash !== digest ||
        metric.resultHash !== digest || metric.mode !== mode || metric.accountId !== account ||
        metric.matchId !== result.matchId || metric.source !== 'authoritative-simulation' ||
        metric.metricsHash !== row.metrics_hash || rankingMetricsHash(metric) !== row.metrics_hash ||
        metric.finishedAt !== finishedAt || !Number.isSafeInteger(finishedAt) ||
        finishedAt <= acceptedAt || finishedAt > deadline || signals.left !== false ||
        !Number.isSafeInteger(signals.durationMs) || !Number.isSafeInteger(signals.activeMs) ||
        signals.durationMs <= 0 || signals.activeMs > signals.durationMs ||
        finishedAt - signals.durationMs < acceptedAt ||
        signals.activeMs < Math.min(12_000, Math.ceil(signals.durationMs / 5))) return null;
    if (mode === 'boss' && !(signals.shieldBreaks > 0 || signals.allyHealing > 0 || signals.allyBlocked > 0)) return null;
    if (mode === 'control' && !(signals.captureMs > 0 || signals.defenseMs > 0)) return null;
    if (mode === 'trials' && (signals.standardizedKit !== true || signals.objectiveProgress !== 8)) return null;
    return { matchId:result.matchId, finishedAt };
  } catch { return null; }
}

export function createGuildMissions({ database, rpc, now = Date.now }) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_guild_missions (
    account_id TEXT NOT NULL, project_id TEXT NOT NULL, mode TEXT NOT NULL,
    terms_hash TEXT NOT NULL, accepted_at INTEGER NOT NULL, deadline INTEGER NOT NULL,
    match_id TEXT, completed_at INTEGER,
    PRIMARY KEY(account_id,project_id,mode), UNIQUE(account_id,match_id)
  )`);
  const list = database.prepare('SELECT * FROM near_guild_missions WHERE account_id=? AND project_id=?');
  const accept = database.prepare('INSERT OR IGNORE INTO near_guild_missions VALUES(?,?,?,?,?,?,NULL,NULL)');
  const complete = database.prepare(`UPDATE OR IGNORE near_guild_missions SET match_id=?,completed_at=?
    WHERE account_id=? AND project_id=? AND mode=? AND match_id IS NULL`);
  const candidates = () => database.prepare(`SELECT r.match_id,r.payload,r.result_hash,m.payload AS metric,m.metrics_hash
    FROM near_results r JOIN near_result_metrics m USING(match_id,account_id)
    WHERE r.account_id=? AND json_extract(r.payload,'$.mode')=?
      AND json_extract(r.payload,'$.finishedAt')>? AND json_extract(r.payload,'$.finishedAt')<=?
    ORDER BY json_extract(r.payload,'$.finishedAt'),r.match_id`);
  async function snapshot(projectId, account) {
    const account_id = guildDeployment.accountId;
    const code = await rpc('query',{request_type:'view_account',account_id,finality:'final'});
    if (!code.block_hash || code.code_hash !== guildDeployment.codeHash) throw Error('Guild deployment unavailable.');
    const view = async (method_name,args) => {
      const response = await rpc('query',{request_type:'call_function',account_id,method_name,
        block_id:code.block_hash,args_base64:Buffer.from(JSON.stringify(args)).toString('base64')});
      if (response.block_hash !== code.block_hash || !Array.isArray(response.result)) throw Error('Guild snapshot unavailable.');
      return JSON.parse(Buffer.from(response.result).toString());
    };
    const project = await view('project',{project_id:projectId});
    if (!project) return null;
    if (await guildTermsHash({contract:account_id,projectId,project}) !== project.terms_hash) {
      throw Error('Guild project terms could not be verified.');
    }
    const args = {guild_id:project.guild_id};
    const [guild, member] = await Promise.all([view('guild',args),view('member',{...args,account_id:account})]);
    return {project,member:member===true && guild?.active===true};
  }

  return async (account, {projectId, mode}, action) => {
    if (typeof projectId !== 'string' || !idPattern.test(projectId) ||
        (action === 'accept' && !modes.includes(mode))) return {status:400,data:{error:'Invalid guild mission.'}};
    const current = await snapshot(projectId, account);
    if (!current?.member) return {status:403,data:{error:'Join the project guild before accepting a mission.'}};
    const {project} = current;
    const deadline = Number(BigInt(project.deadline) / 1_000_000n);
    const time = now();
    if (action === 'accept') {
      if (project.status !== 'open' || time >= deadline) return {status:409,data:{error:'This project is closed.'}};
      accept.run(account,projectId,mode,project.terms_hash,time,deadline);
    }
    const missions = list.all(account,projectId).map(row => {
      const valid = row.terms_hash === project.terms_hash;
      if (valid && !row.match_id && ['open','committed'].includes(project.status)) {
        for (const item of candidates().iterate(account,row.mode,row.accepted_at,row.deadline)) {
          const match = qualifiesGuildMission(item,{account,mode:row.mode,acceptedAt:row.accepted_at,deadline:row.deadline});
          if (match && complete.run(match.matchId,match.finishedAt,account,projectId,row.mode).changes) {
            row.match_id = match.matchId;
            row.completed_at = match.finishedAt;
            break;
          }
        }
      }
      return {mode:row.mode, status:valid && row.match_id?'confirmed':
        valid && project.status==='open' && time<row.deadline?'accepted':'closed',
        matchId:valid?row.match_id:null, finishedAt:valid?row.completed_at:null};
    });
    return {status:200,data:{missions}};
  };
}
