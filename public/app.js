'use strict';
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const MONTHS = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const ACADEMIC_MONTHS = [8, 9, 10, 11, 12, 1, 2, 3, 4, 5, 6, 7];
const YEAR_NAMES = { 1: 'Freshman', 2: 'Sophomore', 3: 'Junior', 4: 'Senior' };
const CATEGORY_LABEL = { explore: 'Explore', prepare: 'Prepare', network: 'Network', apply: 'Apply', interview: 'Interview' };
const STATUS_LABEL = { open: 'Open', check_now: 'Check now', upcoming: 'Upcoming', watch: 'Not posted yet', closed: 'Closed', not_running: 'Not running', unconfirmed: 'Unconfirmed' };
const PROVIDERS = {
  google: { label: 'Google Calendar', short: 'Google' },
  outlook: { label: 'Outlook (Vanderbilt / Microsoft 365)', short: 'Outlook' },
  outlookcom: { label: 'Outlook.com (personal)', short: 'Outlook.com' },
  ics: { label: 'Apple Calendar / other (.ics file)', short: '.ics' },
};
const fmtMonth = (ym) => new Date(`${ym}-15T12:00:00`).toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
const state = { user: null, industries: [], monthOffset: 0, calMonth: new Date(), events: [], tl: { industry: null, year: null }, adminTab: 'programs' };

async function api(method, url, body) {
  const opts = { method, headers: {} };
  if (body instanceof FormData) opts.body = body;
  else if (body) { opts.body = JSON.stringify(body); opts.headers['content-type'] = 'application/json'; }
  const res = await fetch(url, opts);
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (res.status === 401 && !url.startsWith('/api/auth')) { showAuth(); throw new Error('Please log in.'); }
  if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { data });
  return data;
}
function toast(msg) {
  const t = $('#toast'); t.textContent = msg; t.hidden = false;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.hidden = true), 2800);
}
async function busy(btn, fn) {
  const label = btn?.textContent; if (btn) { btn.disabled = true; btn.textContent = 'Working…'; }
  try { return await fn(); } catch (e) { toast(e.message); } finally { if (btn) { btn.disabled = false; btn.textContent = label; } }
}
const fmtDate = (ymd) => new Date(`${ymd}T12:00:00`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
const fmtDateTime = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
const industryName = (slug) => state.industries.find((i) => i.slug === slug)?.name || slug;
const yearsLabel = (ys) => (!ys.length ? 'All years' : ys.map((y) => YEAR_NAMES[y]).join(', '));
const ymd = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

// ---------------- auth ----------------
let authMode = 'login';
function showAuth() { $('#app').hidden = true; $('#auth').hidden = false; }
function setAuthMode(mode) {
  authMode = mode;
  $$('[data-auth]').forEach((x) => x.classList.toggle('active', x.dataset.auth === mode));
  $('#auth').classList.toggle('signup', mode === 'signup');
  $('#auth-form [name=name]').required = mode === 'signup';
  $('#auth-form').hidden = false; $('#auth-check').hidden = true;
}
$$('[data-auth]').forEach((b) => b.addEventListener('click', () => setAuthMode(b.dataset.auth)));
$('#auth-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#auth-error').textContent = '';
  const body = Object.fromEntries(new FormData(e.target));
  try {
    if (authMode === 'signup') {
      const r = await api('POST', '/api/auth/signup', body);
      $('#auth-check-email').textContent = r.email;
      $('#auth-form').hidden = true; $('#auth-check').hidden = false;
      return;
    }
    const { user } = await api('POST', '/api/auth/login', body);
    state.user = user; start();
  } catch (err) {
    $('#auth-error').textContent = err.message;
    if (err.data?.needsVerification) { $('#auth-check-email').textContent = body.email; $('#auth-check').hidden = false; }
  }
});
$('#resend').addEventListener('click', async () => {
  await api('POST', '/api/auth/resend', { email: $('#auth-check-email').textContent }).catch(() => {});
  toast('If that account needs confirming, a new link is on its way.');
});
$('#logout').addEventListener('click', async () => { await api('POST', '/api/auth/logout').catch(() => {}); location.hash = ''; location.reload(); });

