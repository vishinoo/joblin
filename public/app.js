// Joblin dashboard — no build step. Hash routes: dashboard, review, applications, outreach, tasks, settings.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function api(path, { method = 'GET', body, raw, headers } = {}) {
  const r = await fetch('/api' + path, { method, headers: raw ? headers : { 'content-type': 'application/json' }, body: raw || (body !== undefined ? JSON.stringify(body) : undefined) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || `Request failed (${r.status})`);
  return j;
}
function toast(msg, err = false) {
  const t = $('#toast'); t.textContent = msg; t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toast.t); toast.t = setTimeout(() => (t.className = 'toast'), 3200);
}
const when = (t) => {
  if (!t) return '';
  const d = new Date(String(t).includes('T') ? t : t.replace(' ', 'T') + 'Z'); const s = (Date.now() - d) / 1000;
  if (s < 0) return `in ${-s < 86400 ? Math.max(1, Math.round(-s / 3600)) + 'h' : Math.round(-s / 86400) + 'd'}`;
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
};
const STATUS = {
  queued: ['Queued', ''], pending_approval: ['Needs your OK', 'accent'], approved: ['Approved', 'accent'], skipped: ['Skipped', ''],
  prepared: ['Filled (dry run)', ''], submitted: ['Applied', 'accent'], needs_review: ['Needs a hand', 'warn'], manual: ['Apply yourself', 'warn'],
  failed: ['Failed', 'bad'], interview: ['Interview', 'good'], offer: ['Offer', 'good'], rejected: ['Rejected', 'bad'], withdrawn: ['Withdrawn', ''],
  scheduled: ['Scheduled', ''], sent: ['Sent', 'accent'], replied: ['Replied', 'good'], bounced: ['Bounced', 'bad'], cancelled: ['Cancelled', ''],
};
const pill = (s) => { const [l, c] = STATUS[s] || [s, '']; return `<span class="pill ${c}">${esc(l)}</span>`; };
const scoreBadge = (n) => (n == null ? '' : `<span class="score ${n >= 70 ? 'hi' : n >= 45 ? 'mid' : 'lo'}" title="Fit score">${n}</span>`);
const fileUrl = (p, bust) => `/api/file?p=${encodeURIComponent(p)}${bust ? `&v=${bust}` : ''}`;
// Company monogram: initials on a color picked from the company name (calm blues/teals/violets).
const MONO = ['#3a63d6', '#2f8f9d', '#6b5bd2', '#3d7f5a', '#b5643c', '#8a4fa8', '#2d6fa3', '#a3485a', '#4b7d2e', '#5c6470'];
function mono(name, size = '') {
  const n = String(name || '?').replace(/[^A-Za-z0-9 &]/g, ' ').trim();
  const parts = n.split(/\s+/).filter((w) => !/^(inc|llc|ltd|the|co|corp|&)$/i.test(w));
  const ini = (parts.length > 1 ? parts[0][0] + parts[1][0] : (parts[0] || '?').slice(0, 2)).toUpperCase();
  let h = 0; for (const c of n) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `<span class="mono ${size}" style="background:${MONO[h % MONO.length]}" aria-hidden="true">${esc(ini)}</span>`;
}

// ---------- Dialog: replaces the browser's confirm() ----------
// ask({ title, body, ok, cancel, danger, image, items }) → Promise<boolean>
function ask({ title, body = '', ok = 'Continue', cancel = 'Cancel', danger = false, image = '', items = [] }) {
  return new Promise((resolve) => {
    const back = document.createElement('div');
    back.className = 'modal-back';
    back.innerHTML = `<div class="modal" role="dialog" aria-modal="true" aria-labelledby="mTitle">
      <div class="mh">${image ? `<img src="${image}" alt="">` : ''}<h3 id="mTitle">${esc(title)}</h3></div>
      <div class="mb">${body}${items.length ? `<div class="list">${items.join('')}</div>` : ''}</div>
      <div class="mf"><button class="btn ghost" data-no>${esc(cancel)}</button><button class="btn ${danger ? 'danger-solid' : 'primary'}" data-yes>${esc(ok)}</button></div></div>`;
    const prev = document.activeElement;
    const close = (v) => { back.remove(); document.removeEventListener('keydown', key, true); prev?.focus?.(); resolve(v); };
    const key = (e) => { if (e.key === 'Escape') { e.preventDefault(); close(false); } if (e.key === 'Enter' && !/TEXTAREA/.test(document.activeElement?.tagName)) { e.preventDefault(); close(true); } };
    back.addEventListener('mousedown', (e) => { if (e.target === back) close(false); });
    $('[data-no]', back).onclick = () => close(false);
    $('[data-yes]', back).onclick = () => close(true);
    document.addEventListener('keydown', key, true);
    document.body.appendChild(back);
    $('[data-yes]', back).focus();
  });
}

// ---------- Dropdown: styles every <select> in the app; the native select keeps the value ----------
const CHEVRON = '<svg viewBox="0 0 20 20"><path d="M5 8l5 5 5-5"/></svg>';
const CHECK = '<svg class="ck" viewBox="0 0 20 20"><path d="M4.5 10.5l3.5 3.5 7.5-8"/></svg>';
let openDD = null;
function closeDD() { if (!openDD) return; openDD.wrap.classList.remove('open'); openDD.menu.remove(); openDD.btn.setAttribute('aria-expanded', 'false'); openDD = null; }
document.addEventListener('mousedown', (e) => { if (openDD && !openDD.wrap.contains(e.target)) closeDD(); });
window.addEventListener('hashchange', closeDD);

function enhanceSelect(sel) {
  if (sel.dataset.dd || sel.multiple) return;
  sel.dataset.dd = '1';
  const wrap = document.createElement('div');
  wrap.className = 'dd' + (/width:\s*auto/.test(sel.getAttribute('style') || '') || sel.classList.contains('status') ? ' inline' : '');
  sel.parentNode.insertBefore(wrap, sel);
  wrap.appendChild(sel);
  sel.classList.add('dd-native');
  sel.tabIndex = -1;
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'dd-btn' + (sel.classList.contains('status') ? ' sm' : '');
  btn.setAttribute('aria-haspopup', 'listbox');
  btn.setAttribute('aria-expanded', 'false');
  const lab = sel.getAttribute('aria-label') || sel.closest('label')?.childNodes[0]?.textContent?.trim();
  if (lab) btn.setAttribute('aria-label', lab);
  wrap.appendChild(btn);
  const paint = () => { btn.innerHTML = `<span>${esc(sel.options[sel.selectedIndex]?.text || 'Choose…')}</span>${CHEVRON}`; };
  paint();
  sel.addEventListener('change', paint);
  const choose = (i) => {
    if (sel.selectedIndex !== i) { sel.selectedIndex = i; sel.dispatchEvent(new Event('input', { bubbles: true })); sel.dispatchEvent(new Event('change', { bubbles: true })); }
    paint(); closeDD(); btn.focus();
  };
  const open = () => {
    if (openDD?.sel === sel) return closeDD();
    closeDD();
    const menu = document.createElement('div');
    menu.className = 'dd-menu';
    menu.setAttribute('role', 'listbox');
    [...sel.options].forEach((o, i) => {
      const d = document.createElement('div');
      d.className = 'dd-opt' + (i === sel.selectedIndex ? ' sel active' : '');
      d.setAttribute('role', 'option');
      d.setAttribute('aria-selected', String(i === sel.selectedIndex));
      d.innerHTML = `${CHECK}<span>${esc(o.text)}</span>`;
      d.onmousedown = (e) => { e.preventDefault(); choose(i); };
      menu.appendChild(d);
    });
    wrap.appendChild(menu);
    const r = btn.getBoundingClientRect();
    if (r.bottom + Math.min(290, menu.scrollHeight) + 12 > window.innerHeight && r.top > 300) menu.classList.add('up');
    menu.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    wrap.classList.add('open');
    btn.setAttribute('aria-expanded', 'true');
    openDD = { wrap, menu, btn, sel, active: sel.selectedIndex };
  };
  btn.onclick = open;
  btn.onkeydown = (e) => {
    if (!openDD || openDD.sel !== sel) { if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) { e.preventDefault(); open(); } return; }
    const opts = $$('.dd-opt', openDD.menu);
    if (e.key === 'Escape') { e.preventDefault(); closeDD(); return; }
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(openDD.active); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      openDD.active = Math.max(0, Math.min(opts.length - 1, openDD.active + (e.key === 'ArrowDown' ? 1 : -1)));
      opts.forEach((o, i) => o.classList.toggle('active', i === openDD.active));
      opts[openDD.active]?.scrollIntoView({ block: 'nearest' });
    }
  };
}
const enhanceAll = (root = document) => $$('select', root).forEach(enhanceSelect);
new MutationObserver((muts) => { for (const m of muts) for (const n of m.addedNodes) if (n.nodeType === 1) (n.tagName === 'SELECT' ? enhanceSelect(n) : enhanceAll(n)); })
  .observe(document.body, { childList: true, subtree: true });

let S = {}; // summary
let SET = null; // settings
const state = { review: { items: [], sel: new Set(), active: null, filter: 'all' }, apps: { q: '', status: '', track: '' }, emailFilter: '', settingsTab: 'integrations' };

// ---------- Shell ----------
const TITLES = { dashboard: 'Dashboard', review: 'Review batch', applications: 'Applications', outreach: 'Outreach', tasks: 'Tasks', answers: 'Questions', memory: 'Memory', settings: 'Settings' };
const route = () => (location.hash.replace('#/', '') || 'dashboard').split('?')[0];

async function refreshSummary() {
  S = await api('/summary');
  const sys = S.system;
  $('#reviewBadge').hidden = !S.pendingReview; $('#reviewBadge').textContent = S.pendingReview;
  $('#taskBadge').hidden = !S.openTasks; $('#taskBadge').textContent = S.openTasks;
  $('#qBadge').hidden = !S.pendingAnswers; $('#qBadge').textContent = S.pendingAnswers;
  $('#sideFoot').innerHTML = `
    <div class="conn"><span class="dot ${sys.linkedin?.connected ? 'ok' : ''}"></span>LinkedIn ${sys.linkedin?.connected ? 'connected' : 'not connected'}</div>
    <div class="conn"><span class="dot ${sys.gmail ? 'ok' : ''}"></span>Gmail ${sys.gmail ? 'connected' : 'not connected'}</div>
    <div class="conn"><span class="dot ${sys.llm ? 'ok' : 'bad'}"></span>${sys.llmProvider === 'ollama' ? 'Local model' : esc(sys.llmModel)} ${sys.llm ? 'ready' : 'not ready'}</div>
    <div class="conn"><span class="dot ${sys.mode.type === 'autopilot' ? 'ok' : ''}"></span>${sys.mode.type === 'autopilot' ? 'Autopilot on' : 'Review mode'}</div>`;
  const w = sys.worker;
  const pr = w?.progress;
  $('#worker').innerHTML = w?.state ? `<span class="spin"></span>${esc(w.detail || 'Working')}${pr?.total ? ` · ${pr.done}/${pr.total}` : ''}` : '';
  $('#worker').style.cursor = w?.state ? 'pointer' : '';
  let sf = $('#showForm');
  if (sys.formWaiting && !sf) {
    sf = document.createElement('button'); sf.id = 'showForm'; sf.className = 'btn';
    sf.textContent = 'Show the form'; sf.title = 'A filled application is waiting for you in Joblin’s hidden Chrome window';
    sf.onclick = () => api('/browser/show', { method: 'POST', body: {} });
    $('#runBtn').before(sf);
  } else if (!sys.formWaiting && sf) sf.remove();
  $('#worker').onclick = () => w?.state && (location.hash = '#/review');
  $('#runBtn').disabled = Boolean(w?.state);
  if (!sys.onboarded && $('#onboarding').hidden) openOnboarding();
}

async function render() {
  const r = route();
  $$('#nav a').forEach((a) => a.classList.toggle('on', a.dataset.route === r));
  $('#pageTitle').textContent = TITLES[r] || 'Dashboard';
  const view = $('#view');
  try { await (VIEWS[r] || VIEWS.dashboard)(view); } catch (e) { view.innerHTML = `<div class="panel empty"><b>Couldn't load this page</b>${esc(e.message)}</div>`; }
}
window.addEventListener('hashchange', render);
$('#runBtn').onclick = async () => {
  const { started } = await api('/run', { method: 'POST', body: {} });
  toast(started ? (S.system.mode.type === 'autopilot' ? 'Joblin is finding and applying to jobs' : 'Joblin is finding jobs — watch progress here') : 'Joblin is already working');
  await refreshSummary(); location.hash = '#/review'; render();
};

// ---------- Charts ----------
function smoothPath(pts) {
  if (pts.length < 2) return '';
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6], c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += ` C${c1[0]},${c1[1]} ${c2[0]},${c2[1]} ${p2[0]},${p2[1]}`;
  }
  return d;
}
const dayKey = (d) => d.toLocaleDateString('en-CA');

