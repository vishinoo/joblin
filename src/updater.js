// Keeps Joblin up to date from GitHub.
//
// Installed with git: compares your commit with GitHub's main branch, lists what's new,
// and on request runs `git pull`, reinstalls packages if they changed, and restarts itself.
// Installed by install.sh without git: same, but downloads the new version as a tarball (.joblin-version holds the commit).
// Downloaded as a ZIP by hand: compares package.json versions and links to the download instead.
//
// Your own files (config.json, .env, resumes, cover letters, data/) are git-ignored, so updates never touch them.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { ROOT, config, paths } from './config.js';
import { log } from './db.js';

const run = promisify(execFile);
export const REPO = 'vishinoo/joblin';
const BRANCH = 'main';
const CHECK_EVERY_MS = 6 * 3600e3;
const isGit = () => fs.existsSync(path.join(ROOT, '.git'));
const VERSION_FILE = path.join(ROOT, '.joblin-version');
const tarballSha = () => (fs.existsSync(VERSION_FILE) ? fs.readFileSync(VERSION_FILE, 'utf8').trim() : '');
const installKind = () => (isGit() ? 'git' : tarballSha() ? 'tarball' : 'zip');
// npm sits next to node (also for the private Node that install.sh downloads)
const npmCmd = () => { const local = path.join(path.dirname(process.execPath), 'npm'); return fs.existsSync(local) ? local : 'npm'; };
const npmEnv = () => ({ ...process.env, PATH: `${path.dirname(process.execPath)}${path.delimiter}${process.env.PATH || ''}` });
const git = async (...args) => (await run('git', args, { cwd: ROOT, timeout: 120_000 })).stdout.trim();
const localVersion = () => JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;

let state = { checking: false, available: false, updating: false, error: '', checkedAt: null, behind: 0, changes: [], install: installKind(), canUpdate: installKind() !== 'zip', version: localVersion(), commit: '', downloadUrl: `https://github.com/${REPO}/archive/refs/heads/${BRANCH}.zip` };
export const updateStatus = () => ({ ...state, enabled: config.updates?.check !== false });

const gh = async (url) => {
  const r = await fetch(`https://api.github.com/repos/${REPO}/${url}`, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'joblin-updater' }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) { const e = new Error(`GitHub said ${r.status}`); e.status = r.status; throw e; }
  return r.json();
};
const newer = (a, b) => { const x = a.split('.').map(Number), y = b.split('.').map(Number); for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0); return false; };

export async function checkForUpdate() {
  if (state.checking || state.updating) return updateStatus();
  state.checking = true; state.error = '';
  try {
    if (installKind() !== 'zip') {
      state.commit = isGit() ? await git('rev-parse', 'HEAD') : tarballSha();
      try {
        const cmp = await gh(`compare/${state.commit}...${BRANCH}`);
        state.behind = cmp.ahead_by || 0;
        state.changes = (cmp.commits || []).slice(-8).reverse().map((c) => c.commit.message.split('\n')[0]);
      } catch (e) {
        if (e.status !== 404) throw e;
        state.behind = 0; state.changes = []; // your commit isn't on GitHub (local edits): nothing to compare
      }
      state.available = state.behind > 0;
    } else {
      const pkg = await gh(`contents/package.json?ref=${BRANCH}`);
      const latest = JSON.parse(Buffer.from(pkg.content, 'base64').toString('utf8')).version;
      state.available = newer(latest, localVersion());
      state.changes = state.available ? [`Version ${latest} is out (you have ${localVersion()})`] : [];
    }
    state.checkedAt = new Date().toISOString();
  } catch (e) { state.error = e.message; }
  finally { state.checking = false; }
  return updateStatus();
}

// Pull (or download) the new version, reinstall packages if needed, then restart into it.
export async function applyUpdate() {
  const kind = installKind();
  if (kind === 'zip') throw new Error('This copy was downloaded by hand. Download the new version from GitHub, or reinstall with the one-line installer to get one-click updates.');
  if (state.updating) return;
  state.updating = true; state.error = '';
  try {
    let changed = '', from = '', to = '';
    if (kind === 'git') {
      from = await git('rev-parse', 'HEAD');
      await git('pull', '--ff-only', '--autostash', 'origin', BRANCH);
      to = await git('rev-parse', 'HEAD');
      changed = await git('diff', '--name-only', from, 'HEAD');
    } else {
      from = tarballSha();
      to = (await gh(`commits/${BRANCH}`)).sha;
      const r = await fetch(`https://codeload.github.com/${REPO}/tar.gz/${to}`, { signal: AbortSignal.timeout(300_000) });
      if (!r.ok) throw new Error(`Download failed (${r.status})`);
      const tmp = path.join(paths.data, 'update.tar.gz');
      fs.writeFileSync(tmp, Buffer.from(await r.arrayBuffer()));
      // Only files that are in the repo get replaced; your own files aren't in the download.
      await run('tar', ['-xzf', tmp, '-C', ROOT, '--strip-components=1'], { timeout: 120_000 });
      fs.rmSync(tmp, { force: true });
      fs.writeFileSync(VERSION_FILE, to + '\n');
      changed = 'package.json';
    }
    if (/^package(-lock)?\.json$/m.test(changed)) await run(npmCmd(), ['install', '--no-audit', '--no-fund'], { cwd: ROOT, env: npmEnv(), timeout: 600_000 });
    log('run', `Updated Joblin (${from.slice(0, 7)} → ${to.slice(0, 7)}), restarting`);
    restart();
  } catch (e) {
    state.updating = false;
    state.error = /not possible to fast-forward|diverg/i.test(e.message) ? 'Your copy has its own changes, so it can’t update automatically. Run "git pull" in the Joblin folder.' : e.message.split('\n')[0];
    throw new Error(state.error);
  }
}

// Start a fresh Joblin once this one has let go of the port; the open app window reconnects by itself.
function restart() {
  const out = fs.openSync(path.join(paths.data, 'server.log'), 'a');
  const args = [...process.argv.slice(1).filter((a) => a !== '--no-window'), '--no-window'];
  spawn('/bin/sh', ['-c', `sleep 2; exec "${process.execPath}" ${args.map((a) => `"${a}"`).join(' ')}`], { cwd: ROOT, detached: true, stdio: ['ignore', out, out] }).unref();
  setTimeout(() => process.exit(0), 300);
}

export function updateRoutes(app) {
  app.get('/api/update', (_req, res) => res.json(updateStatus()));
  app.post('/api/update/check', async (_req, res) => res.json(await checkForUpdate()));
  app.post('/api/update', async (_req, res) => {
    try { res.json({ ok: true }); await applyUpdate(); } catch (e) { log('error', `update: ${e.message}`); }
  });
  if (config.updates?.check !== false) {
    setTimeout(() => checkForUpdate().catch(() => {}), 10_000);
    setInterval(() => { if (config.updates?.check !== false) checkForUpdate().catch(() => {}); }, CHECK_EVERY_MS).unref();
  }
}
