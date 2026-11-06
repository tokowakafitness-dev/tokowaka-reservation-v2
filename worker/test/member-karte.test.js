// 会員画面 C2（設計35・改訂1〜3）を、本物の SQLite に全 migration を流し、**入口（index.js）から**通す。
//   実行: node worker/test/member-karte.test.js
//
// ★なぜ本物の SQLite か
//   karte_member_notes の部分 UNIQUE・CHECK と、karte_guard の見張りは D1 の身代わりでは再現しない。
// ★なぜ入口から通すか
//   停止スイッチ MEMBER_KARTE・許可表・body.customerId の検査は index.js にある（部品ではなく配線を検査する）。
// ★見本の値だけを使う（会員の氏名・フル ID を書かない・I38）

import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import worker from '../src/index.js';
import { buildMemberKarte } from '../src/lib/member-karte.js';
import { compatMyKarte } from '../src/routes/member-karte.js';
import { normalizeMember } from '../src/routes/karte.js';
import { isAllowed } from '../src/perms.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const W = join(HERE, '..');
const ROOT = join(W, '..');
const ORIGIN = 'https://reservation.tokowaka-gym.com';
const CHANNEL = '1234567890';

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

// ---------------- D1 の身代わり（実物の SQLite・全 migration）----------------
//   env._log：実行した SQL を記録する／env._hook(q, args)：検査のために失敗させる・値を差し替える
function makeEnv() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(readFileSync(join(W, 'schema.sql'), 'utf8'));
  for (const f of readdirSync(join(W, 'migrations')).filter((x) => x.endsWith('.sql')).sort()) {
    try { db.exec(readFileSync(join(W, 'migrations', f), 'utf8')); } catch (e) {
      if (!/duplicate column/.test(e.message)) throw e;
    }
  }
  db.exec('PRAGMA foreign_keys = ON');   // 0001 が切るので戻す（D1 は既定で有効）
  const env = { LINE_CHANNEL_ID: CHANNEL, _db: db, _kv: {}, _log: [], _hook: null };
  const exec = (q, args0, how) => {
    let args = args0;
    if (env._hook) { const r = env._hook(q, args); if (r) args = r; }
    env._log.push(q);
    const st = db.prepare(q);
    if (how === 'first') { const r = st.get(...args); return r === undefined ? null : Object.assign({}, r); }
    if (how === 'all') return { results: st.all(...args).map((r) => Object.assign({}, r)) };
    const r = st.run(...args);
    return { meta: { changes: Number(r.changes) } };
  };
  env.KV = { async get(k, t) { const v = env._kv[k]; return v == null ? null : (t === 'json' ? JSON.parse(v) : v); }, async put(k, v) { env._kv[k] = v; } };
  env.DB = {
    prepare(q) {
      return { _q: q, _args: [], bind(...a) { this._args = a; return this; },
               async run() { return exec(q, this._args, 'run'); }, async first() { return exec(q, this._args, 'first'); },
               async all() { return exec(q, this._args, 'all'); } };
    },
    async batch(stmts) {
      db.exec('BEGIN');
      try { const out = stmts.map((s) => exec(s._q, s._args, 'run')); db.exec('COMMIT'); return out; }
      catch (e) { try { db.exec('ROLLBACK'); } catch (_) {} throw e; }
    },
  };
  return env;
}
const q1 = (env, sql, ...a) => { const r = env._db.prepare(sql).get(...a); return r ? Object.assign({}, r) : null; };
const qn = (env, sql, ...a) => q1(env, sql, ...a).n;

// ---------------- トークン（ES256）----------------
const b64u = (buf) => Buffer.from(buf).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
const kp = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']);
const pubJwk = { ...(await crypto.subtle.exportKey('jwk', kp.publicKey)), kid: 'k1', alg: 'ES256' };
async function token(sub) {
  const now = Math.floor(Date.now() / 1000);
  const h = b64u(JSON.stringify({ alg: 'ES256', kid: 'k1', typ: 'JWT' }));
  const pl = b64u(JSON.stringify({ iss: 'https://access.line.me', aud: CHANNEL, sub, exp: now + 3600, iat: now }));
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, kp.privateKey, new TextEncoder().encode(h + '.' + pl));
  return h + '.' + pl + '.' + b64u(sig);
}

// ---------------- 見本 ----------------
const env = makeEnv();
env._kv['jwks:line'] = JSON.stringify({ keys: [pubJwk] });
const NOW = Date.now();
const d = env._db;
const jstDay = (ms) => new Date(ms + 9 * 3600000).toISOString().slice(0, 10);
const today = jstDay(NOW);
const dayOffset = (n) => jstDay(NOW + n * 86400000);
d.exec(`INSERT INTO trainers (trainer_id, name, line_user_id, role, active) VALUES
  ('T1', '一郎', 'U_T1', 'trainer', 1), ('T2', '二郎', 'U_T2', 'trainer', 1), ('OWN', '店主', 'U_OWN', 'owner', 1)`);
d.exec(`INSERT INTO customers (customer_id, name, line_user_id, default_trainer_id, created_at, updated_at) VALUES
  ('C1', '見本一', 'U_C1', 'T1', 1, 1), ('C2', '見本二', 'U_C2', 'T2', 1, 1), ('C3', '見本三', NULL, NULL, 1, 1)`);
