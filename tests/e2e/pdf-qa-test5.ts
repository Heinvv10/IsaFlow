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

  // ─── STATEMENT RUN ───────────────────────────────────────────────
  console.log('\n=== Statement Run: Click checkbox by coordinates ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);

  // Examine the DOM structure of the first row checkbox area
  const checkboxDom = await page.evaluate(() => {
    // Find the first row's first cell
    const rows = document.querySelectorAll('tbody tr');
    if (rows.length > 0) {
      const firstRow = rows[0];
      const firstCell = firstRow.querySelector('td');
      return firstCell ? firstCell.outerHTML.substring(0, 500) : 'no td';
    }
    return 'no rows';
  });
  console.log('First row first cell HTML:', checkboxDom);

  // Get bounding box of the first row's first cell to click it
  const firstCellBox = await page.evaluate(() => {
    const rows = document.querySelectorAll('tbody tr');
    if (rows.length > 0) {
      const firstCell = rows[0].querySelector('td');
      if (firstCell) {
        const rect = firstCell.getBoundingClientRect();
        return { x: rect.x + rect.width/2, y: rect.y + rect.height/2, width: rect.width, height: rect.height };
      }
    }
    return null;
  });
  console.log('First cell bounding box:', firstCellBox);

  if (firstCellBox) {
    await page.mouse.click(firstCellBox.x, firstCellBox.y);
    await page.waitForTimeout(1000);
    await ss(page, '03c-after-cell-click');

    const selectedCount = await page.evaluate(() => {
      const counter = document.querySelector('[class*="selected"]') || document.querySelector('*');
      return document.body.innerText.match(/(\d+) selected/)?.[1] || '0';
    });
    console.log('Selected count from text:', selectedCount);

    // Get Generate button state
    const genState = await page.evaluate(() => {
      const btn = Array.from(document.querySelectorAll('button')).find(b => b.textContent?.includes('Generate'));
      return btn ? { disabled: (btn as HTMLButtonElement).disabled, text: btn.textContent?.trim() } : null;
    });
    console.log('Generate button state:', genState);
  }

  // Try clicking the actual SVG checkbox element in the first row
  const svgCheckbox = await page.$('tbody tr:first-child svg, tbody tr:first-child [role="checkbox"]');
  if (svgCheckbox) {
    await svgCheckbox.click();
    await page.waitForTimeout(1000);
    console.log('Clicked SVG checkbox');
    await ss(page, '03d-after-svg-click');
  } else {
    // Try by clicking at specific position - checkbox is leftmost element in row
    // From the screenshot: checkbox column is about x=70, first row y is about 350
    await page.mouse.click(70, 350);
    await page.waitForTimeout(1000);
    await ss(page, '03d-after-coord-click');
  }

  // Check if anything is selected
  const bodyText = await page.evaluate(() => document.body.innerText);
  const selectedMatch = bodyText.match(/(\d+) selected/);
  console.log('Body selection status:', selectedMatch?.[0] || 'none found');

  // Try Generate regardless
  const genBtn = await page.$('button:has-text("Generate")');
  if (genBtn) {
    const isDisabled = await genBtn.evaluate((el: HTMLButtonElement) => el.disabled);
    console.log('Generate disabled:', isDisabled);

    if (!isDisabled) {
      const downloadPromise = page.waitForEvent('download', { timeout: 25000 }).catch(() => null);
      await genBtn.click();
      await page.waitForTimeout(6000);
      const download = await downloadPromise;
      if (download) {
        const dlPath = path.join(SCREENSHOTS_DIR, 'statement.pdf');
        await download.saveAs(dlPath);
        console.log('Statement PDF downloaded!');
        await renderPdf(dlPath, path.join(SCREENSHOTS_DIR, 'statement-pdf-render'));
      } else {
        await ss(page, '03e-after-generate-click');
        console.log('No download after Generate');
      }
    }
  }

  // ─── QUOTES: Create via new quote form ──────────────────────────
  console.log('\n=== Quotes: Create new quote ===');
  await page.goto(`${BASE_URL}/accounting/customer-quotes/new`);
  await page.waitForTimeout(4000);
  await ss(page, '02b-new-quote-form');

  // Log all the form DOM structure
  const formDom = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('form *, [class*="form"] *')).slice(0, 50).map(el => ({
      tag: el.tagName,
      id: el.id,
      name: (el as any).name,
      type: (el as any).type,
      placeholder: (el as any).placeholder,
      class: el.className.substring(0, 50),
      text: el.textContent?.trim()?.substring(0, 30),
    })).filter(el => el.tag === 'INPUT' || el.tag === 'SELECT' || el.tag === 'BUTTON');
  });
  console.log('Quote form elements:', JSON.stringify(formDom.slice(0, 20), null, 2));

  // Try combobox / custom select for client
  const clientCombo = await page.$('[role="combobox"], [aria-label*="client"], [aria-label*="Client"], select');
  console.log('Client combo found:', !!clientCombo);

  if (clientCombo) {
    const tag = await clientCombo.evaluate((el: Element) => el.tagName);
    console.log('Client element tag:', tag);

    if (tag === 'SELECT') {
      const opts = await page.evaluate((el: any) =>
        Array.from(el.options).map((o: any) => ({ v: o.value, t: o.text })), clientCombo);
      console.log('Select options:', JSON.stringify(opts.slice(0, 5)));
      if (opts.length > 1) {
        await clientCombo.selectOption({ index: 1 });
        await page.waitForTimeout(1500);
        console.log('Client selected via select');
      }
    } else {
      await clientCombo.click();
      await page.waitForTimeout(1000);
      // Type to search
      await page.keyboard.type('Herotel');
      await page.waitForTimeout(1000);
      const option = await page.$('[role="option"]:first-child, li:first-child, .dropdown-item:first-child');
      if (option) {
        await option.click();
        console.log('Client selected from dropdown');
      }
      await page.waitForTimeout(1000);
    }
    await ss(page, '02c-quote-client-selected');
  } else {
    console.log('No client select element found — checking page structure');
    const allElements = await page.evaluate(() => document.body.innerHTML.substring(0, 3000));
    console.log('Page HTML snippet:', allElements.substring(0, 1500));
  }

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
