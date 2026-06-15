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
  console.log('Logged in:', page.url());

  const probePaths = [
    '/accounting/balance-sheet',
    '/accounting/income-statement',
    '/accounting/quotes',
    '/accounting/sales-orders',
    '/accounting/payroll',
    '/accounting/bank-accounts',
    '/accounting/customer-invoices/new',
  ];

  for (const path of probePaths) {
    await page.goto(`${BASE}${path}`, { timeout: 25000 });
    // Wait longer for SPA pages
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await page.waitForTimeout(4000);

    const finalUrl = page.url();
    const body = await page.evaluate(() => document.body.innerText.substring(0, 500));
    const htmlLen = await page.evaluate(() => document.body.innerHTML.length);
    const title = await page.title();
    console.log(`\n--- ${path} ---`);
    console.log(`  URL: ${finalUrl}`);
    console.log(`  Title: ${title}`);
    console.log(`  HTML length: ${htmlLen}`);
    console.log(`  Body text: "${body.substring(0, 200)}"`);
  }

  // Check nav structure in detail
  await page.goto(`${BASE}/accounting`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const navHtml = await page.evaluate(() => {
    const nav = document.querySelector('nav, aside, [role="navigation"]');
    return nav ? nav.innerHTML.substring(0, 3000) : 'NO NAV FOUND';
  });
  console.log('\n--- NAV HTML ---');
  console.log(navHtml.substring(0, 2000));

  // Check customer invoice new page in detail
  await page.goto(`${BASE}/accounting/customer-invoices/new`, { timeout: 25000 });
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(4000);
  const invBody = await page.evaluate(() => document.body.innerText.substring(0, 2000));
  const invInputs = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('input, select, textarea')).map(el => ({
      tag: el.tagName,
      name: (el as any).name,
      placeholder: (el as any).placeholder,
      type: (el as any).type,
    }));
  });
  console.log('\n--- CUSTOMER INVOICE /NEW ---');
  console.log('Body:', invBody.substring(0, 500));
  console.log('Inputs:', JSON.stringify(invInputs.slice(0, 20), null, 2));

  // Check bank accounts page for links
  await page.goto(`${BASE}/accounting/bank-accounts`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(2000);
  const bankBody = await page.evaluate(() => document.body.innerText.substring(0, 1000));
  const bankLinks = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('a')).map(a => ({ text: a.innerText?.trim(), href: a.href })).filter(l => l.href).slice(0, 20);
  });
  console.log('\n--- BANK ACCOUNTS ---');
  console.log('Body:', bankBody.substring(0, 300));
  console.log('Links:', JSON.stringify(bankLinks.slice(0, 15), null, 2));

  // Check PDF button on a real invoice
  await page.goto(`${BASE}/accounting/customer-invoices`, { timeout: 20000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
  await page.waitForTimeout(3000);
  const firstInvLink = await page.evaluate(() => {
    const rows = document.querySelectorAll('table tbody tr');
    if (rows.length > 0) {
      const firstRow = rows[0];
      const link = firstRow.querySelector('a');
      return link ? (link as HTMLAnchorElement).href : null;
    }
    return null;
  });
  console.log('\n--- FIRST INVOICE LINK ---', firstInvLink);

  if (firstInvLink) {
    await page.goto(firstInvLink, { timeout: 20000 });
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
    await page.waitForTimeout(2000);
    const invDetailBody = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    const allButtons = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('button, a')).map(el => ({
        tag: el.tagName,
        text: (el as HTMLElement).innerText?.trim(),
        href: (el as HTMLAnchorElement).href || '',
      })).filter(b => b.text).slice(0, 30);
    });
    console.log('Invoice detail body:', invDetailBody.substring(0, 300));
    console.log('Buttons/links:', JSON.stringify(allButtons.slice(0, 20), null, 2));
  }

  await browser.close();
}

main().catch(console.error);
