/* Request guards.
   None of this stops a volumetric flood — that needs a CDN in front, and
   server/README.md says so. What it does stop is the cheap stuff a single
   machine can do: hammering the API, holding sockets open, and guessing
   the password from many addresses at once. */

import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './store.mjs';

/* ---------- token buckets ---------- */
const buckets = new Map();      // key -> { tokens, last }

/* A caller gets `burst` requests immediately and then `perMin` a minute.
   Returns null when allowed, or the seconds to wait. */
export function take(key, { perMin, burst }) {
  const now = Date.now();
  let b = buckets.get(key);
  if (!b) { b = { tokens: burst, last: now }; buckets.set(key, b); }
  b.tokens = Math.min(burst, b.tokens + ((now - b.last) / 60000) * perMin);
  b.last = now;
  if (b.tokens >= 1) { b.tokens -= 1; return null; }
  return Math.max(1, Math.ceil(((1 - b.tokens) / perMin) * 60));
}

/* Buckets are per IP, so a long-running server would otherwise grow one
   entry per address it has ever seen. */
const TTL = 30 * 60 * 1000;
setInterval(() => {
  const cutoff = Date.now() - TTL;
  for (const [k, b] of buckets) if (b.last < cutoff) buckets.delete(k);
}, 5 * 60 * 1000).unref();

export const LIMITS = {
  publicRates: { perMin: 240, burst: 120 },   // a page polls every 2 min
  api:         { perMin: 120, burst: 60 },
  login:       { perMin: 10,  burst: 8 },
  upload:      { perMin: 20,  burst: 10 },
  static:      { perMin: 600, burst: 300 },
};

/* ---------- password guessing from many addresses ---------- */
/* Per-IP backoff lives in auth.mjs. This is the other half: a botnet with
   a fresh address per try never trips that, but it does trip this. */
let globalFails = [];
const GLOBAL_WINDOW = 15 * 60 * 1000;
const GLOBAL_MAX = 40;

export function noteGlobalFailure() {
  const now = Date.now();
  globalFails = globalFails.filter(t => t > now - GLOBAL_WINDOW);
  globalFails.push(now);
}

export function loginsLocked() {
  const now = Date.now();
  globalFails = globalFails.filter(t => t > now - GLOBAL_WINDOW);
  return globalFails.length >= GLOBAL_MAX;
}

export function clearGlobalFailures() { globalFails = []; }

/* ---------- addresses that have signed in before ----------
   The lock above has a sharp edge: a botnet could hold it closed and keep
   the owner out, turning a guard into the outage it was meant to prevent.
   An address that has already signed in successfully skips the global
   lock (it still faces its own per-IP backoff). */
const KNOWN_FILE = path.join(DATA_DIR, '.known-ips.json');
const KNOWN_TTL = 60 * 24 * 60 * 60 * 1000;   // 60 days
let known = new Map();

try {
  known = new Map(JSON.parse(fs.readFileSync(KNOWN_FILE, 'utf8')));
} catch { known = new Map(); }

function saveKnown() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    fs.writeFileSync(KNOWN_FILE, JSON.stringify([...known]), { mode: 0o600 });
  } catch {}
}

export function rememberGoodIP(ip) {
  const now = Date.now();
  for (const [k, t] of known) if (t < now - KNOWN_TTL) known.delete(k);
  if (known.size > 200) known.delete(known.keys().next().value);
  known.set(ip, now);
  saveKnown();
}

export function isKnownIP(ip) {
  const t = known.get(ip);
  return !!t && t > Date.now() - KNOWN_TTL;
}

/* ---------- socket hardening ---------- */
export function hardenServer(server) {
  /* Slowloris: a client that opens a connection and dribbles the request
     out forever. These caps close it instead of holding a slot. */
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 60;
  server.maxConnections = 512;
  server.on('clientError', (err, socket) => {
    if (!socket.destroyed) socket.destroy();
  });
}
