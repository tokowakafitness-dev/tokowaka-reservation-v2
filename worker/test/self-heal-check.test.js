// 自己修理 P1：点検の側（要約・完走の印・閉じ方・見送りの数え方）（2026-11-23）
//   実行: node worker/test/self-heal-check.test.js
//   入口から通す：dailyHealthCheck（本物）→ 要約・台帳 → lbSelfHeal（本物）。身代わりは _self-heal-harness.js
//   I-H1  要約・台帳・LINE・メールの「オーナーにしかできないこと」に、氏名・顧客の文・例外の文・LINE の ID・メール・電話・予定名が入らない
//   I-H2  fixed は「完走・その段が checked・key 無し」の点検だけが付ける
//   I-H11 古い点検は新しい要約・台帳を上書きしない／DONE は小さい値で戻らない
//   I-H13 facts・ids・last_action・notify_code・notify_state は列挙だけ
//   I-H23 checked は段が例外なく終わった後にだけ付く
//   I-H24 check_id と LB_HEALTH_LAST は同じ数（点検の側）
//   I-H25 見送りは連続回数を数え、完走した点検が health_skipped を出してから戻す
//   I-H28 手動・dry-run の点検も同じ印で排他する
//   ★値はすべて架空
import { makeWorld, run, makeCtx, status, incRows, incOf, removeTrigger, FAKE, tally, lease } from './_self-heal-harness.js';

const t = tally();
const ok = t.ok;
const H = 3600000;

console.log('=== I-H1 氏名・連絡先・例外の文が新しい出力に入らない ===');
{
  const w = makeWorld({
    data: {
      paceMeta: { brokenCount: 3, brokenNames: [FAKE.name, FAKE.roman, FAKE.name2], brokenIds: ['C20260101000000', 'C20260202000001', FAKE.phone],
                  noContractCount: 1, noContractNames: [FAKE.name2], pendingPayMembers: 0 },
      dataHealth: { dupEv: [FAKE.name2 + ' ' + FAKE.phone], dupSlot: [FAKE.event], unlinked: 1, unlinkedList: [FAKE.email], future: [], transferAll: 0 },
      orphan: { orphanB1: [], missingB1: [FAKE.event + ' ' + FAKE.lineId], orphanTrainer: [], missingTrainer: [], manual: [FAKE.note] },
      quota: { ok: true, limited: true, left: 0, pct: 100 },   // quota_exhausted（C・メール）
      emailFailing: 1,                                          // notify_alert_unsent（C・LINE）
      dw: [{ key: 'dw_mismatch', severity: 'warn', count: 1, detail: FAKE.name + ' ' + FAKE.phone }],   // 表に無い key
      throwIn: { lbContractInputCheck: FAKE.lineId + ' ' + FAKE.note + ' ' + FAKE.email },               // 例外の文に連絡先
    },
  });
  removeTrigger(w, 'dailySync');
  const r = run(w, 'dailyHealthCheck');
  w.now += 2 * H; w.props.SELF_HEAL_MODE = 'on';
  run(w, 'lbSelfHeal');
  //   新しく作る出力の全部
  const outs = {
    status: w.props.LB_HEALTH_STATUS || '', since: w.props.LB_HEALTH_SINCE || '', skip: w.props.LB_HEALTH_SKIP || '',
    incidents: JSON.stringify((w.sheets.incidents || { data: [] }).data),
    line: JSON.stringify(w.pushes.map((p) => p.text)),
    ownerMail: JSON.stringify(w.mails.filter((m) => /オーナーにしかできないこと|予約システムの点検/.test(m.subject)).map((m) => [m.subject, m.body])),   // 宛先（to）は走査しない
  };
  const bad = [];
  for (const [where, txt] of Object.entries(outs)) {
    for (const [k, v] of Object.entries(FAKE)) if (txt.indexOf(v) >= 0) bad.push(where + ':' + k);
    for (const v of ['テスト', 'Tesuto', '090-', 'example.invalid', 'U0000']) if (txt.indexOf(v) >= 0) bad.push(where + ':' + v);
  }
  ok('I-H1-1 ★要約・SINCE・台帳・LINE・オーナー宛のメールに架空の氏名・電話・メール・LINE ID・予定名・ひとこと・例外の文が無い', bad.length === 0, bad.join(', '));
  ok('I-H1-2 陽性の対照：既存の health_status には今どおり detail が入っている（注入が効いている）',
     JSON.stringify(w.sheets.health_status.data).indexOf(FAKE.name) >= 0 && JSON.stringify(w.sheets.health_status.data).indexOf(FAKE.lineId) >= 0);
  ok('I-H1-3 陽性の対照：LINE とオーナー宛のメールが実際に出ている（走査が空振りしていない）', w.pushes.length >= 1 && w.mails.some((m) => /オーナーにしかできないこと/.test(m.subject)),
     JSON.stringify({ p: w.pushes.length, m: w.mails.map((m) => m.subject) }));
  const s = status(w);
  const mb = s.items.find((x) => x.k === 'member_broken');
  ok('I-H1-4 member_broken の ids は会員番号の形だけ（電話の形は捨てる）', mb && JSON.stringify(mb.i) === JSON.stringify(['C20260101000000', 'C20260202000001']), JSON.stringify(mb));
  ok('I-H1-5 LINE とメールには会員番号の全桁を出さない', outs.line.indexOf('C20260101000000') < 0 && outs.ownerMail.indexOf('C20260101000000') < 0);
  const ci = s.items.find((x) => x.k === 'contract_input_check_fail');
  ok('I-H1-6 例外は facts: ["exception"] だけ', ci && JSON.stringify(ci.f) === '["exception"]', JSON.stringify(ci));
  ok('I-H1-7 名前入りの key は ids_unavailable', JSON.stringify((s.items.find((x) => x.k === 'resv_dup_ev') || {}).f) === '["ids_unavailable"]');
  ok('I-H1-8 表に無い key は B', (s.items.find((x) => x.k === 'dw_mismatch') || {}).cls === 'B');
  ok('I-H1-9 戻り値に保存の結果', r.saved && r.saved.saved === true, JSON.stringify(r.saved));
}

