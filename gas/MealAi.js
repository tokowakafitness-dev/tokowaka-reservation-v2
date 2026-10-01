/**
 * ============================================================
 *  MealAi.js — meal-ai（目標設計・体重計測・のちに食事）
 * ------------------------------------------------------------
 *  予約システムとは完全に分離する。このファイル以外を編集しない。
 *  webhook からの呼び出しは try/catch で囲み、
 *  ここで何が起きても予約が止まらないようにする（設計 §2.1）。
 *
 *  設計：30_projects/personal-training/meal-ai/moduleA-design.md
 *  決定：0057（PFC基準）／0058（期の連なり・A0）
 * ============================================================
 */

/** Script Properties のキー */
var MA_PROP = {
  SS_ID: 'MEAL_SS_ID',
  SS_ID_STAGING: 'MEAL_SS_ID_STAGING',
  TESTERS: 'MEAL_TESTERS',       // カンマ区切りのLINE userId。ここに居る人にだけ機能が開く
  TESTER_NAMES: 'MEAL_TESTER_NAMES'  // カンマ区切りの氏名。オーナーはこちらを編集する
};

/** シート定義。1行目にこの見出しを書く */
var MA_SHEETS = {
  // ---- A1・A2 で使う ----
  meal_config: {
    note: '係数の既定値。トレーナーが編集する。空欄なら初期値に戻る',
    header: ['key', 'value', '意味', '動かす時の目安']
  },
  meal_goals: {
    note: '契約単位で1行。最終目標と期限',
    header: ['customer_id', '氏名', '契約開始日', '契約終了日', '性別', '生年月日', '身長cm',
             '活動レベル', '開始体重kg', '開始除脂肪kg', '最終目標体重kg', '最終目標体脂肪量kg',
             '最終目標除脂肪kg', 'テンプレート', '状態', '作成日時', '更新日時', '備考']
  },
  goal_phases: {
    note: '期（減量/維持/増量）。上書きせず積む（決定0058）',
    header: ['customer_id', 'phase_no', '種別', '開始日', '終了日', '日数',
             '開始体重kg', '目標体重kg', '週あたりkg', '目標kcal', 'P_g', 'F_g', 'C_g',
             '状態', '確定者', '確定日時', '備考']
  },
  body_log: {
    note: '体重・体組成。モジュールB（3D）の入力にもなる',
    header: ['customer_id', '日付', '体重kg', '体脂肪率', '除脂肪kg', '体水分L', '内臓脂肪',
             '測定元', '入力者', '記録日時', '備考']
  },
  trainer_notes: {
    note: 'トレーナーの所見',
    header: ['customer_id', '日付', 'トレーナー', '種別', '内容', '記録日時']
  },
  // ---- 食事フェーズ（A4以降）で使う。器だけ先に作る ----
  meal_logs: {
    note: '1食1行。食事フェーズで使う',
    header: ['log_id', 'customer_id', '日時', '区分', '入力方法', 'message_id',
             'AI_kcal', 'AI_P', 'AI_F', 'AI_C', 'AI品目', 'AI信頼度',
             '食べた割合', '確定kcal', '確定P', '確定F', '確定C',
             '補正者', '補正日時', '元値JSON', '備考']
  },
  meal_daily: {
    note: '日次集計のキャッシュ',
    header: ['customer_id', '日付', '記録数', 'kcal', 'P', 'F', 'C', '目標差kcal', '更新日時']
  },
  ai_spend: {
    note: 'AI利用のコスト台帳・上限管理',
    header: ['日付', 'customer_id', 'モデル', '入力トークン', '出力トークン', '概算費用円', '用途']
  },
  meal_consent: {
    note: '同意記録',
    header: ['customer_id', '同意日時', '文言バージョン', '経路', '撤回日時']
  }
};

/** meal_config の初期値（決定0057 §6.2） */
var MA_CONFIG_DEFAULTS = [
  ['protein_per_lean_kg',       2.4,   'P：除脂肪1kgあたりのg',            '増量期は2.0〜2.2 / 競技者2.6'],
  ['protein_per_body_fallback', 2.0,   'P：除脂肪が無い時の体重1kgあたりg', '—'],
  ['protein_floor_per_body',    1.2,   'P：下限（体重1kgあたりg）',        '—'],
  ['protein_cap_per_body',      2.5,   'P：上限（体重1kgあたりg）',        '—'],
  ['fat_pct_of_kcal',           0.25,  'F：目標kcalに対する比率',          '0.20〜0.30'],
  ['fat_floor_per_body',        0.8,   'F：下限（体重1kgあたりg）',        '下げない（健康被害に直結）'],
  ['fat_cap_pct_of_kcal',       0.35,  'F：上限比率',                      '—'],
  ['carb_floor_per_body',       2.0,   'C：下限（体重1kgあたりg）',        '1.5〜3.0'],
  ['kcal_adjust_cut',          -400,   '減量時の調整kcal',                 '−300〜−500'],
  ['kcal_adjust_keep',            0,   '維持時の調整kcal',                 '—'],
  ['kcal_adjust_bulk',         +250,   '増量時の調整kcal',                 '+200〜+300'],
  ['rate_max_pct_per_week',     1.0,   '週あたり体重変化の上限（%）',      '下げる方向のみ推奨'],
  ['activity_1',                1.2,   '活動係数：ほぼ座位',               '—'],
  ['activity_2',                1.375, '活動係数：週1〜3回運動',           '—'],
  ['activity_3',                1.55,  '活動係数：週3〜5回運動',           '—'],
  ['activity_4',                1.725, '活動係数：週6〜7回運動',           '—'],
  ['bulk_gain_per_week',        0.12,  '増量期の週あたり増加kg',           '0.08〜0.20'],
  ['template_3m',  'cut:10,keep:2',                          '3ヶ月契約の既定の組み方', '週数で指定'],
  ['template_6m',  'cut:12,keep:2,bulk:6,cut:6',             '6ヶ月契約の既定の組み方', '週数で指定'],
  ['template_12m', 'cut:12,keep:2,bulk:6,cut:6,keep:2,bulk:8,cut:8,keep:2', '12ヶ月契約の既定の組み方', '週数で指定']
];

/**
 * 初回の1回だけ実行する。オーナーがGASエディタから手動で実行。
 * 本番用とstaging用のスプレッドシートを作り、IDをScript Propertiesへ保存する。
 * 2回目以降は既存を検出して何もしない（冪等）。
 */
function setupMealSheets() {
  var props = PropertiesService.getScriptProperties();
  var result = [];

  [['本番', MA_PROP.SS_ID, 'meal-ai データ'],
   ['staging', MA_PROP.SS_ID_STAGING, 'meal-ai データ（staging）']].forEach(function (t) {
    var label = t[0], key = t[1], name = t[2];
    var id = props.getProperty(key);

    if (id) {
      try {
        var existing = SpreadsheetApp.openById(id);
        var added = maEnsureSheets_(existing);
        result.push(label + '：既存を使用（' + existing.getName() + '）'
          + (added.length ? ' ／ 追加したシート: ' + added.join(', ') : ' ／ 変更なし'));
        return;
      } catch (e) {
        result.push(label + '：保存されていたIDを開けなかったので作り直します（' + e.message + '）');
      }
    }

    var ss = SpreadsheetApp.create(name);
    maEnsureSheets_(ss);
    var first = ss.getSheets()[0];
    if (first.getName() === 'シート1' || first.getName() === 'Sheet1') ss.deleteSheet(first);
    props.setProperty(key, ss.getId());
    result.push(label + '：新規作成\n    ' + ss.getUrl());
  });

  var msg = '=== meal-ai セットアップ完了 ===\n' + result.join('\n');
  Logger.log(msg);
  return msg;
}

/** 足りないシートだけ作る。既にあるシートには触らない */
function maEnsureSheets_(ss) {
  var added = [];
  Object.keys(MA_SHEETS).forEach(function (name) {
    if (ss.getSheetByName(name)) return;
    var def = MA_SHEETS[name];
    var sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, def.header.length).setValues([def.header])
      .setFontWeight('bold').setBackground('#f0ece3');
    sh.setFrozenRows(1);
    sh.getRange(1, 1).setNote(def.note);
    if (name === 'meal_config') {
      sh.getRange(2, 1, MA_CONFIG_DEFAULTS.length, 4).setValues(MA_CONFIG_DEFAULTS);
      sh.setColumnWidth(1, 210); sh.setColumnWidth(3, 260); sh.setColumnWidth(4, 240);
    }
    added.push(name);
  });
  return added;
}

var MA_CFG_CACHE_KEY = 'meal_cfg_v1';
var MA_CFG_CACHE_SEC = 600;   // 10分。トレーナーが編集したら maClearConfigCache() で即反映できる

/**
 * 現在の設定を読む。空欄やシート未作成なら初期値を返す。
 *
 * 実測（2026-09-21）：シートから素直に読むと **1058ms** かかる。
 * 内訳の大半は SpreadsheetApp.openById（1回あたり約220ms）。
 * よって ①キャッシュに載せる ②既に開いているSSがあれば渡してもらう、の2段構えにする。
 * なお設定が要るのは目標を計算する時だけで、体重記録の経路では読まない。
 *
 * @param {Spreadsheet} [ss] 既に開いているSSがあれば渡す（開き直しを避ける）
 */
function maGetConfig(ss) {
  var cfg = {};
  MA_CONFIG_DEFAULTS.forEach(function (r) { cfg[r[0]] = r[1]; });

  var cache = CacheService.getScriptCache();
  var hit = cache.get(MA_CFG_CACHE_KEY);
  if (hit) {
    try {
      var parsed = JSON.parse(hit);
      Object.keys(parsed).forEach(function (k) { cfg[k] = parsed[k]; });
      return cfg;
    } catch (e) { /* 壊れていたら読み直す */ }
  }

  try {
    var book = ss || maOpenSs_();
    var sh = book.getSheetByName('meal_config');
    if (sh && sh.getLastRow() >= 2) {
      var over = {};
      sh.getRange(2, 1, sh.getLastRow() - 1, 2).getValues().forEach(function (r) {
        var k = String(r[0]).trim();
        if (k && r[1] !== '' && r[1] !== null) { cfg[k] = r[1]; over[k] = r[1]; }
      });
      cache.put(MA_CFG_CACHE_KEY, JSON.stringify(over), MA_CFG_CACHE_SEC);
    }
  } catch (e) {
    Logger.log('maGetConfig: 初期値で継続 — ' + e.message);
  }
  return cfg;
}

