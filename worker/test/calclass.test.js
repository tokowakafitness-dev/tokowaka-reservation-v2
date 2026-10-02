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

// ------------------------------------------------------------
// ⑧ GASの押し出し（_calsyncClassify）と、Worker側の分類が一致すること
//
//   GASはカレンダーを読んで「分類済みの形」をD1へ送る。Workerはそれを受け取るだけ。
//   つまり分類はGAS側で行われる。ここがWorker側の仕様とずれると、
//   D1に入る内容が設計と違うものになり、誰も気づけない。
//   同じタイトルで同じ effect になることを1件ずつ突き合わせる。
// ------------------------------------------------------------
{
  const PUSH = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8');
  const mc = PUSH.match(/function _calsyncClassify\(role, title\) \{[\s\S]*?\n\}/);
  ok('⑧GASに _calsyncClassify がある', !!mc);
  if (mc) {
    // 判定が依存する関数（isShiftEvent / _lbIsBusyTitle）は上で評価済み
    vm.runInContext(mc[0], ctx, { filename: 'calsync.js' });
    const gasCls = ctx._calsyncClassify;

    // Worker側の effect に合わせて比べる
    const ROLES = [
      ['trainer', CAL_ROLE.TRAINER],
      ['capacity_b1', CAL_ROLE.CAPACITY_B1],
      ['capacity_1f', CAL_ROLE.CAPACITY_1F]
    ];
    for (const [gasRole, workerRole] of ROLES) {
      for (const [title] of TITLES) {
        const g = gasCls(gasRole, title);
        const w = classifyEvent(workerRole, title);
        eq('⑧' + gasRole + ' / ' + JSON.stringify(title) + ' の effect が一致', g.effect, w.kind);
      }
    }

    // 埋まりの理由が正しく分かれること（D1にはタイトルを残さないので、ここだけが手がかり）
    eq('⑧予約の理由', gasCls('trainer', '[RESERVED] x').reason, 'reserved');
    eq('⑧実施済みの理由', gasCls('trainer', '✅ x').reason, 'reserved');
    eq('⑧休憩の理由', gasCls('trainer', '休憩').reason, 'break');
    eq('⑧ブロックの理由', gasCls('trainer', 'ブロック_私用').reason, 'block');
    eq('⑧部屋の理由', gasCls('capacity_b1', '[RESERVED] x').reason, 'room');
    eq('⑧消化の理由', gasCls('capacity_b1', '[消化] x').reason, 'consumed');

    // GASが知らない役割を渡しても、部屋扱いにしない（トレーナーとして評価される）
    //   ★Worker側は知らない役割で落ちる。GAS側は送る前の分類なので落とさず、
    //     代わりに「役割の一覧はGASが作る（_calsyncCalendars）」ことで守る。
    ok('⑧GASは役割の一覧を自分で作る（外から来ない）',
       /function _calsyncCalendars\(\)/.test(PUSH));
    ok('⑧役割はCALENDAR_IDSから組み立てる',
       /role: 'capacity_b1'/.test(PUSH) && /role: 'trainer'/.test(PUSH));
    // 設計書・Worker と同じ文字列を使っていること
    for (const r of Object.values(CAL_ROLE)) {
      ok('⑧GASが役割 ' + r + ' を使う', PUSH.indexOf("'" + r + "'") >= 0);
    }
  }

  // タイトルを送らないこと（会員の氏名が入るため）
  ok('⑧送る形にタイトルを入れない',
     !/title:\s*(ev\.getTitle|t\b|title)/.test(PUSH.slice(PUSH.indexOf('events.push('))));
  ok('⑧壊れた予定は送らずに理由を伝える',
     /invalid\.push\(\{[\s\S]{0,120}reason: 'REVERSED'/.test(PUSH));
  ok('⑧カレンダーが1つでも読めなければ送らない',
     /CALENDAR_UNREADABLE/.test(PUSH));
  ok('⑧分類の条件をGAS側で書き写していない（コード.jsの判定を呼ぶ）',
     /isShiftEvent\(t\)/.test(PUSH) && /_lbIsBusyTitle\(t\)/.test(PUSH));
}

// ------------------------------------------------------------
// ⑨ 1Fは「空き枠に入れる設定のとき」だけ送る（2026-10-02）
//
//   1Fはオンライン・体験用で、B1の席は使わない。LB_1F_TRAINER_BLOCK が off の
//   あいだは空き枠の計算に入れない仕様。それなのにD1へ送ってしまうと、
//   読み取り側が「room_busy なら塞がる」と素朴に書いた瞬間、off のはずの
//   1Fの予定でB1の枠が消える。送らなければ、その誤りが起きようがない。
// ------------------------------------------------------------
{
  const PUSH2 = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8');
  ok('⑨1Fはフラグを見てから送る', /if \(CALENDAR_IDS\.CAPACITY_1F && _calsyncUse1F\(\)\)/.test(PUSH2));
  ok('⑨フラグの判定を書き写さない（コード.jsの判定を呼ぶ）',
     /_lb1FBlockEnabled\(\)/.test(PUSH2));
  ok('⑨B1は常に送る（席の正本なので外さない）',
     /\{ calendarId: CALENDAR_IDS\.CAPACITY_B1, role: 'capacity_b1' \}/.test(PUSH2));
  // フラグの値も世代の条件に入っている（on/off を切り替えたら作り直される）
  ok('⑨フラグの値を送る', /flag1f: _calsyncUse1F\(\) \? 'on' : 'off'/.test(PUSH2));
  // 読み終えた時刻を添える（遅れて届いた押し出しで鮮度を偽らない）
  ok('⑨読み終えた時刻を添える', /pushedAt: now\.getTime\(\)/.test(PUSH2));
}

// ------------------------------------------------------------
// ⑩ 繰り返し予定でIDが重複しないこと（2026-10-02・本番で実際に拒否された）
//
//   GASの getId() は、繰り返し予定の各回で**同じ値**を返す。
//   出勤シフトを毎週の繰り返しで入れていると、全部が同じIDになり、
//   Worker側の DUPLICATE_EVENT 検査で**世代ごと拒否される**。
//   実際に本番で HTTP 422 REJECTED になった。
//   開始時刻を足して回ごとに一意にする。
// ------------------------------------------------------------
{
  const PUSH3 = readFileSync(join(GAS, 'PushToEdge.js'), 'utf8');
  ok('⑩予定の識別子に開始時刻を足している',
     /var uid = id \+ '#' \+ String\(sMs\)/.test(PUSH3));
  ok('⑩送る識別子は uid（生のIDではない）', /eventId: uid,/.test(PUSH3));
  // 送る予定（events.push）だけを見る。壊れた予定の報告（invalid）は、
  //   時刻が壊れていて識別子を作れないので生のIDで正しい。
  const sendBlock = PUSH3.slice(PUSH3.indexOf('events.push('), PUSH3.indexOf('events.push(') + 600);
  ok('⑩送る予定には生のIDを使わない', !/eventId: id,/.test(sendBlock));
  ok('⑩壊れた予定の報告は生のIDでよい（識別子を作れないため）',
     /invalid\.push\(\{ calendarId: cals\[c\]\.calendarId, eventId: id, reason: 'REVERSED' \}\)/.test(PUSH3));
  // 時刻の検査を通ってから識別子を作る（壊れた時刻で識別子を作らない）
  const idxCheck = PUSH3.indexOf("reason: 'ZERO_WIDTH'");
  const idxUid = PUSH3.indexOf("var uid = id + '#'");
  ok('⑩時刻の検査を通ってから識別子を作る', idxCheck > 0 && idxUid > idxCheck);

  // 送る前に重複を見つけて、送らずに知らせる
  ok('⑩送る前に重複を見つける', /DUPLICATE_EVENTS/.test(PUSH3));
  ok('⑩重複があれば送らない',
     /return \{ ok: false, code: 'DUPLICATE_EVENTS'/.test(PUSH3));

  // 識別子の作り方を実際に動かして確かめる
  const mkUid = (id, sMs) => id + '#' + String(sMs);
  const weekly = 'abc123@google.com';
  const t1 = Date.UTC(2026, 9, 5, 1, 0), t2 = Date.UTC(2026, 9, 12, 1, 0);
  ok('⑩同じ予定の別の回は別の識別子', mkUid(weekly, t1) !== mkUid(weekly, t2));
  ok('⑩同じ予定の同じ回は同じ識別子', mkUid(weekly, t1) === mkUid(weekly, t1));
  ok('⑩別の予定は別の識別子', mkUid('xyz@google.com', t1) !== mkUid(weekly, t1));
}

console.log('\nカレンダーの分類（GASとの一致） 検証: ' + pass + ' passed / ' + fail + ' failed');
process.exit(fail ? 1 : 0);
