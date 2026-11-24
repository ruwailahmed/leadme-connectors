import { execFileSync, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

const enableDomains = async (b: Browser) => {
  await Promise.all([
    b.send('Page.enable').catch(() => null),
    b.send('Runtime.enable').catch(() => null),
    b.send('Network.enable').catch(() => null),
  ]);
};

// Dolphin / anti-detect browsers expose their own identity: start a profile, get a ws endpoint.
async function dolphinEndpoint(): Promise<string | null> {
  const api = process.env.DOLPHIN_API;
  const id = process.env.DOLPHIN_PROFILE_ID;
  if (!api || !id) return null;
  const headers: Record<string, string> = {};
  if (process.env.DOLPHIN_TOKEN) headers.Authorization = `Bearer ${process.env.DOLPHIN_TOKEN}`;
  const r = await fetch(`${api.replace(/\/$/, '')}/v1.0/browser_profiles/${encodeURIComponent(id)}/start?automation=1`, { headers, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) throw new Error(`dolphin_start_${r.status}`);
  const j = await r.json() as any;
  const ws = j?.automation?.wsEndpoint ?? j?.wsEndpoint;
  if (ws) return ws;
  const port = j?.automation?.port ?? j?.port;
  return port ? `ws://127.0.0.1:${port}/devtools/browser` : null;
}

// A crash can leave a browser holding the profile lock; clear the owner before booting a new one.
// The pattern is anchored to chrome so it can never match an innocent process that shares the path.
const chromePattern = (dir: string) => `([Cc]hrome|chromium).*--user-data-dir=${dir}`;
const killProfileChrome = (dir: string, signal: 'TERM' | 'KILL' = 'TERM') => {
  try { execFileSync('pkill', [`-${signal}`, '-f', chromePattern(dir)], { stdio: 'ignore' }); } catch { /* nothing running */ }
};
const chromeRunning = (dir: string) => {
  try { return execFileSync('pgrep', ['-f', chromePattern(dir)], { encoding: 'utf8' }).trim().length > 0; } catch { return false; }
};
const releaseProfile = async (dir: string) => {
  if (!chromeRunning(dir)) return;
  killProfileChrome(dir, 'TERM');
  for (let i = 0; i < 10; i++) { await sleep(200); if (!chromeRunning(dir)) return; }
  killProfileChrome(dir, 'KILL');
  for (let i = 0; i < 10; i++) { await sleep(200); if (!chromeRunning(dir)) return; }
};

const CANDIDATES = [
  process.env.CHROME_BIN, process.env.CHROME_PATH,
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
  '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  '/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/nix/var/nix/profiles/default/bin/chromium', '/snap/bin/chromium',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  process.env.LOCALAPPDATA ? `${process.env.LOCALAPPDATA}\\Google\\Chrome\\Application\\chrome.exe` : '',
].filter(Boolean) as string[];

export const findChrome = () => CANDIDATES.find(p => existsSync(p)) ??
  (process.env.PATH ?? '').split(':').flatMap(dir => ['chromium', 'google-chrome', 'chromium-browser', 'chrome'].map(n => join(dir, n))).find(p => existsSync(p));

export interface LaunchOptions {
  profileDir: string; headless?: boolean; proxy?: string; lang?: string; timezone?: string;
  width?: number; height?: number; userAgent?: string; locale?: string; colorScheme?: 'light' | 'dark';
}

const applyEmulation = async (b: Browser, o: LaunchOptions) => {
  if (o.userAgent) await b.send('Emulation.setUserAgentOverride', { userAgent: o.userAgent, acceptLanguage: o.locale ?? 'en-US' }).catch(() => null);
  if (o.locale) await b.send('Emulation.setLocaleOverride', { locale: o.locale }).catch(() => null);
  if (o.timezone) await b.send('Emulation.setTimezoneOverride', { timezoneId: o.timezone }).catch(() => null);
  if (o.width && o.height) await b.send('Emulation.setDeviceMetricsOverride', { width: o.width, height: o.height, deviceScaleFactor: 1, mobile: false }).catch(() => null);
  if (o.colorScheme) await b.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: o.colorScheme }] }).catch(() => null);
};

// Minimal CDP client: no Playwright, no Puppeteer, no browser download. Each account gets its own
// on-disk profile, so cookies/localStorage/device identity survive between reconnects (the same
// thing a fingerprint browser sells, minus the fingerprint marketplace).
export class Browser {
  private ws: WebSocket;
  private seq = 0;
  private waiting = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();
  proc?: ChildProcess;
  profileDir?: string;
  sessionId?: string;

  private constructor(ws: WebSocket, proc?: ChildProcess) {
    this.ws = ws; this.proc = proc;
    ws.addEventListener('message', ev => {
      let msg: any; try { msg = JSON.parse(String((ev as MessageEvent).data)); } catch { return; }
      if (!msg.id) return;
      const w = this.waiting.get(msg.id); if (!w) return;
      this.waiting.delete(msg.id);
      msg.error ? w.reject(new Error(`${msg.error.message ?? 'cdp_error'}${msg.error.data ? `: ${msg.error.data}` : ''}`)) : w.resolve(msg.result);
    });
  }