// ---------------- navigation ----------------
const loaders = { month: loadMonth, timelines: loadTimelines, programs: loadPrograms, formats: loadFormats, calendar: loadCalendar, profile: loadProfile, admin: loadAdmin };
function go(view) {
  if (view === 'admin' && !state.user.isAdmin) view = 'month';
  $$('#nav .tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === `view-${view}`));
  history.replaceState(null, '', `#${view}`);
  loaders[view]?.();
}
$$('#nav .tab').forEach((t) => t.addEventListener('click', () => go(t.dataset.view)));
document.addEventListener('click', (e) => { const g = e.target.closest('[data-goto]'); if (g) { e.preventDefault(); go(g.dataset.goto); } });

async function start() {
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#nav-admin').hidden = !state.user.isAdmin;
  state.industries = await api('GET', '/api/industries');
  const opts = state.industries.map((i) => `<option value="${esc(i.slug)}">${esc(i.name)}</option>`).join('');
  $('#prog-filters [name=industry]').insertAdjacentHTML('beforeend', opts);
  const [view, query] = location.hash.slice(1).split('?');
  if (query?.includes('welcome')) $('#welcome').hidden = false;
  const needsSetup = !state.user.gradYear;
  go(loaders[view] && !query?.includes('verify') ? view : needsSetup ? 'profile' : 'month');
}

// ---------------- shared pieces ----------------
function milestoneCard(m, { checkable = false } = {}) {
  return `<article class="ms ${m.done ? 'done' : ''}">
    ${checkable ? `<input type="checkbox" data-done="${m.id}" ${m.done ? 'checked' : ''} aria-label="Mark done">` : '<span></span>'}
    <div>
      <div class="ms-title">${esc(m.title)}</div>
      <div class="ms-meta">
        <span class="badge ${m.category}">${CATEGORY_LABEL[m.category]}</span>
        ${m.priority === 1 ? '<span class="badge high">High priority</span>' : ''}
        <span>${esc(industryName(m.industry))}${m.track ? ' · ' + esc(m.track) : ''}</span>
        <span>· ${esc(m.when)}</span>
      </div>
    </div>
    <div class="ms-actions">
      ${m.link ? `<a class="btn small" href="${esc(m.link)}" target="_blank" rel="noopener">Link</a>` : ''}
      <button class="btn small" data-remind="${m.id}" title="Add a reminder to your calendar">Remind me</button>
    </div>
    ${m.details ? `<p class="ms-details">${esc(m.details)}</p>` : ''}
  </article>`;
}

function programRow(p) {
  const urgent = p.daysLeft != null && p.daysLeft <= 7;
  const left = p.daysLeft === 0 ? 'Due today' : `${p.daysLeft} day${p.daysLeft === 1 ? '' : 's'} left`;
  let when;
  if (p.status === 'closed') when = `<strong>Closed</strong><span class="days">${p.deadline ? fmtDate(p.deadline) : 'this cycle'}</span>`;
  else if (p.status === 'not_running') when = '<strong>Not running</strong>';
  else if (p.deadline) when = `<strong>Due ${fmtDate(p.deadline)}</strong><span class="days ${urgent ? 'urgent' : ''}">${left}</span>`;
  else if (p.opensOn) when = `<strong>Opens ${fmtDate(p.opensOn)}</strong>`;
  else if (p.expectedMonth) when = `<strong>Expected ${esc(fmtMonth(p.expectedMonth))}</strong><span class="days">estimate</span>`;
  else if (p.rolling) when = '<strong>Rolling</strong><span class="days">Apply early</span>';
  else if (p.status === 'open' || p.status === 'check_now') when = '<strong>Open now</strong><span class="days">No fixed deadline posted</span>';
  else when = '<strong>Date not announced</strong>';
  const facts = [p.affinity && ['Who it\'s for', p.affinity], p.eligibility && ['Eligibility', p.eligibility], p.format && ['Format', p.format], p.timing && ['Timing', p.timing]].filter(Boolean);
  const canRemind = !['closed', 'not_running'].includes(p.status);
  return `<article class="prog ${p.pinned ? 'pinned' : ''}">
    <button class="pin ${p.pinned ? 'on' : ''}" data-pin="${p.id}" aria-pressed="${p.pinned}" title="${p.pinned ? 'Unpin' : 'Pin this program'}">${p.pinned ? '★' : '☆'}</button>
    <div class="prog-main">
      <div class="ms-title">${esc(p.name)}</div>
      <div class="ms-meta"><span><strong>${esc(p.firm)}</strong></span><span>· ${p.industries.length >= state.industries.length ? 'All industries' : p.industries.map((s) => esc(industryName(s))).join(', ')}</span><span>· ${esc(yearsLabel(p.eligibleYears))}</span>
        <span class="badge ${p.closingSoon ? 'soon' : p.status}">${p.closingSoon ? 'Closing soon' : STATUS_LABEL[p.status]}</span>
        ${p.kind === 'pipeline' ? '<span class="badge info">Pipeline org</span>' : ''}${p.needsReview ? '<span class="badge tba">Details being confirmed</span>' : ''}</div>
      ${facts.length ? `<dl class="facts">${facts.map(([k, v]) => `<dt>${k}</dt><dd>${esc(v)}</dd>`).join('')}</dl>` : ''}
      ${p.description ? `<p class="ms-details" style="margin-top:6px">${esc(p.description)}</p>` : ''}
    </div>
    <div class="when">${when}
      <div class="ms-actions" style="justify-content:flex-end;margin-top:6px">
        ${p.link ? `<a class="btn small" href="${esc(p.link)}" target="_blank" rel="noopener">${p.status === 'open' || p.status === 'check_now' ? 'Apply' : 'Details'}</a>` : ''}
        ${canRemind ? `<button class="btn small" data-prog-remind="${p.id}">Remind me</button>` : ''}
      </div>
    </div>
  </article>`;
}

// ---------------- calendar provider helpers ----------------
/** Link (and button label) to add one event to a provider's calendar. */
const providerHref = (ev, provider) => (provider === 'ics' ? ev.links.ics : ev.links[provider]);
function addToButtons(ev, { compact = false } = {}) {
  const pref = state.user.calendarProvider;
  const order = pref ? [pref, ...Object.keys(PROVIDERS).filter((k) => k !== pref)] : Object.keys(PROVIDERS);
  if (compact && pref) {
    return `<a class="btn small primary" href="${esc(providerHref(ev, pref))}" target="_blank" rel="noopener">${pref === 'ics' ? 'Download .ics' : `Add to ${PROVIDERS[pref].short}`}</a>
      <details class="cal-menu"><summary class="btn small" aria-label="Other calendars">▾</summary><div class="menu">
      ${order.slice(1).map((k) => `<a href="${esc(providerHref(ev, k))}" target="_blank" rel="noopener">${PROVIDERS[k].label}</a>`).join('')}</div></details>`;
  }
  return `<details class="cal-menu"><summary class="btn small">Add to calendar ▾</summary><div class="menu">
    ${order.map((k) => `<a href="${esc(providerHref(ev, k))}" target="_blank" rel="noopener">${PROVIDERS[k].label}</a>`).join('')}</div></details>`;
}
document.addEventListener('click', (e) => {
  // close other open calendar menus
  $$('details.cal-menu[open]').forEach((d) => { if (!d.contains(e.target)) d.open = false; });
});

/** Shown after reminders are created: lets the student push them to their own calendar. */
function providerPicker(events) {
  const pref = state.user.calendarProvider || 'outlook';
  const ids = events.map((ev) => ev.id).join(',');
  const render = (prov) => (prov === 'ics'
    ? `<a class="btn primary" href="/api/events/export.ics?ids=${ids}">Download ${events.length > 1 ? `all ${events.length} as one` : 'the'} .ics file</a>
       <p class="hint">Opens in Apple Calendar, Outlook for Mac/Windows, or any calendar app.</p>`
    : `<div class="list">${events.map((ev) => `<div class="list-item"><span><strong>${esc(ev.title)}</strong><br><span class="muted">${fmtDateTime(ev.startsAt)}</span></span>
        <a class="btn small primary" href="${esc(ev.links[prov])}" target="_blank" rel="noopener">Add to ${PROVIDERS[prov].short}</a></div>`).join('')}</div>`);
  setTimeout(() => {
    const sel = $('#prov-select');
    if (!sel) return;
    sel.onchange = async () => {
      $('#prov-out').innerHTML = render(sel.value);
      state.user = await api('PATCH', '/api/me', { calendarProvider: sel.value }).catch(() => state.user);
    };
  });
  return `<label>Also add to my calendar:
      <select id="prov-select">${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === pref ? 'selected' : ''}>${v.label}</option>`).join('')}</select></label>
    <div id="prov-out">${render(pref)}</div>
    <p class="hint">Reminders are already in your BBSA calendar. If you've subscribed to your calendar feed (Calendar tab), they'll appear in your own calendar automatically and you can skip this.</p>`;
}

document.addEventListener('change', async (e) => {
  const cb = e.target.closest('[data-done]');
  if (!cb) return;
  try {
    await api('PUT', `/api/milestones/${cb.dataset.done}/progress${asOfQuery()}`, { done: cb.checked });
    cb.closest('.ms').classList.toggle('done', cb.checked);
  } catch (err) { cb.checked = !cb.checked; toast(err.message); }
});
const at9 = (dateStr) => new Date(`${dateStr}T09:00`).toISOString();
const addDays = (dateStr, n) => { const d = new Date(`${dateStr}T12:00:00`); d.setDate(d.getDate() + n); return ymd(d); };
const today = () => ymd(new Date());

document.addEventListener('click', async (e) => {
  const remind = e.target.closest('[data-remind]');
  if (remind) {
    openDialog(`<h3>Remind me</h3>
      <label>On <input type="date" name="date" value="${addDays(today(), 2)}" min="${today()}" required></label>
      <p class="hint">The reminder pops up at 9:00 AM that day.</p>
      <div id="rem-out"></div>
      <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><button class="btn primary" value="go">Add reminder</button></div>`,
    async (form, action) => {
      if (action !== 'go') return true;
      const ev = await api('POST', '/api/events', { milestoneId: Number(remind.dataset.remind), startsAt: at9(form.date.value), durationMin: 30 });
      $('#rem-out').innerHTML = `<p class="notice">Added to your BBSA calendar.</p>${providerPicker([ev])}`;
      form.querySelector('[value=go]').remove();
      return false;
    });
  }

  const pin = e.target.closest('[data-pin]');
  if (pin) {
    const on = !pin.classList.contains('on');
    try {
      await api('PUT', `/api/programs/${pin.dataset.pin}/pin`, { pinned: on });
      pin.classList.toggle('on', on); pin.textContent = on ? '★' : '☆'; pin.setAttribute('aria-pressed', on);
      pin.closest('.prog')?.classList.toggle('pinned', on);
      toast(on ? 'Pinned. Use "Remind me" to put its dates on your calendar.' : 'Unpinned');
    } catch (err) { toast(err.message); }
  }

  const pr = e.target.closest('[data-prog-remind]');
  if (pr) openProgramReminders(Number(pr.dataset.progRemind));
});

/** Reminders for a program: when applications open, a nudge to start applying, and the deadline. */
async function openProgramReminders(id) {
  const p = state.programCache?.[id] || (await api('GET', '/api/programs')).find((x) => x.id === id);
  if (!p) return toast('Program not found.');
  const t = today();
  const opts = [];
  if (p.opensOn && p.opensOn >= t) opts.push(['opens', `Applications open (${fmtDate(p.opensOn)})`, p.opensOn]);
  else if (p.expectedMonth && !p.deadline && `${p.expectedMonth}-01` >= t.slice(0, 8) + '01') {
    const d = `${p.expectedMonth}-01` < t ? t : `${p.expectedMonth}-01`;
    opts.push(['check', `Check whether applications are open (expected ${fmtMonth(p.expectedMonth)})`, d]);
  }
  if (p.deadline && p.deadline >= t) {
    const applyDate = addDays(p.deadline, -7) < t ? t : addDays(p.deadline, -7);
    opts.push(['apply', 'Start your application', applyDate]);
    opts.push(['deadline', `Deadline day (${fmtDate(p.deadline)})`, p.deadline]);
  }
  if (!opts.length) opts.push(['check', 'Check back on this program', addDays(t, 14)]);
  openDialog(`<h3>Reminders for ${esc(p.name)}</h3><p class="muted">${esc(p.firm)}${p.timing ? ` · ${esc(p.timing)}` : ''}</p>
    ${opts.map(([type, label, date]) => `<div class="rem-row"><label class="checks-row"><label><input type="checkbox" name="type" value="${type}" checked> ${esc(label)}</label></label>
      <input type="date" name="date-${type}" value="${date}" min="${t}" ${type === 'deadline' ? 'readonly' : ''}></div>`).join('')}
    <p class="hint">Reminders pop up at 9:00 AM. Deadline reminders also alert you the day before. Setting reminders pins the program.</p>
    <div id="rem-out"></div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><button class="btn primary" value="go">Add reminders</button></div>`,
  async (form, action) => {
    if (action !== 'go') return true;
    const items = $$('input[name=type]:checked', form).map((cb) => ({ type: cb.value, startsAt: at9(form.elements[`date-${cb.value}`].value) }));
    if (!items.length) { toast('Pick at least one reminder.'); return false; }
    const r = await api('POST', `/api/programs/${p.id}/reminders`, { items });
    $('#rem-out').innerHTML = `<p class="notice">Added ${r.events.length} reminder${r.events.length === 1 ? '' : 's'} to your BBSA calendar.</p>${providerPicker(r.events)}`;
    form.querySelector('[value=go]').remove();
    $$(`[data-pin="${p.id}"]`).forEach((b) => { b.classList.add('on'); b.textContent = '★'; b.closest('.prog')?.classList.add('pinned'); });
    return false;
  });
}

// ---------------- this month ----------------
function asOfQuery() {
  if (!state.monthOffset) return '';
  const d = new Date(); d.setDate(15); d.setMonth(d.getMonth() + state.monthOffset);
  return `?asOf=${ymd(d)}`;
}
async function loadMonth() {
  const r = await api('GET', `/api/this-month${asOfQuery()}`);
  const d = new Date(`${r.date}T12:00:00`);
  $('#month-title').textContent = `${d.toLocaleString(undefined, { month: 'long', year: 'numeric' })}${state.monthOffset ? ' (preview)' : ''}`;
  $('#month-sub').textContent = r.classYearName
    ? `${r.classYearName} · ${r.usingAllIndustries ? 'All industries' : r.industries.map((i) => i.name).join(', ')} · ${r.academicYear} academic year`
    : '';
  if (r.needsProfile) {
    $('#month-body').innerHTML = '<div class="empty"><p>Add your graduation year so we can show what to focus on.</p><button class="btn primary" data-goto="profile">Set up profile</button></div>';
    return;
  }
  if (r.outOfRange) {
    $('#month-body').innerHTML = `<div class="empty"><p>${r.classYear === 0 ? "You haven't started freshman year yet in this month." : 'Your class has graduated by this month.'} Check your graduation year on your profile.</p><button class="btn" data-goto="profile">Profile</button></div>`;
    return;
  }
  const section = (title, count, body, empty) => `<div class="section"><h3>${title} <span class="count">${count}</span></h3>${count ? body : `<p class="empty-sm">${empty}</p>`}</div>`;
  const left = r.now.filter((m) => !m.done).length;
  cachePrograms([...r.pinned, ...r.deadlines, ...r.toWatch]);
  $('#month-body').innerHTML =
    (r.usingAllIndustries ? '<p class="notice">Showing every industry. <a href="#" data-goto="profile">Pick the industries you\'re recruiting for</a> to focus this list.</p>' : '') +
    section('Focus this month', `${left} to do`, `<div class="list">${r.now.map((m) => milestoneCard(m, { checkable: true })).join('')}</div>`, 'Nothing on the timeline for this month. A good time to get ahead on next month.') +
    (r.pinned.length ? section('Your pinned programs', r.pinned.length, `<div class="list">${r.pinned.map(programRow).join('')}</div>`, '') : '') +
    section('Deadlines in the next 45 days', r.deadlines.length, `<div class="list">${r.deadlines.map(programRow).join('')}</div>`, 'No program deadlines coming up for your year and industries.') +
    section('Coming up next month', r.next.length, `<div class="list">${r.next.map((m) => milestoneCard(m)).join('')}</div>`, 'Nothing new starts next month.') +
    section('Check now or opening soon', r.toWatch.length, `<div class="list">${r.toWatch.map(programRow).join('')}</div>`, 'Nothing else expected to open in the next month for your year. Browse the <a href="#" data-goto="programs">Programs</a> tab.') +
    section('On your calendar this month', r.events.length, `<div class="list">${r.events.map((ev) => `<div class="list-item"><div><span class="badge ${ev.kind === 'deadline' ? 'apply' : ev.kind === 'reminder' ? 'prepare' : 'network'}">${ev.kind}</span> <strong>${esc(ev.title)}</strong><br><span class="muted">${fmtDateTime(ev.startsAt)}</span></div></div>`).join('')}</div>`, 'Nothing scheduled. Add deadlines and reminders from the lists above.');
}
$('#month-prev').onclick = () => { state.monthOffset--; loadMonth(); };
$('#month-next').onclick = () => { state.monthOffset++; loadMonth(); };
$('#month-today').onclick = () => { state.monthOffset = 0; loadMonth(); };

// ---------------- timelines ----------------
function seg(el, items, current, onPick) {
  el.innerHTML = items.map(([v, label]) => `<button type="button" data-v="${esc(v)}" class="${String(v) === String(current) ? 'active' : ''}">${esc(label)}</button>`).join('');
  el.onclick = (e) => { const b = e.target.closest('button'); if (b) onPick(b.dataset.v); };
}
async function loadTimelines() {
  const t = state.tl;
  if (!t.industry) t.industry = state.user.industries[0] || state.industries[0]?.slug;
  if (t.year === null) t.year = state.user.classYear >= 1 && state.user.classYear <= 4 ? state.user.classYear : 0;
  seg($('#tl-industry'), state.industries.map((i) => [i.slug, i.name]), t.industry, (v) => { t.industry = v; loadTimelines(); });
  seg($('#tl-year'), [[0, 'All years'], [1, 'Freshman'], [2, 'Sophomore'], [3, 'Junior'], [4, 'Senior']], t.year, (v) => { t.year = Number(v); loadTimelines(); });
  const rows = await api('GET', `/api/timelines?industry=${encodeURIComponent(t.industry)}${t.year ? `&year=${t.year}` : ''}`);
  const thisMonth = new Date().getMonth() + 1;
  const strip = (m) => ACADEMIC_MONTHS.map((mo) => {
    const on = m.startMonth <= m.endMonth ? mo >= m.startMonth && mo <= m.endMonth : mo >= m.startMonth || mo <= m.endMonth;
    return `<span class="${on ? 'on' : ''} ${mo === thisMonth ? 'now' : ''}" title="${MONTHS[mo]}">${MONTHS[mo][0]}</span>`;
  }).join('');
  const groups = t.year ? [[t.year, rows]] : [1, 2, 3, 4].map((y) => [y, rows.filter((m) => !m.classYears.length || m.classYears.includes(y))]);
  $('#tl-summary').textContent = `${rows.length} milestone${rows.length === 1 ? '' : 's'}. The orange outline marks the current month.`;
  $('#tl-body').innerHTML = groups.map(([y, ms]) => `<div class="tl-year"><h3>${YEAR_NAMES[y]} year</h3>
    ${ms.length ? `<div class="tl-row" style="background:transparent;border:0;padding:0 12px"><span></span><div class="strip strip-head">${ACADEMIC_MONTHS.map((mo) => `<span>${MONTHS[mo]}</span>`).join('')}</div></div>
      ${ms.map((m) => `<div class="tl-row"><details><summary>${esc(m.title)} <span class="badge ${m.category}">${CATEGORY_LABEL[m.category]}</span>${m.track ? ` <span class="muted">· ${esc(m.track)}</span>` : ''}</summary>
        <p>${esc(m.details || '')}</p><p><em>${esc(m.when)}</em></p></details>
        <div class="strip">${strip(m)}</div></div>`).join('')}`
    : '<p class="empty-sm">No milestones for this year yet.</p>'}</div>`).join('');
  const ind = state.industries.find((i) => i.slug === t.industry);
  $('#tl-guide').innerHTML = ind ? `<p class="muted">${esc(ind.summary || '')}</p><div class="guide">${ind.guide.map((s) => `<details><summary>${esc(s.heading)}</summary><ul>${s.items.map((it) => `<li>${esc(it)}</li>`).join('')}</ul></details>`).join('')}</div>` : '';
}

// ---------------- programs ----------------
async function loadPrograms() {
  const f = $('#prog-filters');
  if (!loadPrograms.init) {
    loadPrograms.init = true;
    if (state.user.classYear >= 1 && state.user.classYear <= 4) f.year.value = state.user.classYear;
    f.addEventListener('input', () => loadPrograms());
    f.addEventListener('submit', (e) => e.preventDefault());
  }
  const params = new URLSearchParams([...new FormData(f)].filter(([, v]) => v));
  if (!f.status.value && !f.pinned.checked) params.set('status', 'open,check_now,upcoming,watch,unconfirmed');
  const rows = await api('GET', `/api/programs?${params}`);
  cachePrograms(rows);
  const pinnedCount = rows.filter((p) => p.pinned).length;
  $('#prog-count').textContent = `${rows.length} program${rows.length === 1 ? '' : 's'}${pinnedCount ? ` · ${pinnedCount} pinned` : ''}${!f.status.value ? ' · closed and discontinued programs hidden (choose a status to see them)' : ''}`;
  $('#prog-list').innerHTML = rows.length ? rows.map(programRow).join('') : `<p class="empty-sm">${f.pinned.checked ? 'You haven\'t pinned any programs yet. Tap ☆ on a program to pin it.' : 'No programs match these filters.'}</p>`;
}
function cachePrograms(rows) {
  state.programCache = state.programCache || {};
  rows.forEach((p) => { state.programCache[p.id] = p; });
}

// ---------------- email formats ----------------
async function loadFormats() {
  const f = $('#fmt-filters');
  const r = await api('GET', `/api/formats?${new URLSearchParams([...new FormData(f)].filter(([, v]) => v))}`);
  if (!loadFormats.init) {
    loadFormats.init = true;
    f.sector.insertAdjacentHTML('beforeend', r.sectors.map((s) => `<option>${esc(s)}</option>`).join(''));
    f.addEventListener('input', () => loadFormats());
    f.addEventListener('submit', (e) => e.preventDefault());
  }
  $('#fmt-count').textContent = `${r.results.length} firm${r.results.length === 1 ? '' : 's'}. Click a firm to build an address from a name.`;
  $('#fmt-table').innerHTML = `<tr><th>Firm</th><th>Format</th><th>Example</th><th>Confidence</th><th>Notes</th></tr>` +
    r.results.map((x) => `<tr class="clickable" data-firm="${x.id}"><td><strong>${esc(x.name)}</strong><br><span class="muted">${esc([x.sector, x.category].filter(Boolean).join(' · '))}</span></td>
      <td><code>${esc(x.format)}</code>${x.fallbacks.length ? `<br><span class="muted">then ${x.fallbacks.map((fb) => `<code>${esc(fb.format)}</code>`).join(', ')}</span>` : ''}</td>
      <td><code>${esc(x.example)}</code></td><td><span class="conf ${esc((x.confidence || '').replace(' ', '-'))}">${esc(x.confidence || '—')}</span></td>
      <td class="muted">${esc(x.notes || '')}</td></tr>`).join('');
}
$('#fmt-table').addEventListener('click', (e) => {
  const tr = e.target.closest('[data-firm]');
  if (!tr) return;
  const name = tr.querySelector('strong').textContent;
  openDialog(`<h3>Build an address at ${esc(name)}</h3>
    <div class="row2"><label>First name <input name="first" required autofocus></label><label>Last name <input name="last" required></label></div>
    <p class="hint">Use the name the person goes by (e.g. Dan, not Daniel). Hyphens, apostrophes and accents are removed.</p>
    <div id="addr-out"></div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><button class="btn primary" value="go">Build</button></div>`,
  async (form, action) => {
    if (action !== 'go') return true;
    const r = await api('GET', `/api/formats/${tr.dataset.firm}/address?first=${encodeURIComponent(form.first.value)}&last=${encodeURIComponent(form.last.value)}`);
    $('#addr-out').innerHTML = `<p><strong>Most likely:</strong> ${r.primary.map((a) => `<code>${esc(a)}</code>`).join(' or ')}
      <button type="button" class="btn small" data-copy="${esc(r.primary[0])}">Copy</button></p>
      ${r.fallbacks.length ? `<p><strong>If that bounces, try:</strong> ${r.fallbacks.map((a) => `<code>${esc(a)}</code>`).join(', ')}</p>` : ''}
      ${r.notes ? `<p class="hint">${esc(r.notes)}</p>` : ''}
      <p class="hint">Confidence: ${esc(r.confidence || 'unknown')}. A format is the rule, not a guarantee: duplicate names, nicknames and old accounts break it.</p>`;
    return false;
  });
});
document.addEventListener('click', (e) => {
  const c = e.target.closest('[data-copy]');
  if (c) navigator.clipboard.writeText(c.dataset.copy).then(() => toast('Copied'));
});

// ---------------- calendar ----------------
function renderFeed() {
  const sub = state.user.calendarSubscribe;
  const sel = $('#feed-provider');
  sel.value = state.user.calendarProvider || 'outlook';
  const prov = sel.value;
  $('#feed-url').textContent = location.origin + state.user.calendarFeed;
  const go = $('#feed-subscribe');
  go.href = sub[prov];
  go.textContent = prov === 'ics' ? 'Open in calendar app' : `Subscribe in ${PROVIDERS[prov].short}`;
  $('#feed-help').innerHTML = {
    google: 'Google Calendar adds it under "Other calendars" and refreshes it every few hours.',
    outlook: 'Opens Outlook on the web with your Vanderbilt account and adds it as an internet calendar. It also shows up in the Outlook desktop and phone apps.',
    outlookcom: 'For a personal Outlook.com or Hotmail account.',
    ics: 'Opens Apple Calendar or your default calendar app and subscribes to the feed. You can also paste the feed URL into any calendar that supports "subscribe by URL".',
  }[prov] + (/localhost|127\.0\.0\.1/.test(location.host) ? ' <strong>Subscribing only works once the app is hosted on a public web address; it can\'t reach localhost.</strong>' : '');
}
$('#feed-provider').addEventListener('change', async (e) => {
  state.user = await api('PATCH', '/api/me', { calendarProvider: e.target.value }).catch(() => state.user);
  renderFeed();
});
async function loadCalendar() {
  renderFeed();
  state.events = await api('GET', '/api/events');
  renderMonth();
  const upcoming = state.events.filter((e) => Date.parse(e.startsAt) > Date.now() - 36e5);
  $('#cal-upcoming').innerHTML = upcoming.length ? upcoming.map((ev) => `<div class="list-item">
      <div><span class="badge ${ev.kind === 'deadline' ? 'apply' : ev.kind === 'reminder' ? 'prepare' : 'network'}">${ev.kind}</span>
        <strong>${esc(ev.title)}</strong><br><span class="muted">${fmtDateTime(ev.startsAt)} · ${ev.durationMin} min${ev.location ? ' · ' + esc(ev.location) : ''}</span></div>
      <div class="ms-actions">${addToButtons(ev, { compact: true })} <button class="btn small" data-del-event="${ev.id}">Delete</button></div></div>`).join('')
    : '<p class="empty-sm">Nothing scheduled. Use "Remind me" on <a href="#" data-goto="programs">Programs</a> or <a href="#" data-goto="month">This month</a>.</p>';
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
      ${evs.map((e) => `<span class="ev ${e.kind === 'deadline' ? 'deadline' : e.kind === 'reminder' ? 'follow_up' : ''}" title="${esc(e.title)}">${esc(e.title)}</span>`).join('')}</div>`;
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
  await busy(e.submitter, async () => {
    const ev = await api('POST', '/api/events', { ...f, startsAt: new Date(f.startsAt).toISOString(), durationMin: Number(f.durationMin) });
    e.target.reset(); loadCalendar();
    openDialog(`<h3>Event added</h3><p class="notice">${esc(ev.title)} is in your BBSA calendar.</p>${providerPicker([ev])}
      <div class="actions"><button class="btn primary" value="cancel">Done</button></div>`, () => true);
  });
});

