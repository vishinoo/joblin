// Places Joblin understands, worldwide: countries (with the short names people type), their states,
// provinces or regions (with postal codes like "CA" or "ON"), and major job-market cities.
// Shared by the dashboard (location suggestions) and the server (search matching, chat, applications).

const R = (s) => s.split(';').map((x) => { const [name, code] = x.split(':'); return { name, code: code || '' }; });

export const COUNTRIES = [
  { name: 'United States', code: 'US', aliases: ['us', 'usa', 'u.s.', 'u.s.a.', 'america', 'united states of america', 'states'],
    regions: R('Alabama:AL;Alaska:AK;Arizona:AZ;Arkansas:AR;California:CA;Colorado:CO;Connecticut:CT;Delaware:DE;District of Columbia:DC;Florida:FL;Georgia:GA;Hawaii:HI;Idaho:ID;Illinois:IL;Indiana:IN;Iowa:IA;Kansas:KS;Kentucky:KY;Louisiana:LA;Maine:ME;Maryland:MD;Massachusetts:MA;Michigan:MI;Minnesota:MN;Mississippi:MS;Missouri:MO;Montana:MT;Nebraska:NE;Nevada:NV;New Hampshire:NH;New Jersey:NJ;New Mexico:NM;New York:NY;North Carolina:NC;North Dakota:ND;Ohio:OH;Oklahoma:OK;Oregon:OR;Pennsylvania:PA;Rhode Island:RI;South Carolina:SC;South Dakota:SD;Tennessee:TN;Texas:TX;Utah:UT;Vermont:VT;Virginia:VA;Washington:WA;West Virginia:WV;Wisconsin:WI;Wyoming:WY'),
    cities: ['New York', 'San Francisco', 'Seattle', 'Boston', 'Chicago', 'Austin', 'Los Angeles', 'Washington', 'Denver', 'Atlanta', 'Miami', 'Dallas', 'Houston', 'San Jose', 'Palo Alto', 'Mountain View', 'Menlo Park', 'San Diego', 'Philadelphia', 'Pittsburgh', 'Detroit', 'Minneapolis', 'Phoenix', 'Salt Lake City', 'Charlotte', 'Raleigh', 'Nashville', 'Portland', 'Jersey City', 'Stamford'] },
  { name: 'Canada', code: 'CA', aliases: ['can'],
    regions: R('Alberta:AB;British Columbia:BC;Manitoba:MB;New Brunswick:NB;Newfoundland and Labrador:NL;Nova Scotia:NS;Ontario:ON;Prince Edward Island:PE;Quebec:QC;Saskatchewan:SK;Northwest Territories:NT;Nunavut:NU;Yukon:YT'),
    cities: ['Toronto', 'Vancouver', 'Montreal', 'Calgary', 'Edmonton', 'Ottawa', 'Waterloo', 'Kitchener', 'Mississauga', 'Markham', 'Surrey', 'Burnaby', 'Victoria', 'Winnipeg', 'Halifax', 'Quebec City', 'Hamilton', 'Regina', 'Saskatoon', 'Kelowna'] },
  { name: 'United Kingdom', code: 'GB', aliases: ['uk', 'u.k.', 'britain', 'great britain', 'england', 'gb'],
    regions: R('England;Scotland;Wales;Northern Ireland'), cities: ['London', 'Manchester', 'Edinburgh', 'Glasgow', 'Birmingham', 'Bristol', 'Cambridge', 'Oxford', 'Leeds', 'Belfast'] },
  { name: 'Australia', code: 'AU', aliases: ['aus', 'oz'],
    regions: R('New South Wales:NSW;Victoria:VIC;Queensland:QLD;Western Australia:WA;South Australia:SA;Tasmania:TAS;Australian Capital Territory:ACT;Northern Territory:NT'), cities: ['Sydney', 'Melbourne', 'Brisbane', 'Perth', 'Adelaide', 'Canberra'] },
  { name: 'India', code: 'IN', aliases: ['bharat'],
    regions: R('Karnataka:KA;Maharashtra:MH;Delhi:DL;Telangana:TG;Tamil Nadu:TN;Haryana:HR;Uttar Pradesh:UP;West Bengal:WB;Gujarat:GJ;Kerala:KL'), cities: ['Bangalore', 'Bengaluru', 'Mumbai', 'Delhi', 'New Delhi', 'Hyderabad', 'Chennai', 'Pune', 'Gurgaon', 'Gurugram', 'Noida', 'Kolkata', 'Ahmedabad'] },
  { name: 'Germany', code: 'DE', aliases: ['deutschland'], regions: R('Bavaria;Berlin;Hamburg;Hesse;North Rhine-Westphalia;Baden-Württemberg'), cities: ['Berlin', 'Munich', 'Hamburg', 'Frankfurt', 'Cologne', 'Stuttgart', 'Düsseldorf'] },
  { name: 'France', code: 'FR', aliases: [], regions: R('Île-de-France'), cities: ['Paris', 'Lyon', 'Marseille', 'Toulouse', 'Nice'] },
  { name: 'Ireland', code: 'IE', aliases: [], regions: [], cities: ['Dublin', 'Cork', 'Galway'] },
  { name: 'Netherlands', code: 'NL', aliases: ['holland', 'the netherlands'], regions: [], cities: ['Amsterdam', 'Rotterdam', 'The Hague', 'Utrecht', 'Eindhoven'] },
  { name: 'Spain', code: 'ES', aliases: ['españa'], regions: R('Catalonia;Madrid'), cities: ['Madrid', 'Barcelona', 'Valencia', 'Seville'] },
  { name: 'Italy', code: 'IT', aliases: ['italia'], regions: R('Lombardy;Lazio'), cities: ['Milan', 'Rome', 'Turin'] },
  { name: 'Portugal', code: 'PT', aliases: [], regions: [], cities: ['Lisbon', 'Porto'] },
  { name: 'Switzerland', code: 'CH', aliases: [], regions: [], cities: ['Zurich', 'Geneva', 'Basel', 'Lausanne'] },
  { name: 'Sweden', code: 'SE', aliases: [], regions: [], cities: ['Stockholm', 'Gothenburg', 'Malmö'] },
  { name: 'Denmark', code: 'DK', aliases: [], regions: [], cities: ['Copenhagen', 'Aarhus'] },
  { name: 'Norway', code: 'NO', aliases: [], regions: [], cities: ['Oslo', 'Bergen'] },
  { name: 'Finland', code: 'FI', aliases: [], regions: [], cities: ['Helsinki'] },
  { name: 'Poland', code: 'PL', aliases: ['polska'], regions: [], cities: ['Warsaw', 'Krakow', 'Wroclaw', 'Gdansk'] },
  { name: 'Albania', code: 'AL', aliases: [], regions: [], cities: ['Tirana'] },
  { name: 'Belgium', code: 'BE', aliases: [], regions: [], cities: ['Brussels', 'Antwerp'] },
  { name: 'Austria', code: 'AT', aliases: [], regions: [], cities: ['Vienna'] },
  { name: 'Czech Republic', code: 'CZ', aliases: ['czechia'], regions: [], cities: ['Prague', 'Brno'] },
  { name: 'Romania', code: 'RO', aliases: [], regions: [], cities: ['Bucharest', 'Cluj-Napoca'] },
  { name: 'Greece', code: 'GR', aliases: [], regions: [], cities: ['Athens'] },
  { name: 'Turkey', code: 'TR', aliases: ['türkiye'], regions: [], cities: ['Istanbul', 'Ankara'] },
  { name: 'Israel', code: 'IL', aliases: [], regions: [], cities: ['Tel Aviv', 'Jerusalem', 'Haifa'] },
  { name: 'United Arab Emirates', code: 'AE', aliases: ['uae', 'emirates'], regions: R('Dubai;Abu Dhabi'), cities: ['Dubai', 'Abu Dhabi'] },
  { name: 'Saudi Arabia', code: 'SA', aliases: ['ksa'], regions: [], cities: ['Riyadh', 'Jeddah'] },
  { name: 'Egypt', code: 'EG', aliases: [], regions: [], cities: ['Cairo'] },
  { name: 'Nigeria', code: 'NG', aliases: [], regions: [], cities: ['Lagos', 'Abuja'] },
  { name: 'Kenya', code: 'KE', aliases: [], regions: [], cities: ['Nairobi'] },
  { name: 'South Africa', code: 'ZA', aliases: ['rsa'], regions: [], cities: ['Johannesburg', 'Cape Town'] },
  { name: 'Singapore', code: 'SG', aliases: [], regions: [], cities: ['Singapore'] },
  { name: 'Hong Kong', code: 'HK', aliases: [], regions: [], cities: ['Hong Kong'] },
  { name: 'China', code: 'CN', aliases: ['prc'], regions: [], cities: ['Shanghai', 'Beijing', 'Shenzhen', 'Hangzhou'] },
  { name: 'Taiwan', code: 'TW', aliases: [], regions: [], cities: ['Taipei'] },
  { name: 'Japan', code: 'JP', aliases: ['nippon'], regions: [], cities: ['Tokyo', 'Osaka', 'Kyoto'] },
  { name: 'South Korea', code: 'KR', aliases: ['korea'], regions: [], cities: ['Seoul'] },
  { name: 'Philippines', code: 'PH', aliases: [], regions: [], cities: ['Manila'] },
  { name: 'Vietnam', code: 'VN', aliases: [], regions: [], cities: ['Ho Chi Minh City', 'Hanoi'] },
  { name: 'Indonesia', code: 'ID', aliases: [], regions: [], cities: ['Jakarta'] },
  { name: 'Malaysia', code: 'MY', aliases: [], regions: [], cities: ['Kuala Lumpur'] },
  { name: 'Pakistan', code: 'PK', aliases: [], regions: [], cities: ['Karachi', 'Lahore', 'Islamabad'] },
  { name: 'Bangladesh', code: 'BD', aliases: [], regions: [], cities: ['Dhaka'] },
  { name: 'New Zealand', code: 'NZ', aliases: [], regions: [], cities: ['Auckland', 'Wellington'] },
  { name: 'Mexico', code: 'MX', aliases: ['méxico'], regions: [], cities: ['Mexico City', 'Guadalajara', 'Monterrey'] },
  { name: 'Brazil', code: 'BR', aliases: ['brasil'], regions: [], cities: ['São Paulo', 'Sao Paulo', 'Rio de Janeiro'] },
  { name: 'Argentina', code: 'AR', aliases: [], regions: [], cities: ['Buenos Aires'] },
  { name: 'Colombia', code: 'CO', aliases: [], regions: [], cities: ['Bogotá', 'Bogota', 'Medellín'] },
  { name: 'Chile', code: 'CL', aliases: [], regions: [], cities: ['Santiago'] },
];
// Places that aren't a country or region but people search for.
export const SPECIAL = ['Remote', 'Europe', 'EMEA', 'APAC', 'Latin America', 'North America'];

