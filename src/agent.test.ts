import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

process.env.DATA_DIR = mkdtempSync(join(tmpdir(), 'leadme-agent-'));
process.env.TENANT_SECRET = 'agent-test-secret';
const { agentTokenFor, verifyAgentToken, parseLicense, agentMetrics } = await import('./agent.ts');
const { tenantCookieFor } = await import('./tenant.ts');
const { db } = await import('./store.ts');

test('agent token: derived per machine, rejects wrong/blank tokens', () => {
  const token = agentTokenFor('agent_a');
  assert.equal(token.length, 32);
  assert.equal(verifyAgentToken('agent_a', token), true);
  assert.equal(verifyAgentToken('agent_b', token), false, 'token does not transfer between machines');
  assert.equal(verifyAgentToken('agent_a', token.slice(0, -1) + 'x'), false);
  assert.equal(verifyAgentToken('agent_a', ''), false);
});

test('licence: a signed tenant token, tampering rejected', () => {
  const license = tenantCookieFor('acme_42');
  assert.equal(parseLicense(license), 'acme_42');
  assert.equal(parseLicense(`acme_42.${license.split('.')[1].replace(/^./, c => (c === 'A' ? 'B' : 'A'))}`), null);
  assert.equal(parseLicense('nonsense'), null);
  assert.equal(parseLicense(''), null);
});

test('agent metrics reflect the local machine state', () => {
  db.accounts.push(
    { id: 'a1', platform: 'slack', mode: 'live', label: 'x', email: 'x', status: 'healthy', createdAt: 0 },
    { id: 'a2', platform: 'discord', mode: 'live', label: 'y', email: 'y', status: 'disconnected', createdAt: 0 },
  );
  db.monitors.push({ id: 'm1', name: 'm', description: 'd', status: 'listening', targets: [], matches: 0, createdAt: 0 });
  db.alerts.push({ id: 'al', monitorId: 'm1', monitorName: 'm', message: { id: 'x', source: 'slack', accountId: 'a1', workspaceId: 'T', workspace: 'w', channelId: 'C', channel: 'c', author: { id: 'u', name: 'n' }, text: 't', ts: 0, permalink: '' }, reason: 'r', status: 'new', createdAt: 0, replies: [] });
  assert.deepEqual(agentMetrics(), { accounts: 2, healthy: 1, listening: 1, alerts: 1 });
});
