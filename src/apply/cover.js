// Cover-letter engine.
// 1. Analyze the posting: requirements, what the company cares about, tone.
// 2. Match each requirement to the strongest *real* resume bullet (deterministic).
// 3. Draft several openings, score them, keep the best.
// 4. Write evidence paragraphs grounded only in matched bullets; reject any sentence that invents numbers.
// 5. Assemble with a tone-appropriate frame. Every step has a safe fallback.
import fs from 'node:fs';
import { config } from '../core/config.js';
import { generateJSON, clip } from '../core/llm.js';
import { templateFileFor, tracks } from '../you/tracks.js';
import { rolePrefs, roleKey } from '../you/profile.js';
import { fitScore } from './score.js';

const STOP = new Set('the and for with you our are will that this from your have who can all work team role able into about strong including such using their they them its not may more other also what we us an or of to in on at by as be is a it this'.split(' '));
const tokens = (s) => (String(s).toLowerCase().match(/[a-z][a-z+#.&/-]{1,}/g) || []).filter((w) => !STOP.has(w) && w.length > 2);
const SYN = { excel: ['spreadsheet', 'modeling', 'modelling'], python: ['programming', 'scripting', 'code'], modeling: ['models', 'dcf', 'lbo', 'valuation'],
  stakeholders: ['leadership', 'clients', 'executives'], automate: ['automated', 'automation', 'workflows'], data: ['analytics', 'metrics', 'sql'],
  communication: ['pitched', 'presented', 'speaker', 'clients'], ai: ['llm', 'agents', 'agentic', 'machine'], backend: ['api', 'apis', 'databases', 'infrastructure'] };
function expand(words) {
  const set = new Set(words);
  for (const w of words) for (const [k, vs] of Object.entries(SYN)) if (w === k || vs.includes(w)) { set.add(k); vs.forEach((v) => set.add(v)); }
  return set;
}
const overlap = (a, bSet) => tokens(a).reduce((n, w) => n + (bSet.has(w) ? 1 : 0), 0);

const CLICHES = /\bexcited\b|\beager\b|directly aligns|\bmy passion\b|aligning perfectly|aligns perfectly|showcasing my|demonstrating my|thus (showcasing|demonstrating)|testament to|in today.s (complex|fast)|passionate|excited to apply|thrilled|dream (job|company)|perfect fit|esteemed|synergy|i believe i would|i am confident that|hit the ground running|go-getter|team player|fast-paced environment|look no further|to whom it may concern/i;

// Swap common filler for plain words instead of throwing a good paragraph away.
const SWAPS = [
  [/\baligns? perfectly with\b/gi, 'fits'], [/\baligns? closely with\b/gi, 'fits'], [/\bdirectly aligns? with\b/gi, 'fits'], [/\baligning perfectly with\b/gi, 'fitting'],
  [/\bI am (particularly |especially |really |very )?excited (about|by)\b/gi, 'I am drawn to'], [/\bI am (particularly |especially )?excited to\b/gi, 'I want to'],
  [/\bI am (particularly |especially )?eager to\b/gi, 'I want to'], [/\bmy eagerness to\b/gi, 'my wish to'], [/\beager(ness)?\b/gi, 'keen'],
  [/\bI am (particularly |especially )?thrilled\b/gi, 'I am glad'], [/\bpassionate about\b/gi, 'committed to'], [/\bmy passion for\b/gi, 'my interest in'],
  [/,? (thus |thereby )?(showcasing|demonstrating|highlighting) my [^.,;]+/gi, ''], [/\bin today'?s (fast-paced|complex|ever-changing) [a-z]+\b/gi, 'today'],
  [/\ba testament to\b/gi, 'evidence of'], [/\bI am particularly looking forward to\b/gi, 'I look forward to'],
];
export const decliche = (t) => SWAPS.reduce((acc, [re, to]) => acc.replace(re, to), String(t || ''));
// "Co-op/Intern, Accounting - Winter 2027" → "Accounting Co-op/Intern"; drops seasons, years and bracket tags.
export function proseTitle(title) {
  let t = String(title || '').replace(/\[[^\]]*\]|\([^)]*\)/g, ' ').replace(/\s[-–—|]\s*(summer|winter|fall|spring|autumn|20\d\d)[^,]*$/i, '').replace(/\b(summer|winter|fall|spring)\s+20\d\d\b/gi, '').replace(/\b20\d\d\b/g, '');
  const m = t.match(/^\s*(co-?op\/intern|co-?op|intern(ship)?|new grad)\s*,\s*(.+)$/i);
  if (m) t = `${m[3]} ${m[1]}`;
  return t.replace(/\s{2,}/g, ' ').replace(/[\s,–-]+$/, '').trim() || title;
}

// ---------- 1. Analyze ----------
function requirementLines(desc) {
  const lines = String(desc).split(/\n|•|·|(?<=\.)\s+(?=[A-Z])/).map((l) => l.trim()).filter((l) => l.length > 25 && l.length < 220);
  const want = /experience|ability|proficien|knowledge|familiar|skills?|understanding|you (have|bring|will)|degree|strong|comfortable/i;
  return lines.filter((l) => want.test(l)).slice(0, 8);
}

export async function analyzeJob(job) {
  const fallbackReqs = requirementLines(job.description).slice(0, 4).map((l) => l.replace(/^[-–\s]+/, '').slice(0, 110));
  const fin = /bank|capital|equity|invest|asset|wealth|fund|securities|financial/i.test(`${job.company} ${job.title}`);
  const a = await generateJSON(
    `Analyze this job posting for writing a cover letter.
Job: ${job.title} at ${job.company}
Posting: ${clip(job.description, 2200)}
Return JSON:
{"requirements": ["the 4 most important things they want, each under 12 words"],
 "company_focus": "noun phrase that completes the sentence \"${job.company}'s focus on ___\" (under 10 words, lowercase, from the posting)",
 "role_focus": "verb phrase that completes \"this role offers the opportunity to ___\" describing the main work (under 14 words, lowercase)",
 "tone": "formal" | "warm" | "startup"}`,
    { requirements: fallbackReqs, company_focus: '', role_focus: '', tone: fin ? 'formal' : 'warm' }, { temperature: 0.1, maxTokens: 320 });
  a.requirements = (Array.isArray(a.requirements) ? a.requirements : fallbackReqs).map(String).filter((r) => r.length > 3).slice(0, 4);
  if (!a.requirements.length) a.requirements = fallbackReqs.length ? fallbackReqs : [job.title];
  if (!['formal', 'warm', 'startup'].includes(a.tone)) a.tone = fin ? 'formal' : 'warm';
  if (config.coverLetter?.tone && config.coverLetter.tone !== 'auto') a.tone = config.coverLetter.tone;
  const tidy = (x) => String(x || '').trim().replace(/^(to|on|the opportunity to)\s+/i, '').replace(/[.;:!]+$/, '').replace(/^./, (c) => c.toLowerCase()).slice(0, 140);
  a.company_focus = tidy(a.company_focus);
  a.role_focus = tidy(a.role_focus);
  if (a.company_focus.split(' ').length > 14 || /[{}"]/.test(a.company_focus)) a.company_focus = '';
  if (a.role_focus.split(' ').length > 18 || /[{}"]/.test(a.role_focus)) a.role_focus = '';
  return a;
}

// ---------- 2. Evidence matching ----------
function allEvidence(resume) {
  const ev = [];
  for (const s of resume.sections) for (const i of s.items) for (const b of i.bullets) ev.push({ org: i.org, role: i.role, text: b });
  for (const p of resume.projects || []) ev.push({ org: p.split(':')[0], role: 'project', text: p });
  return ev;
}

export function matchEvidence(analysis, resume, job, track = resume.track) {
  const ev = allEvidence(resume);
  const leads = rolePrefs(track).leads; // roles you chose to lead with get first pick of the letter's evidence
  const jobWords = expand(tokens(`${job.title} ${job.description}`));
  const used = new Set();
  const pairs = analysis.requirements.map((req) => {
    const rWords = expand(tokens(req));
    const ranked = ev.map((e, idx) => ({ ...e, idx, score: overlap(e.text, rWords) * 3 + overlap(e.text, jobWords) * 0.5 + (/\d/.test(e.text) ? 1 : 0) + (leads?.has(roleKey(e)) ? 4 : 0) }))
      .filter((e) => !used.has(e.idx)).sort((a, b) => b.score - a.score);
    const best = ranked[0];
    if (best) used.add(best.idx);
    return { requirement: req, evidence: best };
  }).filter((p) => p.evidence);
  // Overall fit score 0-100 for ranking batches.
  const covered = pairs.filter((p) => p.evidence.score - (leads?.has(roleKey(p.evidence)) ? 4 : 0) >= 3).length; // fit ignores your lead boost
  const kw = [...jobWords].filter((w) => w.length > 3);
  const resumeWords = expand(tokens(ev.map((e) => e.text).join(' ') + ' ' + (resume.skills || []).join(' ')));
  const kwHit = kw.length ? kw.filter((w) => resumeWords.has(w)).length / kw.length : 0;
  const score = Math.round(Math.min(100, (covered / Math.max(1, analysis.requirements.length)) * 55 + Math.min(1, kwHit * 1.6) * 45));
  return { pairs, score };
}

// ---------- 3. Opening: draft N, keep the best ----------
function scoreOpening(s, job, analysis) {
  let n = 0;
  const words = s.split(/\s+/).length;
  if (s.includes(job.company)) n += 2;
  if (analysis.company_focus && overlap(s, new Set(tokens(analysis.company_focus))) > 0) n += 2;
  if (overlap(s, expand(tokens(job.description))) >= 3) n += 1;
  if (words >= 18 && words <= 45) n += 2; else if (words > 60) n -= 2;
  if (CLICHES.test(s)) n -= 4;
  if (/^i am writing/i.test(s)) n -= 2;
  if (/\bwe (are|'re|have)\b|\bour (team|company)\b|\byour (skills|experience|background)\b/i.test(s)) n -= 6; // written from the company's side
  if (/\?\?|\[|\{|lorem/i.test(s)) n -= 5;
  return n;
}

const ANGLES = [
  'Lead with what the company is trying to do and who it serves, then connect it to what the candidate wants to work on.',
  'Lead with the specific day-to-day work this role involves, then say why the candidate is drawn to exactly that work.',
  'Lead with an honest observation about the problem this team solves, then why the candidate wants to help solve it.',
];
const EXAMPLE = 'Write like a thoughtful person, not a template: concrete, plain words, about THIS company and THIS role only.';
const cleanGen = (s) => String(s || '').replace(/^[\s{.'"`]+|[\s}.'"`]+$/g, '').replace(/\s+/g, ' ').trim() + '.';

async function bestOpening(job, analysis, track, resume) {
  const focus = analysis.company_focus ? analysis.company_focus.charAt(0).toLowerCase() + analysis.company_focus.slice(1).replace(/^(a|the)\s+/i, '') : '';
  const fallback = `${job.company}${focus ? `'s focus on ${focus}` : `'s work`} is the kind of problem I want to spend my time on, and the ${job.title} role sits right where my ${track === 'swe' ? 'software and data' : 'finance and analytical'} experience points.`;
  const n = Math.max(1, Math.min(ANGLES.length, config.coverLetter?.variants || 3));
  const bg = resume.sections.flatMap((sec) => sec.items.slice(0, 2).map((i) => `${i.role} at ${i.org}`)).slice(0, 4).join('; ');
  const voice = analysis.tone === 'formal' ? 'polished, respectful, professional' : analysis.tone === 'startup' ? 'direct, plain-spoken, energetic' : 'warm, human, sincere';
  const cands = [];
  for (const angle of ANGLES.slice(0, n)) {
    const out = await generateJSON(
      `Write the opening of a cover letter: exactly 2 sentences, 25-45 words total.
Role: ${job.title} at ${job.company}. Company focus: ${focus || 'see posting'}.
Posting excerpt: ${clip(job.description, 700)}
Candidate studies ${config.profile.degree} (do not mention specific employers).
Angle: ${angle}
Voice: ${voice}; show real understanding and empathy for the people the company serves.
${EXAMPLE}
Rules: name ${job.company}; no clichés (passionate, excited, thrilled, eager, perfect fit, dream); do not start with "I am"; no numbers; plain text only.
Return JSON: {"opening": "..."}`,
      { opening: '' }, { temperature: 0.75, maxTokens: 160 });
    const o = typeof out.opening === 'string' ? out.opening : Object.values(out.opening || {})[0];
    const orgs = resume.sections.flatMap((x) => x.items.map((i) => i.org.split(/[ –-]/)[0])).filter((w) => w.length > 2);
    // Openings are about the company and role; experience claims belong in the checked evidence paragraph.
    if (o && o.length > 40 && !orgs.some((w) => o.includes(w)) && !/\b(as an intern|i helped|i built|i worked|i led)\b/i.test(o)) cands.push(cleanGen(o).replace(/\.\.$/, '.'));
  }
  cands.push(fallback);
  const ranked = cands.map((s) => ({ s, score: scoreOpening(s, job, analysis) })).sort((a, b) => b.score - a.score);
  return ranked[0].s;
}

// ---------- 4. Evidence paragraphs (grounded) ----------
const numbersIn = (s) => String(s).match(/\d[\d,.]*\+?[%kKmM]?/g) || [];
function grounded(text, sources) {
  const allowed = new Set(sources.flatMap(numbersIn).map((x) => x.replace(/[^\d]/g, '')));
  return numbersIn(text).every((x) => allowed.has(x.replace(/[^\d]/g, '')) || /^(19|20)\d\d$/.test(x));
}
const TECH = /\b(python|java(script)?|typescript|react|node(\.js)?|sql|excel|swift|c\+\+|c#|go|rust|aws|gcp|azure|docker|kubernetes|tableau|power ?bi|bloomberg|capital iq|vba|r|matlab|terraform|spark|tensorflow|pytorch|figma|salesforce|sap)\b/gi;
function claimsGrounded(text, corpus) {
  const have = corpus.toLowerCase();
  return (text.match(TECH) || []).every((t) => have.includes(t.toLowerCase()));
}
const lc = (s) => s.charAt(0).toLowerCase() + s.slice(1);
const VERB = /^(build|design|develop|work|support|analy[sz]e|create|manage|lead|own|write|help|conduct|prepare|perform|collaborate|partner|drive|deliver|maintain|implement|research|model|communicate|assist)\b/i;
function asNeed(req) {
  const r = lc(req.replace(/\.$/, '').replace(/^(you will|you'll|ability to|able to)\s+/i, ''));
  return VERB.test(r) ? `someone who can ${r}` : `someone with ${r.replace(/^(experience|strong|solid)\b/, (m) => m)}`;
}
function fallbackEvidence(pairs) {
  const [a, b] = pairs;
  const did = (p) => lc(p.evidence.text.replace(/^[^:]{2,40}:\s*/, '').replace(/\.$/, ''));
  const where = (p) => (p.evidence.role === 'project' ? `building ${p.evidence.org}` : `at ${p.evidence.org}`);
  let out = `Your team is looking for ${asNeed(a.requirement)}, and that is the work I have been doing: ${where(a)}, I ${did(a)}.`;
  if (b) out += ` The posting also calls for ${asNeed(b.requirement).replace(/^someone (who can|with) /, (m) => (m.includes('can') ? 'the ability to ' : ''))}; ${where(b)}, I ${did(b)}.`;
  return out;
}

// One sentence per requirement→evidence pair, written in isolation so the model can't mix up employers.
async function evidenceSentence(job, pair, analysis, i) {
  const e = pair.evidence;
  const where = e.role === 'project' ? `on my project ${e.org}` : `at ${e.org}`;
  const out = await generateJSON(
    `Write ONE or TWO sentences for a cover letter (max 45 words) showing the employer that the candidate has what they want.
The employer wants: ${pair.requirement}
The candidate's real experience, ${where}${e.role !== 'project' ? ` (${e.role})` : ''}: ${e.text}
Rules: first person; mention "${e.org}"; use ONLY this one experience; keep numbers exactly as written; do not claim any skill or tool not in that experience; ${analysis.tone === 'formal' ? 'professional' : 'warm, natural'} voice; no clichés.${i ? ' Begin with "I also".' : ''}
Return JSON: {"sentence": "..."}`,
    { sentence: '' }, { temperature: 0.4, maxTokens: 140 });
  const t = decliche(cleanGen(out.sentence).replace(/\.\.$/, '.'));
  const ok = t.length > 50 && t.includes(e.org.split(/[ –-]/)[0]) && grounded(t, [e.text, pair.requirement]) && claimsGrounded(t, e.text) && !CLICHES.test(t);
  return ok ? t : null;
}

async function evidenceParagraph(job, pairs, analysis) {
  if (!pairs.length) return '';
  const sentences = [];
  for (let i = 0; i < pairs.length; i++) sentences.push(await evidenceSentence(job, pairs[i], analysis, i));
  if (sentences.some((x) => !x)) {
    // Fill only the failed ones from the deterministic template.
    const fb = fallbackEvidence(pairs).split(/(?<=\.)\s+(?=(?:The posting|Your team))/);
    return sentences.map((x, i) => x || fb[i] || '').join(' ').trim();
  }
  return sentences.join(' ');
}

// ---------- 5. Assemble ----------
const CLOSINGS = {
  formal: (c) => `I would value the opportunity to discuss how I can contribute to ${c}'s team. Thank you for your time and consideration.`,
  warm: (c) => `I'd love the chance to talk about what your team is building and where I could help. Thank you for reading, and for considering my application to ${c}.`,
  startup: (c) => `If it's useful, I'm happy to walk through any of this work in detail. Thanks for taking a look, and I hope to talk soon about what ${c} is building.`,
};
const SIGNOFF = { formal: 'Sincerely,', warm: 'Warm regards,', startup: 'Best,' };

// ---------- Templates (cheap) and precise letters (for high-fit jobs) ----------
export function getTemplate(track) {
  const custom = config.coverLetter?.templates?.[track];
  if (custom && custom.trim()) return custom;
  return fs.readFileSync(templateFileFor(track), 'utf8');
}

function fillTemplate(tpl, job, analysis, track) {
  const fin = (tracks().find((t) => t.id === track)?.base || track) !== 'swe';
  const role_focus = analysis.role_focus || (fin ? 'apply financial analysis to real decisions alongside an experienced team' : 'build software that real users depend on alongside an experienced team');
  const company_focus = analysis.company_focus || (fin ? 'serving its clients with rigorous analysis' : 'building products people rely on');
  const name = `${config.profile.firstName} ${config.profile.lastName}`;
  return tpl.replace(/\{\{company\}\}/g, job.company).replace(/\{\{role\}\}/g, proseTitle(job.title))
    .replace(/\{\{role_focus\}\}/g, role_focus).replace(/\{\{company_focus\}\}/g, company_focus).replace(/\{\{name\}\}/g, name)
    .replace(/\{\{(\w+)\}\}/g, (m, k) => {
      const P = config.profile;
      const v = { first_name: P.firstName, school: P.school, major: P.major, degree: P.degree, city: P.city, current_employer: P.currentEmployer, current_title: P.currentTitle,
        graduation: [P.graduationMonth, P.graduationYear].filter(Boolean).join(' ') }[k];
      return v ?? m;
    })
    .replace(/\n{3,}/g, '\n\n').trim();
}

// A precise "why this role" paragraph written from the posting itself.
async function whyParagraph(job, analysis, track, fallback) {
  const out = await generateJSON(
    `Write one cover-letter paragraph (4-5 sentences, 80-110 words) explaining why the candidate wants THIS role at THIS company.
Role: ${proseTitle(job.title)} at ${job.company}.
What the company does / cares about: ${analysis.company_focus || 'see posting'}.
What the role involves: ${analysis.requirements.join('; ')}.
Posting: ${clip(job.description, 1600)}
Candidate: ${(tracks().find((t) => t.id === track)?.base || track) === 'swe' ? 'student developer who has built AI agent platforms and data tools' : 'finance and business technology student who wants to work where business, finance and technology meet'}.
Rules: start with "The ${proseTitle(job.title)} position at ${job.company}"; mention 2 specific things from the posting; first person; professional and sincere; no clichés; do not claim any experience, skill or number — this paragraph is about the role, not the candidate's résumé.
Return JSON: {"paragraph": "..."}`,
    { paragraph: '' }, { temperature: 0.45, maxTokens: 320 });
  const p = decliche(String(out.paragraph || '').replace(/\s+/g, ' ').trim());
  const words = p.split(' ').length;
  const ok = words >= 55 && words <= 150 && p.includes(job.company) && grounded(p, [job.description]) && claimsGrounded(p, job.description) && !CLICHES.test(p);
  return ok ? p : fallback;
}

export async function writeCoverLetter(job, track, resume, analysis, { precise } = {}) {
  analysis ??= await analyzeJob(job);
  const { pairs, score: raw } = matchEvidence(analysis, resume, job, track);
  const score = fitScore(raw, job, track); // shown on the job; also decides when a precise letter is worth writing
  const matches = pairs.map((p) => ({ requirement: p.requirement, evidence: p.evidence.text, org: p.evidence.org, strength: p.evidence.score }));
  const C = config.coverLetter || {};
  const wantPrecise = precise ?? (C.alwaysPrecise || score >= (C.preciseMinScore ?? 75));
  const base = fillTemplate(getTemplate(track), job, analysis, track);
  if (!wantPrecise) return { text: base, kind: 'template', analysis: { ...analysis, matches }, score };

  // Precise: keep your voice and structure; rewrite the role paragraph from the posting and
  // add a paragraph that maps their requirements to your real experience.
  const paras = base.split(/\n\s*\n/);
  const role = proseTitle(job.title);
  const roleIdx = paras.findIndex((p) => p.startsWith(`The ${role} position`) || (p.includes(role) && p.includes(job.company)));
  if (roleIdx > -1) paras[roleIdx] = await whyParagraph(job, analysis, track, paras[roleIdx]);
  // Prefer proof the template doesn't already state, and open by naming what they asked for.
  const said = new Set(tokens(base));
  const EDU = /degree|diploma|enrolled|pursuing|student|graduat|eligib|authori[sz]ed|gpa|major in|program/i;
  const fresh = pairs.filter((x) => !EDU.test(x.requirement)).filter((x) => { const tk = tokens(x.evidence.text); return tk.filter((w) => said.has(w)).length / Math.max(1, tk.length) < 0.6; });
  const use = (fresh.length ? fresh : pairs.filter((x) => !EDU.test(x.requirement))).slice(0, 2);
  let evidence = use.length ? await evidenceParagraph(job, use, analysis) : '';
  if (evidence) evidence = `${use.length > 1 ? 'Two parts of the posting stand out to me' : 'One part of the posting stands out to me'}: ${use.map((x) => lc(x.requirement.replace(/\.$/, ''))).join(', and ')}. ${decliche(evidence)}`;
  if (evidence) {
    const anchors = [config.profile?.school, config.profile?.currentEmployer].filter(Boolean);
    const expIdx = anchors.length ? paras.findIndex((p) => anchors.some((a) => p.includes(a))) : -1;
    paras.splice(expIdx > -1 ? expIdx + 1 : Math.max(1, roleIdx), 0, evidence);
  }
  // Keep it to one page: drop the long-term-ambition paragraph if the letter runs long.
  let text = paras.join('\n\n');
  if (text.split(/\s+/).length > 620) text = paras.filter((p) => !/^My long-term ambition/.test(p)).join('\n\n');
  return { text, kind: 'precise', analysis: { ...analysis, matches }, score };
}
