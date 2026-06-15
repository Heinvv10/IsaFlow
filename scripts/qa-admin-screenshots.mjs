/**
 * Final screenshot pass for all admin pages
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://admin.isaflow.co.za';
const SCREENSHOT_DIR = join(__dirname, '../tmp/admin-qa-screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD env var is required (hardcoded default removed for security)'); process.exit(1); }

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.locator('input[type="email"]').first().fill('admin@isaflow.co.za');
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(3000);
  console.log('Logged in:', page.url());

  const pages = [
    ['login', `${BASE_URL}/login`],
    ['dashboard', `${BASE_URL}/`],
    ['companies', `${BASE_URL}/companies`],
    ['users', `${BASE_URL}/users`],
    ['billing-overview', `${BASE_URL}/billing`],
    ['billing-plans', `${BASE_URL}/billing/plans`],
    ['billing-subscriptions', `${BASE_URL}/billing/subscriptions`],
    ['billing-invoices', `${BASE_URL}/billing/invoices`],
    ['features', `${BASE_URL}/features`],
    ['analytics', `${BASE_URL}/analytics`],
    ['audit', `${BASE_URL}/audit`],
    ['tools', `${BASE_URL}/tools`],
    ['tools-announcements', `${BASE_URL}/tools/announcements`],
    ['settings', `${BASE_URL}/settings`],
    ['components', `${BASE_URL}/components`],
  ];

  for (const [name, url] of pages) {
    try {
      await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);
      await page.screenshot({ path: join(SCREENSHOT_DIR, `final-${name}.png`), fullPage: false });
      console.log(`Screenshot: ${name}`);
    } catch (e) {
      console.log(`Error on ${name}: ${e.message}`);
    }
  }

  // Special: open create plan modal
  await page.goto(`${BASE_URL}/billing/plans`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator('button:has-text("Add Plan")').click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-billing-plans-modal.png'), fullPage: false });
  console.log('Screenshot: billing-plans-modal');

  // Special: company detail
  await page.goto(`${BASE_URL}/companies`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator('table tr:not(:first-child)').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-company-detail.png'), fullPage: false });
  console.log('Screenshot: company-detail');

  // Company detail Users tab
  await page.locator('button:has-text("Users"), a:has-text("Users")').first().click().catch(() => {});
  await page.waitForTimeout(800);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-company-detail-users-tab.png'), fullPage: false });
  console.log('Screenshot: company-detail-users-tab');

  // User detail
  await page.goto(`${BASE_URL}/users`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(1000);
  await page.locator('table tr:not(:first-child)').first().click();
  await page.waitForTimeout(1500);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'final-user-detail.png'), fullPage: false });
  console.log('Screenshot: user-detail');

  await browser.close();
  console.log('\nAll screenshots saved to:', SCREENSHOT_DIR);
}

run().catch(err => { console.error(err); process.exit(1); });
