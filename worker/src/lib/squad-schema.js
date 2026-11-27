// 保全部隊が読む要約の許可リスト（会社の設計 maintenance-squad-read-endpoint.md §3-3・I-SQ1・I-SQ5）
//   ★1つの定義から3か所で使う：Worker が GAS から受けるとき／Worker が返すとき／Mac の台本の再構築器
//     （Mac 側は会社リポジトリにこのファイルを**そのまま写して**使い、写しが同じかを機械で突き合わせる）
//   ★import を持たない（写しても動くように）。自由文・氏名・会員番号を通す欄を作らない
//   ★列挙は GAS（gas/LineBooking.js の LB_TRIAGE・LB_ACTION_ENUM・LB_FACT_ENUM ほか）と揃える。
//     揃っているかは worker/test/squad-enum-sync.test.js が見る（GAS を先に変えても、ここは '?' に置き換えて落ちない）

export const SQ_SCHEMA = 1;
export const SQ_MAX_BYTES = 65536;
export const SQ_MAX_ITEMS = 100;
export const SQ_MAX_INCIDENTS = 60;
export const SQ_MAX_FACTS = 9;
export const SQ_MAX_REPORT_ITEMS = 20;
export const SQ_HOUR = 3600000;

export const SQ_KEYS = [
  'booking_error', 'both_fail', 'both_fail_broken', 'both_fail_overflow', 'cal_manual', 'cal_missing',
  'cal_missing_tr', 'cal_orphan', 'cal_orphan_tr', 'calslots_check_fail', 'cancel_notes_check_fail',
  'cancel_notes_purge_late', 'cancel_notes_save_fail', 'cancel_notes_unready', 'cancel_notify_slow', 'consec_counts',
  'consec_display_miss', 'consec_read_fail', 'contract_input_check_fail', 'd1_allow_unreadable', 'd1_read_none',
  'd1_read_served', 'datahealth_fail', 'dualwrite_check_fail', 'dualwrite_too_large', 'dup_pack_prefix',
  'edge_push_off', 'gen_behind', 'gen_behind_capacity', 'gen_behind_no_time', 'gen_behind_stuck', 'gen_write_behind',
  'gen_write_behind_no_time', 'heal_save_fail', 'health_skipped', 'job_lock_miss', 'karte_ai_check_fail',
  'member_broken', 'member_nocontract', 'metrics_fail', 'metrics_protect_blocked', 'metrics_unprotected',
  'metrics_write_fail', 'next_month_check_fail', 'next_month_open', 'next_month_slots_none',
  'next_month_slots_unknown', 'notify_alert_unsent', 'notify_fail', 'notify_queue_write_fail',
  'notify_retry_pending', 'notify_retry_read_fail', 'notify_retry_stalled', 'nudge_lock_miss', 'nudge_open_miss',
  'orphan_fail', 'pace_fail', 'pending_payment_check_fail', 'pending_payment_overage',
  'pending_payment_overage_urgent', 'pending_payment_unknown', 'quota_exhausted', 'quota_near', 'register_fail',
  'reminder_stale', 'resv_dup_ev', 'resv_dup_slot', 'resv_future', 'resv_unlinked', 'selfheal_practice_long',
  'selfheal_stale', 'selfheal_watch_fail', 'shadow_diff', 'shadow_idle', 'shadow_incomplete', 'shadow_sweep_expired',
  'shadow_sweep_read_fail', 'shadow_sweep_short', 'shadow_sweep_stale', 'shadow_sweep_state_broken',
  'squad_check_fail', 'squad_quiet', 'sync_never', 'sync_stale', 'transfer_seen', 'trigger_check_fail',
  'trigger_create_fail', 'trigger_dup', 'trigger_missing', 'trigger_near_limit', 'vacancy_stale', 'ws_backlog',
  'ws_check_fail', 'ws_danger', 'ws_erase_stuck', 'ws_not_running', 'ws_partial'
];
export const SQ_STAGES = [
  'トリガーの揃い', 'キャンセル理由', '定期処理の鮮度', '世代の追いつき', '通知', '会員データ', '予約データ', 'カレンダー', '支払い待ち', '二重書き', '枠のすぐ押し出し', '契約の入力',
  'うながしの取りこぼし', '翌月の解放', '空き枠のお知らせ', '押し出しの元栓', 'shadowの心拍', '作業依頼のロック', 'LINE通数', 'カルテのAI', '自己修理の見張り', '書き込みの比較',
  '保全部隊の見張り'
];
export const SQ_ACTIONS = [
  'add_trigger:multi', 'practice_add_trigger:multi', 'skip_no_config', 'skip_near_limit', 'skip_no_target',
  'practice_skip_no_config', 'practice_skip_near_limit', 'practice_skip_no_target', 'skip_attempts', 'dup_after',
  'over_limit_after', 'create_failed', 'heal_exception', 'lease_lost', 'practice_setup_cancel_notes',
  'setup_cancel_notes:created', 'setup_cancel_notes:ok', 'setup_cancel_notes:rewrote', 'setup_cancel_notes:mismatch',
  'setup_cancel_notes:exception', 'add_trigger:lbNudgeDaily', 'practice_add_trigger:lbNudgeDaily',
  'add_trigger:sendLineReminders', 'practice_add_trigger:sendLineReminders', 'add_trigger:pushToEdgeLight',
  'practice_add_trigger:pushToEdgeLight', 'add_trigger:pushToEdgeFullSync',
  'practice_add_trigger:pushToEdgeFullSync', 'add_trigger:dailySync', 'practice_add_trigger:dailySync',
  'add_trigger:edgeJobPoll', 'practice_add_trigger:edgeJobPoll', 'add_trigger:syncContractStatus',
  'practice_add_trigger:syncContractStatus'
];
export const SQ_FACT_ENUM = {
  trigger_missing: ['lbNudgeDaily', 'sendLineReminders', 'pushToEdgeLight', 'pushToEdgeFullSync', 'dailySync', 'edgeJobPoll', 'syncContractStatus'],
  cancel_notes_unready: ['missing', 'mismatch', 'unreadable'],
  health_skipped: ['held', 'lock_busy', 'lease_broken', 'expired', 'no_time'],
  heal_save_fail: ['ledger', 'header_mismatch', 'exception', 'lease', 'lock_busy', 'expired', 'lost', 'other', 'broken'],
  next_month_slots_none: ['no_shift', 'not_covered'],
  next_month_slots_unknown: ['no_time', 'cal_unreadable']
};
export const SQ_FACT_EXCEPTION_KEYS = [
  'cancel_notes_check_fail', 'pace_fail', 'datahealth_fail', 'orphan_fail', 'metrics_fail', 'notify_retry_read_fail',
  'consec_read_fail', 'shadow_sweep_read_fail', 'trigger_check_fail', 'pending_payment_check_fail',
  'dualwrite_check_fail', 'calslots_check_fail', 'contract_input_check_fail', 'd1_allow_unreadable',
  'edge_defer_check_fail', 'notify_defer_check_fail', 'autobook_check_fail', 'lock_count_check_fail',
  'karte_ai_check_fail', 'selfheal_watch_fail', 'ws_check_fail', 'next_month_check_fail', 'squad_check_fail'
];
export const SQ_FACT_NAME_KEYS = [
  'member_broken', 'member_nocontract', 'resv_dup_ev', 'resv_dup_slot', 'resv_unlinked', 'cal_missing', 'cal_orphan',
  'cal_missing_tr', 'cal_orphan_tr', 'cal_manual'
];