/** 設定シートを編集したあと、待たずに反映させる */
function maClearConfigCache() {
  CacheService.getScriptCache().remove(MA_CFG_CACHE_KEY);
  var msg = '設定のキャッシュを消しました。次の呼び出しでシートの値を読み直します。';
  Logger.log(msg);
  return msg;
}

/** staging と本番の切り替え。デプロイIDで判定する（憲法13節） */
var MA_SS_HANDLE = null;      // 1回の実行の中だけ有効（GASは実行ごとにグローバルを捨てる）
var MA_SH_CACHE = {};

function maOpenSs_() {
  if (MA_SS_HANDLE) return MA_SS_HANDLE;
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(MA_PROP.SS_ID);
  if (!id) throw new Error('setupMealSheets() をまだ実行していません');
  MA_SS_HANDLE = SpreadsheetApp.openById(id);
  return MA_SS_HANDLE;
}

/** シート取得も実行内で使い回す。openById と getSheetByName は毎回往復が発生する */
function maSheet_(name) {
  if (MA_SH_CACHE[name]) return MA_SH_CACHE[name];
  var sh = maOpenSs_().getSheetByName(name);
  if (sh) MA_SH_CACHE[name] = sh;
  return sh;
}

/** 動作確認用。オーナーが実行して結果を玄に伝えるためのもの */
function maSelfCheck() {
  var lines = [];
  var props = PropertiesService.getScriptProperties();
  ['本番', 'staging'].forEach(function (label, i) {
    var key = i === 0 ? MA_PROP.SS_ID : MA_PROP.SS_ID_STAGING;
    var id = props.getProperty(key);
    if (!id) { lines.push(label + '：未作成'); return; }
    try {
      var ss = SpreadsheetApp.openById(id);
      var names = ss.getSheets().map(function (s) { return s.getName(); });
      var missing = Object.keys(MA_SHEETS).filter(function (n) { return names.indexOf(n) < 0; });
      lines.push(label + '：OK シート' + names.length + '枚'
        + (missing.length ? ' ／ 不足: ' + missing.join(', ') : '')
        + '\n    ' + ss.getUrl());
    } catch (e) {
      lines.push(label + '：開けない — ' + e.message);
    }
  });
  var cfg = maGetConfig();
  lines.push('設定値の読み取り：P=除脂肪×' + cfg.protein_per_lean_kg
    + ' ／ F下限=体重×' + cfg.fat_floor_per_body
    + ' ／ 減量調整=' + cfg.kcal_adjust_cut + 'kcal');
  var msg = '=== meal-ai セルフチェック ===\n' + lines.join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 実測用。スプレッドシートの読み書きが実際に何ミリ秒かかるかを測る。
 * 「GAS＋シートは遅いのではないか」を推測でなく数字で判断するためのもの。
 * staging のSSに対して実行する（本番データは触らない）。
 */
function maBenchmark() {
  var props = PropertiesService.getScriptProperties();
  var id = props.getProperty(MA_PROP.SS_ID_STAGING);
  if (!id) return 'staging が未作成です。先に setupMealSheets() を実行してください';
  var out = [];
  var t0 = Date.now();

  var ss = SpreadsheetApp.openById(id);
  out.push(['スプレッドシートを開く', Date.now() - t0]);

  var t = Date.now();
  var sh = ss.getSheetByName('body_log');
  out.push(['シートを取得', Date.now() - t]);

  // 90日分のダミーを一括で書く（1行ずつではなく1回のsetValues）
  t = Date.now();
  var rows = [];
  for (var i = 0; i < 90; i++) {
    rows.push(['BENCH', new Date(Date.now() - i * 86400000), 68 + (i % 7) * 0.1, 20.1, 54.9, 40.2, 8, 'self', 'bench', new Date(), '']);
  }
  sh.getRange(sh.getLastRow() + 1, 1, rows.length, rows[0].length).setValues(rows);
  out.push(['90行を一括書き込み', Date.now() - t]);

  t = Date.now();
  sh.appendRow(['BENCH', new Date(), 68.2, '', '', '', '', 'self', 'bench', new Date(), '1行追記']);
  out.push(['1行を追記（会員の体重記録1回に相当）', Date.now() - t]);

  t = Date.now();
  var all = sh.getDataRange().getValues();
  out.push(['全件を一括読み（' + all.length + '行）', Date.now() - t]);

  t = Date.now();
  var mine = all.filter(function (r) { return r[0] === 'BENCH'; });
  out.push(['絞り込み（メモリ内・' + mine.length + '行）', Date.now() - t]);

  maClearConfigCache();
  t = Date.now();
  maGetConfig(ss);
  out.push(['設定を読む（キャッシュなし・SSは開き直さない）', Date.now() - t]);

  t = Date.now();
  maGetConfig(ss);
  out.push(['設定を読む（キャッシュあり）', Date.now() - t]);

  // 片付け
  t = Date.now();
  var last = sh.getLastRow();
  sh.deleteRows(last - rows.length, rows.length + 1);
  out.push(['後片付け（削除）', Date.now() - t]);

  var total = Date.now() - t0;
  // 実行者のメールは取らない。userinfo.email スコープが必要になり、
  // 防御を緩める変更にあたるため（2026-09-21に一度踏んだ）。
  var msg = '=== 実測（staging）===\n'
    + out.map(function (r) { return '  ' + String(r[1]).padStart(6) + ' ms  ' + r[0]; }).join('\n')
    + '\n  ------\n  ' + String(total).padStart(6) + ' ms  合計'
    + '\n\n判断の目安：会員がLINEに体重を送ってから返信までは「1行を追記」＋LINEへの返信で決まる。';
  Logger.log(msg);
  return msg;
}

/* ============================================================
 *  体重記録（A2）— LINEに数値を送るだけで記録する
 *  ここは会員が毎日通る経路。往復の回数を最小にする。
 *  実測（2026-09-21）：SSを開く220ms／1行追記160ms。
 *  よって「開くのは1回」「読むのはキャッシュから」を徹底する。
 * ============================================================ */

var MA_MAP_CACHE_SEC = 21600;  // LINE userId → 会員 の対応は6時間。
                               // 見つかった場合しかキャッシュしないので、新規登録は待たずに反映される。
                               // ここが切れるたび予約側シートの全件走査が走るため、短いと毎回遅くなる。

/**
 * webhook の message イベント入口。
 * **絶対に外へ例外を投げない。** 予約側を巻き込まないため（設計 §2.1）。
 * @return {boolean} 自分が処理したら true（＝予約側は何もしない）
 */
function _maHandleMessageInner(ev) {
  try {
    if (!ev || ev.type !== 'message' || !ev.message || ev.message.type !== 'text') return false;
    var uid = ev.source && ev.source.userId;

    // ★公開前の門番。テスターに登録された人以外には、この機能は存在しないものとして扱う。
    //   返信もしないので、会員から見れば従来どおり（スタッフが手動で返す）。
    //   プロパティが空なら誰にも開かない＝安全側に倒す。
    if (!maIsTester_(uid)) return false;

    var text = String(ev.message.text || '').trim();

    // キーワードで入力カードを出す（リッチメニューは公開時に作る）
    if (MA_TRIGGER.test(text)) {
      var c0 = maLookupCustomer_(uid);
      maMark_('会員照合');
      if (!c0) { _lbReply(ev.replyToken, '会員情報が確認できませんでした。'); return true; }
      var prev = maLastValue_(c0.customerId, 2);
      maMark_('前回値');
      maReplyFlex_(ev.replyToken, '体重の入力',
        maInputBubble_({ title: '今日の体重は？',
          sub: prev ? '前回 ' + prev.v.toFixed(1) + 'kg（' + prev.date + '）' : '前回の記録がありません',
          center: prev ? prev.v : 65.0, step: 0.1, kind: 'w' }));
      maMark_('返信');
      return true;
    }

    // 「直接入力する」を押した直後なら、送られた数値をその項目として扱う。
    // これが無いと、体脂肪率のつもりで送った 9.9% が体重パーサに弾かれて無反応になる（実機で判明）。
    var awaiting = maGetAwait_(uid);
    if (awaiting) {
      maClearAwait_(uid);
      var c1 = maLookupCustomer_(uid);
      if (!c1) { _lbReply(ev.replyToken, '会員情報が確認できませんでした。'); return true; }
      if (awaiting === 'f') {
        var pct = maParsePercent_(text);
        if (pct === null) {
          _lbReply(ev.replyToken, '体脂肪率として読み取れませんでした（3〜60の範囲の数値で送ってください）。\nやり直す場合は「体重」と送ってください。');
          return true;
        }
        _lbReply(ev.replyToken, maLogFat_(c1.customerId, pct));
        return true;
      }
      if (awaiting === 'w') {
        var kgm = maParseWeight_(text);
        if (kgm === null) {
          _lbReply(ev.replyToken, '体重として読み取れませんでした（20〜250の範囲の数値で送ってください）。\nやり直す場合は「体重」と送ってください。');
          return true;
        }
        var rm = maLogWeight_(c1.customerId, kgm);
        maReply_(ev.replyToken, [
          maTextMsg_(maBuildWeightReply_(c1, kgm, rm)),
          maFlexMsg_('体脂肪率の確認', maAskFatBubble_())
        ]);
        return true;
      }
    }

    var kg = maParseWeight_(text);
    if (kg === null) return false;                    // 体重に見えない＝自分の担当ではない

    var cust = maLookupCustomer_(uid);
    if (!cust) {
      _lbReply(ev.replyToken, '会員情報が確認できませんでした。メニューから会員登録をお願いします。\n（すでに登録済みの場合はトレーナーにお伝えください）');
      return true;
    }
    var res = maLogWeight_(cust.customerId, kg);
    _lbReply(ev.replyToken, maBuildWeightReply_(cust, kg, res));
    return true;
  } catch (err) {
    Logger.log('_maHandleMessage: ' + err.message + '\n' + (err.stack || ''));
    try { _lbReply(ev.replyToken, '記録できませんでした。少し時間をおいて、もう一度お送りください。'); } catch (e2) {}
    return true;   // 失敗しても自分の担当として閉じる（予約側へ流さない）
  }
}

/**
 * 体重に見えるか判定する。
 * 「68.2」「68.2kg」「68,2」まで許す。それ以外は null を返し、食事や予約の邪魔をしない。
 * 20〜250kg の範囲外は体重として扱わない（誤爆防止）。
 */
function maParseWeight_(text) {
  var t = text.replace(/[０-９．，]/g, function (c) {
    return String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/,/g, '.').replace(/\s/g, '');
  var m = /^(\d{2,3}(?:\.\d{1,2})?)(?:kg|ｷﾛ|キロ)?$/i.exec(t);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!(v >= 20 && v <= 250)) return null;
  return Math.round(v * 10) / 10;
}

/**
 * 体脂肪率に見えるか判定する。「19.9」「19.9%」「１９．９％」まで許す。
 * 3〜60% の範囲外は体脂肪率として扱わない（誤爆防止）。
 */
function maParsePercent_(text) {
  var t = String(text).replace(/[０-９．，％]/g, function (c) {
    return c === '％' ? '%' : String.fromCharCode(c.charCodeAt(0) - 0xFEE0);
  }).replace(/,/g, '.').replace(/\s/g, '');
  var m = /^(\d{1,2}(?:\.\d{1,2})?)%?$/.exec(t);
  if (!m) return null;
  var v = parseFloat(m[1]);
  if (!(v >= 3 && v <= 60)) return null;
  return Math.round(v * 10) / 10;
}

/* --- 「次に送られる数値が何か」を覚えておく。直接入力の文脈 --- */
function maSetAwait_(uid, kind) { CacheService.getScriptCache().put('ma_await_' + uid, kind, 300); }
function maGetAwait_(uid) { return CacheService.getScriptCache().get('ma_await_' + uid); }
function maClearAwait_(uid) { CacheService.getScriptCache().remove('ma_await_' + uid); }

/** LINE userId から会員を引く。毎回シートを読まずキャッシュに載せる */
function maLookupCustomer_(lineUserId) {
  if (!lineUserId) return null;
  var cache = CacheService.getScriptCache();
  var key = 'ma_map_' + lineUserId;
  var hit = cache.get(key);
  if (hit) { try { return JSON.parse(hit); } catch (e) {} }

  // 予約側の既存関数を流用する。戻り値は {row, data} で、data は行の生配列。
  // プロパティ名（customerId 等）では取れない。列番号は MAP_COL を使う。
  var rec = getCustomerByLine(lineUserId);
  if (!rec || !rec.data) { Logger.log('maLookupCustomer_: 該当行なし uid=' + String(lineUserId).slice(0, 8) + '…'); return null; }
  var d = rec.data;
  var cust = {
    customerId: String(d[MAP_COL.CUSTOMER_ID - 1] || ''),
    name:       String(d[MAP_COL.NAME - 1] || ''),
    authState:  String(d[MAP_COL.AUTH_STATE - 1] || ''),
    contract:   String(d[MAP_COL.CONTRACT_STAT - 1] || ''),
    row: rec.row
  };
  if (!cust.customerId) {
    Logger.log('maLookupCustomer_: 顧客IDが空（行' + rec.row + '・認証=' + cust.authState + '）');
    return null;
  }
  cache.put(key, JSON.stringify(cust), MA_MAP_CACHE_SEC);
  return cust;
}

/* ============================================================
 *  会員ごとのスナップショット（返信を速くするための土台）
 *
 *  返信文に要るのは「前回値・直近の履歴・今日の行」だけで、いずれも小さい。
 *  これをキャッシュに常駐させ、書いた時に更新する（write-through）。
 *  結果、2回目以降のやり取りは body_log を一切読まずに返せる。
 *
 *  キャッシュが消えても壊れない：シートから作り直すだけ（遅くなるだけ）。
 *  真実は常に body_log にあり、キャッシュはその写し。
 * ============================================================ */
var MA_SNAP_SEC = 21600;      // 6時間

function maSnapKey_(customerId) { return 'ma_snap_' + customerId; }

function maSnapGet_(customerId) {
  try {
    var hit = CacheService.getScriptCache().get(maSnapKey_(customerId));
    if (hit) {
      var snap = JSON.parse(hit);
      if (snap && snap.built === maToday_()) return snap;   // 日付が変わったら作り直す
    }
  } catch (e) {}
  return maSnapRebuild_(customerId);
}

function maSnapPut_(customerId, snap) {
  try {
    snap.recent = (snap.recent || []).slice(0, 20);
    CacheService.getScriptCache().put(maSnapKey_(customerId), JSON.stringify(snap), MA_SNAP_SEC);
  } catch (e) {}
}

/** トレーナーがInBodyを入れた時など、外から書かれたら写しを捨てる */
function maSnapClear_(customerId) {
  try { CacheService.getScriptCache().remove(maSnapKey_(customerId)); } catch (e) {}
}

/** body_log の末尾を1回だけ読んで写しを作る。ここだけがシートに触る */
function maSnapRebuild_(customerId) {
  var today = maToday_();
  var snap = { built: today, recent: [], lastW: null, lastF: null, lastLean: null,
               todayRow: 0, todayKg: null };
  var sh = maSheet_('body_log');
  if (!sh) return snap;
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var from = Math.max(2, lastRow - 800);
    var vals = sh.getRange(from, 1, lastRow - from + 1, 5).getValues();
    var limit = maShiftDays_(today, -14);
    for (var i = vals.length - 1; i >= 0; i--) {          // 新しい行から見る
      if (String(vals[i][0]) !== String(customerId)) continue;
      var d = maDateStr_(vals[i][1]);
      var w = Number(vals[i][2]), f = Number(vals[i][3]), l = Number(vals[i][4]);
      if (d === today) {
        if (!snap.todayRow) { snap.todayRow = from + i; snap.todayKg = w || null; }
      } else {
        if (l && !snap.lastLean) snap.lastLean = { v: l, date: d };
      }
      if (w && !snap.lastW) snap.lastW = { v: w, date: d };
      if (f && !snap.lastF) snap.lastF = { v: f, date: d };
      if (w && d >= limit) snap.recent.push({ date: d, kg: w });
      if (snap.recent.length >= 20 && snap.lastW && snap.lastF && snap.lastLean) break;
    }
  }
  maSnapPut_(customerId, snap);
  return snap;
}

