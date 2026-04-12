/**
 * W2: Navigate to invoice detail via invoice number link and check Record Payment
 */
import { test } from '@playwright/test';

const BASE = 'https://app.isaflow.co.za';

test('W2: Invoice detail via link click', async ({ page }) => {
  await page.goto(`${BASE}/accounting/customer-invoices`);
  await page.waitForLoadState('networkidle');
  await page.waitForTimeout(1000);

  // Click the invoice number link (not the row)
  const invLink = page.locator('a[href*="customer-invoices/"], a:has-text("INV-")').first();
  const linkCount = await invLink.count();
  console.log(`Invoice links found: ${linkCount}`);

  if (linkCount > 0) {
    const href = await invLink.getAttribute('href');
    console.log(`Clicking invoice link: ${href}`);
    await invLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    console.log(`After click URL: ${page.url()}`);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-detail-via-link.png' });

    const bodyText = await page.innerText('body');
    const hasRecordPayment = bodyText.includes('Record Payment');
    const hasPDF = bodyText.includes('Download PDF') || bodyText.includes('PDF');
    const hasApprove = bodyText.includes('Approve');
    console.log(`Record Payment button: ${hasRecordPayment}`);
    console.log(`PDF button: ${hasPDF}`);
    console.log(`Approve button: ${hasApprove}`);

    // Try clicking Record Payment
    const payBtn = page.locator('button:has-text("Record Payment")').first();
    if (await payBtn.count() > 0) {
      await payBtn.click();
      await page.waitForTimeout(1500);
      await page.screenshot({ path: 'tests/e2e/screenshots/w2-record-payment-modal.png' });
      console.log(`After Record Payment click: ${page.url()}`);
    } else {
      console.log('FAIL: Record Payment button not found on invoice detail');
      // List all buttons on the page
      const allBtns = await page.locator('button').allInnerTexts();
      console.log('All buttons:', allBtns.join(' | '));
    }
  } else {
    // Direct navigation to known invoice
    await page.goto(`${BASE}/accounting/customer-invoices/2e397b8f-c0ae-4fbc-8c48-49ad47f568a3`);
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(1500);
    console.log(`Direct URL: ${page.url()}`);
    await page.screenshot({ path: 'tests/e2e/screenshots/w2-direct-invoice.png' });

    const allBtns = await page.locator('button').allInnerTexts();
    console.log('Buttons on detail:', allBtns.join(' | '));
  }
});
