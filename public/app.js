'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const state = { user: null, companies: [], calMonth: new Date(), events: [] };

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !url.startsWith('/api/auth')) { showAuth(); throw new Error('Please log in.'); }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2600);
}
async function busy(btn, fn) {
  const label = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}
const STATUS_TEXT = { valid: 'Valid', likely_valid: 'Likely valid', accept_all: 'Accept-all', risky: 'Risky', invalid: 'Invalid', unknown: 'Unknown' };
const statusBadge = (v) => v ? `<span class="badge ${v.status}" title="Score ${v.score}/99">${STATUS_TEXT[v.status] || v.status} · ${v.grade}</span>` : '<span class="badge unknown">Not verified</span>';
const fmtDate = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// ---------------- auth ----------------
let authMode = 'login';
function showAuth() { $('#app').hidden = true; $('#auth').hidden = false; }
$$('[data-auth]').forEach((b) => b.addEventListener('click', () => {
  authMode = b.dataset.auth;
  $$('[data-auth]').forEach((x) => x.classList.toggle('active', x === b));
  $('#auth').classList.toggle('signup', authMode === 'signup');
  $('#auth-form [name=name]').required = authMode === 'signup';
}));
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  try {
    const { user } = await api('POST', `/api/auth/${authMode}`, Object.fromEntries(new FormData(e.target)));
    state.user = user; start();
  } catch (err) { $('#auth-error').textContent = err.message; }
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/auth/logout').catch(() => {}); location.reload(); });

