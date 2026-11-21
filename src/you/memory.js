// Answer memory: every application question Joblin answers (or can't) is saved, so the same or a
// similar question gets the same answer next time. Your own edits always win over model guesses.
import { db } from '../core/db.js';

db.exec(`CREATE TABLE IF NOT EXISTS answers (
  id INTEGER PRIMARY KEY,
  question TEXT, norm TEXT UNIQUE,
  answer TEXT DEFAULT '',
  options TEXT,                 -- JSON list when the question was multiple choice
  source TEXT DEFAULT 'auto',   -- you | auto | pending
  uses INTEGER DEFAULT 0,
  last_company TEXT,
  updated_at TEXT DEFAULT (datetime('now'))
)`);

const STOP = new Set('a an the to of and or for in on at by with is are you your our we do does did have has will would please this that if any as be from describe tell us about'.split(' '));
export function normalize(q, company = '') {
  let s = String(q || '').toLowerCase();
  if (company) s = s.split(company.toLowerCase()).join(' company ');
  return s.replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w && !STOP.has(w)).join(' ').trim();
}
const tokens = (n) => new Set(n.split(' ').filter(Boolean));
function similarity(a, b) {
  const A = tokens(a), B = tokens(b);
  if (!A.size || !B.size) return 0;
  let inter = 0; for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

// Best saved answer for a question (exact, else ≥ 0.72 similar). With options, the answer must be one of them.
export function recall(question, { options = null, company = '' } = {}) {
  const n = normalize(question, company);
  if (!n) return null;
  let row = db.prepare(`SELECT * FROM answers WHERE norm = ? AND answer != ''`).get(n);
  if (!row) {
    // Similar-question reuse is only for answers you wrote or confirmed, never the model's guesses.
    let best = null, bestScore = 0;
    for (const r of db.prepare(`SELECT * FROM answers WHERE answer != '' AND source = 'you'`).all()) {
      const sc = similarity(n, r.norm);
      if (sc > bestScore) { best = r; bestScore = sc; }
    }
    if (bestScore >= 0.72) row = best;
  }
  if (!row) return null;
  if (options?.length) {
    const lo = row.answer.toLowerCase();
    const hit = options.find((o) => o.toLowerCase() === lo) || options.find((o) => o.toLowerCase().startsWith(lo)) || options.find((o) => lo && o.toLowerCase().includes(lo));
    if (!hit) return null;
    row = { ...row, answer: hit };
  }
  db.prepare('UPDATE answers SET uses = uses + 1 WHERE id = ?').run(row.id);
  return { answer: row.answer, source: row.source };
}

// Returns the id of the saved row. Unanswered questions that match one already waiting for you
// are merged into it, so the same question is only ever asked once.
export function remember(question, answer, { options = null, source = 'auto', company = '' } = {}) {
  const n = normalize(question, company);
  if (!n || n.length < 3) return null;
  // Labels that mean different things on different forms (education vs work dates) are never memorized.
  if (/^(start|end|from|to) ?(date)? ?(month|year)?$|^(month|year|title|company)$/i.test(String(question).trim())) return null;
  if (!answer) {
    for (const r of db.prepare(`SELECT id, norm, source, answer FROM answers`).all())
      if (r.norm !== n && similarity(n, r.norm) >= 0.72 && (r.source === 'pending' || r.source === 'you')) return r.id;
  }
  const existing = db.prepare('SELECT id, source, answer FROM answers WHERE norm = ?').get(n);
  if (existing?.source === 'you' && existing.answer) return existing.id; // never overwrite your own answer
  db.prepare(`INSERT INTO answers (question, norm, answer, options, source, last_company) VALUES (?,?,?,?,?,?)
    ON CONFLICT(norm) DO UPDATE SET answer = excluded.answer, options = COALESCE(excluded.options, options), source = excluded.source,
      last_company = excluded.last_company, updated_at = datetime('now')`)
    .run(String(question).slice(0, 500), n, String(answer || ''), options ? JSON.stringify(options.slice(0, 60)) : null, answer ? source : 'pending', company);
  return db.prepare('SELECT id FROM answers WHERE norm = ?').get(n)?.id ?? null;
}

// Link a question to the job it is blocking; when you answer it, that job goes back in the queue.
export const waitOn = (answerId, jobId) => answerId && db.prepare('INSERT OR IGNORE INTO answer_waits (answer_id, job_id) VALUES (?, ?)').run(answerId, jobId);
// After an answer is saved: jobs whose every blocking question is now answered.
export function unblockedBy(answerId) {
  const jobs = db.prepare('SELECT job_id FROM answer_waits WHERE answer_id = ?').all(answerId).map((r) => r.job_id);
  db.prepare('DELETE FROM answer_waits WHERE answer_id = ?').run(answerId);
  return jobs.filter((j) => !db.prepare(`SELECT 1 FROM answer_waits w JOIN answers a ON a.id = w.answer_id WHERE w.job_id = ? AND a.answer = ''`).get(j));
}

export const listAnswers = () => db.prepare(`SELECT id, question, answer, options, source, uses, last_company, updated_at FROM answers
  ORDER BY source = 'pending' DESC, updated_at DESC LIMIT 1000`).all().map((r) => ({ ...r, options: r.options ? JSON.parse(r.options) : null }));
export function setAnswer(id, answer) {
  db.prepare(`UPDATE answers SET answer = ?, source = CASE WHEN ? = '' THEN 'pending' ELSE 'you' END, updated_at = datetime('now') WHERE id = ?`).run(answer, answer, id);
}
export const deleteAnswer = (id) => db.prepare('DELETE FROM answers WHERE id = ?').run(id);
export const pendingCount = () => db.prepare(`SELECT COUNT(*) n FROM answers WHERE source = 'pending'`).get().n;

// ---------- Facts: things about you Joblin should know for applications and emails ----------
db.exec(`CREATE TABLE IF NOT EXISTS facts (
  id INTEGER PRIMARY KEY, text TEXT, category TEXT DEFAULT 'general',
  created_at TEXT DEFAULT (datetime('now'))
)`);
export const listFacts = () => db.prepare('SELECT * FROM facts ORDER BY category, id DESC').all();
export const addFact = (text, category = 'general') => db.prepare('INSERT INTO facts (text, category) VALUES (?, ?)').run(String(text).trim().slice(0, 600), category).lastInsertRowid;
export const updateFact = (id, text, category) => db.prepare('UPDATE facts SET text = ?, category = COALESCE(?, category) WHERE id = ?').run(String(text).trim().slice(0, 600), category ?? null, id);
export const deleteFacts = (ids) => { const st = db.prepare('DELETE FROM facts WHERE id = ?'); db.transaction(() => ids.forEach((id) => st.run(id)))(); };
// Compact text block for model prompts.
export function memoryFacts(max = 12) {
  return db.prepare('SELECT text FROM facts ORDER BY id DESC LIMIT ?').all(max).map((r) => r.text).join(' • ');
}

// ---------- Bulk actions on saved answers ----------
export const deleteAnswers = (ids) => { const st = db.prepare('DELETE FROM answers WHERE id = ?'); db.transaction(() => ids.forEach((id) => st.run(id)))(); };
export const confirmAnswers = (ids) => { const st = db.prepare(`UPDATE answers SET source = 'you' WHERE id = ? AND answer != ''`); db.transaction(() => ids.forEach((id) => st.run(id)))(); };
