// 保全部隊へ要約・心拍を送る GAS 側と、部隊の報告の配達（2026-11-27・I-SQ5・I-SQ6・I-SQ9・I-H10）
//   ★本物の gas/LineBooking.js（点検・修理・状態の読み取り）と gas/PushToEdge.js（送る・心拍・配達・pushToEdgeLight）を vm で動かす
//   ★GAS が送った本文をそのまま本物の Worker（index.js・本物の SQLite）に通し、部隊が fresh で読めるところまで入口から通す
//   実行: node worker/test/gas-squad.test.js
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { makeWorld, makeCtx, run, tally, ROOT, FAKE, status as statusOf, incOf, removeTrigger } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn } from './_gas-lock-src.js';
import worker from '../src/index.js';
import { makeEnv } from './karte-sqlite-env.mjs';
import { createHash } from 'node:crypto';
import * as S from '../src/lib/squad-schema.js';

const t = tally();
const ok = t.ok;
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
const H = 3600000, MIN = 60000;

//   PushToEdge.js の部隊の塊（本物のソースの区切りで切る）
function squadBlock() {
  const a = PE.indexOf('// ---------- 保全部隊へ要約と心拍を送る');
  const b = PE.indexOf('// D1の枠と引当から出した残数が、計算と一致するかを突き合わせる');
  if (a < 0 || b < a) throw new Error('部隊の塊が見つからない');
  return PE.slice(a, b);
}
//   UrlFetchApp・CacheService の身代わりを足した文脈で1回動かす
function runSq(w, fn, ...args) {
  const ctx = makeCtx(w);
  ctx.UrlFetchApp = { fetch: (url, opt) => {
    const rec = { url, payload: JSON.parse(opt.payload), headers: opt.headers, props: Object.assign({}, w.props) };
    w.fetches = (w.fetches || []).concat([rec]);
    if (w.fetchThrows) throw new Error('net');
    const r = (w.respond || (() => ({ code: 200, body: '{"ok":true}' })))(rec);
    return { getResponseCode: () => r.code, getContentText: () => r.body };
  } };
  w.cache = w.cache || {};
  ctx.CacheService = { getScriptCache: () => ({
    get: (k) => { const e = w.cache[k]; return e && e.exp > w.now ? e.v : null; },
    put: (k, v, ttl) => { w.cache[k] = { v: String(v), exp: w.now + ttl * 1000 }; },
    remove: (k) => { delete w.cache[k]; },
  }) };
  ctx.pushToEdgeAll = () => { if (w.pushDelay) w.now += w.pushDelay; };
  ctx._edgeHealJobTrigger = () => {}; ctx.lbDwPullBehind = () => {}; ctx.lbDualWriteDrain = () => {};
  ctx._edgeProp = (k) => (k in w.props ? w.props[k] : null);
  vm.runInContext(squadBlock() + '\n' + pluckFn(PE, 'pushToEdgeLight') + '\n' + pluckFn(PE, '_edgeQuotaStatus'), ctx);
  //   _edgeQuotaStatus は harness の身代わりを使う（上の本物は UrlFetchApp を叩くので戻す）
  ctx._edgeQuotaStatus = (q) => (q === '?squad=1' ? (w.data.squad || { ok: true, squad: { read_on: false, last_read_at: null, quiet: false } })
    : { syncVersion: { table: 'ok', stale: 0 }, remainRead: null, preflight: { mode: 'off' } });
  w.depth = (w.depth || 0) + 1;
  try { return ctx[fn](...args); } finally { w.depth--; }
}
const posts = (w, path) => (w.fetches || []).filter((f) => f.url.endsWith(path));