const lo = (s) => String(s || '').toLowerCase();
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Every place as a suggestion string: "United States", "California, United States", "Toronto, Canada".
export const ALL_PLACES = [...SPECIAL, ...COUNTRIES.flatMap((c) => [c.name, ...c.regions.map((r) => `${r.name}, ${c.name}`), ...c.cities.map((x) => `${x}, ${c.name}`)])];

// What you see while typing a place. A country (or its short name: "us", "uk", "usa") shows the country
// first and then its states/provinces; otherwise anything that starts with, then contains, what you typed.
export function suggestPlaces(query, taken = []) {
  const q = lo(query).trim();
  const free = (s) => !taken.some((t) => lo(t) === lo(s));
  if (!q) return [...SPECIAL.slice(0, 1), ...COUNTRIES.slice(0, 8).map((c) => c.name)].filter(free);
  const country = COUNTRIES.find((c) => lo(c.name) === q || lo(c.code) === q || c.aliases.includes(q));
  if (country) return [country.name, ...country.regions.map((r) => `${r.name}, ${country.name}`), ...country.cities.map((x) => `${x}, ${country.name}`)].filter(free);
  const starts = ALL_PLACES.filter((p) => lo(p).startsWith(q));
  const words = ALL_PLACES.filter((p) => !lo(p).startsWith(q) && lo(p).split(/[\s,]+/).some((w) => w.startsWith(q)));
  return [...new Set([...starts, ...words])].filter(free);
}

