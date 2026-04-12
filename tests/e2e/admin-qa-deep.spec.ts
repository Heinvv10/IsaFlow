/**
 * Admin Platform QA — Deep inspection with client-side render waiting
 * Targets https://admin.isaflow.co.za (production admin)
 */
import { test, expect, Browser, BrowserContext, Page } from '@playwright/test';
import { chromium } from '@playwright/test';
import fs from 'fs';
import path from 'path';

const BASE = 'https://admin.isaflow.co.za';
const SCREENSHOT_DIR = path.join(process.cwd(), 'tests/e2e/screenshots/admin-qa');
const SESSION_PATH = path.join(process.cwd(), 'tests/e2e/.auth/admin-qa-session.json');

if (!fs.existsSync(SCREENSHOT_DIR)) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
}

let sharedBrowser: Browser;
let sharedContext: BrowserContext;
let sharedPage: Page;

const results: Array<{ page: string; status: 'PASS' | 'FAIL' | 'WARN'; note: string }> = [];
const bugs: Array<{ id: number; page: string; description: string; repro: string }> = [];
let bugId = 1;

function r(pg: string, status: 'PASS' | 'FAIL' | 'WARN', note: string) {
  results.push({ page: pg, status, note });
  console.log(`[${status}] ${pg} — ${note}`);
}

function bug(pg: string, desc: string, repro: string) {
  bugs.push({ id: bugId++, page: pg, description: desc, repro });
  console.log(`[BUG #${bugId - 1}] ${pg}: ${desc}`);
}

async function ss(name: string) {
  try {
    await sharedPage.screenshot({ path: path.join(SCREENSHOT_DIR, `${name}.png`), fullPage: true });
  } catch { /* non-fatal */ }
}

/** Navigate, wait for hydration, return body text */
async function nav(url: string, waitFor?: string): Promise<string> {
  await sharedPage.goto(`${BASE}${url}`);
  // Wait for networkidle + give React time to hydrate
  await sharedPage.waitForLoadState('networkidle');
  // If a specific text is expected, wait for it (up to 8s)
  if (waitFor) {
    try {
      await sharedPage.waitForSelector(waitFor, { timeout: 8000 });
    } catch { /* ignore timeout */ }
  } else {
    // Wait for "Loading..." to disappear or for some real content
    try {
      await sharedPage.waitForFunction(
        () => {
          const body = document.body.innerText;
          return body.length > 100 && !body.startsWith('Loading...');
        },
        { timeout: 8000 }
      );
    } catch { /* accept whatever is there */ }
  }
  return sharedPage.evaluate(() => document.body.innerText) as Promise<string>;
}

test.beforeAll(async () => {
  sharedBrowser = await chromium.launch({ headless: true });
  sharedContext = await sharedBrowser.newContext({ storageState: SESSION_PATH });
  sharedPage = await sharedContext.newPage();
});

test.afterAll(async () => {
  await sharedContext?.close();
  await sharedBrowser?.close();

  console.log('\n\n========== ADMIN QA DEEP REPORT ==========\n');
  const p = results.filter(r => r.status === 'PASS').length;
  const f = results.filter(r => r.status === 'FAIL').length;
  const w = results.filter(r => r.status === 'WARN').length;
  console.log(`Summary: ${p} PASS / ${f} FAIL / ${w} WARN\n`);
  if (bugs.length) {
    console.log('--- BUGS ---');
    bugs.forEach(b => console.log(`#${b.id} [${b.page}] ${b.description}\n  Repro: ${b.repro}`));
  }
});

