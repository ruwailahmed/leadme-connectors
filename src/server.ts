import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, save, uid, DATA_DIR, hydrate, flush, remote, serverless, CAP } from './store.ts';
import { buildCriteria, classify, questionsFor } from './classifier.ts';
import { demoAdapter, demoMessage } from './adapters/demo.ts';
import { slackAdapter } from './adapters/slack.ts';
import { discordAdapter } from './adapters/discord.ts';
import type { Account, Adapter, Alert, Monitor, NormalizedMessage, Target } from './types.ts';

const PORT = Number(process.env.PORT ?? 4310);
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const adapterFor = (a: Account): Adapter => a.mode === 'demo' ? demoAdapter : a.platform === 'slack' ? slackAdapter : discordAdapter;
const clients = new Set<ServerResponse>();
const seen = new Set<string>();
const safeAccount = ({ token: _t, ...a }: Account) => ({ ...a, hasToken: !!_t });

function emit(event: string, data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}

async function outbound(alert: Alert) {
  const m = alert.message;
  const line = `🎯 ${alert.monitorName} — ${m.author.name} in ${m.workspace} #${m.channel}: ${m.text.slice(0, 300)}\n${m.permalink}\nWhy: ${alert.reason}`;
  const jobs: Promise<unknown>[] = [];
  const post = (url: string | undefined, body: unknown) => url && jobs.push(fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) }).catch(e => console.error('push failed', e.message)));
  post(process.env.DISCORD_ALERT_WEBHOOK, { content: line });
  post(process.env.SLACK_ALERT_WEBHOOK, { text: line });
  post(process.env.LEADME_WEBHOOK_URL, { type: 'message.received', alert_id: alert.id, monitor: alert.monitorName, reason: alert.reason, message: m });
  await Promise.all(jobs);
}

async function handleMessage(msg: NormalizedMessage) {
  if (seen.has(msg.id)) return;
  seen.add(msg.id); if (seen.size > 20000) seen.delete(seen.values().next().value!);
  db.history.push(msg); if (db.history.length > CAP.history) db.history.splice(0, db.history.length - CAP.history);
  for (const mon of db.monitors) {
    if (mon.status !== 'listening' || !mon.criteria) continue;
    if (!mon.targets.some(t => t.accountId === msg.accountId && t.channelId === msg.channelId && t.workspaceId === msg.workspaceId)) continue;
    const v = await classify(mon.description, mon.criteria, msg);
    if (!v.match) continue;
    const alert: Alert = { id: uid('al'), monitorId: mon.id, monitorName: mon.name, message: msg, reason: v.reason, status: 'new', createdAt: Date.now(), replies: [] };
    mon.matches++; db.alerts.unshift(alert); if (db.alerts.length > CAP.alerts) db.alerts.length = CAP.alerts;
    emit('alert', alert); void outbound(alert);
  }
  save();
}

const sinceByAccount = { get: (k: string) => db.cursors[k], set: (k: string, v: number) => { db.cursors[k] = v; } };
const failures = new Map<string, number>();
const lastRun = new Map<string, number>();
async function tick() {
  for (const a of db.accounts) {
    const every = a.mode === 'demo' ? 4000 : 15000;
    if (Date.now() - (lastRun.get(a.id) ?? 0) < every) continue;
    lastRun.set(a.id, Date.now());
    const targets = new Map<string, Target>();
    for (const m of db.monitors) if (m.status === 'listening') for (const t of m.targets) if (t.accountId === a.id) targets.set(t.workspaceId + t.channelId, t);
    if (!targets.size) continue;
    try {
      const since = sinceByAccount.get(a.id) ?? Date.now() - 1000;
      const msgs = await adapterFor(a).poll(a, [...targets.values()], since);
      sinceByAccount.set(a.id, Date.now());
      for (const m of msgs.sort((x, y) => x.ts - y.ts)) await handleMessage(m);
      if (a.status !== 'healthy' && a.mode === 'live') { a.status = 'healthy'; a.statusNote = undefined; emit('account', safeAccount(a)); }
      failures.set(a.id, 0); a.lastSync = Date.now();
    } catch (e: any) {
      const n = (failures.get(a.id) ?? 0) + 1; failures.set(a.id, n);
      a.status = n >= 3 ? 'disconnected' : 'degraded'; a.statusNote = e.message;
      emit('account', safeAccount(a)); save();
    }
  }
}
if (!serverless) setInterval(() => tick().catch(e => console.error('tick', e)), 1000);

