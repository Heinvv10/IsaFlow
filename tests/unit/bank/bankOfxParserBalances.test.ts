/**
 * WP1 PR-A review round 2: what the OFX parser hands deriveStatementBalances.
 *   3. Only LEDGERBAL's BALAMT is a closing balance: AVAILBAL alone (available, not booked) gives none.
 *   6. More than one statement block (STMTRS / CCSTMTRS) in a file: its balances are not trusted.
 *   8. Amounts and balances read strictly: a comma followed by 1-2 trailing digits is a decimal separator, comma
 *      thousands groups are stripped, anything else is unreadable (TRNAMT → a row error; BALAMT → no closing, doubted).
 */
import { describe, expect, it } from 'vitest';
import { parseOfxAmount, parseOfxStatement } from '@/modules/accounting/utils/bankOfxParser';

const TRN = (amt: string, id: string) => `<STMTTRN><TRNTYPE>OTHER<DTPOSTED>20260902<TRNAMT>${amt}<FITID>${id}<NAME>N ${id}</STMTTRN>`;
const ofx = (body: string) => ['OFXHEADER:100', '<OFX><BANKMSGSRSV1><STMTTRNRS>', body, '</STMTTRNRS></BANKMSGSRSV1></OFX>'].join('\n');
const stmt = (trns: string[], bal: string) =>
  `<STMTRS><BANKTRANLIST>${trns.join('\n')}</BANKTRANLIST>${bal}</STMTRS>`;

describe('OFX balances', () => {
  it('AVAILBAL without LEDGERBAL: no closing balance', () => {
    const r = parseOfxStatement(ofx(stmt([TRN('-1.00', 'a')], '<AVAILBAL><BALAMT>9999.99<DTASOF>20260930</AVAILBAL>')));
    expect(r.closingBalance).toBeUndefined();
    expect(r.transactions).toHaveLength(1);
  });

  it('LEDGERBAL wins over AVAILBAL wherever they sit', () => {
    const r = parseOfxStatement(ofx(stmt([TRN('-1.00', 'a')],
      '<AVAILBAL><BALAMT>9999.99</AVAILBAL><LEDGERBAL><BALAMT>5330,00<DTASOF>20260930</LEDGERBAL>')));
    expect(r.closingBalance).toBe(5330);
  });

  it('two statement blocks: the balances are doubted', () => {
    const two = ofx(stmt([TRN('-1.00', 'a')], '<LEDGERBAL><BALAMT>10.00</LEDGERBAL>')
      + stmt([TRN('-2.00', 'b')], '<LEDGERBAL><BALAMT>20.00</LEDGERBAL>'));
    expect(parseOfxStatement(two).balancesUnverifiable).toMatch(/2 statements/);
    const cc = ofx(stmt([TRN('-1.00', 'a')], '<LEDGERBAL><BALAMT>10.00</LEDGERBAL>').replace(/STMTRS/g, 'CCSTMTRS')
      + stmt([TRN('-2.00', 'b')], ''));
    expect(parseOfxStatement(cc).balancesUnverifiable).toBeTruthy();
    expect(parseOfxStatement(ofx(stmt([TRN('-1.00', 'a')], '<LEDGERBAL><BALAMT>10.00</LEDGERBAL>'))).balancesUnverifiable).toBeUndefined();
  });

  it('an unreadable BALAMT is no closing, and doubted', () => {
    const r = parseOfxStatement(ofx(stmt([TRN('-1.00', 'a')], '<LEDGERBAL><BALAMT>5330.00 CR</LEDGERBAL>')));
    expect(r.closingBalance).toBeUndefined();
    expect(r.balancesUnverifiable).toBeTruthy();
  });

  it('TRNAMT reads with the same rule: "-120,50" is −120.50, not −12 050; junk is a row error', () => {
    const r = parseOfxStatement(ofx(stmt([TRN('-120,50', 'a'), TRN('1,234.50', 'b'), TRN('12abc', 'c')], '')));
    expect(r.transactions.map((t) => t.amount)).toEqual([-120.5, 1234.5]);
    expect(r.errors).toEqual([{ row: 3, error: 'Invalid TRNAMT amount: 12abc' }]);
  });
});

describe('parseOfxAmount', () => {
  it('reads plain, decimal-comma and comma-grouped numbers; rejects the rest', () => {
    expect(['5330.00', '-5330', '+12.5', '-.50', '5330,00', '5330,5', '1,234', '1,234,567.89', '-1,234.5'].map(parseOfxAmount))
      .toEqual([5330, -5330, 12.5, -0.5, 5330, 5330.5, 1234, 1234567.89, -1234.5]);
    for (const bad of ['', '5,330,00', '12,3456', '1 234.00', '12abc', '5330.00 CR', '1.234,56', '--1', 'NaN', 'Infinity']) {
      expect(parseOfxAmount(bad), bad).toBeNull();
    }
  });
});
