import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { KeyPair } from 'near-api-js';
import manifest from '../../config/economy-deployment-manifest.json' with { type: 'json' };

const directory = new URL('../../outputs/near-secrets/', import.meta.url);
await mkdir(directory, { recursive: true });
const signers = {};
for (const role of ['quartermaster', 'sponsor']) {
  const file = new URL(role + '.key', directory);
  const key = KeyPair.fromRandom('ed25519');
  try {
    await writeFile(file, key.toString() + '\n', { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error.code !== 'EEXIST') throw error;
  }
  const saved = KeyPair.fromString((await readFile(file, 'utf8')).trim());
  signers[role] = { accountId: role + '.' + manifest.operatorId, publicKey: saved.getPublicKey().toString() };
}
await writeFile(new URL('../../contracts/near-fox/mint-console/pilot-keys.json', import.meta.url),
  JSON.stringify(signers, null, 2) + '\n');
