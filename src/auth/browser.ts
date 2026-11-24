import { Browser, findChrome } from './cdp.ts';
import { closeBrowserSession, launchFor, profileDirFor } from './session.ts';
import { existsSync } from 'node:fs';
import { DATA_DIR } from '../store.ts';
import { parseTotp, totp } from '../totp.ts';
import type { Account, CheckpointType, LoginSession } from '../types.ts';
import type { Secret } from '../vault.ts';

export interface LoginCheckpoint { type: CheckpointType; prompt: string; liveView: boolean }
export interface LoginResult { ok: boolean; session?: LoginSession; identity?: string; checkpoint?: LoginCheckpoint; error?: string; retryAfterMs?: number }
export interface LoginContext { account: Account; secret: Secret }
export interface AuthDriver {
  name: string;
  available(): Promise<{ ok: boolean; note?: string }>;
  login(ctx: LoginContext): Promise<LoginResult>;
  submitCode(accountId: string, code: string): Promise<LoginResult>;
  click?(accountId: string, x: number, y: number): Promise<boolean>;
  frame(accountId: string): Promise<Buffer | null>;
  abandon(accountId: string): Promise<void>;
}

const EMAIL = ['input[type="email"]', '#email', 'input[name="email"]', 'input[autocomplete="username"]', '[data-qa="signin_email"]'];
const PASSWORD = ['#password', 'input[type="password"][name="password"]', '[data-qa="signin_password"]', 'input[type="password"]'];
const SUBMIT = ['#signin_btn', 'button[type="submit"]', 'button[data-qa="signin_button"]', 'button[data-qa="submit_2fa"]', 'button[data-qa="submit"]'];
const OTP = ['input[autocomplete="one-time-code"]', '#signin_2fa_code', 'input[data-qa="signin_2fa_code"]', 'input[name="code"]', 'input[inputmode="numeric"]'];
const CAPTCHA_HINT = /captcha|verify (that )?you( a|')?re human|are you a robot/i;
const PHONE_HINT = /check your phone|open (the )?slack app|notification|approve (this|the) (sign|login)|2fa on your phone/i;
const EMAIL_CODE_HINT = /check your email|sent (you )?a code|enter the code|6-digit code|code we (just )?sent/i;
const BAD_PASSWORD_HINT = /incorrect password|wrong password|that.?s not the right password|password is incorrect|invalid password/i;
const BAD_EMAIL_HINT = /not a valid email|isn.t a valid email|no account (with|found)|didn.t find (an|your) account|no slack account/i;

const profiles = profileDirFor;

type SlackFlow = { browser: Browser; ctx: LoginContext; enteredEmail: boolean; enteredPassword: boolean; expiresAt: number; inAppSince?: number };
const slackFlows = new Map<string, SlackFlow>();
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

async function slackSession(b: Browser): Promise<{ session: LoginSession; identity?: string } | null> {
  const href = await b.href();
  if (!/app\.slack\.com|\.slack\.com\/client/.test(href)) return null;
  const raw = (await b.localStorageGet('localConfig_v2')) ?? (await b.localStorageGet('localConfig_v1'));
  if (!raw) return null;
  let cfg: any; try { cfg = JSON.parse(raw); } catch { return null; }
  const teams: any[] = Object.values(cfg?.teams ?? {});
  const team = teams.find(t => t.id === cfg?.lastActiveTeamId) ?? teams.find(t => t.token) ?? teams[0];
  if (!team?.token || !/^xoxc-/.test(team.token)) return null;
  const cookies = await b.cookies(['https://app.slack.com', 'https://slack.com']);
  const d = cookies.find(c => c.name === 'd' && /^xoxd-/.test(c.value));
  if (!d) return null;
  return { session: { token: team.token, sessionCookie: d.value }, identity: team.name ?? team.domain };
}

const checkpointOf = (type: CheckpointType, prompt: string, liveView = false): LoginResult => ({ ok: false, checkpoint: { type, prompt, liveView } });

// One look at the page. Returns "retry" while a step is still in flight.
async function slackOnce(flow: SlackFlow, code?: string): Promise<LoginResult | 'retry'> {
  const b = flow.browser;
  const got = await slackSession(b);
  if (got) return { ok: true, session: got.session, identity: got.identity };

  const body = (await b.text()).toLowerCase();
  if (BAD_PASSWORD_HINT.test(body)) return { ok: false, error: 'bad_credentials: Slack rejected the stored password' };
  if (BAD_EMAIL_HINT.test(body)) return { ok: false, error: 'bad_credentials: Slack rejected the stored email address' };

  if (await b.visible(OTP)) {
    const parsed = flow.ctx.secret.totpSecret ? parseTotp(flow.ctx.secret.totpSecret) : null;
    const answer = code ?? (parsed ? totp(parsed.secret, { digits: parsed.digits, period: parsed.period, algorithm: parsed.algorithm }) : null);
    if (!answer) return checkpointOf('TWO_FA', 'Slack asked for a 2FA code. Paste it here, or save the account\'s 2FA setup key so this step is automatic next time.', true);
    await b.fill(OTP, answer);
    await b.click(SUBMIT);
    await b.pressEnter();
    await sleep(2500);
    return 'retry';
  }

  // Checked before the email/password early-returns: Slack leaves the form up while it shows a
  // challenge, and the old order spun until timeout instead of surfacing a checkpoint.
  if (CAPTCHA_HINT.test(body)) return checkpointOf('CAPTCHA', 'Slack is showing a CAPTCHA. Finish it in the live view (headful mode) or re-run once it clears.', true);
  if (EMAIL_CODE_HINT.test(body)) return checkpointOf('OTP', 'Slack sent a code by email/SMS. Paste it here — a TOTP secret cannot answer this step.', true);
  if (PHONE_HINT.test(body)) {
    // Approving on the phone completes by itself; give it time before asking a person.
    flow.inAppSince ??= Date.now();
    if (Date.now() - flow.inAppSince > 60_000) return checkpointOf('IN_APP_VALIDATION', 'Approve the sign-in in the Slack mobile app. Then press "Retry now".', true);
    return 'retry';
  }

  if (await b.visible(EMAIL)) {
    if (flow.enteredEmail) return 'retry';
    await b.fill(EMAIL, flow.ctx.secret.username);
    await b.click(SUBMIT);
    await b.pressEnter();
    flow.enteredEmail = true;
    await sleep(1500);
    return 'retry';
  }

  if (await b.visible(PASSWORD)) {
    if (!flow.ctx.secret.password) return checkpointOf('UNKNOWN', 'Slack wants the account password, but none is stored for this account.');
    if (flow.enteredPassword) return 'retry';
    await b.fill(PASSWORD, flow.ctx.secret.password);
    await b.click(SUBMIT);
    await b.pressEnter();
    flow.enteredPassword = true;
    await sleep(2000);
    return 'retry';
  }

  if (CAPTCHA_HINT.test(body)) return checkpointOf('CAPTCHA', 'Slack is showing a CAPTCHA. Finish it in the live view (headful mode) or re-run once it clears.', true);
  if (EMAIL_CODE_HINT.test(body)) return checkpointOf('OTP', 'Slack sent a code by email/SMS. Paste it here — a TOTP secret cannot answer this step.', true);
  if (PHONE_HINT.test(body)) {
    // Approving on the phone completes by itself; give it time before asking a person.
    flow.inAppSince ??= Date.now();
    if (Date.now() - flow.inAppSince > 60_000) return checkpointOf('IN_APP_VALIDATION', 'Approve the sign-in in the Slack mobile app. Then press "Retry now".', true);
    return 'retry';
  }
  if (/sign in to slack|welcome back|continue with email/i.test(body)) return 'retry';
  return 'retry';
}

async function pumpSlack(flow: SlackFlow, deadline: number, code?: string): Promise<LoginResult> {
  let next = code;
  while (Date.now() < deadline) {
    const r = await slackOnce(flow, next);
    next = undefined;
    if (r !== 'retry') return r;
    await sleep(1200);
  }
  return { ok: false, error: 'slack_login_timeout' };
}

async function openSlack(ctx: LoginContext): Promise<SlackFlow> {
  const live = slackFlows.get(ctx.account.id);
  if (live && live.expiresAt > Date.now()) return live;
  if (live) await live.browser.close().catch(() => null);
  await closeBrowserSession(ctx.account.id);
  // launchFor picks our own browser, a Dolphin/anti-detect profile, or a raw ws endpoint.
  const browser = await launchFor(ctx.account, ctx.secret.proxy);
  const flow: SlackFlow = { browser, ctx, enteredEmail: false, enteredPassword: false, expiresAt: Date.now() + 10 * 60_000 };
  slackFlows.set(ctx.account.id, flow);
  return flow;
}

async function closeSlack(accountId: string) {
  const flow = slackFlows.get(accountId);
  slackFlows.delete(accountId);
  if (flow) await flow.browser.close().catch(() => null);
}

export const slackBrowserDriver: AuthDriver = {
  name: 'slack-browser',
  async available() {
    if (process.env.BROWSER_WS) return { ok: true, note: 'attached to BROWSER_WS (remote CDP browser)' };
    if (process.env.DOLPHIN_API && process.env.DOLPHIN_PROFILE_ID) return { ok: true, note: `Dolphin profile ${process.env.DOLPHIN_PROFILE_ID} via ${process.env.DOLPHIN_API}` };
    if (process.env.BROWSER_URL) return { ok: true, note: `attached to ${process.env.BROWSER_URL}` };
    const bin = findChrome();
    return bin ? { ok: true, note: bin } : { ok: false, note: 'Chrome/Chromium not found — set CHROME_BIN, or point BROWSER_WS / DOLPHIN_API at an anti-detect browser profile' };
  },
  async login(ctx) {
    const flow = await openSlack(ctx);
    try {
      await flow.browser.goto('https://app.slack.com/client');
      const direct = await slackSession(flow.browser);
      if (direct) { await closeSlack(ctx.account.id); return { ok: true, session: direct.session, identity: direct.identity }; }
      await flow.browser.goto('https://slack.com/signin?redir=%2Fmessages');
      const res = await pumpSlack(flow, Date.now() + 150_000);
      if (!res.checkpoint) await closeSlack(ctx.account.id);
      return res;
    } catch (e: any) {
      await closeSlack(ctx.account.id);
      return { ok: false, error: e.message };
    }
  },
  async submitCode(accountId, code) {
    const flow = slackFlows.get(accountId);
    if (!flow) return { ok: false, error: 'no_pending_signin' };
    const res = await pumpSlack(flow, Math.min(flow.expiresAt, Date.now() + 150_000), code);
    if (!res.checkpoint) await closeSlack(accountId);
    return res;
  },
  async frame(accountId) {
    const flow = slackFlows.get(accountId);
    return flow ? flow.browser.screenshot(55) : null;
  },
  async click(accountId, x, y) {
    const flow = slackFlows.get(accountId);
    if (!flow) return false;
    await flow.browser.clickAt(x, y);
    return true;
  },
  abandon: closeSlack,
};

// ---------- Discord: native auth endpoints, so 2FA is a clean API answer instead of DOM guessing ----------
const DISCORD = () => process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
const UA = process.env.AUTH_USER_AGENT ?? 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
type DiscordFlow = { ticket: string; sms: boolean; ctx: LoginContext };
const discordFlows = new Map<string, DiscordFlow>();

async function dpost(path: string, body: unknown): Promise<{ status: number; body: any }> {
  const res = await fetch(DISCORD() + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': UA, 'x-discord-locale': 'en-US', 'x-super-properties': Buffer.from(JSON.stringify({ os: 'Mac OS X', browser: 'Chrome', device: '' })).toString('base64') },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  let j: any = {}; try { j = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: j ?? {} };
}

async function discordFinish(token: string): Promise<LoginResult> {
  const r = await fetch(`${DISCORD()}/users/@me`, { headers: { Authorization: token, 'user-agent': UA }, signal: AbortSignal.timeout(15_000) });
  if (!r.ok) return { ok: false, error: `discord_rejected_token_${r.status}` };
  const me = await r.json() as any;
  return { ok: true, session: { selfToken: token }, identity: me.username ?? me.global_name };
}

async function discordMfa(accountId: string, code: string): Promise<LoginResult> {
  const flow = discordFlows.get(accountId);
  if (!flow) return { ok: false, error: 'no_pending_signin' };
  const base = { code, ticket: flow.ticket, login: flow.ctx.secret.username, password: flow.ctx.secret.password ?? '', undeclared_user_agent: UA };
  let r = await dpost('/auth/mfa/totp', base);
  if (!r.body?.token && flow.sms) r = await dpost('/auth/mfa/sms', base);
  if (r.body?.token) { discordFlows.delete(accountId); return discordFinish(r.body.token); }
  if (r.status === 429) return { ok: false, error: 'rate_limited', retryAfterMs: Math.ceil((r.body?.retry_after ?? 5) * 1000) };
  if (r.body?.code === 'INVALID_CODE' || r.status === 400) return { ok: false, error: 'wrong_code' };
  if (r.body?.captcha_key) return checkpointOf('CAPTCHA', 'Discord wants a CAPTCHA for this sign-in. Solve it on discord.com, then press "Retry now".');
  return { ok: false, error: `discord_mfa_${r.status}` };
}

// Discord's API path answers 2FA cleanly but a fresh IP gets a CAPTCHA, which only a browser can clear.
// Fallback: the same persistent profile, discord.com/login, then the token Discord stores in localStorage.
type DiscordBrowserFlow = { browser: Browser; ctx: LoginContext; entered: boolean; expiresAt: number };
const discordBrowsers = new Map<string, DiscordBrowserFlow>();
const D_EMAIL = ['input[name="email"]', 'input[type="email"]', 'input[autocomplete="username"]'];
const D_PASS = ['input[name="password"]', 'input[type="password"]'];
const D_SUBMIT = ['button[type="submit"]', 'button[tabindex="0"]'];
const D_CODE = ['input[name="code"]', 'input[autocomplete="one-time-code"]', 'input[inputmode="numeric"]'];
const D_CAPTCHA = ['iframe[title*="aptcha" i]', 'iframe[src*="hcaptcha"]', 'iframe[src*="recaptcha"]', 'div[class*="captcha" i]'];

async function discordBrowserToken(b: Browser): Promise<string | null> {
  const raw = await b.localStorageGet('token');
  if (!raw) return null;
  let t: unknown = raw;
  try { t = JSON.parse(raw); } catch { /* already a bare token */ }
  return typeof t === 'string' && t.length > 20 ? t : null;
}

async function discordBrowserOnce(flow: DiscordBrowserFlow, code?: string): Promise<LoginResult | 'retry'> {
  const b = flow.browser;
  const token = await discordBrowserToken(b);
  if (token) return { ok: true, session: { selfToken: token }, identity: (await discordVerify(token)) ?? undefined };
  const body = (await b.text()).toLowerCase();
  if (/invalid login|login or password|incorrect password/i.test(body)) return { ok: false, error: 'bad_credentials: Discord rejected the login' };

  if (await b.visible(D_CODE)) {
    const p = flow.ctx.secret.totpSecret ? parseTotp(flow.ctx.secret.totpSecret) : null;
    const answer = code ?? (p ? totp(p.secret, { digits: p.digits, period: p.period, algorithm: p.algorithm }) : null);
    if (!answer) return checkpointOf('TWO_FA', 'Discord asked for a 2FA code. Paste it here, or save the 2FA setup key.', true);
    await b.fill(D_CODE, answer);
    await b.click(D_SUBMIT);
    await b.pressEnter();
    await sleep(2500);
    return 'retry';
  }
  // Discord keeps the form on screen behind the challenge, so this must be checked before the
  // "already typed the email" early-return or the flow spins until it times out.
  if (flow.entered && await b.visible(D_CAPTCHA)) return checkpointOf('CAPTCHA', 'Discord is showing a CAPTCHA. Solve it in the browser window (or the live view), then press "Retry now".', true);
  if (await b.visible(D_EMAIL)) {
    if (flow.entered) return 'retry';
    await b.fill(D_EMAIL, flow.ctx.secret.username);
    await b.fill(D_PASS, flow.ctx.secret.password ?? '');
    await b.click(D_SUBMIT);
    flow.entered = true;
    await sleep(3000);
    return 'retry';
  }
  return 'retry';
}

async function pumpDiscord(flow: DiscordBrowserFlow, deadline: number, code?: string): Promise<LoginResult> {
  let next = code;
  while (Date.now() < deadline) {
    const r = await discordBrowserOnce(flow, next);
    next = undefined;
    if (r !== 'retry') return r;
    await sleep(1200);
  }
  return { ok: false, error: 'discord_login_timeout' };
}

async function closeDiscordBrowser(accountId: string) {
  const flow = discordBrowsers.get(accountId);
  discordBrowsers.delete(accountId);
  if (flow?.browser) await flow.browser.close().catch(() => null);
}

async function discordBrowserLogin(ctx: LoginContext): Promise<LoginResult> {
  const live = discordBrowsers.get(ctx.account.id);
  const flow = live && live.expiresAt > Date.now() ? live : (() => {
    const created: DiscordBrowserFlow = { browser: null as unknown as Browser, ctx, entered: false, expiresAt: Date.now() + 10 * 60_000 };
    discordBrowsers.set(ctx.account.id, created);
    return created;
  })();
  try {
    if (!flow.browser) {
      await closeBrowserSession(ctx.account.id);
      flow.browser = await launchFor(ctx.account, ctx.secret.proxy);
      await flow.browser.goto('https://discord.com/login');
    }
    const res = await pumpDiscord(flow, Date.now() + 150_000);
    if (!res.checkpoint) await closeDiscordBrowser(ctx.account.id);
    return res;
  } catch (e: any) {
    await closeDiscordBrowser(ctx.account.id);
    return { ok: false, error: e.message };
  }
}

export const discordApiDriver: AuthDriver = {
  name: 'discord-api',
  async available() { return { ok: true, note: 'Discord auth endpoints (unofficial): /auth/login + /auth/mfa/totp' }; },
  async login(ctx) {
    // A previous login left a browser profile: reuse its live session first (no password, no captcha
    // if Discord still trusts the device), falling through to the browser form when it does not.
    if (existsSync(profiles(ctx.account.id))) return discordBrowserLogin(ctx);
    if (!ctx.secret.password) return { ok: false, error: 'no_password: save the account password first' };
    const r = await dpost('/auth/login', { login: ctx.secret.username, password: ctx.secret.password, undeclared_user_agent: UA });
    const j = r.body ?? {};
    if (j.token) return discordFinish(j.token);
    if (j.mfa && j.ticket) {
      discordFlows.set(ctx.account.id, { ticket: j.ticket, sms: !!j.sms, ctx });
      if (ctx.secret.totpSecret) {
        const p = parseTotp(ctx.secret.totpSecret);
        const auto = await discordMfa(ctx.account.id, totp(p.secret, { digits: p.digits, period: p.period, algorithm: p.algorithm }));
        if (auto.ok || auto.error === 'wrong_code') return auto;
      }
      return checkpointOf('TWO_FA', j.sms ? 'Discord sent a code by SMS. Paste it here.' : 'Discord asked for a 2FA code. Paste it here, or save the account\'s 2FA setup key.');
    }
    if (j.captcha_key) return discordBrowserLogin(ctx);
    if (r.status === 429) return { ok: false, error: 'rate_limited', retryAfterMs: Math.ceil((j.retry_after ?? 5) * 1000) };
    if (r.status === 400 || r.status === 401) return { ok: false, error: `bad_credentials: ${j.message ?? j.code ?? 'Discord rejected the login'}` };
    return { ok: false, error: `discord_login_${r.status}` };
  },
  async submitCode(accountId, code) {
    const flow = discordBrowsers.get(accountId);
    if (flow) {
      const res = await pumpDiscord(flow, Math.min(flow.expiresAt, Date.now() + 150_000), code);
      if (!res.checkpoint) await closeDiscordBrowser(accountId);
      return res;
    }
    return discordMfa(accountId, code);
  },
  async frame(accountId) {
    const flow = discordBrowsers.get(accountId);
    return flow?.browser ? flow.browser.screenshot(55) : null;
  },
  async click(accountId, x, y) {
    const flow = discordBrowsers.get(accountId);
    if (!flow?.browser) return false;
    await flow.browser.clickAt(x, y);
    return true;
  },
  async abandon(accountId) { discordFlows.delete(accountId); await closeDiscordBrowser(accountId); },
};

