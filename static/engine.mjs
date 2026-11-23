export const SORTS = [
  ['firstLimit', '首次涨停'], ['lastLimit', '最后涨停'], ['amount', '成交额'],
  ['floatCap', '自由流通市值'], ['floatRatio', '自由流通股占比'], ['price', '收盘价'], ['sealRatio', '封成比'], ['name', '名称'],
];
export const THEME_SORTS = [['manual','手动顺序'],['total','全天总数'],['early','早盘数量'],['late','午盘数量'],['balance','午－早']];
export const PALETTE = ['#5168c9', '#b66586', '#43948d', '#b18039', '#8b6ec0', '#467da6', '#af6854', '#6d8b43'];
export const normalizeName = name => String(name).normalize('NFKC').replace(/\s+/g,'');
export const normalizeTheme = theme => String(theme || '').normalize('NFKC').trim().replace(/\s+/g,' ');
export const themeKey = theme => normalizeTheme(theme).replace(/\s+/g,'').toLowerCase();
export function normalizeProvince(value) {
  const province=String(value || '').normalize('NFKC').replace(/\s+/g,'');
  if(!province || /^(?:--|—|未知|暂无数据|省份待补|省份待补充|待补)$/.test(province))return '';
  return province.replace(/(?:壮族自治区|回族自治区|维吾尔自治区|特别行政区|自治区|省|市)$/,'');
}

// These reserved entries live inside existing persisted preference containers,
// so an already-running local server can save the new feature without a restart.
export function buildThemeCatalog(state, limit=200) {
  const entries=new Map(),prefs=state.preferences;
  const add=(raw,seenAt)=>{
    const name=normalizeTheme(raw);if(!name)return;
    const key=themeKey(name),old=entries.get(key);
    if(!old || seenAt>old.seenAt)entries.set(key,{name,seenAt});
  };
  for(const entry of prefs.themeOrders?.$catalog || [])if(entry?.name && typeof entry.seenAt==='string')add(entry.name,entry.seenAt);
  for(const day of state.days){
    const seenAt=`${day.date}T00:00:00.000Z`;
    for(const theme of new Set([...(day.themeOrder || []),...day.stocks.flatMap(s=>s.themes)]))add(theme,seenAt);
    for(const theme of Object.values(prefs.merges?.[day.date] || {}))add(theme,seenAt);
    for(const themes of Object.values(prefs.merges?.$stockThemes?.[day.date] || {}))for(const theme of themes)add(theme,seenAt);
  }
  return [...entries.values()].sort((a,b)=>b.seenAt.localeCompare(a.seenAt) || a.name.localeCompare(b.name,'zh-CN')).slice(0,limit);
}
export function assignStockTheme(state,date,name,rawTheme) {
  const theme=normalizeTheme(rawTheme);
  if(!theme || theme.length>40)throw new Error('题材名称需要为 1–40 个字。');
  const model=derive(state),stock=model.days.find(d=>d.date===date)?.stocks.find(s=>normalizeName(s.name)===normalizeName(name));
  if(!stock)throw new Error('未找到这只股票，请重新打开详情。');
  const existing=buildThemeCatalog(state,Infinity).find(t=>themeKey(t.name)===themeKey(theme));
  const canonical=existing?.name || theme,resolved=resolveTheme(canonical,date,state.preferences);
  if(stock.themes.some(t=>themeKey(t)===themeKey(resolved)))return state.preferences;
  const next=structuredClone(state.preferences);next.merges ||= {};next.merges.$stockThemes ||= {};next.merges.$stockThemes[date] ||= {};
  const episode=model.episodes.find(ep=>ep.id===stock.episode);
  // Adding a previously removed theme also clears its exclusion across this
  // episode, including original classifications behind a merged label.
  const restored=[canonical,resolved,...[...episode.sourceThemes].filter(t=>themeKey(resolveTheme(t,date,next))===themeKey(resolved))];
  for(const entry of episode.identities){
    const removals=next.merges.$stockThemeRemovals?.[entry.date]?.[entry.name];
    if(removals)next.merges.$stockThemeRemovals[entry.date][entry.name]=removals.filter(t=>!restored.some(source=>themeRemoved(source,entry.date,[t],next)));
  }
  const key=normalizeName(stock.name),themes=next.merges.$stockThemes[date][key] ||= [];
  if(!themes.some(t=>themeKey(t)===themeKey(canonical)))themes.push(canonical);return next;
}

