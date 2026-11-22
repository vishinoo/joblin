// Joblin dashboard — no build step. Hash routes: dashboard, review, applications, outreach, tasks, settings.
import { suggestPlaces } from './places.js';
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
  queued: ['Queued', ''], pending_approval: ['For review', 'accent'], approved: ['In queue', 'accent'], skipped: ['Skipped', ''],
  prepared: ['For review', 'accent'], duplicate: ['Already applied', ''], submitted: ['Applied', 'good'], needs_review: ['Needs a hand', 'warn'], manual: ['Apply yourself', 'warn'],
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
  const paint = () => { btn.innerHTML = `<span>${esc(sel.options[sel.selectedIndex]?.text || 'Choose…')}</span>${CHEVRON}`; if (sel.classList.contains('status')) btn.dataset.status = sel.value; };
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

// ---------- Tag input with suggestions (locations, positions, resume types, companies) ----------
// chipInput(el, { values, suggestions, placeholder, onChange, max })
function chipInput(el, { values = [], suggestions = [], placeholder = 'Type to add…', onChange: onChange0 = () => {}, single = false } = {}) {
  let vals = [...values];
  const onChange = (v) => { onChange0(v); el.dispatchEvent(new Event('change', { bubbles: true })); };
  el.classList.add('chips-in');
  const draw = () => {
    el.innerHTML = `${vals.map((v, i) => `<span class="chip on">${esc(v)}<button type="button" data-x="${i}" aria-label="Remove ${esc(v)}">×</button></span>`).join('')}
      <span class="ci-wrap"><input type="text" class="ci" placeholder="${esc(placeholder)}" autocomplete="off"><div class="dd-menu ci-menu" hidden></div></span>`;
    const input = $('.ci', el), menu = $('.ci-menu', el);
    let active = 0, shown = [], custom = null;
    const add = (v) => { v = String(v).trim().replace(/,$/, ''); if (!v) return; if (!vals.some((x) => x.toLowerCase() === v.toLowerCase())) { vals = single ? [v] : [...vals, v]; onChange(vals); } draw(); $('.ci', el).focus(); };
    const show = () => {
      const q = input.value.trim().toLowerCase();
      // Suggestions are a list, or a function that knows better (places: "us" → the US and its states).
      shown = typeof suggestions === 'function' ? suggestions(q, vals).slice(0, 60)
        : suggestions.filter((s) => !vals.some((v) => v.toLowerCase() === s.toLowerCase()) && (!q || s.toLowerCase().includes(q)))
          .sort((a, b) => (b.toLowerCase().startsWith(q) - a.toLowerCase().startsWith(q))).slice(0, 8);
      custom = q && !shown.some((s) => s.toLowerCase() === q) ? input.value.trim() : null; // what you typed, if it isn't a suggestion
      if (custom) shown.push(custom);
      active = 0;
      menu.innerHTML = shown.map((s, i) => `<div class="dd-opt ${i === 0 ? 'active' : ''}" data-i="${i}">${s === custom ? `Add “${esc(s)}”` : esc(s)}</div>`).join('');
      menu.hidden = !shown.length || document.activeElement !== input;
      $$('.dd-opt', menu).forEach((o) => o.onmousedown = (e) => { e.preventDefault(); add(shown[+o.dataset.i]); });
    };
    input.oninput = show; input.onfocus = show; input.onblur = () => setTimeout(() => (menu.hidden = true), 120);
    input.onkeydown = (e) => {
      const opts = $$('.dd-opt', menu);
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(opts.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); opts.forEach((o, i) => o.classList.toggle('active', i === active)); }
      else if (e.key === 'Enter' || e.key === ',' || e.key === 'Tab' && input.value) { if (shown[active] || input.value) { e.preventDefault(); add(menu.hidden ? input.value : shown[active] || input.value); } }
      else if (e.key === 'Backspace' && !input.value && vals.length) { vals = vals.slice(0, -1); onChange(vals); draw(); $('.ci', el).focus(); }
      else if (e.key === 'Escape') menu.hidden = true;
    };
    $$('[data-x]', el).forEach((b) => b.onclick = () => { vals = vals.filter((_, i) => i !== +b.dataset.x); onChange(vals); draw(); });
  };
  draw();
  return () => vals;
}

const LOCATION_SUGGESTIONS = (q, taken) => suggestPlaces(q, taken); // worldwide: see public/places.js
const POSITION_SUGGESTIONS = ['Software Engineer Intern', 'Software Developer', 'New Grad Software Engineer', 'Backend Engineer', 'Frontend Engineer', 'Full Stack Developer', 'Mobile Developer', 'DevOps Engineer', 'Data Engineer',
  'Data Analyst', 'Data Scientist', 'Machine Learning Engineer', 'AI Engineer', 'Business Intelligence Analyst', 'Product Manager', 'Associate Product Manager', 'UX Designer', 'Product Designer', 'Cybersecurity Analyst', 'IT Support',
  'Investment Banking Analyst', 'Investment Banking Summer Analyst', 'Finance Intern', 'Financial Analyst', 'Equity Research', 'Private Equity', 'Venture Capital', 'Corporate Finance', 'FP&A Analyst', 'Capital Markets', 'Wealth Management', 'Asset Management', 'Risk Analyst', 'Credit Analyst', 'Treasury Analyst', 'Quantitative Analyst', 'Trader',
  'Accounting Intern', 'Staff Accountant', 'Audit Associate', 'Tax Associate', 'Business Analyst', 'Management Consultant', 'Strategy Analyst', 'Operations Analyst', 'Supply Chain Analyst', 'Project Coordinator', 'Project Manager',
  'Marketing Intern', 'Marketing Coordinator', 'Digital Marketing', 'Social Media Coordinator', 'Content Writer', 'Communications', 'Public Relations', 'Brand Associate', 'Growth Marketing', 'SEO Specialist',
  'Sales Development Representative', 'Account Executive', 'Business Development', 'Customer Success', 'Account Manager', 'Recruiter', 'HR Coordinator', 'People Operations',
  'Mechanical Engineer', 'Electrical Engineer', 'Civil Engineer', 'Chemical Engineer', 'Industrial Engineer', 'Manufacturing Engineer', 'Embedded Systems Engineer', 'Hardware Engineer', 'Energy Analyst',
  'Research Assistant', 'Lab Technician', 'Policy Analyst', 'Legal Assistant', 'Paralegal', 'Healthcare Administration', 'Teacher', 'Graphic Designer', 'Video Editor', 'Architect'];

// ---------- Chat with Joblin ----------
let chatOpen = false;
function toggleChat(force) {
  chatOpen = force ?? !chatOpen;
  document.body.classList.toggle('chat-open', chatOpen);
  $('#chat').hidden = !chatOpen;
  $('#chatFab')?.classList.toggle('hide', chatOpen);
  if (chatOpen) { loadChat(); setTimeout(() => $('#chatIn')?.focus(), 50); }
}
const CHAT_STARTERS = ['Software engineering internships, remote is fine', 'Finance and investment banking roles in New York or London', 'Only apply to Stripe, Shopify and Wise', 'Marketing internships, remote is fine', 'Start a search now'];
async function loadChat() {
  const msgs = await api('/chat');
  const box = $('#chatMsgs');
  box.innerHTML = (msgs.length ? '' : `<div class="cmsg joblin"><img src="/img/joblin-logo-64.png" alt=""><div>Heh, hello! I’m Joblin, your job goblin. Tell me what to hunt — roles, places, companies — and I’ll scurry off and drag back applications. Say “start” and I go with what you’ve already set up.</div></div>`)
    + msgs.map((m) => `<div class="cmsg ${m.role}">${m.role === 'joblin' ? '<img src="/img/joblin-logo-64.png" alt="">' : ''}<div>${esc(m.text)}${m.meta?.changes?.length ? `<div class="cchanges">${m.meta.changes.map((c) => `<span>${esc(c)}</span>`).join('')}</div>` : ''}</div></div>`).join('');
  $('#chatStarters').innerHTML = msgs.length > 2 ? '' : CHAT_STARTERS.map((s) => `<button class="chip" data-s="${esc(s)}">${esc(s)}</button>`).join('');
  $$('#chatStarters [data-s]').forEach((b) => b.onclick = () => sendChat(b.dataset.s));
  box.scrollTop = box.scrollHeight;
}
async function sendChat(text) {
  text = String(text ?? $('#chatIn').value).trim(); if (!text) return;
  $('#chatIn').value = '';
  const box = $('#chatMsgs');
  box.insertAdjacentHTML('beforeend', `<div class="cmsg user"><div>${esc(text)}</div></div><div class="cmsg joblin typing"><img src="/img/joblin-logo-64.png" alt=""><div><span class="dots"><i></i><i></i><i></i></span></div></div>`);
  box.scrollTop = box.scrollHeight;
  try { const r = await api('/chat', { method: 'POST', body: { message: text } }); if (r.started) refreshSummary(); await loadSettings().catch(() => {}); }
  catch (e) { toast(e.message, true); }
  loadChat();
}
function mountChat() {
  const el = document.createElement('aside');
  el.id = 'chat'; el.hidden = true; el.setAttribute('aria-label', 'Chat with Joblin');
  el.innerHTML = `<div class="chat-h"><img src="/img/joblin-logo-64.png" alt=""><div><b>Joblin</b><span class="muted">Your job goblin</span></div>
      <button class="btn sm ghost" id="chatClear" title="Clear conversation">Clear</button><button class="btn sm ghost" id="chatClose" aria-label="Close chat">✕</button></div>
    <div class="chat-msgs" id="chatMsgs"></div><div class="chips chat-starters" id="chatStarters"></div>
    <form class="chat-f" id="chatForm"><textarea id="chatIn" rows="2" placeholder="e.g. Finance internships in London or New York"></textarea><button class="btn primary" type="submit">Send</button></form>`;
  document.body.appendChild(el);
  // Always-there launcher: Joblin's face in a circle, bottom right.
  const fab = document.createElement('button');
  fab.id = 'chatFab'; fab.type = 'button'; fab.setAttribute('aria-label', 'Chat with Joblin'); fab.title = 'Chat with Joblin';
  fab.innerHTML = '<img src="/img/joblin-logo-64.png" alt="">';
  fab.onclick = () => toggleChat(true);
  document.body.appendChild(fab);
  $('#chatClose').onclick = () => toggleChat(false);
  $('#chatClear').onclick = async () => { await api('/chat', { method: 'DELETE' }); loadChat(); };
  $('#chatForm').onsubmit = (e) => { e.preventDefault(); sendChat(); };
  $('#chatIn').onkeydown = (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); } };
}

// ---------- Progress for both workers ----------
function workBars() {
  const W = S.system.workers || {};
  const bar = (label, p, extra = '') => `<div class="wbar"><div class="wl"><span>${label}</span><span class="muted">${p?.total ? `${p.done} / ${p.total}` : ''}</span></div>
    <div class="pbar"><i style="width:${p?.total ? Math.round((p.done / p.total) * 100) : 6}%"></i></div>${p?.current ? `<div class="meta">${esc(p.current)}</div>` : extra}</div>`;
  const out = [];
  if (W.find?.state) out.push(bar(W.find.detail || 'Finding jobs', W.find.progress, W.find.found ? `<div class="meta">${W.find.found} new jobs found</div>` : ''));
  if (W.apply?.state) out.push(bar('Applying', W.apply.progress));
  const q = S.byStatus || {};
  const queue = [q.approved ? `${q.approved} approved, waiting to send` : '', q.pending_approval ? `${q.pending_approval} ready for your review` : '', S.pendingAnswers ? `${S.pendingAnswers} question${S.pendingAnswers === 1 ? '' : 's'} waiting on you` : ''].filter(Boolean);
  if (queue.length) out.push(`<div class="queue">${queue.map((x) => `<span class="pill plain">${esc(x)}</span>`).join('')}</div>`);
  return out.join('');
}