function seedHistory(a: Account, t: Target) {
  if (a.mode !== 'demo') return;
  for (let i = 0; i < 40; i++) { const m = demoMessage(a, t); m.ts -= (i + 1) * 3_600_000; m.id += `-h${i}`; db.history.push(m); }
}

// ---------- routing ----------
type Ctx = { body: any; params: string[]; url: URL };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), h]);
const getAccount = (id: string) => { const a = db.accounts.find(x => x.id === id); if (!a) throw Object.assign(new Error('account not found'), { status: 404 }); return a; };
const getMonitor = (id: string) => { const m = db.monitors.find(x => x.id === id); if (!m) throw Object.assign(new Error('monitor not found'), { status: 404 }); return m; };
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

route('GET', '/api/accounts', () => db.accounts.map(safeAccount));
route('POST', '/api/accounts', async ({ body }) => {
  if (!['slack', 'discord'].includes(body.platform)) throw bad('platform must be slack or discord');
  const live = body.mode === 'live';
  if (live && !body.token) throw bad('token required for live mode');
  const a: Account = { id: uid('acc'), platform: body.platform, mode: live ? 'live' : 'demo', label: String(body.label || `${body.platform} account`).slice(0, 60),
    email: String(body.email || 'demo@leadme.app').slice(0, 80), token: live ? String(body.token) : undefined, status: 'healthy', createdAt: Date.now() };
  if (live) { try { const r = await adapterFor(a).check(a); a.email = r.identity ?? a.email; } catch (e: any) { throw bad(`could not verify credentials: ${e.message}`); } }
  db.accounts.push(a); save(); emit('account', safeAccount(a));
  return safeAccount(a);
});
route('DELETE', '/api/accounts/:id', ({ params }) => {
  const a = getAccount(params[0]); db.accounts = db.accounts.filter(x => x !== a);
  for (const m of db.monitors) m.targets = m.targets.filter(t => t.accountId !== a.id);
  save(); emit('account_removed', { id: a.id }); return { ok: true };
});
route('POST', '/api/accounts/:id/simulate', ({ params, body }) => {
  const a = getAccount(params[0]); if (a.mode !== 'demo') throw bad('only demo accounts can be simulated');
  a.status = body.status === 'disconnected' ? 'disconnected' : body.status === 'degraded' ? 'degraded' : 'healthy';
  a.statusNote = a.status === 'healthy' ? undefined : a.status === 'degraded' ? 'Rate limited by provider, backing off' : 'Session expired — reconnect required';
  save(); emit('account', safeAccount(a)); return safeAccount(a);
});
route('POST', '/api/accounts/:id/reconnect', async ({ params }) => {
  const a = getAccount(params[0]);
  try { await adapterFor(a).check(a); a.status = 'healthy'; a.statusNote = undefined; failures.set(a.id, 0); }
  catch (e: any) { a.status = 'disconnected'; a.statusNote = e.message; }
  save(); emit('account', safeAccount(a)); return safeAccount(a);
});
route('GET', '/api/accounts/:id/workspaces', ({ params }) => { const a = getAccount(params[0]); return adapterFor(a).workspaces(a); });
route('GET', '/api/accounts/:id/workspaces/:wid/channels', ({ params }) => { const a = getAccount(params[0]); return adapterFor(a).channels(a, params[1]); });

