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

  // ─── STATEMENT: Click checkbox cell, then immediately Generate ───
  console.log('\n=== Statement: Select 1 customer + Generate ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);

  // Click the first row's first cell (checkbox button) - x:73, y:359 from previous run
  await page.mouse.click(73, 359);
  await page.waitForTimeout(800);

  // Verify selection
  const bodyText1 = await page.evaluate(() => document.body.innerText);
  const selectedMatch = bodyText1.match(/(\d+) selected/);
  console.log('After first cell click, selected:', selectedMatch?.[0]);

  await ss(page, '03e-statement-1-selected');

  // Click Generate immediately
  const genBtn = await page.$('button:has-text("Generate")');
  if (genBtn) {
    const isDisabled = await genBtn.evaluate((el: HTMLButtonElement) => el.disabled);
    console.log('Generate button disabled?', isDisabled);

    if (!isDisabled) {
      const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch((e: Error) => {
        console.log('Download timeout:', e.message);
        return null;
      });

      await genBtn.click();
      console.log('Clicked Generate');
      await page.waitForTimeout(8000);

      const download = await downloadPromise;
      if (download) {
        const dlPath = path.join(SCREENSHOTS_DIR, 'statement.pdf');
        await download.saveAs(dlPath);
        console.log('Statement PDF downloaded!', dlPath);
        await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'statement-pdf-render'));
      } else {
        console.log('No download received');
        await ss(page, '03f-after-generate-no-dl');
        const afterText = await page.evaluate(() => document.body.innerText.substring(0, 500));
        console.log('Page after Generate:', afterText);
      }
    }
  }

  // ─── QUOTES: Find the correct new quote URL ──────────────────────
  console.log('\n=== Quotes: Find correct route ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes`);
  await page.waitForTimeout(3000);

  // Click "New Quote" or "Create Quote" button to find the route
  const newQuoteBtn = await page.$('button:has-text("New Quote"), a:has-text("New Quote"), button:has-text("Create Quote"), a:has-text("Create Quote")');
  if (newQuoteBtn) {
    const href = await newQuoteBtn.getAttribute('href');
    const tag = await newQuoteBtn.evaluate((el: Element) => el.tagName);
    console.log(`New Quote button: tag=${tag}, href=${href}`);

    if (href) {
      await page.goto(`${BASE_URL}${href}`);
    } else {
      await newQuoteBtn.click();
    }
    await page.waitForTimeout(3000);
    console.log('After New Quote click, URL:', page.url());
    await ss(page, '02b-new-quote-page');

    const quotePageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.log('New quote page text:', quotePageText.substring(0, 1000));

    // Find all form controls
    const formControls = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('input, select, textarea, [role="combobox"], [contenteditable]'))
        .map(el => ({
          tag: el.tagName,
          type: (el as HTMLInputElement).type || '',
          name: (el as HTMLInputElement).name || '',
          id: el.id || '',
          placeholder: (el as HTMLInputElement).placeholder || '',
          role: el.getAttribute('role') || '',
        }));
    });
    console.log('Form controls:', JSON.stringify(formControls, null, 2));
  } else {
    console.log('No New Quote button found');
    const allBtns = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button, a')).map(el => ({
        text: el.textContent?.trim()?.substring(0, 50),
        href: (el as HTMLAnchorElement).href || null
      })).filter(b => b.text)
    );
    console.log('All buttons:', JSON.stringify(allBtns.slice(0, 20)));
  }

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
