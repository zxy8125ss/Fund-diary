// 基金日记：涨跌预测实验
// 流程：抓净值和指数 → 计算因子 → 回填实际 → 规则模型 / AI / 笨办法基线 各自预测 → 复盘并修正规则（带版本）
// 运行：node scripts/update.mjs（MODE=evening|morning，省略时按北京时间自动判断）
import fs from 'node:fs';

const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
const DIR = new URL('../data/', import.meta.url);
const read = (f, def) => { try { return JSON.parse(fs.readFileSync(new URL(f, DIR), 'utf8')); } catch (e) { if (def !== undefined) return def; throw e; } };
const write = (f, o) => fs.writeFileSync(new URL(f, DIR), typeof o === 'string' ? o : JSON.stringify(o, null, 1) + '\n');

const funds = read('funds.json');
const cal = read('calendar.json');
let strategy = read('strategy.json');
const rec = read('records.json', { days: {} });
const report = [];
const log = s => { console.log(s); report.push(s); };
const CODES = funds.map(f => f.code);
const FUND = Object.fromEntries(funds.map(f => [f.code, f]));

// ---------- 时间 ----------
const bj = (d = new Date()) => new Date(d.getTime() + 8 * 3600e3);
const NOW = bj();
const today = NOW.toISOString().slice(0, 10);
const nowStr = NOW.toISOString().slice(0, 16).replace('T', ' ');
const hourBJ = NOW.getUTCHours() + NOW.getUTCMinutes() / 60;
const MODE = process.env.MODE || (hourBJ < 12 ? 'morning' : 'evening');
const addDays = (ds, n) => { const d = new Date(ds + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dayNum = ds => Date.parse(ds + 'T00:00:00Z') / 864e5;
const weekday = ds => new Date(ds + 'T00:00:00Z').getUTCDay();
const isTD = ds => { const w = weekday(ds); return w > 0 && w < 6 && !cal.holidays.includes(ds); };
const nextTD = ds => { let d = addDays(ds, 1); for (let i = 0; i < 40 && !isTD(d); i++) d = addDays(d, 1); return d; };
if (today.slice(5) >= '12-15' && !cal.holidays.some(h => h.startsWith(String(+today.slice(0, 4) + 1)))) log('提醒：data/calendar.json 缺少来年休市安排');

// ---------- 网络 ----------
async function get(url, { headers = {}, encoding = 'utf-8', timeout = 20000, tries = 3 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36', ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return new TextDecoder(encoding).decode(await r.arrayBuffer());
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 2500 * (i + 1))); }
    finally { clearTimeout(t); }
  }
  throw err;
}
const pct = v => v == null || !Number.isFinite(+v) ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';
const r2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;

// ---------- 1. 行情数据 ----------
const IDX = { sh: ['上证指数', '1.000001'], cyb: ['创业板指', '0.399006'], kc50: ['科创50', '1.000688'], ndx: ['纳斯达克100', '100.NDX'], sox: ['费城半导体', '100.SOX'], hstech: ['恒生科技', '124.HSTECH'] };
const ANCHORS = { '002910': '半导体', '024481': 'PCB', '015060': '元件' };  // 板块锚；QDII 用纳指100，国寿用创业板指

