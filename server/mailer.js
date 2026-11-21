'use strict';
// Sends account emails. With SMTP_URL set (e.g. smtps://user:pass@smtp.example.com) mail
// is sent through nodemailer; otherwise the message is printed to the server log, which
// is enough for local development.

let transport = null;
function getTransport() {
  if (!process.env.SMTP_URL) return null;
  if (!transport) transport = require('nodemailer').createTransport(process.env.SMTP_URL);
  return transport;
}

async function sendMail({ to, subject, text }) {
  const t = getTransport();
  if (!t) {
    console.log(`\n[mail] To: ${to}\n[mail] Subject: ${subject}\n${text}\n`);
    return { logged: true };
  }
  await t.sendMail({ from: process.env.MAIL_FROM || 'BBSA Career Hub <no-reply@localhost>', to, subject, text });
  return { sent: true };
}

module.exports = { sendMail };
