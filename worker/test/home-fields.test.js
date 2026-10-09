// 顧客に返す鍵が、全部「写し」に入っているか
//
//   ★なぜ要るのか（2026-10-09）
//     `transferCredits`（ホームの「振替 N回」＋予約画面の①通常/②振替の分岐）が
//     **写しに入っていなかった**。GASは memberStatus の home の**外**に置き、
//     Workerは home の**中**を読んでいた（compat.js）。
//     ＝Worker経由では常に { available: 0 }。
//     **振替権を持つ会員が、振替で予約できない状態だった。**
//
//     shadow（写しとD1を比べる仕組み）のために「顧客に返す値の一覧」を
//     作ろうとして初めて気づいた。Codex の指摘から辿った。
//
//   ★この検査が守ること
//     Worker が `home.XXX` として読む鍵は、次のどれかに必ず属する。
//       ① 写し（_lbBuildHome の返り値）にある
//       ② readHome が後から足す付帯情報（month / computedAt / stale / ageMs）
//       ③ 写しのトップレベルにある（transferCredits）
//     どれにも無ければ **undefined を顧客に返している**。
//
//   実行: node worker/test/home-fields.test.js

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const rd = (p) => readFileSync(join(ROOT, p), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

//   写し（GASの _lbBuildHome の返り値）の鍵を、ソースから取り出す
function gasHomeKeys() {
  const LB = rd('gas/LineBooking.js');
  const at = LB.indexOf('function _lbBuildHome(');
  const end = LB.indexOf('\n}', at);
  const body = LB.slice(at, end);
  const rs = body.indexOf('\n  return {');
  let i = rs + '\n  return '.length, depth = 0, keys = [], inStr = null, buf = '';
  for (; i < body.length; i++) {
    const c = body[i];
    if (inStr) { if (c === inStr && body[i - 1] !== '\\') inStr = null; continue; }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '/' && body[i + 1] === '/') { while (i < body.length && body[i] !== '\n') i++; continue; }
    if (c === '{' || c === '(' || c === '[') { depth++; buf = ''; continue; }
    if (c === '}' || c === ')' || c === ']') { depth--; buf = ''; if (depth === 0) break; continue; }
    if (depth === 1) {
      if (c === ':') { const k = buf.trim(); if (/^[A-Za-z_]\w*$/.test(k)) keys.push(k); buf = ''; }
      else if (c === ',') buf = '';
      else buf += c;
    }
  }
  return keys;
}

//   readHome が後から足すもの
const EXTRA = ['month', 'computedAt', 'stale', 'ageMs'];
//   写しのトップレベル（月ごとに分かれない値）
const TOP = ['transferCredits'];

const copyKeys = gasHomeKeys();
ok('①写しの鍵を読み取れた', copyKeys.length >= 20, `${copyKeys.length}個`);

//   Worker が home.XXX として読んでいる鍵を全部集める
const files = readdirSync(join(ROOT, 'worker/src/routes')).filter((f) => f.endsWith('.js'));
const used = new Set();
const where = {};
for (const f of files) {
  const src = rd(`worker/src/routes/${f}`);
  for (const m of (src.match(/\bhome\.[a-zA-Z_][a-zA-Z0-9_]*/g) || [])) {
    const k = m.replace('home.', '');
    used.add(k);
    (where[k] = where[k] || []).push(f);
  }
}
ok('②読んでいる鍵を集められた', used.size >= 10, `${used.size}個: ${[...used].join(' ')}`);

//   ★どれにも属さない鍵があれば、undefined を顧客に返している
{
  const known = new Set(copyKeys.concat(EXTRA).concat(TOP));
  const orphan = [...used].filter((k) => !known.has(k));
  ok('③★顧客に返す鍵が全部そろっている', orphan.length === 0,
     `写しに無い鍵: ${orphan.map((k) => `${k}（${(where[k] || []).join(',')}）`).join(' / ')}`);
}

