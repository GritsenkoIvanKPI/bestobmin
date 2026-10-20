import fs from 'fs';
import path from 'path';

const p = 'parts/';
const SITE = 'https://bestobmin.vercel.app';
const f = fs.readdirSync(p);
const pick = (re) => f.filter(x => re.test(x)).sort();
const read = (x) => fs.readFileSync(x, 'utf8');

/* ============================================================
   CONTENT — content/posts/*.md, one file per post.
   Front matter keys: title, date, tag, image, imageAlt, excerpt,
   draft. The body is Markdown. Nothing else in the build knows
   about individual posts, so an admin panel only ever has to
   write these files.
   ============================================================ */
const MONTHS = ['січня','лютого','березня','квітня','травня','червня',
                'липня','серпня','вересня','жовтня','листопада','грудня'];

const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')
                            .replace(/>/g,'&gt;').replace(/"/g,'&quot;');

function frontMatter(src) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(src);
  if (!m) return { data: {}, body: src };
  const data = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = /^([A-Za-z][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) continue;
    let v = kv[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
    data[kv[1]] = v;
  }
  return { data, body: src.slice(m[0].length) };
}

/* A deliberately small Markdown subset: headings, paragraphs, lists,
   quotes, rules, images, links, bold/italic/code. Enough for a blog,
   small enough to stay dependency-free. */
function inline(s) {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, '<img src="$2" alt="$1" loading="lazy">')
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
}

