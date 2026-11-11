// 設計38 §12-1：メモの読み取り（parseMemo）の実例 P1〜P63 を、本番の liff/karte.js から _t.parseMemo を取り出して通す
//   実行: node worker/test/liff-memo-parse.test.js
//
//   ★倒れる向き：読み取れないもの・autoKnown と完全一致しない名前・括弧書きは pending（決定待ち）に入り、items に入らない
//   ★今日＝2026-11-06。autoKnown・suggestKnown は §12-1 冒頭のとおり（suggestKnown は過去の自由文に健康の文が種目名として入っていた場合を模す）
//   ★文字列は設計の例だけ（実在の会員の名前・会話を書かない）

import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '../..');
const require = createRequire(join(homedir(), '.cache/claude-node/package.json'));
const { JSDOM } = require('jsdom');
const SRC = readFileSync(join(ROOT, 'liff/karte.js'), 'utf8');

let pass = 0, fail = 0;
function ok(name, cond, detail) { if (cond) pass++; else { fail++; console.log(`❌ ${name}${detail ? '\n   ' + detail : ''}`); } }

//   本番の karte.js をそのまま読み込み、検査用の _t から取り出す
const dom = new JSDOM('<!doctype html><html><body></body></html>', { runScripts: 'outside-only', url: 'https://reservation.tokowaka-gym.com/liff/' });
const w = dom.window;
w.state = { trainerId: 'T1' }; w.alert = () => {}; w.fetch = async () => ({ json: async () => ({ success: true }) });
w.eval(SRC);
const parseMemo = w.KarteUI._t.parseMemo;

const TODAY = '2026-11-06';
const AUTO = ['腸腰筋ストレッチ', 'アーチスクワット', 'フロアアブ', 'ヒップリフト', 'ラットプルダウン', 'ドンキーキック', 'ルーマニアン片足', 'スクワット', 'ベンチプレス', 'プランク', 'カール', 'ディップス', 'ランジ', 'クランチ'];
const SUGG = ['腰が痛い', '右膝に違和感', '血圧の薬', '体調が悪い', 'ｽｸﾜｯﾄ'];
//   jsdom の別の世界の配列・オブジェクトを、この世界の JSON に直してから比べる
const run = (text, auto = AUTO, sugg = SUGG) => JSON.parse(JSON.stringify(parseMemo(text, TODAY, auto, sugg)));

//   比べやすい書き方：重さ×回数（自重は 0）・+補助・!＝無理やり・→ドロップ
const segS = (s) => `${s.w === '' ? '0' : s.w}×${s.r}${s.assist != null ? '+' + s.assist : ''}${s.forced ? '!' : ''}`;
const setS = (s) => segS(s) + (s.drops || []).map((d) => '→' + segS(d)).join('');
const itemS = (it) => `${it.exercise}${it.doneOnly ? '(実施)' : ''}:${it.sets.map(setS).join(' ')}`;
const itemsS = (r) => r.items.map(itemS).join(' / ');
const kinds = (r) => r.pending.map((p) => p.kind).join(',');
const show = (r) => JSON.stringify({ date: r.date, items: itemsS(r), pending: r.pending });
const noAutoName = (r, name) => !r.items.some((it) => it.exercise === name);
//   原文のどこかが決定待ちに残っているか（黙って捨てていない）
const kept = (r, frag) => r.pending.some((p) => p.text.includes(frag));

const EXAMPLE = `9/18

腸腰筋ストレッチ
アーチスクワット
フロアアブ
0×10 10×10+0×10 10×10+0×10
ヒップリフト
30×10 50×10+5  80×5(できない)60×10+5 60×10+5
ラットプルダウン
10×10 15×10 20×10
ドンキーキック
60×10 80×10
ルーマニアン片足
9×10 14×10`;
const EXAMPLE_ITEMS = '腸腰筋ストレッチ(実施): / アーチスクワット(実施): / フロアアブ:0×10 10×10→0×10 10×10→0×10 / ヒップリフト:30×10 50×10+5 80×5! 60×10+5 60×10+5 / ラットプルダウン:10×10 15×10 20×10 / ドンキーキック:60×10 80×10 / ルーマニアン片足:9×10 14×10';