// ─── DASHBOARD ───────────────────────────────────────────────────────────────
test('Dashboard', async () => {
  const body = await nav('/admin');
  await ss('D01-dashboard');

  // Stats cards expected: companies count, users, revenue, etc.
  const hasNumbers = /\d+/.test(body);
  const hasStatWords = /compan|user|revenue|subscriber|total|active/i.test(body);
  const isLoginPage = /sign in|log in|email address.*password/i.test(body);

  if (isLoginPage) {
    r('Dashboard', 'FAIL', 'Redirected to login — session not working');
    bug('Dashboard', 'Session cookie not accepted, landing on login page', 'Navigate to /admin while logged in');
    return;
  }
  if (hasNumbers && hasStatWords) {
    r('Dashboard', 'PASS', 'Stat cards rendered with numbers and labels');
  } else {
    r('Dashboard', 'WARN', `Body: ${body.substring(0, 150)}`);
  }
});

// ─── COMPANIES LIST ──────────────────────────────────────────────────────────
test('Companies List', async () => {
  await nav('/admin/companies', 'table, [role="grid"], .company-row, h1, [data-testid]');
  await ss('D02-companies');

  const body = await sharedPage.evaluate(() => document.body.innerText);

  // Look for actual company row data
  const rows = await sharedPage.locator('table tbody tr, [role="row"]').count();
  const companyLinks = await sharedPage.locator('a[href*="/admin/companies/"]').count();
  const hasTable = await sharedPage.locator('table, [role="grid"], [role="table"]').count();

  console.log(`  rows: ${rows}, links: ${companyLinks}, hasTable: ${hasTable}`);

  if (companyLinks > 0) {
    r('Companies List', 'PASS', `${companyLinks} company links found`);
  } else if (rows > 0) {
    r('Companies List', 'PASS', `${rows} table rows found (links may not use /admin/companies/ pattern)`);
  } else if (hasTable > 0) {
    r('Companies List', 'WARN', 'Table rendered but no data rows — may be empty dataset or loading issue');
    bug('Companies List', 'Companies table is empty in production', 'Navigate to /admin/companies, inspect data');
  } else {
    r('Companies List', 'WARN', `No table or rows found. Body: ${body.substring(0, 200)}`);
    bug('Companies List', 'No company list table found on /admin/companies', 'Navigate to /admin/companies');
  }

  // Check for create button
  const createBtn = await sharedPage.locator(
    'button:has-text("New"), button:has-text("Create"), button:has-text("Add"), ' +
    'a:has-text("New Company"), a:has-text("Create Company"), a:has-text("Add")'
  ).count();
  if (createBtn === 0) {
    bug('Companies List', 'No "Create" or "Add Company" button found', 'Navigate to /admin/companies');
  }
});

// ─── COMPANY DETAIL ──────────────────────────────────────────────────────────
let firstCompanyId = '';
test('Company Detail', async () => {
  await nav('/admin/companies', 'a[href*="/admin/companies/"], table tbody tr');

  const links = sharedPage.locator('a[href*="/admin/companies/"]');
  const count = await links.count();

  // Also try table rows that might be clickable
  const rows = sharedPage.locator('table tbody tr, [role="row"]:not([role="columnheader"])');
  const rowCount = await rows.count();

  if (count > 0) {
    const href = await links.first().getAttribute('href') ?? '';
    firstCompanyId = href.split('/').filter(Boolean).pop() ?? '';
    await links.first().click();
  } else if (rowCount > 0) {
    await rows.first().click();
  } else {
    // Try direct known ID approach
    const testId = 'd27bac33';  // Britech test company from memory
    await nav(`/admin/companies/${testId}`);
    await ss('D03-company-detail-direct');
    const body = await sharedPage.evaluate(() => document.body.innerText);
    if (!/404|not found|error/i.test(body) && body.length > 200) {
      r('Company Detail', 'PASS', `Direct navigation to known company ID works (Britech)`);
      firstCompanyId = testId;
    } else {
      r('Company Detail', 'WARN', 'Could not navigate to company detail — no links and direct ID failed');
    }
    return;
  }

  await sharedPage.waitForLoadState('networkidle');
  try {
    await sharedPage.waitForFunction(() => document.body.innerText.length > 200, { timeout: 8000 });
  } catch { /* accept */ }

  await ss('D03-company-detail');
  const url = sharedPage.url();
  const body = await sharedPage.evaluate(() => document.body.innerText);
  firstCompanyId = url.split('/').filter(Boolean).pop() ?? '';

  if (url.includes('/admin/companies/') && !/404|not found/i.test(body)) {
    r('Company Detail', 'PASS', `Detail page loaded: id=${firstCompanyId}`);
  } else {
    r('Company Detail', 'WARN', `URL: ${url}, body: ${body.substring(0, 100)}`);
  }
});

