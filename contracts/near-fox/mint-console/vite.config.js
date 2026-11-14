import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const app = fileURLToPath(new URL('./', import.meta.url));
const projectPath = path => fileURLToPath(new URL('../../../' + path, import.meta.url));
const modules = ['economy', 'passport', 'pool', 'guild', 'market'];
const wasmFiles = modules.map(name =>
  projectPath(`contracts/near-${name}/target/wasm32-unknown-unknown/release/near_${name}.wasm`));

export default defineConfig({
  server: { fs: { allow: [
    app,
    ...wasmFiles,
    projectPath('contracts/near-fox/target/near_fox.opt.wasm'),
    projectPath('contracts/near-claims/target/near_claims.opt.wasm'),
    projectPath('nft-art/testnet-88/mint-plan.json'),
    projectPath('assets/near-fox/economy-catalogue.js'),
    projectPath('config/economy-deployment-manifest.json'),
  ] } },
  build: {
    rollupOptions: {
      input: {
        mint: fileURLToPath(new URL('./index.html', import.meta.url)),
        claims: fileURLToPath(new URL('./claims.html', import.meta.url)),
        economy: fileURLToPath(new URL('./economy.html', import.meta.url)),
        modules: fileURLToPath(new URL('./modules.html', import.meta.url)),
        activate: fileURLToPath(new URL('./activate.html', import.meta.url)),
      },
    },
  },
});
