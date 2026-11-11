// トレーナー紹介URL（UTM付き）の配線（2026-11-05）
//
//   ★なぜ要るのか
//     成果物は「URL」そのもので、コードは1行も変えていない。
//     だから正しさの根拠は、「本番のページがこのクエリを読み、
//     台帳の utm_source 列に落ちる」という配線が今も生きていること、それだけである。
//     配線が死んでも画面は壊れず、予約は通り、台帳には direct と入る
//     ＝**静かに壊れる**。誰も気づけない。
//
//   ★ここで見るのは「文字列があるか」ではない。
//     ① 実際のクエリ文字列を本番と同じコードに通して、値が出てくるか
//     ② その値が送信の中身に乗るか
//     ③ GASが台帳の**同じ位置の列**に書くか（列がずれると全部横にずれる）
//     ④ 紹介が計測から消える形（traffic_type=internal・許可形外）になっていないか
//     ⑤ 「誰経由」と「誰が担当」が別の列か（枠は全員ぶん出すのが前提）
//
//   使い方
//     node worker/test/utm-referral.test.js            ローカルの index.html
//     node worker/test/utm-referral.test.js --live      本番を取得して見る
//     node worker/test/utm-referral.test.js --break N   わざと壊して落ちることを確かめる
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const LIVE_URL = 'https://reservation.tokowaka-gym.com/';
const argv = process.argv.slice(2);
const LIVE = argv.includes('--live');
const BREAK = (() => { const i = argv.indexOf('--break'); return i >= 0 ? Number(argv[i + 1]) : 0; })();

/* ★紹介URLの設計（唯一の定義。URLを増やすときはここに足す）
   utm_campaign に月を入れないのは、名刺・QRを刷り直さずに使い続けるため。
   いつ来たかは台帳の日時で分かる。
   氏名は brand-facts.md、トレーナーIDは nakano/suzuki/oki.html の TRAINER_ID が正本。 */
const MEDIUM   = 'referral_trainer';
const CAMPAIGN = 'trial_referral';
const TRAINERS = [
  { id: 'A', slug: 'tr_nakano', name: '中野 太郎' },
  { id: 'B', slug: 'tr_suzuki', name: '鈴木 健' },
  { id: 'C', slug: 'tr_oki',    name: '沖 進' },
];
const refUrl = (slug, content) =>
  `${LIVE_URL}?utm_source=${slug}&utm_medium=${MEDIUM}&utm_campaign=${CAMPAIGN}` +
  (content ? `&utm_content=${content}` : '');

let ng = 0, ok = 0;
const check = (cond, label, detail) => {
  if (cond) { ok++; console.log(`  ok   ${label}`); }
  else { ng++; console.log(`  NG   ${label}${detail ? '\n       → ' + detail : ''}`); }
};

let html;
if (LIVE) {
  html = execFileSync('curl', ['-fsS', LIVE_URL], { encoding: 'utf8', maxBuffer: 8 << 20 });
  console.log(`本番を取得しました（${html.length} bytes）: ${LIVE_URL}`);
} else {
  html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  console.log('ローカルの index.html を見ています');
}
if (BREAK === 1) html = html.replace(/p\.get\('utm_source'\)/, "p.get('source')");
if (BREAK === 2) html = html.replace(/utmSource:utmParams\.utm_source/, 'utmSource:"direct"');

/* ── ① ページが URL の utm_* を読むか（入口から実際に通す） ───────── */
console.log('\n① ページが紹介URLのクエリを読むか');
const iife = html.match(/var utmParams = \(function\(\)\{[\s\S]*?\}\)\(\);/);
check(!!iife, 'utmParams の読み取り部分がページにある',
  '見つからない＝ページの作りが変わった。この検査の前提が崩れている');

if (iife) {
  const run = (search) => {
    try {
      return new Function('window', 'URLSearchParams',
        iife[0] + ' return utmParams;')({ location: { search } }, URLSearchParams);
    } catch (e) { return { err: e.message }; }
  };
  for (const t of TRAINERS) {
    const got = run(new URL(refUrl(t.slug, 'card_qr')).search);
    check(got.utm_source === t.slug, `${t.name} → utm_source=${t.slug}`,
      `実際は ${JSON.stringify(got.utm_source)}`);
    check(got.utm_medium === MEDIUM, `${t.name} → utm_medium=${MEDIUM}`,
      `実際は ${JSON.stringify(got.utm_medium)}`);
    check(got.utm_campaign === CAMPAIGN, `${t.name} → utm_campaign=${CAMPAIGN}`,
      `実際は ${JSON.stringify(got.utm_campaign)}`);
    check(got.utm_content === 'card_qr', `${t.name} → utm_content=card_qr（接点を足したとき）`,
      `実際は ${JSON.stringify(got.utm_content)}`);
  }
  /* UTMなしで来た人は direct に倒れる＝紹介と素の流入が混ざらない */
  check(run('').utm_source === 'direct', 'UTMなしで来た人は direct（紹介に混ざらない）');
}

