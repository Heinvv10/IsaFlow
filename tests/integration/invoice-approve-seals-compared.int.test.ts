/**
 * PR S round seventeen (codex finding at 39e0b8b87): the approval compares the shown digest with only the invoice row
 * locked, so the customer or company record (bank details) could change after the comparison and before the PDF is
 * sealed, and the customer be sent payment details the approver never saw. Now the approval loads the PDF model ONCE
 * under its row lock, compares its digest, and seals THAT model (status approved): what was compared is what is sealed
 * (and emailed: sendInvoiceEmail attaches the sealed PDF). The window is opened with the repo's lazy sql wrapper: right
 * after the approval's status UPDATE (past the comparison, before the seal) a hook changes the company's bank account.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Pool } from 'pg';
import type { InvoicePdfModel } from '@/modules/accounting/services/ar/invoicePdfModel';

const hooks = vi.hoisted(() => ({ afterApprove: null as null | (() => Promise<void>), fired: 0, rendered: [] as unknown[] }));
vi.mock('@/lib/neon', async (orig) => {
  const real = await orig<Record<string, unknown>>();
  const realSql = real.sql as (s: TemplateStringsArray, ...v: unknown[]) => unknown;
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join('?');
    if (!hooks.afterApprove || !/UPDATE customer_invoices\s+SET status = 'approved'/.test(text)) return realSql(strings, ...values);
    return (async () => {
      const rows = await (realSql(strings, ...values) as Promise<unknown>);
      const hook = hooks.afterApprove;
      hooks.afterApprove = null;
      if (hook) { hooks.fired++; await hook(); }
      return rows;
    })();
  };
  return { ...real, sql: Object.assign(sql, realSql) };
});
// What the seal renders: the model it is given, or (were it to reload) the one it would load now.
vi.mock('@/modules/accounting/services/ar/invoicePdfBuilder', async (orig) => {
  const real = await orig<typeof import('@/modules/accounting/services/ar/invoicePdfBuilder')>();
  const { loadInvoicePdfModel } = await import('@/modules/accounting/services/ar/invoicePdfModel');
  return {
    ...real,
    generateInvoicePdf: async (companyId: string, invoiceId: string, given?: InvoicePdfModel) => {
      hooks.rendered.push(given ?? await loadInvoicePdfModel(companyId, invoiceId));
      return Buffer.from('%PDF-1.4 test');
    },
  };
});

import customerInvoicesDetail from '../../pages/api/accounting/customer-invoices-detail';
import { invoiceDigests, loadInvoicePdfModelAndDigests } from '@/modules/accounting/services/ar/invoicePdfModel';
import { assertDisposable } from './mfa-impersonation-postgres.helpers';
import { callRoute, createUser } from './r035-approval.helpers';
import { cleanupPr4, invoiceCompany, plantInvoice } from './r035-pr4.helpers';

assertDisposable();
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const companies: string[] = [];
const tokens: Record<string, string> = {};
let owner = '';
let company = '';
const call = (method: string, body: unknown, query: Record<string, string> = {}) =>
  callRoute(customerInvoicesDetail, tokens[owner]!, company, method, body, '/api/accounting/customer-invoices-detail', query);

beforeAll(async () => {
  owner = await createUser(pool, tokens);
  company = await invoiceCompany(pool, [[owner, 'owner']], companies);
  await pool.query(`UPDATE companies SET bank_name = 'Seen Bank', bank_account_number = '1111111111', logo_data = $2 WHERE id = $1`,
    [company, 'data:image/png;base64,' + 'A'.repeat(4096)]);
}, 60_000);
afterAll(async () => { await cleanupPr4(pool, companies, [owner]); });

describe('the approval seals the model it compared', () => {
  it('bank details changed after the comparison: the sealed PDF carries the compared ones, never the unseen ones', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const shown = (await call('GET', undefined, { id: inv.id })).state.body as { data: { shown_digest: string } };
    hooks.fired = 0;
    hooks.rendered = [];
    hooks.afterApprove = async () => { await pool.query(`UPDATE companies SET bank_account_number = '9999999999' WHERE id = $1`, [company]); };
    const res = await call('POST', { id: inv.id, action: 'approve', expectedTotal: 1150, expectedContentDigest: shown.data.shown_digest });
    hooks.afterApprove = null;
    expect(res.state.statusCode, JSON.stringify(res.state.body)).toBe(200);
    expect(hooks.fired).toBe(1); // the window really opened
    expect(hooks.rendered).toHaveLength(1);
    const sealed = hooks.rendered[0] as InvoicePdfModel;
    expect(sealed.company.bankAccountNumber).toBe('1111111111');
    expect(sealed.invoice.status).toBe('approved');
    await pool.query(`UPDATE companies SET bank_account_number = '1111111111' WHERE id = $1`, [company]);
  });

  it('the once-loaded model\'s digests are the digests the GET hands out (the logo md5\'d in TS as in SQL)', async () => {
    const inv = await plantInvoice(pool, company, owner);
    const once = await loadInvoicePdfModelAndDigests(company, inv.id);
    expect(once?.model.company.logoData).toMatch(/^data:image\/png;base64,A{4096}$/);
    expect(once?.digests).toEqual(await invoiceDigests(company, inv.id));
  });
});
