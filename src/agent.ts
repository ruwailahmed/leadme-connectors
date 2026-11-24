import { createHmac } from 'node:crypto';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { arch, hostname, platform } from 'node:os';
import { db, DATA_DIR } from './store.ts';
import { tenantFromCookie } from './tenant.ts';

// The agent runs on the customer's machine: it owns the browsers, profiles and sessions. The cloud
// only holds the licence, the fleet view and the config. Selling this as a service = one agent per
// seat, one licence key, no browser hosting on our side.
const SECRET = () => process.env.TENANT_SECRET ?? process.env.CREDENTIALS_KEY ?? process.env.APP_PASSWORD ?? 'leadme-dev-tenant';
export const APP_VERSION = process.env.APP_VERSION ?? '1.0.0';
export const agentTokenFor = (id: string) => createHmac('sha256', SECRET()).update(`agent:${id}`).digest('base64url').slice(0, 32);
export const verifyAgentToken = (id: string, token: string) => !!token && token.length === 32 && token === agentTokenFor(id);
export const parseLicense = (license: string) => tenantFromCookie(`lm_t=${String(license ?? '').trim()}`);

export interface AgentLocal { agentId: string; token: string; license: string; controlPlane: string }
export const agentFile = () => `${DATA_DIR}/agent.json`;

export function loadAgent(): AgentLocal | null {
  try { const j = JSON.parse(readFileSync(agentFile(), 'utf8')); return j?.agentId && j?.token && j?.controlPlane ? j : null; } catch { return null; }
}

const saveAgent = (a: AgentLocal) => {
  try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(agentFile(), JSON.stringify(a)); } catch { /* read-only fs */ }
};

export const agentMetrics = () => ({
  accounts: db.accounts.length,
  healthy: db.accounts.filter(a => a.status === 'healthy').length,
  listening: db.monitors.filter(m => m.status === 'listening').length,
  alerts: db.alerts.length,
});

const controlPlane = () => (process.env.CONTROL_PLANE_URL ?? '').trim().replace(/\/$/, '');
const license = () => (process.env.LICENSE_KEY ?? '').trim();

export async function registerAgent(force = false): Promise<AgentLocal | null> {
  const cp = controlPlane(); const key = license();
  if (!cp || !key) return null;
  const saved = loadAgent();
  if (!force && saved && saved.controlPlane === cp && saved.license === key) return saved;
  const r = await fetch(`${cp}/api/agents/register`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ license: key, name: hostname(), host: hostname(), os: platform(), arch: arch(), version: APP_VERSION }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!r.ok) throw new Error(`register_${r.status}`);
  const j = await r.json() as any;
  if (!j?.agentId || !j?.token) throw new Error('register_bad_response');
  const local = { agentId: String(j.agentId), token: String(j.token), license: key, controlPlane: cp };
  saveAgent(local);
  console.log(`agent registered ${local.agentId} -> ${cp}`);
  return local;
}

export async function heartbeat(local = loadAgent()): Promise<boolean> {
  if (!local) return false;
  const r = await fetch(`${local.controlPlane}/api/agents/heartbeat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-agent-token': local.token },
    body: JSON.stringify({ agentId: local.agentId, version: APP_VERSION, ...agentMetrics() }),
    signal: AbortSignal.timeout(10_000),
  });
  return r.ok;
}

export function startAgentLoop() {
  const tick = async () => {
    try {
      const local = await registerAgent();
      if (local) await heartbeat(local);
    } catch (e: any) { console.error('agent', e.message); }
  };
  void tick();
  const t = setInterval(tick, Number(process.env.AGENT_HEARTBEAT_MS ?? 60_000));
  t.unref();
}

export const agentStatus = () => {
  const local = loadAgent();
  return {
    configured: !!controlPlane() && !!license(),
    registered: !!local,
    agentId: local?.agentId ?? null,
    controlPlane: (local?.controlPlane ?? controlPlane()) || null,
    version: APP_VERSION,
    mode: process.env.AGENT_MODE === '1' ? 'agent' : 'server',
    metrics: agentMetrics(),
    saved: !!local,
  };
};