// ---------------- profile ----------------
function loadProfile() {
  const u = state.user, f = $('#profile-form');
  f.name.value = u.name; f.gradYear.value = u.gradYear || '';
  $('#profile-year').textContent = u.classYearName ? `You're a ${u.classYearName.toLowerCase()} this academic year.` : '';
  $('#profile-industries').innerHTML = state.industries.map((i) => `<label><input type="checkbox" name="industries" value="${esc(i.slug)}" ${u.industries.includes(i.slug) ? 'checked' : ''}> ${esc(i.name)}</label>`).join('');
  f.calendarProvider.innerHTML = `<option value="">Ask me each time</option>${Object.entries(PROVIDERS).map(([k, v]) => `<option value="${k}" ${k === u.calendarProvider ? 'selected' : ''}>${v.label}</option>`).join('')}`;
}
$('#profile-form').addEventListener('submit', (e) => {
  e.preventDefault();
  busy(e.submitter, async () => {
    const f = e.target;
    state.user = await api('PATCH', '/api/me', { name: f.name.value, gradYear: f.gradYear.value || null, industries: $$('input[name=industries]:checked', f).map((x) => x.value), calendarProvider: f.calendarProvider.value || null });
    loadProfile(); $('#welcome').hidden = true; toast('Profile saved');
  });
});

