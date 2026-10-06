// 基金日记 v2.1 · 公共工具（run.mjs 与 lock.mjs 共用）
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const ROOT = new URL('..', import.meta.url).pathname;
export const DATA = path.join(ROOT, 'data');
export const P = (...a) => path.join(DATA, ...a);
export const exists = f => fs.existsSync(f);
export const readJ = (f, def) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { if (def !== undefined) return def; throw e; } };
export const writeJ = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(o, null, 1) + '\n'); fs.renameSync(tmp, f); };
export const writeOnce = (f, o) => { if (exists(f)) return false; writeJ(f, o); return true; };   // 快照、预测、锁定记录：只新建
export const appendLine = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.appendFileSync(f, JSON.stringify(o) + '\n'); };

export const CFG = readJ(P('config.json'));

// ---------- 时间（北京时间，字符串一律带 +08:00） ----------
export const toBJ = ms => new Date(ms + 8 * 3600e3).toISOString().slice(0, 19) + '+08:00';
export const ms = iso => Date.parse(iso);
export const at = (d, hm) => `${d}T${hm}:00+08:00`;
export const addDays = (d, n) => { const t = new Date(d + 'T00:00:00Z'); t.setUTCDate(t.getUTCDate() + n); return t.toISOString().slice(0, 10); };
export const dayNum = d => Date.parse(d + 'T00:00:00Z') / 864e5;
export const weekday = d => new Date(d + 'T00:00:00Z').getUTCDay();
export const deadlineOf = T => at(T, CFG.deadline);

// 交易日：有实际行情的日期以行情为准，之后的日期用日历推算
export function makeCalendar(dataDates) {
  const cal = readJ(P('calendar.json'));
  const set = new Set(dataDates), last = dataDates.at(-1) || '0000';
  const isTD = d => d <= last ? set.has(d) : (weekday(d) > 0 && weekday(d) < 6 && !cal.holidays.includes(d));
  const nextTD = d => { let x = addDays(d, 1); for (let i = 0; i < 40 && !isTD(x); i++) x = addDays(x, 1); return x; };
  const prevTD = d => { let x = addDays(d, -1); for (let i = 0; i < 40 && !isTD(x); i++) x = addDays(x, -1); return x; };
  return { isTD, nextTD, prevTD, holidays: cal.holidays };
}

// ---------- 评分 ----------
export const tri = v => v == null ? null : v > CFG.flatBand ? '涨' : v < -CFG.flatBand ? '跌' : '平';
export const r2 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 100) / 100;
export const r3 = v => v == null || !Number.isFinite(v) ? null : Math.round(v * 1000) / 1000;

// ---------- 哈希（规范化 JSON：键排序） ----------
function canon(x) {
  if (Array.isArray(x)) return '[' + x.map(canon).join(',') + ']';
  if (x && typeof x === 'object') return '{' + Object.keys(x).sort().map(k => JSON.stringify(k) + ':' + canon(x[k])).join(',') + '}';
  return JSON.stringify(x);
}
export const sha256 = o => 'sha256:' + crypto.createHash('sha256').update(canon(o)).digest('hex');

// ---------- 依据核验（以锁定时可见的批次为准） ----------
export function checkReasons(pred, snap, trig, defs, lockIso) {
  const out = {}; const ev = { dataRefs: 0, validSignals: 0, notTriggered: 0, historicallyInvalid: 0, afterLock: 0, notInSnapshot: 0, subjectiveOnly: 0, reasons: 0 };
  for (const [c, f] of Object.entries(pred.funds || {})) out[c] = (f.reasons || []).map(r => {
    ev.reasons++;
    const signals = (r.signals || []).map(id => {
      const t = trig?.funds?.[c]?.find(x => x.signal === id);
      const v = !t ? '今天未触发' : t.status !== '有效' ? '历史不成立' : '有效依据';
      ev[v === '有效依据' ? 'validSignals' : v === '今天未触发' ? 'notTriggered' : 'historicallyInvalid']++;
      return { id, verdict: v };
    });
    const data = (r.dataRefs || []).map(id => {
      const it = snap?.items?.find(i => i.id === id);
      const v = !it ? '数据不在快照中' : ms(it.cutoff) <= ms(lockIso) ? '预测前已成立' : '事后信息';
      if (v === '预测前已成立') ev.dataRefs++; else if (v === '事后信息') ev.afterLock++; else ev.notInSnapshot++;
      return { id, verdict: v };
    });
    if (!signals.length && !data.length) ev.subjectiveOnly++;
    return { signals, data };
  });
  return { checks: out, evidence: ev };
}

export function batchFiles(T) {
  // 当天所有批次，按生成时间排序
  const dir = P('snapshots', T);
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter(f => f.endsWith('.json')).map(f => ({ batch: f.replace('.json', ''), snap: readJ(path.join(dir, f)) })).sort((a, b) => ms(a.snap.asOf) - ms(b.snap.asOf));
}
// 锁定时可见的最新批次（asOf <= 截止点）
export function batchAsOf(T, limitIso) {
  const bs = batchFiles(T).filter(b => ms(b.snap.asOf) <= ms(limitIso));
  return bs.at(-1) || null;
}