// Which country a place or a job location belongs to (null if it doesn't say).
export function countryOf(text) {
  const raw = String(text || ''), t = lo(raw);
  for (const c of COUNTRIES) {
    if (new RegExp(`\\b${esc(lo(c.name))}\\b`).test(t) || c.aliases.some((a) => a.length > 2 && new RegExp(`\\b${esc(a)}\\b`).test(t))) return c;
  }
  // Cities and region names next ("Toronto, ON, CA" is Canada even though "CA" is also California's code)…
  for (const c of COUNTRIES) if (c.cities.some((x) => new RegExp(`\\b${esc(lo(x))}\\b`).test(t))) return c;
  for (const c of COUNTRIES) if (c.regions.some((r) => new RegExp(`\\b${esc(lo(r.name))}\\b`).test(t))) return c;
  // …then a region code after a comma ("Fresno, CA"), in exact capitals so words like "in" never match.
  for (const c of COUNTRIES) if (c.regions.some((r) => r.code && new RegExp(`,\\s*${r.code}\\b`).test(raw))) return c;
  if (/\b(us|usa|u\.s\.)\b/i.test(raw)) return COUNTRIES[0];
  if (/\buk\b/i.test(raw)) return COUNTRIES.find((c) => c.code === 'GB');
  return null;
}

// Does a job location match a place you search? Countries match any of their regions, codes and cities;
// regions match their name or code ("California" ↔ "San Francisco, CA"); cities match by name.
export function placeMatches(place, jobLocation) {
  const p = lo(place).split(',')[0].trim(), raw = String(jobLocation || ''), t = lo(raw);
  if (!p) return false;
  if (p === 'remote') return /remote|anywhere|work from home|wfh/.test(t);
  if (['north america', 'europe', 'emea', 'apac', 'latin america'].includes(p)) return t.includes(p);
  const country = COUNTRIES.find((c) => lo(c.name) === p || c.aliases.includes(p) || lo(c.code) === p);
  if (country) return countryOf(raw) === country;
  for (const c of COUNTRIES) {
    const r = c.regions.find((x) => lo(x.name) === p || lo(x.code) === p);
    if (r) return new RegExp(`\\b${esc(lo(r.name))}\\b`).test(t) || (r.code && new RegExp(`,\\s*${r.code}\\b`).test(raw));
  }
  return new RegExp(`\\b${esc(p)}\\b`).test(t);
}

// A region's code and country for a "City, Region" string you typed ("Edmonton, AB", "Austin, Texas").
export function regionOf(text) {
  const raw = String(text || ''), t = lo(raw);
  for (const c of COUNTRIES) for (const r of c.regions) {
    if ((r.code && new RegExp(`,\\s*${r.code}\\b`).test(raw)) || new RegExp(`\\b${esc(lo(r.name))}\\b`).test(t)) return { ...r, country: c.name };
  }
  return null;
}
