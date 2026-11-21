import { getContext, holdOpen, hideBrowser, workPage, markHeld } from './browser.js';
import path from 'node:path';
import { execFile } from 'node:child_process';
const notify = (title, text) => process.platform === 'darwin' && execFile('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`], () => {});
import { config, jitter } from './config.js';
import { db, log, addTask, setStatus, alreadyApplied } from './db.js';
import { prepareDocuments } from './documents.js';
import { generateJSON, clip } from './llm.js';
import { findContacts } from './contacts.js';
import { scheduleOutreach } from './mailer.js';
import { recall, remember, memoryFacts, waitOn } from './memory.js';

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
const RULES = [
  [/\bcity\b.*\b(province|state)\b|\b(province|state)\b.*\bcity\b|where do you (live|reside)|city.{0,20}live/i, () => `${P.city}, ${P.region}`],
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
  [/^(current )?(city|location)\b(?!.*\?)|^where (are you|do you live)/i, `${P.city}, ${P.region}`],
  [/\bcountry\b/i, P.country],
  [/\b(province|state)\b(?! of)/i, P.region],
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
  const inJob = /employ|experience|work/.test(sec) && !inEdu;
  if (/graduat|expected (completion|finish)|completion date/.test(L)) return fmt(P.graduationMonth, P.graduationYear);
  if (inEdu && isStart) return fmt(P.eduStartMonth, P.eduStartYear);
  if (inEdu && isEnd) return fmt(P.graduationMonth, P.graduationYear);
  if (inJob && isStart) return fmt(P.jobStartMonth, P.jobStartYear);
  if (inJob && isEnd) return fmt(P.jobEndMonth, P.jobEndYear);
  if (inJob && /company|employer/.test(L)) return P.currentEmployer;
  if (inJob && /title|position|role/.test(L)) return P.currentTitle;
  if (/(position|role|job).{0,30}(applying|interested)|which (role|position|job)/.test(L)) return job.title;
  return undefined;
}

const isJunk = (a) => !a || /^[.\s…-]*$|^n\/?a$|^none$|^unknown$/i.test(String(a).trim());

// One place that decides an answer: your saved answers → profile rules → earlier model answers → model.
// Whatever the model writes is saved, so similar questions later get the same answer.
// Used by the Questions page: draft an answer for a saved question without a specific job.
export async function suggestAnswer(question, options = null) {
  const a = await llmAnswer(question, options, { title: 'the role', company: 'the company', description: '' }, { mustAnswer: !options });
  if (!options) return a;
  const lo = a.toLowerCase();
  return options.find((o) => o.toLowerCase() === lo) || options.find((o) => o.toLowerCase().startsWith(lo)) || '';
}

// Questions about your own history or facts only you know. The model must never guess these.
const FACTUAL = /how many|number of|years? of (experience|work)|have you (ever|previously|already)|did you (ever|previously)|previously (worked|applied|interned)|currently (employed|enrolled|working)|completed to date|terms? completed|start date|graduation|citizenship|security clearance|criminal|convicted|referred by|employee id|student (id|number)|gpa|average|grade/i;

async function answer(label, job, { options = null, required = false, rule } = {}) {
  const opts = options?.length ? options : null;
  const mem = recall(label, { options: opts, company: job.company });
  if (mem?.source === 'you') return mem.answer;
  const r = rule !== undefined ? rule : ruleFor(label);
  if (r) return r;
  if (mem) return mem.answer;
  if (FACTUAL.test(label)) { remember(label, '', { options: opts, company: job.company }); return ''; } // ask you instead
  let a = await llmAnswer(label, opts, job);
  if (!a && required && !opts) a = await llmAnswer(label, null, job, { mustAnswer: true });
  remember(label, a, { options: opts, company: job.company });
  return a;
}

async function llmAnswer(label, options, job, { mustAnswer = false } = {}) {
  const opt = options?.length ? `Choose exactly one of these options: ${JSON.stringify(options.slice(0, 40))}` : 'Answer in 1–3 short sentences (or a single word/number if that is what is asked).';
  const out = await generateJSON(
    `You are filling a job application for ${P.firstName} ${P.lastName}, a ${P.degree} student at ${P.school} (graduating ${P.graduationYear}), based in ${P.city}, ${P.region}, ${P.country}.
Facts: authorized to work in ${P.country}: ${A.authorizedToWork}; needs sponsorship in ${P.country}: ${A.requiresSponsorship}; authorized to work in the US: ${A.authorizedToWorkUS}; needs US sponsorship: ${A.requiresSponsorshipUS}; willing to relocate: ${A.willingToRelocate}; start date: ${A.startDate}; current employer: ${P.currentEmployer} (${P.currentTitle}).
${mustAnswer ? 'This question is required: write a brief, honest, specific answer using the facts and the job description. Only leave it empty if it asks for a fact you cannot know (like an ID number).' : "If the question asks for information you don't have, answer with an empty string."}
Studies ${P.major || P.degree}${P.minor ? `, minor in ${P.minor}` : ''}${P.gpa ? `, GPA ${P.gpa}/${P.gpaScale || '4.0'}` : ''}, ${P.yearOfStudy || ''}.
${memoryFacts() ? `More about the candidate (from their memory): ${memoryFacts()}` : ''}
Job: ${job.title} at ${job.company}. ${clip(job.description, 800)}
Question: "${label}"
${opt}
If unsure for a yes/no eligibility question, prefer the honest answer from the facts. Never invent credentials.
Respond as JSON: {"answer": "..."}`, { answer: '' }, { temperature: 0.2, maxTokens: 150 });
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
        const rule = contextRule(f, job) ?? (isPlace(/\b(location|city)\b/i) ? P.city : ruleFor(label));
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
        let pick = (ACK_Q ? opts.find((o) => /^(yes|i (have|acknowledge|agree|understand|consent|confirm))|agree|acknowledge|understand/i.test(o) && !/not|don.?t|disagree/i.test(o)) : null)
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
      if (f.tag === 'textarea' && /\bwhy\b|interest|motivat|tell us about|about yourself|additional information|good fit|great fit|make[s]? you|stand out|what draws|excite/i.test(label) && recall(label, { company: job.company })?.source !== 'you') {
        // Reuse the tailored cover letter body (skip greeting/sign-off) for motivation questions.
        const paras = docs.letterText.split(/\n\n+/).slice(1, 3).join('\n\n').replace(/^I am writing to apply[^.]*\.\s*/, '');
        await el.fill(paras);
        continue;
      }
      let ans = contextRule(f, job) ?? (recall(label, { company: job.company })?.source === 'you' ? null : ruleFor(label));
      if (!ans && f.required && /website|portfolio|url/i.test(label)) ans = P.linkedin; // required and nothing better
      if (!ans) {
        if (!f.required && !/why|interest/i.test(label) && !recall(label, { company: job.company })) continue;
        ans = await answer(label, job, { required: f.required });
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

async function submit(page, frame) {
  await humanize(page);
  const btn = frame.locator('button[type="submit"], input[type="submit"], button:has-text("Submit application"), button:has-text("Submit Application"), button:has-text("Submit")').last();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  const box = await btn.boundingBox().catch(() => null);
  if (box) { await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2, { steps: 15 }).catch(() => {}); await jitter(300, 700); }
  await btn.click({ timeout: 8000 });
  for (let i = 0; i < 25; i++) {
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
  try { await findContacts(job); } catch (e) { log('error', `contacts ${job.company}: ${e.message}`); }
  return docs;
}

export async function prepareBatch(limit = config.mode.batchSize, onProgress = () => {}) {
  const jobs = db.prepare(`SELECT j.* FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.status = 'queued' ORDER BY j.discovered_at LIMIT ?`).all(limit);
  for (const [i, job] of jobs.entries()) {
    onProgress({ done: i, total: jobs.length, current: `${job.title} · ${job.company}` });
    try { await prepareJob(job); log('prepare', `Prepared ${job.title} @ ${job.company}`); }
    catch (e) { setStatus(job.id, 'failed', `prepare: ${e.message}`); log('error', `prepare ${job.company}: ${e.message}`); }
  }
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
  if (dup) { setStatus(job.id, 'skipped', `Already applied to this role at ${dup.company}`); log('apply', `Skipped duplicate: ${job.title} @ ${job.company}`); return 'skipped'; }
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
    const unanswered = await fillForm(frame, job, docs);
    if (dryRun || !config.apply.autoSubmit) {
      if (dryRun && process.env.JOBERT_SCREENSHOT) await page.screenshot({ path: process.env.JOBERT_SCREENSHOT, fullPage: true });
      setStatus(job.id, 'prepared', `Filled, not submitted (dry run)${unanswered.length ? ` — unanswered: ${unanswered.join(' | ')}` : ''}`);
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
    const res = await submit(page, frame);
    if (res.ok) { await markSubmitted(page, job, docs, ''); return 'submitted'; }
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
    await jitter(4000, 9000);
  }
  return tally;
}
export { contextRule as _contextRule, ruleFor as _ruleFor };
