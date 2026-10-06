// 基金日记 v2 · 实验引擎（设计见 docs/DESIGN.md · 2026-10-08 起正式运行）
// MODE=evening：结算今天（净值→评分→复盘→信号统计→模型门槛），再为下一交易日出晚间快照与草稿
// MODE=morning：为今天出早间快照与草稿（隔夜美股已收盘）
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const ROOT = new URL('..', import.meta.url).pathname;
const DATA = path.join(ROOT, 'data');
const P = (...a) => path.join(DATA, ...a);
const exists = f => fs.existsSync(f);
const readJ = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (def !== undefined) return def; throw e; } };
const writeJ = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 1) + '\n'); };
const writeOnce = (f, o) => { if (exists(f)) return false; writeJ(f, o); return true; };   // 快照、预测：只增不改

const KEY = process.env.GEMINI_API_KEY || '';
const MODELS = [...new Set([process.env.GEMINI_MODEL, 'gemini-3.6-flash', 'gemini-3.5-flash-lite'].filter(Boolean))];
const CFG = readJ(P('config.json'));
const funds = readJ(P('funds.json'));
const cal = readJ(P('calendar.json'));
let signals = readJ(P('signals.json'));
const changelog = readJ(P('models', 'changelog.json'), []);
const index = readJ(P('index.json'), { days: {} });
const report = [];
const log = s => { console.log(s); report.push(s); };
const CODES = funds.map(f => f.code);
const FUND = Object.fromEntries(funds.map(f => [f.code, f]));
const EPS = CFG.flatBand;

// ---------- 时间 ----------
const bjDate = (ms = Date.now()) => new Date(ms + 8 * 3600e3);
const NOWMS = Number(process.env.NOW_MS || Date.now());
const NOW = bjDate(NOWMS);
const today = NOW.toISOString().slice(0, 10);
const nowISO = NOW.toISOString().slice(0, 19) + '+08:00';
const hourBJ = NOW.getUTCHours() + NOW.getUTCMinutes() / 60;
const MODE = process.env.MODE || (hourBJ < 12 ? 'morning' : 'evening');
const ms = iso => Date.parse(iso);
const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
const dayNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;
const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
const isTD = d => { const w = weekday(d); return w > 0 && w < 6 && !cal.holidays.includes(d); };
const nextTD = d => { let x = addDays(d, 1); for (let i = 0; i < 40 && !isTD(x); i++) x = addDays(x, 1); return x; };
const prevTD = d => { let x = addDays(d, -1); for (let i = 0; i < 40 && !isTD(x); i++) x = addDays(x, -1); return x; };
const at = (d, hm) => `${d}T${hm}:00+08:00`;
const deadlineOf = T => at(T, CFG.deadline);
const morningAsOf = T => at(T, '08:07');

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
const r2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;
const pct = v => v == null || !Number.isFinite(+v) ? '–' : (v > 0 ? '+' : '') + Number(v).toFixed(2) + '%';

// ---------- 1. 行情序列（每个数据点带"何时可获得"） ----------
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
    for (const p of JSON.parse(m[1]).slice(-320)) if (Number.isFinite(+p.equityReturn)) map[bjDate(p.x).toISOString().slice(0, 10)] = +p.equityReturn;
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
async function series(name, yahooSyms, emSecid) {
  for (const s of yahooSyms || []) { try { return await yahoo(s); } catch (e) { console.error(`${name} Yahoo ${s}：${e.message}`); } }
  if (emSecid) { try { return await emKline(emSecid); } catch (e) { console.error(`${name} 东财：${e.message}`); } }
  log(`${name} 行情抓取失败`); return {};
}
// 何时可获得（北京时间）
const CUT = {
  cn: d => at(d, '15:00'),
  hk: d => at(d, '16:10'),
  us: d => at(addDays(d, 1), '05:00'),
  nav: d => at(d, '21:00'),
  navQdii: d => at(nextTD(d), '21:00'),
};
function mkSeries(id, name, map, cutoff, source) {
  const dates = Object.keys(map).sort();
  return { id, name, map, cutoff, source, dates, cuts: dates.map(d => ms(cutoff(d))) };
}
// T 之前、且在 asOf 时已可获得的最近 n 个数据点
function avail(s, T, asOfMs, n = 1) {
  const out = [];
  for (let i = s.dates.length - 1; i >= 0 && out.length < n; i--) if (s.dates[i] < T && s.cuts[i] <= asOfMs) out.push({ date: s.dates[i], v: s.map[s.dates[i]] });
  return out.reverse();
}

const IDX = {
  sh: ['上证指数', ['000001.SS'], '1.000001', 'cn'], cyb: ['创业板指', ['399006.SZ', '159915.SZ'], '0.399006', 'cn'],
  kc50: ['科创50', ['000688.SS', '588000.SS'], '1.000688', 'cn'], ndx: ['纳斯达克100', ['^NDX'], '100.NDX', 'us'],
  spx: ['标普500', ['^GSPC'], '100.SPX', 'us'], sox: ['费城半导体', ['^SOX'], '100.SOX', 'us'],
  kweb: ['中概互联网', ['KWEB'], null, 'us'], hstech: ['恒生科技', ['^HSTECH', '3033.HK'], '124.HSTECH', 'hk'],
};
const ETF_FALLBACK = { '半导体': ['512480.SS'], 'PCB': ['515260.SS'], '元件': ['515260.SS'] };
const S = {};
for (const [k, [name, ys, em, kind]] of Object.entries(IDX)) S[k] = mkSeries(k, name, await series(name, ys, em), CUT[kind], ys[0]);
const NAV = {}, ANC = {};
for (const f of funds) {
  let m = {}; try { m = await navHist(f.code); } catch (e) { log(`${f.short} 净值抓取失败：${e.message}`); }
  NAV[f.code] = mkSeries('NAV.' + f.code, f.short + '净值', m, f.qdii ? CUT.navQdii : CUT.nav, '天天基金');
  if (f.anchor.series) ANC[f.code] = S[f.anchor.series];
  else {
    let am = {};
    try { const id = await boardSecid(f.anchor.name); if (id) am = await emKline(id); } catch (e) { console.error(`${f.anchor.name}：${e.message}`); }
    if (!Object.keys(am).length) am = await series(f.anchor.name + '（ETF 代替）', ETF_FALLBACK[f.anchor.name], null);
    ANC[f.code] = mkSeries('ANC.' + f.code, f.anchor.name, am, CUT.cn, '东财板块');
  }
}
const tdays = (S.sh.dates.length ? S.sh.dates : NAV[CODES[0]].dates).filter(d => d <= today);

