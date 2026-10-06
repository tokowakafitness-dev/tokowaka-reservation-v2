// ============================================================
// 予約を促すリマインド（Nudge）— 顧客への「次の予約」を促す発信をここに1本化する
//
//   オーナーと詰め切った結果、送るものは4種になった（2026-09-30 確定仕様）。
//   同じ日に複数当たったら、**優先順位が上のものだけ**を送る（1人1日1通）。
//
//   ┌順┬種別───────────┬条件────────────────────────────────────────────┐
//   │1 │transfer 振替の案内 │昨日の予約が当日キャンセルで、振替権が未使用かつ有効期限内       │
//   │2 │month_open 翌月解放 │毎月25日・契約が有効                                    │
//   │3 │visit_b 来店翌日B   │昨日実際に来店・今月の未来予約が0件・月額残 > 0             │
//   │4 │visit_a 来店翌日A   │昨日実際に来店・今月の未来予約が1件以上・月額残 > 0・前回から7日以上│
//   └──┴──────────────┴────────────────────────────────────────────────┘
//
// ★当日キャンセルと実来店の見分け方（ここが本ファイルの肝）
//   予約台帳では当日キャンセルも `consumed` として残るため、状態だけでは来店と区別できない。
//   `transfer_credits`（当日キャンセルで1件付与・6日有効）の source_reservation_id に
//   昨日の予約IDが載っていれば**当日キャンセル**、載っていなければ**実来店**と判定する。
//   ※台帳の備考列は取消時に「resId|当日消化取消」となるため、'|' の手前で切って突き合わせる。
//
// ★設計の柱（ここを崩すと顧客に実害が出る）
//   ① 既定は「送らない」。Script Properties の LB_REMIND_ON が '1' のときだけ実送信する。
//      顧客への発信はオーナー承認が必要（憲法第3節-3）。CEO/CIの判断で有効化しない。
//   ② 「送らずに一覧するだけ」を主たる入口にする（lbNudgePreview）。
//      4種それぞれ何人が対象か、除外理由の内訳、優先順位で見送った分まで出す。
//   ③ 1人1日1通。優先順位で1つに絞る。絞って送らなかったものも一覧には出す。
//   ④ visit_a だけ同じ人へ7日空ける（nudge_log で抑止）。他の種別に週の上限は設けない。
//      month_open は「その月に送ったか」で冪等にする。
//   ⑤ トリガーは1日1回だけ（lbNudgeDaily）。
//      このシステムでは以前1分/10分ごとのトリガーを増やした結果、GASの応答が2倍以上遅くなり
//      顧客に実害が出た。分/時間ごとのトリガーはこのファイルに一切書かない（回帰テストで固定）。
//   ⑥ 出力に個人情報を残さない。一覧・ログ・戻り値は顧客IDの下4桁だけで示し、氏名と
//      lineUserId は外へ出さない（_lbNudgeMask / _lbNudgePublic）。
//   ⑦ fail-closed。名簿・予約台帳・振替権シートのいずれかが読めなければ1通も送らない。
//      1人分のデータ不備では止めず、その行だけ記録して他の会員の分は続ける（sendLineReminders と同方針）。
//
// ★言い回しの決まり（オーナー指示）
//   ・「消える」「残りわずか」などマイナス表現を使わない
//   ・「下記よりどうぞ」ではなく「下記よりお待ちしております」
//   ・敬体。上品なトーンを保つ
//   ・transfer には残数の話を入れない（振替のことだけにする）
//
// ★Script Properties（すべて省略可・既定値はコード側。値はオーナーが決める）
//   LB_REMIND_ON            '1' のときだけ実送信。未設定＝一覧のみ（既定）
//   LB_NUDGE_OPEN_DAY       翌月分の解放日（既定 25）
//   LB_NUDGE_VISIT_A_DAYS   visit_a を同じ人へ再送するまでの間隔（既定 7）
//   LB_NUDGE_MAX_PER_RUN    1回の実行で送る上限（既定 50・初回有効化の暴走防止）
// ============================================================

// この版の印。中身を変えたら必ず書き換える。
var LB_NUDGE_BUILD = '2026-10-05a 1人1日1通を種別横断で・送る前に記録・排他ロック';

var LB_NUDGE_LOG_SHEET = 'nudge_log';   // 送信記録（再送抑止の正本）
var LB_NUDGE_LOG_COLS = 6;              // 送信日時 / 種別 / customer_id / 対象キー / 結果 / 詳細
var LB_NUDGE_LOG_SCAN = 3000;           // 再送判定で見る直近行数（新しい行が上＝これで足りる）

// 既定値。プロパティで上書きできるが、「送らない」側の既定は変えない。
var LB_NUDGE_DEFAULTS = { openDay: 25, visitADays: 7, maxPerRun: 50 };

var LB_NUDGE_KIND = {
  TRANSFER:   'nudge_transfer',
  MONTH_OPEN: 'nudge_month_open',
  VISIT_B:    'nudge_visit_b',
  VISIT_A:    'nudge_visit_a'
};
// ★優先順位。同じ日に複数当たったら、この並びで先頭のものだけを送る。
var LB_NUDGE_ORDER = [LB_NUDGE_KIND.TRANSFER, LB_NUDGE_KIND.MONTH_OPEN, LB_NUDGE_KIND.VISIT_B, LB_NUDGE_KIND.VISIT_A];
var LB_NUDGE_LABEL = {
  nudge_transfer:   '① 振替のご案内',
  nudge_month_open: '② 翌月分の解放',
  nudge_visit_b:    '③ 来店翌日B（今月の予約なし）',
  nudge_visit_a:    '④ 来店翌日A（今月の予約あり）'
};

