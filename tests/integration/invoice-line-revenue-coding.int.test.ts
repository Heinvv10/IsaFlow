/**
 * Migration 873, the write half: every path that codes a customer invoice line
 * — create (HTTP and MCP share it), draft edit, a recurring template — refuses
 * an account or job the line may not name, BEFORE its first write, and stores
 * what it accepts, beside migration 870's CC1 / CC2 / BU. The invoice header's
 * job is what the caller sent or nothing: never a guess from the client's
 * projects.
 *
 * Disposable databases only.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { InvoiceLineCodingRefusal } from '@/modules/accounting/services/ar/invoiceLineCoding';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { getCustomerInvoiceDetail } from '@/modules/accounting/services/ar/customerInvoiceReadService';
import { approveCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceApprovalService';
import { mintRecurringCustomerInvoice } from '@/modules/accounting/services/core/recurringTransactionInvoices';
import { RecurringTemplateLineAccountError } from '@/modules/accounting/services/core/recurringTransactionErrors';
import type { RecurringTemplate } from '@/modules/accounting/services/core/recurringTransactionService';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;

const invoiceCount = async () => Number(((await sql`
  SELECT COUNT(*) AS n FROM customer_invoices WHERE company_id = ${f.fx.companyId}::UUID`) as { n: string }[])[0]!.n);

const create = (items: Record<string, unknown>[], projectId?: unknown) =>
  inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15,
    items: items as never, projectId: projectId as never,
  }));

async function storedLines(invoiceId: string) {
  return (await sql`
    SELECT gl_account_id, project_id, cc1_id, cc2_id, bu_id FROM customer_invoice_items
    WHERE invoice_id = ${invoiceId}::UUID ORDER BY unit_price DESC, id`) as Record<string, string | null>[];
}
/** A stored line with no CC1 / CC2 / BU. */
const coded = (gl: string | null, project: string | null) =>
  ({ gl_account_id: gl, project_id: project, cc1_id: null, cc2_id: null, bu_id: null });

