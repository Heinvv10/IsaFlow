// Shared helpers for the entity-onboarding browser acceptance (entity-onboarding.ts, entity-onboarding-admin.ts).
// Needs: dev server on BASE against a THROWAWAY Postgres, JWT_SECRET signer (sign.ts), PGPASSWORD/PORT for psql.
import { chromium, type Page, type BrowserContext, type Browser } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync } from 'node:fs';

export const WIZ = process.cwd(); // run from the repo root
// Scratch directory for failure screenshots and results.json.
export const SCRATCH = process.env.ACCEPT_SCRATCH ?? '/tmp/isaflow-accept';
export const OUT = process.env.EVIDENCE_DIR ?? `${WIZ}/docs/evidence/entity-onboarding-8types`;
export const BASE = process.env.BASE ?? 'http://localhost:3200';
export const BASE_URL = new URL(BASE);
const { PORT, PGPASSWORD, JWT } = process.env as Record<string, string>;
const PGHOST = process.env.PGHOST ?? '127.0.0.1';
const PGDATABASE = process.env.PGDATABASE ?? 'isaflow_e2e';
if (!PORT || !PGPASSWORD || !JWT) throw new Error('PORT (postgres), PGPASSWORD and JWT (the JWT_SECRET) must be set');
mkdirSync(SCRATCH, { recursive: true });
mkdirSync(OUT, { recursive: true });

const psqlArgs = (extra: string[], sql: string) =>
  ['-h', PGHOST, '-p', PORT, '-U', 'postgres', '-d', PGDATABASE, ...extra, '-c', sql];
const psqlEnv = { ...process.env, PGPASSWORD };
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
// unique bytes per file: the server refuses the same document attached twice
const uniq = (b: Buffer, tag: string) => Buffer.concat([b, Buffer.from(`\n${tag}-${Date.now()}-${Math.random()}\n`), Buffer.alloc(2048, 32)]); // padded: the server refuses files under 1 KB
export const pdfFile = (name: string) => ({ name, mimeType: 'application/pdf', buffer: uniq(PDF, name) });
export const pngFile = (name: string) => ({ name, mimeType: 'image/png', buffer: uniq(PNG, name) });
export const pngDataUrl = (tag: string) => `data:image/png;base64,${uniq(PNG, tag).toString('base64')}`;

/** SA ID number with a valid Luhn digit. */
export function saId(yymmdd: string, seq: number): string {
  const base = `${yymmdd}${String(seq).padStart(4, '0')}08`;
  let sum = 0;
  for (let i = 0; i < 12; i++) { let n = Number(base[i]); if (i % 2 === 0) sum += n; else { n *= 2; sum += n > 9 ? n - 9 : n; } }
  return base + String((10 - (sum % 10)) % 10);
}

export type Result = {
  n: number; name: string; status: 'PASS' | 'FAIL'; notes: string[]; shots: string[];
  entity?: string; completeSetupStatus?: number; failed?: boolean;
  refusals?: Array<{ label: string; status: number; body: string }>; dbEvidence?: string[];
};
export const allShots: string[] = [];
export type Combo = ['mobile' | 'desktop', 'light' | 'dark'];
export const ALL4: Combo[] = [['mobile', 'light'], ['mobile', 'dark'], ['desktop', 'light'], ['desktop', 'dark']];
/** The two views the 8-type evidence set requires per step: desktop 1440 dark, mobile 390 light. */
export const PAIR: Combo[] = [['desktop', 'dark'], ['mobile', 'light']];

export async function shot(page: Page, r: Result, slug: string, combos: Combo[]) {
  for (const [vp, theme] of combos) {
    await page.setViewportSize(vp === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    await page.evaluate((t) => document.documentElement.classList.toggle('dark', t === 'dark'), theme);
    await page.waitForTimeout(250);
    const file = `${String(r.n).padStart(2, '0')}-${slug}-${vp}-${theme}.png`;
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: vp === 'mobile' });
    r.shots.push(file); allShots.push(file);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

/**
 * Landed dashboard: switches the app's OWN theme with its header toggle (ThemeContext state). Toggling only the html
 * class leaves context-driven parts dark, and a stored preference does not survive a dev reload (StrictMode re-runs
 * ThemeContext's save effect before its load effect has applied).
 */
export async function shotLanded(page: Page, r: Result, slug: string, combos: Combo[], name: string) {
  await page.getByRole('heading', { name }).first().waitFor({ state: 'visible', timeout: 45000 });
  const toggle = page.locator('button[title="Switch to light mode"], button[title="Switch to dark mode"]');
  for (const [vp, theme] of combos) {
    await page.setViewportSize(vp === 'mobile' ? { width: 390, height: 844 } : { width: 1440, height: 900 });
    const isDark = (await toggle.getAttribute('title')) === 'Switch to light mode';
    if (isDark !== (theme === 'dark')) await toggle.dispatchEvent('click');
    await page.waitForTimeout(1200);
    const file = `${String(r.n).padStart(2, '0')}-${slug}-${vp}-${theme}.png`;
    await page.screenshot({ path: `${OUT}/${file}`, fullPage: false });
    r.shots.push(file); allShots.push(file);
  }
  if ((await toggle.getAttribute('title')) === 'Switch to dark mode') await toggle.dispatchEvent('click');
  await page.setViewportSize({ width: 1440, height: 900 });
}

export const overflow: string[] = [];
export async function checkMobile(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: window.innerWidth }));
  overflow.push(`${m.sw <= m.iw ? 'OK  ' : 'FAIL'} ${label}: scrollWidth ${m.sw} / innerWidth ${m.iw}`);
  await page.setViewportSize({ width: 1440, height: 900 });
}

