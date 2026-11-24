import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { db, save, uid, DATA_DIR, hydrate, flush, remote, serverless, CAP } from './store.ts';
import { DEFAULT_TENANT, connectUrl, ownerOf, tenantCookieFor, tenantFromCookie } from './tenant.ts';
import { buildCriteria, classify, questionsFor } from './classifier.ts';
import { demoAdapter, demoMessage } from './adapters/demo.ts';
import { slackAdapter } from './adapters/slack.ts';
import { discordAdapter, setDiscordRefresher } from './adapters/discord.ts';
import { abandonAuth, authClick, authFrame, autoauthFor, credentialView, driversStatus, forgetCredentials, ingestStatusEvent, noteSessionEnd, runNow, saveCredentials, setAuthEmitter, setEnabled, submitCode, tickAuth } from './auth/reconnect.ts';
import { keeperStatus, keeperTick, setKeeperProbe } from './auth/keeper.ts';
import { closeBrowserSession, fingerprintFor, launchFor, profileDirFor } from './auth/session.ts';
import type { Account, Adapter, Alert, Monitor, NormalizedMessage, Target } from './types.ts';

const PORT = Number(process.env.PORT ?? 4310);
const PUBLIC = new URL('../public/', import.meta.url).pathname;
const adapterFor = (a: Account): Adapter => a.mode === 'demo' ? demoAdapter : a.platform === 'slack' ? slackAdapter : discordAdapter;
const clients = new Set<ServerResponse>();
const seen = new Set<string>();
const safeAccount = ({ token: _t, ...a }: Account) => ({ ...a, hasToken: !!_t });
const als = new AsyncLocalStorage<string>();
const tenant = () => als.getStore() ?? DEFAULT_TENANT;
const mine = <T extends { tenantId?: string }>(rows: T[]) => rows.filter(r => ownerOf(r.tenantId) === tenant());

function emit(event: string, data: unknown) {
  const frame = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const c of clients) c.write(frame);
}
setAuthEmitter(entry => emit('autoauth', entry));
setKeeperProbe(a => adapterFor(a).check(a));

const dirBytes = (dir: string): number => {
  let total = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = `${d}/${e.name}`;
      try { total += e.isDirectory() ? (walk(p), 0) : statSync(p).size; } catch { /* raced */ }
    }
  };
  try { walk(dir); } catch { /* missing */ }
  return total;
};

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
    const alert: Alert = { id: uid('al'), tenantId: mon.tenantId ?? DEFAULT_TENANT, monitorId: mon.id, monitorName: mon.name, message: msg, reason: v.reason, status: 'new', createdAt: Date.now(), replies: [] };
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
    // A dead session stays quiet until a sign-in (or the Reconnect button) marks it healthy again —
    // otherwise every page load re-hits the provider with a token that is already invalid.
    if (a.mode === 'live' && a.status === 'disconnected') continue;
    if (Date.now() - (lastRun.get(a.id) ?? 0) < every) continue;
    lastRun.set(a.id, Date.now());
    const targets = new Map<string, Target>();
    for (const m of db.monitors) if (m.status === 'listening') for (const t of m.targets) if (t.accountId === a.id) targets.set(t.workspaceId + t.channelId, t);
    if (!targets.size) continue;
    try {
      const since = sinceByAccount.get(a.id) ?? Date.now() - 1000; const startedAt = Date.now();
      const msgs = await adapterFor(a).poll(a, [...targets.values()], since);
      sinceByAccount.set(a.id, startedAt - 2000);
      for (const m of msgs.sort((x, y) => x.ts - y.ts)) await handleMessage(m);
      if (a.status !== 'healthy' && a.mode === 'live') { a.status = 'healthy'; a.statusNote = undefined; emit('account', safeAccount(a)); }
      failures.set(a.id, 0); a.lastSync = Date.now();
    } catch (e: any) {
      const n = (failures.get(a.id) ?? 0) + 1; failures.set(a.id, n);
      a.status = n >= 3 ? 'disconnected' : 'degraded'; a.statusNote = e.message;
      emit('account', safeAccount(a)); save();
      if (a.mode === 'live' && n >= 3) noteSessionEnd(a.id, e.message);
    }
  }
}
if (!serverless) setInterval(() => tick().catch(e => console.error('tick', e)), 1000);
if (!serverless) setInterval(() => tickAuth().catch(e => console.error('auth tick', e)), 1000);
// Autonomous keeper: probe stale sessions so a dead token never sits unnoticed.
if (!serverless) setInterval(() => keeperTick().catch(e => console.error('keeper', e)), 30_000);