const fresh = () => d.exec(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES ('customers', ${Date.now()}, 3, 1), ('trainers', ${Date.now()}, 3, 1)
  ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at`);
fresh();
const calcFresh = (at) => {
  for (const k of ['calcContracts', 'calcMeta', 'calcReservations', 'opening']) {
    d.prepare(`INSERT INTO sync_state (key, synced_at, rows, ok) VALUES (?, ?, 1, 1) ON CONFLICT(key) DO UPDATE SET synced_at = excluded.synced_at`).run(k, at);
  }
};
calcFresh(NOW - 60000);

let reqSeq = 0;
const crid = () => 'mreq-' + (++reqSeq).toString().padStart(6, '0');
async function call(as, action, body = {}) {
  const payload = JSON.stringify({ action, idToken: await token(as), ...body });
  const res = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN }, body: payload }), env, { waitUntil() {} });
  let j = {};
  try { j = await res.json(); } catch (_) {}
  return { status: res.status, ...j };
}
const clearRate = () => d.exec('DELETE FROM karte_rate');

//   社内・健康・金額の「漏れてはいけない文字」（見本）
const SECRETS = ['社内秘メモ本文', '次回計画秘', '確認秘', '右膝秘', '診断秘', '服薬秘', 'ヒアリング秘', 'セット秘メモ', '99999', '0.35', 'C2専用', '88.8'];

// 体の記録（I51）：verified の凍結 fzV ＋ d1。copying の fzX の写し・削除済みは出ない
d.exec(`INSERT INTO body_freeze (freeze_id, state, counts_json, hashes_json, copied_json, started_at) VALUES
  ('fzV', 'verified', '{}', '{}', '{}', ${NOW - 1000}), ('fzX', 'copying', '{}', '{}', '{}', ${NOW})`);
const bm = d.prepare(`INSERT INTO body_measurements (customer_id, measured_date, source_raw, origin, origin_key, sheet_order, weight_kg, body_fat_pct, skeletal_muscle_kg, waist_cm, created_at, updated_at, deleted_at)
  VALUES (?, ?, 'inbody', ?, ?, ?, ?, ?, ?, ?, 1, 1, ?)`);
bm.run('C1', dayOffset(-30), 'sheet', 'fzV:body_log:0', 0, 70, 25, 28, null, null);
bm.run('C1', dayOffset(-10), 'd1', null, null, 69, 24, null, null, null);
bm.run('C1', dayOffset(-1), 'd1', null, null, 68.5, null, 29, null, null);
bm.run('C1', dayOffset(-5), 'sheet', 'fzX:body_log:0', 0, 99, null, null, null, null);   // 未確認の写し
bm.run('C1', dayOffset(-3), 'd1', null, null, 55, null, null, null, NOW);                // 削除済み
bm.run('C1', dayOffset(-2), 'd1', null, null, null, null, null, 80, null);               // 3項目が空の日
bm.run('C2', dayOffset(-1), 'd1', null, null, 88.8, null, null, null, null);
d.prepare(`INSERT INTO body_goals (customer_id, kind, start_date, end_date, start_weight, target_weight, origin, updated_at) VALUES (?, 'meal_goal', ?, ?, ?, ?, 'd1', 1)`)
  .run('C1', dayOffset(-30), dayOffset(60), 70, 65);
d.prepare(`INSERT INTO karte_profile (customer_id, goal_deadline, hearing_json, goal_text, motive, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 'T1', 1)`)
  .run('C1', '2027-03-31', JSON.stringify({ targetWeight: 65, exerciseNow: 'ヒアリング秘' }), 'ヒアリング秘の理想', 'ヒアリング秘の動機');
d.prepare(`INSERT INTO karte_profile (customer_id, goal_deadline, hearing_json, updated_by, updated_at) VALUES ('C2', '2027-01-01', '{"targetWeight":80}', 'T2', 1)`).run();
//   社内メモ・健康情報（会員には出ない）
d.prepare(`INSERT INTO karte_notes (note_id, customer_id, session_date, body, next_plan, next_check, reasons_json, author_trainer_id, created_at) VALUES ('N1', 'C1', ?, '社内秘メモ本文', '次回計画秘', '確認秘', '["snack_down"]', 'T1', 1)`).run(today);
d.exec(`INSERT INTO karte_consent (customer_id, kind, state, changed_at, method, recorded_by) VALUES ('C1', 'health', 'agreed', 1, 'paper', 'T1')`);
d.exec(`INSERT INTO karte_safety (customer_id, injuries, diagnosis, medication, pain_json, updated_by, updated_at) VALUES ('C1', '右膝秘', '診断秘', '服薬秘', '[{"region":"knee_r","level":3}]', 'T1', 1)`);
//   契約（金額の列・報酬の列を含む行）
d.prepare(`INSERT INTO calc_meta (key, payload) VALUES ('contract_cols', ?)`).run(JSON.stringify({ cols: { name: 1, type: 2, reward: 4, course: 5, ticket: 6, freq: 8, start: 10, end: 11, trainer: 3, method: 16, ticketPrice: 19 } }));
const crow = new Array(23).fill('');
crow[1] = '見本一'; crow[2] = '月額'; crow[3] = '一郎'; crow[4] = 0.35; crow[5] = 'ベーシック'; crow[6] = 8; crow[8] = 4; crow[19] = 99999;
d.prepare(`INSERT INTO calc_contract_rows (row_key, customer_id, idx, row_json, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('C1#1', 'C1', 1, JSON.stringify(crow), NOW - 10 * 86400000, NOW + 50 * 86400000);
const crow2 = crow.slice(); crow2[1] = '見本二'; crow2[3] = '二郎'; crow2[2] = 'C2専用チケット';
d.prepare(`INSERT INTO calc_contract_rows (row_key, customer_id, idx, row_json, start_ms, end_ms) VALUES (?, ?, ?, ?, ?, ?)`)
  .run('C2#1', 'C2', 1, JSON.stringify(crow2), NOW - 10 * 86400000, NOW + 50 * 86400000);

// トレーニング（入口から書く）
const tr1 = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: dayOffset(-7), clientReqId: crid(),
  items: [{ exercise: 'スクワット', sets: [{ weight: 40, reps: 10, note: 'セット秘メモ' }, { weight: 50, reps: 8 }] }, { exercise: 'ベンチプレス', sets: [{ weight: 30, reps: 10 }] }],
  member: { message: '  よく頑張りました  ', todo: ['水を2L', '', '  '], tags: ['脚', '全身'] } });
const tr2 = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: dayOffset(-2), clientReqId: crid(),
  items: [{ exercise: 'スクワット', sets: [{ weight: 50, reps: 10 }] }] });
const tr3 = await call('U_T2', 'k_addTraining', { customerId: 'C2', sessionDate: dayOffset(-2), clientReqId: crid(),
  items: [{ exercise: 'C2専用種目', sets: [{ weight: 77, reps: 7 }] }], member: { message: 'C2専用メッセージ', todo: ['C2専用の宿題'], tags: ['C2専用'] } });
ok('0-1 見本のトレーニングが書けた（お客様の欄つき）', tr1.status === 200 && tr1.mnoteId && tr1.mnoteRev === 1 && tr2.status === 200 && !('mnoteId' in tr2) && tr3.status === 200,
   JSON.stringify([tr1, tr2, tr3]));

