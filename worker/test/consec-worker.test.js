// 連続ルール（設計18）：顧客が実際に使う窓口（Worker compatTrainerSlots）で、写しのモードどおりに絞るか。
//   実行: node worker/test/consec-worker.test.js
//
// ★入口（compatTrainerSlots）から通す。部品（consecPick）だけを見ても配線は守れない。
//
//   写しの consec        顧客に返すもの
//   on / version 1       consecOk === true だけ。真偽値でない枠が1つでも → _fallback（GASへ）
//   on で予約の変更       _fallback（写しは自分の旧予定を連続に数えたまま。GAS がその場で外して計算する）
//   off                  今のまま
//   無い（古い写し）       今のまま
//   知らない mode/version  _fallback
//   トレーナー・オーナー   いつも全部

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { compatTrainerSlots } from '../src/routes/compat.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`);
}

function cacheEnv(row) {
  return {
    DB: {
      prepare(q) {
        return { bind() { return this; }, async first() { return /slots_cache/.test(q) ? row : null; }, async all() { return { results: [] }; } };
      },
    },
  };
}
const H = 3600000;
const base = Date.now() + 3 * 24 * H;    // 3日後（締め切りに当たらない）
function slot(i, consecOk) {
  const st = base + i * H;
  const s = { startMs: st, startISO: new Date(st).toISOString(), endISO: new Date(st + H).toISOString(),
    date: 'd', dayOfWeek: '火', startTime: String(i), endTime: String(i + 1), trainerId: 't1', trainerName: '鈴木 一郎', trialOk: true };
  if (consecOk !== undefined) s.consecOk = consecOk;
  return s;
}
const rules = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };
const row = (slots, consec) => ({ payload: JSON.stringify(Object.assign({ trainerId: 't1', slots, rules, builtAt: Date.now() }, consec === undefined ? {} : { consec })), computed_at: Date.now() - 60000 });
const CUST = { role: 'customer', customerId: 'c1' };
const TR = { role: 'trainer', trainerId: 't1' };
const OWNER = { role: 'owner', trainerId: 't3' };
const call = (r, who, body = {}) => compatTrainerSlots({ env: cacheEnv(r), body: Object.assign({ trainerId: 't1' }, body), who });
const times = (res) => (res.slots || []).map((s) => s.startTime).join(',');

const mixed = [slot(0, true), slot(1, false), slot(2, true)];

console.log('=== 1. on の写し ===');
{
  const r = await call(row(mixed, { mode: 'on', version: 1 }), CUST);
  ok('1-1 ★顧客には consecOk === true の枠だけ', times(r) === '0,2', JSON.stringify(r));
  ok('1-2 返す形は変えない（consecOk を顧客に返さない）', (r.slots || []).every((s) => !('consecOk' in s)));
  const t = await call(row(mixed, { mode: 'on', version: 1 }), TR);
  ok('1-3 ★トレーナーには全部（代行で取れる）', times(t) === '0,1,2');
  const o = await call(row(mixed, { mode: 'on', version: 1 }), OWNER);
  ok('1-4 オーナーにも全部', times(o) === '0,1,2');
  const lost = await call(row([slot(0, true), slot(1), slot(2, true)], { mode: 'on', version: 1 }), CUST);
  ok('1-5 ★印の無い枠が1つでもあれば答えない（GASへ）', lost._fallback === true);
  const allLost = await call(row([slot(0), slot(1)], { mode: 'on', version: 1 }), CUST);
  ok('1-6 ★on なのに印が全部無い写しも答えない（全部見せない）', allLost._fallback === true);
  const str = await call(row([slot(0, 'true')], { mode: 'on', version: 1 }), CUST);
  ok('1-7 文字列の "true" は真偽値ではない＝答えない', str._fallback === true);
  const ch = await call(row(mixed, { mode: 'on', version: 1 }), CUST, { excludeStartISO: new Date(base).toISOString() });
  ok('1-8 ★予約の変更は答えない（GAS がその場で旧予定を外して計算する）', ch._fallback === true);
  const chTr = await call(row(mixed, { mode: 'on', version: 1 }), TR, { excludeStartISO: new Date(base).toISOString() });
  ok('1-9 トレーナーの変更は今のまま答える', chTr._fallback !== true && times(chTr) === '0,1,2');
  const empty = await call(row([], { mode: 'on', version: 1 }), CUST);
  ok('1-10 0件の on の写しは「0件」と答える', empty._fallback !== true && Array.isArray(empty.slots) && empty.slots.length === 0);
}

