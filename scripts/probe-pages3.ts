import { chromium } from 'playwright';
const BASE = 'https://app.isaflow.co.za';

async function main() {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  await page.goto(`${BASE}/login`, { timeout: 20000 });
  await page.waitForLoadState('domcontentloaded');
  if (!page.url().includes('/accounting')) {
    await page.fill('input[type="email"]', 'admin@isaflow.co.za');
    await page.fill('input[type="password"]', 'admin123');
    await page.click('button[type="submit"]');
    await page.waitForTimeout(4000);
  }

  // 1. Check correct report URLs
  const reportPages = [
    '/accounting/reports/balance-sheet',
    '/accounting/reports/income-statement',
    '/accounting/reports/cash-flow',
  ];
  for (const path of reportPages) {
    await page.goto(`${BASE}${path}`, { timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const body = await page.evaluate(() => document.body.innerText.substring(0, 300));
    const htmlLen = await page.evaluate(() => document.body.innerHTML.length);
    console.log(`\n--- ${path} ---`);
    console.log(`  HTML: ${htmlLen}, Body: "${body.substring(0, 150)}"`);
  }

  // 2. Bank Accounts: click into an account
  await page.goto(`${BASE}/accounting/bank-accounts`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  // Click "View Transactions" or the account name
  const viewBtn = await page.$('button:has-text("View"), a:has-text("View"), button:has-text("Transactions"), button:has-text("Bank - Primary")');
  if (viewBtn) {
    await viewBtn.click();
    await page.waitForTimeout(2000);
    console.log('\n--- After clicking bank account ---');
    console.log('URL:', page.url());
    console.log('Body:', (await page.evaluate(() => document.body.innerText.substring(0, 300))));
  } else {
    // Try clicking the card directly
    const card = await page.$('[class*="card"], [class*="account-card"], .cursor-pointer, [class*="hover:bg"]');
    if (card) {
      await card.click();
      await page.waitForTimeout(2000);
      console.log('\n--- After clicking bank card ---');
      console.log('URL:', page.url());
    }
    // Look for any clickable elements
    const clickables = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('[class*="cursor-pointer"], [onclick]')).map(el => ({
        tag: el.tagName,
        text: (el as HTMLElement).innerText?.trim().substring(0, 50),
        classes: (el as HTMLElement).className?.substring(0, 80),
      })).filter(e => e.text).slice(0, 10);
    });
    console.log('\nClickable elements on bank-accounts:', JSON.stringify(clickables, null, 2));
  }

  // 3. Nav: expand Banking submenu and check sub-links
  await page.goto(`${BASE}/accounting`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(1500);

  // Click Banking nav item
  const bankingNav = await page.$('div:has-text("Banking"), button:has-text("Banking")');
  if (bankingNav) {
    await bankingNav.click();
    await page.waitForTimeout(800);
    const allLinks = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('nav a, nav button, aside a, aside button')).map(el => ({
        tag: el.tagName,
        text: (el as HTMLElement).innerText?.trim(),
        href: (el as HTMLAnchorElement).href || '',
      })).filter(e => e.text);
    });
    console.log('\n--- NAV after Banking expand ---');
    console.log(JSON.stringify(allLinks, null, 2));
  }

  // 4. Check customer new form more carefully
  await page.goto(`${BASE}/accounting/customers`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);

  const allBtns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(el => ({
      text: (el as HTMLElement).innerText?.trim().substring(0, 50),
    })).filter(b => b.text);
  });
  console.log('\n--- CUSTOMERS PAGE BUTTONS ---');
  console.log(JSON.stringify(allBtns, null, 2));

  // 5. Check supplier-invoices new
  await page.goto(`${BASE}/accounting/supplier-invoices`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const supBtns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(el => ({
      text: (el as HTMLElement).innerText?.trim().substring(0, 50),
    })).filter(b => b.text);
  });
  console.log('\n--- SUPPLIER INVOICES BUTTONS ---');
  console.log(JSON.stringify(supBtns, null, 2));

  // 6. Check purchase-orders
  await page.goto(`${BASE}/accounting/purchase-orders`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const poBody = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('\n--- PURCHASE ORDERS ---');
  console.log(poBody.substring(0, 300));

  // 7. Check assets page
  await page.goto(`${BASE}/accounting/assets`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const assetsBody = await page.evaluate(() => document.body.innerText.substring(0, 500));
  console.log('\n--- ASSETS ---');
  console.log(assetsBody.substring(0, 300));

  // 8. Admin checks in detail
  await page.goto('https://admin.isaflow.co.za', { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const adminBody = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  const adminBtns = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button, a[href]')).map(el => ({
      text: (el as HTMLElement).innerText?.trim().substring(0, 50),
      href: (el as HTMLAnchorElement).href || '',
    })).filter(b => b.text).slice(0, 20);
  });
  console.log('\n--- ADMIN ---');
  console.log(adminBody.substring(0, 500));
  console.log('Admin buttons:', JSON.stringify(adminBtns, null, 2));

  await browser.close();
}
main().catch(console.error);
