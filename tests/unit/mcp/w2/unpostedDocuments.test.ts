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

const rows: unknown[][] = [];
/**
 * The query splices the settlement rewind in as a NESTED `sql` fragment, so
 * `sql` is called several times and only one call is the statement. Queuing
 * responses positionally would hand the document rows to a rewind fragment and
 * leave every assertion green against an empty result. A fragment is
 * discriminated by having no ORDER BY; the statement orders its rows.
 */
const sqlFn = vi.fn((...a: unknown[]) => {
  const parts = a[0];
  const text = Array.isArray(parts) ? (parts as string[]).join('?') : '';
  if (!text.includes('ORDER BY')) return { fragment: text };
  return Promise.resolve(rows.shift() ?? []);
});

/** The statement as Postgres would see it: template text plus its values. */
function render(call: readonly unknown[]): string {
  const parts = call[0];
  if (!Array.isArray(parts)) return '';
  return (parts as string[])
    .map((part, i) => part + (i < call.length - 1 ? String(call[i + 1] ?? '') : ''))
    .join('');
}

/** Queue one statement's result. */
function nextRows(...results: unknown[][]) {
  rows.push(...results);
}
vi.mock('@/lib/neon', () => ({
  // `unsafe` is part of the real client: the point-in-time rewind splices a
  // nested fragment and an interpolated expression through it. A mock without
  // it fails loudly, which is better than a mock that silently drops the
  // rewind and leaves every assertion green against today's balances.
  sql: Object.assign((...a: unknown[]) => sqlFn(...a), { unsafe: (t: string) => t }),
  withTransaction: vi.fn(),
}));
vi.mock('@/lib/logger', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() } }));

import { getUnpostedSubledgerDocuments } from '@/modules/accounting/services/reconciliation/unpostedDocumentService';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const CTRL = ['22222222-2222-4222-8222-222222222222'];

const row = (over: Record<string, unknown> = {}) => ({
  id: 'inv-1', document_number: 'INV0000001', entity_name: 'Blitz',
  document_date: '2026-01-01', balance: '1000', has_journal: true, control_amount: '1000', ...over,
});

beforeEach(() => {
  rows.length = 0;
  sqlFn.mockClear();
});

describe('getUnpostedSubledgerDocuments', () => {
  it('names a document that carries NO link to a journal entry', async () => {
    nextRows([
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
    nextRows([
      row({ id: 'inv-8', has_journal: true, control_amount: '0', balance: '250' }),
    ]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.reason).toBe('document_not_on_control_account');
  });

  it('reports only the SHORTFALL when part of a document reached control', async () => {
    nextRows([
      row({ balance: '1000', control_amount: '400', has_journal: true }),
    ]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.amount).toBe(600);
  });

  it('says nothing about a document exactly represented on the control account', async () => {
    nextRows([row()]);
    expect(await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL)).toEqual([]);
  });

  it('reports an OVER-posted document as a negative amount', async () => {
    // Both signs are needed. Dropping the negative ones leaves the difference
    // permanently over-explained, and the residual then never reaches zero.
    nextRows([row({ balance: '400', control_amount: '1000' })]);
    const docs = await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    expect(docs[0]!.amount).toBe(-600);
  });

  it('returns nothing, and runs no query, when no control account exists', async () => {
    expect(await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', [])).toEqual([]);
    expect(sqlFn).not.toHaveBeenCalled();
  });

  it('scopes by company and passes the date as a string', async () => {
    nextRows([]);
    await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    const scoped = sqlFn.mock.calls.filter((c) => render(c).includes('company_id'));
    expect(scoped.length).toBeGreaterThanOrEqual(2);
    for (const call of scoped) expect(call.slice(1)).toContain(COMPANY);
    // Dates are 'YYYY-MM-DD' strings the whole way down. A Date here would be
    // serialised in the session's UTC and land a day early on a UTC+2 host.
    for (const call of sqlFn.mock.calls) {
      expect(call.slice(1).every((v: unknown) => !(v instanceof Date))).toBe(true);
    }
  });

  it('counts the document at its REWOUND balance, on the aging population', async () => {
    // The number this contributes must be the same number the subledger
    // snapshot counted for the document. When it was not — the open-status set
    // and the current `amount_paid` here, the aging population and the rewind
    // there — the drift between the two definitions landed in
    // `unexplained_difference` and read as a finding about the books.
    nextRows([]);
    await getUnpostedSubledgerDocuments(COMPANY, 'ar', '2026-09-03', CTRL);
    const statement = sqlFn.mock.calls.map(render).find((t) => t.includes('ORDER BY'))!;
    expect(statement).toContain("ci.status NOT IN ('draft', 'cancelled')");
    expect(statement).toContain('COALESCE(ci.invoice_date, ci.created_at::date) <=');
    expect(statement).toContain('LEAST(GREATEST(COALESCE(ci.amount_paid, 0)');
    expect(statement).toContain('unpaid.amount');
  });
});
