/* BEST — site + admin server.
   Plain Node, no dependencies, so it runs on any host that has Node 18+:
       node server/index.mjs
   Put it behind nginx/Caddy for TLS, or set TRUST_PROXY=1 when it sits
   behind a reverse proxy so client IPs are read from X-Forwarded-For. */
import http from 'http';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { execFile } from 'child_process';
import {
  ROOT, readJSON, writeJSON, listPosts, readPost, writePost, deletePost,
  validSlug, logChange, readAudit,
} from './store.mjs';
import {
  checkPassword, loadCredentials, loadSessions, createSession, getSession,
  dropSession, sameSecret, throttleState, noteFailure, clearFailures,
} from './auth.mjs';
import { take, LIMITS, hardenServer, noteGlobalFailure, loginsLocked, clearGlobalFailures, rememberGoodIP, isKnownIP } from './guard.mjs';
import { Invalid, validateRates, validateBranches, validateTexts, validatePost, sniffImage, safeImageName, rateMoves } from './validate.mjs';

const PORT = Number(process.env.PORT || 4199);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
const MAX_BODY = 256 * 1024;
const MAX_UPLOAD = 8 * 1024 * 1024;

loadSessions();

/* ============================================================
   helpers
   ============================================================ */
const clientIP = (req) => {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    if (typeof fwd === 'string' && fwd) return fwd.split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
};

const cookies = (req) => Object.fromEntries(
  (req.headers.cookie || '').split(';').map(c => {
    const i = c.indexOf('=');
    return i < 0 ? ['', ''] : [c.slice(0, i).trim(), decodeURIComponent(c.slice(i + 1).trim())];
  }).filter(([k]) => k)
);

function send(res, status, body, headers = {}) {
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body);
  res.writeHead(status, {
    'Content-Length': buf.length,
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(buf);
}

const json = (res, status, obj, headers = {}) =>
  send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(new Invalid('запит завеликий')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new Invalid('пошкоджений JSON')); }
    });
    req.on('error', reject);
  });
}

/* Uploads arrive as the raw file, so there is no multipart parser to get
   wrong — the browser sends the bytes and nothing else. */
function readRaw(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Invalid(`файл завеликий (максимум ${Math.round(limit / 1048576)} МБ)`)); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/* The admin page may only talk to its own origin and may not be framed. */
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data: blob:",   // blob: is how the picker previews a chosen file
  "connect-src 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
].join('; ');

const SECURITY_HEADERS = {
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=(), payment=()',
  ...(SECURE_COOKIES ? { 'Strict-Transport-Security': 'max-age=31536000; includeSubDomains' } : {}),
};

