/**
 * Budget workspace performance (budgets P2 spec §13). REPORT-ONLY: it prints the numbers next to the targets and
 * never fails on one (CI is red under box load). Not part of the golden gate.
 *
 *   Initial render ≤ 500 ms scripting · commit one cell → paint p95 ≤ 16 ms · paste 250×12 ≤ 150 ms ·
 *   save of 3 750 cells ≤ 1.5 s server time.  Plus: does `content-visibility: auto` on a band's <tbody> apply?
 *
 * Needs a session (Api.login: the golden session file, else E2E_ADMIN_EMAIL/_PASSWORD) on a company whose budget
 * year (PERF_FISCAL_YEAR, default the year holding today) has a version, ≥ 250 editable lines and 15 months; it
 * skips with the reason otherwise. It writes one scratch version `PERF-<runId>` (a non-primary scenario copy of the
 * year's primary, +0%) and deletes it in a finally and in afterAll; stale `PERF-` versions are swept first.
 *   BASE_URL=http://localhost:3200 playwright test tests/e2e/budget-workspace-perf.spec.ts --config playwright-standalone.config.ts
 * Numbers: stdout, the report attachment, and PERF_OUT=<file.json> when set. Under `next dev` React runs its
 * development build, so scripting is several times a production build's; say which one was measured.
 */
import { writeFileSync } from 'fs';
import { loadavg } from 'os';
import { test, expect, type CDPSession, type Page } from '@playwright/test';
import { Api, ApiError } from './golden-paths/_api';
import { LINES, WORKSPACE, pickYearAndVersion, rowCell, waitForGrid, type BudgetYearsAnswer } from './helpers/budgetWorkspace';

const MIN_LINES = 250;
const MONTHS = 15;
const COMMIT_SAMPLES = 40;

interface Version { id: string; name: string; status: string; isPrimary: boolean }
interface GridRead { version: Version | null; year: { monthKeys: string[] }; accounts: { isActive: boolean; isHeader: boolean }[] }
type Metrics = Record<string, number>;

const scratch = new Set<string>();

async function deletePerfVersion(api: Api, id: string): Promise<void> {
  const res = await api.getRaw(`/api/accounting/budget-versions/${id}`);
  const v = res.json?.data as Version | undefined;
  if (res.status === 200 && v && !v.isPrimary && v.name.startsWith('PERF-') && v.status !== 'locked') {
    try { await api.del(`/api/accounting/budget-versions/${id}`); } catch (err) { if (!(err instanceof ApiError && err.status === 404)) throw err; }
  } else if (res.status !== 404) {
    throw new Error(`refusing to delete version ${id} (${res.status}, ${JSON.stringify(v ?? null).slice(0, 120)})`);
  }
  scratch.delete(id);
}

async function metrics(cdp: CDPSession): Promise<Metrics> {
  const { metrics: list } = await cdp.send('Performance.getMetrics');
  return Object.fromEntries(list.map((m) => [m.name, m.value]));
}

/** Scripting / style / layout ms between two CDP metric snapshots. */
const delta = (a: Metrics, b: Metrics) => ({
  scriptMs: Math.round(((b.ScriptDuration ?? 0) - (a.ScriptDuration ?? 0)) * 1000),
  styleMs: Math.round(((b.RecalcStyleDuration ?? 0) - (a.RecalcStyleDuration ?? 0)) * 1000),
  layoutMs: Math.round(((b.LayoutDuration ?? 0) - (a.LayoutDuration ?? 0)) * 1000),
  taskMs: Math.round(((b.TaskDuration ?? 0) - (a.TaskDuration ?? 0)) * 1000),
});

/** Resolves after the next frame has painted (rAF runs before paint; a message posted from it lands after). */
const afterPaint = (page: Page) => page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => {
  const ch = new MessageChannel(); ch.port1.onmessage = () => resolve(); ch.port2.postMessage(0);
})));

/** Switches the version select to `id` and measures until the grid has painted. */
async function measureSwitch(page: Page, cdp: CDPSession, id: string) {
  const m0 = await metrics(cdp);
  const t0 = Date.now();
  await page.getByTestId('version-select').selectOption(id);
  await waitForGrid(page, id);
  await afterPaint(page);
  return { wallMs: Date.now() - t0, ...delta(m0, await metrics(cdp)) };
}

/**
 * Pastes a rows × cols TSV on the first line's first month. workMs: dispatch until the task (and its microtasks: the
 * React render) is done; paintMs: until after the next paint, so it includes the wait for the frame.
 */