// 持仓随净值滚动（不加减仓的前提下）
for (const f of funds) {
  const h = f.holding;
  for (const d of NAV[f.code].dates.filter(d => d > h.navDate)) { const v = NAV[f.code].map[d], dl = h.amount * v / 100; h.amount = r2(h.amount + dl); h.pnl = r2(h.pnl + dl); h.navDate = d; }
  h.pnlPct = r2(h.pnl / (h.amount - h.pnl) * 100);
}

// ---------- 2. 因子（时点纪律：只用 asOf 时已可获得的数据） ----------
const sum = a => a.length ? a.reduce((s, x) => s + x, 0) : null;
const sd = a => { if (a.length < 5) return null; const m = sum(a) / a.length; return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
function features(T, asOfIso, extra = {}) {
  const A = ms(asOfIso), refs = {};
  const one = (key, s) => { const x = avail(s, T, A, 1)[0]; if (x) refs[key] = { id: `${s.id}@${x.date}`, date: x.date, cutoff: s.cutoff(x.date) }; return x ? r2(x.v) : null; };
  const P_ = prevTD(T);
  // 隔夜/假期累计：上一个 A 股交易日收盘之后发生的外盘涨跌（长假时把假期内每天累加）
  const since = (key, s) => { const xs = avail(s, T, A, 15).filter(x => x.date >= P_); if (!xs.length) return null; const l = xs.at(-1); refs[key] = { id: `${s.id}@${l.date}`, date: l.date, cutoff: s.cutoff(l.date), from: xs[0].date, days: xs.length }; return r2((xs.reduce((m, x) => m * (1 + x.v / 100), 1) - 1) * 100); };
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
    if (last) refs[`${fd.code}.prev`] = { id: `${NAV[fd.code].id}@${last.date}`, date: last.date, cutoff: NAV[fd.code].cutoff(last.date) };
    if (al) refs[`${fd.code}.anc`] = { id: `${ANC[fd.code].id}@${al.date}`, date: al.date, cutoff: ANC[fd.code].cutoff(al.date) };
    f[fd.code] = {
      prev: r2(last?.v), mom5: r2(sum(nav.slice(-5).map(x => x.v))), anc: r2(al?.v), anc_mom3: r2(sum(anc.map(x => x.v))),
      dev: last && al && last.date === al.date ? r2(last.v - al.v) : null, vol20: r2(sd(nav.map(x => x.v))),
    };
  }
  return { asOf: asOfIso, c, f, refs };
}
const usMove = (feat, code) => FUND[code].qdii ? feat.c.ndx_on : feat.c.sox_on;

// ---------- 3. 信号 ----------
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
function fires(sig, feat, code) {
  if (sig.scope !== '*' && sig.scope !== code) return false;
  const v = { ...feat.c, ...feat.f[code], qdii: !!FUND[code].qdii };
  try { return !!compile(sig.when)(...VARS.map(k => k === 'qdii' ? v.qdii : (v[k] == null ? NaN : v[k])), Math); } catch { return false; }
}
const tri = v => v == null ? null : v > EPS ? '涨' : v < -EPS ? '跌' : '平';

// 历史样本（每个交易日按"早间可获得"的信息计算因子）
const WINDOW = CFG.researchDays + CFG.holdoutDays;
const histDays = tdays.filter(d => d >= (tdays[25] || tdays[0])).slice(-WINDOW);
const ROWS = [];
for (const T of histDays) {
  const feat = features(T, morningAsOf(T));
  for (const c of CODES) { const a = NAV[c].map[T]; if (a != null) ROWS.push({ T, c, feat, a }); }
}
const splitDay = histDays[Math.max(0, histDays.length - CFG.holdoutDays)];
const RESEARCH = ROWS.filter(r => r.T < splitDay), HOLDOUT = ROWS.filter(r => r.T >= splitDay);

