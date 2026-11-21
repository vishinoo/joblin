import dns from 'node:dns/promises';
import { config } from '../core/config.js';
import { db } from '../core/db.js';

const EMAIL_RE = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi;
const JUNK = /noreply|no-reply|donotreply|privacy|accommodation|accessibility|example\.com|benefits|payroll|legal@/i;

const mxCache = new Map();
async function hasMX(domain) {
  if (!mxCache.has(domain)) mxCache.set(domain, dns.resolveMx(domain).then((r) => r.length > 0).catch(() => false));
  return mxCache.get(domain);
}

async function hunterFind(domain, first, last) {
  const key = config.email.hunterApiKey;
  if (!key) return null;
  const u = `https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(last)}&api_key=${key}`;
  const r = await fetch(u).then((x) => x.json()).catch(() => null);
  const d = r?.data;
  return d?.email && d.score >= 60 ? { email: d.email, confidence: `hunter ${d.score}` } : null;
}

// Company recruiters from Hunter's domain search (works from the company name alone).
const recruiterCache = new Map();
async function hunterRecruiters(company, domain) {
  const key = config.email.hunterApiKey;
  if (!key) return { people: [], domain };
  const k = domain || company;
  if (recruiterCache.has(k)) return recruiterCache.get(k);
  const q = domain ? `domain=${encodeURIComponent(domain)}` : `company=${encodeURIComponent(company)}`;
  const r = await fetch(`https://api.hunter.io/v2/domain-search?${q}&type=personal&limit=20&api_key=${key}`).then((x) => x.json()).catch(() => null);
  const emails = r?.data?.emails || [];
  const want = /recruit|talent|university|campus|early career|hiring|people|hr\b|human resources/i;
  const people = emails.filter((e) => want.test(`${e.position || ''} ${e.department || ''}`) && (e.confidence ?? 0) >= 70)
    .sort((a, b) => (/university|campus|early/i.test(b.position || '') - /university|campus|early/i.test(a.position || '')) || b.confidence - a.confidence)
    .map((e) => ({ name: [e.first_name, e.last_name].filter(Boolean).join(' '), title: e.position || 'Recruiting', email: e.value.toLowerCase(), source: 'hunter', confidence: `hunter ${e.confidence}` }));
  const out = { people, domain: r?.data?.domain || domain };
  recruiterCache.set(k, out);
  return out;
}

const clean = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');

const insert = db.prepare(`INSERT OR IGNORE INTO contacts (job_id, name, title, email, source, confidence) VALUES (?,?,?,?,?,?)`);

// Returns contact rows worth emailing for this job (posted emails first, then hiring team).
export async function findContacts(job) {
  const found = [];
  const max = config.email.maxContactsPerJob;

  // 1) Emails written in the posting itself.
  for (const email of new Set((job.description || '').match(EMAIL_RE) || [])) {
    if (JUNK.test(email)) continue;
    found.push({ name: '', title: 'From job posting', email: email.toLowerCase(), source: 'posting', confidence: 'high' });
  }

  // 2) "Meet the hiring team" people → Hunter lookup, else first.last@domain guess.
  const team = JSON.parse(job.hiring_team || '[]');
  const domain = job.company_domain;
  if (domain && (await hasMX(domain))) {
    for (const p of team) {
      const parts = (p.name || '').trim().split(/\s+/);
      if (parts.length < 2) continue;
      const [first, last] = [clean(parts[0]), clean(parts[parts.length - 1])];
      if (!first || !last) continue;
      const hit = await hunterFind(domain, first, last);
      if (hit) found.push({ name: p.name, title: p.title, email: hit.email, source: 'hunter', confidence: hit.confidence });
      else if (config.email.useGuessedEmails) found.push({ name: p.name, title: p.title, email: `${first}.${last}@${domain}`, source: 'guessed', confidence: 'low' });
    }
  }

  // 3) No hiring team (e.g. jobs from company boards): find the company's recruiters.
  if (found.length < max && config.email.hunterApiKey) {
    const { people, domain: d } = await hunterRecruiters(job.company, domain);
    if (d && !job.company_domain) db.prepare('UPDATE jobs SET company_domain = ? WHERE id = ?').run(d, job.id);
    for (const p of people) if (!found.some((f) => f.email === p.email)) found.push(p);
  }

  const out = [];
  for (const c of found.slice(0, max)) {
    insert.run(job.id, c.name, c.title, c.email, c.source, c.confidence);
    const row = db.prepare('SELECT * FROM contacts WHERE email = ?').get(c.email);
    if (row && !row.unsubscribed) out.push(row);
  }
  return out;
}
