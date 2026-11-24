import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'leadme-vault-'));
const { totp, totpMatches, parseTotp, normalizeTotpSecret } = await import('./totp.ts');
const { seal, open, mask } = await import('./vault.ts');

// RFC 6238 appendix B vectors (SHA-1, seed "12345678901234567890").
const SEED = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

test('totp: matches the RFC 6238 SHA-1 vectors', () => {
  const cases: [number, string][] = [
    [59, '94287082'], [1111111109, '07081804'], [1111111111, '14050471'],
    [1234567890, '89005924'], [2000000000, '69279037'], [20000000000, '65353130'],
  ];
  for (const [seconds, expected] of cases) {
    assert.equal(totp(SEED, { at: seconds * 1000, digits: 8 }), expected, `T=${seconds}`);
  }
});

test('totp: accepts a setup key, a grouped key, and an otpauth URL; rejects a wrong code', () => {
  assert.equal(normalizeTotpSecret('jbsw y3dp ehpk 3pxp'), 'JBSWY3DPEHPK3PXP');
  const url = 'otpauth://totp/Slack:me%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=Slack&digits=6&period=30&algorithm=SHA1';
  const parsed = parseTotp(url);
  assert.deepEqual([parsed.secret, parsed.digits, parsed.period, parsed.algorithm], ['JBSWY3DPEHPK3PXP', 6, 30, 'sha1']);
  assert.equal(parsed.issuer, 'Slack');
  const code = totp('JBSWY3DPEHPK3PXP');
  assert.equal(totpMatches('JBSWY3DPEHPK3PXP', code), true);
  assert.equal(totpMatches('JBSWY3DPEHPK3PXP', code === '000000' ? '111111' : '000000', 0), false);
});

test('vault: sealed credentials round-trip, mask hides secrets, tampering is rejected', () => {
  const secret = { username: 'me@example.com', password: 'hunter2', totpSecret: 'JBSWY3DPEHPK3PXP', proxy: 'http://u:p@1.2.3.4:8080' };
  const sealed = seal(secret);
  assert.ok(!sealed.includes('hunter2'), 'plaintext never appears in the stored blob');
  assert.deepEqual(open(sealed), secret);
  const masked = mask(open(sealed));
  assert.equal(masked.hasPassword, true);
  assert.equal(masked.hasTotp, true);
  assert.equal(masked.proxy, 'http://***@1.2.3.4:8080');
  assert.equal(masked.totpPreview, 'JBSW…3PXP');
  const tampered = sealed.slice(0, -2) + (sealed.endsWith('AA') ? 'BB' : 'AA');
  assert.throws(() => open(tampered));
});
