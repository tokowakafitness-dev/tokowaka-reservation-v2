// 設計47：ロックの取り方と記録の引数を「構文で」固定する（2026-11-20）
//   実行: node worker/test/gas-lock-syntax.test.js
//
//   ④ gas/*.js を、コメント・文字列・正規表現を取り除く小さな字句解析を通してから、
//      ScriptLock への waitLock の呼び出しを集める → 許可リスト（月締め・web 体験予約）と完全一致。
//      _lbTakeWriteLock('<op>') を呼ぶ関数の集合が対象10関数と完全一致。増えたら落ちる
//      陽性 fixture（反映前の12か所）を全部拾い、陰性 fixture（コメント・文字列・別のロック・別のオブジェクト）を拾わない
//   ⑪ 記録の関数の呼び出しの引数が、許可した文字列リテラル・数値・計測用のローカル変数（数値と真偽値）だけ
//      陰性 fixture の違反（会員ID・予約ID・例外の文）を拾い、コメントの中の呼び出しを数えない
//   ⑩ 新しいトリガーを作らない（newTrigger のハンドラの集合が変わらない）
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const GAS = process.env.GAS_DIR || join(ROOT, 'gas');
let pass = 0, fail = 0;
function ok(name, cond, why) { if (cond) pass++; else { fail++; console.log(`❌ ${name}`); if (why) console.log(`   ${why}`); } }