export const SQ_ENUM = {
  cls: ['A', 'AB', 'B', 'C', 'info'],
  sev: ['high', 'warn', 'info'],
  mode: ['off', 'practice', 'on', 'unset'],
  gate: ['ok', 'status_broken', 'no_status', 'not_done', 'not_completed', 'stale'],
  save_why: ['ledger', 'header_mismatch', 'exception', 'lease', 'lock_busy', 'expired', 'lost', 'other'],
  skip_entry: ['check', 'check_dry', 'heal'],
  skip_why: ['held', 'lock_busy', 'lease_broken', 'expired', 'no_time'],
  status: ['open', 'fixing', 'fixed', 'escalated', 'owner', 'unknown'],
  state: ['fresh', 'stale', 'none'],
  stale_reason: ['never_received', 'digest_old', 'beat_old', 'schema_mismatch', 'not_completed'],
  report_state: ['none', 'pending', 'handed', 'delivered', 'failed'],
  // 部隊の報告（④）。★固定の列挙だけ。GAS がこの値から固定の文を組み立てて LINE に送る
  verdict: ['all_ok', 'fixed', 'owner_needed', 'cannot_judge'],
  urgency: ['now', 'daily'],
  judge: ['fixed', 'not_fixed', 'cannot_judge', 'new'],
  ask: ['none', 'gas_deploy', 'merge_pr', 'check_mac', 'rotate_key', 'check_system'],
  ack: ['line_ok', 'mail_ok', 'failed'],
};
//   部隊だけが出す key（GAS の LB_TRIAGE には無い・Mac の台本と点検役が作る）
export const SQ_SQUAD_KEYS = ['squad_gas_quiet', 'squad_read_fail', 'squad_not_completed'];
export const SQ_SEND_FAIL = ['ok', 'http_4xx', 'http_5xx', 'exception', 'skipped_time', 'skipped_late'];
export const SQ_BUILD_RE = /^\d{4}-\d{2}-\d{2}[a-z]?$/;

