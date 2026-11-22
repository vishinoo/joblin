import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import { paths } from './config.js';

fs.mkdirSync(paths.data, { recursive: true });
export const db = new Database(path.join(paths.data, 'jobert.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id INTEGER PRIMARY KEY,
  linkedin_id TEXT UNIQUE,
  title TEXT, company TEXT, location TEXT,
  linkedin_url TEXT, apply_url TEXT, ats TEXT,
  company_domain TEXT,
  description TEXT,
  hiring_team TEXT,              -- JSON [{name, title, profileUrl}]
  easy_apply INTEGER DEFAULT 0,
  discovered_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY,
  job_id INTEGER UNIQUE REFERENCES jobs(id),
  track TEXT,                    -- swe | finance
  status TEXT DEFAULT 'queued',  -- queued | pending_approval | approved | skipped | prepared | submitted | needs_review | manual | failed | interview | offer | rejected | withdrawn
  resume_path TEXT, cover_letter_path TEXT, cover_letter_text TEXT,
  notes TEXT,
  applied_at TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS contacts (
  id INTEGER PRIMARY KEY,
  job_id INTEGER REFERENCES jobs(id),
  name TEXT, title TEXT, email TEXT, source TEXT,  -- posting | pattern | guessed | hunter
  confidence TEXT,
  unsubscribed INTEGER DEFAULT 0,
  UNIQUE(email)
);
CREATE TABLE IF NOT EXISTS emails (
  id INTEGER PRIMARY KEY,
  contact_id INTEGER REFERENCES contacts(id),
  kind TEXT,                     -- intro | followup
  subject TEXT, body TEXT,
  status TEXT DEFAULT 'scheduled', -- scheduled | sent | bounced | replied | cancelled | failed
  scheduled_at TEXT, sent_at TEXT, message_id TEXT,
  replied_at TEXT, reply_snippet TEXT, error TEXT
);
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  title TEXT, detail TEXT, url TEXT,
  priority INTEGER DEFAULT 2,     -- 1 high, 2 normal, 3 low
  done INTEGER DEFAULT 0,
  related_job_id INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY,
  type TEXT, message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT);
`);

// Additive migrations (safe to re-run).
for (const sql of [
  'ALTER TABLE applications ADD COLUMN match_score INTEGER',
  'ALTER TABLE applications ADD COLUMN analysis TEXT',
  'ALTER TABLE applications ADD COLUMN batch_id INTEGER',
  'ALTER TABLE jobs ADD COLUMN search_track TEXT',
  'ALTER TABLE applications ADD COLUMN letter_kind TEXT',
  'ALTER TABLE applications ADD COLUMN proof_path TEXT',
  'ALTER TABLE contacts ADD COLUMN linkedin TEXT',
  'ALTER TABLE contacts ADD COLUMN pattern TEXT', // the address pattern used (for retrying after a bounce)
  'ALTER TABLE contacts ADD COLUMN tried TEXT', // JSON list of patterns already tried
]) { try { db.exec(sql); } catch {} }

export function log(type, message) {
  console.log(`[${type}] ${message}`);
  db.prepare('INSERT INTO events (type, message) VALUES (?, ?)').run(type, message);
}

export function addTask({ title, detail = '', url = '', priority = 2, jobId = null }) {
  const dup = db.prepare('SELECT id FROM tasks WHERE title = ? AND done = 0').get(title);
  if (dup) return dup.id;
  return db.prepare('INSERT INTO tasks (title, detail, url, priority, related_job_id) VALUES (?,?,?,?,?)')
    .run(title, detail, url, priority, jobId).lastInsertRowid;
}

export function setStatus(jobId, status, notes) {
  db.prepare(`UPDATE applications SET status = ?, notes = COALESCE(?, notes), updated_at = datetime('now'),
    applied_at = CASE WHEN ? = 'submitted' THEN datetime('now') ELSE applied_at END WHERE job_id = ?`)
    .run(status, notes ?? null, status, jobId);
}

export const kv = {
  get: (k, d = null) => { const r = db.prepare('SELECT v FROM kv WHERE k = ?').get(k); return r ? JSON.parse(r.v) : d; },
  set: (k, v) => db.prepare('INSERT INTO kv (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v').run(k, JSON.stringify(v)),
};

// ---------- Duplicate jobs ----------
// The same job often shows up on LinkedIn and on the company board, or twice with different tracking links.
export const normTitle = (t) => String(t || '').toLowerCase().replace(/\[[^\]]*\]|\([^)]*\)/g, ' ')
  .replace(/\b(summer|winter|fall|spring|autumn)\b|\b20\d\d\b|\bterm\b/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const normCompany = (c) => String(c || '').toLowerCase().replace(/\b(inc|llc|ltd|corp|corporation|co|company|canada|technologies|labs)\b\.?/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
export const normUrl = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname).replace(/\/+$/, '').toLowerCase(); } catch { return String(u || '').toLowerCase(); } };
export function findDuplicateJob({ company, title, apply_url }) {
  const nu = apply_url ? normUrl(apply_url) : '';
  const nc = normCompany(company), nt = normTitle(title);
  for (const j of db.prepare('SELECT id, company, title, apply_url FROM jobs').all()) {
    if (nu && j.apply_url && normUrl(j.apply_url) === nu) return j.id;
    if (nc && nt && normCompany(j.company) === nc && normTitle(j.title) === nt) return j.id;
  }
  return null;
}
// Already applied (or in progress) to the same company + role under another listing?
export function alreadyApplied(job) {
  const nc = normCompany(job.company), nt = normTitle(job.title);
  return db.prepare(`SELECT j.id, j.company, j.title, a.status FROM jobs j JOIN applications a ON a.job_id = j.id
    WHERE j.id != ? AND a.status IN ('submitted','interview','offer','rejected')`).all(job.id)
    .find((j) => normCompany(j.company) === nc && normTitle(j.title) === nt) || null;
}

// ---------- Questions that block applications ----------
db.exec(`CREATE TABLE IF NOT EXISTS answer_waits (answer_id INTEGER, job_id INTEGER, PRIMARY KEY (answer_id, job_id))`);
