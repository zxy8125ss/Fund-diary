// 基金日记 v2.1 · 实验引擎（设计见 docs/DESIGN.md，审查见 docs/REVIEW-v2.1.md）
// 每次运行：存行情（只追加）→ 结算所有待结算日 → 信号状态（每天一次）→ 模型门槛 → 若在时间窗内，生成批次
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { ROOT, P, exists, readJ, writeJ, writeOnce, appendLine, CFG, toBJ, ms, at, addDays, dayNum, weekday, deadlineOf, makeCalendar, tri, r2, r3, sha256, checkReasons, batchAsOf } from './lib.mjs';

const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
const PROMPT_VERSION = 'draft-3';
const funds = readJ(P('funds.json'));
const holdings = readJ(P('state', 'holdings.json'), {});
for (const f of funds) f.holding = holdings[f.code] || f.holding;
const index = readJ(P('index.json'), { days: {} });
const report = [];
const log = s => { console.log(s); report.push(s); };
const CODES = funds.map(f => f.code);
const FUND = Object.fromEntries(funds.map(f => [f.code, f]));
const RUN = { id: process.env.GITHUB_RUN_ID || 'local', trigger: process.env.GITHUB_EVENT_NAME || 'local' };

const NOWMS = Number(process.env.NOW_MS || Date.now());
const nowISO = toBJ(NOWMS);
const today = nowISO.slice(0, 10);
const hm = nowISO.slice(11, 16);