function seedHistory(a: Account, t: Target) {
  if (a.mode !== 'demo') return;
  for (let i = 0; i < 40; i++) { const m = demoMessage(a, t); m.ts -= (i + 1) * 3_600_000; m.id += `-h${i}`; db.history.push(m); }
}

// ---------- routing ----------
type Ctx = { body: any; params: string[]; url: URL; req: IncomingMessage };
type Handler = (c: Ctx) => unknown | Promise<unknown>;
const routes: [string, RegExp, Handler][] = [];
const route = (method: string, path: string, h: Handler) => routes.push([method, new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`), h]);
const getAccount = (id: string) => { const a = db.accounts.find(x => x.id === id && ownerOf(x.tenantId) === tenant()); if (!a) throw Object.assign(new Error('account not found'), { status: 404 }); return a; };
const getMonitor = (id: string) => { const m = db.monitors.find(x => x.id === id && ownerOf(x.tenantId) === tenant()); if (!m) throw Object.assign(new Error('monitor not found'), { status: 404 }); return m; };
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

route('GET', '/api/accounts', () => mine(db.accounts).map(safeAccount));
route('POST', '/api/accounts', async ({ body }) => {
  if (!['slack', 'discord'].includes(body.platform)) throw bad('platform must be slack or discord');
  const live = body.mode === 'live';
  const slackSession = live && body.platform === 'slack' && !!body.sessionCookie;
  const discordSelf = live && body.platform === 'discord' && !!body.selfToken;
  const loginOnly = live && !!body.loginOnly;
  if (live && !loginOnly && !slackSession && !discordSelf && !body.token) throw bad('token required for live mode');
  if (slackSession && (!body.token || !body.sessionCookie)) throw bad('both the token and the cookie are required');
  if (discordSelf && !String(body.selfToken).trim()) throw bad('token is required');
  const a: Account = { id: uid('acc'), tenantId: tenant(), platform: body.platform, mode: live ? 'live' : 'demo', label: String(body.label || `${body.platform} account`).slice(0, 60),
    email: String(body.email || (body.platform === 'discord' ? 'Discord (stored login)' : 'Slack (stored login)')).slice(0, 80), token: live && !discordSelf && body.token ? String(body.token) : undefined,
    sessionCookie: slackSession ? String(body.sessionCookie) : undefined, selfToken: discordSelf ? String(body.selfToken).trim() : undefined,
    status: loginOnly ? 'disconnected' : 'healthy', statusNote: loginOnly ? 'no session yet — save the login and it signs in' : undefined, createdAt: Date.now() };
  if (live && !loginOnly) { try { const r = await adapterFor(a).check(a); a.email = r.identity ?? a.email; } catch (e: any) { throw bad(`could not verify credentials: ${e.message}`); } }
  if (loginOnly) { const entry = autoauthFor(a.id); entry.enabled = true; save(); }
  db.accounts.push(a); save(); emit('account', safeAccount(a));
  return safeAccount(a);
});
route('DELETE', '/api/accounts/:id', ({ params }) => {
  const a = getAccount(params[0]); db.accounts = db.accounts.filter(x => x !== a);
  db.credentials = db.credentials.filter(c => c.accountId !== a.id);
  db.autoauth = db.autoauth.filter(e => e.accountId !== a.id);
  void abandonAuth(a.id);
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

// ---------- stored logins: credential vault + automatic sign-in ----------
const authView = (id: string) => ({ autoauth: autoauthFor(id), credential: credentialView(id) });
route('GET', '/api/autoauth', () => { const accounts = mine(db.accounts); return db.autoauth.filter(e => accounts.some(a => a.id === e.accountId)).map(e => ({ ...e, credential: credentialView(e.accountId) })); });
route('GET', '/api/autoauth/drivers', () => driversStatus());
route('GET', '/api/accounts/:id/autoauth', ({ params }) => { getAccount(params[0]); return authView(params[0]); });
route('PUT', '/api/accounts/:id/autoauth', ({ params, body }) => {
  const a = getAccount(params[0]);
  saveCredentials(a, body);
  if (body.enabled === undefined && !autoauthFor(a.id).enabled && credentialView(a.id).secret?.hasPassword) setEnabled(a.id, true);
  else if (body.enabled !== undefined) setEnabled(a.id, !!body.enabled);
  const entry = autoauthFor(a.id);
  if (entry.enabled && entry.status === 'idle') entry.nextRetryAt = Date.now();
  return authView(a.id);
});
route('DELETE', '/api/accounts/:id/autoauth', async ({ params }) => { getAccount(params[0]); await abandonAuth(params[0]); forgetCredentials(params[0]); return authView(params[0]); });
route('POST', '/api/accounts/:id/autoauth/run', async ({ params }) => { getAccount(params[0]); return runNow(params[0], 'manual'); });
route('POST', '/api/accounts/:id/autoauth/stop', async ({ params }) => { getAccount(params[0]); await abandonAuth(params[0]); return setEnabled(params[0], false); });
route('POST', '/api/accounts/:id/autoauth/code', async ({ params, body }) => { getAccount(params[0]); return submitCode(params[0], String(body.code ?? '')); });
route('POST', '/api/accounts/:id/autoauth/click', async ({ params, body }) => { getAccount(params[0]); return authClick(params[0], Number(body.x), Number(body.y)); });
route('GET', '/api/accounts/:id/autoauth/frame', async ({ params }) => {
  getAccount(params[0]);
  const png = await authFrame(params[0]);
  return png ? { __raw: png, __type: 'image/jpeg' } : { __status: 204 };
});

// ---------- browser identity (the Dolphin-style profile) ----------
const browserView = (id: string) => {
  const a = getAccount(id);
  const dir = profileDirFor(a.id);
  const exists = existsSync(dir);
  return {
    config: a.browser ?? { mode: 'builtin' as const },
    effective: fingerprintFor(a),
    profile: { exists, mb: exists ? Math.round(dirBytes(dir) / 1_048_576) : 0, path: dir },
    account: { id: a.id, status: a.status, hasSession: !!(a.token || a.selfToken || a.sessionCookie), lastSync: a.lastSync ?? null },
  };
};
route('GET', '/api/accounts/:id/browser', ({ params }) => browserView(params[0]));
route('PUT', '/api/accounts/:id/browser', ({ params, body }) => {
  const a = getAccount(params[0]);
  const prev = a.browser;
  const text = (v: unknown, max = 220) => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined;
  const num = (v: unknown, lo: number, hi: number) => Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : undefined;
  const f = (body.fingerprint ?? {}) as Record<string, unknown>;
  const mode = ['builtin', 'dolphin', 'ws'].includes(String(body.mode)) ? String(body.mode) as 'builtin' | 'dolphin' | 'ws' : (prev?.mode ?? 'builtin');
  a.browser = {
    mode,
    profileId: text(body.profileId, 80) ?? (mode === 'dolphin' ? prev?.profileId : undefined),
    ws: text(body.ws, 300) ?? (mode === 'ws' ? prev?.ws : undefined),
    fingerprint: {
      userAgent: text(f.userAgent, 300) ?? prev?.fingerprint?.userAgent,
      timezone: text(f.timezone, 60) ?? prev?.fingerprint?.timezone,
      locale: text(f.locale, 20) ?? prev?.fingerprint?.locale,
      proxy: text(f.proxy, 220) ?? prev?.fingerprint?.proxy,
      width: num(f.width, 800, 2560) ?? prev?.fingerprint?.width,
      height: num(f.height, 600, 1600) ?? prev?.fingerprint?.height,
      colorScheme: f.colorScheme === 'dark' || f.colorScheme === 'light' ? f.colorScheme : prev?.fingerprint?.colorScheme,
    },
  };
  if (mode === 'dolphin' && !a.browser.profileId) throw bad('a Dolphin profile id is required for dolphin mode');
  if (mode === 'ws' && !a.browser.ws) throw bad('a ws endpoint is required for ws mode');
  void closeBrowserSession(a.id);
  save(); return browserView(a.id);
});
route('POST', '/api/accounts/:id/browser/reset', async ({ params }) => {
  const a = getAccount(params[0]);
  await closeBrowserSession(a.id);
  await abandonAuth(a.id);
  try { rmSync(profileDirFor(a.id), { recursive: true, force: true }); } catch { /* already gone */ }
  a.token = undefined; a.sessionCookie = undefined; a.selfToken = undefined; a.userToken = undefined; a.refreshToken = undefined;
  a.status = 'disconnected'; a.statusNote = 'identity reset — sign in again';
  save(); emit('account', safeAccount(a)); return browserView(a.id);
});
route('POST', '/api/accounts/:id/browser/inspect', async ({ params }) => {
  const a = getAccount(params[0]);
  const b = await launchFor(a);
  await b.goto(a.platform === 'slack' ? 'https://app.slack.com/client' : 'https://discord.com/channels/@me');
  const cookies = await b.cookies(['https://slack.com', 'https://app.slack.com', 'https://discord.com']);
  return {
    url: await b.href(),
    cookieCount: cookies.length,
    cookieNames: [...new Set(cookies.map(c => c.name))].slice(0, 25),
    cookieDomains: [...new Set(cookies.map(c => c.domain))].slice(0, 10),
  };
});

route('GET', '/api/accounts/:id/workspaces/:wid/channels/:cid/messages', async ({ params }) => {
  const a = getAccount(params[0]); const msgs = await adapterFor(a).history(a, params[1], params[2], 30);
  return msgs.sort((x, y) => y.ts - x.ts);
});
route('GET', '/api/monitors', () => mine(db.monitors));
route('POST', '/api/monitors', ({ body }) => {
  const description = String(body.description ?? '').trim();
  if (description.length < 8) throw bad('describe what you are looking for (at least a sentence)');
  const m: Monitor = { id: uid('mon'), tenantId: tenant(), name: String(body.name || description.split(/\s+/).slice(0, 5).join(' ')).slice(0, 60), description, status: 'draft', targets: [], matches: 0, createdAt: Date.now() };
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
route('PUT', '/api/monitors/:id/targets', async ({ params, body }) => {
  const m = getMonitor(params[0]);
  if (!Array.isArray(body.targets)) throw bad('targets must be an array');
  const next: Target[] = body.targets.map((t: any) => { getAccount(t.accountId); return { accountId: String(t.accountId), workspaceId: String(t.workspaceId), channelId: String(t.channelId), label: String(t.label ?? '') }; });
  for (const t of next) if (!m.targets.some(o => o.accountId === t.accountId && o.channelId === t.channelId)) seedHistory(getAccount(t.accountId), t);
  const added = next.filter(t => !m.targets.some(o => o.accountId === t.accountId && o.channelId === t.channelId));
  m.targets = next; save();
  for (const t of added) { const a = getAccount(t.accountId); if (a.mode === 'live') await adapterFor(a).history(a, t.workspaceId, t.channelId, 40).then(ms => { for (const x of ms) if (!seen.has(x.id)) db.history.push(x); db.history = db.history.slice(-CAP.history); save(); }).catch(e => console.error('backfill failed', t.label, e.message)); }
  return m;
});
route('POST', '/api/monitors/:id/deploy', ({ params }) => {
  const m = getMonitor(params[0]);
  if (!m.criteria) throw bad('confirm the monitor first');
  if (!m.targets.length) throw bad('pick at least one channel to listen to');
  m.status = 'listening'; for (const t of m.targets) sinceByAccount.set(t.accountId, Date.now()); save(); emit('monitor', m); return m;
});
route('POST', '/api/monitors/:id/pause', ({ params }) => { const m = getMonitor(params[0]); m.status = 'paused'; save(); emit('monitor', m); return m; });
route('DELETE', '/api/monitors/:id', ({ params }) => { getMonitor(params[0]); db.monitors = db.monitors.filter(m => !(m.id === params[0] && ownerOf(m.tenantId) === tenant())); save(); return { ok: true }; });

route('GET', '/api/alerts', ({ url }) => {
  const s = url.searchParams.get('status'); const mon = url.searchParams.get('monitor');
  return mine(db.alerts).filter(a => (!s || a.status === s) && (!mon || a.monitorId === mon)).slice(0, 300);
});
route('PATCH', '/api/alerts/:id', ({ params, body }) => {
  const a = db.alerts.find(x => x.id === params[0] && ownerOf(x.tenantId) === tenant()); if (!a) throw Object.assign(new Error('alert not found'), { status: 404 });
  if (!['new', 'read', 'contacted', 'bad_match', 'archived'].includes(body.status)) throw bad('invalid status');
  a.status = body.status; save(); emit('alert_updated', a); return a;
});
route('POST', '/api/alerts/:id/reply', async ({ params, body }) => {
  const a = db.alerts.find(x => x.id === params[0] && ownerOf(x.tenantId) === tenant()); if (!a) throw Object.assign(new Error('alert not found'), { status: 404 });
  const text = String(body.text ?? '').trim(); if (!text) throw bad('message is empty');
  const acc = getAccount(a.message.accountId);
  if (a.replies.length >= 3) throw bad('reply limit reached for this lead');
  await adapterFor(acc).send(acc, a.message.workspaceId, a.message.channelId, text, body.dm ? a.message.author.id : undefined);
  a.replies.push({ text, ts: Date.now() }); a.status = 'contacted'; save(); emit('alert_updated', a); return a;
});
route('GET', '/api/alerts.csv', () => {
  const esc = (v: unknown) => `"${String(v).replace(/"/g, '""').replace(/^([=+\-@])/, "'$1")}"`;
  const rows = [['time', 'monitor', 'platform', 'workspace', 'channel', 'author', 'message', 'reason', 'status', 'link'],
    ...mine(db.alerts).map(a => [new Date(a.message.ts).toISOString(), a.monitorName, a.message.source, a.message.workspace, a.message.channel, a.message.author.name, a.message.text, a.reason, a.status, a.message.permalink])];
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

