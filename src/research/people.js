// Company & people research for personal cold emails — ported from the old job_info_scraper project.
// Only public professional data people chose to publish: company team pages, GitHub org members,
// OpenAlex publications, and public search results. It never logs into or scrapes LinkedIn,
// Instagram, TikTok, etc.; for LinkedIn it only finds the public profile URL via search.
// Emails are INFERRED from the company's pattern unless verified (Hunter) — check before sending.
import * as cheerio from 'cheerio';

const UA = 'Joblin/1.0 (personal job search & networking)';
const TIMEOUT = 15000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function get(url, headers = {}) {
  return fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: AbortSignal.timeout(TIMEOUT), redirect: 'follow' });
}

// ---------------- Email patterns ----------------
export const EMAIL_PATTERNS = ['{first}.{last}', '{first}{last}', '{f}{last}', '{first}', '{first}_{last}', '{last}{f}', '{f}.{last}'];
const slugName = (s) => String(s || '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z]/g, '');
export function splitName(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? [parts[0], parts.length > 1 ? parts[parts.length - 1] : ''] : ['', ''];
}
export function renderEmail(pattern, name, domain) {
  let [first, last] = splitName(name).map(slugName);
  if (!first || !domain) return '';
  const local = pattern.replace('{first}', first).replace('{last}', last).replace('{f}', first[0]).replace('{l}', last[0] || '').replace(/^[._]+|[._]+$/g, '');
  return local ? `${local}@${domain}` : '';
}
// Detect the company's pattern from real addresses published on its site.
export function inferPattern(examples, domain) {
  const re = new RegExp(`^([a-z]+)([._]?)([a-z]*)@${domain.replace(/\./g, '\\.')}$`);
  for (const addr of examples) {
    const m = addr.toLowerCase().match(re);
    if (m && m[3]) return m[2] ? `{first}${m[2]}{last}` : '{first}{last}';
  }
  return null;
}
export const domainOf = (s) => { try { return new URL(/:\/\//.test(s) ? s : `https://${s}`).hostname.replace(/^www\./, ''); } catch { return ''; } };

// ---------------- Company website ----------------
const TEAM_HINTS = ['team', 'about', 'people', 'leadership', 'company', 'who-we-are', 'our-story', 'founders'];
const TITLE_RE = /\b(CEO|CTO|CFO|COO|VP|Head|Director|Manager|Lead|Engineer|Designer|Founder|President|Officer|Scientist|Recruiter|Developer|Architect|Analyst|Marketing|Sales|Partner|Associate|Principal|Talent)\b/i;

export async function findTeamPages(baseUrl) {
  try {
    const $ = cheerio.load(await (await get(baseUrl)).text());
    const found = new Set();
    $('a[href]').each((_, a) => {
      const href = $(a).attr('href');
      if (TEAM_HINTS.some((h) => href.toLowerCase().includes(h))) { try { found.add(new URL(href, baseUrl).href.split('#')[0]); } catch {} }
    });
    return [...found].slice(0, 6);
  } catch { return []; }
}

// Heuristic: a short text that looks like a job title, with the nearest heading in its card as the name.
export async function scrapePeoplePage(url) {
  let html = '';
  try { html = await (await get(url)).text(); } catch { return { people: [], html: '' }; }
  const $ = cheerio.load(html);
  const people = [], seen = new Set();
  $('div, li, article, section').each((_, el) => {
    if (people.length >= 60) return false;
    const box = $(el);
    if (box.children().length > 12 || box.text().length > 400) return;
    const title = box.find('p, span, div').filter((_, t) => { const s = $(t).text().trim(); return s.length < 80 && TITLE_RE.test(s) && $(t).children().length === 0; }).first().text().trim();
    if (!title) return;
    const name = box.find('h1, h2, h3, h4, h5, strong, b').map((_, h) => $(h).text().trim()).get()
      .find((s) => s && s !== title && s.split(/\s+/).length >= 2 && s.split(/\s+/).length <= 4 && !TITLE_RE.test(s));
    if (!name || seen.has(name.toLowerCase())) return;
    seen.add(name.toLowerCase());
    people.push({ name, position: title, source: 'Company site', sourceUrl: url });
  });
  return { people, html };
}
export const emailsOnPage = (html, domain) => [...new Set(String(html).match(new RegExp(`[a-zA-Z0-9._%+-]+@${domain.replace(/\./g, '\\.')}`, 'g')) || [])];

// ---------------- GitHub org (official REST API) ----------------
export async function githubOrg(org, { token = '', limit = 30 } = {}) {
  const h = { accept: 'application/vnd.github+json', ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const r = await get(`https://api.github.com/orgs/${org}/members?per_page=${limit}`, h).catch(() => null);
  if (!r?.ok) return { people: [], warning: r?.status === 403 ? 'GitHub rate limit hit — add a token.' : `GitHub org "${org}" not found or has no public members.` };
  const people = [];
  for (const m of (await r.json()).slice(0, limit)) {
    const u = await get(`https://api.github.com/users/${m.login}`, h).then((x) => x.json()).catch(() => ({}));
    const repos = await get(`https://api.github.com/users/${m.login}/repos?sort=pushed&per_page=20`, h).then((x) => x.json()).catch(() => []);
    const counts = {}; for (const rp of Array.isArray(repos) ? repos : []) if (rp.language) counts[rp.language] = (counts[rp.language] || 0) + 1;
    people.push({ name: u.name || m.login, position: u.bio || '', github: `https://github.com/${m.login}`,
      githubLangs: Object.keys(counts).sort((a, b) => counts[b] - counts[a]).slice(0, 3).join(', '),
      email: u.email || '', emailConfidence: u.email ? 'verified' : '', source: 'GitHub org', sourceUrl: `https://github.com/orgs/${org}/people` });
    await sleep(100);
  }
  return { people };
}

// ---------------- Search (SerpAPI if keyed, else DuckDuckGo HTML) ----------------
export async function search(query, { serpapiKey = '', n = 8 } = {}) {
  if (serpapiKey) {
    const j = await get(`https://serpapi.com/search.json?${new URLSearchParams({ q: query, engine: 'google', num: n, api_key: serpapiKey })}`).then((r) => r.json()).catch(() => ({}));
    return (j.organic_results || []).filter((o) => o.link).map((o) => ({ title: o.title || '', url: o.link }));
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await get(`https://html.duckduckgo.com/html/?${new URLSearchParams({ q: query })}`, { 'user-agent': 'Mozilla/5.0' });
      const $ = cheerio.load(await r.text());
      const out = [];
      $('a.result__a').each((_, a) => {
        let href = $(a).attr('href') || '';
        if (href.includes('uddg=')) { try { href = decodeURIComponent(new URL(href, 'https://duckduckgo.com').searchParams.get('uddg')); } catch {} }
        out.push({ title: $(a).text().trim(), url: href });
        if (out.length >= n) return false;
      });
      if (out.length || r.ok) return out;
    } catch {}
    await sleep(1500 * (attempt + 1));
  }
  return [];
}

export async function findLinkedin(name, company, opts = {}) {
  if (!name) return { url: '', verified: false };
  for (const { title, url } of await search(`site:linkedin.com/in "${name}" ${company}`, opts))
    if (/linkedin\.com\/in\//i.test(url)) return { url: url.split('?')[0], verified: Boolean(company && title.toLowerCase().includes(company.toLowerCase())) };
  return { url: '', verified: false };
}

const SIGNAL_HOSTS = ['youtube.com', 'youtu.be', 'vimeo.com', 'slideshare.net', 'speakerdeck.com', 'arxiv.org', 'acm.org', 'ieee.org', 'researchgate.net', 'scholar.google', 'medium.com', 'dev.to', 'substack.com', 'ted.com', 'podcasts.apple.com'];
const SIGNAL_PATHS = ['/talk', '/event', '/speaker', '/lecture', '/keynote', '/publication', '/paper', '/blog', '/press', '/news', '/podcast'];
const SOCIAL = ['linkedin.com', 'facebook.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'pinterest.com', 'reddit.com'];
// Talks, papers, posts, press — URLs only.
export async function findMentions(name, company, { limit = 3, ...opts } = {}) {
  if (!name) return [];
  const hits = [];
  for (const { url } of await search(`"${name}" ${company} talk lecture paper`, { ...opts, n: 12 })) {
    let host = ''; try { host = new URL(url).hostname.toLowerCase(); } catch { continue; }
    if (SOCIAL.some((s) => host.includes(s))) continue;
    if (SIGNAL_HOSTS.some((s) => host.includes(s)) || SIGNAL_PATHS.some((p) => url.toLowerCase().includes(p))) {
      const clean = /youtube|youtu\.be|vimeo/.test(host) ? url : url.split('?')[0];
      if (!hits.includes(clean)) hits.push(clean);
    }
    if (hits.length >= limit) break;
  }
  return hits;
}

// ---------------- Publications (OpenAlex, affiliation-matched) ----------------
export async function findPublications(name, company = '', limit = 4) {
  if (!name) return { titles: [], count: 0 };
  const authors = await get(`https://api.openalex.org/authors?${new URLSearchParams({ search: name, 'per-page': 5 })}`).then((r) => r.json()).then((j) => j.results || []).catch(() => []);
  const affs = (a) => [a.last_known_institution?.display_name, ...(a.affiliations || []).map((x) => x.institution?.display_name)].filter(Boolean).map((s) => s.toLowerCase());
  let author = null;
  if (company) {
    const pat = new RegExp(`\\b${company.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
    author = authors.find((a) => affs(a).some((x) => pat.test(x))) || null; // no affiliation match → don't guess
  } else author = authors[0] || null;
  if (!author) return { titles: [], count: 0 };
  const works = await get(`https://api.openalex.org/works?${new URLSearchParams({ filter: `author.id:${author.id.split('/').pop()}`, sort: 'cited_by_count:desc', 'per-page': limit })}`)
    .then((r) => r.json()).then((j) => j.results || []).catch(() => []);
  return { titles: works.map((w) => (w.title || w.display_name) + (w.publication_year ? ` (${w.publication_year})` : '')).filter(Boolean), count: author.works_count || 0 };
}

// ---------------- Opener grounded in public work ----------------
export function suggestApproach(p, jobs = []) {
  if (p.publications?.length) return `Reference their paper “${p.publications[0]}”. Ask what they’re researching now.`;
  if (p.githubLangs) return `Reference their GitHub work in ${p.githubLangs}. Ask how their team uses it.`;
  if (p.position) {
    const role = p.position.split(',')[0].split(' - ')[0].trim();
    return jobs.length ? `They work as ${role}. Mention the open “${jobs[0].title}” role and ask what the team looks for.` : `They work as ${role}. Ask a specific question about that team’s current focus.`;
  }
  return 'Lead with genuine interest in the company’s work; ask an open question about their team.';
}

// ---------------- One company, end to end ----------------
// researchCompany({ company, website, githubOrg, jobs, deep, serpapiKey, githubToken, maxPeople })
export async function researchCompany({ company, website = '', githubOrg: org = '', jobs = [], deep = false, serpapiKey = '', githubToken = '', maxPeople = 40, emailPattern = '{first}.{last}' }) {
  const domain = website ? domainOf(website) : '';
  const report = { company, domain, emailPattern, people: [], warnings: [] };
  let people = [];
  if (org) { const g = await githubOrg(org, { token: githubToken, limit: maxPeople }); people.push(...g.people); if (g.warning) report.warnings.push(g.warning); }
  const realEmails = [];
  if (website) {
    const base = /:\/\//.test(website) ? website : `https://${website}`;
    for (const page of await findTeamPages(base)) {
      const { people: found, html } = await scrapePeoplePage(page);
      people.push(...found);
      if (domain) realEmails.push(...emailsOnPage(html, domain));
    }
    if (!people.length && !org) report.warnings.push('No people found on the site. Try a direct /team or /about URL.');
  }
  if (domain && realEmails.length) { const pat = inferPattern(realEmails, domain); if (pat) { report.emailPattern = pat; report.warnings.push(`Detected email pattern from the site: ${pat}`); } }
  const seen = new Set();
  people = people.filter((p) => p.name && !seen.has(p.name.toLowerCase()) && seen.add(p.name.toLowerCase())).slice(0, maxPeople);
  if (deep) {
    for (const p of people) {
      if (!p.linkedin) { const l = await findLinkedin(p.name, company, { serpapiKey }); p.linkedin = l.url; p.linkedinVerified = l.verified; }
      const pubs = await findPublications(p.name, company); p.publications = pubs.titles; p.publicationCount = pubs.count;
      p.mentions = await findMentions(p.name, company, { serpapiKey });
      if (!serpapiKey) await sleep(1200); // pace DuckDuckGo
    }
  }
  for (const p of people) {
    if (domain && !p.email) { p.email = renderEmail(report.emailPattern, p.name, domain); p.emailConfidence = p.email ? 'inferred' : ''; }
    p.approach = suggestApproach(p, jobs);
  }
  report.people = people;
  if (!people.length) report.warnings.push('No people found. Try adding a GitHub org or a direct team-page URL.');
  return report;
}
