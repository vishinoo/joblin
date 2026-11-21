#!/usr/bin/env node
// Joblin — find jobs on LinkedIn, apply on company sites, tailor docs with a local LLM, drip outreach emails.
//
//   node start.js            app window + dashboard + scheduler (everything is configurable in Settings)
//   node start.js --no-window  same, without opening the app window
//   node start.js run [--dry]  discover + prepare a batch now (and apply approved jobs)
//   node start.js login      sign into LinkedIn (same as Settings → Integrations → Connect)
//   node start.js test-docs "Job Title"   generate a sample resume + cover letter

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config, paths } from './src/core/config.js';
import { log, db, kv } from './src/core/db.js';
import { interactiveLogin, closeContext, linkedinStatus, heldOpen } from './src/apply/browser.js';
import { discover } from './src/search/linkedin.js';
import { discoverBoards } from './src/search/boards.js';
import { prepareBatch, applyApproved } from './src/apply/apply.js';
import { dripTick } from './src/email/mailer.js';
import { checkInbox, canReadInbox } from './src/email/inbox.js';
import { startServer } from './src/server.js';
import { prepareDocuments, closePdfBrowser } from './src/apply/documents.js';

const [cmd = 'serve', ...flags] = process.argv.slice(2).filter((a) => a !== '--no-window').concat([]);
const dryRun = process.argv.includes('--dry');

// ---------- Two workers that run side by side ----------
// finder: search (company boards + LinkedIn) → write resumes & cover letters
// applier: submit approved applications, one after another, until none are left
const newWorker = () => ({ state: null, phase: '', detail: '', progress: null, found: 0, prepared: 0, applied: 0, startedAt: null });
const workers = { find: newWorker(), apply: newWorker() };
const busy = (w) => Boolean(workers[w].state);
const anyBusy = () => busy('find') || busy('apply');
const phase = (w, name, detail) => Object.assign(workers[w], { phase: name, detail, progress: null });
const progressOf = (w) => (p) => { workers[w].progress = p; };
async function cleanupIfIdle() { if (!anyBusy() && !heldOpen()) { await closeContext(); await closePdfBrowser(); } }

async function runWorker(w, state, fn) {
  if (busy(w)) return false;
  Object.assign(workers[w], newWorker(), { state, startedAt: new Date().toISOString() });
  try { await fn(); } catch (e) { log('error', `${state}: ${e.message}`); console.error(e.stack); }
  finally { if (w === 'find') config.runSearch = null; workers[w] = newWorker(); await cleanupIfIdle(); }
  return true;
}

const approvedCount = () => db.prepare(`SELECT COUNT(*) n FROM applications WHERE status = 'approved'`).get().n;

// Applier: keeps going while anything is approved, in small chunks so new approvals join quickly.
function startApplier({ dryRun = false, manual = false } = {}) {
  if (manual) config.applyPaused = false; // you approved or retried something: resume
  if (busy('apply') || !approvedCount() || config.applyPaused) return false;
  config.stopApply = false;
  runWorker('apply', 'applying', async () => {
    const cap = Math.min(config.apply.maxApplicationsPerRun || 15, 30);
    while (approvedCount() && workers.apply.applied < cap && !config.stopApply) {
      phase('apply', 'apply', 'Applying');
      const total = approvedCount();
      const r = await applyApproved({ dryRun, limit: 1, onProgress: (p) => (workers.apply.progress = { done: workers.apply.applied, total: workers.apply.applied + total, current: p.current }) });
      workers.apply.applied += Object.values(r).reduce((a, b) => a + b, 0) || 1;
    }
    log('run', `Applier finished: ${workers.apply.applied} handled`);
  }).then(() => { if (approvedCount() && !config.applyPaused) setTimeout(() => startApplier(), 2000); });
  return true;
}

// Finder: search → prepare a small batch. In autopilot, approved jobs flow straight to the applier.
function startFinder({ dryRun = false, search = null } = {}) {
  if (busy('find')) return false;
  runWorker('find', 'running', async () => {
    const W = workers.find;
    config.runSearch = search; // a one-off request from the chat, or null for your saved search
    config.stopFind = false;
    if (config.sources?.boards?.enabled !== false) { phase('find', 'boards', 'Checking company job boards'); W.found += await discoverBoards({ onProgress: progressOf('find') }); }
    if (config.sources?.linkedin?.enabled !== false) { phase('find', 'linkedin', linkedinStatus().connected ? 'Searching LinkedIn' : 'Searching LinkedIn (public listings)'); W.found += await discover({ onProgress: progressOf('find') }); }
    log('run', `Found ${W.found} new jobs`);
    phase('find', 'prepare', 'Writing resumes and cover letters');
    const batch = Math.min(config.mode.batchSize || 8, 15);
    W.prepared = await prepareBatch(batch, (p) => {
      progressOf('find')(p);
      if (config.mode.type === 'autopilot') { autoApprove(); startApplier({ dryRun }); } // apply while the rest are still being written
    });
    config.runSearch = null;
    kv.set('lastRunAt', new Date().toISOString());
    if (config.mode.type === 'autopilot') { autoApprove(); startApplier({ dryRun }); }
    else if (W.prepared) log('review', `${W.prepared} applications ready for your review`);
  });
  return true;
}
// Stop the current search at the next safe point (used when you ask the chat for something new).
function stopFinder() { if (busy('find')) { config.stopFind = true; workers.find.detail = 'Stopping…'; log('run', 'Search stopped'); } return busy('find'); }
// Stopping the applier finishes the form it's on (never half-submits), then pauses until you approve or retry something.
function stopApplier() { if (busy('apply')) { config.stopApply = true; workers.apply.detail = 'Stopping after this one…'; log('run', 'Applying paused'); } config.applyPaused = true; return true; }
const autoApprove = () => db.prepare(`UPDATE applications SET status='approved' WHERE status='pending_approval' AND COALESCE(match_score, 0) >= ?`).run(config.mode.minScore ?? 0);

