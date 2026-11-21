// "New Joblin available" card in the sidebar. Talks to src/updater.js.
const css = `
.upd { margin: 10px 4px 0; padding: 12px; border: 1px solid var(--accent); border-radius: 10px; background: var(--accent-soft); font-size: 13px; line-height: 1.45; }
.upd b { display: block; margin-bottom: 4px; }
.upd ul { margin: 6px 0 10px; padding-left: 18px; color: var(--muted); max-height: 120px; overflow: auto; }
.upd .row { display: flex; gap: 6px; }
.upd button, .upd a.btn { flex: 1; text-align: center; text-decoration: none; }
.upd .err { color: #ff8a8a; margin: 6px 0; }
`;
document.head.append(Object.assign(document.createElement('style'), { textContent: css }));

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
const card = Object.assign(document.createElement('div'), { className: 'upd', hidden: true });
document.querySelector('.side')?.insertBefore(card, document.getElementById('sideFoot'));
let dismissed = '';
try { dismissed = localStorage.getItem('joblin-upd-dismissed') || ''; } catch {}

const api = async (url, opts) => (await fetch(url, opts)).json();

function draw(s) {
  const key = String(s.behind || s.changes?.join('|'));
  if (s.updating) { card.hidden = false; card.innerHTML = '<b>Updating Joblin…</b>Grabbing the new version and restarting. This page reloads by itself.'; return; }
  if (!s.enabled || !s.available || dismissed === key) { card.hidden = true; return; }
  card.hidden = false;
  const list = (s.changes || []).map((c) => `<li>${esc(c)}</li>`).join('');
  const action = s.install === 'git'
    ? '<button class="btn primary" data-go>Update &amp; restart</button>'
    : `<a class="btn primary" href="${esc(s.downloadUrl)}" target="_blank" rel="noopener">Download</a>`;
  card.innerHTML = `<b>Joblin learned new tricks</b>${s.behind ? `${s.behind} update${s.behind > 1 ? 's' : ''} on GitHub:` : ''}<ul>${list}</ul>
    ${s.error ? `<div class="err">${esc(s.error)}</div>` : ''}<div class="row">${action}<button class="btn" data-later>Later</button></div>`;
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