/** body_log へ1行追記する。2回目以降はシートを読まずに追記だけで済む */
function maLogWeight_(customerId, kg) {
  var snap = maSnapGet_(customerId);
  var sh = maSheet_('body_log');
  if (!sh) throw new Error('body_log が無い。setupMealSheets() を実行してください');

  var today = maToday_();
  var prev = snap.recent || [];
  var sameDay = prev.filter(function (r) { return r.date === today; });

  sh.appendRow([customerId, today, kg, '', '', '', '', 'self', 'line', new Date(),
                sameDay.length ? '同日再送' : '']);

  // 写しを更新する。次回はシートを読まずに返せる
  snap.todayRow = sh.getLastRow();
  snap.todayKg = kg;
  snap.lastW = { v: kg, date: today };
  snap.recent = [{ date: today, kg: kg }]
                  .concat(prev.filter(function (r) { return r.date !== today; }));
  maSnapPut_(customerId, snap);

  var last = prev.filter(function (r) { return r.date !== today; })
                 .sort(function (a, b) { return a.date < b.date ? 1 : -1; })[0] || null;
  var avg7 = maAvg_(prev.filter(function (r) { return r.date !== today; }).slice(0, 7).map(function (r) { return r.kg; }));
  return { today: today, isRepeat: sameDay.length > 0, last: last,
           avg7: avg7, count: prev.length + 1 };
}

/** 指定会員の直近n日ぶんだけ読む。シートが育っても全件スキャンしない */
function maRecentWeights_(sh, customerId, days) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  // 1会員1日1行の想定で、余裕を見て後ろから読む
  var span = Math.min(lastRow - 1, days * 40 + 200);
  var from = Math.max(2, lastRow - span + 1);
  var vals = sh.getRange(from, 1, lastRow - from + 1, 3).getValues();
  var limit = maShiftDays_(maToday_(), -days);
  var out = [];
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) !== String(customerId)) continue;
    var d = maDateStr_(vals[i][1]);
    if (d < limit) break;
    var w = Number(vals[i][2]);
    if (w) out.push({ date: d, kg: w });
  }
  return out;
}

/** 返信文。数字を並べるだけにせず、読み方を一言添える */
function maBuildWeightReply_(cust, kg, res) {
  var lines = ['記録しました。' + kg.toFixed(1) + 'kg（' + res.today + '）'];
  if (res.isRepeat) lines[0] += '\n※本日2回目です。最新の値で見ます';
  if (res.last) {
    var d = kg - res.last.kg;
    lines.push('前回（' + res.last.date + '）から ' + (d >= 0 ? '+' : '−') + Math.abs(d).toFixed(1) + 'kg');
  }
  if (res.avg7 !== null) {
    lines.push('直近7回の平均 ' + res.avg7.toFixed(1) + 'kg');
    lines.push('体重は水分で1〜2kg動きます。日々の増減より平均の傾きを見てください。');
  } else if (res.count < 4) {
    lines.push('あと' + (4 - res.count) + '回記録すると、平均の線が出ます。');
  }
  return lines.join('\n');
}

/* --- 小物 --- */
function maToday_() { return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd'); }
function maDateStr_(v) {
  if (v instanceof Date) return Utilities.formatDate(v, 'Asia/Tokyo', 'yyyy-MM-dd');
  return String(v).slice(0, 10);
}
function maShiftDays_(ymd, n) {
  var p = ymd.split('-');
  var d = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2]));
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function maAvg_(arr) {
  if (!arr || arr.length < 4) return null;      // 4回未満では線を引かない（嘘の平均を出さない）
  var s = 0; for (var i = 0; i < arr.length; i++) s += arr[i];
  return s / arr.length;
}

