import test from 'node:test';
import assert from 'node:assert/strict';
import {derive, historyFor, provinceHistoryFor, themeLadderFor, normalizeProvince, mergeThemes, sortStocks, sortFirstBoardThemes, countFirstLimitTimes, reorderThemes, columnWeights, resizeColumns, buildThemeCatalog, assignStockTheme, removeStockTheme} from './static/engine.mjs';
const calendar={years:{2026:{closed_weekdays:[]}}};
const stock=(board,themes=['游戏'],name='甲股')=>({name,board,themes});
const day=(date,stocks,complete=true)=>({date,stocks,complete,themeOrder:[...new Set(stocks.flatMap(s=>s.themes))],metrics:{}});
const base=days=>({days,calendar,preferences:{days:3,merges:{},colors:{},sorts:{},manual:[]}});
const located=(date,stocks,provinces,complete=true)=>({...day(date,stocks,complete),metrics:Object.fromEntries(Object.entries(provinces).map(([name,province])=>[name,{name,province}]))});

test('题材近15交易日天梯按日、板数和唯一股票汇总，并以悬浮日为截止日',()=>{
 const days=Array.from({length:18},(_,i)=>({date:`2026-10-${String(i+1).padStart(2,'0')}`,stocks:[]}));
 days[1].stocks=[{name:'过期股',board:5,themes:['芯片']}];
 days[2].stocks=[{name:'首板乙',board:1,themes:['芯片']},{name:'首板甲',board:1,themes:['芯片']},{name:'其他',board:6,themes:['游戏']}];
 days[9].stocks=[{name:'二板乙',board:2,themes:['芯片','AI']},{name:'二板甲',board:2,themes:['芯片']}];
 days[14].stocks=[{name:'三板股',board:3,themes:['芯片']},{name:'首板股',board:1,themes:['芯片']}];
 days[16].stocks=[{name:'未来股',board:8,themes:['芯片']}];
 const ladder=themeLadderFor({days},' 芯片 ','2026-10-16');
 assert.equal(ladder.days.length,15);assert.equal(ladder.days[0].date,'2026-10-02');assert.equal(ladder.days.at(-1).date,'2026-10-16');
 assert.equal(ladder.highest,5);assert.equal(ladder.maxBoard,5);assert.equal(ladder.activeDays,4);
 assert.deepEqual(ladder.days[1].boards,[{board:1,names:['首板甲','首板乙'],count:2}]);
 assert.deepEqual(ladder.days[8].boards,[{board:2,names:['二板甲','二板乙'],count:2}]);
 assert.deepEqual(ladder.days[13].boards,[{board:1,names:['首板股'],count:1},{board:3,names:['三板股'],count:1}]);
 assert.equal(ladder.days.some(d=>d.boards.some(b=>b.names.includes('未来股'))),false);
});
test('题材天梯规范化名称、限制窗口，保留无题材日期并安全处理空结果',()=>{
 const days=[{date:'2026-11-02',stocks:[{name:'甲',board:1,themes:['ＡＩ应用']}]},{date:'2026-11-03',stocks:[]},{date:'2026-11-04',stocks:[{name:'乙',board:2,themes:['AI应用']}]}];
 const ladder=themeLadderFor({days},'AI应用','2026-11-04',2);
 assert.deepEqual(ladder.days.map(d=>[d.date,d.maxBoard]),[['2026-11-03',0],['2026-11-04',2]]);assert.equal(ladder.activeDays,1);assert.equal(ladder.highest,2);
 assert.deepEqual(themeLadderFor({days},'不存在','2026-11-01'),{theme:'不存在',date:'2026-11-01',days:[],maxBoard:1,activeDays:0,highest:0});
});

