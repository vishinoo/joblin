// Chat with Joblin: describe what you want ("finance internships in Toronto at RBC and Wealthsimple")
// and it updates your search, remembers your preferences, and starts a search when you ask.
import { config, saveConfig } from './config.js';
import { db, log } from './db.js';
import { generateJSON } from './llm.js';
import { addFact, listFacts } from './memory.js';
import { tracks, scoreTracks } from './tracks.js';

db.exec(`CREATE TABLE IF NOT EXISTS chat (id INTEGER PRIMARY KEY, role TEXT, text TEXT, meta TEXT, created_at TEXT DEFAULT (datetime('now')))`);
export const history = (n = 40) => db.prepare('SELECT * FROM chat ORDER BY id DESC LIMIT ?').all(n).reverse().map((r) => ({ ...r, meta: r.meta ? JSON.parse(r.meta) : null }));
const say = (role, text, meta = null) => db.prepare('INSERT INTO chat (role, text, meta) VALUES (?, ?, ?)').run(role, text, meta ? JSON.stringify(meta) : null);
export const clearChat = () => db.prepare('DELETE FROM chat').run();

// ---------- Company → job board ----------
const slugs = (name) => {
  const base = String(name).toLowerCase().replace(/&/g, 'and').replace(/[^a-z0-9 ]+/g, '').trim();
  const words = base.split(/\s+/).filter((w) => !/^(inc|ltd|llc|corp|corporation|company|co|the|group|technologies)$/.test(w));
  return [...new Set([words.join(''), words.join('-'), words[0], `${words.join('')}hq`, `${words.join('')}inc`].filter(Boolean))];
};
async function probe(url) { try { const r = await fetch(url, { signal: AbortSignal.timeout(8000) }); return r.ok ? r.json() : null; } catch { return null; } }
export async function resolveCompany(name) {
  for (const slug of slugs(name)) {
    const gh = await probe(`https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`); if (gh?.jobs) return `greenhouse:${slug}`;
    const ab = await probe(`https://api.ashbyhq.com/posting-api/job-board/${slug}`); if (ab?.jobs) return `ashby:${slug}`;
    const lv = await probe(`https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`); if (Array.isArray(lv)) return `lever:${slug}`;
  }
  return null;
}

const trackFor = (keywords) => { const best = scoreTracks({ title: keywords, description: '' })[0]; return best?.score ? best.id : 'auto'; };

