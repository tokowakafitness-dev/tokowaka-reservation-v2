// 「全員を元に戻す」手段が本当に効くことの検証（2026-10-03・Codex指摘）
//
//   ★なぜ要るのか
//     2026-09-29、画面側の切り替え（EDGE_ON）を既定 false にして止めたつもりだったが、
//     鍵の読み方が `!== '0'` のままで、鍵の無い端末は式のほうで true に戻っていた。
//     **止めたつもりで止まっていなかった。**
//     さらに画面は端末のキャッシュに載っており、push しても即座には届かない。
//
//     止める手段を画面に置いたことが原因だった。だから画面を経由しない1か所
//     （Workerの環境変数 EDGE_READS）に置き直し、それが効くことをここで固定する。
//
//   ★いちばん危ないのは「新しい窓口を足したとき、止める対象から漏れること」。
//     止めたのに一部だけWorkerに残ると、何が起きているか分からなくなる。
//
//   実行: node worker/test/edge-killswitch.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const INDEX = readFileSync(join(ROOT, 'worker/src/index.js'), 'utf8');
const TOML  = readFileSync(join(ROOT, 'worker/wrangler.toml'), 'utf8');
const HTML  = readFileSync(join(ROOT, 'liff/index.html'), 'utf8');

let pass = 0, fail = 0;
function eq(name, got, want) {
  if (JSON.stringify(got) === JSON.stringify(want)) pass++;
  else { fail++; console.log(`❌ ${name}\n   got : ${JSON.stringify(got)}\n   want: ${JSON.stringify(want)}`); }
}
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// ---------- 1. 停止スイッチが入口に在ること ----------
ok('①EDGE_READS を見ている', /env\.EDGE_READS/.test(INDEX));
ok('①"off" のとき FALLBACK を返す',
  /EDGE_READS[\s\S]{0,80}'off'[\s\S]{0,200}code: 'FALLBACK'/.test(INDEX));
ok('①理由が分かる印を付けている', /EDGE_READS_OFF/.test(INDEX));

// ★処理に入る前に止めること。handler を呼んでから止めてもD1は読まれている。
{
  const iSwitch = INDEX.indexOf('EDGE_READS');
  const iHandler = INDEX.indexOf('const handler = HANDLERS[action]');
  ok('①★窓口を呼ぶ前に止める', iSwitch > 0 && iHandler > 0 && iSwitch < iHandler,
     `switch=${iSwitch} handler=${iHandler}`);
}
// 認証より後であること（誰でも叩ける窓口を増やさない）
{
  const iAuth = INDEX.indexOf('verifyIdToken');
  const iSwitch = INDEX.indexOf('EDGE_READS');
  ok('①認証の後に置く', iAuth > 0 && iSwitch > iAuth);
}

// ---------- 2. 既定では止まらないこと ----------
//   既定で止まっていると、気づかないまま全員が遅いままになる。
ok('②wrangler.toml で既定は書かれていない（コメントのみ）',
  !/^\s*EDGE_READS\s*=/m.test(TOML), '有効な EDGE_READS 行が存在する');
ok('②戻し方が設定ファイルに書いてある', /EDGE_READS\s*=\s*"off"/.test(TOML));

// ---------- 3. ★止める対象に漏れが無いこと ----------
//   画面が呼ぶ窓口はすべて c_ で始まる、という約束に乗っている。
//   新しい窓口を c_ 以外の名前で足すと、止めたのにそれだけ残る。
{
  const map = (HTML.match(/var EDGE_MAP = \{[\s\S]*?\n  \};/) || [])[0] || '';
  ok('③画面の窓口一覧が読める', !!map);
  const targets = [...map.matchAll(/:\s*'([a-zA-Z_]+)'/g)].map((m) => m[1]);
  ok('③窓口が1つ以上ある', targets.length > 0, `${targets.length}個`);
  const notC = targets.filter((t) => !/^c_/.test(t));
  eq('③★画面が呼ぶ窓口はすべて c_ で始まる（止める対象から漏れない）', notC, []);

  // 止める判定そのものが c_ で始まるものを対象にしていること
  ok('③止める判定が c_ を対象にしている', /\/\^c_\/\.test\(action\)/.test(INDEX));

  // 今日足した2つが確かに入っていること
  ok('③起動のまとめ取得が対象に入る', targets.includes('c_boot'));
  ok('③顧客カードのまとめ取得が対象に入る', targets.includes('c_customerCard'));
}

// ---------- 4. 止める手段が2段そろっていること ----------
//   画面側（端末1台を戻す）とWorker側（全員を戻す）は役割が違う。片方だけでは足りない。
ok('④端末1台を戻す道がある（?edge=0）', /edge=0/.test(HTML));
ok('④全員を戻す道がWorker側にある', /EDGE_READS/.test(INDEX) && /EDGE_READS/.test(TOML));
// 画面側のコメントが「既定を false にすれば全員止まる」と誤って案内していないこと。
//   実際には鍵の読み方が対で直っていないと止まらない（2026-09-29の事故）。
{
  const liffComment = (HTML.match(/全員を止める[^\n]*/g) || []).join('\n');
  ok('④★画面側に「既定を false にすれば全員止まる」という案内が残っていない',
     !/既定を false にして push/.test(liffComment), liffComment);
}

console.log(`\n${fail ? '❌' : '✅'} 全員を戻す手段 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
