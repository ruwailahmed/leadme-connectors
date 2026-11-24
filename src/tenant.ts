import { createHmac, timingSafeEqual } from 'node:crypto';

// One signed cookie per end user, minted by leadme's backend. No shared console password, no second login.
const SECRET = () => process.env.TENANT_SECRET ?? process.env.CREDENTIALS_KEY ?? process.env.APP_PASSWORD ?? 'leadme-dev-tenant';
export const DEFAULT_TENANT = process.env.DEFAULT_TENANT ?? 'default';
export const ownerOf = (tenantId?: string) => (tenantId && tenantId.trim()) || DEFAULT_TENANT;

const sig = (id: string) => createHmac('sha256', SECRET()).update(`tenant:${id}`).digest('base64url').slice(0, 32);
const eq = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

export const tenantCookieFor = (id: string) => `${id}.${sig(id)}`;

export function tenantFromCookie(cookie?: string): string | null {
  const raw = /(?:^|;\s*)lm_t=([^;]+)/.exec(cookie ?? '')?.[1];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 1) return null;
  const id = raw.slice(0, i);
  const given = raw.slice(i + 1);
  return eq(given, sig(id)) ? id : null;
}

export const connectUrl = (baseUrl: string, tenantId: string, platform?: 'slack' | 'discord') =>
  `${baseUrl.replace(/\/$/, '')}/connect?t=${encodeURIComponent(tenantCookieFor(tenantId))}${platform ? `&platform=${platform}` : ''}`;
