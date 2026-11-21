// "Connect Gmail": you sign in to Google once in a Joblin window. Joblin then
//  1. reads security codes from Gmail's unread feed in that window (works right away), and
//  2. creates its own app password on Google's App passwords page, so it can also send outreach and
//     watch for replies. If Google won't allow that (2-Step Verification off), codes still work.
import { getContext, closeContext, workPage, browserHidden } from '../apply/browser.js';
import { config, saveEnv } from '../core/config.js';
import { verifyGmail, resetTransport } from './mailer.js';
import { kv, log } from '../core/db.js';

const FEED = 'https://mail.google.com/mail/u/0/feed/atom';
export const gmailWebStatus = () => kv.get('gmailWeb', { connected: false });
const setStatus = (connected, note = '', email = '') => kv.set('gmailWeb', { connected, note, email, at: new Date().toISOString() });

const decode = (s) => String(s || '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
const tag = (xml, t) => decode(xml.match(new RegExp(`<${t}[^>]*>([\\s\\S]*?)</${t}>`))?.[1] || '');

async function readFeed(c) {
  const r = await c.request.get(FEED, { timeout: 15000, maxRedirects: 0 }).catch(() => null);
  if (!r || r.status() !== 200) return null;
  const xml = await r.text().catch(() => '');
  if (!/<feed/.test(xml)) return null;
  return {
    email: tag(xml, 'title').match(/[\w.+-]+@[\w.-]+/)?.[0] || '',
    messages: [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(([, e]) => ({
      subject: tag(e, 'title'), text: tag(e, 'summary'),
      from: (tag(e.match(/<author>[\s\S]*?<\/author>/)?.[0] || '', 'email') || '').toLowerCase(),
      date: Date.parse(tag(e, 'issued') || tag(e, 'modified')) || 0,
      link: decode(e.match(/<link[^>]*href="([^"]+)"/)?.[1] || ''),
    })),
  };
}

const ctxFor = () => getContext({ headless: false, hidden: config.apply.window !== 'visible' || browserHidden() });

// Unread messages since `sinceMs`. `open(m)` returns a message's full text (for codes not in the preview).
export async function gmailWebRecent(sinceMs) {
  if (!gmailWebStatus().connected) return [];
  const c = await ctxFor();
  const f = await readFeed(c);
  if (!f) { setStatus(false, 'signed out of Gmail'); log('gmail', 'Joblin’s browser was signed out of Gmail'); return []; }
  return f.messages.filter((m) => m.date >= sinceMs - 60e3);
}
export async function gmailWebOpen(m) {
  if (!m.link) return '';
  const c = await ctxFor();
  const page = await workPage(c, 'mail');
  try {
    await page.goto(m.link, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.locator('div[role="main"] .a3s, div[role="listitem"] .a3s').last().waitFor({ timeout: 12000 }).catch(() => {});
    return (await page.locator('div[role="main"]').innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 4000);
  } finally { await page.goto('about:blank').catch(() => {}); }
}

// Opens a visible Joblin window on Google sign-in, then sets up sending. Closes by itself when done.
let connecting = false;
export async function connectGmailWeb() {
  if (connecting) return;
  connecting = true;
  setStatus(false, 'waiting for sign-in');
  try {
    await closeContext(true); // the sign-in window has to be visible
    const c = await getContext({ headless: false, hidden: false });
    const page = c.pages()[0] || (await c.newPage());
    let f = await readFeed(c);
    if (!f) {
      await page.goto('https://accounts.google.com/ServiceLogin?service=mail&continue=https%3A%2F%2Fmail.google.com%2Fmail%2F');
      await page.bringToFront().catch(() => {});
      const deadline = Date.now() + 10 * 60 * 1000;
      while (Date.now() < deadline && !(f = await readFeed(c))) {
        const body = await page.locator('body').innerText().catch(() => '');
        if (/browser or app may not be secure|couldn.t sign you in/i.test(body)) { setStatus(false, 'Google blocked sign-in from this window — use an app password instead (below)'); return; }
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (!f) { setStatus(false, 'sign-in timed out'); return; }
    setStatus(true, 'setting up sending', f.email);
    log('gmail', `Gmail connected in Joblin’s browser${f.email ? ` (${f.email})` : ''}`);
    if (!(process.env.GMAIL_USER && process.env.GMAIL_APP_PASSWORD) && f.email) {
      const ok = await makeAppPassword(page, f.email).catch((e) => { log('error', `gmail app password: ${e.message}`); return false; });
      setStatus(true, ok ? '' : 'sending not set up', f.email);
    } else setStatus(true, '', f.email);
  } catch (e) {
    setStatus(false, `couldn't open the sign-in window: ${e.message.split('\n')[0]}`);
  } finally { connecting = false; await closeContext(); }
}

// Google's App passwords page: name it "Joblin", press Create, and read the 16-letter password from the
// dialog. Google may ask for your password again first; you type it in the open window and Joblin waits.
async function makeAppPassword(page, email) {
  await page.goto('https://myaccount.google.com/apppasswords', { waitUntil: 'domcontentloaded' });
  const deadline = Date.now() + 6 * 60 * 1000;
  let created = false;
  const tried = new Set();
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1500));
    if (!/myaccount\.google\.com\/apppasswords/.test(page.url())) continue; // still confirming your password
    const body = await page.locator('body').innerText().catch(() => '');
    if (/not available for your account|setting you are looking for is not available/i.test(body)) {
      setStatus(true, 'turn on 2-Step Verification in your Google account to let Joblin send emails', email); return false;
    }
    if (!created) {
      const name = page.locator('input[aria-label*="App name" i], input[type="text"]').first();
      if (await name.isVisible().catch(() => false)) {
        await name.fill('Joblin'); await name.press('Enter').catch(() => {});
        await page.locator('button:has-text("Create")').first().click({ timeout: 2000 }).catch(() => {});
        created = true;
      }
      continue;
    }
    // The password shows as four groups of four letters in the dialog. Check each candidate with Google.
    const dialog = await page.locator('[role="dialog"], [role="alertdialog"]').allInnerTexts().catch(() => []);
    for (const m of dialog.join('\n').matchAll(/\b([a-z]{4})\s?([a-z]{4})\s?([a-z]{4})\s?([a-z]{4})\b/g)) {
      const pass = m.slice(1).join('');
      if (tried.has(pass)) continue;
      tried.add(pass);
      if (await verifyGmail(email, pass).then(() => true, () => false)) {
        saveEnv({ GMAIL_USER: email, GMAIL_APP_PASSWORD: pass });
        resetTransport();
        log('gmail', `Gmail sending set up for ${email}`);
        await page.locator('button:has-text("Done")').first().click({ timeout: 1500 }).catch(() => {});
        return true;
      }
    }
  }
  return false;
}

export async function disconnectGmailWeb() {
  setStatus(false, 'disconnected');
  try { const c = await ctxFor(); await c.clearCookies({ domain: /(^|\.)google\.com$/ }); } catch {}
}
