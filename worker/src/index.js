// Ice cream debt tracker API — Cloudflare Worker + D1.
//
// Every time Muneeb says "baad mein bataonga" he owes Fiza 2 ice creams.
// Only two people use this; each has a PIN sent in the X-Pin header.
// All responses are JSON. Successful calls return { state } (+ the affected item).

import { handlePush, notify } from "./push.js";

const OWE_QTY = 2;
const COOLDOWN_MS = 3 * 60 * 1000; // global cooldown after any +2
const UNDO_WINDOW_MS = 60 * 1000; // you can undo your own latest event for 60s
const MAX_NOTE = 280;
const MAX_NAME = 80;
const MAX_LETTER = 1000;
const MILESTONE_STEP = 10; // a surprise every 10 ice creams owed, starting at 20
const MILESTONE_FIRST = 20;
const MILESTONE_LAST = 1000;
// Muneeb can unfreeze the bell: rings older than this setting don't count toward the cooldown.
const COOLDOWN_RESET_SQL = `COALESCE((SELECT CAST(value AS INTEGER) FROM settings WHERE key = 'cooldown_reset_at'), 0)`;
const OPENS_KEEP_MS = 90 * 24 * 60 * 60 * 1000; // Fiza's visit log is kept for 90 days
const OPEN_GAP_MS = 2 * 60 * 1000; // away longer than this = a new visit
const OPEN_NOTIFY_GAP_MS = 10 * 60 * 1000; // at most one "Fiza walked in" ping per 10 minutes
const MAX_COMMENT = 500;
const MAX_PHOTO_BYTES = 95 * 1024 * 1024; // originals are kept untouched; just under the 100 MB request cap
const MAX_PIN_TRIES = 10; // wrong PINs from one IP before it gets locked out
const LOCKOUT_MS = 15 * 60 * 1000;

export default {
  async fetch(request, env, ctx) {
    const cors = corsHeaders(request, env);

    // CORS preflight: browsers don't send X-Pin here, so answer before auth.
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      const db = env.DB;
      const ip = request.headers.get("CF-Connecting-IP") || "local";
      const pin = request.headers.get("X-Pin");
      const now = Date.now();
      const [attemptRes, pinRes] = await db.batch([
        db.prepare(`SELECT * FROM pin_attempts WHERE ip = ?`).bind(ip),
        db.prepare(`SELECT key, value FROM settings WHERE key IN ('pin_fiza', 'pin_muneeb')`),
      ]);
      const attempt = attemptRes.results[0] ?? null;
      const pinHashes = Object.fromEntries(pinRes.results.map((r) => [r.key, r.value]));

      // A locked-out IP is refused even with a correct PIN, so guessing can't continue.
      if (attempt?.locked_until > now) return lockedOut(attempt.locked_until, now, cors);

      const me = await whoIs(pin, env, pinHashes);
      const entry = logEntry(request);
      if (!me) {
        if (!pin) return json({ error: "bad_pin" }, 401, cors);
        ctx.waitUntil(writeLog(db, entry, null, 401, null, "wrong PIN"));
        const fails = (attempt && !attempt.locked_until ? attempt.fails : 0) + 1;
        const lockedUntil = fails >= MAX_PIN_TRIES ? now + LOCKOUT_MS : null;
        await db
          .prepare(
            `INSERT INTO pin_attempts (ip, fails, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (ip) DO UPDATE SET fails = ?2, locked_until = ?3, updated_at = ?4`
          )
          .bind(ip, lockedUntil ? 0 : fails, lockedUntil, now)
          .run();
        if (lockedUntil) return lockedOut(lockedUntil, now, cors);
        return json({ error: "bad_pin", triesLeft: MAX_PIN_TRIES - fails }, 401, cors);
      }
      if (attempt) await db.prepare(`DELETE FROM pin_attempts WHERE ip = ?`).bind(ip).run();

      let result;
      try {
        result = await route(request, env, me, ctx);
      } catch (err) {
        const status = err instanceof HttpError ? err.status : 500;
        if (entry.log) ctx.waitUntil(writeLog(db, entry, me, status, err.body ?? { error: String(err) }));
        throw err;
      }
      if (entry.log && !(result instanceof Response)) {
        ctx.waitUntil(writeLog(db, entry, me, result.status ?? 200, result.body));
      }
      if (result instanceof Response) {
        // Raw responses (photos) still need the CORS headers.
        for (const [k, v] of Object.entries(cors)) result.headers.set(k, v);
        return result;
      }
      return json(result.body, result.status ?? 200, cors);
    } catch (err) {
      if (err instanceof HttpError) return json(err.body, err.status, cors);
      console.error(err);
      return json({ error: "server_error" }, 500, cors);
    }
  },

  // Cron (see wrangler.toml): settles finished Scoop Stack races + the last-day reminder.
  async scheduled(event, env, ctx) {
    ctx.waitUntil(gameCron(env, event.scheduledTime || Date.now()));
  },
};

// ---------------------------------------------------------------------------
// Routing

