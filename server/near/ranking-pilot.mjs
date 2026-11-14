import { foxoAtomic } from '../../src/economy/policy.js';
import { readFileSync } from 'node:fs';
import { prepareRankingDay, readRankingDay } from './ranking-daily.mjs';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';

const configFile = file => JSON.parse(readFileSync(new URL('../../config/' + file, import.meta.url), 'utf8'));
const DAY_MS = 86_400_000;
const GRACE_MS = 300_000;

export function createRankingPilots({ seasons = configFile('ranking-pilot.testnet.json'), ...options }) {
  const list = [seasons, ...(seasons.additional ?? [])];
  const pilots = new Map();
  const campaignIds = new Set();
  for (const season of list) {
    if (pilots.has(season.mode) || campaignIds.has(season.campaignId)) {
      throw new Error('Duplicate ranking mode or campaign.');
    }
    campaignIds.add(season.campaignId);
    pilots.set(season.mode, createRankingPilot({ ...options, pilot: season }));
  }
  return {
    board(day, mode = seasons.mode) {
      return pilots.get(mode)?.board(day) ?? null;
    },
    async stageClosedDay(options) {
      for (const pilot of pilots.values()) await pilot.stageClosedDay(options);
    },
  };
}

export function createRankingPilot({ database, config, rpc, drafts, now = Date.now,
  pilot = configFile('ranking-pilot.testnet.json'), rubric = configFile('ranking-rubrics.testnet.json') }) {
  const { campaignId, mode, seasonStartMs } = pilot;
  const lastDay = config.pilot.seasonDays - 1;
  const enabled = config.ranking.enabledModes.includes(mode) && rubric.enabledModes.includes(mode) &&
    rubric.reviewStatus === 'approved';
  let nextRun = 0;
  let nextDay = 0;

  async function chainSnapshot() {
    const account_id = economyDeployment.accountId;
    const { header } = await rpc('block', { finality: 'final' });
    const blockId = header.hash;
    const chainTime = Number(BigInt(header.timestamp_nanosec) / 1_000_000n);
    const code = await rpc('query', { request_type: 'view_account', account_id, block_id: blockId });
    if (code.block_hash !== blockId || !economyDeployment.acceptedCodeHashes.includes(code.code_hash)) {
      throw new Error('Ranking contract code could not be verified.');
    }
    const view = async (method_name, args) => {
      const reply = await rpc('query', { request_type: 'call_function', account_id, block_id: blockId, method_name,
        args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      if (reply.block_hash !== blockId || !Array.isArray(reply.result)) throw new Error('Ranking view unavailable.');
      return JSON.parse(Buffer.from(reply.result).toString());
    };
    const campaign = await view('get_campaign', { campaign_id: campaignId });
    const expectedEnd = seasonStartMs + config.pilot.seasonDays * DAY_MS;
    const cap = foxoAtomic(config.ranking.dailyCapPerModeFoxo);
    if (campaign && (campaign.closesAtMs !== expectedEnd || campaign.maxAward !== cap.toString())) {
      throw new Error('Ranking campaign terms differ from the configured pilot.');
    }
    return { view, campaign, chainTime };
  }

  function ranked(entries) {
    return [...entries].sort((a, b) => Number(b.scoreAtomic) - Number(a.scoreAtomic) ||
      a.accountId.localeCompare(b.accountId)).map((entry, index) => ({ ...entry, rank: index + 1 }));
  }

  return {
    async board(dayIndex) {
      const currentDay = Math.max(0, Math.min(lastDay, Math.floor((now() - seasonStartMs) / DAY_MS)));
      if (dayIndex == null) dayIndex = currentDay;
      if (!Number.isSafeInteger(dayIndex) || dayIndex < 0 || dayIndex > lastDay) return null;
      const { campaign, view, chainTime } = await chainSnapshot();
      const from = seasonStartMs + dayIndex * DAY_MS;
      const summary = { campaignId, mode, dayIndex, lastDay, date: new Date(from).toISOString().slice(0, 10),
        closesAtMs: from + DAY_MS, campaignActive: enabled && !!campaign && !campaign.closed &&
          chainTime >= seasonStartMs && chainTime < campaign.closesAtMs };
      const args = { campaign_id: campaignId, day_index: dayIndex };
      const record = campaign && await view('get_ranking_draft', args);
      const readEvidence = () => readRankingDay({ database, rubric, campaignId, mode, dayIndex, from,
        until: from + DAY_MS, strict: false, includeMatches: true });
      if (record) {
        if (record.draft?.mode !== mode || record.draft?.dayIndex !== dayIndex ||
            record.draft?.seasonStartMs !== seasonStartMs || record.draft?.campaignId !== campaignId) {
          throw new Error('Ranking draft does not match this campaign.');
        }
        const published = Number.isSafeInteger(record.publishedAtMs);
        const evidence = readEvidence();
        const explanations = evidence.evidenceHash === record.draft.evidenceHash
          ? new Map(evidence.entries.map(row=>[row.accountId,row])) : new Map();
        return { ...summary, status: published ? 'published' : 'review', reviewAfterMs: record.reviewAfterMs,
          entries: ranked(record.draft.allocations.map(({ accountId, scoreAtomic, amountAtomic }) => {
            const row = explanations.get(accountId);
            return { accountId, scoreAtomic, ...(row?.scoreAtomic === scoreAtomic ? {breakdown:row.breakdown} : {}),
              ...(published ? { amountAtomic } : {}) };
          })).slice(0, 100) };
      }
      const { entries, unscored } = readEvidence();
      return { ...summary, status: 'preview', entries: ranked(entries).slice(0, 100), unscored };
    },

    async stageClosedDay({ onError }) {
      const time = now();
      if (!enabled || time < seasonStartMs + DAY_MS + GRACE_MS || time < nextRun) return;
      nextRun = time + 60_000;
      try {
        const { campaign, view, chainTime } = await chainSnapshot();
        if (!campaign || campaign.closed) return;
        const latest = Math.min(lastDay, Math.floor((chainTime - seasonStartMs - GRACE_MS) / DAY_MS) - 1);
        if (latest < 0) return;
        const dayIndex = nextDay > latest ? 0 : nextDay;
        nextDay = dayIndex + 1;
        const budgetDay = new Date(seasonStartMs + dayIndex * DAY_MS).toISOString().slice(0, 10);
        if (drafts.forSubmission({ campaignId, mode, budgetDay })) return;
        if (await view('get_ranking_draft', { campaign_id: campaignId, day_index: dayIndex })) return;
        prepareRankingDay({ database, drafts, config, rubric, campaignId, mode, seasonStartMs, dayIndex, now: chainTime });
      } catch (error) {
        onError(error, { action: 'ranking-stage' });
      }
    },
  };
}

