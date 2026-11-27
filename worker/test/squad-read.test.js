// 保全部隊が要約を読む口（/squad/*）を入口（index.js）から本物の SQLite で通す（2026-11-27・I-SQ1〜I-SQ4・I-SQ7・I-SQ9）
//   実行: node worker/test/squad-read.test.js
//   ★値はすべて架空。鍵は検査のための固定値（本番の鍵ではない）
import worker from '../src/index.js';
import { makeEnv } from './karte-sqlite-env.mjs';
import { SQ } from '../src/routes/squad.js';
import { sqRebuildStatus, SQ_KEYS, SQ_STAGES, SQ_ACTIONS } from '../src/lib/squad-schema.js';
import { createHash } from 'node:crypto';

let pass = 0, fail = 0;
const ok = (name, cond, why) => { if (cond) pass++; else { fail++; console.log(`❌ ${name}${why ? '\n   ' + why : ''}`); } };

const realNow = Date.now;
let NOW = Date.UTC(2026, 10, 27, 0, 30);   // 2026-11-27 09:30 JST
Date.now = () => NOW;
const H = 3600000, MIN = 60000;

const KEY = 'ab'.repeat(24);               // 48 桁の16進（検査用）
const KEY2 = 'cd'.repeat(24);
const sha = (s) => createHash('sha256').update(s).digest('hex');
const FAKE = ['テスト 太郎', '090-0000-0000', 'nobody@example.invalid', 'U0000000000000000000000000000000a', 'C20260101000000', '架空のひとこと本文'];

