// "Sign in with Google" for Gmail, using the same pathway as Noctus and Grove: Google sign-in through
// Noctus's Supabase project, which returns your Google tokens. Supabase sends the browser back to
// http://localhost:5173/auth (the address Noctus already has approved), so during sign-in Joblin listens
// there for a moment, exchanges the code, and stores the Gmail tokens. Refreshing them goes straight
// to Google with the same OAuth client.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import MailComposer from 'nodemailer/lib/mail-composer/index.js';
import { paths } from './config.js';
import { log } from './db.js';

const TOKENS = path.join(paths.data, 'google-tokens.json');
const RETURN_PORT = Number(process.env.SUPABASE_RETURN_PORT || 5173);
const RETURN_URL = process.env.SUPABASE_RETURN_URL || `http://localhost:${RETURN_PORT}/auth`;
const SCOPES = ['https://www.googleapis.com/auth/gmail.send', 'https://www.googleapis.com/auth/gmail.readonly'];

const read = () => { try { return JSON.parse(fs.readFileSync(TOKENS, 'utf8')); } catch { return null; } };
const write = (t) => fs.writeFileSync(TOKENS, JSON.stringify(t, null, 2), { mode: 0o600 });
export const googleConfigured = () => Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
export const googleStatus = () => { const t = read(); return { configured: googleConfigured(), connected: Boolean(t?.refresh_token), email: t?.email || '' }; };
export function disconnectGoogle() {
  const t = read();
  if (t?.refresh_token) fetch(`https://oauth2.googleapis.com/revoke?token=${t.refresh_token}`, { method: 'POST' }).catch(() => {});
  try { fs.unlinkSync(TOKENS); } catch {}
}

let pending = null;
const b64url = (buf) => buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

export function startGoogleAuth() {
  if (!googleConfigured()) throw new Error('Google sign-in isn’t set up. It needs SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET in .env.');
  pending?.server.close();
  const verifier = b64url(crypto.randomBytes(48));
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest());
  const url = `${process.env.SUPABASE_URL}/auth/v1/authorize?${new URLSearchParams({
    provider: 'google', redirect_to: RETURN_URL, code_challenge: challenge, code_challenge_method: 's256',
    scopes: SCOPES.join(' '), access_type: 'offline', prompt: 'consent',
  })}`;
  return new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      const u = new URL(req.url, RETURN_URL);
      const page = (msg) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(`<body style="font:16px system-ui;background:#1c1d21;color:#ecebe8;display:grid;place-items:center;height:100vh;margin:0"><div style="text-align:center"><img src="http://localhost:4321/img/joblin-256.png" width="120"><p>${msg}</p></div></body>`); };
      if (!u.searchParams.get('code') && !u.searchParams.get('error')) { page('Waiting for Google…'); return; }
      try {
        if (u.searchParams.get('error')) throw new Error(u.searchParams.get('error_description') || u.searchParams.get('error'));
        const r = await fetch(`${process.env.SUPABASE_URL}/auth/v1/token?grant_type=pkce`, {
          method: 'POST', headers: { apikey: process.env.SUPABASE_ANON_KEY, 'content-type': 'application/json' },
          body: JSON.stringify({ auth_code: u.searchParams.get('code'), code_verifier: verifier }) });
        const sess = await r.json();
        if (!sess.provider_token) throw new Error(sess.error_description || sess.msg || 'Google didn’t return Gmail access');
        if (!sess.provider_refresh_token) throw new Error('Google didn’t return a refresh token — remove Joblin/Noctus from myaccount.google.com/permissions and try again');
        write({ access_token: sess.provider_token, refresh_token: sess.provider_refresh_token, email: sess.user?.email, expires_at: Date.now() + 50 * 60 * 1000 });
        log('gmail', `Gmail connected (${sess.user?.email})`);
        page('Joblin is connected to Gmail. You can close this tab.');
      } catch (e) {
        log('error', `google sign-in: ${e.message}`);
        page(`Google sign-in didn’t finish: ${String(e.message).replace(/</g, '&lt;')}<br>Close this tab and try again.`);
      } finally { setTimeout(() => server.close(), 500); pending = null; }
    });
    server.once('error', (e) => reject(e.code === 'EADDRINUSE'
      ? new Error(`Port ${RETURN_PORT} is busy (is the Noctus frontend running?). Stop it, then connect again.`) : e));
    server.listen(RETURN_PORT, '127.0.0.1', () => {
      pending = { server };
      setTimeout(() => server.close(), 10 * 60 * 1000);
      spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
      resolve(url);
    });
  });
}

async function accessToken() {
  const t = read();
  if (!t?.refresh_token) throw new Error('Gmail not connected');
  if (t.access_token && Date.now() < t.expires_at) return t.access_token;
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ refresh_token: t.refresh_token, client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, grant_type: 'refresh_token' }) });
  const n = await r.json();
  if (!n.access_token) throw new Error(`Google token refresh failed: ${n.error_description || n.error}`);
  write({ ...t, access_token: n.access_token, expires_at: Date.now() + (n.expires_in - 60) * 1000 });
  return n.access_token;
}

async function gapi(url, opts = {}) {
  const r = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${url}`, { ...opts, headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json', ...(opts.headers || {}) } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`Gmail ${r.status}: ${j.error?.message || ''}`);
  return j;
}

export async function gmailSend(mail) {
  const raw = await new Promise((res, rej) => new MailComposer(mail).compile().build((e, m) => (e ? rej(e) : res(m))));
  const j = await gapi('messages/send', { method: 'POST', body: JSON.stringify({ raw: raw.toString('base64url') }) });
  const sent = await gapi(`messages/${j.id}?format=metadata&metadataHeaders=Message-ID`);
  return { messageId: sent.payload?.headers?.find((h) => /message-id/i.test(h.name))?.value || j.id };
}

const b64 = (s) => Buffer.from(String(s || '').replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
function bodyText(part) {
  if (!part) return '';
  if (part.mimeType === 'text/plain' && part.body?.data) return b64(part.body.data);
  for (const p of part.parts || []) { const t = bodyText(p); if (t) return t; }
  if (part.mimeType === 'text/html' && part.body?.data) return b64(part.body.data).replace(/<[^>]+>/g, ' ');
  return '';
}

// New inbox messages since `afterMs`, as {id, from, subject, text, date}.
export async function gmailRecent(afterMs) {
  const q = `in:inbox after:${Math.floor(afterMs / 1000)}`;
  const list = await gapi(`messages?q=${encodeURIComponent(q)}&maxResults=100`);
  const out = [];
  for (const { id } of list.messages || []) {
    const m = await gapi(`messages/${id}?format=full`);
    const h = (n) => m.payload?.headers?.find((x) => x.name.toLowerCase() === n)?.value || '';
    out.push({ id, from: (h('from').match(/<([^>]+)>/)?.[1] || h('from')).toLowerCase(), subject: h('subject'), text: bodyText(m.payload).replace(/\s+/g, ' ').slice(0, 3000), date: Number(m.internalDate) });
  }
  return out;
}