const setCookie = (name, value, maxAge) =>
  `${name}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (SECURE_COOKIES ? '; Secure' : '');

/* The rates endpoint is the one every visitor's page polls. Serving it
   from memory means a flood costs no disk reads, and an ETag means a
   repeat caller usually gets 304 with no body at all. */
let ratesCache = null;
function publicRates() {
  if (!ratesCache) {
    const rates = readJSON('rates');
    if (!rates) return null;
    const body = Buffer.from(JSON.stringify(rates));
    ratesCache = { body, etag: `W/"${crypto.createHash('sha1').update(body).digest('hex').slice(0, 16)}"` };
  }
  return ratesCache;
}
const dropRatesCache = () => { ratesCache = null; };

/* ============================================================
   rebuild — content changes need the static pages regenerated.
   Debounced so a burst of saves rebuilds once.
   ============================================================ */
let rebuildTimer = null;
let rebuilding = false;
function scheduleRebuild() {
  clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(runBuild, 400);
}
function runBuild() {
  if (rebuilding) { scheduleRebuild(); return; }
  rebuilding = true;
  execFile(process.execPath, [path.join(ROOT, 'assemble.mjs')], { cwd: ROOT, timeout: 60000 }, (err, _out, stderr) => {
    rebuilding = false;
    if (err) console.error('[build] failed:', stderr || err.message);
  });
}

/* ============================================================
   static files
   ============================================================ */
const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.mp4': 'video/mp4', '.webm': 'video/webm',
};

/* Resolve inside ROOT only: a request for /../../etc/passwd resolves out of
   the root and is refused before anything touches the filesystem. */
function resolveStatic(urlPath) {
  let rel;
  try { rel = decodeURIComponent(urlPath); } catch { return null; }
  if (rel.includes('\0')) return null;
  const full = path.resolve(ROOT, '.' + path.posix.normalize(rel));
  if (full !== ROOT && !full.startsWith(ROOT + path.sep)) return null;
  for (const candidate of path.extname(full)
      ? [full]
      : [path.join(full, 'index.html'), full + '.html', full]) {
    try { if (fs.statSync(candidate).isFile()) return candidate; } catch {}
  }
  return null;
}

/* Never serve the places where secrets and raw content live. */
const PRIVATE = ['data', 'server', 'content', 'parts', 'node_modules', '.git'];
const isPrivate = (urlPath) => {
  const first = urlPath.split('/').filter(Boolean)[0];
  return !!first && (PRIVATE.includes(first) || first.startsWith('.'));
};

function serveStatic(req, res, urlPath) {
  if (isPrivate(urlPath)) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  const file = resolveStatic(urlPath);
  if (!file) return send(res, 404, 'Not found', { 'Content-Type': 'text/plain; charset=utf-8' });
  const ext = path.extname(file).toLowerCase();
  const stat = fs.statSync(file);
  const etag = `W/"${stat.size.toString(16)}-${stat.mtimeMs.toString(16)}"`;
  if (req.headers['if-none-match'] === etag) return send(res, 304, '', { ETag: etag });
  const isAdmin = urlPath.startsWith('/admin');
  send(res, 200, fs.readFileSync(file), {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Cache-Control': ext === '.html' ? 'no-cache' : 'public, max-age=86400',
    ETag: etag,
    ...SECURITY_HEADERS,
    ...(isAdmin ? { 'Content-Security-Policy': ADMIN_CSP, 'Cache-Control': 'no-store' } : {}),
  });
}

/* ============================================================
   API
   ============================================================ */
const requireSession = (req) => getSession(cookies(req).sid, req.headers['user-agent']);

/* A valid session is not enough for a write: the request must also echo the
   session's CSRF token in a header, which only our own page can read. */
function requireWrite(req, session) {
  if (!session) return 'не авторизовано';
  if (!sameSecret(String(req.headers['x-csrf-token'] || ''), session.csrf)) return 'недійсний CSRF-токен';
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    let ok = false;
    try { ok = new URL(origin).host === host; } catch {}
    if (!ok) return 'чужий origin';
  }
  return null;
}

const tooFast = (res, wait) => json(res, 429, { error: `Забагато запитів. Спробуйте через ${wait} с` }, { 'Retry-After': String(wait) });

async function api(req, res, urlPath) {
  const method = req.method;
  const ip = clientIP(req);

  /* Buckets are sized so normal use never notices: a visitor's page asks
     for rates every two minutes, and a cashier saves a handful of times
     an hour. */
  const bucket = urlPath === '/api/public/rates' ? LIMITS.publicRates
    : urlPath === '/api/login' ? LIMITS.login
    : urlPath === '/api/admin/upload' ? LIMITS.upload
    : LIMITS.api;
  const wait = take(urlPath.split('/').slice(0, 3).join('/') + '|' + ip, bucket);
  if (wait) return tooFast(res, wait);

  /* ---------- public ---------- */
  /* HEAD as well as GET: uptime monitors ping with HEAD, and a 404 there
     would read as an outage. */
  if (urlPath === '/api/public/rates' && (method === 'GET' || method === 'HEAD')) {
    const hit = publicRates();
    if (!hit) return json(res, 503, { error: 'немає даних' });
    if (req.headers['if-none-match'] === hit.etag) {
      return send(res, 304, '', { ETag: hit.etag, 'Cache-Control': 'public, max-age=15' });
    }
    return send(res, 200, method === 'HEAD' ? '' : hit.body, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=120',
      'Access-Control-Allow-Origin': '*',
      ETag: hit.etag,
    });
  }

  /* ---------- session ---------- */
  if (urlPath === '/api/login' && method === 'POST') {
    const t = throttleState(ip);
    if (t.blocked) return json(res, 429, { error: `Забагато спроб. Спробуйте через ${t.retryIn} с` });
    /* a spread-out guessing run never trips the per-IP backoff, so the
       whole login route closes for a while instead */
    if (loginsLocked() && !isKnownIP(ip)) {
      logChange({ what: 'login.locked', ip });
      return json(res, 429, { error: 'Вхід тимчасово заблоковано через підозрілу активність. Спробуйте за 15 хвилин.' });
    }
    if (!loadCredentials()) return json(res, 503, { error: 'Пароль ще не налаштовано. Запустіть: node server/set-password.mjs' });
    const body = await readBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !checkPassword(password)) {
      noteFailure(ip);
      noteGlobalFailure();
      logChange({ what: 'login.fail', ip });
      /* one fixed delay for every failure — no timing hint about the password */
      await new Promise(r => setTimeout(r, 400));
      return json(res, 401, { error: 'Невірний пароль' });
    }
    clearFailures(ip);
    clearGlobalFailures();
    rememberGoodIP(ip);
    const s = createSession(req.headers['user-agent']);
    logChange({ what: 'login.ok', ip });
    return json(res, 200, { ok: true, csrf: s.csrf }, { 'Set-Cookie': setCookie('sid', s.id, 12 * 60 * 60) });
  }

  if (urlPath === '/api/logout' && method === 'POST') {
    dropSession(cookies(req).sid);
    return json(res, 200, { ok: true }, { 'Set-Cookie': setCookie('sid', '', 0) });
  }

  if (urlPath === '/api/me' && method === 'GET') {
    const s = requireSession(req);
    return json(res, 200, s ? { authed: true, csrf: s.csrf } : { authed: false });
  }

  /* ---------- everything below needs a session ---------- */
  const session = requireSession(req);
  if (!urlPath.startsWith('/api/admin/')) return json(res, 404, { error: 'немає такого методу' });
  if (!session) return json(res, 401, { error: 'не авторизовано' });

  if (method !== 'GET') {
    const bad = requireWrite(req, session);
    if (bad) return json(res, 403, { error: bad });
  }

  const resource = urlPath.slice('/api/admin/'.length);

  /* rates / branches / texts: read and replace whole documents */
  const DOCS = {
    rates: { name: 'rates', check: validateRates },
    branches: { name: 'branches', check: validateBranches },
    texts: { name: 'texts', check: validateTexts },
  };
  if (DOCS[resource]) {
    const doc = DOCS[resource];
    if (method === 'GET') return json(res, 200, readJSON(doc.name));
    if (method === 'PUT') {
      const body = await readBody(req);
      const before = readJSON(doc.name);
      if (doc.name === 'rates' && body.confirmBigMoves !== true) {
        const moves = rateMoves(body, before);
        if (moves.length) {
          logChange({ what: 'rates.bigmove.held', count: moves.length, ip: clientIP(req) });
          return json(res, 409, { error: 'Незвично велика зміна курсу', moves });
        }
      }
      const next = doc.check(body, before);
      writeJSON(doc.name, next);
      if (doc.name === 'rates') dropRatesCache();
      logChange({ what: `${doc.name}.save`, ip: clientIP(req) });
      scheduleRebuild();
      return json(res, 200, { ok: true, saved: next });
    }
    return json(res, 405, { error: 'метод не підтримується' });
  }

  if (resource === 'posts' && method === 'GET') return json(res, 200, { posts: listPosts() });

  if (resource.startsWith('posts/')) {
    const slug = resource.slice('posts/'.length);
    if (!validSlug(slug)) return json(res, 400, { error: 'погана адреса статті' });
    if (method === 'GET') {
      const post = readPost(slug);
      return post ? json(res, 200, post) : json(res, 404, { error: 'статтю не знайдено' });
    }
    if (method === 'PUT') {
      const post = validatePost(await readBody(req));
      writePost(slug, post);
      logChange({ what: 'post.save', slug, ip: clientIP(req) });
      scheduleRebuild();
      return json(res, 200, { ok: true, slug });
    }
    if (method === 'DELETE') {
      deletePost(slug);
      logChange({ what: 'post.delete', slug, ip: clientIP(req) });
      scheduleRebuild();
      return json(res, 200, { ok: true });
    }
    return json(res, 405, { error: 'метод не підтримується' });
  }

  if (resource === 'images' && method === 'GET') {
    const dir = path.join(ROOT, 'images');
    const files = fs.existsSync(dir)
      ? fs.readdirSync(dir).filter(f => /\.(webp|jpg|jpeg|png|svg)$/i.test(f)).sort()
      : [];
    return json(res, 200, { images: files.map(f => 'images/' + f) });
  }

  if (resource === 'upload' && method === 'POST') {
    const buf = await readRaw(req, MAX_UPLOAD);
    const ext = sniffImage(buf);                       // throws Invalid on anything else
    const digest = crypto.createHash('sha1').update(buf).digest('hex');
    const name = safeImageName(req.headers['x-file-name'], ext, digest);
    const dir = path.join(ROOT, 'images');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, name);
    if (path.dirname(file) !== dir) return json(res, 400, { error: 'погана назва файлу' });
    if (!fs.existsSync(file)) {                        // same bytes, same name — upload once
      const tmp = file + '.tmp';
      fs.writeFileSync(tmp, buf);
      fs.renameSync(tmp, file);
    }
    logChange({ what: 'image.upload', name, bytes: buf.length, ip: clientIP(req) });
    return json(res, 200, { path: 'images/' + name, bytes: buf.length });
  }

  if (resource === 'audit' && method === 'GET') return json(res, 200, { entries: readAudit() });

  if (resource === 'rebuild' && method === 'POST') { runBuild(); return json(res, 200, { ok: true }); }

  return json(res, 404, { error: 'немає такого методу' });
}

/* ============================================================
   server
   ============================================================ */
const server = http.createServer(async (req, res) => {
  let urlPath;
  try { urlPath = new URL(req.url, 'http://localhost').pathname; }
  catch { return send(res, 400, 'Bad request', { 'Content-Type': 'text/plain; charset=utf-8' }); }

  try {
    if (urlPath.startsWith('/api/')) return await api(req, res, urlPath);
    if (req.method !== 'GET' && req.method !== 'HEAD') return send(res, 405, 'Method not allowed', { 'Content-Type': 'text/plain; charset=utf-8' });
    const wait = take('static|' + clientIP(req), LIMITS.static);
    if (wait) return send(res, 429, 'Too many requests', { 'Content-Type': 'text/plain; charset=utf-8', 'Retry-After': String(wait) });
    return serveStatic(req, res, urlPath === '/' ? '/index.html' : urlPath);
  } catch (err) {
    if (err instanceof Invalid) return json(res, 400, { error: err.message });
    console.error('[error]', urlPath, err);
    return json(res, 500, { error: 'внутрішня помилка' });
  }
});

hardenServer(server);

/* A bug in one request must not take the whole site off the air. Log it
   and keep serving; systemd restarts only if the process truly dies. */
process.on('uncaughtException', (err) => console.error('[uncaught]', err));
process.on('unhandledRejection', (err) => console.error('[unhandled]', err));

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log(`BEST  site  ${where}`);
  console.log(`      admin ${where}/admin`);
  if (!loadCredentials()) console.log('      ⚠ пароль не налаштовано — запустіть: node server/set-password.mjs');
});
