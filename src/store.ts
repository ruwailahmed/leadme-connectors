import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { Account, Alert, Monitor, NormalizedMessage } from './types.ts';

export const DATA_DIR = process.env.DATA_DIR ?? (process.env.VERCEL ? '/tmp/leadme' : new URL('../data', import.meta.url).pathname);
const FILE = `${DATA_DIR}/db.json`;
export interface DB { accounts: Account[]; monitors: Monitor[]; alerts: Alert[]; history: NormalizedMessage[]; cursors: Record<string, number>; settings: Record<string, string> }
export const db: DB = { accounts: [], monitors: [], alerts: [], history: [], cursors: {}, settings: {} };

const REMOTE_URL = process.env.UPSTASH_REDIS_REST_URL ?? process.env.KV_REST_API_URL;
const REMOTE_TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN ?? process.env.KV_REST_API_TOKEN;
export const remote = !!(REMOTE_URL && REMOTE_TOKEN);
export const serverless = !!process.env.VERCEL;
export const CAP = { history: remote ? 300 : 1500, alerts: remote ? 300 : 2000 };

if (!serverless && existsSync(FILE)) { try { Object.assign(db, JSON.parse(readFileSync(FILE, 'utf8'))); } catch (e) { console.error('db load failed, starting empty', e); } }

const call = async (path: string, body?: string) => (await fetch(`${REMOTE_URL}${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${REMOTE_TOKEN}` }, body })).json() as Promise<any>;
export async function hydrate() {
  if (!remote) return;
  const j = await call('/get/leadme:db');
  if (j.result) Object.assign(db, { cursors: {}, settings: {}, ...JSON.parse(j.result) });
}
let dirty = false; let timer: NodeJS.Timeout | undefined;
export function save() {
  dirty = true;
  if (remote) return;
  clearTimeout(timer);
  timer = setTimeout(() => { dirty = false; try { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(db)); } catch { /* read-only fs: memory only */ } }, 300);
}
export async function flush() { if (remote && dirty) { dirty = false; await call('/set/leadme:db', JSON.stringify(db)); } }
export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
