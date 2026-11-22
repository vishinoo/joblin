import { ImapFlow } from 'imapflow';
import { db, log, kv, addTask } from '../core/db.js';
import { generateJSON, clip } from '../core/llm.js';
import { gmailReady, draftReply } from './mailer.js';
import { nextPattern } from './finder.js';
import { renderEmail } from './people.js';
import { gmailWebStatus, gmailWebRecent, gmailWebOpen } from './gmailWeb.js';

function plainText(source) {
  const s = source.toString('utf8');
  const body = s.slice(s.indexOf('\r\n\r\n') + 4);
  return body.replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ').replace(/=\r?\n/g, '').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 3000);
}

async function classify(subject, text, company) {
  return generateJSON(
    `Classify this email about a job application at ${company}.
Subject: ${subject}
Body: ${clip(text, 1500)}
Categories: "rejected" (not moving forward), "interview" (wants to schedule a call/interview/assessment), "offer" (job offer), "received" (application confirmation), "other".
Respond as JSON: {"category": "...", "summary": "one short sentence"}`,
    { category: 'other', summary: subject }, { temperature: 0 });
}

// A guessed address bounced: try the person's next most likely address (up to 3 patterns), re-sending the intro.
function retryNextAddress(email) {
  const c = db.prepare('SELECT * FROM contacts WHERE email = ?').get(email);
  if (!c || !c.pattern || !c.name) return;
  const tried = JSON.parse(c.tried || '[]');
  const domain = email.split('@')[1];
  if (tried.length >= 3) return log('email', `${c.name}: no working address after ${tried.length} tries`);
  let pattern = nextPattern(tried), next = '';
  while (pattern) { tried.push(pattern); next = renderEmail(pattern, c.name, domain); if (next && !db.prepare('SELECT 1 FROM contacts WHERE email = ?').get(next)) break; next = ''; pattern = nextPattern(tried); }
  if (!next) return;
  const intro = db.prepare(`SELECT subject, body FROM emails WHERE contact_id = ? AND kind = 'intro' ORDER BY id DESC`).get(c.id);
  db.prepare('UPDATE contacts SET email = ?, pattern = ?, tried = ? WHERE id = ?').run(next, pattern, JSON.stringify(tried), c.id);
  if (intro) db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, scheduled_at) VALUES (?, 'intro', ?, ?, datetime('now'))`).run(c.id, intro.subject, intro.body);
  log('email', `Trying ${next} for ${c.name} instead`);
}

// Handles one inbox message: outreach replies, bounces, and application outcomes.
async function handleMessage({ from, subject, text, messageId }, companies) {
  if (/mailer-daemon|postmaster/.test(from)) {
    const to = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.find((e) => db.prepare('SELECT 1 FROM contacts WHERE email = ?').get(e.toLowerCase()));
    if (to) {
      db.prepare(`UPDATE emails SET status='bounced' WHERE contact_id = (SELECT id FROM contacts WHERE email = ?) AND status = 'sent'`).run(to.toLowerCase());
      db.prepare(`UPDATE emails SET status='cancelled' WHERE contact_id = (SELECT id FROM contacts WHERE email = ?) AND status = 'scheduled'`).run(to.toLowerCase());
      log('email', `Bounced: ${to}`);
      retryNextAddress(to.toLowerCase());
    }
    return;
  }
  const contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(from);
  if (contact) {
    db.prepare(`UPDATE emails SET status='replied', replied_at=datetime('now'), reply_snippet=?, seen=0 WHERE contact_id=? AND status='sent'`).run(text.slice(0, 600), contact.id);
    db.prepare(`UPDATE emails SET status='cancelled' WHERE contact_id=? AND status='scheduled'`).run(contact.id);
    if (/\b(stop|unsubscribe|remove me)\b/i.test(text.slice(0, 300))) {
      db.prepare('UPDATE contacts SET unsubscribed = 1 WHERE id = ?').run(contact.id);
      log('email', `${from} opted out`);
    } else {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(contact.job_id);
      log('email', `Reply from ${from}`);
      await draftReply(contact, job, { subject, text, messageId }).catch((e) => log('error', `reply draft: ${e.message}`));
    }
    return;
  }
  const job = matchJob(from, subject, text, companies);
  if (!job) return;
  // The model's label only counts when the email itself says so in plain words (no "rejections" from newsletters).
  const { category, summary } = await classify(subject, text, job.company);
  const said = `${subject}\n${text.slice(0, 2500)}`;
  const EVIDENCE = {
    rejected: /unfortunately|not (be )?(moving|move) forward|decided to (pursue|move forward with) other|not been selected|won.t be (moving|proceeding)|regret to inform|position has been filled|other candidates/i,
    interview: /interview|phone screen|schedule (a|some) time|your availability|next steps? in (our|the) (hiring|interview) process|online assessment|coding (challenge|assessment)|hirevue|codesignal|hackerrank/i,
    offer: /offer letter|pleased to offer|extend (you )?an offer|job offer/i,
  };
  if (!EVIDENCE[category]?.test(said)) return;
  db.prepare(`UPDATE applications SET status=?, notes=?, updated_at=datetime('now') WHERE job_id=?`).run(category, `From your inbox: ${subject}`.slice(0, 300), job.id);
  log('status', `${job.company}: ${category} — “${subject}” (from ${from})`);
  if (category !== 'rejected') addTask({ title: `${category === 'offer' ? 'Offer' : 'Interview'}: ${job.title} @ ${job.company}`, detail: summary, url: 'https://mail.google.com', priority: 1, jobId: job.id });
}

// Which application an email is about. Only emails from the company (its domain) or from a hiring system
// (Greenhouse, Lever, Workday…) count, and the company has to be named as a whole word in the sender or subject.
// Newsletters and promos that merely mention a company name never match.
const HIRING_SENDERS = /greenhouse|lever\.co|ashbyhq|myworkday|workday|icims|taleo|smartrecruiters|jobvite|successfactors|bamboohr|workable|recruitee|hirevue|codesignal|hackerrank|jobs-noreply@linkedin|careers|recruit|talent|hiring|no-?reply/i;
const word = (name) => new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
export function matchJob(from, subject, text, companies) {
  const fromCo = companies.find((c) => c.company_domain && from.toLowerCase().endsWith(`@${c.company_domain}`) || (c.company_domain && from.toLowerCase().endsWith(`.${c.company_domain}`)));
  if (fromCo) return fromCo;
  if (!HIRING_SENDERS.test(from)) return null;
  const named = companies.filter((c) => c.company.length > 2 && (word(c.company).test(subject) || word(c.company).test(from.split('@')[0])));
  if (named.length === 1) return named[0];
  // Several jobs at the same company: the one whose title is in the email.
  return named.find((c) => text.toLowerCase().includes(c.title.toLowerCase().slice(0, 30))) || named[0] || null;
}

const activeCompanies = () => db.prepare(`SELECT j.id, j.company, j.title, j.company_domain FROM jobs j JOIN applications a ON a.job_id = j.id
  WHERE a.status IN ('submitted','needs_review','manual','interview')`).all();

export async function checkInbox() {
  if (!gmailReady()) return;
  return checkInboxImap();
}

// Reads new mail over IMAP with your app password.
async function checkInboxImap() {
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false,
    auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  try {
    const lastUid = kv.get('lastUid', 0);
    const range = lastUid ? `${lastUid + 1}:*` : null;
    const query = range ? { uid: range } : { since: new Date(Date.now() - 7 * 864e5) };
    const companies = activeCompanies();
    let maxUid = lastUid;

    for await (const msg of client.fetch(range || query, { envelope: true, source: { start: 0, maxLength: 40000 }, uid: true }, { uid: Boolean(range) })) {
      if (msg.uid <= lastUid) continue;
      maxUid = Math.max(maxUid, msg.uid);
      await handleMessage({ from: (msg.envelope.from?.[0]?.address || '').toLowerCase(), subject: msg.envelope.subject || '', text: plainText(msg.source), messageId: msg.envelope.messageId }, companies);
    }
    kv.set('lastUid', maxUid);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}

// ---------- Verification codes ----------
// Some job sites (Greenhouse) email an 8-character code before they accept an application.
// Joblin reads it from your inbox (app password, or Gmail signed in inside Joblin's browser) and types it in.
async function recentMessages(sinceMs) {
  if (!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD)) return [];
  const client = new ImapFlow({ host: 'imap.gmail.com', port: 993, secure: true, logger: false, auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD } });
  await client.connect();
  const lock = await client.getMailboxLock('INBOX');
  const out = [];
  try {
    for await (const m of client.fetch({ since: new Date(sinceMs - 864e5) }, { envelope: true, source: { start: 0, maxLength: 30000 }, internalDate: true }))
      if (+m.internalDate >= sinceMs - 60e3) out.push({ from: (m.envelope.from?.[0]?.address || '').toLowerCase(), subject: m.envelope.subject || '', text: plainText(m.source), date: +m.internalDate });
  } finally { lock.release(); await client.logout().catch(() => {}); }
  return out;
}
// Codes can be read with an app password or with Gmail signed in inside Joblin's browser.
export const canReadInbox = () => gmailReady() || gmailWebStatus().connected;
const CODE_MAIL = /greenhouse|security code|verification code|verify|one-time|passcode/i;
// The code is the first token of the right length after the word "code" that looks generated:
// it has a digit or a capital letter after the first character (so "Security" or "password" never match).
export function findCode(text, length = 8) {
  const i = String(text).search(/code/i); if (i < 0) return null;
  return (String(text).slice(i).match(new RegExp(`\\b[A-Za-z0-9]{${length}}\\b`, 'g')) || []).find((t) => /\d/.test(t) || /[A-Z]/.test(t.slice(1))) || null;
}
export async function waitForCode({ company = '', sinceMs = Date.now() - 120e3, timeoutMs = 180e3, length = 8 } = {}) {
  const until = Date.now() + timeoutMs;
  const find = (text) => findCode(text, length);
  const opened = new Set();
  while (Date.now() < until) {
    const viaWeb = !gmailReady() && gmailWebStatus().connected;
    const msgs = await (viaWeb ? gmailWebRecent(sinceMs) : recentMessages(sinceMs)).catch(() => []);
    for (const m of msgs.sort((a, b) => b.date - a.date)) {
      if (!CODE_MAIL.test(`${m.from} ${m.subject} ${m.text}`)) continue;
      if (company && !new RegExp(company.split(/\s+/)[0], 'i').test(`${m.subject} ${m.text}`) && !/greenhouse/i.test(m.from)) continue;
      const code = find(`${m.subject} ${m.text}`);
      if (code) return code;
      // The feed only shows a preview; open the message once to read the whole thing.
      if (viaWeb && m.link && !opened.has(m.link)) { opened.add(m.link); const full = find(await gmailWebOpen(m).catch(() => '')); if (full) return full; }
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
  return null;
}
