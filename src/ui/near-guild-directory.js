import { h } from './ui-util.js';
import { GLYPHS } from './ui-icons.js';

const guilds = [
  { id:'beacon-guard', name:'Beacon Guard', text:'Keep the plaza beacon lit.', level:8, xp:68, trophies:1840, raids:12, leader:'Beacon', officer:'Lamplight' },
  { id:'tide-runners', name:'Tide Runners', text:'Take the fight to Tidewater.', level:7, xp:81, trophies:1620, raids:9, leader:'Riptide', officer:'Foam' },
  { id:'ember-squad', name:'Ember Squad', text:'Rally for Boss Battle.', level:7, xp:22, trophies:1480, raids:8, leader:'Cinder', officer:'Flare' },
  { id:'violet-vanguard', name:'Violet Vanguard', text:'Build gear for the next raid.', level:6, xp:56, trophies:1210, raids:6, leader:'Pulse', officer:'Static' },
  { id:'star-harbor', name:'Star Harbor', text:'Run Daily Trials together.', level:5, xp:40, trophies:970, raids:4, leader:'Polaris', officer:'Orbit' },
];
const avatar = new URL('../../assets/near-fox/foxo-token-icon.png', import.meta.url).href;
const icon = (glyph, cls) => h('span',{class:cls,'aria-hidden':'true',html:GLYPHS[glyph] || '<svg viewBox="0 0 64 64"><path fill="currentColor" d="M5 13h54v39H5zm5 5v5l22 15 22-15v-5L32 33z" fill-rule="evenodd"/></svg>'});
const number = value => value.toLocaleString('en-US');
const progress = guild => h('div',{class:'guild-level'},
  h('b',null,'LV '+guild.level),
  h('progress',{value:guild.xp,max:100,'aria-label':'Guild level progress'}));
const facts = entries => h('dl',null,entries.flatMap(([label,value])=>[h('dt',null,label),h('dd',null,value)]));

const crest = guild => h('img',{class:'guild-crest',alt:'',src:new URL('../../assets/near-fox/guild-crests/'+guild.id+'.png',import.meta.url).href});