// ================= 1. 停止スイッチ（I-M5）と許可（I-M1） =================
{
  delete env.MEMBER_KARTE;
  const a = await call('U_C1', 'c_myKarte', {});
  ok('1-1 MEMBER_KARTE が無ければ c_myKarte は 503', a.status === 503 && a.code === 'MEMBER_KARTE_OFF', JSON.stringify(a));
  for (const v of ['off', 'ON', 'true', '1', ' on']) {
    env.MEMBER_KARTE = v;
    const r = await call('U_C1', 'c_myKarte', {});
    ok(`1-2 MEMBER_KARTE="${v}" でも 503（厳密に 'on' だけ開く）`, r.status === 503 && r.code === 'MEMBER_KARTE_OFF');
  }
  env.MEMBER_KARTE = 'off';
  const raw = await worker.fetch(new Request('https://w.example/', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: ORIGIN },
    body: JSON.stringify({ action: 'c_myKarte', idToken: 'not-a-token' }) }), env, { waitUntil() {} });
  ok('1-2b ★入口が認証より前に止める（壊れたトークンでも 401 でなく 503）', raw.status === 503);
  const direct = await compatMyKarte({ env, who: { role: 'customer', customerId: 'C1' }, body: {} });
  ok('1-3 ★窓口を直接呼んでも off なら 503（入口の分岐が外れても止まる）', direct._error === 'MEMBER_KARTE_OFF' && direct._status === 503);
  const pv = await call('U_T1', 'k_memberPreview', { customerId: 'C1' });
  ok('1-4 ★off でも k_memberPreview は動く', pv.status === 200 && pv.success && pv.goal && pv.training, JSON.stringify(pv).slice(0, 200));
  const sv = await call('U_T1', 'k_saveMemberNote', { rev: 0, customerId: 'C1', sessionDate: today, message: 'off でも書ける', clientReqId: crid() });
  ok('1-5 off でも k_saveMemberNote は動く', sv.status === 200 && sv.mnoteId, JSON.stringify(sv));
  env.KARTE = 'off';
  const pvk = await call('U_T1', 'k_memberPreview', { customerId: 'C1' });
  ok('1-6 KARTE=off なら k_memberPreview は止まる（KARTE の守りは受ける）', pvk.status === 503 && pvk.code === 'KARTE_OFF');
  delete env.KARTE;

  env.MEMBER_KARTE = 'on';
  const t = await call('U_T1', 'c_myKarte', {});
  ok('1-7 トレーナーは c_myKarte を叩けない（customer だけ）', t.status === 403);
  const g = await call('U_GUEST', 'c_myKarte', {});
  ok('1-8 未登録（guest）も叩けない', g.status === 403);
  const cpv = await call('U_C1', 'k_memberPreview', { customerId: 'C1' });
  ok('1-9 会員は k_memberPreview を叩けない', cpv.status === 403);
  const csv = await call('U_C1', 'k_saveMemberNote', { rev: 0, customerId: 'C1', sessionDate: today, message: 'x', clientReqId: crid() });
  ok('1-10 会員は k_saveMemberNote を叩けない', csv.status === 403);
  const other = await call('U_C1', 'c_myKarte', { customerId: 'C2' });
  ok('1-11 body に他人の customerId を入れると入口で 403（他人の中身は返らない）', other.status === 403 && !JSON.stringify(other).includes('C2専用'));
  //   ★窓口は body を一切読まない：直接呼びで body に他人の値を入れても本人の中身だけ
  const evil = await compatMyKarte({ env, who: { role: 'customer', customerId: 'C1' },
    body: { customerId: 'C2', mnoteId: 'x', sessionId: tr3.sessionId, noteId: 'N1' } });
  ok('1-12 ★body の customerId・sessionId・noteId を無視する（本人＝who.customerId だけ）',
     evil.training && evil.training.sessions.length === 2 && !JSON.stringify(evil).includes('C2専用'), JSON.stringify(evil).slice(0, 300));
  const noCid = await compatMyKarte({ env, who: { role: 'customer', customerId: '' }, body: { customerId: 'C1' } });
  ok('1-13 who.customerId が無ければ 403（body で補わない）', noCid._error === 'FORBIDDEN');
  const trDirect = await compatMyKarte({ env, who: { role: 'trainer', trainerId: 'T1', customerId: 'C1' }, body: {} });
  ok('1-14 窓口の中でも customer 以外は 403', trDirect._error === 'FORBIDDEN');
  //   LINE の ID が入っていない行（未承認で押し出し側が null にした行）は customer にならない
  const pend = await call('U_C3', 'c_myKarte', {});
  ok('1-15 line_user_id の無い会員は guest 扱い＝届かない', pend.status === 403);
  ok('1-16 許可表：c_myKarte は customer だけ／k_ の3つは trainer（owner は継承）', isAllowed('c_myKarte', 'customer') && !isAllowed('c_myKarte', 'trainer')
     && !isAllowed('c_myKarte', 'owner') && !isAllowed('c_myKarte', 'guest')
     && ['k_memberPreview', 'k_saveMemberNote', 'k_deleteMemberNote'].every((a) => isAllowed(a, 'trainer') && isAllowed(a, 'owner') && !isAllowed(a, 'customer') && !isAllowed(a, 'guest')));
}

// ================= 2. 中身（allowlist・混ざらない・I-M2・I-M3） =================
let mine;
{
  env.MEMBER_KARTE = 'on';
  mine = await call('U_C1', 'c_myKarte', {});
  const s = JSON.stringify(mine);
  ok('2-1 会員は自分のカルテを読める', mine.status === 200 && mine.success === true, s.slice(0, 300));
  const leaked = SECRETS.filter((x) => s.includes(x));
  ok('2-2 ★応答 JSON 全体に社内メモ・次回の計画・確かめること・健康情報・ヒアリングの自由文・セットのメモ・金額・他人の値が無い', leaked.length === 0, '漏れ: ' + leaked.join(','));
  ok('2-3 ★作成者の ID・顧客 ID・枚の ID を返さない', !/"T1"|"T2"|"OWN"|"C1"|author|mnoteId|sessionId|customer_id/.test(s), s.slice(0, 400));
  ok('2-4 最上位の鍵は決めた形だけ', JSON.stringify(Object.keys(mine).filter((k) => k !== 'status').sort()) === JSON.stringify(['body', 'contract', 'goal', 'notes', 'success', 'training']), Object.keys(mine).join(','));
  ok('2-5 目標：目標体重（数）と期日', mine.goal.targetWeight === 65 && mine.goal.deadline === '2027-03-31', JSON.stringify(mine.goal));
  const b = mine.body;
  ok('2-6 ★体の記録は verified の凍結＋d1 だけ（未確認の写し・削除済み・3項目が空の日は出ない）',
     b.series.length === 3 && b.series.map((x) => x.weight).join(',') === '70,69,68.5', JSON.stringify(b.series));
  ok('2-7 最新と前回・数は数のまま', b.latest.date === dayOffset(-1) && b.latest.weight === 68.5 && b.latest.fat === null && b.latest.muscle === 29
     && b.prev.date === dayOffset(-10) && b.prev.fat === 24, JSON.stringify([b.latest, b.prev]));
  ok('2-8 recent は新しい→古い', b.recent.map((x) => x.date).join(',') === [dayOffset(-1), dayOffset(-10), dayOffset(-30)].join(','));
  ok('2-9 目標線', b.goalLine && b.goalLine.startWeight === 70 && b.goalLine.targetWeight === 65 && b.goalLine.endDate === dayOffset(60), JSON.stringify(b.goalLine));
  const tr = mine.training;
  ok('2-10 トレーニングは新しい→古い・自分の分だけ', tr.sessions.length === 2 && tr.sessions[0].date === dayOffset(-2) && tr.sessions[1].date === dayOffset(-7));
  const s7 = tr.sessions[1];
  ok('2-11 種目は入力の順・セットは {setNo,weight,reps} の数だけ', s7.items.map((x) => x.exercise).join(',') === 'スクワット,ベンチプレス'
     && JSON.stringify(s7.items[0].sets) === JSON.stringify([{ setNo: 1, weight: 40, reps: 10 }, { setNo: 2, weight: 50, reps: 8 }]), JSON.stringify(s7));
  ok('2-12 日のタグはその session の枚の tags（無ければ空配列）', JSON.stringify(s7.tags) === '["脚","全身"]' && JSON.stringify(tr.sessions[0].tags) === '[]');
  const sq = tr.best.find((x) => x.exercise === 'スクワット');
  ok('2-13 自己ベスト：重さ最大→回数最大→日付', sq && sq.weight === 50 && sq.reps === 10 && sq.date === dayOffset(-2), JSON.stringify(tr.best));
  const n7 = mine.notes.find((x) => x.date === dayOffset(-7));
  ok('2-14 「お客様へ」：前後の空白を落とし・空の宿題を捨て・担当は表示名', n7 && n7.message === 'よく頑張りました' && JSON.stringify(n7.todo) === '["水を2L"]' && n7.trainerName === '一郎', JSON.stringify(mine.notes));
  ok('2-15 notes は新しい→古い', mine.notes.length >= 2 && mine.notes[0].date >= mine.notes[mine.notes.length - 1].date);
  const c = mine.contract;
  ok('2-16 契約：種類・コース・回数・担当（名簿の表示名）・期間・枚数だけ', c && c.type === '月額' && c.course === 'ベーシック' && c.freq === 4 && c.tickets === 8
     && c.trainerName === '一郎' && c.startDate === jstDay(NOW - 10 * 86400000) && c.endDate === jstDay(NOW + 50 * 86400000)
     && JSON.stringify(Object.keys(c).sort()) === JSON.stringify(['course', 'endDate', 'freq', 'startDate', 'tickets', 'trainerName', 'type']), JSON.stringify(c));
  const m2 = await call('U_C2', 'c_myKarte', {});
  const s2 = JSON.stringify(m2);
  ok('2-17 ★2人目で読むと2人目の分だけ（1人目の値が混ざらない）', m2.status === 200 && m2.training.sessions.length === 1 && m2.training.sessions[0].items[0].exercise === 'C2専用種目'
     && !s2.includes('よく頑張りました') && !s2.includes('スクワット') && m2.goal.targetWeight === 80 && m2.body.latest.weight === 88.8 && m2.body.series.length === 1 && m2.contract.type === 'C2専用チケット', s2.slice(0, 300));
  const log = q1(env, `SELECT trainer_id, role, customer_id, section, action, result, req_id FROM karte_access_log WHERE action = 'c_myKarte' ORDER BY id DESC LIMIT 1`);
  ok('2-18 ★読んだ記録：trainer_id=NULL・role=customer・section=member_karte・中身なし（I-M8）', log && log.trainer_id === null && log.role === 'customer'
     && log.customer_id === 'C2' && log.section === 'member_karte' && log.result === 'ok' && log.req_id === null, JSON.stringify(log));
}

