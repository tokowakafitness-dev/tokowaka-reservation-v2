// D1の行から残数を作る（段階3-b 手順2）
//
//   ★何より大事なのは「写しとまったく同じ形で返す」こと。
//     形がずれると、呼ぶ側を変えずに差し替えられない＝戻せない。
//     だから**形の鍵をGASのソースから機械で取り出して突き合わせる**。
//     目で見比べると必ず漏れる（2026-10-08に2項目を私とCodexの両方が見落とした）。
//
//   実行: node worker/test/remain-from-d1.test.js

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  buildRemainFromRows, monthlyRemainOf, ticketsAt,
  fmtDateOnlyJst, monthKeyJst, monthRangeJst, readRemainFromD1, readRemainDiag,
} from '../src/lib/remain-from-d1.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const LB = readFileSync(join(ROOT, 'gas/LineBooking.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, extra) { cond ? pass++ : (fail++, console.log(`❌ ${name}${extra ? '\n   ' + extra : ''}`)); }

// JST の時刻を作る
const jst = (y, m, d, h = 12) => Date.UTC(y, m - 1, d, h - 9, 0, 0);

// ---------- 1. ★形の鍵をGASから取り出して突き合わせる ----------
//   _lbBuildHome の最後の return { … } を、括弧の深さを数えて読む。
//   深さ1の鍵だけを集める（ticketPacks の中の鍵などを拾わない）。
function gasHomeKeys() {
  const at = LB.indexOf('function _lbBuildHome(');
  if (at < 0) return null;
  //   その関数の中で最後に現れる `return {`
  const end = LB.indexOf('\n}', at);
  const body = LB.slice(at, end);
  //   ★lastIndexOf('return {') では、.map の中の `return { remaining: … }` を拾ってしまう。
  //     関数の本体の return は字下げ2文字。そこだけを見る。
  const rs = body.indexOf('\n  return {');
  if (rs < 0) return null;
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
const gasKeys = gasHomeKeys();
ok('①GASの形を読み取れた', Array.isArray(gasKeys) && gasKeys.length >= 20,
   `取れた鍵=${gasKeys ? gasKeys.length : 'なし'}`);

const sample = buildRemainFromRows({
  nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
  targetMonthRow: { month_key: '2026-10', quota: 9, used: 3, coverage: 'limited', base_freq: 8, overage: 0 },
  curMonthRow: { month_key: '2026-10', quota: 9, used: 3, coverage: 'limited', base_freq: 8, overage: 0 },
  nextMonthRow: null, packs: [], thisMonthCount: 3,
});
const mine = Object.keys(sample).filter((k) => k[0] !== '_');
{
  const missing = (gasKeys || []).filter((k) => mine.indexOf(k) < 0);
  const extra = mine.filter((k) => (gasKeys || []).indexOf(k) < 0);
  ok('①★GASにある鍵が全部ある', missing.length === 0, `足りない: ${missing.join(', ')}`);
  ok('①★GASに無い鍵を増やしていない', extra.length === 0, `余計: ${extra.join(', ')}`);
}
ok('①印の鍵は _ で始める（比べるときに除ける）', sample._src === 'd1');

// ---------- 2. 月額の見せ方（coverage の3状態）----------
ok('②覆っていて頻度がある → 枠−使った数',
   monthlyRemainOf({ coverage: 'limited', quota: 9, used: 3 }).rem === 6);
ok('②覆っていない → 0（繰越が残っていても使えない）',
   monthlyRemainOf({ coverage: 'uncovered', quota: 2, used: 0 }).rem === 0);
ok('②上限なし → null', monthlyRemainOf({ coverage: 'unlimited', quota: 0, used: 0 }).rem === null);
ok('②★coverage が入っていない行は答えない（0 で埋めない）',
   monthlyRemainOf({ coverage: null, quota: 9, used: 3 }).ok === false,
   '既定値で埋めると、本当は0やnullを見せる行が数値を見せる');
ok('②枠の行が無い → 月額の契約が無い（null）',
   monthlyRemainOf(null).rem === null && monthlyRemainOf(null).hasRow === false);

// ---------- 3. 枠の2列から繰越を作る ----------
{
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: { quota: 9, used: 3, coverage: 'limited', base_freq: 8, overage: 0 },
    curMonthRow: { quota: 9, used: 3, coverage: 'limited', base_freq: 8, overage: 0 },
    packs: [], thisMonthCount: 3,
  });
  ok('③頻度は base_freq', r.quota === 8);
  ok('③繰越は 枠 − 頻度', r.carryover === 1);
  ok('③残りは 枠 − 使った数', r.monthlyRemaining === 6 && r.remaining === 6);
  ok('③種別は monthly', r.type === 'monthly');
  ok('③予約できる経路がある', r.hasNormalRoute === true);
}
{
  //   ★base_freq が入っていない行からは作れない。0 で埋めると繰越が過大に見える。
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: { quota: 9, used: 3, coverage: 'limited', base_freq: null, overage: 0 },
    curMonthRow: { quota: 9, used: 3, coverage: 'limited', base_freq: null, overage: 0 },
    packs: [], thisMonthCount: 3,
  });
  ok('③★頻度が入っていない行では答えない', r === null,
     '0 で埋めると carryover = 枠の全部になり、繰越が過大に見える');
}

