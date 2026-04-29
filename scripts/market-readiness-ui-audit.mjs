import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const BASE_URL = process.env.QA_BASE_URL ?? 'http://localhost:3200';
const COMPANY_ID = process.env.COMPANY_ID_ISADEMO2 ?? '00000000-0000-0000-0000-0000000d4e02';
const ADMIN_EMAIL = process.env.QA_ADMIN_EMAIL ?? process.env.E2E_ADMIN_EMAIL ?? 'admin@isaflow.co.za';
const ADMIN_PASSWORD = process.env.QA_ADMIN_PASSWORD ?? process.env.E2E_ADMIN_PASSWORD ?? 'admin123';

async function login(page) {
  const res = await page.request.post(`${BASE_URL}/api/auth/login`, {
    data: { email: ADMIN_EMAIL, password: ADMIN_PASSWORD },
  });
  const body = await res.json().catch(async () => ({ raw: await res.text().catch(() => '') }));
  if (res.status() !== 200 || body?.success !== true) {
    throw new Error(`Login failed: HTTP ${res.status()} ${JSON.stringify(body).slice(0, 500)}`);
  }
  return {
    email: body.data?.user?.email ?? ADMIN_EMAIL,
    userId: body.data?.user?.id,
    activeCompanyId: body.data?.activeCompanyId,
  };
}

const routes = [
  '/accounting',
  '/accounting/customers',
  '/accounting/customers/new',
  '/accounting/customer-invoices',
  '/accounting/customer-invoices/new',
  '/accounting/customer-payments',
  '/accounting/customer-payments/new',
  '/accounting/suppliers',
  '/accounting/suppliers/new',
  '/accounting/supplier-invoices',
  '/accounting/supplier-invoices/new',
  '/accounting/bank-accounts',
  '/accounting/bank-transactions',
  '/accounting/bank-reconciliation',
  '/accounting/bank-reconciliation/rules',
  '/accounting/chart-of-accounts',
  '/accounting/journal-entries',
  '/accounting/journal-entries/new',
  '/accounting/reports/trial-balance',
  '/accounting/reports/vat-return',
  '/accounting/reports/income-statement',
  '/accounting/reports/balance-sheet',
  '/accounting/company-settings',
  '/accounting/accounting-settings',
  '/accounting/practice/clients',
  '/accounting/practice/time-entry',
  '/accounting/practice/approvals',
  '/accounting/practice/wip',
  '/payroll/employees',
  '/payroll/runs',
];

const workflowRoutes = [
  { name: 'customer invoice creation form', path: '/accounting/customer-invoices/new', terms: ['Customer', 'Invoice', 'Total'], actions: ['Save', 'Create', 'Record'] },
  { name: 'customer payment form', path: '/accounting/customer-payments/new', terms: ['Payment', 'Customer'], actions: ['Record', 'Save', 'Allocate', 'Payment'] },
  { name: 'supplier invoice capture form', path: '/accounting/supplier-invoices/new', terms: ['Supplier', 'Invoice', 'Total'], actions: ['Save', 'Create', 'Record'] },
  { name: 'bank rules', path: '/accounting/bank-reconciliation/rules', terms: ['Rule', 'Bank'], actions: ['Add Rule', 'New Rule', 'Create Rule', 'Save'] },
  { name: 'company settings', path: '/accounting/company-settings', terms: ['Company', 'Settings'], actions: ['Save', 'Update'] },
  { name: 'practice time entry', path: '/accounting/practice/time-entry', terms: ['Time', 'Client'], actions: ['Save Entry', 'Submit Day', 'Fill Range'] },
];

function hasPageError(text) {
  return /\b(internal server error|application error|runtime error)\b/i.test(text)
    || /\b(404|500)\b\s*[:,-]?\s*(page )?(not found|error)/i.test(text)
    || /\b(page not found|not found page)\b/i.test(text);
}

function isAbortNoise(req) {
  return req.failure()?.errorText === 'net::ERR_ABORTED';
}

function isNavigationFetchNoise(message) {
  return message.includes('next/dist/shared/lib/router/router.js')
    || message.trim() === 'TypeError: Failed to fetch';
}

