import { createHmac, timingSafeEqual } from 'node:crypto';
import { db, save, uid } from '../store.ts';
import { mask, open, seal, vaultStrength, type Secret } from '../vault.ts';
import { normalizeTotpSecret } from '../totp.ts';
import type { Account, AutoAuth, Credential, LoginSession } from '../types.ts';
import type { AuthDriver, LoginContext, LoginResult } from './browser.ts';
import { discordApiDriver, slackBrowserDriver } from './browser.ts';

// Same ladder the provider docs recommend: every retry is a real sign-in, so wait longer each time.
export const BACKOFF_MINUTES = [2, 5, 15, 30, 60, 120, 240, 360];
export const backoffFor = (attempt: number) => BACKOFF_MINUTES[Math.min(Math.max(attempt - 1, 0), BACKOFF_MINUTES.length - 1)];

const running = new Set<string>();
const MAX_LOG = 40;
const bad = (msg: string) => Object.assign(new Error(msg), { status: 400 });

let emitAuth: (entry: AutoAuth) => void = () => {};
export const setAuthEmitter = (fn: (entry: AutoAuth) => void) => { emitAuth = fn; };

let resolveDriver: (a: Account) => AuthDriver = a => a.platform === 'slack' ? slackBrowserDriver : discordApiDriver;
export const setDriverResolver = (fn: (a: Account) => AuthDriver) => { resolveDriver = fn; };

export const autoauthFor = (accountId: string): AutoAuth => {
  let e = db.autoauth.find(x => x.accountId === accountId);
  if (!e) { e = { accountId, enabled: false, status: 'idle', attempts: 0, log: [], updatedAt: Date.now() }; db.autoauth.push(e); }
  if (!Array.isArray(e.log)) e.log = [];
  return e;
};

const log = (e: AutoAuth, level: 'info' | 'warn' | 'error', msg: string) => {
  e.log.unshift({ ts: Date.now(), level, msg });
  if (e.log.length > MAX_LOG) e.log.length = MAX_LOG;
  e.updatedAt = Date.now();
};

export const credentialFor = (accountId: string) => db.credentials.find(c => c.accountId === accountId);

export function credentialView(accountId: string) {
  const cred = credentialFor(accountId);
  if (!cred) return { stored: false, strength: vaultStrength, lastLoginAt: null, lastLoginError: null, secret: null };
  try { return { stored: true, strength: vaultStrength, lastLoginAt: cred.lastLoginAt ?? null, lastLoginError: cred.lastLoginError ?? null, secret: mask(open(cred.sealed)) }; }
  catch (e: any) { return { stored: true, strength: vaultStrength, lastLoginAt: cred.lastLoginAt ?? null, lastLoginError: e.message, secret: null }; }
}

export interface CredentialInput { username?: string; password?: string; totpSecret?: string; backupCodes?: string | string[]; proxy?: string; notes?: string; enabled?: boolean }

export function saveCredentials(a: Account, input: CredentialInput) {
  const existing = credentialFor(a.id);
  let prev: Partial<Secret> = {};
  if (existing) { try { prev = open(existing.sealed); } catch { prev = {}; } }
  const username = String(input.username ?? prev.username ?? a.email ?? '').trim();
  if (!username) throw bad('username is required');
  const secret: Secret = {
    username,
    password: input.password ?? prev.password,
    totpSecret: input.totpSecret !== undefined ? (input.totpSecret ? normalizeTotpSecret(input.totpSecret) : undefined) : prev.totpSecret,
    backupCodes: input.backupCodes !== undefined
      ? (Array.isArray(input.backupCodes) ? input.backupCodes : String(input.backupCodes).split(/[\s,]+/)).filter(Boolean)
      : prev.backupCodes,
    proxy: input.proxy !== undefined ? (input.proxy.trim() || undefined) : prev.proxy,
    notes: input.notes ?? prev.notes,
  };
  const now = Date.now();
  if (existing) { existing.sealed = seal(secret); existing.updatedAt = now; existing.lastLoginError = undefined; }
  else db.credentials.push({ id: uid('cred'), accountId: a.id, platform: a.platform, sealed: seal(secret), createdAt: now, updatedAt: now });
  const entry = autoauthFor(a.id);
  if (input.enabled !== undefined) entry.enabled = !!input.enabled;
  if (!entry.enabled && entry.status === 'failed') entry.status = 'idle';
  log(entry, 'info', `credentials saved${secret.totpSecret ? ' (2FA secret stored — codes are answered automatically)' : ''}`);
  save(); emitAuth(entry);
  return { credential: credentialView(a.id), autoauth: entry };
}

