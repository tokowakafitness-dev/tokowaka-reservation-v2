// ============================================================
// 予約タイトルの分類（純粋関数・Node検証可能）— 決定0045 / 運用モデル確定 2026-08-05 / Codexレビュー反映
//   カレンダーの予約1件を「B1容量を占有するか / 担当トレーナーを占有するか / 会員残数に計上するか」に分類する。
//   運用実態（オーナー確認 2026-08-05）：
//     - 予約はB1施設calに集約・形式 `種別_担当姓_顧客`（顧客名に_が含まれてもよい＝残りを結合）。担当はタイトルparts[1](姓)。
//     - B1＝同時1セッションの単一共有容量（B1の予約は全トレーナーを弾く）。
//     - オンライン＝1Fcalに記録（種別「オンライン」明示 or 1F＋契約会員）。B1容量は占有せず・担当は占有・残数計上。
//     - レンタル＝B1利用・担当あり・場所貸し（残数計上せず＝別売上）。体験/カウンセリング＝非会員・非計上。
//     - チケットは残数モデル(pack)側で処理。カレンダー種別としても会員セッション扱い。
//   fail-closed 方針（Codex #5,#6）：
//     - B1に載っている予約は種別を問わず occupiesB1=true（誤配置オンラインでも施設を塞ぐ＝二重予約を防ぐ）。
//     - オンライン判定は会員のみ。非会員の1Fセッション種別・未知種別は mode=other＋anomaly で要確認に落とす。
//   ※純粋関数・副作用なし。呼出側は anomaly / trainerId 空 を fail-closed に扱うこと（担当不明はエンジンで安全側=停止/全員busy）。
// ============================================================
function _lbClassifyBooking(title, calId, opts) {
  opts = opts || {};
  var b1Id = opts.b1Id, oneFId = opts.oneFId;
  var surToId = opts.surToId || {};
  var isMember = opts.isMember || function () { return false; };
  var SESSION_KINDS = { '通常': 1, 'モニター': 1, 'オンライン': 1, 'チケット': 1, '振替': 1 };   // 残数を消化する会員セッション種別
  var NONSESSION = { 'レンタル': 'rental', '体験': 'trial', 'カウンセリング': 'consultation' };     // 席/担当は使うが残数非計上
  var res = { parsed: false, kind: '', sur: '', cname: '', trainerId: '', occupiesB1: false, blocksTrainer: false, isSessionKind: false, isMemberSession: false, mode: 'other', anomaly: '' };
  var t = String(title == null ? '' : title);
  if (t.indexOf('[消化]') === 0) return res;   // 消化済み＝過去実績。未来予約の分類対象外（openingと二重計上しない）
  var body = t.replace(/^\[RESERVED\]\s*/, '').replace(/^✅\s*/, '');
  var parts = body.split('_');
  if (parts.length < 3) return res;             // 種別_担当姓_顧客… 最低3分割（出勤シフト・休憩・2分割等は対象外）
  var kind = _lbNormTok(parts[0]), sur = _lbNormTok(parts[1]);
  var cname = String(parts.slice(2).join('_')).replace(/_line$/, '').replace(/^\s+|\s+$/g, '');   // 末尾の予約マーカー_lineを顧客名から除去（照合キーへの混入で二重同期を招くのを防ぐ）。顧客名内の_は保持
  res.parsed = true; res.kind = kind; res.sur = sur; res.cname = cname;
  res.trainerId = surToId[sur] || '';
  res.blocksTrainer = !!res.trainerId;          // 担当姓→trainerIdが引ければそのトレーナーを占有。空=表記ゆれ→呼出側でfail-closed
  var onB1 = !!(b1Id && calId === b1Id), onOneF = !!(oneFId && calId === oneFId);
  res.occupiesB1 = onB1;                         // B1配置は種別を問わず施設容量を占有（fail-closed・Codex#5）
  res.isSessionKind = !!SESSION_KINDS[kind];
  var mem = !!isMember(cname);
  res.isMemberSession = mem && res.isSessionKind;   // レンタル/体験/カウンセリング/未知は会員でも非計上
  // mode（表示・監査用）
  if (NONSESSION[kind]) res.mode = NONSESSION[kind];
  else if (!res.isSessionKind) res.mode = 'other';                       // 未知種別
  else if (kind === 'オンライン' || onOneF) res.mode = mem ? 'online' : 'other';   // オンラインは会員限定（Codex#6）
  else res.mode = 'inperson';
  // anomaly（要確認サイン・優先順）
  if (kind === 'オンライン' && onB1) res.anomaly = 'online_on_b1';        // オンラインなのにB1→容量占有させ要確認
  else if (res.isSessionKind && !res.trainerId) res.anomaly = 'unknown_trainer';   // 担当姓不明
  else if (onOneF && res.isSessionKind && !mem) res.anomaly = 'onef_nonmember';    // 1Fのセッション種別だが非会員
  else if (!res.isSessionKind && !NONSESSION[kind]) res.anomaly = 'unknown_kind';  // 未知種別
  return res;
}
function _lbNormTok(s) { return String(s == null ? '' : s).replace(/　/g, ' ').replace(/^\s+|\s+$/g, ''); }   // 全角空白→半角・トリム

