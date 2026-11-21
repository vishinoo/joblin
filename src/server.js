import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, config, saveConfig, saveEnv, paths } from './config.js';
import { db, kv, addTask, log } from './db.js';
import { gmailReady, verifyGmail, resetTransport } from './mailer.js';
import { llmAvailable, PROVIDERS, testModel, currentModel } from './llm.js';
import { googleStatus, startGoogleAuth, disconnectGoogle } from './google.js';
import { listAnswers, setAnswer, deleteAnswer, pendingCount, listFacts, addFact, updateFact, deleteFacts, deleteAnswers, confirmAnswers, unblockedBy } from './memory.js';
import { getTemplate } from './cover.js';
import { DEFAULT_BOARDS } from './sources/boards.js';
import { chat, history as chatHistory, clearChat } from './chat.js';
import { tracks, CATALOG, addTrack, removeTrack, hasOwnResume, trackLabel, templateFileFor } from './tracks.js';
import { writeCoverLetter, analyzeJob } from './cover.js';
import { senderAddress } from './mailer.js';
import { linkedinStatus, connectLinkedIn, disconnectLinkedIn, isBrowserBusy, showBrowser, heldOpen } from './browser.js';
import { importResume, confirmResume, parseQuality } from './resumeImport.js';
import { getResume, renderLetter, renderResumePreview, chooseTrack, renderSampleLetter } from './documents.js';
import { prepareJob, suggestAnswer } from './apply.js';

const SUGGESTED = {
  swe: ['Software Engineer Intern', 'Software Developer Intern', 'New Grad Software Engineer', 'Backend Engineer Intern', 'Full Stack Developer Intern', 'Machine Learning Intern', 'AI Engineer Intern', 'Data Engineer Intern', 'Data Analyst Intern'],
  finance: ['Investment Banking Summer Analyst', 'Finance Intern', 'Private Equity Intern', 'Equity Research Intern', 'Corporate Finance Intern', 'Venture Capital Intern', 'FP&A Intern', 'Financial Analyst Intern', 'Capital Markets Intern'],
};

function publicSettings() {
  const c = structuredClone(config);
  if (c.email?.hunterApiKey) c.email.hunterApiKey = '••••' + c.email.hunterApiKey.slice(-4);
  c.llm.keys = Object.fromEntries(Object.entries(PROVIDERS).filter(([, v]) => v.key).map(([k, v]) => [k, process.env[v.key] ? '••••' + process.env[v.key].slice(-4) : '']));
  c.llm.providers = Object.fromEntries(Object.entries(PROVIDERS).map(([k, v]) => [k, { label: v.label, defaultModel: v.defaultModel }]));
  c.sources.boards.defaults = DEFAULT_BOARDS;
  c.coverLetter.defaultTemplates = Object.fromEntries(tracks().map((t) => [t.id, fs.readFileSync(templateFileFor(t.id), 'utf8')]));
  c.coverLetter.activeTemplates = Object.fromEntries(tracks().map((t) => [t.id, getTemplate(t.id)]));
  c.trackList = tracks().map((t) => ({ id: t.id, label: t.label }));
  return c;
}