// ─── COMPANY ANNOUNCEMENTS ───────────────────────────────────────────────────
test('Company Announcements', async () => {
  if (!firstCompanyId) {
    r('Company Announcements', 'WARN', 'No company ID from previous test, trying Britech');
    firstCompanyId = 'd27bac33';
  }

  const body = await nav(`/admin/companies/${firstCompanyId}/announcements`);
  await ss('D04-announcements');
  const url = sharedPage.url();

  if (/404|not found/i.test(body)) {
    r('Company Announcements', 'FAIL', '404 on announcements page');
    bug('Company Announcements', 'Announcements page returns 404', `Navigate to /admin/companies/${firstCompanyId}/announcements`);
  } else if (url.includes('announcements')) {
    r('Company Announcements', 'PASS', `Page loads (${body.length} chars)`);
  } else {
    r('Company Announcements', 'WARN', `Redirected to: ${url}`);
  }
});

// ─── USERS LIST ──────────────────────────────────────────────────────────────
let firstUserId = '';
test('Users List', async () => {
  await nav('/admin/users', 'table tbody tr, a[href*="/admin/users/"]');
  await ss('D05-users');

  const links = sharedPage.locator('a[href*="/admin/users/"]');
  const rows = sharedPage.locator('table tbody tr, [role="row"]:not([role="columnheader"])');
  const linkCount = await links.count();
  const rowCount = await rows.count();
  const hasTable = await sharedPage.locator('table, [role="grid"]').count();
  const body = await sharedPage.evaluate(() => document.body.innerText);

  console.log(`  user links: ${linkCount}, rows: ${rowCount}, hasTable: ${hasTable}`);

  // Check for search
  const searchInput = sharedPage.locator(
    'input[placeholder*="search" i], input[placeholder*="filter" i], input[type="search"], input[placeholder*="user" i], input[placeholder*="email" i]'
  ).first();
  const hasSearch = await searchInput.count();

  if (hasSearch > 0) {
    await searchInput.fill('admin');
    await sharedPage.waitForTimeout(800);
    await ss('D05b-users-search');
  }

  if (linkCount > 0) {
    firstUserId = (await links.first().getAttribute('href') ?? '').split('/').filter(Boolean).pop() ?? '';
    r('Users List', 'PASS', `${linkCount} user links, search: ${hasSearch > 0 ? 'yes' : 'no'}`);
  } else if (rowCount > 1) {
    r('Users List', 'PASS', `${rowCount} rows found, search: ${hasSearch > 0 ? 'yes' : 'no'}`);
  } else if (hasTable > 0) {
    r('Users List', 'WARN', `Table present but empty. Search: ${hasSearch > 0 ? 'yes' : 'no'}. Body: ${body.substring(0, 100)}`);
  } else {
    r('Users List', 'WARN', `No table structure. Body: ${body.substring(0, 150)}`);
    bug('Users List', 'No user list table visible on /admin/users', 'Navigate to /admin/users');
  }

  if (hasSearch === 0) {
    bug('Users List', 'No search input found on users page', 'Navigate to /admin/users, look for search field');
  }
});

