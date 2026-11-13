/**
 * bulk_approve_credit_notes wiring of the mirror_bill re-check (migration 988; review round 1, quality #5): the
 * batch is judged in the LIVE posting order (linked bill, then note id), after the approval-gate skips, and a
 * refused note is a `vat_already_reversed` skip that never posts — dry run and live alike.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/modules/accounting/services/gl/approvalUnattended', () => ({ agentApprovalRefusals: vi.fn(async () => new Map()) }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));
vi.mock('@/lib/neon', () => ({
  sql: vi.fn(async () => []),
  withSavepoint: vi.fn(async (_n: string, fn: () => Promise<unknown>) => fn()),
}));
vi.mock('@/lib/mcp/tools/bulkApprovePeriods', () => ({ resolvePeriodSkips: vi.fn(async () => new Map()) }));
vi.mock('@/modules/accounting/services/gl/systemAccountResolver', () => ({ validateSystemAccounts: vi.fn(async () => []) }));
vi.mock('@/modules/accounting/services/shared/creditNoteFifo', async () => ({
  ...(await vi.importActual<typeof import('@/modules/accounting/services/shared/creditNoteFifo')>('@/modules/accounting/services/shared/creditNoteFifo')),
  listCreditNoteAllocations: vi.fn(async () => []),
}));
vi.mock('@/modules/accounting/services/ar/creditNoteService', () => ({ approveCreditNote: vi.fn() }));
vi.mock('@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove')>()),
  mirroredVatRefusals: vi.fn(),
}));

import { sql } from '@/lib/neon';
import { agentApprovalRefusals } from '@/modules/accounting/services/gl/approvalUnattended';
import { approveCreditNote } from '@/modules/accounting/services/ar/creditNoteService';
import { mirroredVatRefusals } from '@/modules/accounting/services/ap/supplierCreditNoteMirrorApprove';
import { resolvePeriodSkips } from '@/lib/mcp/tools/bulkApprovePeriods';
import { validateSystemAccounts } from '@/modules/accounting/services/gl/systemAccountResolver';
import { bulkApproveCreditNotesTool } from '@/lib/mcp/tools/writeBulkApproveCreditNotes';

const ctx = { companyId: 'company-1', userId: 'user-1' } as never;
const ID = (n: number) => `0a000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const note = (n: number, bill: string) => ({ id: ID(n), status: 'draft', credit_date: '2026-09-01', credit_note_number: `CN-${n}`,
  type: 'supplier', total_amount: 115, linked_invoice_id: bill });
const call = async (dry: boolean) => JSON.parse((await bulkApproveCreditNotesTool.handler(
  { credit_note_ids: [ID(4), ID(3), ID(2), ID(1)], dry_run: dry, idempotency_key: 'k' }, ctx)).content[0]!.text) as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(resolvePeriodSkips).mockResolvedValue(new Map());
  vi.mocked(validateSystemAccounts).mockResolvedValue([]);
  vi.mocked(agentApprovalRefusals).mockImplementation(async () => new Map([[ID(4), 'approval_required: owner signs']]));
  vi.mocked(sql).mockResolvedValue([note(1, 'bill-b'), note(2, 'bill-a'), note(3, 'bill-b'), note(4, 'bill-a')] as never);
  vi.mocked(mirroredVatRefusals).mockResolvedValue(new Map([[ID(3), 'VAT_ALREADY_REVERSED: CN-3 …']]));
  vi.mocked(approveCreditNote).mockImplementation((async (_c: string, id: string) => ({
    id, creditNoteNumber: 'CN', type: 'supplier', status: 'applied', totalAmount: 115, glJournalEntryId: 'je', appliedAmount: 115,
  })) as never);
});

describe('bulk_approve_credit_notes — mirror_bill re-check wiring', () => {
  it.each([true, false])('dry_run=%s: judged in live order after the approval skips; the refused note is skipped, never posted', async (dry) => {
    const r = await call(dry);
    expect(mirroredVatRefusals).toHaveBeenCalledWith('company-1', [ID(2), ID(1), ID(3)]);
    const skipped = r.skipped as { document_id: string; reason: string }[];
    expect(skipped.find((s) => s.document_id === ID(3))!.reason).toBe('vat_already_reversed: VAT_ALREADY_REVERSED: CN-3 …');
    if (dry) expect(r.would_post_ids).toEqual([ID(2), ID(1)]);
    else expect(vi.mocked(approveCreditNote).mock.calls.map((c) => c[1])).toEqual([ID(2), ID(1)]);
  });
});
