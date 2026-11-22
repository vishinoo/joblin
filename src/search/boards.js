import { restrictedFor } from './linkedin.js';
import { placeMatches, countryOf } from '../../public/places.js';
// Job source: companies' own public job boards (Greenhouse, Lever, Ashby).
// These are official public APIs meant for listing jobs, no login or scraping needed,
// and every job found here is one Joblin can submit automatically.
import { config, activeSearch } from '../core/config.js';
import { db, log, findDuplicateJob } from '../core/db.js';

export const DEFAULT_BOARDS = [
  // Canada-based
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
  // Canadian finance & fintech (few internships most of the year; picked up when they post them)
  'greenhouse:questrade', 'greenhouse:clutch', 'greenhouse:shakepay', 'ashby:jobber', 'ashby:hopper', 'ashby:float', 'ashby:venn', 'ashby:propel',
  'ashby:georgian', 'lever:policyme', 'lever:plooto',
];

export const EARLY = /\b(interns?|internships?|co-?ops?|new ?grads?|graduates?|university|students?|campus|junior|jr\.?|entry[- ]level|early[- ]career|summer analyst|analyst program|apprentice)\b/i;
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
// Board listings are reused for 2 hours, so back-to-back searches don't download everything again.
const boardCache = new Map();
const CACHE_MS = 2 * 3600e3;
export async function fetchBoard(entry, { light = false } = {}) {
  const hit = boardCache.get(entry);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.jobs;
  const jobs = await fetchBoardFresh(entry, { light });
  boardCache.set(entry, { at: Date.now(), jobs });
  return jobs;
}
// Greenhouse descriptions are fetched one by one, only for jobs that match your search.
export async function fullDescription(j) {
  if (j.description) return j.description;
  const m = j.key.match(/^gh-(.+)-(\d+)$/);
  if (!m) return '';
  const x = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${m[1]}/jobs/${m[2]}`).catch(() => null);
  j.description = strip(x?.content || '');
  return j.description;
}
async function fetchBoardFresh(entry, { light = false } = {}) {
  const [ats, slug] = entry.split(':').map((s) => s.trim());
  if (ats === 'greenhouse') {
    // Titles and locations only (fast); descriptions come later for the few that match.
    const j = await getJSON(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs${light ? '' : ''}`);
    return j.jobs.map((x) => ({ key: `gh-${slug}-${x.id}`, title: x.title, company: x.company_name || pretty(slug), location: x.location?.name || '',
      // Use the Greenhouse-hosted form even when the company embeds it on its own site.
      apply_url: `https://job-boards.greenhouse.io/${slug}/jobs/${x.id}`, ats, description: '' }));
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

// A job fits your places if it's in one of them (countries include their states and cities). "Remote" counts
// when the job isn't tied to a country, or is tied to one of yours ("Remote, US" fits if you search the US).
// No places set means anywhere.
function locationOk(loc, places) {
  if (!places.length) return true;
  if (places.some((p) => p !== 'remote' && placeMatches(p, loc))) return true;
  if (!places.includes('remote') || !placeMatches('remote', loc)) return false;
  const where = countryOf(loc);
  return !where || places.some((p) => countryOf(p) === where || placeMatches(p, where.name));
}

function targetWords() {
  const generic = /^(intern|internship|new|grad|graduate|summer|junior|jr|entry|level|co-?op|the|and|of|analyst)$/i;
  return [...new Set(activeSearch().queries.flatMap((q) => q.keywords.toLowerCase().split(/[^a-z&+]+/)).filter((w) => w.length > 2 && !generic.test(w)))];
}
// Job titles rarely repeat your exact words ("finance intern" → "Investment Analyst Intern", "Quant Trader Intern").
// When a search word belongs to a field, any title from that field counts.
export const FIELDS = [
  { words: /financ|invest|banking|equity|capital|asset|wealth|treasury|fp&a|valuation|m&a|credit|portfolio|trading|trader|quant|risk|venture|private|hedge|markets?/, title: FIN_TITLE },
  { words: /account|audit|tax|bookkeep|cpa/, title: /account|audit|tax|bookkeep|controller|payable|receivable/i },
  { words: /software|developer|engineer|backend|frontend|stack|swe|program|coding|web|mobile/, title: /software|developer|engineer|backend|front.?end|full.?stack|\bswe\b|programmer|platform|infrastructure|mobile|ios|android/i },
  { words: /data|analytics|machine|learning|\bml\b|\bai\b|scien/, title: /data|analytics|machine learning|\bml\b|\bai\b|scien|research/i },
];
export const titleMatches = (title, words) => {
  const t = String(title).toLowerCase();
  if (words.some((w) => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(t))) return true;
  return FIELDS.some((f) => words.some((w) => f.words.test(w)) && f.title.test(t));
};

