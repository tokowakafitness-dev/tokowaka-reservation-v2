/* 顧客カルテ（設計28 段1 → 設計31 ヒアリング構造化と見せ方の改修）・2026-11-04
 *
 *   予約 LIFF（index.html）の全体の変数を使う：idToken・EDGE_URL・state（trainerId・_isOwner）・liff
 *   Worker の k_ 窓口だけを呼ぶ（GAS には落とさない＝カルテの正本は D1）。
 *
 *   ★守ること
 *     ・書き込みは clientReqId を「その保存1回」で1つ作り、送り直しでも同じ値を使う（二重にならない）
 *     ・トークンが古くて断られたら（STALE_TOKEN）、入力中の内容を端末に退避して読み直し、戻す（メモを消さない）
 *     ・表示は textContent で入れる（会員の入力・メモを HTML として解釈しない）。SVG は createElementNS で数値と固定の文字だけ
 *     ・安全面（健康情報）は端末に退避しない
 *     ・顧客の画面からは呼ばれない（入口のボタンはトレーナー画面にだけある・Worker も customer を通さない）
 *     ・配色は TOKOWAKA の規約（tokowaka-lp/design-system.md §4）。注意の赤は予約画面の --warn
 */
(function () {
  'use strict';
  var KARTE_BUILD = '2026-11-06b お客様に見える欄（お客様へ・次回までに・日のタグ）・お客様の見え方（設計35 C2）';
  var DRAFT_KEY = 'karte_draft_v1';
  //   この画面が必要とする Worker の版。古い Worker には新しい項目を送らない（黙って捨てられるため）
  var NEED_SCHEMA = 32;   // 32＝お客様に見える欄（設計35 C2・Codex 関門②：新しい画面×古い Worker で欄が session から切り離された）
  var SCHEMA_MSG = 'システムの更新中です。少し時間をおいて、カルテを開き直してから保存してください（入力はまだ保存されていません）。';
  function schemaOk(r) { return !!(r && typeof r.karteSchema === 'number' && r.karteSchema >= NEED_SCHEMA); }
  //   お客様に見える欄（設計35 C2）。版（32）で古い Worker への送信を止める。二重の守りとして、
  //     member を送ったのに応答に mnoteId が無ければ「お客様の欄は保存されていません」（欄は下書きに残す・セットは保存済み）
  //   日のタグ（お客様に見える・選ぶだけ）。社内メモのタグ（TAGS）とは別物
  var DAY_TAGS = ['全身', '上半身', '下半身', '脚', '尻', '背中', '胸', '肩', '腕', '体幹', '有酸素', 'ストレッチ'];
  var MEMBER_MAX = { message: 400, todo: 3, todoLen: 60, tags: 6 };
  /** お客様に見える欄を送る形にそろえる。空なら null（＝送らない） */
  function memberOf(m) {
    if (!m || typeof m !== 'object') return null;
    var message = String(m.message || '').trim().slice(0, MEMBER_MAX.message);
    var todo = (Array.isArray(m.todo) ? m.todo : []).map(function (x) { return String(x == null ? '' : x).trim().slice(0, MEMBER_MAX.todoLen); }).filter(Boolean).slice(0, MEMBER_MAX.todo);
    var tags = (Array.isArray(m.tags) ? m.tags : []).filter(function (x, i, a) { return DAY_TAGS.indexOf(x) >= 0 && a.indexOf(x) === i; }).slice(0, MEMBER_MAX.tags);
    if (!message && !todo.length && !tags.length) return null;
    return { message: message, todo: todo, tags: tags };
  }

  // ---------------------------------------------------------------- 固定表（鍵は worker/src/lib/karte-hearing.js と同じ・検査で一致を確かめる）
  var PURPOSES = [['diet', 'ダイエット'], ['bodymake', 'ボディメイク'], ['strength', '筋力アップ'], ['posture', '姿勢改善'],
    ['condition', 'コンディショニング'], ['stamina', '体力づくり'], ['health', '健康維持'], ['sports', '競技・大会']];
  var SLIM_AREAS = [['face', '顔・首'], ['arm', '二の腕'], ['chest', '胸'], ['belly', 'お腹'], ['waist', 'くびれ'],
    ['back', '背中'], ['hip', 'お尻'], ['thigh', '太もも'], ['calf', 'ふくらはぎ']];
  var REGIONS = [['neck', '首'], ['shoulder_r', '右肩'], ['shoulder_l', '左肩'], ['upper_back', '背中'], ['lower_back', '腰'],
    ['elbow_r', '右肘'], ['elbow_l', '左肘'], ['wrist_r', '右手首'], ['wrist_l', '左手首'],
    ['hip_r', '右股関節'], ['hip_l', '左股関節'], ['knee_r', '右膝'], ['knee_l', '左膝'],
    ['ankle_r', '右足首'], ['ankle_l', '左足首'], ['other', 'その他']];
  var TAGS = [['training', 'トレーニング'], ['meal', '食事'], ['life', '生活'], ['body', '体組成の変化']];
  var REASONS = [['snack_down', '間食が減った', 'meal'], ['protein_low', 'タンパク質が少ない', 'meal'], ['eating_out', '外食が多い', 'meal'],
    ['cut_too_much', '量を減らしすぎ', 'meal'], ['meal_irregular', '食事の時間が不規則', 'meal'],
    ['self_training_up', '自主トレが増えた', 'exercise'], ['cardio_up', '有酸素運動が増えた', 'exercise'],
    ['visit_gap', '来店の間隔が空いた', 'exercise'], ['steps_down', '日常の歩数が減った', 'exercise'],
    ['sleep_short', '睡眠が短い', 'life'], ['busy', '仕事が忙しい', 'life'], ['tired', '疲れが抜けない', 'life']];
  var REASON_GROUPS = [['meal', '食事'], ['exercise', '運動'], ['life', '睡眠と生活']];
  //   身体図の位置（前・後ろ。人の右＝図の左）
  var REGION_POS = { neck: ['f', 60, 40], shoulder_r: ['f', 30, 52], shoulder_l: ['f', 90, 52], elbow_r: ['f', 22, 80], elbow_l: ['f', 98, 80],
    wrist_r: ['f', 22, 102], wrist_l: ['f', 98, 102], hip_r: ['f', 48, 114], hip_l: ['f', 72, 114], knee_r: ['f', 48, 150], knee_l: ['f', 72, 150],
    ankle_r: ['f', 48, 184], ankle_l: ['f', 72, 184], upper_back: ['b', 60, 62], lower_back: ['b', 60, 98] };
  var EXERCISES = ['ベンチプレス', 'チェストプレス', 'スクワット', 'レッグプレス', 'ヒップスラスト', 'デッドリフト', 'ラットプルダウン', 'シーテッドロウ', 'ショルダープレス', 'サイドレイズ', 'アームカール', 'プランク'];
  //   上から順に当てる（「ショルダープレス」「プレスダウン」「レッグレイズ」を胸・脚に取られないよう、胸は最後）
  var PARTS = [['体幹', /プランク|クランチ|腹筋|レッグレイズ|ドローイン|デッドバグ/],
    ['脚・尻', /スクワット|レッグ|ランジ|ヒップ|デッドリフト|ブルガリアン|カーフ|アダクション|アブダクション/],
    ['背中', /ラット|ロウ|懸垂|プルダウン|背筋|プルオーバー/],
    ['肩', /ショルダー|サイドレイズ|リアレイズ|フロントレイズ|アップライト/], ['腕', /カール|トライセプス|キックバック|プレスダウン/],
    ['胸', /ベンチ|チェスト|プレス|フライ|腕立て|ディップス/]];
  var MEASURE = [
    ['weight_kg', '体重', 'kg', 0.1], ['body_fat_pct', '体脂肪率', '%', 0.1], ['skeletal_muscle_kg', '骨格筋量', 'kg', 0.1],
    ['lean_kg', '除脂肪量', 'kg', 0.1], ['body_water_l', '体水分量', 'L', 0.1], ['visceral_fat', '内臓脂肪', '', 1],
    ['waist_cm', 'ウエスト', 'cm', 0.1], ['hip_cm', 'ヒップ', 'cm', 0.1], ['chest_cm', '胸囲', 'cm', 0.1],
    ['arm_cm', '上腕', 'cm', 0.1], ['thigh_cm', '太もも', 'cm', 0.1]
  ];
  var METRICS = [['w', '体重', 'kg'], ['pbf', '体脂肪率', '%'], ['smm', '骨格筋量', 'kg'], ['waist', 'ウエスト', 'cm']];
  var COND = { good: '良い', normal: '普通', bad: '悪い' };
  var TABS = [['summary', '概要'], ['body', '体組成'], ['training', 'トレーニング'], ['notes', '指導の履歴'], ['contract', '契約・会員']];

  var cur = { customerId: '', name: '', tab: 'summary', root: null, body: null, summary: null };

  // ---------------------------------------------------------------- 見た目（固定の CSS。会員のデータは入れない）
  var CSS = [
    //   モック（承認済み）と同じ作り：ゴシック体・白いカード・角丸・下のタブ。
    //   色は2026-11-05 オーナー確定の配色（会員画面と共通）：地 #fafbfc・主ネイビー #243b66・淡 #edf2fb・注意はコーラル #bb4630／ピーチ #fff0ea
    //   （11-04 のグリーン版の値：主 0e6b5c・押下 0a5246・淡 e3f1ee）
    '#karteRoot{--k-acc:#243b66;--k-acc2:#1a2d50;--k-acc-l:#edf2fb;--k-gold:#b8965a;--k-gold-l:#f3ecdc;--k-cream:#fafbfc;--k-ground:#fafbfc;--k-ink:#1c2321;--k-sub:#5b6661;--k-line:#e7ebf0;--k-warn:#bb4630;--k-warn-l:#fff0ea;',
    'position:fixed;inset:0;z-index:9000;background:var(--k-ground);overflow:auto;-webkit-overflow-scrolling:touch;overscroll-behavior:contain;color:var(--k-ink);font-family:"Noto Sans JP",-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;font-size:14px;line-height:1.6;}',
    '#karteRoot .k-wrap{max-width:520px;margin:0 auto;min-height:calc(100% + 2px);display:flex;flex-direction:column;}',
    '#karteRoot .k-head{background:#fff;color:var(--k-ink);padding:10px 14px;border-bottom:1px solid var(--k-line);}',
    '#karteRoot .k-head-row{display:flex;align-items:center;gap:10px;}',
    '#karteRoot .k-back{min-width:44px;min-height:44px;border:1px solid var(--k-line);background:#fff;color:var(--k-ink);border-radius:12px;font-size:18px;}',
    '#karteRoot .k-name{font-size:17px;font-weight:700;letter-spacing:.02em;}',
    '#karteRoot .k-meta{font-size:12px;color:var(--k-sub);margin-top:2px;}',
    '#karteRoot .k-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;}',
    '#karteRoot .k-chip-h{font-size:12px;padding:4px 10px;background:var(--k-acc-l);color:var(--k-acc);border-radius:999px;}',
    '#karteRoot .k-gtag{font-size:12px;padding:3px 10px;background:var(--k-gold-l);color:#6b5427;border-radius:999px;}',
    '#karteRoot .k-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:#fff;border-top:1px solid var(--k-line);position:sticky;bottom:0;z-index:2;padding:4px 4px calc(8px + env(safe-area-inset-bottom));margin-top:auto;}',
    '#karteRoot .k-tab{min-height:56px;padding:4px 2px;border:none;background:transparent;font-size:14px;line-height:1.25;color:var(--k-sub);border-top:3px solid transparent;font-family:inherit;}',   // ★iPhone で小さすぎた（12px・48px → 14px・56px、2026-11-04h）
    '@media (min-width:400px){#karteRoot .k-tab{font-size:15px;}}',
    '#karteRoot .k-tab.on{color:var(--k-acc);font-weight:700;border-top-color:var(--k-acc);}',
    '#karteRoot .k-body{padding:12px 14px 18px;display:flex;flex-direction:column;gap:10px;flex:1;}',
    '#karteRoot .k-card{background:#fff;border:1px solid #dde3ea;border-radius:14px;padding:12px;box-shadow:0 1px 3px rgba(28,35,33,.07);}',
    '#karteRoot .k-h{font-size:14px;font-weight:700;color:var(--k-ink);margin:0 0 8px;}',
    '#karteRoot .k-sub{font-size:12px;color:var(--k-sub);}',
    '#karteRoot .k-msg{font-size:13px;color:var(--k-sub);margin:6px 0;}',
    '#karteRoot .k-msg.bad{color:var(--k-warn);}',
    '#karteRoot .k-caution{background:var(--k-warn-l);border-radius:14px;padding:12px;}',
    '#karteRoot .k-caution .k-h{color:var(--k-warn);font-size:14px;}',
    '#karteRoot .k-btn{display:block;width:100%;min-height:44px;border:none;border-radius:10px;background:var(--k-acc);color:#fff;font-size:14px;font-weight:700;margin-top:4px;font-family:inherit;}',
    '#karteRoot .k-btn.out{background:#fff;color:var(--k-acc);border:1.5px solid var(--k-acc);font-weight:700;}',
    '#karteRoot .k-btn.out.k-danger{color:var(--k-warn);border-color:#e09a86;font-weight:500;}',
    '#karteRoot .k-btn:active{filter:brightness(.92);}',
    '#karteRoot .k-btn.small{display:inline-block;width:auto;min-height:44px;padding:0 14px;font-size:13px;margin:0;}',
    '#karteRoot .k-pill{min-height:44px;padding:0 12px;border-radius:999px;border:1px solid #8692a6;background:#fff;color:#3f4550;font-size:13px;font-family:inherit;}',
    '#karteRoot .k-pill.on{border:1.5px solid var(--k-acc);background:var(--k-acc);color:#fff;font-weight:700;}',
    '#karteRoot .k-pills{display:flex;flex-wrap:wrap;gap:8px;}',
    '#karteRoot .k-seg{display:flex;background:#ecedef;border-radius:10px;padding:3px;gap:2px;}',
    '#karteRoot .k-seg button{flex:1;min-height:44px;border:none;border-radius:8px;background:transparent;font-size:13px;color:#3f4550;font-family:inherit;}',
    '#karteRoot .k-seg button.on{background:#fff;color:var(--k-ink);font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '#karteRoot .k-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
    '#karteRoot .k-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}',
    '#karteRoot .k-num{font-weight:700;color:var(--k-ink);}',
    '#karteRoot .k-up{color:var(--k-warn);font-weight:700;} #karteRoot .k-down{color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--k-sub);margin-bottom:10px;}',
    '#karteRoot .k-field input,#karteRoot .k-field textarea,#karteRoot .k-field select{min-height:44px;border:1px solid #8692a6;border-radius:8px;padding:8px 10px;font-size:16px;font-family:inherit;color:var(--k-ink);background:#fff;box-sizing:border-box;width:100%;}',
    '#karteRoot .k-tag{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--k-acc-l);color:var(--k-acc);}',
    '#karteRoot .k-flag{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--k-warn-l);color:var(--k-warn);font-weight:500;}',
    '#karteRoot .k-flag.soft{background:#fbefd9;color:#7a4a06;}',
    '#karteRoot .k-flag.grey{background:#eeeeec;color:#3f4550;font-weight:400;}',
    '#karteRoot .k-tl{border-left:2px solid #d5d8de;margin-left:6px;padding-left:14px;display:flex;flex-direction:column;gap:14px;}',
    '#karteRoot .k-tl-item{position:relative;}',
    '#karteRoot .k-tl-dot{position:absolute;left:-21px;top:4px;width:12px;height:12px;border-radius:6px;background:var(--k-acc);}',
    '#karteRoot .k-bar{height:12px;border-radius:6px;background:#eeeeec;} #karteRoot .k-bar>div{height:12px;border-radius:6px;background:var(--k-acc);}',
    '#karteRoot .k-setrow{display:grid;grid-template-columns:22px minmax(0,1fr) minmax(0,1fr) 44px 44px 44px;gap:6px;align-items:center;margin-bottom:6px;}',
    '#karteRoot .k-setnote{margin:-2px 0 8px 28px;}',
    '#karteRoot .k-btn.k-setdel2{display:none;}',   // .k-btn.small（inline-block）より強くする
    '#karteRoot .k-memochips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
    '#karteRoot .k-memochips button{min-height:44px;padding:0 12px;border-radius:999px;border:1px solid #8692a6;background:#fff;font-size:14px;font-family:inherit;color:#3f4550;}',
    //   幅の狭い端末（380px 以下＝iPhone SE・mini を含む）：セットを消すボタンはメモ欄の中へ移し、数字の欄を広く取る
    //   （375px で6列のままだと数字の欄が約47px＝「102.5」が欠ける）
    '@media (max-width:380px){#karteRoot .k-setrow{grid-template-columns:20px minmax(0,1fr) minmax(0,1fr) 44px 44px;gap:4px;} #karteRoot .k-setrow input{padding:0 6px;} #karteRoot .k-setdel{display:none;} #karteRoot .k-btn.k-setdel2{display:inline-block;} #karteRoot .k-setnote{margin-left:24px;}}',
    '#karteRoot .k-setnote input{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #8692a6;border-radius:10px;padding:0 10px;font-size:16px;background:#fff;}',
    '#karteRoot .k-setrow input{box-sizing:border-box;width:100%;min-width:0;min-height:44px;border:1px solid #8692a6;border-radius:10px;padding:0 10px;font-size:16px;}',
    '#karteRoot .k-picker-go{position:sticky;bottom:76px;z-index:2;}',
    //   キーパッドが出ているあいだ（k-kb）：下のタブを隠し、決定ボタンは下に詰める
    '#karteRoot.k-kb .k-tabs{display:none;}',
    '#karteRoot.k-kb .k-picker-go{bottom:0;}',
    '#karteRoot .k-accessory{position:sticky;bottom:0;z-index:5;display:flex;gap:8px;align-items:center;padding:6px 10px;background:#eef0ee;border-top:1px solid var(--k-line);}',
    '#karteRoot .k-accessory button{min-height:44px;min-width:64px;border:1px solid #8692a6;border-radius:10px;background:#fff;font-size:16px;font-family:inherit;color:var(--k-ink);}',
    '#karteRoot .k-accessory button.done{background:var(--k-acc);color:#fff;border-color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-rest-done{animation:kflash 0.6s ease-in-out 0s 6 alternate;}',
    '@keyframes kflash{from{background:#fff0ea;}to{background:#f7b7a3;}}',
    'html.karte-open,html.karte-open body{overflow:hidden;}',
    //   ★はみ出し対策（2026-11-04g・iPhone の LIFF で日付の欄がカードの右端を越えた）
    //     ・iOS の date/time 入力は固有の見た目と最小幅を持ち、width:100% でも親を越える＝appearance を外し、最小幅を0にする
    //     ・grid / flex の子は既定で「中身の最小幅」より縮まない＝min-width:0 を明示する
    //     ・長い英数字（種目名・メモ・URL）は途中で折り返す
    '#karteRoot{overflow-wrap:anywhere;word-wrap:break-word;}',
    '#karteRoot .k-field{min-width:0;}',
    '#karteRoot .k-field input,#karteRoot .k-field textarea,#karteRoot .k-field select{display:block;min-width:0;max-width:100%;}',
    '#karteRoot input[type=date],#karteRoot input[type=time]{-webkit-appearance:none;appearance:none;display:block;box-sizing:border-box;width:100%;min-width:0;max-width:100%;text-align:left;line-height:1.5;}',
    '#karteRoot input[type=date]::-webkit-date-and-time-value,#karteRoot input[type=time]::-webkit-date-and-time-value{text-align:left;margin:0;min-height:1.5em;}',
    '#karteRoot .k-grid2>*,#karteRoot .k-grid3>*{min-width:0;}',
    '#karteRoot .k-pill,#karteRoot .k-btn.small{max-width:100%;}',
    //   休憩の帯：数えていないとき（中身が空）は出さない。inline の display:none と二重に守る
    '#karteRoot .k-restbar{background:var(--k-acc-l);border:1px solid #d2ddf0;border-radius:10px;padding:6px 6px 6px 12px;display:flex;align-items:center;gap:8px;margin:0 0 8px 28px;}',
    '#karteRoot .k-restbar:empty{display:none !important;}',
    '#karteRoot.k-entry .k-head,#karteRoot.k-entry .k-tabs{display:none;}',
    '#karteRoot .k-entryhead{background:var(--k-acc);color:#fff;padding:10px 14px;display:flex;align-items:center;gap:10px;position:sticky;top:0;z-index:4;}',
    '#karteRoot .k-entryhead .k-back{color:#fff;background:transparent;border:1px solid rgba(255,255,255,.55);border-radius:12px;}',
    '#karteRoot .k-entrytitle{font-size:16px;font-weight:700;} #karteRoot .k-entrysub{font-size:12px;opacity:.85;}',
    '#karteRoot .k-savebar{position:sticky;bottom:0;z-index:3;background:#fff;border-top:1px solid var(--k-line);margin:10px -14px -18px;padding:10px 14px calc(10px + env(safe-area-inset-bottom));}',
    '#karteRoot.k-kb .k-savebar{position:static;}',
    '#karteRoot .k-entrytext{position:relative;min-height:44px;}',
    '#karteRoot .k-dateover{position:absolute;inset:0;opacity:0;width:100%;height:100%;min-height:44px;border:0;}',
    '#karteRoot .k-btn.k-btn-line{background:#fff;color:var(--k-acc);border:1px solid var(--k-acc);min-height:44px;margin:0 0 10px;}',
    '#karteRoot .k-excol{display:flex;align-items:center;gap:8px;width:100%;min-height:48px;background:#fff;border:1px solid #dde3ea;box-shadow:0 1px 3px rgba(28,35,33,.07);border-radius:12px;padding:0 12px;margin-bottom:10px;font-family:inherit;color:var(--k-ink);}',
    '#karteRoot .k-addset{display:block;width:100%;min-height:44px;border:1px dashed var(--k-acc);border-radius:10px;background:#fff;color:var(--k-acc);font-size:14px;font-family:inherit;margin-top:4px;}',
    '#karteRoot .k-pick{display:flex;flex-direction:column;gap:8px;width:100%;text-align:left;font-family:inherit;font-size:14px;color:var(--k-ink);}',
    '#karteRoot .k-pick.on{border:2px solid var(--k-acc);}',
    '#karteRoot .k-dayrow{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:44px;border:0;background:transparent;padding:0;font-family:inherit;font-size:14px;color:var(--k-ink);}',
    '#karteRoot .k-daycard.focus{border-color:var(--k-acc);}',
    '#karteRoot input:focus,#karteRoot textarea:focus,#karteRoot select:focus{outline:none;border-color:var(--k-acc) !important;box-shadow:0 0 0 3px rgba(36,59,102,.18);}',
    '#karteRoot .k-link{font-weight:700;}',
    '#karteRoot .k-memo{box-sizing:border-box;width:100%;border:1px solid #8692a6;border-radius:10px;padding:10px;font-size:16px;font-family:inherit;line-height:1.6;resize:vertical;background:#fff;color:var(--k-ink);}',
    '#karteRoot .k-admin{background:#f0f3f7;border-radius:14px;padding:12px;display:flex;flex-direction:column;gap:10px;margin-top:6px;}',
    '#karteRoot .k-headrow{display:flex;justify-content:space-between;align-items:center;gap:8px;margin:-10px 0 2px;}',
    '#karteRoot .k-link{min-height:44px;padding:0 2px 0 8px;border:none;background:transparent;color:var(--k-acc);font-size:13px;font-family:inherit;white-space:nowrap;}',
    '#karteRoot .k-caution .k-link{color:var(--k-warn);}',
    '#karteRoot .k-note-hint{font-size:12px;color:var(--k-warn);background:var(--k-warn-l);border-radius:8px;padding:6px 10px;margin-bottom:10px;}'
  ].join('\n');
  function ensureStyle() {
    if (document.getElementById('karteStyle')) return;
    var st = document.createElement('style'); st.id = 'karteStyle'; st.textContent = CSS;
    document.head.appendChild(st);
  }

  // ---------------------------------------------------------------- 道具
  function el(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'text') e.textContent = attrs[k];
      else if (k === 'style') e.style.cssText = attrs[k];
      else if (k === 'class') e.className = attrs[k];
      else if (k.indexOf('on') === 0) e[k] = attrs[k];
      else e.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  var SVGNS = 'http://www.w3.org/2000/svg';
  function sv(tag, attrs, text) {
    var e = document.createElementNS(SVGNS, tag);
    for (var k in attrs) e.setAttribute(k, String(attrs[k]));
    if (text != null) e.textContent = String(text);
    return e;
  }
  function label(tbl, key) { for (var i = 0; i < tbl.length; i++) if (tbl[i][0] === key) return tbl[i][1]; return key; }
  function today() { var t = new Date(Date.now() + 9 * 3600000); return t.toISOString().slice(0, 10); }
  function newReqId() {
    try { if (window.crypto && crypto.randomUUID) return 'k' + crypto.randomUUID().replace(/-/g, ''); } catch (e) {}
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function fmtDate(ms) { if (!ms) return ''; var t = new Date(Number(ms) + 9 * 3600000); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + ' ' + String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0'); }
  function md(d) { var p = String(d || '').split('-'); return p.length === 3 ? (+p[1]) + '/' + (+p[2]) : String(d || ''); }
  function msg(text, bad) { return el('p', { class: 'k-msg' + (bad ? ' bad' : ''), text: text }); }
  //   見出しの右に小さなリンク（「編集 ›」「体組成へ ›」）。押せる高さは 44px 取る（2026-11-05 整理：概要は読むだけ・書くのはリンクの先）
  function headRow(title, linkText, onclick, cls) {
    return el('div', { class: 'k-headrow' }, [el('div', { class: 'k-h', style: 'margin:0;', text: title }),
      linkText ? el('button', { type: 'button', class: 'k-link' + (cls ? ' ' + cls : ''), text: linkText, onclick: onclick }) : null]);
  }
  function card(title, kids, cls) { return el('div', { class: cls || 'k-card' }, [title ? el('div', { class: 'k-h', text: title }) : null].concat(kids || [])); }
  function trainerName(id) {
    var list = (window.state && state._allTrainers) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name;
    return id ? 'トレーナー' : '';
  }
  function r1(x) { return Math.round(Number(x) * 10) / 10; }
  var ERR = {
    NO_CONSENT: '健康情報の同意が記録されていません。先に「同意を記録」してください。',
    CONFLICT: 'ほかの人が先に更新しました。画面を開き直して最新の内容を確認してください。',
    RATE_LIMITED: '短い時間に保存が続いたため、少し時間をおいてください。',
    BODY_NOT_READY: '体組成の記録を利用できません。しばらくしてから開き直してください（続くときはオーナーへ）。',
    BAD_STATE: 'この記録はできません（退会・再入会の順序、または取り消せるのは最後の記録だけです）。',
    FORBIDDEN: 'この操作の権限がありません。', NOT_FOUND: '見つかりませんでした。', REQ_REUSED: '送信が重なりました。開き直してください。',
    TOTAL_SETS: '1回の記録は合計60セットまでです。',
    KARTE_OFF: 'カルテは一時停止中です。', TOO_LARGE: '入力が長すぎます。', BAD_REQUEST: '入力を確認してください。',
    EXISTS: 'この記録には、すでにお客様に見える欄があります。「お客様の見え方」から直してください。'
  };
  function errText(r) { return (r && ERR[r.code]) || ('うまくいきませんでした（' + ((r && (r.code || r.detail)) || '通信') + '）'); }

  // ---------------------------------------------------------------- 通信
  function post(body) {
    return fetch(EDGE_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      .then(function (r) { return r.json().catch(function () { return { success: false, code: 'BAD_RESPONSE' }; }); });
  }
  function kRead(action, params) {
    var body = { action: action, idToken: idToken };
    for (var k in params) body[k] = params[k];
    return post(body).then(function (r) {
      if (r && r.code === 'UNAUTHORIZED') {
        var fresh = (window.liff && liff.getIDToken) ? (liff.getIDToken() || '') : '';
        if (fresh && fresh !== idToken) { idToken = fresh; body.idToken = fresh; return post(body); }
      }
      return r;
    });
  }
  // 書き込み：reqId は呼ぶ側が「保存1回」につき1つ作って渡す。draft は退避用（読み直して戻す）
  function kWrite(action, params, reqId, draft) {
    var body = { action: action, idToken: idToken, clientReqId: reqId };
    for (var k in params) body[k] = params[k];
    return post(body).then(function (r) {
      if (r && r.code === 'UNAUTHORIZED') {
        var fresh = (window.liff && liff.getIDToken) ? (liff.getIDToken() || '') : '';
        if (fresh && fresh !== idToken) { idToken = fresh; body.idToken = fresh; return post(body).then(function (r2) { return handleStale(r2, draft); }); }
        return handleStale(r, draft);
      }
      return r;
    });
  }
  //   ★トークンが古い（発行から10分超）＝入力を退避して読み直す。読み直しても同じなら、開き直しを案内
  function handleStale(r, draft) {
    if (!r || r.code !== 'UNAUTHORIZED') return r;
    //   ★トレーニングの送信中に別の顧客を開いていたら、読み直さない（その顧客の画面を奪わない・下書きの pending は端末に残る）
    if (draft && draft.kind === 'training' && draft.customerId && draft.customerId !== cur.customerId) return { success: false, code: 'BAD_RESPONSE' };
    try {
      if (!sessionStorage.getItem('karte_reauth')) {
        sessionStorage.setItem('karte_reauth', '1');
        var isTr = !!(draft && draft.kind === 'training');
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ customerId: isTr ? draft.customerId : cur.customerId, name: isTr ? '' : cur.name, tab: isTr ? 'training' : cur.tab, draft: isTr ? { kind: 'training' } : (draft || null), at: Date.now() }));   // ★トレーニングは氏名を残さない（開き直したら概要から取る）
        reloadPage();
        return new Promise(function () {});
      }
    } catch (e) {}
    return { success: false, code: 'STALE', message: 'ログインの更新が必要です。LINE から開き直してください（入力内容は端末に残っています）。' };
  }
  //   読み直しは1か所（検査では window.__karteReload で差し替える）
  function reloadPage() { if (typeof window.__karteReload === 'function') window.__karteReload(); else location.reload(); }

  // ---------------------------------------------------------------- 画面の枠
  //   ★キーパッド（2026-11-04 オーナー指示「入力欄は必ずキーパッドの上に」）
  //     iPhone はキーパッドが出ても画面（layout viewport）が縮まず、見える範囲（visual viewport）だけが縮む＝
  //     下に固定したものや入力欄がキーパッドの裏に隠れる。見える範囲の高さと位置に画面を合わせ、触った欄をその中へ動かす。
  //     Android は画面ごと縮むので、同じ計算で崩れない。
  var kb = { base: 0, w: 0, on: false, raf: 0, revealT: 0, resampleUntil: 0, lastInput: null };
  function fitViewport() {   // 何度呼ばれても1フレームに1回だけ計算する
    if (kb.raf) return;
    kb.raf = (window.requestAnimationFrame || function (f) { return setTimeout(f, 16); })(function () { kb.raf = 0; fitNow(); });
  }
  function fitNow() {
    var root = cur.root; if (!root) return;
    var vv = window.visualViewport;
    var h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0, w = vv ? vv.width : window.innerWidth;
    //   ★基準の高さは「キーパッドが無いときの高さ」。端末を回して幅が変わったら採り直す（回転で縮んだのをキーパッドと見誤らない）
    //   ★回転の途中は innerHeight が古いことがある＝混ぜない。回転のあと0.5秒のあいだだけ採り直す
    //     （出来事の回数で数えると、次の出来事がキーパッドの表示だったときにその高さを基準にしてしまう）
    if (!kb.base) { kb.base = h; kb.w = w; }
    else if (Math.abs(w - kb.w) > 80) { kb.base = h; kb.w = w; kb.resampleUntil = Date.now() + 500; }
    else if (Date.now() < (kb.resampleUntil || 0)) {
      //   採り直しの間でも、入力中に大きく縮んだのはキーパッド＝基準にしない
      var a0 = document.activeElement;
      var editing = a0 && root.contains(a0) && /^(INPUT|TEXTAREA|SELECT)$/.test(a0.tagName);
      if (editing && (kb.base - h) > 120) kb.resampleUntil = 0; else kb.base = h;
    }
    else if (h > kb.base) kb.base = h;
    root.style.top = top + 'px'; root.style.height = h + 'px'; root.style.bottom = 'auto';
    var open = (kb.base - h) > 120;   // 120px 以上縮んだ＝キーパッドが出ている
    if (open !== kb.on) {
      kb.on = open; root.classList.toggle('k-kb', open);
      if (open) revealFocused();   // ★動かすのは「閉→開」に変わった瞬間の1回だけ（スクロールの連鎖でちらつかない）
    }
    accessory();
  }
  function revealFocused() {
    if (kb.revealT) clearTimeout(kb.revealT);
    kb.revealT = setTimeout(function () {
      kb.revealT = 0;
      var a = document.activeElement;
      if (!a || !cur.root || !cur.root.contains(a) || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return;
      try { a.scrollIntoView({ block: 'center', behavior: 'auto' }); } catch (e) { try { a.scrollIntoView(); } catch (e2) {} }
    }, 80);
  }
  //   キーパッドの上の「前へ／次へ／完了」（iPhone の数字のキーパッドには「次へ」のキーが無いため）
  function setInputs() { return cur.root ? Array.prototype.slice.call(cur.root.querySelectorAll('.k-setrow input')).filter(function (x) { return !x.disabled; }) : []; }
  function accessory() {
    var root = cur.root; if (!root) return;
    var bar = root.querySelector('#kAccessory');
    var a = document.activeElement;
    var show = kb.on && ((a && a.closest && a.closest('.k-setrow')) || (a && a.closest && a.closest('#kAccessory')));
    if (!show) { if (bar) bar.remove(); return; }
    if (bar) return;
    //   ★いまの欄は focusin で覚えた欄を使う（ボタンを押した瞬間にフォーカスが移る端末でも動く）
    function move(d) { var all = setInputs(), cur0 = kb.lastInput, k = all.indexOf(cur0); if (k < 0) return; var n = all[k + d]; if (n) n.focus(); else cur0.blur(); }
    function keep(e) { e.preventDefault(); }
    bar = el('div', { id: 'kAccessory', class: 'k-accessory' }, [
      el('button', { type: 'button', text: '前へ', onpointerdown: keep, onmousedown: keep, onclick: function () { move(-1); } }),
      el('button', { type: 'button', text: '次へ', onpointerdown: keep, onmousedown: keep, onclick: function () { move(1); } }),
      el('div', { style: 'flex:1;' }),
      el('button', { type: 'button', class: 'done', text: '完了', onpointerdown: keep, onmousedown: keep, onclick: function () { if (kb.lastInput) kb.lastInput.blur(); if (document.activeElement && document.activeElement.blur) document.activeElement.blur(); } })]);
    var wrap = root.querySelector('.k-wrap') || root;
    wrap.appendChild(bar);
  }
  function onFocusIn(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.k-setrow')) kb.lastInput = t;
    if (t && t.tagName === 'INPUT' && t.type === 'number') { try { t.select(); } catch (er) {} }   // 数字は触ったら全選択＝そのまま打ち直せる
    if (kb.on) revealFocused();   // すでにキーパッドが出ているときは、ここで1回だけ動かす（出る前なら「閉→開」で動かす）
    accessory();
  }
  function onFocusOut() { setTimeout(accessory, 0); }
  // ---------------------------------------------------------------- 戻る・進む（2026-11-04 オーナー指示）
  //   ★カルテの画面を移るたびにブラウザの履歴へ1つ積む＝iPhone の左端スワイプ・Android の戻るボタンが
  //     LIFF を閉じずにカルテの前の画面へ戻る。履歴には顧客ID・タブだけ（氏名は入れない）
  //   ★画面の中の横スワイプ：左→右で戻る、右→左で進む
  var nav = { i: 0, restoring: false, canceling: false };
  function navState() { return (window.history && history.state && history.state.karte) ? history.state : null; }
  function navPush(st, mode) {
    if (mode === 'none' || nav.restoring || !window.history || !history.pushState) return;
    var curSt = navState();
    try {
      //   いまの画面のスクロール位置を、いまの履歴に残してから移る（戻ったときに同じ位置へ）
      if (curSt && cur.root && mode !== 'replace') history.replaceState(Object.assign({}, curSt, { scroll: cur.root.scrollTop }), '');
      if (mode === 'replace' && curSt) { st.karte = 1; st.i = curSt.i; history.replaceState(st, ''); }
      else { st.karte = 1; st.i = (curSt ? curSt.i : 0) + 1; history.pushState(st, ''); }
      nav.i = st.i;
    } catch (e) {}
  }
  function goBack() { if (navState()) history.back(); else close(); }
  function exitKarte() {
    if (cur.dirty && !window.confirm('入力中の内容は保存されていません。カルテを閉じますか？')) return;
    cur.dirty = false;
    var st = navState();
    if (st && st.i > 0) { try { history.go(-st.i); return; } catch (e) {} }
    close();
  }
  function onPopState(e) {
    if (nav.canceling) { nav.canceling = false; return; }   // 取り消しで元の位置へ戻ったときの1回は描かない
    var st = e.state && e.state.karte ? e.state : null;
    //   入力中なら確かめる。やめたら、来た向きの逆へ1つ動いて元の位置に戻る（積み直さない＝履歴の数え方を崩さない）
    if (cur.root && cur.dirty) {
      if (!window.confirm('入力中の内容は保存されていません。前の画面に戻りますか？')) {
        nav.canceling = true;
        try { if (!st || st.i < nav.i) history.forward(); else history.back(); } catch (er) { nav.canceling = false; }
        return;
      }
    }
    cur.dirty = false;
    if (!st) { if (cur.root) close(); return; }
    nav.i = st.i; nav.restoring = true;
    try {
      if (st.board) openBoard(null, null, 'none');
      else open(st.cid, st.cid === cur.customerId ? cur.name : '', st.tab, st.sub ? { kind: 'sub', sub: st.sub, navMode: 'none' } : null, 'none');
    } finally { nav.restoring = false; }
    if (st.scroll) restoreScroll(st.scroll, st);
  }
  //   中身は読み込みのあとに伸びるので、何度か当てる。★当てるのは「その履歴の画面のまま」のときだけ・指で触ったらやめる
  var scrollFix = { gen: 0 };
  function restoreScroll(y, st) {
    var root = cur.root, gen = ++scrollFix.gen;
    [60, 400, 1000].forEach(function (t) {
      setTimeout(function () {
        var now = navState();
        if (gen !== scrollFix.gen || !root || cur.root !== root || !now) return;
        if (now.i !== st.i || (now.cid || '') !== (st.cid || '') || (now.tab || '') !== (st.tab || '') || (now.sub || '') !== (st.sub || '') || !!now.board !== !!st.board) return;
        if (root.scrollTop < y) root.scrollTop = y;
      }, t);
    });
  }
  //   いまの画面のスクロール位置を、いまの履歴に残し続ける（端末の戻るで離れても、進んで戻ったとき同じ位置に）
  var scrollSave = { t: 0 };
  function onRootScroll() {
    if (scrollSave.t) clearTimeout(scrollSave.t);
    scrollSave.t = setTimeout(function () {
      scrollSave.t = 0;
      var st = navState(); if (!st || !cur.root) return;
      try { history.replaceState(Object.assign({}, st, { scroll: cur.root.scrollTop }), ''); } catch (e) {}
    }, 150);
  }
  window.addEventListener('popstate', onPopState);
  var swipe = null;
  //   ★LINE の「下へスワイプで最小化」に動きを渡しにくくする（2026-11-05 オーナー：上から下へのスクロールで閉じる）
  //     画面の中身は常に2px長くしてあり（.k-wrap の min-height）、触った瞬間に端にいたら1px内側へ寄せる＝引き下げを画面の中で受け止める。
  //     LINE 側の仕様なので完全には止められない（実機で効き方を確かめる）
  function edgeNudge() {
    var r = cur.root; if (!r) return;
    var max = r.scrollHeight - r.clientHeight;
    if (max < 2) return;
    if (r.scrollTop <= 0) r.scrollTop = 1;
    else if (r.scrollTop >= max) r.scrollTop = max - 1;
  }
  function onTouchStart(e) {
    edgeNudge();
    scrollFix.gen++;   // 指で触ったら、残っているスクロールの当て直しをやめる
    if (kb.on || !e.touches || e.touches.length !== 1) { swipe = null; return; }
    var t = e.touches[0], tg = e.target;
    //   左端20pxは端末（iPhone）の戻るに任せる。入力欄・横に並ぶ選択肢・グラフ・セットの行の上では反応しない
    if (t.clientX < 20 || (tg && tg.closest && tg.closest('input,textarea,select,button,a,svg,.k-pills,.k-seg,.k-setrow,.k-accessory'))) { swipe = null; return; }
    swipe = { x: t.clientX, y: t.clientY, at: Date.now() };
  }
  function onTouchEnd(e) {
    if (!swipe || !e.changedTouches || !e.changedTouches.length) { swipe = null; return; }
    var t = e.changedTouches[0], dx = t.clientX - swipe.x, dy = t.clientY - swipe.y, dt = Date.now() - swipe.at;
    swipe = null;
    if (dt > 700 || Math.abs(dx) < 80 || Math.abs(dy) > 50 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (dx > 0) { if (navState()) history.back(); }
    else { try { history.forward(); } catch (er) {} }   // 右→左は進む（2026-11-05 オーナー確認：左→右＝戻る・右→左＝進む で統一）
  }
  function onDirty(e) {
    var t = e.target;
    if (t && t.closest && t.closest('.k-setrow,.k-setnote,.k-picker-go')) return;   // トレーニングの記録は端末の下書きがあるので確かめない
    if (t && t.closest && t.closest('[data-nodirty]')) return;
    cur.dirty = true;
  }

  function ensureRoot() {
    ensureStyle();
    if (cur.root) return cur.root;
    var root = el('div', { id: 'karteRoot' });
    document.body.appendChild(root);
    cur.root = root;
    document.documentElement.classList.add('karte-open');   // 後ろの予約画面がつられて動かないように
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('touchstart', onTouchStart, { passive: true });
    root.addEventListener('touchend', onTouchEnd, { passive: true });
    root.addEventListener('input', onDirty);
    root.addEventListener('scroll', onRootScroll, { passive: true });
    if (window.visualViewport) { window.visualViewport.addEventListener('resize', fitViewport); window.visualViewport.addEventListener('scroll', fitViewport); }
    window.addEventListener('resize', fitViewport);
    fitNow();
    return root;
  }
  function close() {
    restStop();
    if (window.visualViewport) { window.visualViewport.removeEventListener('resize', fitViewport); window.visualViewport.removeEventListener('scroll', fitViewport); }
    window.removeEventListener('resize', fitViewport);
    document.documentElement.classList.remove('karte-open');
    kb.on = false; kb.base = 0; kb.w = 0; kb.resampleUntil = 0; kb.lastInput = null;
    if (kb.revealT) { clearTimeout(kb.revealT); kb.revealT = 0; }
    if (scrollSave.t) { clearTimeout(scrollSave.t); scrollSave.t = 0; }
    scrollFix.gen++;
    if (cur.root) { cur.root.remove(); cur.root = null; }
  }

  function open(customerId, name, tab, draft, mode) {
    restStop();   // ★画面を移ったら休憩タイマーは消す（設計33 §9-7）
    navPush({ cid: String(customerId || ''), tab: tab || 'summary' }, mode);
    cur.dirty = false;
    var same = cur.customerId === String(customerId || '');
    cur.customerId = String(customerId || ''); cur.name = String(name || ''); cur.tab = tab || 'summary';
    if (!same) cur.summary = null;
    var root = ensureRoot(); root.innerHTML = ''; root.classList.remove('k-entry');
    var wrap = el('div', { class: 'k-wrap' });
    var meta = el('div', { class: 'k-meta' });
    var chips = el('div', { class: 'k-chips' });
    var head = el('div', { class: 'k-head' }, [
      el('div', { class: 'k-head-row' }, [
        el('button', { class: 'k-back', 'aria-label': 'カルテを閉じる', text: '←', onclick: exitKarte }),
        el('div', { style: 'flex:1;min-width:0;' }, [(cur.headName = el('div', { class: 'k-name', text: cur.name ? cur.name + ' 様' : '' })), meta])
      ]), chips
    ]);
    var tabs = el('div', { class: 'k-tabs', role: 'tablist' });
    TABS.forEach(function (t) {
      tabs.appendChild(el('button', { class: 'k-tab' + (t[0] === cur.tab ? ' on' : ''), role: 'tab', text: t[1],
        onclick: function () { open(cur.customerId, cur.name, t[0]); } }));
    });
    var body = el('div', { class: 'k-body' });
    wrap.appendChild(head); wrap.appendChild(body); wrap.appendChild(tabs);   // タブは下（モックと同じ）
    root.appendChild(wrap);
    cur.body = body; cur.headMeta = meta; cur.headChips = chips;
    fillHead();
    if (!cur.summary && !cur.name) loadSummary();
    ({ summary: tabSummary, body: tabBody, training: tabTraining, notes: tabNotes, contract: tabContract })[cur.tab](body, draft);
  }
  //   見出しの補足（概要を一度読めば埋まる）
  function fillHead() {
    var s = cur.summary; if (!s || !cur.headMeta) return;
    var c = s.customer || {};
    if (!cur.name && c.name) { cur.name = String(c.name); if (cur.headName) cur.headName.textContent = cur.name + ' 様'; }
    cur.headMeta.textContent = (c.age != null ? c.age + '歳 ／ ' : '') + (c.trainerId ? '担当 ' + trainerName(c.trainerId) : '担当なし');
    cur.headChips.innerHTML = '';
    cur.headChips.appendChild(el('span', { class: 'k-chip-h', text: s.nextReservation ? '次回 ' + fmtDate(s.nextReservation.startAt) : '次回の予約なし' }));
    if (s.consent && s.consent.state !== 'agreed') cur.headChips.appendChild(el('span', { class: 'k-chip-h', text: '同意待ち' }));
  }
  function loadSummary() {
    if (cur.summary) return Promise.resolve(cur.summary);
    var askedFor = cur.customerId;   // ★応答が来たときに別の顧客を開いていたら、見出しにも控えにも入れない
    return kRead('k_summary', { customerId: askedFor }).then(function (r) { if (cur.customerId !== askedFor) return r; if (r && r.success) { cur.summary = r; fillHead(); } return r; });
  }

  // ---------------------------------------------------------------- 身体図（数値と固定の文字だけ）
  function painColor(level) { return level >= 7 ? '#8e3b34' : (level >= 4 ? '#b8603f' : '#d9a066'); }
  function bodyFigure(pain, side, size) {
    var w = size || 110, h = Math.round(w * 200 / 120);
    var s = sv('svg', { viewBox: '0 0 120 200', width: w, height: h, role: 'img' });
    var names = [];
    var fill = '#eceae4', line = '#cfccc4';
    s.appendChild(sv('circle', { cx: 60, cy: 22, r: 16, fill: fill, stroke: line }));
    s.appendChild(sv('rect', { x: 34, y: 44, width: 52, height: 66, rx: 14, fill: fill, stroke: line }));
    s.appendChild(sv('rect', { x: 14, y: 48, width: 16, height: 60, rx: 8, fill: fill, stroke: line }));
    s.appendChild(sv('rect', { x: 90, y: 48, width: 16, height: 60, rx: 8, fill: fill, stroke: line }));
    s.appendChild(sv('rect', { x: 38, y: 112, width: 20, height: 80, rx: 9, fill: fill, stroke: line }));
    s.appendChild(sv('rect', { x: 62, y: 112, width: 20, height: 80, rx: 9, fill: fill, stroke: line }));
    (pain || []).forEach(function (p) {
      var pos = REGION_POS[p.region];
      if (!pos || pos[0] !== side) return;
      var lv = Number(p.level) || 0;
      s.appendChild(sv('circle', { cx: pos[1], cy: pos[2], r: 11, fill: painColor(lv), opacity: 0.9 }));
      s.appendChild(sv('text', { x: pos[1], y: pos[2] + 4.5, 'text-anchor': 'middle', 'font-size': 12, 'font-weight': 700, fill: lv >= 4 ? '#ffffff' : '#1c1f26' }, lv));
      names.push(label(REGIONS, p.region) + ' ' + lv);
    });
    s.setAttribute('aria-label', (side === 'f' ? '身体図（前）' : '身体図（後ろ）') + (names.length ? '：' + names.join('・') : '：記録なし'));
    return s;
  }
  function ring(pct, text, size) {
    var z = size || 64, r = z / 2 - 5, c = 2 * Math.PI * r, p = Math.max(0, Math.min(1, Number(pct) || 0));
    var s = sv('svg', { viewBox: '0 0 ' + z + ' ' + z, width: z, height: z, role: 'img', 'aria-label': text });
    s.appendChild(sv('circle', { cx: z / 2, cy: z / 2, r: r, fill: 'none', stroke: '#edf2fb', 'stroke-width': 8 }));
    s.appendChild(sv('circle', { cx: z / 2, cy: z / 2, r: r, fill: 'none', stroke: '#243b66', 'stroke-width': 8, 'stroke-linecap': 'round',
      'stroke-dasharray': (c * p).toFixed(1) + ' ' + c.toFixed(1), transform: 'rotate(-90 ' + z / 2 + ' ' + z / 2 + ')' }));
    s.appendChild(sv('text', { x: z / 2, y: z / 2 + 5, 'text-anchor': 'middle', 'font-size': Math.round(z / 4.4), 'font-weight': 700, fill: '#1c1f26' }, text));
    return s;
  }

  // ---------------------------------------------------------------- 概要
  function tabSummary(box, draft) {
    if (draft && draft.kind === 'sub' && draft.sub === 'mpreview') { memberPreviewSub(box, draft.navMode); return; }   // 戻る・進む・送り直しの画面から
    box.appendChild(msg('読み込み中…'));
    cur.summary = null;
    Promise.all([loadSummary(), kRead('k_body', { customerId: cur.customerId })]).then(function (rs) {
      var r = rs[0], b = rs[1];
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      var hearing = (r.profile && r.profile.hearing) || {};
      var latest = latestBody(b && b.success && b.ready ? b.rows : []);

      //   ★概要は読むだけ（2026-11-05 オーナー承認の整理案）。書く・記録する操作は各カードの右上のリンクの先と「契約・会員」タブへ
      //   並び：注意すること → 目標と進み具合 → 直近の指導 → お客様のこと
      var agreed = r.consent && r.consent.state === 'agreed';
      var sb = r.safetyBrief;
      var caut = el('div', { class: 'k-caution' }, [headRow('注意すること', agreed ? '編集 ›' : null, function () { safetyForm(box); })]);
      if (agreed) {
        var pain = (sb && sb.pain) || [];
        if (pain.length || (sb && (sb.restrictions || sb.painSites || sb.diagnosis || sb.medication))) {
          var row = el('div', { style: 'display:flex;gap:12px;align-items:flex-start;' });
          if (pain.length) row.appendChild(el('div', { style: 'display:flex;gap:2px;' }, [bodyFigure(pain, 'f', 64), bodyFigure(pain, 'b', 64)]));
          var txt = el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:4px;font-size:14px;line-height:1.6;' });
          pain.forEach(function (p) { txt.appendChild(el('div', { text: label(REGIONS, p.region) + ' ' + p.level + '/10' + (p.symptom ? '（' + p.symptom + '）' : '') })); });
          if (sb.restrictions) txt.appendChild(el('div', { text: '運動制限：' + sb.restrictions }));
          if (sb.painSites && !pain.length) txt.appendChild(el('div', { text: '痛む部位：' + sb.painSites }));
          txt.appendChild(el('div', { class: 'k-sub', text: '医師の診断：' + (sb.diagnosis || 'なし') + ' ／ 服薬：' + (sb.medication || 'なし') }));
          row.appendChild(txt); caut.appendChild(row);
        } else caut.appendChild(msg('記録はまだありません。'));
      } else {
        caut.appendChild(msg(r.consent && r.consent.state === 'revoked' ? '同意が撤回されています（健康情報は記録できません）。' : '同意待ち：入会時の同意書でカルテでの健康情報の管理に同意をもらってから記録できます。'));
        //   同意の記録は「契約・会員」タブの末尾（管理）へ移した。初回に迷わないよう、ここから直接行けるようにする
        caut.appendChild(el('button', { type: 'button', class: 'k-btn out small', style: 'margin-top:6px;', text: '同意を記録する（契約・会員へ）›', onclick: function () { open(cur.customerId, cur.name, 'contract'); } }));
      }
      box.appendChild(caut);

      //   目標と進み具合（モック K1：進み具合の輪＋いま／目標／期日）
      var p = r.profile || {};
      var wRows = (b && b.success && b.ready ? b.rows : []).filter(function (x) { return x.w != null; }).sort(function (x, y) { return x.d < y.d ? -1 : 1; });
      var wFirst = wRows.length ? wRows[0].w : null, wNow = latest.w != null ? latest.w : null, wTarget = hearing.targetWeight != null && hearing.targetWeight !== '' ? Number(hearing.targetWeight) : null;
      var pct = (wFirst != null && wNow != null && wTarget != null) ? (wFirst === wTarget ? 1 : Math.max(0, Math.min(1, (wFirst - wNow) / (wFirst - wTarget)))) : null;
      var dl = p.goal_deadline ? Math.ceil((Date.parse(p.goal_deadline) - Date.parse(today())) / 86400000) : null;
      function col(name, big, small) { return el('div', {}, [el('div', { class: 'k-sub', text: name }), el('div', { class: 'k-num', style: 'font-size:16px;', text: big }), el('div', { class: 'k-sub', text: small })]); }
      var goalCard = el('div', { class: 'k-card' }, [headRow('目標と進み具合', '体組成へ ›', function () { open(cur.customerId, cur.name, 'body'); }),
        el('div', { style: 'display:flex;gap:14px;align-items:center;' }, [
          pct != null ? ring(pct, Math.round(pct * 100) + '%', 60) : el('div', { class: 'k-sub', style: 'width:60px;text-align:center;', text: '目標 未設定' }),
          el('div', { class: 'k-grid3', style: 'flex:1;font-size:12px;' }, [
            col('いま', wNow != null ? String(wNow) : '—', 'kg'),
            col('目標', wTarget != null ? String(wTarget) : '—', 'kg'),
            col('期日', p.goal_deadline ? md(p.goal_deadline) : '—', dl == null ? '' : (dl >= 0 ? 'あと' + dl + '日' : '期日を過ぎています'))])])]);
      box.appendChild(goalCard);

      //   直近の指導（モック K1：日付つきの見出し・本文・ゴールドの印）
      if (r.lastNote) {
        var ln = r.lastNote, lnTags = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
        if (ln.tag) lnTags.appendChild(el('span', { class: 'k-gtag', text: label(TAGS, ln.tag) }));
        if (ln.condition) lnTags.appendChild(el('span', { class: 'k-gtag', text: '体調：' + (COND[ln.condition] || ln.condition) }));
        var lnKids = [headRow('直近の指導（' + md(ln.session_date) + '）', '指導の履歴へ ›', function () { open(cur.customerId, cur.name, 'notes'); })];
        if (ln.body) lnKids.push(el('div', { style: 'white-space:pre-wrap;font-size:14px;line-height:1.7;', text: ln.body }));
        if (ln.next_plan) lnKids.push(el('div', { class: 'k-sub', style: 'font-size:13px;', text: '次回：' + ln.next_plan }));
        if (lnTags.children.length) lnKids.push(lnTags);
        box.appendChild(el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:8px;' }, lnKids));
      }

      //   お客様のこと（モック K1：目的の印＋やる気 n/10・2列の表）
      var hasHearing = !!(r.profile && r.profile.hearing);
      var who = el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:10px;' }, [headRow('お客様のこと', hasHearing ? 'ヒアリングを編集 ›' : 'ヒアリングを記入する ›', function () { hearingForm(box, r, null); })]);
      var pc = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;align-items:center;' });
      (hearing.purposes || []).forEach(function (k) { pc.appendChild(el('span', { class: 'k-tag', style: 'font-size:12px;padding:4px 10px;border-radius:999px;', text: label(PURPOSES, k) })); });
      if (!(hearing.purposes || []).length) pc.appendChild(el('span', { class: 'k-sub', text: '目的は未記入' }));
      pc.appendChild(el('span', { class: 'k-sub', style: 'padding:4px;', text: hearing.motivation ? 'やる気 ' + hearing.motivation + '/10' : 'やる気 未記入' }));
      who.appendChild(pc);
      var rowsW = [['引き締めたい部位', (hearing.slimAreas || []).map(function (k) { return label(SLIM_AREAS, k); }).join('・')], ['いまの運動', hearing.exerciseNow], ['睡眠', hearing.sleep], ['食事', hearing.meals], ['過去の経験', hearing.exercisePast]].filter(function (x) { return x[1]; });
      if (rowsW.length) {
        var lg = el('div', { class: 'k-grid2', style: 'font-size:13px;gap:8px;' });
        rowsW.forEach(function (x) { lg.appendChild(el('div', {}, [el('div', { style: 'font-size:11px;color:var(--k-sub);', text: x[0] }), el('div', { text: x[1] })])); });
        who.appendChild(lg);
      }
      if (p.goal_text) who.appendChild(el('div', { style: 'font-size:13px;line-height:1.7;background:var(--k-cream);border-radius:10px;padding:10px 12px;', text: '理想：' + p.goal_text }));
      box.appendChild(who);
      //   お客様の見え方（設計35 C2）：会員の画面と同じ部品で、このお客様の画面を出す。★オーナーは会員として開けないので、確かめるのはここ
      box.appendChild(el('button', { type: 'button', class: 'k-btn out', text: 'お客様の見え方', 'aria-label': 'お客様の画面での見え方を確かめる', onclick: function () { memberPreviewSub(box); } }));
      if (draft && draft.kind === 'profile') hearingForm(box, r, draft.data, draft.navMode);
      else if (draft && draft.kind === 'sub' && draft.sub === 'hearing') hearingForm(box, r, null, draft.navMode);
      else if (draft && draft.kind === 'sub' && draft.sub === 'safety' && agreed) safetyForm(box, draft.navMode);
    });
  }
  function goalCol(name, now, target, unit) {
    var rest = (now != null && target != null) ? r1(Math.abs(now - target)) : null;
    return el('div', {}, [el('div', { class: 'k-sub', text: name }),
      el('div', { class: 'k-num', style: 'font-size:20px;margin-top:4px;', text: now != null ? String(now) + unit : '—' }),
      el('div', { class: 'k-sub', text: target != null ? '→ ' + target + unit : '目標 未設定' }),
      el('div', { style: 'font-size:12px;font-weight:700;color:var(--k-acc);margin-top:4px;', text: rest != null ? 'あと ' + rest + unit : '' })]);
  }

  function consentRow(consent) {
    var row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;' });
    var state0 = consent ? consent.state : 'none';
    function rec(stateTo, method) {
      var lbl = stateTo === 'agreed' ? '同意を記録しますか？（' + (method === 'paper' ? '紙の同意書' : 'LINE') + '）' : '同意の撤回を記録しますか？\n★記録済みの健康情報は削除され、元に戻せません。';
      if (!window.confirm(lbl)) return;
      kWrite('k_saveConsent', { customerId: cur.customerId, state: stateTo, method: method }, newReqId()).then(function (r) {
        if (!r || !r.success) { window.alert(errText(r)); return; }
        open(cur.customerId, cur.name, cur.tab, null, 'replace');   // 記録した画面（契約・会員）に留まる
      });
    }
    if (state0 !== 'agreed') {
      row.appendChild(el('button', { class: 'k-btn out small', text: '同意を記録（紙）', onclick: function () { rec('agreed', 'paper'); } }));
      row.appendChild(el('button', { class: 'k-btn out small', text: '同意を記録（LINE）', onclick: function () { rec('agreed', 'line'); } }));
    } else {
      row.appendChild(el('button', { class: 'k-btn out small k-danger', text: '撤回を記録', onclick: function () { rec('revoked', null); } }));
    }
    return row;
  }

  function field(lbl, val, type, attrs) {
    var i = el(type === 'area' ? 'textarea' : 'input', type === 'area' ? { rows: '3' } : { type: type || 'text' });
    if (attrs) for (var k in attrs) i.setAttribute(k, attrs[k]);
    if (val != null && val !== '') i.value = val;
    if (type === 'number') { i.inputMode = 'decimal'; i.step = 'any'; }
    return { row: el('label', { class: 'k-field' }, [el('span', { text: lbl }), i]), get: function () { return i.value.trim(); }, el: i };
  }
  function pills(tbl, selected, opts) {
    var o = opts || {}, sel = (selected || []).slice();
    var box = el('div', { class: 'k-pills' });
    var btns = {};
    function paint() {
      tbl.forEach(function (t) {
        var i = sel.indexOf(t[0]);
        btns[t[0]].className = 'k-pill' + (i >= 0 ? ' on' : '');
        btns[t[0]].textContent = (o.ordered && i >= 0 ? (i + 1) + ' ' : '') + t[1];
        btns[t[0]].setAttribute('aria-pressed', i >= 0 ? 'true' : 'false');
      });
    }
    tbl.forEach(function (t) {
      btns[t[0]] = el('button', { type: 'button', onclick: function () {
        cur.dirty = true;
        var i = sel.indexOf(t[0]);
        if (i >= 0) sel.splice(i, 1);
        else if (!o.max || sel.length < o.max) sel.push(t[0]);
        if (o.single) sel = i >= 0 ? [] : [t[0]];
        paint();
      } });
      box.appendChild(btns[t[0]]);
    });
    paint();
    return { el: box, get: function () { return sel.slice(); } };
  }
  function scale(val) {
    var v = val || null;
    var box = el('div', { style: 'display:grid;grid-template-columns:repeat(10,minmax(0,1fr));gap:3px;' });
    var bs = [];
    for (var n = 1; n <= 10; n++) (function (n) {
      var b = el('button', { type: 'button', style: 'min-height:38px;border-radius:6px;font-size:13px;font-family:inherit;', text: String(n), onclick: function () { cur.dirty = true; v = (v === n ? null : n); paint(); } });
      bs.push(b); box.appendChild(b);
    })(n);
    function paint() { bs.forEach(function (b, i) { var on = v === i + 1; b.style.cssText = 'min-height:38px;border-radius:6px;font-size:13px;font-family:inherit;border:' + (on ? '2px solid #243b66;background:#243b66;color:#fff;font-weight:700' : '1px solid #8692a6;background:#fff;color:#1c1f26'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
    paint();
    return { el: box, get: function () { return v; } };
  }

  // ---------------------------------------------------------------- ヒアリング入力
  function hearingForm(box, r, draftData, mode) {
    navPush({ cid: cur.customerId, tab: 'summary', sub: 'hearing' }, mode);
    box.innerHTML = '';
    var p = r.profile || {}, h = draftData ? draftData.hearing || {} : (p.hearing || {});
    var purposes = pills(PURPOSES, h.purposes);
    var slim = pills(SLIM_AREAS, h.slimAreas, { max: 3, ordered: true });
    var mot = scale(h.motivation);
    var tw = field('目標体重 kg', h.targetWeight, 'number'), tf = field('目標体脂肪率 %', h.targetFat, 'number');
    var dl = field('期日', draftData ? draftData.goalDeadline : p.goal_deadline, 'date');
    var ideal = field('理想の姿（本人の言葉で）', draftData ? draftData.goalText : p.goal_text, 'area', { maxlength: '500' });
    var now = field('いまの運動', h.exerciseNow, 'text', { maxlength: '100' }), past = field('過去の経験', h.exercisePast, 'text', { maxlength: '100' });
    var sleep = field('睡眠', h.sleep, 'text', { maxlength: '100' }), meals = field('食事', h.meals, 'text', { maxlength: '100' });
    box.appendChild(card('目的（いくつでも）', [purposes.el]));
    box.appendChild(card('引き締めたい部位（上位3つまで・押した順）', [slim.el]));
    var tg = el('div', { class: 'k-grid2' }, [tw.row, tf.row]);
    box.appendChild(card('目標', [tg, dl.row, ideal.row, el('div', { class: 'k-sub', style: 'margin-bottom:6px;', text: 'やる気（10段階）' }), mot.el]));
    box.appendChild(card('運動と生活', [el('div', { class: 'k-note-hint', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }), el('div', { class: 'k-grid2' }, [now.row, past.row, sleep.row, meals.row])]));
    var reqId = newReqId();
    function collect() {
      var num = function (s) { return s === '' ? null : Number(s); };
      return { goalText: ideal.get(), goalDeadline: dl.get(), hearing: { purposes: purposes.get(), slimAreas: slim.get(), motivation: mot.get(),
        targetWeight: num(tw.get()), targetFat: num(tf.get()), exerciseNow: now.get(), exercisePast: past.get(), sleep: sleep.get(), meals: meals.get() } };
    }
    box.appendChild(el('button', { class: 'k-btn', text: 'ヒアリングを保存', onclick: function () {
      var data = collect();
      if ((data.hearing.targetWeight != null && !(data.hearing.targetWeight >= 20 && data.hearing.targetWeight <= 250))
          || (data.hearing.targetFat != null && !(data.hearing.targetFat >= 3 && data.hearing.targetFat <= 60))) { window.alert('目標の数値を確認してください。'); return; }
      if (!schemaOk(r)) { window.alert(SCHEMA_MSG); return; }
      var params = { customerId: cur.customerId, rev: r.profile ? r.profile.rev : 0, goalText: data.goalText, goalDeadline: data.goalDeadline, hearing: data.hearing };
      kWrite('k_saveProfile', params, reqId, { kind: 'profile', data: data }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('保存しました。'); open(cur.customerId, cur.name, 'summary', null, 'replace');
      });
    } }));
    box.appendChild(el('button', { class: 'k-btn out', text: '戻る', onclick: function () { goBack(); } }));
  }

  // ---------------------------------------------------------------- 安全面（健康情報・端末に退避しない）
  function safetyForm(box, mode) {
    navPush({ cid: cur.customerId, tab: 'summary', sub: 'safety' }, mode);
    box.innerHTML = ''; box.appendChild(msg('読み込み中…'));
    kRead('k_safety', { customerId: cur.customerId }).then(function (r) {
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      if (r.consent !== 'agreed') { box.appendChild(msg('同意が無いため、健康情報は表示・記録できません。', true)); return; }
      var s = r.safety || {};
      var pain = (s.pain || []).map(function (x) { return { region: x.region, level: x.level, symptom: x.symptom || '' }; });
      var figs = el('div', { style: 'display:flex;gap:12px;justify-content:center;' });
      var list = el('div', { style: 'display:flex;flex-direction:column;gap:8px;margin-top:10px;' });
      var editor = el('div');
      function redraw() {
        figs.innerHTML = '';
        figs.appendChild(el('div', { style: 'text-align:center;' }, [bodyFigure(pain, 'f', 110), el('div', { class: 'k-sub', text: '前' })]));
        figs.appendChild(el('div', { style: 'text-align:center;' }, [bodyFigure(pain, 'b', 110), el('div', { class: 'k-sub', text: '後ろ' })]));
        list.innerHTML = '';
        pain.forEach(function (p, i) {
          list.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;font-size:14px;' }, [
            el('span', { style: 'flex:1;min-width:0;', text: label(REGIONS, p.region) + ' ' + p.level + '/10' + (p.symptom ? '（' + p.symptom + '）' : '') }),
            el('button', { type: 'button', class: 'k-btn out small', text: '直す', onclick: function () { edit(p.region); } }),
            el('button', { type: 'button', class: 'k-btn out small k-danger', text: '外す', onclick: function () { cur.dirty = true; pain.splice(i, 1); redraw(); } })]));
        });
      }
      function edit(region) {
        editor.innerHTML = '';
        var ex = null; pain.forEach(function (p) { if (p.region === region) ex = p; });
        var lv = scale(ex ? ex.level : null);
        var sy = field('症状（80字まで）', ex ? ex.symptom : '', 'text', { maxlength: '80' });
        editor.appendChild(el('div', { class: 'k-caution', style: 'margin-top:10px;' }, [el('div', { class: 'k-h', text: label(REGIONS, region) + ' の強さ' }), lv.el, el('div', { style: 'height:8px;' }), sy.row,
          el('button', { type: 'button', class: 'k-btn small', text: 'この部位を入れる', onclick: function () {
            if (!lv.get()) { window.alert('強さを選んでください。'); return; }
            cur.dirty = true;
            var item = { region: region, level: lv.get(), symptom: sy.get() };
            var done = false; pain.forEach(function (p, i) { if (p.region === region) { pain[i] = item; done = true; } });
            if (!done) { if (pain.length >= 12) { window.alert('部位は12か所までです。'); return; } pain.push(item); }
            editor.innerHTML = ''; redraw();
          } })]));
      }
      var pick = el('div', { class: 'k-pills', style: 'margin-top:10px;' });
      REGIONS.forEach(function (t) { pick.appendChild(el('button', { type: 'button', class: 'k-pill', text: t[1], onclick: function () { edit(t[0]); } })); });
      var f = { conditions: field('既往歴', s.conditions, 'area', { maxlength: '500' }), injuries: field('ケガ', s.injuries, 'area', { maxlength: '500' }),
                diagnosis: field('医師の診断', s.diagnosis, 'area', { maxlength: '500' }), medication: field('服薬', s.medication, 'area', { maxlength: '500' }),
                restrictions: field('運動制限', s.restrictions, 'area', { maxlength: '500' }), painSites: field('痛む部位（自由記入・旧欄）', s.pain_sites, 'area', { maxlength: '500' }) };
      box.appendChild(card('痛み・不調', [msg('部位を選び、強さを 1〜10 で入れます。ここに入れた内容は概要の一番上に出ます（トレーナー全員が読めます）。'), figs, list, pick, editor]));
      var c2 = card('健康の情報', []);
      for (var k in f) c2.appendChild(f[k].row);
      box.appendChild(c2);
      redraw();
      var reqId = newReqId();
      box.appendChild(el('button', { class: 'k-btn', text: '保存する', onclick: function () {
        if (!schemaOk(r)) { window.alert(SCHEMA_MSG); return; }
        var params = { customerId: cur.customerId, rev: r.safety ? r.safety.rev : 0,
          painMap: pain.map(function (p) { return { region: p.region, level: p.level, symptom: p.symptom || null }; }) };
        for (var k in f) params[k] = f[k].get();
        //   ★安全面は端末に退避しない（健康情報を sessionStorage に残さない）
        kWrite('k_saveSafety', params, reqId, null).then(function (w) {
          if (!w || !w.success) { window.alert(errText(w)); return; }
          window.alert('保存しました。'); open(cur.customerId, cur.name, 'summary', null, 'replace');
        });
      } }));
      box.appendChild(el('button', { class: 'k-btn out', text: '戻る', onclick: function () { goBack(); } }));
    });
  }

  function membershipCard() {
    var d = field('発効日', today(), 'date'); d.el.max = today();
    function rec(kind) {
      if (!window.confirm((kind === 'withdrawn' ? '退会' : '再入会') + '（' + d.get() + '）を記録しますか？')) return;
      kWrite('k_recordMembership', { customerId: cur.customerId, kind: kind, effectiveDate: d.get() }, newReqId()).then(function (r) {
        window.alert(r && r.success ? '記録しました。' : errText(r));
      });
    }
    return el('div', { style: 'border-top:1px solid #dde3eb;padding-top:12px;' }, [el('div', { style: 'font-size:14px;font-weight:700;margin-bottom:6px;', text: '退会・再入会の記録' }), msg('退会後3年の保存期間の起算日になります。契約の期限切れとは別に、退会が決まったときだけ記録してください。'), d.row,
      el('div', { style: 'display:flex;gap:6px;' }, [
        el('button', { class: 'k-btn out small', style: 'flex:1;', text: '退会を記録', onclick: function () { rec('withdrawn'); } }),
        el('button', { class: 'k-btn out small', style: 'flex:1;', text: '再入会を記録', onclick: function () { rec('rejoined'); } })])]);
  }

  // ---------------------------------------------------------------- 体組成
  function latestBody(rows) {
    var out = {};
    (rows || []).slice().sort(function (a, b) { return a.d < b.d ? -1 : 1; }).forEach(function (x) { METRICS.concat([['lean']]).forEach(function (m) { if (x[m[0]] != null) out[m[0]] = x[m[0]]; }); });
    return out;
  }
  /** 値のある記録の、最後の2つ（前回比） */
  function lastTwo(rows, key) {
    var v = (rows || []).filter(function (x) { return x[key] != null; }).sort(function (a, b) { return a.d < b.d ? -1 : 1; });
    return { first: v[0] || null, prev: v.length >= 2 ? v[v.length - 2] : null, last: v[v.length - 1] || null, n: v.length };
  }
  /**
   * 見立ての一言（規則で決める・断定しない・設計31）。記録2件未満は null
   *   返り値 { kind:'good'|'reverse'|'slow'|'mixed', text }
   */
  function assess(rows, purposes) {
    var w = lastTwo(rows, 'w'), f = lastTwo(rows, 'pbf'), m = lastTwo(rows, 'smm');
    if (!w.prev && !f.prev) return null;
    var dw = w.prev ? w.last.w - w.prev.w : 0, df = f.prev ? f.last.pbf - f.prev.pbf : 0, dm = m.prev ? m.last.smm - m.prev.smm : 0;
    var lose = (purposes || []).some(function (k) { return k === 'diet' || k === 'bodymake'; });
    if (Math.abs(dw) < 0.3 && Math.abs(df) < 0.3) return { kind: 'slow', text: '前回からの変化はゆるやかです。食事・運動・生活のうち、続けやすい点を一つ決めて次回まで試してみましょう。' };
    if (lose && dw > 0 && df > 0) return { kind: 'reverse', text: '目的とは逆の動きが見られます。下の「変化の理由を確かめる」で食事・運動・生活を整理し、次回の方針を決めましょう。' };
    if (dw <= 0 && df <= 0 && !(dm < -0.2)) return { kind: 'good', text: '体重と体脂肪率が下がり、骨格筋量は保てています。いまの進め方で良さそうです。次回も同じ時間帯に測ると比べやすくなります。' };
    return { kind: 'mixed', text: '指標によって動きが分かれています。測る時間帯や前日の食事でも変わるため、次回の測定と合わせて見ていきましょう。' };
  }

  function lineChart(points, goalPts, unit) {
    var pts = (points || []).filter(function (p) { return p.v != null; });
    if (pts.length < 1) return msg('まだ記録がありません。');
    var W = 320, H = 160, P = 28;
    var all = pts.map(function (p) { return p.v; }).concat((goalPts || []).map(function (g) { return g.v; }));
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var dates = pts.map(function (p) { return p.d; }).concat((goalPts || []).map(function (g) { return g.d; })).sort();
    var t0 = Date.parse(dates[0]), t1 = Date.parse(dates[dates.length - 1]); if (t1 === t0) t1 = t0 + 86400000;
    function x(d) { return P + (W - P * 2) * (Date.parse(d) - t0) / (t1 - t0); }
    function y(v) { return H - P + 10 - (H - P * 2 + 10) * (v - lo) / (hi - lo); }
    var s = sv('svg', { viewBox: '0 0 ' + W + ' ' + H, width: '100%', role: 'img', 'aria-label': '推移 ' + pts[0].v + unit + ' から ' + pts[pts.length - 1].v + unit });
    [0.25, 0.5, 0.75].forEach(function (r) { s.appendChild(sv('line', { x1: P, x2: W - 4, y1: (H * r).toFixed(1), y2: (H * r).toFixed(1), stroke: '#eceae4' })); });
    if (goalPts && goalPts.length >= 2) s.appendChild(sv('polyline', { fill: 'none', stroke: '#b8965a', 'stroke-dasharray': '5 4', 'stroke-width': 1.5,
      points: goalPts.map(function (g) { return x(g.d).toFixed(1) + ',' + y(g.v).toFixed(1); }).join(' ') }));
    s.appendChild(sv('polyline', { fill: 'none', stroke: '#243b66', 'stroke-width': 2.2, 'stroke-linejoin': 'round', points: pts.map(function (p) { return x(p.d).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ') }));
    pts.forEach(function (p) {
      //   ● 本人の記録 ○ InBody
      s.appendChild(sv('circle', p.src === 'i' ? { cx: x(p.d).toFixed(1), cy: y(p.v).toFixed(1), r: 3.6, fill: '#ffffff', stroke: '#243b66', 'stroke-width': 2 }
        : { cx: x(p.d).toFixed(1), cy: y(p.v).toFixed(1), r: 3.2, fill: '#243b66' }));
    });
    s.appendChild(sv('text', { x: 2, y: 12, 'font-size': 10, fill: '#5d574e' }, hi.toFixed(1)));
    s.appendChild(sv('text', { x: 2, y: H - 4, 'font-size': 10, fill: '#5d574e' }, lo.toFixed(1)));
    s.appendChild(sv('text', { x: P, y: H - 2, 'font-size': 10, fill: '#5d574e' }, md(dates[0])));
    s.appendChild(sv('text', { x: W - 34, y: H - 2, 'font-size': 10, fill: '#5d574e' }, md(dates[dates.length - 1])));
    return s;
  }

  function delta(now, prev, unit, lowerIsGood) {
    if (now == null || prev == null) return el('div', { class: 'k-sub', text: '前回比 —' });
    var d = r1(now - prev);
    if (Math.abs(d) < 0.05) return el('div', { class: 'k-sub', text: 'ほぼ同じ' });
    var good = lowerIsGood ? d < 0 : d > 0;
    return el('div', { style: 'font-size:13px;' }, [el('span', { class: good ? 'k-down' : 'k-up', text: (d < 0 ? '▼ ' : '▲ ') + Math.abs(d) + unit }), el('span', { class: 'k-sub', text: ' 前回比' })]);
  }

  function tabBody(box, draft) {
    box.appendChild(msg('読み込み中…'));
    Promise.all([kRead('k_body', { customerId: cur.customerId }), loadSummary()]).then(function (rs) {
      var r = rs[0], s = rs[1];
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      if (!r.ready) { box.appendChild(msg('体組成の記録を読み込めませんでした。しばらくしてから開き直してください（続くときはオーナーへ）。')); return; }
      //   ★書くのは上のボタンから専用の記入画面へ（2026-11-05 整理案）。読み直し後の復元・戻るでも記入画面を開き直す
      if (draft && (draft.kind === 'measure' || (draft.kind === 'sub' && draft.sub === 'measure'))) { measureSub(box, draft.kind === 'measure' ? draft.data : null, draft.navMode); return; }
      box.appendChild(el('button', { class: 'k-btn', text: '＋ 測定を記録', onclick: function () { measureSub(box, null); } }));
      var rows = r.rows || [];
      var hearing = (s && s.success && s.profile && s.profile.hearing) || {};
      var W2 = lastTwo(rows, 'w'), F2 = lastTwo(rows, 'pbf'), M2 = lastTwo(rows, 'smm'), WA = lastTwo(rows, 'waist'), L2 = lastTwo(rows, 'lean');
      var lastD = rows.length ? rows.slice().sort(function (a, b) { return a.d < b.d ? 1 : -1; })[0].d : null;
      box.appendChild(el('div', { class: 'k-sub', text: lastD ? '最新 ' + md(lastD) : '' }));
      function hero(name, t, key, unit) {
        return el('div', { class: 'k-card', style: 'padding:14px;' }, [el('div', { class: 'k-sub', text: name }),
          el('div', { class: 'k-num', style: 'font-size:24px;line-height:1.2;margin-top:4px;', text: t.last ? String(t.last[key]) : '—' }, []),
          el('div', { class: 'k-sub', text: unit }), delta(t.last && t.last[key], t.prev && t.prev[key], unit, true)]);
      }
      function small(name, t, key, unit, lowerIsGood) {
        return el('div', { class: 'k-card', style: 'padding:10px;' }, [el('div', { class: 'k-sub', text: name }),
          el('div', { class: 'k-num', style: 'font-size:16px;margin-top:2px;', text: t.last ? t.last[key] + unit : '—' }),
          delta(t.last && t.last[key], t.prev && t.prev[key], unit, lowerIsGood)]);
      }
      box.appendChild(el('div', { class: 'k-grid2' }, [hero('体重', W2, 'w', 'kg'), hero('体脂肪率', F2, 'pbf', '%')]));
      box.appendChild(el('div', { class: 'k-grid3' }, [small('骨格筋量', M2, 'smm', 'kg', false), small('ウエスト', WA, 'waist', 'cm', true), small('除脂肪量', L2, 'lean', 'kg', false)]));

      //   目標までの進み具合（最初の記録→目標）
      function prog(name, t, key, target, unit) {
        if (target == null || !t.first || !t.last) return null;
        var total = t.first[key] - target, done = t.first[key] - t.last[key];
        var pct = total === 0 ? 1 : Math.max(0, Math.min(1, done / total));
        return el('div', { style: 'display:flex;align-items:center;gap:10px;' }, [ring(pct, Math.round(pct * 100) + '%', 64),
          el('div', { style: 'font-size:12px;line-height:1.6;' }, [el('b', { text: name }), el('br'), document.createTextNode(t.first[key] + ' → ' + target + unit), el('br'),
            el('span', { style: 'color:var(--k-acc);font-weight:700;', text: 'あと ' + r1(Math.abs(t.last[key] - target)) + unit })])]);
      }
      var pw = prog('体重', W2, 'w', hearing.targetWeight, 'kg'), pf = prog('体脂肪率', F2, 'pbf', hearing.targetFat, '%');
      box.appendChild(card('目標までの進み具合', (pw || pf) ? [el('div', { class: 'k-grid2' }, [pw, pf])] : [msg('ヒアリングで目標体重・目標体脂肪率を入れると表示されます。')]));

      //   推移（指標と期間を切り替え）
      var state0 = { m: 'w', days: 90 };
      var chartBox = el('div');
      var segM = el('div', { class: 'k-seg' }), segP = el('div', { class: 'k-seg', style: 'margin-top:10px;' });
      function drawChart() {
        chartBox.innerHTML = '';
        var since = state0.days ? new Date(Date.now() + 9 * 3600000 - state0.days * 86400000).toISOString().slice(0, 10) : '0000';
        var pts = rows.filter(function (x) { return x.d >= since; }).map(function (x) { return { d: x.d, v: x[state0.m] != null ? x[state0.m] : null, src: x.s ? x.s[state0.m] : null }; })
          .sort(function (a, b) { return a.d < b.d ? -1 : 1; });
        var goal = (state0.m === 'w' && r.goal && r.goal.points) ? r.goal.points : null;
        var unit = label(METRICS.map(function (m) { return [m[0], m[2]]; }), state0.m);
        chartBox.appendChild(lineChart(pts, goal, unit));
        Array.prototype.forEach.call(segM.children, function (b, i) { b.className = METRICS[i][0] === state0.m ? 'on' : ''; });
        Array.prototype.forEach.call(segP.children, function (b, i) { b.className = [30, 90, 0][i] === state0.days ? 'on' : ''; });
      }
      METRICS.forEach(function (m) { segM.appendChild(el('button', { type: 'button', text: m[1], onclick: function () { state0.m = m[0]; drawChart(); } })); });
      [[30, '1ヶ月'], [90, '3ヶ月'], [0, '全部']].forEach(function (p) { segP.appendChild(el('button', { type: 'button', text: p[1], onclick: function () { state0.days = p[0]; drawChart(); } })); });
      box.appendChild(card('推移', [segM, chartBox, segP, el('div', { class: 'k-sub', style: 'margin-top:6px;', text: '● 本人の記録　○ InBody　点線＝体重の目標線' })]));
      drawChart();

      var a = assess(rows, hearing.purposes);
      if (a) box.appendChild(el('div', { class: 'k-card', style: 'background:var(--k-acc-l);border-color:#d2ddf0;' }, [
        el('div', { class: 'k-h', text: '前回からの見立て（自動・目安）' }), el('div', { style: 'font-size:14px;line-height:1.75;', text: a.text }),
        el('div', { class: 'k-sub', style: 'margin-top:6px;', text: '※ 数字の動きから出す目安で、診断ではありません。' })]));
      box.appendChild(el('button', { class: 'k-btn out', text: '変化の理由を確かめる（指導の履歴へ）', onclick: function () { open(cur.customerId, cur.name, 'notes', { kind: 'reflect', data: {} }); } }));

      box.appendChild(goalForm(r.goal));
      var hist = card('最近の記録', []);
      (r.raw || []).forEach(function (m) {
        var parts = MEASURE.filter(function (f) { return m[f[0]] != null; }).map(function (f) { return f[1] + ' ' + m[f[0]] + f[2]; });
        var row = el('div', { style: 'display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--k-line);padding:8px 0;font-size:13px;' }, [
          el('div', { style: 'flex:1;min-width:0;', text: md(m.d) + '　' + parts.join('・') })
        ]);
        var mine = m.origin === 'd1' && (String(m.enteredBy) === String(state.trainerId) || state._isOwner);
        if (mine || (state._isOwner && m.origin === 'sheet')) {
          row.appendChild(el('button', { class: 'k-btn out small k-danger', text: '削除', onclick: function () {
            if (!window.confirm(m.d + ' の記録を削除しますか？')) return;
            kWrite('k_deleteMeasurement', { id: m.id, rev: m.rev }, newReqId()).then(function (w) {
              if (!w || !w.success) { window.alert(errText(w)); return; }
              open(cur.customerId, cur.name, 'body', null, 'replace');
            });
          } }));
        }
        hist.appendChild(row);
      });
      if (!(r.raw || []).length) hist.appendChild(msg('まだ記録がありません。'));
      box.appendChild(hist);
    });
  }

  function measureSub(box, draftData, mode) {
    navPush({ cid: cur.customerId, tab: 'body', sub: 'measure' }, mode);
    box.innerHTML = '';
    entryHead('測定を記録', '体組成の画面に戻る');
    box.appendChild(measureForm(draftData));
  }
  function measureForm(draftData) {
    var c = card('InBody・周囲径', [msg('測った項目だけ入れてください。体重と体脂肪率を入れれば除脂肪量は自動で計算します。')]);
    var d = field('測定日', (draftData && draftData.measuredDate) || today(), 'date'); d.el.max = today();
    c.appendChild(d.row);
    var inputs = {};
    var g = el('div', { class: 'k-grid2' });
    MEASURE.forEach(function (f) {
      var fl = field(f[1] + (f[2] ? '（' + f[2] + '）' : ''), draftData && draftData.values ? draftData.values[f[0]] : '', 'number');
      fl.el.step = String(f[3]);
      inputs[f[0]] = fl.el; g.appendChild(fl.row);
    });
    c.appendChild(g);
    var reqId = newReqId();
    var mbar = el('div', { class: 'k-savebar' });
    mbar.appendChild(el('button', { class: 'k-btn', text: '保存する', onclick: function () {
      var values = {}, any = false;
      for (var k in inputs) { var v = inputs[k].value.trim(); if (v !== '') { values[k] = Number(v); any = true; } }
      if (!any) { window.alert('1つ以上入力してください。'); return; }
      kWrite('k_addMeasurement', { customerId: cur.customerId, measuredDate: d.get(), values: values }, reqId, { kind: 'measure', data: { measuredDate: d.get(), values: values } }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('記録しました。'); open(cur.customerId, cur.name, 'body', null, 'replace');
      });
    } }));
    mbar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: '保存すると「体組成」の画面に戻ります' }));
    return el('div', {}, [c, mbar]);
  }

  function goalForm(goal) {
    var g = goal && goal.kind === 'line' ? goal.points : null;
    var sd = field('開始日', g ? g[0].d : today(), 'date'), ed = field('目標の期限', g ? g[1].d : '', 'date');
    var sw = field('開始体重（kg）', g ? g[0].v : '', 'number'), tw = field('目標体重（kg）', g ? g[1].v : '', 'number');
    var c = card('体重の目標線（グラフの点線）', [el('div', { class: 'k-grid2' }, [sd.row, ed.row, sw.row, tw.row])]);
    if (goal && goal.kind === 'phases') c.appendChild(msg('いまは期ごとの目標（シートから写したもの）が使われています。ここで保存しても、期の目標が優先されます。'));
    var reqId = newReqId();
    c.appendChild(el('button', { class: 'k-btn out', text: '目標線を保存', onclick: function () {
      kWrite('k_saveGoalLine', { customerId: cur.customerId, startDate: sd.get(), endDate: ed.get(), startWeight: sw.get(), targetWeight: tw.get() }, reqId).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('保存しました。'); open(cur.customerId, cur.name, 'body', null, 'replace');
      });
    } }));
    return c;
  }

  // ---------------------------------------------------------------- トレーニング
  function partOf(ex) { for (var i = 0; i < PARTS.length; i++) if (PARTS[i][1].test(String(ex || ''))) return PARTS[i][0]; return 'その他'; }
  /** 種目ごとのまとめ（自己ベスト＝重量が最大のセット・同じなら回数が多い方） */
  function exerciseStats(sessions, ex) {
    var sets = [], days = {};
    (sessions || []).forEach(function (s) { (s.sets || []).forEach(function (st) { if (st.exercise === ex) { sets.push({ d: s.session_date, w: st.weight_kg, r: st.reps, e: st.e1rm }); (days[s.session_date] = days[s.session_date] || []).push(st); } }); });
    if (!sets.length) return null;
    var best = sets.slice().sort(function (a, b) { return b.w - a.w || b.r - a.r || (a.d < b.d ? 1 : -1); })[0];
    var byDay = Object.keys(days).sort().map(function (d) { var m = null; days[d].forEach(function (st) { if (st.e1rm != null && (m == null || st.e1rm > m)) m = st.e1rm; }); return { d: d, v: m, sets: days[d] }; });
    var withE = byDay.filter(function (x) { return x.v != null; });
    return { best: best, maxE: withE.length ? Math.max.apply(null, withE.map(function (x) { return x.v; })) : null,
      firstE: withE.length ? withE[0].v : null, reps: sets.reduce(function (a, b) { return a + b.r; }, 0), sets: sets.length, days: byDay };
  }

  // ---------------------------------------------------------------- トレーニングの記録（設計33 第1回）
  //   ★守ること（関門①）
  //     ・送る中身は送信の直前に「✓のセットだけ」から作り直す（前回の値を先に置くので、✓が無いとやっていないセットが残る）
  //     ・下書きは localStorage（トレーナー×顧客）。編集中と「送ったが応答が分からない（pending）」を分け、pending は中身と送信番号を固定
  //     ・「前回」は入力中の日付より前の、session_id 単位の直近1回
  var TR_DRAFT_PREFIX = 'karte_tr_draft_v1:';
  var TR_DRAFT_TTL = 24 * 3600 * 1000;
  var TR_TOTAL = 60;
  //   よく使う短いメモ（押すだけで入る）。健康の言葉は入れない（I55）
  var MEMO_PRESETS = ['補助あり', 'フォーム崩れ', '余裕あり', 'ギリギリ', '可動域を狭めた', 'テンポ遅め'];
  function trKey() { return TR_DRAFT_PREFIX + String((window.state && state.trainerId) || '') + ':' + cur.customerId; }
  function lsGet(k) { try { var v = localStorage.getItem(k); return v ? JSON.parse(v) : null; } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); return true; } catch (e) { return false; } }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }
  //   期限切れの下書きを実際に消す（開くたび）
  function purgeTrDrafts() {
    try {
      var dead = [];
      for (var i = 0; i < localStorage.length; i++) {
        var k = localStorage.key(i);
        if (k && k.indexOf(TR_DRAFT_PREFIX) === 0) { var v = lsGet(k); if (!v || Date.now() - Number(v.at || 0) > TR_DRAFT_TTL) dead.push(k); }
      }
      dead.forEach(lsDel);
    } catch (e) {}
  }
  function dayDiff(a, b) {   // 日本の暦日の差（YYYY-MM-DD どうし）
    var pa = String(a).split('-').map(Number), pb = String(b).split('-').map(Number);
    return Math.round((Date.UTC(pa[0], pa[1] - 1, pa[2]) - Date.UTC(pb[0], pb[1] - 1, pb[2])) / 86400000);
  }
  function byNewest(a, b) { return a.session_date !== b.session_date ? (a.session_date < b.session_date ? 1 : -1) : (Number(b.created_at || 0) - Number(a.created_at || 0)); }
  /** 入力中の日付より前の直近1回（session_id 単位） */
  function prevSession(sessions, date) { var l = (sessions || []).filter(function (s) { return s.session_date < date; }).sort(byNewest); return l[0] || null; }
  /** その種目の、入力中の日付より前の直近1回のセット */
  function prevOfExercise(sessions, ex, date) {
    var l = (sessions || []).filter(function (s) { return s.session_date < date && (s.sets || []).some(function (x) { return x.exercise === ex; }); }).sort(byNewest);
    if (!l.length) return null;
    return { s: l[0], sets: l[0].sets.filter(function (x) { return x.exercise === ex; }).sort(function (a, b) { return a.set_no - b.set_no; }) };
  }
  /** 部位ごとの前回からの暦日（入力中の日付まで）。同じ日の記録は「今日実施済み」 */
  function partsSince(sessions, date) {
    var last = {};
    (sessions || []).forEach(function (s) { if (s.session_date > date) return; (s.sets || []).forEach(function (x) { var p = partOf(x.exercise); if (!last[p] || s.session_date > last[p]) last[p] = s.session_date; }); });
    return Object.keys(last).map(function (p) { var d = dayDiff(date, last[p]); return { part: p, days: d, text: d === 0 ? p + ' 今日実施済み' : p + ' ' + d + '日ぶり' }; })
      .sort(function (a, b) { return b.days - a.days; });
  }
  /** 送る中身：✓のセットだけ（関門①-1） */
  function buildPayload(items) {
    return items.map(function (it) {
      return { exercise: String(it.exercise || '').trim(), sets: (it.sets || []).filter(function (s) { return s.done === true && s.w !== '' && s.r !== '' && s.w != null && s.r != null; })
        .map(function (s) { var o = { weight: Number(s.w), reps: Number(s.r) }; var n = String(s.note || '').trim(); if (n) o.note = n.slice(0, 200); return o; }) };
    }).filter(function (it) { return it.exercise && it.sets.length; });
  }
  //   記録されない入力：✓が無い・重量か回数が欠けている、のどちらかで、重量・回数・メモのどれかが入っているセット
  function uncheckedCount(items) {
    var n = 0;
    items.forEach(function (it) { (it.sets || []).forEach(function (s) {
      var hasW = s.w !== '' && s.w != null, hasR = s.r !== '' && s.r != null, hasN = String(s.note || '').trim() !== '';
      var recorded = s.done === true && hasW && hasR;
      if (!recorded && (hasW || hasR || hasN)) n++;
    }); });
    return n;
  }
  function totalSets(items) { var n = 0; items.forEach(function (it) { n += (it.sets || []).length; }); return n; }

  //   休憩タイマー（端末内だけ・記録しない・1つだけ・終了予定の時刻から残りを出す）
  var rest = { endAt: 0, iv: null, box: null, buzzed: false, ac: null };
  //   iPhone はウェブの画面から振動できない（Safari・LINE の中のブラウザとも）。気づけるように音と点滅を足す
  function restSound() { try { return localStorage.getItem('karte_rest_sound') !== 'off'; } catch (e) { return true; } }
  function audioUnlock() {   // ✓を押した（＝利用者の操作の）瞬間に用意しておかないと、iPhone は後から音を出せない
    if (!restSound()) return;
    try { var AC = window.AudioContext || window.webkitAudioContext; if (!AC) return; if (!rest.ac) rest.ac = new AC(); if (rest.ac.state === 'suspended') rest.ac.resume(); } catch (e) {}
  }
  function beep() {
    if (!restSound() || !rest.ac) return;
    try {
      [0, 0.35, 0.7].forEach(function (t) {
        var o = rest.ac.createOscillator(), g = rest.ac.createGain();
        o.type = 'sine'; o.frequency.value = 880; o.connect(g); g.connect(rest.ac.destination);
        var s0 = rest.ac.currentTime + t; g.gain.setValueAtTime(0.0001, s0); g.gain.exponentialRampToValueAtTime(0.4, s0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, s0 + 0.25);
        o.start(s0); o.stop(s0 + 0.27);
      });
    } catch (e) {}
  }
  //   休憩の秒数は種目ごと（2026-11-05 オーナー：種目で休憩を変える）。選べるのは 15・30・60・90 秒、基本は 60 秒。
  //   種目名ごとに端末へ覚える（次にその種目を足したら同じ秒数）。記録には保存しない（従来どおり）
  var REST_CHOICES = [15, 30, 60, 90], REST_DEFAULT = 60;
  function restMap() { try { var m = JSON.parse(localStorage.getItem('karte_rest_ex') || '{}'); return m && typeof m === 'object' ? m : {}; } catch (e) { return {}; } }
  function restSecondsFor(ex) { var v = Number(restMap()[String(ex || '')]); return REST_CHOICES.indexOf(v) >= 0 ? v : REST_DEFAULT; }
  function setRestSecondsFor(ex, v) { if (REST_CHOICES.indexOf(Number(v)) < 0) return; var m = restMap(); m[String(ex || '')] = Number(v); try { localStorage.setItem('karte_rest_ex', JSON.stringify(m)); } catch (e) {} }
  function restStart(sec) {
    rest.endAt = Date.now() + (REST_CHOICES.indexOf(Number(sec)) >= 0 ? Number(sec) : REST_DEFAULT) * 1000; rest.buzzed = false; audioUnlock();
    if (rest.box) rest.box.classList.remove('k-rest-done');
    if (rest.iv) clearInterval(rest.iv);
    rest.iv = setInterval(restTick, 500); restTick();
  }
  //   種目・セットを消したとき、帯の位置（何番目の種目の何セット目）を詰める。休憩中のそれ自体を消したら止める（関門②）
  function restShift(ei, si) {
    var p = rest.pos; if (!p) return;
    if (si == null) { if (p.ei === ei) restStop(); else if (p.ei > ei) p.ei--; return; }
    if (p.ei !== ei) return;
    if (p.si === si) restStop(); else if (p.si > si) p.si--;
  }
  function restStop() { rest.endAt = 0; rest.pos = null; if (rest.iv) clearInterval(rest.iv); rest.iv = null; if (rest.box) restTick(); }
  function restTick() {
    if (!rest.box || !rest.box.isConnected) { if (rest.iv) clearInterval(rest.iv); rest.iv = null; return; }   // 画面から外れたら止める（戻ったら trainingForm が続きを始める）
    var left = Math.ceil((rest.endAt - Date.now()) / 1000);
    rest.box.innerHTML = '';
    if (!rest.endAt) { rest.box.style.display = 'none'; return; }
    rest.box.style.display = '';
    if (left <= 0) {
      rest.box.appendChild(el('span', { style: 'font-weight:700;', text: '休憩おわり' }));
      if (!rest.buzzed) {
        rest.buzzed = true;
        //   長めの振動（Android）：0.6秒×3回（間を入れて約2.2秒）
        try { if (navigator.vibrate) navigator.vibrate([600, 200, 600, 200, 600]); } catch (e) {}
        beep();
        rest.box.classList.add('k-rest-done');
      }
      if (rest.iv) { clearInterval(rest.iv); rest.iv = null; }   // 「休憩おわり」は次の✓か「止める」まで残す
    } else rest.box.appendChild(el('span', { style: 'font-weight:700;font-size:18px;', text: '休憩 ' + Math.floor(left / 60) + ':' + String(left % 60).padStart(2, '0') }));
    rest.box.appendChild(el('button', { type: 'button', class: 'k-btn out small', style: 'margin-left:auto;', text: '止める', onclick: restStop }));
  }

  function tabTraining(box, draft) {
    purgeTrDrafts();
    var viaNav = nav.restoring;   // ★戻る・進むで来たか（open の中で同期に読む）。戻ってきたときに途中の記録を自動で開き直すと、記録の画面から出られなくなる
    box.appendChild(msg('読み込み中…'));
    var askedFor = cur.customerId;
    kRead('k_training', { customerId: cur.customerId }).then(function (r) {
      if (cur.customerId !== askedFor || cur.tab !== 'training') return;   // ★頼んだ顧客＝いまの顧客のときだけ
      box.innerHTML = '';
      if (!r || !r.success) { cur.wantDayView = null; box.appendChild(msg(errText(r), true)); return; }
      cur.trSchema = r.karteSchema;   // 指導メモのタグを送ってよいか（今日の記録の中の指導メモ）
      var sessions = r.sessions || [];
      //   ★今日の記録は専用の画面（2026-11-05 モックどおり）。読み直し後の復元・戻る/進むでも専用画面を開き直す
      if (draft && (draft.kind === 'training' || (draft.kind === 'sub' && draft.sub === 'trform'))) { trainingSub(box, sessions, draft.navMode); return; }
      if (draft && draft.kind === 'sub' && draft.sub === 'trpick') { trPickSub(sessions, draft.navMode); return; }
      var d0 = lsGet(trKey());
      //   ★「途中」は種目が入っている（または送り直し待ち）ときだけ。開いただけの空の下書きで毎回自動で開かない
      if (d0 && !(d0.pending || d0.memoPending || (d0.items || []).length || String(d0.memo || '').trim())) d0 = null;
      box.appendChild(el('button', { class: 'k-btn', text: d0 ? '記録の入力（途中）を開く' : '＋ 今日の記録', onclick: function () { trainingSub(box, sessions); } }));
      if (d0) box.appendChild(el('div', { class: 'k-sub', text: '入力の途中の記録があります（この端末に最大24時間残ります）。' }));
      trainingViews(box, sessions);
      //   開き直したら入力の途中に戻す（従来どおり）。ただし戻る・進むで来たときは開かない
      if (d0 && !viaNav) trainingSub(box, sessions);
    });
  }

  //   記入の専用画面の見出し（2026-11-05 モック K3/K3b/K5）：ネイビーの帯・戻る・タイトル・小見出し。下のタブとカルテの見出しは隠す
  function entryHead(title, backLabel) {
    var root = cur.root, wrap = root && root.querySelector('.k-wrap');
    if (root) root.classList.add('k-entry');
    var old = root && root.querySelector('.k-entryhead'); if (old) old.remove();
    var subText = el('span', { class: 'k-entrydate', text: cur.name ? cur.name + ' 様' : '' });
    var sub = el('div', { class: 'k-entrysub' }, [subText]);
    var hd = el('div', { class: 'k-entryhead' }, [
      el('button', { type: 'button', class: 'k-back', 'aria-label': backLabel || '前の画面に戻る', text: '←', onclick: function () { goBack(); } }),
      el('div', { class: 'k-entrytext', style: 'flex:1;min-width:0;' }, [el('div', { class: 'k-entrytitle', text: title }), sub])]);
    if (wrap) wrap.insertBefore(hd, wrap.firstChild);
    return { sub: sub, subText: subText };
  }
  var DOW = ['日', '月', '火', '水', '木', '金', '土'];
  function mdw(d) { var p = String(d || '').split('-'); if (p.length !== 3) return String(d || ''); var t = new Date(Date.UTC(+p[0], +p[1] - 1, +p[2])); return (+p[1]) + '/' + (+p[2]) + '(' + DOW[t.getUTCDay()] + ')'; }
  //   今日の記録を入れる（専用の画面）：ネイビーの見出し・下のタブは隠す・保存は下に固定（2026-11-05 モック K3）
  function trainingSub(box, sessions, mode) {
    navPush({ cid: cur.customerId, tab: 'training', sub: 'trform' }, mode);
    box.innerHTML = '';
    entryHead('今日の記録を入れる', 'トレーニングの画面に戻る');
    box.appendChild(trainingForm(sessions));
  }
  //   過去の記録から写す（専用の画面・モック K3b）：前回の日を最初から選んでおく＝「写す画面を開く→写す」の2タップで前回から始められる
  //   ★写した結果は端末の下書きに書いてから記録の画面に戻る（下書きの仕組みをそのまま使う）
  function partsOf(sess) { var m = {}, out = []; (sess.sets || []).forEach(function (x) { var pt = partOf(x.exercise); if (!m[pt]) { m[pt] = 1; out.push(pt); } }); return out; }
  function exOrder(sess) { var by = {}, order = []; (sess.sets || []).slice().sort(function (a, b) { return a.set_no - b.set_no; }).forEach(function (x) { if (!by[x.exercise]) { by[x.exercise] = []; order.push(x.exercise); } by[x.exercise].push(x); }); return { by: by, order: order }; }
  function copyInto(D, sess, withNums) {
    var o = exOrder(sess), cut = false;
    o.order.forEach(function (ex) {
      var sets = o.by[ex].map(function (x) { return withNums ? { w: x.weight_kg, r: x.reps, done: false } : { w: '', r: '', done: false }; });
      var same0 = D.items.filter(function (it) { return it.exercise === ex; })[0];   // ★同じ種目は1つにまとめる（1種目10セットまで・関門②）
      if (!same0 && D.items.length >= 20) { cut = true; return; }
      var cap = 10 - (same0 ? same0.sets.length : 0), room = TR_TOTAL - totalSets(D.items);
      var n = Math.min(sets.length, cap, room);
      if (n < sets.length) cut = true;
      if (n <= 0) return;
      if (same0) same0.sets = same0.sets.concat(sets.slice(0, n)); else D.items.push({ exercise: ex, sets: sets.slice(0, n) });
    });
    D.openEi = D.items.length - 1;
    return cut;
  }
  function trPickSub(sessions, mode) {
    navPush({ cid: cur.customerId, tab: 'training', sub: 'trpick' }, mode);
    var box = cur.body; box.innerHTML = '';
    entryHead('過去の記録から写す', '今日の記録に戻る');
    var tid = String((window.state && state.trainerId) || ''), cid = cur.customerId;
    var key = TR_DRAFT_PREFIX + tid + ':' + cid;
    var D = lsGet(key);
    if (D && (D.tid !== tid || D.cid !== cid || D.v !== 1)) D = null;
    if (D && D.pending) { box.appendChild(msg('前回の保存の結果を確かめるまで写せません。今日の記録の画面に戻ってください。', true)); return; }
    var sessionDate = D ? D.sessionDate : today();
    var list0 = (sessions || []).filter(function (x) { return String(x.session_date) < String(sessionDate); }).sort(byNewest).slice(0, 30);   // 記録の日付より前・新しい順に30回まで
    if (!list0.length) { box.appendChild(msg('写せる過去の記録がありません。')); return; }
    var sel = list0[0], part = '';
    var chips = el('div', { class: 'k-pills', style: 'gap:6px;' }), info = el('div', { class: 'k-sub' }), cards = el('div', { style: 'display:flex;flex-direction:column;gap:10px;' });
    box.appendChild(chips); box.appendChild(info); box.appendChild(cards);
    var bar = el('div', { class: 'k-savebar' });
    box.appendChild(bar);
    function draw() {
      chips.innerHTML = ''; cards.innerHTML = '';
      var allParts = []; list0.forEach(function (x) { partsOf(x).forEach(function (pt) { if (allParts.indexOf(pt) < 0) allParts.push(pt); }); });
      [''].concat(allParts).forEach(function (pt) {
        chips.appendChild(el('button', { type: 'button', class: 'k-pill' + (part === pt ? ' on' : ''), text: pt || 'すべて', onclick: function () { part = pt; var f = shown(); sel = f[0] || null; draw(); } }));
      });
      function shown() { return list0.filter(function (x) { return !part || partsOf(x).indexOf(part) >= 0; }); }
      var f = shown();
      info.textContent = (part ? '「' + part + '」の日 ' : '') + f.length + '件（新しい順）';
      f.forEach(function (x) {
        var on = sel === x, o = exOrder(x);
        var kids = [el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;' }, [el('b', { style: 'font-size:15px;', text: mdw(x.session_date) }), on ? el('span', { style: 'font-size:12px;color:var(--k-acc);font-weight:700;', text: '選択中' }) : null]),
          el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' }, partsOf(x).map(function (pt) { return el('span', { class: 'k-tag', text: pt }); }))];
        if (on) kids.push(el('div', { style: 'display:flex;flex-direction:column;gap:4px;font-size:14px;' }, o.order.map(function (ex) {
          return el('div', { style: 'display:flex;justify-content:space-between;gap:8px;' }, [el('span', { text: ex }), el('span', { class: 'k-sub', style: 'font-size:13px;', text: o.by[ex][0].weight_kg + 'kg × ' + o.by[ex].map(function (st) { return st.reps; }).join('・') })]);
        })));
        else kids.push(el('div', { class: 'k-sub', style: 'font-size:13px;', text: o.order.join('・') }));
        cards.appendChild(el('button', { type: 'button', 'aria-pressed': on ? 'true' : 'false', class: 'k-card k-pick' + (on ? ' on' : ''), onclick: function () { sel = x; draw(); } }, kids));
      });
      bar.innerHTML = '';
      bar.appendChild(el('div', { class: 'k-grid2' }, [
        el('button', { type: 'button', class: 'k-btn', text: '重量・回数ごと写す', onclick: function () { copy(true); } }),
        el('button', { type: 'button', class: 'k-btn out', text: '種目だけ写す', onclick: function () { copy(false); } })]));
      bar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;line-height:1.6;', text: '写した後も自由に直せます。✓（実施）は外した状態で入ります。今日の記録にすでに種目がある場合は、後ろに足します' }));
    }
    function copy(withNums) {
      if (!sel) return;
      var T = lsGet(key);
      if (T && (T.tid !== tid || T.cid !== cid || T.v !== 1)) T = null;
      if (T && T.pending) return;
      if (!T) T = { v: 1, tid: tid, cid: cid, sessionDate: sessionDate, items: [], reqId: newReqId(), pending: null, at: Date.now() };
      var cut = copyInto(T, sel, withNums);
      T.at = Date.now();
      if (!lsSet(key, T)) { window.alert('この端末に下書きを残せないため、写せませんでした。'); return; }
      if (cut) window.alert('上限（20種目・1種目10セット・合計60セット）を超える分は写していません。');
      goBack();
    }
    draw();
  }
  function trainingForm(sessions) {
    var c = el('div', { class: 'k-trform' });
    var tid = String((window.state && state.trainerId) || ''), cid = cur.customerId, cname = cur.name;
    //   ★鍵・顧客・名前はフォームを作った時点で固定する（送信中に別の顧客を開いても、その顧客の下書きを触らない・関門②）
    var draftKey = TR_DRAFT_PREFIX + tid + ':' + cid;
    var sending = false;
    function same() { return String((window.state && state.trainerId) || '') === tid && cur.customerId === cid; }
    var D = lsGet(draftKey);
    if (D && (D.tid !== tid || D.cid !== cid || D.v !== 1)) D = null;
    var restored = !!D;
    if (!D) D = { v: 1, tid: tid, cid: cid, sessionDate: today(), items: [], reqId: newReqId(), pending: null, at: Date.now() };
    function save() { D.at = Date.now(); var ok = lsSet(draftKey, D); if (!ok && note) note.textContent = 'この端末に下書きを残せません（保存するまで画面を閉じないでください）。'; return ok; }
    var note = el('div', { class: 'k-sub', style: 'margin-bottom:8px;' });
    c.appendChild(note);

    //   ---- 送ったが応答が分からない（pending）＝編集させない
    if (D.pending) {
      c.appendChild(el('div', { class: 'k-caution' }, [el('div', { class: 'k-h', text: '前回の保存の結果を確かめられませんでした' }),
        msg('通信が途中で切れた可能性があります。同じ内容で送り直しても、二重には記録されません。'),
        el('div', { style: 'font-size:13px;', text: md(D.pending.payload.sessionDate) + '・' + D.pending.payload.items.map(function (it) { return it.exercise + ' ' + it.sets.length + 'セット'; }).join('・') }),
        D.pending.payload.member ? el('div', { class: 'k-sub', text: 'お客様に見える欄も一緒に送ります（同じ内容）' }) : null]));
      c.appendChild(el('button', { class: 'k-btn', text: '同じ内容で送り直す', onclick: function () { send(D.pending.payload, D.pending.reqId); } }));
      c.appendChild(el('button', { class: 'k-btn out', text: '日別の記録を確かめる', onclick: function () { cur.wantDayView = cid; goBack(); } }));   // ★お客様に紐づける（別のお客様に持ち越さない・関門②）   // 専用画面→トレーニングの画面に戻って日別を開く
      c.appendChild(el('button', { class: 'k-btn out k-danger', text: '破棄して入れ直す', onclick: function () {
        if (!window.confirm('送り直さずに破棄しますか？（記録されていたかは「日別の記録を確かめる」で見られます）')) return;
        lsDel(draftKey); open(cid, cname, 'training', null, 'replace');
      } }));
      return c;
    }
    //   ---- お客様に見える欄だけを送ったが応答が分からない（mpending）＝編集させない（トレーニングの pending と同じ扱い）
    if (D.mpending) {
      var mq = D.mpending.payload || {};
      c.appendChild(el('div', { class: 'k-caution' }, [el('div', { class: 'k-h', text: 'お客様に見える欄の保存の結果を確かめられませんでした' }),
        msg('同じ内容で送り直しても、二重には残りません。'),
        el('div', { style: 'font-size:13px;white-space:pre-wrap;', text: md(mq.sessionDate) + '：' + String(mq.message || (mq.todo || []).join('・') || (mq.tags || []).join('・')).slice(0, 120) })]));
      c.appendChild(el('button', { class: 'k-btn', text: '同じ内容で送り直す', onclick: function () { sendMember(D.mpending.payload, D.mpending.reqId); } }));
      c.appendChild(el('button', { class: 'k-btn out', text: 'お客様の見え方を確かめる', onclick: function () { open(cid, cname, 'summary', { kind: 'sub', sub: 'mpreview' }); } }));
      c.appendChild(el('button', { class: 'k-btn out k-danger', text: '送り直さずに破棄', onclick: function () {
        if (!window.confirm('お客様に見える欄を送り直さずに破棄しますか？（残っていたかは「お客様の見え方を確かめる」で見られます）')) return;
        D.mpending = null; D.member = null; D.mReqId = newReqId(); save();   // 社内メモの書きかけは残す
        open(cid, cname, 'training', null, 'replace');
      } }));
      return c;
    }
    if (D.memoPending) {
      var mp0 = D.memoPending;
      c.appendChild(el('div', { class: 'k-caution' }, [el('div', { class: 'k-h', text: '指導メモの保存の結果を確かめられませんでした' }),
        msg((mp0.withTraining ? 'トレーニングの記録は保存済みです。' : '') + (mp0.memberSaved ? 'お客様に見える欄は保存済みです。' : '') + '指導メモは同じ内容で送り直しても、二重には残りません。'),
        el('div', { style: 'font-size:13px;white-space:pre-wrap;', text: md(mp0.date) + '：' + mp0.body.slice(0, 120) + (mp0.body.length > 120 ? '…' : '') })]));
      var resend = el('button', { class: 'k-btn', text: '同じ内容で送り直す', onclick: function () { if (!sending) submitMemo(mp0.date, mp0.body, '', !!mp0.memberSaved); } });
      saveBtn = resend; c.appendChild(resend);
      c.appendChild(el('button', { class: 'k-btn out', text: '指導の履歴を確かめる', onclick: function () { open(cid, cname, 'notes'); } }));
      c.appendChild(el('button', { class: 'k-btn out k-danger', text: '送り直さずに破棄', onclick: function () {
        if (!window.confirm('この指導メモを送り直さずに破棄しますか？（残っていたかは「指導の履歴を確かめる」で見られます）')) return;
        lsDel(draftKey); open(cid, cname, 'training', null, 'replace');
      } }));
      return c;
    }
    if (restored) note.textContent = '入力の途中を戻しました（' + fmtDate(D.at) + '）。この端末に最大24時間残ります。';

    //   日付は見出しに出す（モック K3）。見出しの日付を押すと端末の日付ピッカーで変えられる
    var d = field('日付', D.sessionDate, 'date'); d.el.max = today(); d.el.setAttribute('data-nodirty', '1');
    var hdDate = cur.root && cur.root.querySelector('.k-entrytext');
    if (hdDate) { d.el.className = 'k-dateover'; d.el.setAttribute('aria-label', '記録の日付を変える'); hdDate.appendChild(d.el); }
    else c.appendChild(d.row);
    //   過去の記録から写す（専用の画面・モック K3b）
    if ((sessions || []).length) c.appendChild(el('button', { type: 'button', class: 'k-btn k-btn-line', text: '過去の記録から写す', onclick: function () { trPickSub(sessions); } }));
    var restBar = el('div', { class: 'k-restbar', style: 'display:none;' });   // ★見た目は CSS の .k-restbar（inline に display を2つ書くと後の flex が勝ち、空の帯が出ていた）
    rest.box = restBar;   // ★置き場所は draw() が決める：✓を押したセットの真下（無ければ一覧の先頭＝空なので見えない）
    //   ★休憩中に上の「記録の入力」をもう一度押すと、この欄ごと作り直される。この時点の欄はまだ画面に無い（返してから置かれる）ので、
    //     ここで数えると「外れた帯」と見なして止まる。画面に置かれた後に、残り時間があれば新しい帯で続ける（関門②）
    setTimeout(function () {
      if (rest.box !== restBar || !restBar.isConnected) return;
      if (rest.endAt && !rest.buzzed && !rest.iv) rest.iv = setInterval(restTick, 500);
      restTick();
    }, 0);
    var list = el('div'); c.appendChild(list);
    var remain = el('div');   // セット数の集計（画面には出さない＝モック K3。保存の確認で知らせる）

    function prevLabel(ex) {   // モック K3：「前回 10/29：50kg × 10・10・8」（重さが混ざるときは 重さ×回数 を並べる）
      var p = prevOfExercise(sessions, ex, D.sessionDate);
      if (!p) return '前回の記録なし（直近20回の中）';
      var st = p.sets.slice().sort(function (a, b) { return a.set_no - b.set_no; });
      var oneW = st.every(function (x) { return x.weight_kg === st[0].weight_kg; });
      var body = oneW ? st[0].weight_kg + 'kg × ' + st.map(function (x) { return x.reps; }).join('・') : st.map(function (x) { return x.weight_kg + 'kg×' + x.reps; }).join('・');
      var pn = st.filter(function (x) { return x.note; }).map(function (x) { return x.note; });
      return '前回 ' + md(p.s.session_date) + '：' + body + (pn.length ? '（メモ：' + pn[pn.length - 1].slice(0, 30) + (pn[pn.length - 1].length > 30 ? '…' : '') + '）' : '');
    }
    function refreshTop() {
      var t = cur.root && cur.root.querySelector('.k-entrydate');
      if (t) t.textContent = (cname ? cname + ' 様 ／ ' : '') + mdw(D.sessionDate) + ' ▾';   // ▾＝押すと日付を変えられる
    }
    function trimTotal() { var n = 0; D.items.forEach(function (it) { it.sets = it.sets.filter(function () { n++; return n <= TR_TOTAL; }); }); D.items = D.items.filter(function (it) { return it.sets.length; }); }
    d.el.onchange = function () { D.sessionDate = d.get() || today(); save(); refreshTop(); draw(); };

    function numInput(val, ph, label, onv) {
      var i = el('input', { type: 'number', step: ph === 'kg' ? '0.5' : '1', placeholder: ph, 'aria-label': label, enterkeyhint: 'next', autocomplete: 'off' });
      //   キーパッドの「次へ」で、重量→回数→次のセットの重量…と進む（最後はキーパッドを閉じる）
      i.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var all = Array.prototype.slice.call(list.querySelectorAll('.k-setrow input'));
        var k = all.indexOf(i);
        if (k >= 0 && k < all.length - 1) all[k + 1].focus(); else i.blur();
      };
      i.inputMode = ph === 'kg' ? 'decimal' : 'numeric';
      if (val !== '' && val != null) i.value = val;
      i.oninput = function () { onv(i.value.trim()); save(); };
      return i;
    }
    function draw() {
      list.innerHTML = '';
      var placed = false;
      if (D.openEi == null || D.openEi >= D.items.length || D.openEi < 0) D.openEi = D.items.length - 1;
      D.items.forEach(function (it, ei) {
        if (ei !== D.openEi) {   // 畳んだ種目：押すと広げる（入力済み・✓の数を出す）
          var nd = it.sets.filter(function (x) { return x.done === true; }).length;
          list.appendChild(el('button', { type: 'button', class: 'k-excol', 'aria-label': it.exercise + 'を開く', onclick: function () { D.openEi = ei; save(); draw(); } }, [
            el('span', { style: 'flex:1;min-width:0;font-weight:700;font-size:15px;text-align:left;', text: it.exercise }),
            el('span', { class: 'k-tag', text: partOf(it.exercise) }),
            el('span', { class: 'k-sub', text: it.sets.length + 'セット' + (nd ? '（✓' + nd + '）' : '') + ' ›' })]));
          return;
        }
        var hasVal = it.sets.some(function (s) { return s.w !== '' && s.r !== '' && s.w != null && s.r != null; });
        var noneDone = !it.sets.some(function (s) { return s.done === true; });
        var blk = el('div', { style: 'border:1px solid ' + (hasVal && noneDone ? '#f5c9bb' : 'var(--k-line)') + ';border-radius:12px;padding:10px;margin-bottom:10px;background:' + (hasVal && noneDone ? '#fff7f4' : '#fff') + ';' });
        blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
          el('div', { style: 'flex:1;min-width:0;font-weight:700;font-size:15px;', text: it.exercise }),
          el('span', { class: 'k-tag', text: partOf(it.exercise) }),
          el('button', { type: 'button', class: 'k-btn out small k-danger', 'aria-label': it.exercise + 'を外す', text: '外す', onclick: function () { restShift(ei); D.items.splice(ei, 1); save(); draw(); } })]));
        blk.appendChild(el('div', { class: 'k-sub', style: 'margin:2px 0 8px;', text: prevLabel(it.exercise) }));
        blk.appendChild(el('div', { class: 'k-setrow', style: 'margin-bottom:2px;font-size:11px;color:var(--k-sub);' }, [el('span'), el('span', { text: '重量 kg' }), el('span', { text: '回数' }), el('span', { style: 'text-align:center;', text: '実施' }), el('span', { style: 'text-align:center;', text: 'メモ' }), el('span')]));
        it.sets.forEach(function (s, si) {
          var chk = el('button', { type: 'button', 'aria-pressed': s.done ? 'true' : 'false', 'aria-label': (si + 1) + 'セット目を実施済みにする',
            style: 'min-width:44px;min-height:44px;border-radius:12px;font-size:18px;font-weight:700;' + (s.done ? 'background:#243b66;color:#fff;border:1px solid #243b66;' : 'background:#fff;color:#8692a6;border:1px solid #8692a6;'),
            text: '✓', onclick: function () { s.done = !s.done; if (s.done) rest.pos = { ei: ei, si: si }; save(); draw(); if (s.done) restStart(restSecondsFor(it.exercise)); } });
          blk.appendChild(el('div', { class: 'k-setrow' }, [
            el('span', { style: 'color:var(--k-sub);font-size:13px;text-align:center;', text: String(si + 1) }),
            numInput(s.w, 'kg', (si + 1) + 'セット目の重量', function (v) { s.w = v; }),
            numInput(s.r, '回', (si + 1) + 'セット目の回数', function (v) { s.r = v; }),
            chk,
            el('button', { type: 'button', 'aria-label': (si + 1) + 'セット目のメモ', 'aria-expanded': (s.note || s.memoOpen) ? 'true' : 'false',
              style: 'min-width:44px;min-height:44px;border-radius:10px;font-size:16px;' + (s.note ? 'background:var(--k-acc-l);color:var(--k-acc);border:1px solid var(--k-acc);' : 'background:#fff;color:#9a9ea6;border:1px solid #8692a6;'),
              text: '✎', onclick: function () { s.memoOpen = !(s.memoOpen || s.note); if (!s.memoOpen && !s.note) { save(); draw(); return; } save(); draw(); focusMemo(ei, si); } }),
            el('button', { type: 'button', class: 'k-setdel', 'aria-label': (si + 1) + 'セット目を消す', style: 'min-width:44px;min-height:44px;border:none;background:transparent;color:var(--k-warn);font-size:16px;', text: '×',
              onclick: function () { if (it.sets.length === 1) restShift(ei); else restShift(ei, si); it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
          //   セットのメモ（✎ で開く・入っていれば開いたまま）。痛み・診断は書かない（注意すること へ）
          if (s.note || s.memoOpen) {
            var mi = el('input', { type: 'text', maxlength: '200', placeholder: '例：最後の2回は補助', 'aria-label': (si + 1) + 'セット目のメモ（200字まで）', 'data-memo': ei + ':' + si, enterkeyhint: 'done', autocomplete: 'off' });
            if (s.note) mi.value = s.note;
            mi.oninput = function () { s.note = mi.value; save(); };
            mi.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); mi.blur(); } };
            var chips = el('div', { class: 'k-memochips' });
            MEMO_PRESETS.forEach(function (tx) {
              chips.appendChild(el('button', { type: 'button', text: tx, onclick: function () {
                var v = String(s.note || '').trim();
                if (v.indexOf(tx) >= 0) return;
                s.note = (v ? v + '・' : '') + tx; if (s.note.length > 200) s.note = s.note.slice(0, 200);
                mi.value = s.note; save();
              } }));
            });
            blk.appendChild(el('div', { class: 'k-setnote' }, [mi, chips,
              el('div', { class: 'k-sub', style: 'margin-top:4px;color:var(--k-warn);', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }),
              el('button', { type: 'button', class: 'k-btn out small k-danger k-setdel2', style: 'margin-top:6px;', text: 'このセットを消す', onclick: function () { if (it.sets.length === 1) restShift(ei); else restShift(ei, si); it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
          }
          if (rest.pos && rest.pos.ei === ei && rest.pos.si === si) { blk.appendChild(restBar); placed = true; }   // ★休憩の帯は✓を押したセットの真下（2026-11-05 オーナー：スクロールが煩わしい）
        });
        //   セットを足す＝直前のセットを複製（✓は外す）
        blk.appendChild(el('button', { type: 'button', class: 'k-addset', text: '＋ セット', 'aria-label': 'セットを足す（前のセットを複製）', onclick: function () {
          if (totalSets(D.items) >= TR_TOTAL) { window.alert('1回の記録は合計60セットまでです。'); return; }
          if (it.sets.length >= 10) { window.alert('1種目10セットまでです。'); return; }
          var last = it.sets[it.sets.length - 1] || { w: '', r: '' };
          it.sets.push({ w: last.w, r: last.r, done: false }); save(); draw();
        } }));
        //   休憩の行（従来の見た目のまま種目ごとに置く・2026-11-05 オーナー）。秒数はこの種目に覚える
        var rs = el('select', { 'data-nodirty': '1', 'aria-label': it.exercise + 'の休憩の秒数', style: 'min-height:44px;border:1px solid #8692a6;border-radius:8px;padding:0 8px;font-size:16px;background:#fff;' });
        REST_CHOICES.forEach(function (v) { var o = el('option', { value: String(v), text: '休憩 ' + v + '秒' }); if (v === restSecondsFor(it.exercise)) o.selected = true; rs.appendChild(o); });
        rs.onchange = function () { setRestSecondsFor(it.exercise, rs.value); };
        var snd = el('button', { type: 'button', class: 'k-pill' + (restSound() ? ' on' : ''), 'aria-pressed': restSound() ? 'true' : 'false', text: restSound() ? '終了音：あり' : '終了音：なし', onclick: function () {
          var on = !restSound(); try { localStorage.setItem('karte_rest_sound', on ? 'on' : 'off'); } catch (e) {}
          if (on) audioUnlock();   // ★この操作の中で用意する（後からでは iPhone は鳴らせない）
          draw();   // 終了音は端末で1つ＝ほかの種目の表示もそろえる
        } });
        blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;' }, [rs, snd, el('span', { class: 'k-sub', text: '✓を押すと休憩タイマーが始まります（記録には保存されません）' })]));
        list.appendChild(blk);
      });
      if (!placed) list.insertBefore(restBar, list.firstChild);   // ✓のセットが無い・消えた：一覧の先頭（数えていれば見える・空なら隠れる）
      if (!D.items.length) list.appendChild(msg('「前回の内容で始める」か「種目を足す」から始めてください。'));
      var t = totalSets(D.items), rec = 0;
      buildPayload(D.items).forEach(function (x) { rec += x.sets.length; });
      remain.textContent = '記録する ' + rec + 'セット・記録しない ' + uncheckedCount(D.items) + 'セット（合計 ' + t + '／' + TR_TOTAL + '）';
    }
    function focusMemo(ei, si) { var m = list.querySelector('input[data-memo="' + ei + ':' + si + '"]'); if (m) { try { m.focus(); } catch (e) {} } }
    function addExercises(names) {
      names.forEach(function (ex) {
        if (D.items.length >= 20 || totalSets(D.items) >= TR_TOTAL) return;
        var p = prevOfExercise(sessions, ex, D.sessionDate);
        var first = { w: '', r: '', done: false };
        if (p) { var top = p.sets.slice().sort(function (a, b) { return b.weight_kg - a.weight_kg || b.reps - a.reps; })[0]; first = { w: top.weight_kg, r: top.reps, done: false }; }
        D.items.push({ exercise: ex, sets: [first] });
      });
      D.openEi = D.items.length - 1;
      save(); draw();
    }
    c.appendChild(el('button', { type: 'button', class: 'k-btn out', text: '＋ 種目を足す', onclick: function () { picker.style.display = picker.style.display === 'none' ? '' : 'none'; } }));
    var picker = exercisePicker(sessions, function (names) { addExercises(names); picker.style.display = 'none'; });
    picker.style.display = 'none';
    c.appendChild(picker);
    //   指導メモ（2026-11-05 モック K3：セッション中にそのまま書く）。社内メモ＝既存の指導メモ（k_addNote）にそのまま残す
    //   ★書きかけは記録の下書き（D.memo）に残す＝セットと同じく画面を離れても消えない。「お客様へ」は第2弾（保存先を作る）
    if (!D.memoReqId) D.memoReqId = newReqId();
    if (D.memoTag == null) D.memoTag = 'training';
    c.appendChild(el('div', { class: 'k-sub', style: 'letter-spacing:.08em;padding:10px 2px 6px;', text: '指導メモ（セッション中にそのまま書けます）' }));
    var memoTa = el('textarea', { rows: '3', maxlength: '2000', 'aria-label': '社内メモ', placeholder: '話した内容・やったこと・次回の課題', 'data-nodirty': '1', class: 'k-memo' });
    memoTa.value = D.memo || '';
    memoTa.oninput = function () { D.memo = memoTa.value; save(); };
    var memoTags = el('div', { class: 'k-pills', style: 'gap:6px;' });
    function drawMemoTags() {
      memoTags.innerHTML = '';
      TAGS.filter(function (t) { return t[0] !== 'body'; }).forEach(function (t) {
        memoTags.appendChild(el('button', { type: 'button', class: 'k-pill' + (D.memoTag === t[0] ? ' on' : ''), 'aria-pressed': D.memoTag === t[0] ? 'true' : 'false', text: t[1], onclick: function () { D.memoTag = D.memoTag === t[0] ? '' : t[0]; save(); drawMemoTags(); } }));
      });
    }
    drawMemoTags();
    //   ★社内＝灰・お客様＝ネイビーの淡（設計35 C2）。見た目で取り違えないように色を分ける
    c.appendChild(el('div', { class: 'k-card k-internal', style: 'display:flex;flex-direction:column;gap:8px;background:#f0f3f7;border-color:#e3e8ee;box-shadow:none;' }, [
      el('div', { class: 'k-headrow', style: 'margin:0;' }, [el('div', { style: 'font-size:14px;font-weight:700;', text: '社内メモ' }), el('span', { class: 'k-chip-h', style: 'background:#fff;color:var(--k-sub);', text: 'お客様には見えません' })]),
      memoTa, memoTags,
      el('div', { class: 'k-note-hint', style: 'margin:0;', text: '痛み・診断・服薬はここに書かず「注意すること」へ' })]));
    //   お客様に見える欄（設計35 C2）：お客様へ・次回までに（3つ）・日のタグ。★保存するとお客様の画面にそのまま出る（下書き・公開の2段は設けない＝オーナー判断）
    //   書きかけは記録の下書き（D.member）に残す。送るのは「保存する」の1回（セットがあれば k_addTraining に同梱・無ければ k_saveMemberNote）
    if (!D.member || typeof D.member !== 'object') D.member = { message: '', todo: ['', '', ''], tags: [] };
    if (!Array.isArray(D.member.todo)) D.member.todo = ['', '', ''];
    while (D.member.todo.length < MEMBER_MAX.todo) D.member.todo.push('');
    if (!Array.isArray(D.member.tags)) D.member.tags = [];
    if (!D.mReqId) D.mReqId = newReqId();
    var mTa = el('textarea', { rows: '3', maxlength: String(MEMBER_MAX.message), 'aria-label': 'お客様へ', placeholder: '例：スクワットが前回より深くしゃがめていました。次回は重さを少し上げます。', 'data-nodirty': '1', class: 'k-memo' });
    mTa.value = D.member.message || '';
    var mCount = el('div', { class: 'k-sub', style: 'text-align:right;' });
    function drawCount() { mCount.textContent = String(mTa.value.length) + '／' + MEMBER_MAX.message + '字'; }
    mTa.oninput = function () { D.member.message = mTa.value; drawCount(); save(); };
    drawCount();
    var todoBox = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
    D.member.todo.slice(0, MEMBER_MAX.todo).forEach(function (v, i) {
      var ti = el('input', { type: 'text', maxlength: String(MEMBER_MAX.todoLen), 'aria-label': '次回までに ' + (i + 1) + 'つ目', placeholder: i === 0 ? '例：お風呂上がりに股関節のストレッチ 2分' : '', 'data-nodirty': '1', enterkeyhint: 'next', autocomplete: 'off',
        style: 'box-sizing:border-box;width:100%;min-height:44px;border:1px solid #8692a6;border-radius:10px;padding:0 10px;font-size:16px;background:#fff;color:var(--k-ink);font-family:inherit;' });
      ti.value = v || '';
      ti.oninput = function () { D.member.todo[i] = ti.value; save(); };
      todoBox.appendChild(ti);
    });
    var dayTags = el('div', { class: 'k-pills', style: 'gap:6px;' });
    function drawDayTags() {
      dayTags.innerHTML = '';
      DAY_TAGS.forEach(function (tg) {
        var onTag = D.member.tags.indexOf(tg) >= 0;
        dayTags.appendChild(el('button', { type: 'button', class: 'k-pill' + (onTag ? ' on' : ''), 'aria-pressed': onTag ? 'true' : 'false', text: tg, onclick: function () {
          var k = D.member.tags.indexOf(tg);
          if (k >= 0) D.member.tags.splice(k, 1);
          else { if (D.member.tags.length >= MEMBER_MAX.tags) { window.alert('日のタグは' + MEMBER_MAX.tags + 'つまでです。'); return; } D.member.tags.push(tg); }
          save(); drawDayTags();
        } }));
      });
    }
    drawDayTags();
    function mLabel(text) { return el('div', { style: 'font-size:12px;font-weight:700;color:var(--k-acc);margin-top:4px;', text: text }); }
    c.appendChild(el('div', { class: 'k-card k-member', style: 'display:flex;flex-direction:column;gap:8px;background:#edf2fb;border-color:#d2ddf0;' }, [
      el('div', { class: 'k-headrow', style: 'margin:0;' }, [el('div', { style: 'font-size:14px;font-weight:700;color:var(--k-acc);', text: 'お客様に見える欄' }), el('span', { class: 'k-chip-h', style: 'background:var(--k-acc);color:#fff;font-weight:700;', text: 'お客様に見えます' })]),
      mLabel('お客様へ（' + MEMBER_MAX.message + '字まで）'), mTa, mCount,
      mLabel('次回までに（' + MEMBER_MAX.todo + 'つまで）'), todoBox,
      mLabel('日のタグ（' + MEMBER_MAX.tags + 'つまで）'), dayTags,
      el('div', { class: 'k-note-hint', style: 'margin:0;', text: '保存するとお客様の画面にそのまま出ます。痛み・診断・社内のことは書かない' })]));
    //   指導メモを送る。★結果が確定するまで、本文と送信番号を記録の下書き（D.memoPending）に残す（関門② High×3）
    //     ・結果が分からない（通信切れ・応答が読めない）＝同じ送信番号で「同じ内容で送り直す」＝二重にならない
    //     ・送信中に別のお客様を開いても、元のお客様の下書きに残る（鍵は開いた時点で固定）
    //     ・ログインが古いときは記録の下書きとして退避（お客様の番号を固定・別のお客様を開いていたら読み直さない）
    function submitMemo(date, body, trainingLine, memberSaved) {
      if (!D.memoPending) D.memoPending = { date: date, body: body, tag: schemaOk({ karteSchema: cur.trSchema }) ? (D.memoTag || '') : '', reqId: D.memoReqId, withTraining: !!trainingLine, memberSaved: !!memberSaved };
      var mp = D.memoPending;
      if (!save()) { window.alert('この端末に送信の控えを残せないため、指導メモを送りませんでした（ブラウザの保存領域を確かめてください）。'); return; }
      sending = true;
      if (saveBtn) saveBtn.textContent = '送信中…';
      function again() { if (same()) open(cid, cname, 'training', null, 'replace'); }
      function unknownMemo() { sending = false; if (same()) { window.alert('指導メモの保存の結果を確かめられませんでした。「同じ内容で送り直す」から送ってください。'); again(); } }
      kWrite('k_addNote', { customerId: cid, sessionDate: mp.date, tag: mp.tag, condition: '', body: mp.body, nextPlan: '' }, mp.reqId, { kind: 'training', customerId: cid }).then(function (w) {
        if (!w || w.code === 'BAD_RESPONSE' || w.code === 'STALE') { unknownMemo(); return; }
        sending = false;
        if (w.success) {
          //   お客様の欄が保存されずに残っている（古い Worker）＝その欄だけ下書きに残す
          if (memberOf(D.member)) { D.memoPending = null; D.memo = ''; D.memoReqId = newReqId(); save(); } else lsDel(draftKey);
          if (same()) doneScreen(trainingLine, true, mp.body, mp.date, !!mp.memberSaved);
          return;
        }
        //   はっきり断られた＝残っていない。本文は下書きに残したまま、次は新しい送信番号
        D.memoPending = null; D.memoReqId = newReqId(); save();
        if (same()) { window.alert('指導メモは保存できませんでした（' + errText(w) + '）。内容は残っています。もう一度「保存する」を押してください。'); again(); }
      }, unknownMemo);
    }
    function doneScreen(trainingLine, memoSaved, memoBody, date, memberSaved) {
      c.innerHTML = '';
      c.appendChild(el('div', { class: 'k-h', text: '記録しました' }));
      if (trainingLine) c.appendChild(el('div', { style: 'font-size:14px;margin-bottom:4px;', text: trainingLine }));
      if (memberSaved) c.appendChild(el('div', { style: 'font-size:14px;margin-bottom:4px;', text: 'お客様に見える欄も保存しました（お客様の画面に出ます）' }));
      if (memoSaved) c.appendChild(el('div', { style: 'font-size:14px;margin-bottom:8px;', text: '指導メモも保存しました' }));
      if (!memoBody) c.appendChild(el('button', { class: 'k-btn', text: '続けて指導メモを書く', onclick: function () { open(cid, cname, 'notes', { kind: 'note', data: { sessionDate: date, tag: 'training', condition: '', body: '', nextPlan: '' } }); } }));
      c.appendChild(el('button', { class: 'k-btn out', text: '記録の一覧を見る', onclick: function () { if (same()) open(cid, cname, 'training', null, 'replace'); } }));
    }


    function send(payload, reqId) {
      if (sending) return;   // ★連打・送信中の再保存を止める（関門②）
      //   ★古い Worker（版 32 未満）には送らない＝お客様の欄が session から切り離されない（Codex 関門②）。入力は下書きに残る
      if (!schemaOk({ karteSchema: cur.trSchema })) { window.alert(SCHEMA_MSG); return; }
      //   ★送る直前に、トレーナー・顧客が下書きと同じかを確かめる（違えば送らない・下書きも消さない）
      if (!same() || D.tid !== tid || D.cid !== cid || payload.customerId !== cid) { window.alert('開いているお客様が変わったため送りませんでした。カルテを開き直してください。'); return; }
      D.pending = { payload: payload, reqId: reqId };
      //   ★送った中身を端末に固定できないなら送らない（送り直しで二重にしないための前提）
      if (!save()) { D.pending = null; window.alert('この端末に送信の控えを残せないため、送りませんでした（ブラウザの保存領域を確かめてください）。'); return; }
      sending = true;   // ★送信中はお客様の欄・メモも止める（送った後に書き足した分が、成功で下書きから消えないように）
      Array.prototype.forEach.call(c.querySelectorAll('button,input,select,textarea'), function (x) { x.disabled = true; });
      if (saveBtn) saveBtn.textContent = '送信中…';
      function back() { if (same()) open(cid, cname, 'training', null, 'replace'); }
      function unknown() { sending = false; if (same()) { window.alert('通信の結果を確かめられませんでした。「同じ内容で送り直す」から送ってください。'); back(); } }
      kWrite('k_addTraining', payload, reqId, { kind: 'training', customerId: cid }).then(function (w) {
        if (!w || w.code === 'BAD_RESPONSE') { unknown(); return; }
        sending = false;
        if (w.success) {
          var memoBody = String(D.memo || '').trim();
          //   ★お客様の欄が書けたかは応答の mnoteId で確かめる（古い Worker は member を黙って捨てて success を返す）
          var memberSent = !!payload.member && !!w.mnoteId, memberLost = !!payload.member && !w.mnoteId;
          //   ★お客様の欄はセットと同じ1回で書けた＝セットと同じ時点で下書きから消す（設計35 改訂1-2）。書けていなければ欄は下書きに残す
          if (!memberLost) { D.member = null; }
          D.mReqId = newReqId();
          //   ★メモがあるなら下書きは消さない：セットだけを外し、メモは送信待ちとして残す（別のお客様を開いていても元のお客様の下書きに残る）
          if (memoBody) { D.items = []; D.pending = null; D.reqId = newReqId(); D.memoPending = { date: payload.sessionDate, body: memoBody, tag: schemaOk({ karteSchema: cur.trSchema }) ? (D.memoTag || '') : '', reqId: D.memoReqId, withTraining: true, memberSaved: memberSent }; save(); }
          else if (memberLost) { D.items = []; D.pending = null; D.reqId = newReqId(); save(); }
          else lsDel(draftKey);
          if (memberLost) window.alert('トレーニングの記録は保存しました。お客様の欄は保存されていません（システムの更新中の可能性があります）。内容は今日の記録の画面に残っています。');
          if (!same()) return;   // 別の顧客を開いていたら画面は触らない
          var n = 0; payload.items.forEach(function (x) { n += x.sets.length; });
          var line = md(payload.sessionDate) + '・' + payload.items.length + '種目・' + n + 'セット';
          if (!memoBody) { doneScreen(line, false, '', payload.sessionDate, memberSent); return; }
          c.innerHTML = ''; c.appendChild(msg('記録しました。指導メモを保存しています…'));
          submitMemo(payload.sessionDate, memoBody, line, memberSent);
          return;
        }
        //   はっきり断られた＝記録されていない。pending を解き、次は新しい送信番号（鍵は固定したもの）
        D.pending = null; D.reqId = newReqId(); save();
        if (!same()) return;
        if (w.code === 'REQ_REUSED') window.alert('この送信番号は別の内容で使われています。日別の記録を確かめてから、必要なら保存し直してください。');
        else if (w.code === 'TOTAL_SETS') window.alert('1回の記録は合計60セットまでです。');
        else window.alert(errText(w));
        back();
      }, unknown);
    }
    //   セットが無く、お客様に見える欄だけを送る（k_saveMemberNote・新規・トレーニングなし＝設計35 改訂3-1）。扱いはトレーニングの send と同じ
    //     ・結果が分からない＝同じ送信番号で「同じ内容で送り直す」（D.mpending）。はっきり断られた＝欄は残したまま、次は新しい送信番号
    function sendMember(payload, reqId) {
      if (sending) return;
      if (!schemaOk({ karteSchema: cur.trSchema })) { window.alert(SCHEMA_MSG); return; }   // 古い Worker には送らない（send と同じ）
      if (!same() || D.tid !== tid || D.cid !== cid || payload.customerId !== cid) { window.alert('開いているお客様が変わったため送りませんでした。カルテを開き直してください。'); return; }
      D.mpending = { payload: payload, reqId: reqId };
      if (!save()) { D.mpending = null; window.alert('この端末に送信の控えを残せないため、送りませんでした（ブラウザの保存領域を確かめてください）。'); return; }
      sending = true;
      Array.prototype.forEach.call(c.querySelectorAll('button,input,select,textarea'), function (x) { x.disabled = true; });
      if (saveBtn) saveBtn.textContent = '送信中…';
      function back() { if (same()) open(cid, cname, 'training', null, 'replace'); }
      function unknown() { sending = false; if (same()) { window.alert('通信の結果を確かめられませんでした。「同じ内容で送り直す」から送ってください。'); back(); } }
      kWrite('k_saveMemberNote', payload, reqId, { kind: 'training', customerId: cid }).then(function (w) {
        if (!w || w.code === 'BAD_RESPONSE') { unknown(); return; }
        sending = false;
        if (w.success) {
          var memoBody = String(D.memo || '').trim();
          D.mpending = null; D.member = null; D.mReqId = newReqId();
          if (memoBody) { D.items = []; D.memoPending = { date: payload.sessionDate, body: memoBody, tag: schemaOk({ karteSchema: cur.trSchema }) ? (D.memoTag || '') : '', reqId: D.memoReqId, withTraining: false, memberSaved: true }; save(); }
          else lsDel(draftKey);
          if (!same()) return;
          if (!memoBody) { doneScreen('', false, '', payload.sessionDate, true); return; }
          c.innerHTML = ''; c.appendChild(msg('お客様に見える欄を保存しました。指導メモを保存しています…'));
          submitMemo(payload.sessionDate, memoBody, '', true);
          return;
        }
        D.mpending = null; D.mReqId = newReqId(); save();
        if (!same()) return;
        window.alert('お客様に見える欄は保存できませんでした（' + errText(w) + '）。内容は残っています。');
        back();
      }, unknown);
    }
    var saveBtn = null;
    var saveBar = el('div', { class: 'k-savebar' });
    c.appendChild(saveBar);
    saveBar.appendChild(saveBtn = el('button', { class: 'k-btn', text: '保存する', onclick: function () {
      var items = buildPayload(D.items);
      var memo = String(D.memo || '').trim();
      var mem = memberOf(D.member);
      if (!items.length) {
        if (!memo && !mem) { window.alert('実施したセットに✓を付けるか、指導メモ・お客様に見える欄を書いてください。'); return; }
        //   ★トレーニングの無い日は、日のタグだけでは会員のどこにも出ない＝「お客様へ」か「次回までに」が要る（Codex 関門②）
        if (mem && !mem.message && !(mem.todo && mem.todo.length)) { window.alert('トレーニングの記録が無い日は、日のタグだけでは保存できません。「お客様へ」か「次回までに」を書いてください。'); return; }
        var n0 = uncheckedCount(D.items);
        if (n0 && !window.confirm('✓の付いたセットが無いため、' + (mem ? 'お客様に見える欄' + (memo ? 'と指導メモ' : '') : '指導メモ') + 'だけを保存します。入力中の ' + n0 + ' セットは消えます。よいですか？')) return;
        if (sending) return;
        D.items = []; save();
        if (mem) { sendMember({ rev: 0, customerId: cid, sessionDate: D.sessionDate, message: mem.message, todo: mem.todo, tags: mem.tags }, D.mReqId); return; }
        submitMemo(D.sessionDate, memo, '');
        return;
      }
      var n = uncheckedCount(D.items);
      if (n && !window.confirm('記録されない入力が ' + n + ' セットあります（✓が無い・重量か回数が空）。保存すると、その入力は消えます。よいですか？')) return;
      var total = 0; items.forEach(function (it) { total += it.sets.length; });
      if (total > TR_TOTAL) { window.alert('1回の記録は合計60セットまでです。'); return; }
      var payload = { customerId: cur.customerId, sessionDate: D.sessionDate, items: items };
      if (mem) payload.member = mem;   // 空なら送らない（member なし＝今までと同じ形）
      send(payload, D.reqId);
    } }));
    saveBar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: '記録・指導メモ・お客様に見える欄をまとめて保存し、「トレーニング」の画面に戻ります' }));
    refreshTop(); draw();
    if (!restored) save();
    return c;
  }

  //   種目の選び方：この方の最近の種目 → 部位 → 検索・名前を入れて足す。複数選んでまとめて足す
  function exercisePicker(sessions, onAdd) {
    var cnt = {};
    (sessions || []).forEach(function (s) { var seen = {}; (s.sets || []).forEach(function (x) { if (!seen[x.exercise]) { seen[x.exercise] = 1; cnt[x.exercise] = (cnt[x.exercise] || 0) + 1; } }); });
    var recent = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 8);
    var all = recent.concat(EXERCISES.filter(function (x) { return recent.indexOf(x) < 0; }));
    var picked = [];
    var box = el('div', { class: 'k-card', style: 'margin-top:8px;background:var(--k-cream);' });
    var q = el('input', { 'data-nodirty': '1', type: 'search', placeholder: '種目を探す・新しい名前を入れる', 'aria-label': '種目を探す', enterkeyhint: 'search', style: 'width:100%;min-height:44px;border:1px solid #8692a6;border-radius:8px;padding:0 10px;font-size:16px;box-sizing:border-box;' });
    var area = el('div');
    var go = el('button', { type: 'button', class: 'k-btn k-picker-go', text: '選んだ種目を足す' });
    function chip(ex) {
      var on = picked.indexOf(ex) >= 0;
      return el('button', { type: 'button', class: 'k-pill' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', text: ex, onclick: function () { var i = picked.indexOf(ex); if (i >= 0) picked.splice(i, 1); else picked.push(ex); draw(); } });
    }
    function draw() {
      area.innerHTML = '';
      var t = q.value.trim();
      if (t) {
        var hit = all.filter(function (x) { return x.indexOf(t) >= 0; });
        var p1 = el('div', { class: 'k-pills', style: 'margin-top:10px;' }); hit.forEach(function (x) { p1.appendChild(chip(x)); });
        area.appendChild(p1);
        if (hit.indexOf(t) < 0 && t.length <= 50) area.appendChild(el('button', { type: 'button', class: 'k-btn out small', style: 'margin-top:8px;', text: '「' + t + '」を新しく足す', onclick: function () { if (picked.indexOf(t) < 0) picked.push(t); all.push(t); q.value = ''; draw(); } }));
      } else {
        if (recent.length) { area.appendChild(el('div', { class: 'k-sub', style: 'margin:10px 0 6px;font-weight:700;', text: 'この方の最近の種目' })); var p2 = el('div', { class: 'k-pills' }); recent.forEach(function (x) { p2.appendChild(chip(x)); }); area.appendChild(p2); }
        var groups = {};
        all.forEach(function (x) { if (recent.indexOf(x) >= 0) return; var p = partOf(x); (groups[p] = groups[p] || []).push(x); });
        Object.keys(groups).forEach(function (g) { area.appendChild(el('div', { class: 'k-sub', style: 'margin:10px 0 6px;font-weight:700;', text: g })); var p3 = el('div', { class: 'k-pills' }); groups[g].forEach(function (x) { p3.appendChild(chip(x)); }); area.appendChild(p3); });
      }
      go.textContent = picked.length ? '選んだ ' + picked.length + ' 種目を足す' : '選んだ種目を足す';
    }
    q.oninput = draw;
    go.onclick = function () { if (!picked.length) { window.alert('種目を選んでください。'); return; } onAdd(picked.slice()); picked = []; q.value = ''; draw(); };
    box.appendChild(q); box.appendChild(area); box.appendChild(go);
    draw();
    return box;
  }

  //   トレーニングの「見る」（モック K2）：前回 → 種目ごとの推移 → 日別の記録（部位で絞る・押すと中身と削除）
  function trainingViews(box, sessions) {
    box.appendChild(el('div', { class: 'k-sub', style: 'letter-spacing:.08em;padding:4px 2px 0;', text: '見る' }));
    var wantDay = cur.wantDayView; cur.wantDayView = null;   // 使っても使わなくても消す
    if (!sessions.length) { box.appendChild(msg('まだ記録がありません。')); cur.showDayView = function () {}; return; }
    var sorted = sessions.slice().sort(byNewest);
    function setLine(sets) {
      var st = sets.slice().sort(function (a, b) { return a.set_no - b.set_no; });
      var oneW = st.every(function (x) { return x.weight_kg === st[0].weight_kg; });
      return oneW ? st[0].weight_kg + 'kg × ' + st.map(function (x) { return x.reps; }).join('・') : st.map(function (x) { return x.weight_kg + 'kg×' + x.reps; }).join('・');
    }
    function exRows(sess, withNotes) {
      var o = exOrder(sess), out = el('div', { style: 'display:flex;flex-direction:column;gap:6px;font-size:14px;' });
      o.order.forEach(function (ex) {
        out.appendChild(el('div', { style: 'display:flex;justify-content:space-between;gap:8px;' }, [el('span', { text: ex }), el('span', { class: 'k-sub', style: 'font-size:13px;text-align:right;', text: setLine(o.by[ex]) })]));
        if (withNotes) o.by[ex].forEach(function (st) { if (st.note) out.appendChild(el('div', { class: 'k-sub', style: 'margin:-2px 0 2px 10px;', text: st.set_no + 'セット目：' + st.note })); });
      });
      return out;
    }
    //   前回
    var last = sorted[0], lo = exOrder(last);
    box.appendChild(el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:8px;' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;' }, [el('div', { class: 'k-h', style: 'margin:0;', text: '前回（' + md(last.session_date) + '）' }), el('div', { class: 'k-sub', text: lo.order.length + '種目・' + (last.sets || []).length + 'セット' })]),
      exRows(last, true)]));
    //   種目ごとの推移
    var exList = [];
    sorted.forEach(function (x) { (x.sets || []).forEach(function (st) { if (exList.indexOf(st.exercise) < 0) exList.push(st.exercise); }); });
    var exSel = exList[0], exCard = el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:10px;' });
    box.appendChild(exCard);
    function drawEx() {
      exCard.innerHTML = '';
      exCard.appendChild(el('div', { class: 'k-h', style: 'margin:0;', text: '種目ごとの推移' }));
      var chips = el('div', { class: 'k-pills', style: 'gap:6px;' });
      exList.forEach(function (ex) { chips.appendChild(el('button', { type: 'button', class: 'k-pill' + (ex === exSel ? ' on' : ''), text: ex, onclick: function () { exSel = ex; drawEx(); } })); });
      exCard.appendChild(chips);
      var st = exerciseStats(sessions, exSel);
      if (!st) return;
      exCard.appendChild(lineChart(st.days.filter(function (x) { return x.v != null; }).map(function (x) { return { d: x.d, v: x.v }; }), null, 'kg'));
      exCard.appendChild(el('div', { class: 'k-sub', style: 'font-size:13px;', text: '自己ベスト ' + st.best.w + 'kg × ' + st.best.r + '（' + md(st.best.d) + '）' }));
    }
    drawEx();
    //   日別の記録（いまは種目から分かる部位で絞る。日のタグは第2弾）
    var dayCard = el('div', { class: 'k-card k-daycard', style: 'display:flex;flex-direction:column;gap:8px;' });
    box.appendChild(dayCard);
    var dayPart = '', openDay = null;
    function drawDays() {
      dayCard.innerHTML = '';
      dayCard.appendChild(el('div', { class: 'k-h', style: 'margin:0;', text: '日別の記録' }));
      var allParts = []; sorted.forEach(function (x) { partsOf(x).forEach(function (pt) { if (allParts.indexOf(pt) < 0) allParts.push(pt); }); });
      var chips = el('div', { class: 'k-pills', style: 'gap:6px;' });
      [''].concat(allParts).forEach(function (pt) { chips.appendChild(el('button', { type: 'button', class: 'k-pill' + (dayPart === pt ? ' on' : ''), text: pt || 'すべて', onclick: function () { dayPart = pt; drawDays(); } })); });
      dayCard.appendChild(chips);
      sorted.filter(function (x) { return !dayPart || partsOf(x).indexOf(dayPart) >= 0; }).forEach(function (x, k, arr) {
        var on = openDay === x.session_id, o = exOrder(x);
        var row = el('div', { style: 'display:flex;flex-direction:column;gap:6px;padding:10px 0;' + (k < arr.length - 1 ? 'border-bottom:1px solid var(--k-line);' : '') });
        row.appendChild(el('button', { type: 'button', class: 'k-dayrow', 'aria-expanded': on ? 'true' : 'false', onclick: function () { openDay = on ? null : x.session_id; drawDays(); } }, [
          el('span', { style: 'font-weight:700;', text: mdw(x.session_date) }), el('span', { class: 'k-sub', text: o.order.length + '種目 ' + (on ? '▾' : '›') })]));
        row.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' }, partsOf(x).map(function (pt) { return el('span', { class: 'k-tag', style: 'border-radius:999px;padding:2px 9px;font-size:12px;', text: pt }); })));
        if (on) {
          row.appendChild(el('div', { class: 'k-sub', text: '担当 ' + trainerName(x.author_trainer_id) }));
          row.appendChild(exRows(x, true));
          if (String(x.author_trainer_id) === String(state.trainerId) || state._isOwner) {
            row.appendChild(el('button', { class: 'k-btn out small k-danger', style: 'align-self:flex-start;', text: '削除', onclick: function () {
              if (!window.confirm(x.session_date + ' の記録を削除しますか？')) return;
              kWrite('k_deleteTraining', { sessionId: x.session_id, rev: x.rev }, newReqId()).then(function (w) {
                if (!w || !w.success) { window.alert(errText(w)); return; }
                open(cur.customerId, cur.name, 'training', null, 'replace');
              });
            } }));
          }
        }
        dayCard.appendChild(row);
      });
    }
    drawDays();
    //   送り直しの画面の「日別の記録を確かめる」：日別の記録へ移って一番新しい日を開く
    cur.showDayView = function () { dayPart = ''; openDay = sorted[0].session_id; drawDays(); dayCard.classList.add('focus'); try { dayCard.scrollIntoView({ block: 'start' }); } catch (e) {} };
    if (wantDay && wantDay === cur.customerId) cur.showDayView();
  }

  // ---------------------------------------------------------------- 指導の履歴（メモ＋変化の理由）
  function noteView(n) {
    var box = el('div', { style: 'display:flex;flex-direction:column;gap:6px;' });
    var tags = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;' });
    if (n.tag) tags.appendChild(el('span', { class: 'k-tag', text: label(TAGS, n.tag) }));
    if (n.condition) tags.appendChild(el('span', { class: 'k-flag grey', text: '体調：' + (COND[n.condition] || n.condition) }));
    if (tags.children.length) box.appendChild(tags);
    if ((n.reasons || []).length) box.appendChild(el('div', { style: 'font-size:13px;', text: '理由：' + n.reasons.map(function (k) { return label(REASONS, k); }).join('・') }));
    if (n.body) box.appendChild(el('div', { style: 'white-space:pre-wrap;font-size:14px;line-height:1.7;', text: n.body }));
    if (n.next_check) box.appendChild(el('div', { style: 'font-size:13px;', text: '次回確かめること：' + n.next_check }));
    if (n.next_plan) box.appendChild(el('div', { style: 'font-size:13px;background:var(--k-cream);border-radius:10px;padding:8px 10px;', text: '次回：' + n.next_plan }));
    return box;
  }

  function noteSub(box, draftData, mode) {
    navPush({ cid: cur.customerId, tab: 'notes', sub: 'note' }, mode);
    box.innerHTML = '';
    //   ★版（タグを送ってよいか）は記入画面を開くたびに読み直す。戻る・読み直しの復元から直接ここへ来ても判定できるように（読めなければ信用しない）
    cur.notesSchema = null;
    var askedFor = cur.customerId;
    kRead('k_notes', { customerId: askedFor }).then(function (r) { if (r && r.success && cur.customerId === askedFor) cur.notesSchema = r.karteSchema; });
    entryHead('指導メモを書く', '指導の履歴に戻る');
    box.appendChild(noteForm(draftData));
  }
  function tabNotes(box, draft) {
    //   ★書くのは上のボタンから専用の記入画面へ（2026-11-05 整理案）
    if (draft && (draft.kind === 'note' || (draft.kind === 'sub' && draft.sub === 'note'))) { noteSub(box, draft.kind === 'note' ? draft.data : null, draft.navMode); return; }
    var reflectOpen = !!(draft && (draft.kind === 'reflect' || draft.kind === 'reflectNote'));
    box.appendChild(el('button', { class: 'k-btn', text: '＋ メモを書く', onclick: function () { noteSub(box, null); } }));
    var rbox = el('div');
    box.appendChild(rbox);
    function showReflect(data) { rbox.innerHTML = ''; rbox.appendChild(reflectForm(data)); }
    if (reflectOpen) showReflect(draft.kind === 'reflectNote' ? draft.data : null);
    else rbox.appendChild(el('button', { class: 'k-btn out', text: '変化の理由を確かめる', onclick: function () { showReflect(null); } }));
    var filt = { tag: '' };
    var chips = el('div', { class: 'k-pills', style: 'gap:6px;' });
    var list = el('div', { class: 'k-tl' });
    box.appendChild(el('div', { class: 'k-h', style: 'margin:6px 0 0;', text: '指導の履歴' }));
    box.appendChild(chips); box.appendChild(list);
    list.appendChild(msg('読み込み中…'));
    //   ★版は毎回読み直す（前に読んだ 31 を、今回の読み取りが失敗したときに信用しない・関門②）
    cur.notesSchema = null;
    var askedFor = cur.customerId;
    kRead('k_notes', { customerId: cur.customerId }).then(function (r) {
      if (!r || !r.success) { list.innerHTML = ''; list.appendChild(msg(errText(r), true)); return; }
      if (cur.customerId === askedFor) cur.notesSchema = r.karteSchema;
      var notes = r.notes || [];
      [['', 'すべて']].concat(TAGS).forEach(function (t) {
        chips.appendChild(el('button', { type: 'button', class: 'k-pill', text: t[1], onclick: function () { filt.tag = t[0]; draw(); } }));
      });
      function draw() {
        Array.prototype.forEach.call(chips.children, function (b, i) { b.className = 'k-pill' + ((i === 0 ? '' : TAGS[i - 1][0]) === filt.tag ? ' on' : ''); });
        list.innerHTML = '';
        var shown = notes.filter(function (n) { return !filt.tag || n.tag === filt.tag; });
        shown.forEach(function (n) {
          var item = el('div', { class: 'k-tl-item' }, [el('div', { class: 'k-tl-dot' }),
            el('div', { class: 'k-sub', text: md(n.session_date) + '・' + trainerName(n.author_trainer_id) + (n.edited_at ? '（編集済み）' : '') })]);
          var c = el('div', { class: 'k-card', style: 'padding:12px;margin-top:6px;' }, [noteView(n)]);
          if (String(n.author_trainer_id) === String(state.trainerId) || state._isOwner) {
            c.appendChild(el('button', { class: 'k-btn out small k-danger', style: 'margin-top:8px;', text: '削除', onclick: function () {
              if (!window.confirm('このメモを削除しますか？')) return;
              kWrite('k_deleteNote', { noteId: n.note_id, rev: n.rev }, newReqId()).then(function (w) {
                if (!w || !w.success) { window.alert(errText(w)); return; }
                open(cur.customerId, cur.name, 'notes', null, 'replace');
              });
            } }));
          }
          item.appendChild(c);
          list.appendChild(item);
        });
        if (!shown.length) list.appendChild(msg(notes.length ? 'このタグのメモはありません。' : 'まだメモがありません。'));
      }
      draw();
    });
  }

  function noteForm(draftData) {
    //   モック K5：社内メモ（お客様には見えません）のカード＋保存は下に固定。日付は見出し（押すと変えられる）
    //   ★体調・次回やることはモックに無いが、概要の「直近の指導」に出る情報なので残す
    var c = el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:10px;' }, [
      el('div', { class: 'k-headrow', style: 'margin:0;' }, [el('div', { style: 'font-size:15px;font-weight:700;', text: '社内メモ' }), el('span', { class: 'k-chip-h', style: 'background:#f0f3f7;color:var(--k-sub);', text: 'お客様には見えません' })])]);
    var d = field('日付', (draftData && draftData.sessionDate) || today(), 'date'); d.el.max = today(); d.el.setAttribute('data-nodirty', '1');
    var hdDate = cur.root && cur.root.querySelector('.k-entrytext'), hdText = cur.root && cur.root.querySelector('.k-entrydate');
    function showDate() { if (hdText) hdText.textContent = (cur.name ? cur.name + ' 様 ／ ' : '') + mdw(d.get() || today()) + ' ▾'; }
    if (hdDate) { d.el.className = 'k-dateover'; d.el.setAttribute('aria-label', 'メモの日付を変える'); hdDate.appendChild(d.el); d.el.addEventListener('change', showDate); showDate(); }
    else c.appendChild(d.row);
    var body = field('', draftData && draftData.body, 'area', { maxlength: '2000', 'aria-label': '社内メモ', placeholder: '話した内容・やったこと' });
    c.appendChild(body.el);
    var tag = pills(TAGS.filter(function (t) { return t[0] !== 'body'; }), draftData && draftData.tag ? [draftData.tag] : [], { single: true });
    c.appendChild(tag.el);
    var cond = pills([['good', '体調：良い'], ['normal', '体調：普通'], ['bad', '体調：悪い']], draftData && draftData.condition ? [draftData.condition] : [], { single: true });
    c.appendChild(cond.el);
    var next = field('次回やること', draftData && draftData.nextPlan, 'area', { maxlength: '500' });
    c.appendChild(next.row);
    c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }));
    var reqId = newReqId();
    var bar = el('div', { class: 'k-savebar' });
    bar.appendChild(el('button', { class: 'k-btn', text: '保存する', onclick: function () {
      var data = { sessionDate: d.get(), tag: tag.get()[0] || '', condition: cond.get()[0] || '', body: body.get(), nextPlan: next.get() };
      if (!data.condition && !data.body && !data.nextPlan) { window.alert('体調か内容を入れてください。'); return; }
      //   タグは新しい項目＝古い Worker では捨てられる。タグを付けたときだけ版を確かめる（タグなしのメモは古い Worker でも同じ意味で残る）
      if (data.tag && !schemaOk({ karteSchema: cur.notesSchema })) { window.alert(SCHEMA_MSG); return; }
      var params = { customerId: cur.customerId }; for (var k in data) params[k] = data[k];
      kWrite('k_addNote', params, reqId, { kind: 'note', data: data }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        open(cur.customerId, cur.name, 'notes', null, 'replace');
      });
    } }));
    bar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: '保存すると「指導の履歴」の画面に戻ります' }));
    return el('div', { style: 'display:flex;flex-direction:column;gap:12px;' }, [c, bar]);
  }

  function reflectForm(draftData) {
    var dd = draftData || {};
    var c = card('変化の理由を確かめる', [msg('体組成の変化について、当てはまる理由を選び、次回の方針を残します。')]);
    var groups = {};
    REASON_GROUPS.forEach(function (g) {
      var tbl = REASONS.filter(function (x) { return x[2] === g[0]; });
      groups[g[0]] = pills(tbl, (dd.reasons || []).filter(function (k) { return tbl.some(function (x) { return x[0] === k; }); }));
      c.appendChild(el('div', { class: 'k-sub', style: 'font-weight:700;margin:8px 0 6px;', text: g[1] }));
      c.appendChild(groups[g[0]].el);
    });
    c.appendChild(el('div', { style: 'height:12px;' }));
    var chk = field('次回確かめること', dd.nextCheck, 'text', { maxlength: '500' });
    var plan = field('次回の方針', dd.nextPlan, 'text', { maxlength: '500' });
    c.appendChild(chk.row); c.appendChild(plan.row);
    var reqId = newReqId();
    c.appendChild(el('button', { class: 'k-btn', text: '履歴に残す', onclick: function () {
      var reasons = []; REASON_GROUPS.forEach(function (g) { reasons = reasons.concat(groups[g[0]].get()); });
      var data = { sessionDate: today(), tag: 'body', reasons: reasons, nextCheck: chk.get(), nextPlan: plan.get() };
      if (!reasons.length && !data.nextCheck && !data.nextPlan) { window.alert('理由か方針を入れてください。'); return; }
      if (!schemaOk({ karteSchema: cur.notesSchema })) { window.alert(SCHEMA_MSG); return; }
      var params = { customerId: cur.customerId }; for (var k in data) params[k] = data[k];
      kWrite('k_addNote', params, reqId, { kind: 'reflectNote', data: data }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        open(cur.customerId, cur.name, 'notes', null, 'replace');
      });
    } }));
    return c;
  }

  // ---------------------------------------------------------------- 契約
  //   契約・会員（2026-11-05 整理：契約の一覧＋末尾に「管理」＝同意の記録・退会と再入会の記録。概要から移した）
  //   ★契約が読めない（担当外）・契約が無いときも「管理」は出す（同意の記録は従来どおり誰でも・退会と再入会は担当だけ＝従来の条件のまま）
  function tabContract(box) {
    box.appendChild(msg('読み込み中…'));
    var askedFor = cur.customerId;
    Promise.all([kRead('k_contract', { customerId: askedFor }), loadSummary()]).then(function (rs) {
      if (cur.customerId !== askedFor || cur.tab !== 'contract') return;
      var r = rs[0], sm = rs[1];
      box.innerHTML = '';
      box.appendChild(el('div', { class: 'k-sub', style: 'letter-spacing:.08em;padding:0 2px;', text: '契約' }));
      if (r && r.code === 'FORBIDDEN') box.appendChild(msg('担当外のお客様の契約は表示されません。'));
      else if (!r || !r.success) box.appendChild(msg(errText(r), true));
      else if (!(r.contracts || []).length) box.appendChild(msg('契約の記録が見つかりませんでした。'));
      else r.contracts.forEach(function (c) {
        var d0 = c.startMs ? new Date(c.startMs + 9 * 3600000).toISOString().slice(0, 10) : '?';
        var d1 = c.endMs ? new Date(c.endMs + 9 * 3600000).toISOString().slice(0, 10) : '';
        var nowMs = Date.now(), live = c.startMs && c.startMs <= nowMs && (!c.endMs || nowMs <= c.endMs + 86400000);   // 終了日の当日いっぱいは有効
        box.appendChild(el('div', { class: 'k-card' }, [
          el('div', { style: 'display:flex;justify-content:space-between;align-items:center;gap:8px;margin-bottom:4px;' }, [
            el('div', { class: 'k-h', style: 'margin:0;', text: [c.type, c.course].filter(Boolean).join('・') || '契約' }),
            live ? el('span', { class: 'k-chip-h', text: 'いま有効' }) : null]),
          el('div', { class: 'k-sub', text: d0 + ' 〜 ' + (d1 || '（期限なし）') }),
          el('div', { style: 'font-size:14px;margin-top:4px;', text: (c.freq ? '月' + c.freq + '回　' : '') + (c.tickets ? 'チケット' + c.tickets + '枚　' : '') + (c.trainer ? '担当：' + c.trainer : '') })
        ]));
      });
      //   管理（ときどき使う記録）
      if (!sm || !sm.success) return;
      var adm = el('div', { class: 'k-admin' }, [el('div', { class: 'k-h', style: 'margin:0;color:var(--k-sub);', text: '管理（ときどき使う記録）' })]);
      var cs = sm.consent ? sm.consent.state : 'none';
      var cAt = sm.consent && typeof sm.consent.changedAt === 'number' ? (function (t) { return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); })(new Date(sm.consent.changedAt + 9 * 3600000)) : '';
      var cHow = sm.consent && sm.consent.method === 'paper' ? '（紙）' : (sm.consent && sm.consent.method === 'line' ? '（LINE）' : '');
      adm.appendChild(el('div', {}, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;' }, [
          el('div', { style: 'font-size:14px;font-weight:700;', text: '健康情報の取り扱いの同意' }),
          el('div', { style: 'font-size:12px;color:' + (cs === 'agreed' ? 'var(--k-acc)' : 'var(--k-warn)') + ';', text: cs === 'agreed' ? '同意済み ' + cAt + cHow : (cs === 'revoked' ? '撤回済み ' + cAt : '同意待ち') })]),
        consentRow(sm.consent)]));
      if (sm.assigned) adm.appendChild(membershipCard());
      box.appendChild(adm);
    });
  }

  // ---------------------------------------------------------------- お客様の見え方（設計35 C2）
  //   k_memberPreview の応答（会員の c_myKarte と同じ形＋枚の mnoteId・rev・sessionId・authorIsMe）を、会員の画面と同じ部品（index.html の MemberKarteView）で描く
  //   ★「直す」「消す」は書いた本人（authorIsMe）かオーナーだけ。消すは確かめてから
  //   ★表示は部品の中で textContent（ここでは HTML を組み立てない）
  var PREVIEW_TABS = [['home', '概要'], ['body', '体組成'], ['training', 'トレーニング'], ['notes', '指導の履歴'], ['contract', '契約']];
  function memberPreviewSub(box, mode, tab0) {
    navPush({ cid: cur.customerId, tab: 'summary', sub: 'mpreview' }, mode);
    box.innerHTML = '';
    cur.dirty = false;
    entryHead('お客様の見え方', '概要に戻る');
    var askedFor = cur.customerId, tab = tab0 || 'home', data = null, ui = { metric: 'weight', ex: '', openDay: '' };
    var seg = el('div', { class: 'k-pills', style: 'gap:6px;', role: 'tablist' });
    var area = el('div', { class: 'k-mpreview', style: 'display:flex;flex-direction:column;gap:10px;' });
    box.appendChild(el('div', { class: 'k-sub', text: 'お客様の画面と同じ組み立てで出しています。「お客様へ」は保存した時点でお客様に見えます。' }));
    box.appendChild(seg); box.appendChild(area);
    function reload() { memberPreviewSub(box, 'none', tab); }
    function draw() {
      seg.innerHTML = '';
      PREVIEW_TABS.forEach(function (p) {
        seg.appendChild(el('button', { type: 'button', role: 'tab', class: 'k-pill' + (p[0] === tab ? ' on' : ''), 'aria-selected': p[0] === tab ? 'true' : 'false', text: p[1], onclick: function () { tab = p[0]; draw(); } }));
      });
      area.innerHTML = '';
      if (!window.MemberKarteView) { area.appendChild(msg('表示の部品が読み込まれていません。画面を開き直してください。', true)); return; }
      if (!data) { area.appendChild(msg('読み込み中…')); return; }
      if (!data.success) { area.appendChild(msg(errText(data), true)); return; }
      window.MemberKarteView.tab(area, data, tab, { ui: ui, goTab: function (t2) { tab = t2; draw(); }, noteActions: noteActions, showTagOnly: true,
        remainNote: '残り回数は、お客様の画面ではここに出ます（予約画面の残数と同じ）。' });
    }
    //   枚の操作（指導の履歴のタブ）
    function noteActions(n, cardEl) {
      if (!n || !n.mnoteId || !(n.authorIsMe === true || (window.state && state._isOwner))) return null;
      return el('div', { style: 'display:flex;gap:12px;margin-top:4px;' }, [
        el('button', { type: 'button', class: 'k-btn out small', text: '直す', 'aria-label': md(n.date) + 'のお客様への欄を直す', onclick: function () { editNote(n, cardEl); } }),
        el('button', { type: 'button', class: 'k-btn out small k-danger', style: 'margin-left:auto;', text: '消す', 'aria-label': md(n.date) + 'のお客様への欄を消す', onclick: function () {
          if (!window.confirm(md(n.date) + ' の「お客様へ」を消しますか？\nお客様の画面からも消えます。')) return;
          kWrite('k_deleteMemberNote', { mnoteId: n.mnoteId, rev: n.rev }, newReqId()).then(function (w) {
            if (!w || !w.success) { window.alert(errText(w)); return; }
            if (cur.customerId === askedFor) reload();
          });
        } })]);
    }
    //   日のタグ：その枚の tags だけを使う（日付から推測しない＝同じ日に2回あっても取り違えない・Codex 関門②）。
    //     載っていなければ null＝この画面ではタグを直させない（空から作って上書きしない）
    function tagsOf(n) { return Array.isArray(n.tags) ? n.tags.slice() : null; }
    function editNote(n, cardEl) {
      var known = tagsOf(n);
      //   タグを直せるのは、タグが分かっていて、トレーニングに付いた枚だけ（トレーニングの無い枚のタグは会員に出ない）
      var tagsEditable = !!known && !!n.sessionId;
      var m = { message: String(n.message || ''), todo: (Array.isArray(n.todo) ? n.todo : []).concat(['', '', '']).slice(0, MEMBER_MAX.todo), tags: (known || []).filter(function (x) { return DAY_TAGS.indexOf(x) >= 0; }) };
      var reqId = newReqId(), busy = false, tagsTouched = false;   // ★編集は送った鍵だけ置き換わる＝タグは触ったときだけ送る
      cardEl.innerHTML = '';
      cardEl.appendChild(el('div', { style: 'font-size:14px;font-weight:700;color:var(--k-acc);', text: md(n.date) + ' のお客様に見える欄を直す' }));
      var ta = el('textarea', { rows: '4', maxlength: String(MEMBER_MAX.message), 'aria-label': 'お客様へ', class: 'k-memo' }); ta.value = m.message;
      ta.oninput = function () { m.message = ta.value; };
      cardEl.appendChild(ta);
      m.todo.forEach(function (v, i) {
        var ti = el('input', { type: 'text', maxlength: String(MEMBER_MAX.todoLen), 'aria-label': '次回までに ' + (i + 1) + 'つ目', autocomplete: 'off', style: 'box-sizing:border-box;width:100%;min-height:44px;border:1px solid #8692a6;border-radius:10px;padding:0 10px;font-size:16px;background:#fff;font-family:inherit;' });
        ti.value = v || ''; ti.oninput = function () { m.todo[i] = ti.value; };
        cardEl.appendChild(ti);
      });
      var tg = el('div', { class: 'k-pills', style: 'gap:6px;' });
      function drawTags() {
        tg.innerHTML = '';
        DAY_TAGS.forEach(function (x) {
          var onT = m.tags.indexOf(x) >= 0;
          tg.appendChild(el('button', { type: 'button', class: 'k-pill' + (onT ? ' on' : ''), 'aria-pressed': onT ? 'true' : 'false', text: x, onclick: function () {
            var k = m.tags.indexOf(x);
            if (k >= 0) m.tags.splice(k, 1); else { if (m.tags.length >= MEMBER_MAX.tags) { window.alert('日のタグは' + MEMBER_MAX.tags + 'つまでです。'); return; } m.tags.push(x); }
            tagsTouched = true; drawTags();
          } }));
        });
      }
      if (tagsEditable) { drawTags(); cardEl.appendChild(tg); }
      var saveB = el('button', { type: 'button', class: 'k-btn', text: '保存する', onclick: function () {
        if (busy) return;
        var mem = memberOf(m);
        if (!mem) { window.alert('空にするときは「消す」を使ってください。'); return; }
        if (!n.sessionId && !mem.message && !(mem.todo && mem.todo.length)) { window.alert('トレーニングの記録が無い日は、「お客様へ」か「次回までに」を残してください。消すときは「消す」を使ってください。'); return; }
        busy = true; saveB.textContent = '送信中…';
        var body = { mnoteId: n.mnoteId, rev: n.rev, message: mem.message, todo: mem.todo };   // 本文の最上位に置く（member で包まない）
        if (tagsTouched) body.tags = mem.tags;
        kWrite('k_saveMemberNote', body, reqId).then(function (w) {
          busy = false; saveB.textContent = '保存する';
          if (!w || w.code === 'BAD_RESPONSE') { window.alert('結果を確かめられませんでした。もう一度「保存する」を押すと同じ内容で送ります（二重にはなりません）。'); return; }
          if (w.code === 'BAD_STATE') { window.alert('全部を空にするときは「消す」を使ってください。'); return; }
          if (!w.success) { window.alert(errText(w)); return; }
          if (cur.customerId === askedFor) reload();
        }, function () { busy = false; saveB.textContent = '保存する'; window.alert('結果を確かめられませんでした。もう一度「保存する」を押すと同じ内容で送ります（二重にはなりません）。'); });
      } });
      cardEl.appendChild(el('div', { class: 'k-grid2', style: 'margin-top:4px;' }, [saveB, el('button', { type: 'button', class: 'k-btn out', text: 'やめる', onclick: function () { cur.dirty = false; draw(); } })]));
      cardEl.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '保存するとお客様の画面にそのまま出ます。痛み・診断・社内のことは書かない' }));
    }
    draw();
    kRead('k_memberPreview', { customerId: askedFor }).then(function (r) {
      if (cur.customerId !== askedFor || !area.isConnected) return;   // ★頼んだお客様＝いまのお客様のときだけ
      data = r || { success: false, code: 'BAD_RESPONSE' };
      draw();
    });
  }

  // ---------------------------------------------------------------- 一覧
  var FLAG = {
    caution: ['注意あり', null, 'soft'],
    noNextBooking: ['次の予約なし', '予約の同期を確認中'],
    recordStale: ['記録が30日以上ない', '記録の準備中'],
    contractEnding: ['契約の終了が近い', '契約を確認中'],
    paymentPending: ['支払い待ち', '残数を確認中'],
    hearingMissing: ['ヒアリング未記入', null, 'soft'],
    consentPending: ['同意待ち', null, 'soft']
  };
  //   声かけの印（並べ替えに使う）。注意・未記入・同意待ちは並べ替えに入れない（毎回上に来てしまう）
  var CALL_FLAGS = ['noNextBooking', 'recordStale', 'contractEnding', 'paymentPending'];
  function openBoard(after, acc, mode) {
    if (!after) navPush({ board: 1 }, mode);   // 「さらに表示」は積まない
    var root = ensureRoot(); root.innerHTML = ''; root.classList.remove('k-entry');
    var wrap = el('div', { class: 'k-wrap' });
    wrap.appendChild(el('div', { class: 'k-head' }, [el('div', { class: 'k-head-row' }, [
      el('button', { class: 'k-back', 'aria-label': 'カルテを閉じる', text: '←', onclick: exitKarte }),
      el('div', { class: 'k-name', style: 'flex:1;', text: 'カルテの一覧' })])]));
    var filt = el('div', { class: 'k-pills', style: 'gap:6px;padding:12px 14px 0;' });
    var list = el('div', { class: 'k-body' });
    wrap.appendChild(filt); wrap.appendChild(list); root.appendChild(wrap);
    list.appendChild(msg('読み込み中…'));
    kRead('k_board', after ? { after: after } : {}).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.success) { list.appendChild(msg(errText(r), true)); return; }
      var all = (acc || []).concat(r.customers || []);
      all.sort(function (a, b) { return score(b.flags) - score(a.flags); });
      var mode = 'call';
      [['call', '声かけが要る'], ['hearing', 'ヒアリング未記入'], ['all', 'すべて']].forEach(function (m) {
        filt.appendChild(el('button', { type: 'button', class: 'k-pill', text: m[1], onclick: function () { mode = m[0]; draw(); } }));
      });
      function draw() {
        Array.prototype.forEach.call(filt.children, function (b, i) { b.className = 'k-pill' + (['call', 'hearing', 'all'][i] === mode ? ' on' : ''); });
        Array.prototype.slice.call(list.querySelectorAll('.k-card,.k-msg,.k-btn')).forEach(function (n) { n.remove(); });
        var shown = all.filter(function (c) { return mode === 'all' || (mode === 'call' ? score(c.flags) > 0 : c.flags.hearingMissing === true); });
        shown.forEach(function (c) {
          var tags = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:8px;' });
          Object.keys(FLAG).forEach(function (k) {
            var v = c.flags[k];
            if (v === true) tags.appendChild(el('span', { class: 'k-flag' + (FLAG[k][2] ? ' ' + FLAG[k][2] : ''), text: FLAG[k][0] }));
            else if (k === 'recordStale' && v === 'none') tags.appendChild(el('span', { class: 'k-flag', text: '体組成の記録なし' }));
            else if (typeof v === 'string' && v !== 'none' && FLAG[k][1]) tags.appendChild(el('span', { class: 'k-flag grey', text: FLAG[k][1] }));
          });
          var initial = String(c.name || '').slice(0, 1);
          list.appendChild(el('div', { class: 'k-card', style: 'cursor:pointer;', role: 'button', tabindex: '0', onclick: function () { open(c.customerId, c.name, 'summary'); } }, [
            el('div', { style: 'display:flex;align-items:center;gap:10px;' }, [
              el('div', { style: 'width:40px;height:40px;border-radius:20px;background:var(--k-acc-l);color:var(--k-acc);display:flex;align-items:center;justify-content:center;font-weight:700;', text: initial }),
              el('b', { style: 'flex:1;min-width:0;font-size:15px;', text: c.name + ' 様' })]), tags]));
        });
        if (!shown.length) list.appendChild(msg(all.length ? 'この条件のお客様はいません。' : '対象のお客様がいません。'));
        if (r.next) list.appendChild(el('button', { class: 'k-btn out', text: 'さらに表示', onclick: function () { openBoard(r.next, all); } }));
      }
      draw();
    });
  }
  function score(f) { var s = 0; CALL_FLAGS.forEach(function (k) { if (f[k] === true || (k === 'recordStale' && f[k] === 'none')) s++; }); return s; }

  // ---------------------------------------------------------------- 読み直した後に戻す
  function resume() {
    var raw = null;
    try { raw = sessionStorage.getItem(DRAFT_KEY); } catch (e) {}
    if (!raw) return;
    var d; try { d = JSON.parse(raw); } catch (e) { d = null; }
    try { sessionStorage.removeItem(DRAFT_KEY); } catch (e) {}
    //   ★戻さないときも読み直し済みの印を消す（残ると、次にトークンが古くなったとき読み直しが永久に止まる）
    if (!d || !d.customerId || Date.now() - Number(d.at || 0) > 30 * 60 * 1000) { try { sessionStorage.removeItem('karte_reauth'); } catch (e) {} return; }
    var tries = 0;
    (function wait() {
      //   トレーナーの起動（state.trainerId）が済むのを待つ
      if (window.state && state.trainerId) {
        //   ★読み直す前の履歴がそのまま残っている＝積み足さず置き換える（戻る回数を増やさない）
        var m = navState() ? 'replace' : undefined;
        if (d.draft && m) d.draft.navMode = 'replace';
        open(d.customerId, d.name, d.tab, d.draft, m);
        try { sessionStorage.removeItem('karte_reauth'); } catch (e) {}
        window.alert('ログインを更新しました。入力内容を戻したので、もう一度「保存」を押してください。');
        return;
      }
      if (++tries < 40) setTimeout(wait, 500);
      else { try { sessionStorage.removeItem('karte_reauth'); } catch (e) {} }
    })();
  }

  window.KarteUI = { open: open, openBoard: openBoard, build: KARTE_BUILD,
    //   検査用（純粋な部分だけ）
    _t: { NEED_SCHEMA: NEED_SCHEMA, memberOf: memberOf, DAY_TAGS: DAY_TAGS, buildPayload: buildPayload, prevSession: prevSession, prevOfExercise: prevOfExercise, partsSince: partsSince, dayDiff: dayDiff, assess: assess, partOf: partOf, exerciseStats: exerciseStats, PURPOSES: PURPOSES, SLIM_AREAS: SLIM_AREAS, REGIONS: REGIONS, TAGS: TAGS, REASONS: REASONS } };
  resume();
})();