// ---------------- navigation ----------------
const loaders = { matches: loadMatches, search: loadSearch, finder: () => {}, verify: () => {}, calendar: loadCalendar, pipeline: loadPipeline, profile: loadProfile };
function go(view) {
  $$('#nav .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  history.replaceState(null, '', `#${view}`);
  loaders[view]?.();
}
$$('#nav .tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) go(g.dataset.goto); });

async function start() {
  $('#auth').hidden = true; $('#app').hidden = false;
  state.companies = await api('GET', '/api/companies');
  const coOpts = state.companies.map((c) => `<option value="${c.id}">${esc(c.name)}</option>`).join('');
  $('#search-form [name=company]').insertAdjacentHTML('beforeend', coOpts);
  $('#finder-form [name=companyId]').insertAdjacentHTML('beforeend', coOpts);
  const industries = [...new Set(state.companies.map((c) => c.industry).filter(Boolean))].sort();
  $('#search-form [name=industry]').insertAdjacentHTML('beforeend', industries.map((i) => `<option>${esc(i)}</option>`).join(''));
  const initial = location.hash.slice(1);
  go(loaders[initial] ? initial : state.user.profile ? 'matches' : 'profile');
}

// ---------------- contact cards ----------------
function contactCard(c, { compact = false } = {}) {
  const m = c.match || { score: 0, reasons: [] };
  return `<article class="card" data-contact="${c.id}">
    <div class="top">
      <div><div class="name">${esc(c.name)}</div><div class="role">${esc(c.title || '')}${c.department ? ' · ' + esc(c.department) : ''}<br>${esc(c.company)}</div></div>
      <div class="score" style="--p:${m.score}" title="Match score"><span>${m.score}</span></div>
    </div>
    ${compact ? '' : `<div class="email">${esc(c.email || 'No email on file')}</div>
    <div>${statusBadge(c.verification)}</div>
    ${m.reasons.length ? `<ul class="reasons">${m.reasons.map((r) => `<li>${esc(r.text)}</li>`).join('')}</ul>` : ''}`}
  </article>`;
}
document.addEventListener('click', (e) => {
  const card = e.target.closest('[data-contact]');
  if (card) openContact(card.dataset.contact);
});

async function openContact(id) {
  const c = await api('GET', `/api/contacts/${id}`);
  const shared = new Set(c.match.sharedInterests);
  $('#drawer-body').innerHTML = `
    <h2>${esc(c.name)}</h2>
    <p class="muted">${esc(c.title || '')} · ${esc(c.department || '')}<br><strong>${esc(c.company)}</strong> · ${esc(c.industry || '')}</p>
    <div class="report-head"><div class="score" style="--p:${c.match.score}"><span>${c.match.score}</span></div>
      <div>${c.match.reasons.map((r) => `<div>• ${esc(r.text)}</div>`).join('') || '<span class="muted">Upload your resume to see what you have in common.</span>'}</div></div>
    <h3>Details</h3>
    <dl class="kv">
      <dt>Email</dt><dd><code>${esc(c.email || '—')}</code> ${statusBadge(c.verification)}</dd>
      <dt>Location</dt><dd>${esc(c.location || '—')}</dd>
      <dt>School</dt><dd>${esc(c.school || '—')}</dd>
      <dt>Interests</dt><dd class="chips">${c.interests.map((i) => `<span class="chip ${[...shared].some((s) => i.includes(s)) ? 'hl' : ''}">${esc(i)}</span>`).join('')}</dd>
      <dt>Firm format</dt><dd>${c.emailPattern.dominant ? `${esc(c.emailPattern.dominant)}@${esc(c.domain)} <span class="muted">(${Math.round(c.emailPattern.confidence * 100)}% of ${c.emailPattern.sample} known)</span>` : '—'}</dd>
      ${c.linkedin ? `<dt>LinkedIn</dt><dd><a href="${esc(c.linkedin)}" target="_blank" rel="noopener">Profile</a></dd>` : ''}
    </dl>
    ${c.bio ? `<p>${esc(c.bio)}</p>` : ''}
    <div class="actions">
      ${c.email ? '<button class="btn primary" id="d-verify">Verify email</button>' : `<button class="btn primary" id="d-find">Find email</button>`}
      <button class="btn" id="d-intro">Draft intro email</button>
      <select id="d-status" style="width:auto">${['', 'saved', 'emailed', 'replied', 'meeting', 'closed'].map((s) => `<option value="${s}" ${c.saved?.status === s ? 'selected' : ''}>${s ? 'Status: ' + s : 'Add to outreach…'}</option>`).join('')}</select>
    </div>
    <div id="d-verify-out">${c.verification ? renderReport(c.verification) : ''}</div>
    <div id="d-intro-out"></div>
    <h3>Schedule a coffee chat</h3>
    <form id="d-schedule" class="filters">
      <input type="datetime-local" name="startsAt" required>
      <input type="number" name="durationMin" value="30" min="5" max="240" title="Minutes">
      <input name="location" placeholder="Zoom link / place">
      <button class="btn primary">Add to calendar</button>
    </form>
    <div id="d-schedule-out"></div>`;
  $('#drawer').hidden = false;

  $('#d-verify')?.addEventListener('click', (e) => busy(e.target, async () => {
    const v = await api('POST', `/api/contacts/${id}/verify`);
    $('#d-verify-out').innerHTML = renderReport(v);
  }));
  $('#d-find')?.addEventListener('click', () => {
    $('#drawer').hidden = true; go('finder');
    const f = $('#finder-form'); f.firstName.value = c.firstName; f.lastName.value = c.lastName; f.companyId.value = c.companyId;
  });
  $('#d-intro').addEventListener('click', async () => {
    const d = await api('GET', `/api/contacts/${id}/intro`);
    const mailto = `mailto:${encodeURIComponent(c.email || '')}?subject=${encodeURIComponent(d.subject)}&body=${encodeURIComponent(d.body)}`;
    $('#d-intro-out').innerHTML = `<h3>Draft</h3><p><strong>Subject:</strong> ${esc(d.subject)}</p><pre>${esc(d.body)}</pre>
      <div class="actions"><a class="btn primary" href="${mailto}">Open in email app</a><button class="btn" id="d-copy">Copy</button></div>`;
    $('#d-copy').onclick = () => navigator.clipboard.writeText(d.body).then(() => toast('Copied'));
  });
  $('#d-status').addEventListener('change', async (e) => {
    if (!e.target.value) { await api('DELETE', `/api/saved/${id}`); return toast('Removed from outreach'); }
    const r = await api('PUT', `/api/saved/${id}`, { status: e.target.value });
    toast(r.followUp ? `Saved. Follow-up reminder set for ${fmtDate(r.followUp.startsAt)}` : 'Saved');
  });
  $('#d-schedule').addEventListener('submit', (e) => {
    e.preventDefault();
    busy(e.submitter, async () => {
      const f = Object.fromEntries(new FormData(e.target));
      const r = await api('POST', '/api/events', { contactId: Number(id), startsAt: new Date(f.startsAt).toISOString(), durationMin: Number(f.durationMin), location: f.location });
      $('#d-schedule-out').innerHTML = `<p>Added <strong>${esc(r.event.title)}</strong> on ${fmtDate(r.event.startsAt)}${r.followUp ? ', plus a thank-you reminder' : ''}.</p>
        <div class="actions">${eventLinks(r.event)}</div>`;
    });
  });
}
$('#drawer-close').addEventListener('click', () => ($('#drawer').hidden = true));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') $('#drawer').hidden = true; });

// ---------------- verification report ----------------
function renderReport(v) {
  const icon = { pass: '✓', warn: '!', fail: '✕', info: 'i', skip: '–' };
  return `<div class="report">
    <div class="report-head">
      <div class="grade g-${v.grade.replace('+', 'p')}">${esc(v.grade)}</div>
      <div>
        <div><code>${esc(v.email)}</code></div>
        <div style="margin:6px 0">${statusBadge(v)} <span class="muted">Confidence ${v.score}/99</span></div>
        <div class="muted" style="font-size:.85rem">Domain reputation: <strong>${esc(v.reputation.label)}</strong> (${v.reputation.score}/100)</div>
        <div class="meter" title="Domain reputation"><i style="width:${v.reputation.score}%"></i></div>
      </div>
    </div>
    ${v.suggestion ? `<p>Did you mean <strong>${esc(v.suggestion)}</strong>?</p>` : ''}
    <table class="checks">${v.checks.map((c) => `<tr><td><span class="badge ${c.status}">${icon[c.status]}</span></td><td>${esc(c.label)}</td><td>${esc(c.detail)}</td><td class="pts">${c.points ? (c.points > 0 ? '+' : '') + c.points : ''}</td></tr>`).join('')}</table>
    ${v.resolver === 'demo' ? '<p class="muted" style="font-size:.8rem">Demo domain: DNS and mailbox answers are simulated.</p>' : ''}
  </div>`;
}

// ---------------- views ----------------
async function loadMatches() {
  const m = await api('GET', '/api/matches');
  $('#matches-empty').hidden = !m.needsResume;
  $('#matches-profile').innerHTML = m.profile ? [...m.profile.interests.map((i) => `<span class="chip hl">${esc(i)}</span>`), ...m.profile.schools.map((s) => `<span class="chip">🎓 ${esc(s)}</span>`), ...m.profile.careerTracks.map((t) => `<span class="chip">💼 ${esc(t)}</span>`)].join('') : '';
  $('#matches-list').innerHTML = m.results.map((c) => contactCard(c)).join('');
}

async function loadSearch(e) {
  e?.preventDefault?.();
  const params = new URLSearchParams([...new FormData($('#search-form'))].filter(([, v]) => v));
  const r = await api('GET', `/api/contacts?${params}`);
  $('#search-count').textContent = `${r.total} ${r.total === 1 ? 'person' : 'people'}`;
  $('#search-list').innerHTML = r.results.map((c) => contactCard(c)).join('');
}
$('#search-form').addEventListener('submit', loadSearch);

$('#finder-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const f = Object.fromEntries(new FormData(e.target));
    const r = await api('POST', '/api/finder', { ...f, companyId: f.companyId ? Number(f.companyId) : undefined });
    $('#finder-result').innerHTML = `
      ${r.knownContact ? `<p>✅ ${esc(r.knownContact.name)} is already in your database: <code>${esc(r.knownContact.email || 'no email')}</code> <button class="btn small" data-contact="${r.knownContact.id}">Open</button></p>` : ''}
      <p class="muted">${r.emailPattern?.dominant ? `${esc(r.company)} mostly uses <strong>${esc(r.emailPattern.dominant)}@${esc(r.domain)}</strong> (${Math.round(r.emailPattern.confidence * 100)}% of ${r.emailPattern.sample} known addresses).` : `No known addresses at ${esc(r.domain)}; trying common formats.`}</p>
      ${r.best ? `<h3>Best guess</h3>${renderReport(r.best.verification)}` : ''}
      <h3>All checked candidates</h3>
      <table class="table"><tr><th>Email</th><th>Pattern</th><th>Result</th><th>Score</th></tr>
        ${r.candidates.map((c) => `<tr><td><code>${esc(c.email)}</code></td><td>${esc(c.pattern)}</td><td>${statusBadge(c.verification)}</td><td>${c.verification.score}</td></tr>`).join('')}
        ${r.untested.slice(0, 4).map((c) => `<tr><td><code>${esc(c.email)}</code></td><td>${esc(c.pattern)}</td><td><span class="badge unknown">Not checked</span></td><td></td></tr>`).join('')}
      </table>`;
  });
});

