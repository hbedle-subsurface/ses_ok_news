/* ------------------------------------------------------------------
   app.js — reads what the crawler collected and lets you work through it.

   The data files sit in this repository, so they load from the same
   origin and there is no API to call from the browser. Your coding is
   kept in this browser, with a backup button, because a page served
   from GitHub Pages cannot write back to the repository.
------------------------------------------------------------------ */

const SAVE_KEY = 'ses_ok_news_codes_v1';

let BOOK = null;          // codebook.json
let ALL = [];             // every collected article
let RUNS = [];            // collection history
let META = {};            // updated stamp, threshold
let CODES = loadCodes();  // article id -> { tags:[], star, note, read }
let SELECTED = null;
let STATE_TOTALS = {};
let CUE_TOTALS = {};

const F = {
  q: '',
  states: new Set(),
  topics: new Set(),
  outlets: new Set(),
  marks: new Set(),
  days: 0,             // 0 means everything
  showWeak: false,
  hideElsewhere: false
};

const $ = s => document.querySelector(s);
/* Sidebar sections are optional. If index.html is missing one, that section
   is skipped rather than throwing and leaving the rest of the page blank. */
const slot = s => document.querySelector(s) || { innerHTML: '', textContent: '',
                                                 appendChild() {} };
const $$ = s => Array.from(document.querySelectorAll(s));
const esc4 = s => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;');

/* ========================== persistence ========================== */

function loadCodes() {
  try { return JSON.parse(localStorage.getItem(SAVE_KEY)) || {}; }
  catch (e) { return {}; }
}
function saveCodes() {
  try { localStorage.setItem(SAVE_KEY, JSON.stringify(CODES)); }
  catch (e) { /* private browsing; the backup button is the fallback */ }
}
function codeOf(a) {
  if (!CODES[a.id]) CODES[a.id] = { tags: [], star: false, note: '', read: false };
  return CODES[a.id];
}

/* ============================= startup =========================== */

start();

async function start() {
  let book, data, runs;
  try {
    [book, data, runs] = await Promise.all([
      fetch('codebook.json').then(r => r.json()),
      fetch('data/articles.json').then(r => r.json()),
      fetch('data/runs.json').then(r => r.json()).catch(() => ({ runs: [] }))
    ]);
  } catch (err) {
    return showOpening('This page needs a web server',
      '<p>It loads its data from files in this repository, and a browser will not '
      + 'read those from a <code>file://</code> address. Open it at its published '
      + 'address instead, or from a local server '
      + '(<code>python3 -m http.server</code> in the repository folder).</p>'
      + '<p class="quiet">' + esc4(err.message) + '</p>');
  }

  BOOK = book;
  ALL = data.articles || [];
  META = { updated: data.updated, threshold: data.threshold || 2 };
  RUNS = runs.runs || [];

  if (!ALL.length) return showEmpty();

  computeTotals();
  buildControls();
  $('#opening').hidden = true;
  $('#top').hidden = false;
  $('#wrap').hidden = false;
  render();
}

function showOpening(title, html) {
  $('#opentitle').textContent = title;
  $('#openbody').innerHTML = html;
}

function showEmpty() {
  showOpening('Nothing collected yet',
    '<p>The crawler has not run, so there is nothing to read. It searches GDELT and '
    + 'Google News for coverage of energy infrastructure proposed in Oklahoma and the '
    + 'public response to it, and writes what it finds back into this repository.</p>'
    + '<h3>Starting it</h3>'
    + '<ol class="steps">'
    + '<li>Go to the <b>Actions</b> tab of this repository.</li>'
    + '<li>Choose <b>Collect Oklahoma energy news</b> in the left column.</li>'
    + '<li>Press <b>Run workflow</b>. On a first run set <b>days</b> to 90; leave the '
    + 'other boxes blank.</li>'
    + '<li>It takes five or six minutes. Reload this page when it finishes.</li>'
    + '</ol>'
    + '<p class="quiet">After that it runs itself every Friday. GDELT only indexes '
    + 'about three months back, so the weekly run is what builds the archive — '
    + 'coverage from a month nobody collects cannot be recovered later.</p>');
}