async function inspectPage(page, route, outDir) {
  const url = `${BASE_URL}${route}`;
  const result = {
    route,
    finalUrl: null,
    status: null,
    title: null,
    screenshot: null,
    bodySample: null,
    counts: {},
    problems: [],
    failedRequests: [],
    consoleErrors: [],
  };

  const onConsole = (msg) => {
    if (msg.type() === 'error') result.consoleErrors.push(msg.text().slice(0, 500));
  };
  const onRequestFailed = (req) => {
    if (isAbortNoise(req)) return;
    result.failedRequests.push({ url: req.url(), failure: req.failure()?.errorText ?? 'unknown' });
  };
  const onResponse = (res) => {
    const status = res.status();
    const reqUrl = res.url();
    if (status >= 400 && !reqUrl.includes('/_next/static')) {
      result.failedRequests.push({ url: reqUrl, status });
    }
  };

  page.on('console', onConsole);
  page.on('requestfailed', onRequestFailed);
  page.on('response', onResponse);
  try {
    const response = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });
    result.status = response?.status() ?? null;
    await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
    await page.waitForTimeout(500);
    result.finalUrl = page.url();
    result.title = await page.title();
    const bodyText = await page.locator('body').innerText({ timeout: 5000 }).catch(() => '');
    result.bodySample = bodyText.replace(/\s+/g, ' ').slice(0, 500);
    result.counts = await page.evaluate(() => {
      const visible = (el) => {
        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
      };
      const buttons = Array.from(document.querySelectorAll('button')).filter(visible);
      const links = Array.from(document.querySelectorAll('a')).filter(visible);
      const inputs = Array.from(document.querySelectorAll('input, select, textarea')).filter(visible);
      const dialogs = Array.from(document.querySelectorAll('[role="dialog"], dialog')).filter(visible);
      return {
        buttons: buttons.length,
        disabledButtons: buttons.filter((b) => b.disabled || b.getAttribute('aria-disabled') === 'true').length,
        links: links.length,
        emptyLinks: links.filter((a) => !a.getAttribute('href') || a.getAttribute('href') === '#').length,
        inputs: inputs.length,
        dialogs: dialogs.length,
        buttonLabels: buttons.slice(0, 12).map((b) => b.innerText.trim() || b.getAttribute('aria-label') || '(unlabelled)'),
      };
    });
    if (result.failedRequests.length === 0) {
      result.consoleErrors = result.consoleErrors.filter((message) => !isNavigationFetchNoise(message));
    }
    if (result.finalUrl.includes('/login')) result.problems.push('redirected to login');
    if (result.finalUrl.includes('/onboarding')) result.problems.push('redirected to onboarding');
    if (result.status && result.status >= 400) result.problems.push(`page returned HTTP ${result.status}`);
    if (hasPageError(bodyText)) result.problems.push('body contains page-level error language');
    if (result.consoleErrors.length > 0) result.problems.push(`${result.consoleErrors.length} console error(s)`);
    if (result.failedRequests.some((r) => r.status >= 500)) result.problems.push('one or more 5xx network responses');
    const name = route.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '') || 'root';
    const screenshot = path.join(outDir, `${name}.png`);
    await page.screenshot({ path: screenshot, fullPage: true }).catch(() => null);
    result.screenshot = path.relative(ROOT, screenshot);
  } catch (err) {
    result.problems.push(err instanceof Error ? err.message : String(err));
  } finally {
    page.off('console', onConsole);
    page.off('requestfailed', onRequestFailed);
    page.off('response', onResponse);
  }
  return result;
}

