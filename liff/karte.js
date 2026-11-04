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
  var KARTE_BUILD = '2026-11-04g カルテ はみ出し（日付の欄・空の休憩の帯・狭い画面）';
  var DRAFT_KEY = 'karte_draft_v1';
  //   この画面が必要とする Worker の版。古い Worker には新しい項目を送らない（黙って捨てられるため）
  var NEED_SCHEMA = 31;
  var SCHEMA_MSG = 'システムの更新中です。少し時間をおいて、カルテを開き直してから保存してください（入力はまだ保存されていません）。';
  function schemaOk(r) { return !!(r && typeof r.karteSchema === 'number' && r.karteSchema >= NEED_SCHEMA); }

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
  var TABS = [['summary', '概要'], ['body', '体組成'], ['training', 'トレーニング'], ['notes', '指導の履歴'], ['contract', '契約']];

  var cur = { customerId: '', name: '', tab: 'summary', root: null, body: null, summary: null };

  // ---------------------------------------------------------------- 見た目（固定の CSS。会員のデータは入れない）
  var CSS = [
    //   モック（承認済み）と同じ作り：ゴシック体・白いカード・角丸・下のタブ。
    //   色は2026-11-04 オーナー指示でモックA案のグリーン（ネイビー案は --k-acc:#0e6b5c・--k-acc-l:#e3f1ee に戻せば同じ作り）
    '#karteRoot{--k-acc:#0e6b5c;--k-acc2:#0a5246;--k-acc-l:#e3f1ee;--k-gold:#b8965a;--k-gold-l:#f3ecdc;--k-cream:#f5f6f4;--k-ground:#f5f6f4;--k-ink:#1c2321;--k-sub:#5b6661;--k-line:#e2e6e3;--k-warn:#8a3f0a;--k-warn-l:#fdf0e4;',
    'position:fixed;inset:0;z-index:9000;background:var(--k-ground);overflow:auto;-webkit-overflow-scrolling:touch;color:var(--k-ink);font-family:"Noto Sans JP",-apple-system,"Hiragino Kaku Gothic ProN",sans-serif;font-size:14px;line-height:1.6;}',
    '#karteRoot .k-wrap{max-width:520px;margin:0 auto;min-height:100%;display:flex;flex-direction:column;}',
    '#karteRoot .k-head{background:#fff;color:var(--k-ink);padding:12px 16px;border-bottom:1px solid var(--k-line);}',
    '#karteRoot .k-head-row{display:flex;align-items:center;gap:10px;}',
    '#karteRoot .k-back{min-width:44px;min-height:44px;border:none;background:transparent;color:var(--k-ink);border-radius:10px;font-size:20px;}',
    '#karteRoot .k-name{font-size:20px;font-weight:700;letter-spacing:.02em;}',
    '#karteRoot .k-meta{font-size:12px;color:var(--k-sub);margin-top:2px;}',
    '#karteRoot .k-chips{display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;}',
    '#karteRoot .k-chip-h{font-size:12px;padding:4px 10px;background:#eeeeec;color:#3f4550;border-radius:999px;}',
    '#karteRoot .k-tabs{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));background:#fff;border-top:1px solid var(--k-line);position:sticky;bottom:0;z-index:2;padding:4px 4px calc(8px + env(safe-area-inset-bottom));margin-top:auto;}',
    '#karteRoot .k-tab{min-height:48px;padding:0 2px;border:none;background:transparent;font-size:12px;color:var(--k-sub);border-top:3px solid transparent;font-family:inherit;}',
    '#karteRoot .k-tab.on{color:var(--k-acc);font-weight:700;border-top-color:var(--k-acc);}',
    '#karteRoot .k-body{padding:14px 16px 20px;display:flex;flex-direction:column;gap:12px;flex:1;}',
    '#karteRoot .k-card{background:#fff;border:1px solid var(--k-line);border-radius:14px;padding:16px;}',
    '#karteRoot .k-h{font-size:13px;font-weight:700;color:#3f4550;margin:0 0 10px;}',
    '#karteRoot .k-sub{font-size:12px;color:var(--k-sub);}',
    '#karteRoot .k-msg{font-size:13px;color:var(--k-sub);margin:6px 0;}',
    '#karteRoot .k-msg.bad{color:var(--k-warn);}',
    '#karteRoot .k-caution{background:var(--k-warn-l);border:1px solid #f1c9a3;border-radius:14px;padding:14px;}',
    '#karteRoot .k-caution .k-h{color:var(--k-warn);}',
    '#karteRoot .k-btn{display:block;width:100%;min-height:46px;border:none;border-radius:10px;background:var(--k-acc);color:#fff;font-size:15px;font-weight:700;margin-top:4px;font-family:inherit;}',
    '#karteRoot .k-btn.out{background:#fff;color:var(--k-acc);border:1px solid #c9ccd3;font-weight:500;}',
    '#karteRoot .k-btn.small{display:inline-block;width:auto;min-height:44px;padding:0 14px;font-size:13px;margin:0;}',
    '#karteRoot .k-pill{min-height:44px;padding:0 14px;border-radius:999px;border:1px solid #c9ccd3;background:#fff;color:#3f4550;font-size:13px;font-family:inherit;}',
    '#karteRoot .k-pill.on{border:1.5px solid var(--k-acc);background:var(--k-acc-l);color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-pills{display:flex;flex-wrap:wrap;gap:8px;}',
    '#karteRoot .k-seg{display:flex;background:#ecedef;border-radius:10px;padding:3px;gap:2px;}',
    '#karteRoot .k-seg button{flex:1;min-height:44px;border:none;border-radius:8px;background:transparent;font-size:13px;color:#3f4550;font-family:inherit;}',
    '#karteRoot .k-seg button.on{background:#fff;color:var(--k-ink);font-weight:700;box-shadow:0 1px 2px rgba(0,0,0,.06);}',
    '#karteRoot .k-grid2{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px;}',
    '#karteRoot .k-grid3{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:8px;}',
    '#karteRoot .k-num{font-weight:700;color:var(--k-ink);}',
    '#karteRoot .k-up{color:var(--k-warn);font-weight:700;} #karteRoot .k-down{color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-field{display:flex;flex-direction:column;gap:4px;font-size:12px;color:var(--k-sub);margin-bottom:10px;}',
    '#karteRoot .k-field input,#karteRoot .k-field textarea,#karteRoot .k-field select{min-height:44px;border:1px solid #c9ccd3;border-radius:8px;padding:8px 10px;font-size:16px;font-family:inherit;color:var(--k-ink);background:#fff;box-sizing:border-box;width:100%;}',
    '#karteRoot .k-tag{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--k-acc-l);color:var(--k-acc);}',
    '#karteRoot .k-flag{font-size:11px;padding:3px 8px;border-radius:6px;background:var(--k-warn-l);color:var(--k-warn);font-weight:500;}',
    '#karteRoot .k-flag.soft{background:#fbefd9;color:#7a4a06;}',
    '#karteRoot .k-flag.grey{background:#eeeeec;color:#3f4550;font-weight:400;}',
    '#karteRoot .k-tl{border-left:2px solid #d5d8de;margin-left:6px;padding-left:14px;display:flex;flex-direction:column;gap:14px;}',
    '#karteRoot .k-tl-item{position:relative;}',
    '#karteRoot .k-tl-dot{position:absolute;left:-21px;top:4px;width:12px;height:12px;border-radius:6px;background:var(--k-acc);}',
    '#karteRoot .k-bar{height:12px;border-radius:6px;background:#eeeeec;} #karteRoot .k-bar>div{height:12px;border-radius:6px;background:var(--k-acc);}',
    '#karteRoot .k-setrow{display:grid;grid-template-columns:22px minmax(0,1fr) minmax(0,1fr) 48px 44px 44px;gap:6px;align-items:center;margin-bottom:6px;}',
    '#karteRoot .k-setnote{margin:-2px 0 8px 28px;}',
    '#karteRoot .k-btn.k-setdel2{display:none;}',   // .k-btn.small（inline-block）より強くする
    '#karteRoot .k-memochips{display:flex;flex-wrap:wrap;gap:6px;margin-top:6px;}',
    '#karteRoot .k-memochips button{min-height:44px;padding:0 12px;border-radius:999px;border:1px solid #c9ccd3;background:#fff;font-size:14px;font-family:inherit;color:#3f4550;}',
    //   幅の狭い端末（380px 以下＝iPhone SE・mini を含む）：セットを消すボタンはメモ欄の中へ移し、数字の欄を広く取る
    //   （375px で6列のままだと数字の欄が約47px＝「102.5」が欠ける）
    '@media (max-width:380px){#karteRoot .k-setrow{grid-template-columns:20px minmax(0,1fr) minmax(0,1fr) 48px 44px;gap:4px;} #karteRoot .k-setrow input{padding:0 6px;} #karteRoot .k-setdel{display:none;} #karteRoot .k-btn.k-setdel2{display:inline-block;} #karteRoot .k-setnote{margin-left:24px;}}',
    '#karteRoot .k-setnote input{box-sizing:border-box;width:100%;min-height:44px;border:1px solid #c9ccd3;border-radius:10px;padding:0 10px;font-size:16px;background:#fff;}',
    '#karteRoot .k-setrow input{box-sizing:border-box;width:100%;min-width:0;min-height:48px;border:1px solid #c9ccd3;border-radius:10px;padding:0 10px;font-size:17px;}',
    '#karteRoot .k-picker-go{position:sticky;bottom:76px;z-index:2;}',
    //   キーパッドが出ているあいだ（k-kb）：下のタブを隠し、決定ボタンは下に詰める
    '#karteRoot.k-kb .k-tabs{display:none;}',
    '#karteRoot.k-kb .k-picker-go{bottom:0;}',
    '#karteRoot .k-accessory{position:sticky;bottom:0;z-index:5;display:flex;gap:8px;align-items:center;padding:6px 10px;background:#eef0ee;border-top:1px solid var(--k-line);}',
    '#karteRoot .k-accessory button{min-height:44px;min-width:64px;border:1px solid #c9ccd3;border-radius:10px;background:#fff;font-size:16px;font-family:inherit;color:var(--k-ink);}',
    '#karteRoot .k-accessory button.done{background:var(--k-acc);color:#fff;border-color:var(--k-acc);font-weight:700;}',
    '#karteRoot .k-rest-done{animation:kflash 0.6s ease-in-out 0s 6 alternate;}',
    '@keyframes kflash{from{background:#fdf0e4;}to{background:#f6c58f;}}',
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
    '#karteRoot .k-restbar{position:sticky;top:0;z-index:3;background:var(--k-acc-l);border:1px solid #cfe5df;border-radius:10px;padding:8px 12px;display:flex;align-items:center;gap:8px;margin-bottom:10px;}',
    '#karteRoot .k-restbar:empty{display:none !important;}',
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
    BODY_NOT_READY: '体組成の記録はまだ切り替え前です（従来の InBody 入力を使ってください）。',
    BAD_STATE: 'この記録はできません（退会・再入会の順序、または取り消せるのは最後の記録だけです）。',
    FORBIDDEN: 'この操作の権限がありません。', NOT_FOUND: '見つかりませんでした。', REQ_REUSED: '送信が重なりました。開き直してください。',
    TOTAL_SETS: '1回の記録は合計60セットまでです。',
    KARTE_OFF: 'カルテは一時停止中です。', TOO_LARGE: '入力が長すぎます。', BAD_REQUEST: '入力を確認してください。'
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
  //   ★画面の中の横スワイプ：左→右で戻る、右→左で進む（入力欄・選択肢・グラフの上やキーパッド表示中は反応しない）
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
  function onTouchStart(e) {
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
    else { try { history.forward(); } catch (er) {} }
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
    var root = ensureRoot(); root.innerHTML = '';
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
    s.appendChild(sv('circle', { cx: z / 2, cy: z / 2, r: r, fill: 'none', stroke: '#e3f1ee', 'stroke-width': 8 }));
    s.appendChild(sv('circle', { cx: z / 2, cy: z / 2, r: r, fill: 'none', stroke: '#0e6b5c', 'stroke-width': 8, 'stroke-linecap': 'round',
      'stroke-dasharray': (c * p).toFixed(1) + ' ' + c.toFixed(1), transform: 'rotate(-90 ' + z / 2 + ' ' + z / 2 + ')' }));
    s.appendChild(sv('text', { x: z / 2, y: z / 2 + 5, 'text-anchor': 'middle', 'font-size': Math.round(z / 4.4), 'font-weight': 700, fill: '#1c1f26' }, text));
    return s;
  }

  // ---------------------------------------------------------------- 概要
  function tabSummary(box, draft) {
    box.appendChild(msg('読み込み中…'));
    cur.summary = null;
    Promise.all([loadSummary(), kRead('k_body', { customerId: cur.customerId })]).then(function (rs) {
      var r = rs[0], b = rs[1];
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      var hearing = (r.profile && r.profile.hearing) || {};
      var latest = latestBody(b && b.success && b.ready ? b.rows : []);

      //   注意すること（安全面の要点）を最上部に
      var agreed = r.consent && r.consent.state === 'agreed';
      var sb = r.safetyBrief;
      var caut = el('div', { class: 'k-caution' }, [el('div', { class: 'k-h', text: '注意すること' })]);
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
        caut.appendChild(el('button', { class: 'k-btn out small', style: 'margin-top:10px;', text: '安全面を見る・書く', onclick: function () { safetyForm(box); } }));
      } else {
        caut.appendChild(msg(r.consent && r.consent.state === 'revoked' ? '同意が撤回されています（健康情報は記録できません）。' : '同意待ち：入会時の同意書でカルテでの健康情報の管理に同意をもらってから記録できます。'));
      }
      caut.appendChild(consentRow(r.consent));
      box.appendChild(caut);

      //   目標（3列）
      var p = r.profile || {};
      var g = el('div', { class: 'k-grid3' });
      g.appendChild(goalCol('体重', latest.w, hearing.targetWeight, 'kg'));
      g.appendChild(goalCol('体脂肪率', latest.pbf, hearing.targetFat, '%'));
      var dl = p.goal_deadline ? Math.ceil((Date.parse(p.goal_deadline) - Date.parse(today())) / 86400000) : null;
      g.appendChild(el('div', {}, [el('div', { class: 'k-sub', text: '期日' }),
        el('div', { class: 'k-num', style: 'font-size:20px;margin-top:4px;', text: p.goal_deadline ? md(p.goal_deadline) : '—' }),
        el('div', { class: 'k-sub', text: p.goal_deadline ? p.goal_deadline.slice(0, 4) + '年' : '' }),
        el('div', { style: 'font-size:12px;font-weight:700;color:var(--k-acc);margin-top:4px;', text: dl == null ? '' : (dl >= 0 ? '残り ' + dl + '日' : '期日を過ぎています') })]));
      var goalCard = card('目標', [g]);
      if (p.goal_text) goalCard.appendChild(el('div', { style: 'font-size:13px;line-height:1.7;background:var(--k-cream);border-radius:10px;padding:10px 12px;margin-top:12px;', text: '理想：' + p.goal_text }));
      box.appendChild(goalCard);

      //   やる気＋目的
      var pc = el('div', { class: 'k-pills', style: 'gap:6px;' });
      (hearing.purposes || []).forEach(function (k) { pc.appendChild(el('span', { class: 'k-tag', style: 'font-size:12px;padding:5px 10px;', text: label(PURPOSES, k) })); });
      if (!(hearing.purposes || []).length) pc.appendChild(el('span', { class: 'k-sub', text: '目的は未記入' }));
      box.appendChild(el('div', { class: 'k-card', style: 'display:flex;gap:16px;align-items:center;' }, [
        hearing.motivation ? ring(hearing.motivation / 10, String(hearing.motivation), 72) : el('div', { class: 'k-sub', style: 'width:72px;text-align:center;', text: 'やる気 未記入' }),
        el('div', { style: 'flex:1;min-width:0;display:flex;flex-direction:column;gap:8px;' }, [el('div', { class: 'k-sub', text: 'やる気（10段階）と目的' }), pc])
      ]));

      //   引き締めたい部位
      if ((hearing.slimAreas || []).length) {
        var sa = el('div', { style: 'display:flex;gap:8px;' });
        hearing.slimAreas.forEach(function (k, i) {
          sa.appendChild(el('div', { style: 'flex:1;text-align:center;padding:10px 0;border-radius:10px;background:' + (i === 0 ? 'var(--k-acc-l)' : 'var(--k-cream)') + ';' }, [
            el('div', { class: 'k-sub', text: String(i + 1) }), el('div', { style: 'font-size:15px;font-weight:700;', text: label(SLIM_AREAS, k) })]));
        });
        box.appendChild(card('引き締めたい部位', [sa]));
      }

      //   運動と生活
      var life = [['いまの運動', hearing.exerciseNow], ['過去の経験', hearing.exercisePast], ['睡眠', hearing.sleep], ['食事', hearing.meals]].filter(function (x) { return x[1]; });
      if (life.length) {
        var lg = el('div', { class: 'k-grid2', style: 'font-size:13px;' });
        life.forEach(function (x) { lg.appendChild(el('div', {}, [el('div', { class: 'k-sub', text: x[0] }), el('div', { text: x[1] })])); });
        box.appendChild(card('運動と生活', [lg]));
      }
      box.appendChild(el('button', { class: 'k-btn' + (r.profile && r.profile.hearing ? ' out' : ''), text: r.profile && r.profile.hearing ? 'ヒアリングを編集' : 'ヒアリングを記入する',
        onclick: function () { hearingForm(box, r, null); } }));

      //   直近の指導
      if (r.lastNote) box.appendChild(card('直近の指導', [noteView(r.lastNote)]));
      if (r.assigned) box.appendChild(membershipCard());
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
        open(cur.customerId, cur.name, 'summary', null, 'replace');
      });
    }
    if (state0 !== 'agreed') {
      row.appendChild(el('button', { class: 'k-btn out small', text: '同意を記録（紙）', onclick: function () { rec('agreed', 'paper'); } }));
      row.appendChild(el('button', { class: 'k-btn out small', text: '同意を記録（LINE）', onclick: function () { rec('agreed', 'line'); } }));
    } else {
      row.appendChild(el('button', { class: 'k-btn out small', style: 'color:var(--k-warn);', text: '撤回を記録', onclick: function () { rec('revoked', null); } }));
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
    function paint() { bs.forEach(function (b, i) { var on = v === i + 1; b.style.cssText = 'min-height:38px;border-radius:6px;font-size:13px;font-family:inherit;border:' + (on ? '2px solid #0e6b5c;background:#0e6b5c;color:#fff;font-weight:700' : '1px solid #c9ccd3;background:#fff;color:#1c1f26'); b.setAttribute('aria-pressed', on ? 'true' : 'false'); }); }
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
            el('button', { type: 'button', class: 'k-btn out small', text: '外す', onclick: function () { cur.dirty = true; pain.splice(i, 1); redraw(); } })]));
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
    return card('退会・再入会の記録', [msg('退会後3年の保存期間の起算日になります。契約の期限切れとは別に、退会が決まったときだけ記録してください。'), d.row,
      el('div', { style: 'display:flex;gap:6px;' }, [
        el('button', { class: 'k-btn out small', text: '退会を記録', onclick: function () { rec('withdrawn'); } }),
        el('button', { class: 'k-btn out small', text: '再入会を記録', onclick: function () { rec('rejoined'); } })])]);
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
    s.appendChild(sv('polyline', { fill: 'none', stroke: '#0e6b5c', 'stroke-width': 2.2, 'stroke-linejoin': 'round', points: pts.map(function (p) { return x(p.d).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ') }));
    pts.forEach(function (p) {
      //   ● 本人の記録 ○ InBody
      s.appendChild(sv('circle', p.src === 'i' ? { cx: x(p.d).toFixed(1), cy: y(p.v).toFixed(1), r: 3.6, fill: '#ffffff', stroke: '#0e6b5c', 'stroke-width': 2 }
        : { cx: x(p.d).toFixed(1), cy: y(p.v).toFixed(1), r: 3.2, fill: '#0e6b5c' }));
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
      if (!r.ready) { box.appendChild(msg('体組成の記録は切り替えの準備中です。それまでは予約画面の「InBodyを記録」を使ってください。')); return; }
      var rows = r.rows || [];
      var hearing = (s && s.success && s.profile && s.profile.hearing) || {};
      var W2 = lastTwo(rows, 'w'), F2 = lastTwo(rows, 'pbf'), M2 = lastTwo(rows, 'smm'), WA = lastTwo(rows, 'waist'), L2 = lastTwo(rows, 'lean');
      var lastD = rows.length ? rows.slice().sort(function (a, b) { return a.d < b.d ? 1 : -1; })[0].d : null;
      box.appendChild(el('div', { class: 'k-sub', text: lastD ? '最新 ' + md(lastD) : '' }));
      function hero(name, t, key, unit) {
        return el('div', { class: 'k-card', style: 'padding:14px;' }, [el('div', { class: 'k-sub', text: name }),
          el('div', { class: 'k-num', style: 'font-size:30px;line-height:1.2;margin-top:4px;', text: t.last ? String(t.last[key]) : '—' }, []),
          el('div', { class: 'k-sub', text: unit }), delta(t.last && t.last[key], t.prev && t.prev[key], unit, true)]);
      }
      function small(name, t, key, unit, lowerIsGood) {
        return el('div', { class: 'k-card', style: 'padding:10px;' }, [el('div', { class: 'k-sub', text: name }),
          el('div', { class: 'k-num', style: 'font-size:18px;margin-top:2px;', text: t.last ? t.last[key] + unit : '—' }),
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
      if (a) box.appendChild(el('div', { class: 'k-card', style: 'background:var(--k-acc-l);border-color:#cfe5df;' }, [
        el('div', { class: 'k-h', text: '前回からの見立て（自動・目安）' }), el('div', { style: 'font-size:14px;line-height:1.75;', text: a.text }),
        el('div', { class: 'k-sub', style: 'margin-top:6px;', text: '※ 数字の動きから出す目安で、診断ではありません。' })]));
      box.appendChild(el('button', { class: 'k-btn out', text: '変化の理由を確かめる（指導の履歴へ）', onclick: function () { open(cur.customerId, cur.name, 'notes', { kind: 'reflect', data: {} }); } }));

      box.appendChild(measureForm(draft && draft.kind === 'measure' ? draft.data : null));
      box.appendChild(goalForm(r.goal));
      var hist = card('最近の記録', []);
      (r.raw || []).forEach(function (m) {
        var parts = MEASURE.filter(function (f) { return m[f[0]] != null; }).map(function (f) { return f[1] + ' ' + m[f[0]] + f[2]; });
        var row = el('div', { style: 'display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--k-line);padding:8px 0;font-size:13px;' }, [
          el('div', { style: 'flex:1;min-width:0;', text: md(m.d) + '　' + parts.join('・') })
        ]);
        var mine = m.origin === 'd1' && (String(m.enteredBy) === String(state.trainerId) || state._isOwner);
        if (mine || (state._isOwner && m.origin === 'sheet')) {
          row.appendChild(el('button', { class: 'k-btn out small', text: '削除', onclick: function () {
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

  function measureForm(draftData) {
    var c = card('測定を記録（InBody・周囲径）', [msg('測った項目だけ入れてください。体重と体脂肪率を入れれば除脂肪量は自動で計算します。')]);
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
    c.appendChild(el('button', { class: 'k-btn', text: 'この内容で記録する', onclick: function () {
      var values = {}, any = false;
      for (var k in inputs) { var v = inputs[k].value.trim(); if (v !== '') { values[k] = Number(v); any = true; } }
      if (!any) { window.alert('1つ以上入力してください。'); return; }
      kWrite('k_addMeasurement', { customerId: cur.customerId, measuredDate: d.get(), values: values }, reqId, { kind: 'measure', data: { measuredDate: d.get(), values: values } }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('記録しました。'); open(cur.customerId, cur.name, 'body', null, 'replace');
      });
    } }));
    return c;
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
  function restSeconds() { var v = Number((function () { try { return localStorage.getItem('karte_rest_s'); } catch (e) { return null; } })()); return [60, 90, 120, 180].indexOf(v) >= 0 ? v : 90; }
  function restStart() {
    rest.endAt = Date.now() + restSeconds() * 1000; rest.buzzed = false; audioUnlock();
    if (rest.box) rest.box.classList.remove('k-rest-done');
    if (rest.iv) clearInterval(rest.iv);
    rest.iv = setInterval(restTick, 500); restTick();
  }
  function restStop() { rest.endAt = 0; if (rest.iv) clearInterval(rest.iv); rest.iv = null; if (rest.box) restTick(); }
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
    box.appendChild(msg('読み込み中…'));
    var askedFor = cur.customerId;
    kRead('k_training', { customerId: cur.customerId }).then(function (r) {
      if (cur.customerId !== askedFor || cur.tab !== 'training') return;   // ★頼んだ顧客＝いまの顧客のときだけ
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      var sessions = r.sessions || [];
      var formBox = el('div');
      var d0 = lsGet(trKey());
      var openNow = !!(d0 || (draft && draft.kind === 'training'));
      box.appendChild(el('button', { class: 'k-btn', text: openNow ? '記録の入力（途中）' : '＋ 今日の記録', onclick: function () { formBox.innerHTML = ''; formBox.appendChild(trainingForm(sessions)); } }));
      box.appendChild(formBox);
      if (openNow) formBox.appendChild(trainingForm(sessions));
      trainingViews(box, sessions);
    });
  }

  function trainingForm(sessions) {
    var c = card('トレーニングを記録', []);
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
        el('div', { style: 'font-size:13px;', text: md(D.pending.payload.sessionDate) + '・' + D.pending.payload.items.map(function (it) { return it.exercise + ' ' + it.sets.length + 'セット'; }).join('・') })]));
      c.appendChild(el('button', { class: 'k-btn', text: '同じ内容で送り直す', onclick: function () { send(D.pending.payload, D.pending.reqId); } }));
      c.appendChild(el('button', { class: 'k-btn out', text: '日別の記録を確かめる', onclick: function () { if (cur.showDayView) cur.showDayView(); } }));
      c.appendChild(el('button', { class: 'k-btn out', text: '破棄して入れ直す', onclick: function () {
        if (!window.confirm('送り直さずに破棄しますか？（記録されていたかは「日別の記録を確かめる」で見られます）')) return;
        lsDel(draftKey); open(cid, cname, 'training', null, 'replace');
      } }));
      return c;
    }
    if (restored) note.textContent = '入力の途中を戻しました（' + fmtDate(D.at) + '）。この端末に最大24時間残ります。';

    var d = field('日付', D.sessionDate, 'date'); d.el.max = today(); d.el.setAttribute('data-nodirty', '1');
    c.appendChild(d.row);
    var partsLine = el('div', { class: 'k-sub', style: 'margin:-4px 0 10px;' });
    c.appendChild(partsLine);
    var prevBtnBox = el('div');
    c.appendChild(prevBtnBox);
    var restBar = el('div', { class: 'k-restbar', style: 'display:none;' });   // ★見た目は CSS の .k-restbar（inline に display を2つ書くと後の flex が勝ち、空の帯が出ていた）
    c.appendChild(restBar);
    rest.box = restBar;
    //   ★休憩中に上の「記録の入力」をもう一度押すと、この欄ごと作り直される。この時点の欄はまだ画面に無い（返してから置かれる）ので、
    //     ここで数えると「外れた帯」と見なして止まる。画面に置かれた後に、残り時間があれば新しい帯で続ける（関門②）
    setTimeout(function () {
      if (rest.box !== restBar || !restBar.isConnected) return;
      if (rest.endAt && !rest.buzzed && !rest.iv) rest.iv = setInterval(restTick, 500);
      restTick();
    }, 0);
    var list = el('div'); c.appendChild(list);
    var remain = el('div', { class: 'k-sub', style: 'margin-top:6px;' });

    function prevLabel(ex) {
      var p = prevOfExercise(sessions, ex, D.sessionDate);
      if (!p) return '前回の記録なし（直近20回の中）';
      var top = p.sets.slice().sort(function (a, b) { return b.weight_kg - a.weight_kg || b.reps - a.reps; })[0];
      var pn = p.sets.filter(function (x) { return x.note; }).map(function (x) { return x.note; });
      return '前回 ' + md(p.s.session_date) + '・' + top.weight_kg + 'kg×' + top.reps + '×' + p.sets.length + 'セット' + (pn.length ? '（メモ：' + pn[pn.length - 1].slice(0, 30) + (pn[pn.length - 1].length > 30 ? '…' : '') + '）' : '');
    }
    function refreshTop() {
      var ps = partsSince(sessions, D.sessionDate);
      partsLine.textContent = ps.length ? '部位ごとの前回：' + ps.map(function (x) { return x.text; }).join('・') + '（種目名から自動判定）' : '';
      prevBtnBox.innerHTML = '';
      var p = prevSession(sessions, D.sessionDate);
      if (p) prevBtnBox.appendChild(el('button', { type: 'button', class: 'k-btn out', text: '前回（' + md(p.session_date) + '・担当 ' + trainerName(p.author_trainer_id) + '）の内容で始める', onclick: function () {
        if (D.items.length && !window.confirm('いま入れている内容を、前回の内容に置き換えますか？')) return;
        var byEx = {}, order = [];
        (p.sets || []).slice().sort(function (a, b) { return a.set_no - b.set_no; }).forEach(function (x) { if (!byEx[x.exercise]) { byEx[x.exercise] = []; order.push(x.exercise); } byEx[x.exercise].push({ w: x.weight_kg, r: x.reps, done: false }); });
        D.items = order.map(function (ex) { return { exercise: ex, sets: byEx[ex] }; });
        if (totalSets(D.items) > TR_TOTAL) { window.alert('前回の内容が60セットを超えるため、途中までにしました。'); trimTotal(); }
        save(); draw();
      } }));
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
      D.items.forEach(function (it, ei) {
        var hasVal = it.sets.some(function (s) { return s.w !== '' && s.r !== '' && s.w != null && s.r != null; });
        var noneDone = !it.sets.some(function (s) { return s.done === true; });
        var blk = el('div', { style: 'border:1px solid ' + (hasVal && noneDone ? '#f1c9a3' : 'var(--k-line)') + ';border-radius:12px;padding:12px;margin-bottom:10px;' + (hasVal && noneDone ? 'background:#fffaf4;' : '') });
        blk.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;' }, [
          el('div', { style: 'flex:1;min-width:0;font-weight:700;font-size:15px;', text: it.exercise }),
          el('span', { class: 'k-tag', text: partOf(it.exercise) }),
          el('button', { type: 'button', class: 'k-btn out small', 'aria-label': it.exercise + 'を外す', text: '外す', onclick: function () { D.items.splice(ei, 1); save(); draw(); } })]));
        blk.appendChild(el('div', { class: 'k-sub', style: 'margin:2px 0 8px;', text: prevLabel(it.exercise) }));
        blk.appendChild(el('div', { class: 'k-setrow', style: 'margin-bottom:2px;font-size:11px;color:var(--k-sub);' }, [el('span'), el('span', { text: '重量 kg' }), el('span', { text: '回数' }), el('span', { style: 'text-align:center;', text: '実施' }), el('span', { style: 'text-align:center;', text: 'メモ' }), el('span')]));
        it.sets.forEach(function (s, si) {
          var chk = el('button', { type: 'button', 'aria-pressed': s.done ? 'true' : 'false', 'aria-label': (si + 1) + 'セット目を実施済みにする',
            style: 'min-width:48px;min-height:48px;border-radius:12px;font-size:20px;font-weight:700;' + (s.done ? 'background:#0e6b5c;color:#fff;border:1px solid #0e6b5c;' : 'background:#fff;color:#c9ccd3;border:1px solid #c9ccd3;'),
            text: '✓', onclick: function () { s.done = !s.done; save(); draw(); if (s.done) restStart(); } });
          blk.appendChild(el('div', { class: 'k-setrow' }, [
            el('span', { style: 'color:var(--k-sub);font-size:13px;text-align:center;', text: String(si + 1) }),
            numInput(s.w, 'kg', (si + 1) + 'セット目の重量', function (v) { s.w = v; }),
            numInput(s.r, '回', (si + 1) + 'セット目の回数', function (v) { s.r = v; }),
            chk,
            el('button', { type: 'button', 'aria-label': (si + 1) + 'セット目のメモ', 'aria-expanded': (s.note || s.memoOpen) ? 'true' : 'false',
              style: 'min-width:44px;min-height:44px;border-radius:10px;font-size:16px;' + (s.note ? 'background:var(--k-acc-l);color:var(--k-acc);border:1px solid var(--k-acc);' : 'background:#fff;color:#9a9ea6;border:1px solid #c9ccd3;'),
              text: '✎', onclick: function () { s.memoOpen = !(s.memoOpen || s.note); if (!s.memoOpen && !s.note) { save(); draw(); return; } save(); draw(); focusMemo(ei, si); } }),
            el('button', { type: 'button', class: 'k-setdel', 'aria-label': (si + 1) + 'セット目を消す', style: 'min-width:44px;min-height:44px;border:none;background:transparent;color:#9a9ea6;font-size:16px;', text: '×',
              onclick: function () { it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
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
              el('button', { type: 'button', class: 'k-btn out small k-setdel2', style: 'margin-top:6px;', text: 'このセットを消す', onclick: function () { it.sets.splice(si, 1); if (!it.sets.length) D.items.splice(ei, 1); save(); draw(); } })]));
          }
        });
        //   セットを足す＝直前のセットを複製（✓は外す）
        blk.appendChild(el('button', { type: 'button', class: 'k-btn out small', text: '＋ セット（前のセットを複製）', onclick: function () {
          if (totalSets(D.items) >= TR_TOTAL) { window.alert('1回の記録は合計60セットまでです。'); return; }
          if (it.sets.length >= 10) { window.alert('1種目10セットまでです。'); return; }
          var last = it.sets[it.sets.length - 1] || { w: '', r: '' };
          it.sets.push({ w: last.w, r: last.r, done: false }); save(); draw();
        } }));
        list.appendChild(blk);
      });
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
      save(); draw();
    }
    c.appendChild(el('button', { type: 'button', class: 'k-btn out', text: '＋ 種目を足す', onclick: function () { picker.style.display = picker.style.display === 'none' ? '' : 'none'; } }));
    var picker = exercisePicker(sessions, function (names) { addExercises(names); picker.style.display = 'none'; });
    picker.style.display = 'none';
    c.appendChild(picker);
    c.appendChild(remain);
    var rs = el('select', { 'data-nodirty': '1', 'aria-label': '休憩の秒数', style: 'min-height:44px;border:1px solid #c9ccd3;border-radius:8px;padding:0 8px;font-size:16px;' });
    [60, 90, 120, 180].forEach(function (v) { var o = el('option', { value: String(v), text: '休憩 ' + v + '秒' }); if (v === restSeconds()) o.selected = true; rs.appendChild(o); });
    rs.onchange = function () { try { localStorage.setItem('karte_rest_s', rs.value); } catch (e) {} };
    var snd = el('button', { type: 'button', class: 'k-pill' + (restSound() ? ' on' : ''), 'aria-pressed': restSound() ? 'true' : 'false', text: restSound() ? '終了音：あり' : '終了音：なし', onclick: function () {
      var on = !restSound(); try { localStorage.setItem('karte_rest_sound', on ? 'on' : 'off'); } catch (e) {}
      if (on) audioUnlock();   // ★この操作の中で用意する（後からでは iPhone は鳴らせない）
      snd.className = 'k-pill' + (on ? ' on' : ''); snd.textContent = on ? '終了音：あり' : '終了音：なし'; snd.setAttribute('aria-pressed', on ? 'true' : 'false');
    } });
    c.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-top:10px;flex-wrap:wrap;' }, [rs, snd, el('span', { class: 'k-sub', text: '✓を押すと休憩タイマーが始まります（記録には保存されません）。終了音は端末の消音設定でも鳴る場合があります' })]));
    c.appendChild(el('div', { class: 'k-note-hint', style: 'margin-top:10px;', text: '痛み・診断・服薬はここに書かず「注意すること」へ' }));

    function send(payload, reqId) {
      if (sending) return;   // ★連打・送信中の再保存を止める（関門②）
      //   ★送る直前に、トレーナー・顧客が下書きと同じかを確かめる（違えば送らない・下書きも消さない）
      if (!same() || D.tid !== tid || D.cid !== cid || payload.customerId !== cid) { window.alert('開いているお客様が変わったため送りませんでした。カルテを開き直してください。'); return; }
      D.pending = { payload: payload, reqId: reqId };
      //   ★送った中身を端末に固定できないなら送らない（送り直しで二重にしないための前提）
      if (!save()) { D.pending = null; window.alert('この端末に送信の控えを残せないため、送りませんでした（ブラウザの保存領域を確かめてください）。'); return; }
      sending = true;
      Array.prototype.forEach.call(c.querySelectorAll('button,input,select'), function (x) { x.disabled = true; });
      if (saveBtn) saveBtn.textContent = '送信中…';
      function back() { if (same()) open(cid, cname, 'training', null, 'replace'); }
      function unknown() { sending = false; if (same()) { window.alert('通信の結果を確かめられませんでした。「同じ内容で送り直す」から送ってください。'); back(); } }
      kWrite('k_addTraining', payload, reqId, { kind: 'training', customerId: cid }).then(function (w) {
        if (!w || w.code === 'BAD_RESPONSE') { unknown(); return; }
        sending = false;
        if (w.success) {
          lsDel(draftKey);
          if (!same()) return;   // 別の顧客を開いていたら画面は触らない
          var n = 0; payload.items.forEach(function (x) { n += x.sets.length; });
          c.innerHTML = '';
          c.appendChild(el('div', { class: 'k-h', text: '記録しました' }));
          c.appendChild(el('div', { style: 'font-size:14px;margin-bottom:8px;', text: md(payload.sessionDate) + '・' + payload.items.length + '種目・' + n + 'セット' }));
          c.appendChild(el('button', { class: 'k-btn', text: '続けて指導メモを書く', onclick: function () { open(cid, cname, 'notes', { kind: 'note', data: { sessionDate: payload.sessionDate, tag: 'training' } }); } }));
          c.appendChild(el('button', { class: 'k-btn out', text: '記録の一覧を見る', onclick: back }));
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
    var saveBtn = null;
    c.appendChild(saveBtn = el('button', { class: 'k-btn', style: 'margin-top:12px;', text: '✓のセットを記録する', onclick: function () {
      var items = buildPayload(D.items);
      if (!items.length) { window.alert('実施したセットに✓を付けてください。'); return; }
      var n = uncheckedCount(D.items);
      if (n && !window.confirm('記録されない入力が ' + n + ' セットあります（✓が無い・重量か回数が空）。保存すると、その入力は消えます。よいですか？')) return;
      var total = 0; items.forEach(function (it) { total += it.sets.length; });
      if (total > TR_TOTAL) { window.alert('1回の記録は合計60セットまでです。'); return; }
      send({ customerId: cur.customerId, sessionDate: D.sessionDate, items: items }, D.reqId);
    } }));
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
    var q = el('input', { 'data-nodirty': '1', type: 'search', placeholder: '種目を探す・新しい名前を入れる', 'aria-label': '種目を探す', enterkeyhint: 'search', style: 'width:100%;min-height:44px;border:1px solid #c9ccd3;border-radius:8px;padding:0 10px;font-size:16px;box-sizing:border-box;' });
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

  function trainingViews(box, sessions) {
    var view = { mode: 'exercise', ex: null };
    var seg = el('div', { class: 'k-seg' });
    var area = el('div', { style: 'display:flex;flex-direction:column;gap:12px;' });
    box.appendChild(seg); box.appendChild(area);
    var exList = [];
    sessions.forEach(function (s) { (s.sets || []).forEach(function (st) { if (exList.indexOf(st.exercise) < 0) exList.push(st.exercise); }); });
    view.ex = exList[0] || null;
    [['day', '日別'], ['exercise', '種目別'], ['part', '部位別']].forEach(function (m) {
      seg.appendChild(el('button', { type: 'button', text: m[1], onclick: function () { view.mode = m[0]; draw(); } }));
    });
    cur.showDayView = function () { view.mode = 'day'; draw(); try { seg.scrollIntoView({ block: 'start' }); } catch (e) {} };
    function draw() {
      Array.prototype.forEach.call(seg.children, function (b, i) { b.className = ['day', 'exercise', 'part'][i] === view.mode ? 'on' : ''; });
      area.innerHTML = '';
      if (!sessions.length) { area.appendChild(msg('まだ記録がありません。')); return; }
      if (view.mode === 'exercise') {
        var chips = el('div', { class: 'k-pills', style: 'gap:6px;' });
        exList.forEach(function (ex) { chips.appendChild(el('button', { type: 'button', class: 'k-pill' + (ex === view.ex ? ' on' : ''), text: ex, onclick: function () { view.ex = ex; draw(); } })); });
        area.appendChild(chips);
        var st = exerciseStats(sessions, view.ex);
        if (!st) return;
        var g = el('div', { class: 'k-grid3' }, [
          el('div', { style: 'background:var(--k-cream);border-radius:10px;padding:10px;' }, [el('div', { class: 'k-sub', text: '自己ベスト' }), el('div', { class: 'k-num', style: 'font-size:17px;', text: st.best.w + 'kg×' + st.best.r }), el('div', { class: 'k-sub', text: md(st.best.d) })]),
          el('div', { style: 'background:var(--k-cream);border-radius:10px;padding:10px;' }, [el('div', { class: 'k-sub', text: '推定MAX' }), el('div', { class: 'k-num', style: 'font-size:17px;', text: st.maxE != null ? st.maxE + 'kg' : '—' }),
            el('div', { style: 'font-size:11px;color:var(--k-acc2);font-weight:700;', text: (st.maxE != null && st.firstE != null && st.days.length > 1) ? '▲ ' + r1(st.maxE - st.firstE) + ' 開始から' : '' })]),
          el('div', { style: 'background:var(--k-cream);border-radius:10px;padding:10px;' }, [el('div', { class: 'k-sub', text: '合計回数' }), el('div', { class: 'k-num', style: 'font-size:17px;', text: st.reps + '回' }), el('div', { class: 'k-sub', text: st.sets + 'セット' })])
        ]);
        area.appendChild(card(view.ex, [g, lineChart(st.days.filter(function (x) { return x.v != null; }).map(function (x) { return { d: x.d, v: x.v }; }), null, 'kg'),
          el('div', { class: 'k-sub', text: '推定MAX＝1回で挙げられる重さの目安（重量と回数から計算・13回以上は出しません）' })]));
        var recent = card('直近3回', []);
        st.days.slice(-3).reverse().forEach(function (dd) {
          recent.appendChild(el('div', { style: 'display:grid;grid-template-columns:56px minmax(0,1fr) 56px;gap:8px;font-size:13px;padding:6px 0;border-top:1px solid var(--k-line);' }, [
            el('div', { class: 'k-sub', text: md(dd.d) }), el('div', {}, [document.createTextNode(dd.sets.map(function (x) { return x.weight_kg + 'kg×' + x.reps; }).join(' ・ '))].concat(
              dd.sets.filter(function (x) { return x.note; }).map(function (x) { return el('div', { class: 'k-sub', text: x.set_no + 'セット目：' + x.note }); }))),
            el('div', { class: 'k-num', style: 'text-align:right;', text: dd.v != null ? String(dd.v) : '' })]));
        });
        area.appendChild(recent);
      } else if (view.mode === 'part') {
        var since = new Date(Date.now() + 9 * 3600000 - 30 * 86400000).toISOString().slice(0, 10);
        var cnt = {}, total = 0;
        sessions.forEach(function (s) { if (s.session_date < since) return; (s.sets || []).forEach(function (st) { var p = partOf(st.exercise); cnt[p] = (cnt[p] || 0) + 1; total++; }); });
        var c2 = card('部位別のセット配分（直近1ヶ月・' + total + 'セット）', []);
        var keys = Object.keys(cnt).sort(function (a, b) { return cnt[b] - cnt[a]; });
        if (!keys.length) c2.appendChild(msg('直近1ヶ月の記録がありません。'));
        keys.forEach(function (k) {
          var bar = el('div', { class: 'k-bar' }, [el('div', { style: 'width:' + Math.round(cnt[k] / total * 100) + '%;' })]);
          c2.appendChild(el('div', { style: 'display:grid;grid-template-columns:52px minmax(0,1fr) 30px;gap:8px;align-items:center;font-size:12px;margin-bottom:8px;' }, [el('div', { text: k }), bar, el('div', { style: 'text-align:right;', text: String(cnt[k]) })]));
        });
        var ps = partsSince(sessions, today());
        if (ps.length) c2.appendChild(el('div', { style: 'font-size:13px;margin-top:6px;', text: '前回から：' + ps.map(function (x) { return x.text; }).join('・') }));
        c2.appendChild(el('div', { class: 'k-sub', text: '種目名から自動で振り分けています（分からない種目は「その他」）' }));
        area.appendChild(c2);
      } else {
        sessions.forEach(function (s) {
          var c3 = card(md(s.session_date) + '・' + trainerName(s.author_trainer_id), []);
          var byEx = {};
          (s.sets || []).forEach(function (st) { (byEx[st.exercise] = byEx[st.exercise] || []).push(st); });
          Object.keys(byEx).forEach(function (ex) {
            c3.appendChild(el('div', { style: 'font-size:13px;margin-bottom:4px;', text: ex + '：' + byEx[ex].map(function (st) { return st.weight_kg + 'kg×' + st.reps + (st.e1rm != null ? '（' + st.e1rm + '）' : ''); }).join('　') }));
            byEx[ex].forEach(function (st) { if (st.note) c3.appendChild(el('div', { class: 'k-sub', style: 'margin:-2px 0 4px 10px;', text: st.set_no + 'セット目：' + st.note })); });
          });
          if (String(s.author_trainer_id) === String(state.trainerId) || state._isOwner) {
            c3.appendChild(el('button', { class: 'k-btn out small', style: 'margin-top:6px;', text: '削除', onclick: function () {
              if (!window.confirm(s.session_date + ' の記録を削除しますか？')) return;
              kWrite('k_deleteTraining', { sessionId: s.session_id, rev: s.rev }, newReqId()).then(function (w) {
                if (!w || !w.success) { window.alert(errText(w)); return; }
                open(cur.customerId, cur.name, 'training', null, 'replace');
              });
            } }));
          }
          area.appendChild(c3);
        });
      }
    }
    draw();
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

  function tabNotes(box, draft) {
    var reflectOpen = !!(draft && (draft.kind === 'reflect' || draft.kind === 'reflectNote'));
    box.appendChild(noteForm(draft && draft.kind === 'note' ? draft.data : null));
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
            c.appendChild(el('button', { class: 'k-btn out small', style: 'margin-top:8px;', text: '削除', onclick: function () {
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
    var c = card('メモを書く', [el('div', { class: 'k-note-hint', text: '痛み・診断・服薬はメモに書かず「注意すること」へ' })]);
    var d = field('日付', (draftData && draftData.sessionDate) || today(), 'date'); d.el.max = today();
    c.appendChild(d.row);
    var tag = pills(TAGS.filter(function (t) { return t[0] !== 'body'; }), draftData && draftData.tag ? [draftData.tag] : [], { single: true });
    c.appendChild(el('div', { class: 'k-sub', style: 'margin-bottom:6px;', text: 'タグ' })); c.appendChild(tag.el);
    var cond = pills([['good', '体調：良い'], ['normal', '体調：普通'], ['bad', '体調：悪い']], draftData && draftData.condition ? [draftData.condition] : [], { single: true });
    c.appendChild(el('div', { style: 'height:10px;' })); c.appendChild(cond.el); c.appendChild(el('div', { style: 'height:10px;' }));
    var body = field('話した内容・やったこと', draftData && draftData.body, 'area', { maxlength: '2000' });
    var next = field('次回やること', draftData && draftData.nextPlan, 'area', { maxlength: '500' });
    c.appendChild(body.row); c.appendChild(next.row);
    var reqId = newReqId();
    c.appendChild(el('button', { class: 'k-btn', text: 'メモを保存', onclick: function () {
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
    return c;
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
  function tabContract(box) {
    box.appendChild(msg('読み込み中…'));
    kRead('k_contract', { customerId: cur.customerId }).then(function (r) {
      box.innerHTML = '';
      if (r && r.code === 'FORBIDDEN') { box.appendChild(msg('担当外のお客様の契約は表示されません。')); return; }
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      if (!(r.contracts || []).length) { box.appendChild(msg('契約の記録が見つかりませんでした。')); return; }
      r.contracts.forEach(function (c) {
        var d0 = c.startMs ? new Date(c.startMs + 9 * 3600000).toISOString().slice(0, 10) : '?';
        var d1 = c.endMs ? new Date(c.endMs + 9 * 3600000).toISOString().slice(0, 10) : '';
        box.appendChild(el('div', { class: 'k-card' }, [
          el('div', { class: 'k-h', style: 'margin-bottom:4px;', text: [c.type, c.course].filter(Boolean).join('・') || '契約' }),
          el('div', { class: 'k-sub', text: d0 + ' 〜 ' + (d1 || '（期限なし）') }),
          el('div', { style: 'font-size:14px;margin-top:4px;', text: (c.freq ? '月' + c.freq + '回　' : '') + (c.tickets ? 'チケット' + c.tickets + '枚　' : '') + (c.trainer ? '担当：' + c.trainer : '') })
        ]));
      });
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
    var root = ensureRoot(); root.innerHTML = '';
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
    _t: { NEED_SCHEMA: NEED_SCHEMA, buildPayload: buildPayload, prevSession: prevSession, prevOfExercise: prevOfExercise, partsSince: partsSince, dayDiff: dayDiff, assess: assess, partOf: partOf, exerciseStats: exerciseStats, PURPOSES: PURPOSES, SLIM_AREAS: SLIM_AREAS, REGIONS: REGIONS, TAGS: TAGS, REASONS: REASONS } };
  resume();
})();
