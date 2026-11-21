import { getContext, holdOpen, workPage, markHeld } from './browser.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
const notify = (title, text) => process.platform === 'darwin' && execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], () => {});
import { config, jitter } from '../core/config.js';
import { db, log, addTask, setStatus, alreadyApplied } from '../core/db.js';
import { prepareDocuments } from './documents.js';
import { generateJSON, clip } from '../core/llm.js';
import { findContacts } from '../email/contacts.js';
import { scheduleOutreach } from '../email/mailer.js';
import { recall, remember, memoryFacts, waitOn } from '../you/memory.js';
import { waitForCode, canReadInbox } from '../email/inbox.js';
import { employmentHistory, candidateBackground, homeFor } from '../you/profile.js';
import { countryOf } from '../../public/places.js';

export function detectATS(url) {
  const u = (url || '').toLowerCase();
  if (/greenhouse\.io|gh_jid=/.test(u)) return 'greenhouse';
  if (/lever\.co/.test(u)) return 'lever';
  if (/ashbyhq\.com/.test(u)) return 'ashby';
  if (/myworkdayjobs|workday/.test(u)) return 'workday';
  if (/smartrecruiters/.test(u)) return 'smartrecruiters';
  if (/icims|taleo|successfactors|jobvite|bamboohr|workable|recruitee|breezy/.test(u)) return 'other_ats';
  return u ? 'company_site' : 'unknown';
}
const AUTOMATABLE = new Set(['greenhouse', 'lever', 'ashby']);