/** 体重パーサの自己テスト。オーナーが実行して結果を貼れる */
function maTestParser() {
  var cases = [
    ['68.2', 68.2], ['68', 68], ['68.2kg', 68.2], ['68.2KG', 68.2],
    ['６８．２', 68.2], ['68,2', 68.2], [' 68.2 ', 68.2], ['68.25', 68.3],
    ['予約したい', null], ['明日9時', null], ['8', null], ['300', null],
    ['68.2です', null], ['', null], ['2026', null]
  ];
  var ng = [];
  cases.forEach(function (c) {
    var got = maParseWeight_(c[0]);
    if (got !== c[1]) ng.push('「' + c[0] + '」→ 期待 ' + c[1] + ' / 実際 ' + got);
  });
  var msg = ng.length ? '✗ ' + ng.length + '件失敗\n  ' + ng.join('\n  ')
                      : '✓ ' + cases.length + '件すべて期待どおり';
  Logger.log(msg);
  return msg;
}

/**
 * customer_line_map の状態を確認する。
 * 「会員情報が確認できません」と返る時に、原因が紐付けか実装かを切り分けるためのもの。
 * 個人情報を出さないよう、氏名は伏せ、LINE IDは先頭のみ表示する。
 */
function maCheckLinkage() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return 'customer_line_map が読めません';
  var last = sh.getLastRow();
  if (last < 2) return 'customer_line_map が空です';
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.AUTH_STATE).getValues();
  var stat = { verified: 0, pending: 0, other: 0, noCustomerId: 0 };
  var samples = [];
  vals.forEach(function (r, i) {
    var auth = String(r[MAP_COL.AUTH_STATE - 1] || '');
    var cid  = String(r[MAP_COL.CUSTOMER_ID - 1] || '');
    if (auth === 'verified') stat.verified++;
    else if (auth === 'pending') stat.pending++;
    else stat.other++;
    if (!cid) {
      stat.noCustomerId++;
      if (samples.length < 5) samples.push('  行' + (i + 2) + ' 認証=' + (auth || '空')
        + ' LINE=' + String(r[MAP_COL.LINE_USER_ID - 1] || '').slice(0, 8) + '…');
    }
  });
  var msg = '=== 紐付けの状態 ===\n'
    + '  全' + vals.length + '行  verified ' + stat.verified + ' / pending ' + stat.pending + ' / その他 ' + stat.other + '\n'
    + '  顧客IDが空の行：' + stat.noCustomerId + '件'
    + (samples.length ? '\n' + samples.join('\n') : '')
    + '\n\n体重記録には顧客IDが必要です。空の行は記録できません。';
  Logger.log(msg);
  return msg;
}

/* ============================================================
 *  公開前の門番（2026-09-21 オーナー指示）
 *  機能が完成するまで顧客には出さない。登録した人にだけ開く。
 * ============================================================ */

/** テスターかどうか。プロパティが空なら誰にも開かない（安全側） */
var MA_TESTERS_MEMO = null;

function maIsTester_(lineUserId) {
  if (!lineUserId) return false;
  if (MA_TESTERS_MEMO === null) {
    var raw = PropertiesService.getScriptProperties().getProperty(MA_PROP.TESTERS) || '';
    MA_TESTERS_MEMO = raw.trim()
      ? raw.split(',').map(function (x) { return String(x).trim(); }).filter(Boolean)
      : [];                                  // 空＝誰にも開かない（安全側）
  }
  for (var i = 0; i < MA_TESTERS_MEMO.length; i++) {
    if (MA_TESTERS_MEMO[i] === String(lineUserId)) return true;
  }
  return false;
}

/**
 * 氏名でテスターに追加する。LINE userId を直接扱わずに済む。
 * 例：maAddTesterByName('中野 龍之介')
 */
function maAddTesterByName(name) {
  if (!name) return '氏名を指定してください。例: maAddTesterByName(\'中野 龍之介\')';
  var m = _lbFindMemberByName(name);
  if (!m || !m.lineUserId) return '「' + name + '」が customer_line_map の verified に見つかりません';
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(MA_PROP.TESTERS) || '';
  var list = raw.split(',').map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (list.indexOf(m.lineUserId) >= 0) return '「' + m.name + '」は既にテスターです';
  list.push(m.lineUserId);
  props.setProperty(MA_PROP.TESTERS, list.join(','));
  var msg = '「' + m.name + '」をテスターに追加しました（現在 ' + list.length + '名）';
  Logger.log(msg);
  return msg;
}

/** 氏名でテスターから外す */
function maRemoveTesterByName(name) {
  var m = _lbFindMemberByName(name);
  if (!m || !m.lineUserId) return '「' + name + '」が見つかりません';
  var props = PropertiesService.getScriptProperties();
  var list = (props.getProperty(MA_PROP.TESTERS) || '').split(',')
    .map(function (x) { return String(x).trim(); }).filter(Boolean);
  var next = list.filter(function (x) { return x !== m.lineUserId; });
  props.setProperty(MA_PROP.TESTERS, next.join(','));
  var msg = '「' + m.name + '」をテスターから外しました（現在 ' + next.length + '名）';
  Logger.log(msg);
  return msg;
}

/** いま誰に開いているか。氏名で表示し、LINE IDは伏せる */
function maListTesters() {
  var raw = PropertiesService.getScriptProperties().getProperty(MA_PROP.TESTERS) || '';
  var list = raw.split(',').map(function (x) { return String(x).trim(); }).filter(Boolean);
  if (!list.length) return '=== 公開状態 ===\n  テスターは0名。**誰にも開いていません**（会員が数字を送っても無反応）';
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.AUTH_STATE).getValues();
  var names = list.map(function (uid) {
    for (var i = 0; i < vals.length; i++) {
      if (String(vals[i][MAP_COL.LINE_USER_ID - 1]) === uid) {
        return '  ' + String(vals[i][MAP_COL.NAME - 1] || '(氏名なし)') + '  ' + uid.slice(0, 8) + '…';
      }
    }
    return '  (map に無い) ' + uid.slice(0, 8) + '…';
  });
  var msg = '=== 公開状態 ===\n  テスター ' + list.length + '名にだけ開いています\n' + names.join('\n')
    + '\n\n  この人たち以外が数字を送っても、何も返りません。';
  Logger.log(msg);
  return msg;
}

/** 全員に開く。機能が完成し、オーナーが公開を決めた時にだけ実行する */
function maOpenToEveryone_DANGEROUS() {
  return 'この関数は意図的に未実装です。公開はオーナーの決裁事項（憲法3節）。'
       + '\n公開する時は、テスター判定を外す変更をCEOが行い、decisions/ に記録します。';
}

/* ============================================================
 *  Flexメッセージによる入力フロー（設計：weight-input.html）
 *  ── リッチメニューは「公開するための部品」なので、まだ作らない。
 *     プロトタイプ段階はキーワードで起動する。
 * ============================================================ */

var MA_TRIGGER = /^(体重|体重記録|たいじゅう|記録)$/;

/** 複数メッセージをまとめて返す。reply は1トークン1回しか使えないため必ずまとめる */
function maReply_(replyToken, messages) {
  var token = _lbProp('LINE_MESSAGING_TOKEN');
  if (!token || !replyToken) { Logger.log('maReply_ skip: token/replyToken無し'); return false; }
  var res = UrlFetchApp.fetch('https://api.line.me/v2/bot/message/reply', {
    method: 'post', contentType: 'application/json',
    headers: { Authorization: 'Bearer ' + token },
    payload: JSON.stringify({ replyToken: replyToken, messages: messages }),
    muteHttpExceptions: true
  });
  var code = res.getResponseCode();
  if (code !== 200) Logger.log('maReply_ HTTP' + code + ': ' + String(res.getContentText()).slice(0, 300));
  return code === 200;
}
function maTextMsg_(t) { return { type: 'text', text: t }; }
function maFlexMsg_(alt, bubble) { return { type: 'flex', altText: alt, contents: bubble }; }
function maReplyFlex_(replyToken, altText, bubble) {
  return maReply_(replyToken, [maFlexMsg_(altText, bubble)]);
}

/**
 * 二度押しの吸収。同じ人の同じ操作が短時間に複数届いたら、2回目以降は捨てる。
 * 返信が返るまでに間があるため、押せたか分からず何度も押されるのが実測で判明（2026-09-21）。
 */
function maOnce_(uid, key, sec) {
  var cache = CacheService.getScriptCache();
  var k = 'ma_once_' + uid + '_' + key;
  if (cache.get(k)) return false;          // 既に処理済み
  cache.put(k, '1', sec || 90);
  return true;
}

/* --- 見た目の定数（TOKOWAKA） --- */
var MA_C = { navy: '#1B2A47', gold: '#B8965A', cream: '#FAF5EB',
             stone: '#E6DDCD', ink: '#22201C', soft: '#5D574E', faint: '#8F887C', white: '#FFFFFF' };

/** 数値の候補グリッド（3列×4行）。前回値を中心に並べる */
function maNumberGrid_(center, step, kind) {
  var vals = [];
  for (var i = -5; i <= 6; i++) vals.push(+(center + i * step).toFixed(1));
  var rows = [];
  for (var r = 0; r < 4; r++) {
    var cells = [];
    for (var c = 0; c < 3; c++) {
      var v = vals[r * 3 + c];
      var isPrev = Math.abs(v - center) < step / 2;
      cells.push({
        type: 'box', layout: 'vertical', flex: 1, height: '38px',
        backgroundColor: isPrev ? MA_C.white : MA_C.cream,
        borderColor: isPrev ? MA_C.gold : MA_C.stone, borderWidth: '1px', cornerRadius: '3px',
        justifyContent: 'center', margin: c ? '4px' : 'none',
        // displayText を付けると、タップした値が本人の発言として即座に表示される。
        // 押せたかどうかが分からず何度も押される問題（実測）への対処。
        action: { type: 'postback', label: String(v), data: 'ma=' + kind + '&v=' + v,
                  displayText: v.toFixed(1) + (kind === 'f' ? '%' : 'kg') },
        contents: [{ type: 'text', text: v.toFixed(1), size: 'sm', align: 'center',
                     color: isPrev ? MA_C.navy : MA_C.ink, weight: 'bold' }]
      });
    }
    rows.push({ type: 'box', layout: 'horizontal', margin: r ? '4px' : 'none', contents: cells });
  }
  return rows;
}