// ================= 3. 契約の鮮度（I53）・列が無いとき =================
{
  calcFresh(NOW - 46 * 60000);
  const a = await call('U_C1', 'c_myKarte', {});
  ok('3-1 ★計算の材料が45分以上前なら契約は null', a.status === 200 && a.contract === null);
  calcFresh(NOW - 60000);
  d.exec(`UPDATE sync_state SET synced_at = synced_at - 1 WHERE key = 'opening'`);
  const b = await call('U_C1', 'c_myKarte', {});
  ok('3-2 ★材料4つの回がそろわなければ null', b.contract === null);
  calcFresh(NOW - 60000);
  const meta0 = q1(env, `SELECT payload FROM calc_meta WHERE key = 'contract_cols'`).payload;
  const m = JSON.parse(meta0); delete m.cols.start; delete m.cols.end;
  d.prepare(`UPDATE calc_meta SET payload = ? WHERE key = 'contract_cols'`).run(JSON.stringify(m));
  const c = await call('U_C1', 'c_myKarte', {});
  ok('3-3 ★期間の列が契約表に無ければ推定せず null', c.contract && c.contract.startDate === null && c.contract.endDate === null && c.contract.tickets === 8, JSON.stringify(c.contract));
  d.prepare(`UPDATE calc_meta SET payload = ? WHERE key = 'contract_cols'`).run(meta0);
  const r0 = q1(env, `SELECT row_json FROM calc_contract_rows WHERE row_key = 'C1#1'`).row_json;
  const rr = JSON.parse(r0); rr[3] = '自由に書いた担当名';
  d.prepare(`UPDATE calc_contract_rows SET row_json = ? WHERE row_key = 'C1#1'`).run(JSON.stringify(rr));
  const e = await call('U_C1', 'c_myKarte', {});
  ok('3-4 ★担当が名簿に当たらなければ null（行の文字をそのまま出さない）', e.contract && e.contract.trainerName === null && !JSON.stringify(e).includes('自由に書いた'), JSON.stringify(e.contract));
  d.prepare(`UPDATE calc_contract_rows SET row_json = ? WHERE row_key = 'C1#1'`).run(r0);
}

// ================= 4. includeContract=false は契約の SQL を1本も出さない（改訂2-3） =================
{
  env._log = [];
  await buildMemberKarte(env, 'C1', { includeContract: false, includeIds: false });
  const bad = env._log.filter((q) => /calc_contract_rows|calc_meta|sync_state|FROM trainers/.test(q));
  ok('4-1 ★includeContract=false：calc_contract_rows・calc_meta・sync_state・担当名の問い合わせが無い', bad.length === 0, bad.join('\n'));
  env._log = [];
  await buildMemberKarte(env, 'C1', { includeContract: true });
  ok('4-2 （記録が効いている証拠）true なら契約の SQL が走る', env._log.some((q) => /calc_contract_rows/.test(q)) && env._log.some((q) => /sync_state/.test(q)));
  env._log = [];
  await buildMemberKarte(env, 'C1', {});
  ok('4-3 opts を省くと契約は読まない（既定は読まない側）', !env._log.some((q) => /calc_contract_rows/.test(q)));
}

