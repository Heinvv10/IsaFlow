/**
 * Focused workflow tests for W1 (create invoice) and W2 (record payment)
 * These complete the full CRUD cycle with actual form submission
 */
import { test, expect, Page } from '@playwright/test';

const BASE = 'https://app.isaflow.co.za';

test('W1 FULL: Create customer invoice with 2 line items', async ({ page }) => {
  await page.goto(`${BASE}/accounting/customer-invoices/new`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Select client from the dropdown
  const clientSelect = page.locator('select').first();
  const optionCount = await clientSelect.locator('option').count();
  console.log(`Client dropdown options: ${optionCount}`);
  if (optionCount > 1) {
    await clientSelect.selectOption({ index: 1 });
    await page.waitForTimeout(500);
  }
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-full-01-client-selected.png' });

  // Fill first line item
  const descFields = page.locator('input[placeholder="Description *"]');
  const desc1 = descFields.first();
  await desc1.fill('Consulting Services - Q1 2026');

  // Fill unit price for first line item
  const priceInputs = page.locator('input[type="number"]');
  const priceCount = await priceInputs.count();
  console.log(`Number inputs found: ${priceCount}`);

  // Qty and unit price should be there
  // Typically: qty (default 1), unit price
  if (priceCount >= 2) {
    const unitPriceInput = priceInputs.nth(1); // usually qty is first, price second
    await unitPriceInput.fill('5000');
  } else if (priceCount === 1) {
    await priceInputs.first().fill('5000');
  }

  // Check subtotal updated
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-full-02-first-line.png' });

  // Add second line item
  const addLineBtn = page.locator('button:has-text("Add Line"), button:has-text("+ Add Line")').first();
  if (await addLineBtn.count() > 0) {
    await addLineBtn.click();
    await page.waitForTimeout(500);

    const allDescFields = page.locator('input[placeholder="Description *"]');
    const descCount = await allDescFields.count();
    console.log(`Description fields after add: ${descCount}`);

    if (descCount > 1) {
      await allDescFields.last().fill('Software License Annual');
      const allPriceInputs = page.locator('input[type="number"]');
      const allPriceCount = await allPriceInputs.count();
      // Second line's price - find the last unit price field
      if (allPriceCount >= 4) {
        await allPriceInputs.nth(allPriceCount - 1).fill('2500');
      }
    }
  }
  await page.waitForTimeout(500);
  await page.screenshot({ path: 'tests/e2e/screenshots/w1-full-03-two-lines.png' });

  // Read totals
  const bodyText = await page.innerText('body');
  const subtotalMatch = bodyText.match(/Subtotal[:\s]+R\s*([\d\s,]+)/i);
  const vatMatch = bodyText.match(/VAT[:\s]+R\s*([\d\s,]+)/i);
  const totalMatch = bodyText.match(/Total[:\s]+R\s*([\d\s,]+)/i);
  console.log(`Subtotal: ${subtotalMatch?.[1]?.trim()}`);
  console.log(`VAT: ${vatMatch?.[1]?.trim()}`);
  console.log(`Total: ${totalMatch?.[1]?.trim()}`);

  // Submit the invoice
  const createBtn = page.locator('button:has-text("Create Invoice"), button[type="submit"]').first();
  console.log(`Create button found: ${await createBtn.count() > 0}`);
  if (await createBtn.count() > 0) {
    await createBtn.click();
    await page.waitForTimeout(3000);
    const afterUrl = page.url();
    console.log(`After submit URL: ${afterUrl}`);
    await page.screenshot({ path: 'tests/e2e/screenshots/w1-full-04-after-create.png' });

    const afterText = await page.innerText('body');
    const isOnNewPage = !afterUrl.endsWith('/new');
    const hasError = afterText.includes('required') || afterText.includes('error') || afterText.includes('Error');
    console.log(`Navigated away from /new: ${isOnNewPage}, hasError: ${hasError}`);

    if (!isOnNewPage) {
      // Still on new page - check for validation errors
      const errorMsgs = await page.locator('.error, [class*="error"], [class*="invalid"], .text-red').allInnerTexts();
      console.log(`Validation errors: ${errorMsgs.join(', ')}`);
    }
  }
});

test('W2 FULL: Find invoice and check Record Payment button', async ({ page }) => {
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Click first invoice
  const rows = page.locator('table tbody tr');
  const rowCount = await rows.count();
  console.log(`Invoice rows: ${rowCount}`);

  if (rowCount > 0) {
    await rows.first().click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    const invoiceUrl = page.url();
    console.log(`Invoice detail URL: ${invoiceUrl}`);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-full-01-detail.png' });

    const bodyText = await page.innerText('body');
    // Check for payment-related buttons/actions
    const hasRecordPayment = bodyText.includes('Record Payment') || bodyText.includes('record payment');
    const hasPaymentSection = bodyText.includes('Payment') || bodyText.includes('payment');
    const hasPdfBtn = bodyText.includes('PDF') || bodyText.includes('Download');
    console.log(`Record Payment: ${hasRecordPayment}, Payment section: ${hasPaymentSection}, PDF: ${hasPdfBtn}`);

    // Look for any payment button
    const paymentBtns = page.locator('button, a').filter({ hasText: /payment|pay|PDF|download/i });
    const btnCount = await paymentBtns.count();
    console.log(`Payment/PDF buttons found: ${btnCount}`);
    const btnTexts: string[] = [];
    for (let i = 0; i < Math.min(btnCount, 5); i++) {
      btnTexts.push(await paymentBtns.nth(i).innerText());
    }
    console.log(`Button texts: ${btnTexts.join(' | ')}`);

    // Try clicking Record Payment if found
    const recordBtn = page.locator('button:has-text("Record Payment"), a:has-text("Record Payment"), button:has-text("Payment")').first();
    if (await recordBtn.count() > 0) {
      await recordBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'tests/e2e/screenshots/w2-full-02-payment-modal.png' });
      const afterClick = page.url();
      console.log(`After Record Payment click: ${afterClick}`);
    } else {
      console.log('Record Payment button NOT found on invoice detail page');
    }
  }
});

test('W5 FULL: Chart of Accounts navigation', async ({ page }) => {
  // CoA is under Accounts menu, not /chart-of-accounts directly
  await page.goto(`${BASE}/accounting`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Click Chart of Accounts tab
  const coaTab = page.locator('a:has-text("Chart of Accounts"), button:has-text("Chart of Accounts")').first();
  if (await coaTab.count() > 0) {
    await coaTab.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'tests/e2e/screenshots/w5-full-01-coa-tab.png' });
  }

  // Also navigate via URL
  await page.goto(`${BASE}/accounting?tab=accounts`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);
  await page.screenshot({ path: 'tests/e2e/screenshots/w5-full-02-coa-via-url.png' });

  const bodyText = await page.innerText('body');
  const hasCoA = bodyText.includes('Chart') || bodyText.includes('Account Code') || bodyText.includes('Account Name');
  console.log(`CoA content visible: ${hasCoA}`);

  // Count accounts
  const rows = await page.locator('table tbody tr').count();
  console.log(`CoA rows visible: ${rows}`);
});