export function guildDirectory(menu, { openGuild, createGuild, readGuild }) {
  const name = h('div',{class:'guild-book-name iw-display'},'GUILD PROJECTS');
  const content = h('div',{class:'guild-book-content'});
  const tabs = h('nav',{class:'guild-book-tabs','aria-label':'Guild sections'});
  const menuTabs = ['Info','Members','Event Log','Inbox','Top Guilds'];
  const tabButtons = [];
  let selected, record, pending = false, unavailable = false, version = 0, tab = 'Top Guilds';
  const bind = (id,label,accept) => menu._btn({id,label,accept,cls:'iw-btn--small'});
  const search = h('input',{type:'search',placeholder:'Search guilds','aria-label':'Search guilds'});
  const list = h('div',{class:'guild-directory-list'});
  const demoNotice = h('p',{class:'guild-demo-label'},'Demo standings');
  search.addEventListener('keydown',event=>{if(event.key!=='Escape')event.stopPropagation();});
  search.addEventListener('input',renderList);
  const directory = h('div',null,h('div',{class:'guild-directory-toolbar'},search,bind('guild-directory-create','CREATE GUILD',createGuild)),demoNotice,list);

  async function select(guild) {
    const request = ++version;
    selected=guild;record=null;pending=true;unavailable=false;
    show('Info');
    menu._setFocus?.(tabButtons[0],{snap:true});
    try {
      const result = await readGuild(guild.id);
      if (request===version) record=result;
    }
    catch { if (request===version) unavailable=true; }
    if(request===version){pending=false;if(tab!=='Top Guilds')show(tab);}
  }

  function renderList() {
    const query=search.value.trim().toLowerCase();
    for(const node of list.querySelectorAll('[data-nav]')) menu._binds.delete(node);
    const rows=guilds.filter(guild=>guild.name.toLowerCase().includes(query)||guild.id.includes(query)).map(guild=>{
      const rank=guilds.indexOf(guild)+1;
      const row=h('button',{type:'button',class:'guild-book-row guild-standing-row','aria-label':'View '+guild.name},
        h('b',{class:'guild-rank-badge',data:{rank}},String(rank)),crest(guild),h('strong',null,guild.name),
        progress(guild),h('span',{class:'guild-trophies'},icon('crown'),number(guild.trophies)));
      menu._bind(row,{id:'guild-card-'+guild.id,accept:()=>{void select(guild);}});
      return row;
    });
    list.replaceChildren(...(rows.length ? rows : [h('p',null,'No guilds match this search.')]));
  }

  function show(next) {
    tab=next;
    name.textContent=tab==='Top Guilds'?'GUILD DIRECTORY':selected?.name || 'GUILD PROJECTS';
    tabButtons.forEach((button,i)=>{
      const active=menuTabs[i]===tab;
      button.classList.toggle('is-selected',active);
      button.setAttribute('aria-pressed',String(active));
    });
    for(const node of content.querySelectorAll('[data-nav]')) if(!directory.contains(node)) menu._binds.delete(node);
    if(tab==='Top Guilds') {
      content.replaceChildren(directory);
      renderList();
      return;
    }
    if(!selected) { content.replaceChildren(h('p',null,'Select a guild from Top Guilds.')); return; }
    const demo = !record && !pending && !unavailable;
    const label = demo ? h('p',{class:'guild-demo-label'},'Demo guild') : null;
    if(tab==='Info') {
      const state=pending?'Checking Testnet…':unavailable?'Testnet status unavailable.':record?.active?'Active on Testnet':record?'Guild archived':'';
      const overview = demo ? [
        ['Guild members','3'],['Join type','Open'],['Language','English'],['Required Lv.','None'],
      ] : record ? [['Leader',record.leader],['Treasurer',record.treasurer],['Projects',String(record.projects.length)]] : [];
      content.replaceChildren(h('div',{class:'guild-book-info'},
        h('div',{class:'guild-book-crest-panel'},crest(selected),
          demo?h('div',{class:'guild-trophy-panel'},icon('crown'),h('strong',null,number(selected.trophies)),h('span',null,'Trophies')):null,
          record?bind('guild-open-selected','VIEW PROJECTS',()=>openGuild(selected.id)):null),
        h('div',{class:'guild-info-main'},
          h('header',{class:'guild-info-heading'},
            h('div',{class:'guild-info-title'},h('h3',{class:'iw-display'},selected.name),label),
            demo?progress(selected):null,
            demo?h('p',{class:'guild-info-leader'},h('span',null,'Guild Leader'),h('strong',null,selected.leader)):null,
            h('p',{class:'guild-info-description'},selected.text),
            state?h('p',{role:'status'},state):null),
          h('div',{class:'guild-info-facts'},
            overview.length?facts(overview):null,
            demo?facts([['Rank',String(guilds.indexOf(selected)+1)],['Successful raids',String(selected.raids)]]):null))));
      return;
    }
    if(tab==='Members') {
      const members=demo?[[selected.leader,'Leader'],[selected.officer,'Officer'],['Scout','Member']]:
        record?[...new Set([record.leader,record.treasurer,...record.governors])].map(account=>
          [account,account===record.leader?'Leader':account===record.treasurer?'Treasurer':'Governor']):[];
      content.replaceChildren(...[label, record?h('p',null,'Guild leadership and governors'):null,
        ...(members.length?members.map(([player,role],i)=>h('div',{class:'guild-book-row guild-member-row'},
          h('b',{class:'guild-rank-badge'},String(i+1)),h('img',{src:avatar,alt:''}),h('strong',null,player),
          h('span',{class:role==='Leader'?'guild-member-leader':null},role))):
          [h('p',null,pending?'Checking Testnet…':'No member records to display.')])].filter(Boolean));
      return;
    }
    if(tab==='Event Log') {
      const events=demo?[['Boss Battle','Raid clear recorded','Today','crown'],
        [selected.name,'Guild reached level '+selected.level,'Today','star'],
        ['Guild Beacon','Project opened','Yesterday','flag']]:
        (record?.projects.map(id=>[id,'Guild project','','flag']) || []);
      content.replaceChildren(...[label,...(events.length?events.map(([title,text,time,glyph])=>
        h('article',{class:'guild-book-row guild-event-row'},icon(glyph,'guild-event-icon'),
          h('div',null,h('strong',null,title),h('p',null,text)),time?h('time',null,time):null)):
        [h('p',null,'No recorded projects.')])].filter(Boolean));
      return;
    }
    content.replaceChildren(h('div',{class:'guild-book-empty'},icon('mail','guild-inbox-icon'),label,
      h('h3',{class:'iw-display'},'Join requests'),
      h('p',null,demo?'No pending requests.':'Join requests are unavailable for this guild.')));

  }

  for(const label of menuTabs) {
    const button=bind('guild-tab-'+label.toLowerCase().replaceAll(' ','-'),label,()=>show(label));
    tabButtons.push(button);
    tabs.append(button);
  }
  show(tab);
  return h('section',{class:'guild-book'},name,tabs,content);
}
