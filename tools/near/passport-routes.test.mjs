import test from 'node:test';
import assert from 'node:assert/strict';
import {createFoxPassportRoutes} from '../../server/near/passport-routes.mjs';

test('gas sponsorship derives the signer from the verified wallet session', async () => {
  const headers = { origin: 'http://game' };
  const nearAuth = { account(token, origin) {
    assert.equal(origin, headers.origin);
    if (token !== 'session') throw Error('Sign in');
    return 'player.testnet';
  } };
  const request = { method: 'POST', url: '/near/gas/submit', headers,
    body: { nearSession: 'session', accountId: 'other.testnet', delegate: { senderId: 'other.testnet' } } };
  assert.equal((await createFoxPassportRoutes({ nearAuth })(request)).status, 503);
  const route = createFoxPassportRoutes({ nearAuth, gasSponsor: {
    async submit(delegate, session) {
      assert.equal(delegate.senderId, 'other.testnet');
      assert.equal(session.accountId, 'player.testnet');
      assert.equal(session.expiresAtMs - session.issuedAtMs, 60_000);
      return { status: 'PENDING' };
    },
    async status(id, accountId) {
      assert.equal(id, 'a'.repeat(64));
      assert.equal(accountId, 'player.testnet');
      return null;
    },
  } });
  assert.equal((await route(request)).data.status, 'PENDING');
  assert.equal((await route({ ...request, url: '/near/gas/status', body: { ...request.body, id: 'a'.repeat(64) } })).status, 404);
  await assert.rejects(route({ ...request, body: { nearSession: 'other' } }), /Sign in/);
});

test('gas sponsorship availability and submission require a confirmed Boss clear', async () => {
  let eligible = false;
  const route = createFoxPassportRoutes({ nearAuth: { account: () => 'player.testnet' },
    gasEligibility: async () => eligible,
    gasSponsor: { budget: () => ({ enabled: true, budgetAtomic: '100000000000000000000000', reservedAtomic: '0' }),
      canRegister: () => true, submit: async () => ({ status: 'FINALIZED' }) } });
  const request = { method: 'POST', url: '/near/gas/availability', headers: {}, body: {} };
  assert.deepEqual((await route(request)).data, { enabled: false });
  assert.equal((await route({ ...request, url: '/near/gas/submit' })).status, 409);
  eligible = true;
  assert.deepEqual((await route(request)).data, { enabled: true });
  assert.equal((await route({ ...request, url: '/near/gas/submit' })).data.status, 'FINALIZED');
});

test('public Quartermaster feed exposes only published order identifiers and source', async () => {
  const route = createFoxPassportRoutes({ quartermaster: { enabled: true, budgetFoxo: '20' },
    quartermasterOrders: { list: () => [
      { orderId: 'buyer.testnet:order-1', source: 'Sponsored', receipt: { private: 'internal' } },
      { orderId: 'buyer.testnet:order-2', source: 'Guild', fundingId: 'internal' },
    ] } });
  assert.deepEqual(await route({ method: 'GET', url: '/near/orders/quartermaster' }), {
    status: 200, data: { enabled: true, budgetFoxo: '20', orders: [
      { orderId: 'buyer.testnet:order-1', source: 'Sponsored' },
      { orderId: 'buyer.testnet:order-2', source: 'Guild' },
    ] },
  });
});

test('claim discovery waits for verified rewards and scopes the lookup to the signed account', async () => {
  const entries = [{ source: 'ranking', operationId: 'ranking:example', amountAtomic: '5', mode: 'hunt' }];
  const route = createFoxPassportRoutes({
    nearAuth: { account(token, origin) {
      if (token !== 'session' || origin !== 'http://game') throw new Error('Sign in');
      return 'player.testnet';
    } },
    fixedRewards: { async claims(account) {
      assert.equal(account, 'player.testnet');
      return { economyId: 'economy.testnet', entries };
    } },
  });
  const request = { method: 'POST', url: '/near/rewards/claims', headers: { origin: 'http://game' },
    body: { nearSession: 'session', accountId: 'someone-else.testnet' } };
  assert.deepEqual(await route(request), { status: 200, data: { economyId: 'economy.testnet', entries } });
  await assert.rejects(route({ ...request, body: { nearSession: 'invalid' } }), /Sign in/);
});
test('outgoing loan inspection requires the current owner and authentication',async()=>{
  let actor='owner.testnet';
  const view={ownerId:actor,grants:[{borrowerId:'borrower.testnet',expiresAt:100}],lease:null};
  const route=createFoxPassportRoutes({nearAuth:{account(token){if(token!=='valid')throw Error('Sign in');return actor;}},usage:{view:async()=>view}});
  const request={method:'POST',url:'/near/usage/owned',headers:{origin:'http://game'},body:{nearSession:'valid',nft:{collectionId:'fox.testnet',tokenId:'045'}}};
  assert.deepEqual((await route(request)).data.usage,view);
  actor='borrower.testnet';assert.equal((await route(request)).status,403);
  await assert.rejects(route({...request,body:{...request.body,nearSession:'fake'}}),/Sign in/);
});