// Back-compat names used by the CLI below.
const pipeline = (o) => startFinder(o);
const applyNow = (o) => startApplier(o);

// ---------- Open the dashboard as its own app window ----------
function openAppWindow() {
  const url = `http://localhost:${config.dashboard.port}`;
  const chrome = '/Applications/Google Chrome.app';
  if (fs.existsSync(chrome))
    spawn('open', ['-na', chrome, '--args', `--app=${url}`, `--user-data-dir=${path.join(paths.data, 'app-window')}`, '--window-size=1440,920', '--no-first-run'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
}

switch (cmd) {
  case 'login': await interactiveLogin(); break;
  case 'run': pipeline({ dryRun }); break;
  case 'apply': applyNow({ dryRun }); break;
  case 'test-docs': {
    const sample = { id: 0, title: flags[0] || 'Software Engineer Intern', company: 'Acme Corp',
      description: 'We are looking for an intern to build backend services in Python and React dashboards, working with data pipelines and LLM-powered features. You have strong communication skills and experience with SQL.' };
    const d = await prepareDocuments(sample);
    console.log(d.letterText, '\n\nscore:', d.score, '\n', d.resumePath);
    await closePdfBrowser();
    break;
  }
  case 'serve': default: {
    startServer({
      run: (o) => startFinder(o),
      stopFind: () => stopFinder(),
      apply: () => { startApplier({ manual: true }); return true; },
      stop: (w) => (w === 'apply' ? stopApplier() : stopFinder()),
      status: () => ({ ...workers.find, ...(busy('find') ? {} : busy('apply') ? workers.apply : {}) }),
      // Live counts: anything you approve while it's applying is added to the total right away.
      workers: () => ({ find: { ...workers.find }, apply: busy('apply') ? { ...workers.apply, progress: { ...(workers.apply.progress || {}), done: workers.apply.applied, total: workers.apply.applied + approvedCount() } } : { ...workers.apply } }),
    });
    const safe = (fn, name) => fn().catch((e) => log('error', `${name}: ${e.message}`));
    setInterval(() => safe(dripTick, 'drip'), 60_000);
    setInterval(() => safe(checkInbox, 'inbox'), 15 * 60_000);
    safe(checkInbox, 'inbox');
    // Scheduler: searches on your schedule, and makes sure approved jobs never sit waiting.
    const everyMs = () => { const m = config.mode; const n = Number(m.discoverEvery ?? m.discoverEveryHours ?? 6) || 6; return n * ({ hours: 3600e3, days: 864e5, weeks: 6048e5 }[m.discoverUnit || 'hours'] || 3600e3); };
    const dueAtTime = () => { const t = config.mode.discoverAt; if (!t || (config.mode.discoverUnit || 'hours') === 'hours') return true; const [h, mi] = t.split(':').map(Number); const now = new Date(); return now.getHours() > h || (now.getHours() === h && now.getMinutes() >= (mi || 0)); };
    setInterval(() => {
      const m = config.mode;
      // Applications that stopped at an emailed security code go again as soon as Joblin can read your inbox.
      if (canReadInbox()) {
        const n = db.prepare(`UPDATE applications SET status = 'approved', notes = 'Gmail connected — applying again', updated_at = datetime('now')
          WHERE status = 'needs_review' AND notes LIKE '%security code%'`).run().changes;
        if (n) { db.prepare(`DELETE FROM tasks WHERE done = 0 AND detail LIKE '%security code%'`).run(); log('apply', `${n} application${n === 1 ? '' : 's'} waiting on an emailed code back in the queue`); }
      }
      if (approvedCount()) startApplier();
      if (!config.onboarded || busy('find') || !(m.autoDiscover || m.type === 'autopilot')) return;
      const last = Date.parse(kv.get('lastRunAt', 0)) || 0;
      if (Date.now() - last >= everyMs() && dueAtTime()) startFinder();
    }, 60_000);
    setTimeout(() => startApplier(), 5000); // anything approved before a restart
    // Close Chrome cleanly on shutdown so your LinkedIn sign-in (cookies) is saved.
    for (const sig of ['SIGTERM', 'SIGINT']) process.on(sig, async () => { try { await closeContext(true); await closePdfBrowser(); } finally { process.exit(0); } });
    if (!process.argv.includes('--no-window')) setTimeout(openAppWindow, 600);
  }
}