export function setEnabled(accountId: string, enabled: boolean) {
  const entry = autoauthFor(accountId);
  entry.enabled = !!enabled;
  if (!enabled) { entry.nextRetryAt = undefined; entry.status = entry.status === 'running' ? 'running' : 'stopped'; }
  else if (entry.status === 'stopped') entry.status = 'idle';
  entry.updatedAt = Date.now();
  log(entry, 'info', enabled ? 'automatic sign-in enabled' : 'automatic sign-in disabled');
  save(); emitAuth(entry);
  return entry;
}

export function forgetCredentials(accountId: string) {
  const cred = credentialFor(accountId);
  if (cred) db.credentials = db.credentials.filter(c => c !== cred);
  const entry = autoauthFor(accountId);
  entry.enabled = false; entry.status = 'idle'; entry.attempts = 0; entry.nextRetryAt = undefined; entry.checkpoint = undefined; entry.lastError = undefined;
  log(entry, 'warn', 'stored credentials deleted');
  save(); emitAuth(entry);
  return entry;
}

function schedule(entry: AutoAuth, retryAfterMs?: number) {
  const minutes = backoffFor(entry.attempts);
  const ms = Math.max(minutes * 60_000, retryAfterMs ?? 0);
  entry.status = entry.enabled ? 'failed' : 'idle';
  entry.nextRetryAt = Date.now() + ms;
  log(entry, 'info', `next automatic attempt in ${Math.round(ms / 60_000)} min`);
}

function applyResult(a: Account, entry: AutoAuth, cred: Credential, res: LoginResult) {
  if (res.checkpoint) {
    entry.status = 'waiting_human';
    entry.checkpoint = {
      id: uid('cp'), type: res.checkpoint.type, prompt: res.checkpoint.prompt,
      requestedAt: Date.now(), expiresAt: Date.now() + 10 * 60_000, attempts: 0, liveView: res.checkpoint.liveView,
    };
    log(entry, 'warn', `needs a person (${res.checkpoint.type})`);
    return;
  }
  if (!res.ok) {
    entry.lastError = res.error ?? 'sign-in failed';
    cred.lastLoginError = entry.lastError;
    log(entry, 'error', entry.lastError);
    schedule(entry, res.retryAfterMs);
    return;
  }
  Object.assign(a, res.session ?? ({} as LoginSession));
  if (res.identity) a.email = res.identity;
  a.status = 'healthy'; a.statusNote = undefined;
  entry.status = 'succeeded'; entry.attempts = 0; entry.lastSuccessAt = Date.now();
  entry.lastError = undefined; entry.nextRetryAt = undefined; entry.checkpoint = undefined;
  cred.lastLoginAt = Date.now(); cred.lastLoginError = undefined;
  log(entry, 'info', `signed in${res.identity ? ` as ${res.identity}` : ''} — session handed back to the poller`);
}

export async function runNow(accountId: string, reason = 'manual'): Promise<AutoAuth> {
  const entry = autoauthFor(accountId);
  const a = db.accounts.find(x => x.id === accountId);
  if (!a) throw Object.assign(new Error('account not found'), { status: 404 });
  if (running.has(accountId)) return entry;
  const cred = credentialFor(accountId);
  if (!cred) {
    entry.lastError = 'no stored credentials — save the login below';
    log(entry, 'error', entry.lastError);
    schedule(entry); // not every second: the ladder starts at 2 minutes
    save(); emitAuth(entry);
    return entry;
  }
  running.add(accountId);
  entry.status = 'running'; entry.lastAttemptAt = Date.now(); entry.lastReason = reason;
  entry.attempts++; entry.nextRetryAt = undefined; entry.checkpoint = undefined;
  log(entry, 'info', `sign-in attempt ${entry.attempts} (${reason})`);
  save(); emitAuth(entry);
  try {
    const res = await resolveDriver(a).login({ account: a, secret: open(cred.sealed) } as LoginContext);
    applyResult(a, entry, cred, res);
  } catch (e: any) {
    entry.lastError = e.message; cred.lastLoginError = e.message;
    log(entry, 'error', e.message);
    schedule(entry);
  } finally {
    running.delete(accountId);
    entry.updatedAt = Date.now();
    save(); emitAuth(entry);
  }
  return entry;
}