// ─── USER DETAIL ─────────────────────────────────────────────────────────────
test('User Detail', async () => {
  await nav('/admin/users', 'a[href*="/admin/users/"], table tbody tr');

  const links = sharedPage.locator('a[href*="/admin/users/"]');
  const rows = sharedPage.locator('table tbody tr');

  if (await links.count() > 0) {
    await links.first().click();
  } else if (await rows.count() > 0) {
    await rows.first().click();
  } else if (firstUserId) {
    await nav(`/admin/users/${firstUserId}`);
  } else {
    r('User Detail', 'WARN', 'No user links or rows found, cannot test user detail');
    return;
  }

  await sharedPage.waitForLoadState('networkidle');
  try { await sharedPage.waitForFunction(() => document.body.innerText.length > 200, { timeout: 6000 }); } catch { /* ok */ }

  await ss('D06-user-detail');
  const url = sharedPage.url();
  const body = await sharedPage.evaluate(() => document.body.innerText);

  if (url.includes('/admin/users/') && !/404|not found/i.test(body) && body.length > 200) {
    r('User Detail', 'PASS', `User detail loads: ${url.split('/').pop()}`);
  } else {
    r('User Detail', 'WARN', `URL: ${url}, body: ${body.substring(0, 100)}`);
  }
});

// ─── BILLING PLANS ───────────────────────────────────────────────────────────
test('Billing Plans', async () => {
  const body = await nav('/admin/billing/plans', 'table, .plan-card, [class*="plan"]');
  await ss('D07-billing-plans');

  // Check for plan names and prices
  const hasPlanNames = /starter|professional|enterprise|basic|free|premium/i.test(body);
  const hasPrices = /R\s*\d+|ZAR|\$\d+|\d+\s*\/\s*month/i.test(body);
  const hasTable = await sharedPage.locator('table, [role="grid"]').count();
  const hasCards = await sharedPage.locator('[class*="card"], [class*="plan"]').count();

  console.log(`  plan names: ${hasPlanNames}, prices: ${hasPrices}, table: ${hasTable}, cards: ${hasCards}`);

  if (hasPlanNames && hasPrices) {
    r('Billing Plans', 'PASS', 'Plans with names and prices visible');
  } else if (hasPlanNames || hasTable > 0 || hasCards > 0) {
    r('Billing Plans', 'WARN', `Plans visible but missing pricing. Names: ${hasPlanNames}, Prices: ${hasPrices}`);
    if (!hasPrices) bug('Billing Plans', 'Plan prices not shown in billing plans UI', 'Navigate to /admin/billing/plans');
  } else {
    r('Billing Plans', 'WARN', `No plan data visible. Body: ${body.substring(0, 150)}`);
    bug('Billing Plans', 'No plans visible on billing plans page', 'Navigate to /admin/billing/plans');
  }
});

// ─── BILLING SUBSCRIPTIONS ───────────────────────────────────────────────────
test('Billing Subscriptions', async () => {
  const body = await nav('/admin/billing/subscriptions', 'table, h1, [class*="subscription"]');
  await ss('D08-subscriptions');

  const rows = await sharedPage.locator('table tbody tr, [role="row"]').count();
  const isError = /application error|internal server error/i.test(body);

  if (isError) {
    r('Billing Subscriptions', 'FAIL', 'Error state detected');
    bug('Billing Subscriptions', 'Page shows application error', 'Navigate to /admin/billing/subscriptions');
  } else if (rows > 0 || body.length > 300) {
    r('Billing Subscriptions', 'PASS', `Page loads (${rows} rows, ${body.length} chars)`);
  } else {
    r('Billing Subscriptions', 'WARN', `Sparse content. Body: ${body.substring(0, 100)}`);
  }
});

// ─── BILLING INVOICES ────────────────────────────────────────────────────────
test('Billing Invoices', async () => {
  const body = await nav('/admin/billing/invoices', 'table, h1');
  await ss('D09-invoices');

  const rows = await sharedPage.locator('table tbody tr').count();
  const isError = /application error|internal server error/i.test(body);

  if (isError) {
    r('Billing Invoices', 'FAIL', 'Error state');
    bug('Billing Invoices', 'Application error on invoices page', 'Navigate to /admin/billing/invoices');
  } else if (rows > 0 || body.length > 300) {
    r('Billing Invoices', 'PASS', `Page loads (${rows} rows)`);
  } else {
    r('Billing Invoices', 'WARN', `Sparse content (${body.length} chars)`);
  }
});