export function startServer(actions) {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(express.static(path.join(ROOT, 'public')));
  const sendErr = (res, e, code = 400) => res.status(code).json({ error: e.message || String(e) });

  // ---------- Overview ----------
  app.get('/api/summary', async (_req, res) => {
    const count = (sql) => db.prepare(sql).get().n;
    const byStatus = Object.fromEntries(db.prepare('SELECT status, COUNT(*) n FROM applications GROUP BY status').all().map((r) => [r.status, r.n]));
    const sent = count(`SELECT COUNT(*) n FROM emails WHERE status IN ('sent','replied','bounced')`);
    const replied = count(`SELECT COUNT(*) n FROM emails WHERE status = 'replied'`);
    res.json({
      jobs: count('SELECT COUNT(*) n FROM jobs'),
      byStatus,
      submitted: ['submitted', 'interview', 'offer', 'rejected'].reduce((n, s) => n + (byStatus[s] || 0), 0),
      pendingReview: byStatus.pending_approval || 0,
      emails: { sent, replied, bounced: count(`SELECT COUNT(*) n FROM emails WHERE status='bounced'`), queued: count(`SELECT COUNT(*) n FROM emails WHERE status='scheduled'`),
        today: count(`SELECT COUNT(*) n FROM emails WHERE sent_at IS NOT NULL AND date(sent_at,'localtime') = date('now','localtime')`), cap: config.email.dailyCap },
      openTasks: count('SELECT COUNT(*) n FROM tasks WHERE done = 0'),
      daily: db.prepare(`SELECT date(applied_at,'localtime') d, COUNT(*) n FROM applications WHERE applied_at IS NOT NULL AND applied_at > datetime('now','-30 days') GROUP BY d ORDER BY d`).all(),
      dailyEmails: db.prepare(`SELECT date(sent_at,'localtime') d, COUNT(*) n FROM emails WHERE sent_at IS NOT NULL AND sent_at > datetime('now','-30 days') GROUP BY d ORDER BY d`).all(),
      // Everything Joblin did per day: jobs found, applications written and sent, emails, replies.
      calendar: db.prepare(`SELECT date(created_at,'localtime') d, COUNT(*) n FROM events
        WHERE created_at > datetime('now','-112 days') AND type IN ('discover','prepare','apply','email','review','status','gmail','linkedin')
          AND message NOT LIKE 'Searching%' AND message NOT LIKE 'Scanned%' AND message NOT LIKE 'LinkedIn:%'
        GROUP BY d`).all(),
      heat: db.prepare(`SELECT CAST(strftime('%w', created_at, 'localtime') AS INT) dow, CAST(strftime('%H', created_at, 'localtime') AS INT) hr, COUNT(*) n
        FROM events WHERE type IN ('apply','email','prepare') AND created_at > datetime('now','-28 days') GROUP BY dow, hr`).all(),
      pendingAnswers: pendingCount(),
      contacts: count('SELECT COUNT(*) n FROM contacts'),
      avgScore: db.prepare(`SELECT ROUND(AVG(match_score)) n FROM applications WHERE match_score IS NOT NULL`).get().n || 0,
      system: {
        llm: await llmAvailable(), llmProvider: config.llm.provider || 'ollama', llmModel: currentModel(),
        gmail: gmailReady(), gmailUser: senderAddress(), google: googleStatus(), linkedin: linkedinStatus(),
        emailPaused: kv.get('emailPaused', false), worker: actions.status(), workers: actions.workers?.(), mode: config.mode, onboarded: config.onboarded,
        browser: config.apply.browser, lastRun: kv.get('lastRunAt', null), formWaiting: heldOpen(),
      },
    });
  });

  app.get('/api/applications', (_req, res) => res.json(db.prepare(`
    SELECT j.id, j.title, j.company, j.location, j.ats, j.apply_url, j.linkedin_url, a.track, a.status, a.notes, a.applied_at, a.updated_at,
      a.resume_path, a.cover_letter_path, a.match_score, a.proof_path, (SELECT COUNT(*) FROM contacts c WHERE c.job_id = j.id) contacts
    FROM jobs j JOIN applications a ON a.job_id = j.id ORDER BY a.updated_at DESC LIMIT 2000`).all()));

  app.patch('/api/applications/:id', (req, res) => {
    db.prepare(`UPDATE applications SET status = ?, updated_at = datetime('now') WHERE job_id = ?`).run(req.body.status, req.params.id);
    res.json({ ok: true });
  });

  // ---------- Batch review ----------
  app.get('/api/review', (_req, res) => {
    const rows = db.prepare(`SELECT j.id, j.title, j.company, j.location, j.ats, j.apply_url, j.linkedin_url, j.easy_apply,
        a.track, a.match_score, a.analysis, a.cover_letter_text, a.resume_path, a.cover_letter_path, a.letter_kind
      FROM jobs j JOIN applications a ON a.job_id = j.id WHERE a.status = 'pending_approval' ORDER BY a.match_score DESC`).all();
    const contacts = db.prepare('SELECT name, title, email, source FROM contacts WHERE job_id = ?');
    res.json(rows.map((r) => ({ ...r, analysis: JSON.parse(r.analysis || '{}'), contacts: contacts.all(r.id) })));
  });

  app.post('/api/review/decide', (req, res) => {
    const { approve = [], skip = [], applyNow = true } = req.body;
    const set = db.prepare(`UPDATE applications SET status = ?, updated_at = datetime('now') WHERE job_id = ? AND status = 'pending_approval'`);
    db.transaction(() => { approve.forEach((id) => set.run('approved', id)); skip.forEach((id) => set.run('skipped', id)); })();
    log('review', `Approved ${approve.length}, skipped ${skip.length}`);
    const started = applyNow && approve.length ? actions.apply() : false;
    res.json({ ok: true, started });
  });

  app.put('/api/applications/:id/letter', async (req, res) => {
    try {
      const a = db.prepare('SELECT cover_letter_path FROM applications WHERE job_id = ?').get(req.params.id);
      await renderLetter(path.dirname(a.cover_letter_path), String(req.body.text || ''));
      db.prepare(`UPDATE applications SET cover_letter_text = ?, updated_at = datetime('now') WHERE job_id = ?`).run(req.body.text, req.params.id);
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
  });

  // Bring Joblin's hidden Chrome window forward (a filled form is waiting for you).
  app.post('/api/browser/show', async (_req, res) => { await showBrowser(); res.json({ ok: true, waiting: heldOpen() }); });

  // Retry a stuck application: approve it again and run it in the Chrome window.
  app.post('/api/applications/:id/retry', (req, res) => {
    db.prepare(`UPDATE applications SET status = 'approved', updated_at = datetime('now') WHERE job_id = ?`).run(req.params.id);
    db.prepare(`UPDATE tasks SET done = 1 WHERE related_job_id = ? AND title LIKE 'Finish application%'`).run(req.params.id);
    res.json({ started: actions.apply() });
  });

  app.post('/api/applications/:id/regenerate', async (req, res) => {
    try {
      const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(req.params.id);
      if (req.body?.track) job.search_track = req.body.track;
      await prepareJob(job, { precise: req.body?.precise });
      res.json({ ok: true });
    } catch (e) { sendErr(res, e); }
  });

  // ---------- Outreach / tasks / events ----------
  app.get('/api/emails', (_req, res) => res.json(db.prepare(`
    SELECT e.id, e.kind, e.subject, e.body, e.status, e.scheduled_at, e.sent_at, e.replied_at, e.reply_snippet, e.error,
      c.name, c.email, c.source, c.confidence, j.company, j.title
    FROM emails e JOIN contacts c ON c.id = e.contact_id JOIN jobs j ON j.id = c.job_id
    ORDER BY COALESCE(e.replied_at, e.sent_at, e.scheduled_at) DESC LIMIT 2000`).all()));
  app.post('/api/emails/:id/cancel', (req, res) => { db.prepare(`UPDATE emails SET status='cancelled' WHERE id=? AND status='scheduled'`).run(req.params.id); res.json({ ok: true }); });
  app.post('/api/email/pause', (req, res) => { kv.set('emailPaused', Boolean(req.body.paused)); res.json({ ok: true }); });

  app.get('/api/tasks', (_req, res) => res.json(db.prepare('SELECT * FROM tasks WHERE done = 0 ORDER BY priority, created_at DESC LIMIT 500').all()));
  app.post('/api/tasks', (req, res) => res.json({ id: addTask(req.body) }));
  // Checking a task off deletes it.
  app.patch('/api/tasks/:id', (req, res) => {
    if (req.body.done) db.prepare('DELETE FROM tasks WHERE id = ?').run(req.params.id);
    else db.prepare('UPDATE tasks SET done = 0 WHERE id = ?').run(req.params.id);
    res.json({ ok: true });
  });
  app.get('/api/events', (_req, res) => res.json(db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 100').all()));

  app.get('/api/file', (req, res) => {
    const f = path.resolve(String(req.query.p || ''));
    if (!f.startsWith(paths.output) && !f.startsWith(paths.uploads)) return res.status(403).end();
    res.sendFile(f);
  });

  // ---------- Runs ----------
  app.post('/api/run', (req, res) => res.json({ started: actions.run(req.body || {}) }));

  // ---------- Settings ----------
  app.get('/api/settings', (_req, res) => res.json({ settings: publicSettings(), suggested: SUGGESTED }));
  app.put('/api/settings', (req, res) => {
    const patch = req.body || {};
    if (patch.email?.hunterApiKey?.startsWith('••••')) delete patch.email.hunterApiKey;
    delete patch.llm?.host;
    if (patch.llm) { delete patch.llm.providers; const keys = patch.llm.keys || {}; delete patch.llm.keys;
      const env = {}; for (const [prov, val] of Object.entries(keys)) if (PROVIDERS[prov]?.key && val && !String(val).startsWith('••••')) env[PROVIDERS[prov].key] = String(val).trim();
      if (Object.keys(env).length) saveEnv(env); }
    if (patch.sources?.boards) delete patch.sources.boards.defaults;
    if (patch.coverLetter) { delete patch.coverLetter.defaultTemplates; delete patch.coverLetter.activeTemplates; }
    saveConfig(patch);
    res.json({ settings: publicSettings() });
  });

  // ---------- Integrations ----------
  app.post('/api/integrations/gmail', async (req, res) => {
    const user = String(req.body.user || '').trim(), pass = String(req.body.pass || '').replace(/\s+/g, '');
    try {
      await verifyGmail(user, pass);
      saveEnv({ GMAIL_USER: user, GMAIL_APP_PASSWORD: pass });
      resetTransport();
      log('gmail', `Gmail connected (${user})`);
      res.json({ ok: true });
    } catch (e) { sendErr(res, new Error(/Invalid login|535|Username and Password/i.test(e.message) ? 'Google rejected that address / app password.' : e.message)); }
  });
  app.delete('/api/integrations/gmail', (_req, res) => { saveEnv({ GMAIL_USER: '', GMAIL_APP_PASSWORD: '' }); resetTransport(); res.json({ ok: true }); });

  app.post('/api/integrations/linkedin/connect', (_req, res) => {
    if (isBrowserBusy() || actions.status().state) return sendErr(res, new Error('Joblin is busy — try again when the current run finishes.'), 409);
    connectLinkedIn().catch((e) => log('error', `linkedin: ${e.message}`));
    res.json({ ok: true, message: 'A LinkedIn window opened — sign in there.' });
  });
  app.post('/api/integrations/linkedin/disconnect', async (_req, res) => {
    if (isBrowserBusy()) return sendErr(res, new Error('Joblin is busy.'), 409);
    await disconnectLinkedIn(); res.json({ ok: true });
  });

  // ---------- Resumes ----------
  app.get('/api/resumes/:track', (req, res) => {
    const t = req.params.track;
    if (!tracks().some((x) => x.id === t)) return res.status(404).end();
    const r = getResume(t);
    res.json({ resume: r, quality: parseQuality(r), file: config.resumes?.[t] || {}, own: hasOwnResume(t), label: trackLabel(t) });
  });
  app.post('/api/resumes/:track/upload', express.raw({ type: '*/*', limit: '15mb' }), async (req, res) => {
    const t = req.params.track;
    if (!tracks().some((x) => x.id === t)) return res.status(404).end();
    try { res.json(await importResume(t, decodeURIComponent(req.get('x-filename') || 'resume.pdf'), req.body)); } catch (e) { sendErr(res, e); }
  });
  app.post('/api/resumes/:track/confirm', (req, res) => {
    try { confirmResume(req.params.track, req.body.resume); res.json({ ok: true }); } catch (e) { sendErr(res, e); }
  });
  app.post('/api/resumes/:track/preview', async (req, res) => {
    try { res.json({ path: await renderResumePreview(req.params.track) }); } catch (e) { sendErr(res, e); }
  });

  // ---------- Google sign-in (Gmail) ----------
  app.post('/api/integrations/google/start', async (_req, res) => {
    try { res.json({ url: await startGoogleAuth() }); } catch (e) { sendErr(res, e); }
  });
  app.delete('/api/integrations/google', (_req, res) => { disconnectGoogle(); res.json({ ok: true }); });

  // ---------- AI model ----------
  app.post('/api/llm/test', async (_req, res) => { try { res.json(await testModel()); } catch (e) { sendErr(res, e); } });
  app.delete('/api/llm/keys/:provider', (req, res) => { const k = PROVIDERS[req.params.provider]?.key; if (k) saveEnv({ [k]: '' }); res.json({ ok: true }); });

  // ---------- Saved answers ----------
  app.get('/api/answers', (_req, res) => res.json(listAnswers()));
  // When an answer unblocks applications, send them straight back through.
  const requeue = (answerId) => {
    const jobs = unblockedBy(answerId);
    for (const j of jobs) {
      db.prepare(`UPDATE applications SET status = 'approved', notes = 'Your answer was saved — applying again', updated_at = datetime('now') WHERE job_id = ? AND status IN ('needs_review','failed')`).run(j);
      db.prepare(`DELETE FROM tasks WHERE related_job_id = ? AND done = 0 AND (title LIKE 'Answer %' OR title LIKE 'Finish application%')`).run(j);
    }
    if (jobs.length) { log('apply', `${jobs.length} application${jobs.length === 1 ? '' : 's'} back in the queue after your answer`); actions.apply(); }
    return jobs.length;
  };
  app.put('/api/answers/:id', (req, res) => {
    const answer = String(req.body.answer ?? '').trim();
    setAnswer(+req.params.id, answer);
    res.json({ ok: true, requeued: answer ? requeue(+req.params.id) : 0 });
  });
  app.delete('/api/answers/:id', (req, res) => { deleteAnswer(+req.params.id); res.json({ ok: true }); });

  // ---------- Chat ----------
  app.get('/api/chat', (_req, res) => res.json(chatHistory()));
  app.post('/api/chat', async (req, res) => { try { res.json(await chat(req.body.message, actions)); } catch (e) { sendErr(res, e); } });
  app.delete('/api/chat', (_req, res) => { clearChat(); res.json({ ok: true }); });

  // ---------- Resume types ----------
  app.get('/api/tracks', (_req, res) => res.json({ tracks: tracks().map((t) => ({ id: t.id, label: t.label, base: t.base, own: hasOwnResume(t.id) })), catalog: CATALOG.map((c) => ({ id: c.id, label: c.label })) }));
  app.post('/api/tracks', (req, res) => { try { res.json({ id: addTrack(String(req.body.name || '').trim()) }); } catch (e) { sendErr(res, e); } });
  app.delete('/api/tracks/:id', (req, res) => { try { removeTrack(req.params.id); res.json({ ok: true }); } catch (e) { sendErr(res, e); } });

  // ---------- Memory: facts about you + saved answers ----------
  app.get('/api/memory', (_req, res) => res.json({ facts: listFacts(), answers: listAnswers().filter((a) => a.source !== 'pending') }));
  app.post('/api/facts', (req, res) => res.json({ id: addFact(req.body.text, req.body.category) }));
  app.put('/api/facts/:id', (req, res) => { updateFact(+req.params.id, req.body.text, req.body.category); res.json({ ok: true }); });
  app.post('/api/facts/delete', (req, res) => { deleteFacts((req.body.ids || []).map(Number)); res.json({ ok: true }); });
  app.post('/api/answers/bulk', async (req, res) => {
    const ids = (req.body.ids || []).map(Number);
    if (req.body.action === 'delete') deleteAnswers(ids);
    else if (req.body.action === 'confirm') confirmAnswers(ids);
    else if (req.body.action === 'suggest') {
      const all = listAnswers(); let n = 0;
      let rq = 0;
      for (const id of ids) { const a = all.find((x) => x.id === id); if (!a) continue; const ans = await suggestAnswer(a.question, a.options); if (ans) { setAnswer(id, ans); n++; rq += requeue(id); } }
      return res.json({ ok: true, answered: n, requeued: rq });
    }
    res.json({ ok: true });
  });

  // ---------- Transcript (optional, used when a form asks for one) ----------
  app.post('/api/profile/transcript', express.raw({ type: '*/*', limit: '20mb' }), (req, res) => {
    const name = decodeURIComponent(req.get('x-filename') || 'transcript.pdf');
    const ext = (path.extname(name) || '.pdf').toLowerCase();
    if (!['.pdf', '.png', '.jpg', '.jpeg', '.docx'].includes(ext)) return sendErr(res, new Error('Upload a PDF, image or Word file'));
    const dest = path.join(paths.uploads, `transcript${ext}`);
    fs.writeFileSync(dest, req.body);
    saveConfig({ profile: { transcriptFile: dest, transcriptName: name } });
    res.json({ ok: true, name });
  });
  app.delete('/api/profile/transcript', (_req, res) => {
    try { if (config.profile.transcriptFile) fs.unlinkSync(config.profile.transcriptFile); } catch {}
    saveConfig({ profile: { transcriptFile: '', transcriptName: '' } }); res.json({ ok: true });
  });

  // ---------- Cover letter preview ----------
  app.post('/api/cover/preview', async (req, res) => {
    try {
      const fin = req.body.track === 'finance';
      const job = { id: 0, title: req.body.title || (fin ? 'Investment Banking Summer Analyst' : 'Software Engineer Intern'), company: req.body.company || 'Northwind',
        description: req.body.description || (fin
          ? 'Summer analysts support deal teams on M&A and capital markets transactions: building financial models (DCF, comparables), preparing pitch materials, and researching industries. You have strong Excel skills, attention to detail, and clear communication.'
          : 'Interns build backend services and internal tools with Python and TypeScript, work with data pipelines, and ship features end to end with a mentor. You are comfortable with APIs and databases and enjoy owning problems.') };
      const track = req.body.track || await chooseTrack(job);
      const analysis = await analyzeJob(job);
      const out = await writeCoverLetter(job, track, getResume(track), analysis, { precise: Boolean(req.body.precise) });
      res.json({ ...out, pdf: await renderSampleLetter(out.text) });
    } catch (e) { sendErr(res, e); }
  });

  app.listen(config.dashboard.port, () => console.log(`\n  Joblin → http://localhost:${config.dashboard.port}\n`));
}
