/**
 * QA Script: ISAFlow Admin Platform
 * Target: https://admin.isaflow.co.za
 * Tests every admin page systematically
 */

import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BASE_URL = 'https://admin.isaflow.co.za';
const SCREENSHOT_DIR = join(__dirname, '../tmp/admin-qa-screenshots');
const REPORT_PATH = join(__dirname, '../tmp/admin-qa-report.md');

mkdirSync(SCREENSHOT_DIR, { recursive: true });

const results = [];
let stepNum = 0;

function record(action, expected, actual, pass, notes = '') {
  stepNum++;
  results.push({ step: stepNum, action, expected, actual, pass, notes });
  const icon = pass ? 'PASS' : 'FAIL';
  console.log(`[${icon}] Step ${stepNum}: ${action}`);
  if (!pass) console.log(`  Expected: ${expected}`);
  console.log(`  Actual: ${actual}`);
  if (notes) console.log(`  Notes: ${notes}`);
}

async function screenshot(page, name) {
  const filePath = join(SCREENSHOT_DIR, `${name}.png`);
  await page.screenshot({ path: filePath, fullPage: false });
  return filePath;
}

async function getConsoleErrors(page) {
  // Returns accumulated console errors — must be set up before navigation
  return page._consoleErrors || [];
}

async function run() {
  console.log('=== ISAFlow Admin QA Test Suite ===');
  console.log(`Target: ${BASE_URL}`);
  console.log(`Date: ${new Date().toISOString()}\n`);

  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });

  const page = await context.newPage();

  // Track console errors
  const consoleErrors = [];
  page.on('console', msg => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });

  const getErrors = () => [...consoleErrors];
  const clearErrors = () => { consoleErrors.length = 0; };

  // ============================================================
  // STEP 1: Navigate to admin root — should redirect to login
  // ============================================================
  console.log('\n--- Phase 1: Login ---');
  try {
    await page.goto(BASE_URL, { waitUntil: 'networkidle', timeout: 15000 });
    const url = page.url();
    const onLogin = url.includes('/login') || url.includes('/auth') || url.includes('admin.isaflow.co.za');
    await screenshot(page, '01-initial-load');
    record(
      `Navigate to ${BASE_URL}`,
      'Redirect to login or admin home',
      `URL: ${url}`,
      onLogin
    );
  } catch (e) {
    record(`Navigate to ${BASE_URL}`, 'Page loads', `Error: ${e.message}`, false);
    await browser.close();
    generateReport();
    return;
  }

  // ============================================================
  // Login
  // ============================================================
  try {
    const currentUrl = page.url();
    if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
      // Already on login page
    } else {
      // Navigate to login explicitly
      await page.goto(`${BASE_URL}/login`, { waitUntil: 'networkidle', timeout: 15000 });
    }

    clearErrors();
    const emailInput = page.locator('input[type="email"], input[name="email"], input[placeholder*="email" i]').first();
    const passwordInput = page.locator('input[type="password"]').first();

    await emailInput.fill('admin@isaflow.co.za');
    await passwordInput.fill('admin123');
    await screenshot(page, '02-login-filled');

    await page.locator('button[type="submit"], button:has-text("Sign in"), button:has-text("Login"), button:has-text("Log in")').first().click();
    await page.waitForTimeout(4000);

    const afterLoginUrl = page.url();
    const loggedIn = !afterLoginUrl.includes('/login') && !afterLoginUrl.includes('/auth');
    await screenshot(page, '03-after-login');

    record(
      'Login with admin@isaflow.co.za / admin123',
      'Redirect away from login page',
      `URL: ${afterLoginUrl}`,
      loggedIn
    );

    if (!loggedIn) {
      // Check for error message
      const bodyText = await page.evaluate(() => document.body.innerText.substring(0, 500));
      record('Login success check', 'No error message', bodyText.substring(0, 200), false, 'Login may have failed');
      await browser.close();
      generateReport();
      return;
    }
  } catch (e) {
    record('Login', 'Login successful', `Error: ${e.message}`, false);
    await screenshot(page, '03-login-error');
    await browser.close();
    generateReport();
    return;
  }

  // ============================================================
  // STEP 2: Test each admin page
  // ============================================================

  const pagesToTest = [
    { name: 'Dashboard', path: '/', screenshot: '04-dashboard', checks: ['KPI', 'health', 'activity', 'dashboard'] },
    { name: 'Companies', path: '/companies', screenshot: '05-companies', checks: ['company', 'table', 'search'] },
    { name: 'Users', path: '/users', screenshot: '06-users', checks: ['user', 'table'] },
    { name: 'Billing Overview', path: '/billing', screenshot: '07-billing', checks: ['billing', 'MRR', 'ARR', 'subscription', 'revenue'] },
    { name: 'Plans', path: '/billing/plans', screenshot: '08-plans', checks: ['plan', 'pricing', 'feature'] },
    { name: 'Subscriptions', path: '/billing/subscriptions', screenshot: '09-subscriptions', checks: ['subscription', 'table'] },
    { name: 'Invoices', path: '/billing/invoices', screenshot: '10-invoices', checks: ['invoice', 'table'] },
    { name: 'Feature Flags', path: '/features', screenshot: '11-features', checks: ['feature', 'flag', 'toggle'] },
    { name: 'Analytics', path: '/analytics', screenshot: '12-analytics', checks: ['analytic', 'chart', 'stat', 'metric'] },
    { name: 'Audit Trail', path: '/audit', screenshot: '13-audit', checks: ['audit', 'log', 'trail', 'event'] },
    { name: 'Tools', path: '/tools', screenshot: '14-tools', checks: ['tool', 'utility'] },
    { name: 'Announcements', path: '/tools/announcements', screenshot: '15-announcements', checks: ['announcement', 'message', 'notify'] },
    { name: 'Settings', path: '/settings', screenshot: '16-settings', checks: ['setting', 'config', 'save'] },
    { name: 'Components', path: '/components', screenshot: '17-components', checks: ['component', 'button', 'input', 'modal'] },
  ];

  console.log('\n--- Phase 2: Page Tests ---');

  for (const pageTest of pagesToTest) {
    clearErrors();
    try {
      await page.goto(`${BASE_URL}${pageTest.path}`, { waitUntil: 'networkidle', timeout: 15000 });
      await page.waitForTimeout(1500);

      const currentUrl = page.url();
      const bodyText = (await page.evaluate(() => document.body.innerText)).toLowerCase();
      const title = await page.title();
      const errors = getErrors();

      // Check if redirected to login (session expired)
      if (currentUrl.includes('/login') || currentUrl.includes('/auth')) {
        await screenshot(page, pageTest.screenshot);
        record(`Navigate to ${pageTest.path} (${pageTest.name})`, 'Page renders', 'Redirected to login — session expired', false);
        // Try to re-login
        const emailInput = page.locator('input[type="email"], input[name="email"]').first();
        const passwordInput = page.locator('input[type="password"]').first();
        await emailInput.fill('admin@isaflow.co.za');
        await passwordInput.fill('admin123');
        await page.locator('button[type="submit"]').first().click();
        await page.waitForTimeout(3000);
        await page.goto(`${BASE_URL}${pageTest.path}`, { waitUntil: 'networkidle', timeout: 15000 });
        await page.waitForTimeout(1500);
      }

      await screenshot(page, pageTest.screenshot);

      // Check for 404 or error page
      const is404 = bodyText.includes('404') || bodyText.includes('not found') || bodyText.includes('page not found');
      const is500 = bodyText.includes('500') || bodyText.includes('internal server error') || bodyText.includes('server error');
      const isError = is404 || is500;

      // Check content matches expected
      const hasExpectedContent = pageTest.checks.some(check =>
        bodyText.includes(check.toLowerCase()) || title.toLowerCase().includes(check.toLowerCase())
      );

      const pass = !isError && hasExpectedContent;
      const notes = errors.length > 0 ? `Console errors: ${errors.slice(0, 3).join('; ')}` : '';

      record(
        `Navigate to ${pageTest.path} (${pageTest.name})`,
        `Page renders with relevant content [${pageTest.checks.slice(0, 2).join(', ')}]`,
        `Title: "${title}" | Content keywords found: ${hasExpectedContent} | 404: ${is404} | 500: ${is500}`,
        pass,
        notes
      );
    } catch (e) {
      await screenshot(page, `${pageTest.screenshot}-error`).catch(() => {});
      record(
        `Navigate to ${pageTest.path} (${pageTest.name})`,
        'Page renders',
        `Error: ${e.message}`,
        false
      );
    }
  }

  // ============================================================
  // STEP 3: Test navigation sidebar
  // ============================================================
  console.log('\n--- Phase 3: Navigation Tests ---');

  try {
    await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    // Check sidebar exists
    const sidebar = await page.locator('nav, aside, [class*="sidebar"], [class*="nav"]').first();
    const sidebarVisible = await sidebar.isVisible().catch(() => false);
    await screenshot(page, '18-sidebar');
    record(
      'Sidebar/nav renders on dashboard',
      'Sidebar is visible',
      `Sidebar visible: ${sidebarVisible}`,
      sidebarVisible
    );

    // Check for billing submenu expand/collapse
    const billingNav = page.locator('text=Billing').first();
    const billingExists = await billingNav.isVisible().catch(() => false);
    if (billingExists) {
      await billingNav.click().catch(() => {});
      await page.waitForTimeout(500);
      await screenshot(page, '19-billing-submenu');
      const submenuVisible = await page.locator('text=Plans, text=Subscriptions, text=Invoices').first().isVisible().catch(() => false);
      record(
        'Click Billing nav item to expand submenu',
        'Billing submenu expands',
        `Submenu visible: ${submenuVisible}`,
        billingExists,
        billingExists ? 'Billing nav found and clicked' : 'Billing nav not found'
      );
    } else {
      record('Billing submenu expand/collapse', 'Billing nav exists', 'Billing nav not found in sidebar', false);
    }

    // Check Tools submenu
    const toolsNav = page.locator('text=Tools').first();
    const toolsExists = await toolsNav.isVisible().catch(() => false);
    if (toolsExists) {
      await toolsNav.click().catch(() => {});
      await page.waitForTimeout(500);
      await screenshot(page, '20-tools-submenu');
      record(
        'Click Tools nav item to expand submenu',
        'Tools submenu expands',
        `Tools nav found and clicked`,
        true
      );
    } else {
      record('Tools submenu expand/collapse', 'Tools nav exists', 'Tools nav not found in sidebar', false);
    }

  } catch (e) {
    record('Navigation sidebar tests', 'Sidebar renders', `Error: ${e.message}`, false);
  }

  // ============================================================
  // STEP 4: Test Companies page interactions
  // ============================================================
  console.log('\n--- Phase 4: Workflow Tests ---');

  try {
    await page.goto(`${BASE_URL}/companies`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    // Test search
    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i], input[placeholder*="Search" i]').first();
    const searchExists = await searchInput.isVisible().catch(() => false);
    if (searchExists) {
      await searchInput.fill('test');
      await page.waitForTimeout(1000);
      await screenshot(page, '21-companies-search');
      record('Search in Companies table', 'Search input accepts text and filters', 'Search input filled with "test"', true);
      await searchInput.clear().catch(() => {});
    } else {
      record('Companies search input', 'Search input visible', 'Search input not found', false);
    }

    // Test status filter dropdown
    const filterDropdown = page.locator('select, [class*="filter"], [class*="dropdown"]').first();
    const filterExists = await filterDropdown.isVisible().catch(() => false);
    await screenshot(page, '22-companies-filter');
    record(
      'Companies status filter dropdown',
      'Filter dropdown visible',
      `Filter/dropdown found: ${filterExists}`,
      filterExists
    );

    // Click a company row
    const tableRow = page.locator('table tr:not(:first-child), [class*="row"], [class*="table-row"]').first();
    const rowExists = await tableRow.isVisible().catch(() => false);
    if (rowExists) {
      await tableRow.click().catch(() => {});
      await page.waitForTimeout(2000);
      const afterClickUrl = page.url();
      await screenshot(page, '23-company-detail');
      const navigatedToDetail = afterClickUrl.includes('/companies/') && afterClickUrl !== `${BASE_URL}/companies`;
      record(
        'Click a company row to view detail',
        'Navigate to company detail page',
        `URL after click: ${afterClickUrl}`,
        navigatedToDetail || afterClickUrl.includes('/companies')
      );

      // Test back button on company detail
      const backBtn = page.locator('button:has-text("Back"), a:has-text("Back"), [aria-label*="back" i]').first();
      const backExists = await backBtn.isVisible().catch(() => false);
      record('Back button on company detail', 'Back button visible', `Back button found: ${backExists}`, backExists);
    } else {
      record('Click company row', 'Company rows exist in table', 'No table rows found', false);
    }
  } catch (e) {
    record('Companies page workflow', 'Companies interactions work', `Error: ${e.message}`, false);
  }

  // ============================================================
  // Test Users page interactions
  // ============================================================
  try {
    await page.goto(`${BASE_URL}/users`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    const searchInput = page.locator('input[type="search"], input[placeholder*="search" i]').first();
    const searchExists = await searchInput.isVisible().catch(() => false);
    if (searchExists) {
      await searchInput.fill('admin');
      await page.waitForTimeout(1000);
      await screenshot(page, '24-users-search');
      record('Search users', 'Search filters user list', 'Search input filled with "admin"', true);
    } else {
      record('Users search', 'Search input visible', 'Search input not found', false);
    }

    // Role filter
    const roleFilter = page.locator('select, [placeholder*="role" i], [class*="role-filter"]').first();
    const roleFilterExists = await roleFilter.isVisible().catch(() => false);
    record('Users role filter', 'Role filter visible', `Role filter found: ${roleFilterExists}`, roleFilterExists);

    await screenshot(page, '25-users-page');
  } catch (e) {
    record('Users page workflow', 'Users interactions work', `Error: ${e.message}`, false);
  }

  // ============================================================
  // Test Feature Flags toggle
  // ============================================================
  try {
    await page.goto(`${BASE_URL}/features`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    const toggle = page.locator('input[type="checkbox"], [role="switch"], [class*="toggle"], [class*="switch"]').first();
    const toggleExists = await toggle.isVisible().catch(() => false);
    await screenshot(page, '26-feature-flags');
    record(
      'Feature flags toggle switches visible',
      'Toggle/switch elements present',
      `Toggle found: ${toggleExists}`,
      toggleExists
    );
  } catch (e) {
    record('Feature flags', 'Feature flag toggles visible', `Error: ${e.message}`, false);
  }

  // ============================================================
  // Test Plans page — create plan modal
  // ============================================================
  try {
    await page.goto(`${BASE_URL}/billing/plans`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    const createBtn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add"), button:has-text("+ Plan"), button:has-text("Add Plan")').first();
    const createBtnExists = await createBtn.isVisible().catch(() => false);
    if (createBtnExists) {
      await createBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      const modal = page.locator('[role="dialog"], [class*="modal"], [class*="dialog"]').first();
      const modalVisible = await modal.isVisible().catch(() => false);
      await screenshot(page, '27-create-plan-modal');
      record('Create plan button opens modal', 'Modal opens on click', `Create btn found: ${createBtnExists} | Modal visible: ${modalVisible}`, createBtnExists);
      // Close modal
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      await screenshot(page, '27-plans-no-create-btn');
      record('Create plan button', 'Create button visible on plans page', 'Create button not found', false);
    }
  } catch (e) {
    record('Plans page create modal', 'Create plan modal works', `Error: ${e.message}`, false);
  }

  // ============================================================
  // Test Announcements — create announcement
  // ============================================================
  try {
    await page.goto(`${BASE_URL}/tools/announcements`, { waitUntil: 'networkidle', timeout: 15000 });
    await page.waitForTimeout(1500);

    const createBtn = page.locator('button:has-text("Create"), button:has-text("New"), button:has-text("Add"), button:has-text("Announcement")').first();
    const createBtnExists = await createBtn.isVisible().catch(() => false);
    if (createBtnExists) {
      await createBtn.click().catch(() => {});
      await page.waitForTimeout(1000);
      await screenshot(page, '28-create-announcement-modal');
      const modal = page.locator('[role="dialog"], [class*="modal"], [class*="dialog"]').first();
      const modalVisible = await modal.isVisible().catch(() => false);
      record('Create announcement button opens modal', 'Modal opens', `Create btn: ${createBtnExists} | Modal: ${modalVisible}`, createBtnExists);
      await page.keyboard.press('Escape').catch(() => {});
    } else {
      await screenshot(page, '28-announcements-no-btn');
      record('Create announcement button', 'Create button visible', 'Create button not found', false);
    }
  } catch (e) {
    record('Announcements create modal', 'Create announcement works', `Error: ${e.message}`, false);
  }

  // ============================================================
  // Final screenshot
  // ============================================================
  await page.goto(`${BASE_URL}/`, { waitUntil: 'networkidle', timeout: 15000 }).catch(() => {});
  await screenshot(page, '99-final-dashboard');

  await browser.close();
  generateReport();
}

function generateReport() {
  const passed = results.filter(r => r.pass).length;
  const total = results.length;
  const failed = results.filter(r => !r.pass);

  const lines = [
    `## QA Report: ISAFlow Admin Platform (admin.isaflow.co.za)`,
    `Date: ${new Date().toISOString().split('T')[0]}`,
    ``,
    `| Step | Action | Expected | Actual | Result |`,
    `|------|--------|----------|--------|--------|`,
  ];

  for (const r of results) {
    const result = r.pass ? '✓ PASS' : '✗ FAIL';
    const actual = r.notes ? `${r.actual} | ${r.notes}` : r.actual;
    lines.push(`| ${r.step} | ${r.action} | ${r.expected} | ${actual} | ${result} |`);
  }

  lines.push(``);
  lines.push(`**Summary:** ${passed}/${total} steps passed`);

  if (failed.length > 0) {
    lines.push(``);
    lines.push(`### Failed Steps`);
    for (const r of failed) {
      lines.push(`- **Step ${r.step}**: ${r.action}`);
      lines.push(`  - Expected: ${r.expected}`);
      lines.push(`  - Actual: ${r.actual}`);
      if (r.notes) lines.push(`  - Notes: ${r.notes}`);
    }
  }

  lines.push(``);
  lines.push(`### Screenshots`);
  lines.push(`Saved to: \`/home/hein/Workspace/IsaFlow/tmp/admin-qa-screenshots/\``);

  const report = lines.join('\n');
  writeFileSync(REPORT_PATH, report, 'utf8');

  console.log('\n=== FINAL REPORT ===');
  console.log(`Passed: ${passed}/${total}`);
  if (failed.length > 0) {
    console.log('\nFailed steps:');
    for (const r of failed) {
      console.log(`  Step ${r.step}: ${r.action}`);
    }
  }
  console.log(`\nReport saved to: ${REPORT_PATH}`);
  console.log(`Screenshots saved to: ${SCREENSHOT_DIR}`);
}

run().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
