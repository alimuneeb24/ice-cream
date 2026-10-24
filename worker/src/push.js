// Web Push for the ice cream tracker: subscription routes + sending, WebCrypto only.
//
// RFC 8030 (Web Push), RFC 8291 (payload encryption, aes128gcm / RFC 8188) and
// RFC 8292 (VAPID). Works with Apple (web.push.apple.com), FCM and Mozilla.
//
// Env (.dev.vars locally, `wrangler secret put` in production):
//   VAPID_PUBLIC_KEY   base64url uncompressed P-256 point (65 bytes, starts 0x04):
//                      the browser's applicationServerKey.
//   VAPID_PRIVATE_KEY  base64url raw private scalar `d` (32 bytes), the same
//                      format `web-push generate-vapid-keys` prints.
//   VAPID_SUBJECT      contact for push services, e.g. "mailto:someone@example.com".

const TTL_SECONDS = 86400; // push service keeps an undelivered message for a day
const JWT_LIFETIME_S = 12 * 60 * 60; // RFC 8292 allows up to 24h; stay well under
const RECORD_SIZE = 4096;
const MAX_PAYLOAD = 3993; // 4096-byte body limit - 86-byte header - 1 delimiter - 16 tag
const MAX_ENDPOINT = 2048;
const MAX_TEXT = 500;

const enc = new TextEncoder();

// ---------------------------------------------------------------------------
// Routes

// Returns a handler result ({ body } / { status, body }), or null if `path`
// isn't a push route. `me` is the already-authenticated "Muneeb" or "Fiza".
export async function handlePush(request, env, me, path, method) {
  if (method === "GET" && path === "/push/key") {
    if (!env.VAPID_PUBLIC_KEY) return fail(503, "push_not_configured");
    return { body: { publicKey: env.VAPID_PUBLIC_KEY } };
  }

  if (method === "POST" && path === "/push/subscribe") {
    const [body, bad] = await readJson(request);
    if (bad) return bad;
    // Body is PushSubscription.toJSON(): { endpoint, expirationTime, keys: { p256dh, auth } }
    const endpoint = body.endpoint;
    const p256dh = body.keys?.p256dh;
    const auth = body.keys?.auth;
    if (!validEndpoint(endpoint)) return badRequest("endpoint must be an https URL");
    if (byteLength(p256dh) !== 65) return badRequest("keys.p256dh must be a base64url P-256 public key");
    if (byteLength(auth) !== 16) return badRequest("keys.auth must be a base64url 16-byte secret");

    // One row per browser; re-subscribing (or logging in as the other person on
    // the same device) just moves the row over.
    await env.DB
      .prepare(
        `INSERT INTO push_subs (who, endpoint, p256dh, auth, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (endpoint) DO UPDATE SET who = ?1, p256dh = ?3, auth = ?4`
      )
      .bind(me, endpoint, p256dh, auth, Date.now())
      .run();
    return { body: { ok: true } };
  }

  if (method === "POST" && path === "/push/unsubscribe") {
    const [body, bad] = await readJson(request);
    if (bad) return bad;
    if (typeof body.endpoint !== "string" || !body.endpoint) return badRequest("endpoint is required");
    await env.DB.prepare(`DELETE FROM push_subs WHERE endpoint = ?`).bind(body.endpoint).run();
    return { body: { ok: true } };
  }

  return null;
}

// ---------------------------------------------------------------------------
// Sending

// Sends { title, body, tag, url } to every device `to` ("Muneeb" or "Fiza") has
// subscribed. Never throws (errors are logged), so it's safe in ctx.waitUntil().
// Resolves to { sent, removed, failed } counts.
export async function notify(env, to, { title, body, tag, url } = {}) {
  const counts = { sent: 0, removed: 0, failed: 0 };
  try {
    if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) {
      console.warn("push: VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY / VAPID_SUBJECT not set; not sending");
      return counts;
    }
    const { results } = await env.DB
      .prepare(`SELECT id, endpoint, p256dh, auth FROM push_subs WHERE who = ?`)
      .bind(to)
      .all();
    if (!results.length) return counts;

    const payload = enc.encode(JSON.stringify({
      title: clip(title),
      body: clip(body),
      tag: clip(tag),
      url: clip(url),
    }));
    if (payload.length > MAX_PAYLOAD) {
      console.error(`push: payload too large (${payload.length} bytes)`);
      counts.failed = results.length;
      return counts;
    }

    const signingKey = await importVapidKey(env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
    const jwts = new Map(); // one JWT per push service origin
    const outcomes = await Promise.all(results.map(async (sub) => {
      try {
        const aud = new URL(sub.endpoint).origin;
        if (!jwts.has(aud)) jwts.set(aud, vapidJwt(signingKey, aud, env.VAPID_SUBJECT));
        return await sendOne(env, sub, payload, await jwts.get(aud));
      } catch (err) {
        console.error(`push: sending to subscription ${sub.id} failed:`, err);
        return "failed";
      }
    }));
    for (const o of outcomes) counts[o]++;
  } catch (err) {
    console.error("push: notify failed:", err);
  }
  return counts;
}

