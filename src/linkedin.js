import { getContext, setLinkedinStatus, workPage } from './browser.js';
import { config, jitter } from './config.js';
import { db, log, findDuplicateJob } from './db.js';
import { detectATS } from './apply.js';

const TPR = { day: 'r86400', week: 'r604800', month: 'r2592000' };

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
async function collectJobIds(page, { keywords, location }) {
  const url = `https://www.linkedin.com/jobs/search/?keywords=${encodeURIComponent(keywords)}&location=${encodeURIComponent(location)}&f_TPR=${TPR[config.search.postedWithin] || TPR.week}&sortBy=DD`;
  const want = config.search.maxJobsPerQuery;
  const jobs = new Map();
  const grab = () => page.$$eval('[componentkey^="job-card-component-ref-"], [data-job-id], a[href*="/jobs/view/"]', (els) => els.map((e) => {
    const id = (e.getAttribute('componentkey') || '').match(/job-card-component-ref-(\d+)/)?.[1] || e.getAttribute('data-job-id') || (e.getAttribute('href') || '').match(/\/jobs\/view\/(\d+)/)?.[1];
    const card = e.closest('[componentkey^="job-card-component-ref-"], li') || e;
    return id ? { id, easyApply: /easy apply/i.test(card.innerText || '') } : null;
  }).filter(Boolean));
  for (let start = 0; jobs.size < want && start < 200; start += 25) {
    await page.goto(`${url}&start=${start}`, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await jitter(3000, 4500);
    if (/login|checkpoint|authwall|signup/.test(page.url())) { setLinkedinStatus(false, 'session expired'); throw new Error('LinkedIn session expired — reconnect in Settings → Integrations'); }
    setLinkedinStatus(true);
    const before = jobs.size;
    // The list lazy-loads: scroll the last card into view until nothing new appears.
    for (let i = 0, stale = 0; i < 14 && stale < 3 && jobs.size < want; i++) {
      const n = jobs.size;
      for (const j of await grab().catch(() => [])) if (!jobs.has(j.id)) jobs.set(j.id, j);
      stale = jobs.size === n ? stale + 1 : 0;
      await page.evaluate(() => {
        const cards = document.querySelectorAll('[componentkey^="job-card-component-ref-"], [data-job-id]');
        if (cards.length) cards[cards.length - 1].scrollIntoView({ block: 'end' });
        else (document.querySelector('.jobs-search-results-list, .scaffold-layout__list') || document.scrollingElement).scrollBy(0, 800);
      }).catch(() => {});
      await jitter(600, 1000);
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

// Reads one job in a single DOM pass (works with LinkedIn's new layout and the classic one).
async function readJob(page, id) {
  const linkedin_url = `https://www.linkedin.com/jobs/view/${id}/`;
  await page.goto(linkedin_url, { waitUntil: 'domcontentloaded', timeout: 45000 });
  await jitter(2500, 4000);
  await page.locator('button:has-text("See more"), button[aria-label*="see more" i], button:has-text("…more")').first().click({ timeout: 1200 }).catch(() => {});
  const d = await page.evaluate(() => {
    const t = document.title.replace(/\s*\|\s*LinkedIn\s*$/, '').split(' | ');
    const h1 = document.querySelector('h1')?.innerText.trim();
    const title = h1 || t[0] || '';
    const company = t[1] || document.querySelector('.job-details-jobs-unified-top-card__company-name, a[href*="/company/"]')?.innerText.trim().split('\n')[0] || '';
    // Description: the block under the "About the job" heading.
    let description = document.querySelector('#job-details, .jobs-description__content')?.innerText || '';
    if (!description) {
      const h = [...document.querySelectorAll('h2, h3')].find((x) => /about the job/i.test(x.innerText));
      let el = h?.parentElement;
      while (el && el.innerText.length < 400 && el.parentElement) el = el.parentElement;
      description = (el?.innerText || '').replace(/^[\s\S]*?about the job/i, '').trim();
    }
    // Location: "Toronto, ON · Reposted 1 day ago · …" line near the top.
    const top = document.body.innerText.split('\n').map((x) => x.trim()).filter(Boolean);
    const locLine = top.find((x) => /·/.test(x) && /(ago|applicants|clicked apply|people)/i.test(x)) || '';
    // Apply: external link (new layout) or button (classic). Easy Apply never leaves LinkedIn.
    const applyEls = [...document.querySelectorAll('a, button')].filter((b) => /apply/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`) && !/save|alert|similar/i.test(b.innerText));
    const easy = applyEls.some((b) => /easy apply/i.test(`${b.innerText} ${b.getAttribute('aria-label') || ''}`));
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
  } else if (!d.easy && d.hasApplyButton) {
    // Classic layout: clicking Apply opens the company's site in a new tab — capture its URL.
    const popup = page.context().waitForEvent('page', { timeout: 12000 }).catch(() => null);
    await page.locator('button.jobs-apply-button, button:has-text("Apply")').first().click({ timeout: 4000 }).catch(() => {});
    await page.locator('button:has-text("Continue")').first().click({ timeout: 2500 }).catch(() => {});
    const tab = await popup;
    if (tab) { await tab.waitForLoadState('domcontentloaded').catch(() => {}); apply_url = tab.url(); await tab.close(); }
  }

  let company_domain = '';
  try {
    const host = new URL(apply_url).hostname.replace(/^www\.|^careers\.|^jobs\./, '');
    if (apply_url && !/greenhouse|grnh|lever|ashby|workday|myworkdayjobs|smartrecruiters|icims|taleo|jobvite|bamboohr|linkedin|indeed|eightfold|oraclecloud|successfactors/.test(host)) company_domain = host;
  } catch {}
  if (!company_domain && d.hiring.length) company_domain = await Promise.race([companyDomainFromLinkedIn(page).catch(() => ''), new Promise((r) => setTimeout(() => r(''), 15000))]);

  return {
    linkedin_id: id, title: d.title, company: d.company, location: d.location, linkedin_url, apply_url,
    ats: apply_url ? detectATS(apply_url) : (d.easy ? 'linkedin_easy_apply' : 'unknown'),
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

export async function discover({ limit = config.sources?.linkedin?.maxPerRun ?? 30, onProgress = () => {} } = {}) {
  const ctx = await getContext();
  const page = await workPage(ctx, 'find');
  const exclude = config.search.excludeTitleWords.map((w) => w.toLowerCase());
  let added = 0;

  // Your positions, plus "position + company" searches for target companies without their own job board.
  const base = config.search.queries || [];
  const extra = (config.search.companies || []).filter((c) => !c.board).flatMap((c) => base.slice(0, 2).map((q) => ({ ...q, keywords: `${q.keywords} ${c.name}` })));
  const queries = config.search.onlyTargets && extra.length ? extra : [...extra, ...base];
  for (const [qi, q] of queries.entries()) {
    if (added >= limit) break;
    onProgress({ done: added, total: limit, current: `Search ${qi + 1} of ${queries.length}: ${q.keywords}` });
    log('discover', `Searching "${q.keywords}" in ${q.location}`);
    let ids;
    try { ids = await collectJobIds(page, q); } catch (e) { log('error', e.message); if (/session expired/.test(e.message)) break; continue; }
    const fresh = ids.filter((j) => !j.easyApply && !db.prepare('SELECT 1 FROM jobs WHERE linkedin_id = ?').get(j.id));
    log('discover', `LinkedIn: ${ids.length} results, ${fresh.length} new on company sites`);
    for (const { id } of fresh) {
      if (added >= limit) return added;
      onProgress({ done: added, total: limit, current: `Search ${qi + 1} of ${queries.length}: ${q.keywords}` });
      try {
        const read = await Promise.race([readJob(page, id), new Promise((_, rej) => setTimeout(() => rej(new Error('timed out reading job')), 60000))]);
        const job = { ...read, search_track: q.track || 'auto' };
        if (job.easy_apply || findDuplicateJob(job)) continue; // same job already found elsewhere
        if (!job.title) continue;
        if (exclude.some((w) => job.title.toLowerCase().includes(w))) continue;
        const r = insertJob.run(job);
        if (r.changes) {
          added++;
          db.prepare('INSERT OR IGNORE INTO applications (job_id) VALUES (?)').run(r.lastInsertRowid);
          log('discover', `+ ${job.title} @ ${job.company} [${job.ats}]`);
        }
      } catch (e) { log('error', `job ${id}: ${e.message}`); }
      await jitter(3000, 7000); // human-ish pacing; keep LinkedIn happy
    }
  }
  return added;
}