function wilson(h, n) { if (!n) return [null, null]; const z = 1.96, p = h / n, d = 1 + z * z / n, c = p + z * z / (2 * n), s = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)); return [r2((c - s) / d * 100), r2((c + s) / d * 100)]; }
function sigStats(sig, rows) {
  let n = 0, hit = 0, up = 0, dn = 0, sumA = 0, baseN = 0, baseH = 0;
  const want = sig.vote > 0 ? '涨' : '跌';
  for (const r of rows) {
    const t = tri(r.a); if (t === '平') continue;
    baseN++; baseH += t === want;
    if (!fires(sig, r.feat, r.c)) continue;
    n++; hit += t === want; up += t === '涨'; dn += t === '跌'; sumA += r.a;
  }
  const implied = n ? sumA / n : null;
  let mae = null; if (n) { let e = 0, k = 0; for (const r of rows) if (tri(r.a) !== '平' && fires(sig, r.feat, r.c)) { e += Math.abs(implied - r.a); k++; } mae = r2(e / k); }
  const [lo, hi] = wilson(hit, n);
  return { n, hit, up, down: dn, rate: n ? r2(hit / n * 100) : null, lo, hi, mae, implied: r2(implied), base: baseN ? r2(baseH / baseN * 100) : null };
}
function updateStatuses() {
  for (const s of signals) {
    s.research = sigStats(s, RESEARCH); s.holdout = sigStats(s, HOLDOUT);
    const R = s.research, H = s.holdout, nAll = R.n + H.n, old = s.status;
    let st = old;
    if (old !== '淘汰') {
      if (nAll < CFG.minSamples) st = '实验中';
      else if (R.n >= CFG.minSamples && R.lo > R.base && H.n >= 5 && H.rate > H.base) st = '有效';
      else if ((R.n >= CFG.minSamples && R.hi < R.base) || (old === '有效' && H.n >= 5 && H.rate < H.base)) st = '失效';
      else st = old === '失效' ? '失效' : '待验证';
      if (st === '失效') {
        const since = [...s.statusHistory].reverse().find(h => h.to === '失效')?.date;
        if (old === '失效' && since && tdays.filter(d => d > since && d <= today).length >= CFG.retireAfter) st = '淘汰';
      }
    }
    if (st !== old) { s.statusHistory.push({ date: today, from: old, to: st, why: `研究集 ${R.rate ?? '–'}%（${R.n}次，区间 ${R.lo ?? '–'}~${R.hi ?? '–'}，基准 ${R.base ?? '–'}%）；留出集 ${H.rate ?? '–'}%（${H.n}次，基准 ${H.base ?? '–'}%）` }); s.status = st; log(`信号 ${s.id} ${old} → ${st}`); }
  }
}
updateStatuses();

// ---------- 4. 规则模型与基准 ----------
function fitLin(rows) {
  const n = rows.length; if (n < 30) return { a: 0, b: 0, n };
  const mx = sum(rows.map(r => r[0])) / n, my = sum(rows.map(r => r[1])) / n;
  let sxy = 0, sxx = 0; for (const [x, y] of rows) { sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; }
  const b = sxx ? sxy / (sxx * 1.1) : 0;
  return { a: r3(my - b * mx), b: r3(b), n };
}
const modelScore = (model, feat, code, drop = []) => model.signals.filter(id => !drop.includes(id)).reduce((s, id) => { const g = signals.find(x => x.id === id); return s + (g && fires(g, feat, code) ? g.vote : 0); }, 0);
function buildModel(version, ids, why) {
  const m = { version, createdAt: nowISO, signals: ids, why };
  m.fit = fitLin(RESEARCH.map(r => [modelScore(m, r.feat, r.c), r.a]));
  m.benchUs = fitLin(RESEARCH.filter(r => usMove(r.feat, r.c) != null).map(r => [usMove(r.feat, r.c), r.a]));
  return m;
}
const clampV = v => Math.max(-10, Math.min(10, v));
const modelValue = (m, feat, code, drop) => r2(clampV(m.fit.a + m.fit.b * modelScore(m, feat, code, drop)));
function benchValues(m, feat, code) {
  const u = usMove(feat, code);
  return { bench_us: u == null ? null : r2(clampV(m.benchUs.a + m.benchUs.b * u)), bench_prev: feat.f[code].prev, bench_zero: 0 };
}
function scoreSet(rows, fn) {
  let n = 0, hit = 0, e = 0, en = 0;
  for (const r of rows) { const v = fn(r); if (v == null) continue; en++; e += Math.abs(v - r.a); n++; hit += tri(v) === tri(r.a); }
  return { n, hit, rate: n ? r2(hit / n * 100) : null, mae: en ? r3(e / en) : null };
}
let model = readJ(P('models', 'current.json'), null);
if (!model) {
  model = buildModel('v1.0', signals.filter(s => s.status === '有效').map(s => s.id), '初始版本：使用当前全部「有效」信号');
  writeJ(P('models', 'v1.0.json'), model); writeJ(P('models', 'current.json'), model);
  changelog.push({ version: 'v1.0', createdAt: nowISO, change: model.why, signals: model.signals, research: { new: scoreSet(RESEARCH, r => modelValue(model, r.feat, r.c)) }, holdout: { new: scoreSet(HOLDOUT, r => modelValue(model, r.feat, r.c)) }, passed: true, status: '正式上线' });
  log('建立规则模型 v1.0');
}
// 门槛：有效信号集合变化时，尝试升级
function tryUpgrade() {
  const want = signals.filter(s => s.status === '有效').map(s => s.id).sort();
  if (JSON.stringify(want) === JSON.stringify([...model.signals].sort())) return;
  const [maj, min] = model.version.slice(1).split('.').map(Number);
  const cand = buildModel(`v${maj}.${min + 1}`, want, '');
  const added = want.filter(x => !model.signals.includes(x)), removed = model.signals.filter(x => !want.includes(x));
  cand.why = [added.length ? '加入 ' + added.join('、') : '', removed.length ? '移除 ' + removed.join('、') : ''].filter(Boolean).join('；');
  const R0 = scoreSet(RESEARCH, r => modelValue(model, r.feat, r.c)), R1 = scoreSet(RESEARCH, r => modelValue(cand, r.feat, r.c));
  const H0 = scoreSet(HOLDOUT, r => modelValue(model, r.feat, r.c)), H1 = scoreSet(HOLDOUT, r => modelValue(cand, r.feat, r.c));
  const benches = ['bench_us', 'bench_prev', 'bench_zero'].map(k => ({ k, s: scoreSet(HOLDOUT, r => benchValues(cand, r.feat, r.c)[k]) }));
  const best = benches.sort((a, b) => a.s.mae - b.s.mae)[0];
  const ok = (o, x) => x.mae <= o.mae + CFG.gate.mae && (x.rate ?? 0) >= (o.rate ?? 0) - CFG.gate.hit;
  const hadEdge = H0.mae < best.s.mae, keepsEdge = !hadEdge || H1.mae < best.s.mae;
  const passed = ok(R0, R1) && ok(H0, H1) && keepsEdge;
  changelog.push({ version: cand.version, createdAt: nowISO, change: cand.why, signals: want, reason: '信号状态变化后自动尝试', research: { old: R0, new: R1 }, holdout: { old: H0, new: H1 }, vsBenchmark: { name: best.k, holdout: best.s }, passed, status: passed ? '正式上线' : '未上线' });
  if (passed) { model = cand; writeJ(P('models', `${cand.version}.json`), cand); writeJ(P('models', 'current.json'), cand); log(`规则模型升级到 ${cand.version}：${cand.why}`); }
  else log(`规则模型 ${cand.version} 未通过门槛：${cand.why}`);
}

