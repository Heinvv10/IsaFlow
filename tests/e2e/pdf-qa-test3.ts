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
    console.log('PDF rendered via pdftoppm');
  } catch {
    try {
      execSync(`convert -density 150 "${pdfPath}[0]" "${outPrefix}-1.png"`, { timeout: 30000 });
      console.log('PDF rendered via ImageMagick');
    } catch (e: any) {
      console.log('Could not render PDF:', e.message);
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

  // ─── STATEMENT RUN: Select customer + Generate ───────────────────
  console.log('\n=== Statement Run: Select + Generate ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);

  // Click the first row checkbox (the table row itself acts as selector)
  // Try clicking the checkbox directly by evaluating
  const checkboxClicked = await page.evaluate(() => {
    const checkboxes = document.querySelectorAll('input[type="checkbox"]');
    console.log('Checkboxes found:', checkboxes.length);
    if (checkboxes.length > 1) {
      // First one is the "select all" header, so click the second one
      (checkboxes[1] as HTMLInputElement).click();
      return true;
    } else if (checkboxes.length === 1) {
      (checkboxes[0] as HTMLInputElement).click();
      return true;
    }
    return false;
  });
  console.log('Checkbox clicked via JS:', checkboxClicked);
  await page.waitForTimeout(1000);
  await ss(page, '03b-statement-customer-selected');

  // Now click Generate
  const generateBtn = await page.$('button:has-text("Generate")');
  if (generateBtn) {
    const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    const newPagePromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);

    await generateBtn.click();
    console.log('Clicked Generate');
    await page.waitForTimeout(5000);

    const [download, newTab] = await Promise.all([downloadPromise, newPagePromise]);

    if (download) {
      const downloadPath = path.join(SCREENSHOTS_DIR, 'statement.pdf');
      await download.saveAs(downloadPath);
      console.log('Statement PDF downloaded:', downloadPath);
      await renderPdf(downloadPath, path.join(SCREENSHOTS_DIR, 'statement-pdf-render'));
    } else if (newTab) {
      console.log('Statement opened in new tab:', newTab.url());
      await newTab.waitForTimeout(4000);
      await newTab.screenshot({ path: path.join(SCREENSHOTS_DIR, '03c-statement-pdf-tab.png'), fullPage: false });
      await newTab.close();
    } else {
      console.log('No download or new tab after Generate');
      await ss(page, '03c-after-generate');
    }
  } else {
    console.log('Generate button not found');
    await ss(page, '03c-no-generate-btn');
  }

  // ─── QUOTES: Create a test quote then download PDF ───────────────
  console.log('\n=== Quotes: Create a quote ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes/new`);
  await page.waitForTimeout(3000);
  await ss(page, '02b-new-quote-form');

  const quotePageText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  console.log('New quote form:', quotePageText.substring(0, 800));

  // If the new quote form exists, fill it minimally and look for PDF preview
  const clientSelect = await page.$('select[name="clientId"], select[id*="client"], #clientId');
  if (clientSelect) {
    // Select first option
    await page.selectOption('select[name="clientId"]', { index: 1 });
    await page.waitForTimeout(1000);
    console.log('Selected client for quote');
    await ss(page, '02c-quote-client-selected');
  }

  // ─── Also test: invoice PDF header zoom ─────────────────────────
  console.log('\n=== Invoice PDF already rendered — examining ===');
  const pdfRenderPath = path.join(SCREENSHOTS_DIR, 'invoice-pdf-render-1.png');
  if (fs.existsSync(pdfRenderPath)) {
    console.log('Invoice PDF render exists at:', pdfRenderPath);
    // Crop the header area
    try {
      execSync(`convert "${pdfRenderPath}" -crop 1275x250+0+0 "${SCREENSHOTS_DIR}/invoice-pdf-header-zoom.png"`, { timeout: 10000 });
      console.log('Header crop done');
    } catch (e: any) {
      console.log('Crop failed:', e.message);
    }
  }

  console.log('\n=== Done ===');
  await browser.close();
}

main().catch(console.error);