/** 体重／体脂肪率の入力カード */
function maInputBubble_(opts) {
  var body = [
    { type: 'text', text: opts.title, size: 'md', weight: 'bold', color: MA_C.navy },
    { type: 'text', text: opts.sub, size: 'xxs', color: MA_C.faint, margin: 'xs' },
    { type: 'box', layout: 'vertical', margin: 'lg', contents: maNumberGrid_(opts.center, opts.step, opts.kind) },
    { type: 'box', layout: 'vertical', margin: 'md', height: '34px', justifyContent: 'center',
      borderColor: MA_C.stone, borderWidth: '1px', cornerRadius: '3px',
      action: { type: 'postback', label: '直接入力', data: 'ma=manual&kind=' + opts.kind,
                displayText: '直接入力する' },
      contents: [{ type: 'text', text: '別の数値を入力する', size: 'xxs', align: 'center', color: MA_C.soft }] }
  ];
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: MA_C.white,
            borderWidth: '2px', borderColor: MA_C.gold, cornerRadius: '3px', contents: body }
  };
}

/** 「体脂肪率も記録しますか？」 */
function maAskFatBubble_() {
  return {
    type: 'bubble', size: 'kilo',
    body: { type: 'box', layout: 'vertical', paddingAll: '14px', backgroundColor: MA_C.white,
      borderWidth: '2px', borderColor: MA_C.gold, cornerRadius: '3px', contents: [
      { type: 'text', text: '体脂肪率も記録しますか？', size: 'sm', weight: 'bold', color: MA_C.navy },
      { type: 'text', text: '任意です。測っていなければ飛ばして構いません', size: 'xxs', color: MA_C.faint, margin: 'xs', wrap: true },
      { type: 'box', layout: 'horizontal', margin: 'lg', contents: [
        { type: 'box', layout: 'vertical', flex: 1, height: '36px', justifyContent: 'center',
          backgroundColor: MA_C.gold, cornerRadius: '3px',
          action: { type: 'postback', label: '記録する', data: 'ma=askfat', displayText: '体脂肪率も記録する' },
          contents: [{ type: 'text', text: '記録する', size: 'xs', align: 'center', color: MA_C.white, weight: 'bold' }] },
        { type: 'box', layout: 'vertical', flex: 1, height: '36px', justifyContent: 'center', margin: 'sm',
          borderColor: MA_C.stone, borderWidth: '1px', cornerRadius: '3px',
          action: { type: 'postback', label: '今日はここまで', data: 'ma=done', displayText: '今日はここまで' },
          contents: [{ type: 'text', text: '今日はここまで', size: 'xs', align: 'center', color: MA_C.soft }] }
      ]}
    ]}
  };
}

/** 直近の値を取る（無ければ null）。写しから返すのでシートに触らない */
function maLastValue_(customerId, col) {
  var snap = maSnapGet_(customerId);
  if (col === 2) return snap.lastW;
  if (col === 3) return snap.lastF;
  if (col === 4) return snap.lastLean;
  return null;
}

/** postback の入口。message と同じく外へ例外を投げない */
function _maHandlePostbackInner(ev) {
  try {
    var uid = ev && ev.source && ev.source.userId;
    if (!maIsTester_(uid)) return false;
    var data = String((ev.postback && ev.postback.data) || '');
    if (data.indexOf('ma=') !== 0) return false;

    var q = {};
    data.split('&').forEach(function (kv) { var p = kv.split('='); q[p[0]] = decodeURIComponent(p[1] || ''); });
    var cust = maLookupCustomer_(uid);
    if (!cust) { _lbReply(ev.replyToken, '会員情報が確認できませんでした。'); return true; }

    if (q.ma === 'w') {
      var kg = parseFloat(q.v);
      if (!maOnce_(uid, 'w' + maToday_() + kg)) { Logger.log('二度押しを無視: w ' + kg); return true; }
      var res = maLogWeight_(cust.customerId, kg);
      maMark_('保存');
      maReply_(ev.replyToken, [
        maTextMsg_(maBuildWeightReply_(cust, kg, res)),
        maFlexMsg_('体脂肪率の確認', maAskFatBubble_())
      ]);
      maMark_('返信');
      return true;
    }
    if (q.ma === 'askfat') {
      if (!maOnce_(uid, 'askfat' + maToday_(), 20)) { Logger.log('二度押しを無視: askfat'); return true; }
      var prevFat = maLastValue_(cust.customerId, 3);
      maReplyFlex_(ev.replyToken, '体脂肪率の入力',
        maInputBubble_({ title: '今日の体脂肪率は？',
          sub: prevFat ? '前回 ' + prevFat.v.toFixed(1) + '%（' + prevFat.date + '）' : '前回の記録がありません',
          center: prevFat ? prevFat.v : 22.0, step: 0.1, kind: 'f' }));
      return true;
    }
    if (q.ma === 'f') {
      var pct = parseFloat(q.v);
      if (!maOnce_(uid, 'f' + maToday_() + pct)) { Logger.log('二度押しを無視: f ' + pct); return true; }
      _lbReply(ev.replyToken, maLogFat_(cust.customerId, pct));
      return true;
    }
    if (q.ma === 'done') { _lbReply(ev.replyToken, '記録しました。今日もおつかれさまでした。'); return true; }
    if (q.ma === 'manual') {
      var kind = (q.kind === 'f') ? 'f' : 'w';
      maSetAwait_(uid, kind);                          // 次に届く数値をこの項目として扱う
      _lbReply(ev.replyToken, kind === 'f'
        ? '体脂肪率を数値で送ってください（例：19.9）'
        : '体重を数値で送ってください（例：68.4）');
      return true;
    }
    return false;
  } catch (err) {
    Logger.log('_maHandlePostback: ' + err.message + '\n' + (err.stack || ''));
    try { _lbReply(ev.replyToken, '記録できませんでした。もう一度お試しください。'); } catch (e2) {}
    return true;
  }
}

/** 体脂肪率を今日の行へ書き、除脂肪を計算して返す */
function maLogFat_(customerId, pct) {
  var sh = maSheet_('body_log');
  var today = maToday_();
  var snap = maSnapGet_(customerId);
  var target = snap.todayRow || 0, kg = snap.todayKg || null;
  var prevLean = snap.lastLean ? snap.lastLean.v : null;

  // 写しが指す行が本当に本人の今日の行か、2セルだけ読んで確かめる。
  // appendRow の直後に他の人が書くと行番号がずれうるため、他人の行を潰さない。
  if (target > 1) {
    var chk = sh.getRange(target, 1, 1, 3).getValues()[0];
    if (String(chk[0]) !== String(customerId) || maDateStr_(chk[1]) !== today) {
      maSnapClear_(customerId);
      snap = maSnapRebuild_(customerId);
      target = snap.todayRow || 0; kg = snap.todayKg || null;
      prevLean = snap.lastLean ? snap.lastLean.v : null;
    } else if (!kg) {
      kg = Number(chk[2]) || null;
    }
  }

  if (target < 2 || !kg) return '先に体重を記録してください。';
  var fatKg = kg * pct / 100, lean = kg - fatKg;
  sh.getRange(target, 4, 1, 2).setValues([[pct, +lean.toFixed(1)]]);   // 2セルを1回で書く

  snap.lastF = { v: pct, date: today };
  maSnapPut_(customerId, snap);
  var lines = ['体脂肪率 ' + pct.toFixed(1) + '% を記録しました',
               '体脂肪量 ' + fatKg.toFixed(1) + 'kg',
               '除脂肪量 ' + lean.toFixed(1) + 'kg'
                 + (prevLean ? '（前回 ' + prevLean.toFixed(1) + 'kg）' : '')];
  if (prevLean) {
    var d2 = lean - prevLean;
    lines.push(d2 >= -0.05
      ? '落ちているのは脂肪です。筋肉は保てています。'
      : '除脂肪が ' + Math.abs(d2).toFixed(1) + 'kg 減っています。次回のセッションで確認しましょう。');
  }
  return lines.join('\n');
}

/* ============================================================
 *  テスター登録（コードを書き換えずに済む経路）
 *  GASの「実行」は引数を渡せないため、氏名はスクリプトプロパティに置く。
 *  clasp push で上書きされないので、設定が消えない。
 * ============================================================ */

/**
 * スクリプトプロパティ MEAL_TESTER_NAMES（カンマ区切りの氏名）を読み、
 * customer_line_map で LINE userId に解決して MEAL_TESTERS を作り直す。
 * 引数を取らないので、エディタの「実行」からそのまま動く。
 */
function maSyncTestersFromNames() {
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty(MA_PROP.TESTER_NAMES) || '';
  var names = raw.split(',').map(function (x) { return String(x).trim(); }).filter(Boolean);

  if (!names.length) {
    return '=== テスター同期 ===\n'
      + '  スクリプトプロパティ「' + MA_PROP.TESTER_NAMES + '」が空です。\n'
      + '  エディタ左の ⚙ プロジェクトの設定 → スクリプト プロパティ で\n'
      + '  プロパティ名: ' + MA_PROP.TESTER_NAMES + '\n'
      + '  値: 自分の氏名（複数ならカンマ区切り）\n'
      + '  を追加してから、もう一度この関数を実行してください。\n'
      + '  正確な氏名は maListVerifiedNames() で確認できます。';
  }

  var ok = [], ng = [];
  names.forEach(function (n) {
    var m = _lbFindMemberByName(n);
    if (m && m.lineUserId) ok.push({ name: m.name, uid: m.lineUserId });
    else ng.push(n);
  });

  props.setProperty(MA_PROP.TESTERS, ok.map(function (x) { return x.uid; }).join(','));

  var msg = '=== テスター同期 ===\n'
    + '  開いた相手 ' + ok.length + '名\n'
    + ok.map(function (x) { return '    ' + x.name + '  ' + x.uid.slice(0, 8) + '…'; }).join('\n')
    + (ng.length ? '\n  見つからなかった氏名 ' + ng.length + '件\n    ' + ng.join('\n    ')
        + '\n  → maListVerifiedNames() で正確な表記を確認してください' : '')
    + '\n\n  ここに載っていない会員が数字を送っても、何も返りません。';
  Logger.log(msg);
  return msg;
}

/** verified な会員の氏名を並べる。テスター登録で使う正確な表記を確認するため */
function maListVerifiedNames() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return 'customer_line_map が空です';
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, MAP_COL.AUTH_STATE).getValues();
  var names = [];
  vals.forEach(function (r) {
    if (String(r[MAP_COL.AUTH_STATE - 1]) !== 'verified') return;
    var n = String(r[MAP_COL.NAME - 1] || '').trim();
    if (n) names.push(n);
  });
  var msg = '=== verified の氏名（' + names.length + '名）===\n'
    + '  この表記をそのまま ' + MA_PROP.TESTER_NAMES + ' に入れてください\n\n'
    + names.map(function (n) { return '  ' + n; }).join('\n');
  Logger.log(msg);
  return msg;
}

