// カレンダーの予定を分類する（① カレンダー→D1 の土台）
//
//   なぜ1つのファイルに閉じるか：
//     同じ条件が3か所に書き写されていたため、体験予約だけが休憩・ブロックを
//     見落とし、トレーナーが塞いだ時間に予約が入っていた（2026-10-02 に修正）。
//     片方を直してももう片方が残る形が原因だったので、D1側では最初から1か所に置く。
//
//   GAS側の判定（gas/コード.js の isShiftEvent / _lbIsBusyTitle / _lbIsSessionTitle）と
//   答えが一致していなければならない。一致はテスト（worker/test/calclass.test.js）が
//   GASのソースから関数を取り出して突き合わせて検査する。
//   どちらかを直したらもう片方も直さないとテストが落ちる＝食い違ったまま進めない。
//
//   ★ここは純粋な関数だけを置く。カレンダーAPIもD1も触らない。

// 出勤シフトか。「この中でだけ予約できる」枠。
//   部分一致。評価はいちばん先（「シフト」と「ブロック」を両方含むタイトルは shift）。
const SHIFT_WORDS = ['出勤可能', '出勤', 'シフト', 'available', 'AVAILABLE'];

export function isShiftTitle(title) {
  const t = String(title == null ? '' : title);
  for (let i = 0; i < SHIFT_WORDS.length; i++) {
    if (t.indexOf(SHIFT_WORDS[i]) >= 0) return true;
  }
  return false;
}

// 席を塞ぐか（予約を受けられないか）。
//   休憩・ブロックも塞ぐ。トレーナーが休んでいても、その時間は予約できない。
export function isBusyTitle(title) {
  const t = String(title == null ? '' : title);
  if (t.indexOf('休憩') >= 0) return true;
  if (t.indexOf('ブロック') >= 0) return true;
  return t.indexOf('[RESERVED]') === 0 || t.indexOf('✅') === 0;
}

// トレーナーが実際に施術しているか。
//   埋まり（席を塞ぐか）とは別の概念。休憩・ブロックは施術ではないので含まない。
//   連続セッションを数えるときはこちらを使う。混ぜると「セッション→休憩→セッション」が
//   連続に見え、休んでいる日の前後の枠まで落とす制限になる。
export function isSessionTitle(title) {
  const t = String(title == null ? '' : title);
  if (t.indexOf('休憩') >= 0 || t.indexOf('ブロック') >= 0) return false;
  return t.indexOf('[RESERVED]') === 0 || t.indexOf('✅') === 0;
}

// B1（部屋）で席が空いているか。
//   [消化] は「予定はあるが席は空いている」という計上の証跡。
//   これを取りこぼすと、消化済みの時間が永久に予約不可になる。
export function isConsumedTitle(title) {
  return String(title == null ? '' : title).indexOf('[消化]') === 0;
}

// ============================================================
// 分類の本体
//   kind は役割ごとに意味が変わるので、カレンダーの役割を引数で受ける。
//     'trainer' … トレーナー個人のカレンダー
//     'room'    … B1（施設キャパシティ）
//     'room_1f' … 1F（オンライン・体験用。部屋の容量は使わず担当だけ塞ぐ）
// ============================================================

// ★名前は設計書（01-calendar-to-d1.md §4 の D1スキーマ）と同じ文字列にする。
//   設計書は role を 'trainer' / 'capacity_b1' と書いているのに、ここを 'room' に
//   していたため、設計書どおりの文字列を渡すとどちらにも一致せず **トレーナー扱い** になり、
//   B1の不明な予定が「席が空いている」と判定される経路ができていた（Codexの指摘で発覚）。
//   D1に入れる文字列とコードの定数は必ず同じにする。
export const CAL_ROLE = {
  TRAINER: 'trainer',
  CAPACITY_B1: 'capacity_b1',
  CAPACITY_1F: 'capacity_1f'
};

// effect の値も設計書と同じ文字列にする。
//   ★'session' は effect ではない。セッションかどうかは effect と直交する情報で、
//     { kind: 'busy', session: true } の形で持つ。effect に 'session' を置くと
//     「busy なのか session なのか」を取り違える。だから定数にも置かない。
export const EV_KIND = {
  SHIFT: 'shift',           // この中でだけ予約できる（トレーナーのみ）
  BUSY: 'busy',             // そのトレーナーが埋まっている
  ROOM_BUSY: 'room_busy',   // 部屋が埋まっている（全トレーナーに効く）
  IGNORE: 'ignore'          // 空き枠の計算に影響しない
};

// 1件の予定を分類する。
//   返すのは { kind, session } の形。
//     kind    … 空き枠の計算に使う区分
//     session … 実際のセッションか（連続を数えるときだけ見る）
export function classifyEvent(role, title) {
  const t = String(title == null ? '' : title);

  // ★知らない役割が来たら必ず落とす（fail-closed）。
  //   「どれでもなければトレーナー」にすると、役割の綴り違い1つで
  //   部屋の予定が「席が空いている」と判定され、二重予約を作る。
  //   落ちれば世代の公開が止まるだけで、顧客に害は出ない。
  if (role !== CAL_ROLE.TRAINER && role !== CAL_ROLE.CAPACITY_B1 && role !== CAL_ROLE.CAPACITY_1F) {
    throw new Error('CALCLASS_UNKNOWN_ROLE: ' + String(role));
  }

  if (role === CAL_ROLE.CAPACITY_B1 || role === CAL_ROLE.CAPACITY_1F) {
    // 部屋は「[消化] で始まるかどうか」だけで決まる。それ以外はすべて埋まり。
    //   fail-closed：種別が読めなくても席は塞ぐ（空いていると誤判断して二重予約を作らない）。
    if (isConsumedTitle(t)) return { kind: EV_KIND.IGNORE, session: false };
    return { kind: EV_KIND.ROOM_BUSY, session: false };
  }

  // トレーナーのカレンダー。評価順は上から（シフトが最優先）。
  if (isShiftTitle(t)) return { kind: EV_KIND.SHIFT, session: false };
  if (isBusyTitle(t))  return { kind: EV_KIND.BUSY, session: isSessionTitle(t) };
  return { kind: EV_KIND.IGNORE, session: false };
}

