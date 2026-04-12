import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/tests/e2e/screenshots/pdf-qa';
const BASE_URL = 'https://app.isaflow.co.za';

async function login(page: any) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(2000);

  // Check if already logged in
  const url = page.url();
  if (url.includes('/accounting') || url.includes('/dashboard')) {
    console.log('Already logged in');
    return;
  }

  await page.fill('input[type="email"]', 'admin@isaflow.co.za');
  await page.fill('input[type="password"]', 'admin123');
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
  console.log('Logged in, URL:', page.url());
}

async function screenshot(page: any, name: string) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot saved: ${filepath}`);
  return filepath;
}

async function main() {
  fs.mkdirSync(SCREENSHOTS_DIR, { recursive: true });

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });

  const context = await browser.newContext({
    viewport: { width: 1400, height: 900 },
    acceptDownloads: true,
  });

  const page = await context.newPage();

  // ─── LOGIN ───────────────────────────────────────────────────────
  console.log('\n=== STEP 0: Login ===');
  await login(page);
  await screenshot(page, '00-login-result');

  // ─── STEP 1: Customer Invoices PDF ──────────────────────────────
  console.log('\n=== STEP 1: Customer Invoice PDF ===');
  await page.goto(`${BASE_URL}/accounting/customer-invoices`);
  await page.waitForTimeout(3000);
  await screenshot(page, '01-invoice-list');

  // Get page text to find invoices
  const invoicePageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Invoice page content (first 1000 chars):', invoicePageText.substring(0, 1000));

  // Try to click on the first invoice row
  const invoiceRow = await page.$('table tbody tr:first-child') || await page.$('[data-testid="invoice-row"]:first-child');
  if (invoiceRow) {
    await invoiceRow.click();
    await page.waitForTimeout(3000);
    await screenshot(page, '01b-invoice-detail');
    console.log('Clicked invoice row, URL:', page.url());

    // Look for Download PDF button
    const pdfBtn = await page.$('button:has-text("Download PDF"), a:has-text("Download PDF"), button:has-text("PDF"), a:has-text("PDF")');
    if (pdfBtn) {
      console.log('Found PDF button!');

      // Set up download handler
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

      await pdfBtn.click();
      await page.waitForTimeout(2000);

      const download = await downloadPromise;
      const newTab = await newPagePromise;

      if (download) {
        const downloadPath = path.join(SCREENSHOTS_DIR, 'invoice.pdf');
        await download.saveAs(downloadPath);
        console.log('PDF downloaded to:', downloadPath);

        // Convert first page of PDF to image using convert command
        try {
          const { execSync } = require('child_process');
          execSync(`convert -density 150 "${downloadPath}[0]" "${SCREENSHOTS_DIR}/invoice-pdf-page1.png"`, { timeout: 30000 });
          console.log('PDF converted to image');
        } catch (e: any) {
          console.log('PDF conversion failed (ImageMagick not available):', e.message);
        }
      } else if (newTab) {
        console.log('PDF opened in new tab:', newTab.url());
        await newTab.waitForTimeout(3000);
        await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '01c-invoice-pdf-tab.png'), fullPage: true });
        await newTab.close();
      } else {
        await screenshot(page, '01c-after-pdf-click');
        console.log('No download or new tab detected after PDF click');
      }
    } else {
      console.log('PDF button NOT found on invoice detail page');
      const buttons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a')).map(el => el.textContent?.trim()).filter(t => t && t.length < 50)
      );
      console.log('Available buttons/links:', buttons.slice(0, 20));
      await screenshot(page, '01c-invoice-detail-no-pdf-btn');
    }
  } else {
    console.log('No invoice rows found in table');
    // Try clicking any clickable row
    const anyRow = await page.$('tr.cursor-pointer, tr[role="button"], tbody tr');
    if (anyRow) {
      await anyRow.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '01b-invoice-detail-fallback');
    }
  }

  // ─── STEP 2: Customer Quotes PDF ────────────────────────────────
  console.log('\n=== STEP 2: Customer Quotes PDF ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);
  await screenshot(page, '02-quotes-list');

  const quotesPageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log('Quotes page content:', quotesPageText.substring(0, 800));

  // Look for PDF download icons in the actions column
  const quotePdfIcons = await page.$$('button[title*="PDF"], button[title*="pdf"], button[aria-label*="PDF"], [title*="Download PDF"]');
  console.log(`Found ${quotePdfIcons.length} PDF icons on quotes page`);

  if (quotePdfIcons.length > 0) {
    const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
    const newPagePromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);
    await quotePdfIcons[0].click();
    await page.waitForTimeout(2000);

    const download = await downloadPromise;
    const newTab = await newPagePromise;

    if (download) {
      const downloadPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
      await download.saveAs(downloadPath);
      console.log('Quote PDF downloaded to:', downloadPath);
      try {
        const { execSync } = require('child_process');
        execSync(`convert -density 150 "${downloadPath}[0]" "${SCREENSHOTS_DIR}/quote-pdf-page1.png"`, { timeout: 30000 });
      } catch (e: any) {
        console.log('Quote PDF conversion failed:', e.message);
      }
    } else if (newTab) {
      await newTab.waitForTimeout(3000);
      await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '02b-quote-pdf-tab.png'), fullPage: true });
      await newTab.close();
    } else {
      await screenshot(page, '02b-after-quote-pdf-click');
    }
  } else {
    // Try clicking a row to open detail
    const quoteRow = await page.$('table tbody tr:first-child, tr.cursor-pointer');
    if (quoteRow) {
      await quoteRow.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '02b-quote-detail');
      console.log('Quote detail URL:', page.url());

      const pdfBtn = await page.$('button:has-text("PDF"), a:has-text("PDF"), button:has-text("Download")');
      if (pdfBtn) {
        const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
        await pdfBtn.click();
        await page.waitForTimeout(3000);
        const download = await downloadPromise;
        if (download) {
          const downloadPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
          await download.saveAs(downloadPath);
          console.log('Quote PDF downloaded');
        }
        await screenshot(page, '02c-after-quote-pdf-click');
      }
    }
  }

  // ─── STEP 3: Statement Run ───────────────────────────────────────
  console.log('\n=== STEP 3: Statement Run PDF ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);
  await screenshot(page, '03-statement-run');

  const stmtPageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Statement run content:', stmtPageText.substring(0, 1000));

  // ─── STEP 4: Record Payment flow ────────────────────────────────
  console.log('\n=== STEP 4: Record Payment flow ===');
  await page.goto(`${BASE_URL}/accounting/customer-invoices`);
  await page.waitForTimeout(3000);

  // Find an invoice with Approved/Sent/Overdue status
  const statusText = await page.evaluate(() => document.body.innerText);
  console.log('Looking for Approved/Sent/Overdue invoices...');

  // Click first invoice to see its detail
  const firstRow = await page.$('table tbody tr:first-child, tr.cursor-pointer');
  if (firstRow) {
    await firstRow.click();
    await page.waitForTimeout(3000);
    await screenshot(page, '04-invoice-detail-for-payment');
    console.log('Invoice detail URL:', page.url());

    // Check for Record Payment button
    const recordPaymentBtn = await page.$('button:has-text("Record Payment"), a:has-text("Record Payment"), button:has-text("Payment")');
    if (recordPaymentBtn) {
      console.log('FOUND Record Payment button!');
      await recordPaymentBtn.click();
      await page.waitForTimeout(3000);
      await screenshot(page, '04b-record-payment-page');
      console.log('Record Payment URL:', page.url());

      // Check for pre-filled fields
      const pageContent = await page.evaluate(() => document.body.innerText.substring(0, 3000));
      console.log('Payment page content:', pageContent.substring(0, 1000));
    } else {
      console.log('Record Payment button NOT found');
      const allButtons = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a[href]')).map(el => ({
          text: el.textContent?.trim(),
          href: (el as HTMLAnchorElement).href || null
        })).filter(b => b.text && b.text.length < 60)
      );
      console.log('All buttons on page:', JSON.stringify(allButtons.slice(0, 25), null, 2));
    }
  }

  console.log('\n=== All screenshots saved to:', SCREENSHOTS_DIR, '===');
  await browser.close();
}

main().catch(console.error);