test('省份规范化覆盖直辖市、自治区、空值，省份历史按独立维度分批并记录并列最高',()=>{
 assert.deepEqual(['广东省','北京市','广西壮族自治区','宁夏回族自治区','新疆维吾尔自治区','内蒙古自治区','香港特别行政区',' -- ',null].map(normalizeProvince),['广东','北京','广西','宁夏','新疆','内蒙古','香港','','']);
 const s=base([
  located('2026-11-02',[stock(1,['游戏','芯片'],'甲'),stock(1,['农业'],'乙'),stock(1,['农业'],'丙'),stock(1,['游戏'],'丁'),stock(1,['游戏'],'未知股')],{'甲':'广东省','乙':'广东','丙':'广东省','丁':'北京市'}),
  located('2026-11-03',[stock(2,['游戏','芯片'],'甲'),stock(2,['农业'],'乙'),stock(2,['游戏'],'丁')],{'甲':'广东','乙':'广东省','丁':'北京'}),
  located('2026-11-04',[stock(3,['游戏','芯片'],'甲'),stock(3,['农业'],'乙')],{'甲':'广东省','乙':'广东省'}),day('2026-11-05',[])]);
 const m=derive(s),h=provinceHistoryFor(m,'广东省','2026-11-05',s.preferences);
 assert.equal(h.length,1);assert.equal(h[0].board,3);assert.deepEqual(new Set(h[0].names),new Set(['甲','乙']));assert.equal(h[0].members.length,3);
 assert.equal(h[0].startDate,'2026-11-02');assert.equal(h[0].lastDate,'2026-11-04');assert.equal(h[0].date,'2026-11-05');
 assert.equal(provinceHistoryFor(m,'广东','2026-11-04',s.preferences).length,0);assert.equal(provinceHistoryFor(m,'北京','2026-11-04',s.preferences)[0].name,'丁');
 assert.equal(provinceHistoryFor(m,'省份待补','2026-11-05',s.preferences).length,0);assert.equal(m.days[0].stocks.at(-1).province,'');
});
test('省份批次包含筛选按查看日期，未结束与不完整名单不会提前形成高度记录',()=>{
 const s=base([
  located('2026-11-02',[stock(1,['甲'],'外层')],{'外层':'广东省'}),
  located('2026-11-03',[stock(2,['甲'],'外层'),stock(1,['乙'],'内层')],{'外层':'广东','内层':'广东省'}),
  located('2026-11-04',[stock(3,['甲'],'外层'),stock(2,['乙'],'内层')],{'外层':'广东','内层':'广东'}),
  located('2026-11-05',[stock(4,['甲'],'外层')],{'外层':'广东'}),day('2026-11-06',[])]);
 const m=derive(s);assert.deepEqual(provinceHistoryFor(m,'广东','2026-11-05',s.preferences),[]);
 const h=provinceHistoryFor(m,'广东','2026-11-06',s.preferences);assert.equal(h.length,1);assert.equal(h[0].text,'外层 4板');
 s.days.at(-1).complete=false;assert.deepEqual(provinceHistoryFor(derive(s),'广东','2026-11-06',s.preferences),[]);
});
test('题材移除与合并不改变省份高度，省份手动记录与同名题材完全隔离并共用六条上限',()=>{
 const s=base([located('2026-11-02',[stock(1,['广东'])],{'甲股':'广东省'}),located('2026-11-03',[stock(2,['广东'])],{'甲股':'广东省'}),day('2026-11-04',[])]);
 const original=provinceHistoryFor(derive(s),'广东','2026-11-04',s.preferences);
 s.preferences=mergeThemes(s.preferences,'2026-11-03','广东','其他');s.preferences=removeStockTheme(s,'2026-11-03','甲股','其他');
 assert.deepEqual(provinceHistoryFor(derive(s),'广东','2026-11-04',s.preferences),original);assert.deepEqual(historyFor(derive(s),'广东','2026-11-04',s.preferences),[]);
 s.preferences.manual=[{id:'theme',theme:'广东',date:'2026-11-04',text:'同名题材手动记录'},...Array.from({length:7},(_,i)=>({id:'province'+i,scope:'province',province:'广东省',date:'2026-11-04',text:`省份手动${i}`,createdAt:`12:00:0${i}`})),{id:'future',scope:'province',province:'广东',date:'2026-11-05',text:'未来记录'}];
 const m=derive(s),h=provinceHistoryFor(m,'广东','2026-11-04',s.preferences);assert.equal(h.length,6);assert.equal(h[0].text,'省份手动6');assert.equal(h.at(-1).text,'省份手动1');
 assert.deepEqual(historyFor(m,'广东','2026-11-04',s.preferences).map(e=>e.text),['同名题材手动记录']);assert.equal(m.history.filter(e=>e.scope==='province').length,0);
});

