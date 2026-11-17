import { ChogWalletUI } from './chog-wallet-ui.js';

import { openIncomingFoxLoans } from './near-loans-ui.js';
import { FOXO_EXPLORER, FOXO_ICON, NEAR_TESTNET, nearRelayUrl, readNearAssets, readNearClaims, readNearFox, viewNearContract, readNearAccountCode, formatFoxo } from './near-testnet-assets.js';
import { verifyEconomyDeployment } from '../economy/near-deployment.js';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { h } from './ui-util.js';
import { GLYPHS } from './ui-icons.js';
import { foxoProductEvent } from '../game/foxo-product-telemetry.js';

export class NearWalletUI extends ChogWalletUI {
  prepareWallet() {
    return this.walletSetup ||= import('../../assets/near-fox/intear-wallet.js')
      .then(async module => {
        this.intear = await module.openNearWallet();
        this.nearActions = module.nearActions;
        this.createPoolRegistrationSigner = module.createPoolRegistrationSigner;
      })
      .catch(error => { this.walletSetup = null; throw error; });
  }

  renderIdentity(panel) {
    this.clearBindings(panel);
    const state = this.menu._identity;
    panel.classList.add('chog-identity');
    panel.classList.toggle('is-entry', !state);
    panel.classList.toggle('has-near-wallet', state?.kind === 'wallet');
    const connect = () => this.connect();
    if (!state) {
      this.prepareWallet().catch(() => {});
      const socialPreview = location.origin === 'http://localhost:3000';
      const localGame = location.port === '8817' && ['127.0.0.1', 'localhost'].includes(location.hostname);
      const social = this.socialEnabled || socialPreview || localGame
        ? () => this.startSocial(localGame && !this.socialEnabled)
        : null;
      panel.replaceChildren(this.button('connect-wallet', 'CONNECT INTEAR', connect, true),
        ...(social ? [this.button('social-login', 'SOCIAL SIGN-IN', social)] : []),
        this.button('guest', 'GUEST', () => {
          this.menu._identity = { kind: 'guest' };
          this.message = '';
          this.repaint();
        }), ...(this.busy && this.message ? [this.status()] : []));
      this.checkSocial();
      return;
    }

    const guest = state.kind !== 'wallet';
    const nft = state.nft;
    const socialAddress = state.socialSession?.wallet?.accountId;
    panel.replaceChildren(...[
      ...(!guest ? [h('div', { class: 'near-profile-tools' },
        this.profileIcon('near-refresh', 'Refresh wallet', GLYPHS.reset, () => this.run(() => this.refresh(), false)),
        this.profileIcon('change-account', 'Disconnect wallet', GLYPHS.exit, () => this.disconnect()))] : []),
      h('div', { class: 'chog-avatar-frame' }, h('img', { src: nft?.image || FOXO_ICON, alt: nft?.name || 'Fox' })),
      h('div', { class: 'iw-profile__info' },
        h('div', { class: 'iw-profile__name', title: state.address || socialAddress || '' },
          state.socialSession ? socialAddress || 'SOCIAL PLAYER' : guest ? 'GUEST' : nft?.name || state.address),
        guest ? (socialAddress
          ? h('div', { class: 'chog-game-balance' }, h('span', null, 'NEAR TESTNET WALLET'),
            h('strong', null, state.socialBalance === undefined ? '—' : state.socialBalance + ' FOXO'))
          : null) : h('div', { class: 'chog-game-balance' },
          h('span', null, 'NEAR TESTNET WALLET'),
          h('strong', { 'data-foxo-balance': '', role: 'status' },
            h('img', { src: FOXO_ICON, alt: '', width: 20, height: 20, style: { verticalAlign: 'middle', marginRight: '0.3em' } }),
            state.tokenBalance === undefined ? '—' : state.tokenBalance + ' FOXO'))),
      this.progressView(nft),
      h('div', { class: 'chog-wallet-actions' },
        guest ? this.button('profile-connect', 'CONNECT INTEAR', connect, true)
          : this.button('profile-claim', 'CLAIM', () => this.openClaims(), true),
        guest ? null : this.button('foxo-contract', 'VIEW FOXO', () => window.open(FOXO_EXPLORER, '_blank', 'noopener,noreferrer')),
        guest ? this.button('change-account', 'BACK', () => this.disconnect()) : null),
      this.busy && this.message ? this.status() : null,
    ].filter(node => node != null));
  }

