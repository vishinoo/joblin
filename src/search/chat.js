import { COUNTRIES, SPECIAL } from '../../public/places.js';
import { noteFocus } from './linkedin.js';
// Chat with Joblin: describe what you want ("finance internships in London at Barclays and Wise")
// and it updates your search, remembers your preferences, and starts a search when you ask.
import { config } from '../core/config.js';
import { db, log, kv } from '../core/db.js';
import { jobNamedIn, appliedCompanies, moreOutreachFor } from '../email/contacts.js';
import { generateJSON } from '../core/llm.js';
import { addFact, listFacts } from '../you/memory.js';
import { tracks, scoreTracks } from '../you/tracks.js';

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
// Only the response code matters, so the (sometimes huge) job lists aren't downloaded here.
async function probe(url, ok) {
  try { const r = await fetch(url, { signal: AbortSignal.timeout(5000) }); return r.ok && ok(await r.json()); } catch { return false; }
}
// A company's Greenhouse, Ashby or Lever board, e.g. "greenhouse:stripe" — or null. All name variations are tried
// at once (not one after another) and the answer, including "none", is remembered for 30 days.
export async function resolveCompany(name) {
  const key = `board:${String(name).toLowerCase()}`;
  const hit = kv.get(key, null);
  if (hit && Date.now() - hit.at < 30 * 864e5) return hit.board;
  const tries = slugs(name).flatMap((slug) => [
    [`greenhouse:${slug}`, `https://boards-api.greenhouse.io/v1/boards/${slug}/jobs`, (j) => Array.isArray(j?.jobs)],
    [`ashby:${slug}`, `https://api.ashbyhq.com/posting-api/job-board/${slug}`, (j) => Array.isArray(j?.jobs)],
    [`lever:${slug}`, `https://api.lever.co/v0/postings/${slug}?mode=json&limit=1`, (j) => Array.isArray(j)],
  ]);
  const ok = await Promise.all(tries.map(([, url, test]) => probe(url, test)));
  const board = tries.find((_, i) => ok[i])?.[0] || null; // first in priority order: full name before shorter guesses
  kv.set(key, { board, at: Date.now() });
  return board;
}

