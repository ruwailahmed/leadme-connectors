import type { Account, Adapter, Channel, NormalizedMessage, Target, Workspace } from '../types.ts';

const SLACK_WS: (Workspace & { channels: Channel[] })[] = [
  { id: 'T-GTMCAFE', name: 'GTMCafe', members: 3100, icon: '☕', channels: [
    { id: 'C-general', name: 'general', members: 3100 }, { id: 'C-jobs', name: 'jobs-and-opportunities', members: 2400 },
    { id: 'C-outbound', name: 'outbound-tactics', members: 1900 }, { id: 'C-tools', name: 'tools-and-stack', members: 1700 },
    { id: 'D-dana', name: 'DM: Dana Whitfield', kind: 'im' }, { id: 'G-triage', name: 'Group DM: Jordan Reyes, Priya Nair', kind: 'mpim' }] },
  { id: 'T-UNIPILE', name: 'Unipile community', members: 2000, icon: '🔌', channels: [
    { id: 'C-general', name: 'general', members: 2000 }, { id: 'C-linkedin', name: 'linkedin-api', members: 900 }, { id: 'C-help', name: 'help', members: 1200 }] },
  { id: 'T-CLAY', name: 'Clay', members: 35000, icon: '🧱', channels: [
    { id: 'C-general', name: 'general', members: 35000 }, { id: 'C-copy', name: 'copywriting-feedback', members: 8100 },
    { id: 'C-jobs', name: 'jobs-and-opportunities', members: 12000 }, { id: 'C-enrich', name: 'enrichment-help', members: 15000 }] },
  { id: 'T-TTG', name: 'TTG Services', members: 410, icon: '🛠️', channels: [{ id: 'C-general', name: 'general', members: 410 }, { id: 'C-market', name: 'marketplace', members: 380 }] },
  { id: 'T-EXA', name: 'Websets Community by Exa', members: 1250, icon: '🔎', channels: [{ id: 'C-general', name: 'general', members: 1250 }, { id: 'C-showcase', name: 'showcase', members: 900 }] },
];
const DISCORD_WS: (Workspace & { channels: Channel[] })[] = [
  { id: 'G-GROWTH', name: 'Growth Operators', members: 9800, icon: '📈', channels: [
    { id: 'D-general', name: 'general', members: 9800 }, { id: 'D-leads', name: 'lead-gen', members: 6100 }, { id: 'D-market', name: 'marketplace', members: 5200 }] },
  { id: 'G-COLD', name: 'Cold Email Club', members: 4300, icon: '❄️', channels: [
    { id: 'D-general', name: 'general', members: 4300 }, { id: 'D-infra', name: 'infrastructure', members: 2900 }, { id: 'D-deliv', name: 'deliverability', members: 3100 }] },
  { id: 'G-AIB', name: 'AI Builders', members: 22000, icon: '🤖', channels: [
    { id: 'D-general', name: 'general', members: 22000 }, { id: 'D-scrape', name: 'scraping', members: 7400 }, { id: 'D-hire', name: 'hire-a-builder', members: 6000 }] },
];

const NAMES = ['Maya Chen', 'Jordan Reyes', 'Sam Okafor', 'Priya Nair', 'Luca Ferri', 'Dana Whitfield', 'Tomás Ibarra', 'Aisha Rahman', 'Kyle Brandt', 'Noor Haddad', 'Elena Petrova', 'Marcus Lee'];

const HITS = [
  'Anyone have LinkedIn accounts for rent? Need US ID verified ones for outbound, paying monthly.',
  'Looking to rent aged LinkedIn profiles, US ID verified only. DM me with your rates.',
  'Who is renting out LinkedIn accounts for outbound? We need a few US ID verified.',
  'Need cold email infrastructure for 50 domains — anyone recommend a provider?',
  'Looking for email infrastructure (inboxes + warmup) for a new agency, budget is flexible.',
  'Can anyone scrape LinkedIn Sales Navigator lists for us? Happy to pay per 1k leads.',
  'Hiring someone to build a LinkedIn scraping pipeline, who is available this week?',
];
const NEAR = [
  'Asking for LinkedIn profiles for rent in the UK, any leads?',
  'We just wrote a post about why renting LinkedIn accounts is risky.',
  'Is scraping LinkedIn even legal anymore? Genuinely curious.',
];
const NOISE = [
  'Happy Friday everyone! What are you shipping this weekend?',
  'Does anyone have a good template for a follow-up after a no-show?',
  'Reminder: office hours at 3pm ET in the voice channel.',
  'Just closed our first $10k month with a cold calling offer 🎉',
  'Clay table keeps timing out on the enrichment step, anyone else seeing it?',
  'What CRM are you all using for small agencies?',
  'Great thread, saving this. Thanks for sharing.',
  'Podcast recommendation for sales folks? Looking for something under 30 min.',
  'Has anyone tried the new Apollo sequencing update?',
  'lol that demo video was rough but the product is solid',
];

const pick = <T,>(a: T[]) => a[Math.floor(Math.random() * a.length)];
let seq = 0;

function catalogue(a: Account) { return a.platform === 'slack' ? SLACK_WS : DISCORD_WS; }

export function demoMessage(a: Account, t: Target): NormalizedMessage {
  const r = Math.random();
  const text = r < 0.22 ? pick(HITS) : r < 0.34 ? pick(NEAR) : pick(NOISE);
  const ws = catalogue(a).find(w => w.id === t.workspaceId);
  const ch = ws?.channels.find(c => c.id === t.channelId);
  const name = pick(NAMES);
  const ts = Date.now();
  const slug = (ws?.name ?? 'ws').toLowerCase().replace(/[^a-z0-9]+/g, '-');
  return {
    id: `demo-${a.id}-${++seq}-${ts}`, source: a.platform, accountId: a.id,
    workspaceId: t.workspaceId, workspace: ws?.name ?? t.workspaceId,
    channelId: t.channelId, channel: ch?.name ?? t.channelId,
    author: { id: 'U' + name.replace(/\W/g, '').slice(0, 6).toUpperCase(), name }, text, ts,
    permalink: a.platform === 'slack'
      ? `https://${slug}.slack.com/archives/${t.channelId}/p${ts}`
      : `https://discord.com/channels/${t.workspaceId}/${t.channelId}/${ts}`,
  };
}

export const demoAdapter: Adapter = {
  async workspaces(a) { return catalogue(a).map(({ channels: _c, ...w }) => w); },
  async channels(a, wid) { return catalogue(a).find(w => w.id === wid)?.channels ?? []; },
  async poll(a, targets) {
    if (a.status !== 'healthy' || !targets.length) return [];
    if (Math.random() > 0.55) return [];
    return [demoMessage(a, pick(targets))];
  },
  async history(a, workspaceId, channelId, limit) {
    const t = { accountId: a.id, workspaceId, channelId, label: '' };
    return Array.from({ length: Math.min(limit, 25) }, (_, i) => { const m = demoMessage(a, t); m.ts -= (i + 1) * 900_000; return m; });
  },
  async send() { /* demo: accepted */ },
  async check(a) { return { ok: a.status !== 'disconnected', identity: a.email }; },
};
