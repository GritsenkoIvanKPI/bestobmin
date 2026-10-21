/* Every value that arrives from the browser is rebuilt here field by field.
   Nothing from the request body is ever written to disk as-is, so a crafted
   payload cannot smuggle extra keys or HTML into the site. */

export class Invalid extends Error {}

const fail = (msg) => { throw new Invalid(msg); };

const str = (v, { max = 400, min = 0, name = 'поле', allowEmpty = min === 0 } = {}) => {
  if (typeof v !== 'string') fail(`${name}: очікується текст`);
  const s = v.replace(/\r\n/g, '\n').trim();
  if (!allowEmpty && !s) fail(`${name}: не може бути порожнім`);
  if (s.length > max) fail(`${name}: задовго (максимум ${max})`);
  return s;
};

const num = (v, { min = 0, max = 1e6, name = 'число' } = {}) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v).replace(',', '.'));
  if (!isFinite(n)) fail(`${name}: не число`);
  if (n < min || n > max) fail(`${name}: поза межами ${min}–${max}`);
  /* keep at most 4 decimals — rates are quoted to 2–3 */
  return Math.round(n * 1e4) / 1e4;
};

const arr = (v, name) => (Array.isArray(v) ? v : fail(`${name}: очікується список`));

/* ---------- rates ---------- */
export function validateRates(input, current) {
  const byId = new Map(current.rows.map(r => [r.id, r]));
  const seen = new Set();

  const rows = arr(input.rows, 'rows').map((row) => {
    const base = byId.get(row.id);
    if (!base) fail(`невідома валюта: ${String(row.id).slice(0, 20)}`);
    if (seen.has(row.id)) fail(`валюта ${row.id} двічі`);
    seen.add(row.id);

    /* Presentation stays with the developer — the admin only moves numbers,
       so a saved form can never rename a currency or swap its flag. */
    const out = { ...base };
    for (const t of ['w', 'r']) {
      if (!base[t]) { continue; }
      const got = row[t];
      if (!got || typeof got !== 'object') fail(`${base.code}: бракує ${t === 'w' ? 'оптового' : 'роздрібного'} курсу`);
      const isPct = base[t].unit === '%';
      const lim = isPct ? { min: -50, max: 50 } : { min: 0.0001, max: 100000 };
      const buy = num(got.buy, { ...lim, name: `${base.code} купівля` });
      const sell = num(got.sell, { ...lim, name: `${base.code} продаж` });
      if (sell < buy) fail(`${base.code}: продаж (${sell}) менший за купівлю (${buy})`);
      out[t] = { ...base[t], buy, sell };
    }
    return out;
  });

  if (rows.length !== current.rows.length) fail('список валют неповний');

  return {
    ...current,
    rows,
    headline: str(input.headline ?? current.headline, { max: 40, name: 'Дата в заголовку' }),
    wholesaleMin: num(input.wholesaleMin ?? current.wholesaleMin, { min: 1, max: 100000, name: 'Оптовий поріг' }),
    updatedAt: new Date().toISOString(),
  };
}

/* ---------- branches ---------- */
const TEL = /^\+380\d{9}$/;

