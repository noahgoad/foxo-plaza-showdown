const MAX_SAMPLES = 1801;
const PREFIX = '#trial-ghost=';

export function trialGhostLink(href, key, duration, trace) {
  if (!validRecord({duration,trace}, 180)) throw Error('Complete a Daily Trial to share its ghost.');
  const coordinates = new Int16Array(trace.length * 3);
  trace.forEach((point, index) => point.forEach((value, axis) => {
    coordinates[index * 3 + axis] = Math.round(value * 100);
  }));
  const binary = String.fromCharCode(...new Uint8Array(coordinates.buffer));
  const url = new URL(href);
  url.hash = PREFIX.slice(1) + encodeURIComponent(key) + '!' + duration.toFixed(3) + '!' + btoa(binary);
  return url.href;
}

export function sharedTrialGhost(hash, key, maxDuration) {
  if (!hash.startsWith(PREFIX) || hash.length > 16500) return null;
  try {
    const [scope, seconds, payload, extra] = hash.slice(PREFIX.length).split('!');
    if (extra !== undefined || decodeURIComponent(scope) !== key || !payload) return null;
    const bytes = Uint8Array.from(atob(payload), value => value.charCodeAt(0));
    if (bytes.length % 6 || bytes.length > MAX_SAMPLES * 6) return null;
    const coordinates = new Int16Array(bytes.buffer);
    const trace = Array.from({length:coordinates.length / 3}, (_,i) =>
      Array.from(coordinates.subarray(i * 3, i * 3 + 3), value => value / 100));
    const record = {duration:Number(seconds),trace};
    return validRecord(record,maxDuration) ? record : null;
  } catch {
    return null;
  }
}

function validRecord({duration,trace}, maxDuration) {
  return Number.isFinite(duration) && duration > 0 && duration <= maxDuration &&
    Array.isArray(trace) && trace.length > 1 && trace.length <= MAX_SAMPLES &&
    trace.every(point => Array.isArray(point) && point.length === 3 &&
      point.every(value => Number.isFinite(value) && Math.abs(value) <= 327.67));
}
