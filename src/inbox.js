import { ImapFlow } from 'imapflow';
import { db, log, kv, addTask } from './db.js';
import { generateJSON, clip } from './llm.js';
import { gmailReady } from './mailer.js';
import { googleStatus, gmailRecent } from './google.js';

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

// Handles one inbox message: outreach replies, bounces, and application outcomes.
async function handleMessage({ from, subject, text }, companies) {
  if (/mailer-daemon|postmaster/.test(from)) {
    const to = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi)?.find((e) => db.prepare('SELECT 1 FROM contacts WHERE email = ?').get(e.toLowerCase()));
    if (to) {
      db.prepare(`UPDATE emails SET status='bounced' WHERE contact_id = (SELECT id FROM contacts WHERE email = ?) AND status = 'sent'`).run(to.toLowerCase());
      db.prepare(`UPDATE emails SET status='cancelled' WHERE contact_id = (SELECT id FROM contacts WHERE email = ?) AND status = 'scheduled'`).run(to.toLowerCase());
      log('email', `Bounced: ${to}`);
    }
    return;
  }
  const contact = db.prepare('SELECT * FROM contacts WHERE email = ?').get(from);
  if (contact) {
    db.prepare(`UPDATE emails SET status='replied', replied_at=datetime('now'), reply_snippet=? WHERE contact_id=? AND status='sent'`).run(text.slice(0, 280), contact.id);
    db.prepare(`UPDATE emails SET status='cancelled' WHERE contact_id=? AND status='scheduled'`).run(contact.id);
    if (/\b(stop|unsubscribe|remove me)\b/i.test(text.slice(0, 300))) {
      db.prepare('UPDATE contacts SET unsubscribed = 1 WHERE id = ?').run(contact.id);
      log('email', `${from} opted out`);
    } else {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(contact.job_id);
      addTask({ title: `Reply to ${contact.name || from} (${job?.company})`, detail: text.slice(0, 400), url: 'https://mail.google.com', priority: 1, jobId: contact.job_id });
      log('email', `Reply from ${from}`);
    }
    return;
  }
  const hay = `${from} ${subject} ${text.slice(0, 600)}`.toLowerCase();
  const job = companies.find((c) => (c.company_domain && from.endsWith(c.company_domain)) || (c.company.length > 3 && hay.includes(c.company.toLowerCase())));
  if (!job) return;
  const { category, summary } = await classify(subject, text, job.company);
  const map = { rejected: 'rejected', interview: 'interview', offer: 'offer' };
  if (map[category]) {
    db.prepare(`UPDATE applications SET status=?, notes=?, updated_at=datetime('now') WHERE job_id=?`).run(map[category], summary, job.id);
    log('status', `${job.company}: ${category} — ${summary}`);
    if (category !== 'rejected') addTask({ title: `${category === 'offer' ? 'Offer' : 'Interview'}: ${job.title} @ ${job.company}`, detail: summary, url: 'https://mail.google.com', priority: 1, jobId: job.id });
  }
}

const activeCompanies = () => db.prepare(`SELECT j.id, j.company, j.title, j.company_domain FROM jobs j JOIN applications a ON a.job_id = j.id
  WHERE a.status IN ('submitted','needs_review','manual','interview')`).all();

export async function checkInbox() {
  if (!gmailReady()) return;
  if (googleStatus().connected) {
    const since = kv.get('inboxSince', Date.now() - 7 * 864e5);
    const msgs = await gmailRecent(since);
    const companies = activeCompanies();
    for (const m of msgs.sort((a, b) => a.date - b.date)) await handleMessage(m, companies);
    kv.set('inboxSince', Math.max(since, ...msgs.map((m) => m.date + 1000)));
    return;
  }
  return checkInboxImap();
}

// App-password fallback (IMAP).
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
      await handleMessage({ from: (msg.envelope.from?.[0]?.address || '').toLowerCase(), subject: msg.envelope.subject || '', text: plainText(msg.source) }, companies);
    }
    kv.set('lastUid', maxUid);
  } finally {
    lock.release();
    await client.logout().catch(() => {});
  }
}
