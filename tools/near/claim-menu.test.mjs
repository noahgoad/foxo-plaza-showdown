import test from 'node:test';
import assert from 'node:assert/strict';
import { NearWalletUI } from '../../src/ui/near-wallet-ui.js';

test('FOXO claims paginate and keep the exact selected reward and wallet', () => {
  const entries = Array.from({ length: 5 }, (_, index) => ({
    operationId: 'reward:' + index, amountAtomic: '5000000000000000000000000',
    mode: 'boss', source: index === 4 ? 'ranking' : 'fixed',
  }));
  const state = { fixedClaims: entries };
  const ui = Object.create(NearWalletUI.prototype);
  let rows, claimed, assets;
  ui.menu = { _identity: state, _closeModal() { this._modal = null; } };
  ui.showClaimMenu = value => {
    rows = value;
    ui.menu._modal = { isConnected: true };
  };
  ui.claimFixed = (identity, entry) => { claimed = { identity, entry }; };
  ui.openClaims = options => { assets = options; };

  ui.showFoxoRewards(state);
  assert.deepEqual(rows.map(row => row.label), [
    '5 FOXO', '5 FOXO', '5 FOXO', '5 FOXO', 'NEXT REWARDS', 'NFT & FAUCET',
  ]);
  rows[4].accept();
  assert.equal(rows[0].sub, 'BOSS · Ranking reward');
  rows[0].accept();
  assert.deepEqual(claimed, { identity: state, entry: entries[4] });
  rows.at(-1).accept();
  assert.deepEqual(assets, { assetsOnly: true });
  ui.menu._identity = { fixedClaims: [] };
  claimed = null;
  rows[0].accept();
  assert.equal(claimed, null);
});
