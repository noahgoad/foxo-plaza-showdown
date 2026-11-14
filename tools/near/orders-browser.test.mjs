import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

const root = new URL('../../', import.meta.url);
const executablePath = [process.env.CHOG_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('buy-order modal reviews exact costs and reuses a pending operation after reopening', { skip: !executablePath }, async () => {
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://fixture').pathname;
    if (path === '/') {
      res.setHeader('Content-Type', 'text/html');
      return res.end('<html><body><main></main></body></html>');
    }
    if (path === '/assets/near-fox/economy-deployment.js') {
      res.setHeader('Content-Type', 'text/javascript');
      return res.end("export const economyDeployment={accountId:'economy.testnet',codeHash:'hash',recipes:[{recipeId:'finish',version:1,label:'Test finish',sku:'finish-a'}]}");
    }
    if (!/^\/(src|assets\/near-fox)\/[a-z0-9/.-]+\.(js|json)$/i.test(path) || path.includes('..')) {
      res.writeHead(404).end();
      return;
    }
    try {
      const data = await readFile(new URL('.' + path, root));
      res.setHeader('Content-Type', path.endsWith('.json') ? 'application/json' : 'text/javascript');
      res.end(data);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let browser;
  try {
    browser = await puppeteer.launch({ executablePath, headless: true });
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:' + server.address().port);
    await page.evaluate(async () => {
      const { openNearOrders } = await import('/src/ui/near-orders-ui.js');
      const account = 'alice.testnet';
      const foxo = 'foxo.xuancanh1.testnet';
      let order = null;
      window.funding = [];
      const realFetch = window.fetch;
      window.fetch = async (url, options) => {
        if (!String(url).startsWith('https://near-testnet.drpc.org')) return realFetch(url, options);
        const { params } = JSON.parse(options.body);
        if(params.request_type==='view_account')return new Response(JSON.stringify({result:{code_hash:'hash',block_hash:'final'}}));
        const value = {
          get_config: { network: 'near-testnet', foxoContractId: foxo, ordersEnabled: true },
          get_order_credit: '0', get_owned_items: [], get_order: order,
          get_order_storage_charge:'1',get_order_storage_credit:'1',get_order_storage_registration_charge:'0',
        }[params.method_name];
        return new Response(JSON.stringify({ result: {block_hash:'final', result: [...new TextEncoder().encode(JSON.stringify(value))] } }));
      };
      const button = (id, label, accept) => {
        const el = document.createElement('button');
        el.id = id;
        el.textContent = label;
        el.addEventListener('click', accept);
        return el;
      };
      const menu = {
        _identity: { kind: 'wallet', address: account, config: { network: 'near-testnet' } },
        _binds: new Map(),
        _btn: ({ id, label, accept }) => button(id, label, accept),
        _openModal({ title, text, buttons }) {
          this._modal?.remove();
          this._modal = document.createElement('section');
          const status = document.createElement('p');
          status.className = 'iw-modal__text';
          status.textContent = text;
          const actions = document.createElement('div');
          actions.className = 'iw-modal__btns';
          for (const [index, entry] of buttons.entries()) actions.append(button('modal-' + index, entry.label, entry.accept));
          this._modal.append(title, status, actions);
          document.querySelector('main').append(this._modal);
        },
        chogWallet: {
          prepareWallet: async () => {},
          nearActions: { functionCall: (method, args) => ({ method, args }) },
          intear: { async signAndSendTransaction({ receiverId, actions }) {
            if (receiverId !== foxo || actions[0].method !== 'ft_transfer_call') throw new Error('Wrong transfer target');
            const args = actions[0].args;
            window.funding.push(args);
            const terms = JSON.parse(args.msg);
            if (window.funding.length === 2) order = {
              buyerId: account, recipeId: terms.recipeId, recipeVersion: terms.recipeVersion,
              unitPrice: terms.unitPrice, expiresAtMs: terms.expiresAtMs, remaining: terms.quantity, closed: false,
            };
            return { status: { SuccessValue: '' } };
          } },
        },
      };
      window.openOrders = () => openNearOrders(menu, () => menu._modal.remove());
      window.openOrders();
    });
    await page.waitForFunction(() => !document.querySelector('#order-review').disabled);
    await page.type('input[inputmode=decimal]', '0.15');
    await page.$eval('input[type=number]', el => { el.value = '3'; });
    await page.click('#order-review');
    await page.waitForFunction(() => document.body.innerText.includes('Total 0.45 FOXO'));
    await page.click('#order-fund');
    await page.waitForFunction(() => document.body.innerText.includes('Order not confirmed yet'));
    await page.evaluate(() => window.openOrders());
    await page.waitForFunction(() => !document.querySelector('#order-review').disabled);
    await page.click('#order-review');
    await page.waitForFunction(() => document.body.innerText.includes('Saved order'));
    await page.click('#order-fund');
    await page.waitForFunction(() => document.body.innerText.includes('Order confirmed'));
    const [first, second] = await page.evaluate(() => window.funding);
    assert.equal(first.amount, '450000000000000000000000');
    assert.deepEqual(second, first);
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