//   ★写しのトップレベルの鍵が、実際に写しへ入っているか（GAS側）
{
  const PUSH = rd('gas/PushToEdge.js');
  ok('④★振替権を写しに入れている',
     /transferCredits: tcAll\[cid\] \|\| \{ available: 0/.test(PUSH),
     '入っていないと Worker 経由で常に0になる');
  ok('④★シートは1回だけ読む（会員ごとに読まない）',
     /function _edgeTransferCreditsAll\(\)/.test(PUSH)
     && !/_lbTransferCreditsFor\(cid/.test(PUSH),
     '_lbTransferCreditsFor は会員ごとにシート全体を読む（40名で40回）');
  //   ★★読めなかったら押し出しを**止める**（2026-10-09・関門③の2周目）。
  //     最初は「止めない（0に見えるだけ）」と書いたが、**それは退行だった**。
  //     振替権を写しに入れたあとに 0 を書くと、正しい写しを「振替0回」で
  //     上書きする＝振替で予約できなくなる。
  ok('④★読めなかったら ok:false を返す',
     /return \{ ok: false, byCid: \{\}, error: String/.test(PUSH)
     && !/0として扱われます/.test(PUSH));
  ok('④★そのとき写しを押し出さない（前の正しい写しを残す）',
     /if \(!_tc\.ok\) \{[\s\S]{0,200}return \[\];/.test(PUSH),
     '「不明」を「0件」に変換して押し出してはいけない');
  ok('④シートが無い・空は正常として 0 を返す',
     /return \{ ok: true, byCid: out, empty: 'no_sheet' \}/.test(PUSH)
     && /return \{ ok: true, byCid: out, empty: 'no_rows' \}/.test(PUSH),
     '振替権を持つ人がいないだけ＝0でよい');
}

//   ★Worker 側が写しのトップレベルから返しているか
{
  const BOOT = rd('worker/src/routes/boot.js');
  ok('⑤★readHome が振替権を返す', /transferCredits: p\.transferCredits,/.test(BOOT));
  ok('⑤古い写しでも落ちない（undefined のまま返す）',
     !/transferCredits: p\.transferCredits \|\| /.test(BOOT),
     '呼ぶ側が 0 に落とす（compat.js の `|| { available: 0 }`）');
  const COMPAT = rd('worker/src/routes/compat.js');
  ok('⑤呼ぶ側が 0 に落としている', /transferCredits: home\.transferCredits \|\| \{ available: 0 \}/.test(COMPAT));
}

//   ★D1からは作れないことを明示（手順4で顧客に出すときは写しから補う）
{
  const RF = rd('worker/src/lib/remain-from-d1.js');
  ok('⑥★D1の組み立てには入っていない', !/transferCredits/.test(RF),
     '振替権のデータはD1に無い（transfer_credits シートだけにある）');
  const SH = rd('worker/src/lib/remain-shadow.js');
  ok('⑥shadow の比較対象にも入っていない', !/'transferCredits'/.test(SH),
     'D1から作れないものを比べると、必ず食い違いとして出る');
  const DOC = rd('ops/MODEL.md');
  ok('⑥★地図が「D1から作れない」と書いている',
     /transferCredits/.test(DOC),
     '手順4（顧客に出す）で写しから補わないと、振替が消える');
}

// ---------- 7. ★期限の規則が3箇所で揃っているか（shadow が見つけた差）----------
//   ★2026-10-09、shadow を on にした**初回の比較**で見つかった：
//     写し=2027-01-12 00:00:00.000 ／ D1=2027-01-12 23:59:59.999（差 86,399,999ms）
//     計算側（Allocate.js）と割当器は「終了日のJST終端まで有効」に正規化していたが、
//     **写しを作るところだけ契約行のセルの生の値（0:00）を返していた。**
//   ★D1のほうが正しい（0時セルで当日午後が切れる境界を回避するための規則）。
//     画面はこの鍵を使っていないので顧客への影響は無いが、
//     規則が2つあると shadow の食い違いとして出続け、**本物の差が埋もれる**。
{
  const NORM = /\(Math\.floor\(\w+ \/ 86400000\) \* 86400000 - 9 \* 3600000\) \+ 86399999/;
  const files = {
    '計算側（Worker）': rd('worker/src/allocate.js'),
    '計算側（GAS）': rd('gas/Allocate.js'),
    '写しを作るところ（GAS）': rd('gas/LineBooking.js'),
  };
  for (const [name, src] of Object.entries(files)) {
    ok(`⑦★期限を終端に正規化している：${name}`, NORM.test(src),
       '規則が揃っていないと shadow の食い違いとして出続ける');
  }
  //   ★生の値をそのまま入れる書き方が残っていないか
  ok('⑦★写しが生の値を返していない',
     !/ticketExpireMs = rr\.end\.getTime\(\);/.test(rd('gas/LineBooking.js')),
     'shadow の初回でこれが見つかった');
}

console.log(`\n${fail ? '❌' : '✅'} 顧客に返す鍵がそろっているか 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