async function kline(secid) {
  const t = await get(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=200&end=20500101&fields1=f1,f2,f3&fields2=f51,f53,f59`);
  const map = {};
  for (const k of JSON.parse(t)?.data?.klines || []) { const [d, , p] = k.split(','); if (Number.isFinite(+p)) map[d] = +p; }
  if (!Object.keys(map).length) throw new Error('空');
  return map;
}
async function navHist(code) {
  try {
    const t = await get(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`);
    const m = t.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('无净值数据');
    const map = {};
    for (const p of JSON.parse(m[1]).slice(-200)) if (Number.isFinite(+p.equityReturn)) map[bj(new Date(p.x)).toISOString().slice(0, 10)] = +p.equityReturn;
    return map;
  } catch (e) {
    const t = await get(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=200`, { headers: { referer: 'https://fundf10.eastmoney.com/' } });
    const map = {};
    for (const p of JSON.parse(t)?.Data?.LSJZList || []) if (Number.isFinite(+p.JZZZL)) map[p.FSRQ] = +p.JZZZL;
    if (!Object.keys(map).length) throw e;
    return map;
  }
}
let boardCodes = null;
async function boardSecid(name) {
  if (!boardCodes) {
    boardCodes = {};
    for (const fs_ of ['m:90+t:2', 'm:90+t:3']) {
      try {
        const t = await get(`https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=800&po=1&np=1&fltt=2&fid=f3&fs=${fs_}&fields=f12,f14`);
        for (const x of JSON.parse(t)?.data?.diff || []) boardCodes[x.f14] ??= '90.' + x.f12;
      } catch (e) { log('板块列表抓取失败：' + e.message); }
    }
  }
  return boardCodes[name] || boardCodes[Object.keys(boardCodes).find(n => n.includes(name))] || null;
}

// Yahoo Finance（GitHub 美国服务器访问稳定）为主，东方财富为备用
const YAHOO = { sh: ['000001.SS'], cyb: ['399006.SZ'], kc50: ['000688.SS'], ndx: ['^NDX'], sox: ['^SOX'], hstech: ['^HSTECH', '3033.HK'] };
const YAHOO_BOARD = { '半导体': ['512480.SS'], 'PCB': ['515260.SS'], '元件': ['515260.SS'] };
async function yahoo(sym) {
  const t = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=1y&interval=1d`);
  const j = JSON.parse(t)?.chart?.result?.[0]; if (!j?.timestamp) throw new Error('空');
  const off = j.meta?.gmtoffset || 0, c = j.indicators.quote[0].close, map = {};
  let prev = null;
  j.timestamp.forEach((ts, i) => { const v = c[i]; if (v == null) return; if (prev != null) map[new Date((ts + off) * 1000).toISOString().slice(0, 10)] = +((v / prev - 1) * 100).toFixed(2); prev = v; });
  if (!Object.keys(map).length) throw new Error('空');
  return map;
}
async function series(name, yahooSyms, emSecid) {
  for (const s of yahooSyms || []) { try { return await yahoo(s); } catch (e) { console.error(`${name} Yahoo ${s}：${e.message}`); } }
  if (emSecid) { try { return await kline(emSecid); } catch (e) { console.error(`${name} 东财：${e.message}`); } }
  log(`${name} 行情抓取失败`); return {};
}
const K = {};
for (const [k, [name, secid]] of Object.entries(IDX)) K[k] = await series(name, YAHOO[k], secid);
const NAV = {}, ANC = {};
for (const f of funds) {
  try { NAV[f.code] = await navHist(f.code); } catch (e) { log(`${f.short} 净值抓取失败：${e.message}`); NAV[f.code] = {}; }
  if (f.qdii) ANC[f.code] = { name: '纳斯达克100', map: K.ndx };
  else if (ANCHORS[f.code]) {
    const nm = ANCHORS[f.code];
    let map = {};
    try { const id = await boardSecid(nm); if (id) map = await kline(id); } catch (e) { console.error(`${nm} 东财板块：${e.message}`); }
    if (!Object.keys(map).length) map = await series(nm + '（ETF 代替）', YAHOO_BOARD[nm], null);
    ANC[f.code] = { name: nm, map };
  } else ANC[f.code] = { name: '创业板指', map: K.cyb };
}

// 1a. 滚动持仓金额（不加减仓的前提下）
for (const f of funds) {
  const fresh = Object.entries(NAV[f.code]).filter(([d]) => d > f.navDate).sort();
  for (const [d, p] of fresh) { const delta = f.amount * p / 100; f.amount = +(f.amount + delta).toFixed(2); f.pnl = +(f.pnl + delta).toFixed(2); f.navDate = d; }
  f.pnlPct = +(f.pnl / (f.amount - f.pnl) * 100).toFixed(2);
}

// ---------- 2. 因子 ----------
// 预测日 T 的因子只用 T 开盘前已知的信息：A 股取上一交易日，美股/港股取 T 之前最近一个交易日
const sortedKeys = m => Object.keys(m).sort();
const lastBefore = (m, T) => { const d = sortedKeys(m).filter(x => x < T).at(-1); return d ? { date: d, pct: m[d] } : null; };
const lastN = (m, T, n) => sortedKeys(m).filter(d => d < T).slice(-n).map(d => m[d]);
const sum = a => a.length ? a.reduce((s, x) => s + x, 0) : null;
const stdev = a => { if (a.length < 5) return null; const mu = a.reduce((s, x) => s + x, 0) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - mu) ** 2, 0) / (a.length - 1)); };
const tdays = sortedKeys(K.sh).length ? sortedKeys(K.sh) : sortedKeys(NAV[funds.find(f => !f.qdii).code]);

