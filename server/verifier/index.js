'use strict';
// Email verification + reputation scoring, modelled on how tools like RocketReach grade
// addresses: a deliverability verdict (valid / accept-all / risky / invalid / unknown),
// a 0-99 confidence score with a letter grade, and a separate domain-reputation rating.

const { DISPOSABLE, FREE_PROVIDERS, ROLE_LOCALS, MX_PROVIDERS, TYPOS } = require('./lists');
const { defaultResolver } = require('./resolvers');
const { detectPattern } = require('../patterns');

// Pragmatic RFC 5322 subset: what real mail servers accept in practice.
const EMAIL_RE = /^(?!\.)(?!.*\.\.)([a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64})(?<!\.)@((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9][a-z0-9-]{0,61}[a-z0-9])$/i;

const GRADES = [[90, 'A+'], [80, 'A'], [70, 'B'], [55, 'C'], [35, 'D'], [0, 'F']];
const grade = (score) => GRADES.find(([min]) => score >= min)[1];

function mxProvider(hosts) {
  for (const h of hosts) {
    const hit = MX_PROVIDERS.find(([suffix]) => h.toLowerCase().endsWith(suffix));
    if (hit) return hit[1];
  }
  return null;
}

/**
 * @param {string} rawEmail
 * @param {object} [opts]
 * @param {object} [opts.resolver]   DNS/SMTP backend (see resolvers.js)
 * @param {boolean} [opts.smtp]      attempt a live SMTP RCPT probe (needs outbound port 25)
 * @param {object} [opts.context]    what we know from the database:
 *   { firstName, lastName, companyDomain, companyPattern: {dominant, confidence, sample}, lastVerifiedAt }
 */
