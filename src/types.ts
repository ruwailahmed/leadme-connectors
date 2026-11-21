export type Platform = 'slack' | 'discord';
export type Health = 'healthy' | 'degraded' | 'disconnected';

export interface Account {
  id: string;
  platform: Platform;
  mode: 'demo' | 'live';
  label: string;
  email: string;
  token?: string;
  userToken?: string;
  status: Health;
  statusNote?: string;
  lastSync?: number;
  createdAt: number;
}

export interface Workspace { id: string; name: string; members: number; icon: string }
export interface Channel { id: string; name: string; topic?: string; members?: number }

export interface NormalizedMessage {
  id: string;
  source: Platform;
  accountId: string;
  workspaceId: string;
  workspace: string;
  channelId: string;
  channel: string;
  author: { id: string; name: string };
  text: string;
  ts: number;
  permalink: string;
}

export interface Target { accountId: string; workspaceId: string; channelId: string; label: string }

export interface Criteria {
  topic: string[];
  qualifiers: string[];
  strict: boolean;
  ignoreSellers?: boolean;
  labels?: Record<string, string>;
  summary: string;
}

export interface Monitor {
  id: string;
  name: string;
  description: string;
  criteria?: Criteria;
  status: 'draft' | 'listening' | 'paused';
  targets: Target[];
  matches: number;
  createdAt: number;
}

export type AlertStatus = 'new' | 'read' | 'contacted' | 'bad_match' | 'archived';
export interface Alert {
  id: string;
  monitorId: string;
  monitorName: string;
  message: NormalizedMessage;
  reason: string;
  status: AlertStatus;
  createdAt: number;
  replies: { text: string; ts: number }[];
}

export interface Verdict { match: boolean; reason: string }

export interface Adapter {
  workspaces(a: Account): Promise<Workspace[]>;
  channels(a: Account, workspaceId: string): Promise<Channel[]>;
  poll(a: Account, targets: Target[], since: number): Promise<NormalizedMessage[]>;
  send(a: Account, workspaceId: string, channelId: string, text: string, userId?: string): Promise<void>;
  check(a: Account): Promise<{ ok: boolean; note?: string; identity?: string }>;
}
