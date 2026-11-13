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
  var KARTE_BUILD = '2026-11-12a 録音の文字起こしを AI で振り分けた下書き（設計39・切替が開いたトレーナーだけ）';
  var DRAFT_KEY = 'karte_draft_v1';
  //   この画面が必要とする Worker の版。古い Worker には新しい項目を送らない（黙って捨てられるため）
  var NEED_SCHEMA = 32;   // 32＝お客様に見える欄（設計35 C2・Codex 関門②：新しい画面×古い Worker で欄が session から切り離された）
  var SCHEMA_MSG = 'システムの更新中です。少し時間をおいて、カルテを開き直してから保存してください（入力はまだ保存されていません）。';
  function schemaOk(r) { return !!(r && typeof r.karteSchema === 'number' && r.karteSchema >= NEED_SCHEMA); }
  //   新しい鍵（doneOnly・assist・forced・drops）を使う保存だけが要求する版（設計38 I68）。全体の NEED_SCHEMA は 32 のまま
  //   ★サーバーの受付の切替（KARTE_TRAINING_EXT）が off／未許可なら Worker は 32 を返す＝取り込みのボタン・補助などの欄が消える
  var NEED_SCHEMA_EXT = 33;
  var EXT_SCHEMA_MSG = 'この形の保存（補助・無理やり・ドロップ・数字だけの種目）は、いまは使えません。入力は残っています。印を外せば保存できます（カルテを開き直すと使えるようになる場合があります）。';
  function extOk() { return typeof cur.trSchema === 'number' && cur.trSchema >= NEED_SCHEMA_EXT; }
  /**
   * 送る中身が新しい鍵を1つでも使っているか（I68）。★Worker と同じく「値ではなく鍵があるか」で決める
   *   （drops: [] でも使った扱い）。判定は payload の中身だけで行う（画面の状態や「取り込みから来たか」では決めない）
   */
  function usesExt(payload) {
    function has(o, k) { return !!o && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k); }
    return ((payload && Array.isArray(payload.items)) ? payload.items : []).some(function (it) {
      return has(it, 'doneOnly') || (Array.isArray(it && it.sets) && it.sets.some(function (st) { return has(st, 'assist') || has(st, 'forced') || has(st, 'drops'); }));
    });
  }
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
  //   部位の鍵と表示名（鍵は worker/src/lib/karte-exercises.js の EXERCISE_PARTS・表の CHECK と同じ＝検査で一致を確かめる）
  var PART_KEYS = [['chest', '胸'], ['legs', '脚・尻'], ['back', '背中'], ['shoulder', '肩'], ['arm', '腕'], ['core', '体幹'], ['other', 'その他']];
  //   種目名からの推定（共有の一覧に部位が無いときだけ使う）。上から順に当てる（「ショルダープレス」「プレスダウン」「レッグレイズ」を胸・脚に取られないよう、胸は最後）
  var PART_RULES = [['core', /プランク|クランチ|腹筋|レッグレイズ|ドローイン|デッドバグ/],
    ['legs', /スクワット|レッグ|ランジ|ヒップ|デッドリフト|ブルガリアン|カーフ|アダクション|アブダクション/],
    ['back', /ラット|ロウ|懸垂|プルダウン|背筋|プルオーバー/],
    ['shoulder', /ショルダー|サイドレイズ|リアレイズ|フロントレイズ|アップライト/], ['arm', /カール|トライセプス|キックバック|プレスダウン/],
    ['chest', /ベンチ|チェスト|プレス|フライ|腕立て|ディップス/]];
  //   共有の種目の一覧（k_exercises）：名前 → 部位の鍵（null＝まだ分類していない）。トレーニングのタブを開くたびに読み直す
  var exMaster = {};
  var exTruncated = false;   // k_exercises が上限で切れている（画面に「一部だけ表示」と出す）
  var EX_NAME_MAX = 50;
  function exName(v) { return String(v == null ? '' : v).trim(); }   // Worker の normalizeExerciseName と同じ（前後の空白だけ・50字）
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
    '#karteRoot .k-rtg{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid #8692a6;background:#fff;color:#3f4550;font-size:13px;font-family:inherit;}',
    '#karteRoot .k-rtg[aria-pressed=true]{border:1.5px solid var(--k-acc);background:var(--k-acc-l);color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-note-hint{font-size:12px;color:var(--k-warn);background:var(--k-warn-l);border-radius:8px;padding:6px 10px;margin-bottom:10px;}',
    //   ---- 設計38：メモから取り込む・補助/無理やり/ドロップ/実施
    //   畳んだ種目の行：開くボタンの右に「全部✓」「実施した」（1種目1タップで確かめる）
    '#karteRoot .k-exline{display:flex;align-items:stretch;gap:8px;margin-bottom:10px;}',
    '#karteRoot .k-exline .k-excol{margin-bottom:0;flex:1;min-width:0;}',
    '#karteRoot .k-allchk{min-width:64px;min-height:44px;padding:0 10px;border-radius:12px;border:1.5px solid var(--k-acc);background:var(--k-acc-l);color:var(--k-acc);font-size:14px;font-weight:700;font-family:inherit;white-space:nowrap;}',
    '#karteRoot .k-donechk{min-width:48px;min-height:48px;padding:0 12px;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;white-space:nowrap;background:#fff;color:#5b6661;border:1px solid #8692a6;}',
    '#karteRoot .k-donechk[aria-pressed=true]{background:#243b66;color:#fff;border-color:#243b66;}',
    '#karteRoot .k-frommemo{font-size:11px;padding:2px 8px;border-radius:999px;background:var(--k-gold-l);color:#6b5427;white-space:nowrap;}',
    '#karteRoot .k-marks{margin:-2px 0 6px 28px;font-size:12px;color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-extrow{display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-top:8px;}',
    '#karteRoot .k-extrow input{width:88px !important;}',
    '#karteRoot .k-setrow.k-droprow{grid-template-columns:22px minmax(0,1fr) minmax(0,1fr) minmax(0,1fr) 44px;margin:6px 0 0;}',
    '#karteRoot .k-dropadd{min-height:44px;padding:0 14px;border-radius:10px;border:1px dashed var(--k-acc);background:#fff;color:var(--k-acc);font-size:14px;font-family:inherit;margin-top:6px;}',
    '#karteRoot .k-imp textarea{font-size:16px;}',
    '#karteRoot .k-impcard{display:flex;flex-direction:column;gap:8px;}',
    '#karteRoot .k-impcard .k-imptext{white-space:pre-wrap;background:var(--k-cream);border:1px solid var(--k-line);border-radius:10px;padding:8px 10px;font-size:14px;}',
    '#karteRoot .k-impbtns{display:flex;flex-direction:column;gap:8px;}',
    '#karteRoot .k-impbtns .k-btn{margin:0;}',
    '#karteRoot .k-impcard input[type=text]{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #8692a6;border-radius:10px;padding:0 10px;font-size:16px;background:#fff;font-family:inherit;}'
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
    EXISTS: 'この記録には、すでにお客様に見える欄があります。「お客様の見え方」から直してください。',
    STALE: 'ログインの更新が必要です。LINE から開き直してください（入力内容は端末に残っています）。',
    EX_LIMIT: '種目の登録は500件までです。',
    TRAINING_EXT_OFF: 'この形の保存はまだ使えません（補助・無理やり・ドロップ・数字だけの種目）。入力は残っています。印を外せば保存できます。'
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
  //   ★送る前に手元のトークンの発行時刻を見る。9分を超えていたら送らずに取り直す（Worker は10分超を 401 で断る＝I46・2026-11-06）
  function kWrite(action, params, reqId, draft) {
    adoptFreshToken();
    if (tokenNeedsRefresh()) return reauth(draft);
    var body = { action: action, idToken: idToken, clientReqId: reqId };
    for (var k in params) body[k] = params[k];
    return post(body).then(function (r) {
      if (r && r.code === 'UNAUTHORIZED') {
        var fresh = (window.liff && liff.getIDToken) ? (liff.getIDToken() || '') : '';
        if (fresh && fresh !== idToken) { idToken = fresh; body.idToken = fresh; return post(body).then(function (r2) { return Promise.resolve(handleStale(r2, draft)).then(doneWrite); }); }
        return handleStale(r, draft);
      }
      return doneWrite(r);
    });
  }
  //   新しいトークンで書けた＝読み直しの印を消す（次にトークンが古くなったら、また1回だけ読み直せる）
  function doneWrite(r) { if (r && r.success) { try { sessionStorage.removeItem(REAUTH_KEY); } catch (e) {} } return r; }
  //   ---- トークンの鮮度（画面の側の見積もり。最終の判定は Worker）
  var TOKEN_REFRESH_S = 3540;         // 59分。Worker の上限（KARTE_LIMITS.TOKEN_MAX_AGE_S=3600・決定0142）より1分早く取り直す
  var REAUTH_KEY = 'karte_reauth';    // 読み直し済みの印（sessionStorage・中身は印を付けた時刻）
  var REAUTH_TTL = 10 * 60 * 1000;    // 印が効くのは10分（それより前の印は無いものとして扱う）
  function adoptFreshToken() {
    try { var f = (window.liff && liff.getIDToken) ? (liff.getIDToken() || '') : ''; if (f && f !== idToken) idToken = f; } catch (e) {}
  }
  /** 送るトークンの iat（秒）。読めなければ null（＝画面では判定しない・送って Worker に任せる） */
  function tokenIat() {
    try {
      //   LIFF が持っているトークンが送るものと同じなら、LIFF の読み解きを使う
      if (window.liff && typeof liff.getDecodedIDToken === 'function' && liff.getIDToken && liff.getIDToken() === idToken) {
        var dd = liff.getDecodedIDToken();
        if (dd && typeof dd.iat === 'number') return dd.iat;
      }
    } catch (e) {}
    try {
      var p = String(idToken || '').split('.');
      if (p.length !== 3) return null;
      var s = p[1].replace(/-/g, '+').replace(/_/g, '/');
      while (s.length % 4) s += '=';
      var o = JSON.parse(atob(s));
      return (o && typeof o.iat === 'number') ? o.iat : null;
    } catch (e) { return null; }
  }
  function reauthMarked() {
    try {
      var v = Number(sessionStorage.getItem(REAUTH_KEY) || 0), age = Date.now() - v;
      if (v > 0 && age >= 0 && age < REAUTH_TTL) return true;
      if (v > 0 && age < 0) sessionStorage.removeItem(REAUTH_KEY);   // ★未来の時刻（時計を戻した等）は無効にして消す＝印が永久に効かない
      return false;
    } catch (e) { return false; }
  }
  /**
   * 送る前に取り直すか。★読み直したばかり（印が効いている）なら画面では判定しない＝そのまま送る
   *   （端末の時計が進んでいると、新しいトークンでも古く見えて読み直しが止まらないため。判定は Worker の 401 に任せる）
   */
  function tokenNeedsRefresh() {
    var iat = tokenIat();
    if (iat == null || reauthMarked()) return false;
    return (Date.now() / 1000 - iat) > TOKEN_REFRESH_S;
  }
  //   ★トークンが古い（発行から10分超）＝入力を退避して取り直す。読み直しても同じなら、開き直しを案内
  function handleStale(r, draft) {
    if (!r || r.code !== 'UNAUTHORIZED') return r;
    return reauth(draft);
  }
  //   取り直し：入力を端末に退避 → LINE からいったんログアウト → 読み直し（liff.init が新しいトークンを取る）
  //     ★logout は LINE アプリの外（PC 等の外部ブラウザ）だけ。LINE アプリの中で logout すると LINE のログインを経由して
  //       最初のページに戻ってしまった（2026-11-06 オーナーの実機・決定0142）。アプリの中は読み直しだけ（index.html の _apiGas と同じ）
  //     ★印（REAUTH_KEY）は新しいトークンで書けたときに消す（doneWrite）。印が効いているあいだにまた古ければ案内（入力は端末に残る）
  function reauth(draft) {
    //   ★トレーニングの送信中に別の顧客を開いていたら、読み直さない（その顧客の画面を奪わない・下書きの pending は端末に残る）
    if (draft && draft.kind === 'training' && draft.customerId && draft.customerId !== cur.customerId) return Promise.resolve({ success: false, code: 'BAD_RESPONSE' });
    try {
      if (!reauthMarked()) {
        sessionStorage.setItem(REAUTH_KEY, String(Date.now()));
        var isTr = !!(draft && draft.kind === 'training');
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ customerId: isTr ? draft.customerId : cur.customerId, name: '', tab: (draft && draft.tab) || (isTr ? 'training' : cur.tab), draft: isTr ? (draft.ex ? { kind: 'training', ex: draft.ex } : { kind: 'training' }) : (draft || null), at: Date.now() }));   // ★氏名は残さない（どの画面も・開き直したら概要から取る）。トレーニングの中身は下書き（localStorage）にある
        try { if (window.liff && typeof liff.logout === 'function' && typeof liff.isInClient === 'function' && liff.isInClient() === false) liff.logout(); } catch (e) {}
        reloadPage();
        return new Promise(function () {});
      }
    } catch (e) {}
    return Promise.resolve({ success: false, code: 'STALE', message: ERR.STALE });
  }
  /** 送る前に取り直しが要るか（トレーニングの保存が下書きに「送信中」を固定する前に確かめる＝送っていないのに「結果が分からない」にしない） */
  function needReauthBeforeSend() { adoptFreshToken(); return tokenNeedsRefresh(); }
  //   読み直しは1か所（検査では window.__karteReload で差し替える）
  //   退避した入力が「いま開いている顧客」のものか（読み直し後に戻すときに照合する）
  function draftFor(draft, kind) { return !!(draft && draft.kind === kind && draft.cid && draft.cid === cur.customerId); }
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
    if (draft && draft.kind === 'sub' && draft.sub === 'mpreview') { memberPreviewSub(box, draft.navMode, draft.edit && draft.cid === cur.customerId ? 'notes' : null, draft.edit && draft.cid === cur.customerId ? draft.edit : null); return; }   // 戻る・進む・送り直しの画面から
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
      var lbl = stateTo === 'agreed' ? '同意を記録しますか？（' + (method === 'paper' ? '紙の同意書' : 'LINE') + '）'
        : '同意の撤回を記録しますか？\n★記録済みの健康情報は削除され、元に戻せません。' + (consent && consent.byMember ? '\n（会員画面でご本人が同意した記録です。ご本人の申し出を確かめてから記録してください）' : '');
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

  //   録音と AI の記録作成の同意（設計44）。表示と「撤回を記録」だけ（同意は会員本人が会員画面で。トレーナーは記録できない）
  function recConsentRow(rc) {
    var s = rc && rc.state ? rc.state : 'unknown';
    var at = rc && typeof rc.changedAt === 'number' ? (function (t) { return (t.getUTCMonth() + 1) + '/' + t.getUTCDate(); })(new Date(rc.changedAt + 9 * 3600000)) : '';
    var txt = s === 'agreed' ? '同意済み ' + at + (rc.byMember ? '（会員画面）' : '') : (s === 'revoked' ? '撤回済み ' + at : (s === 'none' ? '未回答（会員画面で同意できます）' : '確認できませんでした'));
    var box = el('div', { class: 'k-reccons', style: 'margin-top:12px;' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;' }, [
        el('div', { style: 'font-size:14px;font-weight:700;', text: '録音と AI の記録作成の同意' }),
        el('div', { style: 'font-size:12px;color:' + (s === 'agreed' ? 'var(--k-acc)' : 'var(--k-warn)') + ';', text: txt })])]);
    if (s === 'agreed') {
      box.appendChild(el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;' }, [
        el('button', { class: 'k-btn out small k-danger', text: '撤回を記録（店頭・セッション中の申し出）', onclick: function () {
          if (!window.confirm('録音と AI の記録作成への同意の撤回を記録しますか？\nこのお客様には、次から AI の振り分けを使えなくなります（もう一度同意できるのは、ご本人が会員画面からだけです）。')) return;
          kWrite('k_saveConsent', { customerId: cur.customerId, kind: 'rec_ai', state: 'revoked' }, newReqId()).then(function (r) {
            if (!r || !r.success) { window.alert(errText(r)); return; }
            open(cur.customerId, cur.name, cur.tab, null, 'replace');
          });
        } })]));
    }
    return box;
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

  function membershipCard(dd) {   // dd＝読み直しの前に入れていた発効日（退避から戻す）
    var d = field('発効日', (dd && dd.effectiveDate) || today(), 'date'); d.el.max = today();
    function rec(kind) {
      if (!window.confirm((kind === 'withdrawn' ? '退会' : '再入会') + '（' + d.get() + '）を記録しますか？')) return;
      kWrite('k_recordMembership', { customerId: cur.customerId, kind: kind, effectiveDate: d.get() }, newReqId(), { kind: 'membership', cid: cur.customerId, tab: 'contract', data: { effectiveDate: d.get() } }).then(function (r) {
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

      var gf = goalForm(r.goal, draftFor(draft, 'goalLine') ? draft.data : null);
      box.appendChild(gf);
      if (draftFor(draft, 'goalLine')) { gf.classList.add('k-restored'); try { gf.scrollIntoView({ block: 'center' }); } catch (e) {} }
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

  function goalForm(goal, dd) {   // dd＝読み直しの前に入れていた値（退避から戻す）
    var g = goal && goal.kind === 'line' ? goal.points : null;
    var sd = field('開始日', dd ? dd.startDate : (g ? g[0].d : today()), 'date'), ed = field('目標の期限', dd ? dd.endDate : (g ? g[1].d : ''), 'date');
    var sw = field('開始体重（kg）', dd ? dd.startWeight : (g ? g[0].v : ''), 'number'), tw = field('目標体重（kg）', dd ? dd.targetWeight : (g ? g[1].v : ''), 'number');
    var c = card('体重の目標線（グラフの点線）', [el('div', { class: 'k-grid2' }, [sd.row, ed.row, sw.row, tw.row])]);
    if (goal && goal.kind === 'phases') c.appendChild(msg('いまは期ごとの目標（シートから写したもの）が使われています。ここで保存しても、期の目標が優先されます。'));
    var reqId = (dd && dd.reqId) || newReqId();
    c.appendChild(el('button', { class: 'k-btn out', text: '目標線を保存', onclick: function () {
      var gd = { startDate: sd.get(), endDate: ed.get(), startWeight: sw.get(), targetWeight: tw.get(), reqId: reqId };
      kWrite('k_saveGoalLine', { customerId: cur.customerId, startDate: gd.startDate, endDate: gd.endDate, startWeight: gd.startWeight, targetWeight: gd.targetWeight }, reqId, { kind: 'goalLine', cid: cur.customerId, tab: 'body', data: gd }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('保存しました。'); open(cur.customerId, cur.name, 'body', null, 'replace');
      });
    } }));
    return c;
  }

  // ---------------------------------------------------------------- トレーニング
  //   部位：共有の一覧の部位 → 無ければ名前からの推定 → それも無ければ「その他」
  function guessPart(ex) { for (var i = 0; i < PART_RULES.length; i++) if (PART_RULES[i][1].test(String(ex || ''))) return PART_RULES[i][0]; return 'other'; }
  function partKeyOf(ex) { var k = exMaster[String(ex || '')]; return (k && PART_KEYS.some(function (p) { return p[0] === k; })) ? k : guessPart(ex); }
  function partOf(ex) { return label(PART_KEYS, partKeyOf(ex)); }
  //   重量の表示：0 は「自重」（自重の種目は重量を空のまま✓して 0 で保存する・2026-11-06）
  function isBw(w) { return w !== '' && w != null && Number(w) === 0; }
  function wLabel(w) { return isBw(w) ? '自重' : w + 'kg'; }
  //   印（補助・ドロップ・無理やり）があるセットか（新しい回のセットだけが持つ鍵。古い回は鍵が無い＝今までどおり）
  function setHasMark(x) { return !!x && (x.assist_reps != null || x.forced === true || (Array.isArray(x.drops) && x.drops.length > 0)); }
  function setOneLine(x) {   // 「50kg×10+補助5」「10kg×10→自重×10」「80kg×5（無理）」
    var t = wLabel(x.weight_kg) + '×' + x.reps + (x.assist_reps != null ? '+補助' + x.assist_reps : '');
    (Array.isArray(x.drops) ? x.drops : []).forEach(function (d) { t += '→' + wLabel(d.weight_kg) + '×' + d.reps + (d.assist_reps != null ? '+補助' + d.assist_reps : '') + (d.forced === true ? '（無理）' : ''); });
    return t + (x.forced === true ? '（無理）' : '');
  }
  function setLineOf(st) {   // 「50kg × 10・10・8」／重さが混ざるときは「50kg×10・自重×12」
    if (!st.length) return '実施のみ';   // 数字の無い種目（設計38・新しい回だけ）
    //   ★印が1つでもあれば、まとめ書きをせず1セットずつ（設計38 §6-1）。印の無い回は1文字も変えない
    if (st.some(setHasMark)) return st.map(setOneLine).join('・');
    var oneW = st.every(function (x) { return x.weight_kg === st[0].weight_kg; });
    return oneW ? wLabel(st[0].weight_kg) + ' × ' + st.map(function (x) { return x.reps; }).join('・') : st.map(function (x) { return wLabel(x.weight_kg) + '×' + x.reps; }).join('・');
  }
  /** 種目ごとのまとめ（自己ベスト＝重量が最大のセット・同じなら回数が多い方） */
  function exerciseStats(sessions, ex) {
    var sets = [], days = {};
    //   ★種目名ごと（全 ord をまとめる）・本セットだけ（ドロップは平らな配列に無い）・無理やりを除く（設計38 I66）
    (sessions || []).forEach(function (s) { (s.sets || []).forEach(function (st) { if (st.exercise === ex && st.forced !== true) { sets.push({ d: s.session_date, w: st.weight_kg, r: st.reps, e: st.e1rm }); (days[s.session_date] = days[s.session_date] || []).push(st); } }); });
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
  var MEMO_STRUCTURED = ['補助あり', 'フォーム崩れ'];   // 補助・無理やりを構造で持てるとき（33）は出さない（設計38 §5-4）
  var DROPS_MAX = 3;
  //   Worker の 400（BAD_REQUEST）の detail（設計38）
  var TR_DETAIL = { SET_VALUE: '重さは0.1kg刻み（0〜500）、回数・補助は1〜100で入れてください', DROPS: 'ドロップは1セット3段までです', DONE_ONLY: '「実施した」とセットの両方は送れません',
    SETS: 'セットの無い種目があります', ITEMS: '種目は1〜20までです', SET_KEY: '画面の版が古い可能性があります。カルテを開き直してください', EXERCISE: '種目名を確かめてください' };   // 1セットのドロップの段（Worker の DROPS_PER_SET と同じ）
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
  //   新しい回（設計38）は exercises（ord の並び・数字の無い種目を含む）を持つ。古い回は持たない
  function isNewSess(s) { return !!s && Array.isArray(s.exercises) && s.exercises.length > 0; }
  function sessHasEx(s, ex) { return (s.sets || []).some(function (x) { return x.exercise === ex; }) || (isNewSess(s) && s.exercises.some(function (x) { return x && x.exercise === ex; })); }
  function prevOfExercise(sessions, ex, date) {
    var l = (sessions || []).filter(function (s) { return s.session_date < date && sessHasEx(s, ex); }).sort(byNewest);
    if (!l.length) return null;
    var out = { s: l[0], sets: (l[0].sets || []).filter(function (x) { return x.exercise === ex; }).sort(function (a, b) { return a.set_no - b.set_no; }) };
    //   ★新しい回：同じ名前の ord が2つ以上あれば ord ごとに並べる（混ぜない・設計38 §6-1）
    if (isNewSess(l[0])) out.groups = exOrder(l[0]).groups.filter(function (g) { return g.exercise === ex; });
    return out;
  }
  /** 部位ごとの前回からの暦日（入力中の日付まで）。同じ日の記録は「今日実施済み」 */
  function partsSince(sessions, date) {
    var last = {};
    function seen(s, name) { var p = partOf(name); if (!last[p] || s.session_date > last[p]) last[p] = s.session_date; }
    (sessions || []).forEach(function (s) {
      if (s.session_date > date) return;
      (s.sets || []).forEach(function (x) { seen(s, x.exercise); });
      if (isNewSess(s)) s.exercises.forEach(function (x) { if (x && x.exercise) seen(s, x.exercise); });   // 数字の無い種目も数える（設計38）
    });
    return Object.keys(last).map(function (p) { var d = dayDiff(date, last[p]); return { part: p, days: d, text: d === 0 ? p + ' 今日実施済み' : p + ' ' + d + '日ぶり' }; })
      .sort(function (a, b) { return b.days - a.days; });
  }
  /** 送る中身：✓のセットだけ（関門①-1）。★重量が空の✓は自重＝0 で送る（回数が空のセットは今までどおり送らない・2026-11-06） */
  //   ★設計38：印の無い鍵は送らない（Worker は「値ではなく鍵があるか」で新しい形かを決める・null や空配列も新しい鍵の扱い）。
  //     送る鍵は既知のものだけ（item: exercise/sets/doneOnly、set: weight/reps/note/assist/forced/drops、drop: weight/reps/assist/forced）
  function assistOf(v) { var t = String(v == null ? '' : v).trim(); if (!/^\d+$/.test(t)) return null; var n = Number(t); return n >= 1 && n <= 100 ? n : null; }
  function hasR(s) { return !!s && s.r !== '' && s.r != null; }
  function anyR(it) { return (it.sets || []).some(hasR); }
  function buildPayload(items) {
    return items.map(function (it) {
      var o = { exercise: String(it.exercise || '').trim(), sets: (it.sets || []).filter(function (s) { return s.done === true && s.r !== '' && s.r != null; })
        .map(function (s) {
          var o = { weight: (s.w === '' || s.w == null) ? 0 : Number(s.w), reps: Number(s.r) }; var n = String(s.note || '').trim(); if (n) o.note = n.slice(0, 200);
          var a = assistOf(s.assist); if (a != null) o.assist = a;
          if (s.forced === true) o.forced = true;
          //   ドロップは本セットが送られるときだけ・回数のある段だけ（重量の空は0＝I61）
          var ds = (Array.isArray(s.drops) ? s.drops : []).filter(hasR).map(function (d) {
            var x = { weight: (d.w === '' || d.w == null) ? 0 : Number(d.w), reps: Number(d.r) };
            var da = assistOf(d.assist); if (da != null) x.assist = da;
            if (d.forced === true) x.forced = true;
            return x;
          });
          if (ds.length) o.drops = ds;
          return o;
        }) };
      //   数字の無い種目：「実施した」の✓があり、回数のあるセットが1つも無いときだけ（両方は送らない）
      if (!o.sets.length && it.doneOnly === true && !anyR(it)) o.doneOnly = true;
      return o;
    }).filter(function (it) { return it.exercise && (it.sets.length || it.doneOnly === true); });
  }
  //   記録されない入力：✓が無い・回数が欠けている、のどちらかで、重量・回数・メモのどれかが入っているセット（重量の空は自重＝記録される）
  //   ★設計38：「実施した」の✓が効いている種目（回数のあるセットが無い）は数えない。印（補助・無理やり・ドロップ）も入力として数える。
  //     送られるセットの下の、回数が空のドロップの段は数える
  function uncheckedCount(items) {
    var n = 0;
    items.forEach(function (it) {
      if (it.doneOnly === true && !anyR(it)) return;
      (it.sets || []).forEach(function (s) {
        var hasW = s.w !== '' && s.w != null, hasR = s.r !== '' && s.r != null, hasN = String(s.note || '').trim() !== '';
        var hasX = String(s.assist == null ? '' : s.assist).trim() !== '' || s.forced === true || (Array.isArray(s.drops) && s.drops.length > 0);
        var recorded = s.done === true && hasR;
        if (!recorded && (hasW || hasR || hasN || hasX)) n++;
        if (recorded && Array.isArray(s.drops)) s.drops.forEach(function (d) { if (d.r === '' || d.r == null) n++; });
      });
    });
    return n;
  }
  //   合計はドロップの段も1つと数える（設計38 §3-2）。ドロップの無い下書きは今までと同じ数
  function totalSets(items) { var n = 0; items.forEach(function (it) { (it.sets || []).forEach(function (s) { n += 1 + (Array.isArray(s.drops) ? s.drops.length : 0); }); }); return n; }

  // ---------------------------------------------------------------- メモの読み取り（設計38 §4・純粋関数）［memo-parse ここから］
  //   ★倒れる向き：読み取れないもの・意味が決まっていない書き方・autoKnown と完全一致しない名前・括弧書きは、
  //     推測で数値や種目やメモにせず pending（決定待ち）に入れる。黙って捨てない・黙って構造にしない（I64・I71）
  //   ★DOM・保存領域・通信・console に触れない。原文は呼び出し側のメモリにだけ置く（I63）
  //   autoKnown＝固定の EXERCISES ∪ 共有の種目（自動で種目にしてよい名前）。suggestKnown＝この方の最近の種目（「もしかして」の候補にだけ使う）
  var MEMO_LIMITS = { setsPerOrd: 10, drops: 3, items: 20, total: 60 };
  var FORCED_WORDS = ['できない', 'できず', '出来ない', 'できなかった', '無理やり', 'むりやり'];   // ★E：いまはこの6語だけ
  //   seg ::= WEIGHT WS* MUL WS* REPS（NFKC の後）。値の範囲は memoW・memoInt で見る（正規表現では丸めない）
  var MEMO_SEG = /(\d+(?:\.\d+)?)(?:\s*kg)?\s*(?:×|x|\*|✕|✖|かける)\s*(\d+)(?:\s*回)?/iy;
  var MEMO_ASSIST = /(\d+)(?:\s*回)?/y;
  //   設計40 G6：重さを書かない回数（×20）＝自重。セットの先頭だけ（ドロップの段には使わない）
  var MEMO_SEG0 = /(?:×|x|\*|✕|✖)\s*(\d+)(?:\s*回)?/iy;
  //   設計40 G5：重さのあるセットの直後がかな・漢字なら区切り。ただし単位・構造の語で始まるならセット全体を読まない（50×10キロ・60×5秒・50×10セット＝I64）
  var MEMO_JA = /[ぁ-ゖァ-ヺー一-鿿々]/;
  var MEMO_UNIT = /^(?:キロ|kg|秒|分|セット|set|回|目|レップ|rep|本|周|m|メートル|往復|段|枚|ずつ|種類|か所|箇所|ヶ所|sec|min)/i;
  //   設計40 §5・G9b：提案（propose）を付けない文＝健康の言葉（I55）・名前らしい印。自動で捨てもしない（1件ずつ選ぶ）
  var MEMO_HEALTH = /痛|痺|しびれ|怪我|ケガ|けが|診断|薬|手術|違和感|腫|骨折|捻|ヘルニア|病院|通院|体調|血圧|めまい|熱|妊娠|アレルギー|生理|持病|リハビリ|吐き気|頭痛|不調|医師|医者|治療|炎症|つった|つる/;
  var MEMO_PII_WEAK = /様|さん|氏|くん|君|ちゃん|回目|初回|体験/;
  //   設計40 G9：行頭の漢字・カタカナ1〜6字＋敬称＝お客様の名前らしい行（提案「捨てる」・計画では名前の部分を〇〇にする）
  var MEMO_PII_STRONG = /^([一-鿿々〆ヵヶァ-ヺー]{1,6})(様|さん|氏|くん|君|ちゃん)/;
  var MEMO_NOTE_END = /(た|る|い|く|あり|なし|〇|○|感覚|意識)$/;
  function memoQuiet(t) { t = String(t || ''); return MEMO_HEALTH.test(t) || MEMO_PII_WEAK.test(t); }
  //   設計41：オーナーに聞いて決めた読み方（R2・R5・R7・R8・R10）。★読めても items には入れない＝下見つきの決定待ち（propose 'addset'）にして、
  //     計画の一覧で原文と行き先を見てから入れる（改訂2 A）。範囲を外れたら null＝今までどおり（1件ずつ）
  var MEMO_R2 = /^([ぁ-ゖァ-ヺー一-鿿々]{1,4}?(?:チューブ|バンド))\s*[×x✕✖*]\s*(\d+)(?:\s*回)?(?:\s*\+\s*(\d+)(?:\s*回)?)?/i;
  var MEMO_R5 = /^[×x✕✖*]\s*(\d+)(?:\s*回)?(?:\s*\+\s*(\d+)(?:\s*回)?)?\s*自重/i;
  var MEMO_R7 = /^[×x✕✖*]\s*(\d+)\s*ずつ\s*(\d+)\s*種類/i;
  var MEMO_R8 = /^(\d+(?:\.\d)?)\s*\+\s*(\d+(?:\.\d)?)\s*[×x✕✖*]\s*(\d+)(?:\s*回)?(?:\s*\+\s*(\d+)(?:\s*回)?)?/i;
  var MEMO_R10 = /^(?:(\d+(?:\.\d)?)\s*(?:kg|キロ)|(自重))\s*(?:で|を|、|,)?\s*(\d+)\s*(?:回|レップ|rep)(?:\s*を?\s*(\d+)\s*セット)?/i;
  //   R10 の後ろに許す言い方（これ以外が続けば読まない＝相談・疑問・名前などを数値にしない・R11）
  var MEMO_R6 = /^\d+(?:\.\d)?\s*(?:kg|キロ)?\s*[×x✕✖*]\s*$/i;   // R6：回数の無いセット（60×）
  var MEMO_R10_END =/^(?:\s|いきます|行きます|やります|やりました|やった|でした|です|ね|よ|。|、|!)*$/;
  var memoSeqN = 0;   // 設計41 F：読んだ順の通し番号（parseMemo の呼び出しごとに 0 から）
  function memoTag(st) { if (st && st.sq == null) st.sq = ++memoSeqN; return st; }
  function memoRuleSet(w, r, a, note) {
    var o = { w: w, r: String(r), assist: a == null ? null : a, forced: false, drops: [] };
    if (note) o.note = note;
    return memoTag(o);
  }
  /** 正規化した文字の先頭から、設計41 の形を1つ読む。{ rule, sets, end, spoken }。読めなければ null */
  function memoRuleCore(s) {
    var m, r, a, w;
    if ((m = MEMO_R2.exec(s))) {
      r = memoInt(m[2]); a = m[3] != null ? memoInt(m[3]) : null;
      if (r == null || (m[3] != null && a == null)) return null;
      return { rule: 'R2', sets: [memoRuleSet('', r, a, m[1])], end: m[0].length };
    }
    if ((m = MEMO_R5.exec(s))) {
      r = memoInt(m[1]); a = m[2] != null ? memoInt(m[2]) : null;
      if (r == null || (m[2] != null && a == null)) return null;
      return { rule: 'R5', sets: [memoRuleSet('', r, a, '自重')], end: m[0].length };
    }
    if ((m = MEMO_R7.exec(s))) {
      r = memoInt(m[1]); var k = Number(m[2]);
      if (r == null || !(/^\d+$/.test(m[2]) && k >= 2 && k <= 10)) return null;
      var out7 = [];
      for (var i7 = 0; i7 < k; i7++) out7.push(memoRuleSet('', r, null, i7 === 0 ? k + '種類' : null));
      return { rule: 'R7', sets: out7, end: m[0].length };
    }
    if ((m = MEMO_R8.exec(s))) {
      var wa = memoW(m[1]), wb = memoW(m[2]);
      r = memoInt(m[3]); a = m[4] != null ? memoInt(m[4]) : null;
      if (wa == null || wb == null || wa === '' || Number(m[1]) !== Number(m[2]) || r == null || (m[4] != null && a == null)) return null;   // ★左右が違えば一部も読まない
      return { rule: 'R8', sets: [memoRuleSet(wa, r, a, '片手' + wa + 'kgずつ')], end: m[0].length };
    }
    if ((m = MEMO_R10.exec(s))) {
      w = m[2] ? '' : memoW(m[1]); r = memoInt(m[3]);
      if (w == null || r == null) return null;
      var n10 = 1;
      if (m[4] != null) { n10 = Number(m[4]); if (!(n10 >= 2 && n10 <= 10)) return null; }
      var out10 = [];
      for (var i10 = 0; i10 < n10; i10++) out10.push(memoRuleSet(w, r, null, null));
      return { rule: 'R10', sets: out10, end: m[0].length, spoken: true };
    }
    return null;
  }
  //   date ::= ( YEAR SEP_D )? MONTH SEP_D DAY 日? ( "(" WEEKDAY ")" )?   SEP_D＝/ . 月
  //   設計40 G1：日付の後ろの時刻（00〜23:00〜59）と「〜」は捨てる（保存しない）。例：11/3(火)12:30〜
  var MEMO_DATE = /^\s*(?:(\d{4})[\/.月])?(\d{1,2})[\/.月](\d{1,2})日?\s*(?:\([月火水木金土日]\))?\s*(?:(?:[01]?\d|2[0-3]):[0-5]\d\s*[~〜\-]?)?\s*$/;
  //   ★「.」区切りは年があるときだけ日付（2026.9.18）。年の無い「12.5」は重さを書いた行かもしれない＝日付にしない（関門② Codex 高）
  var MEMO_DATE_NOYEAR_DOT = /^\s*\d{1,2}\./;
  /** 1行に NFKC をかける。map[i]＝正規化後の i 文字目が元の何文字目から来たか（読めなかった部分を元の文字で返すため） */
  function memoNorm(orig) {
    var s = '', map = [], i = 0, n = orig.length;
    while (i < n) {
      var j = i + (orig.codePointAt(i) > 0xffff ? 2 : 1);
      //   半角の濁点・結合文字は前の文字とまとめて NFKC をかける（1文字ずつだと合成されない）
      while (j < n && /[ﾞﾟ゙゚̀-ͯ]/.test(orig.charAt(j))) j++;
      var t = orig.slice(i, j).normalize('NFKC');
      for (var k = 0; k < t.length; k++) map.push(i);
      s += t; i = j;
    }
    map.push(n);
    return { s: s, map: map, orig: orig };
  }
  function memoSlice(nm, a, b) { return nm.orig.slice(nm.map[a], nm.map[b == null ? nm.s.length : b]).trim(); }
  function memoName(x) { return String(x == null ? '' : x).replace(/\s+/g, ' ').trim(); }   // 種目名は元の文字のまま（空白だけそろえる）
  function memoWs(s, p) { while (p < s.length && /\s/.test(s.charAt(p))) p++; return p; }
  /** 重さ：0〜500・小数は1桁まで（0.1 刻み）。2桁以上は丸めずに読めない＝null。0 は自重として ''（I61） */
  function memoW(str) {
    if (!/^\d+(\.\d)?$/.test(str)) return null;
    var v = Number(str);
    if (!(v >= 0 && v <= 500)) return null;
    return v === 0 ? '' : String(v);
  }
  function memoInt(str) { if (!/^\d+$/.test(str)) return null; var v = Number(str); return v >= 1 && v <= 100 ? v : null; }
  function memoSeg(s, p) {
    MEMO_SEG.lastIndex = p;
    var m = MEMO_SEG.exec(s);
    if (!m) return null;
    var w = memoW(m[1]), r = memoInt(m[2]);
    if (w == null || r == null) return null;
    return { v: { w: w, r: String(r), assist: null, forced: false }, end: p + m[0].length };
  }
  function memoSeg0(s, p) {
    MEMO_SEG0.lastIndex = p;
    var m = MEMO_SEG0.exec(s);
    if (!m) return null;
    var r = memoInt(m[1]);
    if (r == null) return null;
    return { v: { w: '', r: String(r), assist: null, forced: false }, end: p + m[0].length };
  }
  /** set ::= seg ( + seg )* ( + assist )? ( "(" … ")" )?。読めなければ null（そのかたまりから後ろは読めなかった部分） */
  function memoSet(s, p) {
    var segs = [], assist = null, q, m, noW = false;
    m = memoSeg(s, p);
    if (!m) { m = memoSeg0(s, p); noW = true; }   // G6
    if (!m) return null;
    segs.push(m.v); p = m.end;
    for (;;) {
      q = memoWs(s, p);
      if (s.charAt(q) !== '+') break;
      if (assist != null) return null;              // 補助の後ろにさらに続く（50×10+5+3・50×10+5+40×10）は読まない
      q = memoWs(s, q + 1);
      m = memoSeg(s, q);
      if (m) { segs.push(m.v); p = m.end; continue; }   // ＋の後ろが「重さ×回数」＝ドロップ
      MEMO_ASSIST.lastIndex = q;
      m = MEMO_ASSIST.exec(s);
      if (!m) return null;
      var a = memoInt(m[1]);                         // ＋の後ろが数字だけ＝補助の回数
      if (a == null) return null;
      assist = a; p = q + m[0].length;
    }
    var forced = false, paren = null;
    q = memoWs(s, p);
    if (s.charAt(q) === '(') {
      var c = s.indexOf(')', q + 1);
      if (c < 0) return null;
      var inner = s.slice(q + 1, c).trim();
      //   括弧書きで構造にするのは無理やりの確定語だけ。それ以外はそのかたまりごと決定待ち（I71）
      if (FORCED_WORDS.indexOf(inner) >= 0) forced = true; else paren = inner;
      p = c + 1;                                     // 括弧の直後は区切りなしで次のセットへ続いてよい
    } else if (p < s.length && !/[\s、,→]/.test(s.charAt(p)) && !(s.charAt(p) === '-' && s.charAt(p + 1) === '>')) {
      //   区切りでも行の終わりでもない（50×10×3・50×10kg 等）＝読まない。
      //   設計40 G5：重さのあるセットの直後がかな・漢字なら区切り（20×10トップで…）。単位・構造の語なら読まない。重さ無しには使わない（×8クリア）
      if (noW || !MEMO_JA.test(s.charAt(p)) || MEMO_UNIT.test(s.slice(p))) return null;
    }
    var main = segs[0], drops = segs.slice(1);
    if (assist != null) (drops.length ? drops[drops.length - 1] : main).assist = assist;   // 補助は最後の段に付く
    //   ★ドロップのあるセットの「(できない)」は、本セットとどの段のどちらに付くかが文法から決まらない＝決定待ちにする
    if (forced && drops.length) { forced = false; paren = inner; }
    main.forced = forced;
    main.drops = drops;
    return { end: p, set: main, paren: paren, nDrops: drops.length };
  }
  /** sets_line を頭から読む。chunks＝読めたかたまり、tailAt＝読めなかった残りの位置（-1＝最後まで読めた） */
  function memoSets(s) {
    var out = [], p = memoWs(s, 0), r;
    while (p < s.length) {
      r = memoSet(s, p);
      if (!r) return { chunks: out, tailAt: p };
      out.push({ from: p, to: r.end, set: memoTag(r.set), paren: r.paren, nDrops: r.nDrops });
      p = memoWs(s, r.end);
      if (s.charAt(p) === '、' || s.charAt(p) === ',' || s.charAt(p) === '→') p = memoWs(s, p + 1);   // G7：矢印も区切り
      else if (s.charAt(p) === '-' && s.charAt(p + 1) === '>') p = memoWs(s, p + 2);
    }
    return { chunks: out, tailAt: -1 };
  }
  function memoFull(r) { return r.chunks.length > 0 && r.tailAt < 0; }
  //   数値を書こうとした行か（×がある・数字＋単位で始まる・数字と記号だけ）。種目名としては扱わない
  function memoSetish(s) {
    return /\d\s*(?:[×x*✕✖]|かける)/i.test(s) || /^\s*\d+(?:\.\d+)?\s*(?:kg|キロ|回|秒|分|セット)/i.test(s) || /^[\d\s.,、+()]+$/.test(s);
  }
  function memoBullet(name) {   // BULLET ::= ・ | - | • | INT ( . | ) ) WS+
    var m = /^(?:[・•\-]\s*|\d+[.)]\s+)/.exec(name.normalize('NFKC').slice(0, 8));
    if (!m) return name;
    //   NFKC で長さが変わらない範囲（数字・記号）だけを外す
    var cut = 0, n = 0;
    while (cut < name.length && n < m[0].length) { n += name.charAt(cut).normalize('NFKC').length; cut++; }
    return name.slice(cut).trim();
  }
  function memoKey(x) {   // 「もしかして」の照合だけに使う（自動の照合には使わない）
    return String(x).normalize('NFKC').toLowerCase().replace(/[\s()\[\]・\-_\/.、,]/g, '')
      .replace(/[ぁ-ゖ]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) + 0x60); });
  }
  function memoList(l) {
    var out = [];
    (Array.isArray(l) ? l : []).forEach(function (x) {
      if (typeof x !== 'string') return;
      var n = memoName(x);
      if (n && n.length <= EX_NAME_MAX && !out.some(function (o) { return o.n === n; })) out.push({ n: n, orig: exName(x) });
    });
    return out;
  }
  function memoReal(y, mo, d) {
    if (!(mo >= 1 && mo <= 12 && d >= 1 && d <= 31)) return null;
    var t = new Date(Date.UTC(y, mo - 1, d));
    if (t.getUTCFullYear() !== y || t.getUTCMonth() !== mo - 1 || t.getUTCDate() !== d) return null;
    return y + '-' + (mo < 10 ? '0' : '') + mo + '-' + (d < 10 ? '0' : '') + d;
  }
  /** 日付：年が無ければ今年・今日より後なら去年。年があって未来・実在しない日は null（Worker の isPastOrToday と同じ条件） */
  function memoDate(m, today) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(today || ''))) return null;
    var mo = Number(m[2]), d = Number(m[3]);
    if (m[1]) { var a = memoReal(Number(m[1]), mo, d); return a && a <= today ? a : null; }
    var y = Number(today.slice(0, 4)), v = memoReal(y, mo, d);
    if (!v) return null;
    if (v > today) v = memoReal(y - 1, mo, d);
    return v;
  }
  /**
   * メモの文字を、記録の画面の下書きと同じ形に読む（設計38 §4-2〜4-4）。
   *   返す形：{ date, items: [{ exercise, doneOnly, sets: [{ w, r, assist, forced, drops: [{ w, r, assist, forced }] }] }],
   *            pending: [{ kind, lines, text, parsed?, candidates?, item? }] }
   *   w・r は文字列（重さ0は ''＝自重）。items に入るのは autoKnown と完全一致した名前だけ。
   *   pending.item は「その決定待ちがどの種目（items の添字）に付くか」。pending が付いた種目は doneOnly にしない（決まるまで）
   *   pending.after は「名前の決定待ちの直前にある種目（items の添字）」。種目の下に書いたメモ（例：肘を上げる意識）を、その種目のメモにする選択肢に使う（2026-11-08）
   *   pending.prevPend は「直前が名前の決定待ちのとき、その pending の添字」。宛先は画面で、その決定待ちをどう決めたかから後で決める
   *     （種目にした→その種目・種目のメモにした→同じ宛先・それ以外→出さない＝Codex 関門② 高：引き継ぐと別の種目へ入る）
   *     ・数値と同じ行の名前（「名前 50×10」）には付けない
   */
  function parseMemo(text, todayYmd, autoKnown, suggestKnown) {
    //   設計40（関門②）：名前らしい印（敬称・回目・初回・体験）を含む共有の種目は、自動の照合（完全一致・G2・G4・候補）から外す＝held。
    //     登録された名前を自動で種目にしない。held で始まる行は G9 の「捨てる」にもしない（赤ちゃんのポーズ等の正しい種目を名前と取り違えない）＝1件ずつ
    var autoAll = memoList(autoKnown), sugg = memoList(suggestKnown);
    var auto = autoAll.filter(function (a) { return !MEMO_PII_WEAK.test(a.n); });
    var held = autoAll.filter(function (a) { return MEMO_PII_WEAK.test(a.n); });
    var autoLong = auto.slice().sort(function (a, b) { return b.n.length - a.n.length; });
    var res = { date: null, items: [], pending: [] };
    memoSeqN = 0;
    var meta = [];        // items と同じ添字：{ pend: 決定待ちが付いたか }
    var dateSeen = false, stop = null, cur = null, total = 0;
    var lines = String(text == null ? '' : text).split(/\r\n|\r|\n/);

    function autoOf(name) { for (var i = 0; i < auto.length; i++) if (auto[i].n === name) return auto[i].orig; return null; }
    function pend(p) { res.pending.push(p); return p; }
    function candidatesOf(name) {
      var k = memoKey(name), out = [];
      if (!k || name.length > EX_NAME_MAX) return out;
      auto.forEach(function (a) { if (memoKey(a.n) === k) out.push({ name: a.orig, source: 'auto' }); });
      sugg.forEach(function (a) { if (memoKey(a.n) === k && !out.some(function (o) { return o.name === a.orig; })) out.push({ name: a.orig, source: 'suggest' }); });
      return out;
    }
    //   決定待ちのかたまり（名前・種目の無い数値・上限を超えた種目）に、続く行を足す
    function append(p, ln, otext, chunks) {
      p.lines.push(ln);
      p.text += '\n' + otext;
      if (p.parsed && chunks) chunks.forEach(function (c) { if (c.paren == null) p.parsed.sets.push(c.set); });
      if (p.kind === 'name' && p.parsed && p.parsed.sets.length) delete p.propose;   // 設計40：下に数値が続く名前は種目かもしれない＝メモを提案しない
    }
    function newItem(name, ln, otext) {
      if (res.items.length >= MEMO_LIMITS.items) {   // 種目20を超えた：入れない（捨てるだけ選べる）
        cur = { pend: pend({ kind: 'limit', lines: [ln], text: otext, parsed: { exercise: name, sets: [] } }) };
        return -1;
      }
      res.items.push({ exercise: name, doneOnly: false, sets: [] });
      meta.push({ pend: false });
      cur = { item: res.items.length - 1 };
      return cur.item;
    }
    function addChunks(idx, chunks, ln, nm) {
      var it = res.items[idx];
      chunks.forEach(function (c) {
        var ctext = memoSlice(nm, c.from, c.to);
        if (c.paren != null) {
          meta[idx].pend = true;
          var pp0 = pend({ kind: 'paren', lines: [ln], text: ctext, parsed: { exercise: it.exercise, sets: [c.set], paren: c.paren }, item: idx });
          //   設計41 R4：括弧が1つだけ・中に健康の言葉や名前の印が無い＝「セットにして、括弧の中をそのセットのメモに」を提案
          if (c.paren && (nm.s.match(/\(/g) || []).length === 1 && !memoQuiet(c.paren)) pp0.propose = 'parenset';
          return;
        }
        if (c.nDrops > MEMO_LIMITS.drops || it.sets.length >= MEMO_LIMITS.setsPerOrd || total + 1 + c.nDrops > MEMO_LIMITS.total) {
          meta[idx].pend = true;
          pend({ kind: 'limit', lines: [ln], text: ctext, parsed: { exercise: it.exercise, sets: [c.set] }, item: idx });
          return;
        }
        it.sets.push(c.set);
        total += 1 + c.nDrops;
      });
    }
    function addTail(idx, r, ln, nm, n0) {
      if (r.tailAt < 0) return;
      var t = memoSlice(nm, r.tailAt);
      if (!t) return;
      meta[idx].pend = true;
      var tp = pend({ kind: 'tail', lines: [ln], text: t, item: idx });
      //   設計40 G3：その行で入ったセットがあれば「そのセットのメモ」を提案（健康の言葉・名前らしい印があれば提案しない）
      //   設計41 F：宛先はそのセットの通し番号（setSq）で持つ。行の最後が R4 の括弧のセットなら、そのセット（決まれば入る）
      var lastC = r.chunks[r.chunks.length - 1], lastP = res.pending[res.pending.length - 2];
      if (MEMO_R6.test(memoNorm(t).s)) tp.propose = 'exnote';   // 設計41 R6：回数の無いセット（60×）＝セットにしない・種目のメモを提案
      else if (lastC && lastC.paren != null && lastP && lastP.propose === 'parenset' && lastP.parsed.sets[0] === lastC.set) {
        if (!memoQuiet(t)) { tp.setSq = lastC.set.sq; tp.propose = 'setnote'; }
      } else if (res.items[idx].sets.length > n0 && !memoQuiet(t)) {
        tp.setAt = res.items[idx].sets.length - 1; tp.setSq = res.items[idx].sets[tp.setAt].sq; tp.propose = 'setnote';
      }
    }
    //   設計41：規則で読んだ数値を「下見つきの決定待ち」にする（items に入れない）。後ろの文はそのセットのメモの提案
    function addRule(idx, core, ln, otext, tail) {
      meta[idx].pend = true;
      pend({ kind: 'rule', rule: core.rule, lines: [ln], text: otext, parsed: { exercise: res.items[idx].exercise, sets: core.sets }, item: idx, propose: 'addset' });
      if (tail) {
        var rt = pend({ kind: 'tail', lines: [ln], text: tail, item: idx });
        if (!memoQuiet(tail)) { rt.setSq = core.sets[core.sets.length - 1].sq; rt.propose = 'setnote'; }
      }
    }
    //   メモの宛先の手がかり：直前が種目ならその添字、直前が名前の決定待ちならその pending の添字（宛先は画面で決定から解く）
    function linkPrev(p) {
      if (!cur) return;
      if (cur.item != null && cur.item >= 0) p.after = cur.item;
      else if (cur.pend && cur.pend.kind === 'name') p.prevPend = res.pending.indexOf(cur.pend);
    }

    for (var i = 0; i < lines.length; i++) {
      var ln = i + 1, otext = lines[i].trim();
      if (stop) { if (otext) append(stop, ln, otext); continue; }   // 2つ目の日付から後ろは全部 second_date
      if (!otext) continue;
      var raw = lines[i];
      //   設計40 G10：閉じない括弧で始まる行（「(ダンベルフライ9×15」）は、先頭の括弧だけ外して読む
      if (/^\s*[(（]/.test(raw) && !/[)）]/.test(raw)) raw = raw.replace(/^(\s*)[(（]/, '$1');
      var nm = memoNorm(raw), s = nm.s;

      //   日付の行：最初の1つだけ。2つ目が出たら止める
      var dm = MEMO_DATE.exec(s);
      if (dm && !dm[1] && MEMO_DATE_NOYEAR_DOT.test(s)) dm = null;
      if (dm) {
        if (dateSeen) { stop = pend({ kind: 'second_date', lines: [ln], text: otext }); continue; }
        dateSeen = true;
        var ymd = memoDate(dm, todayYmd);
        if (ymd) res.date = ymd; else pend({ kind: 'bad_date', lines: [ln], text: otext });
        cur = null;
        continue;
      }

      var name0 = memoName(raw), body = memoBullet(name0), isBullet = body !== name0;
      //   設計40 G9：お客様の名前らしい行（行頭の漢字・カタカナ＋敬称）。提案は「捨てる」。宛先の手がかりは付けない。
      //     ★known_line より先（共有の種目に名前が登録されていても種目にしない・関門②）
      //     ★sealed：次の数値行を直前の種目に足さない（名前の行の後ろの数値はどの種目か決まらない）
      var pm = MEMO_PII_STRONG.exec(body);
      if (pm && held.some(function (a) { return body.indexOf(a.n) === 0; })) pm = null;   // 登録済みの種目で始まる＝名前と決めない（下で提案なしの決定待ちになる）
      if (pm) {
        pend({ kind: 'name', lines: [ln], text: otext, parsed: { exercise: body, sets: [] }, candidates: [], propose: 'drop', pii: true, masked: '〇〇' + body.slice(pm[1].length) });
        if (cur) cur = { item: cur.item, pend: cur.pend, sealed: true };
        continue;
      }
      //   known_line：autoKnown と完全一致（suggestKnown は使わない）。箇条書き＋完全一致も種目（P42）。
      //     ★名前らしい印（敬称・回目・初回・体験）を含む名前は、一致しても自動で種目にしない＝提案なしの名前の決定待ち（関門②）
      var k = autoOf(name0) || autoOf(body);
      if (k) { newItem(k, ln, otext); continue; }

      //   設計41（改訂2 B の順）：行全体に健康の言葉・名前らしい印があれば当てない／sealed 中は当てない／held の名前で始まる行は当てない
      var curOk = !!(cur && !cur.sealed && !cur.pend && cur.item != null && cur.item >= 0);
      if (!memoQuiet(body) && !(cur && cur.sealed) && !held.some(function (a) { return body.indexOf(a.n) === 0; })) {
        //   R9：「次」「次回」で始まる数字＝次回の目標。セットにしない＝直前の種目のメモを提案（次第・次々は除く）
        if (!isBullet && /^次(?:回)?(?![第々])/.test(body) && /\d/.test(body)) {
          if (curOk) { meta[cur.item].pend = true; pend({ kind: 'tail', rule: 'R9', lines: [ln], text: otext, item: cur.item, propose: 'exnote' }); }
          else pend({ kind: 'line', lines: [ln], text: otext });
          continue;
        }
        //   R2・R5・R7・R8・R10：行頭に登録済みの種目名（ちょうど1つ）があればその種目（G2 と同じ）。無ければ直前の確定済みの種目。
        //     ★どれも行の先頭（か行頭の種目名の直後）からだけ読む。区切りの後ろ（50×10、16+16×10）は読まない＝今までどおり（改訂5）
        var rLead = null, rCore = null, rRest = '', rc = [];
        autoLong.forEach(function (a) {
          if (body.indexOf(a.n) !== 0 || body.length <= a.n.length) return;
          var rem = memoNorm(body.slice(a.n.length).replace(/^[\s、,]+/, '')).s, cc = memoRuleCore(rem);
          if (cc) rc.push({ a: a, core: cc, rest: rem.slice(cc.end) });
        });
        if (rc.length === 1) { rLead = rc[0].a; rCore = rc[0].core; rRest = rc[0].rest; }
        else if (!rc.length) { var c0 = memoRuleCore(s); if (c0) { rCore = c0; rRest = s.slice(c0.end); } }
        if (rCore) {
          var rTail = null, okR = true;
          if (rCore.spoken) okR = MEMO_R10_END.test(rRest);                                   // R10：後ろは決まった言い方だけ（R11）
          else if (rRest && !/^\s/.test(rRest)) okR = false;                                // それ以外：後ろは空白で区切った文だけ
          else rTail = rRest.trim() || null;
          if (okR && rTail && /\d/.test(rTail)) okR = false;                                // 後ろにさらに数字＝読まない
          if (okR && rLead) {
            var ri = newItem(rLead.orig, ln, otext);
            if (ri >= 0) addRule(ri, rCore, ln, otext, rTail);
            continue;
          }
          if (okR && curOk) { addRule(cur.item, rCore, ln, otext, rTail); continue; }
        }
      }

      //   sets_line：直前の種目に足す
      var r = memoSets(s);
      if (r.chunks.length) {
        if (cur && cur.sealed) { pend({ kind: 'line', lines: [ln], text: otext }); continue; }   // 設計40 sealed：item も下見も付けない
        if (!cur) {
          cur = { pend: pend({ kind: 'no_exercise', lines: [ln], text: otext, parsed: { sets: [] } }) };
          r.chunks.forEach(function (c) { if (c.paren == null) cur.pend.parsed.sets.push(c.set); });
        } else if (cur.pend) {
          append(cur.pend, ln, otext, r.chunks);
          //   ★下見（parsed.sets）に入らない部分＝括弧書きのセット・読めない残りは別の決定待ちに出す。
          //     名前の決定待ちで「種目にする」を選ぶと下見のセットだけが入る＝ここで分けないと黙って消える（I64）
          r.chunks.forEach(function (c) { if (c.paren != null) pend({ kind: 'line', lines: [ln], text: memoSlice(nm, c.from, c.to) }); });
          if (r.tailAt >= 0) { var tt = memoSlice(nm, r.tailAt); if (tt) pend({ kind: 'line', lines: [ln], text: tt }); }
        } else {
          var n0 = res.items[cur.item].sets.length;
          addChunks(cur.item, r.chunks, ln, nm);
          addTail(cur.item, r, ln, nm, n0);
        }
        continue;
      }

      //   known_sets_line：autoKnown を長い順に行の先頭と比べ、残りの先頭から1つ以上のセットが読める候補がちょうど1つのときだけ採る
      //     設計40 G2：残りに読めない部分があってもよい（ラットプルダウン25×10 背中に入った）。読めない残りは tail（G3）
      var cands = [];
      autoLong.forEach(function (a) {
        if (body.indexOf(a.n) !== 0 || body.length <= a.n.length) return;
        var rnm = memoNorm(body.slice(a.n.length)), rr = memoSets(rnm.s);
        if (rr.chunks.length) cands.push({ a: a, nm: rnm, r: rr });
      });
      if (cands.length === 1) {
        var idx = newItem(cands[0].a.orig, ln, otext);
        if (idx >= 0) { addChunks(idx, cands[0].r.chunks, ln, cands[0].nm); addTail(idx, cands[0].r, ln, cands[0].nm, 0); }
        else {   // 種目20を超えた：数値も一緒に limit の中へ（行の文字は limit の text に全部ある）
          cands[0].r.chunks.forEach(function (c) { if (c.paren == null) cur.pend.parsed.sets.push(c.set); });
        }
        continue;
      }
      if (cands.length > 1) { pend({ kind: 'line', lines: [ln], text: otext }); cur = null; continue; }   // どちらの名前か決めない

      //   設計40 G8：箇条書きの行（完全一致の種目でない）は数値・種目として読まない＝直前の種目のメモの候補。★sealed
      if (isBullet) {
        var bp = pend({ kind: 'name', lines: [ln], text: otext, parsed: { exercise: body, sets: [] }, candidates: [] });
        linkPrev(bp);
        bp.candidates = candidatesOf(body);
        if ((bp.after != null || bp.prevPend != null) && !memoQuiet(body)) bp.propose = 'exnote';
        cur = { pend: bp, sealed: true };
        continue;
      }

      //   設計40 G4：autoKnown の名前＋空白＋文（数値なし）＝種目と、その種目のメモの候補（ベンチプレス　パワーフォームで）
      var g4 = [];
      autoLong.forEach(function (a) {
        if (body.indexOf(a.n) !== 0 || !/\s/.test(body.charAt(a.n.length))) return;
        var rest = body.slice(a.n.length).trim();
        if (rest && !memoSetish(memoNorm(rest).s)) g4.push({ a: a, rest: rest });
      });
      if (g4.length === 1) {
        var gi = newItem(g4[0].a.orig, ln, otext);
        if (gi >= 0) { var gp = pend({ kind: 'tail', lines: [ln], text: g4[0].rest, item: gi }); if (!memoQuiet(g4[0].rest)) gp.propose = 'exnote'; }
        continue;
      }

      //   一致しない名前＋空白＋数値（autoKnown が空のときの「スクワット 50×10」等）：名前の決定待ちにし、数値は下見に入れる
      var split = null;
      for (var sp = body.indexOf(' '); sp > 0 && !split; sp = body.indexOf(' ', sp + 1)) {
        var pre = body.slice(0, sp), rr2 = memoSets(memoNorm(body.slice(sp + 1)).s);
        if (!memoSetish(pre) && memoFull(rr2)) split = { name: pre, r: rr2 };
      }
      //   設計40：名前と数値が空白なしで続く形（インクラインスミスベンチ20×10トップで…）。数字の直前で切る。読めない残りは別の決定待ち（I64）
      var dg = split ? -1 : body.search(/\d/), splitTail = null;
      if (dg >= 2 && !memoSetish(body.slice(0, dg)) && !/[×✕✖*xX+]\s*$/.test(body.slice(0, dg))) {
        var snm = memoNorm(body.slice(dg)), rr3 = memoSets(snm.s);
        if (rr3.chunks.length && rr3.chunks.every(function (c) { return c.paren == null; })) {
          split = { name: body.slice(0, dg).trim(), r: rr3 };
          if (rr3.tailAt >= 0) splitTail = memoSlice(snm, rr3.tailAt) || null;
        }
      }
      //   数値を書こうとしたが文法に合わない行（50×10×3・20回・60秒・50キロ10回・12.34×10・名前と数値がつながる形）
      if (!split && memoSetish(s)) {
        if (cur && cur.sealed) { pend({ kind: 'line', lines: [ln], text: otext }); continue; }   // 設計40 sealed
        if (/^\s*\d/.test(s) && cur) {
          //   ★決定待ちのかたまりに混ぜない：混ぜると「種目にする」を選んだときに黙って消える（I64・関門② 画面担当の指摘）
          if (cur.pend) pend({ kind: 'line', lines: [ln], text: otext });
          else {
            meta[cur.item].pend = true;
            var lp6 = pend({ kind: 'line', lines: [ln], text: otext, item: cur.item });
            if (MEMO_R6.test(s)) lp6.propose = 'exnote';   // 設計41 R6
          }
        } else {
          pend({ kind: 'line', lines: [ln], text: otext });
          if (!/^\s*\d/.test(s)) cur = null;   // 「名前＋数値」の行は前の種目に続けない（どの種目か分からない）
        }
        continue;
      }

      //   それ以外は全部、決定待ちの名前（健康の文を含む）
      var p = pend({ kind: 'name', lines: [ln], text: otext, parsed: { exercise: split ? split.name : body, sets: [] }, candidates: [] });
      if (!split) linkPrev(p);
      //   設計40 G11：直前の種目（か名前の決定待ち）の下の「文」は、その種目のメモを提案する。短い名詞（新しい種目かもしれない）には付けない
      if (!split && (p.after != null || p.prevPend != null) && !memoQuiet(body) && (/\s/.test(body) || body.length > 15 || MEMO_NOTE_END.test(body))) p.propose = 'exnote';
      //   設計41 R3：行の途中（先頭でない）に登録済みの種目名がちょうど1つ・1回だけある文（数字なし）。カードで「その種目にして文をメモに」を選べる。
      //     ★直前の種目のメモの提案は外す（一括の計画で別の種目のメモにしない・I71）。held の名前は候補にしない
      if (!split && !isBullet && !/\d/.test(body) && !memoQuiet(body) && !held.some(function (a) { return body.indexOf(a.n) >= 0; })) {
        var r3 = auto.filter(function (a) { var at = body.indexOf(a.n); return at > 0 && body.indexOf(a.n, at + 1) < 0; });
        //   長い名前に含まれる短い名前（ベンチプレスの中のベンチ）は数えない
        r3 = r3.filter(function (a) { return !r3.some(function (b) { return b !== a && b.n.length > a.n.length && b.n.indexOf(a.n) >= 0 && body.indexOf(b.n) >= 0; }); });
        if (r3.length === 1 && !auto.some(function (a) { return body.indexOf(a.n) === 0; })) { p.r3 = r3[0].orig; delete p.propose; }
      }
      if (split) split.r.chunks.forEach(function (c) { if (c.paren == null) p.parsed.sets.push(c.set); });
      p.candidates = candidatesOf(p.parsed.exercise);
      cur = { pend: p };
      if (splitTail) {   // 名前＋数値の後ろの文：その名前を種目にしたら、その種目のメモにできる（prevPend）
        var stp = pend({ kind: 'name', lines: [ln], text: splitTail, parsed: { exercise: splitTail, sets: [] }, candidates: [], prevPend: res.pending.indexOf(p), note: splitTail });
        if (!memoQuiet(splitTail)) stp.propose = 'exnote';
      }
    }

    //   数字の無い種目＝セットが0で、決定待ちも付いていない種目だけ
    res.items.forEach(function (it, j) { it.doneOnly = it.sets.length === 0 && !meta[j].pend; });
    return res;
  }
  // ［memo-parse ここまで］

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
  //   休憩タイマーを使うか（端末に覚える・既定はあり＝今までの動き・2026-11-06 オーナー）。なしなら✓で数えず、帯も秒数・終了音の行も出さない
  function restOn() { try { return localStorage.getItem('karte_rest_on') !== 'off'; } catch (e) { return true; } }
  function setRestOn(on) { try { localStorage.setItem('karte_rest_on', on ? 'on' : 'off'); } catch (e) {} if (!on) restStop(); }
  function restStart(sec) {
    if (!restOn()) { restStop(); return; }   // ★二重の守り：呼ぶ側が止め忘れても数えない
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
    //   共有の種目の一覧（部位つき）も一緒に読む。読めなければ（古い Worker・失敗）固定の種目と名前からの推定だけで続ける
    var exP = kRead('k_exercises', {}).then(function (x) { return x; }, function () { return null; });
    Promise.all([kRead('k_training', { customerId: cur.customerId }), exP]).then(function (rr) {
      var r = rr[0], ex = rr[1];
      if (ex && ex.success && Array.isArray(ex.exercises)) {
        var m = {};
        ex.exercises.forEach(function (e) { if (e && typeof e.name === 'string' && e.name) m[e.name] = (typeof e.part === 'string' ? e.part : null); });
        exMaster = m; exTruncated = ex.truncated === true;
      }
      if (cur.customerId !== askedFor || cur.tab !== 'training') return;   // ★頼んだ顧客＝いまの顧客のときだけ
      box.innerHTML = '';
      if (!r || !r.success) { cur.wantDayView = null; box.appendChild(msg(errText(r), true)); return; }
      cur.trSchema = r.karteSchema;   // 指導メモのタグを送ってよいか（今日の記録の中の指導メモ）
      cur.aiDraft = r.aiDraft === true;   // 設計39：AI の振り分けのボタンを出すか（Worker の切替が開き鍵があるときだけ真）
      cur.aiConsent = typeof r.aiConsent === 'string' ? r.aiConsent : 'unknown';   // 設計44：その会員の録音・AI の同意（画面の補助。関門は Worker）
      var sessions = r.sessions || [];
      //   ★今日の記録は専用の画面（2026-11-05 モックどおり）。読み直し後の復元・戻る/進むでも専用画面を開き直す
      if (draft && (draft.kind === 'training' || (draft.kind === 'sub' && draft.sub === 'trform'))) { trainingSub(box, sessions, draft.navMode, draft.kind === 'training' ? draft.ex : null); return; }
      if (draft && draft.kind === 'sub' && draft.sub === 'trpick') { trPickSub(sessions, draft.navMode); return; }
      if (draft && draft.kind === 'sub' && draft.sub === 'trimport') { trImportSub(sessions, draft.navMode); return; }   // 戻る・進む：貼った文字は持っていない（I63）＝空の欄から
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
  function trainingSub(box, sessions, mode, exRestore) {
    navPush({ cid: cur.customerId, tab: 'training', sub: 'trform' }, mode);
    box.innerHTML = '';
    entryHead('今日の記録を入れる', 'トレーニングの画面に戻る');
    box.appendChild(trainingForm(sessions, exRestore));
  }
  //   過去の記録から写す（専用の画面・モック K3b）：前回の日を最初から選んでおく＝「写す画面を開く→写す」の2タップで前回から始められる
  //   ★写した結果は端末の下書きに書いてから記録の画面に戻る（下書きの仕組みをそのまま使う）
  function partsOf(sess) { var m = {}, out = []; function add(name) { var pt = partOf(name); if (!m[pt]) { m[pt] = 1; out.push(pt); } } (sess.sets || []).forEach(function (x) { add(x.exercise); }); if (isNewSess(sess)) sess.exercises.forEach(function (x) { if (x && x.exercise) add(x.exercise); }); return out; }
  /**
   * その回の種目のかたまり。groups＝[{ exercise, sets（set_no の順）, doneOnly }]
   *   古い回：今までどおり名前でまとめる（by・order も今までどおり）
   *   新しい回（設計38）：ord ごとのかたまり（exercises の順・同じ名前でも別のかたまり・数字の無い種目もかたまり）
   */
  function exOrder(sess) {
    var by = {}, order = [];
    (sess.sets || []).slice().sort(function (a, b) { return a.set_no - b.set_no; }).forEach(function (x) { if (!by[x.exercise]) { by[x.exercise] = []; order.push(x.exercise); } by[x.exercise].push(x); });
    if (!isNewSess(sess)) return { by: by, order: order, groups: order.map(function (ex) { return { exercise: ex, sets: by[ex], doneOnly: false }; }) };
    var gs = [], byOrd = {};
    sess.exercises.slice().sort(function (a, b) { return a.ord - b.ord; }).forEach(function (x) { var g = { exercise: String(x.exercise), sets: [], doneOnly: x.doneOnly === true, ord: x.ord }; byOrd[x.ord] = g; gs.push(g); });
    var stray = {};
    (sess.sets || []).slice().sort(function (a, b) { return a.set_no - b.set_no; }).forEach(function (x) {
      var g = byOrd[x.ord];
      if (!g) { g = stray[x.exercise]; if (!g) { g = stray[x.exercise] = { exercise: x.exercise, sets: [], doneOnly: false }; gs.push(g); } }   // 並びの無いセット（起きないはず）も黙って消さない
      g.sets.push(x);
    });
    return { by: by, order: order, groups: gs };
  }
  function copyInto(D, sess, withNums) {
    var o = exOrder(sess), cut = false;
    if (isNewSess(sess)) {
      //   ★新しい回：写す元の1つの ord ＝ 下書きの1つの種目（同じ名前が下書きにあっても混ぜない・後ろに足す）。
      //     ドロップの形は写す・補助と無理やりは写さない（その日の結果）・数字の無い種目は数字の無い種目のまま（✓は外す）
      o.groups.forEach(function (g) {
        if (D.items.length >= 20) { cut = true; return; }
        if (g.doneOnly && !g.sets.length) { D.items.push({ exercise: g.exercise, sets: [], doneOnly: false }); return; }
        var sets = [], room = TR_TOTAL - totalSets(D.items);
        g.sets.slice(0, 10).forEach(function (x) {
          var st = withNums ? { w: isBw(x.weight_kg) ? '' : x.weight_kg, r: x.reps, done: false } : { w: '', r: '', done: false };
          var ds = withNums && Array.isArray(x.drops) ? x.drops.map(function (d) { return { w: isBw(d.weight_kg) ? '' : d.weight_kg, r: d.reps }; }) : [];
          if (ds.length) st.drops = ds;
          if (1 + ds.length > room) { cut = true; return; }
          room -= 1 + ds.length; sets.push(st);
        });
        if (sets.length < g.sets.length) cut = true;
        if (sets.length) D.items.push({ exercise: g.exercise, sets: sets });
      });
      D.openEi = D.items.length - 1;
      return cut;
    }
    o.order.forEach(function (ex) {
      var sets = o.by[ex].map(function (x) { return withNums ? { w: isBw(x.weight_kg) ? '' : x.weight_kg, r: x.reps, done: false } : { w: '', r: '', done: false }; });   // 自重（0）は空で写す
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
        if (on) kids.push(el('div', { style: 'display:flex;flex-direction:column;gap:4px;font-size:14px;' }, o.groups.map(function (g) {
          return el('div', { style: 'display:flex;justify-content:space-between;gap:8px;' }, [el('span', { text: g.exercise }), el('span', { class: 'k-sub', style: 'font-size:13px;', text: setLineOf(g.sets) })]);
        })));
        else kids.push(el('div', { class: 'k-sub', style: 'font-size:13px;', text: o.groups.map(function (g) { return g.exercise; }).join('・') }));
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
  // ---------------------------------------------------------------- メモから取り込む（設計38 §5-2・5-3）
  //   ★守ること
  //     ・貼った原文と決定待ちは、この関数の中の変数と画面の要素（メモリ）にだけ置く。localStorage・sessionStorage・送信・console に出さない（I63）
  //     ・この画面からは何も送らない（部位の登録も記録の画面へ回す）＝トークンの取り直しが起きない・原文が退避に乗らない
  //     ・autoKnown と完全一致しない名前・括弧書きは、トレーナーが選ぶまでどこにも入れない（I71）。最近の種目の候補は名前の欄に仮に入れるだけ
  //     ・入れたセットの✓はすべて外す（I57・★B）
  var trImportMsg = null;   // 取り込んだ直後に記録の画面の上に出す1行（件数だけ・メモリだけ）
  var IMP_KIND = { name: '種目名の確かめが必要です', line: '読めなかった行', paren: '括弧書きのあるセット', tail: '行の残り（読めなかった部分）', limit: '上限を超えた分（20種目・1種目10セット・合計60・ドロップ3段）',
    second_date: '2つ目の日付から後ろ', bad_date: '日付として読めない行', no_exercise: '種目の無い数値', rule: '読めた数値（確かめてから足します）',
    aiunv: 'AI：数字を確かめられないセット' };
  //   設計39：AI の下書きのカードの見出し（cat ごと）
  var AI_CAT = { coaching: 'AI：指導のメモ', hearing: 'AI：ヒアリング', caution: 'AI：体の状態（注意すること）', member: 'AI：お客様へ', todo: 'AI：次回までに' };
  //   設計39 改訂2 高4：AI の決定待ちに許す決定（表に無い組み合わせは build が投げる＝取り込み全体を止める）
  var AI_ACTS = { caution: ['discard'], member: ['member', 'memo', 'discard'], todo: ['todo', 'memo', 'discard'], coaching: ['memo', 'discard'], hearing: ['memo', 'discard'],
    aiunv: ['memo', 'discard'], rule: ['addset', 'memo', 'discard'], name: ['item', 'memo', 'discard'] };
  var AI_TEXT_MAX = 30000;
  var AI_STALE = 'ログインの更新が必要です。貼った文字をコピーしてから LINE で開き直し、もう一度貼ってください。';
  function aiErr(r) {
    var c = r && r.code;
    if (c === 'AI_NOT_CONFIGURED') return 'AIの振り分けはいま使えません。「読み取る」で取り込めます。';
    if (c === 'AI_DAILY_LIMIT') return '今日のAIの振り分けの回数の上限に達しました。「読み取る」で取り込めます。';
    if (c === 'AI_TOO_LONG' || c === 'TOO_LARGE') return '長すぎます（3万字まで）。分けて貼ってください。';
    if (c === 'UNAUTHORIZED') return AI_STALE;
    if (c === 'AI_REFUSED' || c === 'AI_BAD_OUTPUT' || c === 'AI_TRUNCATED') return 'AIが下書きを作れませんでした。「読み取る」で取り込めます（もう一度押すと1日の回数を1回使います）。';
    return 'AIの振り分けに失敗しました（' + (c || '通信') + '）。もう一度押すと1日の回数を1回使います。「読み取る」でも取り込めます。';
  }
  var I55_HINT = '種目名・メモに痛み・診断・服薬を入れない（「注意すること」へ）';
  function impSet(st) {   // 読み取った形 → 下書きのセット（✓は外す・印の無い鍵は持たない）
    var o = { w: st.w, r: st.r, done: false };
    if (st.assist != null) o.assist = String(st.assist);
    if (st.forced === true) o.forced = true;
    var ds = (st.drops || []).map(function (d) { var x = { w: d.w, r: d.r }; if (d.assist != null) x.assist = String(d.assist); if (d.forced === true) x.forced = true; return x; });
    if (ds.length) o.drops = ds;
    return o;
  }
  function impLine(sets) { return (sets || []).map(function (st) { return setOneLine({ weight_kg: st.w === '' ? 0 : st.w, reps: st.r, assist_reps: st.assist, forced: st.forced, drops: (st.drops || []).map(function (d) { return { weight_kg: d.w === '' ? 0 : d.w, reps: d.r, assist_reps: d.assist, forced: d.forced }; }) }); }).join('・'); }
  function trImportSub(sessions, mode) {
    navPush({ cid: cur.customerId, tab: 'training', sub: 'trimport' }, mode);
    var box = cur.body; box.innerHTML = '';
    entryHead('メモから取り込む', '今日の記録に戻る');
    var tid = String((window.state && state.trainerId) || ''), cid = cur.customerId;
    var key = TR_DRAFT_PREFIX + tid + ':' + cid;
    function draftNow() { var T = lsGet(key); return (T && (T.tid !== tid || T.cid !== cid || T.v !== 1)) ? null : T; }
    var D0 = draftNow();
    if (D0 && (D0.pending || D0.mpending || D0.memoPending)) { box.appendChild(msg('前回の保存の結果を確かめるまで取り込めません。今日の記録の画面に戻ってください。', true)); return; }
    if (!extOk()) { box.appendChild(msg('いまはメモから取り込めません（システムの更新中の可能性があります）。今日の記録の画面から入力してください。', true)); return; }
    //   autoKnown＝固定の種目 ∪ 共有の種目（自動で種目にしてよい名前）。suggestKnown＝この方の最近の種目（候補にだけ使う・自動では使わない）
    var autoKnown = EXERCISES.concat(Object.keys(exMaster));
    var sugg = [];
    (sessions || []).forEach(function (x) {
      (x.sets || []).forEach(function (st) { if (sugg.indexOf(st.exercise) < 0) sugg.push(st.exercise); });
      if (isNewSess(x)) x.exercises.forEach(function (e) { if (e && sugg.indexOf(e.exercise) < 0) sugg.push(e.exercise); });
    });
    function isAuto(name) { return autoKnown.some(function (a) { return exName(a) === name; }); }
    var wrap = el('div', { class: 'k-imp', style: 'display:flex;flex-direction:column;gap:8px;' });
    wrap.appendChild(el('div', { class: 'k-sub', style: 'font-size:13px;line-height:1.7;', text: '紙のメモを打つか、貼ってください。キーボードのマイクで話しても入ります（例：ヒップリフト／改行／30かける10　50かける10プラス5）。' }));
    wrap.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }));
    if (exTruncated) wrap.appendChild(el('div', { class: 'k-sub', style: 'color:var(--k-warn);', text: '共有の種目を一部しか読めていないため、確かめが必要な名前が増えます。' }));
    var ta = el('textarea', { rows: '10', class: 'k-memo', 'aria-label': 'メモを貼る', autocomplete: 'off', autocapitalize: 'off', spellcheck: 'false', 'data-nodirty': '1', placeholder: '9/18\nヒップリフト\n30×10 50×10+5' });
    wrap.appendChild(ta);
    var out = el('div', { style: 'display:flex;flex-direction:column;gap:10px;' });
    wrap.appendChild(out);
    var bar = el('div', { class: 'k-savebar' });
    box.appendChild(wrap); box.appendChild(bar);
    var res = null, dec = [], ui = [], ask = false, err = '', lines0 = [], planOpen = false;
    var aiBusy = false, aiGen = 0;   // 設計39：送信中・応答の世代（文字を変えたら古い応答を捨てる）
    ta.oninput = function () {
      var was = aiBusy; aiGen++; aiBusy = false;
      if (res || err || ask || was) { res = null; dec = []; ui = []; ask = false; err = ''; planOpen = false; draw(); }
    };
    function allDecided() { return !!res && dec.every(function (d) { return !!d; }); }
    function read() {
      err = ''; ask = false; planOpen = false;
      lines0 = String(ta.value || '').split(/\r\n|\r|\n/);
      res = parseMemo(ta.value, today(), autoKnown, sugg);
      dec = res.pending.map(function () { return null; });
      ui = res.pending.map(function (p) { return { name: (p.parsed && p.parsed.exercise) || '', open: false }; });
      if (!res.items.length && !res.pending.length) { res = null; err = '読み取れる行がありませんでした。'; draw(); return; }
      if (!res.pending.length) { place(); return; }
      draw();
      var first = out.querySelector('.k-impcard'); if (first) { try { first.scrollIntoView({ block: 'center' }); } catch (e) {} }
    }
    //   決定待ちの名前を、メモの行の順の位置に入れる：その行より前だけを読み取り直して、前にある種目の数を数える（読み取りの関数は変えない）
    function posOf(p) { if (p.pos != null) return p.pos; return parseMemo(lines0.slice(0, p.lines[0] - 1).join('\n'), today(), autoKnown, sugg).items.length; }
    //   ---- 設計39：AI の下書き → 既存の res（items＋pending）。AI のセットは全部 addset の決定待ち（計画の一覧を通す）・✓なし
    //     ★名前が autoKnown と完全一致した種目だけ items。一致しない名前は sets を持たない name＋その後ろの rule（pendItem）
    function aiToRes(dr) {
      var items = [], pending = [], sq = 0;
      function P(o) { o.ai = true; o.lines = []; o.label = 'AIの下書き'; o.pos = items.length; pending.push(o); return pending.length - 1; }
      function str(v) { return typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : ''; }
      function wl(w) { return w == null ? '自重' : String(w) + 'kg'; }
      (Array.isArray(dr.exercises) ? dr.exercises : []).forEach(function (e) {
        var name = exName(e.name), heard = str(e.heard), label = name || heard || '種目';
        var quiet = [], sets = [], evs = [];
        (Array.isArray(e.sets) ? e.sets : []).forEach(function (st) {
          var o = { w: st.w == null ? '' : String(st.w), r: String(st.r), assist: null, forced: false, drops: [], sq: ++sq };
          var nt = str(st.note);
          if (nt && !memoQuiet(nt)) o.note = nt; else if (nt) quiet.push(label + '：' + nt);
          sets.push(o); evs.push('「' + str(st.evidence) + '」');
        });
        var evText = evs.join('／');
        if (name && isAuto(name)) {
          var idx = items.push({ exercise: name, sets: [], doneOnly: true }) - 1;
          if (sets.length) P({ kind: 'rule', item: idx, text: name + '：' + evText, parsed: { exercise: name, sets: sets }, propose: 'addset' });
        } else if (name || heard) {
          var nj = P({ kind: 'name', text: label + (heard && heard !== label ? '（聞こえた言葉：' + heard + '）' : ''), after: null, prevPend: null, candidates: [], parsed: { exercise: label.slice(0, EX_NAME_MAX), sets: [] } });
          if (sets.length) P({ kind: 'rule', pendItem: nj, text: label + '：' + evText, parsed: { exercise: label, sets: sets }, propose: 'addset' });
        } else sets.forEach(function (o, i) { P({ kind: 'aiunv', text: '（種目名なし）' + wl(o.w === '' ? null : o.w) + '×' + o.r + ' ' + evs[i] }); });
        (Array.isArray(e.unverified) ? e.unverified : []).forEach(function (u) {
          var ev = str(u.evidence);
          P({ kind: 'aiunv', text: label + ' ' + wl(u.w) + '×' + (u.r == null ? '?' : u.r) + (ev ? '（「' + ev + '」）' : '') + '　文字起こしの中で数字を確かめられません' });
        });
        var en = str(e.note);
        if (en) P({ kind: 'ai', cat: 'coaching', text: label + '：' + en, propose: memoQuiet(en) ? null : 'memo' });
        quiet.forEach(function (t) { P({ kind: 'ai', cat: 'coaching', text: t, propose: null }); });
      });
      function list(k) { return (Array.isArray(dr[k]) ? dr[k] : []).map(str).filter(Boolean); }
      list('coaching').forEach(function (t) { P({ kind: 'ai', cat: 'coaching', text: t, propose: memoQuiet(t) ? null : 'memo' }); });
      list('hearing').forEach(function (t) { P({ kind: 'ai', cat: 'hearing', text: 'ヒアリング：' + t, propose: memoQuiet(t) ? null : 'memo' }); });
      list('caution').forEach(function (t) { P({ kind: 'ai', cat: 'caution', text: t }); });
      var mm = str(dr.member_message);
      if (mm) P({ kind: 'ai', cat: 'member', text: mm });
      list('member_todo').forEach(function (t) { P({ kind: 'ai', cat: 'todo', text: t }); });
      return { date: null, items: items, pending: pending, ai: true };
    }
    //   設計39 改訂3：AI の rule の宛先（item＝一覧の種目／pendItem＝自分より前の AI の name を「種目にした」ときだけ）。表示・提案・カード・組み立て・許可が全部これを使う
    function ruleTarget(p) {
      if (p.item != null) return (typeof p.item === 'number' && res.items[p.item]) ? { base: p.item, name: res.items[p.item].exercise } : null;
      if (p.ai && p.pendItem != null) {
        var k = p.pendItem, me = res.pending.indexOf(p), q = res.pending[k];
        if (typeof k === 'number' && k >= 0 && k < me && q && q.ai && q.kind === 'name' && dec[k] && dec[k].act === 'item') return { pend: k, name: dec[k].name };
      }
      return null;
    }
    function aiActOk(p, d) {
      var key = p.kind === 'ai' ? p.cat : p.kind, ok = AI_ACTS[key];
      if (!ok || ok.indexOf(d.act) < 0) return false;
      if ((p.kind === 'ai' || p.kind === 'aiunv' || p.kind === 'rule') && d.act !== 'discard' && d.act !== 'addset' && MEMO_HEALTH.test(String(p.text || ''))) return false;   // 関門② 高1：健康語の文は捨てるだけ
      if (p.kind === 'rule' && d.act === 'addset' && !ruleTarget(p)) return false;
      return true;
    }
    //   設計39：文字起こしを Worker へ送り、AI の下書きを受け取る（I76）。★送るのはこの1回だけ・kWrite（読み直して退避）は使わない
    function aiSend() {
      if (aiBusy) return;
      var text = String(ta.value || '').trim();
      err = ''; ask = false; planOpen = false;
      if (!text) { err = '文字起こしを貼ってください。'; draw(); return; }
      if (text.length > AI_TEXT_MAX) { err = aiErr({ code: 'AI_TOO_LONG' }); draw(); return; }
      adoptFreshToken();
      if (tokenNeedsRefresh()) { err = AI_STALE; draw(); return; }   // ★送らない・読み直さない（原文を保存領域へ退避できない＝I63）
      var known = [];
      autoKnown.forEach(function (n) { var x = exName(n); if (x && x.length <= EX_NAME_MAX && known.indexOf(x) < 0) known.push(x); });
      var gen = ++aiGen; aiBusy = true; res = null; draw();
      fetch(String(EDGE_URL).replace(/\/+$/, '') + '/karte/ai-draft', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'k_aiDraft', idToken: idToken, customerId: cid, text: text, known: known.slice(0, 600) }) })
        .then(function (r) { return r.json().catch(function () { return { success: false, code: 'BAD_RESPONSE' }; }); }, function () { return { success: false, code: 'NETWORK' }; })
        .then(function (r) {
          if (gen !== aiGen || !out.isConnected || cur.customerId !== cid) return;   // 文字を変えた・画面を離れた・別の顧客＝捨てる
          aiBusy = false;
          if (!r || !r.success || !r.draft || typeof r.draft !== 'object') { err = aiErr(r); draw(); return; }
          var rr;
          try { rr = aiToRes(r.draft); } catch (e) { err = aiErr({ code: 'AI_BAD_OUTPUT' }); draw(); return; }
          lines0 = [];
          res = rr;
          dec = res.pending.map(function () { return null; });
          ui = res.pending.map(function (p) { return { name: (p.parsed && p.parsed.exercise) || '', open: false }; });
          if (!res.items.length && !res.pending.length) { res = null; err = 'AIの下書きに入れられる内容がありませんでした。'; draw(); return; }
          if (!res.pending.length) { place(); return; }
          draw();
          var first = out.querySelector('.k-impcard'); if (first) { try { first.scrollIntoView({ block: 'center' }); } catch (e) {} }
        });
    }
    //   設計41 F・G：いまの決定（dec）を pending の順に再生して、種目とセットを組み立てる。build・makePlan・カードで同じ関数を使う（数え方を1つに）
    //     セットは通し番号 sq の順に並べ直す（自動・括弧・addset・名前の下見・メモが運ぶセットを、メモの行の順にそろえる）。
    //     addset は足すと 1種目10セット・合計60段（ドロップ込み）を超えるなら1つも足さない＝blocked。lite＝並べ替えとメモの付け先だけ（画面の判定用・posOf を呼ばない）
    function assemble(lite) {
      function wrap(st) { var e = { sq: st.sq, s: impSet(st) }; if (st.note) e.s.note = String(st.note).slice(0, 200); return e; }
      var base = res.items.map(function (it) {
        var o = { exercise: it.exercise, sets: it.sets.map(wrap), fromMemo: true };
        if (it.doneOnly) o.doneOnly = false;   // 数字の無い種目：「実施した」の✓は外して入れる
        return o;
      });
      var memos = [], named = [], exnotes = [], snotes = [], namedBy = {}, blocked = {}, nSet = 0, members = [], todos = [];
      function every() { return base.concat(named.map(function (x) { return x.item; })); }
      function tot() { var n = 0; every().forEach(function (o) { o.sets.forEach(function (e) { n += 1 + ((e.s.drops || []).length); }); }); return n; }
      res.pending.forEach(function (p, j) {
        var d = dec[j];
        if (!d) return;
        //   設計39 改訂2 高4：AI の決定待ちは許す決定だけ（組み立て本番だけで確かめる＝画面の判定 lite では投げない）
        if (!lite && p.ai && !aiActOk(p, d)) throw new Error('AI_ACT');
        if (d.act === 'memo') memos.push(p.text);
        else if (d.act === 'member') members.push(String(p.text));
        else if (d.act === 'todo') todos.push(String(p.text));
        else if (d.act === 'exnote') {
          //   種目の下に書いたメモ：その種目の1セット目のメモへ（お客様には出ない）。名前の決定待ちの下の数値は、その種目のセットにする（メモの行が種目と数値の間にあった）
          //   ★宛先は今の決定から解き直す（画面で選んだ後に前の決定が変わっていたら入れない・黙って別の種目へ入れない）
          var tg = exTarget(j), tit = !tg ? null : tg.base != null ? base[tg.base] : namedBy[tg.pend];
          if (!tit) { memos.push(p.text); return; }
          var carried = ((p.parsed && p.parsed.sets) || []).map(wrap);
          if (carried.length) { tit.sets = tit.sets.concat(carried); delete tit.doneOnly; }
          exnotes.push({ it: tit, text: exNoteText(p) });
        }
        //   設計40 G3・設計41 F：数値の後ろの文を、そのセット（通し番号）のメモへ。付け先は並べ替えた後に探す
        else if (d.act === 'setnote') snotes.push({ sq: p.setSq, text: String(p.text).trim() });
        else if (d.act === 'set' && p.item != null && base[p.item]) {
          var e0 = wrap(p.parsed.sets[0]); if (d.note && p.parsed.paren) e0.s.note = String(p.parsed.paren).slice(0, 200);
          if (base[p.item].sets.length + 1 > MEMO_LIMITS.setsPerOrd || tot() + 1 + ((e0.s.drops || []).length) > MEMO_LIMITS.total) { blocked[j] = true; return; }
          base[p.item].sets.push(e0);
        }
        else if (d.act === 'addset') {
          //   設計41：規則で読んだ数値（R2・R5・R7・R8・R10）。上限を超えるなら1つも足さない
          var ti = p.item != null ? base[p.item] : null, add = (p.parsed.sets || []).map(wrap);
          if (!ti && p.ai && p.pendItem != null) { var rt = ruleTarget(p); ti = rt && rt.pend != null ? (namedBy[rt.pend] || null) : null; }   // 設計39：種目にした AI の名前へ
          var nd = add.reduce(function (n, e) { return n + 1 + ((e.s.drops || []).length); }, 0);
          if (!ti || ti.sets.length + add.length > MEMO_LIMITS.setsPerOrd || tot() + nd > MEMO_LIMITS.total) { blocked[j] = true; return; }
          ti.sets = ti.sets.concat(add); delete ti.doneOnly;
        }
        else if (d.act === 'item') {
          var it = { exercise: d.name, sets: ((p.parsed && p.parsed.sets) || []).map(wrap), fromMemo: true };
          if (!it.sets.length) it.doneOnly = false;
          if (d.part) it.regPart = d.part;
          namedBy[j] = it;
          named.push({ pos: lite ? 0 : posOf(p), item: it });
          if (d.r3) exnotes.push({ it: it, text: String(p.text).trim() });   // 設計41 R3：行の途中の種目名。原文の全体をその種目のメモに（つながない）
        }
      });
      var live = {};
      every().forEach(function (o) { o.sets.sort(function (a, b) { return a.sq - b.sq; }); o.sets.forEach(function (e) { live[e.sq] = o; }); });
      if (lite) return { blocked: blocked, live: live };
      snotes.forEach(function (x) {
        var o = x.sq != null ? live[x.sq] : null, e = o ? o.sets.filter(function (q) { return q.sq === x.sq; })[0] : null;
        if (!e) { var hx = x.sq != null ? sqInfo(x.sq) : null; memos.push((hx ? hx.exercise + '：' : '') + x.text); return; }   // そのセットが入らなかった（捨てた・上限）＝種目名を付けて社内メモへ（切らない）
        var bx = (e.s.note ? e.s.note + '・' : '') + x.text;
        if (bx.length <= 200) { e.s.note = bx; nSet++; } else memos.push(o.exercise + '：' + x.text);
      });
      every().forEach(function (o) { o.sets = o.sets.map(function (e) { return e.s; }); });
      var items = [];
      for (var i = 0; i <= base.length; i++) {
        named.forEach(function (x) { if (x.pos === i) items.push(x.item); });
        if (i < base.length) items.push(base[i]);
      }
      named.forEach(function (x) { if (x.pos > base.length) items.push(x.item); });
      //   ★黙って捨てない：セットが無い種目（実施のみ）・200字を超える分は、種目名を付けて社内メモへ
      var nNote = 0;
      exnotes.forEach(function (x) {
        var it = x.it, s0 = it.sets[0], cur0 = s0 ? String(s0.note || '') : '', nx = (cur0 ? cur0 + '・' : '') + x.text;
        if (s0 && nx.length <= 200) { s0.note = nx; nNote++; }
        else memos.push(it.exercise + '：' + x.text);
      });
      return { items: items, memos: memos, nNote: nNote, nSet: nSet, blocked: blocked, members: members, todos: todos };
    }
    function build() { return assemble(false); }
    //   設計41 G：その決定を足しても上限に収まるか（いまの決定を全部再生した上で判定）。dec 本体は変えない
    function fits(j, d) {
      var real = dec, dd = dec.slice(); dd[j] = d; dec = dd;
      try { return !assemble(true).blocked[j]; } finally { dec = real; }
    }
    function liveSq(sq) { return sq != null && !!assemble(true).live[sq]; }
    //   通し番号のセットがどの種目のどれか（行き先の文に使う）
    function sqInfo(sq) {
      var hit = null;
      res.items.forEach(function (it) { it.sets.forEach(function (st) { if (st.sq === sq) hit = { exercise: it.exercise, set: st }; }); });
      if (!hit) res.pending.forEach(function (p) { ((p.parsed && p.parsed.sets) || []).forEach(function (st) { if (st.sq === sq) hit = { exercise: p.item != null && res.items[p.item] ? res.items[p.item].exercise : p.parsed.exercise, set: st }; }); });
      return hit;
    }
    //   下書きへ入れる（5-3）。空なら日付をメモの日付に。種目があれば、日付が違えば入れない・同じ（または日付の行が無い）なら2択
    function place() {
      var T = draftNow();
      if (T && (T.pending || T.mpending || T.memoPending)) { err = '前回の保存の結果を確かめるまで取り込めません。'; draw(); return; }
      if (T && (T.items || []).length) {
        if (res.date && res.date !== T.sessionDate) { err = '入力中の記録は ' + md(T.sessionDate) + ' です。' + md(res.date) + ' のメモは、いまの記録を保存してから取り込んでください。'; draw(); return; }
        ask = true; draw(); return;
      }
      commit();
    }
    function commit() {
      var T = draftNow();
      if (T && (T.pending || T.mpending || T.memoPending)) { err = '前回の保存の結果を確かめるまで取り込めません。'; ask = false; draw(); return; }
      var wasEmpty = !T || !(T.items || []).length;
      if (!T) T = { v: 1, tid: tid, cid: cid, sessionDate: today(), items: [], reqId: newReqId(), pending: null, at: Date.now() };
      if (wasEmpty && res.date) T.sessionDate = res.date;
      var b;
      try { b = build(); } catch (e) { ask = false; err = 'この選び方では入れられません。カードを選び直してください。'; draw(); return; }   // ★下書きは変えない
      var all = (T.items || []).concat(b.items);
      //   上限（20種目・1種目10セット・合計60＝ドロップも数える）。超えるなら入れない（黙って切らない）
      //   ★設計41 G：決めたセットが上限で入らなかった（blocked）ものが1つでもあれば、取り込み全体を止める（黙って落とさない）
      if (Object.keys(b.blocked).length || all.length > 20 || totalSets(all) > TR_TOTAL || b.items.some(function (it) { return it.sets.length > 10; })) {
        ask = false; err = '上限（20種目・1種目10セット・合計60セット。ドロップも1つと数えます）を超えるため入れられません。どれかを捨てるか、いまの記録を保存してから取り込んでください。'; draw(); return;
      }
      //   設計39：お客様に見える欄（お客様へ・次回までに）。入らなければ取り込み全体を止める（途中まで入れない）。お客様に出るのは記録の画面で「保存する」を押したときだけ
      var mNew = null;
      if (b.members.length || b.todos.length) {
        var m0 = (T.member && typeof T.member === 'object') ? T.member : {};
        mNew = { message: String(m0.message || ''), todo: Array.isArray(m0.todo) ? m0.todo.slice() : [], tags: Array.isArray(m0.tags) ? m0.tags.slice() : [] };
        while (mNew.todo.length < MEMBER_MAX.todo) mNew.todo.push('');
        if (b.members.length) { var addM = b.members.join('\n'); mNew.message = mNew.message.trim() ? mNew.message.replace(/\s+$/, '') + '\n' + addM : addM; }
        var free = []; mNew.todo.forEach(function (v, i) { if (i < MEMBER_MAX.todo && !String(v || '').trim()) free.push(i); });
        if (mNew.message.length > MEMBER_MAX.message || b.todos.length > free.length || b.todos.some(function (t) { return t.length > MEMBER_MAX.todoLen; })) {
          ask = false; err = 'お客様に見える欄に入りきりません（お客様へ' + MEMBER_MAX.message + '字・次回までに' + MEMBER_MAX.todo + 'つ）。どれかを社内メモか捨てるにしてください。'; draw(); return;
        }
        b.todos.forEach(function (t, i) { mNew.todo[free[i]] = t; });
      }
      var first = (T.items || []).length;
      T.items = all;
      if (mNew) T.member = mNew;
      if (b.memos.length) T.memo = (String(T.memo || '').trim() ? String(T.memo).replace(/\s+$/, '') + '\n' : '') + b.memos.join('\n');   // 選んだものだけ社内メモの末尾へ
      T.openEi = first;
      T.at = Date.now();
      if (!lsSet(key, T)) { err = 'この端末に下書きを残せないため、入れられませんでした。'; ask = false; draw(); return; }
      var ns = 0, nd = 0; b.items.forEach(function (it) { it.sets.forEach(function (st) { ns++; nd += (st.drops || []).length; }); });
      trImportMsg = { cid: cid, text: 'メモから ' + b.items.length + '種目・' + ns + 'セット' + (nd ? '（ドロップ' + nd + '）' : '') + 'を入れました。✓を付けて保存してください（✓の無いセットは保存されません）。'
        + (b.nNote ? '種目のメモ ' + b.nNote + '件は、その種目の1セット目のメモに入れました。' : '')
        + (b.nSet ? 'セットのメモ ' + b.nSet + '件は、そのセットのメモに入れました。' : '')
        + (mNew ? 'お客様に見える欄に ' + (b.members.length + b.todos.length) + '件入れました（保存するとお客様に見えます）。' : '')
        + (res.date ? '' : '日付の行がありません。' + md(T.sessionDate) + ' として入れます（見出しで変えられます）。') };
      res = null; dec = []; ui = [];
      goBack();
    }
    function exNoteText(p) { if (p.note != null) return String(p.note).trim(); return p.kind === 'name' ? memoBullet(String(lines0[p.lines[0] - 1] || p.parsed.exercise).trim()) : String(p.text).trim(); }   // 箇条書きの記号は外す（設計40 G8）
    //   設計40：提案の行き先の文（計画の一覧・カードの「提案：」・決めた後の表示で同じ文を使う）
    //   設計41 F：宛先はセットの通し番号。そのセットがいまの決定で入っているときだけ選べる（括弧・規則のセットは、決まってから）
    function setNoteOk(p) { return p.setSq != null && liveSq(p.setSq); }
    function setNoteDest(p) { var h = sqInfo(p.setSq); return '「' + (h ? h.exercise : '') + '」の ' + (h ? impLine([h.set]) : '') + ' のセットのメモ'; }
    function exNoteDest(p, j) { var nm = exTargetName(exTarget(j)); return '「' + nm + '」の1セット目のメモ' + (p.parsed && p.parsed.sets && p.parsed.sets.length ? '。下の数値も「' + nm + '」のセットにする' : ''); }
    function ruleNote(p) { var n = (p.parsed.sets || []).map(function (st) { return st.note; }).filter(Boolean); return n.length ? '（セットのメモ「' + n.join('・') + '」）' : ''; }
    function addSetDest(p) { var t = ruleTarget(p); return '「' + (t ? t.name : '') + '」に ' + impLine(p.parsed.sets) + ' を足す' + ruleNote(p); }
    function parenSetDest(p) { return '「' + res.items[p.item].exercise + '」に ' + impLine(p.parsed.sets) + ' を足し、括弧の中「' + p.parsed.paren + '」をそのセットのメモに'; }
    function proposeDest(p, j) {
      if (p.propose === 'drop') return '捨てる';
      if (p.propose === 'setnote') return setNoteOk(p) ? setNoteDest(p) + '（お客様には見えません）' : null;
      if (p.propose === 'exnote') return exTarget(j) ? exNoteDest(p, j) + '（お客様には見えません）' : null;
      if (p.propose === 'addset') return ruleTarget(p) ? addSetDest(p) : null;
      if (p.propose === 'memo') return '社内メモ（お客様には見えません）';   // 設計39：AI の指導のメモ・ヒアリング
      if (p.propose === 'parenset') return p.item != null && res.items[p.item] ? parenSetDest(p) + '（お客様には見えません）' : null;
      return null;
    }
    function proposeAct(p) { return p.propose === 'drop' ? { act: 'discard' } : p.propose === 'parenset' ? { act: 'set', note: true } : p.propose === 'memo' ? { act: 'memo' } : { act: p.propose }; }
    //   設計40 §4「提案どおりに決める」の計画：dec の写しの上で、添字の小さい順に、未決定で提案があり行き先が解けるものを決めていく
    //   （前の決定で後ろの宛先が解ける）。★dec 本体は変えない（開いただけでは決まらない）
    function makePlan() {
      var real = dec, dd = dec.slice(), list = [];
      dec = dd;
      try {
        res.pending.forEach(function (p, j) {
          if (dd[j] || !p.propose) return;
          var dest = proposeDest(p, j);
          if (!dest) return;
          var d = proposeAct(p);
          dd[j] = d;
          //   設計41 G：足すと上限を超えるもの（それまでの決定を全部再生した上で）は計画に入れない＝未決定のまま残す
          if ((d.act === 'addset' || d.act === 'set') && assemble(true).blocked[j]) { dd[j] = null; return; }
          list.push({ j: j, d: d, text: p.pii ? p.masked : p.text, dest: dest });
        });
      } finally { dec = real; }
      return list;
    }
    //   メモの宛先：{ base: items の添字 } か { pend: 種目にした名前の決定待ちの添字 }。決まらないときは null（ボタンを出さない）
    //   ★prevPend は必ず自分より小さい添字＝たどるたびに減る（循環しない・件数の上限を置かない）
    function exTarget(j) {
      var p = res.pending[j];
      if (!p) return null;
      if (p.kind === 'line' || p.kind === 'tail') return p.item != null && res.items[p.item] ? { base: p.item } : null;
      while (p && p.kind === 'name') {
        if (p.after != null) return res.items[p.after] ? { base: p.after } : null;
        var pp = p.prevPend;
        if (pp == null || pp < 0 || pp >= j) return null;
        var dp = dec[pp];
        if (dp && dp.act === 'item') return { pend: pp };
        if (!dp || dp.act !== 'exnote') return null;
        j = pp; p = res.pending[pp];
      }
      return null;
    }
    function exTargetName(t) { return !t ? '' : t.base != null ? res.items[t.base].exercise : dec[t.pend].name; }
    function exNoteBtn(p, j) {   // 「直前の種目『〇〇』の1セット目のメモにする」（直前の種目が決まっているときだけ）
      var t = exTarget(j);
      if (!t) return null;
      return act('直前の種目「' + exTargetName(t) + '」の1セット目のメモにする', function () { decide(j, { act: 'exnote' }); }, '');
    }
    //   前の決定を選び直したら、それを宛先にしていた「種目のメモ」の決定も外す（宛先が変わったまま残さない）
    function dropDependents(j) {
      //   設計41 F：選び直したもの（括弧・規則のセット）を宛先にしていた「セットのメモ」の決定も外す
      var mine = {}; ((res.pending[j] && res.pending[j].parsed && res.pending[j].parsed.sets) || []).forEach(function (st) { if (st.sq != null) mine[st.sq] = 1; });
      res.pending.forEach(function (q, k) { if (k > j && dec[k] && dec[k].act === 'setnote' && q.setSq != null && mine[q.setSq]) dec[k] = null; });
      //   設計39：AI の名前を選び直したら、そこを宛先にしていた AI の rule の「足す」も外す
      res.pending.forEach(function (q, k) { if (k > j && q.ai && q.pendItem === j && dec[k] && dec[k].act === 'addset') dec[k] = null; });
      res.pending.forEach(function (q, k) {
        if (k <= j || !dec[k] || dec[k].act !== 'exnote') return;
        for (var x = q, at = k; x && x.kind === 'name' && x.prevPend != null && x.prevPend >= 0 && x.prevPend < at; ) {
          if (x.prevPend === j) { dec[k] = null; dropDependents(k); return; }
          at = x.prevPend; x = res.pending[at];
        }
      });
    }
    function btnCol(kids) { return el('div', { class: 'k-impbtns' }, kids); }
    function act(text, fn, cls) { return el('button', { type: 'button', class: 'k-btn ' + (cls || 'out'), text: text, onclick: fn }); }
    function decide(j, d) { dec[j] = d; if (ui[j]) ui[j].err = ''; planOpen = false; draw(); }
    //   設計41 G：セットを足す決定は、いまの決定を全部再生して上限に収まるときだけ（超えるなら決めずにカードに理由を出す）
    function decideFit(j, d) {
      if (!fits(j, d)) { if (ui[j]) ui[j].err = '上限（1種目10セット・合計60セット。ドロップも1つと数えます）を超えるため入れられません。'; draw(); return; }
      decide(j, d);
    }
    function card(p, j) {
      var d = dec[j], u = ui[j];
      var c = el('div', { class: 'k-card k-impcard', 'data-kind': p.kind }, [
        el('div', { style: 'font-weight:700;', text: (p.kind === 'ai' ? AI_CAT[p.cat] : (p.ai && p.kind === 'rule') ? 'AI：読んだ数値（根拠を見て決めます）' : IMP_KIND[p.kind]) || '確かめが必要です' }),
        el('div', { class: 'k-sub', text: (p.lines && p.lines.length) ? p.lines.join('・') + '行目' : (p.label || '') }),
        el('div', { class: 'k-imptext', text: p.text })]);
      if (p.parsed && p.parsed.sets && p.parsed.sets.length && p.kind !== 'paren') c.appendChild(el('div', { class: 'k-sub', text: '読めた数値：' + impLine(p.parsed.sets) }));
      if (!d && p.propose) { var pd = proposeDest(p, j); if (pd) c.appendChild(el('div', { class: 'k-sub k-imppro', text: '提案：' + pd })); }
      if (d) {
        var t = d.act === 'discard' ? '捨てる' : d.act === 'memo' ? '社内メモに足す'
          : d.act === 'member' ? 'お客様へに入れる（お客様に見えます）' : d.act === 'todo' ? '次回までにに入れる（お客様に見えます）'
          : d.act === 'exnote' ? (function () { var nm = exTargetName(exTarget(j)); return '「' + nm + '」の1セット目のメモにする（お客様には見えません）' + (p.parsed && p.parsed.sets && p.parsed.sets.length ? '。下の数値も「' + nm + '」のセットにする' : ''); })()
          : d.act === 'setnote' ? (setNoteOk(p) ? setNoteDest(p) + 'にする（お客様には見えません）' : '社内メモに足す')
          : d.act === 'set' ? (d.note ? '括弧の中をセットのメモに入れてセットにする' : '括弧を除いてセットにする')
          : d.act === 'addset' ? addSetDest(p)
          : '種目「' + d.name + '」にする' + (d.part ? '（' + label(PART_KEYS, d.part) + '）' : '') + (d.r3 ? '。この文をそのメモにする（お客様には見えません）' : '');
        c.appendChild(el('div', { class: 'k-impdone', style: 'font-weight:700;color:var(--k-acc);', text: '→ ' + t }));
        c.appendChild(btnCol([act('選び直す', function () { dec[j] = null; dropDependents(j); if (u) u.open = false; planOpen = false; draw(); })]));
        return c;
      }
      //   設計39：AI の文（指導のメモ・ヒアリング・体の状態・お客様へ・次回までに）と、数字を確かめられないセット。★一般の分岐に落とさない
      if (p.kind === 'ai' || p.kind === 'aiunv') {
        var cat = p.kind === 'aiunv' ? 'aiunv' : p.cat;
        if (cat === 'caution' || MEMO_HEALTH.test(String(p.text || ''))) {   // 健康語を含む文は体の状態と同じく捨てるだけ（関門② 高1）
          c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '体の状態は「注意すること」の画面で入れてください（同意が要ります）。ここからはどこにも入れません。' }));
          c.appendChild(btnCol([act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
          return c;
        }
        var kids = [];
        if (cat === 'member' || cat === 'todo') {
          c.appendChild(el('div', { class: 'k-sub', style: 'font-weight:700;color:var(--k-acc);', text: 'お客様にそのまま見えます' }));
          var lim = cat === 'member' ? MEMBER_MAX.message : MEMBER_MAX.todoLen;
          if (!memoQuiet(p.text) && String(p.text).length <= lim) kids.push(act(cat === 'member' ? 'お客様へに入れる' : '次回までにに入れる', function () { decide(j, { act: cat }); }, ''));
        }
        kids.push(act('社内メモに足す', function () { decide(j, { act: 'memo' }); }));
        kids.push(act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger'));
        c.appendChild(btnCol(kids));
        c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '社内メモはお客様には見えません。' + I55_HINT }));
        return c;
      }
      if (p.kind === 'name') {
        var nameOk = function () { var n = exName(u.name); return n.length >= 1 && n.length <= EX_NAME_MAX; };
        if ((p.candidates || []).length) {
          var cp = el('div', { class: 'k-pills', style: 'gap:6px;' });
          p.candidates.forEach(function (cd) {
            cp.appendChild(el('button', { type: 'button', class: 'k-pill k-impcand', 'data-source': cd.source, text: 'もしかして：' + cd.name, onclick: function () {
              //   ★autoKnown（登録済みの名前）だけ一押しで置き換える。最近の種目は名前の欄に仮に入れるだけ（部位を選んで「種目にする」まで決まらない・I71）
              if (cd.source === 'auto') { decide(j, { act: 'item', name: cd.name, part: null }); return; }
              u.name = cd.name; u.open = false; draw();
            } }));
          });
          c.appendChild(cp);
          c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: I55_HINT }));
        }
        if (p.text.length <= EX_NAME_MAX || exName(u.name).length <= EX_NAME_MAX) {
          var ni = el('input', { type: 'text', maxlength: String(EX_NAME_MAX), 'aria-label': '種目名', 'data-nodirty': '1', autocomplete: 'off', value: u.name });
          ni.value = u.name;
          ni.oninput = function () { u.name = ni.value; };
          c.appendChild(ni);
        }
        if (u.open) {
          c.appendChild(el('div', { class: 'k-sub', text: '部位を選ぶと種目になります（登録するかは記録の画面で選べます）' }));
          var pp = el('div', { class: 'k-pills', role: 'radiogroup', 'aria-label': '部位', style: 'gap:6px;' });
          PART_KEYS.forEach(function (pk) { pp.appendChild(el('button', { type: 'button', role: 'radio', class: 'k-pill', 'aria-checked': 'false', 'data-part': pk[0], text: pk[1], onclick: function () {
            if (!nameOk()) { window.alert('種目名は1〜' + EX_NAME_MAX + '字で入れてください。'); return; }
            decide(j, { act: 'item', name: exName(u.name), part: pk[0] });
          } })); });
          c.appendChild(pp);
        }
        c.appendChild(btnCol([
          //   設計41 R3：行の途中に登録済みの種目名が1つだけある文。一括の計画には入れず、ここで選ぶ（原文の全体をその種目のメモに）
          p.r3 ? act('「' + p.r3 + '」を種目にして、この文をそのメモにする', function () { decide(j, { act: 'item', name: p.r3, part: null, r3: true }); }, '') : null,
          act('種目にする', function () {
            if (!nameOk()) { window.alert('種目名は1〜' + EX_NAME_MAX + '字で入れてください。'); return; }
            if (isAuto(exName(u.name))) { decide(j, { act: 'item', name: exName(u.name), part: null }); return; }   // 登録済みの名前を打ち直した
            u.open = true; draw();
          }, ''),
          exNoteBtn(p, j),
          act('社内メモに足す', function () { decide(j, { act: 'memo' }); }),
          act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
        c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: I55_HINT }));
        return c;
      }
      if (p.kind === 'paren') {
        c.appendChild(el('div', { class: 'k-sub', text: 'セット：' + impLine(p.parsed.sets) + '　括弧の中：' + (p.parsed.paren || '') }));
        if (u && u.err) c.appendChild(msg(u.err, true));
        c.appendChild(btnCol([
          act('括弧を除いてセットにする', function () { decideFit(j, { act: 'set', note: false }); }, ''),
          act('括弧の中をセットのメモに入れてセットにする', function () { decideFit(j, { act: 'set', note: true }); }),
          el('div', { class: 'k-note-hint', style: 'margin:0;', text: I55_HINT }),
          act('社内メモに足す', function () { decide(j, { act: 'memo' }); }),
          act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
        return c;
      }
      if (p.kind === 'rule') {
        //   設計41：規則で読んだ数値。確かめてから足す（「いきます」は予告＝やり切ったかはトレーナーが見る）
        if (u && u.err) c.appendChild(msg(u.err, true));
        var rt = ruleTarget(p);
        //   設計39 改訂3：種目名をまだ決めていない／種目にしなかった AI の名前の下のセットは、足すボタンを出さない
        if (!rt && p.ai && p.pendItem != null) c.appendChild(el('div', { class: 'k-sub', text: dec[p.pendItem] ? '種目にしなかったため、社内メモに足すか捨ててください。' : '先に「' + (res.pending[p.pendItem] && res.pending[p.pendItem].parsed ? res.pending[p.pendItem].parsed.exercise : '') + '」の種目名を決めてください。' }));
        c.appendChild(btnCol([
          rt ? act('「' + rt.name + '」に ' + impLine(p.parsed.sets) + ' を足す', function () { decideFit(j, { act: 'addset' }); }, '') : null,
          (p.ai && MEMO_HEALTH.test(String(p.text || ''))) ? null : act('社内メモに足す', function () { decide(j, { act: 'memo' }); }),
          act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
        c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: p.ai ? '数字は録音の文字起こしから読みました。根拠の文を見て、予告だけ・やり切れなかったセットは記録の画面で直してください。' : '話した数値は予告のことがあります。やり切れなかったセットは、記録の画面で直してください。' }));
        return c;
      }
      if (p.kind === 'limit' || p.kind === 'second_date') {
        if (p.kind === 'second_date') c.appendChild(el('div', { class: 'k-sub', text: '1回の記録に1日分だけ取り込みます。' + String(p.text).split('\n')[0] + ' から後ろは、保存した後にもう一度取り込んでください（貼った文字は消していません）。' }));
        c.appendChild(btnCol([act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
        return c;
      }
      c.appendChild(btnCol([setNoteOk(p) ? act(setNoteDest(p) + 'にする', function () { decide(j, { act: 'setnote' }); }, '') : null, exNoteBtn(p, j), act('社内メモに足す', function () { decide(j, { act: 'memo' }); }), act('捨てる', function () { decide(j, { act: 'discard' }); }, 'out k-danger')]));
      c.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: '社内メモはお客様には見えません。' + I55_HINT }));
      return c;
    }
    function draw() {
      out.innerHTML = ''; bar.innerHTML = '';
      if (err) out.appendChild(msg(err, true));
      if (res) {
        var ns = 0, nd = 0; res.items.forEach(function (it) { it.sets.forEach(function (st) { ns++; nd += (st.drops || []).length; }); });
        out.appendChild(el('div', { class: 'k-impsum', style: 'font-weight:700;', text: (res.ai ? 'AIの下書き' : res.date ? md(res.date) : '日付の行なし') + '・' + res.items.length + '種目・本セット' + ns + (nd ? '（ドロップ' + nd + '）' : '') + (res.pending.length ? '　確かめが必要 ' + res.pending.length + '件' : '') }));
      }
      if (ask) {
        out.appendChild(el('div', { class: 'k-card k-impcard k-impask' }, [
          el('div', { style: 'font-weight:700;', text: '入力中の記録に種目があります' }),
          el('div', { class: 'k-sub', text: 'メモの内容を、いまの入力の後ろに足しますか？（置き換えはしません）' }),
          btnCol([act('いまの入力の後ろに足す', function () { commit(); }, ''), act('やめる', function () { ask = false; draw(); })])]));
        return;
      }
      if (res && !err) {
        //   設計40 §4：提案どおりに決める。押すと「決める内容」を全部並べ、末尾の「この内容で決める」で計画をそのまま適用する（ダイアログなし）
        var plan = makePlan();
        if (plan.length && !planOpen) out.appendChild(el('button', { type: 'button', class: 'k-btn k-impplan', text: '提案どおりに決める（' + plan.length + '件）', onclick: function () { planOpen = true; draw(); } }));
        if (plan.length && planOpen) {
          var pb = el('div', { class: 'k-card k-impplanbox', style: 'display:flex;flex-direction:column;gap:8px;' }, [el('div', { style: 'font-weight:700;', text: '決める内容（' + plan.length + '件）' })]);
          plan.forEach(function (x) { pb.appendChild(el('div', { class: 'k-impplanrow' }, [el('div', { class: 'k-imptext', text: x.text }), el('div', { class: 'k-sub', style: 'font-weight:700;', text: '→ ' + x.dest })])); });
          pb.appendChild(el('div', { class: 'k-note-hint', style: 'margin:0;', text: I55_HINT + '。違うものは「閉じる」を押し、そのカードで選んでください。' }));
          pb.appendChild(btnCol([act('この内容で決める', function () { plan.forEach(function (x) { dec[x.j] = x.d; }); planOpen = false; draw(); }, 'k-impplango'), act('閉じる', function () { planOpen = false; draw(); })]));
          out.appendChild(pb);
        }
        res.pending.forEach(function (p, j) { out.appendChild(card(p, j)); });
      }
      if (res && res.pending.length && !err) {
        var go = el('button', { type: 'button', class: 'k-btn k-impput', text: '記録の画面に入れる', onclick: function () { if (allDecided()) place(); } });
        if (!allDecided()) { go.disabled = true; go.setAttribute('aria-disabled', 'true'); }
        bar.appendChild(go);
        bar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: allDecided() ? 'この画面からは何も送りません' : '全部選ぶと押せます（' + dec.filter(function (x) { return !x; }).length + '件のこり）' }));
        return;
      }
      bar.appendChild(el('button', { type: 'button', class: 'k-btn k-impread', text: '読み取る', onclick: read }));
      if (!cur.aiDraft) { bar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: 'この画面からは何も送りません（端末の中で読み取ります）' })); return; }
      //   設計44：お客様の録音・AI の同意が無ければボタンを出さない（Worker でも 403 で止まる）
      if (cur.aiConsent !== 'agreed') {
        bar.appendChild(el('div', { class: 'k-sub k-noaiconsent', style: 'text-align:center;margin-top:8px;', text: cur.aiConsent === 'none'
          ? 'このお客様は録音と AI の利用に同意していません（会員画面の「同意の内容」から同意できます）。「読み取る」は使えます。'
          : '録音と AI の利用の同意を確認できませんでした。「読み取る」は使えます。' }));
        return;
      }
      //   設計39：AI で振り分ける（Worker の切替が開き鍵があるときだけ）。送信中は押せない
      var ab = el('button', { type: 'button', class: 'k-btn out k-impai', style: 'margin-top:8px;', text: aiBusy ? '振り分けています（1分ほど）' : 'AIで振り分ける（録音の文字起こし）', onclick: aiSend });
      if (aiBusy) { ab.disabled = true; ab.setAttribute('aria-disabled', 'true'); }
      bar.appendChild(ab);
      bar.appendChild(el('div', { class: 'k-sub', style: 'text-align:center;margin-top:6px;', text: '「読み取る」は端末の中だけで読みます。「AIで振り分ける」は外部（Anthropic）へ送ります。登録済みの氏名などは機械的に伏せますが、聞き違い・第三者の名前・トレーナーの名前のかな書きは残ることがあります。保存はしません。' }));
    }
    draw();
  }
  function trainingForm(sessions, exRestore) {
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
        el('div', { style: 'font-size:13px;', text: md(D.pending.payload.sessionDate) + '・' + D.pending.payload.items.map(function (it) { return it.exercise + ' ' + (it.doneOnly === true ? '実施' : it.sets.length + 'セット'); }).join('・') }),
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
    //   メモから取り込んだ直後の1行（メモリにだけある件数の案内・原文は持たない）
    if (trImportMsg && trImportMsg.cid === cid) { note.textContent = trImportMsg.text; note.style.cssText = 'margin-bottom:8px;font-size:14px;font-weight:700;color:var(--k-acc);background:var(--k-acc-l);border-radius:10px;padding:8px 10px;'; }
    trImportMsg = null;

    //   日付は見出しに出す（モック K3）。見出しの日付を押すと端末の日付ピッカーで変えられる
    var d = field('日付', D.sessionDate, 'date'); d.el.max = today(); d.el.setAttribute('data-nodirty', '1');
    var hdDate = cur.root && cur.root.querySelector('.k-entrytext');
    if (hdDate) { d.el.className = 'k-dateover'; d.el.setAttribute('aria-label', '記録の日付を変える'); hdDate.appendChild(d.el); }
    else c.appendChild(d.row);
    //   過去の記録から写す（専用の画面・モック K3b）
    if ((sessions || []).length) c.appendChild(el('button', { type: 'button', class: 'k-btn k-btn-line', text: '過去の記録から写す', onclick: function () { trPickSub(sessions); } }));
    //   メモから取り込む（設計38 §5-1）：Worker が新しい鍵を受け付けるとき（karteSchema 33）だけ。送信中・結果待ちの間はここまで来ない（上で return）
    if (extOk()) c.appendChild(el('button', { type: 'button', class: 'k-btn k-btn-line k-impgo', text: 'メモから取り込む', onclick: function () { trImportSub(sessions); } }));
    //   休憩タイマーの切り替え（端末に覚える・2026-11-06 オーナー）。なし＝✓で数えない・帯と秒数・終了音の行を出さない
    var restTg = el('button', { type: 'button', class: 'k-rtg', 'data-nodirty': '1', onclick: function () {
      setRestOn(!restOn()); drawRestTg(); draw();   // ★なしにした瞬間に動いているタイマーは止める（setRestOn の中）
    } });
    function drawRestTg() { var on = restOn(); restTg.setAttribute('aria-pressed', on ? 'true' : 'false'); restTg.textContent = on ? '休憩タイマー：あり' : '休憩タイマー：なし'; }
    drawRestTg();
    c.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;margin:0 0 8px;' }, [restTg]));
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
      //   ★新しい回で同じ名前の ord が2つ以上：ord ごとに並べて「 ／ 」でつなぐ。無理やりも印つきで出す（設計38 §6-1）
      var body = p.groups ? p.groups.map(function (g) { return setLineOf(g.sets); }).join(' ／ ') : setLineOf(st);   // 0 は「自重」
      var pn = st.filter(function (x) { return x.note; }).map(function (x) { return x.note; });
      return '前回 ' + md(p.s.session_date) + '：' + body + (pn.length ? '（メモ：' + pn[pn.length - 1].slice(0, 30) + (pn[pn.length - 1].length > 30 ? '…' : '') + '）' : '');
    }
    function refreshTop() {
      var t = cur.root && cur.root.querySelector('.k-entrydate');
      if (t) t.textContent = (cname ? cname + ' 様 ／ ' : '') + mdw(D.sessionDate) + ' ▾';   // ▾＝押すと日付を変えられる
    }
    function trimTotal() { var n = 0; D.items.forEach(function (it) { it.sets = it.sets.filter(function () { n++; return n <= TR_TOTAL; }); }); D.items = D.items.filter(function (it) { return it.sets.length; }); }
    d.el.onchange = function () { D.sessionDate = d.get() || today(); save(); refreshTop(); draw(); };

    function numInput(val, kind, label, onv) {   // kind：'kg'（重量）／'回'
      var i = el('input', { type: 'number', step: kind === 'kg' ? '0.5' : '1', placeholder: kind === 'kg' ? '自重なら空のまま' : '回', 'aria-label': label, enterkeyhint: 'next', autocomplete: 'off' });
      //   キーパッドの「次へ」で、重量→回数→次のセットの重量…と進む（最後はキーパッドを閉じる）
      i.onkeydown = function (ev) {
        if (ev.key !== 'Enter') return;
        ev.preventDefault();
        var all = Array.prototype.slice.call(list.querySelectorAll('.k-setrow input'));
        var k = all.indexOf(i);
        if (k >= 0 && k < all.length - 1) all[k + 1].focus(); else i.blur();
      };
      i.inputMode = kind === 'kg' ? 'decimal' : 'numeric';
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
          var colBtn = el('button', { type: 'button', class: 'k-excol', 'aria-label': it.exercise + 'を開く', onclick: function () { D.openEi = ei; save(); draw(); } }, [
            el('span', { style: 'flex:1;min-width:0;font-weight:700;font-size:15px;text-align:left;', text: it.exercise }),
            it.fromMemo ? el('span', { class: 'k-frommemo', text: 'メモから' }) : null,
            el('span', { class: 'k-tag', text: partOf(it.exercise) }),
            el('span', { class: 'k-sub', text: (it.sets.length ? it.sets.length + 'セット' + (nd ? '（✓' + nd + '）' : '') : (it.doneOnly === true ? '実施（✓）' : '数字なし')) + ' ›' })]);
          //   ★畳んだままでも1タップで確かめられる（設計38 §5-5：例のメモが11操作）。印の無い今までの下書きでは何も足さない
          var side = allChkBtn(it) || doneBtn(it);
          if (!side) { list.appendChild(colBtn); return; }
          list.appendChild(el('div', { class: 'k-exline' }, [colBtn, side]));
          return;
        }
        var hasVal = it.sets.some(function (s) { return s.r !== '' && s.r != null; });   // 重量の空は自重
        var noneDone = !it.sets.some(function (s) { return s.done === true; });
        //   数字の無い種目で「実施した」が無い＝保存されない（設計38）。目で分かるように同じ色にする
        var warn = (hasVal && noneDone) || (!it.sets.length && it.doneOnly !== true);
        var blk = el('div', { style: 'border:1px solid ' + (warn ? '#f5c9bb' : 'var(--k-line)') + ';border-radius:12px;padding:10px;margin-bottom:10px;background:' + (warn ? '#fff7f4' : '#fff') + ';' });
        blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
          el('div', { style: 'flex:1;min-width:0;font-weight:700;font-size:15px;', text: it.exercise }),
          it.fromMemo ? el('span', { class: 'k-frommemo', text: 'メモから' }) : null,
          el('span', { class: 'k-tag', text: partOf(it.exercise) }),
          el('button', { type: 'button', class: 'k-btn out small k-danger', 'aria-label': it.exercise + 'を外す', text: '外す', onclick: function () { restShift(ei); D.items.splice(ei, 1); save(); draw(); } })]));
        //   「全部✓」は見出しの「外す」から離し、前回の行の右に置く（押し間違えて種目を消さない・設計38 §5-4）
        var ac = allChkBtn(it);
        blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin:2px 0 8px;' }, [el('div', { class: 'k-sub', style: 'flex:1;min-width:0;', text: prevLabel(it.exercise) }), ac]));
        var db = doneBtn(it);
        if (db) blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin:0 0 8px;' }, [db, el('span', { class: 'k-sub', text: '数字の無い種目は「実施した」で記録します' })]));
        if (it.regPart && !registeredEx(it.exercise)) blk.appendChild(regCard(it));
        if (it.sets.length) blk.appendChild(el('div', { class: 'k-setrow', style: 'margin-bottom:2px;font-size:11px;color:var(--k-sub);' }, [el('span'), el('span', { text: '重量 kg' }), el('span', { text: '回数' }), el('span', { style: 'text-align:center;', text: '実施' }), el('span', { style: 'text-align:center;line-height:1.2;', text: extOk() ? 'メモ・補助' : 'メモ' }), el('span')]));
        it.sets.forEach(function (s, si) {
          var chk = el('button', { type: 'button', 'aria-pressed': s.done ? 'true' : 'false', 'aria-label': (si + 1) + 'セット目を実施済みにする',
            style: 'min-width:44px;min-height:44px;border-radius:12px;font-size:18px;font-weight:700;' + (s.done ? 'background:#243b66;color:#fff;border:1px solid #243b66;' : 'background:#fff;color:#8692a6;border:1px solid #8692a6;'),
            text: '✓', onclick: function () { var go = !s.done && restOn(); s.done = !s.done; if (go) rest.pos = { ei: ei, si: si }; save(); draw(); if (go) restStart(restSecondsFor(it.exercise)); } });   // ★タイマーなしなら数えない
          blk.appendChild(el('div', { class: 'k-setrow' }, [
            el('span', { style: 'color:var(--k-sub);font-size:13px;text-align:center;', text: String(si + 1) }),
            numInput(s.w, 'kg', (si + 1) + 'セット目の重量', function (v) { s.w = v; }),
            numInput(s.r, '回', (si + 1) + 'セット目の回数', function (v) { s.r = v; }),
            chk,
            el('button', { type: 'button', 'aria-label': (si + 1) + 'セット目のメモ', 'aria-expanded': (s.note || s.memoOpen) ? 'true' : 'false',
              style: 'min-width:44px;min-height:44px;border-radius:10px;font-size:16px;' + (s.note || hasExt(s) ? 'background:var(--k-acc-l);color:var(--k-acc);border:1px solid var(--k-acc);' : 'background:#fff;color:#9a9ea6;border:1px solid #8692a6;'),
              text: '✎', onclick: function () { s.memoOpen = !(s.memoOpen || s.note); if (!s.memoOpen && !s.note) { save(); draw(); return; } save(); draw(); focusMemo(ei, si); } }),
            el('button', { type: 'button', class: 'k-setdel', 'aria-label': (si + 1) + 'セット目を消す', style: 'min-width:44px;min-height:44px;border:none;background:transparent;color:var(--k-warn);font-size:16px;', text: '×',
              onclick: function () { if (it.sets.length === 1) restShift(ei); else restShift(ei, si); it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
          //   印（補助・ドロップ・無理やり）はセットの行の真下に小さく＝✎ を閉じていても分かる（設計38 §5-4）
          var mk = marksOf(s);
          if (mk) blk.appendChild(el('div', { class: 'k-marks', text: mk }));
          //   セットのメモ（✎ で開く・入っていれば開いたまま）。痛み・診断は書かない（注意すること へ）
          if (s.note || s.memoOpen) {
            var mi = el('input', { type: 'text', maxlength: '200', placeholder: '例：最後の2回は補助', 'aria-label': (si + 1) + 'セット目のメモ（200字まで）', 'data-memo': ei + ':' + si, enterkeyhint: 'done', autocomplete: 'off' });
            if (s.note) mi.value = s.note;
            mi.oninput = function () { s.note = mi.value; save(); };
            mi.onkeydown = function (ev) { if (ev.key === 'Enter') { ev.preventDefault(); mi.blur(); } };
            var chips = el('div', { class: 'k-memochips' });
            //   ★補助・無理やりを構造で持てるとき（33）は「補助あり」「フォーム崩れ」を出さない（構造と自由文が二重になる・F10）。既存のメモの文字は変えない
            MEMO_PRESETS.filter(function (tx) { return !extOk() || MEMO_STRUCTURED.indexOf(tx) < 0; }).forEach(function (tx) {
              chips.appendChild(el('button', { type: 'button', text: tx, onclick: function () {
                var v = String(s.note || '').trim();
                if (v.indexOf(tx) >= 0) return;
                s.note = (v ? v + '・' : '') + tx; if (s.note.length > 200) s.note = s.note.slice(0, 200);
                mi.value = s.note; save();
              } }));
            });
            blk.appendChild(el('div', { class: 'k-setnote' }, [mi, chips,
              el('div', { class: 'k-sub', style: 'margin-top:4px;color:var(--k-warn);', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }),
              extPanel(it, s, ei, si),
              el('button', { type: 'button', class: 'k-btn out small k-danger k-setdel2', style: 'margin-top:6px;', text: 'このセットを消す', onclick: function () { if (it.sets.length === 1) restShift(ei); else restShift(ei, si); it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
          }
          if (restOn() && rest.pos && rest.pos.ei === ei && rest.pos.si === si) { blk.appendChild(restBar); placed = true; }   // ★休憩の帯は✓を押したセットの真下（2026-11-05 オーナー：スクロールが煩わしい）
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
        if (restOn()) blk.appendChild(el('div', { class: 'k-restrow', style: 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;' }, [rs, snd, el('span', { class: 'k-sub', text: '✓を押すと休憩タイマーが始まります（記録には保存されません）' })]));   // タイマーなしなら行ごと出さない
        list.appendChild(blk);
      });
      if (!placed && restOn()) list.insertBefore(restBar, list.firstChild);
      else if (!placed && restBar.parentNode) restBar.parentNode.removeChild(restBar);   // ✓のセットが無い・消えた：一覧の先頭（数えていれば見える・空なら隠れる）
      if (!D.items.length) list.appendChild(msg('「前回の内容で始める」か「種目を足す」から始めてください。'));
      var t = totalSets(D.items), rec = 0;
      buildPayload(D.items).forEach(function (x) { rec += x.sets.length; });
      remain.textContent = '記録する ' + rec + 'セット・記録しない ' + uncheckedCount(D.items) + 'セット（合計 ' + t + '／' + TR_TOTAL + '）';
    }
    //   ---- 設計38：補助・無理やり・ドロップ・実施（数字なし）・全部✓
    function hasExt(s) { return String(s.assist == null ? '' : s.assist).trim() !== '' || s.forced === true || (Array.isArray(s.drops) && s.drops.length > 0); }
    function dLabel(w) { return (w === '' || w == null) ? '自重' : wLabel(w); }
    function marksOf(s) {   // 「＋補助5」「→ 自重×10」「無理」
      var out = [], a = String(s.assist == null ? '' : s.assist).trim();
      if (a) out.push('＋補助' + a);
      (Array.isArray(s.drops) ? s.drops : []).forEach(function (d) { var da = String(d.assist == null ? '' : d.assist).trim(); out.push('→ ' + dLabel(d.w) + '×' + (hasR(d) ? d.r : '？') + (da ? '＋補助' + da : '') + (d.forced === true ? '（無理）' : '')); });
      if (s.forced === true) out.push('無理');
      return out.join('　');
    }
    function allChkBtn(it) {   // 回数の入った✓なしのセットを全部✓に（回数が空のセットには付けない）
      if (!it.sets.some(function (x) { return hasR(x) && x.done !== true; })) return null;
      return el('button', { type: 'button', class: 'k-allchk', 'aria-label': it.exercise + 'のセットを全部✓にする', text: '全部✓', onclick: function () {
        it.sets.forEach(function (x) { if (hasR(x)) x.done = true; }); save(); draw();
      } });
    }
    function doneBtn(it) {   // 回数の入ったセットが1つも無い種目の「実施した」（できたら消える＝両方は送らない）
      if (anyR(it) || !(extOk() || it.doneOnly === true)) return null;
      var on = it.doneOnly === true;
      return el('button', { type: 'button', class: 'k-donechk', 'aria-pressed': on ? 'true' : 'false', 'aria-label': it.exercise + 'を実施した（数字なし）', text: '✓ 実施した', onclick: function () {
        it.doneOnly = !on; save(); draw();
      } });
    }
    //   ✎ の欄の補助・無理やり・ドロップ。33 のときだけ出す（I68）。33 でなくても印が入っていれば外せるように出す
    function extPanel(it, s, ei, si) {
      if (!(extOk() || hasExt(s))) return null;
      var n = si + 1;
      var ai = numInput(s.assist == null ? '' : s.assist, '回', n + 'セット目の補助の回数', function (v) { s.assist = v; if (!v) delete s.assist; });
      ai.onchange = function () { draw(); };
      var fz = el('button', { type: 'button', class: 'k-rtg', 'aria-pressed': s.forced === true ? 'true' : 'false', 'aria-label': n + 'セット目を無理やりにする', text: '無理やり', onclick: function () {
        if (s.forced === true) delete s.forced; else s.forced = true; save(); draw();
      } });
      var box = el('div', { class: 'k-extpanel', style: 'margin-top:8px;' }, [
        el('div', { class: 'k-extrow' }, [el('span', { style: 'font-size:13px;', text: '補助 ＋' }), ai, el('span', { style: 'font-size:13px;', text: '回' }), fz]),
        el('div', { class: 'k-sub', text: '補助は回数に足しません。ドロップは本セットの✓に含まれます' })]);
      (Array.isArray(s.drops) ? s.drops : []).forEach(function (d, k) {
        var lb = n + 'セット目のドロップ' + (k + 1) + '段目の';
        var wi = numInput(d.w, 'kg', lb + '重量', function (v) { d.w = v; }); wi.onchange = function () { draw(); };
        var ri = numInput(d.r, '回', lb + '回数', function (v) { d.r = v; }); ri.onchange = function () { draw(); };
        var dai = numInput(d.assist == null ? '' : d.assist, '回', lb + '補助', function (v) { d.assist = v; if (!v) delete d.assist; }); dai.setAttribute('placeholder', '補助'); dai.onchange = function () { draw(); };
        box.appendChild(el('div', { class: 'k-setrow k-droprow' }, [el('span', { style: 'color:var(--k-sub);text-align:center;', text: '→' }), wi, ri, dai,
          el('button', { type: 'button', 'aria-label': lb.replace(/の$/, '') + 'を消す', style: 'min-width:44px;min-height:44px;border:none;background:transparent;color:var(--k-warn);font-size:16px;', text: '×', onclick: function () {
            s.drops.splice(k, 1); if (!s.drops.length) delete s.drops; save(); draw();
          } })]));
      });
      if (!s.drops || s.drops.length < DROPS_MAX) box.appendChild(el('button', { type: 'button', class: 'k-dropadd', text: 'ドロップを足す', 'aria-label': n + 'セット目にドロップを足す', onclick: function () {
        if (totalSets(D.items) >= TR_TOTAL) { window.alert('1回の記録は合計60セットまでです（ドロップも1つと数えます）。'); return; }
        if (!Array.isArray(s.drops)) s.drops = [];
        s.drops.push({ w: '', r: '' }); save(); draw();
      } }));
      return box;
    }
    function registeredEx(x) { return EXERCISES.indexOf(x) >= 0 || Object.prototype.hasOwnProperty.call(exMaster, x); }
    //   メモから「種目にする」で部位を選んだ名前：記録の画面で、選んだ部位を初期値にして登録の欄を出す（設計38 §5-2・I60）。
    //   ★取り込みの画面からは送らない。登録するか（全員の一覧に出すか）は今までどおりトレーナーが選ぶ
    var regBusy = false;
    function regCard(it) {
      var name = it.exercise, rp = it.regPart;
      var pp = el('div', { class: 'k-pills', role: 'radiogroup', 'aria-label': name + 'の部位', style: 'gap:6px;margin-top:6px;' });
      PART_KEYS.forEach(function (pk) {
        pp.appendChild(el('button', { type: 'button', role: 'radio', class: 'k-pill' + (rp === pk[0] ? ' on' : ''), 'aria-checked': rp === pk[0] ? 'true' : 'false', 'data-part': pk[0], text: pk[1], onclick: function () { it.regPart = pk[0]; delete it.regReq; save(); draw(); } }));
      });
      var rb = el('button', { type: 'button', class: 'k-btn out small k-exreg', text: regBusy ? '送信中…' : label(PART_KEYS, rp) + 'で登録する', onclick: function () {
        if (regBusy) return;
        regBusy = true; draw();
        var reqId = it.regReq || (it.regReq = newReqId()); save();
        kWrite('k_saveExercise', { name: name, part: rp }, reqId, { kind: 'training', customerId: cid }).then(function (w) {
          regBusy = false;
          if (w && w.success) { exMaster[name] = rp; delete it.regPart; delete it.regReq; save(); if (same()) draw(); return; }
          if (!w || w.code === 'BAD_RESPONSE') { if (same()) { window.alert('部位の保存の結果を確かめられませんでした。もう一度「登録する」を押してください（二重にはなりません）。'); draw(); } return; }
          delete it.regReq; save();
          if (same()) { window.alert('部位を保存できませんでした（' + (w.code === 'BAD_STATE' ? ERR.EX_LIMIT : errText(w)) + '）。今日の記録には足せます。'); draw(); }
        }, function () { regBusy = false; if (same()) draw(); });
      } });
      if (regBusy) rb.disabled = true;
      return el('div', { class: 'k-card k-exunreg', 'data-name': name, style: 'margin:0 0 8px;display:flex;flex-direction:column;gap:6px;' }, [
        el('div', { style: 'font-weight:700;', text: '「' + name + '」は共有の一覧にありません' }),
        el('div', { class: 'k-sub', text: '部位を選んで登録すると、全トレーナー・全お客様の一覧に出ます（登録しなくても今日の記録には足せます）。' }),
        pp, el('div', { class: 'k-grid2' }, [rb, el('button', { type: 'button', class: 'k-btn out small', text: '登録しない', onclick: function () { delete it.regPart; delete it.regReq; save(); draw(); } })]),
        el('div', { class: 'k-note-hint', style: 'margin:0;', text: '種目名に痛み・診断・服薬が入っていたら登録しない（「注意すること」へ）' })]);
    }
    function focusMemo(ei, si) { var m = list.querySelector('input[data-memo="' + ei + ':' + si + '"]'); if (m) { try { m.focus(); } catch (e) {} } }
    function addExercises(names) {
      names.forEach(function (ex) {
        if (D.items.length >= 20 || totalSets(D.items) >= TR_TOTAL) return;
        var p = prevOfExercise(sessions, ex, D.sessionDate);
        var first = { w: '', r: '', done: false };
        //   前回の回の、その名前の全 ord の本セットのうち、無理やりでない最大（無ければ空・設計38 §6-1）
        var top = p ? p.sets.filter(function (x) { return x.forced !== true; }).sort(function (a, b) { return b.weight_kg - a.weight_kg || b.reps - a.reps; })[0] : null;
        if (top) first = { w: isBw(top.weight_kg) ? '' : top.weight_kg, r: top.reps, done: false };
        D.items.push({ exercise: ex, sets: [first] });
      });
      D.openEi = D.items.length - 1;
      save(); draw();
    }
    c.appendChild(el('button', { type: 'button', class: 'k-btn out', text: '＋ 種目を足す', onclick: function () { picker.style.display = picker.style.display === 'none' ? '' : 'none'; } }));
    var picker = exercisePicker(sessions, function (names) { addExercises(names); picker.style.display = 'none'; }, cid, exRestore && exRestore.cid === cid ? exRestore : null);
    picker.style.display = (exRestore && exRestore.cid === cid) ? '' : 'none';   // 種目の登録の途中で読み直したら、種目を選ぶ欄を開いたまま戻す
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
      if (needReauthBeforeSend()) { save(); reauth({ kind: 'training', customerId: cid }).then(function (w) { if (w && w.code === 'STALE' && same()) window.alert(errText(w)); }); return; }   // send と同じ
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
      //   ★新しい鍵（doneOnly・assist・forced・drops）を使う保存は 33 以上のときだけ（設計38 I68）。確かめるのはここ1か所＝
      //     通常の保存・pending の固定 payload の送り直し・下書きの復元後・doneOnly だけ・drops だけ・ドロップの中の印だけ、のすべてがここを通る。
      //     判定は送る中身（payload）だけで行い、固定した時点の判定を使い回さない（古い Worker は新しい鍵を黙って捨てる＝F2）
      if (usesExt(payload) && !extOk()) { window.alert(EXT_SCHEMA_MSG); return; }
      //   ★送る直前に、トレーナー・顧客が下書きと同じかを確かめる（違えば送らない・下書きも消さない）
      if (!same() || D.tid !== tid || D.cid !== cid || payload.customerId !== cid) { window.alert('開いているお客様が変わったため送りませんでした。カルテを開き直してください。'); return; }
      //   ★トークンが古ければ送らずに取り直す（送信中の控えを固定する前＝送っていないのに「結果が分からない」にしない。入力は下書きに残っている）
      if (needReauthBeforeSend()) { save(); reauth({ kind: 'training', customerId: cid }).then(function (w) { if (w && w.code === 'STALE' && same()) window.alert(errText(w)); }); return; }
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
        //   ★サーバーの受付の切替が off／未許可（設計38 §3-7・I72）：はっきりした断り。pending は上で解いた・下書き（種目・セット・印）は残す・次は新しい送信番号
        else if (w.code === 'TRAINING_EXT_OFF') window.alert(ERR.TRAINING_EXT_OFF);
        else if (w.code === 'BAD_REQUEST' && TR_DETAIL[w.detail]) window.alert(TR_DETAIL[w.detail] + '（入力は残っています）');
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
      if (needReauthBeforeSend()) { save(); reauth({ kind: 'training', customerId: cid }).then(function (w) { if (w && w.code === 'STALE' && same()) window.alert(errText(w)); }); return; }   // send と同じ
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
      //   補助の回数は1〜100（黙って捨てない・設計38）
      var badA = D.items.some(function (it) { return it.sets.some(function (s) {
        function bad(v) { var t = String(v == null ? '' : v).trim(); return t !== '' && assistOf(t) == null; }
        return s.done === true && hasR(s) && (bad(s.assist) || (Array.isArray(s.drops) && s.drops.some(function (d) { return hasR(d) && bad(d.assist); })));
      }); });
      if (badA) { window.alert('補助の回数は1〜100の数で入れてください。'); return; }
      var n = uncheckedCount(D.items);
      if (n && !window.confirm('記録されない入力が ' + n + ' セットあります（✓が無い・重量か回数が空）。保存すると、その入力（セットのメモも）は消えます。よいですか？')) return;
      var total = 0; items.forEach(function (it) { it.sets.forEach(function (st) { total += 1 + (st.drops ? st.drops.length : 0); }); });   // ドロップも1つと数える
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

  //   種目の選び方：この方の最近の種目 → 部位ごと（固定の種目＋共有の一覧）→ 検索・名前を入れて部位を選んで登録。複数選んでまとめて足す
  //   ★共有の一覧（k_exercises）は画面で登録された種目だけ（記録の自由文は読まない＝CEO 決定 2026-11-06）。新しく足した種目と部位は全員に出る
  //   ★「最近の種目」から選んだ名前が共有の一覧に無ければ、選んだ下にその場で部位を選んで登録する欄を出す（ダイアログを増やさない）
  //   ★部位を直すのは「部位を直す」を押してから種目を押す（選ぶ操作と取り違えない）
  //   ★登録の途中でトークンを取り直したら、検索の文字・部位・モード・送信番号を退避して、読み直し後に同じ欄で戻す（restore）
  function exercisePicker(sessions, onAdd, cid, restore) {
    var cnt = {};
    //   数字の無い種目も数える（設計38・回ごとに名前を1回）
    (sessions || []).forEach(function (s) { var seen = {}; function add(n) { if (n && !seen[n]) { seen[n] = 1; cnt[n] = (cnt[n] || 0) + 1; } } (s.sets || []).forEach(function (x) { add(x.exercise); }); if (isNewSess(s)) s.exercises.forEach(function (x) { if (x) add(x.exercise); }); });
    var recent = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; }).slice(0, 8);
    var local = [];   // この画面で足したが、共有の一覧に保存できなかった名前
    function allNames() {
      var out = [];
      [recent, EXERCISES, Object.keys(exMaster), local].forEach(function (l) { l.forEach(function (x) { if (x && out.indexOf(x) < 0) out.push(x); }); });
      return out;
    }
    function registered(x) { return EXERCISES.indexOf(x) >= 0 || Object.prototype.hasOwnProperty.call(exMaster, x); }
    var picked = [], editMode = false, editing = null, editPart = null, newPart = null, busy = false, lastReq = {}, regPart = {};
    var box = el('div', { class: 'k-card k-picker', style: 'margin-top:8px;background:var(--k-cream);' });
    var q = el('input', { 'data-nodirty': '1', type: 'search', maxlength: String(EX_NAME_MAX), placeholder: '種目を探す・新しい名前を入れる', 'aria-label': '種目を探す', enterkeyhint: 'search', style: 'width:100%;min-height:44px;border:1px solid #8692a6;border-radius:8px;padding:0 10px;font-size:16px;box-sizing:border-box;' });
    var editBtn = el('button', { type: 'button', class: 'k-btn out small k-exedit', 'data-nodirty': '1', onclick: function () { editMode = !editMode; editing = null; draw(); } });
    var area = el('div');
    var go = el('button', { type: 'button', class: 'k-btn k-picker-go', text: '選んだ種目を足す' });
    if (restore) {
      q.value = String(restore.q || '');
      newPart = restore.newPart || null; editMode = !!restore.editMode; editing = restore.editing || null; editPart = restore.editPart || null;
      (Array.isArray(restore.picked) ? restore.picked : []).forEach(function (x) { if (typeof x === 'string' && picked.indexOf(x) < 0) picked.push(x); });
      if (restore.name && restore.part && restore.reqId) lastReq[restore.name + '\u0000' + restore.part] = restore.reqId;   // 同じ名前・部位なら同じ送信番号
      if (restore.regName && restore.part) regPart[restore.regName] = restore.part;
    }
    function partPills(cur0, onPick, labelFor) {
      var p = el('div', { class: 'k-pills', role: 'radiogroup', 'aria-label': labelFor, style: 'gap:6px;margin-top:6px;' });
      PART_KEYS.forEach(function (pk) {
        p.appendChild(el('button', { type: 'button', role: 'radio', class: 'k-pill' + (cur0 === pk[0] ? ' on' : ''), 'aria-checked': cur0 === pk[0] ? 'true' : 'false', 'data-part': pk[0], text: pk[1], onclick: function () { onPick(pk[0]); } }));
      });
      return p;
    }
    //   共有の一覧へ保存する。結果が分からないときは同じ名前・部位なら同じ送信番号で送り直す（二重にならない）
    //   how：'new'（検索から新しく）／'edit'（部位を直す）／'reg'（最近の種目から選んで登録）
    function saveEx(name, part, how, done) {
      if (busy) return;
      var k = name + '\u0000' + part;
      var reqId = lastReq[k] || (lastReq[k] = newReqId());
      var ex = { cid: cid, q: q.value, newPart: newPart, editMode: editMode, editing: editing, editPart: editPart, picked: picked.slice(), name: name, part: part, reqId: reqId, regName: how === 'reg' ? name : '' };
      busy = true; draw();
      kWrite('k_saveExercise', { name: name, part: part }, reqId, { kind: 'training', customerId: cid, ex: ex }).then(function (w) {
        busy = false;
        if (w && w.success) { delete lastReq[k]; exMaster[name] = part; done(true); return; }
        if (!w || w.code === 'BAD_RESPONSE') { done(false, '部位の保存の結果を確かめられませんでした。必要なら「部位を直す」からもう一度保存してください。'); return; }
        delete lastReq[k];
        done(false, '部位を保存できませんでした（' + (w.code === 'BAD_STATE' ? ERR.EX_LIMIT : errText(w)) + '）。');
      }, function () { busy = false; done(false, '部位の保存の結果を確かめられませんでした。必要なら「部位を直す」からもう一度保存してください。'); });
    }
    function chip(ex) {
      var on = picked.indexOf(ex) >= 0;
      if (editMode) return el('button', { type: 'button', class: 'k-pill', 'aria-label': ex + 'の部位を直す', text: ex + ' ✎', onclick: function () { editing = ex; editPart = partKeyOf(ex); draw(); } });
      return el('button', { type: 'button', class: 'k-pill' + (on ? ' on' : ''), 'aria-pressed': on ? 'true' : 'false', text: ex, onclick: function () { var i = picked.indexOf(ex); if (i >= 0) picked.splice(i, 1); else picked.push(ex); draw(); } });
    }
    function draw() {
      area.innerHTML = '';
      editBtn.textContent = editMode ? '部位を直すのをやめる' : '部位を直す';
      editBtn.setAttribute('aria-pressed', editMode ? 'true' : 'false');
      go.style.display = editMode ? 'none' : '';
      if (exTruncated) area.appendChild(el('div', { class: 'k-sub k-extrunc', style: 'margin-top:8px;color:var(--k-warn);', text: '共有の種目は一部だけ表示しています。見つからなければ名前を入力してください。' }));
      //   部位を直す（1つずつ・上にまとめて出す＝片手で探さない）
      if (editMode && editing) {
        var ed = el('div', { class: 'k-card k-exeditor', style: 'margin-top:10px;display:flex;flex-direction:column;gap:6px;' }, [
          el('div', { style: 'font-weight:700;', text: '「' + editing + '」の部位' }),
          el('div', { class: 'k-sub', text: 'いま：' + label(PART_KEYS, partKeyOf(editing)) + (exMaster[editing] ? '' : '（種目名からの推定）') + '。保存すると全トレーナー・全お客様の一覧で変わります' }),
          partPills(editPart, function (pk) { editPart = pk; draw(); }, editing + 'の部位'),
          el('div', { class: 'k-grid2', style: 'margin-top:4px;' }, [
            el('button', { type: 'button', class: 'k-btn', text: busy ? '送信中…' : '保存する', onclick: function () {
              var name = editing; saveEx(name, editPart, 'edit', function (ok2, m) { if (!ok2) { window.alert(m); draw(); return; } editing = null; draw(); });
            } }),
            el('button', { type: 'button', class: 'k-btn out', text: 'やめる', onclick: function () { editing = null; draw(); } })])]);
        if (busy) ed.querySelector('.k-btn').disabled = true;
        area.appendChild(ed);
      }
      if (editMode && !editing) area.appendChild(el('div', { class: 'k-sub', style: 'margin-top:8px;', text: '部位を直す種目を押してください。' }));
      var t = exName(q.value), all = allNames();
      if (t) {
        var hit = all.filter(function (x) { return x.indexOf(t) >= 0; });
        var p1 = el('div', { class: 'k-pills', style: 'margin-top:10px;' }); hit.forEach(function (x) { p1.appendChild(chip(x)); });
        area.appendChild(p1);
        if (!editMode && hit.indexOf(t) < 0 && t.length <= EX_NAME_MAX) {
          var np = newPart || guessPart(t);
          var addBtn = el('button', { type: 'button', class: 'k-btn k-exadd', text: busy ? '送信中…' : '「' + t + '」を' + label(PART_KEYS, np) + 'で登録して選ぶ', onclick: function () {
            var name = t;
            saveEx(name, np, 'new', function (ok2, m) {
              //   ★保存できなくても今日の記録には足せる（部位は後で直せる）。記録を止めない
              if (!ok2) { if (local.indexOf(name) < 0 && !(name in exMaster)) local.push(name); window.alert(m + '「' + name + '」は今日の記録用に選びました。'); }
              if (picked.indexOf(name) < 0) picked.push(name);
              q.value = ''; newPart = null; draw();
            });
          } });
          if (busy) addBtn.disabled = true;
          area.appendChild(el('div', { class: 'k-card k-exnew', style: 'margin-top:10px;display:flex;flex-direction:column;gap:6px;' }, [
            el('div', { style: 'font-weight:700;', text: '新しい種目「' + t + '」の部位' }),
            partPills(np, function (pk) { newPart = pk; draw(); }, '新しい種目の部位'),
            addBtn,
            el('div', { class: 'k-sub', text: '登録した種目は、全トレーナー・全お客様の一覧に出ます。' }),
            el('div', { class: 'k-note-hint', style: 'margin:0;', text: '種目名だけを書く（痛み・診断・服薬は「注意すること」へ）' })]));
        }
      } else {
        if (recent.length) { area.appendChild(el('div', { class: 'k-sub', style: 'margin:10px 0 6px;font-weight:700;', text: 'この方の最近の種目' })); var p2 = el('div', { class: 'k-pills' }); recent.forEach(function (x) { p2.appendChild(chip(x)); }); area.appendChild(p2); }
        //   最近の種目から選んだが共有の一覧に無い名前：選んだまま足せる。部位を選んで登録すると全員の一覧に出る（任意）
        if (!editMode) picked.filter(function (x) { return recent.indexOf(x) >= 0 && !registered(x) && local.indexOf(x) < 0; }).forEach(function (x) {
          var rp = regPart[x] || guessPart(x);
          var rb = el('button', { type: 'button', class: 'k-btn out small k-exreg', text: busy ? '送信中…' : label(PART_KEYS, rp) + 'で登録する', onclick: function () {
            saveEx(x, rp, 'reg', function (ok2, m) { if (!ok2) { local.push(x); window.alert(m + '「' + x + '」は今日の記録用に選んだままです。'); } draw(); });
          } });
          if (busy) rb.disabled = true;
          area.appendChild(el('div', { class: 'k-card k-exunreg', 'data-name': x, style: 'margin-top:8px;display:flex;flex-direction:column;gap:6px;' }, [
            el('div', { style: 'font-weight:700;', text: '「' + x + '」は共有の一覧にありません' }),
            el('div', { class: 'k-sub', text: '部位を選んで登録すると、全トレーナー・全お客様の一覧に出ます（登録しなくても今日の記録には足せます）。' }),
            partPills(rp, function (pk) { regPart[x] = pk; draw(); }, x + 'の部位'), rb,
            el('div', { class: 'k-note-hint', style: 'margin:0;', text: '種目名に痛み・診断・服薬が入っていたら登録しない（「注意すること」へ）' })]));
        });
        var groups = {};
        all.forEach(function (x) { if (recent.indexOf(x) >= 0) return; var p = partKeyOf(x); (groups[p] = groups[p] || []).push(x); });
        PART_KEYS.forEach(function (pk) {
          var g = groups[pk[0]]; if (!g) return;
          area.appendChild(el('div', { class: 'k-sub k-partgroup', 'data-part': pk[0], style: 'margin:10px 0 6px;font-weight:700;', text: pk[1] }));
          var p3 = el('div', { class: 'k-pills' }); g.forEach(function (x) { p3.appendChild(chip(x)); }); area.appendChild(p3);
        });
      }
      go.textContent = picked.length ? '選んだ ' + picked.length + ' 種目を足す' : '選んだ種目を足す';
    }
    q.oninput = function () { newPart = null; draw(); };
    go.onclick = function () { if (!picked.length) { window.alert('種目を選んでください。'); return; } onAdd(picked.slice()); picked = []; q.value = ''; draw(); };
    box.appendChild(q);
    box.appendChild(el('div', { style: 'display:flex;justify-content:flex-end;margin-top:6px;' }, [editBtn]));
    box.appendChild(area); box.appendChild(go);
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
      return setLineOf(sets.slice().sort(function (a, b) { return a.set_no - b.set_no; }));   // 0 は「自重」
    }
    function exRows(sess, withNotes) {
      var o = exOrder(sess), out = el('div', { style: 'display:flex;flex-direction:column;gap:6px;font-size:14px;' });
      o.groups.forEach(function (g) {
        out.appendChild(el('div', { style: 'display:flex;justify-content:space-between;gap:8px;' }, [el('span', { text: g.exercise }), el('span', { class: 'k-sub', style: 'font-size:13px;text-align:right;', text: setLine(g.sets) })]));
        if (withNotes) g.sets.forEach(function (st) { if (st.note) out.appendChild(el('div', { class: 'k-sub', style: 'margin:-2px 0 2px 10px;', text: st.set_no + 'セット目：' + st.note })); });
      });
      return out;
    }
    //   前回
    var last = sorted[0], lo = exOrder(last);
    box.appendChild(el('div', { class: 'k-card', style: 'display:flex;flex-direction:column;gap:8px;' }, [
      el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;' }, [el('div', { class: 'k-h', style: 'margin:0;', text: '前回（' + md(last.session_date) + '）' }), el('div', { class: 'k-sub', text: lo.groups.length + '種目・' + (last.sets || []).length + 'セット' })]),
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
      var pts = st.days.filter(function (x) { return x.v != null; }).map(function (x) { return { d: x.d, v: x.v }; });
      if (pts.some(function (x) { return x.v > 0; })) exCard.appendChild(lineChart(pts, null, 'kg'));   // 自重だけの種目（推定MAXが全部0）は線を出さない
      exCard.appendChild(el('div', { class: 'k-sub', style: 'font-size:13px;', text: '自己ベスト ' + wLabel(st.best.w) + ' × ' + st.best.r + '（' + md(st.best.d) + '）' }));
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
          el('span', { style: 'font-weight:700;', text: mdw(x.session_date) }), el('span', { class: 'k-sub', text: o.groups.length + '種目 ' + (on ? '▾' : '›') })]));
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
  function tabContract(box, draft) {
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
      var cHow = sm.consent && sm.consent.byMember ? '（会員画面）' : (sm.consent && sm.consent.method === 'paper' ? '（紙）' : (sm.consent && sm.consent.method === 'line' ? '（LINE）' : ''));
      adm.appendChild(el('div', {}, [
        el('div', { style: 'display:flex;justify-content:space-between;align-items:baseline;gap:8px;' }, [
          el('div', { style: 'font-size:14px;font-weight:700;', text: '健康情報の取り扱いの同意' }),
          el('div', { style: 'font-size:12px;color:' + (cs === 'agreed' ? 'var(--k-acc)' : 'var(--k-warn)') + ';', text: cs === 'agreed' ? '同意済み ' + cAt + cHow : (cs === 'revoked' ? '撤回済み ' + cAt : '同意待ち') })]),
        consentRow(sm.consent)]));
      adm.appendChild(recConsentRow(sm.recConsent));
      if (sm.assigned) adm.appendChild(membershipCard(draftFor(draft, 'membership') ? draft.data : null));
      box.appendChild(adm);
    });
  }

  // ---------------------------------------------------------------- お客様の見え方（設計35 C2）
  //   k_memberPreview の応答（会員の c_myKarte と同じ形＋枚の mnoteId・rev・sessionId・authorIsMe）を、会員の画面と同じ部品（index.html の MemberKarteView）で描く
  //   ★「直す」「消す」は書いた本人（authorIsMe）かオーナーだけ。消すは確かめてから
  //   ★表示は部品の中で textContent（ここでは HTML を組み立てない）
  var PREVIEW_TABS = [['home', '概要'], ['body', '体組成'], ['training', 'トレーニング'], ['notes', '指導の履歴'], ['contract', '契約']];
  function memberPreviewSub(box, mode, tab0, restoreEdit) {   // restoreEdit＝読み直しの前に直していた枚（退避から戻す）
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
      //   ★読み直しの前に直していた枚なら、同じカードで編集を開き直して入力を戻す（1回だけ）
      if (restoreEdit && restoreEdit.mnoteId === n.mnoteId) { var re = restoreEdit; restoreEdit = null; setTimeout(function () { if (cardEl.isConnected) editNote(n, cardEl, re); }, 0); }
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
    function editNote(n, cardEl, re) {   // re＝退避から戻す入力（rev はいまの枚のものを使う＝古ければ Worker が CONFLICT）
      var known = tagsOf(n);
      //   タグを直せるのは、タグが分かっていて、トレーニングに付いた枚だけ（トレーニングの無い枚のタグは会員に出ない）
      var tagsEditable = !!known && !!n.sessionId;
      var m = { message: String(n.message || ''), todo: (Array.isArray(n.todo) ? n.todo : []).concat(['', '', '']).slice(0, MEMBER_MAX.todo), tags: (known || []).filter(function (x) { return DAY_TAGS.indexOf(x) >= 0; }) };
      var reqId = newReqId(), busy = false, tagsTouched = false;
      if (re && re.rev === n.rev) {
        m.message = String(re.message || ''); m.todo = (Array.isArray(re.todo) ? re.todo : []).concat(['', '', '']).slice(0, MEMBER_MAX.todo);
        if (re.tagsTouched && Array.isArray(re.tags)) { m.tags = re.tags.filter(function (x) { return DAY_TAGS.indexOf(x) >= 0; }); tagsTouched = true; }
        if (typeof re.reqId === 'string') reqId = re.reqId;
      } else if (re) window.alert('この欄はほかの操作で更新されていたため、入力していた内容は戻せませんでした。いまの内容を確かめてから直してください。');   // ★編集は送った鍵だけ置き換わる＝タグは触ったときだけ送る
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
        kWrite('k_saveMemberNote', body, reqId, { kind: 'sub', sub: 'mpreview', tab: 'summary', cid: askedFor, edit: { mnoteId: n.mnoteId, rev: n.rev, message: m.message, todo: m.todo.slice(), tags: m.tags.slice(), tagsTouched: tagsTouched, reqId: reqId } }).then(function (w) {
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
        //   ★読み直し済みの印はここでは消さない：新しいトークンで書けたとき（doneWrite）に消す。
        //     読み直した後もまだ古ければ、もう一度読み直さずに「LINE から開き直して」を出す（無限に読み直さない）。印は10分で効かなくなる
        window.alert('ログインを更新しました。入力内容を戻したので、もう一度「保存」を押してください。');
        return;
      }
      if (++tries < 40) setTimeout(wait, 500);
      else { try { sessionStorage.removeItem('karte_reauth'); } catch (e) {} }
    })();
  }

  window.KarteUI = { open: open, openBoard: openBoard, build: KARTE_BUILD,
    //   検査用（純粋な部分だけ）
    _t: { NEED_SCHEMA: NEED_SCHEMA, NEED_SCHEMA_EXT: NEED_SCHEMA_EXT, usesExt: usesExt, exOrder: exOrder, setLineOf: setLineOf, copyInto: copyInto, totalSets: totalSets, memberOf: memberOf, PART_KEYS: PART_KEYS, uncheckedCount: uncheckedCount, wLabel: wLabel, partKeyOf: partKeyOf, DAY_TAGS: DAY_TAGS, buildPayload: buildPayload, parseMemo: parseMemo, prevSession: prevSession, prevOfExercise: prevOfExercise, partsSince: partsSince, dayDiff: dayDiff, assess: assess, partOf: partOf, exerciseStats: exerciseStats, PURPOSES: PURPOSES, SLIM_AREAS: SLIM_AREAS, REGIONS: REGIONS, TAGS: TAGS, REASONS: REASONS } };
  resume();
})();
