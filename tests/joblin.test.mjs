// Joblin's unit tests: the rules that decide what gets typed into applications, what counts as a match,
// and how searches are ordered. Run with `npm test`. They use a throwaway data folder (JOBLIN_HOME),
// so your settings, database and browser profile are never touched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'joblin-test-'));
const example = JSON.parse(fs.readFileSync(new URL('../config.example.json', import.meta.url), 'utf8'));
example.profile = { ...example.profile, city: 'Surrey', region: 'BC', bases: ['Edmonton, AB', 'Vancouver, BC'], currentEmployer: 'Acme', currentTitle: 'Analyst Intern',
  jobStartMonth: 'May', jobStartYear: '2026', jobEndMonth: 'August', jobEndYear: '2026', graduationMonth: 'April', graduationYear: '2028', eduStartMonth: 'September', eduStartYear: '2024' };
fs.writeFileSync(path.join(home, 'config.json'), JSON.stringify(example));
process.env.JOBLIN_HOME = home;

const { activeSearch, config } = await import('../src/core/config.js');
const { findCode } = await import('../src/email/inbox.js');
const { parseDates, homeFor, applyOrder, roleKey } = await import('../src/you/profile.js');
const { titleMatches } = await import('../src/search/boards.js');
const { fairOrder, noteFocus } = await import('../src/search/linkedin.js');
const { _contextRule: contextRule } = await import('../src/apply/apply.js');
const { remember, recall } = await import('../src/you/memory.js');

test('reads emailed security codes, never ordinary words', () => {
  assert.equal(findCode('Copy and paste this code into the security code field on your application: aB3dE9xQ'), 'aB3dE9xQ');
  assert.equal(findCode('Your Security code is: XYZWQRTP'), 'XYZWQRTP');
  assert.equal(findCode('verification code Required'), null);
  assert.equal(findCode('no code word here at all'), null);
});

test('parses resume dates, including current roles', () => {
  assert.deepEqual(parseDates('May 2026 – September 2026'), { start: { month: 'May', year: '2026' }, end: { month: 'September', year: '2026' }, current: false });
  const cur = parseDates('Jul 2026 - Present');
  assert.equal(cur.current, true); assert.equal(cur.end, null); assert.equal(cur.start.month, 'July');
});

test('answers "where are you located" with the base closest to the job', () => {
  assert.equal(homeFor('Calgary, Alberta, Canada').city, 'Edmonton');
  assert.equal(homeFor('Vancouver, BC').city, 'Vancouver');
  assert.equal(homeFor('Toronto, ON').city, 'Surrey'); // no base nearby: your real city
  assert.equal(homeFor('Remote').city, 'Surrey');
});

test('finance searches accept finance-type titles; software searches stay software', () => {
  for (const t of ['Investment Analyst Intern', 'Quantitative Trader Intern', 'Financial Analyst, Summer']) assert.ok(titleMatches(t, ['finance']), t);
  assert.ok(!titleMatches('Software Engineer Intern', ['finance']));
  assert.ok(titleMatches('Backend Developer Intern', ['software']));
  assert.ok(!titleMatches('Equity Research Intern', ['software']));
});

test('search order: fields take turns, recent chat focus goes first', () => {
  const q = ['software engineer intern', 'backend intern', 'finance intern', 'equity research intern'].map((keywords) => ({ keywords, track: 'auto' }));
  noteFocus([{ keywords: 'finance intern', track: 'finance' }]);
  const order = fairOrder(q).map((x) => x.keywords);
  assert.match(order[0], /finance|equity/); // finance first after a finance chat search
  assert.notEqual(/finance|equity/.test(order[0]), /finance|equity/.test(order[1])); // then alternate
});

test('your chosen role order wins over the default', () => {
  const roles = [{ org: 'A', role: 'x' }, { org: 'B', role: 'y' }, { org: 'C', role: 'z' }];
  assert.deepEqual(applyOrder(roles, [roleKey(roles[2]), roleKey(roles[0])]).map((r) => r.org), ['C', 'A', 'B']);
  assert.deepEqual(applyOrder(roles, null).map((r) => r.org), ['A', 'B', 'C']);
});

test('date fields depend on the section and on month/year splits', () => {
  const job = { title: 'Analyst Intern', company: 'X' };
  assert.equal(contextRule({ label: 'Graduation month', id: '', name: '', section: '' }, job), 'April');
  assert.equal(contextRule({ label: 'Start date year', id: 'start-year', name: '', section: 'education' }, job), '2024');
  assert.equal(contextRule({ label: 'Start date (MM/YYYY)', id: 'start-date-0', name: '', section: 'employment' }, job), '05/2026');
  assert.equal(contextRule({ label: 'Company name', id: 'company-name-0', name: '', section: 'employment' }, job), 'Acme');
});

test('chat searches given as plain text still work', () => {
  config.runSearch = { queries: ['finance intern'] };
  assert.deepEqual(activeSearch().queries, [{ keywords: 'finance intern' }]);
  config.runSearch = null;
});

test('answer memory: your answers are reused; similar guesses are not', () => {
  remember('Are you legally authorized to work in Canada?', 'Yes', { source: 'you' });
  assert.equal(recall('Are you legally authorized to work in Canada?').answer, 'Yes');
  remember('What is your favourite colour?', 'Blue'); // a model guess
  assert.equal(recall('What is your favorite color today?'), null);
});

