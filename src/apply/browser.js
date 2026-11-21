import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { config, paths } from '../core/config.js';
import { kv, log } from '../core/db.js';

let ctx, ctxHeadless;
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';

// One persistent profile keeps your LinkedIn session (and any ATS logins) between runs.
// Tabs you've been handed (a filled form waiting for your click) keep the browser open.
let holds = 0;
export function holdOpen() { holds++; let done = false; return () => { if (done) return; done = true; holds = Math.max(0, holds - 1); }; }
export const heldOpen = () => holds > 0;

// ---------- Keeping Joblin's Chrome out of your way (macOS) ----------
// Job sites block headless browsers, so applications use a real Chrome window, which Joblin hides
// right away (like ⌘H) and then hands focus back to whatever you were using.
// Uses AppKit's NSRunningApplication via JXA: no Accessibility permission needed.
const jxa = (code) => new Promise((res) => execFile('osascript', ['-l', 'JavaScript', '-e', `ObjC.import('AppKit');${code}`], { timeout: 5000 }, (e, out) => res(e ? '' : String(out).trim())));
const frontmostPid = async () => Number(await jxa('$.NSWorkspace.sharedWorkspace.frontmostApplication.processIdentifier')) || 0;
function chromePid() {
  return new Promise((res) => execFile('ps', ['-axo', 'pid=,command='], { maxBuffer: 1 << 24 }, (e, out) => {
    if (e) return res(0);
    const line = String(out).split('\n').find((l) => l.includes(`--user-data-dir=${paths.browser}`) && !l.includes('--type=') && !/crashpad|helper/i.test(l));
    res(line ? Number(line.trim().split(/\s+/)[0]) : 0);
  }));
}
const appCall = (pid, call) => pid && jxa(`var a=$.NSRunningApplication.runningApplicationWithProcessIdentifier(${pid}); if (a) { ${call} }`);
let hiddenWanted = false, returnTo = 0;
export async function hideBrowser() {
  if (process.platform !== 'darwin' || !ctx) return;
  hiddenWanted = true;
  const pid = await chromePid();
  await appCall(pid, 'a.hide;');
  if (returnTo && returnTo !== pid) await appCall(returnTo, 'a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);');
}
export async function showBrowser() {
  if (process.platform !== 'darwin' || !ctx) return;
  hiddenWanted = false;
  await appCall(await chromePid(), 'a.unhide; a.activateWithOptions($.NSApplicationActivateIgnoringOtherApps);');
}
export const browserHidden = () => hiddenWanted;

// Watchdog: while Joblin's Chrome is meant to be hidden, check every second which app is in front.
// If Chrome jumped forward (a new tab, a site's pop-up, a relaunch), hide it again and give focus back to
// the app you were using. Your last app is remembered so focus goes back to the right place.
let watchdog = null;
function startWatchdog() {
  if (process.platform !== 'darwin' || watchdog) return;
  let busy = false;
  watchdog = setInterval(async () => {
    if (busy || !ctx || !hiddenWanted) return;
    busy = true;
    try {
      const [front, chrome] = await Promise.all([frontmostPid(), chromePid()]);
      if (front && front !== chrome) returnTo = front;
      else if (front && front === chrome) await hideBrowser();
    } finally { busy = false; }
  }, 1000);
  watchdog.unref?.();
}
const stopWatchdog = () => { clearInterval(watchdog); watchdog = null; };

// Each worker gets its own tab (searching and applying can run at the same time). Reusing tabs
// means no new windows, so nothing ever jumps in front of you.
const heldPages = new WeakSet();
const rolePages = new Map();
export const markHeld = (p) => { heldPages.add(p); for (const [k, v] of rolePages) if (v === p) rolePages.delete(k); };
export async function workPage(c, role = 'find') {
  const mine = rolePages.get(role);
  if (mine && !mine.isClosed() && mine.context() === c) return mine;
  const taken = new Set(rolePages.values());
  let p = c.pages().find((x) => !heldPages.has(x) && !x.isClosed() && !taken.has(x));
  if (!p) { p = await c.newPage(); if (hiddenWanted) await hideBrowser(); }
  rolePages.set(role, p);
  return p;
}