/**
 * 同じ会員・同じ日付の行が複数あるとき、最後の1行だけ残して消す。
 * 検証中の二度押しで増えた行を片付けるためのもの。
 * 読み取り側も「同日は最後の行を採る」ので必須ではないが、シートを綺麗に保つ。
 */
function maDedupeBodyLog() {
  var ss = maOpenSs_(), sh = ss.getSheetByName('body_log');
  var last = sh.getLastRow();
  if (last < 3) return '重複なし（' + Math.max(0, last - 1) + '行）';
  var vals = sh.getRange(2, 1, last - 1, 2).getValues();
  var seen = {}, del = [];
  for (var i = vals.length - 1; i >= 0; i--) {       // 後ろから見て、最初に出たものを残す
    var key = String(vals[i][0]) + '|' + maDateStr_(vals[i][1]);
    if (seen[key]) del.push(i + 2); else seen[key] = true;
  }
  del.sort(function (a, b) { return b - a; });       // 下の行から消さないとずれる
  del.forEach(function (r) { sh.deleteRow(r); });
  var msg = '重複を ' + del.length + ' 行削除しました（残り ' + (last - 1 - del.length) + ' 行）';
  Logger.log(msg);
  return msg;
}


/* =========================================================
 *  A2-2  LIFF（グラフ画面）の窓口
 *  doGet(?action=ma_*) から呼ばれる。認証は予約LIFFと同じ verifyLineIdToken。
 *  公開前の門番（maIsTester_）をここでも通す。URLを知られても開かない。
 * ========================================================= */
function maHandleGet(params) {
  var action = params.action || '';
  var auth = verifyLineIdToken(params.idToken);
  if (!auth.ok) return { success: false, code: 'UNAUTHORIZED' };
  var uid = auth.lineUserId;

  // トレーナーは公開前でも入れる（会員の進捗を見るのが仕事のため）
  var tr = null;
  try { tr = requireTrainer(uid); } catch (e) { tr = null; }

  // テスター以外には存在しないものとして返す（機能の存在自体を伏せる）
  if (!tr && !maIsTester_(uid)) return { success: false, code: 'NOT_OPEN' };

  try {
    switch (action) {
      case 'ma_series':    return maApiSeries_(uid, params, tr);
      case 'ma_myMembers': return tr ? maTrainerMembers_(tr) : { success: false, code: 'FORBIDDEN' };
      default:             return { success: false, code: 'UNKNOWN_ACTION' };
    }
  } catch (err) {
    Logger.log('maHandleGet 例外: ' + err.message);
    return { success: false, code: 'ERROR', message: err.message };
  }
}

/**
 * グラフ1枚ぶんのデータを1往復で返す。
 * 画面が指標を切り替えるたびに通信しないよう、6指標すべてをまとめて渡す。
 */
function maApiSeries_(uid, params, tr) {
  // トレーナーが顧客を指定した場合のみ、他人のカルテを開ける。
  // 会員が customerId を付けて叩いても tr が無いので自分のカルテしか返らない。
  var cust = null, asTrainer = false;
  if (tr && params.customerId) {
    var nm = maCustomerName_(String(params.customerId));
    if (!nm) return { success: false, code: 'NOT_FOUND' };
    cust = { customerId: String(params.customerId), name: nm };
    asTrainer = true;
  } else {
    cust = maLookupCustomer_(uid);
  }
  if (!cust) return { success: false, code: 'NOT_MEMBER' };

  var days = Math.min(Math.max(Number(params.days) || 180, 30), 400);
  var ss = maOpenSs_();
  var sh = ss.getSheetByName('body_log');
  if (!sh) return { success: false, code: 'NO_SHEET' };

  var rows = maReadBody_(sh, cust.customerId, days);
  return {
    success: true,
    name: cust.name,
    asTrainer: asTrainer,
    isTrainer: !!tr,
    customerId: cust.customerId,
    today: maToday_(),
    from: maShiftDays_(maToday_(), -days),
    days: days,                                   // 画面の見出しはこれを使う（要求値ではなく返した値）
    rows: rows,                                   // [{d,w,pbf,fat,lean,tbw,vis,src}]
    goal: maReadGoal_(ss, cust.customerId)        // 無ければ null
  };
}

/**
 * body_log を後ろから読む。全件は読まない。
 * 同じ日に複数行あれば「最後に書かれた行」を採用する（同日再送の扱いを記録側と揃える）。
 */
function maReadBody_(sh, customerId, days) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return [];
  var span = Math.min(lastRow - 1, days * 40 + 400);
  var from = Math.max(2, lastRow - span + 1);
  var vals = sh.getRange(from, 1, lastRow - from + 1, 8).getValues();
  var limit = maShiftDays_(maToday_(), -days);

  var byDate = {};
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0]) !== String(customerId)) continue;
    var d = maDateStr_(vals[i][1]);
    if (!d || d < limit) continue;
    var rec = byDate[d] || { d: d, s: {} };
    if (!rec.s) rec.s = {};
    // 測定元を項目ごとに持つ。InBodyの実測と会員の自己申告を同じ線に混ぜないため。
    // 'i' = InBody（トレーナー入力）／'s' = 自己申告（家庭用体重計）
    var tag = (String(vals[i][7] || '').indexOf('inbody') >= 0) ? 'i' : 's';
    // 後の行が勝つ。ただし空欄では上書きしない（体重だけ再送しても体脂肪が消えない）
    if (Number(vals[i][2])) { rec.w    = Number(vals[i][2]); rec.s.w    = tag; }
    if (Number(vals[i][3])) { rec.pbf  = Number(vals[i][3]); rec.s.pbf  = tag; }
    if (Number(vals[i][4])) { rec.lean = Number(vals[i][4]); rec.s.lean = tag; }
    if (Number(vals[i][5])) { rec.tbw  = Number(vals[i][5]); rec.s.tbw  = tag; }
    if (Number(vals[i][6])) { rec.vis  = Number(vals[i][6]); rec.s.vis  = tag; }
    byDate[d] = rec;
  }
  var out = [];
  for (var k in byDate) {
    var r = byDate[k];
    // 実測が無いときだけ計算で補う。補った値の出所は体脂肪率に合わせる。
    if (r.w && r.pbf && !r.lean) {
      r.lean = Math.round(r.w * (1 - r.pbf / 100) * 10) / 10;
      r.s.lean = r.s.pbf;
    }
    if (r.w && r.pbf) {
      r.fat = Math.round(r.w * (r.pbf / 100) * 10) / 10;
      r.s.fat = r.s.pbf;
    }
    out.push(r);
  }
  out.sort(function (a, b) { return a.d < b.d ? -1 : (a.d > b.d ? 1 : 0); });
  return out;
}

/**
 * 目標線を返す。goal_phases があれば区分線形（期ごとの折れ線）、
 * 無く meal_goals だけなら契約開始→終了の一直線。どちらも無ければ null。
 */
function maReadGoal_(ss, customerId) {
  var gs = ss.getSheetByName('meal_goals');
  if (!gs || gs.getLastRow() < 2) return null;
  var g = gs.getRange(2, 1, gs.getLastRow() - 1, 13).getValues();
  var row = null;
  for (var i = g.length - 1; i >= 0; i--) {
    if (String(g[i][0]) === String(customerId)) { row = g[i]; break; }   // 最新の契約を採る
  }
  if (!row) return null;

  var goal = {
    start:     maDateStr_(row[2]),
    end:       maDateStr_(row[3]),
    startKg:   Number(row[8])  || null,
    startLean: Number(row[9])  || null,
    targetKg:  Number(row[10]) || null,
    targetFat: Number(row[11]) || null,
    targetLean:Number(row[12]) || null,
    line: []
  };
  if (goal.startKg && goal.targetKg && goal.start && goal.end) {
    goal.line = [{ d: goal.start, v: goal.startKg }, { d: goal.end, v: goal.targetKg }];
  }

  // 期があれば、そちらを正とする（決定0058：期は上書きせず積む＝有効なものだけ拾う）
  var ps = ss.getSheetByName('goal_phases');
  if (ps && ps.getLastRow() >= 2) {
    var p = ps.getRange(2, 1, ps.getLastRow() - 1, 14).getValues();
    var phases = [];
    for (var j = 0; j < p.length; j++) {
      if (String(p[j][0]) !== String(customerId)) continue;
      if (String(p[j][13]) === '無効') continue;
      phases.push({
        no: Number(p[j][1]) || 0, kind: String(p[j][2] || ''),
        start: maDateStr_(p[j][3]), end: maDateStr_(p[j][4]),
        startKg: Number(p[j][6]) || null, targetKg: Number(p[j][7]) || null,
        kcal: Number(p[j][9]) || null
      });
    }
    if (phases.length) {
      phases.sort(function (a, b) { return a.no - b.no; });
      var line = [];
      for (var q = 0; q < phases.length; q++) {
        var ph = phases[q];
        if (!ph.start || !ph.targetKg) continue;
        if (!line.length && ph.startKg) line.push({ d: ph.start, v: ph.startKg });
        if (ph.end) line.push({ d: ph.end, v: ph.targetKg });
      }
      if (line.length >= 2) { goal.line = line; goal.phases = phases; }
    }
  }
  return goal.line.length ? goal : null;
}

/**
 * LIFF（HtmlServiceサンドボックス）からの窓口。
 * 予約LIFFと同じく fetch はCORSで通らないため google.script.run 経由。
 * 戻りは文字列（google.script.run はオブジェクトを返せない）。
 */
function mealApi(payloadJson) {
  try {
    var body = JSON.parse(payloadJson || '{}');
    // maHandleGet と同じ検問を通す（認証 → テスター門番 → 分岐）
    return JSON.stringify(maHandleGet({
      action:  'ma_' + String(body.action || '').replace(/^ma_/, ''),
      idToken: body.idToken,
      days:    body.days
    }));
  } catch (err) {
    Logger.log('mealApi 例外: ' + err.message);
    return JSON.stringify({ success: false, code: 'ERROR', message: err.message });
  }
}

