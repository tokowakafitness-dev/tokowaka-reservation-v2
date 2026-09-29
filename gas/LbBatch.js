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
// まとめ取得の間は読み取りだけに縛る。
//   _edgeWithSheetCache は最初に読んだ内容を配る仕組みなので、
//   途中で書き込むと「書いたのに古い値を読む」が静かに起きる。
//   いまの中身は読み取りだけだが、あとから誰かが保存処理を足したときに
//   気づけるよう、書き込みを試みたらその場で止める。
function _lbReadOnly(fn) {
  // ★禁止するものを並べるのではなく、許すものだけを並べる。
  //   禁止の列挙は必ず漏れる（deleteRows・clearContents・copyTo・
  //   createTextFinder().replaceAllWith() など、書ける経路は非常に多い）。
  //   漏れたときに「静かに書けてしまう」のではなく「止まる」側へ倒す。
  function readOnly(obj, what) {
    if (!obj || typeof obj !== 'object') return obj;
    return new Proxy(obj, {
      get: function (t, k) {
        var name = String(k);
        var v = t[k];
        if (typeof v !== 'function') return v;
        // 読み取りとして許すもの（get* と、値を変えない数少ないもの）
        var allowed = (name.indexOf('get') === 0) || name === 'toString' || name === 'valueOf';
        if (!allowed) {
          throw new Error('まとめ取得の中は読み取りだけです（' + what + '.' + name + ' は使えません）');
        }
        return function () {
          return readOnly(v.apply(t, arguments), what + '.' + name);
        };
      },
    });
  }

  // ★シートを手に入れる入口は1つではない。
  //   _lbSheet だけ包んでも、_lbContractSheet や MealAi の maOpenSs_ は
  //   SpreadsheetApp.openById() から直接シートを取るため素通しになる。
  //   まとめ取得が通る入口はすべて包む（Codex指摘 2026-09-29）。
  var GATES = ['_lbSheet', '_lbSs', '_lbContractSheet', 'maOpenSs_', 'maSheet_'];

  return _edgeWithSheetCache(function () {
    var saved = {};
    for (var i = 0; i < GATES.length; i++) {
      var g = GATES[i];
      if (typeof globalThis[g] !== 'function') continue;
      saved[g] = globalThis[g];
      (function (name, orig) {
        globalThis[name] = function () { return readOnly(orig.apply(null, arguments), name); };
      })(g, globalThis[g]);
    }
    try { return fn(); }
    finally { for (var k in saved) globalThis[k] = saved[k]; }
  });
}

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

  _lbReadOnly(function () {
    part('memberStatus', function () { return getMemberStatus(lineUserId); });
    var ms = out.parts.memberStatus;
    // ★会員状態はまとめの前提。ここが転んだら、まとめ全体を失敗として返す。
    //   success:true のまま転んだ中身を返すと、画面がそれを会員状態として
    //   解釈して起動できなくなる（2026-09-29 Codex指摘）。
    if (!ms || ms.success !== true) { out.success = false; out.code = 'BOOT_MEMBER_FAILED'; return; }

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
  // ★先頭で1回だけ確かめる。中の3つも各自で確かめるが、
  //   トレーナーでない人に3つとも走らせる意味がない。
  var pic = requireTrainer(lineUserId);
  if (!pic) return { success: false, code: 'FORBIDDEN' };

  function part(name, fn) {
    var t = new Date().getTime();
    try { out.parts[name] = fn(); }
    catch (e) {
      out.parts[name] = { success: false, code: 'PART_FAILED', message: String(e && e.message || e) };
      Logger.log('[card] ' + name + ' で失敗: ' + (e && e.message));
    }
    Logger.log('[perf][card] ' + name + ': ' + (new Date().getTime() - t) + 'ms');
  }

  _lbReadOnly(function () {
    part('customerHome', function () { return getCustomerHomeForTrainer(lineUserId, customerId); });
    part('recurring',    function () { return listRecurringPatternsByTrainer(lineUserId, customerId); });
    part('inBody',       function () {
      // meal-ai は別系統。止まっていても予約の画面を巻き込まない。
      try { return maInBodyCard_(pic, customerId); }
      catch (e) { return { success: false, code: 'UNAVAILABLE' }; }
    });
  });

  out.ms = new Date().getTime() - t0;
  Logger.log('[perf][card] 合計: ' + out.ms + 'ms');
  return out;
}
