// カレンダーの分類が GAS と D1 側で一致することの検証（① カレンダー→D1 のハーネス）
//
//   なぜこの形にするか：
//     同じ条件を2か所に書くと必ず食い違う。2026-10-02、体験予約だけが休憩・ブロックを
//     見落としており、トレーナーが塞いだ時間に予約が入っていた。原因は「同じ条件の書き写し」。
//     D1へ移すときは、GAS側とWorker側で**同じ入力に同じ答えを返すこと**を機械で検査する。
//     どちらかを直したらもう片方も直さないとテストが落ちる＝食い違ったまま進めない。
//
//   検査の作り：
//     GASのソース（gas/コード.js）から判定関数を取り出して Node で評価し、
//     Worker側（worker/src/lib/calclass.js）の答えと1件ずつ突き合わせる。
//     残数計算（Allocate.js）のドリフト検査と同じ考え方。
//
//   実行: node worker/test/calclass.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';
import {
  isShiftTitle, isBusyTitle, isSessionTitle, isConsumedTitle,
  classifyEvent, subtractIntervals, overlaps, findInvalidIntervals,
  CAL_ROLE, EV_KIND
} from '../src/lib/calclass.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const GAS = join(HERE, '../../gas');

let pass = 0, fail = 0;
function ok(name, cond) { if (cond) pass++; else { fail++; console.log('❌ ' + name); } }
function eq(name, got, want) {
  const G = JSON.stringify(got), W = JSON.stringify(want);
  if (G === W) pass++; else { fail++; console.log('❌ ' + name + '\n   got : ' + G + '\n   want: ' + W); }
}

// ------------------------------------------------------------
// GAS側の判定を取り出す（ソースから関数だけを抜いて評価する）
//   コード.js 全体は GAS の API に依存するので読み込めない。必要な関数だけを抜く。
// ------------------------------------------------------------
const CODE = readFileSync(join(GAS, 'コード.js'), 'utf8');

function pluck(name) {
  const re = new RegExp('function ' + name + '\\([^)]*\\) \\{[\\s\\S]*?\\n\\}');
  const m = CODE.match(re);
  if (!m) throw new Error('GASに ' + name + ' が見つかりません');
  return m[0];
}

const ctx = { console, String, Number, Math, isFinite };
ctx.global = ctx;
vm.createContext(ctx);
let pluckErr = '';
try {
  for (const fn of ['isShiftEvent', '_lbIsBusyTitle', '_lbIsSessionTitle', '_lbSubtractIntervals']) {
    vm.runInContext(pluck(fn), ctx, { filename: fn + '.js' });
  }
} catch (e) { pluckErr = String(e.message); }
ok('GASから判定関数を取り出せる' + (pluckErr ? '（' + pluckErr + '）' : ''), !pluckErr);

const gasShift   = ctx.isShiftEvent;
const gasBusy    = ctx._lbIsBusyTitle;
const gasSession = ctx._lbIsSessionTitle;
const gasSubtract = ctx._lbSubtractIntervals;

