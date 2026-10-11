// 出勤枠の新しさ（2026-10-11）
//
//   ★なぜ要るのか
//     トレーナーがカレンダーにブロック・出勤枠を入れたのに、**30分経っても
//     予約システムに反映されなかった**（2026-10-11 実例）。
//     原因は3つが直列に積み上がっていたこと：
//       ① 押し出しは枠を作らず、キャッシュを読むだけだった
//          （作り直すのは別トリガーの warmupCache・10分ごと）     最大10分
//       ② 押し出し自体が10分ごと                                 最大10分
//       ③ ほかの押し出しとぶつかると5秒で諦めて、その回を捨てた   さらに+10分
//     しかも D1 の computed_at は**押し出した時刻**なので、
//     20分前のカレンダーも「たったいま」に見え、**何分遅れているか答えられなかった**。
//
//   実行: node worker/test/slots-freshness.test.js

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

const PUSH = rd('gas/PushToEdge.js');
const CODE = rd('gas/コード.js');
const AUDIT = rd('gas/EdgeAudit.js');
const JOB = rd('gas/EdgeJob.js');

let pass = 0, fail = 0;
function ok(name, cond, why) {
  if (cond) { pass++; return; }
  fail++;
  console.log(`❌ ${name}`);
  if (why) console.log(`   ${why}`);
}

