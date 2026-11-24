import { Browser } from './cdp.ts';
import { DATA_DIR } from '../store.ts';
import type { Account, BrowserConfig, Fingerprint } from '../types.ts';

// Impersonation transport: keep one browser per account and make the provider API calls from inside
// that page. Slack rotates the xoxc token / d cookie as the web client uses them, so a copied pair
// dies within minutes; calling from the page means we are the client, not a second one.
type Entry = { browser: Browser; lastUsed: number };
const pool = new Map<string, Entry>();
const IDLE_MS = Number(process.env.BROWSER_IDLE_MS ?? 5 * 60_000);
export const profileDirFor = (id: string) => `${DATA_DIR}/profiles/${id.replace(/[^\w-]/g, '')}`;

export const DEFAULT_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

export function fingerprintFor(a: Account, proxy?: string): Fingerprint {
  const f = a.browser?.fingerprint ?? {};
  return {
    userAgent: f.userAgent || process.env.AUTH_USER_AGENT || DEFAULT_UA,
    timezone: f.timezone || process.env.AUTH_TIMEZONE,
    locale: f.locale || 'en-US',
    width: f.width ?? 1280,
    height: f.height ?? 800,
    colorScheme: f.colorScheme ?? 'light',
    proxy: f.proxy || proxy || process.env.AUTH_PROXY,
  };
}

async function dolphinWs(profileId: string): Promise<string> {
  const api = process.env.DOLPHIN_API;
  if (!api) throw new Error('dolphin_not_configured: set DOLPHIN_API to the Local API base URL');
  const headers: Record<string, string> = {};
  if (process.env.DOLPHIN_TOKEN) headers.Authorization = `Bearer ${process.env.DOLPHIN_TOKEN}`;
  const r = await fetch(`${api.replace(/\/$/, '')}/v1.0/browser_profiles/${encodeURIComponent(profileId)}/start?automation=1`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`dolphin_start_${r.status}`);
  const j = await r.json() as any;
  const ws = j?.automation?.wsEndpoint ?? j?.wsEndpoint;
  if (ws) return ws;
  const port = j?.automation?.port ?? j?.port;
  if (!port) throw new Error('dolphin_no_ws_endpoint');
  return `ws://127.0.0.1:${port}/devtools/browser`;
}

// One entry point for every launch: our own browser, a Dolphin/anti-detect profile, or a raw
// browser-level websocket. The account owns the choice, so each tenant can bring its own browser.
export async function launchFor(a: Account, proxy?: string): Promise<Browser> {
  const cfg: BrowserConfig = a.browser ?? { mode: 'builtin' };
  if (cfg.mode === 'ws' && cfg.ws) return Browser.attachBrowserWs(cfg.ws);
  if (cfg.mode === 'dolphin' && cfg.profileId) return Browser.attachBrowserWs(await dolphinWs(cfg.profileId));
  const f = fingerprintFor(a, proxy);
  return Browser.launch({
    profileDir: profileDirFor(a.id),
    headless: process.env.AUTH_HEADLESS === '1' || (process.platform === 'linux' && !process.env.DISPLAY),
    proxy: f.proxy, timezone: f.timezone, userAgent: f.userAgent, locale: f.locale,
    width: f.width, height: f.height, colorScheme: f.colorScheme,
  });
}

export const impersonateSlack = (a: Account) =>
  a.mode === 'live' && !!a.sessionCookie && process.env.SLACK_TRANSPORT !== 'token';

export async function browserFor(a: Account): Promise<Browser> {
  const hit = pool.get(a.id);
  if (hit) { hit.lastUsed = Date.now(); return hit.browser; }
  const browser = await launchFor(a);
  await browser.goto('https://app.slack.com/client');
  pool.set(a.id, { browser, lastUsed: Date.now() });
  return browser;
}

export async function closeBrowserSession(accountId: string) {
  const hit = pool.get(accountId);
  if (!hit) return;
  pool.delete(accountId);
  await hit.browser.close().catch(() => null);
}

if (!process.env.VERCEL) setInterval(() => {
  const now = Date.now();
  for (const [id, e] of [...pool]) if (now - e.lastUsed > IDLE_MS) { pool.delete(id); void e.browser.close().catch(() => null); }
}, 60_000).unref();

const pageFetch = (method: string, params: Record<string, string | number>) => `(async () => {
  let token = '';
  try {
    const raw = localStorage.getItem('localConfig_v2') || localStorage.getItem('localConfig_v1') || '{}';
    const cfg = JSON.parse(raw); const teams = Object.values(cfg.teams || {});
    const team = teams.find(t => t.id === cfg.lastActiveTeamId) || teams.find(t => t.token) || teams[0];
    token = (team && team.token) || '';
  } catch (e) { token = ''; }
  const body = new URLSearchParams(${JSON.stringify(params)});
  body.set('token', token);
  const r = await fetch('https://slack.com/api/${method}', { method: 'POST', credentials: 'include', body });
  return { status: r.status, retryAfter: r.headers.get('retry-after') || '', text: await r.text() };
})()`;

export async function slackPageApi(a: Account, method: string, params: Record<string, string | number> = {}) {
  const b = await browserFor(a);
  const out = await b.evaluate<{ status: number; retryAfter: string; text: string }>(pageFetch(method, params));
  if (!out || typeof out.text !== 'string') throw new Error('browser_api_empty');
  if (out.status === 429) throw new Error(`rate_limited retry-after=${out.retryAfter}`);
  let j: any; try { j = JSON.parse(out.text); } catch { throw new Error('browser_api_not_json'); }
  return j;
}
