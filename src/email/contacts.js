// The people Joblin emails about a job, in order of how sure we are about them:
//  1. addresses written in the job posting itself;
//  2. the "meet the hiring team" people LinkedIn shows on the job;
//  3. recruiters and a team lead found with a LinkedIn people search (see finder.js).
// Addresses come from the company's own email pattern (or Hunter, if you added a key).
import { config } from '../core/config.js';
import { db, log } from '../core/db.js';
import { companyDomain, findPeople, findMorePeople, emailFor } from './finder.js';
import { scheduleOutreach } from './mailer.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK = /noreply|no-reply|donotreply|privacy|accommodation|accessibility|example\.com|benefits|payroll|legal@/i;
const insert = db.prepare(`INSERT OR IGNORE INTO contacts (job_id, name, title, email, source, confidence, linkedin, pattern, tried, why) VALUES (?,?,?,?,?,?,?,?,?,?)`);

// more: N extra people beyond the ones already found for this company (from the chat: "more people at Ryan").
export async function findContacts(job, { more = 0 } = {}) {
  const max = more || config.email.maxContactsPerJob;
  const found = [];
  const known = more ? db.prepare('SELECT c.name, c.email FROM contacts c JOIN jobs j ON j.id = c.job_id WHERE lower(j.company) = lower(?)').all(job.company) : [];
  const add = (c) => { if (c.email && !found.some((f) => f.email === c.email) && !JUNK.test(c.email)) found.push(c); };

  // 1) Emails written in the posting.
  if (!more) for (const email of new Set((job.description || '').match(EMAIL_RE) || [])) add({ name: '', title: 'From the job posting', email: email.toLowerCase(), source: 'posting', confidence: 'high', why: 'Address given in the job posting' });

  // 2 & 3) People: the hiring team LinkedIn showed, then a LinkedIn people search.
  const domain = found.length >= max ? '' : await companyDomain(job.company, job.company_domain || '').catch(() => '');
  if (domain) {
    if (!job.company_domain) db.prepare('UPDATE jobs SET company_domain = ? WHERE id = ?').run(domain, job.id);
    const team = more ? [] : JSON.parse(job.hiring_team || '[]').map((p) => ({ name: p.name, title: p.title, linkedin: p.profileUrl, why: 'Listed on the job as the hiring team' }));
    const searched = found.length + team.length >= max ? [] : await (more
      ? findMorePeople(job.company, job.search_track || '', job.title, max, known.map((k) => k.name).filter(Boolean))
      : findPeople(job.company, job.search_track || '', job.title, max)).catch((e) => { log('error', `people ${job.company}: ${e.message}`); return []; });
    for (const p of [...team, ...searched]) {
      if (found.length >= max) break;
      if (!p.name || p.name.trim().split(/\s+/).length < 2) continue;
      if (known.some((k) => k.name && k.name.toLowerCase() === p.name.toLowerCase())) continue;
      const addr = await emailFor(p.name, domain);
      if (!addr) continue;
      if (addr.source === 'guessed' && !config.email.useGuessedEmails) continue;
      add({ name: p.name, title: p.title, email: addr.email, source: addr.source, confidence: addr.confidence, linkedin: p.linkedin || '', pattern: addr.pattern, why: p.why || '' });
    }
  }

  const out = [], fresh = [];
  for (const c of found.slice(0, max)) {
    if (/^[a-z]\.?$/i.test(String(c.name).trim().split(/\s+/).pop()) && c.source !== 'posting') continue; // initial-only last name
    if (insert.run(job.id, c.name, c.title, c.email, c.source, c.confidence, c.linkedin || '', c.pattern || '', JSON.stringify(c.pattern ? [c.pattern] : []), c.why || '').changes) fresh.push(c.name || c.email);
    const row = db.prepare('SELECT * FROM contacts WHERE email = ?').get(c.email);
    if (row && !row.unsubscribed) out.push(row);
  }
  if (fresh.length) log('email', `${job.company}: found ${fresh.join(', ')}`); // people already emailed for another job aren't emailed twice
  return out;
}

// Your applications' companies, newest first (what "more people at X" can refer to).
export const appliedCompanies = () => db.prepare(`SELECT j.*, a.track FROM jobs j JOIN applications a ON a.job_id = j.id
  WHERE a.status IN ('submitted','interview','offer','needs_review','manual') ORDER BY COALESCE(a.applied_at, a.updated_at) DESC`).all();
// The application a message is about: the company named in it ("more emails to Ryan").
export function jobNamedIn(text) {
  const t = ` ${String(text).toLowerCase()} `;
  return appliedCompanies().find((j) => {
    const name = j.company.toLowerCase().replace(/\s*\(.*?\)|,? (inc|llc|ltd|corp|corporation|canada|limited)\.?$/g, '').trim();
    return name.length > 1 && (t.includes(` ${name} `) || t.includes(` ${name}'`) || t.includes(` ${name}.`) || t.includes(` ${name},`) || t.includes(` ${name}?`) || t.includes(` ${name}!`));
  }) || null;
}
// Find `n` more people at that company for that role and write them drafts (or queue them, with auto-send on).
export async function moreOutreachFor(job, n = 3) {
  const cs = await findContacts(job, { more: n });
  const fresh = cs.filter((c) => !db.prepare('SELECT 1 FROM emails WHERE contact_id = ?').get(c.id));
  if (fresh.length) await scheduleOutreach(job, fresh, { track: job.track || job.search_track });
  log('email', `${job.company}: ${fresh.length} more ${fresh.length === 1 ? 'person' : 'people'} for ${job.title}`);
  return fresh;
}