// ---------- 4. 頻度0は月0回（設計08）----------
{
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: { quota: 1, used: 0, coverage: 'limited', base_freq: 0, overage: 0 },
    curMonthRow: { quota: 1, used: 0, coverage: 'limited', base_freq: 0, overage: 0 },
    packs: [], thisMonthCount: 0,
  });
  ok('④頻度0＋繰越1 → 残り1', r.quota === 0 && r.carryover === 1 && r.monthlyRemaining === 1);
}

// ---------- 5. 支払い待ち（超過）----------
{
  const row = { quota: 8, used: 8, coverage: 'limited', base_freq: 8, overage: 2 };
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: row, curMonthRow: row, packs: [], thisMonthCount: 10,
  });
  ok('⑤件数をそのまま出す', r.overageCount === 2);
  ok('⑤★見せる残数は負で出す', r.displayRemaining === -2);
  ok('⑤支払いの案内を出す', r.paymentRequired === true);
  ok('⑤★monthlyRemaining は負にしない', r.monthlyRemaining === 0,
     '負にすると「あと -2回ご利用いただけます」の文面が出る（予約可否・請求も読む）');
}

// ---------- 6. チケット ----------
{
  const packs = [
    //   期限が遅い方を先に並べて、FEFO に並べ替わることを見る
    { pack_id: 'p2', kind: 'normal', total: 5, used: 0, opening_used: 0,
      valid_from: jst(2026, 9, 1), valid_to: jst(2026, 12, 31) },
    { pack_id: 'p1', kind: 'normal', total: 10, used: 1, opening_used: 2,
      valid_from: jst(2026, 9, 1), valid_to: jst(2026, 10, 31) },
    { pack_id: 'p0', kind: 'pair', total: 4, used: 1, opening_used: 0,
      valid_from: jst(2026, 9, 1), valid_to: jst(2026, 11, 30) },
    //   期限切れ（いまは数えない。ただし買った枚数と期限の表示には入る）
    { pack_id: 'px', kind: 'normal', total: 3, used: 3, opening_used: 0,
      valid_from: jst(2026, 1, 1), valid_to: jst(2026, 3, 31) },
  ];
  const t = ticketsAt(packs, jst(2026, 10, 9));
  ok('⑥残り＝買った枚数 − 移行前 − 引当', t.rem === (5) + (10 - 2 - 1) + (4 - 1),
     `出た値=${t.rem}`);
  ok('⑥期限切れは数えない', t.list.every((p) => p.expireMs >= jst(2026, 10, 9)));
  ok('⑥ペアと通常を分ける', t.pair === 3 && t.normal === 5 + 7);
  ok('⑥単一パックの最大残（2名来店の可否素材）', t.pairPackMax === 3);
  ok('⑥★先に切れる順に並ぶ（FEFO）',
     t.list.map((p) => p.expireMs).join(',') === [jst(2026, 10, 31), jst(2026, 11, 30), jst(2026, 12, 31)].join(','));

  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: null, curMonthRow: null, packs, thisMonthCount: 2,
  });
  ok('⑥種別は ticket', r.type === 'ticket');
  ok('⑥見せる残数はチケットの残り', r.remaining === t.rem && r.ticketRemaining === t.rem);
  ok('⑥買った枚数は期限切れも含む', r.ticketTotal === 5 + 10 + 4 + 3);
  ok('⑥期限はいちばん遅いパック', r.ticketExpireMs === jst(2026, 12, 31));
  ok('⑥期限の書き方はGASと同じ', r.ticketExpire === '2026年12月31日', `出た値=${r.ticketExpire}`);
}
{
  //   ★買った枚数を超えて使っている状態を 0 に丸めて隠さない
  const packs = [{ pack_id: 'p', kind: 'normal', total: 2, used: 3, opening_used: 0,
                   valid_from: jst(2026, 9, 1), valid_to: jst(2026, 12, 31) }];
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: null, curMonthRow: null, packs, thisMonthCount: 3,
  });
  ok('⑥★使いすぎは残り0だが、丸めた事実を残す',
     r.ticketRemaining === 0 && r._packOverUse === 1,
     '黙って丸めると、計算側も0なので「一致」と出て異常が見えなくなる');
}

