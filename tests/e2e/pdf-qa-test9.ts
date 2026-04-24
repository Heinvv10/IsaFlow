import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';
import { getE2ECredentials } from './_creds';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/tests/e2e/screenshots/pdf-qa';
const BASE_URL = 'https://app.isaflow.co.za';

async function login(page: any) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(2000);
  if (page.url().includes('/accounting')) return;
  const { email: _e2eEmail, password: _e2ePwd } = getE2ECredentials();
  await page.fill('input[type="email"]', _e2eEmail);
  await page.fill('input[type="password"]', _e2ePwd);
  await page.click('button[type="submit"]');
  await page.waitForTimeout(4000);
}

async function ss(page: any, name: string) {
  const filepath = path.join(SCREENSHOTS_DIR, `${name}.png`);
  await page.screenshot({ path: filepath, fullPage: true });
  console.log(`Screenshot: ${filepath}`);
}

async function renderPdf(pdfPath: string, outPrefix: string) {
  try {
    execSync(`pdftoppm -r 150 -png "${pdfPath}" "${outPrefix}"`, { timeout: 30000 });
    console.log('PDF rendered:', outPrefix);
    return true;
  } catch {
    try {
      execSync(`convert -density 150 "${pdfPath}[0]" "${outPrefix}-1.png"`, { timeout: 30000 });
      return true;
    } catch (e: any) {
      console.log('Could not render PDF:', e.message);
      return false;
    }
  }
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
  await login(page);

  // Create a quote via API call (within browser session - uses same auth cookies)
  console.log('\n=== Creating quote via API ===');
  const quoteResult = await page.evaluate(async () => {
    const herotelClientId = 'c1000000-0000-0000-0000-000000000008'; // from invoice record payment test

    const resp = await fetch('/api/accounting/customer-quotes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        customerName: 'Herotel (Pty) Ltd',
        clientId: herotelClientId,
        quoteDate: '2026-04-12',
        expiryDate: '2026-05-12',
        notes: 'QA Test Quote - PDF Design Evaluation',
        lines: [
          { description: 'Fibre Installation Services', quantity: 5, unitPrice: 2500, taxRate: 15 },
          { description: 'Network Equipment Supply', quantity: 2, unitPrice: 8000, taxRate: 15 },
          { description: 'Project Management', quantity: 10, unitPrice: 750, taxRate: 15 },
        ],
      }),
    });
    const json = await resp.json();
    return { status: resp.status, body: json };
  });
  console.log('Quote create result:', JSON.stringify(quoteResult).substring(0, 500));

  if (quoteResult.status === 200 || quoteResult.status === 201) {
    const quoteId = quoteResult.body?.data?.id || quoteResult.body?.id;
    console.log('Created quote ID:', quoteId);

    if (quoteId) {
      // Navigate to the quote list to see the PDF icon
      await page.goto(`${BASE_URL}/accounting/customer-quotes`);
      await page.waitForTimeout(3000);
      await ss(page, '02f-quotes-with-new-quote');

      // Download PDF via the API link directly
      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      const newTabPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);

      // Click the PDF download anchor for the first quote
      const pdfLink = await page.$(`a[href*="quote-pdf"], a[href*="${quoteId}"], a[title="Download PDF"]`);
      if (pdfLink) {
        const href = await pdfLink.getAttribute('href');
        console.log('PDF link href:', href);
        await pdfLink.click();
        await page.waitForTimeout(3000);

        const [download, newTab] = await Promise.all([downloadPromise, newTabPromise]);
        if (download) {
          const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
          await download.saveAs(dlPath);
          console.log('Quote PDF downloaded!');
          await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
        } else if (newTab) {
          console.log('Quote PDF opened in new tab:', newTab.url());
          await newTab.waitForTimeout(3000);
          await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '02g-quote-pdf-tab.png'), fullPage: false });
          await newTab.close();
        }
      } else {
        // Try navigating to the PDF URL directly
        const pdfUrl = `/api/accounting/quote-pdf?quoteId=${quoteId}`;
        console.log('Navigating directly to:', pdfUrl);
        const downloadPromise2 = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        await page.goto(`${BASE_URL}${pdfUrl}`);
        await page.waitForTimeout(4000);
        const dl2 = await downloadPromise2;
        if (dl2) {
          const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
          await dl2.saveAs(dlPath);
          console.log('Quote PDF downloaded via direct nav!');
          await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
        } else {
          await ss(page, '02g-quote-pdf-page');
          console.log('Direct PDF nav page URL:', page.url());
        }
      }
    }
  } else {
    console.log('Quote creation failed:', JSON.stringify(quoteResult));
  }

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
