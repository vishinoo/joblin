// The people Joblin emails about a job, in order of how sure we are about them:
//  1. addresses written in the job posting itself;
//  2. the "meet the hiring team" people LinkedIn shows on the job;
//  3. recruiters and a team lead found with a LinkedIn people search (see finder.js).
// Addresses come from the company's own email pattern (or Hunter, if you added a key).
import { config } from '../core/config.js';
import { db, log } from '../core/db.js';
import { companyDomain, findPeople, emailFor } from './finder.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK = /noreply|no-reply|donotreply|privacy|accommodation|accessibility|example\.com|benefits|payroll|legal@/i;
const insert = db.prepare(`INSERT OR IGNORE INTO contacts (job_id, name, title, email, source, confidence, linkedin, pattern, tried) VALUES (?,?,?,?,?,?,?,?,?)`);

export async function findContacts(job) {
  const max = config.email.maxContactsPerJob;
  const found = [];
  const add = (c) => { if (c.email && !found.some((f) => f.email === c.email) && !JUNK.test(c.email)) found.push(c); };

  // 1) Emails written in the posting.
  for (const email of new Set((job.description || '').match(EMAIL_RE) || [])) add({ name: '', title: 'From the job posting', email: email.toLowerCase(), source: 'posting', confidence: 'high' });

  // 2 & 3) People: the hiring team LinkedIn showed, then a LinkedIn people search.
  const domain = found.length >= max ? '' : await companyDomain(job.company, job.company_domain || '').catch(() => '');
  if (domain) {
    if (!job.company_domain) db.prepare('UPDATE jobs SET company_domain = ? WHERE id = ?').run(domain, job.id);
    const team = JSON.parse(job.hiring_team || '[]').map((p) => ({ name: p.name, title: p.title, linkedin: p.profileUrl }));
    const searched = found.length + team.length >= max ? [] : await findPeople(job.company, job.search_track || '', job.title, max).catch((e) => { log('error', `people ${job.company}: ${e.message}`); return []; });
    for (const p of [...team, ...searched]) {
      if (found.length >= max) break;
      if (!p.name || p.name.trim().split(/\s+/).length < 2) continue;
      const addr = await emailFor(p.name, domain);
      if (!addr) continue;
      if (addr.source === 'guessed' && !config.email.useGuessedEmails) continue;
      add({ name: p.name, title: p.title, email: addr.email, source: addr.source, confidence: addr.confidence, linkedin: p.linkedin || '', pattern: addr.pattern });
    }
  }

  const out = [], fresh = [];
  for (const c of found.slice(0, max)) {
    if (/^[a-z]\.?$/i.test(String(c.name).trim().split(/\s+/).pop()) && c.source !== 'posting') continue; // initial-only last name
    if (insert.run(job.id, c.name, c.title, c.email, c.source, c.confidence, c.linkedin || '', c.pattern || '', JSON.stringify(c.pattern ? [c.pattern] : [])).changes) fresh.push(c.name || c.email);
    const row = db.prepare('SELECT * FROM contacts WHERE email = ?').get(c.email);
    if (row && !row.unsubscribed) out.push(row);
  }
  if (fresh.length) log('email', `${job.company}: found ${fresh.join(', ')}`); // people already emailed for another job aren't emailed twice
  return out;
}