function features(T) {
  const P = tdays.filter(d => d < T).at(-1);
  const c = {
    sh_prev: P ? r2(K.sh[P]) : null, cyb_prev: P ? r2(K.cyb[P]) : null, kc50_prev: P ? r2(K.kc50[P]) : null,
    kc50_mom5: r2(sum(lastN(K.kc50, T, 5))),
    ndx_on: r2(lastBefore(K.ndx, T)?.pct), sox_on: r2(lastBefore(K.sox, T)?.pct), hstech_prev: r2(lastBefore(K.hstech, T)?.pct),
    gap: P ? dayNum(T) - dayNum(P) : null, wd: weekday(T), guxia: null,
  };
  const f = {};
  for (const fd of funds) {
    const prev = lastBefore(NAV[fd.code], T);
    const anc = lastBefore(ANC[fd.code].map, T);
    f[fd.code] = {
      prev: r2(prev?.pct), mom5: r2(sum(lastN(NAV[fd.code], T, 5))), anc: r2(anc?.pct),
      dev: prev && anc && prev.date === anc.date ? r2(prev.pct - anc.pct) : null,
      vol20: r2(stdev(lastN(NAV[fd.code], T, 20))),
    };
  }
  return { c, f };
}

// ---------- 3. 规则模型 ----------
const VARS = ['sh_prev', 'cyb_prev', 'kc50_prev', 'kc50_mom5', 'ndx_on', 'sox_on', 'hstech_prev', 'gap', 'wd', 'guxia', 'prev', 'mom5', 'anc', 'dev', 'vol20', 'qdii'];
const OK_IDS = new Set([...VARS, 'Math', 'abs', 'max', 'min', 'true', 'false']);
const compiled = new Map();
function compile(expr) {
  if (compiled.has(expr)) return compiled.get(expr);
  if (typeof expr !== 'string' || expr.length > 200 || !/^[\w\s.<>=!&|()+\-*\/?:]+$/.test(expr)) throw new Error('表达式不合法：' + expr);
  for (const id of expr.match(/[A-Za-z_]\w*/g) || []) if (!OK_IDS.has(id)) throw new Error('未知变量：' + id);
  const fn = new Function(...VARS, 'Math', `"use strict";return (${expr});`);
  fn(...VARS.map(() => 0), Math);  // 试跑
  compiled.set(expr, fn); return fn;
}
function fires(rule, feat, code) {
  if (rule.fund !== '*' && rule.fund !== code) return false;
  const v = { ...feat.c, ...feat.f[code], qdii: !!FUND[code].qdii };
  try { return !!compile(rule.when)(...VARS.map(k => k === 'qdii' ? v.qdii : (v[k] == null ? NaN : v[k])), Math); } catch { return false; }
}
const DIR_OF = v => v > 0.3 ? 'up' : v < -0.3 ? 'down' : 'flat';   // 只用于把因子转成笨办法的方向
const ACT = v => v > 0 ? 'up' : v < 0 ? 'down' : 'flat';             // 实际方向：按正负
function rulePredict(strat, feat, code) {
  let score = 0; const fired = [];
  for (const r of strat.rules) if (fires(r, feat, code)) { fired.push(r.id); if (r.status === 'active') score += r.vote * r.weight; }
  const th = strat.params?.th ?? 0.75;
  const dir = score >= th ? 'up' : score <= -th ? 'down' : 'flat';
  const sg = feat.f[code].vol20 || 2;
  const center = dir === 'up' ? 0.5 * sg : dir === 'down' ? -0.5 * sg : 0;
  return { dir, low: r2(center - 0.9 * sg), high: r2(center + 0.9 * sg), score: r2(score), conf: Math.abs(score) >= 2 ? '高' : Math.abs(score) >= 1 ? '中' : '低', fired };
}
function baselines(feat, code) {
  const ff = feat.f[code]; const us = FUND[code].qdii ? feat.c.ndx_on : feat.c.sox_on;
  return { base_prev: ff.prev == null ? null : DIR_OF(ff.prev), base_up: 'up', base_us: us == null ? null : DIR_OF(us) };
}
function buildPreds(strat, feat) {
  const p = { rule: {}, base_prev: {}, base_up: {}, base_us: {} };
  for (const c of CODES) { p.rule[c] = rulePredict(strat, feat, c); const b = baselines(feat, c); for (const k in b) p[k][c] = b[k]; }
  return p;
}

// ---------- 4. 回测（用当前规则版本，覆盖最近约 120 个交易日） ----------
function backtest(strat) {
  const days = {};
  for (const T of tdays.slice(-120)) {
    if (T < tdays[25]) continue;  // 留足计算因子的历史
    const actual = {}; for (const c of CODES) if (NAV[c][T] != null) actual[c] = NAV[c][T];
    if (!Object.keys(actual).length) continue;
    const feat = features(T);
    days[T] = { date: T, phase: 'backtest', features: feat, preds: buildPreds(strat, feat), actual };
  }
  return days;
}