// ---------- 5. Gemini ----------
function parseJson(t) { const s = t.replace(/```json|```/g, ''); const a = s.indexOf('{'), b = s.lastIndexOf('}'); if (a < 0 || b < a) throw new Error('输出中没有 JSON'); return JSON.parse(s.slice(a, b + 1)); }
async function gemini(text, label) {
  if (!KEY) throw new Error('缺少 GEMINI_API_KEY');
  for (const m of MODELS) {
    try {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': KEY },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text }] }], generationConfig: { temperature: 0.3, responseMimeType: 'application/json' } }) });
      if (r.ok) { const j = await r.json(); const t = (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join(''); if (t.trim()) { console.log(`${label}：${m}`); return parseJson(t); } }
      else console.error(`${label}：${m} ${r.status} ${(await r.text()).slice(0, 160)}`);
    } catch (e) { console.error(`${label}：${m} ${e.message}`); }
    await new Promise(res => setTimeout(res, 13000));
  }
  throw new Error('Gemini 不可用');
}
const NEWS_KEYS = /半导体|芯片|PCB|覆铜板|MLCC|光模块|英伟达|台积电|美联储|关税|出口管制|央行|降准|降息|证监会|科创|纳斯达克|美股|港股|A股|算力|AI|存储|汇率|国务院/;
async function news() {
  try {
    const t = await get(`https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=100&req_trace=${Date.now()}`);
    const list = JSON.parse(t)?.data?.fastNewsList || []; if (!list.length) throw new Error('空');
    return list.map(n => ({ time: String(n.showTime).replace(' ', 'T') + '+08:00', text: `${n.title || ''}：${(n.summary || '').slice(0, 100)}` }));
  } catch {
    try {
      const t = await get('https://zhibo.sina.com.cn/api/zhibo/feed?page=1&page_size=100&zhibo_id=152&tag_id=0&dire=f&dpc=1');
      return (JSON.parse(t)?.result?.data?.feed?.list || []).map(n => ({ time: String(n.create_time).replace(' ', 'T') + '+08:00', text: String(n.rich_text).replace(/<[^>]+>/g, '').slice(0, 120) }));
    } catch (e) { log('快讯抓取失败：' + e.message); return []; }
  }
}
async function externalView(sinceIso) {   // 外部观点：作为普通信号输入，前台不单独展示
  const t = await get('https://www.sina.cn/media/1896820725');
  const text = t.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;|&#\d+;/g, ' ').replace(/\s+/g, ' ').slice(0, 9000);
  if (text.length < 200) throw new Error('页面内容过少');
  const out = await gemini(`下面是一位财经博主主页抓取到的文字。现在是北京时间 ${nowISO}。只看 ${sinceIso} 之后发布的内容，判断他对下一个A股交易日大盘的倾向：2明确看多，1偏多，0中性或无判断，-1偏空，-2明确看空；没有可识别的帖子填 null。只输出 JSON：{"stance":0}\n\n${text}`, '外部观点');
  const s = out.stance == null ? null : Math.max(-2, Math.min(2, Math.round(+out.stance)));
  return Number.isFinite(s) ? s : null;
}

// ---------- 6. 快照、触发、系统预测（晚间 / 早间批次） ----------
const VAR_NAMES = { sh_prev: '上证指数', cyb_prev: '创业板指', kc50_prev: '科创50', kc50_mom5: '科创50近5日', ndx_on: '纳斯达克100', spx_on: '标普500', sox_on: '费城半导体', kweb_on: '中概互联网(KWEB)', hstech_prev: '恒生科技' };
function snapshotItems(feat, newsList, asOfIso) {
  const items = [];
  for (const [k, ref] of Object.entries(feat.refs)) {
    const [code, sub] = k.includes('.') ? k.split('.') : [null, null];
    const value = code ? feat.f[code][sub] : feat.c[k];
    const name = (code ? `${FUND[code].short}${sub === 'prev' ? ' 上一净值日涨跌' : ' 锚定（' + FUND[code].anchor.name + '）'}` : VAR_NAMES[k] || k) + (ref.days > 1 ? `（${ref.from}起 ${ref.days} 个交易日累计）` : '');
    items.push({ id: ref.id, key: k, name, value, unit: '%', dataTime: ref.date, cutoff: ref.cutoff, fetchedAt: nowISO, kind: '行情' });
  }
  for (const n of newsList.filter(n => ms(n.time) <= ms(asOfIso) && NEWS_KEYS.test(n.text)).slice(0, 25))
    items.push({ id: 'NEWS@' + n.time, name: '快讯', text: n.text, dataTime: n.time, cutoff: n.time, fetchedAt: nowISO, kind: '消息' });
  return items;
}
async function prepare(T, batch) {
  const asOf = nowISO;
  const snapF = P('snapshots', T, `${batch}.json`);
  if (exists(snapF)) { log(`${T} ${batch} 快照已存在`); return; }
  let ext = null;
  try { ext = await externalView(at(prevTD(T), '15:00')); } catch (e) { console.error('外部观点：' + e.message); }
  const feat = features(T, asOf, { guxia: ext });
  const newsList = await news();
  const items = snapshotItems(feat, newsList, asOf);
  if (ext != null) items.push({ id: 'EXT@' + asOf, name: '外部观点', value: ext, dataTime: asOf, cutoff: asOf, fetchedAt: nowISO, kind: '外部观点', hidden: true });
  writeOnce(snapF, { date: T, batch, asOf, features: feat, items });
  // 触发表
  const trig = { date: T, batch, snapshot: `${T}/${batch}`, funds: {} };
  for (const c of CODES) trig.funds[c] = signals.filter(s => s.status !== '淘汰' && fires(s, feat, c)).map(s => ({ signal: s.id, status: s.status }));
  writeOnce(P('triggers', T, `${batch}.json`), trig);
  // 规则模型与三个基准
  const sys = { model: {}, bench_us: {}, bench_prev: {}, bench_zero: {} };
  for (const c of CODES) { sys.model[c] = { value: modelValue(model, feat, c), score: modelScore(model, feat, c) }; const b = benchValues(model, feat, c); for (const k in b) sys[k][c] = { value: b[k] }; }
  for (const k of Object.keys(sys)) writeOnce(P('predictions', T, `${k}-${batch}.json`), { date: T, predictor: k, batch, createdAt: nowISO, lockedAt: nowISO, snapshot: `${T}/${batch}`, dataCutoff: asOf, modelVersion: model.version, funds: sys[k] });
  // AI 草稿（对照组，也给你参考）
  try {
    const ai = await aiDraft(T, feat, items, trig, sys);
    writeOnce(P('predictions', T, `ai-${batch}.json`), { date: T, predictor: 'ai', batch, createdAt: nowISO, lockedAt: nowISO, snapshot: `${T}/${batch}`, dataCutoff: asOf, modelVersion: model.version, ...ai });
  } catch (e) { log('AI 草稿失败：' + e.message); }
  const day = (index.days[T] ||= { batches: [] }); if (!day.batches.includes(batch)) day.batches.push(batch);
  log(`${T} ${batch} 批次：快照 ${items.length} 条数据，草稿已生成`);
}
function sigLine(id) {
  const s = signals.find(x => x.id === id); if (!s) return id;
  return `${s.id} ${s.name}（${s.status}；研究集命中${s.research.rate ?? '–'}%/${s.research.n}次，基准${s.research.base ?? '–'}%；留出集${s.holdout.rate ?? '–'}%/${s.holdout.n}次）`;
}
async function aiDraft(T, feat, items, trig, sys) {
  const data = items.filter(i => !i.hidden).map(i => `[${i.id}] ${i.name}${i.value != null ? ' ' + pct(i.value) : ''}${i.text ? '：' + i.text : ''}（数据时间 ${i.dataTime}）`).join('\n');
  const fundsTxt = funds.map(f => {
    const t = trig.funds[f.code] || [];
    const valid = t.filter(x => x.status === '有效').map(x => sigLine(x.signal)), other = t.filter(x => x.status !== '有效').map(x => sigLine(x.signal));
    return `${f.code} ${f.name}（${f.type}${f.qdii ? '；QDII，T日净值对应海外T日收盘' : ''}）\n  特征：${f.drivers.join('；')}\n  近20日波动 ${feat.f[f.code].vol20 ?? '–'}%，上一日 ${pct(feat.f[f.code].prev)}，近5日 ${pct(feat.f[f.code].mom5)}，锚定 ${pct(feat.f[f.code].anc)}，锚定近3日 ${pct(feat.f[f.code].anc_mom3)}\n  今天触发且历史有效（可作依据）：${valid.join('；') || '无'}\n  今天触发但未被证明有效（不能作依据）：${other.join('；') || '无'}`;
  }).join('\n');
  const out = await gemini(`你是这五只基金的持有人，以投资人身份预测 ${T} 各基金的净值涨跌幅。现在是北京时间 ${nowISO}，只能使用下面列出的、此刻已经可以获得的数据。
评分：方向（涨>+${EPS}%，跌<-${EPS}%，其余为平）和绝对误差。每只基金只给一个数值，不给区间和概率。

可用数据（[编号] 名称 数值，数据时间）：
${data}

各基金：
${fundsTxt}

规则：
- 只有「今天触发且历史有效」的规律可以作为依据，引用时写出编号和历史命中率。
- 没触发的规律不能说"触发了"；未被证明有效的规律不能当理由。
- 每条理由尽量引用数据编号（dataRefs）。主观判断要写明是主观判断。
- 依据互相矛盾时写明，并把数值往0收。
- 独立判断，不要照抄任何模型的数值；五只基金的差别要有理由。

只输出 JSON：{"overall":{"value":0.5,"reasons":[{"text":"40字内","signals":[],"dataRefs":[]}],"conclusion":"一句话"},"funds":{"代码":{"value":0.8,"reasons":[{"text":"40字内","signals":["R001"],"dataRefs":["..."]}],"conclusion":"一句话"}}}`, `AI 草稿 ${T}`);
  const fx = {};
  const clean = rs => (Array.isArray(rs) ? rs : []).slice(0, 5).map(r => ({ text: String(r.text || '').slice(0, 90), signals: (r.signals || []).filter(id => signals.some(s => s.id === id)), dataRefs: (r.dataRefs || []).filter(id => items.some(i => i.id === id)) })).filter(r => r.text);
  for (const c of CODES) { const p = out.funds?.[c]; const v = +p?.value; if (!Number.isFinite(v)) continue; fx[c] = { value: r2(clampV(v)), reasons: clean(p.reasons), conclusion: String(p.conclusion || '').slice(0, 80) }; }
  const ov = +out.overall?.value;
  return { overall: { value: Number.isFinite(ov) ? r2(clampV(ov)) : null, reasons: clean(out.overall?.reasons), conclusion: String(out.overall?.conclusion || '').slice(0, 80) }, funds: fx };
}

// ---------- 7. 结算：锁定校验 → 评分 → 复盘 ----------
function git(...args) { try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } }
function userPrediction(T) {
  const rel = `data/predictions/${T}/user.json`;
  if (!exists(path.join(ROOT, rel))) return null;
  const commits = git('log', '--format=%H %cI', '--follow', '--', rel).split('\n').filter(Boolean).map(l => l.split(' '));
  let content, lockedAt, tampered = false;
  if (commits.length) {
    const [first, time] = commits.at(-1);
    lockedAt = time; tampered = commits.length > 1;
    try { content = JSON.parse(git('show', `${first}:${rel}`)); } catch { content = readJ(path.join(ROOT, rel)); }
  } else { content = readJ(path.join(ROOT, rel)); lockedAt = content.lockedAt || content.createdAt; }
  const late = ms(lockedAt) > ms(deadlineOf(T));
  return { ...content, lockedAt, late, tampered };
}
function sysPrediction(T, who) {
  for (const b of ['morning', 'evening', 'early']) { const f = P('predictions', T, `${who}-${b}.json`); if (exists(f)) return readJ(f); }
  return null;
}
// 依据核验（与 app 提交时同一规则；以锁定前最后一个批次的触发表为准）
function verifyReasons(T, pred) {
  const trig = readJ(P('triggers', T, 'morning.json'), null) || readJ(P('triggers', T, 'evening.json'), null) || readJ(P('triggers', T, 'early.json'), null);
  const snap = readJ(P('snapshots', T, 'morning.json'), null) || readJ(P('snapshots', T, 'evening.json'), null) || readJ(P('snapshots', T, 'early.json'), null);
  const out = {};
  for (const [c, f] of Object.entries(pred.funds || {})) out[c] = (f.reasons || []).map(r => {
    const sigV = (r.signals || []).map(id => { const s = signals.find(x => x.id === id), t = trig?.funds?.[c]?.find(x => x.signal === id); return { id, verdict: !t ? '今天未触发' : t.status !== '有效' ? '历史不成立' : '有效依据' }; });
    const dataV = (r.dataRefs || []).map(id => { const it = snap?.items?.find(i => i.id === id); return { id, verdict: !it ? '数据不在快照中' : ms(it.cutoff) <= ms(pred.lockedAt) ? '预测前已成立' : '事后信息' }; });
    return { signals: sigV, data: dataV };
  });
  return out;
}
function scoreDay(T, actual) {
  const preds = { user: userPrediction(T), ai: sysPrediction(T, 'ai'), model: sysPrediction(T, 'model'), bench_us: sysPrediction(T, 'bench_us'), bench_prev: sysPrediction(T, 'bench_prev'), bench_zero: sysPrediction(T, 'bench_zero') };
  const scores = {}, meta = {};
  for (const [k, p] of Object.entries(preds)) {
    if (!p) { meta[k] = { status: '缺席' }; continue; }
    meta[k] = { status: p.late ? '迟交' : p.tampered ? '已改动（按首次提交计分）' : '有效', lockedAt: p.lockedAt, batch: p.batch || null };
    if (p.late) continue;
    scores[k] = {};
    for (const c of CODES) {
      const v = p.funds?.[c]?.value, a = actual[c];
      if (v == null || a == null) continue;
      scores[k][c] = { pred: v, actual: a, dirPred: tri(v), dirActual: tri(a), hit: tri(v) === tri(a), absErr: r2(Math.abs(v - a)) };
    }
  }
  return { preds, scores, meta };
}
async function settle(T) {
  const actual = {}; for (const c of CODES) if (NAV[c].map[T] != null) actual[c] = NAV[c].map[T];
  const domestic = funds.filter(f => !f.qdii).map(f => f.code);
  if (!domestic.every(c => actual[c] != null)) { log(`${T} 净值未全部公布，稍后再结算`); return false; }
  const old = readJ(P('results', T + '.json'), null);
  const { preds, scores, meta } = scoreDay(T, actual);
  const res = { date: T, actual, navSource: '天天基金', fetchedAt: nowISO, scores, meta, revisions: old?.revisions || [] };
  if (old && JSON.stringify(old.actual) !== JSON.stringify(actual)) res.revisions.push({ at: nowISO, before: old.actual });
  if (preds.user && !preds.user.late) res.userChecks = verifyReasons(T, preds.user);
  writeJ(P('results', T + '.json'), res);
  (index.days[T] ||= { batches: [] }).result = true; index.days[T].user = !!preds.user;
  if (!exists(P('reviews', T + '.json'))) await review(T, preds, res);
  return true;
}
async function review(T, preds, res) {
  const who = preds.user && !preds.user.late ? 'user' : 'ai';
  const p = preds[who];
  if (!p) { log(`${T} 没有可复盘的预测`); return; }
  const snap = readJ(P('snapshots', T, 'morning.json'), null) || readJ(P('snapshots', T, 'evening.json'), null) || readJ(P('snapshots', T, 'early.json'), null);
  const trig = readJ(P('triggers', T, 'morning.json'), null) || readJ(P('triggers', T, 'evening.json'), null) || readJ(P('triggers', T, 'early.json'), null);
  // 反省一（代码部分）：引用数据的时间 vs 锁定时间
  const hindsight = [], ablation = [];
  for (const [c, f] of Object.entries(p?.funds || {})) (f.reasons || []).forEach((r, i) => {
    for (const id of r.dataRefs || []) { const it = snap?.items?.find(x => x.id === id); if (it) hindsight.push({ fund: c, reason: i, verdict: ms(it.cutoff) <= ms(p.lockedAt) ? '预测前已成立' : '事后信息', evidence: `${it.name} 可获得于 ${it.cutoff}，锁定于 ${p.lockedAt}` }); }
    // 反省二（代码部分）：关联信号的理由，去掉该信号后规则模型方向是否改变
    if ((r.signals || []).length && snap) {
      const base = modelValue(model, snap.features, c), dropV = modelValue(model, snap.features, c, r.signals);
      ablation.push({ fund: c, reason: i, verdict: tri(base) !== tri(dropV) ? '核心变量' : '对结论影响小', detail: `规则模型 ${pct(base)} → 去掉后 ${pct(dropV)}` });
    }
  });
  const newsAfter = (await news()).filter(n => p && ms(n.time) > ms(p.lockedAt) && ms(n.time) <= ms(at(T, '15:00')) && NEWS_KEYS.test(n.text)).slice(0, 20);
  const rows = funds.map(f => {
    const pf = p?.funds?.[f.code]; const sc = res.scores[who]?.[f.code];
    return `${f.short}：预测 ${pct(pf?.value)}，实际 ${pct(res.actual[f.code])}，${sc ? (sc.hit ? '方向对' : '方向错') + `，误差 ${sc.absErr}` : '未计分'}\n  理由：${(pf?.reasons || []).map((r, i) => `(${i}) ${r.text}${r.signals?.length ? ' [信号 ' + r.signals.join(',') + ']' : ''}`).join(' ')}\n  今天触发：${(trig?.funds?.[f.code] || []).map(x => x.signal + '(' + x.status + ')').join('、') || '无'}`;
  }).join('\n');
  const researchSig = signals.filter(s => s.status !== '淘汰').map(s => `${s.id} ${s.name}：when ${s.when} → ${s.vote > 0 ? '看涨' : '看跌'}，研究集 ${s.research.rate ?? '–'}%（${s.research.n}次，基准${s.research.base ?? '–'}%），${s.status}`).join('\n');
  let out = {};
  try {
    out = await gemini(`你在帮一位普通投资人复盘 ${T} 的基金涨跌预测（被复盘的是${who === 'user' ? '他本人的预测' : 'AI 草稿（他当天没有提交）'}，锁定时间 ${p?.lockedAt}）。用简体中文，具体、不说空话。
${rows}

锁定之后、收盘之前出现的快讯（这些都不能作为预测依据）：
${newsAfter.map(n => `[${n.time.slice(11, 16)}] ${n.text}`).join('\n') || '无'}

信号库（只给研究集统计）：
${researchSig}

请输出：
1. right：判断正确的地方（1-3条）；wrong：判断错误的地方（1-3条）；
2. bestSignal：贡献最大的信号或依据 {"id":"信号编号或空","why":"..."}；misleading：误导判断的 {"id":"","why":"..."}；
3. nextTime：下次怎么改（1-3条）；
4. hindsight：逐条检查没有引用数据编号的文字理由，是否用到了锁定后才知道的信息 [{"fund":"代码","reason":序号,"verdict":"预测前已成立/疑似事后信息","why":"..."}]；
5. ablation：逐条判断"删掉这条理由，结论还一样吗" [{"fund":"代码","reason":序号,"verdict":"核心变量/装饰/无法判断","why":"..."}]（已关联信号的理由不用写）；
6. newSignals：从今天的经验里提炼最多2条值得实验的新信号（野路子也可以），只能用这些变量：${VARS.join(',')}，表达式只用变量、数字、比较和逻辑运算、Math.abs。[{"name":"中文说明","when":"表达式","vote":1或-1,"scope":"*或基金代码"}]
只输出 JSON。`, `复盘 ${T}`);
  } catch (e) { log('复盘 AI 部分失败：' + e.message); }
  const arr = x => Array.isArray(x) ? x.slice(0, 5).map(String) : [];
  const rv = { date: T, subject: who, createdAt: nowISO, right: arr(out.right), wrong: arr(out.wrong), bestSignal: out.bestSignal || null, misleading: out.misleading || null, nextTime: arr(out.nextTime),
    hindsight: [...hindsight, ...(Array.isArray(out.hindsight) ? out.hindsight.slice(0, 15) : [])],
    ablation: [...ablation, ...(Array.isArray(out.ablation) ? out.ablation.slice(0, 15) : [])], userAnswers: [] };
  writeOnce(P('reviews', T + '.json'), rv);
  index.days[T].review = true;
  for (const ns of (out.newSignals || []).slice(0, 2)) {
    try {
      compile(String(ns.when));
      if (signals.some(s => s.when === ns.when)) continue;
      const id = 'S' + String(Math.max(0, ...signals.map(s => +s.id.slice(1) || 0)) + 1).padStart(3, '0');
      const scope = ns.scope === '*' || CODES.includes(ns.scope) ? ns.scope : '*';
      const sg = { id, name: String(ns.name || '').slice(0, 40), sourceType: '复盘提炼', scope, when: String(ns.when), vote: +ns.vote > 0 ? 1 : -1, status: '实验中', createdAt: today, statusHistory: [{ date: today, from: null, to: '实验中', why: `${T} 复盘提出` }] };
      sg.research = sigStats(sg, RESEARCH); sg.holdout = sigStats(sg, HOLDOUT); signals.push(sg);
      log(`新增实验信号 ${id}：${ns.name}`);
    } catch (e) { console.error('新信号无效：' + e.message); }
  }
  log(`${T} 复盘完成`);
}

