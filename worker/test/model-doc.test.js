// 地図（ops/MODEL.md）が事実と合っているか
//
//   ★なぜ要るのか
//     古い地図は、無いより悪い。「読んだのに違っていた」は、読まないより危険。
//     だから地図に書いた事実のうち、**機械で確かめられるものは全部確かめる。**
//
//   ★ここで落ちたときの直し方
//     コードが正しければ**地図を直す**。地図が正しければコードを直す。
//     どちらが正しいかは、地図の「なぜ」の記述で判断する。
//
//   実行: node worker/test/model-doc.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readdirSync } from 'node:fs';
import { buildQuotaForCustomer } from '../src/lib/quota-build.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const DOC = readFileSync(join(ROOT, 'ops/MODEL.md'), 'utf8');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. トリガーは4本だけ（地図の§2-4）----------
{
  const migs = readdirSync(join(ROOT, 'worker/migrations')).filter((f) => f.endsWith('.sql'));
  let trg = [];
  for (const f of migs) {
    const m = rd(`worker/migrations/${f}`).match(/CREATE TRIGGER IF NOT EXISTS (\w+)/g) || [];
    trg = trg.concat(m.map((x) => x.replace(/.*EXISTS /, '')));
  }
  ok('①トリガーは4本だけ', trg.length === 4, `実際=${trg.length}本: ${trg.join(', ')}`);
  for (const t of trg) {
    ok(`①地図に ${t} が載っている`, DOC.indexOf(t) >= 0);
  }
  //   ★INSERT/DELETE だけに反応する（UPDATE に反応しない）＝地図の記述の根拠
  let onUpdate = 0;
  for (const f of migs) {
    const src = rd(`worker/migrations/${f}`);
    onUpdate += (src.match(/CREATE TRIGGER[\s\S]{0,120}AFTER UPDATE ON reservation_allocations/g) || []).length;
  }
  ok('①★トリガーは UPDATE に反応しない', onUpdate === 0,
     '地図は「built_version の UPDATE はトリガーを引かない」と書いている');
}

// ---------- 2. 語彙表（地図の§4）----------
{
  const PUSH = rd('gas/PushToEdge.js');
  ok('②★confirmed → booked の変換が実在する',
     /\(st === 'confirmed'\) \? 'booked'/.test(PUSH),
     '地図の語彙表の根拠。ここが変わったら地図も直す');
  ok('②consumed はそのまま', /\(st === 'consumed'\)\s*\? 'consumed'/.test(PUSH));
  ok('②★D1を読むときは D1 の語彙で数えている',
     /status IN \('booked', 'consumed'\)/.test(rd('worker/src/lib/remain-from-d1.js')));
  ok('②地図に語彙表がある', /\| 予約が有効 \| `confirmed` \| \*\*`booked`\*\*/.test(DOC));
}