/**
 * グラフLIFFの登録に必要な値を全部まとめて出す。
 * オーナーはGASエディタでこれを1回実行し、出てきたURLを LINE Developers に貼るだけでよい。
 */
function maPrintLiffSetup() {
  var props = PropertiesService.getScriptProperties();
  // ★画面はGASではなくGitHub Pagesから配信する。
  //   GASのHtmlServiceは入れ子iframe（googleusercontent.com）で配信されるため、
  //   LINEのログイン情報が中まで渡らず liff.init が返ってこない（2026-09-22 実機で確定）。
  //   予約LIFF（reservation.tokowaka-gym.com/liff/）と同じ構成に揃えた。
  var base = 'https://reservation.tokowaka-gym.com/karte/';
  var out = [
    '── グラフLIFFの登録に使う値 ──',
    '',
    '1) LINE Developers → 予約と同じチャネル → LIFF → 対象アプリ',
    '   サイズ　　　　 : Full',
    '   エンドポイントURL: ' + base,
    '   Scope　　　　　: openid, profile',
    '   ボットリンク機能 : Off（GASのiframe問題とは無関係だが、いま不要）',
    '',
    '   ※LIFF IDは karte/index.html に直書きしてある（GAS側の登録は不要）',
    '',
    '── 現在の登録状況 ──',
    'LINE_LIFF_ID_MEAL : ' + (props.getProperty('LINE_LIFF_ID_MEAL') ? '登録済み' : '未登録'),
    'LINE_LIFF_ID(予約) : ' + (props.getProperty('LINE_LIFF_ID') ? '登録済み' : '未登録'),
    'LINE_CHANNEL_ID　 : ' + (props.getProperty('LINE_CHANNEL_ID') ? '登録済み' : '未登録（未登録だと認証が全て失敗する）'),
    MA_PROP.TESTERS + ' : ' + (function () {
      var raw = props.getProperty(MA_PROP.TESTERS) || '';
      return raw.trim() ? (raw.split(',').length + '名') : '0名（＝誰にも開かない）';
    })()
  ].join('\n');
  Logger.log(out);
  return out;
}


/* =========================================================
 *  A2-3  トレーナーによる InBody 入力
 *  入口は予約LIFFのトレーナー画面（顧客を開いた状態から数値を打つ）。
 *  カルテは「見る面」、予約のトレーナー画面は「入れる面」。保存先は同じ body_log。
 * ========================================================= */

/** 入力を受ける項目と、取りうる範囲。範囲外は保存しない（打ち間違いを通さない） */
var MA_INBODY_FIELDS = [
  { key: 'w',    col: 3, label: '体重',     unit: 'kg', min: 20,  max: 250, dec: 1 },
  { key: 'pbf',  col: 4, label: '体脂肪率', unit: '%',  min: 3,   max: 60,  dec: 1 },
  { key: 'lean', col: 5, label: '除脂肪量', unit: 'kg', min: 10,  max: 150, dec: 1 },
  { key: 'tbw',  col: 6, label: '体水分量', unit: 'L',  min: 5,   max: 100, dec: 1 },
  { key: 'vis',  col: 7, label: '内臓脂肪', unit: '',   min: 1,   max: 30,  dec: 0 }
];

/**
 * トレーナーが測定値を1件書く。追記のみ（既存行は書き換えない）。
 * @param {Object} tr        requireTrainer() の戻り（トレーナー本人）
 * @param {string} customerId
 * @param {Object} v         {w,pbf,lean,tbw,vis,date}
 */
function maSaveInBody_(tr, customerId, v, shOverride) {
  customerId = String(customerId || '');
  if (!customerId) return { success: false, code: 'BAD_REQUEST', message: '顧客が指定されていません。' };

  var date = String(v.date || '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) date = maToday_();
  if (date > maToday_()) return { success: false, code: 'BAD_REQUEST', message: '未来の日付は記録できません。' };

  var vals = {}, filled = 0, errs = [];
  for (var i = 0; i < MA_INBODY_FIELDS.length; i++) {
    var f = MA_INBODY_FIELDS[i];
    var raw = v[f.key];
    if (raw === undefined || raw === null || String(raw).trim() === '') continue;
    var n = Number(String(raw).replace(/[^0-9.\-]/g, ''));
    if (!isFinite(n)) { errs.push(f.label + 'が数値ではありません'); continue; }
    if (n < f.min || n > f.max) { errs.push(f.label + 'が範囲外です（' + f.min + '〜' + f.max + f.unit + '）'); continue; }
    vals[f.key] = Math.round(n * Math.pow(10, f.dec)) / Math.pow(10, f.dec);
    filled++;
  }
  if (errs.length) return { success: false, code: 'BAD_VALUE', message: errs.join('\n') };
  if (!filled)     return { success: false, code: 'EMPTY', message: '1つ以上入力してください。' };

  // 体重と体脂肪率が揃っていて除脂肪が空なら、計算して補う（InBody票にも載っている値）
  if (vals.w && vals.pbf && !vals.lean) vals.lean = Math.round(vals.w * (1 - vals.pbf / 100) * 10) / 10;

  // shOverride は自己テスト専用（staging SSのシートを渡す）。本番経路では常に未指定。
  var sh = shOverride || null;
  if (!sh) {
    var ss = maOpenSs_();
    sh = ss.getSheetByName('body_log');
  }
  if (!sh) return { success: false, code: 'NO_SHEET', message: 'body_log がありません。setupMealSheets() を実行してください。' };

  var prev = maLastInBody_(sh, customerId, date);      // 差分を返すため、書く前に取る
  maSnapClear_(customerId);                           // 会員側のキャッシュを捨てる（外から書いたため）
  sh.appendRow([customerId, date,
                vals.w    || '', vals.pbf  || '', vals.lean || '',
                vals.tbw  || '', vals.vis  || '',
                'inbody', (tr && tr.name) ? tr.name : 'trainer', new Date(), '']);

  var diffs = [];
  for (var j = 0; j < MA_INBODY_FIELDS.length; j++) {
    var g = MA_INBODY_FIELDS[j];
    if (vals[g.key] === undefined || !prev || prev[g.key] === undefined) continue;
    var d = vals[g.key] - prev[g.key];
    diffs.push({ key: g.key, label: g.label, unit: g.unit,
                 now: vals[g.key], prev: prev[g.key],
                 diff: Math.round(d * 10) / 10 });
  }
  return { success: true, date: date, saved: vals,
           prevDate: prev ? prev.d : '', diffs: diffs };
}

/** 直近のInBody実測（測定元=inbody）を1件返す。before を指定するとその日より前を探す */
function maLastInBody_(sh, customerId, before) {
  var lastRow = sh.getLastRow();
  if (lastRow < 2) return null;
  var from = Math.max(2, lastRow - 4000);
  var vals = sh.getRange(from, 1, lastRow - from + 1, 8).getValues();
  for (var i = vals.length - 1; i >= 0; i--) {
    if (String(vals[i][0]) !== String(customerId)) continue;
    if (String(vals[i][7] || '').indexOf('inbody') < 0) continue;
    var d = maDateStr_(vals[i][1]);
    if (before && d >= before) continue;
    var rec = { d: d };
    for (var j = 0; j < MA_INBODY_FIELDS.length; j++) {
      var f = MA_INBODY_FIELDS[j];
      var n = Number(vals[i][f.col - 1]);
      if (n) rec[f.key] = n;
    }
    return rec;
  }
  return null;
}

/** 入力画面の下敷き。前回値を見せて「どこから動いたか」を打つ前に分かるようにする */
function maInBodyCard_(tr, customerId) {
  var ss = maOpenSs_();
  var sh = ss.getSheetByName('body_log');
  if (!sh) return { success: false, code: 'NO_SHEET' };
  return {
    success: true,
    today: maToday_(),
    fields: MA_INBODY_FIELDS.map(function (f) {
      return { key: f.key, label: f.label, unit: f.unit, min: f.min, max: f.max, dec: f.dec };
    }),
    last: maLastInBody_(sh, String(customerId || ''), '') || null
  };
}

/**
 * InBody入力の実機テスト。**staging スプレッドシートにだけ**書く。
 * 本番の body_log は一切触らない（憲法13条）。オーナーはこれを1回実行するだけでよい。
 * 書いた行は最後に自分で消すので、テストSSにもゴミを残さない。
 */
function maSelfTestInBody() {
  var props = PropertiesService.getScriptProperties();
  var sid = props.getProperty(MA_PROP.SS_ID_STAGING);
  if (!sid) return '❌ ' + MA_PROP.SS_ID_STAGING + ' が未登録です。setupMealSheets() を先に実行してください。';

  var ss = SpreadsheetApp.openById(sid);
  var sh = ss.getSheetByName('body_log');
  if (!sh) return '❌ staging に body_log がありません。setupMealSheets() を実行してください。';

  var CID = '__SELFTEST__';
  var before = sh.getLastRow();
  var log = ['── InBody入力 実機テスト（staging）──', 'SS: ' + ss.getUrl(), ''];
  var pass = 0, fail = 0;
  function check(label, cond, extra) {
    if (cond) { pass++; log.push('  ✅ ' + label); }
    else      { fail++; log.push('  ❌ ' + label + (extra !== undefined ? ('  → ' + JSON.stringify(extra)) : '')); }
  }
  var tr = { name: '自己テスト' };

  try {
    // 1件目
    var r1 = maSaveInBody_(tr, CID, { w: 70.0, pbf: 22.0, tbw: 40.0, vis: 10, date: maShiftDays_(maToday_(), -7) }, sh);
    check('1件目を保存できる', r1.success === true, r1);
    check('除脂肪を自動計算する', r1.success && r1.saved.lean === 54.6, r1.saved);

    // 2件目（差分が出るか）
    var r2 = maSaveInBody_(tr, CID, { w: 68.5, pbf: 20.1 }, sh);
    check('2件目を保存できる', r2.success === true, r2);
    var dw = (r2.diffs || []).filter(function (d) { return d.key === 'w'; })[0];
    check('前回との差分が出る', !!dw && Math.abs(dw.diff + 1.5) < 1e-9, dw);

    // 打ち間違いを通さない
    var bad = maSaveInBody_(tr, CID, { w: 685 }, sh);
    check('範囲外を拒否する', bad.success === false && bad.code === 'BAD_VALUE', bad);
    var empty = maSaveInBody_(tr, CID, {}, sh);
    check('空入力を拒否する', empty.success === false && empty.code === 'EMPTY', empty);
    var future = maSaveInBody_(tr, CID, { w: 68, date: maShiftDays_(maToday_(), 1) }, sh);
    check('未来日を拒否する', future.success === false, future);

    check('拒否では行が増えない', sh.getLastRow() === before + 2, sh.getLastRow() - before);

    // 読み出し側と噛み合うか
    var rows = maReadBody_(sh, CID, 30);
    check('カルテ側が2日分を読める', rows.length === 2, rows.length);
    var latest = rows[rows.length - 1];
    check('最新の体重が読める', latest && latest.w === 68.5, latest);
    check('測定元がInBodyとして返る', latest && latest.s && latest.s.w === 'i', latest && latest.s);
    check('体脂肪量を計算して返す', latest && Math.abs(latest.fat - 13.8) < 0.15, latest && latest.fat);
  } catch (e) {
    fail++; log.push('  ❌ 例外: ' + e.message);
  }

  // 後始末（下から消す）
  var after = sh.getLastRow();
  for (var r = after; r >= 2; r--) {
    if (String(sh.getRange(r, 1).getValue()) === CID) sh.deleteRow(r);
  }
  log.push('', '後始末: テスト行を削除（' + before + '行 → ' + sh.getLastRow() + '行）');
  log.push('', (fail === 0 ? '✅ 全' + pass + '項目 合格' : '❌ ' + fail + '件 失敗 / ' + pass + '件 合格'));
  var out = log.join('\n');
  Logger.log(out);
  return out;
}

/** customerId から氏名を引く。予約側の会員マスタを読むだけ（軽い） */
function maCustomerName_(customerId) {
  if (!customerId) return '';
  var cache = CacheService.getScriptCache();
  var key = 'ma_cname_' + customerId;
  var hit = cache.get(key);
  if (hit !== null && hit !== undefined) return hit;
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh || sh.getLastRow() < 2) return '';
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, _lbMapWidth(sh)).getValues();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][MAP_COL.CUSTOMER_ID - 1]) === String(customerId)) {
      var nm = String(vals[i][MAP_COL.NAME - 1] || '');
      cache.put(key, nm, 1800);
      return nm;
    }
  }
  return '';
}