// ---------- 型の小道具（どれも「合わなければ BAD」を返す。呼ぶ側が全体を捨てるか決める）----------
const BAD = Symbol('bad');
export const isMs = (v) => Number.isInteger(v) && v >= 1e12 && v < 1e14;
export const isCount = (v) => Number.isInteger(v) && v >= 0 && v <= 1e6;
const msOrNull = (v) => (v === null || v === undefined) ? null : (isMs(v) ? v : BAD);
const count = (v) => isCount(v) ? v : BAD;
const bool = (v) => (v === true || v === false) ? v : BAD;
const hourFloor = (v) => v === null ? null : Math.floor(v / SQ_HOUR) * SQ_HOUR;
const plainObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
//   列挙：strict（Mac）は列挙か '?' だけ。lenient（Worker の受け取り）は外れたら '?'
function en(v, list, strict, nullable) {
  if (v === null || v === undefined) return nullable ? null : (strict ? BAD : '?');
  if (typeof v === 'string' && (list.indexOf(v) >= 0 || v === '?')) return v;
  return strict ? BAD : '?';
}
const keysOnly = (o, allowed) => Object.keys(o).every((k) => allowed.indexOf(k) >= 0);

export function sqFactAllowed(key, f) {
  if (typeof f !== 'string') return false;
  if (Object.prototype.hasOwnProperty.call(SQ_FACT_ENUM, key) && SQ_FACT_ENUM[key].indexOf(f) >= 0) return true;
  if (f === 'exception' && SQ_FACT_EXCEPTION_KEYS.indexOf(key) >= 0) return true;
  if (f === 'ids_unavailable' && SQ_FACT_NAME_KEYS.indexOf(key) >= 0) return true;
  return false;
}

// ---------- 要約（digest）・心拍（beat）を組み直す ----------
//   opt.strict … true＝Mac の再構築器（未知の欄・未知の列挙は全体拒否）／false＝Worker が GAS から受ける（未知の欄は無視・列挙は '?'）
//   返り値 { ok: true, body, unknown, factsRejected } ／ { ok: false, why }
const DIGEST_KEYS = ['schema', 'kind', 'gas_build', 'snap_at', 'check_id', 'health_last', 'health_done', 'heal_last', 'heal_done',
  'watch_from', 'practice_from', 'digest_date', 'mode', 'completed', 'gate', 'save_last', 'skip', 'lease', 'items', 'incidents',
  'facts_rejected', 'unknown_keys', 'send_fail'];
const BEAT_KEYS = ['schema', 'kind', 'gas_build', 'snap_at', 'health_last', 'health_done', 'heal_last', 'heal_done'];

function common(src, strict, allowed) {
  if (!plainObj(src)) return { why: 'not_object' };
  if (strict && !keysOnly(src, allowed)) return { why: 'unknown_field' };
  if (src.schema !== SQ_SCHEMA) return { why: 'schema' };
  if (typeof src.gas_build !== 'string' || !SQ_BUILD_RE.test(src.gas_build)) return { why: 'gas_build' };
  if (!isMs(src.snap_at)) return { why: 'snap_at' };
  const t = {};
  for (const k of ['health_last', 'health_done', 'heal_last', 'heal_done']) {
    t[k] = msOrNull(src[k]);
    if (t[k] === BAD) return { why: k };
  }
  return { t };
}

