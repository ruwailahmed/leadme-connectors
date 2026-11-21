import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import type { Account, Alert, Monitor, NormalizedMessage } from './types.ts';

export const DATA_DIR = process.env.DATA_DIR ?? new URL('../data', import.meta.url).pathname;
const FILE = `${DATA_DIR}/db.json`;
export interface DB { accounts: Account[]; monitors: Monitor[]; alerts: Alert[]; history: NormalizedMessage[] }
export const db: DB = { accounts: [], monitors: [], alerts: [], history: [] };

if (existsSync(FILE)) { try { Object.assign(db, JSON.parse(readFileSync(FILE, 'utf8'))); } catch (e) { console.error('db load failed, starting empty', e); } }

let timer: NodeJS.Timeout | undefined;
export function save() {
  clearTimeout(timer);
  timer = setTimeout(() => { mkdirSync(DATA_DIR, { recursive: true }); writeFileSync(FILE, JSON.stringify(db)); }, 300);
}
export const uid = (p: string) => `${p}_${Math.random().toString(36).slice(2, 10)}`;
