// トリガーの安全（2026-10-09・Codex関門①で発覚）
//
//   ★何が危なかったか
//     `setupTriggers()` は作られた当時トリガーが3本しか無かった。いまは18本ある。
//     `getProjectTriggers()` を**名前で絞らずに全部消し、3本しか戻さない。**
//     実行すると押し出し・作業依頼・カレンダー同期・うながし・固定枠の自動予約・
//     日次点検が丸ごと止まる＝顧客の残数が固まり、リマインドが届かない。
//
//     ★そして**日次点検が「setupTriggers を実行し直すと戻ります」と案内していた。**
//       案内どおりに実行すると大事故になる。
//
//   実行: node worker/test/trigger-safety.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

const CODE = rd('gas/コード.js');
const LB = rd('gas/LineBooking.js');
//   ★2026-10-09：最初この検査は LineBooking.js しか見ておらず、
//     Nudge.js（オーナーへ送られるメール）と overview.html の案内を**取り残した**。
//     「全部見た」は機械で確かめる。危険な文字列は**全ファイルから**探す。
const NUDGE = rd('gas/Nudge.js');

// ---------- 1. 全部消す関数が実行できないこと ----------
ok('①★setupTriggers は実行を拒否する',
   /function setupTriggers\(\) \{[\s\S]{0,900}?throw new Error\(msg\);/.test(CODE),
   '名前で絞らずに全部消し、3本しか戻さない');
ok('①★全部消すループが残っていない',
   !/function setupTriggers\(\) \{\n  var triggers = ScriptApp\.getProjectTriggers\(\);\n  for \(var i = 0; i < triggers\.length; i\+\+\) ScriptApp\.deleteTrigger\(triggers\[i\]\);/.test(CODE));
ok('①代わりの関数は名前で絞る',
   /function setupBasicTriggersOnly\(\)/.test(CODE)
   && /if \(names\[all\[i\]\.getHandlerFunction\(\)\]\)/.test(CODE),
   'その3つだけを作り直し、ほかには触らない');
ok('①何本消したかを返す', /消した ' \+ removed \+ ' 本・ほかのトリガーには触っていません/.test(CODE));

// ---------- 2. 点検が危険な案内をしないこと ----------
ok('②★「setupTriggers を実行し直す」と案内していない',
   !/setupTriggers を実行し直すと戻ります/.test(LB),
   '案内どおりに実行すると、押し出し・作業依頼・点検そのものが止まる');
ok('②★実行しないよう明示している',
   /★setupTriggers は実行しないでください（全部消して3本しか戻しません）/.test(LB));
ok('②用途ごとの関数を名指しで案内する',
   /setupEdgeTrigger/.test(LB) && /setupEdgeJobTrigger/.test(LB)
   && /setupCalSyncTrigger/.test(LB) && /setupNudgeTrigger/.test(LB)
   && /setupRecurringTriggers/.test(LB) && /setupLineTriggers/.test(LB));
ok('②版の印を上げている', /LB_HEALTH_BUILD = '2026-10-10a/.test(LB));

// ---------- 3. ★月次のものを日次と混同しないこと（私の誤り）----------
//   atHour だけを見て onMonthDay を見ていなかった。
//   設計どおり実装すると**全トレーナーに毎日LINEが飛ぶ**（送信済み判定が無い）。
{
  //   ★実際の定義は setupRecurringTriggers（LineBooking.js:7177）の1箇所にある
  const setup = LB.slice(LB.indexOf('function setupRecurringTriggers()'),
                         LB.indexOf('function setupRecurringTriggers()') + 900);
  ok('③★シフト連絡は毎月20日10時',
     /newTrigger\('sendShiftReminders'\)\.timeBased\(\)\.onMonthDay\(20\)\.atHour\(10\)/.test(setup),
     '毎日ではない。毎日呼ぶと全トレーナーに毎日LINEが飛ぶ（送信済み判定が無い）');
  ok('③★固定枠の自動予約は毎月25日6時',
     /newTrigger\('autoBookRecurringPatterns'\)\.timeBased\(\)\.onMonthDay\(25\)\.atHour\(6\)/.test(setup),
     '毎日ではない');
  ok('③シフト連絡に送信済みの判定が無い（だから毎日呼んではいけない）',
     !/shift_sent|_lbShiftSent|sentThisMonth/.test(LB.slice(LB.indexOf('function sendShiftReminders'),
                                                            LB.indexOf('function sendShiftReminders') + 1200)),
     '束ねるなら、日付で絞るか送信済み印を足すのが前提');
  //   ★日次のものと束ねるときは、必ず日付で絞る（まだ束ねていないので、
  //     束ねる実装が入ったらこの検査を「日付の判定がある」に変える）
  ok('③いまは束ねていない（毎日呼ぶ実装が入っていない）',
     !/function lbDaily6\(/.test(LB) && !/function lbDaily10\(/.test(LB),
     '束ねるなら JST の日付で絞る実装と同時に入れる');
}

// ---------- 4. ★`setupTriggers` の使い方を許可リストで縛る ----------
//
//   ★なぜブラックリストをやめたか（2026-10-09・Codex関門①の3周目）
//     最初は「危険な言い方」を4つ列挙して探していた。**言い換えを防げない。**
//       setupTriggersを実行 ／ setupTriggers を再実行 ／
//       setupTriggers で復旧 ／ setupTriggers を走らせてください
//     どれも通ってしまう。
//   ★だから逆にする：**`setupTriggers` が出てくる場所を全部集め、
//     許されている形だけを通す。** 許可にない出現は落とす。
{
  const { readdirSync, statSync } = await import('node:fs');
  const SKIP_DIR = new Set(['node_modules', '.git', 'dist', 'build', '.wrangler']);
  const files = [];
  const walk = (dir) => {
    for (const name of readdirSync(join(ROOT, dir || '.'))) {
      if (SKIP_DIR.has(name) || name[0] === '.') continue;
      const rel = dir ? `${dir}/${name}` : name;
      let st; try { st = statSync(join(ROOT, rel)); } catch (_) { continue; }
      //   ★深さを制限しない（「全ファイル」と言うなら制限しない）
      if (st.isDirectory()) { walk(rel); continue; }
      if (/\.(js|gs|html|md|json|yml|yaml)$/.test(name)) files.push(rel);
    }
  };
  walk('');
  ok('④全ファイルを見ている（深さの制限なし）', files.length > 50, `${files.length}ファイル`);

  //   許されている形（これ以外の非コメント出現は落とす）
  const ALLOW = [
    /^function setupTriggers\(\) \{$/,                    // 関数の定義
    /この関数は実行できません/,                              // 拒否の文
    /setupTriggers は実行しないでください/,                  // 案内（してはいけないと書く）
    /<code>setupTriggers\(\)<\/code> は実行しないでください/, // 同（HTML）
    /setupTriggers を廃止または実行拒否/,                    // 設計の記述
    /^var LB_\w+_BUILD = '[^']*setupTriggers[^']*';$/,        // 版の印の文面（何を直したかを書く）
  ];
  //   除く場所
  //     ops/design・00_board … 経緯の記録（なぜ危険かを残すため）
  //     worker/test …★検査そのもの。危険な文言を**打ち消す形で**書く
  //       （`!/…/.test(…)` のように「無いこと」を確かめる行が引っかかる）
  //     expected-builds.json … 版の印の期待値（文面に関数名が入る）
  const SKIP_FILE = /^ops\/design\/|^00_board\/|^worker\/test\//;

  const bad = [];
  for (const f of files) {
    if (SKIP_FILE.test(f)) continue;
    let src; try { src = rd(f); } catch (_) { continue; }
    if (src.indexOf('setupTriggers') < 0) continue;
    const lines = src.split('\n');
    for (let n = 0; n < lines.length; n++) {
      const ln = lines[n];
      if (ln.indexOf('setupTriggers') < 0) continue;
      //   コメント行（// * <!-- #）は経緯の記述として許す
      if (/^\s*(\/\/|\*|<!--|#)/.test(ln)) continue;
      if (ALLOW.some((re) => re.test(ln.trim()))) continue;
      bad.push(`${f}:${n + 1} ${ln.trim().slice(0, 70)}`);
    }
  }
  ok('④★許可にない `setupTriggers` の使い方が無い', bad.length === 0,
     bad.join('\n   '));

  //   ★「して良いこと」を肯定形でも見る（許可リストだけでは「案内が消えた」ことに気づけない）
  ok('④概要ページに拒否の案内がある',
     /<code>setupTriggers\(\)<\/code> は実行しないでください/.test(rd('overview.html')));
  ok('④オーナーへ送るメールに拒否の案内と代わりの関数がある',
     /★setupTriggers は実行しないでください/.test(NUDGE)
     && /setupRecurringTriggers/.test(NUDGE),
     'Nudge.js は日次点検が止まったときにオーナーへ送る文面');
  ok('④点検の案内にも拒否と代わりの関数がある',
     /★setupTriggers は実行しないでください/.test(LB) && /setupEdgeJobTrigger/.test(LB));
}

// ---------- 5. ★版の印は完全一致で固定する ----------
//   ★「形だけ見る」に変えたのは誤りだった（2026-10-09・Codex関門①の3周目）。
//     形だけでは**上げ忘れを捕まえられない**（昨日の印でも形は正しい）。
//     固定値を毎回更新する手間が、上げ忘れを捕まえる仕組みそのもの。
//   ★期待値は1つのファイル（expected-builds.json）に集める。
//     版を上げたらそこだけ直す。各検査はそこを参照する。
{
  const expected = JSON.parse(rd('worker/test/expected-builds.json'));
  const where = {
    LB_EDGE_BUILD: 'gas/PushToEdge.js',
    LB_AUDIT_BUILD: 'gas/EdgeAudit.js',
    LB_HEALTH_BUILD: 'gas/LineBooking.js',
    LB_NUDGE_BUILD: 'gas/Nudge.js',
    LB_JOB_BUILD: 'gas/EdgeJob.js',
  };
  for (const [name, file] of Object.entries(where)) {
    const want = expected[name];
    ok(`⑤${name} が期待の値`, want != null && rd(file).indexOf(`var ${name} = '${want}'`) >= 0,
       `期待=${want}（${file}）。上げたら expected-builds.json も直す`);
  }
  ok('⑤期待値の一覧に漏れがない',
     Object.keys(where).every((k) => expected[k] != null)
     && Object.keys(expected).length === Object.keys(where).length,
     `一覧=${Object.keys(expected).join(',')}`);
}

console.log(`\n${fail ? '❌' : '✅'} トリガーの安全 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