let S = {}; // summary
let SET = null; // settings
const state = { review: { items: [], sel: new Set(), active: null, filter: 'all' }, apps: { q: '', status: '', track: '' }, emailFilter: '', settingsTab: 'integrations' };

// ---------- Shell ----------
const TITLES = { dashboard: 'Dashboard', review: 'Review batch', applications: 'Applications', outreach: 'Outreach', tasks: 'Tasks', answers: 'Questions', memory: 'Memory', settings: 'Settings' };
const route = () => (location.hash.replace('#/', '') || 'dashboard').split('?')[0];

// A soft two-note ding when a new question needs your answer (plays after you've clicked anywhere once).
let lastPending = null, audioCtx = null;
document.addEventListener('pointerdown', () => { try { audioCtx ??= new AudioContext(); audioCtx.resume(); } catch {} }, { once: true });
function ding() {
  try {
    audioCtx ??= new AudioContext();
    const t0 = audioCtx.currentTime;
    for (const [f, at] of [[880, 0], [1320, 0.12]]) {
      const o = audioCtx.createOscillator(), g = audioCtx.createGain();
      o.type = 'sine'; o.frequency.value = f; o.connect(g); g.connect(audioCtx.destination);
      g.gain.setValueAtTime(0.0001, t0 + at); g.gain.exponentialRampToValueAtTime(0.18, t0 + at + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
      o.start(t0 + at); o.stop(t0 + at + 0.5);
    }
  } catch {}
}

async function refreshSummary() {
  S = await api('/summary');
  const sys = S.system;
  $('#reviewBadge').hidden = !S.pendingReview; $('#reviewBadge').textContent = S.pendingReview;

  $('#qBadge').hidden = !S.pendingAnswers; $('#qBadge').textContent = S.pendingAnswers;
  if (lastPending !== null && S.pendingAnswers > lastPending) ding();
  lastPending = S.pendingAnswers;
  $('#sideFoot').innerHTML = `
    <div class="conn"><span class="dot ${sys.linkedin?.connected ? 'ok' : ''}"></span>LinkedIn ${sys.linkedin?.connected ? 'connected' : 'not connected'}</div>
    <div class="conn"><span class="dot ${sys.gmail || sys.gmailWeb?.connected ? 'ok' : ''}"></span>Gmail ${sys.gmail ? 'connected' : sys.gmailWeb?.connected ? 'reading codes' : 'not connected'}</div>
    <div class="conn"><span class="dot ${sys.llm ? 'ok' : 'bad'}"></span>${sys.llmProvider === 'ollama' ? 'Local model' : esc(sys.llmModel)} ${sys.llm ? 'ready' : 'not ready'}</div>
    <div class="conn"><span class="dot ${sys.mode.type === 'autopilot' ? 'ok' : ''}"></span>${sys.mode.type === 'autopilot' ? 'Autopilot on' : 'Review mode'}</div>`;
  const w = sys.worker;
  const WK = sys.workers || {};
  const chip = (x, label, w) => x?.state ? `<button type="button" class="wk" data-stop="${w}" title="Click to stop"><span class="spin"></span><span class="wk-l">${esc(/Stopping/.test(x.detail || '') ? x.detail : label || x.detail || 'Working')}${x.progress?.total ? ` ${x.progress.done}/${x.progress.total}` : ''}</span><span class="wk-stop">Stop</span></button>` : '';
  $('#worker').innerHTML = chip(WK.find, null, 'find') + chip(WK.apply, 'Applying', 'apply');
  $$('#worker [data-stop]').forEach((b) => b.onclick = async (e) => {
    e.stopPropagation();
    const w = b.dataset.stop;
    if (!(await ask({ title: w === 'apply' ? 'Stop applying?' : 'Stop this search?', ok: 'Stop', danger: true,
      body: w === 'apply' ? 'Joblin finishes the application it’s on (so nothing is left half-sent), then pauses. Approving or retrying anything starts it again.' : 'Joblin stops after the job it’s checking. Anything already found stays in Review batch.' }))) return;
    await api('/stop', { method: 'POST', body: { worker: w } }); toast(w === 'apply' ? 'Applying will pause after this one' : 'Search stopped'); refreshSummary();
  });
  $('#worker').style.cursor = w?.state ? 'pointer' : '';
  let sf = $('#showForm');
  if (sys.formWaiting && !sf) {
    sf = document.createElement('button'); sf.id = 'showForm'; sf.className = 'btn';
    sf.textContent = 'Show the form'; sf.title = 'A filled application is waiting for you in Joblin’s hidden Chrome window';
    sf.onclick = () => api('/browser/show', { method: 'POST', body: {} });
    $('#runBtn').before(sf);
  } else if (!sys.formWaiting && sf) sf.remove();
  $('#worker').onclick = () => w?.state && (location.hash = '#/review');
  $('#runBtn').textContent = 'Ask Joblin';
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
$('#runBtn').onclick = () => toggleChat();
const startSearch = async () => {
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
  const [apps, events] = await Promise.all([api('/applications'), api('/events')]);
  const needs = apps.filter((a) => ['needs_review', 'manual', 'failed'].includes(a.status)).slice(0, 6);
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
      <section class="panel"><div class="panel-h"><h2>Needs you</h2><div class="right"><a class="link" href="#/applications">Applications</a></div></div>
        <div class="list" style="margin-top:8px">
          ${S.pendingAnswers ? `<div class="li"><span class="prio p1"></span><div><div class="t"><a class="link" href="#/answers">Answer ${S.pendingAnswers} question${S.pendingAnswers === 1 ? '' : 's'}</a></div><div class="d">Applications are waiting on these. They go through as soon as you answer.</div></div></div>` : ''}
          ${needs.map((a) => `<div class="li"><span class="prio p2"></span>${mono(a.company)}<div style="min-width:0"><div class="t"><a class="link" href="#/applications">${esc(a.title)}</a></div><div class="d">${esc(a.company)} · ${esc((a.notes || STATUS[a.status]?.[0] || '').slice(0, 110))}</div></div></div>`).join('')}
          ${!needs.length && !S.pendingAnswers ? '<div class="empty">Nothing needs you right now.</div>' : ''}</div></section>
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
  const W = S.system.workers || {};
  if (!W.find?.state && !W.apply?.state) return '';
  const title = W.find?.state && W.apply?.state ? 'Joblin is finding jobs and applying' : W.apply?.state ? 'Joblin is applying' : W.find?.phase === 'prepare' ? 'Joblin is writing your applications' : 'Joblin is looking for jobs';
  return `<section class="panel work" aria-live="polite"><img src="/img/joblin-working.png" alt="Joblin at his desk, working">
    <div><h2>${title}</h2><div class="muted">It runs in the background. Keep working; approved jobs are sent as soon as they’re ready.</div>
    <div class="wbars">${workBars()}</div></div></section>`;
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
      <button class="btn primary" id="go">Tell Joblin what to look for</button></div></section>`;
    $('#go')?.addEventListener('click', () => toggleChat(true)); return;
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
    <span class="muted">Unchecked jobs stay here for later. Use Skip on any job you’re not sure about.</span>
    <div class="right"><button class="btn primary" id="applyBtn">Apply to ${R.sel.size}</button></div></div>`;
  const sync = () => { $('#selCount').textContent = R.sel.size; $('#applyBtn').textContent = `Apply to ${R.sel.size}`; $('#applyBtn').disabled = !R.sel.size; };
  sync();
  $$('#rf button').forEach((b) => b.onclick = () => { R.filter = b.dataset.f; render(); });
  $('#selAll').onclick = () => { shown.forEach((i) => R.sel.add(i.id)); render(); };
  $('#selNone').onclick = () => { R.sel.clear(); render(); };
  $$('[data-sel]').forEach((c) => { c.onclick = (ev) => ev.stopPropagation(); c.onchange = () => { c.checked ? R.sel.add(+c.dataset.sel) : R.sel.delete(+c.dataset.sel); sync(); }; });
  $$('.ritem').forEach((el) => el.onclick = () => { R.active = +el.dataset.id; $$('.ritem').forEach((x) => x.classList.toggle('on', x === el)); renderDetail(); });
  $('#applyBtn').onclick = async () => {
    const approve = [...R.sel], skip = [];
    const chosen = R.items.filter((i) => R.sel.has(i.id));
    if (!(await ask({ title: `Apply to ${approve.length} ${approve.length === 1 ? 'job' : 'jobs'}?`, image: '/img/joblin-working.png', ok: `Apply to ${approve.length}`,
      body: `Joblin applies in the background, one after another. Jobs you didn’t check stay here for later.`,
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
          <button class="btn sm ghost danger" id="skipOne">Skip this job</button>
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
    $('#skipOne').onclick = async () => { await api('/review/decide', { method: 'POST', body: { approve: [], skip: [i.id] } }); R.sel.delete(i.id); toast('Skipped — find it under Applications → Skipped'); refreshSummary(); render(); };
    $('#swapTrack').onclick = () => regen({ track: i.track === 'swe' ? 'finance' : 'swe' }, 'Rebuilding with the other resume…');
  }
};

// ---------- Applications ----------
// Status is set by Joblin (Applied, Needs you, In queue…). You only mark outcomes: interview, offer, rejected, withdrawn, skip.
const APP_FILTERS = [
  ['all', 'All', () => true],
  ['applied', 'Applied', (s) => ['submitted', 'interview', 'offer'].includes(s)],
  ['needs', 'Needs you', (s) => ['needs_review', 'manual', 'failed'].includes(s)],
  ['queue', 'In queue', (s) => ['approved', 'queued'].includes(s)],
  ['review', 'For review', (s) => s === 'pending_approval'],
  ['skipped', 'Skipped', (s) => ['skipped', 'duplicate', 'withdrawn'].includes(s)],
  ['rejected', 'Rejected', (s) => s === 'rejected'],
];
const OUTCOMES = [['submitted', 'Applied'], ['interview', 'Interview'], ['offer', 'Offer'], ['rejected', 'Rejected'], ['withdrawn', 'Withdrawn'], ['skipped', 'Skip this job']];
const statusClass = (s) => (['submitted', 'interview', 'offer'].includes(s) ? 'good' : ['approved', 'pending_approval', 'queued'].includes(s) ? 'accent' : ['needs_review', 'manual'].includes(s) ? 'warn' : ['failed', 'rejected'].includes(s) ? 'bad' : '');

VIEWS.applications = async (view) => {
  const [rows, { tracks }] = await Promise.all([api('/applications'), api('/tracks')]); const A = state.apps;
  A.filter ??= 'all'; A.track ??= '';
  // Filter by kind of job (the resume each one uses): only types that have applications are offered.
  const label = (id) => tracks.find((t) => t.id === id)?.label || id;
  const types = [...new Set(rows.map((r) => r.track).filter(Boolean))].sort((a, b) => label(a).localeCompare(label(b)));
  if (A.track && !types.includes(A.track)) A.track = '';
  const count = (k) => rows.filter((r) => APP_FILTERS.find((f) => f[0] === k)[2](r.status)).length;
  const retryable = rows.filter((r) => ['skipped', 'failed', 'needs_review'].includes(r.status)).length;
  view.innerHTML = `
  <div class="toolbar">
    <div class="seg filters" id="af">${APP_FILTERS.map(([k, l]) => `<button data-f="${k}" class="${A.filter === k ? 'on' : ''}">${l}<span class="n">${count(k)}</span></button>`).join('')}</div>
    <button class="btn" id="retryAll" style="margin-left:auto" ${retryable ? '' : 'disabled'} title="Send everything skipped, failed or stuck back through">Retry all${retryable ? ` (${retryable})` : ''}</button>
  </div>
  <div class="toolbar"><input type="search" id="q" placeholder="Search company or role" value="${esc(A.q)}">
    <select id="tf" aria-label="Kind of job" style="width:auto"><option value="">All kinds of jobs</option>${types.map((t) => `<option value="${esc(t)}" ${A.track === t ? 'selected' : ''}>${esc(label(t))} (${rows.filter((r) => r.track === t).length})</option>`).join('')}</select></div>
  <div class="panel tablewrap" id="appBox"><div class="selbar"><label style="display:flex;gap:8px;align-items:center"><input type="checkbox" data-pickall>Select all</label><span class="muted" data-count></span>
    <div style="margin-left:auto;display:flex;gap:8px;align-items:center"><button class="btn sm" data-needsel id="bRetry">Try again</button>
      <select id="bMark" data-needsel aria-label="Mark selected as" style="width:auto"><option value="">Mark as…</option>${OUTCOMES.map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select>
      <button class="btn sm ghost danger" data-needsel id="bRemove">Remove</button></div></div>
    <table><thead><tr><th style="width:28px"></th><th>Role</th><th>Fit</th><th>Status</th><th>Documents</th><th>Updated</th></tr></thead><tbody id="rows"></tbody></table></div>`;
  let picked = () => [];
  const docs = (r) => r.resume_path ? `<a class="link" target="_blank" href="${fileUrl(r.resume_path)}">Resume</a> · <a class="link" target="_blank" href="${fileUrl(r.cover_letter_path)}">Letter</a>` : '—';
  const draw = () => {
    const pass = APP_FILTERS.find((f) => f[0] === A.filter)[2];
    const f = rows.filter((r) => pass(r.status) && (!A.track || r.track === A.track) && (!A.q || `${r.company} ${r.title}`.toLowerCase().includes(A.q.toLowerCase())));
    $('#rows').innerHTML = f.map((r) => `<tr>
      <td><input type="checkbox" data-pick="${r.id}" aria-label="Select ${esc(r.title)}"></td>
      <td><div style="display:flex;gap:12px">${mono(r.company)}<div><a class="link" href="${esc(r.apply_url || r.linkedin_url)}" target="_blank" rel="noopener">${esc(r.title)}</a><div class="sub">${esc(r.company)}${r.location ? ` · ${esc(r.location)}` : ''}</div>${r.notes && !['submitted'].includes(r.status) ? `<div class="sub">${esc(r.notes.slice(0, 160))}</div>` : ''}</div></div></td>
      <td>${scoreBadge(r.match_score)}</td>
      <td><div class="stcell">${pill(r.status).replace('class="pill', `class="pill ${statusClass(r.status)}`)}
        <select class="mark" data-id="${r.id}" aria-label="Mark as"><option value="">Mark as…</option>${OUTCOMES.filter(([k]) => k !== r.status).map(([k, l]) => `<option value="${k}">${l}</option>`).join('')}</select></div></td>
      <td class="sub" style="white-space:nowrap">${r.proof_path ? `<div><a class="link" target="_blank" href="${fileUrl(r.proof_path, Date.now())}">${r.status === 'submitted' ? 'Confirmation' : 'What happened'}</a></div>` : ''}<div>${docs(r)}</div>
        ${['needs_review', 'failed', 'skipped'].includes(r.status) ? `<div style="margin-top:6px"><button class="btn sm" data-retry="${r.id}">${r.status === 'skipped' ? 'Apply anyway' : 'Try again'}</button></div>` : ''}</td>
      <td class="sub">${when(r.updated_at)}</td></tr>`).join('') || `<tr><td colspan="6"><div class="empty"><b>Nothing here</b>${A.filter === 'all' ? 'Tell Joblin what to look for and applications will show up here.' : 'No applications in this group.'}</div></td></tr>`;
    $$('[data-retry]').forEach((b) => b.onclick = async () => {
      const r = await api(`/applications/${b.dataset.retry}/retry`, { method: 'POST', body: {} });
      toast(r.started ? 'Joblin is applying in the background' : 'In the queue — it goes right after the current one'); refreshSummary(); render();
    });
    $$('select.mark').forEach((sel) => sel.onchange = async () => {
      if (!sel.value) return;
      await api(`/applications/${sel.dataset.id}`, { method: 'PATCH', body: { status: sel.value } });
      toast(`Marked as ${OUTCOMES.find((o) => o[0] === sel.value)[1].toLowerCase()}`); refreshSummary(); render();
    });
    const all = $('[data-pickall]', view); if (all) { all.checked = false; all.indeterminate = false; }
    picked = selectable($('#appBox'));
  };
  const bulk = async (action, extra = {}) => {
    const ids = picked(); if (!ids.length) return;
    const r = await api('/applications/bulk', { method: 'POST', body: { ids, action, ...extra } });
    return { ids, r };
  };
  $('#bRetry').onclick = async () => { const x = await bulk('retry'); if (x) { toast(`${x.r.count} back in the queue`); refreshSummary(); render(); } };
  $('#bMark').onchange = async (e) => {
    const v = e.target.value; if (!v) return;
    const x = await bulk('status', { status: v });
    if (x) { toast(`Marked ${x.ids.length} as ${(v === 'submitted' ? 'applied' : OUTCOMES.find((o) => o[0] === v)[1]).toLowerCase()}`); refreshSummary(); render(); }
  };
  $('#bRemove').onclick = async () => {
    const n = picked().length;
    if (!(await ask({ title: `Remove ${n} application${n === 1 ? '' : 's'}?`, body: 'They disappear from Joblin and won’t be found again in later searches.', ok: 'Remove', danger: true }))) return;
    const x = await bulk('remove'); if (x) { toast(`Removed ${x.ids.length}`); refreshSummary(); render(); }
  };
  $$('#af button').forEach((b) => b.onclick = () => { A.filter = b.dataset.f; $$('#af button').forEach((x) => x.classList.toggle('on', x === b)); draw(); });
  $('#q').oninput = (e) => { A.q = e.target.value; draw(); };
  $('#tf').onchange = (e) => { A.track = e.target.value; draw(); };
  $('#retryAll').onclick = async () => {
    if (!(await ask({ title: `Retry ${retryable} application${retryable === 1 ? '' : 's'}?`, image: '/img/joblin-working.png', ok: 'Retry all',
      body: 'Everything skipped, failed or stuck goes back in the queue and Joblin applies in the background. Applications waiting on one of your answers stay put until you answer.' }))) return;
    const r = await api('/applications/retry-all', { method: 'POST', body: {} });
    toast(`${r.count} back in the queue`); refreshSummary(); render();
  };
  draw();
};

// ---------- Outreach ----------
VIEWS.outreach = async (view) => {
  const rows = await api('/emails'); const sys = S.system; if (!SET) await loadSettings();
  view.innerHTML = `
  <div class="toolbar">
    <div class="seg" id="ef">${[['', 'All'], ['scheduled', 'Scheduled'], ['sent', 'Sent'], ['replied', 'Replied'], ['bounced', 'Bounced']].map(([k, l]) => `<button data-f="${k}" class="${state.emailFilter === k ? 'on' : ''}">${l}</button>`).join('')}</div>
    <span class="muted">${S.emails.today} of ${S.emails.cap} sent today</span>
    <button class="btn sm" id="findPeople" style="margin-left:auto" title="Look up recruiters and team leads for applications you've sent">Find people</button>
    <button class="btn sm" id="pause">${sys.emailPaused ? 'Resume sending' : 'Pause sending'}</button></div>
  ${!rows.length ? `<section class="panel hello" style="margin-bottom:14px"><img src="/img/joblin-mailbox.png" alt="Joblin looking into an empty mailbox">
    <div><h2>No outreach yet</h2><div class="muted">After an application goes in, Joblin emails the recruiters or hiring managers for that job, then follows up once if they don't reply.</div>
    <div class="checks">
      <div><span class="dot ${sys.gmail ? 'ok' : ''}"></span>${sys.gmail ? `Sending from ${esc(sys.gmailUser)}` : '<a class="link" href="#/settings" id="toInteg">Connect Gmail</a> so Joblin can send'}</div>
      <div><span class="dot ${S.submitted ? 'ok' : ''}"></span>${S.submitted} applications sent — emails start after each one</div>
      <div><span class="dot ${S.contacts ? 'ok' : ''}"></span>${S.contacts} people found. ${sys.linkedin?.connected ? 'Joblin finds recruiters and team leads on LinkedIn and works out their email from the company’s own address pattern.' : '<a class="link" href="#/settings">Connect LinkedIn</a> so Joblin can find recruiters and team leads.'}</div>
    </div></div></section>` : !sys.gmail ? `<div class="panel" style="padding:14px 18px;margin-bottom:14px">Emails are queued but won't send until you connect Gmail. <a class="link" href="#/settings" id="toInteg">Connect Gmail</a></div>` : ''}
  <div class="panel tablewrap" ${rows.length ? '' : 'hidden'}><table><thead><tr><th>Contact</th><th>Company</th><th>Email</th><th>Status</th><th>When</th><th></th></tr></thead><tbody>
  ${rows.filter((r) => !state.emailFilter || r.status === state.emailFilter).map((r) => `<tr>
    <td>${r.linkedin ? `<a class="link" href="${esc(r.linkedin)}" target="_blank" rel="noopener">${esc(r.name || '—')}</a>` : esc(r.name || '—')}<div class="sub">${esc(r.email)}${r.source === 'guessed' ? ' · likely address' : r.source === 'pattern' ? ' · their address pattern' : r.source === 'hunter' ? ' · verified' : ''}</div></td>
    <td>${esc(r.company)}<div class="sub">${esc(r.title)}</div></td>
    <td><details><summary class="sub" style="cursor:pointer">${r.kind === 'followup' ? 'Follow-up' : 'Intro'}: ${esc(r.subject)}</summary><div class="sub" style="white-space:pre-wrap;margin-top:8px;max-width:520px">${esc(r.body)}</div></details>
      ${r.reply_snippet ? `<div class="sub" style="margin-top:6px;color:var(--ink-2)">“${esc(r.reply_snippet.slice(0, 160))}”</div>` : ''}${r.error ? `<div class="sub" style="color:var(--bad)">${esc(r.error)}</div>` : ''}</td>
    <td>${pill(r.status)}</td><td class="sub">${when(r.replied_at || r.sent_at || r.scheduled_at)}</td>
    <td>${r.status === 'scheduled' ? `<button class="btn sm ghost" data-cancel="${r.id}">Cancel</button>` : ''}</td></tr>`).join('') || `<tr><td colspan="6"><div class="empty"><b>No outreach yet</b>Emails are written after each application goes in.</div></td></tr>`}
  </tbody></table></div>`;
  $$('#ef button').forEach((b) => b.onclick = () => { state.emailFilter = b.dataset.f; render(); });
  $('#findPeople').onclick = async (ev) => {
    const b = ev.currentTarget; b.disabled = true; b.textContent = 'Finding people…';
    const r = await api('/outreach/find', { method: 'POST', body: {} });
    if (!r.started) { toast(r.running ? 'Already looking — new people show up here as they’re found' : 'Every sent application already has people'); b.disabled = false; b.textContent = 'Find people'; return; }
    toast(`Looking up people for ${r.count} application${r.count === 1 ? '' : 's'} — this takes a few minutes`);
    const t = setInterval(async () => { const f = await api('/outreach/finding'); if (!f.running) { clearInterval(t); toast('Done finding people'); if (route() === 'outreach') render(); } }, 5000);
  };
  $('#pause').onclick = async () => { await api('/email/pause', { method: 'POST', body: { paused: !sys.emailPaused } }); await refreshSummary(); render(); };
  $('#toInteg')?.addEventListener('click', () => (state.settingsTab = 'integrations'));
  $$('[data-cancel]').forEach((b) => b.onclick = async () => { await api(`/emails/${b.dataset.cancel}/cancel`, { method: 'POST', body: {} }); render(); });
};

// ---------- Tasks ----------
VIEWS.tasks = async (view) => { location.hash = '#/applications'; return;
  const tasks = await api('/tasks');
  view.innerHTML = `<div class="panel"><div class="panel-b" style="display:flex;gap:8px"><input type="text" id="newTask" placeholder="Add a task"><button class="btn" id="addTask">Add task</button></div>
    <div class="list">${tasks.map(taskRow).join('') || '<div class="empty">No tasks.</div>'}</div></div>`;
  const add = async () => { const v = $('#newTask').value.trim(); if (!v) return; await api('/tasks', { method: 'POST', body: { title: v, priority: 2 } }); refreshSummary(); render(); };
  $('#addTask').onclick = add; $('#newTask').onkeydown = (e) => e.key === 'Enter' && add();
  bindTasks(view);
};

// ---------- Settings ----------
async function loadSettings() { const r = await api('/settings'); SET = r.settings; return r; }
const saveSettings = async (patch, msg = 'Saved') => { const quiet = autosaving; const r = await api('/settings', { method: 'PUT', body: patch }); SET = r.settings; toast(quiet ? 'Saved' : msg); refreshSummary(); };
const sw = (id, on) => `<label class="switch"><input type="checkbox" id="${id}" ${on ? 'checked' : ''}><span></span></label>`;

VIEWS.settings = async (view) => {
  const { suggested } = await loadSettings();
  const tabs = [['integrations', 'Integrations'], ['ai', 'AI model'], ['sources', 'Job sources'], ['positions', 'Positions'], ['automation', 'Automation'], ['resumes', 'Resumes'], ['cover', 'Cover letter'], ['profile', 'Profile'], ['email', 'Email outreach']];
  view.innerHTML = `<div class="settings"><div class="stabs">${tabs.map(([k, l]) => `<button data-t="${k}" class="${state.settingsTab === k ? 'on' : ''}">${l}</button>`).join('')}</div><div class="spane" id="spane"></div></div>`;
  $$('.stabs button').forEach((b) => b.onclick = () => { state.settingsTab = b.dataset.t; render(); });
  await SETTINGS[state.settingsTab]($('#spane'), suggested);
  autosave($('#spane'), state.settingsTab);
};

// Every change in Settings saves by itself, a moment after you stop typing (no Save button needed).
// AI model, Integrations and Resumes save through their own buttons and editors.
let autosaving = false;
function autosave(pane, tab) {
  if (['ai', 'integrations', 'resumes'].includes(tab)) return;
  const btn = $('button.btn.primary[id^="save"]', pane);
  if (!btn) return;
  btn.textContent = 'Changes save automatically'; btn.classList.remove('primary'); btn.classList.add('ghost'); btn.disabled = true;
  let t;
  const fire = (e) => {
    if (e.target.closest?.('.ci, #factText, #coIn, #pvGo')) return; // typing a new chip or company isn't a change yet
    clearTimeout(t);
    t = setTimeout(() => { if (!pane.isConnected) return; autosaving = true; btn.disabled = false; btn.click(); btn.disabled = true; setTimeout(() => (autosaving = false), 50); }, 700);
  };
  pane.addEventListener('input', fire);
  pane.addEventListener('change', fire);
}

const SETTINGS = {};
// One line that says where Gmail stands, in plain words.
function gmailLine(sys) {
  const g = sys.gmailWeb || {};
  if (sys.gmail) return `Connected as ${esc(sys.gmailUser)}. Joblin sends your outreach, watches for replies, and types in the security codes job sites email you.`;
  if (g.note === 'waiting for sign-in') return 'Sign in to Google in the Joblin window. It closes by itself when you’re done.';
  if (g.note === 'setting up sending') return 'Signed in. Joblin is setting up sending on Google’s App passwords page — if Google asks for your password again, type it in the Joblin window.';
  if (g.connected) return `Signed in${g.email ? ` as ${esc(g.email)}` : ''}: Joblin types in emailed security codes. ${g.note && g.note !== 'sending not set up' ? esc(g.note[0].toUpperCase() + g.note.slice(1)) + '.' : 'Sending emails isn’t set up yet — press Connect Gmail again, or paste an app password below.'}`;
  return `One click: sign in to Google once and Joblin handles the rest — security codes, outreach emails and replies.${g.note && !/disconnected/.test(g.note) ? ` <span style="color:var(--warn)">(${esc(g.note)})</span>` : ''}`;
}
SETTINGS.integrations = async (el) => {
  const sys = S.system;
  el.innerHTML = `
  <section class="panel panel-b"><div class="integ"><div class="ico">${logoTile('/img/brands/linkedin.svg', 'LinkedIn')}</div>
    <div><div class="name">LinkedIn</div><div class="muted" style="font-size:13px">${sys.linkedin?.connected ? `Connected${sys.linkedin.note ? ` as ${esc(sys.linkedin.note)}` : ''}. Joblin searches LinkedIn for jobs and the people who posted them.` : sys.linkedin?.note === 'waiting for sign-in' ? 'Sign in in the LinkedIn window. It closes by itself once you’re in.' : `Optional. Sign in once in a Joblin window — your password never touches Joblin.${sys.linkedin?.note ? ` (${esc(sys.linkedin.note)})` : ''}`}</div></div>
    ${sys.linkedin?.connected ? `<button class="btn danger" id="liOff">Disconnect</button>` : `<button class="btn primary" id="liOn">Connect LinkedIn</button>`}</div></section>

  <section class="panel panel-b"><div class="integ"><div class="ico">${logoTile('/img/brands/gmail.svg', 'Gmail')}</div>
    <div><div class="name">Gmail</div><div class="muted" id="gmLine" style="font-size:13px">${gmailLine(sys)}</div></div>
    ${sys.gmail ? '<button class="btn danger" id="gmOff">Disconnect</button>'
      : sys.gmailWeb?.note === 'waiting for sign-in' || sys.gmailWeb?.note === 'setting up sending' ? '<button class="btn" disabled>Connecting…</button>'
      : '<button class="btn primary" id="gwOn">Connect Gmail</button>'}</div>
    ${sys.gmail ? '' : `<details class="alt"><summary>Or paste an app password instead</summary>
      <ol class="steps"><li>Turn on 2-Step Verification for your Google account.</li><li>Open <a class="link" href="https://myaccount.google.com/apppasswords" target="_blank" rel="noopener">App passwords</a>, create one called “Joblin”, and copy the 16 letters.</li><li>Paste it below.</li></ol>
      <div class="grid2" style="margin-top:12px"><label class="f">Gmail address<input type="email" id="gmUser" placeholder="you@gmail.com" autocomplete="off"></label>
      <label class="f">App password<input type="password" id="gmPass" placeholder="xxxx xxxx xxxx xxxx" autocomplete="off"></label></div>
      <div style="margin-top:12px"><button class="btn" id="gmOn">Test and connect</button></div></details>`}</section>

  <section class="panel panel-b"><div class="integ"><div class="ico">${logoTile(PROVIDER_ICONS[sys.llmProvider || 'ollama']?.img || '/img/ai/ollama.webp', 'AI model')}</div>
    <div><div class="name">Local model</div><div class="muted" style="font-size:13px">${sys.llmProvider === 'ollama' ? (sys.llm ? `Running ${esc(SET.llm.model)} in Ollama on this Mac. Free.` : 'Ollama isn’t responding. Start it with: brew services start ollama') : `Using ${esc(sys.llmModel)} with your API key.`} <a class="link" href="#" id="toAi">Change model</a></div></div>
    <span class="pill ${sys.llm ? 'good' : 'bad'}">${sys.llm ? 'Ready' : 'Not ready'}</span></div></section>

  <section class="panel panel-b"><div class="integ"><div class="ico">H</div>
    <div><div class="name">Hunter.io <span class="muted" style="font-weight:400">optional</span></div><div class="muted" style="font-size:13px">Not needed: Joblin finds people on LinkedIn and works out their addresses itself. A Hunter key only double-checks addresses so even fewer bounce. The free plan covers 25 lookups a month.</div></div><span></span></div>
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
  $('#gmOff')?.addEventListener('click', async () => { if (!(await ask({ title: 'Disconnect Gmail?', body: 'Queued emails wait until you reconnect, and Joblin stops entering emailed codes.', ok: 'Disconnect', danger: true }))) return; await api('/integrations/gmail', { method: 'DELETE' }); await api('/integrations/gmail-web/disconnect', { method: 'POST', body: {} }); await refreshSummary(); render(); });
  $('#gwOn')?.addEventListener('click', async (ev) => {
    try { const r = await api('/integrations/gmail-web/connect', { method: 'POST', body: {} }); toast(r.message); ev.target.disabled = true; ev.target.textContent = 'Connecting…';
      let n = 0; const t = setInterval(async () => { await refreshSummary(); const g = S.system.gmailWeb || {};
        if ($('#gmLine')) $('#gmLine').innerHTML = gmailLine(S.system);
        if (!['waiting for sign-in', 'setting up sending'].includes(g.note) || ++n > 300) { clearInterval(t); toast(S.system.gmail ? 'Gmail connected — Joblin can send emails and enter codes' : g.connected ? 'Joblin can enter emailed codes' : g.note || 'Sign-in didn’t finish', !g.connected); if (route() === 'settings') render(); } }, 2500); }
    catch (e) { toast(e.message, true); }
  });
  $('#gwOff')?.addEventListener('click', async () => { await api('/integrations/gmail-web/disconnect', { method: 'POST', body: {} }); await refreshSummary(); render(); });
  $('#toAi')?.addEventListener('click', (e) => { e.preventDefault(); state.settingsTab = 'ai'; render(); });
  $('#hunterSave').onclick = () => saveSettings({ email: { hunterApiKey: $('#hunter').value.trim() } }, 'Hunter key saved');
  function poll() { let n = 0; const t = setInterval(async () => { await refreshSummary(); if (S.system.linkedin?.connected || ++n > 120) { clearInterval(t); if (route() === 'settings') render(); } }, 3000); }
};

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
      <div style="display:flex;gap:8px;margin-top:4px"><button class="btn sm" id="prev-${track}">Preview resume</button><button class="btn sm ghost" id="edit-${track}">Edit content</button></div><div id="ed-${track}"></div><div id="roles-${track}"></div>`;
    showRoles(track);
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
    if (!quality) { // editing the saved resume (not a fresh upload waiting for confirmation): save as you go
      let t;
      $(`#edf-${track}`).addEventListener('input', () => { clearTimeout(t); t = setTimeout(async () => {
        const data = collectResume($(`#edf-${track}`), resume);
        await api(`/resumes/${track}/confirm`, { method: 'POST', body: { resume: data } }); Object.assign(cur.resume, data); toast('Resume saved');
      }, 900); });
      $(`#conf-${track}`).textContent = 'Done';
    }
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
// The roles in a resume as boxes. Drag them into the order you want; mark the ones Joblin should lead with.
// Untouched, Joblin orders them by fit for each job and leads with the top two.
const KIND = { work: 'Work', leadership: 'Leadership', project: 'Project' };
async function showRoles(track) {
  const el = $(`#roles-${track}`); if (!el) return;
  let u;
  try { u = await api(`/resumes/${track}/usage`); } catch { el.innerHTML = ''; return; }
  if (!u.roles.length) { el.innerHTML = `<div class="roles"><p class="ex">Joblin didn’t find any roles in this resume yet. Upload it or use Edit content to add them.</p></div>`; return; }
  const ex = u.example.real ? `${esc(u.example.title)} at ${esc(u.example.company)}` : `a typical ${esc(u.example.title.toLowerCase())} posting`;
  const roles = [...u.roles].sort((a, b) => a.rank - b.rank);
  el.innerHTML = `<div class="roles"><div class="roles-h"><h3>${roles.length} roles Joblin uses from this resume</h3>
      ${u.custom ? `<button class="btn sm ghost" id="rreset-${track}">Let Joblin decide</button>` : ''}</div>
    <p class="ex">${u.custom ? 'Your order. Leads go first in cover letters and answers; the order is used on the tailored resume too.' : `Joblin’s pick for ${ex}. Drag to reorder, or press Lead on the roles you want up front — your choice is kept for every job.`}</p>
    <div class="role-grid" id="rg-${track}">${roles.map((r) => `<div class="role${r.lead ? ' lead' : ''}" draggable="true" data-key="${esc(r.key)}">
      <div class="rk"><span class="grip" aria-hidden="true">⋮⋮</span><span class="n">#${r.rank}</span><span class="tag">${KIND[r.kind] || 'Work'}</span>${r.current ? '<span class="tag">Current</span>' : ''}
        <button type="button" class="lead-t${r.lead ? ' on' : ''}" aria-pressed="${r.lead}" title="${r.lead ? 'Joblin leads with this role' : 'Make this a lead role'}">${r.lead ? '★ Lead' : '☆ Lead'}</button></div>
      <b>${esc(r.role || r.org)}</b><span class="o">${esc(r.role ? r.org : '')}${r.date ? `${r.role ? ' · ' : ''}${esc(r.date)}` : ''}</span>
      ${r.leadBullet ? `<span class="bl">${esc(r.leadBullet)}</span>` : ''}</div>`).join('')}</div></div>`;
  const grid = $(`#rg-${track}`);
  const boxes = () => $$('.role', grid);
  const save = async (msg) => {
    const order = boxes().map((b) => b.dataset.key), leads = boxes().filter((b) => b.classList.contains('lead')).map((b) => b.dataset.key);
    await saveSettings({ resumes: { [track]: { roleOrder: order, leads } } }, msg);
    showRoles(track);
  };
  // Drag and drop: the box follows the pointer; numbers update when you let go.
  let dragging = null;
  grid.addEventListener('dragstart', (e) => { dragging = e.target.closest('.role'); dragging?.classList.add('dragging'); e.dataTransfer.effectAllowed = 'move'; });
  grid.addEventListener('dragover', (e) => {
    e.preventDefault(); const over = e.target.closest('.role'); if (!dragging || !over || over === dragging) return;
    const r = over.getBoundingClientRect(), after = (e.clientY - r.top) / r.height > 0.5 || (e.clientX - r.left) / r.width > 0.5;
    grid.insertBefore(dragging, after ? over.nextSibling : over);
  });
  grid.addEventListener('dragend', () => { if (!dragging) return; dragging.classList.remove('dragging'); dragging = null; save('Order saved'); });
  $$('.lead-t', grid).forEach((t) => t.onclick = () => { t.closest('.role').classList.toggle('lead'); save('Leads saved'); });
  $(`#rreset-${track}`)?.addEventListener('click', async () => { await saveSettings({ resumes: { [track]: { roleOrder: [], leads: null } } }, 'Joblin will pick for each job'); showRoles(track); });
}
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

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Places you can work from</h2></div>
    <p class="muted" style="margin:-6px 0 0;font-size:13px">Cities you could easily be based in besides ${esc(p.city || 'home')}. When an application asks where you're located, Joblin answers with the one closest to the job (Calgary job → Edmonton, Vancouver job → Vancouver). Your street address and postal code stay your real ones.</p>
    <div class="chipbox" id="baseChips"></div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Education</h2></div>
    <div class="grid2">${f('school', 'School', p.school)}${f('degree', 'Degree', p.degree, 'text', 'e.g. Bachelor of Commerce')}
    ${f('major', 'Major', p.major)}${f('minor', 'Minor', p.minor, 'text', 'Optional')}
    <div class="grid2">${f('gpa', 'GPA', p.gpa, 'text', 'e.g. 3.7')}${f('gpaScale', 'Out of', p.gpaScale, 'text', '4.0')}</div>
    ${sel('yearOfStudy', 'Year of study', ['1st year', '2nd year', '3rd year', '4th year', '5th year or more', 'Graduate student'], 'pf')}
    ${sel('eduStartMonth', 'Started — month', MONTHS_UI, 'pf')}${f('eduStartYear', 'Started — year', p.eduStartYear, 'text', 'e.g. 2024')}
    ${sel('graduationMonth', 'Graduation — month', MONTHS_UI, 'pf')}${f('graduationYear', 'Graduation — year', p.graduationYear)}</div>
    <div class="srow" style="border-top:1px solid var(--line-soft);padding-top:14px"><div class="l"><b>Transcript</b><span>${p.transcriptName ? `${esc(p.transcriptName)} — attached when an application asks for one.` : 'Optional. Attached only when an application asks for a transcript.'}</span></div>
      <div class="ctl" style="display:flex;gap:8px">${p.transcriptName ? '<button class="btn sm ghost danger" id="trDel">Remove</button>' : ''}<button class="btn sm" id="trUp">${p.transcriptName ? 'Replace' : 'Upload transcript'}</button><input type="file" id="trFile" accept=".pdf,.png,.jpg,.jpeg,.docx" hidden></div></div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Work history</h2><span class="sub">from your resumes</span></div>
    <p class="muted" style="margin:-6px 0 0;font-size:13px">Every role Joblin found across your resumes. Applications with several employment blocks get these in order. Change them in <a class="link" href="#/settings" id="toRes">Resumes</a>.</p>
    <div class="role-grid" id="workHist"><div class="muted" style="font-size:13px">Loading…</div></div></section>

  <section class="panel panel-b fieldset"><div class="panel-h" style="padding:0"><h2>Role listed first</h2></div>
    <p class="muted" style="margin:-6px 0 0;font-size:13px">Used for “current employer” and “job title” questions and the first employment block. The rest of your roles follow it. Leave the end date blank if you're still there.</p>
    <label class="f">Pick from your resumes<select id="pickRole"><option value="">Choose a role…</option></select></label>
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
  let bases = p.bases || [];
  chipInput($('#baseChips'), { values: bases, placeholder: 'Add a city, e.g. Austin, Texas or Edmonton, Alberta',
    suggestions: LOCATION_SUGGESTIONS, onChange: (v) => (bases = v) });
  $('#saveP').onclick = () => {
    const profile = { answers: {}, bases };
    $$('[data-pf]', el).forEach((i) => (profile[i.dataset.pf] = i.value.trim()));
    $$('[data-pa]', el).forEach((i) => (profile.answers[i.dataset.pa] = i.value.trim()));
    saveSettings(profile.answers.pronouns ? { profile: { ...profile, pronouns: profile.answers.pronouns } } : { profile }, 'Profile saved');
  };
  $('#toRes').onclick = () => (state.settingsTab = 'resumes');
  api('/positions').then((roles) => {
    $('#workHist').innerHTML = roles.length ? roles.map((r) => `<div class="role${r.org === p.currentEmployer ? ' lead' : ''}"><div class="rk"><span class="tag">${KIND[r.kind] || 'Work'}</span>${r.current ? '<span class="tag">Current</span>' : ''}${r.org === p.currentEmployer ? '<span class="tag l">Listed first</span>' : ''}</div>
      <b>${esc(r.role || r.org)}</b><span class="o">${esc(r.role ? r.org : '')}${r.date ? ` · ${esc(r.date)}` : ''}</span><span class="o">${r.tracks.map((t) => esc(t === 'swe' ? 'Software' : t === 'finance' ? 'Finance' : t)).join(' · ')} resume${r.tracks.length > 1 ? 's' : ''}</span></div>`).join('')
      : '<div class="muted" style="font-size:13px">No roles found yet. Upload your resumes in Settings → Resumes.</div>';
    const pick = $('#pickRole');
    roles.forEach((r, i) => pick.add(new Option(`${r.role} · ${r.org}`, i)));
    pick.onchange = () => {
      const r = roles[+pick.value]; if (!r) return;
      const set = (k, v) => { const i = $(`[data-pf="${k}"]`, el); if (!i) return; i.value = v || ''; i.dispatchEvent(new Event('change', { bubbles: true })); };
      set('currentEmployer', r.org); set('currentTitle', r.role);
      set('jobStartMonth', r.start?.month); set('jobStartYear', r.start?.year);
      set('jobEndMonth', r.end?.month || ''); set('jobEndYear', r.end?.year || '');
      toast('Filled in');
    };
  }).catch(() => {});
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
    <div class="srow"><div class="l"><b>Daily limit</b><span>Up to 60. Gmail flags accounts that send too much cold email; 30–50 a day is safe.</span></div><div class="ctl"><input type="number" id="cap" min="1" max="60" value="${Math.min(60, E.dailyCap)}" style="width:90px"></div></div>
    <div class="srow"><div class="l"><b>Sending hours</b><span>Weekdays only, in your local time.</span></div><div class="ctl" style="display:flex;gap:6px;align-items:center"><input type="number" id="h1" min="0" max="23" value="${E.sendWindow.startHour}" style="width:70px"> to <input type="number" id="h2" min="1" max="24" value="${E.sendWindow.endHour}" style="width:70px"></div></div>
    <div class="srow"><div class="l"><b>Follow up after</b><span>One polite follow-up if nobody replies. Cancelled automatically when they do.</span></div><div class="ctl" style="display:flex;gap:6px;align-items:center"><input type="number" id="fu" min="1" max="10" value="${Math.min(10, E.followUpAfterDays)}" style="width:70px"> days</div></div>
    <div class="srow"><div class="l"><b>People per job</b><span>Maximum contacts emailed for one posting.</span></div><div class="ctl"><input type="number" id="per" min="1" max="5" value="${E.maxContactsPerJob}" style="width:70px"></div></div>
    <div class="srow"><div class="l"><b>Email guessed addresses</b><span>When no address is public, try first.last@company. Some will bounce.</span></div><div class="ctl">${sw('guess', E.useGuessedEmails)}</div></div>
  </section><div><button class="btn primary" id="saveE">Save email settings</button></div>`;
  const cl = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number(v) || d));
  $('#saveE').onclick = () => saveSettings({ email: { enabled: $('#emOn').checked, dailyCap: cl($('#cap').value, 1, 60, 40), sendWindow: { startHour: cl($('#h1').value, 0, 23, 8), endHour: cl($('#h2').value, 1, 24, 17) }, followUpAfterDays: cl($('#fu').value, 1, 10, 5), maxContactsPerJob: cl($('#per').value, 1, 3, 2), minGapMinutes: 2, maxGapMinutes: 6, useGuessedEmails: $('#guess').checked } }, 'Email settings saved');
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
        <div class="grid2">${[['firstName', 'First name'], ['lastName', 'Last name'], ['email', 'Email'], ['phone', 'Phone'], ['city', 'City'], ['region', 'Province or state'], ['country', 'Country'], ['linkedin', 'LinkedIn URL'], ['school', 'School'], ['major', 'Major'], ['minor', 'Minor (optional)'], ['gpa', 'GPA (optional)'], ['graduationYear', 'Graduation year']].map(([k, l]) => `<label class="f">${l}<input type="text" data-ob="${k}" value="${esc(p[k])}"></label>`).join('')}</div>`;
    } else if (step === 1) {
      b.innerHTML = `<h2>Your resumes</h2><p class="lead">Upload your software and finance resumes. Joblin reads them, shows you what it found, and uses the best one for each job. Skip this to keep the versions already loaded.</p>${resumeCard('swe', 'Software engineering resume')}${resumeCard('finance', 'Finance resume')}`;
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
        if (await ask({ title: 'You’re all set', image: '/img/joblin-256.png', body: 'Want Joblin to find your first batch of jobs now?', ok: 'Find jobs now', cancel: 'Later' })) startSearch();
        return;
      }
      step++; await loadSettings(); draw();
    };
  };
  draw();
}