// ---------- 3. pack_id の合成（地図の§4・いちばん危うい）----------
{
  const AL = rd('worker/src/allocate.js');
  //   ★字面ではなく**合成の式そのもの**を見る（2026-10-09・Codexの指摘）。
  //     「packId と idx がある」だけでは、開始日・終了日・行番号から作っていることを
  //     何も保証しない。
  ok('③★合成の式が「開始・終了・行番号」であることを式で確かめる',
     /packId = 'CT' \+ \(startMs \|\| 0\) \+ '_' \+ endMs \+ '_' \+ \(\(rr\.idx != null\) \? rr\.idx : i\);/.test(AL),
     '地図の §4 の記述の根拠。ここが変わったら地図も直す');
  //   ★2026-10-09 に実態を確定した（LB_STRICT_ID_MODE の既定が off）。
  //     地図が「未確認」ではなく**確定した事実**を書いていることを縛る。
  const LB2 = rd('gas/LineBooking.js');
  ok('③★strict モードの既定が off である（地図の根拠）',
     /getProperty\('LB_STRICT_ID_MODE'\) \|\| ''\) === 'on'/.test(LB2),
     'on のときだけ pack_id 列を読む＝既定では必ず合成する');
  ok('③★pack_id 列は strict のときだけ読む',
     /packId: strict \? find\('pack_id'\) : -1/.test(LB2));
  ok('③地図が「いま本番は合成IDを使っている」と書いている',
     /いま本番は合成IDを使っている/.test(DOC));
  ok('③★地図が合成の形を書いている',
     /'CT' \+ 開始日のms \+ '_' \+ 終了日のms \+ '_' \+ シートの行の番号/.test(DOC));
  ok('③★地図が「読まない方式で救われる理由」と「残る危険」を両方書いている',
     /IDが変わっても、読む値は整合する/.test(DOC) && /それでも残る危険/.test(DOC),
     '救われる理由だけ書くと、残る危険を忘れる');
  //   ★「前方一致」ではなく「末尾の '_行番号' を除いた値の完全一致」（Codexの指摘で訂正）
  ok('③末尾を落とす関数が実在する',
     /function _lbPackPrefix\(packId\)/.test(AL) && /replace\(\/_\\d\+\$\/, ''\)/.test(AL));
  ok('③★地図が「前方一致ではない」と書いている',
     /「前方一致（startsWith）」ではない/.test(DOC));
  //   ★棚卸しの解決ブロックが、実際にその関数を使っているか（存在だけ見ない）
  const QB = rd('worker/src/lib/quota-build.js');
  ok('③★棚卸しの解決が末尾除去を使っている',
     /_lbPackPrefix/.test(QB) && /OPENING_PACK_UNRESOLVED/.test(QB),
     '関数があることと、使われていることは別');
  ok('③完全一致を先に試している', /完全一致/.test(QB) || /exact/i.test(QB));
}

// ---------- 3-b. ★実際に動かして確かめる（字面ではなく挙動）----------
//   地図は「日付を直すと棚卸しの照合が切れ、**その会員の作り直しが止まる**」と書いている。
//   （「チケットが復活する」と書いていたのは誤りで、2026-10-09 に訂正した）
//   ★本当に止まるのかを、実際に呼んで確かめる。
{
  const COLS = { name: 1, type: 2, course: -1, freq: 8, ticket: 6, start: 10, end: 11,
                 carry: -1, carryCap: -1, phone: 15, method: 16, trainer: 3,
                 custId: -1, ticketPrice: -1, packId: -1, normalPrice: -1 };
  const jst = (y, m, d) => Date.UTC(y, m - 1, d, -9, 0);
  const crow = (method, type, ticket) => {
    const r = new Array(23).fill('');
    r[COLS.name] = '◯◯ ◯◯様'; r[COLS.type] = type; r[COLS.method] = method;
    if (ticket != null) r[COLS.ticket] = ticket;
    return r;
  };
  const ticketRow = (startY, startM, startD, endY, endM, endD, idx) => ({
    row: crow('チケット', 'チケット', 3), cols: COLS,
    start: new Date(jst(startY, startM, startD)), end: new Date(jst(endY, endM, endD)), idx,
  });
  const OPTS = { fromMonth: '2026-09', toMonth: '2026-11', nowKey: '2026-10',
                 targetDateMs: jst(2026, 10, 15), carryRate: 0.5 };

  //   ① まず、いまの契約で pack_id がどう作られるかを見る
  const base = buildQuotaForCustomer('CM1', [ticketRow(2026, 9, 15, 2026, 12, 15, 1)], [], null, OPTS);
  ok('③-b パックが1つできる', base.packs.length === 1, JSON.stringify(base.issues));
  const pid = String(base.packs[0].packId);
  ok('③-b★合成IDの形（CT…_…_行番号）', /^CT\d+_\d+_1$/.test(pid), pid);

  //   ② 行番号だけがずれた場合 → 末尾を落とせば一致する（棚卸しは解決する）
  const moved = buildQuotaForCustomer('CM1', [ticketRow(2026, 9, 15, 2026, 12, 15, 7)], [],
                                      { packsUsed: { [pid]: 1 } }, OPTS);
  ok('③-b★行番号がずれても棚卸しは解決する',
     moved.issues.filter((x) => x.code === 'OPENING_PACK_UNRESOLVED').length === 0,
     JSON.stringify(moved.issues));
  ok('③-b そのとき使った枚数が引き継がれる',
     moved.packs.length === 1 && Number(moved.packs[0].openingUsed) === 1,
     JSON.stringify(moved.packs));

  //   ③ ★開始日を直した場合 → 照合が切れる → **問題として出る（止まる）**
  const dated = buildQuotaForCustomer('CM1', [ticketRow(2026, 9, 20, 2026, 12, 15, 1)], [],
                                      { packsUsed: { [pid]: 1 } }, OPTS);
  ok('③-b★日付を直すと棚卸しの照合が切れる',
     dated.issues.some((x) => x.code === 'OPENING_PACK_UNRESOLVED'),
     JSON.stringify(dated.issues));
  //   ★問題が1件でもあれば、その会員は何も書かない（I5）＝止まる。
  //     「チケットが復活する」のではない。地図の記述の根拠。
  ok('③-b★地図が「止まる」と書いている（復活ではない）',
     /その会員のD1の作り直しは止まる/.test(DOC)
     && /「開始日を直すとチケットが復活する」は誤り/.test(DOC));
  ok('③-b 書かない判断が実装にある',
     /if \(!dry && \(built\.issues\.length \|\| allocIssues\.length\)\)/.test(rd('worker/src/routes/quota.js')));

  //   ④ ★同じ日付のパックが2つある会員では、末尾除去の候補が複数になる
  const twin = buildQuotaForCustomer('CM1', [
    ticketRow(2026, 9, 15, 2026, 12, 15, 1),
    ticketRow(2026, 9, 15, 2026, 12, 15, 2),
  ], [], { packsUsed: { [pid]: 1 } }, OPTS);
  //   完全一致が1つあるので解決はする。ただし地図はこの形を合格条件で禁じている
  ok('③-b★地図が「同じ開始・終了のpackが複数ない」を合格条件にしている',
     /同じ会員の中に、同じ 'CT<開始>_<終了>' のpackが\*\*複数ない\*\*/.test(DOC),
     `双子のとき: ${JSON.stringify(twin.issues)}`);
}