// ================= 5. ソースの検査（I-M3・I-M7） =================
{
  const SRC = readFileSync(join(W, 'src/lib/member-karte.js'), 'utf8');
  const FORBID = ['karte_notes', 'karte_safety', 'karte_consent', 'pain', 'diagnosis', 'next_plan', 'next_check', 'reasons_json',
                  'price', 'amount', 'reward', 'medication', 'injuries', 'restrictions', 'conditions', 'phone', 'email', 'line_user_id', 'goal_text', 'motive'];
  const hit = FORBID.filter((w) => SRC.includes(w));
  ok('5-1 ★buildMemberKarte のソースに禁止の表名・列名が無い', hit.length === 0, hit.join(','));
  ok('5-2 ★セットのメモの列（note）を読まない', !/\bnote\b/.test(SRC));
  ok('5-3 全部の列を取る書き方（SELECT *・t.*）が無い', !/SELECT\s+\*|\w\.\*/.test(SRC));
  const hj = SRC.match(/hearing_json/g) || [];
  ok('5-4 ★ヒアリングは json_extract の目標体重だけ', hj.length === 1 && /json_extract\(hearing_json, '\$\.targetWeight'\)/.test(SRC));
  ok('5-5 契約の判定は I53 の関数をそのまま使う（45分を書き直さない）', /import \{ readCalcInputStatus \} from '\.\/remain-read-on\.js'/.test(SRC) && !/45 \* 60/.test(SRC));
  const RT = readFileSync(join(W, 'src/routes/member-karte.js'), 'utf8');
  const KA = readFileSync(join(W, 'src/routes/karte.js'), 'utf8');
  const pvSrc = KA.slice(KA.indexOf('async function memberPreview'), KA.indexOf('async function mnoteRow'));
  ok('5-6 ★本人と見え方は同じ組み立て関数を通る（配線）', /buildMemberKarte\(env, cid, \{ includeContract: true, includeIds: false \}\)/.test(RT)
     && /buildMemberKarte\(c\.env, cid, \{ includeContract: contractAllowed === true, includeIds: true/.test(pvSrc));
  ok('5-7 ★c_myKarte の窓口は body を読まない', !/body/.test(RT.slice(RT.indexOf('export async function compatMyKarte'))));
}

// ================= 6. お客様の見え方（k_memberPreview） =================
{
  const p2 = await call('U_T2', 'k_memberPreview', { customerId: 'C1' });
  ok('6-1 担当外のトレーナーも見え方を開ける（共有の範囲）・契約は null', p2.status === 200 && p2.contract === null && p2.training.sessions.length === 2, JSON.stringify(p2).slice(0, 200));
  const p1 = await call('U_T1', 'k_memberPreview', { customerId: 'C1' });
  ok('6-2 担当は契約も見える', p1.status === 200 && p1.contract && p1.contract.tickets === 8);
  const n = p1.notes.find((x) => x.date === dayOffset(-7));
  ok('6-3 見え方の notes には mnoteId・rev・sessionId・authorIsMe', n && n.mnoteId === tr1.mnoteId && n.rev === 1 && n.sessionId === tr1.sessionId && n.authorIsMe === true, JSON.stringify(n));
  ok('6-4 担当外から見ると authorIsMe=false', p2.notes.find((x) => x.date === dayOffset(-7)).authorIsMe === false);
  ok('6-4b ★見え方の notes にはその枚のタグ（直す画面で日付から推測させない・Codex 関門②）', Array.isArray(n.tags));
  const me0 = await call('U_C1', 'c_myKarte', {});
  ok('6-4c 会員本人の notes にはタグも ID も載せない', me0.notes.every((x) => !('tags' in x) && !('mnoteId' in x) && !('sessionId' in x)));
  const strip = (o) => JSON.parse(JSON.stringify({ goal: o.goal, body: o.body, training: o.training, contract: o.contract,
    notes: o.notes.map((x) => ({ date: x.date, message: x.message, todo: x.todo, trainerName: x.trainerName })) }));
  const me = await call('U_C1', 'c_myKarte', {});
  ok('6-5 ★見え方（ID を除く）と会員本人の応答が一致する', JSON.stringify(strip(p1)) === JSON.stringify(strip(me)));
  ok('6-6 見え方にも社内メモ・健康情報・金額が無い', SECRETS.filter((x) => x !== 'C2専用' && x !== '88.8').every((x) => !JSON.stringify(p1).includes(x)));
  const nf = await call('U_T1', 'k_memberPreview', { customerId: 'NOPE' });
  ok('6-7 存在しない顧客は 403', nf.status === 403);
  ok('6-8 見え方を開いた記録が残る', qn(env, `SELECT COUNT(*) n FROM karte_access_log WHERE action = 'k_memberPreview' AND result = 'ok'`) >= 2);
}

// ================= 7. k_addTraining の member（正規化・冪等の4組・改訂2-5） =================
{
  clearRate();
  const base = { customerId: 'C1', sessionDate: dayOffset(-1), items: [{ exercise: 'デッドリフト', sets: [{ weight: 60, reps: 5 }] }] };
  const M = { message: '腰を立てて', todo: ['ストレッチ'], tags: ['背中'] };
  const k1 = crid();
  const a = await call('U_T1', 'k_addTraining', { ...base, member: M, clientReqId: k1 });
  const a2 = await call('U_T1', 'k_addTraining', { ...base, member: { message: '  腰を立てて ', todo: ['ストレッチ', ''], tags: ['背中'] }, clientReqId: k1 });
  ok('7-1 ★あり→同じ内容（正規化後）の再送＝同じ sessionId・mnoteId', a.status === 200 && a2.status === 200 && a2.replayed && a2.sessionId === a.sessionId && a2.mnoteId === a.mnoteId
     && qn(env, `SELECT COUNT(*) n FROM karte_member_notes WHERE session_id = ?`, a.sessionId) === 1, JSON.stringify([a, a2]));
  const a3 = await call('U_T1', 'k_addTraining', { ...base, clientReqId: k1 });
  ok('7-2 ★あり→なし＝REQ_REUSED', a3.status === 409 && a3.code === 'REQ_REUSED');
  const k2 = crid();
  const b = await call('U_T1', 'k_addTraining', { ...base, clientReqId: k2 });
  const b2 = await call('U_T1', 'k_addTraining', { ...base, member: M, clientReqId: k2 });
  ok('7-3 ★なし→あり＝REQ_REUSED（後から足さない）', b.status === 200 && b2.status === 409 && b2.code === 'REQ_REUSED'
     && qn(env, `SELECT COUNT(*) n FROM karte_member_notes WHERE session_id = ?`, b.sessionId) === 0);
  const a4 = await call('U_T1', 'k_addTraining', { ...base, member: { ...M, todo: ['別の宿題'] }, clientReqId: k1 });
  const a5 = await call('U_T1', 'k_addTraining', { ...base, member: { ...M, tags: ['脚'] }, clientReqId: k1 });
  ok('7-4 ★todo・tags だけの変更＝REQ_REUSED', a4.status === 409 && a4.code === 'REQ_REUSED' && a5.status === 409 && a5.code === 'REQ_REUSED');
  const k3 = crid();
  const c = await call('U_T1', 'k_addTraining', { ...base, clientReqId: k3 });
  const c2 = await call('U_T1', 'k_addTraining', { ...base, member: { message: '   ', todo: [], tags: [''] }, clientReqId: k3 });
  ok('7-5 中身が全部空の member は「無い」と同じ（同じ鍵の再送が通る・枚は作らない）', c2.status === 200 && c2.replayed && c2.sessionId === c.sessionId
     && qn(env, `SELECT COUNT(*) n FROM karte_member_notes WHERE session_id = ?`, c.sessionId) === 0);
  const before = qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions`);
  const badCases = [
    { message: 'あ'.repeat(401) }, { todo: ['a', 'b', 'c', 'd'] }, { todo: ['あ'.repeat(61)] }, { tags: ['1', '2', '3', '4', '5', '6', '7'] },
    { tags: ['あ'.repeat(13)] }, { todo: 'ひとつ' }, { todo: [3] }, { message: 5 }, { extra: 'x' }, ['x'], 'x',
  ];
  let allBad = true, which = '';
  for (const bc of badCases) {
    const r = await call('U_T1', 'k_addTraining', { ...base, member: bc, clientReqId: crid() });
    if (r.status !== 400) { allBad = false; which = JSON.stringify(bc).slice(0, 60) + ' → ' + r.status; break; }
  }
  ok('7-6 ★上限超え・型違い・知らない鍵は 400', allBad, which);
  ok('7-7 400 のときトレーニングも書かれない（全部か無か）', qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions`) === before);
  const edge = normalizeMember({ message: 'あ'.repeat(400), todo: ['い'.repeat(60), 'b', 'c'], tags: ['う'.repeat(12), '2', '3', '4', '5', '6'] });
  ok('7-8 ちょうど上限は通る', edge && JSON.parse(edge.todo_json).length === 3 && JSON.parse(edge.tags_json).length === 6);
  ok('7-9 正規化：無い→null・空→null', normalizeMember(null) === null && normalizeMember({}) === null && normalizeMember({ message: '' }) === null);
}

