'use strict';
// Calendar integration: RFC 5545 .ics export (works with Google, Outlook, Apple),
// a subscribable feed URL, and one-click "add to Google Calendar" links.

const icsDate = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const esc = (s) => String(s || '').replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');

// Lines longer than 75 octets must be folded (RFC 5545 §3.1).
function fold(line) {
  const out = [];
  let rest = line;
  while (Buffer.byteLength(rest) > 75) {
    let cut = 75;
    while (Buffer.byteLength(rest.slice(0, cut)) > 75) cut--;
    out.push(rest.slice(0, cut));
    rest = ' ' + rest.slice(cut);
  }
  out.push(rest);
  return out.join('\r\n');
}

function vevent(e, { attendee } = {}) {
  const start = new Date(e.starts_at);
  const end = new Date(start.getTime() + (e.duration_min || 30) * 60000);
  const lines = [
    'BEGIN:VEVENT',
    `UID:${e.uid}`,
    `DTSTAMP:${icsDate(e.created_at ? e.created_at.replace(' ', 'T') + 'Z' : Date.now())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${esc(e.title)}`,
    e.description && `DESCRIPTION:${esc(e.description)}`,
    e.location && `LOCATION:${esc(e.location)}`,
    `CATEGORIES:${e.kind === 'follow_up' ? 'Follow-up' : e.kind === 'deadline' ? 'Deadline' : 'Networking'}`,
    attendee && `ATTENDEE;CN=${esc(attendee.name)};ROLE=REQ-PARTICIPANT:mailto:${attendee.email}`,
    'BEGIN:VALARM', 'ACTION:DISPLAY', `DESCRIPTION:${esc(e.title)}`, `TRIGGER:-PT${e.kind === 'follow_up' ? 0 : 15}M`, 'END:VALARM',
    'END:VEVENT',
  ];
  return lines.filter(Boolean).map(fold).join('\r\n');
}

function toIcs(events, { name = 'Networking' } = {}) {
  return [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//FirmConnect//Networking Calendar//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', fold(`X-WR-CALNAME:${esc(name)}`),
    ...events.map((e) => vevent(e, { attendee: e.attendee })),
    'END:VCALENDAR', '',
  ].join('\r\n');
}

function googleCalendarLink(e) {
  const start = new Date(e.starts_at);
  const end = new Date(start.getTime() + (e.duration_min || 30) * 60000);
  const p = new URLSearchParams({
    action: 'TEMPLATE',
    text: e.title,
    dates: `${icsDate(start)}/${icsDate(end)}`,
    details: e.description || '',
    location: e.location || '',
  });
  if (e.attendee?.email) p.set('add', e.attendee.email);
  return `https://calendar.google.com/calendar/render?${p}`;
}

function outlookCalendarLink(e) {
  const start = new Date(e.starts_at);
  const end = new Date(start.getTime() + (e.duration_min || 30) * 60000);
  const p = new URLSearchParams({
    path: '/calendar/action/compose', rru: 'addevent', subject: e.title,
    startdt: start.toISOString(), enddt: end.toISOString(), body: e.description || '', location: e.location || '',
  });
  return `https://outlook.office.com/calendar/0/deeplink/compose?${p}`;
}

/** Add n business days (skipping Sat/Sun), keeping the time of day. */
function addBusinessDays(date, n) {
  const d = new Date(date);
  while (n > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const day = d.getUTCDay();
    if (day !== 0 && day !== 6) n--;
  }
  return d;
}

module.exports = { toIcs, googleCalendarLink, outlookCalendarLink, addBusinessDays, icsDate };
