// Resume types ("tracks"). Each job is matched to the resume type that fits it best.
// You start with Software engineering and Finance; add more from the catalog (or your own) in Settings → Resumes.
import fs from 'node:fs';
import path from 'node:path';
import { config, paths, saveConfig } from './config.js';

// base: which existing resume a new type starts from until you upload your own.
export const CATALOG = [
  { id: 'swe', label: 'Software engineering', base: 'swe', keywords: ['software', 'developer', 'engineer', 'backend', 'frontend', 'full stack', 'full-stack', 'python', 'javascript', 'typescript', 'react', 'node', 'api', 'mobile', 'ios', 'android', 'web', 'devops', 'cloud', 'sde', 'programming'] },
  { id: 'finance', label: 'Finance', base: 'finance', keywords: ['finance', 'financial', 'investment', 'analyst', 'equity', 'valuation', 'capital markets', 'portfolio', 'asset management', 'wealth', 'credit', 'fp&a', 'treasury', 'private equity', 'venture'] },
  { id: 'investment-banking', label: 'Investment banking', base: 'finance', keywords: ['investment banking', 'm&a', 'mergers', 'acquisitions', 'deal', 'pitch', 'capital markets', 'summer analyst', 'leveraged finance'] },
  { id: 'accounting', label: 'Accounting', base: 'finance', keywords: ['accounting', 'accountant', 'audit', 'tax', 'cpa', 'gaap', 'ifrs', 'bookkeeping', 'reconciliation', 'month-end', 'journal entries', 'payable', 'receivable'] },
  { id: 'data', label: 'Data science & analytics', base: 'swe', keywords: ['data', 'analytics', 'data science', 'data scientist', 'machine learning', 'sql', 'tableau', 'power bi', 'statistics', 'insights', 'dashboard', 'bi '] },
  { id: 'ml', label: 'Machine learning & AI', base: 'swe', keywords: ['machine learning', 'ml ', 'ai ', 'deep learning', 'llm', 'nlp', 'computer vision', 'pytorch', 'tensorflow', 'research'] },
  { id: 'product', label: 'Product management', base: 'swe', keywords: ['product manager', 'product management', 'roadmap', 'product owner', 'pm ', 'user research', 'requirements'] },
  { id: 'consulting', label: 'Consulting & strategy', base: 'finance', keywords: ['consulting', 'consultant', 'strategy', 'advisory', 'transformation', 'case', 'client engagement'] },
  { id: 'business-analyst', label: 'Business analysis', base: 'finance', keywords: ['business analyst', 'business analysis', 'process improvement', 'requirements', 'stakeholder', 'operations analyst', 'reporting'] },
  { id: 'marketing', label: 'Marketing', base: 'finance', keywords: ['marketing', 'brand', 'growth', 'social media', 'content', 'seo', 'campaign', 'digital marketing', 'communications'] },
  { id: 'sales', label: 'Sales & business development', base: 'finance', keywords: ['sales', 'account executive', 'business development', 'bdr', 'sdr', 'partnerships', 'customer success', 'revenue'] },
  { id: 'operations', label: 'Operations & supply chain', base: 'finance', keywords: ['operations', 'supply chain', 'logistics', 'procurement', 'inventory', 'planning', 'fulfillment'] },
  { id: 'hr', label: 'People & HR', base: 'finance', keywords: ['human resources', 'hr ', 'recruiting', 'talent', 'people operations', 'recruiter'] },
  { id: 'design', label: 'Design (UX/UI)', base: 'swe', keywords: ['design', 'designer', 'ux', 'ui', 'figma', 'prototype', 'user experience', 'visual design'] },
  { id: 'security', label: 'Cybersecurity', base: 'swe', keywords: ['security', 'cybersecurity', 'soc', 'threat', 'vulnerability', 'penetration', 'iam'] },
  { id: 'mechanical', label: 'Mechanical engineering', base: 'swe', keywords: ['mechanical', 'cad', 'solidworks', 'manufacturing', 'thermal', 'hvac', 'product design engineer'] },
  { id: 'electrical', label: 'Electrical engineering', base: 'swe', keywords: ['electrical', 'circuit', 'pcb', 'embedded', 'firmware', 'power systems', 'hardware'] },
  { id: 'civil', label: 'Civil engineering', base: 'swe', keywords: ['civil', 'structural', 'construction', 'infrastructure', 'geotechnical', 'transportation engineer'] },
  { id: 'chemical', label: 'Chemical engineering', base: 'swe', keywords: ['chemical', 'process engineer', 'chemistry', 'refinery', 'materials'] },
  { id: 'energy', label: 'Energy & resources', base: 'finance', keywords: ['energy', 'oil', 'gas', 'midstream', 'power', 'renewable', 'utilities', 'mining', 'energy transition'] },
];