export async function submitCode(accountId: string, code: string): Promise<AutoAuth> {
  const entry = autoauthFor(accountId);
  const cp = entry.checkpoint;
  if (!cp || cp.resolvedAt) throw bad('nothing is waiting for a code right now');
  const clean = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{4,10}$/.test(clean)) throw bad('that does not look like a code');
  if (running.has(accountId)) return entry;
  const a = db.accounts.find(x => x.id === accountId);
  const cred = credentialFor(accountId);
  if (!a || !cred) throw bad('account has no stored credentials');
  running.add(accountId);
  cp.attempts++; entry.status = 'running'; cp.error = undefined;
  log(entry, 'info', `code submitted for the ${cp.type} step`);
  save(); emitAuth(entry);
  try {
    const res = await resolveDriver(a).submitCode(accountId, clean);
    if (res.error === 'wrong_code') {
      cp.error = 'that code was rejected — try the next one';
      entry.status = 'waiting_human';
      log(entry, 'warn', cp.error);
    } else applyResult(a, entry, cred, res);
  } catch (e: any) {
    cp.error = e.message; entry.status = 'waiting_human';
    log(entry, 'error', e.message);
  } finally {
    running.delete(accountId);
    entry.updatedAt = Date.now();
    save(); emitAuth(entry);
  }
  return entry;
}

export const authFrame = (accountId: string) => {
  const a = db.accounts.find(x => x.id === accountId);
  if (!a) return Promise.resolve(null);
  return resolveDriver(a).frame(accountId);
};

// Click replay for the live view: a person can tick the provider's CAPTCHA from the panel even
// when the host has no display.
export async function authClick(accountId: string, x: number, y: number) {
  const a = db.accounts.find(x => x.id === accountId);
  if (!a) throw Object.assign(new Error('account not found'), { status: 404 });
  const px = Math.max(0, Math.round(Number(x) || 0));
  const py = Math.max(0, Math.round(Number(y) || 0));
  const ok = await resolveDriver(a).click?.(accountId, px, py);
  return { ok: !!ok };
}

export async function abandonAuth(accountId: string) {
  const a = db.accounts.find(x => x.id === accountId);
  if (a) await resolveDriver(a).abandon(accountId).catch(() => null);
  const entry = autoauthFor(accountId);
  entry.checkpoint = undefined;
  if (entry.status === 'waiting_human') entry.status = entry.enabled ? 'idle' : 'stopped';
  save(); emitAuth(entry);
}

export function noteSessionEnd(accountId: string, reason: string) {
  const entry = autoauthFor(accountId);
  if (!entry.enabled) return;
  log(entry, 'warn', `session ended (${reason})`);
  entry.lastReason = reason;
  entry.nextRetryAt = Date.now();
  if (entry.status !== 'running') entry.status = 'idle';
  save(); emitAuth(entry);
}

// Called once a second by the server tick: expire stale human steps, fire due retries, keep succeeded accounts quiet.
export async function tickAuth() {
  const now = Date.now();
  for (const entry of [...db.autoauth]) {
    if (!entry.enabled || running.has(entry.accountId)) continue;
    const a = db.accounts.find(x => x.id === entry.accountId);
    if (!a || a.mode !== 'live') continue;
    if (entry.status === 'waiting_human') {
      if (entry.checkpoint && entry.checkpoint.expiresAt < now) {
        log(entry, 'warn', `the ${entry.checkpoint.type} step expired`);
        entry.checkpoint = undefined;
        schedule(entry);
        save(); emitAuth(entry);
      }
      continue;
    }
    if (entry.nextRetryAt && entry.nextRetryAt > now) continue;
    if (entry.status === 'idle' || entry.status === 'failed') await runNow(entry.accountId, 'scheduled').catch(e => console.error('autoauth', e.message));
  }
}