// ---------- Fast paths that don't need the model ----------
const START = /\b(go|start|run|search|find|look|begin|apply)\b.*\b(now|jobs?|search|batch|it)\b|^(go|start|search|find jobs|run it|let'?s go)[.! ]*$/i;
const STATUS = /\b(status|progress|how many|what('?s| is) (happening|going on)|update)\b/i;

export async function chat(message, actions) {
  const text = String(message || '').trim();
  if (!text) return { reply: '' };
  say('user', text);
  const Q = config.search.queries || [];
  const companies = config.search.companies || [];
  const prefs = listFacts().filter((f) => ['companies', 'preferences', 'goals'].includes(f.category)).slice(0, 8).map((f) => f.text);

  // Status questions answer instantly.
  if (STATUS.test(text) && text.length < 60) {
    const c = (sql) => db.prepare(sql).get().n;
    const reply = `Right now: ${c(`SELECT COUNT(*) n FROM applications WHERE status='pending_approval'`)} waiting for your review, ${c(`SELECT COUNT(*) n FROM applications WHERE status='approved'`)} approved and queued, ${c(`SELECT COUNT(*) n FROM applications WHERE status IN ('submitted','interview','offer')`)} applied, and ${c(`SELECT COUNT(*) n FROM answers WHERE source='pending'`)} questions need your answer.`;
    say('joblin', reply);
    return { reply };
  }

  const plan = await generateJSON(
    `You are Joblin, a friendly job-search assistant. The user tells you what jobs they want. Update their search.
Current positions: ${JSON.stringify(Q.map((q) => q.keywords))}
Current locations: ${JSON.stringify(config.sources?.boards?.locations || [])}
Target companies: ${JSON.stringify(companies.map((c) => c.name))}
Known preferences: ${JSON.stringify(prefs)}
Resume types available: ${tracks().map((t) => t.label).join(', ')}
User says: "${text}"
Return JSON:
{"reply": "1-2 short sentences confirming what you changed or answering them",
 "positions": ["job titles/keywords to search, e.g. 'Investment Banking Analyst', 'Marketing Intern'"],
 "replace_positions": true if they want ONLY these positions (e.g. "only", "instead", "switch to"), else false,
 "locations": ["places to search, e.g. 'Toronto', 'Canada', 'Remote'"],
 "replace_locations": true if they want only these places,
 "companies": ["specific companies they want to apply to"],
 "only_companies": true if they want ONLY those companies,
 "remember": ["lasting preferences worth remembering, e.g. 'Prefers fintech companies'"],
 "start_search": true if they ask to search/apply/go now}
Use empty lists for anything they didn't mention.`,
    { reply: '', positions: [], replace_positions: false, locations: [], replace_locations: false, companies: [], only_companies: false, remember: [], start_search: false },
    { temperature: 0.2, maxTokens: 500 });

  const arr = (x) => (Array.isArray(x) ? x : []).map((v) => String(v).trim()).filter((v) => v && v.length < 80);
  // Small models embellish: only keep things whose key words you actually said.
  const said = text.toLowerCase();
  const GENERIC = /^(intern|internship|internships|analyst|associate|new|grad|graduate|junior|senior|entry|level|role|roles|job|jobs|position|positions|summer|co-?op|and|the|in|at|of)$/;
  const mentioned = (v) => String(v).toLowerCase().split(/[^a-z0-9&+]+/).filter((w) => w.length > 2 && !GENERIC.test(w)).some((w) => said.includes(w.replace(/s$/, '')));
  plan.positions = arr(plan.positions).filter(mentioned);
  plan.locations = arr(plan.locations).filter(mentioned);
  plan.companies = arr(plan.companies).filter(mentioned);
  const changes = [];

  // Positions
  const pos = arr(plan.positions);
  if (pos.length) {
    const loc0 = (config.sources?.boards?.locations || ['Canada'])[0] || 'Canada';
    const next = plan.replace_positions ? [] : [...Q];
    for (const k of pos) if (!next.some((q) => q.keywords.toLowerCase() === k.toLowerCase())) next.push({ keywords: k, location: loc0, track: trackFor(k) });
    saveConfig({ search: { queries: next } });
    changes.push(`${plan.replace_positions ? 'Now searching for' : 'Added'} ${pos.join(', ')}`);
  }
  // Locations
  const locs = arr(plan.locations);
  if (locs.length) {
    const cur = config.sources?.boards?.locations || [];
    const next = plan.replace_locations ? locs : [...new Set([...cur, ...locs])];
    saveConfig({ sources: { boards: { locations: next } }, search: { queries: (config.search.queries || []).map((q) => ({ ...q, location: plan.replace_locations ? locs[0] : q.location })) } });
    changes.push(`locations: ${next.join(', ')}`);
  }
  // Companies → find their job boards; LinkedIn searches cover the rest.
  const comps = arr(plan.companies);
  if (comps.length) {
    const found = [], linkedinOnly = [];
    const next = plan.only_companies ? [] : [...companies];
    for (const name of comps) {
      if (next.some((c) => c.name.toLowerCase() === name.toLowerCase())) continue;
      const board = await resolveCompany(name);
      next.push({ name, board: board || '' });
      (board ? found : linkedinOnly).push(name);
      addFact(`Wants to apply to ${name}`, 'companies');
    }
    saveConfig({ search: { companies: next, onlyTargets: Boolean(plan.only_companies) } });
    if (found.length) changes.push(`found job boards for ${found.join(', ')}`);
    if (linkedinOnly.length) changes.push(`will look for ${linkedinOnly.join(', ')} on LinkedIn`);
  }
  for (const r of arr(plan.remember)) { addFact(r, 'preferences'); changes.push(`remembered “${r}”`); }

  const start = START.test(text) || (plan.start_search === true && /\b(search|find|start|go|apply|look|run)\b/i.test(text));
  let started = false;
  if (start) started = actions.run();
  let reply = String(plan.reply || '').trim();
  if (!reply || reply.length > 400) reply = changes.length ? `Done — ${changes.join('; ')}.` : 'Tell me what kind of roles, where, and any companies you’re after, and I’ll set up the search.';
  if (changes.length && !/added|now|search|remember|found/i.test(reply)) reply += ` (${changes.join('; ')})`;
  if (start) reply += started ? ' Searching now — new applications will show up in Review batch.' : ' A search is already running; I’ll use these settings next time.';
  say('joblin', reply, { changes, started });
  log('chat', changes.length ? changes.join('; ') : 'chat');
  return { reply, changes, started };
}
