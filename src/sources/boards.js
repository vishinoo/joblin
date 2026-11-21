// Job source: companies' own public job boards (Greenhouse, Lever, Ashby).
// These are official public APIs meant for listing jobs, no login or scraping needed,
// and every job found here is one Joblin can submit automatically.
import { config, jitter } from '../config.js';
import { db, log, findDuplicateJob } from '../db.js';

export const DEFAULT_BOARDS = [
  // Canada-based or big Canadian hiring
  'ashby:wealthsimple', 'ashby:koho', 'ashby:neofinancial', 'ashby:lightspeedhq', 'ashby:1password', 'ashby:cohere', 'ashby:loopio', 'ashby:thinkific',
  'ashby:procurify', 'ashby:trulioo', 'greenhouse:geotab', 'greenhouse:hootsuite', 'greenhouse:d2l', 'greenhouse:faire', 'greenhouse:later', 'greenhouse:ritual',
  'greenhouse:tenstorrent', 'lever:achievers',
  // Tech
  'greenhouse:stripe', 'greenhouse:airbnb', 'greenhouse:databricks', 'greenhouse:robinhood', 'greenhouse:figma', 'greenhouse:discord', 'greenhouse:anthropic',
  'greenhouse:airtable', 'greenhouse:brex', 'greenhouse:coinbase', 'greenhouse:cloudflare', 'greenhouse:datadog', 'greenhouse:dropbox', 'greenhouse:duolingo',
  'greenhouse:gitlab', 'greenhouse:instacart', 'greenhouse:lyft', 'greenhouse:mongodb', 'greenhouse:okta', 'greenhouse:pinterest', 'greenhouse:reddit',
  'greenhouse:roblox', 'greenhouse:samsara', 'greenhouse:scaleai', 'greenhouse:twilio', 'greenhouse:vercel', 'greenhouse:asana', 'greenhouse:elastic',
  'greenhouse:pagerduty', 'greenhouse:squarespace', 'greenhouse:toast', 'greenhouse:verkada', 'ashby:openai', 'ashby:notion', 'ashby:linear', 'ashby:replit',
  'ashby:snowflake', 'ashby:benchling', 'ashby:miro', 'ashby:plaid', 'lever:palantir',
  // Finance & fintech
  'greenhouse:janestreet', 'greenhouse:imc', 'greenhouse:point72', 'greenhouse:jumptrading', 'greenhouse:akunacapital', 'greenhouse:flowtraders', 'greenhouse:virtu',
  'greenhouse:affirm', 'greenhouse:betterment', 'greenhouse:carta', 'greenhouse:chime', 'greenhouse:mercury', 'greenhouse:sofi', 'greenhouse:wise', 'greenhouse:ramp',
  'ashby:nubank',
];

