import { collectionBrowser } from './near-collection-browser.js';
import { economyPanelActive, economyPanel, economyTabs } from './near-economy-page.js';
import { marketDeployment } from '../../assets/near-fox/market-deployment.js';
import { orderFillQuote, orderPriceAtomic } from '../economy/near-orders.js';
import { h } from './ui-util.js';
import { formatFoxo, nearRelayUrl, NEAR_TESTNET, nearFoxProfile, readNearAccountCode, viewNearContract } from './near-testnet-assets.js';
import { marketCard, marketSection, marketPicker } from './near-market-card.js';
import { raidRole, raidSkills } from '../game/boss-raid-rules.js';
import { objectiveFromNft } from '../game/chog-objectives.js';

const GAS = 250n * 10n ** 12n;
const APPROVAL_DEPOSIT = 10n ** 22n;
const validFox = id => /^0(?:0[1-9]|[1-7]\d|8[0-8])$/.test(id);
const date = ns => new Date(Number(BigInt(ns) / 1_000_000n)).toLocaleString();
const foxo = amount => formatFoxo(amount) + ' FOXO';
const near = amount => formatFoxo(String(amount)) + ' NEAR';
const describe = (price, expiry) => {
  const { grossAtomic, feeAtomic, netAtomic } = orderFillQuote(price, 250);
  return 'Gross ' + foxo(grossAtomic) + ' · Fee ' + foxo(feeAtomic) +
    ' · Seller receives ' + foxo(netAtomic) + ' · Expires ' + date(expiry);
};
const sameTerms = (a, b) => a && b && ['token_id', 'seller_id', 'approval_id', 'price_atomic', 'expires_at_ns', 'career_revision']
  .every(key => a[key] === b[key]);