// ---------- 5. 统计 ----------
const PREDICTORS = ['rule', 'ai', 'base_prev', 'base_up', 'base_us'];
function lnC(n, k) { let s = 0; for (let i = 1; i <= k; i++) s += Math.log((n - k + i) / i); return s; }
function pUpper(n, k, p0) { if (!n) return null; let s = 0; for (let i = k; i <= n; i++) s += Math.exp(lnC(n, i) + i * Math.log(p0) + (n - i) * Math.log(1 - p0)); return Math.min(1, s); }
function tally(dayList, predictor, codeFilter) {
  let n = 0, hit = 0, rn = 0, rhit = 0, tot = 0;
  for (const d of dayList) for (const c of CODES) {
    if (codeFilter && c !== codeFilter) continue;
    const a = d.actual?.[c]; const p = d.preds?.[predictor]?.[c];
    if (a == null || p == null) continue;
    const dir = typeof p === 'string' ? p : p.dir;
    tot++;
    if (typeof p === 'object' && p.low != null) { rn++; rhit += a >= p.low && a <= p.high; }
    if (dir === 'flat') continue;   // 判平＝不出手
    n++; hit += dir === ACT(a);
  }
  return { n, hit, rate: n ? r2(hit / n * 100) : null, total: tot, cover: tot ? r2(n / tot * 100) : null, rangeRate: rn ? r2(rhit / rn * 100) : null };
}
function ruleScorecard(strat, dayList) {
  return strat.rules.map(r => {
    let n = 0, hit = 0;
    for (const d of dayList) for (const c of CODES) {
      const a = d.actual?.[c]; if (a == null || !d.features) continue;
      if (!fires(r, d.features, c)) continue;
      n++; hit += (r.vote > 0 ? a > 0 : a < 0);
    }
    return { id: r.id, n, hit, rate: n ? r2(hit / n * 100) : null };
  });
}
function computeStats(bt) {
  const live = Object.values(rec.days).filter(d => d.phase === 'live');
  const btDays = Object.values(bt);
  const out = { updatedAt: nowStr, strategyVersion: strategy.version, predictors: {}, byFund: {}, rules: [], rolling: [], versions: {} };
  for (const p of PREDICTORS) out.predictors[p] = { live: tally(live, p), backtest: p === 'ai' ? null : tally(btDays, p) };
  // p 值：命中是否显著高于同期最好的笨办法
  for (const p of ['rule', 'ai']) for (const ph of ['live', 'backtest']) {
    const s = out.predictors[p][ph]; if (!s?.n) continue;
    const best = Math.max(...['base_prev', 'base_up', 'base_us'].map(b => out.predictors[b][ph]?.rate || 0));
    const p0 = Math.min(0.95, Math.max(0.05, best / 100));
    s.vsBest = r2(best); s.p = Math.round(pUpper(s.n, s.hit, p0) * 1000) / 1000;
  }
  for (const c of CODES) out.byFund[c] = Object.fromEntries(PREDICTORS.map(p => [p, { live: tally(live, p, c), backtest: p === 'ai' ? null : tally(btDays, p, c) }]));
  out.rules = ruleScorecard(strategy, [...btDays, ...live]);
  const ld = live.filter(d => d.status === 'reviewed').sort((a, b) => a.date.localeCompare(b.date));
  const acc = Object.fromEntries(PREDICTORS.map(p => [p, { n: 0, h: 0 }]));
  for (const d of ld) {
    const row = { date: d.date };
    for (const p of PREDICTORS) { const t = tally([d], p); acc[p].n += t.n; acc[p].h += t.hit; row[p] = acc[p].n ? r2(acc[p].h / acc[p].n * 100) : null; }
    out.rolling.push(row);
    const v = d.strategyVersion; out.versions[v] ||= { n: 0, hit: 0 }; const t = tally([d], 'rule'); out.versions[v].n += t.n; out.versions[v].hit += t.hit;
  }
  return out;
}

// ---------- 6. Gemini ----------
function parseJson(t) { const s = t.replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('输出中没有 JSON'); return JSON.parse(s.slice(a, b + 1)); }
async function gemini(text, label) {
  if (!KEY) throw new Error('缺少 GEMINI_API_KEY');
  for (const model of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }) });
      if (r.ok) { const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); if (t.trim()) { console.log(`${label}：${model}`); return parseJson(t); } }
      else console.error(`${label}：${model} ${r.status} ${(await r.text()).slice(0, 160)}`);
    } catch (e) { console.error(`${label}：${model} ${e.message}`); }
    await new Promise(res => setTimeout(res, 13000));
  }
  throw new Error('Gemini 不可用');
}

