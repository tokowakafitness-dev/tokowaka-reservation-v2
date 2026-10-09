// 会員ごとの世代（段階3-b 手順1）— 実際のSQLiteで文を走らせて確かめる
//
//   ★なぜ本物のSQLiteで回すのか
//     この仕組みの正しさは**SQLの意味**にある（+1・MAX・行が無いとき）。
//     文字列を正規表現で見るだけでは「MAX と書いてある」しか分からない。
//     巻き戻しが本当に起きないかは、走らせないと分からない。
//
//   ★なぜ巻き戻しが怖いのか
//     built_version を古い値で上書きすると、新しい行を「古い」と判定し続ける。
//     顧客にはいつまでも写し（15分遅れ）が出る。壊れたことに誰も気づかない。
//
//   実行: node worker/test/sync-version.test.js

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  affectsQuotaInput, affectsQuotaInputGlobally, isFresh,
  bumpSourceStatement, bumpAllSourceStatement, markBuiltStatement,
  QUOTA_INPUT_KINDS,
} from '../src/lib/sync-version.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- SQLite を動かす小さな土台 ----------
const DIR = mkdtempSync(join(tmpdir(), 'csv-'));
const DB = join(DIR, 't.db');
const MIG = readFileSync(join(ROOT, 'worker/migrations/0014_customer_sync_version.sql'), 'utf8');
//   0016 で足した2列（書いた行数）も当てる。**migration のファイルから読む**
//   （テストの中に列を書き写すと、本物とずれても気づけない）。
const MIG16 = readFileSync(join(ROOT, 'worker/migrations/0016_row_generation.sql'), 'utf8')
  .split('\n').filter((l) => /^ALTER TABLE customer_sync_version/.test(l)).join('\n');

function sql(text) {
  return execFileSync('sqlite3', [DB], { input: text, encoding: 'utf8' });
}
//   文の ? に値を入れる（テスト専用。文字列は '' で囲む）
function fill(st) {
  let i = 0;
  return st.sql.replace(/\?/g, () => {
    const v = st.args[i++];
    return (typeof v === 'number') ? String(v) : `'${String(v).replace(/'/g, "''")}'`;
  }) + ';';
}
function row(cid) {
  const out = sql(`SELECT source_version, built_version FROM customer_sync_version WHERE customer_id='${cid}';`).trim();
  if (!out) return null;
  const [s, b] = out.split('|').map(Number);
  return { sourceVersion: s, builtVersion: b, exists: true };
}
function reset() {
  sql('DROP TABLE IF EXISTS customer_sync_version;');
  sql(MIG);
  sql(MIG16);
}

reset();
ok('0016 の列を当てられた（migration から読んでいる）', MIG16.split('\n').length === 4, MIG16);
ok('表が作れる', sql("SELECT name FROM sqlite_master WHERE name='customer_sync_version';").trim() === 'customer_sync_version');

// ---------- 1. 入力が書かれるたびに進む ----------
sql(fill(bumpSourceStatement('C1', 1000)));
ok('①はじめは 1 から（0 にしない）', row('C1').sourceVersion === 1,
   '0 のままだと built の既定値 0 と一致し「新しい」と誤判定する');
sql(fill(bumpSourceStatement('C1', 2000)));
sql(fill(bumpSourceStatement('C1', 3000)));
ok('①書かれた回数ぶん進む', row('C1').sourceVersion === 3);
ok('①作り直す前は答えない', isFresh(row('C1')) === false);

// ---------- 2. 作り直したら一致する ----------
sql(fill(markBuiltStatement('C1', 3, 4000)));
ok('②作り直しを取り込むと一致する', isFresh(row('C1')) === true);

// ---------- 3. 同じ世代から2回書いても巻き戻らない（MAX が残っている意味）----------
//   ★「古い世代で上書き」の場面は 6-b に移した。
//     いまの markBuiltStatement は、いまの source と自分が読んだ世代が違えば
//     built を 0 に落とす。だから「3 のまま残る」のではなく「0 に落ちる」が正しい。
sql(fill(markBuiltStatement('C1', 3, 5000)));
ok('③同じ世代から2回書いても一致したまま', isFresh(row('C1')) === true && row('C1').builtVersion === 3);

