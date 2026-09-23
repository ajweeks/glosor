import crypto from "node:crypto";

// ---------------------------------------------------------------------------
// Access control for hosting publicly. Everything is off unless configured, so local use needs no setup.
//
//   TURNSTILE_SITE_KEY, TURNSTILE_SECRET_KEY   Cloudflare Turnstile captcha, solved once per session
//   ACCESS_PASSWORD                            shared password, asked once per session
//   SESSION_SECRET                             signs session cookies; random per boot if unset, so a restart signs everyone out
//   SESSION_HOURS                              session lifetime (default 12)
//   RATE_LIMIT                                 Claude calls per session per rolling hour (default 60); needs a captcha or password
//   DAILY_BUDGET_USD                           cap on estimated Claude spend per UTC day, across everyone; unset = no cap
//   TRUST_PROXY=1                              read the client IP from the last X-Forwarded-For hop (behind nginx, Caddy, …)
//
// A captcha or password only proves a human started the session. The rate limit bounds one session,
// and the daily budget bounds everyone together: that's the number that protects the API bill.

const env = process.env;

export const CAPTCHA_SITE_KEY = env.TURNSTILE_SITE_KEY && env.TURNSTILE_SECRET_KEY ? env.TURNSTILE_SITE_KEY : null;
const PASSWORD = env.ACCESS_PASSWORD || null;
export const GATED = !!(CAPTCHA_SITE_KEY || PASSWORD);

const SECRET = env.SESSION_SECRET || crypto.randomBytes(32).toString("hex");
const SESSION_MS = (Number(env.SESSION_HOURS) || 12) * 3_600_000;
export const RATE_LIMIT = Number(env.RATE_LIMIT) || 60;
export const DAILY_BUDGET = Number(env.DAILY_BUDGET_USD) || null;

const COOKIE = "glosor_sid";
const HOUR = 3_600_000;

export function describe() {
  const parts = [];
  if (CAPTCHA_SITE_KEY) parts.push("turnstile");
  if (PASSWORD) parts.push("password");
  if (GATED) parts.push(`${RATE_LIMIT} calls/session/hour`);
  if (DAILY_BUDGET) parts.push(`$${DAILY_BUDGET}/day budget`);
  return parts.length ? parts.join(", ") : "open (no captcha, password or budget)";
}

// ---------------------------------------------------------------------------
// Sessions: a random id with an expiry, HMAC-signed into a cookie. Nothing is stored server-side
// except the rate-limit counters, so any number of sessions costs nothing until they make calls.

const sign = (data) => crypto.createHmac("sha256", SECRET).update(data).digest("base64url");

