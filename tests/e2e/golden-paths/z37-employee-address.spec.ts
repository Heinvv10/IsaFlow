// golden:dev-only
/**
 * Golden path (z37): an employee's residential and postal address (master plan wave 7, EA1; W5 part 1; Hein's ruling 10).
 *
 *  - Staff side, in a sandbox company: the profile's Address card. A bad ZA postal code is refused on its field with the
 *    BRS message (code 3217) and nothing is sent; a good address is saved through the real PUT and the card shows the
 *    residential and postal lines; the "Record changes" timeline shows the address keys masked (no street in plain text).
 *  - Create form: the address typed on /payroll/employees/new (optional section in Personal details) is refused on its
 *    field when the BRS rules refuse it (nothing is created), then saved through the same PUT once the employee exists;
 *    the new profile's card shows it.
 *  - Portal side: "Your details" renders the address and the bank as name + last four, with no edit control, against
 *    page.route'd portal answers (the server side, own-employee only and the masks, is proven by
 *    tests/integration/w7-ea1-portal-details.int.test.ts). Nothing is sent or invited.
 *  - axe reports 0 critical and 0 serious, in both themes, at 1568 and 390, and no sideways scroll at 390.
 *    EVIDENCE_DIR=<dir> saves screenshots.
 *
 * Dev only: it writes one employee and its address in its own sandbox company, never in Demo.
 */
import { expect, test, type Locator, type Page } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { seedTheme, settle, THEMES } from '../helpers/themeSpec';

const EVIDENCE_DIR = process.env.EVIDENCE_DIR;
const SANDBOX = { name: '0GP Golden Employee Address Sandbox', onboardingId: 'c37a1e5d-2b84-4f19-9e6a-7d3b5c1f8a24' };
const EMPLOYEE = { employeeNumber: 'Z37-1', firstName: 'Zinhle', lastName: 'Address' };
const ok = (data: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data }) });

let sandboxId = '';
let employeeId = '';

async function seriousAxe(page: Page): Promise<string[]> {
  return (await new AxeBuilder({ page }).analyze()).violations
    .filter((v) => v.impact === 'serious' || v.impact === 'critical')
    .flatMap((v) => v.nodes.map((n) => `${v.id} (${v.impact}): ${n.target.join(' ')}`));
}

/** `shots`: the parts to photograph (the app pages scroll inside the layout, so a full-page shot shows the top only). */
async function checkWidths(page: Page, name: string, theme: string, shots: Locator[] = []): Promise<void> {
  await settle(page);
  for (const width of [1568, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    if (EVIDENCE_DIR && shots.length === 0) await page.screenshot({ path: `${EVIDENCE_DIR}/${name}-${theme}-${width}.png`, fullPage: true });
    for (const [i, shot] of shots.entries()) {
      await shot.scrollIntoViewIfNeeded();
      if (EVIDENCE_DIR) await shot.screenshot({ path: `${EVIDENCE_DIR}/${name}${i ? `-part${i + 1}` : ''}-${theme}-${width}.png` });
    }
    expect(await seriousAxe(page), `axe ${name} ${theme} ${width}`).toEqual([]);
    if (width === 390) {
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), `${name} sideways scroll at 390`).toBe(true);
    }
  }
  await page.setViewportSize({ width: 1568, height: 1000 });
}

test.beforeAll(async ({ baseURL }) => {
  const u = new URL(baseURL!);
  expect(u.hostname === 'localhost' && u.port !== '3101', `z37 writes payroll data: dev/CI localhost only, not ${u.host}`).toBe(true);
  const api = await Api.login(baseURL!);
  try {
    sandboxId = await findOrCreateSandbox(api, SANDBOX);
    await switchApiCompany(api, sandboxId);
    const existing = await api.get<Array<{ id: string; employeeNumber: string }>>('/api/payroll/employees?limit=50');
    employeeId = existing.find((e) => e.employeeNumber === EMPLOYEE.employeeNumber)?.id
      ?? (await api.post<{ id: string }>('/api/payroll/employees', { ...EMPLOYEE, employmentType: 'permanent', startDate: '2024-01-01' })).id;
  } finally {
    await api.dispose();
  }
});