function freshEnv(o = {}) {
  const env = makeEnv();
  env.SHARED_SECRET = 'S';
  env.SQUAD_READ_KEY_SHA256 = sha(KEY);
  Object.assign(env, o);
  //   D1 に触れた回数を数える（I-SQ4）
  env._d1 = 0;
  const p = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (q) => { env._d1++; return p(q); };
  return env;
}
async function req(env, path, { method = 'GET', headers = {}, body = undefined, raw = undefined } = {}) {
  const init = { method, headers: Object.assign({}, headers) };
  if (raw !== undefined) { init.body = raw; init.duplex = 'half'; }
  else if (body !== undefined) { init.body = typeof body === 'string' ? body : JSON.stringify(body); init.headers['Content-Type'] = 'application/json'; }
  const res = await worker.fetch(new Request('https://w.example' + path, init), env, { waitUntil() {} });
  const text = await res.text();
  let j = null; try { j = JSON.parse(text); } catch (_) {}
  return { status: res.status, j, text, headers: res.headers };
}
const status = (env, key = KEY) => req(env, '/squad/status', { headers: { 'X-Squad-Read-Key': key } });
const send = (env, body) => req(env, '/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body });

function digest(o = {}) {
  const cid = o.check_id !== undefined ? o.check_id : NOW - 2 * H;
  return Object.assign({
    schema: 1, kind: 'digest', gas_build: '2026-11-27a', snap_at: NOW, check_id: cid,
    health_last: cid, health_done: cid, heal_last: NOW - H, heal_done: NOW - H + MIN,
    watch_from: null, practice_from: NOW - 3 * 86400000, digest_date: '2026-11-27', mode: 'practice', completed: true, gate: 'ok',
    save_last: { saved: true, why: null, check_id: cid, header_repaired: false, repairs: 0 },
    skip: { count: 0, last: null, entry: null, why: null }, lease: { present: false, until: null, entry: null },
    items: [{ k: 'member_broken', cls: 'B', st: '会員データ', sev: 'warn', c: 2, f: [], n_ids: 2, since: cid }],
    incidents: [{ k: 'trigger_missing', cls: 'A', stage: 'トリガーの揃い', status: 'open', attempts: 0, would_attempts: 1,
      last_action: 'practice_add_trigger:dailySync', opened_at: cid + 17 * MIN, last_seen: cid + 17 * MIN, closed_at: null, notified_at: null }],
    facts_rejected: 0, unknown_keys: 0, send_fail: { ok: 3, http_4xx: 0, http_5xx: 0, exception: 0, skipped_time: 0, skipped_late: 0 },
  }, o);
}
function beat(o = {}) {
  const cid = o.cid !== undefined ? o.cid : NOW - 2 * H;
  const b = Object.assign({ schema: 1, kind: 'beat', gas_build: '2026-11-27a', snap_at: NOW,
    health_last: cid, health_done: cid, heal_last: NOW - H, heal_done: NOW - H + MIN }, o);
  delete b.cid;
  return b;
}

// ---------- 1. I-SQ4 止める・鍵の検査は D1 より前 ----------
{
  for (const [label, o, key, want] of [
    ['off', { SQUAD_READ: 'off' }, KEY, 503], ['ハッシュの欄が空', { SQUAD_READ_KEY_SHA256: '' }, KEY, 503],
    ['ハッシュの欄が壊れている', { SQUAD_READ_KEY_SHA256: 'zz' }, KEY, 503],
    ['形の違う鍵（大文字）', {}, KEY.toUpperCase(), 403], ['形の違う鍵（短い）', {}, 'ab', 403], ['鍵なし', {}, '', 403],
    ['違う鍵', {}, KEY2, 403],
  ]) {
    const env = freshEnv(o);
    const r = await status(env, key);
    ok(`I-SQ4-1 ${label} → ${want}・D1 0回`, r.status === want && env._d1 === 0, `status=${r.status} d1=${env._d1}`);
  }
  const env = freshEnv({ SQUAD_READ: 'off' });
  const r1 = await send(env, digest());
  const r2 = await req(env, '/squad/report', { method: 'POST', headers: { 'X-Squad-Read-Key': KEY }, body: {} });
  const r3 = await req(env, '/squad/report/ack', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: {} });
  ok('I-SQ4-2 off は受ける側・報告・ack も 503・D1 0回', r1.status === 503 && r2.status === 503 && r3.status === 503 && env._d1 === 0, `${r1.status} ${r2.status} ${r3.status} d1=${env._d1}`);
  const env2 = freshEnv();
  const r4 = await req(env2, '/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'X' }, body: digest() });
  ok('I-SQ4-3 合言葉が違う要約は 403・D1 0回', r4.status === 403 && env2._d1 === 0);
  const env3 = freshEnv({ SQUAD_READ_KEY_SHA256: '', SQUAD_READ_KEY_SHA256_NEXT: sha(KEY2) });
  ok('I-SQ4-4 入れ替え用の欄（_NEXT）の鍵だけでも読める', (await status(env3, KEY2)).status === 200);
  const env4 = freshEnv({ SQUAD_READ_KEY_SHA256_NEXT: sha(KEY2) });
  ok('I-SQ4-5 両方の欄があるときはどちらの鍵でも読め、他は 403', (await status(env4, KEY)).status === 200 && (await status(env4, KEY2)).status === 200
     && (await status(env4, 'ef'.repeat(24))).status === 403);
  const r5 = await status(freshEnv());
  ok('I-SQ4-6 CORS を返さない', !r5.headers.get('Access-Control-Allow-Origin'));
}

// ---------- 2. I-SQ2 読む鍵では書けない／書く鍵では読めない ----------
{
  const env = freshEnv();
  const writes = [['/ingest', 'POST'], ['/calsync', 'POST'], ['/quota/build', 'POST'], ['/quota/rebuild', 'POST'], ['/quota/status', 'GET'],
    ['/quota/remain-allow', 'POST'], ['/quota/remain-probe', 'POST'], ['/quota/behind', 'GET'], ['/quota/verify', 'POST'], ['/jobs', 'POST'],
    ['/body/write', 'POST'], ['/body/freeze', 'POST'], ['/body/series', 'POST'], ['/writeshadow', 'POST'], ['/calcompare', 'POST'],
    ['/r/lookup', 'POST'], ['/calc', 'POST'], ['/squad/digest', 'POST'], ['/squad/report/ack', 'POST']];
  const bad = [];
  for (const [p, m] of writes) {
    const r = await req(env, p, { method: m, headers: { 'X-Squad-Read-Key': KEY }, body: m === 'POST' ? { action: 'x' } : undefined });
    if (!(r.status === 401 || r.status === 403)) bad.push(`${p}=${r.status}`);
  }
  ok('I-SQ2-1 ★部隊の鍵を付けて書き込み・合言葉の窓口を叩くと全部 401/403', bad.length === 0, bad.join(' '));
  const r = await req(env, '/squad/status', { headers: { 'X-Ingest-Secret': 'S' } });
  ok('I-SQ2-2 ★合言葉（X-Ingest-Secret）では /squad/status を読めない', r.status === 403);
  const r2 = await req(freshEnv({ SQUAD_REPORT: 'on' }), '/squad/report', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: {} });
  ok('I-SQ2-3 合言葉では報告を出せない', r2.status === 403);
  const r3 = await req(env, '/squad/status', { method: 'POST', headers: { 'X-Squad-Read-Key': KEY }, body: {} });
  ok('I-SQ2-4 /squad/status は GET だけ', r3.status === 405);
}

