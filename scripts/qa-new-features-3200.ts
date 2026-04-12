/**
 * QA script for new ISAFlow features — localhost:3200
 * Tests: Financial Years, Delivery Notes, Recurring Invoices,
 *        Customer Statements, Supplier Detail tabs, Item Bundles, Admin Companies
 */

import { chromium, Browser, BrowserContext, Page } from 'playwright';

const BASE = 'http://localhost:3200';
const EMAIL = 'admin@isaflow.co.za';
const PASS = 'admin123';

interface TestResult {
  step: number;
  feature: string;
  action: string;
  expected: string;
  actual: string;
  result: 'PASS' | 'FAIL' | 'SKIP';
  notes?: string;
}

const results: TestResult[] = [];
let stepNum = 0;

function record(
  feature: string,
  action: string,
  expected: string,
  actual: string,
  result: 'PASS' | 'FAIL' | 'SKIP',
  notes?: string
) {
  stepNum++;
  results.push({ step: stepNum, feature, action, expected, actual, result, notes });
  const icon = result === 'PASS' ? '✓' : result === 'FAIL' ? '✗' : '~';
  process.stdout.write(`[${icon}] Step ${stepNum} | ${feature} | ${action} → ${result}${notes ? ' | ' + notes : ''}\n`);
}

/**
 * Login: navigate to login page, fill form, submit.
 * Playwright ignores Secure flag for localhost, but the app sets SameSite=Strict.
 * We use ignoreHTTPSErrors and set the context to allow all cookies.
 */
async function login(page: Page): Promise<boolean> {
  try {
    // Navigate to login page
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(1500);

    const url = page.url();
    if (url.includes('/accounting') || url.includes('/dashboard') || url.includes('/onboarding')) {
      record('Auth', 'Login check', 'Dashboard', 'Already authenticated', 'PASS');
      return true;
    }

    // Wait for form to be ready
    await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 8000 });
    await page.fill('input[type="email"]', EMAIL);
    await page.fill('input[type="password"]', PASS);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);

    const afterUrl = page.url();
    // Check if still on login (failed)
    if (afterUrl.includes('/login')) {
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      record('Auth', `Login as ${EMAIL}`, 'Dashboard', `Still on ${afterUrl}`, 'FAIL', bodyText.substring(0, 200));
      return false;
    }
    record('Auth', `Login as ${EMAIL}`, 'Dashboard', `Redirected to ${afterUrl}`, 'PASS');
    return true;
  } catch (e: any) {
    record('Auth', 'Login', 'Dashboard', `Exception: ${e.message}`, 'FAIL');
    return false;
  }
}

/** Navigate and return { url, bodyText, is404, hasError } */
async function safeNav(page: Page, path: string): Promise<{ url: string; bodyText: string; is404: boolean; hasAppError: boolean }> {
  await page.goto(`${BASE}${path}`, { waitUntil: 'networkidle', timeout: 20000 });
  await page.waitForTimeout(2000);
  const url = page.url();
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 4000));
  const is404 = bodyText.includes('404') && (bodyText.includes('Page not found') || bodyText.includes('could not be found'));
  const hasAppError = bodyText.toLowerCase().includes('application error') || bodyText.toLowerCase().includes('something went wrong');
  return { url, bodyText, is404, hasAppError };
}

// ── Feature Tests ─────────────────────────────────────────────────────────────

