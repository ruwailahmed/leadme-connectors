import type { Account, Adapter, Channel, NormalizedMessage, Target, Workspace } from '../types.ts';

// Read-only listening via Slack's Web API using a token the account owner supplies.
// Replies are human-initiated only (chat.postMessage from the console). Polite rate limits.
async function api(a: Account, method: string, params: Record<string, string | number> = {}, post = false) {
  const url = new URL(`https://slack.com/api/${method}`);
  const init: RequestInit = { headers: { Authorization: `Bearer ${a.token}` } };
  if (post) {
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json; charset=utf-8' };
    init.body = JSON.stringify(params);
  } else for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await fetch(url, init);
  if (res.status === 429) throw new Error(`rate_limited retry-after=${res.headers.get('retry-after')}`);
  const j = await res.json() as any;
  if (!j.ok) throw new Error(j.error ?? 'slack_error');
  return j;
}
const userCache = new Map<string, string>();
async function userName(a: Account, id?: string) {
  if (!id) return 'unknown';
  const k = a.id + id;
  if (userCache.has(k)) return userCache.get(k)!;
  try { const j = await api(a, 'users.info', { user: id }); const n = j.user.real_name || j.user.name; userCache.set(k, n); return n; }
  catch { return id; }
}

export const slackAdapter: Adapter = {
  async check(a) { const j = await api(a, 'auth.test'); return { ok: true, identity: `${j.user}@${j.team}` }; },
  async workspaces(a): Promise<Workspace[]> {
    const j = await api(a, 'auth.test');
    let members = 0;
    try { members = (await api(a, 'team.info')).team?.member_count ?? 0; } catch { /* scope optional */ }
    return [{ id: j.team_id, name: j.team, members, icon: '💬' }];
  },
  async channels(a): Promise<Channel[]> {
    const out: Channel[] = []; let cursor = '';
    do {
      const j = await api(a, 'conversations.list', { types: 'public_channel', exclude_archived: 'true', limit: 200, cursor });
      for (const c of j.channels) out.push({ id: c.id, name: c.name, topic: c.topic?.value, members: c.num_members });
      cursor = j.response_metadata?.next_cursor ?? '';
    } while (cursor && out.length < 2000);
    return out.sort((x, y) => (y.members ?? 0) - (x.members ?? 0));
  },
  async poll(a, targets, since): Promise<NormalizedMessage[]> {
    const ws = (await this.workspaces(a))[0];
    const out: NormalizedMessage[] = [];
    for (const t of targets) {
      const j = await api(a, 'conversations.history', { channel: t.channelId, oldest: (since / 1000).toFixed(6), limit: 50 });
      for (const m of j.messages as any[]) {
        if (m.subtype || !m.text) continue;
        out.push({
          id: `slack-${t.channelId}-${m.ts}`, source: 'slack', accountId: a.id, workspaceId: ws.id, workspace: ws.name,
          channelId: t.channelId, channel: t.label.split('#').pop() ?? t.channelId,
          author: { id: m.user, name: await userName(a, m.user) }, text: m.text, ts: Math.round(Number(m.ts) * 1000),
          permalink: `https://app.slack.com/client/${ws.id}/${t.channelId}/thread/${t.channelId}-${m.ts}`,
        });
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return out;
  },
  async send(a, _w, channelId, text, userId) {
    let channel = channelId;
    if (userId) channel = (await api(a, 'conversations.open', { users: userId }, true)).channel.id;
    await api(a, 'chat.postMessage', { channel, text }, true);
  },
};
