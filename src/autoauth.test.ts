import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from './types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'leadme-auth-'));
process.env.SESSION_WEBHOOK_SECRET = 'whsec_test';
const { db, uid } = await import('./store.ts');
const R = await import('./auth/reconnect.ts');

const mk = async (platform: 'slack' | 'discord' = 'slack') => {
  const a: Account = { id: uid('acc'), platform, mode: 'live', label: 'x', email: 'x', status: 'healthy', createdAt: 0 };
  db.accounts.push(a);
  R.saveCredentials(a, { username: 'me@example.com', password: 'pw', totpSecret: 'JBSWY3DPEHPK3PXP', enabled: true });
  return a;
};

let calls = 0;
let login: () => Promise<any> = async () => ({ ok: true, session: { token: 'xoxc-new', sessionCookie: 'xoxd-new' }, identity: 'Acme HQ' });
R.setDriverResolver(() => ({
  name: 'fake',
  available: async () => ({ ok: true }),
  login: () => { calls++; return login(); },
  submitCode: async (_id: string, code: string) => ({ ok: true, session: { token: `xoxc-${code}` }, identity: 'Acme HQ' }),
  frame: async () => null,
  abandon: async () => {},
}));

test('backoff: the documented ladder, capped at six hours', () => {
  assert.deepEqual([1, 2, 3, 7, 8, 99].map(R.backoffFor), [2, 5, 15, 240, 360, 360]);
});

test('run: a successful sign-in replaces the session and clears the failure count', async () => {
  const a = await mk();
  calls = 0; login = async () => ({ ok: true, session: { token: 'xoxc-new', sessionCookie: 'xoxd-new' }, identity: 'Acme HQ' });
  const e = await R.runNow(a.id, 'test');
  assert.equal(calls, 1);
  assert.equal(e.status, 'succeeded');
  assert.equal(e.attempts, 0);
  assert.equal(a.token, 'xoxc-new');
  assert.equal(a.sessionCookie, 'xoxd-new');
  assert.equal(a.email, 'Acme HQ');
  assert.equal(a.status, 'healthy');
});

test('run: one sign-in at a time per account', async () => {
  const a = await mk();
  calls = 0;
  let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  login = async () => { await gate; return { ok: true, session: { token: 'xoxc-slow' } }; };
  const first = R.runNow(a.id, 'test');
  const second = R.runNow(a.id, 'test');
  release();
  await Promise.all([first, second]);
  assert.equal(calls, 1, 'the second call joins the in-flight attempt instead of starting a new sign-in');
});

test('run: a checkpoint pauses retries until a code arrives, then finishes', async () => {
  const a = await mk();
  calls = 0;
  login = async () => ({ ok: false, checkpoint: { type: 'TWO_FA', prompt: 'enter the code', liveView: true } });
  const paused = await R.runNow(a.id, 'test');
  assert.equal(paused.status, 'waiting_human');
  assert.equal(paused.checkpoint!.type, 'TWO_FA');
  assert.equal(paused.nextRetryAt, undefined, 'no timer while a person is needed');
  const done = await R.submitCode(a.id, '123456');
  assert.equal(done.status, 'succeeded');
  assert.equal(a.token, 'xoxc-123456');
  assert.equal(done.checkpoint, undefined);
});

test('run: a failure schedules the next attempt instead of hammering the provider', async () => {
  const a = await mk();
  login = async () => ({ ok: false, error: 'bad_credentials: nope' });
  const e = await R.runNow(a.id, 'test');
  assert.equal(e.status, 'failed');
  assert.equal(e.lastError, 'bad_credentials: nope');
  assert.ok(e.nextRetryAt! > Date.now());
});

test('run: an account with no saved credentials waits instead of retrying every second', async () => {
  const a: Account = { id: uid('acc'), platform: 'slack', mode: 'live', label: 'x', email: 'x', status: 'disconnected', createdAt: 0 };
  db.accounts.push(a);
  R.setEnabled(a.id, true);
  const e = await R.runNow(a.id, 'test');
  assert.equal(e.status, 'failed');
  assert.match(e.lastError!, /no stored credentials/);
  assert.ok(e.nextRetryAt! > Date.now() + 60_000, 'two-minute floor before the next attempt');
});

test('webhook: signed body triggers a reconnect; retries dedupe; older events lose', () => {
  const a = db.accounts[0];
  const raw = (emitted: string) => Buffer.from(JSON.stringify({ event_id: `evt_${emitted}`, emitted_at: emitted, livemode: true, AccountStatus: { account_id: a.id, message: 'CREDENTIALS' } }));
  const sign = (b: Buffer) => createHmac('sha256', 'whsec_test').update(b).digest('base64url');

  const first = raw('2026-11-17T09:12:44.000Z');
  assert.equal(R.verifySignature(first, sign(first), 'whsec_test'), true);
  assert.equal(R.verifySignature(first, 'nope', 'whsec_test'), false);
  assert.equal(R.ingestStatusEvent(first, sign(first)).action, 'reconnect');
  assert.equal(R.ingestStatusEvent(first, sign(first)).duplicate, true, 'a retry keeps the same event_id');
  assert.equal(R.ingestStatusEvent(raw('2026-11-17T09:00:00.000Z'), sign(raw('2026-11-17T09:00:00.000Z'))).stale, true, 'out-of-order events do not win');
  assert.equal(R.ingestStatusEvent(raw('2026-11-17T09:20:00.000Z'), sign(raw('2026-11-17T09:20:00.000Z'))).action, 'reconnect');
  assert.throws(() => R.ingestStatusEvent(first, 'bad'), /signature/);
});