function computeTotals() {
  STATE_TOTALS = {}; CUE_TOTALS = {};
  for (const a of ALL) {
    for (const s of placesOf(a)) STATE_TOTALS[s] = (STATE_TOTALS[s] || 0) + 1;
    for (const c of a.cues || []) CUE_TOTALS[c] = (CUE_TOTALS[c] || 0) + 1;
  }
}

/* A state named in the headline is a fact; the state whose search found
   the article is a good guess. Both are usable for filtering, and the
   difference is shown wherever it matters. */
function placesOf(a) {
  const set = new Set(a.states || []);
  for (const v of a.via_states || []) set.add(v);
  return Array.from(set);
}
function stateIsCertain(a, s) { return (a.states || []).includes(s); }

/* =========================== filtering =========================== */

function daysAgo(iso) {
  if (!iso) return 1e6;
  return (Date.now() - new Date(iso + 'T12:00:00Z').getTime()) / 86400000;
}

function passes(a) {
  if (a.weak && !F.showWeak) return false;
  if (F.hideElsewhere && a.elsewhere) return false;
  if (F.states.size && !placesOf(a).some(s => F.states.has(s))) return false;
  if (F.topics.size && !(a.topics || []).some(t => F.topics.has(t))) return false;
  if (F.outlets.size && !F.outlets.has(a.outlet)) return false;
  if (F.days && daysAgo(a.published) > F.days) return false;

  if (F.marks.size) {
    const c = CODES[a.id];
    let ok = false;
    if (F.marks.has('unread') && !(c && c.read)) ok = true;
    if (F.marks.has('star') && c && c.star) ok = true;
    if (F.marks.has('coded') && c && c.tags.length) ok = true;
    if (F.marks.has('noted') && c && c.note) ok = true;
    if (!ok) return false;
  }
  if (F.q) {
    const hay = (a.title + ' ' + a.outlet + ' ' + (a.counties || []).join(' ')).toLowerCase();
    if (!hay.includes(F.q.toLowerCase())) return false;
  }
  return true;
}

const current = () => ALL.filter(passes);

/* ============================ controls =========================== */

function chip(label, count, on, onClick, cls) {
  const b = document.createElement('button');
  b.className = 'chip' + (cls ? ' ' + cls : '');
  b.setAttribute('aria-pressed', on ? 'true' : 'false');
  b.innerHTML = esc4(label) + (count != null ? ' <span class="n">' + count + '</span>' : '');
  b.addEventListener('click', onClick);
  return b;
}
const toggle = (set, v) => set.has(v) ? set.delete(v) : set.add(v);

function buildControls() {
  $('#q').addEventListener('input', e => { F.q = e.target.value.trim(); render(); });
  $('#exCoded').addEventListener('click', exportCoded);
  $('#exList').addEventListener('click', exportList);
  $('#exSess').addEventListener('click', exportSession);
  $('#imSess').addEventListener('click', () => $('#sessfile').click());
  $('#sessfile').addEventListener('change', importSession);
}

const TOPIC_LABEL = {
  solar: 'Solar', wind: 'Wind', storage: 'Battery storage',
  data_center: 'Data centers', carbon_capture: 'Carbon capture and CO2 pipelines',
  nuclear: 'Nuclear', hydrogen: 'Hydrogen', hydropower: 'Hydropower and dams',
  transmission: 'Transmission lines',
  disposal_seismicity: 'Disposal wells and earthquakes',
  geothermal: 'Geothermal', biogas: 'Biogas and digesters',
  agrivoltaics: 'Agrivoltaics', solar_on_water: 'Canals and reservoirs'
};
function topicLabel(id) { return TOPIC_LABEL[id] || id; }