route('GET', '/api/monitors', () => db.monitors);
route('POST', '/api/monitors', ({ body }) => {
  const description = String(body.description ?? '').trim();
  if (description.length < 8) throw bad('describe what you are looking for (at least a sentence)');
  const m: Monitor = { id: uid('mon'), name: String(body.name || description.split(/\s+/).slice(0, 5).join(' ')).slice(0, 60), description, status: 'draft', targets: [], matches: 0, createdAt: Date.now() };
  db.monitors.push(m); save(); return { monitor: m, questions: questionsFor(description) };
});
route('POST', '/api/monitors/:id/confirm', ({ params, body }) => {
  const m = getMonitor(params[0]);
  const a = body.answers ?? {};
  m.criteria = buildCriteria(m.description, { strict: a.strict, ignoreSellers: a.ignoreSellers });
  if (a.qualifiers === false) m.criteria.qualifiers = [];
  m.criteria.summary = buildCriteria(m.description, { strict: m.criteria.strict, ignoreSellers: m.criteria.ignoreSellers }).summary;
  if (a.qualifiers === false) m.criteria.summary = m.criteria.summary.replace(/, and the message must also mention:[^.]*/, '');
  save(); return m;
});
route('POST', '/api/monitors/:id/test', async ({ params, body }) => {
  const m = getMonitor(params[0]); if (!m.criteria) throw bad('confirm the monitor first');
  return classify(m.description, m.criteria, { text: String(body.text ?? '').slice(0, 4000) });
});
route('POST', '/api/monitors/:id/replay', async ({ params }) => {
  const m = getMonitor(params[0]); if (!m.criteria) throw bad('confirm the monitor first');
  const pool = db.history.filter(h => !m.targets.length || m.targets.some(t => t.accountId === h.accountId && t.channelId === h.channelId)).slice(-120);
  const out = [];
  for (const msg of pool) { const v = await classify(m.description, m.criteria, msg); if (v.match) out.push({ message: msg, reason: v.reason }); }
  return { scanned: pool.length, matches: out.length, results: out.slice(-20).reverse() };
});
route('PUT', '/api/monitors/:id/targets', ({ params, body }) => {
  const m = getMonitor(params[0]);
  if (!Array.isArray(body.targets)) throw bad('targets must be an array');
  const next: Target[] = body.targets.map((t: any) => { getAccount(t.accountId); return { accountId: String(t.accountId), workspaceId: String(t.workspaceId), channelId: String(t.channelId), label: String(t.label ?? '') }; });
  for (const t of next) if (!m.targets.some(o => o.accountId === t.accountId && o.channelId === t.channelId)) seedHistory(getAccount(t.accountId), t);
  m.targets = next; save(); return m;
});
route('POST', '/api/monitors/:id/deploy', ({ params }) => {
  const m = getMonitor(params[0]);
  if (!m.criteria) throw bad('confirm the monitor first');
  if (!m.targets.length) throw bad('pick at least one channel to listen to');
  m.status = 'listening'; for (const t of m.targets) sinceByAccount.set(t.accountId, Date.now()); save(); emit('monitor', m); return m;
});
route('POST', '/api/monitors/:id/pause', ({ params }) => { const m = getMonitor(params[0]); m.status = 'paused'; save(); emit('monitor', m); return m; });
route('DELETE', '/api/monitors/:id', ({ params }) => { db.monitors = db.monitors.filter(m => m.id !== params[0]); save(); return { ok: true }; });

route('GET', '/api/alerts', ({ url }) => {
  const s = url.searchParams.get('status'); const mon = url.searchParams.get('monitor');
  return db.alerts.filter(a => (!s || a.status === s) && (!mon || a.monitorId === mon)).slice(0, 300);
});
route('PATCH', '/api/alerts/:id', ({ params, body }) => {
  const a = db.alerts.find(x => x.id === params[0]); if (!a) throw Object.assign(new Error('alert not found'), { status: 404 });
  if (!['new', 'read', 'contacted', 'bad_match'].includes(body.status)) throw bad('invalid status');
  a.status = body.status; save(); emit('alert_updated', a); return a;
});
route('POST', '/api/alerts/:id/reply', async ({ params, body }) => {
  const a = db.alerts.find(x => x.id === params[0]); if (!a) throw Object.assign(new Error('alert not found'), { status: 404 });
  const text = String(body.text ?? '').trim(); if (!text) throw bad('message is empty');
  const acc = getAccount(a.message.accountId);
  if (a.replies.length >= 3) throw bad('reply limit reached for this lead');
  await adapterFor(acc).send(acc, a.message.workspaceId, a.message.channelId, text, body.dm ? a.message.author.id : undefined);
  a.replies.push({ text, ts: Date.now() }); a.status = 'contacted'; save(); emit('alert_updated', a); return a;
});
route('GET', '/api/alerts.csv', () => {
  const esc = (v: unknown) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const rows = [['time', 'monitor', 'platform', 'workspace', 'channel', 'author', 'message', 'reason', 'status', 'link'],
    ...db.alerts.map(a => [new Date(a.message.ts).toISOString(), a.monitorName, a.message.source, a.message.workspace, a.message.channel, a.message.author.name, a.message.text, a.reason, a.status, a.message.permalink])];
  return { __csv: rows.map(r => r.map(esc).join(',')).join('\n') };
});