// ================= P0 純粋関数（I63） =================
{
  const m = SRC.match(/［memo-parse ここから］([\s\S]*?)［memo-parse ここまで］/);
  ok('P0-1 読み取りの区画がある', !!m);
  const body = (m ? m[1] : '').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  ok('P0-2 ★DOM・保存領域・通信・console に触れない', !/document|localStorage|sessionStorage|fetch\(|console|navigator|XMLHttpRequest|window\./.test(body));
  ok('P0-3 _t から呼べる', typeof parseMemo === 'function');
}

// ================= P1〜P63 =================
{
  const r = run(EXAMPLE);
  ok('P1 オーナーの例：日付・7種目・決定待ち0', r.date === '2026-09-18' && itemsS(r) === EXAMPLE_ITEMS && r.pending.length === 0, show(r));
  const fa = r.items[2];
  ok('P1 自重は w:\'\'（ドロップの段も）・r は文字列', fa?.sets[0]?.w === '' && fa?.sets[1]?.w === '10' && fa?.sets[1]?.r === '10' && fa?.sets[1]?.drops?.[0]?.w === '' && fa?.sets[1]?.drops?.[0]?.r === '10', JSON.stringify(fa));
  ok('P1 補助は回数に足さない・無理やりは真偽値', r.items[3]?.sets[1]?.r === '10' && r.items[3]?.sets[1]?.assist === 5 && r.items[3]?.sets[2]?.forced === true && r.items[3]?.sets[0]?.forced === false && r.items[3]?.sets[0]?.assist === null);
}
{
  for (const [label, sugg] of [['', SUGG], ['（suggestKnown に例の名前を全部入れても同じ）', SUGG.concat(AUTO)]]) {
    const r = run(EXAMPLE, [], sugg);
    const names = r.pending.filter((p) => p.kind === 'name');
    ok('P1b autoKnown＝空：items 0・pending 7（name）' + label, r.items.length === 0 && r.pending.length === 7 && names.length === 7, show(r));
    const hip = names.find((p) => p.parsed?.exercise === 'ヒップリフト');
    ok('P1b 名前の下の数値が一緒に下見に入る' + label, hip && hip.parsed?.sets.map(setS).join(' ') === '30×10 50×10+5 80×5! 60×10+5 60×10+5' && hip.lines.length === 2
       && names.find((p) => p.parsed?.exercise === 'フロアアブ').parsed?.sets.length === 3, JSON.stringify(hip));
  }
}
const one = (id, text, expect, auto) => { const r = run(text, auto); ok(`${id} ${JSON.stringify(text).slice(0, 40)} → ${expect}`, itemsS(r) === expect && r.pending.length === 0, show(r)); return r; };
one('P2', 'スクワット\n50×10', 'スクワット:50×10');
one('P3', 'スクワット\n50x10 50X10 50*10 50＊10 50✕10', 'スクワット:50×10 50×10 50×10 50×10 50×10');
one('P4', 'スクワット\n５０×１０　６０×８', 'スクワット:50×10 60×8');
one('P5', 'スクワット\n50kg×10 60ｋｇ×8回', 'スクワット:50×10 60×8');
{ const r = one('P6', 'プランク\n0×10', 'プランク:0×10'); ok('P6 自重は w:\'\'', r.items[0]?.sets[0]?.w === ''); }
one('P7', 'ヒップリフト\n50×10+5', 'ヒップリフト:50×10+5');
one('P8', 'ヒップリフト\n50×10＋5回', 'ヒップリフト:50×10+5');
{ const r = one('P9', 'フロアアブ\n10×10+0×10', 'フロアアブ:10×10→0×10'); ok('P9 ドロップは本セットの下（セットは1つ）・補助なし', r.items[0]?.sets.length === 1 && r.items[0]?.sets[0]?.assist === null && r.items[0]?.sets[0]?.drops?.[0].assist === null); }
{ const r = one('P10', 'フロアアブ\n10×10+0×10+5', 'フロアアブ:10×10→0×10+5'); ok('P10 補助は最後の段に付く', r.items[0]?.sets[0]?.assist === null && r.items[0]?.sets[0]?.drops?.[0].assist === 5); }
one('P11', 'カール\n20×10+15×10+10×10+5×10', 'カール:20×10→15×10→10×10→5×10');
{
  const r = run('カール\n20×10+15×10+10×10+5×10+3×10');
  ok('P12 ドロップ4段：決定待ち（limit）・items に入らない', kinds(r) === 'limit' && r.items[0]?.sets.length === 0 && !r.items[0]?.doneOnly, show(r));
}
one('P13', 'ヒップリフト\n80×5(できない)', 'ヒップリフト:80×5!');
one('P14', 'ヒップリフト\n80×5（出来ない）', 'ヒップリフト:80×5!');
one('P15', 'ヒップリフト\n80×5(できない)60×10+5', 'ヒップリフト:80×5! 60×10+5');
{
  const r = run('ディップス\n0×8(補助)');
  ok('P16 (補助)：決定待ち（paren）・セット0・doneOnly にもならない', kinds(r) === 'paren' && itemsS(r) === 'ディップス:' && r.items[0]?.doneOnly === false, show(r));
  ok('P16 括弧の中はメモに入らない（下見にだけ）', !JSON.stringify(r.items).includes('補助') && r.pending[0]?.parsed?.paren === '補助' && r.pending[0]?.text === '0×8(補助)', show(r));
}
{
  const r = run('ランジ\n10×10(片足)');
  ok('P17 (片足)：決定待ち（paren）', kinds(r) === 'paren' && itemsS(r) === 'ランジ:' && !JSON.stringify(r.items).includes('片足'), show(r));
}
one('P18', 'ラットプルダウン 10×10 15×10', 'ラットプルダウン:10×10 15×10');
one('P19', 'ベンチプレス40×10', 'ベンチプレス:40×10');
{
  const r = run('45度レッグプレス');
  ok('P20 45度レッグプレス：決定待ち（name）', kinds(r) === 'name' && r.items.length === 0 && r.pending[0]?.parsed?.exercise === '45度レッグプレス', show(r));
}
one('P21', 'スクワット\n130×10', 'スクワット:130×10');
{ const r = one('P22', 'スクワット\n12.5×10', 'スクワット:12.5×10'); ok('P22 w は "12.5"', r.items[0]?.sets[0]?.w === '12.5'); }
{
  const r = run('スクワット\n50×0 50×101 501×10');
  ok('P23 50×0・50×101・501×10：3つとも決定待ち（items に入らない）', r.items[0]?.sets.length === 0 && /^(line|tail)$/.test(kinds(r)) && kept(r, '50×0') && kept(r, '50×101') && kept(r, '501×10'), show(r));
}
{
  const r = run('スクワット\n50×10×3');
  ok('P24 50×10×3：決定待ち（3セットと推測しない・50×10 も入れない）', r.items[0]?.sets.length === 0 && r.pending.length === 1 && kept(r, '50×10×3'), show(r));
}
{
  const r = run('クランチ\n20回');
  ok('P25 20回：決定待ち・doneOnly にもしない', r.items[0]?.sets.length === 0 && !r.items[0]?.doneOnly && kept(r, '20回'), show(r));
}
{
  const r = run('プランク\n60秒');
  ok('P26 60秒：決定待ち', r.items[0]?.sets.length === 0 && !r.items[0]?.doneOnly && kept(r, '60秒'), show(r));
}
for (const [id, d] of [['P27', '9/18(木)'], ['P28', '9月18日'], ['P29', '2026/9/18']]) {
  const r = run(`${d}\nスクワット\n50×10`);
  ok(`${id} ${d} → 2026-09-18`, r.date === '2026-09-18' && itemsS(r) === 'スクワット:50×10' && r.pending.length === 0, show(r));
}
{
  const r = run('12/24\nスクワット\n50×10');
  ok('P30 12/24（年なし・今日より後）→ 2025-12-24', r.date === '2025-12-24' && r.pending.length === 0, show(r));
}
{
  const r = run('2/30\nスクワット\n50×10');
  ok('P31 2/30：date null・bad_date', r.date === null && kinds(r) === 'bad_date' && itemsS(r) === 'スクワット:50×10', show(r));
}
{
  const r = run('2027/1/1\nスクワット\n50×10');
  ok('P32 2027/1/1（未来）：date null・bad_date', r.date === null && kinds(r) === 'bad_date', show(r));
}
{
  const r = run('9/18\nスクワット\n50×10\n9/20\nベンチプレス\n40×10');
  ok('P33 2つ目の日付で止める：9/18 の1種目だけ・second_date 3行', r.date === '2026-09-18' && itemsS(r) === 'スクワット:50×10' && kinds(r) === 'second_date'
     && JSON.stringify(r.pending[0]?.lines) === '[4,5,6]' && r.pending[0]?.text === '9/20\nベンチプレス\n40×10', show(r));
}
{
  const r = run('50×10\nスクワット\n60×10');
  ok('P34 種目の無い数値：no_exercise・スクワットは [60×10]', kinds(r) === 'no_exercise' && JSON.stringify(r.pending[0]?.lines) === '[1]' && itemsS(r) === 'スクワット:60×10', show(r));
}
one('P35', '\n\n  スクワット  \n\n  50×10  \n', 'スクワット:50×10');
one('P36', 'スクワット\n50×10\n60×10', 'スクワット:50×10 60×10');
{
  const long = 'あ'.repeat(51);
  const r = run(long);
  ok('P37 51字の文：決定待ち（name）・どこにも自動で入らない', r.items.length === 0 && kinds(r) === 'name' && r.pending[0]?.text === long, show(r));
}
{
  const r = run('スクワット\n' + Array(11).fill('50×10').join(' '));
  ok('P38 11セット：10セット・11本目は limit', r.items[0]?.sets.length === 10 && kinds(r) === 'limit', show(r));
  const r2 = run('スクワット\n' + Array(11).fill('50×10').join('\n'));
  ok('P38 11行に分けても同じ', r2.items[0]?.sets.length === 10 && kinds(r2) === 'limit' && JSON.stringify(r2.pending[0]?.lines) === '[12]', show(r2));
}
{
  const r = run('スクワット\n50×10+5+3');
  ok('P39 補助2つ：決定待ち', r.items[0]?.sets.length === 0 && r.pending.length === 1 && kept(r, '50×10+5+3'), show(r));
}
one('P40', 'スクワット\n50かける10', 'スクワット:50×10');
{
  const r = run('スクワット\n50×10 ああ');
  ok('P41 読めた分は入れ、残りは tail「ああ」', itemsS(r) === 'スクワット:50×10' && kinds(r) === 'tail' && r.pending[0]?.text === 'ああ' && r.pending[0]?.item === 0, show(r));
}
one('P42', '1. スクワット\n・ベンチプレス\n40×10', 'スクワット(実施): / ベンチプレス:40×10');
{
  const r = run('ｽｸﾜｯﾄ\n50×10');
  const c = (r.pending[0] || {}).candidates || [];
  ok('P43 ｽｸﾜｯﾄ：決定待ち（name）・自動では寄せない', r.items.length === 0 && kinds(r) === 'name' && r.pending[0]?.parsed?.sets.map(setS).join() === '50×10', show(r));
  ok('P43 候補「スクワット」（auto）を出す', c.some((x) => x.name === 'スクワット' && x.source === 'auto'), JSON.stringify(c));
}
{
  const names = Array.from({ length: 21 }, (_, i) => '種目' + (i + 1));
  const r = run(names.join('\n'), names);
  ok('P44 21種目：20種目・21個目は limit', r.items.length === 20 && kinds(r) === 'limit' && r.pending[0]?.text === '種目21' && r.items.every((it) => it.doneOnly), show(r));
}
{
  //   ドロップつき10セット×3種目＝60（本セット30＋ドロップ30）。4種目目の1セットで61
  const ten = Array(10).fill('10×10+0×10').join(' ');
  const r = run(`スクワット\n${ten}\nベンチプレス\n${ten}\nカール\n${ten}\nランジ\n50×10 60×10`);
  const sent = r.items.reduce((n, it) => n + it.sets.reduce((m, s) => m + 1 + s.drops.length, 0), 0);
  ok('P45 合計61：60まで・残りは limit（ドロップも1つと数える）', sent === 60 && r.items[3]?.sets.length === 0 && kinds(r) === 'limit,limit', show(r));
  const r2 = run(`スクワット\n${ten}\nベンチプレス\n${ten}\nカール\n${Array(9).fill('10×10+0×10').join(' ')} 50×10 10×10+0×10`);
  const sent2 = r2.items.reduce((n, it) => n + it.sets.reduce((m, s) => m + 1 + s.drops.length, 0), 0);
  ok('P45 59 のときドロップつき（2つ分）は入れない', sent2 === 59 && kinds(r2) === 'limit', show(r2));
}
{
  const r = run('スクワット\n50×10\nスクワット\n60×10');
  ok('P46 同じ名前の2つの種目は混ぜない（ord 1・ord 2）', itemsS(r) === 'スクワット:50×10 / スクワット:60×10' && r.pending.length === 0, show(r));
}
{
  const r = run('スクワット\n50×10+5+40×10');
  ok('P47 補助の後ろにドロップ：決定待ち', r.items[0]?.sets.length === 0 && r.pending.length === 1 && kept(r, '50×10+5+40×10'), show(r));
}
{
  const r = run('スクワット 50×10 60×10', []);
  ok('P48 autoKnown 空：決定待ち（name・下見に2セット）', r.items.length === 0 && kinds(r) === 'name' && r.pending[0]?.parsed?.exercise === 'スクワット' && r.pending[0]?.parsed?.sets.map(setS).join(' ') === '50×10 60×10', show(r));
}
{
  const r = run('45度レッグプレス50×10');
  ok('P49 前方が autoKnown と一致しないつながる形：決定待ち', r.items.length === 0 && r.pending.length === 1 && kept(r, '45度レッグプレス50×10'), show(r));
}
{
  const r = run('スクワット\n12.34×10');
  ok('P50 12.34：丸めず決定待ち', r.items[0]?.sets.length === 0 && kept(r, '12.34×10'), show(r));
}
{
  const r = run('スクワット\n50キロ10回');
  ok('P51 50キロ10回（×なし）：決定待ち', r.items[0]?.sets.length === 0 && kept(r, '50キロ10回'), show(r));
}
for (const [id, t] of [['P52', '腰が痛い'], ['P53', '右膝に違和感'], ['P54', '血圧の薬'], ['P55', '体調が悪い']]) {
  const r = run(t);
  const c = (r.pending[0] || {}).candidates || [];
  ok(`${id} ★${t}：決定待ち（name）・items 0（suggestKnown に同じ文字列があっても自動確定しない）`, r.items.length === 0 && kinds(r) === 'name', show(r));
  ok(`${id} 候補には出る（source は suggest＝押しても仮に入るだけ）`, c.length === 1 && c[0].name === t && c[0].source === 'suggest', JSON.stringify(c));
}
{
  const r = run('ヒップリフト\n80×5(右膝痛)');
  ok('P56 ★(右膝痛)：決定待ち（paren）・セットのメモにも入らない', kinds(r) === 'paren' && r.items[0]?.sets.length === 0 && !JSON.stringify(r.items).includes('右膝'), show(r));
}
{
  const r = run('腰が痛い\n0×10');
  ok('P57 ★腰が痛い＋数値：決定待ち（name・下見に [0×10]）・items 0', r.items.length === 0 && kinds(r) === 'name' && r.pending[0]?.parsed?.sets.map(setS).join() === '0×10' && JSON.stringify(r.pending[0]?.lines) === '[1,2]', show(r));
}
{
  const r = run('ｽｸﾜｯﾄ\n50×10');
  const c = (r.pending[0] || {}).candidates || [];
  ok('P58 ｽｸﾜｯﾄ：候補は「ｽｸﾜｯﾄ」（suggest）と「スクワット」（auto）の両方・自動では寄せない', r.items.length === 0
     && c.some((x) => x.name === 'ｽｸﾜｯﾄ' && x.source === 'suggest') && c.some((x) => x.name === 'スクワット' && x.source === 'auto') && c.length === 2, JSON.stringify(c));
}
{
  const r = run('腰が痛い50×10');
  ok('P59 ★腰が痛い50×10：決定待ち（前方一致は autoKnown だけ）', r.items.length === 0 && r.pending.length === 1 && kept(r, '腰が痛い50×10'), show(r));
}
{
  const r = run('ゴブレットスクワット\n30×10', AUTO, SUGG.concat(['ゴブレットスクワット']));
  ok('P60 suggestKnown にだけある名前：決定待ち（最近の種目でも自動確定しない）', r.items.length === 0 && kinds(r) === 'name' && r.pending[0]?.candidates.some((x) => x.name === 'ゴブレットスクワット' && x.source === 'suggest'), show(r));
  const r2 = run('ゴブレットスクワット\n30×10', AUTO.concat(['ゴブレットスクワット']), SUGG.concat(['ゴブレットスクワット']));
  ok('P61 共有の種目（autoKnown）に登録された後は種目として自動で入る', itemsS(r2) === 'ゴブレットスクワット:30×10' && r2.pending.length === 0, show(r2));
}
one('P62', '45度レッグプレス50×10', '45度レッグプレス:50×10', ['レッグプレス', '45度レッグプレス']);
{
  const r = run('カール110×10', ['カール', 'カール1']);
  ok('P63 候補が2つ成立（カール1＋10×10／カール＋110×10）：決定待ち', r.items.length === 0 && r.pending.length === 1 && kept(r, 'カール110×10'), show(r));
}

// ================= 補足：引数の型・倒れる向き =================
{
  const r = JSON.parse(JSON.stringify(parseMemo(null, TODAY, null, undefined)));
  ok('X-1 空・null でも落ちない', r.date === null && r.items.length === 0 && r.pending.length === 0);
  const r2 = JSON.parse(JSON.stringify(parseMemo('9/18\nスクワット', 'bad', AUTO, SUGG)));
  ok('X-2 今日が読めないときは日付を入れない（bad_date）', r2.date === null && r2.pending[0]?.kind === 'bad_date');
  const r3 = run('フロアアブ\n10×10+0×10(できない)');
  ok('X-3 ドロップのあるセットの(できない)はどの段か決まらない＝決定待ち（paren）', r3.items[0]?.sets.length === 0 && kinds(r3) === 'paren', show(r3));
}

// ================= 関門②の指摘（2026-11-07） =================
{
  //   Codex 高：年の無い「.」区切りを日付にしない（12.5kg を書いた行が 12/5 の日付にならない）
  const r = run('12.5\nスクワット\n50×10');
  ok('G1 「12.5」だけの行は日付にしない（決定待ち）', r.date === null && itemsS(r) === 'スクワット:50×10' && kept(r, '12.5') && !r.pending.some((p) => p.kind === 'bad_date' || p.kind === 'second_date'), show(r));
  const r2 = run('9/18\nスクワット\n50×10\n12.5\nベンチプレス\n40×10');
  ok('G2 2行目以降の「12.5」で2つ目の日付として止めない', r2.date === '2026-09-18' && itemsS(r2) === 'スクワット:50×10 / ベンチプレス:40×10' && kept(r2, '12.5') && !r2.pending.some((p) => p.kind === 'second_date'), show(r2));
  const r3 = run('2026.9.18\nスクワット\n50×10');
  ok('G3 年のある「.」区切りは日付として読む', r3.date === '2026-09-18' && r3.pending.length === 0, show(r3));
  //   画面担当の指摘：名前の決定待ちの下の、下見に入らない行は別の決定待ちに出す（「種目にする」で黙って消えない）
  const r4 = run('ゴブレット\n30×10\n50×10×3');
  ok('G4 知らない名前の下の文法に合わない数値の行は、名前の決定待ちと別の決定待ち', kinds(r4) === 'name,line' && r4.pending[0].parsed.sets.length === 1 && r4.pending[1].text === '50×10×3', show(r4));
  const r5 = run('ゴブレット\n30×10 50×10(片足)');
  ok('G5 知らない名前の下の括弧書きのセットは別の決定待ち（下見に入らない）', kinds(r5) === 'name,line' && r5.pending[0].parsed.sets.length === 1 && r5.pending[1].text === '50×10(片足)', show(r5));
  const r6 = run('ゴブレット\n30×10\n40×10 ああ');
  ok('G6 知らない名前の下の行の読めない残りは別の決定待ち', kinds(r6) === 'name,line' && r6.pending[0].parsed.sets.length === 2 && r6.pending[1].text === 'ああ', show(r6));
}

// ================= 設計40 普段の書き方（P64〜） =================
const pro = (r) => r.pending.map((p) => p.propose || '-').join(',');
{
  // G1 日付＋時刻
  const r1 = run('11/3(火)12:30～\nスクワット\n50×10');
  ok('P64 G1 日付＋時刻（～）：日付として読む', r1.date === '2025-11-03' || r1.date === '2026-11-03', show(r1));
  ok('P64b G1 時刻は保存しない・決定待ちなし', r1.pending.length === 0 && itemsS(r1) === 'スクワット:50×10', show(r1));
  const r2 = run('11/3 99:99\nスクワット\n50×10');
  ok('P65 G1 実在しない時刻（99:99）は日付にしない', r2.date === null, show(r2));
  // G2 known 名＋数値（空白なし）＋残り
  const r3 = run('ラットプルダウン25×10 25×10 背中に入った');
  ok('P66 G2 known名＋数値（空白なし）＋所感：種目と2セットは自動', itemsS(r3) === 'ラットプルダウン:25×10 25×10', show(r3));
  ok('P66b G3 所感は tail・提案「そのセットのメモ」（2セット目）', kinds(r3) === 'tail' && r3.pending[0].propose === 'setnote' && r3.pending[0].setAt === 1 && r3.pending[0].text === '背中に入った', show(r3));
  // G5 かな・漢字の区切り／単位は読まない
  const r4 = run('スクワット\n20×10トップで抜ける');
  ok('P67 G5 数値の直後のかな・漢字は区切り：20×10 は自動・残りは提案つき tail', itemsS(r4) === 'スクワット:20×10' && kinds(r4) === 'tail' && r4.pending[0].propose === 'setnote', show(r4));
  for (const [id, t] of [['P68a', '50×10キロ'], ['P68b', '60×5秒'], ['P68c', '50×10セット'], ['P68d', '50×10ずつ'], ['P68e', '50×10回3セット'], ['P68f', '50×10回目']]) {
    const r = run('スクワット\n' + t);
    ok(`${id} G5 ★${t}：数値も items に入らない（行ごと決定待ち）`, r.items[0]?.sets.length === 0 && kept(r, t), show(r));
  }
  // G6 重さ無し
  const r5 = run('ディップス\n×20 ×20\n×10+5');
  ok('P69 G6 重さ無しの ×20 は自重・+5 は補助', itemsS(r5) === 'ディップス:0×20 0×20 0×10+5' && r5.pending.length === 0, show(r5));
  const r6 = run('スクワット\n×8クリア');
  ok('P70 G6 ★×8クリア（かなが直結）は行ごと決定待ち', r6.items[0]?.sets.length === 0 && kept(r6, '×8クリア'), show(r6));
  const r7 = run('スクワット×8クリア');
  ok('P70b G6 ★スクワット×8クリア も自動で種目＋セットにしない', !r7.items.some((it) => it.sets.length), show(r7));
  const r8 = run('スクワット\n50×10+×10');
  ok('P71 G6 ドロップの段の重さ無しは読まない', r8.items[0]?.sets.length === 0, show(r8));
  // G7 矢印
  const r9 = run('ベンチプレス\n50×3→60×2 70×1->75×1');
  ok('P72 G7 矢印は区切り', itemsS(r9) === 'ベンチプレス:50×3 60×2 70×1 75×1' && r9.pending.length === 0, show(r9));
  // G4 known 名＋空白＋文
  const r10 = run('ベンチプレス　パワーフォームで\n65×3');
  ok('P73 G4 known名＋全角空白＋文：種目は自動・文は tail で提案「種目のメモ」', itemsS(r10) === 'ベンチプレス:65×3' && kinds(r10) === 'tail' && r10.pending[0].propose === 'exnote' && r10.pending[0].text === 'パワーフォームで' && r10.pending[0].item === 0, show(r10));
  const r10b = run('スクワット 50×10×3');
  ok('P73b G4 は数値らしい残りには使わない（今どおり line）', r10b.items.length === 0 && kinds(r10b) === 'line', show(r10b));
  // G8 箇条書き
  const r11 = run('ベンチプレス\n65×3\n・3×3余裕で上がったので次67.5×');
  ok('P74 G8 ★箇条書きの中の 3×3 はセットにしない・提案「種目のメモ」', itemsS(r11) === 'ベンチプレス:65×3' && kinds(r11) === 'name' && r11.pending[0].propose === 'exnote' && r11.pending[0].after === 0, show(r11));
  const r12 = run('スクワット\n50×10\n・ベンチ台の高さ\n40×10');
  ok('P75 sealed ★箇条書きの後の数値は前の種目に付けない（item の無い line）', itemsS(r12) === 'スクワット:50×10' && kinds(r12) === 'name,line' && r12.pending[1].item === undefined && r12.pending[1].parsed === undefined && !r12.pending[1].propose, show(r12));
  const r13 = run('スクワット\n・ひざ\n40×10\n50×10\nベンチプレス\n60×5');
  ok('P76 sealed は続く数値行すべてに効き、次の種目で解ける', kinds(r13) === 'name,line,line' && itemsS(r13) === 'スクワット(実施): / ベンチプレス:60×5', show(r13));
  one('P77', '1. スクワット\n・ベンチプレス\n40×10', 'スクワット(実施): / ベンチプレス:40×10');   // P42 と同じ（箇条書き＋完全一致は種目）
  // G9 敬称
  const r14 = run('スクワット\n田中様1回目\n40×10');
  ok('P78 G9 敬称の行：提案 drop・pii・名前を〇〇に', r14.pending[0].propose === 'drop' && r14.pending[0].pii === true && r14.pending[0].masked === '〇〇様1回目', show(r14));
  ok('P78b G9 ★名前の行の後の数値はスクワットに付けない（item・下見・提案の無い line で残る）', r14.items[0].sets.length === 0 && kinds(r14) === 'name,line' && r14.pending[1].text === '40×10' && r14.pending[1].item === undefined && r14.pending[1].parsed === undefined && r14.pending[1].propose === undefined, show(r14));
  const r14b = run('田中様1回目\nたなかさん\nスクワット\n50×10', AUTO.concat(['田中様1回目', 'たなかさん']));
  ok('P78c ★共有の種目に名前が登録されていても種目にしない（提案なし・〇〇にしない＝原文で1件ずつ）', itemsS(r14b) === 'スクワット:50×10' && kinds(r14b) === 'name,name' && r14b.pending.every((p) => !p.propose && !p.pii), show(r14b));
  const HELD = AUTO.concat(['たなかさん', '赤ちゃんのポーズ']);
  const r14c = run('スクワット\n50×10\nたなかさん50×10\nたなかさん フォーム確認', HELD);
  ok('P78d ★登録済みの名前は G2（名前＋数値）・G4（名前＋文）でも種目にしない', itemsS(r14c) === 'スクワット:50×10' && !r14c.items.some((i) => i.exercise === 'たなかさん') && kept(r14c, 'たなかさん50×10') && kept(r14c, 'たなかさん フォーム確認') && r14c.pending.every((p) => !p.propose), show(r14c));
  const r14d = run('赤ちゃんのポーズ\n赤ちゃんのポーズ10×10\n王様のポーズ', HELD);
  ok('P78e ★登録済みの「赤ちゃんのポーズ」は捨てる提案にしない（pii なし・提案なし）・数値は下見に残る', r14d.pending.length >= 2 && r14d.pending.slice(0, 2).every((p) => !p.pii && !p.propose) && r14d.pending.some((p) => p.parsed && p.parsed.sets && p.parsed.sets.length === 1), show(r14d));
  ok('P78f 未登録の「王様のポーズ」は名前の印として捨てる提案（〇〇様のポーズ・原文は計画で判別できる）', r14d.pending[r14d.pending.length - 1].propose === 'drop' && r14d.pending[r14d.pending.length - 1].masked === '〇〇様のポーズ', show(r14d));
  for (const t of ['コウダさん', '佐藤氏', '健太くん', '花子ちゃん', '鈴木君']) {
    const r = run('スクワット\n50×10\n' + t);
    ok(`P79 G9 ${t}：drop`, r.pending[0]?.propose === 'drop' && r.pending[0]?.masked.startsWith('〇〇'), show(r));
  }
  for (const t of ['たくさんできた', '君側を意識']) {
    const r = run('スクワット\n50×10\n' + t);
    ok(`P80 G9 ★${t}：drop にしない・G9b で提案もしない（1件ずつ）`, r.pending.length === 1 && !r.pending[0].pii && !r.pending[0].propose, show(r));
  }
  // G9b 弱い名前の印
  for (const t of ['たなかさん 1回目', 'たなかさんでした', '田中太郎 1回目', '初回の方']) {
    const r = run('スクワット\n50×10\n' + t);
    ok(`P81 G9b ★${t}：提案なし・自動で捨てない`, r.pending.length === 1 && !r.pending[0].propose && kept(r, t), show(r));
  }
  const r15 = run('スクワット\n50×10 たなかさん');
  ok('P81b G9b ★tail の敬称にも提案しない', kinds(r15) === 'tail' && !r15.pending[0].propose, show(r15));
  // §5 健康の言葉
  for (const t of ['腰が痛い感じ', '体調が悪い', '血圧が高いと言っていた', 'めまいあり', '頭痛あり', '薬を飲んでいた', '腰が痛かった']) {
    const r = run('スクワット\n50×10\n' + t);
    ok(`P82 §5 ★${t}：提案なし`, r.pending.length === 1 && !r.pending[0].propose, show(r));
  }
  const r16 = run('スクワット\n50×10 膝に違和感');
  ok('P82b §5 ★tail の健康の言葉にも提案しない（数値は入る）', itemsS(r16) === 'スクワット:50×10' && !r16.pending[0].propose, show(r16));
  // G10 閉じない括弧
  const r17 = run('(ベンチプレス\n9×15 9×10+5');
  ok('P83 G10 閉じない括弧で始まる行は括弧を外して読む', itemsS(r17) === 'ベンチプレス:9×15 9×10+5', show(r17));
  // G11 種目の下の文／短い名詞
  const r18 = run('スクワット\n50×10\n首入れやすくなった\nブックオープニング');
  ok('P84 G11 文は提案「種目のメモ」・短い名詞は提案なし', pro(r18) === 'exnote,-', show(r18));
  const r19 = run('スクワット\n50×10\nゴブレット 片足\n30×10');
  ok('P85 下に数値が続く名前（種目かもしれない）は提案を外す', kinds(r19) === 'name' && !r19.pending[0].propose && r19.pending[0].parsed.sets.length === 1, show(r19));
  // 名前と数値が空白なしで続く形
  const r20 = run('スクワット\n50×10\nインクラインスミス20×10トップで抜ける');
  ok('P86 名前＋数値（空白なし）：名前の決定待ち（下見1セット）＋残りは別の決定待ち（prevPend・note）', kinds(r20) === 'name,name' && r20.pending[0].parsed.exercise === 'インクラインスミス' && r20.pending[0].parsed.sets.length === 1 && r20.pending[1].prevPend === 0 && r20.pending[1].note === 'トップで抜ける' && r20.pending[1].propose === 'exnote', show(r20));
  const r21 = run('スクワット\n50×10\n赤チューブ×10');
  //   設計41 R2（オーナー決定）：種目の下の「色＋チューブ×回数」はその種目のセット。★items には入れず確認の一覧へ（addset）
  ok('P87 道具＋×10：名前に切らない・設計41 R2 で確認の一覧へ（重さなし×10・メモ「赤チューブ」）', kinds(r21) === 'rule' && r21.pending[0].propose === 'addset' && r21.pending[0].parsed.sets[0].note === '赤チューブ' && itemsS(r21) === 'スクワット:50×10', show(r21));
}
// ================= 設計40 実例（トレーナー2人のメモ・お客様名と所感は架空に置換） =================
const MEMO_A = `デッドバグ　×15ずつ 3種類　きつそう
・ 体幹を使う意識

エクスターナルローテーション　肘90度
×20 ×20

背中を台に押しつけて胸椎ストレッチ

ベンチプレス　パワーフォームで
50×3→60×2
65×3 足も背中も使えてる
65×3 安定してる　背中に圧をかける
65×3 余力あり
・3×3余裕で上がったので次67.5×

足上げベンチ
55×10(+3更新)余裕あり
57.5×8 6まで一呼吸　×8クリア
60×5+3 スピード早い
・ 胸を立てる意識

ディップス　初
×5+5自重　フォームうまい
赤チューブ×10
赤チューブ×10+5 テンポよく

(ダンベルフライ9×15 9×10+5
・ 前腕がきつい→グリップを試す`;
const MEMO_B = `11/3(火)12:30～
山田様1回目
ポール
姿勢説明
仰向けチェック 肩が浮く
ブックオープニング
仰向けチェック 肩がつく感覚あり
ラットプルパラレル15×15 挙上あり
チューブプルオーバー 脇締まる感覚〇
壁付けチンイン 下制の感覚あり
ラットプル25×10 25×10 背中に入った
首入れやすくなった
インクラインスミスベンチ20×10トップで圧が抜ける
後ろから背中を支えて腕を曲げ伸ばし
肩の後ろで圧をかける感覚が入った
インクラインスミスベンチ20×10 20×7 トップでも圧が抜けなくなった`;
{
  const FIX = ['ベンチプレス', 'チェストプレス', 'スクワット', 'レッグプレス', 'ヒップスラスト', 'デッドリフト', 'ラットプルダウン', 'シーテッドロウ', 'ショルダープレス', 'サイドレイズ', 'アームカール', 'プランク'];
  const REG = FIX.concat(['デッドバグ', 'エクスターナルローテーション', '足上げベンチ', 'ディップス', 'ダンベルフライ', 'ポール', 'ブックオープニング', 'ラットプルパラレル', 'チューブプルオーバー', '壁付けチンイン', 'ラットプル', 'インクラインスミスベンチ']);
  const cnt = (r) => ({ items: r.items.length, pend: r.pending.length, pro: r.pending.filter((p) => p.propose).length });
  const a1 = run(MEMO_A, FIX, []), a2 = run(MEMO_A, REG, []), b1 = run(MEMO_B, FIX, []), b2 = run(MEMO_B, REG, []);
  ok('P88 実例A 初回：ベンチプレスだけ自動（5セット）', itemsS(a1) === 'ベンチプレス:50×3 60×2 65×3 65×3 65×3', show(a1));
  ok('P88b 実例A 登録後：6種目が自動', a2.items.map((i) => i.exercise).join() === 'デッドバグ,エクスターナルローテーション,ベンチプレス,足上げベンチ,ディップス,ダンベルフライ', show(a2));
  //   設計41 で 3件 → 0件（55×10(+3更新)・余裕あり＝R4、赤チューブ×10＝R2 が提案になった）。胸椎ストレッチを登録すると R3 の1件（一括に入れない）
  ok('P88c 実例A 登録後：1件ずつは0件（設計41）', cnt(a2).pend - cnt(a2).pro === 0, JSON.stringify(cnt(a2)));
  const a3 = run(MEMO_A, REG.concat(['胸椎ストレッチ']), []);
  ok('P88d 設計41 R3：胸椎ストレッチを登録すると、行の途中の種目名は R3（提案なし＝一括に入れない）の1件だけ', cnt(a3).pend - cnt(a3).pro === 1 && a3.pending.some((p) => p.r3 === '胸椎ストレッチ' && !p.propose), JSON.stringify(cnt(a3)));
  ok('P89 実例B：日付 11/3・名前の行は drop（〇〇様1回目）', b1.date?.endsWith('-11-03') && b1.pending[0].propose === 'drop' && b1.pending[0].masked === '〇〇様1回目', show(b1));
  ok('P89b 実例B 登録後：8種目が自動', b2.items.length === 8, show(b2));
  ok('P89c 実例B 登録後：1件ずつはちょうど1件（黙って消えていない）', cnt(b2).pend - cnt(b2).pro === 1, JSON.stringify(cnt(b2)));
  ok('P89d ★実例B：「山田」はどの提案の行き先の文にも入らない（masked のみ）', !b2.pending.some((p) => p.propose && p.propose !== 'drop' && p.text.includes('山田')), show(b2));
}

// ================= 設計41 オーナーに聞いて決めた読み方（R2〜R11）。★新しく読む数字は items に入れず確認の一覧へ（addset） =================
{
  const rk = (r) => r.pending.filter((p) => p.kind === 'rule');
  const rs = (p) => p.parsed.sets.map((x) => setS(x) + (x.note ? '[' + x.note + ']' : '')).join(' ');
  const noRule = (r) => rk(r).length === 0;
  const noSets = (r) => r.items.every((it) => it.sets.length === 0);   // 数字が1つも入っていない（実施のみの表示かどうかは問わない）
  //   R10 話し言葉
  let r = run('ベンチプレス、55キロで5回いきます');
  ok('P90 R10 実際にお願いする言い方：種目は入る・数字は確認の一覧（items に入らない）', itemsS(r) === 'ベンチプレス:' && rk(r).length === 1 && rs(rk(r)[0]) === '55×5' && rk(r)[0].propose === 'addset' && rk(r)[0].item === 0, show(r));
  r = run('スクワット\n50×10\n55キロで5回');
  ok('P91 R10 名前なし：直前の確定済みの種目へ', itemsS(r) === 'スクワット:50×10' && rk(r).length === 1 && rk(r)[0].item === 0 && rs(rk(r)[0]) === '55×5', show(r));
  r = run('スクワット\n55キロで5回、次60キロで3回');
  ok('P92 ★R10 2組の文は読まない（1件ずつ）', noRule(r) && noSets(r) && kept(r, '60キロ'), show(r));
  r = run('スクワット\n55キロで5回にしましょうか');
  ok('P93 ★R11 相談の言い方は読まない', noRule(r) && noSets(r), show(r));
  r = run('スクワット\n五十五キロで五回');
  ok('P94 ★R11 漢数字は読まない', noRule(r) && noSets(r), show(r));
  r = run('スクワット\n５５キロで５レップ');
  ok('P95 R10 全角・レップ', rk(r).length === 1 && rs(rk(r)[0]) === '55×5', show(r));
  r = run('スクワット\n自重で10回');
  ok('P96 R10 自重で＝重さなし', rk(r).length === 1 && rs(rk(r)[0]) === '0×10', show(r));
  r = run('スクワット\n55キロで5回を3セット');
  ok('P97 R10 〜を3セット＝同じセットを3つ', rk(r).length === 1 && rs(rk(r)[0]) === '55×5 55×5 55×5', show(r));
  r = run('スクワット\n55キロで5回を11セット');
  ok('P97b ★R10 11セットは読まない（天井 10）', noRule(r), show(r));
  //   健康・名前・sealed・種目なし・held
  r = run('スクワット\n腰が痛いので自重で10回');
  ok('P98 ★健康の言葉の行には新しい規則を当てない（数字も読まない）', noRule(r) && noSets(r) && kept(r, '腰が痛い'), show(r));
  r = run('スクワット\n赤チューブ×10 違和感あり');
  ok('P98b ★健康の言葉の行：R2 も当てない', noRule(r) && kept(r, '違和感'), show(r));
  r = run('スクワット\n田中さん55キロで5回');
  ok('P99 ★名前らしい印の行には当てない', noRule(r) && kept(r, '田中さん'), show(r));
  r = run('スクワット\n・意識する\n55キロで5回');
  ok('P100 ★sealed 中は当てない', noRule(r), show(r));
  r = run('55キロで5回');
  ok('P101 R10 種目が無ければ読まない（1件ずつ）', noRule(r) && r.items.length === 0 && kept(r, '55キロ'), show(r));
  r = run('赤ちゃんのポーズ、自重で10回', AUTO.concat(['赤ちゃんのポーズ']));
  ok('P102 ★held の名前で始まる行には当てない', noRule(r) && noAutoName(r, '赤ちゃんのポーズ'), show(r));
  //   R9 次・次回
  r = run('スクワット\n50×10\n次60×5');
  ok('P103 R9 次の数字はセットにしない・種目のメモを提案', itemsS(r) === 'スクワット:50×10' && r.pending[0].rule === 'R9' && r.pending[0].propose === 'exnote', show(r));
  r = run('スクワット\n50×10\n次のセットで55キロ5回いきます');
  ok('P103b ★R9 は R10 より先（次の〜は数値にしない）', noRule(r) && r.pending[0].rule === 'R9', show(r));
  //   R7
  r = run('スクワット\n×15ずつ 3種類');
  ok('P104 R7 ×15 を3セット（1つ目にメモ「3種類」）', rk(r).length === 1 && rs(rk(r)[0]) === '0×15[3種類] 0×15 0×15', show(r));
  for (const [t, why] of [['×15ずつ 1種類', 'M=1'], ['×15ずつ 11種類', 'M=11'], ['×0ずつ 3種類', 'N=0'], ['×101ずつ 3種類', 'N=101'], ['×15ずつ 3種類だけ', '後ろに空白なしの文字']]) {
    const x = run('スクワット\n' + t);
    ok('P104x ★R7 読まない：' + why, noRule(x) && noSets(x), show(x));
  }
  r = run('スクワット\n×15ずつ 3種');
  ok('P104y ★R7「3種」は読まない（M種類だけ）', noRule(r) && noSets(r), show(r));
  r = run('スクワット\n×15ずつ 3種類　きつそう');
  ok('P104z 改訂5：R7 の後ろの空白区切りの文＝最後のセットのメモの提案', rk(r).length === 1 && r.pending[1].propose === 'setnote' && r.pending[1].setSq === rk(r)[0].parsed.sets[2].sq, show(r));
  r = run('スクワット\n赤チューブ×10 2回目');
  ok('P104w ★改訂5：後ろの文に数字があれば読まない', noRule(r), show(r));
  //   R8
  r = run('スクワット\n50×10、16+16×10');
  ok('P105e ★改訂5：R8 は区切りの後ろでは読まない（50×10 だけ自動・残りは決定待ち）', noRule(r) && itemsS(r) === 'スクワット:50×10' && kept(r, '16+16'), show(r));
  r = run('スクワット\n16+16×10');
  ok('P105 R8 左右が同じ＝片手16kg×10', rk(r).length === 1 && rs(rk(r)[0]) === '16×10[片手16kgずつ]', show(r));
  r = run('スクワット\n16+12×10');
  ok('P105b ★R8 左右が違えば一部も読まない', noRule(r) && noSets(r) && kept(r, '16+12'), show(r));
  r = run('スクワット\n16.0+16×10');
  ok('P105c R8 数値として等しい', rk(r).length === 1, show(r));
  r = run('スクワット\n片手16+16×10');
  ok('P105d ★R8 前に文字があれば読まない', noRule(r), show(r));
  //   R5・R2
  r = run('ディップス\n×5+5自重');
  ok('P106 R5 ×5+5自重＝重さなし×5＋補助5・メモ「自重」', rk(r).length === 1 && rs(rk(r)[0]) === '0×5+5[自重]', show(r));
  r = run('ディップス\n×5+5自重　フォームうまい');
  ok('P106b R5 後ろの文はそのセットのメモの提案（setSq）', rk(r).length === 1 && r.pending[1].propose === 'setnote' && r.pending[1].setSq === rk(r)[0].parsed.sets[0].sq, show(r));
  r = run('赤チューブ×10');
  ok('P107 ★R2 種目が無ければ読まない', noRule(r), show(r));
  r = run('スクワット\n2号チューブ×10');
  ok('P107b ★R2 色に数字を含む形は読まない', noRule(r), show(r));
  r = run('ディップス\n赤チューブ×10+5');
  ok('P107c R2 補助付き', rk(r).length === 1 && rs(rk(r)[0]) === '0×10+5[赤チューブ]', show(r));
  //   R4・R6
  r = run('スクワット\n50×10(+3更新)');
  ok('P108 R4 括弧1つ・健康語なし＝「セットにして括弧の中をメモに」を提案', r.pending[0].kind === 'paren' && r.pending[0].propose === 'parenset', show(r));
  r = run('スクワット\n50×10(膝痛)');
  ok('P108b ★R4 括弧の中に健康の言葉＝提案しない', r.pending[0].kind === 'paren' && !r.pending[0].propose, show(r));
  r = run('スクワット\n55×10(+3更新)余裕あり');
  ok('P108c R4 括弧の後ろの文＝括弧のセットのメモの提案（setSq）', r.pending[1].propose === 'setnote' && r.pending[1].setSq === r.pending[0].parsed.sets[0].sq, show(r));
  r = run('スクワット\n50×10 60×');
  ok('P109 R6 回数の無いセットはセットにしない・種目のメモを提案', itemsS(r) === 'スクワット:50×10' && r.pending[0].propose === 'exnote', show(r));
  r = run('スクワット\n50×10\n60×');
  ok('P109b R6 行だけでも同じ', itemsS(r) === 'スクワット:50×10' && r.pending[0].propose === 'exnote', show(r));
  //   F 通し番号
  r = run('スクワット\n50×10\n55キロで5回\n60×3');
  const sqs = [r.items[0].sets[0].sq, rk(r)[0].parsed.sets[0].sq, r.items[0].sets[1].sq];
  ok('P110 通し番号はメモの行の順（自動・規則・自動）', sqs[0] < sqs[1] && sqs[1] < sqs[2], JSON.stringify(sqs));
  //   R3
  r = run('ベンチプレス\n50×10\nフォームはスクワットと同じ意識で');
  ok('P111 R3 行の途中の種目名：候補を付け、提案は外す（一括の計画に入れない）', r.pending[0].r3 === 'スクワット' && !r.pending[0].propose, show(r));
  r = run('ベンチプレス\n50×10\nスクワットとランジの意識');
  ok('P111b ★R3 種目名が2つなら候補にしない', !r.pending[0].r3, show(r));
  r = run('ベンチプレス\n50×10\n腰が痛いのでスクワットは休み');
  ok('P111c ★R3 健康の言葉の文は候補にしない', !r.pending[0].r3 && !r.pending[0].propose, show(r));
}

console.log(`\nliff-memo-parse: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