function areaChart(el, days) {
  const keys = [...Array(days)].map((_, i) => dayKey(new Date(Date.now() - (days - 1 - i) * 864e5)));
  const a = Object.fromEntries(S.daily.map((r) => [r.d, r.n])), e = Object.fromEntries(S.dailyEmails.map((r) => [r.d, r.n]));
  const sa = keys.map((k) => a[k] || 0), se = keys.map((k) => e[k] || 0);
  const W = 700, H = 200, P = 22, max = Math.max(4, ...sa, ...se) * 1.15;
  const x = (i) => P + (i * (W - 2 * P)) / (days - 1), y = (v) => H - 18 - (v / max) * (H - 36);
  const pa = sa.map((v, i) => [x(i), y(v)]), pe = se.map((v, i) => [x(i), y(v)]);
  const area = (pts) => `${smoothPath(pts)} L${pts.at(-1)[0]},${H - 18} L${pts[0][0]},${H - 18} Z`;
  const ticks = keys.map((k, i) => [k, i]).filter((_, i) => i % Math.ceil(days / 6) === 0 || i === days - 1);
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Applications and emails per day">
    <defs><linearGradient id="ga" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#4c7dff" stop-opacity=".45"/><stop offset="1" stop-color="#4c7dff" stop-opacity="0"/></linearGradient>
    <linearGradient id="ge" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stop-color="#b9bac0" stop-opacity=".18"/><stop offset="1" stop-color="#b9bac0" stop-opacity="0"/></linearGradient></defs>
    <g class="grid">${[0.25, 0.5, 0.75].map((f) => `<line x1="${P}" x2="${W - P}" y1="${y(max * f)}" y2="${y(max * f)}"/>`).join('')}</g>
    <path d="${area(pe)}" fill="url(#ge)" stroke="none"/><path d="${smoothPath(pe)}" stroke="#8b8d96" stroke-width="1.5"/>
    <path d="${area(pa)}" fill="url(#ga)" stroke="none"/><path d="${smoothPath(pa)}" stroke="#4c7dff" stroke-width="2"/>
    <g class="axis">${ticks.map(([k, i]) => `<text x="${x(i)}" y="${H}" text-anchor="middle">${new Date(k + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}</text>`).join('')}</g>
    <line id="hoverLine" y1="8" y2="${H - 18}" stroke="#ecebe8" stroke-opacity=".35" visibility="hidden"/>
  </svg><div class="tip" hidden></div>`;
  const svg = $('svg', el), tip = $('.tip', el), line = $('#hoverLine', el);
  svg.addEventListener('mousemove', (ev) => {
    const b = svg.getBoundingClientRect(); const rx = ((ev.clientX - b.left) / b.width) * W;
    const i = Math.max(0, Math.min(days - 1, Math.round(((rx - P) / (W - 2 * P)) * (days - 1))));
    line.setAttribute('x1', x(i)); line.setAttribute('x2', x(i)); line.setAttribute('visibility', 'visible');
    tip.hidden = false; tip.style.left = `${(x(i) / W) * b.width + 20}px`; tip.style.top = `${(Math.min(pa[i][1], pe[i][1]) / H) * 210 + 10}px`;
    tip.innerHTML = `${new Date(keys[i] + 'T12:00').toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}<br><span style="color:#9dbaff">${sa[i]} applied</span> · ${se[i]} emails`;
  });
  svg.addEventListener('mouseleave', () => { tip.hidden = true; line.setAttribute('visibility', 'hidden'); });
}

// Hex activity map: 16 weeks × 7 days, the dashboard's signature element.
function hexMap(el) {
  const weeks = 16, r = 13, w = Math.sqrt(3) * r, h = 1.5 * r;
  const cal = Object.fromEntries((S.calendar || []).map((c) => [c.d, c.n]));
  const max = Math.max(1, ...Object.values(cal));
  const today = new Date(); const start = new Date(today); start.setDate(today.getDate() - today.getDay() - (weeks - 1) * 7);
  const ramp = ['var(--h0)', 'var(--h1)', 'var(--h2)', 'var(--h3)', 'var(--h4)', 'var(--h5)'];
  let cells = '';
  for (let wk = 0; wk < weeks; wk++) for (let dow = 0; dow < 7; dow++) {
    const d = new Date(start); d.setDate(start.getDate() + wk * 7 + dow);
    if (d > today) continue;
    const n = cal[dayKey(d)] || 0, lvl = n ? Math.min(5, 1 + Math.floor((n / max) * 4.99)) : 0;
    const cx = r + 4 + wk * w + (dow % 2 ? w / 2 : 0), cy = r + 4 + dow * h;
    const pts = [...Array(6)].map((_, k) => { const a = (Math.PI / 3) * k + Math.PI / 6; return `${(cx + r * Math.cos(a)).toFixed(1)},${(cy + r * Math.sin(a)).toFixed(1)}`; }).join(' ');
    cells += `<polygon points="${pts}" style="fill:${ramp[lvl]}" data-d="${dayKey(d)}" data-n="${n}"/>`;
  }
  const W = r * 2 + 8 + weeks * w + w / 2, H = r * 2 + 8 + 6 * h;
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Daily activity over the last 16 weeks">${cells}</svg><div class="tip" hidden></div>`;
  const tip = $('.tip', el);
  $('svg', el).addEventListener('mouseover', (ev) => {
    const p = ev.target.closest('polygon'); if (!p) return;
    const b = el.getBoundingClientRect(), pb = p.getBoundingClientRect();
    tip.hidden = false; tip.style.left = `${pb.left - b.left + pb.width / 2}px`; tip.style.top = `${pb.top - b.top}px`;
    tip.textContent = `${new Date(p.dataset.d + 'T12:00').toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })} · ${p.dataset.n} actions`;
  });
  el.addEventListener('mouseleave', () => (tip.hidden = true));
}

// ---------- Views ----------
const VIEWS = {};

VIEWS.dashboard = async (view) => {
  const [tasks, events] = await Promise.all([api('/tasks'), api('/events')]);
  const b = S.byStatus || {}, e = S.emails;
  const rate = e.sent ? Math.round((e.replied / e.sent) * 100) : 0;
  const funnel = [['Found', S.jobs], ['Prepared', S.jobs - (b.queued || 0)], ['Applied', S.submitted], ['Replies', e.replied], ['Interviews', (b.interview || 0) + (b.offer || 0)]];
  const fmax = Math.max(1, ...funnel.map((f) => f[1]));
  view.innerHTML = `
  <div class="kpis">
    <div class="panel kpi"><div class="k">Applications sent</div><div class="v">${S.submitted}</div><div class="s">${(b.manual || 0) + (b.needs_review || 0)} waiting on you to finish</div></div>
    <div class="panel kpi"><div class="k">Needs your OK <a class="link" href="#/review">Review</a></div><div class="v">${S.pendingReview}</div><div class="s">Average fit score ${S.avgScore || '—'}</div></div>
    <div class="panel kpi"><div class="k">Reply rate</div><div class="v">${rate}<small>%</small></div><div class="s">${e.replied} replies from ${e.sent} emails</div></div>
    <div class="panel kpi"><div class="k">Interviews</div><div class="v">${b.interview || 0}</div><div class="s">${b.offer || 0} offers · ${b.rejected || 0} rejections</div></div>
  </div>
  <div class="dash">
    <div class="col">
      <section class="panel">
        <div class="panel-h"><h2>Activity</h2><span class="sub">Jobs found, applications and emails, last 16 weeks</span>
          <div class="right legend">Less <i style="background:var(--h0)"></i><i style="background:var(--h1)"></i><i style="background:var(--h2)"></i><i style="background:var(--h3)"></i><i style="background:var(--h4)"></i><i style="background:var(--h5)"></i> More</div></div>
        <div class="hexwrap" id="hex"></div>
      </section>
      <section class="panel">
        <div class="panel-h"><h2>Per day</h2><span class="sub"><span style="color:#9dbaff">Applied</span> and emails sent</span>
          <div class="right"><div class="seg" id="range"><button data-d="7">7 days</button><button data-d="30" class="on">30 days</button></div></div></div>
        <div class="chart" id="area"></div>
      </section>
    </div>
    <div class="col">
      <section class="panel"><div class="panel-h"><h2>Pipeline</h2></div>
        <div class="panel-b funnel">${funnel.map(([l, n]) => `<div class="row"><span>${l}</span><div class="bar"><i style="width:${(n / fmax) * 100}%"></i></div><span class="n">${n}</span></div>`).join('')}</div></section>
      <section class="panel"><div class="panel-h"><h2>Needs you</h2><div class="right"><a class="link" href="#/tasks">All tasks</a></div></div>
        <div class="list" style="margin-top:8px">${tasks.filter((t) => !t.done).slice(0, 6).map(taskRow).join('') || '<div class="empty">Nothing needs you right now.</div>'}</div></section>
      <section class="panel"><div class="panel-h"><h2>Recent activity</h2></div>
        <div style="margin-top:8px;max-height:260px;overflow:auto">${events.slice(0, 30).map((ev) => `<div class="ev ${ev.type}"><span class="w">${when(ev.created_at)}</span><span>${esc(ev.message)}</span></div>`).join('') || '<div class="empty">Quiet so far.</div>'}</div></section>
    </div>
  </div>`;
  hexMap($('#hex')); areaChart($('#area'), 30);
  $$('#range button').forEach((bt) => bt.onclick = () => { $$('#range button').forEach((x) => x.classList.toggle('on', x === bt)); areaChart($('#area'), +bt.dataset.d); });
  bindTasks(view);
};

const taskRow = (t) => `<div class="li ${t.done ? 'done' : ''}"><span class="prio p${t.priority}"></span><input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''} aria-label="Mark done">
  <div style="min-width:0"><div class="t">${t.url ? `<a class="link" href="${esc(t.url)}" target="_blank" rel="noopener">${esc(t.title)}</a>` : esc(t.title)}</div>${t.detail ? `<div class="d">${esc(t.detail.slice(0, 220))}</div>` : ''}</div></div>`;
function bindTasks(root) {
  $$('[data-task]', root).forEach((c) => c.onchange = async () => { await api(`/tasks/${c.dataset.task}`, { method: 'PATCH', body: { done: c.checked } }); refreshSummary(); render(); });
}

// ---------- Review batch ----------
const PHASES = [['boards', 'Checking company job boards'], ['linkedin', 'Searching LinkedIn'], ['prepare', 'Writing resumes and cover letters'], ['apply', 'Applying']];
function workPanel() {
  const w = S.system.worker; if (!w?.state) return '';
  const order = PHASES.map((p) => p[0]); const cur = order.indexOf(w.phase);
  const show = PHASES.filter(([k]) => k !== 'linkedin' || S.system.linkedin?.connected).filter(([k]) => k !== 'apply' || w.phase === 'apply' || S.system.mode.type === 'autopilot');
  return `<section class="panel work" aria-live="polite"><img src="/img/joblin-working.png" alt="Joblin at his desk, working">
    <div><h2>${w.phase === 'prepare' ? 'Joblin is writing your applications' : w.phase === 'apply' ? 'Joblin is applying' : 'Joblin is looking for jobs'}</h2>
    <div class="muted">${w.found ? `${w.found} new jobs found so far.` : 'This takes a few minutes. You can keep using your Mac.'}</div>
    <div class="phases">${show.map(([k, l]) => { const i = order.indexOf(k); const st = i < cur ? 'done' : i === cur ? 'on' : '';
      const pr = st === 'on' ? w.progress : null;
      return `<div class="phase ${st}"><span class="ic"></span><span>${l}${pr?.current ? ` <span class="meta">· ${esc(pr.current)}</span>` : ''}</span><span class="meta">${pr?.total ? `${pr.done} of ${pr.total}` : ''}</span>
        ${pr?.total ? `<div class="pbar"><i style="width:${Math.round((pr.done / pr.total) * 100)}%"></i></div>` : ''}</div>`; }).join('')}</div></div></section>`;
}