for (const theme of THEMES) {
  test(`staff: capture the address on the profile, BRS refusal on its field, masked in the history (${theme})`, async ({ page, context }) => {
    await switchBrowserCompany(context, sandboxId);
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/address')) puts.push(r.url()); });
    await seedTheme(page, theme);
    await page.goto(`/payroll/employees/${employeeId}`);
    const card = page.getByTestId('employee-address-card');
    await expect(card).toBeVisible({ timeout: 90_000 });
    await card.getByRole('button', { name: /^(Add|Change) address$/ }).click();
    const street = `${theme === 'light' ? 'Kingfisher' : 'Heron'} Avenue`;
    await card.getByLabel('Unit number').fill('');
    await card.getByLabel('Complex').fill('');
    await card.getByLabel('Street number').fill('12');
    await card.getByLabel('Street or farm name *').fill(street);
    await card.getByLabel('Suburb or district').fill('Hatfield');
    await card.getByLabel('City or town').fill('Pretoria');
    await card.getByLabel('Postal code', { exact: true }).fill('28');
    await card.getByRole('button', { name: 'Save address' }).click();
    await expect(card.getByText('A South African postal code is four digits and not 0000 (code 3217)')).toBeVisible();
    expect(puts).toEqual([]);
    await checkWidths(page, 'z37-address-form-error', theme, [card]);

    await card.getByLabel('Postal code', { exact: true }).fill('0028');
    const same = card.getByLabel('Same as the residential address');
    if (await same.isChecked()) await same.uncheck();
    await card.getByLabel('Postal address line 1 *').fill('PO Box 4711');
    await card.getByLabel('Postal address line 2').fill('Brooklyn Square');
    await card.getByLabel('Postal code (postal address)').fill('0075');
    await card.getByRole('button', { name: 'Save address' }).click();
    await expect(card.getByText(`12 ${street}`)).toBeVisible({ timeout: 30_000 });
    await expect(card.getByText('PO Box 4711')).toBeVisible();
    expect(puts).toHaveLength(1);

    const history = page.getByTestId('employee-change-history');
    await page.reload();
    await expect(history.getByText(/Residential street/).first()).toBeVisible({ timeout: 60_000 });
    expect(await history.innerText()).not.toContain(street);
    await checkWidths(page, 'z37-address-profile', theme, [card, history]);
  });

  test(`create form: the address on New Employee is checked, then saved to the new profile (${theme})`, async ({ page, context }) => {
    await switchBrowserCompany(context, sandboxId);
    const puts: string[] = [];
    page.on('request', (r) => { if (r.method() === 'PUT' && r.url().endsWith('/address')) puts.push(r.url()); });
    await seedTheme(page, theme);
    await page.goto('/payroll/employees/new');
    await expect(page.getByRole('heading', { name: 'New Employee', exact: true })).toBeVisible({ timeout: 90_000 });
    await page.getByLabel('First name *').fill('Zinhle');
    await page.getByLabel('Last name *').fill('Create');
    await page.getByLabel('Employee number *').fill(`Z37-${theme}-${Date.now()}`);
    const section = page.getByTestId('create-address');
    await section.getByLabel('Street or farm name').fill('Weaver Street');
    await section.getByLabel('Street number').fill('9');
    await section.getByLabel('City or town').fill('Pretoria');
    await section.getByLabel('Postal code', { exact: true }).fill('0000');
    await page.getByRole('button', { name: 'Create Employee' }).click();
    await expect(section.getByText('A South African postal code is four digits and not 0000 (code 3217)')).toBeVisible();
    expect(page.url()).toMatch(/\/payroll\/employees\/new$/);
    await checkWidths(page, 'z37-create-address-error', theme, [section]);
    await section.getByLabel('Postal code', { exact: true }).fill('0181');
    await page.getByRole('button', { name: 'Create Employee' }).click();
    await page.waitForURL(/\/payroll\/employees\/[0-9a-f-]{36}$/, { timeout: 60_000 });
    const card = page.getByTestId('employee-address-card');
    await expect(card.getByText('9 Weaver Street')).toBeVisible({ timeout: 60_000 });
    await expect(card.getByText('Pretoria 0181')).toBeVisible();
    expect(puts).toHaveLength(1);
    await checkWidths(page, 'z37-create-address-saved', theme, [card]);
  });

  test(`portal: "Your details" shows the address and bank last four, read-only (${theme})`, async ({ page }) => {
    const me = {
      employeeName: 'Zinhle Address', employeeNumber: 'Z37-1', employer: 'Z37 Sandbox (Pty) Ltd',
      address: {
        residential: { unitNumber: '4', complex: 'Oak Court', streetNumber: '12', street: 'Kingfisher Avenue', suburb: 'Hatfield', city: 'Pretoria', postalCode: '0028', countryCode: 'ZA' },
        postal: { sameAsResidential: false, line1: 'PO Box 4711', line2: 'Brooklyn Square', line3: null, line4: null, postalCode: '0075', countryCode: 'ZA' },
      },
      bank: { bankName: 'FNB', accountLast4: '3456' },
    };
    await page.route('**/api/employee-portal/me', (route) => route.fulfill(ok(me)));
    await page.route('**/api/employee-portal/payslips', (route) => route.fulfill(ok([])));
    await page.route('**/api/employee-portal/leave', (route) => route.fulfill(ok([])));
    await page.route('**/api/employee-portal/irp5', (route) => route.fulfill(ok({ payFrequency: 'monthly', certificates: [] })));
    await seedTheme(page, theme);
    await page.goto('/employee-portal', { waitUntil: 'domcontentloaded' });
    const details = page.getByRole('region', { name: 'Your details' });
    await expect(details).toBeVisible({ timeout: 90_000 });
    await expect(details.getByText('12 Kingfisher Avenue')).toBeVisible();
    await expect(details.getByText('PO Box 4711')).toBeVisible();
    await expect(details.getByText('Account ending 3456')).toBeVisible();
    await expect(details.getByRole('button')).toHaveCount(0);
    await expect(details.getByRole('textbox')).toHaveCount(0);
    await checkWidths(page, 'z37-portal-details', theme);
  });
}
