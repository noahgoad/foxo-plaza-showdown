import { nearRelayUrl } from '../ui/near-testnet-assets.js';

const storageKey = 'foxo.metrics.visitor';
const id = () => crypto.randomUUID().replaceAll('-', '');

export function foxoProductEvent(name, { identity, context = 'menu', mode } = {}) {
  if (navigator.doNotTrack === '1' || navigator.globalPrivacyControl || !crypto.randomUUID) return;
  const query = new URLSearchParams(location.search);
  if (query.has('huntSim')) return;
  if (query.has('autostart') || query.has('assetAudit') || query.has('devstage')) context = 'demo';
  let visitor;
  try {
    visitor = localStorage.getItem(storageKey);
    if (!/^[a-f0-9]{32}$/.test(visitor ?? '')) {
      visitor = id();
      localStorage.setItem(storageKey, visitor);
    }
  } catch { return; }
  const audience = identity?.kind === 'wallet' ? (identity.nft ? 'holder' : 'wallet') : 'guest';
  void fetch(nearRelayUrl() + '/near/telemetry', {
    method: 'POST', headers: { 'content-type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ visitor, eventId: id(), name, audience, context, mode }),
  }).catch(() => {});
}