// ---------------- dialog helper ----------------
/** onSubmit(form, action) returns true to close. */
function openDialog(html, onSubmit) {
  const dlg = $('#dialog'), form = $('#dialog-form');
  form.innerHTML = html;
  form.onsubmit = async (e) => {
    e.preventDefault();
    const action = e.submitter?.value;
    if (action === 'cancel') return dlg.close();
    try { if (await onSubmit(form, action)) dlg.close(); } catch (err) { toast(err.message); }
  };
  dlg.showModal();
}

// ---------------- admin ----------------
const monthOpts = ACADEMIC_MONTHS.map((m) => [m, MONTHS[m]]);
const SCHEMAS = {
  programs: {
    label: 'program', list: '/api/admin/programs', path: '/api/admin/programs',
    columns: [['firm', 'Firm'], ['name', 'Program'], ['industries', 'Industries'], ['status', 'Status'], ['deadline', 'Deadline'], ['expected_month', 'Expected']],
    fields: () => [
      ['firm', 'Firm', 'text', { required: true }], ['name', 'Program name', 'text', { required: true }],
      ['kind', 'Type', 'select', { options: [['firm', 'Firm program'], ['pipeline', 'Pipeline organization (SEO, MLT, ColorStack…)']] }],
      ['industries', 'Industries', 'multi', { options: state.adminIndustries.map((i) => [i.slug, i.name]) }],
      ['status', 'Status', 'select', { options: Object.entries(STATUS_LABEL), hint: 'Dates override this: a past deadline shows Closed; an expected month that has arrived shows Check now.' }],
      ['eligible_years', 'Eligible class years (none = all)', 'years'], ['eligibility', 'Eligibility, as written', 'text', { placeholder: 'Sophomore (preferred GPA 3.2+)' }],
      ['affinity', "Who it's for", 'text', { placeholder: 'Open to all / Women / Black sophomores…' }], ['format', 'Format / location', 'text'],
      ['timing', 'Deadline / timing, as written', 'text', { placeholder: 'Expected ~Feb 2027 (last cycle opened Feb 1)' }],
      ['opens_on', 'Opens on (confirmed)', 'date'], ['deadline', 'Deadline (confirmed)', 'date'],
      ['expected_month', 'Expected month (estimate, if no confirmed date)', 'month'], ['rolling', 'Rolling admissions', 'bool'],
      ['cycle', 'Cycle', 'text', { placeholder: '2026-27' }], ['link', 'Link', 'url'], ['description', 'Notes for students', 'textarea'],
      ['needs_review', 'Needs review (shows "details being confirmed")', 'bool'], ['active', 'Visible to members', 'bool', { default: true }],
    ],
  },
  milestones: {
    label: 'milestone', list: '/api/admin/milestones', path: '/api/admin/milestones',
    columns: [['title', 'Milestone'], ['industry', 'Industry'], ['class_years', 'Years'], ['start_month', 'From'], ['end_month', 'To']],
    fields: () => [
      ['industry', 'Industry', 'select', { options: state.adminIndustries.map((i) => [i.slug, i.name]) }], ['track', 'Track (optional)', 'text', { placeholder: 'e.g. Quant' }],
      ['class_years', 'Class years (none = every year)', 'years'],
      ['start_month', 'From month', 'select', { options: monthOpts }], ['end_month', 'To month', 'select', { options: monthOpts, hint: 'Windows can wrap past December, e.g. Dec to Feb.' }],
      ['title', 'Title', 'text', { required: true }], ['details', 'Details', 'textarea'],
      ['category', 'Category', 'select', { options: Object.entries(CATEGORY_LABEL) }],
      ['priority', 'Priority', 'select', { options: [[1, 'High'], [2, 'Normal'], [3, 'Low']], default: 2 }],
      ['link', 'Link', 'url'], ['sort_order', 'Sort order', 'number', { default: 0 }], ['source', 'Internal note (not shown to members)', 'text'],
    ],
  },
  industries: {
    label: 'industry', list: '/api/admin/industries', path: '/api/admin/industries',
    columns: [['name', 'Industry'], ['slug', 'Slug'], ['sort_order', 'Order'], ['active', 'Active']],
    fields: () => [
      ['name', 'Name', 'text', { required: true }], ['slug', 'Slug', 'text', { required: true, hint: 'Lowercase, hyphens: e.g. sales-trading' }],
      ['summary', 'Summary', 'textarea'], ['sort_order', 'Sort order', 'number', { default: 0 }], ['active', 'Active', 'bool', { default: true }],
      ['guide', 'Guide sections (JSON)', 'code', { default: '[\n  { "heading": "Overview", "items": ["..."] }\n]' }],
    ],
  },
  firms: {
    label: 'firm', list: '/api/admin/firms', path: '/api/admin/firms',
    columns: [['name', 'Firm'], ['sector', 'Sector'], ['format', 'Format'], ['confidence', 'Confidence'], ['researched_on', 'Researched']],
    fields: () => [
      ['name', 'Firm', 'text', { required: true }], ['sector', 'Sector', 'text', { placeholder: 'Consulting, Finance, Tech…' }], ['category', 'Category', 'text'],
      ['format', 'Email format', 'text', { required: true, placeholder: 'first.last@firm.com', hint: 'first.last, first_last, flast, f.last, last.first, last_first, lastf, firstl, first…' }],
      ['fallbacks', 'Fallback formats', 'text', { placeholder: 'flast@firm.com, first@firm.com' }],
      ['max_local', 'Username length limit (optional)', 'number', { hint: 'e.g. 8 for Cisco, whose usernames are cut off at 8 characters' }],
      ['confidence', 'Confidence', 'select', { options: [['Confirmed', 'Confirmed'], ['Very High', 'Very High'], ['High', 'High'], ['Medium', 'Medium']] }],
      ['notes', 'Notes', 'textarea'], ['sources_agree', 'Sources agreeing', 'text', { placeholder: '4 of 5' }], ['researched_on', 'Researched on', 'date'],
    ],
  },
};