async function inspectWorkflow(page, spec) {
  const result = { name: spec.name, path: spec.path, problems: [], evidence: {} };
  await page.goto(`${BASE_URL}${spec.path}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => null);
  const text = await page.locator('body').innerText().catch(() => '');
  const lowerText = text.toLowerCase();
  result.evidence.terms = Object.fromEntries(spec.terms.map((term) => [term, lowerText.includes(term.toLowerCase())]));
  const formControls = await page.locator('input:visible, select:visible, textarea:visible, [role="combobox"]:visible').count();
  const buttons = await page.locator('button:visible').evaluateAll((els) => els.map((el) => ({
    text: el.textContent?.trim() ?? '',
    aria: el.getAttribute('aria-label') ?? '',
    type: el.getAttribute('type') ?? '',
  })));
  const actionTerms = spec.actions ?? ['Save', 'Create', 'Record'];
  const actionButtons = buttons.filter((button) => {
    const label = `${button.text} ${button.aria}`.toLowerCase();
    return button.type === 'submit' || actionTerms.some((term) => label.includes(term.toLowerCase()));
  });
  result.evidence.formControls = formControls;
  result.evidence.actionButtons = actionButtons.length;
  result.evidence.actionLabels = actionButtons.slice(0, 8).map((button) => button.text || button.aria || '(unlabelled)');
  if (formControls === 0) result.problems.push('no visible form controls found');
  if (actionButtons.length === 0) result.problems.push(`no expected action button found: ${actionTerms.join(' / ')}`);
  for (const [term, present] of Object.entries(result.evidence.terms)) {
    if (!present) result.problems.push(`missing expected workflow term: ${term}`);
  }
  return result;
}

async function main() {
  fs.mkdirSync(path.join(ROOT, 'qa-reports'), { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(ROOT, 'qa-reports', `market-ui-${stamp}`);
  fs.mkdirSync(outDir, { recursive: true });

  console.log(`Target: ${BASE_URL}`);
  console.log(`Tenant: ${COMPANY_ID}`);

  const storageState = process.env.AUDIT_STORAGE_STATE;
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...(storageState ? { storageState } : {}),
  });
  const page = await context.newPage();
  const session = storageState ? { email: `${ADMIN_EMAIL} (storage state)` } : await login(page);
  console.log(`Auth user: ${session.email}${session.userId ? ` (${session.userId})` : ''}`);
  if (session.activeCompanyId && session.activeCompanyId !== COMPANY_ID) {
    console.log(`Login active company was ${session.activeCompanyId}; overriding to ${COMPANY_ID}`);
  }

  const cookies = [
    { name: 'active_company_id', value: COMPANY_ID, url: BASE_URL, httpOnly: true, sameSite: 'Lax' },
    { name: 'ff_onboarding_done', value: '1', url: BASE_URL, sameSite: 'Lax' },
  ];
  await context.addCookies(cookies);
  const authProbe = await page.request.get(`${BASE_URL}/api/auth/me`);
  if (authProbe.status() !== 200) {
    const body = await authProbe.text().catch(() => '');
    console.log(`Auth probe failed: HTTP ${authProbe.status()} ${body.slice(0, 300)}`);
  }

  const pages = [];
  for (const route of routes) {
    console.log(`[page] ${route}`);
    pages.push(await inspectPage(page, route, outDir));
  }

  const workflows = [];
  for (const spec of workflowRoutes) {
    console.log(`[workflow] ${spec.name}`);
    workflows.push(await inspectWorkflow(page, spec));
  }

  await browser.close();

  const summary = {
    pages: pages.length,
    pageProblems: pages.filter((p) => p.problems.length > 0).length,
    workflows: workflows.length,
    workflowProblems: workflows.filter((w) => w.problems.length > 0).length,
  };
  const report = { generatedAt: new Date().toISOString(), target: BASE_URL, companyId: COMPANY_ID, summary, pages, workflows };
  const jsonPath = path.join(ROOT, 'qa-reports', `market-readiness-ui-${stamp}.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(report, null, 2));
  const mdPath = path.join(ROOT, 'qa-reports', `market-readiness-ui-${stamp}.md`);
  const lines = [
    '# Market Readiness UI Audit',
    '',
    `Target: ${BASE_URL}`,
    `Tenant: ${COMPANY_ID}`,
    `Generated: ${report.generatedAt}`,
    '',
    `Summary: ${summary.pages} pages, ${summary.pageProblems} with problems; ${summary.workflows} workflow forms, ${summary.workflowProblems} with problems.`,
    '',
    '## Page Findings',
    ...pages.map((p) => `- ${p.problems.length ? 'FAIL' : 'PASS'} ${p.route} -> ${p.status} ${p.finalUrl}${p.problems.length ? `; ${p.problems.join('; ')}` : ''}`),
    '',
    '## Workflow Findings',
    ...workflows.map((w) => `- ${w.problems.length ? 'FAIL' : 'PASS'} ${w.name} (${w.path})${w.problems.length ? `; ${w.problems.join('; ')}` : ''}`),
    '',
    `Screenshots: ${path.relative(ROOT, outDir)}`,
    `JSON: ${path.relative(ROOT, jsonPath)}`,
  ];
  fs.writeFileSync(mdPath, `${lines.join('\n')}\n`);
  console.log(`Summary: ${JSON.stringify(summary)}`);
  console.log(`Reports:\n  ${mdPath}\n  ${jsonPath}\n  ${outDir}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