// ─── BILLING OVERVIEW ────────────────────────────────────────────────────────
test('Billing Overview', async () => {
  const body = await nav('/admin/billing/overview', 'h1, [class*="overview"]');
  await ss('D10-billing-overview');

  const isError = /application error|internal server error|this page could not be found|404/i.test(body);
  const is404 = /not found|404/.test(body.toLowerCase());

  if (is404) {
    r('Billing Overview', 'FAIL', '404 — page does not exist');
    bug('Billing Overview', '/admin/billing/overview returns 404', 'Navigate to /admin/billing/overview');
  } else if (isError) {
    r('Billing Overview', 'FAIL', 'Application error');
    bug('Billing Overview', 'Application error on billing overview', 'Navigate to /admin/billing/overview');
  } else if (body.length > 300) {
    r('Billing Overview', 'PASS', `Page loads (${body.length} chars)`);
  } else {
    r('Billing Overview', 'WARN', `Sparse content: ${body.substring(0, 100)}`);
  }
});

// ─── FEATURE FLAGS ───────────────────────────────────────────────────────────
test('Feature Flags', async () => {
  const body = await nav('/admin/features', '[role="switch"], input[type="checkbox"], table');
  await ss('D11-features');

  const switchCount = await sharedPage.locator('[role="switch"]').count();
  const checkboxCount = await sharedPage.locator('input[type="checkbox"]').count();
  const tableRows = await sharedPage.locator('table tbody tr, [role="row"]').count();
  const isError = /application error|internal server error/i.test(body);

  console.log(`  switches: ${switchCount}, checkboxes: ${checkboxCount}, tableRows: ${tableRows}`);

  if (isError) {
    r('Features', 'FAIL', 'Application error');
    return;
  }

  if (switchCount > 0) {
    // Test toggle
    const toggle = sharedPage.locator('[role="switch"]').first();
    const before = await toggle.getAttribute('aria-checked');
    await toggle.click();
    await sharedPage.waitForTimeout(1000);
    const after = await toggle.getAttribute('aria-checked');
    await ss('D11b-features-toggled');

    if (before !== after) {
      r('Features', 'PASS', `${switchCount} toggle(s), toggle works (${before} → ${after})`);
      // Toggle back
      await toggle.click();
      await sharedPage.waitForTimeout(500);
    } else {
      r('Features', 'WARN', `Toggle click has no effect on aria-checked (stayed: ${before})`);
      bug('Features', 'Toggle aria-checked state does not change after click', 'Click first feature flag toggle on /admin/features');
    }
  } else if (checkboxCount > 0) {
    r('Features', 'PASS', `${checkboxCount} checkbox-style toggles found`);
  } else if (tableRows > 0) {
    r('Features', 'WARN', `Table with ${tableRows} rows but no toggle controls`);
    bug('Features', 'Feature flags table has rows but no toggle UI controls', 'Navigate to /admin/features');
  } else if (body.length > 200) {
    r('Features', 'WARN', `Page loads but no toggles. Body: ${body.substring(0, 150)}`);
    bug('Features', 'No feature flag toggle controls found on /admin/features', 'Navigate to /admin/features');
  } else {
    r('Features', 'WARN', `Minimal content: ${body.substring(0, 100)}`);
  }
});

// ─── ANALYTICS ───────────────────────────────────────────────────────────────
test('Analytics', async () => {
  const body = await nav('/admin/analytics', 'chart, canvas, [class*="chart"], h1');
  await ss('D12-analytics');

  const hasCharts = await sharedPage.locator('canvas, svg[class*="chart"], [class*="chart"], [class*="recharts"]').count();
  const isError = /application error|internal server error/i.test(body);

  if (isError) {
    r('Analytics', 'FAIL', 'Application error');
  } else if (hasCharts > 0) {
    r('Analytics', 'PASS', `Charts/visualization elements found (${hasCharts})`);
  } else if (body.length > 300) {
    r('Analytics', 'WARN', `Page loads but no chart elements found. Body: ${body.substring(0, 150)}`);
  } else {
    r('Analytics', 'WARN', `Minimal content: ${body.substring(0, 100)}`);
  }
});

