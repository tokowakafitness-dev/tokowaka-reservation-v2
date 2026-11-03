// GAS 側：体の記録を D1 へ（設計28 3-1）と、契約の入力の点検・2026-11-03
//   実行: node worker/test/gas-body-d1.test.js
//
//   本物の関数を gas/*.js から切り出し、外の世界（シート・ロック・UrlFetch・キャッシュ）だけ身代わりにする。
//   1. 切替フラグ 'sheet' なら今までどおりシート、'd1' なら Worker へ転送（失敗は成功と返さない）
//   2. postback の二度押しの印は、転送に失敗したら外す
//   3. 体脂肪率は known_weight_kg（D1 の答え→切り替え前のキャッシュ）を付けて送る
//   4. 切り替え：印から6分以上・ロックの中でフラグと凍結コピーと begin。begin に失敗したらフラグは sheet のまま
//   5. maDedupeBodyLog は実行禁止（何も消さない）
//   6. 契約の入力の点検：顧客IDが空の同名行・契約の同期の停止
//   7. 配線：日次点検・作業依頼 quotaBuild の引数・体の記録の GAS 側の範囲（全トレーナー）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MA = readFileSync(join(ROOT, 'gas/MealAi.js'), 'utf8');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');
const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }
function pluck(src, name) {
  const m = src.match(new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}'));
  if (!m) throw new Error('見つからない: ' + name);
  return m[0];
}
const MA_BODY_DEF = MA.match(/var MA_BODY = \{[\s\S]*?\n\};/)[0];

function world(opt = {}) {
  const props = { ...(opt.props || {}) };
  const calls = { fetch: [], sheetWrites: 0, lock: 0, unlocked: 0, released: [] };
  const cache = {};
  const ctx = {
    console, JSON, Math, Date, String, Number, Object, Array,
    PropertiesService: { getScriptProperties: () => ({ getProperty: (k) => (k in props ? props[k] : null), setProperty: (k, v) => { props[k] = String(v); } }) },
    LockService: { getScriptLock: () => ({ tryLock: () => { calls.lock++; return true; }, releaseLock: () => { calls.unlocked++; } }) },
    CacheService: { getScriptCache: () => ({ get: (k) => cache[k] || null, put: (k, v) => { cache[k] = v; }, remove: (k) => { delete cache[k]; calls.released.push(k); } }) },
    UrlFetchApp: { fetch: (url, o) => {
      const body = o && o.payload ? JSON.parse(o.payload) : null;
      calls.fetch.push({ url, body });
      const r = (opt.respond || (() => ({ ok: true })))(url, body);
      return { getResponseCode: () => (r && r._code) || 200, getContentText: () => JSON.stringify(r) };
    } },
    Utilities: { computeDigest: (a, s) => Array.from(Buffer.from(require_crypto().createHash('sha256').update(s).digest())),
                 DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 }, formatDate: (d, tz, f) => '20261103120000' },
    Logger: { log() {} },
    _edgeProp: (k) => ({ EDGE_URL: 'https://edge.example', EDGE_SECRET: 's' })[k],
    maToday_: () => '2026-11-03',
    maSnapGet_: () => opt.snap || {},
    maLogWeightSheet_: () => { calls.sheetWrites++; return { today: '2026-11-03', sheet: true }; },
    maLogFatSheet_: () => { calls.sheetWrites++; return 'シートに書いた'; },
    maSaveInBodySheet_: () => { calls.sheetWrites++; return { success: true, sheet: true }; },
    maOpenSs_: () => opt.ss,
    maDateStr_: (v) => String(v).slice(0, 10),
  };
  vm.createContext(ctx);
  vm.runInContext(MA_BODY_DEF + '\n' + ['maBodyTarget_', 'maBodyPost_', 'maBodyWithTarget_', 'maBodyLive_', 'maWeightReplyFromLive_',
    'maOnceRelease_', 'maLogWeight_', 'maLogFat_', 'maSaveInBody_', 'maSaveInBodyD1_', 'maAvg_', 'maHash_', 'maOnce_',
    'bodyArm', 'bodyCutover', 'maFreezeValues_', 'maDedupeBodyLog'].map((n) => pluck(MA, n)).join('\n'), ctx);
  return { ctx, props, calls, cache };
}
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
function require_crypto() { return require('node:crypto'); }

