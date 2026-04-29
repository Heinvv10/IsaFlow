import { chromium } from 'playwright';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://app.isaflow.co.za';
// admin@isaflow.co.za is a member of the demo company (00000000-0000-0000-0000-000000000001)
// and was validated working on 2026-04-29
const EMAIL = process.env.E2E_TENANT_EMAIL || process.env.E2E_ADMIN_EMAIL || 'admin@isaflow.co.za';
const PASSWORD = process.env.E2E_TENANT_PASSWORD || process.env.E2E_ADMIN_PASSWORD || 'admin123';
const OUT = join(process.cwd(), 'tmp/tenant-e2e-audit');
const SHOTS = join(OUT, 'screenshots');

mkdirSync(SHOTS, { recursive: true });

// Comprehensive tenant route list from accountingNavConfig.ts (2026-04-29)
const routes = [
  // Core
  ['Dashboard', '/accounting'],
  ['Portfolio Workbench', '/accounting/portfolio-workbench'],
  ['Month-End Workbench', '/accounting/month-end-workbench'],

  // Sales / AR
  ['Customers', '/accounting/customers'],
  ['Customer Invoices', '/accounting/customer-invoices'],
  ['Customer Payments', '/accounting/customer-payments'],
  ['Customer Receipts / AR Receipt Match', '/accounting/ar/receipt-match'],
  ['Customer Statements', '/accounting/customer-statements'],
  ['Customer Quotes', '/accounting/customer-quotes'],
  ['Credit Notes', '/accounting/credit-notes'],
  ['Write-Offs', '/accounting/write-offs'],
  ['Customer Allocations', '/accounting/customer-allocations'],
  ['AR Aging', '/accounting/ar-aging'],
  ['Statement Run', '/accounting/statement-run'],
  ['Dunning', '/accounting/ar/dunning'],
  ['Dunning Runs', '/accounting/ar/dunning/runs'],
  ['Debtors Manager', '/accounting/debtors-manager'],
  ['Recurring Invoices', '/accounting/recurring-invoices'],
  ['Disputes', '/accounting/disputes'],

  // Purchases / AP
  ['Suppliers', '/accounting/suppliers'],
  ['Supplier Invoices', '/accounting/supplier-invoices'],
  ['Supplier Payments', '/accounting/supplier-payments'],
  ['Supplier Returns', '/accounting/supplier-returns'],
  ['Batch Payments', '/accounting/batch-payments'],
  ['Supplier Allocations', '/accounting/supplier-allocations'],
  ['AP Aging', '/accounting/ap-aging'],
  ['Supplier Statements', '/accounting/supplier-statements'],
  ['Purchase Orders', '/accounting/purchase-orders'],
  ['Goods Received', '/accounting/goods-received'],
  ['Capture Inbox', '/accounting/capture/inbox'],
  ['Expenses', '/accounting/expenses'],

  // Banking
  ['Bank Accounts', '/accounting/bank-accounts'],
  ['Bank Transactions', '/accounting/bank-transactions'],
  ['Bank Reconciliation', '/accounting/bank-reconciliation'],
  ['Bank Reconciliation Import', '/accounting/bank-reconciliation/import'],
  ['Bank Reconciliation Rules', '/accounting/bank-reconciliation/rules'],
  ['Bank Transfers', '/accounting/bank-transfers'],
  ['Bank Provisional', '/accounting/bank/provisional'],

  // Accounting / GL
  ['Chart of Accounts', '/accounting/chart-of-accounts'],
  ['Journal Entries', '/accounting/journal-entries'],
  ['Recurring Journals', '/accounting/recurring-journals'],
  ['Trial Balance', '/accounting/trial-balance'],
  ['Fiscal Periods', '/accounting/fiscal-periods'],
  ['Financial Years', '/accounting/financial-years'],
  ['Opening Balances', '/accounting/opening-balances'],
  ['Audit Log', '/accounting/audit-log'],
  ['Year End', '/accounting/year-end'],
  ['Depreciation', '/accounting/depreciation'],
  ['Cost Centres', '/accounting/cost-centres'],
  ['Budgets', '/accounting/budgets'],

  // Loans
  ['Loans', '/accounting/loans'],
  ['Loan Rate Curves', '/accounting/loans/rate-curves'],

  // Fixed Assets
  ['Assets', '/accounting/assets'],
  ['Assets Register', '/accounting/assets/register'],
  ['Assets FAR Report', '/accounting/assets/far-report'],
  ['Asset Categories', '/accounting/assets/categories'],
  ['Asset Disposals', '/accounting/assets/disposals'],

  // Reports
  ['Income Statement', '/accounting/reports/income-statement'],
  ['Balance Sheet', '/accounting/reports/balance-sheet'],
  ['Cash Flow', '/accounting/reports/cash-flow'],
  ['Cash Flow Forecast', '/accounting/reports/cash-flow-forecast'],
  ['Budget vs Actual', '/accounting/reports/budget-vs-actual'],
  ['VAT Return', '/accounting/reports/vat-return'],
  ['Sales by Customer', '/accounting/reports/sales-by-customer'],
  ['Purchases by Supplier', '/accounting/reports/purchases-by-supplier'],
  ['Account Transactions', '/accounting/reports/account-transactions'],
  ['Journal Entries Report', '/accounting/reports/journal-entries'],
  ['Bank Transactions Report', '/accounting/reports/bank-transactions'],
  ['AFS', '/accounting/afs'],
  ['AFS Management Packs', '/accounting/afs/management-packs'],
  ['Report Builder', '/accounting/reports/builder'],
  ['Audit Packs', '/accounting/audit-packs'],

  // VAT / Tax
  ['VAT Adjustments', '/accounting/vat-adjustments'],
  ['DRC VAT', '/accounting/drc-vat'],
  ['SARS', '/accounting/sars'],
  ['SARS VAT201', '/accounting/sars/vat201'],

  // Payroll
  ['Payroll Runs', '/payroll/runs'],
  ['Employees', '/payroll/employees'],
  ['Payroll Components', '/payroll/components'],
  ['Payroll Leave Types', '/payroll/leave/types'],
  ['Payroll Leave Balances', '/payroll/leave/balances'],
  ['Payroll IRP5', '/payroll/irp5'],
  ['Payroll Year End', '/payroll/year-end'],
  ['Payroll EMP501', '/payroll/emp501'],

  // Practice
  ['Practice Clients', '/accounting/practice/clients'],
  ['Practice Time Entry', '/accounting/practice/time-entry'],
  ['Practice Jobs', '/accounting/practice/jobs'],
  ['Practice WIP', '/accounting/practice/wip'],
  ['Practice Utilisation Report', '/accounting/practice/reports/utilisation'],

  // Settings
  ['Company Settings', '/accounting/company-settings'],
  ['User Access', '/accounting/user-access'],
  ['Webhooks (tenant)', '/accounting/webhooks'],
  ['Document Capture Settings', '/accounting/document-capture'],
  ['Connected Apps', '/accounting/settings/connected-apps'],
  ['Sage Migration', '/accounting/sage-migration'],
];

