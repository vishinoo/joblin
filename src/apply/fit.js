// Is this job one you can realistically get? Checked before Joblin writes documents for a job and again right
// before it applies, so applications only go where they have a chance:
//  - the level fits a student (no "Senior", "Engineer II", "5+ years of experience");
//  - the degree fits (no Master's/PhD-only roles for a bachelor's student);
//  - "new grad" roles only when you graduate within about a year;
//  - the title is in a field you're looking for (no Content Design intern from a software search);
//  - at most a few applications per company, so recruiters don't see you spray their whole job board.
import { config } from '../core/config.js';
import { db, kv } from '../core/db.js';

const P = () => config.profile || {};
const SENIOR = /\b(senior|sr\.?|staff|principal|lead|manager|director|head of|vp|vice president|architect|(engineer|developer|analyst|scientist|accountant|associate)\s+(ii|iii|iv|2|3|4)|level\s*[2-9]|\bl[4-9]\b)\b/i;
const EARLY = /\b(interns?|internships?|stages?|stagiaires?|co-?ops?|new ?grads?|graduates?|university|students?|campus|junior|jr\.?|entry[- ]level|early[- ]career|summer analyst|analyst program|apprentice)\b/i;
const STUDENT = /\b(intern\w*|co-?op|student|stage|stagiaire)\b/i;
// Your field, broadly: a finance search also wants accounting, tax, audit, risk, actuarial and advisory roles;
// a software search wants software, data and ML roles — not hardware, industrial or design roles.
const BROAD = [
  { words: /financ|invest|bank|equity|capital|asset|wealth|treasury|account|audit|tax|fp&a|valuation|credit|portfolio|trading|quant|risk|venture|private|hedge|actuar|insurance/,
    title: /financ|invest|bank|equity|capital|asset|wealth|treasury|account|audit|tax|actuar|risk|consult|advis|credit|portfolio|trading|valuation|fp&a|payable|receivable|controller|insurance|real estate|economic/i },
  { words: /software|developer|engineer|data|machine|learning|\bai\b|backend|full|stack|front|cloud|devops|security|mobile|web/,
    title: /software|developer|data|machine learning|\bml\b|\bai\b|analytics|scien|backend|back-end|front-?end|full.?stack|platform|cloud|devops|security|mobile|automation|programm|(?<!(hardware|mechanical|civil|electrical|industrial\w*|field|quality|manufacturing|process|structural|chemical)\s)engineer/i },
];
const GENERIC = /^(intern|internship|new|grad|graduate|summer|junior|jr|entry|level|co-?op|the|and|of|analyst|student)$/i;
export const MAX_PER_COMPANY = () => config.apply?.maxPerCompany ?? 3;

// The words of every position you're after: your saved positions plus anything you asked for in the last month.
function positionWords() {
  const recent = kv.get('searchFocus', []).filter((x) => x.kw && Date.now() - x.at < 30 * 864e5).map((x) => x.kw);
  const all = [...(config.search?.queries || []).map((q) => q.keywords), ...recent];
  return [...new Set(all.flatMap((k) => String(k).toLowerCase().split(/[^a-z&+]+/)).filter((w) => w.length > 2 && !GENERIC.test(w)))];
}
// Whole positions without the filler ("Equity Research Intern" → "equity research"): a title must contain one,
// so a lone word like "research" or "engineer" never lets in UX Research or Hardware Quality Engineer.
function positionPhrases() {
  const recent = kv.get('searchFocus', []).filter((x) => x.kw && Date.now() - x.at < 30 * 864e5).map((x) => x.kw);
  return [...new Set([...(config.search?.queries || []).map((q) => q.keywords), ...recent]
    .map((k) => String(k).toLowerCase().split(/[^a-z&+]+/).filter((w) => w && !GENERIC.test(w)).join(' ')).filter((p) => p.length > 2))];
}
const monthsUntilGrad = () => {
  const y = Number(P().graduationYear); if (!y) return 0;
  const m = Math.max(1, ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'].indexOf(String(P().graduationMonth || 'may').slice(0, 3).toLowerCase()) + 1);
  const now = new Date();
  return (y - now.getFullYear()) * 12 + (m - (now.getMonth() + 1));
};
// "3+ years of experience", "minimum of 2 years" → 3 / 2 (the largest required, ignoring "preferred").
export function yearsRequired(text) {
  let max = 0;
  for (const m of String(text || '').matchAll(/(\d{1,2})\s*\+?\s*(?:-\s*\d+\s*)?(?:years?|yrs?)(?:\s+of)?(?:\s+\w+){0,4}\s+(?:experience|exp\b)/gi)) {
    // Only the sentence this is in: "3+ years required. 5 years preferred." keeps the 3.
    const str = String(text), start = Math.max(str.lastIndexOf('.', m.index), str.lastIndexOf('\n', m.index)) + 1;
    const ends = [str.indexOf('.', m.index + m[0].length), str.indexOf('\n', m.index + m[0].length)].filter((i) => i >= 0);
    if (/prefer|nice to have|bonus|\bplus\b|asset/i.test(str.slice(start, ends.length ? Math.min(...ends) : undefined))) continue;
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

// '' when the job is worth applying to, otherwise the reason it isn't (shown on the job).
export function whyNot(job) {
  const t = String(job.title || ''), early = EARLY.test(t);
  if (SENIOR.test(t) && !STUDENT.test(t)) return 'Not entry level: this role is for people with work experience';
  const yrs = yearsRequired(job.description);
  if (yrs >= 2 && !STUDENT.test(t)) return `Asks for ${yrs}+ years of experience`;
  if (/\b(master'?s|mba|ph\.?\s?d|doctoral|graduate student)\b/i.test(t) && !/master|mba|ph\.?d/i.test(`${P().degree} ${P().school}`)) return 'Needs a graduate degree';
  if (/\bnew ?grad|graduate (program|role|opportunit)|early[- ]career\b/i.test(t) && !STUDENT.test(t) && monthsUntilGrad() > 12) return `For new graduates; you graduate ${P().graduationMonth || ''} ${P().graduationYear}`.trim();
  if (!early && !/\b(analyst|associate|assistant|coordinator|specialist|accountant|developer|engineer)\b/i.test(t)) return 'Not an early-career role';
  const words = positionWords();
  const broad = BROAD.some((b) => words.some((w) => b.words.test(w)) && b.title.test(t));
  const phrase = positionPhrases().some((p) => t.toLowerCase().includes(p));
  if (words.length && !broad && !phrase) return 'Not one of the positions you’re looking for';
  return '';
}

// Applications already going to this company (sent, approved or in flight) in the last 60 days.
export function companyLoad(job) {
  return db.prepare(`SELECT COUNT(*) n FROM applications a JOIN jobs j ON j.id = a.job_id WHERE lower(j.company) = lower(?) AND j.id != ?
    AND a.status IN ('submitted','interview','offer','approved') AND COALESCE(a.applied_at, a.updated_at) > datetime('now', '-60 days')`).get(job.company, job.id).n;
}