console.log('=== 2. off・古い写し・知らないもの ===');
{
  const plain = [slot(0), slot(1), slot(2)];
  const off = await call(row(plain, { mode: 'off', version: 1 }), CUST);
  ok('2-1 off は今のまま全部', times(off) === '0,1,2');
  const old = await call(row(plain), CUST);
  ok('2-2 consec の無い古い写しは今のまま', times(old) === '0,1,2');
  const v2 = await call(row(mixed, { mode: 'on', version: 2 }), CUST);
  ok('2-3 知らない版は答えない', v2._fallback === true);
  const dry = await call(row(plain, { mode: 'dry', version: 1 }), CUST);
  ok('2-4 知らないモード（写しに dry は書かない）は答えない', dry._fallback === true);
  const arr = await call(row(plain, ['on']), CUST);
  ok('2-5 consec が配列なら壊れた写しとして無視（今のまま）', times(arr) === '0,1,2');
}

console.log('=== 3. GAS 側の写しの作り方（_edgeConsecModeFor）===');
{
  const PE = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  const fn = PE.match(/function _edgeConsecModeFor\([^)]*\) \{[\s\S]*?\n\}/)[0];
  const f = new Function(fn + '; return _edgeConsecModeFor;')();
  const m = (srcBool, srcNone, outBool, outNone, sw) => { try { return f({ srcBool, srcNone, outBool, outNone }, sw).mode; } catch (e) { return 'STOP'; } };
  ok('3-1 全部印つき → on（スイッチが off に変わっていても枠に合わせる）', m(5, 0, 5, 0, 'off') === 'on');
  ok('3-2 印なし＋スイッチ off/dry → off', m(0, 5, 0, 5, 'off') === 'off' && m(0, 5, 0, 5, 'dry') === 'off');
  ok('3-3 ★印なし＋スイッチ on → 送らない（切り替え直後か取りこぼしか分からない）', m(0, 5, 0, 5, 'on') === 'STOP');
  ok('3-4 ★混ざっている（1人分だけ落ちた等）→ 送らない', m(3, 2, 3, 2, 'on') === 'STOP' && m(3, 2, 3, 2, 'off') === 'STOP');
  ok('3-5 ★変換で印が落ちた → 送らない', m(5, 0, 4, 1, 'on') === 'STOP');
  ok('3-6 0件はスイッチの値', m(0, 0, 0, 0, 'on') === 'on' && m(0, 0, 0, 0, 'off') === 'off');
  ok('3-7 写しを作る処理が _edgeConsecModeFor を通して payload に書く',
     /var consec = _edgeConsecModeFor\(cMark, /.test(PE) && /entries\[k\]\._payload\.consec = consec;/.test(PE));
  ok('3-8 ★写しへ送る処理は絞らない全部の枠を使う（顧客用に絞った枠を入れない）',
     /var r = _lbTrainerSlotsAll\(tid\);/.test(PE) && !/getTrainerSlots\(\{ trainerId: tid \}\)/.test(PE));
}

console.log('=== 4. Worker①を本番に出すなら①にも判定がある（C10）===');
{
  const toml = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8');
  const calOn = /^\s*SLOTS_FROM_CALENDAR\s*=\s*"on"/m.test(toml);
  const calslots = readFileSync(join(ROOT, 'worker/src/lib/calslots.js'), 'utf8');
  ok('4-1 ★SLOTS_FROM_CALENDAR を on にするなら calslots に連続ルールが要る', !calOn || /consecOk/.test(calslots),
     '①は consec を持たないので、そのまま on にすると顧客にルールが効かなくなる');
}

console.log('');
console.log(`${fail ? '❌' : '✅'} 連続ルール（Worker の窓口） 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
