import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import pdf from 'pdf-parse/lib/pdf-parse.js';
import { paths, saveConfig } from './config.js';
import { reloadResumes } from './documents.js';

export async function extractText(file) {
  if (/\.pdf$/i.test(file)) return (await pdf(fs.readFileSync(file))).text;
  if (/\.(docx?|rtf|txt)$/i.test(file)) return execFileSync('textutil', ['-convert', 'txt', '-stdout', file], { encoding: 'utf8' });
  throw new Error('Upload a PDF or DOCX');
}

const MONTH = /(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+\d{4}|\b(19|20)\d{2}\b|present|current|class of/i;
const LOCATION = /,\s*[A-Z]{2}\b|remote/;
const BULLET = /^\s*[•●▪◦\-*]\s*/;
const HEADINGS = /^(education|work experience|experience|professional experience|relevant experience|projects|leadership|leadership experience|activities|extracurriculars|skills|additional information|technical skills|certifications|awards|volunteer)/i;

// Turns resume text into the structure the tailoring engine uses.
// Heuristic (WSO / standard one-column resumes); the Settings page shows the result for confirmation.
export function parseResume(text, track) {
  const lines = text.split(/\r?\n/).map((l) => l.replace(/\t+/g, '  ').trimEnd()).filter((l) => l.trim());
  const out = { track, headline: '', education: [], sections: [], skills: [], projects: [], certifications: '', interests: '' };
  let section = null, item = null, header = [];

  const flushHeader = () => {
    if (!header.length) return;
    const parts = header.flatMap((h) => h.split(/\s{2,}/)).map((s) => s.trim()).filter(Boolean);
    const date = parts.find((p) => MONTH.test(p)) || '';
    const location = parts.find((p) => p !== date && LOCATION.test(p)) || '';
    const rest = parts.filter((p) => p !== date && p !== location);
    item = { org: rest[0] || '', role: rest.slice(1).join(' – '), location, date, bullets: [] };
    if (section) section.items.push(item);
    header = [];
  };

  for (const raw of lines) {
    const line = raw.trim();
    if (HEADINGS.test(line) && line.length < 40 && (line === line.toUpperCase() || /^[A-Z][a-z]+( [A-Z][a-z]+)*$/.test(line))) {
      flushHeader();
      section = { title: line.replace(/\s+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\B\w+/g, (w) => w.toLowerCase()), items: [] };
      if (!/education/i.test(line)) out.sections.push(section); else section.isEducation = true;
      if (section.isEducation) out._edu = section;
      item = null;
      continue;
    }
    if (!section) continue; // name / contact block

    if (/^(additional information|skills|technical skills|certifications|awards)/i.test(section.title)) {
      let kv = line.replace(BULLET, '').match(/^([A-Za-z ]{3,25}):\s*(.*)$/);
      if (kv && !kv[2]) { out._pendingKey = kv[1]; continue; }
      if (!kv && out._pendingKey) { kv = [line, out._pendingKey, line.replace(BULLET, '')]; out._pendingKey = null; }
      if (kv && kv[2]) {
        const key = kv[1].toLowerCase();
        if (/skill|computer|technical|language/.test(key)) out.skills.push(...kv[2].replace(/^(analytical skills in|proficient in|experience (with|in))\s*/i, '').split(/[;,]\s*|\s+and\s+(?=[A-Z])/).filter(Boolean));
        else if (/certif/.test(key)) out.certifications = kv[2];
        else if (/interest/.test(key)) out.interests = kv[2];
        else if (/project/.test(key)) out.projects.push(kv[2]);
      } else if (BULLET.test(line) || out.projects.length) {
        const t = line.replace(BULLET, '');
        if (/^[A-Z][\w &/-]{2,40}:/.test(t)) out.projects.push(t); else if (out.projects.length && !BULLET.test(line)) out.projects[out.projects.length - 1] += ` ${t}`;
      }
      continue;
    }

    if (BULLET.test(line)) {
      flushHeader();
      if (!item) { item = { org: '', role: '', location: '', date: '', bullets: [] }; section.items.push(item); }
      item.bullets.push(line.replace(BULLET, ''));
    } else if (item && item.bullets.length && /^[a-z(&,]/.test(line)) {
      item.bullets[item.bullets.length - 1] += ` ${line}`; // wrapped bullet
    } else if (item && item.bullets.length && !MONTH.test(line) && !LOCATION.test(line) && header.length === 0
      && (line.split(' ').length > 6 || !/[.;!]\s*$/.test(item.bullets[item.bullets.length - 1]))) {
      item.bullets[item.bullets.length - 1] += ` ${line}`; // wrapped bullet starting uppercase
    } else {
      if (item && item.bullets.length) item = null;
      header.push(line);
      if (header.length >= 4) flushHeader();
    }
  }
  flushHeader();

  out.education = (out._edu?.items || []).map((e) => ({ school: e.org, degree: e.role, location: e.location, date: e.date, bullets: e.bullets }));
  delete out._edu; delete out._pendingKey;
  out.sections = out.sections.filter((s) => s.items.some((i) => i.bullets.length));
  out.skills = [...new Set(out.skills.map((s) => s.trim()).filter((s) => s && s.length < 60))];
  const roles = out.sections.flatMap((s) => s.items).slice(0, 2).map((i) => i.role).filter(Boolean);
  out.headline = track === 'swe' ? `Builder with experience as ${roles.join(' and ')}` : `Finance candidate with experience as ${roles.join(' and ')}`;
  return out;
}

export function parseQuality(r) {
  const bullets = r.sections.reduce((n, s) => n + s.items.reduce((m, i) => m + i.bullets.length, 0), 0);
  const items = r.sections.reduce((n, s) => n + s.items.length, 0);
  return { sections: r.sections.length, items, bullets, education: r.education.length, skills: r.skills.length, ok: bullets >= 4 && items >= 2 && r.education.length >= 1 };
}

// Save an uploaded file, parse it, and stage the parsed result for confirmation.
export async function importResume(track, filename, buf) {
  const ext = path.extname(filename).toLowerCase() || '.pdf';
  const dest = path.join(paths.uploads, `${track}-original${ext}`);
  fs.writeFileSync(dest, buf);
  const text = await extractText(dest);
  const parsed = parseResume(text, track);
  fs.writeFileSync(path.join(paths.uploads, `${track}-parsed.json`), JSON.stringify(parsed, null, 2));
  saveConfig({ resumes: { [track]: { originalFile: dest, originalName: filename } } });
  return { parsed, quality: parseQuality(parsed) };
}

export function confirmResume(track, data) {
  const file = path.join(paths.resumes, `${track}.json`);
  if (fs.existsSync(file)) fs.copyFileSync(file, path.join(paths.uploads, `${track}-backup-${Date.now()}.json`));
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  reloadResumes();
}
