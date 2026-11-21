import nodemailer from 'nodemailer';
import { googleStatus, gmailSend } from './google.js';
import { config } from './config.js';
import { db, log, kv } from './db.js';
import { fill, template } from './documents.js';
import { generateJSON, clip } from './llm.js';

const P = config.profile;
// One-line intro for outreach emails, built from your profile (or set profile.pitch.<track> in config.json).
function trackPitch(track) {
  const custom = P.pitch?.[track];
  if (custom) return custom;
  const study = [P.major || P.degree, 'student'].filter(Boolean).join(' ');
  const parts = [];
  if (P.school) parts.push(`I'm a ${study} at ${P.school}`);
  if (P.currentTitle && P.currentEmployer) parts.push(`${parts.length ? 'most recently' : 'I\'m'} ${/^[aeiou]/i.test(P.currentTitle) ? 'an' : 'a'} ${P.currentTitle} at ${P.currentEmployer}`);
  return parts.length ? parts.join(', ') + '.' : '';
}

const appPasswordReady = () => Boolean(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD);
export const gmailReady = () => googleStatus().connected || appPasswordReady();
export const senderAddress = () => googleStatus().email || process.env.GMAIL_USER || '';
async function sendMail(mail) {
  if (googleStatus().connected) return gmailSend(mail);
  return getTransport().sendMail(mail);
}

// Used by Settings → Integrations → Test connection.
export async function verifyGmail(user, pass) {
  const t = nodemailer.createTransport({ service: 'gmail', auth: { user, pass } });
  await t.verify();
  return true;
}
let transport;
export const resetTransport = () => { transport = null; };
const getTransport = () => (transport ??= nodemailer.createTransport({
  service: 'gmail', auth: { user: process.env.GMAIL_USER, pass: process.env.GMAIL_APP_PASSWORD },
}));

function render(tplName, vars) {
  const text = fill(template(tplName), vars);
  const [first, ...rest] = text.split('\n');
  return { subject: first.replace(/^Subject:\s*/, '').trim(), body: rest.join('\n').trim() };
}

// Queue an intro email per contact (follow-ups are queued when the intro actually sends).
export async function scheduleOutreach(job, contacts, docs) {
  for (const c of contacts) {
    if (db.prepare('SELECT 1 FROM emails WHERE contact_id = ?').get(c.id)) continue;
    const first = (c.name || '').split(' ')[0] || 'there';
    const { personal_line } = await generateJSON(
      `Write ONE friendly, specific sentence (max 25 words) for a cold email to ${c.name || 'a recruiter'}${c.title ? ` (${c.title})` : ''} at ${job.company} about the ${job.title} role.
Reference something concrete from the job description. No flattery, no clichés, do not start with "I".
Job description: ${clip(job.description, 1200)}
Respond as JSON: {"personal_line": "..."}`,
      { personal_line: `The ${job.title} role lines up closely with the work I've been doing.` }, { maxTokens: 80 });

    const { subject, body } = render('email-intro.txt', {
      role: job.title, company: job.company, first_name: first, name: `${P.firstName} ${P.lastName}`,
      personal_line, track_pitch: trackPitch(docs.track), phone: P.phone,
      linkedin_line: P.linkedin ? `\n${P.linkedin}` : '',
    });
    db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, scheduled_at) VALUES (?, 'intro', ?, ?, datetime('now'))`).run(c.id, subject, body);
    log('email', `Queued intro → ${c.email} (${c.source}) for ${job.company}`);
  }
}

const sentToday = () => db.prepare(`SELECT COUNT(*) n FROM emails WHERE status IN ('sent','replied','bounced') AND date(sent_at, 'localtime') = date('now', 'localtime')`).get().n;

// Called every minute: sends at most one email if the drip rules allow it.
export async function dripTick() {
  const E = config.email;
  if (!E.enabled || !gmailReady() || kv.get('emailPaused', false)) return;
  const now = new Date();
  if (now.getHours() < E.sendWindow.startHour || now.getHours() >= E.sendWindow.endHour || [0, 6].includes(now.getDay())) return;
  if (sentToday() >= E.dailyCap) return;
  if (Date.now() < kv.get('nextSendAt', 0)) return;

  const e = db.prepare(`SELECT e.*, c.email AS to_email, c.job_id, c.name AS contact_name FROM emails e JOIN contacts c ON c.id = e.contact_id
    WHERE e.status = 'scheduled' AND e.scheduled_at <= datetime('now') AND c.unsubscribed = 0
    ORDER BY e.kind = 'followup' DESC, e.scheduled_at LIMIT 1`).get();
  if (!e) return;

  const app = db.prepare('SELECT resume_path FROM applications WHERE job_id = ?').get(e.job_id);
  const intro = e.kind === 'followup' ? db.prepare(`SELECT message_id FROM emails WHERE contact_id = ? AND kind = 'intro'`).get(e.contact_id) : null;
  try {
    const info = await sendMail({
      from: `${P.firstName} ${P.lastName} <${senderAddress()}>`,
      to: e.to_email, subject: e.subject, text: e.body,
      attachments: e.kind === 'intro' && app?.resume_path ? [{ path: app.resume_path }] : [],
      ...(intro?.message_id ? { inReplyTo: intro.message_id, references: intro.message_id } : {}),
    });
    db.prepare(`UPDATE emails SET status='sent', sent_at=datetime('now'), message_id=? WHERE id=?`).run(info.messageId, e.id);
    if (e.kind === 'intro') {
      const { subject, body } = render('email-followup.txt', {
        role: db.prepare('SELECT title FROM jobs WHERE id=?').get(e.job_id).title,
        company: db.prepare('SELECT company FROM jobs WHERE id=?').get(e.job_id).company,
        first_name: (e.contact_name || '').split(' ')[0] || 'there', name: `${P.firstName} ${P.lastName}`,
      });
      db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, scheduled_at) VALUES (?, 'followup', ?, ?, datetime('now', ?))`)
        .run(e.contact_id, subject, body, `+${E.followUpAfterDays} days`);
    }
    log('email', `Sent ${e.kind} → ${e.to_email}`);
  } catch (err) {
    db.prepare(`UPDATE emails SET status='failed', error=? WHERE id=?`).run(err.message.slice(0, 300), e.id);
    log('error', `send ${e.to_email}: ${err.message}`);
  }
  const gap = (E.minGapMinutes + Math.random() * (E.maxGapMinutes - E.minGapMinutes)) * 60_000;
  kv.set('nextSendAt', Date.now() + gap);
}
