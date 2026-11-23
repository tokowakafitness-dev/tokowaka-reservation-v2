// 自己修理 P1：オーナーへの通知（2026-11-23）
//   実行: node worker/test/self-heal-notify.test.js
//   I-H14 即時の宛先が 0 人ならメール。quota_exhausted は LINE を試さない
//   I-H15 通知は試行と成功を分け、届いた後は送らない／sending のまま残れば LINE で送り直さずメール
//   I-H19 オーナーへの通知の失敗は _lbNqOnFail に積まれない（警告の未達が警告を呼ぶループを作らない）
//   ★値はすべて架空
import { makeWorld, run, incOf, tally, FAKE } from './_self-heal-harness.js';

const t = tally();
const ok = t.ok;
const H = 3600000;
const unsent = (o = {}) => makeWorld(Object.assign({ data: { emailFailing: 1 } }, o));   // notify_alert_unsent（C・即時 LINE）
const ownerMails = (w) => w.mails.filter((m) => /予約システムの点検/.test(m.subject));

console.log('=== I-H14 宛先 ===');
{
  const w = unsent();
  run(w, 'dailyHealthCheck');
  const row = incOf(w, 'notify_alert_unsent')[0];
  ok('I-H14-1 owner 1人：LINE 1通・届いた（line_ok・delivered・tries 1）', w.pushes.length === 1 && w.pushes[0].to === FAKE.lineId && row.notify_code === 'line_ok' && row.notify_state === 'delivered' && row.notify_tries === 1, JSON.stringify(row));
  ok('I-H14-2 送る経路は _lbPushOnce（purpose=owner_heal・その場で粘らない）', w.pushes[0].opts.purpose === 'owner_heal' && w.pushes[0].opts.noInlineRetry === true);
  ok('I-H14-3 LINE の文は固定の文（取り違えようのない一文）', /^【要対処】届かなかった LINE 通知を知らせるメールが送れていません/.test(w.pushes[0].text), w.pushes[0].text);

  const w0 = unsent({ trainers: [['', 'T1', 'テスト', 'owner', true, ''], ['U00000000000000000000000000000002', 'T2', 'テスト', 'admin', true, '']] });
  run(w0, 'dailyHealthCheck');
  ok('I-H14-4 ★owner 0人（LINE ID が空・admin には送らない）→ メール・no_recipient', w0.pushes.length === 0 && incOf(w0, 'notify_alert_unsent')[0].notify_code === 'no_recipient_mail_ok' && ownerMails(w0).some((m) => /【要対処】/.test(m.subject)));

  const w2 = unsent({ trainers: [[FAKE.lineId, 'T1', 'テスト', 'owner', true, ''], [FAKE.lineId, 'T9', 'テスト', 'owner', false, ''], ['U00000000000000000000000000000003', 'T3', 'テスト', ' owner ', true, '']] });
  run(w2, 'dailyHealthCheck');
  ok('I-H14-5 owner 2人（同じ ID は1回）→ LINE 2通', w2.pushes.length === 2 && new Set(w2.pushes.map((p) => p.to)).size === 2, JSON.stringify(w2.pushes.map((p) => p.to)));

  const wa = unsent({ trainers: [[FAKE.lineId, 'T1', 'テスト', 'owner', false, ''], ['U00000000000000000000000000000004', 'T4', 'テスト', 'owner', '', '']] });
  run(wa, 'dailyHealthCheck');
  ok('I-H14-5b ★active が真でない owner には送らない（_lbOwnerLineIds と同じ _lbTruthy）→ 0人ならメール', wa.pushes.length === 0 && incOf(wa, 'notify_alert_unsent')[0].notify_code === 'no_recipient_mail_ok');
  const wb = unsent({ trainers: [['U00000000000000000000000000000005', 'T5', 'テスト', 'owner', '有効', '']] });
  run(wb, 'dailyHealthCheck');
  ok('I-H14-5c active の表記（有効）も既存と同じく真', wb.pushes.length === 1);

  const w3 = unsent({ noTrainerSheet: true });
  run(w3, 'dailyHealthCheck');
  ok('I-H14-6 表が読めない → メール（no_recipient）', w3.pushes.length === 0 && incOf(w3, 'notify_alert_unsent')[0].notify_code === 'no_recipient_mail_ok');

  const w4 = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } });
  run(w4, 'dailyHealthCheck');
  ok('I-H14-7 ★quota_exhausted は LINE を試さない・メール（オーナーにしかできないこと）に載る', w4.pushes.length === 0 && ownerMails(w4).some((m) => /LINE の送信数が上限に達しました/.test(m.body)), JSON.stringify(w4.mails.map((m) => m.subject)));
}