// 振替権の残高判定（純粋・#9）。当日キャンセルで付与、6日有効、1件=1回。
//   rows: [{grantedMs, expiresMs, usedMs}]（usedMs>0で使用済み）。available=未使用かつ未失効の件数。nextExpiryMs=最短失効。
function _lbTransferCreditState(rows, nowMs) {
  var available = 0, nextExpiryMs = null;
  for (var i = 0; i < (rows || []).length; i++) {
    var r = rows[i];
    if (r.usedMs) continue;                       // 使用済み
    if (!(r.expiresMs >= nowMs)) continue;        // 失効（6日超）
    available++;
    if (nextExpiryMs === null || r.expiresMs < nextExpiryMs) nextExpiryMs = r.expiresMs;
  }
  return { available: available, nextExpiryMs: nextExpiryMs };
}

// #6 繰り返し予約：同曜日同時刻でN回分の開始ミリ秒を返す（everyDays=7・JSTはDST無しなので+7日で同曜日同時刻）。
//   count は 1..maxCount にクランプ。定期イベントは作らず、各回を独立予約として一括作成する土台。
function _lbRecurringStartMs(startMs, count, everyDays, maxCount) {
  everyDays = everyDays || 7; maxCount = maxCount || 8;
  var n = Math.floor(Number(count) || 1); if (n < 1) n = 1; if (n > maxCount) n = maxCount;
  var out = [];
  for (var k = 0; k < n; k++) out.push(startMs + k * everyDays * 86400000);
  return out;
}

// ペア/複数消化：セッション配列から「チケット消化数」を数える（通常=1・ペアは attendeeCount 分）。
//   s.attendeeCount>1 のセッションは人数ぶん消化。未指定は1。人数回モデルの残数計算の核（純粋）。
function _lbCountTicketConsumption(sessions) {
  var total = 0;
  for (var i = 0; i < (sessions || []).length; i++) {
    var a = Number(sessions[i].attendeeCount); if (!(a >= 1)) a = 1;
    total += a;
  }
  return total;
}

// 予約カレンダータイトルの種別プレフィックス決定（純粋・billingの計上種別を左右する）。
//   channel(transfer優先)＞packKind(pair)＞レンタル(0円pack消化時＝月額消化はレンタルにしない・Codex#3)＞
//   消化=ticket＞契約モニター/チケット＞通常。consumeType='monthly'/'ticket'/''。
function _lbBookTypePrefix(channel, packKind, contractType, consumeType, monthlyType) {
  var ct = String(contractType || ''), cons = String(consumeType || ''), mct = String(monthlyType || '');
  if (channel === 'transfer') return '振替_';
  if (packKind === 'pair') return 'ペア_';
  if (ct.indexOf('レンタル') >= 0 && cons !== 'monthly') return 'レンタル_';   // レンタル会員が0円pack(ticket)消化＝レンタル計上。月額消化はレンタルにしない
  if (cons === 'ticket') return 'チケット_';
  // ★月額枠を消化したときは月額として計上する（2026-10-05）。
  //   contractType は「開始日が最も新しい有効な契約行」から来る（_lbFindContract）。月額行と追加チケット行を
  //   並列に持つ運用にしたため、チケットを買った会員は contractType='チケット' になる。それをそのまま
  //   タイトルに出すと、月額枠を消化した予約が チケット_ に化け、billing がチケット行で計上して
  //   月額売上が立たない。消化方式が monthly と確定しているなら、月額契約の種別(monthlyType)を使う。
  //   monthlyType が取れない場合（degraded・旧経路）は従来のフォールバックへ落ちる＝後方互換。
  if (cons === 'monthly' && mct) return (mct.indexOf('モニター') >= 0) ? 'モニター_' : '通常_';
  if (ct.indexOf('モニター') >= 0) return 'モニター_';
  if (ct.indexOf('チケット') >= 0) return 'チケット_';
  return '通常_';
}