// ---------- 3. 送って読む（fresh）と I-SQ1 返す中身 ----------
{
  const env = freshEnv();
  ok('S3-0 一度も受け取っていなければ none（中身なし）', await (async () => { const r = await status(env); return r.status === 200 && r.j.state === 'none' && r.j.stale_reason === 'never_received' && !('digest' in r.j); })());
  const a = await send(env, digest()), b = await send(env, beat());
  ok('S3-1 要約と心拍を受ける', a.status === 200 && b.status === 200, `${a.status} ${a.text} ${b.status}`);
  const r = await status(env);
  ok('S3-2 fresh で中身が載る・版の印・読んだ回数', r.j.state === 'fresh' && r.j.digest && r.j.worker_build.length === 11 && r.j.reads_today === 2 && r.j.gas_build === '2026-11-27a', r.text.slice(0, 300));
  ok('S3-3 台帳の時刻は時間単位に切り下げ', r.j.digest.incidents[0].opened_at % H === 0 && r.j.digest.incidents[0].opened_at === Math.floor((NOW - 2 * H + 17 * MIN) / H) * H);
  ok('S3-4 snap_at・受け取り時刻は丸めない', r.j.digest.snap_at === NOW && r.j.digest_received_at === NOW);
  ok('S3-5 ★返りを台本の再構築器（strict）に通しても通る', sqRebuildStatus(JSON.parse(r.text)).ok, JSON.stringify(sqRebuildStatus(JSON.parse(r.text))));
  ok('S3-6 読むたびに reads_today が増える', (await status(env)).j.reads_today === 3);
}
{
  //   ★攻撃入力：余計な欄・氏名・電話・会員番号・自由文・未知の key・許されない facts
  const env = freshEnv();
  const d = digest({ name: FAKE[0], detail: FAKE[5] });
  d.items.push({ k: 'member_broken', cls: 'B', st: '会員データ', sev: 'warn', c: 1, f: [FAKE[1].slice(0, 13)], n_ids: 1, since: NOW - H, i: [FAKE[4]] });
  d.items.push({ k: 'brand_new_key', cls: 'B', st: '新しい段', sev: 'warn', c: 1, f: ['x'], n_ids: 0, since: null });
  d.incidents[0].id = FAKE[4]; d.incidents[0].notify_code = FAKE[2];
  const s = await send(env, d); await send(env, beat());
  const r = await status(env);
  const leak = FAKE.filter((x) => r.text.indexOf(x) >= 0 || r.text.indexOf(x.slice(0, 13)) >= 0);
  ok('I-SQ1-1 ★氏名・電話・会員番号・メール・自由文が返りに出ない', s.status === 200 && leak.length === 0, leak.join(','));
  const ks = r.j.digest.items.map((x) => x.k);
  ok('I-SQ1-2 未知の key は ? に置き換えて unknown_keys を数える', ks.includes('?') && r.j.digest.unknown_keys === 1 && !r.text.includes('brand_new_key'));
  ok('I-SQ1-3 許されない facts は捨てて facts_rejected を数える', r.j.digest.items[1].f.length === 0 && r.j.digest.facts_rejected >= 1);
  ok('I-SQ1-4 未知の段は ?', r.j.digest.items[2].st === '?');
  ok('I-SQ1-5 会員番号の配列 i を返さない', !r.j.digest.items.some((x) => 'i' in x) && !('id' in r.j.digest.incidents[0]));
}
{
  //   丸ごと拒否して前の行を残す：重複キー・末尾のデータ・型の違う必須欄
  const env = freshEnv();
  await send(env, digest()); await send(env, beat());
  const before = env._db.prepare("SELECT body, rejected FROM squad_digest WHERE kind='digest'").get();
  const good = JSON.stringify(digest({ snap_at: NOW + 1000 }));
  const dup = good.replace('"schema":1,', '"schema":1,"schema":1,');
  const r1 = await send(env, dup);
  const r2 = await send(env, good + ' {}');
  const r3 = await send(env, digest({ snap_at: NOW + 2000, check_id: 'x' }));
  const r4 = await send(env, digest({ snap_at: undefined }));
  const r5 = await send(env, digest({ snap_at: NOW + 3000, items: [{ k: 'member_broken', cls: 'B', st: '会員データ', sev: 'warn', c: -1, f: [], n_ids: 0, since: null }] }));
  const after = env._db.prepare("SELECT body, rejected FROM squad_digest WHERE kind='digest'").get();
  ok('I-SQ1-6 ★重複キー・末尾のデータ・型違い・snap_at 欠け・負の件数は 400 で前の行が残る', [r1, r2, r3, r4, r5].every((x) => x.status === 400) && after.body === before.body,
     [r1, r2, r3, r4, r5].map((x) => x.status).join(','));
  ok('I-SQ1-7 拒否は rejected に数える（理由は分けない）', Number(after.rejected) === Number(before.rejected) + 5, `${before.rejected}→${after.rejected}`);
  const rb = await send(env, beat({ snap_at: NOW + 1000, health_done: 'x' }));
  ok('I-SQ1-8 壊れた心拍で前の心拍を上書きしない', rb.status === 400);
}
{
  //   本文の大きさ（§3-3-2）
  const env = freshEnv();
  const gz = await req(env, '/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'S', 'Content-Encoding': 'gzip', 'Content-Type': 'application/json' }, raw: 'xx' });
  ok('I-SQ1-9 Content-Encoding: gzip は本文を読む前に 415', gz.status === 415);
  let cancelled = false, pulled = 0;
  const big = new ReadableStream({
    pull(c) { pulled++; if (pulled > 40) { c.close(); return; } c.enqueue(new Uint8Array(2000).fill(32)); },
    cancel() { cancelled = true; },
  });
  const r413 = await req(env, '/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, raw: big });
  ok('I-SQ1-10 ★65,537 バイトに達したら reader.cancel() して 413（Content-Length なし）', r413.status === 413 && cancelled && pulled < 40, `${r413.status} cancelled=${cancelled} pulled=${pulled}`);
  const decl = await req(env, '/squad/digest', { method: 'POST', headers: { 'X-Ingest-Secret': 'S', 'Content-Length': '70000' }, raw: 'x' });
  ok('I-SQ1-11 Content-Length が超えていれば読まずに 413', decl.status === 413);
  const base = JSON.stringify(digest());
  const pad = 65536 - Buffer.byteLength(base);
  const exact = base.slice(0, -1) + ' '.repeat(pad) + '}';
  ok('I-SQ1-12 ちょうど 65,536 バイトは受理', Buffer.byteLength(exact) === 65536 && (await send(env, exact)).status === 200);
  const over = base.slice(0, -1) + ' '.repeat(pad + 1) + '}';
  ok('I-SQ1-13 65,537 バイトは 413', (await send(env, over)).status === 413);
}
{
  //   最大構造が 65,536 に収まる（§3-3-2）。★長さの上限を全部満たした要約を組む
  const longK = SQ_KEYS.reduce((a, b) => (b.length > a.length ? b : a));
  const longSt = SQ_STAGES.reduce((a, b) => (Buffer.byteLength(b) > Buffer.byteLength(a) ? b : a));
  const longA = SQ_ACTIONS.reduce((a, b) => (b.length > a.length ? b : a));
  const items = Array.from({ length: 100 }, () => ({ k: 'heal_save_fail', cls: 'AB', st: longSt, sev: 'warn', c: 1000000,
    f: ['ledger', 'header_mismatch', 'exception', 'lease', 'lock_busy', 'expired', 'lost', 'other', 'broken'], n_ids: 1000000, since: 99999999999999 - 1 }));
  const incidents = Array.from({ length: 60 }, () => ({ k: longK, cls: 'info', stage: longSt, status: 'escalated', attempts: 1000000, would_attempts: 1000000,
    last_action: longA, opened_at: 99999999999999 - 1, last_seen: 99999999999999 - 1, closed_at: 99999999999999 - 1, notified_at: 99999999999999 - 1 }));
  const env = freshEnv();
  const d = digest({ items, incidents, facts_rejected: 1000000, unknown_keys: 1000000 });
  const bytes = Buffer.byteLength(JSON.stringify(d));
  const s = await send(env, d); await send(env, beat());
  const r = await status(env);
  ok('I-SQ1-14 ★最大構造の要約が受け取れ、応答も 65,536 バイト以内', s.status === 200 && r.status === 200 && Buffer.byteLength(r.text) <= 65536 && r.j.state === 'fresh',
     `req=${bytes} res=${Buffer.byteLength(r.text)} ${s.status} ${s.text}`);
  const items101 = items.concat([items[0]]);
  ok('I-SQ1-15 項目 101 個は丸ごと拒否', (await send(env, digest({ snap_at: NOW + 10, items: items101 }))).status === 400);
}

// ---------- 4. I-SQ3 古い・未完走・心拍切れは中身を出さない ----------
{
  const cases = [];
  const st = async (setup) => { const env = freshEnv(); await setup(env); const r = await status(env); return r.j; };
  cases.push(['要約だけ（心拍なし）→ beat_old', await st(async (e) => { await send(e, digest()); }), 'stale', 'beat_old']);
  cases.push(['心拍だけ → never_received', await st(async (e) => { await send(e, beat()); }), 'stale', 'never_received']);
  cases.push(['心拍が 2時間＋1分前 → beat_old', await st(async (e) => { await send(e, digest()); const t = NOW; NOW -= 2 * H + MIN; await send(e, beat()); NOW = t; }), 'stale', 'beat_old']);
  cases.push(['心拍がちょうど 2時間前 → fresh', await st(async (e) => { await send(e, digest()); const t = NOW; NOW -= 2 * H; await send(e, beat({ snap_at: NOW })); NOW = t; }), 'fresh', null]);
  cases.push(['要約が 26時間＋1分前 → digest_old', await st(async (e) => {
    const t = NOW; NOW -= 26 * H + MIN; await send(e, digest({ check_id: NOW - H })); NOW = t; await send(e, beat({ cid: NOW - 27 * H - MIN }));
  }), 'stale', 'digest_old']);
  cases.push(['要約が completed=false → not_completed', await st(async (e) => { await send(e, digest({ completed: false })); await send(e, beat({ snap_at: NOW - 1 })); }), 'stale', 'not_completed']);
  cases.push(['要約の gate≠ok → not_completed', await st(async (e) => { await send(e, digest({ gate: 'not_done' })); await send(e, beat({ snap_at: NOW - 1 })); }), 'stale', 'not_completed']);
  cases.push(['心拍が新しく点検の途中（last>done）→ not_completed', await st(async (e) => { await send(e, digest({ snap_at: NOW - 10 })); await send(e, beat({ health_last: NOW - 5 })); }), 'stale', 'not_completed']);
  cases.push(['心拍が新しく done≠要約の check_id → not_completed', await st(async (e) => { await send(e, digest({ snap_at: NOW - 10 })); await send(e, beat({ health_last: NOW - 20, health_done: NOW - 20 })); }), 'stale', 'not_completed']);
  cases.push(['心拍が新しく修理の途中 → not_completed', await st(async (e) => { await send(e, digest({ snap_at: NOW - 10 })); await send(e, beat({ heal_last: NOW - 5 })); }), 'stale', 'not_completed']);
  cases.push(['同時刻は要約の勝ち（心拍は途中でも要約が完走）→ fresh', await st(async (e) => { await send(e, digest()); await send(e, beat({ health_last: NOW + 0 - 1 })); }), 'fresh', null]);
  for (const [name, j, s, r] of cases) ok(`I-SQ3-1 ${name}`, j.state === s && j.stale_reason === r && (s === 'fresh') === ('digest' in j), `${j.state}/${j.stale_reason} digest=${'digest' in j}`);
}
{
  //   ★到着順の全順列：期待は「snap_at の最も新しい状態だけで決まる」
  const T0 = NOW - 40 * MIN;
  const cidOld = T0 - 24 * H, cidNew = T0 + 1 * MIN;
  const msgs = {
    beatPre: beat({ snap_at: T0, health_last: cidOld, health_done: cidOld, heal_last: cidOld + H, heal_done: cidOld + H + MIN }),
    beatMid: beat({ snap_at: T0 + 2 * MIN, health_last: cidNew, health_done: cidOld, heal_last: cidOld + H, heal_done: cidOld + H + MIN }),
    digCheck: digest({ snap_at: T0 + 6 * MIN, check_id: cidNew, health_last: cidNew, health_done: cidNew, heal_last: cidOld + H, heal_done: cidOld + H + MIN }),
    beatPost: beat({ snap_at: T0 + 10 * MIN, health_last: cidNew, health_done: cidNew, heal_last: cidOld + H, heal_done: cidOld + H + MIN }),
    beatHealMid: beat({ snap_at: T0 + 20 * MIN, health_last: cidNew, health_done: cidNew, heal_last: T0 + 19 * MIN, heal_done: cidOld + H + MIN }),
    digHeal: digest({ snap_at: T0 + 25 * MIN, check_id: cidNew, health_last: cidNew, health_done: cidNew, heal_last: T0 + 19 * MIN, heal_done: T0 + 24 * MIN }),
  };
  const perms = (a) => a.length <= 1 ? [a] : a.flatMap((x, i) => perms(a.slice(0, i).concat(a.slice(i + 1))).map((p) => [x].concat(p)));
  const sets = [
    [['beatPre', 'beatMid', 'digCheck', 'beatPost'], 'fresh'],
    [['beatPre', 'digCheck', 'beatMid'], 'fresh'],                // 途中の心拍は要約より古い
    [['digCheck', 'beatPost', 'beatHealMid'], 'not_completed'],   // 修理の途中の心拍が最新
    [['beatMid', 'digCheck', 'beatHealMid', 'digHeal'], 'fresh'],  // 修理の完走の要約が最新
    [['beatPre', 'beatMid'], 'never_received'],                    // 要約が届かない
    [['digCheck', 'beatHealMid'], 'not_completed'],                // 修理が途中で死んだ
  ];
  const bad = [];
  let n = 0;
  for (const [names, want] of sets) {
    for (const order of perms(names)) {
      const env = freshEnv();
      for (const k of order) await send(env, msgs[k]);
      const j = (await status(env)).j;
      const got = j.state === 'fresh' ? 'fresh' : j.stale_reason;
      n++;
      if (got !== want) bad.push(`${order.join('>')}=${got}（期待 ${want}）`);
    }
  }
  ok(`I-SQ3-2 ★到着順の全順列（${n} 通り）で、snap_at の最新の状態だけで決まる`, bad.length === 0, bad.slice(0, 4).join(' / '));
}
{
  //   snap_at の受け入れ
  const env = freshEnv();
  await send(env, digest()); await send(env, beat());
  const row = (k) => env._db.prepare('SELECT received_at, snap_at, rejected, body FROM squad_digest WHERE kind = ?').get(k);
  ok('I-SQ3-3 未来 +6分の snap_at は 409', (await send(env, beat({ snap_at: NOW + 6 * MIN }))).status === 409);
  ok('I-SQ3-4 2時間＋1分前の snap_at は 409', (await send(env, beat({ snap_at: NOW - 2 * H - MIN }))).status === 409);
  ok('I-SQ3-5 +4分（時計の前進）は受ける', (await send(env, beat({ snap_at: NOW + 4 * MIN }))).status === 200);
  const r0 = row('beat');
  ok('I-SQ3-6 小さい snap_at（時計の後退・遅れて着いた古い心拍）は 409・rejected が増える', (await send(env, beat({ snap_at: NOW + MIN }))).status === 409 && Number(row('beat').rejected) === Number(r0.rejected) + 1);
  const t = NOW; const sameBeat = beat({ snap_at: t + 4 * MIN }); NOW += 10 * MIN;
  const same = await send(env, sameBeat);
  ok('I-SQ3-7 ★同じ snap_at・同じ本文は成功で received_at が動かない（古さを若返らせない）', same.status === 200 && Number(row('beat').received_at) === t, `${same.status} ${row('beat').received_at} vs ${t}`);
  const r1 = row('beat');
  const diff = await send(env, Object.assign({}, sameBeat, { heal_done: t - 1 }));
  ok('I-SQ3-8 同じ snap_at・違う本文は 409・rejected が1増える', diff.status === 409 && Number(row('beat').rejected) === Number(r1.rejected) + 1);
  NOW = t;
  //   ★壊れた未来値の行（received_at より 10分先）が入った後に、正常な要求で直る
  env._db.prepare("UPDATE squad_digest SET snap_at = received_at + 600000 WHERE kind = 'digest'").run();
  const rep = await send(env, digest({ snap_at: NOW - MIN }));
  ok('I-SQ3-9 ★壊れた未来値の行は正常な要求で置き換わる', rep.status === 200 && Number(row('digest').snap_at) === NOW - MIN);
}

// ---------- 5. I-SQ4 読み取りの上限は1つの条件付き文で原子的 ----------
{
  const env = freshEnv();
  const day = new Date(NOW + 9 * H).toISOString().slice(0, 10);
  env._db.prepare('INSERT INTO squad_reads(day, n, last_read_at) VALUES (?, 199, ?)').run(day, NOW);
  const rs = await Promise.all(Array.from({ length: 5 }, () => status(env)));
  const n200 = rs.filter((r) => r.status === 200).length, n429 = rs.filter((r) => r.status === 429).length;
  ok('I-SQ4-7 ★上限199から並行に5本 → 通るのは1本だけ・残りは 429', n200 === 1 && n429 === 4, rs.map((r) => r.status).join(','));
  const env2 = freshEnv();
  const rs2 = await Promise.all(Array.from({ length: 4 }, () => status(env2)));
  const rows = env2._db.prepare('SELECT day, n FROM squad_reads').all();
  ok('I-SQ4-8 日替わりの初回が並行でも行は1つ・数は4', rows.length === 1 && Number(rows[0].n) === 4 && rs2.every((r) => r.status === 200));
  const env3 = freshEnv(); env3._failRe = /squad_reads/;
  ok('I-SQ4-9 数える文が例外なら 503（答えない）', (await status(env3)).status === 503);
  const env4 = freshEnv();
  ok('I-SQ4-10 鍵が違う要求では squad_reads に書かない', (await status(env4, KEY2)).status === 403 && env4._db.prepare('SELECT COUNT(*) AS n FROM squad_reads').get().n === 0);
}

// ---------- 6. I-SQ7 check_id は前進のみ ----------
{
  const env = freshEnv();
  await send(env, digest({ check_id: NOW - H }));
  const r = await send(env, digest({ snap_at: NOW + 1000, check_id: NOW - 2 * H }));
  ok('I-SQ7-1 新しい snap_at でも check_id が後退する要約は置き換わらない（409）', r.status === 409 && Number(env._db.prepare("SELECT check_id FROM squad_digest WHERE kind='digest'").get().check_id) === NOW - H);
}

// ---------- 7. I-SQ9 部隊の報告（④）----------
{
  const rep = (o = {}) => Object.assign({ schema: 1, run_id: NOW, verdict: 'owner_needed', urgency: 'daily', items: [{ k: 'squad_gas_quiet', j: 'new', c: 1 }], ask: 'check_system' }, o);
  const post = (env, b, key = KEY) => req(env, '/squad/report', { method: 'POST', headers: { 'X-Squad-Read-Key': key }, body: b });
  const env0 = freshEnv();
  const r0 = await post(env0, rep());
  ok('I-SQ9-1 ★SQUAD_REPORT が未設定なら 503・D1 0回（既定は閉じる）', r0.status === 503 && env0._d1 === 0);
  const env = freshEnv({ SQUAD_REPORT: 'on' });
  ok('I-SQ9-2 違う鍵は 403', (await post(env, rep(), KEY2)).status === 403);
  ok('I-SQ9-3 自由文の欄・未知の key・未知の列挙は 400', (await post(env, rep({ note: FAKE[5] }))).status === 400
     && (await post(env, rep({ items: [{ k: 'unknown_thing', j: 'new', c: 1 }] }))).status === 400
     && (await post(env, rep({ verdict: 'ok' }))).status === 400);
  const ok1 = await post(env, rep());
  ok('I-SQ9-4 報告を受ける', ok1.status === 200 && ok1.j.id === NOW);
  await send(env, digest());
  const b1 = await send(env, beat());
  ok('I-SQ9-5 心拍の応答で報告を1回だけ渡す', b1.status === 200 && b1.j.report && b1.j.report.run_id === NOW && b1.j.report.ask === 'check_system', b1.text);
  const t = NOW; NOW += 60 * MIN;
  const b2 = await send(env, beat());
  ok('I-SQ9-6 次の心拍では渡さない', b2.status === 200 && !b2.j.report);
  ok('I-SQ9-7 渡した後・ack 前の状態は handed', (await status(env)).j.report_state === 'handed');
  const ack = await req(env, '/squad/report/ack', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: { id: t, code: 'line_ok' } });
  ok('I-SQ9-8 ack で delivered', ack.status === 200 && (await status(env)).j.report_state === 'delivered');
  const ack2 = await req(env, '/squad/report/ack', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: { id: t, code: 'line_ok' } });
  ok('I-SQ9-9 同じ番号の二度目の ack は成功（already）・状態は変わらない', ack2.status === 200 && ack2.j.already === true);
  ok('I-SQ9-9b 古い番号の ack は 409', (await req(env, '/squad/report/ack', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: { id: t - 1000, code: 'line_ok' } })).status === 409);
  ok('I-SQ9-10 古い番号の報告は 429', (await post(env, rep({ run_id: t - 1 }))).status === 429);
  let okN = 1;
  for (let i = 1; i <= 6; i++) { NOW += 1000; if ((await post(env, rep({ run_id: NOW }))).status === 200) okN++; }
  ok('I-SQ9-11 1日の上限は6件（7件目から 429）', okN === 6, `受けた=${okN}`);
  //   ★ack が無いまま2時間たてば渡し直す・3回まで（関門② 中1：応答が GAS に届かなかった回を失わない）
  const envR = freshEnv({ SQUAD_REPORT: 'on' });
  const t0 = NOW;
  await post(envR, rep({ run_id: t0 }));
  const hands = [];
  for (let i = 0; i < 6; i++) { const b = await send(envR, beat({ snap_at: NOW })); hands.push(!!(b.j && b.j.report)); NOW += 2 * H + MIN; }
  ok('I-SQ9-13a ack が無ければ2時間ごとに渡し直し、3回で止める', JSON.stringify(hands) === JSON.stringify([true, true, true, false, false, false]), JSON.stringify(hands));
  NOW = t0;
  const envR2 = freshEnv({ SQUAD_REPORT: 'on' });
  await post(envR2, rep({ run_id: t0 }));
  await send(envR2, beat());
  await req(envR2, '/squad/report/ack', { method: 'POST', headers: { 'X-Ingest-Secret': 'S' }, body: { id: t0, code: 'mail_ok' } });
  NOW += 3 * H;
  const bR = await send(envR2, beat({ snap_at: NOW }));
  ok('I-SQ9-13b ack の後は渡し直さない', bR.status === 200 && !bR.j.report);
  NOW += 1000;
  await post(envR2, rep({ run_id: NOW }));
  const bR2 = await send(envR2, beat({ snap_at: NOW }));
  ok('I-SQ9-13c 新しい報告は回数を数え直して渡す', bR2.j && bR2.j.report && bR2.j.report.run_id === NOW);
  NOW = t0;
  const envOff = freshEnv({ SQUAD_REPORT: 'on' });
  await post(envOff, rep());
  envOff.SQUAD_REPORT = '';
  const b3 = await send(envOff, beat());
  ok('I-SQ9-12 SQUAD_REPORT を外すと心拍の応答で報告を渡さない', b3.status === 200 && !b3.j.report);
  NOW = t;
}