// ---------- 8. 汇总统计 ----------
const PREDICTORS = ['user', 'ai', 'model', 'bench_us', 'bench_prev', 'bench_zero'];
const BENCHES = ['bench_us', 'bench_prev', 'bench_zero'];
function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
function bootDiff(diffs, iters = 2000) {
  if (diffs.length < 5) return null;
  const R = rng(42), m = [];
  for (let k = 0; k < iters; k++) { let s = 0; for (let i = 0; i < diffs.length; i++) s += diffs[Math.floor(R() * diffs.length)]; m.push(s / diffs.length); }
  m.sort((a, b) => a - b);
  return { mean: r3(sum(diffs) / diffs.length), lo: r3(m[Math.floor(iters * 0.025)]), hi: r3(m[Math.floor(iters * 0.975)]) };
}
function computeStats() {
  const files = fs.existsSync(P('results')) ? fs.readdirSync(P('results')).filter(f => f.endsWith('.json')).sort() : [];
  const results = files.map(f => readJ(P('results', f)));
  const agg = k => { let n = 0, hit = 0, e = 0; for (const r of results) for (const s of Object.values(r.scores[k] || {})) { n++; hit += s.hit; e += s.absErr; } return { n, hit, rate: n ? r2(hit / n * 100) : null, mae: n ? r3(e / n) : null }; };
  const out = { updatedAt: nowISO, days: results.length, predictors: {}, vsBench: {}, byFund: {}, reasonQuality: null, versions: {} };
  for (const k of PREDICTORS) out.predictors[k] = agg(k);
  // 配对比较：我 / AI / 模型 vs 每个基准
  for (const k of ['user', 'ai', 'model']) {
    out.vsBench[k] = {};
    for (const b of BENCHES) {
      const dErr = [], dHit = [];
      for (const r of results) for (const c of CODES) { const x = r.scores[k]?.[c], y = r.scores[b]?.[c]; if (!x || !y) continue; dErr.push(y.absErr - x.absErr); dHit.push((x.hit ? 1 : 0) - (y.hit ? 1 : 0)); }
      const be = sum(results.flatMap(r => CODES.map(c => r.scores[k]?.[c] && r.scores[b]?.[c] ? r.scores[b][c].absErr : null)).filter(v => v != null));
      out.vsBench[k][b] = { n: dErr.length, maeGain: bootDiff(dErr), hitGain: bootDiff(dHit.map(x => x * 100)), maeImprovePct: dErr.length && be ? r2(sum(dErr) / be * 100) : null };
    }
  }
  for (const c of CODES) out.byFund[c] = Object.fromEntries(PREDICTORS.map(k => { let n = 0, hit = 0, e = 0; for (const r of results) { const s = r.scores[k]?.[c]; if (s) { n++; hit += s.hit; e += s.absErr; } } return [k, { n, rate: n ? r2(hit / n * 100) : null, mae: n ? r3(e / n) : null }]; }));
  // 依据质量：带「今天未触发 / 历史不成立 / 事后信息」依据的预测，是不是更不准
  const g = { clean: { n: 0, hit: 0, e: 0 }, flagged: { n: 0, hit: 0, e: 0 } };
  for (const r of results) for (const c of CODES) {
    const s = r.scores.user?.[c]; if (!s) continue;
    const flags = (r.userChecks?.[c] || []).some(x => x.signals.some(v => v.verdict !== '有效依据') || x.data.some(v => v.verdict === '事后信息'));
    const G = g[flags ? 'flagged' : 'clean']; G.n++; G.hit += s.hit; G.e += s.absErr;
  }
  out.reasonQuality = Object.fromEntries(Object.entries(g).map(([k, G]) => [k, { n: G.n, rate: G.n ? r2(G.hit / G.n * 100) : null, mae: G.n ? r3(G.e / G.n) : null }]));
  // 各模型版本上线后的实盘成绩
  for (const r of results) { const v = r.meta.model?.batch ? (readJ(P('predictions', r.date, `model-${r.meta.model.batch}.json`), {}).modelVersion) : null; if (!v) continue; const o = (out.versions[v] ||= { n: 0, hit: 0, e: 0 }); for (const s of Object.values(r.scores.model || {})) { o.n++; o.hit += s.hit; o.e += s.absErr; } }
  for (const o of Object.values(out.versions)) { o.rate = o.n ? r2(o.hit / o.n * 100) : null; o.mae = o.n ? r3(o.e / o.n) : null; delete o.e; }
  // 打脸榜（研究集 + 留出集合并，样本 ≥ 门槛）
  const pool = signals.filter(s => s.status !== '淘汰' && s.research).map(s => { const n = s.research.n + s.holdout.n, h = s.research.hit + s.holdout.hit, [lo, hi] = wilson(h, n); return { id: s.id, name: s.name, n, rate: n ? r2(h / n * 100) : null, lo, hi, base: s.research.base, status: s.status }; }).filter(x => x.n >= CFG.minSamples);
  out.reliable = pool.filter(x => x.lo > x.base).sort((a, b) => (b.lo - b.base) - (a.lo - a.base)).slice(0, 5);   // 区间下限都高于基准
  out.deceptive = pool.filter(x => x.rate < x.base).sort((a, b) => (a.rate - a.base) - (b.rate - b.base)).slice(0, 5);   // 命中率低于基准，越低越靠前
  return out;
}

