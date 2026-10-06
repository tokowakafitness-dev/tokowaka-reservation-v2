// リマインドが同じ人に二重に届かないことの検証
//
//   ★なぜ要るのか（2026-10-05）
//     顧客へ送り始める前のレビューで、二重送信の経路が3つ見つかった。
//     どれも「1日1回しかトリガーが動かない」前提に寄りかかった作りだった。
//
//       ① 送信済みの抑止が4種類のうち2種類（month_open・visit_a）にしか無く、
//          transfer と visit_b は条件が続くかぎり毎回候補になった。
//       ② 全員へ送り終えてから一括で記録していた。途中で時間切れになると
//          「送信済みだが記録なし」が残り、次の実行で同じ人にもう一度届く。
//       ③ 排他が無く、トリガーの二重発火や手動実行と重なると、
//          どちらも「まだ誰にも送っていない」記録を読んで2通送る。
//
//     顧客に直接届くものなので、届かないより届きすぎる方が害が大きい。
//     迷ったときは送らない側に倒す、が全体の方針。
//
//   実行: node worker/test/nudge-dedupe.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const SRC = readFileSync(join(ROOT, 'gas/Nudge.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- ① 1人1日1通を、種別をまたいで守る ----------
ok('①暦日ごとの印を集めている', /out\._byDay\[Utilities\.formatDate\(d, SETTINGS\.TIMEZONE, 'yyyy-MM-dd'\) \+ '\|' \+ cid\] = true/.test(SRC));
ok('①その日に送ったかを見る関数がある', /function _lbNudgeSentOnDay\(logs, customerId, dayKey\)/.test(SRC));
ok('①★候補が決まったあと、送る前に必ず通る',
  /if \(_lbNudgeSentOnDay\(log, m\.customerId, todayKey\)\) \{ plan\.skipped\.sentToday\+\+; continue; \}/.test(SRC),
  'ここが消えると transfer と visit_b が毎回送られる');
ok('①一覧に理由が出る', /sentToday: '今日すでに送信済み'/.test(SRC) && /sentToday: 0/.test(SRC));

