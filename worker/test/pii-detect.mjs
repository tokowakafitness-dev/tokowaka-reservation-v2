// 個人情報・鍵の形を見つける部品（2026-11-11・決定0164・0166）
//
//   使うところ
//     worker/test/no-real-names.test.js … 作業ツリーの追跡ファイル全部
//     ops/prepush-scan.mjs               … push しようとしているコミットの「足した行」とコミットの説明
//
//   ★許可リスト方式。「見つけたら止める。許すものだけを名前で挙げる」
//     拒否リスト（危ない名前を並べる）は、書き忘れた人が漏れる。
//   ★実名・実在の値をこのファイルに書かない。許すものは一般語・架空の名前・ハッシュで持つ。
//   ★見つけたものを出すときは値もハッシュも出さない。種類と gloss()（名前の文字の種類）だけ。hash() は許可リストの照合にだけ使う。

import { createHash } from 'node:crypto';

export const hash = (s) => createHash('sha256').update(s).digest('hex').slice(0, 8);
export const gloss = (s) => [...s].map((c) => (/[一-龥々〆]/.test(c) ? 'K' : /[ァ-ヴー]/.test(c) ? 'k' : /[ 　・]/.test(c) ? '_' : '?')).join('');

// ---- 1. 「〇〇様」の名前 ---------------------------------------------------
// 許可リスト（ダミー・架空の名前・トレーナーの姓・一般語）
export const ALLOW_NAMES = new Set((
  '〇〇 ○○ ●● 様 体験 顧客 会員 名前 顧客名 本文 見本 ' +
  // 昔からのダミー
  '山田 山田太郎 山田花子 田中 田中太郎 田中花子 佐藤 佐藤花子 太郎 花子 一郎 二郎 健 ' +
  // テストで使う架空の名前（2026-11-11 に実名から置き換えたもの）
  '甲野 乙川 丙田 丁原 戊井 己島 甲野一郎 乙川二郎 戊井三郎 丁原四郎 丙田五郎 甲野花子 コウノ ハナコ コウノハナコ ' +
  '会員二 会員見本 新規花子 未来太郎 残骸花子 消化漏子 ' +
  // トレーナーの姓（LP で公開している業務上の名前。フルネームは書かない）
  '中野 鈴木 沖'
).split(/\s+/).filter(Boolean));
// 「仕様」「模様」「お客様」「同様」… の「様」は名前ではない（直前の1文字で判定）
const GEN_TAIL = new Set([...'仕模客同多異王神皆奥貴外両各左有今斯如']);
const RUN = '[一-龥々〆ァ-ヴー]';
const NAME_RE = new RegExp(`(?:(${RUN}+)([ 　・]))?(${RUN}+)[ 　]?様(?![式子相態])`, 'g');

export function flaggedNames(line) {
  const out = [];
  for (const m of line.matchAll(NAME_RE)) {
    const r0 = m[1], r1 = m[3];
    const full = r0 ? r0 + m[2] + r1 : r1;
    if (ALLOW_NAMES.has(r1) && (!r0 || ALLOW_NAMES.has(r0))) continue;
    if (GEN_TAIL.has(r1[r1.length - 1])) continue;
    out.push(full);
  }
  return out;
}

// ---- 2. 携帯・IP電話の番号 -------------------------------------------------
const PHONE_ALLOW_HASH = new Set(['f9d1a4ba']);   // 店の公開番号（LP に掲載）
const PHONE_RE = /(?<![\d.])0[5789]0-?\d{4}-?\d{4}(?!\d)/g;
const PHONE_INTL_RE = /\+81[- ]?[5789]0[- ]?\d{4}[- ]?\d{4}(?!\d)/g;
function isDummyPhone(p) {
  const d = p.replace(/\D/g, '').replace(/^81/, '0');
  return new Set(d.slice(3)).size <= 2 || /(0000|1111|2222|3333|4444|5555|6666|7777|8888|9999|1234|5678|9876)/.test(d);
}
export function flaggedPhones(line) {
  const out = [];
  for (const re of [PHONE_RE, PHONE_INTL_RE]) {
    for (const m of line.matchAll(re)) {
      if (isDummyPhone(m[0])) continue;
      if (PHONE_ALLOW_HASH.has(hash(m[0]))) continue;
      out.push(m[0]);
    }
  }
  return out;
}