const destructive = /delete|remove|suspend|activate|deactivate|disable|enable|save|submit|confirm|reset|logout|log out|impersonate|force|promote|convert|import|commit|run|execute|sync|send|resend|redeliver|retry|bulk/i;
const safeOpeners = /filter|status|role|type|more|menu|actions|search|date|period|billing|tools|export|download|create|add|new/i;

function textish(s) {
  return String(s || '').replace(/\s+/g, ' ').trim().slice(0, 160);
}

async function visibleSummary(page) {
  return page.evaluate(() => {
    const vis = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    const cls = el => typeof el.className === 'string' ? el.className : '';
    return {
      headings: [...document.querySelectorAll('h1,h2,h3')].filter(vis).map(el => el.innerText.trim()).filter(Boolean).slice(0, 12),
      buttons: [...document.querySelectorAll('button,[role="button"]')].filter(vis).map(el => el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || cls(el)).filter(Boolean).slice(0, 80),
      links: [...document.querySelectorAll('a[href]')].filter(vis).map(el => ({ text: el.innerText.trim() || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('href'), href: el.getAttribute('href') })).slice(0, 80),
      inputs: [...document.querySelectorAll('input,textarea,select,[role="combobox"],[role="switch"],input[type="checkbox"]')].filter(vis).map(el => ({
        tag: el.tagName,
        type: el.getAttribute('type'),
        role: el.getAttribute('role'),
        label: el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.name || el.id || el.parentElement?.innerText?.trim()?.slice(0, 80) || ''
      })).slice(0, 80),
      tables: [...document.querySelectorAll('table')].filter(vis).map(table => ({
        headers: [...table.querySelectorAll('th')].map(th => th.innerText.trim()).filter(Boolean).slice(0, 12),
        rows: table.querySelectorAll('tbody tr').length,
      })),
      dialogs: [...document.querySelectorAll('[role="dialog"],[aria-modal="true"],dialog,[class*="modal" i]')].filter(vis).map(el => el.innerText.trim().slice(0, 300)),
      body: document.body.innerText.slice(0, 1200),
    };
  });
}