// ---------- 1. 要約は完走の印の後に送る・中身は許可リストの形 ----------
{
  const w = makeWorld({ data: { paceMeta: { brokenCount: 2, brokenNames: [FAKE.name, FAKE.name2], brokenIds: ['C20260101000001', 'C20260101000002'], noContractCount: 0, noContractNames: [], pendingPayMembers: 0, pendingPaySessions: 0 } } });
  removeTrigger(w, 'dailySync');
  runSq(w, 'dailyHealthCheck');
  const d = posts(w, '/squad/digest');
  ok('G1-1 日次点検の最後に要約を1回送る', d.length === 1 && d[0].payload.kind === 'digest', JSON.stringify((w.fetches || []).map((f) => f.url)));
  const p = d[0] && d[0].payload;
  ok('G1-2 ★送った時点で LB_HEALTH_DONE が書かれていて、要約の check_id・health_done と一致（完走の印の後）',
     p && d[0].props.LB_HEALTH_DONE && Number(d[0].props.LB_HEALTH_DONE) === p.check_id && p.health_done === p.check_id && p.completed === true);
  ok('G1-3 認証は既存の合言葉（X-Ingest-Secret）だけ', d[0] && d[0].headers['X-Ingest-Secret'] === w.props.EDGE_SECRET && Object.keys(d[0].headers).join() === 'X-Ingest-Secret');
  const txt = JSON.stringify(p);
  const leak = [FAKE.name, FAKE.name2, 'C20260101000001', 'C20260101000002', FAKE.phone, FAKE.lineId].filter((x) => txt.indexOf(x) >= 0);
  ok('G1-4 ★氏名・会員番号を送らない（member_broken は件数 n_ids だけ）', leak.length === 0 && p.items.some((x) => x.k === 'member_broken' && x.n_ids === 2) && !p.items.some((x) => 'i' in x), leak.join(','));
  const strict = S.sqRebuildDigest(p, { strict: true });
  ok('G1-5 ★GAS の要約は Worker の許可リスト（strict）をそのまま通る（未知の欄・未知の列挙が無い）', strict.ok && strict.unknown === 0, JSON.stringify(strict.why || ''));
  ok('G1-6 台帳の時刻は時間単位に切り下げて送る', p.incidents.length > 0 && p.incidents.every((x) => x.opened_at % H === 0));
  ok('G1-7 トリガーを1本も作らない（I-SQ6）', w.created.length === 0);
}
{
  //   修理の最後（lbSelfHeal）も要約を送る・完走の印の後
  const w = makeWorld();
  runSq(w, 'dailyHealthCheck');
  w.now += 3 * H; w.fetches = [];
  runSq(w, 'lbSelfHeal', w.now);
  const d = posts(w, '/squad/digest');
  ok('G1-8 lbSelfHeal の最後に要約を送り、送った時点で LB_SELFHEAL_DONE ≥ LAST', d.length === 1 && Number(d[0].props.LB_SELFHEAL_DONE) >= Number(d[0].props.LB_SELFHEAL_LAST) && d[0].payload.heal_done === Number(d[0].props.LB_SELFHEAL_DONE));
  w.fetches = [];
  runSq(w, 'lbSelfHeal', w.now - 6 * MIN);
  ok('G1-9 lbNudgeDaily の開始から5分30秒を過ぎていたら送らず skipped_time を数える', posts(w, '/squad/digest').length === 0 && JSON.parse(w.cache.lb_squad_fail.v).skipped_time === 1);
}
{
  //   日次点検が長かった回は送らない → 次の要約に数が載る
  const w = makeWorld();
  w.hooks.refreshPaceBoard = () => { w.now += 6 * MIN; };
  runSq(w, 'dailyHealthCheck');
  ok('G1-10 日次点検の残りが30秒未満なら送らない', posts(w, '/squad/digest').length === 0);
  delete w.hooks.refreshPaceBoard; w.now += 3 * H;
  runSq(w, 'lbSelfHeal', w.now);   // 同じ朝の修理の後の要約（★数えは CacheService＝6時間で消える。設計どおりの損失）
  const d = posts(w, '/squad/digest');
  ok('G1-11 見送った数は次の要約（6時間以内）の send_fail に載り、届いたら消す', d.length === 1 && d[0].payload.send_fail.skipped_time === 1 && !w.cache.lb_squad_fail);
  w.respond = () => ({ code: 503, body: '' }); w.now += 24 * H;
  runSq(w, 'dailyHealthCheck');
  ok('G1-12 失敗（5xx）を数える', JSON.parse(w.cache.lb_squad_fail.v).http_5xx === 1);
  w.fetchThrows = true; w.now += 24 * H;
  let threw = false; try { runSq(w, 'dailyHealthCheck'); } catch (_) { threw = true; }
  ok('G1-13 通信の例外は点検を落とさず exception を数える', !threw && JSON.parse(w.cache.lb_squad_fail.v).exception === 1);
}