// ================= 8. k_saveMemberNote の3つの形と 400（改訂3-1） =================
let dayNote, addNote;
{
  clearRate();
  const before = () => qn(env, `SELECT COUNT(*) n FROM karte_member_notes`);
  const n0 = before();
  const shapes = [
    ['rev が無い', { customerId: 'C1', sessionDate: today, message: 'x' }],
    ['rev が負', { rev: -1, customerId: 'C1', sessionDate: today, message: 'x' }],
    ['rev が文字', { rev: '0', customerId: 'C1', sessionDate: today, message: 'x' }],
    ['新規で mnoteId', { rev: 0, mnoteId: 'm', customerId: 'C1', sessionDate: today, message: 'x' }],
    ['新規で sessionId と customerId の両方', { rev: 0, sessionId: tr2.sessionId, customerId: 'C1', message: 'x' }],
    ['新規でどちらも無い', { rev: 0, sessionDate: today, message: 'x' }],
    ['既存の session への追加で sessionDate', { rev: 0, sessionId: tr2.sessionId, sessionDate: dayOffset(-2), message: 'x' }],
    ['トレーニングなしで sessionDate が無い', { rev: 0, customerId: 'C1', message: 'x' }],
    ['トレーニングなしで未来の日付', { rev: 0, customerId: 'C1', sessionDate: dayOffset(2), message: 'x' }],
    ['中身が空', { rev: 0, customerId: 'C1', sessionDate: today, message: '  ' }],
    ['中身の鍵が無い', { rev: 0, customerId: 'C1', sessionDate: today }],
    ['編集で mnoteId が無い', { rev: 1, message: 'x' }],
    ['編集で sessionId', { rev: 1, mnoteId: tr1.mnoteId, sessionId: tr1.sessionId, message: 'x' }],
    ['編集で customerId', { rev: 1, mnoteId: tr1.mnoteId, customerId: 'C1', message: 'x' }],
    ['編集で sessionDate', { rev: 1, mnoteId: tr1.mnoteId, sessionDate: today, message: 'x' }],
  ];
  for (const [name, body] of shapes) {
    const r = await call('U_T1', 'k_saveMemberNote', { ...body, clientReqId: crid() });
    ok(`8-0 ★曖昧な形は 400：${name}`, r.status === 400, JSON.stringify(r));
  }
  ok('8-0b 400 のとき行は作られない', before() === n0);
  ok('8-0c 400 のとき既存の枚は変わらない', q1(env, `SELECT rev, message FROM karte_member_notes WHERE mnote_id = ?`, tr1.mnoteId).rev === 1);

  //   ① トレーニングなし
  const a = await call('U_T2', 'k_saveMemberNote', { rev: 0, customerId: 'C1', sessionDate: dayOffset(-3), message: '食事を記録しましょう', todo: ['朝食の写真'], clientReqId: crid() });
  dayNote = a.mnoteId;
  const row = q1(env, `SELECT customer_id, session_id, session_date, author_trainer_id FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId);
  ok('8-1 ① トレーニングなしの枚（session_id=NULL・作成者は送ったトレーナー）', a.status === 200 && a.rev === 1 && row.session_id === null && row.customer_id === 'C1'
     && row.session_date === dayOffset(-3) && row.author_trainer_id === 'T2', JSON.stringify([a, row]));
  const nf = await call('U_T1', 'k_saveMemberNote', { rev: 0, customerId: 'NOPE', sessionDate: today, message: 'x', clientReqId: crid() });
  ok('8-2 ① 存在しない顧客は 404', nf.status === 404);
  const n8 = qn(env, `SELECT COUNT(*) n FROM karte_member_notes`);
  const tg = await call('U_T1', 'k_saveMemberNote', { rev: 0, customerId: 'C1', sessionDate: today, tags: ['胸'], clientReqId: crid() });
  ok('8-2b ★トレーニングの無い枚はタグだけでは作れない（会員のどこにも出ない）＝400・行は作られない', tg.status === 400 && tg.code === 'BAD_REQUEST' && qn(env, `SELECT COUNT(*) n FROM karte_member_notes`) === n8, JSON.stringify(tg));
  const tg2 = await call('U_T2', 'k_saveMemberNote', { rev: 1, mnoteId: a.mnoteId, message: '', todo: [], tags: ['胸'], clientReqId: crid() });
  ok('8-2c ★トレーニングの無い枚を、編集でタグだけにはできない（409・中身は変わらない）', tg2.status === 409 && q1(env, `SELECT message, rev FROM karte_member_notes WHERE mnote_id = ?`, a.mnoteId).rev === 1, JSON.stringify(tg2));

  //   ② 既存のトレーニング（member なしで作った session）に後から1枚
  const b = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: tr2.sessionId, message: 'フォームが安定', tags: ['脚'], clientReqId: crid() });
  addNote = b.mnoteId;
  const brow = q1(env, `SELECT customer_id, session_date FROM karte_member_notes WHERE mnote_id = ?`, b.mnoteId);
  ok('8-3 ② member なしで作った session に後から足せる・顧客と日付は session から', b.status === 200 && brow.customer_id === 'C1' && brow.session_date === dayOffset(-2), JSON.stringify([b, brow]));
  const b2 = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: tr2.sessionId, message: '二枚目', clientReqId: crid() });
  ok('8-4 ② 生きた枚がある session への新規は 409', b2.status === 409 && b2.code === 'CONFLICT');
  const b3 = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: 'no-such-session', message: 'x', clientReqId: crid() });
  ok('8-5 ② session が無ければ 404', b3.status === 404);
  const tags = await call('U_C1', 'c_myKarte', {});
  const s2d = tags.training.sessions.find((x) => x.date === dayOffset(-2));
  ok('8-6 後から足した枚のタグがその日のトレーニングに出る', s2d && JSON.stringify(s2d.tags) === '["脚"]', JSON.stringify(s2d));

  //   ③ 編集
  const e1 = await call('U_T2', 'k_saveMemberNote', { rev: 1, mnoteId: tr1.mnoteId, message: '他人が直す', clientReqId: crid() });
  ok('8-7 ③ 書いた本人以外のトレーナーは編集できない', e1.status === 403 && e1.code === 'FORBIDDEN');
  const e2 = await call('U_T1', 'k_saveMemberNote', { rev: 1, mnoteId: tr1.mnoteId, message: '直しました', clientReqId: crid() });
  const er = q1(env, `SELECT message, todo_json, tags_json, rev FROM karte_member_notes WHERE mnote_id = ?`, tr1.mnoteId);
  ok('8-8 ③ 本人は編集できる・鍵の無い項目（todo・tags）はそのまま', e2.status === 200 && e2.rev === 2 && er.message === '直しました' && er.todo_json === '["水を2L"]' && er.tags_json === '["脚","全身"]', JSON.stringify(er));
  const e3 = await call('U_T1', 'k_saveMemberNote', { rev: 1, mnoteId: tr1.mnoteId, message: '古い rev', clientReqId: crid() });
  ok('8-9 ③ 古い rev は 409', e3.status === 409 && e3.code === 'CONFLICT');
  const e4 = await call('U_OWN', 'k_saveMemberNote', { rev: 2, mnoteId: tr1.mnoteId, todo: ['水を2L', '早寝'], clientReqId: crid() });
  const ol = q1(env, `SELECT section, action FROM karte_access_log WHERE action = 'k_saveMemberNote' ORDER BY id DESC LIMIT 1`);
  ok('8-10 ③ owner は他人の枚を直せる・記録は section=member_note_owner_override・action は操作名', e4.status === 200 && e4.rev === 3
     && ol.section === 'member_note_owner_override' && ol.action === 'k_saveMemberNote', JSON.stringify([e4, ol]));
  const e5 = await call('U_T1', 'k_saveMemberNote', { rev: 3, mnoteId: tr1.mnoteId, message: null, todo: [], tags: null, clientReqId: crid() });
  ok('8-11 ③ 編集で全部空にはできない（409・中身は変わらない）', e5.status === 409 && q1(env, `SELECT rev FROM karte_member_notes WHERE mnote_id = ?`, tr1.mnoteId).rev === 3, JSON.stringify(e5));
  const e5b = await call('U_T1', 'k_saveMemberNote', { rev: 3, mnoteId: tr1.mnoteId, message: null, clientReqId: crid() });
  const r5b = q1(env, `SELECT message, todo_json, rev FROM karte_member_notes WHERE mnote_id = ?`, tr1.mnoteId);
  ok('8-11b ③ 1項目だけ消せる（message だけ null・宿題は残る）', e5b.status === 200 && r5b.message === null && r5b.todo_json === '["水を2L","早寝"]' && r5b.rev === 4, JSON.stringify([e5b, r5b]));
  const k = crid();
  const e6 = await call('U_T1', 'k_saveMemberNote', { rev: 4, mnoteId: tr1.mnoteId, message: '再送の確認', clientReqId: k });
  const e7 = await call('U_T1', 'k_saveMemberNote', { rev: 4, mnoteId: tr1.mnoteId, message: '再送の確認', clientReqId: k });
  const e8 = await call('U_T1', 'k_saveMemberNote', { rev: 4, mnoteId: tr1.mnoteId, message: '中身が違う', clientReqId: k });
  ok('8-12 ③ 同じ鍵・同じ中身の再送は保存した結果／中身が違えば REQ_REUSED', e6.rev === 5 && e7.replayed && e7.rev === 5 && e8.status === 409 && e8.code === 'REQ_REUSED', JSON.stringify([e6, e7, e8]));
}

// ================= 9. 一致の見張り（改訂2-4）：別の顧客や日付の違う session は書けない =================
{
  clearRate();
  const s0 = qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions`);
  const m0 = qn(env, `SELECT COUNT(*) n FROM karte_member_notes`);
  //   枚を書く文の値だけを差し替えて、見張りが batch 全体を戻すかを確かめる（身代わりで本物の SQL に当てる）
  for (const [name, idx, val] of [['顧客', 1, 'C2'], ['日付', 3, dayOffset(-9)]]) {
    env._hook = (q, args) => (/INSERT INTO karte_member_notes/.test(q) ? args.map((x, i) => (i === idx ? val : x)) : null);
    const r = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: dayOffset(-4), clientReqId: crid(),
      items: [{ exercise: 'x', sets: [{ weight: 1, reps: 1 }] }], member: { message: 'ずらした' } });
    env._hook = null;
    ok(`9-1 ★枚の${name}が session と違えば 404 で batch 全体が戻る（トレーニングも残らない）`, r.status === 404
       && qn(env, `SELECT COUNT(*) n FROM karte_tr_sessions`) === s0 && qn(env, `SELECT COUNT(*) n FROM karte_member_notes`) === m0, JSON.stringify(r));
  }
  //   別の顧客の session（担当外のトレーナーでも共有の範囲で見えるが、顧客は session から引く＝C2 の枚になる）
  const x = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: tr3.sessionId, message: 'C1 に付けたつもり', clientReqId: crid() });
  ok('9-2 ② 他の顧客の session（生きた枚あり）は 409・C1 に枚はできない', x.status === 409
     && !q1(env, `SELECT 1 x FROM karte_member_notes WHERE customer_id = 'C1' AND message = 'C1 に付けたつもり'`));
}