// ---- 字句解析：コメント・文字列・テンプレート・正規表現の中身を空白に（改行と位置は保つ） ----
function strip(src) {
  const out = src.split('');
  const blank = (a, b) => { for (let i = a; i < b; i++) if (out[i] !== '\n') out[i] = ' '; };
  let i = 0, lastSig = '';
  const regexOk = () => lastSig === '' || /[(,=:[!&|?{};+\-*%<>~^]/.test(lastSig) || /\b(return|typeof|in|of|case|do|else)$/.test(src.slice(Math.max(0, i - 8), i).trimEnd());
  while (i < src.length) {
    const c = src[i], n = src[i + 1];
    if (c === '/' && n === '/') { const e = src.indexOf('\n', i); const end = e < 0 ? src.length : e; blank(i, end); i = end; continue; }
    if (c === '/' && n === '*') { const e = src.indexOf('*/', i + 2); const end = e < 0 ? src.length : e + 2; blank(i, end); i = end; continue; }
    if (c === '\'' || c === '"' || c === '`') {
      let j = i + 1;
      while (j < src.length && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      blank(i + 1, j); i = j + 1; lastSig = c; continue;
    }
    if (c === '/' && regexOk()) {
      let j = i + 1, inClass = false;
      while (j < src.length && src[j] !== '\n') {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === '[') inClass = true; else if (src[j] === ']') inClass = false;
        else if (src[j] === '/' && !inClass) break;
        j++;
      }
      if (src[j] === '/') { blank(i + 1, j); i = j + 1; while (/[a-z]/.test(src[i] || '')) i++; lastSig = '/'; continue; }
    }
    if (!/\s/.test(c)) lastSig = c;
    i++;
  }
  return out.join('');
}
//   位置を含むトップレベルの関数名（GAS のファイルはトップレベルの function 宣言）
function topFnAt(stripped, pos) {
  let name = '(top)';
  const re = /^function\s+([\w$]+)\s*\(/gm; let m;
  while ((m = re.exec(stripped)) && m.index <= pos) name = m[1];
  return name;
}
function fnBody(stripped, name) {
  const re = new RegExp('^function\\s+' + name.replace('$', '\\$') + '\\s*\\(', 'm');
  const m = re.exec(stripped); if (!m) return '';
  const next = /^function\s+/gm; next.lastIndex = m.index + 1;
  const n = next.exec(stripped);
  return stripped.slice(m.index, n ? n.index : stripped.length);
}
//   ScriptLock への waitLock の呼び出し（関数名の配列）
function scriptWaitLocks(src) {
  const s = strip(src), out = [];
  const direct = /getScriptLock\s*\(\s*\)\s*\.\s*waitLock\s*\(/g; let m;
  while ((m = direct.exec(s))) out.push(topFnAt(s, m.index));
  const viaVar = /([A-Za-z_$][\w$]*)\s*\.\s*waitLock\s*\(/g;
  while ((m = viaVar.exec(s))) {
    const fn = topFnAt(s, m.index), body = fnBody(s, fn);
    if (new RegExp('\\b' + m[1] + '\\s*=\\s*LockService\\s*\\.\\s*getScriptLock\\s*\\(\\s*\\)').test(body)) out.push(fn);
  }
  return out;
}
//   呼び出しの引数（元のソースの文字）
function callArgs(src, stripped, openIdx) {
  let depth = 0, start = openIdx + 1;
  const args = [];
  for (let i = openIdx; i < stripped.length; i++) {
    const c = stripped[i];
    if (c === '(' || c === '[' || c === '{') depth++;
    else if (c === ')' || c === ']' || c === '}') {
      depth--;
      if (depth === 0) { args.push(src.slice(start, i)); return args.map((a) => a.trim()).filter((a) => a !== ''); }
    } else if (c === ',' && depth === 1) { args.push(src.slice(start, i)); start = i + 1; }
  }
  return null;
}
function findCalls(src, names) {
  const s = strip(src), out = [];
  const re = new RegExp('\\b(' + names.join('|') + ')\\s*\\(', 'g'); let m;
  while ((m = re.exec(s))) {
    const before = s.slice(Math.max(0, m.index - 12), m.index);
    if (/function\s+$/.test(before)) continue;   // 定義
    const open = s.indexOf('(', m.index + m[1].length);
    out.push({ name: m[1], fn: topFnAt(s, m.index), args: callArgs(src, s, open) || [] });
  }
  return out;
}

const RECORD_FNS = ['_lbWlTally', '_lbWlTallyErr', '_lbWlFlush', '_lbLcMerge', '_edgeTallyRun', '_edgeTallyKey', '_edgeTallySkip', '_edgePushFlush', '_ejPushFlush'];
const WRITE_OPS = ['reserve', 'cancel', 'change', 'undoSdc', 'recurAdd', 'recurDel', 'verify', 'selfReg', 'merge', 'offline'];
const STR_ALLOW = new Set(['jobHold', ...WRITE_OPS]);
//   計測用のローカル変数（数値・真偽値・固定の名前）と定数だけ
const IDENT_ALLOW = new Set(['key', 'kind', 'op', 'got', 'waitMs', 'holdMs', 'lockWaitMs', 'threw', 'nested', 't', 'true', 'false', 'null',
  'LB_LC', 'WRITE_PROP', 'PUSH_PROP', '_edgeNestedPrefix', 'lock', 'releasedAt', 'lockAt', 'ok', 'nowMs']);
function badArgs(call) {
  const bad = [];
  for (const a of call.args) {
    const strs = [...a.matchAll(/'([^'\\]*)'|"([^"\\]*)"/g)].map((m) => (m[1] !== undefined ? m[1] : m[2]));
    for (const x of strs) if (!STR_ALLOW.has(x)) bad.push('文字列 ' + x);
    const rest = a.replace(/'[^'\\]*'|"[^"\\]*"/g, ' ');
    if (/`/.test(rest)) bad.push('テンプレート');
    for (const m of rest.matchAll(/[A-Za-z_$][\w$]*/g)) if (!IDENT_ALLOW.has(m[0])) bad.push('名前 ' + m[0]);
  }
  return bad;
}

const files = readdirSync(GAS).filter((f) => f.endsWith('.js'));
const SRC = Object.fromEntries(files.map((f) => [f, readFileSync(join(GAS, f), 'utf8')]));
const POS = readFileSync(join(HERE, 'fixtures', 'lock-syntax-positive.js.txt'), 'utf8');
const NEG = readFileSync(join(HERE, 'fixtures', 'lock-syntax-negative.js.txt'), 'utf8');
const REL = readFileSync(join(HERE, 'fixtures', 'lock-syntax-release.js.txt'), 'utf8');
//   _lbTakeWriteLock の結果を受けた関数のうち、releaseLock が「自分で取ったとき」の条件の外にあるもの（関数名の配列）
function unguardedReleases(src) {
  const s = strip(src), out = [];
  const fns = new Set();
  const re = /_lbTakeWriteLock\s*\(/g; let m;
  while ((m = re.exec(s))) { const fn = topFnAt(s, m.index); if (!/^function _lbTakeWriteLock/m.test(fnBody(s, fn).slice(0, 40))) fns.add(fn); }
  for (const fn of fns) {
    const body = fnBody(s, fn);
    const rr = /\.\s*releaseLock\s*\(/g; let r;
    while ((r = rr.exec(body))) {
      const lineStart = body.lastIndexOf('\n', r.index) + 1;
      const before = body.slice(lineStart, r.index);
      if (!/if \((_wl\.owned|_lbOwnedLock)\)\s*[A-Za-z_$][\w$]*\s*$/.test(before)) out.push(fn);
    }
  }
  return out;
}


console.log('=== ④ 字句解析そのもの（fixture） ===');
{
  const p = scriptWaitLocks(POS).sort();
  const want12 = ['_lbAddRecurPattern', '_lbReserveCoreImpl', 'addOfflineMember', 'cancelReservationLine', 'changeReservationLine', 'closeAllocationMonth',
    'deleteRecurringPattern', 'makeReservation', 'mergeMemberLink', 'selfRegister', 'undoSameDayCancel', 'verifyMembership'].sort();
  ok('④-p1 陽性 fixture：反映前の12か所を全部拾う', JSON.stringify(p) === JSON.stringify(want12), JSON.stringify(p));
  const n = scriptWaitLocks(NEG);
  ok('④-n1 陰性 fixture：コメント・文字列・テンプレート・正規表現・UserLock・別のオブジェクトの waitLock を拾わない', n.length === 0, JSON.stringify(n));
  ok('④-n2 ★字句解析を外せば拾ってしまう形が陰性 fixture に入っている（語ではなく構文を見ていることの確かめ）', (NEG.match(/waitLock\(/g) || []).length >= 6);
}

console.log('=== ④ 本物の gas/ ===');
{
  const all = [];
  for (const f of files) for (const fn of scriptWaitLocks(SRC[f])) all.push(f + ':' + fn);
  all.sort();
  ok('④-1 ★ScriptLock の waitLock は許可リスト（月締め・web 体験予約）だけ＝増えたら落ちる',
     JSON.stringify(all) === JSON.stringify(['LineBooking.js:closeAllocationMonth', 'コード.js:makeReservation'].sort()), JSON.stringify(all));
  const tw = [];
  for (const f of files) for (const c of findCalls(SRC[f], ['_lbTakeWriteLock'])) tw.push({ f, fn: c.fn, op: (c.args[0] || '').replace(/^'|'$/g, '') });
  const fns = [...new Set(tw.map((x) => x.fn))].sort();
  ok('④-2 ★_lbTakeWriteLock を呼ぶ関数が対象10関数と完全一致', JSON.stringify(fns) === JSON.stringify(['_lbAddRecurPattern', '_lbReserveCoreImpl', 'addOfflineMember', 'cancelReservationLine',
    'changeReservationLine', 'deleteRecurringPattern', 'mergeMemberLink', 'selfRegister', 'undoSameDayCancel', 'verifyMembership'].sort()) && tw.length === 10, JSON.stringify(tw));
  ok('④-3 op は文字列リテラルで許可リストの値', tw.length > 0 && tw.every((x) => WRITE_OPS.includes(x.op)), JSON.stringify(tw));
  ok('④-4 取れなかったら BUSY を返す（各呼び出しの直後の行に if (!_wl.got) { … return … }）', tw.length > 0 && files.every((f) => {
    const s = strip(SRC[f]);
    const calls = (s.match(/_lbTakeWriteLock\s*\(/g) || []).length - (/function _lbTakeWriteLock/.test(s) ? 1 : 0);
    const guarded = (s.match(/_lbTakeWriteLock\s*\([^)]*\)\s*;\s*\n\s*if \(!_wl\.got\) \{[^}\n]*return [^\n]*\}/g) || []).length;
    return calls === guarded;
  }));
}

console.log('=== ④-5 releaseLock は「自分で取ったとき」の条件の中 ===');
{
  const f = unguardedReleases(REL).sort();
  ok('④-5p 陽性・陰性 fixture：good は通し、bad（条件なし・条件が別の行）を拾い、対象外の関数とコメントは見ない', JSON.stringify(f) === JSON.stringify(['badElsewhere', 'badUnguarded']), JSON.stringify(f));
  const all = [];
  for (const fl of files) for (const fn of unguardedReleases(SRC[fl])) all.push(fl + ':' + fn);
  ok('④-5 ★本物の gas/：_lbTakeWriteLock を使う10関数の releaseLock は全部 if (_wl.owned)／if (_lbOwnedLock) の中', all.length === 0, JSON.stringify(all));
  const cnt = files.reduce((a, fl) => a + (strip(SRC[fl]).match(/if \((_wl\.owned|_lbOwnedLock)\) lock\.releaseLock\(/g) || []).length, 0);
  ok('④-5c 条件つきの releaseLock を10か所拾えている（0件で素通りしない）', cnt === 10, String(cnt));
}

console.log('=== ⑪ 記録の関数の引数 ===');
{
  const neg = findCalls(NEG, RECORD_FNS);
  ok('⑪-n1 陰性 fixture：コメントの中の呼び出しは数えない（違反の3件だけ）', neg.length === 3, JSON.stringify(neg.map((c) => c.name)));
  ok('⑪-n2 陰性 fixture：会員ID・予約ID・例外の文を違反として拾う', neg.length === 3 && neg.every((c) => badArgs(c).length > 0), JSON.stringify(neg.map((c) => badArgs(c))));
  const calls = [];
  for (const f of files) for (const c of findCalls(SRC[f], RECORD_FNS)) calls.push(Object.assign({ f }, c));
  ok('⑪-1 記録の関数の呼び出しがある（0件で素通りしない）', calls.length >= 12, String(calls.length));
  const bad = calls.map((c) => ({ at: c.f + ':' + c.fn + ':' + c.name, bad: badArgs(c) })).filter((x) => x.bad.length);
  ok('⑪-2 ★全部の呼び出しの引数が許可した文字列・数値・計測用のローカル変数だけ', bad.length === 0, JSON.stringify(bad));
  ok('⑪-3 陽性：今の呼び出しの形を拾えている（_edgeTallyRun の5引数・_ejPushFlush）',
     calls.some((c) => c.name === '_edgeTallyRun' && c.args.length === 5) && calls.some((c) => c.name === '_ejPushFlush'), JSON.stringify(calls.map((c) => c.name + '/' + c.args.length)));
}

console.log('=== ⑩ トリガー ===');
{
  const names = new Set();
  for (const f of files) {
    const s = strip(SRC[f]);
    const re = /newTrigger\s*\(/g; let m;
    while ((m = re.exec(s))) {
      const close = s.indexOf(')', m.index);
      names.add(SRC[f].slice(m.index + m[0].length, close).trim().replace(/^'|'$/g, ''));
    }
  }
  //   ★'lbSelfHeal' は自己修理 P1（決定0201）で意図して1本足した（setupSelfHealTrigger は総数17本以下のときだけ作る）
  const want = ['_lbSyncAfterRegister', '_lbWarmContract', 'autoBookRecurringPatterns', 'checkLineQuota', 'dailyHealthCheck', 'dailySync', 'edgeJobPoll', 'lbNudgeDaily', 'lbSelfHeal',
    'pushToEdgeFullSync', 'pushToEdgeHome', 'pushToEdgeLight', 'pushToEdgeSlots', 'refreshPaceBoard', 'sendLineReminders', 'sendReminderMails', 'sendShiftReminders',
    'syncContractStatus', 'warmupCache', 'weeklyPaceReport', 'LB_CALSYNC.AFTER_HANDLER', 'LB_CALSYNC.TICK_HANDLER'].sort();
  ok('⑩-1 newTrigger のハンドラの集合が変わらない（新しいトリガー0本）', JSON.stringify([...names].sort()) === JSON.stringify(want), JSON.stringify([...names].sort()));
}

console.log(`\n${fail ? '❌' : '✅'} 設計47 ロックの構文 検証: ${pass} passed / ${fail} failed`);
process.exit(fail ? 1 : 0);