function renderControls(hits) {
  const strip = slot('#strip'); strip.innerHTML = '';
  const maxState = Math.max(1, ...Object.values(STATE_TOTALS));
  const live = {};
  for (const a of hits) for (const s of placesOf(a)) live[s] = (live[s] || 0) + 1;
  const names = Object.keys(STATE_TOTALS).sort();
  const few = names.length <= 16;

  slot('#striplab').textContent = hits.length === ALL.length
    ? 'Articles per state. Click one to filter.'
    : 'Bar height is each state\u2019s full total; the solid part is what the filters leave.';

  for (const s of names) {
    const total = STATE_TOTALS[s], now = live[s] || 0;
    const b = document.createElement('button');
    b.className = 'stbar';
    b.setAttribute('aria-pressed', F.states.has(s) ? 'true' : 'false');
    b.title = s + ' \u2014 ' + now + ' shown of ' + total;
    const outline = Math.max(2, Math.round(34 * total / maxState));
    const fill = Math.round(outline * now / total);
    b.innerHTML =
      '<span class="bar"><span class="fill" style="height:' + outline + 'px">' +
      '<span class="fill live" style="display:block;height:' + fill + 'px;margin-top:' +
      (outline - fill) + 'px"></span></span></span>' +
      '<span class="lbl">' + esc4(s.length > 9 ? s.slice(0, 8) + '.' : s) +
      (few ? '<span class="cnt">' + now + '</span>' : '') + '</span>';
    b.addEventListener('click', () => { toggle(F.states, s); render(); });
    strip.appendChild(b);
  }

  const sp = slot('#statepick'); sp.innerHTML = '';
  for (const s of names) {
    sp.appendChild(chip(s, STATE_TOTALS[s], F.states.has(s),
      () => { toggle(F.states, s); render(); }));
  }
  const guessed = ALL.filter(a => !(a.states || []).length && (a.via_states || []).length).length;
  slot('#statenote').textContent = guessed
    ? guessed + ' of these name no state in the headline and are placed by which '
      + 'search found them. The exported table keeps the two apart.'
    : '';

  const tp = slot('#topicpick'); tp.innerHTML = '';
  const topics = {};
  for (const a of ALL) for (const t of a.topics || []) topics[t] = (topics[t] || 0) + 1;
  for (const t of Object.keys(topics).sort()) {
    tp.appendChild(chip(topicLabel(t), topics[t], F.topics.has(t),
      () => { toggle(F.topics, t); render(); }));
  }

  const dp = slot('#datepick'); dp.innerHTML = '';
  for (const [d, label] of [[7, 'Past week'], [30, 'Past month'],
                            [90, 'Past 3 months'], [0, 'Everything']]) {
    dp.appendChild(chip(label, ALL.filter(a => !d || daysAgo(a.published) <= d).length,
      F.days === d, () => { F.days = d; render(); }));
  }

  const op = slot('#outletpick'); op.innerHTML = '';
  const outlets = {};
  for (const a of ALL) if (!a.weak) outlets[a.outlet] = (outlets[a.outlet] || 0) + 1;
  const top = Object.entries(outlets).sort((x, y) => y[1] - x[1]).slice(0, 12);
  for (const [name, n] of top) {
    op.appendChild(chip(name, n, F.outlets.has(name),
      () => { toggle(F.outlets, name); render(); }));
  }

  const mp = slot('#markpick'); mp.innerHTML = '';
  const cnt = fn => ALL.filter(fn).length;
  mp.appendChild(chip('Not read yet', cnt(a => !(CODES[a.id] && CODES[a.id].read)),
    F.marks.has('unread'), () => { toggle(F.marks, 'unread'); render(); }, 'g'));
  mp.appendChild(chip('To follow up', cnt(a => CODES[a.id] && CODES[a.id].star),
    F.marks.has('star'), () => { toggle(F.marks, 'star'); render(); }, 'g'));
  mp.appendChild(chip('Coded', cnt(a => CODES[a.id] && CODES[a.id].tags.length),
    F.marks.has('coded'), () => { toggle(F.marks, 'coded'); render(); }, 'g'));
  mp.appendChild(chip('With a note', cnt(a => CODES[a.id] && CODES[a.id].note),
    F.marks.has('noted'), () => { toggle(F.marks, 'noted'); render(); }, 'g'));

  const ep = slot('#elsewherepick');
  {
    ep.innerHTML = '';
    const away = ALL.filter(a => a.elsewhere).length;
    if (away) {
      ep.appendChild(chip(F.hideElsewhere ? 'Hidden' : 'Showing them', away,
        F.hideElsewhere, () => { F.hideElsewhere = !F.hideElsewhere; render(); }, 'g'));
      slot('#elsewherenote').textContent = away + ' articles name a state other than '
        + 'Oklahoma. They are kept because they are often the same story from a '
        + 'competing state \u2014 West Virginia and Tennessee are bidding for the same '
        + 'DOE nuclear campus \u2014 but they should not sit unmarked among Oklahoma\u2019s own.';
    } else {
      slot('#elsewherenote').textContent = 'Nothing so far from outside Oklahoma.';
    }
  }

  const wp = slot('#weakpick'); wp.innerHTML = '';
  const weak = ALL.filter(a => a.weak).length;
  wp.appendChild(chip(F.showWeak ? 'Showing them' : 'Hidden', weak, F.showWeak,
    () => { F.showWeak = !F.showWeak; render(); }, 'g'));
  slot('#weaknote').textContent = weak
    ? 'A search for "solar farm" in Texas also turns up module prices and earnings '
      + 'reports. These scored too low to look like a local siting story. Worth a '
      + 'glance now and then to see what is being thrown away.'
    : '';
}

