const storageKey = 'fox-social-popup';
const params = new URLSearchParams(location.hash.slice(1));
history.replaceState(null, '', location.pathname);
const local = location.origin === 'http://localhost:3000';
const authBase = local ? '/near-auth/' : '/relay/near-auth/';
const status = document.getElementById('status');
let pending;

async function auth(action, data) {
  let response;
  try {
    response = await fetch(authBase + action, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(data), signal: AbortSignal.timeout(action === 'social-login' ? 90000 : 15000),
    });
  } catch {
    throw Error('Could not reach the game sign-in server. Try again in a moment.');
  }
  const result = await response.json().catch(() => null);
  if (!response.ok || !result) throw Error(result?.error || 'Social sign-in is unavailable.');
  return result;
}

function report(result) {
  if (!pending) return;
  const page = new URL(pending.returnPage);
  if (page.origin === location.origin) {
    deliver(pending.nonce, result);
    return;
  }
  page.hash = new URLSearchParams({ nonce: pending.nonce, result: JSON.stringify(result) }).toString();
  location.replace(page.href);
}

function deliver(nonce, result) {
  if (!/^[a-f0-9-]{36}$/.test(nonce || '')) throw Error('Invalid sign-in return.');
  const channel = new BroadcastChannel('fox-social-' + nonce);
  status.textContent = result.error || 'Returning to the game…';
  channel.onmessage = ({data}) => {
    if (data?.received !== true) return;
    channel.close();
    window.close();
    status.textContent = 'You can close this window and return to the game.';
  };
  channel.postMessage(result);
  setTimeout(() => {
    channel.close();
    if (!result.error) status.textContent = 'Return to the game. If you are still signed out, try Social Sign-In again.';
  }, 4000);
}

try {
  if (params.has('result')) {
    deliver(params.get('nonce'), JSON.parse(params.get('result')));
  } else if (params.has('state')) {
    pending = JSON.parse(sessionStorage.getItem(storageKey) || 'null');
    if (!pending || pending.state !== params.get('state')) throw Error('Social sign-in expired. Try again from the game.');
    sessionStorage.removeItem(storageKey);
    if (!params.get('code')) throw Error('Social sign-in was cancelled.');
    status.textContent = 'Finishing sign-in…';
    const session = await auth('social-login', { state: pending.state, key: pending.key, code: params.get('code') });
    report({ session });
  } else {
    const returnPage = new URL(params.get('returnPage'));
    const nonce = params.get('nonce');
    const allowedOrigin = returnPage.origin === location.origin || (local &&
      ['http://127.0.0.1:8817', 'http://localhost:8817'].includes(returnPage.origin));
    if (!allowedOrigin || !['/assets/near-fox/social-popup.html', '/dist/assets/near-fox/social-popup.html'].includes(returnPage.pathname) ||
        returnPage.username || returnPage.password || returnPage.search || !/^[a-f0-9-]{36}$/.test(nonce || '')) {
      throw Error('Open Social Sign-In from the game.');
    }
    pending = { returnPage: returnPage.href, nonce };
    const { enabled, issuerOrigin } = await auth('social-status', {});
    if (!enabled) throw Error('Social sign-in is unavailable.');
    const key = Array.from(crypto.getRandomValues(new Uint8Array(32)), byte => byte.toString(16).padStart(2, '0')).join('');
    const { state, url } = await auth('social-start', { key });
    const target = new URL(url);
    if (target.origin !== issuerOrigin || target.protocol !== 'https:') throw Error('Unexpected social provider.');
    sessionStorage.setItem(storageKey, JSON.stringify({ ...pending, state, key }));
    location.replace(target.href);
  }
} catch (error) {
  status.textContent = error.message;
  report({ error: error.message });
}