// ================= 1. 切替フラグ =================
{
  const w = world();
  const r = w.ctx.maLogWeight_('C1', 70, 'evt1:w');
  ok('1-1 フラグが無ければ（既定 sheet）シートに書き、Worker は呼ばない', r.sheet === true && w.calls.sheetWrites === 1 && !w.calls.fetch.length);
  ok('1-2 シートに書くときはロックの中', w.calls.lock === 1 && w.calls.unlocked === 1);
}
{
  const w = world({ props: { BODY_WRITE_TARGET: 'd1' }, respond: (url, b) => (/series/.test(url) ? { ok: true, rows: [{ d: '2026-11-01', w: 71 }], freezeId: 'fz1' } : { ok: true, result: { id: 9 } }) });
  const r = w.ctx.maLogWeight_('C1', 70, 'evt1:w');
  const wr = w.calls.fetch.find((f) => /\/body\/write$/.test(f.url));
  ok('1-3 d1 ならシートに書かず /body/write へ（webhookEventId を鍵に）', w.calls.sheetWrites === 0 && wr && wr.body.op === 'addWeight' && wr.body.clientReqId === 'evt1:w' && wr.body.weightKg === 70);
  ok('1-4 返信の材料は D1 の答えから（前回 71kg）', r.last && r.last.kg === 71 && r.today === '2026-11-03');
}
{
  const w = world({ props: { BODY_WRITE_TARGET: 'd1' }, respond: (url) => (/series/.test(url) ? { ok: true, rows: [] } : { ok: false, code: 'INTERNAL', _code: 500 }) });
  let threw = false; try { w.ctx.maLogWeight_('C1', 70, 'evt2:w'); } catch (e) { threw = /BODY_WRITE_FAILED/.test(e.message); }
  ok('1-5 ★転送に失敗したら成功と返さない（例外＝呼ぶ側が失敗の返信）', threw);
}
{
  const w = world({ props: { BODY_WRITE_TARGET: 'd1' }, respond: () => ({ ok: true, result: { id: 3 } }) });
  const r = w.ctx.maSaveInBody_({ name: '一郎' }, 'C1', { date: '2026-11-03', w: '70.5', pbf: '' });
  const wr = w.calls.fetch.find((f) => /\/body\/write$/.test(f.url));
  ok('1-6 古い画面の InBody も d1 なら Worker へ（シートに書かない）', r.success && w.calls.sheetWrites === 0 && wr.body.op === 'addInBody' && wr.body.values.weight_kg === 70.5 && /^ib:C1:2026-11-03:/.test(wr.body.clientReqId));
}

// ================= 2. postback の二度押しの印 =================
{
  //   postback の該当部分が「失敗したら印を外す」形になっていることを、本物のコードで確かめる
  const block = MA.slice(MA.indexOf("if (q.ma === 'w') {"), MA.indexOf("if (q.ma === 'askfat')"));
  ok('2-1 体重の postback：失敗したら maOnceRelease_ で印を外す', /catch \(eW\) \{ maOnceRelease_\(uid, 'w' \+ maToday_\(\) \+ kg\); throw eW; \}/.test(block));
  const blockF = MA.slice(MA.indexOf("if (q.ma === 'f') {"), MA.indexOf("if (q.ma === 'done')"));
  ok('2-2 体脂肪率の postback も同じ', /catch \(eF\) \{ maOnceRelease_\(uid, 'f' \+ maToday_\(\) \+ pct\); throw eF; \}/.test(blockF));
  const w = world();
  ok('2-3 印を付けたあと外せば、同じ操作が二度押しとして捨てられない',
     w.ctx.maOnce_('U1', 'k1') === true && w.ctx.maOnce_('U1', 'k1') === false && (w.ctx.maOnceRelease_('U1', 'k1'), w.ctx.maOnce_('U1', 'k1') === true));
}