console.log('=== I-H13 列挙だけ（一覧に無い値は捨てて数える） ===');
{
  const w = makeWorld();
  const c = makeCtx(w);
  const sum = c._lbHealthSummary([
    { key: 'trigger_missing', severity: 'high', count: 2, detail: FAKE.name, safe: { facts: ['dailySync', FAKE.roman, FAKE.phone, 'dailyHealthCheck'] } },
    { key: 'member_broken', severity: 'high', count: 1, detail: '', safe: { ids: ['C12345678901234', FAKE.phone, 'c12345678901234', 'C123'] } },
    { key: 'cancel_notes_unready', severity: 'warn', count: 1, safe: { facts: ['mismatch', 'header_mismatch'] } },
    { key: 'resv_dup_ev', severity: 'high', count: 1, safe: { ids: ['C12345678901234'] } },   // P1 で ids を出すのは member_broken だけ
    { key: 'Bad Key ' + FAKE.name, severity: 'warn', count: 1 },
    { key: 'notify_fail', severity: 'nonsense', count: 1 },
  ], 1000, ['トリガーの揃い']);
  const it = (k) => sum.items.find((x) => x.k === k) || {};
  ok('I-H13-1 facts は key ごとの一覧だけ（ローマ字の氏名・電話・一覧に無い処理名を捨てる）', JSON.stringify(it('trigger_missing').f) === '["dailySync"]', JSON.stringify(it('trigger_missing')));
  ok('I-H13-2 ids は ^C\\d{14}$ だけ', JSON.stringify(it('member_broken').i) === '["C12345678901234"]');
  ok('I-H13-3 cancel_notes の facts は missing/mismatch/unreadable だけ', JSON.stringify(it('cancel_notes_unready').f) === '["mismatch"]');
  ok('I-H13-4 member_broken 以外は ids を出さない', it('resv_dup_ev').i.length === 0 && JSON.stringify(it('resv_dup_ev').f) === '["ids_unavailable"]');
  ok('I-H13-5 key の形でない key は捨てる', !sum.items.some((x) => /Bad|テスト/.test(x.k)));
  ok('I-H13-6 重大度は列挙', it('notify_fail').sev === 'warn');
  ok('I-H13-7 捨てた数を数える', sum.facts_rejected === 3 + 3 + 1 + 1 + 1, String(sum.facts_rejected));
  //   台帳の last_action・notify_code・notify_state・status の列挙
  const row = new Array(c.LB_HEAL.COLS.length).fill('');
  c._lbIncSetEnum(row, 'last_action', 'add_trigger:dailySync', c.LB_ACTION_ENUM);
  ok('I-H13-8 一覧にある last_action は書く', row[c._lbIncCol('last_action')] === 'add_trigger:dailySync');
  c._lbIncSetEnum(row, 'last_action', 'add_trigger:' + FAKE.roman, c.LB_ACTION_ENUM);
  c._lbIncSetEnum(row, 'notify_code', FAKE.phone, c.LB_NOTIFY_ENUM.code);
  c._lbIncSetEnum(row, 'notify_state', 'sent ' + FAKE.name, c.LB_NOTIFY_ENUM.state);
  c._lbIncSetEnum(row, 'status', 'closed', c.LB_STATUS_ENUM);
  ok('I-H13-9 一覧に無い last_action・notify_code・notify_state・status は書かない（空）',
     row[c._lbIncCol('last_action')] === '' && row[c._lbIncCol('notify_code')] === '' && row[c._lbIncCol('notify_state')] === '' && row[c._lbIncCol('status')] === '');
}