export function validateBranches(input, current) {
  const byId = new Map(current.branches.map(b => [b.id, b]));
  const branches = arr(input.branches, 'branches').map((b) => {
    const base = byId.get(b.id) || {};
    const phones = arr(b.phones ?? base.phones ?? [], 'телефони').slice(0, 4).map((p, i) => {
      const tel = str(p.tel, { max: 16, min: 1, name: `телефон ${i + 1}` });
      if (!TEL.test(tel)) fail(`телефон ${i + 1}: формат +380XXXXXXXXX`);
      return { tel, text: str(p.text, { max: 24, min: 1, name: `телефон ${i + 1} (підпис)` }) };
    });
    if (!phones.length) fail(`${b.addr || base.addr || 'відділення'}: потрібен хоча б один телефон`);
    const hours = arr(b.hours ?? base.hours ?? [], 'графік').slice(0, 4)
      .map((h, i) => str(h, { max: 40, min: 1, name: `графік, рядок ${i + 1}` }));
    if (!hours.length) fail('потрібен хоча б один рядок графіку');
    const addr = str(b.addr, { max: 80, min: 1, name: 'адреса' });
    return {
      ...base,
      id: base.id || slugify(addr),
      addr,
      addrFull: str(b.addrFull ?? base.addrFull ?? '', { max: 120, name: 'повна адреса' }) || `м. Івано-Франківськ, ${addr}`,
      mapQuery: str(b.mapQuery ?? base.mapQuery ?? '', { max: 160, name: 'запит для карти' }) || `Івано-Франківськ, ${addr}`,
      badge: str(b.badge ?? base.badge ?? '', { max: 40, name: 'підпис-бейдж' }),
      phones,
      hours,
      hoursMuted: str(b.hoursMuted ?? base.hoursMuted ?? '', { max: 40, name: 'примітка до графіку' }),
      hoursShort: str(b.hoursShort ?? base.hoursShort ?? '', { max: 80, name: 'короткий графік' }) || hours.join(' · '),
    };
  });
  if (!branches.length) fail('потрібне хоча б одне відділення');
  if (branches.length > 12) fail('забагато відділень');

  const main = branches[0].phones[0];
  return {
    ...current,
    branches,
    mainPhone: { tel: main.tel, text: '+38 ' + main.text },
  };
}

const slugify = (s) => 'b' + Buffer.from(s).toString('hex').slice(0, 12);

/* ---------- section texts ---------- */
export function validateTexts(input, current) {
  const out = { ...current };
  for (const [key, value] of Object.entries(input)) {
    if (!(key in current)) fail(`невідоме поле: ${String(key).slice(0, 40)}`);
    if (key.startsWith('_')) continue;
    out[key] = str(value, { max: 1200, min: 1, name: key });
  }
  return out;
}

/* ---------- blog post ---------- */
const TAGS = ['Курси', 'Валюти', 'Поради', 'Новини', 'Блог'];

export function validatePost(input) {
  const date = str(input.date, { max: 10, min: 10, name: 'Дата' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || isNaN(new Date(date))) fail('Дата: формат РРРР-ММ-ДД');
  const tag = str(input.tag || 'Блог', { max: 24, name: 'Рубрика' });
  if (!TAGS.includes(tag)) fail(`Рубрика: оберіть зі списку (${TAGS.join(', ')})`);
  const image = str(input.image || '', { max: 120, name: 'Зображення' });
  if (image && !/^images\/[\w.-]+\.(webp|jpg|jpeg|png|svg)$/.test(image)) fail('Зображення: шлях має бути images/файл.webp');
  return {
    title: str(input.title, { max: 160, min: 1, name: 'Заголовок' }),
    date,
    tag,
    image,
    imageAlt: str(input.imageAlt || '', { max: 160, name: 'Опис зображення' }),
    excerpt: str(input.excerpt, { max: 400, min: 1, name: 'Анонс' }),
    draft: input.draft === true || input.draft === 'true',
    body: str(input.body, { max: 40000, min: 1, name: 'Текст' }),
  };
}

/* ---------- uploaded image ----------
   The type is read from the bytes, never from the name or the declared
   Content-Type: a file called photo.webp that is really something else is
   refused. SVG is not accepted at all — it can carry script. */
export function sniffImage(buf) {
  if (buf.length < 12) fail('файл порожній або пошкоджений');
  const hex = buf.subarray(0, 12);
  if (hex[0] === 0xff && hex[1] === 0xd8 && hex[2] === 0xff) return 'jpg';
  if (hex[0] === 0x89 && hex[1] === 0x50 && hex[2] === 0x4e && hex[3] === 0x47
      && hex[4] === 0x0d && hex[5] === 0x0a && hex[6] === 0x1a && hex[7] === 0x0a) return 'png';
  if (hex.toString('latin1', 0, 4) === 'RIFF' && hex.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  fail('підтримуються лише JPG, PNG і WebP');
}

/* The stored name is built here, never taken from the browser. */
export function safeImageName(hint, ext, digest) {
  const base = String(hint || '')
    .toLowerCase()
    .replace(/\.[a-z0-9]+$/, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'photo';
  return `${base}-${digest.slice(0, 8)}.${ext}`;
}