const EARLY = /\b(intern|internship|co-?op|new ?grad|graduate|university|student|campus|junior|jr\.?|entry[- ]level|early[- ]career|summer analyst|analyst program|apprentice)\b/i;
const FIN_TITLE = /financ|invest|banking|analyst|equity|capital|asset|wealth|treasury|accounting|audit|fp&a|valuation|m&a|credit|portfolio|trading|trader|quant|risk|venture/i;
const strip = (html) => String(html || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ')
  .replace(/<(br|\/p|\/li|\/h\d|\/div)>/gi, '\n').replace(/<li[^>]*>/gi, '• ').replace(/<[^>]+>/g, ' ').replace(/[ \t]+/g, ' ').replace(/\n\s+/g, '\n').trim();
const pretty = (slug) => slug.replace(/[-_]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).replace(/hq$/i, '').trim();

async function getJSON(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(30000), headers: { 'user-agent': 'Joblin/1.0 (personal job search)' } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}

// Normalized listings: {key, title, company, location, apply_url, ats, description}
async function fetchBoard(entry) {
  const [ats, slug] = entry.split(':').map((s) => s.trim());
  if (ats === 'greenhouse') {
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs?content=true`);
    return j.jobs.map((x) => ({ key: `gh-${slug}-${x.id}`, title: x.title, company: x.company_name || pretty(slug), location: x.location?.name || '',
      // Use the Greenhouse-hosted form even when the company embeds it on its own site.
      apply_url: `https://job-boards.greenhouse.io/${slug}/jobs/${x.id}`, ats, description: strip(x.content) }));
  }
  if (ats === 'lever') {
    const j = await getJSON(`https://api.lever.co/v0/postings/${slug}?mode=json`);
    return j.map((x) => ({ key: `lv-${slug}-${x.id}`, title: x.text, company: pretty(slug), location: [x.categories?.location, ...(x.categories?.allLocations || [])].filter(Boolean).join(' / '),
      apply_url: x.hostedUrl, ats, description: [x.descriptionPlain, ...(x.lists || []).map((l) => `${l.text}\n${strip(l.content)}`), x.additionalPlain].filter(Boolean).join('\n\n') }));
  }
  if (ats === 'ashby') {
    const j = await getJSON(`https://api.ashbyhq.com/posting-api/job-board/${slug}`);
    return (j.jobs || []).filter((x) => x.isListed !== false).map((x) => ({ key: `ab-${slug}-${x.id}`, title: x.title, company: j.organizationName || pretty(slug),
      location: [x.location, ...(x.secondaryLocations || []).map((s) => s.location), x.isRemote ? 'Remote' : ''].filter(Boolean).join(' / '),
      apply_url: x.jobUrl || `https://jobs.ashbyhq.com/${slug}/${x.id}`, ats, description: x.descriptionPlain || strip(x.descriptionHtml) }));
  }
  return [];
}

// A city/country match wins; "Remote" only counts when it isn't tied to another country.
const ELSEWHERE = /\b(us|usa|u\.s\.|united states|america(?!s)|california|new york|washington|texas|seattle|boston|chicago|austin|denver|atlanta|miami|virginia|uk|united kingdom|london|ireland|dublin|india|germany|france|spain|poland|netherlands|singapore|japan|australia|brazil|mexico|israel|emea|apac|europe)\b/;
function locationOk(loc, places) {
  if (places.some((p) => p !== 'remote' && loc.includes(p))) return true;
  if (!places.includes('remote') || !/remote|anywhere/.test(loc)) return false;
  return !ELSEWHERE.test(loc) || /canada|north america|americas/.test(loc);
}

function targetWords() {
  const generic = /^(intern|internship|new|grad|graduate|summer|junior|jr|entry|level|co-?op|the|and|of|analyst)$/i;
  return [...new Set(config.search.queries.flatMap((q) => q.keywords.toLowerCase().split(/[^a-z&+]+/)).filter((w) => w.length > 2 && !generic.test(w)))];
}

const insertJob = db.prepare(`INSERT OR IGNORE INTO jobs
  (linkedin_id, title, company, location, linkedin_url, apply_url, ats, company_domain, description, hiring_team, easy_apply, search_track)
  VALUES (@key, @title, @company, @location, '', @apply_url, @ats, '', @description, '[]', 0, @search_track)`);

export async function discoverBoards({ limit = config.sources?.boards?.maxPerRun ?? 100, onProgress = () => {} } = {}) {
  const S = config.sources?.boards || {};
  if (S.enabled === false) return 0;
  // Your target companies (from chat or Settings) are always checked; "only my companies" skips the defaults.
  const targets = (config.search.companies || []).map((c) => c.board).filter(Boolean);
  const boards = [...new Set(config.search.onlyTargets && targets.length ? targets : [...targets, ...(S.list?.length ? S.list : DEFAULT_BOARDS)])];
  const places = (S.locations?.length ? S.locations : ['Canada', 'Toronto', 'Vancouver', 'Montreal', 'Ottawa', 'Waterloo', 'Calgary', 'Edmonton', 'Remote'])
    .map((p) => p.toLowerCase());
  const exclude = config.search.excludeTitleWords.map((w) => w.toLowerCase());
  const words = targetWords();
  const targetSet = new Set(targets);
  let added = 0, scanned = 0;

  for (const [i, entry] of boards.entries()) {
    if (added >= limit) break;
    onProgress({ done: i, total: boards.length, current: entry.split(':')[1] });
    let jobs;
    try { jobs = await fetchBoard(entry); } catch (e) { log('error', `board ${entry}: ${e.message}`); continue; }
    for (const j of jobs) {
      scanned++;
      const t = j.title.toLowerCase(), loc = j.location.toLowerCase();
      if (!EARLY.test(t) && !(S.includeEntryLevelWithoutKeyword && !/senior|staff|principal|lead|manager|director|sr\b/.test(t))) continue;
      if (exclude.some((w) => t.includes(w)) || /\bph\.?d\b/.test(t)) continue;
      if (!locationOk(loc, places)) continue;
      // Any field: keep roles whose title matches one of your position keywords (targets: any early-career role).
      if (words.length && !targetSet.has(entry) && !words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t))) continue;
      if (j.description.length < 200) continue;
      if (db.prepare('SELECT 1 FROM jobs WHERE linkedin_id = ?').get(j.key) || findDuplicateJob(j)) continue;
      const r = insertJob.run({ ...j, search_track: 'auto' });
      if (r.changes) {
        db.prepare('INSERT OR IGNORE INTO applications (job_id) VALUES (?)').run(r.lastInsertRowid);
        added++;
        log('discover', `+ ${j.title} @ ${j.company} [${j.ats}]`);
        if (added >= limit) break;
      }
    }
    await jitter(300, 700);
  }
  log('discover', `Scanned ${scanned} openings on ${boards.length} company boards, kept ${added}`);
  return added;
}
