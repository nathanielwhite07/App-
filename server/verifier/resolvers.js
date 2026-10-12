'use strict';
const dns = require('node:dns').promises;
const net = require('node:net');
const crypto = require('node:crypto');

const DNS_MISS = new Set(['ENOTFOUND', 'ENODATA', 'ESERVFAIL', 'NXDOMAIN', 'ENONAME']);
const quietly = async (p) => {
  try { return await p; } catch (err) { if (DNS_MISS.has(err.code)) return []; throw err; }
};

/**
 * Talk SMTP to `mxHost` up to RCPT TO and hang up without sending mail.
 * Resolves { code, message } for the target address and { catchAllCode } for a random one.
 * Many networks (including most cloud hosts and home ISPs) block outbound port 25; in that
 * case this resolves { code: null, error } and the verifier treats the mailbox as unknown.
 */
function smtpProbe(mxHost, email, { heloDomain = process.env.SMTP_HELO_DOMAIN || 'verifier.local', timeoutMs = 8000 } = {}) {
  const domain = email.split('@')[1];
  const randomAddr = `zz-${crypto.randomBytes(6).toString('hex')}@${domain}`;
  const script = [
    `EHLO ${heloDomain}`,
    `MAIL FROM:<probe@${heloDomain}>`,
    `RCPT TO:<${email}>`,
    `RCPT TO:<${randomAddr}>`,
    'QUIT',
  ];
  return new Promise((resolve) => {
    const replies = [];
    let buf = '';
    let step = -1; // -1 = waiting for banner
    const socket = net.createConnection({ host: mxHost, port: 25 });
    const done = (result) => { socket.destroy(); resolve(result); };
    socket.setTimeout(timeoutMs, () => done({ code: null, error: 'timeout (port 25 may be blocked)' }));
    socket.on('error', (err) => done({ code: null, error: err.code || err.message }));
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      // A complete reply ends with a line "NNN text" (space, not dash, after the code).
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) {
        if (!/^\d{3} /.test(line)) continue;
        const code = Number(line.slice(0, 3));
        replies.push({ code, message: line.slice(4) });
        if (step === -1 && code !== 220) return done({ code: null, error: `banner ${line}` });
        if (step === 0 && code !== 250) return done({ code: null, error: `EHLO rejected: ${line}` });
        if (step === 1 && code !== 250) return done({ code: null, error: `MAIL FROM rejected: ${line}` });
        if (step === 3) {
          const target = replies[replies.length - 2];
          return done({ code: target.code, message: target.message, catchAllCode: code });
        }
        step++;
        socket.write(script[step] + '\r\n');
      }
    });
  });
}

const liveResolver = {
  name: 'live',
  resolveMx: (domain) => quietly(dns.resolveMx(domain)),
  resolveTxt: (name) => quietly(dns.resolveTxt(name)),
  resolveA: (domain) => quietly(dns.resolve4(domain)),
  smtpProbe,
};

/** Resolver backed by demo-dns.json so the fictional seed domains can be verified offline. */
function demoResolver(table = require('../seed/demo-dns.json')) {
  const mailboxes = new Set(table.mailboxes.map((m) => m.toLowerCase()));
  const get = (d) => table.domains[d.toLowerCase()];
  return {
    name: 'demo',
    handles: (domain) => domain.toLowerCase().endsWith('.example') || domain.toLowerCase().endsWith('.examp1e'),
    async resolveMx(domain) {
      const d = get(domain);
      return d ? d.mx.map((exchange, i) => ({ exchange, priority: (i + 1) * 10 })) : [];
    },
    async resolveTxt(name) {
      if (name.startsWith('_dmarc.')) {
        const d = get(name.slice(7));
        return d?.dmarc ? [[`v=DMARC1; p=${d.dmarc}`]] : [];
      }
      const d = get(name);
      return d?.spf ? [['v=spf1 include:_spf.example ~all']] : [];
    },
    async resolveA(domain) { return get(domain) ? ['192.0.2.10'] : []; },
    async smtpProbe(_mx, email) {
      const d = get(email.split('@')[1]);
      if (d?.catchAll) return { code: 250, message: 'OK', catchAllCode: 250 };
      return mailboxes.has(email.toLowerCase())
        ? { code: 250, message: 'Recipient OK', catchAllCode: 550 }
        : { code: 550, message: 'No such user', catchAllCode: 550 };
    },
  };
}

/** Route .example domains to the demo resolver and everything else to live DNS. */
function defaultResolver() {
  const demo = demoResolver();
  const pick = (domain) => (demo.handles(domain) ? demo : liveResolver);
  return {
    name: 'auto',
    for: (domain) => pick(domain).name,
    resolveMx: (d) => pick(d).resolveMx(d),
    resolveTxt: (n) => pick(n.replace(/^_dmarc\./, '')).resolveTxt(n),
    resolveA: (d) => pick(d).resolveA(d),
    smtpProbe: (mx, email) => pick(email.split('@')[1]).smtpProbe(mx, email),
  };
}

module.exports = { liveResolver, demoResolver, defaultResolver, smtpProbe };