// ─── AUDIT LOG ───────────────────────────────────────────────────────────────
test('Audit Log', async () => {
  const body = await nav('/admin/audit', 'table tbody tr, [role="row"]');
  await ss('D13-audit');

  const rows = await sharedPage.locator('table tbody tr, [role="row"]:not([role="columnheader"])').count();
  const isError = /application error|internal server error/i.test(body);

  if (isError) {
    r('Audit Log', 'FAIL', 'Application error');
  } else if (rows > 0) {
    r('Audit Log', 'PASS', `${rows} audit entries visible`);
  } else if (body.length > 300) {
    r('Audit Log', 'WARN', 'Page loads but no audit rows');
    bug('Audit Log', 'Audit log shows no entries', 'Navigate to /admin/audit');
  } else {
    r('Audit Log', 'WARN', `Minimal content: ${body.substring(0, 100)}`);
  }
});

// ─── TOOLS ───────────────────────────────────────────────────────────────────
test('Tools', async () => {
  const body = await nav('/admin/tools', 'h1, h2, [class*="tool"]');
  await ss('D14-tools');

  const isError = /application error|internal server error/i.test(body);
  const hasLinks = await sharedPage.locator('a[href*="migrations"], a[href*="sage"]').count();

  if (isError) {
    r('Tools', 'FAIL', 'Application error');
  } else if (hasLinks > 0 || body.length > 300) {
    r('Tools', 'PASS', `Tools page loads with nav links: ${hasLinks}`);
  } else {
    r('Tools', 'WARN', `Minimal content: ${body.substring(0, 100)}`);
  }
});

// ─── TOOLS MIGRATIONS ────────────────────────────────────────────────────────
test('Tools Migrations', async () => {
  const body = await nav('/admin/tools/migrations', 'table, button, h1');
  await ss('D15-migrations');

  const isError = /application error|internal server error/i.test(body);
  const hasMigrationData = /migration|pending|applied|run|version/i.test(body);
  const rows = await sharedPage.locator('table tbody tr').count();

  if (isError) {
    r('Tools Migrations', 'FAIL', 'Application error');
  } else if (hasMigrationData || rows > 0) {
    r('Tools Migrations', 'PASS', `Migration data visible (${rows} rows)`);
  } else {
    r('Tools Migrations', 'WARN', `Page loads but no migration data. Body: ${body.substring(0, 150)}`);
  }
});

// ─── TOOLS SAGE IMPORT ───────────────────────────────────────────────────────
test('Tools Sage Import', async () => {
  const body = await nav('/admin/tools/sage-import', 'form, input, button, h1');
  await ss('D16-sage-import');

  const isError = /application error|internal server error/i.test(body);
  const hasSageContent = /sage|import|company|sync/i.test(body);

  if (isError) {
    r('Tools Sage Import', 'FAIL', 'Application error');
  } else if (hasSageContent) {
    r('Tools Sage Import', 'PASS', `Sage import page loads with relevant content`);
  } else {
    r('Tools Sage Import', 'WARN', `Page loads. Body: ${body.substring(0, 150)}`);
  }
});

// ─── SETTINGS ────────────────────────────────────────────────────────────────
test('Settings', async () => {
  const body = await nav('/admin/settings', 'form, input, h1, h2');
  await ss('D17-settings');

  const isError = /application error|internal server error/i.test(body);
  const hasSettingsContent = /setting|config|maintenance|notification|email/i.test(body);
  const hasInputs = await sharedPage.locator('input, textarea, select').count();

  if (isError) {
    r('Settings', 'FAIL', 'Application error');
  } else if (hasSettingsContent || hasInputs > 0) {
    r('Settings', 'PASS', `Settings page loads (${hasInputs} input(s))`);
  } else {
    r('Settings', 'WARN', `Page loads. Body: ${body.substring(0, 150)}`);
  }
});

