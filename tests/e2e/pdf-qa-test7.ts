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

  // ─── QUOTES: Fill the modal form and create a quote ─────────────
  console.log('\n=== Quotes: Create via modal ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);

  // Click "New Quote"
  await page.click('button:has-text("New Quote")');
  await page.waitForTimeout(2000);
  await ss(page, '02b-quote-modal-open');

  // Select a customer using the SELECT element (index 0 is the customer select, since search input is first)
  const selects = await page.$$('select');
  console.log('Selects found:', selects.length);

  if (selects.length > 0) {
    // First select should be the customer dropdown
    const opts = await page.evaluate((el: any) =>
      Array.from(el.options).map((o: any) => ({ v: o.value, t: o.text })), selects[0]);
    console.log('Customer select options (first 5):', JSON.stringify(opts.slice(0, 5)));

    // Select Herotel (Pty) Ltd
    const herotelOpt = opts.find((o: any) => o.t.includes('Herotel'));
    if (herotelOpt) {
      await selects[0].selectOption({ value: herotelOpt.v });
      console.log('Selected Herotel');
    } else if (opts.length > 1) {
      await selects[0].selectOption({ index: 1 });
      console.log('Selected first non-empty option');
    }
    await page.waitForTimeout(1000);
  }

  // Fill item description
  const descInput = await page.$('input[placeholder="Item description"]');
  if (descInput) {
    await descInput.fill('Fibre Installation Services');
    console.log('Filled description');
  }

  // Fill quantity (number inputs)
  const numberInputs = await page.$$('input[type="number"]');
  console.log('Number inputs found:', numberInputs.length);
  if (numberInputs.length > 0) {
    await numberInputs[0].fill('');
    await numberInputs[0].type('5');
    console.log('Filled qty');
  }
  if (numberInputs.length > 1) {
    await numberInputs[1].fill('');
    await numberInputs[1].type('2500');
    console.log('Filled unit price');
  }

  await ss(page, '02c-quote-form-filled');

  // Find and click Save/Create Quote
  const createBtn = await page.$('button:has-text("Create Quote"), button:has-text("Save Quote"), button:has-text("Save"), button[type="submit"]');
  if (createBtn) {
    const btnText = await createBtn.textContent();
    console.log('Found create button:', btnText?.trim());
    await createBtn.click();
    await page.waitForTimeout(4000);
    await ss(page, '02d-after-quote-create');
    console.log('URL after quote create:', page.url());

    // Check for success - count quotes
    const pageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.log('Page after create:', pageText.substring(0, 800));

    // If we're on a quote detail page or the list now shows 1 quote
    const quotePdfBtn = await page.$('button:has-text("Download PDF"), button:has-text("PDF"), [title*="PDF"], [aria-label*="PDF"]');
    if (quotePdfBtn) {
      console.log('Found PDF button on quote detail!');
      const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
      await quotePdfBtn.click();
      await page.waitForTimeout(3000);
      const download = await downloadPromise;
      if (download) {
        const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
        await download.saveAs(dlPath);
        console.log('Quote PDF downloaded!');
        await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
      }
    } else {
      // Maybe we're back at the list — find the new quote row and click its PDF icon
      console.log('Looking for PDF icon in quotes list...');
      const pdfIcons = await page.$$('button svg, button[title], [aria-label]');
      console.log('PDF icon candidates:', pdfIcons.length);

      // Look for any download icon button in the table
      const quoteRows = await page.$$('tbody tr');
      console.log('Quote rows:', quoteRows.length);
      if (quoteRows.length > 0) {
        // Click the first quote row to open detail
        await quoteRows[0].click();
        await page.waitForTimeout(3000);
        await ss(page, '02e-quote-detail');
        console.log('Quote detail URL:', page.url());

        const pdfBtn2 = await page.$('button:has-text("Download PDF"), button:has-text("PDF")');
        if (pdfBtn2) {
          const downloadPromise2 = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
          await pdfBtn2.click();
          await page.waitForTimeout(3000);
          const dl2 = await downloadPromise2;
          if (dl2) {
            const dlPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
            await dl2.saveAs(dlPath);
            console.log('Quote PDF downloaded from detail!');
            await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
          } else {
            await ss(page, '02f-after-quote-pdf-click');
          }
        } else {
          console.log('No PDF button on quote detail');
          const detailText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
          console.log('Quote detail text:', detailText.substring(0, 1000));
        }
      }
    }
  } else {
    console.log('No Create button found');
    const allBtns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim())
    );
    console.log('All buttons:', allBtns);
  }

  // ─── View statement PDF render ────────────────────────────────────
  console.log('\n=== Statement PDF render check ===');
  const stmtPdfRenders = fs.readdirSync(SCREENSHOTS_DIR).filter(f => f.startsWith('statement-pdf-render'));
  console.log('Statement PDF renders:', stmtPdfRenders);

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
