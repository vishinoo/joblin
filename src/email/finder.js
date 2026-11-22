// Finds the people worth emailing about a job, and their email addresses, without paid tools:
//  - people: a LinkedIn people search in Joblin's own (signed-in) browser, e.g. "Stripe university recruiter";
//    your AI model (Ollama by default, or ChatGPT/Claude/Gemini if you added a key) picks the right ones.
//  - domain: the model names the company's email domain; Joblin checks the domain really receives mail.
//  - address: the pattern is learned from real addresses on the company's own site (first.last@, first@…),
//    else the most common pattern. If an email bounces, Joblin tries the next pattern (see inbox.js).
// Hunter.io, if you add a key, is only used to double-check an address.
import dns from 'node:dns/promises';
import { config } from '../core/config.js';
import { kv, log } from '../core/db.js';
import { generateJSON } from '../core/llm.js';
import { getContext, workPage, linkedinStatus } from '../apply/browser.js';
import { renderEmail, inferPattern, emailsOnPage, EMAIL_PATTERNS } from './people.js';

const DAY = 864e5;
const cached = (key, days, fn) => async (...args) => {
  const k = `${key}:${String(args[0]).toLowerCase()}${args[1] ? `:${args[1]}` : ''}`;
  const hit = kv.get(k, null);
  if (hit && Date.now() - hit.at < days * DAY) return hit.v;
  const v = await fn(...args);
  kv.set(k, { v, at: Date.now() });
  return v;
};

// ---------- Domain ----------
const mx = new Map();
export const receivesMail = (domain) => {
  if (!mx.has(domain)) mx.set(domain, dns.resolveMx(domain).then((r) => r.length > 0).catch(() => false));
  return mx.get(domain);
};
const ATS_HOST = /greenhouse|lever\.co|ashbyhq|workday|myworkdayjobs|smartrecruiters|icims|taleo|jobvite|bamboohr|linkedin|indeed|eightfold|oraclecloud|successfactors/;

export const companyDomain = cached('domain', 60, async (company, hint = '') => {
  const tries = [];
  if (hint && !ATS_HOST.test(hint)) tries.push(hint);
  const out = await generateJSON(
    `What is the email domain employees of the company "${company}" use (the part after @ in their work email)? Answer with the bare domain like "stripe.com". If you are not sure, give your best guess.
Respond as JSON: {"domain": "..."}`, { domain: '' }, { temperature: 0, maxTokens: 40 });
  const d = String(out.domain || '').toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, '').trim();
  if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)) tries.push(d);
  tries.push(`${company.toLowerCase().replace(/[^a-z0-9]/g, '')}.com`);
  for (const t of tries) if (await receivesMail(t)) return t;
  return '';
});

