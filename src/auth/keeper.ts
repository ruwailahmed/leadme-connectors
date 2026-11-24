import { db, save } from '../store.ts';
import type { Account } from '../types.ts';
import { autoauthFor, credentialFor, noteSessionEnd } from './reconnect.ts';

// Autonomous session keeper: every account with automatic sign-in is probed on a schedule, so a
// silently dead token is fixed before anyone notices. Re-login itself is handled by reconnect.ts.
const STALE_MS = Number(process.env.KEEPER_STALE_MS ?? 6 * 60 * 60_000);
const INTERVAL_MS = Number(process.env.KEEPER_INTERVAL_MS ?? 60_000);
let lastRun = 0;

type Probe = (a: Account) => Promise<{ ok: boolean; note?: string; identity?: string }>;
let probe: Probe = async () => ({ ok: true });
export const setKeeperProbe = (fn: Probe) => { probe = fn; };

export async function keeperTick(force = false) {
  const now = Date.now();
  if (!force && now - lastRun < INTERVAL_MS) return { checked: 0, skipped: true };
  lastRun = now;
  const targets = db.accounts.filter(a =>
    a.mode === 'live' && autoauthFor(a.id).enabled &&
    !!(a.token || a.selfToken || a.sessionCookie || credentialFor(a.id)));
  let checked = 0;
  for (const a of targets) {
    const age = now - (a.lastSync ?? 0);
    if (a.status === 'healthy' && age < STALE_MS) continue;
    checked++;
    try {
      const r = await probe(a);
      if (r.ok) {
        a.status = 'healthy'; a.statusNote = undefined; a.lastSync = now;
        if (r.identity) a.email = r.identity;
      } else noteSessionEnd(a.id, r.note ?? 'session check failed');
    } catch (e: any) {
      noteSessionEnd(a.id, e.message);
    }
  }
  if (checked) save();
  return { checked };
}

export const keeperStatus = () => ({
  staleMs: STALE_MS,
  intervalMs: INTERVAL_MS,
  watched: db.accounts.filter(a => a.mode === 'live' && autoauthFor(a.id).enabled).length,
  lastRun: lastRun || null,
});