VIEWS.review = async (view) => {
  const R = state.review;
  R.items = await api('/review');
  const running = S.system.worker?.state;
  if (!R.items.length) {
    const sys = S.system;
    view.innerHTML = running ? workPanel() : `<section class="panel hello"><img src="/img/joblin-256.png" alt="Joblin">
      <div><h2>Nothing waiting for review</h2><div class="muted">Each time Joblin runs, it finds new jobs, writes a resume and cover letter for each, and puts them here for you to approve.</div>
      <div class="checks">
        <div><span class="dot ok"></span>Company job boards: ${(SET?.sources?.boards?.list?.length || 'about 75')} companies</div>
        <div><span class="dot ${sys.linkedin?.connected ? 'ok' : ''}"></span>LinkedIn ${sys.linkedin?.connected ? 'connected' : '<a class="link" href="#/settings">not connected</a> — optional, finds more jobs'}</div>
        <div><span class="dot ${sys.llm ? 'ok' : 'bad'}"></span>${sys.llm ? 'Writing model ready' : '<a class="link" href="#/settings">Writing model not ready</a>'}</div>
      </div>
      <button class="btn primary" id="go">Find jobs now</button></div></section>`;
    $('#go')?.addEventListener('click', () => $('#runBtn').click()); return;
  }
  R.items.forEach((i) => { if (!R.seen?.has(i.id)) { (R.seen ??= new Set()).add(i.id); if ((i.match_score ?? 0) >= 45 && !i.easy_apply) R.sel.add(i.id); } });
  if (!R.items.find((i) => i.id === R.active)) R.active = R.items[0].id;
  const auto = (i) => ['greenhouse', 'lever', 'ashby'].includes(i.ats) && !i.easy_apply;
  const shown = R.items.filter((i) => R.filter === 'all' || (R.filter === 'auto' ? auto(i) : R.filter === i.track));
  view.innerHTML = `${running ? workPanel() + '<div style="height:14px"></div>' : ''}
  <div class="toolbar">
    <div class="seg" id="rf">${[['all', 'All'], ['auto', 'Joblin can submit'], ['swe', 'Software'], ['finance', 'Finance']].map(([k, l]) => `<button data-f="${k}" class="${R.filter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <span class="muted">${R.items.length} prepared · sorted by fit</span>
    <div style="margin-left:auto;display:flex;gap:8px"><button class="btn sm ghost" id="selAll">Select all</button><button class="btn sm ghost" id="selNone">Clear</button></div>
  </div>
  <div class="review">
    <div class="panel rlist">${shown.map((i) => `
      <div class="ritem ${i.id === R.active ? 'on' : ''}" data-id="${i.id}">
        <input type="checkbox" data-sel="${i.id}" ${R.sel.has(i.id) ? 'checked' : ''} aria-label="Approve ${esc(i.title)}">
        ${mono(i.company)}
        <div style="min-width:0"><div class="t">${esc(i.title)}</div><div class="c">${esc(i.company)} · ${auto(i) ? 'Joblin submits' : 'You submit'} · ${i.letter_kind === 'precise' ? 'Precise letter' : 'Template letter'}</div></div>
        ${scoreBadge(i.match_score)}
      </div>`).join('')}</div>
    <div class="panel rdetail" id="rdetail"></div>
  </div>
  <div class="decide"><span class="count"><b id="selCount">${R.sel.size}</b> of ${R.items.length} approved</span>
    <span class="muted">Unchecked jobs are skipped. Outreach emails start after each application goes in.</span>
    <div class="right"><button class="btn primary" id="applyBtn">Apply to ${R.sel.size}</button></div></div>`;
  const sync = () => { $('#selCount').textContent = R.sel.size; $('#applyBtn').textContent = `Apply to ${R.sel.size}`; $('#applyBtn').disabled = !R.sel.size; };
  sync();
  $$('#rf button').forEach((b) => b.onclick = () => { R.filter = b.dataset.f; render(); });
  $('#selAll').onclick = () => { shown.forEach((i) => R.sel.add(i.id)); render(); };
  $('#selNone').onclick = () => { R.sel.clear(); render(); };
  $$('[data-sel]').forEach((c) => { c.onclick = (ev) => ev.stopPropagation(); c.onchange = () => { c.checked ? R.sel.add(+c.dataset.sel) : R.sel.delete(+c.dataset.sel); sync(); }; });
  $$('.ritem').forEach((el) => el.onclick = () => { R.active = +el.dataset.id; $$('.ritem').forEach((x) => x.classList.toggle('on', x === el)); renderDetail(); });
  $('#applyBtn').onclick = async () => {
    const approve = [...R.sel], skip = R.items.map((i) => i.id).filter((id) => !R.sel.has(id));
    const chosen = R.items.filter((i) => R.sel.has(i.id));
    if (!(await ask({ title: `Apply to ${approve.length} ${approve.length === 1 ? 'job' : 'jobs'}?`, image: '/img/joblin-working.png', ok: `Apply to ${approve.length}`,
      body: `Joblin will open a Chrome window and fill each application. If a site asks for something only you can answer, it leaves the form open for you.${skip.length ? ` ${skip.length} unchecked ${skip.length === 1 ? 'job is' : 'jobs are'} skipped.` : ''}`,
      items: chosen.slice(0, 12).map((i) => `<div>${mono(i.company)}<span>${esc(i.title)} <span class="muted">· ${esc(i.company)}</span></span></div>`) }))) return;
    const r = await api('/review/decide', { method: 'POST', body: { approve, skip } });
    R.sel.clear(); toast(r.started ? `Applying to ${approve.length} jobs` : 'Approved — applying once the current run finishes');
    refreshSummary(); render();
  };
  renderDetail();

  function renderDetail() {
    const i = R.items.find((x) => x.id === R.active); if (!i) return;
    const m = i.analysis?.matches || [];
    const bust = Date.now();
    $('#rdetail').innerHTML = `
      <div class="rhead"><div class="top-line">${mono(i.company, 'lg')}<div><h2>${esc(i.title)}</h2>
        <div class="muted">${esc(i.company)}${i.location ? ` · ${esc(i.location)}` : ''} · fit ${i.match_score ?? '—'}</div></div></div>
        <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap">
          <a class="btn sm" href="${esc(i.apply_url || i.linkedin_url)}" target="_blank" rel="noopener">Open posting</a>
          <a class="btn sm" href="${fileUrl(i.resume_path, bust)}" target="_blank">Resume PDF</a>
          <button class="btn sm ghost" id="swapTrack">Use ${i.track === 'swe' ? 'finance' : 'software'} resume</button>
        </div></div>
      <div class="rbody">
        ${m.length ? `<div><h3>What they want, and your proof</h3><div class="match">${m.map((x) => `<div>${esc(x.requirement)}</div><div>${esc(x.evidence)}<div class="org">${esc(x.org)}</div></div>`).join('')}</div></div>` : ''}
        <div><h3>Cover letter <span class="pill ${i.letter_kind === 'precise' ? 'accent' : 'plain'}" style="margin-left:6px">${i.letter_kind === 'precise' ? 'Precise' : 'Template'}</span></h3>
          <div class="pdfbar">
            <a class="btn sm" href="${fileUrl(i.cover_letter_path, bust)}" download="${esc((SET?.profile?.firstName || 'Cover') + '_' + (SET?.profile?.lastName || 'Letter'))}_Cover_Letter_${esc(i.company.replace(/\W+/g, '_'))}.pdf">Download PDF</a>
            <button class="btn sm" id="editLetter">Edit text</button>
            ${i.letter_kind === 'precise' ? '<button class="btn sm ghost" id="regen">Write another precise version</button>' : '<button class="btn sm primary" id="precise">Write a precise letter</button>'}
            <span class="muted" style="font-size:12.5px">${i.letter_kind === 'precise' ? 'Written for this posting.' : 'Your template with this company filled in. Precise letters cost a few more model calls.'}</span>
          </div>
          <div id="letterBox"><iframe class="pdfframe" title="Cover letter" src="${fileUrl(i.cover_letter_path, bust)}#toolbar=0&navpanes=0&view=FitH"></iframe></div></div>
        <div><h3>People Joblin will email</h3>${i.contacts.length ? i.contacts.map((c) => `<div style="font-size:13px;margin-bottom:6px">${esc(c.name || c.email)} <span class="muted">${esc(c.email)} · ${c.source === 'guessed' ? 'guessed address' : esc(c.source)}</span></div>`).join('') : '<div class="muted" style="font-size:13px">No contacts found for this posting.</div>'}</div>
      </div>`;
    $('#editLetter').onclick = () => {
      $('#letterBox').innerHTML = `<textarea class="letter" id="letter" style="min-height:560px">${esc(i.cover_letter_text)}</textarea>
        <div style="display:flex;gap:8px;margin-top:8px"><button class="btn sm primary" id="saveLetter">Save and update PDF</button><button class="btn sm ghost" id="cancelEdit">Cancel</button></div>`;
      $('#cancelEdit').onclick = renderDetail;
      $('#saveLetter').onclick = async () => {
        await api(`/applications/${i.id}/letter`, { method: 'PUT', body: { text: $('#letter').value } });
        i.cover_letter_text = $('#letter').value; toast('Cover letter saved'); renderDetail();
      };
    };
    const regen = async (body, label) => {
      $('#letterBox').innerHTML = `<div class="work" style="grid-template-columns:120px 1fr;padding:18px 4px"><img src="/img/joblin-working.png" alt="" style="width:120px"><div><b>${esc(label)}</b><div class="muted">About a minute on the local model.</div></div></div>`;
      try { await api(`/applications/${i.id}/regenerate`, { method: 'POST', body }); toast('Updated'); } catch (e) { toast(e.message, true); }
      render();
    };
    $('#regen')?.addEventListener('click', () => regen({ precise: true }, 'Joblin is writing a new precise letter…'));
    $('#precise')?.addEventListener('click', () => regen({ precise: true }, 'Joblin is writing a precise letter for this posting…'));
    $('#swapTrack').onclick = () => regen({ track: i.track === 'swe' ? 'finance' : 'swe' }, 'Rebuilding with the other resume…');
  }
};

// ---------- Applications ----------
VIEWS.applications = async (view) => {
  const rows = await api('/applications'); const A = state.apps;
  const statuses = [...new Set(rows.map((r) => r.status))];
  view.innerHTML = `
  <div class="toolbar"><input type="search" id="q" placeholder="Search company or role" value="${esc(A.q)}">
    <select id="st"><option value="">Any status</option>${statuses.map((s) => `<option value="${s}" ${A.status === s ? 'selected' : ''}>${STATUS[s]?.[0] || s}</option>`).join('')}</select>
    <select id="tr"><option value="">Both resumes</option><option value="swe" ${A.track === 'swe' ? 'selected' : ''}>Software</option><option value="finance" ${A.track === 'finance' ? 'selected' : ''}>Finance</option></select></div>
  <div class="panel tablewrap"><table><thead><tr><th>Role</th><th>Fit</th><th>Resume</th><th>Status</th><th>Documents</th><th>Updated</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  const draw = () => {
    const f = rows.filter((r) => (!A.q || `${r.company} ${r.title}`.toLowerCase().includes(A.q.toLowerCase())) && (!A.status || r.status === A.status) && (!A.track || r.track === A.track));
    $('#rows').innerHTML = f.map((r) => `<tr>
      <td><div style="display:flex;gap:12px">${mono(r.company)}<div><a class="link" href="${esc(r.apply_url || r.linkedin_url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="sub">${esc(r.company)}${r.location ? ` · ${esc(r.location)}` : ''}</div>${r.notes ? `<div class="sub">${esc(r.notes.slice(0, 160))}</div>` : ''}</div></div></td>
      <td>${scoreBadge(r.match_score)}</td><td class="sub">${r.track === 'swe' ? 'Software' : r.track === 'finance' ? 'Finance' : '—'}</td>
      <td><select class="status" data-id="${r.id}" aria-label="Status">${Object.keys(STATUS).filter((k) => !['scheduled', 'sent', 'replied', 'bounced', 'cancelled'].includes(k)).map((k) => `<option value="${k}" ${k === r.status ? 'selected' : ''}>${STATUS[k][0]}</option>`).join('')}</select></td>
      <td class="sub">${r.resume_path ? `<a class="link" target="_blank" href="${fileUrl(r.resume_path)}">Resume</a> · <a class="link" target="_blank" href="${fileUrl(r.cover_letter_path)}">Letter</a>` : '—'}${r.proof_path ? ` · <a class="link" target="_blank" href="${fileUrl(r.proof_path)}">Confirmation</a>` : ''}
        ${['needs_review', 'failed'].includes(r.status) ? `<div style="margin-top:6px"><button class="btn sm" data-retry="${r.id}">Try again in Chrome</button></div>` : ''}</td>
      <td class="sub">${when(r.updated_at)}</td></tr>`).join('') || `<tr><td colspan="6"><div class="empty"><b>No applications yet</b>Use Find jobs now to start your first batch.</div></td></tr>`;
    $$('[data-retry]').forEach((b) => b.onclick = async () => {
      const r = await api(`/applications/${b.dataset.retry}/retry`, { method: 'POST', body: {} });
      toast(r.started ? 'Joblin is opening it in Chrome' : 'Queued — it runs when the current job finishes'); refreshSummary(); draw();
    });
    $$('select.status').forEach((s) => s.onchange = async () => { await api(`/applications/${s.dataset.id}`, { method: 'PATCH', body: { status: s.value } }); toast('Status updated'); refreshSummary(); });
  };
  $('#q').oninput = (e) => { A.q = e.target.value; draw(); };
  $('#st').onchange = (e) => { A.status = e.target.value; draw(); };
  $('#tr').onchange = (e) => { A.track = e.target.value; draw(); };
  draw();
};

