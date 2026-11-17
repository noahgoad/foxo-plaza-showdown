const origin = new URL(process.argv[2] ?? 'https://foxo-plaza.vercel.app/');

async function probe(name, path, validate) {
  const url = new URL(path, origin);
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12000) });
    const ok = response.ok && await validate(response);
    return { name, httpStatus: response.status, ok };
  } catch (error) {
    return { name, ok: false, reason: error.name };
  }
}

const results = await Promise.all([
  probe('Game page', origin, response => response.headers.get('content-type')?.includes('text/html') ?? false),
  probe('Relay health', '/relay/health', async response => {
    if (!response.headers.get('content-type')?.includes('application/json')) return false;
    const body = await response.json();
    return body.ok === true;
  }),
]);

console.log(JSON.stringify({ origin: origin.origin, checkedAt: new Date().toISOString(), results }, null, 2));
if (results.some(result => !result.ok)) process.exitCode = 1;