export const idFit: string[] = [];
export async function checkIdInputsFit(page: Page, label: string) {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(200);
  const rows = await page.evaluate(() => Array.from(document.querySelectorAll<HTMLInputElement>('input[placeholder="ID number"]'))
    .map(i => ({ v: i.value, sw: i.scrollWidth, cw: i.clientWidth })));
  for (const r of rows) {
    idFit.push(`${r.sw <= r.cw && r.v.length === 13 ? 'OK  ' : 'FAIL'} ${label}: ID ${r.v.length} digits, input scrollWidth ${r.sw} / clientWidth ${r.cw}`);
    if (r.sw > r.cw || r.v.length !== 13) throw new Error(`ID input clipped at 390px: ${JSON.stringify(r)}`);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

export const logoChecks: string[] = [];
export async function checkLogoAndCards(page: Page) {
  await page.evaluate(() => document.documentElement.classList.remove('dark'));
  await page.waitForTimeout(250);
  const m = await page.evaluate(() => {
    const img = document.querySelector('img[alt="ISAFlow"]') as HTMLImageElement | null;
    const body = getComputedStyle(document.querySelector('div.min-h-screen') as Element);
    const card = document.querySelector('[role=radio]') as HTMLElement;
    const label = card.querySelector('p') as HTMLElement;
    return { filter: img ? getComputedStyle(img).filter : 'no img', loaded: !!img && img.naturalWidth > 0, bg: body.backgroundColor,
      cardBg: getComputedStyle(card).backgroundColor, cardBorder: getComputedStyle(card).borderColor, labelColor: getComputedStyle(label).color,
      hintColor: getComputedStyle(card.querySelectorAll('p')[1] as HTMLElement).color };
  });
  logoChecks.push(JSON.stringify(m));
  await page.evaluate(() => document.documentElement.classList.add('dark'));
}

export async function newCtx(browser: Browser, id: string, email: string, aal: string): Promise<BrowserContext> {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: 'sb-access-token', value: cookieFor(id, email, aal), domain: BASE_URL.hostname, path: '/' }]);
  // default dark, but never overwrite a theme the run itself chose (the landed-dashboard shots reload in light)
  await ctx.addInitScript(() => { if (!localStorage.getItem('accounting-theme')) localStorage.setItem('accounting-theme', 'dark'); });
  return ctx;
}

let logTarget: Result | null = null;
const hooked = new WeakSet<Page>();
/** Routes console errors, failed API calls and every complete-setup response into `r` (the latest caller wins). */
export function attachLogs(page: Page, r: Result) {
  logTarget = r;
  if (hooked.has(page)) return;
  hooked.add(page);
  page.on('console', m => { if (m.type() === 'error') logTarget?.notes.push(`console.error: ${m.text().slice(0, 200)}`); });
  page.on('response', async resp => {
    const u = resp.url();
    const isSetup = u.includes('/api/onboarding/complete-setup');
    if (isSetup || (resp.status() >= 400 && u.includes('/api/') && !u.includes('extract'))) {
      if (isSetup && resp.request().method() === 'POST' && logTarget) logTarget.completeSetupStatus = resp.status();
      logTarget?.notes.push(`HTTP ${resp.status()} ${resp.request().method()} ${u.replace(BASE, '')} ${(await resp.text().catch(() => '')).slice(0, 300)}`);
    }
  });
}

/** Soft assertion: recorded in the notes, marks the scenario FAIL, and lets the run carry on to collect more evidence. */
export function check(r: Result, ok: boolean, msg: string) {
  r.notes.push(`${ok ? 'ok  ' : 'FAIL'} ${msg}`);
  if (!ok) r.failed = true;
}

export const expectVisible = async (page: Page, text: string | RegExp) => {
  await page.getByText(text).first().waitFor({ state: 'visible', timeout: 8000 });
};
export const cont = (page: Page) => page.getByRole('button', { name: /^Continue/ });

export { chromium };