// ================= 10. 削除の連動と作り直し（改訂2-1・3-1） =================
{
  clearRate();
  const d1 = await call('U_T2', 'k_deleteMemberNote', { mnoteId: addNote, rev: 1, clientReqId: crid() });
  ok('10-1 書いた本人以外は消せない', d1.status === 403);
  const d0 = await call('U_T1', 'k_deleteMemberNote', { mnoteId: addNote, clientReqId: crid() });
  ok('10-2 rev が無ければ 400', d0.status === 400);
  const d2 = await call('U_T1', 'k_deleteMemberNote', { mnoteId: addNote, rev: 1, clientReqId: crid() });
  ok('10-3 本人は消せる（論理削除）', d2.status === 200 && d2.deleted && q1(env, `SELECT deleted_at FROM karte_member_notes WHERE mnote_id = ?`, addNote).deleted_at > 0);
  const re = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: tr2.sessionId, message: '作り直し', clientReqId: crid() });
  ok('10-4 ★枚を消した後、同じ session に新しい reqId で作り直せる', re.status === 200 && re.mnoteId && re.mnoteId !== addNote, JSON.stringify(re));
  const od = await call('U_OWN', 'k_deleteMemberNote', { mnoteId: dayNote, rev: 1, clientReqId: crid() });
  const ol = q1(env, `SELECT section, action FROM karte_access_log WHERE action = 'k_deleteMemberNote' ORDER BY id DESC LIMIT 1`);
  ok('10-5 owner は他人の枚を消せる・section=member_note_owner_override', od.status === 200 && ol.section === 'member_note_owner_override');
  const me = await call('U_C1', 'c_myKarte', {});
  ok('10-6 消した枚は会員に出ない', !JSON.stringify(me).includes('食事を記録しましょう') && JSON.stringify(me).includes('作り直し'));

  //   トレーニングを消すと同じ session の枚も消える
  const t = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: dayOffset(-6), clientReqId: crid(),
    items: [{ exercise: 'ランジ', sets: [{ weight: 10, reps: 10 }] }], member: { message: '消える枚' } });
  //   ★片方を失敗させると batch 全体が戻る（トレーニングも消えない）
  env._hook = (q) => { if (/UPDATE karte_member_notes SET deleted_at/.test(q)) throw new Error('injected'); return null; };
  const f = await call('U_T1', 'k_deleteTraining', { sessionId: t.sessionId, rev: 1, clientReqId: crid() });
  env._hook = null;
  ok('10-7 ★枚の削除が失敗すると、トレーニングの削除も戻る', f.status === 500
     && q1(env, `SELECT deleted_at FROM karte_tr_sessions WHERE session_id = ?`, t.sessionId).deleted_at === null
     && q1(env, `SELECT deleted_at FROM karte_member_notes WHERE mnote_id = ?`, t.mnoteId).deleted_at === null);
  const g = await call('U_T1', 'k_deleteTraining', { sessionId: t.sessionId, rev: 1, clientReqId: crid() });
  ok('10-8 ★トレーニングの削除で同じ session の生きた枚も同じ batch で消える', g.status === 200
     && q1(env, `SELECT deleted_at FROM karte_tr_sessions WHERE session_id = ?`, t.sessionId).deleted_at > 0
     && q1(env, `SELECT deleted_at, rev FROM karte_member_notes WHERE mnote_id = ?`, t.mnoteId).deleted_at > 0);
  const gone = await call('U_T1', 'k_saveMemberNote', { rev: 0, sessionId: t.sessionId, message: '消えた session', clientReqId: crid() });
  ok('10-9 消えた session への新規は 404', gone.status === 404);
  //   ★二重の守り：消し忘れ（session だけ消えて枚が生きている）でも会員に出ない
  const t2 = await call('U_T1', 'k_addTraining', { customerId: 'C1', sessionDate: dayOffset(-8), clientReqId: crid(),
    items: [{ exercise: 'プランク', sets: [{ weight: 0, reps: 1 }] }], member: { message: '消し忘れの枚' } });
  d.prepare(`UPDATE karte_tr_sessions SET deleted_at = 1 WHERE session_id = ?`).run(t2.sessionId);
  const me2 = await call('U_C1', 'c_myKarte', {});
  ok('10-10 ★session が消えた枚は、枚が生きていても会員に出ない（JOIN の守り）', !JSON.stringify(me2).includes('消し忘れの枚') && !JSON.stringify(me2).includes('プランク'));
}

