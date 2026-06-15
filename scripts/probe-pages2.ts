import { chromium } from 'playwright';
const BASE = 'https://app.isaflow.co.za';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD env var is required (hardcoded default removed for security)'); process.exit(1); }

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto(`${BASE}/login`, { timeout: 20000 });
  await page.waitForLoadState('domcontentloaded');
  if (!page.url().includes('/accounting')) {
    await page.fill('input[type="email"]', 'admin@isaflow.co.za');
    await page.fill('input[type="password"]', ADMIN_PASSWORD);
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
  }

  // ---- 1. Bank Accounts - click on an account row ----
  await page.goto(`${BASE}/accounting/bank-accounts`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Try clicking a row or card
  const bankCard = await page.$('[class*="card"], tr, [class*="row"], [class*="account"]');
  if (bankCard) {
    await bankCard.click().catch(() => {});
    await page.waitForTimeout(2000);
    console.log('After bank card click URL:', page.url());
  }

  // Full bank accounts HTML
  const bankHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
  console.log('\n--- BANK ACCOUNTS FULL HTML (first 5000) ---');
  console.log(bankHtml);

  // ---- 2. PDF Download test ----
  await page.goto(`${BASE}/accounting/customer-invoices/f5d4e726-70d1-4864-90a7-9645f0fc61c6`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const allBtns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a')).map(el => ({
      tag: el.tagName,
      text: (el as HTMLElement).innerText?.trim().substring(0, 50),
      href: (el as HTMLAnchorElement).href || '',
      classes: (el as HTMLElement).className?.substring(0, 100),
    })).filter(b => b.text);
  });
  console.log('\n--- INVOICE DETAIL ALL BUTTONS ---');
  console.log(JSON.stringify(allBtns, null, 2));

  // Try clicking Download PDF
  const downloadBtn = await page.$('button:has-text("Download PDF"), a:has-text("Download PDF"), button:has-text("PDF")');
  if (downloadBtn) {
    const dlPromise = page.waitForEvent('download', { timeout: 8000 }).catch(() => null);
    await downloadBtn.click();
    await page.waitForTimeout(3000);
    const dl = await dlPromise;
    if (dl) {
      console.log('PDF DOWNLOAD SUCCESS:', dl.suggestedFilename());
    } else {
      const newUrl = page.url();
      console.log('PDF click - no download event. URL after click:', newUrl);
      // Check for new tab
      const pages = context.pages();
      console.log('Pages open:', pages.map(p => p.url()));
    }
  } else {
    console.log('Download PDF button NOT found');
  }

  // ---- 3. Nav: expand Customers submenu ----
  await page.goto(`${BASE}/accounting`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Click Customers expander
  const customersBtn = await page.$('button:has-text("Customers"), div:has-text("Customers")');
  if (customersBtn) {
    await customersBtn.click();
    await page.waitForTimeout(1000);
    const expandedLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('nav a, aside a')).map(a => ({
        text: (a as HTMLElement).innerText?.trim(),
        href: (a as HTMLAnchorElement).href,
      }));
    });
    console.log('\n--- NAV LINKS AFTER EXPAND CUSTOMERS ---');
    console.log(JSON.stringify(expandedLinks, null, 2));
  }

  // ---- 4. Check vat-return redirect ----
  await page.goto(`${BASE}/accounting/vat-return`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const vatUrl = page.url();
  const vatBody = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('\n--- VAT-RETURN ---');
  console.log('URL:', vatUrl);
  console.log('Body:', vatBody.substring(0, 300));

  // ---- 5. Reports page ----
  await page.goto(`${BASE}/accounting/reports`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const reportsBody = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  const reportsLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a[href*="reports"], a[href*="balance"], a[href*="income"]')).map(a => ({
      text: (a as HTMLElement).innerText?.trim(),
      href: (a as HTMLAnchorElement).href,
    }));
  });
  console.log('\n--- REPORTS PAGE ---');
  console.log('Body:', reportsBody.substring(0, 400));
  console.log('Report links:', JSON.stringify(reportsLinks, null, 2));

  // ---- 6. Check Company Settings tabs ----
  await page.goto(`${BASE}/accounting/company-settings`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const settingsBody = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  const settingsButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, [role="tab"]')).map(el => ({
      text: (el as HTMLElement).innerText?.trim().substring(0, 50),
    })).filter(b => b.text);
  });
  console.log('\n--- COMPANY SETTINGS ---');
  console.log('Body:', settingsBody.substring(0, 500));
  console.log('Buttons/tabs:', JSON.stringify(settingsButtons, null, 2));

  // ---- 7. Customer invoice /new - check all content ----
  await page.goto(`${BASE}/accounting/customer-invoices/new`, { timeout: 25000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const newInvFull = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('\n--- NEW CUSTOMER INVOICE FULL ---');
  console.log(newInvFull.substring(0, 2000));

  await browser.close();
}
main().catch(console.error);
