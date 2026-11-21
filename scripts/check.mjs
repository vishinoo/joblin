// `npm run check`: syntax-checks every JavaScript file Joblin ships (fast, no network, no data needed).
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const walk = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : /\.m?js$/.test(e.name) ? [path.join(dir, e.name)] : []));
const files = ['start.js', ...['src', 'public', 'tests', 'scripts'].flatMap((d) => walk(path.join(root, d)).map((f) => path.relative(root, f)))];
let bad = 0;
for (const f of files) {
  try { execFileSync(process.execPath, ['--check', path.join(root, f)], { stdio: 'pipe' }); }
  catch (e) { bad++; console.error(`✗ ${f}\n${String(e.stderr || e.message).trim()}\n`); }
}
console.log(bad ? `${bad} of ${files.length} files have syntax errors` : `✓ ${files.length} files OK`);
process.exit(bad ? 1 : 0);
