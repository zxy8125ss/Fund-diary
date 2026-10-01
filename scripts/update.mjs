// 基金日记自动更新：抓净值 → 更新持仓 → 复盘 → 预测下一交易日
// 运行：node scripts/update.mjs   （MODE=evening|morning，可省略，按北京时间自动判断）
import fs from 'node:fs';

const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
const DIR = new URL('../data/', import.meta.url);
const read = f => JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8'));
const write = (f, o) => fs.writeFileSync(new URL(f, DIR), JSON.stringify(o, null, 1) + '\n');

const funds = read('funds.json');
const diary = read('diary.json');
const cal = read('calendar.json');
const report = [];
const log = s => { console.log(s); report.push(s); };

// ---------- 时间与交易日 ----------
const bj = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3);
const NOW = bj();
const today = NOW.toISOString().slice(0, 10);
const nowStr = NOW.toISOString().slice(0, 16).replace('T', ' ');
const hourBJ = NOW.getUTCHours() + NOW.getUTCMinutes() / 60;
const MODE = process.env.MODE || (hourBJ < 12 ? 'morning' : 'evening');
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const isTD = ds => { const w = new Date(ds + 'T00:00:00Z').getUTCDay(); return w > 0 && w < 6 && !cal.holidays.includes(ds); };
const nextTD = ds => { let d = addDays(ds, 1); for (let i = 0; i < 40 && !isTD(d); i++) d = addDays(d, 1); return d; };
if (!cal.holidays.some(h => h.startsWith(today.slice(0, 4))) || (today.slice(5) >= '12-15' && !cal.holidays.some(h => h.startsWith(String(+today.slice(0, 4) + 1)))))
  log('提醒：data/calendar.json 缺少来年休市安排，请补充');