export function sqRebuildBeat(src, opt = {}) {
  const strict = !!opt.strict;
  const c = common(src, strict, BEAT_KEYS);
  if (c.why) return { ok: false, why: c.why };
  if (strict && src.kind !== undefined && src.kind !== 'beat') return { ok: false, why: 'kind' };
  //   ★固定のキー順（本文の文字列の一致で同値を判定する＝§3-2 の 3）
  const body = { schema: SQ_SCHEMA, kind: 'beat', gas_build: src.gas_build, snap_at: src.snap_at,
    health_last: c.t.health_last, health_done: c.t.health_done, heal_last: c.t.heal_last, heal_done: c.t.heal_done };
  return { ok: true, body, unknown: 0, factsRejected: 0 };
}

export function sqRebuildDigest(src, opt = {}) {
  const strict = !!opt.strict;
  const c = common(src, strict, DIGEST_KEYS);
  if (c.why) return { ok: false, why: c.why };
  if (strict && src.kind !== undefined && src.kind !== 'digest') return { ok: false, why: 'kind' };
  let unknown = 0, factsRejected = 0;
  const ms = {};
  for (const k of ['check_id', 'watch_from', 'practice_from']) { ms[k] = msOrNull(src[k]); if (ms[k] === BAD) return { ok: false, why: k }; }
  let dd = src.digest_date === undefined ? null : src.digest_date;
  if (dd !== null && !(typeof dd === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dd))) return { ok: false, why: 'digest_date' };
  const mode = en(src.mode, SQ_ENUM.mode, strict, false); if (mode === BAD) return { ok: false, why: 'mode' };
  const completed = bool(src.completed); if (completed === BAD) return { ok: false, why: 'completed' };
  const gate = en(src.gate, SQ_ENUM.gate, strict, true); if (gate === BAD) return { ok: false, why: 'gate' };

  let save = null;
  if (src.save_last !== null && src.save_last !== undefined) {
    const s = src.save_last;
    if (!plainObj(s) || (strict && !keysOnly(s, ['saved', 'why', 'check_id', 'header_repaired', 'repairs']))) return { ok: false, why: 'save_last' };
    const saved = bool(s.saved), hr = bool(s.header_repaired), rp = count(s.repairs), cid = msOrNull(s.check_id);
    const why = (s.why === '' || s.why === null || s.why === undefined) ? null : en(s.why, SQ_ENUM.save_why, strict, true);
    if ([saved, hr, rp, cid, why].indexOf(BAD) >= 0) return { ok: false, why: 'save_last' };
    save = { saved, why, check_id: cid, header_repaired: hr, repairs: rp };
  }
  let skip = null;
  if (src.skip !== null && src.skip !== undefined) {
    const s = src.skip;
    if (!plainObj(s) || (strict && !keysOnly(s, ['count', 'last', 'entry', 'why']))) return { ok: false, why: 'skip' };
    const cnt = count(s.count), last = msOrNull(s.last), entry = en(s.entry, SQ_ENUM.skip_entry, strict, true), why = en(s.why, SQ_ENUM.skip_why, strict, true);
    if ([cnt, last, entry, why].indexOf(BAD) >= 0) return { ok: false, why: 'skip' };
    skip = { count: cnt, last, entry, why };
  }
  const l = src.lease;
  if (!plainObj(l) || (strict && !keysOnly(l, ['present', 'until', 'entry']))) return { ok: false, why: 'lease' };
  const lp = bool(l.present), lu = msOrNull(l.until), le = en(l.entry, SQ_ENUM.skip_entry, strict, true);
  if ([lp, lu, le].indexOf(BAD) >= 0) return { ok: false, why: 'lease' };
  const lease = { present: lp, until: lu, entry: le };

  if (!Array.isArray(src.items) || src.items.length > SQ_MAX_ITEMS) return { ok: false, why: 'items' };
  const items = [];
  for (const x of src.items) {
    if (!plainObj(x) || (strict && !keysOnly(x, ['k', 'cls', 'st', 'sev', 'c', 'f', 'n_ids', 'since']))) return { ok: false, why: 'item' };
    let k = x.k;
    if (typeof k !== 'string' || k.length > 64) return { ok: false, why: 'item_k' };
    if (SQ_KEYS.indexOf(k) < 0 && k !== '?') { if (strict) return { ok: false, why: 'item_k' }; k = '?'; unknown++; }
    const cls = en(x.cls, SQ_ENUM.cls, strict, false), sev = en(x.sev, SQ_ENUM.sev, strict, false);
    const st = (typeof x.st === 'string' && x.st.length <= 30 && (SQ_STAGES.indexOf(x.st) >= 0 || x.st === '?')) ? x.st : (strict ? BAD : '?');
    const cc = count(x.c), ni = count(x.n_ids), since = msOrNull(x.since);
    if ([cls, sev, st, cc, ni, since].indexOf(BAD) >= 0) return { ok: false, why: 'item' };
    if (!Array.isArray(x.f) || x.f.length > SQ_MAX_FACTS) return { ok: false, why: 'item_f' };
    const f = [];
    for (const v of x.f) {
      if (typeof v !== 'string' || v.length > 15) return { ok: false, why: 'item_f' };
      if (k !== '?' && sqFactAllowed(k, v)) { if (f.indexOf(v) < 0) f.push(v); }
      else if (strict) return { ok: false, why: 'item_f' };
      else factsRejected++;
    }
    items.push({ k, cls, st, sev, c: cc, f, n_ids: ni, since });
  }
  if (!Array.isArray(src.incidents) || src.incidents.length > SQ_MAX_INCIDENTS) return { ok: false, why: 'incidents' };
  const incidents = [];
  for (const x of src.incidents) {
    if (!plainObj(x) || (strict && !keysOnly(x, ['k', 'cls', 'stage', 'status', 'attempts', 'would_attempts', 'last_action', 'opened_at', 'last_seen', 'closed_at', 'notified_at']))) return { ok: false, why: 'incident' };
    let k = x.k;
    if (typeof k !== 'string' || k.length > 64) return { ok: false, why: 'inc_k' };
    if (SQ_KEYS.indexOf(k) < 0 && k !== '?') { if (strict) return { ok: false, why: 'inc_k' }; k = '?'; unknown++; }
    const cls = en(x.cls, SQ_ENUM.cls, strict, false), status = en(x.status, SQ_ENUM.status, strict, false);
    const stage = (typeof x.stage === 'string' && x.stage.length <= 30 && (SQ_STAGES.indexOf(x.stage) >= 0 || x.stage === '?')) ? x.stage : (strict ? BAD : '?');
    const la = (x.last_action === null || x.last_action === undefined || x.last_action === '') ? null
      : ((typeof x.last_action === 'string' && x.last_action.length <= 64 && (SQ_ACTIONS.indexOf(x.last_action) >= 0 || x.last_action === '?')) ? x.last_action : (strict ? BAD : '?'));
    const at = count(x.attempts), wa = count(x.would_attempts);
    const t = {};
    for (const n of ['opened_at', 'last_seen', 'closed_at', 'notified_at']) { t[n] = msOrNull(x[n]); }
    if ([cls, status, stage, la, at, wa, t.opened_at, t.last_seen, t.closed_at, t.notified_at].indexOf(BAD) >= 0) return { ok: false, why: 'incident' };
    //   ★台帳の時刻は時間単位に切り下げる（予約の時刻と突き合わせる手がかりを減らす・関門① 軽1）
    incidents.push({ k, cls, stage, status, attempts: at, would_attempts: wa, last_action: la,
      opened_at: hourFloor(t.opened_at), last_seen: hourFloor(t.last_seen), closed_at: hourFloor(t.closed_at), notified_at: hourFloor(t.notified_at) });
  }
  const fr = count(src.facts_rejected === undefined ? 0 : src.facts_rejected), uk = count(src.unknown_keys === undefined ? 0 : src.unknown_keys);
  if (fr === BAD || uk === BAD) return { ok: false, why: 'counts' };
  const sf = src.send_fail === undefined ? {} : src.send_fail;
  if (!plainObj(sf) || (strict && !keysOnly(sf, SQ_SEND_FAIL))) return { ok: false, why: 'send_fail' };
  const send_fail = {};
  for (const k of SQ_SEND_FAIL) { const v = count(sf[k] === undefined ? 0 : sf[k]); if (v === BAD) return { ok: false, why: 'send_fail' }; send_fail[k] = v; }
  const body = { schema: SQ_SCHEMA, kind: 'digest', gas_build: src.gas_build, snap_at: src.snap_at, check_id: ms.check_id,
    health_last: c.t.health_last, health_done: c.t.health_done, heal_last: c.t.heal_last, heal_done: c.t.heal_done,
    watch_from: ms.watch_from, practice_from: ms.practice_from, digest_date: dd, mode, completed, gate,
    save_last: save, skip, lease, items, incidents,
    facts_rejected: Math.min(1e6, fr + (strict ? 0 : factsRejected)), unknown_keys: Math.min(1e6, uk + (strict ? 0 : unknown)), send_fail };
  return { ok: true, body, unknown, factsRejected };
}

