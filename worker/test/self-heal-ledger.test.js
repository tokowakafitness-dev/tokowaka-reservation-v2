// 自己修理 P1：台帳（incidents）の空のタブ・保存の失敗を黙らない・CEO が読める状態（2026-11-24）
//   実行: node worker/test/self-heal-ledger.test.js
//   ★なぜ要るのか：本番の incidents タブが「在るが完全に空（見出しの行も無い）」だった。
//     _lbIncRead が header_mismatch を返し、_lbHealthSave は saved:false → DONE も通知も無く、結果は Logger だけ＝初回から黙って止まっていた。
//   入口から通す：dailyHealthCheck（本物）→ _lbHealthSave → 台帳。作業依頼は本物の _ejRun('remaining', {healStatus}) から。
//   I-H32 空のタブ（中身が何も無い）だけは、印を確かめてから見出しを書いて使う。1行でも中身がある・見出しが違うなら書かない
//   I-H33 保存できなかった（newer 以外）ことを LB_HEALTH_SAVE_LAST に残し、次の点検が heal_save_fail として従来の悪化メールに載せる
//   I-H35 「自己修理の見張り」の段そのものの例外を selfheal_watch_fail で出す（例外の文は出さない・_done は付けない）
//   I-H34 作業依頼 remaining {healStatus} は列挙・数・日時だけを返す（氏名・会員番号・自由文を返さない・読むだけ）
//   ★値はすべて架空
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { makeWorld, makeSheet, run, makeCtx, status, incRows, incOf, FAKE, tally, ROOT } from './_self-heal-harness.js';
import { pluckFnFrom as pluckFn, pluckVarFrom as pluckVar } from './_gas-lock-src.js';

const t = tally();
const ok = t.ok;
const H = 3600000, D = 24 * H;
const COLS = makeCtx(makeWorld()).LB_HEAL.COLS;
const saveLast = (w) => (w.props.LB_HEALTH_SAVE_LAST ? JSON.parse(w.props.LB_HEALTH_SAVE_LAST) : null);
const hcMails = (w) => w.mails.filter((m) => /システム点検/.test(m.subject));
const LINE = (why) => `自己修理の台帳に保存できませんでした（理由: ${why}）`;

console.log('=== I-H32 空のタブを自分で直す ===');
{
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', []) } });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H32-1 ★完全に空のタブ → 見出しを書いて保存できた（saved:true・header_repaired）', r.saved && r.saved.saved === true && r.saved.header_repaired === true, JSON.stringify(r.saved));
  ok('I-H32-2 見出しは LB_HEAL.COLS と同じ', JSON.stringify(w.sheets.incidents.data[0]) === JSON.stringify(COLS), JSON.stringify(w.sheets.incidents.data[0]));
  ok('I-H32-3 完走の印 DONE が書かれた（修理役が動ける）', Number(w.props.LB_HEALTH_DONE) === r.checkId);
  const s1 = saveLast(w);
  ok('I-H32-4 保存の結果に header_repaired と回数が残る', s1 && s1.saved === true && s1.header_repaired === true && s1.repairs === 1, JSON.stringify(s1));
  w.now += D;
  const r2 = run(w, 'dailyHealthCheck');
  const s2 = saveLast(w) || {};
  ok('I-H32-5 翌日は直さない（header_repaired なし・回数は1のまま）', r2.saved.saved === true && !r2.saved.header_repaired && s2.repairs === 1 && s2.header_repaired === false, JSON.stringify([r2.saved, s2]));
}
{
  const bad = [['id', 'key', 'ちがう見出し']];
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', bad) } });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H32-6 ★見出しが違う → 書かない（行の意味を変えない）・saved:false why=header_mismatch',
     r.saved.saved === false && r.saved.why === 'header_mismatch' && JSON.stringify(w.sheets.incidents.data) === JSON.stringify(bad), JSON.stringify([r.saved, w.sheets.incidents.data]));
  ok('I-H32-7 DONE は書かない（途中の結果を修理に使わない）', !w.props.LB_HEALTH_DONE);
}
{
  const data = [[], ['', 'z']];   // 1行目は空だが2行目に中身がある
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', data) } });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H32-8 ★1行目が空でも、どこかに中身があれば書かない', r.saved.saved === false && r.saved.why === 'header_mismatch' && JSON.stringify(w.sheets.incidents.data) === JSON.stringify(data), JSON.stringify([r.saved, w.sheets.incidents.data]));
}
{
  //   印を失った（要約・SINCE を書いた直後にロックが取れなくなる）→ 見出しを書かない
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', []) } });
  w.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_SINCE') w.lockBusy = true; };
  const r = run(w, 'dailyHealthCheck');
  ok('I-H32-9 ★印を確かめられなければ見出しを書かない', r.saved && r.saved.saved === false && w.sheets.incidents.data.length === 0, JSON.stringify([r.saved, w.sheets.incidents.data]));
  ok('I-H32-10 印を失った回は保存の結果も書かない（見送りは LB_HEALTH_SKIP が数える）', saveLast(w) === null && /lock_busy/.test(w.props.LB_HEALTH_SKIP || ''), JSON.stringify([w.props.LB_HEALTH_SAVE_LAST, w.props.LB_HEALTH_SKIP]));
}