// ─── CREATE COMPANY ──────────────────────────────────────────────────────────
test('Create Company (CRUD)', async () => {
  await nav('/admin/companies', 'table, button, a');
  await ss('D18-create-company-before');

  const createSelectors = [
    'button:has-text("New Company")',
    'button:has-text("Create Company")',
    'button:has-text("Add Company")',
    'button:has-text("New")',
    'button:has-text("Create")',
    'a:has-text("New Company")',
    'a:has-text("Add Company")',
    '[data-testid*="create"]',
    '[data-testid*="add"]',
    'button[aria-label*="create" i]',
    'button[aria-label*="add" i]',
  ];

  let found = false;
  for (const selector of createSelectors) {
    try {
      const el = sharedPage.locator(selector).first();
      if (await el.count() > 0) {
        console.log(`  Found create button: ${selector}`);
        await el.click();
        await sharedPage.waitForTimeout(1000);
        await ss('D18b-create-company-form');

        const hasModal = await sharedPage.locator('[role="dialog"], [role="alertdialog"], .modal').count();
        const hasForm = await sharedPage.locator('form').count();
        const nameInput = sharedPage.locator('input[name="name"], input[id*="name"], input[placeholder*="company" i], input[placeholder*="name" i]').first();
        const hasNameInput = await nameInput.count();

        if (hasNameInput > 0) {
          await nameInput.fill('QA Test Company');
          await ss('D18c-create-company-filled');
          r('Create Company', 'PASS', 'Create form accessible, name field fillable');
          await sharedPage.keyboard.press('Escape');
        } else if (hasModal > 0 || hasForm > 0) {
          r('Create Company', 'WARN', 'Create dialog/form opens but no name input found');
          bug('Create Company', 'Create company dialog has no identifiable name input', 'Click create button, inspect form fields');
          await sharedPage.keyboard.press('Escape');
        } else {
          r('Create Company', 'WARN', `Create button found (${selector}) but no dialog appeared`);
        }
        found = true;
        break;
      }
    } catch { /* try next selector */ }
  }

  if (!found) {
    r('Create Company', 'WARN', 'No create/add button found on companies list');
    bug('Create Company', 'No visible Create Company button on /admin/companies', 'Check for button with text: New, Create, Add Company');
  }
});

// ─── IMPERSONATE COMPANY ─────────────────────────────────────────────────────
test('Impersonate Company', async () => {
  await nav('/admin/companies', 'table tbody tr, button');
  await ss('D19-impersonate-list');

  const impersonateSelectors = [
    'button:has-text("Impersonate")',
    'button:has-text("Login as")',
    'button:has-text("Switch to")',
    'a:has-text("Impersonate")',
    '[data-testid*="impersonate"]',
    '[aria-label*="impersonate" i]',
  ];

  let found = false;
  for (const sel of impersonateSelectors) {
    if (await sharedPage.locator(sel).count() > 0) {
      found = true;
      r('Impersonate Company', 'PASS', `Impersonate button found on list: "${sel}"`);
      break;
    }
  }

  if (!found) {
    // Try in company detail
    const links = sharedPage.locator('a[href*="/admin/companies/"]');
    const rows = sharedPage.locator('table tbody tr');
    if (await links.count() > 0) {
      await links.first().click();
    } else if (await rows.count() > 0) {
      await rows.first().click();
    } else {
      // Try direct
      await nav(`/admin/companies/${firstCompanyId || 'd27bac33'}`);
    }
    await sharedPage.waitForLoadState('networkidle');
    try { await sharedPage.waitForFunction(() => document.body.innerText.length > 200, { timeout: 5000 }); } catch {}
    await ss('D19b-impersonate-detail');

    for (const sel of impersonateSelectors) {
      if (await sharedPage.locator(sel).count() > 0) {
        found = true;
        r('Impersonate Company', 'PASS', `Impersonate button found on detail: "${sel}"`);
        break;
      }
    }

    if (!found) {
      r('Impersonate Company', 'WARN', 'No impersonate/login-as button found on list or detail page');
      bug('Impersonate Company', 'No "Impersonate" or "Login as" button visible for any company', 'Check /admin/companies list and /admin/companies/[id] detail');
    }
  }
});