// ---------- one-click connect link: leadme mints it per end user, no console login ----------
route('POST', '/api/connect-link', ({ body, req }) => {
  const service = process.env.SERVICE_TOKEN;
  if (service && String(req.headers.authorization ?? '') !== `Bearer ${service}`) throw Object.assign(new Error('invalid service token'), { status: 401 });
  const id = String(body.tenantId ?? '').trim().slice(0, 64);
  if (!id) throw bad('tenantId is required');
  const platform = body.platform === 'slack' || body.platform === 'discord' ? body.platform : undefined;
  return { tenantId: id, url: connectUrl(BASE_URL(), id, platform), cookie: tenantCookieFor(id) };
});
route('GET', '/api/me', () => ({ tenant: tenant() }));

route('GET', '/api/stats', () => {
  const accounts = mine(db.accounts); const monitors = mine(db.monitors); const alerts = mine(db.alerts);
  const mineAuthed = db.autoauth.filter(e => accounts.some(a => a.id === e.accountId));
  return {
    accounts: accounts.length, healthy: accounts.filter(a => a.status === 'healthy').length,
    listening: monitors.filter(m => m.status === 'listening').length,
    channels: new Set(monitors.filter(m => m.status === 'listening').flatMap(m => m.targets.map(t => t.accountId + t.channelId))).size,
    alerts: alerts.length, unread: alerts.filter(a => a.status === 'new').length,
    sse: !serverless, persistent: !serverless || remote, ai: (process.env.CLASSIFIER === 'rules' || serverless) && !process.env.ANTHROPIC_API_KEY ? 'rules' : 'llm',
    autoauth: { enabled: mineAuthed.filter(e => e.enabled).length, waiting: mineAuthed.filter(e => e.status === 'waiting_human').length, failed: mineAuthed.filter(e => e.status === 'failed').length },
    tenant: tenant(), sessionMode: process.env.SESSION_MODE ?? 'impersonate', slackTransport: process.env.SLACK_TRANSPORT ?? 'browser',
    keeper: keeperStatus(),
  };
});