// ================= 3. 体脂肪率 =================
{
  const w = world({ props: { BODY_WRITE_TARGET: 'd1' }, snap: { todayKg: 69.8 },
    respond: (url, b) => (/series/.test(url) ? { ok: true, rows: [{ d: '2026-11-02', w: 70, lean: 55 }] } : { ok: true, result: { weightKg: 69.8, fatPct: 20, leanKg: 55.8 } }) });
  const text = w.ctx.maLogFat_('C1', 20, 'evt3:f');
  const wr = w.calls.fetch.find((f) => /\/body\/write$/.test(f.url));
  ok('3-1 今日の体重が D1 に無ければ、切り替え前のキャッシュを known_weight_kg に', wr.body.op === 'addFat' && wr.body.knownWeightKg === 69.8 && wr.body.clientReqId === 'evt3:f');
  ok('3-2 返信に除脂肪と前回', /除脂肪量 55\.8kg（前回 55\.0kg）/.test(text), text);
}
{
  const w = world({ props: { BODY_WRITE_TARGET: 'd1' }, respond: (url) => (/series/.test(url) ? { ok: true, rows: [] } : { ok: false, code: 'NEED_WEIGHT_FIRST', _code: 404 }) });
  ok('3-3 体重が無ければ「先に体重を」', w.ctx.maLogFat_('C1', 20, 'evt4:f') === '先に体重を記録してください。');
}

// ================= 4. 切り替え =================
function fakeSs(failCopy) {
  const sheets = {};
  const mk = (name, rows) => ({ name, rows, getLastRow: () => rows.length + 1, getLastColumn: () => (rows[0] || []).length || 1,
    getRange: (r, c, n, w) => ({ getValues: () => rows.slice(r - 2, r - 2 + n).map((x) => x.slice(0, w)) }),
    copyTo: () => { const cp = mk('copy', rows.map((x) => x.slice())); return cp; }, setName(n) { this.name = n; sheets[n] = this; }, hideSheet() {} });
  sheets.body_log = mk('body_log', [['C1', '2026-11-01', 70, '', '', '', '', 'self', 'line', '', '']]);
  sheets.meal_goals = mk('meal_goals', []);
  sheets.goal_phases = mk('goal_phases', []);
  return { getSheetByName: (n) => sheets[n] || null, insertSheet: () => mk('new', []), _sheets: sheets };
}
{
  const w = world({ ss: fakeSs() });
  ok('4-1 印が無ければ切り替えない', /先に bodyArm/.test(w.ctx.bodyCutover()) && w.props.BODY_WRITE_TARGET === undefined);
  w.props.BODY_ARMED_AT = String(Date.now() - 60 * 1000);
  ok('4-2 印から6分以上たっていなければ切り替えない', /待つ必要/.test(w.ctx.bodyCutover()) && w.props.BODY_WRITE_TARGET === undefined);
}
{
  const w = world({ ss: fakeSs(), props: { BODY_ARMED_AT: String(Date.now() - 7 * 60 * 1000) }, respond: () => ({ ok: false, code: 'EXISTS', _code: 409 }) });
  const msg = w.ctx.bodyCutover();
  ok('4-3 ★begin に失敗したらフラグは sheet のまま', /フラグは sheet のまま/.test(msg) && w.props.BODY_WRITE_TARGET === undefined, msg);
}
{
  const ss = fakeSs();
  const w = world({ ss, props: { BODY_ARMED_AT: String(Date.now() - 7 * 60 * 1000) }, respond: () => ({ ok: true }) });
  const lockBefore = w.calls.lock;
  const msg = w.ctx.bodyCutover();
  const begin = w.calls.fetch.find((f) => f.body && f.body.op === 'begin');
  ok('4-4 切り替え：フラグ d1・凍結 ID・凍結用シート・begin（行数とハッシュ）', w.props.BODY_WRITE_TARGET === 'd1' && /^fz/.test(w.props.BODY_FREEZE_ID)
     && ss._sheets['body_log__freeze_' + w.props.BODY_FREEZE_ID] && begin && begin.body.counts.body_log === 1 && typeof begin.body.hashes.body_log === 'string', msg);
  ok('4-5 切り替えはロックの中', w.calls.lock === lockBefore + 1 && w.calls.unlocked >= 1);
  ok('4-6 二度目は何もしない', /既に切り替え済み/.test(w.ctx.bodyCutover()));
}

