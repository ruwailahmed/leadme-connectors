import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { Account, Alert, Monitor, NormalizedMessage } from './types.ts';

const FILE = new URL('../data/db.json', import.meta.url).pathname;
export interface DB { accounts: Account[]; monitors: Monitor[]; alerts: Alert[]; history: NormalizedMessage[] }
export const db: DB = { accounts: [], monitors: [], alerts: [], history: [] };

if (existsSync(FILE)) { try { Object.assign(db, JSON.parse(readFileSync(FILE, 'utf8'))); } catch (e) { console.error('db load failed, starting empty', e); } }

let timer: NodeJS.Timeout | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { mkdirSync(new URL('../data', import.meta.url).pathname, { recursive: true }); writeFileSync(FILE, JSON.stringify(db)); }, 300);
}
export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
