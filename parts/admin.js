(function () {
  'use strict';

  /* ============================================================
     plumbing
     ============================================================ */
  var CSRF = null;
  var dirty = null;          // { label, save(), revert() } while there are unsaved edits

  /* ---------- showcase mode ----------
     With no server behind it (a static preview host), the panel runs on a
     snapshot so the client can walk through every screen. Nothing is
     stored and nothing can be: there is no endpoint to store it in. The
     real deployment answers /api/me, so this never switches on there. */
  var DEMO = false;
  var DEMO_PASS = 'demo2026';
  var snap = null;
  var clone = function (v) { return JSON.parse(JSON.stringify(v)); };

  function demoApi(method, url, body) {
    return new Promise(function (resolve) {
      setTimeout(function () {
        var post = /^\/api\/admin\/posts\/(.+)$/.exec(url);
        if (method === 'GET') {
          if (url === '/api/admin/rates') return resolve(clone(snap.rates));
          if (url === '/api/admin/branches') return resolve(clone(snap.branches));
          if (url === '/api/admin/texts') return resolve(clone(snap.texts));
          if (url === '/api/admin/images') return resolve({ images: snap.images.slice() });
          if (url === '/api/admin/posts') {
            return resolve({ posts: snap.posts.map(function (x) {
              return { slug: x.slug, title: x.title, date: x.date, tag: x.tag, draft: x.draft };
            }) });
          }
          if (post) {
            var found = snap.posts.filter(function (x) { return x.slug === post[1]; })[0];
            return resolve(found ? clone(found) : {});
          }
          return resolve({});
        }
        /* keep the edit on screen for the rest of the visit, then forget it */
        if (url === '/api/admin/rates') snap.rates = clone(body);
        if (url === '/api/admin/branches') snap.branches = clone(body);
        if (url === '/api/admin/texts') snap.texts = clone(body);
        if (post) {
          var slug = post[1];
          var rest = snap.posts.filter(function (x) { return x.slug !== slug; });
          if (method === 'PUT') rest.unshift(Object.assign({ slug: slug }, clone(body)));
          snap.posts = rest;
        }
        resolve({ ok: true });
      }, 120);
    });
  }

  function api(method, url, body) {
    if (DEMO) return demoApi(method, url, body);
    var opts = { method: method, headers: {}, credentials: 'same-origin' };
    if (body !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    if (method !== 'GET' && CSRF) opts.headers['X-CSRF-Token'] = CSRF;
    return fetch(url, opts).then(function (r) {
      if (r.status === 401) { showLogin('Сесія завершилась — увійдіть знову'); throw new Error('auth'); }
      return r.json().catch(function () { return {}; }).then(function (d) {
        if (!r.ok) throw new Error(d.error || ('Помилка ' + r.status));
        return d;
      });
    });
  }

  /* Views fetch before they paint. If the user switches screens meanwhile,
     the older fetch must not land on top of the newer screen. */
  var renderSeq = 0;
  var stale = function (mine) { return mine !== renderSeq; };

  var $ = function (sel, root) { return (root || document).querySelector(sel); };
  var el = function (tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  };

  function toast(msg, kind) {
    if (DEMO && kind !== 'err') msg = 'Демо-режим: зміни видно на екрані, але вони не зберігаються';
    var t = el('div', 'toast toast--' + (kind || 'ok'), msg);
    $('#toasts').appendChild(t);
    setTimeout(function () {
      t.style.transition = 'opacity .3s, transform .3s';
      t.style.opacity = '0'; t.style.transform = 'translateX(12px)';
      setTimeout(function () { t.remove(); }, 320);
    }, kind === 'err' ? 6000 : 3000);
  }

  function confirmDialog(title, text, okLabel) {
    return new Promise(function (resolve) {
      var scrim = el('div', 'scrim');
      var box = el('div', 'dialog');
      box.appendChild(el('h2', null, title));
      box.appendChild(el('p', null, text));
      var acts = el('div', 'dialog__actions');
      var no = el('button', 'btn btn--sm', 'Скасувати');
      var yes = el('button', 'btn btn--sm btn--danger', okLabel || 'Видалити');
      acts.appendChild(no); acts.appendChild(yes);
      box.appendChild(acts); scrim.appendChild(box); document.body.appendChild(scrim);
      yes.focus();
      var close = function (v) { scrim.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
      var onKey = function (e) { if (e.key === 'Escape') close(false); };
      no.onclick = function () { close(false); };
      yes.onclick = function () { close(true); };
      scrim.onclick = function (e) { if (e.target === scrim) close(false); };
      document.addEventListener('keydown', onKey);
    });
  }

  /* ---------- unsaved-changes bar ---------- */
  function setDirty(state) {
    dirty = state;
    var bar = $('#savebar');
    bar.classList.toggle('is-up', !!state);
    if (state) $('#savebarMsg').innerHTML = '<b>' + state.count + '</b>&nbsp;' + state.label;
  }
  $('#save').onclick = function () { if (dirty) dirty.save(); };
  $('#revert').onclick = function () { if (dirty) dirty.revert(); };
  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 's') { e.preventDefault(); if (dirty) dirty.save(); }
  });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  var plural = function (n, one, few, many) {
    var m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  };

  /* ============================================================
     RATES — the screen the cashier opens every morning
     ============================================================ */
  function viewRates(main) {
    var mine = ++renderSeq;
    main.innerHTML = '';
    api('GET', '/api/admin/rates').then(function (data) {
      if (stale(mine)) return;
      var edited = JSON.parse(JSON.stringify(data));

      var top = el('div', 'page-top');
      var left = el('div');
      left.appendChild(el('h1', null, 'Курси валют'));
      left.appendChild(el('p', null, DEMO
        ? 'У робочій панелі збережена зміна зʼявляється на сайті протягом кількох секунд — перезбірка не потрібна.'
        : 'Зміна зберігається одразу й зʼявляється на сайті протягом кількох секунд — перезбірка не потрібна.'));
      top.appendChild(left);
      var stamp = el('span', 'stamp');
      stamp.appendChild(el('i'));
      stamp.appendChild(el('span', null, 'Оновлено ' + whenText(data.updatedAt)));
      top.appendChild(stamp);
      main.appendChild(top);

      /* -- header fields -- */
      var head = el('div', 'panel');
      var hb = el('div', 'panel__body grid-2');
      hb.appendChild(labelled('Дата в заголовку сайту', inputFor('headline', data.headline, 'напр. 24 вересня'), 'Показується як «Актуальні курси на …».'));
      hb.appendChild(labelled('Оптовий курс діє від, у.о.', inputFor('wholesaleMin', data.wholesaleMin, '500'), 'Нижче цієї суми калькулятор рахує за роздрібним курсом.'));
      head.appendChild(hb);
      main.appendChild(head);

      function inputFor(key, value, ph) {
        var i = el('input', 'input input--mono');
        i.value = value; i.placeholder = ph || '';
        i.oninput = function () { edited[key] = key === 'wholesaleMin' ? i.value : i.value; mark(); };
        return i;
      }
      function labelled(k, node, hint) {
        var wrap = el('label', 'field');
        wrap.appendChild(el('span', 'field__k', k));
        wrap.appendChild(node);
        if (hint) wrap.appendChild(el('p', 'hint', hint));
        return wrap;
      }

      /* -- the table -- */
      var panel = el('div', 'panel');
      var ph = el('div', 'panel__head');
      var phl = el('div');
      phl.appendChild(el('h2', null, 'Курси'));
      phl.appendChild(el('p', null, 'Купівля — скільки ви платите клієнту. Продаж — скільки платить клієнт. Стрілки ↑↓ змінюють на 1 копійку.'));
      ph.appendChild(phl);
      panel.appendChild(ph);

      var heads = el('div', 'rates-head');
      heads.appendChild(el('span', null, 'Валюта'));
      heads.appendChild(el('span', 'grp', 'Оптовий (від ' + data.wholesaleMin + ' у.о.)'));
      heads.appendChild(el('span', 'grp', 'Роздрібний'));
      panel.appendChild(heads);
      var sub = el('div', 'rates-head');
      sub.appendChild(el('span', null, ''));
      ['Купівля', 'Продаж', 'Купівля', 'Продаж'].forEach(function (t) { sub.appendChild(el('span', null, t)); });
      sub.style.paddingBottom = '.5rem';
      panel.appendChild(sub);

      /* Show a rate the way the site prints it — two decimals unless the
         number carries more. Per-cent tiers keep their own shape. */
      function showRate(v, unit) {
        if (unit === '%') return String(v);
        var dec = (String(v).split('.')[1] || '').length;
        return Number(v).toFixed(Math.max(2, dec));
      }

      var cells = [];
      data.rows.forEach(function (row, idx) {
        var line = el('div', 'rate-line');
        var cur = el('div', 'rate-cur');
        var flag = el('span', 'rate-cur__flag', row.code.split(' ')[0]);
        cur.appendChild(flag);
        var names = el('span');
        names.appendChild(el('b', 'rate-cur__code', row.code));
        names.appendChild(el('span', 'rate-cur__label', row.label));
        cur.appendChild(names);
        line.appendChild(cur);

        ['w', 'r'].forEach(function (t) {
          ['buy', 'sell'].forEach(function (side) {
            var tier = row[t];
            var box = el('div', 'rate-in');
            box.setAttribute('data-k', (t === 'w' ? 'Опт' : 'Розд') + ' · ' + (side === 'buy' ? 'купівля' : 'продаж'));
            if (!tier) {
              var dash = el('input');
              dash.value = '—'; dash.disabled = true; dash.setAttribute('aria-label', 'не застосовується');
              box.appendChild(dash); line.appendChild(box); return;
            }
            var input = el('input');
            input.type = 'text';
            input.inputMode = 'decimal';
            input.value = showRate(tier[side], tier.unit);
            input.setAttribute('aria-label', row.code + ' ' + (t === 'w' ? 'оптовий' : 'роздрібний') + ' ' + (side === 'buy' ? 'купівля' : 'продаж'));
            if (tier.unit === '%') box.appendChild(el('span', 'rate-in__unit', '%'));
            box.appendChild(input);
            line.appendChild(box);

            var original = input.value;
            var cell = { input: input, box: box, idx: idx, t: t, side: side, original: original };
            cells.push(cell);

            input.oninput = function () {
              var n = parseFloat(input.value.replace(',', '.'));
              edited.rows[idx][t][side] = isFinite(n) ? n : input.value;
              box.classList.toggle('is-dirty', String(input.value) !== String(original));
              validate();
              mark();
            };
            input.onblur = function () {
              if (!NUMERIC.test(input.value.trim())) return;
              var n = parseFloat(input.value.replace(',', '.'));
              if (isFinite(n)) { input.value = showRate(n, tier.unit); input.oninput(); }
            };
            input.onkeydown = function (e) {
              if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
              e.preventDefault();
              var n = parseFloat(input.value.replace(',', '.'));
              if (!isFinite(n)) return;
              var step = tier.unit === '%' ? 0.1 : (Math.abs(n) < 1 ? 0.001 : 0.01);
              input.value = String(Math.round((n + (e.key === 'ArrowUp' ? step : -step)) * 1e4) / 1e4);
              input.oninput();
            };
          });
        });
        panel.appendChild(line);
      });

      var note = el('div', 'rate-note', 'Продаж не може бути меншим за купівлю — такий рядок підсвічується червоним і не збережеться.');
      panel.appendChild(note);
      main.appendChild(panel);

      /* Text that merely starts with digits is not a number: parseFloat
         would quietly turn "44.5.9" into 44.5 and save it. */
      var NUMERIC = /^-?\d{1,7}([.,]\d{1,4})?$/;

      function validate() {
        var bad = 0;
        data.rows.forEach(function (row, idx) {
          ['w', 'r'].forEach(function (t) {
            if (!row[t]) return;
            var pair = cells.filter(function (c) { return c.idx === idx && c.t === t; });
            var malformed = pair.filter(function (c) { return !NUMERIC.test(c.input.value.trim()); });
            malformed.forEach(function (c) { c.box.classList.add('is-bad'); });
            if (malformed.length) {
              pair.forEach(function (c) { if (malformed.indexOf(c) < 0) c.box.classList.remove('is-bad'); });
              bad += malformed.length;
              return;
            }
            var buy = parseFloat(String(edited.rows[idx][t].buy).replace(',', '.'));
            var sell = parseFloat(String(edited.rows[idx][t].sell).replace(',', '.'));
            var ok = isFinite(buy) && isFinite(sell) && sell >= buy;
            pair.forEach(function (c) { c.box.classList.toggle('is-bad', !ok); });
            if (!ok) bad++;
          });
        });
        $('#save').disabled = bad > 0;
        return bad === 0;
      }

      function mark() {
        var n = cells.filter(function (c) { return String(c.input.value) !== String(c.original); }).length;
        var fieldsChanged = String(edited.headline) !== String(data.headline)
          || String(edited.wholesaleMin) !== String(data.wholesaleMin);
        if (!n && !fieldsChanged) { setDirty(null); return; }
        setDirty({
          count: n || 1,
          label: n ? plural(n, 'курс змінено', 'курси змінено', 'курсів змінено') : 'поле змінено',
          save: function () {
            if (!validate()) { toast('Виправте підсвічені рядки', 'err'); return; }
            $('#save').disabled = true;
            api('PUT', '/api/admin/rates', edited).then(function (r) {
              setDirty(null);
              toast('Курси збережено — за кілька секунд зʼявляться на сайті');
              $('#save').disabled = false;
              viewRates(main);
              if (r.saved) stamp.lastChild.textContent = 'Оновлено щойно';
            }).catch(function (e) {
              $('#save').disabled = false;
              toast(e.message, 'err');
            });
          },
          revert: function () { setDirty(null); viewRates(main); },
        });
      }
    }).catch(fail(main));
  }

  function whenText(iso) {
    var d = new Date(iso);
    if (isNaN(d)) return '—';
    var mins = Math.round((Date.now() - d.getTime()) / 60000);
    if (mins < 1) return 'щойно';
    if (mins < 60) return mins + ' ' + plural(mins, 'хвилину', 'хвилини', 'хвилин') + ' тому';
    var hrs = Math.round(mins / 60);
    if (hrs < 24) return hrs + ' ' + plural(hrs, 'годину', 'години', 'годин') + ' тому';
    return d.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  }

  /* ============================================================
     POSTS
     ============================================================ */
  var TAGS = ['Курси', 'Валюти', 'Поради', 'Новини', 'Блог'];

  function viewPosts(main) {
    var mine = ++renderSeq;
    main.innerHTML = '';
    setDirty(null);
    api('GET', '/api/admin/posts').then(function (d) {
      if (stale(mine)) return;
      var top = el('div', 'page-top');
      var left = el('div');
      left.appendChild(el('h1', null, 'Новини'));
      left.appendChild(el('p', null, DEMO
        ? 'Статті блогу. У робочій панелі після збереження сайт перезбирається автоматично.'
        : 'Статті блогу. Після збереження сайт перезбирається автоматично — зміна зʼявиться приблизно за хвилину.'));
      top.appendChild(left);
      var add = el('button', 'btn btn--primary', 'Нова стаття');
      add.onclick = function () { editPost(main, null); };
      top.appendChild(add);
      main.appendChild(top);

      var panel = el('div', 'panel');
      var rows = el('div', 'rows');
      if (!d.posts.length) {
        rows.appendChild(el('div', 'row-item muted', 'Ще немає жодної статті.'));
      }
      d.posts.forEach(function (p) {
        var item = el('div', 'row-item');
        var m = el('div', 'row-item__main');
        m.appendChild(el('b', null, p.title || p.slug));
        m.appendChild(el('span', null, (p.date || '') + ' · ' + (p.tag || '—') + ' · /blog/' + p.slug));
        item.appendChild(m);
        item.appendChild(el('span', 'pill ' + (p.draft ? 'pill--draft' : 'pill--live'), p.draft ? 'Чернетка' : 'На сайті'));
        var acts = el('div', 'row-item__actions');
        var edit = el('button', 'btn btn--sm', 'Редагувати');
        edit.onclick = function () { editPost(main, p.slug); };
        var del = el('button', 'btn btn--sm btn--danger', 'Видалити');
        del.onclick = function () {
          confirmDialog('Видалити статтю?', '«' + (p.title || p.slug) + '» зникне з сайту. Дію не можна скасувати.').then(function (yes) {
            if (!yes) return;
            api('DELETE', '/api/admin/posts/' + p.slug)
              .then(function () { toast('Статтю видалено'); viewPosts(main); })
              .catch(function (e) { toast(e.message, 'err'); });
          });
        };
        acts.appendChild(edit); acts.appendChild(del);
        item.appendChild(acts);
        rows.appendChild(item);
      });
      panel.appendChild(rows);
      main.appendChild(panel);
    }).catch(fail(main));
  }

  function slugify(s) {
    var map = { а:'a',б:'b',в:'v',г:'h',ґ:'g',д:'d',е:'e',є:'ie',ж:'zh',з:'z',и:'y',і:'i',ї:'i',й:'i',к:'k',л:'l',м:'m',
                н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'kh',ц:'ts',ч:'ch',ш:'sh',щ:'shch',ь:'',ю:'iu',я:'ia',"'":'' };
    return String(s).toLowerCase().split('').map(function (c) { return map[c] !== undefined ? map[c] : c; }).join('')
      .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 70);
  }

  function editPost(main, slug) {
    var mine = ++renderSeq;
    main.innerHTML = '';
    var loading = slug
      ? api('GET', '/api/admin/posts/' + slug)
      : Promise.resolve({ title: '', date: new Date().toISOString().slice(0, 10), tag: 'Курси',
                          image: '', imageAlt: '', excerpt: '', draft: true, body: '' });

    Promise.all([loading, api('GET', '/api/admin/images')]).then(function (res) {
      if (stale(mine)) return;
      var post = res[0], images = res[1].images;
      var state = JSON.parse(JSON.stringify(post));
      var nextSlug = slug || '';

      var top = el('div', 'page-top');
      var left = el('div');
      left.appendChild(el('h1', null, slug ? 'Редагування статті' : 'Нова стаття'));
      left.appendChild(el('p', null, slug ? '/blog/' + slug : 'Адреса складеться із заголовка.'));
      top.appendChild(left);
      var back = el('button', 'btn', '← До списку');
      back.onclick = function () {
        if (!dirty) return viewPosts(main);
        confirmDialog('Вийти без збереження?', 'Незбережені зміни зникнуть.', 'Вийти').then(function (y) { if (y) { setDirty(null); viewPosts(main); } });
      };
      top.appendChild(back);
      main.appendChild(top);

      var panel = el('div', 'panel');
      var body = el('div', 'panel__body stack');

      body.appendChild(field('Заголовок', 'title', 'input', 'Про що стаття'));
      var meta = el('div', 'grid-2');
      meta.appendChild(field('Дата', 'date', 'date'));
      meta.appendChild(field('Рубрика', 'tag', 'select'));
      body.appendChild(meta);
      body.appendChild(field('Анонс', 'excerpt', 'textarea', 'Одне-два речення — показуються на картці й у соцмережах'));

      /* image picker */
      var imgWrap = el('div', 'field');
      imgWrap.appendChild(el('span', 'field__k', 'Обкладинка'));
      var grid = el('div', 'imgs');
      var none = el('button', '', '');
      none.type = 'button';
      none.style.display = 'grid'; none.style.placeItems = 'center'; none.style.fontSize = '.8rem';
      none.textContent = 'Без';
      none.onclick = function () { state.image = ''; paintImgs(); markPost(); };
      grid.appendChild(none);
      images.forEach(function (src) {
        var b = el('button'); b.type = 'button';
        var im = el('img'); im.src = '/' + src; im.alt = src; im.loading = 'lazy';
        b.appendChild(im);
        b.onclick = function () { state.image = src; paintImgs(); markPost(); };
        b.dataset.src = src;
        grid.appendChild(b);
      });
      function paintImgs() {
        none.classList.toggle('is-on', !state.image);
        [].forEach.call(grid.querySelectorAll('button[data-src]'), function (b) {
          b.classList.toggle('is-on', b.dataset.src === state.image);
        });
      }
      paintImgs();
      imgWrap.appendChild(grid);
      imgWrap.appendChild(el('p', 'hint', 'Файли беруться з теки images/. Щоб додати нову картинку, покладіть її туди на сервері.'));
      body.appendChild(imgWrap);
      body.appendChild(field('Опис зображення', 'imageAlt', 'input', 'Що зображено — для пошуку і читалок'));

      body.appendChild(field('Текст статті', 'body', 'textarea',
        '## Підзаголовок\n\nАбзац тексту з **жирним** і [посиланням](/#exchange).\n\n- пункт списку'));
      var hint = el('p', 'hint', '## підзаголовок · **жирний** · *курсив* · - список · > цитата · [текст](адреса). Порожній рядок розділяє абзаци.');
      body.appendChild(hint);

      var draftWrap = el('label', 'field');
      draftWrap.style.display = 'flex'; draftWrap.style.alignItems = 'center'; draftWrap.style.gap = '.7rem';
      var cb = el('input'); cb.type = 'checkbox'; cb.checked = !!state.draft;
      cb.style.width = '20px'; cb.style.height = '20px'; cb.style.accentColor = '#cca377';
      cb.onchange = function () { state.draft = cb.checked; markPost(); };
      draftWrap.appendChild(cb);
      draftWrap.appendChild(el('span', null, 'Чернетка — не показувати на сайті'));
      body.appendChild(draftWrap);

      panel.appendChild(body);
      main.appendChild(panel);

      function field(label, key, kind, ph) {
        var wrap = el('label', 'field');
        wrap.appendChild(el('span', 'field__k', label));
        var input;
        if (kind === 'textarea') {
          input = el('textarea', 'input');
          if (key === 'body') input.style.minHeight = '22rem';
          input.placeholder = ph || '';
        } else if (kind === 'select') {
          input = el('select', 'input');
          TAGS.forEach(function (t) {
            var o = el('option', null, t); o.value = t;
            if (t === state.tag) o.selected = true;
            input.appendChild(o);
          });
        } else {
          input = el('input', 'input');
          input.type = kind === 'date' ? 'date' : 'text';
          input.placeholder = ph || '';
        }
        input.value = state[key] || '';
        var handler = function () { state[key] = input.value; markPost(); };
        input.oninput = handler; input.onchange = handler;
        wrap.appendChild(input);
        return wrap;
      }

      function markPost() {
        var changed = JSON.stringify(state) !== JSON.stringify(post);
        if (!changed) return setDirty(null);
        setDirty({
          count: 1, label: 'стаття змінена',
          save: function () {
            var target = slug || slugify(state.title);
            if (!target) { toast('Спершу введіть заголовок', 'err'); return; }
            api('PUT', '/api/admin/posts/' + target, state).then(function () {
              setDirty(null);
              toast(slug ? 'Статтю збережено' : 'Статтю створено');
              viewPosts(main);
            }).catch(function (e) { toast(e.message, 'err'); });
          },
          revert: function () { setDirty(null); editPost(main, slug); },
        });
      }
    }).catch(fail(main));
  }

  /* ============================================================
     BRANCHES
     ============================================================ */
  function viewBranches(main) {
    var mine = ++renderSeq;
    main.innerHTML = '';
    setDirty(null);
    api('GET', '/api/admin/branches').then(function (data) {
      if (stale(mine)) return;
      var state = JSON.parse(JSON.stringify(data));

      var top = el('div', 'page-top');
      var left = el('div');
      left.appendChild(el('h1', null, 'Відділення'));
      left.appendChild(el('p', null, 'Адреси, телефони й графік. Перше відділення у списку показується першим скрізь на сайті, і його перший номер стає головним у шапці.'));
      top.appendChild(left);
      main.appendChild(top);

      var host = el('div');
      main.appendChild(host);
      paint();

      function paint() {
        host.innerHTML = '';
        state.branches.forEach(function (b, i) {
          var panel = el('div', 'panel');
          var head = el('div', 'panel__head');
          var hl = el('div');
          hl.appendChild(el('h2', null, b.addr || 'Нове відділення'));
          hl.appendChild(el('p', null, i === 0 ? 'Головне — показується першим' : 'Позиція ' + (i + 1)));
          head.appendChild(hl);
          var acts = el('div', 'row-item__actions');
          if (i > 0) acts.appendChild(iconBtn('↑', 'Вище', function () { swap(i, i - 1); }));
          if (i < state.branches.length - 1) acts.appendChild(iconBtn('↓', 'Нижче', function () { swap(i, i + 1); }));
          head.appendChild(acts);
          panel.appendChild(head);

          var body = el('div', 'panel__body stack');
          var g = el('div', 'grid-2');
          g.appendChild(txt('Адреса', b, 'addr', 'вул. Лепкого, 14'));
          g.appendChild(txt('Підпис-бейдж', b, 'badge', 'Без вихідних'));
          body.appendChild(g);

          body.appendChild(listEditor('Телефони', b.phones, function (p, j) {
            var row = el('div', 'grid-2');
            row.appendChild(txt('Номер (+380…)', p, 'tel', '+380676781337'));
            row.appendChild(txt('Як показувати', p, 'text', '(067) 67-81-337'));
            return row;
          }, function () { return { tel: '+380', text: '' }; }, b.phones, 4));

          body.appendChild(linesEditor('Графік роботи', b, 'hours'));
          var g2 = el('div', 'grid-2');
          g2.appendChild(txt('Примітка до графіку', b, 'hoursMuted', 'Нд — вихідний'));
          g2.appendChild(txt('Графік одним рядком', b, 'hoursShort', 'Пн–Пт 9:00–18:30 · Сб 9:00–17:30'));
          body.appendChild(g2);
          panel.appendChild(body);
          host.appendChild(panel);
        });
      }

      function swap(a, b) {
        var t = state.branches[a]; state.branches[a] = state.branches[b]; state.branches[b] = t;
        paint(); mark();
      }
      function iconBtn(glyph, title, fn) {
        var b = el('button', 'btn btn--icon', glyph);
        b.type = 'button'; b.title = title; b.setAttribute('aria-label', title);
        b.onclick = fn;
        return b;
      }
      function txt(label, obj, key, ph) {
        var wrap = el('label', 'field');
        wrap.appendChild(el('span', 'field__k', label));
        var i = el('input', 'input');
        i.value = obj[key] || ''; i.placeholder = ph || '';
        i.oninput = function () { obj[key] = i.value; mark(); };
        wrap.appendChild(i);
        return wrap;
      }
      function linesEditor(label, obj, key) {
        var wrap = el('div', 'field');
        wrap.appendChild(el('span', 'field__k', label));
        obj[key].forEach(function (line, j) {
          var row = el('div');
          row.style.display = 'flex'; row.style.gap = '.5rem'; row.style.marginBottom = '.5rem';
          var i = el('input', 'input');
          i.value = line;
          i.oninput = function () { obj[key][j] = i.value; mark(); };
          row.appendChild(i);
          if (obj[key].length > 1) {
            row.appendChild(iconBtn('✕', 'Прибрати рядок', function () { obj[key].splice(j, 1); paint(); mark(); }));
          }
          wrap.appendChild(row);
        });
        if (obj[key].length < 4) {
          var add = el('button', 'btn btn--sm', '+ Рядок');
          add.type = 'button';
          add.onclick = function () { obj[key].push(''); paint(); mark(); };
          wrap.appendChild(add);
        }
        return wrap;
      }
      function listEditor(label, list, render, make, owner, max) {
        var wrap = el('div', 'field');
        wrap.appendChild(el('span', 'field__k', label));
        list.forEach(function (item, j) {
          var row = el('div');
          row.style.display = 'flex'; row.style.gap = '.5rem'; row.style.alignItems = 'flex-end'; row.style.marginBottom = '.6rem';
          var inner = render(item, j);
          inner.style.flex = '1';
          row.appendChild(inner);
          if (list.length > 1) row.appendChild(iconBtn('✕', 'Прибрати', function () { list.splice(j, 1); paint(); mark(); }));
          wrap.appendChild(row);
        });
        if (list.length < max) {
          var add = el('button', 'btn btn--sm', '+ Телефон');
          add.type = 'button';
          add.onclick = function () { list.push(make()); paint(); mark(); };
          wrap.appendChild(add);
        }
        return wrap;
      }
      function mark() {
        if (JSON.stringify(state) === JSON.stringify(data)) return setDirty(null);
        setDirty({
          count: 1, label: 'зміна у відділеннях',
          save: function () {
            api('PUT', '/api/admin/branches', state).then(function () {
              setDirty(null);
              toast('Збережено. Сайт перезбирається — зміна зʼявиться за хвилину.');
              viewBranches(main);
            }).catch(function (e) { toast(e.message, 'err'); });
          },
          revert: function () { setDirty(null); viewBranches(main); },
        });
      }
    }).catch(fail(main));
  }

  /* ============================================================
     TEXTS
     ============================================================ */
  /* Each block says where it lives on the site, so the client can jump
     straight to it and see the real thing next to the fields. */
  var TEXT_GROUPS = [
    { title: 'Перший екран', pre: 'hero.', at: '#top',
      note: 'Найперше, що бачить відвідувач: плашка, великий заголовок і опис під ним.' },
    { title: 'Курси валют', pre: 'rates.', at: '#rates',
      note: 'Шапка таблиці курсів і дві примітки під нею про стан купюр.' },
    { title: 'Послуги', pre: 'services.', at: '#services',
      note: 'Заголовок розділу з доставкою, пошкодженими банкнотами та монетами.' },
    { title: 'Перевірка готівки', pre: 'check.', at: '#services',
      note: 'Широка картка в «Послугах» про безкоштовну перевірку купюр.' },
    { title: 'Не тільки валюта', pre: 'extra.', at: '#services',
      note: 'Картка про паливні талони та злитки — одразу під перевіркою готівки.' },
    { title: 'Переваги', pre: 'benefits.', at: '#benefits',
      note: 'Заголовок блоку з фіксацією курсу, комісією та часом обслуговування.' },
    { title: 'Відділення', pre: 'branches.', at: '#branches',
      note: 'Шапка розділу з трьома відділеннями. Самі адреси — у розділі «Відділення».' },
    { title: 'Безпека', pre: 'security.', at: '#security',
      note: 'Заголовок блоку про захист даних і перевірку купюр.' },
    { title: 'Новини', pre: 'news.', at: '#news',
      note: 'Шапка блоку новин на головній. Самі статті — у розділі «Новини».' },
    { title: 'Підвал сайту', pre: 'footer.', at: '#contacts',
      note: 'Опис компанії та два рядки внизу кожної сторінки.' },
  ];
  var TEXT_LABELS = {
    badge: 'Плашка над заголовком', line1: 'Заголовок, перший рядок', line2: 'Заголовок, другий рядок (золотий)',
    lede: 'Опис під заголовком', eyebrow: 'Надпис над заголовком', heading: 'Заголовок',
    note1: 'Примітка, перший абзац', note2: 'Примітка, другий абзац',
    title: 'Заголовок картки', lead: 'Текст картки',
    about: 'Опис компанії', legal: 'Копірайт', meta: 'Правий напис',
  };

  /* The preview mirrors how the block is built on the page: a small mono
     label, a heading where **word** turns gold, then body copy. It is
     rebuilt from the fields on every keystroke, so what the client reads
     here is what the site will show. */
  var ROLE = {
    eyebrow: 'label', badge: 'label',
    heading: 'head', line1: 'head', line2: 'head-accent', title: 'head',
    lede: 'body', lead: 'body', note1: 'body', note2: 'body',
    about: 'body', legal: 'small', meta: 'small',
  };

  var headlineNow = '';   /* the date the build drops into {headline} */

  function renderPreview(box, group, state) {
    box.innerHTML = '';
    var keys = Object.keys(state).filter(function (k) { return k.indexOf(group.pre) === 0; });
    keys.forEach(function (key) {
      var short = key.split('.')[1];
      var role = ROLE[short] || 'body';
      var value = String(state[key] || '').replace('{headline}', headlineNow);
      if (!value.trim()) return;
      if (role === 'label') { box.appendChild(el('span', 'tprev__label', value)); return; }
      if (role === 'small') { box.appendChild(el('p', 'tprev__small', value)); return; }
      if (role === 'body')  { box.appendChild(richLine(el('p', 'tprev__body'), value)); return; }

      var h = el('p', 'tprev__head');
      if (role === 'head-accent') h.className += ' accent';
      value.split('\n').forEach(function (line, i) {
        if (i) h.appendChild(document.createElement('br'));
        accentInto(h, line);
      });
      box.appendChild(h);
    });
    if (!box.children.length) box.appendChild(el('p', 'tprev__body muted', 'Поля порожні'));
  }

  /* **word** becomes gold; everything else stays text, never markup */
  function accentInto(node, line) {
    var re = /\*\*(.+?)\*\*/g, last = 0, m;
    while ((m = re.exec(line))) {
      if (m.index > last) node.appendChild(document.createTextNode(line.slice(last, m.index)));
      node.appendChild(el('span', 'accent', m[1]));
      last = re.lastIndex;
    }
    if (last < line.length) node.appendChild(document.createTextNode(line.slice(last)));
  }
  function richLine(node, value) {
    value.split('\n').forEach(function (line, i) {
      if (i) node.appendChild(document.createElement('br'));
      var re = /\*\*(.+?)\*\*/g, last = 0, m;
      while ((m = re.exec(line))) {
        if (m.index > last) node.appendChild(document.createTextNode(line.slice(last, m.index)));
        node.appendChild(el('b', null, m[1]));
        last = re.lastIndex;
      }
      if (last < line.length) node.appendChild(document.createTextNode(line.slice(last)));
    });
    return node;
  }

  function viewTexts(main) {
    var mine = ++renderSeq;
    main.innerHTML = '';
    setDirty(null);
    Promise.all([api('GET', '/api/admin/texts'), api('GET', '/api/admin/rates')]).then(function (res) {
      if (stale(mine)) return;
      var data = res[0];
      headlineNow = (res[1] && res[1].headline) || '';
      var state = JSON.parse(JSON.stringify(data));

      var top = el('div', 'page-top');
      var left = el('div');
      left.appendChild(el('h1', null, 'Тексти сайту'));
      left.appendChild(el('p', null, 'Оберіть блок ліворуч — побачите, де він на сайті та як виглядатиме після правки. У заголовках новий рядок означає перенос, а слово в **двох зірочках** стає золотим.'));
      top.appendChild(left);
      main.appendChild(top);

      var layout = el('div', 'texts');
      var nav = el('nav', 'texts__nav');
      nav.setAttribute('aria-label', 'Блоки сайту');
      var cols = el('div', 'texts__cols');
      layout.appendChild(nav);
      layout.appendChild(cols);
      main.appendChild(layout);

      var panels = [];
      TEXT_GROUPS.forEach(function (group, gi) {
        var keys = Object.keys(data).filter(function (k) { return k.indexOf(group.pre) === 0; });
        if (!keys.length) return;

        var link = el('button', 'texts__link', group.title);
        link.type = 'button';
        link.onclick = function () { show(gi); };
        nav.appendChild(link);

        var panel = el('div', 'panel');
        panel.hidden = true;
        var head = el('div', 'panel__head');
        var hl = el('div');
        hl.appendChild(el('h2', null, group.title));
        hl.appendChild(el('p', null, group.note));
        head.appendChild(hl);
        var open = el('a', 'btn btn--sm', 'Подивитись на сайті');
        open.href = '/' + group.at;
        open.target = '_blank';
        open.rel = 'noopener';
        head.appendChild(open);
        panel.appendChild(head);

        /* fields on the left, the preview pinned on the right, so it stays
           in view while the client works down the form */
        var split = el('div', 'panel__split');
        var prevWrap = el('aside', 'tprev');
        prevWrap.appendChild(el('span', 'tprev__tag', 'Так це виглядатиме на сайті'));
        var prevBox = el('div', 'tprev__body-box');
        prevWrap.appendChild(prevBox);

        var body = el('div', 'panel__body stack');
        keys.forEach(function (key) {
          var short = key.split('.')[1];
          var wrap = el('label', 'field');
          wrap.appendChild(el('span', 'field__k', TEXT_LABELS[short] || short));
          var long = String(data[key]).length > 90 || key.indexOf('heading') >= 0 || short === 'lede';
          var input = el(long ? 'textarea' : 'input', 'input');
          input.value = data[key];
          if (long) input.rows = Math.min(6, Math.ceil(String(data[key]).length / 70) + 1);
          input.oninput = function () {
            state[key] = input.value;
            renderPreview(prevBox, group, state);
            mark();
          };
          wrap.appendChild(input);
          if (String(data[key]).indexOf('{headline}') >= 0) {
            wrap.appendChild(el('p', 'hint', '{headline} сюди підставляється дата з розділу «Курси валют» — зараз «' + headlineNow + '». Лишіть це слово на місці, щоб дата оновлювалась сама.'));
          }
          body.appendChild(wrap);
        });
        split.appendChild(body);
        split.appendChild(prevWrap);
        panel.appendChild(split);
        panel.className = 'panel panel--split';
        cols.appendChild(panel);
        renderPreview(prevBox, group, state);
        panels.push({ link: link, panel: panel });
      });

      function show(i) {
        panels.forEach(function (x, j) {
          x.panel.hidden = j !== i;
          x.link.classList.toggle('is-on', j === i);
        });
        try { history.replaceState(null, '', '#texts/' + i); } catch (e) {}
      }
      var want = /^#texts\/(\d+)$/.exec(location.hash);
      show(want && panels[+want[1]] ? +want[1] : 0);

      function mark() {
        var n = Object.keys(state).filter(function (k) { return state[k] !== data[k]; }).length;
        if (!n) return setDirty(null);
        setDirty({
          count: n, label: plural(n, 'текст змінено', 'тексти змінено', 'текстів змінено'),
          save: function () {
            api('PUT', '/api/admin/texts', state).then(function () {
              setDirty(null);
              toast('Збережено. Сайт перезбирається — зміна зʼявиться за хвилину.');
              viewTexts(main);
            }).catch(function (e) { toast(e.message, 'err'); });
          },
          revert: function () { setDirty(null); viewTexts(main); },
        });
      }
    }).catch(fail(main));
  }

  /* ============================================================
     shell
     ============================================================ */
  function fail(main) {
    return function (e) {
      if (e && e.message === 'auth') return;
      main.innerHTML = '';
      var p = el('div', 'panel');
      var b = el('div', 'panel__body');
      b.appendChild(el('h2', null, 'Не вдалося завантажити'));
      b.appendChild(el('p', 'hint', (e && e.message) || 'Невідома помилка'));
      p.appendChild(b); main.appendChild(p);
    };
  }

  var VIEWS = { rates: viewRates, posts: viewPosts, branches: viewBranches, texts: viewTexts };

  function go(name) {
    var run = function () {
      [].forEach.call(document.querySelectorAll('.rail .nav[data-view]'), function (b) {
        b.classList.toggle('is-active', b.dataset.view === name);
      });
      $('#rail').classList.remove('is-open');
      setDirty(null);
      VIEWS[name]($('#main'));
      try { history.replaceState(null, '', '#' + name); } catch (e) {}
    };
    if (!dirty) return run();
    confirmDialog('Вийти без збереження?', 'Незбережені зміни зникнуть.', 'Вийти').then(function (y) { if (y) run(); });
  }

  [].forEach.call(document.querySelectorAll('.rail .nav[data-view]'), function (b) {
    b.onclick = function () { go(b.dataset.view); };
  });
  $('#burger').onclick = function () { $('#rail').classList.toggle('is-open'); };
  $('#logout').onclick = function () {
    if (DEMO) return showLogin('Ви вийшли');
    api('POST', '/api/logout').then(function () { CSRF = null; showLogin('Ви вийшли'); });
  };

  /* ---------- auth ---------- */
  function showLogin(msg) {
    setDirty(null);
    $('#app').hidden = true;
    $('#burger').hidden = true;
    $('#login').hidden = false;
    if (msg) { var e = $('#loginErr'); e.textContent = msg; e.hidden = false; e.style.color = 'var(--text-dim)'; }
    setTimeout(function () { $('#pw').focus(); }, 50);
  }
  function showApp() {
    $('#login').hidden = true;
    $('#app').hidden = false;
    $('#burger').hidden = false;
    var start = (location.hash || '').replace('#', '');
    go(VIEWS[start] ? start : 'rates');
  }

  $('#loginForm').onsubmit = function (e) {
    e.preventDefault();
    var btn = $('#loginBtn'), err = $('#loginErr');
    if (DEMO) {
      if ($('#pw').value.trim() !== DEMO_PASS) {
        err.textContent = 'Невірний пароль'; err.style.color = 'var(--err)'; err.hidden = false;
        $('#pw').select();
        return;
      }
      $('#pw').value = ''; err.hidden = true; showApp();
      return;
    }
    btn.disabled = true; btn.textContent = 'Перевіряємо…';
    fetch('/api/login', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: $('#pw').value }),
    }).then(function (r) { return r.json().then(function (d) { return { ok: r.ok, d: d }; }); })
      .then(function (res) {
        btn.disabled = false; btn.textContent = 'Увійти';
        if (!res.ok) {
          err.textContent = res.d.error || 'Не вдалося увійти';
          err.style.color = 'var(--err)'; err.hidden = false;
          $('#pw').select();
          return;
        }
        CSRF = res.d.csrf;
        $('#pw').value = '';
        err.hidden = true;
        showApp();
      })
      .catch(function () {
        btn.disabled = false; btn.textContent = 'Увійти';
        err.textContent = 'Сервер недоступний'; err.style.color = 'var(--err)'; err.hidden = false;
      });
  };

  function startDemo() {
    return fetch('/assets/demo.json', { cache: 'no-store' })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (!d) { showLogin('Сервер недоступний'); return; }
        DEMO = true;
        snap = d;
        document.body.classList.add('is-demo');
        $('#demoNote').hidden = false;
        $('#loginDemo').hidden = false;
        $('#demoPass').textContent = DEMO_PASS;
        showLogin();
      })
      .catch(function () { showLogin('Сервер недоступний'); });
  }

  fetch('/api/me', { credentials: 'same-origin' })
    .then(function (r) {
      if (!r.ok) throw new Error('no api');
      return r.json();
    })
    .then(function (d) { if (d.authed) { CSRF = d.csrf; showApp(); } else showLogin(); })
    .catch(startDemo);
})();
