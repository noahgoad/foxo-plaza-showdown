import { h } from './ui-util.js';
import { formatFoxo } from './near-testnet-assets.js';
import { marketPicker } from './near-market-card.js';

export function collectionBrowser(menu, detail) {
  const input = (label, props) => h('input', { 'aria-label': label, ...props });
  const select = (label, entries) => h('select', { 'aria-label': label },
    entries.map(([value, text]) => h('option', { value }, text)));
  const search = input('Search items', {type:'search', placeholder:'Search by name, ID or trait'});
  const min = input('Minimum FOXO price', {type:'text', inputmode:'decimal', placeholder:'Min FOXO'});
  const max = input('Maximum FOXO price', {type:'text', inputmode:'decimal', placeholder:'Max FOXO'});
  const status = select('Listing status', [['all','All items'],['listed','Listed'],['unlisted','Not listed']]);
  const sort = select('Sort items', [['low','Price low to high'],['high','Price high to low'],['name','Name']]);
  const category = select('Filter category', [['','All types']]);
  const grid = h('div', {class:'near-market-grid collection-market-grid'});
  const count = h('p', {role:'status'});
  const empty = h('p', null, 'No items match these filters.');
  const prev = menu._btn({id:'collection-previous',label:'PREVIOUS',cls:'iw-btn--small',accept:()=>{page--;render();}});
  const next = menu._btn({id:'collection-next',label:'NEXT',cls:'iw-btn--small',accept:()=>{page++;render();}});
  const pager = h('div',{class:'near-market-actions'},prev,next);
  const filter = (label, control) => h('label',{class:'fox-order-field'},h('span',null,label),control);
  const el = h('div',{class:'collection-market'},
    h('aside',{class:'near-market-section'},h('h3',{class:'iw-display'},'FILTERS'),
      filter('Status',status),filter('Type / Tier',category),filter('Price in FOXO',min),max),
    h('div',{class:'collection-market-main'},h('div',{class:'near-market-search'},search,sort),count,grid,empty,pager,detail));
  let items = [], page = 0, selected, message = '';
  function price(value) {
    if (!/^\d{1,40}(\.\d{1,24})?$/.test(value)) return null;
    const [whole, fraction = ''] = value.split('.');
    return BigInt(whole + fraction.padEnd(24, '0'));
  }
  function render() {
    const q = search.value.trim().toLowerCase(), from = price(min.value), to = price(max.value);
    const results = items.filter(item => {
      const listed = item.price != null;
      return (status.value === 'all' || !item.unknown && listed === (status.value === 'listed')) &&
        (!category.value || category.value === item.category) &&
        (!q || [item.name, item.id, item.keywords].some(value => value?.toLowerCase().includes(q))) &&
        (from === null || listed && BigInt(item.price) >= from) &&
        (to === null || listed && BigInt(item.price) <= to);
    }).sort((a,b) => {
      if (sort.value === 'name') return a.name.localeCompare(b.name, 'en', {numeric:true});
      if (a.price == null || b.price == null) return Number(a.price == null) - Number(b.price == null);
      const delta = BigInt(a.price) - BigInt(b.price);
      return (delta === 0n ? 0 : delta < 0n ? -1 : 1) * (sort.value === 'high' ? -1 : 1);
    });
    page = Math.min(Math.max(page,0),Math.max(0,Math.ceil(results.length/12)-1));
    for (const card of grid.children) menu._binds.delete(card);
    grid.replaceChildren(...results.slice(page*12,page*12+12).map(item => {
      const card = marketPicker(menu,'collection-card-'+item.id,
        {...item,caption:item.price != null ? formatFoxo(item.price)+' FOXO' : item.caption || 'Not listed'},
        () => {
          selected = item.id;
          for (const sibling of grid.children) {
            const pressed = sibling === card;
            sibling.classList.toggle('is-selected',pressed);
            sibling.setAttribute('aria-pressed',String(pressed));
          }
          item.open();
        });
      card.classList.toggle('is-selected',item.id===selected);
      card.setAttribute('aria-pressed',String(item.id===selected));
      return card;
    }));
    count.textContent = results.length + ' items' + (message ? ' · '+message : '');
    empty.hidden = !!results.length || !!message;
    prev.disabled = page === 0;
    next.disabled = (page+1)*12 >= results.length;
    pager.hidden = results.length <= 12;
  }
  for (const control of [search,min,max,status,sort,category]) {
    control.addEventListener('input',()=>{page=0;render();});
    control.addEventListener('keydown',event=>{if(event.key!=='Escape')event.stopPropagation();});
  }
  return { el, update(rows, notice='') {
    items=rows; message=notice;
    const current=category.value;
    category.replaceChildren(h('option',{value:''},'All types'),
      [...new Set(rows.map(row=>row.category).filter(Boolean))].sort().map(name=>h('option',{value:name},name)));
    if ([...category.options].some(option=>option.value===current)) category.value=current;
    render();
  }};
}