async function measurePaste(page: Page, rows: number, cols: number, base: number) {
  await rowCell(page.locator(LINES).first(), 0).click();
  // Whole rand + 37 cents: never a seeded or a copied amount, so every pasted cell is dirty.
  const tsv = Array.from({ length: rows }, (_, r) => Array.from({ length: cols }, (_, c) => `${base + r * 10 + c}.37`).join('\t')).join('\r\n');
  const t = await page.evaluate((text) => new Promise<{ took: boolean; workMs: number; paintMs: number }>((resolve) => {
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
    const t0 = performance.now();
    document.activeElement?.dispatchEvent(ev);
    const work = new MessageChannel();
    work.port1.onmessage = () => {
      const workMs = performance.now() - t0;
      requestAnimationFrame(() => {
        const paint = new MessageChannel();
        paint.port1.onmessage = () => resolve({ took: ev.defaultPrevented, workMs, paintMs: performance.now() - t0 });
        paint.port2.postMessage(0);
      });
    };
    work.port2.postMessage(0);
  }), tsv);
  return { rows, cols, workMs: Math.round(t.workMs), paintMs: Math.round(t.paintMs), took: t.took, dirty: await page.locator('td[data-dirty="true"]').count() };
}

const pct = (xs: number[], p: number): number => {
  const s = [...xs].sort((a, b) => a - b);
  return Math.round((s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN) * 10) / 10;
};

test.afterAll(async ({}, testInfo) => {
  if (scratch.size === 0) return;
  const api = await Api.login(testInfo.project.use.baseURL!);
  try { for (const id of [...scratch]) await deletePerfVersion(api, id); } finally { await api.dispose(); }
});