// ---------- 7. 月額とチケットの併存 ----------
{
  const row = { quota: 3, used: 1, coverage: 'limited', base_freq: 3, overage: 0 };
  const packs = [{ pack_id: 'p', kind: 'normal', total: 2, used: 0, opening_used: 0,
                   valid_from: jst(2026, 9, 1), valid_to: jst(2026, 12, 31) }];
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: row, curMonthRow: row, packs, thisMonthCount: 1,
  });
  ok('⑦種別は both', r.type === 'both');
  ok('⑦後方互換の remaining は月額の残り', r.remaining === 2);
  ok('⑦チケットの残りは別に出す', r.ticketRemaining === 2);
}

// ---------- 8. 契約が無い会員 ----------
{
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 9), targetMs: jst(2026, 10, 9),
    targetMonthRow: null, curMonthRow: null, packs: [], thisMonthCount: 0,
  });
  ok('⑧契約が無ければ type:null（写しと同じ形）',
     r && r.type === null && Object.keys(r).length === 1);
}

// ---------- 9. 25日ゲート（翌月の案内）----------
{
  const cur = { quota: 8, used: 8, coverage: 'limited', base_freq: 8, overage: 0 };
  const nxt = { quota: 8, used: 0, coverage: 'limited', base_freq: 8, overage: 0 };
  const r25 = buildRemainFromRows({
    nowMs: jst(2026, 10, 26), targetMs: jst(2026, 10, 26),
    targetMonthRow: cur, curMonthRow: cur, nextMonthRow: nxt, packs: [], thisMonthCount: 8,
  });
  ok('⑨25日以降は翌月を案内する',
     r25.nextMonth && r25.nextMonth.month === 11 && r25.nextMonth.total === 8,
     JSON.stringify(r25.nextMonth));
  const r24 = buildRemainFromRows({
    nowMs: jst(2026, 10, 24), targetMs: jst(2026, 10, 24),
    targetMonthRow: cur, curMonthRow: cur, nextMonthRow: nxt, packs: [], thisMonthCount: 8,
  });
  ok('⑨24日以前は案内しない', r24.nextMonth === null);
  //   翌月に使える回数が0なら出さない（契約終了など）
  const r0 = buildRemainFromRows({
    nowMs: jst(2026, 10, 26), targetMs: jst(2026, 10, 26),
    targetMonthRow: cur, curMonthRow: cur,
    nextMonthRow: { quota: 0, used: 0, coverage: 'uncovered', base_freq: 0, overage: 0 },
    packs: [], thisMonthCount: 8,
  });
  ok('⑨翌月0回なら案内しない', r0.nextMonth === null);
}