console.log('=== I-H24 check_id と LB_HEALTH_LAST は同じ数・DONE も同じ ===');
{
  const w = makeWorld();
  const r = run(w, 'dailyHealthCheck');
  ok('I-H24-1 LAST === check_id === DONE（完走したとき）', w.props.LB_HEALTH_LAST === String(r.checkId) && w.props.LB_HEALTH_DONE === String(r.checkId)
     && status(w).check_id === r.checkId, JSON.stringify({ last: w.props.LB_HEALTH_LAST, done: w.props.LB_HEALTH_DONE, id: r.checkId }));
  ok('I-H24-2 終われば印は残らない', lease(w) === null);
}

console.log('=== I-H23 checked は段が例外なく終わった後にだけ付く ===');
{
  const w = makeWorld({ data: { throwIn: { debugDataHealth: 'x', _lbQuotaFetch: 'y', getProjectTriggers: 'z' } } });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H23-1 *_fail を出した段は checked に無い（予約データ・トリガーの揃い）', r.checked.indexOf('予約データ') < 0 && r.checked.indexOf('トリガーの揃い') < 0, r.checked.join(','));
  ok('I-H23-2 ★黙って握りつぶす段も checked に無い（LINE通数）', r.checked.indexOf('LINE通数') < 0, r.checked.join(','));
  ok('I-H23-3 ほかの段は checked にある', ['会員データ', 'カレンダー', '通知', 'キャンセル理由', '契約の入力'].every((x) => r.checked.indexOf(x) >= 0), r.checked.join(','));
  //   段の始め（_step）では付かない：途中で落ちた段は「始めた」が「終わっていない」
  const w2 = makeWorld({ data: { quota: { ok: false } } });
  const r2 = run(w2, 'dailyHealthCheck');
  ok('I-H23-4 読めなかった（例外ではないが ok=false）段も checked に無い', r2.checked.indexOf('LINE通数') < 0, r2.checked.join(','));
}