// ---------- provider status webhooks (the PDF's AccountStatus CREDENTIALS -> reconnect loop) ----------
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export function verifySignature(raw: string | Buffer, header: string | undefined, secret: string): boolean {
  if (!secret) return true;
  if (!header) return false;
  const given = header.trim().replace(/^t=\d+,?/, '').replace(/^v1=/, '');
  const sign = () => createHmac('sha256', secret).update(raw);
  return eq(given, sign().digest('base64url')) || eq(given, sign().digest('base64'));
}

export interface StatusEvent { event_id?: string; emitted_at?: string; livemode?: boolean; AccountStatus?: { account_id?: string; message?: string } }

// Idempotent by event_id, newest-wins by emitted_at, exactly as the docs warn (retries reuse the id, events arrive out of order).
export function ingestStatusEvent(raw: Buffer, signature?: string) {
  if (!verifySignature(raw, signature, process.env.SESSION_WEBHOOK_SECRET ?? '')) throw Object.assign(new Error('bad signature'), { status: 401 });
  let ev: StatusEvent;
  try { ev = JSON.parse(raw.toString('utf8')); } catch { throw bad('body is not JSON'); }
  const id = String(ev.AccountStatus?.account_id ?? '');
  if (!id) throw bad('AccountStatus.account_id is required');
  const message = String(ev.AccountStatus?.message ?? '').toUpperCase();
  const emitted = Date.parse(ev.emitted_at ?? '') || Date.now();
  const evtKey = `evt:${ev.event_id ?? `${id}:${emitted}:${message}`}`;
  if (db.sessionEvents[evtKey]) return { ok: true, duplicate: true, action: 'none' };
  db.sessionEvents[evtKey] = 1;
  const keys = Object.keys(db.sessionEvents).filter(k => k.startsWith('evt:'));
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete db.sessionEvents[k];

  const previous = db.sessionEvents[`acc:${id}`] ?? 0;
  if (emitted <= previous) { save(); return { ok: true, stale: true, action: 'none' }; }
  db.sessionEvents[`acc:${id}`] = emitted;

  const a = db.accounts.find(x => x.id === id);
  if (!a) { save(); return { ok: true, action: 'none', note: 'unknown account' }; }
  if (message === 'CREDENTIALS') {
    a.status = 'disconnected'; a.statusNote = 'session ended — automatic sign-in queued';
    noteSessionEnd(id, 'provider reported the session ended');
    save(); return { ok: true, action: 'reconnect' };
  }
  if (message === 'OK') {
    a.status = 'healthy'; a.statusNote = undefined;
    const entry = autoauthFor(id);
    entry.status = 'succeeded'; entry.checkpoint = undefined; entry.attempts = 0;
    save(); return { ok: true, action: 'healthy' };
  }
  if (message === 'STOPPED') {
    const entry = autoauthFor(id);
    entry.status = 'stopped'; entry.nextRetryAt = undefined;
    log(entry, 'warn', 'provider says the account is stopped — waiting instead of burning sign-ins');
    a.status = 'disconnected'; a.statusNote = 'stopped by provider';
    save(); return { ok: true, action: 'stopped' };
  }
  save();
  return { ok: true, action: 'none' };
}

export async function driversStatus() {
  const [slack, discord] = await Promise.all([slackBrowserDriver.available(), discordApiDriver.available()]);
  return { slack, discord, strength: vaultStrength, headful: process.env.AUTH_HEADLESS !== '1' && !(process.platform === 'linux' && !process.env.DISPLAY), serverless: !!process.env.VERCEL };
}

export const authSummary = () => ({
  enabled: db.autoauth.filter(e => e.enabled).length,
  waiting: db.autoauth.filter(e => e.status === 'waiting_human').length,
  failed: db.autoauth.filter(e => e.status === 'failed').length,
});
