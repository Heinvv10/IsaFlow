// Shared helpers for the entity-onboarding browser acceptance (entity-onboarding*.ts).
// Needs: dev server on BASE against the THROWAWAY Postgres `isaflow_e2e` on localhost, the session signer (sign.ts),
// env PORT (postgres) / PGPASSWORD / JWT (the dev server's JWT_SECRET).
import { chromium, type Page, type BrowserContext, type Browser } from 'playwright';
import { execFileSync } from 'node:child_process';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';

export const WIZ = process.cwd();
// The run reads and writes relative to the repo root (evidence dir, signer): refuse to start anywhere else.
const pkgName = (() => { try { return (JSON.parse(readFileSync(`${WIZ}/package.json`, 'utf8')) as { name?: string }).name; } catch { return undefined; } })();
if (pkgName !== 'isaflow') throw new Error(`run from the IsaFlow repo root (package.json name "isaflow"); cwd is ${WIZ}`);

// Scratch directory for failure screenshots and results.json.
export const SCRATCH = process.env.ACCEPT_SCRATCH ?? '/tmp/isaflow-accept';
export const OUT = process.env.EVIDENCE_DIR ?? `${WIZ}/docs/evidence/entity-onboarding-8types`;
export const BASE = process.env.BASE ?? 'http://localhost:3200';
export const BASE_URL = new URL(BASE);
// The run signs in as synthetic users and writes: it only ever talks to a dev server on this machine.
if (!['localhost', '127.0.0.1'].includes(BASE_URL.hostname)) throw new Error(`BASE must be a localhost or 127.0.0.1 URL; got ${BASE}`);
const { PORT, PGPASSWORD, JWT } = process.env as Record<string, string>;
if (!PORT || !PGPASSWORD || !JWT) throw new Error('PORT (postgres), PGPASSWORD and JWT (the JWT_SECRET) must be set');
// Hard-coded on purpose: nothing in the environment can point this run at another host or database (seed.ts re-checks the contents).
const PGHOST = '127.0.0.1';
export const THROWAWAY_DB = 'isaflow_e2e';
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });

const psqlArgs = (extra: string[], sql: string) => ['-h', PGHOST, '-p', PORT, '-U', 'postgres', '-d', THROWAWAY_DB, ...extra, '-c', sql];
const psqlEnv = { ...process.env, PGPASSWORD, PGHOST: undefined, PGDATABASE: undefined, PGSERVICE: undefined, PGOPTIONS: undefined };
/** Machine-readable: unaligned, tuples only, " | " between columns. */
export const psql = (sql: string) => execFileSync('psql', psqlArgs(['-At', '-F', ' | '], sql), { env: psqlEnv }).toString().trim();
/** Human-readable, verbatim psql output (aligned table with header and row count), pasted into RESULTS.md. */
export const psqlPretty = (sql: string) => execFileSync('psql', psqlArgs([], sql), { env: psqlEnv }).toString().trimEnd();

const SIGNER = process.env.ACCEPT_SIGNER ?? `${WIZ}/scripts/acceptance/sign.ts`;
export const cookieFor = (id: string, email: string, aal: string) =>
  execFileSync('bun', [SIGNER, id, email, aal], { cwd: WIZ, env: { ...process.env, JWT_SECRET: JWT } }).toString();

