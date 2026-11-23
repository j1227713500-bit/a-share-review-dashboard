import { derive, historyFor, provinceHistoryFor, themeLadderFor, normalizeProvince, colorFor, mergeThemes, reorderThemes, columnWeights, resizeColumns, normalizeName, normalizeTheme, themeKey, buildThemeCatalog, assignStockTheme, removeStockTheme, resolveTheme, SORTS, THEME_SORTS } from './engine.mjs';

const $ = s => document.querySelector(s);
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = {
  plus:'<path d="M8 3v10M3 8h10"/>',
  minus:'<path d="M4 8h8"/>',
  settings:'<path d="M3 4h10M3 8h10M3 12h10"/><circle cx="6" cy="4" r="1.6" fill="currentColor"/><circle cx="10" cy="8" r="1.6" fill="currentColor"/><circle cx="6" cy="12" r="1.6" fill="currentColor"/>',
  search:'<circle cx="7" cy="7" r="4.5"/><path d="m10.5 10.5 3.5 3.5"/>',
  chevron:'<path d="m3 6 5 5 5-5"/>',
  panel:'<rect x="2" y="2" width="12" height="12" rx="2"/><path d="M6 2v12"/>',
  undo:'<path d="M2 6h7a4 4 0 1 1 0 8M5 3 2 6l3 3"/>',
  download:'<path d="M8 2v8m-3-3 3 3 3-3M3 13h10"/>',
};
const icon = name => `<svg class="icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name] || ''}</svg>`;
let state, model, anchor, selected = sessionStorage.getItem('review.selected') || '', search = '';
let selectedProvince=null;
try {
  const saved=JSON.parse(sessionStorage.getItem('review.selectedProvince') || 'null');
  if(saved?.province && typeof saved.province==='string' && /^\d{4}-\d{2}-\d{2}$/.test(saved.date)){
    selectedProvince={province:normalizeProvince(saved.province),date:saved.date};selected='';sessionStorage.removeItem('review.selected');
  }
}catch{sessionStorage.removeItem('review.selectedProvince');}
let expanded = new Set(), undo = [], sidebarHidden = false, mobileSidebar = false, dragging = null;
let saveTimer, saveChain = Promise.resolve(), toastTimer, pollTimer, gesture = null, wheelTotal = 0, wheelTimer, tipTimer, tipHideTimer;
let ladderTimer, ladderHideTimer, ladderSource = null;
let prefRevision = 0;
let resizing = null;
let noteResizing = null;
let noteEditor = null, noteRange = null, noteComposing = false, renderAfterComposition = false;
let exportingImage = false;

async function api(path, body) {
  const res = await fetch(path, body === undefined ? {} : { method:'POST', headers:{'Content-Type':'application/json','X-Review-Token':state.token}, body:JSON.stringify(body) });
  const data = await res.json(); if (!res.ok) throw new Error(data.error || '操作失败，请重试。'); return data;
}
function save() {
  prefRevision++; clearTimeout(saveTimer);
  // Save a synchronous local draft before the network write. An immediate refresh or
  // closed tab must not discard records still waiting in the save queue.
  const draft = { id: crypto.randomUUID(), preferences: structuredClone(state.preferences) };
  try { localStorage.setItem('review.preferenceDraft', JSON.stringify(draft)); }
  catch { toast('浏览器存储空间不足，请等待设置保存完成后再关闭页面'); }
  saveTimer = setTimeout(() => {
    saveChain = saveChain.catch(() => {}).then(async () => {
      await api('/api/preferences', {preferences: draft.preferences});
      if (JSON.parse(localStorage.getItem('review.preferenceDraft') || 'null')?.id === draft.id) localStorage.removeItem('review.preferenceDraft');
    }).catch(e => toast(`设置尚未保存：${e.message}`, '重试', save));
  }, 100);
}
function toast(message, action, callback) {
  clearTimeout(toastTimer); const el = $('#toast');
  el.innerHTML = `<span>${esc(message)}</span>${action ? `<button>${esc(action)}</button>` : ''}`; el.hidden = false;
  if (action) el.querySelector('button').onclick = () => { callback(); el.hidden = true; };
  toastTimer = setTimeout(() => { el.hidden = true; }, action ? 7000 : 4500);
}
function updateModel() {
  model = derive(state);
  const catalog=buildThemeCatalog(state);state.preferences.themeOrders ||= {};
  if(JSON.stringify(catalog)!==JSON.stringify(state.preferences.themeOrders.$catalog)){state.preferences.themeOrders.$catalog=catalog;save();}
}
function visibleDays() {
  const count = Math.min(state.preferences.days || 3, model.days.length);
  anchor = Math.max(count - 1, Math.min(anchor ?? model.days.length - 1, model.days.length - 1));
  return model.days.slice(anchor - count + 1, anchor + 1);
}
function showTheme(theme) {
  const next=selected===theme?'':theme;clearSelection();selected=next;sessionStorage.setItem('review.selected',selected);render();
}
function clearSelection() {
  selected='';selectedProvince=null;sessionStorage.removeItem('review.selected');sessionStorage.removeItem('review.selectedProvince');
}
function provinceSelected(province,date) { return !!province && selectedProvince?.province===province && selectedProvince?.date===date; }
function showProvince(province,date) {
  province=normalizeProvince(province);if(!province)return;
  const next=provinceSelected(province,date)?null:{province,date};clearSelection();selectedProvince=next;
  if(next)sessionStorage.setItem('review.selectedProvince',JSON.stringify(next));hideTip();render();
}
function navigate(step) {
  const old = anchor; const min = Math.min(state.preferences.days, model.days.length) - 1;
  anchor = Math.max(min, Math.min(model.days.length - 1, anchor + step));
  if (old !== anchor) { hideTip();hideThemeLadder();render(); }
}
function shortDate(d) { return d.slice(5).replace('-', '/'); }
function weekday(d) { return '日一二三四五六'[new Date(d + 'T12:00:00').getDay()]; }
function sidebarHTML() {
  const themes = model.themes.filter(t => t.toLowerCase().includes(search.toLowerCase()));
  return `<aside class="sidebar ${mobileSidebar ? 'mobile-open' : ''}">
    <div class="sidebar-head"><h2>题材颜色</h2><p>点击追踪题材，勾选常驻颜色</p></div>
    <div class="search-wrap">${icon('search')}<input id="themeSearch" aria-label="搜索题材" placeholder="搜索题材…" value="${esc(search)}"></div>
    <div class="legend-label"><span>题材 / 颜色</span><span>常驻</span></div>
    <div class="theme-list">${themes.map(t => `<div class="theme-row ${selected === t ? 'active' : ''}">
      <input type="color" class="color-input" data-color="${esc(t)}" value="${colorFor(t,state.preferences)}" aria-label="${esc(t)}颜色">
      <button class="theme-name" data-theme-select="${esc(t)}" data-theme-ladder="${esc(t)}" title="悬停查看近15个交易日高度">${esc(t)}</button>
      <input type="checkbox" class="persist-check" data-persist="${esc(t)}" aria-label="${esc(t)}始终显示颜色" ${state.preferences.colors[t]?.persistent ? 'checked' : ''}>
    </div>`).join('') || '<div class="no-results">没有找到这个题材</div>'}</div>
    <div class="sidebar-foot"><div class="status-line"><i class="status-dot ${state.job?.errors?.length ? 'warn' : ''}"></i><span id="jobSummary">${jobSummary()}</span></div>
      <span>共 ${model.days.length} 个交易日，已保存在本机</span><br><button class="link" data-action="data-report">查看数据状态</button>
    </div></aside>`;
}
function jobSummary() {
  if (state.job?.running) return `补充行情 ${state.job.done}/${state.job.total}`;
  const ready = model.days.filter(d => d.dataStatus === 'ready').length;
  return ready === model.days.length && ready ? '问财行情已补全' : 'Excel 名单已就绪';
}
function historyHTML(theme, date, scope='theme') {
  const entries = scope==='province' ? provinceHistoryFor(model,theme,date,state.preferences) : historyFor(model, theme, date, state.preferences);
  return `<div class="history-box"><div class="history-heading"><span>连板历史</span><span>最近 ${entries.length}/6 条</span></div>
    ${entries.map(e => `<div class="history-item"><span class="record-text">${esc(e.text)}</span><small title="${e.manual ? '手动记录' : '首板至最后一板'}">${e.manual ? '手动' : `${e.startDate ? (e.startDate.slice(0,4) === e.lastDate.slice(0,4) ? shortDate(e.startDate) : e.startDate.replaceAll('-','/')) : '起日待补'}–${e.startDate && e.startDate.slice(0,4) !== e.lastDate.slice(0,4) ? e.lastDate.replaceAll('-','/') : shortDate(e.lastDate)}`}</small>${e.manual ? `<button data-edit-note="${esc(e.id)}" aria-label="编辑记录">改</button><button data-delete-note="${esc(e.id)}" aria-label="删除记录">×</button>` : ''}</div>`).join('') || '<div class="history-empty">暂时没有已结束的连板批次<br>同日首板全部断板后，记录最高连板（至少 2 板）</div>'}
    <form class="add-note" ${scope==='province'?'data-note-province':'data-note-theme'}="${esc(theme)}" data-note-date="${date}"><input name="text" aria-label="${esc(theme)}${scope==='province'?'省份':''}手动记录" placeholder="补充一条记录…" maxlength="120" required><button title="添加记录" aria-label="添加记录">＋</button></form></div>`;
}
function themeLadderHTML(theme,date) {
  const ladder=themeLadderFor(model,theme,date,15),rowHeight=44,rows=ladder.maxBoard,days=ladder.days;
  const width=Math.max(720,days.length*52),viewWidth=Math.max(1,days.length)*100,viewHeight=rows*100;
  let path='',drawing=false;
  const points=[];
  days.forEach((day,index)=>{
    if(!day.maxBoard){drawing=false;return;}
    const x=index*100+50,y=(rows-day.maxBoard+.5)*100;
    path+=`${drawing?' L':' M'} ${x} ${y}`;drawing=true;points.push({x,y,index,board:day.maxBoard});
  });
  const grid=[...Array(rows+1)].map((_,i)=>`<line x1="0" y1="${i*100}" x2="${viewWidth}" y2="${i*100}"/>`).join('')+
    [...Array(days.length+1)].map((_,i)=>`<line x1="${i*100}" y1="0" x2="${i*100}" y2="${viewHeight}"/>`).join('');
  const cells=days.flatMap((day,index)=>day.boards.map(board=>{
    const names=board.names,boardName=board.board===1?'首板':`${board.board}板`,summary=board.board===1
      ? `<strong class="ladder-first-count">${board.count}</strong><span>只</span>`
      : `<strong class="ladder-stock-name">${esc(names[0])}</strong><span class="ladder-cell-count">共${board.count}只</span>`;
    return `<button class="ladder-cell ${board.board===1?'first-board':''} ${board.board===day.maxBoard?'daily-peak':''}" style="grid-column:${index+1};grid-row:${rows-board.board+1}" data-ladder-names="${esc(JSON.stringify(names))}" data-ladder-cell-date="${day.date}" data-ladder-board="${board.board}" data-ladder-count="${board.count}" aria-label="${day.date} ${boardName} ${board.count}只：${esc(names.join('、'))}">${summary}</button>`;
  })).join('');
  const yLabels=Array.from({length:rows},(_,i)=>rows-i).map(board=>`<span>${board===1?'首板':`${board}板`}</span>`).join('');
  const dateLabels=days.map(day=>`<span class="ladder-date ${day.maxBoard?'active':''}" title="${day.date}">${shortDate(day.date)}</span>`).join('');
  const highest=ladder.highest ? `${ladder.highest===1?'首板':`${ladder.highest}板`}` : '未出现';
  return `<header class="ladder-head"><div class="ladder-title"><i style="--theme:${colorFor(theme,state.preferences)}"></i><div><strong>${esc(theme)}</strong><span>近 ${days.length} 个交易日高度天梯</span></div></div><div class="ladder-summary"><span>活跃 <b>${ladder.activeDays}</b> 日</span><span>最高 <b>${highest}</b></span></div></header>
    <div class="ladder-body"><div class="ladder-chart-frame" style="--rows:${rows};--plot-height:${rows*rowHeight}px">
      <div class="ladder-y-axis">${yLabels}</div><div class="ladder-scroll-x"><div class="ladder-chart-inner" style="width:${width}px">
        <div class="ladder-plot"><svg viewBox="0 0 ${viewWidth} ${viewHeight}" preserveAspectRatio="none" aria-hidden="true"><g class="ladder-grid-lines">${grid}</g>${path?`<path class="ladder-peak-line" d="${path}"/>${points.map(point=>`<circle class="ladder-peak-dot" cx="${point.x}" cy="${point.y}" r="7"><title>${days[point.index].date} · ${point.board===1?'首板':`${point.board}板`}</title></circle>`).join('')}`:''}</svg><div class="ladder-cells" style="grid-template-columns:repeat(${Math.max(1,days.length)},1fr);grid-template-rows:repeat(${rows},${rowHeight}px)">${cells}</div>${ladder.activeDays?'':'<div class="ladder-empty">这段时间没有出现</div>'}</div>
        <div class="ladder-dates" style="grid-template-columns:repeat(${Math.max(1,days.length)},1fr)">${dateLabels}</div>
      </div></div></div></div>
    <footer class="ladder-inspector" aria-live="polite"><span>悬停格子，查看该高度的完整股票名单</span><small>折线连接连续出现日期的每日最高板</small></footer>`;
}
function positionThemeLadder(source) {
  const panel=$('#themeLadder'),rect=source.getBoundingClientRect(),box=panel.getBoundingClientRect();
  panel.style.left=`${Math.max(12,Math.min(rect.left,innerWidth-box.width-12))}px`;
  const below=rect.bottom+8,above=rect.top-box.height-8;
  panel.style.top=`${below+box.height<=innerHeight-12?below:Math.max(12,above)}px`;
}
function showThemeLadder(source) {
  const theme=source?.dataset.themeLadder;if(!theme || !source.isConnected)return;
  const date=source.dataset.ladderDate || model.days[anchor]?.date || model.days.at(-1)?.date;if(!date)return;
  clearTimeout(ladderTimer);clearTimeout(ladderHideTimer);hideTip();ladderSource=source;
  const panel=$('#themeLadder');panel.innerHTML=themeLadderHTML(theme,date);panel.style.setProperty('--theme',colorFor(theme,state.preferences));panel.hidden=false;positionThemeLadder(source);
}
function hideThemeLadder() {
  clearTimeout(ladderTimer);clearTimeout(ladderHideTimer);const panel=$('#themeLadder');if(panel)panel.hidden=true;ladderSource=null;
}
function scheduleHideThemeLadder() {
  clearTimeout(ladderTimer);clearTimeout(ladderHideTimer);ladderHideTimer=setTimeout(()=>{
    const panel=$('#themeLadder'),sourceActive=ladderSource?.isConnected && ladderSource.matches(':hover');
    if(!sourceActive && !panel.matches(':hover') && !panel.contains(document.activeElement))hideThemeLadder();
  },220);
}
function inspectLadderCell(cell) {
  const panel=$('#themeLadder'),inspector=panel.querySelector('.ladder-inspector');if(!cell || !inspector)return;
  let names=[];try{names=JSON.parse(cell.dataset.ladderNames || '[]');}catch{}
  panel.querySelectorAll('.ladder-cell.inspecting').forEach(el=>el.classList.remove('inspecting'));cell.classList.add('inspecting');
  const board=Number(cell.dataset.ladderBoard),label=board===1?'首板':`${board}板`;
  inspector.innerHTML=`<strong>${shortDate(cell.dataset.ladderCellDate)} · ${label} · ${cell.dataset.ladderCount}只</strong><span>${esc(names.join('、'))}</span>`;
}
function stockKey(stock) { return stock.metrics.code || normalizeName(stock.name); }
function stockMetricMarkers(stock) {
  const metric=raw=>raw!==null && raw!=='' && Number.isFinite(Number(raw)) ? Number(raw) : null;
  const decimal=(value,digits=8)=>value.toFixed(digits).replace(/\.?0+$/,'');
  const ratio=metric(stock.metrics?.floatRatio),cap=metric(stock.metrics?.floatCap),markers=[];
  if(cap!==null && cap<3_000_000_000)markers.push({kind:'float-cap',label:`自由流通市值 ${decimal(cap/1e8)} 亿元，低于 30 亿元`});
  if(ratio!==null && ratio<51)markers.push({kind:'float-ratio',label:`自由流通股占比 ${decimal(ratio,6)}%，低于 51%`});
  return markers.length ? `<span class="stock-metric-markers" aria-label="${esc(markers.map(m=>m.label).join('；'))}">${markers.map(m=>`<i class="stock-metric-marker ${m.kind}" data-metric-marker="${m.kind}" title="${esc(m.label)}"></i>`).join('')}</span>` : '';
}
function stockHTML(stock, date, theme=null) {
  const key=stockKey(stock), color=state.preferences.stockColors[key] || state.preferences.stockColors[normalizeName(stock.name)];
  const provinceMatch=provinceSelected(stock.province,date),style=[color?`--stock-color:${esc(color)}`:'',provinceMatch?`--province-color:${provinceColor(stock.province)}`:''].filter(Boolean).join(';');
  const sources=(stock.mergedThemes || []).filter(t=>!theme || t.target===theme);
  const multiThemeFirstBoard=stock.board===1 && stock.themes.length>=2;
  const stockTitle=multiThemeFirstBoard
    ? `橙色：首板同时属于${stock.themes.length}个题材；悬停查看详情；点击添加题材；右键设置高亮`
    : '悬停查看详情；点击添加题材；右键设置高亮';
  return `<span class="stock-entry ${color ? 'has-highlight' : ''} ${provinceMatch?'province-match':''}" ${style ? `style="${style}"` : ''}>
    ${stockMetricMarkers(stock)}
    <button class="stock ${multiThemeFirstBoard?'multi-theme-firstboard':''}" data-stock="${esc(stock.name)}" data-stock-date="${date}" ${multiThemeFirstBoard?`data-firstboard-theme-count="${stock.themes.length}"`:''} title="${stockTitle}">${esc(stock.name)}</button>
    <button class="stock-color-button" data-highlight-stock="${esc(stock.name)}" data-highlight-date="${date}" aria-label="${esc(stock.name)}高亮颜色" title="设置个股高亮颜色"><span></span></button>
    ${sources.map(t=>`<span class="source-theme" style="--source-color:${colorFor(t.source,state.preferences)}" data-theme-ladder="${esc(t.source)}" data-ladder-date="${date}" title="原题材：${esc(t.source)}，已合并到${esc(t.target)}；悬停查看近15日高度">${esc(t.source)}</span>`).join('')}</span>`;
}