// ---------- 4. 読み取りの契約（地図の§5）----------
{
  const BOOT = rd('worker/src/routes/boot.js');
  //   readHome が null を返す6つの理由が、地図と実装で一致しているか
  const want = ['no_customer', 'no_row', 'bad_json', 'month_missing', 'bad_shape', 'no_computed_at'];
  for (const w of want) {
    ok(`④readHome の '${w}' が実装にある`, BOOT.indexOf(`'${w}'`) >= 0);
    ok(`④地図に '${w}' が載っている`, DOC.indexOf(w) >= 0);
  }
  //   ★後から足される4つ
  ok('④★付帯情報は4つ', /\{ \.\.\.home, month, computedAt, stale: age > HOME_TTL_WARN_MS, ageMs: age \}/.test(BOOT));
  ok('④地図が「比べるときは除く」と書いている',
     /`month` \/ `computedAt` \/ `stale` \/ `ageMs`/.test(DOC) || /month` \/ `computedAt`/.test(DOC));
  //   shadow が実際にその4つを除いている
  const SH = rd('worker/src/lib/remain-shadow.js');
  ok('④★shadow がその4つを除いている',
     /export const SKIP_FIELDS = \['computedAt', 'stale', 'ageMs', 'month'\];/.test(SH));
}
{
  const RF = rd('worker/src/lib/remain-from-d1.js');
  const want = ['no_customer', 'out_of_range', 'no_version_row', 'not_built', 'behind',
                'read_failed', 'version_changed', 'row_count_missing', 'row_count_mismatch',
                'coverage_missing', 'base_freq_missing'];
  for (const w of want) {
    ok(`④readRemainDiag の '${w}' が実装にある`, RF.indexOf(`'${w}'`) >= 0, w);
  }
  ok('④★地図の一覧と実装がそろっている',
     want.every((w) => DOC.indexOf(w) >= 0),
     `地図に無い: ${want.filter((w) => DOC.indexOf(w) < 0).join(', ')}`);
}

// ---------- 5. 不変条件の台帳（地図の§3）----------
{
  //   ★表のすべての行に「守っている検査」が書かれているか（空欄を許さない）
  const lines = DOC.split('\n').filter((l) => /^\| I\d+ \|/.test(l));
  ok('⑤不変条件が表になっている', lines.length >= 10, `${lines.length}件`);
  const noTest = lines.filter((l) => {
    const cells = l.split('|').map((x) => x.trim());
    const last = cells[cells.length - 2] || '';
    return last === '' || last === '—';
  });
  //   ★I15（機密）だけは検査を書けない（人の運用）。それ以外は必須。
  ok('⑤★検査が紐付いていない不変条件は1つだけ（機密の運用）',
     noTest.length <= 1,
     `空欄: ${noTest.map((l) => l.split('|')[1].trim()).join(', ')}`);

  //   紐付けたテストファイルが実在するか
  const files = (DOC.match(/`([a-z0-9-]+\.test\.js)`/g) || []).map((x) => x.replace(/`/g, ''));
  const have = new Set(readdirSync(join(ROOT, 'worker/test')));
  const missing = [...new Set(files)].filter((f) => !have.has(f));
  ok('⑤★紐付けた検査のファイルが実在する', missing.length === 0, `無い: ${missing.join(', ')}`);
}