// ---------- OAuth: official "Connect" buttons (no cookie/token copying) ----------
const BASE_URL = () => process.env.PUBLIC_URL ?? (process.env.VERCEL_PROJECT_PRODUCTION_URL ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}` : null) ?? `http://localhost:${PORT}`;
const cfg = (k: string) => process.env[k] || db.settings[k] || '';
const oauthCfg = () => ({
  slack: !!(cfg('SLACK_CLIENT_ID') && cfg('SLACK_CLIENT_SECRET')),
  discord: !!(cfg('DISCORD_CLIENT_ID') && cfg('DISCORD_CLIENT_SECRET')),
  discordBot: !!cfg('DISCORD_BOT_TOKEN'),
});
const states = new Map<string, { platform: string; at: number; tenant: string }>();
const SLACK_SCOPES = 'channels:read,channels:history,groups:read,groups:history,im:read,im:history,mpim:read,mpim:history,users:read,team:read,chat:write,im:write';
function oauthStart(platform: 'slack' | 'discord', res: ServerResponse, tenantId = DEFAULT_TENANT) {
  const ok = oauthCfg(); if (!ok[platform]) { res.writeHead(400, { 'content-type': 'text/plain' }); return void res.end(`${platform} OAuth is not configured. See README.`); }
  const state = uid('st'); states.set(state, { platform, at: Date.now(), tenant: tenantId });
  const redirect = encodeURIComponent(`${BASE_URL()}/oauth/${platform}/callback`);
  const url = platform === 'slack'
    ? `https://slack.com/oauth/v2/authorize?client_id=${cfg('SLACK_CLIENT_ID')}&user_scope=${SLACK_SCOPES}&redirect_uri=${redirect}&state=${state}`
    : `https://discord.com/oauth2/authorize?client_id=${cfg('DISCORD_CLIENT_ID')}&response_type=code&scope=identify%20guilds&redirect_uri=${redirect}&state=${state}`;
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
        body: new URLSearchParams({ client_id: cfg('SLACK_CLIENT_ID'), client_secret: cfg('SLACK_CLIENT_SECRET'), code, redirect_uri }) });
      const j = await r.json() as any; if (!j.ok || !j.authed_user?.access_token) return back('oauth=failed');
      a = { id: uid('acc'), tenantId: st.tenant, platform: 'slack', mode: 'live', label: j.team?.name ?? 'Slack', email: j.team?.name ?? 'Slack workspace', token: j.authed_user.access_token, status: 'healthy', createdAt: Date.now() };
    } else {
      const r = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ client_id: cfg('DISCORD_CLIENT_ID'), client_secret: cfg('DISCORD_CLIENT_SECRET'), grant_type: 'authorization_code', code, redirect_uri }) });
      const j = await r.json() as any; if (!j.access_token) return back('oauth=failed');
      const me = await (await fetch('https://discord.com/api/v10/users/@me', { headers: { Authorization: `Bearer ${j.access_token}` } })).json() as any;
      a = { id: uid('acc'), tenantId: st.tenant, platform: 'discord', mode: 'live', label: me.global_name || me.username || 'Discord', email: me.username ?? 'Discord', token: cfg('DISCORD_BOT_TOKEN'), userToken: j.access_token, refreshToken: j.refresh_token, userTokenExp: Date.now() + (j.expires_in ?? 604800) * 1000, status: 'healthy', createdAt: Date.now() };
    }
    db.accounts.push(a); save(); emit('account', safeAccount(a)); back(`connected=${platform}`);
  } catch (e: any) { console.error('oauth', platform, e.message); back('oauth=failed'); }
}
setDiscordRefresher(async a => {
  if (!a.refreshToken) return false;
  try {
    const r = await fetch('https://discord.com/api/v10/oauth2/token', { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ client_id: cfg('DISCORD_CLIENT_ID'), client_secret: cfg('DISCORD_CLIENT_SECRET'), grant_type: 'refresh_token', refresh_token: a.refreshToken }) });
    const j = await r.json() as any; if (!j.access_token) return false;
    a.userToken = j.access_token; a.refreshToken = j.refresh_token ?? a.refreshToken; a.userTokenExp = Date.now() + (j.expires_in ?? 604800) * 1000; save(); return true;
  } catch (e: any) { console.error('discord refresh failed', e.message); return false; }
});
route('GET', '/api/oauth/config', () => ({ ...oauthCfg(), baseUrl: BASE_URL(), slackScopes: SLACK_SCOPES }));
route('PUT', '/api/oauth/settings', ({ body }) => {
  const allowed = ['SLACK_CLIENT_ID', 'SLACK_CLIENT_SECRET', 'DISCORD_CLIENT_ID', 'DISCORD_CLIENT_SECRET', 'DISCORD_BOT_TOKEN'];
  for (const k of allowed) if (typeof body[k] === 'string' && body[k].trim()) db.settings[k] = body[k].trim().slice(0, 300);
  save(); return oauthCfg();
});
route('GET', '/api/discord/invite', ({ url }) => {
  if (!cfg('DISCORD_CLIENT_ID')) throw bad('Discord is not configured');
  const g = (url.searchParams.get('guild') ?? '').replace(/\D/g, '');
  return { url: `https://discord.com/oauth2/authorize?client_id=${cfg('DISCORD_CLIENT_ID')}&scope=bot&permissions=66560${g ? `&guild_id=${g}&disable_guild_select=true` : ''}` };
});