// ---------- 4. 作り直しの最中に入力が来たら、答えない ----------
reset();
sql(fill(bumpSourceStatement('C2', 1000)));
const ver0 = row('C2').sourceVersion;          // 作り直しが読んだ世代
sql(fill(bumpSourceStatement('C2', 1500)));    // ★作り直している最中に押し出しが来た
sql(fill(markBuiltStatement('C2', ver0, 2000)));
ok('④途中で入力が来たら一致しない', isFresh(row('C2')) === false,
   `source=${row('C2').sourceVersion} built=${row('C2').builtVersion}`);
ok('④次の作り直しで追いつく', (() => {
  const v = row('C2').sourceVersion;
  sql(fill(markBuiltStatement('C2', v, 3000)));
  return isFresh(row('C2')) === true;
})());

// ---------- 5. 行が無い会員 ----------
reset();
ok('⑤行が無ければ答えない', isFresh({ sourceVersion: 0, builtVersion: 0, exists: false }) === false,
   '「まだ一度も作り直していない」を 0===0 で「新しい」と扱うと、枠が無い会員に0回と答える');
//   作り直しが先に走った会員（押し出しの前）。行はできるが built=0 なので答えない。
sql(fill(markBuiltStatement('C3', 0, 1000)));
ok('⑤作り直しが先でも答えない（built=0）', isFresh(row('C3')) === false);
sql(fill(bumpSourceStatement('C3', 2000)));
ok('⑤そのあと入力が来れば遅れとして見える', row('C3').sourceVersion === 1 && row('C3').builtVersion === 0);

// ---------- 6. 会員で分かれていない入力（契約表の列の並び）----------
reset();
sql(fill(bumpSourceStatement('A', 1000)));
sql(fill(bumpSourceStatement('B', 1000)));
sql(fill(markBuiltStatement('A', 1, 1100)));
sql(fill(markBuiltStatement('B', 1, 1100)));
ok('⑥まず全員が一致している', isFresh(row('A')) && isFresh(row('B')));
sql(fill(bumpAllSourceStatement(2000)));
ok('⑥★全員ぶんの入力が変わると全員が遅れになる',
   !isFresh(row('A')) && !isFresh(row('B')),
   '契約表の列の並びが変わると全員の計算が変わる。1人ずつでは拾えない');

// ---------- 6-b. ★作り直しが2本走り、古い方が後に書き終わる ----------
//   Codex関門②の指摘。MAX だけでは防げない形。
//     A が世代10を読む → 入力が来て11 → B が11を読んで枠を書き built=11 →
//     A が古い枠で上書き → 印が11のままだと「行は世代10の内容なのに新しい」と見える。
//   直し方：markBuiltStatement が **batch の中で** いまの source と自分が読んだ世代を比べ、
//           違えば built を 0 に落とす（＝最後に枠を書いた方の世代が印として残る）。

//   場面1：B（新しい）→ A（古い）の順で書き終わる
reset();
sql(fill(bumpSourceStatement('D', 1000)));                   // source=1 … Aが読む世代
const aVer = row('D').sourceVersion;
sql(fill(bumpSourceStatement('D', 1100)));                   // source=2 … 入力が来た
const bVer = row('D').sourceVersion;
sql(fill(markBuiltStatement('D', bVer, 1200)));              // Bが新しい枠を書いた
ok('⑥-b Bが書いた時点では答えてよい', isFresh(row('D')) === true);
sql(fill(markBuiltStatement('D', aVer, 1300)));              // ★Aが古い枠で上書きした
ok('⑥-b★古い方が後に書き終わったら答えない',
   isFresh(row('D')) === false && row('D').builtVersion === 0,
   `built=${row('D').builtVersion}。行は古い世代の内容なので、写しへ落とすのが正しい`);

//   場面2：A（古い）→ B（新しい）の順で書き終わる
reset();
sql(fill(bumpSourceStatement('F', 1000)));
const aVer2 = row('F').sourceVersion;
sql(fill(bumpSourceStatement('F', 1100)));
const bVer2 = row('F').sourceVersion;
sql(fill(markBuiltStatement('F', aVer2, 1200)));             // Aが古い枠を書いた
ok('⑥-b Aが書いた時点では答えない', isFresh(row('F')) === false);
sql(fill(markBuiltStatement('F', bVer2, 1300)));             // Bが新しい枠で上書きした
ok('⑥-b★新しい方が後に書き終わったら答えてよい',
   isFresh(row('F')) === true && row('F').builtVersion === bVer2,
   '0に落ちたままだと、正しい枠があるのに永久に写しへ落ちる');

