import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

// Credentials are sealed at rest. CREDENTIALS_KEY is the real key; APP_PASSWORD or the built-in
// string keep a fresh clone working, and the console says which one is in use.
const KEY_SOURCE = process.env.CREDENTIALS_KEY || process.env.APP_PASSWORD;
export const vaultStrength = process.env.CREDENTIALS_KEY ? 'CREDENTIALS_KEY' : process.env.APP_PASSWORD ? 'APP_PASSWORD' : 'builtin-dev-key';
const KEY = scryptSync(KEY_SOURCE || 'leadme-dev-vault-v1', 'leadme-vault-v1', 32);
const PREFIX = 'v1';

export interface Secret {
  username: string;
  password?: string;
  totpSecret?: string;
  backupCodes?: string[];
  proxy?: string;
  notes?: string;
}

export function seal(secret: Secret): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', KEY, iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(secret), 'utf8'), cipher.final()]);
  return [PREFIX, iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join('.');
}

export function open(sealed: string): Secret {
  const [prefix, iv, tag, ct] = String(sealed ?? '').split('.');
  if (prefix !== PREFIX || !iv || !tag || !ct) throw new Error('stored credential is not readable (wrong CREDENTIALS_KEY?)');
  const decipher = createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8'));
}

export interface MaskedSecret {
  username: string;
  hasPassword: boolean;
  hasTotp: boolean;
  backupCodes: number;
  proxy: string | null;
  totpPreview: string | null;
}

export const mask = (s: Secret): MaskedSecret => ({
  username: s.username,
  hasPassword: !!s.password,
  hasTotp: !!s.totpSecret,
  backupCodes: s.backupCodes?.length ?? 0,
  proxy: s.proxy ? s.proxy.replace(/\/\/[^@]*@/, '//***@') : null,
  totpPreview: s.totpSecret ? `${s.totpSecret.slice(0, 4)}…${s.totpSecret.slice(-4)}` : null,
});