// ---------- 8. squad_quiet の材料（/quota/status?squad=1）----------
{
  const q = (env) => req(env, '/quota/status?squad=1', { headers: { 'X-Ingest-Secret': 'S' } });
  const env0 = freshEnv({ SQUAD_READ: 'off' });
  const r0 = await q(env0);
  ok('I-SQ9-13 off なら read_on=false で D1 0回', r0.status === 200 && r0.j.squad.read_on === false && env0._d1 === 0, r0.text);
  const env = freshEnv();
  const r1 = await q(env);
  ok('I-SQ9-14 一度も読まれていなければ quiet にしない', r1.j.squad.read_on === true && r1.j.squad.last_read_at === null && r1.j.squad.quiet === false);
  await status(env);
  const t = NOW; NOW += 26 * H + MIN;
  const r2 = await q(env);
  ok('I-SQ9-15 26時間＋1分読まれていなければ quiet', r2.j.squad.quiet === true && r2.j.squad.last_read_at === t);
  NOW = t + 26 * H;
  ok('I-SQ9-16 ちょうど26時間は quiet にしない', (await q(env)).j.squad.quiet === false);
  NOW = t;
  ok('I-SQ9-17 部隊の鍵では ?squad=1 を読めない', (await req(env, '/quota/status?squad=1', { headers: { 'X-Squad-Read-Key': KEY } })).status === 403);
}

// ---------- 9. /jobs/<id> は鍵の形を D1 より前に見る（決定0208 の別件）----------
{
  const env = freshEnv();
  const id = 'a'.repeat(24);
  const r1 = await req(env, '/jobs/' + id);
  const r2 = await req(env, '/jobs/' + id, { headers: { 'X-Job-Read-Key': 'xyz' } });
  ok('J-1 ★鍵の無い・形の違う /jobs/<id> は 403 で D1 0回', r1.status === 403 && r2.status === 403 && env._d1 === 0, `${r1.status} ${r2.status} d1=${env._d1}`);
  const r3 = await req(env, '/jobs/' + id, { headers: { 'X-Job-Read-Key': KEY } });
  ok('J-2 形の合う鍵なら今どおり D1 を引く（無ければ 404）', r3.status === 404 && env._d1 === 1);
}

Date.now = realNow;
console.log(`\n${fail ? '❌' : '✅'} squad-read: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
