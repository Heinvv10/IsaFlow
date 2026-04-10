import { chromium } from 'playwright';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/xero-screenshots';

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 300 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  let step = 20;
  const screenshot = async (name) => {
    const path = `${SCREENSHOTS_DIR}/${String(step).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path });
    console.log(`Screenshot ${step}: ${name}`);
    step++;
  };

  // Login
  await page.goto('https://login.xero.com/identity/user/login');
  await page.waitForSelector('input[type="email"], input[id="xl-form-email"]', { timeout: 15000 });
  await page.locator('input[type="email"], input[id="xl-form-email"]').fill('hein@h10.co.za');
  await page.locator('input[type="password"], input[id="xl-form-password"]').fill('Mitzi@0203');
  await page.locator('button[type="submit"], button:has-text("Log in")').click();
  await page.waitForURL('**/go.xero.com/**', { timeout: 30000 });
  await page.waitForTimeout(8000);
  console.log('Logged in:', page.url());

  // 1. Explore onboarding setup guide steps
  const onboardingSteps = [
    'Configure initial settings',
    'Connect your bank',
    'Send invoices',
    'Upload bills',
    'Set up payroll',
    'Set up expense claims',
    'Access support resources',
    'Additional features'
  ];

  // Click each onboarding card
  for (const stepName of onboardingSteps) {
    try {
      const card = page.locator(`text="${stepName}"`).first();
      if (await card.isVisible({ timeout: 3000 })) {
        await card.click();
        await page.waitForTimeout(3000);
        await screenshot(`onboarding_${stepName.replace(/\s+/g, '_').toLowerCase()}`);

        const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
        console.log(`\n=== Onboarding: ${stepName} ===`);
        console.log(text);

        // Go back to homepage
        await page.goto('https://go.xero.com/Dashboard', { timeout: 15000 });
        await page.waitForTimeout(3000);
      }
    } catch (e) {
      console.log(`Could not click "${stepName}": ${e.message.substring(0, 100)}`);
    }
  }

  // 2. Explore Settings
  const settingsPages = [
    { url: 'https://go.xero.com/app/settings/general', name: 'settings_general' },
    { url: 'https://go.xero.com/app/settings/financial', name: 'settings_financial' },
    { url: 'https://go.xero.com/Setup/Organisation.aspx', name: 'settings_org' },
    { url: 'https://go.xero.com/Settings/InvoiceSettings', name: 'settings_invoice' },
    { url: 'https://go.xero.com/app/settings/chart-of-accounts', name: 'settings_coa' },
    { url: 'https://go.xero.com/app/settings/tax-rates', name: 'settings_tax_rates' },
    { url: 'https://go.xero.com/app/settings/users', name: 'settings_users' },
  ];

  for (const p of settingsPages) {
    try {
      await page.goto(p.url, { timeout: 20000 });
      await page.waitForTimeout(4000);
      await screenshot(p.name);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(`\n=== ${p.name} (${page.url()}) ===`);
      console.log(text);
    } catch (e) {
      console.log(`Error: ${p.name}: ${e.message.substring(0, 100)}`);
    }
  }

  // 3. Explore Sales menu items
  const salesPages = [
    { url: 'https://go.xero.com/app/invoicing/view/sales', name: 'sales_overview' },
    { url: 'https://go.xero.com/AccountsReceivable/Edit.aspx', name: 'new_invoice' },
    { url: 'https://go.xero.com/app/quotes', name: 'quotes' },
  ];

  for (const p of salesPages) {
    try {
      await page.goto(p.url, { timeout: 20000 });
      await page.waitForTimeout(4000);
      await screenshot(p.name);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(`\n=== ${p.name} (${page.url()}) ===`);
      console.log(text);
    } catch (e) {
      console.log(`Error: ${p.name}: ${e.message.substring(0, 100)}`);
    }
  }

  // 4. Explore Purchases menu
  const purchasePages = [
    { url: 'https://go.xero.com/AccountsPayable/Search.aspx', name: 'bills' },
    { url: 'https://go.xero.com/AccountsPayable/Edit.aspx', name: 'new_bill' },
  ];

  for (const p of purchasePages) {
    try {
      await page.goto(p.url, { timeout: 20000 });
      await page.waitForTimeout(4000);
      await screenshot(p.name);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(`\n=== ${p.name} (${page.url()}) ===`);
      console.log(text);
    } catch (e) {
      console.log(`Error: ${p.name}: ${e.message.substring(0, 100)}`);
    }
  }

  // 5. Accounting menu
  const accountingPages = [
    { url: 'https://go.xero.com/Bank/BankAccounts.aspx', name: 'bank_accounts_detail' },
    { url: 'https://go.xero.com/GeneralLedger/JournalEntryList.aspx', name: 'journal_entries' },
  ];

  for (const p of accountingPages) {
    try {
      await page.goto(p.url, { timeout: 20000 });
      await page.waitForTimeout(4000);
      await screenshot(p.name);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(`\n=== ${p.name} (${page.url()}) ===`);
      console.log(text);
    } catch (e) {
      console.log(`Error: ${p.name}: ${e.message.substring(0, 100)}`);
    }
  }

  // 6. Navigation structure - capture all menu items
  await page.goto('https://go.xero.com/Dashboard', { timeout: 15000 });
  await page.waitForTimeout(5000);

  // Click each top nav to see sub-menus
  const navItems = ['Sales', 'Purchases', 'Accounting', 'Contacts'];
  for (const nav of navItems) {
    try {
      await page.locator(`nav >> text="${nav}"`).first().click();
      await page.waitForTimeout(1500);
      await screenshot(`nav_${nav.toLowerCase()}`);
      const menuText = await page.evaluate(() => {
        const menu = document.querySelector('[role="menu"], .xnav-dropdown, [class*="dropdown"]');
        return menu ? menu.innerText : 'no dropdown found';
      });
      console.log(`\n=== Nav: ${nav} ===`);
      console.log(menuText);
      // Close by clicking elsewhere
      await page.locator('body').click({ position: { x: 700, y: 400 } });
      await page.waitForTimeout(500);
    } catch (e) {
      console.log(`Nav ${nav} error: ${e.message.substring(0, 100)}`);
    }
  }

  console.log('\nDone! Closing...');
  await browser.close();
}

run().catch(console.error);
