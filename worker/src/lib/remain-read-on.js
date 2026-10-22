// 残数を D1 から顧客に出す（設計21・決定0092・段階3-b 手順4）
//
// ★倒れる向き
//   D1 で答えられるか少しでも怪しければ、いまと同じ写しを返す。写しも無ければいまと同じく null（GAS へ）。
//   mode が 'on' でない・選ばれていない会員の答えは、**変更前と1文字も同じ**（remainSource も付けない）。
//
// ★写しを土台に、shadow で食い違い0を確かめた鍵（COMPARE_FIELDS）だけを D1 で上書きする
//   写しにしか無い鍵（transferCredits 等）はそのまま残る。D1 にしか無い鍵（_src・_packOverUse）は出ない。
//
// ★会員 ID を公開の場所に書かない
//   選ぶのは D1 の許可表（remain_d1_allow）。作業依頼には下4桁だけ。検証用の会員は完全一致。

import { readRemainDiag } from './remain-from-d1.js';
import { COMPARE_FIELDS } from './remain-shadow.js';

export const D1_OVERRIDE_FIELDS = COMPARE_FIELDS;
export const VERIFY_CUSTOMER_ID = 'CVERIFY0000001';

//   入口の名前（数えるときの鍵）。ここ1か所で持つ（I39）
export const READ_ENTRIES = ['compat_member', 'compat_home', 'booking_options', 'boot', 'customer_detail', 'route_booking_options'];
export const DAILY_CAP = 500;

/** mode が 'on' か（厳密な文字列一致） */
export function modeOn(env) {
  return String((env && env.LB_D1_REMAIN_MODE) || '') === 'on';
}

/**
 * 選ばれているか。★許可表が読めなければ「選ばれていない」（例外を外に出さない）
 *   返り値 { selected: bool, why }
 */
export async function isSelected(env, customerId) {
  const cid = String(customerId || '');
  if (!cid) return { selected: false, why: 'no_customer' };
  if (cid === VERIFY_CUSTOMER_ID) return { selected: true, why: 'verify' };
  if (String((env && env.LB_D1_REMAIN_ALL) || '') === '1') return { selected: true, why: 'all' };
  try {
    const r = await env.DB.prepare('SELECT 1 AS x FROM remain_d1_allow WHERE customer_id = ?').bind(cid).first();
    return r ? { selected: true, why: 'allow' } : { selected: false, why: 'not_selected' };
  } catch (_) {
    return { selected: false, why: 'allow_read_failed' };
  }
}

/**
 * 写し（copyDiag＝readHomeDiag の結果）に D1 の値を上書きするかを決めて、返す答えを作る。
 *   返り値 { value, source, status }  ※value は顧客に返すもの（null なら GAS へ）
 *   source  'copy_unchanged'（mode/選択の外＝変更前と同じ） / 'd1' / 'copy:<理由>'
 *   ★mode 'on' かつ選ばれた会員だけ remainSource を付ける
 */
export async function decideHome(env, customerId, targetMs, copyDiag) {
  const copy = copyDiag ? copyDiag.value : null;
  if (!modeOn(env)) return { value: copy, source: 'copy_unchanged', status: 'mode_off', selected: false };
  const sel = await isSelected(env, customerId);
  if (!sel.selected) return { value: copy, source: 'copy_unchanged', status: sel.why, selected: false };
  if (!copy) return { value: null, source: 'copy:no_copy', status: 'no_copy', selected: true };
  const mark = (why) => ({ value: Object.assign({}, copy, { remainSource: 'copy' }), source: 'copy:' + why, status: why, selected: true });
  //   ★GAS が「残数を出せない」と言う会員は D1 でも出さない（設計21 F3）
  if (copy.reviewRequired === true) return mark('review');
  let d;
  try { d = await readRemainDiag(env, customerId, targetMs); }
  catch (_) { return mark('read_failed'); }
  if (!d || d.status !== 'ok' || !d.value) return mark(String((d && d.status) || 'read_failed'));
  if (String(d.month || '') !== String(copyDiag.month || '')) return mark('month_mismatch');
  const out = Object.assign({}, copy);
  for (const k of D1_OVERRIDE_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(d.value, k)) out[k] = d.value[k];
    else delete out[k];   // D1 に無い鍵は消す（undefined で上書きしない）
  }
  out.remainSource = 'd1';
  out.remainBuiltAt = (d.version && d.version.builtAt != null) ? d.version.builtAt : null;
  return { value: out, source: 'd1', status: 'ok', selected: true };
}

/** 日本時間の日付（数える日の鍵） */
export function dayKeyJst(ms) {
  const d = new Date(Number(ms) + 9 * 3600000);
  return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-' + String(d.getUTCDate()).padStart(2, '0');
}

/**
 * 出どころを数える（選ばれた会員だけ）。★日×入口の合計で DAILY_CAP まで（1文で原子的）。
 *   上限に達したら '_dropped' を日×入口で最大1回だけ書く。例外を外に出さない
 */
export async function countSource(env, entry, source, nowMs) {
  try {
    const e = READ_ENTRIES.includes(entry) ? entry : 'unknown';
    const day = dayKeyJst(nowMs || Date.now());
    const r = await env.DB.prepare(
      `INSERT INTO remain_source_daily (day, entry, source, n)
         SELECT ?, ?, ?, 1
          WHERE (SELECT COALESCE(SUM(n), 0) FROM remain_source_daily
                  WHERE day = ? AND entry = ? AND source NOT LIKE '\\_%' ESCAPE '\\') < ?
       ON CONFLICT(day, entry, source) DO UPDATE SET n = n + 1`
    ).bind(day, e, String(source), day, e, DAILY_CAP).run();
    const changed = Number((r && r.meta && r.meta.changes) || 0);
    if (!changed) {
      await env.DB.prepare(
        "INSERT OR IGNORE INTO remain_source_daily (day, entry, source, n) VALUES (?, ?, '_dropped', 1)"
      ).bind(day, e).run();
    }
    return changed > 0;
  } catch (_) { return false; }
}
