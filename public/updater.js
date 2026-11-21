// "New Joblin available" card in the sidebar. Talks to src/updater.js.
const css = `
.upd { margin: 12px 0 0; padding: 14px; border: 1px solid var(--line); border-radius: 12px; background: var(--raised); font-size: 13px; line-height: 1.4; }
.upd-top { display: flex; align-items: center; gap: 10px; margin-bottom: 10px; }
.upd-top img { width: 34px; height: auto; flex: none; }
.upd-t { font-weight: 600; font-size: 13.5px; color: var(--ink); }
.upd-s { font-size: 12px; color: var(--muted); }
.upd ul { list-style: none; margin: 0 0 12px; padding: 0; }
.upd li { position: relative; padding-left: 13px; margin-top: 5px; font-size: 12.5px; color: var(--ink-2); overflow-wrap: anywhere; }
.upd li::before { content: ""; position: absolute; left: 0; top: 6px; width: 5px; height: 5px; border-radius: 50%; background: var(--accent); }
.upd .upd-go { width: 100%; justify-content: center; }
.upd .upd-later { display: block; margin: 8px auto 0; padding: 2px 6px; background: none; border: 0; color: var(--muted); font-size: 12px; cursor: pointer; }
.upd .upd-later:hover { color: var(--ink); }
.upd .err { color: var(--bad, #e5614b); font-size: 12px; margin: 0 0 10px; }
.upd .spin { width: 14px; height: 14px; border: 2px solid var(--line); border-top-color: var(--accent); border-radius: 50%; animation: updspin .8s linear infinite; flex: none; }
@keyframes updspin { to { transform: rotate(360deg); } }
`;
document.head.append(Object.assign(document.createElement('style'), { textContent: css }));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const card = Object.assign(document.createElement('div'), { className: 'upd', hidden: true });
document.querySelector('.side')?.insertBefore(card, document.getElementById('sideFoot'));
let dismissed = '';
try { dismissed = localStorage.getItem('joblin-upd-dismissed') || ''; } catch {}

const api = async (url, opts) => (await fetch(url, opts)).json();

const head = (title, sub) => `<div class="upd-top"><img src="/img/joblin-logo-64.png" alt=""><div><div class="upd-t">${title}</div>${sub ? `<div class="upd-s">${sub}</div>` : ''}</div></div>`;

function draw(s) {
  const key = String(s.behind || s.changes?.join('|'));
  if (s.updating) { card.hidden = false; card.innerHTML = `<div class="upd-top"><div class="spin"></div><div><div class="upd-t">Updating Joblin…</div><div class="upd-s">This page reloads by itself.</div></div></div>`; return; }
  if (!s.enabled || !s.available || dismissed === key) { card.hidden = true; return; }
  card.hidden = false;
  const changes = s.changes || [];
  const list = changes.slice(0, 3).map((c) => `<li>${esc(c)}</li>`).join('') + (changes.length > 3 ? `<li>and ${changes.length - 3} more</li>` : '');
  const sub = s.behind ? `${s.behind} improvement${s.behind > 1 ? 's' : ''} waiting` : 'A new version is out';
  const action = s.canUpdate !== false
    ? '<button class="btn primary sm upd-go" data-go>Update now</button>'
    : `<a class="btn primary sm upd-go" href="${esc(s.downloadUrl)}" target="_blank" rel="noopener">Download update</a>`;
  card.innerHTML = `${head('Update available', sub)}${list ? `<ul>${list}</ul>` : ''}${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}${action}<button class="upd-later" data-later>Not now</button>`;
  card.querySelector('[data-later]').onclick = () => { dismissed = key; try { localStorage.setItem('joblin-upd-dismissed', key); } catch {} card.hidden = true; };
  card.querySelector('[data-go]')?.addEventListener('click', update);
}

async function update() {
  draw({ updating: true });
  await fetch('/api/update', { method: 'POST' }).catch(() => {});
  // Wait for the old server to go away and the new one to come up, then reload.
  const start = Date.now();
  let wentDown = false;
  const tick = async () => {
    try {
      const s = await api('/api/update');
      if (!s.updating && s.error) return draw(s);      // update failed, old server still running
      if (wentDown) return location.reload();          // new server is up
    } catch { wentDown = true; }
    if (Date.now() - start < 180_000) setTimeout(tick, 1500);
    else location.reload();
  };
  setTimeout(tick, 1500);
}

const refresh = () => api('/api/update').then(draw).catch(() => {});
refresh();
setInterval(refresh, 30 * 60_000);