console.log('=== I-H33 保存できなかったことを黙らない ===');
{
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', [['id', 'key', 'ちがう見出し']]) } });
  const r1 = run(w, 'dailyHealthCheck');
  const s = saveLast(w);
  ok('I-H33-1 保存の失敗が LB_HEALTH_SAVE_LAST に残る（why=header_mismatch・check_id）', s && s.saved === false && s.why === 'header_mismatch' && s.check_id === r1.checkId, JSON.stringify(s));
  const m0 = hcMails(w).length;
  w.now += D;
  const r2 = run(w, 'dailyHealthCheck');
  const it = r2.issues.find((x) => x.key === 'heal_save_fail');
  ok('I-H33-2 ★次の点検が heal_save_fail を出す（facts は理由の列挙）', it && it.count === 1 && JSON.stringify(it.safe.facts) === '["header_mismatch"]', JSON.stringify(it));
  const m2 = hcMails(w).slice(m0);
  ok('I-H33-3 ★従来の悪化メールに「保存できませんでした（理由）」の1行が載る', m2.length === 1 && m2[0].body.indexOf(LINE('header_mismatch')) >= 0, JSON.stringify(m2.map((m) => m.subject)));
  w.now += D;
  run(w, 'dailyHealthCheck');
  const m3 = hcMails(w).filter((m) => /前回より悪化/.test(m.body) && m.body.split('---- 全体 ----')[0].indexOf(LINE('header_mismatch')) >= 0);
  ok('I-H33-4 ★同じ失敗が続いても悪化メールは1回だけ（悪化したときだけ知らせる規則）', m3.length === 1, String(m3.length));
}
{
  //   見出しを書く途中で落ちた（＝本番の空のタブができた原因の候補）→ exception → 翌日は直して保存・その翌日は閉じる
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', []) } });
  w.sheets.incidents.failNext = true;
  const r1 = run(w, 'dailyHealthCheck');
  ok('I-H33-5 見出しの書き込みが落ちた → saved:false why=exception を残す', r1.saved.saved === false && r1.saved.why === 'exception' && (saveLast(w) || {}).why === 'exception', JSON.stringify([r1.saved, saveLast(w)]));
  w.now += D;
  const r2 = run(w, 'dailyHealthCheck');
  ok('I-H33-6 翌日：heal_save_fail（exception）を出し、空のタブを直して保存できる',
     r2.issues.some((x) => x.key === 'heal_save_fail' && JSON.stringify(x.safe.facts) === '["exception"]') && r2.saved.saved === true && r2.saved.header_repaired === true,
     JSON.stringify([r2.issues.map((x) => x.key), r2.saved]));
  ok('I-H33-7 heal_save_fail は台帳の案件（B）になる', incOf(w, 'heal_save_fail').length === 1 && (incOf(w, 'heal_save_fail')[0] || {}).cls === 'B', JSON.stringify(incRows(w)));
  w.now += D;
  const r3 = run(w, 'dailyHealthCheck');
  ok('I-H33-8 その翌日：heal_save_fail は出ず、案件は fixed で閉じる', !r3.issues.some((x) => x.key === 'heal_save_fail') && (incOf(w, 'heal_save_fail')[0] || {}).status === 'fixed', JSON.stringify(incOf(w, 'heal_save_fail')));
}
{
  //   newer（新しい点検が既に保存している）は失敗ではない＝記録しない・知らせない
  const w = makeWorld();
  w.props.LB_HEALTH_DONE = String(w.now + 10 * D);
  const r1 = run(w, 'dailyHealthCheck');
  ok('I-H33-9 newer は記録しない', r1.saved.why === 'newer' && saveLast(w) === null, JSON.stringify([r1.saved, w.props.LB_HEALTH_SAVE_LAST]));
  w.now += D;
  const r2 = run(w, 'dailyHealthCheck');
  ok('I-H33-10 newer の翌日に heal_save_fail を出さない', !r2.issues.some((x) => x.key === 'heal_save_fail'));
}
{
  //   後で保存できた（DONE が記録の check_id 以上）なら、古い失敗の記録では鳴らさない
  const w = makeWorld();
  w.props.LB_HEALTH_SAVE_LAST = JSON.stringify({ v: 1, saved: false, why: 'header_mismatch', check_id: w.now - 2 * D, at: w.now - 2 * D });
  w.props.LB_HEALTH_DONE = String(w.now - D);
  w.props.LB_HEALTH_STATUS = JSON.stringify({ v: 1, check_id: w.now - D, completed: true, checked: [], items: [] });
  const r = run(w, 'dailyHealthCheck');
  ok('I-H33-11 後で保存できていれば（DONE ≥ 記録の check_id）古い失敗で鳴らさない', !r.issues.some((x) => x.key === 'heal_save_fail'), JSON.stringify(r.issues.map((x) => x.key)));
}
{
  //   記録に一覧に無い値（架空の氏名）→ other。壊れた JSON → broken（0 とみなさない）
  const w = makeWorld();
  w.props.LB_HEALTH_SAVE_LAST = JSON.stringify({ v: 1, saved: false, why: FAKE.name, check_id: w.now - D, at: w.now - D });
  const r = run(w, 'dailyHealthCheck');
  const it = r.issues.find((x) => x.key === 'heal_save_fail');
  ok('I-H33-12 一覧に無い理由は other（自由な文字を通さない）', it && JSON.stringify(it.safe.facts) === '["other"]' && it.detail.indexOf(FAKE.name) < 0 && JSON.stringify(w.sheets.health_status.data).indexOf(FAKE.name) < 0, JSON.stringify(it));
  const w2 = makeWorld();
  w2.props.LB_HEALTH_SAVE_LAST = '{壊れた';
  const r2 = run(w2, 'dailyHealthCheck');
  ok('I-H33-13 壊れた記録は broken で知らせる（0 とみなさない）', r2.issues.some((x) => x.key === 'heal_save_fail' && JSON.stringify(x.safe.facts) === '["broken"]'));
}
{
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', [['x']]) } });
  run(w, 'dailyHealthCheck', true);
  ok('I-H33-14 dry-run は保存の結果を書かない', saveLast(w) === null);
}

