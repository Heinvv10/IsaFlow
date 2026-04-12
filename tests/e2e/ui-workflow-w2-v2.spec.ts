import { test } from '@playwright/test';

const BASE = 'https://app.isaflow.co.za';
const TEST_INVOICE_ID = '2e397b8f-c0ae-4fbc-8c48-49ad47f568a3';

test('W2: Invoice detail direct URL + Record Payment check', async ({ page }) => {
  // Navigate directly to invoice detail
  await page.goto(`${BASE}/accounting/customer-invoices/${TEST_INVOICE_ID}`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(2000);
  console.log(`Invoice detail URL: ${page.url()}`);
  await page.screenshot({ path: 'tests/e2e/screenshots/w2-v2-invoice-detail.png', fullPage: true });

  const allBtns = await page.locator('button').allInnerTexts();
  console.log('All buttons:', allBtns.filter(t => t.trim()).join(' | '));

  const bodyText = await page.innerText('body');
  const hasRecordPayment = bodyText.includes('Record Payment') || bodyText.includes('record payment');
  const hasPDF = bodyText.includes('Download PDF') || bodyText.includes('PDF');
  const hasApprove = bodyText.includes('Approve');
  const hasStatus = bodyText.includes('draft') || bodyText.includes('Draft');
  console.log(`Status=draft: ${hasStatus}, Record Payment: ${hasRecordPayment}, PDF: ${hasPDF}, Approve: ${hasApprove}`);

  // If there's an Approve button, click it first to get to a payable state
  const approveBtn = page.locator('button:has-text("Approve")').first();
  if (await approveBtn.count() > 0 && !hasRecordPayment) {
    console.log('Clicking Approve first...');
    await approveBtn.click();
    await page.waitForTimeout(2000);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-v2-after-approve.png' });
    const newBtns = await page.locator('button').allInnerTexts();
    console.log('Buttons after approve:', newBtns.filter(t => t.trim()).join(' | '));
  }

  // Look for Record Payment
  const recordBtn = page.locator('button:has-text("Record Payment")').first();
  if (await recordBtn.count() > 0) {
    await recordBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-v2-payment-modal.png' });
    console.log(`Payment modal URL: ${page.url()}`);

    // Fill in payment amount
    const amountInput = page.locator('input[type="number"], input[placeholder*="amount" i]').first();
    if (await amountInput.count() > 0) {
      const currentVal = await amountInput.inputValue();
      console.log(`Payment amount prefilled: ${currentVal}`);
    }
  } else {
    console.log('FAIL: Record Payment button not found even after approve');
  }
});
