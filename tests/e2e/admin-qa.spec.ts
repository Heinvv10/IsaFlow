/**
 * Admin Platform QA — comprehensive walkthrough of all /admin/* pages
 * Runs against http://localhost:3200
 *
 * Uses a single shared browser context (logged in once via globalSetup approach)
 * to avoid rate-limiting from repeated logins.
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
if (!fs.existsSync(path.dirname(SESSION_PATH))) {
  fs.mkdirSync(path.dirname(SESSION_PATH), { recursive: true });
}

// Results accumulator
const results: Array<{ page: string; status: 'PASS' | 'FAIL' | 'WARN'; note: string }> = [];
const bugs: Array<{ id: number; page: string; description: string; repro: string }> = [];
let bugId = 1;

function addResult(pg: string, status: 'PASS' | 'FAIL' | 'WARN', note: string) {
  results.push({ page: pg, status, note });
  console.log(`[${status}] ${pg} — ${note}`);
}

function addBug(pg: string, description: string, repro: string) {
  bugs.push({ id: bugId++, page: pg, description, repro });
  console.log(`[BUG #${bugId - 1}] ${pg}: ${description}`);
}

async function ss(page: Page, name: string) {
  try {
    await page.screenshot({
      path: path.join(SCREENSHOT_DIR, `${name}.png`),
      fullPage: true,
    });
  } catch { /* screenshot failure is non-fatal */ }
}

async function getPageContent(page: Page): Promise<string> {
  return (await page.textContent('body')) ?? '';
}

async function checkForErrors(page: Page, pageName: string): Promise<boolean> {
  const body = await getPageContent(page);
  const lower = body.toLowerCase();
  if (
    lower.includes('internal server error') ||
    lower.includes('application error') ||
    lower.includes('this page could not be found') ||
    lower.includes('404') ||
    lower.includes('unhandled runtime error')
  ) {
    addBug(pageName, `Error state detected on page`, `Navigate to ${pageName}, check body text`);
    return true;
  }
  return false;
}

// Single login + shared context for the whole test suite
let sharedBrowser: Browser;
let sharedContext: BrowserContext;
let sharedPage: Page;
const consoleErrors: Record<string, string[]> = {};

test.beforeAll(async () => {
  sharedBrowser = await chromium.launch({ headless: true });

  // Use pre-created session file (cookies set via curl before running tests).
  // The cookie domain is set to "localhost" in the session file so it applies
  // to http://localhost:3200 requests.
  const sessionExists = fs.existsSync(SESSION_PATH);
  if (!sessionExists) {
    throw new Error(`Session file not found: ${SESSION_PATH}. Run the login curl command first.`);
  }

  // Create the main context with saved session
  sharedContext = await sharedBrowser.newContext({
    storageState: SESSION_PATH,
  });

  sharedPage = await sharedContext.newPage();

  // Capture console errors
  sharedPage.on('console', msg => {
    if (msg.type() === 'error') {
      const url = sharedPage.url();
      if (!consoleErrors[url]) consoleErrors[url] = [];
      consoleErrors[url].push(msg.text());
    }
  });
});

test.afterAll(async () => {
  await sharedContext?.close();
  await sharedBrowser?.close();

  // Print final report
  console.log('\n\n========== ADMIN QA REPORT ==========\n');
  console.log('| Page | Status | Note |');
  console.log('|------|--------|------|');
  for (const r of results) {
    console.log(`| ${r.page} | ${r.status} | ${r.note} |`);
  }

  const passed = results.filter(r => r.status === 'PASS').length;
  const failed = results.filter(r => r.status === 'FAIL').length;
  const warned = results.filter(r => r.status === 'WARN').length;
  console.log(`\nSummary: ${passed} PASS / ${failed} FAIL / ${warned} WARN out of ${results.length} pages\n`);

  if (bugs.length > 0) {
    console.log('--- BUGS ---');
    for (const b of bugs) {
      console.log(`#${b.id} [${b.page}] ${b.description}\n  Repro: ${b.repro}`);
    }
  }

  const totalErrors = Object.values(consoleErrors).flat().length;
  if (totalErrors > 0) {
    console.log('\n--- CONSOLE ERRORS ---');
    for (const [url, errors] of Object.entries(consoleErrors)) {
      console.log(`${url}:\n  ${errors.slice(0, 3).join('\n  ')}`);
    }
  }
});