// 指名/シフト（シフト制顧客の自動割当・純粋）。ベースシフト表＝曜日×時間帯→優先トレーナー順。
//   schedule: [{dow:0-6(0=日), startMin, endMin, priority:[tid,...]}]（JST基準・分は0時からの分）。
//   startMs の曜日・時刻に一致する行の priority のうち、availableIds に含まれる最上位を割当。
//   一致行なし＝スケジュール外→null（呼出側で「出勤中の任意」にフォールバック）。一致行あるが誰も空いていない→null。
function _lbAssignTrainerByShift(schedule, startMs, availableIds) {
  var jst = startMs + 9 * 3600000;
  var dow = ((Math.floor(jst / 86400000) % 7) + 4) % 7;   // 1970-01-01(木=4)基準。0=日
  var minOfDay = Math.floor((jst % 86400000) / 60000);
  var avail = {}; for (var a = 0; a < (availableIds || []).length; a++) avail[String(availableIds[a])] = true;
  for (var i = 0; i < (schedule || []).length; i++) {
    var row = schedule[i];
    if (Number(row.dow) !== dow) continue;
    if (!(minOfDay >= Number(row.startMin) && minOfDay < Number(row.endMin))) continue;
    var pri = row.priority || [];
    for (var p = 0; p < pri.length; p++) { if (avail[String(pri[p])]) return String(pri[p]); }   // 最上位の出勤者
    return null;   // 一致行はあるが優先順の誰も空いていない
  }
  return null;   // スケジュール外の時間帯
}


// ───────────────────────────────────────────────────────────
// 予約の受付締め切り（2026-09-24 追加）
//   従来は「開始3時間前」の一本だった。朝7時の枠が当日4時まで予約でき、
//   トレーナーが前夜に翌日を確認しても朝の予約が増えてしまう（寝坊事故の原因）。
//   → 午前枠だけ「前日22時」で締め、トレーナーが前夜に翌日の朝を確定できるようにする。
//   時刻・午前の定義は SETTINGS（コード.js）で変更できる。コードを触らず運用で調整可能。
// 検証: node 30_projects/personal-training/line-booking/test/booking-deadline.test.js
// ───────────────────────────────────────────────────────────