// ---------- AI connection: sign in with Claude (subscription) or paste a key ----------
const SECRET = `${DATA_DIR}/secret.json`;
if (!process.env.ANTHROPIC_API_KEY && existsSync(SECRET)) { try { process.env.ANTHROPIC_API_KEY = JSON.parse(readFileSync(SECRET, 'utf8')).key; } catch { /* ignore */ } }
let loginProc: ReturnType<typeof spawn> | undefined;
const cli = (args: string[]) => new Promise<string>(res => execFile('claude', args, { timeout: 15000 }, (_e, out) => res(String(out ?? ''))));
async function aiStatus() {
  if (process.env.ANTHROPIC_API_KEY) return { connected: true, method: 'API key', plan: null, loggingIn: false };
  try { const j = JSON.parse(await cli(['auth', 'status'])); return { connected: !!j.loggedIn, method: j.loggedIn ? 'Claude subscription' : null, plan: j.subscriptionType ?? null, loggingIn: !!loginProc }; }
  catch { return { connected: false, method: null, plan: null, loggingIn: !!loginProc, cliMissing: true }; }
}
route('GET', '/api/ai', () => aiStatus());
route('POST', '/api/ai/login', () => {
  if (loginProc) return { started: true };
  loginProc = spawn('claude', ['auth', 'login', '--claudeai'], { stdio: 'ignore' });
  const done = () => { loginProc = undefined; };
  loginProc.on('exit', done); loginProc.on('error', done); setTimeout(() => { loginProc?.kill(); }, 300000);
  return { started: true };
});
route('POST', '/api/ai/key', ({ body }) => {
  const key = String(body.key ?? '').trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(key)) throw bad('that does not look like an Anthropic API key');
  process.env.ANTHROPIC_API_KEY = key; mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(SECRET, JSON.stringify({ key }), { mode: 0o600 });
  return aiStatus();
});
route('DELETE', '/api/ai/key', () => { delete process.env.ANTHROPIC_API_KEY; try { writeFileSync(SECRET, '{}', { mode: 0o600 }); } catch { /* ignore */ } return aiStatus(); });

route('GET', '/api/stats', () => ({
  accounts: db.accounts.length, healthy: db.accounts.filter(a => a.status === 'healthy').length,
  listening: db.monitors.filter(m => m.status === 'listening').length,
  channels: new Set(db.monitors.filter(m => m.status === 'listening').flatMap(m => m.targets.map(t => t.accountId + t.channelId))).size,
  alerts: db.alerts.length, unread: db.alerts.filter(a => a.status === 'new').length,
  sse: !serverless, persistent: !serverless || remote, ai: (process.env.CLASSIFIER === 'rules' || serverless) && !process.env.ANTHROPIC_API_KEY ? 'rules' : 'llm',
}));

