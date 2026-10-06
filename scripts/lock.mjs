// 基金日记 v2.1 · 锁定公证：由 GitHub Issue 事件触发
// - 新建 Issue「预测 YYYY-MM-DD」：校验作者 → serverLockedAt = issue.created_at（服务器时间）→ 写预测和锁定记录（只新建）→ 回复并关闭
// - 在该 Issue 下评论：记为修正意见（服务器时间，不参与计分）
import fs from 'node:fs';
import zlib from 'node:zlib';
import { P, exists, readJ, writeJ, writeOnce, CFG, toBJ, ms, deadlineOf, r2, sha256, checkReasons, batchAsOf } from './lib.mjs';

const ev = readJ(process.env.GITHUB_EVENT_PATH);
const EVENT = process.env.GITHUB_EVENT_NAME;
const REPO = process.env.GITHUB_REPOSITORY;
const TOKEN = process.env.GITHUB_TOKEN;
const OWNER = CFG.owner;
const issue = ev.issue;
// 正文：app 生成的 ```fd1 块（deflate-raw + base64url），或 ```json 块
function parseBody(body) {
  const z = /```fd1\s*([A-Za-z0-9_\-+\/=\s]+?)```/.exec(body || '');
  if (z) return JSON.parse(zlib.inflateRawSync(Buffer.from(z[1].replace(/\s+/g, '').replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toString('utf8'));
  const raw = (/```(?:json)?\s*([\s\S]*?)```/.exec(body || '') || [null, body || ''])[1];
  return JSON.parse(raw);
}
let parsed = null, parseErr = null;
try { parsed = parseBody(issue?.body); } catch (e) { parseErr = e; }
// 日期：标题「预测 YYYY-MM-DD」优先；GitHub App 里标题没带上时，用正文里的日期
const m = /^预测\s+(\d{4}-\d{2}-\d{2})\s*$/.exec(issue?.title || '') || (/^\d{4}-\d{2}-\d{2}$/.test(parsed?.date || '') ? [null, parsed.date] : null);

async function gh(method, url, body) {
  const r = await fetch(`https://api.github.com/repos/${REPO}${url}`, { method, headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/vnd.github+json', 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  if (!r.ok) console.error(method, url, r.status, (await r.text()).slice(0, 200));
}
const reply = text => gh('POST', `/issues/${issue.number}/comments`, { body: text });
const close = () => gh('PATCH', `/issues/${issue.number}`, { state: 'closed', state_reason: 'completed' });

if (!m) { console.log('不是预测 Issue，忽略'); process.exit(0); }
const T = m[1];

if (EVENT === 'issues') {
  if (issue.user.login !== OWNER) { await reply('只接受仓库主人提交的预测，本条不记录。'); await close(); process.exit(0); }
  const serverLockedAt = toBJ(ms(issue.created_at));
  if (exists(P('predictions', T, 'user.json'))) { await reply(`${T} 已经有一份锁定的预测，不能覆盖。需要补充请在原 Issue 下评论（记为修正意见）。`); await close(); process.exit(0); }
  const sub = parsed;
  if (!sub || parseErr) { await reply('没能读出预测内容（格式错误），本条不记录。请回到 app 重新提交。'); await close(); process.exit(0); }
  if (sub.date && sub.date !== T) { await reply(`标题日期 ${T} 和正文日期 ${sub.date} 不一致，本条不记录。`); await close(); process.exit(0); }
  const funds = readJ(P('funds.json'));
  const holdings = readJ(P('state', 'holdings.json'), {});
  const clean = x => {
    const v = Number(x?.value);
    return Number.isFinite(v) ? { value: r2(Math.max(-10, Math.min(10, v))), reasons: (Array.isArray(x.reasons) ? x.reasons : []).slice(0, 8).map(r => ({ text: String(r.text || '').slice(0, 200), signals: (r.signals || []).map(String).slice(0, 10), dataRefs: (r.dataRefs || []).map(String).slice(0, 10) })).filter(r => r.text), conclusion: String(x.conclusion || '').slice(0, 120) } : null;
  };
  const fx = {}; const initial = {};
  for (const f of funds) { const c = clean(sub.funds?.[f.code]); if (c) fx[f.code] = c; const iv = Number(sub.initial?.[f.code]); if (Number.isFinite(iv)) initial[f.code] = r2(iv); }
  if (Object.keys(fx).length !== funds.length) { await reply('5 只基金的预测值没填全，本条不记录。请回到 app 重新提交。'); await close(); process.exit(0); }
  // 科技仓 = 持仓加权平均（用锁定时的持仓）
  let w = 0, s = 0; const weights = {};
  for (const f of funds) { const a = Math.max(0, (holdings[f.code] || f.holding).amount || 0); weights[f.code] = a; w += a; s += a * fx[f.code].value; }
  const overall = { value: r2(w ? s / w : funds.reduce((t, f) => t + fx[f.code].value, 0) / funds.length), method: w ? '持仓加权' : '简单平均', weights };
  // 锁定时可见的批次：以 app 记录的为准，但不能晚于服务器锁定时间
  const seen = batchAsOf(T, serverLockedAt);
  const snapshotId = seen ? `${T}/${seen.batch}` : null;
  const trig = seen ? readJ(P('triggers', T, `${seen.batch}.json`), null) : null;
  const defs = fs.existsSync(P('signals', 'public.json')) ? readJ(P('signals', 'public.json')) : [];
  const pred = {
    date: T, predictor: 'user', clientSubmittedAt: String(sub.clientSubmittedAt || ''), serverLockedAt, issueNumber: issue.number,
    snapshotId, clientSnapshotId: sub.snapshotId || null, aiSeen: sub.aiSeen || null, initial, funds: fx, overall,
  };
  const { checks, evidence } = checkReasons(pred, seen?.snap, trig, defs, serverLockedAt);
  pred.checks = checks; pred.evidence = evidence;
  const predictionHash = sha256(pred);
  const onTime = ms(serverLockedAt) <= ms(deadlineOf(T));
  writeOnce(P('predictions', T, 'user.json'), pred);
  writeOnce(P('locks', T, 'user.json'), { date: T, predictor: 'user', clientSubmittedAt: pred.clientSubmittedAt, serverLockedAt, serverTimeSource: 'issue.created_at', issueNumber: issue.number, issueNodeId: issue.node_id, author: issue.user.login, predictionHash, snapshotId, deadline: deadlineOf(T), onTime });
  const index = readJ(P('index.json'), { days: {} });
  (index.days[T] ||= { batches: [] }).user = true;
  writeJ(P('index.json'), index);
  const e = evidence;
  await reply([
    onTime ? `🔒 已锁定 ${T} 的预测` : `⚠️ 已记录，但超过 ${CFG.deadline} 截止时间，记为迟交，不计入正式成绩`,
    `- 服务器锁定时间：${serverLockedAt}`,
    `- 预测哈希：\`${predictionHash}\``,
    `- 依据快照：${snapshotId || '无'}`,
    `- 科技仓（${overall.method}）：${overall.value > 0 ? '+' : ''}${overall.value}%`,
    `- 依据：数据 ${e.dataRefs}，有效信号 ${e.validSignals}，今天未触发 ${e.notTriggered}，历史无效 ${e.historicallyInvalid}，事后信息 ${e.afterLock}，纯主观理由 ${e.subjectiveOnly}`,
    '', '之后如需补充，直接在本 Issue 下评论，会记为修正意见（不参与计分）。'].join('\n'));
  await close();
  console.log('锁定完成', T, serverLockedAt, predictionHash);
} else if (EVENT === 'issue_comment') {
  const c = ev.comment;
  if (c.user.login !== OWNER || c.body.includes('🔒 已锁定') || c.performed_via_github_app) process.exit(0);
  if (!exists(P('predictions', T, 'user.json'))) process.exit(0);
  const fund = (/基金[:：]\s*(\d{6})/.exec(c.body) || [])[1] || null;
  writeOnce(P('amendments', T, `${c.id}.json`), { date: T, seq: c.id, createdAt: toBJ(ms(c.created_at)), serverTimeSource: 'comment.created_at', fund, text: c.body.slice(0, 2000), affectsScore: false });
  const index = readJ(P('index.json'), { days: {} });
  const d = (index.days[T] ||= { batches: [] }); d.amendments = (d.amendments || 0) + 1;
  writeJ(P('index.json'), index);
  console.log('修正意见已记录', T, c.id);
}
