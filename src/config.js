import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONFIG_PATH = path.join(ROOT, 'config.json');
const ENV_PATH = path.join(ROOT, '.env');

// Minimal .env loader (GMAIL_USER, GMAIL_APP_PASSWORD, ...)
function readEnv() {
  const out = {};
  if (fs.existsSync(ENV_PATH))
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
      if (m) out[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  return out;
}
for (const [k, v] of Object.entries(readEnv())) if (!process.env[k]) process.env[k] = v;

// Secrets live in .env (never in config.json, never sent to the browser).
export function saveEnv(patch) {
  const env = { ...readEnv(), ...patch };
  for (const [k, v] of Object.entries(patch)) { if (v == null || v === '') { delete env[k]; delete process.env[k]; } else process.env[k] = v; }
  fs.writeFileSync(ENV_PATH, Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\n') + '\n', { mode: 0o600 });
}

// First run on a fresh clone: start from the example config and placeholder resumes.
if (!fs.existsSync(CONFIG_PATH)) fs.copyFileSync(path.join(ROOT, 'config.example.json'), CONFIG_PATH);
for (const t of ['swe', 'finance']) {
  const own = path.join(ROOT, 'resumes', `${t}.json`);
  if (!fs.existsSync(own)) fs.copyFileSync(path.join(ROOT, 'resumes', 'examples', `${t}.json`), own);
  const letter = path.join(ROOT, 'templates', `cover-${t}.txt`);
  if (!fs.existsSync(letter)) fs.copyFileSync(path.join(ROOT, 'templates', 'examples', `cover-${t}.txt`), letter);
}

// `config` is a single shared object: saveConfig mutates it in place so every module sees updates live.
export const config = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

// After an update, settings added to config.example.json get their defaults; your own values are never changed.
function addMissing(target, defaults) {
  let added = false;
  for (const [k, v] of Object.entries(defaults)) {
    if (!(k in target)) { target[k] = structuredClone(v); added = true; }
    else if (isObj(v) && isObj(target[k])) added = addMissing(target[k], v) || added;
  }
  return added;
}
try {
  if (addMissing(config, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.example.json'), 'utf8'))))
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
} catch {}
function merge(target, patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (isObj(v) && isObj(target[k])) merge(target[k], v);
    else target[k] = v;
  }
}
export function saveConfig(patch) {
  merge(config, patch);
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + '\n');
  return config;
}

export const paths = {
  data: path.join(ROOT, 'data'),
  output: path.join(ROOT, 'data', 'output'),
  uploads: path.join(ROOT, 'data', 'uploads'),
  browser: path.join(ROOT, 'data', 'browser-profile'),
  resumes: path.join(ROOT, 'resumes'),
  templates: path.join(ROOT, 'templates'),
};
fs.mkdirSync(paths.output, { recursive: true });
fs.mkdirSync(paths.uploads, { recursive: true });

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const jitter = (min, max) => sleep(min + Math.random() * (max - min));
export const slug = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);