// ---------- Outreach ----------
VIEWS.outreach = async (view) => {
  const rows = await api('/emails'); const sys = S.system; if (!SET) await loadSettings();
  view.innerHTML = `
  <div class="toolbar">
    <div class="seg" id="ef">${[['', 'All'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['replied', 'Replied'], ['bounced', 'Bounced']].map(([k, l]) => `<button data-f="${k}" class="${state.emailFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <span class="muted">${S.emails.today} of ${S.emails.cap} sent today</span>
    <button class="btn sm" id="pause" style="margin-left:auto">${sys.emailPaused ? 'Resume sending' : 'Pause sending'}</button></div>
  ${!rows.length ? `<section class="panel hello" style="margin-bottom:14px"><img src="/img/joblin-mailbox.png" alt="Joblin looking into an empty mailbox">
    <div><h2>No outreach yet</h2><div class="muted">After an application goes in, Joblin emails the recruiters or hiring managers for that job, then follows up once if they don't reply.</div>
    <div class="checks">
      <div><span class="dot ${sys.gmail ? 'ok' : ''}"></span>${sys.gmail ? `Sending from ${esc(sys.gmailUser)}` : '<a class="link" href="#/settings" id="toInteg">Connect Gmail</a> so Joblin can send'}</div>
      <div><span class="dot ${S.submitted ? 'ok' : ''}"></span>${S.submitted} applications sent — emails start after each one</div>
      <div><span class="dot ${S.contacts ? 'ok' : ''}"></span>${S.contacts} contacts found. ${SET?.email?.hunterApiKey ? '' : 'Jobs from company boards need a free <a class="link" href="#/settings">Hunter key</a> to find recruiters.'}</div>
    </div></div></section>` : !sys.gmail ? `<div class="panel" style="padding:14px 18px;margin-bottom:14px">Emails are queued but won't send until you connect Gmail. <a class="link" href="#/settings" id="toInteg">Connect Gmail</a></div>` : ''}
  <div class="panel tablewrap" ${rows.length ? '' : 'hidden'}><table><thead><tr><th>Contact</th><th>Company</th><th>Email</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
  ${rows.filter((r) => !state.emailFilter || r.status === state.emailFilter).map((r) => `<tr>
    <td>${esc(r.name || '—')}<div class="sub">${esc(r.email)}${r.source === 'guessed' ? ' · guessed address' : ''}</div></td>
    <td>${esc(r.company)}<div class="sub">${esc(r.title)}</div></td>
    <td><details><summary class="sub" style="cursor:pointer">${r.kind === 'followup' ? 'Follow-up' : 'Intro'}: ${esc(r.subject)}</summary><div class="sub" style="white-space:pre-wrap;margin-top:8px;max-width:520px">${esc(r.body)}</div></details>
      ${r.reply_snippet ? `<div class="sub" style="margin-top:6px;color:var(--ink-2)">“${esc(r.reply_snippet.slice(0, 160))}”</div>` : ''}${r.error ? `<div class="sub" style="color:var(--bad)">${esc(r.error)}</div>` : ''}</td>
    <td>${pill(r.status)}</td><td class="sub">${when(r.replied_at || r.sent_at || r.scheduled_at)}</td>
    <td>${r.status === 'scheduled' ? `<button class="btn sm ghost" data-cancel="${r.id}">Cancel</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6"><div class="empty"><b>No outreach yet</b>Emails are written after each application goes in.</div></td></tr>`}
  </tbody></table></div>`;
  $$('#ef button').forEach((b) => b.onclick = () => { state.emailFilter = b.dataset.f; render(); });
  $('#pause').onclick = async () => { await api('/email/pause', { method: 'POST', body: { paused: !sys.emailPaused } }); await refreshSummary(); render(); };
  $('#toInteg')?.addEventListener('click', () => (state.settingsTab = 'integrations'));
  $$('[data-cancel]').forEach((b) => b.onclick = async () => { await api(`/emails/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }); render(); });
};

// ---------- Tasks ----------
VIEWS.tasks = async (view) => {
  const tasks = await api('/tasks');
  view.innerHTML = `<div class="panel"><div class="panel-b" style="display:flex;gap:8px"><input type="text" id="newTask" placeholder="Add a task"><button class="btn" id="addTask">Add task</button></div>
    <div class="list">${tasks.map(taskRow).join('') || '<div class="empty">No tasks.</div>'}</div></div>`;
  const add = async () => { const v = $('#newTask').value.trim(); if (!v) return; await api('/tasks', { method: 'POST', body: { title: v, priority: 2 } }); refreshSummary(); render(); };
  $('#addTask').onclick = add; $('#newTask').onkeydown = (e) => e.key === 'Enter' && add();
  bindTasks(view);
};

// ---------- Settings ----------
async function loadSettings() { const r = await api('/settings'); SET = r.settings; return r; }
const saveSettings = async (patch, msg = 'Saved') => { const r = await api('/settings', { method: 'PUT', body: patch }); SET = r.settings; toast(msg); refreshSummary(); };
const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;

VIEWS.settings = async (view) => {
  const { suggested } = await loadSettings();
  const tabs = [['integrations', 'Integrations'], ['ai', 'AI model'], ['sources', 'Job sources'], ['positions', 'Positions'], ['automation', 'Automation'], ['resumes', 'Resumes'], ['cover', 'Cover letter'], ['profile', 'Profile'], ['email', 'Email outreach']];
  view.innerHTML = `<div class="settings"><div class="stabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${state.settingsTab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="spane" id="spane"></div></div>`;
  $$('.stabs button').forEach((b) => b.onclick = () => { state.settingsTab = b.dataset.t; render(); });
  await SETTINGS[state.settingsTab]($('#spane'), suggested);
};

