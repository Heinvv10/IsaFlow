/**
 * The Reference column of a statement CSV must survive the import.
 *
 * `mapCsvColumns` mapped date, description, amount and balance and nothing
 * else, so a `Reference` column was read and thrown away: every imported row
 * came back with a null reference. `ParsedBankTransaction.reference` has always
 * existed and `bankImportService` has always written it — only the header
 * mapper never filled it in.
 *
 * The cost is not cosmetic. The reference is the only stable key the CALLER
 * controls, and it is what `allocate_bank_transaction` / `reverse_bank_allocation`
 * resolve a transaction by (`bank_reference`, which reads either column). Losing
 * it forces a caller to import, re-list every row, and rebuild an old→new id map
 * on (date, amount, description) — 9,446 rows of that on the Velocity Fibre
 * rebuild, 2026-09.
 *
 * NOT changed here: the dedupe hash is still (date, amount, description,
 * balance). Adding the reference to it would be correct on a clean slate and a
 * REGRESSION on this one — every row already in the database was imported with
 * a null reference, so a re-imported statement would hash differently against
 * its own earlier rows and land a second time. That correction needs a backfill
 * beside it and is deliberately out of scope.
 */
import { describe, it, expect } from 'vitest';
import { mapCsvColumns, parseGenericStatement } from '@/modules/accounting/utils/bankCsvParserGeneric';
import { parseABSAStatement } from '@/modules/accounting/utils/bankCsvParserAbsa';

const WITH_REF = [
  'Date,Description,Reference,Amount,Balance',
  '2026-02-04,ROHCAP REFUND,RC-1187,120290.00,1500000.00',
  '2026-02-05,ANTHROPIC,INV-9921,-3238.85,1496761.15',
].join('\n');

describe('mapCsvColumns — the reference column', () => {
  it('maps a Reference header to its column index', () => {
    const cols = mapCsvColumns(['Date', 'Description', 'Reference', 'Amount', 'Balance']);
    expect(cols).not.toBeNull();
    expect(cols!.reference).toBe(2);
  });

  it.each([
    ['Ref'],
    ['Ref No'],
    ['Payment Reference'],
    ['Transaction Reference'],
    ['Statement Reference'],
    ['Reference Number'],
  ])('accepts %s as the reference header', (header) => {
    const cols = mapCsvColumns(['Date', 'Description', header, 'Amount']);
    expect(cols!.reference).toBe(2);
  });

  it('reports null when the layout carries no reference column', () => {
    const cols = mapCsvColumns(['Date', 'Description', 'Amount', 'Balance']);
    expect(cols!.reference).toBeNull();
  });

  // A reference column must never be mistaken for the thing that DESCRIBES the
  // line: descriptions are joined into one string, so a reference swept in
  // there would both corrupt the description and still leave `reference` null.
  it('does not fold the reference into the description columns', () => {
    const cols = mapCsvColumns(['Date', 'Description', 'Reference', 'Amount']);
    expect(cols!.descriptions).toEqual([1]);
  });
});

describe('parseGenericStatement — persisting the reference', () => {
  it('carries the Reference column onto every parsed transaction', () => {
    const { transactions } = parseGenericStatement(WITH_REF);
    expect(transactions).toHaveLength(2);
    expect(transactions[0]!.reference).toBe('RC-1187');
    expect(transactions[1]!.reference).toBe('INV-9921');
  });

  it('leaves reference undefined when the column is absent, not empty-string', () => {
    const csv = 'Date,Description,Amount\n2026-02-04,ROHCAP,120290.00';
    const { transactions } = parseGenericStatement(csv);
    expect(transactions[0]!.reference).toBeUndefined();
  });

  it('treats a blank reference cell as absent', () => {
    const csv = 'Date,Description,Reference,Amount\n2026-02-04,ROHCAP,   ,120290.00';
    const { transactions } = parseGenericStatement(csv);
    expect(transactions[0]!.reference).toBeUndefined();
  });

  it('does not disturb the date, amount, description or balance it already read', () => {
    const { transactions } = parseGenericStatement(WITH_REF);
    expect(transactions[0]).toMatchObject({
      transactionDate: '2026-02-04',
      amount: 120290,
      description: 'ROHCAP REFUND',
      balance: 1500000,
      reference: 'RC-1187',
    });
  });
});

describe('parseABSAStatement — the shared mapper, and the legacy fallback', () => {
  it('picks the reference up through the shared header mapping', () => {
    const csv = [
      'Account Number,Transaction Date,Description,Reference,Amount,Balance',
      '4055123456,2026/02/04,ROHCAP REFUND,RC-1187,120290.00,1500000.00',
    ].join('\n');
    const { transactions } = parseABSAStatement(csv);
    expect(transactions[0]!.reference).toBe('RC-1187');
  });

  // The legacy 6-column layout is positional and has no reference column at
  // all. It must keep parsing, with no reference rather than a wrong one.
  it('still parses the legacy positional layout, with no reference', () => {
    const csv = [
      'Account Number,Date,Description1,Description2,Amount,Balance',
      '4055123456,2026/02/04,ROHCAP,REFUND,120290.00,1500000.00',
    ].join('\n');
    const { transactions } = parseABSAStatement(csv);
    expect(transactions).toHaveLength(1);
    expect(transactions[0]!.description).toBe('ROHCAP REFUND');
    expect(transactions[0]!.reference).toBeUndefined();
  });
});