async function route(request, env, me, ctx) {
  const db = env.DB;
  const { pathname } = new URL(request.url);
  const method = request.method;
  const path = pathname.replace(/\/+$/, "") || "/";

  const pushResult = await handlePush(request, env, me, path, method);
  if (pushResult) return pushResult;

  if (method === "GET" && path === "/state") {
    return ok(await getState(db, me));
  }
  if (method === "POST" && path === "/owe") {
    const res = await owe(db, me, await readBody(request));
    const n = res.body.state.totals.pending;
    tell(ctx, env, me, me === "Fiza"
      ? { title: "🔔 Caught!", body: `Fiza rang the bell. +2, that's ${n} now 🙄`, tag: "owe" }
      : { title: "🫡 Muneeb self-reported", body: `+2. Respect. ${n} now.`, tag: "owe" });
    return res;
  }
  if (method === "POST" && path === "/paid") {
    const res = await paid(db, me, await readBody(request));
    tell(ctx, env, me, {
      title: `😋 ${plural(res.body.event.qty, "ice cream")} paid off`,
      body: `${me} logged it. ${res.body.state.totals.pending} to go.`,
      tag: "paid",
    });
    return res;
  }
  if (method === "POST" && path === "/undo") return undo(db, me);
  if (method === "POST" && path === "/shops") return createShop(db, me, await readBody(request));
  if (method === "POST" && path === "/posts") {
    const res = await createPost(db, env, me, request);
    const p = res.body.post;
    const shop = p.shopId && res.body.state.shops.find((s) => s.id === p.shopId)?.name;
    const bits = [shop, p.rating ? "🍦".repeat(p.rating) : null, p.note ? `“${p.note}”` : null,
      p.paidQty ? `${plural(p.paidQty, "ice cream")} off the debt` : null].filter(Boolean);
    tell(ctx, env, me, { title: `📸 New polaroid from ${me}`, body: bits.join(" · ") || "Come see it 👀", tag: "post" });
    return res;
  }
  if (method === "POST" && path === "/spin") {
    const body = await readBody(request);
    const name = optText(body, "name", MAX_NAME);
    const emoji = optText(body, "emoji", 8);
    if (name) {
      tell(ctx, env, me, { title: `🎡 ${me} spun the wheel`, body: `Aaj ka flavour: ${name}${emoji ? " " + emoji : ""}`, tag: "spin" });
    }
    return { body: { ok: true } };
  }
  if (method === "POST" && path === "/game/start") return gameStart(db, env, me, ctx);
  if (method === "POST" && path === "/game/score") return gameScore(db, env, me, await readBody(request), ctx);

  let m;
  if (method === "POST" && (m = path.match(/^\/game\/months\/(\d{4}-\d{2})\/paid$/))) {
    return gamePaid(db, env, me, m[1], ctx);
  }
  if (method === "PATCH" && (m = path.match(/^\/events\/(\d+)$/))) {
    return editEventNote(db, me, Number(m[1]), await readBody(request));
  }
  if ((m = path.match(/^\/shops\/(\d+)$/))) {
    const id = Number(m[1]);
    if (method === "PATCH") return updateShop(db, me, id, await readBody(request));
    if (method === "DELETE") return deleteShop(db, me, id);
  }
  if (method === "GET" && (m = path.match(/^\/posts\/(\d+)\/photo$/))) {
    return getPhoto(db, env, Number(m[1]), new URL(request.url).searchParams.get("size"));
  }
  if (method === "DELETE" && (m = path.match(/^\/posts\/(\d+)$/))) return deletePost(db, env, me, Number(m[1]));
  if (method === "PUT" && (m = path.match(/^\/posts\/(\d+)\/reaction$/))) {
    const res = await reactToPost(db, me, Number(m[1]), await readBody(request));
    if (res.notify) tell(ctx, env, me, res.notify);
    return res.result;
  }
  if (method === "POST" && (m = path.match(/^\/posts\/(\d+)\/comments$/))) {
    const res = await commentOnPost(db, me, Number(m[1]), await readBody(request));
    tell(ctx, env, me, res.notify);
    return res.result;
  }
  if (method === "DELETE" && (m = path.match(/^\/posts\/(\d+)\/comments\/(\d+)$/))) {
    return deleteComment(db, me, Number(m[1]), Number(m[2]));
  }
  if (method === "PATCH" && (m = path.match(/^\/milestones\/(\d+)$/))) {
    return writeLetter(db, me, milestone(m[1]), await readBody(request));
  }
  if (method === "POST" && (m = path.match(/^\/milestones\/(\d+)\/open$/))) {
    return openLetter(db, me, milestone(m[1]), ctx, env);
  }
  if (method === "POST" && path === "/pin/fiza") {
    return setPin(db, env, me, "fiza", await readBody(request));
  }
  if (method === "POST" && path === "/pin/muneeb") {
    return setPin(db, env, me, "muneeb", await readBody(request));
  }

  if (method === "POST" && path === "/hello") return recordOpen(db, me, request, await readBody(request), ctx, env);
  if (method === "POST" && (m = path.match(/^\/hello\/(\d+)$/))) return pingOpen(db, me, request, Number(m[1]), ctx, env);

  // Admin (Muneeb only)
  if (path.startsWith("/admin/") && me !== "Muneeb") throw new HttpError(403, { error: "muneeb_only" });
  if (method === "DELETE" && (m = path.match(/^\/admin\/events\/(\d+)$/))) return adminDeleteEvent(db, me, Number(m[1]));
  if (method === "PATCH" && path === "/admin/archives") return adminSetArchives(db, me, await readBody(request));
  if (method === "POST" && path === "/admin/unfreeze") return adminUnfreeze(db, me);
  if (method === "DELETE" && (m = path.match(/^\/admin\/opens\/(\d+)$/))) {
    await db.prepare(`DELETE FROM opens WHERE id = ?`).bind(Number(m[1])).run(); // "That was me"
    return ok(await getState(db, me));
  }
  if (method === "POST" && (m = path.match(/^\/admin\/milestones\/(\d+)\/reseal$/))) {
    return adminReseal(db, me, milestone(m[1]));
  }
  if (method === "DELETE" && (m = path.match(/^\/admin\/game\/scores\/(\d+)$/))) {
    return adminDeleteScore(db, me, Number(m[1]));
  }
  if (method === "POST" && (m = path.match(/^\/admin\/game\/months\/(\d{4}-\d{2})\/unpaid$/))) {
    await db.prepare(`UPDATE game_months SET paid_at = NULL WHERE month = ?`).bind(m[1]).run();
    return ok(await getState(db, me));
  }
  if (method === "POST" && (m = path.match(/^\/admin\/bin\/(\d+)\/restore$/))) return adminRestore(db, me, Number(m[1]));
  if (method === "GET" && (m = path.match(/^\/admin\/bin\/(\d+)\/photo$/))) {
    return adminBinPhoto(db, env, Number(m[1]), new URL(request.url).searchParams.get("size"));
  }

  throw new HttpError(404, { error: "not_found" });
}

// ---------------------------------------------------------------------------
// Handlers

async function owe(db, me, body) {
  const note = optText(body, "note", MAX_NOTE);
  const now = Date.now();

  // Insert only if no owe (by anyone) happened within the cooldown window.
  // Doing the check inside the INSERT keeps it atomic against double taps.
  const row = await db
    .prepare(
      `INSERT INTO events (type, qty, by, note, created_at)
       SELECT 'owe', ?1, ?2, ?3, ?4
       WHERE NOT EXISTS (SELECT 1 FROM events WHERE type = 'owe' AND created_at > ?5
                           AND created_at > ${COOLDOWN_RESET_SQL})
       RETURNING *`
    )
    .bind(OWE_QTY, me, note, now, now - COOLDOWN_MS)
    .first();

  if (!row) {
    const last = await db
      .prepare(`SELECT MAX(created_at) AS t FROM events WHERE type = 'owe'`)
      .first();
    const cooldownUntil = (last?.t ?? now) + COOLDOWN_MS;
    throw new HttpError(429, {
      error: "cooldown",
      retryAfter: Math.max(1, Math.ceil((cooldownUntil - now) / 1000)),
      cooldownUntil,
    });
  }

  return ok(await getState(db, me), { event: toEvent(row) });
}

async function paid(db, me, body) {
  const qty = body.qty;
  if (!Number.isInteger(qty) || qty < 1) badRequest("qty must be an integer >= 1");
  const flavour = optText(body, "flavour", MAX_NAME);
  const note = optText(body, "note", MAX_NOTE);
  const shopId = optInt(body, "shopId");

  if (shopId !== null) {
    const shop = await db.prepare(`SELECT id FROM shops WHERE id = ?`).bind(shopId).first();
    if (!shop) badRequest("shopId does not match a shop");
  }

  const row = await db.prepare(PAID_INSERT_SQL).bind(qty, me, note, flavour, shopId, Date.now()).first();
  if (!row) throw new HttpError(409, { error: "nothing_owed" });
  return ok(await getState(db, me), { event: toEvent(row) });
}

// Cap qty at what's pending, and insert nothing if pending is 0 — in one statement.
const PAID_INSERT_SQL = `INSERT INTO events (type, qty, by, note, flavour, shop_id, created_at)
  SELECT 'paid', MIN(?1, pending), ?2, ?3, ?4, ?5, ?6
  FROM (SELECT COALESCE(SUM(CASE type WHEN 'owe' THEN qty ELSE -qty END), 0) AS pending FROM events)
  WHERE pending > 0
  RETURNING *`;

// Notify the other person (never the one who did it). Runs after the response.
function tell(ctx, env, me, msg) {
  ctx.waitUntil(notify(env, me === "Muneeb" ? "Fiza" : "Muneeb", { url: "./", ...msg }));
}
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;

// ---- Scrapbook: one polaroid per ice cream, full-size original kept in R2 ----

const photoKey = (id, size) => `posts/${id}/${size === "thumb" ? "thumb" : "original"}`;

