import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { db, save, uid } from './store.ts';
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
  db.history.push(msg); if (db.history.length > 1500) db.history.splice(0, db.history.length - 1500);
  for (const mon of db.monitors) {
    if (mon.status !== 'listening' || !mon.criteria) continue;
    if (!mon.targets.some(t => t.accountId === msg.accountId && t.channelId === msg.channelId && t.workspaceId === msg.workspaceId)) continue;
    const v = await classify(mon.description, mon.criteria, msg);
    if (!v.match) continue;
    const alert: Alert = { id: uid('al'), monitorId: mon.id, monitorName: mon.name, message: msg, reason: v.reason, status: 'new', createdAt: Date.now(), replies: [] };
    mon.matches++; db.alerts.unshift(alert); if (db.alerts.length > 2000) db.alerts.pop();
    emit('alert', alert); void outbound(alert);
  }
  save();
}

const sinceByAccount = new Map<string, number>();
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
setInterval(() => tick().catch(e => console.error('tick', e)), 1000);

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
const SECRET = new URL('../data/secret.json', import.meta.url).pathname;
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
  process.env.ANTHROPIC_API_KEY = key; mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true }); writeFileSync(SECRET, JSON.stringify({ key }), { mode: 0o600 });
  return aiStatus();
});
route('DELETE', '/api/ai/key', () => { delete process.env.ANTHROPIC_API_KEY; try { writeFileSync(SECRET, '{}', { mode: 0o600 }); } catch { /* ignore */ } return aiStatus(); });

route('GET', '/api/stats', () => ({
  accounts: db.accounts.length, healthy: db.accounts.filter(a => a.status === 'healthy').length,
  listening: db.monitors.filter(m => m.status === 'listening').length,
  channels: new Set(db.monitors.filter(m => m.status === 'listening').flatMap(m => m.targets.map(t => t.accountId + t.channelId))).size,
  alerts: db.alerts.length, unread: db.alerts.filter(a => a.status === 'new').length,
  ai: process.env.CLASSIFIER === 'rules' && !process.env.ANTHROPIC_API_KEY ? 'rules' : 'llm',
}));

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
async function readBody(req: IncomingMessage) {
  let size = 0; const chunks: Buffer[] = [];
  for await (const c of req) { size += c.length; if (size > 100_000) throw bad('body too large'); chunks.push(c as Buffer); }
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
}

createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  try {
    if (url.pathname === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
      res.write('retry: 2000\n\n'); clients.add(res); req.on('close', () => clients.delete(res)); return;
    }
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
}).listen(PORT, () => console.log(`leadme connectors → http://localhost:${PORT}`));
