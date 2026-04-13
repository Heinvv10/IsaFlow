import { chromium } from 'playwright';
import * as fs from 'fs';
import * as path from 'path';
import { execSync } from 'child_process';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/tests/e2e/screenshots/pdf-qa';
const BASE_URL = 'https://app.isaflow.co.za';

async function login(page: any) {
  await page.goto(`${BASE_URL}/login`);
  await page.waitForTimeout(2000);
  if (page.url().includes('/accounting')) return;
  await page.fill('input[type="email"]', 'admin@isaflow.co.za');
  await page.fill('input[type="password"]', 'admin123');
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

  // ─── QUOTES: Create via modal, force JS click ────────────────────
  console.log('\n=== Quotes: Create via modal (JS click) ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);

  // Click "New Quote"
  await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'New Quote');
    if (btn) btn.click();
  });
  await page.waitForTimeout(2000);
  await ss(page, '02b-quote-modal-open');

  // Select Herotel
  const selects = await page.$$('select');
  if (selects.length > 0) {
    const opts = await page.evaluate((el: any) =>
      Array.from(el.options).map((o: any) => ({ v: o.value, t: o.text })), selects[0]);
    const herotel = opts.find((o: any) => o.t.includes('Herotel'));
    if (herotel) {
      await selects[0].selectOption({ value: herotel.v });
      console.log('Selected Herotel');
    } else {
      await selects[0].selectOption({ index: 1 });
    }
  }

  // Fill description
  const descInput = await page.$('input[placeholder="Item description"]');
  if (descInput) await descInput.fill('Fibre Installation Services');

  // Fill qty and price
  const numInputs = await page.$$('input[type="number"]');
  if (numInputs.length > 0) {
    await numInputs[0].triple_click?.() ?? await numInputs[0].click({ clickCount: 3 });
    await numInputs[0].type('5');
  }
  if (numInputs.length > 1) {
    await numInputs[1].click({ clickCount: 3 });
    await numInputs[1].type('2500');
  }

  await page.waitForTimeout(500);
  await ss(page, '02c-quote-filled');

  // Use JS click to bypass overlay interception
  const clicked = await page.evaluate(() => {
    const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.trim() === 'Create Quote');
    if (btn) {
      btn.click();
      return true;
    }
    return false;
  });
  console.log('Create Quote JS click:', clicked);
  await page.waitForTimeout(4000);
  await ss(page, '02d-after-create-quote');
  console.log('URL after create:', page.url());

  const afterCreateText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log('After create text:', afterCreateText.substring(0, 800));

  // Check if we now have quotes in the list
  const quoteRows = await page.$$('tbody tr');
  console.log('Quote rows after create:', quoteRows.length);

  if (quoteRows.length > 0) {
    // Click the first quote row to go to detail
    await quoteRows[0].click();
    await page.waitForTimeout(3000);
    await ss(page, '02e-quote-detail');
    console.log('Quote detail URL:', page.url());

    const detailText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    console.log('Quote detail text:', detailText.substring(0, 1000));

    // Look for PDF button
    const pdfBtn = await page.$('button:has-text("Download PDF"), button:has-text("PDF"), a:has-text("PDF")');
    if (pdfBtn) {
      console.log('Found PDF button on quote detail!');
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await pdfBtn.click();
      await page.waitForTimeout(4000);
      const download = await downloadPromise;
      if (download) {
        const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
        await download.saveAs(dlPath);
        console.log('Quote PDF downloaded!');
        await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
      } else {
        await ss(page, '02f-after-pdf-click-no-download');
      }
    } else {
      console.log('No PDF button on quote detail page');
      // Check all buttons
      const allBtns = await page.evaluate(() =>
        Array.from(document.querySelectorAll('button, a')).map(el => el.textContent?.trim()).filter(t => t && t.length < 60)
      );
      console.log('All buttons on quote detail:', allBtns);
    }
  } else {
    // Maybe modal form had validation error - check for inline quote detail
    const quoteLinks = await page.$$('a[href*="customer-quotes/"]');
    console.log('Quote links found:', quoteLinks.length);
    if (quoteLinks.length > 0) {
      await quoteLinks[0].click();
      await page.waitForTimeout(3000);
      await ss(page, '02e-quote-detail-via-link');
    }
  }

  console.log('\n=== All done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