// The searcher and the applier can ask for Chrome at the same moment; only one may launch it (one profile = one Chrome).
let opening = Promise.resolve();
export function getContext(opts = {}) {
  const run = opening.then(() => openContext(opts));
  opening = run.catch(() => {});
  return run;
}
async function openContext({ headless = config.apply.browser !== 'window', hidden = false } = {}) {
  // On a Mac, "background" means a real Chrome that Joblin hides: sites trust it, you never see it,
  // and searching and applying share one browser, so it isn't relaunched mid-run.
  if (process.platform === 'darwin' && headless && config.apply.browser !== 'window') { headless = false; hidden = true; }
  if (ctx && (ctxHeadless === headless || holds > 0)) { if (!headless && hidden && !hiddenWanted && holds === 0) await hideBrowser(); return ctx; } // never kill a window you're using
  if (ctx) await closeContext(true);
  if (!headless && hidden && process.platform === 'darwin') returnTo = await frontmostPid();
  const opts = {
    headless,
    userAgent: UA,
    viewport: headless || hidden ? { width: 1280, height: 860 } : null,
    args: ['--disable-blink-features=AutomationControlled', '--no-first-run', '--no-default-browser-check',
      ...(headless ? [] : hidden ? ['--window-size=1280,900', '--window-position=0,2000'] : ['--window-size=1180,860', '--window-position=160,90'])],
  };
  try { ctx = await chromium.launchPersistentContext(paths.browser, { ...opts, channel: 'chrome' }); }
  catch { ctx = await chromium.launchPersistentContext(paths.browser, opts); } // bundled Chromium fallback
  ctxHeadless = headless;
  ctx.on('close', () => { ctx = null; hiddenWanted = false; rolePages.clear(); stopWatchdog(); });
  if (!headless && hidden) {
    await hideBrowser();
    // New windows can pop the app back up; hide it again whenever one opens (unless you were handed a form).
    ctx.on('page', () => { if (hiddenWanted) setTimeout(() => hideBrowser(), 60); });
    startWatchdog();
  }
  return ctx;
}
export async function closeContext(force = false) { if (holds > 0 && !force) return; await ctx?.close().catch(() => {}); ctx = null; }
export const isBrowserBusy = () => Boolean(ctx);

export const linkedinStatus = () => kv.get('linkedin', { connected: false });
export function setLinkedinStatus(connected, note = '') {
  kv.set('linkedin', { connected, note, at: new Date().toISOString() });
}

const hasSession = async (c) => (await c.cookies('https://www.linkedin.com')).some((k) => k.name === 'li_at' && k.value);

// Opens a normal, centered window so you can sign in once. We watch for LinkedIn's session cookie
// (more reliable than watching URLs), then close the window automatically.
let connecting = false;
export async function connectLinkedIn() {
  if (connecting) return;
  connecting = true;
  setLinkedinStatus(false, 'waiting for sign-in');
  try {
    if (ctx && hiddenWanted) await closeContext(true); // the sign-in window has to be visible
    const c = await getContext({ headless: false, hidden: false });
    const page = c.pages()[0] || (await c.newPage());
    await page.bringToFront();
    if (!(await hasSession(c))) await page.goto('https://www.linkedin.com/login');
    // Close the moment the sign-in cookie appears; no extra page loads.
    const deadline = Date.now() + 10 * 60 * 1000;
    while (Date.now() < deadline && !(await hasSession(c).catch(() => false))) await new Promise((r) => setTimeout(r, 400));
    if (await hasSession(c).catch(() => false)) {
      setLinkedinStatus(true, '');
      log('linkedin', 'LinkedIn connected');
    } else setLinkedinStatus(false, 'sign-in timed out');
  } catch (e) {
    setLinkedinStatus(false, `couldn't open the sign-in window: ${e.message.split('\n')[0]}`);
  } finally { connecting = false; await closeContext(); }
}

export async function disconnectLinkedIn() {
  const c = await getContext({ headless: true });
  await c.clearCookies({ domain: /linkedin\.com/ }).catch(() => c.clearCookies());
  await closeContext();
  setLinkedinStatus(false, 'disconnected');
}

// CLI fallback: `node start.js login`
export async function interactiveLogin() {
  console.log('\n→ Log into LinkedIn in the opened window.\n');
  await connectLinkedIn();
  console.log(linkedinStatus().connected ? '✓ LinkedIn connected.' : '✗ Not connected.');
}
