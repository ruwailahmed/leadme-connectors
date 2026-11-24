import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'leadme-tenant-'));
const { tenantCookieFor, tenantFromCookie, ownerOf, DEFAULT_TENANT, connectUrl } = await import('./tenant.ts');

test('tenant: a signed cookie round-trips and rejects tampering', () => {
  const c = tenantCookieFor('user_123');
  assert.equal(tenantFromCookie(`lm_t=${c}`), 'user_123');
  assert.equal(tenantFromCookie(`lm=abc; lm_t=${c}; other=1`), 'user_123');
  const [id, sig] = c.split('.');
  const flipped = `${sig[0] === 'A' ? 'B' : 'A'}${sig.slice(1)}`;
  assert.equal(tenantFromCookie(`lm_t=${id}.${flipped}`), null, 'flipped signature is rejected');
  assert.equal(tenantFromCookie(`lm_t=user_999.${sig}`), null, 'signature does not transfer to another tenant');
  assert.equal(tenantFromCookie(''), null);
  assert.equal(tenantFromCookie(undefined), null);
});

test('tenant: old rows without a tenant belong to the default one', () => {
  assert.equal(ownerOf(undefined), DEFAULT_TENANT);
  assert.equal(ownerOf(''), DEFAULT_TENANT);
  assert.equal(ownerOf('agency_9'), 'agency_9');
});

test('tenant: connect URLs are signed and carry the platform', () => {
  const u = new URL(connectUrl('https://connectors.example.com/', 'agency_9', 'slack'));
  assert.equal(u.pathname, '/connect');
  assert.equal(u.searchParams.get('platform'), 'slack');
  assert.equal(tenantFromCookie(`lm_t=${u.searchParams.get('t')}`), 'agency_9');
});
