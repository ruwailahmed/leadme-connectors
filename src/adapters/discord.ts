import type { Account, Adapter, Channel, NormalizedMessage, Target, Workspace } from '../types.ts';

// Read-only polling via Discord's REST API with a bot token. Replies are human-initiated only.
const BASE = 'https://discord.com/api/v10';
async function api(a: Account, path: string, init: RequestInit = {}, asUser = false) {
  const auth = asUser && a.userToken ? `Bearer ${a.userToken}` : `Bot ${a.token}`;
  const res = await fetch(BASE + path, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) } });
  if (res.status === 429) { const j = await res.json() as any; throw new Error(`rate_limited retry-after=${j.retry_after}`); }
  if (!res.ok) throw new Error(`discord_${res.status}`);
  return res.status === 204 ? null : res.json() as Promise<any>;
}
const snowflakeTs = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);

export const discordAdapter: Adapter = {
  async check(a) { const j = await api(a, '/users/@me', {}, true); return { ok: true, identity: j.username }; },
  async workspaces(a): Promise<Workspace[]> {
    const gs = await api(a, '/users/@me/guilds?with_counts=true', {}, true);
    return gs.map((g: any) => ({ id: g.id, name: g.name, members: g.approximate_member_count ?? 0, icon: '🎮' }));
  },
  async channels(a, gid): Promise<Channel[]> {
    const cs = await api(a, `/guilds/${gid}/channels`);
    return cs.filter((c: any) => c.type === 0).map((c: any) => ({ id: c.id, name: c.name, topic: c.topic ?? undefined }));
  },
  async poll(a, targets, since): Promise<NormalizedMessage[]> {
    const after = ((BigInt(since) - 1420070400000n) << 22n).toString();
    const out: NormalizedMessage[] = [];
    const names = new Map((await this.workspaces(a)).map(w => [w.id, w.name]));
    for (const t of targets) {
      const ms = await api(a, `/channels/${t.channelId}/messages?limit=50&after=${after}`) as any[];
      for (const m of ms) {
        if (!m.content || m.author?.bot) continue;
        out.push({
          id: `discord-${m.id}`, source: 'discord', accountId: a.id, workspaceId: t.workspaceId, workspace: names.get(t.workspaceId) ?? t.workspaceId,
          channelId: t.channelId, channel: t.label.split('#').pop() ?? t.channelId,
          author: { id: m.author.id, name: m.author.global_name || m.author.username }, text: m.content, ts: snowflakeTs(m.id),
          permalink: `https://discord.com/channels/${t.workspaceId}/${t.channelId}/${m.id}`,
        });
      }
      await new Promise(r => setTimeout(r, 400));
    }
    return out;
  },
  async send(a, _w, channelId, text, userId) {
    let channel = channelId;
    if (userId) channel = (await api(a, '/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: userId }) })).id;
    await api(a, `/channels/${channel}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
  },
};