async function safeClickAudit(page) {
  const candidates = await page.locator('button, [role="button"], select, [role="combobox"]').evaluateAll((els) => {
    const vis = el => {
      const r = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
    };
    return els
      .filter(vis)
      .map((el, index) => ({
        index,
        text: (el.innerText || el.getAttribute('aria-label') || el.getAttribute('title') || el.getAttribute('placeholder') || el.className || '').toString().replace(/\s+/g, ' ').trim().slice(0, 120),
        tag: el.tagName,
        role: el.getAttribute('role'),
      }))
      .filter(item => item.text);
  });

  const results = [];
  for (const item of candidates.slice(0, 30)) {
    if (destructive.test(item.text)) {
      results.push({ control: item.text, skipped: 'destructive-looking' });
      continue;
    }
    if (/view/i.test(item.text)) {
      results.push({ control: item.text, skipped: 'navigation-or-impersonation-risk' });
      continue;
    }
    if (!safeOpeners.test(item.text) && item.tag !== 'SELECT' && item.role !== 'combobox') continue;
    const beforeUrl = page.url();
    const beforeDialogs = await page.locator('[role="dialog"],[aria-modal="true"],dialog,[class*="modal" i]').count().catch(() => 0);
    const beforeText = await page.evaluate(() => document.body.innerText.length);
    try {
      const byName = item.tag === 'BUTTON' || item.role === 'button'
        ? page.getByRole('button', { name: item.text, exact: false }).first()
        : page.locator('select, [role="combobox"]').first();
      await byName.click({ timeout: 1500 });
      await page.waitForTimeout(500);
      const afterDialogs = await page.locator('[role="dialog"],[aria-modal="true"],dialog,[class*="modal" i]').count().catch(() => 0);
      const afterUrl = page.url();
      const afterText = await page.evaluate(() => document.body.innerText.length);
      results.push({
        control: item.text,
        urlChanged: afterUrl !== beforeUrl,
        dialogOpened: afterDialogs > beforeDialogs,
        textDelta: afterText - beforeText,
      });
      await page.keyboard.press('Escape').catch(() => {});
      if (afterUrl !== beforeUrl) await page.goto(beforeUrl, { waitUntil: 'load', timeout: 15000 }).catch(() => {});
    } catch (e) {
      results.push({ control: item.text, error: e.message });
    }
  }
  return results;
}

async function gotoPage(page, url) {
  // Many SPA pages poll APIs — they never reach networkidle.
  // Use 'load' and wait for the main content to appear instead.
  try {
    await page.goto(url, { waitUntil: 'load', timeout: 30000 });
  } catch (e) {
    // If even 'load' times out, try domcontentloaded as last resort
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 15000 });
  }
  // Give React/SWR a moment to render data
  await page.waitForTimeout(2000);
}

async function login(page) {
  await page.goto(`${BASE}/login`, { waitUntil: 'load', timeout: 20000 });
  await page.locator('input[type="email"]').first().fill(EMAIL);
  await page.locator('input[type="password"]').first().fill(PASSWORD);
  await page.locator('button[type="submit"], button:has-text("Sign In"), button:has-text("Login")').first().click();
  await page.waitForURL(url => !url.toString().includes('/login'), { timeout: 20000 });
  // Wait for the app shell to render after login
  await page.waitForTimeout(1500);
}