function themeRemoved(source,date,removals,prefs) {
  const original=themeKey(source),resolved=themeKey(resolveTheme(source,date,prefs));
  return removals.some(t=>themeKey(t)===original || themeKey(t)===resolved);
}
export function removeStockTheme(state,date,name,theme) {
  const model=derive(state),stock=model.days.find(d=>d.date===date)?.stocks.find(s=>normalizeName(s.name)===normalizeName(name));
  if(!stock)throw new Error('未找到这只股票，请重新打开详情。');
  const target=stock.themes.find(t=>themeKey(t)===themeKey(theme));
  if(!target)return state.preferences;
  const episode=model.episodes.find(ep=>ep.id===stock.episode),next=structuredClone(state.preferences);
  next.merges ||= {};next.merges.$stockThemeRemovals ||= {};next.merges.$stockThemeRemovals[date] ||= {};
  const key=normalizeName(stock.name),removed=next.merges.$stockThemeRemovals[date][key] ||= [];
  const sources=[target,...[...episode.themes].filter(t=>themeKey(resolveTheme(t,date,next))===themeKey(target))];
  for(const source of sources)if(!removed.some(t=>themeKey(t)===themeKey(source)))removed.push(source);
  return next;
}

export function resolveTheme(theme, date, prefs) {
  const map = prefs.merges?.[date] || {}; const seen = new Set();
  while (map[theme] && !seen.has(theme)) { seen.add(theme); theme = map[theme]; }
  return theme;
}
export function colorFor(theme, prefs) {
  let hash = 0;
  for (const c of theme) hash = (hash * 31 + c.charCodeAt(0)) >>> 0;
  const color = prefs.colors?.[theme]?.color;
  return /^#[0-9a-f]{6}$/i.test(color || '') ? color : PALETTE[hash % PALETTE.length];
}
function nextDay(s) { return new Date(Date.parse(s + 'T12:00:00Z') + 86400000).toISOString().slice(0, 10); }
export function nextTradingDate(date, calendar) {
  let day = date;
  for (let i = 0; i < 30; i++) {
    day = nextDay(day); const year = calendar?.years?.[day.slice(0, 4)];
    if (!year) return null;
    const weekday = new Date(day + 'T12:00:00Z').getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !year.closed_weekdays.includes(day)) return day;
  }
  return null;
}
function tradingDistance(a, b, calendar) {
  let d = a; let n = 0;
  while (d && d < b && n < 300) { d = nextTradingDate(d, calendar); n++; }
  return d === b ? n : null;
}
function firstBoardDate(date, board, calendar) {
  let day=date, remaining=board-1;
  // An import may begin halfway through a streak. Its board number places the
  // first board on the corresponding previous trading day, not the import day.
  for(let i=0;remaining>0 && i<1000;i++){
    day=new Date(Date.parse(day+'T12:00:00Z')-86400000).toISOString().slice(0,10);
    const year=calendar?.years?.[day.slice(0,4)];if(!year)return null;
    const weekday=new Date(day+'T12:00:00Z').getUTCDay();
    if(weekday!==0 && weekday!==6 && !year.closed_weekdays.includes(day))remaining--;
  }
  return remaining===0?day:null;
}