console.log('=== I-H2 fixed は「完走・その段が checked・key 無し」の点検だけ ===');
{
  //   ① 修理が成功しても、次の点検で key が残っていれば閉じない
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'on' } });
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += H;
  const h = run(w, 'lbSelfHeal');
  ok('I-H2-0 修理はトリガーを足した', JSON.stringify(h.actions) === '["trigger_missing:add_trigger:dailySync"]', JSON.stringify(h));
  ok('I-H2-1 修理の直後は fixed ではない（fixing・閉じるのは次の点検）', incOf(w, 'trigger_missing')[0].status === 'fixing');
  removeTrigger(w, 'dailySync');   // 誰かがまた消した
  w.now += 23 * H; run(w, 'dailyHealthCheck');
  ok('I-H2-2 ★修理が成功を返しても count>0 なら閉じない', incOf(w, 'trigger_missing')[0].status === 'open', JSON.stringify(incOf(w, 'trigger_missing')));
  //   ② その段が落ちた点検では閉じない（unknown）
  w.triggers.push({ h: 'dailySync' });
  w.data.throwIn.getProjectTriggers = 'x';
  w.now += 24 * H; run(w, 'dailyHealthCheck');
  const row = incOf(w, 'trigger_missing')[0];
  ok('I-H2-3 ★段が落ちた点検で key が無くても閉じない（unknown）', row.status === 'unknown' && row.closed_at === '', JSON.stringify(row));
  //   ③ 段が完走した点検で key が無ければ閉じる
  delete w.data.throwIn.getProjectTriggers;
  w.now += 24 * H; run(w, 'dailyHealthCheck');
  const row2 = incOf(w, 'trigger_missing')[0];
  ok('I-H2-4 段が checked にあって key が無い点検で fixed', row2.status === 'fixed' && row2.closed_at === status(w).check_id, JSON.stringify(row2));
  //   ④ dry-run は台帳を触らない
  const before = JSON.stringify(w.sheets.incidents.data);
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck', true);
  ok('I-H2-5 dry-run は要約・台帳を書かない', JSON.stringify(w.sheets.incidents.data) === before);
  //   ⑤ 同じ結果を2回反映しても同じ（開いた行は1つ）
  w.now += H; run(w, 'dailyHealthCheck'); w.now += H; run(w, 'dailyHealthCheck');
  ok('I-H2-6 開いた行は key ごとに1つ', incOf(w, 'trigger_missing').filter((x) => x.status !== 'fixed').length === 1);
}

console.log('=== I-H11 古い点検は新しい要約を上書きしない・DONE は戻らない ===');
{
  const w = makeWorld();
  const T2 = w.now;
  run(w, 'dailyHealthCheck');
  const s2 = w.props.LB_HEALTH_STATUS, inc2 = JSON.stringify(w.sheets.incidents.data);
  w.now = T2 - 10 * 60000;   // 10分前に始まった点検が後から保存しようとする（check_id が小さい）
  removeTrigger(w, 'dailySync');
  const r = run(w, 'dailyHealthCheck');
  ok('I-H11-1 古い点検は保存しない（newer）', r.saved && r.saved.saved === false && r.saved.why === 'newer', JSON.stringify(r.saved));
  ok('I-H11-2 要約・台帳はそのまま', w.props.LB_HEALTH_STATUS === s2 && JSON.stringify(w.sheets.incidents.data) === inc2);
  ok('I-H11-3 DONE は小さい値で戻らない', w.props.LB_HEALTH_DONE === String(T2));
  //   新しい点検が要約だけ書いて落ちた（DONE は古いまま）→ その後に終わった古い点検は要約を上書きしない
  const w2 = makeWorld();
  const T0 = w2.now;
  run(w2, 'dailyHealthCheck');                 // DONE = T0
  const s2b = status(w2); s2b.check_id = T0 + 2 * H; w2.props.LB_HEALTH_STATUS = JSON.stringify(s2b);   // 新しい点検の要約だけがある
  const keep = w2.props.LB_HEALTH_STATUS;
  w2.now = T0 + H;                             // DONE より新しく、要約より古い点検
  const r2 = run(w2, 'dailyHealthCheck');
  ok('I-H11-4 ★要約が自分より新しければ（DONE が古くても）上書きしない', r2.saved.saved === false && r2.saved.why === 'newer' && w2.props.LB_HEALTH_STATUS === keep, JSON.stringify(r2.saved));
}