// ---- 3. 個人のメールアドレス ----------------------------------------------
// 個人が使うフリーメール・携帯キャリアのドメインだけを見る（会社・サービスのドメインは見ない）。
// その中で許すのは、下のハッシュ（業務用のアドレス）だけ。
const PERSONAL_MAIL_DOMAINS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.co.jp', 'ymail.ne.jp', 'yahoo.com', 'icloud.com', 'me.com', 'mac.com',
  'outlook.com', 'outlook.jp', 'hotmail.com', 'hotmail.co.jp', 'live.jp', 'live.com', 'msn.com',
  'docomo.ne.jp', 'ezweb.ne.jp', 'au.com', 'softbank.ne.jp', 'i.softbank.jp', 'ybb.ne.jp', 'nifty.com', 'ocn.ne.jp',
]);
const MAIL_ALLOW_HASH = new Set([
  'a3f8a803',   // 店の GAS を動かす業務アカウント（予約システムのデプロイ主）
  'd9e4a2d2',   // 提携先の業務カレンダーの ID（gmail 形式のカレンダー ID）
]);
const MAIL_RE = /[A-Za-z0-9._%+-]+@([A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+)/g;
export function flaggedEmails(line) {
  const out = [];
  for (const m of line.matchAll(MAIL_RE)) {
    const dom = m[1].toLowerCase();
    if (!PERSONAL_MAIL_DOMAINS.has(dom)) continue;
    if (MAIL_ALLOW_HASH.has(hash(m[0].toLowerCase()))) continue;
    out.push(m[0]);
  }
  return out;
}

// ---- 4. LINE のユーザーID ---------------------------------------------------
// 形：U＋16進32文字。ダミー（同じ文字の繰り返し・0〜9a〜f の連番）だけ許す
const LINE_RE = /(?<![0-9A-Za-z])U[0-9a-f]{32}(?![0-9A-Za-z])/g;
export function flaggedLineIds(line) {
  const out = [];
  for (const m of line.matchAll(LINE_RE)) {
    const body = m[0].slice(1);
    if (new Set(body).size <= 2) continue;                 // U0000… / Uaaaa…
    if (/^(0123456789abcdef){2}$/.test(body)) continue;     // 連番のダミー
    out.push(m[0]);
  }
  return out;
}

// ---- 5. 鍵・トークンの形 ---------------------------------------------------
// 許すものは無い（ダミーも書かない。テストでは実行時に組み立てる）
const KEY_RES = [
  ['秘密鍵', /-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----/g],
  ['サービスアカウントの鍵', /"private_key"\s*:\s*"-----/g],
  ['GitHub', /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})\b/g],
  ['Google API', /\bAIza[0-9A-Za-z_-]{35}\b/g],
  ['Google OAuth', /\bya29\.[0-9A-Za-z_-]{20,}|\b1\/\/0[0-9A-Za-z_-]{30,}/g],
  ['AWS', /\bAKIA[0-9A-Z]{16}\b/g],
  ['Slack', /\bxox[abposr]-[0-9A-Za-z-]{10,}/g],
  ['OpenAI/Anthropic', /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}/g],
  ['Stripe', /\b[rs]k_live_[0-9A-Za-z]{16,}/g],
  ['JWT', /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g],
];
export function flaggedKeys(line) {
  const out = [];
  for (const [kind, re] of KEY_RES) for (const m of line.matchAll(re)) out.push({ kind, value: m[0] });
  return out;
}

// ---- まとめて：1行から見つかったものを、値を出さない形で返す ----------------
// ★ハッシュも出さない（決定0167・4役割の AUDITOR）。電話（約3億通り）や名前は、短いハッシュから総当たりで戻せる。
//   PR の検査のログ（Actions）は公開リポジトリでは誰でも読める。出すのは「種類」と、名前の文字の形（gloss）だけ。
// ★全角の数字・英字で書かれた値も拾うよう、NFKC で揃えてから見る（０９０… → 090…）。
export function scanLine(raw) {
  const line = String(raw).normalize('NFKC');
  const hits = [];
  for (const n of flaggedNames(line)) hits.push(`名前 (${gloss(n)})`);
  for (const p of flaggedPhones(line)) hits.push('電話');
  for (const e of flaggedEmails(line)) hits.push(`メール (@${e.split('@')[1]})`);
  for (const u of flaggedLineIds(line)) hits.push('LINEのID');
  for (const k of flaggedKeys(line)) hits.push(`鍵の形 ${k.kind}`);
  return hits;
}