function fieldHtml([name, label, type, o = {}], value) {
  const v = value ?? o.default ?? '';
  const hint = o.hint ? `<span class="hint">${esc(o.hint)}</span>` : '';
  if (type === 'bool') return `<div class="checks-row"><label><input type="checkbox" name="${name}" ${v ? 'checked' : ''}> ${esc(label)}</label></div>`;
  if (type === 'years') return `<fieldset><legend>${esc(label)}</legend><div class="checks-row">${[1, 2, 3, 4].map((y) => `<label><input type="checkbox" name="${name}" value="${y}" ${(v || []).includes(y) ? 'checked' : ''}> ${YEAR_NAMES[y]}</label>`).join('')}</div></fieldset>`;
  if (type === 'multi') return `<fieldset><legend>${esc(label)}</legend><div class="checks-row">${o.options.map(([ov, ol]) => `<label><input type="checkbox" name="${name}" value="${esc(ov)}" ${(v || []).includes(ov) ? 'checked' : ''}> ${esc(ol)}</label>`).join('')}</div></fieldset>`;
  if (type === 'select') return `<label>${esc(label)} ${hint}<select name="${name}">${o.options.map(([ov, ol]) => `<option value="${esc(ov)}" ${String(ov) === String(v) ? 'selected' : ''}>${esc(ol)}</option>`).join('')}</select></label>`;
  if (type === 'textarea' || type === 'code') return `<label>${esc(label)} ${hint}<textarea name="${name}" rows="${type === 'code' ? 12 : 3}" class="${type}">${esc(v)}</textarea></label>`;
  return `<label>${esc(label)} ${hint}<input name="${name}" type="${type}" value="${esc(v)}" ${o.required ? 'required' : ''} placeholder="${esc(o.placeholder || '')}"></label>`;
}
function readFields(form, fields) {
  const out = {};
  for (const [name, , type] of fields) {
    if (type === 'bool') out[name] = form.elements[name].checked;
    else if (type === 'years') out[name] = $$(`input[name=${name}]:checked`, form).map((x) => Number(x.value));
    else if (type === 'multi') out[name] = $$(`input[name=${name}]:checked`, form).map((x) => x.value);
    else out[name] = form.elements[name].value;
  }
  return out;
}