// multipart/form-data: photo (original, untouched), thumb (small preview made on the
// phone), and optional rating 1-5, note, shopId, flavour, paidQty, width, height.
async function createPost(db, env, me, request) {
  let form;
  try {
    form = await request.formData();
  } catch {
    badRequest("expected multipart form data");
  }
  const photo = form.get("photo");
  const thumb = form.get("thumb");
  if (!(photo instanceof File) || !photo.size) badRequest("photo is required");
  if (!/^image\//.test(photo.type || "")) badRequest("photo must be an image");
  if (photo.size > MAX_PHOTO_BYTES) badRequest("photo is too big");
  if (!(thumb instanceof File) || !thumb.size) badRequest("thumb is required");

  const field = (k) => {
    const v = form.get(k);
    return typeof v === "string" && v.trim() ? v.trim() : null;
  };
  const int = (k) => (field(k) === null ? null : Number(field(k)));
  const rating = int("rating");
  if (rating !== null && !(Number.isInteger(rating) && rating >= 1 && rating <= 5)) badRequest("rating must be 1-5");
  const shopId = int("shopId");
  if (shopId !== null) {
    const shop = Number.isInteger(shopId) && (await db.prepare(`SELECT id FROM shops WHERE id = ?`).bind(shopId).first());
    if (!shop) badRequest("shopId does not match a shop");
  }
  const paidQty = int("paidQty") ?? 0;
  if (!Number.isInteger(paidQty) || paidQty < 0) badRequest("paidQty must be a whole number");
  const note = field("note") ? clip(field("note"), MAX_NOTE) : null;
  const flavour = field("flavour") ? clip(field("flavour"), MAX_NAME) : null;
  const dim = (k) => (Number.isInteger(int(k)) && int(k) > 0 ? int(k) : null);
  const now = Date.now();

  // "Counts toward the debt": also log the pay-off (silently skipped if nothing is owed).
  const paidEvent = paidQty > 0
    ? await db.prepare(PAID_INSERT_SQL).bind(paidQty, me, note, flavour, shopId, now).first()
    : null;

  const post = await db
    .prepare(
      `INSERT INTO posts (by, created_at, country, rating, note, shop_id, flavour, paid_event_id,
                          photo_type, photo_bytes, width, height)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`
    )
    .bind(me, now, request.cf?.country || null, rating, note, shopId, flavour, paidEvent?.id ?? null,
      photo.type, photo.size, dim("width"), dim("height"))
    .first();

  try {
    await Promise.all([
      env.PHOTOS.put(photoKey(post.id, "full"), photo, { httpMetadata: { contentType: photo.type } }),
      env.PHOTOS.put(photoKey(post.id, "thumb"), thumb, { httpMetadata: { contentType: thumb.type || "image/jpeg" } }),
    ]);
  } catch (err) {
    // Don't leave a polaroid (or a pay-off) behind without its photo.
    const undo = [db.prepare(`DELETE FROM posts WHERE id = ?`).bind(post.id)];
    if (paidEvent) undo.push(db.prepare(`DELETE FROM events WHERE id = ?`).bind(paidEvent.id));
    await db.batch(undo);
    throw err;
  }
  return ok(await getState(db, me), { post: toPost({ ...post, paid_qty: paidEvent?.qty ?? null }) });
}

// Photos are private: only requests with a valid PIN get here.
async function getPhoto(db, env, id, size) {
  const row = await db.prepare(`SELECT id FROM posts WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  const obj = await env.PHOTOS.get(photoKey(id, size));
  if (!obj) throw new HttpError(404, { error: "not_found" });
  return new Response(obj.body, {
    headers: {
      "Content-Type": obj.httpMetadata?.contentType || "image/jpeg",
      "Content-Length": String(obj.size),
      "Cache-Control": "private, max-age=31536000, immutable", // a post's photo never changes
    },
  });
}

// The poster can delete their own polaroid; Muneeb can delete any. A polaroid that
// counted toward the debt takes its pay-off with it. It all goes to the bin, and the
// photo stays in R2, so Muneeb can bring it back.
async function deletePost(db, env, me, id) {
  const row = await db.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  if (row.by !== me && me !== "Muneeb") throw new HttpError(403, { error: "not_yours" });
  const [reactions, comments, paidEvent] = await db.batch([
    db.prepare(`SELECT * FROM post_reactions WHERE post_id = ?`).bind(id),
    db.prepare(`SELECT * FROM post_comments WHERE post_id = ?`).bind(id),
    db.prepare(`SELECT * FROM events WHERE id = ?`).bind(row.paid_event_id),
  ]);
  const steps = [
    toBin(db, me, "post", id, {
      post: row, reactions: reactions.results, comments: comments.results, paidEvent: paidEvent.results[0] ?? null,
    }),
    db.prepare(`DELETE FROM posts WHERE id = ?`).bind(id),
    db.prepare(`DELETE FROM post_reactions WHERE post_id = ?`).bind(id),
    db.prepare(`DELETE FROM post_comments WHERE post_id = ?`).bind(id),
  ];
  if (row.paid_event_id) steps.push(db.prepare(`DELETE FROM events WHERE id = ?`).bind(row.paid_event_id));
  await db.batch(steps);
  return ok(await getState(db, me));
}

// ---- Reactions + comments on polaroids ----

const REACTIONS = ["🍦", "🍨", "😋", "❤️", "🤍"];

async function postOrThrow(db, id) {
  const post = await db.prepare(`SELECT id, by, note FROM posts WHERE id = ?`).bind(id).first();
  if (!post) throw new HttpError(404, { error: "not_found" });
  return post;
}
// "your polaroid" when the person being notified posted it.
const whosePolaroid = (post, me) => (post.by === me ? "their own polaroid" : "your polaroid");

// { emoji } sets my reaction; { emoji: null } removes it.
async function reactToPost(db, me, id, body) {
  const post = await postOrThrow(db, id);
  const emoji = body.emoji ?? null;
  if (emoji !== null && !REACTIONS.includes(emoji)) badRequest(`emoji must be one of ${REACTIONS.join(" ")}`);
  let changed = false;
  if (emoji === null) {
    await db.prepare(`DELETE FROM post_reactions WHERE post_id = ? AND who = ?`).bind(id, me).run();
  } else {
    const res = await db
      .prepare(
        `INSERT INTO post_reactions (post_id, who, emoji, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (post_id, who) DO UPDATE SET emoji = ?3, created_at = ?4 WHERE emoji != ?3`
      )
      .bind(id, me, emoji, Date.now())
      .run();
    changed = res.meta.changes > 0;
  }
  return {
    result: ok(await getState(db, me)),
    notify: changed ? { title: `${emoji} ${me} reacted`, body: `to ${whosePolaroid(post, me)}${post.note ? ` · “${clip(post.note, 60)}”` : ""}`, tag: `post-${id}`, url: `./#post-${id}` } : null,
  };
}

async function commentOnPost(db, me, id, body) {
  const post = await postOrThrow(db, id);
  const text = reqText(body, "text", MAX_COMMENT);
  await db
    .prepare(`INSERT INTO post_comments (post_id, by, text, created_at) VALUES (?, ?, ?, ?)`)
    .bind(id, me, text, Date.now())
    .run();
  return {
    result: ok(await getState(db, me)),
    notify: { title: `💬 ${me} on ${whosePolaroid(post, me)}`, body: `“${clip(text, 140)}”`, tag: `post-${id}`, url: `./#post-${id}` },
  };
}

// Your own comments; Muneeb can delete any.
async function deleteComment(db, me, postId, id) {
  const row = await db.prepare(`SELECT * FROM post_comments WHERE id = ? AND post_id = ?`).bind(id, postId).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  if (row.by !== me && me !== "Muneeb") throw new HttpError(403, { error: "not_yours" });
  await db.batch([
    toBin(db, me, "comment", id, { comment: row }),
    db.prepare(`DELETE FROM post_comments WHERE id = ?`).bind(id),
  ]);
  return ok(await getState(db, me));
}

function toPost(r) {
  return {
    id: r.id,
    by: r.by,
    createdAt: r.created_at,
    country: r.country,
    rating: r.rating,
    note: r.note,
    shopId: r.shop_id,
    flavour: r.flavour,
    paidQty: r.paid_qty ?? null,
    width: r.width,
    height: r.height,
  };
}

async function undo(db, me) {
  // Delete my most recent event, but only if it's still inside the undo window.
  const row = await db
    .prepare(
      `DELETE FROM events
       WHERE id = (SELECT id FROM events WHERE by = ?1 ORDER BY created_at DESC, id DESC LIMIT 1)
         AND created_at >= ?2
       RETURNING *`
    )
    .bind(me, Date.now() - UNDO_WINDOW_MS)
    .first();

  if (!row) throw new HttpError(409, { error: "too_late" });
  return ok(await getState(db, me), { event: toEvent(row) });
}

async function editEventNote(db, me, id, body) {
  if (!("note" in body)) badRequest("note is required (string or null)");
  const note = optText(body, "note", MAX_NOTE);

  const row = await db
    .prepare(`UPDATE events SET note = ? WHERE id = ? RETURNING *`)
    .bind(note, id)
    .first();

  if (!row) throw new HttpError(404, { error: "not_found" });
  return ok(await getState(db, me), { event: toEvent(row) });
}

async function createShop(db, me, body) {
  const name = reqText(body, "name", MAX_NAME);
  const lat = coord(body.lat, 90, "lat");
  const lng = coord(body.lng, 180, "lng");
  const area = optText(body, "area", MAX_NAME);
  const address = optText(body, "address", MAX_NOTE);
  const note = optText(body, "note", MAX_NOTE);

  const row = await db
    .prepare(
      `INSERT INTO shops (name, area, address, lat, lng, note, visited, is_next, added_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, ?)
       RETURNING *`
    )
    .bind(name, area, address, lat, lng, note, me, Date.now())
    .first();

  return ok(await getState(db, me), { shop: toShop(row) });
}

async function updateShop(db, me, id, body) {
  const current = await db.prepare(`SELECT * FROM shops WHERE id = ?`).bind(id).first();
  if (!current) throw new HttpError(404, { error: "not_found" });

  // Merge the provided fields over the current row, then write with one static UPDATE.
  const has = (key) => key in body;
  const fields = ["name", "area", "address", "note", "lat", "lng", "visited", "isNext"];
  if (!fields.some(has)) badRequest(`provide at least one of: ${fields.join(", ")}`);

  const next = { ...current };
  if (has("name")) next.name = reqText(body, "name", MAX_NAME);
  if (has("area")) next.area = optText(body, "area", MAX_NAME);
  if (has("address")) next.address = optText(body, "address", MAX_NOTE);
  if (has("note")) next.note = optText(body, "note", MAX_NOTE);
  if (has("lat")) next.lat = coord(body.lat, 90, "lat");
  if (has("lng")) next.lng = coord(body.lng, 180, "lng");
  if (has("visited")) next.visited = bool(body.visited, "visited");
  if (has("isNext")) next.is_next = bool(body.isNext, "isNext");

  const update = db
    .prepare(
      `UPDATE shops SET name = ?, area = ?, address = ?, note = ?, lat = ?, lng = ?,
                        visited = ?, is_next = ?
       WHERE id = ?`
    )
    .bind(next.name, next.area, next.address, next.note, next.lat, next.lng,
      next.visited, next.is_next, id);

  if (body.isNext === true) {
    // Only one "next spot" at a time: clear the others in the same transaction.
    await db.batch([
      db.prepare(`UPDATE shops SET is_next = 0 WHERE id != ?`).bind(id),
      update,
    ]);
  } else {
    await update.run();
  }

  const row = await db.prepare(`SELECT * FROM shops WHERE id = ?`).bind(id).first();
  return ok(await getState(db, me), { shop: toShop(row) });
}

async function deleteShop(db, me, id) {
  const [shop, linked] = await db.batch([
    db.prepare(`SELECT * FROM shops WHERE id = ?`).bind(id),
    db.prepare(`SELECT id FROM events WHERE shop_id = ?`).bind(id),
  ]);
  if (!shop.results.length) throw new HttpError(404, { error: "not_found" });
  // Bin it, detach paid events from the shop, then delete it (one transaction).
  await db.batch([
    toBin(db, me, "shop", id, { shop: shop.results[0], eventIds: linked.results.map((e) => e.id) }),
    db.prepare(`UPDATE events SET shop_id = NULL WHERE shop_id = ?`).bind(id),
    db.prepare(`DELETE FROM shops WHERE id = ?`).bind(id),
  ]);
  return ok(await getState(db, me));
}

// Muneeb pre-writes (or edits) the sealed note for a milestone.
async function writeLetter(db, me, at, body) {
  if (me !== "Muneeb") throw new HttpError(403, { error: "muneeb_only" });
  if (!("note" in body)) badRequest("note is required (string or null)");
  const note = optText(body, "note", MAX_LETTER);
  await db
    .prepare(
      `INSERT INTO milestones (at, note, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (at) DO UPDATE SET note = ?2, updated_at = ?3`
    )
    .bind(at, note, Date.now())
    .run();
  return ok(await getState(db, me));
}

// Fiza opens an unlocked envelope (first open wins; Muneeb peeking doesn't count).
async function openLetter(db, me, at, ctx, env) {
  if (me !== "Fiza") throw new HttpError(403, { error: "fiza_only" });
  const before = await db.prepare(`SELECT note, opened_at FROM milestones WHERE at = ?`).bind(at).first();
  const { owed } = await db
    .prepare(`SELECT COALESCE(SUM(qty), 0) AS owed FROM events WHERE type = 'owe'`)
    .first();
  if (at > owed) throw new HttpError(409, { error: "locked" });
  const now = Date.now();
  await db
    .prepare(
      `INSERT INTO milestones (at, opened_at, updated_at) VALUES (?1, ?2, ?2)
       ON CONFLICT (at) DO UPDATE SET opened_at = COALESCE(opened_at, ?2)`
    )
    .bind(at, now)
    .run();
  if (!before?.opened_at) {
    const firstLine = before?.note ? before.note.split("\n")[0] : null;
    ctx.waitUntil(notify(env, "Muneeb", {
      title: `✉️ Fiza opened your note at ${at}`,
      body: firstLine ? `“${clip(firstLine, 90)}”` : "No note in that one… she got the upgrade though",
      tag: `letter-${at}`,
    }));
  }
  return ok(await getState(db, me));
}

// Muneeb sets a new PIN for Fiza (who = "fiza") or for himself (who = "muneeb").
// The old one (secret or previous change) stops working right away.
async function setPin(db, env, me, who, body) {
  if (me !== "Muneeb") throw new HttpError(403, { error: "muneeb_only" });
  const pin = body.pin;
  if (typeof pin !== "string" || !/^\d{4}$/.test(pin)) badRequest("pin must be exactly 4 digits");
  const hashes = await currentPinHashes(db);
  const other = who === "fiza"
    ? await pinMatches(pin, hashes.pin_muneeb, env.PIN_MUNEEB)
    : await pinMatches(pin, hashes.pin_fiza, env.PIN_FIZA);
  if (other) badRequest(who === "fiza" ? "pin must be different from yours" : "pin must be different from hers");
  await db
    .prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO UPDATE SET value = ?2`)
    .bind(who === "fiza" ? "pin_fiza" : "pin_muneeb", await hashPin(pin))
    .run();
  return ok(await getState(db, me));
}

// Called once per login. Logs Fiza's visits: logins with her PIN, except from a
// browser Muneeb has marked as his (`mine`, a flag kept in his own browser).
async function recordOpen(db, me, request, body, ctx, env) {
  if (me !== "Fiza" || body.mine === true) return { body: { ok: true } };
  return { body: { ok: true, openId: await startOpen(db, request, ctx, env) } };
}

async function startOpen(db, request, ctx, env) {
  const now = Date.now();
  const [row] = await db.batch([
    db.prepare(`INSERT INTO opens (at, country, last_seen) VALUES (?1, ?2, ?1) RETURNING id`)
      .bind(now, request.cf?.country || null),
    db.prepare(`DELETE FROM opens WHERE at < ?`).bind(now - OPENS_KEEP_MS),
  ]);
  ctx.waitUntil(notifyVisit(db, env, now));
  return row.results[0].id;
}

// "Fiza walked in" for Muneeb — at most once per OPEN_NOTIFY_GAP_MS so a few
// reopens in a row don't flood his phone.
const VISIT_LINES = [
  ["👀 Fiza walked into the parlour", "Better behave 🍦"],
  ["🔔 Fiza is in the parlour", "Checking on your debt, probably"],
  ["👀 Fiza just opened the site", "Agent Aloo is watching too 🥔"],
  ["🍦 Fiza dropped by", "Quick, think of an excuse"],
];
async function notifyVisit(db, env, now) {
  const claimed = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('visit_notified_at', ?1)
       ON CONFLICT (key) DO UPDATE SET value = ?1 WHERE CAST(value AS INTEGER) < ?2
       RETURNING value`
    )
    .bind(String(now), now - OPEN_NOTIFY_GAP_MS)
    .first();
  if (!claimed) return;
  const [title, body] = VISIT_LINES[Math.floor(Math.random() * VISIT_LINES.length)];
  await notify(env, "Muneeb", { title, body, tag: "visit" });
}

// Check-in every ~20s while the page is on screen. After a gap longer than
// OPEN_GAP_MS (she left and came back) it starts a new visit instead.
async function pingOpen(db, me, request, id, ctx, env) {
  if (me !== "Fiza") return { body: { ok: true } };
  const now = Date.now();
  const res = await db
    .prepare(`UPDATE opens SET last_seen = ?1 WHERE id = ?2 AND last_seen >= ?3`)
    .bind(now, id, now - OPEN_GAP_MS)
    .run();
  if (res.meta.changes) return { body: { ok: true, openId: id } };
  return { body: { ok: true, openId: await startOpen(db, request, ctx, env) } };
}

// ---- Admin handlers (route() has already checked me === "Muneeb") ----

// Delete any ring or ice-cream entry, as long as eaten never ends up above owed.
async function adminDeleteEvent(db, me, id) {
  const row = await db.prepare(`SELECT * FROM events WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  if (row.by === "system") badRequest("edit The Archives instead of deleting it");
  const del = await db
    .prepare(
      `DELETE FROM events WHERE id = ?1
         AND (type = 'paid' OR (SELECT COALESCE(SUM(CASE type WHEN 'owe' THEN qty ELSE -qty END), 0) FROM events) >= qty)`
    )
    .bind(id)
    .run();
  if (!del.meta.changes) throw new HttpError(409, { error: "would_go_negative" });
  return ok(await getState(db, me), { event: toEvent(row) });
}

// ---- Bin: deleted polaroids, comments and shops wait here until Muneeb restores them ----

function toBin(db, me, kind, itemId, data) {
  return db
    .prepare(`INSERT INTO bin (kind, item_id, data, deleted_by, deleted_at) VALUES (?, ?, ?, ?, ?)`)
    .bind(kind, itemId, JSON.stringify(data), me, Date.now());
}

// Puts a snapshot row back exactly as it was (same id). The column names come from
// our own SELECT *, never from a request.
function insertRow(db, table, row) {
  const cols = Object.keys(row);
  return db
    .prepare(`INSERT INTO ${table} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`)
    .bind(...cols.map((c) => row[c]));
}

async function adminRestore(db, me, binId) {
  const item = await db.prepare(`SELECT * FROM bin WHERE id = ? AND restored_at IS NULL`).bind(binId).first();
  if (!item) throw new HttpError(404, { error: "not_found" });
  const d = JSON.parse(item.data);
  const steps = [];
  if (item.kind === "post") {
    const post = { ...d.post };
    if (d.paidEvent) {
      // Its pay-off comes back too, but never more than is still owed.
      const { pending } = await db
        .prepare(`SELECT COALESCE(SUM(CASE type WHEN 'owe' THEN qty ELSE -qty END), 0) AS pending FROM events`)
        .first();
      const qty = Math.min(d.paidEvent.qty, pending);
      if (qty > 0) steps.push(insertRow(db, "events", { ...d.paidEvent, qty }));
      else post.paid_event_id = null;
    }
    steps.push(insertRow(db, "posts", post));
    for (const r of d.reactions) steps.push(insertRow(db, "post_reactions", r));
    for (const c of d.comments) steps.push(insertRow(db, "post_comments", c));
  } else if (item.kind === "comment") {
    const post = await db.prepare(`SELECT id FROM posts WHERE id = ?`).bind(d.comment.post_id).first();
    if (!post) throw new HttpError(409, { error: "post_in_bin" });
    steps.push(insertRow(db, "post_comments", d.comment));
  } else {
    steps.push(insertRow(db, "shops", d.shop));
    for (const eventId of d.eventIds) {
      steps.push(db.prepare(`UPDATE events SET shop_id = ? WHERE id = ? AND shop_id IS NULL`).bind(d.shop.id, eventId));
    }
  }
  steps.push(db.prepare(`UPDATE bin SET restored_at = ? WHERE id = ?`).bind(Date.now(), binId));
  await db.batch(steps);
  return ok(await getState(db, me), { restored: `${item.kind} #${item.item_id}` });
}

// A binned polaroid's photo, so Muneeb can see what he's restoring.
async function adminBinPhoto(db, env, binId, size) {
  const item = await db.prepare(`SELECT item_id FROM bin WHERE id = ? AND kind = 'post'`).bind(binId).first();
  const obj = item && (await env.PHOTOS.get(photoKey(item.item_id, size)));
  if (!obj) throw new HttpError(404, { error: "not_found" });
  return new Response(obj.body, {
    headers: { "Content-Type": obj.httpMetadata?.contentType || "image/jpeg", "Cache-Control": "private, no-store" },
  });
}

function toBinItem(r) {
  const d = JSON.parse(r.data);
  const item = { id: r.id, kind: r.kind, itemId: r.item_id, deletedBy: r.deleted_by, deletedAt: r.deleted_at };
  if (r.kind === "post") {
    return { ...item, by: d.post.by, createdAt: d.post.created_at, note: d.post.note, flavour: d.post.flavour,
      comments: d.comments.length, paidQty: d.paidEvent?.qty ?? null };
  }
  if (r.kind === "comment") {
    return { ...item, by: d.comment.by, createdAt: d.comment.created_at, text: d.comment.text, postId: d.comment.post_id };
  }
  return { ...item, name: d.shop.name, createdAt: d.shop.created_at };
}

// Set the starting count (The Archives), never below what's already been eaten.
async function adminSetArchives(db, me, body) {
  const qty = body.qty;
  if (!Number.isInteger(qty) || qty < 0 || qty > 999) badRequest("qty must be an integer from 0 to 999");
  const upd = await db
    .prepare(
      `UPDATE events SET qty = ?1
       WHERE id = (SELECT id FROM events WHERE by = 'system' AND type = 'owe' ORDER BY id LIMIT 1)
         AND (SELECT COALESCE(SUM(CASE type WHEN 'owe' THEN qty ELSE -qty END), 0) FROM events) - qty + ?1 >= 0`
    )
    .bind(qty)
    .run();
  if (!upd.meta.changes) throw new HttpError(409, { error: "would_go_negative" });
  return ok(await getState(db, me));
}

async function adminUnfreeze(db, me) {
  await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES ('cooldown_reset_at', ?1)
       ON CONFLICT (key) DO UPDATE SET value = ?1`
    )
    .bind(String(Date.now()))
    .run();
  return ok(await getState(db, me));
}

// Mark an envelope unopened so it pops up for Fiza again.
async function adminReseal(db, me, at) {
  await db.prepare(`UPDATE milestones SET opened_at = NULL WHERE at = ?`).bind(at).run();
  return ok(await getState(db, me));
}

function milestone(raw) {
  const at = Number(raw);
  if (at < MILESTONE_FIRST || at > MILESTONE_LAST || at % MILESTONE_STEP) {
    throw new HttpError(404, { error: "not_found" });
  }
  return at;
}

// ---------------------------------------------------------------------------
// 🎮 Scoop Stack: rounds, streaks, and a monthly race (loser owes the winner 2)

const GAME_FIRST_RACE = "2026-11"; // October 2026 is a practice month
const GAME_STAKE = 2;
const GAME_MAX_SCORE = 999;
const GAME_MIN_MS_PER_SCOOP = 250; // each drop takes ~350 ms in the game, so faster is fake
// "X is playing" at most this often: Muneeb hears about Fiza every 5 min, Fiza about him every 10.
const GAME_PLAY_NOTIFY_GAP_MS = { Fiza: 5 * 60 * 1000, Muneeb: 10 * 60 * 1000 };
const PLAYERS = ["Fiza", "Muneeb"];
const DAY_MS = 24 * 60 * 60 * 1000;
const MONTH_NAMES = ["January", "February", "March", "April", "May", "June", "July",
  "August", "September", "October", "November", "December"];

// Karachi is UTC+5 all year (no DST), so shifting by 5 h and reading the UTC fields
// gives Karachi dates.
const pk = (ms) => new Date(ms + 5 * 60 * 60 * 1000);
const pkDay = (ms) => pk(ms).toISOString().slice(0, 10);
const pkMonth = (ms) => pk(ms).toISOString().slice(0, 7);
const monthName = (m) => MONTH_NAMES[Number(m.slice(5, 7)) - 1];
const nextMonth = (m) => {
  const [y, mo] = m.split("-").map(Number);
  return mo === 12 ? `${y + 1}-01` : `${y}-${String(mo + 1).padStart(2, "0")}`;
};
const otherOf = (me) => (me === "Muneeb" ? "Fiza" : "Muneeb");

const PLAY_LINES = ["Better guard your score 👀", "Practising for the race, probably", "Stacking scoops instead of sleeping 🌙"];

async function gameStart(db, env, me, ctx) {
  const now = Date.now();
  const claimed = await db
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?1, ?2)
       ON CONFLICT (key) DO UPDATE SET value = ?2 WHERE CAST(value AS INTEGER) < ?3
       RETURNING value`
    )
    .bind(`game_play_notified_${me.toLowerCase()}`, String(now), now - GAME_PLAY_NOTIFY_GAP_MS[me])
    .first();
  if (!claimed) return { body: { ok: true } };
  let body = PLAY_LINES[Math.floor(Math.random() * PLAY_LINES.length)];
  if (me === "Fiza") {
    // Muneeb also gets how her day is going (rounds that ended at 0 aren't saved, so they don't count).
    const today = await db
      .prepare(`SELECT COUNT(*) AS n, MAX(score) AS best FROM game_scores WHERE who = 'Fiza' AND day = ?`)
      .bind(pkDay(now))
      .first();
    if (today.n) body = `${plural(today.n, "round")} today, best ${today.best} · ${body}`;
  }
  tell(ctx, env, me, { title: `🎮 ${me} is playing Scoop Stack`, body, tag: "game-play", url: "./#game" });
  return { body: { ok: true } };
}

// { score, ms }: one finished round. Notifies the other person only on the exciting
// ones: taking the all-time record off them, Fiza beating her own best (Muneeb
// always hears about that), or taking the month's lead.
async function gameScore(db, env, me, body, ctx) {
  const { score, ms } = body;
  if (!Number.isInteger(score) || score < 1 || score > GAME_MAX_SCORE) badRequest(`score must be 1-${GAME_MAX_SCORE}`);
  if (!Number.isInteger(ms) || ms < score * GAME_MIN_MS_PER_SCOOP) badRequest("that was suspiciously fast 🤨");
  const now = Date.now();
  const month = pkMonth(now);
  const other = otherOf(me);

  const [before] = await db.batch([
    db.prepare(
      `SELECT who, MAX(score) AS best, MAX(CASE WHEN month = ?1 THEN score END) AS month_best
       FROM game_scores GROUP BY who`
    ).bind(month),
    db.prepare(`INSERT INTO game_scores (who, score, day, month, created_at) VALUES (?, ?, ?, ?, ?)`)
      .bind(me, score, pkDay(now), month, now),
  ]);
  const prev = Object.fromEntries(before.results.map((r) => [r.who, r]));
  const myBest = prev[me]?.best ?? 0;
  const theirBest = prev[other]?.best ?? 0;
  const myMonth = prev[me]?.month_best ?? 0;
  const theirMonth = prev[other]?.month_best ?? 0;

  const racing = month >= GAME_FIRST_RACE;
  const result = {
    score,
    personalBest: score > myBest,
    record: score > Math.max(myBest, theirBest),
    tookRecord: theirBest > 0 && myBest <= theirBest && score > theirBest,
    tookLead: racing && myMonth <= theirMonth && score > theirMonth,
  };

  const mName = monthName(month);
  if (result.tookRecord) {
    tell(ctx, env, me, {
      title: `🏆 ${me} beat your all-time best`,
      body: `${plural(score, "scoop")} (yours: ${theirBest})${result.tookLead ? ` · and leads ${mName} 👑` : ""}`,
      tag: "game-record",
      url: "./#game",
    });
  } else if (me === "Fiza" && result.personalBest && myBest > 0) {
    tell(ctx, env, me, {
      title: "🎉 Fiza beat her own best",
      body: `${plural(score, "scoop")} (her old best: ${myBest}${theirBest ? ` · yours: ${theirBest}` : ""})${result.tookLead ? ` · and leads ${mName} 👑` : ""}`,
      tag: "game-record",
      url: "./#game",
    });
  } else if (result.tookLead) {
    tell(ctx, env, me, theirMonth
      ? { title: `👑 ${me} took the ${mName} lead`, body: `${plural(score, "scoop")} vs your ${theirMonth}. Your move 👀`, tag: "game-lead", url: "./#game" }
      : { title: `🏁 ${me} opened the ${mName} race`, body: `${plural(score, "scoop")}. Your move 👀`, tag: "game-lead", url: "./#game" });
  }
  return ok(await getState(db, me), { result });
}

// Either of you can mark a game debt as paid (Muneeb can undo it from admin).
async function gamePaid(db, env, me, month, ctx) {
  const row = await db
    .prepare(`UPDATE game_months SET paid_at = ?1 WHERE month = ?2 AND winner IS NOT NULL AND paid_at IS NULL RETURNING *`)
    .bind(Date.now(), month)
    .first();
  if (!row) throw new HttpError(409, { error: "nothing_owed" });
  const loser = otherOf(row.winner);
  tell(ctx, env, me, {
    title: `😋 ${monthName(month)} game debt paid`,
    body: me === loser ? `${me} says the ${plural(row.qty, "ice cream")} are paid` : `${me} marked it paid. All square 🤝`,
    tag: "game-paid",
    url: "./#game",
  });
  return ok(await getState(db, me));
}

async function adminDeleteScore(db, me, id) {
  const row = await db.prepare(`DELETE FROM game_scores WHERE id = ? RETURNING month`).bind(id).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  // A finished race is re-scored with what's left (no notifications this time).
  const settled = await db.prepare(`SELECT 1 FROM game_months WHERE month = ?`).bind(row.month).first();
  if (settled) await settleMonth(db, row.month, Date.now());
  return ok(await getState(db, me));
}

// Best score each that month decides it. Not playing at all counts as 0, so sitting
// a month out loses it; equal scores (or nobody playing) mean nobody owes.
async function settleMonth(db, month, now) {
  const { results } = await db
    .prepare(`SELECT who, MAX(score) AS best FROM game_scores WHERE month = ? GROUP BY who`)
    .bind(month)
    .all();
  const best = { Fiza: null, Muneeb: null };
  for (const r of results) best[r.who] = r.best;
  const f = best.Fiza ?? 0;
  const m = best.Muneeb ?? 0;
  const winner = f > m ? "Fiza" : m > f ? "Muneeb" : null;
  await db
    .prepare(
      `INSERT INTO game_months (month, fiza_best, muneeb_best, winner, qty, settled_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (month) DO UPDATE SET fiza_best = ?2, muneeb_best = ?3, winner = ?4, qty = ?5`
    )
    .bind(month, best.Fiza, best.Muneeb, winner, winner ? GAME_STAKE : 0, now)
    .run();
  return { month, best, winner };
}

async function gameCron(env, now) {
  const db = env.DB;
  const current = pkMonth(now);

  // Settle every finished race month that hasn't been settled yet (normally just last month).
  const last = await db.prepare(`SELECT MAX(month) AS m FROM game_months`).first();
  for (let month = last?.m ? nextMonth(last.m) : GAME_FIRST_RACE; month < current; month = nextMonth(month)) {
    const { best, winner } = await settleMonth(db, month, now);
    const name = monthName(month);
    if (!winner && best.Fiza === null) continue; // nobody played: nothing to say
    if (!winner) {
      const msg = { title: `🤝 The ${name} race was a tie`, body: `${best.Fiza} each. Nobody owes anything. Rematch in ${monthName(current)}!`, tag: "game-month", url: "./#game" };
      await Promise.all(PLAYERS.map((p) => notify(env, p, msg)));
      continue;
    }
    const loser = otherOf(winner);
    const score = (who) => (best[who] === null ? "didn't play 🙈" : best[who]);
    await Promise.all([
      notify(env, winner, { title: `🏆 You won the ${name} race!`, body: `${best[winner]} vs ${score(loser)}. ${loser} owes you ${plural(GAME_STAKE, "ice cream")} 🍦`, tag: "game-month", url: "./#game" }),
      notify(env, loser, { title: `🍦 ${name} goes to ${winner}`, body: `${best[winner]} vs your ${score(loser)}. You owe ${plural(GAME_STAKE, "ice cream")} 🙈`, tag: "game-month", url: "./#game" }),
    ]);
  }

  // Last day of a race month, after noon in Karachi: one reminder each.
  const isLastDay = pkMonth(now + DAY_MS) !== current;
  if (current >= GAME_FIRST_RACE && isLastDay && pk(now).getUTCHours() >= 12) {
    const claimed = await db
      .prepare(`INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT (key) DO NOTHING RETURNING value`)
      .bind(`game_lastday_${current}`, String(now))
      .first();
    if (claimed) {
      const { results } = await db
        .prepare(`SELECT who, MAX(score) AS best FROM game_scores WHERE month = ? GROUP BY who`)
        .bind(current)
        .all();
      const best = Object.fromEntries(results.map((r) => [r.who, r.best]));
      const msg = {
        title: `⏳ Last day of the ${monthName(current)} race!`,
        body: `Fiza ${best.Fiza ?? 0} · Muneeb ${best.Muneeb ?? 0}. Loser owes ${plural(GAME_STAKE, "ice cream")} 🍦`,
        tag: "game-lastday",
        url: "./#game",
      };
      await Promise.all(PLAYERS.map((p) => notify(env, p, msg)));
    }
  }
}

// Current streak (days in a row up to today, or up to yesterday if not played yet
// today) and the longest ever, from a player's distinct Karachi play days.
function streaks(days, today) {
  const toMs = (d) => Date.parse(d + "T00:00:00Z");
  const sorted = [...days].sort();
  let best = 0;
  let run = 0;
  for (let i = 0; i < sorted.length; i++) {
    run = i && toMs(sorted[i]) - toMs(sorted[i - 1]) === DAY_MS ? run + 1 : 1;
    best = Math.max(best, run);
  }
  const lastDay = sorted[sorted.length - 1];
  const gap = lastDay ? (toMs(today) - toMs(lastDay)) / DAY_MS : Infinity;
  return { current: gap <= 1 ? run : 0, best, playedToday: gap === 0 };
}

function gameState(now, me, totals, days, months, rounds) {
  const today = pkDay(now);
  const month = pkMonth(now);
  const d = pk(now);
  const daysInMonth = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  const players = {};
  for (const p of PLAYERS) {
    const t = totals.find((r) => r.who === p) || {};
    const s = streaks(days.filter((r) => r.who === p).map((r) => r.day), today);
    players[p] = { best: t.best ?? null, monthBest: t.month_best ?? null, rounds: t.rounds ?? 0, streak: s.current, bestStreak: s.best, playedToday: s.playedToday };
  }
  return {
    month,
    firstRace: GAME_FIRST_RACE,
    stake: GAME_STAKE,
    daysLeft: daysInMonth - d.getUTCDate() + 1, // including today
    players,
    months: months.map((r) => ({
      month: r.month,
      best: { Fiza: r.fiza_best, Muneeb: r.muneeb_best },
      winner: r.winner,
      qty: r.qty,
      paidAt: r.paid_at,
    })),
    ...(me === "Muneeb" ? { rounds: rounds.map((r) => ({ id: r.id, who: r.who, score: r.score, createdAt: r.created_at })) } : {}),
  };
}

// ---------------------------------------------------------------------------
// Activity log: every change either of them makes, kept in D1 and never shown on
// the site (read it with `npm run logs`). Reads and the "still here" pings are left out.

const LOG_SKIP = [/^\/hello\/\d+$/];
const LOG_NO_BODY = [/^\/pin\//, /^\/push\//]; // never store a PIN or a push key
const LOG_MAX_DETAIL = 2000;
const LOG_ACTIONS = [
  ["POST", /^\/owe$/, () => "rang the bell (+2)"],
  ["POST", /^\/paid$/, (m, res) => `ate ${plural(res?.event?.qty ?? 0, "ice cream")}`],
  ["POST", /^\/undo$/, (m, res) => `undid ${res?.event ? `${res.event.type} #${res.event.id}` : "their last event"}`],
  ["PATCH", /^\/events\/(\d+)$/, (m) => `edited the note on event #${m[1]}`],
  ["POST", /^\/shops$/, (m, res) => `added shop #${res?.shop?.id ?? "?"}`],
  ["PATCH", /^\/shops\/(\d+)$/, (m) => `edited shop #${m[1]}`],
  ["DELETE", /^\/shops\/(\d+)$/, (m) => `deleted shop #${m[1]} (moved to bin)`],
  ["POST", /^\/posts$/, (m, res) => `uploaded polaroid #${res?.post?.id ?? "?"}`],
  ["DELETE", /^\/posts\/(\d+)$/, (m) => `deleted polaroid #${m[1]} (moved to bin)`],
  ["PUT", /^\/posts\/(\d+)\/reaction$/, (m) => `reacted to polaroid #${m[1]}`],
  ["POST", /^\/posts\/(\d+)\/comments$/, (m) => `commented on polaroid #${m[1]}`],
  ["DELETE", /^\/posts\/(\d+)\/comments\/(\d+)$/, (m) => `deleted comment #${m[2]} on polaroid #${m[1]} (moved to bin)`],
  ["PATCH", /^\/milestones\/(\d+)$/, (m) => `wrote the envelope for ${m[1]}`],
  ["POST", /^\/milestones\/(\d+)\/open$/, (m) => `opened the envelope for ${m[1]}`],
  ["POST", /^\/pin\/(\w+)$/, (m) => `changed the ${m[1]} PIN`],
  ["POST", /^\/hello$/, () => "opened the site"],
  ["POST", /^\/spin$/, () => "spun the wheel"],
  ["POST", /^\/game\/start$/, () => "started a Scoop Stack round"],
  ["POST", /^\/game\/score$/, () => "finished a Scoop Stack round"],
  ["POST", /^\/game\/months\/([\d-]+)\/paid$/, (m) => `marked the ${m[1]} race paid`],
  ["POST", /^\/push\/subscribe$/, () => "turned on notifications"],
  ["POST", /^\/push\/unsubscribe$/, () => "turned off notifications"],
  ["DELETE", /^\/admin\/events\/(\d+)$/, (m) => `admin: deleted event #${m[1]}`],
  ["PATCH", /^\/admin\/archives$/, () => "admin: changed The Archives"],
  ["POST", /^\/admin\/unfreeze$/, () => "admin: unfroze the bell"],
  ["DELETE", /^\/admin\/opens\/(\d+)$/, (m) => `admin: removed open #${m[1]} ("that was me")`],
  ["POST", /^\/admin\/milestones\/(\d+)\/reseal$/, (m) => `admin: re-sealed the envelope for ${m[1]}`],
  ["DELETE", /^\/admin\/game\/scores\/(\d+)$/, (m) => `admin: deleted Scoop Stack round #${m[1]}`],
  ["POST", /^\/admin\/game\/months\/([\d-]+)\/unpaid$/, (m) => `admin: marked the ${m[1]} race unpaid`],
  ["POST", /^\/admin\/bin\/(\d+)\/restore$/, (m, res) => `admin: restored ${res?.restored ?? `bin item #${m[1]}`} from the bin`],
];

// Taken before the request is handled. Only small JSON bodies are copied: teeing a
// multipart photo upload would hold the whole photo in memory twice.
function logEntry(request) {
  const url = new URL(request.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const method = request.method;
  const log = method !== "GET" && !LOG_SKIP.some((re) => re.test(path));
  const isJson = (request.headers.get("Content-Type") || "").includes("json");
  const body = log && isJson && !LOG_NO_BODY.some((re) => re.test(path))
    ? request.clone().text().catch(() => null)
    : null;
  return {
    log, method, path, body,
    country: request.cf?.country || null,
    ip: request.headers.get("CF-Connecting-IP") || "local",
  };
}

async function writeLog(db, entry, who, status, res, action) {
  try {
    const sent = entry.body ? await entry.body : null;
    let label = action;
    for (const [method, re, fn] of LOG_ACTIONS) {
      const m = !label && method === entry.method && entry.path.match(re);
      if (m) label = fn(m, res);
    }
    label ??= `${entry.method} ${entry.path}`;
    if (status >= 400 && !action) label = `FAILED ${status}: ${label}`;
    const { state, ...back } = res || {}; // the full state is too big and says nothing new
    const detail = JSON.stringify({
      ...(sent ? { sent: safeParse(sent) } : {}),
      ...(Object.keys(back).length ? { back } : {}),
    });
    await db
      .prepare(`INSERT INTO activity_log (at, who, action, method, path, status, detail, country, ip)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(Date.now(), who, label, entry.method, entry.path, status,
        detail === "{}" ? null : clip(detail, LOG_MAX_DETAIL), entry.country, entry.ip)
      .run();
  } catch (err) {
    console.error("activity log failed", err); // never let logging break the request
  }
}

function safeParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------
// State

async function getState(db, me) {
  const month = pkMonth(Date.now());
  const [events, shops, letters, reset, opens, posts, reactions, comments,
    gameTotals, gameDays, gameMonths, gameRounds, bin] = await db.batch([
    db.prepare(`SELECT * FROM events ORDER BY created_at DESC, id DESC`),
    db.prepare(`SELECT * FROM shops ORDER BY created_at ASC, id ASC`),
    db.prepare(`SELECT * FROM milestones ORDER BY at ASC`),
    db.prepare(`SELECT ${COOLDOWN_RESET_SQL} AS t`),
    // Fiza's open times for the admin page (Muneeb only, last 30 days).
    db.prepare(`SELECT id, at, country, last_seen AS lastSeen FROM opens WHERE ?1 = 'Muneeb' AND at > ?2 ORDER BY at DESC`)
      .bind(me, Date.now() - 30 * 24 * 60 * 60 * 1000),
    db.prepare(
      `SELECT p.*, e.qty AS paid_qty FROM posts p LEFT JOIN events e ON e.id = p.paid_event_id
       ORDER BY p.created_at DESC, p.id DESC`
    ),
    db.prepare(`SELECT post_id, who, emoji FROM post_reactions ORDER BY created_at`),
    db.prepare(`SELECT id, post_id, by, text, created_at FROM post_comments ORDER BY created_at, id`),
    db.prepare(
      `SELECT who, MAX(score) AS best, MAX(CASE WHEN month = ?1 THEN score END) AS month_best, COUNT(*) AS rounds
       FROM game_scores GROUP BY who`
    ).bind(month),
    db.prepare(`SELECT DISTINCT who, day FROM game_scores`),
    db.prepare(`SELECT * FROM game_months ORDER BY month DESC`),
    // Recent rounds for the admin page (Muneeb only).
    db.prepare(`SELECT id, who, score, created_at FROM game_scores WHERE ?1 = 'Muneeb' ORDER BY created_at DESC, id DESC LIMIT 40`)
      .bind(me),
    // The bin, for the admin page (Muneeb only).
    db.prepare(`SELECT * FROM bin WHERE ?1 = 'Muneeb' AND restored_at IS NULL ORDER BY deleted_at DESC, id DESC LIMIT 50`)
      .bind(me),
  ]);
  const cooldownResetAt = reset.results[0]?.t ?? 0;

  const now = Date.now();
  let owed = 0;
  let eaten = 0;
  let lastOwe = null;
  for (const e of events.results) {
    if (e.type === "owe") {
      owed += e.qty;
      if (lastOwe === null || e.created_at > lastOwe) lastOwe = e.created_at;
    } else {
      eaten += e.qty;
    }
  }
  const until = lastOwe === null || lastOwe <= cooldownResetAt ? null : lastOwe + COOLDOWN_MS;

  return {
    me,
    serverNow: now,
    totals: { owed, eaten, pending: owed - eaten },
    cooldownUntil: until !== null && until > now ? until : null,
    events: events.results.map(toEvent),
    shops: shops.results.map(toShop),
    // Fiza only sees letters she has unlocked; Muneeb sees everything he wrote.
    milestones: letters.results
      .filter((r) => me === "Muneeb" || r.at <= owed)
      .map((r) => ({ at: r.at, note: r.note, openedAt: r.opened_at })),
    posts: posts.results.map((r) => ({
      ...toPost(r),
      reactions: reactions.results.filter((x) => x.post_id === r.id).map((x) => ({ who: x.who, emoji: x.emoji })),
      comments: comments.results
        .filter((c) => c.post_id === r.id)
        .map((c) => ({ id: c.id, by: c.by, text: c.text, createdAt: c.created_at })),
    })),
    game: gameState(now, me, gameTotals.results, gameDays.results, gameMonths.results, gameRounds.results),
    ...(me === "Muneeb" ? { opens: opens.results, bin: bin.results.map(toBinItem) } : {}),
  };
}

function toEvent(r) {
  return {
    id: r.id,
    type: r.type,
    qty: r.qty,
    by: r.by,
    note: r.note,
    flavour: r.flavour,
    shopId: r.shop_id,
    createdAt: r.created_at,
  };
}

function toShop(r) {
  return {
    id: r.id,
    name: r.name,
    area: r.area,
    address: r.address,
    lat: r.lat,
    lng: r.lng,
    note: r.note,
    visited: !!r.visited,
    isNext: !!r.is_next,
    addedBy: r.added_by,
    createdAt: r.created_at,
  };
}

// ---------------------------------------------------------------------------
// Auth + CORS

// pinHashes: { pin_fiza?, pin_muneeb? } from settings. A PIN changed on the site is
// stored there as a hash and replaces the PIN_FIZA / PIN_MUNEEB secret.
async function whoIs(pin, env, pinHashes) {
  if (!pin) return null;
  // Check both PINs every time (no early exit) so timing doesn't hint at which matched.
  const isMuneeb = await pinMatches(pin, pinHashes.pin_muneeb, env.PIN_MUNEEB);
  const isFiza = await pinMatches(pin, pinHashes.pin_fiza, env.PIN_FIZA);
  if (isMuneeb) return "Muneeb";
  if (isFiza) return "Fiza";
  return null;
}

async function pinMatches(pin, hash, secret) {
  return hash ? safeEqual(await hashPin(pin), hash) : safeEqual(pin, secret);
}

async function currentPinHashes(db) {
  const rows = await db.prepare(`SELECT key, value FROM settings WHERE key IN ('pin_fiza', 'pin_muneeb')`).all();
  return Object.fromEntries(rows.results.map((r) => [r.key, r.value]));
}

async function hashPin(pin) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("icecream-pin:" + pin));
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lockedOut(until, now, cors) {
  return json({ error: "locked", retryAfter: Math.ceil((until - now) / 1000), lockedUntil: until }, 429, cors);
}

// Constant-ish time string comparison (always walks the longer string).
function safeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || b.length === 0) return false;
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) {
    diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  }
  return diff === 0;
}

function corsHeaders(request, env) {
  const headers = {
    "Access-Control-Allow-Methods": "GET, POST, PUT, PATCH, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "X-Pin, Content-Type",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
  const origin = request.headers.get("Origin");
  if (origin) {
    const allowed = String(env.ALLOWED_ORIGINS ?? "")
      .split(",")
      .map((s) => s.trim().replace(/\/+$/, ""))
      .filter(Boolean);
    if (allowed.includes("*") || allowed.includes(origin)) {
      headers["Access-Control-Allow-Origin"] = origin;
    }
  }
  return headers;
}

// ---------------------------------------------------------------------------
// Request/response helpers + validation

class HttpError extends Error {
  constructor(status, body) {
    super(body.error);
    this.status = status;
    this.body = body;
  }
}

function badRequest(message) {
  throw new HttpError(400, { error: "bad_request", message });
}

function ok(state, extra = {}) {
  return { body: { state, ...extra } };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      ...cors,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

// Parse a JSON object body; an empty body counts as {}.
async function readBody(request) {
  const text = await request.text();
  if (!text.trim()) return {};
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    badRequest("body must be valid JSON");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    badRequest("body must be a JSON object");
  }
  return body;
}

// Trim and cap to `max` characters (counting emoji as one character).
function clip(s, max) {
  const chars = Array.from(s.trim());
  return chars.length > max ? chars.slice(0, max).join("").trim() : chars.join("");
}

// Optional string field: missing/null/blank → null.
function optText(body, key, max) {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") badRequest(`${key} must be a string`);
  return clip(v, max) || null;
}

// Required non-blank string field.
function reqText(body, key, max) {
  const v = optText(body, key, max);
  if (v === null) badRequest(`${key} is required`);
  return v;
}

function optInt(body, key) {
  const v = body[key];
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 1) badRequest(`${key} must be a positive integer`);
  return v;
}

function coord(v, limit, key) {
  if (typeof v !== "number" || !Number.isFinite(v) || Math.abs(v) > limit) {
    badRequest(`${key} must be a number between -${limit} and ${limit}`);
  }
  return v;
}

function bool(v, key) {
  if (typeof v !== "boolean") badRequest(`${key} must be a boolean`);
  return v ? 1 : 0;
}