// ---------- 6. 入口の表（地図の§6）----------
{
  const COMPAT = rd('worker/src/routes/compat.js');
  const SLOTS = rd('worker/src/routes/slots.js');
  const BOOT = rd('worker/src/routes/boot.js');
  ok('⑥shadow の対象は3入口', /entry: 'boot'/.test(BOOT)
     && /entry: 'compat_member'/.test(COMPAT) && /entry: 'compat_home'/.test(COMPAT));
  const bo = COMPAT.slice(COMPAT.indexOf('export async function compatBookingOptions'));
  ok('⑥★候補を選ぶ経路は対象外', !/shadow: true/.test(bo.slice(0, 2000)) && !/shadow: true/.test(SLOTS));
  ok('⑥地図に入口の表がある', /compatBookingOptions/.test(DOC) && /候補を選び直すたび/.test(DOC));
  //   ★ctx は全handlerに渡る（地図の記述の根拠）
  ok('⑥★ctx が全handlerに渡っている',
     /handler\(\{ body, env, ctx, who, lineUserId: auth\.lineUserId \}\)/.test(rd('worker/src/index.js')),
     '「ctx があるから比べる」にしてはいけない理由');
}

// ---------- 7. 世代を進める表（地図の§2-2）----------
{
  const SV = rd('worker/src/lib/sync-version.js');
  const CALC = rd('worker/src/calc.js');
  for (const k of ['calcContracts', 'calcReservations', 'opening']) {
    ok(`⑦'${k}' が世代の対象`, new RegExp(`${k}: 1`).test(SV));
  }
  ok('⑦calcMeta は全員ぶん', /calcMeta: 1/.test(SV) && /QUOTA_INPUT_GLOBAL_KINDS/.test(SV));
  ok('⑦★計算の入力は4つだけ',
     (CALC.match(/FROM calc_meta|FROM calc_contract_rows|FROM calc_reservation_rows|FROM member_opening/g) || []).length === 4,
     '地図の§2-2 と1対1');
}

// ---------- 8. 天井（地図の§7）----------
{
  ok('⑧地図にトリガー20本の上限がある', /トリガー \| 20本/.test(DOC));
  ok('⑧地図にバージョン200の上限がある', /バージョン \| 200/.test(DOC));
  ok('⑧地図に「反映はまとめて1回」がある', /反映はまとめて1回/.test(DOC));
}

