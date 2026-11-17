import { communityEvents } from '../../src/game/foxo-community-calendar.js';
import { guildDeployment } from '../../assets/near-fox/guild-deployment.js';

const layoutNames = new Set(['gallery', 'banner', 'compact']);
const guildIdPattern = /^[a-zA-Z0-9_-]{1,64}$/;

export function createGuildCommunity({ database, rpc, now = Date.now }) {
  database.exec(`CREATE TABLE IF NOT EXISTS near_community_rsvps (
    event_id TEXT NOT NULL, account_id TEXT NOT NULL, ends_at INTEGER NOT NULL,
    PRIMARY KEY(event_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS near_guild_lounge (
    guild_id TEXT PRIMARY KEY, layout TEXT NOT NULL
  );`);
  const getLayout = database.prepare('SELECT layout FROM near_guild_lounge WHERE guild_id=?');
  const saveLayout = database.prepare(`INSERT INTO near_guild_lounge VALUES(?,?)
    ON CONFLICT(guild_id) DO UPDATE SET layout=excluded.layout`);
  const listRsvps = database.prepare('SELECT event_id FROM near_community_rsvps WHERE account_id=? AND ends_at>?');
  const addRsvp = database.prepare('INSERT OR IGNORE INTO near_community_rsvps VALUES(?,?,?)');
  const removeRsvp = database.prepare('DELETE FROM near_community_rsvps WHERE event_id=? AND account_id=?');
  const removeExpired = database.prepare('DELETE FROM near_community_rsvps WHERE ends_at<=?');

  return async (action, account, body) => {
    const result = (status, data) => ({ status, data });
    if (['rsvp','save-layout'].includes(action) && !account) return result(401, { error:'Connect your wallet first.' });
    if (action === 'events' || action === 'rsvp') {
      const time = now();
      const events = communityEvents(time);
      if (action === 'rsvp') {
        const event = events.find(item => item.id === body?.eventId);
        if (!event || typeof body.attending !== 'boolean') return result(400, { error:'Invalid or expired event.' });
        removeExpired.run(time);
        if (body.attending) addRsvp.run(event.id, account, event.endsAt);
        else removeRsvp.run(event.id, account);
      }
      const attending = account ? new Set(listRsvps.all(account,time).map(row => row.event_id)) : new Set();
      return result(200, { events:events.map(event => ({ ...event, attending:attending.has(event.id) })) });
    }
    const guildId = body?.guildId;
    if (typeof guildId !== 'string' || !guildIdPattern.test(guildId)) return result(400, { error:'Invalid guild.' });
    if (action === 'save-layout') {
      if (!layoutNames.has(body.layout)) return result(400, { error:'Invalid layout.' });
      const account_id = guildDeployment.accountId;
      const code = await rpc('query', { request_type:'view_account', account_id, finality:'final' });
      if (!code.block_hash || code.code_hash !== guildDeployment.codeHash) return result(503, { error:'Guild verification is unavailable.' });
      const row = await rpc('query', { request_type:'call_function', account_id, method_name:'guild',
        block_id:code.block_hash, args_base64:Buffer.from(JSON.stringify({guild_id:guildId})).toString('base64') });
      if (row.block_hash !== code.block_hash || !Array.isArray(row.result)) return result(503, { error:'Guild verification is unavailable.' });
      const guild = JSON.parse(Buffer.from(row.result).toString());
      if (!guild?.active || ![guild.leader,guild.treasurer,...(guild.governors ?? [])].includes(account)) {
        return result(403, { error:'Only current guild leadership can change the lounge layout.' });
      }
      saveLayout.run(guildId,body.layout);
    }
    return result(200, { layout:getLayout.get(guildId)?.layout ?? 'gallery' });
  };
}