//   場面3：同じ世代から2本が作り直した（巻き戻さない＝MAX が残っている意味）
reset();
sql(fill(bumpSourceStatement('G', 1000)));
sql(fill(markBuiltStatement('G', 1, 1200)));
sql(fill(markBuiltStatement('G', 1, 1300)));
ok('⑥-b 同じ世代から2本でも答えてよい', isFresh(row('G')) === true);

//   場面4：作り直している最中に入力が来た（同時に2本でなくても倒れる）
reset();
sql(fill(bumpSourceStatement('H', 1000)));
const hVer = row('H').sourceVersion;
sql(fill(bumpSourceStatement('H', 1100)));                   // ★作り直しの最中に押し出し
sql(fill(markBuiltStatement('H', hVer, 1200)));
ok('⑥-b 途中で入力が来たら答えない', isFresh(row('H')) === false);
ok('⑥-b 次の作り直しで追いつく', (() => {
  sql(fill(markBuiltStatement('H', row('H').sourceVersion, 1300)));
  return isFresh(row('H')) === true;
})());

//   ★この判定が本当に効いているかを、壊して確かめる（2026-10-08の教訓）。
//     CASE を外して MAX だけに戻したら、場面1で「新しい」と見えるはずである。
{
  reset();
  sql(fill(bumpSourceStatement('I', 1000)));
  sql(fill(bumpSourceStatement('I', 1100)));
  sql(fill(markBuiltStatement('I', 2, 1200)));               // B
  const st = markBuiltStatement('I', 1, 1300);               // A（古い）
  const broken = st.sql.replace(
    /built_version = CASE[\s\S]*?END,/,
    'built_version = MAX(customer_sync_version.built_version, excluded.built_version),');
  ok('⑥-b★壊し方が成立している（文が変わった）', broken !== st.sql);
  sql(fill({ sql: broken, args: st.args }));
  ok('⑥-b★CASE を外すと実際に誤って「新しい」と見える（＝判定は効いている）',
     isFresh(row('I')) === true && row('I').builtVersion === 2,
     `壊した結果 built=${row('I').builtVersion}。0 のままならこの検査は何も見ていない`);
}

//   ★built_at は巻き戻さない（古い作り直しの終了時刻を「最後に作り直した時刻」にしない）
reset();
sql(fill(bumpSourceStatement('E', 1000)));
sql(fill(bumpSourceStatement('E', 1000)));
sql(fill(markBuiltStatement('E', 2, 5000)));
sql(fill(markBuiltStatement('E', 1, 9000)));
ok('⑥-b★古い作り直しで built_at が動かない',
   sql("SELECT built_at FROM customer_sync_version WHERE customer_id='E';").trim() === '5000',
   '診断の時刻が古いビルドの終了時刻になると、原因を追うときに嘘をつく');

// ---------- 7. どの表を数えるか（loadCalcInput と1対1）----------
{
  const CALC = readFileSync(join(ROOT, 'worker/src/calc.js'), 'utf8');
  //   loadCalcInput が読んでいる表を、世代の対象と突き合わせる。
  //   ★増やしすぎると source>built が常態化してD1から答えられない。
  //     入れ忘れると古い値を顧客に出す。どちらも害がある。
  ok('⑦契約の行を数える', affectsQuotaInput('calcContracts') && /FROM calc_contract_rows/.test(CALC));
  ok('⑦予約の行を数える', affectsQuotaInput('calcReservations') && /FROM calc_reservation_rows/.test(CALC));
  ok('⑦棚卸しを数える', affectsQuotaInput('opening') && /FROM member_opening/.test(CALC));
  ok('⑦列の並びは全員ぶんとして数える',
     affectsQuotaInputGlobally('calcMeta') && !affectsQuotaInput('calcMeta') && /FROM calc_meta/.test(CALC));
  ok('⑦★計算に関わらない表は数えない',
     !affectsQuotaInput('home') && !affectsQuotaInput('reservations')
     && !affectsQuotaInput('body') && !affectsQuotaInput('slots'),
     '残数の写しや体組成で世代を進めると、いつまでもD1から答えられない');
  ok('⑦対象は3つだけ', Object.keys(QUOTA_INPUT_KINDS).length === 3);
}

