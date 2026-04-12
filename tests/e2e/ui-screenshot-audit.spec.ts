/**
 * Screenshot-focused workflow audit — captures screenshots for visual evidence
 */
import { test } from '@playwright/test';

const BASE = 'https://app.isaflow.co.za';

test('capture workflow screenshots', async ({ page }) => {
  // Verify auth works
  await page.goto(`${BASE}/accounting/customers`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w1-customers.png', fullPage: false });

  // W1: Customer invoices list
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w1-invoice-list.png' });

  // W1: New invoice form
  await page.goto(`${BASE}/accounting/customer-invoices/new`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w1-new-invoice.png' });

  // W2: Invoice detail (find one with unpaid status)
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  // Click first invoice
  try {
    const rows = page.locator('table tbody tr, [data-testid*="invoice"]');
    if (await rows.count() > 0) {
      await rows.first().click();
      await page.waitForLoadState('networkidle');
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'tests/e2e/screenshots/audit-w2-invoice-detail.png' });
    }
  } catch { /* ignore */ }

  // W3: Supplier invoice new
  await page.goto(`${BASE}/accounting/supplier-invoices/new`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w3-supplier-new.png' });

  // W3: Supplier invoice list
  await page.goto(`${BASE}/accounting/supplier-invoices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1500);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w3-supplier-list.png' });

  // W4: Bank accounts
  await page.goto(`${BASE}/accounting/bank-accounts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w4-bank-accounts.png' });

  // W4: Bank transactions
  await page.goto(`${BASE}/accounting/bank-transactions`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w4-bank-transactions.png' });

  // W5: Chart of accounts
  await page.goto(`${BASE}/accounting/chart-of-accounts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w5-coa.png' });

  // W6: Trial balance
  await page.goto(`${BASE}/accounting/reports/trial-balance`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w6-trial-balance.png' });

  // W7: VAT return
  await page.goto(`${BASE}/accounting/reports/vat-return`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w7-vat-return.png' });

  // W8: Company settings
  await page.goto(`${BASE}/accounting/company-settings`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  await page.screenshot({ path: 'tests/e2e/screenshots/audit-w8-company-settings.png' });

  // W8: Click UDF tab
  try {
    const udfTab = page.locator('button:has-text("UDF"), button:has-text("User Fields"), [role="tab"]:has-text("UDF"), [role="tab"]:has-text("User")').first();
    if (await udfTab.count() > 0) {
      await udfTab.click();
      await page.waitForTimeout(1000);
      await page.screenshot({ path: 'tests/e2e/screenshots/audit-w8-udf-tab.png' });
    }
  } catch { /* ignore */ }
});