$('#verify-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const r = await api('POST', '/api/verify', { email: e.target.email.value });
    $('#verify-result').innerHTML = (r.contact ? `<p>Matched <a href="#" data-contact="${r.contact.id}">${esc(r.contact.name)}</a> at ${esc(r.contact.company)} in your database.</p>` : '') + renderReport(r);
  });
});
$('#bulk-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const emails = e.target.emails.value.split(/[\s,;]+/).filter(Boolean);
    const r = await api('POST', '/api/verify/bulk', { emails });
    $('#bulk-result').innerHTML = `<p>${Object.entries(r.summary).map(([k, n]) => `<span class="badge ${k}">${STATUS_TEXT[k] || k}: ${n}</span>`).join(' ')}</p>
      <table class="table"><tr><th>Email</th><th>Result</th><th>Score</th><th>Reputation</th></tr>
      ${r.results.map((v) => `<tr><td><code>${esc(v.email)}</code></td><td>${statusBadge(v)}</td><td>${v.score}</td><td>${esc(v.reputation.label)}</td></tr>`).join('')}</table>`;
  });
});

// ---------------- calendar ----------------
const eventLinks = (ev) => `<a class="btn small" href="${esc(ev.links.google)}" target="_blank" rel="noopener">Google</a>
  <a class="btn small" href="${esc(ev.links.outlook)}" target="_blank" rel="noopener">Outlook</a>
  <a class="btn small" href="${esc(ev.links.ics)}">.ics</a>`;