// ------------------------------------------------------------
// ① タイトルと期待結果の対応表（設計書 01-calendar-to-d1.md §3）
//    ここが仕様の正本。増やすときは設計書と一緒に増やす。
// ------------------------------------------------------------
const TITLES = [
  // 出勤シフト（部分一致・最優先）
  ['出勤可能',                          { shift: true,  busy: false, session: false }],
  ['出勤',                              { shift: true,  busy: false, session: false }],
  ['シフト',                            { shift: true,  busy: false, session: false }],
  ['available',                         { shift: true,  busy: false, session: false }],
  ['AVAILABLE',                         { shift: true,  busy: false, session: false }],
  ['出勤可能（休憩込み）',               { shift: true,  busy: true,  session: false }],   // 評価順でshiftが勝つ
  ['シフト・ブロックあり',               { shift: true,  busy: true,  session: false }],   // 同上
  // 予約（先頭一致）
  ['[RESERVED] 通常_鈴木_山田様_line',  { shift: false, busy: true,  session: true  }],
  ['✅ 通常_鈴木_山田様_line',          { shift: false, busy: true,  session: true  }],
  ['[RESERVED] 体験_沖_佐藤様',         { shift: false, busy: true,  session: true  }],
  // 休憩・ブロック（部分一致・席は塞ぐが施術ではない）
  ['休憩',                              { shift: false, busy: true,  session: false }],
  ['12:00 休憩 60分',                   { shift: false, busy: true,  session: false }],
  ['ブロック_私用',                      { shift: false, busy: true,  session: false }],
  ['ブロック_仮押さえ',                  { shift: false, busy: true,  session: false }],
  // 無視するもの
  ['[消化] 通常_鈴木_山田様_line',       { shift: false, busy: false, session: false }],
  ['ミーティング',                       { shift: false, busy: false, session: false }],
  ['',                                  { shift: false, busy: false, session: false }],
  // 先頭以外に紛れた印では塞がない
  ['メモ [RESERVED] の件',               { shift: false, busy: false, session: false }],
  ['買い物 ✅ 済み',                     { shift: false, busy: false, session: false }],
  ['[MIGRATED] 旧データ',                { shift: false, busy: false, session: false }]
];

for (const [title, want] of TITLES) {
  const label = JSON.stringify(title);
  // 仕様どおりか
  eq('①仕様: shift ' + label,   isShiftTitle(title),   want.shift);
  eq('①仕様: busy ' + label,    isBusyTitle(title),    want.busy);
  eq('①仕様: session ' + label, isSessionTitle(title), want.session);
  // ★GASと一致するか（ここが食い違いを止める要）
  if (!pluckErr) {
    eq('①GASと一致: shift ' + label,   isShiftTitle(title),   !!gasShift(title));
    eq('①GASと一致: busy ' + label,    isBusyTitle(title),    !!gasBusy(title));
    eq('①GASと一致: session ' + label, isSessionTitle(title), !!gasSession(title));
  }
}

// null/undefined でも落ちない（カレンダーのタイトルが空の経路がある）
for (const v of [null, undefined]) {
  ok('①空値で落ちない: shift', isShiftTitle(v) === false);
  ok('①空値で落ちない: busy', isBusyTitle(v) === false);
  ok('①空値で落ちない: session', isSessionTitle(v) === false);
  if (!pluckErr) {
    eq('①空値でもGASと一致: busy', isBusyTitle(v), !!gasBusy(v));
  }
}

// ------------------------------------------------------------
// ② 埋まりとセッションの関係（別の概念であることを固定）
// ------------------------------------------------------------
ok('②休憩は埋まりだがセッションではない', isBusyTitle('休憩') && !isSessionTitle('休憩'));
ok('②ブロックは埋まりだがセッションではない', isBusyTitle('ブロック_x') && !isSessionTitle('ブロック_x'));
for (const [title] of TITLES) {
  // セッションなら必ず埋まりでもある（施術しているなら席も塞がる）
  ok('②セッションは埋まりの部分集合: ' + JSON.stringify(title),
     !isSessionTitle(title) || isBusyTitle(title));
}

// ------------------------------------------------------------
// ③ 役割ごとの分類（トレーナー / B1 / 1F）
// ------------------------------------------------------------
eq('③トレーナー: 出勤はshift',
   classifyEvent(CAL_ROLE.TRAINER, '出勤可能'), { kind: EV_KIND.SHIFT, session: false });
eq('③トレーナー: 予約はbusyかつsession',
   classifyEvent(CAL_ROLE.TRAINER, '[RESERVED] x'), { kind: EV_KIND.BUSY, session: true });
eq('③トレーナー: 休憩はbusyだがsessionでない',
   classifyEvent(CAL_ROLE.TRAINER, '休憩'), { kind: EV_KIND.BUSY, session: false });
eq('③トレーナー: [消化]は無視',
   classifyEvent(CAL_ROLE.TRAINER, '[消化] x'), { kind: EV_KIND.IGNORE, session: false });
eq('③トレーナー: 関係ない予定は無視',
   classifyEvent(CAL_ROLE.TRAINER, 'ミーティング'), { kind: EV_KIND.IGNORE, session: false });