// ---------- Plain parsing of a request ("finance internships in Edmonton at ATB and Stantec") ----------
// Every country (and its short names), state/province, and major city from public/places.js.
const PLACE_NAMES = [...new Map([
  ...SPECIAL.map((p) => [p, p]),
  ...COUNTRIES.flatMap((c) => [[c.name, c.name], ...c.aliases.filter((a) => a.length > 2).map((a) => [a, c.name]), ...c.regions.map((r) => [r.name, r.name]), ...c.cities.map((x) => [x, x])]),
]).entries()];
const FILLER = /\b(i'?m|i am|i'?d|i would|i want|i need|want|wanna|looking|look|for|find|search|searching|get|me|some|any|please|can you|could you|apply|applying|to|jobs?|roles?|positions?|openings?|opportunities|like|now|start|go|only|just|the|a|an|new|good|great|is|are|fine|ok|okay|too|also|works|preferably|ideally|in|near|around|across)\b/gi;
export function parseRequest(text) {
  let t = ` ${String(text || '')} `;
  const locations = [];
  for (const [p, name] of PLACE_NAMES.sort((a, b) => b[0].length - a[0].length)) {
    const re = new RegExp(`\\b(in|near|around|from|across)?\\s*${p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(t)) { if (!locations.includes(name)) locations.push(name); t = t.replace(re, ' '); }
  }
  // Two-letter short names only count after "in"/"near" ("jobs in us", "roles in uk"), never as ordinary words.
  for (const m of t.matchAll(/\b(?:in|near|across)\s+(us|uk|uae)\b/gi)) { const c = COUNTRIES.find((x) => x.aliases.includes(m[1].toLowerCase())); if (c && !locations.includes(c.name)) locations.push(c.name); t = t.replace(m[0], ' '); }
  const companies = [];
  const at = t.match(/\b(?:at|with|for companies like|companies like)\s+([A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*(?:\s*(?:,|and|or)\s*[A-Z][\w&.'-]*(?:\s+[A-Z][\w&.'-]*)*)*)/);
  if (at) { companies.push(...at[1].split(/\s*(?:,|\band\b|\bor\b)\s*/).map((x) => x.trim()).filter(Boolean)); t = t.replace(at[0], ' '); }
  let role = t.replace(FILLER, ' ').replace(/[^\w&+/ -]+/g, ' ').replace(/\s+/g, ' ').trim()
    .replace(/\binternships\b/i, 'intern').replace(/\binternship\b/i, 'intern').replace(/\bco-?ops\b/i, 'co-op').replace(/s\b(?=\s*$)/, (m) => (/(analysts|engineers|developers|managers|associates|designers|accountants|interns|coordinators|consultants|scientists)$/i.test(t.trim()) ? '' : m));
  const positions = role.split(/\s*(?:,|\band\b|\bor\b)\s*/).map((x) => x.trim()).filter((x) => x.split(' ').some((w) => w.length > 2) && x.length < 60);
  return { positions, locations, companies };
}

const trackFor = (keywords) => { const best = scoreTracks({ title: keywords, description: '' })[0]; return best?.score ? best.id : 'auto'; };

// ---------- Fast paths that don't need the model ----------
const START = /\b(go|start|run|search|find|look|begin|apply)\b.*\b(now|jobs?|search|batch|it)\b|^(go|start|search|find jobs|run it|let'?s go)[.! ]*$/i;
const STATUS = /\b(status|progress|how many|what('?s| is) (happening|going on)|update)\b/i;

// If a search is already running, start the new one as soon as it finishes.
let queued = null, queuedOpts = null;
function queueSearchAfterCurrent(actions, opts = {}) {
  queuedOpts = opts; // the newest request wins
  if (queued) return;
  queued = setInterval(() => { if (actions.run(queuedOpts)) { clearInterval(queued); queued = null; queuedOpts = null; } }, 3000);
}

// Joblin talks like what he is: a small, scrappy office goblin in a suit who is VERY determined to get
// you hired. The facts in each reply stay plain and exact; the goblin is in the wrapping.
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const GOBLIN = {
  status: ['Heh, the hoard report:', 'Counted the pile twice, here it is:', 'Goblin ledger, freshly scribbled:'],
  go: ['Sharpening my pencil!', 'Off I scurry!', 'Heh heh, to the job boards!', 'Grabbing my tiny briefcase!'],
  queued: ['Paws full right now, but', 'One hunt at a time (goblin rules), so'],
  stopping: ['Dropping what I’m sniffing at —', 'Hold on, turning my nose around —'],
  idle: ['Tell this goblin what to hunt: roles, places, companies. I’ll start digging right away.', 'Point me at a job, any job. Roles, places, companies — and I’m off.'],
};
export async function chat(message, actions) {
  const text = String(message || '').trim();
  if (!text) return { reply: '' };
  say('user', text);
  const Q = config.search.queries || [];
  const companies = config.search.companies || [];
  const prefs = listFacts().filter((f) => ['companies', 'preferences', 'goals'].includes(f.category)).slice(0, 8).map((f) => f.text);

  // "More emails / people at <company I applied to>": find more people for that role and write drafts.
  if (/\b(more|other|additional|another|extra|new)\b.{0,50}\b(people|emails?|messages?|contacts?|drafts?|outreach|recruiters?|managers?)\b/i.test(text)) {
    const job = jobNamedIn(text);
    if (job) {
      const n = Math.min(5, Number(text.match(/\b([1-5])\b/)?.[1]) || 3);
      moreOutreachFor(job, n).then((fresh) => say('joblin', fresh.length
        ? `Heh, found ${fresh.length} more at ${job.company}: ${fresh.map((c) => c.name).join(', ')}. ${config.email.autoSend !== false ? 'Their emails are queued.' : 'Drafts are waiting on Outreach.'}`
        : `Sniffed all around ${job.company} and found nobody new for ${job.title}. Try again in a few days?`)).catch(() => {});
      const reply = `${pick(GOBLIN.go)} Digging up ${n} more people at ${job.company} who work near the ${job.title} role. I’ll write ${config.email.autoSend !== false ? 'and queue' : 'drafts for'} them — check Outreach in a minute or two.`;
      say('joblin', reply);
      return { reply };
    }
    const cos = [...new Set(appliedCompanies().map((j) => j.company))].slice(0, 6);
    if (cos.length && /\b(email|message|people|contact|outreach|draft)/i.test(text)) {
      const reply = `Which company, boss? You've applied to ${cos.join(', ')}${cos.length === 6 ? '…' : ''}. Say e.g. “more people at ${cos[0]}”.`;
      say('joblin', reply);
      return { reply };
    }
  }

  // Status questions answer instantly.
  if (STATUS.test(text) && text.length < 60) {
    const c = (sql) => db.prepare(sql).get().n;
    const reply = `${pick(GOBLIN.status)} ${c(`SELECT COUNT(*) n FROM applications WHERE status='pending_approval'`)} waiting for your review, ${c(`SELECT COUNT(*) n FROM applications WHERE status='approved'`)} approved and queued, ${c(`SELECT COUNT(*) n FROM applications WHERE status IN ('submitted','interview','offer')`)} applied, and ${c(`SELECT COUNT(*) n FROM answers WHERE source='pending'`)} questions need your answer. Keep ’em coming.`;
    say('joblin', reply);
    return { reply };
  }

  const plan = await generateJSON(
    `You are Joblin, a small, scrappy office goblin in a tiny suit whose whole life's purpose is getting the user hired.
You talk like a cheerful little goblin: short, eager, a bit mischievous ("heh", "shinies", "my hoard", "sniffing out jobs"), but always clear and helpful. Never mean, never weird. The user tells you what jobs they want. Update their search.
Current positions: ${JSON.stringify(Q.map((q) => q.keywords))}
Current locations: ${JSON.stringify(config.sources?.boards?.locations || [])}
Target companies: ${JSON.stringify(companies.map((c) => c.name))}
Known preferences: ${JSON.stringify(prefs)}
Resume types available: ${tracks().map((t) => t.label).join(', ')}
User says: "${text}"
Return JSON:
{"reply": "1-2 short sentences in your goblin voice confirming what you changed or answering them",
 "positions": ["job titles/keywords to search, e.g. 'Investment Banking Analyst', 'Marketing Intern'"],
 "replace_positions": true if they want ONLY these positions (e.g. "only", "instead", "switch to"), else false,
 "locations": ["places to search, e.g. 'London', 'Texas', 'Germany', 'Remote'"],
 "replace_locations": true if they want only these places,
 "companies": ["specific companies they want to apply to"],
 "only_companies": true if they want ONLY those companies,
 "remember": ["lasting preferences worth remembering, e.g. 'Prefers fintech companies'"],
 "start_search": true if they ask to search/apply/go now}
Use empty lists for anything they didn't mention.`,
    { reply: '', positions: [], replace_positions: false, locations: [], replace_locations: false, companies: [], only_companies: false, remember: [], start_search: false },
    { temperature: 0.2, maxTokens: 500 });

  const arr = (x) => (Array.isArray(x) ? x : typeof x === 'string' && x.trim() ? x.split(/\s*(?:,|;|\band\b)\s*/) : []).map((v) => String(v).trim()).filter((v) => v && v.length < 80);
  // Don't depend on the model for the basics: read places, companies and the role straight from your words.
  const direct = parseRequest(text);
  for (const k of ['positions', 'locations', 'companies']) if (!arr(plan[k]).length && direct[k].length) plan[k] = direct[k];
  // Small models embellish: only keep things whose key words you actually said.
  const said = text.toLowerCase();
  const GENERIC = /^(intern|internship|internships|analyst|associate|new|grad|graduate|junior|senior|entry|level|role|roles|job|jobs|position|positions|summer|co-?op|and|the|in|at|of)$/;
  const mentioned = (v) => String(v).toLowerCase().split(/[^a-z0-9&+]+/).filter((w) => w.length > 2 && !GENERIC.test(w)).some((w) => said.includes(w.replace(/s$/, '')));
  plan.positions = arr(plan.positions).filter(mentioned);
  plan.locations = arr(plan.locations).filter(mentioned);
  plan.companies = arr(plan.companies).filter(mentioned);
  const changes = [];
  const pos = arr(plan.positions), locs = arr(plan.locations), comps = arr(plan.companies);

  // Companies: find their job boards (kept for this search; liked companies also go to Memory).
  const companiesForRun = [];
  const found = [], linkedinOnly = [];
  for (const name of comps) {
    const known = companies.find((c) => c.name.toLowerCase() === name.toLowerCase());
    const board = known ? known.board : await resolveCompany(name);
    companiesForRun.push({ name, board: board || '' });
    (board ? found : linkedinOnly).push(name);
    addFact(`Interested in ${name}`, 'companies');
  }
  for (const r of arr(plan.remember)) { addFact(r, 'preferences'); changes.push(`remembered “${r}”`); }

  // A request is a one-off search for exactly what you asked. Your saved settings stay as they are.
  const asked = pos.length || locs.length || comps.length;
  const wantsSaved = !asked && (START.test(text) || (plan.start_search === true && /\b(search|find|start|go|apply|look|run)\b/i.test(text)));
  let started = false, reply = '';
  if (asked || wantsSaved) {
    const search = asked ? {
      queries: (pos.length ? pos : Q.map((q) => q.keywords)).map((k) => ({ keywords: k, location: locs[0] || '', track: trackFor(k) })),
      locations: locs.length ? locs : null,
      companies: companiesForRun.length ? companiesForRun : null,
      onlyTargets: companiesForRun.length ? Boolean(plan.only_companies) : undefined,
    } : null;
    const what = asked ? `${pos.length ? pos.join(', ') : 'your saved positions'}${locs.length ? ` in ${locs.join(', ')}` : ''}${comps.length ? ` at ${comps.join(', ')}` : ''}` : 'your saved positions';
    if (search) noteFocus(search.queries); // later scheduled searches lean toward what you've been asking for
    started = actions.run({ search });
    if (!started && actions.stopFind?.()) { queueSearchAfterCurrent(actions, { search }); reply = `${pick(GOBLIN.stopping)} hunting for ${what} instead…`; started = true; }
    else if (!started) { queueSearchAfterCurrent(actions, { search }); reply = `${pick(GOBLIN.queued)} I’ll hunt for ${what} as soon as this search wraps up.`; }
    else reply = `${pick(GOBLIN.go)} Hunting for ${what} now. Every good one I drag back lands in Review batch.`;
    if (found.length) changes.push(`found job boards for ${found.join(', ')}`);
    if (linkedinOnly.length) changes.push(`searching LinkedIn for ${linkedinOnly.join(', ')}`);
  } else {
    reply = String(plan.reply || '').trim().slice(0, 400) || (changes.length ? `Heh, noted — ${changes.join('; ')}.` : pick(GOBLIN.idle));
  }
  say('joblin', reply, { changes, started });
  log('chat', changes.length ? changes.join('; ') : 'chat');
  return { reply, changes, started };
}
