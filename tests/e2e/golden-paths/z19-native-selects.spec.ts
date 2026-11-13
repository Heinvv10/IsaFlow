// golden:dev-only
/**
 * Golden path (z19): no native selects on the screens that had them (master plan wave 5, UXN).
 *
 * READ-ONLY, Demo company, dev only. Nothing is written.
 *  - P&L filters, company settings (Details tab), the leave list and an employee profile have 0 native <select>
 *    (the journal-entry form: its per-line Account selects too).
 *  - With two mocked cost centres and components the P&L filter lists exactly 2 options and keeps the picked one, and the
 *    employee profile's Cost centre and Component pickers list 2; with none (the hosted CI seed) they show their empty state.
 *  - Opening an invoice from a plain cell and pressing Escape returns focus to that row, not BODY.
 *  - Accounting settings (reporting currency) has 0 native selects; the invoice list is colour-contrast clean at 1280 px.
 *  - No screen scrolls sideways at 390 px; axe reports 0 critical and 0 serious, in both themes. The screens this work
 *    re-laid out (P&L, journal form, employee profile) are loaded FRESH at 390, so mount-time width logic runs at a phone
 *    width; the others are resized from 1568 (as z4 does) to keep the suite inside its job timeout.
 *  - UXN_EVIDENCE_DIR=<dir> saves a screenshot per screen, theme and width.
 */
