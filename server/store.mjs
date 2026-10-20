/* Data store: plain JSON files on disk, written atomically.
   No database and no hosting-specific service, so the whole thing moves
   to another server by copying the folder. */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
/* Live data can sit outside the repo so that deploying (git pull, rsync)
   never overwrites the rates the client just saved:
       DATA_DIR=/var/lib/bestobmin node server/index.mjs */
const DATA = process.env.DATA_DIR
  ? path.resolve(process.env.DATA_DIR)
  : path.join(ROOT, 'data');
export const DATA_DIR = DATA;
const BACKUPS = path.join(DATA, '.backups');
const KEEP_BACKUPS = 30;

export const dataPath = (name) => path.join(DATA, name + '.json');

export function readJSON(name, fallback = null) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(name), 'utf8'));
  } catch {
    return fallback;
  }
}

/* Write through a temp file and rename: a crash mid-write can never leave
   a half-written rates.json on disk. The previous version is kept so a bad
   edit can be rolled back by hand. */
export function writeJSON(name, value) {
  const file = dataPath(name);
  fs.mkdirSync(DATA, { recursive: true });
  if (fs.existsSync(file)) {
    fs.mkdirSync(BACKUPS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.copyFileSync(file, path.join(BACKUPS, `${name}.${stamp}.json`));
    pruneBackups(name);
  }
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function pruneBackups(name) {
  const mine = fs.readdirSync(BACKUPS).filter(f => f.startsWith(name + '.')).sort();
  for (const f of mine.slice(0, Math.max(0, mine.length - KEEP_BACKUPS))) {
    try { fs.unlinkSync(path.join(BACKUPS, f)); } catch {}
  }
}

/* ---------- blog posts: Markdown files, same format the build reads ---------- */
const POSTS = path.join(ROOT, 'content', 'posts');
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export const validSlug = (s) => typeof s === 'string' && s.length >= 2 && s.length <= 80 && SLUG.test(s);

const postFile = (slug) => {
  if (!validSlug(slug)) throw new Error('bad slug');
  return path.join(POSTS, slug + '.md');   // slug charset makes traversal impossible
};

export function listPosts() {
  if (!fs.existsSync(POSTS)) return [];
  return fs.readdirSync(POSTS)
    .filter(f => f.endsWith('.md'))
    .map(f => ({ slug: f.replace(/\.md$/, ''), ...parsePost(fs.readFileSync(path.join(POSTS, f), 'utf8')) }))
    .sort((a, b) => String(b.date).localeCompare(String(a.date)));
}

export function readPost(slug) {
  const file = postFile(slug);
  if (!fs.existsSync(file)) return null;
  return { slug, ...parsePost(fs.readFileSync(file, 'utf8')) };
}

export function writePost(slug, post) {
  fs.mkdirSync(POSTS, { recursive: true });
  const order = ['title', 'date', 'tag', 'image', 'imageAlt', 'excerpt', 'draft'];
  const fm = order
    .filter(k => post[k] !== undefined && post[k] !== '')
    .map(k => `${k}: ${needsQuotes(String(post[k])) ? JSON.stringify(String(post[k])) : post[k]}`)
    .join('\n');
  const tmp = postFile(slug) + '.tmp';
  fs.writeFileSync(tmp, `---\n${fm}\n---\n\n${String(post.body || '').trim()}\n`, 'utf8');
  fs.renameSync(tmp, postFile(slug));
}

export function deletePost(slug) {
  const file = postFile(slug);
  if (fs.existsSync(file)) fs.unlinkSync(file);
}

/* A value starting with punctuation, or holding a colon, would change the
   meaning of the front matter line, so it gets quoted. */
const needsQuotes = (v) => /^[\s"'\[{#&*!|>%@`-]/.test(v) || /:\s/.test(v) || v.includes('\n');

function parsePost(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { title: '', body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  data.draft = String(data.draft) === 'true';
  return { ...data, body: src.slice(m[0].length).trim() };
}

/* ---------- audit log ---------- */
export function logChange(entry) {
  fs.mkdirSync(DATA, { recursive: true });
  const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
  try { fs.appendFileSync(path.join(DATA, 'audit.log'), line, 'utf8'); } catch {}
}

export function readAudit(limit = 60) {
  try {
    return fs.readFileSync(path.join(DATA, 'audit.log'), 'utf8')
      .trim().split('\n').filter(Boolean).slice(-limit).reverse()
      .map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
}
