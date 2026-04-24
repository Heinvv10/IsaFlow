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

  // Intercept network to capture detailed error
  page.on('response', async (response: any) => {
    const url = response.url();
    if (url.includes('customer-quotes') && !url.includes('.js') && !url.includes('.css')) {
      const status = response.status();
      let body = '';
      try {
        body = await response.text();
      } catch {}
      console.log(`API Response [${status}] ${url}: ${body.substring(0, 300)}`);
    }
  });

  // Try creating the quote via UI one more time - using the form and capturing network
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);

  // Open modal
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'New Quote');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);

  // Select Herotel
  const selects = await page.$$('select');
  if (selects.length > 0) {
    const opts = await page.evaluate((el: any) =>
      Array.from(el.options).map((o: any) => ({ v: o.value, t: o.text })), selects[0]);
    const herotel = opts.find((o: any) => o.t.includes('Herotel'));
    if (herotel) {
      await selects[0].selectOption({ value: herotel.v });
    }
  }

  // Fill description
  const descInput = await page.$('input[placeholder="Item description"]');
  if (descInput) {
    await descInput.click({ clickCount: 3 });
    await descInput.fill('Fibre Installation Services');
  }

  // Fill qty
  const numInputs = await page.$$('input[type="number"]');
  if (numInputs.length > 0) {
    await numInputs[0].click({ clickCount: 3 });
    await numInputs[0].fill('1');
  }
  if (numInputs.length > 1) {
    await numInputs[1].click({ clickCount: 3 });
    await numInputs[1].fill('5000');
  }

  await page.waitForTimeout(500);
  await ss(page, '02c-quote-filled-v2');

  // Submit via JS click
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Create Quote') && !b.disabled);
    if (btn) {
      console.log('Clicking Create Quote:', btn.textContent);
      btn.click();
    } else {
      const allBtns = Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim());
      console.log('Available buttons:', allBtns);
    }
  });

  await page.waitForTimeout(5000);
  await ss(page, '02d-after-create-v2');

  const afterText = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  console.log('After create text:', afterText.substring(0, 500));

  // Check quote count
  const quoteCountText = afterText.match(/(\d+) quotes?/);
  console.log('Quote count:', quoteCountText?.[0]);

  // Try direct quote-pdf for any existing quotes
  const existingQuotes = await page.evaluate(async () => {
    const r = await fetch('/api/accounting/customer-quotes');
    const j = await r.json();
    return j;
  });
  console.log('Existing quotes:', JSON.stringify(existingQuotes).substring(0, 500));

  if (existingQuotes?.data?.quotes?.length > 0 || existingQuotes?.data?.length > 0) {
    const quotes = existingQuotes.data?.quotes || existingQuotes.data;
    const firstQuote = Array.isArray(quotes) ? quotes[0] : null;
    if (firstQuote) {
      console.log('First quote:', JSON.stringify(firstQuote).substring(0, 200));

      // Navigate to the quote-pdf API
      const pdfUrl = `${BASE_URL}/api/accounting/quote-pdf?quoteId=${firstQuote.id}`;
      console.log('Fetching PDF:', pdfUrl);

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
        await ss(page, '02e-quote-pdf-nav-result');
        console.log('URL after PDF nav:', page.url());
        const pdfPageText = await page.evaluate(() => document.body.innerText.substring(0, 300));
        console.log('PDF page text:', pdfPageText);
      }
    }
  } else {
    console.log('No quotes found in API response');
    console.log('Full quotes API response:', JSON.stringify(existingQuotes).substring(0, 800));
  }

  console.log('\n=== Done ===');
  await browser.close();
}

main().catch(console.error);
