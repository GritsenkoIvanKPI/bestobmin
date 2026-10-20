/* BEST — site + admin server.
   Plain Node, no dependencies, so it runs on any host that has Node 18+:
       node server/index.mjs
   Put it behind nginx/Caddy for TLS, or set TRUST_PROXY=1 when it sits
   behind a reverse proxy so client IPs are read from X-Forwarded-For. */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { execFile } from 'child_process';
import {
  ROOT, readJSON, writeJSON, listPosts, readPost, writePost, deletePost,
  validSlug, logChange, readAudit,
} from './store.mjs';
import {
  checkPassword, loadCredentials, loadSessions, createSession, getSession,
  dropSession, sameSecret, throttleState, noteFailure, clearFailures,
} from './auth.mjs';
import { Invalid, validateRates, validateBranches, validateTexts, validatePost } from './validate.mjs';

const PORT = Number(process.env.PORT || 4199);
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const SECURE_COOKIES = process.env.SECURE_COOKIES === '1';
const MAX_BODY = 256 * 1024;

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

/* The admin page may only talk to its own origin and may not be framed. */
const ADMIN_CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "font-src 'self' https://fonts.gstatic.com",
  "img-src 'self' data:",
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
const requireSession = (req) => getSession(cookies(req).sid);

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

async function api(req, res, urlPath) {
  const method = req.method;

  /* ---------- public ---------- */
  if (urlPath === '/api/public/rates' && method === 'GET') {
    const rates = readJSON('rates');
    if (!rates) return json(res, 503, { error: 'немає даних' });
    return json(res, 200, rates, {
      'Cache-Control': 'public, max-age=15, stale-while-revalidate=120',
      'Access-Control-Allow-Origin': '*',
    });
  }

  /* ---------- session ---------- */
  if (urlPath === '/api/login' && method === 'POST') {
    const ip = clientIP(req);
    const t = throttleState(ip);
    if (t.blocked) return json(res, 429, { error: `Забагато спроб. Спробуйте через ${t.retryIn} с` });
    if (!loadCredentials()) return json(res, 503, { error: 'Пароль ще не налаштовано. Запустіть: node server/set-password.mjs' });
    const body = await readBody(req);
    const password = typeof body.password === 'string' ? body.password : '';
    if (!password || !checkPassword(password)) {
      noteFailure(ip);
      logChange({ what: 'login.fail', ip });
      /* one fixed delay for every failure — no timing hint about the password */
      await new Promise(r => setTimeout(r, 400));
      return json(res, 401, { error: 'Невірний пароль' });
    }
    clearFailures(ip);
    const s = createSession();
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
      const next = doc.check(body, readJSON(doc.name));
      writeJSON(doc.name, next);
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
    return serveStatic(req, res, urlPath === '/' ? '/index.html' : urlPath);
  } catch (err) {
    if (err instanceof Invalid) return json(res, 400, { error: err.message });
    console.error('[error]', urlPath, err);
    return json(res, 500, { error: 'внутрішня помилка' });
  }
});

server.listen(PORT, () => {
  const where = `http://localhost:${PORT}`;
  console.log(`BEST  site  ${where}`);
  console.log(`      admin ${where}/admin`);
  if (!loadCredentials()) console.log('      ⚠ пароль не налаштовано — запустіть: node server/set-password.mjs');
});