console.log('=== I-H33 関門②の直し（2026-11-24） ===');
{
  //   保存に失敗し（見出し違い）、保存の結果を残す直前の印の確認だけが失敗 → SKIP に数え、翌日 health_skipped が鳴る
  const w = makeWorld({ sheets: { incidents: makeSheet('incidents', [['id', 'key', 'ちがう見出し']]) } });
  w.hooks.setProperty = (k) => { if (k === 'LB_HEALTH_SINCE') w.lockBusy = true; };
  const r1 = run(w, 'dailyHealthCheck');
  const sk = JSON.parse(w.props.LB_HEALTH_SKIP || '{}');
  ok('I-H33-15 ★保存失敗＋保存の結果の印の確認だけ失敗 → LB_HEALTH_SKIP に数える（黙らない）',
     r1.saved && r1.saved.saved === false && r1.saved.why === 'header_mismatch' && saveLast(w) === null && sk.count >= 1 && sk.why === 'lock_busy', JSON.stringify([r1.saved, w.props.LB_HEALTH_SKIP]));
  delete w.hooks.setProperty; w.lockBusy = false; w.now += D;
  const r2 = run(w, 'dailyHealthCheck');
  ok('I-H33-16 ★翌日 health_skipped が鳴る（悪化メールに載る）', r2.issues.some((x) => x.key === 'health_skipped') && hcMails(w).some((m) => /見送られた回/.test(m.body)),
     JSON.stringify(r2.issues.map((x) => x.key)));
}
{
  const fail = (done, status) => {
    const w = makeWorld();
    w.props.LB_HEALTH_SAVE_LAST = JSON.stringify({ v: 1, saved: false, why: 'header_mismatch', check_id: w.now - 2 * D, at: w.now - 2 * D });
    w.props.LB_HEALTH_DONE = String(typeof done === 'function' ? done(w.now) : done);
    if (status) w.props.LB_HEALTH_STATUS = JSON.stringify(status(w.now));
    const it = run(w, 'dailyHealthCheck').issues.find((x) => x.key === 'heal_save_fail');
    return it ? it.safe.facts[0] : null;
  };
  const st = (d) => (now) => ({ v: 1, check_id: d(now), completed: true, checked: [], items: [] });
  const fut = (now) => now + 10 * D;
  ok('I-H33-17 ★壊れた未来の DONE は失敗を隠さない（broken）', fail(fut, st(fut)) === 'broken', String(fail(fut, st(fut))));
  ok('I-H33-18 ★数でない DONE は broken', fail('abc') === 'broken', String(fail('abc')));
  ok('I-H33-19 0以下の DONE は broken', fail('-5') === 'broken');
  const past = (now) => now - D;
  ok('I-H33-20 ★DONE ≥ check_id でも要約の check_id と合わなければ解除しない', fail(past, (now) => ({ v: 1, check_id: now - 3 * D, completed: true, items: [] })) === 'header_mismatch');
  ok('I-H33-21 要約が completed でなければ解除しない', fail(past, (now) => ({ v: 1, check_id: now - D, completed: false, items: [] })) === 'header_mismatch');
  ok('I-H33-22 陰性の対照：DONE・要約が揃えば解除する', fail(past, st(past)) === null);
}
{
  //   見張りの段そのものが落ちた → selfheal_watch_fail（例外の文は出さない・段は checked に付かない）
  const w = makeWorld();
  const c = makeCtx(w);
  const real = c.PropertiesService.getScriptProperties;
  c.PropertiesService.getScriptProperties = () => { const o = real(); const g0 = o.getProperty; o.getProperty = (k) => { if (k === 'LB_SELFHEAL_DONE') throw new Error(FAKE.name + ' ' + FAKE.phone); return g0(k); }; return o; };
  const r = c.dailyHealthCheck();
  const it = r.issues.find((x) => x.key === 'selfheal_watch_fail');
  ok('I-H35-1 ★見張りの段の例外 → selfheal_watch_fail（B・warn）', it && it.severity === 'warn' && c._lbTriage('selfheal_watch_fail').cls === 'B', JSON.stringify(r.issues.map((x) => x.key)));
  ok('I-H35-2 例外の文（架空の氏名・電話）は出さない', it && it.detail.indexOf(FAKE.name) < 0 && it.detail.indexOf(FAKE.phone) < 0 && JSON.stringify(w.sheets.health_status.data).indexOf(FAKE.name) < 0
     && (w.props.LB_HEALTH_STATUS || '').indexOf(FAKE.name) < 0, it && it.detail);
  ok('I-H35-3 段は checked に付かない（今どおり）', r.checked.indexOf('自己修理の見張り') < 0 && r.checked.length > 0, JSON.stringify(r.checked));
  ok('I-H35-4 要約の facts は exception だけ', JSON.stringify((status(w).items.find((x) => x.k === 'selfheal_watch_fail') || {}).f) === '["exception"]');
}