// ---------- Address pattern ----------
const PAGES = ['', '/contact', '/contact-us', '/about', '/about-us', '/careers', '/press', '/team'];
export const emailPattern = cached('pattern', 90, async (domain) => {
  const seen = [];
  for (const p of PAGES) {
    const html = await fetch(`https://${domain}${p}`, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0' } }).then((r) => (r.ok ? r.text() : '')).catch(() => '');
    seen.push(...emailsOnPage(html, domain).filter((e) => !/^(info|hello|contact|support|press|media|careers|jobs|hr|privacy|legal|sales|team|admin|help|security|billing|investors?|partners?)@/i.test(e)));
    const pat = inferPattern(seen, domain);
    if (pat) return { pattern: pat, from: 'site' };
  }
  const key = config.email.hunterApiKey;
  if (key) {
    const r = await fetch(`https://api.hunter.io/v2/domain-search?domain=${encodeURIComponent(domain)}&limit=1&api_key=${key}`).then((x) => x.json()).catch(() => null);
    const p = r?.data?.pattern; // e.g. "{first}.{last}"
    if (p) return { pattern: p, from: 'hunter' };
  }
  return { pattern: '{first}.{last}', from: 'common' }; // the most common pattern at mid and large companies
});
// The next pattern to try after a bounce, or null when they've all been tried.
export const nextPattern = (tried) => EMAIL_PATTERNS.find((p) => !tried.includes(p)) || null;

// ---------- People (LinkedIn search in Joblin's browser) ----------
const FIELD_PEOPLE = [
  [/financ|invest|bank|equity|capital|account|audit|fp&a|treasury|trading|quant|risk|wealth|credit/i, 'finance manager'],
  [/data|analytics|machine learning|\bml\b|\bai\b|scien/i, 'data science manager'],
  [/software|developer|engineer|backend|frontend|stack|platform|mobile/i, 'engineering manager'],
  [/market|brand|growth|content/i, 'marketing manager'],
  [/product/i, 'product manager'],
];
let peopleTurn = Promise.resolve();
async function searchLinkedInPeople(keywords) {
  const run = peopleTurn.then(async () => {
    const page = await workPage(await getContext(), 'people');
    try {
      await page.goto(`https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(keywords)}&origin=GLOBAL_SEARCH_HEADER`, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForSelector('main a[href*="/in/"]', { timeout: 10000 }).catch(() => {});
      if (/login|authwall|checkpoint/.test(page.url())) return [];
      // Each result card: profile link + the card's text lines (name, headline, location). Layout-independent.
      return await page.$$eval('main a[href*="/in/"]', (as) => {
        const seen = new Set(), out = [];
        for (const a of as) {
          const url = a.href.split('?')[0];
          if (seen.has(url) || /\/in\/(ACo|me\/?$)/.test(url)) continue;
          const card = a.closest('li, [data-chameleon-result-urn], div[class*="result"]') || a.parentElement;
          const lines = (card?.innerText || '').split('\n').map((s) => s.trim()).filter((s) => s && !/^(connect|message|follow|view|•|\d+(st|nd|rd|th)\+?|status is)/i.test(s)).slice(0, 6);
          if (!lines.length) continue;
          seen.add(url); out.push({ url, text: lines.join(' | ') });
          if (out.length >= 10) break;
        }
        return out;
      }).catch(() => []);
    } finally { await page.goto('about:blank').catch(() => {}); }
  });
  peopleTurn = run.catch(() => {});
  return run;
}

// Up to `max` people at the company worth emailing about this job: recruiters first, then someone on the team.
// Who counts: they work at the company now (per LinkedIn), and they either hire for this kind of role
// (campus / early-career / talent recruiters) or work on the team the role sits in (a manager or senior person).
const teamFor = (field, title) => (FIELD_PEOPLE.find(([re]) => re.test(`${field} ${title}`)) || [null, 'hiring manager'])[1];
const roleWords = (title) => String(title || '').replace(/\b(summer|fall|winter|spring|20\d\d|intern(ship)?|co-?op|student|new grad|program|early career|canada|\(.*?\)|[-–,|].*$)\b/gi, ' ').replace(/\s+/g, ' ').trim();
async function pickPeople(company, field, title, max, queries, exclude = []) {
  if (!linkedinStatus().connected) return [];
  const results = [];
  for (const q of queries) {
    results.push(...(await searchLinkedInPeople(q).catch((e) => { log('error', `people search ${company}: ${e.message}`); return []; })));
  }
  const skip = new Set(exclude.map((n) => String(n).toLowerCase()));
  const pool = results.filter((r, i) => results.findIndex((x) => x.url === r.url) === i && ![...skip].some((n) => r.text.toLowerCase().includes(n)));
  if (!pool.length) return [];
  const out = await generateJSON(
    `These are LinkedIn search results. Pick up to ${max} people who CURRENTLY work at "${company}" and would be good to email about a "${title || field}" internship/new-grad application:
recruiters (university/campus/early-career/talent acquisition) first, then a manager or senior person on the team this role sits in.
Skip anyone who doesn't clearly work at ${company} now, students, and people at other companies.
For each, say in a few words why they're a good person to email (e.g. "campus recruiter for Canada", "manages the tax team").
Results:
${pool.map((r, i) => `${i + 1}. ${r.text}`).join('\n')}
Respond as JSON: {"people": [{"n": <result number>, "name": "First Last", "title": "their role", "why": "short reason"}]}`,
    { people: [] }, { temperature: 0, maxTokens: 400 });
  const picked = [];
  for (const p of Array.isArray(out.people) ? out.people : []) {
    const r = pool[Number(p.n) - 1];
    const name = String(p.name || '').replace(/\s*[,(|].*$/, '').trim();
    if (!r || name.split(/\s+/).length < 2 || !r.text.toLowerCase().includes(name.split(/\s+/)[0].toLowerCase())) continue; // must really be in the results
    if (/^[a-z]\.?$/i.test(name.split(/\s+/).pop())) continue; // LinkedIn hid the last name ("Edward O."): no way to know their address
    // …and really at this company: its name must appear apart from the person's own name ("Ryan Mann" isn't proof of working at Ryan).
    const aside = r.text.replace(new RegExp(name.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'gi'), ' ');
    if (!new RegExp(`\\b${company.split(/\s+/)[0].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i').test(aside)) continue;
    if (picked.some((x) => x.name === name)) continue;
    picked.push({ name, title: String(p.title || '').slice(0, 120), linkedin: r.url, why: String(p.why || '').slice(0, 140) });
    if (picked.length >= max) break;
  }
  return picked;
}
export const findPeople = cached('people', 30, async (company, field, title = '', max = 3) =>
  pickPeople(company, field, title, max, [`${company} university recruiter`, `${company} ${teamFor(field, title)}`]));
// "More people at this company": wider searches around the role, skipping everyone already found.
export const findMorePeople = (company, field, title, max, exclude) => {
  const role = roleWords(title);
  return pickPeople(company, field, title, max, [`${company} recruiter`, `${company} talent acquisition`, ...(role ? [`${company} ${role} manager`, `${company} ${role}`] : [`${company} ${teamFor(field, title)}`])], exclude);
};

// An address for a person: Hunter's verified one if you have a key, else the company's pattern.
export async function emailFor(name, domain) {
  const key = config.email.hunterApiKey;
  const [first, ...rest] = name.split(/\s+/);
  if (key) {
    const r = await fetch(`https://api.hunter.io/v2/email-finder?domain=${encodeURIComponent(domain)}&first_name=${encodeURIComponent(first)}&last_name=${encodeURIComponent(rest.pop() || '')}&api_key=${key}`).then((x) => x.json()).catch(() => null);
    if (r?.data?.email && r.data.score >= 60) return { email: r.data.email.toLowerCase(), source: 'hunter', confidence: `verified ${r.data.score}`, pattern: '' };
  }
  const { pattern, from } = await emailPattern(domain);
  const email = renderEmail(pattern, name, domain);
  return email ? { email, source: from === 'common' ? 'guessed' : 'pattern', confidence: from === 'common' ? 'likely' : 'pattern from their site', pattern } : null;
}