// ---------- ② 送る前に記録する ----------
ok('②1件ずつ書く関数がある', /function _lbNudgeLogAppendOne\(row, nowMs\)/.test(SRC));
ok('②結果で書き換える関数がある', /function _lbNudgeLogSettle\(rowIndex, expect, result, detail\)/.test(SRC));
ok('②★書いてから送る順序になっている',
  /_row = _lbNudgeLogAppendOne\([\s\S]{0,120}?\n[\s\S]{0,200}?ok = _lbPush\(/.test(SRC),
  '送ってから記録する順序に戻っている');
ok('②書けなければ送らない', /res\.code = 'LOG_UNWRITABLE'; break;/.test(SRC));
ok('②送る前に確実に残す', /SpreadsheetApp\.flush\(\);\s*\/\/ 送る前に確実に残す/.test(SRC));
ok('②★全員送ってから一括で書く関数は無い',
  !/function _lbNudgeLogWrite\s*\(/.test(SRC),
  'まとめ書きが復活すると、途中で落ちたとき記録が残らない');

// ---------- ③ 同時に2つ走らせない ----------
ok('③ロックを取る', /LockService\.getScriptLock\(\)/.test(SRC));
ok('③★取れなければ待たずに中止', /_lock\.tryLock\(0\)/.test(SRC) && /res\.code = 'ALREADY_RUNNING'/.test(SRC),
  '待って送ると、待っていた方が同じ人に2通目を送る');
ok('③必ず解放する', /\} finally \{[\s\S]{0,120}releaseLock\(\)/.test(SRC));

// ---------- ④ 分からないものは「送った」とみなす ----------
//   'sending' のまま残る＝送ったかどうか分からない。再送しない側に倒す。
ok('④sending も抑止に数える', /_rst !== 'sent' && _rst !== 'sending'/.test(SRC));
ok('④★記録が読めなければ1通も出さない',
  /out\._readFailed = true/.test(SRC) && /if \(log\._readFailed\) \{ plan\.code = 'LOG_UNREADABLE'; return plan; \}/.test(SRC),
  '読めないまま送ると、昨日送った人へもう一度送る');
ok('④★「抑止を効かせないまま続行」が残っていない',
  !/送信は中止せず、この実行では抑止を効かせない/.test(SRC));

// ---------- ⑤ 1人でも届かなければ成功と言わない ----------
ok('⑤失敗したら success を倒す', /res\.failed\+\+; res\.success = false;/.test(SRC),
  '監視が success だけを見ると部分失敗を見逃す');

// ---------- ⑥ 版の印が更新されている ----------
ok('⑥版の印', /LB_NUDGE_BUILD = '2026-10-06a/.test(SRC), '直したのに出力が変わらないときの切り分けに要る');
ok('⑥★一覧を二重にログへ出さない',
  /lbNudgeCatchUpPreview\(FROM, TO\);   \/\/ 一覧は中でログに出る/.test(SRC),
  '同じ一覧が2回出ると、2回送ったように見えて確認を誤る');

// ---------- ⑦ ロックは「誰に送るかを決める前」に取る ----------
//   ★送信だけを囲っても足りない（2026-10-05 Codex指摘）。
//     2つの実行が同時に一覧を作ると、どちらも「まだ誰にも送っていない」記録を読む。
//     先に送った方が解放したあと、もう一方が古い一覧のまま送る＝同じ人に2通届く。
ok('⑦入口でロックを取ってから一覧を作る',
  /function lbNudgeDaily[\s\S]{0,900}?lock\.tryLock\(0\)[\s\S]{0,600}?_lbNudgeSend\(lbNudgePlanAll\(ms\), ms, true\)/.test(SRC),
  'plan を作ってからロックを取る順序に戻っている');
ok('⑦送信側はロック済みを受け取る', /function _lbNudgeSend\(plan, nowMs, alreadyLocked\)/.test(SRC));
ok('⑦単独で呼ばれたときは自分で取る', /if \(!alreadyLocked\) \{\s*\n\s*try \{ _lock = LockService\.getScriptLock\(\)/.test(SRC));

// ---------- ⑧ 同じ会員が名簿に2行あっても1通 ----------
ok('⑧この実行で作った会員を覚える', /var seenCid = \{\};/.test(SRC) && /seenCid\[m\.customerId\] = true;/.test(SRC));
ok('⑧★2度目は作らない', /if \(seenCid\[m\.customerId\]\) \{ plan\.skipped\.dupMember\+\+; continue; \}/.test(SRC),
  '送信済みの記録はこの実行より前しか見ないので、同じ一覧の中の重複は防げない');
ok('⑧一覧に理由が出る', /dupMember: '名簿に同じ会員の行が重複'/.test(SRC) && /dupMember: 0/.test(SRC));

// ---------- ⑨ 書き戻す行が自分の行か確かめる ----------
ok('⑨★書く前に種別と顧客IDを照合する',
  /String\(cur\[0\]\) !== String\(expect\.kind\) \|\| String\(cur\[1\]\) !== String\(expect\.customerId\)/.test(SRC),
  '送信中に行がずれると、別人の記録を書き換える');
ok('⑨ずれたら何も書かない（sending のまま）', /行がずれたため結果を書きません/.test(SRC));
ok('⑨呼び出し側が期待する行の中身を渡している',
  /_lbNudgeLogSettle\(_row, \{ kind: t\.kind, customerId: t\._cid \}/.test(SRC));

// ---------- ⑩ 守れないなら送らない ----------
//   ★ロックが取れない仕組みのときに「取れたこと」にして送るのが、
//     前回の修正で持ち込んだ穴だった（2026-10-05 Codex 2回目）。
ok('⑩入口：ロックを使えなければ中止', /if \(!lock\) \{[\s\S]{0,200}?LOCK_UNAVAILABLE/.test(SRC));
ok('⑩送信側：ロックを使えなければ中止', /res\.code = 'LOCK_UNAVAILABLE';/.test(SRC));
ok('⑩★「lock があれば」で済ませていない',
  !/if \(lock && !lock\.tryLock\(0\)\)/.test(SRC) && !/if \(_lock && !_lock\.tryLock\(0\)\)/.test(SRC),
  'null のまま素通りすると、何も守らずに送る');

// ---------- ⑪ 中止したら success を倒して理由を返す ----------
ok('⑪中止の理由を返す', /res\.success = false; res\.code = plan\.code;/.test(SRC),
  '1通も送れていないのに「成功」と見えると、止まっている状態が黙って続く');

// ---------- ⑫ 追いかけ送信（ある期間の来店者へ、まとめて1回） ----------
//   ★毎日の送信は「昨日来た人」しか見ない。有効化の前に来店した方には何も届かない。
//     運用を始める前の数日ぶんを、1人1通で追いかける（2026-10-06 オーナー要望）。
ok('⑫来店を見る窓を期間で広げられる',
  /function _lbNudgeResvIndex\(now, range\)/.test(SRC)
  && /if \(range && range\.fromMs != null && range\.toMs != null\) \{ yStart = range\.fromMs; yEnd = range\.toMs; \}/.test(SRC));
ok('⑫一覧の生成にも期間を渡せる',
  /function lbNudgePlanAll\(nowMs, range\)/.test(SRC) && /_lbNudgeResvIndex\(now, range\)/.test(SRC));
ok('⑫入口が2つある（確認用と送信用）',
  /function lbNudgeCatchUpPreview\(fromYmd, toYmd\)/.test(SRC) && /function lbNudgeCatchUp\(fromYmd, toYmd\)/.test(SRC));
ok('⑫★to の日を含める（指定した最終日の来店者が漏れない）',
  /toEnd\.setDate\(toEnd\.getDate\(\) \+ 1\);/.test(SRC));
ok('⑫期間が不正なら何もしない', /code: 'BAD_RANGE'/.test(SRC));

// ★追いかけ送信も、毎日の送信と同じ守りを通ること
ok('⑫★ロックを一覧の前に取る',
  /function lbNudgeCatchUp\(fromYmd, toYmd\)[\s\S]{0,700}?lock\.tryLock\(0\)[\s\S]{0,400}?_lbNudgeSend\(lbNudgePlanAll\(ms, r\), ms, true\)/.test(SRC),
  '一覧を作ってからロックを取ると、毎日の送信と同時に走ったとき同じ人へ2通行く');
ok('⑫★ロックが使えなければ送らない',
  /function lbNudgeCatchUp\(fromYmd, toYmd\)[\s\S]{0,500}?LOCK_UNAVAILABLE/.test(SRC));
ok('⑫★送信は共通の _lbNudgeSend を通る（重複防止を迂回しない）',
  /_lbNudgeSend\(lbNudgePlanAll\(ms, r\), ms, true\)/.test(SRC),
  '別の送信処理を書くと、1日1通・送る前に記録・名簿の重複よけが効かない');

// ★既定（期間を渡さない）の挙動が変わっていないこと
ok('⑫既定はいまも「昨日の1日」',
  /var yStart = _lbNudgeDayStart\(now, -1\), yEnd = _lbNudgeDayStart\(now, 0\);/.test(SRC));
ok('⑫一覧の整形は毎日と追いかけで共通',
  /function _lbNudgePreviewText\(plan, title\)/.test(SRC)
  && /return _lbNudgePreviewText\(lbNudgePlanAll\(ms\), null\);/.test(SRC));

// ---------- ⑬ 追いかけ送信が、来ていない日のことを言わない／別の人に送らない ----------
//   ★Codex関門②で差し戻された3点（2026-10-06）。どれも顧客に直接届く誤り。
ok('⑬★「先日」の文面が別に用意されている',
  /visit_a_catchup: \{/.test(SRC) && /visit_b_catchup: \{/.test(SRC)
  && /先日はお疲れさまでした。/.test(SRC),
  'visit_a/visit_b を流用すると、9/30の来店者に「昨日はお疲れさまでした」と送る');
ok('⑬★追いかけのときだけ文面を切り替える',
  /_lbNudgeMsg\(lang, catchUp \? 'visit_a_catchup' : 'visit_a', vars\)/.test(SRC)
  && /_lbNudgeText\(win\.kind, m\.lang, v, !!range\)/.test(SRC));
ok('⑬英語・中国語も直っている',
  /Thank you for your recent session\./.test(SRC) && /前些天辛苦了。/.test(SRC),
  '日本語だけ直すと、他の言語の方には "yesterday" のまま届く');

ok('⑬★追いかけは来店した人だけに送る',
  /if \(range\) \{[\s\S]{0,300}?c\.kind === LB_NUDGE_KIND\.VISIT_A \|\| c\.kind === LB_NUDGE_KIND\.VISIT_B/.test(SRC),
  '期間を広げると、当日キャンセルした人へ振替の案内が飛び、解放日なら全会員に翌月の案内が飛ぶ');
ok('⑬来店以外は理由として数える', /notVisitKind: '来店以外（追いかけでは送らない）'/.test(SRC));

ok('⑬★同じ期間を二度実行しても二度目は送らない',
  /function _lbNudgeSentForRange\(logs, customerId, rangeKey\)/.test(SRC)
  && /if \(range && _lbNudgeSentForRange\(log, m\.customerId, range\.key\)\)/.test(SRC),
  '暦日の抑止だけでは、翌日もう一度実行すると visit_b に2通目が届く');
ok('⑬期間の鍵を記録に残す',
  /key: 'catchup:' \+ Utilities\.formatDate/.test(SRC)
  && /_key: \(range \? range\.key : win\.key\)/.test(SRC),
  '鍵を記録しないと、次の実行で「送った」と判定できない');
ok('⑬送信済みは理由として数える', /catchUpDone: 'この期間の追いかけは送信済み'/.test(SRC));
ok('⑬★エディタから引数なしで呼べる入口がある',
  /function lbNudgeCatchUpCheck\(\) \{/.test(SRC) && /function lbNudgeCatchUpSend\(\) \{/.test(SRC),
  'GASエディタの関数プルダウンからは引数を渡せない。入口が無いとオーナーが実行できない');
ok('⑬確認用と送信用が名前で見分けられる',
  /lbNudgeCatchUpCheck[\s\S]{0,400}?lbNudgeCatchUpPreview\(FROM, TO\)/.test(SRC)
  && /lbNudgeCatchUpSend[\s\S]{0,400}?lbNudgeCatchUp\(FROM, TO\)/.test(SRC),
  '取り違えて送信を実行すると、確認なしで顧客に届く');
ok('⑬★抑止が「恒久的」ではないことを書いてある',
  /「恒久的」ではない。記録を読むのは直近 LB_NUDGE_LOG_SCAN 行まで/.test(SRC),
  '3000行を超えて古くなった鍵は見えなくなる。言い切ると、同じ期間を流し直したとき二重に届く');

// ---------- ⑭ 「残数が出ない」の中身を分ける ----------
//   ★2026-10-06、追いかけ送信の一覧に「残数が算出できない 9名」と出た。
//     前日は2名だったので「7名が壊れた」と疑ったが、**誤報**だった。
//     同じ名前で3つの別の状態を数えていた：
//       ・計算が壊れている（その会員は予約できない）← 本当の異常
//       ・月額の契約が無い（チケットだけ・契約切れ）← 正常
//       ・月額の頻度が未設定                        ← 正常
//     異常が正常の中に埋もれると、気づくべきものに気づけない。
ok('⑭なぜ残数が出ないのかを持ち回る',
  /why: \(h && h\.reviewRequired\) \? 'broken' : 'noMonthly'/.test(SRC));
ok('⑭★計算が止まっている人と、月額契約が無い人を分けて数える',
  /reasons\.push\(f2\.why === 'broken' \? 'remainBroken' : 'noMonthlyPlan'\)/.test(SRC)
  && /reasons\.push\(f3\.why === 'broken' \? 'remainBroken' : 'noMonthlyPlan'\)/.test(SRC));
ok('⑭一覧で見分けられる',
  /remainBroken: '🚨 残数の計算が止まっている/.test(SRC)
  && /noMonthlyPlan: '月額の契約が無い/.test(SRC),
  '異常だけが目に入るようにする。正常と同じ見た目だと毎回調べ直すことになる');
ok('⑭両方とも集計に初期値がある', /remainBroken: 0, noMonthlyPlan: 0,/.test(SRC));

console.log(`\n${fail ? '❌' : '✅'} リマインドの二重送信 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
