import * as cheerio from 'cheerio';
import { getContext, setLinkedinStatus, workPage } from '../apply/browser.js';
import { config, jitter, activeSearch } from '../core/config.js';
import { db, log, kv, findDuplicateJob, addTask } from '../core/db.js';
import { detectATS } from '../apply/apply.js';
import { resolveCompany } from './chat.js';
import { fetchBoard, FIELDS } from './boards.js';
import { normTitle } from '../core/db.js';

const TPR = { day: 'r86400', week: 'r604800', month: 'r2592000' };

// ---------- Fair turns for every kind of job you want ----------
// Each run stops after ~30 new jobs, so the order of your searches decides what you get. Searches are grouped by
// field (finance, software…), fields take turns, and each run starts where the last one stopped. Fields you
// asked the chat about in the last 3 days go first.
const fieldOf = (q) => {
  if (q.track && q.track !== 'auto') return /swe|data|ml|software|security|design|product/.test(q.track) ? 'swe' : q.track === 'accounting' ? 'finance' : q.track;
  const k = q.keywords.toLowerCase();
  return FIELDS[0].words.test(k) || FIELDS[1].words.test(k) ? 'finance' : 'swe';
};
export const noteFocus = (queries) => kv.set('searchFocus', [...kv.get('searchFocus', []), ...queries.map((q) => ({ field: fieldOf(q), at: Date.now() }))].slice(-30));
export function fairOrder(queries) {
  const groups = new Map();
  for (const q of queries) { const f = fieldOf(q); if (!groups.has(f)) groups.set(f, []); groups.get(f).push(q); }
  const recent = kv.get('searchFocus', []).filter((x) => Date.now() - x.at < 3 * 864e5).map((x) => x.field).reverse();
  const order = [...groups.keys()].sort((a, b) => (recent.indexOf(a) < 0 ? 99 : recent.indexOf(a)) - (recent.indexOf(b) < 0 ? 99 : recent.indexOf(b)));
  const cursor = kv.get('searchCursor', 0);
  kv.set('searchCursor', cursor + 1);
  const lists = order.map((f) => { const g = groups.get(f); const k = cursor % g.length; return [...g.slice(k), ...g.slice(0, k)]; });
  const out = [];
  for (let i = 0; out.length < queries.length; i++) for (const l of lists) if (l[i]) out.push(l[i]);
  return out;
}

const insertJob = db.prepare(`INSERT OR IGNORE INTO jobs
  (linkedin_id, title, company, location, linkedin_url, apply_url, ats, company_domain, description, hiring_team, easy_apply, search_track)
  VALUES (@linkedin_id, @title, @company, @location, @linkedin_url, @apply_url, @ats, @company_domain, @description, @hiring_team, @easy_apply, @search_track)`);

async function firstText(page, selectors) {
  for (const s of selectors) {
    const el = page.locator(s).first();
    if (await el.count()) { const t = (await el.innerText().catch(() => '')).trim(); if (t) return t; }
  }
  return '';
}