function cohortHistory(episodes, themeFor=t=>t, asOf=null, groupsFor=ep=>ep.themes) {
  const cohorts=new Map();
  // Include one-board and unfinished members: a lower stock dropping out must
  // not create a record while another member of its first-board batch survives.
  for(const ep of episodes)for(const theme of new Set([...groupsFor(ep)].map(themeFor))){
    const key=JSON.stringify([theme,ep.firstDate || ep.id]);
    if(!cohorts.has(key))cohorts.set(key,{theme,members:new Map()});
    cohorts.get(key).members.set(ep.id,ep);
  }
  const entries=[];
  for(const [key,cohort] of cohorts){
    const members=[...cohort.members.values()];
    if(members.some(ep=>ep.status!=='ended' || !ep.endDate))continue;
    const board=Math.max(...members.map(ep=>ep.max));if(board<2)continue;
    const leaders=members.filter(ep=>ep.max===board).sort((a,b)=>a.name.localeCompare(b.name,'zh-CN'));
    const date=members.map(ep=>ep.endDate).sort().at(-1);
    const startDate=leaders[0].firstDate;
    const lastDate=leaders.map(ep=>ep.last).sort().at(-1);
    const name=leaders.map(ep=>ep.name).join('、');
    entries.push({id:`cohort:${key}`,theme:cohort.theme,date,startDate,lastDate,name,names:leaders.map(ep=>ep.name),board,
      members:members.map(ep=>ep.id),text:`${name} ${board}板`,manual:false,order:`${date}T00:00:00-${key}`});
  }
  // An earlier batch can still be running when a later, shorter batch ends.
  // Only use streak dates already visible at the review date as evidence of
  // containment. Never hide a past record merely because of a later extension.
  const intervals=episodes.filter(ep=>ep.firstDate).map(ep=>({
    start:ep.firstDate,last:asOf ? ep.dates.filter(d=>d<=asOf).at(-1) : ep.last,
    themes:new Set([...groupsFor(ep)].map(themeFor)),
  }));
  return entries.filter(entry=>!entry.startDate || !intervals.some(outer=>
    outer.themes.has(entry.theme) && outer.start<entry.startDate && outer.last>=entry.lastDate));
}

export function derive(state) {
  const days = [...state.days].sort((a, b) => a.date.localeCompare(b.date));
  const prefs = state.preferences; const episodes = []; const active = new Map(); const memberships = new Map();
  const codes = new Map();
  for (const d of days) for (const m of Object.values(d.metrics || {})) {
    if (m.code && m.name) { const n = normalizeName(m.name); if (!codes.has(n)) codes.set(n, new Set()); codes.get(n).add(m.code); }
  }
  const keyFor = s => { const found = codes.get(normalizeName(s.name)); return found?.size === 1 ? [...found][0] : normalizeName(s.name); };
  for (const day of days) {
    const present = new Set(day.stocks.map(keyFor));
    for (const [key, ep] of active) {
      if (present.has(key)) continue;
      if (day.complete && nextTradingDate(ep.last, state.calendar) === day.date) {
        ep.endDate = day.date; ep.status = 'ended'; active.delete(key);
      } else ep.status = 'waiting';
    }
    for (const stock of day.stocks) {
      const key = keyFor(stock); let ep = active.get(key);
      const distance = ep ? tradingDistance(ep.last, day.date, state.calendar) : null;
      const continuous = ep && distance !== null && stock.board - ep.lastBoard === distance;
      if (!continuous) {
        if (ep) {
          if (day.complete && distance === 1) { ep.endDate = day.date; ep.status = 'ended'; }
          else ep.status = 'waiting';
        }
        ep = { id: `${key}@${day.date}`, key, name: stock.name, start: day.date, last: day.date, firstDate: firstBoardDate(day.date,stock.board,state.calendar),
          lastBoard: stock.board, max: stock.board, themes: new Set(), provinces: new Set(), status: 'active', endDate: null, dates: [], identities: [] };
        episodes.push(ep); active.set(key, ep);
      }
      ep.last = day.date; ep.lastBoard = stock.board; ep.max = Math.max(ep.max, stock.board); ep.status = 'active'; ep.dates.push(day.date);
      ep.identities.push({date:day.date,name:normalizeName(stock.name)});
      const province=normalizeProvince(day.metrics?.[normalizeName(stock.name)]?.province);
      if(province)ep.provinces.add(province);
      // Source classification changes accumulate across an episode. Manual daily merges
      // are a presentation override and must not leak into any other date.
      for (const theme of stock.themes) ep.themes.add(theme);
      for (const theme of prefs.merges?.$stockThemes?.[day.date]?.[normalizeName(stock.name)] || [])ep.themes.add(theme);
      memberships.set(`${day.date}:${stock.name}`, ep);
    }
  }
  for(const ep of episodes){
    ep.sourceThemes=new Set(ep.themes);
    ep.themes=new Set([...ep.themes].filter(theme=>!ep.identities.some(entry=>
      themeRemoved(theme,entry.date,prefs.merges?.$stockThemeRemovals?.[entry.date]?.[entry.name] || [],prefs))));
  }
  const views = days.map(day => {
    const stocks = day.stocks.map(s => {
      const ep = memberships.get(`${day.date}:${s.name}`);
      return { ...s, episode: ep.id, episodeMax: ep.max,
        province: normalizeProvince(day.metrics?.[normalizeName(s.name)]?.province) || (ep.provinces.size===1 ? [...ep.provinces][0] : ''),
        themes: [...new Set([...ep.themes].map(t => resolveTheme(t, day.date, prefs)))],
        mergedThemes: [...ep.themes].map(source=>({source,target:resolveTheme(source,day.date,prefs)})).filter(t=>t.source!==t.target),
        metrics: day.metrics?.[normalizeName(s.name)] || {} };
    });
    const boards = [...new Set(stocks.map(s => s.board))].sort((a, b) => b - a);
    const themeOrder = [...new Set([...(prefs.themeOrders?.[day.date] || []), ...day.themeOrder, ...stocks.flatMap(s => s.themes)]
      .map(t => resolveTheme(t, day.date, prefs)))].filter(t => stocks.some(s => s.themes.includes(t)));
    for (const s of stocks) s.themes.sort((a,b) => themeOrder.indexOf(a) - themeOrder.indexOf(b));
    const groups = boards.map(board => ({ board, count: stocks.filter(s => s.board === board).length,
      stocks: sortStocks(stocks.filter(s => s.board === board), prefs.sorts?.global),
      unclassified: sortStocks(stocks.filter(s=>s.board===board && !s.themes.length),prefs.sorts?.global),
      themes: themeOrder.map(theme => {
        const members = sortStocks(stocks.filter(s => s.board === board && s.themes.includes(theme)), prefs.sorts?.global);
        return {theme, stocks: members, times: countFirstLimitTimes(members)};
      }).filter(g => g.stocks.length) }));
    const firstBoard=groups.find(group=>group.board===1);
    if(firstBoard)firstBoard.themes=sortFirstBoardThemes(firstBoard.themes,prefs.sorts?.firstBoard?.[day.date]);
    return { ...day, stocks, groups, themeOrder: themeOrder.filter(t => stocks.some(s => s.themes.includes(t))) };
  });
  const history = cohortHistory(episodes);
  for (const entry of prefs.manual || []) if(entry.scope!=='province')history.push({ ...entry, manual: true, order: `${entry.date}T${entry.createdAt || '23:59:59'}-${entry.id}` });
  return { days: views, episodes, history, themes: [...new Set(views.flatMap(d => d.themeOrder))] };
}