SETTINGS.ai = async (el) => {
  const L = SET.llm, provs = L.providers;
  let prov = L.provider || 'ollama';
  const draw = () => {
    el.innerHTML = `<section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>Writing model</h2></div>
      <p class="muted" style="margin:0 0 14px;font-size:13px">Joblin uses this model for cover letters, emails and application questions. The local model is free. Cloud models write noticeably better and cost a fraction of a cent per application on your own key.</p>
      <div class="choice" id="provs" style="grid-template-columns:repeat(2,1fr)">${Object.entries(provs).map(([k, v]) => `<button data-p="${k}" class="${prov === k ? 'on' : ''}"><span class="pico">${logoTile(PROVIDER_ICONS[k]?.img, v.label)}</span><b>${esc(v.label)}</b><span>${k === 'ollama' ? 'Runs on this Mac. No account, no cost.' : L.keys[k] ? `Key saved (${esc(L.keys[k])})` : 'Needs an API key'}</span></button>`).join('')}</div>
      <div class="grid2" style="margin-top:16px">
        <label class="f">Model<select id="model">${(() => {
          const cur = prov === 'ollama' ? L.model : (L.models?.[prov] || provs[prov].defaultModel);
          let list = [...(provs[prov].models || [])];
          if (prov === 'ollama') for (const m of L.installed || []) if (!list.some(([id]) => id === m)) list.push([m, `${m} — installed`]);
          if (prov === 'ollama') list = list.map(([id, l]) => [id, (L.installed || []).includes(id) ? l.replace(/ —/, ' (installed) —') : `${l} · needs: ollama pull ${id}`]);
          if (cur && !list.some(([id]) => id === cur)) list.unshift([cur, cur]);
          return list.map(([id, l]) => `<option value="${esc(id)}" ${id === cur ? 'selected' : ''}>${esc(l)}</option>`).join('');
        })()}</select></label>
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
  // Leaving an answer box (or picking an option) saves it, same as pressing Save.
  $$('[data-ans]', root).forEach((i) => i.addEventListener('change', () => { if (i.value.trim()) $(`[data-save="${i.dataset.ans}"]`, root)?.click(); }));
  $$('[data-save]', root).forEach((b) => b.onclick = async () => {
    await api(`/answers/${b.dataset.save}`, { method: 'PUT', body: { answer: $(`[data-ans="${b.dataset.save}"]`, root).value } });
    toast('Saved to memory — Joblin will reuse it'); await refreshSummary(); render();
  });
}

// ---------- Questions: only what still needs an answer ----------
VIEWS.answers = async (view) => {
  const pending = (await api('/answers')).filter((r) => r.source === 'pending');
  if (!pending.length) {
    view.innerHTML = `<section class="panel hello"><img src="/img/joblin-256.png" alt=""><div><h2>No open questions</h2><div class="muted">When an application asks something Joblin can't answer, it shows up here. Once you answer, it moves to <a class="link" href="#/memory">Memory</a> and gets reused. Written answers (“tell us about a project…”) are written fresh for each job and never need you.</div></div></section>`;
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
const FACT_CATS = [['general', 'About me'], ['companies', 'Companies I like'], ['preferences', 'Job preferences'], ['experience', 'Experience & projects'], ['goals', 'Goals & interests'], ['outreach', 'For emails']];
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
  $$('[data-fact]').forEach((i) => i.addEventListener('change', () => $(`[data-fsave="${i.dataset.fact}"]`)?.click()));
  const pickFacts = selectable($('#factBox'));
  $('#factDel')?.addEventListener('click', async () => { const ids = pickFacts(); if (!(await ask({ title: `Forget ${ids.length} ${ids.length === 1 ? 'note' : 'notes'}?`, ok: 'Forget', danger: true }))) return; await api('/facts/delete', { method: 'POST', body: { ids } }); render(); });
  const pickAns = selectable($('#ansBox'));
  bindAnswerSaves($('#ansBox'));
  $('#ansConfirm')?.addEventListener('click', async () => { await api('/answers/bulk', { method: 'POST', body: { ids: pickAns(), action: 'confirm' } }); toast('Marked as your answers'); render(); });
  $('#ansForget')?.addEventListener('click', async () => { const ids = pickAns(); if (!(await ask({ title: `Forget ${ids.length} ${ids.length === 1 ? 'answer' : 'answers'}?`, body: 'Joblin won’t reuse them on future applications.', ok: 'Forget', danger: true }))) return; await api('/answers/bulk', { method: 'POST', body: { ids, action: 'delete' } }); render(); });
};

// ---------- Positions: keywords for any field ----------
function positionsEditor(el, _suggested, { onboarding = false } = {}) {
  const loc0 = (SET.sources?.boards?.locations || [])[0] || SET.profile?.country || '';
  let vals = (SET.search.queries || []).map((q) => q.keywords);
  el.innerHTML = `<div class="chipbox" id="posChips"></div>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Type any job title or keyword (“marketing coordinator”, “structural engineer”, “investment banking”). Joblin matches each job to your best resume automatically.</p>`;
  chipInput($('#posChips', el), { values: vals, suggestions: POSITION_SUGGESTIONS, placeholder: vals.length ? 'Add another position…' : 'e.g. Finance Intern', onChange: (v) => (vals = v) });
  return () => vals.map((k) => {
    const prev = (SET.search.queries || []).find((q) => q.keywords.toLowerCase() === k.toLowerCase());
    return { keywords: k, location: prev?.location || loc0, track: prev?.track && prev.track !== 'swe' && prev.track !== 'finance' ? prev.track : 'auto' };
  });
}

SETTINGS.positions = async (el) => {
  el.innerHTML = `<section class="panel panel-b"><div class="panel-h" style="padding:0 0 4px"><h2>Positions you’re applying for</h2></div>
      <p class="muted" style="margin:0 0 12px;font-size:13px">You can also just tell Joblin in the chat: “add product management roles”.</p><div id="pe"></div></section>
    <section class="panel panel-b"><label class="f">Skip titles containing</label><div class="chipbox" id="exclChips" style="margin-top:6px"></div>
    <div class="grid2" style="margin-top:14px"><label class="f">Posted within<select id="posted">${['day', 'week', 'month'].map((p) => `<option value="${p}" ${SET.search.postedWithin === p ? 'selected' : ''}>Past ${p}</option>`).join('')}</select></label>
    <label class="f">LinkedIn results per search<input type="number" id="perQ" min="5" max="50" value="${Math.min(50, SET.search.maxJobsPerQuery)}"></label></div></section>
    <div><button class="btn primary" id="saveQ">Save positions</button></div>`;
  const get = positionsEditor($('#pe'));
  let excl = SET.search.excludeTitleWords || [];
  chipInput($('#exclChips'), { values: excl, suggestions: ['senior', 'sr.', 'staff', 'principal', 'lead', 'manager', 'director', 'head of', 'vp', 'phd', 'clearance'], placeholder: 'e.g. senior', onChange: (v) => (excl = v) });
  $('#saveQ').onclick = () => saveSettings({ search: { queries: get(), excludeTitleWords: excl, postedWithin: $('#posted').value, maxJobsPerQuery: Math.min(50, +$('#perQ').value || 25) } }, 'Positions saved');
};

// ---------- Job sources: where to look, and which companies ----------
SETTINGS.sources = async (el) => {
  const B = SET.sources.boards, Li = SET.sources.linkedin;
  let locs = B.locations || [];
  el.innerHTML = `<section class="panel panel-b">
    <div class="srow"><div class="l"><b>Company job boards</b><span>Open roles straight from companies’ Greenhouse, Lever and Ashby pages. Joblin can submit every one of these itself.</span></div><div class="ctl">${sw('bOn', B.enabled !== false)}</div></div>
    <div class="srow"><div class="l"><b>LinkedIn</b><span>Searches LinkedIn with your positions. Needs LinkedIn connected.</span></div><div class="ctl">${sw('lOn', Li.enabled !== false)}</div></div>
    <div class="srow"><div class="l"><b>Also show jobs I’d submit myself</b><span>Banks, pension funds, governments and big companies use Workday or their own portals, which Joblin can’t submit to — that’s where most Canadian finance internships are. Joblin still finds them, writes your resume and cover letter, and lists them under Needs you with a link; you press submit.</span></div>
      <div class="ctl"><select id="incManual" style="width:auto">${[['off', 'Off'], ['finance', 'Finance jobs only'], ['all', 'All jobs']].map(([v, l]) => `<option value="${v}" ${(Li.includeManual === true ? 'all' : Li.includeManual === 'finance' ? 'finance' : 'off') === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div></div>
    <div class="srow"><div class="l"><b>New jobs per search</b><span>Kept small so each search finishes quickly (up to 60).</span></div><div class="ctl"><input type="number" id="bMax" min="5" max="60" value="${Math.min(60, B.maxPerRun || 30)}" style="width:90px"></div></div>
  </section>
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>Where</h2></div>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Add countries, provinces, states or cities. “Remote” only counts when a job isn’t tied to another country.</p>
    <div class="chipbox" id="locChips"></div>
    <div class="srow" style="margin-top:8px"><div class="l"><b>Include roles without “intern” or “new grad” in the title</b><span>Off keeps it to internships, co-ops and early-career roles.</span></div><div class="ctl">${sw('bEntry', B.includeEntryLevelWithoutKeyword)}</div></div></section>
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>Companies you want</h2></div>
    <p class="muted" style="margin:0 0 10px;font-size:13px">Add a company and Joblin finds its job board, or searches LinkedIn for it. You can also say “apply to Shopify and RBC” in the chat.</p>
    <div class="cos" id="cos"></div>
    <div style="display:flex;gap:8px;margin-top:10px"><input type="text" id="coIn" placeholder="Company name, e.g. Wealthsimple"><button class="btn" id="coAdd">Add company</button></div>
    <div class="srow" style="margin-top:8px"><div class="l"><b>Only search these companies</b><span>Off also checks Joblin’s list of ~75 companies that hire students.</span></div><div class="ctl">${sw('onlyT', SET.search.onlyTargets)}</div></div></section>
  <div><button class="btn primary" id="saveSrc">Save job sources</button></div>`;
  chipInput($('#locChips'), { values: locs, suggestions: LOCATION_SUGGESTIONS, placeholder: 'Add a place…', onChange: (v) => (locs = v) });
  const drawCos = () => {
    const cos = SET.search.companies || [];
    $('#cos').innerHTML = cos.map((c, i) => `<div class="co">${mono(c.name)}<div><b>${esc(c.name)}</b><span class="muted">${c.board ? `Job board found (${esc(c.board.split(':')[0])})` : 'Searched on LinkedIn'}</span></div><button class="btn sm ghost" data-rmco="${i}">Remove</button></div>`).join('') || '<div class="muted" style="font-size:13px">No companies yet.</div>';
    $$('[data-rmco]').forEach((b) => b.onclick = async () => { const cos2 = (SET.search.companies || []).filter((_, i) => i !== +b.dataset.rmco); await saveSettings({ search: { companies: cos2 } }, 'Company removed'); drawCos(); });
  };
  drawCos();
  const addCo = async () => {
    const name = $('#coIn').value.trim(); if (!name) return;
    $('#coAdd').disabled = true; $('#coAdd').textContent = 'Looking it up…';
    try { const r = await api('/companies', { method: 'POST', body: { name } }); await loadSettings(); toast(r.board ? `Found ${name}’s job board` : `${name} will be searched on LinkedIn`); $('#coIn').value = ''; drawCos(); }
    catch (e) { toast(e.message, true); } finally { $('#coAdd').disabled = false; $('#coAdd').textContent = 'Add company'; }
  };
  $('#coAdd').onclick = addCo; $('#coIn').onkeydown = (e) => e.key === 'Enter' && addCo();
  $('#saveSrc').onclick = () => saveSettings({ sources: { boards: { enabled: $('#bOn').checked, maxPerRun: Math.min(60, +$('#bMax').value || 30), locations: locs, includeEntryLevelWithoutKeyword: $('#bEntry').checked }, linkedin: { enabled: $('#lOn').checked, includeManual: { all: true, finance: 'finance', off: false }[$('#incManual').value] } },
    search: { onlyTargets: $('#onlyT').checked, queries: (SET.search.queries || []).map((q) => ({ ...q, location: locs[0] || q.location })) } }, 'Job sources saved');
};

// ---------- Automation ----------
const ICON_REVIEW = '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="3"/><path d="M8 9h8M8 13h5"/><path d="M14.5 17l1.5 1.5 3-3"/></svg>';
const ICON_BOLT = '<svg viewBox="0 0 24 24"><path d="M13 2L4 14h7l-1 8 9-12h-7z"/></svg>';
SETTINGS.automation = async (el) => {
  const m = SET.mode, a = SET.apply;
  const every = m.discoverEvery ?? m.discoverEveryHours ?? 6, unit = m.discoverUnit || 'hours';
  el.innerHTML = `
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 14px"><h2>How Joblin applies</h2></div>
    <div class="choice" id="modeChoice">
      <button data-m="review" class="${m.type === 'review' ? 'on' : ''}"><span class="mico">${ICON_REVIEW}</span><b>Review first</b><span>Joblin prepares applications and waits. Each one you approve is sent right away.</span></button>
      <button data-m="autopilot" class="${m.type === 'autopilot' ? 'on' : ''}"><span class="mico bolt">${ICON_BOLT}</span><b>Autopilot</b><span>Joblin finds, writes and submits on its own schedule. You check in when you like.</span></button>
    </div></section>
  <section class="panel panel-b">
    <div class="srow"><div class="l"><b>Search automatically</b><span>Always on in autopilot.</span></div><div class="ctl">${sw('autoDiscover', m.autoDiscover || m.type === 'autopilot')}</div></div>
    <div class="srow"><div class="l"><b>Search every</b><span>How often Joblin looks for new jobs.</span></div>
      <div class="ctl" style="display:flex;gap:8px;align-items:center"><input type="number" id="every" min="1" max="60" value="${every}" style="width:76px">
        <select id="unit" style="width:auto">${['hours', 'days', 'weeks'].map((u) => `<option ${u === unit ? 'selected' : ''}>${u}</option>`).join('')}</select>
        <span id="atWrap" ${unit === 'hours' ? 'hidden' : ''}>at <input type="time" id="at" value="${esc(m.discoverAt || '09:00')}" style="width:auto"></span></div></div>
    <div class="srow"><div class="l"><b>Applications written per search</b><span>Small batches finish fast; the next search picks up the rest (up to 15).</span></div><div class="ctl"><input type="number" id="batch" min="1" max="15" value="${Math.min(15, m.batchSize || 8)}" style="width:76px"></div></div>
    <div class="srow"><div class="l"><b>Applications sent per round</b><span>Up to 30, then Joblin takes a breather before the next round.</span></div><div class="ctl"><input type="number" id="maxApps" min="1" max="30" value="${Math.min(30, a.maxApplicationsPerRun || 15)}" style="width:76px"></div></div>
    <div class="srow"><div class="l"><b>Autopilot minimum fit</b><span>Skip jobs scoring below this (0–100).</span></div><div class="ctl"><input type="number" id="minScore" min="0" max="100" value="${m.minScore ?? 0}" style="width:76px"></div></div>
  </section>
  <section class="panel panel-b">
    <div class="srow"><div class="l"><b>While Joblin works</b><span>Hidden uses a real Chrome window you never see; it never takes your keyboard or mouse. Visible lets you watch.</span></div>
      <div class="ctl"><div class="seg" id="browserSeg"><button data-b="background" class="${a.browser !== 'window' ? 'on' : ''}">Hidden</button><button data-b="window" class="${a.browser === 'window' ? 'on' : ''}">Visible</button></div></div></div>
    <div class="srow"><div class="l"><b>Submit applications</b><span>Off means Joblin fills each form but leaves it unsent, for testing.</span></div><div class="ctl">${sw('autoSubmit', a.autoSubmit)}</div></div>
  </section>
  <div><button class="btn primary" id="saveAuto">Save automation settings</button></div>`;
  let mode = m.type, browser = a.browser;
  $$('#modeChoice button').forEach((b) => b.onclick = () => { mode = b.dataset.m; $$('#modeChoice button').forEach((x) => x.classList.toggle('on', x === b)); });
  $$('#browserSeg button').forEach((b) => b.onclick = () => { browser = b.dataset.b; $$('#browserSeg button').forEach((x) => x.classList.toggle('on', x === b)); });
  $('#unit').onchange = () => ($('#atWrap').hidden = $('#unit').value === 'hours');
  $('#saveAuto').onclick = async () => {
    if (mode === 'autopilot' && m.type !== 'autopilot' && !(await ask({ title: 'Turn on autopilot?', body: 'Joblin will find jobs and submit applications on its own schedule, without asking you first.', ok: 'Turn on autopilot' }))) return;
    const clamp = (v, lo, hi, d) => Math.max(lo, Math.min(hi, Number(v) || d));
    saveSettings({ mode: { type: mode, autoDiscover: $('#autoDiscover').checked, discoverEvery: clamp($('#every').value, 1, 60, 6), discoverUnit: $('#unit').value, discoverAt: $('#at').value, batchSize: clamp($('#batch').value, 1, 15, 8), minScore: clamp($('#minScore').value, 0, 100, 0) },
      apply: { browser, window: browser === 'window' ? 'visible' : 'hidden', autoSubmit: $('#autoSubmit').checked, maxApplicationsPerRun: clamp($('#maxApps').value, 1, 30, 15) } }, 'Automation settings saved');
  };
};

// ---------- Resumes: one per type of job ----------
function resumeCard(track, label = track, own = true, removable = false) {
  return `<section class="panel panel-b" id="rc-${track}"><div class="panel-h" style="padding:0 0 12px"><h2>${esc(label)}</h2>
      <div class="right" id="rcq-${track}"></div>${removable ? `<button class="btn sm ghost danger" data-rmtrack="${track}">Remove</button>` : ''}</div>
    ${own ? '' : `<p class="muted" style="margin:-4px 0 10px;font-size:13px">Using your ${track && /swe|data|ml|design|security|mechanical|electrical|civil|chemical|product/.test(track) ? 'software' : 'finance'} resume for now. Upload one made for ${esc(label.toLowerCase())} roles.</p>`}
    <div class="drop" data-drop="${track}" tabindex="0" role="button">Drop a PDF or Word file here, or click to choose<input type="file" accept=".pdf,.docx,.doc" hidden></div>
    <div id="rcb-${track}"></div></section>`;
}
SETTINGS.resumes = async (el) => {
  const { tracks, catalog } = await api('/tracks');
  el.innerHTML = `<p class="muted" style="margin:0;font-size:13px">Add a resume for each kind of job you apply to. Joblin picks the best one for every posting, reorders your bullet points to match it, and never adds experience you don’t have.</p>
    ${tracks.map((t) => resumeCard(t.id, t.label, t.own, !['swe', 'finance'].includes(t.id))).join('')}
    <section class="panel panel-b"><div class="panel-h" style="padding:0 0 10px"><h2>Add a resume type</h2></div><div class="chipbox" id="addTrack"></div></section>`;
  for (const t of tracks) await mountResume(t.id);
  chipInput($('#addTrack'), { values: [], suggestions: catalog.filter((c) => !tracks.some((t) => t.id === c.id)).map((c) => c.label), placeholder: '+ e.g. Accounting, Marketing, Mechanical engineering',
    onChange: async (v) => { if (!v.length) return; await api('/tracks', { method: 'POST', body: { name: v[v.length - 1] } }); toast('Resume type added'); await loadSettings(); SETTINGS.resumes(el); } });
  $$('[data-rmtrack]').forEach((b) => b.onclick = async () => {
    if (!(await ask({ title: 'Remove this resume type?', body: 'Jobs will use your other resumes instead.', ok: 'Remove', danger: true }))) return;
    await api(`/tracks/${b.dataset.rmtrack}`, { method: 'DELETE' }); SETTINGS.resumes(el);
  });
};

// ---------- Cover letters: a template per resume type, "/" inserts a field ----------
const TOKENS = [['company', 'Company'], ['role', 'Role'], ['company_focus', 'What the company does'], ['role_focus', 'What the role does'], ['name', 'Your name'], ['first_name', 'First name'],
  ['school', 'School'], ['major', 'Major'], ['degree', 'Degree'], ['graduation', 'Graduation date'], ['current_employer', 'Current employer'], ['current_title', 'Current title'], ['city', 'City']];
const tokLabel = (k) => (TOKENS.find((t) => t[0] === k) || [k, k])[1];
function tplToHTML(text) {
  return esc(text).replace(/\{\{(\w+)\}\}/g, (_, k) => `<span class="tok" contenteditable="false" data-k="${k}">${esc(tokLabel(k))}</span>`);
}
function htmlToTpl(el) {
  let out = '';
  const walk = (n) => {
    for (const c of n.childNodes) {
      if (c.nodeType === 3) out += c.nodeValue;
      else if (c.classList?.contains('tok')) out += `{{${c.dataset.k}}}`;
      else if (c.tagName === 'BR') out += '\n';
      else { if (/^(DIV|P)$/.test(c.tagName) && out && !out.endsWith('\n')) out += '\n'; walk(c); }
    }
  };
  walk(el);
  return out.replace(/ /g, ' ');
}
function slashEditor(el, text) {
  el.className = 'tpl-ed'; el.setAttribute('contenteditable', 'plaintext-only'); el.spellcheck = true;
  el.innerHTML = tplToHTML(text);
  const menu = document.createElement('div'); menu.className = 'dd-menu slash-menu'; menu.hidden = true; document.body.appendChild(menu);
  let items = [], active = 0, range = null;
  const close = () => { menu.hidden = true; range = null; };
  const insert = (k) => {
    if (!range) return;
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(range);
    const node = range.startContainer, off = range.startOffset, txt = node.nodeValue || '', at = txt.lastIndexOf('/', off - 1);
    const r = document.createRange(); r.setStart(node, at); r.setEnd(node, off); r.deleteContents();
    const tok = document.createElement('span'); tok.className = 'tok'; tok.contentEditable = 'false'; tok.dataset.k = k; tok.textContent = tokLabel(k);
    r.insertNode(tok);
    const space = document.createTextNode(' '); tok.after(space);
    const after = document.createRange(); after.setStart(space, 1); after.collapse(true); sel.removeAllRanges(); sel.addRange(after);
    close();
  };
  el.addEventListener('input', () => {
    const sel = getSelection(); if (!sel.rangeCount) return close();
    const r = sel.getRangeAt(0), node = r.startContainer;
    if (node.nodeType !== 3) return close();
    const before = node.nodeValue.slice(0, r.startOffset), m = before.match(/(?:^|\s)\/(\w*)$/);
    if (!m) return close();
    items = TOKENS.filter(([k, l]) => !m[1] || k.includes(m[1].toLowerCase()) || l.toLowerCase().includes(m[1].toLowerCase()));
    if (!items.length) return close();
    range = r.cloneRange(); active = 0;
    menu.innerHTML = items.map(([k, l], i) => `<div class="dd-opt ${i === 0 ? 'active' : ''}" data-k="${k}"><span class="tok sm">${esc(l)}</span></div>`).join('');
    const rect = r.getBoundingClientRect();
    Object.assign(menu.style, { position: 'fixed', left: `${Math.min(rect.left, innerWidth - 280)}px`, top: `${rect.bottom + 6}px`, minWidth: '240px' });
    menu.hidden = false;
    $$('.dd-opt', menu).forEach((o) => o.onmousedown = (e) => { e.preventDefault(); insert(o.dataset.k); });
  });
  el.addEventListener('keydown', (e) => {
    if (menu.hidden) return;
    const opts = $$('.dd-opt', menu);
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); active = Math.max(0, Math.min(opts.length - 1, active + (e.key === 'ArrowDown' ? 1 : -1))); opts.forEach((o, i) => o.classList.toggle('active', i === active)); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); insert(items[active][0]); }
    else if (e.key === 'Escape') close();
  });
  el.addEventListener('blur', () => setTimeout(close, 150));
  window.addEventListener('hashchange', () => menu.remove(), { once: true });
  return () => htmlToTpl(el);
}

SETTINGS.cover = async (el) => {
  const C = SET.coverLetter, list = SET.trackList || [{ id: 'swe', label: 'Software engineering' }, { id: 'finance', label: 'Finance' }];
  let cur = state.coverTrack && list.some((t) => t.id === state.coverTrack) ? state.coverTrack : list[0].id;
  el.innerHTML = `
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 6px"><h2>How cover letters are written</h2></div>
    <p class="muted" style="margin:0 0 6px;font-size:13px;max-width:72ch">Most jobs get the template for that resume type with the blue fields filled in, which costs one small model call. Jobs that fit you best get a <b>precise</b> letter: same voice and structure, but the “why this role” paragraph is rewritten from the posting and a paragraph matches their requirements to your experience.</p>
    <div class="srow"><div class="l"><b>Write precise letters for jobs with fit of at least</b><span>0–100. You can also ask for one on any job in Review batch.</span></div><div class="ctl"><input type="number" id="pmin" min="0" max="100" value="${C.preciseMinScore ?? 75}" style="width:80px"></div></div>
    <div class="srow"><div class="l"><b>Always write precise letters</b><span>Best letters, a few more model calls per job.</span></div><div class="ctl">${sw('palways', C.alwaysPrecise)}</div></div></section>
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 10px"><h2>Templates</h2>
      <div class="right"><button class="btn sm ghost" id="tplReset">Reset this template</button></div></div>
    <div class="tabsrow" id="tplTabs">${list.map((t) => `<button data-t="${t.id}" class="${t.id === cur ? 'on' : ''}">${esc(t.label)}</button>`).join('')}<a class="link" href="#/settings" id="toResumes" style="font-size:13px;margin-left:6px">+ Add a type in Resumes</a></div>
    <div id="tplEd"></div>
    <p class="muted" style="font-size:12.5px;margin:8px 0 0">Type <b>/</b> to insert a field like company, role or what the company does. Fields show in blue and are filled in for each job.</p></section>
  <section class="panel panel-b"><div class="panel-h" style="padding:0 0 12px"><h2>Try it</h2>
      <div class="right"><div class="seg" id="pvKind"><button data-k="template" class="on">Template</button><button data-k="precise">Precise</button></div></div></div>
    <button class="btn" id="pvGo">Save and write a sample letter</button><div id="pvOut" style="margin-top:14px"></div></section>
  <div><button class="btn primary" id="saveCl">Save cover letter settings</button></div>`;
  const edited = {};
  let getText;
  const open = (t) => {
    if (getText) edited[cur] = getText();
    cur = t; state.coverTrack = t;
    $$('#tplTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === t));
    getText = slashEditor($('#tplEd'), edited[t] ?? C.activeTemplates[t] ?? C.defaultTemplates[t] ?? '');
  };
  open(cur);
  $$('#tplTabs button').forEach((b) => b.onclick = () => open(b.dataset.t));
  $('#toResumes').onclick = () => (state.settingsTab = 'resumes');
  $('#tplReset').onclick = () => { edited[cur] = C.defaultTemplates[cur]; getText = slashEditor($('#tplEd'), C.defaultTemplates[cur]); };
  let pvk = 'template';
  $$('#pvKind button').forEach((b) => b.onclick = () => { pvk = b.dataset.k; $$('#pvKind button').forEach((x) => x.classList.toggle('on', x === b)); });
  const patch = () => {
    edited[cur] = getText();
    const templates = {}; for (const [t, v] of Object.entries(edited)) templates[t] = v.trim() === (C.defaultTemplates[t] || '').trim() ? '' : v;
    return { coverLetter: { preciseMinScore: +$('#pmin').value, alwaysPrecise: $('#palways').checked, templates } };
  };
  $('#saveCl').onclick = async () => { await saveSettings(patch(), 'Cover letter settings saved'); await loadSettings(); };
  $('#pvGo').onclick = async (ev) => {
    ev.target.disabled = true;
    $('#pvOut').innerHTML = `<div class="work" style="grid-template-columns:120px 1fr;padding:6px 0"><img src="/img/joblin-working.png" alt="" style="width:120px"><div><b>Joblin is writing a ${pvk} ${esc((list.find((t) => t.id === cur) || {}).label || '')} letter…</b><div class="muted">${pvk === 'precise' ? 'About a minute' : 'About 15 seconds'} on the local model.</div></div></div>`;
    try {
      await api('/settings', { method: 'PUT', body: patch() }); await loadSettings();
      const r = await api('/cover/preview', { method: 'POST', body: { track: cur, precise: pvk === 'precise' } });
      $('#pvOut').innerHTML = `<div class="pdfbar"><span class="muted">${r.text.split(/\s+/).length} words · ${r.kind} letter</span><a class="btn sm" href="${fileUrl(r.pdf, Date.now())}" download="Sample_Cover_Letter.pdf">Download PDF</a></div><iframe class="pdfframe" title="Sample cover letter" src="${fileUrl(r.pdf, Date.now())}#toolbar=0&navpanes=0&view=FitH"></iframe>`;
    } catch (e) { $('#pvOut').textContent = e.message; } finally { ev.target.disabled = false; }
  };
};

// ---------- AI model logos ----------
const PROVIDER_ICONS = {
  ollama: { img: '/img/ai/ollama.webp' }, anthropic: { img: '/img/ai/anthropic.webp' }, openai: { img: '/img/ai/openai.webp' }, gemini: { img: '/img/ai/gemini.webp' },
};
const logoTile = (src, alt = '') => `<span class="logo-tile"><img src="${src}" alt="${esc(alt)}"></span>`;

// ---------- Share: one line a friend pastes into Terminal to get their own Joblin ----------
const INSTALL = 'curl -fsSL https://raw.githubusercontent.com/vishinoo/joblin/main/install.sh | bash';
const REPO = 'https://github.com/vishinoo/joblin';
const INVITE = `I've been using Joblin, a free job-application goblin that runs on your own Mac. It finds jobs, writes a tailored resume and cover letter for each one, and applies for you.\n\nTo get it, open Terminal and paste:\n${INSTALL}\n\nMore: ${REPO}`;
const copy = async (text, msg) => { try { await navigator.clipboard.writeText(text); toast(msg); } catch { toast('Couldn’t copy — select the text and copy it yourself', true); } };
$('#shareBtn').onclick = async () => {
  const p = ask({ title: 'Share Joblin with a friend', image: '/img/joblin-256.png', ok: 'Copy invite message', cancel: 'Close',
    body: `<p style="margin:0 0 10px">Joblin is free and runs on their own computer: their resumes, answers and passwords never touch yours. They paste one line into Terminal and he sets himself up.</p>
      <div class="share-line"><code>${esc(INSTALL)}</code><button type="button" class="btn sm" id="cpLine">Copy</button></div>
      <p class="muted" style="margin:10px 0 0;font-size:12.5px">Works on Mac and Linux. Or send them the page: <a class="link" href="${REPO}" target="_blank" rel="noopener">${REPO.replace('https://', '')}</a></p>` });
  $('#cpLine')?.addEventListener('click', () => copy(INSTALL, 'Install line copied'));
  if (await p) copy(INVITE, 'Invite copied — paste it in a message');
};

// ---------- Boot ----------
mountChat();
await refreshSummary();
loadSettings().catch(() => {});
render();
// Keep every page live: check for changes every 2s while Joblin works (5s otherwise) and redraw the page
// when something on it changed — but never while you're typing, choosing, or reading a dialog.
let lastSig = '';
const LIVE = ['dashboard', 'review', 'applications', 'answers', 'memory', 'outreach'];
const sig = () => JSON.stringify([S.byStatus, S.pendingAnswers, S.pendingReview, S.submitted, route() === 'dashboard' ? S.system.workers : null]);
(async function tick() {
  try {
    await refreshSummary();
    const now = sig();
    const busyHere = (document.activeElement && /INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName))
      || document.querySelector('.modal-back, .dd-menu:not([hidden]), .tip:not([hidden])')
      || $$('#view [data-pick]:checked').length || window.getSelection()?.toString();
    if (now !== lastSig && lastSig && !busyHere && LIVE.includes(route())) render();
    if (!busyHere) lastSig = now;
  } catch {}
  const WK = S.system?.workers || {};
  setTimeout(tick, WK.find?.state || WK.apply?.state ? 2000 : 5000);
})();