{
  //   投げられた値の name に架空の氏名・電話が入っていても detail に出さない（関門②2回目）
  const w = makeWorld();
  const c = makeCtx(w);
  const real = c.PropertiesService.getScriptProperties;
  c.PropertiesService.getScriptProperties = () => { const o = real(); const g0 = o.getProperty; o.getProperty = (k) => { if (k === 'LB_SELFHEAL_DONE') throw { name: FAKE.name + ' ' + FAKE.phone }; return g0(k); }; return o; };
  const r = c.dailyHealthCheck();
  const it = r.issues.find((x) => x.key === 'selfheal_watch_fail');
  ok('I-H35-5 ★例外の name（架空の氏名・電話）も出さない', it && it.detail.indexOf(FAKE.name) < 0 && it.detail.indexOf(FAKE.phone) < 0 && JSON.stringify(w.sheets.health_status.data).indexOf(FAKE.name) < 0, it && it.detail);
}

{
  //   保存の結果を残す処理が name に架空の氏名・電話を持つ値を投げても、実行ログに出さない（関門②3回目）
  const w = makeWorld();
  const c = makeCtx(w);
  const logs = [];
  c.Logger = { log: (m) => logs.push(String(m)) };
  const real = c.PropertiesService.getScriptProperties;
  c.PropertiesService.getScriptProperties = () => { const o = real(); const s0 = o.setProperty; o.setProperty = (k, v) => { if (k === 'LB_HEALTH_SAVE_LAST') throw { name: FAKE.name + ' ' + FAKE.phone }; return s0(k, v); }; return o; };
  c.dailyHealthCheck();
  const hit = logs.filter((m) => m.indexOf('保存の結果を残せませんでした') >= 0);
  ok('I-H35-6 ★例外の name をログに出さない（型名でなければ Error）', hit.length === 1 && hit[0].indexOf(FAKE.name) < 0 && hit[0].indexOf(FAKE.phone) < 0 && /: Error$/.test(hit[0]), JSON.stringify(hit));
}