test('places work worldwide: "us" means the US and its states, codes and cities match', async () => {
  const { suggestPlaces, placeMatches, countryOf } = await import('../public/places.js');
  const us = suggestPlaces('us');
  assert.equal(us[0], 'United States'); assert.ok(us.includes('California, United States')); assert.ok(!us.some((p) => /Ontario/.test(p)));
  assert.equal(suggestPlaces('uk')[0], 'United Kingdom');
  assert.ok(placeMatches('United States', 'San Francisco, CA'));
  assert.ok(placeMatches('California', 'San Francisco, CA'));
  assert.ok(!placeMatches('United States', 'Toronto, ON, CA')); // "CA" here is Canada
  assert.ok(placeMatches('Germany', 'Berlin'));
  assert.equal(countryOf('London')?.name, 'United Kingdom');
});

test('bases anywhere in the world: an Austin job gets your Texas base', () => {
  config.profile.bases = ['Austin, Texas', 'Edmonton, AB'];
  assert.equal(homeFor('Dallas, TX').city, 'Austin');
  assert.equal(homeFor('Calgary, Alberta, Canada').city, 'Edmonton');
  config.profile.bases = ['Edmonton, AB', 'Vancouver, BC'];
});

test('inbox: newsletters that mention a company never count as replies', async () => {
  const { matchJob } = await import('../src/email/inbox.js');
  const jobs = [{ id: 1, company: 'Later', title: 'AI Automation Co-op', company_domain: 'later.com' }, { id: 2, company: 'Lyft', title: 'Business Systems Engineer Intern', company_domain: '' }];
  assert.equal(matchJob('news@oilprice.com', 'Energy stocks later this week', 'see you later', jobs), null);
  assert.equal(matchJob('deals@lyft.com', 'Ride promo', 'Lyft promo', jobs), null); // no domain on file, not a hiring sender
  assert.equal(matchJob('no-reply@greenhouse.io', 'Your application to Lyft', 'Business Systems Engineer Intern', jobs)?.id, 2);
  assert.equal(matchJob('recruiting@later.com', 'Next steps', '', jobs)?.id, 1);
});

test('phone fields: your own country code, digits only', async () => {
  const { _ruleFor: ruleFor } = await import('../src/apply/apply.js');
  config.profile.phone = '+1 250-608-6197'; config.profile.country = 'Canada';
  assert.equal(ruleFor('Phone country code'), 'Canada');
  assert.equal(ruleFor('Mobile phone number'), '2506086197');
  config.profile.country = 'United Kingdom';
  assert.equal(ruleFor('Phone country code'), 'United Kingdom');
});

test('outreach emails: short role names and no mail-merge lines', async () => {
  const { shortRole, emailTemplate } = await import('../src/email/mailer.js');
  assert.equal(shortRole('Summer 2027 Tax Consulting Intern - Canada'), 'Tax Consulting Intern');
  assert.equal(shortRole('[Summer 2027 Canada] Software Engineer Intern, Engine'), 'Software Engineer Intern, Engine');
  assert.equal(shortRole('Software Engineer Intern, Summer 2027'), 'Software Engineer Intern');
  assert.equal(shortRole('Analyst'), 'Analyst');
  assert.doesNotMatch(emailTemplate('intro'), /reply "?stop|prefer not to hear/i);
  config.email.templates = { intro: 'Subject: Hi\n\nMy own words' };
  assert.equal(emailTemplate('intro'), 'Subject: Hi\n\nMy own words');
  config.email.templates = { intro: '' };
});

test('chat: "more emails to <company>" finds the application you mean', async () => {
  const { db } = await import('../src/core/db.js');
  const { jobNamedIn } = await import('../src/email/contacts.js');
  const id = db.prepare(`INSERT INTO jobs (title, company) VALUES ('Tax Intern', 'Ryan')`).run().lastInsertRowid;
  db.prepare(`INSERT INTO applications (job_id, status) VALUES (?, 'submitted')`).run(id);
  assert.equal(jobNamedIn('I want more messages to Ryan')?.id, id);
  assert.equal(jobNamedIn('more people at ryan please')?.id, id);
  assert.equal(jobNamedIn('more people at Bryant'), null);
});

test('outreach intro leads with the experience that fits the job; company line never invents', async () => {
  const { jobField, topicOk } = await import('../src/email/mailer.js');
  assert.equal(jobField({ title: 'Data Analyst, Intern' }, 'finance'), 'tech');
  assert.equal(jobField({ title: 'Summer 2027 Tax Consulting Intern - Canada' }, 'swe'), 'finance');
  assert.equal(jobField({ title: 'Financial Data Analyst' }, 'finance'), 'finance');
  const desc = 'You will join the payments team building fraud detection for small businesses.';
  assert.equal(topicOk('fraud detection for small businesses', desc, 'Stripe'), true);
  assert.equal(topicOk('blockchain trading for hedge funds', desc, 'Stripe'), false); // not in the posting
  assert.equal(topicOk('what we do at Stripe', desc, 'Stripe'), false);
  assert.equal(topicOk('fraud prevention for online businesses', 'fraud prevention for online businesses', 'X'), false); // the prompt's example
});