// ---------- 2. 心拍（pushToEdgeLight の最後・1時間に1回まで）----------
{
  const w = makeWorld();
  runSq(w, 'pushToEdgeLight');
  ok('G2-1 ★pushToEdgeLight の最後に心拍を送る（配線）', posts(w, '/squad/digest').length === 1 && posts(w, '/squad/digest')[0].payload.kind === 'beat');
  const b = posts(w, '/squad/digest')[0].payload;
  ok('G2-2 心拍は版・snap_at・4つの時刻だけ', Object.keys(b).sort().join() === 'gas_build,heal_done,heal_last,health_done,health_last,kind,schema,snap_at' && S.sqRebuildBeat(b, { strict: true }).ok);
  w.now += 15 * MIN; runSq(w, 'pushToEdgeLight');
  w.now += 15 * MIN; runSq(w, 'pushToEdgeLight');
  ok('G2-3 55分以内は送らない（間引き）', posts(w, '/squad/digest').length === 1);
  w.now += 30 * MIN; runSq(w, 'pushToEdgeLight');
  ok('G2-4 55分を過ぎたら送る', posts(w, '/squad/digest').length === 2);
  w.now += 60 * MIN; w.pushDelay = 4 * MIN; runSq(w, 'pushToEdgeLight');
  ok('G2-5 写しの送り出しが3分を超えた回は見送り skipped_late を数える', posts(w, '/squad/digest').length === 2 && JSON.parse(w.cache.lb_squad_fail.v).skipped_late === 1);
  const w2 = makeWorld({ props: { EDGE_URL: '' } });
  runSq(w2, 'pushToEdgeLight');
  ok('G2-6 EDGE_URL が無ければ送らない（数えない）', !(w2.fetches || []).length && !(w2.cache || {}).lb_squad_fail);
  ok('G2-7 トリガーを作らない', w.created.length === 0);
}

