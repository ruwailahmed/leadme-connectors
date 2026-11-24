import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Account } from './types.ts';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'leadme-profile-'));
const { fingerprintFor, profileDirFor, DEFAULT_UA } = await import('./auth/session.ts');

const acc = (extra: Partial<Account> = {}): Account => ({ id: 'acc_1', platform: 'slack', mode: 'live', label: 'x', email: 'x', status: 'healthy', createdAt: 0, ...extra });

test('fingerprint: defaults are stable, account overrides win, proxy falls back to the credential', () => {
  const base = fingerprintFor(acc());
  assert.equal(base.userAgent, DEFAULT_UA);
  assert.equal(base.locale, 'en-US');
  assert.deepEqual([base.width, base.height], [1280, 800]);
  const custom = fingerprintFor(acc({ browser: { mode: 'builtin', fingerprint: { userAgent: 'UA-X', timezone: 'Europe/Berlin', locale: 'de-DE', width: 1440, height: 900, colorScheme: 'dark' } } }), 'http://p:1');
  assert.equal(custom.userAgent, 'UA-X');
  assert.equal(custom.timezone, 'Europe/Berlin');
  assert.equal(custom.locale, 'de-DE');
  assert.deepEqual([custom.width, custom.height, custom.colorScheme], [1440, 900, 'dark']);
  assert.equal(custom.proxy, 'http://p:1', 'credential proxy is used when the profile has none');
});

test('profile: one directory per account, path-safe', () => {
  assert.match(profileDirFor('acc_1'), /profiles\/acc_1$/);
  assert.equal(profileDirFor('acc/../evil'), profileDirFor('acc..evil'));
  assert.ok(!profileDirFor('a/b').includes('/b'));
});