// ------------------------------------------------------------
// 文面（4言語）。ここだけ見れば全文が分かるようにしてある。
//   ・氏名は入れない（宛先は1:1のトーク＝本人にしか届かない。出力・ログをPIIゼロに保つため）
//   ・差し込み：{facts}=残数の一文（下の _lbNudgeFactsText が組み立てる）
//     {month}=対象の月 / {pattern}=固定枠 / {quota}=押さえていただきたい回数
//     {next}=次のご予約の日時 / {expire}=振替の期限 / {url}=予約画面
// ------------------------------------------------------------
var _LB_NUDGE_MSG = {
  // 残数の一文（{facts} に入る）。★繰越の行は月末が近いときだけ足す。
  // 残り日数は「月末が近いとき」だけ添える（下の LB_NUDGE_DAYS_SHOW_DAYS）。
  //   月初に「残り31日」と言うと、急ぐ理由にならず逆に先延ばしを促す（2026-10-02 オーナー判断）。
  facts_remain: {
    ja:        '今月はあと {remain}回 ご利用いただけます。',
    en:        'You have {remain} session(s) left this month.',
    zh:        '本月还可使用 {remain}次。',
    'zh-Hant': '本月還可使用 {remain}次。'
  },
  facts_remain_days: {
    ja:        '今月はあと {remain}回 ご利用いただけます。（残り{days}日）',
    en:        'You have {remain} session(s) left this month ({days} days remaining).',
    zh:        '本月还可使用 {remain}次（剩余{days}天）。',
    'zh-Hant': '本月還可使用 {remain}次（剩餘{days}天）。'
  },
  // ④ 来店翌日A（すでにご予約がある方）専用。残数は既にあるご予約を引いた数なので、
  //   「あと○回」ではなく「すでにいただいているご予約の他、○回」と言う方が正確で、
  //   押しつけがましくない（2026-10-02 オーナー指示）。
  facts_remain_booked: {
    ja:        '今月はすでにいただいているご予約の他、{remain}回 ご利用いただけます。',
    en:        'In addition to the session(s) you have booked, you have {remain} more available this month.',
    zh:        '除已预约的课程外，本月还可使用 {remain}次。',
    'zh-Hant': '除已預約的課程外，本月還可使用 {remain}次。'
  },
  facts_remain_booked_days: {
    ja:        '今月はすでにいただいているご予約の他、{remain}回 ご利用いただけます。（残り{days}日）',
    en:        'In addition to the session(s) you have booked, you have {remain} more available this month ({days} days remaining).',
    zh:        '除已预约的课程外，本月还可使用 {remain}次（剩余{days}天）。',
    'zh-Hant': '除已預約的課程外，本月還可使用 {remain}次（剩餘{days}天）。'
  },
  // 「先月から○回繰り越しました」（その月に初めて送るとき・15日までだけ）
  facts_carried_in: {
    ja:        '先月分から {carried}回 繰り越しました。',
    en:        '{carried} session(s) were carried over from last month.',
    zh:        '上月结转了 {carried}次。',
    'zh-Hant': '上月結轉了 {carried}次。'
  },
  facts_carry: {
    ja:        'うち {carry}回 は繰り越し可能です。',
    en:        'Of these, {carry} can be carried over to next month.',
    zh:        '其中 {carry}次 可结转至下月。',
    'zh-Hant': '其中 {carry}次 可結轉至下月。'
  },

  // ① 振替の案内（★残数の話は入れない。振替のことだけにする＝オーナー指示）
  transfer: {
    ja: '振替が1回ご利用いただけます。\n' +
        '\n' +
        '昨日のご予約は当日のお取り消しのため、1回分の消化となりました。\n' +
        'かわりに振替を1回、{expire}まで ご利用いただけます。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'You have one transfer session available.\n' +
        '\n' +
        "Yesterday's booking was cancelled on the day, so it was counted as one session used.\n" +
        'In its place, you may use one transfer session until {expire}.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '您可使用1次转期。\n' +
        '\n' +
        '昨日的预约因当日取消，已计为1次消耗。\n' +
        '作为替代，您可在{expire}之前使用1次转期。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '您可使用1次轉期。\n' +
        '\n' +
        '昨日的預約因當日取消，已計為1次消耗。\n' +
        '作為替代，您可在{expire}之前使用1次轉期。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ② 翌月の解放（固定枠あり）— 25日に autoBookRecurringPatterns が翌月分を自動予約済み
  month_open_fixed: {
    ja: '{month}分のご予約が可能になりました。\n' +
        '\n' +
        'ご登録の固定枠（{pattern}）は、{month}分を自動でお取りしました。\n' +
        'ご変更が必要でしたら、下記よりお願いいたします。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ ご予約・ご変更\n' +
        '{url}',
    en: 'Bookings for {month} are now open.\n' +
        '\n' +
        'Your regular slot ({pattern}) has been booked for {month} automatically.\n' +
        'If you would like to change it, please use the link below.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ Book or change\n' +
        '{url}',
    zh: '{month}的预约已开放。\n' +
        '\n' +
        '您登记的固定时段（{pattern}），{month}的课程已自动为您预约。\n' +
        '如需变更，敬请从下方办理。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 预约・变更\n' +
        '{url}',
    'zh-Hant': '{month}的預約已開放。\n' +
        '\n' +
        '您登記的固定時段（{pattern}），{month}的課程已自動為您預約。\n' +
        '如需變更，敬請從下方辦理。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 預約・變更\n' +
        '{url}'
  },
  // ②' 翌月の解放（固定枠なし）— 先着順であることを伝え、まとめて押さえていただく
  month_open_free: {
    ja: '{month}分のご予約が可能になりました。\n' +
        '\n' +
        'ご希望のお時間は先着順です。\n' +
        '徐々にご予約可能な枠が少なくなってまいりますので、\n' +
        'まずはなるべくお早めに{quota}回分お押さえいただくことをおすすめいたします。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Bookings for {month} are now open.\n' +
        '\n' +
        'Preferred times are taken on a first-come basis.\n' +
        'Available slots become fewer as the days pass, so we recommend\n' +
        'securing your {quota} session(s) as early as you can.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '{month}的预约已开放。\n' +
        '\n' +
        '您希望的时段按先后顺序安排。\n' +
        '可预约的时段会逐渐减少，\n' +
        '建议您尽早先行预约 {quota}次。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '{month}的預約已開放。\n' +
        '\n' +
        '您希望的時段按先後順序安排。\n' +
        '可預約的時段會逐漸減少，\n' +
        '建議您盡早先行預約 {quota}次。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ③ 来店翌日B（今月の予約なし）
  visit_b: {
    ja: '昨日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次回のご予約がお決まりでなければ、下記よりお待ちしております。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your session yesterday.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'If your next session is not yet decided, we will be glad to welcome you below.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的预约尚未确定，敬请从下方预约，我们恭候您的光临。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的預約尚未確定，敬請從下方預約，我們恭候您的光臨。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ④ 来店翌日A（今月の予約あり）
  //   すでにご予約がある方なので押しを弱める。合う枠が無いときの逃げ道も示す
  //   （担当へご相談いただく）。2026-10-02 オーナー指示。
  visit_a: {
    ja: '昨日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次のご予約は {next} に承っております。\n' +
        '他日程でもいかがでしょうか。\n' +
        '\n' +
        'もし予約可能枠が合わなければ、担当宛にご希望の日時をご相談ください！\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your session yesterday.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'Your next session is reserved for {next}.\n' +
        'Another day would be very welcome as well.\n' +
        '\n' +
        'If none of the available times suit you, please let your trainer know your preferred date and time.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次预约为 {next}。\n' +
        '其他日期也十分欢迎。\n' +
        '\n' +
        '如果可预约的时段不合适，请将您希望的日期与时间告知您的教练！\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '昨日辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次預約為 {next}。\n' +
        '其他日期也十分歡迎。\n' +
        '\n' +
        '如果可預約的時段不合適，請將您希望的日期與時間告知您的教練！\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ★追いかけ送信用（2026-10-06）。中身は visit_a / visit_b と同じで、冒頭だけ「昨日」→「先日」。
  //   数日前の来店にも使うため、そのまま流用すると**来ていない日のことを言う**（Codex関門②の指摘）。
  visit_b_catchup: {
    ja: '先日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次回のご予約がお決まりでなければ、下記よりお待ちしております。\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your recent session.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'If your next session is not yet decided, we will be glad to welcome you below.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '前些天辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的预约尚未确定，敬请从下方预约，我们恭候您的光临。\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '前些天辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '若下次的預約尚未確定，敬請從下方預約，我們恭候您的光臨。\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
  // ④ 来店翌日A（今月の予約あり）
  //   すでにご予約がある方なので押しを弱める。合う枠が無いときの逃げ道も示す
  //   （担当へご相談いただく）。2026-10-02 オーナー指示。
  visit_a_catchup: {
    ja: '先日はお疲れさまでした。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '次のご予約は {next} に承っております。\n' +
        '他日程でもいかがでしょうか。\n' +
        '\n' +
        'もし予約可能枠が合わなければ、担当宛にご希望の日時をご相談ください！\n' +
        '\n' +
        '▼ ご予約\n' +
        '{url}',
    en: 'Thank you for your recent session.\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        'Your next session is reserved for {next}.\n' +
        'Another day would be very welcome as well.\n' +
        '\n' +
        'If none of the available times suit you, please let your trainer know your preferred date and time.\n' +
        '\n' +
        '▼ Book\n' +
        '{url}',
    zh: '前些天辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次预约为 {next}。\n' +
        '其他日期也十分欢迎。\n' +
        '\n' +
        '如果可预约的时段不合适，请将您希望的日期与时间告知您的教练！\n' +
        '\n' +
        '▼ 预约\n' +
        '{url}',
    'zh-Hant': '前些天辛苦了。\n' +
        '\n' +
        '{facts}\n' +
        '\n' +
        '您的下次預約為 {next}。\n' +
        '其他日期也十分歡迎。\n' +
        '\n' +
        '如果可預約的時段不合適，請將您希望的日期與時間告知您的教練！\n' +
        '\n' +
        '▼ 預約\n' +
        '{url}'
  },
};

// 文面の取り出し（_lbSt と同じ作り。辞書だけ別にして、LineBooking.js を太らせない）
function _lbNudgeMsg(lang, key, vars) {
  var e = _LB_NUDGE_MSG[key];
  var l = _lbNormLang(lang);
  var s = e ? (e[l] != null ? e[l] : e.ja) : key;
  if (typeof s === 'string' && vars) s = s.replace(/\{(\w+)\}/g, function (_, k) { return (vars[k] != null) ? vars[k] : ''; });
  return s;
}

// 「10月」/「October」/「10月」。文面の {month} に差し込む。
function _lbNudgeMonthLabel(month1, lang) {
  var l = _lbNormLang(lang);
  if (l === 'en') return ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'][month1 - 1];
  return month1 + '月';
}

// 予約画面（LIFF）の入口。_lbWelcomeText と同じ組み立て。
function _lbNudgeLiffUrl() {
  var liffId = _lbProp('LINE_LIFF_ID') || '2010827953-QgBQFzh9';
  return 'https://liff.line.me/' + liffId;
}

// 種別＋差し込み値 → 本文。month_open だけ固定枠の有無で辞書キーが分かれる。
function _lbNudgeText(kind, lang, v, catchUp) {
  var vars = {
    month: v.monthLabel, pattern: v.pattern, remain: v.remain, carry: v.carry, days: v.days,
    facts: v.facts || '',                      // 残数の一文（繰越の行は月末が近いときだけ入る）
    quota: v.quota, next: v.next, expire: v.expire, url: _lbNudgeLiffUrl()
  };
  if (kind === LB_NUDGE_KIND.TRANSFER)   return _lbNudgeMsg(lang, 'transfer', vars);
  if (kind === LB_NUDGE_KIND.MONTH_OPEN) return _lbNudgeMsg(lang, v.pattern ? 'month_open_fixed' : 'month_open_free', vars);
  // ★追いかけ送信は「先日」と言う。数日前の来店に「昨日」は嘘になる。
  if (kind === LB_NUDGE_KIND.VISIT_B)    return _lbNudgeMsg(lang, catchUp ? 'visit_b_catchup' : 'visit_b', vars);
  return _lbNudgeMsg(lang, catchUp ? 'visit_a_catchup' : 'visit_a', vars);
}

// ------------------------------------------------------------
// 小道具
// ------------------------------------------------------------
// 実送信の可否。既定は無効＝一覧だけ。オーナーが承認してプロパティを立てるまで送らない。
function _lbNudgeEnabled() { return _lbProp('LB_REMIND_ON') === '1'; }

// 数値プロパティ（空欄・壊れ値は既定へ倒す＝設定ミスで暴走しない）
function _lbNudgeNum(key, def) {
  var v = _lbProp(key);
  if (v === null || v === undefined || String(v) === '') return def;
  var n = Number(v);
  return (isFinite(n) && n >= 0) ? Math.floor(n) : def;
}

function _lbNudgeConf() {
  return {
    openDay:    _lbNudgeNum('LB_NUDGE_OPEN_DAY', LB_NUDGE_DEFAULTS.openDay),
    visitADays: _lbNudgeNum('LB_NUDGE_VISIT_A_DAYS', LB_NUDGE_DEFAULTS.visitADays),
    maxPerRun:  _lbNudgeNum('LB_NUDGE_MAX_PER_RUN', LB_NUDGE_DEFAULTS.maxPerRun)
  };
}

// 顧客IDの下4桁だけを見せる（氏名・全体IDを出力に残さない・要件8）
function _lbNudgeMask(customerId) {
  var s = String(customerId || '');
  return '*' + (s.length > 4 ? s.slice(-4) : s);
}

function _lbNudgeMonthKey(d) { return d.getFullYear() + '-' + ((d.getMonth() + 1) < 10 ? '0' : '') + (d.getMonth() + 1); }

// その日の 00:00（JST）。「昨日」の範囲を暦日で切るために使う。
function _lbNudgeDayStart(d, offsetDays) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + (offsetDays || 0), 0, 0, 0).getTime();
}
// 今月の終わり（23:59:59）。「今月の未来予約」と「残り日数」の両方で使う。
function _lbNudgeMonthEnd(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime(); }
// 今月の残り日数（今日を含む）。9/26 なら 30-26+1 = 5日。
function _lbNudgeDaysLeft(d) { return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate() - d.getDate() + 1; }
// 翌月の中旬（＝確実にその月）。残数を「翌月時点」で出すために使う（_lbBuildHome と同じ手）。
function _lbNudgeNextMonthDate(now) { return new Date(now.getFullYear(), now.getMonth() + 1, 15, 12, 0, 0); }

// 台帳の備考列は取消時に「resId|当日消化取消」となる。突き合わせは '|' の手前だけで行う。
function _lbNudgeResId(v) { return String(v || '').split('|')[0]; }

// 対象一覧から内部情報（lineUserId・生の顧客ID・本文）を落とす。外へ返すのは必ずこれを通す。
function _lbNudgePublic(plan) {
  function pub(t) {
    var o = { id: t.id, kind: t.kind, lang: t.lang };
    // 差し込んだ事実だけ返す（すべて下4桁IDに紐づく非PII）。本文と宛先は外へ出さない。
    if (t.remain != null)  o.remain = t.remain;
    if (t.carry != null)   o.carry = t.carry;
    if (t.days != null)    o.days = t.days;
    if (t.expire)          o.expire = t.expire;
    if (t.next)            o.next = t.next;
    if (t.pattern != null) o.pattern = t.pattern;
    if (t.quota)           o.quota = t.quota;
    return o;
  }
  return {
    code: plan.code, conf: plan.conf, month: plan.month, isOpenDay: plan.isOpenDay,
    examined: plan.examined, counts: plan.counts, skipped: plan.skipped, rowErrors: plan.rowErrors,
    targets: plan.targets.map(pub),
    demoted: plan.demoted.map(function (d) { return { id: d.id, kind: d.kind, insteadOf: d.insteadOf }; })
  };
}

// ------------------------------------------------------------
// 送信記録（nudge_log）— 再送抑止の正本。氏名は書かない（customer_id のみ）。
// ------------------------------------------------------------
function _lbNudgeLogSheet() {
  var ss = _lbSs();
  var sh = ss.getSheetByName(LB_NUDGE_LOG_SHEET) || ss.insertSheet(LB_NUDGE_LOG_SHEET);
  if (sh.getLastRow() === 0 || sh.getLastColumn() < LB_NUDGE_LOG_COLS) {
    sh.getRange(1, 1, 1, LB_NUDGE_LOG_COLS)
      .setValues([['送信日時', '種別', 'customer_id', '対象キー', '結果', '詳細']]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

// 全種別を1回のシート読みで引く（種別ごとに読み直すと人数ぶん往復が増える）。
//   結果が sent の行だけ数える＝未達（LINE側で弾かれた）は送ったことにしない＝翌日また試せる。
function _lbNudgeLogReadAll() {
  var out = {};
  for (var i = 0; i < LB_NUDGE_ORDER.length; i++) out[LB_NUDGE_ORDER[i]] = {};
  out._byDay = {};        // 'yyyy-MM-dd|customerId' → true（種別をまたいだ1日1通の判定に使う）
  out._readFailed = false;
  try {
    var sh = _lbSheet(LB_NUDGE_LOG_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    var n = Math.min(LB_NUDGE_LOG_SCAN, sh.getLastRow() - 1);
    var v = sh.getRange(2, 1, n, LB_NUDGE_LOG_COLS).getValues();
    for (var r = 0; r < v.length; r++) {
      var kind = String(v[r][1]);
      if (!out[kind]) continue;
      // ★'sending' も「送った扱い」にする（2026-10-05）。
      //   送信の直前に 'sending' を書き、結果が出てから 'sent'/'failed' に書き換える。
      //   途中でGASが落ちると 'sending' のまま残る＝**送ったかどうか分からない**。
      //   そのとき再送すると同じ人に2通届く。届かないより届きすぎる方が害が大きいので、
      //   分からないものは「送った」とみなして二度と送らない（安全側）。
      var _rst = String(v[r][4]);
      if (_rst !== 'sent' && _rst !== 'sending') continue;
      var cid = String(v[r][2] || ''); if (!cid) continue;
      var e = out[kind][cid] || (out[kind][cid] = { lastMs: null, keys: {} });
      var d = _lbParseResvDate(String(v[r][0] || '').replace(/^'/, ''));   // 文字列固定のため先頭 ' を外す
      if (d) {
        var ms = d.getTime(); if (e.lastMs === null || ms > e.lastMs) e.lastMs = ms;
        // 暦日ごとの印。種別をまたいで「今日はもう送った」を判定するために使う。
        out._byDay[Utilities.formatDate(d, SETTINGS.TIMEZONE, 'yyyy-MM-dd') + '|' + cid] = true;
      }
      var k = String(v[r][3] || ''); if (k) e.keys[k] = true;
    }
  } catch (e) {
    // ★読めなければ送らない（2026-10-05・fail-closed）。
    //   以前はここで「抑止を効かせないまま続行」していた。記録が読めない状態は、
    //   **すでに送った人をもう一度送る**状態と見分けがつかない。送らない側に倒す。
    out._readFailed = true;
    Logger.log('nudge_log 読み取り失敗（この実行は中止する）: ' + e.message);
  }
  return out;
}

// この追いかけ（期間）で、その方に既に送ったか。種別も日付も問わない。
//   記録の「対象キー」列に期間の鍵を入れておき、それで照合する。
//   暦日の抑止だけでは、翌日もう一度実行したときに2通目が出る。
//
//   ★「恒久的」ではない。記録を読むのは直近 LB_NUDGE_LOG_SCAN 行まで（既定3000行）。
//     その鍵の行が3000行より古くなったあとに同じ期間をもう一度実行すると、再び送られる。
//     追いかけは数日ぶんを1回流すための道具なので、いまの運用では足りる。
//     何か月も経ってから同じ期間を流し直す使い方をするなら、この制限を先に外すこと。
function _lbNudgeSentForRange(logs, customerId, rangeKey) {
  if (!logs || !rangeKey) return false;
  for (var i = 0; i < LB_NUDGE_ORDER.length; i++) {
    var e = logs[LB_NUDGE_ORDER[i]] && logs[LB_NUDGE_ORDER[i]][String(customerId)];
    if (e && e.keys && e.keys[rangeKey]) return true;
  }
  return false;
}

// 種別を問わず「その暦日にもう1通送っている」か。1人1日1通の最後の砦。
function _lbNudgeSentOnDay(logs, customerId, dayKey) {
  return !!(logs && logs._byDay && logs._byDay[dayKey + '|' + String(customerId)]);
}

// ★「まとめて1回で書く」はやめた（2026-10-05）。
//   全員へ送り終えてから記録すると、途中で時間切れになったとき
//   「送信済みだが記録なし」が残り、次の実行で同じ人にもう一度届く。
//   いまは送信の直前に1行ずつ書く（_lbNudgeLogAppendOne → _lbNudgeLogSettle）。
//   シートの往復は増えるが、対象は1日数名なので実害はない。

// ------------------------------------------------------------
// 判定に必要な事実を、シートごとに1回だけ読む
// ------------------------------------------------------------
// 名簿。読めなければ null（＝誰が対象か判断できない → 送らない）
function _lbNudgeMembers() {
  var sh = _lbSheet(LINE_BOOKING.MAP_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var vals = sh.getRange(2, 1, last - 1, MAP_COL.LANG).getValues();
  var out = [];
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    out.push({
      lineUserId:   String(r[MAP_COL.LINE_USER_ID - 1] || ''),
      customerId:   String(r[MAP_COL.CUSTOMER_ID - 1] || ''),
      name:         String(r[MAP_COL.NAME - 1] || ''),
      contractStat: String(r[MAP_COL.CONTRACT_STAT - 1] || ''),
      authState:    String(r[MAP_COL.AUTH_STATE - 1] || ''),
      lang:         _lbNormLang(r[MAP_COL.LANG - 1])
    });
  }
  return out;
}

// 予約台帳から会員ごとに「昨日の消化（＝来店 or 当日キャンセル）」と「今月の未来予約」を作る。
//   読めなければ null（＝来店したかも未来があるかも分からない → 送らない）。
//   未来は confirmed だけ（cancelled/changed は数えない）。
//
//   ★昨日の来店は confirmed と consumed の**両方**を数える（2026-09-30 修正）。
//     予約台帳の実データは confirmed 253件 / consumed 6件で、来店しても状態は
//     ほとんど confirmed のまま残る。消化の計上は、残数計算の側が
//     「過去の confirmed も消化とみなす」（LineBooking.js の
//     `if (st !== 'confirmed' && st !== 'consumed') continue;`）ことで成立している。
//     ここだけ consumed に限っていたため、実際に来店された方を1人も拾えていなかった。
//     **消化の定義はシステム全体で1つにする。**
//   ★来店を見る範囲（2026-10-06）
//     既定は「昨日の1日」。毎日動かす前提の作り。
//     `range` を渡すと、その期間に来店した人をまとめて拾う（取りこぼしの追いかけ送信に使う）。
//     判定そのものは同じ。見る窓の広さだけが変わる。
function _lbNudgeResvIndex(now, range) {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return {};
  var nowMs = now.getTime();
  var yStart = _lbNudgeDayStart(now, -1), yEnd = _lbNudgeDayStart(now, 0);
  if (range && range.fromMs != null && range.toMs != null) { yStart = range.fromMs; yEnd = range.toMs; }
  var monthEnd = _lbNudgeMonthEnd(now);
  var vals = sh.getRange(2, 1, last - 1, Math.max(12, sh.getLastColumn())).getValues();
  var idx = {};
  for (var i = 0; i < vals.length; i++) {
    var r = vals[i];
    var cid = String(r[2] || ''); if (!cid) continue;
    var dt = _lbParseResvDate(r[0]); if (!dt) continue;
    var t = dt.getTime(), st = String(r[6]);
    var e = idx[cid] || (idx[cid] = { yesterday: [], futureThisMonth: 0, nextRaw: null, nextMs: null });
    if ((st === 'confirmed' || st === 'consumed') && t >= yStart && t < yEnd) {
      e.yesterday.push(_lbNudgeResId(r[8]));   // 備考＝予約ID。振替権の source と突き合わせる
    } else if (st === 'confirmed' && t > nowMs && t <= monthEnd) {
      e.futureThisMonth++;
      if (e.nextMs === null || t < e.nextMs) { e.nextMs = t; e.nextRaw = r[0]; }
    }
  }
  return idx;
}

// 振替権シート。
//   ★「シートが無い」と「ブックが開けない」を分ける（2026-09-30）。
//     - ブックが開けない → 判断できない → null（送らない・fail-closed）
//     - ブックは開けるがシートが無い → **当日キャンセルが一度も無い**ということ。
//       事実として「振替権0件」と分かるので、空として扱ってよい。
//     ここを一緒くたに止めていたため、有効化の前にオーナーがGASエディタで
//     シートを作る作業が必要になっていた。その作業を無くす。
function _lbNudgeTcreditIndex() {
  var ss;
  try { ss = _lbSs(); } catch (e) { return null; }      // ブックが開けない＝判断できない
  if (!ss) return null;
  var sh = ss.getSheetByName(LB_TCREDIT_SHEET);
  if (!sh) return {};                                    // シートが無い＝振替権0件（事実）
  var last = sh.getLastRow();
  if (last < 2) return {};
  var v = sh.getRange(2, 1, last - 1, 5).getValues();
  var idx = {};
  for (var i = 0; i < v.length; i++) {
    var cid = String(v[i][0] || ''); if (!cid) continue;
    var g = _lbParseResvDate(v[i][1]), ex = _lbParseResvDate(v[i][2]), u = v[i][3] ? _lbParseResvDate(v[i][3]) : null;
    var e = idx[cid] || (idx[cid] = { rows: [], sources: {} });
    e.rows.push({ grantedMs: g ? g.getTime() : 0, expiresMs: ex ? ex.getTime() : 0, usedMs: u ? u.getTime() : 0 });
    var src = String(v[i][4] || ''); if (src) e.sources[src] = true;
  }
  return idx;
}

// 固定枠（recurring_patterns）。無ければ「固定枠なし」として扱う（fail-closed の対象ではない）。
function _lbNudgeRecurIndex() {
  var idx = {};
  try {
    var sh = _lbSheet(LB_RECUR_SHEET);
    if (!sh || sh.getLastRow() < 2) return idx;
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 10).getValues();
    for (var i = 0; i < v.length; i++) {
      if (!_lbTruthy(v[i][RP_COL.ACTIVE - 1])) continue;
      var cid = String(v[i][RP_COL.CUSTOMER_ID - 1] || ''); if (!cid) continue;
      (idx[cid] || (idx[cid] = [])).push({ weekday: Number(v[i][RP_COL.WEEKDAY - 1]), time: String(v[i][RP_COL.TIME - 1]) });
    }
  } catch (e) { Logger.log('recurring_patterns 読み取り失敗（固定枠なしとして続行）: ' + e.message); }
  return idx;
}

// 名簿の行が「そもそも発信していい相手か」。ここを緩めない（未認証・契約切れへは送らない）。
function _lbNudgeEligible(m, skipped) {
  // ★人数だけでは「誰が落ちたか」を追えない。顧客IDの下4桁も控える（氏名は出さない）。
  //   2026-09-30：オーナーの「9/29は8名来ている」と一覧の7名が合わず、
  //   どこで誰が落ちたのかを人数からは特定できなかったため。
  function drop(key) {
    (skipped._who[key] = skipped._who[key] || []).push(_lbNudgeMask(m.customerId));
    // ★氏名つきはエディタで見る版だけが使う。外へ出す経路（作業依頼）では触らない。
    (skipped._whoNamed[key] = skipped._whoNamed[key] || [])
      .push((m.name || '(氏名なし)') + '(' + m.customerId + ')');
  }
  if (!skipped._who) skipped._who = {};
  if (!skipped._whoNamed) skipped._whoNamed = {};
  if (!m.customerId)                { skipped.noCustomerId++; return false; }   // IDが無いので控えようがない
  if (m.authState !== 'verified')   { skipped.notVerified++;  drop('notVerified'); return false; }
  if (m.contractStat !== 'active')  { skipped.notActive++;    drop('notActive');   return false; }   // 空欄も対象外（判定不能＝送らない）
  if (!m.lineUserId)                { skipped.noLine++;       drop('noLine');      return false; }
  return true;
}

// 繰越上限。優先順：契約マスタ「繰越上限」列 ＞ 頻度テーブル（Allocate.js）＞ 率fallback。
//   契約が引けなかった場合はテーブルへ倒す（表示を0にするより実態に近い側へ倒す）。
function _lbNudgeCarryCap(m, quota) {
  var ov = null;
  try {
    var c = _lbFindContract(m.name, _lbPhoneByCustomerId(m.customerId));
    if (c && c.cols && c.cols.carryCap >= 0) {
      var raw = c.row[c.cols.carryCap];
      if (raw !== '' && raw != null) { var n = Number(raw); if (isFinite(n) && n >= 0) ov = Math.floor(n); }
    }
  } catch (e) { Logger.log('繰越上限の契約参照に失敗（頻度テーブルで続行）: ' + e.message); }
  return _lbResolveCarryCap(quota, ov, LINE_BOOKING.CARRYOVER_RATE);
}

// 残数の一文を組み立てる。
//   ★繰越の行は「月末が近いとき」だけ出す（2026-09-30 オーナー判断）。
//     月初に「うち1回は繰り越し可能です」と出しても行動につながらない。
//     31日も残っているのに繰越の話をすると、むしろ「来月に回してよい」と読める。
//     月末が近づいて初めて、繰り越せる回数が意味を持つ。
var LB_NUDGE_CARRY_SHOW_DAYS = 10;   // 残りこの日数以内なら繰越の行を出す
// 残りこの日数以内なら「（残り○日）」を添える。繰越の行と同じ日数にしてあるので、
//   文面の切り替わりが月に1回で済む（2026-10-02 オーナー判断）。
var LB_NUDGE_DAYS_SHOW_DAYS = 10;

function _lbNudgeFactsText(lang, f, carriedIn, kind) {
  var lines = [];
  // ★「先月から繰り越しました」は、その月にその方へ初めて送るとき、かつ15日までだけ。
  //   得た感じがあるので月の前半の行動につながる。後半に言っても古い話になる。
  //   （2026-09-30 オーナー判断：「その月にその方へ初めて送るとき、かつ15日まで」）
  if (carriedIn > 0) lines.push(_lbNudgeMsg(lang, 'facts_carried_in', { carried: carriedIn }));
  // 残り日数は月末が近いときだけ。月初の「残り31日」は急ぐ理由にならない。
  //   ④（すでにご予約がある方）だけは「あと○回」ではなく
  //   「すでにいただいているご予約の他、○回」と言う（残数は既にある予約を引いた数）。
  var booked = (kind === LB_NUDGE_KIND.VISIT_A);
  var remainKey = (f.days <= LB_NUDGE_DAYS_SHOW_DAYS)
    ? (booked ? 'facts_remain_booked_days' : 'facts_remain_days')
    : (booked ? 'facts_remain_booked' : 'facts_remain');
  lines.push(_lbNudgeMsg(lang, remainKey, { remain: f.remain, days: f.days }));
  // 繰越の行は月末が近いときだけ（月初に言っても「来月に回してよい」と読める）
  if (f.carry > 0 && f.days <= LB_NUDGE_CARRY_SHOW_DAYS) {
    lines.push(_lbNudgeMsg(lang, 'facts_carry', { carry: f.carry }));
  }
  return lines.join('\n');
}

// その月にその方へ「まだ一度も送っていない」か。送信記録で見る。
var LB_NUDGE_CARRIED_IN_UNTIL_DAY = 15;   // この日までなら繰越の報告を添える
function _lbNudgeFirstOfMonth(logs, customerId, now) {
  if (now.getDate() > LB_NUDGE_CARRIED_IN_UNTIL_DAY) return false;
  var mk = _lbNudgeMonthKey(now);
  for (var k = 0; k < LB_NUDGE_ORDER.length; k++) {
    var e = logs[LB_NUDGE_ORDER[k]] && logs[LB_NUDGE_ORDER[k]][String(customerId)];
    if (e && e.lastMs && _lbNudgeMonthKey(new Date(e.lastMs)) === mk) return false;   // 今月すでに送っている
  }
  return true;
}

// 共通して入れる事実（transfer を除く3種で使う）。
//   remain=今月の月額残 / carry=そのうち繰り越せる回数 / days=今月の残り日数。
//   remain が null＝残数を算出できない（degraded）＝送らない側へ倒す。
function _lbNudgeFacts(m, now) {
  var h = _lbBuildHome(m.customerId, m.name, m.lang, now.getTime());
  if (!h || !h.type) return { remain: null, carry: 0, days: _lbNudgeDaysLeft(now), quota: 0, carriedIn: 0 };
  var remain = (h.monthlyRemaining == null) ? null : Number(h.monthlyRemaining);
  var quota = Number(h.quota || 0);
  var carry = (remain == null) ? 0 : Math.max(0, Math.min(remain, _lbNudgeCarryCap(m, quota)));
  // carriedIn＝今月に繰り越されてきた回数（先月の余り）。月の前半に一度だけ伝える。
  var carriedIn = Math.max(0, Number(h.carryover || 0));
  return { remain: remain, carry: carry, days: _lbNudgeDaysLeft(now), quota: quota, carriedIn: carriedIn };
}

// 翌月に押さえていただきたい回数（②'固定枠なしの {quota}）。翌月時点の月額残が本命、
//   取れなければ契約の頻度へ倒す（0回分お押さえください、という文面を出さないため）。
function _lbNudgeNextQuota(m, now, fallbackQuota) {
  try {
    var h = _lbBuildHome(m.customerId, m.name, m.lang, _lbNudgeNextMonthDate(now).getTime());
    if (h && h.type && h.monthlyRemaining != null && Number(h.monthlyRemaining) > 0) return Number(h.monthlyRemaining);
  } catch (e) { Logger.log('翌月の回数算出に失敗（契約頻度で代用）: ' + e.message); }
  return fallbackQuota;
}

// ============================================================
// 対象の一覧（送らない）— 4種をまとめて1回の走査で作り、1人1通に絞る
// ============================================================
// 予約・契約の正本がどこにあるか。'sheet'（既定）か 'd1'。
//   D1へ移したら Script Property LB_SOURCE_OF_TRUTH を 'd1' にする。
//   その時点でリマインドは自動的に止まる（読み先をD1に直すまで送らない）。
function _lbNudgeSourceOfTruth() {
  var v = '';
  try { v = String(_lbProp('LB_SOURCE_OF_TRUTH') || '').trim().toLowerCase(); } catch (e) { v = ''; }
  return v ? v : 'sheet';
}

function lbNudgePlanAll(nowMs, range) {
  var now = (nowMs != null) ? new Date(nowMs) : new Date();   // 引数はテスト／確認で「今」を固定するため。本番は省略。
  // range を渡すと、来店を見る窓が「昨日の1日」から指定の期間に広がる（追いかけ送信・2026-10-06）。
  var ms = now.getTime();
  var conf = _lbNudgeConf();
  var nm = _lbNudgeNextMonthDate(now);
  var plan = {
    code: 'OK', conf: conf, asOf: Utilities.formatDate(now, SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm'),
    isOpenDay: (now.getDate() === conf.openDay), month: nm.getMonth() + 1, monthKey: _lbNudgeMonthKey(nm),
    examined: 0, targets: [], demoted: [], rowErrors: [],
    counts: { nudge_transfer: 0, nudge_month_open: 0, nudge_visit_b: 0, nudge_visit_a: 0 },
    skipped: { noCustomerId: 0, notVerified: 0, notActive: 0, noLine: 0,
               transferUsed: 0, transferExpired: 0, transferNone: 0,
               monthAlreadySent: 0, visitATooSoon: 0, noRemain: 0, remainUnknown: 0, noEvent: 0,
               sentToday: 0, dupMember: 0 }
  };

  // ★正本がD1へ移っていないか（2026-10-02）。
  //   リマインドはスプレッドシートを読んで判定する。予約や契約の正本がD1へ移ると、
  //   シートは消えずに「残ったまま古くなる」。既存の fail-closed はシートが読めない
  //   ときだけ働くので、この形はすり抜けて**黙って誤った連絡を送る**。
  //   例：D1に予約があるのにシートに無い → 「次のご予約がありません」と判定して催促する。
  //   送信は取り返しがつかないので、正本が移ったら読み先を直すまで1通も送らない。
  //   移行の日に切り替えを忘れても、止まるだけで事故にならない。
  var src = _lbNudgeSourceOfTruth();
  if (src !== 'sheet') { plan.code = 'SOURCE_MOVED_' + String(src).toUpperCase(); return plan; }

  var members = _lbNudgeMembers();
  if (members === null) { plan.code = 'NO_MAP_SHEET'; return plan; }
  var resv = _lbNudgeResvIndex(now, range);
  if (resv === null) { plan.code = 'NO_RESV_SHEET'; return plan; }      // 台帳が無い＝来店も未来も分からない → 送らない
  var tc = _lbNudgeTcreditIndex();
  if (tc === null) { plan.code = 'NO_TCREDIT_SHEET'; return plan; }     // 振替権が無い＝当日キャンセルと来店を区別できない → 送らない
  var recur = _lbNudgeRecurIndex();
  var log = _lbNudgeLogReadAll();
  // ★送信記録が読めなければ1通も出さない（2026-10-05）。
  //   記録は「もう送った人」を知る唯一の手がかり。読めない状態で送ると、
  //   昨日送った人へもう一度送ることになる。読めない＝中止。
  if (log._readFailed) { plan.code = 'LOG_UNREADABLE'; return plan; }
  var todayKey = Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy-MM-dd');
  var seenCid = {};   // この1回の一覧で、すでに1通ぶん作った会員（名簿の重複行よけ）

  for (var i = 0; i < members.length; i++) {
    var m = members[i];
    plan.examined++;
    try {
      if (!_lbNudgeEligible(m, plan.skipped)) continue;

      var ev = resv[m.customerId] || { yesterday: [], futureThisMonth: 0, nextRaw: null, nextMs: null };
      var tce = tc[m.customerId] || { rows: [], sources: {} };

      // 昨日の消化を「当日キャンセル」と「実来店」に割る。振替権の source に載っていれば当日キャンセル。
      var sameDayCancel = false, visited = false;
      for (var y = 0; y < ev.yesterday.length; y++) {
        if (ev.yesterday[y] && tce.sources[ev.yesterday[y]]) sameDayCancel = true; else visited = true;
      }

      var cand = [], reasons = [], facts = null;
      function needFacts() { if (facts === null) facts = _lbNudgeFacts(m, now); return facts; }

      // ── ① transfer：当日キャンセル＋振替権が未使用かつ有効期限内 ──
      if (sameDayCancel) {
        var st = _lbTransferCreditState(tce.rows, ms);
        if (st.available > 0) {
          cand.push({ kind: LB_NUDGE_KIND.TRANSFER, key: '',
                      expire: _lbFmtDateShort(new Date(st.nextExpiryMs), m.lang) });
        } else {
          var usedAny = false, expiredAny = false;
          for (var c = 0; c < tce.rows.length; c++) {
            if (tce.rows[c].usedMs) usedAny = true;
            else if (!(tce.rows[c].expiresMs >= ms)) expiredAny = true;
          }
          reasons.push(usedAny ? 'transferUsed' : (expiredAny ? 'transferExpired' : 'transferNone'));
        }
      }

      // ── ② month_open：解放日（既定25日）・契約有効（eligible で確認済み） ──
      if (plan.isOpenDay) {
        var le = log[LB_NUDGE_KIND.MONTH_OPEN][m.customerId];
        if (le && le.keys[plan.monthKey]) { reasons.push('monthAlreadySent'); }
        else {
          var f2 = needFacts();
          if (f2.remain === null) reasons.push('remainUnknown');
          else {
            var pats = recur[m.customerId] || [];
            var label = pats.map(function (p) { return _lbRecurLabel(p.weekday, p.time, m.lang); }).join('／');
            cand.push({ kind: LB_NUDGE_KIND.MONTH_OPEN, key: plan.monthKey, pattern: label,
                        quota: label ? 0 : _lbNudgeNextQuota(m, now, f2.quota) });   // 固定枠ありの文面に {quota} は出ない
          }
        }
      }

      // ── ③④ visit_b / visit_a：昨日「実際に来店」した方だけ ──
      //   ★当日キャンセルの方はここに来ない。振替（①）だけをお送りする。
      if (visited) {
        var f3 = needFacts();
        if (f3.remain === null) reasons.push('remainUnknown');
        else if (f3.remain <= 0) reasons.push('noRemain');
        else if (ev.futureThisMonth === 0) {
          cand.push({ kind: LB_NUDGE_KIND.VISIT_B, key: '' });
        } else {
          var la = log[LB_NUDGE_KIND.VISIT_A][m.customerId];
          if (la && la.lastMs !== null && (ms - la.lastMs) < conf.visitADays * 86400000) reasons.push('visitATooSoon');
          else cand.push({ kind: LB_NUDGE_KIND.VISIT_A, key: '', next: _lbFmtResvLabel(ev.nextRaw, m.lang) });
        }
      }

      if (!cand.length) {
        // 近いところまで来た理由を1つだけ数える（1人が複数のバケツに入らないようにする）。
        plan.skipped[reasons.length ? reasons[0] : 'noEvent']++;
        continue;
      }

      // ★1人1日1通を、種別をまたいで守る（2026-10-05）。
      //   これまで送信済みの記録で抑えていたのは month_open（対象月）と visit_a（7日）だけで、
      //   transfer と visit_b は条件が続くかぎり毎回候補になった。1日1回のトリガーしか無い前提の
      //   作りで、トリガーの二重発火・手動の再実行・前回の途中終了があると、同じ人に同じ案内が
      //   何通も届く。「1回の実行の中で1通」ではなく「その日に1通」で抑える。
      if (_lbNudgeSentOnDay(log, m.customerId, todayKey)) { plan.skipped.sentToday++; continue; }

      // ★同じ会員が名簿に2行あるとき、この1回の中で2通作らない（2026-10-05）。
      //   送信済みの記録は「この実行より前」しか見ていないので、
      //   1回の一覧の中に同じ人が2度入ると、どちらも抑止をすり抜ける。
      if (seenCid[m.customerId]) { plan.skipped.dupMember++; continue; }

      // ★追いかけ送信は「来店した方」だけに送る（2026-10-06・Codex関門②の指摘）。
      //   range は来店を見る窓を広げるが、同じ `yesterday` を振替の判定も使っている。
      //   そのまま走らせると、期間中に**当日キャンセルした方**にも振替の案内が届く。
      //   さらに実行日が解放日なら、期間と関係ない全会員に翌月分の案内が飛ぶ。
      //   どちらも「来店した方へのお礼」という今回の目的から外れる。
      if (range) {
        cand = cand.filter(function (c) {
          return c.kind === LB_NUDGE_KIND.VISIT_A || c.kind === LB_NUDGE_KIND.VISIT_B;
        });
        if (!cand.length) { plan.skipped.notVisitKind = (plan.skipped.notVisitKind || 0) + 1; continue; }
      }

      // ★この追いかけで既に送った方には、日をまたいでも二度と送らない。
      //   種別をまたいだ抑止は「同じ暦日」しか見ないので、翌日もう一度実行すると
      //   予約の無い来店者（visit_b）には2通目が届く。期間を鍵にして恒久的に抑える。
      // （注：記録の読み取りは直近3000行まで。古くなった鍵は見えなくなる＝_lbNudgeSentForRange のコメント）
      if (range && _lbNudgeSentForRange(log, m.customerId, range.key)) {
        plan.skipped.catchUpDone = (plan.skipped.catchUpDone || 0) + 1; continue;
      }

      // ── 優先順位で1通に絞る。絞って送らなかったものは demoted として一覧に出す ──
      cand.sort(function (a, b) { return LB_NUDGE_ORDER.indexOf(a.kind) - LB_NUDGE_ORDER.indexOf(b.kind); });
      var win = cand[0];
      var f = needFacts();
      var v = {
        monthLabel: _lbNudgeMonthLabel(plan.month, m.lang),
        pattern: win.pattern || '', quota: win.quota || 0,
        remain: f.remain, carry: f.carry, days: f.days,
        // 残数の一文。繰越の行は月末が近いときだけ、
        //   「先月から繰り越しました」は今月はじめての案内かつ15日までだけ。
        facts: _lbNudgeFactsText(m.lang, f,
                 _lbNudgeFirstOfMonth(log, m.customerId, now) ? f.carriedIn : 0, win.kind),
        next: win.next || '', expire: win.expire || ''
      };
      plan.counts[win.kind]++;
      plan.targets.push({
        id: _lbNudgeMask(m.customerId), kind: win.kind, lang: m.lang,
        _cidFull: m.customerId, _name: m.name,   // ★エディタで見る版だけが使う。外へ出す経路では触らない
        remain: (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.remain,   // transfer に残数の話は入れない（オーナー指示）
        carry:  (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.carry,
        days:   (win.kind === LB_NUDGE_KIND.TRANSFER) ? null : f.days,
        expire: v.expire, next: v.next, pattern: v.pattern, quota: v.quota,
        _to: m.lineUserId, _cid: m.customerId, _key: (range ? range.key : win.key), _text: _lbNudgeText(win.kind, m.lang, v, !!range)
      });
      seenCid[m.customerId] = true;   // ここから先、この実行ではこの会員に2通目を作らない
      for (var d = 1; d < cand.length; d++) {
        plan.demoted.push({ id: _lbNudgeMask(m.customerId), kind: cand[d].kind, insteadOf: win.kind });
      }
    } catch (err) {
      // ★1人分の不備（残数データ不整合など）で全員分を止めない。氏名は残さない。
      plan.rowErrors.push(_lbNudgeMask(m.customerId) + ': ' + err.message);
      Logger.log('nudge 1件失敗（他は継続）: ' + err.message);
    }
  }
  return plan;
}

// ============================================================
// 送信（ここだけが実際にLINEへ出す。既定は無効なので何もしない）
// ============================================================
function _lbNudgeSend(plan, nowMs, alreadyLocked) {
  var res = { success: true, enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0, plan: _lbNudgePublic(plan) };
  // ★中止したときは success を倒し、理由を返す（2026-10-05）。
  //   以前は success:true のまま返していた。1通も送れなかったのに「成功」と見え、
  //   記録が読めない・正本が移ったといった**止まっている状態が黙って続く**。
  if (plan.code !== 'OK') { res.success = false; res.code = plan.code; Logger.log('nudge 中止（fail-closed）: ' + plan.code); return res; }
  if (!res.enabled) {
    // ★既定の道。ここで必ず止まる。記録も残さない（あとで有効にしたとき抑止が誤作動しないように）。
    Logger.log('nudge は無効（LB_REMIND_ON≠1）。対象' + plan.targets.length + '名を一覧しただけで送信していません。');
    return res;
  }
  // ★同時に2つ走らせない（2026-10-05）。
  //   通常の入口（lbNudgeDaily）は、一覧を作る前からロックを取っている（alreadyLocked=true）。
  //   ここで取り直すのは、将来この関数が単独で呼ばれたときに裸にならないようにするため。
  //   待たずに諦める（tryLock(0)）。待って送るより、送らない方が安全。
  var _lock = null;
  if (!alreadyLocked) {
    try { _lock = LockService.getScriptLock(); } catch (e) { _lock = null; }
    // 入口と同じ扱い：守れないなら送らない。
    if (!_lock) {
      res.success = false; res.code = 'LOCK_UNAVAILABLE';
      Logger.log('nudge 中止：排他ロックを使えないため何も送りません');
      return res;
    }
    if (!_lock.tryLock(0)) {
      res.success = false; res.code = 'ALREADY_RUNNING';
      Logger.log('nudge 中止：別の実行が動いています（二重送信を避けるため何も送りません）');
      return res;
    }
  }
  try {
    var cap = plan.conf.maxPerRun;
    var now2 = (nowMs != null) ? nowMs : new Date().getTime();
    for (var i = 0; i < plan.targets.length; i++) {
      var t = plan.targets[i];
      if (cap > 0 && (res.sent + res.failed) >= cap) { res.deferred++; continue; }   // 残りは翌日の実行へ
      // ★送る前に記録する（2026-10-05）。
      //   以前は全員へ送り終えてから一括で記録していた。途中でGASが時間切れになると、
      //   送信は済んでいるのに記録が残らず、次の実行で同じ人にもう一度届いた。
      //   先に 'sending' を残しておけば、落ちても「送ったかもしれない人」として二度と送らない。
      var _row = -1;
      try { _row = _lbNudgeLogAppendOne({ kind: t.kind, customerId: t._cid, key: t._key }, now2); }
      catch (e) { Logger.log('nudge_log に書けないため送信を中止: ' + e.message); res.success = false; res.code = 'LOG_UNWRITABLE'; break; }
      var ok = false, detail = '';
      try { ok = _lbPush(t._to, t._text, t.kind); } catch (e) { detail = String(e.message).slice(0, 200); Logger.log('nudge push例外: ' + e.message); }
      if (ok) res.sent++; else { res.failed++; res.success = false; }   // 1人でも届かなければ成功とは言わない
      _lbNudgeLogSettle(_row, { kind: t.kind, customerId: t._cid }, ok ? 'sent' : 'failed', ok ? '' : (detail || 'push未達'));
      Utilities.sleep(250);   // 連続送信で429を招かない間隔（sendLineReminders と同じ）
    }
  } finally {
    if (_lock) { try { _lock.releaseLock(); } catch (e) { } }
  }
  Logger.log('nudge: ' + JSON.stringify({ sent: res.sent, failed: res.failed, deferred: res.deferred, counts: plan.counts }));
  return res;
}

// 送信の直前に1行だけ書き、その行番号を返す（必ず2行目＝いちばん上に挿入する）。
//   書けなければ例外を投げる＝呼び出し側が送信を止める。記録できない送信は、
//   次の実行で同じ人にもう一度送ることになるため。
function _lbNudgeLogAppendOne(row, nowMs) {
  var sh = _lbNudgeLogSheet();
  var when = Utilities.formatDate(new Date(nowMs), SETTINGS.TIMEZONE, 'yyyy/MM/dd HH:mm');
  sh.insertRowsAfter(1, 1);
  sh.getRange(2, 1, 1, LB_NUDGE_LOG_COLS)
    .setValues([["'" + when, row.kind, row.customerId, row.key || '', 'sending', '']]);
  SpreadsheetApp.flush();   // 送る前に確実に残す
  return 2;
}

// 送信の結果で 'sending' を書き換える。ここが失敗しても 'sending' のまま残り、
//   再送されない側（安全側）に倒れる。
//   ★書く前に、その行が本当に自分の行かを確かめる（2026-10-05）。
//     行番号で場所を覚えているので、送信している間に誰かがシートの先頭へ行を足すと
//     ずれて**別人の記録を書き換える**。種別と顧客IDが一致しなければ何も書かない。
function _lbNudgeLogSettle(rowIndex, expect, result, detail) {
  if (!(rowIndex > 0)) return;
  try {
    var sh = _lbNudgeLogSheet();
    var cur = sh.getRange(rowIndex, 2, 1, 2).getValues()[0];   // B=種別 / C=customer_id
    if (String(cur[0]) !== String(expect.kind) || String(cur[1]) !== String(expect.customerId)) {
      Logger.log('nudge_log の行がずれたため結果を書きません（sending のまま残す＝再送しない）');
      return;
    }
    sh.getRange(rowIndex, 5, 1, 2).setValues([[result, String(detail || '').slice(0, 200)]]);
  } catch (e) { Logger.log('nudge_log の結果更新に失敗（sending のまま残す＝再送しない）: ' + e.message); }
}

// ============================================================
// ★オーナー確認用：送らずに「誰に何を送るか」だけ出す（主たる入口）
//   GASエディタで lbNudgePreview を実行 → ログに一覧が出る。1通も送らない。
// ============================================================
function lbNudgePlan(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var plan = lbNudgePlanAll(ms);
  var pub = _lbNudgePublic(plan);
  pub.asOf = plan.asOf;
  pub.enabled = _lbNudgeEnabled();
  return pub;
}

var _LB_NUDGE_SKIP_LABEL = {
  noCustomerId: '顧客ID未設定', notVerified: '未認証', notActive: '契約が有効でない', noLine: 'LINE未連携',
  transferUsed: '振替権を使用済み', transferExpired: '振替権が期限切れ', transferNone: '振替権の記録なし',
  monthAlreadySent: 'その月は送信済み', visitATooSoon: '前回の来店翌日Aから日が浅い',
  noRemain: '月額残が0', remainUnknown: '残数が算出できない', noEvent: '該当する出来事なし',
  sentToday: '今日すでに送信済み', dupMember: '名簿に同じ会員の行が重複',
  notVisitKind: '来店以外（追いかけでは送らない）', catchUpDone: 'この期間の追いかけは送信済み'
};
function _lbNudgeSkipText(skipped) {
  var parts = [];
  for (var k in skipped) {
    if (k === '_who' || k === '_whoNamed' || !skipped[k]) continue;
    var who = (skipped._who && skipped._who[k]) ? '（' + skipped._who[k].join(' ') + '）' : '';
    parts.push((_LB_NUDGE_SKIP_LABEL[k] || k) + ' ' + skipped[k] + '名' + who);
  }
  return parts.length ? parts.join(' / ') : 'なし';
}
function _lbNudgeIndent(s) { return String(s).split('\n').map(function (l) { return '      | ' + l; }).join('\n'); }

function lbNudgePreview(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  return _lbNudgePreviewText(lbNudgePlanAll(ms), null);
}

// 一覧の整形。毎日の送信と追いかけ送信で同じものを使う（見え方がずれないように）。
//   title を渡すと見出しに添える（例：「追いかけ送信（来店 2026/09/30〜2026/10/05）」）。
function _lbNudgePreviewText(plan, title) {
  var conf = plan.conf;
  var out = [];
  out.push('=== 予約を促すリマインド 一覧（送信しません） ' + plan.asOf + ' ==='
           + (title ? '\n【' + title + '】' : ''));
  // ★どの版が本番で動いているかを出す。
  //   「直したのに出力が変わらない」とき、反映漏れなのか不具合なのかを切り分けられない。
  //   今日それで時間を使ったので、印を出す（2026-10-01）。
  out.push('版: ' + LB_NUDGE_BUILD);
  out.push('実送信: ' + (_lbNudgeEnabled() ? '⚠️ 有効（LB_REMIND_ON=1）' : '無効（既定）— この一覧を見て決めてください'));
  out.push('設定: 解放日' + conf.openDay + '日（本日は' + (plan.isOpenDay ? '解放日です' : '解放日ではありません') + '）／来店翌日Aの間隔' + conf.visitADays + '日／1回上限' + conf.maxPerRun + '通');
  out.push('※氏名は出しません。会員は顧客IDの下4桁で示します。');
  if (plan.code !== 'OK') {
    out.push('');
    if (String(plan.code).indexOf('SOURCE_MOVED') === 0) {
      out.push('⛔ 中止: 予約・契約の正本がスプレッドシートから移っています（' + plan.code + '）。');
      out.push('   リマインドはスプレッドシートを読んで判定します。正本が移ったまま送ると、');
      out.push('   古いデータで「次のご予約がありません」と判断し、予約済みの方に催促してしまいます。');
      out.push('   ★リマインドの読み先を新しい正本に直してから、再開してください。');
      out.push('   （一時的に元へ戻すなら Script Property LB_SOURCE_OF_TRUTH を sheet に）');
    } else {
      out.push('⛔ 中止（fail-closed）: ' + plan.code + ' — 必要なシートが読めないため1通も出しません。');
    }
    var stop = out.join('\n'); Logger.log(stop); return stop;
  }
  out.push('');
  out.push('── 名簿' + plan.examined + '件を確認 ／ 送る対象 ' + plan.targets.length + '名（1人1日1通）');

  for (var k = 0; k < LB_NUDGE_ORDER.length; k++) {
    var kind = LB_NUDGE_ORDER[k];
    var list = plan.targets.filter(function (t) { return t.kind === kind; });
    out.push('');
    out.push(LB_NUDGE_LABEL[kind] + ': ' + list.length + '名');
    if (!list.length) { out.push('   （該当なし）'); continue; }
    for (var j = 0; j < list.length; j++) {
      var t = list[j], detail = [];
      if (t.remain != null) detail.push('今月残' + t.remain + '回');
      if (t.carry != null)  detail.push('繰越可' + t.carry + '回');
      if (t.expire)         detail.push('振替期限' + t.expire);
      if (t.next)           detail.push('次回' + t.next);
      if (t.pattern)        detail.push('固定枠' + t.pattern);
      out.push('   ・' + t.id + '（' + t.lang + (detail.length ? '・' + detail.join('・') : '') + '）');
      // ★ここに出すのは「実際に送る文面そのもの」。
      //   以前はテンプレートから作り直したサンプルを1人ぶんだけ出していたため、
      //   残数の一文（facts）が抜けた文面が一覧に出て、確認そのものが成立しなかった（2026-10-01）。
      //   作り直すと必ずまた食い違う。だから送る文面を直接見せる。
      out.push('     ▼実際に送る文面（' + t.lang + '）');
      out.push(_lbNudgeIndent(t._text));
    }
  }

  out.push('');
  out.push('── 優先順位で見送り: ' + (plan.demoted.length || 'なし'));
  for (var d = 0; d < plan.demoted.length; d++) {
    out.push('   ・' + plan.demoted[d].id + ' ' + LB_NUDGE_LABEL[plan.demoted[d].kind] + '（' + LB_NUDGE_LABEL[plan.demoted[d].insteadOf] + 'を送るため）');
  }
  out.push('── 対象外: ' + _lbNudgeSkipText(plan.skipped));
  if (plan.rowErrors.length) out.push('── ⚠️ 判定できなかった会員: ' + plan.rowErrors.join(' / '));

  var txt = out.join('\n');
  Logger.log(txt);
  return txt;
}

// ============================================================
// 1日1回のトリガーの入口（★これ以外のトリガーは作らない）
//   4種すべてをこの1回でまとめて判定する。month_open は解放日（既定25日）だけ内部で当たる。
// ============================================================
// ============================================================
// 追いかけ送信：ある期間に来店した方へ、まとめて1回だけ送る（2026-10-06）
// ============================================================
//   ★なぜ要るのか
//     毎日の送信は「昨日来た人」だけを見る。仕組みを有効にする前に来店した方には
//     何も届かない。運用を始める前の数日ぶんを、1人1通で追いかける。
//
//   ★重複させない仕掛けは、毎日の送信とまったく同じものを使う
//     ・種別をまたいだ「その日1通」（送信記録の暦日で判定）
//     ・同じ一覧の中の重複（名簿に同じ会員の行が2つある場合）
//     ・排他ロック。読む→決める→送る→記録する、を1つの実行だけが通る
//     ・送る前に記録する。途中で落ちても再送しない
//     したがって **毎日の送信と同じ日に実行しても、同じ人に2通は行かない。**
//
//   ★期間に何度来ていても1通
//     来店が複数あっても会員ごとに1行にまとめている（_lbNudgeResvIndex）。
//     文面は「今月の予約が残っているか」で選ばれる（来店翌日A／B）。
//
//   使い方（GASエディタ）：
//     lbNudgeCatchUpPreview('2026-09-30', '2026-10-05')   送らずに一覧だけ
//     lbNudgeCatchUp('2026-09-30', '2026-10-05')          実際に送る（LB_REMIND_ON=1 のときだけ）
//   どちらも「to」の日を**含む**（その日の終わりまで）。
function _lbNudgeCatchUpRange(fromYmd, toYmd) {
  var tz = SETTINGS.TIMEZONE;
  var f = _lbParseResvDate(String(fromYmd) + ' 00:00');
  var t = _lbParseResvDate(String(toYmd) + ' 00:00');
  if (!f || !t) return null;
  var toEnd = new Date(t.getTime()); toEnd.setDate(toEnd.getDate() + 1);   // to の日を含める
  if (f.getTime() >= toEnd.getTime()) return null;
  return { fromMs: f.getTime(), toMs: toEnd.getTime(),
           // ★記録に残す鍵。これで「この期間の追いかけは済み」を日をまたいで判定する。
           key: 'catchup:' + Utilities.formatDate(f, tz, 'yyyyMMdd') + '-' + Utilities.formatDate(t, tz, 'yyyyMMdd'),
           label: Utilities.formatDate(f, tz, 'yyyy/MM/dd') + '〜' + Utilities.formatDate(t, tz, 'yyyy/MM/dd') };
}

// ============================================================
// ★GASエディタから実行する入口（2026-10-06）
// ============================================================
//   エディタの関数プルダウンからは**引数を渡せない**。
//   日付はここに書いて実行する。既存の lbNudgePreviewNamed と同じ作法。
//
//   手順：
//     ① 下の FROM / TO を直す
//     ② lbNudgeCatchUpCheck を実行 → ログで「誰に何が届くか」を確かめる（送りません）
//     ③ 問題なければ lbNudgeCatchUpSend を実行（ここで実際に届きます）
//   ②を飛ばして③をしない。送ったものは取り消せない。

function lbNudgeCatchUpCheck() {
  var FROM = '2026-09-30';   // ← 来店の期間（この日を含む）
  var TO   = '2026-10-05';   // ← この日も含む
  Logger.log(lbNudgeCatchUpPreview(FROM, TO));
}

function lbNudgeCatchUpSend() {
  var FROM = '2026-09-30';   // ← 上と同じ日付にすること
  var TO   = '2026-10-05';
  var r = lbNudgeCatchUp(FROM, TO);
  Logger.log('結果: ' + JSON.stringify({ success: r.success, code: r.code || '', sent: r.sent, failed: r.failed, deferred: r.deferred }));
  return r;
}

/** 送らずに一覧だけ出す。実際に送る前に必ずこれで確かめる。 */
function lbNudgeCatchUpPreview(fromYmd, toYmd) {
  var r = _lbNudgeCatchUpRange(fromYmd, toYmd);
  if (!r) { var e = '⛔ 期間の指定が正しくありません。例：lbNudgeCatchUpPreview(\'2026-09-30\', \'2026-10-05\')'; Logger.log(e); return e; }
  var plan = lbNudgePlanAll(new Date().getTime(), r);
  return _lbNudgePreviewText(plan, '追いかけ送信（来店 ' + r.label + '）');   // 整形の中でログに出る（二重に出さない）
}

/** 実際に送る。LB_REMIND_ON=1 のときだけ。1人1通。 */
function lbNudgeCatchUp(fromYmd, toYmd) {
  var r = _lbNudgeCatchUpRange(fromYmd, toYmd);
  if (!r) { Logger.log('⛔ 期間の指定が正しくありません'); return { success: false, code: 'BAD_RANGE' }; }
  var ms = new Date().getTime();
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  if (!lock) { Logger.log('nudge 中止：排他ロックを使えないため何も送りません'); return { success: false, code: 'LOCK_UNAVAILABLE' }; }
  if (!lock.tryLock(0)) { Logger.log('nudge 中止：別の実行が動いています'); return { success: false, code: 'ALREADY_RUNNING' }; }
  try {
    Logger.log('追いかけ送信：来店 ' + r.label + ' を対象にします');
    return _lbNudgeSend(lbNudgePlanAll(ms, r), ms, true);
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

function lbNudgeDaily(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  // ★ロックは「誰に送るかを決める前」に取る（2026-10-05）。
  //   送信だけを囲っても足りない。2つの実行が同時に一覧を作ると、どちらも
  //   「まだ誰にも送っていない」記録を読む。先に送った方がロックを解放したあと、
  //   もう一方が**古い一覧のまま**送る＝同じ人に2通届く。
  //   読む→決める→送る→記録する、までを1つの実行だけが通るようにする。
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  // ★ロックそのものが使えないなら送らない（2026-10-05）。
  //   ここで null のまま先へ進むと、**何も守っていないのに「ロック済み」として**送ることになる。
  //   2つ走れば同じ人に2通届く。守れないときは送らない。
  if (!lock) {
    Logger.log('nudge 中止：排他ロックを使えないため何も送りません');
    return { success: false, code: 'LOCK_UNAVAILABLE', enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0 };
  }
  if (!lock.tryLock(0)) {
    Logger.log('nudge 中止：別の実行が動いています（二重送信を避けるため何も送りません）');
    return { success: false, code: 'ALREADY_RUNNING', enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0 };
  }
  try {
    return _lbNudgeSend(lbNudgePlanAll(ms), ms, true);   // 第3引数＝ロックは取得済み
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { } }
  }
}

// ------------------------------------------------------------
// 初回だけ：判定に使うシートを用意する（fail-closed で止まらないように）
//   transfer_credits は当日キャンセルが1件も無いと存在しない。存在しないと全リマインドが止まる
//   仕様（要件9）なので、有効化の前に1回だけ実行して空のシートを作っておく。
// ------------------------------------------------------------
function lbNudgeSetupSheets() {
  _lbTcreditSheet();       // transfer_credits（当日キャンセルの見分けに必須）
  _lbNudgeLogSheet();      // nudge_log（送信記録・再送抑止の正本）
  Logger.log('✅ transfer_credits / nudge_log を確認しました（無ければ作成済み）');
}

// ------------------------------------------------------------
// トリガー登録（★オーナー承認後に、オーナーが1回だけ実行する。ここでは登録しない）
//   1日1回だけ。分ごと・時間ごとは作らない（過去に応答が2倍以上遅くなり顧客に実害が出た）。
//   時刻は既定10時。オーナーが決めたら atHour の数字を直す。
// ------------------------------------------------------------
function setupNudgeTrigger() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'lbNudgeDaily') ScriptApp.deleteTrigger(t);   // 重複登録防止
  });
  ScriptApp.newTrigger('lbNudgeDaily').timeBased().everyDays(1).atHour(10).inTimezone(SETTINGS.TIMEZONE).create();
  Logger.log('✅ 予約を促すリマインドを毎日10時に設定しました（実送信は LB_REMIND_ON=1 のときだけ）');
}

// ============================================================
// 一覧（氏名つき）— GASエディタから実行する版
//
//   なぜ分けるか：
//     作業依頼の結果は「作業番号さえ分かれば誰でも読める」URLに置かれる（合言葉が要らない）。
//     そこへお客様の氏名を載せると、社外へ出る経路ができる。
//     だから氏名を出す版はエディタ専用にして、Googleの外へ出さない。
//     （EdgeVerify の verifyEdgeRemaining / verifyEdgeRemainingText と同じ考え方）
//
//   使い方：GASエディタでこの関数を選び、実行 → 実行ログに出ます。
//     日付を変えたいときは下の dateStr を書き換えてください（空なら今日）。
// ============================================================
function lbNudgePreviewNamed() {
  var dateStr = '';          // ← 例 '2026-10-01'。空なら今日
  var ms = null;
  var m = String(dateStr).match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) ms = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0).getTime();
  Logger.log(_lbNudgePreviewNamedText(ms));
}

function _lbNudgePreviewNamedText(nowMs) {
  var ms = (nowMs != null) ? nowMs : new Date().getTime();
  var plan = lbNudgePlanAll(ms);
  var out = [];
  out.push('=== 送信内容の確認（氏名つき・送信しません） ' + plan.asOf + ' ===');
  out.push('★この出力には個人情報が含まれます。外部へ貼らないでください。');
  out.push('実送信: ' + (_lbNudgeEnabled() ? '⚠️ 有効（LB_REMIND_ON=1）' : '無効（既定）'));
  out.push('');

  if (!plan.targets.length) {
    out.push('送る対象はいません。');
  } else {
    out.push('送る対象 ' + plan.targets.length + '名');
    out.push('');
    for (var i = 0; i < plan.targets.length; i++) {
      var t = plan.targets[i];
      out.push('──────────────────────────────');
      out.push('【' + (i + 1) + '】 ' + (t._name || '(氏名なし)') + '  顧客ID: ' + (t._cidFull || '(なし)'));
      out.push('  種別: ' + (LB_NUDGE_LABEL[t.kind] || t.kind) + ' ／ 言語: ' + (t.lang || 'ja'));
      out.push('  ▼ 実際に送られる文面');
      var lines = String(t._text || '').split('\n');
      for (var j = 0; j < lines.length; j++) out.push('    ' + lines[j]);
      out.push('');
    }
  }

  // 除外された方も氏名で出す（誰が落ちているかを確認できるように）
  if (plan.skipped && plan.skipped._whoNamed) {
    out.push('──────────────────────────────');
    out.push('■ 対象外');
    for (var k in plan.skipped._whoNamed) {
      out.push('  ' + (_LB_NUDGE_SKIP_LABEL[k] || k) + '：' + plan.skipped._whoNamed[k].join(' / '));
    }
  }
  return out.join('\n');
}
