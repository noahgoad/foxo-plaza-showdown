import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

const root = new URL('../../', import.meta.url);
const executablePath = [process.env.CHOG_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('Fox market reviews NEP-178 listing, exact FOXO payment and refund from a finalized receipt', { skip: !executablePath }, async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') return res.end('<html><body><main></main></body></html>');
    res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'text/javascript');
    if (path === '/assets/near-fox/market-deployment.js') return res.end(
      "export const marketDeployment={accountId:'market.testnet',codeHash:'market',collectionCodeHash:'fox',foxoCodeHash:'foxo',passportId:'passport.testnet',passportCodeHash:'passport'}");
    if (!/^\/(src|assets\/near-fox)\/[a-z0-9/.-]+\.(js|json)$/i.test(path) || path.includes('..')) return res.writeHead(404).end();
    try { res.end(await readFile(new URL('.' + path, root))); } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(async () => {
      const { openNearMarket } = await import('/src/ui/near-market-ui.js');
      const seller = 'seller.testnet', buyer = 'buyer.testnet', market = 'market.testnet', passport = 'passport.testnet';
      const nft = 'fox.xuancanh1.testnet', token = 'foxo.xuancanh1.testnet', charge = '50000000000000000000000';
      const fox = { token_id: '001', owner_id: seller, approved_account_ids: {} };
      const state = { [buyer]: { credit: '0', withdraw_pending: '0' } };
      let slot = false, listing = null, purchase = null, revision = 3;
      window.transactions = [];
      const realFetch = window.fetch;
      window.fetch = async (url, options) => {
        if (String(url).includes('/near/passport/')) return Response.json({
          identity: { collectionId: nft, tokenId: fox.token_id },
          usage: { ownerId: fox.owner_id, active: Boolean(window.activeMatch) },
        });
        if (!String(url).startsWith('https://near-testnet.drpc.org')) return realFetch(url, options);
        const { params } = JSON.parse(options.body);
        const block_hash = 'finalized-block';
        if (params.request_type === 'view_account') {
          if (params.account_id !== market && params.block_id !== block_hash) throw new Error('Code read must pin block');
          const hashes = { [market]: window.badCode ? 'wrong' : 'market', [nft]: 'fox', [token]: 'foxo', [passport]: 'passport' };
          return Response.json({ result: { code_hash: hashes[params.account_id], block_hash } });
        }
        if (params.block_id !== block_hash) throw new Error('Finalized read required');
        const caller = window.menu._identity.address;
        const value = {
          get_config: { collectionId: nft, foxoContractId: token, passportContractId: passport, enabled: true },
          get_storage_charge: charge, get_account_state: state[caller] ?? null,
          nft_tokens_for_owner: fox.owner_id === caller ? [fox] : [],
          get_listing: listing, nft_token: fox, get_career: { revision }, get_listing_slot: slot, get_purchase: purchase,
        }[params.method_name];
        return Response.json({ result: { result: [...new TextEncoder().encode(JSON.stringify(value))], block_hash } });
      };
      function button(id, label, accept) {
        const el = document.createElement('button');
        el.id = id;
        el.textContent = label;
        el.addEventListener('click', accept);
        return el;
      }
      const menu = {
        _binds: new Map(),
        _btn: ({ id, label, accept }) => button(id, label, accept),
        _openModal({ title, text, buttons }) {
          this._modal?.remove();
          this._modal = document.createElement('section');
          const status = document.createElement('p'), actions = document.createElement('div');
          status.className = 'iw-modal__text';
          status.textContent = text;
          actions.className = 'iw-modal__btns';
          for (const b of buttons) actions.append(button('back', b.label, b.accept));
          this._modal.append(title, status, actions);
          document.querySelector('main').append(this._modal);
        },
        chogWallet: {
          prepareWallet: async () => {},
          nearActions: { functionCall: (method, args, gas, deposit) => ({ method, args, gas: String(gas), deposit: String(deposit) }) },
          intear: { async signAndSendTransaction(tx) {
            window.transactions.push(tx);
            const [{ method, args }] = tx.actions;
            if (method === 'fund_account') state[tx.signerId] = { credit: '0', withdraw_pending: '0' };
            if (method === 'fund_listing') slot = true;
            if (method === 'nft_approve') {
              listing = { seller_id: seller, token_id: args.token_id, approval_id: 1, status: 'open', ...JSON.parse(args.msg) };
              fox.approved_account_ids[market] = 1;
            }
            if (method === 'prepare_purchase') {
              if (!localStorage.getItem('fox-nft-market:' + market + ':' + buyer)) throw new Error('Purchase draft must be stored before signing');
              purchase = { buyer_id: buyer, listing, status: 'prepared' };
              window.purchaseId = args.purchase_id;
            }
            if (method === 'ft_transfer_call') purchase = { ...purchase, status: 'pending' };
            if (method === 'withdraw_credit') state[buyer].credit = '0';
            return { status: { SuccessValue: '' } };
          } },
        },
      };
      window.menu = menu;
      window.openAs = address => {
        menu._identity = { kind: 'wallet', address, nearSession: 'session', config: { network: 'near-testnet' } };
        openNearMarket(menu, () => {});
      };
      window.refund = () => { purchase.status = 'refundable'; state[buyer].credit = '10001'; };
      window.changeRevision = value => { revision = value; };
      window.openAs(seller);
    });
    const contains = text => page.waitForFunction(value => document.body.innerText.includes(value), {}, text);
    const confirm = async () => {
      await page.waitForFunction(() => !document.querySelector('#fox-market-confirm').disabled);
      await page.click('#fox-market-confirm');
    };
    await page.waitForSelector('#fox-market-find');
    assert.equal(await page.evaluate(() => window.transactions.length), 0);
    await page.click('#fox-market-fund');
    await contains('0.05 NEAR retained');
    await confirm();
    await contains('Market account setup confirmed');
    await page.click('#fox-market-list');
    await contains('Set up listing storage for Fox #001');
    await confirm();
    await contains('Listing storage confirmed');
    await page.type('#fox-market-price', '0.000000000000000000010001');
    await page.click('#fox-market-list');
    await contains('Fox stays in your wallet');
    await confirm();
    await contains('Listing confirmed for Fox #001');

    await page.evaluate(() => window.openAs('buyer.testnet'));
    await page.waitForSelector('#fox-market-find');
    await page.type('#fox-market-token', '001');
    await page.click('#fox-market-find');
    await page.waitForSelector('#fox-market-buy');
    await page.evaluate(() => window.changeRevision(4));
    await page.click('#fox-market-buy');
    await contains('ownership or approval changed');
    assert.equal(await page.evaluate(() => window.transactions.length), 3);
    await page.evaluate(() => { window.changeRevision(3); window.activeMatch = true; });
    await page.click('#fox-market-buy');
    await contains('This Fox has an active match');
    assert.equal(await page.evaluate(() => window.transactions.length), 3);
    await page.evaluate(() => { window.activeMatch = false; });
    await page.click('#fox-market-buy');
    await contains('Purchase record storage 0.05 NEAR');
    await confirm();
    await contains('Pay for Fox #001');
    await page.evaluate(() => window.openAs('buyer.testnet'));
    await page.waitForSelector('#fox-market-find');
    await page.click('#fox-market-resume');
    await contains('Pay for Fox #001');
    await confirm();
    await contains('Payment submitted');
    await page.click('#fox-market-resume');
    await contains('NFT delivery is pending');
    await page.evaluate(() => window.refund());
    await page.click('#fox-market-resume');
    await contains('Your FOXO is available as a refund credit');
    await page.click('#fox-market-withdraw');
    await contains('Withdraw 0.000000000000000000010001 FOXO');
    await confirm();
    await contains('Withdrawal submitted');
    const { transactions, purchaseId } = await page.evaluate(() => ({ transactions: window.transactions, purchaseId: window.purchaseId }));
    assert.deepEqual(transactions.map(tx => tx.actions[0].method), ['fund_account', 'fund_listing', 'nft_approve', 'prepare_purchase', 'ft_transfer_call', 'withdraw_credit']);
    assert.equal(transactions[4].receiverId, 'foxo.xuancanh1.testnet');
    assert.equal(transactions[4].actions[0].args.amount, '10001');
    assert.deepEqual(JSON.parse(transactions[4].actions[0].args.msg), { purchase_id: purchaseId });

    await page.evaluate(() => { window.badCode = true; window.openAs('buyer.testnet'); });
    await contains('Fox market code could not be verified');
    assert.equal(await page.evaluate(() => window.transactions.length), 6);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
