// ① カレンダー → D1 の受け取り口（POST /calsync）
//   設計：ops/design/01-calendar-to-d1.md 第4版（2026-10-02）
//
//   GASが1分ごとにカレンダー全量を読み、分類済みの形でここへ押し出す（§10）。
//   **Workerはカレンダーを読まない。** 組織ポリシー（iam.disableServiceAccountKeyCreation）が
//   サービスアカウントの鍵を禁じており、①は③（予約の正本をD1へ）が終われば向きが逆になって
//   消える仕組みなので、捨てるものに認証を作り込まない。
//
//   ここの仕事は4つだけ：
//     1. 受け取る（合言葉。ingest.js と同じ作法。合言葉のない経路は作らない）
//     2. 中身が前回と同じか見る → 同じなら checked_at だけ更新して終わり（§5-4）
//     3. 検査する（§6）→ 1つでも当たれば公開しない（status=rejected）
//     4. 公開する（§5-7）→ 条件付き更新で原子的に差し替え、古い世代を消す（§8）
//
//   ★分類の条件をここに書き写さない。worker/src/lib/calclass.js を使う。
//     同じ条件を2か所に書くと必ず食い違う（2026-10-02、体験予約だけが休憩・ブロックを
//     見落として実際に二重予約が起きた）。役割の妥当性も classifyEvent に判定させる。
//   ★タイトル・氏名は保存しない（§4）。GASも送ってこない。拒否の理由にも入れない。
//   ★「2つの時刻」を取り違えない（§4）。
//       calendar_active.checked_at … 正常に確認できた時刻。中身が変わらなくても毎回更新
//       calendar_snapshot.built_at … その世代を作り終えた時刻。世代を作った時だけ
//     鮮度は checked_at で見る。ここを取り違えると、2分変更がないだけでD1が使えなくなる。

import { allowedEffectsFor, trainerVariesPerEvent, classifyEvent, overlaps, findInvalidIntervals, CAL_ROLE, EV_KIND } from '../lib/calclass.js';

// ---- 上限と期限 -------------------------------------------------------------
const MAX_EVENTS_TOTAL = 20000;          // 1回の押し出しで受ける予定の総数（記憶と書き込みの保険）
const MAX_EVENTS_PER_CALENDAR = 5000;    // §5：1カレンダー5,000件を超えたら公開しない
const INSERT_CHUNK = 50;                 // D1のbatchに1度に渡す文の数
const KEEP_READY = 3;                    // §8：公開中 ＋ 過去に公開された ready 2つ
const REJECTED_TTL_MS = 24 * 3600000;    // §8：rejected は24時間残す（原因を追うため）
const BUILDING_STALE_MS = 15 * 60000;    // §8：building のまま残ったものを rejected にする期限
const MAX_REASONS = 50;                  // 理由の記録を無制限に増やさない
const MAX_PUSH_AGE_MS = 120000;          // §5：上限2分。pushedAt が来たときだけ見る

// 必要なカレンダー（§6 取得：4つのどれかが取れなかった ＝ 公開しない）
//   ★この数は GAS の CALENDAR_IDS.TRAINERS と同じでなければならない。
//     トレーナーが増えるぶんは通る（>=）。減ったときは必ず落ちる。
//     落ちれば公開中の世代がそのまま使われ、鮮度切れでGASへ落ちるだけなので顧客に害は出ない。
const REQUIRED_TRAINER_CALENDARS = 3;

const HASH_RE = /^[0-9a-f]{64}$/;        // §5：SHA-256（16進の小文字）
const MAX_REASON_TEXT = 32;              // reason（埋まりの内訳）の文字数の上限

const EV_COLS = ['generation', 'calendar_id', 'event_id', 'role', 'trainer_id',
                 'effect', 'reason', 'start_at', 'end_at', 'all_day'];
