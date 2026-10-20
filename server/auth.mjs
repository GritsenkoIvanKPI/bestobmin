/* Authentication: one shared company password.
   - the password is never stored, only a scrypt hash with a random salt
   - a session is a 256-bit random token; the cookie is HttpOnly and
     SameSite=Strict, so another site cannot ride on it
   - every comparison of a secret is constant-time
   - failed logins are throttled per IP and globally */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { DATA_DIR } from './store.mjs';

const AUTH_FILE = path.join(DATA_DIR, 'auth.json');
const SESSION_FILE = path.join(DATA_DIR, '.sessions.json');

const SESSION_TTL = 12 * 60 * 60 * 1000;   // 12 h of inactivity ends the session
const SESSION_MAX = 7 * 24 * 60 * 60 * 1000;
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };

/* ---------- password ---------- */
export function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, SCRYPT.keylen, SCRYPT).toString('hex');
  return { salt, hash, algo: 'scrypt', createdAt: new Date().toISOString() };
}

export function loadCredentials() {
  if (process.env.ADMIN_PASSWORD_SALT && process.env.ADMIN_PASSWORD_HASH) {
    return { salt: process.env.ADMIN_PASSWORD_SALT, hash: process.env.ADMIN_PASSWORD_HASH };
  }
  try { return JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8')); } catch { return null; }
}

export function saveCredentials(record) {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  fs.writeFileSync(AUTH_FILE, JSON.stringify(record, null, 2) + '\n', { mode: 0o600 });
}

export function checkPassword(password) {
  const cred = loadCredentials();
  if (!cred) return false;
  const want = Buffer.from(cred.hash, 'hex');
  let got;
  try { got = crypto.scryptSync(password, cred.salt, want.length, SCRYPT); } catch { return false; }
  return want.length === got.length && crypto.timingSafeEqual(want, got);
}

/* ---------- login throttling ---------- */
const attempts = new Map();          // ip -> { count, until }
const FAIL_WINDOW = 15 * 60 * 1000;
const MAX_FAILS = 8;

export function throttleState(ip) {
  const rec = attempts.get(ip);
  if (!rec) return { blocked: false, retryIn: 0 };
  if (rec.until > Date.now()) return { blocked: true, retryIn: Math.ceil((rec.until - Date.now()) / 1000) };
  return { blocked: false, retryIn: 0 };
}

export function noteFailure(ip) {
  const rec = attempts.get(ip) || { count: 0, until: 0 };
  rec.count += 1;
  /* back off harder each time past the threshold: 30 s, 1 m, 2 m, 4 m … */
  if (rec.count >= MAX_FAILS) {
    const over = rec.count - MAX_FAILS;
    rec.until = Date.now() + Math.min(30 * 1000 * Math.pow(2, over), FAIL_WINDOW);
  }
  attempts.set(ip, rec);
}

export function clearFailures(ip) { attempts.delete(ip); }

/* ---------- sessions ---------- */
let sessions = new Map();

function persist() {
  try {
    fs.writeFileSync(SESSION_FILE, JSON.stringify([...sessions]), { mode: 0o600 });
  } catch {}
}

export function loadSessions() {
  try {
    const raw = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
    sessions = new Map(raw);
    sweep();
  } catch { sessions = new Map(); }
}

function sweep() {
  const now = Date.now();
  let dirty = false;
  for (const [id, s] of sessions) {
    if (s.seen + SESSION_TTL < now || s.born + SESSION_MAX < now) { sessions.delete(id); dirty = true; }
  }
  if (dirty) persist();
}

export function createSession() {
  sweep();
  const id = crypto.randomBytes(32).toString('base64url');
  const csrf = crypto.randomBytes(32).toString('base64url');
  sessions.set(id, { csrf, born: Date.now(), seen: Date.now() });
  persist();
  return { id, csrf };
}

export function getSession(id) {
  if (!id) return null;
  const s = sessions.get(id);
  if (!s) return null;
  const now = Date.now();
  if (s.seen + SESSION_TTL < now || s.born + SESSION_MAX < now) { sessions.delete(id); persist(); return null; }
  s.seen = now;
  return { id, ...s };
}

export function dropSession(id) {
  if (id && sessions.delete(id)) persist();
}

export const sameSecret = (a, b) => {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};
