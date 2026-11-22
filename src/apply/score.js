// The fit score shown on every job (0–100). It starts from how well your resume covers the posting's
// requirements (cover.js → matchEvidence), lifts that onto a friendlier curve, and adds a bonus for
// well-known employers — a bigger one when the company is known for the same field as the job
// (a top bank for a finance role, a top tech company for a software role).

const TIERS = {
  tech: [
    // tier 1
    ['google', 'alphabet', 'meta', 'facebook', 'apple', 'amazon', 'microsoft', 'netflix', 'nvidia', 'openai', 'anthropic', 'stripe', 'databricks', 'deepmind', 'tesla', 'spacex'],
    // tier 2
    ['shopify', 'airbnb', 'uber', 'lyft', 'pinterest', 'snowflake', 'coinbase', 'roblox', 'figma', 'datadog', 'cloudflare', 'palantir', 'robinhood', 'cohere', 'wealthsimple',
      '1password', 'notion', 'linear', 'discord', 'reddit', 'dropbox', 'atlassian', 'salesforce', 'adobe', 'oracle', 'ibm', 'intel', 'amd', 'qualcomm', 'scale ai', 'scaleai',
      'mongodb', 'twilio', 'okta', 'gitlab', 'instacart', 'doordash', 'spotify', 'plaid', 'ramp', 'brex', 'samsara', 'vercel', 'replit', 'duolingo', 'faire', 'geotab', 'hootsuite',
      'lightspeed', 'd2l', 'tenstorrent', 'clio', 'jobber', 'benevity', 'ada', 'thinkific', 'later', 'ritual', 'koho', 'neo financial'],
  ],
  finance: [
    ['goldman sachs', 'morgan stanley', 'jpmorgan', 'j.p. morgan', 'blackstone', 'kkr', 'citadel', 'jane street', 'two sigma', 'point72', 'bridgewater', 'd. e. shaw', 'de shaw',
      'evercore', 'lazard', 'centerview', 'pjt', 'brookfield', 'cpp investments', 'ontario teachers', 'blackrock', 'hudson river trading', 'renaissance', 'apollo', 'carlyle', 'tpg'],
    ['rbc', 'royal bank', 'td ', 'td bank', 'td securities', 'bmo', 'bank of montreal', 'scotiabank', 'cibc', 'national bank', 'aimco', 'bci', 'psp investments', 'omers', 'hoopp',
      'caisse', 'cdpq', 'macquarie', 'ubs', 'barclays', 'citi', 'bank of america', 'wells fargo', 'deloitte', 'pwc', 'ey', 'ernst & young', 'kpmg', 'mckinsey', 'bcg', 'bain',
      'imc', 'optiver', 'jump trading', 'akuna', 'virtu', 'drw', 'sig', 'susquehanna', 'fidelity', 'vanguard', 'manulife', 'sun life', 'power corporation', 'great-west', 'canada life',
      'atb', 'desjardins', 'mackenzie', 'ci financial', 'fiera', 'onex', 'sprott', 'canaccord', 'raymond james', 'questrade', 'moody', 's&p global', 'bloomberg', 'marsh', 'ryan'],
  ],
};
const FINANCE_TRACKS = /finance|bank|account|consult|business|operations|energy/;

// How well-known the company is in a field: 2 (top tier), 1 (well known), 0.
export function reputation(company, field) {
  const c = ` ${String(company || '').toLowerCase()} `;
  const tiers = TIERS[field] || [];
  for (let i = 0; i < tiers.length; i++) if (tiers[i].some((n) => c.includes(n.length <= 4 ? ` ${n.trim()} ` : n))) return 2 - i;
  return 0;
}

export function fitScore(raw, job, track = '') {
  const field = FINANCE_TRACKS.test(track) ? 'finance' : 'tech';
  const other = field === 'finance' ? 'tech' : 'finance';
  const same = reputation(job.company, field), cross = reputation(job.company, other);
  // Curve: a resume that covers half the requirements reads as a solid 70, not a 50.
  let s = 40 + Math.round(Math.max(0, Math.min(100, raw)) * 0.6);
  s += same === 2 ? 15 : same === 1 ? 8 : cross === 2 ? 7 : cross === 1 ? 4 : 0;
  return Math.max(1, Math.min(99, s));
}
