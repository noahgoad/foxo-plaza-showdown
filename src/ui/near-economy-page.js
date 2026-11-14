import { h } from './ui-util.js';

export function economyPage(menu, title, render) {
  const content = h('div', { class: 'near-crafting-content near-economy-content' });
  const el = h('div', { class: 'iw-screen iw-online chog-online near-game-panel' },
    h('div', { class: 'iw-scrim-left' }), menu._header(title), content);
  return { el, afterMount: () => {
    render(menu, () => menu._back(), content);
    menu._setFocus(content.querySelector('[data-nav]:not(:disabled)'), { snap: true });
  } };
}

export function economyPanel(menu, host, options) {
  if (!host) {
    menu._openModal(options);
    return menu._modal;
  }
  host.replaceChildren(h('p', { class: 'iw-modal__text', role: 'status' }, options.text),
    h('div', { class: 'iw-modal__btns' }, options.buttons
      .filter(button => button.label !== 'BACK')
      .map(button => menu._btn({ ...button, id: 'economy-' + button.label.toLowerCase().replaceAll(' ', '-'),
        cls: 'iw-btn--small' }))));
  return host;
}

export function economyTabs(menu, tabs) {
  const buttons = [];
  const show = index => tabs.forEach(([, panel], i) => {
    panel.hidden = i !== index;
    buttons[i].setAttribute('aria-pressed', String(i === index));
    buttons[i].classList.toggle('is-selected', i === index);
  });
  tabs.forEach(([label], index) => {
    buttons.push(menu._btn({id:'market-tab-' + index, label, cls:'iw-btn--small', accept: () => show(index)}));
  });
  show(0);
  return h('div', { class: 'near-economy-tabs' }, h('nav', { 'aria-label': 'Market sections' }, buttons),
    tabs.map(([, panel]) => panel));
}

export function economyPanelActive(menu, host, panel) {
  return panel.isConnected && (host ? menu._scr?.el.contains(host) : menu._modal === panel);
}
