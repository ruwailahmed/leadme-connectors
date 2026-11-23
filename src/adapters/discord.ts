import type { Account, Adapter, Channel, NormalizedMessage, Workspace } from '../types.ts';

// Read-only polling via Discord's REST API. Server list comes from the user's OAuth sign-in;
// message reads use the app's bot, which a server admin must have invited (and Message Content intent enabled).
const BASE = () => process.env.DISCORD_API_BASE ?? 'https://discord.com/api/v10';
let refresher: ((a: Account) => Promise<boolean>) | undefined;
export const setDiscordRefresher = (fn: (a: Account) => Promise<boolean>) => { refresher = fn; };

async function api(a: Account, path: string, init: RequestInit = {}, asUser = false): Promise<any> {
  if (asUser && a.userToken && a.userTokenExp && a.userTokenExp < Date.now() + 60_000 && refresher) await refresher(a);
  const auth = asUser && a.userToken ? `Bearer ${a.userToken}` : `Bot ${a.token}`;
  const res = await fetch(BASE() + path, { ...init, headers: { Authorization: auth, 'Content-Type': 'application/json', ...(init.headers ?? {}) }, signal: AbortSignal.timeout(15000) });
  if (res.status === 401 && asUser && refresher && await refresher(a)) return api(a, path, init, asUser);
  if (res.status === 429) { const j = await res.json() as any; throw new Error(`rate_limited retry-after=${j.retry_after}`); }
  if (res.status === 403 || res.status === 404) throw new Error('bot_not_in_server');
  if (!res.ok) throw new Error(`discord_${res.status}`);
  return res.status === 204 ? null : res.json();
}
const snowflakeTs = (id: string) => Number((BigInt(id) >> 22n) + 1420070400000n);
const toSnowflake = (ms: number) => ((BigInt(ms) - 1420070400000n) << 22n).toString();
const guildNames = new Map<string, string>(); const chanNames = new Map<string, string>();

function normalize(a: Account, m: any, guildId: string, channelId: string): NormalizedMessage {
  return {
    id: `discord-${m.id}`, source: 'discord', accountId: a.id, workspaceId: guildId, workspace: guildNames.get(guildId) ?? guildId,
    channelId, channel: chanNames.get(channelId) ?? channelId, author: { id: m.author.id, name: m.author.global_name || m.author.username },
    text: m.content, ts: snowflakeTs(m.id), permalink: `https://discord.com/channels/${guildId}/${channelId}/${m.id}`,
  };
}

export const discordAdapter: Adapter = {
  async check(a) { const j = await api(a, '/users/@me', {}, true); return { ok: true, identity: j.username }; },
  async workspaces(a): Promise<Workspace[]> {
    const mine: any[] = await api(a, '/users/@me/guilds?with_counts=true', {}, true);
    let botIn = new Set<string>();
    if (a.token) { try { botIn = new Set((await api(a, '/users/@me/guilds')).map((g: any) => g.id)); } catch { /* bot token missing/invalid */ } }
    for (const g of mine) guildNames.set(g.id, g.name);
    return mine.map(g => ({ id: g.id, name: g.name, members: g.approximate_member_count ?? 0, icon: '🎮', needsBot: !botIn.has(g.id) }));
  },
  async channels(a, gid): Promise<Channel[]> {
    const cs = await api(a, `/guilds/${gid}/channels`);
    for (const c of cs) chanNames.set(c.id, c.name);
    return cs.filter((c: any) => c.type === 0 || c.type === 5).map((c: any) => ({ id: c.id, name: c.name, topic: c.topic ?? undefined })).sort((x: Channel, y: Channel) => x.name.localeCompare(y.name));
  },
  async history(a, gid, channelId, limit) {
    const ms: any[] = await api(a, `/channels/${channelId}/messages?limit=${Math.min(limit, 100)}`);
    return ms.filter(m => m.content && !m.author?.bot).map(m => normalize(a, m, gid, channelId));
  },
  async poll(a, targets, since) {
    const out: NormalizedMessage[] = [];
    for (const t of targets) {
      chanNames.set(t.channelId, t.label.split('#').pop() ?? t.channelId);
      const ms: any[] = await api(a, `/channels/${t.channelId}/messages?limit=100&after=${toSnowflake(since)}`);
      for (const m of ms) if (m.content && !m.author?.bot) out.push(normalize(a, m, t.workspaceId, t.channelId));
      await new Promise(r => setTimeout(r, 350));
    }
    return out;
  },
  async send(a, _w, channelId, text, userId) {
    let channel = channelId;
    if (userId) channel = (await api(a, '/users/@me/channels', { method: 'POST', body: JSON.stringify({ recipient_id: userId }) })).id;
    await api(a, `/channels/${channel}/messages`, { method: 'POST', body: JSON.stringify({ content: text }) });
  },
};