describeIfDisposable('invoice line coding on write (migration 873)', () => {
  beforeAll(async () => { f = await seedLineRevenue(process.env.DATABASE_URL!); });
  afterAll(async () => { if (f) await dropLineRevenue(f); });

  it('stores what each line names, lower-cased — the job beside 870\'s CC2 / BU (CC1 derived) — and leaves an uncoded line uncoded', async () => {
    const { id } = await create([
      { description: 'Spot', unitPrice: 100, glAccountId: f.acct.commercials.toUpperCase(), projectId: f.project.p1,
        cc2Id: f.dim.cc2, buId: f.dim.bu },
      { description: 'Fee', unitPrice: 50 },
    ]);
    expect(await storedLines(id)).toEqual([
      { gl_account_id: f.acct.commercials, project_id: f.project.p1, cc1_id: f.dim.fno, cc2_id: f.dim.cc2, bu_id: f.dim.bu },
      coded(null, null),
    ]);
  });

  it('the header project is the one sent, or none — not one of the client\'s projects picked at random', async () => {
    const header = async (projectId?: string) => {
      const { id } = await create([{ description: 'x', unitPrice: 1 }], projectId);
      return ((await sql`SELECT project_id FROM customer_invoices WHERE id = ${id}::UUID`) as { project_id: string | null }[])[0]!.project_id;
    };
    expect(await header()).toBeNull(); // the client has P1, P2 and P3
    expect(await header(f.project.p2)).toBe(f.project.p2);
  });

  it.each([
    ['another company\'s account', () => ({ glAccountId: f.acct.foreign }), /not in your company/],
    ['another company\'s project', () => ({ projectId: f.project.foreign }), /not in your company/],
    ['an id that exists nowhere', () => ({ glAccountId: '00000000-0000-4000-8000-000000000000' }), /not in your company/],
    ['an expense account', () => ({ glAccountId: f.acct.expense }), /6100 Crew.*not a revenue account \(it is expense\)/],
    ['a header account', () => ({ glAccountId: f.acct.header }), /4300 Studio header.*header account/],
    ['an inactive account', () => ({ glAccountId: f.acct.inactive }), /4400 Retired line.*inactive/],
    ['a cancelled job', () => ({ projectId: f.project.cancelled }), /job P3-.*cancelled/],
    ['an array holding a valid id', () => ({ glAccountId: [f.acct.commercials] }), /items\[0\]\.glAccountId must be a UUID/],
    ['a number', () => ({ projectId: 42 }), /items\[0\]\.projectId must be a UUID/],
  ])('create refuses %s before writing anything', async (_label, coding, message) => {
    const before = await invoiceCount();
    const err = await create([{ description: 'x', unitPrice: 10, ...coding() }]).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceLineCodingRefusal);
    expect((err as InvoiceLineCodingRefusal).code).toBe('INVOICE_LINE_CODING_REFUSED');
    expect((err as Error).message).toMatch(message);
    expect(await invoiceCount()).toBe(before);
  });

  it('create refuses a header project of another company, and a non-uuid one', async () => {
    await expect(create([{ description: 'x', unitPrice: 1 }], f.project.foreign)).rejects.toThrow(/not in your company/);
    await expect(create([{ description: 'x', unitPrice: 1 }], [f.project.p1])).rejects.toThrow(/projectId must be a UUID/);
  });

  it('draft edit stores the new coding, and refuses a foreign one leaving the draft untouched', async () => {
    const { id } = await create([{ description: 'x', unitPrice: 100, glAccountId: f.acct.commercials }]);
    const edit = (coding: Record<string, string>) => inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
      id, items: [{ description: 'y', quantity: 1, unitPrice: 200, ...coding }],
    }));
    expect(await edit({ glAccountId: f.acct.postProduction, projectId: f.project.p2 })).toEqual({ kind: 'ok' });
    expect(await storedLines(id)).toEqual([coded(f.acct.postProduction, f.project.p2)]);

    const refused = await edit({ projectId: f.project.foreign });
    expect(refused).toEqual({ kind: 'bad_line', message: expect.stringMatching(/not in your company/) });
    expect(await storedLines(id)).toEqual([coded(f.acct.postProduction, f.project.p2)]);
    const subtotal = ((await sql`SELECT subtotal FROM customer_invoices WHERE id = ${id}::UUID`) as { subtotal: string }[])[0]!.subtotal;
    expect(Number(subtotal)).toBe(200);
  });

  it('draft edit: a PUT without coding keys keeps the coding; null clears it; differing lines need it explicitly', async () => {
    const { id } = await create([
      { description: 'a', unitPrice: 10, glAccountId: f.acct.commercials, projectId: f.project.p1 },
      { description: 'b', unitPrice: 20, glAccountId: f.acct.commercials, projectId: f.project.p1 },
    ]);
    const put = (items: Record<string, unknown>[]) => inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
      id, items: items.map((i) => ({ description: 'x', quantity: 1, unitPrice: 15, ...i })) as never,
    }));
    expect(await put([{}, {}])).toEqual({ kind: 'ok' });
    expect(await storedLines(id)).toEqual([coded(f.acct.commercials, f.project.p1), coded(f.acct.commercials, f.project.p1)]);
    expect(await put([{ projectId: f.project.p2 }, { projectId: null }])).toEqual({ kind: 'ok' });
    expect(await put([{}, {}])).toEqual({ kind: 'bad_line', message: expect.stringMatching(/items\[0\]\.projectId was left out/) });
    expect(await put([{ glAccountId: null, projectId: null }, { glAccountId: null, projectId: null }])).toEqual({ kind: 'ok' });
    expect(await storedLines(id)).toEqual([coded(null, null), coded(null, null)]);
  });

  it('draft edit: the header project is set, kept when absent, cleared on null, and refused when not this company\'s', async () => {
    const { id } = await create([{ description: 'x', unitPrice: 10 }]);
    const header = async () => ((await sql`SELECT project_id FROM customer_invoices WHERE id = ${id}::UUID`) as { project_id: string | null }[])[0]!.project_id;
    const put = (body: Record<string, unknown>) => inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, ...body } as never));
    expect(await put({ projectId: f.project.p1 })).toEqual({ kind: 'ok' });
    expect(await header()).toBe(f.project.p1);
    expect(await put({ notes: 'still p1' })).toEqual({ kind: 'ok' });
    expect(await header()).toBe(f.project.p1);
    expect(await put({ projectId: f.project.foreign })).toEqual({ kind: 'bad_line', message: expect.stringMatching(/not in your company/) });
    expect(await header()).toBe(f.project.p1);
    expect(await put({ projectId: null })).toEqual({ kind: 'ok' });
    expect(await header()).toBeNull();
  });

  it('the invoice detail names each line\'s account, job, CC1, CC2 and BU — never another company\'s', async () => {
    const { id } = await create([{ description: 'Spot', unitPrice: 100, glAccountId: f.acct.commercials, projectId: f.project.p1,
      cc2Id: f.dim.cc2, buId: f.dim.bu }]);
    const named = async () => ((await inTx(f.fx, () => getCustomerInvoiceDetail(f.fx.companyId, id))) as { items: Record<string, unknown>[] }).items[0]!;
    expect(await named()).toMatchObject({ gl_account_code: '4100', project_number: expect.stringMatching(/^P1-/),
      line_project_name: 'Production P1', cc1_code: 'FT', cc2_code: 'LAW', bu_code: 'ACT', account_posted: null });
    const otherBu = ((await sql`INSERT INTO business_units (company_id, code, name) VALUES (${f.other.companyId}::UUID, 'ACT', 'Theirs')
      RETURNING id`) as { id: string }[])[0]!.id;
    await sql`UPDATE customer_invoice_items SET project_id = ${f.project.foreign}::UUID, gl_account_id = ${f.acct.foreign}::UUID,
              cc1_id = ${f.dim.foreignCc2}::UUID, cc2_id = ${f.dim.foreignCc2}::UUID, bu_id = ${otherBu}::UUID
              WHERE invoice_id = ${id}::UUID`;
    expect(await named()).toMatchObject({ gl_account_code: null, gl_account_name: null, project_number: null,
      line_project_name: null, cc1_code: null, cc1_name: null, cc2_code: null, cc2_name: null, bu_code: null, bu_name: null });
    await sql`DELETE FROM customer_invoice_items WHERE invoice_id = ${id}::UUID`;
  });

  it('account_posted says whether a posted invoice\'s journal credited the line\'s account', async () => {
    const { id } = await create([{ description: 'Spot', unitPrice: 100, glAccountId: f.acct.commercials }]);
    await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, id, f.fx.userId));
    const posted = async () => ((await inTx(f.fx, () => getCustomerInvoiceDetail(f.fx.companyId, id))) as { items: Record<string, unknown>[] }).items[0]!.account_posted;
    expect(await posted()).toBe(true);
    // Another invoice's journal DOES credit 4200: the check is this invoice's journal, not any.
    const other = (await create([{ description: 'Grade', unitPrice: 50, glAccountId: f.acct.postProduction }])).id;
    await inTx(f.fx, () => approveCustomerInvoice(f.fx.companyId, other, f.fx.userId));
    // As a pre-873 invoice reads: the line names an account its journal never credited.
    await sql`UPDATE customer_invoice_items SET gl_account_id = ${f.acct.postProduction}::UUID WHERE invoice_id = ${id}::UUID`;
    expect(await posted()).toBe(false);
  });

  it('draft edit re-sending a header project cancelled since it was set is not refused; switching to a cancelled one is', async () => {
    const { id } = await create([{ description: 'x', unitPrice: 10 }], f.project.p2);
    await sql`UPDATE projects SET status = 'cancelled' WHERE id = ${f.project.p2}::UUID`;
    try {
      const put = (projectId: string) => inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, projectId, notes: 'n' } as never));
      expect(await put(f.project.p2)).toEqual({ kind: 'ok' });
      expect(await put(f.project.cancelled)).toEqual({ kind: 'bad_line', message: expect.stringMatching(/cancelled/) });
    } finally {
      await sql`UPDATE projects SET status = 'active' WHERE id = ${f.project.p2}::UUID`;
    }
  });

  it('a recurring template naming a non-revenue or foreign account is refused before the number is reserved', async () => {
    const template = (glAccountId: string): RecurringTemplate => ({
      id: '11111111-1111-4111-8111-111111111111', companyId: f.fx.companyId, name: 'Monthly retainer',
      entityType: 'customer_invoice', frequency: 'monthly', nextRunDate: '2026-07-01', lastRunDate: null,
      isActive: true, autoPost: false, createdBy: f.fx.userId, createdAt: '2026-07-01',
      templateData: {
        clientId: f.fx.customerId, subtotal: 100, vatAmount: 15, totalAmount: 115,
        lines: [{ description: 'Retainer', quantity: 1, unitPrice: 100, taxRate: 15, glAccountId }],
      },
    });
    for (const [account, message] of [[f.acct.expense, /not a revenue account/], [f.acct.foreign, /not in your company/]] as const) {
      const before = await invoiceCount();
      const err = await inTx(f.fx, () => mintRecurringCustomerInvoice(f.fx.companyId, template(account), f.fx.userId))
        .catch((e: unknown) => e);
      expect(err).toBeInstanceOf(RecurringTemplateLineAccountError);
      expect((err as Error).message).toMatch(message);
      expect(await invoiceCount()).toBe(before);
    }
    const ok = await inTx(f.fx, () => mintRecurringCustomerInvoice(f.fx.companyId, template(f.acct.commercials), f.fx.userId));
    expect((await storedLines(ok.entityId))[0]!.gl_account_id).toBe(f.acct.commercials);
  });
});