// Returns [{ id, easyApply }] from the results list. Handles both LinkedIn layouts:
// the new one (cards with componentkey="job-card-component-ref-<id>") and the classic one (data-job-id).
const linkedinWasConnected = () => { try { return JSON.parse(db.prepare("SELECT v FROM kv WHERE k = 'linkedin'").get()?.v || '{}').connected; } catch { return false; } };
async function collectJobIds(page, { keywords, location }) {
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&f_TPR=${TPR[config.search.postedWithin] || TPR.week}&sortBy=DD`;
  const want = config.search.maxJobsPerQuery;
  const jobs = new Map();
  const grab = () => page.$$eval('[componentkey^="job-card-component-ref-"], [data-job-id], [data-entity-urn*="jobPosting"], a[href*="/jobs/view/"]', (els) => els.map((e) => {
    const id = (e.getAttribute('componentkey') || '').match(/job-card-component-ref-(\d+)/)?.[1] || e.getAttribute('data-job-id')
      || (e.getAttribute('data-entity-urn') || '').match(/jobPosting:(\d+)/)?.[1] || (e.getAttribute('href') || '').match(/\/jobs\/view\/(?:[^/?]*-)?(\d{6,})/)?.[1];
    const card = e.closest('[componentkey^="job-card-component-ref-"], [data-entity-urn*="jobPosting"], li') || e;
    return id ? { id, easyApply: /easy apply/i.test(card.innerText || '') } : null;
  }).filter(Boolean));
  for (let start = 0; jobs.size < want && start < 200; start += 25) {
    await page.goto(`${url}&start=${start}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForSelector('[componentkey^="job-card-component-ref-"], [data-job-id], [data-entity-urn*="jobPosting"]', { timeout: 8000 }).catch(() => {});
    await jitter(600, 1000);
    if (/login|checkpoint|authwall|signup/.test(page.url())) { setLinkedinStatus(false, 'session expired'); throw new Error('LinkedIn session expired — reconnect in Settings → Integrations'); }
    const signedOut = await page.evaluate(() => !!document.querySelector('a[href*="/login"], a[data-tracking-control-name*="sign-in"], .nav__button-secondary') && !document.querySelector('img.global-nav__me-photo, [data-test-global-nav-me]')).catch(() => false);
    if (signedOut) {
      if (linkedinWasConnected()) {
        setLinkedinStatus(false, 'signed out — reconnect to see everything');
        addTask({ title: 'Reconnect LinkedIn', detail: 'LinkedIn signed Joblin out. Joblin still finds public jobs, but reconnecting shows more. Settings → Integrations → Connect LinkedIn.', url: '#/settings', priority: 2 });
        log('linkedin', 'LinkedIn signed out — searching public listings instead');
      }
      await page.locator('button[aria-label*="Dismiss" i], .modal__dismiss, button.contextual-sign-in-modal__modal-dismiss').first().click({ timeout: 1500 }).catch(() => {});
    } else setLinkedinStatus(true);
    const before = jobs.size;
    // The list lazy-loads: scroll the last card into view until nothing new appears.
    for (let i = 0, stale = 0; i < 8 && stale < 2 && jobs.size < want; i++) {
      const n = jobs.size;
      for (const j of await grab().catch(() => [])) if (!jobs.has(j.id)) jobs.set(j.id, j);
      stale = jobs.size === n ? stale + 1 : 0;
      await page.evaluate(() => {
        const cards = document.querySelectorAll('[componentkey^="job-card-component-ref-"], [data-job-id]');
        if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
        else (document.querySelector('.jobs-search-results-list, .scaffold-layout__list') || document.scrollingElement).scrollBy(0, 800);
      }).catch(() => {});
      await jitter(350, 600);
    }
    if (jobs.size === before) break; // no more results
  }
  return [...jobs.values()].slice(0, want);
}

// Follow short links (grnh.se, lnkd.in, bit.ly…) to the real application page.
async function resolveUrl(url) {
  try {
    const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(15000), headers: { 'user-agent': 'Mozilla/5.0' } });
    return r.url || url;
  } catch { return url; }
}

// When LinkedIn hides the apply link (signed out), look for the same job on the company's own job board.
const boardCache = new Map();
async function findOnCompanyBoard(company, title) {
  if (!boardCache.has(company)) boardCache.set(company, resolveCompany(company).then((b) => (b ? fetchBoard(b) : [])).catch(() => []));
  const jobs = await boardCache.get(company);
  const want = normTitle(title), words = new Set(want.split(' ').filter((w) => w.length > 2));
  let best = null, bestScore = 0;
  for (const j of jobs) {
    const nt = normTitle(j.title); if (nt === want) return j.apply_url;
    const tw = nt.split(' ').filter((w) => w.length > 2); const hit = tw.filter((w) => words.has(w)).length / Math.max(words.size, tw.length, 1);
    if (hit > bestScore) { best = j; bestScore = hit; }
  }
  return bestScore >= 0.6 ? best.apply_url : '';
}