// ---------- Worker の応答の外枠（§3-3-1）。Mac の再構築器が使う（strict）----------
const OUTER_KEYS = ['ok', 'schema', 'worker_build', 'now', 'state', 'stale_reason', 'digest_received_at', 'digest_age_min',
  'beat_received_at', 'beat_age_min', 'gas_build', 'check_id', 'gate', 'reads_today', 'digest_rejected', 'report_state', 'report_id', 'digest'];
export function sqRebuildStatus(src) {
  if (!plainObj(src) || !keysOnly(src, OUTER_KEYS)) return { ok: false, why: 'unknown_field' };
  if (src.ok !== true || src.schema !== SQ_SCHEMA) return { ok: false, why: 'schema' };
  if (typeof src.worker_build !== 'string' || !SQ_BUILD_RE.test(src.worker_build)) return { ok: false, why: 'worker_build' };
  if (!isMs(src.now)) return { ok: false, why: 'now' };
  const state = en(src.state, SQ_ENUM.state, true, false);
  if (state === BAD || state === '?') return { ok: false, why: 'state' };
  let sr = src.stale_reason === undefined ? BAD : src.stale_reason;
  if (state === 'fresh') { if (sr !== null) return { ok: false, why: 'stale_reason' }; }
  else if (state === 'none') { if (sr !== 'never_received') return { ok: false, why: 'stale_reason' }; }
  else if (typeof sr !== 'string' || SQ_ENUM.stale_reason.indexOf(sr) < 0) return { ok: false, why: 'stale_reason' };
  const o = { ok: true, schema: SQ_SCHEMA, worker_build: src.worker_build, now: src.now, state, stale_reason: sr };
  for (const k of ['digest_received_at', 'beat_received_at', 'check_id', 'report_id']) {
    const v = msOrNull(src[k]); if (v === BAD) return { ok: false, why: k }; o[k] = v;
  }
  for (const k of ['digest_age_min', 'beat_age_min']) {
    const v = (src[k] === null || src[k] === undefined) ? null : (isCount(src[k]) ? src[k] : BAD); if (v === BAD) return { ok: false, why: k }; o[k] = v;
  }
  if (src.gas_build !== null && src.gas_build !== undefined && !(typeof src.gas_build === 'string' && SQ_BUILD_RE.test(src.gas_build))) return { ok: false, why: 'gas_build' };
  o.gas_build = src.gas_build === undefined ? null : src.gas_build;
  const g = en(src.gate, SQ_ENUM.gate, true, true); if (g === BAD) return { ok: false, why: 'gate' }; o.gate = g;
  if (!(Number.isInteger(src.reads_today) && src.reads_today >= 1 && src.reads_today <= 200)) return { ok: false, why: 'reads_today' };
  o.reads_today = src.reads_today;
  if (!isCount(src.digest_rejected)) return { ok: false, why: 'digest_rejected' };
  o.digest_rejected = src.digest_rejected;
  const rs = en(src.report_state === undefined ? 'none' : src.report_state, SQ_ENUM.report_state, true, false);
  if (rs === BAD || rs === '?') return { ok: false, why: 'report_state' };
  o.report_state = rs;
  const has = Object.prototype.hasOwnProperty.call(src, 'digest');
  if (state === 'fresh') {
    if (!has) return { ok: false, why: 'digest_missing' };
    const d = sqRebuildDigest(src.digest, { strict: true });
    if (!d.ok) return { ok: false, why: 'digest_' + d.why };
    o.digest = d.body;
  } else if (has) return { ok: false, why: 'digest_not_fresh' };
  return { ok: true, body: o };
}