function safeEqual(a, b) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function readCookie(req, name) {
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

// The session token travels in the cookie and, for browsers that drop or withhold it (DuckDuckGo's
// mobile browser), in an Authorization header the page sets from the sign-in response.
function tokenOf(req) {
  const auth = String(req.headers.authorization ?? "");
  return auth.startsWith("Bearer ") ? auth.slice(7).trim() : readCookie(req, COOKIE) ?? "";
}

// The session id, or null when the token is missing, forged or expired.
export function sessionOf(req) {
  const [id, exp, sig] = tokenOf(req).split(".");
  if (!id || !exp || !sig || !safeEqual(sig, sign(`${id}.${exp}`))) return null;
  return Number(exp) > Date.now() ? id : null;
}

// Always Secure: browsers still accept it on http://localhost (Chrome, Firefox), and in production it
// can't leak over plain http even when a proxy rewrites Host or forgets X-Forwarded-Proto.
function newSession() {
  const id = crypto.randomBytes(16).toString("hex");
  const exp = Date.now() + SESSION_MS;
  const token = `${id}.${exp}.${sign(`${id}.${exp}`)}`;
  return { token, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_MS / 1000}` };
}

export function clientIp(req) {
  if (env.TRUST_PROXY === "1") {
    // The last hop is the one our own proxy appended; earlier ones are whatever the client claimed.
    const hops = String(req.headers["x-forwarded-for"] ?? "").split(",").map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops.at(-1);
  }
  return req.socket.remoteAddress ?? "";
}

// ---------------------------------------------------------------------------
// Signing in: a captcha token and/or the password, in exchange for a session cookie.

async function verifyCaptcha(token, ip) {
  if (typeof token !== "string" || !token || token.length > 2048) return false;
  const form = new URLSearchParams({ secret: env.TURNSTILE_SECRET_KEY, response: token });
  if (ip) form.set("remoteip", ip);
  const res = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
    method: "POST",
    body: form,
    signal: AbortSignal.timeout(10_000),
  });
  const out = await res.json().catch(() => ({}));
  if (!out.success) console.warn("turnstile rejected:", out["error-codes"]);
  return out.success === true;
}

// Hashing first makes the comparison constant-time regardless of length.
const digest = (s) => crypto.createHash("sha256").update(String(s ?? "")).digest();
const passwordOk = (given) => crypto.timingSafeEqual(digest(given), digest(PASSWORD));

// Failed sign-ins per IP. The captcha already costs something per attempt; this also covers
// password-only setups, where guesses would otherwise be free.
const MAX_FAILURES = 10;
const failures = new Map(); // ip → { count, until }

export async function signIn(req, body) {
  if (!GATED) return { status: 200, body: { ok: true } };
  const ip = clientIp(req);
  const f = failures.get(ip);
  if (f && f.until > Date.now() && f.count >= MAX_FAILURES) {
    return { status: 429, body: { error: "Too many attempts. Try again in 15 minutes." } };
  }
  const fail = (error) => {
    const prev = f && f.until > Date.now() ? f.count : 0;
    failures.set(ip, { count: prev + 1, until: Date.now() + 15 * 60_000 });
    return { status: 403, body: { error } };
  };

  if (CAPTCHA_SITE_KEY && !(await verifyCaptcha(body?.captcha, ip))) return fail("Captcha check failed. Please try again.");
  if (PASSWORD && !passwordOk(body?.password)) return fail("Wrong password.");
  failures.delete(ip);
  const { token, cookie } = newSession();
  return { status: 200, body: { ok: true, token }, cookie };
}

// ---------------------------------------------------------------------------
// Limits on Claude calls.

const calls = new Map(); // session id → timestamps of calls in the last hour

function takeCall(sid) {
  const now = Date.now();
  const recent = (calls.get(sid) ?? []).filter((t) => t > now - HOUR);
  if (recent.length >= RATE_LIMIT) return false;
  recent.push(now);
  calls.set(sid, recent);
  return true;
}

// Spend is tracked in memory, so a restart resets today's total. The check happens before a call and
// the charge after it, so calls already in flight can overshoot the cap by a few cents.
const utcDay = () => new Date().toISOString().slice(0, 10);
let budgetDay = utcDay();
let spent = 0;

function rollDay() {
  if (budgetDay !== utcDay()) {
    budgetDay = utcDay();
    spent = 0;
  }
}

export function charge(usd) {
  rollDay();
  spent += usd ?? 0;
}

// Gate for endpoints that call Claude (rateLimited) or just need a session. Returns an error to send, or null.
export function check(req, { rateLimited = false } = {}) {
  const sid = GATED ? sessionOf(req) : null;
  if (GATED && !sid) return { status: 401, body: { error: "Session expired. Verify again to continue.", auth: true } };
  if (!rateLimited) return null;
  rollDay();
  if (DAILY_BUDGET && spent >= DAILY_BUDGET) {
    return { status: 503, body: { error: "Today's grading budget is used up. It resets at midnight UTC." } };
  }
  if (sid && !takeCall(sid)) {
    return { status: 429, body: { error: `Rate limit reached (${RATE_LIMIT} per hour). Try again in a little while.` } };
  }
  return null;
}

// Forget idle rate-limit counters and expired lockouts.
setInterval(() => {
  const now = Date.now();
  for (const [sid, ts] of calls) if (!ts.some((t) => t > now - HOUR)) calls.delete(sid);
  for (const [ip, f] of failures) if (f.until < now) failures.delete(ip);
}, 10 * 60_000).unref();