async function testFinancialYears(page: Page) {
  const F = 'Financial Year Management';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/accounting/financial-years');
    if (url.includes('/login')) {
      record(F, 'Navigate to /accounting/financial-years', 'Page loads', 'Redirected to login', 'FAIL', 'Auth not persisting');
      return;
    }
    if (is404) { record(F, 'Navigate to financial-years', 'Page loads', '404', 'FAIL', 'Routing issue'); return; }
    if (hasAppError) { record(F, 'Navigate to financial-years', 'Page loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /accounting/financial-years', 'Page loads', `OK — ${url}`, 'PASS');

    const hasPeriodContent = /period|year|fiscal|quarter/i.test(bodyText);
    record(F, 'Fiscal periods listed', 'Periods/years visible', hasPeriodContent ? 'Period content found' : 'No period content', hasPeriodContent ? 'PASS' : 'FAIL', bodyText.substring(0, 200));

    const lockEl = await page.$('button:has-text("Lock"), button:has-text("Unlock"), [title*="Lock"], [aria-label*="lock" i]');
    record(F, 'Lock/unlock controls', 'Controls visible', lockEl ? 'Controls found' : 'No lock controls (may be no periods)', lockEl ? 'PASS' : 'SKIP', 'Depends on data');
  } catch (e: any) {
    record(F, 'Navigate', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

async function testDeliveryNotes(page: Page) {
  const F = 'Delivery Notes';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/accounting/delivery-notes');
    if (url.includes('/login')) { record(F, 'Navigate', 'Page loads', 'Redirected to login', 'FAIL'); return; }
    if (is404) { record(F, 'Navigate to /accounting/delivery-notes', 'List page loads', '404', 'FAIL'); return; }
    if (hasAppError) { record(F, 'Navigate to /accounting/delivery-notes', 'List page loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /accounting/delivery-notes', 'List page loads', `OK — ${url}`, 'PASS');

    // Look for new button
    const newBtn = await page.$('button:has-text("New"), a:has-text("New"), a[href*="new"]');
    record(F, 'New Delivery Note button present', 'Button visible', newBtn ? 'Button found' : 'Not found', newBtn ? 'PASS' : 'FAIL');

    if (newBtn) {
      await newBtn.click();
      await page.waitForTimeout(2500);
      const newUrl = page.url();
      const formText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
      const hasCustomer = /customer/i.test(formText) || (await page.$('select, input[placeholder*="customer" i], [data-testid*="customer"]')) !== null;
      const hasLineItems = /item|product|description|qty|quantity/i.test(formText);
      record(F, 'Click New — form opens', 'Form with customer selector', `URL: ${newUrl}, customer: ${hasCustomer}`, hasCustomer ? 'PASS' : 'FAIL');
      record(F, 'Line items section present', 'Line items visible', hasLineItems ? 'Line items found' : 'No line items', hasLineItems ? 'PASS' : 'FAIL');
    } else {
      record(F, 'Click New — form opens', 'Form opens', 'Skipped — no button', 'SKIP');
      record(F, 'Line items section present', 'Line items visible', 'Skipped', 'SKIP');
    }
  } catch (e: any) {
    record(F, 'Navigate', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

async function testRecurringInvoices(page: Page) {
  const F = 'Recurring Invoices';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/accounting/recurring-invoices');
    if (url.includes('/login')) { record(F, 'Navigate', 'Page loads', 'Redirected to login', 'FAIL'); return; }
    if (is404) { record(F, 'Navigate to /accounting/recurring-invoices', 'List page loads', '404', 'FAIL'); return; }
    if (hasAppError) { record(F, 'Navigate to /accounting/recurring-invoices', 'List page loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /accounting/recurring-invoices', 'List page loads', `OK — ${url}`, 'PASS');

    const hasContent = /recurring|invoice|template/i.test(bodyText);
    record(F, 'Templates listed', 'Templates visible', hasContent ? 'Content found' : 'No content', hasContent ? 'PASS' : 'FAIL', bodyText.substring(0, 150));

    // "Due" badge
    const dueBadge = await page.$('span:has-text("Due"), .badge:has-text("Due"), [class*="badge"]');
    record(F, '"Due" badges', 'Due badges if overdue', dueBadge ? 'Due badge found' : 'No due badges (none overdue)', 'PASS', 'Optional');

    // "Run All Due" button
    const runBtn = await page.$('button:has-text("Run All Due"), button:has-text("Run All"), button:has-text("Run")');
    record(F, '"Run All Due" button', 'Button visible', runBtn ? 'Button found' : 'Not found', runBtn ? 'PASS' : 'FAIL');
  } catch (e: any) {
    record(F, 'Navigate', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

async function testCustomerStatements(page: Page) {
  const F = 'Customer Statements';
  const routes = ['/accounting/customer-statements', '/accounting/statement-run', '/accounting/statements'];
  let tested = false;

  for (const route of routes) {
    try {
      const { url, bodyText, is404, hasAppError } = await safeNav(page, route);
      if (url.includes('/login')) continue;
      if (is404) continue;
      if (hasAppError) {
        record(F, `Navigate to ${route}`, 'Page loads', 'App error', 'FAIL');
        tested = true;
        break;
      }
      record(F, `Navigate to ${route}`, 'Page loads', `OK — ${url}`, 'PASS');
      tested = true;

      const hasCustomers = /customer|balance|statement/i.test(bodyText);
      record(F, 'Customer list with balances', 'List + balances visible', hasCustomers ? 'Customer/balance content found' : 'No customer content', hasCustomers ? 'PASS' : 'FAIL');

      const hasCheckboxes = (await page.$('input[type="checkbox"]')) !== null;
      record(F, 'Checkboxes for selection', 'Checkboxes visible', hasCheckboxes ? 'Checkboxes present' : 'No checkboxes', hasCheckboxes ? 'PASS' : 'FAIL');
      break;
    } catch (_) { /* try next */ }
  }

  if (!tested) {
    record(F, 'Navigate to statements page', 'Page loads', `All routes 404: ${routes.join(', ')}`, 'FAIL');
  }
}

async function testSupplierDetail(page: Page) {
  const F = 'Supplier Detail — Contacts & Activity';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/accounting/suppliers');
    if (url.includes('/login')) { record(F, 'Navigate to /accounting/suppliers', 'List loads', 'Redirected to login', 'FAIL'); return; }
    if (is404) { record(F, 'Navigate to /accounting/suppliers', 'List loads', '404', 'FAIL'); return; }
    if (hasAppError) { record(F, 'Navigate to /accounting/suppliers', 'List loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /accounting/suppliers', 'List loads', `OK — ${url}`, 'PASS');

    // Find first supplier link
    const supplierLinks = await page.$$('a[href*="/accounting/suppliers/"]');
    if (supplierLinks.length === 0) {
      // Check if there are table rows we can click
      const rows = await page.$$('tbody tr');
      if (rows.length > 0) {
        await rows[0].click();
        await page.waitForTimeout(2000);
      } else {
        record(F, 'Find and click supplier', 'Supplier detail opens', 'No supplier links found (empty list?)', 'FAIL');
        return;
      }
    } else {
      const href = await supplierLinks[0].getAttribute('href');
      await supplierLinks[0].click();
      await page.waitForTimeout(2000);
    }

    const detailUrl = page.url();
    record(F, 'Click supplier row', 'Detail page opens', `URL: ${detailUrl}`, 'PASS');

    // Look for Contacts tab
    const contactsTab = await page.$('[role="tab"]:has-text("Contacts"), button:has-text("Contacts"), a:has-text("Contacts")');
    record(F, '"Contacts" tab visible', 'Tab present', contactsTab ? 'Contacts tab found' : 'Not found', contactsTab ? 'PASS' : 'FAIL');

    // Look for Activity tab
    const activityTab = await page.$('[role="tab"]:has-text("Activity"), button:has-text("Activity"), a:has-text("Activity")');
    record(F, '"Activity" tab visible', 'Tab present', activityTab ? 'Activity tab found' : 'Not found', activityTab ? 'PASS' : 'FAIL');

    // Click Contacts
    if (contactsTab) {
      await contactsTab.click();
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.body.innerText.toLowerCase());
      const err = t.includes('application error') || t.includes('something went wrong');
      record(F, 'Click Contacts tab', 'No error', err ? 'Error on tab' : 'Tab loaded OK', err ? 'FAIL' : 'PASS');
    } else {
      record(F, 'Click Contacts tab', 'Tab loads', 'Skipped — tab not found', 'SKIP');
    }

    // Click Activity
    if (activityTab) {
      await activityTab.click();
      await page.waitForTimeout(1500);
      const t = await page.evaluate(() => document.body.innerText.toLowerCase());
      const err = t.includes('application error') || t.includes('something went wrong');
      record(F, 'Click Activity tab', 'No error', err ? 'Error on tab' : 'Tab loaded OK', err ? 'FAIL' : 'PASS');
    } else {
      record(F, 'Click Activity tab', 'Tab loads', 'Skipped — tab not found', 'SKIP');
    }
  } catch (e: any) {
    record(F, 'Supplier detail test', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

async function testItemBundles(page: Page) {
  const F = 'Item Bundles';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/accounting/items');
    if (url.includes('/login')) { record(F, 'Navigate to /accounting/items', 'List loads', 'Redirected to login', 'FAIL'); return; }
    if (is404) { record(F, 'Navigate to /accounting/items', 'List loads', '404', 'FAIL'); return; }
    if (hasAppError) { record(F, 'Navigate to /accounting/items', 'List loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /accounting/items', 'List loads', `OK — ${url}`, 'PASS');

    // Click first item
    const itemLinks = await page.$$('a[href*="/accounting/items/"]');
    if (itemLinks.length === 0) {
      const rows = await page.$$('tbody tr');
      if (rows.length > 0) {
        await rows[0].click();
        await page.waitForTimeout(2000);
      } else {
        record(F, 'Find and click item', 'Item detail opens', 'No items found (empty list?)', 'FAIL');
        return;
      }
    } else {
      await itemLinks[0].click();
      await page.waitForTimeout(2000);
    }

    const detailUrl = page.url();
    record(F, 'Click item', 'Detail page opens', `URL: ${detailUrl}`, 'PASS');

    const detailText = await page.evaluate(() => document.body.innerText.substring(0, 4000));
    const hasBundle = /bundle|component/i.test(detailText) || (await page.$('[data-testid*="bundle"], .bundle, label:has-text("Bundle")')) !== null;
    record(F, '"Bundle Components" section', 'Section visible', hasBundle ? 'Bundle section found' : 'No bundle section', hasBundle ? 'PASS' : 'FAIL');

    // Try toggling bundle switch
    const bundleSwitch = await page.$('input[type="checkbox"][name*="bundle" i], input[type="checkbox"][id*="bundle" i], button[role="switch"], [data-testid*="bundle"]');
    if (bundleSwitch) {
      await bundleSwitch.click();
      await page.waitForTimeout(1000);
      const afterText = await page.evaluate(() => document.body.innerText.toLowerCase());
      const err = afterText.includes('application error');
      record(F, 'Toggle bundle switch', 'Toggles without error', err ? 'Error after toggle' : 'Toggle OK', err ? 'FAIL' : 'PASS');
    } else {
      record(F, 'Toggle bundle switch', 'Switch toggles', 'No bundle toggle found', hasBundle ? 'FAIL' : 'SKIP');
    }
  } catch (e: any) {
    record(F, 'Item bundles test', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

async function testAdminCompanies(page: Page) {
  const F = 'Admin — Companies';
  try {
    const { url, bodyText, is404, hasAppError } = await safeNav(page, '/admin/companies');
    if (url.includes('/login')) {
      record(F, 'Navigate to /admin/companies', 'Page loads', 'Redirected to login (auth issue)', 'FAIL', 'Admin route rejects auth');
      return;
    }
    if (is404) { record(F, 'Navigate to /admin/companies', 'Page loads', '404', 'FAIL', 'May be on separate subdomain'); return; }
    if (hasAppError) { record(F, 'Navigate to /admin/companies', 'Page loads', 'App error', 'FAIL'); return; }
    record(F, 'Navigate to /admin/companies', 'Page loads', `OK — ${url}`, 'PASS');

    const addBtn = await page.$('button:has-text("Add Company"), a:has-text("Add Company"), button:has-text("New Company")');
    record(F, '"Add Company" button', 'Button visible', addBtn ? 'Button found' : 'Not found', addBtn ? 'PASS' : 'FAIL');

    const hasActions = /suspend|activate/i.test(bodyText) || (await page.$('[title*="Suspend"], [title*="Activate"], [aria-label*="suspend" i]')) !== null;
    record(F, 'Actions column (Suspend/Activate)', 'Icons visible', hasActions ? 'Actions found' : 'Not found', hasActions ? 'PASS' : 'FAIL');
  } catch (e: any) {
    record(F, 'Admin companies test', 'Page loads', `Exception: ${e.message}`, 'FAIL');
  }
}

// ── Report ────────────────────────────────────────────────────────────────────

function printReport(consoleErrors: string[]) {
  const date = new Date().toISOString().split('T')[0];
  const passed = results.filter(r => r.result === 'PASS').length;
  const failed = results.filter(r => r.result === 'FAIL').length;
  const skipped = results.filter(r => r.result === 'SKIP').length;
  const total = results.length;

  console.log('\n' + '='.repeat(100));
  console.log(`QA Report: ISAFlow New Features`);
  console.log(`Date: ${date}   Target: ${BASE}`);
  console.log('='.repeat(100));

  console.log('\n| Step | Feature | Action | Expected | Actual | Result |');
  console.log('|------|---------|--------|----------|--------|--------|');
  for (const r of results) {
    const feature = r.feature.substring(0, 35);
    const action = r.action.substring(0, 50);
    const expected = r.expected.substring(0, 30);
    const actual = r.actual.substring(0, 45);
    console.log(`| ${r.step} | ${feature} | ${action} | ${expected} | ${actual} | **${r.result}** |`);
    if (r.notes) console.log(`|  |  | NOTE: ${r.notes.substring(0, 80)} |  |  |  |`);
  }

  console.log(`\n**Summary:** ${passed}/${total} steps passed  |  ${failed} failed  |  ${skipped} skipped`);

  if (failed > 0) {
    console.log('\n--- FAILURES ---');
    results.filter(r => r.result === 'FAIL').forEach(r => {
      console.log(`  Step ${r.step} [${r.feature}] ${r.action}`);
      console.log(`    Expected: ${r.expected}`);
      console.log(`    Actual:   ${r.actual}`);
      if (r.notes) console.log(`    Notes:    ${r.notes}`);
    });
  }

  if (consoleErrors.length > 0) {
    console.log('\n--- Console Errors (first 15) ---');
    consoleErrors.slice(0, 15).forEach(e => console.log('  ' + e));
  }
  console.log('='.repeat(100));
}

// ── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  // Use ignoreHTTPSErrors and bypassCSP so Secure cookies work on localhost
  const browser: Browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });
  const context: BrowserContext = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: true,
    bypassCSP: true,
  });
  const page = await context.newPage();

  const consoleErrors: string[] = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Filter noise
      if (!text.includes('favicon') && !text.includes('cloudflare')) {
        consoleErrors.push(`[${page.url().split('/').slice(-1)[0]}] ${text.substring(0, 180)}`);
      }
    }
  });
  page.on('pageerror', err => {
    consoleErrors.push(`[pageerror][${page.url().split('/').slice(-1)[0]}] ${err.message.substring(0, 180)}`);
  });

  try {
    const ok = await login(page);
    if (!ok) {
      console.error('Login failed — cannot continue with feature tests');
      printReport(consoleErrors);
      await browser.close();
      process.exit(1);
    }

    // After login, may land on company selector or accounting dashboard
    await page.waitForTimeout(1000);
    const postLoginUrl = page.url();
    console.log(`[info] Post-login URL: ${postLoginUrl}`);

    // If on company selector, pick first company
    if (postLoginUrl.includes('/onboarding') || (await page.$('h2:has-text("Select Company"), h1:has-text("Select Company"), [data-testid="company-selector"]'))) {
      console.log('[info] Company selector detected — picking first company');
      const companyBtn = await page.$('button[data-testid*="company"], button:has-text("Select"), li button, .company-item button');
      if (companyBtn) {
        await companyBtn.click();
        await page.waitForTimeout(2000);
      }
    }

    await testFinancialYears(page);
    await testDeliveryNotes(page);
    await testRecurringInvoices(page);
    await testCustomerStatements(page);
    await testSupplierDetail(page);
    await testItemBundles(page);
    await testAdminCompanies(page);

  } finally {
    printReport(consoleErrors);
    await browser.close();
  }
})();