  profileIcon(id, label, icon, action) {
    const button = this.menu._btn({
      id, label: '', icon, cls: 'iw-btn--small near-profile-icon',
      accept: () => { if (!this.busy) action(); },
    });
    button.setAttribute('aria-label', label);
    button.title = label;
    button.disabled = this.busy;
    return button;
  }

  async onlineAuth(path, data) {
    const localSocial = location.origin === 'http://localhost:3000' && path.startsWith('social-');
    let response;
    try {
      response = await fetch((localSocial ? location.origin : nearRelayUrl()) + '/near-auth/' + path, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(data), signal: AbortSignal.timeout(15000),
      });
    } catch {
      throw new Error('Could not reach the game sign-in server. Try again in a moment.');
    }
    const result = await response.json().catch(() => null);
    if (!response.ok || !result) throw new Error(result?.error || 'Online wallet verification unavailable.');
    return result;
  }

  checkSocial() {
    if (this.socialCheck) return;
    let returning = false;
    this.socialCheck = Promise.resolve().then(async () => {
      const url = new URL(location.href);
      const pending = JSON.parse(sessionStorage.getItem('fox-social-pending') || 'null');
      returning = Boolean(pending && url.searchParams.get('state') === pending.state);
      if (returning && typeof pending.returnPath === 'string') {
        const original = new URL(pending.returnPath, location.origin);
        if (original.origin === location.origin) {
          // Restore the relay override and game path that initiated sign-in.
          for (const key of ['state', 'code', 'error', 'error_description']) {
            const value = url.searchParams.get(key);
            if (value !== null) original.searchParams.set(key, value);
          }
          history.replaceState(null, '', original);
          url.href = original.href;
        }
      }
      const { enabled } = await this.onlineAuth('social-status', {});
      this.socialEnabled = enabled === true;
      if (!this.socialEnabled || this.menu._identity) return;
      if (pending && url.searchParams.get('state') === pending.state) {
        const code = url.searchParams.get('code');
        for (const key of ['state', 'code', 'error', 'error_description']) url.searchParams.delete(key);
        history.replaceState(null, '', url);
        sessionStorage.removeItem('fox-social-pending');
        if (!code) throw Error('Social sign-in was cancelled.');
        const socialSession = await this.onlineAuth('social-login', { state: pending.state, key: pending.key, code });
        if (!this.menu._identity) {
          sessionStorage.setItem('fox-social-session', socialSession.token);
          this.menu._identity = { kind: 'guest', socialSession };
        }
      } else {
        const token = sessionStorage.getItem('fox-social-session');
        if (!token) return;
        const session = await this.onlineAuth('social-session', { token }).catch(() => {
          sessionStorage.removeItem('fox-social-session');
          return null;
        });
        if (session && !this.menu._identity) this.menu._identity = { kind: 'guest', socialSession: { ...session, token } };
      }
    }).catch(error => {
      if (returning) this.menu.toast(error.message, {kind:'error'});
    }).finally(() => {
      if (!this.socialEnabled && !returning) this.socialCheck = null;
      if (this.socialEnabled || returning) this.repaint();
    });
  }

  startSocial(useLocalPreview = false) {
    if (this.busy || this.menu._identity) return;
    this.socialPopup?.cancel();
    const bridge = useLocalPreview
      ? new URL('http://localhost:3000/assets/near-fox/social-popup.html')
      : new URL('../../assets/near-fox/social-popup.html', import.meta.url);
    const nonce = crypto.randomUUID();
    const returnPage = new URL('../../assets/near-fox/social-popup.html', import.meta.url);
    bridge.hash = new URLSearchParams({ returnPage: returnPage.href, nonce }).toString();
    const popup = window.open(bridge.href, '_blank', 'popup,width=540,height=720');
    if (!popup) {
      this.menu.toast('Allow pop-ups for this site, then try Social Sign-In again.', {kind:'error'});
      return;
    }
    const channel = new BroadcastChannel('fox-social-' + nonce);
    const cleanup = () => {
      clearTimeout(timeout);
      channel.close();
      this.socialPopup = null;
    };
    channel.onmessage = ({ data }) => {
      if (!data || (!data.error && (!data.session?.token || !data.session?.profileId))) return;
      channel.postMessage({received:true});
      cleanup();
      popup.close();
      window.focus();
      if (data.error) {
        this.menu.toast(data.error, {kind:'error'});
      } else if (!this.menu._identity && data.session?.token && data.session?.profileId) {
        const socialSession = data.session;
        if (bridge.origin === location.origin) sessionStorage.setItem('fox-social-session', socialSession.token);
        const identity = this.menu._identity = { kind: 'guest', socialSession };
        this.repaint();
        const accountId = socialSession.wallet?.accountId;
        if (socialSession.wallet?.unavailable) {
          this.menu.toast('Testnet wallet could not be verified. Sign in again to retry.', {kind:'error'});
        }
        if (accountId) readNearAssets(accountId).then(({ profiles, tokenBalance }) => {
          if (this.menu._identity !== identity) return;
          identity.socialBalance = tokenBalance;
          identity.nft = profiles[0] || null;
          this.repaint();
        }).catch(error => {
          if (this.menu._identity === identity) this.menu.toast(error.message, {kind:'error'});
        });
      }
    };
    const timeout = setTimeout(cleanup, 5 * 60 * 1000);
    this.socialPopup = { cancel: () => { cleanup(); popup.close(); } };
  }

  async openClaims({ assetsOnly=false } = {}) {
    const state = this.menu._identity;
    if (this.busy || state?.kind !== 'wallet' || this.menu._modal?.isConnected) return;
    if (!assetsOnly && economyDeployment.accountId && state.nearSession) {
      if(this.loadingFixedClaims)return;
      state.fixedClaims=undefined;
      this.loadingFixedClaims=true;
      try { await this.loadFixedClaims(state); }
      finally { this.loadingFixedClaims=false; }
      if (this.menu._identity !== state || this.menu._modal?.isConnected) return;
    }
    if (!assetsOnly && state.fixedClaims?.length) return this.showFoxoRewards(state);
    const claims = state.claims;
    const choose = method => () => {
      this.menu._closeModal();
      this.claimModal = null;
      if (this.menu._identity === state) this.claim(method);
    };
    const nftReady = claims?.available > 0 && claims.nftStatus === 'eligible';
    const foxoReady = !!claims?.faucetFunded && !claims.pending && Date.now() >= (claims.nextClaim || 0);
    const loading = claims === null ? 'Status unavailable · refresh wallet' : 'Checking availability…';
    this.showClaimMenu([
      {
        label: '1 NFT', icon: GLYPHS.star, disabled: !nftReady, accept: choose('claim_nft'),
        sub: !claims ? loading : nftReady ? 'One NFT per wallet' :
          claims.nftStatus === 'claimed' ? 'Already received' :
          claims.nftStatus === 'pending' ? 'Transfer in progress' : 'No NFTs available',
      },
      {
        label: '10 FOXO', icon: `<img src="${FOXO_ICON}" alt="">`,
        disabled: !foxoReady, accept: choose('claim_foxo'),
        sub: !claims ? loading : claims.pending ? 'Transfer in progress' :
          !claims.faucetFunded ? 'Faucet is empty' : !foxoReady ? 'Daily claim on cooldown' :
          claims.storageDeposit ? 'Includes FOXO wallet registration' : 'Daily testnet tokens',
      },
    ]);
  }

  showFoxoRewards(state, offset = 0) {
    if (this.menu._identity !== state || this.menu._modal?.isConnected) return;
    const entries = state.fixedClaims ?? [];
    const pageSize = 4;
    const choose = action => () => {
      if (this.menu._identity !== state) return;
      this.menu._closeModal();
      this.claimModal = null;
      action();
    };
    const rows = entries.slice(offset, offset + pageSize).map(entry => ({
      label: formatFoxo(entry.amountAtomic) + ' FOXO', icon: `<img src="${FOXO_ICON}" alt="">`,
      sub: entry.mode.toUpperCase() + ({ranking:' · Ranking reward',guild:' · Guild mission reward'}[entry.source] || ' · Match reward'),
      accept: choose(() => this.claimFixed(state, entry)),
    }));
    if (entries.length > pageSize) {
      const next = offset + pageSize < entries.length ? offset + pageSize : 0;
      rows.push({
        label: next ? 'NEXT REWARDS' : 'FIRST REWARDS', icon: GLYPHS.gamepad,
        sub: `${offset + 1}–${Math.min(offset + pageSize, entries.length)} of ${entries.length}`,
        accept: choose(() => this.showFoxoRewards(state, next)),
      });
    }
    rows.push({
      label: 'NFT & FAUCET', icon: GLYPHS.star, sub: 'Other claims',
      accept: choose(() => this.openClaims({ assetsOnly: true })),
    });
    this.showClaimMenu(rows);
  }

  async loadFixedClaims(state) {
    const {address,nearSession}=state;
    const active=()=>this.menu._identity===state && state.address===address && state.nearSession===nearSession;
    try {
      const response = await fetch(nearRelayUrl() + '/near/rewards/claims', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nearSession: state.nearSession }), signal: AbortSignal.timeout(10_000) });
      if (!response.ok) throw new Error('Match rewards are unavailable.');
      const result = await response.json();
      if (result.economyId !== economyDeployment.accountId || !Array.isArray(result.entries)) return;
      const {blockHash}=await verifyEconomyDeployment({deployment:economyDeployment,tokenId:NEAR_TESTNET.token,readCode:readNearAccountCode,view:viewNearContract});
      const entries = [], candidates=result.entries.slice(0,100);
      for(let i=0;i<candidates.length;i+=6) {
        if(!active())return;
        const verified=await Promise.all(candidates.slice(i,i+6).map(async entry=>{
          if(typeof entry?.operationId!=='string'||!entry.operationId||entry.operationId.length>96)return null;
          const observed=await viewNearContract(result.economyId,'get_entitlement',{operation_id:entry.operationId},{blockId:blockHash});
          const {value}=observed;
          if(observed.blockHash!==blockHash||value?.operationId!==entry.operationId||value.accountId!==address||value.status!=='reserved'||value.amountAtomic!==entry.amountAtomic)return null;
          return {...entry,mode:['boss','trials','hunt','control'].includes(entry.mode)?entry.mode:'match'};
        }));
        entries.push(...verified.filter(Boolean));
      }
      if (active()) state.fixedClaims = entries;
    } catch (error) {
      if (this.menu._identity === state) this.menu.toast(error.message);
    }
  }

  async claimFixed(state, entry) {
    if (this.menu._identity !== state) return;
    const {address,nearSession}=state;
    const active=()=>this.menu._identity===state && state.address===address && state.nearSession===nearSession;
    await this.run(async progress => {
      await this.prepareWallet();
      if(!active())throw new Error('Wallet changed. Reopen claims.');
      const {blockHash}=await verifyEconomyDeployment({deployment:economyDeployment,tokenId:NEAR_TESTNET.token,readCode:readNearAccountCode,view:viewNearContract});
      const observed=await viewNearContract(economyDeployment.accountId,'get_entitlement',{operation_id:entry.operationId},{blockId:blockHash});
      if(!active())throw new Error('Wallet changed. Reopen claims.');
      if(observed.blockHash!==blockHash||observed.value?.operationId!==entry.operationId||observed.value.status!=='reserved'||observed.value.accountId!==address||observed.value.amountAtomic!==entry.amountAtomic)throw new Error('Reward status changed. Refresh claims.');
      progress('Confirm the FOXO reward in Intear.');
      await this.intear.signAndSendTransaction({ signerId: address, receiverId: economyDeployment.accountId,
        actions: [this.nearActions.functionCall('claim', { operation_id: entry.operationId }, 100n * 10n ** 12n, 1n)] });
      const { value } = await viewNearContract(economyDeployment.accountId, 'get_entitlement', { operation_id: entry.operationId });
      if(!active())return;
      if (value?.operationId !== entry.operationId || value.status !== 'paid' || value.accountId !== address ||
          value.amountAtomic !== entry.amountAtomic) throw new Error('Reward transfer is pending. Refresh before retrying.');
      state.fixedClaims = state.fixedClaims?.filter(row => row.operationId !== entry.operationId);
      this.menu.toast('FOXO reward received.');
    });
  }

  async claim(method) {
    const state = this.menu._identity;
    if (!state?.claims || !this.nearActions || !this.intear) return;
    const register = method === 'storage_deposit';
    await this.run(async progress => {
      progress('Confirm the transaction in Intear.');
      const transaction = {
        signerId: state.address,
        receiverId: register ? NEAR_TESTNET.token : NEAR_TESTNET.claims,
        actions: [this.nearActions.functionCall(method,
          register ? { account_id: state.address, registration_only: true } : {},
          80n * 10n ** 12n, register ? BigInt(state.claims.storageDeposit) : 1n)],
      };
      let result;
      if (method === 'claim_foxo' && state.claims.storageDeposit) {
        const [registration, claim] = await this.intear.signAndSendTransactions({ transactions: [{
          signerId: state.address, receiverId: NEAR_TESTNET.token,
          actions: [this.nearActions.functionCall('storage_deposit', {
            account_id: state.address, registration_only: true,
          }, 30n * 10n ** 12n, BigInt(state.claims.storageDeposit))],
        }, transaction] });
        if (typeof registration?.status?.SuccessValue !== 'string' && typeof claim?.status?.SuccessValue !== 'string') {
          throw new Error('FOXO registration or claim could not be confirmed. Refresh your wallet.');
        }
        result = claim;
      } else {
        result = await this.intear.signAndSendTransaction(transaction);
      }
      const success = result?.status?.SuccessValue;
      if (typeof success !== 'string' || (!register && atob(success) !== 'true')) {
        throw new Error('Transfer was not confirmed. Refresh your wallet before trying again.');
      }
      this.menu.toast(register ? 'FOXO registered.' : 'Claim confirmed.');
    });
  }

  async connect() {
    if (this.busy || this.menu._modal?.isConnected) return;
    if (!this.intear) {
      await this.run(async () => {
        await this.prepareWallet();
      }, false);
    }
    if (!this.intear || !this.menu._scr?.el.isConnected) return;

    await this.run(async progress => {
      const epoch = this.epoch;
      let verified = false;
      try {
        progress('Choose your NEAR Testnet account in Intear.');
        const [account] = await this.intear.signIn({});
        if (!account?.accountId) throw new Error('No account connected.');
        const challenge = await this.onlineAuth('challenge', { accountId: account.accountId });
        if (epoch !== this.epoch) return;
        progress('Confirm the sign-in message in Intear.');
        const signature = await this.intear.signMessage({
          message: challenge.message, recipient: challenge.recipient,
          nonce: globalThis.Buffer.from(challenge.nonce, 'base64'),
        });
        if (epoch !== this.epoch) return;
        const result = await this.onlineAuth('login', { ...signature, nonce: challenge.nonce });
        if (!result.token || !(result.expires > Date.now())) throw new Error('Online wallet verification unavailable.');
        if (epoch !== this.epoch) {
          this.onlineAuth('logout', { token: result.token }).catch(() => {});
          return;
        }
        this.menu._identity = {
          kind: 'wallet', address: account.accountId, config: NEAR_TESTNET,
          nearSession: result.token, nearSessionExpires: result.expires,
        };
        verified = true;
      } finally {
        this.intear.closeGameConnector();
        if (!verified) await this.intear.signOut().catch(() => {});
      }
      await this.refresh();
      if (verified && epoch === this.epoch) foxoProductEvent('wallet_connected', { identity: this.menu._identity });
    }, false);
  }

  async refresh() {
    const state = this.menu._identity;
    if (state?.kind !== 'wallet') return;
    state.fixedClaims = undefined;
    if (state.nearSession && state.nearSessionExpires <= Date.now()) {
      this.disconnect();
      this.menu.toast('Wallet session expired. Connect Intear to sign in again.', {kind:'error'});
      return;
    }
    this.message = 'Reading assets from NEAR Testnet…';
    try {
      const { profiles, tokenBalance } = await readNearAssets(state.address);
      if (this.menu._identity !== state) return;
      this.nftProfiles = new Map(profiles.map(profile => [profile.tokenId, profile]));
      const ownedTokenIds = [...this.nftProfiles.keys()];
      const equipped = this.nftProfiles.get(localStorage.getItem(this.nftKey())) || profiles[0];
      state.nft = equipped ? { ...equipped, ownedTokenIds } : null;
      state.tokenBalance = tokenBalance;
      state.error = null;
      this.nftPreview = null;
      this.message = '';
      readNearClaims(state.address).then(claims => {
        if (this.menu._identity !== state) return;
        state.claims = claims;
        this.repaint();
      }).catch(() => {
        if (this.menu._identity === state && !state.claims) {
          state.claims = null;
          this.repaint();
        }
      });
    } catch (error) {
      if (this.menu._identity !== state) return;
      state.nft = null;
      state.tokenBalance = undefined;
      this.nftProfiles = null;
      this.nftPreview = null;
      state.error = this.message = error.message;
      this.menu.toast(this.message, {kind:'error'});
    }
    this.repaint();
  }

  async readNft(id) {
    const state = this.menu._identity;
    const profile = await readNearFox(state.address, id);
    if (this.menu._identity !== state) throw new Error('Wallet changed.');
    return { ...profile, ownedTokenIds: state.nft.ownedTokenIds };
  }

  disconnect() {
    const state = this.menu._identity;
    super.disconnect();
    if (state?.kind === 'wallet') this.intear?.signOut().catch(() => {});
    if (state?.nearSession) this.onlineAuth('logout', { token: state.nearSession }).catch(() => {});
    if (state?.socialSession) {
      sessionStorage.removeItem('fox-social-session');
      this.onlineAuth('social-logout', { token: state.socialSession.token }).catch(() => {});
    }
  }

  requirePlayer() {
    if (!this.menu._identity || this.busy) {
      this.menu.toast(this.busy ? 'Wait for the wallet request to finish.' : 'Connect Intear or choose GUEST before playing.');
      return false;
    }
    return true;
  }

  gameBalance() {
    try { return this.gameLedger().balance; }
    catch { return null; }
  }

  lockerModel() { return 'varsity'; }

  renderLocker(body) {
    super.renderLocker(body);
    if(this.menu._identity?.kind==='wallet'&&this.menu._identity?.nearSession) {
      body.querySelector('.chog-nft-collection')?.append(this.button('fox-incoming-loans','BORROWED FOXES',()=>openIncomingFoxLoans(this.menu)));
    }
    const selected = body._selectedNft;
    if (!selected?.tokenId || selected.contract !== NEAR_TESTNET.nft) return;
    const detail = body.querySelector('.chog-nft-details');
    if (detail) {
      if (selected.borrowed) detail.append(h('p', { class: 'chog-wallet-status' }, 'Borrowed usage only · Owner: ' + selected.ownerId + ' · Expires: ' + new Date(selected.sourceLoan?.expiresAt).toLocaleString('en-US')));
      detail.append(this.button('fox-career', 'FOX PASSPORT', () => this.showFoxCareer(selected)));
    }
  }

  showFoxCareer(nft) {
    this.menu._passportNft = nft;
    this.menu._go('foxPassport');
  }

  renderLockerPortraits(body) {
    for (const tile of body.querySelectorAll('.chog-nft-tile:not(.is-empty)')) {
      const profile = tile._nftProfile;
      if (!profile) continue;
      tile.querySelector('.iw-ltile__art').replaceChildren(
        h('span', { class: 'iw-ltile__pic' }, h('img', { src: profile.image, alt: '', loading: 'lazy',
          style: { width: '100%', height: '100%', objectFit: 'contain' } })));
      tile.classList.add('has-pic');
    }
  }
}