test('移除原始题材同步整轮分组与历史，不影响其他股、新轮次、股票数量和导入数据',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片','农业']),stock(1,['芯片'],'乙股')]),day('2026-11-03',[stock(2,['芯片']),stock(2,['芯片'],'乙股')]),day('2026-11-04',[]),day('2026-11-05',[stock(1,['芯片'])])]);
 const before=structuredClone(s.days);s.preferences=removeStockTheme(s,'2026-11-03','甲股','芯片');const m=derive(s);
 assert.deepEqual(s.days,before);assert.deepEqual(m.days[0].stocks[0].themes,['农业']);assert.deepEqual(m.days[1].stocks[0].themes,['农业']);
 assert.deepEqual(m.days[0].stocks[1].themes,['芯片']);assert.deepEqual(m.days[3].stocks[0].themes,['芯片']);
 assert.equal(historyFor(m,'芯片','2026-11-04',s.preferences)[0].name,'乙股');assert.equal(historyFor(m,'农业','2026-11-04',s.preferences)[0].name,'甲股');
 assert.deepEqual(m.days.map(d=>d.stocks.length),[2,2,0,1]);assert.ok(buildThemeCatalog(s).some(t=>t.name==='芯片'));
 s.days=structuredClone(before);s.days[0].metrics={'甲股':{name:'甲股',code:'000001.SZ'}};
 assert.deepEqual(derive(s).days[0].stocks[0].themes,['农业']);assert.equal(removeStockTheme(s,'2026-11-03','甲股','不存在'),s.preferences);
});
test('可移除最后题材，首板未归类保留且不创建伪题材和历史，重新添加恢复整轮',()=>{
 const s=base([day('2026-11-02',[stock(1)]),day('2026-11-03',[stock(2)]),day('2026-11-04',[])]);
 s.preferences=removeStockTheme(s,'2026-11-03','甲股','游戏');let m=derive(s);
 assert.deepEqual(m.days[0].stocks[0].themes,[]);assert.equal(m.days[0].groups[0].count,1);
 assert.deepEqual(m.days[0].groups[0].unclassified.map(s=>s.name),['甲股']);assert.deepEqual(m.days[0].groups[0].themes,[]);assert.deepEqual(m.themes,[]);assert.deepEqual(m.history,[]);
 s.preferences=assignStockTheme(s,'2026-11-02','甲股','游戏');m=derive(s);
 assert.deepEqual(m.days[0].stocks[0].themes,['游戏']);assert.deepEqual(m.days[0].groups[0].unclassified,[]);assert.equal(m.history[0].name,'甲股');
});
test('移除后重新添加手动题材可跨本轮日期恢复，合并目标移除不会从源题材回流',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片','算力'])]),day('2026-11-03',[stock(2,['芯片'])])]);
 s.preferences=assignStockTheme(s,'2026-11-02','甲股','机器人');s.preferences=removeStockTheme(s,'2026-11-03','甲股','机器人');
 assert.ok(derive(s).days.every(d=>!d.stocks[0].themes.includes('机器人')));
 s.preferences=assignStockTheme(s,'2026-11-02','甲股','机器人');assert.ok(derive(s).days.every(d=>d.stocks[0].themes.includes('机器人')));
 s.preferences=mergeThemes(s.preferences,'2026-11-03','芯片','科技');s.preferences=mergeThemes(s.preferences,'2026-11-03','算力','科技');
 s.preferences=removeStockTheme(s,'2026-11-03','甲股','科技');let m=derive(s);
 assert.deepEqual(m.days[0].stocks[0].themes,['机器人']);assert.deepEqual(m.days[1].stocks[0].themes,['机器人']);assert.deepEqual(m.days[1].stocks[0].mergedThemes,[]);
 s.preferences=assignStockTheme(s,'2026-11-03','甲股','科技');m=derive(s);
 assert.deepEqual(new Set(m.days[0].stocks[0].themes),new Set(['芯片','算力','机器人','科技']));assert.deepEqual(new Set(m.days[1].stocks[0].themes),new Set(['科技','机器人']));
});