// ---------- 8. 取り込み側の組み込み ----------
{
  const IG = readFileSync(join(ROOT, 'worker/src/routes/ingest.js'), 'utf8');
  ok('⑧★行の書き込みと同じ batch に入れる',
     /stmts\.push\(env\.DB\.prepare\(st\.sql\)\.bind\(\.\.\.st\.args\)\)/.test(IG),
     '別の batch にすると「行は書けたが世代は増えていない」状態が残る');
  ok('⑧実際に書いた行だけ数える',
     /if \(!full && !replaceCustomer && same\(r, existing\[String\(key\)\]\)\) continue;   \/\/ 書かなかった行/.test(IG));
  ok('⑧★scope:customer は0件でも進める',
     /if \(replaceCustomer && onlyCustomer\) touched\[onlyCustomer\] = 1;/.test(IG),
     '全件取り消された状態は正常。送られてこないこと自体が入力の変化');
  ok('⑧★written を stmts.length で数えない',
     /written = rowStmtCount;/.test(IG) && !/written = stmts\.length;/.test(IG),
     '世代の文と削除の文が混ざるので、報告が行数とずれる');
  ok('⑧削除はいちばん最後に積む（removed の読み取りが狂わない）',
     IG.indexOf('bumpSourceStatement(cid, nowMs)') < IG.indexOf('DELETE FROM ${conf.table}'));
  ok('⑧件数を報告に出す', /bumped, bumpedStale, mode: full/.test(IG));
}

