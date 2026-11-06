// 会員が自分のカルテを読む窓口（設計35 会員画面 C2）・2026-11-06
//
//   入口（index.js）で済んでいること：ID トークンの検証・役割の確定・許可表（c_myKarte は customer だけ）・
//     役割の鮮度・停止スイッチ MEMBER_KARTE（'on' でなければ認証より前に 503）
//
//   ここで守ること
//     ・本人は who.customerId だけで決める。**body を一切読まない**（I-M1）
//       （入口の検査は body.customerId にしか効かない。noteId・sessionId 等で他人を指させない）
//     ・停止スイッチをここでも確かめる（入口の分岐を誰かが外しても止まる＝二重・I-M5）
//     ・組み立ては buildMemberKarte だけ（トレーナーの「お客様の見え方」と同じ関数・I-M7）
//     ・読んだ記録は karte_access_log に「本人が読んだ」だけ（中身・氏名・LINE ID・測定値を書かない・I-M8）
//     ・GAS へ送り直さない（対応する GAS の操作が無い・改訂1-9）。失敗は失敗のまま返す

import { buildMemberKarte } from '../lib/member-karte.js';

export function memberKarteOn(env) {
  return String((env && env.MEMBER_KARTE) || '') === 'on';
}

async function logMemberRead(env, customerId, result) {
  try {
    await env.DB.prepare(
      `INSERT INTO karte_access_log (at, trainer_id, role, customer_id, section, action, result, req_id)
       VALUES (?, NULL, 'customer', ?, 'member_karte', 'c_myKarte', ?, NULL)`
    ).bind(Date.now(), String(customerId), result).run();
  } catch (_) {
    //   ★ID も中身も出さない
    try { console.error('[member-karte] access_log write failed'); } catch (_) {}
  }
}

export async function compatMyKarte({ env, who }) {
  if (!memberKarteOn(env)) return { _error: 'MEMBER_KARTE_OFF', _status: 503 };
  if (!who || who.role !== 'customer' || !who.customerId) return { _error: 'FORBIDDEN', _status: 403 };
  const cid = String(who.customerId);
  let out;
  try {
    out = await buildMemberKarte(env, cid, { includeContract: true, includeIds: false });
  } catch (_) {
    await logMemberRead(env, cid, 'error');
    try { console.error('[member-karte] build failed'); } catch (_) {}
    return { _error: 'INTERNAL', _status: 500 };
  }
  await logMemberRead(env, cid, 'ok');
  return out;
}
