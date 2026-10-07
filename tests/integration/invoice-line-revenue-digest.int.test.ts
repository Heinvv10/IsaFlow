/**
 * Migration 870, the approval half: a line's project and cost centre post to
 * the journal, so they are approval content. Retagging either after a request
 * was raised makes the approve refuse DOCUMENT_CHANGED; retagging after the
 * approval makes it stale, in the TypeScript gate and in migration 865's
 * database backstop alike. Re-saving the SAME coding moves nothing (Q9).
 *
 * Disposable databases only (migrations 869 and 870 are not on isaflow_dev).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { sql } from '@/lib/neon';
import { createDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceCreateService';
import { editDraftCustomerInvoice } from '@/modules/accounting/services/ar/customerInvoiceDraftEdit';
import { evaluateApprovalGate } from '@/modules/accounting/services/gl/approvalGate';
import {
  ApprovalDocumentChangedError,
  assertDocumentUnchanged,
} from '@/modules/accounting/services/gl/approvalDecideDocument';
import { isDisposableDb } from '../helpers/assertDisposableDb';
import { inTx } from './helpers/l1FifoFixture';
import { dropLineRevenue, seedLineRevenue, type LineRevenueFixture } from './helpers/lineRevenueFixture';

vi.mock('@/modules/accounting/services/ar/invoicePdfSnapshotService', () => ({
  snapshotInvoicePdf: vi.fn(async () => ({ documentId: null, wasExisting: false })),
}));

const describeIfDisposable = isDisposableDb() ? describe : describe.skip;
let f: LineRevenueFixture;
const APPROVER = '99999999-0000-4000-8000-0000000000a1';

type Coding = { projectId?: string; costCenterId?: string };
const line = (c: Coding) => ({ description: 'Spot', quantity: 1, unitPrice: 1000, glAccountId: f.acct.commercials, ...c });

async function draft(c: Coding): Promise<string> {
  return (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
    clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15, items: [line(c)],
  }))).id;
}

const edit = (id: string, c: Coding) =>
  inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, items: [line(c)] }));

const digest = async (id: string) => String(((await sql`
  SELECT approval_document_digest(${f.fx.companyId}::UUID, 'customer_invoice', ${id}::UUID) AS d`) as { d: string }[])[0]!.d);

async function request(id: string, status: 'pending' | 'approved'): Promise<{ id: string; digest: string }> {
  const d = await digest(id);
  const rows = (await sql`
    INSERT INTO approval_requests (company_id, document_type, document_id, status, requested_by,
                                   decided_by, decided_at, document_digest, required_role, rule_id)
    VALUES (${f.fx.companyId}::UUID, 'customer_invoice', ${id}::UUID, ${status}, ${f.fx.userId}::UUID,
            ${status === 'approved' ? APPROVER : null}::UUID, ${status === 'approved' ? new Date() : null},
            ${d}, 'owner', ${ruleId}::UUID)
    RETURNING id`) as { id: string }[];
  return { id: rows[0]!.id, digest: d };
}

let ruleId = '';
const RETAGS: [string, () => Coding, () => Coding][] = [
  ['project', () => ({ projectId: f.project.p1 }), () => ({ projectId: f.project.p2 })],
  ['cost centre', () => ({ costCenterId: f.centre.active }), () => ({ costCenterId: undefined })],
];

describeIfDisposable('invoice line project / cost centre are approval content (migration 870)', () => {
  beforeAll(async () => {
    f = await seedLineRevenue(process.env.DATABASE_URL!);
    await sql`INSERT INTO approval_enforcement (company_id, document_type, enabled_by, enabled_at)
              VALUES (${f.fx.companyId}::UUID, 'customer_invoice', ${f.fx.userId}::UUID, NOW() - INTERVAL '1 day')`;
    ruleId = ((await sql`
      INSERT INTO approval_rules (company_id, name, document_type, condition_field, condition_operator,
                                  condition_value, approver_role, is_active)
      VALUES (${f.fx.companyId}::UUID, 'Owner signs invoices', 'customer_invoice', 'amount', 'any', 0, 'owner', true)
      RETURNING id`) as { id: string }[])[0]!.id;
  });
  afterAll(async () => {
    if (!f) return;
    await sql`DELETE FROM approval_requests WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM approval_rules WHERE company_id = ${f.fx.companyId}::UUID`;
    await sql`DELETE FROM approval_enforcement WHERE company_id = ${f.fx.companyId}::UUID`;
    await dropLineRevenue(f);
  });

  it.each(RETAGS)('the digest moves with the line %s, and re-saving the same coding moves nothing', async (_l, from, to) => {
    const id = await draft(from());
    const before = await digest(id);
    expect(await edit(id, from())).toEqual({ kind: 'ok' });
    expect(await digest(id)).toBe(before);
    expect(await edit(id, to())).toEqual({ kind: 'ok' });
    expect(await digest(id)).not.toBe(before);
  });

  it('two lines that differ only by project or cost centre digest in a content-determined order', async () => {
    // Lines re-inserted in one transaction share created_at, so without the two
    // columns in the ORDER BY the order would fall to the random line id and the
    // same content would digest differently from one save to the next.
    const pair = (a: Coding, b: Coding) => [line(a), line(b)];
    const id = (await inTx(f.fx, () => createDraftCustomerInvoice(f.fx.companyId, f.fx.userId, {
      clientId: f.fx.customerId, invoiceDate: '2026-07-15', taxRate: 15,
      items: pair({ projectId: f.project.p1 }, { projectId: f.project.p2 }),
    }))).id;
    for (const [a, b] of [[{ projectId: f.project.p1 }, { projectId: f.project.p2 }],
      [{ costCenterId: f.centre.active }, {}]] as [Coding, Coding][]) {
      expect(await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, items: pair(a, b) })))
        .toEqual({ kind: 'ok' });
      const first = await digest(id);
      for (let i = 0; i < 10; i++) {
        const items = i % 2 === 0 ? pair(b, a) : pair(a, b);
        await inTx(f.fx, () => editDraftCustomerInvoice(f.fx.companyId, f.fx.userId, { id, items }));
        expect(await digest(id)).toBe(first);
      }
    }
  });

  it.each(RETAGS)('retagging the line %s after the request was raised: approve refuses DOCUMENT_CHANGED', async (_l, from, to) => {
    const id = await draft(from());
    const req = await request(id, 'pending');
    await expect(inTx(f.fx, () => assertDocumentUnchanged(f.fx.companyId, req.id, req.digest))).resolves.toBeUndefined();
    await edit(id, to());
    const err = await inTx(f.fx, () => assertDocumentUnchanged(f.fx.companyId, req.id, req.digest)).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApprovalDocumentChangedError);
    expect((err as ApprovalDocumentChangedError).code).toBe('DOCUMENT_CHANGED');
  });

  it.each(RETAGS)('retagging the line %s after the approval stales it, in the gate and the database backstop', async (_l, from, to) => {
    const id = await draft(from());
    await request(id, 'approved');
    expect(await inTx(f.fx, () => evaluateApprovalGate(f.fx.companyId, 'customer_invoice', id))).toBeNull();
    await edit(id, to());
    expect((await inTx(f.fx, () => evaluateApprovalGate(f.fx.companyId, 'customer_invoice', id)))?.reason).toBe('APPROVAL_STALE');
    await expect(sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`)
      .rejects.toThrow(/R035_APPROVAL_REQUIRED/);
  });

  it('the backstop still lets the approved, untouched invoice through', async () => {
    const id = await draft({ projectId: f.project.p1, costCenterId: f.centre.active });
    await request(id, 'approved');
    await sql`UPDATE customer_invoices SET status = 'approved' WHERE id = ${id}::UUID`;
    expect(((await sql`SELECT status FROM customer_invoices WHERE id = ${id}::UUID`) as { status: string }[])[0]!.status)
      .toBe('approved');
  });
});