// ---------- 9. 主流程 ----------
try {
  if (MODE === 'evening') {
    // 结算：最近 5 个交易日里还没结算或 QDII 净值晚到的
    for (const T of tdays.slice(-5)) {
      const r = readJ(P('results', T + '.json'), null);
      const hasPred = exists(P('predictions', T));
      if (!hasPred) continue;
      if (!r || CODES.some(c => r.actual[c] == null && NAV[c].map[T] != null)) await settle(T);
    }
    tryUpgrade();
    const T = nextTD(today);
    if (addDays(today, 1) === T) await prepare(T, 'evening');          // 前一晚：晚间批次
    else if (addDays(today, 2) === T) await prepare(T, 'early');       // 长假/周末前两晚：提前批次（仅供参考）
    else log(`下一交易日 ${T}，前一晚再出草稿`);
  } else {
    if (!isTD(today)) log('今天休市');
    else if (ms(nowISO) > ms(deadlineOf(today))) log('已过截止时间，不再生成早间批次');
    else await prepare(today, 'morning');
  }
} catch (e) { log('运行出错：' + (e.stack || e.message).slice(0, 300)); }

writeJ(P('signals.json'), signals);
writeJ(P('models', 'changelog.json'), changelog);
writeJ(P('funds.json'), funds);
writeJ(P('index.json'), index);
writeJ(P('stats.json'), computeStats());
writeJ(P('status.json'), { lastRun: nowISO, mode: MODE, report, split: { researchFrom: histDays[0], holdoutFrom: splitDay, to: histDays.at(-1) } });
console.log('完成');
