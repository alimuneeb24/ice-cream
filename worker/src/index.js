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
      if (!me) {
        if (!pin) return json({ error: "bad_pin" }, 401, cors);
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

      const result = await route(request, env, me, ctx);
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

  let m;
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
// counted toward the debt takes its pay-off with it.
async function deletePost(db, env, me, id) {
  const row = await db.prepare(`SELECT * FROM posts WHERE id = ?`).bind(id).first();
  if (!row) throw new HttpError(404, { error: "not_found" });
  if (row.by !== me && me !== "Muneeb") throw new HttpError(403, { error: "not_yours" });
  await env.PHOTOS.delete([photoKey(id, "full"), photoKey(id, "thumb")]);
  const steps = [db.prepare(`DELETE FROM posts WHERE id = ?`).bind(id)];
  if (row.paid_event_id) steps.push(db.prepare(`DELETE FROM events WHERE id = ?`).bind(row.paid_event_id));
  await db.batch(steps);
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
  // Detach paid events from the shop, then delete it (one transaction).
  const [, del] = await db.batch([
    db.prepare(`UPDATE events SET shop_id = NULL WHERE shop_id = ?`).bind(id),
    db.prepare(`DELETE FROM shops WHERE id = ?`).bind(id),
  ]);
  if (!del.meta.changes) throw new HttpError(404, { error: "not_found" });
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
// State

async function getState(db, me) {
  const [events, shops, letters, reset, opens, posts] = await db.batch([
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
    posts: posts.results.map(toPost),
    ...(me === "Muneeb" ? { opens: opens.results } : {}),
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
    "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
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