/* ── ② 読んだ値が送信の中身に乗るか ──────────────────── */
console.log('\n② 読んだ値が予約の送信に乗るか');
check(/utmSource:utmParams\.utm_source/.test(html), 'utmSource に utmParams.utm_source を渡している',
  '渡していない＝URLを読んでも台帳には届かない');
check(/utmMedium:utmParams\.utm_medium/.test(html), 'utmMedium を渡している');
check(/utmCampaign:utmParams\.utm_campaign/.test(html), 'utmCampaign を渡している');
check(/utmContent:utmParams\.utm_content/.test(html), 'utmContent を渡している');

/* ── ③ 受ける側（GAS）が同じ位置の列に書くか ───────────────
   列の数がずれると、そこから先の値が全部1つ横へずれて記録される。 */
console.log('\n③ GASが台帳の正しい列に書くか');
let gas = readFileSync(join(ROOT, 'gas', 'コード.js'), 'utf8');
if (BREAK === 3) gas = gas.replace(/sanitizeCell\(params\.utmSource   \|\| 'direct'\),\n/, '');

const splitTop = (s) => {        // かっこの中のコンマは区切りにしない
  const out = []; let d = 0, cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[') d++;
    else if (ch === ')' || ch === ']') d--;
    if (ch === ',' && d === 0) { out.push(cur); cur = ''; continue; }
    cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((x) => x.trim()).filter(Boolean);
};
const headSrc = gas.match(/var RES_HEADERS = \[([\s\S]*?)\];/);
const rowSrc  = gas.match(/sheet\.appendRow\(\[([\s\S]*?)\n    \]\);/);
check(!!headSrc && !!rowSrc, 'ヘッダーと書き込みの両方が読めた',
  '読めない＝記録の作りが変わった。この検査の前提が崩れている');
if (headSrc && rowSrc) {
  const heads = splitTop(headSrc[1]).map((x) => x.replace(/^'|'$/g, ''));
  const cells = splitTop(rowSrc[1].replace(/\/\/[^\n]*/g, ''));
  check(heads.length === cells.length,
    `列の数が揃っている（ヘッダー${heads.length} / 書き込み${cells.length}）`,
    'ずれている＝どこかの列から先が全部1つ横へずれて記録される');
  for (const [label, expr] of [['utm_source', 'utmSource'], ['utm_medium', 'utmMedium'],
                               ['utm_campaign', 'utmCampaign'], ['広告CR', 'utmContent']]) {
    const hi = heads.indexOf(label);
    const ci = cells.findIndex((c) => c.includes('params.' + expr));
    check(hi >= 0 && hi === ci, `「${label}」列に params.${expr} が入る（${hi + 1}列目）`,
      `ヘッダー ${hi + 1}列目 / 書き込み ${ci + 1}列目`);
  }
}

/* ── ④ 紹介が計測から消えないか ─────────────────────── */
console.log('\n④ 紹介が計測から消えないか');
check(!refUrl('tr_nakano').includes('traffic_type'),
  '紹介URLに traffic_type=internal が付いていない',
  '付けるとGA4の自社トラフィック除外に当たり、紹介が1件も計測されない');
/* LP側の到達計測（page_hits）が受け付ける形。pagehits.js の SOURCE_RE と揃える */
const srcRe = readFileSync(join(ROOT, 'worker', 'src', 'routes', 'pagehits.js'), 'utf8')
  .match(/const SOURCE_RE = (\/\^.*\$\/);/);
check(!!srcRe, 'pagehits.js の SOURCE_RE が読めた',
  '読めない＝許可形の場所が変わった。この検査の前提が崩れている');
if (srcRe) {
  const re = new RegExp(srcRe[1].slice(1, -1));
  for (const t of TRAINERS) {
    const slug = BREAK === 4 ? t.slug.replace('tr_', 'trainer_') : t.slug;
    check(re.test(slug), `${slug} は到達計測の許可形に入る`,
      'SOURCE_RE に合わない＝LP側の到達が none に落ちる');
  }
}

/* ── ⑤ 「誰経由」と「誰が担当」が別の列か ──────────────── */
console.log('\n⑤ 「誰経由」と「誰が担当」が別の列か');
check(/'担当トレーナー', 'トレーナーID'/.test(gas) && /'utm_source'/.test(gas),
  '担当トレーナー列と utm_source 列が別にある',
  '同じ列なら「鈴木の紹介で沖の枠を取った」が記録できない');
check(!/allSlots = \(data\|\|\[\]\)\.filter/.test(BREAK === 5 ? html + 'allSlots = (data||[]).filter(' : html),
  'トップページは枠を絞っていない（全員ぶん表示）',
  'filter が入っている＝トレーナー別ページの作りになっている');

console.log(`\n${ng === 0 ? '✅ 全部通りました' : '❌ ' + ng + '件 NG'}（ok ${ok} / ng ${ng}）`);
if (ng === 0 && argv.includes('--urls')) {
  console.log('\n紹介URL：');
  for (const t of TRAINERS) console.log(`  ${t.name}（ID ${t.id}）\n    ${refUrl(t.slug)}`);
}
process.exit(ng === 0 ? 0 : 1);
