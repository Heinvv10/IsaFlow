/**
 * Subledger documents that never reached the control account (W2).
 *
 * Found by running the reconciliation over real books rather than by reading
 * the specification, which does not mention it: on isaflow_dev, 169 of ISAFlow
 * Demo's open customer invoices carry NO `gl_journal_entry_id` at all —
 * R10,664,575.43 of receivable that the subledger counts and the general ledger
 * has never heard of. On Brightsphere's dev copy it is all 29 of them.
 *
 * Without this the reconciler reported that money as `unexplained_difference`,
 * which is honest but useless: a reader is told a number and not which
 * invoices. Naming it turns the largest residual in these books into a list of
 * documents somebody can act on.
 *
 * TWO reasons, because the remedy differs: a document with no journal has never
 * been posted, while a document whose journal misses every control account was
 * posted to the wrong place.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

const sqlFn = vi.fn();
vi.mock('@/lib/neon', () => ({ sql: (...a: unknown[]) => sqlFn(...a), withTransaction: vi.fn() }));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CTRL = ['22222222-2222-4222-8222-222222222222'];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', document_number: 'INV0000001', entity_name: 'Blitz',
  document_date: '2026-01-01', balance: '1000', has_journal: true, control_amount: '1000', ...over,
});

beforeEach(() => sqlFn.mockReset());

describe('getUnpostedSubledgerDocuments', () => {
  it('names a document that carries NO link to a journal entry', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ id: 'inv-9', document_number: 'INV9', has_journal: false, control_amount: '0', balance: '10664575.43' }),
    ]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs).toEqual([
      expect.objectContaining({
        id: 'inv-9', documentNumber: 'INV9',
        reason: 'document_not_linked_to_journal', amount: 10664575.43,
      }),
    ]);
  });

  it('distinguishes a document POSTED SOMEWHERE ELSE from one never posted', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ id: 'inv-8', has_journal: true, control_amount: '0', balance: '250' }),
    ]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.reason).toBe('document_not_on_control_account');
  });

  it('reports only the SHORTFALL when part of a document reached control', async () => {
    sqlFn.mockResolvedValueOnce([
      row({ balance: '1000', control_amount: '400', has_journal: true }),
    ]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.amount).toBe(600);
  });

  it('says nothing about a document exactly represented on the control account', async () => {
    sqlFn.mockResolvedValueOnce([row()]);
    expect(await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL)).toEqual([]);
  });

  it('reports an OVER-posted document as a negative amount', async () => {
    // Both signs are needed. Dropping the negative ones leaves the difference
    // permanently over-explained, and the residual then never reaches zero.
    sqlFn.mockResolvedValueOnce([row({ balance: '400', control_amount: '1000' })]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.amount).toBe(-600);
  });

  it('returns nothing, and runs no query, when no control account exists', async () => {
    expect(await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', [])).toEqual([]);
    expect(sqlFn).not.toHaveBeenCalled();
  });

  it('scopes by company and passes the date as a string', async () => {
    sqlFn.mockResolvedValueOnce([]);
    await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    const values = sqlFn.mock.calls[0]!.slice(1);
    expect(values).toContain(COMPANY);
    expect(values).toContain('2026-09-03');
    expect(values.every((v: unknown) => !(v instanceof Date))).toBe(true);
  });
});