// Test files: valid PDF header / 1x1 PNG
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
// unique bytes per file: the server refuses the same ID document on two people (company documents are not de-duplicated)
const uniq = (b: Buffer, tag: string) => Buffer.concat([b, Buffer.from(`\n${tag}-${Date.now()}-${Math.random()}\n`), Buffer.alloc(2048, 32)]); // padded: the server refuses files under 1 KB
export const pdfFile = (name: string) => ({ name, mimeType: 'application/pdf', buffer: uniq(PDF, name) });
export const pngFile = (name: string) => ({ name, mimeType: 'image/png', buffer: uniq(PNG, name) });
export const pngDataUrl = (tag: string) => `data:image/png;base64,${uniq(PNG, tag).toString('base64')}`;
export const pdfDataUrl = (tag: string) => `data:application/pdf;base64,${uniq(PDF, tag).toString('base64')}`;
/** Files the server must refuse: a valid header with under 1 KB, and text bytes (padded past 1 KB) under a document MIME type. */
export const tinyPdfDataUrl = () => `data:application/pdf;base64,${PDF.toString('base64')}`;
export const tinyPngDataUrl = () => `data:image/png;base64,${PNG.toString('base64')}`;
/** A real PDF/PNG header followed by padding, exactly `bytes` long (the upload-limit cases). */
export const sizedDataUrl = (kind: 'pdf' | 'png', bytes: number, tag: string) => {
  const head = Buffer.concat([kind === 'pdf' ? PDF : PNG, Buffer.from(`\n${tag}-${Date.now()}-${Math.random()}\n`)]);
  return `data:${kind === 'pdf' ? 'application/pdf' : 'image/png'};base64,${Buffer.concat([head, Buffer.alloc(Math.max(0, bytes - head.length), 32)]).toString('base64')}`;
};
export const textDataUrl = (mime: string) => `data:${mime};base64,${Buffer.from(`plain text, not a document ${'x'.repeat(2048)}`).toString('base64')}`;

/** SA ID number with a valid Luhn digit. */
export function saId(yymmdd: string, seq: number): string {
  const base = `${yymmdd}${String(seq).padStart(4, '0')}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) { let n = Number(base[i]); if (i % 2 === 0) sum += n; else { n *= 2; sum += n > 9 ? n - 9 : n; } }
  return base + String((10 - (sum % 10)) % 10);
}

/** A response the scenario expects to see as an error, and why. Anything else >= 400 on /api/ fails the scenario. */
export type AllowedError = { url: RegExp; status: number; reason: string };
export type Refusal = { label: string; status: number; message: string; created: string };
export type Result = {
  n: number; kind: 'onboarding' | 'server' | 'admin'; name: string; status: 'PASS' | 'FAIL'; notes: string[]; shots: string[];
  entity?: string; completeSetupStatus?: number; failed?: boolean; allow: AllowedError[];
  refusals?: Refusal[]; dbEvidence?: string[];
};
export const newResult = (n: number, kind: Result['kind'], name: string, extra: Partial<Result> = {}): Result =>
  ({ n, kind, name, status: 'FAIL', notes: [], shots: [], allow: [], ...extra });
export const allShots: string[] = [];
export type Combo = ['mobile' | 'desktop', 'light' | 'dark'];
/** The two views the 8-type evidence set requires per step: desktop 1440 dark, mobile 390 light. */
export const PAIR: Combo[] = [['desktop', 'dark'], ['mobile', 'light']];

/** Timestamped progress line in the scratch dir: if a run ever hangs, the last line says where. */
let lastProgress = Date.now();
export const trace = (line: string) => { lastProgress = Date.now(); appendFileSync(`${SCRATCH}/trace.log`, `${new Date().toISOString()} ${line}\n`); };

/** Soft assertion: recorded in the notes, marks the scenario FAIL, and lets the run carry on to collect more evidence. */
export function check(r: Result, ok: boolean, msg: string) {
  r.notes.push(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  trace(`#${r.n} ${ok ? 'ok' : 'FAIL'} ${msg.slice(0, 120)}`);
  if (!ok) r.failed = true;
}
/** `r.status` from its checks; call once, after the last response handler has had time to run. */
export const finish = (r: Result) => { r.status = r.failed ? 'FAIL' : 'PASS'; };