async function sendOne(env, sub, payload, jwt) {
  const res = await fetch(sub.endpoint, {
    method: "POST",
    headers: {
      TTL: String(TTL_SECONDS),
      Urgency: "high",
      "Content-Type": "application/octet-stream",
      "Content-Encoding": "aes128gcm",
      Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC_KEY}`,
    },
    body: await encryptPayload(payload, sub.p256dh, sub.auth),
  });

  if (res.status === 404 || res.status === 410) {
    // Expired or unsubscribed in the browser: forget it.
    await res.body?.cancel();
    await env.DB.prepare(`DELETE FROM push_subs WHERE id = ?`).bind(sub.id).run();
    return "removed";
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`push: ${res.status} from ${new URL(sub.endpoint).host} (sub ${sub.id}): ${text.slice(0, 300)}`);
    return "failed";
  }
  await res.body?.cancel();
  return "sent";
}

// ---------------------------------------------------------------------------
// RFC 8291: message encryption (single aes128gcm record)

// `payload` is a Uint8Array; `p256dh` / `auth` are the subscription's base64url keys.
// `opts.salt` / `opts.localKeys` exist only so tests can reproduce RFC 8291 Appendix A.
export async function encryptPayload(payload, p256dh, auth, opts = {}) {
  const uaPublic = b64urlDecode(p256dh);
  const authSecret = b64urlDecode(auth);
  const salt = opts.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const local = opts.localKeys ??
    (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]));
  const asPublic = new Uint8Array(await crypto.subtle.exportKey("raw", local.publicKey));

  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const ecdhSecret = new Uint8Array(
    await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, local.privateKey, 256)
  );

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0x00 || ua_public || as_public, 32)
  const ikm = await hkdf(authSecret, ecdhSecret, concat(enc.encode("WebPush: info\x00"), uaPublic, asPublic), 32);
  const cek = await hkdf(salt, ikm, enc.encode("Content-Encoding: aes128gcm\x00"), 16);
  const nonce = await hkdf(salt, ikm, enc.encode("Content-Encoding: nonce\x00"), 12);

  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const plaintext = concat(payload, Uint8Array.of(2)); // 0x02 = last record, no padding
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, plaintext));

  // Header: salt (16) || rs (uint32 BE) || idlen (1) || keyid (as_public, 65)
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, RECORD_SIZE);
  header[20] = asPublic.length;
  header.set(asPublic, 21);
  return concat(header, ciphertext);
}

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8);
  return new Uint8Array(bits);
}

// ---------------------------------------------------------------------------
// RFC 8292: VAPID JWT (ES256)

export async function importVapidKey(publicKey, privateKey) {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY must be a base64url uncompressed P-256 point");
  let d = b64urlDecode(privateKey);
  if (d.length > 32) throw new Error("VAPID_PRIVATE_KEY must be the base64url 32-byte private scalar");
  if (d.length < 32) d = concat(new Uint8Array(32 - d.length), d); // restore stripped leading zeros
  const jwk = {
    kty: "EC",
    crv: "P-256",
    x: b64urlEncode(pub.slice(1, 33)),
    y: b64urlEncode(pub.slice(33, 65)),
    d: b64urlEncode(d),
  };
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

// `aud` is the push service origin (e.g. "https://web.push.apple.com").
export async function vapidJwt(signingKey, aud, sub, now = Date.now()) {
  const header = b64urlEncode(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64urlEncode(enc.encode(JSON.stringify({
    aud,
    exp: Math.floor(now / 1000) + JWT_LIFETIME_S,
    sub,
  })));
  const unsigned = `${header}.${claims}`;
  // WebCrypto ECDSA signatures are already raw r||s (64 bytes), which is what JWS wants.
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, signingKey, enc.encode(unsigned));
  return `${unsigned}.${b64urlEncode(new Uint8Array(sig))}`;
}

// ---------------------------------------------------------------------------
// Helpers

function fail(status, error, message) {
  return { status, body: message ? { error, message } : { error } };
}

function badRequest(message) {
  return fail(400, "bad_request", message);
}

// Parse a JSON object body. Returns [body, null], or [null, <400 handler result>].
async function readJson(request) {
  let body;
  try {
    body = JSON.parse(await request.text());
  } catch {
    return [null, badRequest("body must be valid JSON")];
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return [null, badRequest("body must be a JSON object")];
  }
  return [body, null];
}

function validEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > MAX_ENDPOINT) return false;
  try {
    return new URL(endpoint).protocol === "https:";
  } catch {
    return false;
  }
}

// Decoded length of a base64url string, or -1 if it isn't one.
function byteLength(s) {
  if (typeof s !== "string" || !/^[A-Za-z0-9_-]+=*$/.test(s)) return -1;
  try {
    return b64urlDecode(s).length;
  } catch {
    return -1;
  }
}

function clip(v) {
  if (v === undefined || v === null) return undefined;
  const chars = Array.from(String(v));
  return chars.length > MAX_TEXT ? chars.slice(0, MAX_TEXT - 1).join("") + "…" : chars.join("");
}

function concat(...parts) {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}

function b64urlEncode(bytes) {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s) {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