  static async connect(wsUrl: string, proc?: ChildProcess, page = true): Promise<Browser> {
    const ws = new WebSocket(wsUrl);
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('cdp_connect_timeout')), 20_000);
      ws.addEventListener('open', () => { clearTimeout(t); resolve(); }, { once: true });
      ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('cdp_connect_failed')); }, { once: true });
    });
    const b = new Browser(ws, proc);
    if (page) await enableDomains(b);
    return b;
  }

  // Attach to a browser-level endpoint (Dolphin/Anti-detect Local API hands out exactly this):
  // pick or create a page, then talk to it through a flattened session.
  static async attachBrowserWs(wsUrl: string): Promise<Browser> {
    const b = await Browser.connect(wsUrl, undefined, false);
    const { targetInfos } = await b.send('Target.getTargets', {}, null);
    const page = (targetInfos ?? []).find((t: any) => t.type === 'page' && !String(t.url).startsWith('devtools://'));
    const targetId = page?.targetId ?? (await b.send('Target.createTarget', { url: 'about:blank' }, null)).targetId;
    const { sessionId } = await b.send('Target.attachToTarget', { targetId, flatten: true }, null);
    b.sessionId = sessionId;
    await enableDomains(b);
    return b;
  }

  // Attach to an already-running debug endpoint (e.g. a fingerprint browser you supply).
  static async attach(httpBase: string): Promise<Browser> {
    const target = await (await fetch(`${httpBase.replace(/\/$/, '')}/json/new?about:blank`, { method: 'PUT' })).json() as any;
    return Browser.connect(target.webSocketDebuggerUrl);
  }

  static async launch(o: LaunchOptions): Promise<Browser> {
    if (process.env.BROWSER_WS) return Browser.attachBrowserWs(process.env.BROWSER_WS);
    if (process.env.BROWSER_URL) return Browser.attach(process.env.BROWSER_URL);
    const dolphin = await dolphinEndpoint();
    if (dolphin) return Browser.attachBrowserWs(dolphin);
    const bin = findChrome();
    if (!bin) throw new Error('chrome_not_found: set CHROME_BIN (or BROWSER_URL for a remote/fingerprint browser)');
    mkdirSync(o.profileDir, { recursive: true });
    await releaseProfile(o.profileDir);
    try { rmSync(join(o.profileDir, 'DevToolsActivePort'), { force: true }); } catch { /* best effort */ }
    const args = [
      '--remote-debugging-port=0', `--user-data-dir=${o.profileDir}`,
      '--no-first-run', '--no-default-browser-check', '--no-service-autorun', '--password-store=basic',
      '--disable-background-networking', '--disable-component-update', '--disable-sync',
      '--disable-features=Translate,MediaRouter,OptimizationHints', '--disable-blink-features=AutomationControlled',
      `--window-size=${o.width ?? 1280},${o.height ?? 900}`, `--lang=${o.lang ?? 'en-US'}`,
    ];
    if (o.headless !== false) args.unshift('--headless=new');
    if (o.proxy) args.push(`--proxy-server=${o.proxy}`);
    if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
    args.push('about:blank');
    const portFile = join(o.profileDir, 'DevToolsActivePort');
    const clearLocks = () => {
      for (const f of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'DevToolsActivePort']) {
        try { rmSync(join(o.profileDir, f), { force: true }); } catch { /* best effort */ }
      }
    };
    let proc!: ChildProcess;
    let port = '';
    // Two attempts: a leftover browser (common on Windows, where we cannot pgrep it away) holds the
    // profile lock; clearing the singleton files and retrying recovers it.
    for (let attempt = 0; attempt < 2 && !port; attempt++) {
      await releaseProfile(o.profileDir);
      clearLocks();
      proc = spawn(bin, args, { stdio: 'ignore', detached: true });
      proc.on('error', () => { /* surfaced by the timeout below */ });
      for (let i = 0; i < 120; i++) {
        if (existsSync(portFile)) { port = readFileSync(portFile, 'utf8').split('\n')[0].trim(); if (port) break; }
        if (proc.exitCode !== null) break;
        await sleep(100);
      }
      if (!port && proc.exitCode === null) {
        try { process.kill(-proc.pid!, 'SIGKILL'); } catch { try { proc.kill('SIGKILL'); } catch { /* gone */ } }
        await sleep(300);
      }
    }
    if (!port) { await releaseProfile(o.profileDir); throw new Error(`chrome_did_not_start${proc?.exitCode != null ? `_${proc.exitCode}` : ''}`); }

    const httpBase = `http://127.0.0.1:${port}`;
    let wsUrl = '';
    for (let i = 0; i < 50 && !wsUrl; i++) {
      try {
        const list = await (await fetch(`${httpBase}/json/list`)).json() as any[];
        const page = list.find(t => t.type === 'page' && !t.url.startsWith('devtools://')) ?? list.find(t => t.type === 'page');
        if (page?.webSocketDebuggerUrl) wsUrl = page.webSocketDebuggerUrl;
      } catch { /* still booting */ }
      if (!wsUrl) await sleep(100);
    }
    if (!wsUrl) { await releaseProfile(o.profileDir); throw new Error('chrome_debug_endpoint_missing'); }

    const b = await Browser.connect(wsUrl, proc);
    b.profileDir = o.profileDir;
    if (o.timezone || o.userAgent || o.locale || o.colorScheme || (o.width && o.height)) await applyEmulation(b, o);
    await b.send('Page.addScriptToEvaluateOnNewDocument', {
      source: "Object.defineProperty(navigator,'webdriver',{get:()=>undefined});Object.defineProperty(navigator,'languages',{get:()=>['en-US','en']});",
    }).catch(() => null);
    return b;
  }

  send(method: string, params: Record<string, unknown> = {}, session: string | null | undefined = undefined): Promise<any> {
    const id = ++this.seq;
    const sid = session === null ? undefined : (session ?? this.sessionId);
    const frame: Record<string, unknown> = { id, method, params };
    if (sid) frame.sessionId = sid;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify(frame)); }
      catch (e: any) { this.waiting.delete(id); reject(new Error(`cdp_send_failed: ${e.message}`)); return; }
      setTimeout(() => { if (this.waiting.delete(id)) reject(new Error(`cdp_timeout ${method}`)); }, 90_000);
    });
  }

  async evaluate<T = unknown>(expression: string): Promise<T> {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true });
    if (r?.exceptionDetails) throw new Error(`page_error: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? 'eval_failed'}`);
    return r?.result?.value as T;
  }

  async goto(url: string, timeoutMs = 45_000) {
    await this.send('Page.navigate', { url });
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate<string>('document.readyState').catch(() => 'loading');
      if (ready === 'complete') return;
      await sleep(250);
    }
    throw new Error(`page_load_timeout ${url}`);
  }

  async waitFor(expression: string, timeoutMs = 20_000, interval = 300): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await this.evaluate<boolean>(`!!(${expression})`).catch(() => false)) return true;
      await sleep(interval);
    }
    return false;
  }

  text(max = 4000) { return this.evaluate<string>(`(document.body?.innerText ?? '').slice(0, ${max})`).catch(() => ''); }
  href() { return this.evaluate<string>('location.href').catch(() => ''); }

  private picker(selectors: string[]) {
    return `[${selectors.map(s => JSON.stringify(s)).join(',')}].map(s=>{try{return document.querySelector(s)}catch{return null}}).find(e=>e)`;
  }

  async visible(selectors: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(()=>{const el=${this.picker(selectors)};if(!el)return false;const r=el.getBoundingClientRect();return r.width>0&&r.height>0})()`).catch(() => false);
  }

  async fill(selectors: string[], value: string): Promise<boolean> {
    return this.evaluate<boolean>(`(()=>{const el=${this.picker(selectors)};if(!el)return false;el.focus();
      const proto=el instanceof HTMLTextAreaElement?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;
      const set=Object.getOwnPropertyDescriptor(proto,'value').set;set.call(el,${JSON.stringify(value)});
      el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}));return true})()`).catch(() => false);
  }

  async click(selectors: string[]): Promise<boolean> {
    return this.evaluate<boolean>(`(()=>{const el=${this.picker(selectors)};if(!el)return false;el.scrollIntoView({block:'center'});
      el.click();return true})()`).catch(() => false);
  }

  async pressEnter() {
    const key = { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
    await this.send('Input.dispatchKeyEvent', key).catch(() => null);
    await this.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }).catch(() => null);
  }

  async cookies(urls: string[]): Promise<{ name: string; value: string; domain: string }[]> {
    const r = await this.send('Network.getCookies', { urls }).catch(() => ({ cookies: [] }));
    return r?.cookies ?? [];
  }

  localStorageGet(key: string) { return this.evaluate<string | null>(`localStorage.getItem(${JSON.stringify(key)})`).catch(() => null); }

  async screenshot(quality?: number): Promise<Buffer | null> {
    const params = quality ? { format: 'jpeg', quality, captureBeyondViewport: false } : { format: 'png', captureBeyondViewport: false };
    const r = await this.send('Page.captureScreenshot', params).catch(() => null);
    return r?.data ? Buffer.from(r.data, 'base64') : null;
  }

  async clickAt(x: number, y: number) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await this.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...base });
    await sleep(70);
    await this.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...base });
  }

  async close() {
    try { this.ws.close(); } catch { /* already gone */ }
    if (this.profileDir) { await releaseProfile(this.profileDir); return; }
    const proc = this.proc;
    if (!proc || proc.exitCode !== null || !proc.pid) return;
    const kill = (sig: NodeJS.Signals) => { try { process.kill(-proc.pid!, sig); } catch { try { proc.kill(sig); } catch { /* gone */ } } };
    kill('SIGTERM');
    await sleep(600);
    if (proc.exitCode === null) kill('SIGKILL');
  }
}