async function loadAdmin() {
  if (!state.user.isAdmin) return;
  $$('#admin-tabs button').forEach((b) => b.classList.toggle('active', b.dataset.admin === state.adminTab));
  state.adminIndustries = await api('GET', '/api/admin/industries');
  if (state.adminTab === 'backup') return renderBackup();
  const s = SCHEMAS[state.adminTab];
  const rows = await api('GET', s.list);
  const cell = (row, key) => {
    const v = row[key];
    if (key === 'class_years') return v.length ? v.map((y) => YEAR_NAMES[y].slice(0, 2)).join(', ') : 'All';
    if (key === 'start_month' || key === 'end_month') return MONTHS[v];
    if (key === 'industry') return industryName(v);
    if (key === 'industries') return v.map(industryName).join(', ');
    if (key === 'status') return STATUS_LABEL[v] || v;
    if (typeof v === 'boolean') return v ? 'Yes' : '';
    if (key === 'format') return `<code>${esc(v)}</code>`;
    return esc(v ?? '—');
  };
  $('#admin-body').innerHTML = `<div class="admin-bar">
      <input id="admin-search" placeholder="Filter ${s.label}s…">
      <button class="btn primary" id="admin-add">Add ${s.label}</button>
      ${['firms', 'programs'].includes(state.adminTab) ? '<button class="btn" id="admin-upload">Upload spreadsheet</button>' : ''}
    </div>
    <div class="table-wrap"><table class="table"><tr>${s.columns.map(([, l]) => `<th>${l}</th>`).join('')}<th>Last edited</th></tr>
    ${rows.map((row) => `<tr class="clickable" data-row="${row.id}">${s.columns.map(([k]) => `<td>${cell(row, k)}</td>`).join('')}<td class="muted">${esc(row.updated_by || '')}<br>${esc((row.updated_at || '').slice(0, 10))}</td></tr>`).join('')}
    </table></div>`;
  $('#admin-search').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    $$('#admin-body tr[data-row]').forEach((tr) => { tr.hidden = q && !tr.textContent.toLowerCase().includes(q); });
  };
  $('#admin-add').onclick = () => editRow(s, null);
  $('#admin-body table').onclick = (e) => {
    const tr = e.target.closest('[data-row]');
    if (tr) editRow(s, rows.find((r) => String(r.id) === tr.dataset.row));
  };
  $('#admin-upload')?.addEventListener('click', state.adminTab === 'programs' ? uploadPrograms : uploadFormats);
}
$('#admin-tabs').addEventListener('click', (e) => { const b = e.target.closest('[data-admin]'); if (b) { state.adminTab = b.dataset.admin; loadAdmin(); } });

