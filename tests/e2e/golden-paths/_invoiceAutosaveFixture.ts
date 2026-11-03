/**
 * The sandbox company, customer and drafts the PR S invoice goldens share (z2-invoice-autosave-send,
 * z2b-invoice-held-back). Moved out of z2 unchanged.
 */
import { expect, type BrowserContext, type Page } from '@playwright/test';
import { Api } from './_api';
import { findOrCreateSandbox, switchApiCompany, switchBrowserCompany } from './_migrationSandbox';
import { todayInSast } from '../../../src/lib/saDateParser';
import { settle } from '../helpers/themeSpec';

// Every write here goes to this sandbox company, never to Demo (Willie uses Demo for QA).
const SANDBOX_NAME = '0GP Golden Invoice Form Sandbox';
const SANDBOX_ONBOARDING_ID = 'd6630d3e-22b5-4c1f-b872-262d940a869a'; // y1's and z1's company: one sandbox for the invoice form
export const CUSTOMER = { name: '0GP-Golden-Autosave-Customer', email: 'golden-z2@example.invalid', payment_terms: 0, payment_terms_type: 'days', default_discount: 0, default_vat_type: 'standard' };

export async function sandbox(context: BrowserContext, baseURL: string): Promise<{ api: Api; customerId: string }> {
  const api = await Api.login(baseURL);
  const id = await findOrCreateSandbox(api, { name: SANDBOX_NAME, onboardingId: SANDBOX_ONBOARDING_ID });
  await switchApiCompany(api, id);
  await switchBrowserCompany(context, id);
  const found = await api.get<{ id: string; name: string }[]>(`/api/accounting/customers?q=${encodeURIComponent(CUSTOMER.name)}`);
  const existing = found.find((c) => c.name === CUSTOMER.name);
  const customerId = existing?.id ?? (await api.post<{ id: string }>('/api/accounting/customers', CUSTOMER)).id;
  return { api, customerId };
}

export async function draft(api: Api, customerId: string, description: string): Promise<string> {
  const made = await api.post<{ id: string }>('/api/accounting/customer-invoices-create', {
    clientId: customerId, invoiceDate: todayInSast(), taxRate: 15, currencyCode: 'ZAR', exchangeRate: 1,
    items: [{ description, quantity: 1, unitPrice: 100 }],
  });
  return made.id;
}

export async function openEdit(page: Page, id: string): Promise<void> {
  await page.goto(`/accounting/customer-invoices/edit/${id}`, { waitUntil: 'domcontentloaded' });
  await expect(page.getByPlaceholder('Item description').first()).not.toHaveValue('', { timeout: 60_000 });
  await settle(page);
}

/** Every draft PUT the page sends from now on. */
export function countPuts(page: Page): () => number {
  let n = 0;
  page.on('request', (r) => { if (r.method() === 'PUT' && r.url().includes('/api/accounting/customer-invoices-detail')) n++; });
  return () => n;
}