function maskedStockName(name) {
  const characters=[...String(name || '')];
  return characters.slice(0,2).join('')+'*'.repeat(Math.max(0,characters.length-2));
}
function maskExportedStockNames(root) {
  const names=new Set();
  for(const day of model.days){
    for(const stock of day.stocks || [])if(stock.name)names.add(stock.name);
    for(const stock of day.rebound?.stocks || [])if(stock.name)names.add(stock.name);
  }
  const replacements=[...names].sort((a,b)=>[...b].length-[...a].length).map(name=>[name,maskedStockName(name)]);
  const walker=document.createTreeWalker(root,NodeFilter.SHOW_TEXT);let node;
  while((node=walker.nextNode())){
    let text=node.nodeValue;
    for(const [name,masked] of replacements)if(text.includes(name))text=text.replaceAll(name,masked);
    node.nodeValue=text;
  }
}
function imageBlob(canvas) {
  return new Promise((resolve,reject)=>canvas.toBlob(blob=>blob?resolve(blob):reject(new Error('无法生成 PNG 图片')),'image/png'));
}
function setExportButtonState(busy) {
  const button=document.querySelector('[data-action="export-image"]');if(!button)return;
  button.disabled=busy;button.setAttribute('aria-busy',String(busy));
  button.innerHTML=`${icon('download')}<span>${busy?'生成中…':'导出长图'}</span>`;
}
async function exportLongImage() {
  if(exportingImage)return;
  const board=$('#board');if(!board){toast('当前没有可导出的复盘数据');return;}
  exportingImage=true;setExportButtonState(true);hideTip();hideThemeLadder();hideNoteToolbar();document.activeElement?.blur?.();
  let surface;
  try{
    const boardWidth=Math.ceil(Math.max(board.scrollWidth,board.getBoundingClientRect().width));
    const boardClone=board.cloneNode(true),gridColumns=getComputedStyle(board).gridTemplateColumns;
    boardClone.style.width=`${boardWidth}px`;boardClone.style.gridTemplateColumns=gridColumns;
    for(const liveBody of board.querySelectorAll('[data-scroll-date]')){
      const key=CSS.escape(liveBody.dataset.scrollDate),cloneBody=boardClone.querySelector(`[data-scroll-date="${key}"]`);
      if(!cloneBody)continue;
      cloneBody.style.height=`${Math.ceil(Math.max(liveBody.scrollHeight,liveBody.clientHeight))}px`;
      cloneBody.style.flex='0 0 auto';cloneBody.style.overflow='visible';
    }
    surface=document.createElement('div');
    surface.id='exportCapture';surface.className=`export-capture-root ${$('.shell')?.classList.contains('dense')?'dense':''}`;
    surface.style.cssText=`position:fixed;left:-100000px;top:0;width:${boardWidth+24}px;z-index:-1;pointer-events:none`;
    surface.append(boardClone);maskExportedStockNames(surface);document.body.append(surface);
    await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));
    const width=Math.ceil(surface.scrollWidth),height=Math.ceil(surface.scrollHeight);
    if(!width || !height)throw new Error('看板尺寸异常，请刷新后重试');
    const scale=Math.min(2,30000/width,30000/height,Math.sqrt(160_000_000/(width*height)));
    if(scale<.25)throw new Error('当前内容过长，请减少显示天数后再导出');
    const canvas=await html2canvas(surface,{backgroundColor:'#f4f6fb',scale,width,height,logging:false,useCORS:true,removeContainer:true,windowWidth:Math.max(innerWidth,width),windowHeight:Math.max(innerHeight,height),scrollX:0,scrollY:0,onclone:documentClone=>{
      const clone=documentClone.querySelector('#exportCapture');
      if(clone)clone.style.cssText=`position:absolute;left:0;top:0;width:${width}px;height:${height}px;z-index:0;pointer-events:none;background:#f4f6fb`;
    }});
    const blob=await imageBlob(canvas),url=URL.createObjectURL(blob),days=visibleDays();
    const range=days.length>1?`${days[0].date}_${days.at(-1).date}`:days[0]?.date || new Date().toISOString().slice(0,10);
    const link=document.createElement('a');link.href=url;link.download=`复盘看板_${range}_长图.png`;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
    toast('长图已导出，股票名称已仅保留前两个字');
  }catch(error){toast(`导出失败：${error.message}`);}
  finally{surface?.remove();exportingImage=false;setExportButtonState(false);}
}
// Only text layout and a small set of font styles enter the saved rich text.
function cleanNoteHTML(html) {
  const template=document.createElement('template');template.innerHTML=html;
  const allowed=new Set(['B','STRONG','I','EM','U','S','STRIKE','SPAN','FONT','DIV','P','BR','OL','LI']);
  const blocked=new Set(['SCRIPT','STYLE','IFRAME','OBJECT','SVG','MATH','TEMPLATE','IMG','VIDEO','AUDIO','INPUT','BUTTON','SELECT','TEXTAREA']);
  function clean(node) {
    if(node.nodeType===Node.TEXT_NODE)return document.createTextNode(node.textContent);
    const fragment=document.createDocumentFragment();
    if(node.nodeType!==Node.ELEMENT_NODE || blocked.has(node.tagName))return fragment;
    const out=allowed.has(node.tagName)?document.createElement(node.tagName==='FONT'?'span':node.tagName.toLowerCase()):fragment;
    if(out.nodeType===Node.ELEMENT_NODE){
      const s=node.style;
      if(/^(bold|[6-9]00)$/.test(s.fontWeight))out.style.fontWeight='700';
      if(s.fontStyle==='italic')out.style.fontStyle='italic';
      if(s.textDecorationLine.includes('underline'))out.style.textDecorationLine='underline';
      const size=s.fontSize || (node.tagName==='FONT'?({1:'10px',2:'13px',3:'16px',4:'18px',5:'24px',6:'32px',7:'48px'}[node.getAttribute('size')]):'');
      if(size && /^(\d+(\.\d+)?)(px|pt)$/.test(size))out.style.fontSize=`${Math.max(10,Math.min(32,parseFloat(size)*(size.endsWith('pt')?4/3:1)))}px`;
      const color=s.color || (node.tagName==='FONT'?node.getAttribute('color'):'');
      if(color && /^(#[\da-f]{3,8}|rgba?\([\d\s.,%]+\)|[a-z]+)$/i.test(color))out.style.color=color;
    }
    for(const child of node.childNodes)out.append(clean(child));
    return out;
  }
  const result=document.createElement('div');for(const child of template.content.childNodes)result.append(clean(child));
  return result.innerHTML;
}
function noteHTML(kind,key,date,label,text) {
  const saved=state.preferences.themeNotes.$rich?.[kind]?.[date]?.[key];
  const html=saved?cleanNoteHTML(saved):esc(text || '').replace(/\n/g,'<br>');
  return `<div class="inline-note rich-note ${kind}-note" contenteditable="true" role="textbox" aria-multiline="true" data-inline-note="${kind}" data-note-key="${esc(key)}" data-note-date="${date}" aria-label="${esc(label)}当日备注" title="${esc(label)} · ${date}（自动保存）">${html}</div>`;
}
function inlineNote(kind, key, date, label) {
  return noteHTML(kind,key,date,label,state.preferences.stockNotes[date]?.[key] || '');
}
function bandNoteHTML(board, date) {
  const value=state.preferences.themeNotes.$bands?.[date]?.[board] || '';
  const label=board===1?'首板':`${board}板`;
  return noteHTML('band',board,date,label,value);
}
const REVIEW_SECTIONS=[
  ['rebound','今日反包'],['emotion','高标情绪'],['themes','题材风口'],
  ['orders','封单异常'],['trades','今日买卖'],['plan','明日计划'],
];
function reviewNoteText(key,date) {
  const saved=state.preferences.themeNotes.$reviews?.[date]?.[key];
  return typeof saved==='string' ? saved : saved?.text || '';
}
function reboundResultHTML(day) {
  const result=day.rebound || {status:'pending',stocks:[],message:'等待查询今日反包'};
  const stocks=result.stocks || [],status=result.status || 'pending';
  const previous=result.previousDates || [];
  return `<div class="rebound-result ${status}" aria-label="今日反包自动筛选结果">
    <div class="rebound-result-head"><span class="rebound-status-dot"></span><strong>${status==='ready'?`${stocks.length} 只`:status==='error'?'查询未完成':'等待问财查询'}</strong><span>${esc(result.message || '')}</span></div>
    ${stocks.length ? `<div class="rebound-stocks">${stocks.map(stock=>`<span><b>${esc(stock.name)}</b><small>${esc(stock.code)}</small></span>`).join('')}</div>` : status==='ready' ? '<div class="rebound-empty">当日没有符合条件的股票</div>' : ''}
    <div class="rebound-source">${previous.length===2?`${shortDate(previous[0])} 涨停 → ${shortDate(previous[1])} 断板 → ${shortDate(day.date)} 涨停 · `:''}数据来源：同花顺问财</div>
  </div>`;
}
function dailyReviewHTML(day) {
  return `<section class="daily-review" aria-label="${day.date}每日复盘分区"><header class="daily-review-head"><strong>每日复盘</strong><span>按交易日独立保存 · 点击正文开始记录</span></header>
    ${REVIEW_SECTIONS.map(([key,title],index)=>`<article class="review-section" data-review-section="${key}">
      <div class="review-label"><span>${String(index+1).padStart(2,'0')}</span><strong>${title}</strong></div>
      <div class="review-content">${key==='rebound'?reboundResultHTML(day):''}${noteHTML('review',key,day.date,title,reviewNoteText(key,day.date))}</div>
    </article>`).join('')}</section>`;
}
function provinceColor(province) { return colorFor(`province:${province}`,state.preferences); }
function provinceExpandKey(stock,date) { return JSON.stringify(['province',date,stock.name,stock.province]); }
function provinceToken(stock,date) {
  const province=stock.province;
  if(!province)return '<span class="stock-province province-missing" title="省份待补充">省份待补</span>';
  const key=provinceExpandKey(stock,date),opened=expanded.has(key);
  return `<span class="stock-province theme-token province-token ${provinceSelected(province,date)?'selected':''}" style="--theme:${provinceColor(province)}" data-province="${esc(province)}" title="${esc(stock.metrics.province || province)}">
    <button class="token-label" data-province-select="${esc(province)}" data-province-date="${date}" aria-label="高亮${date}的${esc(province)}个股" aria-pressed="${provinceSelected(province,date)}" title="点击高亮当日同省份个股；再次点击取消">${esc(province)}</button><button class="history-toggle ${opened?'open':''}" data-expand="${esc(key)}" aria-label="${esc(stock.name)}的${esc(province)}省份历史" aria-expanded="${opened}">${icon('chevron')}</button></span>`;
}
function provinceTipToken(stock,date) {
  const province=stock.province;if(!province)return '<span class="tip-province">省份待补充</span>';
  return `<button class="tip-province theme-token ${provinceSelected(province,date)?'selected':''}" style="--theme:${provinceColor(province)}" data-province-select="${esc(province)}" data-province-date="${date}" aria-label="高亮${date}的${esc(province)}个股" aria-pressed="${provinceSelected(province,date)}" title="点击高亮当日同省份个股；再次点击取消">${esc(province)}</button>`;
}
function themeNoteRecord(theme,date) {
  const saved=state.preferences.themeNotes[date]?.[theme];
  // Retain notes written before resizable note panels were introduced.
  return typeof saved==='string' ? {text:saved} : saved && typeof saved==='object' ? saved : {text:''};
}
function themeNoteSize() {
  const size=state.preferences.themeNotes.$size || {};
  return {width:Math.max(.15,Math.min(.75,Number(size.width)||.32)),height:Math.max(52,Math.min(600,Number(size.height)||60))};
}
function storeThemeNoteSize(size) { state.preferences.themeNotes.$size=size;save(); }
function applyThemeNoteSize(size) {
  for(const content of document.querySelectorAll('.theme-content')){
    content.style.setProperty('--note-width',`${size.width*100}%`);content.style.setProperty('--note-height',`${size.height}px`);
  }
}
function themeNoteHTML(theme,date) {
  return `<div class="theme-note-pane">
    ${noteHTML('theme',theme,date,theme,themeNoteRecord(theme,date).text || '')}
    <div class="theme-note-resizer" role="separator" aria-orientation="vertical" tabindex="0" data-resize-note="${esc(theme)}" data-resize-date="${date}" data-resize-axis="width" aria-label="调整${esc(theme)}备注宽度" title="左右拖动，统一调整所有题材备注宽度"></div>
    <button class="theme-note-grip" data-resize-note="${esc(theme)}" data-resize-date="${date}" data-resize-axis="both" aria-label="调整${esc(theme)}备注大小" title="向左拉宽、向下拉高，所有题材同步；也可使用方向键"></button>
  </div>`;
}
function stockNoteSize() {
  const size=state.preferences.themeNotes.$stockSize || {};
  return {width:Math.max(.28,Math.min(.78,Number(size.width)||.56))};
}
function storeStockNoteSize(size) { state.preferences.themeNotes.$stockSize=size;save(); }
function applyStockNoteSize(size) {
  for(const row of document.querySelectorAll('.streak-row'))row.style.setProperty('--stock-note-width',`${size.width*100}%`);
}
function stockNoteHTML(stock,date) {
  return `<div class="stock-note-pane">
    ${inlineNote('stock',normalizeName(stock.name),date,stock.name)}
    <div class="stock-note-resizer" role="separator" aria-orientation="vertical" tabindex="0" data-resize-stock-note="${esc(normalizeName(stock.name))}" data-resize-date="${date}" aria-label="调整高板备注宽度" title="左右拖动，统一调整所有高板备注宽度"></div>
  </div>`;
}
function saveNote(editor) {
  const {inlineNote:kind,noteKey:key,noteDate:date}=editor.dataset;
  const text=editor.innerText.replace(/\r\n/g,'\n'),html=cleanNoteHTML(editor.innerHTML);
  if(kind==='theme'){
    state.preferences.themeNotes[date] ||= {};
    state.preferences.themeNotes[date][key]={...themeNoteRecord(key,date),text};
  }else if(kind==='band'){
    const notes=state.preferences.themeNotes.$bands ||= {};notes[date] ||= {};notes[date][key]=text;
  }else if(kind==='review'){
    const notes=state.preferences.themeNotes.$reviews ||= {};notes[date] ||= {};notes[date][key]={text};
  }else{state.preferences.stockNotes[date] ||= {};state.preferences.stockNotes[date][key]=text;}
  const rich=state.preferences.themeNotes.$rich ||= {};rich[kind] ||= {};rich[kind][date] ||= {};rich[kind][date][key]=html;
  save();
}
function noteToolbar() {
  let bar=$('#noteToolbar');if(bar)return bar;
  bar=document.createElement('div');bar.id='noteToolbar';bar.hidden=true;bar.setAttribute('role','toolbar');bar.setAttribute('aria-label','备注文字格式');
  bar.innerHTML=`<button type="button" data-note-command="bold" aria-label="加粗" aria-pressed="false" title="加粗（⌘/Ctrl+B）"><b>B</b></button>
    <button type="button" data-note-command="italic" aria-label="斜体" aria-pressed="false" title="斜体（⌘/Ctrl+I）"><i>I</i></button>
    <button type="button" data-note-command="underline" aria-label="下划线" aria-pressed="false" title="下划线（⌘/Ctrl+U）"><u>U</u></button>
    <button type="button" class="note-list-tool" data-note-command="insertOrderedList" aria-label="编号列表" aria-pressed="false" title="编号列表 1、2、3"><span>1.</span><span>2.</span><span>3.</span></button>
    <span class="note-tool-divider"></span><select data-note-size aria-label="备注字号" title="选中文字后调整字号"><option value="">字号</option><option value="1">10</option><option value="2">13</option><option value="3">16</option><option value="4">18</option><option value="5">24</option></select>
    <label class="note-color-tool" title="文字颜色"><span>A</span><input type="color" data-note-color value="#344158" aria-label="备注文字颜色"></label>
    <button type="button" data-note-command="removeFormat" aria-label="清除文字格式" title="清除选中文字的格式">T<span class="note-clear-mark">×</span></button>
    <span class="note-tool-divider"></span><button type="button" data-note-done aria-label="结束备注编辑" title="结束编辑">✓</button>`;
  document.body.append(bar);
  bar.addEventListener('pointerdown',e=>{rememberNoteRange();if(e.target.closest('button'))e.preventDefault();});
  bar.addEventListener('click',e=>{
    const button=e.target.closest('button');if(!button)return;
    if(button.hasAttribute('data-note-done')){noteEditor?.blur();hideNoteToolbar();return;}
    formatNote(button.dataset.noteCommand);
  });
  bar.addEventListener('change',e=>{
    if(e.target.hasAttribute('data-note-size') && e.target.value)formatNote('fontSize',e.target.value);
    if(e.target.hasAttribute('data-note-color'))formatNote('foreColor',e.target.value);
  });
  return bar;
}
function rememberNoteRange() {
  const selection=getSelection();if(!noteEditor || !selection.rangeCount)return;
  const range=selection.getRangeAt(0);
  if(noteEditor.contains(range.startContainer) && noteEditor.contains(range.endContainer))noteRange=range.cloneRange();
}
function updateNoteToolbar() {
  if(!noteEditor?.isConnected)return;
  const bar=noteToolbar();
  for(const button of bar.querySelectorAll('[aria-pressed]'))button.setAttribute('aria-pressed',String(document.queryCommandState(button.dataset.noteCommand)));
  const selection=getSelection(),node=selection?.anchorNode;
  if(node && noteEditor.contains(node)){
    const style=getComputedStyle(node.nodeType===Node.ELEMENT_NODE?node:node.parentElement);
    bar.querySelector('[data-note-size]').value=({10:'1',13:'2',16:'3',18:'4',24:'5'})[Math.round(parseFloat(style.fontSize))] || '';
    const rgb=style.color.match(/^rgb\((\d+),\s*(\d+),\s*(\d+)\)$/);
    if(rgb){const color='#'+rgb.slice(1).map(v=>Number(v).toString(16).padStart(2,'0')).join('');bar.querySelector('[data-note-color]').value=color;bar.style.setProperty('--note-ink',color);}
  }
  positionNoteToolbar();
}
function positionNoteToolbar() {
  if(!noteEditor?.isConnected)return;
  const bar=noteToolbar(),r=noteEditor.getBoundingClientRect(),clip=noteEditor.closest('.day-body').getBoundingClientRect();
  if(r.bottom<clip.top || r.top>clip.bottom){bar.hidden=true;return;}
  bar.hidden=false;const b=bar.getBoundingClientRect();
  bar.style.left=`${Math.max(8,Math.min(r.left,innerWidth-b.width-8))}px`;
  const above=r.top-b.height-7;
  bar.style.top=`${Math.max(8,Math.min(above>=50?above:r.bottom+7,innerHeight-b.height-8))}px`;
}
function hideNoteToolbar() {if($('#noteToolbar'))$('#noteToolbar').hidden=true;noteEditor=null;noteRange=null;}
function formatNote(command,value=null) {
  if(!noteEditor?.isConnected || !command)return;
  const editor=noteEditor,range=noteRange?.cloneRange();
  editor.focus({preventScroll:true});
  if(range && editor.contains(range.startContainer) && editor.contains(range.endContainer)){const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}
  // Native editing keeps selection, typing styles, and the browser's undo history.
  document.execCommand(command,false,value);saveNote(editor);rememberNoteRange();updateNoteToolbar();
}
function captureNoteEditing() {
  const editor=document.activeElement?.closest('[data-inline-note]') || ($('#noteToolbar')?.contains(document.activeElement)?noteEditor:null);
  if(!editor)return null;
  rememberNoteRange();
  const path=node=>{const result=[];while(node && node!==editor){result.unshift([...node.parentNode.childNodes].indexOf(node));node=node.parentNode;}return result;};
  const range=noteRange && editor.contains(noteRange.startContainer) && editor.contains(noteRange.endContainer)?{start:path(noteRange.startContainer),startOffset:noteRange.startOffset,end:path(noteRange.endContainer),endOffset:noteRange.endOffset}:null;
  return {editor,range,toolbarFocus:$('#noteToolbar')?.contains(document.activeElement)};
}
function restoreNoteEditing(editing) {
  if(!editing){hideNoteToolbar();return;}
  const {editor,range,toolbarFocus}=editing,d=editor.dataset;
  const replacement=[...document.querySelectorAll('[data-inline-note]')].find(e=>e.dataset.inlineNote===d.inlineNote && e.dataset.noteKey===d.noteKey && e.dataset.noteDate===d.noteDate);
  if(!replacement){hideNoteToolbar();return;}
  replacement.replaceWith(editor);noteEditor=editor;
  if(!toolbarFocus)editor.focus({preventScroll:true});
  if(range){
    const node=path=>path.reduce((n,i)=>n.childNodes[i],editor),restored=document.createRange();
    restored.setStart(node(range.start),range.startOffset);restored.setEnd(node(range.end),range.endOffset);
    const selection=getSelection();selection.removeAllRanges();selection.addRange(restored);noteRange=restored.cloneRange();
  }
  updateNoteToolbar();
}
function themeToken(theme, day, stock) {
  const key=`${day.date}|${stock.board}|${theme}|${stock.name}`;
  return `<span class="theme-token ${selected === theme ? 'selected' : ''}" style="--theme:${colorFor(theme,state.preferences)}" data-group-theme="${esc(theme)}" data-group-date="${day.date}" data-theme-ladder="${esc(theme)}" data-ladder-date="${day.date}">
    <button class="token-label" data-theme-select="${esc(theme)}" draggable="true" data-drag-theme="${esc(theme)}" data-drag-date="${day.date}" title="点击联动高亮；拖到同日其他题材可合并">${esc(theme)}</button>
    <button class="history-toggle ${expanded.has(key) ? 'open' : ''}" data-expand="${esc(key)}" aria-label="${esc(stock.name)}的${esc(theme)}题材历史" aria-expanded="${expanded.has(key)}">${icon('chevron')}</button></span>`;
}
function streakHTML(stock, day) {
  const openThemes=stock.themes.filter(t=>expanded.has(`${day.date}|${stock.board}|${t}|${stock.name}`));
  const noteSize=stockNoteSize();
  return `<div class="streak-item"><div class="streak-row" style="--stock-note-width:${noteSize.width*100}%">${stockHTML(stock,day.date)}
    <div class="stock-context"><div class="stock-themes">${stock.themes.map(t=>themeToken(t,day,stock)).join('')}</div>${provinceToken(stock,day.date)}</div>
    ${stockNoteHTML(stock,day.date)}</div>
    ${openThemes.map(t=>`<div class="streak-history" style="--theme:${colorFor(t,state.preferences)}"><div class="streak-history-title">${esc(t)}</div>${historyHTML(t,day.date)}</div>`).join('')}
    ${stock.province && expanded.has(provinceExpandKey(stock,day.date)) ? `<div class="streak-history province-history" data-province-history="${esc(stock.province)}" style="--theme:${provinceColor(stock.province)}"><div class="streak-history-title">${esc(stock.province)} · 连板高度</div>${historyHTML(stock.province,day.date,'province')}</div>` : ''}</div>`;
}
function firstBoardHTML(group, day) {
  const key=`${day.date}|1|${group.theme}`, opened=expanded.has(key), color=colorFor(group.theme,state.preferences);
  const size=themeNoteSize();
  return `<div class="theme-group ${state.preferences.colors[group.theme]?.persistent ? 'colored' : ''} ${selected === group.theme ? 'selected' : ''}" style="--theme:${color}" data-group-theme="${esc(group.theme)}" data-group-date="${day.date}">
    <div class="theme-content" style="--note-width:${size.width*100}%;--note-height:${size.height}px"><div class="theme-main">
    <div class="group-head">
      <button class="theme-reorder" draggable="true" data-order-theme="${esc(group.theme)}" data-order-date="${day.date}" aria-label="拖动${esc(group.theme)}顺序" title="拖动调整题材顺序；聚焦后按上下键调整">⠿</button>
      <span class="theme-dot"></span><button class="group-title" draggable="true" data-drag-theme="${esc(group.theme)}" data-drag-date="${day.date}" data-theme-select="${esc(group.theme)}" data-theme-ladder="${esc(group.theme)}" data-ladder-date="${day.date}" title="点击联动高亮；悬停查看近15日高度；拖到同日其他题材可合并">${esc(group.theme)}</button><span class="group-count">${group.stocks.length}</span>
      <span class="limit-counts" title="首次涨停不晚于 12:59 计早，13:00 及以后计午${group.times.unknown ? `；${group.times.unknown} 只时间待补充` : ''}">早${group.times.early}午${group.times.late}${group.times.unknown ? `<span class="unknown-times"> 待${group.times.unknown}</span>` : ''}</span>
      <button class="history-toggle ${opened ? 'open' : ''}" data-expand="${esc(key)}" aria-label="${esc(group.theme)}题材信息" aria-expanded="${opened}">${icon('chevron')}</button></div>
    <div class="stock-grid">${group.stocks.map(s=>stockHTML(s,day.date,group.theme)).join('')}</div>
    </div>${themeNoteHTML(group.theme,day.date)}</div>${opened ? historyHTML(group.theme,day.date) : ''}</div>`;
}
function themeSortHTML(date) {
  const sort=state.preferences.sorts.firstBoard?.[date] || {field:'manual',direction:'desc'};
  return `<div class="theme-sort"><span class="theme-sort-field"><select data-firstboard-sort="${date}" aria-label="${date}首板题材排序" title="首板题材排序，仅影响当日；早盘按13:00之前统计（截至12:59），时间待补题材在时间排序中置后">${THEME_SORTS.map(([value,label])=>`<option value="${value}" ${sort.field===value?'selected':''}>${label}</option>`).join('')}</select>${icon('chevron')}</span>
    <button class="sort-direction" data-theme-sort-direction="${date}" aria-label="${date}首板题材排序方向" title="${sort.direction==='asc'?'当前从小到大，点击改为从大到小':'当前从大到小，点击改为从小到大'}" ${sort.field==='manual'?'disabled':''}>${sort.direction==='asc'?'↑':'↓'}</button></div>`;
}
function bandHTML(b,day) {
  return `<div class="band" data-board="${b.board}"><div class="band-heading ${b.board===1?'firstboard-heading':''}"><span class="band-title"><span class="board-number">${b.board === 1 ? '首板' : `${b.board} 板`}</span><span class="band-count" title="${b.board===1?'首板':`${b.board}板`}涨停总数">${b.count}<small>只</small></span></span>${bandNoteHTML(b.board,day.date)}${b.board===1?themeSortHTML(day.date):''}</div>
    ${b.board >= 2 ? b.stocks.map(s=>streakHTML(s,day)).join('') : b.themes.map(g=>firstBoardHTML(g,day)).join('') + (b.unclassified.length ? `<div class="theme-group unclassified-group" data-unclassified-date="${day.date}"><div class="group-head"><span class="group-title">未归类</span><span class="group-count">${b.unclassified.length}</span><span class="unclassified-hint">在个股详情中添加题材</span></div><div class="stock-grid">${b.unclassified.map(s=>stockHTML(s,day.date)).join('')}</div></div>` : '')}</div>`;
}
function columnHTML(day, focus, index, count) {
  const single=count===1,first=day.groups.filter(b=>b.board===1),higher=day.groups.filter(b=>b.board>=2);
  const content=single?`<div class="single-day-content">
    <div class="day-body single-day-first" data-scroll-date="${day.date}|first" role="region" aria-label="首板">${first.map(b=>bandHTML(b,day)).join('') || '<div class="no-results">当日没有首板股票</div>'}</div>
    <div class="day-body single-day-higher" data-scroll-date="${day.date}|higher" role="region" aria-label="二板及以上与每日复盘">${higher.map(b=>bandHTML(b,day)).join('') || '<div class="no-results">当日没有二板及以上股票</div>'}${dailyReviewHTML(day)}</div>
    </div>`:`<div class="day-body" data-scroll-date="${day.date}">${day.groups.map(b=>bandHTML(b,day)).join('')}${dailyReviewHTML(day)}</div>`;
  return `<section class="day-column ${focus ? 'focus-day' : ''}" data-date="${day.date}">
    <header class="day-header" title="左右拖动，逐日回溯"><div class="day-date">${shortDate(day.date)}<small>周${weekday(day.date)}</small>${focus ? '<span class="focus-tag">复盘日</span>' : ''}</div>
      <div class="day-meta"><span><b>${day.stocks.length}</b> 只个股</span><span><b>${day.themeOrder.length}</b> 个题材</span><span>最高 <b>${day.groups[0]?.board || 0}</b> 板</span></div>
    </header>${content}
    ${index < count-1 ? `<div class="column-resizer" role="separator" aria-orientation="vertical" aria-label="调整${shortDate(day.date)}列宽" tabindex="0" data-resize-index="${index}" title="左右拖动调整列宽；双击恢复默认；方向键微调"></div>` : ''}
  </section>`;
}
function render() {
  if (!state) return;
  if (resizing || noteResizing) return;
  if(noteComposing){renderAfterComposition=true;return;}
  hideThemeLadder();
  const editing=captureNoteEditing();
  const scrolls = new Map([...document.querySelectorAll('[data-scroll-date]')].map(e => [e.dataset.scrollDate, e.scrollTop]));
  const sidebarScroll = $('.theme-list')?.scrollTop || 0;
  const days = visibleDays(); const count = days.length; const focus = days.at(-1);
  const sort = state.preferences.sorts.global || {field:'firstLimit',direction:'asc'};
  const sizes = columnWeights(days,state.preferences).map(w=>`minmax(120px,${w}fr)`).join(' ');
  $('#app').innerHTML = `<div class="shell ${sidebarHidden ? 'collapsed' : ''} ${count >= 5 ? 'dense' : ''}">
    <header class="toolbar" aria-label="复盘工具栏">
        <button class="button subtle icon-button" data-action="sidebar" title="题材颜色" aria-label="题材侧栏">${icon('panel')}</button>
        ${undo.length ? `<button class="button subtle icon-button" data-action="undo" title="撤销上一次合并" aria-label="撤销合并">${icon('undo')}</button>` : ''}
        <input type="date" class="date-picker" id="datePicker" aria-label="复盘日期" value="${focus?.date || ''}" min="${model.days[0]?.date || ''}" max="${model.days.at(-1)?.date || ''}">
        <div class="nav-buttons"><button data-action="previous" aria-label="前一个交易日" ${anchor <= count-1 ? 'disabled' : ''}>‹</button><button data-action="next" aria-label="后一个交易日" ${anchor >= model.days.length-1 ? 'disabled' : ''}>›</button></div>
        <div class="spacer"></div>
        ${selected ? `<button class="selection-chip" data-action="clear-selection" data-theme-ladder="${esc(selected)}" data-ladder-date="${focus?.date || ''}" title="取消题材高亮；悬停查看近15日高度" style="--theme:${colorFor(selected,state.preferences)}"><span class="theme-dot"></span>${esc(selected)}<span>×</span></button>` : ''}
        ${selectedProvince ? `<button class="selection-chip" data-action="clear-selection" title="取消省份高亮" aria-label="取消省份高亮" style="--theme:${provinceColor(selectedProvince.province)}"><span class="theme-dot"></span>${shortDate(selectedProvince.date)} · ${esc(selectedProvince.province)}<span>×</span></button>` : ''}
        <div class="global-sort"><select id="globalSort" aria-label="统一排序" title="所有日期统一排序">${SORTS.map(([value,label]) => `<option value="${value}" ${sort.field === value ? 'selected' : ''}>${label}</option>`).join('')}</select><button data-action="sort-direction" class="sort-direction" title="${sort.direction === 'asc' ? '当前升序，点击降序' : '当前降序，点击升序'}" aria-label="统一排序方向">${sort.direction === 'asc' ? '↑' : '↓'}</button></div>
        <label class="day-count">显示<select id="dayCount" aria-label="显示天数">${Array.from({length:7},(_,i)=>`<option value="${i+1}" ${state.preferences.days===i+1?'selected':''}>${i+1} 天</option>`).join('')}</select></label>
        <button class="button export-image" data-action="export-image" title="导出当前看板的完整长图；股票名称仅保留前两个字">${icon('download')}<span>导出长图</span></button>
        <button class="button subtle icon-button" data-action="settings" title="数据设置" aria-label="数据设置">${icon('settings')}</button>
        <div class="latest-actions"><button class="button" data-action="latest">最新交易日</button><button class="button primary icon-button" data-action="upload" title="导入 Excel" aria-label="导入 Excel">${icon('plus')}</button></div>
    </header>
    <div class="workspace">${sidebarHTML()}<main class="main">
      ${days.some(d=>!d.complete) ? '<div class="warn-banner">部分表格数量不一致，相关日期暂不用于判定连板结束。请查看数据状态。</div>' : ''}
      ${count ? `<div class="board" id="board" style="grid-template-columns:${sizes};--count:${count}">${days.map((d,i)=>columnHTML(d,i===count-1,i,count)).join('')}</div>` : '<div class="empty"><h2>还没有复盘数据</h2><p>拖入板块矩阵 Excel，或点击右上角的 ＋。</p></div>'}
    </main></div></div>`;
  for (const el of document.querySelectorAll('[data-scroll-date]')) el.scrollTop = scrolls.get(el.dataset.scrollDate) || 0;
  if ($('.theme-list')) $('.theme-list').scrollTop = sidebarScroll;
  sessionStorage.setItem('review.anchor', focus?.date || '');
  restoreNoteEditing(editing);
}
function modal(title, content, after) {
  hideTip();hideThemeLadder();const el = $('#modal');
  el.innerHTML = `<div class="modal-head"><h2>${esc(title)}</h2><button data-close-modal aria-label="关闭">×</button></div><div class="modal-body">${content}</div>`;
  if (!el.open) el.showModal(); after?.(el);
}
function settings() {
  modal('问财数据设置', `<p>使用同花顺问财补充每个交易日的个股指标。Excel 中的题材和板数继续保留。</p>
    <div class="modal-status">${state.configured ? '已配置密钥，可补充数据。' : '尚未配置密钥。'} 密钥仅在本次服务运行期间保留。</div>
    <form id="credentialForm"><label class="field">问财 API Key<input type="password" name="key" autocomplete="off" placeholder="粘贴单个密钥" required></label>
      <div class="form-error" id="keyError"></div><button class="button" type="submit">使用此密钥</button></form>
    <div class="modal-status" id="modalJob">${state.job?.running ? `正在补充 ${state.job.date || ''}（${state.job.done}/${state.job.total}）` : '已获取的数据保存在本机，回溯和悬停无需重复查询。'}</div>
    <div class="modal-actions"><button class="button" data-action="data-report">查看各日状态</button><button class="button primary" id="syncAll" ${!state.configured || state.job?.running ? 'disabled' : ''}>补充全部日期</button></div>`, el => {
      el.querySelector('#credentialForm').onsubmit = async e => {
        e.preventDefault(); const form = e.currentTarget;
        try { await api('/api/credential',{key:new FormData(form).get('key')}); state.configured=true; form.reset(); settings(); toast('已配置本次运行使用的问财密钥'); }
        catch (err) { $('#keyError').textContent=err.message; }
      };
      el.querySelector('#syncAll').onclick = () => syncDates(model.days.map(d=>d.date));
    });
}
function dataReport() {
  modal('导入与行情状态', `<p>股票数量按唯一股票计算，同一只股票出现在多个题材中不会重复计数。</p><table class="data-table"><thead><tr><th>日期</th><th>个股</th><th>行情 / 导入情况</th><th></th></tr></thead><tbody>${model.days.map(d=>`<tr><td>${d.date}</td><td>${d.stocks.length}</td><td>${esc(d.dataMessage)}${!d.complete?'<br>'+esc(d.importWarnings.join('；')):''}</td><td><button class="link" data-sync-date="${d.date}" ${state.job?.running ? 'disabled' : ''}>${d.dataStatus === 'ready' ? '刷新' : '补充'}</button></td></tr>`).join('')}</tbody></table><div class="modal-actions"><button class="button" data-action="settings">数据设置</button><button class="button primary" data-close-modal>完成</button></div>`);
}
async function syncDates(dates) {
  if (!state.configured) { settings(); return; }
  try { await api('/api/sync',{dates}); state.job={running:true,done:0,total:dates.length,errors:[]}; $('#modal').close(); render(); startPolling(); toast('已开始补充问财行情'); }
  catch(e) { toast(e.message); }
}
async function refreshState() {
  const revision = prefRevision; const fresh = await api('/api/state');
  if (state && (revision !== prefRevision || state.preferences)) fresh.preferences = state.preferences;
  state=fresh; updateModel(); render();
}
function startPolling() {
  clearTimeout(pollTimer);
  pollTimer=setTimeout(async()=>{
    try {
      const job=await api('/api/job'); const changed=job.done!==state.job?.done; state.job=job;
      if(changed || !job.running) await refreshState();
      else if($('#jobSummary')) $('#jobSummary').textContent=jobSummary();
      if($('#modalJob')) $('#modalJob').textContent=job.running?`正在补充 ${job.date || ''}（${job.done}/${job.total}）`:'本次补充已结束';
      if(job.running) startPolling(); else toast(job.errors.length?`数据补充结束，${job.errors.length} 个日期需要重试`:'问财数据补充完成');
    } catch(e) { toast('连接暂时中断，正在重试'); startPolling(); }
  },2000);
}
function undoMerge() {
  const last=undo.pop(); if(!last)return;
  state.preferences.merges[last.date]=last.before; save(); updateModel(); render(); toast(`已撤销 ${last.date} 的题材合并`);
}
function performMerge(date, source, target) {
  if(source===target)return;
  undo.push({date,before:structuredClone(state.preferences.merges[date] || {})});
  state.preferences=mergeThemes(state.preferences,date,source,target);clearSelection();selected=target;sessionStorage.setItem('review.selected',selected);
  save(); updateModel(); render(); toast(`${shortDate(date)}：${source} 已合并到 ${target}`,'撤销',undoMerge);
}
function editNote(id) {
  const entry=state.preferences.manual.find(e=>e.id===id); if(!entry)return;
  modal('编辑手动记录',`<form id="editNote"><label class="field">${esc(entry.scope==='province'?`${entry.province}省份`:entry.theme)} · ${entry.date}<textarea name="text" maxlength="120" required>${esc(entry.text)}</textarea></label><div class="modal-actions"><button type="button" class="button" data-close-modal>取消</button><button class="button primary">保存</button></div></form>`,el=>{
    el.querySelector('form').onsubmit=e=>{e.preventDefault(); const text=new FormData(e.currentTarget).get('text').trim(); if(!text)return; entry.text=text;save();updateModel();render();el.close();toast('记录已更新');};
  });
}
function highlightStock(name,date) {
  const stock=model.days.find(d=>d.date===date)?.stocks.find(s=>s.name===name);if(!stock)return;
  const key=stockKey(stock), current=state.preferences.stockColors[key] || state.preferences.stockColors[normalizeName(name)] || '#f4cb69';
  const apply=color=>{if(color)state.preferences.stockColors[key]=color;else{delete state.preferences.stockColors[key];delete state.preferences.stockColors[normalizeName(name)];}save();render();};
  modal(`${name} · 高亮颜色`,`<p>同一只股票在各个日期使用同一种高亮颜色。</p><div class="highlight-options">${['#f4cb69','#ef9c98','#a9c4ef','#a9d7bd','#c7b0e5','#efbb8c'].map(c=>`<button class="highlight-swatch" data-highlight-choice="${c}" style="background:${c}" aria-label="使用${c}高亮颜色"></button>`).join('')}</div><label class="highlight-custom">自选颜色<input type="color" id="customHighlight" value="${esc(current)}"></label><div class="modal-actions"><button class="button" id="clearHighlight">清除高亮</button><button class="button primary" data-close-modal>完成</button></div>`,el=>{
    el.querySelectorAll('[data-highlight-choice]').forEach(button=>button.onclick=()=>{apply(button.dataset.highlightChoice);el.close();});
    el.querySelector('#customHighlight').oninput=e=>apply(e.target.value);
    el.querySelector('#clearHighlight').onclick=()=>{apply(null);el.close();};
  });
}
function performReorder(date,source,target,after=false) {
  const day=model.days.find(d=>d.date===date);if(!day || source===target)return;
  const shown=day.groups.find(g=>g.board===1)?.themes.map(g=>g.theme) || [],firstThemes=new Set(shown);let i=0;
  const currentOrder=day.themeOrder.map(theme=>firstThemes.has(theme)?shown[i++]:theme);
  state.preferences.themeOrders[date]=reorderThemes(currentOrder,source,target,after);
  state.preferences.sorts.firstBoard ||= {};state.preferences.sorts.firstBoard[date]={field:'manual',direction:'desc'};
  save();updateModel();render();
}
function saveColumnWidths(widths) {
  const days=visibleDays(), average=widths.reduce((a,b)=>a+b,0)/widths.length;
  days.forEach((d,i)=>{state.preferences.columnWidths[d.date]=widths[i]/average;});save();
}
function fmt(value, kind='number') {
  if(value==null || value==='--' || value==='')return '暂无数据';
  if(kind==='time')return String(value);
  const n=Number(value); if(!Number.isFinite(n))return '暂无数据';
  if(kind==='money')return Math.abs(n)>=1e8 ? `${(n/1e8).toFixed(2)} 亿` : Math.abs(n)>=1e4 ? `${(n/1e4).toFixed(2)} 万` : `${n.toFixed(2)} 元`;
  if(kind==='percent')return `${n.toFixed(2)}%`;
  if(kind==='price')return `${n.toFixed(2)} 元`;
  return n.toFixed(2);
}
function captureStockThemeRules(name,date) {
  const stock=model.days.find(d=>d.date===date)?.stocks.find(s=>s.name===name);
  const episode=model.episodes.find(ep=>ep.id===stock?.episode);
  const entries=(episode?.identities || [{date,name:normalizeName(name)}]).flatMap(entry=>
    ['$stockThemes','$stockThemeRemovals'].map(kind=>({...entry,kind,value:structuredClone(state.preferences.merges?.[kind]?.[entry.date]?.[entry.name])})));
  return ()=>{
    for(const entry of entries){
      state.preferences.merges[entry.kind] ||= {};state.preferences.merges[entry.kind][entry.date] ||= {};
      if(entry.value===undefined)delete state.preferences.merges[entry.kind][entry.date][entry.name];
      else state.preferences.merges[entry.kind][entry.date][entry.name]=entry.value;
    }
  };
}
function refreshStockThemeView(name,date,position) {
  updateModel();save();render();
  requestAnimationFrame(()=>{
    const button=[...document.querySelectorAll('[data-stock]')].find(el=>el.dataset.stock===name && el.dataset.stockDate===date);
    if(button){showTip(button,position);$('#tooltip .tip-remove-theme, #tooltip .tip-add-theme')?.focus({preventScroll:true});}
    else hideTip();
  });
}
function deleteStockTheme(name,date,theme) {
  try {
    const restore=captureStockThemeRules(name,date),rect=$('#tooltip').getBoundingClientRect(),position={left:rect.left,top:rect.top};
    const next=removeStockTheme(state,date,name,theme);if(next===state.preferences)return;
    state.preferences=next;refreshStockThemeView(name,date,position);
    toast(`已移除${name}的「${theme}」`,'撤销',()=>{restore();refreshStockThemeView(name,date,position);toast('已撤销此次题材移除');});
  }catch(error){toast(error.message);}
}
function addStockThemeDialog(name,date) {
  const stock=model.days.find(d=>d.date===date)?.stocks.find(s=>s.name===name);if(!stock)return;
  const catalog=state.preferences.themeOrders.$catalog || [],allThemes=buildThemeCatalog(state,Infinity);
  const hasTheme=theme=>stock.themes.some(t=>themeKey(t)===themeKey(resolveTheme(theme,date,state.preferences)));
  modal(`为${name}添加题材`,`<form id="stockThemeForm" class="theme-picker">
    <p class="theme-picker-context">${date} · 添加后，本轮连板各日同步显示</p>
    <div class="theme-picker-current"><span>已归属</span>${stock.themes.map(t=>`<span class="theme-picker-tag" style="--theme:${colorFor(t,state.preferences)}">${esc(t)}</span>`).join('')}</div>
    <div class="theme-picker-search">${icon('search')}<input id="stockThemeQuery" role="combobox" aria-label="搜索或创建题材" aria-controls="stockThemeResults" aria-expanded="true" aria-autocomplete="list" autocomplete="off" maxlength="40" placeholder="输入题材关键词，如芯片、机器人"></div>
    <div class="theme-picker-caption"><span id="stockThemeResultLabel">最近出现的题材</span><span>最多保留 200 个</span></div>
    <div id="stockThemeResults" class="theme-picker-results" role="listbox" aria-label="匹配题材"></div>
    <div class="theme-picker-selection" id="stockThemeSelection" role="status">请选择一个题材</div>
    <div class="modal-actions"><button type="button" class="button" data-close-modal>取消</button><button type="submit" class="button primary" id="confirmStockTheme" disabled>确认添加</button></div>
  </form>`,el=>{
    const input=el.querySelector('#stockThemeQuery'),list=el.querySelector('#stockThemeResults'),confirm=el.querySelector('#confirmStockTheme'),status=el.querySelector('#stockThemeSelection');
    let choice=null,rows=[],active=-1;
    const choose=index=>{const row=rows[index];if(!row || row.added)return;choice=row;active=-1;draw();};
    const draw=()=>{
      const query=normalizeTheme(input.value),key=themeKey(query),exact=allThemes.find(t=>themeKey(t.name)===key);
      const matches=catalog.filter(t=>themeKey(t.name).includes(key));
      // An exact historical match remains reusable even after leaving the recent 200.
      if(exact && !matches.some(t=>themeKey(t.name)===key))matches.unshift(exact);
      rows=matches.map(t=>({name:t.name,added:hasTheme(t.name),create:false}));
      if(query && !exact)rows.push({name:query,added:false,create:true});
      el.querySelector('#stockThemeResultLabel').textContent=query?`匹配到 ${matches.length} 个题材`:'最近出现的题材';
      list.innerHTML=rows.map((r,i)=>`<button type="button" class="theme-picker-option ${r.create?'create-theme':''} ${active===i?'keyboard-active':''}" role="option" id="stockThemeOption${i}" data-theme-option="${i}" aria-selected="${choice?.name===r.name && choice?.create===r.create}" ${r.added?'disabled aria-disabled="true"':''}>
        <span class="theme-picker-dot" style="--theme:${colorFor(r.name,state.preferences)}">${r.create?'+':''}</span><span>${r.create?`创建新题材「${esc(r.name)}」`:esc(r.name)}</span><small>${r.added?'已添加':r.create?'新题材':choice?.name===r.name?'已选择':''}</small></button>`).join('') || '<div class="theme-picker-empty">还没有题材，输入名称即可创建。</div>';
      if(active>=0)input.setAttribute('aria-activedescendant',`stockThemeOption${active}`);else input.removeAttribute('aria-activedescendant');
      confirm.disabled=!choice;confirm.textContent=choice?.create?'确认创建并添加':'确认添加';
      status.textContent=choice?`${choice.create?'将创建并添加':'将添加'}：${choice.name}`:query && !matches.length?'没有找到匹配题材，可选择上方的新建选项。':'请选择一个题材';
    };
    input.addEventListener('input',()=>{choice=null;active=-1;const exact=allThemes.find(t=>themeKey(t.name)===themeKey(input.value));if(exact && !hasTheme(exact.name))choice={name:exact.name,create:false};draw();});
    list.addEventListener('click',e=>{const option=e.target.closest('[data-theme-option]');if(option)choose(Number(option.dataset.themeOption));});
    input.addEventListener('keydown',e=>{
      if(e.isComposing)return;
      if(['ArrowDown','ArrowUp'].includes(e.key)){
        e.preventDefault();const available=rows.map((r,i)=>r.added?-1:i).filter(i=>i>=0);if(!available.length)return;
        const pos=available.indexOf(active);active=available[(pos+(e.key==='ArrowDown'?1:pos<0?0:-1)+available.length)%available.length];draw();el.querySelector(`#stockThemeOption${active}`)?.scrollIntoView({block:'nearest'});
      }else if(e.key==='Enter' && active>=0){e.preventDefault();choose(active);}
    });
    el.querySelector('form').addEventListener('submit',e=>{
      e.preventDefault();if(!choice)return;
      try {
        const restore=captureStockThemeRules(name,date);
        const next=assignStockTheme(state,date,name,choice.name);
        if(next===state.preferences){status.textContent='这只股票已属于该题材。';confirm.disabled=true;return;}
        state.preferences=next;
        state.preferences.themeOrders.$catalog=[{name:choice.name,seenAt:new Date().toISOString()},...catalog];
        updateModel();save();el.close();render();
        const added=choice.name;
        toast(`已将${name}加入「${added}」`,'撤销',()=>{
          restore();save();updateModel();render();toast('已撤销此次题材添加');
        });
      }catch(error){status.textContent=error.message;}
    });
    draw();input.focus();
  });
}
function showTip(button,position=null) {
  if($('#modal').open)return;clearTimeout(tipHideTimer);hideThemeLadder();
  const day=model.days.find(d=>d.date===button.dataset.stockDate);const stock=day?.stocks.find(s=>s.name===button.dataset.stock);if(!stock)return;
  const m=stock.metrics;const fields=[['首次涨停',m.firstLimit,'time'],['最后涨停',m.lastLimit,'time'],['自由流通市值',m.floatCap,'money'],['自由流通股占比',m.floatRatio,'percent'],[m.priceBasis || '收盘价',m.price,'price'],['成交额',m.amount,'money'],['封成比',m.sealRatio,'percent']];
  const tip=$('#tooltip'); tip.innerHTML=`<div class="tip-title">${esc(stock.name)}<span class="code">${esc(m.code || '代码待补充')}</span><span class="tip-board">${stock.board===1?'首板':`${stock.board} 板`}</span></div>
    <div class="tip-date"><span>${day.date}</span>${provinceTipToken(stock,day.date)}<span>本轮最高 ${stock.episodeMax} 板</span></div><div class="tip-themes">${stock.themes.map(t=>`<span class="tip-theme" style="--theme:${colorFor(t,state.preferences)}">${esc(t)}<button class="tip-remove-theme" data-remove-stock-theme="${esc(stock.name)}" data-remove-theme-date="${day.date}" data-remove-theme="${esc(t)}" aria-label="移除${esc(stock.name)}的${esc(t)}题材" title="从${esc(stock.name)}本轮连板中移除${esc(t)}">${icon('minus')}</button></span>`).join('') || '<span class="tip-unclassified">未归类</span>'}<button class="tip-add-theme" data-add-stock-theme="${esc(stock.name)}" data-add-theme-date="${day.date}" aria-label="为${esc(stock.name)}添加题材" title="添加题材">${icon('plus')}</button></div>
    <div class="tip-grid">${fields.map(([label,value,type])=>`<div class="tip-metric"><label>${label}</label><strong>${esc(fmt(value,type))}</strong></div>`).join('')}</div>
    <div class="tip-foot ${!m.firstLimit?'warn':''}">${Object.keys(m).length ? '数据来源：同花顺问财' : '行情尚未补充，题材与板数来自导入表格'}</div>`;
  tip.hidden=false; const rect=button.getBoundingClientRect(); const box=tip.getBoundingClientRect();
  tip.style.left=`${Math.max(12,Math.min(position?.left ?? rect.left,innerWidth-box.width-12))}px`;
  tip.style.top=`${position ? Math.max(12,Math.min(position.top,innerHeight-box.height-12)) : rect.bottom+8+box.height<innerHeight ? rect.bottom+8 : Math.max(12,rect.top-box.height-8)}px`;
}
function hideTip(){clearTimeout(tipTimer);clearTimeout(tipHideTimer);$('#tooltip').hidden=true;}
function scheduleHideTip(){clearTimeout(tipTimer);clearTimeout(tipHideTimer);tipHideTimer=setTimeout(()=>{const tip=$('#tooltip');if(!tip.matches(':hover') && !tip.contains(document.activeElement))hideTip();},240);}

async function uploadFiles(fileList) {
  const files=[...fileList].filter(f=>/\.xlsx?$/i.test(f.name));
  if(!files.length){toast('请选择 .xls 或 .xlsx 板块矩阵');return;}
  if(files.some(f=>f.size>10_000_000) || files.reduce((n,f)=>n+f.size,0)>14_000_000){toast('请分批导入，每批总大小不超过 14 MB');return;}
  const duplicate=files.filter(f=>state.days.some(d=>f.name.includes(d.date)));
  if(duplicate.length){
    modal('更新已有日期',`<p>以下文件对应的日期已经导入。更新会替换该日的原始股票名单，并保留颜色、手动记录、排序和题材合并设置。</p><p>${duplicate.map(f=>esc(f.name)).join('<br>')}</p><div class="modal-actions"><button class="button" data-close-modal>取消</button><button class="button primary" id="confirmUpload">更新这些日期</button></div>`,el=>{el.querySelector('#confirmUpload').onclick=()=>{el.close();performUpload(files);};});
  }else await performUpload(files);
}
async function performUpload(files) {
  try {
    toast('正在导入并整理表格…');
    const encoded=await Promise.all(files.map(f=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve({name:f.name,content:reader.result.split(',')[1]});reader.onerror=()=>reject(new Error('无法读取文件'));reader.readAsDataURL(f);}))); 
    const result=await api('/api/import',{files:encoded});await refreshState();anchor=model.days.length-1;render();
    toast(`已导入 ${result.dates.length} 个交易日`);if(state.job?.running)startPolling();
  }catch(e){toast(e.message);}
}