export function historyFor(model, theme, date, prefs) {
  const seen = new Set();
  // Resolve daily theme merges before grouping, so merged batches also wait
  // for every member and produce just one highest record for that first date.
  const entries=[...cohortHistory(model.episodes,t=>resolveTheme(t,date,prefs),date),...model.history.filter(e=>e.manual)];
  return entries.filter(e => e.date <= date && resolveTheme(e.theme, date, prefs) === theme)
    .sort((a, b) => a.order.localeCompare(b.order, 'zh-CN')).filter(e => {
      if (seen.has(e.id)) return false; seen.add(e.id); return true;
    }).slice(-6).reverse();
}

export function provinceHistoryFor(model, province, date, prefs) {
  province=normalizeProvince(province);if(!province)return [];
  const seen=new Set(),entries=cohortHistory(model.episodes,t=>t,date,ep=>ep.provinces || new Set())
    .map(e=>({...e,id:`province:${e.id}`,scope:'province',province:e.theme}));
  for(const e of prefs.manual || [])if(e.scope==='province')entries.push({...e,province:normalizeProvince(e.province),manual:true,order:`${e.date}T${e.createdAt || '23:59:59'}-${e.id}`});
  return entries.filter(e=>e.date<=date && e.province===province)
    .sort((a,b)=>a.order.localeCompare(b.order,'zh-CN')).filter(e=>{
      if(seen.has(e.id))return false;seen.add(e.id);return true;
    }).slice(-6).reverse();
}