console.log('=== I-H25 見送りの連続回数 ===');
{
  const w = makeWorld({ props: { LB_HEALTH_SKIP: JSON.stringify({ count: 1, last: 1, entry: 'heal', why: 'held' }) } });
  //   走っている間に別の見送りが1回起きる（lbSelfHeal が印を取れない）
  let once = false;
  w.hooks.debugDataHealth = () => { if (!once) { once = true; run(w, 'lbSelfHeal'); } };
  run(w, 'dailyHealthCheck');
  const it = status(w).items.find((x) => x.k === 'health_skipped');
  ok('I-H25-1 前回までの見送りが health_skipped（facts=理由）として要約に載る', it && it.c === 1 && JSON.stringify(it.f) === '["held"]', JSON.stringify(it));
  ok('I-H25-2 台帳にも開く（B）', incOf(w, 'health_skipped').length === 1 && incOf(w, 'health_skipped')[0].cls === 'B');
  ok('I-H25-3 ★保存できた後に読んだ分だけ引く（走っている間に増えた1回は残る）', JSON.parse(w.props.LB_HEALTH_SKIP).count === 1, w.props.LB_HEALTH_SKIP);
  //   保存に失敗したら戻さない
  const w2 = makeWorld({ props: { LB_HEALTH_SKIP: JSON.stringify({ count: 2, last: 1, entry: 'check', why: 'lock_busy' }) } });
  w2.sheets.incidents = (await import('./_self-heal-harness.js')).makeSheet('incidents', [['id', 'key', 'ちがう見出し']]);
  const r2 = run(w2, 'dailyHealthCheck');
  ok('I-H25-4 ★台帳を保存できなければ（見出し違い）見送りの回数を戻さない・DONE も進めない', r2.saved.saved === false && JSON.parse(w2.props.LB_HEALTH_SKIP).count === 2 && !w2.props.LB_HEALTH_DONE,
     JSON.stringify({ s: r2.saved, k: w2.props.LB_HEALTH_SKIP, d: w2.props.LB_HEALTH_DONE }));
}

console.log('=== I-H28 手動・dry-run の点検も同じ印で排他する ===');
{
  const w = makeWorld({ props: { SELF_HEAL_MODE: 'practice' } });
  removeTrigger(w, 'dailySync');
  run(w, 'dailyHealthCheck'); w.now += H;
  let dry = null;
  const pace0 = w.calls.refreshPaceBoard || 0;
  w.hooks.getProjectTriggers = () => { if (!dry) dry = run(w, 'dailyHealthCheck', true); };
  run(w, 'lbSelfHeal');
  const paceCalls = (w.calls.refreshPaceBoard || 0) - pace0;
  ok('I-H28-1 ★修理中に dry-run を起動しても走らない（held）', dry && dry.skipped === 'held', JSON.stringify(dry));
  ok('I-H28-2 dry-run はシートを書く部品（refreshPaceBoard）を呼んでいない', paceCalls === 0, String(paceCalls));
  ok('I-H28-3 見送りを数える（entry=check_dry）', JSON.parse(w.props.LB_HEALTH_SKIP).entry === 'check_dry');
  w.hooks.getProjectTriggers = null;
  const d2 = run(w, 'runHealthCheckDryRun');
  ok('I-H28-4 誰も持っていなければ dry-run は走り、印を放す', !d2.skipped && lease(w) === null && Array.isArray(d2.issues));
}

t.end('自己修理 P1 点検の側');
