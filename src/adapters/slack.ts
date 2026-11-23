import type { Account, Adapter, Channel, NormalizedMessage, Workspace } from '../types.ts';

// Read-only listening through Slack's Web API with the user token from "Continue with Slack".
// Replies are human-initiated only. Polite rate limits.
const BASE = () => process.env.SLACK_API_BASE ?? 'https://slack.com/api';

async function api(a: Account, method: string, params: Record<string, string | number> = {}, post = false) {
  const url = new URL(`${BASE()}/${method}`);
  const init: RequestInit = { headers: { Authorization: `Bearer ${a.token}` }, signal: AbortSignal.timeout(15000) };
  if (post) {
    init.method = 'POST';
    init.headers = { ...init.headers, 'Content-Type': 'application/json; charset=utf-8' };
    init.body = JSON.stringify(params);
  } else for (const [k, v] of Object.entries(params)) if (v !== '') url.searchParams.set(k, String(v));
  const res = await fetch(url, init);
  if (res.status === 429) throw new Error(`rate_limited retry-after=${res.headers.get('retry-after')}`);
  const j = await res.json() as any;
  if (!j.ok) throw new Error(j.error ?? 'slack_error');
  return j;
}

const names = new Map<string, string>();
async function userName(a: Account, id?: string) {
  if (!id) return 'unknown';
  const k = a.id + id;
  if (names.has(k)) return names.get(k)!;
  try { const j = await api(a, 'users.info', { user: id }); const n = j.user.real_name || j.user.profile?.display_name || j.user.name; names.set(k, n); return n; }
  catch { return id; }
}
async function clean(a: Account, text: string) {
  let out = text;
  for (const id of new Set([...text.matchAll(/<@([UW][A-Z0-9]+)>/g)].map(m => m[1]).slice(0, 10))) out = out.replaceAll(`<@${id}>`, '@' + await userName(a, id));
  return out.replace(/<(https?:[^|>]+)\|([^>]+)>/g, '$2 ($1)').replace(/<(https?:[^>]+)>/g, '$1').replace(/<#[A-Z0-9]+\|([^>]+)>/g, '#$1').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}

const team = new Map<string, { id: string; name: string }>();
async function whoami(a: Account) {
  if (!team.has(a.id)) { const j = await api(a, 'auth.test'); team.set(a.id, { id: j.team_id, name: j.team }); }
  return team.get(a.id)!;
}

async function normalize(a: Account, m: any, channelId: string, channelName: string): Promise<NormalizedMessage> {
  const t = await whoami(a);
  return {
    id: `slack-${channelId}-${m.ts}`, source: 'slack', accountId: a.id, workspaceId: t.id, workspace: t.name, channelId, channel: channelName,
    author: { id: m.user, name: await userName(a, m.user) }, text: await clean(a, m.text), ts: Math.round(Number(m.ts) * 1000),
    permalink: `https://app.slack.com/client/${t.id}/${channelId}/thread/${channelId}-${m.ts}`,
  };
}
const channelNames = new Map<string, string>();

export const slackAdapter: Adapter = {
  async check(a) { const j = await api(a, 'auth.test'); return { ok: true, identity: `${j.user}@${j.team}` }; },
  async workspaces(a): Promise<Workspace[]> {
    const t = await whoami(a);
    let members = 0;
    try { members = (await api(a, 'team.info')).team?.member_count ?? 0; } catch { /* scope optional */ }
    return [{ id: t.id, name: t.name, members, icon: '💬' }];
  },
  // Channels the user is actually in (history is readable for those), public and private.
  async channels(a): Promise<Channel[]> {
    const out: Channel[] = []; let cursor = '';
    do {
      const j = await api(a, 'users.conversations', { types: 'public_channel,private_channel', exclude_archived: 'true', limit: 200, cursor });
      for (const c of j.channels) { out.push({ id: c.id, name: c.name, topic: c.topic?.value, members: c.num_members }); channelNames.set(a.id + c.id, c.name); }
      cursor = j.response_metadata?.next_cursor ?? '';
    } while (cursor && out.length < 2000);
    return out.sort((x, y) => (y.members ?? 0) - (x.members ?? 0));
  },
  async history(a, _w, channelId, limit) {
    const j = await api(a, 'conversations.history', { channel: channelId, limit });
    const name = channelNames.get(a.id + channelId) ?? channelId;
    const msgs = (j.messages as any[]).filter(m => !m.subtype && m.text);
    return Promise.all(msgs.map(m => normalize(a, m, channelId, name)));
  },
  async poll(a, targets, since) {
    const out: NormalizedMessage[] = [];
    for (const t of targets) {
      const j = await api(a, 'conversations.history', { channel: t.channelId, oldest: (since / 1000).toFixed(6), limit: 100 });
      const name = t.label.split('#').pop() ?? t.channelId;
      for (const m of j.messages as any[]) if (!m.subtype && m.text) out.push(await normalize(a, m, t.channelId, name));
      await new Promise(r => setTimeout(r, 350));
    }
    return out;
  },
  async send(a, _w, channelId, text, userId) {
    let channel = channelId;
    if (userId) channel = (await api(a, 'conversations.open', { users: userId }, true)).channel.id;
    await api(a, 'chat.postMessage', { channel, text }, true);
  },
};