// ─── EDIT COMPANY ────────────────────────────────────────────────────────────
test('Edit Company (CRUD)', async () => {
  await nav('/admin/companies', 'table tbody tr, button');

  const editSelectors = [
    'button:has-text("Edit")',
    'a:has-text("Edit")',
    '[aria-label*="edit" i]',
    '[data-testid*="edit"]',
    'button.edit-btn',
  ];

  let found = false;
  for (const sel of editSelectors) {
    const el = sharedPage.locator(sel).first();
    if (await el.count() > 0) {
      await el.click();
      await sharedPage.waitForTimeout(1000);
      await ss('D20-edit-company');
      const hasModal = await sharedPage.locator('[role="dialog"], form').count();
      if (hasModal > 0) {
        r('Edit Company', 'PASS', 'Edit dialog/form opens');
        await sharedPage.keyboard.press('Escape');
      } else {
        r('Edit Company', 'WARN', 'Edit button found but no form appeared');
      }
      found = true;
      break;
    }
  }

  if (!found) {
    // Try inside detail
    const links = sharedPage.locator('a[href*="/admin/companies/"]');
    if (await links.count() > 0) {
      await links.first().click();
      await sharedPage.waitForLoadState('networkidle');
      try { await sharedPage.waitForFunction(() => document.body.innerText.length > 200, { timeout: 5000 }); } catch {}

      for (const sel of editSelectors) {
        const el = sharedPage.locator(sel).first();
        if (await el.count() > 0) {
          r('Edit Company', 'PASS', `Edit button found on detail page: "${sel}"`);
          found = true;
          break;
        }
      }
    }

    if (!found) {
      r('Edit Company', 'WARN', 'No edit button found');
      bug('Edit Company', 'No edit button found on company list or detail', 'Check /admin/companies and /admin/companies/[id]');
    }
  }
});

// ─── BILLING OVERVIEW DEEP CHECK ─────────────────────────────────────────────
test('Billing Overview - detailed error check', async () => {
  await nav('/admin/billing/overview', 'h1, [class*="error"], [class*="overview"]');
  await ss('D21-billing-overview-deep');

  const url = sharedPage.url();
  const body = await sharedPage.evaluate(() => document.body.innerText);
  const htmlContent = await sharedPage.evaluate(() => document.documentElement.innerHTML);

  // Look for specific error indicators
  const errors: string[] = [];
  if (/this page could not be found/i.test(body)) errors.push('404 page-not-found text');
  if (/application error/i.test(body)) errors.push('Application error text');
  if (htmlContent.includes('"statusCode":404')) errors.push('statusCode 404 in JSON');
  if (htmlContent.includes('"statusCode":500')) errors.push('statusCode 500 in JSON');

  // Check what network requests failed
  console.log(`  URL: ${url}, body length: ${body.length}`);
  console.log(`  Error indicators: ${errors.join(', ') || 'none'}`);
  console.log(`  Body preview: ${body.substring(0, 200)}`);

  if (errors.length > 0) {
    r('Billing Overview (detailed)', 'FAIL', `Errors: ${errors.join(', ')}`);
  } else if (body.length > 300) {
    r('Billing Overview (detailed)', 'PASS', `Page renders without errors (${body.length} chars)`);
  } else {
    r('Billing Overview (detailed)', 'WARN', `Sparse content: ${body.substring(0, 100)}`);
  }
});
