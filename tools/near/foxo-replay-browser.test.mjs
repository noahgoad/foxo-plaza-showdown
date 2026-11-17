import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import test from 'node:test';
import puppeteer from 'puppeteer-core';

const root = new URL('../../', import.meta.url);
const executablePath = [process.env.CHOG_BROWSER_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', '/usr/bin/chromium'].find(path => path && existsSync(path));

test('Chrome exports a replay frame and a playable clip payload', { skip:!executablePath }, async () => {
  const server = createServer(async (request,response) => {
    const path = new URL(request.url,'http://local').pathname;
    if (path === '/') return response.end('<!doctype html><main></main>');
    if (!/^\/(src|assets)\/[\w./-]+\.(js|json)$/.test(path) || path.includes('..')) return response.writeHead(404).end();
    try {
      const file = await readFile(new URL('.'+path,root));
      response.setHeader('content-type',path.endsWith('.json')?'application/json':'text/javascript');
      response.end(file);
    } catch { response.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    browser = await puppeteer.launch({executablePath,headless:true});
    const page = await browser.newPage();
    await page.goto('http://127.0.0.1:'+server.address().port);
    const exports = await page.evaluate(async () => {
      const downloads = [];
      HTMLAnchorElement.prototype.click = function () {
        downloads.push(fetch(this.href).then(r => r.blob()).then(blob => ({name:this.download,type:blob.type,size:blob.size})));
      };
      const {openHuntReplay} = await import('/src/ui/foxo-replay-ui.js');
      const dialog = openHuntReplay({
        players:[{id:'hunt-0',name:'Fox 1'}],events:[],
        frames:Array.from({length:8},(_,i) => ({
          tick:i*200,carrier:'hunt-0',positions:[{id:'hunt-0',active:true,x:i,z:i}],
        })),
      });
      const button = label => [...dialog.querySelectorAll('button')].find(node => node.textContent===label);
      button('SAVE FRAME').click();
      button('SAVE CLIP').click();
      for (let i=0; i<100 && downloads.length<2; i++) await new Promise(resolve => setTimeout(resolve,50));
      dialog.close();
      return Promise.all(downloads);
    });
    assert(exports.some(file => file.type==='image/png' && file.size>0));
    assert(exports.some(file => file.type.startsWith('video/') && file.size>100));
  } finally {
    await browser?.close();
    await new Promise(resolve => server.close(resolve));
  }
});