test('最近题材库去重、按最后出现排序、上限200且历史精确名称仍可复用',()=>{
 const s=base(Array.from({length:205},(_,i)=>day(new Date(Date.UTC(2026,0,1+i)).toISOString().slice(0,10),[stock(1,[`题材${i}`])])));
 const catalog=buildThemeCatalog(s);assert.equal(catalog.length,200);assert.equal(catalog[0].name,'题材204');assert.equal(catalog.at(-1).name,'题材5');
 s.preferences.themeOrders={$catalog:catalog};
 s.days.push(day('2026-11-02',[stock(1,['ＡＩ应用','AI应用',' AI应用 '])]));
 const next=buildThemeCatalog(s);assert.equal(next.length,200);assert.equal(next.filter(t=>t.name==='AI应用').length,1);assert.equal(next[0].name,'AI应用');
 s.preferences=assignStockTheme(s,'2026-11-02','甲股',' 题材0 ');assert.ok(derive(s).days.at(-1).stocks[0].themes.includes('题材0'));
});
test('题材库保留已缓存题材，手动新建优先，同日重复不会无限扩张',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片'])])]);
 s.preferences.themeOrders={$catalog:[{name:'历史题材',seenAt:'2026-10-01T00:00:00.000Z'},{name:'自建题材',seenAt:'2026-11-16T01:00:00.000Z'}]};
 const catalog=buildThemeCatalog(s);assert.deepEqual(catalog.map(t=>t.name),['自建题材','芯片','历史题材']);
 s.preferences.themeOrders.$catalog=catalog;assert.deepEqual(buildThemeCatalog(s),catalog);
});
test('为个股添加题材回补本轮首板和历史，同股下一轮不继承且不改变原始名单',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片']),stock(1,['农业'],'乙股')]),day('2026-11-03',[stock(2,['芯片'])]),day('2026-11-04',[]),day('2026-11-05',[stock(1,['算力'])])]);
 const original=structuredClone(s.days);s.preferences=assignStockTheme(s,'2026-11-03','甲股','机器人概念');const m=derive(s);
 assert.deepEqual(s.days,original);assert.ok(m.days[0].groups[0].themes.some(g=>g.theme==='机器人概念' && g.stocks.length===1));
 assert.ok(m.days[1].stocks[0].themes.includes('机器人概念'));assert.deepEqual(m.days[3].stocks[0].themes,['算力']);
 assert.equal(historyFor(m,'机器人概念','2026-11-04',s.preferences)[0].text,'甲股 2板');
 assert.deepEqual(m.days[0].stocks.find(x=>x.name==='乙股').themes,['农业']);assert.equal(m.days[0].stocks.length,2);
});
test('添加题材复用已有规范名称、防止已合并题材重复，重新导入与补全代码后仍有效',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片']),stock(1,['AI应用'],'乙股')])]);
 s.preferences=assignStockTheme(s,'2026-11-02','甲股',' ＡＩ应用 ');assert.deepEqual(s.preferences.merges.$stockThemes['2026-11-02']['甲股'],['AI应用']);
 assert.equal(assignStockTheme(s,'2026-11-02','甲股','ai应用'),s.preferences);
 s.preferences=mergeThemes(s.preferences,'2026-11-02','AI应用','芯片');assert.equal(assignStockTheme(s,'2026-11-02','甲股','AI应用'),s.preferences);
 s.days[0]=day('2026-11-02',[stock(1,['芯片']),stock(1,['AI应用'],'乙股')]);
 s.days[0].metrics={'甲股':{name:'甲股',code:'000001.SZ'}};
 assert.deepEqual(derive(s).days[0].stocks[0].mergedThemes,[{source:'AI应用',target:'芯片'}]);
 assert.throws(()=>assignStockTheme(s,'2026-11-02','甲股',' '),/1–40/);
 assert.throws(()=>assignStockTheme(s,'2026-11-02','缺失股票','芯片'),/未找到/);
});

