import { chromium } from 'playwright';

const SCREENSHOTS_DIR = '/home/hein/Workspace/IsaFlow/xero-screenshots';

async function run() {
  const browser = await chromium.launch({ headless: false, slowMo: 500 });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  let step = 1;
  const screenshot = async (name) => {
    const path = `${SCREENSHOTS_DIR}/${String(step).padStart(2, '0')}_${name}.png`;
    await page.screenshot({ path });
    console.log(`Screenshot ${step}: ${name} -> ${path}`);
    step++;
  };

  // Navigate to Xero login
  await page.goto('https://login.xero.com/identity/user/login');
  await page.waitForSelector('input[type="email"], input[id="xl-form-email"]', { timeout: 15000 });
  await screenshot('login_page');

  // Fill credentials
  const emailInput = page.locator('input[type="email"], input[id="xl-form-email"]');
  await emailInput.fill('hein@h10.co.za');
  const passwordInput = page.locator('input[type="password"], input[id="xl-form-password"]');
  await passwordInput.fill('Mitzi@0203');
  await screenshot('credentials_filled');

  // Click login
  await page.locator('button[type="submit"], button:has-text("Log in")').click();
  await page.waitForURL('**/go.xero.com/**', { timeout: 30000 });
  console.log('Logged in, current URL:', page.url());

  // Wait for page to fully load
  await page.waitForTimeout(5000);
  await screenshot('after_login');

  // Wait longer for SPA to mount
  await page.waitForTimeout(10000);
  await screenshot('after_wait');

  // Take snapshot of current page content
  const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Page content:', bodyText);

  const url = page.url();
  console.log('Current URL:', url);

  // If on onboarding, explore it
  if (url.includes('onboarding')) {
    await page.waitForTimeout(5000);
    await screenshot('onboarding_loaded');

    // Full page screenshot
    await page.screenshot({ path: `${SCREENSHOTS_DIR}/${String(step).padStart(2, '0')}_onboarding_full.png`, fullPage: true });
    console.log(`Screenshot ${step}: onboarding_full`);
    step++;
  }

  // Try navigating to dashboard
  await page.goto('https://go.xero.com/Dashboard');
  await page.waitForTimeout(10000);
  await screenshot('dashboard');
  console.log('Dashboard URL:', page.url());
  const dashText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Dashboard content:', dashText);

  // Navigate to key areas
  const pages_to_visit = [
    { url: 'https://go.xero.com/app/contacts', name: 'contacts' },
    { url: 'https://go.xero.com/AccountsReceivable/Search.aspx', name: 'invoices' },
    { url: 'https://go.xero.com/Bank/BankAccounts.aspx', name: 'bank_accounts' },
    { url: 'https://go.xero.com/ChartOfAccounts/ChartOfAccounts.aspx', name: 'chart_of_accounts' },
    { url: 'https://go.xero.com/Settings', name: 'settings' },
    { url: 'https://go.xero.com/Reports', name: 'reports' },
  ];

  for (const p of pages_to_visit) {
    try {
      await page.goto(p.url, { timeout: 30000 });
      await page.waitForTimeout(5000);
      await screenshot(p.name);
      const text = await page.evaluate(() => document.body.innerText.substring(0, 2000));
      console.log(`\n=== ${p.name} (${page.url()}) ===`);
      console.log(text);
    } catch (e) {
      console.log(`Error visiting ${p.name}: ${e.message}`);
    }
  }

  // Keep browser open for manual inspection
  console.log('\nDone! Browser will stay open for 60 seconds...');
  await page.waitForTimeout(60000);
  await browser.close();
}

run().catch(console.error);