// ================= 5. 重複整理は実行禁止 =================
{
  const w = world({ ss: { getSheetByName: () => { throw new Error('シートに触った'); } } });
  ok('5-1 maDedupeBodyLog は何も消さない', /実行禁止/.test(w.ctx.maDedupeBodyLog()));
}

// ================= 6. 契約の入力の点検 =================
{
  const ctx = {
    console, JSON, Math, Date, String, Number,
    _edgeCustomers: () => [{ customer_id: 'C20260001234', name: '甲', phone: '090' }, { customer_id: 'C20260005678', name: '乙', phone: '080' }],
    _lbContractRowsAll: (name) => { const a = []; if (name === '乙') a.migrationGap = true; return a; },
    _lbPhoneByCustomerId: () => { throw new Error('名簿を人数分読み直している'); },
    _lbSheet: () => { throw new Error('名簿を2回読んでいる'); },
    _edgeProp: () => 'https://edge.example',
    UrlFetchApp: { fetch: () => ({ getContentText: () => JSON.stringify({ sync: [{ key: 'calcContracts', synced_at: Date.now() - 30 * 3600000 }] }) }) },
  };
  vm.createContext(ctx);
  vm.runInContext(pluck(PE, 'lbContractInputCheck'), ctx);
  const items = ctx.lbContractInputCheck();
  const gap = items.find((x) => x.key === 'contract_id_blank');
  const st = items.find((x) => x.key === 'contract_push_stalled');
  ok('6-1 顧客IDが空の同名行がある会員を high で出す（下4桁だけ）', gap && gap.severity === 'high' && gap.count === 1 && gap.detail.includes('*5678') && !gap.detail.includes('乙'), JSON.stringify(gap));
  ok('6-2 契約の同期が26時間を超えて止まっていれば high', st && st.severity === 'high' && /30時間/.test(st.detail), JSON.stringify(st));
}

// ================= 7. 配線 =================
ok('7-1 日次点検が契約の入力の点検を呼ぶ', /_step\('契約の入力'\);[\s\S]{0,600}lbContractInputCheck\(\)/.test(LB));
ok('7-2 作業依頼 quotaBuild の body 引数から切り替えの各段を呼ぶ', /if \(a0\.body\) \{[\s\S]{0,500}bodyArm\(\)[\s\S]{0,200}bodyCutover\(\)[\s\S]{0,100}bodyCopy\(\)[\s\S]{0,100}bodyVerify\(\)/.test(PE));
ok('7-3 InBody の読み書きは共有の照合（全トレーナー・名簿に無い顧客は止める）', /case 'line_maInBodyCard': \{[\s\S]{0,400}_lbTrainerMaySeeShared\(_pic, params\.customerId\)/.test(LB)
   && /case 'line_maSaveInBody': \{[\s\S]{0,400}_lbTrainerMaySeeShared\(_pis, params\.customerId\)/.test(LB));
ok('7-4 グラフのトレーナー経路も共有の照合', /_lbTrainerMaySeeShared\(tr, String\(params\.customerId\)\)/.test(MA) && !/_lbTrainerMaySeeCustomer\(tr, _lbCustOwnerOf/.test(MA));

console.log(`\n${fail ? '❌' : '✅'} GAS 体の記録を D1 へ 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
