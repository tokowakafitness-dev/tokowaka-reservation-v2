/* 顧客カルテ（設計28・段1＝トレーナー画面だけ）・2026-11-03
 *
 *   予約 LIFF（index.html）の全体の変数を使う：idToken・EDGE_URL・state（trainerId・_isOwner）・liff
 *   Worker の k_ 窓口だけを呼ぶ（GAS には落とさない＝カルテの正本は D1）。
 *
 *   ★守ること
 *     ・書き込みは clientReqId を「その保存1回」で1つ作り、送り直しでも同じ値を使う（二重にならない）
 *     ・トークンが古くて断られたら（STALE_TOKEN）、入力中の内容を端末に退避して読み直し、戻す（メモを消さない）
 *     ・表示は textContent で入れる（会員の入力・メモを HTML として解釈しない）
 *     ・顧客の画面からは呼ばれない（入口のボタンはトレーナー画面にだけある・Worker も customer を通さない）
 */
(function () {
  'use strict';
  var KARTE_BUILD = '2026-11-03a カルテ段1';
  var DRAFT_KEY = 'karte_draft_v1';
  var EXERCISES = ['ベンチプレス', 'スクワット', 'デッドリフト', 'ラットプルダウン', 'ショルダープレス'];
  var MEASURE = [
    ['weight_kg', '体重', 'kg', 0.1], ['body_fat_pct', '体脂肪率', '%', 0.1], ['lean_kg', '除脂肪量', 'kg', 0.1],
    ['skeletal_muscle_kg', '骨格筋量', 'kg', 0.1], ['body_water_l', '体水分量', 'L', 0.1], ['visceral_fat', '内臓脂肪', '', 1],
    ['chest_cm', '胸囲', 'cm', 0.1], ['arm_cm', '上腕', 'cm', 0.1], ['waist_cm', 'ウエスト', 'cm', 0.1],
    ['hip_cm', 'ヒップ', 'cm', 0.1], ['thigh_cm', '太もも', 'cm', 0.1]
  ];
  var CHARTS = [['w', '体重', 'kg'], ['pbf', '体脂肪率', '%'], ['waist', 'ウエスト', 'cm'], ['chest', '胸囲', 'cm']];
  var COND = { good: '良い', normal: '普通', bad: '悪い' };

  var cur = { customerId: '', name: '', tab: 'summary', root: null, body: null };

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
  function today() { var t = new Date(Date.now() + 9 * 3600000); return t.toISOString().slice(0, 10); }
  function newReqId() {
    try { if (window.crypto && crypto.randomUUID) return 'k' + crypto.randomUUID().replace(/-/g, ''); } catch (e) {}
    return 'k' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12);
  }
  function fmtDate(ms) { if (!ms) return ''; var t = new Date(Number(ms) + 9 * 3600000); return (t.getUTCMonth() + 1) + '/' + t.getUTCDate() + ' ' + String(t.getUTCHours()).padStart(2, '0') + ':' + String(t.getUTCMinutes()).padStart(2, '0'); }
  function msg(text, bad) { return el('p', { class: 'muted', style: 'margin:6px 0;' + (bad ? 'color:var(--warn);' : ''), text: text }); }
  function trainerName(id) {
    var list = (window.state && state._allTrainers) || [];
    for (var i = 0; i < list.length; i++) if (String(list[i].id) === String(id)) return list[i].name;
    return id ? 'トレーナー' : '';
  }
  var ERR = {
    NO_CONSENT: '健康情報の同意が記録されていません。先に「同意を記録」してください。',
    CONFLICT: 'ほかの人が先に更新しました。画面を開き直して最新の内容を確認してください。',
    RATE_LIMITED: '短い時間に保存が続いたため、少し時間をおいてください。',
    BODY_NOT_READY: '体の記録はまだ切り替え前です（従来の InBody 入力を使ってください）。',
    BAD_STATE: 'この記録はできません（退会・再入会の順序、または取り消せるのは最後の記録だけです）。',
    FORBIDDEN: 'この操作の権限がありません。', NOT_FOUND: '見つかりませんでした。', REQ_REUSED: '送信が重なりました。開き直してください。',
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
    try {
      if (!sessionStorage.getItem('karte_reauth')) {
        sessionStorage.setItem('karte_reauth', '1');
        sessionStorage.setItem(DRAFT_KEY, JSON.stringify({ customerId: cur.customerId, name: cur.name, tab: cur.tab, draft: draft || null, at: Date.now() }));
        reloadPage();
        return new Promise(function () {});
      }
    } catch (e) {}
    return { success: false, code: 'STALE', message: 'ログインの更新が必要です。LINE から開き直してください（入力内容は端末に残っています）。' };
  }

  //   読み直しは1か所（検査では window.__karteReload で差し替える）
  function reloadPage() { if (typeof window.__karteReload === 'function') window.__karteReload(); else location.reload(); }

  // ---------------------------------------------------------------- 画面の枠
  function ensureRoot() {
    if (cur.root) return cur.root;
    var root = el('div', { id: 'karteRoot', style: 'position:fixed;inset:0;z-index:9000;background:var(--bg);overflow:auto;-webkit-overflow-scrolling:touch;' });
    document.body.appendChild(root);
    cur.root = root;
    return root;
  }
  function close() { if (cur.root) { cur.root.remove(); cur.root = null; } }

  function open(customerId, name, tab, draft) {
    cur.customerId = String(customerId || ''); cur.name = String(name || ''); cur.tab = tab || 'summary';
    var root = ensureRoot(); root.innerHTML = '';
    var wrap = el('div', { style: 'max-width:520px;margin:0 auto;padding:14px 14px 40px;' });
    var head = el('div', { style: 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;' }, [
      el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:8px 12px;', text: '← 戻る', onclick: close }),
      el('div', { style: 'font-weight:700;font-size:16px;flex:1;text-align:right;', text: cur.name + ' 様のカルテ' })
    ]);
    var tabs = el('div', { style: 'display:flex;gap:6px;overflow-x:auto;margin:6px 0 12px;' });
    [['summary', '概要'], ['body', 'からだ'], ['training', 'トレーニング'], ['notes', 'メモ'], ['contract', '契約']].forEach(function (t) {
      tabs.appendChild(el('button', { class: 'btn ' + (t[0] === cur.tab ? '' : 'btn-outline'), style: 'margin:0;width:auto;padding:8px 12px;white-space:nowrap;', text: t[1],
        onclick: function () { open(cur.customerId, cur.name, t[0]); } }));
    });
    var body = el('div');
    wrap.appendChild(head); wrap.appendChild(tabs); wrap.appendChild(body);
    root.appendChild(wrap);
    cur.body = body;
    ({ summary: tabSummary, body: tabBody, training: tabTraining, notes: tabNotes, contract: tabContract })[cur.tab](body, draft);
  }

  // ---------------------------------------------------------------- 概要
  function tabSummary(box, draft) {
    box.appendChild(msg('読み込み中…'));
    kRead('k_summary', { customerId: cur.customerId }).then(function (r) {
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      var c = r.customer || {};
      //   注意事項（安全面の要点）を最上部に
      var safe = el('div', { class: 'card', style: 'border-color:' + (r.safetyBrief ? 'var(--warn)' : 'var(--line)') + ';' });
      safe.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '注意事項（安全面）' }));
      if (r.consent && r.consent.state === 'agreed') {
        if (r.safetyBrief && (r.safetyBrief.restrictions || r.safetyBrief.painSites)) {
          if (r.safetyBrief.restrictions) safe.appendChild(el('div', { text: '運動制限：' + r.safetyBrief.restrictions }));
          if (r.safetyBrief.painSites) safe.appendChild(el('div', { text: '痛む部位：' + r.safetyBrief.painSites }));
        } else safe.appendChild(msg('記録はまだありません。'));
        safe.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:8px 0 0;', text: '安全面を見る・書く', onclick: function () { safetyForm(box); } }));
      } else {
        safe.appendChild(msg(r.consent && r.consent.state === 'revoked' ? '同意が撤回されています（健康情報は記録できません）。' : '同意待ち：入会時の同意書でカルテでの健康情報の管理に同意をもらってから記録できます。'));
      }
      safe.appendChild(consentRow(r.consent));
      box.appendChild(safe);

      var info = el('div', { class: 'card' });
      info.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '基本' }));
      info.appendChild(el('div', { text: (c.age != null ? c.age + '歳　' : '') + (c.trainerId ? '担当：' + trainerName(c.trainerId) : '担当なし') }));
      if (r.nextReservation) info.appendChild(el('div', { text: '次回の予約：' + fmtDate(r.nextReservation.startAt) }));
      else info.appendChild(el('div', { style: 'color:var(--warn);', text: '次回の予約：なし' }));
      if (r.assigned && c.contractStatus) info.appendChild(el('div', { class: 'muted', text: '契約の状態：' + c.contractStatus }));
      box.appendChild(info);

      box.appendChild(profileCard(r.profile, draft && draft.kind === 'profile' ? draft.data : null));
      if (r.lastNote) {
        var n = r.lastNote;
        var ln = el('div', { class: 'card' });
        ln.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '直近のメモ（' + n.session_date + '・' + trainerName(n.author_trainer_id) + '）' }));
        if (n.condition) ln.appendChild(el('div', { text: '体調：' + (COND[n.condition] || n.condition) }));
        if (n.body) ln.appendChild(el('div', { style: 'white-space:pre-wrap;', text: n.body }));
        if (n.next_plan) ln.appendChild(el('div', { text: '次回：' + n.next_plan }));
        box.appendChild(ln);
      }
      if (r.assigned) box.appendChild(membershipCard());
    });
  }

  function consentRow(consent) {
    var row = el('div', { style: 'display:flex;gap:6px;flex-wrap:wrap;margin-top:10px;' });
    var state0 = consent ? consent.state : 'none';
    function rec(stateTo, method) {
      var label = stateTo === 'agreed' ? '同意を記録しますか？（' + (method === 'paper' ? '紙の同意書' : 'LINE') + '）' : '同意の撤回を記録しますか？\n★記録済みの健康情報は削除され、元に戻せません。';
      if (!window.confirm(label)) return;
      var id = newReqId();
      kWrite('k_saveConsent', { customerId: cur.customerId, state: stateTo, method: method }, id).then(function (r) {
        if (!r || !r.success) { window.alert(errText(r)); return; }
        open(cur.customerId, cur.name, 'summary');
      });
    }
    if (state0 !== 'agreed') {
      row.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:6px 10px;font-size:12px;', text: '同意を記録（紙）', onclick: function () { rec('agreed', 'paper'); } }));
      row.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:6px 10px;font-size:12px;', text: '同意を記録（LINE）', onclick: function () { rec('agreed', 'line'); } }));
    } else {
      row.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:6px 10px;font-size:12px;color:var(--warn);', text: '撤回を記録', onclick: function () { rec('revoked', null); } }));
    }
    return row;
  }

  function profileCard(p, draftData) {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '目標・動機' }));
    var v = draftData || p || {};
    var f = {
      goalText: input('目標（例：胸板を厚くしたい・−5kg）', v.goal_text || v.goalText),
      goalValue: input('目標の数値', v.goal_value != null ? v.goal_value : v.goalValue, 'number'),
      goalUnit: input('単位（kg・cm など）', v.goal_unit || v.goalUnit),
      goalDeadline: input('期限', v.goal_deadline || v.goalDeadline, 'date'),
      motive: area('なぜそうなりたいか（結婚式・自信など）', v.motive),
      history: area('過去のジム経験と続かなかった理由', v.history)
    };
    for (var k in f) card.appendChild(f[k].row);
    var reqId = newReqId();
    card.appendChild(el('button', { class: 'btn', text: '保存する', onclick: function () {
      var data = {}; for (var k in f) data[k] = f[k].get();
      var params = { customerId: cur.customerId, rev: p ? p.rev : 0 };
      for (var k2 in data) params[k2] = data[k2];
      kWrite('k_saveProfile', params, reqId, { kind: 'profile', data: data }).then(function (r) {
        if (!r || !r.success) { window.alert(errText(r)); return; }
        window.alert('保存しました。'); open(cur.customerId, cur.name, 'summary');
      });
    } }));
    return card;
  }
  function input(label, val, type) {
    var i = el('input', { type: type || 'text', style: 'width:100%;padding:9px;box-sizing:border-box;' });
    if (val != null && val !== '') i.value = val;
    if (type === 'number') { i.inputMode = 'decimal'; i.step = 'any'; }
    return { row: el('label', { style: 'display:block;margin-bottom:8px;font-size:13px;' }, [el('div', { class: 'muted', text: label }), i]),
             get: function () { return i.value.trim(); }, el: i };
  }
  function area(label, val, max) {
    var t = el('textarea', { rows: '3', style: 'width:100%;padding:9px;box-sizing:border-box;font-family:inherit;' });
    if (max) t.maxLength = max;
    if (val) t.value = val;
    return { row: el('label', { style: 'display:block;margin-bottom:8px;font-size:13px;' }, [el('div', { class: 'muted', text: label }), t]),
             get: function () { return t.value.trim(); }, el: t };
  }

  function safetyForm(box) {
    box.innerHTML = ''; box.appendChild(msg('読み込み中…'));
    kRead('k_safety', { customerId: cur.customerId }).then(function (r) {
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      if (r.consent !== 'agreed') { box.appendChild(msg('同意が無いため、健康情報は表示・記録できません。', true)); return; }
      var s = r.safety || {};
      var card = el('div', { class: 'card' });
      card.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '安全面（健康情報・要配慮個人情報）' }));
      card.appendChild(msg('指導に必要な範囲だけを書いてください。トレーナー全員が読めます。'));
      var f = { conditions: area('既往歴', s.conditions, 500), injuries: area('ケガ', s.injuries, 500), painSites: area('痛む部位', s.pain_sites, 500),
                medication: area('服薬', s.medication, 500), restrictions: area('運動制限', s.restrictions, 500) };
      for (var k in f) card.appendChild(f[k].row);
      var reqId = newReqId();
      card.appendChild(el('button', { class: 'btn', text: '保存する', onclick: function () {
        var params = { customerId: cur.customerId, rev: r.safety ? r.safety.rev : 0 };
        for (var k in f) params[k] = f[k].get();
        //   ★安全面は端末に退避しない（健康情報を sessionStorage に残さない）
        kWrite('k_saveSafety', params, reqId, null).then(function (w) {
          if (!w || !w.success) { window.alert(errText(w)); return; }
          window.alert('保存しました。'); open(cur.customerId, cur.name, 'summary');
        });
      } }));
      card.appendChild(el('button', { class: 'btn btn-outline', text: '戻る', onclick: function () { open(cur.customerId, cur.name, 'summary'); } }));
      box.appendChild(card);
    });
  }

  function membershipCard() {
    var card = el('div', { class: 'card' });
    card.appendChild(el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '退会・再入会の記録' }));
    card.appendChild(msg('退会後3年の保存期間の起算日になります。契約の期限切れとは別に、退会が決まったときだけ記録してください。'));
    var d = input('発効日', today(), 'date'); d.el.max = today();
    card.appendChild(d.row);
    function rec(kind) {
      if (!window.confirm((kind === 'withdrawn' ? '退会' : '再入会') + '（' + d.get() + '）を記録しますか？')) return;
      kWrite('k_recordMembership', { customerId: cur.customerId, kind: kind, effectiveDate: d.get() }, newReqId()).then(function (r) {
        window.alert(r && r.success ? '記録しました。' : errText(r));
      });
    }
    card.appendChild(el('div', { style: 'display:flex;gap:6px;' }, [
      el('button', { class: 'btn btn-outline', style: 'margin:0;', text: '退会を記録', onclick: function () { rec('withdrawn'); } }),
      el('button', { class: 'btn btn-outline', style: 'margin:0;', text: '再入会を記録', onclick: function () { rec('rejoined'); } })
    ]));
    return card;
  }

  // ---------------------------------------------------------------- からだ
  function lineChart(points, goal, unit) {
    var pts = (points || []).filter(function (p) { return p.v != null; });
    var W = 320, H = 150, P = 28;
    var svg = '<svg viewBox="0 0 ' + W + ' ' + H + '" width="100%" role="img" style="display:block">';
    if (pts.length < 1) return el('div', { class: 'muted', text: 'まだ記録がありません。' });
    var all = pts.map(function (p) { return p.v; }).concat((goal || []).map(function (g) { return g.v; }));
    var lo = Math.min.apply(null, all), hi = Math.max.apply(null, all);
    if (hi === lo) { hi += 1; lo -= 1; }
    var dates = pts.map(function (p) { return p.d; }).concat((goal || []).map(function (g) { return g.d; })).sort();
    var t0 = Date.parse(dates[0]), t1 = Date.parse(dates[dates.length - 1]); if (t1 === t0) t1 = t0 + 86400000;
    function x(d) { return P + (W - P * 2) * (Date.parse(d) - t0) / (t1 - t0); }
    function y(v) { return H - P + 10 - (H - P * 2 + 10) * (v - lo) / (hi - lo); }
    if (goal && goal.length >= 2) svg += '<polyline fill="none" stroke="#b8965a" stroke-dasharray="4 4" stroke-width="1.5" points="' + goal.map(function (g) { return x(g.d).toFixed(1) + ',' + y(g.v).toFixed(1); }).join(' ') + '"/>';
    svg += '<polyline fill="none" stroke="#1b2a47" stroke-width="2" points="' + pts.map(function (p) { return x(p.d).toFixed(1) + ',' + y(p.v).toFixed(1); }).join(' ') + '"/>';
    pts.forEach(function (p) { svg += '<circle cx="' + x(p.d).toFixed(1) + '" cy="' + y(p.v).toFixed(1) + '" r="3" fill="#1b2a47"/>'; });
    svg += '<text x="4" y="12" font-size="10" fill="#57514a">' + hi.toFixed(1) + unit + '</text><text x="4" y="' + (H - 4) + '" font-size="10" fill="#57514a">' + lo.toFixed(1) + unit + '</text>';
    svg += '</svg>';
    var d = el('div'); d.innerHTML = svg;   // 数値と固定の文字列だけで組み立てている（入力は含めない）
    return d;
  }

  function tabBody(box, draft) {
    box.appendChild(msg('読み込み中…'));
    kRead('k_body', { customerId: cur.customerId }).then(function (r) {
      box.innerHTML = '';
      if (!r || !r.success) { box.appendChild(msg(errText(r), true)); return; }
      if (!r.ready) { box.appendChild(msg('体の記録は切り替えの準備中です。それまでは予約画面の「InBodyを記録」を使ってください。')); return; }
      CHARTS.forEach(function (c) {
        var pts = (r.rows || []).map(function (x) { return { d: x.d, v: x[c[0]] != null ? x[c[0]] : null }; });
        var goal = (c[0] === 'w' && r.goal) ? r.goal.points : null;
        var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: c[1] + (goal ? '（点線＝目標）' : '') })]);
        card.appendChild(lineChart(pts, goal, c[2]));
        box.appendChild(card);
      });
      box.appendChild(measureForm(draft && draft.kind === 'measure' ? draft.data : null));
      box.appendChild(goalForm(r.goal));
      var hist = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '最近の記録' })]);
      (r.raw || []).forEach(function (m) {
        var parts = MEASURE.filter(function (f) { return m[f[0]] != null; }).map(function (f) { return f[1] + ' ' + m[f[0]] + f[2]; });
        var row = el('div', { style: 'display:flex;justify-content:space-between;gap:8px;border-top:1px solid var(--line);padding:6px 0;font-size:13px;' }, [
          el('div', { text: m.d + '　' + parts.join('・') })
        ]);
        var mine = m.origin === 'd1' && (String(m.enteredBy) === String(state.trainerId) || state._isOwner);
        if (mine || (state._isOwner && m.origin === 'sheet')) {
          row.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:4px 8px;font-size:12px;', text: '削除', onclick: function () {
            if (!window.confirm(m.d + ' の記録を削除しますか？')) return;
            kWrite('k_deleteMeasurement', { id: m.id, rev: m.rev }, newReqId()).then(function (w) {
              if (!w || !w.success) { window.alert(errText(w)); return; }
              open(cur.customerId, cur.name, 'body');
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
    var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '測定を記録（InBody・周囲径）' })]);
    card.appendChild(msg('測った項目だけ入れてください。体重と体脂肪率を入れれば除脂肪量は自動で計算します。'));
    var d = input('測定日', (draftData && draftData.measuredDate) || today(), 'date'); d.el.max = today();
    card.appendChild(d.row);
    var inputs = {};
    MEASURE.forEach(function (f) {
      var i = el('input', { type: 'number', step: String(f[3]), style: 'padding:9px;flex:1;min-width:0;' }); i.inputMode = 'decimal';
      if (draftData && draftData.values && draftData.values[f[0]] != null) i.value = draftData.values[f[0]];
      inputs[f[0]] = i;
      card.appendChild(el('div', { style: 'display:flex;align-items:center;gap:8px;margin-bottom:6px;' }, [
        el('span', { style: 'flex:0 0 78px;font-size:13px;', text: f[1] }), i, el('span', { class: 'muted', style: 'flex:0 0 28px;font-size:12px;', text: f[2] })
      ]));
    });
    var reqId = newReqId();
    card.appendChild(el('button', { class: 'btn', text: 'この内容で記録する', onclick: function () {
      var values = {}, any = false;
      for (var k in inputs) { var v = inputs[k].value.trim(); if (v !== '') { values[k] = Number(v); any = true; } }
      if (!any) { window.alert('1つ以上入力してください。'); return; }
      kWrite('k_addMeasurement', { customerId: cur.customerId, measuredDate: d.get(), values: values }, reqId, { kind: 'measure', data: { measuredDate: d.get(), values: values } }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('記録しました。'); open(cur.customerId, cur.name, 'body');
      });
    } }));
    return card;
  }

  function goalForm(goal) {
    var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: '体重の目標線' })]);
    var g = goal && goal.kind === 'line' ? goal.points : null;
    var sd = input('開始日', g ? g[0].d : today(), 'date'), ed = input('目標の期限', g ? g[1].d : '', 'date');
    var sw = input('開始体重（kg）', g ? g[0].v : '', 'number'), tw = input('目標体重（kg）', g ? g[1].v : '', 'number');
    [sd, ed, sw, tw].forEach(function (x) { card.appendChild(x.row); });
    if (goal && goal.kind === 'phases') card.appendChild(msg('いまは期ごとの目標（シートから写したもの）が使われています。ここで保存しても、期の目標が優先されます。'));
    var reqId = newReqId();
    card.appendChild(el('button', { class: 'btn btn-outline', text: '目標線を保存', onclick: function () {
      kWrite('k_saveGoalLine', { customerId: cur.customerId, startDate: sd.get(), endDate: ed.get(), startWeight: sw.get(), targetWeight: tw.get() }, reqId).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('保存しました。'); open(cur.customerId, cur.name, 'body');
      });
    } }));
    return card;
  }

  // ---------------------------------------------------------------- トレーニング
  function tabTraining(box, draft) {
    box.appendChild(trainingForm(draft && draft.kind === 'training' ? draft.data : null));
    var list = el('div'); box.appendChild(list);
    list.appendChild(msg('読み込み中…'));
    kRead('k_training', { customerId: cur.customerId }).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.success) { list.appendChild(msg(errText(r), true)); return; }
      //   主要種目の推定1RMのグラフ
      EXERCISES.forEach(function (ex) {
        var pts = (r.best || []).filter(function (b) { return b.exercise === ex; }).map(function (b) { return { d: b.d, v: b.e1rm }; })
          .sort(function (a, b) { return a.d < b.d ? -1 : 1; });
        if (pts.length) list.appendChild(el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: ex + '（推定1RM）' }), lineChart(pts, null, 'kg')]));
      });
      (r.sessions || []).forEach(function (s) {
        var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: s.session_date + '・' + trainerName(s.author_trainer_id) })]);
        var byEx = {};
        (s.sets || []).forEach(function (st) { (byEx[st.exercise] = byEx[st.exercise] || []).push(st); });
        Object.keys(byEx).forEach(function (ex) {
          card.appendChild(el('div', { style: 'font-size:13px;margin-bottom:4px;', text: ex + '：' + byEx[ex].map(function (st) { return st.weight_kg + 'kg×' + st.reps + (st.e1rm != null ? '（' + st.e1rm + '）' : ''); }).join('　') }));
        });
        if (String(s.author_trainer_id) === String(state.trainerId) || state._isOwner) {
          card.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:6px 0 0;width:auto;padding:4px 10px;font-size:12px;', text: '削除', onclick: function () {
            if (!window.confirm(s.session_date + ' の記録を削除しますか？')) return;
            kWrite('k_deleteTraining', { sessionId: s.session_id, rev: s.rev }, newReqId()).then(function (w) {
              if (!w || !w.success) { window.alert(errText(w)); return; }
              open(cur.customerId, cur.name, 'training');
            });
          } }));
        }
        list.appendChild(card);
      });
      if (!(r.sessions || []).length) list.appendChild(msg('まだ記録がありません。'));
    });
  }

  function trainingForm(draftData) {
    var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: 'トレーニングを記録' })]);
    var d = input('日付', (draftData && draftData.sessionDate) || today(), 'date'); d.el.max = today();
    card.appendChild(d.row);
    var items = el('div'); card.appendChild(items);
    var rows = [];
    function addExercise(pre) {
      var sel = el('select', { style: 'width:100%;padding:9px;margin-bottom:6px;' });
      EXERCISES.concat(['その他']).forEach(function (x) { sel.appendChild(el('option', { value: x, text: x })); });
      var other = el('input', { type: 'text', placeholder: '種目名', style: 'width:100%;padding:9px;box-sizing:border-box;display:none;margin-bottom:6px;' });
      sel.onchange = function () { other.style.display = sel.value === 'その他' ? '' : 'none'; };
      if (pre) { if (EXERCISES.indexOf(pre.exercise) >= 0) sel.value = pre.exercise; else { sel.value = 'その他'; other.value = pre.exercise; other.style.display = ''; } }
      var setsBox = el('div');
      var sets = [];
      function addSet(sv) {
        var w = el('input', { type: 'number', step: '0.5', placeholder: 'kg', style: 'padding:8px;width:80px;' }); w.inputMode = 'decimal';
        var rp = el('input', { type: 'number', step: '1', placeholder: '回', style: 'padding:8px;width:64px;' }); rp.inputMode = 'numeric';
        if (sv) { w.value = sv.weight; rp.value = sv.reps; }
        var line = el('div', { style: 'display:flex;align-items:center;gap:6px;margin-bottom:4px;font-size:13px;' }, [el('span', { text: (sets.length + 1) + 'セット' }), w, el('span', { text: '×' }), rp]);
        setsBox.appendChild(line); sets.push({ w: w, r: rp });
      }
      ((pre && pre.sets) || [null]).forEach(function (sv) { addSet(sv); });
      var block = el('div', { style: 'border-top:1px solid var(--line);padding-top:8px;margin-top:6px;' }, [sel, other, setsBox,
        el('button', { class: 'btn btn-outline', style: 'margin:0 0 6px;width:auto;padding:4px 10px;font-size:12px;', text: '＋ セット', onclick: function () { if (sets.length < 10) addSet(); } })]);
      items.appendChild(block);
      rows.push({ get: function () {
        var ex = sel.value === 'その他' ? other.value.trim() : sel.value;
        var ss = sets.map(function (s) { return { weight: s.w.value.trim(), reps: s.r.value.trim() }; }).filter(function (s) { return s.weight !== '' && s.reps !== ''; })
          .map(function (s) { return { weight: Number(s.weight), reps: Number(s.reps) }; });
        return { exercise: ex, sets: ss };
      } });
    }
    ((draftData && draftData.items) || [null]).forEach(function (it) { addExercise(it); });
    card.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:6px 0;', text: '＋ 種目を追加', onclick: function () { if (rows.length < 20) addExercise(); } }));
    var reqId = newReqId();
    card.appendChild(el('button', { class: 'btn', text: 'この内容で記録する', onclick: function () {
      var its = rows.map(function (r) { return r.get(); }).filter(function (it) { return it.exercise && it.sets.length; });
      if (!its.length) { window.alert('種目と、重量・回数を1セット以上入れてください。'); return; }
      kWrite('k_addTraining', { customerId: cur.customerId, sessionDate: d.get(), items: its }, reqId, { kind: 'training', data: { sessionDate: d.get(), items: its } }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        window.alert('記録しました。'); open(cur.customerId, cur.name, 'training');
      });
    } }));
    return card;
  }

  // ---------------------------------------------------------------- メモ
  function tabNotes(box, draft) {
    box.appendChild(noteForm(draft && draft.kind === 'note' ? draft.data : null));
    var list = el('div'); box.appendChild(list);
    list.appendChild(msg('読み込み中…'));
    kRead('k_notes', { customerId: cur.customerId }).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.success) { list.appendChild(msg(errText(r), true)); return; }
      (r.notes || []).forEach(function (n) {
        var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: n.session_date + '・' + trainerName(n.author_trainer_id) + (n.edited_at ? '（編集済み）' : '') })]);
        if (n.condition) card.appendChild(el('div', { text: '体調：' + (COND[n.condition] || n.condition) }));
        if (n.body) card.appendChild(el('div', { style: 'white-space:pre-wrap;', text: n.body }));
        if (n.next_plan) card.appendChild(el('div', { text: '次回：' + n.next_plan }));
        if (String(n.author_trainer_id) === String(state.trainerId) || state._isOwner) {
          card.appendChild(el('button', { class: 'btn btn-outline', style: 'margin:6px 0 0;width:auto;padding:4px 10px;font-size:12px;', text: '削除', onclick: function () {
            if (!window.confirm('このメモを削除しますか？')) return;
            kWrite('k_deleteNote', { noteId: n.note_id, rev: n.rev }, newReqId()).then(function (w) {
              if (!w || !w.success) { window.alert(errText(w)); return; }
              open(cur.customerId, cur.name, 'notes');
            });
          } }));
        }
        list.appendChild(card);
      });
      if (!(r.notes || []).length) list.appendChild(msg('まだメモがありません。'));
    });
  }

  function noteForm(draftData) {
    var card = el('div', { class: 'card' }, [el('div', { class: 'sect-h', style: 'margin:0 0 6px;', text: 'セッションのメモ' })]);
    var d = input('日付', (draftData && draftData.sessionDate) || today(), 'date'); d.el.max = today();
    card.appendChild(d.row);
    var cond = (draftData && draftData.condition) || '';
    var cbox = el('div', { style: 'display:flex;gap:6px;margin-bottom:8px;' });
    var btns = {};
    Object.keys(COND).forEach(function (k) {
      btns[k] = el('button', { class: 'btn ' + (cond === k ? '' : 'btn-outline'), style: 'margin:0;', text: '体調：' + COND[k], onclick: function () {
        cond = (cond === k) ? '' : k;
        Object.keys(btns).forEach(function (j) { btns[j].className = 'btn ' + (cond === j ? '' : 'btn-outline'); });
      } });
      cbox.appendChild(btns[k]);
    });
    card.appendChild(cbox);
    var body = area('話した内容・やったこと', draftData && draftData.body, 2000);
    var next = area('次回やること', draftData && draftData.nextPlan, 500);
    card.appendChild(body.row); card.appendChild(next.row);
    var reqId = newReqId();
    card.appendChild(el('button', { class: 'btn', text: 'メモを保存', onclick: function () {
      var data = { sessionDate: d.get(), condition: cond, body: body.get(), nextPlan: next.get() };
      if (!data.condition && !data.body && !data.nextPlan) { window.alert('体調か内容を入れてください。'); return; }
      var params = { customerId: cur.customerId }; for (var k in data) params[k] = data[k];
      kWrite('k_addNote', params, reqId, { kind: 'note', data: data }).then(function (w) {
        if (!w || !w.success) { window.alert(errText(w)); return; }
        open(cur.customerId, cur.name, 'notes');
      });
    } }));
    return card;
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
        box.appendChild(el('div', { class: 'card' }, [
          el('div', { style: 'font-weight:700;', text: [c.type, c.course].filter(Boolean).join('・') || '契約' }),
          el('div', { class: 'muted', text: d0 + ' 〜 ' + (d1 || '（期限なし）') }),
          el('div', { text: (c.freq ? '月' + c.freq + '回　' : '') + (c.tickets ? 'チケット' + c.tickets + '枚　' : '') + (c.trainer ? '担当：' + c.trainer : '') })
        ]));
      });
    });
  }

  // ---------------------------------------------------------------- 一覧
  var FLAG = {
    noNextBooking: ['次の予約なし', '予約の同期を確認中'],
    recordStale: ['記録が30日以上ない', '記録の準備中'],
    contractEnding: ['契約の終了が近い', '契約を確認中'],
    paymentPending: ['支払い待ち', '残数を確認中']
  };
  function openBoard(after, acc) {
    var root = ensureRoot(); root.innerHTML = '';
    var wrap = el('div', { style: 'max-width:520px;margin:0 auto;padding:14px 14px 40px;' });
    wrap.appendChild(el('div', { style: 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;' }, [
      el('button', { class: 'btn btn-outline', style: 'margin:0;width:auto;padding:8px 12px;', text: '← 戻る', onclick: close }),
      el('div', { style: 'font-weight:700;', text: 'カルテの一覧' })
    ]));
    var list = el('div'); wrap.appendChild(list); root.appendChild(wrap);
    list.appendChild(msg('読み込み中…'));
    kRead('k_board', after ? { after: after } : {}).then(function (r) {
      list.innerHTML = '';
      if (!r || !r.success) { list.appendChild(msg(errText(r), true)); return; }
      var all = (acc || []).concat(r.customers || []);
      //   印がある人を上に
      all.sort(function (a, b) { return score(b.flags) - score(a.flags); });
      all.forEach(function (c) {
        var tags = el('div', { style: 'display:flex;gap:4px;flex-wrap:wrap;margin-top:4px;' });
        Object.keys(FLAG).forEach(function (k) {
          var v = c.flags[k];
          if (v === true) tags.appendChild(el('span', { style: 'font-size:11px;padding:2px 6px;border-radius:10px;background:#f6e3df;color:var(--warn);', text: FLAG[k][0] }));
          else if (typeof v === 'string' && v !== 'none') tags.appendChild(el('span', { style: 'font-size:11px;padding:2px 6px;border-radius:10px;background:#eee;color:#57514a;', text: FLAG[k][1] }));
          else if (k === 'recordStale' && v === 'none') tags.appendChild(el('span', { style: 'font-size:11px;padding:2px 6px;border-radius:10px;background:#f6e3df;color:var(--warn);', text: '体の記録なし' }));
        });
        list.appendChild(el('div', { class: 'card', style: 'cursor:pointer;', onclick: function () { open(c.customerId, c.name, 'summary'); } }, [el('b', { text: c.name + ' 様' }), tags]));
      });
      if (r.next) list.appendChild(el('button', { class: 'btn btn-outline', text: 'さらに表示', onclick: function () { openBoard(r.next, all); } }));
      if (!all.length) list.appendChild(msg('対象のお客様がいません。'));
    });
  }
  function score(f) { var s = 0; for (var k in f) if (f[k] === true || (k === 'recordStale' && f[k] === 'none')) s++; return s; }

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
        open(d.customerId, d.name, d.tab, d.draft);
        try { sessionStorage.removeItem('karte_reauth'); } catch (e) {}
        window.alert('ログインを更新しました。入力内容を戻したので、もう一度「保存」を押してください。');
        return;
      }
      if (++tries < 40) setTimeout(wait, 500);
      else { try { sessionStorage.removeItem('karte_reauth'); } catch (e) {} }
    })();
  }

  window.KarteUI = { open: open, openBoard: openBoard, build: KARTE_BUILD };
  resume();
})();