// ---------- 10. ★GASの癖をそのまま写す ----------
//   _lbBuildHome は翌月ぶんの写しでも thisMonth / overageCount を**当月のもの**で埋める。
//   直すと shadow の食い違いが「GASの癖」と「こちらの間違い」で混ざって読めなくなる。
{
  const cur = { quota: 8, used: 8, coverage: 'limited', base_freq: 8, overage: 2 };
  const nxt = { quota: 8, used: 1, coverage: 'limited', base_freq: 8, overage: 0 };
  const r = buildRemainFromRows({
    nowMs: jst(2026, 10, 26), targetMs: jst(2026, 11, 15),
    targetMonthRow: nxt, curMonthRow: cur, nextMonthRow: nxt, packs: [], thisMonthCount: 8,
  });
  ok('⑩翌月の残数は翌月の行から', r.monthlyRemaining === 7);
  ok('⑩★支払い待ちは当月のもの（GASの癖）', r.overageCount === 2);
  ok('⑩★今月の件数も当月のもの（GASの癖）', r.thisMonth === 8);
  ok('⑩GASが当月で埋めていることを根拠で確かめる',
     /_ovKey = _lbMonthKeyJst\(new Date\(\)\.getTime\(\)\)/.test(LB)
     && /var month = _lbCountReservations\(customerId, 'month'\);/.test(LB),
     'ここが変わったら、この写し方も変える');
}

// ---------- 11. 月の範囲と件数の数え方 ----------
{
  const { from, to } = monthRangeJst(jst(2026, 10, 9));
  ok('⑪月の始まりはJSTの1日0時', monthKeyJst(from) === '2026-10' && new Date(from + 9 * 3600000).getUTCDate() === 1);
  ok('⑪月の終わりは翌月1日0時（未満）', monthKeyJst(to) === '2026-11');
  ok('⑪★境目の1ミリ秒前は当月', monthKeyJst(to - 1) === '2026-10');
}
{
  const SRC = readFileSync(join(ROOT, 'worker/src/lib/remain-from-d1.js'), 'utf8');
  //   GAS の数え方（confirmed/consumed・transfer を除く）と合っているか
  const GAS_PUSH = readFileSync(join(ROOT, 'gas/PushToEdge.js'), 'utf8');
  //   ★★語彙が違う（2026-10-09・Codex関門②）。
  //     台帳 'confirmed' は、押し出しのときに D1 では 'booked' に変換される。
  //     台帳の語彙で書くと、通常の予約が1件も数えられない（consumed だけ数える）。
  ok('⑪★D1の語彙で数える（booked）',
     /status IN \('booked', 'consumed'\)/.test(SRC)
     && !/status IN \('confirmed'/.test(SRC),
     'D1を読むなら D1 の言葉で書く');
  ok('⑪★その変換が本当に行われていることを根拠で確かめる',
     /\(st === 'confirmed'\) \? 'booked'/.test(GAS_PUSH)
     && /\(st === 'consumed'\)  \? 'consumed'/.test(GAS_PUSH),
     'ここが変わったら、数え方も変える');
  ok('⑪GAS側は台帳の語彙で数えている（意味は同じ）',
     /_st !== 'confirmed' && _st !== 'consumed'/.test(LB));
  ok('⑪★取消・変更は数えない',
     !/cancelled/.test(SRC) && !/'changed'/.test(SRC)
     && /\(st === 'cancelled'\) \? 'cancelled'/.test(GAS_PUSH),
     'D1には cancelled / changed も入る。数えると今月の件数が増える');
  ok('⑪★振替は数えない',
     /COALESCE\(book_type, ''\) <> 'transfer'/.test(SRC)
     && /String\(r\[9\]\) === 'transfer'\) continue;/.test(LB));
}