export function openNearMarket(menu, back, host) {
  const identity = menu._identity;
  const account = identity?.kind === 'wallet' && identity.config?.network === NEAR_TESTNET.network ? identity.address : null;
  const session = identity?.nearSession;
  const { accountId: market, codeHash, collectionCodeHash, foxoCodeHash, passportId, passportCodeHash } = marketDeployment;
  const configured = [market, codeHash, collectionCodeHash, foxoCodeHash, passportId, passportCodeHash].every(Boolean);
  const { nft, token } = NEAR_TESTNET;
  const modal = economyPanel(menu, host, {
    title: 'FOX NFT MARKET',
    text: !account ? 'Connect Intear to trade a Fox.' : !configured ? 'The Fox market is awaiting its verified Testnet deployment.' : 'Loading Fox market…',
    buttons: [{ label: 'BACK', accept: back }],
  });
  if (!account || !configured) return;

  modal.classList.add('near-game-panel','near-market-panel');
  const status = modal.querySelector('.iw-modal__text');
  modal.classList.add('chog-workshop-modal');
  status.setAttribute('role', 'status');
  const active = () => economyPanelActive(menu, host, modal) && menu._identity === identity &&
    identity.address === account && identity.nearSession === session && identity.config?.network === NEAR_TESTNET.network;
  const key = 'fox-nft-market:' + market + ':' + account;
  const body = h('div', { class: 'chog-workshop-body' });
  const search = h('input', { id: 'fox-market-token', autocomplete: 'off', maxlength: 3, inputmode: 'numeric' });
  const owned = h('select', { id: 'fox-market-owned' });
  const collection = h('div', {class:'near-market-grid','aria-label':'Owned Fox cards'});
  owned.addEventListener('change',()=>[...collection.children].forEach((card,i)=>{
    const selected=owned.selectedIndex===i;card.classList.toggle('is-selected',selected);card.setAttribute('aria-pressed',String(selected));
  }));
  const price = h('input', { id: 'fox-market-price', autocomplete: 'off', inputmode: 'decimal' });
  const detail = h('div', { id: 'fox-market-detail' });
  const quote = h('p', { id: 'fox-market-quote', role: 'status' });
  const balance = h('p', { id: 'fox-market-credit' });
  const purchaseDetail = h('p', { id: 'fox-market-purchase-status' });
  const field = (label, input) => h('label', { class: 'fox-order-field' }, h('span', null, label), input);
  for (const input of [search, owned, price]) {
    input.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
  }
  let busy = false;
  let action;
  async function act(run) {
    if (busy || !active()) return;
    busy = true;
    try { await run(); }
    catch (error) { if (active()) status.textContent = error.message || 'Fox market request failed.'; }
    finally { busy = false; }
  }
  const button = (id, label, run) => menu._btn({ id, label, accept: () => act(run), cls: 'iw-btn--small' });
  const confirm = button('fox-market-confirm', 'CONFIRM IN WALLET', async () => {
    if (!action) return;
    const run = action;
    clearReview();
    await run();
  });
  function clearReview() {
    action = null;
    confirm.disabled = true;
    quote.textContent = '';
  }
  function review(text, run) {
    if (!active()) return;
    quote.textContent = text;
    action = run;
    confirm.disabled = false;
  }

  async function snapshot() {
    const code = await readNearAccountCode(market);
    if (code.codeHash !== codeHash) throw new Error('Fox market code could not be verified.');
    const blockId = code.blockHash;
    const peers = [[nft, collectionCodeHash], [token, foxoCodeHash], [passportId, passportCodeHash]];
    await Promise.all(peers.map(async ([address, hash]) => {
      const peer = await readNearAccountCode(address, { blockId });
      const approved = peer.codeHash === hash ||
        (address === nft && peer.codeHash === marketDeployment.collectionUpgradeHash);
      if (peer.blockHash !== blockId || !approved) throw new Error('Fox market dependency code could not be verified.');
    }));
    const view = async (address, method, args = {}) => {
      const read = await viewNearContract(address, method, args, { blockId });
      if (read.blockHash !== blockId) throw new Error('Fox market snapshot changed. Refresh.');
      return read.value;
    };
    const mv = (method, args) => view(market, method, args);
    const [config, charge, accountState] = await Promise.all([
      mv('get_config'), mv('get_storage_charge'), mv('get_account_state', { account_id: account }),
    ]);
    if (config.collectionId !== nft || config.foxoContractId !== token || config.passportContractId !== passportId ||
        !/^\d+$/.test(charge) || BigInt(charge) <= 0n) throw new Error('Fox market configuration does not match this game.');
    if (!active()) throw new Error('Wallet or screen changed.');
    return { view, mv, charge, accountState, enabled: config.enabled === true };
  }

  async function sign(address, method, args, deposit, check) {
    await menu.chogWallet.prepareWallet();
    const fresh = await snapshot();
    await check(fresh);
    if (!active()) throw new Error('Wallet or screen changed.');
    const wallet = menu.chogWallet;
    const result = await wallet.intear.signAndSendTransaction({
      signerId: account, receiverId: address,
      actions: [wallet.nearActions.functionCall(method, args, GAS, BigInt(deposit))],
    });
    if (typeof result?.status?.SuccessValue !== 'string') throw new Error('Wallet outcome unavailable. Refresh for finalized status.');
    if (!active()) throw new Error('Wallet or screen changed.');
  }

  function checkCharge(fresh, charge) {
    if (!fresh.enabled || fresh.charge !== charge) throw new Error('Market availability or storage charge changed. Review again.');
  }

  function tokenId(value) {
    const id = value.trim();
    if (!validFox(id)) throw new Error('Enter a Fox ID from 001 to 088.');
    return id;
  }

  async function readTerms(snap, id) {
    const args = { token_id: id };
    const [listing, fox, career] = await Promise.all([
      snap.mv('get_listing', args), snap.view(nft, 'nft_token', args),
      snap.view(passportId, 'get_career', { collection_id: nft, ...args }),
    ]);
    if (!fox || !Number.isSafeInteger(career?.revision) || career.revision < 0) throw new Error('Fox ownership or career is unavailable.');
    return { listing, fox, career, revision: String(career.revision) };
  }

  async function requireIdleFox(id, expectedOwner) {
    const url = nearRelayUrl() + '/near/passport/' + encodeURIComponent(nft) + '/' + id + '?limit=1';
    const response = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!response.ok) throw new Error('Fox match status is unavailable.');
    const { identity, usage } = await response.json();
    if (identity?.collectionId !== nft || identity.tokenId !== id ||
        usage?.ownerId !== expectedOwner || typeof usage.active !== 'boolean') {
      throw new Error('Fox match status or ownership could not be verified.');
    }
    if (usage.active) throw new Error('This Fox has an active match. Wait for the match to finish.');
  }

  function requireBuyable(snap, current, expected = current.listing) {
    const { listing, fox, revision } = current;
    if (!snap.enabled || !sameTerms(listing, expected) || listing.status !== 'open' ||
        listing.seller_id === account || fox.owner_id !== listing.seller_id ||
        fox.approved_account_ids?.[market] !== listing.approval_id || !Number.isSafeInteger(listing.approval_id) ||
        revision !== listing.career_revision || BigInt(listing.expires_at_ns) <= BigInt(Date.now()) * 1_000_000n) {
      throw new Error('Listing is paused, expired, or its terms, ownership or approval changed.');
    }
  }

  function setDetails(...nodes) {
    for (const el of detail.querySelectorAll('[data-nav]')) menu._binds?.delete(el);
    detail.replaceChildren(...nodes);
  }

  async function refresh(message) {
    clearReview();
    const snap = await snapshot();
    const items = await snap.view(nft, 'nft_tokens_for_owner', { account_id: account, from_index: '0', limit: 88 });
    if (!active()) return;
    const selection = owned.value;
    const profiles = items.filter(item => item.owner_id === account && validFox(item.token_id))
      .map(item => nearFoxProfile(item,account));
    owned.replaceChildren(...profiles.map(item => h('option', { value: item.tokenId }, item.name)));
    if ([...owned.options].some(option => option.value === selection)) owned.value = selection;
    for (const card of collection.children) menu._binds.delete(card);
    collection.replaceChildren(...profiles.map(item => marketPicker(menu, 'fox-card-' + item.tokenId, item, () => {
      owned.value = item.tokenId;
      owned.dispatchEvent(new Event('change', { bubbles: true }));
    })));
    owned.dispatchEvent(new Event('change'));
    list.disabled = !snap.enabled || !owned.options.length;
    fund.disabled = !snap.enabled || Boolean(snap.accountState);
    withdraw.disabled = !snap.accountState || snap.accountState.credit === '0' || snap.accountState.withdraw_pending !== '0';
    balance.textContent = 'Withdrawable balance · ' + foxo(snap.accountState?.credit ?? '0') +
      (snap.accountState?.withdraw_pending && snap.accountState.withdraw_pending !== '0' ? ' · Withdrawal pending' : '');
    status.textContent = message || (snap.enabled ? '' : 'New Fox sales are paused.');
    resume.disabled = !localStorage.getItem(key);
  }

  const fund = button('fox-market-fund', 'SET UP MARKET ACCOUNT', async () => {
    const snap = await snapshot();
    if (snap.accountState || !snap.enabled) return refresh();
    review('Set up market credit storage · ' + near(snap.charge) + ' retained storage charge. Network gas is additional.', async () => {
      await sign(market, 'fund_account', {}, snap.charge, fresh => {
        checkCharge(fresh, snap.charge);
        if (fresh.accountState) throw new Error('Market account is already set up.');
      });
      const fresh = await snapshot();
      await refresh(fresh.accountState ? 'Market account setup confirmed.' : 'Account setup is awaiting finalized confirmation.');
    });
  });

  const list = button('fox-market-list', 'REVIEW LISTING', async () => {
    const id = tokenId(owned.value);
    const snap = await snapshot();
    if (!snap.enabled || !snap.accountState) throw new Error('Set up your market account before listing.');
    const current = await readTerms(snap, id);
    if (current.fox.owner_id !== account || current.listing?.status === 'pending') throw new Error('This Fox cannot be listed right now.');
    await requireIdleFox(id, account);
    const args = { account_id: account, token_id: id };
    if (!await snap.mv('get_listing_slot', args)) {
      review('Set up listing storage for Fox #' + id + ' · ' + near(snap.charge) + ' retained storage charge.', async () => {
        await sign(market, 'fund_listing', { token_id: id }, snap.charge, async fresh => {
          checkCharge(fresh, snap.charge);
          if ((await readTerms(fresh, id)).fox.owner_id !== account || await fresh.mv('get_listing_slot', args)) {
            throw new Error('Fox ownership or listing storage changed.');
          }
        });
        const fresh = await snapshot();
        await refresh(await fresh.mv('get_listing_slot', args) ? 'Listing storage confirmed. Review listing terms to continue.' : 'Listing storage is awaiting finalized confirmation.');
      });
      return;
    }
    const amount = orderPriceAtomic(price.value.trim());
    if (amount > ((1n << 128n) - 1n) / 10_000n) throw new Error('Price is outside the supported range.');
    const terms = { price_atomic: amount.toString(), career_revision: current.revision, expires_at_ns: String(BigInt(Date.now() + 86_400_000) * 1_000_000n) };
    const oldApproval = current.listing?.approval_id;
    review('List Fox #' + id + ' · ' + describe(terms.price_atomic, terms.expires_at_ns) +
      ' · Approval deposit up to ' + near(APPROVAL_DEPOSIT) + '. Fox stays in your wallet until sale.', async () => {
      await sign(nft, 'nft_approve', { token_id: id, account_id: market, msg: JSON.stringify(terms) }, APPROVAL_DEPOSIT, async fresh => {
        const check = await readTerms(fresh, id);
        if (!fresh.enabled || !fresh.accountState || check.fox.owner_id !== account || check.revision !== terms.career_revision ||
            check.listing?.status === 'pending' || check.listing?.approval_id !== oldApproval || !await fresh.mv('get_listing_slot', args)) {
          throw new Error('Listing or career changed. Review again.');
        }
        await requireIdleFox(id, account);
      });
      const finalized = await readTerms(await snapshot(), id);
      const row = finalized.listing;
      if (row?.seller_id !== account || row.status !== 'open' || row.approval_id === oldApproval ||
          row.price_atomic !== terms.price_atomic || row.expires_at_ns !== terms.expires_at_ns || row.career_revision !== terms.career_revision ||
          finalized.fox.approved_account_ids?.[market] !== row.approval_id) throw new Error('Listing is awaiting finalized confirmation. Find this Fox before retrying.');
      search.value = id;
      await refresh('Listing confirmed for Fox #' + id + '.');
      await find();
    });
  });

  async function find() {
    clearReview();
    const id = tokenId(search.value);
    const snap = await snapshot();
    const { listing, fox, career, revision } = await readTerms(snap, id);
    if (!active()) return;
    if (!listing) { setDetails(h('p', null, 'No listing found for Fox #' + id + '.')); return; }
    const profile = nearFoxProfile(fox);
    const role = raidRole(objectiveFromNft(profile));
    const skills = Number.isSafeInteger(career.boss_wins) ? raidSkills(career.boss_wins) : null;
    setDetails(h('div',{class:'near-market-feature'},
      marketCard({...profile,caption:foxo(listing.price_atomic)}),
      h('div',null,h('strong',null,listing.status.toUpperCase()),h('p',null,'Seller '+listing.seller_id),
        h('p',null,describe(listing.price_atomic, listing.expires_at_ns)),
        h('h3',null,'BOSS ROLE · '+role.name),h('p',null,role.description),
        h('p',null,skills?'Career skills · '+skills.map(skill=>skill.name).join(' · '):'Career skills unavailable'),
        h('p',null,'The Fox traits and recorded NFT career stay with this token. Match payouts belong to their original earners.'))));
    if (listing.status !== 'open') return;
    if (listing.seller_id === account) {
      detail.append(button('fox-market-cancel', 'REVIEW CANCELLATION', async () => {
        review('Cancel the listing for Fox #' + id + '. Network gas is additional.', async () => {
          await sign(market, 'cancel_listing', { token_id: id }, 0n, async fresh => {
            const row = await fresh.mv('get_listing', { token_id: id });
            if (!sameTerms(row, listing) || row.status !== 'open') throw new Error('Listing changed.');
          });
          await find();
        });
      }));
      return;
    }
    try { requireBuyable(snap, { listing, fox, revision }); }
    catch (error) { detail.append(h('p', null, error.message)); return; }
    detail.append(button('fox-market-buy', 'REVIEW PURCHASE', async () => {
      if (localStorage.getItem(key)) return recover();
      const fresh = await snapshot();
      requireBuyable(fresh, await readTerms(fresh, id), listing);
      await requireIdleFox(id, listing.seller_id);
      if (!fresh.accountState) throw new Error('Set up your market account before buying.');
      const purchaseId = crypto.randomUUID();
      const draft = { purchaseId, listing, charge: fresh.charge };
      review('Prepare purchase for Fox #' + id + ' · ' + describe(listing.price_atomic, listing.expires_at_ns) +
        ' · Purchase record storage ' + near(fresh.charge) + ' retained. FOXO payment requires a separate wallet confirmation.', async () => {
        localStorage.setItem(key, JSON.stringify(draft));
        resume.disabled = false;
        await prepare(draft);
      });
    }));
  }

  async function prepare(draft) {
    const { listing, purchaseId, charge } = draft;
    const { token_id, approval_id, price_atomic, career_revision } = listing;
    await sign(market, 'prepare_purchase', { purchase_id: purchaseId, token_id, approval_id, price_atomic, career_revision }, charge, async fresh => {
      checkCharge(fresh, charge);
      requireBuyable(fresh, await readTerms(fresh, token_id), listing);
      await requireIdleFox(token_id, listing.seller_id);
      if (await fresh.mv('get_purchase', { purchase_id: purchaseId })) throw new Error('Purchase already exists. Check its status.');
    });
    await recover();
  }

  async function recover() {
    clearReview();
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const draft = JSON.parse(raw);
    const { purchaseId, listing, charge } = draft;
    if (!/^[a-f\d-]{36}$/.test(purchaseId) || !listing || !validFox(listing.token_id) || !/^\d+$/.test(charge)) {
      throw new Error('Saved Fox purchase is invalid.');
    }
    const snap = await snapshot();
    const args = { purchase_id: purchaseId };
    const receipt = await snap.mv('get_purchase', args);
    purchaseDetail.textContent = 'Purchase ' + purchaseId + ' · ' + (receipt?.status ?? 'awaiting finalized receipt');
    cancelPurchase.disabled = receipt?.status !== 'prepared';
    if (!receipt) {
      review('Purchase record has no finalized receipt. Review the same storage request before retrying · ' + near(charge), () => prepare(draft));
      return;
    }
    if (receipt.buyer_id !== account || !sameTerms(receipt.listing, listing)) throw new Error('Saved purchase terms do not match the finalized receipt.');
    if (receipt.status === 'pending') {
      status.textContent = 'NFT delivery is pending. Check purchase status before taking any further action.';
      return;
    }
    if (['delivered', 'refundable', 'cancelled'].includes(receipt.status)) {
      localStorage.removeItem(key);
      const message = receipt.status === 'delivered' ? 'Fox purchase confirmed.' : receipt.status === 'cancelled' ?
        'Unfunded purchase cancelled.' : 'Delivery failed. Your FOXO is available as a refund credit.';
      await refresh(message);
      return;
    }
    if (receipt.status !== 'prepared') throw new Error('Unknown purchase status. Check again before sending FOXO.');
    requireBuyable(snap, await readTerms(snap, listing.token_id), listing);
    await requireIdleFox(listing.token_id, listing.seller_id);
    review('Pay for Fox #' + listing.token_id + ' · ' + describe(listing.price_atomic, listing.expires_at_ns) +
      ' · Attach 1 yoctoNEAR. Check purchase status after signing.', async () => {
      await sign(token, 'ft_transfer_call', { receiver_id: market, amount: listing.price_atomic, msg: JSON.stringify(args) }, 1n, async fresh => {
        const latest = await fresh.mv('get_purchase', args);
        if (latest?.status !== 'prepared' || latest.buyer_id !== account || !sameTerms(latest.listing, listing)) throw new Error('Purchase changed. Check its status.');
        requireBuyable(fresh, await readTerms(fresh, listing.token_id), listing);
        await requireIdleFox(listing.token_id, listing.seller_id);
      });
      clearReview();
      status.textContent = 'Payment submitted. Check purchase status for the delivery or refund receipt.';
    });
  }

  const withdraw = button('fox-market-withdraw', 'REVIEW WITHDRAWAL', async () => {
    const snap = await snapshot();
    const amount = snap.accountState?.credit;
    if (!amount || amount === '0' || snap.accountState.withdraw_pending !== '0') return refresh();
    review('Withdraw ' + foxo(amount) + ' to ' + account + ' · Attach 1 yoctoNEAR.', async () => {
      await sign(market, 'withdraw_credit', {}, 1n, async fresh => {
        if (fresh.accountState?.credit !== amount || fresh.accountState.withdraw_pending !== '0') throw new Error('Available credit changed. Review again.');
      });
      await refresh('Withdrawal submitted. Refresh to check available and pending credit.');
    });
  });
  const resume = button('fox-market-resume', 'CHECK PURCHASE STATUS', recover);
  const cancelPurchase = button('fox-market-cancel-purchase', 'REVIEW PURCHASE CANCELLATION', async () => {
    const saved = JSON.parse(localStorage.getItem(key));
    if (!saved) return refresh();
    const args = { purchase_id: saved.purchaseId };
    const check = async snap => {
      const receipt = await snap.mv('get_purchase', args);
      if (receipt?.status !== 'prepared' || receipt.buyer_id !== account || !sameTerms(receipt.listing, saved.listing)) {
        throw new Error('Purchase is no longer an unfunded draft. Check its status.');
      }
    };
    await check(await snapshot());
    review('Cancel unfunded purchase for Fox #' + saved.listing.token_id + ' · Purchase record storage remains charged.', async () => {
      await sign(market, 'cancel_purchase', args, 0n, check);
      await recover();
    });
  });
  list.disabled = fund.disabled = withdraw.disabled = resume.disabled = cancelPurchase.disabled = confirm.disabled = true;
  const actions = (...items) => h('div', { class: 'chog-raid-pool-actions' }, items);
  const browser = host ? collectionBrowser(menu, detail) : null;
  async function loadCollection() {
    browser.update([], 'Loading collection…');
    try {
      const snap = await snapshot();
      const tokens = await snap.view(nft, 'nft_tokens', { from_index:'0', limit:88 });
      const rows = tokens.filter(token => validFox(token.token_id)).map(token => {
        const profile = nearFoxProfile(token);
        return { ...profile, id:profile.tokenId,
          category:profile.attributes.find(trait=>trait.trait_type.toLowerCase()==='tier')?.value,
          keywords:profile.attributes.map(trait=>trait.value).join(' '),
          caption:'Checking listing…',unknown:true,
          open:()=>act(async()=>{ search.value=profile.tokenId; await find(); }) };
      });
      if (!active()) return;
      browser.update(rows,'Checking listings…');
      let partial=false;
      for(let offset=0; offset<rows.length && active(); offset+=6) {
        await Promise.all(rows.slice(offset,offset+6).map(async row=>{
          try {
            const listing=await snap.mv('get_listing',{token_id:row.id});
            if (listing?.status==='open' && BigInt(listing.expires_at_ns)>BigInt(Date.now())*1000000n &&
                listing.seller_id===row.ownerId && /^\d+$/.test(listing.price_atomic)) row.price=listing.price_atomic;
            row.caption=''; row.unknown=false;
          } catch { partial=true; row.caption='Listing unknown'; row.unknown=true; }
        }));
      }
      if(active()) browser.update(rows,partial?'Some listings could not be checked.':'');
    } catch { if(active()) browser.update([],'Collection unavailable. Search by Fox ID.'); }
  }
  const lookup = h('div', { class: 'near-market-search' }, field('Fox ID', search),
    button('fox-market-find', 'FIND LISTING', find));
  const browse = host ? h('div', null, browser.el, h('details', null, h('summary', null, 'Find by Fox ID'), lookup))
    : marketSection('FIND A FOX', lookup, detail);
  const inventory = marketSection('YOUR FOXES', collection, h('p', { class: 'near-market-empty' }, 'No Fox NFTs in this wallet.'),
    field('Owned Fox', owned), field('List price in FOXO', price), actions(list));
  const accountPanel = marketSection('MARKET WALLET', balance,
    actions(fund, withdraw, button('fox-market-refresh', 'REFRESH', () => refresh())));
  const transactions = marketSection('TRANSACTIONS', purchaseDetail, actions(resume, cancelPurchase), quote, actions(confirm));
  if (host) {
    accountPanel.append(actions(resume, cancelPurchase), purchaseDetail);
    body.append(economyTabs(menu, [['BUY', browse], ['SELL', inventory], ['WALLET', accountPanel]]),
      h('div', { class: 'near-market-review' }, quote, actions(confirm)));
  } else body.append(h('div', { class: 'near-market-layout' }, inventory, browse), transactions, accountPanel);
  modal.querySelector('.iw-modal__btns').before(body);
  act(() => refresh());
  if(host) void loadCollection();
}