async function loadCalendar() {
  const feed = location.origin + state.user.calendarFeed;
  $('#feed-url').textContent = feed;
  $('#gcal-subscribe').href = `https://calendar.google.com/calendar/r?cid=${encodeURIComponent(feed.replace(/^https?:/, 'webcal:'))}`;
  state.events = await api('GET', '/api/events');
  renderMonth();
  const upcoming = state.events.filter((e) => Date.parse(e.startsAt) > Date.now() - 36e5);
  $('#cal-upcoming').innerHTML = upcoming.length ? upcoming.map((ev) => `<div class="list-item">
      <div><span class="badge ${ev.kind === 'meeting' ? 'pass' : ev.kind === 'deadline' ? 'fail' : 'warn'}">${ev.kind.replace('_', '-')}</span>
        <strong>${esc(ev.title)}</strong><br><span class="muted">${fmtDate(ev.startsAt)} · ${ev.durationMin} min${ev.location ? ' · ' + esc(ev.location) : ''}</span></div>
      <div class="actions">${eventLinks(ev)} <button class="btn small" data-del-event="${ev.id}">Delete</button></div></div>`).join('')
    : '<p class="muted">Nothing scheduled. Open a contact to book a coffee chat.</p>';
}
function renderMonth() {
  const m = state.calMonth, y = m.getFullYear(), mo = m.getMonth();
  $('#cal-title').textContent = m.toLocaleString(undefined, { month: 'long', year: 'numeric' });
  const first = new Date(y, mo, 1), startDay = new Date(y, mo, 1 - first.getDay());
  const today = new Date().toDateString();
  let html = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => `<div class="dow">${d}</div>`).join('');
  for (let i = 0; i < 42; i++) {
    const d = new Date(startDay); d.setDate(startDay.getDate() + i);
    const evs = state.events.filter((e) => new Date(e.startsAt).toDateString() === d.toDateString());
    html += `<div class="day ${d.getMonth() !== mo ? 'other' : ''} ${d.toDateString() === today ? 'today' : ''}"><span class="num">${d.getDate()}</span>
      ${evs.map((e) => `<span class="ev ${e.kind}" title="${esc(e.title)}" ${e.contact ? `data-contact="${e.contact.id}"` : ''}>${new Date(e.startsAt).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })} ${esc(e.title)}</span>`).join('')}</div>`;
  }
  $('#cal-grid').innerHTML = html;
}
$('#cal-prev').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() - 1, 1); renderMonth(); };
$('#cal-next').onclick = () => { state.calMonth = new Date(state.calMonth.getFullYear(), state.calMonth.getMonth() + 1, 1); renderMonth(); };
$('#copy-feed').onclick = () => navigator.clipboard.writeText($('#feed-url').textContent).then(() => toast('Feed URL copied'));
document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-del-event]');
  if (b && confirm('Delete this event?')) { await api('DELETE', `/api/events/${b.dataset.delEvent}`); loadCalendar(); }
});
$('#event-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const f = Object.fromEntries(new FormData(e.target));
  await api('POST', '/api/events', { ...f, startsAt: new Date(f.startsAt).toISOString(), durationMin: Number(f.durationMin) });
  e.target.reset(); toast('Event added'); loadCalendar();
});