// ---------- 8-b. ★作業依頼の出し方・読み方（地図の§8-2）----------
{
  const JOBS = rd('worker/src/routes/jobs.js');
  ok('⑧-b★結果の読み取りは合言葉が要らない',
     /GET \/jobs\/<request_id> … 結果を読む。合言葉は不要/.test(JOBS),
     '地図の §8-2 の根拠。ここが変わったら地図も直す');
  ok('⑧-b★登録と報告は合言葉が要る',
     /if \(!authed\(request, env\)\) return json\(\{ success: false, code: 'FORBIDDEN' \}, 403\);/.test(JOBS));
  ok('⑧-b requestId の形が決まっている', /\^\[A-Za-z0-9_-\]\{24,64\}\$/.test(JOBS));
  //   ★EDGE_URL が公開情報であることの根拠（顧客のブラウザが叩く）
  ok('⑧-b★WorkerのURLは画面に平文で入っている（公開情報）',
     /var EDGE_URL = 'https:\/\/[a-z0-9.-]+workers\.dev';/.test(rd('liff/index.html')));
  //   ★許可されている op の一覧と、地図の記述がそろっているか
  const WF = rd('.github/workflows/edge-job.yml');
  ok('⑧-b quotaBuild が許可されている', /quotaBuild\) : ;;/.test(WF));
  ok('⑧-b 地図が「登録するだけ」と書いている', /★登録するだけ。結果は読まない/.test(DOC));
  ok('⑧-b★地図が alloc 必須と書いている',
     /\{"write":true,"alloc":true\} の\*\*両方\*\*が必須/.test(DOC)
     && /ALLOC_REQUIRED/.test(rd('worker/src/routes/quota.js')));
  ok('⑧-b★地図が正しい範囲を書いている', /\{"from":"2026-09","to":"2026-12"\}/.test(DOC));
  //   ★作り直しの順序（2026-10-09 に踏んだ）
  ok('⑧-b★地図が「入力を押す→作り直す→照合」の順序を書いている',
     /① 入力を押す           \{"op":"pushAll"\}/.test(DOC)
     && /② 作り直す/.test(DOC) && /③ 照合/.test(DOC));
  //   ★2026-10-09：地図は「pushAll ← source_version が進む」と書いていた。**事実と違った。**
  //     差分同期なので、内容が変わっていない行は書かず、世代も進まない。
  ok('⑧-b★地図が「進むとは限らない」と書いている',
     /`source_version` が進むとは限らない/.test(DOC)
     && /実際にD1へ書いた会員だけ source_version が進む/.test(DOC));
  ok('⑧-b★その根拠（書かなかった行は数えない）',
     /if \(!full && !replaceCustomer && same\(r, existing\[String\(key\)\]\)\) continue;   \/\/ 書かなかった行/.test(rd('worker/src/routes/ingest.js')));
  ok('⑧-b★完全同期なら全行を書く（だから進む）',
     /const full = body\.deleteStale === true;/.test(rd('worker/src/routes/ingest.js'))
     && /削除まで確定するのは\*\*日次の完全同期\*\*/.test(DOC));
  ok('⑧-b★後付けの手順（bootstrap）が書いてある',
     /世代表を既存の入力へ後付けするとき/.test(DOC)
     && /既存の 0\/0 の行も 1\/0 に直す/.test(DOC));
  ok('⑧-b★その根拠（印は source と一致したときだけ進む）',
     /WHEN customer_sync_version\.source_version = excluded\.built_version/.test(rd('worker/src/lib/sync-version.js')));
  ok('⑧-b★飛ばしたときは「答えない側」に倒れる',
     /VERSION_NOT_BUILT|VERSION_/.test(rd('worker/src/routes/quota-verify.js')),
     '止まるのが正しい。「一致」と出るほうが危険');
}

// ---------- 9. 倒れる向き（地図の§0）----------
{
  ok('⑨★地図の先頭に「答えない側へ倒す」がある',
     DOC.indexOf('判定できないとき・確かめられないときは、**必ず「答えない」側へ倒す。**') > 0
     && DOC.indexOf('判定できないとき') < DOC.indexOf('## 1.'),
     'これが全部の判断の基準。先頭に無ければ読まれない');
}

console.log(`\n${fail ? '❌' : '✅'} 地図が事実と合っているか 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