// 市场快讯（给 AI 判断用）
const NEWS_KEYS = /半导体|芯片|PCB|覆铜板|MLCC|光模块|英伟达|台积电|美联储|关税|出口管制|央行|降准|降息|证监会|科创|纳斯达克|美股|港股|A股|算力|AI|存储|汇率|国务院/;
async function news() {
  try {
    const t = await get(`https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=100&req_trace=${Date.now()}`);
    const list = JSON.parse(t)?.data?.fastNewsList || []; if (!list.length) throw new Error('空');
    return list.map(n => `[${String(n.showTime).slice(5, 16)}] ${n.title || ''}：${(n.summary || '').slice(0, 100)}`).filter(s => NEWS_KEYS.test(s)).slice(0, 30);
  } catch {
    try {
      const t = await get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1');
      return (JSON.parse(t)?.result?.data?.feed?.list || []).map(n => `[${String(n.create_time).slice(5, 16)}] ${String(n.rich_text).replace(/<[^>]+>/g, '').slice(0, 120)}`).filter(s => NEWS_KEYS.test(s)).slice(0, 30);
    } catch (e) { log('快讯抓取失败：' + e.message); return []; }
  }
}

// 天津股侠（观察信号）：抓主页文字，让 Gemini 判断他对下一交易日大盘的倾向
async function guxia(sinceDate) {
  const t = await get('https://www.sina.cn/media/1896820725');
  const text = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ').replace(/\s+/g, ' ').slice(0, 9000);
  if (text.length < 200) throw new Error('页面内容过少');
  const out = await gemini(`下面是财经博主「天津股侠」主页抓取到的文字（夹杂页面杂项）。现在是北京时间 ${nowStr}。只看 ${sinceDate} 15:00 之后发布的内容，判断他对下一个A股交易日大盘的倾向。
stance：2=明确看多，1=偏多，0=中性或没有方向性判断，-1=偏空，-2=明确看空；如果这段时间没有可识别的帖子，stance 填 null。
summary：30字内概括他的观点（用自己的话，不要照抄）。
只输出 JSON：{"stance":0,"summary":"...","posts":0}

${text}`, '股侠立场');
  const s = out.stance == null ? null : Math.max(-2, Math.min(2, Math.round(+out.stance)));
  return { stance: Number.isFinite(s) ? s : null, summary: String(out.summary || ''), posts: +out.posts || 0, at: nowStr };
}

const featText = feat => `公共因子：${Object.entries(feat.c).map(([k, v]) => `${k}=${v ?? '无'}`).join('，')}\n` +
  funds.map(f => `${f.code} ${f.short}${f.qdii ? '(QDII)' : ''}：${Object.entries(feat.f[f.code]).map(([k, v]) => `${k}=${v ?? '无'}`).join('，')}`).join('\n');
const VAR_DOC = `因子说明（单位%）：sh_prev/cyb_prev/kc50_prev=上一交易日上证/创业板/科创50涨跌；kc50_mom5=科创50近5日累计；ndx_on/sox_on=预测日开盘前最近一个美股交易日纳指100/费城半导体涨跌；hstech_prev=最近一个港股交易日恒生科技涨跌；gap=距上一交易日的自然日天数（≥4为长假后）；wd=星期几(1-5)；guxia=天津股侠立场(-2~2，可能为空)；prev=该基金上一净值日涨跌；mom5=该基金近5日累计；anc=锚定指数上一交易日涨跌（易方达→半导体板块，财通→PCB，华夏节能→元件，华夏全球→纳指100，国寿→创业板指）；dev=prev-anc；vol20=近20日波动率；qdii=是否QDII（true/false）。注意QDII在T日的净值对应海外T日收盘，开盘前无法知道。`;

// ---------- 7. 复盘：回填实际、AI 复盘、提出规则修改 ----------
const domestic = funds.filter(f => !f.qdii).map(f => f.code);
let bt = backtest(strategy);
for (const d of Object.values(rec.days)) {
  d.actual ||= {};
  for (const c of CODES) if (d.actual[c] == null && NAV[c][d.date] != null) d.actual[c] = NAV[c][d.date];
}
const toReview = Object.values(rec.days).filter(d => d.phase === 'live' && d.status === 'pending' && d.date <= today && domestic.every(c => d.actual[c] != null));
let stats = computeStats(bt);