// ---------- 部隊の報告（④）----------
const REPORT_KEYS = ['schema', 'run_id', 'verdict', 'urgency', 'items', 'ask'];
export function sqRebuildReport(src) {
  if (!plainObj(src) || !keysOnly(src, REPORT_KEYS)) return { ok: false, why: 'unknown_field' };
  if (src.schema !== SQ_SCHEMA) return { ok: false, why: 'schema' };
  if (!isMs(src.run_id)) return { ok: false, why: 'run_id' };
  const verdict = en(src.verdict, SQ_ENUM.verdict, true, false), urgency = en(src.urgency, SQ_ENUM.urgency, true, false), ask = en(src.ask, SQ_ENUM.ask, true, false);
  if ([verdict, urgency, ask].some((v) => v === BAD || v === '?')) return { ok: false, why: 'enum' };
  if (!Array.isArray(src.items) || src.items.length > SQ_MAX_REPORT_ITEMS) return { ok: false, why: 'items' };
  const items = [];
  for (const x of src.items) {
    if (!plainObj(x) || !keysOnly(x, ['k', 'j', 'c'])) return { ok: false, why: 'item' };
    if (typeof x.k !== 'string' || (SQ_KEYS.indexOf(x.k) < 0 && SQ_SQUAD_KEYS.indexOf(x.k) < 0)) return { ok: false, why: 'item_k' };
    const j = en(x.j, SQ_ENUM.judge, true, false);
    if (j === BAD || j === '?' || !isCount(x.c)) return { ok: false, why: 'item' };
    items.push({ k: x.k, j, c: x.c });
  }
  return { ok: true, body: { schema: SQ_SCHEMA, run_id: src.run_id, verdict, urgency, items, ask } };
}