// ---------- 12. 入れ物（鮮度・月の範囲・読めないとき）----------
function fakeEnv(spec) {
  //   ごく小さな D1 の代わり。SQL の中身で返すものを決める。
  return {
    DB: {
      prepare(sql) {
        return {
          bind(...args) { return this; },
          async first() {
            if (/customer_sync_version/.test(sql)) {
              if (spec.version === 'throw') throw new Error('no such table');
              return spec.version || null;
            }
            if (/COUNT\(\*\) AS n FROM reservations/.test(sql)) return { n: spec.count || 0 };
            return null;
          },
          async all() {
            if (/FROM monthly_quota/.test(sql)) return { results: spec.quota || [] };
            if (/FROM ticket_packs/.test(sql)) return { results: spec.packs || [] };
            return { results: [] };
          },
        };
      },
    },
  };
}
const now = jst(2026, 10, 9);
const qRow = { month_key: '2026-10', quota: 9, used: 3, coverage: 'limited', base_freq: 8, overage: 0 };
{
  const env = fakeEnv({ version: { source_version: 5, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 }, quota: [qRow], count: 3 });
  const r = await readRemainFromD1(env, 'C1', now, { nowMs: now });
  ok('⑫追いついていれば答える', r && r.monthlyRemaining === 6, JSON.stringify(r && r.monthlyRemaining));
}
{
  const env = fakeEnv({ version: { source_version: 6, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 }, quota: [qRow], count: 3 });
  ok('⑫★追いついていなければ答えない', (await readRemainFromD1(env, 'C1', now, { nowMs: now })) === null);
}
{
  const env = fakeEnv({ version: { source_version: 0, built_version: 0, built_quota_rows: 1, built_pack_rows: 0 }, quota: [qRow], count: 3 });
  ok('⑫★一度も作り直していなければ答えない',
     (await readRemainFromD1(env, 'C1', now, { nowMs: now })) === null);
}
{
  const env = fakeEnv({ version: null, quota: [qRow], count: 3 });
  ok('⑫★世代の行が無ければ答えない', (await readRemainFromD1(env, 'C1', now, { nowMs: now })) === null);
}
{
  const env = fakeEnv({ version: 'throw', quota: [qRow], count: 3 });
  ok('⑫★表が無い／読めないときも答えない',
     (await readRemainFromD1(env, 'C1', now, { nowMs: now })) === null,
     '読めなかったことを「問題なし」と扱ってはいけない');
}
{
  const env = fakeEnv({ version: { source_version: 5, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 }, quota: [qRow], count: 3 });
  ok('⑫★当月と翌月以外は答えない',
     (await readRemainFromD1(env, 'C1', jst(2026, 12, 15), { nowMs: now })) === null,
     '持っていない月に答えると、間違った残数を返す');
  ok('⑫翌月は答える対象', (await readRemainFromD1(
       fakeEnv({ version: { source_version: 5, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 },
                 quota: [{ ...qRow, month_key: '2026-11', used: 0 }], count: 3 }),
       'C1', jst(2026, 11, 15), { nowMs: now })) !== null);
}
ok('⑫会員が分からなければ答えない', (await readRemainFromD1(fakeEnv({}), '', now, { nowMs: now })) === null);