function editRow(s, row) {
  const fields = s.fields();
  openDialog(`<h3>${row ? 'Edit' : 'Add'} ${s.label}</h3>${fields.map((f) => fieldHtml(f, row?.[f[0]])).join('')}
    <div class="actions">${row ? '<button class="btn" value="delete" formnovalidate style="margin-right:auto;color:var(--bad)">Delete</button>' : ''}
      <button class="btn" value="cancel" formnovalidate>Cancel</button><button class="btn primary" value="save">Save</button></div>`,
  async (form, action) => {
    if (action === 'delete') {
      if (!confirm(`Delete this ${s.label}? This can't be undone.`)) return false;
      await api('DELETE', `${s.path}/${row.id}`);
    } else {
      const body = readFields(form, fields);
      await (row ? api('PUT', `${s.path}/${row.id}`, body) : api('POST', s.path, body));
    }
    toast('Saved');
    if (s === SCHEMAS.industries) state.industries = await api('GET', '/api/industries');
    loadAdmin();
    return true;
  });
}

function uploadPrograms() {
  openDialog(`<h3>Upload programs spreadsheet</h3>
    <p class="hint">An .xlsx or .csv with columns <strong>Industry</strong>, <strong>Firm</strong> and <strong>Program</strong>, plus any of: Affinity focus / who it's for, Eligible year, Format / location, Deadline / timing, Deadline date, Status, Link, Notes. Programs are matched by firm + program name, so re-uploading an updated sheet refreshes them and keeps students' pins and reminders.</p>
    <p class="hint">Industry labels like "Banking", "Consulting", "Tech", "Finance (Quant/Trading)" and "Pipeline org (tech / finance / multi-industry)" are mapped automatically. Check the result and adjust any program's industries by hand if needed.</p>
    <label>File <input type="file" name="file" accept=".xlsx,.csv" required></label>
    <label>Recruiting cycle <input name="cycle" placeholder="2026-27"></label>
    <div id="upload-out"></div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><button class="btn primary" value="go">Upload</button></div>`,
  async (form, action) => {
    if (action !== 'go') return true;
    const fd = new FormData(); fd.append('file', form.file.files[0]); if (form.cycle.value) fd.append('cycle', form.cycle.value);
    const r = await api('POST', '/api/admin/programs/import', fd);
    $('#upload-out').innerHTML = `<p class="notice">Added ${r.created}, updated ${r.updated}.${r.errors.length ? `<br>${r.errors.length} row(s) skipped:<br>${r.errors.slice(0, 8).map(esc).join('<br>')}` : ''}</p>`;
    loadAdmin();
    return false;
  });
}

