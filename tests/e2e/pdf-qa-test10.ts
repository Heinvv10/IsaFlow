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

  // Get the real Herotel clientId from customers API
  console.log('\n=== Get real Herotel client ID ===');
  const clientsResp = await page.evaluate(async () => {
    const r = await fetch('/api/accounting/customers?limit=20');
    const j = await r.json();
    return j;
  });
  console.log('Customers API:', JSON.stringify(clientsResp).substring(0, 1000));

  let herotelId: string | null = null;
  if (clientsResp?.data) {
    const customers = Array.isArray(clientsResp.data) ? clientsResp.data : clientsResp.data.customers || clientsResp.data.items || [];
    const herotel = customers.find((c: any) => c.name?.includes('Herotel') || c.customerName?.includes('Herotel'));
    herotelId = herotel?.id || null;
    console.log('Herotel:', herotel);
  }

  // Also try the quote form UI approach - look at what data the form uses
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);

  // Click New Quote to open form
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'New Quote');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);

  // Get the actual Herotel value from the select
  const herotelValue = await page.evaluate(() => {
    const select = document.querySelector('select');
    if (!select) return null;
    const opt = Array.from((select as HTMLSelectElement).options).find(o => o.text.includes('Herotel'));
    return opt ? opt.value : null;
  });
  console.log('Herotel value from form select:', herotelValue);

  // Close the modal (press Escape)
  await page.keyboard.press('Escape');
  await page.waitForTimeout(500);

  // Create quote using the actual clientId from form
  const actualClientId = herotelValue || herotelId;
  console.log('Using clientId:', actualClientId);

  if (actualClientId) {
    const quoteResult = await page.evaluate(async (clientId: string) => {
      const resp = await fetch('/api/accounting/customer-quotes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          customerName: 'Herotel (Pty) Ltd',
          clientId,
          quoteDate: '2026-04-12',
          expiryDate: '2026-05-12',
          notes: 'QA Test Quote - PDF Design Evaluation',
          lines: [
            { description: 'Fibre Installation Services', quantity: 5, unitPrice: 2500, taxRate: 15 },
            { description: 'Network Equipment Supply', quantity: 2, unitPrice: 8000, taxRate: 15 },
          ],
        }),
      });
      const json = await resp.json();
      return { status: resp.status, body: json };
    }, actualClientId);

    console.log('Quote create status:', quoteResult.status);
    console.log('Quote create body:', JSON.stringify(quoteResult.body).substring(0, 500));

    const quoteId = quoteResult.body?.data?.id || quoteResult.body?.id;

    if (quoteId) {
      console.log('Created quote ID:', quoteId);

      // Download the PDF directly
      const pdfUrl = `${BASE_URL}/api/accounting/quote-pdf?quoteId=${quoteId}`;
      console.log('Fetching PDF from:', pdfUrl);

      const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
      await page.goto(pdfUrl);
      await page.waitForTimeout(5000);

      const download = await downloadPromise;
      if (download) {
        const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
        await download.saveAs(dlPath);
        console.log('Quote PDF downloaded!');
        await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
      } else {
        console.log('No download from PDF URL — checking page');
        await ss(page, '02h-quote-pdf-direct');

        // Check current URL and content
        const pdfPageUrl = page.url();
        console.log('PDF page URL:', pdfPageUrl);

        // Try fetching as blob
        const pdfBytes = await page.evaluate(async (url: string) => {
          const r = await fetch(url);
          const ab = await r.arrayBuffer();
          return { status: r.status, contentType: r.headers.get('content-type'), size: ab.byteLength };
        }, pdfUrl);
        console.log('PDF fetch result:', pdfBytes);
      }

      // Also check the quotes list page
      await page.goto(`${BASE_URL}/accounting/customer-quotes`);
      await page.waitForTimeout(3000);
      await ss(page, '02i-quotes-list-with-quote');
    } else {
      console.log('No quote ID in response — error details:');

      // Try with just customerName (no clientId)
      const quoteResult2 = await page.evaluate(async () => {
        const resp = await fetch('/api/accounting/customer-quotes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            customerName: 'Test Customer',
            quoteDate: '2026-04-12',
            lines: [
              { description: 'Test Service', quantity: 1, unitPrice: 1000, taxRate: 15 },
            ],
          }),
        });
        const json = await resp.json();
        return { status: resp.status, body: json };
      });
      console.log('Quote create without clientId:', JSON.stringify(quoteResult2).substring(0, 500));
    }
  }

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