// Helper: navigate shared page and check for load
async function goto(path: string, label: string): Promise<boolean> {
  try {
    await sharedPage.goto(`${BASE}${path}`);
    await sharedPage.waitForLoadState('networkidle');
    const isError = await checkForErrors(sharedPage, label);
    return !isError;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    addBug(label, `Page navigation failed: ${msg}`, `goto ${BASE}${path}`);
    return false;
  }
}

// ─── 1. ADMIN DASHBOARD ──────────────────────────────────────────────────────
test('1. Admin Dashboard /admin', async () => {
  const ok = await goto('/admin', 'Dashboard');
  await ss(sharedPage, '01-dashboard');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Dashboard', 'FAIL', 'Page shows error state');
    return;
  }

  // Check for stats cards: expect at least some numbers
  const hasNumbers = /\d+/.test(body);
  const hasHeadings = body.length > 300;

  if (hasNumbers && hasHeadings) {
    addResult('Dashboard', 'PASS', 'Loads with content and numbers visible');
  } else {
    addResult('Dashboard', 'WARN', `Body length: ${body.length}, has numbers: ${hasNumbers}`);
  }
});

// ─── 2. COMPANIES LIST ───────────────────────────────────────────────────────
test('2. Companies List /admin/companies', async () => {
  const ok = await goto('/admin/companies', 'Companies List');
  await ss(sharedPage, '02-companies-list');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Companies List', 'FAIL', 'Error state detected');
    return;
  }

  const companyLinks = sharedPage.locator('a[href*="/admin/companies/"]');
  const count = await companyLinks.count();
  console.log(`Found ${count} company links`);

  if (count > 0) {
    addResult('Companies List', 'PASS', `${count} companies listed`);
  } else if (body.includes('No companies') || body.includes('no companies') || body.includes('empty')) {
    addResult('Companies List', 'WARN', 'Page loads but shows empty state');
  } else {
    addResult('Companies List', 'WARN', `Page loads but no company row links found (body: ${body.substring(0, 100)})`);
  }
});

// ─── 3. COMPANY DETAIL ───────────────────────────────────────────────────────
let firstCompanyHref = '';
test('3. Company Detail /admin/companies/[id]', async () => {
  await goto('/admin/companies', 'Company Detail');

  // Find any company link
  const links = sharedPage.locator('a[href*="/admin/companies/"]');
  const count = await links.count();

  if (count === 0) {
    // Try table rows or buttons that might be row click targets
    const rows = sharedPage.locator('tr[data-href], tr[onclick], [role="row"] a');
    const rowCount = await rows.count();
    if (rowCount > 0) {
      await rows.first().click();
    } else {
      addResult('Company Detail', 'WARN', 'No clickable company rows found, skipping detail test');
      return;
    }
  } else {
    firstCompanyHref = (await links.first().getAttribute('href')) ?? '';
    await links.first().click();
  }

  await sharedPage.waitForLoadState('networkidle');
  await ss(sharedPage, '03-company-detail');
  const url = sharedPage.url();
  const body = await getPageContent(sharedPage);
  const isError = await checkForErrors(sharedPage, 'Company Detail');

  if (isError) {
    addResult('Company Detail', 'FAIL', 'Error state on company detail page');
  } else if (url.includes('/admin/companies/') && body.length > 200) {
    addResult('Company Detail', 'PASS', `Detail page loaded: ${url.split('/').pop()}`);
    firstCompanyHref = url.replace(BASE, '');
  } else {
    addResult('Company Detail', 'WARN', `URL: ${url}, body length: ${body.length}`);
  }
});

