'use strict';
// Small built-in reference lists. For production, swap DISPOSABLE for a maintained
// list such as https://github.com/disposable-email-domains/disposable-email-domains.

const DISPOSABLE = new Set([
  'mailinator.com', 'guerrillamail.com', 'guerrillamail.net', '10minutemail.com', 'tempmail.com', 'temp-mail.org',
  'throwawaymail.com', 'yopmail.com', 'trashmail.com', 'getnada.com', 'sharklasers.com', 'dispostable.com',
  'maildrop.cc', 'fakeinbox.com', 'mintemail.com', 'mohmal.com', 'emailondeck.com', 'burnermail.io', 'mailnesia.com',
  'tempail.com', 'spamgourmet.com', 'mytemp.email', 'tempr.email', 'discard.email', 'moakt.com',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'googlemail.com', 'yahoo.com', 'ymail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'aol.com', 'icloud.com', 'me.com', 'mac.com', 'proton.me', 'protonmail.com', 'gmx.com', 'gmx.net', 'zoho.com',
  'yandex.com', 'mail.com', 'fastmail.com', 'hey.com',
]);

const ROLE_LOCALS = new Set([
  'admin', 'administrator', 'info', 'contact', 'hello', 'hr', 'jobs', 'careers', 'recruiting', 'recruitment', 'talent',
  'support', 'help', 'sales', 'marketing', 'press', 'media', 'office', 'team', 'billing', 'accounts', 'noreply',
  'no-reply', 'donotreply', 'postmaster', 'webmaster', 'abuse', 'security', 'legal', 'compliance', 'privacy', 'enquiries',
  'inquiries', 'feedback', 'events', 'investor', 'investors', 'ir', 'service', 'mail',
]);

// MX host suffix -> provider name. Enterprise-grade hosting is a mild trust signal.
const MX_PROVIDERS = [
  ['google.com', 'Google Workspace'], ['googlemail.com', 'Google Workspace'],
  ['protection.outlook.com', 'Microsoft 365'], ['outlook.com', 'Microsoft 365'],
  ['pphosted.com', 'Proofpoint'], ['ppe-hosted.com', 'Proofpoint'], ['mimecast.com', 'Mimecast'],
  ['barracudanetworks.com', 'Barracuda'], ['iphmx.com', 'Cisco Secure Email'], ['messagelabs.com', 'Broadcom Email Security'],
  ['zoho.com', 'Zoho Mail'], ['yahoodns.net', 'Yahoo'], ['icloud.com', 'iCloud'],
];

// Commonly mistyped domains -> intended domain.
const TYPOS = {
  'gmial.com': 'gmail.com', 'gmai.com': 'gmail.com', 'gamil.com': 'gmail.com', 'gnail.com': 'gmail.com', 'gmail.co': 'gmail.com',
  'gmail.con': 'gmail.com', 'hotmial.com': 'hotmail.com', 'hotmai.com': 'hotmail.com', 'yaho.com': 'yahoo.com',
  'yahooo.com': 'yahoo.com', 'outlok.com': 'outlook.com', 'outloo.com': 'outlook.com', 'iclod.com': 'icloud.com',
};

module.exports = { DISPOSABLE, FREE_PROVIDERS, ROLE_LOCALS, MX_PROVIDERS, TYPOS };