test('budget workspace perf: 250 accounts × 15 months (report-only)', async ({ browser, baseURL }) => {
  test.setTimeout(600_000);
  const api = await Api.login(baseURL!);
  const report: Record<string, unknown> = { baseURL, loadavg: loadavg().map((l) => Math.round(l * 10) / 10) };
  try {
    const years = await api.get<BudgetYearsAnswer>('/api/accounting/budgets');
    const fiscalYear = Number(process.env.PERF_FISCAL_YEAR ?? years.fiscalYear);
    const grid = await api.get<GridRead>(`/api/accounting/budget-grid?fiscal_year=${fiscalYear}`);
    const lines = grid.accounts.filter((a) => a.isActive && !a.isHeader).length;
    const months = grid.year.monthKeys.length;
    test.skip(!grid.version || lines < MIN_LINES || months < MONTHS,
      `needs a ${fiscalYear} version with ≥ ${MIN_LINES} lines × ${MONTHS} months; found ${grid.version ? 'a version' : 'no version'}, ${lines} lines × ${months} months`);
    const primaryId = grid.version!.id;
    Object.assign(report, { fiscalYear, lines, months });

    const { items } = await api.get<{ items: Version[] }>('/api/accounting/budget-versions');
    for (const v of items.filter((x) => x.name.startsWith('PERF-') && !x.isPrimary)) await deletePerfVersion(api, v.id);
    const seeded = await api.post<{ versionId: string; cells: number }>('/api/accounting/budget-grid/seed', {
      fiscalYear, name: `PERF-${Date.now().toString(36)}`, kind: 'scenario', makePrimary: false, roundingUnit: 1,
      source: { type: 'version', versionId: primaryId, upliftPct: 0 },
    });
    scratch.add(seeded.versionId);
    report.scratchCells = seeded.cells;

    const context = await browser.newContext({ storageState: await api.ctx.storageState(), viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    // The page may write only the scratch version: anything else is aborted and fails the run. (Under `next dev` a
    // Fast Refresh re-runs the workspace's year effect, which reopens the year's PRIMARY mid-run.)
    const blocked: string[] = [];
    await page.route(/\/api\/accounting\/budget/, (route) => {
      const req = route.request();
      if (req.method() === 'GET') return route.continue();
      const body = (req.postDataJSON() ?? {}) as { versionId?: string };
      if (req.url().endsWith('/api/accounting/budget-grid/save') && body.versionId === seeded.versionId) return route.continue();
      blocked.push(`${req.method()} ${new URL(req.url()).pathname} version ${body.versionId ?? '-'}`);
      return route.abort('blockedbyclient');
    });
    try {
      await page.addInitScript(() => window.localStorage.setItem('accounting-theme', 'light'));
      const cdp = await context.newCDPSession(page);
      await cdp.send('Performance.enable');
      // 1. Page load to the primary's grid, then the grid alone: a version switch renders every row from scratch.
      await page.goto(WORKSPACE, { waitUntil: 'domcontentloaded', timeout: 240_000 });
      await pickYearAndVersion(page, { fiscalYear, versionId: primaryId, timeout: 240_000 });
      await afterPaint(page);
      const load = await metrics(cdp);
      report.pageLoadToGrid = { scriptMs: Math.round((load.ScriptDuration ?? 0) * 1000), styleMs: Math.round((load.RecalcStyleDuration ?? 0) * 1000), layoutMs: Math.round((load.LayoutDuration ?? 0) * 1000) };
      report.cellsInDom = await page.locator('table[role="grid"] td[data-pos]').count();
      const first = await measureSwitch(page, cdp, seeded.versionId);
      await measureSwitch(page, cdp, primaryId);
      report.initialRender = { first, again: await measureSwitch(page, cdp, seeded.versionId), targetScriptMs: 500 };

      // 2. content-visibility: what the grid sets, then whether `auto` on a <tbody> takes effect at all.
      const lastRow = page.locator('table[role="grid"] tbody').last().locator('tr').last();
      const asShipped = await page.locator('table[role="grid"] tbody').first().evaluate((el) => getComputedStyle(el).contentVisibility);
      const style = await page.addStyleTag({ content: 'table[role="grid"] > tbody { content-visibility: auto; contain-intrinsic-size: auto 400px; }' });
      await measureSwitch(page, cdp, primaryId);
      const withCv = await measureSwitch(page, cdp, seeded.versionId);
      // checkVisibility({contentVisibilityAuto}) is false for an element whose rendering `auto` skips; the row is below the fold.
      const offscreen = await lastRow.evaluate((el) => el.getBoundingClientRect().top > window.innerHeight);
      const offscreenSkipped = await lastRow.evaluate((el) => !el.checkVisibility({ contentVisibilityAuto: true }));
      const computed = await page.locator('table[role="grid"] tbody').last().evaluate((el) => getComputedStyle(el).contentVisibility);
      await style.evaluate((el) => el.parentNode?.removeChild(el));
      report.contentVisibility = { asShipped, injected: computed, lastRowOffscreen: offscreen, lastRowSkipped: offscreenSkipped, applies: offscreen && offscreenSkipped, renderWithInjected: withCv };

      // 3. Commit one cell (type + Enter) to paint, COMMIT_SAMPLES times down the first month.
      // workMs: Enter's task and its microtasks (the commit and React's render); paintMs: until after the next paint.
      await page.evaluate(() => {
        const w = window as unknown as { __commit: { work: number; paint: number }[] };
        w.__commit = [];
        document.addEventListener('keydown', (e) => {
          if (e.key !== 'Enter') return;
          const t0 = performance.now();
          const work = new MessageChannel();
          work.port1.onmessage = () => {
            const done = performance.now() - t0;
            requestAnimationFrame(() => {
              const paint = new MessageChannel();
              paint.port1.onmessage = () => w.__commit.push({ work: done, paint: performance.now() - t0 });
              paint.port2.postMessage(0);
            });
          };
          work.port2.postMessage(0);
        }, true);
      });
      await rowCell(page.locator(LINES).first(), 0).click();
      for (let i = 0; i < COMMIT_SAMPLES; i += 1) {
        await page.keyboard.type(String(7000 + i));
        await page.keyboard.press('Enter');
        await expect.poll(() => page.evaluate(() => (window as unknown as { __commit: unknown[] }).__commit.length)).toBe(i + 1);
      }
      const samples = await page.evaluate(() => (window as unknown as { __commit: { work: number; paint: number }[] }).__commit);
      const work = samples.map((x) => x.work);
      const paint = samples.map((x) => x.paint);
      report.commitOneCell = {
        samples: samples.length, workP50: pct(work, 50), workP95: pct(work, 95), workMax: pct(work, 100),
        paintP50: pct(paint, 50), paintP95: pct(paint, 95), paintMax: pct(paint, 100), targetP95Ms: 16,
      };

      // 4. Paste 250×12, then 250×15 (every cell dirty), then save the 3 750 cells.
      report.paste250x12 = { ...(await measurePaste(page, MIN_LINES, 12, 10_000)), targetMs: 150 };
      report.paste250x15 = await measurePaste(page, MIN_LINES, MONTHS, 20_000);
      await expect(page.locator('td[data-dirty="true"]'), 'every cell dirty before the save').toHaveCount(MIN_LINES * MONTHS);
      await expect(page.getByTestId('version-select'), 'still on the scratch version').toHaveValue(seeded.versionId);
      const saved = page.waitForResponse((r) => r.url().endsWith('/api/accounting/budget-grid/save'), { timeout: 120_000 });
      const t0 = Date.now();
      await page.keyboard.press('Control+s');
      const res = await saved;
      await expect(page.getByTestId('save-bar-status')).toContainText('Saved', { timeout: 120_000 });
      const timing = res.request().timing();
      const body = (await res.json()) as { data?: { saved?: number } };
      report.save = {
        status: res.status(), cellsSent: (res.request().postDataJSON() as { cells: unknown[] }).cells.length, saved: body.data?.saved,
        serverMs: Math.round(timing.responseStart - timing.requestStart), untilSavedShownMs: Date.now() - t0, targetServerMs: 1500,
      };
      expect(blocked, 'no budget write outside the scratch version').toEqual([]);
    } finally {
      await context.close();
    }
  } finally {
    for (const id of [...scratch]) await deletePerfVersion(api, id).catch((err: Error) => test.info().annotations.push({ type: 'cleanup', description: err.message }));
    await api.dispose();
    const json = JSON.stringify(report, null, 2);
    await test.info().attach('budget-workspace-perf.json', { body: json, contentType: 'application/json' });
    if (process.env.PERF_OUT) writeFileSync(process.env.PERF_OUT, json);
    process.stdout.write(`budget-workspace-perf ${json}\n`);
  }
});
