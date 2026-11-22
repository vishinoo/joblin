// Smoke test for the dashboard: opens every page and Settings tab in headless Chrome and reports
// JavaScript errors, failed API calls and empty pages. Joblin must be running (npm start).
//   node scripts/smoke.mjs [http://localhost:4321]
import { chromium } from 'playwright';

const base = process.argv[2] || 'http://localhost:4321';
const routes = ['dashboard', 'review', 'applications', 'outreach', 'answers', 'memory', 'settings'];
const tabs = ['integrations', 'ai', 'sources', 'positions', 'automation', 'resumes', 'cover', 'profile', 'email'];
const problems = [];

const browser = await chromium.launch({ channel: 'chrome', headless: true });
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
let where = 'start';
page.on('pageerror', (e) => problems.push(`${where}: ${e.message}`));
page.on('console', (m) => m.type() === 'error' && !/favicon/.test(m.text()) && problems.push(`${where}: console: ${m.text()}`));
page.on('response', (r) => r.url().includes('/api/') && r.status() >= 400 && problems.push(`${where}: ${r.status()} ${r.url().replace(base, '')}`));

await page.goto(base, { waitUntil: 'networkidle' });
for (const r of routes) {
  where = r;
  await page.evaluate((h) => (location.hash = `#/${h}`), r);
  await page.waitForTimeout(900);
  const text = (await page.locator('#view, main').first().innerText().catch(() => '')).trim();
  if (text.length < 20) problems.push(`${r}: page looks empty`);
}
for (const t of tabs) {
  where = `settings/${t}`;
  await page.evaluate(() => (location.hash = '#/dashboard'));
  await page.waitForTimeout(200);
  await page.evaluate(() => (location.hash = '#/settings'));
  await page.waitForTimeout(500);
  await page.locator(`.stabs button[data-t="${t}"]`).click().catch((e) => problems.push(`${where}: no tab (${e.message.split('\n')[0]})`));
  await page.waitForTimeout(700);
}
// Applications and Outreach filters
for (const [r, sel] of [['applications', '#af button'], ['outreach', '#ef button']]) {
  where = `${r} filters`;
  await page.evaluate((h) => (location.hash = `#/${h}`), r);
  await page.waitForTimeout(800);
  for (const b of await page.locator(sel).all()) { await b.click(); await page.waitForTimeout(150); }
}
await browser.close();
console.log(problems.length ? `✗ ${problems.length} problem(s):\n${[...new Set(problems)].map((p) => `  - ${p}`).join('\n')}` : '✓ every page and settings tab loaded cleanly');
process.exit(problems.length ? 1 : 0);