// ---------- OAuth: official "Connect" buttons (no cookie/token copying) ----------
const BASE_URL = () => process.env.PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ?? `http://localhost:${PORT}`;
const oauthCfg = () => ({
  slack: !!(process.env.SLACK_CLIENT_ID && process.env.SLACK_CLIENT_SECRET),
  discord: !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET),
  discordBot: !!process.env.DISCORD_BOT_TOKEN,
});
const states = new Map<string, { platform: string; at: number }>();
const SLACK_SCOPES = 'channels:read,channels:history,users:read,team:read,chat:write,im:write';
function oauthStart(platform: 'slack' | 'discord', res: ServerResponse) {
  const cfg = oauthCfg(); if (!cfg[platform]) { res.writeHead(400, { 'content-type': 'text/plain' }); return void res.end(`${platform} OAuth is not configured. See README.`); }
  const state = uid('st'); states.set(state, { platform, at: Date.now() });
  const redirect = encodeURIComponent(`${BASE_URL()}/oauth/${platform}/callback`);
  const url = platform === 'slack'
    ? `https://slack.com/oauth/v2/authorize?client_id=${process.env.SLACK_CLIENT_ID}&user_scope=${SLACK_SCOPES}&redirect_uri=${redirect}&state=${state}`
    : `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&response_type=code&scope=identify%20guilds&redirect_uri=${redirect}&state=${state}`;
  res.writeHead(302, { location: url }); res.end();
}
async function oauthCallback(platform: 'slack' | 'discord', url: URL, res: ServerResponse) {
  const st = states.get(url.searchParams.get('state') ?? ''); states.delete(url.searchParams.get('state') ?? '');
  const code = url.searchParams.get('code');
  const back = (q: string) => { res.writeHead(302, { location: `/?${q}` }); res.end(); };
  if (!st || st.platform !== platform || Date.now() - st.at > 600_000 || !code) return back('oauth=failed');
  const redirect_uri = `${BASE_URL()}/oauth/${platform}/callback`;
  try {
    let a: Account;
    if (platform === 'slack') {
      const r = await fetch('https://slack.com/api/oauth.v2.access', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.SLACK_CLIENT_ID!, client_secret: process.env.SLACK_CLIENT_SECRET!, code, redirect_uri }) });
      const j = await r.json() as any; if (!j.ok || !j.authed_user?.access_token) return back('oauth=failed');
      a = { id: uid('acc'), platform: 'slack', mode: 'live', label: j.team?.name ?? 'Slack', email: j.team?.name ?? 'Slack workspace', token: j.authed_user.access_token, status: 'healthy', createdAt: Date.now() };
    } else {
      const r = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: process.env.DISCORD_CLIENT_ID!, client_secret: process.env.DISCORD_CLIENT_SECRET!, grant_type: 'authorization_code', code, redirect_uri }) });
      const j = await r.json() as any; if (!j.access_token) return back('oauth=failed');
      const me = await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${j.access_token}` } })).json() as any;
      a = { id: uid('acc'), platform: 'discord', mode: 'live', label: me.global_name || me.username || 'Discord', email: me.username ?? 'Discord', token: process.env.DISCORD_BOT_TOKEN, userToken: j.access_token, status: 'healthy', createdAt: Date.now() };
    }
    db.accounts.push(a); save(); emit('account', safeAccount(a)); back(`connected=${platform}`);
  } catch (e: any) { console.error('oauth', platform, e.message); back('oauth=failed'); }
}
route('GET', '/api/oauth/config', () => oauthCfg());
route('GET', '/api/discord/invite', () => {
  if (!process.env.DISCORD_CLIENT_ID) throw bad('Discord is not configured');
  return { url: `https://discord.com/oauth2/authorize?client_id=${process.env.DISCORD_CLIENT_ID}&scope=bot&permissions=66560` };
});


// ---------- password gate (set APP_PASSWORD to protect the console) ----------
const PASS = process.env.APP_PASSWORD;
const token = () => createHmac('sha256', PASS ?? '').update('leadme-session').digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = (req: IncomingMessage) => !PASS || eq(/(?:^|;\s*)lm=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '', token());
const attempts = new Map<string, { n: number; at: number }>();
const LOGIN = (err = '') => `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>leadme — sign in</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0b0d12;color:#e8ebf2;font:15px system-ui,sans-serif}form{background:#12151c;border:1px solid #232938;border-radius:16px;padding:28px;width:min(340px,90vw)}h1{margin:0 0 16px;font-size:20px}input,button{width:100%;padding:11px;border-radius:9px;border:1px solid #232938;font:inherit;margin-top:10px;background:#171b24;color:inherit}button{background:linear-gradient(135deg,#7c8cff,#a78bfa);border:0;color:#fff;font-weight:600;cursor:pointer}p{color:#f87171;margin:8px 0 0}</style><form method=post action=/login><h1>leadme</h1><input type=password name=password placeholder=Password autofocus autocomplete=current-password><button>Sign in</button>${err ? `<p>${err}</p>` : ''}</form>`;

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
async function readBody(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 100_000) throw bad('body too large'); chunks.push(c as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
}

