// ============================================================
// まとめ取得（2026-09-29）
//
// なぜ必要か（2026-09-28 の実測に基づく）：
//   画面を開いて予約を終えるまでに、GASを13回呼んでいた。合計58.1秒。
//   このうち読み取り11回で45.8秒。
//
//   決定的だったのは「何もしない処理でも2.3〜3.8秒かかる」こと。
//   言語を保存するだけの setLang が3,840ms、キャッシュを返すだけの
//   getTrainerSlots が2,351ms。745KB・11,000行のスクリプトを
//   呼ぶたびに読み込み直すためで、処理の中身とは関係がない。
//   → 読み取り11回のうち約25秒は「起動しているだけ」の時間だった。
//
//   だから速くする一番の手は、処理を速くすることではなく、
//   呼ぶ回数を減らすことである。
//
// もう一段：
//   1回の呼び出しの中なら、同じシートを何度も読み直す必要がない。
//   _edgeWithSheetCache で読み込みを1回にまとめる。
//   （残数の押し出しで実証済み：150秒 → 9.7秒）
//
// ★写しは使わない。その場でシートから読むので、古い数字は出ない。
//   Cloudflareの写しで起きていた「古さ」の問題とは無関係の改善である。
//
// ★中身は既存の関数をそのまま呼ぶ。答えの形も変えない。
//   画面側は「1回で受け取る」だけで、描画コードは変えなくてよい。
// ============================================================

// 起動時に要るものを1回で返す。
//   トレーナー … 会員状態・担当予約・トレーナー一覧
//   会員       … 会員状態・残数・自分の予約・トレーナー一覧
function lbBoot(lineUserId) {
  var t0 = new Date().getTime();
  var out = { success: true, parts: {} };

  function part(name, fn) {
    var t = new Date().getTime();
    try { out.parts[name] = fn(); }
    catch (e) {
      // 1つ転んでも残りは返す。画面側はその部分だけ従来どおり個別に取り直せる。
      out.parts[name] = { success: false, code: 'PART_FAILED', message: String(e && e.message || e) };
      Logger.log('[boot] ' + name + ' で失敗: ' + (e && e.message));
    }
    Logger.log('[perf][boot] ' + name + ': ' + (new Date().getTime() - t) + 'ms');
  }

  _edgeWithSheetCache(function () {
    part('memberStatus', function () { return getMemberStatus(lineUserId); });
    var ms = out.parts.memberStatus;
    if (!ms || ms.success !== true) return;

    if (ms.role === 'trainer') {
      part('trainerReservations', function () { return getTrainerReservations(lineUserId); });
      part('trainers', function () { return getTrainers(lineUserId); });
    } else if (ms.verified) {
      part('myReservations', function () { return getMyReservations(lineUserId); });
      part('trainers', function () { return getTrainers(lineUserId); });
    }
  });

  out.ms = new Date().getTime() - t0;
  Logger.log('[perf][boot] 合計: ' + out.ms + 'ms');
  return out;
}

// トレーナーが顧客を開いたときに要るものを1回で返す。
//   ここも従来は 残数・体組成・固定枠 で3回呼んでいた。
function lbCustomerCard(lineUserId, customerId) {
  var t0 = new Date().getTime();
  var out = { success: true, parts: {} };
  if (!customerId) return { success: false, code: 'NO_CUSTOMER' };

  function part(name, fn) {
    var t = new Date().getTime();
    try { out.parts[name] = fn(); }
    catch (e) {
      out.parts[name] = { success: false, code: 'PART_FAILED', message: String(e && e.message || e) };
      Logger.log('[card] ' + name + ' で失敗: ' + (e && e.message));
    }
    Logger.log('[perf][card] ' + name + ': ' + (new Date().getTime() - t) + 'ms');
  }

  _edgeWithSheetCache(function () {
    part('customerHome', function () { return getCustomerHomeForTrainer(lineUserId, customerId); });
    part('recurring',    function () { return listRecurringPatternsByTrainer(lineUserId, customerId); });
    part('inBody',       function () {
      var pic = requireTrainer(lineUserId);
      if (!pic) return { success: false, code: 'FORBIDDEN' };
      // meal-ai は別系統。止まっていても予約の画面を巻き込まない。
      try { return maInBodyCard_(pic, customerId); }
      catch (e) { return { success: false, code: 'UNAVAILABLE' }; }
    });
  });

  out.ms = new Date().getTime() - t0;
  Logger.log('[perf][card] 合計: ' + out.ms + 'ms');
  return out;
}
