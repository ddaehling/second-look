(() => {
  'use strict';

  const STORAGE_KEY = 'second-look-reading-v1';
  const PAGE_SIZE = 40;
  const main = document.getElementById('main');
  const icons = {
    search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4.5 4.5"/>',
    bookmark: '<path d="M6 3h12v18l-6-4-6 4z"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    arrow: '<path d="M4 12h15m-6-6 6 6-6 6"/>',
    back: '<path d="M20 12H5m6-6-6 6 6 6"/>',
    external: '<path d="M13 4h7v7M20 4 10 14M9 4H4v16h16v-5"/>',
    close: '<path d="m6 6 12 12M6 18 18 6"/>',
    filter: '<path d="M4 7h16M4 17h16"/><circle cx="9" cy="7" r="2.5" fill="currentColor"/><circle cx="15" cy="17" r="2.5" fill="currentColor"/>',
    print: '<path d="M7 8V3h10v5M7 17H4V9h16v8h-3M7 14h10v7H7zM17 11h.01"/>',
    link: '<path d="m10 14 4-4m-7 2-2 2a4 4 0 0 0 6 6l3-3m3-5 2-2a4 4 0 0 0-6-6l-3 3"/>',
  };
  const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${icons[name] || icons.arrow}</svg>`;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const safeURL = (value, images = false) => {
    try {
      const raw = String(value || '').trim();
      if (!raw) return '';
      const parsed = new URL(raw, location.href);
      if (['http:', 'https:'].includes(parsed.protocol)) return raw;
      if (images && parsed.protocol === 'file:' && !raw.includes(':')) return raw;
      return raw.startsWith('#') ? raw : '';
    } catch { return ''; }
  };
  const formatDate = value => {
    if (!value) return 'Date not recorded';
    const date = new Date(String(value).slice(0, 10) + 'T12:00:00Z');
    return Number.isNaN(+date) ? String(value) : date.toLocaleDateString('en-GB', {day:'numeric',month:'short',year:'numeric',timeZone:'UTC'});
  };
  const reportDate = entry => entry.earliestDate && entry.earliestDate !== entry.date ? `${formatDate(entry.earliestDate)} – ${formatDate(entry.date)}` : formatDate(entry.date);
  const activityTime = entry => Date.parse(entry.activityAt || '') || Date.parse(entry.date || '') || 0;
  const compareActivity = (a,b) => activityTime(b)-activityTime(a) || (Number(b.activityOrder)||0)-(Number(a.activityOrder)||0) || String(b.date || '').localeCompare(String(a.date || '')) || b.score-a.score;
  const activityLabel = entry => {
    if (!entry.lastBookmarkAddedAt || !['new-report','new-mention'].includes(entry.activityKind)) return '';
    const count = Math.max(1, Number(entry.lastAddedBookmarkCount) || 1);
    return entry.activityKind === 'new-report' ? `Added to collection ${formatDate(entry.lastBookmarkAddedAt)}` : `${count===1?'New bookmark':`${num(count)} new bookmarks`} added ${formatDate(entry.lastBookmarkAddedAt)}`;
  };
  const monthLabel = value => new Date(`${value}-01T12:00:00Z`).toLocaleDateString('en-GB', {month:'long',year:'numeric',timeZone:'UTC'});
  const num = value => Number(value || 0).toLocaleString('en-GB');
  const readingTime = entry => Math.max(1, Math.ceil(entry.wordCount / 220));
  const entryURL = id => `#/entry/${encodeURIComponent(id)}`;
  const textFromHTML = html => {
    const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
    return doc.body.textContent || '';
  };
  let collection = {metadata:{},entries:[],excluded:[]};
  let reading = {version:1,queue:[],read:[],positions:{},lastOpened:null};
  let storageAvailable = true;
  let view = 'all';
  let filters = {q:'', category:'', tag:'', month:'', score:'', unread:false, sort:'impact'};
  let visibleCount = PAGE_SIZE;
  let currentEntry = null;
  let observer = null;
  let embedSession = null;
  let xWidgetsPromise = null;
  let toastTimer = null;
  let searchTimer = null;
  let scrollTimer = null;
  let navigationIdentity = '';
  let lastIndexHash = '#/';
  let lastIndexY = 0;
  let lastIndexVisibleCount = PAGE_SIZE;
  let hasRendered = false;

  function readStoredState() {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) reading = cleanReadingState(JSON.parse(stored));
    } catch { storageAvailable = false; }
  }

  function cleanReadingState(value) {
    if (!value || typeof value !== 'object') throw new Error('Not a reading-state file.');
    const cleanList = list => Array.isArray(list) ? [...new Set(list.filter(id => typeof id === 'string'))] : [];
    const positions = {};
    for (const [id, p] of Object.entries(value.positions || {})) {
      if (p && typeof p === 'object' && Number.isFinite(p.progress)) positions[id] = {progress:Math.min(1, Math.max(0, p.progress)),section:typeof p.section === 'string' ? p.section : '',updatedAt:typeof p.updatedAt === 'string' ? p.updatedAt : ''};
    }
    return {version:1,queue:cleanList(value.queue),read:cleanList(value.read),positions,lastOpened:typeof value.lastOpened === 'string' ? value.lastOpened : null};
  }

  function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(reading)); }
    catch {
      if (storageAvailable) toast('Browser storage is unavailable. Export your reading state to keep it.');
      storageAvailable = false;
    }
    updateNavigation();
  }

  function toast(message) {
    const el = document.getElementById('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 4200);
  }

  function updateNavigation() {
    const ids = new Set(collection.entries.map(e => e.id));
    document.getElementById('nav-total').textContent = num(collection.entries.length);
    document.getElementById('nav-queue').textContent = num(reading.queue.filter(id => ids.has(id)).length);
    document.getElementById('nav-read').textContent = num(reading.read.filter(id => ids.has(id)).length);
    document.getElementById('nav-other').textContent = num(collection.excluded.length);
    document.querySelectorAll('[data-nav]').forEach(a => {
      if (a.dataset.nav === view && !currentEntry) a.setAttribute('aria-current','page');
      else a.removeAttribute('aria-current');
    });
  }

  function parseRoute() {
    const raw = location.hash.replace(/^#/, '') || '/';
    const [path, query = ''] = raw.split('?');
    const params = new URLSearchParams(query);
    if (path.startsWith('/entry/')) {
      let id;
      try { id = decodeURIComponent(path.slice(7)); } catch { id = ''; }
      return {page:'entry',id,section:params.get('section') || ''};
    }
    const page = path === '/queue' ? 'queue' : path === '/read' ? 'read' : path === '/other' ? 'other' : path === '/about' ? 'about' : 'all';
    return {page,params};
  }

  function readFilters(params) {
    filters = {q:params.get('q') || '',category:params.get('category') || '',tag:params.get('tag') || '',month:params.get('month') || '',score:params.get('score') || '',unread:params.get('unread') === '1',sort:params.get('sort') || 'impact'};
  }

  function filterHash() {
    const params = new URLSearchParams();
    for (const key of ['q','category','tag','month','score']) if (filters[key]) params.set(key, filters[key]);
    if (filters.unread) params.set('unread','1');
    if (filters.sort !== 'impact') params.set('sort',filters.sort);
    const base = view === 'all' ? '#/' : `#/${view}`;
    return base + (params.size ? '?' + params.toString() : '');
  }

  function applyFilters() {
    visibleCount = PAGE_SIZE;
    history.replaceState(null, '', filterHash());
    lastIndexHash = location.hash;
    renderResults();
  }

  function matchEntry(entry) {
    if (view === 'queue' && !reading.queue.includes(entry.id)) return false;
    if (view === 'read' && !reading.read.includes(entry.id)) return false;
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.tag && !entry.tags.includes(filters.tag)) return false;
    if (filters.month && !entry.bookmarks.some(b => String(b.date || '').startsWith(filters.month))) return false;
    if (filters.score === 'high' && entry.score < 8) return false;
    if (filters.score === 'medium' && (entry.score < 5 || entry.score > 7)) return false;
    if (filters.score === 'low' && entry.score >= 5) return false;
    if (filters.unread && reading.read.includes(entry.id)) return false;
    if (filters.q) {
      const terms = filters.q.toLocaleLowerCase().trim().split(/\s+/);
      if (!terms.every(term => entry.searchText.includes(term))) return false;
    }
    return true;
  }

  function selectedEntries() {
    const items = collection.entries.filter(matchEntry);
    const sorts = {
      impact:(a,b) => b.score-a.score || b.date.localeCompare(a.date),
      newest:compareActivity,
      published:(a,b) => b.date.localeCompare(a.date) || b.score-a.score,
      oldest:(a,b) => a.earliestDate.localeCompare(b.earliestDate) || b.score-a.score,
      title:(a,b) => a.title.localeCompare(b.title),
      shortest:(a,b) => a.wordCount-b.wordCount || b.score-a.score,
      mentions:(a,b) => b.mentionCount-a.mentionCount || b.score-a.score,
      queued:(a,b) => reading.queue.indexOf(a.id)-reading.queue.indexOf(b.id),
    };
    return items.sort(sorts[filters.sort] || sorts.impact);
  }

  function uniqueCounts(field) {
    const counts = new Map();
    collection.entries.forEach(e => (Array.isArray(e[field]) ? e[field] : [e[field]]).filter(Boolean).forEach(item => counts.set(item,(counts.get(item)||0)+1)));
    return [...counts.entries()].sort((a,b) => b[1]-a[1] || a[0].localeCompare(b[0]));
  }

  function masthead() {
    const bookmarkCount = collection.entries.reduce((n,e) => n+e.bookmarks.length,0);
    const coverage = collection.metadata.coverageNote || 'A coverage statement has not yet been recorded.';
    const last = reading.lastOpened && collection.entries.find(e => e.id === reading.lastOpened);
    return `<section class="masthead"><div class="masthead-inner"><div class="masthead-top"><h1>Second<span class="look">Look.</span></h1><div class="masthead-description"><p>Your saved posts, explored.<br>Ideas to understand, tools to put to work.</p><span class="scope">Posts published since ${esc(formatDate(collection.metadata.cutoff || '2026-03-01'))}.</span></div></div><div class="collection-strip"><span><strong>${num(collection.entries.length)}</strong> research reports</span><span><strong>${num(bookmarkCount)}</strong> source bookmarks</span><span><strong>${num(collection.excluded.length)}</strong> brief mentions</span>${last ? `<a class="coverage-link" href="${entryURL(last.id)}">Continue reading ${icon('arrow')}</a>` : '<a class="coverage-link" href="#/about">Collection coverage &amp; method</a>'}</div><details class="index-coverage"><summary>${collection.metadata.complete === false ? 'Collection in progress' : 'Collection coverage'}<span>What was included</span></summary><p>${esc(coverage)} <a href="#/about">Read the methodology</a>.</p></details></div></section>`;
  }

  function renderIndex() {
    const categories = uniqueCounts('category');
    const months = [...new Set(collection.entries.flatMap(e => e.bookmarks.map(b => String(b.date || '').slice(0,7))).filter(s => /^\d{4}-\d{2}$/.test(s)))].sort().reverse();
    const heading = view === 'queue' ? 'Your reading queue' : view === 'read' ? 'Already read' : '';
    const intro = view === 'queue' ? 'A short list for the ideas you want to return to. Add or remove a report with its bookmark button.' : 'Reports you have marked as read. Revisit the research or return one to your unread collection.';
    main.innerHTML = `${heading ? `<section class="compact-heading"><div class="compact-heading-inner"><h1>${heading}</h1><p>${intro}</p></div></section>` : masthead()}
      <div class="workspace"><div class="search-line"><label class="search-box" for="search">${icon('search')}<span class="sr-only">Search titles, reports, tags and authors</span><input id="search" type="search" value="${esc(filters.q)}" placeholder="Find an idea, tool, or author…" autocomplete="off"><kbd class="shortcut" aria-hidden="true">/</kbd></label><button class="filter-toggle" type="button" aria-controls="filters" aria-expanded="false">${icon('filter')} Filters</button></div>
      <div class="index-layout"><aside class="filters" id="filters" aria-label="Filter reports"><div class="filters-inner"><div class="filter-heading"><h2>Refine the collection</h2><button type="button" class="text-button" data-reset>Reset</button></div>
      <div class="filter-group categories"><span class="sr-only" id="category-label">Category</span><div class="category-list" role="group" aria-labelledby="category-label"><button class="category-button" data-category="" aria-pressed="${!filters.category}"><span>All subjects</span><span>${num(collection.entries.length)}</span></button>${categories.map(([name,count]) => `<button class="category-button" data-category="${esc(name)}" aria-pressed="${filters.category === name}"><span>${esc(name)}</span><span>${num(count)}</span></button>`).join('')}</div></div>
      <div class="filter-group"><label for="impact-filter">Impact score</label><select id="impact-filter"><option value="">All scores</option><option value="high" ${filters.score==='high'?'selected':''}>8–10 · High impact</option><option value="medium" ${filters.score==='medium'?'selected':''}>5–7 · Worth exploring</option><option value="low" ${filters.score==='low'?'selected':''}>1–4 · Narrower relevance</option></select></div>
      <div class="filter-group"><label for="date-filter">Post published</label><select id="date-filter"><option value="">Any month</option>${months.map(m => `<option value="${m}" ${filters.month===m?'selected':''}>${monthLabel(m)}</option>`).join('')}</select></div>
      <div class="filter-group"><label class="check-label"><input type="checkbox" id="unread-filter" ${filters.unread?'checked':''}> Only unread reports</label></div><div class="filter-note">Scores reflect potential influence on AI development, with a bonus for repeated bookmarks.<br><a href="#/about">How the scores work</a></div></div></aside>
      <section class="results" aria-label="Research reports"><div class="results-toolbar"><h2 id="results-title">The collection</h2><label class="sort-control" for="sort">Sort by <select id="sort"><option value="impact">Highest impact</option><option value="newest">Recently added or updated</option><option value="published">Newest post</option><option value="oldest">Oldest post</option><option value="title">Title A–Z</option><option value="shortest">Shortest read</option><option value="mentions">Most mentions</option>${view==='queue'?'<option value="queued">Queue order</option>':''}</select></label></div><div id="active-filters"></div><div id="popular-tags"></div><div id="report-list"></div><div id="pagination"></div><p class="sr-only" role="status" id="result-announcement"></p></section></div></div>`;
    document.getElementById('sort').value = filters.sort;
    document.getElementById('search').addEventListener('input', e => {
      filters.q = e.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(applyFilters,130);
    });
    document.getElementById('impact-filter').addEventListener('change', e => { filters.score=e.target.value; applyFilters(); });
    document.getElementById('date-filter').addEventListener('change', e => { filters.month=e.target.value; applyFilters(); });
    document.getElementById('unread-filter').addEventListener('change', e => { filters.unread=e.target.checked; applyFilters(); });
    document.getElementById('sort').addEventListener('change', e => { filters.sort=e.target.value; applyFilters(); });
    main.querySelector('.filter-toggle').addEventListener('click', e => {
      const button = e.currentTarget;
      const open = button.getAttribute('aria-expanded') !== 'true';
      button.setAttribute('aria-expanded',String(open));
      document.getElementById('filters').classList.toggle('is-open',open);
    });
    renderResults();
  }

  function renderResults() {
    const entries = selectedEntries();
    const title = view === 'queue' ? 'Queued to read' : view === 'read' ? 'Read reports' : 'The collection';
    document.getElementById('results-title').innerHTML = `${title} <span>${num(entries.length)} ${entries.length===1?'report':'reports'}</span>`;
    document.getElementById('result-announcement').textContent = `${num(entries.length)} ${entries.length === 1 ? "report matches" : "reports match"} your filters.`;
    document.querySelectorAll('[data-category]').forEach(b => b.setAttribute('aria-pressed',String(b.dataset.category === filters.category)));
    const tags = uniqueCounts('tags').slice(0,8);
    document.getElementById('popular-tags').innerHTML = tags.length && !filters.q ? `<div class="tag-row"><span class="tag-hint">Explore</span>${tags.map(([tag]) => `<button class="tag-button" data-tag="${esc(tag)}" aria-pressed="${filters.tag === tag}">${esc(tag)}</button>`).join('')}</div>` : '';
    const active = [];
    for (const key of ['q','category','tag','month','score','unread']) {
      if (!filters[key]) continue;
      const label = key==='score' ? {high:'Score 8–10',medium:'Score 5–7',low:'Score 1–4'}[filters[key]] : key==='month' ? monthLabel(filters[key]) : key==='unread' ? 'Unread only' : key==='q' ? `Search: ${filters.q}` : filters[key];
      active.push(`<button type="button" class="active-filter" data-clear-filter="${key}" aria-label="Remove filter: ${esc(label)}">${esc(label)} ${icon('close')}</button>`);
    }
    document.getElementById('active-filters').innerHTML = active.length ? `<div class="active-filters">${active.join('')}</div>` : '';
    const list = document.getElementById('report-list');
    if (!entries.length) {
      const hasFilters = !!(filters.q || filters.category || filters.tag || filters.month || filters.score || filters.unread);
      let title = 'No reports match this combination.';
      let message = 'Try a broader search or remove a filter to bring more reports back into view.';
      if (!collection.entries.length) { title='The research is not in this collection yet.'; message='This website is ready for the researched bookmark entries. The collection file currently contains no reports.'; }
      else if (!hasFilters && view==='queue') { title='Give an idea a second look.'; message='Use the bookmark button beside any report to add it to this queue. Your choices stay in this browser.'; }
      else if (!hasFilters && view==='read') { title='Your first finished report goes here.'; message='Open a report and choose “Mark as read” when you have finished. It will remain available in the index.'; }
      list.innerHTML = `<div class="empty-state"><h2>${title}</h2><p>${message}</p>${hasFilters?'<button class="button secondary" type="button" data-reset>Clear filters</button>':view!=='all'?'<a class="button secondary" href="#/">Browse the collection</a>':'<a class="button secondary" href="#/about">View collection details</a>'}</div>`;
    } else list.innerHTML = entries.slice(0,visibleCount).map(entryRow).join('');
    document.getElementById('pagination').innerHTML = entries.length>visibleCount ? `<div class="show-more"><button class="button secondary" type="button" data-more>Show ${Math.min(PAGE_SIZE,entries.length-visibleCount)} more reports <span>(${num(entries.length-visibleCount)} remaining)</span></button></div>` : '';
  }

  function entryRow(entry) {
    const read = reading.read.includes(entry.id);
    const queued = reading.queue.includes(entry.id);
    const position = reading.positions[entry.id];
    return `<article class="report-row"><div class="row-score" aria-label="Impact score ${entry.score} out of 10"><div class="score-number">${entry.score}<span>/10</span></div><div class="score-caption">impact</div></div><div><h3 class="report-title" style="view-transition-name:title-${entry.transitionId}"><a href="${entryURL(entry.id)}">${esc(entry.title)}</a></h3><p class="row-summary">${esc(entry.summary)}</p><div class="row-meta"><span class="category">${esc(entry.category)}</span><time datetime="${esc(entry.date)}">${esc(reportDate(entry))}</time><span>${readingTime(entry)} min read</span>${entry.mentionCount>1?`<span class="duplicate-label">${entry.mentionCount} mentions</span>`:''}${read?`<span class="read-label">${icon('check')} Read</span>`:position?.progress>.04?'<span>Started</span>':''}${activityLabel(entry)?`<span class="activity-label">${esc(activityLabel(entry))}</span>`:''}</div></div><button type="button" class="icon-button queue-action" data-queue="${esc(entry.id)}" aria-pressed="${queued}" aria-label="${queued?'Remove from':'Add to'} reading queue: ${esc(entry.title)}" title="${queued?'Remove from':'Add to'} reading queue">${icon('bookmark')}</button></article>`;
  }

  function sanitiseArticle(html) {
    const template = document.createElement('template');
    template.innerHTML = String(html || '');
    const banned = 'script,style,iframe,object,embed,form,input,button,textarea,select,link,meta,base';
    template.content.querySelectorAll(banned).forEach(n => n.remove());
    for (const el of template.content.querySelectorAll('*')) {
      for (const attr of [...el.attributes]) {
        if (attr.name.startsWith('on') || !['id','class','href','src','alt','title','colspan','rowspan','open','width','height','aria-label'].includes(attr.name)) el.removeAttribute(attr.name);
      }
      if (el.hasAttribute('href')) {
        const href = safeURL(el.getAttribute('href'));
        if (href) { el.setAttribute('href',href); if (!href.startsWith('#')) { el.target='_blank'; el.rel='noopener noreferrer'; } }
        else el.removeAttribute('href');
      }
      if (el.hasAttribute('src')) {
        const src=safeURL(el.getAttribute('src'),true);
        if (src) { el.setAttribute('src',src); el.setAttribute('loading','lazy'); el.setAttribute('decoding','async'); }
        else el.removeAttribute('src');
      }
    }
    return template.content;
  }

  function renderArticle(entry, section='') {
    currentEntry = entry;
    reading.lastOpened = entry.id;
    persist();
    const queued = reading.queue.includes(entry.id);
    const read = reading.read.includes(entry.id);
    const position = reading.positions[entry.id];
    const bonus = Math.max(0, entry.mentionCount-1);
    const capped = entry.baseScore+bonus>10;
    const next = collection.entries.filter(e => e.id!==entry.id && !reading.read.includes(e.id)).sort((a,b) => (b.category===entry.category)-(a.category===entry.category) || b.score-a.score)[0];
    main.innerHTML = `<div class="article-progress" aria-hidden="true"></div><div class="reader-layout"><aside class="reader-margin" aria-label="Report context"><a class="back-link" href="${esc(lastIndexHash)}">${icon('back')} Back to collection</a><section class="reader-score" aria-label="Impact rating"><div class="score-number">${entry.score}<span>/10</span></div><h2>Impact score</h2><p>${bonus?`Base ${entry.baseScore} + ${bonus} repeat ${bonus===1?'bonus':'bonuses'}${capped?'; capped at 10':''}. `:''}${entry.mentionCount>1?`${entry.mentionCount} bookmarked mentions.`:'One bookmarked mention.'}</p></section><dl class="reader-facts"><dt>${entry.mentionCount>1?'Post dates':'Published'}</dt><dd>${esc(reportDate(entry))}</dd><dt>Length</dt><dd>${num(entry.wordCount)} words</dd><dt>Reading time</dt><dd>${readingTime(entry)} minutes</dd><dt>Research sources</dt><dd>${num(entry.sources.length)}</dd></dl><div class="reader-actions"><button type="button" class="button ${queued?'is-active':'secondary'}" data-queue="${esc(entry.id)}" aria-pressed="${queued}">${icon('bookmark')} ${queued?'In reading queue':'Add to queue'}</button><button type="button" class="button secondary ${read?'is-read':''}" data-read="${esc(entry.id)}" aria-pressed="${read}">${icon('check')} ${read?'Marked as read':'Mark as read'}</button></div><div class="reader-utility"><button type="button" class="text-button" data-print>${icon('print')} Print</button><button type="button" class="text-button" data-copy>${icon('link')} Copy link</button></div></aside>
      <article class="article-sheet" aria-labelledby="article-title">${position?.progress>.06 && !read && !section?'<div class="return-note"><span>You started this report earlier.</span><button type="button" class="text-button" data-resume>Resume reading</button></div>':''}<header class="article-heading"><h1 id="article-title" style="view-transition-name:title-${entry.transitionId}">${esc(entry.title)}</h1><p class="article-summary">${esc(entry.summary)}</p><div class="article-meta"><span>${esc(entry.category)}</span><time datetime="${esc(entry.date)}">${esc(reportDate(entry))}</time><span>${num(entry.wordCount)} words · ${readingTime(entry)} min</span>${activityLabel(entry)?`<span class="activity-label">${esc(activityLabel(entry))}</span>`:''}<a href="#/entry/${encodeURIComponent(entry.id)}?section=original-bookmarks">${entry.bookmarks.length===1?'View original bookmark':`${entry.bookmarks.length} original bookmarks`}</a></div></header><details class="mobile-toc"><summary>On this page</summary><nav aria-label="Report sections" id="mobile-toc-links"></nav></details><div class="article-body" id="article-body"></div><div class="image-gallery" id="image-gallery"></div><section class="provenance" id="research-sources"><h2>Research sources</h2>${entry.sources.length?`<ol class="source-list">${entry.sources.map(source => {const url=safeURL(source.url); return `<li>${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(source.title || source.url)}</a><span class="source-host">${esc(hostname(url))}</span>`:esc(source.title || 'Source link not recorded')}</li>`;}).join('')}</ol>`:'<p class="row-summary">No research sources were included in this entry.</p>'}</section><section class="provenance" id="original-bookmarks"><h2>${entry.bookmarks.length===1?'The original bookmark':'The original bookmarks'}</h2><p class="embed-explainer">Live posts load from X as you reach them. Saved summaries and original links remain available below each post.</p>${entry.bookmarks.map(bookmarkRecord).join('') || '<p class="row-summary">Original post metadata is not available for this entry.</p>'}</section><div class="article-bottom"><p>${read?'This report is in your read collection.':'Finished? Keep track of what you have explored.'}</p><button type="button" class="button secondary ${read?'is-read':''}" data-read="${esc(entry.id)}" aria-pressed="${read}">${icon('check')} ${read?'Mark as unread':'Mark as read'}</button></div>${next?`<div class="next-reading"><p>Another report to explore</p><a href="${entryURL(next.id)}">${esc(next.title)}</a></div>`:''}<p class="print-source">Second Look · ${esc(collection.metadata.retrievedAt ? `Research collected ${formatDate(collection.metadata.retrievedAt)} · ` : '')}${esc(entryURL(entry.id))}</p></article><aside class="toc" aria-label="On this page"><h2>On this page</h2><nav class="toc-links" id="toc-links"></nav><a href="${entryURL(entry.id)}?section=research-sources">Research sources</a><a href="${entryURL(entry.id)}?section=original-bookmarks">Original bookmarks</a><a href="${entryURL(entry.id)}?section=article-title">Back to top</a></aside></div>`;
    const body = document.getElementById('article-body');
    body.appendChild(sanitiseArticle(entry.html));
    if (!body.textContent.trim()) body.innerHTML='<p>This entry does not yet contain a report. Its original bookmarks and research sources are listed below.</p>';
    const used = new Set(['article-title','research-sources','original-bookmarks']);
    const headings = [...body.querySelectorAll('h2,h3')];
    headings.forEach((heading,index) => {
      let id = heading.id || `section-${index+1}`;
      id = id.replace(/[^a-zA-Z0-9_-]/g,'-') || `section-${index+1}`;
      while (used.has(id)) id += '-section';
      used.add(id); heading.id=id;
    });
    const tocLinks = headings.map(h => `<a class="${h.tagName==='H3'?'subheading':''}" href="${entryURL(entry.id)}?section=${encodeURIComponent(h.id)}" data-section="${esc(h.id)}">${esc(h.textContent)}</a>`).join('');
    document.getElementById('toc-links').innerHTML=tocLinks;
    document.getElementById('mobile-toc-links').innerHTML=tocLinks + `<a href="${entryURL(entry.id)}?section=research-sources">Research sources</a><a href="${entryURL(entry.id)}?section=original-bookmarks">Original bookmarks</a>`;
    body.querySelectorAll('a[href^="#"]').forEach(a => {
      const fragment=a.getAttribute('href');
      if (!fragment.startsWith('#/')) a.href=`${entryURL(entry.id)}?section=${encodeURIComponent(fragment.slice(1))}`;
    });
    const existingImages = new Set([...body.querySelectorAll('img')].map(i => i.getAttribute('src')));
    const figures=entry.images.filter(i => !existingImages.has(i.src)).slice(0,Math.max(0,3-existingImages.size)).map(image => {
      const src=safeURL(image.src,true); const origin=safeURL(image.sourceUrl);
      const dimensions=Number.isFinite(image.width) && image.width>0 && Number.isFinite(image.height) && image.height>0 ? ` width="${Math.round(image.width)}" height="${Math.round(image.height)}"` : '';
      return src?`<figure><img src="${esc(src)}" alt="${esc(image.alt || '')}"${dimensions} loading="lazy" decoding="async"><figcaption>${esc(image.caption || image.alt || '')}${origin?` <a href="${esc(origin)}" target="_blank" rel="noopener noreferrer">Image source</a>`:''}</figcaption></figure>`:'';
    });
    // Put the first source illustration beside the opening exploration.
    const openingSection = body.querySelector(':scope > section');
    const nextHeading = body.querySelectorAll(':scope > h2')[1];
    if (figures.length && (openingSection || nextHeading)) {
      const illustration = document.createElement('div');
      illustration.className = 'image-gallery opening-illustration';
      illustration.innerHTML = figures.shift();
      if (openingSection) openingSection.after(illustration);
      else nextHeading.before(illustration);
    }
    document.getElementById('image-gallery').innerHTML=figures.join('');
    if (entry.researchNote) {
      const scope = document.createElement('details');
      scope.className = 'research-scope';
      scope.innerHTML = `<summary>Research scope and verification limits</summary><p>${esc(entry.researchNote)}</p>`;
      document.getElementById('research-sources').insertBefore(scope, document.querySelector('#research-sources .source-list'));
    }
    main.querySelectorAll('img').forEach(img => img.addEventListener('error', () => {
      const note=document.createElement('p');note.className='image-failed';note.textContent=`Image unavailable${img.alt ? ': '+img.alt : '.'}`;img.replaceWith(note);
    }, {once:true}));
    if ('IntersectionObserver' in window) {
      observer=new IntersectionObserver(changes => {
        const visible=changes.filter(c => c.isIntersecting).sort((a,b) => a.boundingClientRect.top-b.boundingClientRect.top);
        if (visible.length) {
          document.querySelectorAll('[data-section]').forEach(a => {
            if (a.dataset.section===visible[0].target.id) a.setAttribute('aria-current','location'); else a.removeAttribute('aria-current');
          });
        }
      },{rootMargin:'-100px 0px -65% 0px'});
      headings.forEach(h => observer.observe(h));
    }
    embedSession = createEmbedSession(document.getElementById('original-bookmarks'));
    if (section) requestAnimationFrame(() => scrollToSection(section));
    document.title=`${entry.title} — Second Look`;
  }

  function hostname(url) { try { return new URL(url,location.href).hostname.replace(/^www\./,''); } catch { return ''; } }

  function xPostId(bookmark) {
    try {
      const url = new URL(bookmark.url);
      if (!['x.com','www.x.com','mobile.x.com','twitter.com','www.twitter.com','mobile.twitter.com'].includes(url.hostname)) return '';
      return url.pathname.match(/\/status\/(\d{1,20})(?:\/|$)/)?.[1] || '';
    } catch { return ''; }
  }

  function bookmarkRecord(bookmark) {
    const url=safeURL(bookmark.url);
    const id=xPostId(bookmark);
    return `<div class="bookmark-record"><div class="bookmark-header">${url?`<a href="${esc(url)}" target="_blank" rel="noopener noreferrer">${esc(bookmark.author || 'Open post on X')} ${icon('external')}</a>`:`<span>${esc(bookmark.author || 'Author not recorded')}</span>`}<time datetime="${esc(bookmark.date || '')}">${esc(formatDate(bookmark.date))}</time></div>${id?`<div class="x-post" data-x-post="${id}" data-state="pending"><div class="x-post-feedback"><p class="x-post-status" role="status">X post preview</p><button type="button" class="text-button" data-load-x-post>Load X post</button></div></div>`:''}${bookmark.text?`<details class="saved-post-summary"><summary>Read saved-post summary</summary><p>${esc(bookmark.text)}</p></details>`:'<p>A post summary was not available during collection.</p>'}</div>`;
  }

  function loadXWidgets() {
    if (window.twttr?.widgets?.createTweet) return Promise.resolve(window.twttr.widgets);
    if (xWidgetsPromise) return xWidgetsPromise;
    xWidgetsPromise = new Promise((resolve,reject) => {
      const script = document.createElement('script');
      let settled = false;
      let timer;
      const finish = error => {
        if (settled) return;
        if (!error && !window.twttr?.widgets?.createTweet) return;
        settled = true;
        clearTimeout(timer);
        script.onload = script.onerror = null;
        if (error) {
          script.remove();
          xWidgetsPromise = null;
          reject(error);
        } else resolve(window.twttr.widgets);
      };
      // X's official ready queue lets the widget API finish initialising after script load.
      if (!window.twttr) window.twttr = {_e:[],ready(callback){this._e.push(callback);}};
      if (typeof window.twttr.ready === 'function') window.twttr.ready(() => finish());
      script.id = 'second-look-x-widgets';
      script.src = 'https://platform.twitter.com/widgets.js';
      script.async = true;
      script.charset = 'utf-8';
      script.onload = () => finish();
      script.onerror = () => finish(new Error('X could not be reached.'));
      timer = setTimeout(() => finish(new Error('X took too long to respond.')),15000);
      document.head.appendChild(script);
    });
    return xWidgetsPromise;
  }

  function createEmbedSession(container) {
    let active = true;
    let running = 0;
    let intersection = null;
    const queue = [];
    const cards = [...container.querySelectorAll('.x-post')];
    const belongs = card => active && card?.isConnected && container.contains(card);
    const feedback = (card,state,message) => {
      card.dataset.state = state;
      card.setAttribute('aria-busy',String(state==='loading' || state==='queued'));
      const status = card.querySelector('.x-post-status');
      const button = card.querySelector('[data-load-x-post]');
      status.textContent = message;
      status.hidden = state==='loaded';
      button.hidden = state==='loaded' || state==='loading' || state==='queued';
      button.textContent = state==='failed'?'Retry X post':'Load X post';
      if (state==='failed') {
        const summary = card.closest('.bookmark-record')?.querySelector('.saved-post-summary');
        if (summary) summary.open = true;
      }
    };
    const render = async card => {
      running++;
      feedback(card,'loading','Loading the original post from X…');
      // Each attempt gets a fresh mount. Late responses cannot reinsert a failed or stale embed.
      const mount = document.createElement('div');
      mount.className = 'x-post-mount';
      card.prepend(mount);
      let timer;
      try {
        if (navigator.onLine === false) throw new Error('Offline');
        const widgets = await loadXWidgets();
        if (!belongs(card)) return;
        const rendered = await Promise.race([
          widgets.createTweet(card.dataset.xPost,mount,{dnt:true,conversation:'none',theme:'light',lang:'en',align:'left',width:550}),
          new Promise((_,reject) => {timer=setTimeout(() => reject(new Error('Embed timed out')),20000);}),
        ]);
        if (!belongs(card)) return;
        if (!rendered) throw new Error('Post unavailable');
        feedback(card,'loaded','');
      } catch {
        mount.remove();
        if (belongs(card)) feedback(card,'failed','The live post could not load. Read the saved summary or open the original link.');
      } finally {
        clearTimeout(timer);
        if (!belongs(card)) mount.remove();
        running--;
        pump();
      }
    };
    const pump = () => {
      while (active && running<2 && queue.length) {
        const card = queue.shift();
        if (belongs(card)) void render(card);
      }
    };
    const enqueue = card => {
      if (!belongs(card) || !['pending','failed'].includes(card.dataset.state)) return;
      intersection?.unobserve(card);
      feedback(card,'queued','Waiting to load the original post…');
      queue.push(card);
      pump();
    };
    if ('IntersectionObserver' in window) {
      intersection = new IntersectionObserver(changes => {
        changes.filter(change => change.isIntersecting).forEach(change => enqueue(change.target));
      },{rootMargin:'180px 0px',threshold:0});
      cards.forEach(card => intersection.observe(card));
    }
    return {enqueue,dispose(){active=false;queue.length=0;intersection?.disconnect();}};
  }

  function scrollToSection(section) {
    const el=document.getElementById(section);
    if (el) {
      el.scrollIntoView({behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth',block:'start'});
      el.setAttribute('tabindex','-1');el.focus({preventScroll:true});
    }
  }

  function renderOther() {
    const sorted=[...collection.excluded].sort((a,b) => String(b.date||'').localeCompare(String(a.date||'')));
    main.innerHTML=`<section class="compact-heading"><div class="compact-heading-inner"><h1>Other bookmarks</h1><p>${num(sorted.length)} saved ${sorted.length===1?'post':'posts'} outside the AI and technology scope. Preserved here as brief mentions.</p></div></section><div class="workspace"><div class="other-list">${sorted.length?sorted.map(e => `<article class="other-row"><time datetime="${esc(e.date || '')}">${esc(formatDate(e.date))}</time><div><h2>${esc(e.summary || e.title || 'Saved post')}</h2>${e.reason?`<p class="other-reason">${esc(e.reason)}</p>`:''}${safeURL(e.url)?`<p><a href="${esc(safeURL(e.url))}" target="_blank" rel="noopener noreferrer">${esc(e.author || 'View original post')} on X</a></p>`:''}</div></article>`).join(''):'<div class="empty-state"><h2>No out-of-scope posts are listed.</h2><p>The collection currently contains no brief mentions outside AI and technology.</p><a class="button secondary" href="#/">Back to the research</a></div>'}</div></div>`;
  }

  function renderAbout() {
    const meta=collection.metadata;
    const words=collection.entries.reduce((n,e) => n+e.wordCount,0);
    main.innerHTML=`<article class="about-page"><h1>About this collection.</h1><p>Second Look turns your saved X posts into a research library you can return to. Each report explores the original idea, checks the technology behind it, and works through ways to use it in educational content, apps, websites or videos.</p><div class="coverage-note"><p>${esc(meta.coverageNote || 'The collection file does not include a coverage statement. The number of reports alone should not be taken as proof that all bookmarks were retrieved.')}</p></div><p>This edition contains <strong>${num(collection.entries.length)} reports</strong>, ${num(words)} words of research, and ${num(collection.excluded.length)} brief mentions. The publication cutoff is <strong>${esc(formatDate(meta.cutoff || '2026-03-01'))}</strong>.${meta.retrievedAt?` The collection was retrieved on ${esc(formatDate(meta.retrievedAt))}.`:''}</p><h2>What the score means</h2><p>The rating estimates the idea's potential influence on AI-centered development. It weighs usefulness, capability, maturity, evidence and the scope of what it could enable. Practical examples focus on your interests, while the score considers the wider field.</p><p>Repeated bookmarks about the same subject share one report. Each additional distinct saved post about that subject adds one point to the base rating, up to a maximum of 10. Separate tools are not merged merely because they share a category. The report's context margin shows the base score and any bonus.</p><table class="method-table"><thead><tr><th scope="col">Adjusted score</th><th scope="col">Report length</th><th scope="col">Editorial treatment</th></tr></thead><tbody><tr><td>1–4</td><td>900–1,100 words</td><td>Narrower relevance</td></tr><tr><td>5–7</td><td>1,800–2,200 words</td><td>Worth exploring</td></tr><tr><td>8–10</td><td>2,700–3,300 words</td><td>High impact</td></tr></tbody></table><h2>From post to research</h2><p>The original bookmark is the starting point. Reports distinguish vendor claims from findings supported by primary research, give background where needed, and close with an editorial judgment. Suggested projects and workflows are proposals rather than tests performed during this research unless a report explicitly says otherwise. A tool's availability or capability may have changed since the post was published; follow the linked documentation for the current details.</p><p>Original post links, saved-post summaries and research sources appear at the end of every report. The saved-post text is a paraphrase, not a verbatim transcript. Research illustrations are limited to three per subject and include source information where available. Live X posts are displayed separately, with saved summaries available if an embed cannot load. Publication dates refer to when posts were published. “Recently added or updated” sorts by when a new bookmark was first detected; the initial collection uses publication dates because its save dates were not available. A new distinct bookmark for an existing subject brings that report back to the top without changing its read status or saved position.</p><h2>Make it useful again</h2><ul><li>Search the complete report text, titles, authors and tags. Multiple search words must all match.</li><li>Filter by subject, publication month or impact. A month matches any original post in a consolidated report. Then sort by what you want to read next.</li><li>Add reports to the reading queue with the bookmark button. Mark a report as read when you finish.</li><li>Return to a started report and choose “Resume reading” to continue near your last position.</li><li>Press <strong>/</strong> to focus search on the index. Use Tab to move through all controls.</li><li>Print an individual report for a clean copy with its source list.</li></ul><h2>Your reading state stays here</h2><p>The queue, read status and reading positions are saved in this browser's local storage. They are not sent to a server. They may disappear if browser data is cleared or if you switch browser or website address. The localhost reader and this GitHub Pages site have separate storage. To bring existing progress here, use Export reading state on the local reader, then Import reading state on this site. Export a copy below to keep or transfer your state.</p><p>The export contains report identifiers and reading state, not the report text. Importing merges queues and read lists with your existing state.</p><div style="display:flex;gap:14px;flex-wrap:wrap"><button class="button" type="button" data-export>Export reading state</button><a class="button secondary" href="data.json" download="second-look-collection.json">Download collection data</a></div></article>`;
  }

  function renderMissing(id) {
    main.innerHTML=`<div class="load-state"><h1>This report is not in the collection.</h1><p>The link refers to <code>${esc(id)}</code>. It may have been renamed or removed from this edition.</p><a class="button secondary" href="#/">Browse the index</a></div>`;
  }

  function renderRoute() {
    const route=parseRoute();
    const restoreIndex = ['all','queue','read'].includes(route.page) && navigationIdentity.startsWith('entry:') && (location.hash || '#/') === lastIndexHash;
    if (route.page==='entry' && currentEntry?.id===route.id) {
      if (route.section) scrollToSection(route.section);
      else window.scrollTo({top:0,behavior:'instant'});
      return;
    }
    if (observer) { observer.disconnect(); observer=null; }
    if (embedSession) { embedSession.dispose(); embedSession=null; }
    clearTimeout(scrollTimer);
    currentEntry=null;
    view=route.page;
    visibleCount=restoreIndex ? lastIndexVisibleCount : PAGE_SIZE;
    document.title='Second Look — Your bookmark compendium';
    if (route.page==='entry') {
      const entry=collection.entries.find(e => e.id===route.id);
      if (entry) renderArticle(entry,route.section); else renderMissing(route.id);
    } else if (route.page==='about') renderAbout();
    else if (route.page==='other') renderOther();
    else { readFilters(route.params); lastIndexHash=location.hash || '#/'; renderIndex(); }
    updateNavigation();
    if (!route.section) {
      const restore=restoreIndex && lastIndexY;
      window.scrollTo({top:restore?lastIndexY:0,behavior:'instant'});
    }
    if (hasRendered && !route.section) main.focus({preventScroll:true});
    navigationIdentity=route.page+(route.id?':'+route.id:'');
    hasRendered=true;
  }

  function toggleQueue(id) {
    const queued=reading.queue.includes(id);
    reading.queue=queued?reading.queue.filter(i => i!==id):[...reading.queue,id];
    persist();
    toast(queued?'Removed from your reading queue.':'Added to your reading queue.');
    updateStateControls(id);
    if (!currentEntry && view==='queue') renderResults();
  }

  function toggleRead(id) {
    const read=reading.read.includes(id);
    reading.read=read?reading.read.filter(i => i!==id):[...reading.read,id];
    persist();
    toast(read?'Marked as unread.':'Marked as read.');
    updateStateControls(id);
    if (!currentEntry) renderResults();
  }

  function updateStateControls(id) {
    const entry=collection.entries.find(e => e.id===id);
    if (!entry) return;
    const queued=reading.queue.includes(id), read=reading.read.includes(id);
    document.querySelectorAll('[data-queue]').forEach(b => {
      if (b.dataset.queue!==id) return;
      b.setAttribute('aria-pressed',String(queued));
      if (b.classList.contains('icon-button')) {
        b.setAttribute('aria-label',`${queued?'Remove from':'Add to'} reading queue: ${entry.title}`);
        b.title=`${queued?'Remove from':'Add to'} reading queue`;
      } else {b.classList.toggle('is-active',queued);b.classList.toggle('secondary',!queued);b.innerHTML=icon('bookmark')+(queued?' In reading queue':' Add to queue');}
    });
    document.querySelectorAll('[data-read]').forEach(b => {
      if (b.dataset.read!==id) return;
      b.setAttribute('aria-pressed',String(read));b.classList.toggle('is-read',read);
      b.innerHTML=icon('check')+(read?(b.closest('.article-bottom')?' Mark as unread':' Marked as read'):' Mark as read');
    });
    const end=main.querySelector('.article-bottom p');
    if (end) end.textContent=read?'This report is in your read collection.':'Finished? Keep track of what you have explored.';
  }

  function resetFilters() {
    filters={q:'',category:'',tag:'',month:'',score:'',unread:false,sort:'impact'};
    history.replaceState(null,'',filterHash());
    renderIndex();
  }

  function exportState() {
    const blob=new Blob([JSON.stringify({...reading,exportedAt:new Date().toISOString(),collectionTitle:collection.metadata.title || 'Second Look'},null,2)],{type:'application/json'});
    const url=URL.createObjectURL(blob), link=document.createElement('a');
    link.href=url;link.download=`second-look-reading-${new Date().toISOString().slice(0,10)}.json`;link.click();
    setTimeout(() => URL.revokeObjectURL(url),1000);
    toast('Reading state exported.');
  }

  document.addEventListener('click', async event => {
    if(event.target.closest('.skip-link')) { event.preventDefault(); main.focus(); main.scrollIntoView({block:'start',behavior:'instant'}); return; }
    const button=event.target.closest('button');
    const articleLink=event.target.closest('a[href^="#/entry/"]');
    if (articleLink && !currentEntry) { lastIndexHash=location.hash || '#/'; lastIndexY=scrollY; lastIndexVisibleCount=visibleCount; }
    if (!button) return;
    if (button.hasAttribute('data-queue')) toggleQueue(button.dataset.queue);
    if (button.hasAttribute('data-read')) toggleRead(button.dataset.read);
    if (button.hasAttribute('data-category')) { filters.category=button.dataset.category;applyFilters(); }
    if (button.hasAttribute('data-tag')) { filters.tag=filters.tag===button.dataset.tag?'':button.dataset.tag;applyFilters(); }
    if (button.hasAttribute('data-reset')) resetFilters();
    if (button.hasAttribute('data-clear-filter')) {
      const key=button.dataset.clearFilter;filters[key]=key==='unread'?false:'';
      if(key==='q')document.getElementById('search').value='';
      if(key==='month')document.getElementById('date-filter').value='';
      if(key==='score')document.getElementById('impact-filter').value='';
      if(key==='unread')document.getElementById('unread-filter').checked=false;
      applyFilters();
    }
    if (button.hasAttribute('data-more')) {const count=visibleCount;visibleCount+=PAGE_SIZE;renderResults();const firstNew=document.querySelectorAll('.report-title a')[count];if(firstNew)firstNew.focus({preventScroll:true});}
    if (button.hasAttribute('data-print')) window.print();
    if (button.hasAttribute('data-copy')) {
      try { await navigator.clipboard.writeText(location.href.split('#')[0]+entryURL(currentEntry.id)); toast('Report link copied.'); }
      catch { toast('Could not copy automatically. Copy the address from your browser.'); }
    }
    if (button.hasAttribute('data-resume') && currentEntry) {
      const position=reading.positions[currentEntry.id];
      if(position?.section && document.getElementById(position.section))scrollToSection(position.section);
      else if(position)window.scrollTo({top:position.progress*Math.max(0,document.documentElement.scrollHeight-innerHeight),behavior:matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
      button.closest('.return-note')?.remove();
    }
    if (button.hasAttribute('data-export') || button.id==='export-state') exportState();
    if (button.id==='import-trigger') document.getElementById('import-state').click();
    if (button.hasAttribute('data-retry')) location.reload();
    if (button.hasAttribute('data-load-x-post')) embedSession?.enqueue(button.closest('.x-post'));
  });

  document.getElementById('import-state').addEventListener('change',async event => {
    const file=event.target.files[0];
    if(!file)return;
    try {
      if(file.size>2_000_000)throw new Error('The file is too large to be a reading-state export.');
      const parsed=JSON.parse(await file.text());
      if(parsed.version!==1 || !Array.isArray(parsed.queue) || !Array.isArray(parsed.read))throw new Error('Choose a Second Look reading-state export.');
      const incoming=cleanReadingState(parsed);
      reading.queue=[...new Set([...reading.queue,...incoming.queue])];
      reading.read=[...new Set([...reading.read,...incoming.read])];
      for(const [id,p] of Object.entries(incoming.positions)) if(!reading.positions[id] || p.updatedAt>reading.positions[id].updatedAt)reading.positions[id]=p;
      persist();
      if(currentEntry)updateStateControls(currentEntry.id);else if(['all','queue','read'].includes(view))renderResults();
      toast('Reading state imported and merged with this browser.');
    } catch(error) {toast(`Import failed. ${error.message}`);}
    event.target.value='';
  });

  document.addEventListener('keydown',event => {
    if(event.key==='/' && !event.metaKey && !event.ctrlKey && !event.altKey && !['INPUT','TEXTAREA','SELECT'].includes(event.target.tagName) && !event.target.isContentEditable){
      const search=document.getElementById('search');if(search){event.preventDefault();search.focus();}
    }
  });

  window.addEventListener('scroll',() => {
    if(!currentEntry)return;
    const range=Math.max(1,document.documentElement.scrollHeight-innerHeight);
    const progress=Math.min(1,Math.max(0,scrollY/range));
    const bar=document.querySelector('.article-progress');if(bar)bar.style.width=`${progress*100}%`;
    clearTimeout(scrollTimer);
    scrollTimer=setTimeout(() => {
      if(!currentEntry)return;
      const headings=[...document.querySelectorAll('.article-body h2,.article-body h3')];
      const section=headings.filter(h => h.getBoundingClientRect().top<innerHeight*.45).at(-1)?.id || '';
      if(progress>.02) {reading.positions[currentEntry.id]={progress,section,updatedAt:new Date().toISOString()};persist();}
    },500);
  },{passive:true});

  window.addEventListener('hashchange',() => {
    const route=parseRoute();
    const identity=route.page+(route.id?':'+route.id:'');
    if(document.startViewTransition && !matchMedia('(prefers-reduced-motion: reduce)').matches && identity!==navigationIdentity) document.startViewTransition(renderRoute);
    else renderRoute();
  });

  function normaliseData(data) {
    if(!data || !Array.isArray(data.entries))throw new Error('The collection needs an entries array.');
    const ids=new Set();
    return {metadata:data.metadata || {},excluded:Array.isArray(data.excluded)?data.excluded:[],entries:data.entries.map((e,index) => {
      const id=String(e.id || `report-${index+1}`);
      if(ids.has(id))throw new Error(`Duplicate report identifier: ${id}`);
      ids.add(id);
      const text=textFromHTML(e.html);
      const sources=Array.isArray(e.sources)?e.sources:[],bookmarks=Array.isArray(e.bookmarks)?e.bookmarks:[],tags=Array.isArray(e.tags)?e.tags.map(String):[];
      const score=Math.min(10,Math.max(1,Number(e.score)||1));
      return {...e,id,title:String(e.title || 'Untitled report'),category:String(e.category || 'Technology'),tags,score,baseScore:Math.min(score,Math.max(1,Number(e.baseScore)||score)),mentionCount:Math.max(1,Number(e.mentionCount)||bookmarks.length),date:String(e.date || ''),earliestDate:bookmarks.map(b => String(b.date || '')).filter(Boolean).sort()[0] || String(e.date || ''),summary:String(e.summary || ''),wordCount:Number(e.wordCount)||text.split(/\s+/).filter(Boolean).length,html:String(e.html || ''),sources,bookmarks,images:Array.isArray(e.images)?e.images:[],transitionId:String(index),searchText:[e.title,e.summary,e.category,...tags,text,...bookmarks.map(b => `${b.author || ''} ${b.text || ''}`)].join(' ').toLocaleLowerCase()};
    })};
  }

  async function start() {
    readStoredState();
    try {
      const demo=new URLSearchParams(location.search).get('demo')==='1';
      const response=await fetch(demo?'demo.json':'data.json',{cache:'no-cache'});
      if(!response.ok)throw new Error(`The collection file returned HTTP ${response.status}.`);
      collection=normaliseData(await response.json());
      if(demo){const banner=document.createElement('div');banner.className='demo-banner';banner.textContent='Layout demonstration only. These entries are synthetic fixtures, not your bookmarks.';document.querySelector('.site-header').after(banner);}
      if(!storageAvailable){const notice=document.createElement('div');notice.className='storage-warning';notice.textContent='Browser storage is unavailable. Your reading state will last for this session; export it to keep a copy.';document.querySelector('.site-header').after(notice);}
      renderRoute();
    } catch(error) {
      main.innerHTML=`<div class="load-state"><h1>The collection could not be opened.</h1><p>${esc(location.protocol==='file:'?'Open this website through the included local server. Browsers prevent a directly opened HTML file from loading the collection JSON.':error.message)}</p><p>${location.protocol==='file:'?'Run the project’s local launcher, then use its localhost address.':'Check that data.json is beside index.html and contains the researched entries, then try again.'}</p><button type="button" class="button secondary" data-retry>Try again</button></div>`;
      document.title='Collection unavailable — Second Look';
    }
  }
  start();
})();