// ================= 11. 表の制約（本物の SQLite・0027） =================
{
  const ins = d.prepare(`INSERT INTO karte_member_notes (mnote_id, customer_id, session_id, session_date, message, todo_json, tags_json, author_trainer_id, created_at, updated_at, deleted_at)
                         VALUES (?, 'C2', ?, ?, ?, ?, ?, 'T2', 1, 1, ?)`);
  const throws = (fn) => { try { fn(); return false; } catch (_) { return true; } };
  const sd = q1(env, `SELECT session_date FROM karte_tr_sessions WHERE session_id = ?`, tr3.sessionId).session_date;
  ok('11-1 ★部分 UNIQUE：同じ session に生きた枚は2枚入らない', throws(() => ins.run('dupA', tr3.sessionId, sd, 'x', null, null, null)));
  ok('11-2 消した枚は数えない（消した枚は何枚でも残せる）', !throws(() => ins.run('dupB', tr3.sessionId, sd, 'x', null, null, 5)) && !throws(() => ins.run('dupC', tr3.sessionId, sd, 'x', null, null, 6)));
  ok('11-3 session の無い枚は同じ日に何枚でも', !throws(() => ins.run('nsA', null, today, 'x', null, null, null)) && !throws(() => ins.run('nsB', null, today, 'y', null, null, null)));
  ok('11-4 CHECK：401字は入らない', throws(() => ins.run('c1', null, today, 'あ'.repeat(401), null, null, null)));
  ok('11-5 CHECK：空文字は入らない（空は NULL）', throws(() => ins.run('c2', null, today, '', null, null, null)));
  ok('11-6 CHECK：todo は配列で1〜3件', throws(() => ins.run('c3', null, today, null, '["a","b","c","d"]', null, null))
     && throws(() => ins.run('c4', null, today, null, '"a"', null, null)) && throws(() => ins.run('c5', null, today, null, '[]', null, null)));
  ok('11-7 CHECK：tags は配列で1〜6件', throws(() => ins.run('c6', null, today, null, null, '["1","2","3","4","5","6","7"]', null)));
  ok('11-8 外部キー：無い session は参照できない', throws(() => ins.run('fk1', 'no-such', today, 'x', null, null, null)));
  const cols = d.prepare(`SELECT name FROM pragma_table_info('karte_member_notes')`).all().map((x) => x.name);
  ok('11-9 req_id 列は持たない（冪等の正本は karte_requests）', !cols.includes('req_id'));
  const trg = d.prepare(`SELECT COUNT(*) n FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'karte_member_notes'`).get().n;
  ok('11-10 トリガーを足していない（トリガーは引当の4本だけ）', trg === 0);
}

// ================= 12. 起動の印（compatMemberStatus・c_boot） =================
{
  d.prepare(`INSERT INTO member_home (customer_id, payload, computed_at) VALUES ('C1', ?, ?)`)
    .run(JSON.stringify({ currentMonth: today.slice(0, 7), current: { type: null } }), Date.now());
  env.MEMBER_KARTE = 'on';
  const on = await call('U_C1', 'c_memberStatus', {});
  ok('12-1 MEMBER_KARTE=on で memberKarte=true（真偽値）', on.status === 200 && on.memberKarte === true, JSON.stringify(on).slice(0, 200));
  env.MEMBER_KARTE = 'off';
  const off = await call('U_C1', 'c_memberStatus', {});
  ok('12-2 off で memberKarte=false（真偽値）', off.memberKarte === false);
  env.MEMBER_KARTE = 'on';
  const boot = await call('U_C1', 'c_boot', {});
  ok('12-3 c_boot の memberStatus にもそのまま乗る', boot.status === 200 && boot.parts && boot.parts.memberStatus && boot.parts.memberStatus.memberKarte === true, JSON.stringify(boot).slice(0, 200));
  const COMPAT = readFileSync(join(W, 'src/routes/compat.js'), 'utf8');
  ok('12-4 印は D1 を読まずに env だけで決める', /memberKarte: String\(\(env && env\.MEMBER_KARTE\) \|\| ''\) === 'on'/.test(COMPAT));
}

// ================= 13. 設定と地図 =================
{
  const TOML = readFileSync(join(W, 'wrangler.toml'), 'utf8');
  const vars = TOML.slice(TOML.indexOf('[vars]'), TOML.indexOf('[[d1_databases]]'));
  ok('13-1 wrangler.toml の [vars] に MEMBER_KARTE = "off"（既定は止める側）', /^MEMBER_KARTE = "off"$/m.test(vars));
  const DOC = readFileSync(join(ROOT, 'ops/MODEL.md'), 'utf8');
  const rows = DOC.split('\n').filter((l) => /^\| I-M\d \|/.test(l));
  ok('13-2 地図の §3 に I-M1〜I-M8', rows.length === 8 && [1, 2, 3, 4, 5, 6, 7, 8].every((i) => rows.some((l) => l.startsWith(`| I-M${i} |`))), rows.length + '件');
  const have = new Set(readdirSync(HERE));
  const bad = rows.filter((l) => {
    const files = (l.match(/`([a-z0-9-]+\.test\.js)`/g) || []).map((x) => x.replace(/`/g, ''));
    return !files.length || files.some((f) => !have.has(f));
  });
  ok('13-3 ★I-M の各行に守る検査が紐付き、そのファイルが実在する', bad.length === 0, bad.map((l) => l.slice(0, 12)).join(' / '));
  ok('13-4 地図の §2 に karte_member_notes・§6 に c_myKarte', /\| `karte_member_notes` \|/.test(DOC) && /\| `c_myKarte`/.test(DOC));
}

// ================= 14. 契約は行の全体を読まない（改訂1-8・Codex 関門②） =================
{
  env.MEMBER_KARTE = 'on';
  env._log = [];
  const r = await call('U_C1', 'c_myKarte', {});
  const qs = env._log.filter((q) => /FROM\s+calc_contract_rows/.test(q));
  ok('14-1 ★契約の SQL は row_json の全体を SELECT しない（必要な列だけ json_extract）', r.status === 200 && qs.length >= 1 && qs.every((q) => /json_extract\(row_json/.test(q) && !/row_json/.test(q.replace(/json_extract\(row_json/g, ''))), qs.join(' | ').slice(0, 300));
  ok('14-2 契約の中身はこれまでどおり返る', r.contract && r.contract.tickets === 8, JSON.stringify(r.contract));
}

console.log(`\n${fail ? '❌' : '✅'} 会員画面 C2（入口から） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