const SETTINGS = {};
SETTINGS.integrations = async (el) => {
  const sys = S.system;
  el.innerHTML = `
  <section class="panel panel-b"><div class="integ"><div class="ico" style="color:#5f9bff">in</div>
    <div><div class="name">LinkedIn</div><div class="muted" style="font-size:13px">${sys.linkedin?.connected ? `Connected${sys.linkedin.note ? ` as ${esc(sys.linkedin.note)}` : ''}. Joblin searches LinkedIn for jobs and the people who posted them.` : sys.linkedin?.note === 'waiting for sign-in' ? 'Sign in in the LinkedIn window. It closes by itself once you’re in.' : `Optional. Sign in once in a Joblin window — your password never touches Joblin.${sys.linkedin?.note ? ` (${esc(sys.linkedin.note)})` : ''}`}</div></div>
    ${sys.linkedin?.connected ? `<button class="btn danger" id="liOff">Disconnect</button>` : `<button class="btn primary" id="liOn">Connect LinkedIn</button>`}</div></section>

  <section class="panel panel-b"><div class="integ"><div class="ico" style="color:#ea8a7c">M</div>
    <div><div class="name">Gmail</div><div class="muted" style="font-size:13px">${sys.gmail ? `Connected as ${esc(sys.gmailUser)}. Sends outreach and watches for replies.` : 'Sends outreach from your address and watches your inbox for replies, interviews and rejections.'}</div></div>
    ${sys.google?.connected ? `<button class="btn danger" id="goOff">Disconnect</button>` : sys.gmail ? `<button class="btn danger" id="gmOff">Disconnect</button>` : sys.google?.configured ? `<button class="btn" id="goOn" style="background:#fff;color:#1f1f1f;border-color:#fff"><svg viewBox="0 0 24 24" width="16" height="16" style="stroke:none"><path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.8 3.3-8z"/><path fill="#34A853" d="M12 23c3 0 5.5-1 7.3-2.7l-3.6-2.7c-1 .7-2.2 1.1-3.7 1.1-2.9 0-5.3-1.9-6.2-4.5H2.1v2.8A11 11 0 0 0 12 23z"/><path fill="#FBBC05" d="M5.8 14.2a6.6 6.6 0 0 1 0-4.3V7.1H2.1a11 11 0 0 0 0 9.9z"/><path fill="#EA4335" d="M12 5.4c1.6 0 3.1.6 4.2 1.7l3.2-3.2A11 11 0 0 0 2.1 7.1l3.7 2.8C6.7 7.3 9.1 5.4 12 5.4z"/></svg>Sign in with Google</button>` : ''}</div>
    ${sys.gmail ? '' : `<details style="margin-top:12px"><summary class="muted" style="cursor:pointer;font-size:13px">${sys.google?.configured ? 'Or use an app password instead' : 'Connect with an app password'}</summary><ol class="steps"><li>Turn on 2-Step Verification for your Google account.</li><li>Open <a class="link" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App passwords</a>, create one called “Joblin”, and copy the 16 characters.</li><li>Paste it below. Joblin checks it with Google before saving.</li></ol>
    <div class="grid2" style="margin-top:14px"><label class="f">Gmail address<input type="email" id="gmUser" placeholder="you@gmail.com" autocomplete="off"></label>
    <label class="f">App password<input type="password" id="gmPass" placeholder="xxxx xxxx xxxx xxxx" autocomplete="off"></label></div>
    <div style="margin-top:12px"><button class="btn primary" id="gmOn">Test and connect</button></div></details>`}</section>

  <section class="panel panel-b"><div class="integ"><div class="ico">AI</div>
    <div><div class="name">Local model</div><div class="muted" style="font-size:13px">${sys.llmProvider === 'ollama' ? (sys.llm ? `Running ${esc(SET.llm.model)} in Ollama on this Mac. Free.` : 'Ollama isn’t responding. Start it with: brew services start ollama') : `Using ${esc(sys.llmModel)} with your API key.`} <a class="link" href="#" id="toAi">Change model</a></div></div>
    <span class="pill ${sys.llm ? 'good' : 'bad'}">${sys.llm ? 'Ready' : 'Not ready'}</span></div></section>

  <section class="panel panel-b"><div class="integ"><div class="ico">H</div>
    <div><div class="name">Hunter.io <span class="muted" style="font-weight:400">optional</span></div><div class="muted" style="font-size:13px">Verifies recruiter email addresses so fewer emails bounce. The free plan covers 25 lookups a month.</div></div><span></span></div>
    <div style="display:flex;gap:8px;margin-top:12px"><input type="password" id="hunter" placeholder="API key" value="${esc(SET.email.hunterApiKey || '')}"><button class="btn" id="hunterSave">Save key</button></div></section>`;
  $('#liOn')?.addEventListener('click', async () => {
    try { const r = await api('/integrations/linkedin/connect', { method: 'POST', body: {} }); toast(r.message); poll(); } catch (e) { toast(e.message, true); }
  });
  $('#liOff')?.addEventListener('click', async () => { if (!(await ask({ title: 'Disconnect LinkedIn?', body: 'Joblin will stop searching LinkedIn until you reconnect.', ok: 'Disconnect', danger: true }))) return; await api('/integrations/linkedin/disconnect', { method: 'POST', body: {} }); await refreshSummary(); render(); });
  $('#gmOn')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Checking with Google…';
    try { await api('/integrations/gmail', { method: 'POST', body: { user: $('#gmUser').value, pass: $('#gmPass').value } }); toast('Gmail connected'); await refreshSummary(); render(); }
    catch (e) { toast(e.message, true); ev.target.disabled = false; ev.target.textContent = 'Test and connect'; }
  });
  $('#goOn')?.addEventListener('click', async (ev) => {
    ev.target.disabled = true; ev.target.textContent = 'Opening Google…';
    try { await api('/integrations/google/start', { method: 'POST', body: {} }); toast('Finish signing in with Google in your browser'); pollGoogle(); }
    catch (e) { toast(e.message, true); ev.target.disabled = false; ev.target.textContent = 'Sign in with Google'; }
  });
  $('#goOff')?.addEventListener('click', async () => { if (!(await ask({ title: 'Disconnect Gmail?', body: 'Queued emails wait until you reconnect.', ok: 'Disconnect', danger: true }))) return; await api('/integrations/google', { method: 'DELETE' }); await refreshSummary(); render(); });
  function pollGoogle() { let n = 0; const t = setInterval(async () => { await refreshSummary(); if (S.system.google?.connected || ++n > 200) { clearInterval(t); toast(S.system.google?.connected ? 'Gmail connected' : 'Google sign-in timed out', !S.system.google?.connected); if (route() === 'settings') render(); } }, 3000); }
  $('#gmOff')?.addEventListener('click', async () => { if (!(await ask({ title: 'Disconnect Gmail?', body: 'Queued emails wait until you reconnect.', ok: 'Disconnect', danger: true }))) return; await api('/integrations/gmail', { method: 'DELETE' }); await refreshSummary(); render(); });
  $('#toAi')?.addEventListener('click', (e) => { e.preventDefault(); state.settingsTab = 'ai'; render(); });
  $('#hunterSave').onclick = () => saveSettings({ email: { hunterApiKey: $('#hunter').value.trim() } }, 'Hunter key saved');
  function poll() { let n = 0; const t = setInterval(async () => { await refreshSummary(); if (S.system.linkedin?.connected || ++n > 120) { clearInterval(t); if (route() === 'settings') render(); } }, 3000); }
};

SETTINGS.automation = async (el) => {
  const m = SET.mode, a = SET.apply;
  el.innerHTML = `
  <section class="panel panel-b">
    <div class="panel-h" style="padding:0 0 14px"><h2>How Joblin applies</h2></div>
    <div class="choice" id="modeChoice">
      <button data-m="review" class="${m.type === 'review' ? 'on' : ''}"><b>Review each batch</b><span>Joblin finds jobs and prepares every application, then waits for you to approve the batch.</span></button>
      <button data-m="autopilot" class="${m.type === 'autopilot' ? 'on' : ''}"><b>Autopilot</b><span>Joblin finds, prepares and submits on its own schedule. You check in on the dashboard.</span></button>
    </div>
  </section>
  <section class="panel panel-b">
    <div class="srow"><div class="l"><b>Find jobs automatically</b><span>Search on a schedule while Joblin is open. Always on in autopilot.</span></div><div class="ctl">${sw('autoDiscover', m.autoDiscover || m.type === 'autopilot')}</div></div>
    <div class="srow"><div class="l"><b>Search every</b><span>Hours between runs.</span></div><div class="ctl"><input type="number" id="every" min="1" max="48" value="${m.discoverEveryHours}" style="width:90px"></div></div>
    <div class="srow"><div class="l"><b>Batch size</b><span>Applications prepared per run.</span></div><div class="ctl"><input type="number" id="batch" min="1" max="200" value="${m.batchSize}" style="width:90px"></div></div>
    <div class="srow"><div class="l"><b>Autopilot minimum fit</b><span>In autopilot, skip jobs scoring below this (0–100).</span></div><div class="ctl"><input type="number" id="minScore" min="0" max="100" value="${m.minScore ?? 0}" style="width:90px"></div></div>
  </section>
  <section class="panel panel-b">
    <div class="srow"><div class="l"><b>While Joblin works</b><span>Hidden runs a real Chrome window that you never see and that never takes your keyboard or mouse. Visible shows the window so you can watch it work.</span></div>
      <div class="ctl"><div class="seg" id="browserSeg"><button data-b="background" class="${a.browser !== 'window' ? 'on' : ''}">Hidden</button><button data-b="window" class="${a.browser === 'window' ? 'on' : ''}">Visible</button></div></div></div>
    <div class="srow"><div class="l"><b>Submit applications</b><span>Off means Joblin fills each form but leaves it unsent, for testing.</span></div><div class="ctl">${sw('autoSubmit', a.autoSubmit)}</div></div>
    <div class="srow"><div class="l"><b>Applications per run</b><span>Upper limit on submissions in one sitting.</span></div><div class="ctl"><input type="number" id="maxApps" min="1" max="300" value="${a.maxApplicationsPerRun}" style="width:90px"></div></div>
  </section>
  <div><button class="btn primary" id="saveAuto">Save automation settings</button></div>`;
  let mode = m.type, browser = a.browser;
  $$('#modeChoice button').forEach((b) => b.onclick = () => { mode = b.dataset.m; $$('#modeChoice button').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('#browserSeg button').forEach((b) => b.onclick = () => { browser = b.dataset.b; $$('#browserSeg button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#saveAuto').onclick = async () => {
    if (mode === 'autopilot' && m.type !== 'autopilot' && !(await ask({ title: 'Turn on autopilot?', body: 'Joblin will find jobs and submit applications on its own schedule, without asking you first.', ok: 'Turn on autopilot' }))) return;
    saveSettings({ mode: { type: mode, autoDiscover: $('#autoDiscover').checked, discoverEveryHours: +$('#every').value, batchSize: +$('#batch').value, minScore: +$('#minScore').value },
      apply: { browser, window: browser === 'window' ? 'visible' : 'hidden', autoSubmit: $('#autoSubmit').checked, maxApplicationsPerRun: +$('#maxApps').value } }, 'Automation settings saved');
  };
};

function positionsEditor(el, suggested, { onboarding = false } = {}) {
  const qs = structuredClone(SET.search.queries);
  const draw = () => {
    const has = (t) => qs.some((q) => q.keywords.toLowerCase() === t.toLowerCase());
    el.innerHTML = `
    ${['swe', 'finance'].map((tr) => `<div><div style="font-size:13px;color:var(--ink-2);margin-bottom:8px">${tr === 'swe' ? 'Software roles' : 'Finance roles'}</div>
      <div class="chips">${suggested[tr].map((t) => `<button class="chip ${has(t) ? 'on' : ''}" data-add="${esc(t)}" data-track="${tr}">${esc(t)}</button>`).join('')}</div></div>`).join('')}
    <div><div style="font-size:13px;color:var(--ink-2);margin:6px 0 8px">Searches Joblin will run (${qs.length})</div>
      <div style="display:grid;gap:8px">${qs.map((q, i) => `<div class="qrow">
        <input type="text" data-k="${i}" value="${esc(q.keywords)}" aria-label="Role">
        <input type="text" data-l="${i}" value="${esc(q.location)}" aria-label="Location">
        <select data-tr="${i}" aria-label="Resume"><option value="auto" ${q.track === 'auto' ? 'selected' : ''}>Auto resume</option><option value="swe" ${q.track === 'swe' ? 'selected' : ''}>Software</option><option value="finance" ${q.track === 'finance' ? 'selected' : ''}>Finance</option></select>
        <button class="btn sm ghost" data-rm="${i}" aria-label="Remove">Remove</button></div>`).join('')}</div>
      <button class="btn sm" id="addQ" style="margin-top:10px">Add a search</button></div>`;
    $$('[data-add]', el).forEach((b) => b.onclick = () => {
      const t = b.dataset.add, i = qs.findIndex((q) => q.keywords.toLowerCase() === t.toLowerCase());
      if (i >= 0) qs.splice(i, 1); else qs.push({ keywords: t, location: qs[0]?.location || 'Canada', track: b.dataset.track });
      draw();
    });
    $$('[data-k]', el).forEach((i) => i.oninput = () => (qs[+i.dataset.k].keywords = i.value));
    $$('[data-l]', el).forEach((i) => i.oninput = () => (qs[+i.dataset.l].location = i.value));
    $$('[data-tr]', el).forEach((i) => i.onchange = () => (qs[+i.dataset.tr].track = i.value));
    $$('[data-rm]', el).forEach((b) => b.onclick = () => { qs.splice(+b.dataset.rm, 1); draw(); });
    $('#addQ', el).onclick = () => { qs.push({ keywords: '', location: qs[0]?.location || 'Canada', track: 'auto' }); draw(); };
  };
  draw();
  return () => qs.filter((q) => q.keywords.trim());
}

SETTINGS.positions = async (el, suggested) => {
  el.innerHTML = `<section class="panel panel-b"><div class="panel-h" style="padding:0 0 4px"><h2>Positions you’re applying for</h2></div>
    <p class="muted" style="margin:0 0 14px;font-size:13px">Tap a role to add or remove it. Each search runs on LinkedIn with the location you set.</p><div id="pe" style="display:grid;gap:16px"></div></section>
    <section class="panel panel-b"><label class="f">Skip titles containing (comma separated)<input type="text" id="excl" value="${esc(SET.search.excludeTitleWords.join(', '))}"></label>
    <div class="grid2" style="margin-top:12px"><label class="f">Posted within<select id="posted">${['day', 'week', 'month'].map((p) => `<option value="${p}" ${SET.search.postedWithin === p ? 'selected' : ''}>Past ${p}</option>`).join('')}</select></label>
    <label class="f">Jobs per search<input type="number" id="perQ" min="5" max="200" value="${SET.search.maxJobsPerQuery}"></label></div></section>
    <div><button class="btn primary" id="saveQ">Save positions</button></div>`;
  const get = positionsEditor($('#pe'), suggested);
  $('#saveQ').onclick = () => saveSettings({ search: { queries: get(), excludeTitleWords: $('#excl').value.split(',').map((s) => s.trim()).filter(Boolean), postedWithin: $('#posted').value, maxJobsPerQuery: +$('#perQ').value } }, 'Positions saved');
};

function resumeCard(track) {
  return `<section class="panel panel-b" id="rc-${track}"><div class="panel-h" style="padding:0 0 12px"><h2>${track === 'swe' ? 'Software resume' : 'Finance resume'}</h2><div class="right" id="rcq-${track}"></div></div>
    <div class="drop" data-drop="${track}" tabindex="0" role="button">Drop a PDF or Word file here, or click to choose<input type="file" accept=".pdf,.docx,.doc" hidden></div>
    <div id="rcb-${track}"></div></section>`;
}
function resumeEditor(track, resume) {
  const sec = (title, items, key) => `<details class="rsec"><summary>${esc(title)} <span class="muted" style="font-weight:400">${items.length} entries</span></summary>
    ${items.map((it, i) => `<div class="ritem2"><div class="grid2"><input type="text" data-p="${key}.${i}.org" value="${esc(it.org ?? it.school)}" aria-label="Organization"><input type="text" data-p="${key}.${i}.role" value="${esc(it.role ?? it.degree)}" aria-label="Role"></div>
      <div class="grid2"><input type="text" data-p="${key}.${i}.location" value="${esc(it.location)}" aria-label="Location"><input type="text" data-p="${key}.${i}.date" value="${esc(it.date)}" aria-label="Dates"></div>
      <textarea rows="${Math.max(2, it.bullets.length + 1)}" data-p="${key}.${i}.bullets" aria-label="Bullets, one per line">${esc(it.bullets.join('\n'))}</textarea></div>`).join('')}</details>`;
  return `${sec('Education', resume.education.map((e) => ({ ...e, org: e.school, role: e.degree })), 'education')}
    ${resume.sections.map((s, si) => sec(s.title, s.items, `sections.${si}.items`)).join('')}
    <label class="f" style="margin-top:12px">Skills (comma separated)<input type="text" data-p="skills" value="${esc((resume.skills || []).join(', '))}"></label>`;
}
function collectResume(root, base) {
  const r = structuredClone(base);
  $$('[data-p]', root).forEach((el) => {
    const path = el.dataset.p.split('.'); const leaf = path.pop();
    if (path.length === 0) { r.skills = el.value.split(',').map((s) => s.trim()).filter(Boolean); return; }
    let o = r; for (const k of path) o = o[k];
    const key = path[0] === 'education' ? ({ org: 'school', role: 'degree' }[leaf] || leaf) : leaf;
    o[key] = leaf === 'bullets' ? el.value.split('\n').map((s) => s.trim()).filter(Boolean) : el.value;
  });
  return r;
}
async function mountResume(track, { onboarding = false } = {}) {
  const box = $(`#rcb-${track}`); const q = $(`#rcq-${track}`);
  const cur = await api(`/resumes/${track}`);
  let staged = null;
  const showCurrent = () => {
    q.innerHTML = cur.file.originalName ? `<span class="pill plain">${esc(cur.file.originalName)}</span>` : '<span class="pill plain">Built in</span>';
    box.innerHTML = `<div class="srow" style="margin-top:12px"><div class="l"><b>Send my original file unchanged</b><span>Skip tailoring and attach your uploaded PDF as-is.</span></div><div class="ctl">${sw(`orig-${track}`, cur.file.useOriginalFile)}</div></div>
      <div style="display:flex;gap:8px;margin-top:4px"><button class="btn sm" id="prev-${track}">Preview resume</button><button class="btn sm ghost" id="edit-${track}">Edit content</button></div><div id="ed-${track}"></div>`;
    $(`#orig-${track}`).onchange = (e) => { if (e.target.checked && !/\.pdf$/i.test(cur.file.originalFile || '')) { e.target.checked = false; return toast('Upload a PDF first to send it unchanged', true); } saveSettings({ resumes: { [track]: { useOriginalFile: e.target.checked } } }); };
    $(`#prev-${track}`).onclick = async () => { const r = await api(`/resumes/${track}/preview`, { method: 'POST', body: {} }); window.open(fileUrl(r.path), '_blank'); };
    $(`#edit-${track}`).onclick = () => openEditor(cur.resume, 'Save changes');
  };
  const openEditor = (resume, label, quality) => {
    const ed = $(`#ed-${track}`) || box;
    ed.innerHTML = `${quality ? `<div style="margin:12px 0;font-size:13px" class="${quality.ok ? 'muted' : ''}">${quality.ok ? `Found ${quality.items} roles and ${quality.bullets} bullet points. Check them below, then confirm.` : `<span style="color:var(--warn)">Only found ${quality.items} roles and ${quality.bullets} bullets — fix anything missing below before confirming.</span>`}</div>` : ''}
      <div id="edf-${track}">${resumeEditor(track, resume)}</div>
      <div style="display:flex;gap:8px;margin-top:12px"><button class="btn primary" id="conf-${track}">${label}</button><button class="btn ghost" id="cancel-${track}">Cancel</button></div>`;
    $(`#conf-${track}`).onclick = async () => {
      const data = collectResume($(`#edf-${track}`), resume);
      await api(`/resumes/${track}/confirm`, { method: 'POST', body: { resume: data } });
      toast('Resume saved'); Object.assign(cur, await api(`/resumes/${track}`)); showCurrent();
    };
    $(`#cancel-${track}`).onclick = showCurrent;
  };
  const drop = $(`[data-drop="${track}"]`), input = $('input', drop);
  const upload = async (file) => {
    drop.textContent = `Reading ${file.name}…`;
    try {
      const r = await api(`/resumes/${track}/upload`, { method: 'POST', raw: await file.arrayBuffer(), headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' } });
      staged = r.parsed; cur.file.originalName = file.name; cur.file.originalFile = file.name;
      drop.innerHTML = `Uploaded ${esc(file.name)}. Drop another file to replace it.<input type="file" accept=".pdf,.docx,.doc" hidden>`;
      box.innerHTML = '<div id="ed-' + track + '"></div>'; openEditor(staged, 'Confirm resume', r.quality);
    } catch (e) { toast(e.message, true); drop.textContent = 'Drop a PDF or Word file here, or click to choose'; }
  };
  drop.onclick = () => $('input', drop).click();
  drop.onkeydown = (e) => (e.key === 'Enter' || e.key === ' ') && $('input', drop).click();
  drop.addEventListener('change', (e) => e.target.files[0] && upload(e.target.files[0]));
  drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
  drop.ondragleave = () => drop.classList.remove('over');
  drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); e.dataTransfer.files[0] && upload(e.dataTransfer.files[0]); };
  showCurrent();
}
SETTINGS.resumes = async (el) => {
  el.innerHTML = `<p class="muted" style="margin:0;font-size:13px">Joblin picks the right resume for each job, reorders your bullet points to match the posting, and never adds experience you don’t have.</p>${resumeCard('swe')}${resumeCard('finance')}`;
  await Promise.all([mountResume('swe'), mountResume('finance')]);
};