function renderActive() {
  const box = slot('#active'); box.innerHTML = '';
  const items = [];
  for (const v of F.states) items.push([v, () => F.states.delete(v)]);
  for (const v of F.topics) items.push([topicLabel(v), () => F.topics.delete(v)]);
  for (const v of F.outlets) items.push([v, () => F.outlets.delete(v)]);
  for (const v of F.marks) items.push([MARK_LABEL[v] || v, () => F.marks.delete(v)]);
  if (F.days) items.push(['past ' + F.days + ' days', () => { F.days = 0; }]);
  if (F.showWeak) items.push(['including off-topic', () => { F.showWeak = false; }]);
  if (F.hideElsewhere) items.push(['Oklahoma only', () => { F.hideElsewhere = false; }]);
  if (F.q) items.push(['contains "' + F.q + '"', () => { F.q = ''; $('#q').value = ''; }]);
  if (!items.length) return;

  for (const [label, drop] of items) {
    const b = document.createElement('button');
    b.className = 'pill';
    b.title = 'Remove this filter';
    b.innerHTML = esc4(label) + '<span class="x" aria-hidden="true">\u00d7</span>';
    b.addEventListener('click', () => { drop(); render(); });
    box.appendChild(b);
  }
  if (items.length > 1) {
    const c = document.createElement('button');
    c.className = 'pill clear';
    c.textContent = 'Clear all';
    c.addEventListener('click', () => {
      F.q = ''; $('#q').value = ''; F.days = 0; F.showWeak = false;
      F.states.clear(); F.topics.clear(); F.outlets.clear(); F.marks.clear();
      F.hideElsewhere = false;
      render();
    });
    box.appendChild(c);
  }
}

const MARK_LABEL = { unread: 'Not read yet', star: 'To follow up',
                     coded: 'Coded', noted: 'With a note' };

/* ============================ rendering ========================== */

function render() {
  const hits = current();
  renderControls(hits);
  renderActive();

  const strong = ALL.filter(a => !a.weak).length;
  slot('#counts').innerHTML = '<b>' + strong + '</b> articles worth reading · '
    + (ALL.length - strong) + ' set aside';
  slot('#updated').textContent = META.updated
    ? 'collected through ' + META.updated.slice(0, 10) : '';

  const read = hits.filter(a => CODES[a.id] && CODES[a.id].read).length;
  slot('#hits').textContent = hits.length + ' article' + (hits.length === 1 ? '' : 's')
    + (hits.length ? ' · ' + read + ' read' : '');

  if (SELECTED && hits.some(a => a.id === SELECTED)) renderDetail(hits);
  else { SELECTED = null; renderList(hits); }

  renderWork();
  renderTally(hits);

  const r = RUNS[0];
  slot('#runinfo').textContent = r
    ? r.when.slice(0, 10) + ' — ' + r.searches + ' searches, ' + r.new
      + ' new, ' + r.total + ' on file'
      + (r.problems && r.problems.length ? '. ' + r.problems.length + ' searches had trouble.' : '')
    : 'No run recorded yet.';
}

