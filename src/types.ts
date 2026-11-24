export type Platform = 'slack' | 'discord';
export type Health = 'healthy' | 'degraded' | 'disconnected';

export interface Account {
  id: string;
  platform: Platform;
  mode: 'demo' | 'live';
  tenantId?: string;
  browser?: BrowserConfig;
  label: string;
  email: string;
  token?: string;
  sessionCookie?: string;
  userToken?: string;
  refreshToken?: string;
  selfToken?: string;
  userTokenExp?: number;
  status: Health;
  statusNote?: string;
  lastSync?: number;
  createdAt: number;
}

// ---------- persistent sessions / automatic sign-in ----------
export interface Credential {
  id: string;
  accountId: string;
  platform: Platform;
  sealed: string;          // AES-256-GCM blob: username, password, totpSecret, backupCodes, proxy
  createdAt: number;
  updatedAt: number;
  lastLoginAt?: number;
  lastLoginError?: string;
}

export type CheckpointType = 'OTP' | 'TWO_FA' | 'PHONE_REGISTER' | 'IN_APP_VALIDATION' | 'CAPTCHA' | 'UNKNOWN';

export interface AuthCheckpoint {
  id: string;
  type: CheckpointType;
  prompt: string;
  requestedAt: number;
  expiresAt: number;
  attempts: number;
  liveView: boolean;
  resolvedAt?: number;
  error?: string;
}

export interface AuthLogEntry { ts: number; level: 'info' | 'warn' | 'error'; msg: string }

export type AutoAuthStatus = 'idle' | 'running' | 'waiting_human' | 'succeeded' | 'failed' | 'stopped';

export interface AutoAuth {
  accountId: string;
  enabled: boolean;
  status: AutoAuthStatus;
  attempts: number;
  nextRetryAt?: number;
  lastAttemptAt?: number;
  lastSuccessAt?: number;
  lastError?: string;
  lastReason?: string;
  checkpoint?: AuthCheckpoint;
  log: AuthLogEntry[];
  updatedAt: number;
}

export type LoginSession = Pick<Account, 'token' | 'sessionCookie' | 'selfToken' | 'userToken' | 'refreshToken' | 'userTokenExp'>;

// ---------- browser identity (Dolphin-style profile) ----------
export interface Fingerprint {
  userAgent?: string;
  timezone?: string;
  locale?: string;
  proxy?: string;
  width?: number;
  height?: number;
  colorScheme?: 'light' | 'dark';
}

export type BrowserMode = 'builtin' | 'dolphin' | 'ws';

export interface BrowserConfig {
  mode: BrowserMode;
  profileId?: string;   // profile id inside Dolphin/AdsPower/GoLogin
  ws?: string;          // explicit browser-level CDP endpoint
  fingerprint?: Fingerprint;
}

export interface Workspace { id: string; name: string; members: number; icon: string; needsBot?: boolean }
export interface Channel { id: string; name: string; topic?: string; members?: number; kind?: 'channel' | 'im' | 'mpim' }

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
  tenantId?: string;
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
  tenantId?: string;
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
  history(a: Account, workspaceId: string, channelId: string, limit: number): Promise<NormalizedMessage[]>;
  send(a: Account, workspaceId: string, channelId: string, text: string, userId?: string): Promise<void>;
  check(a: Account): Promise<{ ok: boolean; note?: string; identity?: string }>;
}