// ---------- 厳密な JSON の読み取り（重複キー・末尾のデータ・大きすぎる本文を拒否）----------
//   JSON.parse は重複キーを後勝ちで黙って通す＝検査をすり抜ける。ここは自前の再帰下降で読む
export function sqParseStrict(text, maxBytes = SQ_MAX_BYTES) {
  if (typeof text !== 'string') return { ok: false, why: 'not_text' };
  if (new TextEncoder().encode(text).length > maxBytes) return { ok: false, why: 'too_large' };
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.indexOf(text[i]) >= 0) i++; };
  const fail = (w) => { throw new Error(w); };
  function str() {
    if (text[i] !== '"') fail('str');
    let j = i + 1, out = '';
    while (j < text.length) {
      const ch = text[j];
      if (ch === '"') { i = j + 1; return out; }
      if (ch === '\\') {
        const n = text[j + 1];
        const map = { '"': '"', '\\': '\\', '/': '/', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' };
        if (n === 'u') { const h = text.slice(j + 2, j + 6); if (!/^[0-9a-fA-F]{4}$/.test(h)) fail('esc'); out += String.fromCharCode(parseInt(h, 16)); j += 6; continue; }
        if (!(n in map)) fail('esc');
        out += map[n]; j += 2; continue;
      }
      if (ch < ' ') fail('ctrl');
      out += ch; j++;
    }
    fail('eof');
  }
  function val(depth) {
    if (depth > 8) fail('deep');
    ws();
    const ch = text[i];
    if (ch === '{') {
      i++; const o = {}; ws();
      if (text[i] === '}') { i++; return o; }
      for (;;) {
        ws(); const k = str(); ws();
        if (text[i] !== ':') fail('colon');
        i++;
        if (Object.prototype.hasOwnProperty.call(o, k) || k === '__proto__') fail('dup_key');
        o[k] = val(depth + 1); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === '}') { i++; return o; }
        fail('obj');
      }
    }
    if (ch === '[') {
      i++; const a = []; ws();
      if (text[i] === ']') { i++; return a; }
      for (;;) {
        a.push(val(depth + 1)); ws();
        if (text[i] === ',') { i++; continue; }
        if (text[i] === ']') { i++; return a; }
        fail('arr');
      }
    }
    if (ch === '"') return str();
    const m = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(text.slice(i, i + 40));
    if (m) { i += m[0].length; return Number(m[0]); }
    for (const [w, v] of [['true', true], ['false', false], ['null', null]]) if (text.startsWith(w, i)) { i += w.length; return v; }
    fail('token');
  }
  try {
    const v = val(0); ws();
    if (i !== text.length) return { ok: false, why: 'trailing' };
    return { ok: true, value: v };
  } catch (e) { return { ok: false, why: String(e.message || 'parse') }; }
}

//   応答・保存の本文の文字列（固定のキー順で組み直した後に JSON.stringify するだけ）
export const sqStringify = (o) => JSON.stringify(o);