test('同轮换题材回补所有日期，最高板数共享，日板数不改变',()=>{
 const s=base([day('2026-11-02',[stock(1)]),day('2026-11-03',[stock(2,['文化传媒'])]),day('2026-11-04',[stock(3,['文化传媒'])]),day('2026-11-05',[])]);
 const m=derive(s);
 assert.deepEqual(m.days[0].stocks[0].themes,['游戏','文化传媒']);
 assert.equal(m.days[0].stocks[0].board,1);
 assert.equal(m.days[2].stocks[0].episodeMax,3);
 for(const theme of ['游戏','文化传媒'])assert.equal(historyFor(m,theme,'2026-11-05',s.preferences)[0].text,'甲股 3板');
 assert.equal(historyFor(m,'游戏','2026-11-04',s.preferences).length,0);
});
test('只达到首板的股票不进历史',()=>{
 const s=base([day('2026-11-02',[stock(1)]),day('2026-11-03',[])]);assert.equal(derive(s).history.length,0);
});
test('缺失交易日不能被误判为结束，补齐后重新计算',()=>{
 const s=base([day('2026-11-02',[stock(2)]),day('2026-11-04',[])]);assert.equal(derive(s).history.length,0);
 s.days.push(day('2026-11-03',[]));assert.equal(derive(s).history[0].board,2);
});
test('不完整名单不终止追踪',()=>{
 const s=base([day('2026-11-02',[stock(2)]),day('2026-11-03',[],false),day('2026-11-04',[])]);assert.equal(derive(s).history.length,0);
});
test('周末连续、同股新一轮不继承旧题材',()=>{
 const s=base([day('2026-11-06',[stock(2)]),day('2026-11-09',[stock(3)]),day('2026-11-10',[]),day('2026-11-11',[stock(1,['芯片'])])]);
 const m=derive(s);assert.equal(m.episodes.length,2);assert.equal(m.history[0].board,3);assert.deepEqual(m.days[3].stocks[0].themes,['芯片']);
});
test('每日合并覆盖所有板数但不改变其他日期，历史回补不复活已合并题材',()=>{
 const s=base([day('2026-11-02',[stock(1),stock(2,['文化传媒'],'乙股')]),day('2026-11-03',[stock(2),stock(3,['游戏'],'乙股')])]);
 s.preferences=mergeThemes(s.preferences,'2026-11-03','游戏','文化传媒');const m=derive(s);
 assert.equal(m.days[0].stocks[0].themes.includes('游戏'),true);
 assert.equal(m.days[1].groups.some(b=>b.themes.some(t=>t.theme==='游戏')),false);
 assert.equal(m.days[1].stocks.length,2);
 assert.deepEqual(m.days[1].stocks[0].mergedThemes,[{source:'游戏',target:'文化传媒'}]);
 assert.deepEqual(m.days[0].stocks[0].mergedThemes,[]);
 s.preferences=mergeThemes(s.preferences,'2026-11-03','文化传媒','芯片');
 assert.deepEqual(derive(s).days[1].stocks[0].mergedThemes,[{source:'游戏',target:'芯片'}]);
});
test('同股板数重置开启新轮次',()=>{
 const s=base([day('2026-11-02',[stock(3)]),day('2026-11-03',[stock(1,['算力'])])]);const m=derive(s);
 assert.equal(m.episodes.length,2);assert.equal(m.history[0].board,3);assert.deepEqual(m.days[1].stocks[0].themes,['算力']);
});
test('单日手工合并不能通过累计题材回补到其他日期',()=>{
 const s=base([day('2026-11-02',[stock(1)]),day('2026-11-03',[stock(2)])]);
 s.preferences=mergeThemes(s.preferences,'2026-11-03','游戏','文化传媒');const m=derive(s);
 assert.deepEqual(m.days[0].stocks[0].themes,['游戏']);assert.deepEqual(m.days[1].stocks[0].themes,['文化传媒']);
});
test('自动与手动共享六条，最早记录被替换',()=>{
 const s=base([day('2026-11-02',[stock(2)]),day('2026-11-03',[])]);
 s.preferences.manual=Array.from({length:7},(_,i)=>({id:'m'+i,theme:'游戏',date:'2026-11-03',text:'手动'+i,createdAt:`12:00:0${i}`}));
 const h=historyFor(derive(s),'游戏','2026-11-03',s.preferences);assert.equal(h.length,6);assert.equal(h[0].text,'手动6');assert.equal(h.at(-1).text,'手动1');
});
test('缺失值始终置后，时间与数字排序正确',()=>{
 const stocks=[{name:'甲',metrics:{amount:100,firstLimit:'09:30:00'}},{name:'乙',metrics:{}},{name:'丙',metrics:{amount:2,firstLimit:'10:00:00'}}];
 assert.deepEqual(sortStocks(stocks,{field:'amount',direction:'desc'}).map(s=>s.name),['甲','丙','乙']);
 assert.deepEqual(sortStocks(stocks,{field:'amount',direction:'asc'}).map(s=>s.name),['丙','甲','乙']);
 assert.deepEqual(sortStocks(stocks).map(s=>s.name),['甲','丙','乙']);
});
test('统一排序覆盖全部日期并忽略旧的逐日排序设置',()=>{
 const s=base([day('2026-11-02',[stock(1,['游戏'],'甲'),stock(1,['游戏'],'乙')]),day('2026-11-03',[stock(2,['游戏'],'甲'),stock(2,['游戏'],'乙')])]);
 s.days[0].metrics={甲:{amount:200},乙:{amount:10}};s.days[1].metrics={甲:{amount:30},乙:{amount:500}};
 s.preferences.sorts={'2026-11-02':{field:'amount',direction:'asc'},global:{field:'amount',direction:'desc'}};
 let m=derive(s);assert.deepEqual(m.days.map(d=>d.groups[0].themes[0].stocks.map(x=>x.name)),[['甲','乙'],['乙','甲']]);
 s.preferences.sorts.global.direction='asc';m=derive(s);assert.deepEqual(m.days.map(d=>d.groups[0].themes[0].stocks.map(x=>x.name)),[['乙','甲'],['甲','乙']]);
});