export async function newCtx(browser: Browser, id: string, email: string, aal: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  ctx.setDefaultTimeout(90000); // the shared box is often heavily loaded; the dev server compiles pages on first hit
  await ctx.addCookies([{ name: 'sb-access-token', value: cookieFor(id, email, aal), domain: BASE_URL.hostname, path: '/' }]);
  // default dark, but never overwrite a theme the run itself chose (the landed-dashboard shots switch it in-page)
  await ctx.addInitScript(() => { if (!localStorage.getItem('accounting-theme')) localStorage.setItem('accounting-theme', 'dark'); });
  return ctx;
}

let logTarget: Result | null = null;
const hooked = new WeakSet<Page>();
/**
 * Routes console errors and API failures into `r` (the latest caller wins). Every complete-setup response sets
 * `completeSetupStatus`. A response >= 400 under /api/ that is not in `r.allow` marks the scenario FAILED.
 */
export function attachLogs(page: Page, r: Result) {
  logTarget = r;
  if (hooked.has(page)) return;
  hooked.add(page);
  page.on('console', m => { if (m.type() === 'error') logTarget?.notes.push(`console.error: ${m.text().slice(0, 200)}`); });
  page.on('response', async resp => {
    const t = logTarget;
    const u = resp.url();
    if (!t || !u.includes('/api/')) return;
    const isSetup = u.includes('/api/onboarding/complete-setup') && resp.request().method() === 'POST';
    if (isSetup) t.completeSetupStatus = resp.status();
    if (resp.status() < 400) return;
    const hit = t.allow.find(a => a.url.test(u) && a.status === resp.status());
    const body = (await resp.text().catch(() => '')).slice(0, 200);
    t.notes.push(`${hit ? 'expected' : 'UNEXPECTED'} HTTP ${resp.status()} ${resp.request().method()} ${u.replace(BASE, '')} ${body}${hit ? ` (${hit.reason})` : ''}`);
    if (!hit) t.failed = true;
  });
}

export const expectVisible = async (page: Page, text: string | RegExp) => {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 8000 });
};
export const cont = (page: Page) => page.getByRole('button', { name: /^Continue/ });

/** Playwright's close() has been seen to hang when the browser dies while closing (pipe terminated); never let that stall the run. */
export async function closeWithin(target: { close(): Promise<void> }, ms = 20000): Promise<void> {
  await Promise.race([target.close().catch(() => undefined), new Promise<void>(resolve => setTimeout(resolve, ms))]);
}

/**
 * One browser per attempt, with a hard time limit and a death watch. On this shared box a Chromium has been seen to vanish
 * mid-run (a pending Playwright call then never settles), so an attempt that times out or loses its browser is retried
 * on a fresh browser: 3 attempts in all (2 retries). The failed attempts are returned in `attempts` and the caller writes
 * them into the scenario's notes as RETRY lines.
 */
export async function withBrowser<T>(label: string, launchArgs: string[], limitMs: number, run: (b: Browser) => Promise<T>): Promise<{ value: T; attempts: string[] }> {
  const attempts: string[] = [];
  for (let i = 1; ; i++) {
    const b = await chromium.launch({ args: launchArgs });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let idle: ReturnType<typeof setInterval> | undefined;
    const lost = new Promise<never>((_, reject) => {
      b.on('disconnected', () => reject(new Error('browser process died')));
      timer = setTimeout(() => reject(new Error(`no result within ${limitMs / 1000}s`)), limitMs);
      // the browser can vanish without 'disconnected' ever firing (observed under Bun): no check or screenshot for 5 minutes = hung
      lastProgress = Date.now();
      idle = setInterval(() => { if (Date.now() - lastProgress > 300000) reject(new Error('no progress for 300s (browser gone?)')); }, 10000);
    });
    try {
      const value = await Promise.race([run(b), lost]);
      return { value, attempts };
    } catch (e) {
      attempts.push(`${label}: attempt ${i} failed (${(e as Error).message.split('\n')[0]})`);
      if (i >= 3) throw e;
    } finally {
      clearTimeout(timer);
      clearInterval(idle);
      await closeWithin(b);
    }
  }
}

export { chromium };