async function ensureLoggedIn(page) {
  if (!page.url().includes('/login')) return;
  await login(page);
}

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();

  const network = [];
  const consoleErrors = [];
  page.on('response', res => {
    const url = res.url();
    const status = res.status();
    if (status >= 400 && url.includes('isaflow.co.za')) network.push({ status, url });
  });
  page.on('console', msg => {
    if (['error', 'warning'].includes(msg.type())) consoleErrors.push({ type: msg.type(), text: msg.text() });
  });
  page.on('pageerror', err => consoleErrors.push({ type: 'pageerror', text: err.message }));

  await login(page);

  const routeResults = [];
  for (const [name, path] of routes) {
    const startNet = network.length;
    const startConsole = consoleErrors.length;
    const url = `${BASE}${path}`;
    const result = { name, path, url, ok: false };
    try {
      await ensureLoggedIn(page);
      await gotoPage(page, url);
      if (page.url().includes('/login')) {
        await login(page);
        await gotoPage(page, url);
      }
      const finalUrl = page.url();
      const summary = await visibleSummary(page);
      const body = summary.body.toLowerCase();
      const hardError = /internal server error|application error|server error/.test(body);
      // Don't flag "not found" as hard error — some routes may redirect to a parent
      const loginRedirect = finalUrl.includes('/login');
      const shotName = `${String(routeResults.length + 1).padStart(3, '0')}-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 60)}.png`;
      await page.screenshot({ path: join(SHOTS, shotName), fullPage: true });
      const interactions = await safeClickAudit(page);

      // Triage network errors for this route
      const routeNetErrors = network.slice(startNet);
      const has5xx = routeNetErrors.some(e => e.status >= 500);
      const has4xx = routeNetErrors.some(e => e.status >= 400 && e.status < 500 && !e.url.includes('/_next/data/'));

      result.ok = !hardError && !loginRedirect && !has5xx;
      result.priority = has5xx || hardError ? 'P1' : has4xx ? 'P2' : 'OK';

      Object.assign(result, {
        finalUrl,
        hardError,
        loginRedirect,
        has5xx,
        has4xx,
        screenshot: shotName,
        headings: summary.headings,
        buttons: summary.buttons,
        links: summary.links,
        inputs: summary.inputs,
        tables: summary.tables,
        dialogs: summary.dialogs,
        bodyPreview: textish(summary.body),
        interactions,
        networkErrors: routeNetErrors,
        consoleErrors: consoleErrors.slice(startConsole),
      });
    } catch (e) {
      result.error = e.message;
      result.priority = 'P1';
      result.networkErrors = network.slice(startNet);
      result.consoleErrors = consoleErrors.slice(startConsole);
    }
    routeResults.push(result);
    const tag = result.priority || (result.ok ? 'OK' : 'FAIL');
    console.log(`${tag} ${path} ${result.error || result.bodyPreview || ''}`);
  }

  // --- Build report ---
  const p1s = routeResults.filter(r => r.priority === 'P1' || (!r.ok && !r.priority));
  const p2s = routeResults.filter(r => r.priority === 'P2');
  const passes = routeResults.filter(r => r.ok && r.priority === 'OK');

  const report = [
    '# Tenant App End-to-End UI Audit',
    `Date: ${new Date().toISOString()}`,
    `Target: ${BASE}`,
    `Tenant: ISAFlow Demo (Pty) Ltd — company_id 00000000-0000-0000-0000-000000000001`,
    `Test account: ${EMAIL}`,
    '',
    '## Summary',
    `Routes checked: ${routeResults.length}`,
    `Passed (OK): ${passes.length}`,
    `P1 (5xx / render failure): ${p1s.length}`,
    `P2 (4xx, excl prefetches): ${p2s.length}`,
    `P3 (console noise): see Route Details section`,
    '',
    '## P1 — Must Fix',
    ...(p1s.length === 0 ? ['_None_'] : p1s.flatMap(r => [
      `### ${r.name} (${r.path})`,
      `Final URL: ${r.finalUrl || r.url}`,
      `Error: ${r.error || 'hardError=' + r.hardError + ', loginRedirect=' + r.loginRedirect + ', has5xx=' + r.has5xx}`,
      `Network errors: ${JSON.stringify((r.networkErrors || []).slice(0, 10))}`,
      `Body: ${r.bodyPreview || ''}`,
      '',
    ])),
    '',
    '## P2 — Follow-up Tickets',
    ...(p2s.length === 0 ? ['_None_'] : p2s.flatMap(r => [
      `### ${r.name} (${r.path})`,
      `Final URL: ${r.finalUrl || r.url}`,
      `Network errors: ${JSON.stringify((r.networkErrors || []).slice(0, 10))}`,
      '',
    ])),
    '',
    '## Follow-up Tickets',
    '<!-- P2/P3 items to file as follow-up work -->',
    ...p2s.map(r => `- [ ] P2: \`${r.path}\` — 4xx: ${r.networkErrors?.map(e => `${e.status} ${e.url}`).join(', ')}`),
    '',
    '## Route Details',
    ...routeResults.flatMap(r => [
      `### ${r.name} (${r.path})`,
      `Status: ${r.priority || (r.ok ? 'OK' : 'FAIL')}`,
      `Screenshot: ${r.screenshot || ''}`,
      `Headings: ${JSON.stringify(r.headings || [])}`,
      `Tables: ${JSON.stringify(r.tables || [])}`,
      `Inputs: ${JSON.stringify(r.inputs || [])}`,
      `Buttons: ${JSON.stringify((r.buttons || []).slice(0, 25))}`,
      `Network errors: ${JSON.stringify((r.networkErrors || []).slice(0, 20))}`,
      `Console errors: ${JSON.stringify((r.consoleErrors || []).slice(0, 10))}`,
      `Safe interactions: ${JSON.stringify(r.interactions || [])}`,
      '',
    ]),
  ].join('\n');

  writeFileSync(join(OUT, 'report.md'), report);
  writeFileSync(join(OUT, 'results.json'), JSON.stringify(routeResults, null, 2));
  await browser.close();
  console.log(`\nReport: ${join(OUT, 'report.md')}`);
  console.log(`P1: ${p1s.length} | P2: ${p2s.length} | OK: ${passes.length}`);
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