export const handler = async (req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (serverless && url.searchParams.has('__p')) {
    const p = url.searchParams.get('__p') ?? '/'; url.searchParams.delete('__p');
    url.pathname = p.startsWith('/') ? p : '/' + p;
    req.url = url.pathname + url.search;
  }
  try {
    if (serverless && (url.pathname.startsWith('/api/') || url.pathname.startsWith('/oauth/'))) {
      const end = res.end.bind(res) as (...a: any[]) => ServerResponse;
      (res as any).end = (...a: any[]) => { flush().catch(e => console.error('flush', e)).finally(() => end(...a)); return res; };
      await hydrate();
      if (url.pathname !== '/api/events') await tick().catch(e => console.error('tick', e));
    }
    if (url.pathname === '/healthz') { res.writeHead(200); return void res.end('ok'); }
    if (PASS && url.pathname === '/login') {
      if (req.method === 'POST') {
        const ip = String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0].trim();
        const at = attempts.get(ip); if (at && Date.now() - at.at < 60_000 && at.n >= 8) { res.writeHead(429, { 'content-type': 'text/html' }); return void res.end(LOGIN('Too many attempts, wait a minute.')); }
        const given = new URLSearchParams(Buffer.concat(await (async () => { const c: Buffer[] = []; let n = 0; for await (const x of req) { n += x.length; if (n > 2000) break; c.push(x as Buffer); } return c; })()).toString()).get('password') ?? '';
        if (eq(createHmac('sha256', 'p').update(given).digest('hex'), createHmac('sha256', 'p').update(PASS).digest('hex'))) {
          attempts.delete(ip);
          res.writeHead(302, { location: '/', 'set-cookie': `lm=${token()}; HttpOnly; SameSite=Lax; Path=/; Max-Age=2592000${(process.env.PUBLIC_URL ?? process.env.VERCEL_PROJECT_PRODUCTION_URL ?? '').startsWith('https') || serverless ? '; Secure' : ''}` }); return void res.end();
        }
        attempts.set(ip, { n: (at && Date.now() - at.at < 60_000 ? at.n : 0) + 1, at: Date.now() });
        res.writeHead(401, { 'content-type': 'text/html' }); return void res.end(LOGIN('Wrong password.'));
      }
      res.writeHead(200, { 'content-type': 'text/html' }); return void res.end(LOGIN());
    }
    if (!authed(req)) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end('{"error":"sign in required"}'); }
      res.writeHead(302, { location: '/login' }); return void res.end();
    }
    if (url.pathname === '/api/events' && serverless) { res.writeHead(204); return void res.end(); }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const om = /^\/oauth\/(slack|discord)\/(start|callback)$/.exec(url.pathname);
    if (om) return void (om[2] === 'start' ? oauthStart(om[1] as 'slack' | 'discord', res) : await oauthCallback(om[1] as 'slack' | 'discord', url, res));
    if (url.pathname.startsWith('/api/')) {
      for (const [method, rx, h] of routes) {
        const m = rx.exec(url.pathname);
        if (method === req.method && m) {
          const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
          const out: any = await h({ body, params: m.slice(1).map(decodeURIComponent), url });
          if (out?.__csv !== undefined) { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="leadme-alerts.csv"' }); return void res.end(out.__csv); }
          res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(out));
        }
      }
      res.writeHead(404, { 'content-type': 'application/json' }); return void res.end('{"error":"not found"}');
    }
    const file = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
    if (file.includes('..')) { res.writeHead(400); return void res.end(); }
    const data = await readFile(PUBLIC + file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' }); res.end(data);
  } catch (e: any) {
    if (e.code === 'ENOENT') { res.writeHead(404); return void res.end('not found'); }
    res.writeHead(e.status ?? 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.status ? e.message : 'internal error' }));
    if (!e.status) console.error(e);
  }
};
export default handler;
if (!serverless) createServer(handler).listen(PORT, '0.0.0.0', () => console.log(`leadme connectors → http://localhost:${PORT}`));