async function verifyEmail(rawEmail, opts = {}) {
  const resolver = opts.resolver || defaultResolver();
  const smtp = opts.smtp ?? process.env.SMTP_PROBE !== 'off';
  const ctx = opts.context || {};
  const email = String(rawEmail || '').trim().toLowerCase();
  const checks = [];
  const add = (id, label, status, detail, points = 0) => checks.push({ id, label, status, detail, points });

  let score = 40;       // neutral prior before any evidence
  let rep = 50;         // domain reputation, scored independently of the mailbox
  let cap = 99;         // hard ceiling imposed by disqualifying signals
  let verdict = null;   // set by decisive evidence (SMTP answer, missing MX, ...)
  let suggestion = null;

  const finish = () => {
    const pts = checks.reduce((s, c) => s + c.points, 0);
    const final = Math.max(0, Math.min(cap, Math.round(score + pts)));
    const status = verdict || (final >= 70 ? 'likely_valid' : final >= 40 ? 'risky' : 'invalid');
    const reputation = Math.max(0, Math.min(100, Math.round(rep)));
    return {
      email,
      status,
      score: final,
      grade: grade(final),
      reputation: { score: reputation, label: reputation >= 75 ? 'High' : reputation >= 50 ? 'Medium' : 'Low' },
      suggestion,
      checks,
      resolver: resolver.for ? resolver.for(email.split('@')[1] || '') : resolver.name,
      checkedAt: new Date().toISOString(),
    };
  };

  // 1. Syntax
  const m = EMAIL_RE.exec(email);
  if (!m) {
    add('syntax', 'Syntax', 'fail', 'Not a valid email address format.');
    cap = 0; verdict = 'invalid'; rep = 0;
    return finish();
  }
  const [, local, domain] = m;
  add('syntax', 'Syntax', 'pass', 'Address is well-formed.');

  // 2. Typos of popular domains
  if (TYPOS[domain]) {
    suggestion = `${local}@${TYPOS[domain]}`;
    add('typo', 'Domain typo', 'fail', `Looks like a typo of ${TYPOS[domain]}.`, -30);
    rep -= 30;
  }

  // 3. Disposable / free / role
  if (DISPOSABLE.has(domain)) {
    add('disposable', 'Disposable domain', 'fail', 'Temporary inbox provider; not a real professional address.');
    cap = 10; rep = 0; verdict = 'invalid';
  }
  const isFree = FREE_PROVIDERS.has(domain);
  if (isFree) {
    add('free', 'Free provider', 'info', 'Personal webmail address (not a corporate inbox).');
  }
  const baseLocal = local.split('+')[0];
  if (ROLE_LOCALS.has(baseLocal)) {
    add('role', 'Role-based inbox', 'warn', `"${baseLocal}@" is a shared team inbox, not a person.`, -15);
  }

  // 4. Company match (from the contact's firm in the database)
  if (ctx.companyDomain) {
    if (domain === ctx.companyDomain.toLowerCase()) {
      add('company_domain', 'Company domain', 'pass', `Matches the firm's domain (${ctx.companyDomain}).`, 5);
    } else {
      add('company_domain', 'Company domain', 'warn', `Firm's domain is ${ctx.companyDomain}; this address is on ${domain}.`, isFree ? -10 : -15);
    }
  }

  // 5. Naming pattern vs. the firm's learned convention
  const pat = ctx.companyPattern;
  if (pat?.dominant && ctx.firstName && ctx.lastName) {
    const used = detectPattern(email, ctx.firstName, ctx.lastName);
    const strong = pat.sample >= 3 && pat.confidence >= 0.6;
    if (used === pat.dominant) {
      add('pattern', 'Naming pattern', 'pass', `Follows the firm's ${pat.dominant}@ convention (${Math.round(pat.confidence * 100)}% of known staff).`, Math.round(15 * pat.confidence));
    } else if (strong) {
      add('pattern', 'Naming pattern', 'warn', `Firm mostly uses ${pat.dominant}@ but this is ${used ? used + '@' : 'a non-standard format'}.`, -15);
    } else {
      add('pattern', 'Naming pattern', 'info', 'Not enough data to judge the firm\'s naming convention.');
    }
  }

  // 6. DNS: MX, SPF, DMARC
  let mx = [];
  try {
    mx = (await resolver.resolveMx(domain)).sort((a, b) => a.priority - b.priority);
  } catch (err) {
    add('mx', 'Mail server (MX)', 'skip', `DNS lookup failed: ${err.code || err.message}`);
  }
  if (mx.length) {
    const provider = mxProvider(mx.map((r) => r.exchange));
    add('mx', 'Mail server (MX)', 'pass', `${mx.length} MX record(s): ${mx.slice(0, 2).map((r) => r.exchange).join(', ')}`, 15);
    rep += 10;
    if (provider) { add('mx_provider', 'Mail provider', 'info', `Hosted by ${provider}.`, 3); rep += 5; }
  } else if (!checks.some((c) => c.id === 'mx')) {
    const a = await resolver.resolveA(domain).catch(() => []);
    if (a.length) {
      add('mx', 'Mail server (MX)', 'warn', 'No MX record; mail would fall back to the A record, which is unusual.', -20);
      rep -= 20;
    } else {
      add('mx', 'Mail server (MX)', 'fail', 'Domain has no mail server, so mail to it will bounce.');
      cap = 0; verdict = 'invalid'; rep = 0;
      return finish();
    }
  }

  const txt = (await resolver.resolveTxt(domain).catch(() => [])).map((r) => r.join(''));
  if (txt.some((t) => t.toLowerCase().startsWith('v=spf1'))) {
    add('spf', 'SPF record', 'pass', 'Domain publishes an SPF policy.', 3); rep += 10;
  } else {
    add('spf', 'SPF record', 'warn', 'No SPF record; weak sign of a professionally managed domain.', -3); rep -= 10;
  }
  const dmarcTxt = (await resolver.resolveTxt(`_dmarc.${domain}`).catch(() => [])).map((r) => r.join(''))
    .find((t) => t.toLowerCase().startsWith('v=dmarc1'));
  const policy = dmarcTxt && (/;\s*p=(\w+)/i.exec(dmarcTxt) || [])[1]?.toLowerCase();
  if (policy === 'reject' || policy === 'quarantine') {
    add('dmarc', 'DMARC policy', 'pass', `Enforced DMARC (p=${policy}).`, 4); rep += 20;
  } else if (dmarcTxt) {
    add('dmarc', 'DMARC policy', 'info', 'DMARC published but not enforced (p=none).', 1); rep += 8;
  } else {
    add('dmarc', 'DMARC policy', 'warn', 'No DMARC record.', -2); rep -= 10;
  }
  if (isFree) rep = Math.max(rep, 60); // big webmail providers are reputable domains, just not corporate

  // 7. SMTP mailbox probe
  if (verdict !== 'invalid' && mx.length) {
    if (!smtp) {
      add('smtp', 'Mailbox check (SMTP)', 'skip', 'SMTP probing disabled; result is based on DNS and data signals only.');
    } else {
      const r = await resolver.smtpProbe(mx[0].exchange, email).catch((err) => ({ code: null, error: err.message }));
      if (r.code == null) {
        add('smtp', 'Mailbox check (SMTP)', 'skip', `Could not reach mail server: ${r.error}.`);
      } else if (r.code >= 500) {
        add('smtp', 'Mailbox check (SMTP)', 'fail', `Server rejected the mailbox (${r.code} ${r.message}).`);
        cap = 5; verdict = 'invalid';
      } else if (r.code >= 400) {
        add('smtp', 'Mailbox check (SMTP)', 'warn', `Temporary failure / greylisting (${r.code}).`, -5);
      } else if (r.catchAllCode && r.catchAllCode < 300) {
        add('smtp', 'Mailbox check (SMTP)', 'warn', 'Server accepts mail for any address (catch-all), so the mailbox can\'t be confirmed.', 5);
        cap = Math.min(cap, 79); verdict = 'accept_all';
      } else {
        add('smtp', 'Mailbox check (SMTP)', 'pass', 'Mail server confirmed this mailbox exists.', 30);
        verdict = 'valid';
      }
    }
  }

  // 8. Freshness of our own record
  if (ctx.lastVerifiedAt) {
    const days = (Date.now() - Date.parse(ctx.lastVerifiedAt)) / 864e5;
    if (days > 365) add('freshness', 'Record freshness', 'warn', `Last verified ${Math.round(days)} days ago.`, -5);
  }

  if (verdict === 'invalid' && cap > 10) cap = 10;
  return finish();
}

module.exports = { verifyEmail, grade, EMAIL_RE };