// ---------- 3. 部隊の報告をオーナーへ（④）----------
{
  const rep = { schema: 1, run_id: Date.UTC(2026, 10, 23, 0, 0), verdict: 'owner_needed', urgency: 'now', items: [{ k: 'squad_gas_quiet', j: 'new', c: 1 }, { k: 'member_broken', j: 'not_fixed', c: 2 }], ask: 'check_system' };
  const w = makeWorld();
  w.respond = (r) => (r.url.endsWith('/squad/digest') ? { code: 200, body: JSON.stringify({ ok: true, kind: 'beat', report: rep }) } : { code: 200, body: '{"ok":true}' });
  runSq(w, 'pushToEdgeLight');
  ok('G3-1 心拍の応答に報告があればオーナー（owner かつ active）へ LINE を1通', w.pushes.length === 1 && w.pushes[0].to === FAKE.lineId && w.pushes[0].opts.purpose === 'owner_squad' && w.pushes[0].opts.noInlineRetry === true);
  const txt = w.pushes[0] ? w.pushes[0].text : '';
  ok('G3-2 文は固定の文と列挙・件数だけ', /^【至急】【保全部隊】/.test(txt) && txt.includes('squad_gas_quiet') && txt.includes('直っていない（2件）') && txt.includes('CEO に「保全部隊の報告を見て」'), txt);
  const ack = posts(w, '/squad/report/ack');
  ok('G3-3 届けた結果を ack（line_ok）', ack.length === 1 && ack[0].payload.id === rep.run_id && ack[0].payload.code === 'line_ok');
  const w2 = makeWorld(); w2.pushOk = false;
  w2.respond = w.respond;
  runSq(w2, 'pushToEdgeLight');
  ok('G3-4 LINE が届かなければメール・ack は mail_ok', w2.mails.length === 1 && posts(w2, '/squad/report/ack')[0].payload.code === 'mail_ok');
  //   ★渡し直された同じ報告は送らず ack だけ（関門② 中1）
  runSq(w, 'pushToEdgeLight', undefined); w.now += 61 * MIN; w.cache.lb_squad_beat = undefined;
  runSq(w, 'pushToEdgeLight');
  const acks = posts(w, '/squad/report/ack');
  ok('G3-6 ★同じ番号の報告が渡し直されても LINE は1通・ack は覚えた結果で送り直す', w.pushes.length === 1 && acks.length === 2 && acks[1].payload.code === 'line_ok', `pushes=${w.pushes.length} acks=${acks.length}`);
  //   ★送っている最中に落ちた（'sending' のまま）報告が渡し直されたら、LINE ではなくメールで送る（取りこぼさない・I-H15 と同じ型）
  const w5 = makeWorld();
  w5.respond = w.respond;
  w5.cache = { ['lb_squad_sent_' + rep.run_id]: { v: 'sending', exp: w5.now + 3600000 } };
  runSq(w5, 'pushToEdgeLight');
  ok('G3-6b ★送信中に落ちた報告の渡し直しはメールで送り、LINE は送らない', w5.pushes.length === 0 && w5.mails.length === 1 && posts(w5, '/squad/report/ack')[0].payload.code === 'mail_ok');
  //   CacheService が使えないときは二重に倒れる（取りこぼさない）
  const w6 = makeWorld();
  w6.respond = w.respond;
  runSq(w6, 'pushToEdgeLight'); w6.cache = {}; w6.now += 61 * MIN; runSq(w6, 'pushToEdgeLight');
  ok('G3-6c 覚えていなければもう一度送る（取りこぼしより二重に倒す）', w6.pushes.length === 2);
  const w4 = makeWorld();
  w4.respond = (r) => (r.url.endsWith('/squad/digest') ? { code: 200, body: JSON.stringify({ ok: true, report: rep }) } : { code: 500, body: '' });
  runSq(w4, 'pushToEdgeLight');
  ok('G3-7 ack が失敗したら数える（黙らない）', JSON.parse(w4.cache.lb_squad_fail.v).http_5xx === 1);
  for (const [label, bad] of [['自由文の欄', Object.assign({}, rep, { verdict: '至急です' })], ['日本語の key', Object.assign({}, rep, { items: [{ k: 'テスト 太郎', j: 'new', c: 1 }] })],
    ['未知の ask', Object.assign({}, rep, { ask: 'pay' })], ['番号が壊れている', Object.assign({}, rep, { run_id: 'x' })]]) {
    const w3 = makeWorld();
    w3.respond = (r) => (r.url.endsWith('/squad/digest') ? { code: 200, body: JSON.stringify({ ok: true, report: bad }) } : { code: 200, body: '{}' });
    runSq(w3, 'pushToEdgeLight');
    ok(`G3-5 ★形の違う報告（${label}）は送らない・ack もしない`, w3.pushes.length === 0 && w3.mails.length === 0 && posts(w3, '/squad/report/ack').length === 0);
  }
}

