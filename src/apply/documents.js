import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { config, paths, slug } from '../core/config.js';
import { generateJSON, clip } from '../core/llm.js';

import { writeCoverLetter as engineWrite, analyzeJob } from './cover.js';

import { tracks, resumeFileFor, scoreTracks, trackLabel } from '../you/tracks.js';
import { positionsOf, rolePrefs, roleKey, applyOrder } from '../you/profile.js';
import { db } from '../core/db.js';

// Resume content per type (falls back to the type it's based on until you confirm your own).
let cache = new Map();
export function reloadResumes() { cache = new Map(); }
export function getResume(track) {
  const file = resumeFileFor(track);
  if (!cache.has(file)) cache.set(file, JSON.parse(fs.readFileSync(file, 'utf8')));
  return cache.get(file);
}
const resumes = new Proxy({}, { get: (_, k) => getResume(String(k)) });

export const fill = (tpl, vars) => tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? '');
export const template = (name) => fs.readFileSync(path.join(paths.templates, name), 'utf8');

// ---------- Which resume fits this job: keyword scores across all your types, the model breaks close calls ----------
export async function chooseTrack(job) {
  const mine = tracks().map((t) => t.id);
  if (mine.includes(job.search_track)) return job.search_track;
  const ranked = scoreTracks(job);
  if (ranked.length < 2 || ranked[0].score - ranked[1].score >= 4 || ranked[0].score === 0 && ranked.length === 1) return ranked[0].id;
  const top = ranked.slice(0, 4);
  const out = await generateJSON(
    `Which resume fits this job best? Choose one id.
Options: ${top.map((t) => `"${t.id}" (${trackLabel(t.id)})`).join(', ')}
Job: ${job.title} at ${job.company}
Description: ${clip(job.description, 1200)}
Respond as JSON: {"track": "<id>"}`,
    { track: ranked[0].id }, { temperature: 0 });
  return top.some((t) => t.id === out.track) ? out.track : ranked[0].id;
}

