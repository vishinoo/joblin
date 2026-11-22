import nodemailer from 'nodemailer';
import { config } from '../core/config.js';
import { db, log, kv } from '../core/db.js';
import { fill, template } from '../apply/documents.js';
import { generateJSON, clip } from '../core/llm.js';
import { positionsOf, readResume, roleKey, rolePrefs } from '../you/profile.js';
import { tracks, trackLabel } from '../you/tracks.js';

const P = config.profile;
// Fallback intro when the written one doesn't pass the checks: built from your profile.
function trackPitch() {
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

// ---------- The two personal sentences in each intro ----------
// pitch: who you are, leading with the experience that fits THIS job's field. Built from your resumes, not
//        written by the model, so it's always true and always reads the same way: software and data roles
//        lead with your software work and projects, finance roles with your finance work.
// line:  one sentence the model writes about what the company works on (checked, with a safe fallback).
const TECH_TITLE = /\b(software|engineer\w*|developer|data|machine learning|ml|ai|analytics|scien\w*|product|technical|devops|cloud|security|backend|front-?end|full.?stack|mobile|ios|android|it)\b/i;
const FIN_TITLE = /\b(tax|account\w*|audit\w*|financ\w*|bank\w*|invest\w*|treasury|risk|actuar\w*|credit|equity|capital|wealth|insurance|consult\w*|valuation|m&a|trading|asset|cpa|bookkeep\w*|payable|receivable)\b/i;
const FIN_TRACK = /finance|bank|account|consult|business|audit|tax|invest/i;
export function jobField(job, track = '') {
  const t = String(job.title || ''), tech = TECH_TITLE.test(t), fin = FIN_TITLE.test(t);
  if (tech && !fin) return 'tech';
  if (fin && !tech) return 'finance';
  return FIN_TRACK.test(`${track} ${trackLabel(track)}`) ? 'finance' : 'tech';
}
const fieldOf = (trackId) => (FIN_TRACK.test(`${trackId} ${trackLabel(trackId)}`) ? 'finance' : 'tech');
const article = (w) => (/^[aeiou]/i.test(w) ? 'an' : 'a');
// "ARGUS – AI Emergency Response Platform" → "ARGUS, an AI emergency response platform"
const nameAndWhat = (org) => {
  const [name, what] = String(org).split(/\s+[–—-]\s+/);
  if (!what) return name;
  const w = what.split(' ').map((x) => (/^[A-Z0-9&]{2,}$/.test(x) ? x : x.toLowerCase())).join(' ');
  return `${name}, ${article(w)} ${w}`;
};
function phrase(p) {
  const now = p.current ? 'is' : 'was';
  if (p.kind === 'project') return `${/found/i.test(p.role) ? 'founded' : 'built'} ${nameAndWhat(p.org)}`;
  if (p.kind === 'leadership') return `${now} ${p.role} for the ${p.org.replace(/^the\s+/i, '')}`;
  // Work: what you did there, from the first bullet ("Developed internal software tools for…" → "developed internal software tools").
  const did = String(p.bullets?.[0] || '').match(/^([A-Z][a-z]+ed)\s+([^,;.]+?)(?:\s+(?:for|across|to|that|which|using|with|by|in)\b|[,;.]|$)/);
  if (did && did[2].split(' ').length <= 6) return `${did[1].toLowerCase()} ${did[2]} as ${article(p.role)} ${p.role} at ${p.org}`;
  return `${now} ${article(p.role)} ${p.role} at ${p.org}`;
}
export function pitchFor(job, track) {
  const field = jobField(job, track);
  const own = tracks().filter((t) => fieldOf(t.id) === field).map((t) => t.id);
  const other = tracks().filter((t) => fieldOf(t.id) !== field).map((t) => t.id);
  // This field's version of each role (its bullets describe the relevant side of the work).
  const items = [], seen = new Set();
  for (const id of [...own, ...other]) for (const p of positionsOf(readResume(id))) {
    const k = roleKey(p); if (seen.has(k)) continue; seen.add(k);
    items.push({ ...p, onlyThis: own.includes(id) && !other.some((o) => positionsOf(readResume(o)).some((x) => roleKey(x) === k)), inField: own.includes(id) });
  }
  const leads = new Set(own.flatMap((id) => [...(rolePrefs(id).leads || [])]));
  const rank = (p) => (p.inField ? 0 : 10) + (leads.has(roleKey(p)) ? 0 : 2) + (p.onlyThis ? 0 : 1) + (p.current ? 0 : 0.5);
  const sorted = items.filter((p) => p.org).sort((a, b) => rank(a) - rank(b));
  const first = sorted[0];
  const second = sorted.find((p) => p !== first && p.inField && p.kind === 'work' && first?.kind !== 'work') || sorted.find((p) => p !== first && p.inField);
  const school = P.school ? ` at ${/^university\b/i.test(P.school) ? 'the ' : ''}${P.school}` : '';
  if (!first) return P.pitch?.[track] || trackPitch();
  return `I'm ${article(study())} ${study()}${school} who ${phrase(first)}${second ? `, and ${phrase(second)}` : ''}.`;
}

const study = () => [P.major || P.degree, 'student'].filter(Boolean).join(' ');
// The model only names WHAT the team works on, in a few words taken from the posting ("fraud prevention for
// online businesses"); the sentence around it is ours. Small models otherwise invent experience or switch
// to the company's voice ("what we do at Affirm"). A topic whose words aren't in the posting is thrown out.
const LINES = [
  (co, t) => `Your team's work on ${t} is the kind of problem I'd like to spend my time on.`,
  (co, t) => `${t[0].toUpperCase()}${t.slice(1)} is exactly the kind of work I want to be doing, and ${co} is one of the places doing it best.`,
  (co, t) => `What drew me to this role is the work on ${t}.`,
];
const STOP = new Set('the and for with from that this into their your our are its of to in on at by an a'.split(' '));
const EXAMPLES = ['fraud prevention for online businesses', 'tax credits for manufacturing clients', 'data pipelines for the ads platform'];
export function topicOk(topic, description, company = '') {
  const t = String(topic || '').trim().replace(/[.!]$/, '');
  if (EXAMPLES.includes(t.toLowerCase())) return false; // copied the example
  if (company && t.toLowerCase().includes(company.toLowerCase().split(/\s+/)[0])) return false; // reads oddly: work on the Databricks platform
  const words = t.split(/\s+/);
  if (words.length < 2 || words.length > 9 || /\b(we|our|us|i|my|me|you|applicant|candidate|intern|internship|role|position|job)\b/i.test(t) || /[:;"]/.test(t)) return false;
  const desc = String(description || '').toLowerCase();
  const key = words.map((w) => w.toLowerCase().replace(/[^a-z0-9-]/g, '')).filter((w) => w.length > 3 && !STOP.has(w));
  return key.length > 0 && key.filter((w) => desc.includes(w.replace(/s$/, ''))).length / key.length >= 0.6;
}
async function personalLine(job, c) {
  const out = await generateJSON(
    `What does the team behind this job posting work on? Answer with a short noun phrase of 3 to 8 words using words from the posting. Lowercase, except names and acronyms (AI, SQL).
Examples: "fraud prevention for online businesses", "tax credits for manufacturing clients", "data pipelines for the ads platform".
Don't describe the job or the candidate; describe the team's work.
Job: ${job.title} at ${job.company}. Description: ${clip(job.description, 1400)}
Respond as JSON: {"topic": "..."}`,
    { topic: '' }, { temperature: 0.2, maxTokens: 40 });
  const topic = String(out.topic || '').trim().replace(/^["']|["'.]$/g, '');
  if (topicOk(topic, job.description, job.company)) {
    const pick = [...String(c.name || c.email || '')].reduce((n, ch) => n + ch.charCodeAt(0), 0) % LINES.length;
    // Names and acronyms keep their capitals; only an ordinary first word is lowercased.
    const t = /^[A-Z][a-z]+$/.test(topic.split(' ')[0]) ? topic[0].toLowerCase() + topic.slice(1) : topic;
    return LINES[pick](job.company, t.replace(/\bai\b/g, 'AI').replace(/\bfortune (\d+)/gi, 'Fortune $1'));
  }
  return `${job.company} has been on my list for a while, and this role lines up closely with the work I've been doing.`;
}

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
    const pitch = pitchFor(job, docs.track);
    const { subject, body } = render('intro', {
      role: shortRole(job.title), company: job.company, first_name: first, name: `${P.firstName} ${P.lastName}`,
      personal_line, track_pitch: pitch, phone: P.phone,
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
