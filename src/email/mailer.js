import nodemailer from 'nodemailer';
import { config } from '../core/config.js';
import { db, log, kv } from '../core/db.js';
import { fill, template } from '../apply/documents.js';
import { generateJSON, clip } from '../core/llm.js';

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
export const gmailReady = appPasswordReady;
export const senderAddress = () => process.env.GMAIL_USER || '';
const sendMail = (mail) => getTransport().sendMail(mail);

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

// Your own version from Settings → Email outreach wins over the built-in template.
export const emailTemplate = (kind) => config.email.templates?.[kind]?.trim() || template(`email-${kind}.txt`);
// Lines that make an email read like a mail merge are dropped, whatever the template says.
const ROBOTIC = /^(if you('d| would) prefer not to hear from me|reply ["“]?stop|to unsubscribe|this (email|message) was sent)/i;
function render(kind, vars) {
  const text = fill(emailTemplate(kind), vars).split('\n').filter((l) => !ROBOTIC.test(l.trim())).join('\n').replace(/\n{3,}/g, '\n\n');
  const [first, ...rest] = text.split('\n');
  return { subject: first.replace(/^Subject:\s*/, '').trim(), body: rest.join('\n').trim() };
}

// One specific sentence about what the team/company works on. Small models sometimes echo the prompt or talk
// about "applying", so bad lines are thrown out and a line built from the job analysis is used instead.
const BAD_LINE = /job description|apply|applying|application|interested in|excited|passion|opportunity|i am writing|\bdear\b|^[a-z]/i;
async function personalLine(job, c) {
  const a = (() => { try { return JSON.parse(db.prepare('SELECT analysis FROM applications WHERE job_id = ?').get(job.id)?.analysis || '{}'); } catch { return {}; } })();
  const out = await generateJSON(
    `Write ONE sentence (12-25 words) for a cold email to ${c.name || 'a recruiter'}${c.title ? ` (${c.title})` : ''} at ${job.company}.
The sentence names something concrete the ${job.company} team works on (a product, problem or customer from the description) and why that work appeals to the sender.
Rules: start with a capital letter; don't mention applying, the job description, excitement or passion; no flattery; plain words.
Example shape: "The way your team is rebuilding payouts for small businesses is the kind of problem I like working on."
Job: ${job.title}. Description: ${clip(job.description, 1200)}
Respond as JSON: {"line": "..."}`,
    { line: '' }, { temperature: 0.4, maxTokens: 90 });
  const line = String(out.line || '').replace(/^["'\s]+|["'\s]+$/g, '');
  if (line && !BAD_LINE.test(line) && line.split(/\s+/).length >= 8 && line.split(/\s+/).length <= 35) return /[.!?]$/.test(line) ? line : `${line}.`;
  const focus = String(a.company_focus || a.role_focus || '').replace(/\.$/, '');
  return focus ? `${job.company}'s work on ${focus.charAt(0).toLowerCase()}${focus.slice(1)} is exactly the kind of problem I want to spend my time on.`
    : `The ${job.title} role lines up closely with the work I've been doing.`;
}

// Queue an intro email per contact (follow-ups are queued when the intro actually sends).
// "Summer 2027 Tax Consulting Intern - Canada" reads better in an email as "Tax Consulting Intern".
export const shortRole = (t) => String(t || '').replace(/\s*[(\[].*?[)\]]/g, '').replace(/\s+[-–|]\s+.*$/, '').trim()
  .replace(/^((summer|fall|winter|spring)\s*)?20\d\d\s+/i, '')
  .replace(/,?\s*((summer|fall|winter|spring)\s*)?20\d\d\b.*$/i, '').replace(/,\s*(summer|fall|winter|spring)\s*$/i, '')
  .replace(/^(summer|fall|winter|spring)\s+/i, '').replace(/\s+/g, ' ').trim() || t;
export async function scheduleOutreach(job, contacts, docs) {
  for (const c of contacts) {
    if (db.prepare('SELECT 1 FROM emails WHERE contact_id = ?').get(c.id)) continue;
    const first = (c.name || '').split(' ')[0] || 'there';
    const personal_line = await personalLine(job, c);
    const { subject, body } = render('intro', {
      role: shortRole(job.title), company: job.company, first_name: first, name: `${P.firstName} ${P.lastName}`,
      personal_line, track_pitch: trackPitch(docs.track), phone: P.phone,
      linkedin_line: P.linkedin ? `\n${P.linkedin}` : '',
    });
    // Auto-send (the default): scheduled right away, editable on Outreach until it goes. Off: a draft that waits for you.
    const status = config.email.autoSend !== false ? 'scheduled' : 'draft';
    db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, status, scheduled_at) VALUES (?, 'intro', ?, ?, ?, datetime('now'))`).run(c.id, subject, body, status);
    log('email', `${status === 'draft' ? 'Drafted' : 'Queued'} intro → ${c.email} (${c.source}) for ${job.company}`);
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
    ORDER BY e.kind = 'reply' DESC, e.kind = 'followup' DESC, e.scheduled_at LIMIT 1`).get();
  if (!e) return;

  const app = db.prepare('SELECT resume_path FROM applications WHERE job_id = ?').get(e.job_id);
  const intro = e.kind === 'followup' ? db.prepare(`SELECT message_id FROM emails WHERE contact_id = ? AND kind = 'intro'`).get(e.contact_id) : null;
  const thread = e.kind === 'reply' ? e.in_reply_to : intro?.message_id;
  try {
    const info = await sendMail({
      from: `${P.firstName} ${P.lastName} <${senderAddress()}>`,
      to: e.to_email, subject: e.subject, text: e.body,
      attachments: e.kind === 'intro' && app?.resume_path ? [{ path: app.resume_path }] : [],
      ...(thread ? { inReplyTo: thread, references: thread } : {}),
    });
    db.prepare(`UPDATE emails SET status='sent', sent_at=datetime('now'), message_id=? WHERE id=?`).run(info.messageId, e.id);
    if (e.kind === 'intro') {
      const { body } = render('followup', {
        role: shortRole(db.prepare('SELECT title FROM jobs WHERE id=?').get(e.job_id).title),
        company: db.prepare('SELECT company FROM jobs WHERE id=?').get(e.job_id).company,
        first_name: (e.contact_name || '').split(' ')[0] || 'there', name: `${P.firstName} ${P.lastName}`,
      });
      // Same subject with "Re:", so it lands in the same thread as the intro.
      db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, scheduled_at) VALUES (?, 'followup', ?, ?, datetime('now', ?))`)
        .run(e.contact_id, `Re: ${e.subject.replace(/^re:\s*/i, '')}`, body, `+${E.followUpAfterDays} days`);
    }
    log('email', `Sent ${e.kind} → ${e.to_email}`);
  } catch (err) {
    db.prepare(`UPDATE emails SET status='failed', error=? WHERE id=?`).run(err.message.slice(0, 300), e.id);
    log('error', `send ${e.to_email}: ${err.message}`);
  }
  const gap = (E.minGapMinutes + Math.random() * (E.maxGapMinutes - E.minGapMinutes)) * 60_000;
  kv.set('nextSendAt', Date.now() + gap);
}

// Someone answered your outreach: draft a short reply in your voice. With auto-reply on it's queued to send;
// otherwise it waits on Outreach for you to read, edit and send.
export async function draftReply(contact, job, { subject, text, messageId }) {
  const out = await generateJSON(
    `You are ${P.firstName} ${P.lastName}, a student who applied for "${job?.title}" at ${job?.company}. ${contact.name || 'Someone'}${contact.title ? ` (${contact.title})` : ''} replied to your outreach email:
---
${clip(text, 1500)}
---
Write your reply: warm, brief (40-110 words), plain words, sounds like a real person. Answer what they asked. If they offer a call, say you're glad to and that you're flexible on timing (don't invent specific times). If they say no or point elsewhere, thank them. Never invent facts about yourself.
Sign off with just "${P.firstName}".
Respond as JSON: {"body": "..."}`,
    { body: '' }, { temperature: 0.4, maxTokens: 260 });
  const body = String(out.body || '').trim();
  if (body.split(/\s+/).length < 8) return null;
  const status = config.email.autoReply ? 'scheduled' : 'draft';
  db.prepare(`INSERT INTO emails (contact_id, kind, subject, body, status, scheduled_at, in_reply_to) VALUES (?, 'reply', ?, ?, ?, datetime('now'), ?)`)
    .run(contact.id, `Re: ${String(subject || '').replace(/^re:\s*/i, '')}`, body, status, messageId || null);
  log('email', `${status === 'draft' ? 'Drafted' : 'Queued'} a reply to ${contact.name || contact.email}`);
  return status;
}
