// 自己修理 P1：振り分け表（ops/booking-health-triage.md）と LB_TRIAGE の一致（2026-11-23）
//   実行: node worker/test/self-heal-triage.test.js
//   I-H10 振り分け表に無い key は B／LB_TRIAGE と booking-health-triage.md が一致（76 ＋ P1 で足した 5 ＝ 81 key・2026-11-24 heal_save_fail・selfheal_watch_fail）
//   ＋ LB_TRIAGE の「それを測る段」が、本物のソースで add('key' がある段（直前の _step）と一致する
//     （段がずれていると、別の段が完走しただけで案件を閉じてしまう＝I-H2 が崩れる）
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { makeWorld, makeCtx, tally, ROOT, LB } from './_self-heal-harness.js';

const t = tally();
const ok = t.ok;
const MD = readFileSync(join(ROOT, 'ops/booking-health-triage.md'), 'utf8');
const c = makeCtx(makeWorld());
const TRI = c.LB_TRIAGE;

//   表の節 → 区分
const SEC = [
  [/^## A　GAS が自分で直す/, 'A', 'table'],
  [/^## B へ移したもの/, 'B', 'table'],
  [/^## A→B/, 'AB', 'line'],
  [/^## B　部隊が判断する・名前は要らない/, 'B', 'table'],
  [/^## B　部隊が判断する・いまは名前が入っている/, 'B', 'table'],
  [/^## C　オーナー/, 'C', 'table'],
  [/^## 記録だけ/, 'info', 'line'],
  [/^## P1 で足した key/, null, 'table2'],
];
const KEY = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;
const fromMd = {};
const dupMd = [];
const lines = MD.split('\n');
let cur = null;
for (const ln of lines) {
  if (/^## /.test(ln)) { cur = SEC.find((s) => s[0].test(ln)) || null; continue; }
  if (!cur) continue;
  const put = (k, cls) => { if (fromMd[k]) dupMd.push(k); fromMd[k] = cls; };
  if (cur[2] === 'table' || cur[2] === 'table2') {
    if (!/^\| /.test(ln) || /^\|---/.test(ln) || /^\| key \|/.test(ln)) continue;
    const cells = ln.split('|').map((x) => x.trim());
    const cls = cur[2] === 'table2' ? (cells[2] === '記録' ? 'info' : cells[2]) : cur[1];
    for (const k of cells[1].match(KEY) || []) put(k, cls);
  } else if (cur[2] === 'line') {
    if (!/・/.test(ln) || /^>/.test(ln)) continue;
    const parts = ln.split('・').map((x) => x.replace(/（●）/g, '').trim());
    if (!parts.every((p) => /^[a-z][a-z0-9_]+$/.test(p))) continue;   // key を並べた行だけ
    for (const k of parts) put(k, cur[1]);
  }
}
const mdKeys = Object.keys(fromMd).sort(), codeKeys = Object.keys(TRI).sort();
ok('I-H10-1 表から読めた key は 81（76 ＋ P1 で足した 5）', mdKeys.length === 81, `${mdKeys.length}: ${mdKeys.join(',')}`);
ok('I-H10-2 表の中で key が重複していない', dupMd.length === 0, dupMd.join(','));
ok('I-H10-3 ★表と LB_TRIAGE の key の集合が一致', JSON.stringify(mdKeys) === JSON.stringify(codeKeys),
   `表だけ: ${mdKeys.filter((k) => !TRI[k]).join(',')} ／ コードだけ: ${codeKeys.filter((k) => !fromMd[k]).join(',')}`);
const clsDiff = mdKeys.filter((k) => TRI[k] && TRI[k][0] !== fromMd[k]);
ok('I-H10-4 ★区分も一致', clsDiff.length === 0, clsDiff.map((k) => `${k}: 表=${fromMd[k]} コード=${TRI[k][0]}`).join(', '));
ok('I-H10-5 A は2つだけ（trigger_missing・cancel_notes_unready）', JSON.stringify(codeKeys.filter((k) => TRI[k][0] === 'A')) === '["cancel_notes_unready","trigger_missing"]');
ok('I-H10-6 表の数え（81）と一致', /＝ \*\*81\*\*/.test(MD));
const unk = c._lbTriage('some_new_key');
ok('I-H10-7 ★表に無い key は B（段は空＝add した時の段で閉じる）', unk.cls === 'B' && unk.known === false && unk.stage === '');
ok('I-H10-8 修理してよい key（LB_HEAL_KEYS）は A の2つと同じ', JSON.stringify(c.LB_HEAL_KEYS.slice().sort()) === '["cancel_notes_unready","trigger_missing"]');

//   ---- 段の一致：本物の dailyHealthCheck の中で、add('key' の直前の _step('段') を読む ----
const body = (() => { const a = LB.indexOf('\nfunction dailyHealthCheck('); return LB.slice(a, LB.indexOf('\n}', a)); })();
const stageAt = {};
const re = /_step\('([^']+)'\)|add\('([a-z0-9_]+)'|var _ppKey = [^;]*'([a-z_]+)' : '([a-z_]+)'/g;
let m, st = '';
while ((m = re.exec(body))) {
  if (m[1]) st = m[1];
  else if (m[2]) (stageAt[m[2]] = stageAt[m[2]] || new Set()).add(st);
  else if (m[3]) { for (const k of [m[3], m[4]]) (stageAt[k] = stageAt[k] || new Set()).add(st); }
}
const stageBad = [], notFound = [];
for (const k of codeKeys) {
  if (!stageAt[k]) { notFound.push(k); continue; }
  const s = [...stageAt[k]];
  if (s.length !== 1 || s[0] !== TRI[k][1]) stageBad.push(`${k}: ソース=${s.join('/')} 表=${TRI[k][1]}`);
}
ok('I-H10-9 ★LB_TRIAGE の段が、ソースで add している段と一致', stageBad.length === 0, stageBad.join('\n   '));
ok('I-H10-10 LB_TRIAGE の key は全部 dailyHealthCheck の中で add されている', notFound.length === 0, notFound.join(','));
//   段の名前は _done と _step の両方にある（_done の打ち忘れ＝その段の key が永久に閉じない）
const steps = [...new Set((body.match(/_step\('([^']+)'\)/g) || []).map((x) => x.slice(7, -2)))];
const dones = new Set((body.match(/_done\('([^']+)'\)/g) || []).map((x) => x.slice(7, -2)));
const needDone = [...new Set(codeKeys.map((k) => TRI[k][1]))];
ok('I-H10-11 表が使う段は全部 _done で締めている', needDone.every((s) => dones.has(s)), needDone.filter((s) => !dones.has(s)).join(','));
ok('I-H10-12 _done の段の名前は全部 _step にある（打ち間違いが無い）', [...dones].every((s) => steps.indexOf(s) >= 0), [...dones].filter((s) => steps.indexOf(s) < 0).join(','));

//   ---- 地図（MODEL.md §3）に I-H1〜I-H35 があり、各行に実在する検査が紐付いている ----
{
  const { readdirSync } = await import('node:fs');
  const DOC = readFileSync(join(ROOT, 'ops/MODEL.md'), 'utf8');
  const have = new Set(readdirSync(join(ROOT, 'worker/test')));
  const bad = [];
  for (let i = 1; i <= 35; i++) {
    const ln = DOC.split('\n').find((l) => l.startsWith(`| I-H${i} |`));
    if (!ln) { bad.push(`I-H${i} が無い`); continue; }
    const cells = ln.split('|').map((x) => x.trim());
    const files = (cells[cells.length - 2].match(/`([a-z0-9-]+\.test\.js)`/g) || []).map((x) => x.replace(/`/g, ''));
    if (!files.length || !files.every((f) => have.has(f))) bad.push(`I-H${i} の検査: ${cells[cells.length - 2]}`);
    //   紐付けた検査ファイルの中に、その番号の検査が実在する（飾りの紐付けにしない）
    for (const f of files) if (have.has(f) && readFileSync(join(ROOT, 'worker/test', f), 'utf8').indexOf(`I-H${i}`) < 0) bad.push(`I-H${i} が ${f} の中に無い`);
  }
  ok('I-H 地図：I-H1〜I-H35 が MODEL.md §3 にあり、実在する検査ファイルの中にその番号がある', bad.length === 0, bad.join('\n   '));
}

t.end('自己修理 P1 振り分け表');