console.log('=== I-H34 CEO が作業依頼で読める（heal_status） ===');
const EJ = readFileSync(join(ROOT, 'gas/EdgeJob.js'), 'utf8');
function job(w, args) {
  const c = makeCtx(w);
  vm.runInContext([pluckVar(EJ, 'LB_JOB_BUILD'), 'var _EJ_NAMES = null;', pluckFn(EJ, '_ejScrub'), pluckFn(EJ, '_ejNameList'),
    pluckFn(EJ, '_ejRun'), pluckFn(EJ, '_ejRunInner')].join('\n'), c);
  try { return c._ejRun('remaining', args); } catch (e) { return '（例外: ' + e.name + '）'; }   // 窓口が無い版でも ❌ で落ちる
}
{
  const w = makeWorld({
    data: {
      paceMeta: { brokenCount: 2, brokenNames: [FAKE.name, FAKE.roman], brokenIds: ['C20260101000000', 'C20260202000001'], noContractCount: 0, noContractNames: [], pendingPayMembers: 0 },
      dataHealth: { dupEv: [FAKE.name2 + ' ' + FAKE.phone], dupSlot: [], unlinked: 0, unlinkedList: [], future: [], transferAll: 0 },
      throwIn: { lbContractInputCheck: FAKE.lineId + ' ' + FAKE.email },
    },
    sheets: { incidents: makeSheet('incidents', []) },
  });
  run(w, 'dailyHealthCheck');
  w.now += 3 * H;
  run(w, 'lbSelfHeal');
  //   台帳に誰かが自由な文字を書き込んだ行（列挙に無い値は出さない）
  const row = COLS.map(() => '');
  row[COLS.indexOf('key')] = FAKE.name; row[COLS.indexOf('cls')] = FAKE.note; row[COLS.indexOf('stage')] = FAKE.roman;
  row[COLS.indexOf('status')] = FAKE.phone; row[COLS.indexOf('last_action')] = FAKE.email; row[COLS.indexOf('attempts')] = FAKE.lineId;
  w.sheets.incidents.data.push(row);
  const before = JSON.stringify([w.props, Object.fromEntries(Object.entries(w.sheets).map(([k, s]) => [k, s.data])), w.triggers, w.mails.length, w.pushes.length]);
  const txt = job(w, { healStatus: true });
  const after = JSON.stringify([w.props, Object.fromEntries(Object.entries(w.sheets).map(([k, s]) => [k, s.data])), w.triggers, w.mails.length, w.pushes.length]);
  const leak = [];
  for (const [k, v] of Object.entries(FAKE)) if (txt.indexOf(v) >= 0) leak.push(k);
  for (const v of ['テスト', 'Tesuto', '090-', 'example.invalid', 'U0000', 'C20260101000000', 'C20260202000001', 'uuid-']) if (txt.indexOf(v) >= 0) leak.push(v);
  if (/C\d{14}/.test(txt) || /会員番号の末尾/.test(txt)) leak.push('会員番号');
  ok('I-H34-1 ★氏名・会員番号・電話・メール・LINE ID・自由文・印の owner を返さない', leak.length === 0, leak.join(',') + '\n' + txt);
  ok('I-H34-2 版の印（作業依頼と点検の両方）が載る', /^\[job /.test(txt) && txt.indexOf(String(makeCtx(w).LB_HEALTH_BUILD).slice(0, 11)) >= 0);
  ok('I-H34-3 DONE・SELFHEAL_DONE・保存の結果・台帳の状態が載る',
     /LB_HEALTH_DONE/.test(txt) && /LB_SELFHEAL_DONE/.test(txt) && /LB_HEALTH_SAVE_LAST/.test(txt) && /header_repaired=true/.test(txt) && /台帳 incidents: 使える/.test(txt), txt);
  ok('I-H34-4 台帳の行：key・cls・stage・status・attempts・would_attempts・last_action が並ぶ',
     /member_broken\tB\t会員データ\topen\t0\t0\t/.test(txt) && /contract_input_check_fail\tAB\t契約の入力\t/.test(txt), txt);
  ok('I-H34-5 要約の項目：会員番号は件数だけ（ids=2）', /member_broken .*ids=2/.test(txt), txt);
  ok('I-H34-6 列挙に無い値は ? に置き換える', /\?\t\?\t\?\t\?\t\?\t/.test(txt), txt);
  ok('I-H34-7 ★読むだけ（プロパティ・シート・トリガー・メール・LINE を変えない）', before === after);
  ok('I-H34-8 heal_status（下線の書き方）でも同じものが返る', job(w, { heal_status: true }).replace(/^\[job [^\]]*\]/, '') === txt.replace(/^\[job [^\]]*\]/, ''));
}
{
  const w = makeWorld();
  ok('I-H34-9 台帳が無い → 「まだ無い」と言う（0件と言わない）', /台帳 incidents: まだ無い/.test(job(w, { healStatus: true })));
  w.sheets.incidents = makeSheet('incidents', []);
  ok('I-H34-10 空のタブ → 「空（見出しの行も無い）」と言う', /台帳 incidents: 空（見出しの行も無い）/.test(job(w, { healStatus: true })));
  w.sheets.incidents = makeSheet('incidents', [['id', FAKE.name]]);
  const tx = job(w, { healStatus: true });
  ok('I-H34-11 見出し違い → 中身を出さずに「見出しが違う」と言う', /台帳 incidents: 見出しが違う/.test(tx) && tx.indexOf(FAKE.name) < 0, tx);
}
{
  ok('I-H34-12 新しい op を足していない（remaining の中・_ejScrub を通す）',
     !/case 'heal/.test(EJ) && /if \(args && \(args\.healStatus \|\| args\.heal_status\)\) return _ejScrub\(lbHealStatusText\(\)\);/.test(EJ));
  const JOBS = readFileSync(join(ROOT, 'worker/src/routes/jobs.js'), 'utf8');
  ok('I-H34-13 Worker の許可リストに heal が紛れていない（3箇所は job-ops-drift.test.js が揃いを見る）', !/heal/i.test((JOBS.match(/const OPS = new Set\(\[([^\]]+)\]\)/) || ['', ''])[1]));
}

t.end('自己修理 P1 台帳の空のタブ・保存の失敗・heal_status');
