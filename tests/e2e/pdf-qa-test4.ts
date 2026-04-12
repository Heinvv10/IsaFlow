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
    console.log('PDF rendered via pdftoppm to:', outPrefix);
    return true;
  } catch {
    try {
      execSync(`convert -density 150 "${pdfPath}[0]" "${outPrefix}-1.png"`, { timeout: 30000 });
      console.log('PDF rendered via ImageMagick');
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

  // ─── STATEMENT RUN: Force checkbox selection via label click ────
  console.log('\n=== Statement Run: Select + Generate ===');
  await page.goto(`${BASE_URL}/accounting/statement-run`);
  await page.waitForTimeout(3000);
  await ss(page, '03a-statement-run-loaded');

  // Log all checkbox elements
  const cbInfo = await page.evaluate(() => {
    const inputs = Array.from(document.querySelectorAll('input'));
    return inputs.map(inp => ({
      type: inp.type,
      disabled: inp.disabled,
      id: inp.id,
      name: inp.name,
      class: inp.className.substring(0, 60),
      checked: inp.checked,
      value: inp.value,
    }));
  });
  console.log('All inputs on statement page:', JSON.stringify(cbInfo, null, 2));

  // Try clicking the first table row (to toggle selection)
  const firstRowCells = await page.$$('tbody tr');
  console.log('tbody rows found:', firstRowCells.length);

  if (firstRowCells.length > 0) {
    // Click the first cell of first row (which should contain the checkbox area)
    await firstRowCells[0].click();
    await page.waitForTimeout(1000);

    const cbInfo2 = await page.evaluate(() => {
      const inputs = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      return inputs.map(inp => ({ checked: inp.checked, disabled: inp.disabled }));
    });
    console.log('Checkbox state after row click:', JSON.stringify(cbInfo2));

    await ss(page, '03b-after-row-click');

    // Try the generate button
    const genBtn = await page.$('button:has-text("Generate")');
    if (genBtn) {
      const isDisabled = await genBtn.evaluate((el: HTMLButtonElement) => el.disabled);
      console.log('Generate button disabled:', isDisabled);

      if (!isDisabled) {
        const downloadPromise = page.waitForEvent('download', { timeout: 20000 }).catch(() => null);
        await genBtn.click();
        await page.waitForTimeout(5000);

        const download = await downloadPromise;
        if (download) {
          const downloadPath = path.join(SCREENSHOTS_DIR, 'statement.pdf');
          await download.saveAs(downloadPath);
          console.log('Statement PDF downloaded');
          await renderPdf(downloadPath, path.join(SCREENSHOTS_DIR, 'statement-pdf-render'));
        } else {
          await ss(page, '03c-after-generate-no-download');
        }
      } else {
        console.log('Generate button still disabled after row click');
        // Try direct API call to get statement PDF
        console.log('Attempting direct API download via statement endpoint...');
        // Get cookies for auth
        const cookies = await context.cookies();
        const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ');

        // Try to find the statement API endpoint
        await page.goto(`${BASE_URL}/api/accounting/statements/generate`, { timeout: 5000 }).catch(() => {});
        await page.waitForTimeout(1000);
        const apiText = await page.evaluate(() => document.body.innerText.substring(0, 500));
        console.log('API response:', apiText);
      }
    }
  }

  // ─── QUOTES: Create a quote via API then get PDF ─────────────────
  console.log('\n=== Quotes: Create via API + PDF ===');

  // First, get a valid company_id by reading from existing invoice API
  const invoiceApiResponse = await page.evaluate(async () => {
    const resp = await fetch('/api/accounting/customer-invoices?limit=1');
    const json = await resp.json();
    return json;
  });
  console.log('Invoice API response (first):', JSON.stringify(invoiceApiResponse).substring(0, 300));

  // Get the first client
  const clientsResponse = await page.evaluate(async () => {
    const resp = await fetch('/api/accounting/customers?limit=5');
    const json = await resp.json();
    return json;
  });
  console.log('Clients API response:', JSON.stringify(clientsResponse).substring(0, 500));

  // Try to navigate to new quote form and auto-fill it
  await page.goto(`${BASE_URL}/accounting/customer-quotes/new`);
  await page.waitForTimeout(3000);
  await ss(page, '02b-new-quote-form');

  const quoteFormText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('New quote form text:', quoteFormText.substring(0, 1200));

  // Get all inputs on the quote form
  const quoteInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
      tag: el.tagName,
      type: (el as HTMLInputElement).type,
      name: (el as HTMLInputElement).name,
      id: el.id,
      placeholder: (el as HTMLInputElement).placeholder,
      class: el.className.substring(0, 60),
    }));
  });
  console.log('Quote form inputs:', JSON.stringify(quoteInputs, null, 2));

  // Try selecting client
  const clientSelectEl = await page.$('select[name="clientId"], #clientId, select:first-of-type');
  if (clientSelectEl) {
    const options = await page.evaluate((el: any) => {
      return Array.from(el.options).map((o: any) => ({ value: o.value, text: o.text }));
    }, clientSelectEl);
    console.log('Client options:', JSON.stringify(options.slice(0, 5)));

    if (options.length > 1) {
      await clientSelectEl.selectOption({ index: 1 });
      await page.waitForTimeout(1500);
      console.log('Selected client');
      await ss(page, '02c-quote-with-client');

      // Add a line item
      const addLineBtn = await page.$('button:has-text("Add Line"), button:has-text("Add Item"), button:has-text("Add")');
      if (addLineBtn) {
        const addBtnText = await addLineBtn.textContent();
        if (addBtnText && (addBtnText.includes('Add') || addBtnText.includes('Line'))) {
          await addLineBtn.click();
          await page.waitForTimeout(1000);
        }
      }

      // Fill description
      const descInput = await page.$('input[name*="description"], input[placeholder*="description"], input[placeholder*="Description"]');
      if (descInput) {
        await descInput.fill('Test Service Item');
      }

      // Fill quantity
      const qtyInput = await page.$('input[name*="qty"], input[name*="quantity"], input[type="number"]:first-of-type');
      if (qtyInput) {
        await qtyInput.fill('1');
      }

      // Fill price
      const priceInput = await page.$('input[name*="price"], input[name*="unitPrice"], input[name*="amount"]');
      if (priceInput) {
        await priceInput.fill('1000');
      }

      await ss(page, '02d-quote-filled');

      // Look for Save/Submit
      const saveBtn = await page.$('button:has-text("Save"), button:has-text("Create"), button[type="submit"]');
      if (saveBtn) {
        await saveBtn.click();
        await page.waitForTimeout(4000);
        await ss(page, '02e-quote-saved');
        console.log('Quote save attempt, URL:', page.url());

        // If redirected to quote detail, look for PDF button
        const pdfBtn = await page.$('button:has-text("Download PDF"), button:has-text("PDF")');
        if (pdfBtn) {
          const downloadPromise = page.waitForEvent('download', { timeout: 15000 }).catch(() => null);
          await pdfBtn.click();
          await page.waitForTimeout(3000);
          const download = await downloadPromise;
          if (download) {
            const downloadPath = path.join(SCREENSHOTS_DIR, 'quote.pdf');
            await download.saveAs(downloadPath);
            console.log('Quote PDF downloaded');
            await renderPdf(downloadPath, path.join(SCREENSHOTS_DIR, 'quote-pdf-render'));
          }
        }
      }
    }
  } else {
    console.log('No client select found on quote form');
    const buttons = await page.evaluate(() =>
      Array.from(document.querySelectorAll('button')).map(b => b.textContent?.trim())
    );
    console.log('Buttons on quote form:', buttons);
  }

  console.log('\n=== Done. Screenshots at:', SCREENSHOTS_DIR);
  await browser.close();
}

main().catch(console.error);