export const slugTrack = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'custom';

export function tracks() {
  const list = config.tracks?.length ? config.tracks : [{ id: 'swe' }, { id: 'finance' }];
  return list.map((t) => ({ ...(CATALOG.find((c) => c.id === t.id) || { label: t.label || t.id, base: t.base || 'finance', keywords: [] }), ...t }));
}
export const trackLabel = (id) => tracks().find((t) => t.id === id)?.label || CATALOG.find((c) => c.id === id)?.label || id;

export function addTrack(input) {
  const preset = CATALOG.find((c) => c.id === input || c.label.toLowerCase() === String(input).toLowerCase());
  const id = preset?.id || slugTrack(input);
  const cur = config.tracks?.length ? config.tracks : [{ id: 'swe' }, { id: 'finance' }];
  if (cur.some((t) => t.id === id)) return id;
  const def = preset ? { id } : { id, label: String(input).trim(), base: /engineer|software|data|design|tech|developer/i.test(input) ? 'swe' : 'finance', keywords: String(input).toLowerCase().split(/[^a-z&]+/).filter((w) => w.length > 2) };
  saveConfig({ tracks: [...cur, def] });
  return id;
}
export function removeTrack(id) {
  if (['swe', 'finance'].includes(id)) throw new Error('Software engineering and Finance are your base resumes and can’t be removed.');
  saveConfig({ tracks: tracks().filter((t) => t.id !== id).map(({ id: i, label, base, keywords }) => ({ id: i, ...(CATALOG.find((c) => c.id === i) ? {} : { label, base, keywords }) })) });
}

// Resume content for a type: its own file if you've confirmed one, else the type it's based on.
export function resumeFileFor(id) {
  const own = path.join(paths.resumes, `${id}.json`);
  if (fs.existsSync(own)) return own;
  const base = tracks().find((t) => t.id === id)?.base || 'finance';
  return path.join(paths.resumes, `${base === 'swe' ? 'swe' : 'finance'}.json`);
}
export const hasOwnResume = (id) => fs.existsSync(path.join(paths.resumes, `${id}.json`));

// Cover-letter template for a type: yours from Settings, else a default file, else its base's.
export function templateFileFor(id) {
  const own = path.join(paths.templates, `cover-${id}.txt`);
  if (fs.existsSync(own)) return own;
  const base = tracks().find((t) => t.id === id)?.base || 'finance';
  return path.join(paths.templates, `cover-${base === 'swe' ? 'swe' : 'finance'}.txt`);
}

// Score a job against every resume type you have. Returns [{ id, score }] best first.
export function scoreTracks(job) {
  const title = ` ${String(job.title || '').toLowerCase()} `, desc = ` ${String(job.description || '').toLowerCase()} `;
  const count = (t, w) => t.split(w).length - 1;
  return tracks().map((t) => {
    const kw = [...new Set([...(t.keywords || []), ...String(t.label || '').toLowerCase().split(/[^a-z&]+/).filter((w) => w.length > 3)])];
    return { id: t.id, score: kw.reduce((n, w) => n + count(title, w) * 4 + Math.min(count(desc, w), 6), 0) };
  }).sort((a, b) => b.score - a.score);
}
