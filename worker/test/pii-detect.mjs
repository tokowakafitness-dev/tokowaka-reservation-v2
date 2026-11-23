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
// 「仕様」「模様」「お客様」「同様」…の「様」は名前ではない（直前の1文字で判定）
const GEN_TAIL = new Set([...'仕模客同多異王神皆奥貴外両各左有今斯如']);
// ★1文字だけのとき（姓が前に付かないとき）に限って許す一般語（2026-11-18・会社リポジトリで実測）。
//   「3名様」＝人数の単位（366か所／190ファイル・全検出の約半分）・「次の方様」・「一様に」。
//   GEN_TAIL（最後の1文字で判定）に足すと、名が「一」で終わる実名（〇〇＋一＋様）まで漏れるので枠を分ける。
const ALLOW_SOLO = new Set([...'名方一']);
const RUN = '[一-龥々〆ァ-ヴー]';
const NAME_RE = new RegExp(`(?:(${RUN}+)([ 　・]))?(${RUN}+)[ 　]?様(?![式子相態])`, 'g');

// ★一般語・当社が自ら公開した文書に載る名前を、値を書かずにハッシュで許す（2026-11-18・#14 の2回目）。
//   選び方：会社リポジトリ 1621 ファイルで「LP・公開ブログ・経営文書に広く出る」もの＝顧客名ではありえない語。
//   顧客名は業務のコード・記録にしか出ない。ここに足すのは「20 ファイル超に出て、かつ公開物にも出る」語だけ。
const ALLOW_NAME_HASH = new Set([
  '8fd9da72', '8a535a3f', 'fd6b6462', '905c11ac', 'bd5a8814', '56a98bd5',   // 2〜3文字の一般語
  '8e7307d1', 'a1060199', '8b0f4235', 'c51a09cb', '4ed2a470',               // 同（カナ・4文字を含む）
  '685c8ab9',                                                               // 当社が公開したブログ記事に載る名前
  '2989e1c5',                                                               // 業務用語（空欄を指す語。会社リポジトリ 14 ファイルに出る）
  'a2d4a00e', '1806496b',                                                   // 業務用語（別事業のテストや LP にも出る語。連名の片側として引っかかっていた）
  'b9a00b8b',                                                               // オーナーの氏名（業務上の名前。契約・採算・報酬の記録に頻出するため残す）
  // 顧客分析の検査が自前で持っている架空の名前（ファイル冒頭で MEMBER_NAMES / AREA_NAME として定義されている）
  '4df514d1', '0dba122e', 'f91b0cf8',
  '066a672c',   // 業務用語（報酬の入れ方を指す3文字の語。本番コードの診断メッセージにも出る。2026-11-18）
  '3980673f',   // 一般語（予約した人を指す3文字の語。LUXE の設計・記録に出る。2026-11-23 オーナー承認）
  '320cc865', '96522e84',   // 一般語（「〜様」で終わる言い回し。LUXE の設計・動画の設計に出る。2026-11-23 オーナー承認）
  'ea1e1dc4', '3446ac15',   // 法人・施設の名前（広告コンサルの競合調査。個人ではない。2026-11-23 オーナー承認）
  'a2d4a00e', '1806496b',                                                   // 業務用語（別事業のテストや LP にも出る語。連名の片側として引っかかっていた）
]);

// ★架空名の形は許す（2026-11-18・#14 の2回目）。実名を機械で置き換えた跡なので、検査で止めない。
//   漢字：十干十二支の20文字だけで作る（この20文字だけで出来た氏名は実在しない）
//   カナ：先頭を「ヰ」にする（「アオイ」等の実在する名前と重ならないため）
const FAKE_KJ = new Set([...'甲乙丙丁戊己庚辛壬癸寅卯辰巳午未申酉戌亥']);
export const isFakeName = (s) => {
  const segs = String(s).split(/[ 　・]/).filter(Boolean);
  if (!segs.length) return false;
  // 姓と名で漢字・カナが混ざることがある（置き換えの跡）ので、区切りごとに判定する
  // 顧客名そのものに「様」が入っている場合（敬称が二重になる実データ）があるので、末尾の「様」は外して見る
  return segs.map((t) => t.replace(/様$/, '')).filter(Boolean)
    .every((t) => [...t].every((c) => FAKE_KJ.has(c)) || /^ヰ[ァ-ヴー]*$/.test(t));
};

export function flaggedNames(line) {
  const out = [];
  for (const m of line.matchAll(NAME_RE)) {
    const r0 = m[1], r1 = m[3];
    const full = r0 ? r0 + m[2] + r1 : r1;
    if (ALLOW_NAMES.has(r1) && (!r0 || ALLOW_NAMES.has(r0))) continue;
    if (ALLOW_NAME_HASH.has(hash(full)) || ALLOW_NAME_HASH.has(hash(r1)) ||
        ALLOW_NAME_HASH.has(hash(full.replace(/[ 　・]/g, '')))) continue;
    if (isFakeName(full)) continue;
    if (GEN_TAIL.has(r1[r1.length - 1])) continue;
    if (!r0 && [...r1].length === 1 && ALLOW_SOLO.has(r1)) continue;
    out.push(full);
  }
  return out;
}

// ---- 2. 携帯・IP電話の番号 -------------------------------------------------
const PHONE_ALLOW_HASH = new Set([
  'f9d1a4ba',                 // 店の公開番号（LP に掲載）
  'f519f6ba', 'bdfed4ee',     // 同じ番号の別の書き方（LP・広告LP／NAP の引用ブロック・entity-facts）2026-11-18
]);
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
  // ↓ 2026-11-18・会社リポジトリの洗い出し（#14）で確認した業務用のアカウント。顧客のものは1つも無かった
  '5255941f',   // マーケ自動化の持ち主（GCP・Meta・Cloudflare・リポジトリを作るアカウント）
  'e031cb14',   // 動画編集の自動化が使う Drive の同期先
  '4ab9b2cb',   // 上の +claude エイリアス（Claude 専用のマシンアカウント）
  'b7ddeb5d',   // 入金突合の GAS が使う業務アカウント
  '7748f664',   // オーナー本人のアカウント（決定の記録に1か所）
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