// B1は「[消化]で始まるか」だけ。それ以外はすべて部屋が埋まる（fail-closed）
eq('③B1: [消化]は席が空く',
   classifyEvent(CAL_ROLE.CAPACITY_B1, '[消化] 通常_鈴木_山田様_line'), { kind: EV_KIND.IGNORE, session: false });
eq('③B1: 予約は部屋が埋まる',
   classifyEvent(CAL_ROLE.CAPACITY_B1, '[RESERVED] x'), { kind: EV_KIND.ROOM_BUSY, session: false });
eq('③B1: 種別が読めない予定も部屋が埋まる（fail-closed）',
   classifyEvent(CAL_ROLE.CAPACITY_B1, '謎の予定'), { kind: EV_KIND.ROOM_BUSY, session: false });
eq('③B1: 「出勤」でも部屋としては埋まり扱い（役割が違う）',
   classifyEvent(CAL_ROLE.CAPACITY_B1, '出勤可能'), { kind: EV_KIND.ROOM_BUSY, session: false });
eq('③B1: 本文中の[消化]では席が空かない（先頭一致）',
   classifyEvent(CAL_ROLE.CAPACITY_B1, 'メモ [消化] の件'), { kind: EV_KIND.ROOM_BUSY, session: false });
eq('③1Fも部屋と同じ読み方',
   classifyEvent(CAL_ROLE.CAPACITY_1F, '[消化] x'), { kind: EV_KIND.IGNORE, session: false });

// ------------------------------------------------------------
// ③' 役割の文字列が設計書と一致していること（Codexの指摘・2026-10-02）
//
//   設計書のD1スキーマは role を 'trainer' / 'capacity_b1' と書いているのに、
//   実装の定数を 'room' にしていた。設計書どおりの文字列を渡すと、どちらにも
//   一致せず「トレーナー扱い」になり、B1の不明な予定が『席が空いている』と
//   判定される経路ができていた＝二重予約を作る。
//   D1に入る文字列とコードの定数が食い違わないよう、設計書から読んで突き合わせる。
// ------------------------------------------------------------
{
  const DESIGN = readFileSync(join(HERE, '../../ops/design/01-calendar-to-d1.md'), 'utf8');
  const m = DESIGN.match(/role\s+TEXT NOT NULL,\s*--\s*([^\n]+)/);
  ok('③\'設計書に role の取りうる値が書かれている', !!m);
  if (m) {
    const want = m[1].split('/').map(x => x.trim()).filter(Boolean);
    const have = Object.values(CAL_ROLE);
    for (const w of want) {
      ok('③\'設計書の role を実装が持っている: ' + w, have.indexOf(w) >= 0);
    }
  }
  // 知らない役割は必ず落ちる（fail-closed）。黙ってトレーナー扱いにしない。
  for (const bad of ['room', 'room_1f', 'ROOM', 'capacity', '', null, undefined, 'Trainer']) {
    let threw = false;
    try { classifyEvent(bad, '謎の予定'); } catch (e) { threw = /CALCLASS_UNKNOWN_ROLE/.test(e.message); }
    ok('③\'知らない役割で落ちる: ' + JSON.stringify(bad), threw);
  }
  ok('③\'知っている役割では落ちない',
     classifyEvent(CAL_ROLE.TRAINER, 'x').kind === EV_KIND.IGNORE
     && classifyEvent(CAL_ROLE.CAPACITY_B1, 'x').kind === EV_KIND.ROOM_BUSY);
  // effect に 'session' を置かない（busy か session かを取り違える元になる）
  ok('③\'effect に session を置かない', !Object.values(EV_KIND).includes('session'));
  ok('③\'セッションは session フラグで表す',
     classifyEvent(CAL_ROLE.TRAINER, '[RESERVED] x').session === true);
}

// ------------------------------------------------------------
// ④ 区間の引き算（空き枠の土台）— GASと同じ答えになること
// ------------------------------------------------------------
const H = (h, m) => new Date(2026, 9, 5, h, m || 0, 0).getTime();