// ---------------- pipeline ----------------
async function loadPipeline() {
  const saved = await api('GET', '/api/saved');
  $('#pipeline').innerHTML = ['saved', 'emailed', 'replied', 'meeting', 'closed'].map((s) => `<div class="col"><h3>${s} (${saved.filter((c) => c.status === s).length})</h3>
    ${saved.filter((c) => c.status === s).map((c) => contactCard(c, { compact: true })).join('')}</div>`).join('');
}

// ---------------- profile ----------------
function fillProfile() {
  const u = state.user, p = u.profile || { interests: [], schools: [], careerTracks: [], skills: [] };
  $('#resume-name').textContent = u.resumeFilename ? `Current: ${u.resumeFilename}` : 'No resume uploaded yet.';
  const f = $('#profile-form');
  f.interests.value = p.interests.join(', '); f.schools.value = p.schools.join(', ');
  f.careerTracks.value = p.careerTracks.join(', '); f.skills.value = p.skills.join(', '); f.location.value = u.location || '';
}
async function loadProfile() { state.user = await api('GET', '/api/me'); fillProfile(); }
const afterResume = (u) => { state.user = u; fillProfile(); toast(`Found ${u.profile.interests.length} interests, ${u.profile.schools.length} school(s)`); };
$('#resume-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => afterResume(await api('POST', '/api/me/resume', new FormData(e.target)))); });
$('#resume-text-form').addEventListener('submit', (e) => { e.preventDefault(); busy(e.submitter, async () => afterResume(await api('POST', '/api/me/resume', { text: e.target.text.value }))); });
$('#profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const f = e.target, split = (s) => s.split(',').map((x) => x.trim()).filter(Boolean);
    await api('PATCH', '/api/me', { location: f.location.value || null });
    state.user = await api('PUT', '/api/me/profile', { interests: split(f.interests.value), schools: split(f.schools.value), careerTracks: split(f.careerTracks.value), skills: split(f.skills.value) });
    fillProfile(); toast('Profile saved');
  });
});
$('#import-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const r = await api('POST', '/api/import', new FormData(e.target));
    $('#import-result').textContent = `Imported ${r.created} new, updated ${r.updated}.${r.errors.length ? ` ${r.errors.length} row(s) skipped: ${r.errors.slice(0, 3).join(' ')}` : ''}`;
    state.companies = await api('GET', '/api/companies');
  });
});

// ---------------- boot ----------------
api('GET', '/api/me').then((u) => { state.user = u; start(); }).catch(showAuth);