for (const d of toReview) {
  d.status = 'reviewed'; d.reviewedAt = nowStr;
  const table = funds.map(f => {
    const a = d.actual[f.code]; const pr = d.preds;
    return `${f.short}：实际 ${pct(a)}｜规则 ${pr.rule?.[f.code]?.dir}(得分${pr.rule?.[f.code]?.score}，触发${(pr.rule?.[f.code]?.fired || []).join('/') || '无'})｜AI ${pr.ai?.[f.code]?.dir ?? '无'}｜昨日延续 ${pr.base_prev?.[f.code]}｜跟随外盘 ${pr.base_us?.[f.code]}`;
  }).join('\n');
  const score = r => { const s = stats.rules.find(x => x.id === r.id); return `${r.id}${r.status === 'shadow' ? '(观察)' : ''}［${r.fund}］${r.name}：when ${r.when} → ${r.vote > 0 ? '看涨' : '看跌'} 权重${r.weight}｜历史触发${s?.n ?? 0}次，命中${s?.rate ?? '–'}%`; };
  try {
    const out = await gemini(`你是量化研究员，在做"基金单日涨跌能否预测"的实验，用简体中文。今天复盘 ${d.date}。
判定：实际涨跌按正负算涨或跌；预测flat表示不出手（不计入命中率，但出手率太低也说明没本事）。

当日各预测方 vs 实际：
${table}

当日因子：
${featText(d.features)}
${VAR_DOC}
${d.guxia ? `天津股侠当时观点：${d.guxia.summary}（stance ${d.guxia.stance}）` : ''}

累计成绩（方向命中率）：
${PREDICTORS.map(p => `${p}：实盘 ${stats.predictors[p].live.rate ?? '–'}%（${stats.predictors[p].live.n}次）${stats.predictors[p].backtest ? `，回测 ${stats.predictors[p].backtest.rate}%（${stats.predictors[p].backtest.n}次）` : ''}`).join('\n')}

当前规则（v${strategy.version}，阈值 th=${strategy.params.th}：得分≥th看涨，≤-th看跌，否则平）：
${strategy.rules.map(score).join('\n')}

近期修改记录：
${strategy.changelog.slice(-5).map(c => `v${c.version} ${c.date}：${c.changes}`).join('\n')}

任务：
1. summary：3-5句复盘，说清今天哪些信号有效、哪些失效，以及规则模型和AI谁更准、为什么。
2. proposal：如果有依据，给出修改后的完整规则列表（不改就填 null）。可以调整阈值/权重、删掉长期无效的规则、加入新规则；鼓励尝试非常规的"野路子"组合，但新想法一律先设为 status:"shadow"（只记录不计分），等历史命中率证明有效再改成 active。规则只能使用上面列出的因子变量，表达式只能用变量、数字、比较和逻辑运算（&& || ! ? :）、Math.abs。每条：{"id":"R1","fund":"*或基金代码","name":"中文说明","when":"表达式","vote":1或-1,"weight":0~2,"status":"active或shadow"}。最多20条。
3. ideas：需要新数据才能实现的野路子想法（最多2条，一句话一条），没有就空数组。
样本很少时不要大改；系统会用回测检验你的修改，变差的修改会被拒绝。
只输出 JSON：{"summary":"...","proposal":{"changes":"改了什么","reason":"为什么","th":0.75,"rules":[...]} 或 null,"ideas":[]}`, `复盘 ${d.date}`);
    d.review = { summary: String(out.summary || '') };
    for (const idea of (out.ideas || []).slice(0, 2)) if (idea && !strategy.ideas.some(x => x.text === idea)) strategy.ideas.push({ text: String(idea), date: today });
    const pp = out.proposal;
    if (pp?.rules?.length) {
      try {
        const rules = pp.rules.slice(0, 20).map((r, i) => {
          const rr = { id: String(r.id || 'X' + i).slice(0, 8), fund: r.fund === '*' || CODES.includes(r.fund) ? r.fund : '*', name: String(r.name || '').slice(0, 40), when: String(r.when), vote: +r.vote > 0 ? 1 : -1, weight: Math.max(0, Math.min(2, +r.weight || 0)), status: r.status === 'active' ? 'active' : 'shadow', since: strategy.rules.find(x => x.id === r.id)?.since || today };
          compile(rr.when); return rr;
        });
        if (new Set(rules.map(r => r.id)).size !== rules.length) throw new Error('规则编号重复');
        // 保护：观察规则没被证明无效前不随意删除；正式规则一次最多删 2 条
        for (const old of strategy.rules) {
          if (rules.some(r => r.id === old.id)) continue;
          const s = stats.rules.find(x => x.id === old.id);
          if (old.status === 'shadow' && !(s?.n >= 20 && s.rate < 50)) rules.push(old);
        }
        const droppedActive = strategy.rules.filter(o => o.status === 'active' && !rules.some(r => r.id === o.id)).length;
        if (droppedActive > 2) throw new Error(`一次删除 ${droppedActive} 条正式规则，过多`);
        const cand = { ...strategy, params: { ...strategy.params, th: Math.max(0.25, Math.min(3, +pp.th || strategy.params.th)) }, rules };
        const liveDays = Object.values(rec.days).filter(x => x.phase === 'live' && x.features);
        const oldRate = tally([...Object.values(bt), ...liveDays], 'rule').rate ?? 0;
        const candBt = backtest(cand);
        const candLive = liveDays.map(x => ({ ...x, preds: { rule: Object.fromEntries(CODES.map(c => [c, rulePredict(cand, x.features, c)])) } }));
        const newRate = tally([...Object.values(candBt), ...candLive], 'rule').rate ?? 0;
        const entry = { date: today, changes: String(pp.changes || ''), reason: String(pp.reason || ''), before: oldRate, after: newRate };
        if (newRate >= oldRate - 0.5) {
          strategy = { ...cand, version: strategy.version + 1, updatedAt: nowStr };
          strategy.changelog.push({ version: strategy.version, ...entry });
          bt = candBt;
          log(`规则更新到 v${strategy.version}（命中 ${oldRate}% → ${newRate}%）`);
        } else {
          strategy.rejected = [...(strategy.rejected || []).slice(-19), entry];
          log(`规则修改被拒：命中 ${oldRate}% → ${newRate}%`);
        }
      } catch (e) { log('规则修改无效：' + e.message); }
    }
    log(`复盘 ${d.date} 完成`);
  } catch (e) { d.review = { summary: 'AI 复盘失败：' + e.message }; log(`复盘 ${d.date} 的 AI 部分失败`); }
  stats = computeStats(bt);
}