// ★コメントを落としてから見る（2026-10-11）。
//   これを入れる前、`// buildAndCacheSlots();` とコメントアウトしても
//   検査が通ってしまった（＝守っているつもりで何も守っていなかった）。
//   「書いてある」ではなく「実行される形で書いてある」かを見る。
const strip = (src) => src
  .replace(/\/\*[\s\S]*?\*\//g, '')   // ブロックコメント
  .split('\n').map((ln) => ln.replace(/\/\/.*$/, '')).join('\n');

// ---------- 1. 作ってから押す。ただし★ロックの外で ----------
const slotRows = strip(PUSH.slice(PUSH.indexOf('function _edgeSlotRows('),
                                  PUSH.indexOf('function _edgeWithSheetCache')));
const pushSlots = strip(PUSH.slice(PUSH.indexOf('function pushToEdgeSlots()'),
                                   PUSH.indexOf('var LB_SLOTS_PUSHED_AT_PROP')));

ok('①★押し出しの前に枠を作り直す',
   /buildAndCacheSlots\(\);/.test(pushSlots),
   'キャッシュを読むだけだと、新しさは warmupCache の間隔（10分）で決まる');

//   ★関門②の指摘：一度これを _edgeSlotRows（＝共有ロックの中）に書いた。
//     buildAndCacheSlots は重い（カレンダー読み＋キャッシュ＋公開シート）ので、
//     ロックの中で回すと 15分同期・4時の完全同期が5秒で諦めて見送る。
//     ＝「枠が負ける」問題を「ほかが枠に負ける」問題に反転させていた。
ok('①★★作り直しは共有ロックの**外**で行う',
   !/buildAndCacheSlots/.test(slotRows),
   '_edgeSlotRows は 15分同期・完全同期からも呼ばれる。ここで作り直すとロックを握り続ける');
ok('①★作り直し → ロック取得 の順になっている',
   pushSlots.indexOf('buildAndCacheSlots()') < pushSlots.indexOf('_edgeLocked'),
   '逆だと重い作り直しのあいだロックを握る');
ok('①作り直しは1回だけ（人数ぶん重くならない）',
   (pushSlots.match(/buildAndCacheSlots\(\)/g) || []).length === 1,
   'buildAndCacheSlots は全トレーナーぶんを1回で作る');
ok('①★作り直しに失敗しても押し出しは続ける',
   /catch \(e\) \{[\s\S]{0,300}?枠を作り直せませんでした/
     .test(PUSH.slice(PUSH.indexOf('function pushToEdgeSlots()'),
                      PUSH.indexOf('var LB_SLOTS_PUSHED_AT_PROP'))),
   '古い枠が出るのは「枠が1つも出ない」より軽い（予約できなくなるのを防ぐ）');
ok('①★15分同期・完全同期は作り直さない',
   !/buildAndCacheSlots/.test(strip(PUSH.slice(PUSH.indexOf('function _pushToEdgeAllImpl'),
                                               PUSH.indexOf('function pushToEdgeAllText')))),
   '二重に重い処理を走らせない');

// ---------- 1-b. ウォームアップと二重にしない ----------
ok('①-b★作りたてならウォームアップを省く',
   /LB_SLOTS_BUILT_AT_PROP/.test(CODE)
   && /ウォームアップ省略/.test(CODE),
   '押し出しも10分ごとに作り直すので、そのままだと二重になる');
ok('①-b★ウォームアップは消さない（押し出しが止まったときの砦）',
   /function warmupCache\(\)/.test(CODE) && /buildAndCacheSlots\(\);/.test(strip(CODE)),
   '消すと、押し出しが止まったときに画面が遅くなる');
ok('①-b記録が読めなければ作り直す（安全側）',
   /catch \(e\) \{ builtAt = 0; \}   \/\/ 読めなければ作り直す/.test(CODE));

// ---------- 2. 何分遅れているか答えられる（測れる） ----------
ok('②★カレンダーを読んだ時刻を残す',
   /LB_SLOTS_BUILT_AT_PROP = 'LB_SLOTS_BUILT_AT'/.test(CODE)
   && /setProperty\(LB_SLOTS_BUILT_AT_PROP, String\(LB_SLOTS_BUILT_AT_LOCAL\)\)/.test(CODE),
   'computed_at は押し出した時刻。これだけでは遅れが分からない');
ok('②時刻は枠を作り終えた直後に残す',
   CODE.indexOf('var slots = buildAvailableSlots();')
     < CODE.indexOf('setProperty(LB_SLOTS_BUILT_AT_PROP'),
   '作る前に残すと、作るのに失敗しても「読んだ」ことになる');
ok('②記録と実行ローカルは同じ値',
   /setProperty\(LB_SLOTS_BUILT_AT_PROP, String\(LB_SLOTS_BUILT_AT_LOCAL\)\)/.test(CODE),
   'ずれると、診断の表示と payload の builtAt が食い違う');
// ---------- 1-c. 送る枠と builtAt が同じスナップショット（関門②の指摘） ----------
//   ★呼び出している行を見る。strip(PUSH) 全体を見ると
//     `function _pushToEdgeSlotsImpl(builtAt, builtSlots) {` という**定義**にも当たり、
//     呼び出しから引数を外しても気づけない（最初の版がそうだった）。
ok('①-c★作った枠そのものを持ち回す',
   /builtSlots = buildAndCacheSlots\(\);/.test(pushSlots)
   && /return _pushToEdgeSlotsImpl\(builtAt, builtSlots\);/.test(pushSlots),
   '読み直すと、キャッシュ保存が失敗していた場合に古い枠へ新しい時刻が付く');
ok('①-c★渡されたらキャッシュを読み直さない',
   /var fresh = \(builtSlots && builtSlots\.length != null\) \? builtSlots : null;/.test(slotRows)
   && /if \(fresh\) \{/.test(slotRows),
   '作り直してからロックを取るまでに warmupCache が上書きし得る');
ok('①-c絞り方は既存と同じ（ふるまいを変えない）',
   /_lbDropClosedSlots\(fresh\.filter\(/.test(slotRows),
   'getCachedSlots のキャッシュ外れ時と同じ：トレーナーで絞る→締切済みを落とす');
ok('①-c渡されなければ従来どおりキャッシュから読む',
   /getTrainerSlots\(\{ trainerId: tid \}\)/.test(slotRows),
   '15分同期・完全同期の経路を変えない');
ok('①-c★時刻はこの実行だけの値を使う',
   /LB_SLOTS_BUILT_AT_LOCAL/.test(CODE) && /builtAt = Number\(LB_SLOTS_BUILT_AT_LOCAL \|\| 0\);/.test(pushSlots),
   'Script Properties は実行をまたぐので、読み直すと別の実行の時刻になる');
ok('①-c★時刻はカレンダーを読み終えた直後に取る',
   CODE.indexOf('var slots = buildAvailableSlots();')
     < CODE.indexOf('LB_SLOTS_BUILT_AT_LOCAL = Date.now();')
   && CODE.indexOf('LB_SLOTS_BUILT_AT_LOCAL = Date.now();')
     < CODE.indexOf('writeToSpreadsheet(slots);'),
   'キャッシュ・公開シートを書いたあとだと「カレンダーを読んだ時刻」ではなくなる');

// ---------- 1-f. 古いスナップショットで巻き戻さない（関門②の指摘） ----------
const sender = strip(PUSH.slice(PUSH.indexOf('function _edgeSendSlots('),
                                PUSH.indexOf('function _pushToEdgeSlotsImpl(')));
//   ★`F` が付くものと付かないものの**両方**を数える（2026-10-11）。
//     最初は `_edgePushRowsF('slots'` だけを数えていて、
//     書き込み直後の `_edgePushRows('slots'` を見逃していた（関門②の指摘）。
ok('①-f★枠を送る経路は1本だけ（Fの有無の両方を数える）',
   (strip(PUSH).match(/_edgePushRows[F]?\('slots'/g) || []).length === 1,
   '別の経路から素のキャッシュを送ると、世代のガードを迂回して巻き戻せる');
ok('①-f★書き込み直後は枠を送らない',
   !/_edgePushSlotsFor/.test(PUSH),
   '確定フローは空き枠を作り直さない（warmupCacheに委ねている）ので、古い枠を押し出し直すだけだった');
//   ★trainerId の有無で判断してはいけない（関門②の指摘）。
//     取消・変更は入力も応答も reservationId だけで trainerId を持たない。
//     有無で判断すると、送っていないのに「同期済み」と名乗ってしまう。
ok('①-f★「枠を変える操作か」で判断する',
   /var _slotsChanged = !!EDGE_CALSYNC_AFTER\[String\(action \|\| ''\)\];/.test(strip(PUSH))
   && /var _syncedSlots = !_slotsChanged;/.test(strip(PUSH)),
   '取消・変更は trainerId を持たないので、有無で判断すると安全側に倒れない');
ok('①-f取消・変更がその集合に入っている',
   /line_cancelReservation: 1, line_changeReservation: 1/.test(PUSH));

// ---------- 1-g. 削除が本当に効く／一部だけ消えない（関門②の指摘） ----------
const IG = rd('worker/src/routes/ingest.js');
const slotsConf = IG.slice(IG.indexOf('  slots: {'), IG.indexOf('  calcContracts: {'));
ok('①-g★slots の keepStale を外した（deleteStale が効くように）',
   !/keepStale: true/.test(slotsConf),
   'keepStale が残ると deleteStale が無視され、退職したトレーナーの枠が永久に残る');
ok('①-g★1人でも組み立てに失敗したら送信ごと中止する',
   /throw new Error\('枠を組み立てられないトレーナーがいます/.test(PUSH)
   && !/\} catch \(e\) \{ continue; \}   \/\/ 1人分が取れなくても他を止めない/.test(PUSH),
   '飛ばすと、失敗しただけのトレーナーの枠が「消えたトレーナー」として消される');
ok('①-g0件なら消さない（受け取る側）',
   /EMPTY_SOURCE/.test(IG));
//   ★'all' ではなく 'partial'（関門②の指摘で2回直した）。
//     付けないと SCOPE_REQUIRED で断られ「合言葉が失敗」と嘘をつく。
//     'all' にすると final と合わさって同期時刻を押し、
//     データを送らないはずの疎通テストが状態を変えてしまう。
ok('①-g★疎通テストは scope:partial（状態を変えない）',
   /kind: 'slots', batchId: Date\.now\(\), rows: \[\], final: true, scope: 'partial'/.test(PUSH),
   "'all' だと同期時刻を押し、本物の枠同期が古いバッチとして断られ得る");
ok('①-f★専用同期が消えたトレーナーの行も落とす',
   /_edgeSendSlots\(builtAt, builtSlots, \{ batchId: Date\.now\(\), deleteStale: true \}\)/.test(strip(PUSH)),
   '枠を送るのはここだけになったので、削除もここの役目');
ok('①-f★新しいものを既に送っていたら送らない',
   /builtAt > 0 && builtAt < last/.test(sender) && /STALE_SNAPSHOT/.test(sender),
   'ロックの外で作るので「作り終えた順」と「ロックを取れた順」は一致しない');
ok('①-f★いつの枠か分からないものでも上書きしない',
   /UNKNOWN_SNAPSHOT/.test(sender));
ok('①-f★世代の記録は**送る前**',
   sender.indexOf('setProperty(LB_SLOTS_LAST_BUILT_PROP') < sender.indexOf("_edgePushRowsF('slots'"),
   'あとに書くと「送れたのに記録に失敗した」ときに、古いものが通る窓が開く');
//   ★順序だけ見ても足りない（2026-10-11）。
//     `if (false) { setProperty(...) }` にしても順序は変わらないので通ってしまった。
//     **条件そのもの**を見る。
ok('①-f★世代の記録が本当に走る（条件を潰していない）',
   /if \(builtAt > 0\) \{\s*\n\s*try \{ PropertiesService\.getScriptProperties\(\)\.setProperty\(LB_SLOTS_LAST_BUILT_PROP/
     .test(PUSH.slice(PUSH.indexOf('function _edgeSendSlots('), PUSH.indexOf('function _pushToEdgeSlotsImpl('))),
   '記録しないまま送ると、次に古いものが通る窓が開く');
ok('①-f★記録できなければ送らない',
   /RECORD_FAILED/.test(sender),
   '送ると次に古いものが通る');
ok('①-f初回（記録なし）は送る',
   /if \(last > 0\) \{/.test(sender),
   '記録が無いのに断ると、一度も枠が入らない');
ok('①-f★15分同期も完全同期も枠を送らない',
   !/step\('slots'/.test(strip(PUSH)),
   'トレーナー別キャッシュを順番に読むので、混ざった集合（一度も実在しなかった状態）になり得る');

// ---------- 1-d. 所要時間を測る（関門②の指摘） ----------
ok('①-d★作り直し・ロック待ち・合計を残す',
   /LB_SLOTS_TIMING/.test(PUSH) && /作り直し=/.test(PUSH) && /ロック待ち＋送信=/.test(PUSH),
   '測らずに「6分に遠い」と言わない');
ok('①-d所要時間を読める', /LB_SLOTS_TIMING/.test(AUDIT));
ok('①-d★分布を測れるようにログにも残す',
   /Logger\.log\('\[edge\] 枠の所要時間 ' \+ _timing\)/.test(PUSH),
   'Property は最後の1回しか残らないので p95・最大を出せない');

// ---------- 1-e. ウォームアップの省略は短く ----------
ok('①-e★省略は30秒まで',
   /var FRESH_MS = 30 \* 1000;/.test(CODE),
   'キャッシュの寿命11分・この関数は10分ごと。5分省くと切れる窓ができて画面が遅くなる');

ok('②★自分が作り直した時刻を使う（記録を読み直さない）',
   /builtAt = Number\(LB_SLOTS_BUILT_AT_LOCAL \|\| 0\);/.test(pushSlots)
   && !/builtAt = Number\(_edgeProp\(LB_SLOTS_BUILT_AT_PROP\)/.test(pushSlots),
   '読み直すと、その間に warmupCache が走ったとき別の実行の時刻を載せてしまう');
ok('②作り直していない経路は記録を読む（事実を隠さない）',
   /builtAtOverride != null && Number\(builtAtOverride\) > 0/.test(slotRows)
   && /_edgeProp\(LB_SLOTS_BUILT_AT_PROP\)/.test(slotRows));
ok('②★payload に builtAt を載せる',
   /builtAt: builtAt/.test(slotRows),
   'D1 側・画面側から「いつのカレンダーか」を見えるようにする');
ok('②computed_at は残す（押し出した時刻として）',
   /computed_at: Date\.now\(\)/.test(slotRows),
   'builtAt と computed_at は別物。置き換えない');
ok('②★押し出せた時刻は成功のときだけ残す',
   sender.indexOf("_edgePushRowsF('slots'") < sender.indexOf('setProperty(LB_SLOTS_PUSHED_AT_PROP'),
   '送る前に残すと「押し出せている」ことになり遅れを見逃す');

// ---------- 3. ぶつかっても捨てない（③を消す） ----------
ok('③★枠の押し出しは長く待つ',
   /_edgeLocked\(function \(\) \{ return _pushToEdgeSlotsImpl\(builtAt, builtSlots\); \}, 90000, 'slots'\)/.test(strip(PUSH)),
   '5秒で諦めると、その回を捨てて次は10分後になる');
ok('③待ち時間の既定は変えない（重い押し出しを長く待たせない）',
   /var wait = \(waitMs == null\) \? 5000 : Number\(waitMs\);/.test(PUSH));
ok('③★見送りを記録する',
   /LB_EDGE_SKIP_PROP = 'LB_EDGE_LOCK_SKIPS'/.test(PUSH)
   && /_edgeRecordLockSkip\(label\);/.test(PUSH),
   'Logger にしか書かないと、毎回見送られていても気づけない');
ok('③見送りには種類が付く',
   /_edgeLocked\(function \(\) \{ return _pushToEdgeAllImpl\(withHome, false\); \}, null, 'all'\)/.test(PUSH)
   && /, null, 'fullSync'\)/.test(PUSH),
   'どの押し出しに負けたのか分からないと直せない');

// ---------- 4. 読める（窓口に繋がっている） ----------
ok('④新しさを出す関数がある', /function slotsFreshnessText\(\)/.test(AUDIT));
ok('④★既存の窓口に繋がっている',
   /if \(args && args\.slotsFresh\) return _ejScrub\(slotsFreshnessText\(\)\);/.test(JOB),
   '新しい op を足すと許可一覧3箇所の更新がオーナー作業になる');
ok('④3つとも出す（作った時刻・押した時刻・見送り）',
   /LB_SLOTS_BUILT_AT/.test(AUDIT) && /LB_SLOTS_PUSHED_AT/.test(AUDIT)
   && /LB_EDGE_LOCK_SKIPS/.test(AUDIT));
ok('④★「記録なし」を「新しい」と見せない',
   /★記録なし/.test(AUDIT),
   '0 を「たったいま」と表示すると、反映されていないことを隠す');
ok('④★作った時刻が押した時刻より古いことを指摘する',
   /ぶん古いカレンダーを押し出している/.test(AUDIT),
   '作り直しに失敗して前のキャッシュを押し出した状態を見分ける');

// ---------- 5. 退行しない ----------
ok('⑤枠の押し出しは全消ししない',
   /deleteStale: !!opts\.deleteStale/.test(PUSH),
   'deleteStale を true にすると、一時的に0件のときに全部消える');
ok('⑤キャッシュの保持時間は変えていない',
   /CACHE_SECONDS:\s*660/.test(CODE),
   '画面の速さはこのキャッシュで出ている。短くすると画面が遅くなる');

console.log(`${fail ? '❌' : '✅'} 出勤枠の新しさ 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
