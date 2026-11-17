import { economyPanelActive, economyPanel, economyTabs } from './near-economy-page.js';
import { h } from './ui-util.js';
import { cosmeticCardInfo, marketCard, marketSection, marketPicker } from './near-market-card.js';
import { NEAR_TESTNET, formatFoxo, viewNearContract, readNearAccountCode, nearRelayUrl } from './near-testnet-assets.js';
import { verifyEconomyDeployment } from '../economy/near-deployment.js';
import { economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { fundOrderDraft, matchingOrderItems, orderMatches, orderFillQuote, MATERIAL_ORDER_PRODUCTS } from '../economy/near-orders.js';

const DAY = 86_400_000;
const GAS = 100n * 10n ** 12n;

export function openNearOrders(menu, back, host) {
  const state = menu._identity;
  const wallet = menu.chogWallet;
  const economy = economyDeployment.accountId;
  const account = state?.kind === 'wallet' && state.config?.network === NEAR_TESTNET.network ? state.address : null;
  const modal = economyPanel(menu, host, { title: 'BUY ORDERS', text: !account ? 'Connect Intear to use buy orders.' :
    !economy ? 'Buy orders are awaiting their Testnet deployment.' : 'Loading buy orders…',
  buttons: [{ label: 'BACK', accept: back }] });
  if (!economy || !account) return;

  modal.classList.add('near-game-panel','near-market-panel');
  modal.classList.add('chog-workshop-modal');
  const status = modal.querySelector('.iw-modal__text');
  const body = h('div', { class: 'chog-workshop-body' });
  modal.querySelector('.iw-modal__btns').before(body);
  const session=state.nearSession;
  const active = () => economyPanelActive(menu, host, modal) && menu._identity === state && state.address===account &&
    state.nearSession===session && state.config?.network===NEAR_TESTNET.network;
  const view = async (method, args = {}) => (await viewNearContract(economy, method, args)).value;
  const storageKey = 'fox-buy-order:' + economy + ':' + account;
  const recipes = [...economyDeployment.recipes, ...MATERIAL_ORDER_PRODUCTS];
  let busy = false;
  let prepared = null;
  let owned = [];
  let enabled = false;
  let verified = false;
  let feeBps = 0;
  let storageDeposit = 0n;
  let storageReady = false;
  const recipe = h('select', null, ...recipes.map((entry, index) => h('option', { value: index, disabled: entry.version === 0 }, entry.label)));
  const qty = h('input', { type: 'number', min: 1, max: 100, value: 1 });
  const price = h('input', { type: 'text', inputmode: 'decimal', autocomplete: 'off' });
  const orderInput = h('input', { type: 'text', maxlength: 129, autocomplete: 'off', spellcheck: 'false' });
  const quote = h('p', { role: 'status' });
  const detail = h('div');
  const credit = h('p');
  const quartermaster = h('div', { hidden: true });
  const button = (id, label, accept) => menu._btn({ id, label, accept, cls: 'iw-btn--small' });
  const field = (label, input) => h('label', { class: 'fox-order-field' }, h('span', null, label), input);
  for (const input of [recipe, qty, price, orderInput]) {
    input.addEventListener('keydown', event => {
      if (event.key !== 'Escape') event.stopPropagation();
    });
  }

  async function sign(receiverId, method, args, deposit = 1n, storage = 0n) {
    if (!verified) throw new Error('Refresh and verify the order contract first.');
    await wallet.prepareWallet();
    if (!active()) throw new Error('Wallet or screen changed.');
    await verifyEconomyDeployment({deployment:economyDeployment,tokenId:NEAR_TESTNET.token,readCode:readNearAccountCode,view:viewNearContract});
    if (!active()) throw new Error('Wallet or screen changed.');
    const transaction = {
      signerId: account, receiverId,
      actions: [wallet.nearActions.functionCall(method, args, GAS, deposit)],
    };
    const response = storage>0n
      ? (await wallet.intear.signAndSendTransactions({transactions:[{
        signerId:account,receiverId:economy,
        actions:[wallet.nearActions.functionCall('deposit_order_storage',{},GAS,storage)],
      },transaction]})).at(-1)
      : await wallet.intear.signAndSendTransaction(transaction);
    const value = response?.status?.SuccessValue;
    if (typeof value !== 'string') throw new Error('Transaction outcome is unavailable. Refresh before retrying.');
    return value;
  }

  async function act(work) {
    if (busy || !active()) return;
    busy = true;
    try { await work(); }
    catch (error) { if (active()) status.textContent = error.message || 'Order request failed.'; }
    finally { busy = false; }
  }

  function pending() {
    const saved = localStorage.getItem(storageKey);
    if (!saved) return null;
    const draft = JSON.parse(saved);
    if (draft.buyer !== account || draft.args?.receiver_id !== economy || draft.receiverId !== NEAR_TESTNET.token) {
      throw new Error('Saved order does not match this wallet or deployment.');
    }
    const { action, operationId, recipeId, recipeVersion, quantity, unitPrice, expiresAtMs } = JSON.parse(draft.args.msg);
    const entry = recipes.find(row => row.recipeId === recipeId && row.version === recipeVersion);
    if (action !== 'fund_order' || !entry || typeof unitPrice !== 'string' || !/^[0-9]{1,39}$/.test(unitPrice)) {
      throw new Error('Saved order terms are invalid.');
    }
    const digits = unitPrice.padStart(25, '0');
    const rebuilt = fundOrderDraft({ token: NEAR_TESTNET.token, economy, buyer: account,
      operationId, recipe: entry, quantity, price: digits.slice(0, -24) + '.' + digits.slice(-24), expiresAtMs });
    if (rebuilt.id !== draft.id || rebuilt.args.amount !== draft.args.amount) throw new Error('Saved order total changed.');
    return rebuilt;
  }

  async function refresh() {
    verified = false;
    const [config, creditAtomic, items, materialOrdersReady] = await Promise.all([
      view('get_config'), view('get_order_credit', { account_id: account }),
      view('get_owned_items', { account_id: account, offset: 0, limit: 50 }),
      view('can_fund_material_order', { account_id: account }).catch(() => false),
    ]);
    if (!active()) return;
    if (config.network !== NEAR_TESTNET.network || config.foxoContractId !== NEAR_TESTNET.token) {
      throw new Error('Order contract configuration does not match this game.');
    }
    verified = true;
    enabled = config.ordersEnabled;
    feeBps = config.marketFeeBps ?? 0;
    owned = items;
    for (const [index, entry] of recipes.entries()) {
      if (entry.version === 0) {
        recipe.options[index].disabled = materialOrdersReady !== true;
        recipeCards[index].hidden = materialOrdersReady !== true;
      }
    }
    if (recipe.selectedOptions[0]?.disabled) recipe.selectedIndex = 0;
    credit.textContent = 'Withdrawable balance · ' + formatFoxo(creditAtomic) + ' FOXO';
    withdraw.disabled = creditAtomic === '0';
    review.disabled = !enabled || !recipes.length;
    status.textContent = enabled ? '' : 'New orders and deliveries are paused.';
  }

  async function loadOrder(id) {
    for (const node of detail.querySelectorAll('[data-nav]')) menu._binds.delete(node);
    detail.replaceChildren();
    if (!/^[a-z0-9_.-]{2,64}:[a-zA-Z0-9_./:-]{1,64}$/.test(id)) throw new Error('Enter a valid order ID.');
    const order = await view('get_order', { order_id: id });
    if (!active()) return;
    if (!order) throw new Error('Order is unavailable.');
    const label = recipes.find(entry => entry.recipeId === order.recipeId && entry.version === order.recipeVersion)?.label || order.recipeId;
    const expired = order.expiresAtMs <= Date.now();
    detail.replaceChildren(
      h('div',{class:'near-market-feature'},
        marketCard({...cosmeticCardInfo(recipes.find(entry=>entry.recipeId===order.recipeId&&entry.version===order.recipeVersion)?.sku || order.recipeId),
          name:label,caption:formatFoxo(order.unitPrice)+' FOXO each'}),
        h('div',null,h('strong',null,order.closed?'Closed':expired?'Expired':order.remaining+' remaining'),
          h('p',null,'Seller receives '+formatFoxo(orderFillQuote(order.unitPrice,feeBps).netAtomic)+
            ' FOXO · Fee '+formatFoxo(orderFillQuote(order.unitPrice,feeBps).feeAtomic)+' FOXO'))),
    );
    if (!order.closed && order.buyerId === account) {
      detail.append(button('order-close', 'CLOSE ORDER', () => act(async () => {
        await sign(economy, 'close_order', { order_id: id });
        await refresh();
        await loadOrder(id);
      })));
    } else if (enabled && !order.closed && !expired && order.recipeVersion === 0) {
      const inventory = await view('get_inventory', { account_id: account });
      if (!active()) return;
      const max = Math.min(order.remaining, Number(inventory.available?.[order.recipeId] || 0));
      if (max < 1) {
        detail.append(h('p', null, 'No matching materials available.'));
        return;
      }
      const quantity = h('input', { type: 'number', min: 1, max, value: 1 });
      quantity.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
      detail.append(field('Quantity to deliver', quantity), button('material-order-fill', 'DELIVER MATERIALS', () => act(async () => {
        const count = Number(quantity.value);
        if (!Number.isSafeInteger(count) || count < 1 || count > max) throw new Error('Enter a quantity within your available balance.');
        await sign(economy, 'fill_material_order', { order_id: id, quantity: count });
        await refresh();
        await loadOrder(id);
      })));
    } else if (enabled && !order.closed && !expired) {
      const matching = matchingOrderItems(owned, order, account);
      if (!matching.length) detail.append(h('p', null, 'No matching item in the displayed inventory.'));
      for (const [index, item] of matching.entries()) {
        detail.append(button('order-fill-' + index, 'DELIVER ' + item.itemId.split(':').at(-1), () => act(async () => {
          await sign(economy, 'fill_order', { order_id: id, item_id: item.itemId });
          await refresh();
          await loadOrder(id);
        })));
      }
    }
  }

  async function loadQuartermaster() {
    try {
      const response = await fetch(nearRelayUrl() + '/near/orders/quartermaster',
        { signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const data = await response.json();
      if (!active() || !Array.isArray(data.orders)) return;
      const listings = data.orders.filter(row => typeof row?.orderId === 'string' &&
        ['Sponsored', 'Guild'].includes(row.source)).slice(0, 10);
      const activeListings = await Promise.all(listings.map(async row => {
        const order = await view('get_order', { order_id: row.orderId }).catch(() => null);
        return order && !order.closed && order.remaining > 0 && order.expiresAtMs > Date.now() ? {...row, order} : null;
      }));
      if (!active()) return;
      for (const node of quartermaster.querySelectorAll('[data-nav]')) menu._binds.delete(node);
      const cards = activeListings.filter(Boolean).map(({ orderId, source, projectId, order }, index) => {
        const entry = recipes.find(row => row.recipeId === order.recipeId && row.version === order.recipeVersion);
        const open = () => act(async () => {
          orderInput.value = orderId;
          await loadOrder(orderId);
          if (active()) detail.scrollIntoView({block:'nearest'});
        });
        return h('article',{class:'near-market-section fox-sponsored-order'},
          marketPicker(menu, 'quartermaster-' + index,
            { ...cosmeticCardInfo(entry?.sku || order.recipeId), name: entry?.label || order.recipeId,
              caption:formatFoxo(order.unitPrice)+' FOXO each' }, open),
          h('p',null,source+' · '+order.remaining+' wanted'),
          source==='Guild' && typeof projectId==='string' ? h('p',null,'Project '+projectId) : null,
          button('quartermaster-view-'+index,'VIEW BUY ORDER',open));
      });
      quartermaster.replaceChildren(h('h3', { class: 'iw-display' }, 'QUARTERMASTER'),
        cards.length ? h('div', { class: 'fox-feature-grid' }, cards) :
          h('p', null, data.enabled ? 'No funded orders are open.' : 'Sponsored orders are paused.'));
      quartermaster.hidden = false;
    } catch { /* Player orders remain available independently of the relay. */ }
  }

  async function fundPrepared() {
    const draft = prepared;
    if (!draft) return;
    const current = await view('get_order', { order_id: draft.id });
    if (current && !orderMatches(current, draft)) throw new Error('Saved order ID refers to different terms.');
    if (!current) {
      if (!enabled) throw new Error('New orders are paused.');
      const terms=JSON.parse(draft.args.msg);
      if (terms.recipeVersion === 0 && !await view('can_fund_material_order', { account_id: account })) {
        throw new Error('Material orders require an active material inventory.');
      }
      const [charge,balance,registration]=await Promise.all([view('get_order_storage_charge',{quantity:terms.quantity}),view('get_order_storage_credit',{account_id:account}),view('get_order_storage_registration_charge',{account_id:account})]);
      const missing=BigInt(charge)-BigInt(balance);
      const storage=missing>0n?missing+BigInt(registration):0n;
      if(storage>0n&&!host)throw new Error('Prepay the reviewed native storage fee before funding this order.');
      localStorage.setItem(storageKey, JSON.stringify(draft));
      status.textContent = 'Confirm the order in Intear.';
      await sign(draft.receiverId, 'ft_transfer_call', draft.args, 1n, storage);
      const result = await view('get_order', { order_id: draft.id });
      if (!orderMatches(result, draft)) throw new Error('Order not confirmed yet. Review the saved order before retrying.');
    }
    localStorage.removeItem(storageKey);
    prepared = null;
    submit.disabled = true;
    quote.textContent = '';
    if (!active()) return;
    orderInput.value = draft.id;
    await refresh();
    await loadOrder(draft.id);
    status.textContent = 'Order confirmed. Share its ID with a seller.';
  }
  const submit = button('order-fund', 'FUND ORDER', () => act(fundPrepared));
  submit.disabled = true;

  const review = button('order-review', host?'PLACE ORDER':'REVIEW ORDER', () => act(async () => {
    const saved = pending();
    const draft = saved || fundOrderDraft({ token: NEAR_TESTNET.token, economy, buyer: account,
      operationId: crypto.randomUUID(), recipe: recipes[Number(recipe.value)], quantity: Number(qty.value),
      price: price.value.trim(), expiresAtMs: Date.now() + DAY });
    const terms = JSON.parse(draft.args.msg);
    if (saved && terms.expiresAtMs <= Date.now()) {
      const existing = await view('get_order', { order_id: draft.id });
      if (!existing) {
        localStorage.removeItem(storageKey);
        prepared = null;
        submit.disabled = true;
        quote.textContent = 'Saved draft expired. Review a new order.';
        return;
      }
    }
    if (!active()) return;
    prepared = draft;
    if(host){await fundPrepared();return;}
    const [charge,balance,registration]=await Promise.all([
      view('get_order_storage_charge',{quantity:terms.quantity}),view('get_order_storage_credit',{account_id:account}),view('get_order_storage_registration_charge',{account_id:account}),
    ]);
    if(!active())return;
    storageDeposit=BigInt(charge)>BigInt(balance)?BigInt(charge)-BigInt(balance)+BigInt(registration):0n;
    storageReady=storageDeposit===0n;
    quote.textContent = (saved ? 'Saved order · ' : '') + terms.recipeId + ' · ' + terms.quantity +
      ' items · Total ' + formatFoxo(draft.args.amount) + ' FOXO · Expires ' + new Date(terms.expiresAtMs).toLocaleString()+
      ' · Native storage fee '+formatFoxo(String(charge))+' NEAR'+(storageReady?' · Prepaid':' · Deposit '+formatFoxo(storageDeposit.toString())+' NEAR');
    storageButton.hidden=storageReady;storageButton.disabled=storageReady;
    submit.disabled = !storageReady;
  }));
  const storageButton=button('order-storage','PREPAY REVIEWED STORAGE',()=>act(async()=>{
    if(!prepared || storageDeposit<=0n)throw new Error('Review an order first.');
    const quantity=JSON.parse(prepared.args.msg).quantity;
    const [charge,balance,registration]=await Promise.all([view('get_order_storage_charge',{quantity}),view('get_order_storage_credit',{account_id:account}),view('get_order_storage_registration_charge',{account_id:account})]);
    const required=BigInt(charge)>BigInt(balance)?BigInt(charge)-BigInt(balance)+BigInt(registration):0n;
    if(required>0n&&required!==storageDeposit)throw new Error('Storage quote changed. Review this order again.');
    if(required>0n)await sign(economy,'deposit_order_storage',{},required);
    const available=await view('get_order_storage_credit',{account_id:account});
    if(BigInt(available)<BigInt(charge))throw new Error('Storage prepayment is not finalized. Refresh and review before retrying.');
    storageReady=true;storageDeposit=0n;storageButton.hidden=true;submit.disabled=false;
    status.textContent='Storage prepaid. Allocated storage fees are not refunded; unused credit can fund later orders. Review the FOXO transfer separately.';
  }));
  storageButton.hidden=true;
  const withdraw = button('order-withdraw', 'WITHDRAW TO NEAR WALLET', () => act(async () => {
    const value = await sign(economy, 'withdraw_order_credit', {});
    if (atob(value) !== 'true') throw new Error('Withdrawal not confirmed. Check FOXO registration and refresh.');
    await refresh();
    if (active()) status.textContent = 'FOXO withdrawal confirmed.';
  }));
  withdraw.disabled = true;
  review.disabled = true;
  const recipeCards = recipes.map((entry, index) => marketPicker(menu, 'order-recipe-' + index,
    { ...cosmeticCardInfo(entry.sku), name: entry.label }, () => {
      recipe.value = String(index);
      recipe.dispatchEvent(new Event('input', { bubbles: true }));
    }));
  for (const [index, entry] of recipes.entries()) {
    if (entry.version === 0) recipeCards[index].hidden = true;
  }
  const updateSelection = () => recipeCards.forEach((card, index) => {
    const selected = recipe.selectedIndex === index;
    card.classList.toggle('is-selected', selected);
    card.setAttribute('aria-pressed', String(selected));
  });
  recipe.addEventListener('input', updateSelection);
  updateSelection();
  const create = marketSection('CREATE AN ORDER', h('div', { class: 'near-market-grid' }, recipeCards),
    field('Item or material', recipe), field('Quantity', qty), field('FOXO per unit', price), review, quote, host?null:[storageButton,submit]);
  const browse = marketSection('FIND AN ORDER', h('div', { class: 'near-market-search' }, field('Order ID', orderInput),
    button('order-find', 'FIND ORDER', () => act(() => loadOrder(orderInput.value.trim())))), detail);
  const credits = marketSection('MARKET WALLET', credit, h('div', { class: 'near-market-actions' }, withdraw,
    button('orders-refresh', 'REFRESH', () => act(async () => {
      await refresh();
      if (orderInput.value) await loadOrder(orderInput.value.trim());
      void loadQuartermaster();
    }))));
  if (host) body.append(economyTabs(menu, [['BROWSE',h('div',{class:'fox-feature-stack'},quartermaster,browse)],['PLACE ORDER',create],['WALLET',credits]]));
  else body.append(h('div', { class: 'near-market-layout' }, create, browse), quartermaster, credits);
  for (const fieldInput of [recipe, qty, price]) fieldInput.addEventListener('input', () => {
    prepared = null;
    submit.disabled = true;
    quote.textContent = '';
    storageButton.hidden=true;storageReady=false;
  });
  act(refresh);
  void loadQuartermaster();
}
