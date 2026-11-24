import { createHmac } from 'node:crypto';

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32Decode(input: string): Buffer {
  const clean = input.toUpperCase().replace(/[\s-]/g, '').replace(/=+$/, '');
  let bits = 0; let value = 0; const out: number[] = [];
  for (const ch of clean) {
    const idx = ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`invalid base32 character "${ch}"`);
    value = (value << 5) | idx; bits += 5;
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 0xff); bits -= 8; }
  }
  return Buffer.from(out);
}

export const isBase32 = (s: string) => /^[A-Z2-7\s=-]{16,}$/i.test(s.trim());

export interface TotpOptions { digits?: number; period?: number; at?: number; drift?: number; algorithm?: 'sha1' | 'sha256' | 'sha512' }

export function totp(secret: string, opts: TotpOptions = {}): string {
  const digits = opts.digits ?? 6;
  const period = opts.period ?? 30;
  const counter = Math.floor((opts.at ?? Date.now()) / 1000 / period) + (opts.drift ?? 0);
  const buf = Buffer.alloc(8);
  buf.writeUInt32BE(Math.floor(counter / 2 ** 32), 0);
  buf.writeUInt32BE(counter % 2 ** 32, 4);
  const mac = createHmac(opts.algorithm ?? 'sha1', base32Decode(secret)).update(buf).digest();
  const offset = mac[mac.length - 1] & 0x0f;
  const code = ((mac[offset] & 0x7f) << 24) | (mac[offset + 1] << 16) | (mac[offset + 2] << 8) | mac[offset + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

// Accepts a setup key, a spaced/grouped key, or a full otpauth:// URL pasted from the QR code.
export function parseTotp(input: string): { secret: string; digits: number; period: number; algorithm: 'sha1' | 'sha256' | 'sha512'; issuer?: string; account?: string } {
  const raw = String(input ?? '').trim();
  if (/^otpauth:\/\//i.test(raw)) {
    const u = new URL(raw);
    const algo = (u.searchParams.get('algorithm') ?? 'SHA1').toLowerCase();
    const label = decodeURIComponent(u.pathname.replace(/^\/totp\//i, ''));
    const [issuer, account] = label.includes(':') ? label.split(':') : [undefined, label];
    return {
      secret: (u.searchParams.get('secret') ?? '').toUpperCase(),
      digits: Number(u.searchParams.get('digits') ?? 6),
      period: Number(u.searchParams.get('period') ?? 30),
      algorithm: (algo === 'sha256' || algo === 'sha512' ? algo : 'sha1') as 'sha1' | 'sha256' | 'sha512',
      issuer: u.searchParams.get('issuer') ?? issuer,
      account,
    };
  }
  return { secret: raw.toUpperCase().replace(/[\s-]/g, ''), digits: 6, period: 30, algorithm: 'sha1' };
}

// A secret answers authenticator challenges only; everything else needs a person (the PDF's rule).
export const normalizeTotpSecret = (input: string) => parseTotp(input).secret;

export function totpMatches(secret: string, code: string, window = 1): boolean {
  const given = String(code ?? '').replace(/\s/g, '');
  if (!/^\d{6,8}$/.test(given)) return false;
  const parsed = parseTotp(secret);
  for (let drift = -window; drift <= window; drift++) {
    const v = totp(parsed.secret, { digits: parsed.digits, period: parsed.period, algorithm: parsed.algorithm, drift });
    if (v === given) return true;
  }
  return false;
}
