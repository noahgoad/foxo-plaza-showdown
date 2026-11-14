import { h } from './ui-util.js';
import { NEAR_TESTNET, formatFoxo, viewNearContract, readNearAccountCode } from './near-testnet-assets.js';
import { verifyEconomyDeployment } from '../economy/near-deployment.js';
import { catalogueRecipes, economyDeployment } from '../../assets/near-fox/economy-deployment.js';
import { craftMatches, craftTransfer, recipeQuote } from '../economy/near-crafting.js';
import { cosmeticCardInfo, marketCard } from './near-market-card.js';
import { GLYPHS } from './ui-icons.js';

const GAS = 100n * 10n ** 12n;
const materialNames = ['alloy', 'core', 'catalyst'];

export function craftingScreen(menu) {
  const state = menu._identity;
  const accountSnapshot=state?.address,sessionSnapshot=state?.nearSession;
  const wallet = menu.chogWallet;
  const economy = economyDeployment.accountId;
  const ready = state?.kind === 'wallet' && state.config?.network === NEAR_TESTNET.network;
  const initial = !ready ? 'Connect Intear to open your inventory.' :
    !economy ? 'Crafting is awaiting its Testnet deployment.' : 'Loading inventory…';
  let refresh = async () => {};
  const status = h('p', { class: 'iw-modal__text', role: 'status' }, initial);
  const body = h('div', { class: 'chog-workshop-body' });
  const toolbar = h('div', { class: 'near-market-actions' },
    ready && economy ? menu._btn({ id: 'craft-refresh', label: 'REFRESH', icon: GLYPHS.reset,
      cls: 'iw-btn--small', accept: () => refresh() }) : null);
  const screen = h('div', { class: 'iw-screen iw-online chog-online near-crafting-screen near-crafting-panel near-game-panel' },
    h('div', { class: 'iw-scrim-left' }), menu._header('CRAFTING'),
    h('div', { class: 'near-crafting-content' }, toolbar, status, body));
  const active = () => screen.isConnected && menu._identity === state && menu.current === 'crafting' &&
    state.address===accountSnapshot && state.nearSession===sessionSnapshot && state.config?.network===NEAR_TESTNET.network;
  if (!ready || !economy) return { el: screen };

  const view = async (method, args) => (await viewNearContract(economy, method, args)).value;
  let busy = false;
  let selectedRecipe;
  let recipePage = 0;
  let ownedPage = 0;
  let category = 'all';
  const recipePageSize = 6;
  const ownedPageSize = 12;
  const groups = new Map([...economyDeployment.recipes, ...catalogueRecipes].map(entry => {
    const sku = entry.sku;
    return [sku, sku.includes('finish') ? 'Weapon finishes' : sku.includes('outfit') ? 'Outfits' : 'Other'];
  }));
  const pager = (id, page, previous, next) => h('div', { class: 'near-market-actions near-crafting-pager' },
    ...[[previous, 'PREVIOUS'], [next, 'NEXT']].map(([accept, label]) => {
      const button = menu._btn({ id: id + '-' + label.toLowerCase(), label, cls: 'iw-btn--small', accept: accept || (() => {}) });
      button.disabled = !accept;
      return button;
    }), h('span', null, 'Page ' + (page + 1)));
  let refreshVersion = 0;
  const account = state.address;

  async function sign(receiverId, method, args, deposit = 1n) {
    await wallet.prepareWallet();
    if (!active()) throw new Error('Wallet or screen changed.');
    await verifyEconomyDeployment({deployment:economyDeployment,tokenId:NEAR_TESTNET.token,readCode:readNearAccountCode,view:viewNearContract});
    if (!active()) throw new Error('Wallet or screen changed.');
    const response = await wallet.intear.signAndSendTransaction({
      signerId: account, receiverId,
      actions: [wallet.nearActions.functionCall(method, args, GAS, deposit)],
    });
    if (typeof response?.status?.SuccessValue !== 'string') {
      throw new Error('Transaction outcome is unavailable. Refresh before retrying.');
    }
  }

  async function act(fn) {
    if (busy || !active()) return;
    busy = true;
    ++refreshVersion;
    status.textContent = 'Confirm in Intear.';
    try { await fn(); }
    catch (error) { if (active()) status.textContent = error.message || 'Crafting request failed.'; }
    finally { busy = false; }
  }

  async function craft(recipe, expected) {
    const fresh = recipeQuote(await view('get_recipe', {
      recipe_id: expected.recipeId, recipe_version: expected.version,
    }), expected);
    if (fresh.feeAtomic !== recipe.feeAtomic || materialNames.some(name => fresh.inputs[name] !== recipe.inputs[name])) {
      throw new Error('Crafting costs changed. Refresh and review the recipe.');
    }
    const key = 'fox-craft:' + economy + ':' + account + ':' + fresh.recipeId + ':' + fresh.version;
    const operationId = localStorage.getItem(key) || crypto.randomUUID();
    const draft = craftTransfer({ token: NEAR_TESTNET.token, economy, account, recipe: fresh, operationId });
    const check = async () => craftMatches(await view('get_item', { item_id: draft.itemId }), {
      itemId: draft.itemId, account, recipe: fresh,
    });
    if (!await check()) {
      // Retain the same operation across wallet errors and page reloads.
      localStorage.setItem(key, operationId);
      await sign(draft.receiverId, 'ft_transfer_call', draft.args);
      if (!await check()) throw new Error('No crafted item confirmed. Refresh before retrying.');
    }
    localStorage.removeItem(key);
    await refresh('Crafted item confirmed.');
  }

  refresh = async (message = '') => {
    const version = ++refreshVersion;
    try {
      const [config, inventory, items, equipped, profession, recipes] = await Promise.all([
        view('get_config', {}), view('get_inventory', { account_id: account }),
        view('get_owned_items', { account_id: account, offset: ownedPage * ownedPageSize, limit: ownedPageSize + 1 }),
        view('get_equipped', { account_id: account }),
        view('get_profession_progress', { account_id: account }).catch(() => null),
        Promise.all([...economyDeployment.recipes,...catalogueRecipes].map(async entry => {
          const recipe = await view('get_recipe', { recipe_id: entry.recipeId, recipe_version: entry.version });
          if (!recipe) return null;
          const licensed = !entry.licenseId || await view('get_recipe_license',{account_id:account,license_id:entry.licenseId})===true;
          return [entry, recipeQuote(recipe, entry), licensed];
        })),
      ]);
      if (!active() || version !== refreshVersion) return;
      if (config.network !== NEAR_TESTNET.network || config.foxoContractId !== NEAR_TESTNET.token) {
        throw new Error('Crafting contract configuration does not match this game.');
      }
      const migration = await view('get_mt_migration', {});
      let deposit = 0n;
      if (migration?.finalized) {
        const [balance, bounds] = await Promise.all([
          view('storage_balance_of', { account_id: account }), view('storage_balance_bounds', {}),
        ]);
        const minimum = BigInt(bounds.min);
        const available = BigInt(balance?.available ?? '0');
        if (available < minimum) deposit = minimum + (balance ? 0n : minimum) - available;
      }
      if (!active() || version !== refreshVersion) return;
      for (const element of body.querySelectorAll('[data-nav]')) menu._binds.delete(element);

      const stock = h('div', { class: 'near-crafting-stock', 'aria-label': 'Materials in inventory' },
        materialNames.map(name => h('span', null, name, h('b', null, inventory.available[name]))));
      const published = recipes.filter(Boolean);
      const filtered = published.filter(([entry]) => category === 'all' || groups.get(entry.sku) === category);
      recipePage = Math.min(recipePage, Math.max(0, Math.ceil(filtered.length / recipePageSize) - 1));
      const recipesList = filtered.slice(recipePage * recipePageSize, (recipePage + 1) * recipePageSize);
      const filter = h('select', { 'aria-label': 'Filter recipes by category' }, h('option', { value: 'all' }, 'All recipes'),
        [...new Set(published.map(([entry]) => groups.get(entry.sku)))].map(name => h('option', { value: name }, name)));
      filter.value = category;
      filter.addEventListener('change', () => { category = filter.value; recipePage = 0; refresh(); });
      filter.addEventListener('keydown', event => { if (event.key !== 'Escape') event.stopPropagation(); });
      const recipeNavigation = filtered.length > recipePageSize ? pager('recipes', recipePage,
        recipePage > 0 ? () => { recipePage--; refresh(); } : null,
        (recipePage + 1) * recipePageSize < filtered.length ? () => { recipePage++; refresh(); } : null) : null;
      const cards = h('div', { class: 'near-market-grid near-crafting-recipes', 'aria-label': 'Recipes' });
      const detail = h('section', { class: 'near-crafting-detail', 'aria-label': 'Recipe details' });
      const recipeCards = [];
      function showRecipe(row) {
        const [entry, recipe, licensed] = row;
        selectedRecipe = entry.recipeId;
        for (const [id, card] of recipeCards) {
          card.classList.toggle('is-selected', id === selectedRecipe);
          card.setAttribute('aria-pressed', String(id === selectedRecipe));
        }
        for (const element of detail.querySelectorAll('[data-nav]')) menu._binds.delete(element);
        const missing = materialNames.some(name => recipe.inputs[name] > inventory.available[name]);
        const armorer = entry.licenseId?.startsWith('armorer:');
        detail.replaceChildren(h('h3', { class: 'iw-display' }, entry.label),
          h('div', { class: 'near-crafting-cost' },
            materialNames.filter(name => recipe.inputs[name]).map(name =>
              h('span', { class: recipe.inputs[name] > inventory.available[name] ? 'is-short' : null },
                recipe.inputs[name] + ' ' + name)),
            h('span', null, formatFoxo(recipe.feeAtomic) + ' FOXO')));
        if (!licensed) detail.append(
          h('strong', null, (armorer ? 'Armorer' : 'Stylist') + ' license'),
          h('ul', null,
            h('li', null, 'Active Boss or Daily Trial matches · ' + (profession?.matches ?? '—') + '/3'),
            h('li', null, armorer
              ? 'Boss win with damage · ' + (profession ? Number(profession.boss) : '—') + '/1'
              : 'Daily Trial clear · ' + (profession ? Number(profession.trial) : '—') + '/1')));
        const action = menu._btn({ id: 'craft-' + entry.recipeId, label: 'CRAFT ITEM',
          cls: 'iw-btn--small iw-btn--primary', accept: () => act(() => craft(recipe, entry)) });
        action.disabled = !licensed || !config.craftingEnabled || deposit > 0n || missing;
        detail.append(action);
      }
      for (const row of recipesList) {
        const [entry, , licensed] = row;
        const info = { ...cosmeticCardInfo(entry.sku), caption: licensed ? '' : 'Locked' };
        const display = marketCard(info);
        const card = h('button', { class: display.className, type: 'button', 'aria-pressed': 'false' });
        card.append(...display.childNodes);
        menu._bind(card, { id: 'recipe-' + entry.recipeId, accept: () => { if (!busy) showRecipe(row); } });
        recipeCards.push([entry.recipeId, card]);
        cards.append(card);
      }
      const selected = recipesList.find(([entry]) => entry.recipeId === selectedRecipe) || recipesList[0];
      if (selected) showRecipe(selected);
      const storage = deposit > 0n ? h('section', { class: 'near-crafting-storage' },
        h('p', null, 'Item storage · ' + formatFoxo(deposit.toString()) + ' NEAR refundable deposit'),
        menu._btn({ id: 'craft-storage', label: 'RESERVE STORAGE', cls: 'iw-btn--small',
          accept: () => act(async () => {
            await sign(economy, 'storage_deposit', { account_id: account }, deposit);
            await refresh('Storage balance refreshed.');
          }) })) : null;
      const owned = h('div', { class: 'near-market-grid near-crafting-owned' });
      for (const item of items.slice(0, ownedPageSize)) {
        const info = cosmeticCardInfo(item.sku);
        const tile = marketCard(info);
        const equip = menu._btn({ id: 'equip-' + item.itemId,
          label: equipped === item.itemId ? 'EQUIPPED' : 'EQUIP', cls: 'iw-btn--small',
          accept: () => act(async () => {
            await sign(economy, 'equip', { item_id: item.itemId });
            if (await view('get_equipped', { account_id: account }) !== item.itemId) {
              throw new Error('Equip is awaiting confirmation.');
            }
            await refresh('Equipment selection saved.');
          }) });
        equip.setAttribute('aria-label', equip.textContent.trim() + ' ' + info.name);
        equip.disabled = equipped === item.itemId;
        owned.append(h('div', null, tile, equip));
      }
      const ownedNavigation = ownedPage || items.length > ownedPageSize ? pager('owned', ownedPage,
        ownedPage > 0 ? () => { ownedPage--; refresh(); } : null,
        items.length > ownedPageSize ? () => { ownedPage++; refresh(); } : null) : null;
      body.replaceChildren(...[stock, h('label', { class: 'near-crafting-filter' }, 'Recipes', filter),
        selected ? h('div', { class: 'near-crafting-layout' }, h('div', null, cards, recipeNavigation), detail) : null,
        storage, items.length || ownedPage ? h('section', null, h('h3', { class: 'iw-display' }, 'OWNED ITEMS'), owned, ownedNavigation) : null].filter(Boolean));
      status.textContent = message || (!config.craftingEnabled ? 'Crafting is paused.' :
        recipes.some(Boolean) ? '' : 'No recipes are published.');
    } catch (error) {
      if (active() && version === refreshVersion) {
        for (const element of body.querySelectorAll('[data-nav]')) menu._binds.delete(element);
        body.replaceChildren();
        status.textContent = error?.message || 'Crafting is unavailable. Try refreshing.';
      }
    }
  };
  return { el: screen, afterMount: () => refresh() };
}