// ---------- 4. squad_quiet（C）・squad_check_fail（AB）----------
{
  const w = makeWorld({ data: { squad: { ok: true, squad: { read_on: true, last_read_at: Date.UTC(2026, 10, 21), quiet: true } } } });
  runSq(w, 'dailyHealthCheck');
  const it = (statusOf(w).items || []).find((x) => x.k === 'squad_quiet');
  ok('G4-1 部隊が26時間読んでいなければ squad_quiet（C）・台帳は owner', it && it.cls === 'C' && incOf(w, 'squad_quiet')[0] && incOf(w, 'squad_quiet')[0].status === 'owner');
  ok('G4-2 段「保全部隊の見張り」は checked に付く', statusOf(w).checked.includes('保全部隊の見張り'));
  const w2 = makeWorld({ data: { squad: { ok: true, squad: { read_on: false, last_read_at: null, quiet: false } } } });
  runSq(w2, 'dailyHealthCheck');
  ok('G4-3 read_on=false（鍵の欄が空・off）は数えない', !(statusOf(w2).items || []).some((x) => /^squad_/.test(x.k)));
  const w2b = makeWorld({ data: { squad: { ok: true, squad: { read_on: false, last_read_at: null, quiet: true } } } });
  runSq(w2b, 'dailyHealthCheck');
  ok('G4-3b read_on=false なら quiet が真でも数えない（閉じている口の沈黙は異常ではない）', !(statusOf(w2b).items || []).some((x) => x.k === 'squad_quiet'));
  const w3 = makeWorld({ data: { squad: { ok: true } } });
  runSq(w3, 'dailyHealthCheck');
  const f = (statusOf(w3).items || []).find((x) => x.k === 'squad_check_fail');
  ok('G4-4 ★応答の形が違えば squad_check_fail（facts は exception）・段は checked に付けない', f && f.cls === 'AB' && f.f.join() === 'exception' && !statusOf(w3).checked.includes('保全部隊の見張り'));
}