// JST(UTC+9)の壁時計を読む（UTC内部値を+9してUTCゲッターで読む＝Allocate.js と同じ手法）
function _lbJstParts(ms) {
  var d = new Date(ms + 9 * 3600 * 1000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
// JSTの壁時計(mo=0起点) → epoch ms。d に 0 や -1 を渡しても Date.UTC が月跨ぎ・年跨ぎを正規化する。
function _lbJstMs(y, mo, d, h, mi) {
  return Date.UTC(y, mo, d, h, mi) - 9 * 3600 * 1000;
}

// 設定の既定値（SETTINGSに項目が無い場合のフォールバック＝従来動作を壊さない）
var LB_BOOKING_DEFAULTS = { leadMinutes: 180, morningUntilHour: 12, prevDeadlineHour: 22 };

// SETTINGS から cfg を作る（呼び出し側を1行にするため）
function _lbBookingCfg(s) {
  s = s || {};
  return {
    leadMinutes: (s.BOOKING_LEAD_MINUTES != null) ? s.BOOKING_LEAD_MINUTES : LB_BOOKING_DEFAULTS.leadMinutes,
    morningUntilHour: (s.MORNING_UNTIL_HOUR != null) ? s.MORNING_UNTIL_HOUR : LB_BOOKING_DEFAULTS.morningUntilHour,
    prevDeadlineHour: (s.MORNING_PREV_DEADLINE_HOUR != null) ? s.MORNING_PREV_DEADLINE_HOUR : LB_BOOKING_DEFAULTS.prevDeadlineHour
  };
}

// この枠が午前枠（前日締め切りの対象）か
// 前日締め切りの設定が使える値か（判定と案内文で同じ基準を使う＝食い違わせない）
function _lbPrevDeadlineHourOf(cfg) {
  var h = Number((cfg || LB_BOOKING_DEFAULTS).prevDeadlineHour);
  return (isFinite(h) && h >= 0 && h <= 23) ? h : null;
}

function _lbIsMorningSlot(startMs, cfg) {
  var c = cfg || LB_BOOKING_DEFAULTS;
  var mUntil = Number(c.morningUntilHour);
  //   24以上は「全枠が午前」になってしまうので不正扱い（0/未設定/不正＝午前ルールを使わない）
  if (!(isFinite(mUntil) && mUntil > 0 && mUntil <= 23)) return false;
  if (_lbPrevDeadlineHourOf(c) == null) return false;   // 締め切り時刻が不正なら午前ルール自体を使わない
  return _lbJstParts(startMs).h < mUntil;
}

// 予約の受付締め切り時刻(ms)。この時刻**以降**はその枠を予約できない。
//   ・午前枠＝前日 prevDeadlineHour 時。
//   ・それ以外＝開始の leadMinutes 前。
//   ・午前枠では両者の「早いほう」を採る（前日22時前でも、開始3時間前は必ず守る）。
function _lbBookingDeadlineMs(startMs, cfg) {
  var c = cfg || LB_BOOKING_DEFAULTS;
  var lead = Number(c.leadMinutes);
  if (!(isFinite(lead) && lead >= 0)) lead = LB_BOOKING_DEFAULTS.leadMinutes;
  var byLead = startMs - lead * 60000;
  if (!_lbIsMorningSlot(startMs, c)) return byLead;
  var pHour = _lbPrevDeadlineHourOf(c);
  if (pHour == null) return byLead;   // 不正設定＝従来動作にフォールバック（_lbIsMorningSlot で弾かれるので通常ここには来ない）
  var p = _lbJstParts(startMs);
  var byPrev = _lbJstMs(p.y, p.mo, p.d - 1, pHour, 0);
  return Math.min(byLead, byPrev);
}

// いま(nowMs)この枠を予約できるか。false＝締め切り済み。
function _lbBookingOpen(startMs, nowMs, cfg) {
  return nowMs < _lbBookingDeadlineMs(startMs, cfg);
}

// 締め切りの案内文（エラーと事前案内で同じ文言を使う＝顧客が混乱しない）
function _lbBookingDeadlineText(startMs, cfg) {
  var c = cfg || LB_BOOKING_DEFAULTS;
  if (_lbIsMorningSlot(startMs, c)) {
    return '午前のご予約は前日' + _lbPrevDeadlineHourOf(c) + '時までに承っております。';   // 不正値なら上で午前扱いにならない＝NaNは出ない
  }
  var m = Number(c.leadMinutes);
  var hh = (m % 60 === 0) ? (m / 60) + '時間' : m + '分';
  return 'ご予約は開始の' + hh + '前まで承っております。';
}

// 2つの時間帯が実際に重なるか（接するだけは重ならない）。2026-09-26。
//   CalendarApp.getEvents(start, end) は境界で接するだけの予定（end ちょうどに始まる予定）も返すため、
//   返り値をそのまま「競合あり」と扱うと、19:30開始の予約があるだけで 18:30〜19:30 が取れなくなる。
//   実例：[RESERVED] 体験_鈴木_野崎天平様_line（19:30〜20:30）で 18:30 の枠が予約できなかった。
function _lbOverlaps(aStartMs, aEndMs, bStartMs, bEndMs) {
  return aStartMs < bEndMs && aEndMs > bStartMs;
}

// カレンダーの予定が [start, end) と実際に重なるか（接するだけは除外）
function _lbEventOverlaps(ev, startMs, endMs) {
  if (!ev || typeof ev.getStartTime !== 'function') return true;   // 判定できないものは安全側で「重なる」
  var s = ev.getStartTime(), e = ev.getEndTime();
  if (!s || !e) return true;
  return _lbOverlaps(s.getTime(), e.getTime(), startMs, endMs);
}

// ============================================================
// 自動休憩：休憩の区間を決める（純粋関数・Node検証可能）— 決定0063 / 設計 ops/design/03-auto-break.md
// ============================================================
//
//   ★ここに置く理由
//     「カレンダーを読まないと確認できない形にしない」（設計§6-9）。
//     塊の終わり・休憩の長さ・次の埋まりの開始・シフトの終わりだけを受け取り、
//     書くべき区間を返す。カレンダーには一切触れない。
//
//   ★なぜ「切る」必要があるのか
//     1. 次の埋まりに重ならないため。いまは 休憩15分 ≦ 隙間15分 なので必ず収まるが、
//        この不変条件は設定で壊せる（休憩を30分にすると隙間15分の次の予定に重なる）。
//        設定で壊れたときに黙って重ねない。
//     2. シフトの終わりを越えないため。塊が退勤ちょうどに終わると休憩がシフト外に出る。
//        空き枠は無いので実害は無いが、トレーナーのカレンダーに意味のない予定が増える。
//
//   ★掃除バッチも**この同じ関数を通す**（設計§6-11）。
//     「塊の終わり＋15分」で比べると、シフト終わりで10分に切られた休憩を
//     毎日「違う」と判断して消してしまう。切った後の区間どうしで比べる。

var LB_AUTO_BREAK_DEFAULTS = { limitMin: 180, breakMin: 15, gapMin: 15 };

// 時刻として読めるか。
//   ★`Number(null)` は 0 で `isFinite` が真になる。この取り違えを何度も踏んでいる
//     （欠損が1970年扱いになり、巨大な埋まり区間ができて枠が全部消えた）。
//     欠けている値を 1970-01-01 として扱わないため、null・undefined・空文字は先に弾く。
//   ★文字列の数値は通す。設定（Script Properties）は文字列で来るため。
function _lbMsOk(v) {
  if (v == null || v === '') return false;
  var n = Number(v);
  return isFinite(n);
}

// 設定が不変条件を満たすか。満たさないなら③そのものを無効にする（黙って壊れた状態で動かさない）。
//   休憩の長さ > 隙間 だと、休憩が次のセッションに重なる（設計§6-9）。
function _lbAutoBreakCfgCheck(cfg) {
  var c = cfg || {};
  var limit = Number(c.limitMin), brk = Number(c.breakMin), gap = Number(c.gapMin);
  if (!isFinite(limit) || limit <= 0) return { ok: false, reason: 'bad_limit' };
  if (!isFinite(brk) || brk <= 0) return { ok: false, reason: 'bad_break' };
  if (!isFinite(gap) || gap < 0) return { ok: false, reason: 'bad_gap' };
  if (brk > gap) return { ok: false, reason: 'break_longer_than_gap' };
  return { ok: true, limitMin: limit, breakMin: brk, gapMin: gap };
}

// 塊が「休憩を入れるべき長さ」に達しているか。
//   ★`>=` で判定する。`>` だと 10:00-13:00（ちょうど180分）の3連続で入らない。
//     実測の「180分以上 6件」はこの数え方。数え方を2通りにしない（設計§5）。
function _lbAutoBreakNeeded(spanMinutes, limitMin) {
  var span = Number(spanMinutes);
  var limit = Number(limitMin);
  if (!isFinite(span) || !isFinite(limit)) return false;
  return span >= limit;
}

// 休憩の区間を決める。入れられないなら理由を返す。
//   opts: { runEndMs, breakMin, nextBusyMs（無ければ null）, shiftEndMs（無ければ null）}
//   返り: { ok:true, startMs, endMs, minutes, clipped } ／ { ok:false, reason }
function _lbAutoBreakClip(opts) {
  var o = opts || {};
  if (!_lbMsOk(o.runEndMs) || !_lbMsOk(o.breakMin)) return { ok: false, reason: 'bad_input' };
  var start = Number(o.runEndMs);
  var brkMs = Number(o.breakMin) * 60000;
  if (brkMs <= 0) return { ok: false, reason: 'bad_input' };

  var end = start + brkMs;
  var clipped = false;

  // シフトの外に出さない。**先に見る**（外に出ているなら理由はこちら）。
  if (_lbMsOk(o.shiftEndMs)) {
    var shift = Number(o.shiftEndMs);
    if (shift <= start) return { ok: false, reason: 'skip_outside_shift' };
    if (shift < end) { end = shift; clipped = true; }
  }

  // 次の埋まりに重ねない
  if (_lbMsOk(o.nextBusyMs)) {
    var next = Number(o.nextBusyMs);
    if (next <= start) return { ok: false, reason: 'skip_no_room' };
    if (next < end) { end = next; clipped = true; }
  }

  if (end <= start) return { ok: false, reason: 'skip_no_room' };
  return { ok: true, startMs: start, endMs: end,
           minutes: Math.round((end - start) / 60000), clipped: clipped };
}

// 冪等キー。同じ塊に対して休憩を二重に入れないための印。
//   ★塊の終わりを含める。同じ日に2回3連続が起きる実績があるため（設計§6-2）、
//     トレーナーIDと日付だけで作ると2つ目が入らない。
//   ★予約IDは使わない。振替や変更で予約が入れ替わっても、塊の終わりが同じなら同じ休憩である。
function _lbAutoBreakKey(trainerId, runEndMs) {
  var t = String(trainerId == null ? '' : trainerId);
  if (!t || !_lbMsOk(runEndMs)) return '';     // 欠けた時刻を 0（1970年）のキーにしない
  return t + '#' + Number(runEndMs);
}

// 2つの休憩区間が「同じもの」か。掃除バッチが消してよいかの判定に使う。
//   ★切った後どうしで比べる（設計§6-11）。分単位の丸めは入れない。
function _lbAutoBreakSame(a, b) {
  if (!a || !b) return false;
  // ★欠けた時刻どうしを「同じ」と判定しない。Number(null) は 0 なので、
  //   null 同士が 0===0 で一致してしまう。これは**誤って消す**側の事故になる。
  if (!_lbMsOk(a.startMs) || !_lbMsOk(a.endMs)) return false;
  if (!_lbMsOk(b.startMs) || !_lbMsOk(b.endMs)) return false;
  return Number(a.startMs) === Number(b.startMs) && Number(a.endMs) === Number(b.endMs);
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { _lbClassifyBooking: _lbClassifyBooking, _lbNormTok: _lbNormTok, _lbTransferCreditState: _lbTransferCreditState,
    _lbRecurringStartMs: _lbRecurringStartMs, _lbCountTicketConsumption: _lbCountTicketConsumption, _lbBookTypePrefix: _lbBookTypePrefix,
    _lbAssignTrainerByShift: _lbAssignTrainerByShift,
    LB_BOOKING_DEFAULTS: LB_BOOKING_DEFAULTS, _lbJstParts: _lbJstParts, _lbJstMs: _lbJstMs,
    _lbBookingCfg: _lbBookingCfg, _lbIsMorningSlot: _lbIsMorningSlot, _lbPrevDeadlineHourOf: _lbPrevDeadlineHourOf,
    _lbBookingDeadlineMs: _lbBookingDeadlineMs, _lbBookingOpen: _lbBookingOpen,
    _lbBookingDeadlineText: _lbBookingDeadlineText,
    _lbOverlaps: _lbOverlaps, _lbEventOverlaps: _lbEventOverlaps,
    LB_AUTO_BREAK_DEFAULTS: LB_AUTO_BREAK_DEFAULTS, _lbAutoBreakCfgCheck: _lbAutoBreakCfgCheck,
    _lbAutoBreakNeeded: _lbAutoBreakNeeded, _lbAutoBreakClip: _lbAutoBreakClip,
    _lbAutoBreakSame: _lbAutoBreakSame, _lbAutoBreakKey: _lbAutoBreakKey, _lbMsOk: _lbMsOk };
}