// ---------- 8-b. ★完全同期で消される行の会員も進める ----------
{
  const IG = readFileSync(join(ROOT, 'worker/src/routes/ingest.js'), 'utf8');
  const GAS = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  //   ★前提を機械で確かめる：計算の入力は本当に deleteStale で押されているか。
  //     押されていないなら、この手当ては要らない（＝この検査の根拠が消える）。
  ok('⑧-b★計算の入力は完全同期で押されている',
     /_edgePushRowsF\('calcContracts', cr, batchId, \{ scope: 'all', deleteStale: full \}\)/.test(GAS)
     && /_edgePushRowsF\('calcReservations', _edgeCalcReservations\(\), batchId, \{ scope: 'all', deleteStale: full \}\)/.test(GAS)
     && /_edgePushRowsF\('opening', _edgeOpening\(customers\), batchId, \{ scope: 'all', deleteStale: full \}\)/.test(GAS),
     'ここが変わったら、下の手当ての前提が崩れる');
  //   ★SQL文の字面だけを見ると、条件（affectsQuotaInput）が死んでも通ってしまう。
  //     実際に `if (false)` へ書き換えたら落ちなかった。条件ごと見る。
  ok('⑧-b★計算の入力のときだけ数える（条件ごと見る）',
     /if \(affectsQuotaInput\(kind\)\) \{\n\s*try \{\n\s*const r = await env\.DB\.prepare\(\n\s*`SELECT DISTINCT customer_id FROM/.test(IG),
     '条件が死ぬと、関係ない表の押し出しで全員の世代が進み、永久にD1から答えられない');
  ok('⑧-b★消される行の会員を先に数える',
     /SELECT DISTINCT customer_id FROM \$\{conf\.table\}\n\s*WHERE \(synced_at IS NULL OR synced_at < \?\) AND customer_id IS NOT NULL/.test(IG),
     '送られてこなかった会員は touched に入らない＝入力が変わったのに世代が進まない');
  ok('⑧-b★消す文と同じ batch に入れる',
     /env\.DB\.batch\(sts\.concat\(\[delStmt\]\)\)/.test(IG));
  ok('⑧-b 削除件数は最後の文から読む（世代の文を数えない）',
     /const res = await env\.DB\.batch\(sts\.concat\(\[delStmt\]\)\);\n\s*const last = res && res\[res\.length - 1\];/.test(IG));
  //   ★読めなかったときに消すと、修正前と同じ穴に戻る（Codex関門②の2周目）。
  //     「消せなかった」＝古い入力が残る＝写しへ落ちるだけ。
  //     「世代を進めずに消した」＝古い枠を新しいと答える＝顧客に誤った残数。
  ok('⑧-b★読めなければ消さずに帰る',
     /skippedDelete: 'STALE_IDS_READ_FAILED'/.test(IG)
     && IG.indexOf("STALE_IDS_READ_FAILED") < IG.indexOf('if (staleIds.length) {'),
     '削除だけ通ると、入力は消えたのに世代が進まない');
  ok('⑧-b★そのとき同期時刻も押さない',
     !/STALE_IDS_READ_FAILED[\s\S]{0,200}stampSync/.test(IG),
     '押すと古い行が「たったいま同期した」顔になる');
  ok('⑧-b 件数を報告に出す', /bumpedStale, mode: full/.test(IG));
}

// ---------- 9. 作り直し側の組み込み ----------
{
  const Q = readFileSync(join(ROOT, 'worker/src/routes/quota.js'), 'utf8');
  ok('⑨★世代は入力を読む前に取る',
     Q.indexOf('readSyncVersion(env, cid)') < Q.indexOf('loadCalcInput(env, cid)'),
     'あとに取ると、途中で来た変更を取り込んだことにしてしまう');
  ok('⑨★引当も作ったときだけ世代を書く',
     /if \(withAlloc\) \{[\s\S]{0,400}?const mk = markBuiltStatement/.test(Q),
     '枠だけ作り直すと used が古い。それを「新しい」と記録すると誤った残数を答える');
  //   ★それだけでは足りない（2026-10-09・設計13）。行にも世代の印を付けるので、
  //     alloc=0 での**書き込みそのものを禁じる**。
  ok('⑨★書くなら引当も作る（枠だけの書き込みを弾く）',
     /if \(!dry && !withAlloc\) \{/.test(Q) && /ALLOC_REQUIRED/.test(Q));
  ok('⑨★書いた行数も記録する（枠とパックを別々に）',
     /quotaRows: built\.monthly\.length, packRows: built\.packs\.length/.test(Q),
     '行に世代を書き忘れたとき「契約なし」と答えてしまう穴を塞ぐ');
  //   ★どの範囲で作ったかも残す（2026-10-09・関門②の2周目）。
  //     照合が主キーの集合を突き合わせるのに要る。範囲は会員ごと・実行ごとに違うので、
  //     保存しないと照合側が推測するしかなく、正しい行を「欠けている」と誤判定する。
  ok('⑨★作った範囲も残す', /fromMonth: from, toMonth: to,/.test(Q));
  {
    const SV = readFileSync(join(ROOT, 'worker/src/lib/sync-version.js'), 'utf8');
    ok('⑨範囲を書く文がある', /built_from_month, built_to_month/.test(SV));
    ok('⑨★競合で倒すときは範囲も NULL に',
       /built_from_month = CASE[\s\S]{0,160}ELSE NULL END/.test(SV)
       && /built_to_month = CASE[\s\S]{0,160}ELSE NULL END/.test(SV));
    ok('⑨読むときも範囲を返す', /fromMonth: r\.built_from_month == null \? null : String\(r\.built_from_month\)/.test(SV));
  }
  ok('⑨枠と同じ batch に入れる', /stmts\.push\(\{ sql: mk\.sql, args: mk\.args \}\)/.test(Q));
  ok('⑨書けてから数える', /summary\.wrote \+= stmts\.length;\n[\s\S]{0,260}if \(withAlloc\) summary\.marked/.test(Q));
  ok('⑨確かめ用に遅れを出す', /source_version > built_version/.test(Q) && /syncVersion,/.test(Q));
  ok('⑨★あってはならない向き（built > source）も数える', /built_version > source_version THEN 1/.test(Q),
     '巻き戻しやバグの印。0でなければ何かが壊れている');
  ok('⑨表が無くても落ちない', /table: 'missing'/.test(Q));
  //   ★Codex関門②の2周目：batch の外で倒す作りは捨てた（窓が開く・正しい方を倒す）
  ok('⑨★書いたあとに倒す作りを残していない',
     !/forceStale/.test(Q) && !/readSyncVersion\(env, cid\);[\s\S]{0,400}ver1/.test(Q),
     'batch が終わってから倒すまでに窓が開く。その間にWorkerが終われば誤った印が残る');
  ok('⑨判定は batch の中（markBuiltStatement）に任せている',
     /markBuiltStatement が batch の中で判定/.test(Q));
}

rmSync(DIR, { recursive: true, force: true });
console.log(`\n${fail ? '❌' : '✅'} 会員ごとの世代 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