const EEO = {
  gender: ['Male', 'Female', 'Non-binary', 'Decline to self-identify'],
  pronouns: ['He/him', 'She/her', 'They/them', 'Prefer not to say'],
  race: ['Asian', 'Black or African American', 'Hispanic or Latino', 'Indigenous / Native American', 'Middle Eastern or North African', 'Native Hawaiian or Pacific Islander', 'White', 'Two or more races', 'Decline to self-identify'],
  hispanic: ['Yes', 'No', 'Decline to self-identify'],
  disability: ['Yes, I have a disability', 'No, I do not have a disability', 'I do not want to answer'],
  veteran: ['I am not a protected veteran', 'I identify as a protected veteran', 'I do not wish to self-identify'],
  sexualOrientation: ['Heterosexual', 'Gay or lesbian', 'Bisexual', 'Queer', 'Decline to self-identify'],
  lgbtq: ['Yes', 'No', 'Decline to self-identify'],
  indigenous: ['Yes', 'No', 'Decline to self-identify'],
  visibleMinority: ['Yes', 'No', 'Decline to self-identify'],
};
const MONTHS_UI = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
SETTINGS.profile = async (el) => {
  const p = SET.profile, A = p.answers;
  const f = (k, l, v, t = 'text', ph = '') => `<label class="f">${l}<input type="${t}" data-pf="${k}" value="${esc(v)}" placeholder="${esc(ph)}"></label>`;
  const opt = (list, cur) => [...new Set([...(cur && !list.includes(cur) ? [cur] : []), ...list])].map((o) => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('');
  const sel = (k, l, list, src = 'pa') => `<label class="f">${l}<select data-${src}="${k}">${opt(list, src === 'pa' ? A[k] : p[k])}</select></label>`;
  el.innerHTML = `
  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>About you</h2></div>
    <div class="grid2">${f('firstName', 'First name', p.firstName)}${f('lastName', 'Last name', p.lastName)}${f('email', 'Email on applications', p.email, 'email')}${f('phone', 'Phone', p.phone)}
    ${f('city', 'City', p.city)}${f('region', 'Province or state', p.region)}${f('country', 'Country', p.country)}${f('linkedin', 'LinkedIn URL', p.linkedin)}
    ${f('github', 'GitHub URL', p.github)}${f('website', 'Website or portfolio', p.website, 'text', 'Leave blank if you don’t have one')}</div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Education</h2></div>
    <div class="grid2">${f('school', 'School', p.school)}${f('degree', 'Degree', p.degree, 'text', 'e.g. Bachelor of Commerce')}
    ${f('major', 'Major', p.major)}${f('minor', 'Minor', p.minor, 'text', 'Optional')}
    <div class="grid2">${f('gpa', 'GPA', p.gpa, 'text', 'e.g. 3.7')}${f('gpaScale', 'Out of', p.gpaScale, 'text', '4.0')}</div>
    ${sel('yearOfStudy', 'Year of study', ['1st year', '2nd year', '3rd year', '4th year', '5th year or more', 'Graduate student'], 'pf')}
    ${sel('eduStartMonth', 'Started — month', MONTHS_UI, 'pf')}${f('eduStartYear', 'Started — year', p.eduStartYear, 'text', 'e.g. 2024')}
    ${sel('graduationMonth', 'Graduation — month', MONTHS_UI, 'pf')}${f('graduationYear', 'Graduation — year', p.graduationYear)}</div>
    <div class="srow" style="border-top:1px solid var(--line-soft);padding-top:14px"><div class="l"><b>Transcript</b><span>${p.transcriptName ? `${esc(p.transcriptName)} — attached when an application asks for one.` : 'Optional. Attached only when an application asks for a transcript.'}</span></div>
      <div class="ctl" style="display:flex;gap:8px">${p.transcriptName ? '<button class="btn sm ghost danger" id="trDel">Remove</button>' : ''}<button class="btn sm" id="trUp">${p.transcriptName ? 'Replace' : 'Upload transcript'}</button><input type="file" id="trFile" accept=".pdf,.png,.jpg,.jpeg,.docx" hidden></div></div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Most recent role</h2></div>
    <p class="muted" style="margin:-6px 0 0;font-size:13px">Used for “current employer”, “job title” and work-history sections on applications. Leave the end date blank if you still work there.</p>
    <div class="grid2">${f('currentEmployer', 'Employer', p.currentEmployer)}${f('currentTitle', 'Job title', p.currentTitle)}
    ${sel('jobStartMonth', 'Started — month', MONTHS_UI, 'pf')}${f('jobStartYear', 'Started — year', p.jobStartYear)}
    ${sel('jobEndMonth', 'Ended — month', ['', ...MONTHS_UI], 'pf')}${f('jobEndYear', 'Ended — year', p.jobEndYear, 'text', 'Blank if current')}</div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Work eligibility & preferences</h2></div>
    <div class="grid2">${sel('authorizedToWork', `Authorized to work in ${esc(p.country)}`, ['Yes', 'No'])}${sel('requiresSponsorship', `Need sponsorship in ${esc(p.country)}`, ['Yes', 'No'])}
    ${sel('authorizedToWorkUS', 'Authorized to work in the US', ['Yes', 'No'])}${sel('requiresSponsorshipUS', 'Need US sponsorship', ['Yes', 'No'])}
    ${sel('willingToRelocate', 'Willing to relocate', ['Yes', 'No'])}<label class="f">Earliest start date<input type="text" data-pa="startDate" value="${esc(A.startDate)}"></label>
    <label class="f">Salary expectation<input type="text" data-pa="salaryExpectation" value="${esc(A.salaryExpectation)}"></label><label class="f">How did you hear about us<input type="text" data-pa="howDidYouHear" value="${esc(A.howDidYouHear)}"></label></div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Voluntary self-identification</h2></div>
    <p class="muted" style="margin:-6px 0 0;font-size:13px">Many applications ask these optional questions. Employers can't use them in hiring decisions. Choose “decline” for anything you'd rather not share.</p>
    <div class="grid2">${sel('gender', 'Gender', EEO.gender)}${sel('pronouns', 'Pronouns', EEO.pronouns)}${sel('race', 'Race / ethnicity', EEO.race)}${sel('hispanic', 'Hispanic or Latino', EEO.hispanic)}
    ${sel('disability', 'Disability', EEO.disability)}${sel('veteran', 'Veteran status', EEO.veteran)}${sel('sexualOrientation', 'Sexual orientation', EEO.sexualOrientation)}${sel('lgbtq', 'LGBTQ+', EEO.lgbtq)}
    ${sel('indigenous', 'Indigenous (Canada)', EEO.indigenous)}${sel('visibleMinority', 'Visible minority (Canada)', EEO.visibleMinority)}</div></section>
  <div><button class="btn primary" id="saveP">Save profile</button></div>`;
  $('#saveP').onclick = () => {
    const profile = { answers: {} };
    $$('[data-pf]', el).forEach((i) => (profile[i.dataset.pf] = i.value.trim()));
    $$('[data-pa]', el).forEach((i) => (profile.answers[i.dataset.pa] = i.value.trim()));
    saveSettings(profile.answers.pronouns ? { profile: { ...profile, pronouns: profile.answers.pronouns } } : { profile }, 'Profile saved');
  };
  $('#trUp').onclick = () => $('#trFile').click();
  $('#trFile').onchange = async (e) => {
    const file = e.target.files[0]; if (!file) return;
    try { await api('/profile/transcript', { method: 'POST', raw: await file.arrayBuffer(), headers: { 'x-filename': encodeURIComponent(file.name), 'content-type': 'application/octet-stream' } }); toast('Transcript saved'); await loadSettings(); SETTINGS.profile(el); }
    catch (err) { toast(err.message, true); }
  };
  $('#trDel')?.addEventListener('click', async () => { await api('/profile/transcript', { method: 'DELETE' }); await loadSettings(); SETTINGS.profile(el); });
};

SETTINGS.email = async (el) => {
  const E = SET.email;
  el.innerHTML = `<section class="panel panel-b">
    <div class="srow"><div class="l"><b>Send outreach emails</b><span>Email the recruiters and hiring managers on each job after you apply.</span></div><div class="ctl">${sw('emOn', E.enabled)}</div></div>
    <div class="srow"><div class="l"><b>Daily limit</b><span>Gmail flags accounts that send too much cold email. 30–50 a day is a safe range.</span></div><div class="ctl"><input type="number" id="cap" min="1" max="150" value="${E.dailyCap}" style="width:90px"></div></div>
    <div class="srow"><div class="l"><b>Sending hours</b><span>Weekdays only, in your local time.</span></div><div class="ctl" style="display:flex;gap:6px;align-items:center"><input type="number" id="h1" min="0" max="23" value="${E.sendWindow.startHour}" style="width:70px"> to <input type="number" id="h2" min="1" max="24" value="${E.sendWindow.endHour}" style="width:70px"></div></div>
    <div class="srow"><div class="l"><b>Follow up after</b><span>One polite follow-up if nobody replies. Cancelled automatically when they do.</span></div><div class="ctl" style="display:flex;gap:6px;align-items:center"><input type="number" id="fu" min="1" max="30" value="${E.followUpAfterDays}" style="width:70px"> days</div></div>
    <div class="srow"><div class="l"><b>People per job</b><span>Maximum contacts emailed for one posting.</span></div><div class="ctl"><input type="number" id="per" min="1" max="5" value="${E.maxContactsPerJob}" style="width:70px"></div></div>
    <div class="srow"><div class="l"><b>Email guessed addresses</b><span>When no address is public, try first.last@company. Some will bounce.</span></div><div class="ctl">${sw('guess', E.useGuessedEmails)}</div></div>
  </section><div><button class="btn primary" id="saveE">Save email settings</button></div>`;
  $('#saveE').onclick = () => saveSettings({ email: { enabled: $('#emOn').checked, dailyCap: +$('#cap').value, sendWindow: { startHour: +$('#h1').value, endHour: +$('#h2').value }, followUpAfterDays: +$('#fu').value, maxContactsPerJob: +$('#per').value, useGuessedEmails: $('#guess').checked } }, 'Email settings saved');
};

// ---------- Onboarding ----------
async function openOnboarding() {
  const ob = $('#onboarding'); ob.hidden = false;
  const { suggested } = await loadSettings();
  let step = 0, mode = SET.mode.type, getQueries = null, confirmed = false;
  const STEPS = ['You', 'Resumes', 'Positions', 'Connect', 'Mode'];
  const draw = async () => {
    ob.innerHTML = `<div class="ob-card" role="dialog" aria-modal="true" aria-label="Set up Joblin"><div class="ob-steps">${STEPS.map((_, i) => `<i class="${i <= step ? 'on' : ''}"></i>`).join('')}</div><div class="ob-b" id="obb"></div>
      <div class="ob-f"><span class="muted">Step ${step + 1} of ${STEPS.length}</span><div class="right">${step ? '<button class="btn ghost" id="obBack">Back</button>' : ''}<button class="btn primary" id="obNext">${step === STEPS.length - 1 ? 'Finish setup' : 'Continue'}</button></div></div></div>`;
    const b = $('#obb'); const p = SET.profile;
    if (step === 0) {
      b.innerHTML = `<h2>Let’s set up Joblin</h2><p class="lead">Joblin finds jobs, writes a tailored resume and cover letter for each, applies, and follows up with the people hiring. First, the details that go on every application.</p>
        <div class="grid2">${[['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['region', 'Province or state'], ['linkedin', 'LinkedIn URL'], ['school', 'School'], ['major', 'Major'], ['minor', 'Minor (optional)'], ['gpa', 'GPA (optional)'], ['graduationYear', 'Graduation year']].map(([k, l]) => `<label class="f">${l}<input type="text" data-ob="${k}" value="${esc(p[k])}"></label>`).join('')}</div>`;
    } else if (step === 1) {
      b.innerHTML = `<h2>Your resumes</h2><p class="lead">Upload your software and finance resumes. Joblin reads them, shows you what it found, and uses the best one for each job. Skip this to keep the versions already loaded.</p>${resumeCard('swe')}${resumeCard('finance')}`;
      await Promise.all([mountResume('swe', { onboarding: true }), mountResume('finance', { onboarding: true })]);
    } else if (step === 2) {
      b.innerHTML = `<h2>Which positions are you applying for?</h2><p class="lead">Pick every role you want Joblin to search for. You can change these any time in Settings.</p><div id="obpe" style="display:grid;gap:16px"></div>
        <label class="confirm"><input type="checkbox" id="obConfirm" ${confirmed ? 'checked' : ''}><span>These are the roles I want Joblin to find and prepare applications for.</span></label>`;
      getQueries = positionsEditor($('#obpe'), suggested, { onboarding: true });
      $('#obConfirm').onchange = (e) => (confirmed = e.target.checked);
    } else if (step === 3) {
      b.innerHTML = `<h2>Connect your accounts</h2><p class="lead">LinkedIn is where Joblin finds jobs. Gmail is how it emails recruiters and spots replies. You can skip either and connect later.</p><div id="obint" style="display:grid;gap:14px"></div>`;
      await SETTINGS.integrations($('#obint'));
    } else {
      b.innerHTML = `<h2>How hands-on do you want to be?</h2><p class="lead">You can switch any time in Settings.</p>
        <div class="choice" id="obMode"><button data-m="review" class="${mode === 'review' ? 'on' : ''}"><b>Review each batch</b><span>Joblin prepares a batch of applications, then waits. You check what it wrote and approve which ones go out.</span></button>
        <button data-m="autopilot" class="${mode === 'autopilot' ? 'on' : ''}"><b>Autopilot</b><span>Joblin searches, prepares and applies on a schedule without asking.</span></button></div>
        <p class="muted" style="font-size:13px;margin:0">Either way Joblin runs in the background, so you can keep using your Mac.</p>`;
      $$('#obMode button').forEach((x) => x.onclick = () => { mode = x.dataset.m; $$('#obMode button').forEach((y) => y.classList.toggle('on', y === x)); });
    }
    $('#obBack')?.addEventListener('click', () => { step--; draw(); });
    $('#obNext').onclick = async () => {
      if (step === 0) { const profile = {}; $$('[data-ob]').forEach((i) => (profile[i.dataset.ob] = i.value.trim())); await api('/settings', { method: 'PUT', body: { profile } }); }
      if (step === 2) {
        const qs = getQueries();
        if (!qs.length) return toast('Pick at least one position', true);
        if (!confirmed) return toast('Confirm your positions to continue', true);
        await api('/settings', { method: 'PUT', body: { search: { queries: qs } } });
      }
      if (step === STEPS.length - 1) {
        await api('/settings', { method: 'PUT', body: { onboarded: true, mode: { type: mode, autoDiscover: mode === 'autopilot' } } });
        ob.hidden = true; await refreshSummary(); location.hash = '#/review';
        if (await ask({ title: 'You’re all set', image: '/img/joblin-256.png', body: 'Want Joblin to find your first batch of jobs now?', ok: 'Find jobs now', cancel: 'Later' })) $('#runBtn').click();
        return;
      }
      step++; await loadSettings(); draw();
    };
  };
  draw();
}

// ---------- AI model ----------
const PROVIDER_ICONS = {
  ollama: { bg: '#2b2d33', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#ecebe8" stroke-width="1.6"><path d="M8 3.5v4M16 3.5v4"/><path d="M6 11.5a6 6 0 0 1 12 0V17a4 4 0 0 1-4 4h-4a4 4 0 0 1-4-4z"/><circle cx="9.6" cy="12.5" r=".9" fill="#ecebe8"/><circle cx="14.4" cy="12.5" r=".9" fill="#ecebe8"/><path d="M10.5 16.2c.9.6 2.1.6 3 0"/></svg>' },
  anthropic: { bg: '#3a2a22', svg: '<svg viewBox="0 0 24 24" fill="#e8916a"><path d="M12 2.5l1.3 6.2 5.1-3.8-3.8 5.1 6.2 1.3-6.2 1.3 3.8 5.1-5.1-3.8L12 21.5l-1.3-6.2-5.1 3.8 3.8-5.1L3.2 12.7l6.2-1.3-3.8-5.1 5.1 3.8z"/></svg>' },
  openai: { bg: '#20302b', svg: '<svg viewBox="0 0 24 24" fill="none" stroke="#7fd3b2" stroke-width="1.6"><path d="M12 3.2l7.6 4.4v8.8L12 20.8l-7.6-4.4V7.6z"/><path d="M12 7.6l3.8 2.2v4.4L12 16.4l-3.8-2.2V9.8z"/><path d="M12 3.2v4.4M19.6 7.6l-3.8 2.2M19.6 16.4l-3.8-2.2M12 20.8v-4.4M4.4 16.4l3.8-2.2M4.4 7.6l3.8 2.2"/></svg>' },
  gemini: { bg: '#1f2a44', svg: '<svg viewBox="0 0 24 24"><defs><linearGradient id="gm" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#7aa8ff"/><stop offset="1" stop-color="#b48cff"/></linearGradient></defs><path fill="url(#gm)" d="M12 2c.6 5.3 4.7 9.4 10 10-5.3.6-9.4 4.7-10 10-.6-5.3-4.7-9.4-10-10C7.3 11.4 11.4 7.3 12 2z"/></svg>' },
};
SETTINGS.ai = async (el) => {
  const L = SET.llm, provs = L.providers;
  let prov = L.provider || 'ollama';
  const draw = () => {
    el.innerHTML = `<section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>Writing model</h2></div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">Joblin uses this model for cover letters, emails and application questions. The local model is free. Cloud models write noticeably better and cost a fraction of a cent per application on your own key.</p>
      <div class="choice" id="provs" style="grid-template-columns:repeat(2,1fr)">${Object.entries(provs).map(([k, v]) => `<button data-p="${k}" class="${prov === k ? 'on' : ''}"><span class="pico" style="background:${PROVIDER_ICONS[k]?.bg}">${PROVIDER_ICONS[k]?.svg || ''}</span><b>${esc(v.label)}</b><span>${k === 'ollama' ? 'Runs on this Mac. No account, no cost.' : L.keys[k] ? `Key saved (${esc(L.keys[k])})` : 'Needs an API key'}</span></button>`).join('')}</div>
      <div class="grid2" style="margin-top:16px">
        <label class="f">Model<input type="text" id="model" value="${esc(prov === 'ollama' ? L.model : (L.models?.[prov] || provs[prov].defaultModel))}"></label>
        ${prov === 'ollama' ? '<div></div>' : `<label class="f">API key<input type="password" id="key" placeholder="${L.keys[prov] ? esc(L.keys[prov]) + ' saved — paste to replace' : 'Paste your key'}" autocomplete="off"></label>`}
      </div>
      <div class="muted" style="font-size:12.5px;margin-top:8px">${prov === 'anthropic' ? 'Get a key at console.anthropic.com.' : prov === 'openai' ? 'Get a key at platform.openai.com.' : prov === 'gemini' ? 'Get a key at aistudio.google.com — Gemini has a free tier.' : 'To use a bigger local model, run: ollama pull qwen2.5:7b (needs more memory).'}</div>
      <div style="display:flex;gap:8px;margin-top:16px"><button class="btn primary" id="saveAi">Save</button><button class="btn" id="testAi">Test</button>
      ${prov !== 'ollama' && L.keys[prov] ? '<button class="btn ghost danger" id="rmKey">Remove key</button>' : ''}<span class="muted" id="aiOut" style="align-self:center;font-size:13px"></span></div></section>`;
    $$('#provs button', el).forEach((b) => b.onclick = () => { prov = b.dataset.p; draw(); });
    const save = async () => {
      const patch = { llm: { provider: prov } };
      if (prov === 'ollama') patch.llm.model = $('#model').value.trim(); else { patch.llm.models = { [prov]: $('#model').value.trim() }; const k = $('#key')?.value.trim(); if (k) patch.llm.keys = { [prov]: k }; }
      await saveSettings(patch, 'Model saved'); await loadSettings();
    };
    $('#saveAi').onclick = async () => { await save(); SETTINGS.ai(el); };
    $('#testAi').onclick = async () => { await save(); $('#aiOut').textContent = 'Testing…';
      try { const r = await api('/llm/test', { method: 'POST', body: {} }); $('#aiOut').textContent = r.ok ? `Works — ${r.model} answered in ${(r.ms / 1000).toFixed(1)}s` : 'The model answered, but not correctly. Try another model.'; }
      catch (e) { $('#aiOut').textContent = e.message; } };
    $('#rmKey')?.addEventListener('click', async () => { await api(`/llm/keys/${prov}`, { method: 'DELETE' }); await loadSettings(); toast('Key removed'); SETTINGS.ai(el); });
  };
  draw();
};

// ---------- Job sources ----------
SETTINGS.sources = async (el) => {
  const B = SET.sources.boards, Li = SET.sources.linkedin;
  const list = (B.list?.length ? B.list : B.defaults);
  el.innerHTML = `<section class="panel panel-b">
    <div class="srow"><div class="l"><b>Company job boards</b><span>Reads open roles straight from companies’ Greenhouse, Lever and Ashby pages. No login, and Joblin can submit every one of these itself.</span></div><div class="ctl">${sw('bOn', B.enabled !== false)}</div></div>
    <div class="srow"><div class="l"><b>LinkedIn</b><span>Searches LinkedIn with your positions. Needs LinkedIn connected.</span></div><div class="ctl">${sw('lOn', Li.enabled !== false)}</div></div>
    <div class="srow"><div class="l"><b>New jobs per run</b><span>From company boards.</span></div><div class="ctl"><input type="number" id="bMax" min="5" max="500" value="${B.maxPerRun}" style="width:90px"></div></div>
  </section>
  <section class="panel panel-b"><label class="f">Locations to keep (comma separated — “Remote” only counts when it isn’t tied to another country)<input type="text" id="bLoc" value="${esc(B.locations.join(', '))}"></label>
    <div class="srow" style="margin-top:6px"><div class="l"><b>Include roles without “intern” or “new grad” in the title</b><span>Off keeps it to internships, co-ops and early-career roles.</span></div><div class="ctl">${sw('bEntry', B.includeEntryLevelWithoutKeyword)}</div></div></section>
  <section class="panel panel-b"><label class="f">Companies (${list.length}) — one per line as ats:company, e.g. greenhouse:stripe, lever:palantir, ashby:wealthsimple. Find the name in the company’s careers page URL.
    <textarea id="bList" rows="12" style="font-size:13px">${esc(list.join('\n'))}</textarea></label>
    <button class="btn sm ghost" id="bReset" style="margin-top:8px">Reset to the default list</button></section>
  <div><button class="btn primary" id="saveSrc">Save job sources</button></div>`;
  $('#bReset').onclick = () => ($('#bList').value = B.defaults.join('\n'));
  $('#saveSrc').onclick = () => {
    const l = $('#bList').value.split('\n').map((x) => x.trim().toLowerCase()).filter((x) => /^(greenhouse|lever|ashby):[\w.-]+$/.test(x));
    saveSettings({ sources: { boards: { enabled: $('#bOn').checked, maxPerRun: +$('#bMax').value, locations: $('#bLoc').value.split(',').map((x) => x.trim()).filter(Boolean),
      includeEntryLevelWithoutKeyword: $('#bEntry').checked, list: l.join() === B.defaults.join() ? [] : l }, linkedin: { enabled: $('#lOn').checked } } }, 'Job sources saved');
  };
};

// ---------- Cover letter ----------
SETTINGS.cover = async (el) => {
  const C = SET.coverLetter;
  el.innerHTML = `
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>How cover letters are written</h2></div>
    <p class="muted" style="margin:0 0 6px;font-size:13px;max-width:72ch">Most jobs get your template with the company, role and what they do filled in. That costs one small model call. For jobs that fit you best, Joblin writes a <b>precise</b> letter: it keeps your voice and structure, rewrites the “why this role” paragraph from the posting, and adds a paragraph matching their requirements to your experience.</p>
    <div class="srow"><div class="l"><b>Write precise letters for jobs with fit of at least</b><span>0–100. You can also ask for one on any job from Review batch.</span></div><div class="ctl"><input type="number" id="pmin" min="0" max="100" value="${C.preciseMinScore ?? 75}" style="width:80px"></div></div>
    <div class="srow"><div class="l"><b>Always write precise letters</b><span>Best letters, more model calls per job. Free on the local model, just slower.</span></div><div class="ctl">${sw('palways', C.alwaysPrecise)}</div></div>
  </section>
  ${['finance', 'swe'].map((t) => `<section class="panel panel-b"><div class="panel-h" style="padding:0 0 10px"><h2>${t === 'swe' ? 'Software template' : 'Finance template'}</h2>
      <div class="right"><button class="btn sm ghost" data-reset="${t}">Reset to the default</button></div></div>
    <textarea data-tpl="${t}" rows="18" style="font-size:13.5px">${esc(C.activeTemplates[t])}</textarea>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Placeholders: {{company}}, {{role}}, {{company_focus}} (what the company does, e.g. “helping Canadians invest”), {{role_focus}} (what the role does, e.g. “support deal teams on M&amp;A transactions”), {{name}}.</p></section>`).join('')}
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 12px"><h2>Try it</h2>
      <div class="right"><div class="seg" id="pvTrack"><button data-t="finance" class="on">Finance sample</button><button data-t="swe">Software sample</button></div>
      <div class="seg" id="pvKind"><button data-k="template" class="on">Template</button><button data-k="precise">Precise</button></div></div></div>
    <button class="btn" id="pvGo">Save and write a sample letter</button><div id="pvOut" style="margin-top:14px"></div></section>
  <div><button class="btn primary" id="saveCl">Save cover letter settings</button></div>`;
  $$('[data-reset]', el).forEach((b) => b.onclick = () => ($(`[data-tpl="${b.dataset.reset}"]`).value = C.defaultTemplates[b.dataset.reset]));
  let pvt = 'finance', pvk = 'template';
  $$('#pvTrack button').forEach((b) => b.onclick = () => { pvt = b.dataset.t; $$('#pvTrack button').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('#pvKind button').forEach((b) => b.onclick = () => { pvk = b.dataset.k; $$('#pvKind button').forEach((x) => x.classList.toggle('on', x === b)); });
  const patch = () => {
    const templates = {}; $$('[data-tpl]', el).forEach((t) => { const v = t.value.trim(); templates[t.dataset.tpl] = v === C.defaultTemplates[t.dataset.tpl].trim() ? '' : v; });
    return { coverLetter: { preciseMinScore: +$('#pmin').value, alwaysPrecise: $('#palways').checked, templates } };
  };
  $('#saveCl').onclick = () => saveSettings(patch(), 'Cover letter settings saved');
  $('#pvGo').onclick = async (ev) => {
    ev.target.disabled = true;
    $('#pvOut').innerHTML = `<div class="work" style="grid-template-columns:120px 1fr;padding:6px 0"><img src="/img/joblin-working.png" alt="" style="width:120px"><div><b>Joblin is writing a ${pvk} letter…</b><div class="muted">${pvk === 'precise' ? 'About a minute' : 'About 15 seconds'} on the local model.</div></div></div>`;
    try {
      await api('/settings', { method: 'PUT', body: patch() }); await loadSettings();
      const r = await api('/cover/preview', { method: 'POST', body: { track: pvt, precise: pvk === 'precise' } });
      $('#pvOut').innerHTML = `<div class="pdfbar"><span class="muted">${r.text.split(/\s+/).length} words · ${r.kind} letter</span><a class="btn sm" href="${fileUrl(r.pdf, Date.now())}" download="Sample_Cover_Letter.pdf">Download PDF</a></div><iframe class="pdfframe" title="Sample cover letter" src="${fileUrl(r.pdf, Date.now())}#toolbar=0&navpanes=0&view=FitH"></iframe>`;
    } catch (e) { $('#pvOut').textContent = e.message; } finally { ev.target.disabled = false; }
  };
};

// ---------- Shared: a selectable list with a select-all bar ----------
function selectable(root, { onChange } = {}) {
  if (!root) return () => [];
  const boxes = () => $$('[data-pick]', root);
  const all = $('[data-pickall]', root);
  const sync = () => {
    const n = boxes().filter((b) => b.checked).length;
    if (all) { all.checked = n > 0 && n === boxes().length; all.indeterminate = n > 0 && n < boxes().length; }
    $$('[data-needsel]', root).forEach((b) => (b.disabled = !n));
    const c = $('[data-count]', root); if (c) c.textContent = n ? `${n} selected` : '';
    onChange?.(n);
  };
  all?.addEventListener('change', () => { boxes().forEach((b) => (b.checked = all.checked)); sync(); });
  boxes().forEach((b) => b.addEventListener('change', sync));
  sync();
  return () => boxes().filter((b) => b.checked).map((b) => +b.dataset.pick);
}

const answerInput = (r) => r.options?.length
  ? `<select data-ans="${r.id}"><option value="">Choose…</option>${r.options.map((o) => `<option ${o === r.answer ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>`
  : `<textarea data-ans="${r.id}" rows="${Math.min(5, Math.max(1, Math.ceil((r.answer || '').length / 60)))}" placeholder="Your answer">${esc(r.answer)}</textarea>`;
const qaRow = (r) => `<div class="qa"><input type="checkbox" data-pick="${r.id}" aria-label="Select question">
  <div><div class="q">${esc(r.question)}</div><div class="m">${r.source === 'you' ? 'Your answer' : r.source === 'auto' ? 'Written by Joblin — edit or mark as yours' : 'Waiting for your answer'}${r.last_company ? ` · seen at ${esc(r.last_company)}` : ''}${r.uses ? ` · reused ${r.uses}×` : ''}</div></div>
  ${answerInput(r)}<div style="display:flex;gap:6px"><button class="btn sm" data-save="${r.id}">Save</button></div></div>`;
function bindAnswerSaves(root) {
  $$('[data-save]', root).forEach((b) => b.onclick = async () => {
    await api(`/answers/${b.dataset.save}`, { method: 'PUT', body: { answer: $(`[data-ans="${b.dataset.save}"]`, root).value } });
    toast('Saved to memory — Joblin will reuse it'); await refreshSummary(); render();
  });
}

// ---------- Questions: only what still needs an answer ----------
VIEWS.answers = async (view) => {
  const pending = (await api('/answers')).filter((r) => r.source === 'pending');
  if (!pending.length) {
    view.innerHTML = `<section class="panel hello"><img src="/img/joblin-256.png" alt=""><div><h2>No open questions</h2><div class="muted">When an application asks something Joblin can't answer, it shows up here. Once you answer, it moves to <a class="link" href="#/memory">Memory</a> and gets reused.</div></div></section>`;
    return;
  }
  view.innerHTML = `<p class="muted" style="margin:-8px 0 16px;max-width:72ch">Questions from applications that Joblin couldn't answer. Answer them once and they move to Memory, where Joblin reuses them for similar questions.</p>
    <section class="panel"><div class="selbar"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-pickall>Select all</label><span class="muted" data-count></span>
      <div style="margin-left:auto;display:flex;gap:8px"><button class="btn sm" data-needsel id="qSuggest">Let Joblin answer</button><button class="btn sm ghost danger" data-needsel id="qForget">Forget</button></div></div>
      <div>${pending.map(qaRow).join('')}</div></section>`;
  const picked = selectable(view);
  bindAnswerSaves(view);
  $('#qSuggest').onclick = async (ev) => {
    const ids = picked(); ev.target.disabled = true; ev.target.textContent = `Answering ${ids.length}…`;
    const r = await api('/answers/bulk', { method: 'POST', body: { ids, action: 'suggest' } });
    toast(`Joblin answered ${r.answered} of ${ids.length}. Check them in Memory.`); await refreshSummary(); render();
  };
  $('#qForget').onclick = async () => { const ids = picked(); if (!(await ask({ title: `Forget ${ids.length} ${ids.length === 1 ? 'question' : 'questions'}?`, body: 'Joblin will ask again if they come up.', ok: 'Forget', danger: true }))) return; await api('/answers/bulk', { method: 'POST', body: { ids, action: 'delete' } }); await refreshSummary(); render(); };
};

// ---------- Memory: what Joblin knows about you ----------
const FACT_CATS = [['general', 'About me'], ['experience', 'Experience & projects'], ['goals', 'Goals & interests'], ['outreach', 'For emails']];
VIEWS.memory = async (view) => {
  const { facts, answers } = await api('/memory');
  if (!SET) await loadSettings();
  view.innerHTML = `<p class="muted" style="margin:-8px 0 16px;max-width:72ch">Everything Joblin remembers about you. It uses this to answer application questions and, soon, to write personal emails. Your profile and education live in <a class="link" href="#/settings" id="toProfile">Settings → Profile</a>.</p>
    <section class="panel" style="margin-bottom:14px" id="factBox"><div class="panel-h"><h2>Notes about you</h2><span class="sub">${facts.length}</span></div>
      <div class="panel-b" style="display:grid;grid-template-columns:1fr 200px auto;gap:8px;padding-bottom:12px">
        <input type="text" id="factText" placeholder="e.g. Led a team of 3 building a budgeting app; interested in energy-transition investing">
        <select id="factCat">${FACT_CATS.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select><button class="btn" id="factAdd">Add note</button></div>
      ${facts.length ? `<div class="selbar"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-pickall>Select all</label><span class="muted" data-count></span>
        <div style="margin-left:auto"><button class="btn sm ghost danger" data-needsel id="factDel">Forget</button></div></div>` : ''}
      ${facts.map((f) => `<div class="fact"><input type="checkbox" data-pick="${f.id}" aria-label="Select note">
        <textarea data-fact="${f.id}" rows="${Math.min(4, Math.max(1, Math.ceil(f.text.length / 90)))}">${esc(f.text)}</textarea>
        <div style="display:flex;gap:6px;align-items:center"><span class="pill plain">${esc((FACT_CATS.find((c) => c[0] === f.category) || [0, f.category])[1])}</span><button class="btn sm" data-fsave="${f.id}">Save</button></div></div>`).join('') || '<div class="empty" style="padding:22px">Add things that don’t fit on a resume: what you care about, stories worth telling, people you know at a company.</div>'}
    </section>
    <section class="panel" id="ansBox"><div class="panel-h"><h2>Saved answers</h2><span class="sub">${answers.length} from applications</span></div>
      ${answers.length ? `<div class="selbar" style="margin-top:8px"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-pickall>Select all</label><span class="muted" data-count></span>
        <div style="margin-left:auto;display:flex;gap:8px"><button class="btn sm" data-needsel id="ansConfirm">Mark as mine</button><button class="btn sm ghost danger" data-needsel id="ansForget">Forget</button></div></div>` : ''}
      <div>${answers.map(qaRow).join('') || '<div class="empty">Answers appear here after Joblin fills its first applications.</div>'}</div></section>`;
  $('#toProfile').onclick = () => (state.settingsTab = 'profile');
  const addFactNow = async () => { const t = $('#factText').value.trim(); if (!t) return; await api('/facts', { method: 'POST', body: { text: t, category: $('#factCat').value } }); toast('Added to memory'); render(); };
  $('#factAdd').onclick = addFactNow; $('#factText').onkeydown = (e) => e.key === 'Enter' && addFactNow();
  $$('[data-fsave]').forEach((b) => b.onclick = async () => { await api(`/facts/${b.dataset.fsave}`, { method: 'PUT', body: { text: $(`[data-fact="${b.dataset.fsave}"]`).value } }); toast('Saved'); });
  const pickFacts = selectable($('#factBox'));
  $('#factDel')?.addEventListener('click', async () => { const ids = pickFacts(); if (!(await ask({ title: `Forget ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}?`, ok: 'Forget', danger: true }))) return; await api('/facts/delete', { method: 'POST', body: { ids } }); render(); });
  const pickAns = selectable($('#ansBox'));
  bindAnswerSaves($('#ansBox'));
  $('#ansConfirm')?.addEventListener('click', async () => { await api('/answers/bulk', { method: 'POST', body: { ids: pickAns(), action: 'confirm' } }); toast('Marked as your answers'); render(); });
  $('#ansForget')?.addEventListener('click', async () => { const ids = pickAns(); if (!(await ask({ title: `Forget ${ids.length} ${ids.length === 1 ? 'answer' : 'answers'}?`, body: 'Joblin won’t reuse them on future applications.', ok: 'Forget', danger: true }))) return; await api('/answers/bulk', { method: 'POST', body: { ids, action: 'delete' } }); render(); });
};

// ---------- Boot ----------
await refreshSummary();
loadSettings().catch(() => {});
render();
// Poll every 2s while Joblin is working (live progress), every 15s otherwise.
let wasRunning = false;
(async function tick() {
  try {
    await refreshSummary();
    const running = Boolean(S.system.worker?.state);
    const typing = document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName);
    if (!typing && !document.querySelector('.tip:not([hidden])') && ((running && ['review', 'dashboard'].includes(route())) || (wasRunning && !running) || route() === 'dashboard')) render();
    wasRunning = running;
  } catch {}
  setTimeout(tick, S.system?.worker?.state ? 2000 : 15000);
})();