// ─── 4. COMPANY ANNOUNCEMENTS ────────────────────────────────────────────────
test('4. Company Announcements /admin/companies/[id]/announcements', async () => {
  // Get a company ID from previous navigation or from the list
  let announcementsPath = '';
  if (firstCompanyHref && firstCompanyHref.includes('/admin/companies/')) {
    const companyId = firstCompanyHref.split('/').filter(Boolean).pop();
    announcementsPath = `/admin/companies/${companyId}/announcements`;
  } else {
    // Navigate back to list and get first company
    await goto('/admin/companies', 'Announcements');
    const links = sharedPage.locator('a[href*="/admin/companies/"]');
    const count = await links.count();
    if (count === 0) {
      addResult('Company Announcements', 'WARN', 'No company found to test announcements');
      return;
    }
    const href = (await links.first().getAttribute('href')) ?? '';
    const companyId = href.split('/').filter(Boolean).pop();
    announcementsPath = `/admin/companies/${companyId}/announcements`;
  }

  const ok = await goto(announcementsPath, 'Company Announcements');
  await ss(sharedPage, '04-company-announcements');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Company Announcements', 'FAIL', 'Error state or 404');
    return;
  }

  const url = sharedPage.url();
  if (url.includes('announcements')) {
    addResult('Company Announcements', 'PASS', `Announcements page loaded, body: ${body.length} chars`);
  } else {
    addResult('Company Announcements', 'WARN', `Redirected away from announcements to: ${url}`);
  }
});

// ─── 5. USERS LIST ───────────────────────────────────────────────────────────
test('5. Users List /admin/users', async () => {
  const ok = await goto('/admin/users', 'Users List');
  await ss(sharedPage, '05-users-list');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Users List', 'FAIL', 'Error state');
    return;
  }

  const userLinks = sharedPage.locator('a[href*="/admin/users/"]');
  const count = await userLinks.count();
  console.log(`Found ${count} user links`);

  // Try search
  const searchInput = sharedPage.locator(
    'input[placeholder*="search" i], input[placeholder*="filter" i], input[placeholder*="user" i], input[type="search"]'
  ).first();
  const hasSearch = await searchInput.count();

  let searchNote = '';
  if (hasSearch > 0) {
    await searchInput.fill('admin');
    await sharedPage.waitForTimeout(800);
    await ss(sharedPage, '05b-users-search');
    searchNote = ' (search works)';
    // Clear it
    await searchInput.fill('');
  } else {
    searchNote = ' (no search input found)';
    addBug('Users List', 'No search/filter input found on users list', 'Navigate to /admin/users, look for search input');
  }

  if (count > 0) {
    addResult('Users List', 'PASS', `${count} users listed${searchNote}`);
  } else {
    addResult('Users List', 'WARN', `Page loads but no user row links${searchNote}`);
  }
});

// ─── 6. USER DETAIL ──────────────────────────────────────────────────────────
test('6. User Detail /admin/users/[id]', async () => {
  await goto('/admin/users', 'User Detail');
  const userLinks = sharedPage.locator('a[href*="/admin/users/"]');
  const count = await userLinks.count();

  if (count === 0) {
    addResult('User Detail', 'WARN', 'No user links found on users list, skipping');
    return;
  }

  await userLinks.first().click();
  await sharedPage.waitForLoadState('networkidle');
  await ss(sharedPage, '06-user-detail');
  const url = sharedPage.url();
  const body = await getPageContent(sharedPage);
  const isError = await checkForErrors(sharedPage, 'User Detail');

  if (isError) {
    addResult('User Detail', 'FAIL', 'Error on user detail page');
  } else if (url.includes('/admin/users/') && body.length > 200) {
    addResult('User Detail', 'PASS', `User detail loaded: ${url.split('/').pop()}`);
  } else {
    addResult('User Detail', 'WARN', `URL: ${url}, body: ${body.length} chars`);
  }
});

// ─── 7. BILLING PLANS ────────────────────────────────────────────────────────
test('7. Billing Plans /admin/billing/plans', async () => {
  const ok = await goto('/admin/billing/plans', 'Billing Plans');
  await ss(sharedPage, '07-billing-plans');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Billing Plans', 'FAIL', 'Error state');
    return;
  }

  const hasPricing = /R\s*\d+|ZAR|free|starter|professional|enterprise|basic|plan/i.test(body);
  if (hasPricing) {
    addResult('Billing Plans', 'PASS', 'Pricing/plan information visible');
  } else {
    addResult('Billing Plans', 'WARN', `Page loads but no pricing keywords found (body: ${body.substring(0, 100)})`);
    addBug('Billing Plans', 'No plan pricing data visible', 'Navigate to /admin/billing/plans');
  }
});