// Fast path: LinkedIn's public job page, fetched without Chrome (~0.5s instead of ~14s). It shows the
// title, company, location, description and whether the job applies on the company's site, but hides the
// link itself, so the job is found on the company's own job board. Returns null when the browser is needed
// (rate-limited, page changed, or a site Joblin can't submit to that you still want listed).
// LinkedIn allows ~10 quick requests before it says "too many": pace them, and when it does, pause and retry
// (still far faster than opening the job in Chrome).
let fastNext = 0;
const fastSlot = async (gap) => { const wait = Math.max(0, fastNext - Date.now()); fastNext = Math.max(fastNext, Date.now()) + gap; if (wait) await new Promise((r) => setTimeout(r, wait)); };
async function readJobFast(id, manualOk = false) {
  let r = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    await fastSlot(1500);
    r = await fetch(`https://www.linkedin.com/jobs-guest/jobs/api/jobPosting/${id}`, { signal: AbortSignal.timeout(12000), headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36', 'accept-language': 'en-US,en;q=0.9' } }).catch(() => null);
    if (r?.status !== 429) break;
    fastNext = Date.now() + 15000 * (attempt + 1); // everyone waits, then tries again
  }
  if (!r) return null;
  if (!r.ok) return null;
  const $ = cheerio.load(await r.text());
  const title = $('.topcard__title').first().text().trim(), company = $('.topcard__org-name-link').first().text().trim();
  const description = $('.show-more-less-html__markup').first().text().replace(/\s+\n/g, '\n').trim();
  if (!title || !company || !description) return null;
  const offsite = /apply-link-offsite/.test($.html());
  const base = { linkedin_id: id, title, company, location: $('.topcard__flavor--bullet').first().text().trim(), linkedin_url: `https://www.linkedin.com/jobs/view/${id}/`,
    description, hiring_team: '[]', company_domain: '' };
  if (!offsite) return { ...base, apply_url: '', ats: 'linkedin_easy_apply', easy_apply: 1 };
  const apply_url = await findOnCompanyBoard(company, title).catch(() => '');
  if (!apply_url) return manualOk ? null : { ...base, apply_url: '', ats: 'company_site', easy_apply: 0 };
  return { ...base, apply_url, ats: detectATS(apply_url), easy_apply: 0 };
}

// Reads one job in a single DOM pass (works with LinkedIn's new layout and the classic one).
async function readJob(page, id) {
  const linkedin_url = `https://www.linkedin.com/jobs/view/${id}/`;
  await page.goto(linkedin_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForSelector('h1, .show-more-less-html__markup, #job-details', { timeout: 8000 }).catch(() => {});
  await jitter(700, 1200);
  await page.locator('button:has-text("See more"), button[aria-label*="see more" i], button:has-text("…more")').first().click({ timeout: 1200 }).catch(() => {});
  const d = await page.evaluate(() => {
    const t = document.title.replace(/\s*\|\s*LinkedIn\s*$/, '').split(' | ');
    const h1 = document.querySelector('h1')?.innerText.trim();
    const title = h1 || t[0] || '';
    const org = document.querySelector('.topcard__org-name-link, .topcard__flavor a')?.innerText.trim();
    const company = org || (t[1] && !/linkedin/i.test(t[1]) ? t[1] : '') || document.querySelector('.job-details-jobs-unified-top-card__company-name, a[href*="/company/"]')?.innerText.trim().split('\n')[0] || '';
    // Description: the block under the "About the job" heading.
    let description = document.querySelector('#job-details, .jobs-description__content, .show-more-less-html__markup, .description__text')?.innerText || '';
    if (!description) {
      const h = [...document.querySelectorAll('h2, h3')].find((x) => /about the job/i.test(x.innerText));
      let el = h?.parentElement;
      while (el && el.innerText.length < 400 && el.parentElement) el = el.parentElement;
      description = (el?.innerText || '').replace(/^[\s\S]*?about the job/i, '').trim();
    }
    // Location: "Toronto, ON · Reposted 1 day ago · …" line near the top.
    const top = document.body.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
    const locLine = document.querySelector('.topcard__flavor--bullet')?.innerText.trim() || top.find((x) => /·/.test(x) && /(ago|applicants|clicked apply|people)/i.test(x)) || '';
    // Apply: external link (new layout) or button (classic). Easy Apply never leaves LinkedIn.
    const applyEls = [...document.querySelectorAll('a, button')].filter((b) => /apply/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`) && !/save|alert|similar/i.test(b.innerText));
    const easy = applyEls.some((b) => /easy apply/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`) || /apply-link-onsite/.test(b.getAttribute('data-tracking-control-name') || ''));
    const ext = applyEls.find((b) => b.tagName === 'A' && /company website|^apply$/i.test(`${b.getAttribute('aria-label') || b.innerText}`.trim()));
    const team = [...document.querySelectorAll('section, div')].find((x) => /meet the hiring team/i.test(x.firstElementChild?.innerText || ''));
    const hiring = team ? [...team.querySelectorAll('a[href*="/in/"]')].map((a) => {
      const lines = (a.closest('div')?.innerText || a.innerText).split('\n').map((x) => x.trim()).filter(Boolean);
      return { name: lines[0]?.replace(/\s*(•|·).*$/, ''), title: lines.find((l, i) => i > 0 && l.length > 6 && !/connection|message|job poster/i.test(l)) || '', profileUrl: a.href.split('?')[0] };
    }).filter((p) => p.name && p.name.split(' ').length <= 5) : [];
    return { title, company, description, location: locLine.split('·')[0].trim(), easy, applyHref: ext?.getAttribute('href') || '', hasApplyButton: applyEls.length > 0, hiring };
  });

  let apply_url = '';
  if (d.applyHref) {
    let u = d.applyHref;
    try { const inner = new URL(u, 'https://www.linkedin.com').searchParams.get('url'); if (inner) u = inner; } catch {}
    apply_url = /linkedin\.com/.test(u) ? '' : await resolveUrl(u);
  }

  if (!apply_url && !d.easy && d.company) apply_url = await findOnCompanyBoard(d.company, d.title).catch(() => '');

  let company_domain = '';
  try {
    const host = new URL(apply_url).hostname.replace(/^www\.|^careers\.|^jobs\./, '');
    if (apply_url && !/greenhouse|grnh|lever|ashby|workday|myworkdayjobs|smartrecruiters|icims|taleo|jobvite|bamboohr|linkedin|indeed|eightfold|oraclecloud|successfactors/.test(host)) company_domain = host;
  } catch {}
  const ats = apply_url ? detectATS(apply_url) : (d.easy ? 'linkedin_easy_apply' : 'unknown');
  const keep = SUBMITTABLE.has(ats) || Boolean(config.sources?.linkedin?.includeManual);
  if (keep && !company_domain && d.hiring.length) company_domain = await Promise.race([companyDomainFromLinkedIn(page).catch(() => ''), new Promise((r) => setTimeout(() => r(''), 15000))]);

  return {
    linkedin_id: id, title: d.title, company: d.company, location: d.location, linkedin_url, apply_url,
    ats,
    company_domain, description: d.description, hiring_team: JSON.stringify(d.hiring), easy_apply: d.easy && !apply_url ? 1 : 0,
  };
}

const domainCache = new Map();
async function companyDomainFromLinkedIn(page) {
  const href = await page.locator('.job-details-jobs-unified-top-card__company-name a, a[href*="/company/"]').first().getAttribute('href').catch(() => null);
  if (!href) return '';
  const base = new URL(href, 'https://www.linkedin.com').pathname.match(/\/company\/[^/]+/)?.[0];
  if (!base) return '';
  if (domainCache.has(base)) return domainCache.get(base);
  // Same tab (no new windows): the job has already been read, so it's safe to navigate away.
  await page.goto(`https://www.linkedin.com${base}/about/`, { waitUntil: 'domcontentloaded' });
  await jitter(1500, 2500);
  const site = await page.locator('dd a[href^="http"]:not([href*="linkedin.com"]), a[data-test-id="about-us__website"]').first().getAttribute('href').catch(() => '');
  const domain = site ? new URL(site).hostname.replace(/^www\./, '') : '';
  domainCache.set(base, domain);
  return domain;
}

const SUBMITTABLE = new Set(['greenhouse', 'lever', 'ashby']);
// LinkedIn jobs already read and passed over, so later searches don't read them again.
// reason 'manual' = on a site Joblin can't submit to (re-checked if you turn on "Also show jobs I'd submit myself").
db.exec(`CREATE TABLE IF NOT EXISTS linkedin_seen (id TEXT PRIMARY KEY, reason TEXT, at TEXT DEFAULT (datetime('now')))`);
const markSeen = db.prepare(`INSERT OR REPLACE INTO linkedin_seen (id, reason) VALUES (?, ?)`);
const wasSeen = db.prepare(`SELECT reason FROM linkedin_seen WHERE id = ? AND at > datetime('now', '-30 days')`);
const READERS = 3; // LinkedIn jobs read at the same time (from LinkedIn's public job pages, no Chrome)
// The few jobs that need Chrome take turns in the one search tab.
let chromeTurn = Promise.resolve();
const withChrome = (fn) => { const run = chromeTurn.then(fn); chromeTurn = run.catch(() => {}); return run; };
let skippedManual = 0;
export async function discover({ limit = config.sources?.linkedin?.maxPerRun ?? 30, onProgress = () => {} } = {}) {
  // The search tab, reopened if Chrome was closed mid-search (e.g. you connected LinkedIn or Gmail meanwhile).
  let page = await workPage(await getContext(), 'find');
  const tab = async () => { if (page.isClosed()) page = await workPage(await getContext(), 'find'); return page; };
  const exclude = config.search.excludeTitleWords.map((w) => w.toLowerCase());
  let added = 0;

  // Your positions, plus "position + company" searches for target companies without their own job board.
  const AS = activeSearch();
  // One-off chat searches use the place you asked for; saved searches use each position's place.
  // A search with no place uses your first place, then your country; LinkedIn treats an empty place as worldwide.
  const fallback = AS.locations[0] || config.profile?.country || '';
  const base = (AS.queries || []).map((q) => (AS.oneOff || !q.location ? { ...q, location: q.location || fallback } : q));
  const extra = (AS.companies || []).filter((c) => !c.board).flatMap((c) => base.slice(0, 2).map((q) => ({ ...q, keywords: `${q.keywords} ${c.name}` })));
  const queries = AS.oneOff ? [...extra, ...base] : fairOrder(AS.onlyTargets && extra.length ? extra : [...extra, ...base]);
  // No single search eats the whole run: each gets a share, so the next field still gets its turn.
  const share = AS.oneOff ? limit : Math.max(4, Math.ceil(limit / Math.min(queries.length, 4)));
  skippedManual = 0;
  for (const [qi, q] of queries.entries()) {
    if (added >= limit || config.stopFind) break;
    onProgress({ current: `Finding “${q.keywords}” listings${queries.length > 1 ? ` (search ${qi + 1} of ${queries.length})` : ""}…` });
    log('discover', `Searching "${q.keywords}" in ${q.location}`);
    let ids;
    try { ids = await collectJobIds(await tab(), q); } catch (e) { log('error', e.message); if (/session expired/.test(e.message)) break; continue; }
    const im = config.sources?.linkedin?.includeManual;
    const manualOk = im === true || (im === 'finance' && fieldOf(q) === 'finance'); // portal jobs (Workday…) you submit yourself
    const fresh = ids.filter((j) => {
      if (j.easyApply || db.prepare('SELECT 1 FROM jobs WHERE linkedin_id = ?').get(j.id)) return false;
      const seen = wasSeen.get(j.id);
      return !seen || (seen.reason === 'manual' && manualOk);
    });
    log('discover', `LinkedIn: ${ids.length} results, ${fresh.length} new to check`);
    let next = 0, done = 0;
    const startAdded = added;
    const progress = () => onProgress({ done, total: fresh.length, current: `“${q.keywords}”${queries.length > 1 ? ` (search ${qi + 1} of ${queries.length})` : ''} · ${added} added so far` });
    progress();
    // A few readers share the list: each takes the next job, reads it, and moves on.
    const reader = async () => {
      while (next < fresh.length && added < limit && added - startAdded < share && !config.stopFind) {
        const { id } = fresh[next++];
        try {
          let timer;
          const fast = await readJobFast(id, manualOk);
          const read = fast || await withChrome(async () => Promise.race([readJob(await tab(), id), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timed out reading job')), 45000); })])
            .catch(async (e) => {
              // A stuck read would fight the next job for the tab: send the tab to a blank page (no new tab).
              if (/timed out reading job/.test(e.message)) await page.goto('about:blank', { timeout: 5000 }).catch(() => {});
              throw e;
            }).finally(() => clearTimeout(timer)));
          const job = { ...read, search_track: q.track || 'auto' };
          if (job.easy_apply || findDuplicateJob(job)) { markSeen.run(id, 'other'); continue; } // same job already found elsewhere
          if (!SUBMITTABLE.has(job.ats) && !manualOk) { skippedManual++; markSeen.run(id, 'manual'); continue; } // only jobs Joblin can submit
          if ((job.description || '').length < 200 || !job.title || exclude.some((w) => job.title.toLowerCase().includes(w))) { markSeen.run(id, 'other'); continue; }
          if (added >= limit) break;
          const r = insertJob.run(job);
          if (r.changes) {
            added++;
            db.prepare('INSERT OR IGNORE INTO applications (job_id) VALUES (?)').run(r.lastInsertRowid);
            log('discover', `+ ${job.title} @ ${job.company} [${job.ats}]`);
          }
        } catch (e) { log('error', `job ${id}: ${e.message}`); }
        finally { done++; progress(); }
        await jitter(400, 900); // human-ish pacing per reader
      }
    };
    await Promise.all(Array.from({ length: Math.min(READERS, fresh.length) }, () => reader()));
    if (added >= limit || config.stopFind) break;
  }
  if (skippedManual) log('discover', `LinkedIn: skipped ${skippedManual} jobs on sites Joblin can’t submit to (Workday, iCIMS, company portals)`);
  return added;
}
