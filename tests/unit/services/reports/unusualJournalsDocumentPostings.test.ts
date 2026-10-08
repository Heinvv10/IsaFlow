/**
 * A ROUND NUMBER IS AN ESTIMATE ONLY WHERE SOMEONE TYPED IT.
 *
 * The round-number rule exists because a hand-entered R50 000 tends to be an
 * estimate standing in for an actual. Velocity Fibre's board pack raised 880
 * matters off it, and on the production copy 688 of its 693 round-number
 * flags were postings generated from documents — a customer invoice, a
 * supplier payment, a bank allocation — whose round amount is the document's.
 * Those are not tested for a round number any more. Every source whose amount
 * a person or an agent keys in — a manual journal, a recurring template, a
 * GL import, a VAT adjustment, an opening balance — still is, and so is an
 * unknown or missing one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sqlSpy = vi.hoisted(() => vi.fn());
vi.mock('@/lib/neon', () => ({ sql: sqlSpy }));

import { getUnusualJournals } from '@/modules/accounting/services/reports/unusualJournalsService';
import { DOCUMENT_POSTING_SOURCES, JOURNAL_SOURCE_KINDS } from '@/modules/accounting/services/reports/journalSourceKinds';
import { GL_ENTRY_SOURCES } from '@/modules/accounting/types/gl.types';

const COMPANY = '11111111-1111-4111-8111-111111111111';
const WINDOW = { start: '2026-01-01', end: '2026-10-02' };

const row = (id: string, source: string | null, over: Record<string, unknown> = {}) => ({
  id, entry_number: `JE-${id}`, entry_date: '2026-03-10', description: 'x', source,
  created_at: new Date('2026-03-10T08:00:00.000Z'), amount: 6_000_000, ...over,
});

async function reasons(...rows: ReturnType<typeof row>[]) {
  sqlSpy.mockResolvedValue(rows);
  return (await getUnusualJournals(COMPANY, WINDOW)).flags.map((f) => [f.entryId, f.reason]);
}

beforeEach(() => sqlSpy.mockReset());

describe('the round-number test', () => {
  it('does not flag a posting generated from a document', async () => {
    expect(await reasons(
      row('inv', 'auto_invoice'), row('pay', 'auto_supplier_payment'), row('bank', 'auto_bank_recon'),
    )).toEqual([]);
  });

  it('flags a journal whose amount a person or an agent keyed in, and one whose source is unknown or missing', async () => {
    // Recurring templates, GL imports, VAT adjustments and opening balances
    // all carry an `auto_` source and all are typed figures — a monthly
    // R50 000 recurring accrual is exactly the estimate this rule is for.
    expect(await reasons(
      row('m', 'manual'), row('rec', 'auto_recurring'), row('imp', 'auto_gl_import'),
      row('vat', 'auto_vat_adjustment'), row('ob', 'auto_migration'), row('adj', 'auto_adjustment'),
      row('wo', 'auto_write_off'), row('u', 'not_a_known_source'), row('n', null),
      // A claim's amount is typed by the employee it pays (receipt optional);
      // disposal proceeds are typed; three sources have no writer yet, and a
      // future one is tested until someone decides otherwise.
      row('ec', 'auto_expense_claim'), row('ad', 'auto_asset_disposal'), row('lp', 'auto_loan_payment'),
      row('po', 'auto_purchase_order'), row('grn', 'auto_grn'),
      // An expensed asset's cost: the capitalisation threshold is per company,
      // so it is not always under the round-number floor.
      row('ae', 'auto_asset_expense'),
    )).toEqual([
      ['m', 'round_number'], ['rec', 'round_number'], ['imp', 'round_number'], ['vat', 'round_number'],
      ['ob', 'round_number'], ['adj', 'round_number'], ['wo', 'round_number'], ['u', 'round_number'],
      ['n', 'round_number'], ['ec', 'round_number'], ['ad', 'round_number'], ['lp', 'round_number'],
      ['po', 'round_number'], ['grn', 'round_number'], ['ae', 'round_number'],
    ]);
  });

  it('still tests a document posting for late recording', async () => {
    const late = row('late', 'auto_supplier_invoice', { created_at: new Date('2026-04-20T08:00:00.000Z') });
    expect(await reasons(late)).toEqual([['late', 'backdated']]);
  });
});

// NOT PINNED HERE: that the SELECT returns `je.source`. A mocked `sql` hands
// back whatever row it is given, so dropping the column from the query would
// leave this file green while production flagged every source alike. The
// read-only run against the production copy is the evidence for the query.

describe('the classification', () => {
  it('names exactly these sources as postings generated from documents', () => {
    expect([...DOCUMENT_POSTING_SOURCES].sort()).toEqual([
      'auto_bank_recon', 'auto_bank_transfer', 'auto_batch_payment', 'auto_credit_note',
      'auto_depreciation', 'auto_expense_receipt', 'auto_invoice', 'auto_payment', 'auto_payroll',
      'auto_supplier_invoice', 'auto_supplier_payment', 'auto_vat_late_claim', 'auto_vat_submission', 'year_end',
    ]);
  });

  it('classifies every source the ledger admits, one way or the other', () => {
    // The compile-time half is `Record<GLEntrySource, …>`; this is the run-time
    // half, against the CHECK constraint's own list.
    for (const source of GL_ENTRY_SOURCES) {
      expect(typeof JOURNAL_SOURCE_KINDS[source], source).toBe('string');
    }
  });
});

// sec-nrfa M2 (2026-10-08): Banking > Transfers writes auto_bank_transfer from an amount a person typed, with no bank
// line; only a transfer a bank line points at carries a document's amount.
describe('auto_bank_transfer', () => {
  it('is tested for a round number unless a bank line points at it', async () => {
    expect(await reasons(
      row('typed', 'auto_bank_transfer', { bank_line_backed: false }),
      row('line', 'auto_bank_transfer', { bank_line_backed: true }),
      row('unknown', 'auto_bank_transfer'),
    )).toEqual([['typed', 'round_number'], ['unknown', 'round_number']]);
  });
});