function renderList(hits) {
  const list = $('#list'); list.innerHTML = '';
  if (!hits.length) {
    list.innerHTML = '<p class="empty">Nothing matches that combination. Widen the '
      + 'states, or clear the search box.</p>';
    return;
  }
  const frag = document.createDocumentFragment();
  for (const a of hits.slice(0, 400)) {
    const c = CODES[a.id];
    const d = document.createElement('div');
    d.className = 'art ' + (a.weak ? 'weak' : 'strong') + (c && c.read ? ' seen' : '');
    d.tabIndex = 0;
    const tags = []
      .concat((a.topics || []).map(t => '<span class="tag topic">' + topicLabel(t) + '</span>'))
      .concat((a.counties || []).map(x => '<span class="tag place">' + esc4(x) + '</span>'))
      .concat(c && c.star ? ['<span class="tag star">to follow up</span>'] : [])
      .concat(c && c.tags.length ? ['<span class="tag">' + c.tags.length + ' coded</span>'] : []);
    d.innerHTML =
      '<div class="hd">' + esc4(a.title) + '</div>' +
      '<div class="meta">' + esc4(a.outlet || a.domain) +
        (a.published ? ' · ' + esc4(a.published) : '') +
        ((a.states || []).length
          ? ' · ' + esc4(a.states.join(', '))
          : (a.via_states || []).length
            ? ' · likely ' + esc4(a.via_states.join('/'))
            : '') + '</div>' +
      (tags.length ? '<div>' + tags.join('') + '</div>' : '');
    const open = () => { SELECTED = a.id; render(); window.scrollTo(0, 0); };
    d.addEventListener('click', open);
    d.addEventListener('keydown', e => { if (e.key === 'Enter') open(); });
    frag.appendChild(d);
  }
  list.appendChild(frag);
  if (hits.length > 400) {
    const p = document.createElement('p');
    p.className = 'quiet';
    p.textContent = 'Showing the first 400. Narrow the filter to see the rest.';
    list.appendChild(p);
  }
}

function renderDetail(hits) {
  const a = ALL.find(x => x.id === SELECTED);
  const c = codeOf(a);
  const idx = hits.findIndex(x => x.id === a.id);
  const list = $('#list');

  const box = cat => '<label class="code" title="' + esc4(cat.hint) + '">'
    + '<input type="checkbox" data-code="' + cat.id + '"'
    + (c.tags.includes(cat.id) ? ' checked' : '') + '>'
    + '<span>' + esc4(cat.label) + '</span></label>';

  const upFront = BOOK.categories.filter(
    x => (a.cues || []).includes(x.id) || c.tags.includes(x.id));
  const rest = BOOK.categories.filter(x => !upFront.includes(x));

  const sug = upFront.length
    ? '<div class="sugbox"><div class="codegroup">Words in the headline point at '
      + 'these. The headline is all this page has, so read the article before '
      + 'ticking anything.</div><div class="codegrid">'
      + upFront.map(box).join('') + '</div></div>'
    : '';

  const all = '<details class="allcodes"' + (upFront.length ? '' : ' open')
    + '><summary>All ' + BOOK.categories.length + ' categories</summary><div class="codegrid">'
    + BOOK.groups.map(g => {
        const cats = rest.filter(x => x.group === g.id);
        if (!cats.length) return '';
        return '<div><div class="codegroup">' + esc4(g.label) + '</div>'
             + cats.map(box).join('') + '</div>';
      }).join('')
    + '</div></details>';

  list.innerHTML =
    '<div class="navrow">' +
      '<button class="btn ghost" id="back">All articles</button>' +
      '<span class="spacer"></span>' +
      '<span class="kbd">' + (idx + 1) + ' of ' + hits.length + '</span>' +
      '<button class="btn ghost" id="prev"' + (idx > 0 ? '' : ' disabled') + '>Previous</button>' +
      '<button class="btn ghost" id="next"' + (idx < hits.length - 1 ? '' : ' disabled') +
        '>Next</button>' +
    '</div>' +
    '<div class="detail">' +
      '<h3>' + esc4(a.title) + '</h3>' +
      '<div class="where">' + esc4(a.outlet || a.domain) +
        (a.published ? ' · ' + esc4(a.published) : '') +
        ((a.counties || []).length ? ' · ' + esc4(a.counties.join(', ')) : '') +
        ((a.states || []).length ? ' · ' + esc4(a.states.join(', ')) : '') +
        (!(a.states || []).length && (a.via_states || []).length
          ? ' · found by the ' + esc4(a.via_states.join('/')) + ' search' : '') +
        (a.elsewhere ? ' · ' + esc4((a.other_states || []).join(', ')) : '') +
        (a.weak ? ' · set aside as off-topic' : '') + '</div>' +
      '<div class="readfirst">' +
        '<a class="btn" href="' + esc4(a.url) + '" target="_blank" rel="noopener">'
          + 'Open the article</a>' +
        '<p>Only the headline, outlet, date and link are stored here. Everything you '
          + 'code comes from reading the piece itself.</p>' +
      '</div>' +
      '<h4>Follow up</h4>' +
      '<button class="btn' + (c.star ? '' : ' ghost') + '" id="star">' +
        (c.star ? 'On your follow-up list' : 'Add to follow-up list') + '</button>' +
      '<h4>What was raised</h4>' + sug + all +
      '<h4>Your note</h4>' +
      '<textarea class="note" id="note" placeholder="Who objected, what they said, '
        + 'anything worth quoting">' + esc4(c.note) + '</textarea>' +
    '</div>';

  if (!c.read) { c.read = true; saveCodes(); }

  $('#back').addEventListener('click', () => { SELECTED = null; render(); });
  const go = d => {
    const j = idx + d;
    if (j >= 0 && j < hits.length) { SELECTED = hits[j].id; render(); window.scrollTo(0, 0); }
  };
  $('#prev').addEventListener('click', () => go(-1));
  $('#next').addEventListener('click', () => go(1));
  $('#star').addEventListener('click', () => { c.star = !c.star; saveCodes(); render(); });
  $$('#list input[data-code]').forEach(bx => {
    bx.addEventListener('change', () => {
      const id = bx.dataset.code;
      if (bx.checked) { if (!c.tags.includes(id)) c.tags.push(id); }
      else c.tags = c.tags.filter(t => t !== id);
      saveCodes(); renderTally(current()); renderWork();
    });
  });
  $('#note').addEventListener('input', e => { c.note = e.target.value; saveCodes(); });
}

