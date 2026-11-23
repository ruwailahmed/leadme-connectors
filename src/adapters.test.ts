import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { Account } from './types.ts';

const nowS = () => (Date.now() / 1000).toFixed(6);
const slackMsgs = [{ ts: nowS(), user: 'U1', text: 'Anyone have <@U2> LinkedIn accounts for rent? <https://x.io|site>' }, { ts: nowS(), subtype: 'channel_join', user: 'U9', text: 'joined' }];
const mock = http.createServer(async (req, res) => {
  const u = new URL(req.url!, 'http://x'); const send = (o: unknown, code = 200) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.headers.authorization === 'Bearer bad') return send({ ok: false, error: 'invalid_auth' });
  if (u.pathname === '/slack/auth.test' && req.headers.cookie === 'd=xoxd-session') return send({ ok: true, team: 'Demo Workspace', team_id: 'T9', user: 'kodak' });
  if (u.pathname === '/slack/auth.test') return send({ ok: true, team: 'GTMCafe', team_id: 'T1', user: 'kodak' });
  if (u.pathname === '/slack/team.info') return send({ ok: true, team: { member_count: 3100 } });
  if (u.pathname === '/slack/users.conversations') return send({ ok: true, channels: [
    { id: 'C1', name: 'jobs', num_members: 2400 }, { id: 'C2', name: 'general', num_members: 3100 },
    { id: 'D1', is_im: true, user: 'U2' }, { id: 'G1', is_mpim: true } ], response_metadata: { next_cursor: '' } });
  if (u.pathname === '/slack/conversations.members') return send({ ok: true, members: ['U1', 'U2'] });
  if (u.pathname === '/slack/users.info') return send({ ok: true, user: { real_name: u.searchParams.get('user') === 'U2' ? 'Dana W' : 'Maya Chen' } });
  if (u.pathname === '/slack/conversations.history') return send({ ok: true, messages: slackMsgs });
  if (u.pathname === '/discord/users/@me/guilds') return send(req.headers.authorization!.startsWith('Bot') ? [{ id: 'G1', name: 'Growth Operators' }] : [{ id: 'G1', name: 'Growth Operators', approximate_member_count: 9800 }, { id: 'G2', name: 'No Bot Here', approximate_member_count: 50 }]);
  if (u.pathname === '/discord/guilds/G2/channels' && req.headers.authorization === 'raw-self-token') return send([{ id: 'D9', name: 'staff-only', type: 0 }]);
  if (u.pathname === '/discord/guilds/G1/channels') return send([{ id: 'D1', name: 'lead-gen', type: 0 }, { id: 'D2', name: 'voice', type: 2 }]);
  if (u.pathname === '/discord/guilds/G2/channels') return send({ message: 'Missing Access' }, 403);
  if (u.pathname === '/discord/channels/D1/messages') return send([{ id: '1166000000000000000', content: 'Need cold email infrastructure', author: { id: 'A1', username: 'sam', global_name: 'Sam O' } }, { id: '1166000000000000001', content: 'bot spam', author: { id: 'B', username: 'bot', bot: true } }]);
  send({ ok: false, error: 'unknown' }, 404);
});
await new Promise<void>(r => mock.listen(0, r));
const port = (mock.address() as any).port;
process.env.SLACK_API_BASE = `http://localhost:${port}/slack`;
process.env.DISCORD_API_BASE = `http://localhost:${port}/discord`;
const { slackAdapter } = await import('./adapters/slack.ts');
const { discordAdapter } = await import('./adapters/discord.ts');
const acc = (platform: 'slack' | 'discord', extra: Partial<Account> = {}): Account => ({ id: 'a_' + platform, platform, mode: 'live', label: 'x', email: 'x', token: 't', status: 'healthy', createdAt: 0, ...extra });

test('slack: workspace, member channels, history with cleaned text', async () => {
  const a = acc('slack');
  const ws = await slackAdapter.workspaces(a); assert.deepEqual([ws[0].name, ws[0].members], ['GTMCafe', 3100]);
  const ch = await slackAdapter.channels(a, 'T1');
  assert.deepEqual(ch.map(c => c.kind), ['channel', 'channel', 'im', 'mpim'], 'real channels first, then DMs/group DMs');
  assert.equal(ch[0].name, 'general');
  assert.equal(ch.find(c => c.kind === 'im')!.name, 'DM: Dana W');
  assert.equal(ch.find(c => c.kind === 'mpim')!.name, 'Group DM: Maya Chen, Dana W');
  const h = await slackAdapter.history(a, 'T1', 'C1', 10);
  assert.equal(h.length, 1, 'system subtypes are skipped');
  assert.equal(h[0].text, 'Anyone have @Dana W LinkedIn accounts for rent? site (https://x.io)');
  assert.equal(h[0].author.name, 'Maya Chen'); assert.equal(h[0].workspace, 'GTMCafe');
});
test('slack: poll returns normalized messages for targets', async () => {
  const m = await slackAdapter.poll(acc('slack'), [{ accountId: 'a_slack', workspaceId: 'T1', channelId: 'C1', label: 'GTMCafe #jobs' }], Date.now() - 5000);
  assert.equal(m.length, 1); assert.equal(m[0].channel, 'jobs'); assert.equal(m[0].source, 'slack');
});
test('slack: session-cookie mode (own account, own workspace) authenticates via cookie, not Bearer', async () => {
  const a = acc('slack', { token: 'xoxc-fake', sessionCookie: 'xoxd-session' });
  const r = await slackAdapter.check(a);
  assert.equal(r.identity, 'kodak@Demo Workspace');
});
test('slack: bad token surfaces as an error (drives the health status)', async () => {
  await assert.rejects(slackAdapter.workspaces(acc('slack', { id: 'a_bad', token: 'bad' })), /invalid_auth/);
});
test('discord: lists user servers and flags the one without the bot', async () => {
  const ws = await discordAdapter.workspaces(acc('discord', { userToken: 'u' }));
  assert.deepEqual(ws.map(w => [w.name, w.needsBot]), [['Growth Operators', false], ['No Bot Here', true]]);
});
test('discord: text channels only; missing bot gives a clear error', async () => {
  const a = acc('discord', { userToken: 'u' });
  assert.deepEqual((await discordAdapter.channels(a, 'G1')).map(c => c.name), ['lead-gen']);
  await assert.rejects(discordAdapter.channels(a, 'G2'), /bot_not_in_server/);
});
test('discord: poll drops bot messages', async () => {
  const m = await discordAdapter.poll(acc('discord', { userToken: 'u' }), [{ accountId: 'a_discord', workspaceId: 'G1', channelId: 'D1', label: 'Growth Operators #lead-gen' }], Date.now() - 1000);
  assert.equal(m.length, 1); assert.equal(m[0].author.name, 'Sam O'); assert.match(m[0].permalink, /channels\/G1\/D1\//);
});
test('discord: selfToken reads a server with no bot present, auth header is the raw token (no prefix)', async () => {
  const a = acc('discord', { selfToken: 'raw-self-token' });
  const ws = await discordAdapter.workspaces(a); assert.equal(ws.every(w => w.needsBot === undefined), true, 'no bot-invite gating in self-token mode');
  const ch = await discordAdapter.channels(a, 'G2'); assert.deepEqual(ch.map(c => c.name), ['staff-only']);
});
test.after(() => mock.close());