import { expect, test, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { axeContrastFailures, seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.UXN_EVIDENCE_DIR;
/**
 * `ready`: kit comboboxes that must be on screen BEFORE the native-select count means anything. Counting zero on a page
 * that never rendered its controls would pass for the wrong reason, so each screen names the controls it replaced.
 */
const SCREENS = [
  { slug: 'pnl', path: '/accounting/reports/income-statement', ready: ['Cost Centre', 'Business Unit'], fresh390: true },
  { slug: 'company-settings', path: '/accounting/company-settings?tab=details', ready: ['Entity Type', 'Industry', 'Account Type', 'Document Type'] },
  { slug: 'leave', path: '/payroll/leave', ready: ['Filter by status', 'Filter by month'] },
  { slug: 'accounting-settings', path: '/accounting/accounting-settings', ready: ['Reporting Currency'] },
  { slug: 'journal-new', path: '/accounting/journal-entries/new', ready: ['Account, line 1', 'Account, line 2'], fresh390: true },
] as const;
/**
 * The profile's cost-centre and component pickers depend on the company's data (the hosted CI seed has no cost centres), so
 * they are proved strictly by the mocked tests below. The real-data screens test needs only the picker that always renders.
 */
const PROFILE_READY = ['Occupational level'];
interface Screen { slug: string; path: string; ready: readonly string[]; fresh390?: boolean }

test.setTimeout(240_000);

async function snap(page: Page, slug: string, theme: string, width: number): Promise<void> {
  if (EVIDENCE_DIR) await page.screenshot({ path: `${EVIDENCE_DIR}/${slug}-${theme}-${width}.png`, fullPage: true });
}

const nativeSelects = (page: Page): Promise<number> => page.evaluate(() => document.querySelectorAll('select').length);
const overflowX = (page: Page): Promise<number> => page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);

async function expectAxeClean(page: Page): Promise<void> {
  const results = await new AxeBuilder({ page }).analyze();
  const bad = results.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
  expect(bad).toEqual([]);
}

/**
 * goto, then reload (at most twice) when an employee profile answers "... with identifier X not found" for an id its own
 * list just showed. Two causes are suspected, neither is what this spec tests, and the logs say which: (1) a cold compile of
 * the profile route on a dev server, (2) on dev a peer session switching the shared reporting-qa user's active company
 * (the 404 then carries another companyId). Hosted CI gives each run its own seed, so cause (2) cannot happen there.
 * Every reload is recorded as a test annotation, so the flake rate shows in the report. A dedicated QA user for dev
 * goldens is a backlog item, not a fix made here.
 */
async function gotoScreen(page: Page, path: string): Promise<void> {
  const isProfile = /^\/payroll\/employees\/[0-9a-f-]{36}$/.test(path);
  const listed = profileListCompany.get(page);
  if (isProfile && listed === undefined) throw new Error(`gotoScreen(${path}): no company recorded for the employee list, call profilePath(page) first`);
  // Before every look at the page, not once after the loop: a company switched between attempts must fail as that, not as a not-found.
  const sameCompany = async (): Promise<void> => {
    if (!isProfile) return;
    expect(await activeCompany(page), `the employee list was read under company ${listed}; the session's company changed before the profile loaded (another session switched it)`).toBe(listed);
  };
  await page.goto(path);
  for (let attempt = 1; ; attempt++) {
    await sameCompany();
    if (attempt > 2 || (await page.getByText(/with identifier .* not found/i).count()) === 0) return;
    test.info().annotations.push({ type: 'reload-not-found', description: `${path} attempt ${attempt}` });
    await page.waitForTimeout(3_000);
    await page.reload();
  }
}

/** The company a page's API calls run under, read from the app itself (the session can be switched by another session on dev). */
const activeCompany = (page: Page): Promise<string> =>
  page.evaluate(async () => {
    const res = await fetch('/api/accounting/companies?action=user-companies', { credentials: 'include' });
    const body = await res.json() as { data?: { activeCompanyId?: string } };
    return String(body.data?.activeCompanyId ?? '');
  });

const profileListCompany = new WeakMap<Page, string>();

async function profilePath(page: Page): Promise<string> {
  await page.goto('/payroll/employees');
  const listCompany = await activeCompany(page);
  const link = page.locator('main a[href^="/payroll/employees/"]:not([href$="/new"]):not([href$="/bulk-update"])').first();
  await expect(link).toBeVisible({ timeout: 60_000 });
  const href = await link.getAttribute('href');
  expect(href).toMatch(/^\/payroll\/employees\/[0-9a-f-]{36}$/);
  profileListCompany.set(page, listCompany);
  return href!;
}

const COST_CENTRES = [
  { id: '11111111-1111-4111-8111-111111111111', code: 'GPZ19A', name: 'Golden Alpha', isActive: true },
  { id: '22222222-2222-4222-8222-222222222222', code: 'GPZ19B', name: 'Golden Beta', isActive: true },
];
const COMPONENTS = [
  { id: '33333333-3333-4333-8333-333333333333', name: 'Golden Basic', sarsSourceCode: '3601', componentType: 'earning' },
  { id: '44444444-4444-4444-8444-444444444444', name: 'Golden Bonus', sarsSourceCode: '3605', componentType: 'earning' },
];
const json = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

/** Answer the cost-centre and payroll-component lists with `centres` / `components`, whatever the company holds. */
async function mockLists(page: Page, centres: typeof COST_CENTRES, components: typeof COMPONENTS): Promise<void> {
  // The accounting list answers { items }, the payroll card's own route a bare array.
  await page.route(/\/api\/(accounting|payroll)\/cost-centres/, (route) =>
    route.fulfill(json(route.request().url().includes('/api/payroll/') ? centres : { items: centres })));
  await page.route(/\/api\/payroll\/components(\?|$)/, (route) => route.fulfill(json(components)));
}

for (const theme of THEMES) {
  test.describe(`${theme} theme`, () => {
    test.beforeEach(async ({ page }) => { await seedTheme(page, theme); });

    // Checks on a loaded screen. L2: wait for the screen's own comboboxes, THEN let it settle, then count and run axe, so a
    // resize (which re-lays the page out) is never measured half-way.
    async function check(page: Page, s: Screen, width: number): Promise<void> {
      const at = `${s.slug} at ${width}`;
      for (const name of s.ready) await expect(page.getByRole('combobox', { name, exact: true }), `${at}: kit combobox "${name}" rendered`).toBeVisible({ timeout: 30_000 });
      if (s.slug === 'journal-new') await expect(page.getByRole('heading', { name: 'Balance Summary' })).toBeVisible();
      await settle(page);
      expect(await nativeSelects(page), `${at}: native selects`).toBe(0);
      if (width === 390) expect(await overflowX(page), `${at}: sideways overflow`).toBeLessThanOrEqual(0);
      await expectAxeClean(page);
      await snap(page, s.slug, theme, width);
    }

    // M2: a screen with mount-time width logic must be LOADED at 390, not resized to it, so P&L, the journal form and the
    // employee profile (re-laid out by this work) load twice; the rest load once at 1568 and are resized (two loads per
    // screen pushed the hosted suite past its job timeout and the dev server toward its memory restart).
    test('screens at 1568 and 390px: 0 native selects, no sideways scroll at 390, axe clean at both', async ({ page }) => {
      test.setTimeout(300_000); // measured 0.5-3.5 min per theme at load 40; the golden job caps at 60 min for ~2 themes of this and every other spec
      const screens: Screen[] = [...SCREENS, { slug: 'employee-profile', path: await profilePath(page), ready: PROFILE_READY, fresh390: true }];
      for (const s of screens) {
        await page.setViewportSize({ width: 1568, height: 900 });
        await gotoScreen(page, s.path);
        await check(page, s, 1568);
        await page.setViewportSize({ width: 390, height: 900 });
        if (s.fresh390) await gotoScreen(page, s.path);
        await check(page, s, 390);
      }
    });

    // Strict, on mocked data: nothing here is allowed to pass because a list happened to be empty.
    test('with 2 cost centres and 2 components the pickers list them (P&L, employee profile)', async ({ page }) => {
      await mockLists(page, COST_CENTRES, COMPONENTS);
      await page.goto('/accounting/reports/income-statement');
      await settle(page);
      const box = page.getByRole('combobox', { name: 'Cost Centre' });
      await box.click();
      await expect(page.getByRole('option')).toHaveCount(2);
      await page.getByRole('option', { name: /Golden Beta/ }).click();
      await expect(box).toContainText('Golden Beta');
      await gotoScreen(page, await profilePath(page));
      await settle(page);
      const cc = page.getByRole('combobox', { name: 'Cost centre', exact: true });
      await expect(cc).toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(/No active cost centres/i)).toHaveCount(0);
      await cc.click();
      await expect(page.getByRole('option')).toHaveCount(2);
      await page.keyboard.press('Escape');
      const comp = page.getByRole('combobox', { name: 'Component', exact: true });
      await expect(comp).toBeVisible();
      await comp.click();
      await expect(page.getByRole('option')).toHaveCount(2);
      expect(await nativeSelects(page)).toBe(0);
    });

    test('with no cost centres or components (the hosted CI seed) the pickers show their empty state, still no native select', async ({ page }) => {
      await mockLists(page, [], []);
      await page.goto('/accounting/reports/income-statement');
      await settle(page);
      await page.getByRole('combobox', { name: 'Cost Centre' }).click();
      await expect(page.getByText('No options')).toBeVisible({ timeout: 15_000 });
      expect(await nativeSelects(page)).toBe(0);
      await gotoScreen(page, await profilePath(page));
      await settle(page);
      await expect(page.getByText(/No active cost centres/i)).toBeVisible({ timeout: 30_000 });
      await page.getByRole('combobox', { name: 'Component', exact: true }).click();
      await expect(page.getByText('No options')).toBeVisible();
      expect(await nativeSelects(page)).toBe(0);
    });

    test('the invoice list passes axe colour-contrast at 1280px (the 90+ days label)', async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.goto('/accounting/customer-invoices');
      await settle(page);
      await expect(page.locator('tbody tr').first()).toBeVisible({ timeout: 30_000 });
      expect(await axeContrastFailures(page)).toEqual([]);
    });

    test('Escape on the invoice drawer returns focus to the row that opened it', async ({ page }) => {
      await page.goto('/accounting/customer-invoices');
      await settle(page);
      const row = page.locator('tbody tr').first();
      await row.locator('td').nth(2).click();
      await expect(page.getByRole('dialog')).toBeVisible({ timeout: 30_000 });
      await page.keyboard.press('Escape');
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(row).toBeFocused();
    });
  });
}