// ---------- 5. GAS → Worker → 部隊（入口から通す）----------
{
  const w = makeWorld();
  removeTrigger(w, 'dailySync');
  runSq(w, 'dailyHealthCheck');
  w.now += 30 * MIN;
  runSq(w, 'pushToEdgeLight');
  const env = makeEnv();
  env.SHARED_SECRET = 'S';
  const KEY = 'ab'.repeat(24);
  env.SQUAD_READ_KEY_SHA256 = createHash('sha256').update(KEY).digest('hex');
  const realNow = Date.now;
  let codes = [];
  for (const f of posts(w, '/squad/digest')) {
    Date.now = () => f.payload.snap_at + 1000;
    const res = await worker.fetch(new Request('https://w.example/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'S', 'Content-Type': 'application/json' }, body: JSON.stringify(f.payload) }), env, {});
    codes.push(res.status);
  }
  Date.now = () => w.now + 2000;
  const res = await worker.fetch(new Request('https://w.example/squad/status', { headers: { 'X-Squad-Read-Key': KEY } }), env, {});
  const j = await res.json();
  Date.now = realNow;
  ok('G5-1 ★GAS が送った要約と心拍を Worker が受け、部隊は fresh で読める', codes.join() === '200,200' && j.state === 'fresh' && j.digest.items.some((x) => x.k === 'trigger_missing'), `${codes} ${j.state}/${j.stale_reason}`);
  ok('G5-2 Worker の返りは台本の再構築器（strict）を通る', S.sqRebuildStatus(j).ok);
}

// ---------- 6. I-SQ5 GAS と Worker の列挙が揃う ----------
{
  const c = makeCtx(makeWorld());
  const T = c.LB_TRIAGE;
  const gasKeys = Object.keys(T).sort();
  ok('I-SQ5-1 ★key の一覧（LB_TRIAGE と SQ_KEYS）が一致', JSON.stringify(gasKeys) === JSON.stringify(S.SQ_KEYS.slice().sort()),
     `GAS だけ: ${gasKeys.filter((k) => !S.SQ_KEYS.includes(k))} ／ Worker だけ: ${S.SQ_KEYS.filter((k) => !T[k])}`);
  const st = []; for (const k of gasKeys) if (!st.includes(T[k][1])) st.push(T[k][1]);
  ok('I-SQ5-2 段の一覧が一致', JSON.stringify(st.sort()) === JSON.stringify(S.SQ_STAGES.slice().sort()));
  ok('I-SQ5-3 last_action の一覧が一致', JSON.stringify(c.LB_ACTION_ENUM.slice().sort()) === JSON.stringify(S.SQ_ACTIONS.slice().sort()));
  ok('I-SQ5-4 facts の一覧（key ごと・exception・ids_unavailable）が一致', JSON.stringify(c.LB_FACT_ENUM) === JSON.stringify(S.SQ_FACT_ENUM)
     && JSON.stringify(c.LB_FACT_EXCEPTION_KEYS.slice().sort()) === JSON.stringify(S.SQ_FACT_EXCEPTION_KEYS.slice().sort())
     && JSON.stringify(c.LB_FACT_NAME_KEYS.slice().sort()) === JSON.stringify(S.SQ_FACT_NAME_KEYS.slice().sort()));
  ok('I-SQ5-5 台帳の status・保存の理由・見送りの列挙が一致', JSON.stringify(c.LB_STATUS_ENUM) === JSON.stringify(S.SQ_ENUM.status)
     && JSON.stringify(c.LB_SAVE_WHY.concat(['other'])) === JSON.stringify(S.SQ_ENUM.save_why)
     && JSON.stringify(c.LB_SKIP_WHY) === JSON.stringify(S.SQ_ENUM.skip_why) && JSON.stringify(c.LB_SKIP_ENTRY) === JSON.stringify(S.SQ_ENUM.skip_entry));
  const cs = makeCtx(makeWorld());
  vm.runInContext(squadBlock(), cs);
  ok('I-SQ5-6 送信の失敗の数え（LB_SQUAD.FAIL_KEYS と SQ_SEND_FAIL）が一致', JSON.stringify(cs.LB_SQUAD.FAIL_KEYS) === JSON.stringify(S.SQ_SEND_FAIL));
  ok('I-SQ5-7 報告の文の列挙（verdict・judge・ask）が Worker の列挙と一致', JSON.stringify(Object.keys(cs.LB_SQUAD_MSG.verdict).sort()) === JSON.stringify(S.SQ_ENUM.verdict.slice().sort())
     && JSON.stringify(Object.keys(cs.LB_SQUAD_MSG.judge).sort()) === JSON.stringify(S.SQ_ENUM.judge.slice().sort())
     && JSON.stringify(Object.keys(cs.LB_SQUAD_MSG.ask).sort()) === JSON.stringify(S.SQ_ENUM.ask.slice().sort())
     && JSON.stringify(Object.keys(cs.LB_SQUAD_MSG.key).sort()) === JSON.stringify(S.SQ_SQUAD_KEYS.slice().sort()));
}

// ---------- 7. I-SQ6 トリガーを増やさない（送る入口は既存の3つに相乗り）----------
{
  const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
  const all = LB + PE;
  const callers = [];
  for (const fn of ['dailyHealthCheck', 'lbSelfHeal', 'pushToEdgeLight']) {
    const src = pluckFn(fn === 'pushToEdgeLight' ? PE : LB, fn);
    if (/lbSquad(Send|Beat)\(/.test(src.replace(/\/\/[^\n]*/g, ''))) callers.push(fn);
  }
  const calls = (all.replace(/\/\/[^\n]*/g, '').match(/lbSquad(Send|Beat)\(/g) || []).length;
  ok('I-SQ6-1 ★送るのは dailyHealthCheck・lbSelfHeal・pushToEdgeLight の中だけ（呼び出しは定義の中を含めて数える）', callers.join() === 'dailyHealthCheck,lbSelfHeal,pushToEdgeLight', callers.join());
  ok('I-SQ6-2 部隊のために newTrigger を書かない', !/newTrigger\([^)]*[Ss]quad/.test(all));
  ok('I-SQ6-3 Script Property を新しく書かない（間引きと数えは CacheService）', !/setProperty\([^)]*(SQUAD|squad)/.test(all.replace(/\/\/[^\n]*/g, '')), String(calls));
}

t.end('保全部隊（GAS 側・配達・列挙の一致）');