// ---------- 8. 预测 ----------
let newsCache = null;
async function aiPredict(T, feat, rulePreds, note) {
  newsCache ??= await news();
  const recent = Object.values(rec.days).filter(d => d.review?.summary && d.phase === 'live').sort((a, b) => b.date.localeCompare(a.date)).slice(0, 4).map(d => `${d.date}：${d.review.summary}`).join('\n') || '无';
  const out = await gemini(`你在做"基金单日涨跌能否预测"的实验，用简体中文。现在是北京时间 ${nowStr}，请独立判断五只基金在 ${T} 的净值涨跌。${note}
判定：实际按正负算涨跌；flat表示不出手，不计入命中率。只在有把握时出手。

基金：
${funds.map(f => `${f.code} ${f.name}：${f.drivers.join('；')}`).join('\n')}

预测日因子：
${featText(feat)}
${VAR_DOC}

规则模型 v${strategy.version} 的判断：${CODES.map(c => `${FUND[c].short} ${rulePreds[c].dir}(得分${rulePreds[c].score})`).join('，')}
成绩（方向命中率）：AI 实盘 ${stats.predictors.ai.live.rate ?? '–'}%（${stats.predictors.ai.live.n}次）；规则 实盘 ${stats.predictors.rule.live.rate ?? '–'}%，回测 ${stats.predictors.rule.backtest?.rate ?? '–'}%；笨办法"昨日延续"回测 ${stats.predictors.base_prev.backtest?.rate ?? '–'}%，"跟随外盘"回测 ${stats.predictors.base_us.backtest?.rate ?? '–'}%，"全猜涨"回测 ${stats.predictors.base_up.backtest?.rate ?? '–'}%。
${feat.c.guxia != null ? `天津股侠最新立场 ${feat.c.guxia}` : ''}
近期复盘：
${recent}

相关快讯：
${newsCache.join('\n') || '无'}

要求：可以同意也可以推翻规则模型；basis 60字内，必须引用具体因子数值或快讯；信号不清就给 flat 和低信心。区间 low/high 单位%，宽度参考 vol20。
只输出 JSON：{"market":"2句市场背景","preds":{"代码":{"dir":"up","low":-1,"high":2,"conf":"低/中/高","basis":"..."}}}`, `AI 预测 ${T}`);
  const preds = {};
  for (const c of CODES) {
    const p = out.preds?.[c]; if (!p) continue;
    let lo = +p.low, hi = +p.high; if (!Number.isFinite(lo) || !Number.isFinite(hi)) continue; if (lo > hi) [lo, hi] = [hi, lo];
    preds[c] = { dir: ['up', 'down', 'flat'].includes(p.dir) ? p.dir : 'flat', low: r2(Math.max(-12, lo)), high: r2(Math.min(12, hi)), conf: ['低', '中', '高'].includes(p.conf) ? p.conf : '低', basis: String(p.basis || '') };
  }
  return { market: String(out.market || ''), preds };
}