// ---------- 网络 ----------
async function get(url, { headers = {}, encoding = 'utf-8', timeout = 20000, tries = 2 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) FundDiary', ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new TextDecoder(encoding).decode(await r.arrayBuffer());
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 2000)); }
    finally { clearTimeout(t); }
  }
  throw err;
}
const pct = v => (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';

// ---------- 1. 净值 ----------
async function navHistory(code) {
  try {
    const t = await get(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`);
    const m = t.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('无净值数据');
    return JSON.parse(m[1]).slice(-60).map(p => ({ date: bj(new Date(p.x)).toISOString().slice(0, 10), nav: p.y, pct: Number(p.equityReturn) }));
  } catch (e) {
    const t = await get(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=40`, { headers: { referer: 'https://fundf10.eastmoney.com/' } });
    const list = JSON.parse(t)?.Data?.LSJZList || [];
    if (!list.length) throw e;
    return list.reverse().map(p => ({ date: p.FSRQ, nav: Number(p.DWJZ), pct: Number(p.JZZZL) }));
  }
}

const hist = {};
for (const f of funds) {
  try { hist[f.code] = (await navHistory(f.code)).filter(p => Number.isFinite(p.pct)); }
  catch (e) { log(`${f.short} 净值抓取失败：${e.message}`); hist[f.code] = []; }
}

// 1a. 按新净值滚动持仓金额与收益（不加减仓的前提下）
for (const f of funds) {
  const fresh = hist[f.code].filter(p => p.date > f.navDate);
  for (const p of fresh) {
    const delta = f.amount * p.pct / 100;
    f.amount = +(f.amount + delta).toFixed(2); f.pnl = +(f.pnl + delta).toFixed(2); f.navDate = p.date;
  }
  f.pnlPct = +(f.pnl / (f.amount - f.pnl) * 100).toFixed(2);
  f.recent = hist[f.code].slice(-10).map(p => ({ date: p.date, pct: p.pct }));
  if (fresh.length) log(`${f.short}：更新 ${fresh.length} 天净值，最新 ${f.navDate} ${pct(fresh.at(-1).pct)}`);
}

// 1b. 回填各日记条目的实际涨跌
for (const e of Object.values(diary.entries)) {
  e.actual ||= {};
  for (const f of funds) {
    if (e.actual[f.code] != null) continue;
    const p = hist[f.code].find(x => x.date === e.date);
    if (p) e.actual[f.code] = p.pct;
  }
}

// ---------- 2. 市场快照 ----------
async function indices() {
  const want = [['1.000001', '上证指数'], ['0.399006', '创业板指'], ['1.000688', '科创50'], ['100.NDX', '纳斯达克100'], ['100.SOX', '费城半导体'], ['124.HSTECH', '恒生科技'], ['133.USDCNH', '美元/离岸人民币']];
  try {
    const t = await get(`https://push2.eastmoney.com/api/qt/ulist.np/get?fltt=2&secids=${want.map(w => w[0]).join(',')}&fields=f12,f14,f2,f3,f124`);
    const d = JSON.parse(t)?.data?.diff || [];
    if (!d.length) throw new Error('空');
    return d.map(x => `${x.f14} ${x.f2}（${pct(x.f3)}，${bj(new Date(x.f124 * 1000)).toISOString().slice(5, 16).replace('T', ' ')}）`);
  } catch {
    const t = await get('https://hq.sinajs.cn/list=s_sh000001,s_sz399006,s_sh000688,gb_$ndx,gb_$sox,rt_hkHSTECH', { headers: { referer: 'https://finance.sina.com.cn/' }, encoding: 'gbk' });
    const out = [];
    for (const line of t.split('\n')) {
      const m = line.match(/hq_str_(\S+)="(.*)"/); if (!m || !m[2]) continue;
      const a = m[2].split(',');
      if (m[1].startsWith('s_')) out.push(`${a[0]} ${a[1]}（${pct(a[3])}）`);
      else if (m[1].startsWith('gb_')) out.push(`${a[0]} ${a[1]}（${pct(a[2])}，${a[3]}）`);
      else if (m[1].startsWith('rt_hk')) out.push(`${a[1]} ${a[6]}（${pct(a[8])}）`);
    }
    return out;
  }
}
const BOARD_KEYS = /半导体|芯片|存储|PCB|印制电路|覆铜板|MLCC|被动元件|元件|光模块|CPO|光通信|光纤|AI|算力|消费电子|先进封装/;
async function boards() {
  const res = [];
  for (const fs_ of ['m:90+t:2', 'm:90+t:3']) {
    const t = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=600&po=1&np=1&fltt=2&fid=f3&fs=${fs_}&fields=f12,f14,f3,f62`);
    for (const x of JSON.parse(t)?.data?.diff || []) if (BOARD_KEYS.test(x.f14)) res.push({ name: x.f14, pct: x.f3, flow: x.f62 });
  }
  return [...new Map(res.map(r => [r.name, r])).values()].slice(0, 30)
    .map(r => `${r.name} ${pct(r.pct)}${Number.isFinite(r.flow) ? `，主力净流入${(r.flow / 1e8).toFixed(1)}亿` : ''}`);
}
const NEWS_KEYS = /半导体|芯片|PCB|覆铜板|MLCC|光模块|英伟达|台积电|美联储|关税|出口管制|央行|降准|降息|证监会|科创|纳斯达克|美股|港股|A股|算力|AI|存储|汇率|国务院/;
async function news() {
  try {
    const t = await get(`https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=100&req_trace=${Date.now()}`);
    const list = JSON.parse(t)?.data?.fastNewsList || [];
    if (!list.length) throw new Error('空');
    return list.map(n => `[${String(n.showTime).slice(5, 16)}] ${n.title || ''}：${(n.summary || '').slice(0, 120)}`);
  } catch {
    const t = await get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1');
    return (JSON.parse(t)?.result?.data?.feed?.list || []).map(n => `[${String(n.create_time).slice(5, 16)}] ${String(n.rich_text).replace(/<[^>]+>/g, '').slice(0, 140)}`);
  }
}
async function snapshot() {
  const parts = [];
  try { parts.push('【指数】\n' + (await indices()).join('\n')); } catch (e) { log('指数抓取失败：' + e.message); }
  try { const b = await boards(); if (b.length) parts.push('【相关板块（东财行业/概念）】\n' + b.join('\n')); } catch (e) { log('板块抓取失败：' + e.message); }
  try { const n = (await news()).filter(s => NEWS_KEYS.test(s)).slice(0, 35); if (n.length) parts.push('【相关快讯】\n' + n.join('\n')); } catch (e) { log('快讯抓取失败：' + e.message); }
  return parts.join('\n\n');
}

// ---------- 3. Gemini ----------
function parseJson(t) {
  const s = t.replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw new Error('输出中没有 JSON'); return JSON.parse(s.slice(a, b + 1));
}
async function gemini(text, label) {
  if (!KEY) throw new Error('缺少 GEMINI_API_KEY');
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.2, responseMimeType: 'application/json' } }) });
      if (r.ok) {
        const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
        if (t.trim()) { console.log(`${label}：使用 ${model}`); return parseJson(t); }
      } else console.error(`${label}：${model} ${r.status} ${(await r.text()).slice(0, 160)}`);
    } catch (e) { console.error(`${label}：${model} ${e.message}`); }
    await new Promise(res => setTimeout(res, 13000));
  }
  throw new Error('Gemini 不可用');
}

const fundBrief = () => funds.map(f => `- ${f.code} ${f.name}（${f.type}${f.qdii ? '，QDII：T日净值对应海外T日收盘' : ''}）\n  特征：${f.drivers.join('；')}\n  近10日净值涨跌：${(f.recent || []).map(p => `${p.date.slice(5)} ${pct(p.pct)}`).join('，') || '无'}`).join('\n');
const lessonBrief = () => diary.lessons.map(l => `${l.id}［${l.tag}］${l.text}（已验证${l.uses}次）`).join('\n');
const DIR_OF = v => v > 0.3 ? 'up' : v < -0.3 ? 'down' : 'flat';

function stats() {
  let n = 0, dh = 0, rh = 0;
  for (const e of Object.values(diary.entries)) if (e.status === 'reviewed') for (const [c, p] of Object.entries(e.preds || {})) {
    const a = e.actual?.[c]; if (a == null) continue; n++; dh += p.dir === DIR_OF(a); rh += a >= p.low && a <= p.high;
  }
  return n ? `累计 ${n} 次预测，方向命中 ${(dh / n * 100).toFixed(0)}%，区间命中 ${(rh / n * 100).toFixed(0)}%` : '尚无复盘数据';
}

// ---------- 3b. 大盘交叉验证：每个日期记录大盘和各基金锚定指数的当日涨跌 ----------
const MARKET_IDX = [['上证指数', '1.000001'], ['创业板指', '0.399006'], ['科创50', '1.000688'], ['纳斯达克100', '100.NDX']];
const ANCHORS = {
  '002910': [{ name: '科创50', secid: '1.000688' }, { board: '半导体' }],
  '005698': [{ name: '纳斯达克100', secid: '100.NDX' }, { name: '费城半导体', secid: '100.SOX' }],
  '024481': [{ board: 'PCB' }, { name: '创业板指', secid: '0.399006' }],
  '015060': [{ board: '元件' }, { name: '创业板指', secid: '0.399006' }],
  '001672': [{ name: '创业板指', secid: '0.399006' }, { name: '科创50', secid: '1.000688' }],
};
const klineCache = {};
async function kline(secid) {
  if (klineCache[secid]) return klineCache[secid];
  const t = await get(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=40&end=20500101&fields1=f1,f2,f3&fields2=f51,f53,f59`);
  const map = {};
  for (const k of JSON.parse(t)?.data?.klines || []) { const [d, , p] = k.split(','); map[d] = Number(p); }
  return (klineCache[secid] = map);
}
let boardCodes = null;
async function boardSecid(name) {
  if (!boardCodes) {
    boardCodes = {};
    for (const fs_ of ['m:90+t:2', 'm:90+t:3']) {
      try {
        const t = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=800&po=1&np=1&fltt=2&fid=f3&fs=${fs_}&fields=f12,f14`);
        for (const x of JSON.parse(t)?.data?.diff || []) boardCodes[x.f14] ??= '90.' + x.f12;
      } catch (e) { log('板块代码抓取失败：' + e.message); }
    }
  }
  if (boardCodes[name]) return boardCodes[name];
  const k = Object.keys(boardCodes).find(n => n.includes(name));
  return k ? boardCodes[k] : null;
}
async function idxPct(a, date) {
  try {
    const secid = a.secid || await boardSecid(a.board);
    if (!secid) return null;
    const v = (await kline(secid))[date];
    return Number.isFinite(v) ? { name: a.name || a.board, pct: v } : null;
  } catch { return null; }
}
for (const e of Object.values(diary.entries)) {
  if (e.date > today) continue;
  const has = e.bench && Object.keys(e.bench.market || {}).length && funds.every(f => e.actual?.[f.code] == null || e.bench.funds?.[f.code]?.length);
  if (has) continue;
  const b = { market: {}, funds: {} };
  for (const [n, id] of MARKET_IDX) { const r = await idxPct({ name: n, secid: id }, e.date); if (r) b.market[n] = r.pct; }
  for (const f of funds) {
    if (e.actual?.[f.code] == null) continue;
    const list = [];
    for (const a of ANCHORS[f.code] || []) { const r = await idxPct(a, e.date); if (r) list.push(r); }
    if (list.length) b.funds[f.code] = list;
  }
  if (Object.keys(b.market).length || Object.keys(b.funds).length) e.bench = b;
}

// ---------- 4. 复盘 ----------
let snap = null;
const getSnap = async () => (snap ??= await snapshot());
const domestic = funds.filter(f => !f.qdii).map(f => f.code);

for (const e of Object.values(diary.entries).sort((a, b) => a.date.localeCompare(b.date))) {
  // QDII 净值晚到：已复盘条目补一句规则点评
  if (e.status === 'reviewed') {
    for (const f of funds) {
      const p = e.preds?.[f.code], a = e.actual?.[f.code];
      if (!p || a == null || e.review?.perFund?.[f.code]) continue;
      e.review ||= {}; e.review.perFund ||= {};
      e.review.perFund[f.code] = `实际${pct(a)}，方向${p.dir === DIR_OF(a) ? '命中' : '未中'}，区间${a >= p.low && a <= p.high ? '命中' : '未中'}（净值晚到，自动补评）。`;
      log(`${e.date} ${f.short} 补录实际涨跌 ${pct(a)}`);
    }
    if (!e.needsAIReview) continue;
  }
  if (e.status !== 'predicted' && !e.needsAIReview) continue;
  if (e.date > today || !domestic.every(c => e.actual[c] != null)) continue;

  const rows = funds.filter(f => e.preds?.[f.code]).map(f => {
    const p = e.preds[f.code], a = e.actual[f.code];
    return `${f.code} ${f.short}：预测 ${p.dir} [${p.low}, ${p.high}]% 信心${p.conf}；依据：${p.basis}；实际 ${a == null ? '净值未出' : pct(a)}${(e.bench?.funds?.[f.code] || []).length ? '；同日锚定指数 ' + e.bench.funds[f.code].map(x => x.name + ' ' + pct(x.pct)).join('、') : ''}`;
  }).join('\n');
  e.status = 'reviewed'; e.reviewedAt = nowStr;
  try {
    const out = await gemini(`你是严谨的基金交易复盘员，用简体中文。下面是对 ${e.date} 的预测和实际净值涨跌（判定：涨跌幅>+0.3%为up，<-0.3%为down，其余flat）。
${rows}

预测时的市场背景：${e.market || '无'}

当日大盘：${Object.entries(e.bench?.market || {}).map(([n, v]) => n + ' ' + pct(v)).join('，') || '未取到'}

复盘时（${nowStr}）抓到的市场数据：
${await getSnap()}

现有经验库：
${lessonBrief()}

要求：
1. perFund：每只基金一句话（40字内），说明预测对或错在哪，错的要指出是哪条依据失效。净值未出的基金写"净值未出，待补"。
2. summary：3-5句，总结哪些判断有效、哪些失效、下次具体怎么调整。只基于给出的数据，不编造未给出的消息。
3. validated：本次复盘被验证的经验编号数组（如["L001"]），没有就空数组。
4. newLessons：最多2条新的可复用经验，每条{tag, text}，tag 从 结构/QDII/方法/板块/情绪/政策/外盘 中选，text 具体可操作、50字内；与已有经验重复的不要写。
5. market：用2-3句概括 ${e.date} 当天市场实际表现。
只输出 JSON：{"perFund":{"代码":"..."},"summary":"...","validated":[],"newLessons":[],"market":"..."}`, `复盘 ${e.date}`);
    e.review = { perFund: out.perFund || {}, summary: String(out.summary || '') };
    if (out.market) e.marketActual = String(out.market);
    for (const id of out.validated || []) { const l = diary.lessons.find(x => x.id === id); if (l) l.uses++; }
    for (const nl of (out.newLessons || []).slice(0, 2)) {
      if (!nl?.text) continue;
      const id = 'L' + String(Math.max(0, ...diary.lessons.map(l => +l.id.slice(1))) + 1).padStart(3, '0');
      diary.lessons.push({ id, tag: nl.tag || '方法', text: String(nl.text), uses: 0, createdAt: today });
    }
    delete e.needsAIReview;
    log(`复盘 ${e.date} 完成`);
  } catch (err) {
    e.needsAIReview = true;
    e.review ||= { perFund: {}, summary: '自动评分已完成；AI 复盘暂未生成，下次运行重试。' };
    log(`复盘 ${e.date} 的 AI 部分失败：${err.message}`);
  }
}

// ---------- 5. 预测 ----------
async function predict(target, note) {
  const recent = Object.values(diary.entries).filter(e => e.status === 'reviewed' && e.review?.summary).sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
    .map(e => `${e.date}：${e.review.summary}`).join('\n') || '无';
  const qdiiNote = `QDII 基金在 ${target} 的净值对应海外 ${target} 当天收盘（北京时间次日清晨收盘），预测它时以美股/港股科技为准。`;
  const out = await gemini(`你是谨慎的基金短线研究员，用简体中文。现在是北京时间 ${nowStr}，请预测下列五只基金在 ${target}（A股交易日）的单位净值涨跌幅。${note}

基金：
${fundBrief()}

${qdiiNote}

最新市场数据：
${await getSnap()}

近期复盘结论：
${recent}

经验库（预测时优先遵守，依据里引用编号）：
${lessonBrief()}

历史成绩：${stats()}

要求：
1. 先判断科技成长整体方向，再给每只基金：dir（up/down/flat，判定阈值±0.3%）、low/high（预测区间，单位%，数字，宽度一般2-7个百分点，信心越低越宽）、conf（低/中/高）、basis（60字内，必须引用上面数据中的具体数字或消息，并引用适用的经验编号）。
2. 信号不清或互相矛盾时用 flat 和低信心，不要硬猜。不得编造上面没有的新闻或数据。
3. market：2-3句概括当前市场背景和最关键的变量。
只输出 JSON：{"market":"...","preds":{"代码":{"dir":"up","low":-1,"high":2,"conf":"中","basis":"..."}}}`, `预测 ${target}`);
  const preds = {};
  for (const f of funds) {
    const p = out.preds?.[f.code]; if (!p) continue;
    let low = Math.max(-12, Math.min(12, Number(p.low))), high = Math.max(-12, Math.min(12, Number(p.high)));
    if (!Number.isFinite(low) || !Number.isFinite(high)) continue;
    if (low > high) [low, high] = [high, low];
    preds[f.code] = { dir: ['up', 'down', 'flat'].includes(p.dir) ? p.dir : 'flat', low: +low.toFixed(1), high: +high.toFixed(1), conf: ['低', '中', '高'].includes(p.conf) ? p.conf : '低', basis: String(p.basis || '') };
  }
  if (Object.keys(preds).length < funds.length) throw new Error(`只得到 ${Object.keys(preds).length} 只基金的预测`);
  return { market: String(out.market || ''), preds };
}

try {
  if (MODE === 'evening') {
    const target = nextTD(today);
    const e = diary.entries[target];
    const isEve = addDays(today, 1) === target || isTD(today);
    if (!e || e.draft || (isEve && e.madeOn !== today && e.status === 'predicted')) {
      if (e?.status === 'reviewed') log(`${target} 已复盘，不再预测`);
      else {
        const r = await predict(target, isTD(today) ? '' : '今天A股休市，请重点参考休市期间外盘累计表现。');
        diary.entries[target] = { date: target, status: 'predicted', madeOn: today, madeAt: nowStr + '（晚间）', actual: e?.actual || {}, ...r };
        log(`已生成 ${target} 预测`);
      }
    } else log(`${target} 预测已存在，跳过`);
  } else if (MODE === 'morning') {
    const e = diary.entries[today];
    if (!isTD(today)) log('今天休市，晨间不更新');
    else if (hourBJ > 9.4) log('已过 9:25，为保证预测在开盘前定稿，晨间不再修改');
    else if (e?.status === 'predicted') {
      const r = await predict(today, '这是开盘前的定稿，美股已收盘，请结合隔夜美股收盘修正昨晚的预测。');
      e.predsEvening ||= e.preds; e.preds = r.preds; e.market = r.market; e.madeAt = nowStr + '（开盘前定稿）'; delete e.draft;
      log(`已用隔夜外盘定稿 ${today} 预测`);
    } else log('今天没有待定稿的预测');
  }
} catch (err) { log('预测失败：' + err.message); }

// ---------- 6. 保存 ----------
write('funds.json', funds);
write('diary.json', diary);
write('status.json', { lastRun: nowStr, mode: MODE, report });
console.log('完成');