document.addEventListener('click',e=>{
  if(!e.target.closest('#tooltip,[data-stock]'))hideTip();
  const el=e.target.closest('button');if(!el)return;
  if(el.dataset.removeStockTheme){deleteStockTheme(el.dataset.removeStockTheme,el.dataset.removeThemeDate,el.dataset.removeTheme);return;}
  if(el.dataset.addStockTheme){addStockThemeDialog(el.dataset.addStockTheme,el.dataset.addThemeDate);return;}
  if(el.dataset.stock){showTip(el);$('#tooltip [data-add-stock-theme]')?.focus({preventScroll:true});return;}
  if(el.hasAttribute('data-close-modal')){$('#modal').close();return;}
  if(el.dataset.highlightStock){highlightStock(el.dataset.highlightStock,el.dataset.highlightDate);return;}
  if(el.dataset.themeSortDirection){const date=el.dataset.themeSortDirection,sort=state.preferences.sorts.firstBoard?.[date];if(sort && sort.field!=='manual'){sort.direction=sort.direction==='asc'?'desc':'asc';save();updateModel();render();}return;}
  if(el.dataset.themeSelect){showTheme(el.dataset.themeSelect);return;}
  if(el.dataset.provinceSelect){showProvince(el.dataset.provinceSelect,el.dataset.provinceDate);return;}
  if(el.dataset.expand){expanded.has(el.dataset.expand)?expanded.delete(el.dataset.expand):expanded.add(el.dataset.expand);hideTip();render();return;}
  if(el.dataset.syncDate){syncDates([el.dataset.syncDate]);return;}
  if(el.dataset.editNote){editNote(el.dataset.editNote);return;}
  if(el.dataset.deleteNote){const prev=structuredClone(state.preferences.manual);state.preferences.manual=prev.filter(n=>n.id!==el.dataset.deleteNote);save();updateModel();render();toast('手动记录已删除','撤销',()=>{state.preferences.manual=prev;save();updateModel();render();});return;}
  switch(el.dataset.action){
    case 'upload':$('#fileInput').click();break;
    case 'settings':settings();break;
    case 'data-report':dataReport();break;
    case 'previous':navigate(-1);break;
    case 'next':navigate(1);break;
    case 'latest':anchor=model.days.length-1;render();break;
    case 'export-image':exportLongImage();break;
    case 'sidebar':if(innerWidth<760)mobileSidebar=!mobileSidebar;else sidebarHidden=!sidebarHidden;render();break;
    case 'undo':undoMerge();break;
    case 'sort-direction':{const s=state.preferences.sorts.global || {field:'firstLimit',direction:'asc'};state.preferences.sorts.global={...s,direction:s.direction==='asc'?'desc':'asc'};save();updateModel();render();break;}
    case 'clear-selection':clearSelection();render();break;
  }
});
document.addEventListener('input',e=>{
  const editor=e.target.closest('[data-inline-note]');if(editor){saveNote(editor);rememberNoteRange();positionNoteToolbar();return;}
  if(e.target.id==='themeSearch'){
    search=e.target.value;const pos=e.target.selectionStart;render();$('#themeSearch').focus();$('#themeSearch').setSelectionRange(pos,pos);
  }
});
document.addEventListener('change',e=>{
  const el=e.target;
  if(el.dataset.firstboardSort){state.preferences.sorts.firstBoard ||= {};state.preferences.sorts.firstBoard[el.dataset.firstboardSort]={field:el.value,direction:'desc'};save();updateModel();render();return;}
  if(el.id==='fileInput'){uploadFiles(el.files);el.value='';return;}
  if(el.id==='dayCount'){state.preferences.days=Number(el.value);save();render();return;}
  if(el.id==='datePicker'){
    const i=model.days.findLastIndex(d=>d.date<=el.value);if(i>=0){anchor=i;render();if(model.days[i].date!==el.value)toast('该日没有导入数据，已定位到之前最近的交易日');}return;
  }
  if(el.dataset.color || el.dataset.persist){const theme=el.dataset.color||el.dataset.persist;const prev=state.preferences.colors[theme]||{color:colorFor(theme,state.preferences),persistent:false};if(el.dataset.color)prev.color=el.value;else prev.persistent=el.checked;state.preferences.colors[theme]=prev;save();render();return;}
  if(el.id==='globalSort'){state.preferences.sorts.global={field:el.value,direction:['firstLimit','lastLimit','name'].includes(el.value)?'asc':'desc'};save();updateModel();render();}
});
document.addEventListener('submit',e=>{
  const form=e.target.closest('[data-note-theme],[data-note-province]');if(!form)return;e.preventDefault();
  const text=new FormData(form).get('text').trim();if(!text)return;
  const category=form.dataset.noteProvince ? {scope:'province',province:normalizeProvince(form.dataset.noteProvince)} : {theme:form.dataset.noteTheme};
  state.preferences.manual.push({id:crypto.randomUUID(),...category,date:form.dataset.noteDate,text,createdAt:new Date().toISOString().slice(11,23)});
  save();updateModel();render();toast('已添加记录，超过 6 条时替换最早的一条');
});
document.addEventListener('pointerover',e=>{const el=e.target.closest('[data-stock]');if(el){clearTimeout(tipHideTimer);clearTimeout(tipTimer);tipTimer=setTimeout(()=>{if(el.isConnected && el.matches(':hover'))showTip(el);},120);}});
document.addEventListener('pointerout',e=>{const stock=e.target.closest('[data-stock]');if(stock && !stock.contains(e.relatedTarget))scheduleHideTip();});
document.addEventListener('focusin',e=>{if(e.target.matches('[data-stock]'))showTip(e.target);});
document.addEventListener('focusout',e=>{if(e.target.matches('[data-stock]') || e.target.closest('#tooltip'))scheduleHideTip();});
document.addEventListener('pointerover',e=>{const source=e.target.closest('[data-theme-ladder]');if(source && !source.contains(e.relatedTarget)){clearTimeout(ladderHideTimer);clearTimeout(ladderTimer);ladderTimer=setTimeout(()=>{if(source.isConnected && source.matches(':hover'))showThemeLadder(source);},180);}});
document.addEventListener('pointerout',e=>{const source=e.target.closest('[data-theme-ladder]');if(source && !source.contains(e.relatedTarget))scheduleHideThemeLadder();});
document.addEventListener('focusin',e=>{const source=e.target.closest('[data-theme-ladder]');if(source)showThemeLadder(source);});
document.addEventListener('focusout',e=>{if(e.target.closest('[data-theme-ladder],#themeLadder'))scheduleHideThemeLadder();});
$('#tooltip').setAttribute('role','dialog');$('#tooltip').setAttribute('aria-label','个股详情');
$('#tooltip').addEventListener('pointerenter',()=>clearTimeout(tipHideTimer));$('#tooltip').addEventListener('pointerleave',scheduleHideTip);
document.addEventListener('scroll',hideTip,true);window.addEventListener('resize',hideTip);
$('#themeLadder').addEventListener('pointerenter',()=>{clearTimeout(ladderTimer);clearTimeout(ladderHideTimer);});$('#themeLadder').addEventListener('pointerleave',scheduleHideThemeLadder);
$('#themeLadder').addEventListener('pointerover',e=>{const cell=e.target.closest('.ladder-cell');if(cell && !cell.contains(e.relatedTarget))inspectLadderCell(cell);});
$('#themeLadder').addEventListener('focusin',e=>{const cell=e.target.closest('.ladder-cell');if(cell)inspectLadderCell(cell);});
document.addEventListener('scroll',e=>{if(!e.target.closest?.('#themeLadder'))hideThemeLadder();},true);window.addEventListener('resize',hideThemeLadder);
document.addEventListener('focusin',e=>{const editor=e.target.closest('[data-inline-note]');if(editor){if(noteEditor!==editor)noteRange=null;noteEditor=editor;hideTip();rememberNoteRange();updateNoteToolbar();}});
document.addEventListener('focusout',()=>setTimeout(()=>{if(!document.activeElement?.closest('[data-inline-note],#noteToolbar'))hideNoteToolbar();},0));
document.addEventListener('selectionchange',()=>{if(noteEditor){rememberNoteRange();updateNoteToolbar();}});
document.addEventListener('scroll',()=>{if(noteEditor)positionNoteToolbar();},true);window.addEventListener('resize',()=>{if(noteEditor)positionNoteToolbar();});
document.addEventListener('compositionstart',e=>{if(e.target.closest('[data-inline-note]'))noteComposing=true;});
document.addEventListener('compositionend',e=>{if(e.target.closest('[data-inline-note]')){noteComposing=false;saveNote(e.target.closest('[data-inline-note]'));if(renderAfterComposition){renderAfterComposition=false;render();}}});
document.addEventListener('paste',e=>{
  const editor=e.target.closest('[data-inline-note]');if(!editor)return;e.preventDefault();
  const html=e.clipboardData.getData('text/html'),text=e.clipboardData.getData('text/plain');
  document.execCommand('insertHTML',false,html?cleanNoteHTML(html):esc(text).replace(/\r?\n/g,'<br>'));saveNote(editor);
});
document.addEventListener('keydown',e=>{
  if(e.target.closest('[data-inline-note]')){
    if(!e.isComposing && (e.metaKey || e.ctrlKey) && !e.altKey && ['b','i','u'].includes(e.key.toLowerCase())){e.preventDefault();rememberNoteRange();formatNote({b:'bold',i:'italic',u:'underline'}[e.key.toLowerCase()]);}
    if(e.key==='Escape'){e.preventDefault();e.target.closest('[data-inline-note]').blur();hideNoteToolbar();}
    return;
  }
  if(e.target.closest('#noteToolbar'))return;
  if(e.target.matches('[data-resize-stock-note]') && ['ArrowLeft','ArrowRight'].includes(e.key)){
    e.preventDefault();const el=e.target,size=stockNoteSize(),width=el.closest('.streak-row').getBoundingClientRect().width;
    size.width=Math.max(.28,Math.min(.78,size.width+(e.key==='ArrowLeft'?16:-16)/width));
    storeStockNoteSize(size);render();[...document.querySelectorAll('[data-resize-stock-note]')].find(x=>x.dataset.resizeStockNote===el.dataset.resizeStockNote && x.dataset.resizeDate===el.dataset.resizeDate)?.focus();return;
  }
  if(e.target.matches('[data-resize-note]') && ['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();const el=e.target,theme=el.dataset.resizeNote,date=el.dataset.resizeDate,size=themeNoteSize(),width=el.closest('.theme-content').getBoundingClientRect().width;
    if(e.key==='ArrowLeft' || e.key==='ArrowRight')size.width=Math.max(.15,Math.min(.75,size.width+(e.key==='ArrowLeft'?16:-16)/width));
    else if(el.dataset.resizeAxis==='both')size.height=Math.max(52,Math.min(600,size.height+(e.key==='ArrowDown'?16:-16)));
    storeThemeNoteSize(size);render();[...document.querySelectorAll('[data-resize-note]')].find(x=>x.dataset.resizeNote===theme && x.dataset.resizeDate===date && x.dataset.resizeAxis===el.dataset.resizeAxis)?.focus();return;
  }
  if(e.target.matches('[data-resize-index]') && ['ArrowLeft','ArrowRight'].includes(e.key)){
    e.preventDefault();e.stopPropagation();const i=Number(e.target.dataset.resizeIndex),widths=[...document.querySelectorAll('.day-column')].map(x=>x.getBoundingClientRect().width);saveColumnWidths(resizeColumns(widths,i,e.key==='ArrowLeft'?-16:16));render();document.querySelector(`[data-resize-index="${i}"]`)?.focus();return;
  }
  if(e.target.dataset.orderTheme && ['ArrowUp','ArrowDown'].includes(e.key)){
    e.preventDefault();const {orderTheme:theme,orderDate:date}=e.target.dataset,day=model.days.find(d=>d.date===date),order=day.groups.find(g=>g.board===1).themes.map(g=>g.theme),index=order.indexOf(theme),target=order[index+(e.key==='ArrowUp'?-1:1)];if(target){performReorder(date,theme,target,e.key==='ArrowDown');[...document.querySelectorAll('[data-order-theme]')].find(el=>el.dataset.orderTheme===theme && el.dataset.orderDate===date)?.focus();}return;
  }
  if(e.key==='Escape'){hideTip();hideThemeLadder();clearSelection();render();return;}
  if(e.target.matches('input,textarea,select') || $('#modal').open)return;
  if(e.key==='ArrowLeft'){e.preventDefault();navigate(-1);}if(e.key==='ArrowRight'){e.preventDefault();navigate(1);}
});
document.addEventListener('dragstart',e=>{
  const head=e.target.closest('[data-order-theme],[data-drag-theme]');if(!head)return;
  dragging={theme:head.dataset.orderTheme || head.dataset.dragTheme,date:head.dataset.orderDate || head.dataset.dragDate,mode:head.dataset.orderTheme?'order':'merge'};e.dataTransfer.effectAllowed='move';e.dataTransfer.setData('text/plain',JSON.stringify(dragging));head.closest('[data-group-theme]').classList.add('dragging');hideTip();hideThemeLadder();
});
document.addEventListener('dragover',e=>{
  if(dragging){const group=e.target.closest(dragging.mode==='order'?'.theme-group':'[data-group-theme]');if(group && group.dataset.groupDate===dragging.date && group.dataset.groupTheme!==dragging.theme){e.preventDefault();e.dataTransfer.dropEffect='move';document.querySelectorAll('.drag-over,.order-before,.order-after').forEach(x=>x.classList.remove('drag-over','order-before','order-after'));if(dragging.mode==='order'){const r=group.getBoundingClientRect();group.classList.add(e.clientY>r.top+r.height/2?'order-after':'order-before');}else group.classList.add('drag-over');}}
  else if([...e.dataTransfer.types].includes('Files')){e.preventDefault();if(!$('.drop-overlay')){const overlay=document.createElement('div');overlay.className='drop-overlay';overlay.innerHTML='<h2>松开，导入每日复盘</h2><p>支持一次导入多个 Excel 板块矩阵</p>';document.body.append(overlay);}}
});
document.addEventListener('dragleave',e=>{const group=e.target.closest('[data-group-theme]');if(group && !group.contains(e.relatedTarget))group.classList.remove('drag-over','order-before','order-after');if(!e.relatedTarget)$('.drop-overlay')?.remove();});
document.addEventListener('drop',e=>{
  $('.drop-overlay')?.remove();
  const editor=e.target.closest('[data-inline-note]');
  if(editor && !dragging && !e.dataTransfer.files.length){e.preventDefault();editor.focus();const range=document.caretRangeFromPoint(e.clientX,e.clientY);if(range && editor.contains(range.startContainer)){const selection=getSelection();selection.removeAllRanges();selection.addRange(range);}document.execCommand('insertText',false,e.dataTransfer.getData('text/plain'));saveNote(editor);return;}
  if(dragging){e.preventDefault();const group=e.target.closest(dragging.mode==='order'?'.theme-group':'[data-group-theme]');if(group){if(group.dataset.groupDate===dragging.date){if(dragging.mode==='order'){const r=group.getBoundingClientRect();performReorder(dragging.date,dragging.theme,group.dataset.groupTheme,e.clientY>r.top+r.height/2);}else performMerge(dragging.date,dragging.theme,group.dataset.groupTheme);}else toast('请在同一个交易日内拖动题材');}dragging=null;}
  else if(e.dataTransfer.files.length){e.preventDefault();uploadFiles(e.dataTransfer.files);}
  clearDragStyles();
});
function clearDragStyles(){document.querySelectorAll('.drag-over,.dragging,.order-before,.order-after').forEach(x=>x.classList.remove('drag-over','dragging','order-before','order-after'));}
document.addEventListener('dragend',()=>{dragging=null;clearDragStyles();});
document.addEventListener('contextmenu',e=>{const stock=e.target.closest('[data-stock]');if(stock){e.preventDefault();highlightStock(stock.dataset.stock,stock.dataset.stockDate);}});
document.addEventListener('dblclick',e=>{if(e.target.closest('[data-resize-index]')){for(const d of visibleDays())delete state.preferences.columnWidths[d.date];save();render();}});
document.addEventListener('pointerdown',e=>{
  const stockNoteHandle=e.target.closest('[data-resize-stock-note]');
  if(stockNoteHandle && e.button===0){
    e.preventDefault();gesture=null;hideTip();hideThemeLadder();const row=stockNoteHandle.closest('.streak-row'),pane=stockNoteHandle.closest('.stock-note-pane');
    noteResizing={kind:'stock',id:e.pointerId,x:e.clientX,row,width:row.getBoundingClientRect().width,paneWidth:pane.getBoundingClientRect().width,key:stockNoteHandle.dataset.resizeStockNote,date:stockNoteHandle.dataset.resizeDate};
    stockNoteHandle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-note');return;
  }
  const noteHandle=e.target.closest('[data-resize-note]');
  if(noteHandle && e.button===0){
    e.preventDefault();gesture=null;hideTip();hideThemeLadder();const content=noteHandle.closest('.theme-content'),pane=noteHandle.closest('.theme-note-pane');
    noteResizing={kind:'theme',id:e.pointerId,x:e.clientX,y:e.clientY,content,width:content.getBoundingClientRect().width,paneWidth:pane.getBoundingClientRect().width,paneHeight:pane.getBoundingClientRect().height,theme:noteHandle.dataset.resizeNote,date:noteHandle.dataset.resizeDate,axis:noteHandle.dataset.resizeAxis};
    noteHandle.setPointerCapture(e.pointerId);document.body.classList.add('resizing-note');return;
  }
  const separator=e.target.closest('[data-resize-index]');
  if(separator && e.button===0){e.preventDefault();gesture=null;hideTip();hideThemeLadder();resizing={index:Number(separator.dataset.resizeIndex),x:e.clientX,id:e.pointerId,widths:[...document.querySelectorAll('.day-column')].map(x=>x.getBoundingClientRect().width)};separator.setPointerCapture(e.pointerId);document.body.classList.add('resizing-columns');return;}
  if(e.button!==0 || e.target.closest('button,input,select,textarea,[contenteditable="true"],#noteToolbar,[draggable="true"]'))return;
  if(e.target.closest('.board'))gesture={x:e.clientX,y:e.clientY,id:e.pointerId};
});
document.addEventListener('pointermove',e=>{
  if(noteResizing && noteResizing.id===e.pointerId){const r=noteResizing;
    if(r.kind==='stock'){
      r.next={width:Math.max(.28,Math.min(.78,(r.paneWidth-(e.clientX-r.x))/r.width))};applyStockNoteSize(r.next);return;
    }
    r.next={width:Math.max(.15,Math.min(.75,(r.paneWidth-(e.clientX-r.x))/r.width)),height:r.axis==='both'?Math.max(52,Math.min(600,r.paneHeight+e.clientY-r.y)):themeNoteSize().height};
    const top=r.content.getBoundingClientRect().top;applyThemeNoteSize(r.next);
    r.content.closest('.day-body').scrollTop+=r.content.getBoundingClientRect().top-top;return;
  }
  if(resizing && resizing.id===e.pointerId){resizing.next=resizeColumns(resizing.widths,resizing.index,e.clientX-resizing.x);$('#board').style.gridTemplateColumns=resizing.next.map(w=>`${w}px`).join(' ');return;}
  if(!gesture || gesture.id!==e.pointerId)return;
  const delta=e.clientX-gesture.x;
  if(Math.abs(e.clientY-gesture.y)>50 && Math.abs(delta)<50){gesture=null;return;}
  if(Math.abs(delta)>90){navigate(delta<0?-1:1);gesture.x=e.clientX;gesture.y=e.clientY;}
});
function endPointer(){gesture=null;if(noteResizing){const r=noteResizing;noteResizing=null;document.body.classList.remove('resizing-note');if(r.next){if(r.kind==='stock')storeStockNoteSize(r.next);else storeThemeNoteSize(r.next);render();}}if(resizing){const next=resizing.next;resizing=null;document.body.classList.remove('resizing-columns');if(next){saveColumnWidths(next);render();}}}
document.addEventListener('pointerup',endPointer);document.addEventListener('pointercancel',endPointer);
document.addEventListener('wheel',e=>{
  if(!e.target.closest('.board') || resizing || noteResizing)return;
  const horizontal=Math.abs(e.deltaX)>Math.abs(e.deltaY)?e.deltaX:e.shiftKey?e.deltaY:0;if(!horizontal)return;
  e.preventDefault();wheelTotal+=horizontal;clearTimeout(wheelTimer);wheelTimer=setTimeout(()=>{wheelTotal=0;},150);
  if(Math.abs(wheelTotal)>75){navigate(wheelTotal>0?-1:1);wheelTotal=0;}
},{passive:false});
$('#modal').addEventListener('click',e=>{if(e.target===$('#modal'))$('#modal').close();});

try {
  state=await api('/api/state');
  let recovered=null;try{recovered=JSON.parse(localStorage.getItem('review.preferenceDraft') || 'null');}catch{}
  state.preferences={days:3,colors:{},merges:{},sorts:{},manual:[],stockColors:{},stockNotes:{},themeNotes:{},themeOrders:{},columnWidths:{},...(recovered?.preferences || state.preferences)};
  if(!state.preferences.themeNotes.$size){
    const previous=Object.entries(state.preferences.themeNotes).filter(([date])=>/^\d{4}-\d{2}-\d{2}$/.test(date)).sort(([a],[b])=>b.localeCompare(a)).flatMap(([,notes])=>Object.values(notes)).find(note=>note?.size);
    if(previous){state.preferences.themeNotes.$size={...previous.size};save();}
  }
  if(recovered?.preferences)save();updateModel();
  const saved=sessionStorage.getItem('review.anchor');anchor=saved?model.days.findIndex(d=>d.date===saved):model.days.length-1;if(anchor<0)anchor=model.days.length-1;
  render();if(state.job?.running)startPolling();
}catch(e){$('#app').innerHTML=`<div class="empty"><h2>暂时无法打开看板</h2><p>${esc(e.message)}</p><p>请确认启动窗口仍在运行，然后刷新页面。</p></div>`;}