function markdown(src) {
  const lines = src.replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  const flushList = (tag, re) => {
    const items = [];
    while (i < lines.length && re.test(lines[i])) items.push(inline(lines[i++].replace(re, '')));
    out.push(`<${tag}>` + items.map(x => `<li>${x}</li>`).join('') + `</${tag}>`);
  };
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    if (/^###\s+/.test(line))      { out.push(`<h3>${inline(line.replace(/^###\s+/, ''))}</h3>`); i++; continue; }
    if (/^##\s+/.test(line))       { out.push(`<h2>${inline(line.replace(/^##\s+/, ''))}</h2>`);  i++; continue; }
    if (/^(---|\*\*\*)\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^[-*]\s+/.test(line))     { flushList('ul', /^[-*]\s+/); continue; }
    if (/^\d+\.\s+/.test(line))    { flushList('ol', /^\d+\.\s+/); continue; }
    if (/^>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, ''));
      out.push(`<blockquote><p>${inline(buf.join(' '))}</p></blockquote>`);
      continue;
    }
    if (/^!\[/.test(line.trim())) { out.push(`<figure>${inline(line.trim())}</figure>`); i++; continue; }
    const buf = [];
    while (i < lines.length && lines[i].trim() && !/^(#{2,3}\s|[-*]\s|\d+\.\s|>\s?|---|\*\*\*)/.test(lines[i])) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return out.join('\n');
}

/* ============================================================
   EDITABLE TEXT — data/texts.json fills {{key}} placeholders left
   in the parts. In a heading, a blank line is a line break and
   **word** is the gold accent, so the admin never types HTML.
   ============================================================ */
const TEXTS = JSON.parse(read('data/texts.json'));
const RATES = JSON.parse(read('data/rates.json'));

const accentHeading = (v) => esc(v).split('\n')
  .map(line => line.replace(/\*\*(.+?)\*\*/g, '<span class="accent">$1</span>'))
  .join('<br>');

/* Body text is escaped and then given back only **bold** — the admin can
   never put markup (or a script tag) into the page by typing it. */
const richText = (v) => esc(v).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>');

function applyTexts(html) {
  return html.replace(/\{\{([a-z]+\.[a-zA-Z0-9]+)(\|head)?\}\}/g, (all, key, head) => {
    if (!(key in TEXTS)) throw new Error('no text for placeholder ' + all);
    const v = String(TEXTS[key]).replace('{headline}', RATES.headline);
    return head ? accentHeading(v) : richText(v);
  });
}

const postsDir = 'content/posts';
const posts = (fs.existsSync(postsDir) ? fs.readdirSync(postsDir) : [])
  .filter(x => x.endsWith('.md'))
  .map(file => {
    const { data, body } = frontMatter(read(path.join(postsDir, file)));
    const d = new Date(data.date);
    const words = body.split(/\s+/).filter(Boolean).length;
    return {
      slug: data.slug || file.replace(/\.md$/, ''),
      title: data.title || file,
      tag: data.tag || 'Блог',
      image: data.image || 'images/news-1.webp',
      imageAlt: data.imageAlt || '',
      excerpt: data.excerpt || '',
      draft: String(data.draft) === 'true',
      iso: data.date,
      date: `${d.getDate()} ${MONTHS[d.getMonth()]}`,
      dateFull: `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`,
      read: Math.max(1, Math.round(words / 150)),
      html: markdown(body),
      ts: d.getTime(),
    };
  })
  .filter(x => !x.draft)
  .sort((a, b) => b.ts - a.ts);

/* ============================================================
   RATES — data/rates.json is the single source for the table and
   for the calculator, so the two can never disagree.
   ============================================================ */
/* Show a rate the way it was typed: never fewer than two decimals,
   never more than the number actually carries (0.142 stays 0.142). */
const fmtRate = (n) => {
  const dec = (String(n).split('.')[1] || '').length;
  return Number(n).toFixed(Math.max(2, dec));
};
const cellText = (tier, side) => tier.unit === '%' ? `+${tier[side]}%` : fmtRate(tier[side]);

function rateRow(row, t) {
  const tier = row[t];
  const label = tier.label || row.label;
  return `        <div class="rate-row${row.featured ? ' is-featured' : ''}">
          <div class="rate-row__cur"><span class="cur-badge"><svg class="flag" role="img" aria-label="${esc(label)}"><use href="#fl-${esc(row.flag)}"/></svg></span><span><span class="rate-row__code">${esc(row.code)}</span><span class="rate-row__label">${esc(label)}</span></span></div>
          <div class="rate-row__num is-buy" data-rate="${row.id}.${t}.buy">${cellText(tier, 'buy')}</div>
          <div class="rate-row__num" data-rate="${row.id}.${t}.sell">${cellText(tier, 'sell')}</div>
        </div>`;
}

function ratePanel(t, id, hidden) {
  const rows = RATES.rows.filter(r => r[t]);
  const split = Math.ceil(rows.length / 2);
  const head = '        <div class="rate-row rate-row--head"><span>Валюта</span><span class="ta-right">Купівля</span><span class="ta-right">Продаж</span></div>';
  const col = (list) => `      <div class="rate-table__col">\n${head}\n\n${list.map(r => rateRow(r, t)).join('\n')}\n      </div>`;
  return `    <div class="card rate-table" id="${id}" role="tabpanel"${hidden ? ' hidden' : ''}>
${col(rows.slice(0, split))}
${col(rows.slice(split))}
    </div>`;
}

const ratesTable = () => ratePanel('w', 'rt-w', false) + '\n\n' + ratePanel('r', 'rt-r', true);

/* ============================================================
   SHARED CHUNKS — header and footer come straight out of the
   main page's parts, so the blog can never drift from the site.
   ============================================================ */
const slice = (src, from, to) => {
  const i = src.indexOf(from), j = src.indexOf(to, i);
  if (i < 0 || j < 0) throw new Error('chunk not found: ' + from);
  return src.slice(i, j + to.length);
};
const body01 = read(p + 'body-01.html');
const body06 = read(p + 'body-06.html');
const headerHtml = applyTexts(slice(body01, '<header class="site-header"', '</header>'));
const footerHtml = applyTexts(slice(body06, '<footer class="site-footer"', '</footer>'));

/* On a sub-page every in-page anchor has to point back at the home
   page, and every asset path has to be root-absolute — /blog/<slug>
   is a directory deeper than the root. */
const toRoot = (html) => html
  .replace(/href="#top"/g, 'href="/"')
  .replace(/href="#/g, 'href="/#')
  .replace(/(src|href|content)="images\//g, '$1="/images/');

const CHEV = '<svg viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 9.5 9.5 2.5M4 2.5h5.5V8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>';

const card = (post, i, { root = false, lead = false } = {}) => {
  const img = (root ? '/' : '') + post.image;
  const href = (root ? '/blog/' : 'blog/') + post.slug;
  return `      <article class="card post${lead ? ' post--lead' : ''} reveal"${i ? ` style="transition-delay:.0${i * 8}s"` : ''}>
        <div class="post__media">
          <span class="post__date">${esc(post.date)}</span>
          <span class="post__tag">${esc(post.tag)}</span>
          <img decoding="async" src="${img}" alt="${esc(post.imageAlt)}" loading="lazy" width="900" height="672">
        </div>
        <div class="post__body">
          <h3 class="h-card">${esc(post.title)}</h3>
          <p>${esc(post.excerpt)}</p>
          <a class="post__more" href="${href}">Читати${CHEV}</a>
        </div>
      </article>`;
};

/* ============================================================
   HOME PAGE
   ============================================================ */
let home = read(p + '00-head.html');
home += '<style>\n';
for (const c of pick(/^css-\d+\.css$/)) home += read(p + c);
home += '</style>\n</head>\n<body>\n';
for (const b of pick(/^body-\d+\.html$/)) home += read(p + b);
home += read(p + 'zz-tail.html');
home = home.replace('<!--{{LATEST_POSTS}}-->', posts.slice(0, 3).map((x, i) => card(x, i)).join('\n'));
home = home.replace('<!--{{RATES_TABLE}}-->', ratesTable());
home = home.replace('/*{{RATES_DATA}}*/', 'window.__RATES__ = ' + JSON.stringify(RATES) + ';');
home = applyTexts(home);
fs.writeFileSync('index.html', home);

/* ============================================================
   BLOG — one stylesheet, a listing page, a page per post
   ============================================================ */
let css = '';
for (const c of pick(/^css-\d+\.css$/)) css += read(p + c);
css += read(p + 'blog.css');
fs.mkdirSync('assets', { recursive: true });
fs.writeFileSync('assets/site.css', css);

const head = ({ title, desc, url, image, article }) => `<!DOCTYPE html>
<html lang="uk">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<meta name="description" content="${esc(desc)}">
<meta name="theme-color" content="#050505">
<link rel="canonical" href="${SITE}${url}">
<meta property="og:type" content="${article ? 'article' : 'website'}">
<meta property="og:locale" content="uk_UA">
<meta property="og:site_name" content="BEST — обмін валют">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${SITE}${url}">
<meta property="og:image" content="${SITE}/${image}">
<meta name="twitter:card" content="summary_large_image">
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Inter+Tight:wght@300;400;500;600&family=Inter:wght@300;400;500&family=JetBrains+Mono:wght@400;500;700&display=swap" rel="stylesheet">
<link rel="icon" type="image/svg+xml" href="/images/favicon.svg">
<link rel="stylesheet" href="/assets/site.css">
${article ? `<script type="application/ld+json">${JSON.stringify(article)}</script>\n` : ''}</head>
<body>
${toRoot(headerHtml)}
<main>
`;

const tail = `</main>
${toRoot(footerHtml)}
<script>
(function () {
  'use strict';
  var io = new IntersectionObserver(function (entries) {
    entries.forEach(function (e) {
      if (e.isIntersecting) { e.target.classList.add('visible'); io.unobserve(e.target); }
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.06 });
  document.querySelectorAll('.reveal').forEach(function (el) { io.observe(el); });

  var header = document.querySelector('.site-header');
  var onScroll = function () { header.classList.toggle('is-stuck', window.scrollY > 24); };
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  var burger = document.getElementById('burger');
  var nav = document.getElementById('nav');
  burger.addEventListener('click', function () {
    var open = burger.getAttribute('aria-expanded') === 'true';
    burger.setAttribute('aria-expanded', String(!open));
    nav.classList.toggle('is-open', !open);
  });
  nav.addEventListener('click', function (e) {
    if (e.target.tagName === 'A') { burger.setAttribute('aria-expanded', 'false'); nav.classList.remove('is-open'); }
  });

  var pick = document.getElementById('branchPick');
  pick.addEventListener('click', function (e) {
    e.stopPropagation();
    pick.setAttribute('aria-expanded', String(pick.getAttribute('aria-expanded') !== 'true'));
  });
  document.addEventListener('click', function () { pick.setAttribute('aria-expanded', 'false'); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') { pick.setAttribute('aria-expanded', 'false'); }
  });
})();
</script>
</body>
</html>
`;

/* ---------- listing ---------- */
const listing = head({
  title: 'Блог — новини та аналітика курсу валют | BEST Івано-Франківськ',
  desc: 'Коротко й по суті про курс валют, стан банкнот і те, як вигідніше обмінювати. Блог мережі обмінних пунктів BEST в Івано-Франківську.',
  url: '/blog',
  image: 'images/news-1.webp',
}) + `<section class="page-head">
  <div class="shell"><div class="page-head__inner">
    <nav class="crumbs" aria-label="Хлібні крихти">
      <a href="/">Головна</a><i>/</i><span class="is-here" aria-current="page">Блог</span>
    </nav>
    <span class="eyebrow">Новини та аналітика</span>
    <h1>Що відбувається <span class="accent">з курсом валют</span></h1>
    <p class="lede">Коротко пояснюємо, що впливає на курс цього тижня, які банкноти беруть без комісії та коли вигідніше обмінювати валюту.</p>
  </div></div>
</section>

<section class="section blog-list">
  <div class="shell">
    <div class="blog-grid">
${posts.map((x, i) => card(x, i, { root: true, lead: i === 0 })).join('\n')}
    </div>
  </div>
</section>
` + tail;
fs.mkdirSync('blog', { recursive: true });
fs.writeFileSync('blog/index.html', listing);

/* ---------- one page per post ---------- */
for (const post of posts) {
  const others = posts.filter(x => x.slug !== post.slug).slice(0, 3);
  const page = head({
    title: `${post.title} | Блог BEST`,
    desc: post.excerpt,
    url: `/blog/${post.slug}`,
    image: post.image,
    article: {
      '@context': 'https://schema.org',
      '@type': 'BlogPosting',
      headline: post.title,
      description: post.excerpt,
      datePublished: post.iso,
      image: `${SITE}/${post.image}`,
      author: { '@type': 'Organization', name: 'BEST — обмін валют' },
      publisher: { '@type': 'Organization', name: 'BEST — обмін валют' },
      mainEntityOfPage: `${SITE}/blog/${post.slug}`,
    },
  }) + `<article class="page-head">
  <div class="shell"><div class="page-head__inner">
    <nav class="crumbs" aria-label="Хлібні крихти">
      <a href="/">Головна</a><i>/</i><a href="/blog">Блог</a><i>/</i><span class="is-here" aria-current="page">${esc(post.tag)}</span>
    </nav>
    <div class="article__meta">
      <b>${esc(post.dateFull)}</b><i>·</i><span>${post.read} хв читання</span><i>·</i><span>${esc(post.tag)}</span>
    </div>
    <h1>${esc(post.title)}</h1>
    <p class="lede">${esc(post.excerpt)}</p>
  </div></div>
</article>

<section class="section article">
  <div class="shell">
    <div class="article__cover reveal">
      <img decoding="async" src="/${post.image}" alt="${esc(post.imageAlt)}" width="1200" height="525">
    </div>
    <div class="prose reveal">
${post.html}
    </div>
    <div class="card article__foot reveal">
      <p>Потрібен курс на конкретну суму? Залиште заявку — передзвонимо з актуальними цифрами.</p>
      <a class="btn btn--light" href="/#exchange">Залишити заявку${CHEV}</a>
    </div>
  </div>
</section>
${others.length ? `
<section class="section more-posts">
  <div class="shell">
    <div class="more-posts__head">
      <h2>Інші матеріали</h2>
      <a class="post__more" href="/blog">Усі статті${CHEV}</a>
    </div>
    <div class="blog-grid">
${others.map((x, i) => card(x, i, { root: true })).join('\n')}
    </div>
  </div>
</section>
` : ''}` + tail;
  fs.writeFileSync(path.join('blog', post.slug + '.html'), page);
}

/* ============================================================
   ADMIN — one self-contained page at /admin
   ============================================================ */
fs.mkdirSync('admin', { recursive: true });
const adminPage = read(p + 'admin.html')
  .replace('/*{{ADMIN_CSS}}*/', () => read(p + 'admin.css'))
  .replace('/*{{ADMIN_JS}}*/', () => read(p + 'admin.js'));
fs.writeFileSync('admin/index.html', adminPage);

console.log(`index.html ${home.length}b · admin ${adminPage.length}b · blog/index.html ${listing.length}b · ${posts.length} post page(s) · assets/site.css ${css.length}b`);
