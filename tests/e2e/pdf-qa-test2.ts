import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/tests/e2e/screenshots/pdf-qa';
const BASE_URL = 'https://app.isaflow.co.za';

async function login(page: any) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(2000);
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

async function ss(page: any, name: string) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
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

  // LOGIN
  await login(page);

  // ─── STEP 1: Invoice Detail Page ────────────────────────────────
  console.log('\n=== STEP 1: Invoice Detail ===');
  // Use INV-00559 (approved status - good candidate for payment)
  const invoiceId = 'f5d4e726-70d1-4864-90a7-9645f0fc61c6';
  await page.goto(`${BASE_URL}/accounting/customer-invoices/${invoiceId}`);
  await page.waitForTimeout(4000);
  await ss(page, '01-invoice-detail');
  console.log('Invoice detail URL:', page.url());

  // Log all text to find button names
  const detailText = await page.evaluate(() => document.body.innerText.substring(0, 4000));
  console.log('Invoice detail page text (2000 chars):', detailText.substring(0, 2000));

  // Log all interactive elements
  const buttons = await page.evaluate(() =>
    Array.from(document.querySelectorAll('button, a[href]')).map(el => ({
      tag: el.tagName,
      text: el.textContent?.trim()?.substring(0, 60),
      href: (el as HTMLAnchorElement).href || null,
      classes: el.className?.substring(0, 80)
    })).filter(b => b.text && b.text.length > 0 && b.text.length < 60)
  );
  console.log('All interactive elements:', JSON.stringify(buttons, null, 2));

  // ─── Look for PDF download ────────────────────────────────────
  // Try various selectors
  const pdfSelectors = [
    'button:has-text("Download PDF")',
    'button:has-text("PDF")',
    'a:has-text("PDF")',
    'button:has-text("Download")',
    '[aria-label*="PDF"]',
    '[title*="PDF"]',
    'button[title*="pdf"]',
    'svg[class*="pdf"]',
  ];

  let pdfFound = false;
  for (const sel of pdfSelectors) {
    const el = await page.$(sel);
    if (el) {
      console.log(`Found PDF element with selector: ${sel}`);
      pdfFound = true;

      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      const newPagePromise = context.waitForEvent('page', { timeout: 8000 }).catch(() => null);

      await el.click();
      await page.waitForTimeout(3000);

      const [download, newTab] = await Promise.all([downloadPromise, newPagePromise]);

      if (download) {
        const downloadPath = path.join(SCREENSHOTS_DIR, 'invoice.pdf');
        await download.saveAs(downloadPath);
        console.log('Invoice PDF downloaded to:', downloadPath);

        // Try to render PDF page to image
        try {
          execSync(`pdftoppm -r 150 -png "${downloadPath}" "${SCREENSHOTS_DIR}/invoice-pdf-render"`, { timeout: 30000 });
          console.log('PDF rendered via pdftoppm');
        } catch {
          try {
            execSync(`convert -density 150 "${downloadPath}[0]" "${SCREENSHOTS_DIR}/invoice-pdf-page1.png"`, { timeout: 30000 });
            console.log('PDF rendered via ImageMagick');
          } catch (e2: any) {
            console.log('Could not render PDF to image:', e2.message);
          }
        }
      } else if (newTab) {
        console.log('PDF opened in new tab:', newTab.url());
        await newTab.waitForTimeout(4000);
        await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '01b-invoice-pdf-tab.png'), fullPage: false });
        await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '01b-invoice-pdf-tab-full.png'), fullPage: true });
        console.log('New tab screenshot taken');
        await newTab.close();
      } else {
        await ss(page, '01b-after-pdf-click');
        console.log('No download or new tab — checking current page');
      }
      break;
    }
  }

  if (!pdfFound) {
    console.log('NO PDF BUTTON FOUND on invoice detail page');
    await ss(page, '01b-invoice-no-pdf');
  }

  // Check for Record Payment button on same page
  console.log('\n=== STEP 4 (inline): Record Payment button check ===');
  const paymentSelectors = [
    'button:has-text("Record Payment")',
    'button:has-text("Record")',
    'a:has-text("Record Payment")',
    'button:has-text("Payment")',
    '[href*="customer-payments/new"]',
  ];

  let paymentFound = false;
  for (const sel of paymentSelectors) {
    const el = await page.$(sel);
    if (el) {
      const text = await el.textContent();
      const href = await el.getAttribute('href');
      console.log(`Found payment element: "${text}" (href=${href}) with selector: ${sel}`);
      paymentFound = true;

      // Click it and observe
      await el.click();
      await page.waitForTimeout(3000);
      await ss(page, '04-record-payment-result');
      console.log('After payment click URL:', page.url());

      const paymentPageText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
      console.log('Payment page text:', paymentPageText.substring(0, 1500));
      break;
    }
  }

  if (!paymentFound) {
    console.log('No Record Payment button found on invoice detail page');
  }

  // ─── STEP 2: Quotes ─────────────────────────────────────────────
  console.log('\n=== STEP 2: Quotes (demo has 0 quotes - check page) ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);
  await ss(page, '02-quotes-list');
  const quotesText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log('Quotes page:', quotesText.substring(0, 800));

  // ─── STEP 3: Statement Run ───────────────────────────────────────
  console.log('\n=== STEP 3: Statement Run ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);
  await ss(page, '03-statement-run');

  // Select first customer (checkbox)
  const checkbox = await page.$('table tbody tr:first-child input[type="checkbox"], tbody tr:first-child input[type="checkbox"]');
  if (checkbox) {
    await checkbox.click();
    await page.waitForTimeout(1000);
    await ss(page, '03b-statement-customer-selected');

    // Click Generate
    const generateBtn = await page.$('button:has-text("Generate")');
    if (generateBtn) {
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const newPagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);

      await generateBtn.click();
      await page.waitForTimeout(4000);

      const [download, newTab] = await Promise.all([downloadPromise, newPagePromise]);

      if (download) {
        const downloadPath = path.join(SCREENSHOTS_DIR, 'statement.pdf');
        await download.saveAs(downloadPath);
        console.log('Statement PDF downloaded:', downloadPath);

        try {
          execSync(`pdftoppm -r 150 -png "${downloadPath}" "${SCREENSHOTS_DIR}/statement-pdf-render"`, { timeout: 30000 });
        } catch {
          try {
            execSync(`convert -density 150 "${downloadPath}[0]" "${SCREENSHOTS_DIR}/statement-pdf-page1.png"`, { timeout: 30000 });
          } catch (e: any) {
            console.log('Could not render statement PDF:', e.message);
          }
        }
      } else if (newTab) {
        await newTab.waitForTimeout(4000);
        await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '03c-statement-pdf-tab.png'), fullPage: false });
        await newTab.close();
      } else {
        await ss(page, '03c-after-generate-click');
      }
    }
  } else {
    console.log('No checkbox found on statement run page');
    // Try clicking the first row directly
    const firstRow = await page.$('table tbody tr:first-child');
    if (firstRow) {
      await firstRow.click();
      await page.waitForTimeout(1000);
      await ss(page, '03b-statement-row-clicked');
    }
  }

  await ss(page, '03-statement-final');

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