const CASES = [
  ['真ん中が埋まる',       { start: H(7), end: H(23) }, [{ start: H(12), end: H(13) }]],
  ['端が埋まる',           { start: H(7), end: H(23) }, [{ start: H(7), end: H(9) }]],
  ['両端が埋まる',         { start: H(7), end: H(23) }, [{ start: H(7), end: H(9) }, { start: H(21), end: H(23) }]],
  ['全部埋まる',           { start: H(7), end: H(23) }, [{ start: H(7), end: H(23) }]],
  ['埋まりなし',           { start: H(7), end: H(23) }, []],
  ['重なる埋まり',         { start: H(7), end: H(23) }, [{ start: H(10), end: H(13) }, { start: H(12), end: H(15) }]],
  ['隣接する埋まり',       { start: H(7), end: H(23) }, [{ start: H(10), end: H(11) }, { start: H(11), end: H(12) }]],
  ['順不同の埋まり',       { start: H(7), end: H(23) }, [{ start: H(15), end: H(16) }, { start: H(9), end: H(10) }]],
  ['はみ出す埋まり',       { start: H(9), end: H(12) }, [{ start: H(7), end: H(23) }]],
  ['外側だけの埋まり',     { start: H(9), end: H(12) }, [{ start: H(7), end: H(8) }, { start: H(13), end: H(14) }]],
  ['幅0の埋まり',          { start: H(7), end: H(23) }, [{ start: H(10), end: H(10) }]],
  ['内包される埋まり',     { start: H(7), end: H(23) }, [{ start: H(10), end: H(15) }, { start: H(11), end: H(12) }]],
  ['3時間の空きが残る',    { start: H(7), end: H(23) }, [{ start: H(10), end: H(20) }]]
];

// GAS側は Date を受けて Date を返す（カレンダーAPIが Date を返すため）。
//   Worker側はミリ秒で扱う（JSONでやり取りし、D1に数値で入れるため）。
//   入力の形が違うだけで、答えは一致していなければならない。ここで形を変換して比べる。
const toDate = (iv) => ({ start: new Date(iv.start), end: new Date(iv.end) });
const toMs = (x) => ({
  start: x.start instanceof Date ? x.start.getTime() : Number(x.start),
  end:   x.end   instanceof Date ? x.end.getTime()   : Number(x.end)
});

for (const [name, base, busy] of CASES) {
  const mine = subtractIntervals(base, busy);
  const gas = (gasSubtract(toDate(base), (busy || []).map(toDate)) || []).map(toMs);
  eq('④GASと一致: ' + name, mine, gas);
}

// 壊れた入力で落ちない
eq('④baseが壊れていれば空を返す', subtractIntervals(null, []), []);
eq('④baseの幅が0なら空を返す', subtractIntervals({ start: H(10), end: H(10) }, []), []);
eq('④baseが逆向きなら空を返す', subtractIntervals({ start: H(12), end: H(10) }, []), []);
eq('④busyがnullでもbase全体を返す',
   subtractIntervals({ start: H(7), end: H(9) }, null), [{ start: H(7), end: H(9) }]);

// ------------------------------------------------------------
// ④' 壊れた区間を黙って捨てない（Codexの指摘・2026-10-02）
//
//   subtractIntervals は GAS と同じ答えを出すため壊れた区間を捨てる。
//   捨てたことを黙っていると「予定が無い」ことと区別できず、日時変換の不具合が
//   「席が空いている」に化ける。別に数えて返し、世代の公開を止められるようにする。
// ------------------------------------------------------------
eq('④\'正しい区間なら何も報告しない',
   findInvalidIntervals([{ start: H(10), end: H(11) }]), []);
eq('④\'逆向きを見つける',
   findInvalidIntervals([{ start: H(12), end: H(10) }]), [{ index: 0, reason: 'REVERSED' }]);
eq('④\'幅0を見つける',
   findInvalidIntervals([{ start: H(10), end: H(10) }]), [{ index: 0, reason: 'ZERO_WIDTH' }]);
