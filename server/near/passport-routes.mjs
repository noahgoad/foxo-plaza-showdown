import { nearWorkshopProgress } from '../../src/economy/specializations.js';
import { NEAR_TESTNET } from '../../src/ui/near-testnet-assets.js';

export function createFoxPassportRoutes({ passport, usage, nearAuth, fixedRewards, economyIndex, quartermaster, quartermasterOrders, gasSponsor, gasEligibility, rankingStatus, guildMissions, guildCommunity }) {
  return async ({ method, url, headers, body }) => {
    const path = new URL(url, 'http://relay.local');
    const result = (status, data) => ({ status, data });
    const communityAction = /^\/near\/guild\/community\/(layout|save-layout|events|rsvp)$/.exec(path.pathname)?.[1];
    if (communityAction && guildCommunity) {
      if (method === 'GET' && communityAction === 'layout') return guildCommunity('layout', null, {guildId:path.searchParams.get('guildId')});
      if (method === 'POST' && communityAction !== 'layout') {
        const account = nearAuth.account(body?.nearSession, headers.origin);
        return guildCommunity(communityAction, account, body);
      }
    }
    if (method === 'POST' && guildMissions && ['/near/guild/missions/accept','/near/guild/missions/status'].includes(path.pathname)) {
      const account = nearAuth.account(body?.nearSession, headers.origin);
      return guildMissions(account, body, path.pathname.endsWith('/accept') ? 'accept' : 'status');
    }
    if (method === 'GET' && path.pathname === '/near/ranking/board' && fixedRewards?.rankingBoard) {
      const raw = path.searchParams.get('day');
      const mode = path.searchParams.get('mode');
      if (raw !== null && !/^\d{1,2}$/.test(raw)) return result(400, { error: 'Invalid ranking day.' });
      if (mode !== null && !['hunt', 'boss', 'control', 'trials'].includes(mode)) return result(400, { error: 'Invalid ranking mode.' });
      const board = await fixedRewards.rankingBoard(raw === null ? undefined : Number(raw), mode ?? undefined);
      return board ? result(200, board) : result(400, { error: 'Ranking day or mode is unavailable.' });
    }
    if (method === 'GET' && path.pathname === '/near/ranking/status' && rankingStatus) {
      return result(200, rankingStatus());
    }
    if (method === 'POST' && ['/near/gas/submit', '/near/gas/status', '/near/gas/availability'].includes(path.pathname)) {
      const accountId = nearAuth.account(body?.nearSession, headers.origin);
      if (path.pathname.endsWith('/availability')) {
        const budget = gasSponsor?.budget();
        return result(200, { enabled: budget?.enabled === true &&
          gasSponsor.canRegister(accountId) &&
          (!gasEligibility || await gasEligibility(accountId)) &&
          BigInt(budget.budgetAtomic) - BigInt(budget.reservedAtomic) >= 22_000_000_000_000_000_000_000n });
      }
      if (gasEligibility && !await gasEligibility(accountId)) {
        return result(409, { error: 'A finalized Boss clear is required for sponsorship.' });
      }
      if (!gasSponsor) return result(503, { error: 'Gas sponsorship is unavailable.' });
      if (path.pathname.endsWith('/status')) {
        if (!/^[a-f0-9]{64}$/.test(body?.id ?? '')) return result(400, { error: 'Invalid sponsorship ID.' });
        const status = await gasSponsor.status(body.id, accountId);
        return status ? result(200, status) : result(404, { error: 'Sponsorship not found.' });
      }
      const now = Date.now();
      return result(200, await gasSponsor.submit(body.delegate, { accountId, issuedAtMs: now, expiresAtMs: now + 60_000 }));
    }
    if (method === 'GET' && path.pathname === '/near/orders/quartermaster') {
      const orders = quartermasterOrders?.list().map(({ orderId, source, projectId }) => ({
        orderId, source, ...(projectId ? { projectId } : {}),
      })) ?? [];
      return result(200, { enabled: quartermaster?.enabled === true,
        budgetFoxo: quartermaster?.budgetFoxo ?? '0', orders });
    }
    if (method === 'GET' && path.pathname === '/near/market/cosmetics') {
      if (!economyIndex?.cosmeticSaleIds) return result(503, { error: 'Listing index unavailable.' });
      return result(200, { ids: economyIndex.cosmeticSaleIds() });
    }
    if(method==='GET' && path.pathname==='/near/economy/status') {
      const snapshot=economyIndex?.snapshot();
      if(!snapshot)return result(503,{error:'Economy index is not configured.'});
      const {rewardOperations,...summary}=snapshot;
      return result(200,{...summary,quartermaster});
    }
    if (method === 'POST' && path.pathname === '/near/rewards/claims') {
      const actor = nearAuth.account(body?.nearSession, headers.origin);
      return result(200, (await fixedRewards?.claims(actor)) ?? { economyId: null, entries: [] });
    }
    if (method === 'POST' && path.pathname === '/near/workshop/progress') {
      const actor = nearAuth.account(body?.nearSession, headers.origin);
      const tokenId = body?.tokenId;
      if (tokenId != null && (typeof tokenId !== 'string' || !/^\d{3}$/.test(tokenId))) {
        return result(400, { error: 'Invalid Fox token.' });
      }
      const nft = tokenId == null ? null : { collectionId: NEAR_TESTNET.nft, tokenId };
      if (nft) await usage.authorize(actor, { nft });
      const career=nft && (passport.gameplayCareer ? await passport.gameplayCareer(nft) : passport.tokenCareer(nft));
      return result(200, { progress: nearWorkshopProgress(nft, passport.rank(actor), career) });
    }
    if(method==='POST' && path.pathname==='/near/usage/owned') {
      const actor=nearAuth.account(body?.nearSession,headers.origin);
      const view=await usage.view(body?.nft);
      if(!view || view.ownerId!==actor)return result(403,{error:'Only the current Fox owner can inspect outgoing grants.'});
      return result(200,{usage:view});
    }
    const match = /^\/near\/passport\/([^/]+)\/([^/]+)$/.exec(path.pathname);
    if (method === 'GET' && match) {
      const nft = { collectionId: decodeURIComponent(match[1]), tokenId: decodeURIComponent(match[2]) };
      const view = await passport.view(nft, {
        offset: Number(path.searchParams.get('offset') ?? 0),
        limit: Number(path.searchParams.get('limit') ?? 20),
      });
      if (!view) return result(404, { error: 'Fox not found.' });
      if (view.usage) view.usage = { ownerId: view.usage.ownerId, active: !!view.usage.lease };
      return result(200, view);
    }
    const action = /^\/near\/usage\/(list|grant|revoke)$/.exec(path.pathname)?.[1];
    if (method !== 'POST' || !action) return null;
    const actor = nearAuth.account(body?.nearSession, headers.origin);
    if (action === 'list') return result(200, { loans: await usage.list(actor, body) });
    if (action === 'grant') return result(200, { grant: await usage.grant(actor, body) });
    return result(200, { revoked: await usage.revoke(actor, body) });
  };
}