document.addEventListener('keydown', e => {
  if (!SELECTED) return;
  if (e.target.tagName === 'TEXTAREA' || e.target.tagName === 'INPUT') return;
  if (e.key === 'ArrowRight') { const b = $('#next'); if (b && !b.disabled) b.click(); }
  if (e.key === 'ArrowLeft') { const b = $('#prev'); if (b && !b.disabled) b.click(); }
  if (e.key === 'Escape') { SELECTED = null; render(); }
});

function renderWork() {
  const ul = $('#work'); ul.innerHTML = '';
  const starred = ALL.filter(a => CODES[a.id] && CODES[a.id].star);
  if (!starred.length) {
    slot('#worknote').textContent = 'Open an article and add it here when it is worth '
      + 'coming back to — a project to track, or a fight worth reading the whole '
      + 'record on.';
    return;
  }
  slot('#worknote').textContent = starred.length + ' article'
    + (starred.length === 1 ? '' : 's') + ' set aside.';
  for (const a of starred) {
    const li = document.createElement('li');
    const c = CODES[a.id];
    li.innerHTML = '<div class="wnm">' + esc4(a.title.slice(0, 90)) + '</div>'
      + '<div class="wmeta">' + esc4(a.outlet) + ' · ' + esc4(a.published)
      + (c.tags.length ? ' · ' + c.tags.length + ' coded' : ' · not yet coded') + '</div>';
    li.addEventListener('click', () => { SELECTED = a.id; render(); window.scrollTo(0, 0); });
    ul.appendChild(li);
  }
}

