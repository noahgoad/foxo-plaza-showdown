import { h } from './ui-util.js';
import { communityEvents } from '../game/foxo-community-calendar.js';
import { nearRelayUrl } from './near-testnet-assets.js';

const dateFormat = new Intl.DateTimeFormat('en', {
  weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  timeZoneName: 'short',
});
const banner = new URL('../../assets/near-fox/pilot-v2/guild-avatar.png', import.meta.url).href;

export function guildLounge({ guild, badge, record, identity, button, enter }) {
  const projects = record?.active && Array.isArray(record.projects) ? record.projects : [];
  const displays = record?.displayProjects;
  const projectList = h('section', { class: 'near-market-section' },
    h('h4', { class: 'iw-display' }, 'PROJECT DISPLAY'),
    displays?.length ? h('div', { class: 'fox-feature-grid' }, ...displays.map(project =>
      h('article', { class: 'near-market-section fox-feature-card' },
        h('img', { class: 'guild-crest', src: banner, alt: 'Beacon guild banner' }),
        h('h5', { class: 'iw-display' }, 'Beacon Banner'),
        h('p', null, project)))) : null,
    record?.active && displays === null ? h('p', { role: 'status' }, 'Banner display is unavailable.') : null,
    projects.length ? h('ul', null, ...projects.map(id => h('li', null, id))) :
      h('p', null, 'No active guild projects to display.'));
  const trophies = displays?.length ? h('section', {class:'near-market-section'},
    h('h4',{class:'iw-display'},'GUILD TROPHIES'),
    ...displays.map(project => h('article',{class:'guild-book-row guild-event-row'},
      h('img',{class:'guild-crest',src:banner,alt:''}),
      h('div',null,h('strong',null,'Beacon Completed'),h('p',null,project))))) : null;
  const eventList = h('div', { class: 'fox-feature-grid' });
  const status = h('p', { role: 'status' });
  const layoutControls = h('div', { class:'guild-directory-toolbar' });
  const account = identity?.address;
  const session = identity?.nearSession;
  const canEdit = record?.active && session &&
    [record.leader,record.treasurer,...(record.governors ?? [])].includes(account);
  const layoutSelect = h('select', { 'aria-label':'Lounge layout' },
    h('option',{value:'gallery'},'Gallery'),
    h('option',{value:'banner'},'Banner focus'),
    h('option',{value:'compact'},'Compact'));
  const rootUrl = nearRelayUrl() + '/near/guild/community/';
  async function api(action, body) {
    const response = await fetch(rootUrl + action, {
      ...(body ? {method:'POST',headers:{'content-type':'application/json'},
        body:JSON.stringify({...body,nearSession:session})} : {}),
      signal:AbortSignal.timeout(10_000),
    });
    const result = await response.json();
    if (!response.ok) throw Error(result.error || 'Community service unavailable.');
    return result;
  }
  function applyLayout(layout) {
    projectList.dataset.loungeLayout = layout;
    layoutSelect.value = layout;
  }
  const showError = error => { status.textContent = error.message || 'Community service unavailable.'; };
  if (record?.active) void api('layout?guildId=' + encodeURIComponent(guild.id))
    .then(result=>applyLayout(result.layout)).catch(showError);
  if (canEdit) {
    const save = button('guild-lounge-save','SAVE LAYOUT',async()=>{
      save.disabled = true;
      try {
        const result = await api('save-layout',{guildId:guild.id,layout:layoutSelect.value});
        applyLayout(result.layout);
        status.textContent = 'Lounge layout saved.';
      } catch(error) { showError(error); }
      finally { save.disabled = false; }
    });
    layoutControls.append(layoutSelect,save);
  }
  const rsvpButtons = new Map();
  function applyEvents(events) {
    for (const event of events) {
      const control = rsvpButtons.get(event.id);
      if (!control) continue;
      control.setAttribute('aria-pressed',String(event.attending));
      control.textContent = event.attending ? 'CANCEL RSVP' : 'RSVP';
    }
  }
  for (const event of communityEvents()) {
    function join() {
      const current = communityEvents().find(item => item.id === event.id);
      if (!current?.open) {
        status.textContent = 'This event is not open.';
        return;
      }
      enter(current.mode);
    }
    const rsvp = session ? h('button',{type:'button',class:'iw-btn iw-btn--small','aria-pressed':'false'},'RSVP') : null;
    if (rsvp) {
      rsvpButtons.set(event.id,rsvp);
      rsvp.addEventListener('click',async()=>{
        rsvp.disabled = true;
        try {
          const attending = rsvp.getAttribute('aria-pressed') !== 'true';
          applyEvents((await api('rsvp',{eventId:event.id,attending})).events);
          status.textContent = attending ? 'RSVP saved.' : 'RSVP cancelled.';
        } catch(error) { showError(error); }
        finally { rsvp.disabled = false; }
      });
    }
    eventList.append(h('article', { class: 'near-market-section fox-feature-card' },
      h('h4', { class: 'iw-display' }, event.title),
      h('time', { datetime: new Date(event.startsAt).toISOString() }, dateFormat.format(event.startsAt)),
      h('p', null, event.open ? 'Open now' : 'Upcoming'),
      rsvp,event.open ? button('guild-event-' + event.mode, 'JOIN LOBBY', join) : null));
  }
  if(session)void api('events',{}).then(result=>applyEvents(result.events)).catch(showError);
  return h('div', { class: 'guild-book-info' },
    h('div', { class: 'guild-book-crest-panel' }, badge,
      h('h3', { class: 'iw-display' }, guild.name)),
    h('div', { class: 'guild-info-main' }, layoutControls, projectList,trophies,
      h('h3', { class: 'iw-display' }, 'PLAZA EVENTS'),
      h('p', null, 'Free entry. These events use standard match rules.'), eventList, status));
}