// ---------- password gate (set APP_PASSWORD to protect the console) ----------
const PASS = process.env.APP_PASSWORD;
const token = () => createHmac('sha256', PASS ?? '').update('leadme-session').digest('hex');
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
const authed = (req: IncomingMessage) => !!tenantFromCookie(req.headers.cookie) || !PASS || eq(/(?:^|;\s*)lm=([a-f0-9]+)/.exec(req.headers.cookie ?? '')?.[1] ?? '', token());
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
  const reqTenant = tenantFromCookie(req.headers.cookie) ?? DEFAULT_TENANT;
  const serviceAuthed = !!process.env.SERVICE_TOKEN && String(req.headers.authorization ?? '') === `Bearer ${process.env.SERVICE_TOKEN}`;
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
      if (url.pathname !== '/api/events') {
        await tick().catch(e => console.error('tick', e));
        // Serverless has no timer: give due sign-ins a bounded slice so retries still happen.
        // Slack's browser driver fails fast here (no Chrome); Discord's API driver can complete.
        await Promise.race([tickAuth(), new Promise(r => setTimeout(r, 8000))]).catch(e => console.error('auth tick', e));
      }
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
    if (url.pathname === '/api/hooks/session') {
      const secret = process.env.SESSION_WEBHOOK_SECRET ?? '';
      if (!secret && !authed(req)) { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end('{"error":"signature required"}'); }
      const chunks: Buffer[] = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 200_000) throw bad('body too large'); chunks.push(c as Buffer); }
      const out = ingestStatusEvent(Buffer.concat(chunks), String(req.headers['x-lg-signature'] ?? '') || undefined);
      res.writeHead(200, { 'content-type': 'application/json' }); return void res.end(JSON.stringify(out));
    }
    if (url.pathname === '/connect') {
      const t = url.searchParams.get('t') ?? '';
      const id = tenantFromCookie(`lm_t=${t}`);
      if (!id) { res.writeHead(400, { 'content-type': 'text/plain' }); return void res.end('This connect link is invalid or was tampered with.'); }
      const p = url.searchParams.get('platform');
      const secure = serverless || (process.env.PUBLIC_URL ?? '').startsWith('https') ? '; Secure' : '';
      res.writeHead(302, {
        location: p === 'slack' || p === 'discord' ? `/oauth/${p}/start` : '/',
        'set-cookie': `lm_t=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=31536000${secure}`,
      });
      return void res.end();
    }
    if (!authed(req) && !serviceAuthed) {
      if (url.pathname.startsWith('/api/')) { res.writeHead(401, { 'content-type': 'application/json' }); return void res.end('{"error":"sign in required"}'); }
      res.writeHead(302, { location: '/login' }); return void res.end();
    }
    if (url.pathname === '/api/events' && serverless) { res.writeHead(204); return void res.end(); }
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
    const om = /^\/oauth\/(slack|discord)\/(start|callback)$/.exec(url.pathname);
    if (om) return void (om[2] === 'start' ? oauthStart(om[1] as 'slack' | 'discord', res, reqTenant) : await oauthCallback(om[1] as 'slack' | 'discord', url, res));
    if (url.pathname.startsWith('/api/')) {
      for (const [method, rx, h] of routes) {
        const m = rx.exec(url.pathname);
        if (method === req.method && m) {
          const body = ['POST', 'PUT', 'PATCH'].includes(method) ? await readBody(req) : {};
          const out: any = await als.run(reqTenant, () => h({ body, params: m.slice(1).map(decodeURIComponent), url, req }));
          if (out?.__csv !== undefined) { res.writeHead(200, { 'content-type': 'text/csv', 'content-disposition': 'attachment; filename="leadme-alerts.csv"' }); return void res.end(out.__csv); }
          if (out?.__status === 204) { res.writeHead(204); return void res.end(); }
          if (out?.__raw) { res.writeHead(200, { 'content-type': out.__type ?? 'application/octet-stream', 'cache-control': 'no-store' }); return void res.end(out.__raw); }
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
