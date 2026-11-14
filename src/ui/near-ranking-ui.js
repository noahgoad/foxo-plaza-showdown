import { economyPanelActive, economyPanel } from './near-economy-page.js';
import { h } from './ui-util.js';
import { GLYPHS } from './ui-icons.js';
import { formatFoxo, nearRelayUrl } from './near-testnet-assets.js';

const modes = { boss: 'Boss Battle', hunt: 'Trait Hunt', control: 'Trait Control', trials: 'Daily Trials' };
const ordinal = { 1: '1st', 2: '2nd', 3: '3rd' };
const foxIcon = new URL('../../assets/near-fox/foxo-token-icon.png', import.meta.url).href;
const score = entry => (Number(entry.scoreAtomic) / 1_000_000).toFixed(6);
const reward = entry => entry.amountAtomic === undefined ? '—' : formatFoxo(entry.amountAtomic) + ' FOXO';

export function openNearRanking(menu, back, host) {
  const identity = menu._identity;
  let board;
  let mode = 'boss';
  let request;
  const modal = economyPanel(menu, host, { title: 'RANKING', text: '', buttons: [
    ...(identity?.kind === 'wallet' ? [{label: 'CLAIM REWARDS', accept: () => {
      if (!host) menu._closeModal(true);
      menu.chogWallet?.openClaims();
    }}] : []),
    {label: 'BACK', accept: back},
  ]});
  modal.classList.add('near-game-panel', 'near-ranking');
  const status = modal.querySelector('.iw-modal__text');
  status.setAttribute('role', 'status');
  const tabs = h('nav', {class: 'guild-book-tabs', 'aria-label': 'Ranked mode'});
  const tabButtons = Object.entries(modes).map(([id, label]) => {
    const button = menu._btn({id: 'ranking-' + id, label, cls: 'iw-btn--small', accept: () => {
      if (id === mode) return;
      mode = id;
      void refresh();
    }});
    tabs.append(button);
    return [id, button];
  });
  const previous = menu._btn({id: 'ranking-prev', label: 'PREVIOUS DAY', cls: 'iw-btn--small',
    accept: () => { if (board?.dayIndex > 0) void refresh(board.dayIndex - 1); }});
  const nextDay = menu._btn({id: 'ranking-next', label: 'NEXT DAY', cls: 'iw-btn--small',
    accept: () => { if (board?.dayIndex < board?.lastDay) void refresh(board.dayIndex + 1); }});
  const today = menu._btn({id: 'ranking-today', label: 'TODAY', cls: 'iw-btn--small', accept: () => refresh()});
  modal.querySelector('.iw-modal__btns').prepend(today, previous, nextDay);
  const body = h('div', {class: 'near-ranking-body'});
  status.before(tabs);
  modal.querySelector('.iw-modal__btns').after(body);
  const active = () => economyPanelActive(menu, host, modal) && menu._identity === identity;

  function render(entries, emptyMessage) {
    const podium = h('div', {class: 'near-ranking-podium', 'aria-label': 'Top three'},
      [2, 1, 3].map(rank => {
        const entry = entries.find(item => item.rank === rank);
        const avatar = entry?.accountId === identity?.address ? identity?.nft?.image || foxIcon : foxIcon;
        return h('article', {class: 'near-ranking-place', data: {rank}},
          h('span', {class: 'near-ranking-crown', 'aria-hidden': 'true', html: GLYPHS.crown}),
          h('div', {class: 'near-ranking-player'},
            entry ? h('img', {src: avatar, alt: '', referrerpolicy: 'no-referrer',
              onerror: event => { if (event.target.src !== foxIcon) event.target.src = foxIcon; }}) : null,
            h('strong', null, entry?.accountId || 'Open spot'),
            h('span', null, entry ? score(entry) + ' pts' : '—')),
          h('div', {class: 'near-ranking-step iw-display'}, ordinal[rank]));
      }));
    const rows = entries.map(entry => h('tr', {class: entry.accountId === identity?.address ? 'is-you' : null},
      h('td', null, '#' + entry.rank),
      h('th', {scope: 'row'}, entry.accountId, entry.accountId === identity?.address ? h('small', null, ' YOU') : null,
        entry.breakdown ? h('details',{class:'ranking-breakdown'},
          h('summary',null,'Score breakdown'),
          h('p',null,entry.breakdown.rubricVersion+' · Best '+entry.breakdown.bestOf+' matches'),
          entry.breakdown.matches.map(match=>h('div',null,
            h('strong',null,score(match)+' pts'),
            h('p',null,'Match '+match.matchId),
            h('dl',null,Object.entries(match.signals).map(([key,value])=>[
              h('dt',null,key.replace(/([A-Z])/g,' $1')),h('dd',null,String(value))
            ]))))) : null),
      h('td', null, score(entry)),
      h('td', null, reward(entry))));
    body.replaceChildren(podium,
      h('section', {class: 'near-ranking-standings'},
        h('h2', {class: 'iw-display'}, 'TOP 20'),
        h('div', {class: 'rank-table-wrap'}, h('table', {class: 'rank-table'},
          h('thead', null, h('tr', null, ['Rank', 'Player', 'Score', 'Reward'].map(label => h('th', {scope: 'col'}, label)))),
          h('tbody', null, rows.length ? rows : h('tr', null, h('td', {colspan: 4}, emptyMessage)))))),
      board?.status === 'review' && board.reviewAfterMs
        ? h('p', null, 'Review ends ' + new Date(board.reviewAfterMs).toUTCString() + '.') : null,
      board?.unscored ? h('p', null, board.unscored + ' result(s) awaiting complete ranking data.') : null);
  }

  async function refresh(day) {
    if (!active()) return;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    board = undefined;
    previous.disabled = nextDay.disabled = true;
    for (const [id, button] of tabButtons) {
      button.classList.toggle('is-selected', id === mode);
      button.setAttribute('aria-pressed', String(id === mode));
    }
    status.textContent = 'Loading standings…';
    render([], 'Loading scores…');
    try {
      const params = new URLSearchParams({mode});
      if (day !== undefined) params.set('day', day);
      const response = await fetch(nearRelayUrl() + '/near/ranking/board?' + params,
        {signal: AbortSignal.any([controller.signal, AbortSignal.timeout(12_000)])});
      if (!response.ok) throw Error('Ranking is unavailable. Use TODAY to retry.');
      const result = await response.json();
      if (request !== controller || !active()) return;
      board = result;
      previous.disabled = !(board.dayIndex > 0);
      nextDay.disabled = !(board.dayIndex < board.lastDay);
      status.textContent = board.date + ' UTC · ' + (
        board.status === 'published' ? 'Finalized on Testnet' :
        board.status === 'review' ? 'Pending publication' :
        board.campaignActive ? 'Live standings · Rewards pending publication' : 'Standings preview');
      render(board.entries.slice(0, 20), 'No eligible scores for this day.');
    } catch (error) {
      if (request !== controller || !active()) return;
      status.textContent = error.message;
      render([], 'Scores unavailable.');
    }
  }
  void refresh();
}
