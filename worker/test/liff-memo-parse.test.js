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

console.log(`\nliff-memo-parse: ${pass} 通過 / ${fail} 失敗`);
process.exit(fail ? 1 : 0);
