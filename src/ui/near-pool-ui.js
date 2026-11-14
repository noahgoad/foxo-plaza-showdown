import { h } from './ui-util.js';
import { NEAR_TESTNET, nearRelayUrl, formatFoxo, viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { poolDeployment } from '../../assets/near-fox/pool-deployment.js';
import { foxoAmount, poolCall, readPoolSnapshot } from '../economy/near-pool.js';
import { sponsorPoolRegistration } from '../economy/near-pool-sponsorship.js';
import { economyPanel, economyPanelActive } from './near-economy-page.js';

export function openNearPool(menu, back = () => menu._closeModal(), host) {
  const identity = menu._identity;
  const account = identity?.address;
  const wallet = menu.chogWallet;
  const modal = economyPanel(menu, host, { title:'FOXO BOSS POOL', text:'Stake FOXO and keep your NFT in your wallet.',
    buttons:[{label:'BACK',accept:back}] });
  modal.classList.add('near-game-panel');
  modal.classList.add('chog-raid-pool-modal');
  modal.querySelector('.iw-modal__splat')?.remove();
  const body = h('div',{class:'chog-raid-pool-body'});
  const status = h('p',{class:'chog-wallet-status',role:'status','aria-live':'polite'});
  modal.querySelector('.iw-modal__btns').before(body,status);
  const active = () => economyPanelActive(menu, host, modal) && menu._identity === identity &&
    identity?.kind === 'wallet' && identity.address === account && identity.config?.network === NEAR_TESTNET.network && menu.chogWallet === wallet;
  if (identity?.kind !== 'wallet' || identity.config?.network !== NEAR_TESTNET.network) {
    status.textContent = 'Connect Intear to use the pool. Boss practice does not require a stake.'; return;
  }
  if (!poolDeployment.accountId) {
    status.textContent = 'The Testnet pool is awaiting verified deployment and reward funding.'; return;
  }
  let busy = false;
  let snapshot;
  const read = () => readPoolSnapshot({deployment:poolDeployment,tokenId:NEAR_TESTNET.token,
    account,view:viewNearContract,readCode:readNearAccountCode});
  const eligibility = async () => {
    if (!identity.nearSession) return 'unavailable';
    try {
      const response = await fetch(nearRelayUrl() + '/near/pool/eligibility', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ nearSession: identity.nearSession }), signal: AbortSignal.timeout(5000),
      });
      return response.ok ? (await response.json()).status : 'unavailable';
    } catch { return 'unavailable'; }
  };
  const guard = () => { if (!active()) throw new Error('Wallet or screen changed. Reopen the pool.'); };
  const gate = (action, state) => {
    const {pool,position} = state;
    if (action === 'register' && (position.registered || !pool.starts_at_ms || Date.now() >= (state.rollingRegistration ? pool.ends_at_ms : pool.starts_at_ms))) throw new Error('Registration is closed or already complete.');
    if (action === 'register' && state.rollingRegistration &&
        ['boss_clear_required','pending'].includes(state.eligibility)) {
      throw new Error(state.eligibility === 'pending' ? 'Boss clear is awaiting confirmation.' : 'Win a server-recorded Boss Battle first.');
    }
    if (action === 'stake' && (!position.registered || !pool.ends_at_ms || Date.now() >= pool.ends_at_ms)) throw new Error('Register during the campaign. Staking closes when the campaign ends.');
    if (action === 'withdraw' && BigInt(position.principal) === 0n) throw new Error('No principal to withdraw.');
    if (action === 'claim' && BigInt(position.accrued_reward) === 0n) throw new Error('No accrued reward to claim.');
  };
  const run = async fn => {
    if (busy || !active()) return;
    busy = true;
    body.querySelectorAll('button').forEach(button=>button.disabled=true);
    try { await fn(); guard(); await render(); }
    catch (error) { if (economyPanelActive(menu, host, modal)) status.textContent=error.message; }
    finally { busy=false; updateButtons(); }
  };
  const sign = async (action, amount) => {
    guard();
    const latest = await read();
    guard();
    if (action === 'register' && latest.rollingRegistration) latest.eligibility = await eligibility();
    guard();
    gate(action,latest);
    // Use the latest finalized principal for withdrawal, never a stale display amount.
    const call = poolCall({action,amount:action==='withdraw'?latest.position.principal:amount,poolId:poolDeployment.accountId,tokenId:NEAR_TESTNET.token});
    await wallet.prepareWallet();
    guard();
    if (action === 'register' && latest.rollingRegistration && latest.eligibility === 'confirmed' &&
        await sponsorPoolRegistration({ relay: nearRelayUrl(), session: identity.nearSession, wallet, account,
          receiverId: call.receiverId, guard, inform: message => { status.textContent = message; } })) {
      return;
    }
    guard();
    status.textContent='Review this action in Intear.';
    await wallet.intear.signAndSendTransaction({signerId:account,receiverId:call.receiverId,
      actions:[wallet.nearActions.functionCall(call.method,call.args,100n*10n**12n,call.deposit)]});
    guard();
    status.textContent='Refreshing pool balance…';
  };
  const button = (action,label,fn) => {
    const el=menu._btn({id:'near-pool-'+action,label,cls:'iw-btn--small',accept:()=>run(fn)});
    el.dataset.poolAction=action;
    return el;
  };
  function updateButtons() {
    for (const el of body.querySelectorAll('button[data-pool-action]')) {
      let disabled=busy || !active() || !snapshot;
      if (!disabled && el.dataset.poolAction!=='refresh') {
        try { gate(el.dataset.poolAction,snapshot); } catch { disabled=true; }
      }
      el.disabled=disabled;
    }
  }
  async function render() {
    const next = await read();
    guard();
    if (next.rollingRegistration && !next.position.registered) next.eligibility = await eligibility();
    guard();
    snapshot=next;
    const {pool,position}=snapshot;
    for(const old of body.querySelectorAll('[data-nav]'))menu._binds?.delete(old);
    body.replaceChildren();
    const row = (label,value) => h('div',{class:'chog-raid-pool-row'},h('span',null,label),h('b',null,value));
    const registration = position.registered?'Registered':({
      confirmed:'Boss clear confirmed · Ready to register', pending:'Boss clear awaiting confirmation',
      boss_clear_required:'Win a server-recorded Boss Battle', unavailable:'Boss clear status unavailable',
    })[next.eligibility] || 'Not registered';
    const input=h('input',{type:'text',inputmode:'decimal',class:'chog-token-input',placeholder:'FOXO amount','aria-label':'FOXO stake amount'});
    const card = (title, ...children) => h('section',{class:'near-market-section fox-feature-card'},
      h('h3',{class:'iw-display'},title),children);
    body.append(h('div',{class:'fox-feature-grid'},
      card('REWARD CAMPAIGN',
        row('AVAILABLE REWARD FUND',formatFoxo(pool.reward_available)+' FOXO'),
        row('RESERVED REWARDS',formatFoxo(pool.reward_reserved)+' FOXO'),
        row('CAMPAIGN ENDS',pool.ends_at_ms?new Date(pool.ends_at_ms).toLocaleString('en-US'):'Not open'),
        button('refresh','REFRESH',async()=>{})),
      card('YOUR POSITION',
        row('YOUR PRINCIPAL',formatFoxo(position.principal)+' FOXO'),
        row('ACCRUED REWARD',formatFoxo(position.accrued_reward)+' FOXO'),
        row('REGISTRATION',registration),
        !position.registered?button('register','REGISTER',()=>sign('register')):null,
        h('div',{class:'near-market-search'},h('label',{class:'fox-order-field'},'Stake amount',input),
          button('stake','STAKE FOXO',()=>sign('stake',foxoAmount(input.value.trim())))),
        h('div',{class:'near-market-actions'},button('withdraw','WITHDRAW PRINCIPAL',()=>sign('withdraw')),
          button('claim','CLAIM REWARD',()=>sign('claim'))))));
    status.textContent='';
  }
  run(async()=>{});
}
