/**
 * Deep-check QA Script: Investigate 4 failing steps
 * 1. /billing — content not detected
 * 2. Sidebar visibility detection
 * 3. Tools nav not found
 * 4. Feature flag toggles
 * Also captures rich screenshots and body text for each page
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('ADMIN_PASSWORD env var is required (hardcoded default removed for security)'); process.exit(1); }

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://admin.isaflow.co.za';
const SCREENSHOT_DIR = join(__dirname, '../tmp/admin-qa-screenshots');
const DEEP_REPORT_PATH = join(__dirname, '../tmp/admin-qa-deep-report.md');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

async function run() {
  const browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  // Login
  await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.locator('input[type="email"]').first().fill('admin@isaflow.co.za');
  await page.locator('input[type="password"]').first().fill(ADMIN_PASSWORD);
  await page.locator('button[type="submit"]').first().click();
  await page.waitForTimeout(4000);
  console.log('Logged in. Current URL:', page.url());

  const findings = [];

  // ---- 1. BILLING OVERVIEW (/billing) ----
  console.log('\n=== Investigating /billing ===');
  await page.goto(`${BASE_URL}/billing`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  const billingText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  const billingHtml = await page.evaluate(() => document.body.innerHTML.substring(0, 5000));
  const billingTitle = await page.title();
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-01-billing.png'), fullPage: true });
  console.log('Billing page title:', billingTitle);
  console.log('Billing text preview:', billingText.substring(0, 800));

  findings.push({
    page: '/billing',
    title: billingTitle,
    textPreview: billingText.substring(0, 1500),
    htmlSample: billingHtml.substring(0, 1000),
  });

  // ---- 2. SIDEBAR INVESTIGATION (Dashboard) ----
  console.log('\n=== Investigating sidebar on / ===');
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-02-dashboard-full.png'), fullPage: true });

  const sidebarInfo = await page.evaluate(() => {
    const candidates = [
      ...document.querySelectorAll('nav'),
      ...document.querySelectorAll('aside'),
      ...document.querySelectorAll('[class*="sidebar"]'),
      ...document.querySelectorAll('[class*="Sidebar"]'),
      ...document.querySelectorAll('[class*="nav"]'),
      ...document.querySelectorAll('[class*="Nav"]'),
      ...document.querySelectorAll('[class*="menu"]'),
      ...document.querySelectorAll('[class*="Menu"]'),
    ];
    return candidates.map(el => ({
      tag: el.tagName,
      classes: el.className,
      visible: el.offsetParent !== null,
      textPreview: el.innerText?.substring(0, 200),
    })).slice(0, 10);
  });
  console.log('Sidebar candidates:', JSON.stringify(sidebarInfo, null, 2));

  findings.push({
    page: '/ (sidebar)',
    sidebarCandidates: sidebarInfo,
  });

  // ---- 3. NAV LINKS ----
  const navLinks = await page.evaluate(() => {
    const links = document.querySelectorAll('a, [role="link"], [role="menuitem"], button');
    return Array.from(links).slice(0, 60).map(el => ({
      tag: el.tagName,
      text: el.innerText?.trim()?.substring(0, 50),
      href: el.href || null,
      classes: el.className?.substring(0, 100),
    })).filter(l => l.text);
  });
  console.log('Nav links found:', navLinks.map(l => l.text).join(', '));

  findings.push({
    page: '/ (nav links)',
    links: navLinks,
  });

  // ---- 4. FEATURE FLAGS (/features) ----
  console.log('\n=== Investigating /features ===');
  await page.goto(`${BASE_URL}/features`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-03-features-full.png'), fullPage: true });

  const featuresText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  const featureElements = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input[type="checkbox"], [role="switch"], [class*="toggle"], [class*="Toggle"], [class*="switch"], [class*="Switch"]');
    return Array.from(inputs).map(el => ({
      tag: el.tagName,
      type: el.type,
      role: el.getAttribute('role'),
      classes: el.className?.substring(0, 100),
      visible: el.offsetParent !== null,
      parentText: el.parentElement?.innerText?.substring(0, 100),
    })).slice(0, 20);
  });
  console.log('Features text preview:', featuresText.substring(0, 800));
  console.log('Feature toggle elements:', JSON.stringify(featureElements, null, 2));

  findings.push({
    page: '/features',
    textPreview: featuresText.substring(0, 1500),
    toggleElements: featureElements,
  });

  // ---- 5. COMPANY DETAIL PAGE ----
  console.log('\n=== Investigating Company Detail ===');
  await page.goto(`${BASE_URL}/companies`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  const firstRow = page.locator('table tr:not(:first-child)').first();
  const rowExists = await firstRow.isVisible().catch(() => false);
  if (rowExists) {
    await firstRow.click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-04-company-detail.png'), fullPage: true });
    const detailText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
    console.log('Company detail URL:', page.url());
    console.log('Company detail text:', detailText.substring(0, 800));
    findings.push({ page: 'company detail', url: page.url(), textPreview: detailText.substring(0, 1500) });

    // Check for tabs
    const tabs = await page.evaluate(() => {
      const tabs = document.querySelectorAll('[role="tab"], [class*="tab"], [class*="Tab"]');
      return Array.from(tabs).map(t => ({ text: t.innerText?.trim(), classes: t.className?.substring(0, 100) })).slice(0, 10);
    });
    console.log('Tabs found on company detail:', JSON.stringify(tabs, null, 2));
    findings.push({ page: 'company detail tabs', tabs });
  }

  // ---- 6. USER DETAIL PAGE ----
  console.log('\n=== Investigating User Detail ===');
  await page.goto(`${BASE_URL}/users`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  const userRow = page.locator('table tr:not(:first-child)').first();
  const userRowExists = await userRow.isVisible().catch(() => false);
  if (userRowExists) {
    await userRow.click().catch(() => {});
    await page.waitForTimeout(2000);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-05-user-detail.png'), fullPage: true });
    const userDetailText = await page.evaluate(() => document.body.innerText.substring(0, 2000));
    console.log('User detail URL:', page.url());
    console.log('User detail text:', userDetailText.substring(0, 600));
    findings.push({ page: 'user detail', url: page.url(), textPreview: userDetailText.substring(0, 1500) });
  }

  // ---- 7. ANALYTICS PAGE ----
  console.log('\n=== Investigating /analytics ===');
  await page.goto(`${BASE_URL}/analytics`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(3000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-06-analytics.png'), fullPage: true });
  const analyticsText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Analytics text:', analyticsText.substring(0, 800));
  findings.push({ page: '/analytics', textPreview: analyticsText.substring(0, 1500) });

  // ---- 8. AUDIT PAGE ----
  console.log('\n=== Investigating /audit ===');
  await page.goto(`${BASE_URL}/audit`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-07-audit.png'), fullPage: true });
  const auditText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Audit text:', auditText.substring(0, 800));
  findings.push({ page: '/audit', textPreview: auditText.substring(0, 1500) });

  // ---- 9. SETTINGS PAGE ----
  console.log('\n=== Investigating /settings ===');
  await page.goto(`${BASE_URL}/settings`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-08-settings.png'), fullPage: true });
  const settingsText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Settings text:', settingsText.substring(0, 800));
  findings.push({ page: '/settings', textPreview: settingsText.substring(0, 1500) });

  // ---- 10. TOOLS PAGE ----
  console.log('\n=== Investigating /tools ===');
  await page.goto(`${BASE_URL}/tools`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-09-tools.png'), fullPage: true });
  const toolsText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Tools text:', toolsText.substring(0, 800));
  findings.push({ page: '/tools', textPreview: toolsText.substring(0, 1500) });

  // ---- 11. CREATE PLAN MODAL ----
  console.log('\n=== Investigating Plans create modal ===');
  await page.goto(`${BASE_URL}/billing/plans`, { waitUntil: 'networkidle', timeout: 15000 });
  await page.waitForTimeout(2000);
  await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-10-plans-before.png'), fullPage: false });
  const plansText = await page.evaluate(() => document.body.innerText.substring(0, 3000));
  console.log('Plans page text:', plansText.substring(0, 800));

  // Find all buttons
  const planButtons = await page.evaluate(() => {
    return Array.from(document.querySelectorAll('button')).map(b => ({
      text: b.innerText?.trim()?.substring(0, 60),
      classes: b.className?.substring(0, 100),
      visible: b.offsetParent !== null,
    })).filter(b => b.text && b.visible).slice(0, 20);
  });
  console.log('Plans page buttons:', JSON.stringify(planButtons, null, 2));

  // Click create
  const createBtn = page.locator('button:has-text("Create"), button:has-text("New Plan"), button:has-text("Add Plan"), button:has-text("New"), button:has-text("+ Plan")').first();
  const createExists = await createBtn.isVisible().catch(() => false);
  if (createExists) {
    await createBtn.click();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: join(SCREENSHOT_DIR, 'deep-11-plans-modal.png'), fullPage: false });
    const modalText = await page.evaluate(() => {
      const modal = document.querySelector('[role="dialog"], [class*="modal"], [class*="Modal"], [class*="dialog"]');
      return modal ? modal.innerText?.substring(0, 1000) : 'No modal found';
    });
    console.log('Modal text after click:', modalText);
    findings.push({ page: '/billing/plans create modal', modalText, createBtnFound: createExists });
    await page.keyboard.press('Escape');
  }

  // ---- Write findings report ----
  const reportLines = [
    `# Admin QA Deep-Check Report`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
    ``,
  ];

  for (const f of findings) {
    reportLines.push(`## ${f.page}`);
    for (const [k, v] of Object.entries(f)) {
      if (k === 'page') continue;
      reportLines.push(`### ${k}`);
      reportLines.push('```');
      reportLines.push(typeof v === 'string' ? v : JSON.stringify(v, null, 2));
      reportLines.push('```');
    }
    reportLines.push('');
  }

  writeFileSync(DEEP_REPORT_PATH, reportLines.join('\n'));
  console.log('\nDeep report saved to:', DEEP_REPORT_PATH);

  await browser.close();
}

run().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