const EV_SQL = `INSERT INTO calendar_events (${EV_COLS.join(', ')}) VALUES (${EV_COLS.map(() => '?').join(', ')})`;

// 長さと中身の両方で時間差が出ない比較（合言葉の推測を助けない）
//   ★ingest.js / jobs.js / verify.js と同じ実装。1つにまとめたいが、この作業では
//     他のファイルを触らない取り決めのため写した。test/calsync.test.js が
//     ingest.js の実装と答えが一致することを検査しているので、黙って食い違うことはない。
function safeEqual(a, b) {
  const x = new TextEncoder().encode(String(a || ''));
  const y = new TextEncoder().encode(String(b || ''));
  let diff = x.length ^ y.length;
  const n = Math.max(x.length, y.length);
  for (let i = 0; i < n; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function jsonRes(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

// ---- 役割ごとに「ありうる effect」を calclass から導く -----------------------
//   ★ここで条件を書かない。代表的なタイトルを calclass.js に通して、
//     その役割で出てくる effect の集合を作る。calclass を直せばここも自動で追従する。
//     知らない役割は classifyEvent が落ちる（fail-closed）ので、役割の検査も兼ねる。
const PROBE_TITLES = ['出勤可能', 'シフト', '[RESERVED] x', '✅ x', '休憩', 'ブロック_私用',
                      '[消化] x', 'なんでもない予定', ''];

export function allowedEffects(role) {
  // ★代表タイトルを classifyEvent に通して導く方式はやめた（2026-10-02）。
  //   1Fは送り手（GAS）が担当を読んで busy / room_busy を使い分けるが、
  //   classifyEvent はタイトルだけで決めるので busy を返さない。
  //   その結果、正しい押し出しを毎回 EFFECT_ROLE_MISMATCH で拒否し、
  //   D1が永久に公開されない状態になっていた。役割ごとの一覧を直接持つ。
  return new Set(allowedEffectsFor(role));   // 知らない役割はここで落ちる
}

// ---- カレンダー構成の正規形 --------------------------------------------------
//   calendar_id 順に並べ、キーの順も固定する。こうしておくと
//   「いまの構成と同じか」（§5-4 / §7）が文字列1回の比較で済む。
export function normalizeCalendars(list) {
  const out = [];
  for (const c of (Array.isArray(list) ? list : [])) {
    const o = c || {};
    out.push({
      calendar_id: o.calendarId == null ? '' : String(o.calendarId),
      role: o.role == null ? '' : String(o.role),
      trainer_id: (o.trainerId == null || o.trainerId === '') ? null : String(o.trainerId),
    });
  }
  out.sort((a, b) => (a.calendar_id < b.calendar_id ? -1 : a.calendar_id > b.calendar_id ? 1 : 0));
  return out;
}

// ---- 公開前の検査（§6）------------------------------------------------------
//   reasons が1つでもあれば公開しない。warnings は公開するが記録して知らせる。
//   ★理由にタイトル・氏名を入れない。入れるのは calendar_id / event_id / 件数だけ。
export function inspect(p, cals, now, prevCount) {
  const reasons = [];
  const warnings = [];
  const add = (code, extra) => {
    if (reasons.length < MAX_REASONS) reasons.push(Object.assign({ code }, extra || {}));
  };

  // GASが「壊れている」と判断した予定が1件でもあれば公開しない。
  //   黙って捨てると、日時変換の不具合が「予定が無い」＝「席が空いている」に化ける。
  const invalid = Array.isArray(p.invalid) ? p.invalid : [];
  if (invalid.length > 0) {
    add('GAS_INVALID_EVENTS', {
      count: invalid.length,
      first: invalid.slice(0, 5).map((v) => ({
        calendarId: v && v.calendarId ? String(v.calendarId) : '',
        eventId: v && v.eventId ? String(v.eventId) : '',
        reason: v && v.reason ? String(v.reason).slice(0, 32) : '',
      })),
    });
  }

  // ---- カレンダーの構成 ----
  const byId = new Map();
  const effByRole = new Map();
  const trainers = new Set();
  let b1 = 0, f1 = 0;
  for (const c of cals) {
    if (!c.calendar_id) { add('CALENDAR_ID_MISSING'); continue; }
    if (byId.has(c.calendar_id)) { add('DUPLICATE_CALENDAR', { calendarId: c.calendar_id }); continue; }
    try {
      if (!effByRole.has(c.role)) effByRole.set(c.role, allowedEffects(c.role));
    } catch (_) {
      // 知らない役割（綴り違い）を通すと、部屋の予定が「席が空いている」になりうる
      add('UNKNOWN_ROLE', { calendarId: c.calendar_id, role: c.role });
      continue;
    }
    byId.set(c.calendar_id, c);
    if (c.role === CAL_ROLE.CAPACITY_B1) b1++;
    else if (c.role === CAL_ROLE.CAPACITY_1F) f1++;
    else if (c.role === CAL_ROLE.TRAINER) {
      if (!c.trainer_id) add('CALENDAR_TRAINER_ID_MISSING', { calendarId: c.calendar_id });
      else trainers.add(c.trainer_id);
    }
    if (c.role !== CAL_ROLE.TRAINER && c.trainer_id) {
      add('CALENDAR_TRAINER_ID_UNEXPECTED', { calendarId: c.calendar_id });
    }
  }
  // B1を欠くと、部屋が埋まっている時間を3人分まとめて「空いています」と誤表示する（§1★）
  if (b1 !== 1) add('CAPACITY_B1_MISSING', { count: b1 });
  if (trainers.size < REQUIRED_TRAINER_CALENDARS) {
    add('TRAINER_CALENDARS_MISSING', { count: trainers.size, need: REQUIRED_TRAINER_CALENDARS });
  }
  // 1Fが on のときはD1の空き枠を使わない（§1）。公開は止めないが、気づけるようにする。
  if (p.flag1f === 'on') warnings.push({ code: 'FLAG_1F_ON', calendars1f: f1 });

  // ---- 予定 ----
  const events = p.events;
  // 壊れた区間（逆向き・幅0・整数でない）の判定は calclass に任せる
  const badIv = new Map();
  for (const b of findInvalidIntervals(events.map((e) => ({ start: e && e.startAt, end: e && e.endAt })))) {
    badIv.set(b.index, b.reason);
  }

  const seen = new Set();
  const perCal = new Map();
  const shiftByTrainer = new Map();
  for (const t of trainers) shiftByTrainer.set(t, 0);

  for (let i = 0; i < events.length; i++) {
    const e = events[i] || {};
    const calId = e.calendarId == null ? '' : String(e.calendarId);
    const evId = e.eventId == null ? '' : String(e.eventId);
    const at = { calendarId: calId, eventId: evId };

    if (!calId || !evId) { add('EVENT_KEY_MISSING', at); continue; }
    const key = calId + '\u0000' + evId;
    if (seen.has(key)) { add('DUPLICATE_EVENT', at); continue; }   // 同じ主キーは入れられない
    seen.add(key);
    perCal.set(calId, (perCal.get(calId) || 0) + 1);

    const decl = byId.get(calId);
    if (!decl) { add('UNDECLARED_CALENDAR', at); continue; }        // 一覧に無いカレンダーの予定
    if ((e.role == null ? '' : String(e.role)) !== decl.role) { add('ROLE_CONFLICT', at); continue; }
    const tid = (e.trainerId == null || e.trainerId === '') ? null : String(e.trainerId);
    const effect = e.effect == null ? '' : String(e.effect);
    // ★1Fは予定ごとに担当が変わる（オンラインの担当がタイトルに書いてある）。
    //   カレンダーの宣言（trainer_id=null）と突き合わせると必ず食い違い、
    //   正しい押し出しを毎回拒否してしまう。1Fだけは宣言と比べない。
    //   代わりに「busy なら担当が要る／room_busy なら担当を持たない」を見る。
    if (trainerVariesPerEvent(decl.role)) {
      if (effect === EV_KIND.BUSY && !tid) { add('TRAINER_ID_MISSING', at); continue; }
      if (effect === EV_KIND.ROOM_BUSY && tid) { add('TRAINER_ID_UNEXPECTED', at); continue; }
    } else if (tid !== decl.trainer_id) { add('TRAINER_ID_CONFLICT', at); continue; }

    const bad = badIv.get(i);
    if (bad) { add('BAD_INTERVAL', Object.assign({ reason: bad }, at)); continue; }

    const allow = effByRole.get(decl.role);
    if (!allow || !allow.has(effect)) { add('EFFECT_ROLE_MISMATCH', Object.assign({ effect }, at)); continue; }

    if (e.allDay !== 0 && e.allDay !== 1) { add('BAD_ALL_DAY', at); continue; }
    const reason = typeof e.reason === 'string' ? e.reason : '';
    if (!reason || reason.length > MAX_REASON_TEXT) { add('REASON_MISSING', at); continue; }

    // 地平とまったく重ならない予定（§6）。重なりの条件は calclass に統一させる。
    if (!overlaps(e.startAt, e.endAt, p.horizonStart, p.horizonEnd)) { add('OUT_OF_HORIZON', at); continue; }

    if (effect === EV_KIND.SHIFT && tid != null && shiftByTrainer.has(tid)) {
      shiftByTrainer.set(tid, shiftByTrainer.get(tid) + 1);
    }
  }

  for (const [calId, n] of perCal) {
    if (n > MAX_EVENTS_PER_CALENDAR) add('CALENDAR_TOO_MANY', { calendarId: calId, count: n });
  }

  // 出勤（§6 運用）。全員0件は止める／一部0件は警告（休業・休職がありうる）。
  const zero = [...shiftByTrainer].filter(([, n]) => n === 0).map(([t]) => t);
  if (shiftByTrainer.size > 0 && zero.length === shiftByTrainer.size) add('NO_SHIFTS', { trainers: zero });
  else if (zero.length > 0) warnings.push({ code: 'SHIFT_ZERO_SOME', trainers: zero });

  // 傾向（§6 警告）
  if (prevCount > 0 && events.length * 2 <= prevCount) {
    warnings.push({ code: 'COUNT_DROP', from: prevCount, to: events.length });
  }
  if (p.horizonEnd <= now) warnings.push({ code: 'HORIZON_PAST', horizonEnd: p.horizonEnd });

  return { reasons, warnings, shiftByTrainer: [...shiftByTrainer] };
}

// ============================================================
// 入口
// ============================================================
export async function handleCalSync(request, env) {
  try {
    return await calsync(request, env);
  } catch (e) {
    // 合言葉を通った相手（GAS）しか到達しないので、原因を返す（直せるほうがよい）
    console.error('calsync', e && e.stack);
    return jsonRes({ success: false, code: 'INTERNAL', detail: String((e && e.message) || e).slice(0, 300) }, 500);
  }
}

async function calsync(request, env) {
  const secret = env.SHARED_SECRET || '';
  if (!secret) return jsonRes({ success: false, code: 'SECRET_NOT_SET' }, 503);
  if (!safeEqual(request.headers.get('X-Ingest-Secret') || '', secret)) {
    return jsonRes({ success: false, code: 'FORBIDDEN' }, 403);
  }

  let body;
  try { body = await request.json(); } catch (_) { return jsonRes({ success: false, code: 'BAD_JSON' }, 400); }

  // ---- 1. 形の検証（ここで落ちたものは世代として記録しない。押し出す側が壊れている）----
  const horizonStart = body.horizonStart, horizonEnd = body.horizonEnd;
  if (!isInt(horizonStart) || !isInt(horizonEnd) || horizonEnd <= horizonStart) {
    return jsonRes({ success: false, code: 'BAD_HORIZON' }, 400);
  }
  const ruleVersion = body.ruleVersion;
  if (!isInt(ruleVersion) || ruleVersion < 1) return jsonRes({ success: false, code: 'BAD_RULE_VERSION' }, 400);
  const flag1f = String(body.flag1f == null ? '' : body.flag1f);
  if (flag1f !== 'on' && flag1f !== 'off') return jsonRes({ success: false, code: 'BAD_FLAG_1F' }, 400);
  const contentHash = String(body.contentHash == null ? '' : body.contentHash);
  // ★形を必ず見る。空文字を通すと「前回も空」で中身が同じに見え、古い世代が
  //   いつまでも新しい扱いになる（checked_at だけが進む）。
  if (!HASH_RE.test(contentHash)) return jsonRes({ success: false, code: 'BAD_CONTENT_HASH' }, 400);
  if (!Array.isArray(body.calendars) || body.calendars.length === 0) {
    return jsonRes({ success: false, code: 'BAD_CALENDARS' }, 400);
  }
  if (!Array.isArray(body.events)) return jsonRes({ success: false, code: 'EVENTS_NOT_ARRAY' }, 400);
  if (body.events.length > MAX_EVENTS_TOTAL) return jsonRes({ success: false, code: 'TOO_MANY' }, 413);

  const now = Date.now();
  // 遅れて届いた押し出しで鮮度を実際より新しく見せない。
  //   ★pushedAt は任意（いまのGASは送らない）。送ってくれば効く。
  if (typeof body.pushedAt === 'number' && isFinite(body.pushedAt) && now - body.pushedAt > MAX_PUSH_AGE_MS) {
    return jsonRes({ success: false, code: 'STALE_PUSH', age: now - body.pushedAt }, 409);
  }

  const cals = normalizeCalendars(body.calendars);
  const calsJson = JSON.stringify(cals);
  const p = {
    horizonStart, horizonEnd, ruleVersion, flag1f, contentHash,
    events: body.events, invalid: body.invalid,
  };

  // ---- 2. いまの公開世代を1回のSQLで読む ----
  //   可否判定と同じ考え方（§7）。別々に読むと、その間に差し替わる。
  let cur = await env.DB.prepare(
    `SELECT a.generation AS generation, a.checked_at AS checked_at, s.status AS status,
            s.horizon_start AS horizon_start, s.horizon_end AS horizon_end,
            s.rule_version AS rule_version, s.flag_1f AS flag_1f,
            s.content_hash AS content_hash, s.calendars AS calendars
       FROM calendar_active a LEFT JOIN calendar_snapshot s ON s.generation = a.generation
      WHERE a.id = 1`
  ).first();
  if (!cur) {
    // 1行目が無い（schema.sql の seed が流れていない）。作ってから続ける。
    await env.DB.prepare(
      'INSERT OR IGNORE INTO calendar_active (id, generation, checked_at) VALUES (1, NULL, NULL)'
    ).run();
    cur = { generation: null, checked_at: null, status: null };
  }
  const prevGen = cur.generation == null ? null : Number(cur.generation);
  const expected = prevGen == null ? -1 : prevGen;     // 条件付き更新の比較値

  // ---- 3. 中身が前回と同じなら何も書かない（§5-4）----
  //   ★content_hash だけで決めてはいけない。25日に地平が翌月末まで伸びても、
  //     その範囲にまだ予定が1件も無ければ中身の印は前と同じになる。すると
  //     horizon_end が古いままなのに checked_at だけ新しくなり、翌月の要求が
  //     永久にGASへ落ち続ける。取得仕様（地平・規則の版・1Fフラグ・構成）も必ず比べる。
  const same = prevGen != null && cur.status === 'ready'
    && String(cur.content_hash) === contentHash
    && Number(cur.horizon_start) === horizonStart
    && Number(cur.horizon_end) === horizonEnd
    && Number(cur.rule_version) === ruleVersion
    && String(cur.flag_1f) === flag1f
    && String(cur.calendars) === calsJson;

  if (same) {
    // 更新するのは checked_at だけ（D1の書き込み1行）。built_at は触らない。
    //   条件を付ける：古い同期が新しい同期の結果を上書きしないため（§5★）。
    const r = await env.DB.prepare(
      'UPDATE calendar_active SET checked_at = ? WHERE id = 1 AND generation = ?'
    ).bind(now, prevGen).run();
    if (changes(r) !== 1) return jsonRes({ success: false, code: 'PUBLISH_RACE' }, 409);
    return jsonRes({ success: true, mode: 'unchanged', generation: prevGen, checkedAt: now });
  }

  // ---- 4. 検査する（§6）----
  let prevCount = 0;
  if (prevGen != null) {
    try {
      const c = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM calendar_events WHERE generation = ?'
      ).bind(prevGen).first();
      prevCount = Number((c && c.n) || 0);
    } catch (_) { prevCount = 0; }
  }
  const { reasons, warnings } = inspect(p, cals, now, prevCount);

  if (reasons.length) {
    // 落ちた世代も残す（§6）。ただし予定は書かない。
    //   理由だけで原因は追えるし、拒否した世代に数百行を使うとD1の書き込み枠を食う。
    const gen = await insertSnapshot(env, 'rejected', p, calsJson, now, reasons, warnings);
    console.warn('calsync rejected', gen, JSON.stringify(reasons).slice(0, 500));
    await cleanupSafe(env, prevGen, now);
    return jsonRes({ success: false, code: 'REJECTED', generation: gen, reasons, warnings }, 422);
  }

  // ---- 5. 新しい世代として書く（status=building）----
  const gen = await insertSnapshot(env, 'building', p, calsJson, now, null, warnings);

  // 予定を書く。途中で失敗しても building のままなので、公開中の世代は壊れない。
  for (let i = 0; i < p.events.length; i += INSERT_CHUNK) {
    const stmts = [];
    for (const e of p.events.slice(i, i + INSERT_CHUNK)) {
      const tid = (e.trainerId == null || e.trainerId === '') ? null : String(e.trainerId);
      stmts.push(env.DB.prepare(EV_SQL).bind(
        gen, String(e.calendarId), String(e.eventId), String(e.role), tid,
        String(e.effect), String(e.reason), e.startAt, e.endAt, e.allDay
      ));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }

  // ---- 6. 公開する（§5-7）----
  //   ★D1のbatchは「条件に合わず0行更新」でも成功として扱われる。だから
  //     公開に関わるすべての更新に同じ条件を付け、更新された行数を数える。
  //     条件：calendar_active.generation が、始めに読んだ値のままであること。
  //     これが無いと「Aが遅れる → Bが公開 → Aが復帰して古い結果を公開」で巻き戻る。
  const pub = await env.DB.batch([
    env.DB.prepare(
      `UPDATE calendar_snapshot SET status = 'ready', built_at = ?
         WHERE generation = ? AND status = 'building'
           AND COALESCE((SELECT generation FROM calendar_active WHERE id = 1), -1) = ?`
    ).bind(now, gen, expected),
    env.DB.prepare(
      `UPDATE calendar_active SET generation = ?, checked_at = ?
         WHERE id = 1 AND COALESCE(generation, -1) = ?`
    ).bind(gen, now, expected),
  ]);
  if (changes(pub[0]) !== 1 || changes(pub[1]) !== 1) {
    // 公開せず、次の押し出しに任せる。世代は building のまま残り、§8 が片付ける。
    return jsonRes({ success: false, code: 'PUBLISH_RACE', generation: gen, previous: prevGen }, 409);
  }

  if (warnings.length) console.warn('calsync warnings', gen, JSON.stringify(warnings).slice(0, 500));

  // ---- 7. 古い世代を消す（§8）。失敗しても公開は成功させる ----
  const removed = await cleanupSafe(env, gen, now);

  return jsonRes({
    success: true, mode: 'published', generation: gen, previous: prevGen,
    events: p.events.length, warnings, removed, checkedAt: now,
  });
}

// ---- 世代の行を1つ作る。採番はD1（AUTOINCREMENT）に任せる（MAX+1は使わない）----
async function insertSnapshot(env, status, p, calsJson, now, reasons, warnings) {
  const r = await env.DB.prepare(
    `INSERT INTO calendar_snapshot
       (status, horizon_start, horizon_end, calendars, rule_version, flag_1f, content_hash,
        reject_reasons, warnings, built_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(status, p.horizonStart, p.horizonEnd, calsJson, p.ruleVersion, p.flag1f, p.contentHash,
         reasons && reasons.length ? JSON.stringify(reasons) : null,
         warnings && warnings.length ? JSON.stringify(warnings) : null,
         now, now).run();
  const id = r && r.meta && (r.meta.last_row_id != null ? r.meta.last_row_id : r.meta.lastRowId);
  if (id == null) throw new Error('CALSYNC_NO_GENERATION');
  return Number(id);
}

// ---- 古い世代の削除（§8）----
//   残すもの：公開中の世代 ＋ ready な世代を新しい順に KEEP_READY 個
//   rejected は24時間残す（原因を追うため）。building は期限切れで rejected にする。
//   ★SQLの条件で、公開中の世代を必ず除外する。
const DELETABLE = `SELECT generation FROM calendar_snapshot
   WHERE generation <> ?
     AND ( (status = 'ready' AND generation NOT IN
              (SELECT generation FROM calendar_snapshot WHERE status = 'ready'
                ORDER BY generation DESC LIMIT ?))
        OR (status = 'rejected' AND created_at < ?) )`;

export async function cleanupGenerations(env, activeGen, now) {
  const keep = activeGen == null ? -1 : activeGen;
  // 放置された building を rejected にする（原因を24時間追えるようにしてから消える）
  await env.DB.prepare(
    `UPDATE calendar_snapshot
        SET status = 'rejected',
            reject_reasons = COALESCE(reject_reasons, '[{"code":"ABANDONED_BUILDING"}]')
      WHERE status = 'building' AND created_at < ? AND generation <> ?`
  ).bind(now - BUILDING_STALE_MS, keep).run();

  const args = [keep, KEEP_READY, now - REJECTED_TTL_MS];
  // 予定の削除と世代の削除は同じまとまりで行う（片方だけ消えた状態を作らない）
  const res = await env.DB.batch([
    env.DB.prepare(`DELETE FROM calendar_events WHERE generation IN (${DELETABLE})`).bind(...args),
    env.DB.prepare(`DELETE FROM calendar_snapshot WHERE generation IN (${DELETABLE})`).bind(...args),
  ]);
  return changes(res[1]);
}

async function cleanupSafe(env, activeGen, now) {
  try { return await cleanupGenerations(env, activeGen, now); }
  catch (e) { console.warn('calsync cleanup', e && e.message); return 0; }   // 掃除の失敗で公開を失敗させない
}

function changes(r) {
  return Number((r && r.meta && r.meta.changes) || 0);
}
function isInt(v) {
  return typeof v === 'number' && isFinite(v) && Math.floor(v) === v;
}

export const _forTest = {
  safeEqual, inspect, normalizeCalendars, allowedEffects, cleanupGenerations,
  REQUIRED_TRAINER_CALENDARS, MAX_EVENTS_TOTAL, MAX_EVENTS_PER_CALENDAR,
  KEEP_READY, REJECTED_TTL_MS, BUILDING_STALE_MS, INSERT_CHUNK, MAX_PUSH_AGE_MS,
};