/**
 * トレーナーが見る会員一覧。記録の新しい順に並べ、最後の測定からの日数を添える。
 * 「誰の測定が止まっているか」が一覧で分かることを目的にする。
 */
function maTrainerMembers_(tr) {
  var ss = maOpenSs_();
  var sh = ss.getSheetByName('body_log');
  if (!sh) return { success: false, code: 'NO_SHEET' };

  var out = {};
  var lastRow = sh.getLastRow();
  if (lastRow >= 2) {
    var from = Math.max(2, lastRow - 6000);
    var vals = sh.getRange(from, 1, lastRow - from + 1, 8).getValues();
    for (var i = 0; i < vals.length; i++) {
      var cid = String(vals[i][0] || '');
      if (!cid || cid.indexOf('__') === 0) continue;       // 自己テスト行は出さない
      var d = maDateStr_(vals[i][1]);
      if (!d) continue;
      var rec = out[cid] || { customerId: cid, last: '', lastInBody: '', count: 0 };
      rec.count++;
      if (d > rec.last) rec.last = d;
      if (String(vals[i][7] || '').indexOf('inbody') >= 0 && d > rec.lastInBody) rec.lastInBody = d;
      out[cid] = rec;
    }
  }
  var today = maToday_(), list = [];
  for (var k in out) {
    var r = out[k];
    r.name = maCustomerName_(k) || '（氏名不明）';
    r.daysSince = maDaysBetween_(r.last, today);
    r.daysSinceInBody = r.lastInBody ? maDaysBetween_(r.lastInBody, today) : null;
    list.push(r);
  }
  // 測定が止まっている人ほど上。声をかける相手が一目で分かる並びにする
  list.sort(function (a, b) { return b.daysSince - a.daysSince; });
  return { success: true, today: today, members: list };
}

/** ymd同士の日数差（UTC固定） */
function maDaysBetween_(a, b) {
  if (!a || !b) return null;
  var pa = a.split('-'), pb = b.split('-');
  var da = Date.UTC(+pa[0], +pa[1] - 1, +pa[2]);
  var db = Date.UTC(+pb[0], +pb[1] - 1, +pb[2]);
  return Math.round((db - da) / 86400000);
}

/**
 * InBody入力・カルテのトレーナー機能が「自分に見えるか」を事前に確かめる。
 * カードは権限が無いと黙って消える設計なので、出ない理由をここで言語化する。
 * MEAL_TESTERS に入っている人を対象に見る（LINE userId をチャットへ貼らずに済む）。
 */
function maCheckTrainerAccess() {
  var props = PropertiesService.getScriptProperties();
  var raw = (props.getProperty(MA_PROP.TESTERS) || '').trim();
  var log = ['── トレーナー機能の見え方チェック ──', ''];
  if (!raw) { log.push('❌ ' + MA_PROP.TESTERS + ' が空です。maSyncTestersFromNames() を先に実行してください。');
              Logger.log(log.join('\n')); return log.join('\n'); }

  var ids = raw.split(',').map(function (x) { return String(x).trim(); }).filter(Boolean);
  log.push('テスター登録: ' + ids.length + '名');
  log.push('');

  for (var i = 0; i < ids.length; i++) {
    var uid = ids[i];
    var mask = uid.slice(0, 6) + '…' + uid.slice(-4);     // 値そのものは出さない
    var cust = null, tr = null, trErr = '';
    try { cust = maLookupCustomer_(uid); } catch (e) {}
    try { tr = requireTrainer(uid); } catch (e2) { trErr = e2.message; }

    log.push('[' + (i + 1) + '] ' + mask);
    log.push('   会員として   : ' + (cust ? ('照合OK（' + cust.name + '／' + cust.customerId + '）') : '未照合 → 自分のカルテは開けない'));
    if (tr) {
      log.push('   トレーナーとして: ✅ ' + (tr.name || '(名前不明)') + '（role=' + (tr.role || '?') + '）');
      log.push('   → 予約の顧客画面に「InBodyを記録」「この方のカルテを見る」が出ます');
      log.push('   → カルテを開くと会員一覧が出ます');
    } else {
      log.push('   トレーナーとして: ❌ 未登録' + (trErr ? '（' + trErr + '）' : ''));
      log.push('   → 入力カードも会員一覧も出ません（仕様どおり黙って消えます）');
      log.push('   → 出したい場合は、予約システムのトレーナー台帳にこの人の');
      log.push('      LINE userId と role（trainer / owner / admin）を登録してください');
    }
    log.push('');
  }
  var out = log.join('\n');
  Logger.log(out);
  return out;
}

/* ============================================================
 *  応答時間の計測
 *
 *  「体感で遅い」を数字にする。どの区間で失っているかが分からないと、
 *  当てずっぽうの改修になるため。
 *
 *  ev.timestamp は LINE 側がイベントを受け取った時刻。これと我々のコードの
 *  開始時刻の差が「回線＋GASの起動」＝自分たちのコードでは短縮できない部分。
 *  ここが大きいなら、コードを削っても効かない。
 *
 *  計測そのものの書き出しは返信の後に行うので、会員を待たせない。
 * ============================================================ */
var MA_T0 = 0, MA_MARKS = [];

function maPerfStart_(tag, ev) {
  MA_T0 = Date.now();
  MA_MARKS = [tag];
  var ts = ev && ev.timestamp ? Number(ev.timestamp) : 0;
  if (ts > 0) MA_MARKS.push('起動まで:' + (MA_T0 - ts));
}

function maMark_(label) {
  if (MA_T0) MA_MARKS.push(label + ':' + (Date.now() - MA_T0));
}

function maPerfEnd_() {
  if (!MA_T0) return;
  var total = Date.now() - MA_T0;
  var line = Utilities.formatDate(new Date(), 'Asia/Tokyo', 'MM/dd HH:mm:ss') + '  '
           + MA_MARKS.join('  ') + '  [コード内 合計:' + total + ']';
  MA_T0 = 0; MA_MARKS = [];
  try {
    var c = CacheService.getScriptCache();
    var arr = (c.get('ma_perf') || '').split('\n').filter(function (x) { return !!x; });
    arr.push(line);
    while (arr.length > 30) arr.shift();
    c.put('ma_perf', arr.join('\n'), 21600);
  } catch (e) {}
}

/** 直近30件の内訳を見る。オーナーはこれをエディタで実行するだけでよい */
function maPerfReport() {
  var raw = '';
  try { raw = CacheService.getScriptCache().get('ma_perf') || ''; } catch (e) {}
  if (!raw) return '計測データがありません。LINEで「体重」と送ってから、もう一度実行してください。';
  var lines = raw.split('\n').filter(function (x) { return !!x; });
  var starts = [], totals = [];
  lines.forEach(function (l) {
    var m1 = /起動まで:(\d+)/.exec(l); if (m1) starts.push(Number(m1[1]));
    var m2 = /合計:(\d+)\]/.exec(l);   if (m2) totals.push(Number(m2[1]));
  });
  function med(a) { if (!a.length) return null; var b = a.slice().sort(function (x, y) { return x - y; }); return b[Math.floor(b.length / 2)]; }
  var out = ['── 応答時間の内訳（直近' + lines.length + '件・新しい順）──', ''];
  out.push('中央値  起動まで: ' + (med(starts) !== null ? med(starts) + 'ms' : '—')
         + '  ／  コード内: ' + (med(totals) !== null ? med(totals) + 'ms' : '—'));
  out.push('（起動まで＝LINE受信〜我々のコード開始。回線とGASの起動時間で、コードを削っても縮まない）');
  out.push('');
  lines.slice().reverse().forEach(function (l) { out.push('  ' + l); });
  var r = out.join('\n');
  Logger.log(r);
  return r;
}

/** LINEイベントの入口。計測で包むだけで、中身は Inner に置いてある */
function _maHandleMessage(ev) {
  maPerfStart_('メッセージ', ev);
  try { return _maHandleMessageInner(ev); }
  finally { maPerfEnd_(); }
}

function _maHandlePostback(ev) {
  maPerfStart_('タップ', ev);
  try { return _maHandlePostbackInner(ev); }
  finally { maPerfEnd_(); }
}
