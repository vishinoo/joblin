// Everything Joblin knows about your work history, read from all of your resumes (not just one role).
// Used for work-history blocks on applications, for answering questions, and for the Resumes page.
import fs from 'node:fs';
import { config } from '../core/config.js';
import { tracks, resumeFileFor } from './tracks.js';
import { regionOf as placeRegion } from '../../public/places.js';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

// "May 2026 – September 2026", "Jul 2026 - Present", "2024 – 2025" → { month, year } pairs.
function parsePoint(s) {
  s = String(s || '').trim().toLowerCase();
  if (!s) return null;
  if (/present|current|now|ongoing/.test(s)) return { current: true };
  const y = s.match(/\b(19|20)\d{2}\b/)?.[0] || '';
  const mi = MONTHS.findIndex((m) => new RegExp(`\\b${m.slice(0, 3)}`).test(s));
  return { month: mi >= 0 ? cap(MONTHS[mi]) : '', year: y };
}
export function parseDates(date) {
  const [a, b] = String(date || '').split(/\s*[–—-]\s*|\s+to\s+/i);
  const start = parsePoint(a) || {}, end = b ? parsePoint(b) : null;
  return { start, end: end?.current ? null : end, current: Boolean(end?.current) };
}
const sortKey = (p) => Number(p.start.year || 0) * 12 + Math.max(0, MONTHS.indexOf(String(p.start.month).toLowerCase()));

export const readResume = (id) => { try { return JSON.parse(fs.readFileSync(resumeFileFor(id), 'utf8')); } catch { return null; } };

// Positions in one resume, most recent first. kind: work | leadership | project
export function positionsOf(resume) {
  const out = [];
  for (const s of resume?.sections || []) {
    const kind = /project/i.test(s.title) ? 'project' : /leader|activit|volunteer|extracurric/i.test(s.title) ? 'leadership' : 'work';
    for (const i of s.items) {
      if (!i.org && !i.role) continue;
      out.push({ org: i.org, role: i.role, location: i.location || '', date: i.date || '', kind, section: s.title, bullets: i.bullets || [], ...parseDates(i.date) });
    }
  }
  return out.sort((a, b) => (b.current - a.current) || sortKey(b) - sortKey(a));
}

// Every position across all your resumes, merged (the same role in two resumes keeps its best bullets).
export function allPositions() {
  const seen = new Map();
  for (const t of tracks()) {
    for (const p of positionsOf(readResume(t.id))) {
      const key = `${p.org}|${p.role}`.toLowerCase().replace(/[^a-z0-9|]+/g, '');
      const prev = seen.get(key);
      if (!prev) seen.set(key, { ...p, tracks: [t.id] });
      else { prev.tracks.push(t.id); if (p.bullets.length > prev.bullets.length) prev.bullets = p.bullets; }
    }
  }
  return [...seen.values()].sort((a, b) => (b.current - a.current) || sortKey(b) - sortKey(a));
}

// Roles that belong in an application's "Employment" section: jobs and founder/leadership roles, newest first.
// Club roles and side projects only count when you founded or ran them as a business.
export function employmentHistory() {
  return allPositions().filter((p) => p.kind === 'work' || /founder|owner|operator/i.test(p.role));
}

// A compact background for model prompts: every role with its strongest bullets, plus projects and skills.
export function candidateBackground({ maxChars = 2600 } = {}) {
  // Roles you marked as leads go first (and are flagged), so answers draw on them before anything else.
  const leadKeys = new Set(tracks().flatMap((t) => [...(rolePrefs(t.id).leads || [])]));
  const roles = [...allPositions()].sort((a, b) => leadKeys.has(roleKey(b)) - leadKeys.has(roleKey(a)));
  const lines = roles.map((p) => `- ${p.role} at ${p.org} (${p.date || 'dates n/a'})${leadKeys.has(roleKey(p)) ? ' [a highlight: prefer this one]' : ''}: ${p.bullets.slice(0, 3).join(' ')}`);
  const extra = new Set(), skills = new Set();
  for (const t of tracks()) {
    const r = readResume(t.id);
    for (const pr of r?.projects || []) extra.add(typeof pr === 'string' ? pr : `${pr.name}: ${pr.description || ''}`);
    for (const s of r?.skills || []) skills.add(s);
  }
  const text = `Experience:\n${lines.join('\n')}${extra.size ? `\nProjects:\n${[...extra].map((x) => `- ${x}`).join('\n')}` : ''}${skills.size ? `\nSkills: ${[...skills].slice(0, 40).join(', ')}` : ''}`;
  return text.length > maxChars ? `${text.slice(0, maxChars)}…` : text;
}

// The role to put under "current employer / current title": a current job if there is one, else the latest.
export function currentRole() {
  const P = config.profile;
  if (P.currentEmployer) return { org: P.currentEmployer, role: P.currentTitle };
  const h = employmentHistory();
  return h.find((p) => p.current && p.kind === 'work') || h[0] || { org: '', role: '' };
}

// ---------- Your say in which roles matter most (Settings → Resumes: drag to reorder, pick the leads) ----------
export const roleKey = (p) => `${p.org}|${p.role}`.toLowerCase().replace(/[^a-z0-9|]+/g, '');
// { order: [keys] | null, leads: Set | null }: null means "let Joblin decide for each job".
export function rolePrefs(track) {
  const r = config.resumes?.[track] || {};
  return { order: r.roleOrder?.length ? r.roleOrder : null, leads: Array.isArray(r.leads) ? new Set(r.leads) : null };
}
// Your chosen order for a list of roles; roles you haven't placed keep their place after the ones you have.
export function applyOrder(items, order, keyOf = roleKey) {
  if (!order) return items;
  const pos = (x) => { const i = order.indexOf(keyOf(x)); return i < 0 ? order.length + items.indexOf(x) : i; };
  return [...items].sort((a, b) => pos(a) - pos(b));
}

// ---------- Where you can be based (Profile → "Places you can work from") ----------
// For "your city / location" questions, Joblin answers with whichever of your bases is closest to the job:
// same city first, then same province or state. Your street address and postal code always stay your real ones.
const regionOf = (s) => placeRegion(s)?.code || placeRegion(s)?.name || '';
export function homeFor(jobLocation = '') {
  const P = config.profile;
  const home = { city: P.city, region: P.region };
  const bases = [home, ...(P.bases || []).map((b) => { const [city, region] = String(b).split(/\s*,\s*/); return { city, region: region || regionOf(b) }; })].filter((b) => b.city);
  const loc = String(jobLocation).toLowerCase(), jobRegion = regionOf(jobLocation);
  return bases.find((b) => loc.includes(b.city.toLowerCase()))
    || bases.find((b) => b.region && jobRegion && regionOf(`, ${b.region}`) === jobRegion)
    || home;
}
