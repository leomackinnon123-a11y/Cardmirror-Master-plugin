// CC (CardCutter) - CardMirror plugin (API v1, draft surface)
// Commands: CC C1 (URL), CC C2 (Full Cut), CC E (Evidence Finder), plus CC: settings commands
(function () {
  'use strict';
  const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);

  let lastEditor = null;
  document.addEventListener('focusin', (e) => {
    const p = e.target && e.target.closest && e.target.closest('.ProseMirror');
    if (p) lastEditor = p;
  }, true);

  const PUBS = {
    'nytimes.com': 'The New York Times', 'washingtonpost.com': 'The Washington Post',
    'wsj.com': 'The Wall Street Journal', 'reuters.com': 'Reuters', 'apnews.com': 'Associated Press',
    'bbc.com': 'BBC', 'bbc.co.uk': 'BBC', 'theguardian.com': 'The Guardian', 'politico.com': 'Politico',
    'bloomberg.com': 'Bloomberg', 'cnn.com': 'CNN', 'npr.org': 'NPR', 'theatlantic.com': 'The Atlantic',
    'forbes.com': 'Forbes', 'foreignaffairs.com': 'Foreign Affairs', 'foreignpolicy.com': 'Foreign Policy',
    'economist.com': 'The Economist', 'ft.com': 'Financial Times', 'newyorker.com': 'The New Yorker',
    'brookings.edu': 'Brookings Institution', 'vox.com': 'Vox', 'axios.com': 'Axios',
    'thehill.com': 'The Hill', 'nbcnews.com': 'NBC News', 'cnbc.com': 'CNBC', 'time.com': 'TIME',
    'usatoday.com': 'USA Today', 'latimes.com': 'Los Angeles Times', 'foxnews.com': 'Fox News',
  };

  const DEFAULTS = { 'quals-placeholder': 'QUALS', 'fallback-quals': 'Use placeholder', 'fetch-prefix': '',
    'ollama-model': 'llama3.2', 'ai-mode': 'When rules fail', 'ollama-url': 'http://localhost:11434',
    'web-lookup': 'On', 'cite-style': 'On', 'cite-key': 'F8', 'date-format': 'M/D/YYYY' };
  const cfg = (api, k) => { const v = api.storage.get(k); return (v === undefined || v === null) ? DEFAULTS[k] : v; };

  // ================= names =================
  const SUFFIX = /^(jr|sr|ii|iii|iv|phd|md|esq)\.?,?$/i;
  const PARTICLE = /^(van|von|de|del|della|der|den|di|da|la|le|bin|al|el)$/i;
  const NOT_NAME = /\b(staff|editors?|newsroom|team|desk|contributors?|press|wire|reporters?|writers?|associated|bureau|board|admin|editorial|service|network|news|inc|llc|times|post|journal|magazine|correspondent|columnist|analyst|fellow|professor|director|chief|senior|political|economics|updated|published)\b/i;

  function splitName(n) {
    const t = n.split(/\s+/).filter(Boolean).filter((x) => !SUFFIX.test(x));
    if (t.length < 2) return { first: '', last: t[0] || '' };
    let i = t.length - 1;
    while (i > 1 && PARTICLE.test(t[i - 1])) i--;
    return { first: t[0], last: t.slice(i).join(' ') };
  }
  function validName(n) {
    if (!n || n.length > 45 || /[\d@]|https?:/.test(n) || NOT_NAME.test(n)) return false;
    const t = n.split(/\s+/);
    return t.length >= 2 && t.length <= 5 &&
      t.every((x) => /^[\p{Lu}][\p{L}'’.\-]*,?$/u.test(x) || PARTICLE.test(x));
  }
  const titleIfUpper = (n) => (n === n.toUpperCase()
    ? n.toLowerCase().split(/\s+/).map((w, i) => (i > 0 && PARTICLE.test(w) ? w
        : w.replace(/(^|[-'’])(\p{L})/gu, (m, a, b) => a + b.toUpperCase()))).join(' ')
    : n);
  function parseNames(raw) {
    const s = clean(raw).replace(/\b(updated|published|posted)\b.*$/i, '')
      .replace(/^(by|written by|words by|story by|posted by)\s+/i, '').replace(/\S+@\S+/g, '');
    return s.split(/\s*(?:\band\b|&|;|\||\/|·|•|,|\bwith\b)\s*/i).map(clean).filter(validName).map(titleIfUpper);
  }

  function nameFromHandle(h) {
    const parts = h.replace(/^@/, '').replace(/\d+$/, '').split(/[_.\-]+|(?<=[a-z])(?=[A-Z])/).filter((x) => /^[A-Za-z]{2,}$/.test(x));
    if (parts.length < 2 || parts.length > 4) return '';
    return parts.map((x) => x[0].toUpperCase() + x.slice(1).toLowerCase()).join(' ');
  }
  function handleAuthor(doc, H) {
    const txt = clean(doc.body ? doc.body.innerHTML.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ') : '').slice(0, 300000);
    const m = txt.match(/follow me[^@]{0,40}@([A-Za-z0-9_.]{3,30})/i) || txt.match(/(?:written by|by|author)[^@.]{0,60}@([A-Za-z0-9_.]{3,30})/i);
    const cands = [m && m[1].replace(/[._]+$/, ''), clean(H.meta('twitter:creator')).replace(/^@/, '')];
    for (const c of cands) {
      const n = c && nameFromHandle(c);
      if (n && validName(n)) return { name: n, line: m && c === m[1] ? clean(m[0]) : '@' + c };
    }
    return { name: '', line: m ? clean(m[0]) : '' };
  }

  // ================= bios -> quals =================
  const TITLEISH = /\b(reporter|correspondent|editor|writer|fellow|professor|lecturer|director|analyst|columnist|journalist|author|chief|contributor|scholar|researcher|president|founder|ceo|economist|attorney|lawyer|historian|strategist|consultant|senior|associate|assistant|deputy|manager|host|anchor|producer|specialist|expert|advis[eo]r|partner|dean|chair|executive|officer|commissioner|senator|governor|secretary|minister|physician|doctor|scientist|engineer|staff|policy|politics|member|candidate)\b/i;

  function tidy(q) {
    q = clean(q)
      .replace(/\s+(?:and|who|where|whose|which)\s+(?:he|she|they|previously|formerly|was|has|had|is|also|his|her|their)\b.*$/i, '')
      .replace(/\s+(?:who|where|whose|which)\b.*$/i, '')
      .replace(/[.;:,]+$/, '');
    if (q.length > 140) q = q.slice(0, 140).replace(/\s+\S*$/, '');
    return cap(q);
  }
  function bioToQuals(text, name) {
    const t = clean(text).replace(/^(about|bio|biography)( the author)?:?\s*/i, '').slice(0, 700);
    if (!t) return '';
    const last = name ? splitName(name).last : '';
    const lastRe = last ? new RegExp('\\b' + esc(last) + '\\b', 'i') : null;
    const sents = t.split(/(?<=[.!?])\s+(?=[A-Z"“])/).slice(0, 4);
    for (const s of sents) {
      if (last) {
        const m = s.match(new RegExp(esc(last) + ',\\s+(?:an?|the)\\s+([^,]{5,140}),', 'i'));
        if (m && TITLEISH.test(m[1])) return tidy(m[1]);
      }
      if (lastRe ? (!lastRe.test(s) && !/^(He|She|They)\b/.test(s)) : !/^(He|She|They|[A-Z][\w'’.-]+\s+[A-Z])/.test(s)) continue;
      const m = s.match(/\b(?:is|was|serves as|has served as|has been|works as|currently serves as|joined\b.{0,60}?\bas)\s+(?:currently\s+)?(?:(?:an?|the)\s+)?(.{5,}?)\s*$/i);
      if (m && TITLEISH.test(m[1])) return tidy(m[1]);
    }
    if (t.length <= 140 && TITLEISH.test(t) && !/[.!?]\s+\S/.test(t)) return tidy(t);
    return '';
  }

  // ================= page helpers =================
  function makeHelpers(doc) {
    const q = (s) => doc.querySelector(s);
    const meta = (...names) => {
      for (const n of names) {
        const e = q(`meta[name="${n}"],meta[property="${n}"],meta[itemprop="${n}"]`);
        const v = e && clean(e.getAttribute('content'));
        if (v) return v;
      }
      return '';
    };
    const metaAll = (n) => [...doc.querySelectorAll(`meta[name="${n}"],meta[property="${n}"]`)]
      .map((e) => clean(e.getAttribute('content'))).filter(Boolean);
    return { q, meta, metaAll };
  }

  function readLd(doc) {
    const all = [];
    const flat = (o) => {
      if (Array.isArray(o)) o.forEach(flat);
      else if (o && typeof o === 'object') { all.push(o); if (o['@graph']) flat(o['@graph']); }
    };
    for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
      try { flat(JSON.parse(s.textContent)); } catch (e) {}
    }
    const byId = new Map();
    all.forEach((o) => { if (o['@id']) byId.set(o['@id'], o); });
    const resolve = (x) => {
      if (typeof x === 'string') return byId.get(x) || x;
      if (x && x['@id'] && byId.has(x['@id']) && Object.keys(x).length <= 2) return Object.assign({}, byId.get(x['@id']), x);
      return x;
    };
    const article = all.find((i) => /Article|Posting|Report|Review|Essay/i.test([].concat(i['@type'] || []).join(' '))) || null;
    const people = article
      ? [].concat(article.author || article.creator || []).flat().map(resolve)
          .filter((a) => a && typeof a === 'object' && !/Organization/i.test([].concat(a['@type'] || []).join(' ')))
      : [];
    const authorNames = article
      ? [].concat(article.author || article.creator || []).flat().map(resolve)
          .map((a) => (typeof a === 'string' ? a : a && a.name)).filter(Boolean)
      : [];
    return { all, article, people, authorNames, resolve };
  }
  const orgName = (x) => { const o = [].concat(x || [])[0]; return o ? clean(typeof o === 'string' ? o : o.name) : ''; };

  function getAuthors(doc, H, ld) {
    const { q, meta, metaAll } = H;
    const sources = [
      () => metaAll('citation_author').map((a) => (a.includes(',') ? a.split(',').map(clean).reverse().join(' ') : a)),
      () => ld.authorNames,
      () => ['author', 'article:author', 'parsely-author', 'dc.creator', 'sailthru.author', 'byl']
        .map((n) => meta(n)).filter((v) => v && !/^https?:/i.test(v)),
      () => [...doc.querySelectorAll('[rel="author"], [itemprop="author"] [itemprop="name"], [itemprop="author"], [class*="byline" i] a, [class*="byline" i], [data-testid*="byline" i], [class*="author-name" i], [class*="author" i] a')]
        .map((e) => clean(e.textContent)).filter((t) => t && t.length < 120),
    ];
    for (const src of sources) {
      const out = [];
      src().forEach((raw) => parseNames(raw).forEach((n) => {
        if (!out.some((o) => o.toLowerCase() === n.toLowerCase())) out.push(n);
      }));
      if (out.length) return out.slice(0, 6);
    }
    return [];
  }

  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  function parseDateStr(str) {
    str = String(str || '');
    const maxY = new Date().getFullYear() + 1;
    const ok = (y, m, d) => y >= 1900 && y <= maxY && m >= 1 && m <= 12 && d >= 1 && d <= 31;
    let m = str.match(/\b((?:19|20)\d{2})[-\/.](\d{1,2})[-\/.](\d{1,2})(?!\d)/);
    if (m && ok(+m[1], +m[2], +m[3])) return { y: +m[1], m: +m[2], d: +m[3] };
    m = str.match(/\b([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+((?:19|20)\d{2})\b/);
    if (m) { const mo = MONTHS.indexOf(m[1].slice(0, 3).toLowerCase()) + 1; if (mo && ok(+m[3], mo, +m[2])) return { y: +m[3], m: mo, d: +m[2] }; }
    m = str.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+((?:19|20)\d{2})\b/);
    if (m) { const mo = MONTHS.indexOf(m[2].slice(0, 3).toLowerCase()) + 1; if (mo && ok(+m[3], mo, +m[1])) return { y: +m[3], m: mo, d: +m[1] }; }
    m = str.match(/\b(\d{1,2})[\/.-](\d{1,2})[\/.-]((?:19|20)\d{2})\b/);
    if (m) {
      let mo = +m[1], d = +m[2];
      if (mo > 12) [mo, d] = [d, mo];
      if (ok(+m[3], mo, d)) return { y: +m[3], m: mo, d };
    }
    m = str.match(/\b(?:19|20)\d{2}\b/);
    if (m && +m[0] <= maxY) return { y: +m[0] };
    return null;
  }
  function getDate(doc, H, ld, url) {
    const timeEl = H.q('article time[datetime]') || H.q('time[datetime]');
    const cands = [
      H.meta('citation_publication_date', 'citation_date', 'dc.date.issued', 'dc.date', 'article:published_time',
        'og:article:published_time', 'datePublished', 'parsely-pub-date', 'sailthru.date', 'date'),
      ld.article && (ld.article.datePublished || ld.article.dateCreated),
      timeEl && timeEl.getAttribute('datetime'),
      ...[...doc.querySelectorAll('[class*="date" i], [class*="publish" i], [class*="timestamp" i], time')].slice(0, 8).map((e) => clean(e.textContent)),
      (url.match(/\/((?:19|20)\d{2})\/(\d{1,2})\/(\d{1,2})\//) || []).slice(1).join('-'),
      (url.match(/\/((?:19|20)\d{2})\/\d{1,2}\//) || [])[1],
      ld.article && ld.article.dateModified, H.meta('article:modified_time'),
    ];
    let yearOnly = null;
    for (const c of cands) {
      const d = parseDateStr(c);
      if (!d) continue;
      if (d.m) return d;
      if (!yearOnly) yearOnly = d;
    }
    return yearOnly;
  }
  function formatDate(d, fmt) {
    if (!d) return 'DATE';
    if (!d.m) return String(d.y);
    const names = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (fmt === 'Month D, YYYY') return `${names[d.m - 1]} ${d.d}, ${d.y}`;
    if (fmt === 'YYYY-MM-DD') return `${d.y}-${String(d.m).padStart(2, '0')}-${String(d.d).padStart(2, '0')}`;
    return `${d.m}/${d.d}/${d.y}`;
  }

  // ================= body extraction =================
  const BODY_SEL = ['[itemprop="articleBody"]', 'section[name="articleBody"]', '[data-testid="article-body"]',
    '[class*="article-body" i]', '[class*="articleBody" i]', '[class*="article__body" i]', '[class*="article-content" i]',
    '[class*="articleContent" i]', '[class*="story-body" i]', '[class*="story-content" i]', '[class*="post-content" i]',
    '[class*="post-body" i]', '[class*="entry-content" i]', '[class*="body-copy" i]', '.wysiwyg', '.rich-text'];
  const NOISE_TAGS = /^(NAV|FOOTER|ASIDE|FORM|SCRIPT|STYLE|NOSCRIPT|IFRAME|BUTTON|SVG|FIGURE|FIGCAPTION|SELECT|DIALOG|TEMPLATE|AUDIO|VIDEO|CANVAS)$/;
  const HARD = /(?:^|[\s_-])(?:ads?|advert\w*|promo\w*|related|recirc\w*|newsletter|subscribe\w*|signup|share|sharing|social|comments?|sidebar|trending|cookie\w*|outbrain|taboola|toolbar|byline|bio|breadcrumbs?|pagination|popup|modal|overlay|read-more|more-stories|morestories|up-next|upnext)(?:$|[\s_-])/i;
  const SOFT = /(?:^|[\s_-])(?:tags?|widget|banner|menu|nav|navbar|footer|paywall)(?:$|[\s_-])/i;
  const SHORT_BOILER = /^(advertisement|advertising|sponsored( content)?|read more|read next|continue reading|story continues( below advertisement)?|share( this)?( article| story| page)?|share on \w+|subscribe|sign up|log in|comments?|recommended|trending|most read|related( articles| stories| coverage)?|more from .*|up next|listen( to this article)?|print|email|copy link|save|follow us|follow me.*|@[\w.]+)[\s:.!]*$/i;
  const PREFIX_BOILER = /^(related( articles| stories| coverage| reading)?:|photo:|image:|credit:|©|copyright\b|all rights reserved|follow us\b|follow me\b|sign up for\b|subscribe to\b|support (our|independent) journalism|we use cookies|already a subscriber|watch:|read more:|read next:|click here\b)/i;
  const BYLINEISH = /^(?:(?:by|updated|published|posted)\s+(?:on\s+)?(?:[A-Z][a-z]+\.?\s+\d{1,2}|\d{1,2}[\/.-]|\w+day\b)|by\s+[A-Z][\w.'’-]+(?:\s+[A-Z][\w.'’-]+){0,3}\s*)/;
  const BLOCK = 'p,div,ul,ol,li,table,blockquote,section,article,h1,h2,h3,h4,h5,h6,pre,figure,aside,nav,header,footer,main,form,dl,dd,dt';

  function linkDensity(el) {
    const full = clean(el.textContent);
    if (!full) return 1;
    return [...el.querySelectorAll('a')].reduce((a, x) => a + clean(x.textContent).length, 0) / full.length;
  }
  function isNoise(el, strict) {
    if (NOISE_TAGS.test(el.tagName)) return true;
    if (el.hidden || el.getAttribute('aria-hidden') === 'true') return true;
    const role = el.getAttribute('role');
    if (role && /^(navigation|complementary|banner|contentinfo|dialog|alert|search)$/.test(role)) return true;
    if (/display\s*:\s*none/.test(el.getAttribute('style') || '')) return true;
    if (!strict) return false;
    const id = (el.id || '') + ' ' + (el.getAttribute('class') || '');
    if (HARD.test(id)) return true;
    if (SOFT.test(id)) return clean(el.textContent).length < 400 || linkDensity(el) > 0.3;
    return false;
  }
  const keepLine = (t) => t.length >= 2 &&
    !(t.length <= 60 && SHORT_BOILER.test(t)) && !(t.length <= 200 && PREFIX_BOILER.test(t)) &&
    !(t.length < 90 && BYLINEISH.test(t));
  function paraTexts(n) {
    const full = clean(n.textContent);
    if (!full) return [];
    if (linkDensity(n) > 0.6 && full.length < 200) return [];
    const c = n.cloneNode(true);
    c.querySelectorAll('sup, script, style, button, svg, noscript').forEach((x) => x.remove());
    c.querySelectorAll('br').forEach((b) => b.replaceWith('\n'));
    const heading = /^H[2-6]$/.test(n.tagName);
    return c.textContent.split(/\n+/).map(clean).filter((t) => keepLine(t) && !(heading && t.length > 140));
  }
  function paragraphsOf(root, strict) {
    const out = [];
    const emit = (n) => paraTexts(n).forEach((t) => out.push(t));
    const walk = (el) => {
      for (const n of el.childNodes) {
        if (n.nodeType === 3) { const t = clean(n.nodeValue); if (t.length >= 80) out.push(t); continue; }
        if (n.nodeType !== 1 || isNoise(n, strict)) continue;
        if (n.tagName === 'H1') continue;
        if (/^(P|H[2-6]|LI|PRE|DD|DT)$/.test(n.tagName) || (n.tagName === 'BLOCKQUOTE' && !n.querySelector('p'))) { emit(n); continue; }
        if (!n.querySelector(BLOCK)) { paraTexts(n).filter((t) => t.length >= 40).forEach((t) => out.push(t)); continue; }
        walk(n);
      }
    };
    if (!root.querySelector(BLOCK)) emit(root); else walk(root);
    return out.filter((t, i) => t !== out[i - 1]);
  }
  const total = (ps) => ps.reduce((a, p) => a + p.length, 0);
  const wordsOf = (ps) => ps.join(' ').split(/\s+/).filter(Boolean).length;
  function fromRoots(roots) {
    let all = [];
    for (const r of roots) {
      let ps = paragraphsOf(r, true);
      if (total(ps) < 600) { const l = paragraphsOf(r, false); if (total(l) > total(ps)) ps = l; }
      all = all.concat(ps);
    }
    return all;
  }
  function topLevel(els) {
    return els.filter((e) => !els.some((o) => o !== e && o.contains(e)));
  }
  function clusterRoot(doc) {
    const score = new Map();
    doc.querySelectorAll('p').forEach((p) => {
      const t = clean(p.textContent);
      if (t.length < 80 || p.closest('nav,footer,aside,form')) return;
      score.set(p.parentElement, (score.get(p.parentElement) || 0) + t.length);
      const g = p.parentElement && p.parentElement.parentElement;
      if (g) score.set(g, (score.get(g) || 0) + t.length * 0.5);
    });
    let best = null, bs = 0;
    score.forEach((v, k) => { if (v > bs) { bs = v; best = k; } });
    return best ? [best] : [];
  }
  // every reasonable reading of the page, so the most complete one can be chosen
  function bodyCandidates(doc) {
    const c = [];
    c.push(fromRoots(topLevel([...doc.querySelectorAll(BODY_SEL.join(','))])));
    const arts = [...doc.querySelectorAll('article')].map((e) => [e, total(paragraphsOf(e, true))]).sort((x, y) => y[1] - x[1]);
    if (arts.length) c.push(fromRoots([arts[0][0]]));
    c.push(fromRoots(clusterRoot(doc)));
    if (Math.max(...c.map(total)) < 700) c.push(fromRoots([doc.querySelector('main') || doc.body]));
    return c.filter((x) => x.length);
  }
  function pickBody(cands, wordCount) {
    if (!cands.length) return [];
    if (wordCount > 200) {
      return cands.slice().sort((x, y) => Math.abs(wordsOf(x) - wordCount) - Math.abs(wordsOf(y) - wordCount))[0];
    }
    return cands.slice().sort((x, y) => total(y) - total(x))[0];
  }
  function embeddedBody(doc, ld) {
    let s = ld.article && typeof ld.article.articleBody === 'string' ? ld.article.articleBody : '';
    if (!s) {
      for (const sc of doc.querySelectorAll('script')) {
        const m = (sc.textContent || '').match(/"articleBody"\s*:\s*("(?:[^"\\]|\\.)*")/);
        if (m) { try { s = JSON.parse(m[1]); break; } catch (e) {} }
      }
    }
    s = s.replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n').replace(/<[^>]+>/g, '');
    return s.split(/\n+/).map(clean).filter(Boolean);
  }

  // ================= network =================
  async function fetchDoc(url, prefix) {
    const target = prefix ? prefix + (prefix.endsWith('=') ? encodeURIComponent(url) : url) : url;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetch(target, { signal: ctl.signal, credentials: 'omit' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const buf = await res.arrayBuffer();
      const cs = (res.headers.get('content-type') || '').match(/charset=([\w-]+)/i);
      let html;
      try { html = new TextDecoder(cs ? cs[1] : 'utf-8').decode(buf); } catch (e) { html = new TextDecoder().decode(buf); }
      if (!cs) {
        const m = html.slice(0, 2048).match(/<meta[^>]+charset=["']?([\w-]+)/i);
        if (m && !/utf-?8/i.test(m[1])) { try { html = new TextDecoder(m[1]).decode(buf); } catch (e) {} }
      }
      return new DOMParser().parseFromString(html, 'text/html');
    } finally { clearTimeout(timer); }
  }

  // ================= quals pipeline =================
  const BIO_SEL = '[class*="author-bio" i],[class*="authorBio" i],[class*="author-description" i],[class*="author__bio" i],[class*="author-info" i],[class*="author-details" i],[class*="contributor-bio" i],[class*="about-the-author" i],[class*="-bio" i],[class*="_bio" i],[itemprop="author"] [itemprop="description"],[data-testid*="bio" i],.author-box';

  function qualsFromDoc(doc, name, ev) {
    const H = makeHelpers(doc);
    const ld = readLd(doc);
    const person = ld.all.find((o) => /Person/i.test([].concat(o['@type'] || []).join(' ')) && (!name || clean(o.name).toLowerCase() === name.toLowerCase())) ||
      ld.all.find((o) => /Person/i.test([].concat(o['@type'] || []).join(' ')));
    if (person) {
      const job = clean([].concat(person.jobTitle || [])[0]);
      const org = orgName(person.worksFor || person.affiliation);
      if (job) return org ? `${job} at ${org}` : job;
      if (person.description) { ev.push(person.description); const r = bioToQuals(person.description, name); if (r) return r; }
    }
    for (const el of [...doc.querySelectorAll(BIO_SEL)].slice(0, 8)) {
      const t = clean(el.textContent);
      if (!t) continue;
      ev.push(t.slice(0, 500));
      const r = bioToQuals(t, name);
      if (r) return r;
    }
    return '';
  }

  async function askOllama(api, name, pub, ev) {
    const model = clean(cfg(api, 'ollama-model'));
    if (!model) return { quals: '', author: '', status: 'off' };
    if (!ev.length) return { quals: '', author: '', status: 'no text to read' };
    const base = clean(cfg(api, 'ollama-url')) || 'http://localhost:11434';
    const evidence = ev.join('\n---\n').slice(0, 4000);
    const prompt = 'Find the article author\'s professional qualifications (job title and employer, or credentials) in the text below. ' +
      'Use ONLY the text provided. If the text does not state them, return an empty string. Never guess. ' +
      'If the author name is blank, also give the author\'s full name if the text states it. ' +
      'Reply with JSON only: {"author": "...", "quals": "..."}.\nAuthor: ' + (name || '(blank)') + '\nPublication: ' + pub + '\nTEXT:\n' + evidence;
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 90000);
    try {
      const res = await fetch(base + '/api/generate', {
        method: 'POST', signal: ctl.signal,
        body: JSON.stringify({ model, prompt, stream: false, format: 'json', options: { temperature: 0 } }),
      });
      const data = await res.json();
      if (data.error) return { quals: '', author: '', status: 'Ollama error: ' + data.error };
      const out = JSON.parse(data.response);
      const hay = evidence.toLowerCase();
      let author = clean(out.author);
      const letters = (t) => t.toLowerCase().replace(/[^a-z]/g, '');
      if (name || !validName(author) || !letters(evidence).includes(letters(author))) author = '';
      const quals = clean(out.quals);
      const words = quals.toLowerCase().match(/[a-z]{4,}/g) || [];
      if (!quals) return { quals: '', author, status: author ? 'found author only' : 'found nothing' };
      if (words.length && words.filter((w) => hay.includes(w)).length / words.length >= 0.75) return { quals: tidy(quals), author, status: 'used' };
      return { quals: '', author, status: 'answer unsupported by page, discarded' };
    } finally { clearTimeout(timer); }
  }

  const visibleText = (d, n) => {
    const c = d.body ? d.body.cloneNode(true) : null;
    if (!c) return '';
    c.querySelectorAll('script,style,noscript,nav,footer,svg').forEach((x) => x.remove());
    return clean(c.textContent).slice(0, n);
  };

  // ---------- web lookups (search snippets + Wikipedia) ----------
  async function searchSnippets(query, prefix) {
    const d = await fetchDoc('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), prefix);
    const txt = (r, sel) => clean(r.querySelector(sel) && r.querySelector(sel).textContent);
    return [...d.querySelectorAll('.result')].slice(0, 8).map((r) => {
      const title = txt(r, '.result__title'), snippet = txt(r, '.result__snippet'), u = txt(r, '.result__url');
      return { title, snippet, url: u, text: `${title}. ${snippet}` };
    }).filter((x) => x.snippet || x.title);
  }
  async function wikiSummary(term) {
    const s = await fetch('https://en.wikipedia.org/w/api.php?action=opensearch&limit=1&format=json&origin=*&search=' + encodeURIComponent(term));
    const j = await s.json();
    const title = j[1] && j[1][0];
    if (!title) return null;
    const r = await fetch('https://en.wikipedia.org/api/rest_v1/page/summary/' + encodeURIComponent(title));
    const d = await r.json();
    return d && d.extract ? { title: d.title, extract: d.extract, description: clean(d.description) } : null;
  }
  const siteDescriptor = (extract) => {
    const m = clean(extract).match(/\b(?:is|was)\s+(?:an?|the)\s+(.{5,110}?)(?:[.,;]|\s+(?:based|that|which|founded|owned|headquartered)\b)/i);
    return m ? tidy(m[1]) : '';
  };

  async function lookupPerson(name, pub, host, prefix, ev) {
    const sp = splitName(name);
    const nameRe = new RegExp(esc(sp.first) + '\\s+(?:\\S+\\s+)?' + esc(sp.last), 'i');
    const core = pub.replace(/^the\s+/i, '');
    const pubRe = new RegExp(esc(core) + '|' + esc(host.split('.')[0]), 'i');
    const rs = (await searchSnippets(`"${name}" ${pub}`, prefix))
      .filter((x) => nameRe.test(x.text) && (pubRe.test(x.text) || pubRe.test(x.url)));
    for (const x of rs) {
      ev.push(x.text);
      const t = x.title.match(/^(.+?)\s+[-–|·]\s+(.+?)\s+[-–|·]\s+(.+?)(?:\s+[-–|·]\s+LinkedIn.*)?$/i);
      if (t && nameRe.test(t[1]) && TITLEISH.test(t[2])) return { quals: `${tidy(t[2])} at ${clean(t[3].replace(/\s*[|·].*$/, ''))}`, how: 'web search' };
      const r = bioToQuals(x.snippet, name);
      if (r) return { quals: r, how: 'web search' };
    }
    try {
      const w = await wikiSummary(name);
      if (w && nameRe.test(w.extract) && (pubRe.test(w.extract) || TITLEISH.test(w.description))) {
        const r = bioToQuals(w.extract, name) || (TITLEISH.test(w.description) ? tidy(w.description) : '');
        if (r) return { quals: r, how: 'wikipedia' };
      }
    } catch (e) { /* wikipedia unreachable */ }
    return null;
  }
  async function lookupSite(pub, host, prefix, ev) {
    try {
      const w = await wikiSummary(pub);
      if (w && new RegExp(esc(pub.replace(/^the\s+/i, '').split(' ')[0]), 'i').test(w.extract)) {
        ev.push(w.extract);
        const r = (w.description && w.description.length < 90 ? tidy(w.description) : '') || siteDescriptor(w.extract);
        if (r) return { quals: r, how: 'site lookup' };
      }
    } catch (e) { /* wikipedia unreachable */ }
    try {
      const d = await fetchDoc('https://' + host + '/', prefix);
      const m = makeHelpers(d).meta('og:description', 'description');
      if (m) { ev.push(m); const r = siteDescriptor(m) || tidy(m.split(/(?<=[.!?])\s/)[0]).slice(0, 100); if (r) return { quals: r, how: 'site lookup' }; }
    } catch (e) { /* homepage blocked */ }
    return null;
  }

  async function findQuals(api, ctx) {
    const { doc, url, ld, body, pub, prefix, host } = ctx;
    const model = clean(cfg(api, 'ollama-model'));
    const always = cfg(api, 'ai-mode') === 'Always';
    const lookups = cfg(api, 'web-lookup') !== 'Off';
    let name = ctx.authors[0] || '';
    let foundAuthor;
    const ev = [];
    [...doc.querySelectorAll('[class*="byline" i], [class*="author" i], [rel="author"], [itemprop="author"]')]
      .map((e) => clean(e.textContent)).filter((t) => t && t.length < 300).slice(0, 4).forEach((t) => ev.push(t));
    if (ctx.handleLine) ev.push(ctx.handleLine);
    let found = null;
    let ai = model ? 'not needed' : 'off';
    const keepGoing = () => !found || (model && always);

    // no author yet: let the local AI look for one in the page text
    if (!name && model) {
      try {
        const o = await askOllama(api, '', pub, ev.concat(body.slice(0, 3).join(' ').slice(0, 700), body.slice(-2).join(' ').slice(-500)).filter(Boolean));
        ai = o.status;
        if (o.author) { name = o.author; foundAuthor = o.author; }
        if (o.quals) found = { quals: o.quals, how: 'ollama' };
      } catch (e) {
        ai = 'could not reach Ollama (' + (e && e.message || e) + ')';
        console.warn('[cardcutter-v1] ollama failed', e);
      }
    }

    if (name && !found) {
      let r = qualsFromDoc(doc, name, ev);
      if (r) found = { quals: r, how: 'article page' };

      if (keepGoing()) {
        const sp = splitName(name);
        const full = new RegExp('\\b' + esc(sp.first) + '\\s+(?:\\S+\\s+)?' + esc(sp.last) + '\\b', 'i');
        for (const p of body.slice(-3)) {
          if (full.test(p)) { r = bioToQuals(p, name); if (r) { found = found || { quals: r, how: 'closing bio' }; break; } }
        }
      }

      if (keepGoing()) {
        const sp = splitName(name);
        let href = ld.people[0] && ld.people[0].url;
        if (!href) {
          const a = [...doc.querySelectorAll('a[rel="author"], [itemprop="author"] a, [class*="byline" i] a, a[href*="/author/"], a[href*="/authors/"], a[href*="/people/"], a[href*="/contributors/"], a[href*="/profile/"], a[href*="/experts/"], a[href*="/by/"]')]
            .find((x) => x.getAttribute('href') && new RegExp(esc(sp.last), 'i').test(x.textContent + ' ' + x.getAttribute('href')));
          href = a && a.getAttribute('href');
        }
        if (href) {
          try {
            const abs = new URL(href, url).toString();
            if (abs.split('#')[0] !== url.split('#')[0]) {
              const adoc = await fetchDoc(abs, prefix);
              r = qualsFromDoc(adoc, name, ev);
              for (const d of [adoc.querySelector('meta[property="og:description"]'), adoc.querySelector('meta[name="description"]')]) {
                const t = d && clean(d.getAttribute('content'));
                if (t) { ev.push(t); if (!r) r = bioToQuals(t, name); }
              }
              ev.push(visibleText(adoc, 1200));
              if (r) found = found || { quals: r, how: 'author page' };
            }
          } catch (e) { /* profile page blocked or missing */ }
        }
      }
    }

    // not found on the page: look the author up (or, with no author, the website itself)
    if (!found && lookups) {
      try {
        const r = name ? await lookupPerson(name, pub, host, prefix, ev) : await lookupSite(pub, host, prefix, ev);
        if (r) found = r;
      } catch (e) { console.warn('[cardcutter-v1] lookup failed', e); }
    }

    // local AI reads everything gathered, including search snippets
    if (model && name && !foundAuthor && (!found || always)) {
      ev.push(body.slice(0, 2).join(' ').slice(0, 500), body.slice(-3).join(' ').slice(-1000));
      try {
        const o = await askOllama(api, name, pub, ev.filter(Boolean));
        ai = o.status;
        if (o.quals) return { author: foundAuthor, quals: o.quals, how: 'ollama', ai };
      } catch (e) {
        ai = 'could not reach Ollama (' + (e && e.message || e) + ')';
        console.warn('[cardcutter-v1] ollama failed', e);
      }
    }
    return Object.assign({ ai, author: foundAuthor }, found || { quals: '', how: name ? 'not found' : 'no author' });
  }

  // ================= main =================
  async function cut(api, url, opts) {
    opts = opts || {};
    const prefix = clean(cfg(api, 'fetch-prefix'));
    let doc;
    if (opts.onStep) opts.onStep('fetch', opts.paras && opts.paras.length ? 'Using your pasted text, reading the page for the citation…' : 'Fetching the article…');
    try { doc = await fetchDoc(url, prefix); }
    catch (e) {
      // with pasted body text the citation can still be built from whatever the page gives us
      if (!(opts.paras && opts.paras.length)) throw e;
      console.warn('[cardcutter-v1] page fetch failed, using pasted text only', e);
      doc = new DOMParser().parseFromString('<html><head></head><body></body></html>', 'text/html');
    }
    const H = makeHelpers(doc);
    const ld = readLd(doc);

    const host = new URL(url).hostname.replace(/^www\./, '');
    const pub = PUBS[host] || PUBS[host.split('.').slice(-2).join('.')] ||
      H.meta('citation_journal_title', 'og:site_name', 'application-name') ||
      (ld.article && ld.article.publisher && clean([].concat(ld.article.publisher)[0].name)) || host;

    let title = H.meta('citation_title') || (ld.article && clean(ld.article.headline)) ||
      H.meta('og:title', 'twitter:title') || clean(H.q('h1') && H.q('h1').textContent) || clean(doc.title);
    title = title.replace(new RegExp('\\s*[|\\-–—:]\\s*(?:' + esc(pub) + '|' + esc(host) + ')\\s*$', 'i'), '').replace(/"/g, "'");

    const authors = getAuthors(doc, H, ld);
    const dateParts = getDate(doc, H, ld, url);
    const hAuth = handleAuthor(doc, H);

    // body: your pasted text wins; otherwise choose the most complete of several readings (page containers, embedded JSON, AMP page)
    let bodySrc = 'page';
    let paras = [];
    if (opts.paras && opts.paras.length) { paras = opts.paras; bodySrc = 'pasted text'; }
    else {
      // body: choose the most complete of several readings (page containers, embedded JSON, AMP page)
      const wc = parseInt(ld.article && ld.article.wordCount, 10) || 0;
      const cands = bodyCandidates(doc);
      const emb = embeddedBody(doc, ld);
      paras = pickBody(cands, wc);
      if (total(emb) >= 700 && (total(emb) >= total(paras) * 0.9 || (wc && Math.abs(wordsOf(emb) - wc) < Math.abs(wordsOf(paras) - wc)))) {
        paras = emb; bodySrc = 'embedded data';
      }
      if (total(paras) < 700) {
        const amp = H.q('link[rel="amphtml"]');
        if (amp && amp.getAttribute('href')) {
          try {
            const adoc = await fetchDoc(new URL(amp.getAttribute('href'), url).toString(), prefix);
            const ap = pickBody(bodyCandidates(adoc), 0);
            if (total(ap) > total(paras)) { paras = ap; bodySrc = 'AMP page'; }
          } catch (e) {}
        }
      }
    }

    let authorFrom = authors.length ? 'page' : '';
    if (!authors.length && hAuth.name) { authors.push(hAuth.name); authorFrom = 'social handle'; }
    if (opts.onStep) opts.onStep('author', 'Looking up the author and their qualifications…');
    const q = await findQuals(api, { doc, url, authors, ld, body: paras, pub, prefix, host, handleLine: hAuth.line });
    if (q.author && !authors.length) { authors.push(q.author); authorFrom = 'AI'; }
    let quals = q.quals.replace(/"/g, "'");
    if (!quals) {
      quals = cfg(api, 'fallback-quals') === 'Writer at publication' && authors.length
        ? 'Writer at ' + pub : (cfg(api, 'quals-placeholder') || 'QUALS');
    }

    const vol = H.meta('citation_volume'), issue = H.meta('citation_issue');
    const fp = H.meta('citation_firstpage'), lp = H.meta('citation_lastpage');
    const pages = fp ? (lp && lp !== fp ? `${fp}-${lp}` : fp) : '';
    const u = new URL(url); u.hash = '';
    [...u.searchParams.keys()].forEach((k) => /^(utm_|fbclid|gclid|mc_|ref$|cmp)/i.test(k) && u.searchParams.delete(k));

    let lastPart = pub, first = pub;
    const names = authors.map(splitName);
    if (names.length === 1) { lastPart = names[0].last; first = names[0].first || pub; }
    else if (names.length === 2) { lastPart = `${names[0].last} and ${names[1].last}`; first = `${names[0].first || pub} and ${names[1].first || pub}`; }
    else if (names.length > 2) { lastPart = `${names[0].last} et al.`; first = names[0].first || pub; }

    // required: last name, year, quals, first name, title, URL. Optional: publication, volume, issue, page.
    const year = dateParts ? String(dateParts.y).slice(2) : 'YY';
    const dateText = formatDate(dateParts, cfg(api, 'date-format'));
    const tail = [pub, vol && `vol. ${vol}`, issue && `issue ${issue}`, pages && `page ${pages}`, u.toString()].filter(Boolean);
    const lead = `${lastPart} ${year}`;
    const cite = `${lead}, [${quals}, (${first}, ${dateText}, "${title || 'TITLE'}," ${tail.join(', ')}]`;
    const info = { authors, authorFrom, quals: q.quals, qualsFrom: q.how, ai: q.ai || 'not needed', date: dateText, bodyChars: total(paras), bodyFrom: bodySrc, paragraphs: paras.length };
    console.log('[cardcutter-v1]', url, info);
    const meta = {
      url: u.toString(), host, pub, title, authors: authors.slice(), quals: q.quals || '', dateParts, paras,
      journalTitle: H.meta('citation_journal_title'),
      jsonType: [].concat((ld.article && ld.article['@type']) || []).join(' '),
    };
    return { cite, lead, body: paras.join('\n'), paras, info, meta };
  }

  // ---------- apply CardMirror's Cite style to "Last YY" (undocumented: selects the text, presses the Cite key) ----------
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  function textNodesOf(ed) {
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    const a = []; let n;
    while ((n = w.nextNode())) a.push(n);
    return a;
  }
  function findTextNode(ed, needle, before) {
    let hit = null;
    for (const n of textNodesOf(ed)) {
      if (!n.nodeValue.includes(needle)) continue;
      if (before && n !== before && !(n.compareDocumentPosition(before) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
      hit = n;
    }
    return hit;
  }
  function keyEventFor(spec) {
    const parts = spec.split('-').filter(Boolean);
    const key = parts.pop() || 'F8';
    const mac = /Mac/i.test(navigator.platform);
    const has = (m) => parts.some((p) => p.toLowerCase() === m);
    const fn = /^F(\d+)$/i.exec(key);
    const init = {
      bubbles: true, cancelable: true,
      key: key.length === 1 ? key.toLowerCase() : key.toUpperCase().replace(/^F/, 'F'),
      code: fn ? 'F' + fn[1] : (key.length === 1 ? (/\d/.test(key) ? 'Digit' + key : 'Key' + key.toUpperCase()) : key),
      keyCode: fn ? 111 + (+fn[1]) : (key.length === 1 ? key.toUpperCase().charCodeAt(0) : 0),
      shiftKey: has('shift'), altKey: has('alt') || has('opt'),
      ctrlKey: has('ctrl') || (has('mod') && !mac),
      metaKey: has('cmd') || has('meta') || (has('mod') && mac),
    };
    return new KeyboardEvent('keydown', init);
  }
  async function styleCite(api, ed, lead, tailSnippet) {
    if (!ed || !ed.isConnected) return 'no editor';
    const sel = window.getSelection();
    await sleep(150);
    const node = findTextNode(ed, lead + ', [', sel && sel.anchorNode);
    if (!node) return 'cite text not found';
    const idx = node.nodeValue.indexOf(lead + ', [');
    const styled = lead + ',';
    const r = document.createRange();
    r.setStart(node, idx); r.setEnd(node, idx + styled.length);
    ed.focus();
    sel.removeAllRanges(); sel.addRange(r);
    await sleep(150);
    if (sel.toString() !== styled) return 'could not select the cite';
    ed.dispatchEvent(keyEventFor(cfg(api, 'cite-key')));
    await sleep(200);
    // put the caret back at the end of what we inserted
    const t = findTextNode(ed, tailSnippet, null);
    if (t) {
      const rr = document.createRange();
      const i = t.nodeValue.lastIndexOf(tailSnippet);
      rr.setStart(t, i + tailSnippet.length); rr.collapse(true);
      sel.removeAllRanges(); sel.addRange(rr);
    }
    // marks split text nodes, so an isolated "Last YY" node means a mark was applied
    return textNodesOf(ed).some((n) => n.nodeValue === styled) ? 'applied' : 'key sent, no change seen';
  }

  // Not part of the documented API: simulate a plain-text paste into the editor.
  function insertText(ed, text) {
    if (!ed || !ed.isConnected) return false;
    ed.focus();
    try {
      const dt = new DataTransfer();
      dt.setData('text/plain', text);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      ed.dispatchEvent(ev);
      if (ev.defaultPrevented) return true;
    } catch (e) {}
    try { return document.execCommand('insertText', false, text); } catch (e) { return false; }
  }

  function askText(label, initial) {
    return new Promise((resolve) => {
      const wrap = document.createElement('div');
      wrap.style.cssText = 'position:fixed;inset:0;z-index:2147483647;background:rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center';
      const box = document.createElement('div');
      box.style.cssText = 'background:#fff;color:#111;padding:16px;border-radius:10px;width:480px;font:14px -apple-system,sans-serif;box-shadow:0 8px 30px rgba(0,0,0,.35)';
      box.textContent = label + ' (Enter to save, Esc to cancel)';
      const input = document.createElement('input');
      input.value = initial || '';
      input.style.cssText = 'display:block;width:100%;box-sizing:border-box;margin-top:8px;padding:8px;font:14px sans-serif';
      box.appendChild(input); wrap.appendChild(box); document.body.appendChild(wrap);
      const done = (v) => { wrap.remove(); resolve(v); };
      input.addEventListener('keydown', (e) => {
        e.stopPropagation();
        if (e.key === 'Enter') done(input.value.trim());
        else if (e.key === 'Escape') done(null);
      });
      input.focus();
      input.select();
    });
  }
  const askUrl = () => askText('Article URL to cut', '');


  // =====================================================================
  // CC additions: shared helpers
  // =====================================================================
  const uid = () => Math.random().toString(36).slice(2, 9);
  const setting = (api, k, d) => {
    try {
      const v = api.settings && api.settings.get(k);
      return (v === undefined || v === null) ? d : v;
    } catch (e) { return d; }
  };
  const aiOn = (api) => !!setting(api, 'use-ai', true) && !!clean(cfg(api, 'ollama-model'));

  async function ollamaJson(api, prompt, ms, modelOverride) {
    const model = clean(modelOverride || cfg(api, 'ollama-model'));
    if (!model) throw new Error('no model set');
    const base = clean(cfg(api, 'ollama-url')) || 'http://localhost:11434';
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms || 60000);
    try {
      const res = await fetch(base + '/api/generate', {
        method: 'POST', signal: ctl.signal,
        body: JSON.stringify({ model, prompt, stream: false, format: 'json', keep_alive: '30m', options: { temperature: 0, num_ctx: 8192 } }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      return JSON.parse(data.response);
    } finally { clearTimeout(timer); }
  }

  function h(tag, attrs, ...kids) {
    const el = document.createElement(tag);
    for (const k in (attrs || {})) {
      const v = attrs[k];
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') el.className = v;
      else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), v);
      else el.setAttribute(k, v === true ? '' : v);
    }
    for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) el.append(c.nodeType ? c : document.createTextNode(String(c)));
    return el;
  }

  const CSS = `
.ccx{--bg:#fff;--fg:#1f2328;--mut:#6b7280;--line:#e5e7eb;--soft:#f6f8fa;--acc:#2563eb;--accfg:#fff;--hi:#16a34a;--mid:#d97706;--lo:#dc2626;font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;color:var(--fg)}
.ccx.dark{--bg:#1c1f24;--fg:#e6e8eb;--mut:#9aa3af;--line:#30363d;--soft:#242930;--acc:#6b9bff;--accfg:#0b1220;--hi:#4ade80;--mid:#fbbf24;--lo:#f87171}
.ccx *{box-sizing:border-box}
.ccx-back{position:fixed;inset:0;z-index:2147483000;background:rgba(0,0,0,.4);display:flex;align-items:center;justify-content:center;padding:24px}
.ccx-panel{background:var(--bg);width:min(820px,100%);max-height:88vh;border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.35);display:flex;flex-direction:column;overflow:hidden;border:1px solid var(--line)}
.ccx-top{display:flex;align-items:center;gap:8px;padding:14px 18px;border-bottom:1px solid var(--line)}
.ccx-title{font-weight:650;font-size:15px;flex:1}
.ccx-title small{color:var(--mut);font-weight:500;margin-left:8px}
.ccx-ico{border:0;background:transparent;color:var(--mut);width:30px;height:30px;border-radius:8px;cursor:pointer;font-size:18px;line-height:1}
.ccx-ico:hover{background:var(--soft);color:var(--fg)}
.ccx-claim{padding:14px 18px 8px;display:flex;gap:10px;align-items:flex-start}
.ccx-claim textarea{flex:1;resize:none;height:46px;padding:10px 12px;border:1px solid var(--line);border-radius:10px;background:var(--soft);color:var(--fg);font:inherit;outline:none}
.ccx-claim textarea:focus,.ccx-add input:focus{border-color:var(--acc)}
.ccx-btn{border:1px solid var(--line);background:var(--soft);color:var(--fg);padding:9px 14px;border-radius:10px;cursor:pointer;font:inherit;font-weight:600;white-space:nowrap}
.ccx-btn:hover{border-color:var(--acc)}
.ccx-btn.pri{background:var(--acc);border-color:var(--acc);color:var(--accfg)}
.ccx-btn.sm{padding:5px 11px;font-size:13px}
.ccx-bar{display:flex;align-items:center;gap:8px;padding:4px 18px 12px;color:var(--mut);font-size:12.5px}
.ccx-bar .sp{flex:1}
.ccx-list{overflow:auto;padding:4px 18px 18px;display:flex;flex-direction:column;gap:12px}
.ccx-card{border:1px solid var(--line);border-radius:12px;padding:14px 16px;background:var(--bg)}
.ccx-card.load{background:linear-gradient(90deg,var(--soft),var(--bg),var(--soft));background-size:200% 100%;animation:ccx-sh 1.4s linear infinite;color:var(--mut);word-break:break-word}
.ccx-head{word-break:break-word}
.ccx-head a{color:var(--acc);text-decoration:none}
.ccx-head a:hover{text-decoration:underline}
.ccx-pct{font-weight:700}
.ccx-pct.hi{color:var(--hi)}.ccx-pct.mid{color:var(--mid)}.ccx-pct.lo{color:var(--lo)}
.ccx-segs{margin:14px 0 0}
.ccx-seg{margin:0 0 7px;padding-left:10px;border-left:3px solid var(--line)}
.ccx-quals{margin:14px 0 0;color:var(--mut)}
.ccx-act{display:flex;gap:16px;margin-top:12px;font-size:12.5px}
.ccx-act button{border:0;background:none;color:var(--mut);cursor:pointer;padding:0;font:inherit}
.ccx-act button:hover{color:var(--acc)}
.ccx-add{display:flex;gap:8px}
.ccx-add input{flex:1;padding:10px 12px;border:1px dashed var(--acc);border-radius:10px;background:var(--soft);color:var(--fg);font:inherit;outline:none}
.ccx-empty{color:var(--mut);text-align:center;padding:36px 12px}
.ccx-hud{position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:2147483001;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);padding:12px 16px;width:min(580px,92vw);display:flex;flex-direction:column;gap:9px}
.ccx-pills{display:flex;gap:6px;flex-wrap:wrap}
.ccx-pill{font-size:12px;font-weight:600;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--mut)}
.ccx-pill.on{border-color:var(--acc);color:var(--acc);animation:ccx-pulse 1s ease-in-out infinite}
.ccx-pill.done{background:var(--hi);border-color:var(--hi);color:#fff}
.ccx-track{height:5px;background:var(--soft);border-radius:99px;overflow:hidden}
.ccx-fill{height:100%;width:0;background:var(--acc);border-radius:99px;transition:width .2s}
.ccx-cap{font-size:12.5px;color:var(--mut);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.ccx-hudrow{display:flex;align-items:center;gap:10px}
.ccx-hudrow .ccx-cap{flex:1}
.ccx-fill.ind{width:35% !important;animation:ccx-ind 1.1s ease-in-out infinite}
.ccx-hud.err{border-color:var(--lo)}
.ccx-hud.err .ccx-cap{color:var(--lo)}
@keyframes ccx-ind{0%{margin-left:-35%}100%{margin-left:100%}}
.ccx-flowwrap{position:fixed;inset:14px 18px;z-index:2147482000;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.4);overflow:hidden}
.ccx-ftop{display:flex;align-items:center;gap:8px;padding:9px 14px;border-bottom:1px solid var(--line)}
.ccx-ftop .sp,.ccx-ffoot .sp{flex:1}
.ccx-fbody{flex:1;display:flex;min-height:0}
.ccx-tabs{width:180px;flex:none;border-right:1px solid var(--line);overflow:auto;padding:8px;display:flex;flex-direction:column;gap:4px;background:var(--soft)}
.ccx-tab{display:flex;align-items:center;gap:6px;padding:8px 10px;border-radius:9px;cursor:pointer;border:1px solid transparent;border-left:3px solid var(--line)}
.ccx-tab .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:550}
.ccx-tab:hover{background:var(--bg)}
.ccx-tab.on{background:var(--bg);border-color:var(--acc);border-left-color:var(--acc)}
.ccx-tab .x{border:0;background:none;color:var(--mut);cursor:pointer;opacity:0;font-size:14px;padding:0 2px}
.ccx-tab:hover .x{opacity:1}
.ccx-tab.k-da{border-left-color:#d97706}.ccx-tab.k-cp{border-left-color:#7c3aed}.ccx-tab.k-k{border-left-color:#db2777}.ccx-tab.k-t{border-left-color:#0891b2}.ccx-tab.k-theory{border-left-color:#65a30d}.ccx-tab.k-adv{border-left-color:#2563eb}.ccx-tab.k-solv{border-left-color:#16a34a}
.ccx-rename{width:100%;font:inherit;padding:2px 4px;border:1px solid var(--acc);border-radius:5px;background:var(--bg);color:var(--fg)}
.ccx-muted{color:var(--mut);padding:8px}
.ccx-fmain{flex:1;display:flex;flex-direction:column;min-width:0}
.ccx-fscroll{flex:1;overflow:auto;position:relative}
.ccx-fhead{position:sticky;top:0;z-index:3;display:grid;grid-template-columns:repeat(8,minmax(150px,1fr));min-width:1240px;background:var(--bg)}
.ccx-ch{display:flex;align-items:center;justify-content:space-between;padding:7px 10px;border-bottom:2px solid var(--line);border-right:1px solid var(--line)}
.ccx-ch.aff{background:rgba(37,99,235,.09);border-bottom-color:#2563eb}
.ccx-ch.neg{background:rgba(220,38,38,.09);border-bottom-color:#dc2626}
.ccx-ch.live{box-shadow:inset 0 -3px 0 #e11d48}
.ccx-ch .dot{border:0;background:none;cursor:pointer;color:var(--mut);font-size:13px}
.ccx-ch .dot.done{color:var(--hi)}
.ccx-ch .dot.flowing{color:#e11d48}
.ccx-fgrid{min-width:1240px;padding-bottom:40px}
.ccx-frow{display:grid;grid-template-columns:repeat(8,minmax(150px,1fr));position:relative}
.ccx-cell{width:100%;display:block;border:0;border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:7px 9px;resize:none;overflow:hidden;background:transparent;color:var(--fg);font:12.5px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;outline:none;min-height:38px}
.ccx-cell.aff{background:rgba(37,99,235,.03)}.ccx-cell.neg{background:rgba(220,38,38,.03)}
.ccx-cell:focus{background:var(--soft)}
.ccx-cell.dropped::placeholder{color:var(--lo);font-weight:700;opacity:1;letter-spacing:.04em}
.ccx-cell.wasdropped{box-shadow:inset 3px 0 0 var(--lo)}
.ccx-rowx{position:absolute;right:2px;top:2px;border:0;background:var(--bg);color:var(--mut);border-radius:6px;cursor:pointer;opacity:0;font-size:14px;line-height:1;padding:2px 5px;z-index:2}
.ccx-frow:hover .ccx-rowx{opacity:.9}
.ccx-addrow{margin:10px}
.ccx-ffoot{display:flex;align-items:center;gap:8px;padding:6px 14px;border-top:1px solid var(--line);color:var(--mut);font-size:12.5px}
.ccx-live{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex:1;min-width:0}
.ccx-txrow{display:flex;gap:8px;padding:0 14px 10px;align-items:flex-start}
.ccx-tx{flex:1;height:64px;resize:vertical;padding:8px 10px;border:1px solid var(--line);border-radius:9px;background:var(--soft);color:var(--fg);font:inherit}
.ccx-sel{padding:6px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--fg);font:inherit}
.ccx-chip{display:inline-flex;align-items:center;gap:6px;font-size:12px;font-weight:600;color:#e11d48;border:1px solid #e11d48;border-radius:99px;padding:2px 9px}
.ccx-chip i,.ccx-rec i{width:8px;height:8px;border-radius:50%;background:#e11d48;animation:ccx-pulse 1.2s ease-in-out infinite;display:inline-block}
.ccx-rec{position:fixed;left:14px;bottom:14px;z-index:2147483002;background:var(--bg);border:1px solid var(--line);border-radius:99px;padding:4px 6px 4px 11px;font-size:12px;font-weight:600;display:flex;align-items:center;gap:8px;box-shadow:0 6px 24px rgba(0,0,0,.25);cursor:pointer}
.ccx-rec.off i{animation:none;background:var(--mut)}
.ccx-rec button{border:0;background:#e11d48;color:#fff;border-radius:50%;width:20px;height:20px;cursor:pointer;font-size:9px;line-height:1;padding:0}
@keyframes ccx-sh{to{background-position:-200% 0}}
@keyframes ccx-pulse{50%{opacity:.45}}
`;
  function ensureStyle() {
    if (document.getElementById('ccx-style')) return;
    const s = document.createElement('style');
    s.id = 'ccx-style'; s.textContent = CSS;
    document.head.appendChild(s);
  }
  function themeClass() {
    try {
      const m = getComputedStyle(document.body).backgroundColor.match(/[\d.]+/g);
      if (m && !(m.length >= 4 && +m[3] === 0)) {
        const [r, g, b] = m.map(Number);
        return (0.299 * r + 0.587 * g + 0.114 * b) < 128 ? ' dark' : '';
      }
    } catch (e) { /* fall through */ }
    return (window.matchMedia && matchMedia('(prefers-color-scheme: dark)').matches) ? ' dark' : '';
  }

  // =====================================================================
  // CC additions: language helpers (claim terms, sentences, scoring)
  // =====================================================================
  const STOP = new Set(('a an and are as at be been being but by can could did do does for from had has have he her his how i if in into is it its may might more most no not of on or our she should so some such than that the their them then there these they this those to too was we were what when which who whom why will with would you your about after all also any because both each few just only other over same very via per vs versus according through during between among within without across against toward upon while where whether').split(' '));
  const EVALW = new Set(['bad', 'good', 'harmful', 'beneficial', 'better', 'worse', 'best', 'worst', 'effective', 'ineffective', 'should', 'must', 'fails', 'fail', 'works', 'wrong', 'right', 'terrible', 'great']);
  const WEAK = new Set(('want wants wanted said says say think thinks believe believes seem seems make makes made get gets got take takes took need needs like many much lot really very just even still already often however today new also').split(' '));
  const CONNECT = new Set(['of', 'in', 'on', 'for', 'to', 'by', 'than', 'from', 'with', 'as']);
  const FIRST = new Set(('john james robert michael william david richard joseph thomas charles chris christopher daniel matthew anthony mark donald steven paul andrew joshua kenneth kevin brian george timothy ronald edward jason jeffrey ryan jacob gary nicholas eric jonathan stephen larry justin scott brandon benjamin samuel gregory alexander frank patrick raymond jack dennis jerry tyler aaron adam nathan henry douglas peter kyle walter ethan jeremy keith roger sean arthur lawrence barack hillary bernie joe elon bill mary patricia jennifer linda elizabeth barbara susan jessica sarah karen lisa nancy margaret sandra ashley emily donna michelle carol amanda melissa deborah stephanie rebecca laura anna emma').split(' '));
  const IMPACT_WORDS = ['extinction', 'war', 'wars', 'nuclear', 'collapse', 'catastrophe', 'catastrophic', 'death', 'deaths', 'genocide', 'famine', 'hate', 'violence', 'terrorism', 'escalation', 'poverty', 'recession', 'depression', 'crisis', 'crises', 'instability', 'inequality', 'pandemic', 'disease', 'bankruptcy', 'bankrupt', 'shortage', 'shortages', 'existential', 'irreversible', 'mortality', 'inflation', 'unemployment', 'conflict', 'racism', 'discrimination', 'authoritarianism', 'tyranny', 'suffering', 'devastating', 'devastation', 'destruction', 'chaos', 'unsustainable', 'millions', 'billions', 'trillions'];
  const IMPACT_RE = new RegExp('\\b(?:' + IMPACT_WORDS.join('|') + ')\\b', 'gi');
  const IMPACT_T = new RegExp('^(?:' + IMPACT_WORDS.join('|') + ')$', 'i');
  const IMPACT_ANY = new RegExp('\\b(?:' + IMPACT_WORDS.join('|') + ')\\b', 'i');
  const EVID = /\b(?:\d+(?:\.\d+)?\s?(?:%|percent)|\$\s?\d|study|studies|found|research|evidence|data|analysis|according to|because|therefore|cost|costs|increase[sd]?|decrease[sd]?|lead|leads|cause[sd]?|result[sd]?|will|would)\b|%/i;
  const ACRO_SKIP = new Set(['THE', 'AND', 'FOR', 'NOT', 'BUT', 'ALL', 'ARE', 'WAS', 'OK', 'AM', 'PM']);
  const LEAD = /^(?:however|but|and|so|thus|therefore|moreover|furthermore|additionally|in addition|in fact|indeed|also|yet|still|meanwhile|for example|for instance|first|second|third|finally|similarly|likewise|overall|ultimately|in short|in conclusion|as a result|that said|nevertheless|nonetheless)\b[,;:]?\s+/i;

  const stem = (w) => {
    w = String(w).toLowerCase().replace(/[^a-z0-9]/g, '');
    if (w.length > 5) w = w.replace(/ies$/, 'y').replace(/(?:ations?|ing|ed|ly|es|s)$/, '');
    else if (w.length > 3) w = w.replace(/s$/, '');
    return w;
  };
  const wordList = (s) => (String(s).match(/[A-Za-z0-9][A-Za-z0-9'’-]*/g) || []);

  function claimTerms(claim) {
    const seen = new Set(); const out = [];
    for (const raw of wordList(claim)) {
      const lw = raw.toLowerCase();
      if (STOP.has(lw) || lw.length < 3) continue;
      const st = stem(lw);
      if (!st || seen.has(st)) continue;
      seen.add(st);
      out.push({ raw: lw, stem: st, w: EVALW.has(lw) ? 0.3 : 1 });
    }
    return out;
  }
  // adjacent content-word pairs in the claim, e.g. "single payer", "health insurance"
  function claimBigrams(claim) {
    const toks = wordList(claim).map((w) => w.toLowerCase());
    const res = [];
    for (let i = 0; i + 1 < toks.length; i++) {
      const a = toks[i], b = toks[i + 1];
      if (STOP.has(a) || STOP.has(b) || EVALW.has(a) || EVALW.has(b) || a.length < 3 || b.length < 3) continue;
      res.push(new RegExp('\\b' + esc(a) + '\\w*\\s+' + esc(b) + '\\w*', 'gi'));
    }
    return res;
  }

  const ABBR = /^(?:mr|mrs|ms|dr|prof|sr|jr|st|vs|etc|inc|corp|co|ltd|no|gen|sen|rep|gov|sec|dept|fig|e\.g|i\.e|u\.s|u\.k|u\.n|d\.c|a\.m|p\.m|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec)\.$/i;
  function splitSentences(p) {
    const out = []; let start = 0; let m;
    const re = /[.!?]+["'”’)\]]*\s+(?=["'“‘(\[]?[A-Z0-9])/g;
    while ((m = re.exec(p))) {
      if (m[0][0] === '.') {
        const tok = ((p.slice(start, m.index).match(/(\S+)$/) || [''])[0]) + '.';
        if (ABBR.test(tok) || /^[A-Z]\.$/.test(tok)) continue;
      }
      out.push({ s: start, e: m.index + m[0].replace(/\s+$/, '').length });
      start = m.index + m[0].length;
    }
    if (start < p.length) out.push({ s: start, e: p.length });
    return out.map((x) => ({ s: x.s, e: x.e, text: p.slice(x.s, x.e) })).filter((x) => x.text.trim());
  }
  function sentencesOf(paras) {
    const out = [];
    paras.forEach((p, pi) => splitSentences(p).forEach((s) => out.push({ pi, s: s.s, e: s.e, text: s.text })));
    return out;
  }
  function scoreSentence(text, terms) {
    let sc;
    if (!terms.length) {
      sc = (EVID.test(text) ? 0.3 : 0) + (IMPACT_ANY.test(text) ? 0.3 : 0) + (text.length > 80 ? 0.1 : 0);
    } else {
      const toks = new Set(wordList(text).map(stem));
      let got = 0, tot = 0;
      for (const t of terms) { tot += t.w; if (toks.has(t.stem)) got += t.w; }
      sc = tot ? got / tot : 0;
      if (sc > 0) { if (EVID.test(text)) sc += 0.12; if (IMPACT_ANY.test(text)) sc += 0.08; }
    }
    if (text.length < 50) sc *= 0.5;
    if (/\?\s*$/.test(text)) sc *= 0.6;
    return sc;
  }
  const rankSents = (sents, terms) => sents.map((x, i) => ({ i, sc: scoreSentence(x.text, terms) }))
    .filter((x) => x.sc > 0).sort((a, b) => b.sc - a.sc);

  // =====================================================================
  // CC additions: C2 planning (what to underline / emphasise / highlight)
  // =====================================================================
  function heuristicPick(sents, terms) {
    const total = sents.reduce((a, x) => a + x.text.length, 0);
    const budget = Math.min(total * 0.32, 3000);
    const ranked = rankSents(sents, terms);
    const picked = new Set(); let used = 0;
    for (const r of ranked) {
      if (picked.size >= 3 && (used >= budget || r.sc < ranked[0].sc * 0.35)) break;
      picked.add(r.i); used += sents[r.i].text.length;
    }
    return picked;
  }

  async function aiPick(api, sents, terms, claim, ms) {
    let cands = sents.map((x, i) => i);
    if (cands.length > 45) {
      const top = rankSents(sents, terms).slice(0, 45).map((x) => x.i);
      cands = (top.length >= 10 ? top : cands.slice(0, 45)).sort((a, b) => a - b);
    }
    const list = cands.map((si, n) => (n + 1) + '. ' + sents[si].text.slice(0, 220)).join('\n');
    const prompt = 'You cut evidence cards for competitive policy debate.\nCLAIM: "' + claim + '"\n' +
      'Below are numbered sentences from an article. Choose the sentences that most directly prove or support the claim ' +
      '(about 25-35% of them, at least 3). Also list 3-10 short high-impact words or phrases copied EXACTLY from those sentences ' +
      'worth emphasising (for example: extinction, war, hate, billions).\n' +
      'Reply with JSON only: {"underline":[numbers],"emphasis":["word",...]}\nSENTENCES:\n' + list;
    const out = await ollamaJson(api, prompt, ms || 40000);
    const idx = new Set([].concat(out.underline || []).map((n) => parseInt(n, 10) - 1)
      .filter((n) => n >= 0 && n < cands.length).map((n) => cands[n]));
    const emph = [].concat(out.emphasis || []).map((w) => clean(String(w))).filter((w) => w && w.length < 40).slice(0, 12);
    return { idx, emph };
  }

  function underlineSpans(paras, sents, picked) {
    const spans = [];
    [...picked].sort((a, b) => a - b).forEach((i) => {
      const x = sents[i];
      let s = x.s;
      const m = x.text.match(LEAD);
      if (m && x.text.length - m[0].length > 25) s += m[0].length;
      const last = spans[spans.length - 1];
      if (last && last.pi === x.pi && /^\s*$/.test(paras[x.pi].slice(last.e, s))) last.e = x.e;
      else spans.push({ pi: x.pi, s, e: x.e });
    });
    return spans;
  }

  // Keep the few words that carry the meaning, so the highlighted text reads fast.
  function highlightRanges(text, stems) {
    const toks = []; const re = /[\p{L}\p{N}$][\p{L}\p{N}'’\-.,%$]*/gu; let m;
    while ((m = re.exec(text))) {
      const w = m[0].replace(/[.,'’\-]+$/, '');
      if (w && /[\p{L}\p{N}]/u.test(w)) toks.push({ w, s: m.index, e: m.index + w.length });
    }
    const n = toks.length;
    if (!n) return [];
    if (n < 4) return [{ s: toks[0].s, e: toks[n - 1].e }];
    const isCap = (t) => /^\p{Lu}/u.test(t.w);
    const keep = new Array(n).fill(false), strong = new Array(n).fill(false);
    const sentStart = (i) => i === 0 || /[.!?]["'”’)\]]*\s*$/.test(text.slice(0, toks[i].s));
    const cap = toks.map((t, i) => isCap(t) && !(sentStart(i) && !(toks[i + 1] && isCap(toks[i + 1]))));
    for (let i = 0; i < n;) {
      if (!cap[i]) { i++; continue; }
      let j = i; while (j + 1 < n && cap[j + 1]) j++;
      const run = toks.slice(i, j + 1);
      const personish = j > i && (run.some((t) => /^\p{Lu}\.?$/u.test(t.w)) || FIRST.has(run[0].w.toLowerCase()));
      for (let k = i; k <= j; k++) if (!personish || k === j) { keep[k] = true; strong[k] = true; }
      i = j + 1;
    }
    toks.forEach((t, i) => {
      if (keep[i] || cap[i]) return;
      const lw = t.w.toLowerCase();
      if (/\d/.test(t.w) || stems.has(stem(lw)) || IMPACT_T.test(lw)) { keep[i] = true; strong[i] = true; return; }
      if (!STOP.has(lw) && !WEAK.has(lw) && !/ly$/.test(lw) && lw.length >= 3) keep[i] = true;
    });
    // thin it out: drop the least informative kept words until about half remain
    let kept = keep.filter(Boolean).length;
    const droppable = toks.map((t, i) => i).filter((i) => keep[i] && !strong[i]).sort((a, b) => toks[a].w.length - toks[b].w.length);
    for (const i of droppable) { if (kept <= Math.max(2, n * 0.5)) break; keep[i] = false; kept--; }
    for (let i = 1; i < n - 1; i++) {
      if (!keep[i] && CONNECT.has(toks[i].w.toLowerCase()) && keep[i - 1] && keep[i + 1] &&
        /^\s+$/.test(text.slice(toks[i - 1].e, toks[i].s)) && /^\s+$/.test(text.slice(toks[i].e, toks[i + 1].s))) keep[i] = true;
    }
    const out = [];
    for (let i = 0; i < n;) {
      if (!keep[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && keep[j + 1] && /^\s+$/.test(text.slice(toks[j].e, toks[j + 1].s))) j++;
      let any = false;
      for (let k = i; k <= j; k++) if (strong[k]) any = true;
      if (j > i || any || toks[i].w.length >= 8) out.push({ s: toks[i].s, e: toks[j].e });
      i = j + 1;
    }
    return out;
  }

  function buildPlan(paras, claim, aiOut) {
    const terms = claimTerms(claim);
    const stems = new Set(terms.map((t) => t.stem));
    const sents = sentencesOf(paras);
    const picked = (aiOut && aiOut.idx && aiOut.idx.size >= 2) ? aiOut.idx : heuristicPick(sents, terms);
    const spans = underlineSpans(paras, sents, picked);
    const bigrams = claimBigrams(claim);
    const emphasis = [], highlight = [];
    const aiCount = {}, acroCount = {};
    for (const sp of spans) {
      const text = paras[sp.pi].slice(sp.s, sp.e);
      const add = (arr, a, b) => arr.push({ pi: sp.pi, s: sp.s + a, e: sp.s + b });
      for (const m of text.matchAll(IMPACT_RE)) add(emphasis, m.index, m.index + m[0].length);
      for (const re of bigrams) {
        for (const m of text.matchAll(re)) {
          let off = 0;
          for (const part of m[0].split(/(\s+)/)) {
            if (/\S/.test(part)) add(emphasis, m.index + off, m.index + off + 1);
            off += part.length;
          }
        }
      }
      for (const m of text.matchAll(/\b[A-Z]{2,6}\b/g)) {
        if (ACRO_SKIP.has(m[0])) continue;
        acroCount[m[0]] = (acroCount[m[0]] || 0) + 1;
        if (acroCount[m[0]] <= 2) add(emphasis, m.index, m.index + m[0].length);
      }
      for (const w of (aiOut && aiOut.emph) || []) {
        const re = new RegExp('\\b' + esc(w) + '\\b', 'gi');
        for (const m of text.matchAll(re)) {
          aiCount[w] = (aiCount[w] || 0) + 1;
          if (aiCount[w] <= 2) add(emphasis, m.index, m.index + m[0].length);
        }
      }
      highlightRanges(text, stems).forEach((r) => add(highlight, r.s, r.e));
    }
    const dedupe = (arr, cap) => {
      arr.sort((a, b) => a.pi - b.pi || a.s - b.s || b.e - a.e);
      const res = [];
      for (const r of arr) {
        const l = res[res.length - 1];
        if (l && l.pi === r.pi && r.s < l.e) continue;
        res.push(r);
      }
      return res.slice(0, cap);
    };
    return { underline: spans, emphasis: dedupe(emphasis, 60), highlight: dedupe(highlight, 140), sentenceCount: sents.length };
  }

  // =====================================================================
  // CC additions: driving the editor (selection + simulated shortcuts)
  // =====================================================================
  function rangeAt(ed, a, b, endBias) {
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT);
    const r = document.createRange();
    let pos = 0, n, s0 = false, s1 = false;
    while ((n = w.nextNode())) {
      const s = pos, e = pos + n.nodeValue.length;
      if (!s0 && (endBias ? (a > s && a <= e) : (a >= s && a < e))) { r.setStart(n, a - s); s0 = true; }
      if (!s1 && b > s && b <= e) { r.setEnd(n, b - s); s1 = true; }
      if (s0 && s1) return r;
      pos = e;
    }
    return null;
  }
  function caretOffset(ed) {
    const sel = window.getSelection();
    if (!sel || !sel.anchorNode || !ed.contains(sel.anchorNode)) return -1;
    const r = document.createRange();
    r.setStart(ed, 0); r.setEnd(sel.anchorNode, sel.anchorOffset);
    return r.toString().length;
  }
  function locateTail(ed, joined, caretG, near) {
    const full = ed.textContent;
    if (near === undefined && caretG >= joined.length && full.slice(caretG - joined.length, caretG) === joined) return caretG - joined.length;
    let best = -1, from = 0, i;
    while ((i = full.indexOf(joined, from)) !== -1) {
      if (near === undefined) best = i;
      else if (best === -1 || Math.abs(i - near) < Math.abs(best - near)) best = i;
      from = i + 1;
    }
    return best;
  }
  const waitFor = async (fn, ms) => { const t0 = Date.now(); while (Date.now() - t0 < ms) { if (fn()) return true; await sleep(60); } return !!fn(); };

  // wait for the editor to notice the new selection (selectionchange) instead of a fixed pause
  const settle = (ms) => new Promise((res) => {
    let t;
    const fin = () => { document.removeEventListener('selectionchange', fin); clearTimeout(t); setTimeout(res, 10); };
    document.addEventListener('selectionchange', fin);
    t = setTimeout(fin, ms);
  });
  async function selectRange(ed, r, ms) {
    const sel = window.getSelection();
    ed.focus(); sel.removeAllRanges(); sel.addRange(r);
    await settle(ms || 60);
  }
  // dispatch a key event and resolve as soon as the document mutates (or after maxWait)
  async function fire(ed, ev, maxWait) {
    let n = 0, wake;
    const woke = new Promise((res) => { wake = res; });
    const mo = new MutationObserver((m) => { n += m.length; setTimeout(wake, 8); });
    mo.observe(ed, { subtree: true, childList: true, attributes: true, characterData: true });
    ed.dispatchEvent(ev);
    await Promise.race([woke, sleep(maxWait)]);
    n += mo.takeRecords().length; mo.disconnect();
    return n > 0 ? 'ok' : 'nochange';
  }
  async function press(ed, spec, a, b, delay) {
    const r = rangeAt(ed, a, b);
    if (!r) return 'norange';
    await selectRange(ed, r, delay);
    return fire(ed, keyEventFor(spec), Math.max(80, delay * 2));
  }
  const keyBackspace = () => new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Backspace', code: 'Backspace', keyCode: 8, which: 8 });
  async function deleteRange(ed, a, b, delay) {
    const len0 = ed.textContent.length;
    const r = rangeAt(ed, a, b, true);
    if (!r) return false;
    await selectRange(ed, r, delay);
    await fire(ed, keyBackspace(), 300);
    if (ed.textContent.length < len0) return true;
    try { document.execCommand('delete'); } catch (e) { /* ignore */ }
    await sleep(80);
    return ed.textContent.length < len0;
  }
  async function placeCaret(ed, g) {
    const r = rangeAt(ed, g, g, true);
    if (r) await selectRange(ed, r, 40);
  }

  // =====================================================================
  // CC additions: progress overlay (stays up for the whole command)
  // =====================================================================
  const PILLS = ['Link', 'Fetch', 'Author', 'Insert', 'Cite', 'Tag', 'Shrink', 'Read', 'Underline', 'Emphasis', 'Highlight', 'Trim'];
  const S = { link: 0, fetch: 1, author: 2, insert: 3, cite: 4, tag: 5, shrink: 6, read: 7, underline: 8, emphasis: 9, highlight: 10, trim: 11 };
  function makeHud(api, labels) {
    const noop = { cancelled: false, step() {}, busy() {}, caption() {}, progress() {}, finish() {}, fail() {} };
    if (!labels || !setting(api, 'c2-animation', true)) return noop;
    ensureStyle();
    const state = { cancelled: false };
    const pills = labels.map((l) => h('span', { class: 'ccx-pill' }, l));
    const fill = h('div', { class: 'ccx-fill' });
    const cap = h('div', { class: 'ccx-cap' }, 'Starting…');
    const stop = h('button', { class: 'ccx-btn sm', onclick: () => { state.cancelled = true; cap.textContent = 'Stopping…'; } }, 'Stop');
    const el = h('div', { class: 'ccx ccx-hud' + themeClass() },
      h('div', { class: 'ccx-pills' }, pills), h('div', { class: 'ccx-track' }, fill), h('div', { class: 'ccx-hudrow' }, cap, stop));
    document.body.appendChild(el);
    const end = (ms) => setTimeout(() => el.remove(), ms);
    return Object.assign(state, {
      step(i) { pills.forEach((p, k) => { p.className = 'ccx-pill' + (k < i ? ' done' : k === i ? ' on' : ''); }); fill.className = 'ccx-fill ind'; },
      busy(t) { fill.className = 'ccx-fill ind'; cap.textContent = t; },
      caption(t) { cap.textContent = t; },
      progress(d, t) { fill.className = 'ccx-fill'; fill.style.width = (t ? Math.round(100 * d / t) : 100) + '%'; },
      finish(msg, ms) { pills.forEach((p) => { p.className = 'ccx-pill done'; }); fill.className = 'ccx-fill'; fill.style.width = '100%'; cap.style.whiteSpace = 'normal'; cap.textContent = msg; stop.remove(); end(ms || 5000); },
      fail(msg) { el.classList.add('err'); fill.className = 'ccx-fill'; cap.style.whiteSpace = 'normal'; cap.textContent = msg; stop.remove(); end(8000); },
    });
  }

  // =====================================================================
  // CC additions: reading the document around the cursor (tag + link detection)
  // =====================================================================
  const isBlockEl = (el) => { try { return /^(block|list-item|flex|grid|table|flow-root)/.test(getComputedStyle(el).display); } catch (e) { return false; } };
  const hasBlockChild = (el) => [...el.children].some(isBlockEl);
  function leafBlockOf(ed, node) {
    let el = node && (node.nodeType === 1 ? node : node.parentElement);
    while (el && el !== ed) {
      if (isBlockEl(el) && !hasBlockChild(el)) return el;
      el = el.parentElement;
    }
    return null;
  }
  function prevLeafBlock(ed, el, maxEls) {
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_ELEMENT);
    w.currentNode = el;
    let n, steps = 0;
    while ((n = w.previousNode()) && steps++ < (maxEls || 80)) {
      if (n !== ed && isBlockEl(n) && !hasBlockChild(n)) return n;
    }
    return null;
  }
  // the cursor's line (if it has text) and the nearest non-empty line above it
  function nearbyBlocks(ed) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount) return { cur: null, blocks: [] };
    const r = sel.getRangeAt(0);
    if (!ed.contains(r.startContainer)) return { cur: null, blocks: [] };
    const cur = leafBlockOf(ed, r.startContainer);
    const blocks = [];
    if (!cur) return { cur: null, blocks };
    if (clean(cur.textContent)) blocks.push(cur);
    let p = cur, hops = 0;
    while ((p = prevLeafBlock(ed, p, 80)) && hops++ < 4) {
      if (clean(p.textContent)) { blocks.push(p); break; }
    }
    return { cur, blocks };
  }
  const TAG_SEL = 'h4,[class*="tag" i],[data-type*="tag" i],[data-kind*="tag" i],[data-node-type*="tag" i]';
  function tagSet(api) {
    try {
      const r = api.extractSelection();
      if (r && r.ok && Array.isArray(r.items)) return new Set(r.items.filter((i) => i.kind === 'tag' || i.kind === 'analytic').map((i) => clean(i.text)));
    } catch (e) { /* fall back to DOM hints */ }
    return null;
  }
  function isTagBlock(ed, el, set) {
    const t = clean(el.textContent);
    if (!t || t.length > 600) return false;
    if (set && set.size) return set.has(t);
    const m = el.closest(TAG_SEL);
    return !!(m && ed.contains(m));
  }
  // mode 'near': cursor line or the line above it.  mode 'up': cursor line, then keep walking upward.
  function findDocTag(api, ed, mode) {
    const near = nearbyBlocks(ed);
    if (!near.cur) return null;
    const set = tagSet(api);
    const hit = (b) => ({ text: clean(b.textContent), block: b, onLine: b === near.cur });
    if (mode === 'near') {
      for (const b of near.blocks) if (isTagBlock(ed, b, set)) return hit(b);
      return null;
    }
    let el = near.cur, steps = 0;
    while (el && steps++ < 400) {
      if (clean(el.textContent) && isTagBlock(ed, el, set)) return hit(el);
      el = prevLeafBlock(ed, el, 80);
    }
    return null;
  }
  const URL_ONLY = /^<?(https?:\/\/[^\s<>]+?)>?[.,;]?$/i;
  // a line that is just a link (selected, under the cursor, or right above it)
  function findDocLink(ed) {
    const sel = window.getSelection();
    if (!sel || !sel.rangeCount || !ed.contains(sel.anchorNode)) return null;
    if (!sel.isCollapsed) {
      const m = clean(sel.toString()).match(URL_ONLY);
      if (m) return { url: m[1], range: sel.getRangeAt(0).cloneRange() };
    }
    const near = nearbyBlocks(ed);
    for (const b of near.blocks) {
      const m = clean(b.textContent).match(URL_ONLY);
      if (!m) continue;
      const r = document.createRange();
      r.selectNodeContents(b);
      if (near.cur && near.cur !== b && !clean(near.cur.textContent)) r.setEnd(near.cur, near.cur.childNodes.length);
      return { url: m[1], range: r, block: b };
    }
    return null;
  }

  // =====================================================================
  // CC additions: cite style (located by position, verified, retried)
  // =====================================================================
  async function styleCiteAt(api, ed, lead, citeStart, caretG, delay) {
    const key = clean(String(cfg(api, 'cite-key')));
    const styled = lead + ',';
    await waitFor(() => ed.textContent.includes(lead + ', ['), 4000);
    let a = citeStart;
    if (a < 0 || ed.textContent.slice(a, a + styled.length) !== styled) a = ed.textContent.lastIndexOf(lead + ', [');
    if (a < 0) return 'cite text not found';
    let r = await press(ed, key, a, a + styled.length, Math.max(100, delay));
    if (r !== 'ok') { await sleep(250); r = await press(ed, key, a, a + styled.length, 300); }
    if (caretG >= 0) await placeCaret(ed, caretG);
    return r === 'ok' ? 'applied' : 'no effect (check the cite shortcut ' + key + ')';
  }

  const preview = (paras, r) => paras[r.pi].slice(r.s, r.e).slice(0, 90);

  // tag + shrink + underline + emphasis + highlight + trim, in the order you described
  async function formatCard(api, ed, ctx) {
    const { hud, tagLine, cite, paras, delay } = ctx;
    const keys = {
      tag: clean(String(setting(api, 'key-tag', 'F7'))), shrink: clean(String(setting(api, 'key-shrink', 'Mod-8'))),
      underline: clean(String(setting(api, 'key-underline', 'Mod-u'))), emphasis: clean(String(setting(api, 'key-emphasis', 'F10'))),
      highlight: clean(String(setting(api, 'key-highlight', 'F11'))),
    };
    const stats = { tag: 0, shrink: 0, underline: [0, 0], emphasis: [0, 0], highlight: [0, 0], trimmed: 0 };
    const dead = {};
    const bodyJoined = paras.join('');
    let bodyStart = ctx.start + (tagLine || '').length + cite.length;
    let aiNote = '';
    try {
      // tag
      hud.step(S.tag);
      if (tagLine) {
        hud.busy('Applying the tag: ' + tagLine.slice(0, 70));
        const r = await press(ed, keys.tag, ctx.start, ctx.start + tagLine.length, delay);
        if (r !== 'ok') dead.tag = true; else stats.tag = 1;
        await sleep(100);
        const again = locateTail(ed, bodyJoined, 0, bodyStart);
        if (again >= 0) bodyStart = again;
      } else hud.caption(ctx.docTag ? 'Using the tag already in your doc' : 'No claim available, skipping the tag');

      // shrink
      hud.step(S.shrink); hud.busy('Shrinking body text');
      if (!hud.cancelled) {
        const r = await press(ed, keys.shrink, bodyStart, bodyStart + bodyJoined.length, delay);
        if (r !== 'ok') dead.shrink = true; else stats.shrink = 1;
      }

      // read the card (the AI call started before pasting, so it has usually finished by now)
      hud.step(S.read);
      let aiOut = null;
      if (ctx.aiPromise) {
        hud.busy('Reading the card for your claim (local AI)…');
        const r = await ctx.aiPromise;
        if (r.o) aiOut = r.o; else { aiNote = ' (local AI unavailable, used keyword matching)'; console.warn('[cardcutter-v1] AI pick failed', r.e); }
      }
      const plan = buildPlan(paras, ctx.claim, aiOut);
      const base = []; let acc = bodyStart;
      paras.forEach((p) => { base.push(acc); acc += p.length; });
      const abs = (r) => [base[r.pi] + r.s, base[r.pi] + r.e];

      const runKind = async (kind, idx, list, verb) => {
        hud.step(idx);
        stats[kind] = [0, list.length];
        let misses = 0;
        for (let i = 0; i < list.length; i++) {
          if (hud.cancelled) break;
          hud.caption(verb + ' ' + (i + 1) + '/' + list.length + ': ' + preview(paras, list[i]));
          hud.progress(i, list.length);
          const [a, b] = abs(list[i]);
          const r = await press(ed, keys[kind], a, b, delay);
          if (r === 'ok') { stats[kind][0]++; misses = 0; }
          else if (++misses >= 3) { dead[kind] = true; break; }   // key does nothing: stop wasting time
        }
        hud.progress(list.length, list.length);
      };
      await runKind('underline', S.underline, plan.underline, 'Underlining');
      await runKind('emphasis', S.emphasis, plan.emphasis, 'Emphasising');
      await runKind('highlight', S.highlight, plan.highlight, 'Highlighting');

      // cut off everything below the last highlighted paragraph
      let endG = bodyStart + bodyJoined.length;
      if (!hud.cancelled && setting(api, 'c2-trim', true) && stats.highlight[0] > 0) {
        hud.step(S.trim); hud.busy('Cutting everything below the last highlighted paragraph…');
        const lastPi = Math.max(...plan.highlight.map((r) => r.pi));
        if (lastPi < paras.length - 1) {
          const a = base[lastPi] + paras[lastPi].length;
          const ok = await deleteRange(ed, a, endG, delay);
          if (ok) { stats.trimmed = paras.length - 1 - lastPi; endG = a; } else dead.trim = true;
        }
      }
      await placeCaret(ed, endG);

      const bad = Object.keys(dead).map((k) => k + (keys[k] ? ' (' + keys[k] + ')' : ''));
      const sum = (hud.cancelled ? 'Stopped. ' : '') + 'cite ' + (ctx.citeRes === 'applied' ? '✓' : '✗') + ' · tag ' + (stats.tag ? '✓' : '–') + ' · shrink ' + (stats.shrink ? '✓' : '–') +
        ' · ' + stats.underline[0] + ' underlines · ' + stats.emphasis[0] + ' emphasis · ' + stats.highlight[0] + ' highlights' +
        (stats.trimmed ? ' · trimmed ' + stats.trimmed + ' paragraph' + (stats.trimmed === 1 ? '' : 's') : '') + aiNote +
        (bad.length ? ' · no effect from: ' + bad.join(', ') + ' (fix shortcuts in the plugin’s settings gear)' : '');
      hud.finish(sum, bad.length ? 12000 : 5000);
      return sum;
    } catch (e) {
      console.error('[cardcutter-v1] format failed', e);
      const m = 'formatting stopped: ' + (e && e.message || e);
      hud.fail(m);
      return m;
    }
  }

  // =====================================================================
  // CC additions: clipboard parsing + the C1 / C2 command flow
  // =====================================================================
  // Clipboard shape: first line is the URL, everything under it is the article text.
  // An optional line "Tag: ..." or "Claim: ..." right under the URL supplies the claim for C2.
  function parseClip(text) {
    const lines = String(text || '').replace(/\r/g, '').split('\n');
    let i = 0;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return null;
    const m = lines[i].trim().match(/^<?(https?:\/\/[^\s>]+)>?\s*(.*)$/i);
    if (!m) return null;
    const rest = lines.slice(i + 1);
    if (m[2]) rest.unshift(m[2]);
    let claim = '';
    const ci = rest.findIndex((l) => l.trim());
    if (ci >= 0) {
      const cm = rest[ci].trim().match(/^(?:tag|claim)\s*[:\-–]\s*(.+)$/i);
      if (cm) { claim = clean(cm[1]); rest.splice(ci, 1); }
    }
    const paras = rest.map(clean).filter((l) => l.length >= 2);
    return { url: m[1], claim, paras: paras.join(' ').length > 30 ? paras : [] };
  }

  async function runCut(api, mode, preset) {
    EF.api = api;
    const c2 = mode === 'c2';
    const hud = makeHud(api, c2 ? PILLS : PILLS.slice(0, 5));
    const bail = (msg) => { hud.fail(msg); api.showToast(msg); };
    try {
      hud.step(S.link); hud.busy('Looking for the link…');
      const active = document.activeElement;
      const ed = (active && active.closest && active.closest('.ProseMirror')) || lastEditor;
      const delay = Math.max(15, Number(setting(api, 'c2-delay', 40)) || 40);
      let url = '', pasted = [], claim = '', link = null, docTag = null;

      if (c2 && ed && ed.isConnected) docTag = findDocTag(api, ed, 'near');
      if (preset && preset.url) { url = preset.url; claim = preset.claim || ''; }
      else {
        let clip = '';
        try { clip = await navigator.clipboard.readText(); } catch (e) { /* clipboard blocked */ }
        const p = parseClip(clip);
        if (p && p.paras.length) { url = p.url; pasted = p.paras; claim = p.claim; }        // URL + article text on the clipboard
        else {
          link = (ed && ed.isConnected) ? findDocLink(ed) : null;                            // a link line at the cursor or above
          if (link) url = link.url;
          else if (p) { url = p.url; claim = p.claim; }                                      // bare URL on the clipboard
        }
      }
      if (!url) { hud.busy('Waiting for a link…'); url = await askUrl(); }
      if (!url) { hud.fail('No link given.'); return; }
      if (!/^https?:\/\//i.test(url)) url = 'https://' + url;

      if (c2) {
        if (docTag) claim = docTag.text;                       // the tag already in your doc wins
        else {
          if (!claim) { efLoad(api); claim = clean(EF.claim); }
          if (!claim) { hud.busy('Waiting for a claim…'); claim = clean(await askText('Claim for the tag (blank = no tag)', '') || ''); }
        }
      }

      hud.step(S.fetch); hud.busy(pasted.length ? 'Using your pasted text, reading the page for the citation…' : 'Fetching the article…');
      let res;
      try {
        res = await cut(api, url, { paras: pasted, onStep: (k, t) => { hud.step(S[k]); hud.busy(t); } });
      } catch (e) {
        console.error('[cardcutter-v1]', e);
        bail('Could not fetch that page (' + (e && e.message || e) + '). Tip: paste the URL on line 1 and the article under it, copy it all, then run the command again.');
        return;
      }
      if (hud.cancelled) { hud.fail('Stopped.'); return; }

      const paras = res.paras;
      const tagLine = (c2 && !docTag && claim) ? cap(claim) : '';
      const out = (tagLine ? tagLine + '\n' : '') + (paras.length ? res.cite + '\n' + paras.join('\n') : res.cite);
      const joined = (tagLine || '') + res.cite + paras.join('');
      let aiPromise = null;
      if (c2 && paras.length && aiOn(api)) {
        aiPromise = aiPick(api, sentencesOf(paras), claimTerms(claim), claim || 'the article’s main argument', 40000).then((o) => ({ o }), (e) => ({ e }));
      }

      // paste
      hud.step(S.insert); hud.busy('Pasting the card into your document…');
      let prefix = '';
      if (link) await selectRange(ed, link.range, 150);                       // replace the link line with the card
      else if (docTag && docTag.onLine) {                                      // cursor is on the tag line: start the card on a new line
        const r = document.createRange(); r.selectNodeContents(docTag.block); r.collapse(false);
        await selectRange(ed, r, 100);
        prefix = '\n';
      }
      const ok = insertText(ed, prefix + out);
      if (!ok) { try { await navigator.clipboard.writeText(out); } catch (e) { /* ignore */ } }
      let caretG = -1, start = -1;
      if (ok) {
        await waitFor(() => ed.textContent.includes(res.cite.slice(0, 40)), 5000);
        await sleep(80);
        caretG = caretOffset(ed);
        start = locateTail(ed, joined, caretG);
      }

      // cite style
      hud.step(S.cite); hud.busy('Styling the author and year…');
      let citeRes = 'skipped';
      if (ok && cfg(api, 'cite-style') === 'On') {
        try { citeRes = await styleCiteAt(api, ed, res.lead, start < 0 ? -1 : start + (tagLine || '').length, caretG, delay); }
        catch (e) { citeRes = 'failed: ' + (e && e.message || e); console.warn('[cardcutter-v1] cite style', e); }
      }

      const i = res.info;
      const base = (i.ai === 'off' ? '' : 'AI: ' + i.ai + ' · ') + (ok ? 'Card inserted' : 'Copied, paste with Cmd+V') +
        ` · ${i.bodyChars.toLocaleString()} chars (${i.bodyFrom}) · quals: ${i.qualsFrom} · cite style: ${citeRes}` +
        (docTag ? ' · tag from your doc' : '') + (i.bodyChars < 700 ? ' · body short (paywall/JS page?)' : '');
      if (!c2 || !ok || !paras.length || start < 0) {
        hud.finish(base, citeRes === 'applied' || citeRes === 'skipped' ? 4500 : 10000);
        api.showToast(base);
        return;
      }
      const msg = await formatCard(api, ed, { hud, tagLine, cite: res.cite, paras, start, caretG, claim, aiPromise, delay, docTag, citeRes });
      api.showToast('CC C2: ' + msg);
    } catch (e) {
      console.error('[cardcutter-v1] runCut', e);
      bail('Stopped: ' + (e && e.message || e));
    }
  }

  // =====================================================================
  // CC: SH (Shorten Highlight): un-highlight grammatical filler in the card under the tag
  // =====================================================================
  const FILLER = new Set(('the a an is are was were be been being am do does did have has had will would can could should may might must shall it its this that these those they them their he she his her we our you your and or but so if because than then which who whom whose there here also very just really quite rather too even still such some any each both all').split(' '));
  const PREPS = new Set('of in on at by for with from into about over under to'.split(' '));
  const HL_CLASS = /(^|[\s_-])(highlight|highlighted|hl)([\s_-]|$)/i;
  function isHighlighted(node, ed) {
    let el = node.parentElement;
    while (el && el !== ed) {
      if (isBlockEl(el)) return false;
      if (el.tagName === 'MARK' || HL_CLASS.test(String(el.className || '')) || el.hasAttribute('data-highlight')) return true;
      const bg = getComputedStyle(el).backgroundColor;
      const m = bg && bg.match(/[\d.]+/g);
      if (m && bg !== 'transparent' && !(m.length >= 4 && +m[3] === 0)) return true;
      el = el.parentElement;
    }
    return false;
  }
  // the text blocks that belong to the card headed by tagBlock
  function cardBlocks(ed, tagBlock) {
    const container = tagBlock.parentElement !== ed ? tagBlock.parentElement : null;
    const out = [];
    const w = document.createTreeWalker(ed, NodeFilter.SHOW_ELEMENT);
    w.currentNode = tagBlock;
    let n, steps = 0;
    while ((n = w.nextNode()) && steps++ < 600) {
      if (tagBlock.contains(n)) continue;
      if (container && !container.contains(n)) break;
      if (!(isBlockEl(n) && !hasBlockChild(n))) continue;
      if (/^H[1-6]$/.test(n.tagName) || (n.tagName === tagBlock.tagName && n.className === tagBlock.className)) break;
      out.push(n);
    }
    return out;
  }
  async function shortenHighlight(api) {
    EF.api = api;
    const hud = makeHud(api, ['Find tag', 'Scan', 'Shorten']);
    const bail = (m) => { hud.fail(m); api.showToast(m); };
    try {
      const ed = (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ProseMirror')) || lastEditor;
      if (!ed || !ed.isConnected) return bail('Click into your document first.');
      const delay = Math.max(15, Number(setting(api, 'c2-delay', 40)) || 40);
      const keyHl = clean(String(setting(api, 'key-highlight', 'F11')));
      hud.step(0); hud.busy('Looking for the tag on your line or above…');
      const tag = findDocTag(api, ed, 'up');
      if (!tag) return bail('No tag found on the selected line or above it.');
      hud.step(1); hud.busy('Scanning highlights under: ' + tag.text.slice(0, 70));
      const blocks = cardBlocks(ed, tag.block);
      if (!blocks.length) return bail('Found the tag but no card text under it.');
      const wanted = new Set();
      blocks.forEach((b) => { const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let t; while ((t = tw.nextNode())) wanted.add(t); });
      const info = new Map(); let g = 0;
      const all = document.createTreeWalker(ed, NodeFilter.SHOW_TEXT); let t;
      while ((t = all.nextNode())) {
        const len = t.nodeValue.length;
        if (wanted.has(t)) info.set(t, { g, hl: isHighlighted(t, ed) });
        g += len;
      }
      let anyHl = false; info.forEach((v) => { if (v.hl) anyHl = true; });
      if (!anyHl) {
        console.log('[cardcutter-v1] SH debug: no highlighted text recognised. Card HTML:', blocks.map((b) => b.outerHTML).join('\n').slice(0, 2500));
        return bail('Found the card but could not recognise any highlighted text (see the console for how highlight is drawn).');
      }
      const ranges = [];
      for (const b of blocks) {
        const nodes = [];
        const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
        while ((n = tw.nextNode())) nodes.push(n);
        if (!nodes.length) continue;
        const text = nodes.map((x) => x.nodeValue).join('');
        const flags = []; nodes.forEach((x) => { const hl = info.get(x).hl; for (let k = 0; k < x.nodeValue.length; k++) flags.push(hl); });
        const g0 = info.get(nodes[0]).g;
        const toks = []; const re = /[\p{L}\p{N}$][\p{L}\p{N}'’\-.,%$]*/gu; let m;
        while ((m = re.exec(text))) {
          const w = m[0].replace(/[.,'’\-]+$/, '');
          if (!w || !/[\p{L}\p{N}]/u.test(w)) continue;
          const s = m.index, e = s + w.length;
          const lw = w.toLowerCase();
          const hl = flags.slice(s, e).every(Boolean);
          toks.push({ s, e, lw, hl, filler: hl && FILLER.has(lw), prep: hl && PREPS.has(lw) });
        }
        const content = toks.map((x) => x.hl && !x.filler && !x.prep);
        const gap = (a, c) => /^\s+$/.test(text.slice(toks[a].e, toks[c].s));
        const drop = toks.map((x, i) => x.filler || (x.prep && !(i > 0 && i < toks.length - 1 && content[i - 1] && content[i + 1] && gap(i - 1, i) && gap(i, i + 1))));
        for (let i = 0; i < toks.length;) {
          if (!drop[i]) { i++; continue; }
          let j = i;
          while (j + 1 < toks.length && drop[j + 1] && gap(j, j + 1)) j++;
          ranges.push({ a: g0 + toks[i].s, b: g0 + toks[j].e, words: j - i + 1 });
          i = j + 1;
        }
      }
      if (!ranges.length) { hud.finish('Nothing to shorten: no filler words are highlighted in that card.'); api.showToast('CC SH: no filler highlights found'); return; }
      hud.step(2);
      let done = 0, words = 0, misses = 0;
      for (let i = 0; i < ranges.length; i++) {
        if (hud.cancelled) break;
        hud.caption('Un-highlighting ' + (i + 1) + '/' + ranges.length);
        hud.progress(i, ranges.length);
        const r = await press(ed, keyHl, ranges[i].a, ranges[i].b, delay);
        if (r === 'ok') { done++; words += ranges[i].words; misses = 0; }
        else if (++misses >= 3) break;
      }
      hud.progress(ranges.length, ranges.length);
      const msg = misses >= 3 ? 'The highlight shortcut (' + keyHl + ') did nothing. Set the right one in the plugin settings gear.'
        : (hud.cancelled ? 'Stopped. ' : '') + 'Removed highlighting from ' + words + ' filler word' + (words === 1 ? '' : 's') + ' in ' + done + ' spot' + (done === 1 ? '' : 's');
      if (misses >= 3) hud.fail(msg); else hud.finish(msg);
      api.showToast('CC SH: ' + msg);
    } catch (e) {
      console.error('[cardcutter-v1] SH', e);
      bail('Stopped: ' + (e && e.message || e));
    }
  }

  // Inserts a throwaway line and checks that each formatting shortcut actually changes the document.
  async function testKeys(api) {
    const ed = (document.activeElement && document.activeElement.closest && document.activeElement.closest('.ProseMirror')) || lastEditor;
    if (!ed) { api.showToast('Click into a document first.'); return; }
    const line = 'CC shortcut test line';
    if (!insertText(ed, line)) { api.showToast('Could not insert into the editor.'); return; }
    await waitFor(() => ed.textContent.includes(line), 3000);
    await sleep(100);
    const end = caretOffset(ed);
    const start = end - line.length;
    if (end < 0 || ed.textContent.slice(start, end) !== line) { api.showToast('Inserted the test line but could not find it again.'); return; }
    const delay = Math.max(15, Number(setting(api, 'c2-delay', 40)) || 40);
    const rows = [['Cite', null, null], ['Shrink', 'key-shrink', 'Mod-8'], ['Underline', 'key-underline', 'Mod-u'], ['Emphasis', 'key-emphasis', 'F10'], ['Highlight', 'key-highlight', 'F11']];
    const report = [];
    for (const [label, k, d] of rows) {
      const spec = k ? clean(String(setting(api, k, d))) : clean(String(cfg(api, 'cite-key')));
      const r = await press(ed, spec, start + 3, start + 11, Math.max(100, delay));
      if (r === 'ok') await press(ed, spec, start + 3, start + 11, Math.max(100, delay)); // toggle back off
      report.push(label + ' (' + spec + '): ' + (r === 'ok' ? 'works' : 'NO EFFECT'));
    }
    api.showToast(report.join(' · ') + ' · delete the test line when done');
  }

  // =====================================================================
  // CC E: Evidence Finder
  // =====================================================================
  const EF = { api: null, loaded: false, claim: '', sources: [], busy: false, status: '', run: 0, adding: false, root: null, claimEl: null, listEl: null, statusEl: null, findBtn: null };
  const CACHE = new Map();

  const normUrl = (u) => {
    try {
      const x = new URL(u); x.hash = '';
      [...x.searchParams.keys()].forEach((k) => /^(utm_|fbclid|gclid)/i.test(k) && x.searchParams.delete(k));
      return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '') + x.search).toLowerCase();
    } catch (e) { return u; }
  };
  function efSave() {
    try { EF.api.storage.set('ef-state', { claim: EF.claim, sources: EF.sources.filter((s) => s.state === 'ok') }); } catch (e) { /* storage unavailable */ }
  }
  function efLoad(api) {
    if (EF.loaded) return;
    EF.loaded = true;
    try {
      const st = api.storage.get('ef-state');
      if (st && typeof st === 'object') { EF.claim = st.claim || ''; EF.sources = Array.isArray(st.sources) ? st.sources : []; }
    } catch (e) { /* ignore */ }
  }

  // ---------- classify the source ----------
  const JOURNALS = ['nature.com', 'science.org', 'sciencedirect.com', 'jstor.org', 'springer.com', 'wiley.com', 'pnas.org', 'jamanetwork.com', 'nejm.org', 'thelancet.com', 'bmj.com', 'ssrn.com', 'arxiv.org', 'tandfonline.com', 'sagepub.com', 'oup.com', 'cambridge.org', 'plos.org', 'frontiersin.org', 'mdpi.com', 'healthaffairs.org', 'annualreviews.org', 'ncbi.nlm.nih.gov', 'researchgate.net', 'cell.com', 'nber.org', 'academic.oup.com'];
  const THINK = ['brookings.edu', 'rand.org', 'cato.org', 'heritage.org', 'aei.org', 'cfr.org', 'urban.org', 'kff.org', 'commonwealthfund.org', 'piie.com', 'csis.org', 'carnegieendowment.org', 'hoover.org', 'americanprogress.org', 'manhattan-institute.org', 'manhattan.institute', 'mercatus.org', 'taxfoundation.org', 'epi.org', 'cbpp.org', 'bipartisanpolicy.org', 'pewresearch.org', 'pewtrusts.org', 'rff.org', 'reason.org', 'niskanencenter.org', 'thirdway.org', 'chathamhouse.org', 'iiss.org', 'stimson.org', 'atlanticcouncil.org', 'wilsoncenter.org', 'newamerica.org', 'itif.org', 'fas.org', 'ifs.org.uk', 'cigionline.org', 'lowyinstitute.org', 'belfercenter.org', 'crfb.org', 'ncpa.org', 'fraserinstitute.org', 'hudson.org', 'usip.org', 'brookings.org', 'aspeninstitute.org', 'rff.org', 'resources.org', 'peterson.org', 'ips-dc.org', 'dissentmagazine.org'];
  const INTERGOV = ['europa.eu', 'un.org', 'who.int', 'worldbank.org', 'imf.org', 'oecd.org', 'gc.ca', 'parliament.uk'];
  const BLOGS = ['medium.com', 'substack.com', 'wordpress.com', 'blogspot.com', 'tumblr.com', 'ghost.io', 'wixsite.com'];
  const SKIP_HOSTS = ['wikipedia.org', 'youtube.com', 'youtu.be', 'facebook.com', 'twitter.com', 'x.com', 'reddit.com', 'quora.com', 'pinterest.com', 'instagram.com', 'tiktok.com', 'amazon.com', 'linkedin.com', 'duckduckgo.com', 'google.com', 'bing.com', 'scribd.com', 'slideshare.net', 'archive.org'];
  const hostIn = (host, arr) => arr.some((d) => host === d || host.endsWith('.' + d));

  function classify(host, url, m) {
    let path = '';
    try { path = new URL(url).pathname.toLowerCase(); } catch (e) { /* ignore */ }
    if (m.journalTitle || /Scholarly/i.test(m.jsonType || '') || hostIn(host, JOURNALS)) return { type: 'Journal / academic publisher', cred: 92 };
    if (hostIn(host, THINK)) return { type: 'Think tank / research institute', cred: 80 };
    if (/(^|\.)(gov|mil)(\.[a-z]{2})?$/.test(host) || hostIn(host, INTERGOV)) return { type: 'Official government website', cred: 88 };
    if (/(^|\.)(edu|ac\.[a-z]{2}|edu\.[a-z]{2})$/.test(host)) return { type: 'University / academic site', cred: 84 };
    if (/\/(opinion|opinions|editorial|editorials|commentary|op-ed|oped|perspective|perspectives)\//.test(path)) return { type: 'Opinion / editorial', cred: 50 };
    if (hostIn(host, BLOGS) || /\/blogs?\//.test(path)) return { type: 'Blog / newsletter', cred: 35 };
    const major = PUBS[host] || PUBS[host.split('.').slice(-2).join('.')];
    if (major) return { type: 'News media', cred: 72 };
    if (/NewsArticle|Report/i.test(m.jsonType || '')) return { type: 'News media', cred: 60 };
    if (/\.org$/.test(host)) return { type: 'Nonprofit / advocacy organization', cred: 55 };
    return { type: 'Website', cred: 42 };
  }

  // ---------- judge a source against the claim ----------
  function segText(sents, i) {
    let t = sents[i].text;
    const nx = sents[i + 1];
    if (t.length < 150 && nx && nx.pi === sents[i].pi) t += ' ' + nx.text;
    if (t.length > 520) t = t.slice(0, 520).replace(/\s+\S*$/, '') + '…';
    return t;
  }
  function pickSegments(ranked, k) {
    const picked = [];
    for (const c of ranked) {
      if (picked.length >= k) break;
      if (picked.some((p) => Math.abs(p - c.i) <= 1)) continue;
      picked.push(c.i);
    }
    return picked.sort((a, b) => a - b);
  }
  function heurRelevance(sents, terms, ranked, picks) {
    if (!sents.length || !terms.length) return 0;
    const tot = terms.reduce((a, t) => a + t.w, 0) || 1;
    const covOf = (text) => { const set = new Set(wordList(text).map(stem)); return terms.reduce((a, t) => a + (set.has(t.stem) ? t.w : 0), 0) / tot; };
    const cov = covOf(picks.map((i) => sents[i].text).join(' '));
    const docCov = covOf(sents.map((x) => x.text).join(' '));
    const hits = ranked.filter((r) => r.sc >= 0.5).length;
    const density = Math.min(1, hits / Math.max(3, sents.length * 0.05));
    return Math.round(100 * (0.5 * cov + 0.25 * density + 0.25 * docCov));
  }
  const ageYears = (d) => (d ? (new Date().getFullYear() + new Date().getMonth() / 12) - (d.y + ((d.m || 6) - 1) / 12) : null);

  async function judgeMeta(api, claim, m, state) {
    const { type, cred } = classify(m.host, m.url, m);
    const terms = claimTerms(claim);
    const sents = sentencesOf(m.paras);
    const chars = m.paras.reduce((a, p) => a + p.length, 0);
    const ranked = rankSents(sents, terms);
    let picks = pickSegments(ranked, 3);
    let rel = heurRelevance(sents, terms, ranked, picks);
    let usedAi = false;
    if (state.ai && ranked.length) {
      try {
        const top = ranked.slice(0, 10).map((c) => c.i).sort((a, b) => a - b);
        const list = top.map((si, n) => (n + 1) + '. ' + segText(sents, si).slice(0, 420)).join('\n');
        const prompt = 'You are judging evidence for a policy debate card.\nCLAIM: "' + claim + '"\nARTICLE: "' + (m.title || '') + '" (' + m.pub + ')\n' +
          'Below are numbered passages from the article. Decide whether the article SUPPORTS the claim, OPPOSES it, or is NEUTRAL or off-topic, ' +
          'and how well the best passages prove the claim (0-100). Pick up to 3 passage numbers that most directly support the claim (fewer if none do).\n' +
          'Reply with JSON only: {"stance":"supports|opposes|neutral","relevance":0-100,"best":[numbers]}\nPASSAGES:\n' + list;
        const out = await ollamaJson(api, prompt, 60000);
        const best = [...new Set([].concat(out.best || []).map((n) => parseInt(n, 10) - 1).filter((n) => n >= 0 && n < top.length).map((n) => top[n]))].slice(0, 3);
        const llm = Math.max(0, Math.min(100, Number(out.relevance)));
        if (best.length && isFinite(llm)) {
          picks = best.sort((a, b) => a - b);
          rel = Math.round(0.7 * llm + 0.3 * rel);
          const st = String(out.stance || '').toLowerCase();
          if (st === 'opposes') rel = Math.round(rel * 0.3);
          else if (st === 'neutral') rel = Math.round(rel * 0.7);
          usedAi = true;
        }
      } catch (e) {
        state.ai = false; state.aiFailed = true;
        console.warn('[cardcutter-v1] AI judge failed, using keyword matching', e);
      }
    }
    let bonus = m.quals ? 4 : 0;
    const age = ageYears(m.dateParts);
    bonus += age === null ? -3 : age <= 1 ? 5 : age <= 3 ? 3 : age <= 6 ? 0 : age <= 10 ? -3 : -7;
    if (chars < 1500) bonus -= 10;
    const score = Math.max(1, Math.min(99, Math.round(0.6 * rel + 0.4 * cred + bonus)));
    return {
      id: uid(), url: m.url, title: m.title || m.host, type, score,
      dateText: m.dateParts ? formatDate(m.dateParts, 'M/D/YYYY') : 'n.d.',
      author: (m.authors || []).join(', '), quals: m.quals || '',
      segments: picks.map((i) => segText(sents, i)), readable: chars >= 600, usedAi, state: 'ok', manual: false,
    };
  }
  async function evaluate(api, claim, url, state) {
    const key = normUrl(url);
    let m = CACHE.get(key);
    if (!m) { const res = await cut(api, url); m = res.meta; CACHE.set(key, m); }
    return judgeMeta(api, claim, m, state);
  }

  // ---------- search ----------
  async function ddgSearch(query, prefix) {
    const d = await fetchDoc('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query), prefix);
    return [...d.querySelectorAll('.result')].map((r) => {
      const a = r.querySelector('a.result__a');
      if (!a) return null;
      let href = a.getAttribute('href') || '';
      try { const u = new URL(href, 'https://duckduckgo.com'); href = u.searchParams.get('uddg') || u.toString(); } catch (e) { /* keep raw */ }
      if (!/^https?:/i.test(href)) return null;
      return { url: href, title: clean(a.textContent) };
    }).filter(Boolean);
  }
  async function gatherCandidates(api, claim, alive) {
    const prefix = clean(cfg(api, 'fetch-prefix'));
    const base = claim.replace(/[.?!]+$/, '');
    const queries = [base, base + ' study evidence', base + ' policy analysis report', base + ' peer-reviewed research', base + ' site:.gov', base + ' site:.edu', base + ' think tank'];
    const seen = new Map(); let got = 0;
    for (let q = 0; q < queries.length && alive(); q++) {
      setStatus('Searching… (' + (q + 1) + '/' + queries.length + ')');
      try {
        const rs = await ddgSearch(queries[q], prefix);
        rs.forEach((r, pos) => {
          let host = '';
          try { host = new URL(r.url).hostname.replace(/^www\./, ''); } catch (e) { return; }
          if (hostIn(host, SKIP_HOSTS) || /\.pdf($|\?)/i.test(r.url)) return;
          const k = normUrl(r.url);
          if (seen.has(k)) return;
          got++;
          const prior = classify(host, r.url, {}).cred;
          seen.set(k, { url: r.url, prio: prior - pos * 1.5 - q * 0.5 });
        });
      } catch (e) { console.warn('[cardcutter-v1] search failed', e); }
      await sleep(350);
    }
    return [...seen.values()].sort((a, b) => b.prio - a.prio).map((x) => x.url);
  }

  async function pool(items, n, fn, stop) {
    let i = 0;
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
      while (i < items.length && !stop()) { const it = items[i++]; await fn(it); }
    }));
  }

  async function findEvidence() {
    const api = EF.api;
    const claim = clean(EF.claim);
    if (!claim) { setStatus('Type a claim first.'); return; }
    const run = ++EF.run;
    const alive = () => EF.run === run;
    EF.busy = true; EF.adding = false;
    const manual = EF.sources.filter((s) => s.manual && s.state === 'ok').map((s) => s.url);
    EF.sources = manual.map((u) => ({ id: uid(), url: u, state: 'loading', manual: true }));
    const state = { ai: aiOn(api), aiFailed: false };
    const max = Math.max(5, Math.min(10, Number(setting(api, 'ef-max', 10)) || 10));
    efSave(); paint();
    try {
      await pool(EF.sources.slice(), 2, async (ph) => {
        try {
          const s = await evaluate(api, claim, ph.url, state);
          if (!alive()) return;
          Object.assign(ph, s, { id: ph.id, manual: true });
        } catch (e) { if (alive()) Object.assign(ph, { state: 'error', err: String(e && e.message || e) }); }
        paint();
      }, () => !alive());
      if (!alive()) return;

      const cands = await gatherCandidates(api, claim, alive);
      if (!alive()) return;
      if (!cands.length) { setStatus('No search results came back (the search engine may be blocking requests). Paste your own links with the + button.'); return; }
      const have = new Set(EF.sources.map((s) => normUrl(s.url)));
      const queue = cands.filter((u) => !have.has(normUrl(u))).slice(0, 24);
      const autoOk = () => EF.sources.filter((s) => !s.manual && s.state === 'ok').length;
      let n = 0;
      await pool(queue, 3, async (u) => {
        if (!alive() || autoOk() >= max + 3) return;
        setStatus('Reading sources… ' + (++n) + '/' + queue.length + ' · ' + autoOk() + ' usable so far');
        try {
          const s = await evaluate(api, claim, u, state);
          if (!alive() || !s.readable || autoOk() >= max + 3) return;
          EF.sources.push(s); paint();
        } catch (e) { console.warn('[cardcutter-v1] skipped', u, e); }
      }, () => !alive() || autoOk() >= max + 3);
      if (!alive()) return;

      const keepers = EF.sources.filter((s) => s.manual || s.state !== 'ok');
      let auto = EF.sources.filter((s) => !s.manual && s.state === 'ok').sort((a, b) => b.score - a.score);
      auto = auto.filter((s, i) => i < 5 || s.score >= 25).slice(0, max);
      EF.sources = keepers.concat(auto);
      const note = state.aiFailed ? ' Local AI was unreachable, so scores use keyword matching.' : '';
      setStatus((auto.length < 5 ? 'Only ' + auto.length + ' usable source' + (auto.length === 1 ? '' : 's') + ' found. Add more with +.' : 'Done.') + note);
    } finally {
      if (alive()) { EF.busy = false; efSave(); paint(); }
    }
  }

  async function addManual(url) {
    const api = EF.api;
    const claim = clean(EF.claim);
    if (!claim) { setStatus('Enter your claim first, so the link can be judged against it.'); return; }
    url = clean(url);
    if (!url) return;
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
    if (EF.sources.some((s) => normUrl(s.url) === normUrl(url))) { setStatus('That link is already in the list.'); return; }
    const run = EF.run;
    const ph = { id: uid(), url, state: 'loading', manual: true };
    EF.sources.unshift(ph); EF.adding = false; paint();
    try {
      const s = await evaluate(api, claim, url, { ai: aiOn(api), aiFailed: false });
      if (EF.run !== run || !EF.sources.includes(ph)) return;
      Object.assign(ph, s, { id: ph.id, manual: true });
    } catch (e) {
      if (EF.run !== run) return;
      Object.assign(ph, { state: 'error', err: String(e && e.message || e) });
    }
    efSave(); paint();
  }

  // ---------- the window ----------
  function setStatus(t) { EF.status = t; if (EF.statusEl) EF.statusEl.textContent = t; }
  const tier = (s) => (s >= 75 ? 'hi' : s >= 50 ? 'mid' : 'lo');
  function cardText(s) {
    const head = '(' + s.score + '%, ' + s.dateText + ') - ' + s.url + ', ' + s.type + ', ' + s.title;
    const quals = s.quals ? (s.author ? s.author + ': ' : '') + s.quals : (s.author ? s.author + ': quals not found' : 'Author quals not found');
    return head + '\n\n' + (s.segments.length ? s.segments.join('\n') : '(no passage matched)') + '\n\n' + quals;
  }
  function sourceCard(s) {
    const api = EF.api;
    const remove = () => { EF.sources = EF.sources.filter((x) => x.id !== s.id); efSave(); paint(); };
    if (s.state === 'loading') return h('div', { class: 'ccx-card load' }, 'Analyzing ', s.url, ' …');
    if (s.state === 'error') {
      return h('div', { class: 'ccx-card' }, h('div', { class: 'ccx-head' }, 'Could not read ', h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url), ' (' + (s.err || 'error') + '). Many sites block direct requests; a fetch proxy can be set in CC settings.'),
        h('div', { class: 'ccx-act' }, h('button', { onclick: remove }, 'Remove')));
    }
    const quals = s.quals ? (s.author ? s.author + ': ' : '') + s.quals : (s.author ? s.author + ': quals not found' : 'Author quals not found');
    return h('div', { class: 'ccx-card' },
      h('div', { class: 'ccx-head' },
        h('span', { class: 'ccx-pct ' + tier(s.score) }, '(' + s.score + '%, ' + s.dateText + ')'), ' - ',
        h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, s.url), ', ' + s.type + ', ' + s.title),
      h('div', { class: 'ccx-segs' }, s.segments.length ? s.segments.map((t) => h('div', { class: 'ccx-seg' }, t)) : h('div', { class: 'ccx-seg' }, s.readable === false ? 'Could not read the article text (paywall or script-rendered page).' : 'No passage matched the claim closely.')),
      h('div', { class: 'ccx-quals' }, quals),
      h('div', { class: 'ccx-act' },
        h('button', { onclick: async () => { try { await navigator.clipboard.writeText(cardText(s)); api.showToast('Copied'); } catch (e) { api.showToast('Copy failed'); } } }, 'Copy'),
        h('button', { onclick: () => { closeFinder(); runCut(api, 'c2', { url: s.url, claim: clean(EF.claim) }); } }, 'Cut card (C2)'),
        h('button', { onclick: remove }, 'Remove')));
  }
  function addBox() {
    const input = h('input', { placeholder: 'Paste an article URL to judge against your claim…', spellcheck: 'false' });
    const go = () => addManual(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    setTimeout(() => input.focus(), 0);
    return h('div', { class: 'ccx-add' }, input,
      h('button', { class: 'ccx-btn pri', onclick: go }, 'Judge'),
      h('button', { class: 'ccx-btn', onclick: () => { EF.adding = false; paint(); } }, 'Cancel'));
  }
  function paint() {
    if (!EF.root) return;
    if (EF.statusEl) EF.statusEl.textContent = EF.status;
    if (EF.findBtn) { EF.findBtn.textContent = EF.busy ? 'Stop' : 'Find'; }
    const list = EF.listEl;
    list.textContent = '';
    if (EF.adding) list.append(addBox());
    const pending = EF.sources.filter((s) => s.state !== 'ok');
    const ok = EF.sources.filter((s) => s.state === 'ok').sort((a, b) => b.score - a.score);
    pending.concat(ok).forEach((s) => list.append(sourceCard(s)));
    if (!pending.length && !ok.length && !EF.adding) {
      list.append(h('div', { class: 'ccx-empty' }, EF.busy ? 'Working…' : 'Enter a claim and click Find, or use + to judge your own link.'));
    }
  }
  function resetFinder() {
    EF.run++; EF.busy = false; EF.sources = []; EF.claim = ''; EF.adding = false; EF.status = '';
    CACHE.clear();
    if (EF.claimEl) { EF.claimEl.value = ''; EF.claimEl.focus(); }
    efSave(); paint();
  }
  function closeFinder() {
    if (EF.claimEl) EF.claim = EF.claimEl.value;
    efSave();
    if (EF.root) EF.root.remove();
    EF.root = null; EF.claimEl = EF.listEl = EF.statusEl = EF.findBtn = null;
  }
  function openFinder(api) {
    EF.api = api; efLoad(api); ensureStyle();
    if (EF.root) { closeFinder(); return; }
    const ta = h('textarea', { placeholder: 'Claim to find evidence for, e.g. "Single payer health insurance is bad"', spellcheck: 'true' });
    ta.value = EF.claim;
    ta.addEventListener('input', () => { EF.claim = ta.value; });
    const find = h('button', { class: 'ccx-btn pri', onclick: () => { EF.claim = ta.value; if (EF.busy) { EF.run++; EF.busy = false; setStatus('Stopped.'); paint(); } else findEvidence(); } }, 'Find');
    ta.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); find.click(); } });
    const status = h('span', {}, EF.status);
    const list = h('div', { class: 'ccx-list' });
    const panel = h('div', { class: 'ccx-panel' },
      h('div', { class: 'ccx-top' }, h('div', { class: 'ccx-title' }, 'Evidence Finder', h('small', {}, 'CC E')),
        h('button', { class: 'ccx-ico', title: 'Close (your sources are kept)', onclick: closeFinder }, '×')),
      h('div', { class: 'ccx-claim' }, ta, find),
      h('div', { class: 'ccx-bar' }, status, h('span', { class: 'sp' }),
        h('button', { class: 'ccx-btn sm', title: 'Add your own link', onclick: () => { EF.adding = true; paint(); } }, '+ Add source'),
        h('button', { class: 'ccx-btn sm', title: 'Clear every source and start over', onclick: resetFinder }, '↻ Reset')),
      list);
    const root = h('div', { class: 'ccx ccx-back' + themeClass() }, panel);
    root.addEventListener('mousedown', (e) => { if (e.target === root) closeFinder(); });
    ['keydown', 'keyup', 'keypress'].forEach((t) => root.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') closeFinder(); }));
    document.body.appendChild(root);
    Object.assign(EF, { root, claimEl: ta, listEl: list, statusEl: status, findBtn: find });
    paint();
    setTimeout(() => ta.focus(), 0);
  }
  // =====================================================================
  // CC Flow: data model
  // =====================================================================
  const SPEECHES = ['1AC', '1NC', '2AC', '2NC/1NR', '1AR', '2NR', '2AR'];
  const TEAM = { '1AC': 'A', '1NC': 'N', '2AC': 'A', '2NC/1NR': 'N', '1AR': 'A', '2NR': 'N', '2AR': 'A' };
  const FLOW_TYPES = [['adv', 'Advantage'], ['solv', 'Solvency/Inherency'], ['da', 'DA'], ['cp', 'CP'], ['k', 'K'], ['t', 'T'], ['theory', 'Theory'], ['other', 'Other']];
  const TYPE_LABEL = Object.fromEntries(FLOW_TYPES);
  const OFFCASE = new Set(['da', 'cp', 'k', 't', 'theory']);
  const colsFor = (type) => (OFFCASE.has(type) ? SPEECHES.slice(1) : SPEECHES);
  const CARD_TYPES = ['uniqueness', 'link', 'internal link', 'impact', 'inherency', 'solvency'];

  const FL = { api: null, loaded: false, flows: [], active: null, flowed: {}, roadmap: [], lastSpeech: '', view: 'closed', lastMode: 'full', root: null, ui: {}, pending: false };
  function flSave() {
    try { FL.api.storage.set('flow-state', { flows: FL.flows, active: FL.active, flowed: FL.flowed, roadmap: FL.roadmap, lastSpeech: FL.lastSpeech }); } catch (e) { /* storage unavailable */ }
  }
  function flLoad(api) {
    FL.api = api;
    if (FL.loaded) return;
    FL.loaded = true;
    try {
      const s = api.storage.get('flow-state');
      if (s && typeof s === 'object') {
        FL.flows = Array.isArray(s.flows) ? s.flows : []; FL.active = s.active || null;
        FL.flowed = s.flowed || {}; FL.roadmap = s.roadmap || []; FL.lastSpeech = s.lastSpeech || '';
      }
    } catch (e) { /* ignore */ }
  }

  const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  function normSpeech(raw) {
    const s = String(raw || '').toLowerCase().replace(/[^a-z0-9/]/g, '');
    if (!s) return null;
    if (/^(cx|cross)/.test(s)) return 'CX';
    const m = { '1ac': '1AC', '1nc': '1NC', '2ac': '2AC', '2nc': '2NC/1NR', '1nr': '2NC/1NR', '2nc/1nr': '2NC/1NR', '2nc1nr': '2NC/1NR', '1nr/2nc': '2NC/1NR', '1nr2nc': '2NC/1NR', '1ar': '1AR', '2nr': '2NR', '2ar': '2AR' };
    return m[s] || null;
  }
  function guessType(name) {
    const w = norm(name);
    if (/\b(da|disad|disadvantage)\b/.test(w)) return 'da';
    if (/\b(cp|counterplan|counter plan)\b/.test(w)) return 'cp';
    if (/\bk\b|kritik|critique/.test(w)) return 'k';
    if (/^t( |$)|topicality/.test(w)) return 't';
    if (/theory|condo|conditionality|\bpics?\b|\bperm\b|vagueness|abuse/.test(w)) return 'theory';
    if (/solvency|inherency|\bplan\b/.test(w)) return 'solv';
    if (/advantage|\badv\b|contention/.test(w)) return 'adv';
    return 'other';
  }
  function findFlow(name) {
    const n = norm(name);
    if (!n) return null;
    return FL.flows.find((f) => norm(f.name) === n) ||
      FL.flows.find((f) => { const m = norm(f.name); return m && Math.min(m.length, n.length) >= 4 && (m.includes(n) || n.includes(m)); }) || null;
  }
  function addFlow(name, type) {
    const f = { id: uid(), name: clean(name) || TYPE_LABEL[type] || 'Flow', type: type || 'other', lines: [] };
    FL.flows.push(f);
    if (!FL.active) FL.active = f.id;
    return f;
  }
  const addLine = (f, label) => { const l = { id: uid(), label: clean(label) || '', cells: {} }; f.lines.push(l); return l; };
  const addEntry = (line, col, e) => { (line.cells[col] = line.cells[col] || []).push(e); return e; };
  const mkEntry = (o) => ({ id: uid(), kind: o.kind || 'card', label: o.label || '', text: o.text || '', skipped: !!o.skipped });
  // card roles, shown right before the author: UQ, Link, I/L, !, Solvency, Inherency
  const TYPE_SHORT = { uniqueness: 'UQ', link: 'Link', 'internal link': 'I/L', impact: '!', solvency: 'Solvency', inherency: 'Inherency' };
  const typeShort = (t) => TYPE_SHORT[t] || '';
  const TYPE_ALIAS = { uq: 'uniqueness', unique: 'uniqueness', uniqueness: 'uniqueness', link: 'link', links: 'link', il: 'internal link', 'i/l': 'internal link', 'i l': 'internal link', internal: 'internal link', 'internal link': 'internal link', impact: 'impact', impacts: 'impact', '!': 'impact', solvency: 'solvency', solves: 'solvency', solve: 'solvency', inherency: 'inherency', analytic: 'analytic' };
  const normType = (s) => TYPE_ALIAS[String(s || '').toLowerCase().replace(/[^a-z0-9/! ]/g, '').trim()] || '';
  // debaters often name their own sub-sections ("Uniqueness", "Link", "Impact"): trust that over a guess
  function headType(p) {
    const h = clean(p.heads.block || p.heading || '');
    const m = (re) => re.test(h);
    if (m(/^(?:\d+\W*)?(?:internal link|i\/l|il)\b/i)) return 'internal link';
    if (m(/^(?:\d+\W*)?(?:uniqueness|uq)\b/i)) return 'uniqueness';
    if (m(/^(?:\d+\W*)?link\b/i)) return 'link';
    if (m(/^(?:\d+\W*)?impact\b/i)) return 'impact';
    if (m(/^(?:\d+\W*)?solvency\b/i)) return 'solvency';
    if (m(/^(?:\d+\W*)?inherency\b/i)) return 'inherency';
    return '';
  }
  // an advantage normally runs UQ, link, internal link(s), impact
  function positionType(p) {
    if (!p.of || p.of < 3) return '';
    if (p.pos === 0) return 'uniqueness';
    if (p.pos === p.of - 1) return 'impact';
    return p.pos === 1 ? 'link' : 'internal link';
  }
  // "UQ — Smith 24", then what the card says and its warrant
  function cardEntry(a, skipped) {
    const who = a.kind === 'analytic' ? 'Analytic' : a.cite;
    const label = [typeShort(a.type), who].filter(Boolean).join(' — ') || 'Card';
    const text = [a.says, a.warrant ? 'Warrant: ' + a.warrant : ''].filter(Boolean).join('\n');
    return mkEntry({ kind: a.kind === 'analytic' ? 'analytic' : 'card', label, text, skipped });
  }

  // dropped = one team made an argument and the other team's next flowed speech left that line empty
  function droppedMap(f, cols) {
    const out = new Set();
    for (const l of f.lines) {
      cols.forEach((c, i) => {
        if (!(l.cells[c] || []).some((e) => !e.skipped && e.kind !== 'cx')) return;
        for (let j = i + 1; j < cols.length; j++) {
          if (TEAM[cols[j]] === TEAM[c]) continue;
          if (!FL.flowed[cols[j]]) break;
          if (!(l.cells[cols[j]] || []).some((e) => !e.skipped && e.kind !== 'cx')) out.add(l.id + '|' + cols[j]);
          break;
        }
      });
    }
    return out;
  }

  // =====================================================================
  // CC Flow: reading the speech doc
  // =====================================================================
  function shortCite(text) {
    const t = clean(text);
    const m = t.match(/^([A-Z][\p{L}'’\-]+(?:\s+(?:and|&)\s+[A-Z][\p{L}'’\-]+|\s+et al\.?)?)[\s,]+'?(\d{2}|\d{4})\b/u);
    return m ? m[1] + ' ' + m[2].slice(-2) : t.slice(0, 24);
  }
  // scenario labels ("Advantage 1", "Spending DA") and the plan text are not cards
  const LABEL_ADV = /^(?:the\s+)?(?:advantage|adv\.?|scenario|contention)\b[\s#\d:./\-–—)]*[^.!?]{0,70}$/i;
  const LABEL_KW = /^(?:solvency|inherency|uniqueness|uq|link|internal link|impact|case|1ac)[\s#\d:./\-–—)]*$/i;
  const isPlanText = (t) => t.length < 600 && (/^\s*plan(?: text)?\s*[:\-–—]\s*\S/i.test(t) || /\b(?:united states|u\.s\.|usfg|federal government|congress)\b[^.]{0,120}\bshould\b/i.test(t));
  // extractSelection items -> one record per tag / analytic, with its headings, cite and undertags
  function parseItems(items) {
    const raw = []; let cur = null;
    for (const it of items) {
      if (it.kind === 'pocket' || it.kind === 'hat' || it.kind === 'block') { raw.push({ k: 'head', kind: it.kind, text: it.text }); cur = null; continue; }
      if (it.kind === 'tag' || it.kind === 'analytic') { cur = { k: 'item', kind: it.kind, tag: it.text, cite: '', under: [] }; raw.push(cur); continue; }
      if (it.kind === 'cite' && cur && !cur.cite) cur.cite = shortCite(it.text);
      else if (it.kind === 'undertag' && cur) cur.under.push(it.text);
    }
    const out = []; out.plan = '';
    const heads = { pocket: '', hat: '', block: '' };
    let afterPlan = false;
    for (const r of raw) {
      if (r.k === 'head') {
        heads[r.kind] = r.text;
        if (r.kind === 'pocket') { heads.hat = ''; heads.block = ''; }
        if (r.kind === 'hat') heads.block = '';
        if (!out.plan && isPlanText(r.text)) { out.plan = r.text; afterPlan = true; }
        else if (/^\s*(the\s+)?plan(\s+text)?\s*$/i.test(r.text)) afterPlan = true;
        else if (ADV_RE.test(r.text)) afterPlan = false;
        continue;
      }
      const bare = !r.cite && !r.under.length;
      if (bare && r.tag.length <= 90) {
        if (LABEL_ADV.test(r.tag)) { heads.hat = r.tag; heads.block = ''; afterPlan = false; continue; }
        if (LABEL_KW.test(r.tag)) {
          if (/^(?:solvency|inherency|case|1ac)/i.test(r.tag)) { heads.hat = r.tag; heads.block = ''; } else heads.block = r.tag;
          continue;
        }
        const g = guessType(r.tag);
        if (['da', 'cp', 'k', 't'].includes(g) && r.tag.split(/\s+/).length <= 4 && !/[.!?]/.test(r.tag)) { heads.block = r.tag; continue; }
      }
      if (bare && !out.plan && isPlanText(r.tag)) { out.plan = r.tag; afterPlan = true; continue; }
      out.push({ idx: out.length, kind: r.kind, tag: r.tag, cite: r.cite, under: r.under, body: '', heading: heads.block || heads.hat || heads.pocket || '', heads: Object.assign({}, heads), afterPlan });
    }
    return out;
  }
  function isUnderlined(node, ed) {
    let el = node.parentElement;
    while (el && el !== ed) {
      if (isBlockEl(el)) return false;
      if (el.tagName === 'U' || (getComputedStyle(el).textDecorationLine || '').includes('underline')) return true;
      el = el.parentElement;
    }
    return false;
  }
  // card bodies are not in the extraction, so read the highlighted (= actually read) text from the editor
  function bodyExcerpt(blocks, ed, cite) {
    const hl = [], ul = [], plain = [];
    for (const b of blocks) {
      const t0 = clean(b.textContent);
      if (!t0) continue;
      if (cite && t0.startsWith(cite.split(' ')[0]) && /[\[(]/.test(t0.slice(0, 160))) continue;
      const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT); let n;
      while ((n = tw.nextNode())) {
        const v = n.nodeValue;
        if (!v.trim()) continue;
        plain.push(v);
        if (isHighlighted(n, ed)) hl.push(v); else if (isUnderlined(n, ed)) ul.push(v);
      }
    }
    const pick = hl.length ? hl : (ul.length ? ul : plain);
    return clean(pick.join(' ')).slice(0, 900);
  }
  function readBodies(ed, parsed) {
    if (!ed || !ed.isConnected) return 0;
    const blocks = []; const w = document.createTreeWalker(ed, NodeFilter.SHOW_ELEMENT); let n, c = 0;
    while ((n = w.nextNode()) && c++ < 80000) if (isBlockEl(n) && !hasBlockChild(n)) blocks.push(n);
    let pos = 0, got = 0;
    for (const p of parsed) {
      if (p.kind !== 'tag') continue;
      let at = -1;
      for (let i = pos; i < blocks.length; i++) if (clean(blocks[i].textContent) === p.tag) { at = i; break; }
      if (at < 0) continue;
      pos = at + 1;
      const t = bodyExcerpt(cardBlocks(ed, blocks[at]), ed, p.cite);
      if (t) { p.body = t; got++; }
    }
    return got;
  }

  // =====================================================================
  // CC Flow: classification + matching helpers (work with or without AI)
  // =====================================================================
  const SOLV_RE = /solvency|inherency|\bplan\b|plan text|status quo/i;
  const ADV_RE = /advantage|\badv\b|contention/i;
  function kwType(tag) {
    const t = tag.toLowerCase();
    if (/inherency|status quo (fails|is failing)|no (current|existing)|barrier/.test(t)) return 'inherency';
    if (/solv|plan (will|would|can|results|fixes)|resolves|ensures/.test(t)) return 'solvency';
    if (/extinction|nuclear war|collapse|catastroph|existential|billions|millions of|escalat|poverty/.test(t)) return 'impact';
    if (/internal link|spills? over|which (causes|leads|triggers)|leads to/.test(t)) return 'internal link';
    if (/\blink\b|\btriggers\b|\bcauses\b|plan (causes|triggers|increases|decreases|spends|costs)/.test(t)) return 'link';
    if (/\bnow\b|currently|status quo|already|trend|momentum|\bstill\b|is (growing|rising|strong)/.test(t)) return 'uniqueness';
    return '';
  }
  // 1AC: each advantage gets its own flow; plan text, solvency and inherency share one flow
  function group1AC(parsed) {
    const vals = (lvl) => [...new Set(parsed.map((p) => p.heads[lvl]).filter(Boolean))];
    let level = null;
    for (const lvl of ['hat', 'block']) if (vals(lvl).some((v) => ADV_RE.test(v) || SOLV_RE.test(v))) { level = lvl; break; }
    if (!level) level = vals('block').length >= 2 ? 'block' : (vals('hat').length >= 2 ? 'hat' : (vals('pocket').length >= 2 ? 'pocket' : 'block'));
    parsed.forEach((p) => {
      const path = [p.heads.pocket, p.heads.hat, p.heads.block].join(' | ');
      const lv = p.heads[level] || '';
      const advish = ADV_RE.test(lv);
      if (/^\s*(the )?(united states|usfg|plan)\b/i.test(p.tag) || (!advish && (SOLV_RE.test(path) || p.afterPlan))) { p.flowName = 'Solvency/Inherency'; p.flowType = 'solv'; }
      else {
        const nm = lv || p.heads.block || p.heads.hat || p.heads.pocket || 'Advantage';
        const g = guessType(nm);
        p.flowName = nm; p.flowType = (g === 'other' || g === 'solv') ? 'adv' : g;
      }
    });
  }
  const stemSet = (s) => new Set(wordList(s).filter((w) => !STOP.has(w.toLowerCase()) && w.length > 2).map(stem));
  function sim(a, b) { let n = 0; a.forEach((x) => { if (b.has(x)) n++; }); return n < 2 ? 0 : n / Math.max(3, Math.min(a.size, b.size)); }
  function lineIndex() {
    const out = []; let n = 0;
    for (const f of FL.flows) {
      for (const l of f.lines) {
        const ents = Object.values(l.cells).flat();
        const last = ents[ents.length - 1];
        const text = f.name + ' ' + l.label + ' ' + ents.map((e) => e.label + ' ' + e.text).join(' ');
        out.push({ id: 'L' + (++n), flow: f, line: l, set: stemSet(text), gist: last ? (last.label + ': ' + last.text.split('\n')[0]).slice(0, 100) : '' });
      }
    }
    return out;
  }
  function linesBlock(idx, batch) {
    let pick = idx;
    if (idx.length > 45) {
      const sets = batch.map((p) => stemSet(p.tag + ' ' + p.heading));
      pick = idx.map((x) => ({ x, s: Math.max(0, ...sets.map((s) => sim(s, x.set))) })).sort((a, b) => b.s - a.s).slice(0, 45).map((o) => o.x);
    }
    return pick.map((x) => x.id + ' | ' + x.flow.name + ' | ' + (x.line.label || '-') + ' | ' + x.gist).join('\n');
  }
  function heurAnnotate(p) {
    const blob = p.tag + ' ' + p.under.join(' ');
    const m = blob.match(/\b(because|since|due to|which means|as a result of)\b\s+(.{10,170})/i);
    let warrant = m ? m[2].replace(/[.;].*$/, '') : '';
    if (!warrant && p.body) warrant = p.body.slice(0, 180);
    return { type: p.kind === 'analytic' ? 'analytic' : kwType(p.tag), says: p.tag.slice(0, 200), warrant: clean(warrant).slice(0, 200) };
  }

  // =====================================================================
  // CC Flow: AI calls (local Ollama; every call has a heuristic fallback)
  // =====================================================================
  const flowModel = (api) => clean(String(setting(api, 'flow-model', ''))) || clean(cfg(api, 'ollama-model'));
  const flowAi = (api) => !!setting(api, 'use-ai', true) && !!flowModel(api);
  const asList = (out, key) => (Array.isArray(out) ? out : (Array.isArray(out && out[key]) ? out[key] : []));
  const lim = (s, n) => clean(String(s || '')).slice(0, n);

  const TYPE_DEFS = 'Card roles in policy debate:\n' +
    '- uniqueness (UQ): describes the STATUS QUO, what is true now or the current trend, BEFORE the plan.\n' +
    '- link: what the PLAN does to change that status quo.\n' +
    '- internal link (I/L): connects the link to the impact (A causes B, which leads to the impact).\n' +
    '- impact (!): what happens if the plan is, or is not, passed (the harm or benefit that finally matters).\n' +
    '- solvency: how the PLAN solves the problem ON ITS OWN (the plan works, can be implemented, reaches its goal). It is NOT how the plan solves an advantage.\n' +
    '- inherency: why the status quo does NOT already do the plan (barriers, refusal, the gap).\n' +
    'The cards of one advantage usually run uniqueness, link, internal link(s), impact, in that order.\n';
  async function aiAnnotate(api, spk, batch, idx) {
    const side = TEAM[spk] === 'A' ? 'AFF' : 'NEG';
    const cards = batch.map((p, k) => (k + 1) + '. [section: ' + (p.heading || 'none') + (p.of ? '; card ' + (p.pos + 1) + ' of ' + p.of + ' in this section' : '') + '] ' +
      (p.kind === 'analytic' ? 'ANALYTIC: ' : 'TAG: ') + p.tag + (p.cite ? ' | CITE: ' + p.cite : '') +
      (p.under.length ? ' | NOTE: ' + p.under.join(' ').slice(0, 160) : '') + (p.body ? ' | READ TEXT: ' + p.body.slice(0, 450) : '')).join('\n');
    const fields = 'type (exactly one of: uniqueness, link, internal link, impact, solvency, inherency, none), says (what the card claims, max 18 words), warrant (the reason or mechanism it gives, max 22 words, or "")';
    let prompt;
    if (!idx) {
      prompt = 'You are flowing the ' + spk + ' (' + side + ') of a policy debate round.\n' + TYPE_DEFS + '\nFor each numbered card decide its role from the definitions, and give: ' + fields + '.\n' +
        'Reply with JSON only: {"cards":[{"i":1,"type":"link","says":"...","warrant":"..."}]}\nCARDS:\n' + cards;
    } else {
      prompt = 'You are flowing the ' + spk + ' (' + side + ') of a policy debate round, line by line.\n' + TYPE_DEFS +
        '\nEXISTING LINES (id | flow | line | latest entry):\n' + linesBlock(idx, batch) + '\n\n' +
        'For each numbered card decide which existing line it RESPONDS to (target = the line id, e.g. "L3"), or "NEW" if it starts a new argument (then give flow = a short flow name like "Spending DA", flowType = da, cp, k, t, theory or case, and line = a short label). ' +
        'Also give: ' + fields + ' (the role the card plays in its own argument; "none" if it is only defense).\n' +
        'Reply with JSON only: {"cards":[{"i":1,"target":"L3","type":"link","says":"...","warrant":"...","flow":"","flowType":"","line":""}]}\nCARDS:\n' + cards;
    }
    const out = await ollamaJson(api, prompt, 120000, flowModel(api));
    const map = {};
    asList(out, 'cards').forEach((c) => { const i = parseInt(c.i, 10); if (i >= 1 && i <= batch.length) map[i - 1] = c; });
    return map;
  }
  async function aiAnalytics(api, spk, chunk, idx, docTags) {
    const prompt = 'You are flowing a policy debate round. Speech: ' + spk + ' (' + (TEAM[spk] === 'A' ? 'AFF' : 'NEG') + ').\nEXISTING LINES (id | flow | line | latest entry):\n' + linesBlock(idx, []) + '\n\n' +
      'TRANSCRIPT: "' + chunk + '"\n\nList the ORAL arguments the speaker made (analytic arguments, not just card citations being read, and not the roadmap or filler). Max 6. ' +
      'For each give text (max 25 words), target (the line id it answers, or "NEW" with flow = short flow name, flowType = da, cp, k, t, theory or case, line = short label).\n' +
      'Skip anything matching these already-flowed tags: ' + docTags.slice(0, 25).join(' ; ').slice(0, 1200) + '\nReply with JSON only: {"args":[{"text":"...","target":"L2","flow":"","flowType":"","line":""}]}';
    return asList(await ollamaJson(api, prompt, 90000, flowModel(api)), 'args');
  }
  async function aiRoadmap(api, text) {
    const out = await ollamaJson(api, 'This is the start of a debate speech. If the speaker gives an off-time roadmap (the order of arguments they will go in), list the argument names in order, e.g. ["Spending DA","Cap K","Case"]. Otherwise return an empty list.\nTEXT: "' + text + '"\nReply with JSON only: {"order":[]}', 40000, flowModel(api));
    return (Array.isArray(out && out.order) ? out.order : []).map((s) => lim(s, 40)).filter(Boolean).slice(0, 12);
  }

  // =====================================================================
  // CC Flow: flowing one speech
  // =====================================================================
  function applyRoadmap(order, spk) {
    if (!order.length) return;
    FL.roadmap = order;
    const ids = [];
    const push = (f) => { if (f && !ids.includes(f.id)) ids.push(f.id); };
    for (const name of order) {
      if (/^(the )?(case|aff|advantages?|solvency|inherency|1ac)$/i.test(clean(name))) { FL.flows.filter((f) => f.type === 'adv' || f.type === 'solv').forEach(push); continue; }
      let f = findFlow(name);
      if (!f && spk === '1NC') { f = addFlow(name, guessType(name)); addLine(f, ''); }
      push(f);
    }
    FL.flows.forEach(push);
    FL.flows.sort((a, b) => ids.indexOf(a.id) - ids.indexOf(b.id));
  }
  // headings steer the match: "AT: Advantage 1" answers that flow; an off-case heading names its own flow
  function flowHint(p, spk) {
    const h0 = clean(p.heading);
    if (!h0) return null;
    const at = h0.match(/^(?:at|a2|answers?\s+to)\b[:\s\-–]*(.+)$/i);
    if (at) { const f = findFlow(at[1]); return f ? { flow: f } : null; }
    if (/^(case|aff|neg|cx|answers?|offense)\b/i.test(h0)) return null;
    const t = guessType(h0);
    if (!OFFCASE.has(t)) return null;
    const f = findFlow(h0);
    if (spk === '1NC') return { fresh: true, name: f ? f.name : h0, type: t };
    return f ? { flow: f } : null;
  }
  async function flowSpeech(api, spk, parsed, transcript, hud) {
    const rep = { cards: 0, x: 0, skippedNew: 0, analytics: 0, newFlows: 0, aiFail: false, aiUsed: false, stopped: false };
    const flows0 = FL.flows.length;
    let ai = flowAi(api);
    const aiFailed = (e) => { ai = false; rep.aiFail = true; console.warn('[cardcutter-v1] flow AI failed', e); };
    const trWords = wordList(transcript);
    const tset = new Set(trWords.map(stem));
    const text = clean(transcript);
    const check = trWords.length >= 40 && setting(api, 'flow-xcheck', true);
    const first = spk === '1AC';
    const BATCH = 3;                                    // small batches: the AI sees fewer cards at once, so it reads each one more carefully
    const nChunks = trWords.length >= 25 ? Math.ceil(text.length / 1600) : 0;
    const total = Math.ceil(parsed.length / BATCH) + nChunks + 1;
    let done = 0;
    const bump = () => { done++; hud.pct(Math.min(98, (done / total) * 100)); };
    hud.pct(2);

    // which doc items did the speaker actually read?
    parsed.forEach((p) => {
      p.read = true;
      if (!check) return;
      const toks = [...new Set(wordList(p.tag + ' ' + p.cite.split(' ')[0]).filter((w) => !STOP.has(w.toLowerCase()) && w.length > 2).map(stem))];
      p.cov = toks.length ? toks.filter((t) => tset.has(t)).length / toks.length : 1;
      p.read = p.cov >= 0.4;
    });
    parsed.forEach((p, i) => { if (!p.read && parsed[i - 1] && parsed[i - 1].read && parsed[i + 1] && parsed[i + 1].read) p.read = true; });
    // position of each card within its section (UQ -> link -> I/L -> impact is the usual order)
    const secs = new Map();
    parsed.forEach((p) => { if (!secs.has(p.heading)) secs.set(p.heading, []); secs.get(p.heading).push(p); });
    secs.forEach((arr) => arr.forEach((p, i) => { p.pos = i; p.of = arr.length; }));
    if (first) group1AC(parsed);

    const resolveType = (p, a) => {
      let t = headType(p) || normType(a && a.type);
      if (t === 'analytic') t = '';
      if (!t) t = kwType(p.tag);
      if (!t && first) t = positionType(p);
      return t;
    };
    const buildInfo = (p, a, type) => {
      const h0 = heurAnnotate(p);
      return { type, cite: p.cite, says: lim(a && a.says, 220) || h0.says, warrant: lim(a && a.warrant, 240) || h0.warrant, kind: p.kind };
    };
    const annotate = async (batch, idx) => {
      if (!ai) return {};
      try { const m = await aiAnnotate(api, spk, batch, idx); rep.aiUsed = true; return m; } catch (e) { aiFailed(e); return {}; }
    };

    // 1AC: inherency never belongs to an advantage, and neither does solvency that is not under an advantage heading
    const place1 = (p, a) => {
      const type = resolveType(p, a);
      if (!p.read) { rep.skippedNew++; return; }
      const path = [p.heads.pocket, p.heads.hat, p.heads.block].join(' | ');
      let name = p.flowName, ft = p.flowType;
      if (ft !== 'solv' && (type === 'inherency' || (type === 'solvency' && !ADV_RE.test(path)))) { name = 'Solvency/Inherency'; ft = 'solv'; }
      const flow = findFlow(name) || addFlow(name, ft);
      const line = addLine(flow, typeShort(type));
      addEntry(line, '1AC', cardEntry(buildInfo(p, a, type), false));
      rep.cards++;
    };
    const placeResp = (p, a, idx) => {
      const type = resolveType(p, a);
      const info = buildInfo(p, a, type);
      let target = null;
      const tid = a && String(a.target || '').match(/L\d+/i);
      if (tid) target = idx.find((x) => x.id === tid[0].toUpperCase()) || null;
      const saidNew = a && /new/i.test(String(a.target || '')) && !tid;
      if (!target && !saidNew && !a && idx.length) {            // no AI answer: match by shared words
        const s = stemSet(p.tag + ' ' + p.heading + ' ' + p.under.join(' '));
        let best = null, bs = 0.3;
        idx.forEach((x) => { const v = sim(s, x.set); if (v > bs) { bs = v; best = x; } });
        target = best;
      }
      const hint = flowHint(p, spk);
      let forced = null;
      if (hint && hint.fresh) { target = null; forced = { name: hint.name, type: hint.type }; }
      else if (hint && hint.flow && (!target || target.flow !== hint.flow)) {
        const s = stemSet(p.tag + ' ' + p.under.join(' '));
        let best = null, bs = 0.15;
        idx.filter((x) => x.flow === hint.flow).forEach((x) => { const v = sim(s, x.set); if (v > bs) { bs = v; best = x; } });
        if (best) target = best; else { target = null; forced = { name: hint.flow.name, type: hint.flow.type }; }
      }
      let flow, line, isNew = false;
      if (target) { flow = target.flow; line = target.line; }
      else {
        isNew = true;
        if (!p.read) { rep.skippedNew++; return; }                 // an unread NEW argument is not flowed
        const name = forced ? forced.name : (lim(a && a.flow, 40) || (p.heading && !/^(case|at\b|a2\b|answers?)/i.test(p.heading) ? p.heading : ''));
        flow = (name && findFlow(name)) || addFlow(name || 'Unsorted', (forced && forced.type) || (a && a.flowType && a.flowType !== 'case' ? String(a.flowType).toLowerCase() : '') || guessType(name));
        if (!TYPE_LABEL[flow.type]) flow.type = 'other';
        line = addLine(flow, lim(a && a.line, 40) || typeShort(type) || lim(p.tag, 28));
      }
      const cols = colsFor(flow.type);
      addEntry(line, cols.includes(spk) ? spk : cols[0], cardEntry(info, !p.read));
      rep.cards++; if (!p.read) rep.x++;
    };

    hud.step(1);
    const anns = new Map();
    for (let b = 0; b < parsed.length; b += BATCH) {
      if (hud.cancelled) { rep.stopped = true; break; }
      const batch = parsed.slice(b, b + BATCH);
      hud.busy('cards ' + (b + 1) + '–' + Math.min(parsed.length, b + BATCH) + ' of ' + parsed.length);
      const idx = first ? null : lineIndex();
      const ann = await annotate(batch, idx);
      if (first) batch.forEach((p, k) => anns.set(p, ann[k] || null));
      else batch.forEach((p, k) => placeResp(p, ann[k] || null, idx));
      bump();
      await sleep(120);
    }
    if (first && !rep.stopped) {
      parsed.forEach((p) => place1(p, anns.get(p) || null));
      if (parsed.plan) {                                            // the plan text opens the solvency flow
        const flow = findFlow('Solvency/Inherency') || addFlow('Solvency/Inherency', 'solv');
        if (!flow.lines.some((l) => l.label === 'Plan text')) {
          const line = { id: uid(), label: 'Plan text', cells: {} };
          addEntry(line, '1AC', mkEntry({ kind: 'plan', label: 'Plan text', text: parsed.plan }));
          flow.lines.unshift(line);
        }
      }
    }

    // oral arguments that are not in the doc
    if (nChunks && ai && !rep.stopped) {
      hud.step(2); hud.busy('listening back');
      const tags = parsed.map((p) => p.tag);
      const tagSets = parsed.map((p) => stemSet(p.tag));
      for (let off = 0; off < text.length && ai; off += 1600) {
        if (hud.cancelled) { rep.stopped = true; break; }
        let list = [];
        try { list = await aiAnalytics(api, spk, text.slice(off, off + 1600), lineIndex(), tags); } catch (e) { aiFailed(e); break; }
        const idx = lineIndex();
        for (const a of list) {
          const t = lim(a && a.text, 200);
          if (!t) continue;
          const s = stemSet(t);
          if (tagSets.some((x) => sim(s, x) >= 0.5)) continue;       // already flowed from the doc
          const tid = String(a.target || '').match(/L\d+/i);
          const target = tid ? idx.find((x) => x.id === tid[0].toUpperCase()) : null;
          let flow, line;
          if (target) { flow = target.flow; line = target.line; }
          else {
            const name = lim(a.flow, 40);
            flow = name ? findFlow(name) : null;
            if (!flow && name && (spk === '1NC' || spk === '1AC')) { flow = addFlow(name, guessType(name)); }
            if (!flow) continue;                                       // a new oral argument with nowhere to go is not flowed
            line = addLine(flow, lim(a.line, 40));
          }
          const cols = colsFor(flow.type);
          addEntry(line, cols.includes(spk) ? spk : cols[0], cardEntry({ kind: 'analytic', says: t }, false));
          rep.analytics++;
        }
        bump();
        await sleep(120);
      }
    }

    // off-time roadmap
    if (ai && !rep.stopped && trWords.length >= 15 && /road ?map|off[- ]?time|order (is|will be)/i.test(transcript.slice(0, 700))) {
      hud.step(3); hud.busy('roadmap');
      try { applyRoadmap(await aiRoadmap(api, transcript.slice(0, 700)), spk); } catch (e) { aiFailed(e); }
    }
    rep.newFlows = FL.flows.length - flows0;
    if (!rep.stopped) { FL.flowed[spk] = true; FL.lastSpeech = spk; }
    if (!FL.flows.some((f) => f.id === FL.active)) FL.active = FL.flows[0] ? FL.flows[0].id : null;
    flSave(); flPaint();
    return rep;
  }

  // cross-examination: notes land in the previous speech's column of the flow they concern
  async function flowCX(api, transcript, hud) {
    if (!flowAi(api)) return { notes: 0, err: 'Cross-ex notes need the local AI (set a model in CC settings).' };
    hud.pct(8); hud.busy('cross-examination');
    const idx = lineIndex();
    if (!idx.length) return { notes: 0, err: 'Flow a speech first so there are lines to attach notes to.' };
    const out = asList(await ollamaJson(api, 'This is a cross-examination in a policy debate. EXISTING LINES (id | flow | line | latest entry):\n' + linesBlock(idx, []) +
      '\n\nTRANSCRIPT: "' + clean(transcript).slice(0, 5000) + '"\n\nList useful concessions, clarifications or admissions (max 8), each tied to the line it matters for. ' +
      'Reply with JSON only: {"notes":[{"target":"L2","text":"max 25 words"}]}', 90000, flowModel(api)), 'notes');
    let n = 0;
    for (const a of out) {
      const tid = String(a.target || '').match(/L\d+/i);
      const t = tid && idx.find((x) => x.id === tid[0].toUpperCase());
      const text = lim(a.text, 220);
      if (!t || !text) continue;
      const cols = colsFor(t.flow.type);
      const col = cols.includes(FL.lastSpeech) ? FL.lastSpeech : cols[0];
      addEntry(t.line, col, mkEntry({ kind: 'cx', label: 'CX', text }));
      n++;
    }
    flSave(); flPaint();
    return { notes: n };
  }

  async function flowSpeechCmd(api) {
    EF.api = api; flLoad(api);
    const raw = await askText('Which speech? (1AC, 1NC, 2AC, 2NC, 1NR, 1AR, 2NR, 2AR, or CX)', '');
    if (!raw || !clean(raw)) return;
    const spk = normSpeech(raw);
    if (!spk) { api.showToast('Did not recognise "' + raw + '". Use 1AC, 1NC, 2AC, 2NC, 1NR, 1AR, 2NR, 2AR or CX.'); return; }
    const hud = makeFlowDots(api);
    try {
      hud.step(0); hud.busy('Reading your speech doc…');
      const transcript = takeTranscript();
      let parsed = [];
      if (spk !== 'CX') {
        const res = api.extractSelection();
        if (res && res.ok) {
          parsed = parseItems(res.items);
          const got = readBodies(lastEditor, parsed);
          hud.caption('Read ' + parsed.length + ' tags/analytics' + (got ? ' and the highlighted text of ' + got + ' cards' : '') + ' from “' + res.docTitle + '”');
        } else if (!transcript) {
          const m = 'Could not read the doc (' + (res && res.error) + '). Select the speech doc content, or click into the heading, then run CC: FS again.';
          hud.fail(m); api.showToast(m); return;
        }
      } else if (!transcript) {
        const m = 'No cross-ex audio yet. Start CC: FL (Listen) before the cross-ex.';
        hud.fail(m); api.showToast(m); return;
      }
      if (spk === 'CX') {
        const r = await flowCX(api, transcript, hud);
        const m = r.err || ('Added ' + r.notes + ' cross-ex note' + (r.notes === 1 ? '' : 's') + ' to the ' + (FL.lastSpeech || '1AC') + ' column');
        r.err ? hud.fail(m) : hud.finish(m); api.showToast('CC FS: ' + m); return;
      }
      const rep = await flowSpeech(api, spk, parsed, transcript, hud);
      const m = spk + ': ' + rep.cards + ' cards flowed' + (rep.x ? ' (' + rep.x + ' crossed out as not read)' : '') + (rep.skippedNew ? ', ' + rep.skippedNew + ' unread new args skipped' : '') +
        (rep.analytics ? ', ' + rep.analytics + ' oral args' : '') + (rep.newFlows ? ', ' + rep.newFlows + ' new flow' + (rep.newFlows === 1 ? '' : 's') : '') +
        (rep.aiFail ? ' · AI unavailable, used keyword matching' : (rep.aiUsed ? '' : ' · no AI model set, used keyword matching')) + (transcript ? '' : ' · no transcript, treated everything as read');
      hud.finish(m, 7000); api.showToast('CC FS: ' + m);
    } catch (e) {
      console.error('[cardcutter-v1] FS', e);
      const m = 'Flow stopped: ' + (e && e.message || e);
      hud.fail(m); api.showToast(m);
    }
  }

  // =====================================================================
  // CC Flow: listening (speech recognition) + transcript buffer
  // =====================================================================
  const LISTEN = { on: false, engine: '', t0: 0, final: [], consumed: 0, interim: '', rec: null, pcm: null, asr: null, q: Promise.resolve(), session: 0, runId: 0, tick: 0, fatal: '', warn: '' };
  const fmtTime = (ms) => { const s = Math.floor(ms / 1000); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };
  function pushFinal(text) {
    const t = clean(text);
    if (!t) return;
    LISTEN.final.push({ t: Date.now(), text: t });
    LISTEN.interim = '';
    if (typeof flCaptionUi === 'function') flCaptionUi();
  }
  function takeTranscript() {
    const t = LISTEN.final.slice(LISTEN.consumed).map((x) => x.text).join(' ') + (LISTEN.interim ? ' ' + LISTEN.interim : '');
    LISTEN.consumed = LISTEN.final.length; LISTEN.interim = '';
    return clean(t);
  }
  function startBrowserListening(api, runId) {
    const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) throw new Error('this app has no built-in speech recognition. Set "Listening engine" to whisper-server in the plugin settings.');
    const rec = new SR();
    rec.continuous = true; rec.interimResults = true; rec.lang = String(setting(api, 'listen-lang', 'en-US'));
    rec.onresult = (e) => {
      if (runId !== LISTEN.runId) return;
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const r = e.results[i];
        if (r.isFinal) pushFinal(r[0].transcript); else interim += r[0].transcript;
      }
      LISTEN.interim = clean(interim);
      if (typeof flCaptionUi === 'function') flCaptionUi();
    };
    rec.onerror = (e) => { if (runId === LISTEN.runId && ['not-allowed', 'service-not-allowed', 'network', 'audio-capture'].includes(e.error)) LISTEN.fatal = e.error; };
    rec.onend = () => {
      if (runId !== LISTEN.runId || !LISTEN.on) return;
      if (LISTEN.fatal) {
        const why = LISTEN.fatal; LISTEN.fatal = '';
        stopListening(true);
        api.showToast('Listening stopped (' + why + '): this app has no browser speech service. Set the listening engine to auto or whisper-server in the plugin settings.');
        return;
      }
      setTimeout(() => { try { rec.start(); } catch (err) { /* already running */ } }, 250);
    };
    rec.start();
    LISTEN.rec = rec;
  }
  // ---- audio capture as 16 kHz mono PCM: works in desktop apps, needs no MediaRecorder / ffmpeg ----
  function encodeWav(f32, rate) {
    const buf = new ArrayBuffer(44 + f32.length * 2); const v = new DataView(buf);
    const w = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
    w(0, 'RIFF'); v.setUint32(4, 36 + f32.length * 2, true); w(8, 'WAVE'); w(12, 'fmt '); v.setUint32(16, 16, true);
    v.setUint16(20, 1, true); v.setUint16(22, 1, true); v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true);
    v.setUint16(32, 2, true); v.setUint16(34, 16, true); w(36, 'data'); v.setUint32(40, f32.length * 2, true);
    for (let i = 0; i < f32.length; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 0x8000 : s * 0x7fff, true); }
    return new Blob([buf], { type: 'audio/wav' });
  }
  function resample(f32, from, to) {
    if (from === to) return f32;
    const ratio = from / to, n = Math.floor(f32.length / ratio), out = new Float32Array(n);
    for (let i = 0; i < n; i++) { const pos = i * ratio, i0 = Math.floor(pos), i1 = Math.min(f32.length - 1, i0 + 1), fr = pos - i0; out[i] = f32[i0] * (1 - fr) + f32[i1] * fr; }
    return out;
  }
  const rmsOf = (f) => { let s = 0; for (let i = 0; i < f.length; i++) s += f[i] * f[i]; return Math.sqrt(s / Math.max(1, f.length)); };
  async function openPcm(seconds, onChunk) {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, noiseSuppression: true, echoCancellation: false } });
    const Ctx = window.AudioContext || window.webkitAudioContext;
    let ctx;
    try { ctx = new Ctx({ sampleRate: 16000 }); } catch (e) { ctx = new Ctx(); }
    if (ctx.state === 'suspended') { try { await ctx.resume(); } catch (e) { /* needs a gesture */ } }
    const src = ctx.createMediaStreamSource(stream);
    const proc = ctx.createScriptProcessor(4096, 1, 1);
    let parts = [], n = 0;
    const per = Math.round(ctx.sampleRate * seconds);
    const flush = () => {
      if (!n) return;
      const all = new Float32Array(n); let o = 0;
      parts.forEach((x) => { all.set(x, o); o += x.length; });
      parts = []; n = 0;
      onChunk(resample(all, ctx.sampleRate, 16000));
    };
    proc.onaudioprocess = (e) => { const d = e.inputBuffer.getChannelData(0); parts.push(new Float32Array(d)); n += d.length; if (n >= per) flush(); };
    src.connect(proc); proc.connect(ctx.destination);
    return { stop() {
      try { flush(); } catch (e) { /* ignore */ }
      try { proc.disconnect(); src.disconnect(); } catch (e) { /* ignore */ }
      try { stream.getTracks().forEach((t) => t.stop()); } catch (e) { /* ignore */ }
      try { ctx.close(); } catch (e) { /* ignore */ }
    } };
  }
  const cleanAsr = (t) => { const s = clean(String(t || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')); return s.length < 2 ? '' : s; };
  // chunks are transcribed one at a time, in order
  function enqueueChunk(session, f32, transcribe) {
    if (rmsOf(f32) < 0.004) return;                          // silence: skip (Whisper invents words on silence)
    LISTEN.q = LISTEN.q.then(async () => {
      if (session !== LISTEN.session) return;
      try {
        const t = cleanAsr(await transcribe(f32));
        if (t) { LISTEN.warn = ''; pushFinal(t); }
      } catch (e) {
        console.warn('[cardcutter-v1] transcription failed', e);
        LISTEN.warn = /fetch|network|refused|load/i.test(String(e && e.message)) ? 'Can’t reach the Whisper server. Start it (see the CC settings) and keep this running.' : 'Speech engine error: ' + (e && e.message || e);
        if (typeof flCaptionUi === 'function') flCaptionUi();
      }
    });
  }
  const DEFAULT_WHISPER = 'http://127.0.0.1:8080/inference';
  async function whisperPost(api, f32) {
    const url = clean(String(setting(api, 'whisper-url', DEFAULT_WHISPER)));
    const fd = new FormData();
    fd.append('file', encodeWav(f32, 16000), 'chunk.wav');
    fd.append('model', clean(String(setting(api, 'whisper-model', 'whisper-1'))));
    fd.append('response_format', 'json'); fd.append('temperature', '0');
    const res = await fetch(url, { method: 'POST', body: fd });
    if (!res.ok) throw new Error('Whisper server answered HTTP ' + res.status);
    const j = await res.json();
    return j && (j.text || j.transcription) || '';
  }
  async function whisperReachable(url) {
    try {
      const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 1500);
      await fetch(new URL(url).origin + '/', { mode: 'no-cors', signal: ctl.signal });
      clearTimeout(t); return true;
    } catch (e) { return false; }
  }
  // Whisper running inside the app (a module worker; first use downloads the model)
  const ASR_WORKER = "import { pipeline } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.5.1';\n" +
    "let asr = null;\nself.onmessage = async (e) => { const m = e.data; try {\n" +
    "  if (m.type === 'init') { asr = await pipeline('automatic-speech-recognition', m.model); self.postMessage({ id: m.id, ok: true }); return; }\n" +
    "  const out = await asr(m.audio); self.postMessage({ id: m.id, ok: true, text: (out && out.text) || '' });\n" +
    "} catch (err) { self.postMessage({ id: m.id, ok: false, error: String((err && err.message) || err) }); } };\n";
  function startInAppAsr() {
    const w = new Worker(URL.createObjectURL(new Blob([ASR_WORKER], { type: 'text/javascript' })), { type: 'module' });
    const pend = new Map(); let seq = 0;
    w.onmessage = (e) => { const p = pend.get(e.data.id); if (p) { pend.delete(e.data.id); if (e.data.ok) p.res(e.data); else p.rej(new Error(e.data.error)); } };
    w.onerror = (e) => { const err = new Error((e && e.message) || 'the speech worker could not load (the app may block it)'); pend.forEach((p) => p.rej(err)); pend.clear(); };
    const call = (msg, transfer) => new Promise((res, rej) => { const id = ++seq; pend.set(id, { res, rej }); w.postMessage(Object.assign({ id }, msg), transfer || []); });
    return { init: (model) => call({ type: 'init', model }), run: (f32) => call({ type: 'run', audio: f32 }, [f32.buffer]).then((r) => r.text), stop: () => { try { w.terminate(); } catch (e) { /* ignore */ } } };
  }
  async function pickEngine(api) {
    const pref = String(setting(api, 'listen-engine', 'auto'));
    if (pref !== 'auto') return pref;
    if (await whisperReachable(clean(String(setting(api, 'whisper-url', DEFAULT_WHISPER))))) return 'whisper-server';
    if (!/Electron/i.test(navigator.userAgent) && (window.SpeechRecognition || window.webkitSpeechRecognition)) return 'browser';
    return 'in-app';
  }
  async function startListening(api) {
    FL.api = api; flLoad(api);
    if (LISTEN.on) { api.showToast('Already listening.'); return true; }
    const session = ++LISTEN.session;
    const runId = ++LISTEN.runId;
    LISTEN.on = true; LISTEN.fatal = ''; LISTEN.warn = ''; LISTEN.t0 = Date.now(); LISTEN.q = Promise.resolve();
    try {
      const engine = await pickEngine(api);
      LISTEN.engine = engine;
      const secs = Math.max(3, Number(setting(api, 'listen-chunk', 8)) || 8);
      if (engine === 'browser') startBrowserListening(api, runId);
      else if (engine === 'in-app') {
        LISTEN.warn = 'Loading the speech model (the first time it downloads)…'; flListenUi();
        const asr = startInAppAsr(); LISTEN.asr = asr;
        try { await asr.init(clean(String(setting(api, 'whisper-inapp-model', 'Xenova/whisper-tiny.en')))); }
        catch (e) { asr.stop(); LISTEN.asr = null; throw new Error('the in-app speech engine could not start (' + (e && e.message || e) + '). Run a local Whisper server and use the whisper-server engine instead.'); }
        LISTEN.warn = '';
        LISTEN.pcm = await openPcm(secs, (f32) => enqueueChunk(session, f32, (x) => asr.run(x)));
      } else LISTEN.pcm = await openPcm(secs, (f32) => enqueueChunk(session, f32, (x) => whisperPost(api, x)));
    } catch (e) {
      LISTEN.on = false; LISTEN.runId++; LISTEN.warn = '';
      if (typeof flListenUi === 'function') flListenUi();
      api.showToast('Could not start listening: ' + (e && e.message || e));
      return false;
    }
    clearInterval(LISTEN.tick);
    LISTEN.tick = setInterval(() => { if (typeof flListenUi === 'function') flListenUi(); }, 1000);
    if (typeof flListenUi === 'function') flListenUi();
    api.showToast('Listening (' + LISTEN.engine + '). Run CC: FS after each speech, and CC: SF to stop.');
    return true;
  }
  function stopListening(silent) {
    if (!LISTEN.on) { if (!silent && FL.api) FL.api.showToast('Not listening.'); return; }
    LISTEN.on = false;
    try { if (LISTEN.rec) LISTEN.rec.stop(); } catch (e) { /* ignore */ }
    try { if (LISTEN.pcm) LISTEN.pcm.stop(); } catch (e) { /* ignore */ }
    const asr = LISTEN.asr;                                   // let the last queued chunks finish, then free the worker
    LISTEN.q.then(() => { if (asr) asr.stop(); });
    clearInterval(LISTEN.tick);
    const id = LISTEN.runId;
    setTimeout(() => { if (LISTEN.runId === id) LISTEN.runId++; }, 1500);
    LISTEN.rec = LISTEN.pcm = LISTEN.asr = null; LISTEN.warn = '';
    if (typeof flListenUi === 'function') flListenUi();
    if (!silent && FL.api) FL.api.showToast('Stopped listening. The transcript is kept for the next CC: FS.');
  }
  // =====================================================================
  // CC Flow: window
  // =====================================================================
  const FLOW_CSS = `
.ccx-fl{position:fixed;inset:10px;z-index:2147482500;display:flex;flex-direction:column;background:var(--bg);border:1px solid var(--line);border-radius:14px;box-shadow:0 18px 60px rgba(0,0,0,.35);overflow:hidden}
.ccx-fl.split{inset:10px 10px 10px auto;width:min(66vw,1280px)}
.ccx-fl.hide{display:none}
.ccx-fl-top{display:flex;align-items:center;gap:8px;padding:10px 14px;border-bottom:1px solid var(--line);flex-wrap:wrap;position:relative}
.ccx-fl-title{font-weight:650;font-size:15px}
.ccx-road{font-size:12px;color:var(--mut);max-width:38vw;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ccx-fl-top .sp{flex:1}
.ccx-listen{display:inline-flex;align-items:center;gap:7px}
.ccx-listen.on{border-color:var(--lo);color:var(--lo)}
.ccx-dot{width:9px;height:9px;border-radius:50%;background:var(--mut);flex:none}
.ccx-listen.on .ccx-dot,.ccx-recpill .ccx-dot.on{background:var(--lo);animation:ccx-pulse 1.1s ease-in-out infinite}
.ccx-fl-body{flex:1;display:flex;min-height:0;position:relative}
.ccx-tabs{width:180px;flex:none;border-right:1px solid var(--line);overflow:auto;padding:8px;display:flex;flex-direction:column;gap:4px;background:var(--soft)}
.ccx-tab{display:flex;align-items:center;gap:7px;padding:8px 9px;border-radius:9px;cursor:pointer;border:1px solid transparent}
.ccx-tab:hover{background:var(--bg)}
.ccx-tab.on{background:var(--bg);border-color:var(--acc)}
.ccx-tab{border-left:3px solid var(--line)}
.ccx-tab.A{border-left-color:var(--acc)}
.ccx-tab.N{border-left-color:var(--lo)}
.ccx-tab.A .ccx-tchip{background:color-mix(in srgb,var(--acc) 18%,var(--bg));color:var(--acc)}
.ccx-tab.N .ccx-tchip{background:color-mix(in srgb,var(--lo) 18%,var(--bg));color:var(--lo)}
.ccx-tab.on.A{border-color:var(--acc)}
.ccx-tab.on.N{border-color:var(--lo)}
.ccx-tab.drag{opacity:.4}
.ccx-tab.over.before{box-shadow:0 -2px 0 var(--acc)}
.ccx-tab.over.after{box-shadow:0 2px 0 var(--acc)}
.fe.plan .fe-l{color:var(--acc)}
.ccx-flowdots{position:fixed;left:16px;bottom:16px;z-index:2147482700;display:flex;align-items:center;gap:5px;font-size:12px;color:var(--mut);background:color-mix(in srgb,var(--bg) 90%,transparent);border:1px solid var(--line);border-radius:999px;padding:5px 11px;user-select:none}
.ccx-flowdots .d{width:5px;height:5px;border-radius:50%;background:var(--mut);animation:ccx-dot 1.2s infinite ease-in-out}
.ccx-flowdots .d:nth-child(2){animation-delay:.15s}
.ccx-flowdots .d:nth-child(3){animation-delay:.3s}
.ccx-flowdots .t{margin-left:3px}
.ccx-flowdots .p{min-width:2.4em;font-variant-numeric:tabular-nums}
.ccx-flowdots .x{border:0;background:none;color:var(--mut);cursor:pointer;font-size:14px;line-height:1;padding:0 0 0 2px;display:none}
.ccx-flowdots:hover .x{display:inline}
.ccx-flowdots.done .d{animation:none;opacity:.45}
.ccx-flowdots.err{color:var(--lo);border-color:var(--lo)}
.ccx-flowdots.err .d{animation:none;background:var(--lo)}
@keyframes ccx-dot{0%,80%,100%{opacity:.25;transform:translateY(0)}40%{opacity:1;transform:translateY(-2px)}}
.ccx-tname{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;outline:none}
.ccx-tchip{font-size:10px;font-weight:700;padding:1px 6px;border-radius:99px;background:var(--line);color:var(--mut);text-transform:uppercase;flex:none}
.ccx-tx{border:0;background:none;color:var(--mut);cursor:pointer;opacity:0;font:inherit;flex:none}
.ccx-tab:hover .ccx-tx{opacity:1}
.ccx-grid{flex:1;overflow:auto;min-width:0}
table.ccx-t{border-collapse:separate;border-spacing:0;table-layout:fixed;width:100%}
.ccx-t th,.ccx-t td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);vertical-align:top;text-align:left}
.ccx-t thead th{position:sticky;top:0;z-index:2;background:var(--soft);padding:9px 10px;font-weight:700;min-width:170px}
.ccx-t thead th.A{box-shadow:inset 0 -3px 0 var(--acc)}
.ccx-t thead th.N{box-shadow:inset 0 -3px 0 var(--lo)}
.ccx-t .rowh{position:sticky;left:0;z-index:1;background:var(--soft);width:120px;min-width:120px;padding:8px;font-size:12px;font-weight:600;color:var(--mut)}
.ccx-t thead th.rowh{z-index:3}
.ccx-rl{outline:none;min-height:1.3em;word-break:break-word}
.ccx-rx{display:block;border:0;background:none;color:var(--mut);cursor:pointer;opacity:0;font-size:11px;padding:0;margin-top:4px}
.ccx-t tr:hover .ccx-rx{opacity:1}
.ccx-t td{padding:10px;position:relative;min-width:170px;height:80px}
.ccx-t td.A{background:color-mix(in srgb,var(--acc) 4%,var(--bg))}
.ccx-t td.N{background:color-mix(in srgb,var(--lo) 4%,var(--bg))}
.fdone{color:var(--hi);font-weight:800}
.fe{margin-bottom:4.2em;font-size:13px;line-height:1.4}
.fe-head{display:flex;gap:5px}
.fe-xm{color:var(--lo);font-weight:800;display:none}
.fe.sk .fe-xm{display:inline}
.fe-l{font-weight:700;outline:none;flex:1}
.fe-t{white-space:pre-wrap;outline:none;word-break:break-word}
.fe.sk .fe-l,.fe.sk .fe-t{text-decoration:line-through;opacity:.55}
.fe.cx .fe-l{color:var(--mid)}
.fe.analytic .fe-l{font-style:italic}
.fe-bar{display:none;gap:6px;margin-top:3px}
.fe:hover .fe-bar{display:flex}
.fe-b{border:1px solid var(--line);background:var(--soft);color:var(--mut);border-radius:6px;font-size:11px;padding:0 7px;cursor:pointer}
.fe-b:hover{color:var(--fg);border-color:var(--acc)}
.fdrop{color:var(--lo);font-weight:800;letter-spacing:.06em;font-size:11px;border:1px dashed var(--lo);border-radius:6px;display:inline-block;padding:1px 7px;margin-bottom:6px}
.fplus{position:absolute;right:6px;bottom:6px;opacity:0;border:1px solid var(--line);background:var(--bg);color:var(--mut);border-radius:6px;cursor:pointer;line-height:1.2}
.ccx-t td:hover .fplus{opacity:1}
.ccx-fempty{color:var(--mut);padding:28px;text-align:center}
.ccx-addline{margin:10px}
.ccx-capbox{position:absolute;right:16px;bottom:16px;width:340px;max-height:130px;overflow:hidden;background:rgba(18,20,24,.9);color:#f3f4f6;border-radius:10px;padding:8px 11px;font-size:12.5px;line-height:1.4;pointer-events:none;display:none;white-space:pre-wrap}
.ccx-capbox.on{display:block}
.ccx-recpill{position:fixed;right:16px;bottom:16px;z-index:2147482600;display:none;align-items:center;gap:8px;max-width:380px;background:var(--bg);border:1px solid var(--line);border-radius:999px;padding:6px 13px;box-shadow:0 8px 28px rgba(0,0,0,.3);cursor:pointer;font-size:12.5px}
.ccx-recpill.on{display:flex}
.ccx-recpill .t{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--mut);max-width:240px}
.ccx-pop{position:absolute;top:50px;left:14px;z-index:6;background:var(--bg);border:1px solid var(--line);border-radius:12px;padding:12px;box-shadow:0 12px 36px rgba(0,0,0,.3);display:flex;gap:8px;align-items:center}
.ccx-pop input,.ccx-pop select{padding:8px 10px;border:1px solid var(--line);border-radius:8px;background:var(--soft);color:var(--fg);font:inherit}
`;
  function ensureFlowStyle() {
    ensureStyle();
    if (document.getElementById('ccx-flow-style')) return;
    const s = document.createElement('style');
    s.id = 'ccx-flow-style'; s.textContent = FLOW_CSS;
    document.head.appendChild(s);
  }

  // the quiet indicator for AI flowing: three dots, "Flowing", and a percentage, bottom left
  function makeFlowDots(api) {
    ensureFlowStyle();
    const st = { cancelled: false };
    const label = h('span', { class: 't' }, 'Flowing');
    const pct = h('span', { class: 'p' }, '0%');
    const x = h('button', { class: 'x', title: 'Stop flowing', onclick: () => { st.cancelled = true; label.textContent = 'Stopping'; } }, '×');
    const el = h('div', { class: 'ccx ccx-flowdots' + themeClass(), title: 'Flowing your speech' }, h('span', { class: 'd' }), h('span', { class: 'd' }), h('span', { class: 'd' }), label, pct, x);
    document.body.appendChild(el);
    const end = (ms) => setTimeout(() => el.remove(), ms);
    return Object.assign(st, {
      step() {}, progress() {},
      busy(t) { el.title = 'Flowing: ' + t; },
      caption(t) { el.title = t; },
      pct(n) { pct.textContent = Math.max(0, Math.min(100, Math.round(n))) + '%'; },
      finish(msg) { el.classList.add('done'); label.textContent = 'Flowed'; pct.textContent = '✓'; x.remove(); el.title = msg; end(3000); },
      fail(msg) { el.classList.add('err'); label.textContent = 'Flow stopped'; pct.textContent = ''; x.remove(); el.title = msg; end(8000); },
    });
  }
  function moveFlow(srcId, targetId, before) {
    if (!srcId || srcId === targetId) return;
    const src = FL.flows.find((f) => f.id === srcId);
    if (!src) return;
    FL.flows = FL.flows.filter((f) => f.id !== srcId);
    const at = FL.flows.findIndex((f) => f.id === targetId);
    FL.flows.splice(at < 0 ? FL.flows.length : (before ? at : at + 1), 0, src);
    flSave(); flPaint(true);
  }

  let saveTimer = 0;
  const flDirty = () => { clearTimeout(saveTimer); saveTimer = setTimeout(flSave, 500); };
  const activeFlow = () => FL.flows.find((f) => f.id === FL.active) || null;

  function flCaptionUi() {
    const box = FL.ui.cap;
    const lines = LISTEN.final.slice(-3).map((x) => x.text);
    if (LISTEN.interim) lines.push(LISTEN.interim);
    let text = lines.slice(-3).join('\n');
    if (!text && LISTEN.warn) text = '⚠ ' + LISTEN.warn;
    if (box) { box.textContent = text.length > 420 ? '…' + text.slice(-420) : text; box.classList.toggle('on', LISTEN.on && !!text); }
    flPill();
  }
  function flListenUi() {
    const b = FL.ui.listen;
    if (b) {
      b.className = 'ccx-btn sm ccx-listen' + (LISTEN.on ? ' on' : '');
      b.lastChild.textContent = LISTEN.on ? 'Stop · ' + fmtTime(Date.now() - LISTEN.t0) : 'Listen';
    }
    flCaptionUi();
  }
  // the minimal "recording" signal: a small pill that stays visible while the window is minimised or closed
  function flPill() {
    ensureFlowStyle();
    if (!FL.ui.pill) {
      const dot = h('span', { class: 'ccx-dot' });
      const label = h('b', {}, 'Flow');
      const cap = h('span', { class: 't' });
      const el = h('div', { class: 'ccx ccx-recpill' + themeClass(), title: 'Open the flow', onclick: () => flOpen() }, dot, label, cap);
      document.body.appendChild(el);
      FL.ui.pill = el; FL.ui.pdot = dot; FL.ui.plabel = label; FL.ui.pcap = cap;
    }
    const show = FL.view === 'min' || (FL.view === 'closed' && LISTEN.on);
    FL.ui.pill.classList.toggle('on', show);
    FL.ui.pdot.classList.toggle('on', LISTEN.on);
    FL.ui.plabel.textContent = LISTEN.on ? 'REC ' + fmtTime(Date.now() - LISTEN.t0) : 'Flow';
    const last = LISTEN.interim || (LISTEN.final.length ? LISTEN.final[LISTEN.final.length - 1].text : '');
    FL.ui.pcap.textContent = LISTEN.on ? last.slice(-80) : '';
  }
  function flView(v) {
    FL.view = v;
    if (v === 'full' || v === 'split') FL.lastMode = v;
    if (FL.root) { FL.root.classList.toggle('hide', v === 'min' || v === 'closed'); FL.root.classList.toggle('split', v === 'split'); }
    flPill();
  }
  function flOpen() { flBuild(); flView(FL.lastMode || 'full'); flPaint(true); flListenUi(); }

  function paintTabs() {
    const box = FL.ui.tabs;
    box.textContent = '';
    FL.flows.forEach((f) => {
      const name = h('span', { class: 'ccx-tname', title: 'Double-click to rename' }, f.name);
      name.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        name.contentEditable = 'true'; name.focus();
        const r = document.createRange(); r.selectNodeContents(name); getSelection().removeAllRanges(); getSelection().addRange(r);
      });
      const done = () => { name.contentEditable = 'false'; f.name = clean(name.textContent) || f.name; flSave(); flPaint(true); };
      name.addEventListener('blur', () => { if (name.isContentEditable) done(); });
      name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); name.blur(); } });
      const x = h('button', { class: 'ccx-tx', title: 'Delete this flow' }, '×');
      x.addEventListener('click', (e) => {
        e.stopPropagation();
        if (x.dataset.arm) {
          FL.flows = FL.flows.filter((o) => o.id !== f.id);
          if (FL.active === f.id) FL.active = FL.flows[0] ? FL.flows[0].id : null;
          flSave(); flPaint(true);
        } else { x.dataset.arm = '1'; x.textContent = 'sure?'; x.style.opacity = 1; setTimeout(() => { x.dataset.arm = ''; x.textContent = '×'; x.style.opacity = ''; }, 2500); }
      });
      const tab = h('div', { class: 'ccx-tab ' + (OFFCASE.has(f.type) ? 'N' : (f.type === 'adv' || f.type === 'solv' ? 'A' : '')) + (f.id === FL.active ? ' on' : ''), draggable: 'true', onclick: () => { FL.active = f.id; flSave(); flPaint(true); } },
        h('span', { class: 'ccx-tchip' }, f.type === 'solv' ? 'S/I' : f.type === 'adv' ? 'ADV' : f.type.toUpperCase()), name, x);
      tab.title = f.name + ' (' + (TYPE_LABEL[f.type] || f.type) + ')';
      const clearOver = () => tab.classList.remove('over', 'before', 'after');
      tab.addEventListener('dragstart', (e) => { FL.drag = f.id; e.dataTransfer.effectAllowed = 'move'; try { e.dataTransfer.setData('text/plain', f.id); } catch (err) { /* ignore */ } setTimeout(() => tab.classList.add('drag'), 0); });
      tab.addEventListener('dragend', () => { FL.drag = null; tab.classList.remove('drag'); box.querySelectorAll('.over').forEach((o) => o.classList.remove('over', 'before', 'after')); });
      tab.addEventListener('dragover', (e) => {
        if (!FL.drag || FL.drag === f.id) return;
        e.preventDefault();
        const r = tab.getBoundingClientRect(), before = e.clientY < r.top + r.height / 2;
        tab.classList.add('over'); tab.classList.toggle('before', before); tab.classList.toggle('after', !before);
      });
      tab.addEventListener('dragleave', clearOver);
      tab.addEventListener('drop', (e) => { e.preventDefault(); const r = tab.getBoundingClientRect(); const id = FL.drag; FL.drag = null; moveFlow(id, f.id, e.clientY < r.top + r.height / 2); });
      let dwell = 0;
      tab.addEventListener('mouseenter', () => {
        if (!setting(FL.api, 'flow-hover', true) || f.id === FL.active) return;
        clearTimeout(dwell);
        dwell = setTimeout(() => { if (FL.active !== f.id && !name.isContentEditable) { FL.active = f.id; flSave(); flPaint(true); } }, 140);
      });
      tab.addEventListener('mouseleave', () => clearTimeout(dwell));
      box.append(tab);
    });
    if (!FL.flows.length) box.append(h('div', { class: 'ccx-fempty' }, 'No flows yet'));
  }
  function addManualEntry(l, col) {
    const e = addEntry(l, col, mkEntry({ kind: 'manual', label: '', text: '' }));
    flSave(); flPaint(true);
    const el = FL.ui.grid.querySelector('[data-eid="' + e.id + '"] .fe-l');
    if (el) el.focus();
  }
  function entryEl(l, col, e) {
    const label = h('div', { class: 'fe-l', contenteditable: 'plaintext-only', spellcheck: 'false' }, e.label);
    const text = h('div', { class: 'fe-t', contenteditable: 'plaintext-only' }, e.text);
    label.addEventListener('input', () => { e.label = label.innerText; flDirty(); });
    text.addEventListener('input', () => { e.text = text.innerText; flDirty(); });
    const strike = h('button', { class: 'fe-b', title: 'Strike through (X)', onclick: () => { e.skipped = !e.skipped; flSave(); flPaint(true); } }, 'X');
    const del = h('button', { class: 'fe-b', title: 'Delete entry', onclick: () => { l.cells[col] = (l.cells[col] || []).filter((o) => o.id !== e.id); flSave(); flPaint(true); } }, '×');
    return h('div', { class: 'fe ' + (e.kind || '') + (e.skipped ? ' sk' : ''), 'data-eid': e.id },
      h('div', { class: 'fe-head' }, h('span', { class: 'fe-xm' }, '✕'), label), text, h('div', { class: 'fe-bar' }, strike, del));
  }
  function paintGrid() {
    const wrap = FL.ui.grid;
    const sl = wrap.scrollLeft, st = wrap.scrollTop;
    wrap.textContent = '';
    const f = activeFlow();
    if (!f) { wrap.append(h('div', { class: 'ccx-fempty' }, 'Add a flow with “+ Add flow”, or flow your 1AC with CC: FS (Flow Speech) and the flows appear here.')); return; }
    const cols = colsFor(f.type);
    const drop = droppedMap(f, cols);
    const head = h('tr', {}, h('th', { class: 'rowh' }, 'Line'), cols.map((c) => h('th', { class: TEAM[c] }, c, FL.flowed[c] ? h('span', { class: 'fdone' }, ' ✓') : null)));
    const rows = f.lines.map((l) => {
      const lab = h('div', { class: 'ccx-rl', contenteditable: 'plaintext-only', spellcheck: 'false' }, l.label);
      lab.addEventListener('input', () => { l.label = lab.innerText; flDirty(); });
      const rx = h('button', { class: 'ccx-rx', title: 'Delete this line', onclick: () => { f.lines = f.lines.filter((o) => o.id !== l.id); flSave(); flPaint(true); } }, 'delete line');
      return h('tr', {}, h('th', { class: 'rowh' }, lab, rx), cols.map((c) => {
        const td = h('td', { class: TEAM[c] });
        td.addEventListener('dblclick', (ev) => { if (ev.target === td) addManualEntry(l, c); });
        (l.cells[c] || []).forEach((e) => td.append(entryEl(l, c, e)));
        if (drop.has(l.id + '|' + c)) td.prepend(h('div', { class: 'fdrop' }, 'DROPPED'));
        td.append(h('button', { class: 'fplus', title: 'Add an entry', onclick: () => addManualEntry(l, c) }, '+'));
        return td;
      }));
    });
    const table = h('table', { class: 'ccx-t' }, h('thead', {}, head), h('tbody', {}, rows));
    table.style.minWidth = (120 + cols.length * 170) + 'px';
    wrap.append(table,
      h('button', { class: 'ccx-btn sm ccx-addline', onclick: () => { addLine(f, ''); flSave(); flPaint(true); } }, '+ Add line'));
    wrap.scrollLeft = sl; wrap.scrollTop = st;
  }
  function flPaint(force) {
    if (!FL.root) return;
    const ae = document.activeElement;
    if (!force && ae && FL.root.contains(ae) && ae.isContentEditable) { FL.pending = true; return; }
    FL.pending = false;
    paintTabs(); paintGrid();
    FL.ui.road.textContent = FL.roadmap.length ? 'Roadmap: ' + FL.roadmap.join(' › ') : '';
  }

  function addFlowPop() {
    if (FL.ui.pop) { FL.ui.pop.remove(); FL.ui.pop = null; return; }
    const name = h('input', { placeholder: 'Flow name, e.g. Spending DA', style: 'width:230px' });
    const sel = h('select', {}, FLOW_TYPES.map(([v, l]) => h('option', { value: v }, l)));
    name.addEventListener('input', () => { const g = guessType(name.value); if (g !== 'other') sel.value = g; });
    const go = () => {
      const f = addFlow(name.value || TYPE_LABEL[sel.value], sel.value);
      addLine(f, '');
      FL.active = f.id; flSave(); FL.ui.pop.remove(); FL.ui.pop = null; flPaint(true);
    };
    name.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
    const pop = h('div', { class: 'ccx-pop' }, name, sel, h('button', { class: 'ccx-btn pri sm', onclick: go }, 'Add'));
    FL.ui.top.append(pop); FL.ui.pop = pop;
    setTimeout(() => name.focus(), 0);
  }
  function flBuild() {
    if (FL.root) return;
    ensureFlowStyle();
    const ui = FL.ui;
    ui.listen = h('button', { class: 'ccx-btn sm ccx-listen', title: 'Start / stop listening to the speech', onclick: () => { if (LISTEN.on) stopListening(); else startListening(FL.api); } },
      h('span', { class: 'ccx-dot' }), h('span', {}, 'Listen'));
    const reset = h('button', { class: 'ccx-btn sm', title: 'Delete every flow and start over' }, '↻ Reset');
    reset.addEventListener('click', () => {
      if (reset.dataset.arm) {
        FL.flows = []; FL.active = null; FL.flowed = {}; FL.roadmap = []; FL.lastSpeech = '';
        LISTEN.consumed = LISTEN.final.length;
        flSave(); flPaint(true); reset.dataset.arm = ''; reset.textContent = '↻ Reset';
      } else { reset.dataset.arm = '1'; reset.textContent = 'Click again to wipe'; setTimeout(() => { reset.dataset.arm = ''; reset.textContent = '↻ Reset'; }, 3000); }
    });
    ui.road = h('span', { class: 'ccx-road' });
    ui.top = h('div', { class: 'ccx-fl-top' },
      h('span', { class: 'ccx-fl-title' }, 'Flow'), ui.road, h('span', { class: 'sp' }), ui.listen,
      h('button', { class: 'ccx-btn sm', onclick: addFlowPop }, '+ Add flow'), reset,
      h('button', { class: 'ccx-btn sm', title: 'Switch between full screen and a side panel', onclick: () => flView(FL.view === 'split' ? 'full' : 'split') }, '⇔'),
      h('button', { class: 'ccx-btn sm', title: 'Minimise (keeps flowing / listening)', onclick: () => flView('min') }, '–'),
      h('button', { class: 'ccx-btn sm', title: 'Close (listening keeps going)', onclick: () => flView('closed') }, '×'));
    ui.tabs = h('div', { class: 'ccx-tabs' });
    ui.grid = h('div', { class: 'ccx-grid' });
    ui.cap = h('div', { class: 'ccx-capbox' });
    const body = h('div', { class: 'ccx-fl-body' }, ui.tabs, ui.grid, ui.cap);
    FL.root = h('div', { class: 'ccx ccx-fl hide' + themeClass() }, ui.top, body);
    ['keydown', 'keyup', 'keypress'].forEach((t) => FL.root.addEventListener(t, (e) => { e.stopPropagation(); if (t === 'keydown' && e.key === 'Escape') flView('min'); }));
    FL.root.addEventListener('focusout', () => { if (FL.pending) setTimeout(() => flPaint(true), 60); });
    document.body.appendChild(FL.root);
  }
  function toggleFlow(api) {
    FL.api = api; flLoad(api);
    if (FL.root && (FL.view === 'full' || FL.view === 'split')) { flView('min'); return; }
    flOpen();
  }

  window.__registerCardMirrorPlugin?.({
    id: 'cardcutter-v1',
    name: 'CardCutterV1',
    apiVersion: 1,
    settings: [
      { key: 'use-ai', label: 'Use local AI (Ollama) when available', type: 'boolean', default: true,
        description: 'Used by CC E to judge stance and pick passages, and by CC C2 to choose what to underline. Falls back to keyword matching if Ollama is not running.' },
      { key: 'flow-model', label: 'Flow: local AI model (blank = same as the CC model)', type: 'text', default: '',
        description: 'Flowing works much better with a stronger model, e.g. llama3.1:8b or qwen2.5:14b.' },
      { key: 'flow-xcheck', label: 'Flow: cross out doc responses the speaker never read', type: 'boolean', default: true,
        description: 'Needs Listen. Unread responses get an X; unread new arguments are not flowed.' },
      { key: 'flow-hover', label: 'Flow: switch tabs by hovering over them', type: 'boolean', default: true },
      { key: 'listen-engine', label: 'Listen: speech recognition engine', type: 'select', options: ['auto', 'whisper-server', 'in-app', 'browser'], default: 'auto',
        description: 'auto uses a local Whisper server if one is running, otherwise Whisper inside the app. The browser engine does not work in most desktop apps.' },
      { key: 'listen-lang', label: 'Listen: language (browser engine only)', type: 'text', default: 'en-US' },
      { key: 'whisper-url', label: 'Listen: Whisper server URL', type: 'text', default: 'http://127.0.0.1:8080/inference',
        description: 'whisper.cpp server: http://127.0.0.1:8080/inference. OpenAI-compatible servers: http://localhost:8000/v1/audio/transcriptions.' },
      { key: 'whisper-model', label: 'Listen: Whisper model name (OpenAI-compatible servers)', type: 'text', default: 'whisper-1' },
      { key: 'whisper-inapp-model', label: 'Listen: in-app Whisper model', type: 'text', default: 'Xenova/whisper-tiny.en',
        description: 'Downloaded the first time you listen. whisper-base.en is more accurate but slower.' },
      { key: 'listen-chunk', label: 'Listen: seconds of audio per chunk', type: 'number', default: 8 },
      { key: 'ef-max', label: 'Evidence Finder: max sources', type: 'number', default: 10, description: 'Between 5 and 10.' },
      { key: 'c2-animation', label: 'Show the progress overlay (C1, C2, SH)', type: 'boolean', default: true },
      { key: 'c2-trim', label: 'CC: C2 trims everything below the last highlighted paragraph', type: 'boolean', default: true },
      { key: 'c2-delay', label: 'CC: C2 max wait per simulated keypress (ms)', type: 'number', default: 40,
        description: 'Lower is faster. Raise this if some underlines or highlights get skipped.' },
      { key: 'key-tag', label: 'Shortcut: Tag', type: 'text', default: 'F7', description: 'Written like F7 or Mod-Shift-X. Mod is Cmd on Mac.' },
      { key: 'key-shrink', label: 'Shortcut: Shrink', type: 'text', default: 'Mod-8' },
      { key: 'key-underline', label: 'Shortcut: Underline', type: 'text', default: 'Mod-u' },
      { key: 'key-emphasis', label: 'Shortcut: Emphasis', type: 'text', default: 'F10' },
      { key: 'key-highlight', label: 'Shortcut: Highlight', type: 'text', default: 'F11' },
    ],
    commands: [{
      id: 'cardcutter-v1.cutFromUrl',
      label: 'CC: C1 (URL)',
      keywords: ['cc', 'c1', 'cite', 'card', 'url', 'article', 'cut'],
      defaultKey: null,
      async run(api) { await runCut(api, 'c1'); },
    },
    {
      id: 'cardcutter-v1.cutFullCard',
      label: 'CC: C2 (Full Cut)',
      keywords: ['cc', 'c2', 'cut', 'card', 'tag', 'underline', 'highlight', 'emphasis', 'shrink'],
      defaultKey: null,
      async run(api) { await runCut(api, 'c2'); },
    },
    {
      id: 'cardcutter-v1.evidenceFinder',
      label: 'CC: E (Evidence Finder)',
      keywords: ['cc', 'e', 'evidence', 'find', 'sources', 'claim', 'research'],
      defaultKey: null,
      run(api) { openFinder(api); },
    },
    {
      id: 'cardcutter-v1.shortenHighlight',
      label: 'CC: SH (Shorten Highlight)',
      keywords: ['cc', 'sh', 'shorten', 'highlight', 'filler', 'trim'],
      defaultKey: null,
      run(api) { return shortenHighlight(api); },
    },
    {
      id: 'cardcutter-v1.flow',
      label: 'CC: F (Flow)',
      keywords: ['cc', 'f', 'flow', 'flowing', 'tabs', 'debate'],
      defaultKey: null,
      run(api) { toggleFlow(api); },
    },
    {
      id: 'cardcutter-v1.flowSpeech',
      label: 'CC: FS (Flow Speech)',
      keywords: ['cc', 'fs', 'flow', 'speech', '1ac', '1nc', '2ac', 'cx'],
      defaultKey: null,
      run(api) { return flowSpeechCmd(api); },
    },
    {
      id: 'cardcutter-v1.listen',
      label: 'CC: FL (Listen)',
      keywords: ['cc', 'fl', 'listen', 'record', 'flow', 'transcribe', 'mic'],
      defaultKey: null,
      run(api) { return startListening(api).then(() => undefined); },
    },
    {
      id: 'cardcutter-v1.stopFlow',
      label: 'CC: SF (Stop Flow)',
      keywords: ['cc', 'sf', 'stop', 'listen', 'flow', 'mic'],
      defaultKey: null,
      run(api) { FL.api = api; stopListening(); },
    },
    {
      id: 'cardcutter-v1.testKeys',
      label: 'CC: test formatting shortcuts (inserts a test line)',
      keywords: ['cc', 'test', 'shortcuts', 'keys', 'underline', 'highlight', 'settings'],
      defaultKey: null,
      run(api) { return testKeys(api); },
    },
    {
      id: 'cardcutter-v1.toggleFallbackQuals',
      label: 'CC: toggle fallback when quals are not found',
      keywords: ['cc', 'cardcutter', 'quals', 'fallback', 'settings'],
      defaultKey: null,
      run(api) {
        const next = cfg(api, 'fallback-quals') === 'Writer at publication' ? 'Use placeholder' : 'Writer at publication';
        api.storage.set('fallback-quals', next);
        api.showToast(next === 'Writer at publication'
          ? 'Missing quals will now read "Writer at <publication>" (a guess)'
          : 'Missing quals will now be left as ' + cfg(api, 'quals-placeholder'));
      },
    },
    {
      id: 'cardcutter-v1.setLocalAiModel',
      label: 'CC: set local AI model (Ollama) for quals',
      keywords: ['cc', 'cardcutter', 'ai', 'ollama', 'model', 'settings'],
      defaultKey: null,
      async run(api) {
        const v = await askText('Ollama model name, e.g. llama3.2 (blank turns AI off)', cfg(api, 'ollama-model'));
        if (v === null) return;
        api.storage.set('ollama-model', v);
        api.showToast(v ? 'Local AI on: ' + v : 'Local AI off');
      },
    },
    {
      id: 'cardcutter-v1.toggleAiMode',
      label: 'CC: toggle AI mode (only when rules fail / always)',
      keywords: ['cc', 'cardcutter', 'ai', 'ollama', 'mode', 'settings'],
      defaultKey: null,
      run(api) {
        const next = cfg(api, 'ai-mode') === 'Always' ? 'When rules fail' : 'Always';
        api.storage.set('ai-mode', next);
        api.showToast(next === 'Always' ? 'AI now runs on every card (slower)' : 'AI now runs only when the rules find no quals');
      },
    },
    {
      id: 'cardcutter-v1.toggleCiteStyle',
      label: 'CC: toggle Cite style on "Last YY"',
      keywords: ['cc', 'cardcutter', 'cite', 'style', 'settings'],
      defaultKey: null,
      run(api) {
        const next = cfg(api, 'cite-style') === 'On' ? 'Off' : 'On';
        api.storage.set('cite-style', next);
        api.showToast('Cite style on the author and year: ' + next);
      },
    },
    {
      id: 'cardcutter-v1.setCiteKey',
      label: 'CC: set the Cite shortcut (default F8)',
      keywords: ['cc', 'cardcutter', 'cite', 'shortcut', 'key', 'settings'],
      defaultKey: null,
      async run(api) {
        const v = await askText('Your CardMirror Cite shortcut, e.g. F8 or Mod-Shift-X', cfg(api, 'cite-key'));
        if (!v) return;
        api.storage.set('cite-key', v);
        api.showToast('Cite shortcut: ' + v);
      },
    },
    {
      id: 'cardcutter-v1.cycleDateFormat',
      label: 'CC: cycle date format',
      keywords: ['cc', 'cardcutter', 'date', 'format', 'settings'],
      defaultKey: null,
      run(api) {
        const fmts = ['M/D/YYYY', 'Month D, YYYY', 'YYYY-MM-DD'];
        const next = fmts[(fmts.indexOf(cfg(api, 'date-format')) + 1) % fmts.length];
        api.storage.set('date-format', next);
        api.showToast('Date format: ' + next + ' (e.g. ' + formatDate({ y: 2026, m: 3, d: 5 }, next) + ')');
      },
    },
    {
      id: 'cardcutter-v1.toggleWebLookup',
      label: 'CC: toggle web lookup of author / site quals',
      keywords: ['cc', 'cardcutter', 'lookup', 'search', 'quals', 'settings'],
      defaultKey: null,
      run(api) {
        const next = cfg(api, 'web-lookup') === 'Off' ? 'On' : 'Off';
        api.storage.set('web-lookup', next);
        api.showToast(next === 'On' ? 'Web lookup on: the author or site name is searched on DuckDuckGo and Wikipedia when quals are missing'
          : 'Web lookup off: nothing is sent to search engines');
      },
    },
    {
      id: 'cardcutter-v1.setFetchPrefix',
      label: 'CC: set fetch proxy prefix (optional)',
      keywords: ['cc', 'cardcutter', 'proxy', 'fetch', 'cors', 'settings'],
      defaultKey: null,
      async run(api) {
        const v = await askText('Proxy URL prefix (blank = fetch directly; sends your URLs to the proxy)', cfg(api, 'fetch-prefix'));
        if (v === null) return;
        api.storage.set('fetch-prefix', v);
        api.showToast(v ? 'Fetch prefix saved' : 'Fetching directly');
      },
    },
    {
      id: 'cardcutter-v1.setQualsPlaceholder',
      label: 'CC: set placeholder text for missing quals',
      keywords: ['cc', 'cardcutter', 'quals', 'placeholder', 'settings'],
      defaultKey: null,
      async run(api) {
        const v = await askText('Placeholder when no quals are found', cfg(api, 'quals-placeholder'));
        if (v === null) return;
        api.storage.set('quals-placeholder', v || 'QUALS');
        api.showToast('Placeholder: ' + (v || 'QUALS'));
      },
    },
    {
      id: 'cardcutter-v1.testLocalAi',
      label: 'CC: test local AI connection',
      keywords: ['cc', 'cardcutter', 'ai', 'ollama', 'test'],
      defaultKey: null,
      async run(api) {
        const model = clean(cfg(api, 'ollama-model'));
        const base = clean(cfg(api, 'ollama-url')) || 'http://localhost:11434';
        if (!model) { api.showToast('No AI model set. Run "Set local AI model" first.'); return; }
        try {
          const res = await fetch(base + '/api/tags');
          const names = ((await res.json()).models || []).map((m) => m.name);
          const has = names.some((n) => n === model || n.split(':')[0] === model);
          api.showToast(has ? 'Ollama is reachable and "' + model + '" is installed. AI is ready.'
            : 'Ollama is reachable but "' + model + '" is not installed. Installed: ' + (names.join(', ') || 'none'));
        } catch (e) {
          console.warn('[cardcutter-v1] ollama test', e);
          api.showToast('Cannot reach Ollama at ' + base + ' (' + (e && e.message || e) +
            '). Open the Ollama app, and allow this app with OLLAMA_ORIGINS.');
        }
      },
    },
    {
      id: 'cardcutter-v1.showSettings',
      label: 'CC: show current settings',
      keywords: ['cc', 'cardcutter', 'settings'],
      defaultKey: null,
      run(api) {
        api.showToast('Fallback: ' + cfg(api, 'fallback-quals') + ' · Placeholder: ' + cfg(api, 'quals-placeholder') +
          ' · AI: ' + (cfg(api, 'ollama-model') ? cfg(api, 'ollama-model') + ' (' + cfg(api, 'ai-mode') + ')' : 'off') + ' · Proxy: ' + (cfg(api, 'fetch-prefix') || 'none') +
          ' · Cite style: ' + cfg(api, 'cite-style') + ' (' + cfg(api, 'cite-key') + ') · Date: ' + cfg(api, 'date-format'));
      },
    }],
  });

  // test hook (harmless in the app)
  window.__cardCutterTest = { cut, bioToQuals, parseNames, splitName, styleCite, insertText, parseDateStr, parseClip, FL, LISTEN, flowSpeech, flowCX, parseItems, group1AC, droppedMap, normSpeech, shortCite, readBodies, pushFinal, takeTranscript, startListening, stopListening, toggleFlow, flPaint, flowSpeechCmd, buildPlan, splitSentences, highlightRanges, classify, judgeMeta, claimTerms };
})();