function renderTally(hits) {
  const ul = $('#tally'); ul.innerHTML = '';
  const confirmed = {}, suggested = {};
  for (const a of hits) {
    const c = CODES[a.id];
    if (c) for (const t of c.tags) confirmed[t] = (confirmed[t] || 0) + 1;
    for (const s of a.cues || []) suggested[s] = (suggested[s] || 0) + 1;
  }
  const own = Object.keys(confirmed).length > 0;
  const src = own ? confirmed : suggested;
  const denom = Math.max(1, ...Object.values(CUE_TOTALS), ...Object.values(confirmed));

  const rows = BOOK.categories.map(c => ({ c, n: src[c.id] || 0 }))
    .filter(x => x.n > 0).sort((a, b) => b.n - a.n).slice(0, 14);

  if (!rows.length) { slot('#tallynote').textContent = 'Nothing to count yet.'; return; }
  for (const { c, n } of rows) {
    const li = document.createElement('li');
    li.innerHTML = '<span class="tn">' + n + '</span>'
      + '<span class="tbar" style="width:' + Math.max(2, Math.round(70 * n / denom)) + 'px"></span>'
      + '<span class="tl" title="' + esc4(c.hint) + '">' + esc4(c.label) + '</span>';
    ul.appendChild(li);
  }
  slot('#tallynote').textContent = own
    ? 'Counting the categories you confirmed after reading.'
    : 'Counting headline word matches only. Headlines are short, so this undercounts '
    + 'badly. It is replaced by your own codes as soon as you confirm any.';
}

/* ============================ exporting ========================== */

const csvCell = v => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
};
function download(name, text, mime) {
  const blob = new Blob([text], { type: (mime || 'text/csv') + ';charset=utf-8' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
const stamp = () => new Date().toISOString().slice(0, 10);

function exportCoded() {
  const use = current();
  const head = ['article_id', 'headline', 'outlet', 'published', 'url', 'topics',
                'state_in_headline', 'state_from_search', 'counties', 'relevance_score',
                'off_topic', 'read', 'follow_up', 'n_codes', 'note']
    .concat(BOOK.categories.map(c => 'code_' + c.id));
  const body = use.map(a => {
    const c = CODES[a.id] || { tags: [], note: '', star: false, read: false };
    return [a.id, a.title, a.outlet, a.published, a.url, (a.topics || []).join(';'),
            (a.states || []).join(';'), (a.via_states || []).join(';'),
            (a.other_states || []).join(';'), a.elsewhere ? 1 : 0,
            a.score, a.weak ? 1 : 0,
            c.read ? 1 : 0, c.star ? 1 : 0, c.tags.length, c.note]
      .concat(BOOK.categories.map(x => c.tags.includes(x.id) ? 1 : 0));
  });
  download('coded_articles_' + stamp() + '.csv',
    [head, ...body].map(r => r.map(csvCell).join(',')).join('\n'));
}

function exportList() {
  const use = current();
  const head = ['published', 'outlet', 'headline', 'url', 'topics', 'counties',
                'state_in_headline', 'state_from_search', 'relevance_score', 'off_topic'];
  const body = use.map(a => [a.published, a.outlet, a.title, a.url,
    (a.topics || []).join(';'), (a.counties || []).join(';'),
    (a.states || []).join(';'), (a.via_states || []).join(';'),
    a.score, a.weak ? 1 : 0]);
  download('reading_list_' + stamp() + '.csv',
    [head, ...body].map(r => r.map(csvCell).join(',')).join('\n'));
}

function exportSession() {
  const out = {};
  for (const a of ALL) {
    const c = CODES[a.id];
    if (!c) continue;
    if (!c.star && !c.note && !c.tags.length && !c.read) continue;
    out[a.id] = { tags: c.tags, star: c.star, note: c.note, read: c.read,
                  headline: a.title.slice(0, 120) };
  }
  download('coding_backup_' + stamp() + '.json',
    JSON.stringify({ saved: new Date().toISOString(), codes: out }, null, 2),
    'application/json');
}

async function importSession(e) {
  const f = e.target.files[0];
  if (!f) return;
  try {
    const data = JSON.parse(await f.text());
    const incoming = data.codes || {};
    let matched = 0;
    for (const a of ALL) {
      const hit = incoming[a.id];
      if (!hit) continue;
      const c = codeOf(a);
      c.tags = Array.from(new Set(c.tags.concat(hit.tags || [])));
      c.star = c.star || !!hit.star;
      c.read = c.read || !!hit.read;
      c.note = c.note ? c.note + (hit.note ? '\n' + hit.note : '') : (hit.note || '');
      matched++;
    }
    saveCodes(); render();
    alert('Restored ' + matched + ' of ' + Object.keys(incoming).length + ' articles. '
      + (matched < Object.keys(incoming).length
         ? 'The rest are not in the current file — they may have aged out.' : ''));
  } catch (err) {
    alert('That file could not be read: ' + err.message);
  }
  e.target.value = '';
}
