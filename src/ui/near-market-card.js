import { h } from './ui-util.js';
import { FOXO_ICON } from './near-testnet-assets.js';
import catalogue from '../../assets/near-fox/catalogue.v2.json' with {type:'json'};

const itemArt = {
  'weapon-finish-aurora-v2': new URL('../../assets/near-fox/pilot-v2/aurora-card.png', import.meta.url).href,
  'outfit-recolor-tide-v2': new URL('../../assets/near-fox/pilot-v2/tide-card.png', import.meta.url).href,
};

export function cosmeticCardInfo(sku) {
  const item = catalogue.items.find(row => row.sku === sku);
  if (item) return {name:item.label,image:itemArt[sku] || new URL('../../'+item.preview.path,import.meta.url).href};
  if (sku === catalogue.legacy.sku) return {
    name:'Violet Fox Finish',image:new URL('../../assets/chog-hunt-ui/weapons/shooter.png',import.meta.url).href,
    tint:true,
  };
  return {name:sku,image:FOXO_ICON};
}

export function marketCard({name,image,caption,tint}, {choose,selected=false} = {}) {
  return h(choose?'button':'div', {
    class:'iw-wcard near-market-card'+(selected?' is-selected':'')+(tint?' is-violet':''),
    type:choose?'button':null, onclick:choose, 'aria-pressed':choose?String(selected):null,
  },
  h('span',{class:'iw-wcard__ink'}),
  h('span',{class:'iw-wcard__icon'},h('img',{src:image||FOXO_ICON,alt:'',loading:'lazy'})),
  h('span',{class:'iw-wcard__name',title:name},name),
  caption?h('span',{class:'iw-wcard__kind'},caption):null,
  h('span',{class:'iw-wcard__glare'}));
}

export function marketSection(title, ...children) {
  return h('section', { class: 'near-market-section', 'aria-label': title },
    h('h3', { class: 'iw-display' }, title), ...children);
}

export function marketPicker(menu, id, info, choose) {
  const display = marketCard(info);
  const button = h('button', { class: display.className, type: 'button', 'aria-pressed': 'false' }, ...display.childNodes);
  if (menu._bind) menu._bind(button, { id, accept: choose });
  else button.addEventListener('click', choose);
  return button;
}