async function makePrediction(T, phaseNote, keepEvening) {
  const feat = features(T);
  const old = rec.days[T];
  const gx = old?.guxia || null;
  if (gx?.stance != null) feat.c.guxia = gx.stance;
  const preds = buildPreds(strategy, feat);
  const day = { date: T, phase: 'live', status: 'pending', strategyVersion: strategy.version, madeAt: nowStr + phaseNote, features: feat, preds, actual: old?.actual || {}, guxia: gx };
  if (keepEvening && old?.preds) day.predsEvening = old.preds;
  try {
    const note = phaseNote.includes('定稿') ? '这是开盘前定稿，隔夜美股已收盘。' : (isTD(today) ? '' : '今天A股休市，注意休市期间外盘累计表现。');
    const ai = await aiPredict(T, feat, preds.rule, note); day.preds.ai = ai.preds; day.market = ai.market;
  } catch (e) { log('AI 预测失败：' + e.message); if (old?.preds?.ai) day.preds.ai = old.preds.ai; }
  rec.days[T] = day;
  log(`已生成 ${T} 预测（规则 v${strategy.version}${day.preds.ai ? ' + AI' : ''}）`);
}

try {
  if (MODE === 'evening') {
    const T = nextTD(today);
    const e = rec.days[T];
    const isEve = addDays(today, 1) === T || isTD(today);
    if (e?.status === 'reviewed') log(`${T} 已复盘`);
    else if (!e || !e.features || e.features.c.sh_prev == null || e.features.c.sox_on == null || (isEve && !String(e.madeAt || '').startsWith(today))) {
      const P = tdays.filter(d => d < T).at(-1) || today;
      let gx = null;
      try { gx = await guxia(P); log(`天津股侠：${gx.stance ?? '无观点'} ${gx.summary}`); } catch (err) { log('天津股侠抓取失败：' + err.message); }
      if (gx) rec.days[T] = { ...(e || {}), guxia: gx };
      await makePrediction(T, '（晚间）', false);
    } else log(`${T} 预测已存在`);
  } else {
    const e = rec.days[today];
    if (!isTD(today)) log('今天休市');
    else if (hourBJ > 9.4) log('已过 9:25，不再修改当日预测');
    else if (e?.status === 'pending') await makePrediction(today, '（开盘前定稿）', true);
    else log('没有待定稿的预测');
  }
} catch (e) { log('预测失败：' + e.message); }

// ---------- 9. 保存 ----------
stats = computeStats(bt);
write('funds.json', funds);
write('records.json', rec);
write('backtest.json', { strategyVersion: strategy.version, generatedAt: nowStr, days: bt });
write('strategy.json', strategy);
write('stats.json', stats);
const csv = ['日期,阶段,规则版本,基金代码,基金,规则方向,规则得分,规则区间低,规则区间高,AI方向,AI区间低,AI区间高,AI信心,昨日延续,全猜涨,跟随外盘,股侠立场,实际涨跌,规则命中,AI命中'];
for (const d of [...Object.values(bt), ...Object.values(rec.days).filter(x => x.phase === 'live')].sort((a, b) => a.date.localeCompare(b.date))) {
  for (const f of funds) {
    const p = d.preds || {}, a = d.actual?.[f.code], rl = p.rule?.[f.code], ai = p.ai?.[f.code];
    csv.push([d.date, d.phase === 'live' ? '实盘' : '回测', d.strategyVersion ?? strategy.version, f.code, f.short, rl?.dir ?? '', rl?.score ?? '', rl?.low ?? '', rl?.high ?? '', ai?.dir ?? '', ai?.low ?? '', ai?.high ?? '', ai?.conf ?? '', p.base_prev?.[f.code] ?? '', p.base_up?.[f.code] ?? '', p.base_us?.[f.code] ?? '', d.guxia?.stance ?? '', a ?? '', a == null || !rl || rl.dir === 'flat' ? '' : +(rl.dir === ACT(a)), a == null || !ai || ai.dir === 'flat' ? '' : +(ai.dir === ACT(a))].join(','));
  }
}
write('records.csv', '﻿' + csv.join('\n') + '\n');
write('status.json', { lastRun: nowStr, mode: MODE, report });
console.log('完成');