test('早午以 13:00 为边界，12:59 计早，零值保留，缺失不混入午',()=>{
 const members=['09:25:00','11:00:00','12:59:00','12:59:59','13:00:00','14:50:00',null,'25:00:00'].map(firstLimit=>({metrics:{firstLimit}}));
 assert.deepEqual(countFirstLimitTimes(members),{early:4,late:2,unknown:2});
 assert.deepEqual(countFirstLimitTimes([]),{early:0,late:0,unknown:0});
});
test('二板多题材仍是一只股票，自定题材顺序只影响当日并保留合并规则',()=>{
 const s=base([day('2026-11-12',[stock(2,['文化传媒','芯片'])]),day('2026-11-13',[stock(3,['文化传媒','芯片'])])]);
 s.preferences.themeOrders={'2026-11-13':reorderThemes(['文化传媒','芯片'],'芯片','文化传媒')};
 let m=derive(s);assert.equal(m.days[1].groups[0].stocks.length,1);
 assert.deepEqual(m.days.map(d=>d.themeOrder),[['文化传媒','芯片'],['芯片','文化传媒']]);
 s.preferences=mergeThemes(s.preferences,'2026-11-13','芯片','文化传媒');m=derive(s);
 assert.deepEqual(m.days[1].themeOrder,['文化传媒']);assert.equal(m.days[1].groups[0].stocks.length,1);
});
test('列宽只调整相邻两列，保留总宽和最小宽，自定义宽度按日恢复',()=>{
 assert.deepEqual(resizeColumns([250,250,500],1,100),[250,350,400]);
 assert.deepEqual(resizeColumns([250,250,500],1,999),[250,630,120]);
 assert.deepEqual(resizeColumns([250,250,500],0,-999),[120,380,500]);
 const days=[{date:'a'},{date:'b'},{date:'c'}];assert.deepEqual(columnWeights(days,{}),[.75,.75,1.5]);
 assert.deepEqual(columnWeights(days,{columnWidths:{b:1.2,c:1.05}}),[.75,1.2,1.05]);
});