const insertJob = db.prepare(`INSERT OR IGNORE INTO jobs
  (linkedin_id, title, company, location, linkedin_url, apply_url, ats, company_domain, description, hiring_team, easy_apply, search_track)
  VALUES (@key, @title, @company, @location, '', @apply_url, @ats, '', @description, '[]', 0, @search_track)`);

export async function discoverBoards({ limit = config.sources?.boards?.maxPerRun ?? 100, onProgress = () => {} } = {}) {
  const S = config.sources?.boards || {};
  if (S.enabled === false) return 0;
  // Your target companies (from chat or Settings) are always checked; "only my companies" skips the defaults.
  const AS = activeSearch();
  const targets = (AS.companies || []).map((c) => c.board).filter(Boolean);
  const boards = [...new Set(AS.onlyTargets && targets.length ? targets : [...targets, ...(S.list?.length ? S.list : DEFAULT_BOARDS)])];
  // Your places; if you haven't set any, your own country plus remote jobs.
  const places = (AS.locations?.length ? AS.locations : [config.profile?.country, 'Remote'].filter(Boolean)).map((p) => p.toLowerCase());
  const exclude = config.search.excludeTitleWords.map((w) => w.toLowerCase());
  const words = targetWords();
  const targetSet = new Set(targets);
  let added = 0, scanned = 0;

  // Check 10 boards at a time; only the jobs that match get their full description downloaded.
  const keep = (j, entry) => {
    const t = j.title.toLowerCase(), loc = j.location.toLowerCase();
    if (!EARLY.test(t) && !(S.includeEntryLevelWithoutKeyword && !/senior|staff|principal|lead|manager|director|sr\b/.test(t))) return false;
    if (exclude.some((w) => t.includes(w)) || /\bph\.?d\b/.test(t) || restrictedFor(j.title)) return false;
    if (!locationOk(loc, places)) return false;
    // Any field: keep roles whose title matches one of your position keywords (targets: any early-career role).
    if (words.length && !targetSet.has(entry) && !titleMatches(t, words)) return false;
    return !db.prepare('SELECT 1 FROM jobs WHERE linkedin_id = ?').get(j.key) && !findDuplicateJob(j);
  };
  let done = 0;
  const queue = [...boards];
  const worker = async () => {
    while (queue.length && added < limit && !config.stopFind) {
      const entry = queue.shift();
      let jobs = [];
      try { jobs = await fetchBoard(entry); } catch (e) { log('error', `board ${entry}: ${e.message}`); }
      scanned += jobs.length;
      for (const j of jobs.filter((x) => keep(x, entry))) {
        if (added >= limit || config.stopFind) break;
        if ((await fullDescription(j)).length < 200) continue;
        const r = insertJob.run({ ...j, search_track: 'auto' });
        if (r.changes) { db.prepare('INSERT OR IGNORE INTO applications (job_id) VALUES (?)').run(r.lastInsertRowid); added++; log('discover', `+ ${j.title} @ ${j.company} [${j.ats}]`); }
      }
      onProgress({ done: ++done, total: boards.length, current: entry.split(':')[1] });
    }
  };
  await Promise.all(Array.from({ length: Math.min(10, boards.length) }, worker));
  log('discover', `Scanned ${scanned} openings on ${boards.length} company boards, kept ${added}`);
  return added;
}