export function themeLadderFor(model, rawTheme, date, limit=15) {
  const theme=normalizeTheme(rawTheme),key=themeKey(theme);
  const end=model.days.findLastIndex(day=>day.date<=date);
  if(!theme || end<0)return {theme,date,days:[],maxBoard:1,activeDays:0,highest:0};
  const size=Math.max(1,Math.min(60,Number(limit)||15));
  const days=model.days.slice(Math.max(0,end-size+1),end+1).map(day=>{
    const members=day.stocks.filter(stock=>stock.themes.some(value=>themeKey(value)===key));
    const byBoard=new Map();
    for(const stock of members){
      if(!byBoard.has(stock.board))byBoard.set(stock.board,new Set());
      byBoard.get(stock.board).add(stock.name);
    }
    const boards=[...byBoard].map(([board,names])=>({board,names:[...names].sort((a,b)=>a.localeCompare(b,'zh-CN')),count:names.size})).sort((a,b)=>a.board-b.board);
    return {date:day.date,maxBoard:boards.at(-1)?.board || 0,total:members.length,boards};
  });
  const highest=Math.max(0,...days.map(day=>day.maxBoard));
  return {theme,date:days.at(-1)?.date || date,days,maxBoard:Math.max(1,highest),activeDays:days.filter(day=>day.maxBoard>0).length,highest};
}

export function sortStocks(stocks, sort = { field: 'firstLimit', direction: 'asc' }) {
  const field = sort.field || 'firstLimit'; const sign = sort.direction === 'desc' ? -1 : 1;
  const val = s => field === 'name' ? s.name : s.metrics?.[field];
  return [...stocks].sort((a, b) => {
    const av = val(a), bv = val(b);
    const missingA = av == null || av === '' || av === '--'; const missingB = bv == null || bv === '' || bv === '--';
    if (missingA !== missingB) return missingA ? 1 : -1;
    if (!missingA) {
      const compare = typeof av === 'number' && typeof bv === 'number' ? av - bv : String(av).localeCompare(String(bv), 'zh-CN', { numeric: true });
      if (compare) return compare * sign;
    }
    return a.name.localeCompare(b.name, 'zh-CN');
  });
}

export function sortFirstBoardThemes(groups, sort) {
  if(!sort || !['total','early','late','balance'].includes(sort.field))return [...groups];
  const value=g=>sort.field==='total'?g.stocks.length:sort.field==='balance'?g.times.late-g.times.early:g.times[sort.field];
  const sign=sort.direction==='asc'?1:-1;
  return [...groups].sort((a,b)=>{
    // Unknown first-limit times are not zeros. Keep incomplete time-based
    // rankings at the end in either direction; total counts remain usable.
    if(sort.field!=='total'){
      const aMissing=a.times.unknown>0,bMissing=b.times.unknown>0;
      if(aMissing!==bMissing)return aMissing?1:-1;
      if(aMissing)return 0;
    }
    return (value(a)-value(b))*sign;
  });
}

export function mergeThemes(prefs, date, source, target) {
  source = resolveTheme(source, date, prefs); target = resolveTheme(target, date, prefs);
  if (source === target) return prefs;
  const next = structuredClone(prefs); next.merges ||= {}; next.merges[date] ||= {};
  next.merges[date][source] = target;
  return next;
}

export function countFirstLimitTimes(stocks) {
  const result={early:0, late:0, unknown:0};
  for(const stock of stocks){
    const value=stock.metrics?.firstLimit;
    const m=typeof value==='string' && /^(\d{2}):(\d{2}):(\d{2})$/.exec(value);
    if(!m || +m[1]>23 || +m[2]>59 || +m[3]>59){result.unknown++;continue;}
    // Up to 12:59:59 is the morning bucket; the afternoon bucket starts at 13:00.
    result[+m[1]*3600 + +m[2]*60 + +m[3]<13*3600?'early':'late']++;
  }
  return result;
}

export function reorderThemes(order, source, target, after=false) {
  if(source===target || !order.includes(source) || !order.includes(target))return [...order];
  const next=order.filter(t=>t!==source);next.splice(next.indexOf(target)+(after?1:0),0,source);return next;
}

export function columnWeights(days,prefs) {
  return days.map((d,i)=>{
    const stored=Number(prefs.columnWidths?.[d.date]);
    return Number.isFinite(stored) && stored>=0.05 && stored<=7 ? stored : (days.length===3 ? (i===2 ? 1.5 : .75) : 1);
  });
}

export function resizeColumns(widths,index,delta,minimum=120) {
  const next=[...widths];if(index<0 || index>=widths.length-1)return next;
  const min=Math.min(minimum,(widths[index]+widths[index+1])/2);
  const dx=Math.max(min-widths[index],Math.min(delta,widths[index+1]-min));
  next[index]+=dx;next[index+1]-=dx;return next;
}