// ---------- Field mapping ----------
const P = config.profile, A = P.answers;
const US = /united states|\bu\.?s\.?a?\b|america/i;
// The job being filled right now (one application at a time). Location answers use the base closest to it.
let JOB = {};
const here = () => homeFor(JOB.location);
const today = () => new Date().toLocaleDateString('en-US', { month: '2-digit', day: '2-digit', year: 'numeric' });
const RULES = [
  [/zip|postal/i, () => P.postalCode],
  [/street|^address( line 1)?$|mailing address|home address/i, () => [P.address, P.city, P.region, P.postalCode].filter(Boolean).join(', ')],
  [/signature|sign(ed)? (your|full) name|full name and today/i, () => `${P.firstName} ${P.lastName}, ${today()}`],
  [/^(today'?s )?date$|today'?s date/i, () => today()],
  [/\bcity\b.*\b(province|state)\b|\b(province|state)\b.*\bcity\b|where do you (live|reside)|city.{0,20}live/i, () => `${here().city}, ${here().region}`],
  [/privacy (notice|policy)|i have read|i acknowledge|i understand|i consent|i certify|terms and conditions|consent to (being )?record|we use \w+ to record|record and transcribe/i, () => 'Yes'],
  // Education & EEO details first: they're more specific than the generic rules below.
  [/\bminor\b/i, () => P.minor],
  [/\bmajor\b|discipline|field of study|area of study|program of study|concentration|specialization/i, () => P.major],
  [/\bgpa\b|grade point|cumulative average/i, () => P.gpa && (P.gpaScale ? `${P.gpa}` : P.gpa)],
  [/year of study|current year|what year are you|academic year|year in school|class standing/i, () => P.yearOfStudy],
  [/graduation (date|month)|expected graduation|when (do|will) you graduate/i, () => [P.graduationMonth, P.graduationYear].filter(Boolean).join(' ')],
  [/pronoun/i, () => P.pronouns || A.pronouns],
  [/hispanic|latin[oax]/i, () => A.hispanic],
  [/sexual orientation/i, () => A.sexualOrientation],
  [/lgbt/i, () => A.lgbtq],
  [/transgender/i, () => A.transgender],
  [/indigenous|aboriginal|first nations/i, () => A.indigenous],
  [/visible minority/i, () => A.visibleMinority],
  [/sponsor/i, (l) => (US.test(l) ? A.requiresSponsorshipUS : A.requiresSponsorship)],
  [/authori[sz]ed|eligible to work|legally (able|permitted)|right to work/i, (l) => (US.test(l) ? A.authorizedToWorkUS : A.authorizedToWork)],
  [/deadline|competing offer|other offers?/i, A.offerDeadline],
  [/current (or previous )?employer|current company|most recent (employer|company)/i, P.currentEmployer],
  [/(current|previous|most recent) (or previous )?(job )?title/i, P.currentTitle],
  [/first\s*name|given name|preferred name/i, P.firstName],
  [/last\s*name|surname|family name/i, P.lastName],
  [/^(full\s*)?name\b|your name|legal name/i, `${P.firstName} ${P.lastName}`],
  [/e-?mail/i, P.email],
  [/phone|mobile/i, P.phone],
  [/linkedin/i, P.linkedin],
  [/github/i, P.github],
  [/website|portfolio|personal site|other url/i, () => P.website || P.github || ''],
  // Work-history blocks and "current role" questions
  [/^(current |most recent )?(company|employer|organization)( name)?$/i, () => P.currentEmployer],
  [/^(current |most recent )?(job )?title$|^position( title)?$|^role$/i, () => P.currentTitle],
  [/^(current )?(city|location)\b(?!.*\?)|^where (are you|do you live)/i, () => `${here().city}, ${here().region}`],
  [/\bcountry\b/i, P.country],
  [/\b(province|state)\b(?! of)/i, () => here().region],
  [/school|university|college/i, P.school],
  [/degree/i, P.degree],
  [/graduat/i, P.graduationYear],
  [/how did you hear|source|referr(ed|al) by|where did you (find|hear)/i, A.howDidYouHear],
  [/relocat/i, A.willingToRelocate],
  [/salary|compensation|pay expectation/i, A.salaryExpectation],
  [/start date|available to start|earliest start|availability/i, A.startDate],
  [/gender/i, () => A.gender],
  [/race|ethnic/i, () => A.race],
  [/veteran/i, () => A.veteran],
  [/disabilit/i, () => A.disability],
];
const ruleFor = (label) => {
  const v = RULES.find(([re]) => re.test(label))?.[1];
  return typeof v === 'function' ? v(label) : v;
};
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const monthNum = (m) => String(MONTHS.findIndex((x) => x.toLowerCase().startsWith(String(m || '').toLowerCase().slice(0, 3))) + 1).padStart(2, '0');
// Your roles in the order applications list them: the role you chose in Profile first, then the rest of
// your resumes (newest first), so the 2nd and 3rd employment blocks aren't left empty or repeated.
const orgKey = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function jobAt(n) {
  const hist = employmentHistory();
  const mine = P.currentEmployer ? { org: P.currentEmployer, role: P.currentTitle, start: { month: P.jobStartMonth, year: P.jobStartYear },
    end: P.jobEndYear ? { month: P.jobEndMonth, year: P.jobEndYear } : null } : null;
  return (mine ? [mine, ...hist.filter((h) => orgKey(h.org) !== orgKey(mine.org))] : hist)[n];
}
// Dates and roles depend on where the field is (education vs work history) and how it's split (month / year / both).
function contextRule(f, job) {
  const L = `${f.label} ${f.id} ${f.name}`.toLowerCase(), sec = String(f.section || '').toLowerCase();
  const wantsMonth = /month/.test(L), wantsYear = /year/.test(L);
  const fmt = (m, y) => {
    if (!m && !y) return undefined;
    if (wantsMonth && !wantsYear) return m || undefined;
    if (wantsYear && !wantsMonth) return y || undefined;
    if (/mm\s*\/\s*yyyy|mm\/yy/.test(L)) return `${monthNum(m)}/${y}`;
    return [m, y].filter(Boolean).join(' ');
  };
  const isStart = /start/.test(L), isEnd = /\bend\b|end-|to date|until|graduat|completion/.test(L);
  const inEdu = /educat|school|degree/.test(sec) || /education/.test(L);
  const inJob = (/employ|experience|work/.test(sec) || /employ|company-name|job-title/.test(L)) && !inEdu;
  if (/graduat|expected (completion|finish)|completion date/.test(L)) return fmt(P.graduationMonth, P.graduationYear);
  if (inEdu && isStart) return fmt(P.eduStartMonth, P.eduStartYear);
  if (inEdu && isEnd) return fmt(P.graduationMonth, P.graduationYear);
  if (inJob) {
    // Forms repeat the employment block ("company-name-0", "company-name-1"…): block N gets your Nth role.
    const n = Number(`${f.id} ${f.name}`.match(/(?:[-_\[](\d+)\]?)\s*$/)?.[1] || 0);
    const r = jobAt(n);
    if (!r) return undefined;
    if (isStart) return fmt(r.start?.month, r.start?.year);
    if (isEnd) return r.end ? fmt(r.end.month, r.end.year) : undefined;
    if (/company|employer|organi[sz]ation/.test(L)) return r.org;
    if (/title|position|role/.test(L)) return r.role;
  }
  if (/(position|role|job).{0,30}(applying|interested)|which (role|position|job)/.test(L)) return job.title;
  return undefined;
}

const isJunk = (a) => !a || /^[.\s…-]*$|^n\/?a$|^none$|^unknown$/i.test(String(a).trim());

// One place that decides an answer: your saved answers → profile rules → earlier model answers → model.
// Whatever the model writes is saved, so similar questions later get the same answer.
// Used by the Questions page: draft an answer for a saved question without a specific job.
export async function suggestAnswer(question, options = null) {
  const a = await llmAnswer(question, options, { title: 'the role', company: 'the company', description: '' }, { mustAnswer: !options, skill: SKILL_Q.test(question), long: !options && isLong(question) });
  if (!options) return a;
  const lo = a.toLowerCase();
  return options.find((o) => o.toLowerCase() === lo) || options.find((o) => o.toLowerCase().startsWith(lo)) || '';
}

// Questions about your own history or facts only you know. The model must never guess these.
const FACTUAL = /how many|number of|years? of (experience|work)|have you (ever )?(previously )?(worked|interned|applied) (for|at|with) (us|this company|company)|previously (worked|applied|interned) (for|at|here)|currently (employed|enrolled)|completed to date|terms? completed|start date|graduation|citizenship|security clearance|criminal|convicted|referred by|employee id|student (id|number)|gpa|average|grade/i;
// Questions about what you can do or have done. You always can: the answer is yes, backed by your real roles.
const SKILL_Q = /experience (with|in|using|building|working)|familiar|comfortable|proficien|skilled|knowledge of|expertise|have you (ever )?(built|used|worked (with|on)|done|led|created|developed|designed|analy[sz]ed|managed|shipped|trained|deployed|written)|tell us about (a|an|one|your)|describe (a|an|one|your)|example of|walk us through|past (project|experience)|a time (when|you)|can you|are you able/i;
// Questions that want a written answer (a paragraph, not a word).
const isLong = (label, tag) => tag === 'textarea' || /paragraph|describe|tell us|explain|walk us|example|why|words or less|in \d+ ?-? ?\d* (sentences|words)/i.test(label);

async function answer(label, job, { options = null, required = false, rule, long = false } = {}) {
  const opts = options?.length ? options : null;
  long = long || (!opts && isLong(label));
  const mem = recall(label, { options: opts, company: job.company });
  if (mem?.source === 'you') return mem.answer; // anything you wrote yourself always wins
  const r = rule !== undefined ? rule : ruleFor(label);
  if (r) return r;
  // Written answers are never saved or reused: each application gets one written fresh for that job.
  if (long) return llmAnswer(label, null, job, { mustAnswer: true, skill: SKILL_Q.test(label), long: true });
  if (mem) return mem.answer;
  const skill = SKILL_Q.test(label);
  if (FACTUAL.test(label) && !skill) { remember(label, '', { options: opts, company: job.company }); return ''; } // ask you instead
  if (skill && opts) { // yes/no about a skill: yes
    const yes = opts.find((o) => /^yes\b|^i (have|am|can)|^extremely|^very/i.test(o.trim()));
    if (yes) { remember(label, yes, { options: opts, company: job.company }); return yes; }
  }
  let a = await llmAnswer(label, opts, job, { mustAnswer: required || skill, skill });
  if (!a && required && !opts) a = await llmAnswer(label, null, job, { mustAnswer: true, skill });
  remember(label, a, { options: opts, company: job.company });
  return a;
}

async function llmAnswer(label, options, job, { mustAnswer = false, skill = false, long = false } = {}) {
  const opt = options?.length ? `Choose exactly one of these options: ${JSON.stringify(options.slice(0, 40))}`
    : long ? 'Write 120–220 words in the first person, as the candidate. Name the specific role, project or organization from the background, what they did, and the result. Plain, confident, no clichés, no headings.'
    : 'Answer in 1–3 short sentences (or a single word/number if that is what is asked).';
  const out = await generateJSON(
    `You are filling a job application for ${P.firstName} ${P.lastName}, a ${P.degree} student at ${P.school} (graduating ${P.graduationMonth || ''} ${P.graduationYear}), based in ${homeFor(job.location).city}, ${homeFor(job.location).region}, ${P.country}${P.bases?.length ? ` (can work from ${P.bases.join(' or ')}; open to relocating)` : ''}.
Facts: authorized to work in ${P.country}: ${A.authorizedToWork}; needs sponsorship in ${P.country}: ${A.requiresSponsorship}; authorized to work in the US: ${A.authorizedToWorkUS}; needs US sponsorship: ${A.requiresSponsorshipUS}; willing to relocate: ${A.willingToRelocate}; start date: ${A.startDate}.
Studies ${P.major || P.degree}${P.minor ? `, minor in ${P.minor}` : ''}${P.gpa ? `, GPA ${P.gpa}/${P.gpaScale || '4.0'}` : ''}, ${P.yearOfStudy || ''}.
The candidate's real background (from their resumes):
${candidateBackground()}
${memoryFacts() ? `More about the candidate (from their memory): ${memoryFacts()}` : ''}
${skill ? 'This question asks about a skill or past experience. The candidate HAS this experience: answer yes, confidently, and back it up with the most relevant real example from the background above (name it). Never say they have not done it, never say "as a student I haven\'t", never hedge.' : ''}
${mustAnswer ? 'This question must be answered: write a specific answer using the background and the job description. Only leave it empty if it asks for a fact you cannot know (like an ID number).' : "If the question asks for information you don't have, answer with an empty string."}
Job: ${job.title} at ${job.company}. ${clip(job.description, 800)}
Question: "${label}"
${opt}
For yes/no eligibility questions, use the facts. Only use experience that appears in the background; never invent employers, degrees or numbers.
Respond as JSON: {"answer": "..."}`, { answer: '' }, { temperature: long ? 0.5 : 0.2, maxTokens: long ? 700 : 150 });
  const a = String(out.answer || '').replace(/^[\s.…"'`{\[]+|[\s"'`}\]]+$/g, '').replace(/\.{3,}|…/g, '').trim();
  return isJunk(a) ? '' : a;
}

// Read every visible form control along with its human label.
async function scanFields(frame) {
  return frame.$$eval('input, textarea, select', (els) => els.map((el, idx) => {
    const id = el.id;
    const lab = (id && document.querySelector(`label[for="${CSS.escape(id)}"]`)?.innerText)
      || el.closest('label')?.innerText
      || el.getAttribute('aria-label')
      || el.closest('.field, .application-question, [class*="question"], [class*="field"], fieldset')?.querySelector('label, legend, .text, [class*="label"]')?.innerText
      || el.placeholder || el.name || '';
    const r = el.getBoundingClientRect();
    el.setAttribute('data-jobert', String(idx));
    return {
      idx, id: el.id || '', tag: el.tagName.toLowerCase(), type: (el.type || '').toLowerCase(), name: el.name || '',
      combo: el.getAttribute('role') === 'combobox' || el.getAttribute('aria-autocomplete') === 'list',
      section: (el.closest('[class*="education"], [class*="employment"], [class*="experience"], fieldset, section')?.className || el.closest('fieldset')?.querySelector('legend')?.innerText || '').toString().slice(0, 80),
      label: lab.replace(/Select\.\.\./g, '').replace(/\s+/g, ' ').replace(/\*/g, '').trim().slice(0, 200),
      required: el.required || el.getAttribute('aria-required') === 'true' || /\*/.test(lab),
      visible: r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== 'hidden',
      value: el.value,
      options: el.tagName === 'SELECT' ? [...el.options].map((o) => o.text.trim()).filter((t) => t && !/^select|^--/i.test(t)) : null,
    };
  }));
}

// Stable locator: React re-renders forms mid-fill, so prefer id/name over our temporary marker.
const loc = (frame, f) => f.id ? frame.locator(`[id="${f.id}"]`)
  : (f.name && f.type !== 'radio') ? frame.locator(`${f.tag}[name="${f.name}"]`).first()
  : frame.locator(`[data-jobert="${f.idx}"]`);

async function fillForm(frame, job, docs) {
  JOB = job;
  const unanswered = [];
  const fields = await scanFields(frame);
  if (process.env.JOBERT_DEBUG) console.log(`[debug] ${fields.length} fields in ${frame.url()}`, fields.map((f) => `${f.label}|${f.type}|${f.visible}`).slice(0, 15));
  const radioGroups = new Map();

  for (const f of fields) {
    const el = loc(frame, f);
    const label = f.label;
    if (f.visible && f.type !== 'hidden') await jitter(120, 380); // human pacing between fields
    try {
      if (f.type === 'file') {
        const what = `${label} ${f.name} ${f.id}`;
        if (/transcript|grades/i.test(what)) { if (P.transcriptFile) await el.setInputFiles(P.transcriptFile); else if (f.required) unanswered.push(label); continue; }
        if (/portfolio|work sample|writing sample|other|additional/i.test(what) && !/resume|cv|cover/i.test(what)) continue;
        await el.setInputFiles(/cover/i.test(what) ? docs.letterPath : docs.resumePath);
        continue;
      }
      if (!f.visible || ['hidden', 'submit', 'button', 'search'].includes(f.type)) continue;
      if (!label) continue;
      if (!f.id && !f.name && f.tag === 'input') continue; // hidden mirror inputs behind custom dropdowns
      if (f.type === 'radio' || f.type === 'checkbox') {
        if (f.type === 'checkbox' && /agree|consent|acknowledge|certify|privacy|terms/i.test(label)) await el.check().catch(() => {});
        else if (f.name) { if (!radioGroups.has(f.name)) radioGroups.set(f.name, []); radioGroups.get(f.name).push(f); }
        continue;
      }
      if (f.value) continue;

      // Custom dropdowns (React-Select on Greenhouse, Ashby, etc.): open, read options, click one.
      if (f.combo && f.tag === 'input') {
        // Only short location/school labels are type-ahead search boxes ("Location (City)", "School"),
        // not questions that merely mention a location ("eligible to work in the location you're applying for?").
        const isPlace = (re) => re.test(label) && label.length < 45 && !/\?|eligib|authori|willing|relocat|sponsor/i.test(label);
        const isSearch = isPlace(/\b(location|city|school|university)\b/i);
        const rule = contextRule(f, job) ?? (isPlace(/\b(location|city)\b/i) ? here().city : ruleFor(label));
        if (!isSearch && !rule && !f.required) continue;
        const optSel = async () => {
          const lb = await el.getAttribute('aria-controls').catch(() => null);
          return lb ? `[id="${lb}"] [role="option"]` : '[role="option"]:visible';
        };
        const readOpts = async () => (await frame.locator(await optSel()).allInnerTexts().catch(() => [])).map((s) => s.trim()).filter(Boolean);
        await el.click();
        await jitter(350, 600);
        let opts = isSearch ? [] : await readOpts();
        if (!opts.length && !isSearch) { await el.press('ArrowDown').catch(() => {}); await jitter(300, 500); opts = await readOpts(); }
        for (let t = 0; !opts.length && !isSearch && t < 3; t++) {
          await el.press('Escape').catch(() => {}); await el.fill('').catch(() => {});
          await el.click({ force: true }).catch(() => {}); await jitter(700, 1100); opts = await readOpts();
        }
        if (!opts.length && rule && isSearch) {
          // Async search box (location, school): type, then take the best suggestion.
          await el.pressSequentially(String(rule).slice(0, 24), { delay: 40 });
          await jitter(1200, 1800);
          opts = await readOpts();
        }
        if (!opts.length) {
          if (process.env.JOBERT_DEBUG) console.log('[debug] no options for', label, 'value=', JSON.stringify(await el.inputValue().catch(() => '?')), (await frame.locator('[id*="listbox"]').last().innerHTML().catch(() => 'none')).slice(0, 700));
          await el.press('Escape').catch(() => {}); if (f.required) unanswered.push(label); continue;
        }
        const norm = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
        const SYN = { male: 'man', female: 'woman', man: 'male', woman: 'female', 'non binary': 'nonbinary', heterosexual: 'straight', straight: 'heterosexual' };
        // Self-identification: only exact or starts-with matches. Never infer something more specific than you chose.
        const EEO_Q = /gender|ethnic|race|orientation|disab|veteran|neurodiver|indigenous|minority|lgbt|transgender|hispanic|latin/i.test(label);
        const ACK_Q = /privacy (notice|policy)|i have read|i acknowledge|i understand|i consent|i certify|consent to (being )?record|record and transcribe|we use \w+ to record/i.test(label);
        // Exact → starts with → contains → an option named inside the answer ("Finance" in "Finance and Business Technology Management").
        const match = (a) => a && (opts.find((o) => norm(o) === norm(a)) || opts.find((o) => norm(o).startsWith(norm(a)))
          || (EEO_Q ? null : opts.find((o) => norm(o).includes(norm(a)))
            || opts.filter((o) => norm(o).length > 3 && ` ${norm(a)} `.includes(` ${norm(o)} `)).sort((x, y) => ` ${norm(a)} `.indexOf(` ${norm(x)} `) - ` ${norm(a)} `.indexOf(` ${norm(y)} `))[0]));
        const DECLINE = /decline|don.?t wish|do not wish|prefer not|not to (answer|say|disclose)|do not want|don.?t want|choose not/i;
        const WA_Q = /work authori[sz]ation|authori[sz]ed to work|eligib\w* to work|right to work|work permit|sponsor/i.test(label);
        // US answers apply when the question names the US, or the job is in the US and you live elsewhere.
        const usQ = !/^(us|usa|united states)$/i.test(P.country || '') && (/united states|\bu\.?s\.?a?\b|america/i.test(label) || countryOf(job.location)?.code === 'US');
        const authorized = (usQ ? A.authorizedToWorkUS : A.authorizedToWork) === 'Yes', needs = (usQ ? A.requiresSponsorshipUS : A.requiresSponsorship) === 'Yes';
        const waPick = WA_Q ? (authorized && !needs
          ? opts.find((o) => /authori[sz]ed|eligible|citizen|permanent resident|do not (require|need)|don.?t (require|need)|no sponsorship|^no\b/i.test(o) && !/\b(require|need)s?\b(?!.*not)|will require|^yes/i.test(o.replace(/do not (require|need)|don.?t (require|need)/i, '')))
          : opts.find((o) => /require|need|sponsor/i.test(o) && !/do not|don.?t|not require/i.test(o))) : null;
        let pick = waPick || (ACK_Q ? opts.find((o) => /^(yes|i (have|acknowledge|agree|understand|consent|confirm))|agree|acknowledge|understand/i.test(o) && !/not|don.?t|disagree/i.test(o)) : null)
          || match(rule) || (rule && SYN[norm(rule)] ? match(SYN[norm(rule)]) : null) || (isSearch && rule ? opts[0] : null)
          || (DECLINE.test(rule || '') ? opts.find((o) => DECLINE.test(o)) : null);
        // Your profile dates win for date fields; a saved answer is the fallback (e.g. "Spring/Summer 2028").
        const mine = recall(label, { options: opts, company: job.company });
        const fromProfile = contextRule(f, job);
        if (mine?.source === 'you' && !(fromProfile !== undefined && match(fromProfile))) pick = match(mine.answer) || pick;
        if (!pick && (f.required || rule)) pick = match(await answer(label, job, { options: opts, required: f.required, rule: null }));
        if (process.env.JOBERT_DEBUG) console.log('[debug] combo', label, '| rule:', rule, '| opts:', opts.slice(0, 6), '→', pick);
        if (pick) await frame.locator(await optSel()).filter({ hasText: pick }).first().click();
        else { await el.press('Escape').catch(() => {}); if (f.required) unanswered.push(label); }
        continue;
      }

      if (f.tag === 'select') {
        let ans = contextRule(f, job) ?? ruleFor(label);
        if (!ans && !f.required && !recall(label, { options: f.options, company: job.company })) continue;
        const match = (a) => f.options.find((o) => o.toLowerCase() === String(a).toLowerCase()) || f.options.find((o) => o.toLowerCase().startsWith(String(a).toLowerCase()));
        const mine = recall(label, { options: f.options, company: job.company });
        if (mine?.source === 'you') ans = mine.answer;
        let pick = (ans && match(ans)) || (/decline|not (want|wish)/i.test(ans || '') ? f.options.find((o) => /decline|don.?t wish|prefer not|not to (answer|say|disclose)|do not want/i.test(o)) : null);
        if (!pick) pick = match(await answer(label, job, { options: f.options, required: f.required, rule: null }));
        if (pick) await el.selectOption({ label: pick }); else if (f.required) unanswered.push(label);
        continue;
      }

      if (/cover letter/i.test(label) && f.tag === 'textarea') { await el.fill(docs.letterText); continue; }
      if (f.tag === 'textarea' && !SKILL_Q.test(label) && /\bwhy\b|interest|motivat|about yourself|additional information|good fit|great fit|make[s]? you|stand out|what draws|excite/i.test(label) && recall(label, { company: job.company })?.source !== 'you') {
        // Reuse the tailored cover letter body (skip greeting/sign-off) for motivation questions.
        const paras = docs.letterText.split(/\n\n+/).slice(1, 3).join('\n\n').replace(/^I am writing to apply[^.]*\.\s*/, '');
        await el.fill(paras);
        continue;
      }
      let ans = contextRule(f, job) ?? (recall(label, { company: job.company })?.source === 'you' ? null : ruleFor(label));
      if (!ans && f.required && /website|portfolio|url/i.test(label)) ans = P.linkedin; // required and nothing better
      if (!ans) {
        if (!f.required && !/why|interest/i.test(label) && !recall(label, { company: job.company })) continue;
        ans = await answer(label, job, { required: f.required, long: isLong(label, f.tag) });
      }
      if (ans) {
        await el.fill(ans);
        // Typeahead comboboxes (Greenhouse location, Ashby): pick the first suggestion.
        if (f.type === 'text' && /\b(location|city|school)\b/i.test(label)) {
          await jitter(700, 1200);
          await frame.locator('[role="option"], .pac-item, li[id*="option"]').first().click({ timeout: 1500 }).catch(() => {});
        }
      } else if (f.required) unanswered.push(label);
    } catch (e) {
      if (process.env.JOBERT_DEBUG) console.log('[debug]', label, '→', e.message.split('\n')[0]);
      if (f.required) unanswered.push(label);
    }
  }

  // Radio groups: rule first, otherwise ask the model to pick among the labels.
  for (const [, group] of radioGroups) {
    const optLabels = await Promise.all(group.map((g) => frame.locator(`[data-jobert="${g.idx}"]`).evaluate((el) =>
      (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.closest('label')?.innerText || el.value).catch(() => '')));
    const question = await frame.locator(`[data-jobert="${group[0].idx}"]`).evaluate((el) =>
      el.closest('fieldset')?.querySelector('legend')?.innerText || el.closest('[class*="question"], [class*="field"]')?.querySelector('label, [class*="label"]')?.innerText || '').catch(() => '');
    if (group[0].type === 'checkbox' && group.length === 1) continue; // single checkbox handled above
    const want = await answer(question, job, { options: optLabels.map((l) => l.trim()).filter(Boolean), required: group.some((g) => g.required) });
    const DECL = /decline|don.?t wish|do not wish|prefer not|not to (answer|say|disclose)|do not want|don.?t want|choose not/i;
    let i = want ? optLabels.findIndex((l) => l.trim().toLowerCase().startsWith(String(want).toLowerCase())) : -1;
    if (i < 0 && DECL.test(want || '')) i = optLabels.findIndex((l) => DECL.test(l));
    if (i >= 0) await frame.locator(`[data-jobert="${group[i].idx}"]`).check({ force: true }).catch(() => {});
    else if (group.some((g) => g.required)) unanswered.push(question);
  }
  return unanswered;
}

async function findFormFrame(page) {
  // The application form lives in whichever frame (main page or embedded ATS iframe) has the most inputs.
  let best = page.mainFrame(), most = -1;
  for (const fr of page.frames()) {
    const n = await fr.evaluate(() => document.querySelectorAll('input:not([type=hidden]), textarea, select').length).catch(() => 0);
    if (n > most) { most = n; best = fr; }
  }
  return best;
}

async function openApplication(page, job) {
  let url = job.apply_url;
  if (job.ats === 'lever' && !/\/apply/.test(url)) url = url.replace(/\/?(\?.*)?$/, '/apply$1');
  if (job.ats === 'ashby' && !/\/application/.test(url)) url = url.replace(/\/?(\?.*)?$/, '/application$1');
  // Greenhouse: many companies (Lyft, Stripe…) redirect to their own careers page and hide the form.
  // The standalone embed shows just the application, for any company.
  const gh = url.match(/greenhouse\.io\/(?:embed\/job_app\?for=)?([\w-]+)\/jobs\/(\d+)/) || url.match(/[?&]for=([\w-]+).*[?&]token=(\d+)/);
  if (job.ats === 'greenhouse' && gh) url = `https://job-boards.greenhouse.io/embed/job_app?for=${gh[1]}&token=${gh[2]}`;
  page.setDefaultTimeout(8000);
  await page.goto(url, { waitUntil: "domcontentloaded", timeout: 45000 });
  await jitter(2500, 4000);
  // Some pages hide the form behind an "Apply" button.
  await page.locator('a:has-text("Apply for this job"), button:has-text("Apply for this job"), button:has-text("Apply now"), a:has-text("Apply now")').first().click({ timeout: 2500 }).catch(() => {});
  await jitter(1000, 2000);
}

const SUCCESS = /thank you for (applying|your (application|interest))|application (has been |was )?(received|submitted)|we('| ha)ve received your application|successfully submitted|thanks for applying|application complete/i;
const BLOCKED = /error processing your application|please try again|verify (that )?you are (a )?human|recaptcha|unusual activity|something went wrong/i;

// Real people scroll and pause before submitting; invisible reCAPTCHA scores this behaviour.
async function humanize(page) {
  const vp = page.viewportSize() || { width: 1200, height: 800 };
  for (let i = 0; i < 6; i++) {
    await page.mouse.move(80 + Math.random() * (vp.width - 160), 80 + Math.random() * (vp.height - 160), { steps: 12 }).catch(() => {});
    await page.mouse.wheel(0, 250 + Math.random() * 300).catch(() => {});
    await jitter(350, 800);
  }
  await jitter(1500, 3000);
}

// Greenhouse sometimes emails an 8-character code before accepting the application.
async function enterEmailedCode(page, frame, job, sentAt) {
  const text = await frame.locator('body').innerText().catch(() => '');
  if (!/verification code was sent|enter the \d+-character code|security code/i.test(text)) return { needed: false };
  if (!canReadInbox()) return { needed: true, ok: false, reason: 'The site emailed you a security code — sign in to Gmail in Settings → Integrations and Joblin retries this by itself' };
  log('apply', `${job.company}: waiting for the emailed security code`);
  const code = await waitForCode({ company: job.company, sinceMs: sentAt, length: 8 });
  if (!code) return { needed: true, ok: false, reason: 'The emailed security code didn’t arrive in time' };
  const boxes = frame.locator('input[id*="security"], input[name*="security"], input[aria-label*="ecurity"], input[maxlength="1"]');
  const n = await boxes.count();
  if (n >= code.length) for (let i = 0; i < code.length; i++) await boxes.nth(i).fill(code[i]);
  else if (n) await boxes.first().fill(code);
  else await frame.locator('input:visible').last().fill(code);
  await jitter(500, 900);
  return { needed: true, ok: true };
}

async function submit(page, frame) {
  await humanize(page);
  const btn = frame.locator('button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit Application"), button:has-text("Submit")').last();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const box = await btn.boundingBox().catch(() => null);
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 }).catch(() => {}); await jitter(300, 700); }
  const sentAt = Date.now();
  await btn.click({ timeout: 8000 });
  for (let i = 0; i < 25; i++) {
    if (i === 3) {
      const v = await enterEmailedCode(page, frame, submit.job || {}, sentAt);
      if (v.needed && !v.ok) return { ok: false, blocked: true, reason: v.reason, code: !canReadInbox() };
      if (v.needed) { await btn.click({ timeout: 8000 }).catch(() => {}); }
    }
    await jitter(800, 1000);
    const text = await page.locator('body').innerText().catch(() => '');
    if (SUCCESS.test(text) || /confirmation|thank/i.test(page.url())) return { ok: true };
    if (BLOCKED.test(text) && i > 2) return { ok: false, blocked: true, reason: 'The site’s bot check stopped the automatic submit' };
  }
  const errs = await frame.locator('[class*="error"]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
  return { ok: false, reason: errs.filter(Boolean).slice(0, 3).join('; ') || 'no confirmation page' };
}

async function saveProof(page, job, docs) {
  const file = path.join(path.dirname(docs.resumePath), 'confirmation.png');
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  db.prepare('UPDATE applications SET proof_path = ? WHERE job_id = ?').run(file, job.id);
}

async function markSubmitted(page, job, docs, how) {
  await saveProof(page, job, docs);
  setStatus(job.id, 'submitted', how);
  db.prepare(`UPDATE tasks SET done = 1 WHERE related_job_id = ? AND title LIKE 'Finish application%'`).run(job.id);
  await startOutreach(job, docs);
  log('apply', `✓ Applied: ${job.title} @ ${job.company}${how ? ` (${how})` : ''}`);
}

// Leave the filled form open in Chrome for you, and watch for the confirmation page.
function handOff(page, job, docs, why) {
  setStatus(job.id, 'needs_review', `${why} — finish it in the open Chrome window`);
  addTask({ title: `Finish application: ${job.title} @ ${job.company}`, detail: `${why}. Joblin filled the form and left it open in Chrome: check it and click Submit. Joblin marks it Applied when the confirmation shows.`, url: job.apply_url, priority: 1, jobId: job.id });
  log('apply', `Handed to you: ${job.title} @ ${job.company} — ${why}`);
  const release = holdOpen();
  // Don't interrupt you: stay hidden, send a quiet notification, and wait for "Show the form" in Joblin.
  notify('Joblin needs you', `${job.company}: ${why}`.slice(0, 180));
  markHeld(page); // keep this tab for you; later jobs use another hidden tab
  (async () => {
    const until = Date.now() + 45 * 60 * 1000;
    while (Date.now() < until && !page.isClosed()) {
      await new Promise((r) => setTimeout(r, 3000));
      const text = await page.locator('body').innerText().catch(() => '');
      if (SUCCESS.test(text) || /confirmation|thank/i.test(page.url())) { await markSubmitted(page, job, docs, 'you clicked Submit'); break; }
    }
    release();
  })();
}

// ---------- Stage 1: prepare (docs, fit score, contacts) ----------
export async function prepareJob(job, { precise } = {}) {
  const docs = await prepareDocuments(job, { precise });
  db.prepare(`UPDATE applications SET track=?, resume_path=?, cover_letter_path=?, cover_letter_text=?, match_score=?, analysis=?, letter_kind=?,
    status='pending_approval', updated_at=datetime('now') WHERE job_id=?`)
    .run(docs.track, docs.resumePath, docs.letterPath, docs.letterText, docs.score, JSON.stringify(docs.analysis), docs.letterKind, job.id);
  // Finding the people to email is slow web lookups; do it in the background (it's only needed after you apply).
  findContacts(job).catch((e) => log('error', `contacts ${job.company}: ${e.message}`));
  return docs;
}

const WRITERS = 2; // jobs written up at the same time (the model and PDF renderer can overlap two)
export async function prepareBatch(limit = config.mode.batchSize, onProgress = () => {}) {
  const jobs = db.prepare(`SELECT j.* FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.status = 'queued' ORDER BY j.discovered_at LIMIT ?`).all(limit);
  let next = 0, done = 0;
  const writer = async () => {
    while (next < jobs.length && !config.stopFind) {
      const job = jobs[next++];
      onProgress({ done, total: jobs.length, current: `${job.title} · ${job.company}` });
      try { await prepareJob(job); log('prepare', `Prepared ${job.title} @ ${job.company}`); }
      catch (e) { setStatus(job.id, 'failed', `prepare: ${e.message}`); log('error', `prepare ${job.company}: ${e.message}`); }
      done++;
      onProgress({ done, total: jobs.length, current: `${job.title} · ${job.company}` });
    }
  };
  await Promise.all(Array.from({ length: Math.min(WRITERS, jobs.length) }, writer));
  return jobs.length;
}

// Outreach is only queued once you've committed to the application.
async function startOutreach(job, docs) {
  try {
    const contacts = db.prepare('SELECT * FROM contacts WHERE job_id = ? AND unsubscribed = 0').all(job.id);
    if (contacts.length) await scheduleOutreach(job, contacts, docs);
  } catch (e) { log('error', `outreach ${job.company}: ${e.message}`); }
}

// ---------- Stage 2: submit (only approved jobs) ----------
export async function processJob(job, { dryRun = false } = {}) {
  let app = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(job.id);
  if (!app?.resume_path) { await prepareJob(job); app = db.prepare('SELECT * FROM applications WHERE job_id = ?').get(job.id); }
  const docs = { track: app.track, resumePath: app.resume_path, letterPath: app.cover_letter_path, letterText: app.cover_letter_text };

  const dup = alreadyApplied(job);
  if (dup) { setStatus(job.id, 'duplicate', `You already applied to this role at ${dup.company}`); log('apply', `Skipped duplicate: ${job.title} @ ${job.company}`); return 'skipped'; }
  if (job.easy_apply) { setStatus(job.id, 'manual', 'LinkedIn Easy Apply only'); await startOutreach(job, docs); return 'manual'; }
  if (!AUTOMATABLE.has(job.ats)) {
    setStatus(job.id, 'manual', `${job.ats} form — documents ready`);
    addTask({ title: `Apply manually: ${job.title} @ ${job.company}`, detail: `${job.ats} application. Tailored resume + cover letter are ready.`, url: job.apply_url || job.linkedin_url, priority: 3, jobId: job.id });
    await startOutreach(job, docs);
    return 'manual';
  }

  // Applications run in a real Chrome window (job sites block headless browsers). By default Joblin
  // hides that window so you never see it; it only comes forward when a form needs you.
  const hidden = config.apply.window !== 'visible';
  const ctx = await getContext({ headless: false, hidden });
  const page = await workPage(ctx, 'apply'); // the applier's own hidden tab: no new windows, no focus changes
  let handedOff = false;
  try {
    await openApplication(page, job);
    const frame = await findFormFrame(page);
    // Never press "submit" on a page that isn't really an application form.
    const shape = await frame.evaluate(() => ({ inputs: document.querySelectorAll('input:not([type=hidden]), textarea, select').length, file: document.querySelectorAll('input[type=file]').length })).catch(() => ({ inputs: 0, file: 0 }));
    if (shape.inputs < 4 || !shape.file) {
      setStatus(job.id, 'manual', 'Couldn’t find the application form on this page — apply on the company site');
      addTask({ title: `Apply yourself: ${job.title} @ ${job.company}`, detail: 'Joblin couldn’t find the application form on this site. Documents are ready on the Applications page.', url: job.apply_url, priority: 2, jobId: job.id });
      return 'manual';
    }
    const unanswered = await fillForm(frame, job, docs);
    if (dryRun || !config.apply.autoSubmit) {
      if (dryRun && process.env.JOBERT_SCREENSHOT) await page.screenshot({ path: process.env.JOBERT_SCREENSHOT, fullPage: true });
      setStatus(job.id, 'pending_approval', `Test run: form filled but not sent${unanswered.length ? ` — unanswered: ${unanswered.join(' | ')}` : ''}`);
      return 'prepared';
    }
    if (unanswered.length) {
      // Park it: each blocking question goes to Questions (merged with identical ones), and as soon as
      // you answer them all, this application re-queues itself and goes through.
      for (const q of unanswered) waitOn(remember(q, '', { company: job.company }), job.id);
      setStatus(job.id, 'needs_review', `Waiting for your answer: ${unanswered.slice(0, 3).join(' | ')}`);
      addTask({ title: `Answer ${unanswered.length === 1 ? 'a question' : `${unanswered.length} questions`} for ${job.company}`, detail: `${job.title}: ${unanswered.join(' | ')}. Answer on the Questions page and Joblin applies automatically.`, url: '#/answers', priority: 1, jobId: job.id });
      log('apply', `Waiting on you: ${job.title} @ ${job.company} (${unanswered.length} question${unanswered.length === 1 ? '' : 's'})`);
      return 'needs_review';
    }
    submit.job = job;
    const res = await submit(page, frame);
    if (res.ok) { await markSubmitted(page, job, docs, ''); return 'submitted'; }
    if (res.code) {
      // Nothing for you to do here: once Gmail is connected, Joblin re-runs it and types the code in itself.
      setStatus(job.id, 'needs_review', 'Waiting for the security code the site emailed you. Press Connect Gmail in Settings → Integrations and Joblin finishes this one by itself.');
      log('apply', `Waiting for Gmail: ${job.title} @ ${job.company} needs an emailed security code`);
      return 'needs_review';
    }
    // Keep a picture of what the page showed, so you (and Joblin) can see why it didn't confirm.
    const shot = path.join(path.dirname(docs.resumePath), 'what-happened.png');
    await page.screenshot({ path: shot, fullPage: true }).catch(() => {});
    db.prepare('UPDATE applications SET proof_path = ? WHERE job_id = ?').run(shot, job.id);
    const errText = await frame.locator('[class*="error"]:visible, [role="alert"]:visible, [aria-invalid="true"]').allInnerTexts().catch(() => []);
    if (errText.filter(Boolean).length) res.reason = `The form said: ${errText.filter(Boolean).slice(0, 3).join('; ')}`;
    handedOff = true;
    handOff(page, job, docs, res.reason);
    return 'needs_review';
  } catch (e) {
    setStatus(job.id, 'failed', e.message.slice(0, 300));
    log('error', `apply ${job.company}: ${e.message}`);
    return 'failed';
  } finally { if (!handedOff) await page.goto('about:blank').catch(() => {}); } // keep the tab for the next job
}

export async function applyApproved({ dryRun = false, limit = config.apply.maxApplicationsPerRun, onProgress = () => {} } = {}) {
  const jobs = db.prepare(`SELECT j.* FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.status = 'approved' ORDER BY a.match_score DESC LIMIT ?`).all(limit);
  const tally = {};
  for (const [i, job] of jobs.entries()) {
    onProgress({ done: i, total: jobs.length, current: `${job.title} · ${job.company}` });
    log('apply', `→ ${job.title} @ ${job.company} [${job.ats}]`);
    const r = await processJob(job, { dryRun });
    tally[r] = (tally[r] || 0) + 1;
    await jitter(2000, 4000);
  }
  return tally;
}
export { contextRule as _contextRule, ruleFor as _ruleFor };