console.log('=== I-H15 試行と成功を分ける・届いた後は送らない・送信中に落ちた ===');
{
  const w = unsent();
  run(w, 'dailyHealthCheck');
  w.now += 24 * H; run(w, 'dailyHealthCheck');
  ok('I-H15-1 届いた後は翌日も送らない', w.pushes.length === 1 && incOf(w, 'notify_alert_unsent')[0].notify_tries === 1);
  //   送信中に落ちた（sending のまま残った）
  const w2 = unsent();
  //   LINE を送った直後、結果を書く前に実行が落ちた（次の台帳の書き込みで落とす）
  w2.hooks.push = () => { w2.sheets.incidents.failNext = true; };
  run(w2, 'dailyHealthCheck');
  const r0 = incOf(w2, 'notify_alert_unsent')[0];
  ok('I-H15-2 送る前に sending と時刻を書いている（落ちても残る）', r0.notify_state === 'sending' && r0.notify_tries === 1 && r0.notified_at > 0, JSON.stringify(r0));
  w2.hooks.push = null; w2.now += 24 * H;
  const n0 = w2.pushes.length;
  run(w2, 'dailyHealthCheck');
  const r1 = incOf(w2, 'notify_alert_unsent')[0];
  ok('I-H15-3 ★次の回は LINE で送り直さずメール（resend_by_mail）', w2.pushes.length === n0 && r1.notify_code === 'resend_by_mail_ok' && r1.notify_state === 'delivered' && r1.notify_tries === 2, JSON.stringify(r1));
  //   届かなかった（LINE もメールも）→ 次の日にもう一度・最大3日
  const w3 = unsent(); w3.pushOk = false; w3.data.mailThrows = true;
  for (let d = 0; d < 5; d++) { run(w3, 'dailyHealthCheck'); w3.now += 24 * H; }
  const r3 = incOf(w3, 'notify_alert_unsent')[0];
  ok('I-H15-4 届かなければ1日1回・最大3日で止める（failed）', w3.pushes.length === 3 && r3.notify_tries === 3 && r3.notify_state === 'failed' && r3.notify_code === 'line_fail_mail_fail', JSON.stringify(r3));
  //   同じ日に2回点検しても2回送らない
  const w4 = unsent(); w4.pushOk = false; w4.data.mailThrows = true;
  run(w4, 'dailyHealthCheck'); w4.now += H; run(w4, 'dailyHealthCheck');
  ok('I-H15-5 失敗でも同じ日には送り直さない', w4.pushes.length === 1);
}

console.log('=== I-H19 失敗を _lbNqOnFail に積まない ===');
{
  const w = unsent(); w.pushOk = false;
  run(w, 'dailyHealthCheck');
  const row = incOf(w, 'notify_alert_unsent')[0];
  ok('I-H19-1 ★LINE が失敗しても _lbNqOnFail・_lbPush を呼ばない', w.nqOnFail === 0 && w.forbidden.length === 0, JSON.stringify({ nq: w.nqOnFail, f: w.forbidden }));
  ok('I-H19-2 失敗ならメールに倒す（line_fail_mail_ok）', row.notify_code === 'line_fail_mail_ok' && row.notify_state === 'delivered' && ownerMails(w).length >= 1, JSON.stringify(row));
}

console.log('=== オーナーにしかできないこと（日付ごとに1通・悪化と無関係・off で止まる） ===');
{
  const w = makeWorld({ data: { quota: { ok: true, limited: true, left: 0, pct: 100 } } });
  run(w, 'dailyHealthCheck'); w.now += H; run(w, 'dailyHealthCheck');
  const dg = () => w.mails.filter((m) => /オーナーにしかできないこと/.test(m.subject)).length;
  ok('まとめ-1 同じ日は1通', dg() === 1);
  w.now += 24 * H; run(w, 'dailyHealthCheck');
  ok('まとめ-2 ★件数が変わらなくても（悪化していなくても）翌日また1通', dg() === 2);
  w.props.SELF_HEAL_MODE = 'off'; w.now += 24 * H; run(w, 'dailyHealthCheck');
  ok('まとめ-3 SELF_HEAL_MODE=off なら送らない（戻すときの即時の止め方）', dg() === 2);
  const w2 = makeWorld();
  run(w2, 'dailyHealthCheck');
  ok('まとめ-4 開いているものが無ければ送らない', w2.mails.length === 0);
}

t.end('自己修理 P1 通知');