// ============================================================
// 区間の計算（空き枠を出す土台）
// ============================================================

// 壊れた区間を見つける（設計書 §6 の公開前の検査で使う）。
//   subtractIntervals は GAS と同じ答えを出すために壊れた区間を捨てる。
//   捨てたことを黙っていると「予定が無い」ことと区別できず、
//   日時変換の不具合が「席が空いている」に化ける。だから別に数えて返し、
//   呼び出し側（同期処理）が世代の公開を拒否できるようにする。
export function findInvalidIntervals(list) {
  const bad = [];
  for (let i = 0; i < (list || []).length; i++) {
    const iv = list[i] || {};
    const s = iv.start, e = iv.end;
    // ★Number() は null・''・false を 0 に変える。整数として妥当かを先に見る。
    const okS = typeof s === 'number' && isFinite(s) && Math.floor(s) === s;
    const okE = typeof e === 'number' && isFinite(e) && Math.floor(e) === e;
    if (!okS || !okE) { bad.push({ index: i, reason: 'NOT_INTEGER_MS' }); continue; }
    if (e < s) { bad.push({ index: i, reason: 'REVERSED' }); continue; }
    if (e === s) { bad.push({ index: i, reason: 'ZERO_WIDTH' }); continue; }
  }
  return bad;
}

// base から busy を引いた空き区間を返す。
//   入力は { start, end }（ミリ秒）の配列。重なり・順不同・幅0を許す。
//   GAS側の _lbSubtractIntervals と同じ答えになること（テストで固定）。
export function subtractIntervals(base, busy) {
  const bS = Number(base && base.start), bE = Number(base && base.end);
  if (!isFinite(bS) || !isFinite(bE) || bE <= bS) return [];

  // base と重なる部分だけに切って、順に並べる
  //   ★幅0（start === end）の予定も残す。GAS側（_lbSubtractIntervals）が
  //     幅0を除外していないため、幅0の予定があると空きが2つに割れる。
  //     空きの合計は変わらないが、割れ方で後段の60分刻みの出方が変わりうる。
  //     ①の完了条件は「GASと7日間一致」なので、ここは素直さよりGASとの一致を採る。
  //     逆向き（end < start）は壊れた入力なので落とす。
  const cut = [];
  for (let i = 0; i < (busy || []).length; i++) {
    const rs = Number(busy[i].start), re = Number(busy[i].end);
    if (!isFinite(rs) || !isFinite(re) || re < rs) continue;
    if (!(rs < bE && re > bS)) continue;          // base と重ならないものは捨てる（GASと同じ条件）
    cut.push({ start: Math.max(bS, rs), end: Math.min(bE, re) });
  }
  cut.sort((a, b) => a.start - b.start);

  // 重なり・隣接を1つに畳む
  const merged = [];
  for (let i = 0; i < cut.length; i++) {
    const last = merged[merged.length - 1];
    if (last && cut[i].start <= last.end) {
      if (cut[i].end > last.end) last.end = cut[i].end;
    } else {
      merged.push({ start: cut[i].start, end: cut[i].end });
    }
  }

  // 隙間が空き
  const free = [];
  let cur = bS;
  for (let i = 0; i < merged.length; i++) {
    if (merged[i].start > cur) free.push({ start: cur, end: merged[i].start });
    if (merged[i].end > cur) cur = merged[i].end;
  }
  if (cur < bE) free.push({ start: cur, end: bE });
  return free;
}

// 2つの区間が重なるか。接するだけ（end === start）は重ならない。
//   カレンダーAPIは end ちょうどに始まる予定も返すため、ここを誤ると
//   連続した予約が「競合」と判定されて予約できなくなる。
export function overlaps(aStart, aEnd, bStart, bEnd) {
  // ★読めない値が来たら「重なる」に倒す（fail-closed）。
  //   予約の競合判定に使うので、「重ならない」に倒すと二重予約を作る。
  //   断る方向の誤りは顧客に謝れるが、二重予約は現場が破綻する。
  //
  //   ★Number() を通さない。Number(null)・Number('')・Number(false) はすべて 0 になり、
  //     isFinite(0) は真なので「読めた」ことになってしまう。欠損が1970年1月1日として
  //     扱われ、重なり判定をすり抜ける。だから型そのものを見る。
  if (!isMs(aStart) || !isMs(aEnd) || !isMs(bStart) || !isMs(bEnd)) return true;
  return aStart < bEnd && aEnd > bStart;
}

// ミリ秒として受け付けられる値か。Number() の暗黙変換を通さない。
export function isMs(v) {
  return typeof v === 'number' && isFinite(v);
}