// ---------- Resume tailoring: reorder real content, never invent ----------
function keywordsOf(text) {
  const stop = new Set('the and for with you our are will that this from your have who can all work team role able into about strong including such using their they them its not may more other also'.split(' '));
  const counts = {};
  for (const w of (text || '').toLowerCase().match(/[a-z][a-z+#.&-]{2,}/g) || []) if (!stop.has(w)) counts[w] = (counts[w] || 0) + 1;
  return counts;
}
const relevance = (line, kw) => (line.toLowerCase().match(/[a-z][a-z+#.&-]{2,}/g) || []).reduce((n, w) => n + (kw[w] ? Math.min(kw[w], 3) : 0), 0);

export async function tailorResume(job, track) {
  const base = structuredClone(resumes[track]);
  const kw = keywordsOf(`${job.title} ${job.title} ${job.description}`);

  // Most relevant bullets first within each role; most relevant skills first.
  for (const section of base.sections)
    for (const item of section.items)
      item.bullets.sort((a, b) => relevance(b, kw) - relevance(a, kw));
  // Your chosen role order (Settings → Resumes) sets the order within each section.
  const prefs = rolePrefs(track);
  if (prefs.order) for (const section of base.sections) section.items = applyOrder(section.items, prefs.order);
  base.skills.sort((a, b) => relevance(b, kw) - relevance(a, kw));

  const out = await generateJSON(
    `You tailor a resume summary. Write ONE sentence (max 30 words) summarizing the candidate for this job.
Only use facts from the candidate background. Do not invent experience, numbers, or skills.
Job: ${job.title} at ${job.company}
Job description: ${clip(job.description, 1500)}
Candidate background: ${base.headline}. Skills: ${base.skills.join(', ')}. Experience: ${base.sections.flatMap((s) => s.items.map((i) => `${i.role} at ${i.org}`)).join('; ')}
Respond as JSON: {"summary": "..."}`,
    { summary: base.headline });
  base.summary = String(out.summary || base.headline).slice(0, 260);
  return base;
}

// ---------- How a resume gets used: its roles, ranked for a real (or typical) job of that type ----------
export function resumeUsage(track) {
  const resume = getResume(track);
  const t = tracks().find((x) => x.id === track) || { label: track, keywords: [] };
  const real = db.prepare(`SELECT j.title, j.company, j.description FROM applications a JOIN jobs j ON j.id = a.job_id
    WHERE a.track = ? AND j.description != '' ORDER BY a.updated_at DESC LIMIT 1`).get(track);
  const job = real || { title: `${t.label} intern`, company: '', description: (t.keywords || []).join(' ') };
  const kw = keywordsOf(`${job.title} ${job.title} ${job.description}`);
  const roles = positionsOf(resume).map((p) => {
    const ranked = [...p.bullets].sort((a, b) => relevance(b, kw) - relevance(a, kw));
    const score = ranked.slice(0, 2).reduce((n, b) => n + relevance(b, kw), 0) + relevance(`${p.role} ${p.org}`, kw) * 2;
    return { org: p.org, role: p.role, date: p.date, kind: p.kind, current: p.current, bullets: p.bullets.length, leadBullet: ranked[0] || '', score };
  });
  // Your order and leads win; otherwise Joblin ranks by fit and leads with the top two.
  const prefs = rolePrefs(track);
  roles.forEach((r) => (r.key = roleKey(r)));
  const order = prefs.order ? applyOrder(roles, prefs.order, (r) => r.key) : [...roles].sort((a, b) => b.score - a.score);
  order.forEach((r, i) => { r.rank = i + 1; r.lead = prefs.leads ? prefs.leads.has(r.key) : i < 2 && r.score > 0; });
  return { custom: Boolean(prefs.order || prefs.leads), example: real ? { title: real.title, company: real.company, real: true } : { title: job.title, real: false }, roles,
    projects: (resume.projects || []).length, skills: (resume.skills || []).length };
}

// ---------- PDF rendering ----------
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const CSS = `
  @page { size: Letter; margin: 0.5in 0.6in; }
  body { font-family: 'Times New Roman', Times, serif; font-size: 10.5pt; color: #111; line-height: 1.25; }
  h1 { text-align: center; font-size: 17pt; margin: 0; letter-spacing: .5px; }
  .contact { text-align: center; font-size: 9.5pt; margin: 2px 0 6px; }
  .summary { font-style: italic; text-align: center; margin: 0 0 4px; font-size: 9.8pt; }
  h2 { font-size: 10.5pt; text-transform: uppercase; border-bottom: 1px solid #111; margin: 9px 0 3px; padding-bottom: 1px; }
  .row { display: flex; justify-content: space-between; } .b { font-weight: bold; } .i { font-style: italic; }
  ul { margin: 1px 0 4px 0; padding-left: 16px; } li { margin: 0 0 1px; }
  .letter p { margin: 0 0 11px; white-space: pre-wrap; } .letter { font-size: 11.5pt; line-height: 1.4; }`;

function contactLine() {
  const p = config.profile;
  return [`${p.city}, ${p.region}`, p.email, p.phone, p.linkedin, p.github].filter(Boolean).map(esc).join(' &nbsp;|&nbsp; ');
}

function resumeHTML(r) {
  const p = config.profile;
  const item = (i) => `
    <div class="row"><span class="b">${esc(i.org)}</span><span>${esc(i.location)}</span></div>
    <div class="row"><span class="i">${esc(i.role)}</span><span>${esc(i.date)}</span></div>
    <ul>${i.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`;
  return `<html><head><style>${CSS}</style></head><body>
    <h1>${esc(p.firstName)} ${esc(p.lastName)}</h1>
    <div class="contact">${contactLine()}</div>
    ${r.summary ? `<p class="summary">${esc(r.summary)}</p>` : ''}
    <h2>Education</h2>
    ${r.education.map((e) => `<div class="row"><span class="b">${esc(e.school)}</span><span>${esc(e.location)}</span></div>
      <div class="row"><span class="i">${esc(e.degree)}</span><span>${esc(e.date)}</span></div>
      <ul>${e.bullets.map((b) => `<li>${esc(b)}</li>`).join('')}</ul>`).join('')}
    ${r.sections.map((s) => `<h2>${esc(s.title)}</h2>${s.items.map(item).join('')}`).join('')}
    <h2>Additional Information</h2>
    <ul>
      <li><b>Skills:</b> ${esc(r.skills.join(', '))}</li>
      ${r.projects ? r.projects.map((x) => `<li>${esc(x)}</li>`).join('') : ''}
      ${r.certifications ? `<li><b>Certifications:</b> ${esc(r.certifications)}</li>` : ''}
      ${r.interests ? `<li><b>Interests:</b> ${esc(r.interests)}</li>` : ''}
    </ul></body></html>`;
}

// Cover letter layout modeled on a classic business letter: left-aligned header, date, greeting, body.
const LETTER_CSS = `
  @page { size: Letter; margin: 0.85in 0.95in; }
  body { font-family: 'Times New Roman', Times, serif; font-size: 11.5pt; line-height: 1.32; color: #111; margin: 0; }
  .who b { font-size: 1em; } .who div { margin: 0; } .who a { color: #111; text-decoration: underline; }
  .who .date { margin: 0 0 18px; }
  p { margin: 0 0 12px; text-align: left; }
  .sig { margin-top: 2px; white-space: pre-line; }`;
function letterHTML(text) {
  const p = config.profile;
  const date = new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' });
  const paras = text.split(/\n\s*\n/).map((x) => x.trim()).filter(Boolean);
  const signIdx = paras.findIndex((x) => /^(sincerely|best|regards|kind regards|warm regards|respectfully|yours)/i.test(x));
  const body = signIdx > -1 ? paras.slice(0, signIdx) : paras;
  const sign = signIdx > -1 ? paras.slice(signIdx).join('\n') : '';
  return `<html><head><style>${LETTER_CSS}</style></head><body>
    <div class="who"><b>${esc(p.firstName)} ${esc(p.lastName)}</b><div><a>${esc(p.email)}</a>, ${esc(p.phone)}</div>
    ${p.linkedin ? `<div>${esc(p.linkedin)}</div>` : ''}<div class="date">${esc(date)}</div></div>
    ${body.map((x) => `<p>${esc(x)}</p>`).join('')}${sign ? `<p class="sig">${esc(sign)}</p>` : ''}</body></html>`;
}

let pdfBrowser;
async function toPDF(html, file, { widthIn = 7.3, heightIn = 10, fitFont = false } = {}) {
  pdfBrowser ??= chromium.launch(); // shared promise: two writers at once still get one browser
  const page = await (await pdfBrowser).newPage();
  // Shrink to fit on one page (content box = page minus margins).
  await page.setViewportSize({ width: Math.round(widthIn * 96), height: Math.round(heightIn * 96) });
  await page.setContent(html, { waitUntil: 'load' });
  const max = heightIn * 96 - 8;
  let scale = 1;
  if (fitFont) {
    // Letters: shrink the font in small steps (keeps line length and margins honest).
    await page.evaluate(({ max, min }) => {
      let fs = parseFloat(getComputedStyle(document.body).fontSize);
      while (document.documentElement.scrollHeight > max && fs > min) { fs -= 0.25; document.body.style.fontSize = fs + 'px'; }
    }, { max, min: 13.2 });
  } else {
    const h = await page.evaluate(() => document.documentElement.scrollHeight);
    scale = Math.max(0.8, Math.min(1, max / h));
  }
  await page.pdf({ path: file, format: 'Letter', printBackground: true, scale });
  await page.close();
  return file;
}
export async function closePdfBrowser() { const b = pdfBrowser; pdfBrowser = null; await (await b)?.close().catch(() => {}); }

export async function renderLetter(dir, text) {
  const name = `${config.profile.firstName}_${config.profile.lastName}`;
  fs.writeFileSync(path.join(dir, 'cover_letter.txt'), text);
  return toPDF(letterHTML(text), path.join(dir, `${name}_Cover_Letter.pdf`), { widthIn: 6.6, heightIn: 9.3, fitFont: true });
}

// Build both documents for a job: track → analysis → tailored resume + optimized cover letter.
export async function prepareDocuments(job, { precise } = {}) {
  const track = await chooseTrack(job);
  const analysis = await analyzeJob(job);
  const [resume, letter] = await Promise.all([tailorResume(job, track), engineWrite(job, track, resumes[track], analysis, { precise })]);
  const dir = path.join(paths.output, `${job.id}-${slug(job.company)}-${slug(job.title)}`);
  fs.mkdirSync(dir, { recursive: true });
  const name = `${config.profile.firstName}_${config.profile.lastName}`;
  const rc = config.resumes?.[track];
  let resumePath;
  if (rc?.useOriginalFile && rc.originalFile && fs.existsSync(rc.originalFile) && /\.pdf$/i.test(rc.originalFile)) {
    resumePath = path.join(dir, `${name}_Resume.pdf`);
    fs.copyFileSync(rc.originalFile, resumePath);
  } else resumePath = await toPDF(resumeHTML(resume), path.join(dir, `${name}_Resume.pdf`));
  const letterPath = await renderLetter(dir, letter.text);
  return { track, resumePath, letterPath, letterText: letter.text, letterKind: letter.kind, analysis: letter.analysis, score: letter.score };
}

// Settings → Resumes → Preview: render the stored resume without job-specific tailoring.
export async function renderResumePreview(track) {
  const r = structuredClone(resumes[track]);
  const file = path.join(paths.uploads, `${track}-preview.pdf`);
  return toPDF(resumeHTML(r), file);
}

// Settings → Cover letter → sample: render a letter PDF into uploads for preview.
export async function renderSampleLetter(text) {
  return toPDF(letterHTML(text), path.join(paths.uploads, 'sample-cover-letter.pdf'), { widthIn: 6.6, heightIn: 9.3, fitFont: true });
}