// Number() は null・''・false を 0 に変える。整数として妥当かを見る
for (const v of [null, undefined, '', '10:00', NaN, Infinity, false, true, 1.5, '1791151200000']) {
  eq('④\'数値でない開始を見つける: ' + JSON.stringify(v),
     findInvalidIntervals([{ start: v, end: H(11) }]), [{ index: 0, reason: 'NOT_INTEGER_MS' }]);
}
eq('④\'要素が無い・nullでも落ちない', findInvalidIntervals([null, undefined]).length, 2);
eq('④\'リストがnullなら空', findInvalidIntervals(null), []);
eq('④\'壊れた要素の位置を返す（どれが悪いか分かる）',
   findInvalidIntervals([{ start: H(10), end: H(11) }, { start: H(12), end: H(10) }]),
   [{ index: 1, reason: 'REVERSED' }]);

// ------------------------------------------------------------
// ⑤ 重なりの判定（接するだけは重ならない）
// ------------------------------------------------------------
ok('⑤接するだけは重ならない', !overlaps(H(10), H(11), H(11), H(12)));
ok('⑤逆向きに接するだけも重ならない', !overlaps(H(11), H(12), H(10), H(11)));
ok('⑤1分でも重なれば重なる', overlaps(H(10), H(11), H(10, 59), H(12)));
ok('⑤内包は重なる', overlaps(H(10), H(14), H(11), H(12)));
ok('⑤完全一致は重なる', overlaps(H(10), H(11), H(10), H(11)));
ok('⑤離れていれば重ならない', !overlaps(H(10), H(11), H(13), H(14)));
// ★読めない値は「重なる」に倒す（fail-closed）。
//   予約の競合判定に使うので、「重ならない」に倒すと二重予約を作る。
for (const v of [null, undefined, NaN, '', 'x', {}]) {
  ok('⑤読めない値は重なる扱い（開始）: ' + JSON.stringify(v), overlaps(v, H(11), H(13), H(14)));
  ok('⑤読めない値は重なる扱い（終了）: ' + JSON.stringify(v), overlaps(H(10), v, H(13), H(14)));
}

// ------------------------------------------------------------
// ⑥ 条件を書き写していないこと（再発の経路を塞ぐ）
// ------------------------------------------------------------
const MINE = readFileSync(join(HERE, '../src/lib/calclass.js'), 'utf8');
// 判定の本体を除いた残りに、同じ条件が現れないこと
const MINE_WO = MINE
  .replace(/export function isShiftTitle[\s\S]*?\n\}/, '')
  .replace(/export function isBusyTitle[\s\S]*?\n\}/, '')
  .replace(/export function isSessionTitle[\s\S]*?\n\}/, '')
  .replace(/export function isConsumedTitle[\s\S]*?\n\}/, '');
ok('⑥休憩・ブロックの条件を他の場所に書き写していない',
   !/indexOf\('休憩'\)[\s\S]{0,80}indexOf\('ブロック'\)/.test(MINE_WO));
ok('⑥[RESERVED]/✅ の組を他の場所に書き写していない',
   !/indexOf\('\[RESERVED\]'\)[\s\S]{0,80}indexOf\('✅'\)/.test(MINE_WO));
ok('⑥分類は classifyEvent を通る（役割の判定を散らさない）',
   /export function classifyEvent/.test(MINE));
// 出勤シフトの語を1か所にまとめている
ok('⑥出勤シフトの語を1か所にまとめている', /const SHIFT_WORDS = \[/.test(MINE));
ok('⑥出勤シフトの語を書き写していない',
   (MINE.match(/'出勤可能'/g) || []).length === 1);

// ------------------------------------------------------------
// ⑦ カレンダーもD1も触っていないこと（純粋関数だけの置き場）
// ------------------------------------------------------------
ok('⑦D1を触らない', !/env\.DB|\.prepare\(/.test(MINE));
ok('⑦fetchを呼ばない', !/fetch\(/.test(MINE));
ok('⑦日時の「今」に依存しない（Date.now を使わない）', !/Date\.now\(/.test(MINE));

console.log('\nカレンダーの分類（GASとの一致） 検証: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