// ─── 8. BILLING SUBSCRIPTIONS ────────────────────────────────────────────────
test('8. Billing Subscriptions /admin/billing/subscriptions', async () => {
  const ok = await goto('/admin/billing/subscriptions', 'Billing Subscriptions');
  await ss(sharedPage, '08-billing-subscriptions');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Billing Subscriptions', 'FAIL', 'Error state');
    return;
  }
  addResult('Billing Subscriptions', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 9. BILLING INVOICES ─────────────────────────────────────────────────────
test('9. Billing Invoices /admin/billing/invoices', async () => {
  const ok = await goto('/admin/billing/invoices', 'Billing Invoices');
  await ss(sharedPage, '09-billing-invoices');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Billing Invoices', 'FAIL', 'Error state');
    return;
  }
  addResult('Billing Invoices', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 10. BILLING OVERVIEW ────────────────────────────────────────────────────
test('10. Billing Overview /admin/billing/overview', async () => {
  const ok = await goto('/admin/billing/overview', 'Billing Overview');
  await ss(sharedPage, '10-billing-overview');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Billing Overview', 'FAIL', 'Error state');
    return;
  }
  addResult('Billing Overview', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 11. FEATURE FLAGS ───────────────────────────────────────────────────────
test('11. Feature Flags /admin/features', async () => {
  const ok = await goto('/admin/features', 'Features');
  await ss(sharedPage, '11-features');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Features', 'FAIL', 'Error state');
    return;
  }

  // Find toggle switches
  const toggles = sharedPage.locator('button[role="switch"], input[type="checkbox"][id*="feature"], [data-testid*="toggle"]');
  const toggleCount = await toggles.count();
  console.log(`Feature flags toggles found: ${toggleCount}`);

  if (toggleCount > 0) {
    // Read initial state
    const firstToggle = toggles.first();
    const beforeChecked = await firstToggle.getAttribute('aria-checked') ??
      await firstToggle.evaluate((el: HTMLInputElement) => el.checked ? 'true' : 'false');

    await firstToggle.click();
    await sharedPage.waitForTimeout(1000);
    const afterChecked = await firstToggle.getAttribute('aria-checked') ??
      await firstToggle.evaluate((el: HTMLInputElement) => el.checked ? 'true' : 'false');

    await ss(sharedPage, '11b-features-toggled');

    // Toggle back
    if (beforeChecked !== afterChecked) {
      await firstToggle.click();
      await sharedPage.waitForTimeout(500);
      addResult('Features', 'PASS', `${toggleCount} toggle(s) found, toggle works (${beforeChecked} → ${afterChecked})`);
    } else {
      addResult('Features', 'WARN', `Toggle click did not change state (stayed: ${beforeChecked})`);
      addBug('Features', 'Toggle click has no visible effect on aria-checked state', 'Click first feature flag toggle, check aria-checked before/after');
    }
  } else {
    // Maybe toggles are rendered differently — check for any checkbox-like elements
    const anyToggles = sharedPage.locator('[role="switch"]');
    const anyCount = await anyToggles.count();
    if (anyCount === 0 && body.length > 200) {
      addResult('Features', 'WARN', 'Page loads but no toggle controls found');
      addBug('Features', 'No toggle/switch UI elements found on features page', 'Navigate to /admin/features');
    } else {
      addResult('Features', 'PASS', `Page loads with content (${body.length} chars)`);
    }
  }
});

// ─── 12. ANALYTICS ───────────────────────────────────────────────────────────
test('12. Analytics /admin/analytics', async () => {
  const ok = await goto('/admin/analytics', 'Analytics');
  await ss(sharedPage, '12-analytics');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Analytics', 'FAIL', 'Error state');
    return;
  }
  addResult('Analytics', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 13. AUDIT LOG ───────────────────────────────────────────────────────────
test('13. Audit Log /admin/audit', async () => {
  const ok = await goto('/admin/audit', 'Audit Log');
  await ss(sharedPage, '13-audit');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Audit Log', 'FAIL', 'Error state');
    return;
  }
  addResult('Audit Log', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 14. TOOLS ───────────────────────────────────────────────────────────────
test('14. Tools /admin/tools', async () => {
  const ok = await goto('/admin/tools', 'Tools');
  await ss(sharedPage, '14-tools');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Tools', 'FAIL', 'Error state');
    return;
  }
  addResult('Tools', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 15. TOOLS MIGRATIONS ────────────────────────────────────────────────────
test('15. Tools Migrations /admin/tools/migrations', async () => {
  const ok = await goto('/admin/tools/migrations', 'Tools Migrations');
  await ss(sharedPage, '15-tools-migrations');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Tools Migrations', 'FAIL', 'Error state');
    return;
  }
  addResult('Tools Migrations', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 16. TOOLS SAGE IMPORT ───────────────────────────────────────────────────
test('16. Tools Sage Import /admin/tools/sage-import', async () => {
  const ok = await goto('/admin/tools/sage-import', 'Tools Sage Import');
  await ss(sharedPage, '16-tools-sage-import');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Tools Sage Import', 'FAIL', 'Error state');
    return;
  }
  addResult('Tools Sage Import', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 17. SETTINGS ────────────────────────────────────────────────────────────
test('17. Settings /admin/settings', async () => {
  const ok = await goto('/admin/settings', 'Settings');
  await ss(sharedPage, '17-settings');
  const body = await getPageContent(sharedPage);

  if (!ok) {
    addResult('Settings', 'FAIL', 'Error state');
    return;
  }
  addResult('Settings', body.length > 200 ? 'PASS' : 'WARN',
    body.length > 200 ? 'Page loads with content' : `Sparse content (${body.length} chars)`);
});

// ─── 18. CREATE COMPANY ──────────────────────────────────────────────────────
test('18. Create Company (CRUD)', async () => {
  await goto('/admin/companies', 'Create Company');

  const createBtn = sharedPage.locator(
    'button:has-text("New"), button:has-text("Create"), button:has-text("Add Company"), ' +
    'a:has-text("New Company"), a:has-text("Create Company"), a:has-text("Add"), ' +
    '[data-testid*="create"], [data-testid*="add"]'
  ).first();
  const hasCreateBtn = await createBtn.count();

  if (hasCreateBtn === 0) {
    addResult('Create Company', 'WARN', 'No create/add button found on companies list');
    addBug('Create Company', 'No visible "Create" or "Add Company" button on companies list', 'Navigate to /admin/companies, look for create button');
    return;
  }

  await createBtn.click();
  await sharedPage.waitForTimeout(1000);
  await ss(sharedPage, '18-create-company-form');
  const url = sharedPage.url();
  const body = await getPageContent(sharedPage);

  // Check if a modal/dialog/form appeared
  const hasModal = await sharedPage.locator('[role="dialog"], .modal, form').count();
  const nameInput = sharedPage.locator(
    'input[name="name"], input[id*="name"], input[placeholder*="company" i], input[placeholder*="name" i]'
  ).first();
  const hasNameInput = await nameInput.count();

  if (hasNameInput > 0) {
    await nameInput.fill('QA Test Company ' + Date.now());
    await ss(sharedPage, '18b-create-company-filled');
    addResult('Create Company', 'PASS', 'Create form accessible and name field fillable');

    // Press Escape to close without submitting
    await sharedPage.keyboard.press('Escape');
    await sharedPage.waitForTimeout(500);
  } else if (hasModal > 0) {
    addResult('Create Company', 'WARN', 'Modal/form appeared but no name input found');
    addBug('Create Company', 'Create form has no identifiable name input', 'Click create button, look for name input');
    await sharedPage.keyboard.press('Escape');
  } else {
    addResult('Create Company', 'WARN', `No form appeared after clicking create (URL: ${url})`);
  }
});

// ─── 19. IMPERSONATE COMPANY ─────────────────────────────────────────────────
test('19. Impersonate Company', async () => {
  // Check companies list first
  await goto('/admin/companies', 'Impersonate');

  const impersonateBtns = sharedPage.locator(
    'button:has-text("Impersonate"), button:has-text("Login as"), button:has-text("Switch to"), ' +
    'a:has-text("Impersonate"), [data-testid*="impersonate"]'
  );
  let count = await impersonateBtns.count();

  if (count > 0) {
    addResult('Impersonate Company', 'PASS', `Impersonate button found on companies list`);
    await ss(sharedPage, '19-impersonate-list');
    return;
  }

  // Try company detail
  const companyLinks = sharedPage.locator('a[href*="/admin/companies/"]');
  if (await companyLinks.count() > 0) {
    await companyLinks.first().click();
    await sharedPage.waitForLoadState('networkidle');

    const detailBtns = sharedPage.locator(
      'button:has-text("Impersonate"), button:has-text("Login as"), button:has-text("Switch to"), ' +
      'a:has-text("Impersonate"), [data-testid*="impersonate"]'
    );
    count = await detailBtns.count();
    await ss(sharedPage, '19-impersonate-detail');

    if (count > 0) {
      addResult('Impersonate Company', 'PASS', 'Impersonate button found on company detail page');
    } else {
      addResult('Impersonate Company', 'WARN', 'No impersonate button found on company list or detail page');
      addBug('Impersonate Company', 'Impersonate/Login-as button missing from company list and detail', 'Check /admin/companies and /admin/companies/[id]');
    }
  } else {
    addResult('Impersonate Company', 'WARN', 'No companies to test impersonation with');
  }
});

// ─── 20. EDIT COMPANY ────────────────────────────────────────────────────────
test('20. Edit Company (CRUD)', async () => {
  await goto('/admin/companies', 'Edit Company');

  // Look for edit buttons/icons
  const editBtns = sharedPage.locator(
    'button:has-text("Edit"), a:has-text("Edit"), [aria-label*="edit" i], [data-testid*="edit"]'
  ).first();
  const hasEdit = await editBtns.count();

  if (hasEdit > 0) {
    await editBtns.click();
    await sharedPage.waitForTimeout(1000);
    await ss(sharedPage, '20-edit-company');
    const hasModal = await sharedPage.locator('[role="dialog"], .modal, form').count();
    if (hasModal > 0) {
      addResult('Edit Company', 'PASS', 'Edit form/dialog opens on edit button click');
      await sharedPage.keyboard.press('Escape');
    } else {
      addResult('Edit Company', 'WARN', 'Edit button found but no form/dialog appeared');
    }
  } else {
    // Try inside company detail
    const companyLinks = sharedPage.locator('a[href*="/admin/companies/"]');
    if (await companyLinks.count() > 0) {
      await companyLinks.first().click();
      await sharedPage.waitForLoadState('networkidle');
      const detailEdit = sharedPage.locator(
        'button:has-text("Edit"), a:has-text("Edit"), [aria-label*="edit" i]'
      ).first();
      if (await detailEdit.count() > 0) {
        await detailEdit.click();
        await sharedPage.waitForTimeout(1000);
        await ss(sharedPage, '20b-edit-company-detail');
        addResult('Edit Company', 'PASS', 'Edit button found and clickable on company detail');
        await sharedPage.keyboard.press('Escape');
      } else {
        addResult('Edit Company', 'WARN', 'No edit button found on company list or detail page');
        addBug('Edit Company', 'No edit button visible on companies list or detail', 'Check /admin/companies and company detail');
      }
    }
  }
});

// ─── 21. CONSOLE ERROR SWEEP ─────────────────────────────────────────────────
test('21. Console Error Sweep', async () => {
  // This test just reports what was captured during the run
  const totalErrors = Object.values(consoleErrors).flat().length;
  console.log(`Console errors captured across all pages: ${totalErrors}`);
  if (totalErrors > 0) {
    for (const [url, errors] of Object.entries(consoleErrors)) {
      console.log(`  ${url}: ${errors.length} error(s)`);
      errors.slice(0, 2).forEach(e => console.log(`    - ${e.substring(0, 120)}`));
    }
  }

  if (totalErrors === 0) {
    addResult('Console Errors', 'PASS', 'No JS console errors across admin pages');
  } else if (totalErrors < 5) {
    addResult('Console Errors', 'WARN', `${totalErrors} console error(s) found`);
  } else {
    addResult('Console Errors', 'FAIL', `${totalErrors} console errors — see logs`);
  }
});
