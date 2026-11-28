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
var LB_NUDGE_BUILD = '2026-11-28a 日次点検の「途中で」のメールに段ごとの経過（LB_HEALTH_STEP）を載せ、打ち切りと落ちたのを見分ける／2026-11-26a 設計37 改訂5：1日1通の読み取りに nudge_vacancy を数える（優先順位は変えない）・声かけが終わった印 LB_NUDGE_DAILY_DONE・空き枠のお知らせの区画／2026-11-23c うながしの最後に自己修理（lbSelfHeal）を相乗り（開始時刻を渡して予算を決める）・日次点検の見張りに「途中で落ちた」（LAST > DONE かつ2時間超・DONE 未設定の間は出さない）と壊れた印のメールを足す（自己修理 P1）';

// ロックを待つ時間。0 にすると、他の処理と重なっただけで送信が丸ごと飛ぶ（2026-10-07 実際に起きた）。
//   他の処理は 5〜15秒待っている。それより長めに取る（送信は1日1回で、急がないため）。
var LB_NUDGE_LOCK_WAIT_MS = 30000;

// ロックが取れずに送れなかった回の記録（設定に置く。nudge_log には書かない＝上のコメント参照）。
var LB_NUDGE_LOCK_MISS_KEY = 'LB_NUDGE_LOCK_MISS';
// ★解放日に「翌月を覆う契約が無くて案内を送れなかった人」を記録する鍵（2026-10-08）。
//   解放の判定は25日にしか走らない。**その日に契約が入っていなければ、後で入れても飛ばない。**
//   記録しておかないと、誰も気づかない（点検の出力は私が見たときだけ）。
//   日次点検（dailyHealthCheck）がこれを見て、オーナーへのメールに載せる。
var LB_NUDGE_OPEN_MISS_KEY = 'LB_NUDGE_OPEN_MISS';

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
// ★1日1通に数える種別（設計37 改訂5 §5-21-1）。空き枠のお知らせ（nudge_vacancy）も「今日はもう1通」に数える。
//   優先順位（LB_NUDGE_ORDER）・counts・候補・追いかけの判定には入れない＝声かけの計画は今と同じ
var LB_NUDGE_DAILY_CAP_KINDS = LB_NUDGE_ORDER.concat(['nudge_vacancy']);
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
    ja:        '今月はあと {remain}回\nご利用いただけます。',
    en:        'You have {remain} session(s) left this month.',
    zh:        '本月还可使用 {remain}次。',
    'zh-Hant': '本月還可使用 {remain}次。'
  },
  facts_remain_days: {
    ja:        '今月はあと {remain}回（残り{days}日）\nご利用いただけます。',
    en:        'You have {remain} session(s) left this month ({days} days remaining).',
    zh:        '本月还可使用 {remain}次（剩余{days}天）。',
    'zh-Hant': '本月還可使用 {remain}次（剩餘{days}天）。'
  },
  // ④ 来店翌日A（すでにご予約がある方）専用。残数は既にあるご予約を引いた数なので、
  //   「あと○回」ではなく「すでにいただいているご予約の他、○回」と言う方が正確で、
  //   押しつけがましくない（2026-10-02 オーナー指示）。
  facts_remain_booked: {
    ja:        '今月はすでにいただいている\nご予約の他、{remain}回\nご利用いただけます。',
    en:        'In addition to the session(s) you have booked, you have {remain} more available this month.',
    zh:        '除已预约的课程外，本月还可使用 {remain}次。',
    'zh-Hant': '除已預約的課程外，本月還可使用 {remain}次。'
  },
  facts_remain_booked_days: {
    ja:        '今月はすでにいただいている\nご予約の他、{remain}回（残り{days}日）\nご利用いただけます。',
    en:        'In addition to the session(s) you have booked, you have {remain} more available this month ({days} days remaining).',
    zh:        '除已预约的课程外，本月还可使用 {remain}次（剩余{days}天）。',
    'zh-Hant': '除已預約的課程外，本月還可使用 {remain}次（剩餘{days}天）。'
  },
  // 「先月から○回繰り越しました」（その月に初めて送るとき・15日までだけ）
  facts_carried_in: {
    ja:        '先月分から {carried}回\n繰り越しました。',
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
        '昨日のご予約は\n' +
        '当日のお取り消しのため、\n' +
        '1回分の消化となりました。\n' +
        'かわりに振替を1回、\n' +
        '{expire}まで\n' +
        'ご利用いただけます。\n' +
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
    ja: '{month}分のご予約が\n' +
        '可能になりました。\n' +
        '\n' +
        'ご登録の固定枠\n' +
        '（{pattern}）は、\n' +
        '{month}分を自動でお取りしました。\n' +
        'ご変更が必要でしたら、\n' +
        '下記よりお願いいたします。\n' +
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
    ja: '{month}分のご予約が\n' +
        '可能になりました。\n' +
        '\n' +
        'ご希望のお時間は先着順です。\n' +
        '徐々にご予約可能な枠が\n' +
        '少なくなってまいりますので、\n' +
        'まずはなるべくお早めに\n' +
        '{quota}回分お押さえいただく\n' +
        'ことをおすすめいたします。\n' +
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
        '次回のご予約が\n' +
        'お決まりでなければ、\n' +
        '下記よりお待ちしております。\n' +
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
        '次のご予約は\n' +
        '{next} に\n' +
        '承っております。\n' +
        '他日程でもいかがでしょうか。\n' +
        '\n' +
        'もし予約可能枠が合わなければ、\n' +
        '担当宛にご希望の日時を\n' +
        'ご相談ください！\n' +
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
        '次回のご予約が\n' +
        'お決まりでなければ、\n' +
        '下記よりお待ちしております。\n' +
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
        '次のご予約は\n' +
        '{next} に\n' +
        '承っております。\n' +
        '他日程でもいかがでしょうか。\n' +
        '\n' +
        'もし予約可能枠が合わなければ、\n' +
        '担当宛にご希望の日時を\n' +
        'ご相談ください！\n' +
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
  for (var i = 0; i < LB_NUDGE_DAILY_CAP_KINDS.length; i++) out[LB_NUDGE_DAILY_CAP_KINDS[i]] = {};   // 設計37 改訂5：お知らせも1日1通に数える
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
      lang:         _lbNormLang(r[MAP_COL.LANG - 1]),
      trainerId:    String(r[MAP_COL.TRAINER_ID - 1] || ''),      // 設計37 改訂5（担当の枠だけ知らせる）
      contractType: String(r[MAP_COL.CONTRACT_TYPE - 1] || '')    // 同（連続ルールの体験の判定・_lbContractTypeOf が無いとき）
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

// 25日6時の自動予約の結果（会員ごと {b:取れた, s:取れなかった, p:処理した固定枠}。autoBookRecurringPatterns が残す）。読めなければ空＝誰にも「お取りしました」と言わない
function _lbNudgeAutoBookedIndex(monthKey) {
  try { return JSON.parse(PropertiesService.getScriptProperties().getProperty(LB_AUTOBOOK_RESULT_PREFIX + monthKey) || "{}") || {}; }
  catch (e) { Logger.log("自動予約の件数が読めません（固定枠なしの文面で送ります）: " + e.message); return {}; }
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

// 日次点検が止まっていないかを見る。止まっていればオーナーへメールで知らせる。
//   ★なぜリマインドから見るのか：点検は「悪化したときだけ」送るので、
//     止まっても沈黙が続くだけ。沈黙と正常を区別できない。
//     毎日動く別の処理から「最後に走った時刻」を見るしかない。
function _lbNudgeWatchHealthCheck(nowMs) {
  try { _lbNudgeWatchLease(nowMs); } catch (eL) { Logger.log('印の見張りで例外: ' + (eL && eL.message)); }
  var last = Number(_lbProp('LB_HEALTH_LAST') || 0);
  var hours = last ? Math.floor((nowMs - last) / 3600000) : -1;

  //   ★「記録が無い」と「止まっている」を区別する（2026-10-10）。
  //     記録の仕組みを入れた直後は、まだ一度も記録していない。
  //     それを「止まっている」と知らせると、**必ず1回は誤って鳴る**
  //     （2026-10-10 に実際に鳴った）。
  //     だから「見張りを始めた時刻」を覚えておき、そこから36時間は猶予する。
  //     猶予のあいだに点検が1回でも走れば last が入り、以後は普通の判定になる。
  var watchKey = 'LB_HEALTH_WATCH_FROM';
  var watchFrom = Number(_lbProp(watchKey) || 0);
  if (!watchFrom) {
    try { PropertiesService.getScriptProperties().setProperty(watchKey, String(nowMs)); }
    catch (e) { Logger.log('見張りの開始時刻を残せませんでした: ' + (e && e.message)); }
    watchFrom = nowMs;
  }
  //   ★記録が無く、かつ見張りを始めてから36時間たっていない＝まだ分からない。鳴らさない
  if (!last && (nowMs - watchFrom) < 36 * 3600000) {
    Logger.log('[health] 記録はまだ無いが、見張りを始めてから36時間たっていない（鳴らさない）');
    return;
  }

  //   ★途中で落ちた（自己修理 P1 §4-2・I-H24）：LAST は点検の開始時、DONE は完走時に書く。
  //     LAST > DONE かつ LAST から2時間超＝最新の点検が最後まで来ていない。
  //     ★DONE が一度も書かれていない間は判定しない（反映直後に必ず1回誤って鳴るのを防ぐ移行の猶予）
  if (_lbNudgeWatchHealthCrash(nowMs, last)) return;
  //   36時間＝1日分飛んでも許す（実行の揺れ・手動停止の猶予）。2日飛んだら知らせる
  if (last && hours < 36) return;
  //   1日1回までにする（毎日同じメールが来ると読まれなくなる）
  var notifiedKey = 'LB_HEALTH_ALERT_AT';
  var lastAlert = Number(_lbProp(notifiedKey) || 0);
  if (lastAlert && (nowMs - lastAlert) < 20 * 3600000) return;

  var msg = (last === 0)
    ? ('日次点検（dailyHealthCheck）が一度も走った記録がありません'
       + '（見張りを始めてから ' + Math.floor((nowMs - watchFrom) / 3600000) + '時間）。')
    : ('日次点検（dailyHealthCheck）が ' + hours + '時間走っていません（最終 '
       + Utilities.formatDate(new Date(last), SETTINGS.TIMEZONE, 'M/d HH:mm') + '）。');
  Logger.log('[health] ' + msg);
  try {
    var to = _lbAlertEmail();
    if (to) {
      GmailApp.sendEmail(to, '【要対処】日次点検が止まっています',
        msg + '\n\n'
        + '点検は「悪化したときだけ」メールを送る作りです。つまり**止まっていても沈黙が続き、'
        + '正常と区別できません。**\n'
        + 'そのため、この見張りは毎日10時のリマインドから行っています。\n\n'
        + '確かめること：\n'
        + '　・GASのトリガー一覧に dailyHealthCheck があるか\n'
        + '　・実行ログにエラーが出ていないか（6分の制限に当たっていないか）\n'
        //   ★★「setupTriggers を実行し直す」と案内してはいけない（2026-10-09）。
        //     あの関数は名前で絞らずに**全部のトリガーを消し、3本しか戻さない**。
        //     これはオーナーへ実際に送られるメール。案内どおりに実行すると、
        //     押し出し・作業依頼・カレンダー同期・固定枠の自動予約まで丸ごと止まる。
        + '　・★setupTriggers は実行しないでください（全部消して3本しか戻しません）\n'
        + '　・入れ直すなら用途ごとの関数で：dailyHealthCheck は setupLineTriggers、\n'
        + '　　押し出しは setupEdgeTrigger、作業依頼は setupEdgeJobTrigger、\n'
        + '　　カレンダー同期は setupCalSyncTrigger、うながしは setupNudgeTrigger、\n'
        + '　　固定枠・シフトは setupRecurringTriggers\n');
      PropertiesService.getScriptProperties().setProperty(notifiedKey, String(nowMs));
    }
  } catch (e) { Logger.log('[health] 通知に失敗: ' + (e && e.message)); }
}

// 最新の点検が途中で落ちていないかを見る（自己修理 P1 §4-2・I-H24）。知らせたら真（1日1回まで・止まっているときと同じ記録を使う）
//   LAST は点検の開始時、DONE は完走時に書く。LAST > DONE かつ LAST から2時間超＝最新の点検が最後まで来ていない。
//   ★DONE が一度も書かれていない間は判定しない（反映直後に必ず1回誤って鳴るのを防ぐ移行の猶予）
//   ★LAST が36時間より古いときは今までの「止まっている」に任せる
function _lbNudgeWatchHealthCrash(nowMs, last) {
  var done = Number(_lbProp('LB_HEALTH_DONE') || 0);
  if (!done || !last || !(last > done) || (nowMs - last) <= 2 * 3600000 || (nowMs - last) >= 36 * 3600000) return false;
  var notifiedKey = 'LB_HEALTH_ALERT_AT';
  var lastAlert = Number(_lbProp(notifiedKey) || 0);
  if (lastAlert && (nowMs - lastAlert) < 20 * 3600000) return true;
  //   ★段ごとの経過（LB_HEALTH_STEP・段の名前と経過ミリ秒だけ）を本文に載せる（2026-11-28）。
  //     「打ち切り@」で始まれば、点検が時間の上限の前に自分で止めた（落ちたのではない）
  var stepTxt = String(_lbProp('LB_HEALTH_STEP') || '').slice(0, 1500);
  var cut = /^打ち切り@/.test(stepTxt);
  var msg = '日次点検（dailyHealthCheck）が' + (cut ? '時間の上限に近づいて途中で打ち切られています' : '途中で落ちています') + '（最後に始めたのは '
    + Utilities.formatDate(new Date(last), SETTINGS.TIMEZONE, 'M/d HH:mm') + '・最後に完走したのは '
    + Utilities.formatDate(new Date(done), SETTINGS.TIMEZONE, 'M/d HH:mm') + '）。';
  Logger.log('[health] ' + msg);
  var to = _lbAlertEmail();
  if (to) {
    GmailApp.sendEmail(to, cut ? '【要対処】日次点検が時間の上限で打ち切られています' : '【要対処】日次点検が途中で落ちています',
      msg + '\n\n点検は始めた時刻と最後まで来た時刻を別に残しています。始めたのに最後まで来ていません。\n'
      + '確かめること：GAS の実行ログで dailyHealthCheck のエラーと、作業依頼 remaining {triggers} の「点検がどこまで進んだか」（最後に入った段が落ちた場所）。'
      + (stepTxt ? '\n\n段ごとの経過（段=開始からのミリ秒）：\n' + stepTxt : ''));
    PropertiesService.getScriptProperties().setProperty(notifiedKey, String(nowMs));
  }
  return true;
}

// 点検・修理の「同時に1本だけ」の印（LB_HEALTH_LEASE）が壊れて見送られていないかを見る（自己修理 P1 §2-1・I-H22）。
//   壊れた印は期限切れとみなさない（取らずに見送る）＝放っておくと点検も修理も止まったままになる。固定の文でメール（1日1回まで）
function _lbNudgeWatchLease(nowMs) {
  var o = null;
  try { o = JSON.parse(_lbProp('LB_HEALTH_SKIP') || 'null'); } catch (e) { o = null; }
  if (!o || o.why !== 'lease_broken' || !(Number(o.count) > 0)) return;
  var key = 'LB_HEALTH_LEASE_ALERT_AT', at = Number(_lbProp(key) || 0);
  if (at && (nowMs - at) < 20 * 3600000) return;
  var to = _lbAlertEmail();
  if (!to) return;
  GmailApp.sendEmail(to, '【要対処】日次点検と自己修理が見送られています',
    '日次点検と自己修理の「同時に1本だけ」の印（Script Properties の LB_HEALTH_LEASE）が壊れているため、点検・修理が見送られています。\n'
    + 'GAS エディタのプロジェクトの設定 → スクリプト プロパティで LB_HEALTH_LEASE を削除してください（次の点検から元に戻ります）。');
  PropertiesService.getScriptProperties().setProperty(key, String(nowMs));
}

// 共通して入れる事実（transfer を除く3種で使う）。
//   remain=今月の月額残 / carry=そのうち繰り越せる回数 / days=今月の残り日数。
//   remain が null＝残数を算出できない（degraded）＝送らない側へ倒す。
function _lbNudgeFacts(m, now) {
  var h = _lbBuildHome(m.customerId, m.name, m.lang, now.getTime());
  // ★「残数が出ない」には別のことが混ざっている（2026-10-06）。
  //   ・計算が壊れている（reviewRequired）＝**その会員は予約できない。本当の異常**
  //   ・月額の契約が無い（チケットだけ・契約切れ）＝正常。送らないだけ
  //   一緒くたに「残数が算出できない」と数えると、異常が正常の中に埋もれる。
  if (!h || !h.type) {
    return { remain: null, why: (h && h.reviewRequired) ? 'broken' : 'noMonthly',
             carry: 0, days: _lbNudgeDaysLeft(now), quota: 0, carriedIn: 0 };
  }
  var remain = (h.monthlyRemaining == null) ? null : Number(h.monthlyRemaining);
  var why = (remain === null) ? 'noMonthly' : '';   // 月額の回数が無い（チケットのみ等）
  var quota = Number(h.quota || 0);
  var carry = (remain == null) ? 0 : Math.max(0, Math.min(remain, _lbNudgeCarryCap(m, quota)));
  // carriedIn＝今月に繰り越されてきた回数（先月の余り）。月の前半に一度だけ伝える。
  var carriedIn = Math.max(0, Number(h.carryover || 0));
  return { remain: remain, why: why, carry: carry, days: _lbNudgeDaysLeft(now), quota: quota, carriedIn: carriedIn };
}

// 翌月に押さえていただける回数。**翌月の月額残だけを見る。**
//   null＝算出できない（契約が翌月を覆っていない／計算が壊れている）。
//
//   ★以前は「取れなければ当月の契約頻度へ倒す」作りだった（2026-10-08に廃止）。
//     倒すと、翌月の契約が無い会員にも当月の回数で案内してしまう。
//     しかも「0回分お押さえください」を避けるための細工だったので、
//     **本来の答え（送らない）を隠していた。**
//
//   ★これが無いと顧客に嘘をつく（Codex関門③で発見）：
//     頻度0の規則変更で、会員Jさんの月額残が null → 0 になる。
//     解放日の判定は null だけを除いていたので、0 は通ってしまう。
//     翌月（11月）の契約が未定なのに「11月分の予約が可能になりました」、
//     固定枠があれば「11月分を自動で取りました」と**断言する文面**が飛ぶ。
//   → 翌月に押さえられる回数が1以上でなければ、そもそも送らない。
function _lbNudgeNextRemain(m, now) {
  try {
    var h = _lbBuildHome(m.customerId, m.name, m.lang, _lbNudgeNextMonthDate(now).getTime());
    if (!h || !h.type) return null;                        // 月額の契約が無い
    if (h.monthlyRemaining == null) return null;           // 算出できない
    return Number(h.monthlyRemaining);
  } catch (e) {
    Logger.log('翌月の回数算出に失敗（解放の案内は送りません）: ' + (e && e.message));
    return null;
  }
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
               remainBroken: 0, noMonthlyPlan: 0,
               //   ★初期値を必ず置く（2026-10-08・Codex関門③）。
               //     置かないと ++ が NaN になり、**対象外の集計から消える。**
               //     例外は出ないので、黙って見えなくなるのがいちばん悪い。
               nextMonthNoPlan: 0, nextMonthNoQuota: 0,
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
  var autoBooked = _lbNudgeAutoBookedIndex(plan.monthKey);   // 25日6時の自動予約の結果（会員ごと {b,s,p}）
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
          //   ★翌月に押さえられる回数で判断する（2026-10-08・Codex関門③）。
          //     当月の残数で判断すると、翌月の契約が無い会員にも
          //     「翌月分の予約が可能になりました」と送ってしまう。
          var nextRem = _lbNudgeNextRemain(m, now);
          if (f2.remain === null) reasons.push(f2.why === 'broken' ? 'remainBroken' : 'noMonthlyPlan');
          else if (nextRem === null) reasons.push('nextMonthNoPlan');     // 翌月を覆う契約が無い
          else if (!(nextRem > 0)) reasons.push('nextMonthNoQuota');      // 翌月に押さえる枠が無い
          else {
            // ★「自動でお取りしました」は、6時の自動予約で**全部**取れた会員にだけ言う（2026-10-24・Codex関門②）。
            //   1件でも取れなかった・動かなかった・記録が読めない会員は、固定枠なしの文面（何回分お押さえください）になる。
            //   取れなかった日は6時の通知（_lbNotifyAutoBook）で個別にお伝えしている。
            //   ラベルは6時に実際に処理した固定枠（ab.p）から作る＝その後に足された固定枠を含めない。
            var ab = autoBooked[m.customerId];
            var pats = (ab && typeof ab === 'object' && Number(ab.b || 0) > 0 && Number(ab.s || 0) === 0 && Array.isArray(ab.p)) ? ab.p : [];
            var label = pats.map(function (p) { return _lbRecurLabel(Number(p.w), String(p.t || ''), m.lang); }).join('／');
            cand.push({ kind: LB_NUDGE_KIND.MONTH_OPEN, key: plan.monthKey, pattern: label,
                        quota: label ? 0 : nextRem });   // 固定枠ありの文面に {quota} は出ない
          }
        }
      }

      // ── ③④ visit_b / visit_a：昨日「実際に来店」した方だけ ──
      //   ★当日キャンセルの方はここに来ない。振替（①）だけをお送りする。
      if (visited) {
        var f3 = needFacts();
        if (f3.remain === null) reasons.push(f3.why === 'broken' ? 'remainBroken' : 'noMonthlyPlan');
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
  //   待ち時間は LB_NUDGE_LOCK_WAIT_MS（下の★を参照）。
  var _lock = null;
  if (!alreadyLocked) {
    try { _lock = LockService.getScriptLock(); } catch (e) { _lock = null; }
    // 入口と同じ扱い：守れないなら送らない。
    if (!_lock) {
      res.success = false; res.code = 'LOCK_UNAVAILABLE';
      Logger.log('nudge 中止：排他ロックを使えないため何も送りません');
      return res;
    }
    if (!_lock.tryLock(LB_NUDGE_LOCK_WAIT_MS)) {
      _lbNudgeLogLockMiss('send');
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

// ロックが取れずに1通も送れなかったことを記録に残す（2026-10-07）。
//   ★ログだけだと誰も気づかない。来店翌日A/Bは「昨日来た人」が条件なので、
//     この日に送れなかった方は**翌日には対象から外れ、永久に取りこぼす**。
//
//   ★nudge_log には書かない（Codex関門②の指摘）。
//     この関数は**ロックを持っていない状態で**呼ばれる（ロックが取れなかったから）。
//     nudge_log の2行目に挿入すると、同時に走っている送信処理が覚えている行番号（必ず2）が
//     ずれる。結果の書き戻しが照合に失敗して何も書かず、'sending' のまま残り、
//     **送信に失敗していても再送されない＝未達を送信済み扱いにする。**
//     設定（Script Properties）に置けば、他の処理の行番号に触れない。
function _lbNudgeLogLockMiss(where) {
  try {
    var arr = [];
    try { arr = JSON.parse(_lbProp(LB_NUDGE_LOCK_MISS_KEY) || '[]'); } catch (e) { arr = []; }
    if (Object.prototype.toString.call(arr) !== '[object Array]') arr = [];
    arr.unshift({ at: new Date().getTime(), where: String(where || '') });
    arr = arr.slice(0, 20);   // 直近20件だけ持つ（設定の値を際限なく太らせない）
    PropertiesService.getScriptProperties().setProperty(LB_NUDGE_LOCK_MISS_KEY, JSON.stringify(arr));
  } catch (e) { Logger.log('lock_miss を記録できませんでした: ' + e.message); }
}

// ★解放日に「翌月の契約が無くて送れなかった」人数を記録する（2026-10-08）。
//   行番号に依存しない場所（Script Properties）に置く＝lock_miss と同じ理由。
function _lbNudgeNoteOpenMiss(monthKey, n) {
  try {
    if (!n) return;
    var arr = [];
    try { arr = JSON.parse(_lbProp(LB_NUDGE_OPEN_MISS_KEY) || '[]'); } catch (e) { arr = []; }
    if (Object.prototype.toString.call(arr) !== '[object Array]') arr = [];
    arr.unshift({ at: new Date().getTime(), monthKey: String(monthKey || ''), n: Number(n) });
    arr = arr.slice(0, 12);   // 直近12回（＝1年ぶん）
    PropertiesService.getScriptProperties().setProperty(LB_NUDGE_OPEN_MISS_KEY, JSON.stringify(arr));
  } catch (e) { Logger.log('解放日の取りこぼしを記録できませんでした: ' + e.message); }
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
  remainBroken: '🚨 残数の計算が止まっている（その会員は予約できません）', noMonthlyPlan: '月額の契約が無い（チケットのみ等・正常）',
  nextMonthNoPlan: '翌月を覆う契約が無い（更新待ち。★25日より後に契約を入れると案内が飛びません）',
  nextMonthNoQuota: '翌月に押さえる枠が無い（0回分の案内は出さない）',
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
  lbNudgeCatchUpPreview(FROM, TO);   // 一覧は中でログに出る（ここで出すと二重になる）
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
  if (!lock.tryLock(LB_NUDGE_LOCK_WAIT_MS)) {
    _lbNudgeLogLockMiss('catchup');
    Logger.log('nudge 中止：別の実行が動いています（' + (LB_NUDGE_LOCK_WAIT_MS / 1000) + '秒待っても取れず）');
    return { success: false, code: 'ALREADY_RUNNING' };
  }
  try {
    Logger.log('追いかけ送信：来店 ' + r.label + ' を対象にします');
    return _lbNudgeSend(lbNudgePlanAll(ms, r), ms, true);
  } finally {
    try { lock.releaseLock(); } catch (e) { }
  }
}

function lbNudgeDaily(nowMs) {
  //   ★時間主導のトリガーは第1引数にイベントオブジェクトを渡す（2026-10-11）。
  //     `(nowMs != null)` で判定していたので、オブジェクトがそのまま ms に入り、
  //       ・lbNudgePlanAll の `new Date(nowMs)` が **Invalid Date**
  //       ・_lbNudgeWatchHealthCheck の `(nowMs - last)` が **NaN**
  //         ＝「点検が止まっている」の警告が**永久に鳴らない**
  //     という状態になっていた。
  //   ★数値だけを受け付ける。それ以外は「いま」を使う。
  var ms = (typeof nowMs === 'number' && isFinite(nowMs)) ? nowMs : new Date().getTime();
  var _t0 = Date.now(); try {   // 自己修理 P1（finally）
  //   ★日次点検が止まっていないかを**ここから**見張る（2026-10-09）。
  //     点検は「悪化したときだけ」メールを送る。だから**点検そのものが止まると
  //     何も届かず、沈黙が正常と区別できない。**
  //     点検は自分では気づけないので、毎日動く別の処理から見る。
  //     ここ（毎日10時のリマインド）は点検（7時）の3時間後に動くので都合がよい。
  //     ★見張る側も止まったら？ → そのときは**リマインドが届かない**ので
  //       オーナーが気づく（顧客に届くものだから）。だからここに置く。
  try { _lbNudgeWatchHealthCheck(ms); } catch (e) { Logger.log('点検の見張りで例外: ' + (e && e.message)); }
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
//   ★待ち時間を入れる（2026-10-07）。
//     当初は待ち時間を 0 にしていた（待たずに諦める）。「待って送るより送らない方が安全」と考えたが、
//     **運用初日に実際に取りこぼした。** 10/07 10:43 の自動送信が1通も送らずに終わっている。
//     GASの ScriptLock はプロジェクト全体で1つ。このプロジェクトにはトリガーが18個あり、
//     edgeJobPoll は1分ごと、lbCalSyncTick・warmupCache・pushToEdge* も頻繁に動く。
//     **たまたま重なっただけで送信が丸ごと飛ぶ。**
//     しかも来店翌日A/Bは「昨日来た人」が条件なので、翌日には対象から外れて**永久に取りこぼす**。
//     待って取れた場合も安全である（ロックを取ってから対象を決めるので、先に送った実行の記録が見える）。
//     他の処理も 5〜15秒待っている（EdgeJob.js:139 は5秒、LineBooking.js:3989 は15秒）。
  if (!lock) {
    Logger.log('nudge 中止：排他ロックを使えないため何も送りません');
    return { success: false, code: 'LOCK_UNAVAILABLE', enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0 };
  }
  if (!lock.tryLock(LB_NUDGE_LOCK_WAIT_MS)) {
    // ★取れなかったことを**記録に残す**。ログだけだと誰も気づかない。
    //   この日の対象者は翌日には条件から外れる＝取りこぼしたまま終わる。
    _lbNudgeLogLockMiss('daily');
    Logger.log('nudge 中止：別の実行が動いています（' + (LB_NUDGE_LOCK_WAIT_MS / 1000) + '秒待っても取れず）');
    return { success: false, code: 'ALREADY_RUNNING', enabled: _lbNudgeEnabled(), sent: 0, failed: 0, deferred: 0 };
  }
  try {
    var _plan = lbNudgePlanAll(ms);
    //   ★解放日に「翌月を覆う契約が無くて送れなかった人」を記録する（2026-10-08）。
    //     解放の判定は25日にしか走らない。その日に契約が入っていなければ、
    //     **後から入れても案内は飛ばない。** 記録しないと誰も気づかない。
    //     日次点検がこれを読んでオーナーへのメールに載せる。
    try {
      if (_plan && _plan.isOpenDay) {
        _lbNudgeNoteOpenMiss(_plan.monthKey, Number((_plan.skipped || {}).nextMonthNoPlan || 0));
      }
    } catch (e) { Logger.log('解放日の取りこぼしの記録に失敗: ' + (e && e.message)); }
    var _sres = _lbNudgeSend(_plan, ms, true);   // 第3引数＝ロックは取得済み
    //   ★声かけが終わった印（設計37 改訂5 §5-21-3）。空き枠のお知らせは、声かけが有効な日はこの印が出るまで送らない。
    //     一覧が作れて（OK）中止の code が無いときだけ書く。LINE の未達（failed）は妨げない。書けなければお知らせが止まる側
    try { if (_plan && _plan.code === 'OK' && _sres && !_sres.code) PropertiesService.getScriptProperties().setProperty('LB_NUDGE_DAILY_DONE', Utilities.formatDate(new Date(ms), SETTINGS.TIMEZONE, 'yyyy-MM-dd')); }
    catch (eDone) { Logger.log('声かけの完了の印を書けませんでした（空き枠のお知らせはこの日送りません）'); }
    return _sres;
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (e) { } }
  }
  } finally {
    _lbNudgeThenSelfHeal(_t0);
  }
}

// うながしの後に自己修理を1回（自己修理 P1・CEO 裁定 2026-11-23：専用のトリガーを作らず lbNudgeDaily に相乗り）。
//   ★うながしの戻り値・送信には一切触れない（finally の中で値を返さない）。ロックを放した後に呼ぶ。
//   ★自己修理の例外はここで握りつぶす（うながし側へ漏らさない）。止まったら翌日の点検が selfheal_stale で気づく
//   ★うながしの開始時刻を渡す（修理の予算＝min(4分, 5分 − うながしにかかった時間)・60秒未満なら始めない）
function _lbNudgeThenSelfHeal(nudgeStartMs) {
  try { lbSelfHeal(nudgeStartMs); } catch (e) { Logger.log('自己修理で例外（うながしには影響しない）: ' + String((e && e.name) || 'Error')); }
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

// ==== VACANCY_BEGIN ====
// ============================================================
// 空き枠のお知らせ（設計37 改訂5・決定0216・2026-11-26）
//   3日前の0時〜前日に会員が自分でキャンセルした枠を、同じ曜日・前後1時間に直近8週で2回以上来た会員
//   （担当がその枠のトレーナーか担当なし・残数かチケットあり）へ、最大3名まで LINE で知らせる。
//
// ★設計の柱（ops/design/37-vacancy-notice.md 改訂5・§5-21〜5-25）
//   ① 既定は何もしない。LB_VACANCY_MODE が厳密に 'list'（送らずに記録）か 'on'（送る）のときだけ動く。
//      'on' はオーナー承認（対外発信）。作業依頼からは list と off しかできない。
//   ② 新しいトリガーを作らない。warmupCache（10分ごと）の末尾に相乗り（トリガー20本の天井・MODEL §7）。
//   ③ 枠と予約の可否は入口の部品で決める：getTrainerSlots（会員に見える枠）・getBookingOptions（残数）・
//      _lbBookingDeadlineMs（締め切り）・_lbBookingGate（予約停止）・予約確定と同じ4段（B1・トレーナー・1F・連続ルール）。
//      予約確定の経路そのものは触らない（確定はロックの中で再び確かめる＝取れない予約は作られない）。
//   ④ 送る権利の正本は nudge_log。ロックの中で読み直してから 'sending' を書き、ロックを放してから送る（I19）。
//   ⑤ 判定できないものは送らない。倒れた理由は vacancy_notice の why・skip_json と LB_VACANCY_LAST に数える。
//   ⑥ 文面に他の会員の行動（誰が・何人・理由）と名前を出さない。ログ・作業依頼には顧客IDの下4桁だけ。
// ============================================================
var LB_VACANCY_BUILD = '2026-11-26a 設計37 改訂5：過去の予約者へ自動（登録なし）・3日前以降・最大3名・空きました・受け取らないボタン';

var LB_VAC = {
  MODE_PROP: 'LB_VACANCY_MODE',
  LAST_PROP: 'LB_VACANCY_LAST',         // {at, result, n, build}（見張り・§5-13）
  LEASE_PROP: 'LB_VACANCY_LEASE',       // 同時に1本（期限 ms）
  READ_START_PROP: 'LB_SLOTS_READ_START', // buildAndCacheSlots が残す「カレンダーを読み始めた時刻」（§5-24）
  NUDGE_DONE_PROP: 'LB_NUDGE_DAILY_DONE',
  KIND: 'nudge_vacancy',
  NOTICE_SHEET: 'vacancy_notice',
  OPTOUT_SHEET: 'vacancy_optout',
  NOTICE_HEAD: ['res_id', 'trainer_id', 'start_at', 'deadline_at', 'cancelled_at', 'first_seen_at', 'updated_at', 'state', 'why',
                'mode', 'attempts', 'eligible_n', 'sent_n', 'failed_n', 'unknown_n', 'would', 'skip_json', 'elapsed_ms', 'build', 'tried'],
  OPTOUT_HEAD: ['customer_id', 'opted_out_at', 'via'],
  MARGIN_MS: 2 * 3600000,               // 締め切りの何時間前までに送れれば送るか（§5-4・オーナー未決＝安全側の既定）
  SEND_FROM_H: 9, SEND_UNTIL_H: 20,     // 送る時間帯（JST・9:00〜20:00）
  LOOKBACK_DAYS: 3,                     // 3日前の0時から（決定0216）
  VISIT_WEEKS: 8, VISIT_MIN: 2, VISIT_TOD_MIN: 60,
  MAX_PER_SLOT: 3, WEEK_MAX: 2,
  WAIT_MAX: 6,                          // 枠がまだ見えない・判定できない回の上限（約1時間）
  SLOTS_PER_TICK: 3,
  CN_SCAN: 300, NOTICE_SCAN: 300,
  LATE_MS: 3.5 * 60000,                 // warmupCache の開始からこれを過ぎていたら何もしない
  BUDGET_MS: 45000, SEND_RESERVE_MS: 5000,
  LEASE_MS: 2 * 60000,
  LOCK_WAIT_MS: 5000,
  STALE_MS: 60 * 60000,                 // 日次点検：最後の記録がこれより古ければ止まっている
  BAD_RESULTS: ['read_fail', 'notice_write_fail', 'log_unwritable', 'error']
};

// ---- スイッチ（①）----
function _lbVacMode() {
  var v = null;
  try { v = _lbProp(LB_VAC.MODE_PROP); } catch (e) { return 'off'; }
  return (v === 'list' || v === 'on') ? v : 'off';
}
function lbVacancySetList() { return _lbVacSwitch('list'); }
function lbVacancySetOn()   { return _lbVacSwitch('on'); }   // ★オーナー承認の後にオーナーが押す（対外発信）
function lbVacancySetOff()  { return _lbVacSwitch('off'); }
function _lbVacSwitch(mode) {
  if (mode !== 'list' && mode !== 'on' && mode !== 'off') throw new Error('mode は list / on / off');
  var p = PropertiesService.getScriptProperties();
  var before = p.getProperty(LB_VAC.MODE_PROP);
  if (mode === 'off') p.deleteProperty(LB_VAC.MODE_PROP); else p.setProperty(LB_VAC.MODE_PROP, mode);
  _lbVacLastNote('mode_set', 0);   // 切り替え直後に見張りを鳴らさない（§5-13）
  var msg = 'LB_VACANCY_MODE: ' + (before == null ? '（未設定＝何もしない）' : "'" + before + "'") + ' → ' + (mode === 'off' ? '（未設定＝何もしない）' : "'" + mode + "'") + '／版 ' + LB_VACANCY_BUILD;
  Logger.log(msg);
  return msg;
}

// ---- 見張りの記録（§5-13・§5-21-6）----
function _lbVacLastNote(result, n) {
  try { PropertiesService.getScriptProperties().setProperty(LB_VAC.LAST_PROP, JSON.stringify({ at: Date.now(), result: String(result), n: Number(n || 0), build: LB_VACANCY_BUILD.slice(0, 11) })); }
  catch (e) { Logger.log('空き枠のお知らせ：見張りの記録を書けませんでした'); }
}

// ---- 時刻（JST で切る）----
function _lbVacDay0(ms) { var p = _lbJstParts(ms); return _lbJstMs(p.y, p.mo, p.d, 0, 0); }
function _lbVacDow(ms) { var p = _lbJstParts(ms); return new Date(Date.UTC(p.y, p.mo, p.d)).getUTCDay(); }
function _lbVacTod(ms) { var p = _lbJstParts(ms); return p.h * 60 + p.mi; }
function _lbVacDayKey(ms) { var p = _lbJstParts(ms); return p.y + '-' + (p.mo < 9 ? '0' : '') + (p.mo + 1) + '-' + (p.d < 10 ? '0' : '') + p.d; }
function _lbVacInSendHours(ms) { var h = _lbJstParts(ms).h; return h >= LB_VAC.SEND_FROM_H && h < LB_VAC.SEND_UNTIL_H; }
function _lbVacDeadline(startMs) { return _lbBookingDeadlineMs(startMs, _lbBookingCfg(SETTINGS)); }
function _lbVacKey(trainerId, startMs) { return 'vac|' + String(trainerId) + '|' + String(startMs); }

// ---- 対象のキャンセルか（§5-4）。返り値 { ok:true } か { ok:false, why } ----
function _lbVacTargetVerdict(c, nowMs) {
  if (!c || !c.resId || !c.trainerId || !c.customerId) return { ok: false, why: 'bad_row' };
  if (!(typeof c.cancelledAt === 'number' && isFinite(c.cancelledAt)) || !(typeof c.startAt === 'number' && isFinite(c.startAt))) return { ok: false, why: 'bad_row' };
  if (c.cancelledAt > nowMs) return { ok: false, why: 'bad_row' };
  var proxy = (c.actor === 'trainer' || c.actor === 'owner') && c.trainerReason === 'customer_proxy';
  if (c.actor === 'customer') { if (c.trainerReason) return { ok: false, why: 'actor' }; }
  else if (!proxy) return { ok: false, why: 'actor' };
  if (c.outcome !== 'free' && c.outcome !== 'consumed') return { ok: false, why: 'outcome' };
  var d0 = _lbVacDay0(c.startAt);
  var from = d0 - LB_VAC.LOOKBACK_DAYS * 86400000;   // ★JST の暦日で引く（d0 は JST の0時）
  if (!(c.cancelledAt >= from && c.cancelledAt < d0)) return { ok: false, why: 'window' };
  if (!(c.cancelledAt < _lbVacDeadline(c.startAt) - LB_VAC.MARGIN_MS)) return { ok: false, why: 'margin' };
  return { ok: true };
}

// ---- cancel_notes の末尾から、まだ始まっていない枠の行を読む（列は見出しの名前で引く）----
//   返り値 null＝読めない（その回は送らない）
function _lbVacCancelRows(nowMs) {
  var ready = _lbCnReady();
  if (!ready.ok) return null;
  var sh = ready.sheet, last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(LB_VAC.CN_SCAN, last - 1);
  var v = sh.getRange(last - n + 1, 1, n, LB_CN.HEAD.length).getValues();
  function col(name) { return LB_CN.HEAD.indexOf(name); }
  var out = [], count = {};
  for (var i = 0; i < v.length; i++) {
    var r = v[i];
    var c = { resId: String(r[col('res_id')] || ''), cancelledAt: r[col('cancelled_at')], startAt: r[col('start_at')],
              trainerId: String(r[col('trainer_id')] || ''), customerId: String(r[col('customer_id')] || ''),
              actor: String(r[col('actor')] || ''), outcome: String(r[col('outcome')] || ''), trainerReason: String(r[col('trainer_reason')] || '') };
    if (c.resId) count[c.resId] = (count[c.resId] || 0) + 1;
    if (!(typeof c.startAt === 'number' && c.startAt > nowMs)) continue;              // 始まった枠は見ない
    if (!(typeof c.cancelledAt === 'number' && c.cancelledAt >= nowMs - 4 * 86400000)) continue;
    out.push(c);
  }
  for (var j = 0; j < out.length; j++) if (count[out[j].resId] > 1) out[j].dup = true;   // ★同じ res_id が2行＝取り違えない
  return out;
}

// ---- 記録 vacancy_notice（1キャンセル1行・追記と上書きだけ＝行の番号が変わらない）----
function _lbVacSheet(name, head) {
  var ss = _lbSs(), sh = ss.getSheetByName(name);
  if (!sh) { sh = ss.insertSheet(name); sh.getRange(1, 1, 1, head.length).setValues([head]); }
  return sh;
}
function _lbVacNoticeRead(sh) {
  var last = sh.getLastRow(), map = {};
  if (last < 2) return map;
  var n = Math.min(LB_VAC.NOTICE_SCAN, last - 1), start = last - n + 1;
  var v = sh.getRange(start, 1, n, LB_VAC.NOTICE_HEAD.length).getValues();
  for (var i = 0; i < v.length; i++) {
    var o = { row: start + i };
    for (var k = 0; k < LB_VAC.NOTICE_HEAD.length; k++) o[LB_VAC.NOTICE_HEAD[k]] = v[i][k];
    if (o.res_id) map[String(o.res_id)] = o;
  }
  return map;
}
function _lbVacNoticeWrite(sh, rec) {
  var row = [];
  for (var k = 0; k < LB_VAC.NOTICE_HEAD.length; k++) { var x = rec[LB_VAC.NOTICE_HEAD[k]]; row.push(x == null ? '' : x); }
  if (rec.row) sh.getRange(rec.row, 1, 1, row.length).setValues([row]);
  else { sh.appendRow(row); }
}
var LB_VAC_DONE_STATES = { listed: 1, sent: 1, no_target: 1, too_late: 1, filled: 1, not_offered: 1, unknown: 1, not_target: 1, skip_trainer: 1 };

// ---- 受け取らない（§5-10）----
//   返り値 { set:{customerId:true} } か null（読めない）
function _lbVacOptoutRead() {
  try {
    var sh = _lbSheet(LB_VAC.OPTOUT_SHEET);
    if (!sh || sh.getLastRow() < 2) return {};
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues(), set = {};
    for (var i = 0; i < v.length; i++) { var c = String(v[i][0] || ''); if (c) set[c] = true; }
    return set;
  } catch (e) { return null; }
}

// ---- nudge_log を1回で読む（§5-6・読み方は _lbNudgeLogReadAll と同じ）----
//   byDay[day|cid]＝その日に nudge_ の何かを受けた（sent・sending）
//   week[cid]＝お知らせの送信時刻（sent・sending）／keyPerson[key|cid]＝同じ枠（sent・sending・failed）／slotCount[key]（sent・sending）
function _lbVacLogRead() {
  var out = { byDay: {}, week: {}, keyPerson: {}, slotCount: {}, readFailed: false };
  try {
    var sh = _lbSheet(LB_NUDGE_LOG_SHEET);
    if (!sh || sh.getLastRow() < 2) return out;
    var n = Math.min(LB_NUDGE_LOG_SCAN, sh.getLastRow() - 1);
    var v = sh.getRange(2, 1, n, LB_NUDGE_LOG_COLS).getValues();
    for (var r = 0; r < v.length; r++) {
      var kind = String(v[r][1] || ''), cid = String(v[r][2] || ''), key = String(v[r][3] || ''), st = String(v[r][4] || '');
      if (!cid || kind.indexOf('nudge_') !== 0) continue;
      var raw = v[r][0];
      var d = (raw && typeof raw.getTime === 'function') ? raw : _lbParseResvDate(String(raw || '').replace(/^'/, ''));
      var counted = (st === 'sent' || st === 'sending');
      if (counted && d && isFinite(d.getTime())) out.byDay[_lbVacDayKey(d.getTime()) + '|' + cid] = true;
      if (kind !== LB_VAC.KIND) continue;
      if (counted && d && isFinite(d.getTime())) (out.week[cid] = out.week[cid] || []).push(d.getTime());
      if (key && (counted || st === 'failed')) out.keyPerson[key + '|' + cid] = true;
      if (key && counted) out.slotCount[key] = (out.slotCount[key] || 0) + 1;
    }
  } catch (e) { out.readFailed = true; }
  return out;
}
//   上限に当たるか。当たれば理由、当たらなければ ''
function _lbVacCapWhy(log, cid, key, nowMs) {
  if (log.keyPerson[key + '|' + cid]) return 'same_slot';
  if ((log.slotCount[key] || 0) >= LB_VAC.MAX_PER_SLOT) return 'slot_full';
  if (log.byDay[_lbVacDayKey(nowMs) + '|' + cid]) return 'daily_cap';
  var w = log.week[cid] || [], n = 0;
  for (var i = 0; i < w.length; i++) if (w[i] > nowMs - 7 * 86400000) n++;
  if (n >= LB_VAC.WEEK_MAX) return 'weekly_cap';
  return '';
}

// ---- 台帳を1回で読む（来店・同じ日の予約・枠の重なり）。null＝読めない ----
function _lbVacResvRead() {
  var sh = _lbSheet(LINE_BOOKING.RESV_SHEET);
  if (!sh) return null;
  var last = sh.getLastRow();
  if (last < 2) return [];
  var v = sh.getRange(2, 1, last - 1, 11).getValues(), out = [];
  for (var i = 0; i < v.length; i++) {
    var d = _lbParseResvDate(v[i][0]); if (!d) continue;
    out.push({ ms: d.getTime(), cid: String(v[i][2] || ''), tid: String(v[i][4] || ''), st: String(v[i][6] || '') });
  }
  return out;
}
//   同じ曜日・前後60分・直近8週の来店（confirmed で開始が過去）を会員ごとに数える
function _lbVacVisits(resv, startMs, nowMs) {
  var dow = _lbVacDow(startMs), tod = _lbVacTod(startMs), from = nowMs - LB_VAC.VISIT_WEEKS * 7 * 86400000, out = {};
  for (var i = 0; i < resv.length; i++) {
    var r = resv[i];
    if (r.st !== 'confirmed' || !r.cid || r.ms >= nowMs || r.ms < from) continue;
    if (_lbVacDow(r.ms) !== dow || Math.abs(_lbVacTod(r.ms) - tod) > LB_VAC.VISIT_TOD_MIN) continue;
    var e = out[r.cid] || (out[r.cid] = { n: 0, lastMs: 0 });
    e.n++; if (r.ms > e.lastMs) e.lastMs = r.ms;
  }
  return out;
}

// ---- 予約確定と同じ部品で「いま空いているか」（§5-21-2・5-22-1）。読み取りだけ ----
//   返り値 {ok:true} ／ {ok:false, reason} ／ {ok:false, unknown:true}
function _lbVacSlotFreeNow(trainer, start, end, contractType) {
  try {
    var calB1 = CalendarApp.getCalendarById(CALENDAR_IDS.CAPACITY_B1);
    if (!calB1) return { ok: false, unknown: true };
    var b1busy = calB1.getEvents(start, end).filter(function (ev) {
      if (ev.getTitle().indexOf('[消化]') === 0) return false;
      return _lbEventOverlaps(ev, start.getTime(), end.getTime());
    });
    if (b1busy.length > 0) return { ok: false, reason: 'b1' };
    if (!_lbCheckTrainerAvailable(trainer, start, end, null)) return { ok: false, reason: 'trainer' };
    if (_lb1FBlockEnabled()) {
      var f1 = _lb1FTrainerBusy(start, end);
      if (!f1.ok) return { ok: false, unknown: true };
      if (_lbOverlapsBusy(f1.trainerBusy[trainer.id] || [], start.getTime(), end.getTime(), null, '') ||
          _lbOverlapsBusy(f1.blockAll, start.getTime(), end.getTime(), null, '')) return { ok: false, reason: 'f1' };
    }
    //   連続ルール：予約確定と同じ条件（会員本人の予約＝consecRule は真・体験の契約は当てない・on のときだけ）
    if (_lbConsecMode() === 'on' && String(contractType || '').indexOf('体験') < 0) {
      var cv = _lbConsecCheckAt(trainer, start, end, null);
      if (cv.unknown) return { ok: false, unknown: true };
      if (!cv.ok) return { ok: false, reason: 'consec' };
    }
    return { ok: true };
  } catch (e) { return { ok: false, unknown: true }; }
}

//   予約画面で選べる選択肢が1つ以上あるか（§5-5-8）。
//   返り値 'yes'／'no'（予約できないと分かった）／'unknown'（判定できない＝その回は送らず、後の回で確かめ直す・関門② 2周目）
function _lbVacBookable(lineUserId, startMs) {
  try {
    var o = getBookingOptions(lineUserId, new Date(startMs).toISOString());
    if (o && o.success === true) return (o.hasNormalRoute === true || Number(o.pairRemaining) > 0) ? 'yes' : 'no';
    if (o && (o.code === 'NO_CONTRACT' || o.code === 'NOT_VERIFIED' || o.code === 'NOT_FOUND')) return 'no';
    return 'unknown';   // REVIEW_REQUIRED・BAD_REQUEST・形が違う
  } catch (e) { return 'unknown'; }
}

// ---- 文面（§5-9）----
var _LB_VAC_MSG = {
  body: {
    ja: 'ご予約のお時間が空きました。\n\n{when}〜　{trainer}\n（ご予約の受付は {deadline} までです）\n\nご都合が合いましたら、下記よりお待ちしております。\nご予約の状況により、お取りいただけない場合がございます。',
    en: 'A session time has become available.\n\n{when} with {trainer}\n(Bookings close at {deadline})\n\nIf the time suits you, we look forward to your booking below.\nDepending on other bookings, it may no longer be available.',
    zh: '有可预约的时间了。\n\n{when} 起　{trainer}\n（预约截止：{deadline}）\n\n如时间合适，欢迎通过下方预约。\n视预约情况，可能已无法预约，敬请谅解。',
    'zh-Hant': '有可預約的時間了。\n\n{when} 起　{trainer}\n（預約截止：{deadline}）\n\n如時間合適，歡迎透過下方預約。\n視預約情況，可能已無法預約，敬請見諒。'
  },
  alt: { ja: 'ご予約のお時間が空きました（{when}〜）', en: 'A session time has become available ({when})', zh: '有可预约的时间了（{when} 起）', 'zh-Hant': '有可預約的時間了（{when} 起）' },
  open: { ja: '予約画面を開く', en: 'Open booking', zh: '打开预约页面', 'zh-Hant': '打開預約頁面' },
  stop: { ja: '今後このお知らせを受け取らない', en: 'Stop these notices', zh: '今后不再接收此通知', 'zh-Hant': '今後不再接收此通知' },
  optout_ok: { ja: '承知しました。今後、空き枠のお知らせはお送りしません。ご予約・リマインドのご連絡はこれまでどおりお届けします。',
               en: 'Understood. We will no longer send these availability notices. Booking confirmations and reminders will continue as usual.',
               zh: '已为您设置。今后将不再发送空位通知。预约及提醒消息将照常发送。',
               'zh-Hant': '已為您設定。今後將不再發送空位通知。預約及提醒訊息將照常發送。' },
  optout_fail: { ja: '恐れ入ります、設定を受け付けられませんでした。お手数ですが、このトークでスタッフにお知らせください。',
                 en: 'Sorry, we could not process your request. Please let our staff know in this chat.',
                 zh: '抱歉，未能完成设置。请在此聊天中告知工作人员。',
                 'zh-Hant': '抱歉，未能完成設定。請在此聊天中告知工作人員。' },
  optout_who: { ja: '恐れ入ります、会員情報を確認できませんでした。お手数ですが、このトークでスタッフにお知らせください。',
                en: 'Sorry, we could not confirm your membership. Please let our staff know in this chat.',
                zh: '抱歉，无法确认会员信息。请在此聊天中告知工作人员。',
                'zh-Hant': '抱歉，無法確認會員資訊。請在此聊天中告知工作人員。' },
  test: { ja: '（テスト）ボタンを受け付けました。記録はしていません。', en: '(Test) Received. Nothing was recorded.', zh: '（测试）已收到。未作记录。', 'zh-Hant': '（測試）已收到。未作記錄。' }
};
function _lbVacMsg(key, lang, vars) {
  var e = _LB_VAC_MSG[key], l = _lbNormLang(lang);
  var s = e[l] != null ? e[l] : e.ja;
  if (vars) s = s.replace(/\{(\w+)\}/g, function (_, k) { return vars[k] != null ? String(vars[k]) : ''; });
  return s;
}
//   Flex 1通。postbackData は 'vac=off'（本番）か 'vac=test'（見本）だけ
function _lbVacMessage(lang, v, postbackData) {
  var vars = { when: v.when, trainer: v.trainer, deadline: v.deadline };
  var body = _lbVacMsg('body', lang, vars), alt = _lbVacMsg('alt', lang, vars);
  return {
    text: body, alt: alt,
    flex: { type: 'flex', altText: alt.slice(0, 400), contents: { type: 'bubble',
      body: { type: 'box', layout: 'vertical', contents: [{ type: 'text', text: body, wrap: true, size: 'sm' }] },
      footer: { type: 'box', layout: 'vertical', spacing: 'sm', contents: [
        { type: 'button', style: 'primary', height: 'sm', action: { type: 'uri', label: _lbVacMsg('open', lang), uri: _lbNudgeLiffUrl() } },
        { type: 'button', style: 'link', height: 'sm', action: { type: 'postback', label: _lbVacMsg('stop', lang), data: postbackData, displayText: _lbVacMsg('stop', lang) } }
      ] } } }
  };
}
function _lbVacVars(trainer, startMs, lang) {
  return { when: _lbFmtResvLabel(new Date(startMs), lang), trainer: _lbTrainerNameLang(trainer.id, trainer.name, lang),
           deadline: _lbFmtResvLabel(new Date(_lbVacDeadline(startMs)), lang) };
}

// ============================================================
// 入口：warmupCache の末尾から（例外を外へ出さない＝warmupCache の結果を変えない）
// ============================================================
function lbVacancyTick(wcStartMs) {
  var mode = _lbVacMode();
  if (mode === 'off') return { result: 'off' };                     // ★何も読まない・何も書かない
  var t0 = Date.now();
  var startMs = (typeof wcStartMs === 'number' && isFinite(wcStartMs)) ? wcStartMs : t0;
  if (t0 - startMs > LB_VAC.LATE_MS) { _lbVacLastNote('late', 0); return { result: 'late' }; }
  //   同時に1本（§5-7）
  var lock = null, got = false;
  try { lock = LockService.getScriptLock(); got = lock.tryLock(3000); } catch (e) { got = false; }
  if (!got) { _lbVacLastNote('busy', 0); return { result: 'busy' }; }
  var leaseId = 'L' + t0 + Math.floor(Math.random() * 1e6);
  try {
    var p = PropertiesService.getScriptProperties();
    var cur = Number(String(p.getProperty(LB_VAC.LEASE_PROP) || '').split('|')[0] || 0);
    if (cur && cur > t0) { _lbVacLastNote('busy', 0); return { result: 'busy' }; }
    p.setProperty(LB_VAC.LEASE_PROP, String(t0 + LB_VAC.LEASE_MS) + '|' + leaseId);
  } catch (eL) { _lbVacLastNote('error', 0); return { result: 'error' }; }
  finally { try { lock.releaseLock(); } catch (eR) {} }
  var res;
  try { res = _lbVacTickBody(mode, startMs, t0); }
  catch (e) { res = { result: 'error', n: 0 }; Logger.log('空き枠のお知らせで例外: ' + String((e && e.name) || 'Error')); }
  try {
    var p2 = PropertiesService.getScriptProperties();
    if (String(p2.getProperty(LB_VAC.LEASE_PROP) || '').split('|')[1] === leaseId) p2.deleteProperty(LB_VAC.LEASE_PROP);
  } catch (eD) {}
  _lbVacLastNote(res.result, res.n);
  Logger.log('[vacancy] mode=' + mode + ' result=' + res.result + ' n=' + (res.n || 0) + ' ms=' + (Date.now() - t0));
  return res;
}

function _lbVacTickBody(mode, wcStartMs, t0) {
  var nowMs = Date.now();
  var rows = null;
  try { rows = _lbVacCancelRows(nowMs); } catch (e) { rows = null; }
  if (rows === null) return { result: 'read_fail', n: 0 };
  var nsh = null, notices = null;
  try { nsh = _lbVacSheet(LB_VAC.NOTICE_SHEET, LB_VAC.NOTICE_HEAD); notices = _lbVacNoticeRead(nsh); }
  catch (e) { return { result: 'read_fail', n: 0 }; }

  var res = { result: 'ok', n: 0 };
  var shared = null;   // 名簿・台帳・受け取らない・nudge_log は枠の段に進む枠があるときだけ1回読む
  var handled = 0;
  for (var i = 0; i < rows.length && handled < LB_VAC.SLOTS_PER_TICK; i++) {
    if (Date.now() - t0 > LB_VAC.BUDGET_MS) break;
    var c = rows[i], prev = notices[c.resId] || null;
    if (prev && LB_VAC_DONE_STATES[String(prev.state)]) continue;
    var rec = prev || { res_id: c.resId, first_seen_at: nowMs, attempts: 0 };
    rec.trainer_id = c.trainerId; rec.start_at = c.startAt; rec.cancelled_at = c.cancelledAt;
    rec.deadline_at = _lbVacDeadline(c.startAt); rec.updated_at = nowMs; rec.mode = mode; rec.build = LB_VACANCY_BUILD.slice(0, 11);
    var r1 = _lbVacProcess(mode, c, rec, nowMs, wcStartMs, t0, function () { return shared || (shared = _lbVacShared()); });
    handled++;
    res.n += Number(r1.sent || 0) + Number(r1.listed || 0);
    try { _lbVacNoticeWrite(nsh, rec); } catch (eW) { res.result = 'notice_write_fail'; }
    if (r1.stopAll) { if (res.result === 'ok') res.result = r1.stopAll; break; }
  }
  return res;
}

//   名簿・台帳・受け取らない・nudge_log（tick に1回）
function _lbVacShared() {
  var s = { members: null, resv: null, optout: null, log: null };
  try { s.members = _lbNudgeMembers(); } catch (e) { s.members = null; }
  try { s.resv = _lbVacResvRead(); } catch (e) { s.resv = null; }
  s.optout = _lbVacOptoutRead();
  s.log = _lbVacLogRead();
  return s;
}

//   1つのキャンセルを処理する。rec（vacancy_notice の行）を書き換える。返り値 { sent, listed, stopAll }
function _lbVacProcess(mode, c, rec, nowMs, wcStartMs, t0, getShared) {
  var t1 = Date.now(), skip = {};
  function fin(state, why) { rec.state = state; rec.why = why || ''; rec.elapsed_ms = Date.now() - t1; rec.skip_json = JSON.stringify(skip); }
  function wait(why, countAttempt) {
    if (countAttempt) rec.attempts = Number(rec.attempts || 0) + 1;
    if (countAttempt && rec.attempts >= LB_VAC.WAIT_MAX) return fin(Number(rec.sent_n || 0) > 0 ? 'sent' : (why === 'slot_not_yet' ? 'not_offered' : 'unknown'), why);
    fin(Number(rec.sent_n || 0) > 0 ? 'sent_partial' : 'wait', why);
  }
  //   ---- 対象か（§5-4）----
  if (c.dup) { fin('not_target', 'dup_res'); return {}; }
  var tv = _lbVacTargetVerdict(c, nowMs);
  if (!tv.ok) { fin('not_target', tv.why); return {}; }
  if (!(nowMs < Number(rec.deadline_at) - LB_VAC.MARGIN_MS)) { fin(Number(rec.sent_n || 0) > 0 ? 'sent' : 'too_late', 'too_late'); return {}; }
  //   ---- 安い判定（時間帯・声かけの印）----
  if (!_lbVacInSendHours(nowMs)) { wait('night', false); return {}; }
  if (_lbProp('LB_REMIND_ON') === '1' && _lbProp(LB_VAC.NUDGE_DONE_PROP) !== _lbVacDayKey(nowMs)) { wait('nudge_pending', false); return {}; }
  //   ---- 枠の段（§5-5）----
  var trainer = _lbTrainerById(c.trainerId);
  if (!trainer || trainer.hidden) { fin('skip_trainer', trainer ? 'hidden' : 'unknown_trainer'); return {}; }
  var readStart = (typeof LB_SLOTS_READ_START_LOCAL === 'number' && LB_SLOTS_READ_START_LOCAL > 0) ? LB_SLOTS_READ_START_LOCAL : Number(_lbProp(LB_VAC.READ_START_PROP) || 0);
  if (!(readStart > 0) || !isFinite(readStart)) { wait('slots_not_fresh', false); return {}; }
  if (!(c.cancelledAt < readStart)) { wait('cache_older', false); return {}; }
  var sh = getShared();
  if (sh.members === null || sh.resv === null || sh.optout === null || sh.log.readFailed) { wait('read_fail', false); return { stopAll: 'read_fail' }; }
  var S = c.startAt, E = S + SETTINGS.SESSION_MINUTES * 60000;
  for (var q = 0; q < sh.resv.length; q++) {
    var rr = sh.resv[q];
    if (rr.st === 'confirmed' && rr.tid === c.trainerId && rr.ms < E && rr.ms + SETTINGS.SESSION_MINUTES * 60000 > S) { fin(Number(rec.sent_n || 0) > 0 ? 'sent' : 'filled', 'ledger'); return {}; }
  }
  var slots = null;
  try { slots = getTrainerSlots({ trainerId: c.trainerId }, ''); } catch (e) { slots = null; }   // lineUserId 空＝会員に見える枠
  if (!slots || slots.success !== true) { wait('slot_unknown', true); return {}; }
  var offered = (slots.slots || []).some(function (s) { return new Date(s.startISO).getTime() === S; });
  if (!offered) { wait('slot_not_yet', true); return {}; }

  //   ---- 相手を選ぶ（§5-5）----
  var key = _lbVacKey(c.trainerId, S), d0 = _lbVacDay0(S), d1 = d0 + 86400000;
  var visits = _lbVacVisits(sh.resv, S, nowMs), sameDay = {};
  for (var k = 0; k < sh.resv.length; k++) {
    var x = sh.resv[k];
    if ((x.st === 'confirmed' || x.st === 'consumed') && x.ms >= d0 && x.ms < d1) sameDay[x.cid] = true;
  }
  function bump(w) { skip[w] = (skip[w] || 0) + 1; }
  var cands = [], seen = {}, tried = {};
  String(rec.tried || '').split(',').forEach(function (t) { if (t) tried[t] = true; });
  for (var m = 0; m < sh.members.length; m++) {
    var mb = sh.members[m];
    if (!mb.customerId || seen[mb.customerId]) continue;
    seen[mb.customerId] = true;
    if (mb.authState !== 'verified') { bump('not_verified'); continue; }
    if (mb.contractStat !== 'active') { bump('not_active'); continue; }
    if (!mb.lineUserId) { bump('no_line'); continue; }
    if (mb.customerId === c.customerId) { bump('canceller'); continue; }
    var vs = visits[mb.customerId];
    if (!vs || vs.n < LB_VAC.VISIT_MIN) { bump('visits'); continue; }
    if (mb.trainerId && mb.trainerId !== c.trainerId) { bump('other_trainer'); continue; }
    if (sameDay[mb.customerId]) { bump('same_day'); continue; }
    if (sh.optout[mb.customerId]) { bump('opted_out'); continue; }
    var cw = _lbVacCapWhy(sh.log, mb.customerId, key, nowMs);
    if (cw) { bump(cw); continue; }
    if (tried[_lbNudgeMask(mb.customerId)]) { bump('tried'); continue; }   // 前の回で外れると分かった人（下位の候補を塞がない・関門② 2周目）
    cands.push({ m: mb, n: vs.n, lastMs: vs.lastMs });
  }
  cands.sort(function (a, b) { return (b.n - a.n) || (b.lastMs - a.lastMs) || (a.m.customerId < b.m.customerId ? -1 : (a.m.customerId > b.m.customerId ? 1 : 0)); });
  rec.eligible_n = cands.length;   // 名簿・来店・同じ日・受け取らない・上限を通った人数（残数はこの後）
  //   ★送った人数の正本は nudge_log（vacancy_notice が書けなかった回があっても取り違えない・関門② 2周目）
  if (mode === 'on') rec.sent_n = Math.max(Number(rec.sent_n || 0), Number(sh.log.slotCount[key] || 0));

  if (mode === 'list') {
    //   送らずに「送るはずだった3名」を選ぶ（残数は予約画面と同じ関数）。時間の予算を超えたら次の tick でやり直す
    var chosen = [];
    for (var j = 0; j < cands.length && chosen.length < LB_VAC.MAX_PER_SLOT; j++) {
      if (Date.now() - t0 > LB_VAC.BUDGET_MS - LB_VAC.SEND_RESERVE_MS) { wait('budget', false); return {}; }
      var bk = _lbVacBookable(cands[j].m.lineUserId, S);
      if (bk === 'yes') chosen.push(cands[j]); else bump(bk === 'no' ? 'no_remain' : 'remain_unknown');
    }
    rec.would = chosen.map(function (x) { return _lbNudgeMask(x.m.customerId); }).join(',');
    fin(chosen.length ? 'listed' : 'no_target', chosen.length ? '' : 'no_candidate');
    return { listed: chosen.length };
  }
  if (!cands.length) { fin(Number(rec.sent_n || 0) > 0 ? 'sent' : 'no_target', Number(rec.sent_n || 0) >= LB_VAC.MAX_PER_SLOT ? '' : (Number(rec.sent_n || 0) > 0 ? 'no_more' : 'no_candidate')); return {}; }

  //   ---- 送る（§5-23-4・5-24・5-25・関門② 1周目）----
  //   ★候補を順に1人ずつ確かめて送る。直前に外れた人（名簿・残数・ゲート）は飛ばして次の人へ＝下位の候補を塞がない。
  //     1枠3名に届くか、候補が尽きるか、止まる（予算・夜・ロック・判定できない）まで
  var sent = 0, stop = '', stopAll = '', idx = 0, retry = 0;
  //   下4桁が重なった別の人も飛ばす（送らない側）。60人分まで（セルを太らせない）
  function addTried(cid) { var t = String(rec.tried || ''); var mk = _lbNudgeMask(cid); if ((',' + t + ',').indexOf(',' + mk + ',') < 0 && t.split(',').length < 60) rec.tried = t ? t + ',' + mk : mk; }
  for (idx = 0; idx < cands.length; idx++) {
    if (Number(rec.sent_n || 0) >= LB_VAC.MAX_PER_SLOT) break;
    var r2 = _lbVacSendOne(cands[idx].m, c, trainer, key, t0);
    if (r2.sent) { sent++; rec.sent_n = Number(rec.sent_n || 0) + 1; }
    else if (r2.failed) rec.failed_n = Number(rec.failed_n || 0) + 1;
    else if (r2.unknown) { rec.unknown_n = Number(rec.unknown_n || 0) + 1; rec.sent_n = Number(rec.sent_n || 0) + 1; }
    if (r2.skip) bump(r2.skip);
    if (r2.done) addTried(cands[idx].m.customerId);   // 名簿・残数なし・ゲート＝この枠では次の回も外れる
    if (r2.retry) retry++;                              // 残数が判定できない＝後の回で確かめ直す
    if (r2.stop) { stop = r2.stop; if (r2.stopAll) stopAll = r2.stopAll; break; }
  }
  var total = Number(rec.sent_n || 0);
  if (total >= LB_VAC.MAX_PER_SLOT || stop === 'slot_full_now') fin('sent', '');   // 1枠3名に達した（nudge_log の数で決まる）
  else if (stop === 'filled') fin(total > 0 ? 'sent' : 'filled', 'filled_late');
  else if (stop === 'too_late') fin(total > 0 ? 'sent' : 'too_late', 'too_late');
  else if (stop && retry > 0) wait(stop, true);                    // 判定できない人がいた回は止まっても回数を進める（6回で終わり・関門② 3周目）
  else if (stop) fin(total > 0 ? 'sent_partial' : 'wait', stop);   // night・frozen・budget・lock_busy・slot_unknown → 次の tick で続き
  else if (retry > 0) wait('remain_unknown', true);                // 判定できない人がいた → 後の回（6回まで）
  else fin(total > 0 ? 'sent' : 'no_target', total > 0 ? 'no_more' : 'no_candidate');   // 候補を全員確かめ終えた（§5-25-3）
  return { sent: sent, stopAll: stopAll };
}

//   1人に送る（§5-23-4 の a〜h）。返り値 { sent | failed | unknown, skip, stop, stopAll }
function _lbVacSendOne(mb, c, trainer, key, t0) {
  var S = c.startAt, start = new Date(S), end = new Date(S + SETTINGS.SESSION_MINUTES * 60000);
  // a. 残り時間
  if (Date.now() - t0 > LB_VAC.BUDGET_MS - LB_VAC.SEND_RESERVE_MS) return { stop: 'budget' };
  // b. 名簿を読み直す
  var rec = null;
  try { rec = getCustomerByLine(mb.lineUserId); } catch (e) { rec = null; }
  if (!rec || String(rec.data[MAP_COL.AUTH_STATE - 1]) !== 'verified' || String(rec.data[MAP_COL.CONTRACT_STAT - 1] || '') !== 'active'
      || String(rec.data[MAP_COL.CUSTOMER_ID - 1] || '') !== mb.customerId) return { skip: 'member_changed', done: true };
  var tid = String(rec.data[MAP_COL.TRAINER_ID - 1] || '');
  if (tid && tid !== c.trainerId) return { skip: 'other_trainer', done: true };
  // d. 残数（送る直前にもう一度）
  var bk = _lbVacBookable(mb.lineUserId, S);
  if (bk !== 'yes') return bk === 'no' ? { skip: 'no_remain_late', done: true } : { skip: 'remain_unknown', retry: true };
  // e. 予約確定と同じ4段
  var name = String(rec.data[MAP_COL.NAME - 1] || '');
  var ctype = '';
  try { ctype = _lbContractTypeOf(name) || String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''); } catch (eC) { ctype = String(rec.data[MAP_COL.CONTRACT_TYPE - 1] || ''); }
  var fr = _lbVacSlotFreeNow(trainer, start, end, ctype);
  if (!fr.ok) return fr.unknown ? { stop: 'slot_unknown' } : { stop: 'filled', skip: 'busy_' + fr.reason };
  // c. 予約停止のゲート（予備）
  var g0 = _lbBookingGate(mb.customerId, 'line');
  if (!g0.ok) return (g0.code === 'BOOKING_FROZEN') ? { stop: 'frozen', stopAll: 'frozen' } : { skip: 'gate', done: true };
  // f. ロックの中：締め切り・時間帯・ゲート・上限・受け取らない → sending
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { lock = null; }
  if (!lock || !lock.tryLock(LB_VAC.LOCK_WAIT_MS)) return { stop: 'lock_busy' };
  var claimed = false, wrote = false;
  try {
    var now = Date.now();
    if (!(now < _lbVacDeadline(S) - LB_VAC.MARGIN_MS)) return { stop: 'too_late' };
    if (!_lbVacInSendHours(now)) return { stop: 'night' };
    var g = _lbBookingGate(mb.customerId, 'line');
    if (!g.ok) return (g.code === 'BOOKING_FROZEN') ? { stop: 'frozen', stopAll: 'frozen' } : { skip: 'gate', done: true };
    var log = _lbVacLogRead();
    if (log.readFailed) return { stop: 'log_unreadable', stopAll: 'read_fail' };
    var opt = _lbVacOptoutRead();
    if (opt === null) return { stop: 'optout_unreadable', stopAll: 'read_fail' };
    if (opt[mb.customerId]) return { skip: 'opted_out' };
    var cw = _lbVacCapWhy(log, mb.customerId, key, now);
    if (cw) return (cw === 'slot_full') ? { stop: 'slot_full_now' } : { skip: cw };
    try { _lbNudgeLogAppendOne({ kind: LB_VAC.KIND, customerId: mb.customerId, key: key }, now); wrote = true; }
    catch (eA) { return { stop: 'log_unwritable', stopAll: 'log_unwritable' }; }
    claimed = true;
  } finally { try { lock.releaseLock(); } catch (eR) {} }
  if (!claimed || !wrote) return { stop: 'error' };
  // g. 送る（ロックの外・I19）
  var lang = mb.lang || 'ja';
  var msg = _lbVacMessage(lang, _lbVacVars(trainer, S, lang), 'vac=off');
  var pr;
  try { pr = _lbPushOnce(mb.lineUserId, msg.text, { messages: [msg.flex], noInlineRetry: true, purpose: LB_VAC.KIND }); }
  catch (eP) { pr = { ok: false, code: 'EXCEPTION', uncertain: true }; }
  // h. 書き戻し（鍵で探す）。届いたか分からない・探せない・ロックが取れない → sending のまま（送った扱い）
  if (pr && pr.uncertain) return { unknown: true };
  _lbVacSettle(mb.customerId, key, pr && pr.ok ? 'sent' : 'failed', pr && pr.ok ? '' : String((pr && pr.code) || 'push'));
  return (pr && pr.ok) ? { sent: true } : { failed: true };
}
function _lbVacSettle(cid, key, result, detail) {
  var lock = null;
  try { lock = LockService.getScriptLock(); } catch (e) { return; }
  if (!lock || !lock.tryLock(LB_VAC.LOCK_WAIT_MS)) return;
  try {
    var sh = _lbNudgeLogSheet();
    var n = Math.min(50, sh.getLastRow() - 1);
    if (n < 1) return;
    var v = sh.getRange(2, 1, n, LB_NUDGE_LOG_COLS).getValues();
    for (var i = 0; i < v.length; i++) {
      if (String(v[i][1]) === LB_VAC.KIND && String(v[i][2]) === String(cid) && String(v[i][3]) === String(key) && String(v[i][4]) === 'sending') {
        sh.getRange(i + 2, 5, 1, 2).setValues([[result, String(detail || '').slice(0, 200)]]);
        return;
      }
    }
  } catch (e) { Logger.log('空き枠のお知らせ：結果を書き戻せませんでした（sending のまま＝再送しない）'); }
  finally { try { lock.releaseLock(); } catch (eR) {} }
}

// ============================================================
// 受け取らない（postback・§5-10・§5-21-8）。handleLineWebhook から完全一致のときだけ呼ばれる
// ============================================================
function _lbVacIsPostback(ev) {
  var d = String((ev && ev.postback && ev.postback.data) || '');
  return d === 'vac=off' || d === 'vac=test';
}
function _lbVacPostback(ev) {
  var uid = String((ev && ev.source && ev.source.userId) || '');
  var data = String((ev && ev.postback && ev.postback.data) || '');
  var rec = null;
  try { rec = uid ? getCustomerByLine(uid) : null; } catch (e) { rec = null; }
  var lang = rec ? _lbNormLang(rec.data[MAP_COL.LANG - 1]) : 'ja';
  if (data === 'vac=test') { _lbReply(ev.replyToken, _lbVacMsg('test', lang)); return 'test'; }
  var cid = rec ? String(rec.data[MAP_COL.CUSTOMER_ID - 1] || '') : '';
  if (!cid) { _lbReply(ev.replyToken, _lbVacMsg('optout_who', lang)); return 'who'; }
  try {
    var sh = _lbVacSheet(LB_VAC.OPTOUT_SHEET, LB_VAC.OPTOUT_HEAD);
    var have = false;
    if (sh.getLastRow() >= 2) {
      var v = sh.getRange(2, 1, sh.getLastRow() - 1, 1).getValues();
      for (var i = 0; i < v.length; i++) if (String(v[i][0]) === cid) { have = true; break; }
    }
    if (!have) sh.appendRow([sanitizeCell(cid), Date.now(), 'postback']);
  } catch (eW) {
    try { _lbLogOutcome('VAC_OPTOUT_FAIL', 'line', ''); } catch (eL) {}
    _lbReply(ev.replyToken, _lbVacMsg('optout_fail', lang));
    return 'fail';
  }
  _lbReply(ev.replyToken, _lbVacMsg('optout_ok', lang));
  return 'ok';
}

// ============================================================
// 見本（関門③の前・オーナーがエディタで押す）。オーナー（trainer_master の owner）の LINE にだけ送る。postback は vac=test（記録しない）
// ============================================================
function lbVacancySample() {
  var sh = _lbSheet(LINE_BOOKING.TRAINER_SHEET), to = '';
  if (sh && sh.getLastRow() >= 2) {
    var v = sh.getRange(2, 1, sh.getLastRow() - 1, TR_COL.ACTIVE).getValues();
    for (var i = 0; i < v.length; i++) if (String(v[i][TR_COL.ROLE - 1]) === 'owner' && v[i][TR_COL.LINE_USER_ID - 1]) { to = String(v[i][TR_COL.LINE_USER_ID - 1]); break; }
  }
  if (!to) { Logger.log('オーナーの LINE が trainer_master に見つかりません'); return 'no_owner'; }
  var tr = CALENDAR_IDS.TRAINERS.filter(function (t) { return !t.hidden; })[0] || CALENDAR_IDS.TRAINERS[0];
  var S = _lbJstMs(_lbJstParts(Date.now()).y, _lbJstParts(Date.now()).mo, _lbJstParts(Date.now()).d + 2, 10, 0);
  var out = [];
  ['ja', 'en'].forEach(function (lang) {
    var msg = _lbVacMessage(lang, _lbVacVars(tr, S, lang), 'vac=test');
    var r = _lbPushOnce(to, msg.text, { messages: [msg.flex], noInlineRetry: true, purpose: 'vacancy_sample' });
    out.push(lang + ':' + (r.ok ? 'ok' : String(r.code)));
  });
  Logger.log('見本を送りました（' + out.join(' ') + '）。「今後このお知らせを受け取らない」を押すと（テスト）と返ります');
  return out.join(' ');
}

// ============================================================
// 作業依頼（remaining {vacancy:日数}・{vacancyMode:'list'|'off'}）。名前・LINE ID・フル ID・res_id を出さない
// ============================================================
function lbVacancyJobMode(mode) {
  if (mode !== 'list' && mode !== 'off') return '作業依頼から切り替えられるのは list と off だけです（on はオーナーがエディタで lbVacancySetOn）';
  return _lbVacSwitch(mode);
}
function lbVacancyStatusText(days) {
  var d = Number(days); if (!(d > 0 && d <= 60)) d = 14;
  var out = ['===== 空き枠のお知らせ（直近' + d + '日・読み取りだけ）=====', '版: ' + LB_VACANCY_BUILD.slice(0, 11) + '／声かけ ' + LB_NUDGE_BUILD.slice(0, 11),
             'モード: ' + _lbVacMode() + '／声かけ LB_REMIND_ON=' + (_lbProp('LB_REMIND_ON') === '1' ? '1' : '未設定') + '／声かけの完了の印: ' + (_lbProp(LB_VAC.NUDGE_DONE_PROP) || 'なし')];
  var last = null; try { last = JSON.parse(_lbProp(LB_VAC.LAST_PROP) || 'null'); } catch (e) { last = 'broken'; }
  out.push('最後に走った: ' + (last === 'broken' ? '記録が壊れている' : (last ? (Math.round((Date.now() - Number(last.at)) / 60000) + '分前・' + last.result + '・n=' + last.n + '・' + last.build) : 'なし')));
  var sh = _lbSheet(LB_VAC.NOTICE_SHEET);
  if (!sh || sh.getLastRow() < 2) { out.push('vacancy_notice: 行なし'); return out.join('\n'); }
  var v = sh.getRange(2, 1, sh.getLastRow() - 1, LB_VAC.NOTICE_HEAD.length).getValues(), from = Date.now() - d * 86400000;
  function col(n) { return LB_VAC.NOTICE_HEAD.indexOf(n); }
  var st = {}, why = {}, skip = {}, n = 0, sent = 0, failed = 0, unknown = 0, would = 0, ms = [];
  for (var i = 0; i < v.length; i++) {
    if (!(Number(v[i][col('first_seen_at')]) >= from)) continue;
    n++;
    var s = String(v[i][col('state')]); st[s] = (st[s] || 0) + 1;
    var w = String(v[i][col('why')] || ''); if (w) why[w] = (why[w] || 0) + 1;
    sent += Number(v[i][col('sent_n')] || 0); failed += Number(v[i][col('failed_n')] || 0); unknown += Number(v[i][col('unknown_n')] || 0);
    var wl = String(v[i][col('would')] || ''); if (wl) would += wl.split(',').length;
    try { var sj = JSON.parse(String(v[i][col('skip_json')] || '{}')); for (var k in sj) skip[k] = (skip[k] || 0) + Number(sj[k] || 0); } catch (eJ) {}
    if (Number(v[i][col('elapsed_ms')]) >= 0) ms.push(Number(v[i][col('elapsed_ms')]));
  }
  ms.sort(function (a, b) { return a - b; });
  out.push('キャンセル（見た行）: ' + n + '件', '状態: ' + JSON.stringify(st), '理由: ' + JSON.stringify(why),
           '送った人数: ' + sent + '（うち届いたか不明 ' + unknown + '）／届かなかった: ' + failed + '／送るはずだった人数（list）: ' + would,
           '外した理由ごとの人数: ' + JSON.stringify(skip),
           '1件の処理時間 ms: 中央 ' + (ms.length ? ms[Math.floor(ms.length / 2)] : '-') + '／最大 ' + (ms.length ? ms[ms.length - 1] : '-'));
  return out.join('\n');
}

//   日次点検（vacancy_stale・§5-13）。mode が off なら null
function _lbVacHealth(nowMs) {
  var mode = _lbVacMode();
  if (mode === 'off') return null;
  var last = null;
  try { last = JSON.parse(_lbProp(LB_VAC.LAST_PROP) || 'null'); } catch (e) { return { bad: 1, text: '空き枠のお知らせ（' + mode + '）の記録が壊れています' }; }
  if (!last || !(Number(last.at) > 0)) return { bad: 1, text: '空き枠のお知らせ（' + mode + '）が一度も走った記録がありません（warmupCache の末尾から10分ごと）' };
  var age = nowMs - Number(last.at);
  if (age > LB_VAC.STALE_MS) return { bad: 1, text: '空き枠のお知らせ（' + mode + '）が ' + Math.round(age / 60000) + '分 走っていません（最後: ' + last.result + '）' };
  if (LB_VAC.BAD_RESULTS.indexOf(String(last.result)) >= 0) return { bad: 1, text: '空き枠のお知らせ（' + mode + '）の最後の結果が ' + last.result + '（記録が読めない・書けない）' };
  return { bad: 0, text: '空き枠のお知らせ（' + mode + '）は動いています（最後: ' + last.result + '）' };
}
// ==== VACANCY_END ====
