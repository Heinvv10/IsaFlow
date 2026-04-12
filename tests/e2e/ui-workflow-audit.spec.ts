/**
 * UI WORKFLOW AUDIT — 8 Critical Accounting Workflows
 * Tests against production: https://app.isaflow.co.za
 * Run: bunx playwright test tests/e2e/ui-workflow-audit.spec.ts --config playwright-prod.config.ts
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'https://app.isaflow.co.za';

// ─── Login helper — uses stored session from prod-session.json ───────────────
async function login(page: Page) {
  await page.goto(`${BASE}/accounting`);
  await page.waitForLoadState('networkidle');
  // If redirected to login, session failed
  if (page.url().includes('/login')) {
    throw new Error('Session not valid — redirected to login');
  }
}

// ─── WORKFLOW 1: Customer Invoice Lifecycle ──────────────────────────────────
test('W1: Customer Invoice Lifecycle', async ({ page }) => {
  await login(page);

  // Step 1: Customers list
  await page.goto(`${BASE}/accounting/customers`);
  await page.waitForLoadState('networkidle');
  const customersUrl = page.url();
  const customersBody = await page.content();
  const customersLoaded = !customersBody.includes('500') && !customersBody.includes('Error');
  console.log(`W1.1 Customers page: ${customersUrl} | loaded=${customersLoaded}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-01-customers.png' });

  // Find first customer name in list
  let customerName = '';
  try {
    // Try various selectors for customer list items
    const row = page.locator('table tbody tr, [data-testid="customer-row"], .customer-item').first();
    await row.waitFor({ timeout: 5000 });
    customerName = await row.locator('td, [data-testid="customer-name"]').first().innerText();
    customerName = customerName.trim();
  } catch {
    console.log('W1.1 No customers in list or different structure');
  }
  console.log(`W1.1 First customer: "${customerName}"`);

  // Step 2: New invoice page
  await page.goto(`${BASE}/accounting/customer-invoices/new`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-02-new-invoice.png' });

  const newInvoiceTitle = await page.title();
  const newInvoiceBody = await page.content();
  const hasForm = newInvoiceBody.includes('customer') || newInvoiceBody.includes('Customer') || newInvoiceBody.includes('invoice') || newInvoiceBody.includes('Invoice');
  console.log(`W1.2 New invoice page title="${newInvoiceTitle}" hasForm=${hasForm}`);
  expect(hasForm).toBe(true);

  // Step 3: Select customer - try dropdown
  try {
    const customerSelect = page.locator('select[name*="customer"], [data-testid="customer-select"], input[placeholder*="customer" i], input[placeholder*="Customer"]').first();
    await customerSelect.waitFor({ timeout: 5000 });
    const tagName = await customerSelect.evaluate(el => el.tagName);
    if (tagName === 'SELECT') {
      await customerSelect.selectOption({ index: 1 });
    } else {
      await customerSelect.click();
      await page.waitForTimeout(500);
      const option = page.locator('[role="option"], .dropdown-item, li').first();
      await option.click();
    }
    console.log('W1.3 Customer selected');
  } catch (e) {
    console.log(`W1.3 Customer select failed: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-03-customer-selected.png' });

  // Step 4: Add line items - find "Add Line" button or item rows
  try {
    // Look for description/amount fields for line items
    const descFields = page.locator('input[name*="description" i], input[placeholder*="description" i], input[name*="item" i]');
    const count = await descFields.count();
    console.log(`W1.4 Found ${count} description fields`);

    if (count > 0) {
      await descFields.first().fill('Consulting Services');
      // Find corresponding amount/price field
      const amountField = page.locator('input[name*="amount" i], input[name*="price" i], input[name*="unit" i]').first();
      if (await amountField.count() > 0) {
        await amountField.fill('1000');
      }
    }

    // Try to add second line item
    const addLineBtn = page.locator('button:has-text("Add"), button:has-text("+ Add"), button:has-text("Add Line"), button:has-text("Add Item")').first();
    if (await addLineBtn.count() > 0) {
      await addLineBtn.click();
      await page.waitForTimeout(500);
      const descFields2 = page.locator('input[name*="description" i], input[placeholder*="description" i]');
      const count2 = await descFields2.count();
      if (count2 > 1) {
        await descFields2.last().fill('Software License');
        const amountFields2 = page.locator('input[name*="amount" i], input[name*="price" i], input[name*="unit" i]');
        if (await amountFields2.count() > 1) {
          await amountFields2.last().fill('500');
        }
      }
    }
  } catch (e) {
    console.log(`W1.4 Line item add failed: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-04-line-items.png' });

  // Step 5: Check VAT/total calculations visible
  const bodyText = await page.innerText('body');
  const hasVAT = bodyText.includes('VAT') || bodyText.includes('Tax') || bodyText.includes('15%');
  const hasTotal = bodyText.includes('Total') || bodyText.includes('total');
  const hasSubtotal = bodyText.includes('Subtotal') || bodyText.includes('subtotal');
  console.log(`W1.5 VAT visible=${hasVAT}, Total visible=${hasTotal}, Subtotal visible=${hasSubtotal}`);

  // Step 6: Submit invoice
  let invoiceCreated = false;
  let invoiceId = '';
  try {
    const submitBtn = page.locator('button[type="submit"], button:has-text("Create Invoice"), button:has-text("Save Invoice"), button:has-text("Submit")').first();
    await submitBtn.waitFor({ timeout: 5000 });
    await submitBtn.click();
    await page.waitForTimeout(3000);
    const postSubmitUrl = page.url();
    invoiceCreated = postSubmitUrl !== `${BASE}/accounting/customer-invoices/new`;
    invoiceId = postSubmitUrl.split('/').pop() || '';
    console.log(`W1.6 After submit: ${postSubmitUrl}`);
  } catch (e) {
    console.log(`W1.6 Submit failed: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-05-after-submit.png' });

  // Step 7: Invoice detail page - check data saved
  if (invoiceCreated) {
    const detailBody = await page.innerText('body');
    const hasInvoiceData = detailBody.includes('Invoice') || detailBody.includes('invoice');
    console.log(`W1.7 Invoice detail loaded: ${hasInvoiceData}`);
  }

  // Step 8: Check for PDF download button
  const pdfBtn = page.locator('button:has-text("PDF"), a:has-text("PDF"), button:has-text("Download"), a[href*="pdf"]').first();
  const hasPdfBtn = await pdfBtn.count() > 0;
  console.log(`W1.8 PDF button present: ${hasPdfBtn}`);

  // Step 9: Invoice list - check status
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  const listBody = await page.innerText('body');
  const hasInvoiceList = listBody.includes('Invoice') || listBody.includes('invoice');
  const hasDraft = listBody.includes('Draft') || listBody.includes('Unpaid') || listBody.includes('draft');
  console.log(`W1.9 Invoice list loaded: ${hasInvoiceList}, has Draft/Unpaid: ${hasDraft}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-06-invoice-list.png' });
});

// ─── WORKFLOW 2: Record Payment ───────────────────────────────────────────────
test('W2: Record Payment against Invoice', async ({ page }) => {
  await login(page);

  // Go to customer invoices, find an unpaid one
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  await page.screenshot({ path: 'tests/e2e/screenshots/w2-01-invoice-list.png' });

  // Find an unpaid/draft invoice
  let foundInvoice = false;
  try {
    // Look for clickable invoice rows with Unpaid/Draft status
    const unpaidRow = page.locator('tr:has-text("Unpaid"), tr:has-text("Draft"), tr:has-text("UNPAID"), tr:has-text("DRAFT")').first();
    if (await unpaidRow.count() > 0) {
      await unpaidRow.click();
      await page.waitForLoadState('networkidle');
      foundInvoice = true;
      console.log(`W2.1 Found unpaid invoice at: ${page.url()}`);
    } else {
      // Click first row
      const firstRow = page.locator('table tbody tr').first();
      if (await firstRow.count() > 0) {
        await firstRow.click();
        await page.waitForLoadState('networkidle');
        foundInvoice = true;
        console.log(`W2.1 Clicked first invoice at: ${page.url()}`);
      }
    }
  } catch (e) {
    console.log(`W2.1 Could not navigate to invoice: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w2-02-invoice-detail.png' });

  // Look for Record Payment button
  const recordPayBtn = page.locator('button:has-text("Record Payment"), button:has-text("Payment"), a:has-text("Record Payment")').first();
  const hasPayBtn = await recordPayBtn.count() > 0;
  console.log(`W2.2 Record Payment button: ${hasPayBtn}`);

  if (hasPayBtn) {
    await recordPayBtn.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-03-payment-form.png' });

    // Fill payment amount
    const amountField = page.locator('input[name*="amount" i], input[placeholder*="amount" i]').first();
    if (await amountField.count() > 0) {
      const currentVal = await amountField.inputValue();
      console.log(`W2.3 Payment amount field value: "${currentVal}"`);
      if (!currentVal) await amountField.fill('1000');
    }

    // Submit payment
    const saveBtn = page.locator('button[type="submit"], button:has-text("Save"), button:has-text("Record"), button:has-text("Confirm")').first();
    if (await saveBtn.count() > 0) {
      await saveBtn.click();
      await page.waitForTimeout(2000);
      console.log(`W2.4 After payment save: ${page.url()}`);
    }
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-04-after-payment.png' });

    // Check status changed
    const bodyText = await page.innerText('body');
    const isPaid = bodyText.includes('Paid') || bodyText.includes('PAID') || bodyText.includes('paid');
    console.log(`W2.5 Invoice shows Paid: ${isPaid}`);
  }
});

// ─── WORKFLOW 3: Supplier Invoice ────────────────────────────────────────────
test('W3: Supplier Invoice Capture', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE}/accounting/supplier-invoices/new`);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  const body = await page.content();
  const pageLoaded = !body.includes('404') && !body.includes('500');
  console.log(`W3.1 Supplier invoice new page: ${url}, loaded=${pageLoaded}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w3-01-new-supplier-invoice.png' });

  // Check page structure
  const bodyText = await page.innerText('body');
  const hasSupplierField = bodyText.includes('Supplier') || bodyText.includes('supplier') || bodyText.includes('Vendor');
  const hasLineItems = bodyText.includes('Description') || bodyText.includes('Amount') || bodyText.includes('Item');
  console.log(`W3.2 Has supplier field: ${hasSupplierField}, Has line items: ${hasLineItems}`);

  // Try selecting a supplier
  try {
    const supplierSelect = page.locator('select[name*="supplier" i], input[placeholder*="supplier" i], [data-testid*="supplier"]').first();
    if (await supplierSelect.count() > 0) {
      const tagName = await supplierSelect.evaluate(el => el.tagName);
      if (tagName === 'SELECT') {
        const options = await supplierSelect.locator('option').count();
        console.log(`W3.3 Supplier dropdown has ${options} options`);
        if (options > 1) await supplierSelect.selectOption({ index: 1 });
      } else {
        await supplierSelect.click();
        await page.waitForTimeout(500);
        const option = page.locator('[role="option"], .dropdown-item, li').first();
        if (await option.count() > 0) await option.click();
      }
    }
  } catch (e) {
    console.log(`W3.3 Supplier selection: ${e}`);
  }

  // Fill line item
  try {
    const descField = page.locator('input[name*="description" i], input[placeholder*="description" i]').first();
    if (await descField.count() > 0) {
      await descField.fill('Office Supplies');
      const amountField = page.locator('input[name*="amount" i], input[name*="price" i], input[name*="unit" i]').first();
      if (await amountField.count() > 0) await amountField.fill('2000');
    }
  } catch (e) {
    console.log(`W3.4 Line item: ${e}`);
  }

  // Check VAT
  const pageText = await page.innerText('body');
  const hasVAT = pageText.includes('VAT') || pageText.includes('Tax') || pageText.includes('15%');
  console.log(`W3.5 VAT visible: ${hasVAT}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w3-02-filled.png' });

  // Submit
  try {
    const submitBtn = page.locator('button[type="submit"], button:has-text("Save"), button:has-text("Create")').first();
    if (await submitBtn.count() > 0) {
      await submitBtn.click();
      await page.waitForTimeout(3000);
      console.log(`W3.6 After submit: ${page.url()}`);
    }
  } catch (e) {
    console.log(`W3.6 Submit: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w3-03-after-submit.png' });

  // Check list
  await page.goto(`${BASE}/accounting/supplier-invoices`);
  await page.waitForLoadState('networkidle');
  const listText = await page.innerText('body');
  const hasList = listText.includes('Invoice') || listText.includes('Supplier') || listText.includes('supplier');
  console.log(`W3.7 Supplier invoice list loaded: ${hasList}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w3-04-list.png' });
});

// ─── WORKFLOW 4: Bank Transactions ───────────────────────────────────────────
test('W4: Bank Transaction Navigation', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE}/accounting/bank-accounts`);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  const body = await page.content();
  const loaded = !body.includes('404') && !body.includes('500');
  console.log(`W4.1 Bank accounts page: ${url}, loaded=${loaded}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w4-01-bank-accounts.png' });

  const pageText = await page.innerText('body');
  const hasBankAccounts = pageText.includes('Bank') || pageText.includes('Account') || pageText.includes('account');
  console.log(`W4.2 Bank content present: ${hasBankAccounts}`);

  // Try clicking on a bank account to view transactions
  let navigatedToTransactions = false;
  try {
    const bankRow = page.locator('table tbody tr, .bank-account-item, [data-testid*="bank"]').first();
    if (await bankRow.count() > 0) {
      await bankRow.click();
      await page.waitForLoadState('networkidle');
      console.log(`W4.3 After click: ${page.url()}`);
      navigatedToTransactions = true;
    }

    // Also try "View Transactions" or "Transactions" link
    const txnLink = page.locator('a:has-text("Transaction"), button:has-text("Transaction"), a:has-text("View")').first();
    if (!navigatedToTransactions && await txnLink.count() > 0) {
      await txnLink.click();
      await page.waitForLoadState('networkidle');
      console.log(`W4.3b Via link: ${page.url()}`);
      navigatedToTransactions = true;
    }
  } catch (e) {
    console.log(`W4.3 Navigation: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w4-02-transactions.png' });

  // Try direct bank-transactions URL
  await page.goto(`${BASE}/accounting/bank-transactions`);
  await page.waitForLoadState('networkidle');
  const txnUrl = page.url();
  const txnBody = await page.innerText('body');
  const hasTxns = txnBody.includes('Transaction') || txnBody.includes('transaction') || txnBody.includes('Amount') || txnBody.includes('Date');
  console.log(`W4.4 Bank transactions page: ${txnUrl}, has data: ${hasTxns}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w4-03-bank-txn-direct.png' });

  // Test search/filter
  const searchField = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="filter" i]').first();
  if (await searchField.count() > 0) {
    await searchField.fill('test');
    await page.waitForTimeout(1000);
    console.log('W4.5 Search/filter available and tested');
    await searchField.clear();
  } else {
    console.log('W4.5 No search/filter field found');
  }
});

// ─── WORKFLOW 5: Chart of Accounts ──────────────────────────────────────────
test('W5: Chart of Accounts', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE}/accounting/chart-of-accounts`);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  const body = await page.content();
  const loaded = !body.includes('404') && !body.includes('500');
  console.log(`W5.1 CoA page: ${url}, loaded=${loaded}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w5-01-coa.png' });

  const pageText = await page.innerText('body');
  const hasAccounts = pageText.includes('Account') || pageText.includes('account');
  const hasRows = await page.locator('table tbody tr, .account-row, [data-testid*="account"]').count();
  console.log(`W5.2 Has account content: ${hasAccounts}, row count: ${hasRows}`);

  // Try clicking an account
  try {
    const firstRow = page.locator('table tbody tr, .account-row').first();
    if (await firstRow.count() > 0) {
      const rowText = await firstRow.innerText();
      console.log(`W5.3 First account row: "${rowText.substring(0, 80)}"`);
      await firstRow.click();
      await page.waitForTimeout(1000);
      console.log(`W5.3 After click: ${page.url()}`);
    }
  } catch (e) {
    console.log(`W5.3 Click account: ${e}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w5-02-account-click.png' });

  // Look for create new account
  await page.goto(`${BASE}/accounting/chart-of-accounts`);
  await page.waitForLoadState('networkidle');
  const createBtn = page.locator('button:has-text("New"), button:has-text("Add"), button:has-text("Create"), a:has-text("New Account"), a:has-text("Add Account")').first();
  const hasCreate = await createBtn.count() > 0;
  console.log(`W5.4 Create account button: ${hasCreate}`);
  if (hasCreate) {
    const btnText = await createBtn.innerText();
    console.log(`W5.4 Button text: "${btnText}"`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w5-03-create-btn.png' });
});

// ─── WORKFLOW 6: Trial Balance ───────────────────────────────────────────────
test('W6: Trial Balance', async ({ page }) => {
  await login(page);

  // Try both common URLs
  for (const tbUrl of [
    `${BASE}/accounting/reports/trial-balance`,
    `${BASE}/accounting/trial-balance`,
    `${BASE}/accounting/reports`,
  ]) {
    await page.goto(tbUrl);
    await page.waitForLoadState('networkidle');
    const body = await page.content();
    if (!body.includes('404') && (body.includes('Trial') || body.includes('trial') || body.includes('Debit') || body.includes('Credit'))) {
      console.log(`W6.1 Found trial balance at: ${tbUrl}`);
      break;
    }
    console.log(`W6.1 Not found at: ${tbUrl}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w6-01-trial-balance.png' });

  const pageText = await page.innerText('body');
  const hasDebit = pageText.includes('Debit') || pageText.includes('DR');
  const hasCredit = pageText.includes('Credit') || pageText.includes('CR');
  const hasTrial = pageText.includes('Trial Balance') || pageText.includes('trial balance');
  console.log(`W6.2 Trial Balance: ${hasTrial}, Debit: ${hasDebit}, Credit: ${hasCredit}`);

  // Check if totals are shown and balanced - look for numbers
  const numbers = pageText.match(/[\d,]+\.\d{2}/g) || [];
  console.log(`W6.3 Found ${numbers.length} currency values on page`);

  // Look for a period selector or load button
  const loadBtn = page.locator('button:has-text("Generate"), button:has-text("Load"), button:has-text("Run"), button[type="submit"]').first();
  if (await loadBtn.count() > 0) {
    await loadBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/e2e/screenshots/w6-02-tb-loaded.png' });
    const tbText = await page.innerText('body');
    const tbNumbers = tbText.match(/[\d,]+\.\d{2}/g) || [];
    console.log(`W6.4 After load: ${tbNumbers.length} values`);
  }
});

// ─── WORKFLOW 7: VAT Return ──────────────────────────────────────────────────
test('W7: VAT Return', async ({ page }) => {
  await login(page);

  for (const vatUrl of [
    `${BASE}/accounting/reports/vat-return`,
    `${BASE}/accounting/vat-return`,
    `${BASE}/accounting/reports/vat`,
    `${BASE}/accounting/tax`,
  ]) {
    await page.goto(vatUrl);
    await page.waitForLoadState('networkidle');
    const body = await page.content();
    if (!body.includes('404') && (body.includes('VAT') || body.includes('vat') || body.includes('Tax Return'))) {
      console.log(`W7.1 Found VAT return at: ${vatUrl}`);
      break;
    }
    console.log(`W7.1 Not found at: ${vatUrl}`);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w7-01-vat-return.png' });

  const pageText = await page.innerText('body');
  const hasOutputVAT = pageText.includes('Output VAT') || pageText.includes('Output Tax') || pageText.includes('output');
  const hasInputVAT = pageText.includes('Input VAT') || pageText.includes('Input Tax') || pageText.includes('input');
  const hasNetVAT = pageText.includes('Net VAT') || pageText.includes('Net Tax') || pageText.includes('Payable') || pageText.includes('Refund');
  const hasVAT = pageText.includes('VAT') || pageText.includes('Value Added Tax');
  console.log(`W7.2 Output VAT: ${hasOutputVAT}, Input VAT: ${hasInputVAT}, Net VAT: ${hasNetVAT}, VAT: ${hasVAT}`);

  const numbers = pageText.match(/R[\s]?[\d,]+|[\d,]+\.\d{2}/g) || [];
  console.log(`W7.3 Found ${numbers.length} numeric values`);

  // Try to load/generate
  const loadBtn = page.locator('button:has-text("Generate"), button:has-text("Load"), button:has-text("Run"), button[type="submit"]').first();
  if (await loadBtn.count() > 0) {
    await loadBtn.click();
    await page.waitForTimeout(3000);
    await page.screenshot({ path: 'tests/e2e/screenshots/w7-02-vat-loaded.png' });
  }
});

// ─── WORKFLOW 8: Company Settings UDF ───────────────────────────────────────
test('W8: Company Settings UDF Tab', async ({ page }) => {
  await login(page);

  await page.goto(`${BASE}/accounting/company-settings`);
  await page.waitForLoadState('networkidle');
  const url = page.url();
  const body = await page.content();
  const loaded = !body.includes('404') && !body.includes('500');
  console.log(`W8.1 Company settings: ${url}, loaded=${loaded}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w8-01-company-settings.png' });

  const pageText = await page.innerText('body');
  const hasSettings = pageText.includes('Settings') || pageText.includes('Company');
  console.log(`W8.2 Settings page content: ${hasSettings}`);

  // Look for UDF / User Fields tab
  const udfTab = page.locator('button:has-text("UDF"), button:has-text("User Fields"), button:has-text("Custom Fields"), a:has-text("UDF"), a:has-text("User Fields"), [role="tab"]:has-text("UDF"), [role="tab"]:has-text("User Fields")').first();
  const hasUdfTab = await udfTab.count() > 0;
  console.log(`W8.3 UDF tab found: ${hasUdfTab}`);

  if (hasUdfTab) {
    await udfTab.click();
    await page.waitForTimeout(1000);
    await page.screenshot({ path: 'tests/e2e/screenshots/w8-02-udf-tab.png' });

    const udfText = await page.innerText('body');
    const hasUdfContent = udfText.includes('Field') || udfText.includes('field') || udfText.includes('UDF');
    const hasError = udfText.includes('Error') || udfText.includes('500');
    console.log(`W8.4 UDF tab content: ${hasUdfContent}, error: ${hasError}`);
  } else {
    // List all tabs available
    const tabs = page.locator('[role="tab"], .tab-item, button.tab');
    const tabCount = await tabs.count();
    const tabTexts: string[] = [];
    for (let i = 0; i < tabCount; i++) {
      tabTexts.push(await tabs.nth(i).innerText());
    }
    console.log(`W8.3 Available tabs (${tabCount}): ${tabTexts.join(', ')}`);
    await page.screenshot({ path: 'tests/e2e/screenshots/w8-02-no-udf-tab.png' });
  }
});