function uploadFormats() {
  openDialog(`<h3>Upload email formats</h3>
    <p class="hint">An .xlsx or .csv with columns <strong>Firm</strong> and <strong>Best Email Format</strong> (e.g. first.last@gs.com). Optional: Confidence, Fallback / Notes, Category, Sites Agreeing, Sector. Firms already in the list are updated by name.</p>
    <label>File <input type="file" name="file" accept=".xlsx,.csv" required></label>
    <label>Sector for these firms <span class="hint">(if the sheet has no Sector column)</span><input name="sector" placeholder="e.g. Tech"></label>
    <div id="upload-out"></div>
    <div class="actions"><button class="btn" value="cancel" formnovalidate>Close</button><button class="btn primary" value="go">Upload</button></div>`,
  async (form, action) => {
    if (action !== 'go') return true;
    const fd = new FormData(); fd.append('file', form.file.files[0]); if (form.sector.value) fd.append('sector', form.sector.value);
    const r = await api('POST', '/api/admin/firms/import', fd);
    $('#upload-out').innerHTML = `<p class="notice">Added ${r.created}, updated ${r.updated}.${r.errors.length ? `<br>${r.errors.length} row(s) skipped:<br>${r.errors.slice(0, 8).map(esc).join('<br>')}` : ''}</p>`;
    loadAdmin();
    return false;
  });
}

function renderBackup() {
  $('#admin-body').innerHTML = `<div class="grid2">
    <div class="panel"><h3>Download everything</h3><p class="muted">Industries, timelines, programs and email formats as one JSON file. Keep a copy before big edits, and hand it to next year's officers.</p>
      <a class="btn primary" href="/api/admin/content">Download backup</a></div>
    <div class="panel"><h3>Restore from a backup</h3><p class="muted"><strong>Replaces</strong> all industries, timelines and programs with the file's contents (email formats are merged by firm name). Students' "done" checkmarks are cleared.</p>
      <form id="restore-form"><input type="file" accept=".json,application/json" name="file" required><button class="btn">Restore</button></form></div></div>`;
  $('#restore-form').onsubmit = (e) => {
    e.preventDefault();
    if (!confirm('Replace all timelines and programs with this file?')) return;
    busy(e.submitter, async () => {
      const bundle = JSON.parse(await e.target.file.files[0].text());
      const r = await api('POST', '/api/admin/content', bundle);
      state.industries = await api('GET', '/api/industries');
      toast(`Restored ${r.industries} industries, ${r.milestones} milestones, ${r.programs} programs`);
    });
  };
}

// ---------------- boot ----------------
if (location.hash.includes('verify=invalid')) setTimeout(() => ($('#auth-error').textContent = 'That confirmation link is invalid or was already used. Try logging in.'), 0);
api('GET', '/api/me').then((u) => { state.user = u; start(); }).catch(showAuth);