// ---------- 12-b. ★読んでいる最中に入力が来たら答えない ----------
{
  //   鮮度を確かめてから行を読むまでの間に押し出しが来ると、
  //   「新しいと確かめた世代」と「実際に読んだ行」がずれる。
  let n = 0;
  const env = fakeEnv({ quota: [qRow], count: 3 });
  const base = env.DB.prepare.bind(env.DB);
  env.DB.prepare = (sql) => {
    const st = base(sql);
    if (/customer_sync_version/.test(sql)) {
      const orig = st.first;
      st.first = async () => (++n === 1
        ? { source_version: 5, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 }   // 1回目：追いついている
        : { source_version: 6, built_version: 5, built_quota_rows: 1, built_pack_rows: 0 }); // 2回目：読んでいる間に入力が来た
    }
    return st;
  };
  ok('⑫-b★読み終わったあとにもう一度世代を見る',
     (await readRemainFromD1(env, 'C1', now, { nowMs: now })) === null && n === 2,
     `世代を読んだ回数=${n}。1回なら窓が開いたまま`);
}

// ---------- 12-c. ★世代の印を書き忘れた行を「契約なし」と答えない ----------
//   ★2026-10-09・設計13 関門①の指摘
//     「世代の印が無い行は読まれない＝写しへ落ちる」は**成立しない**。
//     下の組み立ては、枠0行でも「契約が無い会員」として正常に答えてしまう。
//     ＝印を書き忘れると**月額会員の画面から残数が消える**。間違った側に倒れる。
{
  //   作り直しは枠1行を書いたと記録しているが、実際には読めない（印の書き忘れ）
  const env = fakeEnv({ version: { source_version: 5, built_version: 5,
                                   built_quota_rows: 1, built_pack_rows: 0 },
                        quota: [], count: 3 });
  const r = await readRemainDiag(env, 'C1', now, { nowMs: now });
  ok('⑫-c★行数が合わなければ答えない', r.value === null && r.status === 'row_count_mismatch',
     JSON.stringify(r));
  ok('⑫-c 何行足りないかを残す', /枠 0\/1/.test(r.reason || ''), r.reason);
}
{
  //   チケットだけ多い（枠は合っている）＝打ち消し合わないことを確かめる
  const env = fakeEnv({ version: { source_version: 5, built_version: 5,
                                   built_quota_rows: 1, built_pack_rows: 0 },
                        quota: [qRow],
                        packs: [{ pack_id: 'p', kind: 'normal', total: 1, used: 0, opening_used: 0,
                                  valid_from: 0, valid_to: now + 86400000 }], count: 3 });
  const r = await readRemainDiag(env, 'C1', now, { nowMs: now });
  ok('⑫-c★枠が合っていてもチケットが合わなければ答えない',
     r.status === 'row_count_mismatch', JSON.stringify(r));
}
{
  //   記録が無い（まだ作り直していない）
  const env = fakeEnv({ version: { source_version: 5, built_version: 5 }, quota: [qRow], count: 3 });
  const r = await readRemainDiag(env, 'C1', now, { nowMs: now });
  ok('⑫-c★行数の記録が無ければ答えない', r.status === 'row_count_missing', JSON.stringify(r));
}
{
  //   ★いまの世代で絞って読んでいることを文で確かめる
  const SRC2 = readFileSync(join(ROOT, 'worker/src/lib/remain-from-d1.js'), 'utf8');
  ok('⑫-c★枠は世代で絞る',
     /FROM monthly_quota WHERE customer_id = \? AND built_version = \?/.test(SRC2));
  ok('⑫-c★チケットも世代で絞る',
     /FROM ticket_packs WHERE customer_id = \? AND built_version = \?/.test(SRC2));
  ok('⑫-c★月額は全部の月を読む（2か月に絞らない）',
     !/FROM monthly_quota WHERE customer_id = \? AND month_key IN/.test(SRC2),
     '書く側は全月を作るので、2か月だけ読むと件数の照合が成り立たない');
}

// ---------- 13. まだ顧客に出していないこと ----------
{
  const BOOT = readFileSync(join(ROOT, 'worker/src/routes/boot.js'), 'utf8');
  ok('⑬★まだ読み取りに繋いでいない', !/readRemainFromD1/.test(BOOT),
     '手順3（shadow）で食い違いを数えてから繋ぐ');
}

console.log(`\n${fail ? '❌' : '✅'} D1から残数を作る 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