test('同日首板批次等待全部断板，只留最高纪录，时间为首板至末板',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片'],'甲'),stock(1,['芯片'],'乙'),stock(1,['芯片'],'丙')]),
   day('2026-11-03',[stock(2,['芯片'],'甲'),stock(2,['芯片'],'乙')]),day('2026-11-04',[stock(3,['芯片'],'甲')])]);
 assert.equal(historyFor(derive(s),'芯片','2026-11-04',s.preferences).length,0);
 s.days.push(day('2026-11-05',[]));const m=derive(s),h=historyFor(m,'芯片','2026-11-05',s.preferences);
 assert.equal(h.length,1);assert.equal(h[0].text,'甲 3板');assert.equal(h[0].members.length,3);
 assert.equal(h[0].startDate,'2026-11-02');assert.equal(h[0].lastDate,'2026-11-04');
 assert.equal(historyFor(m,'芯片','2026-11-04',s.preferences).length,0);
});
test('同批并列最高合成一条，不同首板日分别成批',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片'],'甲'),stock(1,['芯片'],'乙')]),
  day('2026-11-03',[stock(2,['芯片'],'甲'),stock(2,['芯片'],'乙'),stock(1,['芯片'],'丙')]),
  day('2026-11-04',[stock(2,['芯片'],'丙')]),day('2026-11-05',[])]);
 const h=historyFor(derive(s),'芯片','2026-11-05',s.preferences);assert.equal(h.length,2);
 assert.deepEqual(new Set(h[1].names),new Set(['甲','乙']));assert.equal(h[1].board,2);assert.equal(h[0].text,'丙 2板');
 assert.deepEqual(h.map(e=>e.startDate),['2026-11-03','2026-11-02']);
});
test('同批成员断板日期仍待确认时，不提前形成最高纪录',()=>{
 const s=base([day('2026-11-02',[stock(1,['芯片'],'甲'),stock(1,['芯片'],'乙')]),
 day('2026-11-03',[stock(2,['芯片'],'甲')],false),day('2026-11-04',[])]);
 assert.equal(historyFor(derive(s),'芯片','2026-11-04',s.preferences).length,0);
 s.days[1].complete=true;assert.equal(historyFor(derive(s),'芯片','2026-11-04',s.preferences)[0].text,'甲 2板');
});
test('当日合并题材后，同首板日先合批，再等待最高纪录完成',()=>{
 const s=base([day('2026-11-02',[stock(1,['游戏'],'甲'),stock(1,['文化传媒'],'乙')]),
 day('2026-11-03',[stock(2,['游戏'],'甲'),stock(2,['文化传媒'],'乙')]),day('2026-11-04',[stock(3,['文化传媒'],'乙')])]);
 s.preferences=mergeThemes(s.preferences,'2026-11-04','游戏','文化传媒');
 assert.equal(historyFor(derive(s),'文化传媒','2026-11-04',s.preferences).length,0);
 s.days.push(day('2026-11-05',[]));s.preferences=mergeThemes(s.preferences,'2026-11-05','游戏','文化传媒');
 const h=historyFor(derive(s),'文化传媒','2026-11-05',s.preferences);assert.equal(h.length,1);assert.equal(h[0].text,'乙 3板');
 assert.equal(historyFor(derive(s),'游戏','2026-11-05',{...s.preferences,merges:{}})[0].text,'甲 2板');
});
test('同题材首板更晚且末板更早的批次不入历史，外层仍在连板也生效',()=>{
 const s=base([day('2026-11-02',[stock(1,['农业'],'外层')]),
  day('2026-11-03',[stock(2,['农业'],'外层'),stock(1,['农业'],'内层')]),
  day('2026-11-04',[stock(3,['农业'],'外层'),stock(2,['农业'],'内层')]),
  day('2026-11-05',[stock(4,['农业'],'外层')])]);
 assert.deepEqual(historyFor(derive(s),'农业','2026-11-05',s.preferences),[]);
 s.days.push(day('2026-11-06',[]));const h=historyFor(derive(s),'农业','2026-11-06',s.preferences);
 assert.equal(h.length,1);assert.equal(h[0].text,'外层 4板');
});
test('同日结束的晚启动批次不单列，晚启动且晚结束的交叠批次仍保留',()=>{
 const s=base([day('2026-11-02',[stock(1,['农业'],'早批')]),
  day('2026-11-03',[stock(2,['农业'],'早批'),stock(1,['农业'],'晚批')]),
  day('2026-11-04',[stock(3,['农业'],'早批'),stock(2,['农业'],'晚批')]),day('2026-11-05',[])]);
 const endedTogether=historyFor(derive(s),'农业','2026-11-05',s.preferences);
 assert.equal(endedTogether.length,1);assert.equal(endedTogether[0].text,'早批 3板');
 s.days[3]=day('2026-11-05',[stock(3,['农业'],'晚批')]);s.days.push(day('2026-11-06',[]));
 assert.equal(historyFor(derive(s),'农业','2026-11-06',s.preferences).length,2);
});
test('包含筛选遵循当日题材合并，保留手动记录且不跨题材删除',()=>{
 const s=base([day('2026-11-02',[stock(1,['农业'],'外层')]),
  day('2026-11-03',[stock(2,['农业'],'外层'),stock(1,['水产品'],'内层')]),
  day('2026-11-04',[stock(3,['农业'],'外层'),stock(2,['水产品'],'内层')]),
  day('2026-11-05',[stock(4,['农业'],'外层')]),day('2026-11-06',[])]);
 assert.equal(historyFor(derive(s),'水产品','2026-11-06',s.preferences)[0].text,'内层 2板');
 s.preferences=mergeThemes(s.preferences,'2026-11-06','水产品','农业');
 s.preferences.manual=[{id:'keep',theme:'农业',date:'2026-11-06',text:'内层 2板（手工备注）'}];
 const h=historyFor(derive(s),'农业','2026-11-06',s.preferences);
 assert.equal(h.length,2);assert.equal(h[0].manual,true);assert.equal(h[1].text,'外层 4板');
});
test('首板题材四种排序、差值正负、同值稳定、时间缺失置后',()=>{
 const groups=[['甲',4,3,1,0],['乙',3,0,3,0],['丙',2,1,1,0],['丁',4,1,3,0],['缺时',5,0,0,5]].map(([theme,n,early,late,unknown])=>({theme,stocks:Array(n).fill({}),times:{early,late,unknown}}));
 const names=(field,direction='desc')=>sortFirstBoardThemes(groups,{field,direction}).map(g=>g.theme);
 assert.deepEqual(names('total'),['缺时','甲','丁','乙','丙']);
 assert.deepEqual(names('early'),['甲','丙','丁','乙','缺时']);
 assert.deepEqual(names('late'),['乙','丁','甲','丙','缺时']);
 assert.deepEqual(names('balance'),['乙','丁','丙','甲','缺时']);
 assert.deepEqual(names('balance','asc'),['甲','丙','丁','乙','缺时']);
 assert.deepEqual(names('manual'),['甲','乙','丙','丁','缺时']);
});
test('题材排序只作用于所选日期首板，合并后按去重首板人数重新排序',()=>{
 const a=day('2026-11-02',[stock(1,['甲'],'一'),stock(1,['乙'],'二'),stock(1,['乙','丙'],'三'),stock(2,['甲'],'高板一'),stock(2,['甲'],'高板二')]);
 const b=day('2026-11-03',[stock(1,['甲'],'四'),stock(1,['乙'],'五'),stock(1,['乙'],'六')]);
 const s=base([a,b]);s.preferences.sorts.firstBoard={'2026-11-02':{field:'total',direction:'desc'}};
 const before=derive(base([a,b])),m=derive(s);
 assert.deepEqual(m.days[0].groups.find(g=>g.board===1).themes.map(g=>g.theme),['乙','甲','丙']);
 assert.deepEqual(m.days[1].groups.find(g=>g.board===1).themes.map(g=>g.theme),['甲','乙']);
 assert.deepEqual(m.days[0].groups.find(g=>g.board===2),before.days[0].groups.find(g=>g.board===2));
 s.preferences=mergeThemes(s.preferences,'2026-11-02','丙','乙');
 assert.equal(derive(s).days[0].groups.find(g=>g.board===1).themes[0].stocks.length,2);
});