// ---------- 网络 ----------
async function get(url, { headers = {}, timeout = 20000, tries = 3 } = {}) {
  let err;
  for (let i = 0; i < tries; i++) {
    const ctrl = new AbortController(); const t = setTimeout(() => ctrl.abort(), timeout);
    try {
      const r = await fetch(url, { signal: ctrl.signal, headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/128 Safari/537.36', ...headers } });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return await r.text();
    } catch (e) { err = e; await new Promise(res => setTimeout(res, 2500 * (i + 1))); }
    finally { clearTimeout(t); }
  }
  throw err;
}
const pct = v => v == null || !Number.isFinite(+v) ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';

// ---------- 1. 行情：抓取后并入本地序列（只追加；数据商改了历史值只记录修订，不覆盖） ----------
async function emKline(secid) {
  const t = await get(`https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}&klt=101&fqt=1&lmt=300&end=20500101&fields1=f1,f2,f3&fields2=f51,f53,f59`);
  const map = {};
  for (const k of JSON.parse(t)?.data?.klines || []) { const [d, , p] = k.split(','); if (Number.isFinite(+p)) map[d] = +p; }
  if (!Object.keys(map).length) throw new Error('空');
  return map;
}
async function yahoo(sym) {
  const t = await get(`https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?range=2y&interval=1d`);
  const j = JSON.parse(t)?.chart?.result?.[0]; if (!j?.timestamp) throw new Error('空');
  const off = j.meta?.gmtoffset || 0, c = j.indicators.quote[0].close, map = {};
  let prev = null;
  j.timestamp.forEach((ts, i) => { const v = c[i]; if (v == null) return; if (prev != null) map[new Date((ts + off) * 1000).toISOString().slice(0, 10)] = +((v / prev - 1) * 100).toFixed(2); prev = v; });
  if (!Object.keys(map).length) throw new Error('空');
  return map;
}
async function navHist(code) {
  try {
    const t = await get(`https://fund.eastmoney.com/pingzhongdata/${code}.js?v=${Date.now()}`);
    const m = t.match(/Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
    if (!m) throw new Error('无净值数据');
    const map = {};
    for (const p of JSON.parse(m[1]).slice(-320)) if (Number.isFinite(+p.equityReturn)) map[toBJ(p.x).slice(0, 10)] = +p.equityReturn;
    return map;
  } catch (e) {
    const t = await get(`https://api.fund.eastmoney.com/f10/lsjz?fundCode=${code}&pageIndex=1&pageSize=300`, { headers: { referer: 'https://fundf10.eastmoney.com/' } });
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
      } catch (e) { console.error('板块列表：' + e.message); }
    }
  }
  return boardCodes[name] || boardCodes[Object.keys(boardCodes).find(n => n.includes(name))] || null;
}
async function fetchAny(name, yahooSyms, emSecid) {
  for (const s of yahooSyms || []) { try { return { map: await yahoo(s), source: 'Yahoo ' + s }; } catch (e) { console.error(`${name} Yahoo ${s}：${e.message}`); } }
  if (emSecid) { try { return { map: await emKline(emSecid), source: '东方财富 ' + emSecid }; } catch (e) { console.error(`${name} 东财：${e.message}`); } }
  return { map: {}, source: null };
}
const CUTRULE = {   // 何时可获得（北京时间），取保守值
  cn: d => at(d, '15:00'), hk: d => at(d, '16:10'), us: d => at(addDays(d, 1), '05:00'),
  nav: d => at(d, '21:00'), navQdii: d => at(calNext(d), '21:00'),
};
let calNext = d => addDays(d, 1);
// 只收 cutoff 已经过去的数据点，盘中未完成的数据不会进入本地序列
function mergeSeries(key, name, fetched, kind) {
  const f = P('market', key + '.json');
  const s = readJ(f, { key, name, source: fetched.source, values: {} });
  let added = 0;
  for (const [d, v] of Object.entries(fetched.map || {})) {
    if (ms(CUTRULE[kind](d)) > NOWMS) continue;
    if (s.values[d] == null) { s.values[d] = v; added++; }
    else if (Math.abs(s.values[d] - v) > 0.005) appendLine(P('market', 'revisions.jsonl'), { key, date: d, stored: s.values[d], vendor: v, seenAt: nowISO, source: fetched.source });
  }
  if (fetched.source) s.source = fetched.source;
  s.values = Object.fromEntries(Object.entries(s.values).sort());
  writeJ(f, s);
  return s;
}
const IDX = {
  sh: ['上证指数', ['000001.SS'], '1.000001', 'cn'], cyb: ['创业板指', ['399006.SZ', '159915.SZ'], '0.399006', 'cn'],
  kc50: ['科创50', ['000688.SS', '588000.SS'], '1.000688', 'cn'], ndx: ['纳斯达克100', ['^NDX'], '100.NDX', 'us'],
  spx: ['标普500', ['^GSPC'], '100.SPX', 'us'], sox: ['费城半导体', ['^SOX'], '100.SOX', 'us'],
  kweb: ['中概互联网', ['KWEB'], null, 'us'], hstech: ['恒生科技', ['^HSTECH', '3033.HK'], '124.HSTECH', 'hk'],
};
const ETF_FALLBACK = { '半导体': ['512480.SS'], 'PCB': ['515260.SS'], '元件': ['515260.SS'] };
function mkSeries(id, name, map, kind, source) {
  const dates = Object.keys(map).sort();
  return { id, name, map, kind, source, cutoff: d => CUTRULE[kind](d), dates, cuts: dates.map(d => ms(CUTRULE[kind](d))) };
}
function avail(s, T, asOfMs, n = 1) {
  const out = [];
  for (let i = s.dates.length - 1; i >= 0 && out.length < n; i--) if (s.dates[i] < T && s.cuts[i] <= asOfMs) out.push({ date: s.dates[i], v: s.map[s.dates[i]] });
  return out.reverse();
}
const RAW = {};
for (const [k, [name, ys, em, kind]] of Object.entries(IDX)) {
  const f = await fetchAny(name, ys, em);
  if (!f.source) log(`${name} 行情抓取失败，使用本地已存数据`);
  RAW[k] = { name, kind, s: mergeSeries(k, name, f, kind) };
}
const CAL = makeCalendar(Object.keys(RAW.sh.s.values).sort());
calNext = CAL.nextTD;
const S = Object.fromEntries(Object.entries(RAW).map(([k, x]) => [k, mkSeries(k, x.name, x.s.values, x.kind, x.s.source)]));
const NAV = {}, ANC = {};
for (const f of funds) {
  let m = {}; try { m = await navHist(f.code); } catch (e) { log(`${f.short} 净值抓取失败：${e.message}`); }
  const kind = f.qdii ? 'navQdii' : 'nav';
  const ns = mergeSeries('nav-' + f.code, f.short + '净值', { map: m, source: '天天基金' }, 'nav');   // 净值公布即收；QDII 的可获得时间在因子里另算
  NAV[f.code] = mkSeries('NAV.' + f.code, f.short + '净值', ns.values, kind, '天天基金');
  if (f.anchor.series) ANC[f.code] = S[f.anchor.series];
  else {
    let am = {}, src = null;
    try { const id = await boardSecid(f.anchor.name); if (id) { am = await emKline(id); src = '东方财富板块'; } } catch (e) { console.error(`${f.anchor.name}：${e.message}`); }
    if (!Object.keys(am).length) { const x = await fetchAny(f.anchor.name + '（ETF 代替）', ETF_FALLBACK[f.anchor.name], null); am = x.map; src = x.source; }
    const as = mergeSeries('anchor-' + f.code, f.anchor.name, { map: am, source: src }, 'cn');
    ANC[f.code] = mkSeries('ANC.' + f.code, f.anchor.name, as.values, 'cn', as.source);
  }
}
const tdays = S.sh.dates.filter(d => d <= today);

// 持仓随净值滚动（不加减仓的前提下）
for (const f of funds) {
  const h = f.holding;
  for (const d of NAV[f.code].dates.filter(d => d > h.navDate)) { const v = NAV[f.code].map[d], dl = h.amount * v / 100; h.amount = r2(h.amount + dl); h.pnl = r2(h.pnl + dl); h.navDate = d; }
  h.pnlPct = r2(h.pnl / (h.amount - h.pnl) * 100);
}

// ---------- 2. 因子（时点纪律） ----------
const sum = a => a.length ? a.reduce((s, x) => s + x, 0) : null;
const sd = a => { if (a.length < 2) return null; const m = sum(a) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const VAR_NAMES = { sh_prev: '上证指数', cyb_prev: '创业板指', kc50_prev: '科创50', kc50_mom5: '科创50近5日', ndx_on: '纳斯达克100', spx_on: '标普500', sox_on: '费城半导体', kweb_on: '中概互联网(KWEB)', hstech_prev: '恒生科技' };
function features(T, asOfIso, extra = {}) {
  const A = ms(asOfIso), refs = {};
  const P_ = CAL.prevTD(T);
  const one = (key, s) => { const x = avail(s, T, A, 1)[0]; if (x) refs[key] = { id: `${s.id}@${x.date}`, date: x.date, cutoff: s.cutoff(x.date), source: s.source }; return x ? r2(x.v) : null; };
  // 上一个 A 股收盘之后发生的外盘涨跌，长假时逐日复利累计
  const since = (key, s) => { const xs = avail(s, T, A, 15).filter(x => x.date >= P_); if (!xs.length) return null; const l = xs.at(-1); refs[key] = { id: `${s.id}@${l.date}`, date: l.date, cutoff: s.cutoff(l.date), from: xs[0].date, days: xs.length, source: s.source }; return r2((xs.reduce((m, x) => m * (1 + x.v / 100), 1) - 1) * 100); };
  const c = {
    sh_prev: one('sh_prev', S.sh), cyb_prev: one('cyb_prev', S.cyb), kc50_prev: one('kc50_prev', S.kc50),
    kc50_mom5: r2(sum(avail(S.kc50, T, A, 5).map(x => x.v))),
    ndx_on: since('ndx_on', S.ndx), spx_on: since('spx_on', S.spx), sox_on: since('sox_on', S.sox), kweb_on: since('kweb_on', S.kweb),
    hstech_prev: since('hstech_prev', S.hstech),
    gap: dayNum(T) - dayNum(P_), wd: weekday(T), guxia: extra.guxia ?? null,
  };
  const f = {};
  for (const fd of funds) {
    const nav = avail(NAV[fd.code], T, A, 20), anc = avail(ANC[fd.code], T, A, 3);
    const last = nav.at(-1), al = anc.at(-1);
    if (last) refs[`${fd.code}.prev`] = { id: `${NAV[fd.code].id}@${last.date}`, date: last.date, cutoff: NAV[fd.code].cutoff(last.date), source: '天天基金' };
    if (al) refs[`${fd.code}.anc`] = { id: `${ANC[fd.code].id}@${al.date}`, date: al.date, cutoff: ANC[fd.code].cutoff(al.date), source: ANC[fd.code].source };
    f[fd.code] = {
      prev: r2(last?.v), mom5: r2(sum(nav.slice(-5).map(x => x.v))), anc: r2(al?.v), anc_mom3: r2(sum(anc.map(x => x.v))),
      dev: last && al && last.date === al.date ? r2(last.v - al.v) : null, vol20: r2(sd(nav.map(x => x.v))),
    };
  }
  return { asOf: asOfIso, c, f, refs };
}
const extKey = code => CFG.benchmarks.externalMap[code] || 'sox';
const extMove = (feat, code) => feat.c[extKey(code) + '_on'];

// ---------- 3. 信号：定义只读（改条件 = 新建版本）；状态每天评估一次 ----------
const DEF_DIR = P('signals', 'definitions');
const defs = fs.readdirSync(DEF_DIR).filter(f => f.endsWith('.json')).map(f => readJ(path.join(DEF_DIR, f))).sort((a, b) => a.key.localeCompare(b.key));
const stateF = P('signals', 'current.json');
const state = readJ(stateF, {});
const sigChangelog = readJ(P('signals', 'changelog.json'), []);
for (const d of defs) state[d.key] ||= { status: '实验中', since: today, pending: null };
const VARS = ['sh_prev', 'cyb_prev', 'kc50_prev', 'kc50_mom5', 'ndx_on', 'spx_on', 'sox_on', 'kweb_on', 'hstech_prev', 'gap', 'wd', 'guxia', 'prev', 'mom5', 'anc', 'anc_mom3', 'dev', 'vol20', 'qdii'];
const OK_IDS = new Set([...VARS, 'Math', 'abs', 'max', 'min', 'true', 'false']);
const compiled = new Map();
function compile(expr) {
  if (compiled.has(expr)) return compiled.get(expr);
  if (typeof expr !== 'string' || expr.length > 200 || !/^[\w\s.<>=!&|()+\-*\/?:]+$/.test(expr)) throw new Error('表达式不合法：' + expr);
  for (const id of expr.match(/[A-Za-z_]\w*/g) || []) if (!OK_IDS.has(id)) throw new Error('未知变量：' + id);
  const fn = new Function(...VARS, 'Math', `"use strict";return (${expr});`);
  fn(...VARS.map(() => 0), Math);
  compiled.set(expr, fn); return fn;
}
function fires(def, feat, code) {
  if (def.scope !== '*' && def.scope !== code) return false;
  const v = { ...feat.c, ...feat.f[code], qdii: !!FUND[code].qdii };
  try { return !!compile(def.when)(...VARS.map(k => k === 'qdii' ? v.qdii : (v[k] == null ? NaN : v[k])), Math); } catch { return false; }
}
const statusOf = key => state[key]?.status || '实验中';

// 历史样本：每个交易日按"早间 08:07 可获得的信息"计算因子；研究集固定 160 天，留出集从固定起点开始只增不滚动
const histAll = tdays.filter(d => d >= (tdays[25] || tdays[0]));
const holdStart = CFG.split.holdoutStart;
const researchDays = histAll.filter(d => d < holdStart).slice(-CFG.split.researchDays);
const holdoutDays = histAll.filter(d => d >= holdStart);
const ROWS = [];
for (const T of [...researchDays, ...holdoutDays]) {
  const feat = features(T, at(T, '08:07'));
  for (const c of CODES) { const a = NAV[c].map[T]; if (a != null) ROWS.push({ T, c, feat, a }); }
}
const RESEARCH = ROWS.filter(r => r.T < holdStart), HOLDOUT = ROWS.filter(r => r.T >= holdStart);

const Phi = z => { const t = 1 / (1 + 0.2316419 * Math.abs(z)), d = 0.3989423 * Math.exp(-z * z / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return z > 0 ? 1 - p : p; };
function wilson(h, n) { if (!n) return [null, null]; const z = 1.96, p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n), s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r2((c - s) / d * 100), r2((c + s) / d * 100)]; }
// 信号统计：观测按"交易日"聚合（同一天多只基金高度相关，只算一个独立样本）
function sigStats(def, rows) {
  const want = def.vote > 0 ? '涨' : '跌';
  const byDay = new Map(); let obs = 0, hitObs = 0, up = 0, down = 0, sumA = 0, baseN = 0, baseH = 0;
  for (const r of rows) {
    const t = tri(r.a); if (t === '平') continue;
    baseN++; baseH += t === want;
    if (!fires(def, r.feat, r.c)) continue;
    obs++; hitObs += t === want; up += t === '涨'; down += t === '跌'; sumA += r.a;
    const x = byDay.get(r.T) || { n: 0, h: 0 }; x.n++; x.h += t === want; byDay.set(r.T, x);
  }
  const days = byDay.size, H = [...byDay.values()].reduce((s, x) => s + x.h / x.n, 0);
  const base = baseN ? baseH / baseN : null;
  const [lo, hi] = wilson(H, days);
  const p = days && base != null ? 1 - Phi((H / days - base) / Math.sqrt(base * (1 - base) / days)) : null;   // 单侧：是否高于基准
  const implied = obs ? sumA / obs : null;
  let mfm = null; if (obs) { let e = 0; for (const r of rows) if (tri(r.a) !== '平' && fires(def, r.feat, r.c)) e += Math.abs(implied - r.a); mfm = r2(e / obs); }
  return { obs, days, hitObs, up, down, rate: days ? r2(H / days * 100) : null, lo, hi, base: base != null ? r2(base * 100) : null, p: r3(p), signal_mean_forecast_mae: mfm, implied: r2(implied) };
}
function evaluateSignals() {
  const evalDone = state.__lastEval === today;
  const stats = {};
  for (const d of defs) stats[d.key] = { research: sigStats(d, RESEARCH), holdout: sigStats(d, HOLDOUT), forward: sigStats(d, ROWS.filter(r => r.T > d.createdAt)) };
  // BH 校正：研究集单侧 p 值，控制错误发现率
  const cands = defs.filter(d => statusOf(d.key) !== '淘汰' && stats[d.key].research.p != null && stats[d.key].research.days >= CFG.signals.minDays).map(d => ({ key: d.key, p: stats[d.key].research.p })).sort((a, b) => a.p - b.p);
  const m = cands.length; let kmax = -1; cands.forEach((c, i) => { if (c.p <= (i + 1) / m * CFG.signals.fdr) kmax = i; });
  const bhPass = new Set(cands.slice(0, kmax + 1).map(c => c.key));
  for (const d of defs) {
    const st = state[d.key], R = stats[d.key].research, H = stats[d.key].holdout, F = stats[d.key].forward;
    st.stats = stats[d.key]; st.bhPass = bhPass.has(d.key);
    if (evalDone || st.status === '淘汰') continue;
    const fromReview = d.proposedBy === 'review';
    const enough = fromReview ? F.days >= CFG.signals.minDays : R.days >= CFG.signals.minDays;
    let target;
    if (!enough) target = '实验中';
    else {
      const E = fromReview ? F : R;   // 复盘提出的信号：只用提出之后的数据
      const good = E.lo > E.base && (fromReview || bhPass.has(d.key)) && (fromReview || (H.days >= 5 && H.rate > H.base));
      const bad = E.hi < E.base || (st.status === '有效' && H.days >= 5 && H.rate < H.base);
      target = good ? '有效' : bad ? '失效' : (st.status === '有效' || st.status === '失效') ? st.status : '待验证';
    }
    if (st.status === '失效' && target === '失效' && tdays.filter(x => x > st.since && x <= today).length >= CFG.signals.retireAfter) target = '淘汰';
    if (target === st.status) { st.pending = null; continue; }
    const immediate = (st.status === '实验中' && target === '待验证') || target === '淘汰';
    if (!immediate) {
      st.pending = st.pending?.to === target ? { to: target, count: st.pending.count + 1 } : { to: target, count: 1 };
      if (st.pending.count < CFG.signals.hysteresisDays) continue;
    }
    const why = `研究集 ${R.rate ?? '–'}%（${R.days}天/${R.obs}次，区间 ${R.lo ?? '–'}~${R.hi ?? '–'}，基准 ${R.base ?? '–'}%，BH ${bhPass.has(d.key) ? '通过' : '未通过'}）；留出集 ${H.rate ?? '–'}%（${H.days}天）；提出后 ${F.rate ?? '–'}%（${F.days}天）`;
    sigChangelog.push({ date: today, key: d.key, from: st.status, to: target, why });
    log(`信号 ${d.key} ${st.status} → ${target}`);
    st.status = target; st.since = today; st.pending = null;
  }
  state.__lastEval = today;
  writeOnce(P('signals', 'status', today + '.json'), Object.fromEntries(defs.map(d => [d.key, { status: state[d.key].status, pending: state[d.key].pending, ...stats[d.key] }])));
}
evaluateSignals();

// ---------- 4. 规则模型与基准（都不带截距；系数只在研究集上拟合，随版本冻结） ----------
function fitSlope(rows) { let sxy = 0, sxx = 0; for (const [x, y] of rows) { sxy += x * y; sxx += x * x; } return { b: sxx ? r3(sxy / (sxx * 1.1)) : 0, n: rows.length }; }
const modelScore = (m, feat, code, drop = []) => m.signals.filter(k => !drop.includes(k)).reduce((s, k) => { const d = defs.find(x => x.key === k); return s + (d && fires(d, feat, code) ? d.vote : 0); }, 0);
function buildModel(version, keys, why) {
  const m = { version, createdAt: nowISO, signals: keys, why };
  m.fit = fitSlope(RESEARCH.map(r => [modelScore(m, r.feat, r.c), r.a]));
  m.beta = fitSlope(RESEARCH.filter(r => extMove(r.feat, r.c) != null).map(r => [extMove(r.feat, r.c), r.a]));
  m.trainedOn = { from: researchDays[0], to: researchDays.at(-1) };
  return m;
}
const clampV = v => Math.max(-10, Math.min(10, v));
const modelValue = (m, feat, code, drop) => r2(clampV(m.fit.b * modelScore(m, feat, code, drop)));
function benchValues(m, feat, code) {
  const u = extMove(feat, code);
  return { bench_external_raw: u == null ? null : r2(clampV(u)), bench_external_beta: u == null ? null : r2(clampV(m.beta.b * u)), bench_prev: feat.f[code].prev, bench_zero: 0 };
}
function scoreSet(rows, fn) {
  let n = 0, hit = 0, e = 0;
  for (const r of rows) { const v = fn(r); if (v == null) continue; n++; e += Math.abs(v - r.a); hit += tri(v) === tri(r.a); }
  return { n, rate: n ? r2(hit / n * 100) : null, mae: n ? r3(e / n) : null };
}
const modelLog = readJ(P('models', 'changelog.json'), []);
let model = readJ(P('models', 'current.json'), null);
if (!model) {
  model = buildModel('v1.0', defs.filter(d => statusOf(d.key) === '有效').map(d => d.key), '初始版本：使用当前全部「有效」信号');
  writeJ(P('models', 'v1.0.json'), model); writeJ(P('models', 'current.json'), model);
  modelLog.push({ version: 'v1.0', createdAt: nowISO, launchedAt: nowISO, change: model.why, signals: model.signals, research: { new: scoreSet(RESEARCH, r => modelValue(model, r.feat, r.c)) }, holdout: { new: scoreSet(HOLDOUT, r => modelValue(model, r.feat, r.c)) }, passed: true, status: 'launched' });
  log('建立规则模型 v1.0');
}
function tryUpgrade() {
  const want = defs.filter(d => statusOf(d.key) === '有效').map(d => d.key).sort();
  if (JSON.stringify(want) === JSON.stringify([...model.signals].sort())) return;
  if (modelLog.some(x => x.createdAt.slice(0, 10) === today && JSON.stringify(x.signals) === JSON.stringify(want))) return;   // 同一天同一提案不重复评估
  const [maj, min] = model.version.slice(1).split('.').map(Number);
  const cand = buildModel(`v${maj}.${min + 1}`, want, '');
  const added = want.filter(x => !model.signals.includes(x)), removed = model.signals.filter(x => !want.includes(x));
  cand.why = [added.length ? '加入 ' + added.join('、') : '', removed.length ? '移除 ' + removed.join('、') : ''].filter(Boolean).join('；');
  const R0 = scoreSet(RESEARCH, r => modelValue(model, r.feat, r.c)), R1 = scoreSet(RESEARCH, r => modelValue(cand, r.feat, r.c));
  const H0 = scoreSet(HOLDOUT, r => modelValue(model, r.feat, r.c)), H1 = scoreSet(HOLDOUT, r => modelValue(cand, r.feat, r.c));
  const best = CFG.benchmarks.maePool.map(k => ({ k, s: scoreSet(HOLDOUT, r => benchValues(cand, r.feat, r.c)[k]) })).sort((a, b) => a.s.mae - b.s.mae)[0];
  const ok = (o, x) => x.mae <= o.mae + CFG.gate.mae && (x.rate ?? 0) >= (o.rate ?? 0) - CFG.gate.hit;
  const keepsEdge = !(H0.mae < best.s.mae) || H1.mae < best.s.mae;
  const passed = ok(R0, R1) && ok(H0, H1) && keepsEdge;
  modelLog.push({ version: cand.version, createdAt: nowISO, launchedAt: passed ? nowISO : null, change: cand.why, signals: want, reason: '信号状态变化后自动评估', research: { old: R0, new: R1 }, holdout: { old: H0, new: H1 }, vsBenchmark: { name: best.k, holdout: best.s }, passed, status: passed ? 'launched' : 'not_launched' });
  if (passed) { model = cand; writeJ(P('models', `${cand.version}.json`), cand); writeJ(P('models', 'current.json'), cand); log(`规则模型升级到 ${cand.version}：${cand.why}`); }
  else log(`规则模型 ${cand.version} 未上线：${cand.why}`);
}
tryUpgrade();

// ---------- 5. Gemini ----------
function parseJson(t) { const s = t.replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('输出中没有 JSON'); return JSON.parse(s.slice(a, b + 1)); }
async function gemini(text, label) {
  if (!KEY) throw new Error('缺少 GEMINI_API_KEY');
  for (const m of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }) });
      if (r.ok) { const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); if (t.trim()) { console.log(`${label}：${m}`); return { out: parseJson(t), modelName: j.modelVersion || m }; } }
      else console.error(`${label}：${m} ${r.status} ${(await r.text()).slice(0, 160)}`);
    } catch (e) { console.error(`${label}：${m} ${e.message}`); }
    await new Promise(res => setTimeout(res, 13000));
  }
  throw new Error('Gemini 不可用');
}
const NEWS_KEYS = /半导体|芯片|晶圆|存储|DRAM|HBM|NAND|PCB|覆铜板|MLCC|电子元件|被动元件|光模块|光纤|光通信|算力|服务器|AI|人工智能|大模型|机器人|英伟达|台积电|AMD|博通|美光|三星|SK海力士|苹果|微软|谷歌|Meta|特斯拉|阿斯麦|ASML|高通|英特尔|应用材料|美股|纳指|纳斯达克|标普|道指|费城|中概|港股|恒生|恒指|A股|沪指|上证|深成|创业板|科创|北向|证监会|央行|人民银行|降准|降息|LPR|国务院|发改委|工信部|财政部|商务部|美联储|鲍威尔|非农|CPI|PCE|通胀|美债|收益率|美元|人民币|汇率|关税|出口管制|制裁|实体清单|地缘|停火|原油|黄金|IPO|减持|增持|回购/;
const NEWS_DROP = /^【?(金十|快讯)?图示|PLUS专享|^$/;
// 新闻：华尔街见闻 7×24（主）+ 新浪财经 7×24（备）+ 金十（补），覆盖上一 A 股收盘以来的全部快讯；全部带服务器发布时间
async function news(sinceIso, untilIso) {
  const lo = ms(sinceIso), hi = ms(untilIso), out = [], errs = [];
  try {
    let cursor = '';
    for (let p = 0; p < 8; p++) {
      const j = JSON.parse(await get(`https://api-one-wscn.awtmt.com/apiv1/content/lives?channel=global-channel&limit=100${cursor ? '&cursor=' + cursor : ''}`));
      const it = j?.data?.items || []; if (!it.length) break;
      for (const n of it) out.push({ src: 'wscn', sid: n.id, time: new Date(n.display_time * 1000).toISOString(), text: String(n.content_text || n.title || '').replace(/\s+/g, ' ').trim(), source: '华尔街见闻', url: n.uri || null, score: n.score || 0 });
      cursor = j.data.next_cursor; if (!cursor || it.at(-1).display_time * 1000 < lo) break;
    }
  } catch (e) { errs.push('华尔街见闻 ' + e.message); }
  try {
    for (let p = 1; p <= 12; p++) {
      const j = JSON.parse(await get(`https://zhibo.sina.com.cn/api/zhibo/feed?page=${p}&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1`));
      const it = j?.result?.data?.feed?.list || []; if (!it.length) break;
      for (const n of it) out.push({ src: 'sina', sid: n.id, time: String(n.create_time).replace(' ', 'T') + '+08:00', text: String(n.rich_text || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), source: '新浪财经', url: null, score: 0 });
      if (ms(String(it.at(-1).create_time).replace(' ', 'T') + '+08:00') < lo) break;
    }
  } catch (e) { errs.push('新浪 ' + e.message); }
  try {
    const j = JSON.parse(await get('https://flash-api.jin10.com/get_flash_list?channel=-8200&vip=1', { headers: { 'x-app-id': 'bVBF4FyRTn5NJF5n', 'x-version': '1.0.0', referer: 'https://www.jin10.com/' } }));
    for (const n of j?.data || []) { if (n.data?.lock) continue; out.push({ src: 'jin10', sid: n.id, time: String(n.time).replace(' ', 'T') + '+08:00', text: String(n.data?.content || '').replace(/<br\s*\/?>/g, ' ').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim(), source: '金十数据', url: null, score: n.important ? 1 : 0 }); }
  } catch (e) { errs.push('金十 ' + e.message); }
  if (errs.length) log('快讯源失败：' + errs.join('；'));
  const seen = new Set(), res = [];
  for (const n of out.sort((a, b) => ms(a.time) - ms(b.time))) {
    const t = ms(n.time); if (!(t >= lo && t <= hi) || NEWS_DROP.test(n.text) || n.text.length < 12) continue;
    const k = n.text.replace(/[【】\[\]（）()，。：:、\s"“”]/g, '').slice(0, 22); if (seen.has(k)) continue; seen.add(k);
    res.push({ id: `NEWS@${n.src}:${n.sid}`, time: toBJ(t), text: n.text.slice(0, 220), source: n.source, url: n.url, relevant: NEWS_KEYS.test(n.text), score: n.score });
  }
  return res;
}
// 消息面摘要：只根据抓到的真实快讯写，每条必须引用快讯编号；不做涨跌判断
async function newsDigest(T, items, asOf) {
  const list = items.filter(i => i.kind === '消息');
  if (list.length < 3) return null;
  const txt = list.map(i => `[${i.id}] ${toBJ(ms(i.dataTime)).slice(5, 16).replace("T", " ")} ${i.text.slice(0, 140)}`).join('\n');
  const fundsTxt = funds.map(f => `${f.code} ${f.short}：${f.drivers.join('；')}`).join('\n');
  const { out, modelName } = await gemini(`你是基金持有人的资讯助理。下面是北京时间 ${asOf} 之前抓到的财经快讯（上一个 A 股收盘以来），请整理成预测 ${T} 当天基金涨跌前需要知道的消息面要点。
要求：
- 只能使用下面列出的快讯，不得补充任何列表外的信息；每条要点必须在 refs 里写出所依据的快讯编号。
- 按重要性排序，最多 8 条；合并重复报道；每条 60 字以内，写清楚事实和数字。
- tag 只能是：海外市场、国内政策、行业动态、公司、宏观数据、地缘 之一。
- funds 写可能受影响的基金代码（可以为空）；effect 写"偏利好""偏利空""影响不明"之一，只描述这条消息本身的性质，不预测基金当天涨跌。
- overall 用一句话概括消息面（不超过 50 字），不预测涨跌。

持仓基金：
${fundsTxt}

快讯：
${txt}

只输出 JSON：{"overall":"...","points":[{"text":"...","tag":"海外市场","refs":["NEWS@..."],"funds":["002910"],"effect":"偏利好"}]}`, `消息面摘要 ${T}`);
  const ids = new Set(list.map(i => i.id)), codes = new Set(CODES), TAGS = ['海外市场', '国内政策', '行业动态', '公司', '宏观数据', '地缘'], EFF = ['偏利好', '偏利空', '影响不明'];
  const points = (Array.isArray(out.points) ? out.points : []).map(p => ({ text: String(p.text || '').slice(0, 90), tag: TAGS.includes(p.tag) ? p.tag : '行业动态', refs: (p.refs || []).filter(r => ids.has(r)), funds: (p.funds || []).filter(c => codes.has(c)), effect: EFF.includes(p.effect) ? p.effect : '影响不明' })).filter(p => p.text && p.refs.length).slice(0, 8);
  if (!points.length) return null;
  return { overall: String(out.overall || '').slice(0, 80), points, modelName, promptVersion: 'news-1' };
}
async function externalView(sinceIso) {   // 外部观点：作为普通信号输入，前台不单独展示
  const t = await get('https://www.sina.cn/media/1896820725');
  const text = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ').replace(/\s+/g, ' ').slice(0, 9000);
  if (text.length < 200) throw new Error('页面内容过少');
  const { out } = await gemini(`下面是一位财经博主主页抓取到的文字。现在是北京时间 ${nowISO}。只看 ${sinceIso} 之后发布的内容，判断他对下一个A股交易日大盘的倾向：2明确看多，1偏多，0中性或无判断，-1偏空，-2明确看空；没有可识别的帖子填 null。只输出 JSON：{"stance":0}\n\n${text}`, '外部观点');
  const s = out.stance == null ? null : Math.max(-2, Math.min(2, Math.round(+out.stance)));
  return Number.isFinite(s) ? s : null;
}

// ---------- 6. 批次：只在时间窗内生成；快照、触发表、系统预测都只新建 ----------
function windowNow() {
  const W = CFG.windows;
  if (hm >= W.evening[0] && hm <= W.evening[1]) { const T = CAL.nextTD(today); return addDays(today, 1) === T ? { batch: 'evening', T } : null; }
  // GitHub 定时任务常延迟数小时：晚间批次顺延到凌晨（07:30 前）仍可生成，asOf 记录实际时间，不影响数据纪律
  if (hm < W.morning[0] && CAL.isTD(today)) return { batch: 'evening', T: today };
  if (CAL.isTD(today) && hm >= W.morning[0] && ms(nowISO) < ms(deadlineOf(today))) return { batch: 'morning', T: today };
  return null;
}
function snapshotItems(feat, newsList, asOfIso) {
  const items = [];
  for (const [k, ref] of Object.entries(feat.refs)) {
    const [code, sub] = k.includes('.') ? k.split('.') : [null, null];
    const value = code ? feat.f[code][sub] : feat.c[k];
    const name = (code ? `${FUND[code].short}${sub === 'prev' ? ' 上一净值日涨跌' : ' 锚定（' + FUND[code].anchor.name + '）'}` : VAR_NAMES[k] || k) + (ref.days > 1 ? `（${ref.from}起 ${ref.days} 个交易日累计）` : '');
    items.push({ id: ref.id, key: k, name, value, unit: '%', source: ref.source || null, dataTime: ref.date, cutoff: ref.cutoff, fetchedAt: nowISO, kind: '行情' });
  }
  const rel = newsList.filter(n => n.relevant), base = rel.length >= 15 ? rel : newsList;
  const keep = base.length <= 150 ? base : [...base.filter(n => n.score > 0), ...base.filter(n => !(n.score > 0)).slice(-150)].slice(0, 150);
  const pick = keep.sort((a, b) => ms(a.time) - ms(b.time));
  for (const n of pick)
    items.push({ id: n.id, name: '快讯', text: n.text, source: n.source, url: n.url || undefined, dataTime: n.time, cutoff: n.time, fetchedAt: nowISO, kind: '消息' });
  return items;
}
function sigLine(key) {
  const d = defs.find(x => x.key === key), st = state[key]; if (!d) return key;
  const R = st?.stats?.research || {}, H = st?.stats?.holdout || {};
  return `${d.id} ${d.name}（${st?.status}；研究集 ${R.rate ?? '–'}%/${R.days ?? 0}天，基准${R.base ?? '–'}%；留出集 ${H.rate ?? '–'}%/${H.days ?? 0}天）`;
}
async function prepare(T, batch) {
  const asOf = nowISO;
  if (exists(P('snapshots', T, `${batch}.json`))) { log(`${T} ${batch} 批次已存在`); return; }
  let ext = null;
  try { ext = await externalView(at(CAL.prevTD(T), '15:00')); } catch (e) { console.error('外部观点：' + e.message); }
  const feat = features(T, asOf, { guxia: ext });
  const items = snapshotItems(feat, await news(at(CAL.prevTD(T), '15:00'), asOf), asOf);
  if (ext != null) items.push({ id: 'EXT@' + asOf, name: '外部观点', value: ext, dataTime: asOf, cutoff: asOf, fetchedAt: nowISO, kind: '外部观点', hidden: true });
  const meta = { runId: RUN.id, trigger: RUN.trigger, generatedAt: nowISO };
  writeOnce(P('snapshots', T, `${batch}.json`), { date: T, batch, snapshotId: `${T}/${batch}`, asOf, ...meta, features: feat, items });
  try { const dg = await newsDigest(T, items, asOf); if (dg) writeOnce(P('digests', T, `${batch}.json`), { date: T, batch, snapshotId: `${T}/${batch}`, asOf, ...meta, ...dg }); } catch (e) { log('消息面摘要失败：' + e.message); }
  const trig = { date: T, batch, snapshotId: `${T}/${batch}`, ...meta, funds: {} };
  for (const c of CODES) trig.funds[c] = defs.filter(d => statusOf(d.key) !== '淘汰' && fires(d, feat, c)).map(d => ({ signal: d.id, key: d.key, status: statusOf(d.key), triggered: true, inputs: Object.fromEntries(VARS.filter(v => v !== 'qdii' && new RegExp('\\b' + v + '\\b').test(d.when)).map(v => [v, feat.c[v] ?? feat.f[c][v] ?? null])) }));
  writeOnce(P('triggers', T, `${batch}.json`), trig);
  const sys = { model: {}, bench_external_raw: {}, bench_external_beta: {}, bench_prev: {}, bench_zero: {} };
  for (const c of CODES) { sys.model[c] = { value: modelValue(model, feat, c), score: modelScore(model, feat, c) }; const b = benchValues(model, feat, c); for (const k in b) sys[k][c] = { value: b[k] }; }
  for (const k of Object.keys(sys)) writeOnce(P('predictions', T, `${k}-${batch}.json`), { date: T, predictor: k, batch, snapshotId: `${T}/${batch}`, asOf, ...meta, modelVersion: model.version, funds: sys[k], overall: portfolio(sys[k]) });
  try {
    const ai = await aiDraft(T, feat, items, trig);
    writeOnce(P('predictions', T, `ai-${batch}.json`), { date: T, predictor: 'ai', batch, snapshotId: `${T}/${batch}`, asOf, ...meta, aiVersion: `${PROMPT_VERSION}@${today}`, promptVersion: PROMPT_VERSION, modelName: ai.modelName, ...ai.body });
  } catch (e) { log('AI 草稿失败：' + e.message); }
  const day = (index.days[T] ||= { batches: [] }); if (!day.batches.includes(batch)) day.batches.push(batch);
  log(`${T} ${batch} 批次：快照 ${items.length} 条，草稿已生成`);
}
async function aiDraft(T, feat, items, trig) {
  const data = items.filter(i => !i.hidden).map(i => `[${i.id}] ${i.name}${i.value != null ? ' ' + pct(i.value) : ''}${i.text ? '：' + i.text : ''}（数据时间 ${i.dataTime}）`).join('\n');
  const fundsTxt = funds.map(f => {
    const t = trig.funds[f.code] || [];
    const valid = t.filter(x => x.status === '有效').map(x => sigLine(x.key)), other = t.filter(x => x.status !== '有效' && defs.find(d => d.key === x.key)?.sourceType !== '外部观点').map(x => sigLine(x.key));
    return `${f.code} ${f.name}（${f.type}${f.qdii ? '；QDII，T日净值对应海外T日收盘' : ''}）\n  特征：${f.drivers.join('；')}\n  近20日波动 ${feat.f[f.code].vol20 ?? '–'}%，上一日 ${pct(feat.f[f.code].prev)}，近5日 ${pct(feat.f[f.code].mom5)}，锚定 ${pct(feat.f[f.code].anc)}，锚定近3日 ${pct(feat.f[f.code].anc_mom3)}\n  今天触发且历史有效（可作依据）：${valid.join('；') || '无'}\n  今天触发但未被证明有效（不能作依据）：${other.join('；') || '无'}`;
  }).join('\n');
  const { out, modelName } = await gemini(`你是这五只基金的持有人，以投资人身份预测 ${T} 各基金的净值涨跌幅。现在是北京时间 ${nowISO}，只能使用下面列出的、此刻已经可以获得的数据。
评分：方向（涨>+${CFG.flatBand}%，跌<-${CFG.flatBand}%，其余为平）和绝对误差。每只基金只给一个数值，不给区间和概率。

可用数据（[编号] 名称 数值，数据时间）：
${data}

各基金：
${fundsTxt}

规则：
- 只有「今天触发且历史有效」的规律可以作为依据，引用时写出编号和历史命中率。
- 没触发的规律不能说"触发了"；未被证明有效的规律不能当理由。
- 每条理由尽量引用数据编号（dataRefs）。主观判断要写明是主观判断。
- 依据互相矛盾时写明，并把数值往0收。
- 独立判断；五只基金的差别要有理由。

只输出 JSON：{"funds":{"代码":{"value":0.8,"reasons":[{"text":"40字内","signals":["R001"],"dataRefs":["..."]}],"conclusion":"一句话"}}}`, `AI 草稿 ${T}`);
  const fx = {};
  const ids = new Set(defs.map(d => d.id));
  const clean = rs => (Array.isArray(rs) ? rs : []).slice(0, 5).map(r => ({ text: String(r.text || '').slice(0, 90), signals: (r.signals || []).filter(id => ids.has(id)), dataRefs: (r.dataRefs || []).filter(id => items.some(i => i.id === id)) })).filter(r => r.text);
  for (const c of CODES) { const p = out.funds?.[c]; const v = +p?.value; if (!Number.isFinite(v)) continue; fx[c] = { value: r2(clampV(v)), reasons: clean(p.reasons), conclusion: String(p.conclusion || '').slice(0, 80) }; }
  return { modelName, body: { funds: fx, overall: portfolio(fx) } };
}
// 科技仓整体 = 按持仓金额加权的平均
function portfolio(fx) {
  let w = 0, s = 0; const weights = {};
  for (const f of funds) { const v = fx[f.code]?.value; if (v == null) continue; const a = Math.max(0, f.holding.amount || 0); weights[f.code] = a; w += a; s += a * v; }
  if (!w) { const xs = Object.values(fx).map(x => x.value).filter(v => v != null); return { value: xs.length ? r2(sum(xs) / xs.length) : null, method: '简单平均' }; }
  return { value: r2(s / w), method: '持仓加权', weights };
}

// ---------- 7. 结算 ----------
function git(...args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } }
function userPrediction(T) {
  const rel = `data/predictions/${T}/user.json`;
  if (!exists(path.join(ROOT, rel))) return null;
  const lock = readJ(P('locks', T, 'user.json'), null);
  const commits = git('log', '--format=%H', '--', rel).split('\n').filter(Boolean);
  let content = readJ(path.join(ROOT, rel));
  if (commits.length) { try { content = JSON.parse(git('show', `${commits.at(-1)}:${rel}`)); } catch {} }   // 只按第一次提交的内容计分
  const tampered = commits.length > 1 || (lock && sha256(content) !== lock.predictionHash);
  const serverLockedAt = lock?.serverLockedAt || null;
  const onTime = !!lock && lock.onTime;
  return { ...content, serverLockedAt, lock, onTime, tampered, commitSha: commits.at(-1) || null };
}
// 系统预测：只用锁定点之前生成的最新批次（你缺席时以截止时间为准）
function sysPrediction(T, who, limitIso) {
  const b = batchAsOf(T, limitIso); if (!b) return null;
  const f = P('predictions', T, `${who}-${b.batch}.json`);
  return exists(f) ? readJ(f) : null;
}
function scoreDay(T, actual) {
  const user = userPrediction(T);
  const limit = user && user.onTime ? (ms(user.serverLockedAt) < ms(deadlineOf(T)) ? user.serverLockedAt : deadlineOf(T)) : deadlineOf(T);
  const preds = { user };
  for (const k of ['ai', 'model', 'bench_external_raw', 'bench_external_beta', 'bench_prev', 'bench_zero']) preds[k] = sysPrediction(T, k, limit);
  const scores = {}, meta = {};
  for (const [k, p] of Object.entries(preds)) {
    if (!p) { meta[k] = { status: 'absent' }; continue; }
    meta[k] = k === 'user' ? { status: !p.lock ? 'unverified' : !p.onTime ? 'late' : p.tampered ? 'modified_scored_first' : 'ok', serverLockedAt: p.serverLockedAt, commitSha: p.commitSha, hash: p.lock?.predictionHash || null, snapshotId: p.snapshotId, issue: p.lock?.issueNumber || null }
      : { status: 'ok', batch: p.batch, asOf: p.asOf, snapshotId: p.snapshotId, ...(k === 'ai' ? { aiVersion: p.aiVersion, modelName: p.modelName } : {}), ...(k === 'model' ? { modelVersion: p.modelVersion } : {}) };
    if (k === 'user' && !p.onTime) continue;
    scores[k] = {};
    for (const c of CODES) {
      const v = p.funds?.[c]?.value, a = actual[c];
      if (v == null || a == null) continue;
      scores[k][c] = { pred: v, actual: a, dirPred: tri(v), dirActual: tri(a), hit: tri(v) === tri(a), absErr: r2(Math.abs(v - a)) };
    }
  }
  return { preds, scores, meta, limit };
}
async function settle(T) {
  const actual = {}; for (const c of CODES) if (NAV[c].map[T] != null) actual[c] = NAV[c].map[T];
  if (!funds.filter(f => !f.qdii).every(f => actual[f.code] != null)) return false;
  const old = readJ(P('results', T + '.json'), null);
  const userNow = exists(P('locks', T, 'user.json'));
  if (old && JSON.stringify(old.actual) === JSON.stringify(actual) && (old.meta?.user?.status !== 'unverified' || !userNow)) return false;
  const { preds, scores, meta, limit } = scoreDay(T, actual);
  const versions = old?.versions || [];
  if (!old || JSON.stringify(old.actual) !== JSON.stringify(actual)) versions.push({ v: versions.length + 1, at: nowISO, actual, source: '天天基金', reason: !old ? '首次结算' : Object.keys(actual).length > Object.keys(old.actual).length ? '净值补齐（QDII 晚到）' : '净值更正' });
  const res = { date: T, actual, scoredAt: nowISO, comparisonCutoff: limit, scores, meta, versions };
  if (preds.user && preds.user.onTime) {
    const b = batchAsOf(T, preds.user.serverLockedAt);
    const cr = checkReasons(preds.user, b?.snap, b ? readJ(P('triggers', T, `${b.batch}.json`), null) : null, defs, preds.user.serverLockedAt);
    res.userChecks = cr.checks; res.userEvidence = cr.evidence;
  }
  writeJ(P('results', T + '.json'), res);
  Object.assign(index.days[T] ||= { batches: [] }, { result: true, user: !!preds.user });
  log(`${T} 结算完成（${old ? '更新' : '首次'}）`);
  if (!exists(P('reviews', T + '.json'))) await review(T, preds, res);
  return true;
}
async function review(T, preds, res) {
  const who = preds.user && preds.user.onTime ? 'user' : 'ai';
  const p = preds[who]; if (!p) { log(`${T} 没有可复盘的预测`); return; }
  const lockIso = who === 'user' ? p.serverLockedAt : p.asOf;
  const b = batchAsOf(T, lockIso);
  const snap = b?.snap, trig = b ? readJ(P('triggers', T, `${b.batch}.json`), null) : null;
  const hindsight = [], ablation = [];
  for (const [c, f] of Object.entries(p.funds || {})) (f.reasons || []).forEach((r, i) => {
    for (const id of r.dataRefs || []) { const it = snap?.items?.find(x => x.id === id); if (it) { const after = ms(it.cutoff) > ms(lockIso); hindsight.push({ fund: c, reason: i, verdict: after ? '事后信息' : '预测前已成立', suspected_hindsight: after, evidence: `${it.name} 可获得于 ${it.cutoff}，锁定于 ${lockIso}`, by: 'rule' }); } }
    const keys = (r.signals || []).map(id => defs.find(d => d.id === id)?.key).filter(k => k && model.signals.includes(k));
    if (keys.length && snap) { const base = modelValue(model, snap.features, c), dropV = modelValue(model, snap.features, c, keys); ablation.push({ fund: c, reason: i, verdict: tri(base) !== tri(dropV) ? '核心变量' : '非核心变量', detail: `规则模型 ${pct(base)} → 去掉后 ${pct(dropV)}`, by: 'rule' }); }
  });
  const newsAfter = (await news()).filter(n => ms(n.time) > ms(lockIso) && ms(n.time) <= ms(at(T, '15:00')) && NEWS_KEYS.test(n.text)).slice(0, 20);
  const rows = funds.map(f => {
    const pf = p.funds?.[f.code]; const sc = res.scores[who]?.[f.code];
    return `${f.short}：预测 ${pct(pf?.value)}，实际 ${pct(res.actual[f.code])}，${sc ? (sc.hit ? '方向对' : '方向错') + `，误差 ${sc.absErr}` : '未计分'}\n  理由：${(pf?.reasons || []).map((r, i) => `(${i}) ${r.text}${r.signals?.length ? ' [信号 ' + r.signals.join(',') + ']' : ''}`).join(' ')}\n  今天触发：${(trig?.funds?.[f.code] || []).map(x => x.signal + '(' + x.status + ')').join('、') || '无'}`;
  }).join('\n');
  // 只给研究集统计；不给留出集和提出后的数据
  const researchSig = defs.filter(d => statusOf(d.key) !== '淘汰').map(d => { const R = state[d.key]?.stats?.research || {}; return `${d.id} ${d.name}：when ${d.when} → ${d.vote > 0 ? '看涨' : '看跌'}，研究集 ${R.rate ?? '–'}%（${R.days ?? 0}天，基准${R.base ?? '–'}%）`; }).join('\n');
  let out = {}, modelName = null;
  try {
    ({ out, modelName } = await gemini(`你在帮一位普通投资人复盘 ${T} 的基金涨跌预测（被复盘的是${who === 'user' ? '他本人的预测' : 'AI 草稿（他当天没有提交）'}，锁定时间 ${lockIso}）。用简体中文，具体、不说空话。
${rows}

锁定之后、收盘之前出现的快讯（这些都不能作为预测依据）：
${newsAfter.map(n => `[${n.time.slice(11, 16)}] ${n.text}`).join('\n') || '无'}

信号库（研究集统计）：
${researchSig}

请输出：right（判断正确，1-3条）、wrong（判断错误，1-3条）、bestSignal {"id":"","why":""}、misleading {"id":"","why":""}、nextTime（1-3条）；
hindsight：逐条检查没有引用数据编号的文字理由，是否用到了锁定后才知道的信息 [{"fund":"代码","reason":序号,"verdict":"预测前已成立/疑似事后信息","why":""}]；
ablation：逐条判断"删掉这条理由，结论还一样吗"，只写没关联信号的理由 [{"fund":"代码","reason":序号,"verdict":"核心变量/装饰/无法判断","why":""}]（这只是辅助判断）；
newSignals：最多2条值得实验的新信号（野路子也可以），只能用变量：${VARS.join(',')}，表达式只用变量、数字、比较和逻辑运算、Math.abs。[{"name":"","when":"","vote":1,"scope":"*"}]
只输出 JSON。`, `复盘 ${T}`));
  } catch (e) { log('复盘 AI 部分失败：' + e.message); }
  const arr = x => Array.isArray(x) ? x.slice(0, 5).map(String) : [];
  const aiH = (Array.isArray(out.hindsight) ? out.hindsight.slice(0, 15) : []).map(x => ({ ...x, suspected_hindsight: x.verdict === '疑似事后信息', by: 'ai' }));
  writeOnce(P('reviews', T + '.json'), { date: T, subject: who, createdAt: nowISO, aiModel: modelName, right: arr(out.right), wrong: arr(out.wrong), bestSignal: out.bestSignal || null, misleading: out.misleading || null, nextTime: arr(out.nextTime),
    hindsight: [...hindsight, ...aiH], ablation: [...ablation, ...(Array.isArray(out.ablation) ? out.ablation.slice(0, 15).map(x => ({ ...x, by: 'ai' })) : [])] });
  index.days[T].review = true;
  // 新信号：只新建定义，从"实验中"开始，只能用提出之后的数据验证
  for (const ns of (out.newSignals || []).slice(0, 2)) {
    try {
      compile(String(ns.when));
      if (defs.some(d => d.when === ns.when)) continue;
      const id = 'S' + String(Math.max(0, ...defs.filter(d => d.id.startsWith('S')).map(d => +d.id.slice(1) || 0)) + 1).padStart(3, '0');
      const def = { key: `${id}@v1`, id, version: 1, name: String(ns.name || '').slice(0, 40), sourceType: '复盘提炼', proposedBy: 'review', scope: ns.scope === '*' || CODES.includes(ns.scope) ? ns.scope : '*', when: String(ns.when), vote: +ns.vote > 0 ? 1 : -1, createdAt: today, proposedFrom: T };
      if (writeOnce(P('signals', 'definitions', `${id}@v1.json`), def)) { defs.push(def); state[def.key] = { status: '实验中', since: today, pending: null }; sigChangelog.push({ date: today, key: def.key, from: null, to: '实验中', why: `${T} 复盘提出` }); log(`新增实验信号 ${id}：${def.name}`); }
    } catch (e) { console.error('新信号无效：' + e.message); }
  }
  log(`${T} 复盘完成`);
}

// ---------- 8. 统计：按交易日聚类；正式结论用随时有效的序贯检验 ----------
const PREDICTORS = ['user', 'bench_external_raw', 'bench_external_beta', 'bench_prev', 'bench_zero', 'model', 'ai'];
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function clusterBoot(dayVals, iters = 2000) {   // dayVals：每个交易日一个数（当天各基金差值的平均）
  if (dayVals.length < 5) return null;
  const R = rng(7), m = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < dayVals.length; i++) s += dayVals[Math.floor(R() * dayVals.length)]; m.push(s / dayVals.length); }
  m.sort((a, b) => a - b);
  return [r3(m[Math.floor(iters * 0.025)]), r3(m[Math.floor(iters * 0.975)])];
}
function signFlipP(dayVals, iters = 5000) {   // 按日符号翻转的置换检验（单侧：我是否更好）
  if (dayVals.length < 5) return null;
  const obs = sum(dayVals), R = rng(11); let ge = 0;
  for (let k = 0; k < iters; k++) { let s = 0; for (const v of dayVals) s += R() < 0.5 ? v : -v; if (s >= obs) ge++; }
  return r3((ge + 1) / (iters + 1));
}
// 正态混合置信序列（随时有效）：每天都看也不会抬高假阳性率。单侧，只在"我更好"的方向累积证据
function alwaysValidP(dayVals, rho) {
  const n = dayVals.length; if (n < 5) return null;
  const s = sd(dayVals) || 1e-9, S_ = sum(dayVals);
  const lam = Math.sqrt(rho / (n + rho)) * Math.exp((S_ > 0 ? S_ * S_ : 0) / (2 * s * s * (n + rho)));
  return r3(Math.min(1, 1 / lam));
}
function computeStats() {
  const dir = P('results');
  const results = exists(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')).sort().map(f => readJ(path.join(dir, f))) : [];
  const agg = k => { let n = 0, hit = 0, e = 0; const days = new Set(); for (const r of results) for (const s of Object.values(r.scores[k] || {})) { n++; hit += s.hit; e += s.absErr; days.add(r.date); } return { obs: n, days: days.size, hit, rate: n ? r2(hit / n * 100) : null, mae: n ? r3(e / n) : null }; };
  const out = { updatedAt: nowISO, sampleUnit: '交易日 × 基金', predictors: {}, compare: {}, conclusion: null, byFund: {}, evidence: null, models: {}, aiVersions: {} };
  for (const k of PREDICTORS) out.predictors[k] = agg(k);
  out.predictors.user.lockedDays = results.filter(r => ['ok', 'modified_scored_first'].includes(r.meta.user?.status)).length;
  const pair = (a, b) => {
    const dMae = [], dDir = []; let wins = 0, losses = 0, both = 0, neither = 0, obs = 0;
    for (const r of results) {
      const em = [], ed = [];
      for (const c of CODES) { const x = r.scores[a]?.[c], y = r.scores[b]?.[c]; if (!x || !y) continue; obs++; em.push(y.absErr - x.absErr); ed.push((x.hit ? 1 : 0) - (y.hit ? 1 : 0)); if (x.hit && !y.hit) wins++; else if (!x.hit && y.hit) losses++; else if (x.hit) both++; else neither++; }
      if (em.length) { dMae.push(sum(em) / em.length); dDir.push(sum(ed) / ed.length * 100); }
    }
    const A = agg(a), B = agg(b);
    return { obs, days: dMae.length,
      mae: { mine: A.mae, bench: B.mae, improvePct: B.mae ? r2((B.mae - A.mae) / B.mae * 100) : null, meanGain: dMae.length ? r3(sum(dMae) / dMae.length) : null, ci95: clusterBoot(dMae), signFlipP: signFlipP(dMae), alwaysValidP: alwaysValidP(dMae, CFG.preregistration.rho) },
      direction: { mine: A.rate, bench: B.rate, liftPP: A.rate != null && B.rate != null ? r2(A.rate - B.rate) : null, wins, losses, both, neither, ci95: clusterBoot(dDir), signFlipP: signFlipP(dDir), alwaysValidP: alwaysValidP(dDir, CFG.preregistration.rho) } };
  };
  for (const a of ['user', 'model', 'ai']) { out.compare[a] = {}; for (const b of [...CFG.benchmarks.maePool, ...(a === 'user' ? ['model', 'ai'] : [])]) if (a !== b) out.compare[a][b] = pair(a, b); }
  const bestDir = CFG.benchmarks.directionPool.filter(k => out.predictors[k].obs).sort((x, y) => out.predictors[y].rate - out.predictors[x].rate)[0] || null;
  const bestMae = CFG.benchmarks.maePool.filter(k => out.predictors[k].obs).sort((x, y) => out.predictors[x].mae - out.predictors[y].mae)[0] || null;
  const pr = CFG.preregistration;
  const ends = [{ id: 'MAE', bench: bestMae, p: bestMae ? out.compare.user[bestMae]?.mae.alwaysValidP : null }, { id: 'DIR', bench: bestDir, p: bestDir ? out.compare.user[bestDir]?.direction.alwaysValidP : null }];
  const sorted = ends.filter(e => e.p != null).sort((x, y) => x.p - y.p); let stop = false;
  sorted.forEach((e, i) => { const lvl = pr.alpha / (sorted.length - i); e.level = r3(lvl); e.reject = !stop && e.p <= lvl; if (!e.reject) stop = true; });   // Holm
  const U = out.predictors.user;
  out.conclusion = { bestDirectionBenchmark: bestDir, bestMaeBenchmark: bestMae, endpoints: ends, obs: U.obs, days: U.days, gateOpen: U.obs >= pr.minObsForConclusion,
    verdict: U.obs < pr.minObsForConclusion ? 'insufficient' : ends.some(e => e.reject) ? 'evidence' : 'no_evidence' };
  for (const c of CODES) out.byFund[c] = Object.fromEntries(PREDICTORS.map(k => { let n = 0, hit = 0, e = 0; for (const r of results) { const s = r.scores[k]?.[c]; if (s) { n++; hit += s.hit; e += s.absErr; } } return [k, { obs: n, rate: n ? r2(hit / n * 100) : null, mae: n ? r3(e / n) : null }]; }));
  const g = { clean: [], flagged: [], subjective: [] };
  for (const r of results) for (const c of CODES) {
    const s = r.scores.user?.[c]; if (!s) continue;
    const ch = r.userChecks?.[c] || [];
    const flagged = ch.some(x => x.signals.some(v => v.verdict !== '有效依据') || x.data.some(v => v.verdict === '事后信息'));
    const subjective = !ch.length || ch.every(x => !x.signals.length && !x.data.length);
    g[flagged ? 'flagged' : subjective ? 'subjective' : 'clean'].push(s);
  }
  out.evidence = Object.fromEntries(Object.entries(g).map(([k, xs]) => [k, { obs: xs.length, rate: xs.length ? r2(xs.filter(x => x.hit).length / xs.length * 100) : null, mae: xs.length ? r3(sum(xs.map(x => x.absErr)) / xs.length) : null }]));
  for (const r of results) { const v = r.meta.model?.modelVersion; if (!v) continue; const o = (out.models[v] ||= { obs: 0, hit: 0, e: 0 }); for (const s of Object.values(r.scores.model || {})) { o.obs++; o.hit += s.hit; o.e += s.absErr; } }
  for (const o of Object.values(out.models)) { o.rate = o.obs ? r2(o.hit / o.obs * 100) : null; o.mae = o.obs ? r3(o.e / o.obs) : null; delete o.e; }
  for (const r of results) { const v = r.meta.ai?.aiVersion; if (!v) continue; const o = (out.aiVersions[v] ||= { obs: 0, hit: 0, e: 0, modelNames: [] }); if (!o.modelNames.includes(r.meta.ai.modelName)) o.modelNames.push(r.meta.ai.modelName); for (const s of Object.values(r.scores.ai || {})) { o.obs++; o.hit += s.hit; o.e += s.absErr; } }
  for (const o of Object.values(out.aiVersions)) { o.rate = o.obs ? r2(o.hit / o.obs * 100) : null; o.mae = o.obs ? r3(o.e / o.obs) : null; delete o.e; }
  const pool = defs.filter(d => statusOf(d.key) !== '淘汰' && d.sourceType !== '外部观点').map(d => { const R = state[d.key]?.stats?.research || {}, H = state[d.key]?.stats?.holdout || {}; const days = (R.days || 0) + (H.days || 0); const h = (R.rate || 0) / 100 * (R.days || 0) + (H.rate || 0) / 100 * (H.days || 0); const [lo, hi] = wilson(h, days); return { id: d.id, name: d.name, days, rate: days ? r2(h / days * 100) : null, lo, hi, base: R.base, status: statusOf(d.key) }; }).filter(x => x.days >= CFG.signals.minDays);
  out.reliable = [...pool].sort((a, b) => b.lo - a.lo).slice(0, 5);
  out.deceptive = [...pool].sort((a, b) => a.hi - b.hi).slice(0, 5);
  return out;
}

// ---------- 9. 主流程 ----------
try {
  const pdir = P('predictions');
  const pdays = exists(pdir) ? fs.readdirSync(pdir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && d <= today).sort() : [];
  for (const T of pdays) await settle(T);
  tryUpgrade();
  const w = windowNow();
  if (w) await prepare(w.T, w.batch);
  else log('不在批次时间窗内，只做结算');
  try {   // 最新消息面：随时可看（不进入预测快照，预测只用批次快照）
    const nT = CAL.isTD(today) && hm < '15:00' ? today : CAL.nextTD(today), since = at(CAL.isTD(today) && hm >= '15:00' ? today : CAL.prevTD(nT), '15:00');
    const list = await news(since, nowISO), rel = list.filter(n => n.relevant), base = rel.length >= 15 ? rel : list;
    const keep = (base.length <= 150 ? base : [...base.filter(n => n.score > 0), ...base.filter(n => !(n.score > 0)).slice(-150)].slice(0, 150)).sort((a, b) => ms(a.time) - ms(b.time));
    const items = keep.map(n => ({ id: n.id, name: '快讯', text: n.text, source: n.source, url: n.url || undefined, dataTime: n.time, cutoff: n.time, fetchedAt: nowISO, kind: '消息' }));
    let digest = null; try { digest = await newsDigest(nT, items, nowISO); } catch (e) { log('最新消息面摘要失败：' + e.message); }
    writeJ(P('news', 'latest.json'), { asOf: nowISO, since, forDate: nT, items, digest });
  } catch (e) { log('最新消息面失败：' + e.message); }
} catch (e) { log('运行出错：' + (e.stack || e.message).slice(0, 400)); process.exitCode = 1; }

writeJ(stateF, state);
writeJ(P('signals', 'changelog.json'), sigChangelog);
writeJ(P('signals', 'public.json'), defs.map(d => ({ ...d, status: statusOf(d.key), pending: state[d.key]?.pending || null, stats: state[d.key]?.stats || null, bhPass: !!state[d.key]?.bhPass })));
writeJ(P('models', 'changelog.json'), modelLog);
writeJ(P('state', 'holdings.json'), Object.fromEntries(funds.map(f => [f.code, f.holding])));
writeJ(P('index.json'), index);
writeJ(P('stats.json'), computeStats());
writeJ(P('status.json'), { lastRun: nowISO, runId: RUN.id, trigger: RUN.trigger, report, split: { research: [researchDays[0], researchDays.at(-1)], holdout: [holdoutDays[0], holdoutDays.at(-1)] } });
console.log('完成');
